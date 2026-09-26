import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import { validate, UpdateRoleSchema, formatValidationErrors } from '@/modules/admin/lib/validation';
import { updateRole, deleteRole } from '@/modules/admin/lib/services/role-service';
import prisma from '@/shared/lib/db';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ roleId: string }> }
) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const { roleId } = await params;

  try {
    const role = await prisma.role.findUnique({
      where: { id: roleId },
      include: {
        users: { select: { id: true, email: true, name: true, status: true } },
        _count: { select: { users: true, mcpConnections: true } },
      },
    });

    if (!role) return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    return NextResponse.json(role);
  } catch (error) {
    console.error('Get role error:', error);
    return NextResponse.json({ error: 'Failed to get role' }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ roleId: string }> }
) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const { roleId } = await params;

  try {
    const body = await req.json();
    const { data, error } = validate(UpdateRoleSchema, body);
    if (error) {
      return NextResponse.json({ error: formatValidationErrors(error) }, { status: 400 });
    }

    const role = await updateRole(roleId, data, auth.user.id, getIpAddress(req));
    return NextResponse.json(role);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to update role';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ roleId: string }> }
) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const { roleId } = await params;

  try {
    await deleteRole(roleId, auth.user.id, getIpAddress(req));
    return NextResponse.json({ success: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to delete role';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
