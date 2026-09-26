import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";
import { summarizeTrace, TIMELINE_ACTIONS, traceServers } from "@/modules/admin/lib/dashboards/dashboard-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/dashboard-requests/[id]
 * One request in full (HTML, KPIs, trace summary, decision), its compile jobs
 * (newest first, without the raw template), the dashboard it produced or will
 * extend, and a status timeline built from audit_logs.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  try {
    const r = await prisma.dashboardRequest.findUnique({ where: { id } });
    if (!r) return NextResponse.json({ error: "Request not found." }, { status: 404 });

    const jobs = await prisma.dashboardCompileJob.findMany({
      where: { requestId: id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        kind: true,
        dashboardId: true,
        baseVersionId: true,
        instruction: true,
        connectionScope: true,
        status: true,
        attempts: true,
        claimedAt: true,
        finishedAt: true,
        resultHtml: true,
        resultKpis: true,
        resultNotes: true,
        usage: true,
        error: true,
        createdById: true,
        createdAt: true,
      },
    });

    const decision = (r.decision && typeof r.decision === "object" ? r.decision : null) as Record<string, unknown> | null;
    const dashboardId =
      r.dashboardId ?? (decision && typeof decision.targetDashboardId === "string" ? decision.targetDashboardId : null);
    const dashboard = dashboardId
      ? await prisma.dashboard.findUnique({
          where: { id: dashboardId },
          select: {
            id: true,
            slug: true,
            title: true,
            kind: true,
            status: true,
            currentVersionId: true,
            kpis: true,
            visibleToAll: true,
            visibilityRoleIds: true,
            visibilityUserIds: true,
            expiresAt: true,
            refreshedAt: true,
            lastStatus: true,
          },
        })
      : null;

    const userIds = [...new Set([r.requesterId, r.decidedById, ...jobs.map((j) => j.createdById)].filter((x): x is string => !!x))];
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } });
    const userById = new Map(users.map((u) => [u.id, u]));
    const person = (uid: string | null) => {
      if (!uid) return null;
      const u = userById.get(uid);
      return { id: uid, name: u?.name ?? null, email: u?.email ?? null };
    };

    const targetIds = [id, ...jobs.map((j) => j.id)];
    const audit = await prisma.auditLog.findMany({
      where: { targetId: { in: targetIds }, action: { in: [...TIMELINE_ACTIONS] } },
      orderBy: { createdAt: "asc" },
      select: { id: true, action: true, targetId: true, userId: true, metadata: true, createdAt: true },
    });
    const actorIds = [...new Set(audit.map((a) => a.userId).filter((x): x is string => !!x && !userById.has(x)))];
    if (actorIds.length) {
      const more = await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } });
      for (const u of more) userById.set(u.id, u);
    }

    return NextResponse.json({
      request: {
        id: r.id,
        title: r.title,
        reason: r.reason,
        html: r.html,
        kpis: Array.isArray(r.kpis) ? r.kpis : [],
        trace: summarizeTrace(r.trace),
        traceServers: traceServers(r.trace),
        status: r.status,
        decision,
        requester: person(r.requesterId),
        decidedBy: person(r.decidedById),
        decidedAt: r.decidedAt,
        dashboardId: r.dashboardId,
        conversationId: r.conversationId,
        messageId: r.messageId,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      },
      jobs: jobs.map((j) => ({
        id: j.id,
        kind: j.kind,
        dashboardId: j.dashboardId,
        baseVersionId: j.baseVersionId,
        instruction: j.instruction,
        connectionScope: j.connectionScope,
        status: j.status,
        attempts: j.attempts,
        claimedAt: j.claimedAt,
        finishedAt: j.finishedAt,
        resultHtml: j.resultHtml,
        resultKpis: j.resultKpis,
        resultNotes: j.resultNotes,
        // Carries live `{progress}` while the compile runs, then the real totals.
        usage: j.usage,
        error: j.error,
        createdBy: person(j.createdById),
        createdAt: j.createdAt,
      })),
      dashboard: dashboard
        ? {
            id: dashboard.id,
            slug: dashboard.slug,
            title: dashboard.title,
            kind: dashboard.kind,
            status: dashboard.status,
            currentVersionId: dashboard.currentVersionId,
            kpis: dashboard.kpis,
            visibleToAll: dashboard.visibleToAll,
            visibilityRoleIds: dashboard.visibilityRoleIds,
            visibilityUserIds: dashboard.visibilityUserIds,
            expiresAt: dashboard.expiresAt,
            refreshedAt: dashboard.refreshedAt,
            lastStatus: dashboard.lastStatus,
          }
        : null,
      timeline: audit.map((a) => ({
        id: a.id,
        action: a.action,
        targetId: a.targetId,
        actor: person(a.userId),
        metadata: a.metadata,
        at: a.createdAt,
      })),
    });
  } catch (e) {
    console.error("[api/admin/dashboard-requests/[id]] GET failed", e);
    return NextResponse.json({ error: "Could not load the request." }, { status: 500 });
  }
}
