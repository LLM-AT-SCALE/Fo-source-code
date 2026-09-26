/**
 * FabOrch — faithful failure capture for the chat surface.
 *
 * DESIGN RULE: capture everything, invent nothing.
 * ------------------------------------------------
 * This module does NOT decide what an error "means" from a list of known
 * phrases. A phrase-book only works for failures someone predicted; in
 * production people ask questions we never tried, and the one error that
 * matters is always the one not in the list — which would fall through to a
 * generic line and be exactly as useless as "temporarily unavailable".
 *
 * So instead we EXTRACT whatever the real error actually carries — every
 * property that exists on it, the full `cause` chain, HTTP status, response
 * body, JSON-RPC code, the tool and the arguments it ran with — and persist
 * that. The chat shows a short line plus an error id; the action button reads
 * the stored record back and shows what was really captured.
 *
 * Any human-readable summary is DERIVED from that captured data at render
 * time, is clearly secondary, and never replaces or hides the raw text.
 *
 * Scope: this module diagnoses and records. Fixing the underlying MCP faults
 * is separate work owned elsewhere.
 */

/** Everything we managed to observe about one failure. All fields optional by
 *  design — an unknown error still produces a useful record. */
export interface ErrorDetail {
  /** UUID shown in chat and searchable in the admin console. */
  errorId: string;
  /** Catalog category, when one was assigned. Never used to write prose. */
  type?: string;
  priority?: 'HIGH' | 'MEDIUM';
  /** ISO timestamp of capture. */
  at: string;

  // ── What the user was doing ──────────────────────────────────────────
  /** Connector display name, read from the connection record at runtime. */
  connector?: string;
  /** Server URL / transport target of the connector. */
  connectorUrl?: string;
  /** MCP tool that was running. */
  toolName?: string;
  /** Arguments the model passed to that tool. */
  toolArgs?: Record<string, unknown>;

  // ── What actually failed (verbatim, never paraphrased) ───────────────
  /** `err.name` — e.g. "AbortError", "RequestError", "TimeoutError". */
  name?: string;
  /** `err.message`, untouched. The single most useful field. */
  message?: string;
  /** Node/driver codes: `code`, `errno`, `syscall`. Whatever was present. */
  code?: string;
  errno?: number;
  syscall?: string;
  /** HTTP status, when the transport produced one. */
  httpStatus?: number;
  /** Raw response body from the failing endpoint, when we read one. */
  responseBody?: string;
  /** JSON-RPC error code and message from a reachable MCP server. */
  rpcCode?: number;
  rpcMessage?: string;
  /** Full `cause` chain, outermost first — where the real reason usually is. */
  causeChain?: string[];
  /** Stack trace. */
  stack?: string;
  /** Any other own-properties the error carried that we did not name above.
   *  This is the catch-all that makes unforeseen errors survive intact. */
  extra?: Record<string, unknown>;

  // ── Grouping (set by groupFailures) ────────────────────────────────────
  /** How many identical failures this record stands for. Absent means 1. */
  occurrences?: number;
  /** What each occurrence was fetching — dashboard panel labels, tool names. */
  affected?: string[];
  /** The other occurrences' error ids, so every audit row stays reachable. */
  relatedErrorIds?: string[];

  /**
   * True when the SAME tool succeeded later in the same turn — the model hit
   * this failure, corrected course, and the answer it produced is complete.
   *
   * A model exploring a schema will often run a probe that the database
   * rejects, read the real columns, and try again. That failure is real and is
   * recorded, but it did not cost the user anything, and an amber warning under
   * a finished dashboard reads as "something is wrong" when nothing is. The
   * card renders a recovered failure as a quiet note instead.
   */
  recovered?: boolean;
}

/**
 * Collapse identical failures into one record.
 *
 * A dashboard runs eight queries. When the MES is unreachable all eight fail
 * with the same cause, and eight cards saying the same sentence is not eight
 * pieces of information — it is one piece of information and seven pieces of
 * noise. Grouping is by system + cause; genuinely different causes stay apart.
 *
 * Every occurrence keeps its own audit row (each was a real, separate query);
 * the grouped record carries their ids so nothing becomes unreachable.
 */
export function groupFailures(details: ErrorDetail[], labels?: string[]): ErrorDetail[] {
  const byKey = new Map<string, ErrorDetail>();
  details.forEach((d, i) => {
    const key = `${d.connector ?? ''}::${(d.rpcMessage || d.message || d.responseBody || d.name || '').slice(0, 300)}`;
    const label = labels?.[i];
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, {
        ...d,
        occurrences: 1,
        affected: label ? [label] : undefined,
        relatedErrorIds: undefined,
      });
      return;
    }
    seen.occurrences = (seen.occurrences ?? 1) + 1;
    if (label) seen.affected = [...(seen.affected ?? []), label];
    seen.relatedErrorIds = [...(seen.relatedErrorIds ?? []), d.errorId];
  });
  return [...byKey.values()];
}

/** Cap a string so one huge driver dump cannot blow up the stream or the row. */
function clip(s: unknown, max: number): string | undefined {
  if (s === null || s === undefined) return undefined;
  const str = typeof s === 'string' ? s : String(s);
  if (!str) return undefined;
  return str.length > max ? `${str.slice(0, max)}…[truncated]` : str;
}

/** Properties we lift into named fields; everything else lands in `extra`. */
const NAMED = new Set([
  'name', 'message', 'code', 'errno', 'syscall', 'stack', 'cause',
  'status', 'statusCode', 'httpStatus', 'response', 'body',
]);

