import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/shared/lib/auth-middleware';
import prisma from '@/shared/lib/db';
import { handleApiError } from '@/shared/lib/errors/api-error-handler';
import { applyRowCap, clampLimit } from '@/shared/lib/errors/row-cap';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const url = new URL(req.url);
    const page = Number(url.searchParams.get('page')) || 1;
    const pageSize = clampLimit(Number(url.searchParams.get('pageSize')) || undefined, 50);
    const action = url.searchParams.get('action') || undefined;
    const userId = url.searchParams.get('userId') || undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {};
    if (action) where.action = action;
    if (userId) where.userId = userId;

    // If meta=true, return available filter values
    if (url.searchParams.get('meta') === 'true') {
      const actions = await prisma.auditLog.findMany({
        select: { action: true },
        distinct: ['action'],
        orderBy: { action: 'asc' },
      });
      return NextResponse.json({
        meta: { actions: actions.map((a) => a.action) },
      });
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { user: { select: { id: true, email: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.auditLog.count({ where }),
    ]);

    const { rows, warning } = applyRowCap(logs, total);
    const body = {
      logs: rows,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
    if (warning) {
      return NextResponse.json(body, {
        headers: {
          'X-FabOrch-Warning': warning.type,
          'X-FabOrch-Warning-Message': warning.userMessage,
        },
      });
    }
    return NextResponse.json(body);
  } catch (error) {
    return handleApiError(error, req, {
      route: '/api/admin/audit-logs',
      userId: auth.user.id,
    });
  }
}
