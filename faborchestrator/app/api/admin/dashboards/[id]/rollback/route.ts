import { NextRequest, NextResponse } from "next/server";

import { requireAdmin, getIpAddress } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";
import { recordAuditLogDirect } from "@/modules/admin/lib/services/audit-service";
import { GoLiveError, rollbackDashboard } from "@/modules/admin/lib/dashboards/dashboard-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/dashboards/[id]/rollback {versionId}
 * Re-points current_version_id (and restores that version's KPIs / scope).
 * Audit: report.dashboard_rollback. → {versionId, versionNo, previousVersionId}
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  try {
    const b = (await req.json().catch(() => ({}))) as { versionId?: unknown };
    const versionId = typeof b.versionId === "string" ? b.versionId : "";
    if (!versionId) return NextResponse.json({ error: "versionId is required." }, { status: 400 });

    const result = await prisma.$transaction((tx) => rollbackDashboard(tx, { dashboardId: id, versionId, adminId: auth.user.id }));

    await recordAuditLogDirect(prisma, {
      userId: auth.user.id,
      action: "report.dashboard_rollback",
      targetType: "Dashboard",
      targetId: id,
      metadata: { slug: result.slug, title: result.title, versionId: result.versionId, versionNo: result.versionNo, previousVersionId: result.previousVersionId },
      ipAddress: getIpAddress(req),
    }).catch(() => {});

    return NextResponse.json({ versionId: result.versionId, versionNo: result.versionNo, previousVersionId: result.previousVersionId });
  } catch (e) {
    if (e instanceof GoLiveError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[api/admin/dashboards/[id]/rollback] failed", e);
    return NextResponse.json({ error: "Could not roll back." }, { status: 500 });
  }
}
