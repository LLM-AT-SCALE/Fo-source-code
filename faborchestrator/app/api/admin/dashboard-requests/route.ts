import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";
import { kpiCount, PENDING_STATUSES, REQUEST_STATUSES, type RequestStatus } from "@/modules/admin/lib/dashboards/dashboard-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/dashboard-requests?status=&count=1
 * List pin requests (never the HTML) plus `pendingCount` = requests awaiting an
 * admin action (requested / preview_ready). `count=1` returns only the count —
 * the sidebar badge polls it every 30 s.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const url = new URL(req.url);
    const pendingCount = await prisma.dashboardRequest.count({ where: { status: { in: PENDING_STATUSES } } });
    if (url.searchParams.get("count") === "1") {
      return NextResponse.json({ pendingCount });
    }

    const statusParam = url.searchParams.get("status");
    const status = (REQUEST_STATUSES as readonly string[]).includes(statusParam ?? "")
      ? (statusParam as RequestStatus)
      : null;

    const rows = await prisma.dashboardRequest.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        title: true,
        requesterId: true,
        reason: true,
        kpis: true,
        status: true,
        createdAt: true,
        decidedAt: true,
        dashboardId: true,
      },
    });

    const requesterIds = [...new Set(rows.map((r) => r.requesterId))];
    const users = requesterIds.length
      ? await prisma.user.findMany({ where: { id: { in: requesterIds } }, select: { id: true, name: true, email: true } })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));

    return NextResponse.json({
      requests: rows.map((r) => {
        const u = byId.get(r.requesterId);
        return {
          id: r.id,
          title: r.title,
          requester: { id: r.requesterId, name: u?.name ?? null, email: u?.email ?? null },
          reason: r.reason,
          kpiCount: kpiCount(r.kpis),
          status: r.status,
          createdAt: r.createdAt,
          decidedAt: r.decidedAt,
          dashboardId: r.dashboardId,
        };
      }),
      pendingCount,
    });
  } catch (e) {
    console.error("[api/admin/dashboard-requests] GET failed", e);
    return NextResponse.json({ error: "Could not load dashboard requests." }, { status: 500 });
  }
}