/**
 * Walk the `cause` chain. Node wraps errors (fetch → undici → socket), and the
 * actionable reason is usually two or three levels down, not at the top.
 */
function causeChain(err: unknown, max = 5): string[] {
  const out: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < max && cur; i++) {
    const next: unknown = (cur as { cause?: unknown })?.cause;
    if (!next) break;
    const label =
      next instanceof Error
        ? `${next.name}: ${next.message}`
        : typeof next === 'string'
          ? next
          : safeJson(next);
    if (label) out.push(clip(label, 500)!);
    cur = next;
  }
  return out;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Numeric HTTP status, wherever it happens to live on this error shape. */
function statusOf(err: unknown, explicit?: number): number | undefined {
  if (typeof explicit === 'number') return explicit;
  const e = err as Record<string, unknown> | null;
  for (const k of ['status', 'statusCode', 'httpStatus']) {
    const v = e?.[k];
    if (typeof v === 'number') return v;
  }
  // Last resort: a status embedded in the message, e.g. "HTTP 401: denied".
  const m = /\bHTTP (\d{3})\b/.exec(err instanceof Error ? err.message : String(err ?? ''));
  return m ? Number(m[1]) : undefined;
}

export interface CaptureInput {
  errorId: string;
  /** The thrown value, whatever it is. */
  cause: unknown;
  type?: string;
  priority?: 'HIGH' | 'MEDIUM';
  connector?: string;
  connectorUrl?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  httpStatus?: number;
  responseBody?: string;
  rpcCode?: number;
  rpcMessage?: string;
}

/**
 * Build the full record for one failure by reading the real error object.
 *
 * Nothing here is keyed off a known-error list: every field is whatever the
 * runtime actually produced. An error type this codebase has never seen still
 * yields its name, message, codes, cause chain and stack.
 */
export function captureError(input: CaptureInput): ErrorDetail {
  const err = input.cause;
  const asErr = err as Record<string, unknown> | null;

  // Collect any own-properties we did not name — the reason unforeseen errors
  // still arrive with their useful bits attached.
  const extra: Record<string, unknown> = {};
  if (err && typeof err === 'object') {
    for (const key of Object.getOwnPropertyNames(err)) {
      if (NAMED.has(key)) continue;
      const v = (err as Record<string, unknown>)[key];
      if (v === undefined || typeof v === 'function') continue;
      extra[key] = typeof v === 'object' ? clip(safeJson(v), 1000) : v;
    }
  }

  const chain = causeChain(err);

  return {
    errorId: input.errorId,
    type: input.type,
    priority: input.priority,
    at: new Date().toISOString(),

    connector: input.connector,
    connectorUrl: input.connectorUrl,
    toolName: input.toolName,
    toolArgs: input.toolArgs,

    name: err instanceof Error ? err.name : typeof asErr?.name === 'string' ? asErr.name : undefined,
    message:
      err instanceof Error
        ? clip(err.message, 4000)
        : typeof err === 'string'
          ? clip(err, 4000)
          : clip(safeJson(err), 4000),
    code: typeof asErr?.code === 'string' ? asErr.code : undefined,
    errno: typeof asErr?.errno === 'number' ? asErr.errno : undefined,
    syscall: typeof asErr?.syscall === 'string' ? asErr.syscall : undefined,
    httpStatus: statusOf(err, input.httpStatus),
    responseBody: clip(input.responseBody, 4000),
    rpcCode: input.rpcCode,
    rpcMessage: clip(input.rpcMessage, 1000),
    causeChain: chain.length ? chain : undefined,
    stack: err instanceof Error ? clip(err.stack, 4000) : undefined,
    extra: Object.keys(extra).length ? extra : undefined,
  };
}

/**
 * A one-line summary DERIVED from the captured record — for the chat bubble,
 * where there is no room for the full record.
 *
 * Deliberately thin: it prefers the real text the system produced and only
 * adds context around it. It never substitutes a friendly sentence for an
 * error it does not recognise, because the raw text is more useful than a
 * guess. The action button is what shows the whole record.
 */
export function summarize(d: ErrorDetail): string {
  // Name the connector when we know it; otherwise stay neutral. A stream-level
  // provider error has no connector and must not be blamed on "the data
  // source", which would point people at the wrong system.
  const where = d.connector
    ? `“${d.connector}”${d.toolName ? ` (${d.toolName})` : ''}`
    : (d.toolName ?? 'This request');

  // Prefer the deepest cause — that is where the real reason usually sits.
  const deepest = d.causeChain?.length ? d.causeChain[d.causeChain.length - 1] : undefined;
  const raw = d.rpcMessage || deepest || d.message || d.responseBody || d.name;

  const parts = [`${where} failed`];
  if (d.httpStatus) parts.push(`HTTP ${d.httpStatus}`);
  if (d.code) parts.push(d.code);
  if (typeof d.rpcCode === 'number') parts.push(`JSON-RPC ${d.rpcCode}`);

  const head = parts.join(' · ');
  return raw ? `${head} — ${firstLine(raw)}` : head;
}

function firstLine(text: string): string {
  const line = String(text).split('\n')[0].trim();
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/**
 * Recover an errorId from a tool result the model has already consumed.
 * Tool results carry it as `(errorId=<uuid>)`.
 */
export function errorIdFrom(value: unknown): string | null {
  const text =
    typeof value === 'string' ? value : value && typeof value === 'object' ? safeJson(value) : '';
  const m = /errorId=([0-9a-f-]{36})/i.exec(text);
  return m ? m[1] : null;
}
