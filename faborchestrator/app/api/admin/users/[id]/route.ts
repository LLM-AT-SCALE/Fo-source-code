import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import { validate, UpdateUserSchema, formatValidationErrors } from '@/modules/admin/lib/validation';
import {
  updateUserStatus,
  changeUserRole,
  updateUserName,
  toggleUserAdmin,
  deleteUser,
} from '@/modules/admin/lib/services/admin-user-service';
import prisma from '@/shared/lib/db';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  try {
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        role: true,
        _count: { select: { conversations: true, sessions: true } },
      },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json({
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      isAdmin: user.isAdmin,
      role: user.role,
      forcePasswordChange: user.forcePasswordChange,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
      conversationCount: user._count.conversations,
      sessionCount: user._count.sessions,
    });
  } catch (error) {
    console.error('Get user error:', error);
    return NextResponse.json({ error: 'Failed to get user' }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const ip = getIpAddress(req);

  try {
    const body = await req.json();
    const { data, error } = validate(UpdateUserSchema, body);
    if (error) {
      return NextResponse.json({ error: formatValidationErrors(error) }, { status: 400 });
    }

    let result;
    switch (data.action) {
      case 'suspend':
        result = await updateUserStatus(id, 'SUSPENDED', auth.user.id, ip);
        break;
      case 'activate':
        result = await updateUserStatus(id, 'ACTIVE', auth.user.id, ip);
        break;
      case 'changeRole':
        if (!data.roleId) return NextResponse.json({ error: 'roleId required' }, { status: 400 });
        result = await changeUserRole(id, data.roleId, auth.user.id, ip);
        break;
      case 'editName':
        if (!data.name) return NextResponse.json({ error: 'name required' }, { status: 400 });
        result = await updateUserName(id, data.name, auth.user.id, ip);
        break;
      case 'toggleAdmin':
        const user = await prisma.user.findUnique({ where: { id } });
        if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
        result = await toggleUserAdmin(id, !user.isAdmin, auth.user.id, ip);
        break;
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to update user';
    console.error('Update user error:', error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  try {
    await deleteUser(id, auth.user.id, getIpAddress(req));
    return NextResponse.json({ success: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to delete user';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
