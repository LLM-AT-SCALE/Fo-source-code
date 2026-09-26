import { NextRequest, NextResponse } from 'next/server';
import { validateInvitationToken } from '@/modules/admin/lib/services/invitation-service';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');

  if (!token || token.length < 32) {
    return NextResponse.json({ valid: false, error: 'Invalid token' }, { status: 400 });
  }

  try {
    const result = await validateInvitationToken(token);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Validate invitation error:', error);
    return NextResponse.json({ valid: false, error: 'Server error' }, { status: 500 });
  }
}
