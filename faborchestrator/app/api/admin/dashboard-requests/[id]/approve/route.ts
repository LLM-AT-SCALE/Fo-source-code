import { NextRequest, NextResponse } from "next/server";

import { requireAdmin, getIpAddress } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";
import { parseScheduleInput, resolveExpiry } from "@/modules/admin/lib/dashboards/report-schedule";
import { recordAuditLog } from "@/modules/admin/lib/services/audit-service";
import {
  createPinnedDashboard,
  GoLiveError,
  publishStaticRequest,
  type ConnectionScope,
  type RequestDecision,
  type VisibilityInput,
} from "@/modules/admin/lib/dashboards/dashboard-service";
import { zonedToUtc } from "@/modules/fabinsight/lib/replay/tz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Statuses an admin can (re-)approve from. */
const APPROVABLE = ["requested", "compile_failed", "denied"];

type Body = {
  type?: unknown;
  startDate?: unknown;
  autoPublish?: unknown;
  visibility?: { visibleToAll?: unknown; roleIds?: unknown; userIds?: unknown };
  mode?: unknown;
  targetDashboardId?: unknown;
  connections?: { mode?: unknown; registryIds?: unknown };
  schedule?: unknown;
  expiry?: unknown;
};

/**
 * POST /api/admin/dashboard-requests/[id]/approve
 * Body: {type?:'scheduled'|'static', mode:'create'|'extend', targetDashboardId?,
 *        connections:{mode:'servers',registryIds[]}|{mode:'all'}, schedule:{frequency,…},
 *        expiry:{preset:7|14|30|90|'custom'|'never', date?}, startDate?:'YYYY-MM-DD',
 *        autoPublish?:boolean, visibility?:{visibleToAll, roleIds[], userIds[]}}
 *
 * type 'static': publishes the pinned snapshot as a live dashboard now (no
 * compile, no schedule) → {status:'live', dashboardId}.
 * Otherwise marks the request approved (with the decision) and queues a compile
 * job for Fab Orchestrator's tick, in one transaction → {jobId}. With
 * autoPublish, the compile result publishes itself (with `visibility`) instead of
 * waiting for a review; a new dashboard is created at once showing the pinned
 * snapshot, so the requester can open it while it compiles.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  try {
    const body = (await req.json().catch(() => ({}))) as Body;
    const strList = (v: unknown): string[] =>
      Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && !!x.trim()))] : [];
    const visibility: VisibilityInput = {
      visibleToAll: body.visibility ? body.visibility.visibleToAll !== false : true,
      roleIds: strList(body.visibility?.roleIds),
      userIds: strList(body.visibility?.userIds),
    };

    if (body.type === "static") {
      const out = await prisma.$transaction((tx) => publishStaticRequest(tx, { requestId: id, adminId: auth.user.id, visibility }));
      await prisma.auditLog
        .create({
          data: {
            userId: auth.user.id,
            action: "report.dashboard_live",
            targetType: "Dashboard",
            targetId: id,
            metadata: { requestId: id, dashboardId: out.dashboardId, slug: out.slug, title: out.title, type: "static", requesterId: out.requesterId, ...visibility },
            ipAddress: getIpAddress(req),
          },
        })
        .catch(() => {});
      return NextResponse.json({ status: "live", dashboardId: out.dashboardId, slug: out.slug });
    }

    const mode = body.mode === "extend" ? "extend" : body.mode === "create" ? "create" : null;
    if (!mode) return NextResponse.json({ error: "mode must be 'create' or 'extend'." }, { status: 400 });

    const schedule = parseScheduleInput(body.schedule);
    if ("error" in schedule) return NextResponse.json({ error: schedule.error }, { status: 400 });

    const now = new Date();
    const expires = resolveExpiry(body.expiry, now);
    if (expires !== null && !(expires instanceof Date)) return NextResponse.json({ error: expires.error }, { status: 400 });

    // Connection scope: every connected server, or a fixed list of registry entries.
    let connectionScope: ConnectionScope;
    if (body.connections?.mode === "all") {
      connectionScope = { mode: "all" };
    } else if (body.connections?.mode === "servers") {
      const ids = Array.isArray(body.connections.registryIds)
        ? [...new Set(body.connections.registryIds.filter((x): x is string => typeof x === "string" && !!x.trim()))]
        : [];
      if (!ids.length) return NextResponse.json({ error: "Pick at least one MCP server." }, { status: 400 });
      const entries = await prisma.mcpRegistry.findMany({ where: { id: { in: ids } }, select: { id: true, serverUrl: true, isActive: true } });
      const found = new Map(entries.map((e) => [e.id, e]));
      const missing = ids.filter((x) => !found.has(x));
      if (missing.length) return NextResponse.json({ error: "One of the selected servers is not in the MCP registry." }, { status: 400 });
      connectionScope = { mode: "fixed", servers: ids.map((rid) => ({ registryId: rid, serverUrl: found.get(rid)!.serverUrl })) };
    } else {
      return NextResponse.json({ error: "connections.mode must be 'all' or 'servers'." }, { status: 400 });
    }

    const r = await prisma.dashboardRequest.findUnique({
      where: { id },
      select: { id: true, status: true, title: true, requesterId: true, decision: true, dashboardId: true, html: true, kpis: true, createdAt: true },
    });
    if (!r) return NextResponse.json({ error: "Request not found." }, { status: 404 });
    if (!APPROVABLE.includes(r.status)) {
      return NextResponse.json({ error: `A request in status '${r.status}' cannot be approved.` }, { status: 409 });
    }

    // Extend: the target must exist; the new version starts from its current one.
    let targetDashboardId: string | null = null;
    let baseVersionId: string | null = null;
    if (mode === "extend") {
      const target = typeof body.targetDashboardId === "string" ? body.targetDashboardId : "";
      if (!target) return NextResponse.json({ error: "Pick the dashboard to extend from the matches." }, { status: 400 });
      const d = await prisma.dashboard.findUnique({ where: { id: target }, select: { id: true, currentVersionId: true, status: true } });
      if (!d) return NextResponse.json({ error: "The dashboard to extend was not found." }, { status: 404 });
      if (d.status === "expired") return NextResponse.json({ error: "That dashboard has expired; extend its expiry first or create a new one." }, { status: 409 });
      targetDashboardId = d.id;
      baseVersionId = d.currentVersionId;
    }

    // From date: the first refresh waits for it (a date today or earlier = now).
    let startsAt: Date | null = null;
    const startRaw = typeof body.startDate === "string" ? body.startDate.trim() : "";
    if (startRaw) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startRaw);
      if (!m) return NextResponse.json({ error: "The start date is not a valid date." }, { status: 400 });
      const at = zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, schedule.timezone || "UTC");
      if (at.getTime() > now.getTime()) startsAt = at;
      if (startsAt && expires && expires.getTime() <= startsAt.getTime()) {
        return NextResponse.json({ error: "The expiry must be after the start date." }, { status: 400 });
      }
    }
    const autoPublish = body.autoPublish === true;
    const previous = (r.decision && typeof r.decision === "object" ? r.decision : {}) as Record<string, unknown>;

    const decision: RequestDecision & { type: "scheduled" } = {
      type: "scheduled",
      mode,
      targetDashboardId,
      connectionScope,
      schedule,
      expiresAt: expires ? expires.toISOString() : null,
      startsAt: startsAt ? startsAt.toISOString() : null,
      autoPublish,
      visibility: autoPublish ? visibility : undefined,
      requested: previous.requested ?? undefined,
      decidedById: auth.user.id,
      decidedAt: now.toISOString(),
      note: null,
    };

    const jobId = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE dashboard_requests
            SET status = 'approved', decision = $1::jsonb, decided_by_id = $2, decided_at = now(), updated_at = now()
          WHERE id = $3`,
        JSON.stringify(decision),
        auth.user.id,
        id,
      );
      const [job] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO dashboard_compile_jobs
           (id, kind, request_id, dashboard_id, base_version_id, connection_scope, status, created_by_id, created_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5::jsonb, 'queued', $6, now())
         RETURNING id`,
        mode,
        id,
        targetDashboardId,
        baseVersionId,
        JSON.stringify(connectionScope),
        auth.user.id,
      );
      // Published automatically → the requester can open it now: a new
      // dashboard shows the pinned snapshot until the compile lands in it.
      if (autoPublish && mode === "create" && !r.dashboardId) {
        await createPinnedDashboard(tx, {
          requestId: id,
          title: r.title,
          html: r.html,
          kpis: r.kpis,
          scope: connectionScope,
          expiresAt: expires,
          visibility,
          adminId: auth.user.id,
          requesterId: r.requesterId,
          snapshotAt: r.createdAt,
        });
      }
      await recordAuditLog(tx, {
        userId: auth.user.id,
        action: "report.request_approved",
        targetType: "DashboardRequest",
        targetId: id,
        metadata: {
          title: r.title,
          requesterId: r.requesterId,
          mode,
          targetDashboardId,
          jobId: job.id,
          connectionScope,
          schedule,
          expiresAt: decision.expiresAt,
          startsAt: decision.startsAt,
          autoPublish,
        },
        ipAddress: getIpAddress(req),
      });
      return job.id;
    });

    return NextResponse.json({ jobId, status: "approved", autoPublish });
  } catch (e) {
    if (e instanceof GoLiveError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[api/admin/dashboard-requests/[id]/approve] failed", e);
    return NextResponse.json({ error: "Could not approve the request." }, { status: 500 });
  }
}
