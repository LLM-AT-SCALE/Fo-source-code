/**
 * Connecting to an MCP server: `initialize` + `tools/list`, with the outcome
 * written back to the `mcp_connections` row (status, lastError, tools).
 *
 * Two callers:
 *  - POST /api/mcp/connections/[id]/test — a user with configuration rights
 *    pressing Connect / Test on their own connection;
 *  - `autoConnectMcp` — every connection a role is entitled to is connected
 *    automatically the first time it is listed or used, so users without
 *    configuration rights never have to press anything. Only a connection a
 *    user deliberately disconnected (status `disconnected`, inactive) is left
 *    alone; failures are retried after a short back-off.
 */

import type { McpConnection } from '@/lib/generated/prisma/client';

import prisma from '@/shared/lib/db';
import { decrypt } from '@/shared/lib/encryption';
import { isLambdaInvokeUrl, functionNameFromUrl, invokeLambdaRpc } from '@/modules/mcp/lib/mcp-lambda';

type DiscoveredTool = { name: string; description: string; inputSchema: Record<string, unknown> };

export type ConnectOutcome =
  | { success: true; status: 'connected'; serverInfo: unknown; tools: DiscoveredTool[]; toolCount: number }
  | { success: false; status: 'error'; error: string };

const RPC_TIMEOUT_MS = 10_000;
/** Do not hammer a failing server: a connection that errored this recently is not retried. */
const AUTO_RETRY_AFTER_MS = 2 * 60_000;

type RpcEnvelope = {
  error?: { message?: string };
  result?: { serverInfo?: unknown; tools?: RawTool[] };
  tools?: RawTool[];
};
type RawTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };

/**
 * Our stored secret for the connector cannot be read. Nothing was sent to the
 * server, so this says nothing about the server's health.
 */
export class McpCredentialsError extends Error {
  name = 'McpCredentialsError';
}

function bearerFrom(connection: McpConnection): string | undefined {
  if (connection.authType !== 'api_key' || !connection.authCredentialsEncrypted) return undefined;
  try {
    return JSON.parse(decrypt(connection.authCredentialsEncrypted)).apiKey || undefined;
  } catch (e) {
    // Fail with the real reason. Carrying on without the key sent the request
    // unauthenticated, and the only trace left was the server's "HTTP 401" —
    // which points at the server when the problem is our stored secret.
    console.error('[MCP Connect] Error decrypting credentials:', e);
    throw new McpCredentialsError(
      'The saved credentials for this connector could not be decrypted (the encryption key may have changed). Re-enter the API key for this connector.',
    );
  }
}

function normaliseTools(tools: RawTool[] | undefined): DiscoveredTool[] {
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || {} }));
}

/** Parse a JSON or SSE (`data:` lines) MCP HTTP response into its last JSON-RPC message. */
async function parseHttpResponse(response: Response): Promise<RpcEnvelope> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return (await response.json()) as RpcEnvelope;

  const text = await response.text();
  if (contentType.includes('text/event-stream')) {
    let last: RpcEnvelope | null = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;
      try { last = JSON.parse(jsonStr) as RpcEnvelope; } catch { /* skip malformed line */ }
    }
    if (last) return last;
  }
  try {
    return JSON.parse(text) as RpcEnvelope;
  } catch {
    throw new Error(`Unable to parse response: ${text.slice(0, 200)}`);
  }
}

const INITIALIZE = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, clientInfo: { name: 'llmatscale-ai', version: '1.0.0' } },
};
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };
const TOOLS_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

/**
 * What a probe learned. `toolsError` is set when the server is up but listing
 * its tools failed. `reachMs` / `toolsMs` time the two calls (the health
 * checker records them; connect ignores them).
 */
export type McpProbe = {
  serverInfo: unknown;
  tools: DiscoveredTool[];
  sessionId?: string;
  toolsError?: string;
  reachMs: number;
  toolsMs?: number;
};

/**
 * Bound a Lambda invoke: the SDK call has no deadline of its own, so a runtime
 * that never answers would otherwise hold the caller (and a health-check
 * worker slot) forever.
 */
