import { NextRequest, NextResponse } from "next/server";

import { requireAdmin, getIpAddress } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";
import { recordAuditLogDirect } from "@/modules/admin/lib/services/audit-service";
import { goLive, GoLiveError, sendDashboardLiveEmail } from "@/modules/admin/lib/dashboards/dashboard-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && !!x.trim()))] : [];

/**
 * POST /api/admin/dashboard-requests/[id]/go-live {jobId, visibleToAll, roleIds[], userIds[]}
 * Publishes the compile result as a dashboard version, activates the schedule,
 * marks the request live, emails the requester. Returns {dashboardId, slug, versionId, versionNo}.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  try {
    const body = (await req.json().catch(() => ({}))) as {
      jobId?: unknown;
      visibleToAll?: unknown;
      roleIds?: unknown;
      userIds?: unknown;
    };
    const jobId = typeof body.jobId === "string" ? body.jobId : "";
    if (!jobId) return NextResponse.json({ error: "jobId is required." }, { status: 400 });

    const result = await prisma.$transaction((tx) =>
      goLive(tx, {
        requestId: id,
        jobId,
        adminId: auth.user.id,
        visibleToAll: !!body.visibleToAll,
        roleIds: strList(body.roleIds),
        userIds: strList(body.userIds),
      }),
    );

    const emailed = await sendDashboardLiveEmail(prisma, result);

    await recordAuditLogDirect(prisma, {
      userId: auth.user.id,
      action: "report.dashboard_live",
      targetType: "Dashboard",
      targetId: id,
      metadata: {
        requestId: id,
        dashboardId: result.dashboardId,
        slug: result.slug,
        title: result.title,
        mode: result.mode,
        versionId: result.versionId,
        versionNo: result.versionNo,
        jobId,
        requesterId: result.requesterId,
        visibleToAll: !!body.visibleToAll,
        roleIds: strList(body.roleIds),
        userIds: strList(body.userIds),
        expiresAt: result.expiresAt?.toISOString() ?? null,
        emailed,
      },
      ipAddress: getIpAddress(req),
    }).catch(() => {});

    return NextResponse.json({
      dashboardId: result.dashboardId,
      slug: result.slug,
      versionId: result.versionId,
      versionNo: result.versionNo,
      mode: result.mode,
      emailed,
    });
  } catch (e) {
    if (e instanceof GoLiveError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[api/admin/dashboard-requests/[id]/go-live] failed", e);
    return NextResponse.json({ error: "Could not publish the dashboard." }, { status: 500 });
  }
}
