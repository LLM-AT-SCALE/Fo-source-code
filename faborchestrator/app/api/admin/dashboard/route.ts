import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/shared/lib/auth-middleware';
import prisma from '@/shared/lib/db';
import { parseRange } from '@/modules/admin/lib/date-range';

/**
 * Enterprise admin dashboard metrics.
 *
 * READ-ONLY. Every raw-SQL audit query (prompt_audit_logs / error_audit_logs)
 * is wrapped so a missing table degrades to zeros instead of a 500.
 *
 * ACCURATE SOURCE: usage token sums and USD cost come from
 * `prompt_audit_logs` (real per-prompt data) — NOT `usage_records`, which
 * historically stored 0 tokens. prompt_audit_logs has no 5-way token split,
 * so we map request+retrieval → input and response → output while keeping the
 * TokenBucket field names for back-compat.
 *
 * The top-level fields (totalUsers, activeUsers, totalConversations,
 * totalRoles, totalRequests30d, totalTokens30d) are kept for backward
 * compatibility with older clients; the rich metrics live in nested objects.
 */

interface TokenBucket {
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

interface PromptAuditUsage {
  requests: number;
  tokens: TokenBucket;
  cost: number;
}

const emptyBucket = (): TokenBucket => ({
  input: 0,
  output: 0,
  thinking: 0,
  cacheRead: 0,
  cacheCreation: 0,
  total: 0,
});

/**
 * Prompt-cache effectiveness, sourced from `usage_records` (which carries the
 * per-request cache_read / cache_creation token counts the chat route records
 * from the Anthropic usage object). prompt_audit_logs has no cache split, so
 * cache metrics live here.
 */
interface CacheMetrics {
  readTokens: number;    // served from cache (~0.1x base input price)
  writeTokens: number;   // written to cache (~1.25x base input price)
  inputTokens: number;   // uncached input tokens
  hitRate: number | null; // readTokens / (read + write + input) * 100
  savingsUsd: number;    // estimated net $ saved vs. an uncached run
}

const emptyCache = (): CacheMetrics => ({
  readTokens: 0,
  writeTokens: 0,
  inputTokens: 0,
  hitRate: null,
  savingsUsd: 0,
});

/** Per-model base input rate ($/1M tokens) from the model registry. */
async function registryInputRates(): Promise<Map<string, number>> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ model_id: string; rate: number | string }>>(
      `SELECT model_id, input_cost_per_1m::float AS rate FROM model_registry`
    );
    return new Map((rows || []).map((r) => [r.model_id, Number(r.rate) || 0]));
  } catch {
    return new Map();
  }
}

