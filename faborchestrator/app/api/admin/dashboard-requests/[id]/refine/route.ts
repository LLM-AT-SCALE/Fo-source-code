import { NextRequest, NextResponse } from "next/server";

import { requireAdmin, getIpAddress } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";
import { recordAuditLog } from "@/modules/admin/lib/services/audit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/dashboard-requests/[id]/refine {instruction}
 * Queues a `refine` compile job (pre-live: base_version_id null) that carries
 * the same connection scope as the latest job. Returns {jobId}.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  try {
    const body = (await req.json().catch(() => ({}))) as { instruction?: unknown };
    const instruction = typeof body.instruction === "string" ? body.instruction.trim().slice(0, 4000) : "";
    if (!instruction) return NextResponse.json({ error: "Describe what to change." }, { status: 400 });

    const r = await prisma.dashboardRequest.findUnique({ where: { id }, select: { id: true, status: true, title: true } });
    if (!r) return NextResponse.json({ error: "Request not found." }, { status: 404 });
    if (["live", "denied", "cancelled", "requested"].includes(r.status)) {
      return NextResponse.json({ error: `A request in status '${r.status}' cannot be refined.` }, { status: 409 });
    }

    const latest = await prisma.dashboardCompileJob.findFirst({
      where: { requestId: id },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, dashboardId: true, connectionScope: true },
    });
    if (!latest) return NextResponse.json({ error: "Approve the request first; there is no compile job yet." }, { status: 409 });
    if (latest.status === "queued" || latest.status === "claimed") {
      return NextResponse.json({ error: "A compile is still running. Wait for it to finish before refining." }, { status: 409 });
    }

    const jobId = await prisma.$transaction(async (tx) => {
      const [job] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO dashboard_compile_jobs
           (id, kind, request_id, dashboard_id, base_version_id, instruction, connection_scope, status, created_by_id, created_at)
         VALUES (gen_random_uuid()::text, 'refine', $1, $2, NULL, $3, $4::jsonb, 'queued', $5, now())
         RETURNING id`,
        id,
        latest.dashboardId,
        instruction,
        JSON.stringify(latest.connectionScope ?? { mode: "all" }),
        auth.user.id,
      );
      await tx.$executeRawUnsafe(`UPDATE dashboard_requests SET updated_at = now() WHERE id = $1`, id);
      await recordAuditLog(tx, {
        userId: auth.user.id,
        action: "report.compile_requested",
        targetType: "DashboardCompileJob",
        targetId: job.id,
        metadata: { requestId: id, title: r.title, kind: "refine", instruction, previousJobId: latest.id },
        ipAddress: getIpAddress(req),
      });
      return job.id;
    });

    return NextResponse.json({ jobId });
  } catch (e) {
    console.error("[api/admin/dashboard-requests/[id]/refine] failed", e);
    return NextResponse.json({ error: "Could not queue the refinement." }, { status: 500 });
  }
}
