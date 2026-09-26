import { NextRequest, NextResponse } from "next/server";

import { requireAdmin, getIpAddress } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";
import { parseScheduleInput, resolveExpiry } from "@/modules/admin/lib/dashboards/report-schedule";
import { recordAuditLogDirect } from "@/modules/admin/lib/services/audit-service";
import { GoLiveError, setDashboardSchedule, updateDashboard, type VisibilityInput } from "@/modules/admin/lib/dashboards/dashboard-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && !!x.trim()))] : [];

type ScheduleRow = {
  id: string;
  source_key: string;
  frequency: string;
  interval_minutes: number | null;
  at_time: string | null;
  days_of_week: string | null;
  day_of_month: number | null;
  enabled: boolean;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_status: string | null;
  timezone: string | null;
  window_start: string | null;
  window_end: string | null;
};

/**
 * GET /api/admin/dashboards/[id]
 * → {dashboard, currentVersion:{id, versionNo, templateHtml}, versions[] (no template),
 *    jobs[] (direct-edit jobs for this dashboard, newest first, no template), schedule}
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  try {
    const d = await prisma.dashboard.findUnique({ where: { id } });
    if (!d) return NextResponse.json({ error: "Dashboard not found." }, { status: 404 });

    const [versions, jobs, schedules] = await Promise.all([
      prisma.dashboardVersion.findMany({
        where: { dashboardId: id },
        orderBy: { versionNo: "desc" },
        select: {
          id: true,
          versionNo: true,
          kpis: true,
          connectionScope: true,
          refineHistory: true,
          createdFromJobId: true,
          approvedById: true,
          createdAt: true,
        },
      }),
      prisma.dashboardCompileJob.findMany({
        where: { dashboardId: id, requestId: null },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          kind: true,
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
      }),
      prisma.$queryRawUnsafe<ScheduleRow[]>(
        `SELECT id, source_key, frequency, interval_minutes, at_time, days_of_week, day_of_month, enabled,
                next_run_at, last_run_at, last_status, timezone, window_start, window_end
           FROM report_schedules WHERE dashboard_id = $1 ORDER BY source_key LIMIT 1`,
        d.slug,
      ),
    ]);

    const current = d.currentVersionId
      ? await prisma.dashboardVersion.findUnique({
          where: { id: d.currentVersionId },
          select: { id: true, versionNo: true, templateHtml: true },
        })
      : null;

    const roleIds = Array.isArray(d.visibilityRoleIds) ? (d.visibilityRoleIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const userIds = Array.isArray(d.visibilityUserIds) ? (d.visibilityUserIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const personIds = [...new Set([d.createdById, d.requesterId, ...userIds, ...versions.map((v) => v.approvedById), ...jobs.map((j) => j.createdById)].filter((x): x is string => !!x))];
    const [roles, users] = await Promise.all([
      roleIds.length ? prisma.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
      personIds.length ? prisma.user.findMany({ where: { id: { in: personIds } }, select: { id: true, name: true, email: true } }) : Promise.resolve([]),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const person = (uid: string | null) => {
      if (!uid) return null;
      const u = userById.get(uid);
      return { id: uid, name: u?.name ?? null, email: u?.email ?? null };
    };
    const s = schedules[0];

    return NextResponse.json({
      dashboard: {
        id: d.id,
        slug: d.slug,
        title: d.title,
        kind: d.kind,
        status: d.status,
        currentVersionId: d.currentVersionId,
        kpis: d.kpis,
        visibleToAll: d.visibleToAll,
        visibilityRoleIds: roleIds,
        visibilityRoles: roles,
        visibilityUserIds: userIds,
        visibilityUsers: userIds.map(person),
        connectionScope: d.connectionScope,
        expiresAt: d.expiresAt,
        expiryWarnedAt: d.expiryWarnedAt,
        sourceRequestId: d.sourceRequestId,
        createdBy: person(d.createdById),
        requester: person(d.requesterId),
        metricColumns: d.metricColumns,
        cachedHtml: d.cachedHtml,
        cachedSummary: d.cachedSummary,
        refreshedAt: d.refreshedAt,
        lastStatus: d.lastStatus,
        perServerStatus: d.perServerStatus,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      },
      currentVersion: current ? { id: current.id, versionNo: current.versionNo, templateHtml: current.templateHtml } : null,
      versions: versions.map((v) => ({
        id: v.id,
        versionNo: v.versionNo,
        kpis: v.kpis,
        connectionScope: v.connectionScope,
        refineHistory: v.refineHistory,
        createdFromJobId: v.createdFromJobId,
        approvedBy: person(v.approvedById),
        createdAt: v.createdAt,
        current: v.id === d.currentVersionId,
      })),
      jobs: jobs.map((j) => ({
        id: j.id,
        kind: j.kind,
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
      schedule: s
        ? {
            id: s.id,
            sourceKey: s.source_key,
            frequency: s.frequency,
            intervalMinutes: s.interval_minutes,
            atTime: s.at_time,
            daysOfWeek: s.days_of_week ? s.days_of_week.split(",").map((n) => parseInt(n, 10)).filter((n) => n >= 0 && n <= 6) : [],
            dayOfMonth: s.day_of_month,
            enabled: s.enabled,
            nextRunAt: s.next_run_at,
            lastRunAt: s.last_run_at,
            lastStatus: s.last_status,
            timezone: s.timezone ?? "UTC",
            windowStart: s.window_start,
            windowEnd: s.window_end,
          }
        : null,
    });
  } catch (e) {
    console.error("[api/admin/dashboards/[id]] GET failed", e);
    return NextResponse.json({ error: "Could not load the dashboard." }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/dashboards/[id]
 *   {visibility?, expiry?|expiresAt?, status?:'live'|'paused',
 *    schedule?:{frequency, intervalMinutes?, atTime?, daysOfWeek?, dayOfMonth?, timezone?, windowStart?, windowEnd?, enabled?}}
 * Status flips report_schedules.enabled; resuming an expired dashboard needs a
 * new future expiry in the same call. `schedule` upserts the report_schedules
 * row (next_run_at = now(); enabled:false pauses only the schedule).
 * Audit: report.dashboard_updated for visibility/expiry/status, report.schedule_set for schedule.
 * → {ok, changes, schedule?: {description, enabled}}
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  try {
    const b = (await req.json().catch(() => ({}))) as {
      visibility?: { visibleToAll?: unknown; roleIds?: unknown; userIds?: unknown };
      expiry?: unknown;
      expiresAt?: unknown;
      status?: unknown;
      schedule?: unknown;
    };

    let visibility: VisibilityInput | undefined;
    if (b.visibility && typeof b.visibility === "object") {
      visibility = { visibleToAll: !!b.visibility.visibleToAll, roleIds: strList(b.visibility.roleIds), userIds: strList(b.visibility.userIds) };
    }

    const now = new Date();
    // undefined = leave alone; null = no end date; Date = new expiry.
    let expiresAt: Date | null | undefined;
    if (b.expiry !== undefined) {
      const r = resolveExpiry(b.expiry, now);
      if (r !== null && !(r instanceof Date)) return NextResponse.json({ error: r.error }, { status: 400 });
      expiresAt = r;
    } else if (b.expiresAt === null) {
      expiresAt = null;
    } else if (typeof b.expiresAt === "string") {
      const r = resolveExpiry({ preset: "custom", date: b.expiresAt }, now);
      if (r !== null && !(r instanceof Date)) return NextResponse.json({ error: r.error }, { status: 400 });
      expiresAt = r;
    }

    let status: "live" | "paused" | undefined;
    if (b.status !== undefined) {
      if (b.status !== "live" && b.status !== "paused") return NextResponse.json({ error: "status must be 'live' or 'paused'." }, { status: 400 });
      status = b.status;
    }
    let schedule: ReturnType<typeof parseScheduleInput> | undefined;
    if (b.schedule !== undefined) {
      const parsed = parseScheduleInput(b.schedule);
      if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
      schedule = parsed;
    }

    if (!visibility && expiresAt === undefined && !status && !schedule) return NextResponse.json({ error: "Nothing to update." }, { status: 400 });

    const scheduleInput = schedule && !("error" in schedule) ? schedule : undefined;
    const { result, sched } = await prisma.$transaction(async (tx) => {
      const result = await updateDashboard(tx, { dashboardId: id, adminId: auth.user.id, visibility, expiresAt, status, now });
      const sched = scheduleInput ? await setDashboardSchedule(tx, { dashboardId: id, adminId: auth.user.id, schedule: scheduleInput }) : null;
      return { result, sched };
    });

    if (Object.keys(result.changes).length) {
      await recordAuditLogDirect(prisma, {
        userId: auth.user.id,
        action: "report.dashboard_updated",
        targetType: "Dashboard",
        targetId: id,
        metadata: { slug: result.slug, title: result.title, changes: result.changes },
        ipAddress: getIpAddress(req),
      }).catch(() => {});
    }
    if (sched && scheduleInput) {
      await recordAuditLogDirect(prisma, {
        userId: auth.user.id,
        action: "report.schedule_set",
        targetType: "ReportSchedule",
        targetId: sched.slug,
        metadata: {
          dashboardId: sched.slug,
          dashboardName: sched.title,
          via: "dashboard",
          frequency: scheduleInput.frequency,
          intervalMinutes: scheduleInput.intervalMinutes,
          atTime: scheduleInput.atTime,
          daysOfWeek: scheduleInput.daysOfWeekStr,
          dayOfMonth: scheduleInput.dayOfMonth,
          timezone: scheduleInput.timezone,
          windowStart: scheduleInput.windowStart,
          windowEnd: scheduleInput.windowEnd,
          enabled: scheduleInput.enabled,
        },
        ipAddress: getIpAddress(req),
      }).catch(() => {});
    }

    return NextResponse.json({
      ok: true,
      changes: result.changes,
      ...(sched ? { schedule: { description: sched.description, enabled: sched.enabled } } : {}),
    });
  } catch (e) {
    if (e instanceof GoLiveError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[api/admin/dashboards/[id]] PATCH failed", e);
    return NextResponse.json({ error: "Could not update the dashboard." }, { status: 500 });
  }
}
