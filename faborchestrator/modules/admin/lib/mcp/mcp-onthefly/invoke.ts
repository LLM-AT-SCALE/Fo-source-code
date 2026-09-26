/**
 * On-the-Fly MCP — invoke a runtime Lambda via the IAM Lambda API (not a public
 * Function URL). This account blocks public (AuthType NONE) Function URLs via an
 * org SCP, so we address the runtime by function name using a `lambda-invoke://`
 * serverUrl and call it with lambda:InvokeFunction. The runtime handler parses a
 * Function-URL-style event, so we wrap the JSON-RPC in that shape (with the Bearer)
 * — identical to what an HTTP Function URL would deliver.
 */
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const REGION = process.env.AWS_REGION || 'us-west-2';
export const LAMBDA_INVOKE_SCHEME = 'lambda-invoke://';

let _lambda: LambdaClient | null = null;
const lambda = () => (_lambda ??= new LambdaClient({ region: REGION }));

/** A serverUrl of the form `lambda-invoke://<functionName>` → the function name. */
export function functionNameFromServerUrl(serverUrl: string): string | null {
  return serverUrl.startsWith(LAMBDA_INVOKE_SCHEME) ? serverUrl.slice(LAMBDA_INVOKE_SCHEME.length) : null;
}

/** Invoke a runtime function with a JSON-RPC message; returns the parsed JSON-RPC response. */
export async function invokeRuntimeRpc(functionName: string, bearer: string, rpc: unknown): Promise<unknown> {
  const event = {
    requestContext: { http: { method: 'POST' } },
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(rpc),
    isBase64Encoded: false,
  };
  const res = await lambda().send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify(event)),
  }));
  if (res.FunctionError) throw new Error(`runtime lambda error: ${res.FunctionError}`);
  const raw = res.Payload ? Buffer.from(res.Payload).toString('utf8') : '';
  const httpResp = JSON.parse(raw) as { statusCode: number; body: string };
  if (httpResp.statusCode !== 200) throw new Error(`runtime returned HTTP ${httpResp.statusCode}`);
  return JSON.parse(httpResp.body);
}
