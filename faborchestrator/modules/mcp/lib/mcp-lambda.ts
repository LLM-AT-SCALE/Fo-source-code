/**
 * MCP transport over the IAM Lambda API — for on-the-fly MCP servers whose
 * serverUrl is `lambda-invoke://<functionName>` (created in the Admin Console). This
 * account blocks public Lambda Function URLs, so FO addresses these runtimes by
 * function name and calls them via lambda:InvokeFunction instead of HTTP. The
 * runtime handler parses a Function-URL-style event, so we wrap the JSON-RPC in
 * that shape (with the Bearer). Requires the FO EB instance role to have
 * lambda:InvokeFunction on mcp-otf-*.
 */
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const REGION = process.env.AWS_REGION || 'us-west-2';
const LAMBDA_INVOKE_SCHEME = 'lambda-invoke://';

let _lambda: LambdaClient | null = null;
const lambda = () => (_lambda ??= new LambdaClient({ region: REGION }));

export function isLambdaInvokeUrl(serverUrl: string): boolean {
  return typeof serverUrl === 'string' && serverUrl.startsWith(LAMBDA_INVOKE_SCHEME);
}

export function functionNameFromUrl(serverUrl: string): string {
  return serverUrl.slice(LAMBDA_INVOKE_SCHEME.length);
}

/** Invoke a runtime function with a JSON-RPC message; returns the parsed JSON-RPC response. */
export async function invokeLambdaRpc(
  functionName: string,
  bearer: string | undefined,
  rpcBody: unknown,
): Promise<unknown> {
  const event = {
    requestContext: { http: { method: 'POST' } },
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(rpcBody),
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
  if (httpResp.statusCode !== 200) {
    throw new Error(`runtime returned HTTP ${httpResp.statusCode}`);
  }
  return JSON.parse(httpResp.body);
}
