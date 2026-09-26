/**
 * On-the-Fly MCP — invoke the shared discovery Lambda (in the CMF VPC) to read a
 * target's schema from INSIDE the VPC. This is how discovery works for targets the
 * admin app can't reach directly (on-prem SQL Server, in-VPC Postgres). The creds
 * never leave AWS — the Lambda reads them from Secrets Manager by ARN.
 */
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { DiscoveryResult } from './connectivity';

const REGION = process.env.AWS_REGION || 'us-west-2';
const FUNCTION = process.env.MCP_OTF_DISCOVERY_FUNCTION || 'mcp-otf-discovery';

let _lambda: LambdaClient | null = null;
const lambda = () => (_lambda ??= new LambdaClient({ region: REGION }));

/**
 * `kind` says which side failed, because the two need opposite advice:
 *  - 'platform': the discovery service itself could not be called or crashed
 *    (function missing, no permission, bad platform credentials). The admin's
 *    connection details are NOT the problem; the platform setup is.
 *  - 'target': the service ran and could not reach or read the admin's database
 *    (wrong host, credentials, firewall). The connection details ARE the problem.
 */
export type DiscoveryFailureKind = 'platform' | 'target';
export interface DiscoverViaLambdaResult { ok: boolean; tables?: DiscoveryResult['tables']; error?: string; kind?: DiscoveryFailureKind }
export const DISCOVERY_FUNCTION_NAME = FUNCTION;

/** Invoke the discovery Lambda synchronously; returns the discovered schema or an error. */
export async function discoverViaLambda(
  secretArn: string, engine: string, schemas: string[],
): Promise<DiscoverViaLambdaResult> {
  let res;
  try {
    res = await lambda().send(new InvokeCommand({
      FunctionName: FUNCTION,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify({ secretArn, engine, schemas })),
    }));
  } catch (e) {
    // Name the call that failed: without this the admin only sees the bare AWS
    // text ("The security token included in the request is invalid.").
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { ok: false, kind: 'platform', error: `could not invoke the discovery Lambda "${FUNCTION}" — ${msg}` };
  }

  if (res.FunctionError) {
    return { ok: false, kind: 'platform', error: `discovery lambda error: ${res.FunctionError}` };
  }
  if (!res.Payload) return { ok: false, kind: 'platform', error: 'discovery lambda returned no payload' };
  let out: DiscoverViaLambdaResult;
  try {
    out = JSON.parse(Buffer.from(res.Payload).toString('utf8'));
  } catch {
    return { ok: false, kind: 'platform', error: 'discovery lambda returned invalid JSON' };
  }
  // The service ran: whatever it reports is about the admin's database.
  return out.ok ? out : { ...out, kind: out.kind ?? 'target' };
}
