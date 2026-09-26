import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/shared/lib/auth-middleware';
import prisma from '@/shared/lib/db';
import { mergeByDisplayName, stripMcpPrefixes } from '@/modules/admin/lib/mcp/mcp-tool-name';
import { buildAuditFilters, parseRange, parseUserParam, type DateRange } from '@/modules/admin/lib/date-range';

/**
 * Response-time metrics, sourced from `prompt_audit_logs.timings`.
 *
 * READ-ONLY. Every query is wrapped so a missing column (an environment where
 * add_prompt_audit_timings.sql has not been run) degrades to empty rather than
 * a 500 — the same resilience contract the dashboard route uses.
 *
 * WHERE THE DATA COMES FROM: the Fab app writes one `timings` object per
 * request (faborchestrator/lib/perf-timer.ts). It carries totalMs, ttftMs,
 * streamMs, a per-phase map, and a per-tool array. Rows written before that
 * shipped have `timings IS NULL` and are excluded throughout, so the figures
 * here are never a mix of measured and unmeasured turns.
 *
 * A NOTE ON TOOL TIME: tools inside one step run CONCURRENTLY and the step
 * waits only for the slowest, so `toolWaitedMs` (sum over steps of each step's
 * slowest call) is what the user actually waited. Summing every tool duration
 * would overstate it. Both are surfaced: the gap between them is the
 * parallelism benefit, and `toolBlockingMs` is the straggler cost.
 */

export const dynamic = 'force-dynamic';

type Percentiles = { p50: number; p80: number; p95: number; max: number };

export interface PerformanceMetrics {
  /** Turns that carry measured timings in the window. */
  measuredTurns: number;
  /** True when nothing has been measured yet — the UI shows an empty state. */
  noData: boolean;
  /** Days spanned by the selected range (legacy name kept for older clients). */
  windowDays: number;
  /** The resolved range + active filters. */
  range: { from: string; to: string; preset: DateRange['preset']; days: number };
  /** Distinct users / models seen in the range, for the filter dropdowns. */
  filters: { users: Array<{ id: string; label: string }>; models: string[]; user: string | null; model: string | null };
  totalMs: Percentiles;
  ttftMs: Percentiles;
  /** Share of turns completing under each threshold, as percentages. */
  under: { s10: number; s20: number; s40: number; s60: number };
  /** Daily trend: median and p95 total time, plus volume. */
  trend: Array<{ day: string; turns: number; p50: number; p95: number; ttft: number }>;
  /** Slowest tools by total time contributed. */
  tools: Array<{ name: string; calls: number; avgMs: number; maxMs: number; totalMs: number }>;
  /** Where a turn's time goes, averaged. */
  breakdown: { ttftMs: number; streamMs: number; toolWaitedMs: number; blockingMs: number };
  /** Slowest individual turns, for drill-down. */
  slowest: Array<{
    promptId: string; user: string; datetime: string; route: string;
    totalMs: number; ttftMs: number; toolCalls: number; topPhase: string;
  }>;
  /** Prompt-cache effectiveness over the same window (from usage_records). */
  cache: { hitRate: number | null; readTokens: number; inputTokens: number };
}

/** Run a query, returning [] if the table/column is absent. */
async function safeRows<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  try {
    return await prisma.$queryRawUnsafe<T[]>(sql, ...params);
  } catch {
    return [];
  }
}

