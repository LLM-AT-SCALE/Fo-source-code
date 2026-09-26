import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import { validateOrThrow, CreateRoleSchema } from '@/modules/admin/lib/validation';
import { listRoles, createRole } from '@/modules/admin/lib/services/role-service';
import { handleApiError } from '@/shared/lib/errors/api-error-handler';
import { applyRowCap } from '@/shared/lib/errors/row-cap';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const roles = await listRoles();
    const { rows, warning } = applyRowCap(roles);
    if (warning) {
      return NextResponse.json({ roles: rows }, {
        headers: {
          'X-FabOrch-Warning': warning.type,
          'X-FabOrch-Warning-Message': warning.userMessage,
        },
      });
    }
    return NextResponse.json({ roles: rows });
  } catch (error) {
    return handleApiError(error, req, {
      route: '/api/admin/roles',
      userId: auth.user.id,
    });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await req.json();
    const data = validateOrThrow(CreateRoleSchema, body);
    const role = await createRole(data, auth.user.id, getIpAddress(req));
    return NextResponse.json(role, { status: 201 });
  } catch (error) {
    return handleApiError(error, req, {
      route: '/api/admin/roles',
      userId: auth.user.id,
    });
  }
}
