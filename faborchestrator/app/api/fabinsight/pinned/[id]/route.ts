import { NextRequest, NextResponse } from 'next/server';

import { requireAuth } from '@/shared/lib/auth-middleware';
import { prisma } from '@/shared/lib/db';
import { dashboardAccess } from '@/modules/fabinsight/lib/access';
import { canSee } from '@/modules/fabinsight/lib/visibility';
import { pinSetupStates } from '@/modules/fabinsight/lib/pin/setup-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VISIBILITY_SELECT = {
  status: true,
  visibleToAll: true,
  visibilityRoleIds: true,
  visibilityUserIds: true,
  createdById: true,
  requesterId: true,
} as const;

/**
 * GET — the cached snapshot for one dashboard, for users allowed to see it.
 *
 * Returns the last scheduled (or manual) cached HTML + when it was refreshed, so
 * `/reports` can show the shared snapshot without querying any source per
 * visitor. `html: null` means no snapshot exists yet (brand-new dashboard) and
 * the client offers a manual refresh instead.
 */
export async function GET(
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
      cachedHtml: true,
      cachedSummary: true,
      refreshedAt: true,
      lastStatus: true,
      perServerStatus: true,
      currentVersionId: true,
      sourceRequestId: true,
      ...VISIBILITY_SELECT,
    },
  });
  if (!dash) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  const access = await dashboardAccess(auth.user.id);
  if (!canSee(dash, { id: auth.user.id, roleId: auth.user.roleId ?? null, isAdmin: access.isAdmin })) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const setup = (await pinSetupStates([dash])).get(dash.id) ?? null;
  return NextResponse.json({
    id: dash.id,
    title: dash.title,
    setup,
    dashboardId: dash.slug,
    html: dash.cachedHtml ?? null,
    summary: dash.cachedSummary ?? null,
    refreshedAt: dash.refreshedAt ? dash.refreshedAt.toISOString() : null,
    status: dash.lastStatus ?? null,
    perServerStatus: dash.perServerStatus ?? {},
  });
}

/**
 * DELETE — remove a dashboard. Admin only. Cleans up every reference so nothing
 * dangles: schedule (keyed by slug), alert thresholds, shift-summary lists,
 * baseline samples, and the request that produced it is marked cancelled.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const access = await dashboardAccess(auth.user.id);
  if (!access.isAdmin) {
    return NextResponse.json({ error: 'Only an administrator can remove a dashboard.' }, { status: 403 });
  }

  const { id } = await params;
  const existing = await prisma.dashboard.findUnique({ where: { id }, select: { id: true, slug: true, sourceRequestId: true } });
  if (!existing) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  await prisma.dashboard.delete({ where: { id } }); // versions cascade
  await prisma.reportSchedule.deleteMany({ where: { dashboardId: existing.slug } }).catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM alert_thresholds WHERE dashboard_id IN ($1, $2) OR metric_key LIKE $3`,
      existing.id,
      existing.slug,
      `custom:${existing.slug}:%`,
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `UPDATE shift_summaries SET dashboard_ids = dashboard_ids - $1 - $2, updated_at = now()
        WHERE jsonb_exists(dashboard_ids, $1) OR jsonb_exists(dashboard_ids, $2)`,
      existing.id,
      existing.slug,
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(`DELETE FROM metric_samples WHERE metric_key LIKE $1`, `custom:${existing.slug}:%`)
    .catch(() => {});
  if (existing.sourceRequestId) {
    await prisma.dashboardRequest
      .updateMany({ where: { id: existing.sourceRequestId }, data: { status: 'cancelled', dashboardId: null } })
      .catch(() => {});
  }
  await prisma
    .$executeRawUnsafe(
      `INSERT INTO audit_logs (id, user_id, action, target_type, target_id, metadata, created_at)
       VALUES (gen_random_uuid()::text, $1, 'dashboard.deleted', 'Dashboard', $2, $3::jsonb, now())`,
      auth.user.id,
      existing.id,
      JSON.stringify({ slug: existing.slug }),
    )
    .catch(() => {});
  return NextResponse.json({ success: true });
}
