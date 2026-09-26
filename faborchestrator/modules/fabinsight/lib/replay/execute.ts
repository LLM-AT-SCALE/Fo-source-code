/**
 * Run a replay program: resolve servers, make the MCP calls (in order, per
 * server, servers in parallel), merge results, bind the template, compute
 * KPIs and the summary.
 *
 * No model is involved. `executeMcpTool` is imported lazily so unit tests can
 * inject a stub without loading the MCP client (and its prisma dependency).
 */

import type { ToolResult } from './mcp-result';
import { parseToolResult } from './mcp-result';
import { ExpressionError, resolveArgs } from './expressions';
import { programShifts, type Call, type ConnectionScope, type Program } from './program';
import { resolvePath, toNumber, type ResultRow, type SetResult } from './paths';
import { resolveServers as defaultResolveServers, type ResolvedServer } from './servers';
import { bindTemplate } from './bind';
import { buildSummary, type KpiValue } from './summary';

export type ExecFn = (connectionId: string, toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;

export type RunCtx = {
  now?: Date;
  exec?: ExecFn;
  resolveServers?: (scope: ConnectionScope) => Promise<ResolvedServer[]>;
  /** Pre-resolved servers (skips `resolveServers`). */
  servers?: ResolvedServer[];
  perCallTimeoutMs?: number;
  /** Extra attempts after a timeout (default 1). Never retried: missing tool / invalid params. */
  retries?: number;
};

type ServerStatus = {
  registryId: string;
  serverUrl: string;
  connectionId?: string;
  label: string;
  ok: boolean;
  reason?: 'no-connection' | 'missing-tool' | 'timeout' | 'error';
  error?: string;
  /** Calls that failed on a server that otherwise answered (a partial result). */
  failedCalls?: number;
};

export type RunResult = {
  html: string;
  summary: string;
  /** One entry per call id, in program order (merged across servers). */
  sets: SetResult[];
  kpis: KpiValue[];
  perServer: ServerStatus[];
  /** True when no server produced a non-errored, non-optional set — keep the last-good snapshot. */
  allFailed: boolean;
  drift: string[];
  durationMs: number;
  notes: string[];
};

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

type CallOutcome = { set: SetResult; missingTool?: boolean; timedOut?: boolean };

async function callOnce(
  exec: ExecFn,
  connectionId: string,
  call: Call,
  args: Record<string, unknown>,
  timeoutMs: number,
  retries: number,
): Promise<{ parsed: ReturnType<typeof parseToolResult>; timedOut: boolean }> {
  let attempt = 0;
  for (;;) {
    try {
      const r = await withTimeout(exec(connectionId, call.toolName, args), timeoutMs);
      return { parsed: parseToolResult(r), timedOut: false };
    } catch (e) {
      const isTimeout = e instanceof TimeoutError || (e as { name?: string })?.name === 'TimeoutError';
      if (isTimeout && attempt < retries) {
        attempt++;
        continue;
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { parsed: { error: (isTimeout ? 'timeout: ' : '') + msg.slice(0, 400) }, timedOut: isTimeout };
    }
  }
}

/** Run every call of the program against one server. */
async function runOnServer(
  program: Program,
  server: ResolvedServer,
  exec: ExecFn,
  now: Date,
  timeoutMs: number,
  retries: number,
): Promise<{ status: ServerStatus; results: Map<string, SetResult> }> {
  const results = new Map<string, SetResult>();
  const status: ServerStatus = {
    registryId: server.registryId,
    serverUrl: server.serverUrl,
    connectionId: server.connectionId,
    label: server.label,
    ok: false,
  };
  const label = (c: Call) => c.label ?? c.id;

  if (!server.connectionId || (server.connectionStatus && server.connectionStatus !== 'connected')) {
    status.reason = 'no-connection';
    // Carry the stored cause: "connection … is error" alone sends people to
    // look at the dashboard when the answer is in the connection's last error.
    status.error = server.connectionId
      ? `the connection is ${server.connectionStatus ?? 'not connected'}${server.connectionError ? `: ${server.connectionError}` : ''}`
      : 'no active connection exists for this server';
    for (const c of program.calls) results.set(c.id, { key: c.id, label: label(c), rows: [], columns: [], error: status.error });
    return { status, results };
  }

  const tz = program.time.timezone;
  const shifts = programShifts(program);
  let okCount = 0;
  let missing = 0;
  let timeouts = 0;
  let errors = 0;
  let lastError: string | undefined;

  for (const call of program.calls) {
    const outcome: CallOutcome = { set: { key: call.id, label: label(call), rows: [], columns: [] } };
    try {
      // forEach: expand into one call per item of an earlier result.
      let items: unknown[] | null = null;
      if (call.forEach) {
        const src = resolvePath(call.forEach.$ref, results);
        if (!Array.isArray(src)) throw new ExpressionError(`forEach source "${call.forEach.$ref}" did not resolve to a list`, call.forEach.$ref);
        items = src.slice(0, call.forEach.max ?? 25);
      }
      const runs: { vars?: Record<string, unknown>; item?: unknown }[] = items
        ? items.map((item) => ({ vars: { [call.forEach!.as]: item }, item }))
        : [{}];
      const rows: ResultRow[] = [];
      let columns: string[] = [];
      let capped = false;
      let note: string | undefined;
      let err: string | undefined;
      for (const run of runs) {
        const args = resolveArgs(call.args, { now, tz, shifts, results, vars: run.vars });
        const { parsed, timedOut } = await callOnce(exec, server.connectionId, call, args, timeoutMs, retries);
        if ('error' in parsed) {
          if (parsed.missingTool) outcome.missingTool = true;
          if (timedOut) outcome.timedOut = true;
          err = parsed.error;
          break;
        }
        const tagged = items ? parsed.rows.map((r) => ({ ...r, _item: run.item })) : parsed.rows;
        rows.push(...tagged);
        if (!columns.length) columns = items && parsed.columns.length ? [...parsed.columns, '_item'] : parsed.columns;
        capped = capped || parsed.capped;
        note = note ?? parsed.note;
      }
      outcome.set.rows = rows;
      outcome.set.columns = columns;
      if (capped) outcome.set.capped = true;
      if (err) outcome.set.error = err;
      else if (note && !rows.length && note !== 'empty result') outcome.set.error = undefined;
    } catch (e) {
      outcome.set.error = e instanceof Error ? e.message : String(e);
    }

    results.set(call.id, outcome.set);
    if (outcome.set.error) {
      lastError = outcome.set.error;
      if (outcome.missingTool) missing++;
      else if (outcome.timedOut) timeouts++;
      else errors++;
    } else if (!call.optional) {
      okCount++;
    } else {
      okCount++; // optional success still means the server answered
    }
  }

  status.ok = okCount > 0;
  if (!status.ok) {
    status.reason = missing && !errors && !timeouts ? 'missing-tool' : timeouts && !errors ? 'timeout' : 'error';
    status.error = lastError;
  } else if (missing || errors || timeouts) {
    // The server answered, but some calls did not: those panels are blank.
    // Say how many and why, so a partial refresh is never reported as "ok".
    const failed = missing + errors + timeouts;
    status.failedCalls = failed;
    status.error = `${failed} of ${program.calls.length} call${program.calls.length === 1 ? '' : 's'} failed: ${lastError ?? 'unknown error'}`;
  }
  return { status, results };
}

/** Merge per-server sets for one call into a single set (adds a `server` column when >1 server). */
function mergeSets(call: Call, per: { label: string; set: SetResult }[], multi: boolean): SetResult {
  const label = call.label ?? call.id;
  if (!multi) {
    const only = per[0]?.set;
    return only ? { ...only, key: call.id, label, server: per[0].label } : { key: call.id, label, rows: [], columns: [], error: 'no server' };
  }
  const rows: ResultRow[] = [];
  const columns = new Set<string>(['server']);
  const serverErrors: Record<string, string> = {};
  let capped = false;
  for (const { label: srv, set } of per) {
    if (set.error) {
      serverErrors[srv] = set.error;
      continue;
    }
    for (const c of set.columns.length ? set.columns : set.rows.length ? Object.keys(set.rows[0]) : []) columns.add(c);
    for (const r of set.rows) rows.push({ server: srv, ...r });
    capped = capped || !!set.capped;
  }
  const allErrored = per.length > 0 && per.every((p) => p.set.error);
  const out: SetResult = { key: call.id, label, rows, columns: [...columns] };
  if (capped) out.capped = true;
  if (Object.keys(serverErrors).length) out.serverErrors = serverErrors;
  if (allErrored) out.error = Object.values(serverErrors)[0] ?? 'all servers failed';
  return out;
}

/** Resolve a KPI path; only a HEALTHY set that fails to resolve counts as drift. */
function resolveKpi(path: string, results: Map<string, SetResult>, drift: Set<string>): unknown {
  const id = /^([A-Za-z_][A-Za-z0-9_]*)\./.exec(path)?.[1];
  const set = id ? results.get(id) : undefined;
  if (!set || set.error) return undefined;
  const v = resolvePath(path, results);
  if (v === undefined) drift.add(path);
  return v;
}

function kpiValues(program: Program, merged: Map<string, SetResult>, perServer: { label: string; results: Map<string, SetResult> }[], drift: Set<string>): KpiValue[] {
  const out: KpiValue[] = [];
  const multi = perServer.length > 1;
  for (const k of program.kpis) {
    const coerce = (v: unknown): number | string | null => {
      if (v === undefined) return null;
      if (k.numeric) return toNumber(v);
      if (v === null) return null;
      if (typeof v === 'number') return v;
      // A list-valued KPI (a whole result set) reads as its size; a single
      // object has no sensible scalar form and is left out of summaries.
      if (Array.isArray(v)) return v.every((x) => x === null || typeof x !== 'object') ? v.map((x) => String(x ?? '')).join(', ') : `${v.length} rows`;
      if (typeof v === 'object') return null;
      return String(v);
    };
    if (multi && k.aggregate === 'none') {
      for (const s of perServer) {
        const v = resolveKpi(k.path, s.results, drift);
        out.push({ label: k.label, value: coerce(v), unit: k.unit, server: s.label });
      }
      continue;
    }
    let v = resolveKpi(k.path, merged, drift);
    if (k.aggregate && k.aggregate !== 'none' && Array.isArray(v)) {
      const nums = v.map(toNumber).filter((x): x is number => x !== null);
      v = k.aggregate === 'sum' ? nums.reduce((a, b) => a + b, 0) : nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    }
    out.push({ label: k.label, value: coerce(v), unit: k.unit });
  }
  return out;
}

async function defaultExec(): Promise<ExecFn> {
  const { executeMcpTool } = await import('@/modules/mcp/lib/mcp-client');
  return (connectionId, toolName, args) => executeMcpTool(connectionId, toolName, args, null);
}

/**
 * Execute `program` and fill `template`. Never throws for data problems —
 * they land in `sets[].error`, `perServer[]`, `drift` and `allFailed`.
 */
export async function runProgram(program: Program, template: string, ctx: RunCtx = {}): Promise<RunResult> {
  const started = Date.now();
  const now = ctx.now ?? new Date();
  const timeoutMs = ctx.perCallTimeoutMs ?? 45_000;
  const retries = ctx.retries ?? 1;
  const notes: string[] = [];

  const servers = ctx.servers ?? (await (ctx.resolveServers ?? defaultResolveServers)(program.scope));
  const exec = ctx.exec ?? (await defaultExec());

  const settled = await Promise.allSettled(servers.map((s) => runOnServer(program, s, exec, now, timeoutMs, retries)));
  const perServerRuns: { server: ResolvedServer; status: ServerStatus; results: Map<string, SetResult> }[] = settled.map((r, i) => {
    if (r.status === 'fulfilled') return { server: servers[i], ...r.value };
    const err = r.reason instanceof Error ? r.reason.message : String(r.reason);
    const results = new Map<string, SetResult>();
    for (const c of program.calls) results.set(c.id, { key: c.id, label: c.label ?? c.id, rows: [], columns: [], error: err });
    return {
      server: servers[i],
      status: { registryId: servers[i].registryId, serverUrl: servers[i].serverUrl, connectionId: servers[i].connectionId, label: servers[i].label, ok: false, reason: 'error', error: err },
      results,
    };
  });

  const multi = servers.length > 1;
  const merged = new Map<string, SetResult>();
  for (const call of program.calls) {
    merged.set(
      call.id,
      mergeSets(
        call,
        perServerRuns.map((r) => ({ label: r.status.label, set: r.results.get(call.id)! })),
        multi,
      ),
    );
  }
  if (!servers.length) {
    notes.push('no servers resolved for this program');
    for (const call of program.calls) merged.set(call.id, { key: call.id, label: call.label ?? call.id, rows: [], columns: [], error: 'no servers resolved' });
  }

  const drift = new Set<string>();
  const kpis = kpiValues(program, merged, perServerRuns.map((r) => ({ label: r.status.label, results: r.results })), drift);
  const summary = buildSummary(program, kpis);
  const bound = bindTemplate(template, merged, { now, summary });
  for (const d of bound.drift) drift.add(d);

  // Drift on a path marks its set as errored (unless it already is), so refresh
  // treats it like a failed fetch rather than rendering blanks as "ok".
  for (const path of drift) {
    const id = /^([A-Za-z_][A-Za-z0-9_]*)\./.exec(path)?.[1];
    const set = id ? merged.get(id) : undefined;
    if (set && !set.error) set.error = `shape drift: ${path}`;
  }

  const sets = program.calls.map((c) => merged.get(c.id)!);
  const nonOptional = program.calls.filter((c) => !c.optional);
  const okNonOptional = nonOptional.filter((c) => !merged.get(c.id)?.error).length;
  const allFailed = nonOptional.length > 0 && okNonOptional === 0;
  for (const s of sets) if (s.capped) notes.push(`${s.label}: result was capped by the server; totals may be partial`);

  return {
    html: bound.html,
    summary,
    sets,
    kpis,
    perServer: perServerRuns.map((r) => r.status),
    allFailed,
    drift: [...drift],
    durationMs: Date.now() - started,
    notes,
  };
}
