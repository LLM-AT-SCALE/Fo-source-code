/**
 * Build the MCP call trace for a pin request from an assistant message's
 * persisted parts (`messages.parts`, written by /api/chat onFinish).
 *
 * Every MCP tool part is `type: "tool-mcp_<conn8>__<name>"` (see
 * lib/mcp-tool-key.ts). Its `output` carries an `_mcp` annotation
 * `{connectionId, registryId, serverUrl, toolName}` added by the MCP client, so
 * the trace is self-describing. Parts persisted before namespacing (legacy
 * `tool-mcp_<name>`) fall back to matching `conn8` / the conversation's active
 * connections.
 *
 * The trace is what the compiler agent replays, so it keeps args and results
 * verbatim (results capped so a 1 MB tool response cannot bloat the row).
 */

import { mcpConnShort, parseMcpToolKey } from '@/modules/mcp/lib/mcp-tool-key';

export type TraceStep = {
  seq: number;
  toolCallId?: string;
  connectionId: string | null;
  registryId: string | null;
  serverUrl: string | null;
  connectionName: string | null;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  resultTruncated?: boolean;
  durationMs?: number;
  error?: string;
};

export type KnownConnection = {
  id: string;
  name: string;
  serverUrl: string;
  registryId: string | null;
};

const RESULT_CAP_BYTES = 200_000;

type McpAnnotation = { connectionId?: string; registryId?: string | null; serverUrl?: string; toolName?: string };

function readAnnotation(output: unknown): McpAnnotation | null {
  if (!output || typeof output !== 'object') return null;
  const a = (output as { _mcp?: unknown })._mcp;
  return a && typeof a === 'object' ? (a as McpAnnotation) : null;
}

/** Return `output` without the `_mcp` annotation, capped in size. */
function cleanResult(output: unknown): { result: unknown; truncated: boolean } {
  let value = output;
  if (value && typeof value === 'object' && !Array.isArray(value) && '_mcp' in (value as object)) {
    const { _mcp: _ignored, ...rest } = value as Record<string, unknown>;
    void _ignored;
    value = rest;
  }
  let json: string;
  try {
    json = JSON.stringify(value) ?? 'null';
  } catch {
    return { result: String(value), truncated: false };
  }
  if (json.length <= RESULT_CAP_BYTES) return { result: value, truncated: false };
  // Keep the head of the serialised result so the compiler still sees its shape.
  return { result: { truncated: true, head: json.slice(0, RESULT_CAP_BYTES) }, truncated: true };
}

/**
 * Build the ordered trace from persisted message parts.
 * `known` (the conversation's active connections) resolves legacy parts and fills
 * in connection names.
 */
export function buildTrace(parts: unknown, known: KnownConnection[] = []): TraceStep[] {
  if (!Array.isArray(parts)) return [];
  const byShort = new Map<string, KnownConnection>();
  const byId = new Map<string, KnownConnection>();
  for (const c of known) {
    byShort.set(mcpConnShort(c.id), c);
    byId.set(c.id, c);
  }

  const steps: TraceStep[] = [];
  for (const raw of parts) {
    if (!raw || typeof raw !== 'object') continue;
    const part = raw as Record<string, unknown>;
    const type = typeof part.type === 'string' ? part.type : '';
    if (!type.startsWith('tool-')) continue;
    const key = type.slice('tool-'.length);
    const parsed = parseMcpToolKey(key);
    if (!parsed) continue; // not an MCP tool (web_search, code_execution, …)

    const ann = readAnnotation(part.output);
    let conn: KnownConnection | undefined;
    if (ann?.connectionId) conn = byId.get(ann.connectionId);
    if (!conn && parsed.connShort) conn = byShort.get(parsed.connShort);
    // Legacy un-namespaced part with exactly one known connection: assume it.
    if (!conn && !parsed.connShort && known.length === 1) conn = known[0];

    const { result, truncated } = cleanResult(part.output);
    const state = typeof part.state === 'string' ? part.state : '';
    steps.push({
      seq: steps.length + 1,
      toolCallId: typeof part.toolCallId === 'string' ? part.toolCallId : undefined,
      connectionId: ann?.connectionId ?? conn?.id ?? null,
      registryId: ann?.registryId ?? conn?.registryId ?? null,
      serverUrl: ann?.serverUrl ?? conn?.serverUrl ?? null,
      connectionName: conn?.name ?? null,
      toolName: ann?.toolName ?? parsed.toolName,
      args: (part.input && typeof part.input === 'object' ? (part.input as Record<string, unknown>) : {}),
      result,
      ...(truncated ? { resultTruncated: true } : {}),
      ...(typeof part.durationMs === 'number' ? { durationMs: part.durationMs } : {}),
      ...(state === 'output-error' ? { error: typeof part.errorText === 'string' ? part.errorText : 'tool error' } : {}),
    });
  }
  return steps;
}

/** Distinct servers touched by a trace, in first-seen order — the request's default scope. */
export function traceServers(trace: TraceStep[]): { registryId: string | null; serverUrl: string | null; connectionId: string | null }[] {
  const seen = new Set<string>();
  const out: { registryId: string | null; serverUrl: string | null; connectionId: string | null }[] = [];
  for (const s of trace) {
    const k = s.registryId ?? s.serverUrl ?? s.connectionId ?? '';
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ registryId: s.registryId, serverUrl: s.serverUrl, connectionId: s.connectionId });
  }
  return out;
}
