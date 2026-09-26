import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { prisma } from '@/shared/lib/db';
import { canUseBackendAgent, requiresPermission } from '@/modules/coding-agent/lib/access';
import { isPlatformAdmin } from '@/shared/lib/permissions';

export const runtime = 'nodejs';

/**
 * Whether the signed-in user may use the Back-end Agent.
 *
 * Open to everyone unless `BACKEND_AGENT_REQUIRE_PERMISSION` is set — see
 * `modules/coding-agent/lib/access.ts` for why it is that way round.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  /* Skip the role lookup entirely while the agent is open to everyone: a query
     whose answer cannot change the outcome is a round trip for nothing. */
  if (!requiresPermission()) {
    return NextResponse.json({ enabled: true, enforced: false });
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: auth.user.id },
    include: { role: true },
  });
  const permissions = Array.isArray(dbUser?.role?.permissions)
    ? (dbUser!.role!.permissions as string[])
    : [];

  return NextResponse.json({
    enabled: canUseBackendAgent({ isAdmin: isPlatformAdmin(dbUser), permissions }),
    enforced: true,
  });
}