async function cacheMetrics(since: Date, rates: Map<string, number>, until?: Date): Promise<CacheMetrics> {
  try {
    const rows = await prisma.$queryRawUnsafe<
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
         FROM usage_records WHERE created_at >= $1 AND created_at <= $2 GROUP BY model`,
      since,
      until ?? new Date()
    );
    // Fallback base rate ($/1M) for models absent from the registry (Opus tier).
    const DEFAULT_RATE = 5;
    let read = 0, write = 0, input = 0, savings = 0;
    for (const r of rows || []) {
      const rd = Number(r.read) || 0;
      const wr = Number(r.write) || 0;
      const inp = Number(r.input) || 0;
      read += rd;
      write += wr;
      input += inp;
      const rate = rates.get(r.model) ?? DEFAULT_RATE;
      // Cache reads cost ~0.1x base (save 0.9x/token); writes cost ~1.25x base
      // (add 0.25x/token). Net saving vs. paying full input price uncached.
      savings += (rd * 0.9 - wr * 0.25) * (rate / 1_000_000);
    }
    const denom = read + write + input;
    return {
      readTokens: read,
      writeTokens: write,
      inputTokens: input,
      hitRate: denom > 0 ? Math.round((read / denom) * 1000) / 10 : null,
      savingsUsd: Math.round(savings * 100) / 100,
    };
  } catch {
    return emptyCache();
  }
}

/**
 * Requests, token bucket, and USD cost from prompt_audit_logs since a date.
 * Degrades to zeros if the table/columns are unavailable.
 */
async function promptAuditUsage(since: Date, until?: Date): Promise<PromptAuditUsage> {
  try {
    const rows = await prisma.$queryRawUnsafe<
      Array<{
        requests: number | string;
        input: bigint | number | string;
        output: bigint | number | string;
        cost: number | string | null;
      }>
    >(
      `SELECT COUNT(*)::int AS requests,
              COALESCE(SUM(COALESCE(request_tokens,0)+COALESCE(retrieval_tokens,0)),0)::bigint AS input,
              COALESCE(SUM(response_tokens),0)::bigint AS output,
              COALESCE(SUM(COALESCE(request_cost,0)+COALESCE(retrieval_cost,0)+COALESCE(response_cost,0)),0)::float AS cost
         FROM prompt_audit_logs WHERE datetime >= $1 AND datetime <= $2`,
      since,
      until ?? new Date()
    );
    const r = rows?.[0];
    const input = Number(r?.input ?? 0) || 0;
    const output = Number(r?.output ?? 0) || 0;
    const cost = Number(r?.cost ?? 0);
    return {
      requests: Number(r?.requests ?? 0) || 0,
      tokens: { input, output, thinking: 0, cacheRead: 0, cacheCreation: 0, total: input + output },
      cost: Number.isFinite(cost) ? cost : 0,
    };
  } catch {
    return { requests: 0, tokens: emptyBucket(), cost: 0 };
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    // Selected range (?range / ?from&to; default last 30 days) drives the
    // usage, cost, cache, error and prompt figures. The fixed 7d/30d fields stay
    // for older clients.
    const range = parseRange(req.nextUrl.searchParams, now);
    const rangeFrom = range.from;
    const rangeTo = range.to;

    // Per-model rates for cache-savings estimation (resilient to missing table).
    const cacheRates = await registryInputRates();

    const [
      totalUsers,
      activeUsers,
      suspendedUsers,
      adminUsers,
      totalConversations,
      conversations7d,
      conversations30d,
      totalMessages,
      totalRoles,
      totalMcp,
      connectedMcp,
      activeSessions,
      closedIdle7d,
      usage7d,
      usage30d,
      cache7d,
      cache30d,
      usageRange,
      cacheRange,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { lastLogin: { gte: thirtyDaysAgo } } }),
      prisma.user.count({ where: { status: 'SUSPENDED' } }),
      prisma.user.count({ where: { isAdmin: true } }),
      prisma.conversation.count({ where: { deletedAt: null } }),
      prisma.conversation.count({ where: { deletedAt: null, createdAt: { gte: sevenDaysAgo } } }),
      prisma.conversation.count({ where: { deletedAt: null, createdAt: { gte: thirtyDaysAgo } } }),
      prisma.message.count(),
      prisma.role.count(),
      prisma.mcpConnection.count(),
      prisma.mcpConnection.count({ where: { status: 'connected' } }),
      prisma.userSessionLog.count({ where: { sessionStatus: 'ACTIVE' } }),
      prisma.userSessionLog.count({
        where: { sessionStatus: 'CLOSED_IDLE', loginTime: { gte: sevenDaysAgo } },
      }),
      // ACCURATE usage + cost from prompt_audit_logs (resilient to missing table).
      promptAuditUsage(sevenDaysAgo),
      promptAuditUsage(thirtyDaysAgo),
      // Prompt-cache effectiveness from usage_records.
      cacheMetrics(sevenDaysAgo, cacheRates),
      cacheMetrics(thirtyDaysAgo, cacheRates),
      promptAuditUsage(rangeFrom, rangeTo),
      cacheMetrics(rangeFrom, cacheRates, rangeTo),
    ]);

    // Average closed-session duration (seconds), last 30d. Raw SQL because
    // Prisma cannot aggregate a timestamp difference. Table is a real model,
    // but wrap anyway for resilience.
    let avgSessionSec = 0;
    try {
      const dur = await prisma.$queryRawUnsafe<Array<{ avg_sec: number | string | null }>>(
        `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (logout_time - login_time))),0)::float AS avg_sec
           FROM user_session_logs
          WHERE logout_time IS NOT NULL AND login_time >= $1`,
        thirtyDaysAgo
      );
      avgSessionSec = Math.round(Number(dur?.[0]?.avg_sec ?? 0));
    } catch {
      avgSessionSec = 0;
    }

    // ── Errors (raw-SQL audit table, resilient) ──────────────────────────
    let errorsOpen = 0;
    let errorsByPriority: Array<{ priority: string; count: number }> = [];
    let errorsByType: Array<{ type: string; count: number }> = [];
    let errorsTotal30d = 0;
    try {
      const [openRows, prioRows, typeRows] = await Promise.all([
        prisma.$queryRawUnsafe<Array<{ n: number | string }>>(
          `SELECT COUNT(*)::int AS n FROM error_audit_logs WHERE status = 'OPEN'`
        ),
        prisma.$queryRawUnsafe<Array<{ priority: string; n: number | string }>>(
          `SELECT priority, COUNT(*)::int AS n FROM error_audit_logs
            WHERE datetime >= $1 AND datetime <= $2 GROUP BY priority ORDER BY n DESC`,
          rangeFrom,
          rangeTo
        ),
        prisma.$queryRawUnsafe<Array<{ error_type: string; n: number | string }>>(
          `SELECT error_type, COUNT(*)::int AS n FROM error_audit_logs
            WHERE datetime >= $1 AND datetime <= $2 GROUP BY error_type ORDER BY n DESC LIMIT 12`,
          rangeFrom,
          rangeTo
        ),
      ]);
      errorsOpen = Number(openRows?.[0]?.n ?? 0);
      errorsByPriority = (prioRows || []).map((r) => ({ priority: r.priority, count: Number(r.n) }));
      errorsByType = (typeRows || []).map((r) => ({ type: r.error_type, count: Number(r.n) }));
      errorsTotal30d = errorsByType.reduce((n, r) => n + r.count, 0);
    } catch {
      // table absent → zeros
    }

    // ── Prompts (raw-SQL audit table, resilient) ─────────────────────────
    let promptsTotal = 0;
    let promptsSuccessRate: number | null = null;
    let promptsAvgResponseMs = 0;
    let promptsByTopic: Array<{ topic: string; count: number }> = [];
    try {
      const [sumRows, topicRows] = await Promise.all([
        prisma.$queryRawUnsafe<
          Array<{ total: number | string; success: number | string; avg_ms: number | string | null }>
        >(
          `SELECT COUNT(*)::int AS total,
                  SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END)::int AS success,
                  COALESCE(ROUND(AVG(response_time_ms)),0)::int AS avg_ms
             FROM prompt_audit_logs WHERE datetime >= $1 AND datetime <= $2`,
          rangeFrom,
          rangeTo
        ),
        prisma.$queryRawUnsafe<Array<{ topic: string; n: number | string }>>(
          `SELECT COALESCE(topic_matched,'(unmatched)') AS topic, COUNT(*)::int AS n
             FROM prompt_audit_logs WHERE datetime >= $1 AND datetime <= $2
            GROUP BY 1 ORDER BY n DESC LIMIT 12`,
          rangeFrom,
          rangeTo
        ),
      ]);
      promptsTotal = Number(sumRows?.[0]?.total ?? 0);
      const succ = Number(sumRows?.[0]?.success ?? 0);
      promptsSuccessRate = promptsTotal > 0 ? Math.round((succ / promptsTotal) * 1000) / 10 : null;
      promptsAvgResponseMs = Number(sumRows?.[0]?.avg_ms ?? 0);
      promptsByTopic = (topicRows || []).map((r) => ({ topic: r.topic, count: Number(r.n) }));
    } catch {
      // table absent → zeros
    }

    const tokens7d = usage7d.tokens;
    const tokens30d = usage30d.tokens;
    // Surface real cache token counts (from usage_records) on the token buckets.
    tokens7d.cacheRead = cache7d.readTokens;
    tokens7d.cacheCreation = cache7d.writeTokens;
    tokens30d.cacheRead = cache30d.readTokens;
    tokens30d.cacheCreation = cache30d.writeTokens;
    const tokensRange = usageRange.tokens;
    tokensRange.cacheRead = cacheRange.readTokens;
    tokensRange.cacheCreation = cacheRange.writeTokens;
    const requests7d = usage7d.requests;
    const requests30d = usage30d.requests;
    const cost7d = usage7d.cost;
    const cost30d = usage30d.cost;
    const costSource = 'prompt_audit_logs';

    return NextResponse.json({
      range: { from: rangeFrom.toISOString(), to: rangeTo.toISOString(), preset: range.preset, days: range.days },
      // ── Backward-compatible top-level fields ──
      totalUsers,
      activeUsers,
      totalConversations,
      totalRoles,
      totalRequests30d: requests30d,
      totalTokens30d: tokens30d.total,

      // ── Rich, enterprise metrics ──
      users: {
        total: totalUsers,
        active: activeUsers,
        suspended: suspendedUsers,
        admins: adminUsers,
      },
      conversations: {
        total: totalConversations,
        last7d: conversations7d,
        last30d: conversations30d,
      },
      messages: { total: totalMessages },
      roles: { total: totalRoles },
      mcp: { total: totalMcp, connected: connectedMcp },
      sessions: {
        active: activeSessions,
        closedIdle7d,
        avgDurationSec: avgSessionSec,
      },
      usage: {
        last7d: { requests: requests7d, tokens: tokens7d },
        last30d: { requests: requests30d, tokens: tokens30d },
        selected: { requests: usageRange.requests, tokens: tokensRange },
      },
      cost: {
        last7d: Math.round(cost7d * 100) / 100,
        last30d: Math.round(cost30d * 100) / 100,
        selected: Math.round(usageRange.cost * 100) / 100,
        source: costSource,
      },
      cache: {
        last7d: cache7d,
        last30d: cache30d,
        selected: cacheRange,
        source: 'usage_records',
      },
      errors: {
        open: errorsOpen,
        /** Errors logged in the selected range (name kept for older clients). */
        total30d: errorsTotal30d,
        totalSelected: errorsTotal30d,
        byPriority: errorsByPriority,
        byType: errorsByType,
      },
      prompts: {
        total: promptsTotal,
        successRate: promptsSuccessRate,
        avgResponseMs: promptsAvgResponseMs,
        byTopic: promptsByTopic,
      },
      generatedAt: now.toISOString(),
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    return NextResponse.json({ error: 'Failed to load dashboard data' }, { status: 500 });
  }
}
