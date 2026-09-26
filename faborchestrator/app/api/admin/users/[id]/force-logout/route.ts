import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import { forceLogoutUser } from '@/modules/admin/lib/services/admin-user-service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  try {
    const result = await forceLogoutUser(id, auth.user.id, getIpAddress(req));
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error('Force logout error:', error);
    return NextResponse.json({ error: 'Failed to force logout' }, { status: 500 });
  }
}
