import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";
import { rankMatches } from "@/modules/admin/lib/dashboards/dashboard-matching";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/dashboard-requests/[id]/matches
 * The 5 live/paused dashboards closest to this request by KPI overlap.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  try {
    const r = await prisma.dashboardRequest.findUnique({ where: { id }, select: { title: true, kpis: true } });
    if (!r) return NextResponse.json({ error: "Request not found." }, { status: 404 });

    const dashboards = await prisma.dashboard.findMany({
      where: { status: { in: ["live", "paused"] } },
      select: { id: true, slug: true, title: true, kpis: true, status: true, expiresAt: true },
    });
    const meta = new Map(dashboards.map((d) => [d.id, d]));
    const matches = rankMatches({ title: r.title, kpis: r.kpis }, dashboards, 5).map((m) => ({
      ...m,
      slug: meta.get(m.dashboardId)?.slug ?? null,
      status: meta.get(m.dashboardId)?.status ?? null,
      expiresAt: meta.get(m.dashboardId)?.expiresAt ?? null,
    }));
    return NextResponse.json({ matches });
  } catch (e) {
    console.error("[api/admin/dashboard-requests/[id]/matches] failed", e);
    return NextResponse.json({ error: "Could not compute matches." }, { status: 500 });
  }
}
