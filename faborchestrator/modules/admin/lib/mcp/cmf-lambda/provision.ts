/**
 * Per-connection CMF token Lambda provisioning.
 *
 * When an admin creates a CMF database connection, we provision a dedicated
 * token-refresher Lambda + a 45-min EventBridge schedule for it. The Lambda code
 * is a SINGLE pre-built artifact in S3 (headless-Chromium portal login + `pg`
 * Postgres writer — see lambda/cmf-token/); only the ENV VARS differ per
 * connection. The Lambda mints the MES JWT and UPSERTs it into
 * `cmf_bearer_tokens`, keyed by TOKEN_DB_NAME.
 *
 * We create only a FUNCTION + a RULE that reference pre-existing, ops-owned
 * infrastructure (IAM role, VPC subnet/SG, artifact bucket) — never IAM/VPC/SG.
 *
 * Env (set on the admin environment; sane defaults match the existing two token
 * Lambdas so this works out of the box):
 *   CMF_LAMBDA_ARTIFACT_BUCKET   default mcp-otf-artifacts-628203515088
 *   CMF_LAMBDA_ARTIFACT_KEY      default cmf-token/runtime.zip
 *   CMF_LAMBDA_ROLE_ARN          default arn:aws:iam::628203515088:role/feb-orc-mcp-lambda-role
 *   CMF_LAMBDA_SUBNET_IDS        default subnet-050098578f3a0fbad (csv)
 *   CMF_LAMBDA_SECURITY_GROUP_ID default sg-0299b94298e64e570
 *   CMF_LAMBDA_SCHEDULE_RATE     default "rate(45 minutes)"
 *   DATABASE_URL                 the shared RDS URL (passed to the Lambda)
 */
import {
  LambdaClient,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  DeleteFunctionCommand,
  AddPermissionCommand,
  RemovePermissionCommand,
  InvokeCommand,
  GetFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import {
  EventBridgeClient,
  PutRuleCommand,
  PutTargetsCommand,
  RemoveTargetsCommand,
  DeleteRuleCommand,
} from "@aws-sdk/client-eventbridge";

const REGION = process.env.AWS_REGION || "us-west-2";
const ARTIFACT_BUCKET = process.env.CMF_LAMBDA_ARTIFACT_BUCKET || "mcp-otf-artifacts-628203515088";
const ARTIFACT_KEY = process.env.CMF_LAMBDA_ARTIFACT_KEY || "cmf-token/runtime.zip";
const ROLE_ARN = process.env.CMF_LAMBDA_ROLE_ARN || "arn:aws:iam::628203515088:role/feb-orc-mcp-lambda-role";
const SUBNET_IDS = (process.env.CMF_LAMBDA_SUBNET_IDS || "subnet-050098578f3a0fbad")
  .split(",").map((s) => s.trim()).filter(Boolean);
const SECURITY_GROUP_ID = process.env.CMF_LAMBDA_SECURITY_GROUP_ID || "sg-0299b94298e64e570";
const SCHEDULE_RATE = process.env.CMF_LAMBDA_SCHEDULE_RATE || "rate(45 minutes)";

// Match the existing token Lambdas (Chromium needs the memory + /tmp space).
const TIMEOUT_SECONDS = 180;
const MEMORY_MB = 2048;
const EPHEMERAL_MB = 1024;

let _lambda: LambdaClient | null = null;
let _events: EventBridgeClient | null = null;
const lambda = () => (_lambda ??= new LambdaClient({ region: REGION }));
const events = () => (_events ??= new EventBridgeClient({ region: REGION }));

/** Lambda/rule names allow [a-zA-Z0-9-_]; keep them short + deterministic per key. */
function sanitize(key: string): string {
  return key.replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 40);
}
function functionNameFor(dbKey: string): string {
  return `cmf-token-${sanitize(dbKey)}`;
}
function scheduleNameFor(dbKey: string): string {
  return `cmf-token-refresh-${sanitize(dbKey)}`;
}

export interface ProvisionInput {
  dbKey: string;
  baseUrl: string;
  portalUser: string;
  portalPassword: string; // plaintext (decrypted by the caller)
  /** [[host, ip], ...]; the minting Lambda uses a single "host=ip" string. */
  hostResolver: Array<[string, string]>;
  tokenDbName: string;
  tokenSecretId?: string | null; // optional Secrets Manager dual-write
  /** Reuse an already-provisioned Lambda / schedule instead of deriving new names
   *  (so re-provisioning a connection UPDATES its function rather than creating a
   *  duplicate — e.g. the two seeded connections whose Lambdas were named by a
   *  different convention). Derived from the connection's stored lambda_arn/schedule_name. */
  existingFunctionName?: string | null;
  existingScheduleName?: string | null;
}

export interface ProvisionResult {
  lambdaArn: string;
  scheduleName: string;
}

