/**
 * Read-side helpers for dashboard requests (pure; used by the admin API routes).
 * The trace is written by Fab Orchestrator (lib/fabinsight/pin/trace.ts):
 * ordered `{seq, connectionId, registryId, serverUrl, connectionName, toolName, args, result, error?}`.
 */

export const REQUEST_STATUSES = [
  "requested",
  "approved",
  "compiling",
  "compile_failed",
  "preview_ready",
  "live",
  "denied",
  "cancelled",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Statuses that need an admin to act (drives the sidebar badge). */
export const PENDING_STATUSES: RequestStatus[] = ["requested", "preview_ready"];

/** Audit actions that make up a request's timeline. */
export const TIMELINE_ACTIONS = [
  "dashboard.requested",
  "report.request_approved",
  "report.request_denied",
  "report.compile_requested",
  "dashboard.compile_ready",
  "dashboard.compile_failed",
  "report.dashboard_live",
] as const;

export type TraceStepSummary = {
  seq: number;
  toolName: string;
  serverUrl: string | null;
  registryId: string | null;
  connectionName: string | null;
  rowCount: number | null;
  error: string | null;
};

export type TraceServer = { registryId: string | null; serverUrl: string | null; connectionName: string | null };

function rowCountOf(result: unknown): number | null {
  if (result === null || result === undefined) return null;
  if (Array.isArray(result)) return result.length;
  if (typeof result === "string") return rowCountOf(tryJson(result));
  if (typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.rowCount === "number") return r.rowCount;
  if (Array.isArray(r.rows)) return r.rows.length;
  // MCP tool result: {content:[{type:'text', text:'{"rows":[…]}'}]}
  if (Array.isArray(r.content)) {
    for (const c of r.content as Array<Record<string, unknown>>) {
      if (c && typeof c.text === "string") {
        const n = rowCountOf(tryJson(c.text));
        if (n !== null) return n;
      }
    }
  }
  if (typeof r.head === "string") return rowCountOf(tryJson(r.head));
  return null;
}

function tryJson(s: string): unknown {
  const t = s.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Per-call summary of a request trace (no args/results — those stay in the DB). */
export function summarizeTrace(trace: unknown): TraceStepSummary[] {
  if (!Array.isArray(trace)) return [];
  return trace.map((raw, i) => {
    const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return {
      seq: typeof s.seq === "number" ? s.seq : i + 1,
      toolName: typeof s.toolName === "string" ? s.toolName : "?",
      serverUrl: typeof s.serverUrl === "string" ? s.serverUrl : null,
      registryId: typeof s.registryId === "string" ? s.registryId : null,
      connectionName: typeof s.connectionName === "string" ? s.connectionName : null,
      rowCount: rowCountOf(s.result),
      error: typeof s.error === "string" ? s.error : null,
    };
  });
}

/** Distinct servers touched by a trace, in first-seen order. */
export function traceServers(trace: unknown): TraceServer[] {
  const seen = new Set<string>();
  const out: TraceServer[] = [];
  for (const s of summarizeTrace(trace)) {
    const k = s.registryId ?? s.serverUrl ?? "";
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ registryId: s.registryId, serverUrl: s.serverUrl, connectionName: s.connectionName });
  }
  return out;
}

export function kpiCount(kpis: unknown): number {
  return Array.isArray(kpis) ? kpis.length : 0;
}
