import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import { forcePasswordReset } from '@/modules/admin/lib/services/admin-user-service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  try {
    const { emailSent } = await forcePasswordReset(id, auth.user.id, getIpAddress(req));
    return NextResponse.json({
      success: true,
      emailSent,
      message: emailSent
        ? 'User must change password on next login. A reset email was sent.'
        : 'User must change password on next login, but the reset email could not be sent (email is not configured).',
    });
  } catch (error) {
    console.error('Force reset error:', error);
    return NextResponse.json({ error: 'Failed to force password reset' }, { status: 500 });
  }
}