/** A VPC function is Pending while its ENI provisions (~30-60s). Bounded wait. */
async function waitForActive(name: string, maxMs = 120_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const c = await lambda().send(new GetFunctionConfigurationCommand({ FunctionName: name }));
    if (c.State === "Active" && (c.LastUpdateStatus ?? "Successful") === "Successful") return true;
    if (c.State === "Failed") throw new Error(`Lambda entered Failed state: ${c.StateReason ?? ""}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

function hostResolverEnv(pairs: Array<[string, string]>, baseUrl: string): string {
  if (!pairs.length) return "";
  // Prefer the pair whose host matches the base URL host; else the first.
  let host = "";
  try { host = new URL(baseUrl).host.toLowerCase(); } catch { /* ignore */ }
  const match = pairs.find(([h]) => h.toLowerCase() === host) ?? pairs[0];
  return `${match[0]}=${match[1]}`;
}

/**
 * Provision (or update, if it already exists) the connection's token Lambda +
 * 45-min schedule, then best-effort seed the first token. Idempotent per dbKey.
 */
export async function provisionConnectionLambda(input: ProvisionInput): Promise<ProvisionResult> {
  if (!ROLE_ARN || !SUBNET_IDS.length || !SECURITY_GROUP_ID) {
    throw new Error(
      "CMF Lambda substrate is not configured (need CMF_LAMBDA_ROLE_ARN + CMF_LAMBDA_SUBNET_IDS + CMF_LAMBDA_SECURITY_GROUP_ID).",
    );
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set on the admin environment — the Lambda needs it to write the token.");

  // Reuse the existing Lambda/schedule names when the connection already has them
  // (prevents creating a duplicate under a different naming convention on re-save).
  const name = (input.existingFunctionName && input.existingFunctionName.trim()) || functionNameFor(input.dbKey);
  const ruleName = (input.existingScheduleName && input.existingScheduleName.trim()) || scheduleNameFor(input.dbKey);

  const envVars: Record<string, string> = {
    CMF_BASE_URL: input.baseUrl,
    CMF_USER: input.portalUser,
    CMF_PASS: input.portalPassword,
    HOST_RESOLVER: hostResolverEnv(input.hostResolver, input.baseUrl),
    DATABASE_URL: databaseUrl,
    TOKEN_DB_NAME: input.tokenDbName,
    ...(input.tokenSecretId ? { CMF_TOKEN_SECRET_ID: input.tokenSecretId } : {}),
  };

  // 1) Create (or update if a prior attempt left it) the function from the S3 artifact.
  let lambdaArn: string;
  try {
    const created = await lambda().send(
      new CreateFunctionCommand({
        FunctionName: name,
        Runtime: "nodejs20.x",
        Handler: "index.handler",
        Role: ROLE_ARN,
        Code: { S3Bucket: ARTIFACT_BUCKET, S3Key: ARTIFACT_KEY },
        Timeout: TIMEOUT_SECONDS,
        MemorySize: MEMORY_MB,
        EphemeralStorage: { Size: EPHEMERAL_MB },
        VpcConfig: { SubnetIds: SUBNET_IDS, SecurityGroupIds: [SECURITY_GROUP_ID] },
        Environment: { Variables: envVars },
        Tags: { feature: "cmf-token", cmf_db_key: input.dbKey },
      }),
    );
    lambdaArn = created.FunctionArn ?? "";
  } catch (e) {
    if ((e as { name?: string })?.name !== "ResourceConflictException") throw e;
    await lambda().send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: name,
        Role: ROLE_ARN,
        Timeout: TIMEOUT_SECONDS,
        MemorySize: MEMORY_MB,
        EphemeralStorage: { Size: EPHEMERAL_MB },
        VpcConfig: { SubnetIds: SUBNET_IDS, SecurityGroupIds: [SECURITY_GROUP_ID] },
        Environment: { Variables: envVars },
      }),
    );
    await waitForActive(name);
    const updated = await lambda().send(
      new UpdateFunctionCodeCommand({ FunctionName: name, S3Bucket: ARTIFACT_BUCKET, S3Key: ARTIFACT_KEY }),
    );
    lambdaArn = updated.FunctionArn ?? "";
  }

  // 2) 45-min EventBridge schedule → this function.
  const rule = await events().send(
    new PutRuleCommand({ Name: ruleName, ScheduleExpression: SCHEDULE_RATE, State: "ENABLED" }),
  );
  // Allow EventBridge to invoke the function (idempotent — ignore duplicate id).
  try {
    await lambda().send(
      new AddPermissionCommand({
        FunctionName: name,
        StatementId: `${ruleName}-invoke`,
        Action: "lambda:InvokeFunction",
        Principal: "events.amazonaws.com",
        SourceArn: rule.RuleArn,
      }),
    );
  } catch (e) {
    if ((e as { name?: string })?.name !== "ResourceConflictException") throw e;
  }
  await events().send(
    new PutTargetsCommand({ Rule: ruleName, Targets: [{ Id: `${name}-target`, Arn: lambdaArn }] }),
  );

  // 3) Best-effort seed: wait until Active, then async-invoke once so the first
  //    token appears without waiting the full 45 min. Non-fatal if it times out —
  //    the scheduled run will seed it.
  try {
    if (await waitForActive(name)) {
      await lambda().send(new InvokeCommand({ FunctionName: name, InvocationType: "Event" }));
    }
  } catch {
    /* seeding is best-effort */
  }

  return { lambdaArn, scheduleName: ruleName };
}

/** Tear down the connection's schedule + Lambda. Best-effort; ignores NotFound. */
export async function deprovisionConnectionLambda(dbKey: string): Promise<void> {
  const name = functionNameFor(dbKey);
  const ruleName = scheduleNameFor(dbKey);
  const ignore = async (p: Promise<unknown>) => {
    try { await p; } catch (e) {
      const n = (e as { name?: string })?.name;
      if (n && n !== "ResourceNotFoundException" && n !== "NotFoundException") {
        console.error(`[cmf-lambda] teardown step failed for ${dbKey}:`, e);
      }
    }
  };
  // Remove targets first (a rule with targets can't be deleted).
  await ignore(events().send(new RemoveTargetsCommand({ Rule: ruleName, Ids: [`${name}-target`] })));
  await ignore(events().send(new DeleteRuleCommand({ Name: ruleName })));
  await ignore(lambda().send(new RemovePermissionCommand({ FunctionName: name, StatementId: `${ruleName}-invoke` })));
  await ignore(lambda().send(new DeleteFunctionCommand({ FunctionName: name })));
}