async function withTimeout<T>(p: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`)), timeoutMs);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function probeLambda(connection: McpConnection, timeoutMs: number): Promise<McpProbe> {
  const fn = functionNameFromUrl(connection.serverUrl);
  const bearer = bearerFrom(connection);
  const t0 = Date.now();
  const init = (await withTimeout(invokeLambdaRpc(fn, bearer, INITIALIZE), timeoutMs, 'initialize')) as RpcEnvelope;
  if (init.error) throw new Error(init.error.message || 'MCP error');
  const reachMs = Date.now() - t0;
  const t1 = Date.now();
  const list = (await withTimeout(invokeLambdaRpc(fn, bearer, TOOLS_LIST), timeoutMs, 'tools/list')) as RpcEnvelope;
  return {
    serverInfo: init.result?.serverInfo ?? null,
    tools: normaliseTools(list.result?.tools || list.tools),
    ...(list.error ? { toolsError: `Listing its tools failed: ${list.error.message || 'MCP error'}` } : {}),
    reachMs,
    toolsMs: Date.now() - t1,
  };
}

function httpHeaders(connection: McpConnection): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const bearer = bearerFrom(connection);
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
  return headers;
}

async function probeHttp(connection: McpConnection, timeoutMs: number): Promise<McpProbe> {
  const headers = httpHeaders(connection);

  const t0 = Date.now();
  const response = await fetch(connection.serverUrl, {
    method: 'POST', headers, body: JSON.stringify(INITIALIZE), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 200)}`);
  }
  const sessionId = response.headers.get('mcp-session-id') || response.headers.get('x-session-id') || undefined;
  const init = await parseHttpResponse(response);
  if (init.error) throw new Error(init.error.message || 'Unknown MCP error');
  const reachMs = Date.now() - t0;

  // The MCP handshake ends with `notifications/initialized`; spec-strict
  // stateful servers (the Python SDK among them) refuse every request on the
  // session until it arrives. Best-effort: a server that ignores it loses nothing.
  if (sessionId) {
    await fetch(connection.serverUrl, {
      method: 'POST',
      headers: { ...headers, 'Mcp-Session-Id': sessionId },
      body: JSON.stringify(INITIALIZED),
      signal: AbortSignal.timeout(timeoutMs),
    }).then((r) => r.body?.cancel()).catch(() => { /* the next call reports any real failure */ });
  }

  // A server that is up but refuses tools/list still counts as connected — but
  // WHY it has no tools is kept (as lastError), so the chat can say so instead
  // of guessing "no tools discovered yet".
  let tools: DiscoveredTool[] = [];
  let toolsError: string | undefined;
  const t1 = Date.now();
  try {
    const toolsResponse = await fetch(connection.serverUrl, {
      method: 'POST',
      headers: sessionId ? { ...headers, 'Mcp-Session-Id': sessionId } : headers,
      body: JSON.stringify(TOOLS_LIST),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (toolsResponse.ok) {
      const list = await parseHttpResponse(toolsResponse);
      if (list.error) toolsError = `Listing its tools failed: ${list.error.message || 'MCP error'}`;
      tools = normaliseTools(list.result?.tools || list.tools);
    } else {
      const body = (await toolsResponse.text()).slice(0, 200);
      console.log('[MCP Connect] tools/list failed:', body);
      toolsError = `Listing its tools failed: HTTP ${toolsResponse.status}${body ? ` — ${body}` : ''}`;
    }
  } catch (toolError) {
    console.error('[MCP Connect] Tool discovery error:', toolError);
    toolsError = `Listing its tools failed: ${toolError instanceof Error ? toolError.message : String(toolError)}`;
  }
  return { serverInfo: init.result?.serverInfo ?? null, tools, sessionId, toolsError, reachMs, toolsMs: Date.now() - t1 };
}

/**
 * `initialize` + `tools/list` against a connection row WITHOUT writing anything
 * back. Throws when the server cannot be reached (stage 1); a server that is
 * up but cannot list its tools returns with `toolsError` set. `timeoutMs`
 * bounds each of the two calls (default 10 s; the health checker allows more).
 */
export async function probeMcpServer(connection: McpConnection, opts: { timeoutMs?: number } = {}): Promise<McpProbe> {
  const timeoutMs = opts.timeoutMs ?? RPC_TIMEOUT_MS;
  return isLambdaInvokeUrl(connection.serverUrl) ? await probeLambda(connection, timeoutMs) : await probeHttp(connection, timeoutMs);
}

/** The raw shape of a `tools/call` result. */
export type RawToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

/**
 * One `tools/call` over the same transport as the probe, with no connection-row
 * state involved: the health checker uses it for its data stage, straight after
 * `probeMcpServer` (whose `sessionId` is passed along for stateful HTTP servers).
 * Throws with the server's own reason — HTTP status and body, the JSON-RPC
 * error message, or the timeout — and never records anything.
 */
export async function callMcpToolRaw(
  connection: McpConnection,
  call: { name: string; arguments: Record<string, unknown>; sessionId?: string; timeoutMs?: number },
): Promise<RawToolResult> {
  const timeoutMs = call.timeoutMs ?? RPC_TIMEOUT_MS;
  const rpc = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: call.name, arguments: call.arguments } };
  type CallEnvelope = { error?: { message?: string; code?: number }; result?: RawToolResult };

  if (isLambdaInvokeUrl(connection.serverUrl)) {
    const res = (await withTimeout(
      invokeLambdaRpc(functionNameFromUrl(connection.serverUrl), bearerFrom(connection), rpc),
      timeoutMs,
      call.name,
    )) as CallEnvelope;
    if (res.error) throw new Error(res.error.message || 'MCP error');
    return res.result ?? {};
  }

  const headers = httpHeaders(connection);
  if (call.sessionId) headers['Mcp-Session-Id'] = call.sessionId;
  const response = await fetch(connection.serverUrl, {
    method: 'POST', headers, body: JSON.stringify(rpc), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ''}`);
  }
  const res = (await parseHttpResponse(response)) as CallEnvelope;
  if (res.error) throw new Error(res.error.message || 'MCP error');
  return res.result ?? {};
}

/**
 * Connect one row and persist the result. On failure a personal connection is
 * also deactivated (as the manual Test button always did); an admin-managed
 * (role-level) connection keeps `isActive`, which is the admin's assignment flag.
 */
export async function connectMcpConnection(connection: McpConnection): Promise<ConnectOutcome> {
  try {
    const probe = await probeMcpServer(connection);
    await prisma.mcpConnection.update({
      where: { id: connection.id },
      data: {
        status: 'connected',
        // Up, but possibly without tools — keep the reason if listing failed.
        lastError: probe.toolsError ?? null,
        isActive: true,
        lastConnectedAt: new Date(),
        // Prisma Json column; the discovered tool list needs the cast.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        availableTools: probe.tools as any,
        ...(probe.sessionId ? { sessionId: probe.sessionId } : {}),
      },
    });
    return { success: true, status: 'connected', serverInfo: probe.serverInfo, tools: probe.tools, toolCount: probe.tools.length };
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Connection failed';
    const managed = connection.roleId != null && connection.userId == null;
    await prisma.mcpConnection.update({
      where: { id: connection.id },
      data: { status: 'error', lastError: error, ...(managed ? {} : { isActive: false }) },
    }).catch((writeErr) => {
      // Best-effort, but not silent: a stale status makes the chat report an
      // old cause for this connector.
      console.error('[MCP Connect] could not save the failed status for', connection.id, writeErr);
    });
    return { success: false, status: 'error', error };
  }
}

export type AutoConnectOptions = {
  /**
   * Honour a deliberate disconnect (status `disconnected`, inactive) on personal
   * rows. Only meaningful for users who can configure their own connections;
   * for everyone else every entitled connection is connected, full stop.
   */
  respectManualOff?: boolean;
};

/** True when the row should be (re)connected automatically. */
function shouldAutoConnect(connection: McpConnection, opts: AutoConnectOptions = {}, now = Date.now()): boolean {
  if (connection.status === 'connected') return false;
  const managed = connection.roleId != null && connection.userId == null;
  // A personal connection the user switched off on purpose stays off — but only
  // when that user has a Connect button to switch it back on.
  if (opts.respectManualOff && !managed && connection.status === 'disconnected' && !connection.isActive) return false;
  // Recent failure: wait before retrying.
  if (connection.status === 'error' && now - connection.updatedAt.getTime() < AUTO_RETRY_AFTER_MS) return false;
  return true;
}

/**
 * Connect every row that needs it, in parallel, and return the rows with their
 * fresh status. Rows that were already connected (or must not be touched) are
 * returned unchanged, so this is free in the steady state.
 */
export async function autoConnectMcp(connections: McpConnection[], opts: AutoConnectOptions = {}): Promise<McpConnection[]> {
  const now = Date.now();
  const pending = connections.filter((c) => shouldAutoConnect(c, opts, now));
  if (pending.length === 0) return connections;

  await Promise.allSettled(pending.map((c) => connectMcpConnection(c)));

  const refreshed = await prisma.mcpConnection.findMany({ where: { id: { in: pending.map((c) => c.id) } } });
  const byId = new Map(refreshed.map((c) => [c.id, c]));
  return connections.map((c) => byId.get(c.id) ?? c);
}
