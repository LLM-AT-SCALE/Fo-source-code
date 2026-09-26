import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';

/**
 * Bearer-session shim for ported cmf-loader routes.
 *
 * The cmf-loader routes call `getSessionUserId()` (NextAuth). In the fab app we
 * authenticate with the bearer/session middleware instead, so this returns the
 * signed-in user's id from the request's Authorization header, or null.
 */
export async function getSessionUserId(req: NextRequest): Promise<string | null> {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return null;
  return auth.user.id;
}
