// Deploy (or update) the shared DISCOVERY Lambda into the CMF VPC. Run once.
// Idempotent: creates mcp-otf-discovery, or updates its code if it exists.
//
//   # clear any expired personal session first, then use the static profile:
//   $env:AWS_SESSION_TOKEN=$null; $env:AWS_ACCESS_KEY_ID=$null; $env:AWS_SECRET_ACCESS_KEY=$null
//   $env:AWS_PROFILE="mcp-otf-deployer"
//   node scripts/deploy-discovery-lambda.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LambdaClient, CreateFunctionCommand, UpdateFunctionCodeCommand, UpdateFunctionConfigurationCommand, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';

const REGION = 'us-west-2';
const ROLE = 'arn:aws:iam::628203515088:role/mcp-otf-runtime-exec';
const CMF_SUBNETS = ['subnet-0cfc26eb17af33330', 'subnet-03de8d1716947ddfb'];
const CMF_SG = 'sg-0dc3bdccf1d97f2c3';
const NAME = 'mcp-otf-discovery';

const here = dirname(fileURLToPath(import.meta.url));
const zip = readFileSync(join(here, '..', '..', 'lambda', 'mcp-onthefly', 'discovery-v1.zip'));
const lambda = new LambdaClient({ region: REGION });

async function waitActive() {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const c = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: NAME }));
    console.log(`  state=${c.State} lastUpdate=${c.LastUpdateStatus || ''}`);
    if (c.State === 'Active' && (c.LastUpdateStatus || 'Successful') === 'Successful') return true;
    if (c.State === 'Failed') { console.error('failed:', c.StateReason); return false; }
  }
  return false;
}

try {
  await lambda.send(new CreateFunctionCommand({
    FunctionName: NAME, Runtime: 'nodejs20.x', Handler: 'index.handler', Role: ROLE,
    Code: { ZipFile: zip }, Timeout: 120, MemorySize: 512,
    VpcConfig: { SubnetIds: CMF_SUBNETS, SecurityGroupIds: [CMF_SG] },
    Tags: { feature: 'mcp-onthefly' },
  }));
  console.log('discovery Lambda creating in CMF VPC (ENI setup ~30-60s)...');
} catch (e) {
  if (e.name === 'ResourceConflictException') {
    console.log('discovery Lambda exists — updating timeout + code...');
    await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: NAME, Timeout: 120, MemorySize: 512 }));
    await waitActive();
    await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: NAME, ZipFile: zip }));
  } else { console.error('CreateFunction failed:', e.name, e.message); process.exit(1); }
}

const ok = await waitActive();
console.log(ok ? `✔ ${NAME} is Active — the admin app can now discover schemas via it.` : `✖ ${NAME} did not become Active in time.`);
process.exit(ok ? 0 : 2);
