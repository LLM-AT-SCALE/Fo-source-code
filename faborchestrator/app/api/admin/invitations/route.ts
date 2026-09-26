import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import { createInvitation, listInvitations } from '@/modules/admin/lib/services/invitation-service';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const invitations = await listInvitations();
    return NextResponse.json({ invitations });
  } catch (error) {
    console.error('List invitations error:', error);
    return NextResponse.json({ error: 'Failed to list invitations' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { email, roleId } = await req.json();

    if (!email || !roleId) {
      return NextResponse.json({ error: 'Email and role are required' }, { status: 400 });
    }

    const result = await createInvitation({
      email,
      roleId,
      adminUserId: auth.user.id,
      ipAddress: getIpAddress(req),
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to create invitation';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
