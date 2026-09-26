import { NextRequest, NextResponse } from 'next/server';
import { acceptInvitation } from '@/modules/admin/lib/services/invitation-service';

export async function POST(req: NextRequest) {
  try {
    const { token, name, password } = await req.json();

    if (!token || !name || !password) {
      return NextResponse.json(
        { error: 'Token, name, and password are required' },
        { status: 400 }
      );
    }

    const ipAddress = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
    const userAgent = req.headers.get('user-agent') || null;

    const result = await acceptInvitation({ token, name, password, ipAddress, userAgent });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to accept invitation';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
