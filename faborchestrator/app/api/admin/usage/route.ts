import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/shared/lib/auth-middleware';
import prisma from '@/shared/lib/db';
import { handleApiError } from '@/shared/lib/errors/api-error-handler';
import { buildAuditFilters, dayKeys, parseRange, parseUserParam } from '@/modules/admin/lib/date-range';

/**
 * Detailed usage analytics for the admin Usage page. READ-ONLY.
 *
 * ACCURATE SOURCE: token counts and USD cost are sourced from
 * `prompt_audit_logs` (a raw-SQL audit table with real per-prompt data),
 * NOT `usage_records` — the latter historically stored 0 tokens.
 *
 * prompt_audit_logs has no 5-way token split: it records
 * request/retrieval/response tokens + matching *_cost columns. We map
 * tokenBreakdown as { input: request+retrieval, output: response,
 * thinking:0, cacheRead:0, cacheCreation:0 } while keeping every field
 * name so the page keeps working. Per-model breakdown uses the (newly
 * added) `model` column, treating NULL as 'unknown'.
 *
 * Every raw-SQL query is wrapped so a missing table/column degrades to
 * zeros instead of crashing the route.
 */

const num = (v: unknown): number => {
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

interface TotalsRow {
  requests: number | string;
  request_tokens: bigint | number | string;
  retrieval_tokens: bigint | number | string;
  response_tokens: bigint | number | string;
  cost: number | string | null;
  avg_ms: number | string | null;
}

interface ModelRow {
  model: string | null;
  requests: number | string;
  request_tokens: bigint | number | string;
  retrieval_tokens: bigint | number | string;
  response_tokens: bigint | number | string;
  cost: number | string | null;
}

interface UserRow {
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
  requests: number | string;
  tokens: bigint | number | string;
  cost: number | string | null;
}

interface DayRow {
  date: string;
  requests: number | string;
  tokens: bigint | number | string;
  cost: number | string | null;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const url = new URL(req.url);
    // ?range=7|30|90, ?from&to (custom), or legacy ?days; plus optional ?user (id or email) and ?model.
    const range = parseRange(url.searchParams);
    const days = range.days;
    const user = parseUserParam(url.searchParams.get('user') ?? url.searchParams.get('userId'));
    const model = (url.searchParams.get('model') ?? '').trim() || null;
    const f = buildAuditFilters({ from: range.from, to: range.to, user, model });
    const where = f.sql;
    const params = f.params;
    // usage_records has user_id + model but no email: resolve an email filter to an id.
    let cacheUserId: string | null = user?.id ?? null;
    if (!cacheUserId && user?.email) {
      cacheUserId = (await prisma.user.findFirst({ where: { email: user.email }, select: { id: true } }).catch(() => null))?.id ?? '__none__';
    }
    const cacheFilter = buildAuditFilters(
      { from: range.from, to: range.to, user: cacheUserId ? { id: cacheUserId } : null, model },
      { dateColumn: 'created_at', userEmailColumn: null },
    );

    const [totalsRows, byModelRows, byUserRows, dailyRows, modelNames, cacheRows, rateRows, userOptions, modelOptions] =
      await Promise.all([
      prisma
        .$queryRawUnsafe<TotalsRow[]>(
          `SELECT COUNT(*)::int AS requests,
                  COALESCE(SUM(request_tokens),0)::bigint   AS request_tokens,
                  COALESCE(SUM(retrieval_tokens),0)::bigint AS retrieval_tokens,
                  COALESCE(SUM(response_tokens),0)::bigint  AS response_tokens,
                  COALESCE(SUM(COALESCE(request_cost,0)+COALESCE(retrieval_cost,0)+COALESCE(response_cost,0)),0)::float AS cost,
                  COALESCE(ROUND(AVG(response_time_ms)),0)::float AS avg_ms
             FROM prompt_audit_logs
            WHERE ${where}`,
          ...params
        )
        .catch(() => [] as TotalsRow[]),
      prisma
        .$queryRawUnsafe<ModelRow[]>(
          `SELECT COALESCE(model,'unknown') AS model,
                  COUNT(*)::int AS requests,
                  COALESCE(SUM(request_tokens),0)::bigint   AS request_tokens,
                  COALESCE(SUM(retrieval_tokens),0)::bigint AS retrieval_tokens,
                  COALESCE(SUM(response_tokens),0)::bigint  AS response_tokens,
                  COALESCE(SUM(COALESCE(request_cost,0)+COALESCE(retrieval_cost,0)+COALESCE(response_cost,0)),0)::float AS cost
             FROM prompt_audit_logs
            WHERE ${where}
            GROUP BY COALESCE(model,'unknown')`,
          ...params
        )
        .catch(() => [] as ModelRow[]),
      prisma
        .$queryRawUnsafe<UserRow[]>(
          `SELECT user_id, MAX(user_name) AS user_name, MAX(user_email) AS user_email,
                  COUNT(*)::int AS requests,
                  COALESCE(SUM(COALESCE(request_tokens,0)+COALESCE(retrieval_tokens,0)+COALESCE(response_tokens,0)),0)::bigint AS tokens,
                  COALESCE(SUM(COALESCE(request_cost,0)+COALESCE(retrieval_cost,0)+COALESCE(response_cost,0)),0)::float AS cost
             FROM prompt_audit_logs
            WHERE ${where}
            GROUP BY user_id`,
          ...params
        )
        .catch(() => [] as UserRow[]),
      prisma
        .$queryRawUnsafe<DayRow[]>(
          `SELECT TO_CHAR(DATE(datetime), 'YYYY-MM-DD') AS date,
                  COUNT(*)::int AS requests,
                  COALESCE(SUM(COALESCE(request_tokens,0)+COALESCE(retrieval_tokens,0)+COALESCE(response_tokens,0)),0)::bigint AS tokens,
                  COALESCE(SUM(COALESCE(request_cost,0)+COALESCE(retrieval_cost,0)+COALESCE(response_cost,0)),0)::float AS cost
             FROM prompt_audit_logs
            WHERE ${where}
            GROUP BY DATE(datetime)
            ORDER BY date`,
          ...params
        )
        .catch(() => [] as DayRow[]),
      // Optional: friendly model display names from the registry (if present).
      prisma.modelRegistry
        .findMany({ select: { modelId: true, displayName: true } })
        .catch(() => [] as Array<{ modelId: string; displayName: string }>),
      // Prompt-cache tokens per model — from usage_records, which carries the
      // cache_read / cache_creation split (prompt_audit_logs does not).
      prisma
        .$queryRawUnsafe<
          Array<{
            model: string;
            read: bigint | number | string;
            write: bigint | number | string;
            input: bigint | number | string;
          }>
        >(
          `SELECT model,
                  COALESCE(SUM(cache_read_tokens),0)::bigint     AS read,
                  COALESCE(SUM(cache_creation_tokens),0)::bigint AS write,
                  COALESCE(SUM(input_tokens),0)::bigint          AS input
             FROM usage_records WHERE ${cacheFilter.sql} GROUP BY model`,
          ...cacheFilter.params
        )
        .catch(
          () =>
            [] as Array<{
              model: string;
              read: bigint | number | string;
              write: bigint | number | string;
              input: bigint | number | string;
            }>
        ),
      // Per-model base input rates ($/1M) for cache-savings estimation.
      prisma
        .$queryRawUnsafe<Array<{ model_id: string; rate: number | string }>>(
          `SELECT model_id, input_cost_per_1m::float AS rate FROM model_registry`
        )
        .catch(() => [] as Array<{ model_id: string; rate: number | string }>),
      // Dropdown options over the RANGE only (not narrowed by the active filters).
      prisma
        .$queryRawUnsafe<Array<{ user_id: string; label: string | null; email: string | null }>>(
          `SELECT user_id, MAX(COALESCE(user_name, user_email)) AS label, MAX(user_email) AS email
             FROM prompt_audit_logs WHERE datetime >= $1 AND datetime <= $2 AND user_id IS NOT NULL
            GROUP BY user_id ORDER BY label`,
          range.from,
          range.to
        )
        .catch(() => [] as Array<{ user_id: string; label: string | null; email: string | null }>),
      prisma
        .$queryRawUnsafe<Array<{ model: string }>>(
          `SELECT DISTINCT model FROM prompt_audit_logs WHERE datetime >= $1 AND datetime <= $2 AND model IS NOT NULL ORDER BY model`,
          range.from,
          range.to
        )
        .catch(() => [] as Array<{ model: string }>),
    ]);

    const displayNames = new Map<string, string>(
      modelNames.map((m) => [m.modelId, m.displayName])
    );

    // ── Token totals + breakdown ──
    const t = totalsRows[0];
    const tRequest = num(t?.request_tokens);
    const tRetrieval = num(t?.retrieval_tokens);
    const tResponse = num(t?.response_tokens);
    const tInput = tRequest + tRetrieval;
    const tOutput = tResponse;
    const totalTokens = tInput + tOutput;
    const totalRequests = num(t?.requests);
    const totalCost = round2(num(t?.cost));
    const avgRequestDurationMs = Math.round(num(t?.avg_ms));

    // ── Usage by model (with cost) ──
    const byModel = byModelRows
      .map((g) => {
        const model = g.model || 'unknown';
        const input = num(g.request_tokens) + num(g.retrieval_tokens);
        const output = num(g.response_tokens);
        const tokens = input + output;
        return {
          model,
          displayName: displayNames.get(model) || model,
          requests: num(g.requests),
          tokens,
          input,
          output,
          thinking: 0,
          cacheRead: 0,
          cacheCreation: 0,
          cost: round2(num(g.cost)),
        };
      })
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

    // ── Per-user (top spenders / top consumers) ──
    const usersEnriched = byUserRows.map((u) => ({
      userId: u.user_id || 'unknown',
      name: u.user_name || null,
      email: u.user_email || 'unknown',
      requests: num(u.requests),
      tokens: num(u.tokens),
      cost: round2(num(u.cost)),
    }));
    const topUsersByCost = [...usersEnriched].sort((a, b) => b.cost - a.cost).slice(0, 10);
    const topUsersByTokens = [...usersEnriched].sort((a, b) => b.tokens - a.tokens).slice(0, 10);

    // ── Prompt-cache metrics (from usage_records) ──
    const rateMap = new Map<string, number>((rateRows || []).map((r) => [r.model_id, num(r.rate)]));
    const cacheByModel = new Map<string, { read: number; write: number }>();
    const DEFAULT_RATE = 5; // $/1M, Opus-tier fallback for models absent from registry
    let cacheRead = 0, cacheWrite = 0, cacheInput = 0, cacheSavings = 0;
    for (const r of cacheRows || []) {
      const rd = num(r.read), wr = num(r.write), inp = num(r.input);
      cacheRead += rd;
      cacheWrite += wr;
      cacheInput += inp;
      cacheByModel.set(r.model, { read: rd, write: wr });
      const rate = rateMap.get(r.model) ?? DEFAULT_RATE;
      // Cache reads cost ~0.1x base (save 0.9x/tok); writes cost ~1.25x (add 0.25x/tok).
      cacheSavings += (rd * 0.9 - wr * 0.25) * (rate / 1_000_000);
    }
    const cacheDenom = cacheRead + cacheWrite + cacheInput;
    const cacheHitRate = cacheDenom > 0 ? Math.round((cacheRead / cacheDenom) * 1000) / 10 : null;
    // Merge per-model cache tokens into the byModel rows.
    for (const m of byModel) {
      const c = cacheByModel.get(m.model);
      if (c) {
        m.cacheRead = c.read;
        m.cacheCreation = c.write;
      }
    }

    // ── Daily time series (continuous, zero-filled) ──
    const dailyMap = new Map<string, { tokens: number; cost: number; requests: number }>();
    for (const r of dailyRows) {
      dailyMap.set(r.date, {
        tokens: num(r.tokens),
        cost: num(r.cost),
        requests: num(r.requests),
      });
    }
    const timeSeries: Array<{ date: string; tokens: number; cost: number; requests: number }> = [];
    for (const key of dayKeys(range.from, range.to)) {
      const v = dailyMap.get(key) || { tokens: 0, cost: 0, requests: 0 };
      timeSeries.push({ date: key, tokens: v.tokens, cost: round2(v.cost), requests: v.requests });
    }

    return NextResponse.json({
      days,
      range: { from: range.from.toISOString(), to: range.to.toISOString(), preset: range.preset, days: range.days },
      filters: {
        users: userOptions.map((u) => ({ id: u.user_id, label: u.label ?? u.email ?? u.user_id })),
        models: modelOptions.map((m) => m.model),
        user: user?.id ?? user?.email ?? null,
        model,
      },
      // ── Back-compat legacy fields ──
      totalRequests,
      totalTokens,
      perModel: byModel.map((m) => ({ model: m.model, requests: m.requests, tokens: m.tokens })),

      // ── Rich analytics ──
      totalCost,
      avgRequestDurationMs,
      tokenBreakdown: {
        input: tInput,
        output: tOutput,
        thinking: 0,
        cacheRead,
        cacheCreation: cacheWrite,
        total: totalTokens,
      },
      cache: {
        readTokens: cacheRead,
        writeTokens: cacheWrite,
        uncachedInputTokens: cacheInput,
        hitRate: cacheHitRate,
        savingsUsd: round2(cacheSavings),
        source: 'usage_records',
      },
      byModel,
      topUsersByCost,
      topUsersByTokens,
      timeSeries,
    });
  } catch (error) {
    return handleApiError(error, req, {
      route: '/api/admin/usage',
      userId: auth.user.id,
    });
  }
}
