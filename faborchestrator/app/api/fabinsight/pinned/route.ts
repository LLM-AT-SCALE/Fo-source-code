import { NextRequest, NextResponse } from 'next/server';

import { requireAuth } from '@/shared/lib/auth-middleware';
import { prisma } from '@/shared/lib/db';
import { dashboardAccess } from '@/modules/fabinsight/lib/access';
import { visibilityWhere } from '@/modules/fabinsight/lib/visibility';
import { pinSetupStates } from '@/modules/fabinsight/lib/pin/setup-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET — the dashboards this user may see (Recent Reports).
 *
 * Reads the `dashboards` table (live, approved, versioned dashboards) filtered
 * by visibility: everyone / listed roles / listed users / requester / creator;
 * admins see all. Only snapshot metadata comes back — the HTML is fetched per
 * report from GET /api/fabinsight/pinned/[id].
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const access = await dashboardAccess(auth.user.id);
  const me = { id: auth.user.id, roleId: auth.user.roleId ?? null, isAdmin: access.isAdmin };

  const rows = await prisma.dashboard.findMany({
    where: visibilityWhere(me),
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      slug: true,
      title: true,
      kind: true,
      status: true,
      createdAt: true,
      refreshedAt: true,
      lastStatus: true,
      cachedHtml: true,
      expiresAt: true,
      createdById: true,
      requesterId: true,
      perServerStatus: true,
      kpis: true,
      currentVersionId: true,
      sourceRequestId: true,
    },
  });
  const setup = await pinSetupStates(rows);

  // The Reports list shows each dashboard's refresh schedule in words.
  const schedules = rows.length
    ? await prisma.reportSchedule.findMany({
        // report_schedules keys on the dashboard slug, not the row id.
        where: { dashboardId: { in: rows.map((r) => r.slug) }, enabled: true },
        select: { dashboardId: true, frequency: true, atTime: true, daysOfWeek: true, dayOfMonth: true, timezone: true },
      })
    : [];
  const scheduleText = new Map<string, string>();
  for (const s of schedules) {
    if (scheduleText.has(s.dashboardId)) continue;
    const tz = s.timezone || 'UTC';
    const at = s.atTime ?? '00:00';
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    // days_of_week is stored as "1,3,5"; no days stored means Monday (the scheduler's default).
    const weekly = (s.daysOfWeek ?? '')
      .split(',')
      .map((n) => days[parseInt(n.trim(), 10)])
      .filter((d): d is string => !!d);
    const text =
      s.frequency === 'hourly' ? 'hourly'
      : s.frequency === 'daily' ? `daily at ${at} ${tz}`
      : s.frequency === 'weekly' ? `weekly on ${weekly.length ? weekly.join(', ') : 'Monday'} at ${at} ${tz}`
      : s.frequency === 'monthly' ? `monthly on day ${s.dayOfMonth ?? 1} at ${at} ${tz}`
      : s.frequency;
    scheduleText.set(s.dashboardId, text);
  }

  const ownerIds = [...new Set(rows.flatMap((r) => [r.requesterId, r.createdById]).filter((v): v is string => !!v))];
  const owners = ownerIds.length
    ? await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true, email: true } })
    : [];
  const ownerName = new Map(owners.map((u) => [u.id, u.name || u.email]));

  return NextResponse.json({
    dashboards: rows.map((r) => ({
      id: r.id,
      title: r.title,
      dashboardId: r.slug,
      kind: r.kind,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      // Snapshot metadata — `refreshedAt` is when the last scheduled (or manual)
      // snapshot was cached; null = never cached yet.
      refreshedAt: r.refreshedAt ? r.refreshedAt.toISOString() : null,
      hasCache: !!r.cachedHtml,
      // "stale: …" means the last scheduled refresh couldn't reach a source and
      // the previous snapshot was intentionally kept.
      stale: typeof r.lastStatus === 'string' && r.lastStatus.startsWith('stale:'),
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      perServerStatus: r.perServerStatus ?? {},
      kpis: Array.isArray(r.kpis) ? r.kpis : [],
      schedule: scheduleText.get(r.slug) ?? null,
      createdBy: ownerName.get(r.requesterId ?? '') || ownerName.get(r.createdById) || 'Unknown',
      // static | preparing | setup_failed | null — see modules/fabinsight/lib/pin/setup-state.ts
      setup: setup.get(r.id) ?? null,
    })),
    canManage: access.isAdmin,
    canPin: access.canPin,
  });
}

/**
 * POST — retired. Pinning is now a request for admin approval:
 * POST /api/fabinsight/pin-requests.
 */
export async function POST() {
  return NextResponse.json(
    { error: 'Pinning now goes through admin approval. Use the Pin button on a dashboard to send a request.' },
    { status: 410 },
  );
}
