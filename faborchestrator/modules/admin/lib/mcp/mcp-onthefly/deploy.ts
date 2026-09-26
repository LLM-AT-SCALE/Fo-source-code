/**
 * On-the-Fly MCP — Step 4: deploy a per-source runtime Lambda onto the fixed substrate.
 *
 * Reconciliation of the two approved choices: we DO deploy a per-source Lambda
 * FUNCTION, but every reusable/risky thing is pre-provisioned once
 * (deploy/cloudformation/mcp-onthefly.yaml): the execution role, VPC subnets, security
 * group, artifact bucket, and cost budget. This module never creates IAM/VPC/SG —
 * it only creates a function that references them, with hard caps.
 *
 * The deployment zip = a PRE-BUILT runtime base (lambda/mcp-onthefly/runtime + its
 * node_modules, published to S3 once by CI at runtime-base/<version>.zip) with the
 * generated manifest.json injected. The runtime code is fixed; only manifest.json
 * (data) differs per source. (@aws-sdk/* is provided by the Node 20 Lambda runtime;
 * only `pg` needs to be in the base zip.)
 *
 * Env (set on the admin image; see deploy/cloudformation/mcp-onthefly.yaml outputs):
 *   MCP_OTF_ARTIFACT_BUCKET, MCP_OTF_RUNTIME_ROLE_ARN, MCP_OTF_SUBNET_IDS (csv),
 *   MCP_OTF_SECURITY_GROUP_ID, MCP_OTF_RUNTIME_VERSION (default v1).
 */
import { randomBytes } from 'crypto';
import AdmZip from 'adm-zip';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  LambdaClient,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  PutFunctionConcurrencyCommand,
  DeleteFunctionCommand,
  GetFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import { LAMBDA_INVOKE_SCHEME } from './invoke';
import type { Engine, Manifest } from './types';

const REGION = process.env.AWS_REGION || 'us-west-2';
const ARTIFACT_BUCKET = process.env.MCP_OTF_ARTIFACT_BUCKET || 'mcp-otf-artifacts-628203515088';
const RUNTIME_ROLE_ARN = process.env.MCP_OTF_RUNTIME_ROLE_ARN || '';
const RUNTIME_VERSION = process.env.MCP_OTF_RUNTIME_VERSION || 'v1';

