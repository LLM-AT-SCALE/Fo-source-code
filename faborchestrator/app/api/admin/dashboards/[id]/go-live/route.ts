import { NextRequest, NextResponse } from "next/server";

import { requireAdmin, getIpAddress } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";
import { recordAuditLogDirect } from "@/modules/admin/lib/services/audit-service";
import { GoLiveError, publishDashboardEdit, type VisibilityInput } from "@/modules/admin/lib/dashboards/dashboard-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && !!x.trim()))] : [];

/**
 * POST /api/admin/dashboards/[id]/go-live {jobId, visibility?}
 * Publishes a direct-edit compile result as the next version of this dashboard.
 * Expiry and schedule are kept; visibility is kept unless provided.
 * → {versionId, versionNo, previousVersionId}
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  try {
    const b = (await req.json().catch(() => ({}))) as { jobId?: unknown; visibility?: { visibleToAll?: unknown; roleIds?: unknown; userIds?: unknown } };
    const jobId = typeof b.jobId === "string" ? b.jobId : "";
    if (!jobId) return NextResponse.json({ error: "jobId is required." }, { status: 400 });
    let visibility: VisibilityInput | undefined;
    if (b.visibility && typeof b.visibility === "object") {
      visibility = { visibleToAll: !!b.visibility.visibleToAll, roleIds: strList(b.visibility.roleIds), userIds: strList(b.visibility.userIds) };
    }

    const result = await prisma.$transaction((tx) => publishDashboardEdit(tx, { dashboardId: id, jobId, adminId: auth.user.id, visibility }));

    await recordAuditLogDirect(prisma, {
      userId: auth.user.id,
      action: "report.dashboard_live",
      targetType: "Dashboard",
      targetId: id,
      metadata: {
        dashboardId: id,
        slug: result.slug,
        title: result.title,
        mode: "edit",
        jobId,
        versionId: result.versionId,
        versionNo: result.versionNo,
        previousVersionId: result.previousVersionId,
        visibilityChanged: !!visibility,
      },
      ipAddress: getIpAddress(req),
    }).catch(() => {});

    return NextResponse.json({ versionId: result.versionId, versionNo: result.versionNo, previousVersionId: result.previousVersionId });
  } catch (e) {
    if (e instanceof GoLiveError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[api/admin/dashboards/[id]/go-live] failed", e);
    return NextResponse.json({ error: "Could not publish the new version." }, { status: 500 });
  }
}
