/**
 * GET /api/admin/errors
 *
 * Lists error_audit_logs rows. Until now the only way to read this table was to
 * ask the admin chat in prose — there was no page and no API, so an errorId
 * handed to a user led nowhere. This backs the errors list, and the filters are
 * the ones people actually triage by: type, priority, status, user, date.
 *
 * Reuses `queryErrorAudit`/`countErrorAudit`, so the id matching stays
 * consistent with the chat tool (either the human ERR-… id or the UUID).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/shared/lib/auth-middleware';
import { handleApiError } from '@/shared/lib/errors/api-error-handler';
import { queryErrorAudit, countErrorAudit } from '@/shared/lib/errors/error-audit';
import { clampLimit } from '@/shared/lib/errors/row-cap';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const url = new URL(req.url);
    const q = url.searchParams;

    const limit = clampLimit(Number(q.get('limit')) || undefined, 100);
    const parseDate = (v: string | null) => {
      if (!v) return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    };

    const filters = {
      userKey: q.get('user') || null,
      errorType: q.get('type') || null,
      priority: (q.get('priority') as 'HIGH' | 'MEDIUM' | null) || null,
      status: (q.get('status') as 'OPEN' | 'RESOLVED' | 'all' | null) || null,
      errorIdLike: q.get('errorId') || null,
      dateFrom: parseDate(q.get('from')),
      dateTo: parseDate(q.get('to')),
      limit,
    };

    const [{ rows, truncated }, total] = await Promise.all([
      queryErrorAudit(filters),
      countErrorAudit(filters),
    ]);

    return NextResponse.json({ rows, total, truncated, limit });
  } catch (error) {
    return handleApiError(error, req, { route: '/api/admin/errors' });
  }
}