const num = (v: unknown): number => {
  const n = typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const emptyPct = (): Percentiles => ({ p50: 0, p80: 0, p95: 0, max: 0 });

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const sp = req.nextUrl.searchParams;
  const range = parseRange(sp);
  const windowDays = range.days;
  const user = parseUserParam(sp.get('user') ?? sp.get('userId'));
  const model = (sp.get('model') ?? '').trim() || null;

  // Filters for prompt_audit_logs (datetime/user_id/user_email/model) and, with
  // an alias, the tool query that joins the timings array.
  const base = buildAuditFilters({ from: range.from, to: range.to, user, model });
  const aliased = buildAuditFilters({ from: range.from, to: range.to, user, model }, { alias: 'p' });
  // Only measured turns. `timings IS NOT NULL` is the single gate applied
  // everywhere so a percentile is never computed over a mix of measured and
  // unmeasured rows.
  const measured = `timings IS NOT NULL AND ${base.sql}`;
  const measuredAliased = `p.timings IS NOT NULL AND ${aliased.sql}`;
  const params = base.params;
  // usage_records has user_id + model but no email: resolve an email filter to an id.
  let cacheUserId: string | null = user?.id ?? null;
  if (!cacheUserId && user?.email) {
    cacheUserId = (await prisma.user.findFirst({ where: { email: user.email }, select: { id: true } }).catch(() => null))?.id ?? '__none__';
  }
  const cacheFilter = buildAuditFilters(
    { from: range.from, to: range.to, user: cacheUserId ? { id: cacheUserId } : null, model },
    { dateColumn: 'created_at', userEmailColumn: null },
  );

  try {
    const [pctRows, underRows, trendRows, toolRows, breakdownRows, slowRows, cacheRows, userRows, modelRows] =
      await Promise.all([
        safeRows<Record<string, unknown>>(`
          SELECT
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY (timings->>'totalMs')::numeric) AS t50,
            percentile_cont(0.8)  WITHIN GROUP (ORDER BY (timings->>'totalMs')::numeric) AS t80,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY (timings->>'totalMs')::numeric) AS t95,
            MAX((timings->>'totalMs')::numeric) AS tmax,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY (timings->>'ttftMs')::numeric) AS f50,
            percentile_cont(0.8)  WITHIN GROUP (ORDER BY (timings->>'ttftMs')::numeric) AS f80,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY (timings->>'ttftMs')::numeric) AS f95,
            MAX((timings->>'ttftMs')::numeric) AS fmax,
            COUNT(*) AS turns
          FROM prompt_audit_logs WHERE ${measured}`, ...params),

        safeRows<Record<string, unknown>>(`
          SELECT
            COUNT(*) AS turns,
            COUNT(*) FILTER (WHERE (timings->>'totalMs')::numeric <= 10000) AS s10,
            COUNT(*) FILTER (WHERE (timings->>'totalMs')::numeric <= 20000) AS s20,
            COUNT(*) FILTER (WHERE (timings->>'totalMs')::numeric <= 40000) AS s40,
            COUNT(*) FILTER (WHERE (timings->>'totalMs')::numeric <= 60000) AS s60
          FROM prompt_audit_logs WHERE ${measured}`, ...params),

        safeRows<Record<string, unknown>>(`
          SELECT to_char(datetime, 'YYYY-MM-DD') AS day,
                 COUNT(*) AS turns,
                 percentile_cont(0.5)  WITHIN GROUP (ORDER BY (timings->>'totalMs')::numeric) AS p50,
                 percentile_cont(0.95) WITHIN GROUP (ORDER BY (timings->>'totalMs')::numeric) AS p95,
                 AVG((timings->>'ttftMs')::numeric) AS ttft
          FROM prompt_audit_logs WHERE ${measured}
          GROUP BY 1 ORDER BY 1`, ...params),

        // Per-tool, unnested from the timings toolDetail array.
        safeRows<Record<string, unknown>>(`
          SELECT d->>'name' AS name,
                 COUNT(*) AS calls,
                 AVG((d->>'ms')::numeric) AS avg_ms,
                 MAX((d->>'ms')::numeric) AS max_ms,
                 SUM((d->>'ms')::numeric) AS total_ms
          FROM prompt_audit_logs p,
               LATERAL jsonb_array_elements(p.timings->'toolDetail') AS d
          WHERE ${measuredAliased}
          GROUP BY 1 ORDER BY total_ms DESC LIMIT 15`, ...aliased.params),

        safeRows<Record<string, unknown>>(`
          SELECT AVG((timings->>'ttftMs')::numeric)         AS ttft,
                 AVG((timings->>'streamMs')::numeric)       AS stream,
                 AVG((timings->>'toolWaitedMs')::numeric)   AS tool_waited,
                 AVG((timings->>'toolBlockingMs')::numeric) AS blocking
          FROM prompt_audit_logs WHERE ${measured}`, ...params),

        safeRows<Record<string, unknown>>(`
          SELECT prompt_id, COALESCE(user_email, user_name, '-') AS who,
                 to_char(datetime, 'YYYY-MM-DD HH24:MI') AS dt,
                 COALESCE(timings->>'label', '-')        AS route,
                 (timings->>'totalMs')::numeric          AS total_ms,
                 (timings->>'ttftMs')::numeric           AS ttft_ms,
                 COALESCE((timings->>'toolCalls')::int, 0) AS tool_calls,
                 COALESCE(timings->'slowest'->>0, '-')   AS top_phase
          FROM prompt_audit_logs WHERE ${measured}
          ORDER BY (timings->>'totalMs')::numeric DESC NULLS LAST LIMIT 10`, ...params),

        safeRows<Record<string, unknown>>(`
          SELECT SUM(cache_read_tokens) AS read_tokens,
                 SUM(input_tokens)      AS input_tokens,
                 SUM(cache_creation_tokens) AS write_tokens
          FROM usage_records WHERE ${cacheFilter.sql}`, ...cacheFilter.params),

        // Dropdown options: everyone / every model with a measured turn in the RANGE
        // (not narrowed by the current user/model filter, so the admin can switch).
        safeRows<Record<string, unknown>>(`
          SELECT user_id, MAX(COALESCE(user_name, user_email)) AS label, MAX(user_email) AS email
          FROM prompt_audit_logs WHERE timings IS NOT NULL AND datetime >= $1 AND datetime <= $2 AND user_id IS NOT NULL
          GROUP BY user_id ORDER BY label`, range.from, range.to),
        safeRows<Record<string, unknown>>(`
          SELECT DISTINCT model FROM prompt_audit_logs
          WHERE timings IS NOT NULL AND datetime >= $1 AND datetime <= $2 AND model IS NOT NULL ORDER BY model`, range.from, range.to),
      ]);

    const p = pctRows[0] ?? {};
    const u = underRows[0] ?? {};
    const b = breakdownRows[0] ?? {};
    const c = cacheRows[0] ?? {};

    const measuredTurns = num(p.turns);
    const underTotal = num(u.turns) || 1; // avoid divide-by-zero on an empty window
    const cacheTotal = num(c.read_tokens) + num(c.input_tokens) + num(c.write_tokens);

    const metrics: PerformanceMetrics = {
      measuredTurns,
      noData: measuredTurns === 0,
      windowDays,
      range: { from: range.from.toISOString(), to: range.to.toISOString(), preset: range.preset, days: range.days },
      filters: {
        users: userRows.map((r) => ({ id: String(r.user_id), label: String(r.label ?? r.email ?? r.user_id) })),
        models: modelRows.map((r) => String(r.model)),
        user: user?.id ?? user?.email ?? null,
        model,
      },
      totalMs: measuredTurns
        ? { p50: num(p.t50), p80: num(p.t80), p95: num(p.t95), max: num(p.tmax) }
        : emptyPct(),
      ttftMs: measuredTurns
        ? { p50: num(p.f50), p80: num(p.f80), p95: num(p.f95), max: num(p.fmax) }
        : emptyPct(),
      under: {
        s10: (num(u.s10) / underTotal) * 100,
        s20: (num(u.s20) / underTotal) * 100,
        s40: (num(u.s40) / underTotal) * 100,
        s60: (num(u.s60) / underTotal) * 100,
      },
      trend: trendRows.map((r) => ({
        day: String(r.day),
        turns: num(r.turns),
        p50: num(r.p50),
        p95: num(r.p95),
        ttft: num(r.ttft),
      })),
      // Two connections exposing the same tool collapse to one display name.
      tools: mergeByDisplayName(
        toolRows.map((r) => ({
          name: String(r.name ?? 'unknown'),
          calls: num(r.calls),
          avgMs: num(r.avg_ms),
          maxMs: num(r.max_ms),
          totalMs: num(r.total_ms),
        })),
        'name',
        { sum: ['calls', 'totalMs'], max: ['maxMs'], avg: ['avgMs', 'calls'] },
      ).sort((a, b) => b.totalMs - a.totalMs),
      breakdown: {
        ttftMs: num(b.ttft),
        streamMs: num(b.stream),
        toolWaitedMs: num(b.tool_waited),
        blockingMs: num(b.blocking),
      },
      slowest: slowRows.map((r) => ({
        promptId: String(r.prompt_id ?? '-'),
        user: String(r.who ?? '-'),
        datetime: String(r.dt ?? '-'),
        route: String(r.route ?? '-'),
        totalMs: num(r.total_ms),
        ttftMs: num(r.ttft_ms),
        toolCalls: num(r.tool_calls),
        topPhase: stripMcpPrefixes(String(r.top_phase ?? '-')),
      })),
      cache: {
        hitRate: cacheTotal > 0 ? (num(c.read_tokens) / cacheTotal) * 100 : null,
        readTokens: num(c.read_tokens),
        inputTokens: num(c.input_tokens),
      },
    };

    return NextResponse.json(metrics);
  } catch (error) {
    console.error('[admin/performance] failed:', error);
    return NextResponse.json({ error: 'Failed to load performance metrics' }, { status: 500 });
  }
}
