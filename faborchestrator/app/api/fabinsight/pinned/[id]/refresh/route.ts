import { NextRequest, NextResponse } from 'next/server';

import { requireAuth } from '@/shared/lib/auth-middleware';
import { prisma } from '@/shared/lib/db';
import { dashboardAccess } from '@/modules/fabinsight/lib/access';
import { refreshDashboard } from '@/modules/fabinsight/lib/refresh';
import { canSee } from '@/modules/fabinsight/lib/visibility';
import { pinSetupStates, PIN_SETUP_TEXT } from '@/modules/fabinsight/lib/pin/setup-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST — replay one dashboard's program now and update its shared snapshot.
 * Allowed for anyone who can see the dashboard: the refreshed snapshot becomes
 * what every viewer sees.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const dash = await prisma.dashboard.findUnique({
    where: { id },
    select: {
      id: true,
      slug: true,
      title: true,
      status: true,
      currentVersionId: true,
      visibleToAll: true,
      visibilityRoleIds: true,
      visibilityUserIds: true,
      createdById: true,
      requesterId: true,
      sourceRequestId: true,
    },
  });
  if (!dash) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  const access = await dashboardAccess(auth.user.id);
  if (!canSee(dash, { id: auth.user.id, roleId: auth.user.roleId ?? null, isAdmin: access.isAdmin })) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }
  if (dash.status !== 'live') {
    return NextResponse.json({ error: `This dashboard is ${dash.status} and cannot be refreshed.` }, { status: 409 });
  }

  // A pinned snapshot with no refresh program yet: say why, rather than failing.
  if (!dash.currentVersionId) {
    const setup = (await pinSetupStates([dash])).get(dash.id) ?? null;
    return NextResponse.json({ error: setup ? PIN_SETUP_TEXT[setup] : 'This dashboard cannot be refreshed yet.', setup }, { status: 409 });
  }

  // The refresher is the one waiting on it: a failure is recorded against them.
  const r = await refreshDashboard(dash, { userId: auth.user.id });
  if (!r.ok) {
    return NextResponse.json({ error: r.error ?? 'Refresh failed.', unreachable: !!r.unreachable }, { status: 503 });
  }

  const fresh = await prisma.dashboard.findUnique({
    where: { id },
    select: { cachedHtml: true, cachedSummary: true, refreshedAt: true, lastStatus: true, perServerStatus: true },
  });
  await prisma
    .$executeRawUnsafe(
      `INSERT INTO audit_logs (id, user_id, action, target_type, target_id, metadata, created_at)
       VALUES (gen_random_uuid()::text, $1, 'report.schedule_ran', 'ReportSchedule', $2, $3::jsonb, now())`,
      auth.user.id,
      dash.slug,
      JSON.stringify({ dashboardId: dash.slug, dashboardName: dash.title, refreshed: 1, failed: 0, status: r.partial ? 'partial' : 'ok', reason: r.error ?? null, trigger: 'manual' }),
    )
    .catch(() => {});
  return NextResponse.json({
    html: fresh?.cachedHtml ?? null,
    summary: fresh?.cachedSummary ?? null,
    refreshedAt: fresh?.refreshedAt ? fresh.refreshedAt.toISOString() : null,
    status: fresh?.lastStatus ?? null,
    perServerStatus: fresh?.perServerStatus ?? {},
  });
}
