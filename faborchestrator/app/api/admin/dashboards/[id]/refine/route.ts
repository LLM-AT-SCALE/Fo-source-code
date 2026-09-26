import { NextRequest, NextResponse } from "next/server";

import { requireAdmin, getIpAddress } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";
import { recordAuditLog } from "@/modules/admin/lib/services/audit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/dashboards/[id]/refine {instruction}
 * Queues a direct-edit compile job against the live dashboard: kind 'refine',
 * base_version_id = current version, scope = the dashboard's scope. → {jobId}
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  try {
    const body = (await req.json().catch(() => ({}))) as { instruction?: unknown };
    const instruction = typeof body.instruction === "string" ? body.instruction.trim().slice(0, 4000) : "";
    if (!instruction) return NextResponse.json({ error: "Describe what to change." }, { status: 400 });

    const d = await prisma.dashboard.findUnique({
      where: { id },
      select: { id: true, slug: true, title: true, status: true, currentVersionId: true, connectionScope: true },
    });
    if (!d) return NextResponse.json({ error: "Dashboard not found." }, { status: 404 });
    if (!d.currentVersionId) return NextResponse.json({ error: "This dashboard has no version to edit yet." }, { status: 409 });

    const running = await prisma.dashboardCompileJob.findFirst({
      where: { dashboardId: id, status: { in: ["queued", "claimed"] } },
      select: { id: true },
    });
    if (running) return NextResponse.json({ error: "A compile is still running for this dashboard. Wait for it to finish." }, { status: 409 });

    const jobId = await prisma.$transaction(async (tx) => {
      const [job] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO dashboard_compile_jobs
           (id, kind, request_id, dashboard_id, base_version_id, instruction, connection_scope, status, created_by_id, created_at)
         VALUES (gen_random_uuid()::text, 'refine', NULL, $1, $2, $3, $4::jsonb, 'queued', $5, now())
         RETURNING id`,
        id,
        d.currentVersionId,
        instruction,
        JSON.stringify(d.connectionScope ?? { mode: "all" }),
        auth.user.id,
      );
      await recordAuditLog(tx, {
        userId: auth.user.id,
        action: "report.compile_requested",
        targetType: "DashboardCompileJob",
        targetId: job.id,
        metadata: { dashboardId: id, slug: d.slug, title: d.title, kind: "refine", instruction, baseVersionId: d.currentVersionId },
        ipAddress: getIpAddress(req),
      });
      return job.id;
    });

    return NextResponse.json({ jobId });
  } catch (e) {
    console.error("[api/admin/dashboards/[id]/refine] failed", e);
    return NextResponse.json({ error: "Could not queue the edit." }, { status: 500 });
  }
}
