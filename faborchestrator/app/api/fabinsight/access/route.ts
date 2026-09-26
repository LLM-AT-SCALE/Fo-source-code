import { NextRequest, NextResponse } from 'next/server';

import { requireAuth } from '@/shared/lib/auth-middleware';
import { dashboardAccess } from '@/modules/fabinsight/lib/access';
import { prisma } from '@/shared/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Tells the chat UI what dashboard controls to render:
 *  - `canPin`: the role has the `dashboards` permission (or the user is an admin),
 *    so artifacts show "Pin for scheduling".
 *  - `chips`: the role's prompt chips for the composer (empty unless the role has
 *    Dashboard Scheduling).
 *  - `canCreateDashboards` / `canManage`: admin — kept for the existing UI shape.
 *  - `roles`: the roles a pinned dashboard can be shared with (Pin dialog), only
 *    for users who may pin.
 * The server enforces the same rules independently — this endpoint is only what
 * the UI renders from, never the security boundary.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const access = await dashboardAccess(auth.user.id);
  return NextResponse.json({
    canPin: access.canPin,
    canManage: access.isAdmin,
    canCreateDashboards: access.isAdmin,
    chips: access.chips,
    roles: access.canPin
      ? await prisma.role.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } })
      : [],
  });
}
