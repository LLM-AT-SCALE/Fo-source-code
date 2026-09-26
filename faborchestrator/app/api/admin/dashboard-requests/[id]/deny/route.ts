import { NextRequest, NextResponse } from "next/server";

import { requireAdmin, getIpAddress } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";
import { recordAuditLogDirect } from "@/modules/admin/lib/services/audit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FINAL = ["live", "denied", "cancelled"];

/** POST /api/admin/dashboard-requests/[id]/deny {note} → status 'denied'. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  try {
    const body = (await req.json().catch(() => ({}))) as { note?: unknown };
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 2000) : "";

    const r = await prisma.dashboardRequest.findUnique({ where: { id }, select: { id: true, status: true, title: true, requesterId: true } });
    if (!r) return NextResponse.json({ error: "Request not found." }, { status: 404 });
    if (FINAL.includes(r.status)) return NextResponse.json({ error: `This request is already ${r.status}.` }, { status: 409 });

    const decision = { mode: null, note, decidedById: auth.user.id, decidedAt: new Date().toISOString() };
    await prisma.$executeRawUnsafe(
      `UPDATE dashboard_requests
          SET status = 'denied', decision = $1::jsonb, decided_by_id = $2, decided_at = now(), updated_at = now()
        WHERE id = $3`,
      JSON.stringify(decision),
      auth.user.id,
      id,
    );

    await recordAuditLogDirect(prisma, {
      userId: auth.user.id,
      action: "report.request_denied",
      targetType: "DashboardRequest",
      targetId: id,
      metadata: { title: r.title, requesterId: r.requesterId, note },
      ipAddress: getIpAddress(req),
    }).catch(() => {});

    return NextResponse.json({ ok: true, status: "denied" });
  } catch (e) {
    console.error("[api/admin/dashboard-requests/[id]/deny] failed", e);
    return NextResponse.json({ error: "Could not deny the request." }, { status: 500 });
  }
}
