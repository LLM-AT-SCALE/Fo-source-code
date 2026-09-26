import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import { validateOrThrow, CreateUserSchema } from '@/modules/admin/lib/validation';
import { listUsers, createUser } from '@/modules/admin/lib/services/admin-user-service';
import prisma from '@/shared/lib/db';
import { handleApiError } from '@/shared/lib/errors/api-error-handler';
import { applyRowCap, clampLimit } from '@/shared/lib/errors/row-cap';
import { FabOrchError } from '@/shared/lib/errors/faborch-errors';
import { ALLOWED_USER_STATUSES } from '@/shared/lib/errors/parameter-values';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const url = new URL(req.url);
    const status = url.searchParams.get('status') || undefined;
    if (status && !ALLOWED_USER_STATUSES.includes(status)) {
      throw FabOrchError.invalidParameter('status', ALLOWED_USER_STATUSES, undefined, { badValue: status });
    }
    const result = await listUsers({
      search: url.searchParams.get('search') || undefined,
      roleId: url.searchParams.get('roleId') || undefined,
      status,
      page: Number(url.searchParams.get('page')) || 1,
      pageSize: clampLimit(Number(url.searchParams.get('pageSize')) || undefined, 50),
    });

    // If meta=true, return filter options too
    if (url.searchParams.get('meta') === 'true') {
      const roles = await prisma.role.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      return NextResponse.json({ ...result, meta: { roles, statuses: ['ACTIVE', 'SUSPENDED'] } });
    }

    // Soft cap row count.
    if (Array.isArray((result as { users?: unknown }).users)) {
      const r = result as { users: unknown[] };
      const { rows, warning } = applyRowCap(r.users as unknown[]);
      r.users = rows;
      if (warning) {
        return NextResponse.json(result, {
          headers: {
            'X-FabOrch-Warning': warning.type,
            'X-FabOrch-Warning-Message': warning.userMessage,
          },
        });
      }
    }

    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error, req, {
      route: '/api/admin/users',
      userId: auth.user.id,
    });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const data = validateOrThrow(CreateUserSchema, body);

    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) {
      return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
    }

    const user = await createUser({
      ...data,
      adminUserId: auth.user.id,
      ipAddress: getIpAddress(req),
    });

    return NextResponse.json(user, { status: 201 });
  } catch (error) {
    return handleApiError(error, req, {
      route: '/api/admin/users',
      userId: auth.user.id,
    });
  }
}