// Shared VPC (Postgres / AWS-reachable targets).
const SHARED_SUBNET_IDS = (process.env.MCP_OTF_SUBNET_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const SHARED_SECURITY_GROUP_ID = process.env.MCP_OTF_SECURITY_GROUP_ID || '';

// CMF VPC (SQL Server / on-prem targets reached over the Site-to-Site VPN).
// Defaults are the live CMF private subnets + egress SG (faborch-cmf-app-egress).
const CMF_SUBNET_IDS = (process.env.MCP_OTF_CMF_SUBNET_IDS || 'subnet-0cfc26eb17af33330,subnet-03de8d1716947ddfb').split(',').map((s) => s.trim()).filter(Boolean);
const CMF_SECURITY_GROUP_ID = process.env.MCP_OTF_CMF_SECURITY_GROUP_ID || 'sg-0dc3bdccf1d97f2c3';

// Pick the runtime base zip + VPC placement for the target engine.
function runtimeTarget(engine: Engine) {
  if (engine === 'sqlserver') {
    return {
      baseKey: `runtime-base/${RUNTIME_VERSION}-mssql.zip`,
      subnetIds: CMF_SUBNET_IDS,
      securityGroupId: CMF_SECURITY_GROUP_ID,
      vpc: 'CMF',
    };
  }
  return {
    baseKey: `runtime-base/${RUNTIME_VERSION}.zip`,
    subnetIds: SHARED_SUBNET_IDS,
    securityGroupId: SHARED_SECURITY_GROUP_ID,
    vpc: 'shared',
  };
}

// Hard runtime caps (cost + blast-radius guardrails).
const TIMEOUT_SECONDS = 30;
const MEMORY_MB = 256;
const RESERVED_CONCURRENCY = 2;
const NAME_PREFIX = 'mcp-otf';

let _s3: S3Client | null = null;
let _lambda: LambdaClient | null = null;
const s3 = () => (_s3 ??= new S3Client({ region: REGION }));
const lambda = () => (_lambda ??= new LambdaClient({ region: REGION }));

function functionName(dataSourceId: string): string {
  return `${NAME_PREFIX}-${dataSourceId.slice(0, 20)}`;
}

// A VPC Lambda is created in Pending state while its ENI is provisioned (~30-60s);
// it can't be invoked until Active. Poll until it's ready.
async function waitForActive(name: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const c = await lambda().send(new GetFunctionConfigurationCommand({ FunctionName: name }));
    if (c.State === 'Active' && (c.LastUpdateStatus ?? 'Successful') === 'Successful') return;
    if (c.State === 'Failed') throw new Error(`function entered Failed state: ${c.StateReason ?? ''}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('function did not become Active in time (VPC ENI setup timed out)');
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  // @ts-expect-error Node stream is async-iterable at runtime
  for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

/** Fetch the pre-built runtime base zip and inject the generated manifest.json. */
async function buildDeploymentZip(manifest: Manifest, baseKey: string): Promise<Buffer> {
  let baseBuf: Buffer;
  try {
    const obj = await s3().send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: baseKey }));
    baseBuf = await streamToBuffer(obj.Body);
  } catch (e) {
    // Say WHICH artifact failed: a missing base zip and bad AWS credentials look
    // the same to the admin otherwise.
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    throw new Error(`could not fetch the runtime base s3://${ARTIFACT_BUCKET}/${baseKey} — ${msg}`);
  }
  const zip = new AdmZip(baseBuf);
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'));
  return zip.toBuffer();
}

export interface DeployResult {
  lambdaArn: string;
  endpointUrl: string;
  bearer: string;
  runtimeVersion: string;
}

/**
 * Deploy a runtime function for a data source. Idempotent-ish: caller should have
 * set status DEPLOYING and handle failures by marking FAILED with the message.
 */
export async function deployRuntime(params: {
  dataSourceId: string;
  secretArn: string;
  manifest: Manifest;
  engine?: Engine;
  existingBearer?: string; // reuse on re-deploy so existing assignments keep working
}): Promise<DeployResult> {
  const engine: Engine = params.engine === 'sqlserver' ? 'sqlserver' : 'postgres';
  const target = runtimeTarget(engine);
  if (!RUNTIME_ROLE_ARN || !target.subnetIds.length || !target.securityGroupId) {
    throw new Error(`On-the-fly MCP substrate is not configured for the ${target.vpc} VPC (need MCP_OTF_RUNTIME_ROLE_ARN + ${engine === 'sqlserver' ? 'MCP_OTF_CMF_SUBNET_IDS / MCP_OTF_CMF_SECURITY_GROUP_ID' : 'MCP_OTF_SUBNET_IDS / MCP_OTF_SECURITY_GROUP_ID'}). Deploy the substrate + set the env vars.`);
  }
  const name = functionName(params.dataSourceId);
  const bearer = params.existingBearer || randomBytes(32).toString('hex');

  // 1) build + upload the per-source zip (engine-specific runtime base)
  const zipBuf = await buildDeploymentZip(params.manifest, target.baseKey);
  const codeKey = `functions/${name}.zip`;
  await s3().send(new PutObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: codeKey, Body: zipBuf }));

  // 2) create the function on the FIXED substrate (VPC chosen by engine), with hard
  //    caps. Idempotent: if a prior (e.g. failed) attempt left the function, update it.
  const envVars = {
    SECRET_ARN: params.secretArn,
    MCP_BEARER_TOKEN: bearer,
    MAX_ROWS: '1000',
    MAX_OUTPUT_BYTES: '1000000',
    STATEMENT_TIMEOUT_MS: '15000',
  };
  let lambdaArn: string;
  try {
    const created = await lambda().send(
      new CreateFunctionCommand({
        FunctionName: name,
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: RUNTIME_ROLE_ARN,
        Code: { S3Bucket: ARTIFACT_BUCKET, S3Key: codeKey },
        Timeout: TIMEOUT_SECONDS,
        MemorySize: MEMORY_MB,
        VpcConfig: { SubnetIds: target.subnetIds, SecurityGroupIds: [target.securityGroupId] },
        Environment: { Variables: envVars },
        Tags: { feature: 'mcp-onthefly', mcp_data_source_id: params.dataSourceId },
      }),
    );
    lambdaArn = created.FunctionArn!;
  } catch (e) {
    if ((e as { name?: string })?.name !== 'ResourceConflictException') throw e;
    // Function already exists (prior attempt) — update config then code in place.
    await lambda().send(new UpdateFunctionConfigurationCommand({
      FunctionName: name, Role: RUNTIME_ROLE_ARN, Timeout: TIMEOUT_SECONDS, MemorySize: MEMORY_MB,
      VpcConfig: { SubnetIds: target.subnetIds, SecurityGroupIds: [target.securityGroupId] },
      Environment: { Variables: envVars },
    }));
    await waitForActive(name);
    const updated = await lambda().send(new UpdateFunctionCodeCommand({ FunctionName: name, S3Bucket: ARTIFACT_BUCKET, S3Key: codeKey }));
    lambdaArn = updated.FunctionArn ?? '';
  }

  // 3) cap concurrency (cost guardrail)
  await lambda().send(
    new PutFunctionConcurrencyCommand({ FunctionName: name, ReservedConcurrentExecutions: RESERVED_CONCURRENCY }),
  );

  // 3b) wait until the VPC function is Active before validating/using it
  await waitForActive(name);

  // 4) Address the runtime by function name (lambda-invoke://<name>). We do NOT
  //    create a public Function URL — this account blocks AuthType-NONE URLs via
  //    an org SCP. FO + validation invoke it via the IAM Lambda API instead (the
  //    runtime still checks the Bearer). See ./invoke.ts.
  return { lambdaArn, endpointUrl: `${LAMBDA_INVOKE_SCHEME}${name}`, bearer, runtimeVersion: RUNTIME_VERSION };
}

/** Deprovision on retire: delete the function (Function URL + concurrency go with it). */
export async function deleteRuntime(dataSourceId: string): Promise<void> {
  await lambda().send(new DeleteFunctionCommand({ FunctionName: functionName(dataSourceId) }));
}
