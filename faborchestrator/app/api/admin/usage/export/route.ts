import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/shared/lib/auth-middleware';
import prisma from '@/shared/lib/db';
import { buildAuditFilters, parseRange, parseUserParam } from '@/modules/admin/lib/date-range';

/**
 * Compliance CSV export of usage/cost, sourced from the ACCURATE
 * `prompt_audit_logs` table. READ-ONLY.
 *
 * Query params:
 *   from, to  — ISO dates (inclusive; a bare YYYY-MM-DD `to` covers the whole day),
 *               or range=7|30|90 (default: last 30 days).
 *   user      — user id or email; model — model id (optional filters).
 *   groupBy   — user | model | day | prompt  (default: user)
 *
 * Returns text/csv as an attachment. Every raw-SQL query is wrapped so a
 * missing table/column yields an empty (header-only) CSV instead of a crash.
 */

type GroupBy = 'user' | 'model' | 'day' | 'prompt';

const num = (v: unknown): number => {
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** RFC-4180 CSV field escaping. */
function csvField(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header.map(csvField).join(',')];
  for (const r of rows) lines.push(r.map(csvField).join(','));
  return lines.join('\r\n');
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const url = new URL(req.url);
    const groupByRaw = (url.searchParams.get('groupBy') || 'user').toLowerCase();
    const groupBy: GroupBy = (['user', 'model', 'day', 'prompt'] as const).includes(
      groupByRaw as GroupBy
    )
      ? (groupByRaw as GroupBy)
      : 'user';

    const range = parseRange(url.searchParams);
    const from = range.from;
    const to = range.to;
    const user = parseUserParam(url.searchParams.get('user') ?? url.searchParams.get('userId'));
    const model = (url.searchParams.get('model') ?? '').trim() || null;
    const filter = buildAuditFilters({ from, to, user, model });
    const where = filter.sql;
    const params = filter.params;

    const fromLabel = from.toISOString().slice(0, 10);
    const toLabel = to.toISOString().slice(0, 10);

    const costExpr = 'COALESCE(request_cost,0)+COALESCE(retrieval_cost,0)+COALESCE(response_cost,0)';
    const tokensExpr = 'COALESCE(request_tokens,0)+COALESCE(retrieval_tokens,0)+COALESCE(response_tokens,0)';

    let header: string[] = [];
    let rows: unknown[][] = [];

    if (groupBy === 'user') {
      header = ['user_email', 'user_name', 'requests', 'total_tokens', 'total_cost'];
      const data = await prisma
        .$queryRawUnsafe<
          Array<{
            user_email: string | null;
            user_name: string | null;
            requests: number | string;
            total_tokens: bigint | number | string;
            total_cost: number | string | null;
          }>
        >(
          `SELECT MAX(user_email) AS user_email, MAX(user_name) AS user_name,
                  COUNT(*)::int AS requests,
                  COALESCE(SUM(${tokensExpr}),0)::bigint AS total_tokens,
                  COALESCE(SUM(${costExpr}),0)::float AS total_cost
             FROM prompt_audit_logs
            WHERE ${where}
            GROUP BY user_id
            ORDER BY total_cost DESC`,
          ...params
        )
        .catch(() => []);
      rows = data.map((d) => [
        d.user_email ?? '',
        d.user_name ?? '',
        num(d.requests),
        num(d.total_tokens),
        num(d.total_cost).toFixed(4),
      ]);
    } else if (groupBy === 'model') {
      header = ['model', 'requests', 'total_tokens', 'total_cost'];
      const data = await prisma
        .$queryRawUnsafe<
          Array<{
            model: string | null;
            requests: number | string;
            total_tokens: bigint | number | string;
            total_cost: number | string | null;
          }>
        >(
          `SELECT COALESCE(model,'unknown') AS model,
                  COUNT(*)::int AS requests,
                  COALESCE(SUM(${tokensExpr}),0)::bigint AS total_tokens,
                  COALESCE(SUM(${costExpr}),0)::float AS total_cost
             FROM prompt_audit_logs
            WHERE ${where}
            GROUP BY COALESCE(model,'unknown')
            ORDER BY total_cost DESC`,
          ...params
        )
        .catch(() => []);
      rows = data.map((d) => [
        d.model ?? 'unknown',
        num(d.requests),
        num(d.total_tokens),
        num(d.total_cost).toFixed(4),
      ]);
    } else if (groupBy === 'day') {
      header = ['date', 'requests', 'total_tokens', 'total_cost'];
      const data = await prisma
        .$queryRawUnsafe<
          Array<{
            date: string;
            requests: number | string;
            total_tokens: bigint | number | string;
            total_cost: number | string | null;
          }>
        >(
          `SELECT TO_CHAR(DATE(datetime),'YYYY-MM-DD') AS date,
                  COUNT(*)::int AS requests,
                  COALESCE(SUM(${tokensExpr}),0)::bigint AS total_tokens,
                  COALESCE(SUM(${costExpr}),0)::float AS total_cost
             FROM prompt_audit_logs
            WHERE ${where}
            GROUP BY DATE(datetime)
            ORDER BY date`,
          ...params
        )
        .catch(() => []);
      rows = data.map((d) => [
        d.date,
        num(d.requests),
        num(d.total_tokens),
        num(d.total_cost).toFixed(4),
      ]);
    } else {
      // prompt — one row per audited prompt
      header = [
        'prompt_id',
        'datetime',
        'user_email',
        'model',
        'topic_matched',
        'status',
        'request_tokens',
        'retrieval_tokens',
        'response_tokens',
        'total_cost',
      ];
      const data = await prisma
        .$queryRawUnsafe<
          Array<{
            prompt_id: string | null;
            datetime: Date | string | null;
            user_email: string | null;
            model: string | null;
            topic_matched: string | null;
            status: string | null;
            request_tokens: number | string | null;
            retrieval_tokens: number | string | null;
            response_tokens: number | string | null;
            total_cost: number | string | null;
          }>
        >(
          `SELECT prompt_id, datetime, user_email,
                  COALESCE(model,'unknown') AS model,
                  topic_matched, status,
                  COALESCE(request_tokens,0) AS request_tokens,
                  COALESCE(retrieval_tokens,0) AS retrieval_tokens,
                  COALESCE(response_tokens,0) AS response_tokens,
                  COALESCE(${costExpr},0)::float AS total_cost
             FROM prompt_audit_logs
            WHERE ${where}
            ORDER BY datetime DESC
            LIMIT 100000`,
          ...params
        )
        .catch(() => []);
      rows = data.map((d) => [
        d.prompt_id ?? '',
        d.datetime instanceof Date ? d.datetime.toISOString() : (d.datetime ?? ''),
        d.user_email ?? '',
        d.model ?? 'unknown',
        d.topic_matched ?? '',
        d.status ?? '',
        num(d.request_tokens),
        num(d.retrieval_tokens),
        num(d.response_tokens),
        num(d.total_cost).toFixed(4),
      ]);
    }

    const csv = toCsv(header, rows);
    const filename = `usage-${groupBy}-${fromLabel}-${toLabel}.csv`;

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Usage export error:', error);
    return NextResponse.json({ error: 'Failed to export usage data' }, { status: 500 });
  }
}
