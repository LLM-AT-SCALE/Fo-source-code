// Retire on-the-fly MCP data sources that have a deployed runtime Lambda but ZERO
// assignments (or are FAILED) — the proper deprovision the retire flow does:
// delete the Lambda + its Secrets Manager secret + its mcp_registry row (+ any
// connections), then mark the source RETIRED. SAFETY: only sources with a runtime
// Lambda AND 0 assignments are ever touched — assigned sources cannot be selected.
//
//   node scripts/retire-unassigned-datasources.mjs           # dry run (lists only)
//   node scripts/retire-unassigned-datasources.mjs --apply   # actually retire
import { readFileSync } from 'node:fs';
import { promises as dns } from 'node:dns';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { LambdaClient, DeleteFunctionCommand } from '@aws-sdk/client-lambda';
import { SecretsManagerClient, DeleteSecretCommand } from '@aws-sdk/client-secrets-manager';

const APPLY = process.argv.includes('--apply');
const REGION = 'us-west-2';
const here = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(join(here, '..', '..', '.env'), 'utf8');
const url = new URL(env.match(/^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/m)[1]);
const { address: host } = await dns.lookup(url.hostname, { family: 4 });
const c = new pg.Client({ host, port: +(url.port || 5432), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), ssl: false });
await c.connect();

const { rows } = await c.query(`
  select ds.id, ds.name, ds.status, ds.secret_arn, ds.registry_id,
         coalesce(ds.lambda_arn, ds.endpoint_url) as fnref,
         (select count(*)::int from mcp_connections mc where mc.registry_id = ds.registry_id) as assignments
  from mcp_data_sources ds
  where (ds.lambda_arn is not null or ds.endpoint_url like 'lambda-invoke://%')
    and (select count(*) from mcp_connections mc where mc.registry_id = ds.registry_id) = 0
  order by ds.updated_at desc`);

const fnName = (ref) => (ref || '').replace(/^arn:aws:lambda:[^:]+:\d+:function:/, '').replace('lambda-invoke://', '');
console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${rows.length} source(s) with a runtime Lambda and 0 assignments:\n`);
for (const r of rows) console.log(`  ${fnName(r.fnref).padEnd(28)} | ${r.status.padEnd(9)} | assigned ${r.assignments} | ${r.name}`);
if (rows.some((r) => r.assignments > 0)) { console.error('\nABORT: an assigned source slipped into the set — refusing to proceed.'); process.exit(2); }
if (!APPLY) { console.log('\n(dry run — pass --apply to retire these)'); await c.end(); process.exit(0); }

const lambda = new LambdaClient({ region: REGION });
const sm = new SecretsManagerClient({ region: REGION });
console.log('');
for (const r of rows) {
  const fn = fnName(r.fnref);
  const notes = [];
  // 1) delete the runtime Lambda
  try { await lambda.send(new DeleteFunctionCommand({ FunctionName: fn })); notes.push('lambda deleted'); }
  catch (e) { notes.push(e?.name === 'ResourceNotFoundException' ? 'lambda already gone' : `lambda err: ${e?.name}`); }
  // 2) delete the target secret
  if (r.secret_arn) {
    // Shared by another live data source (credential reuse at intake)? Keep it.
    const { rows: sharers } = await c.query(
      `select count(*)::int as n from mcp_data_sources where secret_arn=$1 and status<>'RETIRED' and id<>$2`, [r.secret_arn, r.id],
    );
    if (sharers[0]?.n > 0) notes.push('secret kept (shared)');
    else try { await sm.send(new DeleteSecretCommand({ SecretId: r.secret_arn, ForceDeleteWithoutRecovery: true })); notes.push('secret deleted'); }
    catch (e) { notes.push(e?.name === 'ResourceNotFoundException' ? 'secret already gone' : `secret err: ${e?.name}`); }
  }
  // 3) delete registry row (+ any connections — should be 0)
  if (r.registry_id) {
    await c.query('delete from mcp_connections where registry_id = $1', [r.registry_id]);
    await c.query('delete from mcp_registry where id = $1', [r.registry_id]);
    notes.push('registry removed');
  }
  // 4) mark the source RETIRED and drop the now-dangling references
  await c.query(
    `update mcp_data_sources set status='RETIRED', lambda_arn=null, endpoint_url=null, secret_arn=null, endpoint_auth_encrypted=null, registry_id=null, updated_at=now() where id=$1`,
    [r.id],
  );
  notes.push('marked RETIRED');
  console.log(`✔ ${r.name} (${fn}) — ${notes.join(', ')}`);
}
await c.end();
console.log('\nDone.');
