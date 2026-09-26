/**
 * Dashboard governance writes (shared tables, raw SQL — the DDL lives in
 * faborchestrator/prisma/create_dashboards.sql).
 *
 * Every function takes an injected SQL client so the route can run it inside
 * `prisma.$transaction(tx => …)` and the tests can pass a fake.
 */

import { sendSmtpEmail } from "@/modules/admin/lib/email/smtp";
import { buildDashboardLiveEmailHtml } from "@/modules/admin/lib/email/dashboard-live-template";
import type { ScheduleInput } from "@/modules/admin/lib/dashboards/report-schedule";

/** The subset of PrismaClient / TransactionClient the services use. */
export interface SqlClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export type ConnectionScope =
  | { mode: "all" }
  | { mode: "fixed"; servers: { registryId: string; serverUrl: string }[] };

/** What the approve step stores on `dashboard_requests.decision`. */
export type RequestDecision = {
  mode: "create" | "extend";
  targetDashboardId: string | null;
  connectionScope: ConnectionScope;
  schedule: ScheduleInput;
  /** ISO instant. */
  expiresAt: string | null;
  decidedById: string;
  /** ISO instant. */
  decidedAt: string;
  note?: string | null;
  /** ISO instant of the first scheduled refresh (the pin's From date); null/absent = as soon as it is live. */
  startsAt?: string | null;
  /** Publish the compile result as soon as it is ready, without a separate review step. */
  autoPublish?: boolean;
  /** Who sees the dashboard when it is published automatically. */
  visibility?: VisibilityInput;
  /** What the person who pinned it chose in the Pin dialog (PinChoices), kept for the record. */
  requested?: unknown;
};

const DEFAULT_SOURCE_KEY = "lumentum";

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Human sentence for a schedule ("daily at 06:00 Asia/Kolkata"). */
export function describeSchedule(s: ScheduleInput | null | undefined): string {
  if (!s) return "no schedule";
  const tz = s.timezone || "UTC";
  if (s.frequency === "hourly") {
    const win = s.windowStart && s.windowEnd ? ` between ${s.windowStart}–${s.windowEnd} ${tz}` : "";
    return `every ${s.intervalMinutes ?? 60} min${win}`;
  }
  const at = s.atTime ?? "00:00";
  if (s.frequency === "daily") return `daily at ${at} ${tz}`;
  if (s.frequency === "weekly") {
    const days = s.daysOfWeek.length ? s.daysOfWeek : [1];
    return `weekly on ${days.map((d) => DOW_SHORT[d] ?? d).join(", ")} at ${at} ${tz}`;
  }
  return `monthly on day ${s.dayOfMonth ?? 1} at ${at} ${tz}`;
}

/**
 * Upsert one `report_schedules` row for a dashboard slug. `next_run_at = now()`
 * makes it due on Fab Orchestrator's next tick; Fab Orch computes later runs.
 * Same statement as app/api/admin/report-schedule/route.ts.
 */
async function upsertReportSchedule(
  db: SqlClient,
  args: { dashboardSlug: string; schedule: ScheduleInput; updatedById: string; sourceKey?: string; enabled?: boolean; startsAt?: Date | null },
): Promise<void> {
  const s = args.schedule;
  await db.$executeRawUnsafe(
    `INSERT INTO report_schedules
       (id, dashboard_id, source_key, frequency, interval_minutes, at_time, days_of_week, day_of_month, enabled, next_run_at, updated_by_id, timezone, window_start, window_end, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, GREATEST(now(), $13::timestamptz), $9, $10, $11, $12, now())
     ON CONFLICT (dashboard_id, source_key) DO UPDATE SET
       frequency = EXCLUDED.frequency,
       interval_minutes = EXCLUDED.interval_minutes,
       at_time = EXCLUDED.at_time,
       days_of_week = EXCLUDED.days_of_week,
       day_of_month = EXCLUDED.day_of_month,
       enabled = EXCLUDED.enabled,
       next_run_at = EXCLUDED.next_run_at,
       updated_by_id = EXCLUDED.updated_by_id,
       timezone = EXCLUDED.timezone,
       window_start = EXCLUDED.window_start,
       window_end = EXCLUDED.window_end,
       updated_at = now()`,
    args.dashboardSlug,
    args.sourceKey ?? DEFAULT_SOURCE_KEY,
    s.frequency,
    s.intervalMinutes,
    s.atTime,
    s.daysOfWeekStr,
    s.dayOfMonth,
    args.enabled ?? true,
    args.updatedById,
    s.timezone,
    s.windowStart,
    s.windowEnd,
    // The first refresh waits for a future start date (GREATEST ignores NULL).
    args.startsAt ?? null,
  );
}

export class GoLiveError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "GoLiveError";
  }
}

type RefineHistoryEntry = { instruction: string; jobId: string; at: string; by: string | null };

/** Insert the next `dashboard_versions` row (version_no = max + 1) and return it. */
async function insertDashboardVersion(
  db: SqlClient,
  args: {
    dashboardId: string;
    program: unknown;
    templateHtml: string;
    kpis: unknown;
    scope: unknown;
    refineHistory: RefineHistoryEntry[];
    jobId: string | null;
    adminId: string;
  },
): Promise<{ id: string; version_no: number }> {
  const [version] = await db.$queryRawUnsafe<{ id: string; version_no: number }[]>(
    `INSERT INTO dashboard_versions
       (id, dashboard_id, version_no, program, template_html, kpis, connection_scope, refine_history, created_from_job_id, approved_by_id, created_at)
     VALUES (gen_random_uuid()::text, $1,
             (SELECT COALESCE(MAX(version_no), 0) + 1 FROM dashboard_versions WHERE dashboard_id = $1),
             $2::jsonb, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, now())
     RETURNING id, version_no`,
    args.dashboardId,
    JSON.stringify(args.program),
    args.templateHtml,
    JSON.stringify(args.kpis),
    JSON.stringify(args.scope),
    JSON.stringify(args.refineHistory),
    args.jobId,
    args.adminId,
  );
  if (!version) throw new GoLiveError("Could not record the dashboard version.", 500);
  return { id: version.id, version_no: Number(version.version_no) };
}

// ── Go-live ──────────────────────────────────────────────────────────────────

export type GoLiveInput = {
  requestId: string;
  jobId: string;
  adminId: string;
  visibleToAll: boolean;
  roleIds: string[];
  userIds: string[];
};

export type GoLiveResult = {
  mode: "create" | "extend";
  dashboardId: string;
  slug: string;
  title: string;
  versionId: string;
  versionNo: number;
  requesterId: string;
  expiresAt: Date | null;
  schedule: ScheduleInput;
  refineCount: number;
};

type RequestRow = {
  id: string;
  requester_id: string;
  title: string;
  kpis: unknown;
  status: string;
  decision: unknown;
  dashboard_id: string | null;
};

type JobRow = {
  id: string;
  kind: string;
  request_id: string | null;
  dashboard_id: string | null;
  status: string;
  connection_scope: unknown;
  result_program: unknown;
  result_template: string | null;
  result_kpis: unknown;
  created_at: Date;
};

function asDecision(v: unknown): RequestDecision | null {
  if (!v || typeof v !== "object") return null;
  const d = v as Partial<RequestDecision>;
  if (d.mode !== "create" && d.mode !== "extend") return null;
  if (!d.schedule || typeof d.schedule !== "object") return null;
  return {
    mode: d.mode,
    targetDashboardId: d.targetDashboardId ?? null,
    connectionScope: (d.connectionScope as ConnectionScope) ?? { mode: "all" },
    schedule: d.schedule as ScheduleInput,
    expiresAt: typeof d.expiresAt === "string" ? d.expiresAt : null,
    decidedById: String(d.decidedById ?? ""),
    decidedAt: String(d.decidedAt ?? ""),
    note: d.note ?? null,
    startsAt: typeof d.startsAt === "string" ? d.startsAt : null,
    autoPublish: d.autoPublish === true,
    visibility: d.visibility && typeof d.visibility === "object" ? (d.visibility as VisibilityInput) : undefined,
    requested: d.requested,
  };
}

const uniq = (xs: string[]) => [...new Set(xs.filter((x) => typeof x === "string" && x.trim()))];

/**
 * Publish a compile result: create (or extend) the dashboard, add a version,
 * point `current_version_id` at it, activate the schedule and mark the request
 * live. Must run inside one transaction (the caller passes the tx client).
 * Throws `GoLiveError` (400/404/409) on any precondition failure.
 */
export async function goLive(db: SqlClient, input: GoLiveInput): Promise<GoLiveResult> {
  const [request] = await db.$queryRawUnsafe<RequestRow[]>(
    `SELECT id, requester_id, title, kpis, status, decision, dashboard_id FROM dashboard_requests WHERE id = $1`,
    input.requestId,
  );
  if (!request) throw new GoLiveError("Request not found.", 404);
  if (["live", "denied", "cancelled"].includes(request.status)) {
    throw new GoLiveError(`This request is already ${request.status}.`, 409);
  }
  const decision = asDecision(request.decision);
  if (!decision) throw new GoLiveError("The request has no approval decision yet.", 409);

  const [job] = await db.$queryRawUnsafe<JobRow[]>(
    `SELECT id, kind, request_id, dashboard_id, status, connection_scope, result_program, result_template, result_kpis, created_at
       FROM dashboard_compile_jobs WHERE id = $1`,
    input.jobId,
  );
  if (!job || job.request_id !== request.id) throw new GoLiveError("That compile job does not belong to this request.", 404);
  if (job.status !== "preview_ready") throw new GoLiveError("Only a compile job with a ready preview can go live.", 409);
  if (!job.result_program || !job.result_template) throw new GoLiveError("The compile job has no program or template to publish.", 409);

  const [newest] = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM dashboard_compile_jobs WHERE request_id = $1 AND status = 'preview_ready' ORDER BY created_at DESC LIMIT 1`,
    request.id,
  );
  if (!newest || newest.id !== job.id) throw new GoLiveError("A newer compile result exists; publish the latest preview.", 409);

  const kpis = job.result_kpis ?? request.kpis ?? [];
  const scope = job.connection_scope ?? decision.connectionScope ?? { mode: "all" };
  const expiresAt = decision.expiresAt ? new Date(decision.expiresAt) : null;
  const userIds = uniq([...input.userIds, request.requester_id]);
  const roleIds = uniq(input.roleIds);

  let dashboardId: string;
  let slug: string;
  let title = request.title;

  if (decision.mode === "extend") {
    if (!decision.targetDashboardId) throw new GoLiveError("The approval has no target dashboard to extend.", 409);
    const [target] = await db.$queryRawUnsafe<{ id: string; slug: string; title: string }[]>(
      `SELECT id, slug, title FROM dashboards WHERE id = $1`,
      decision.targetDashboardId,
    );
    if (!target) throw new GoLiveError("The dashboard to extend no longer exists.", 404);
    dashboardId = target.id;
    slug = target.slug;
    title = target.title;
  } else if (request.dashboard_id && (await dashboardExists(db, request.dashboard_id))) {
    // Pinned straight to live: the dashboard already exists, showing the pinned
    // snapshot while the compile ran. Publish into it rather than a second one.
    const [existing] = await db.$queryRawUnsafe<{ id: string; slug: string; title: string }[]>(
      `SELECT id, slug, title FROM dashboards WHERE id = $1`,
      request.dashboard_id,
    );
    dashboardId = existing.id;
    slug = existing.slug;
    title = existing.title;
  } else {
    const [created] = await db.$queryRawUnsafe<{ id: string; slug: string }[]>(
      `INSERT INTO dashboards
         (id, slug, title, kind, status, kpis, visible_to_all, visibility_role_ids, visibility_user_ids,
          connection_scope, expires_at, source_request_id, created_by_id, requester_id, created_at, updated_at)
       SELECT g.new_id, 'custom-' || left(g.new_id, 8), $1, 'custom', 'live', $2::jsonb, $3, $4::jsonb, $5::jsonb,
              $6::jsonb, $7::timestamptz, $8, $9, $10, now(), now()
         FROM (SELECT gen_random_uuid()::text AS new_id) g
       RETURNING id, slug`,
      request.title,
      JSON.stringify(kpis),
      input.visibleToAll,
      JSON.stringify(roleIds),
      JSON.stringify(userIds),
      JSON.stringify(scope),
      expiresAt,
      request.id,
      input.adminId,
      request.requester_id,
    );
    if (!created) throw new GoLiveError("Could not create the dashboard.", 500);
    dashboardId = created.id;
    slug = created.slug;
  }

  // Refine history = every successful refine job for this request up to the one being published.
  const refines = await db.$queryRawUnsafe<{ id: string; instruction: string | null; created_at: Date; created_by_id: string | null }[]>(
    `SELECT id, instruction, created_at, created_by_id FROM dashboard_compile_jobs
      WHERE request_id = $1 AND kind = 'refine' AND status = 'preview_ready' AND created_at <= $2
      ORDER BY created_at ASC`,
    request.id,
    job.created_at,
  );
  const refineHistory: RefineHistoryEntry[] = refines.map((r) => ({
    instruction: r.instruction ?? "",
    jobId: r.id,
    at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    by: r.created_by_id,
  }));

  const version = await insertDashboardVersion(db, {
    dashboardId,
    program: job.result_program,
    templateHtml: job.result_template,
    kpis,
    scope,
    refineHistory,
    jobId: job.id,
    adminId: input.adminId,
  });

  await db.$executeRawUnsafe(
    `UPDATE dashboards
        SET current_version_id = $1, kpis = $2::jsonb, status = 'live', connection_scope = $3::jsonb,
            expires_at = $4::timestamptz,
            visible_to_all = $5, visibility_role_ids = $6::jsonb, visibility_user_ids = $7::jsonb,
            updated_at = now()
      WHERE id = $8`,
    version.id,
    JSON.stringify(kpis),
    JSON.stringify(scope),
    expiresAt,
    input.visibleToAll,
    JSON.stringify(roleIds),
    JSON.stringify(userIds),
    dashboardId,
  );

  await upsertReportSchedule(db, {
    dashboardSlug: slug,
    schedule: decision.schedule,
    updatedById: input.adminId,
    startsAt: decision.startsAt ? new Date(decision.startsAt) : null,
  });

  await db.$executeRawUnsafe(
    `UPDATE dashboard_requests SET status = 'live', dashboard_id = $1, updated_at = now() WHERE id = $2`,
    dashboardId,
    request.id,
  );

  return {
    mode: decision.mode,
    dashboardId,
    slug,
    title,
    versionId: version.id,
    versionNo: version.version_no,
    requesterId: request.requester_id,
    expiresAt,
    schedule: decision.schedule,
    refineCount: refineHistory.length,
  };
}

async function dashboardExists(db: SqlClient, id: string): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM dashboards WHERE id = $1`, id);
  return rows.length > 0;
}

// ── Pinned dashboards (the one-step Pin dialog) ─────────────────────────────

export type PinnedDashboardInput = {
  requestId: string;
  title: string;
  html: string;
  kpis: unknown;
  scope: ConnectionScope;
  expiresAt: Date | null;
  visibility: VisibilityInput;
  adminId: string;
  requesterId: string;
  /** When the pinned data was captured (shown as "last refreshed"). */
  snapshotAt: Date;
};

/**
 * Create a live dashboard whose content is the pinned chat dashboard itself: no
 * version, no program — the pinned HTML is its snapshot. A static pin stays like
 * this; a scheduled pin shows it until its compile is published into the same
 * dashboard (goLive reuses `dashboard_requests.dashboard_id`). Links the request.
 */
export async function createPinnedDashboard(db: SqlClient, input: PinnedDashboardInput): Promise<{ id: string; slug: string }> {
  const v = visibilityValues(input.visibility, input.requesterId);
  const [created] = await db.$queryRawUnsafe<{ id: string; slug: string }[]>(
    `INSERT INTO dashboards
       (id, slug, title, kind, status, kpis, visible_to_all, visibility_role_ids, visibility_user_ids,
        connection_scope, expires_at, source_request_id, created_by_id, requester_id,
        cached_html, refreshed_at, created_at, updated_at)
     SELECT g.new_id, 'custom-' || left(g.new_id, 8), $1, 'custom', 'live', $2::jsonb, $3, $4::jsonb, $5::jsonb,
            $6::jsonb, $7::timestamptz, $8, $9, $10, $11, $12::timestamptz, now(), now()
       FROM (SELECT gen_random_uuid()::text AS new_id) g
     RETURNING id, slug`,
    input.title,
    JSON.stringify(input.kpis ?? []),
    v.visibleToAll,
    JSON.stringify(v.roleIds),
    JSON.stringify(v.userIds),
    JSON.stringify(input.scope),
    input.expiresAt,
    input.requestId,
    input.adminId,
    input.requesterId,
    input.html,
    input.snapshotAt,
  );
  if (!created) throw new GoLiveError("Could not create the dashboard.", 500);
  await db.$executeRawUnsafe(`UPDATE dashboard_requests SET dashboard_id = $1, updated_at = now() WHERE id = $2`, created.id, input.requestId);
  return created;
}

/**
 * Approve a request as a STATIC dashboard: publish the pinned snapshot as is (no
 * compile, no schedule, never refreshed) and mark the request live.
 */
export async function publishStaticRequest(
  db: SqlClient,
  input: { requestId: string; adminId: string; visibility: VisibilityInput; requested?: unknown },
): Promise<{ dashboardId: string; slug: string; title: string; requesterId: string }> {
  const [r] = await db.$queryRawUnsafe<{ id: string; title: string; html: string; kpis: unknown; requester_id: string; status: string; created_at: Date; decision: unknown }[]>(
    `SELECT id, title, html, kpis, requester_id, status, created_at, decision FROM dashboard_requests WHERE id = $1`,
    input.requestId,
  );
  if (!r) throw new GoLiveError("Request not found.", 404);
  if (["live", "cancelled"].includes(r.status)) throw new GoLiveError(`This request is already ${r.status}.`, 409);
  const created = await createPinnedDashboard(db, {
    requestId: r.id,
    title: r.title,
    html: r.html,
    kpis: r.kpis,
    scope: { mode: "all" },
    expiresAt: null,
    visibility: input.visibility,
    adminId: input.adminId,
    requesterId: r.requester_id,
    snapshotAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
  });
  const previous = (r.decision && typeof r.decision === "object" ? r.decision : {}) as Record<string, unknown>;
  const decision = {
    type: "static",
    mode: "create",
    targetDashboardId: null,
    visibility: input.visibility,
    requested: input.requested ?? previous.requested ?? null,
    decidedById: input.adminId,
    decidedAt: new Date().toISOString(),
    note: null,
  };
  await db.$executeRawUnsafe(
    `UPDATE dashboard_requests
        SET status = 'live', decision = $1::jsonb, decided_by_id = $2, decided_at = now(), updated_at = now()
      WHERE id = $3`,
    JSON.stringify(decision),
    input.adminId,
    r.id,
  );
  return { dashboardId: created.id, slug: created.slug, title: r.title, requesterId: r.requester_id };
}

/** Where the requester opens their dashboards (Fab Orchestrator's /reports). */
function reportsUrl(): string {
  const base = process.env.APP_URL || "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/reports`;
}

/**
 * Email the requester that their dashboard is live. Returns false when SMTP is
 * not configured or the requester has no email; never throws.
 */
export async function sendDashboardLiveEmail(
  db: SqlClient,
  result: Pick<GoLiveResult, "requesterId" | "title" | "mode" | "expiresAt" | "schedule">,
  send: (p: { to: string; subject: string; html: string }) => Promise<boolean> = sendSmtpEmail,
): Promise<boolean> {
  try {
    const [user] = await db.$queryRawUnsafe<{ email: string; name: string | null }[]>(
      `SELECT email, name FROM users WHERE id = $1`,
      result.requesterId,
    );
    if (!user?.email) return false;
    const html = buildDashboardLiveEmailHtml({
      requesterName: user.name,
      title: result.title,
      reportsUrl: reportsUrl(),
      mode: result.mode,
      expiresAt: result.expiresAt,
      scheduleText: describeSchedule(result.schedule),
    });
    return await send({ to: user.email, subject: `Your dashboard "${result.title}" is live`, html });
  } catch (e) {
    console.error("[dashboard-service] live email failed", e);
    return false;
  }
}

// ── Dashboard management (B5) ────────────────────────────────────────────────

export type VisibilityInput = { visibleToAll: boolean; roleIds: string[]; userIds: string[] };

type DashboardRow = {
  id: string;
  slug: string;
  title: string;
  status: string;
  current_version_id: string | null;
  kpis: unknown;
  connection_scope: unknown;
  expires_at: Date | null;
  requester_id: string | null;
  visible_to_all: boolean;
  visibility_role_ids: unknown;
  visibility_user_ids: unknown;
};

async function loadDashboard(db: SqlClient, id: string): Promise<DashboardRow> {
  const [d] = await db.$queryRawUnsafe<DashboardRow[]>(
    `SELECT id, slug, title, status, current_version_id, kpis, connection_scope, expires_at, requester_id,
            visible_to_all, visibility_role_ids, visibility_user_ids
       FROM dashboards WHERE id = $1`,
    id,
  );
  if (!d) throw new GoLiveError("Dashboard not found.", 404);
  return d;
}

function visibilityValues(v: VisibilityInput, requesterId: string | null) {
  return {
    visibleToAll: !!v.visibleToAll,
    roleIds: uniq(v.roleIds),
    userIds: uniq([...v.userIds, ...(requesterId ? [requesterId] : [])]),
  };
}

export type UpdateDashboardInput = {
  dashboardId: string;
  adminId: string;
  visibility?: VisibilityInput;
  /** New expiry (already resolved); resets the expiry warning. */
  /** undefined = unchanged; null = no end date; Date = new expiry (must be in the future). */
  expiresAt?: Date | null;
  status?: "live" | "paused";
  now?: Date;
};

export type UpdateDashboardResult = {
  dashboardId: string;
  slug: string;
  title: string;
  changes: Record<string, unknown>;
};

/**
 * Change visibility, expiry and/or status. Pausing disables the report
 * schedule; resuming enables it. Resuming an expired dashboard needs a new
 * expiry in the future (given in the same call).
 */
export async function updateDashboard(db: SqlClient, input: UpdateDashboardInput): Promise<UpdateDashboardResult> {
  const now = input.now ?? new Date();
  const d = await loadDashboard(db, input.dashboardId);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const changes: Record<string, unknown> = {};
  const push = (sql: string, v: unknown) => {
    vals.push(v);
    sets.push(sql.replace("$?", `$${vals.length}`));
  };

  if (input.visibility) {
    const v = visibilityValues(input.visibility, d.requester_id);
    push("visible_to_all = $?", v.visibleToAll);
    push("visibility_role_ids = $?::jsonb", JSON.stringify(v.roleIds));
    push("visibility_user_ids = $?::jsonb", JSON.stringify(v.userIds));
    changes.visibility = v;
  }

  if (input.expiresAt instanceof Date) {
    if (input.expiresAt.getTime() <= now.getTime()) throw new GoLiveError("The new expiry must be in the future.", 400);
    push("expires_at = $?::timestamptz", input.expiresAt);
    sets.push("expiry_warned_at = NULL");
    changes.expiresAt = input.expiresAt.toISOString();
  } else if (input.expiresAt === null && d.expires_at !== null) {
    // Never expires: keeps refreshing until an admin pauses it.
    sets.push("expires_at = NULL");
    sets.push("expiry_warned_at = NULL");
    changes.expiresAt = null;
  }

  let scheduleEnabled: boolean | null = null;
  if (input.status && input.status !== d.status) {
    if (input.status === "live") {
      // null = no end date (always resumable); undefined = keep the stored expiry.
      const effectiveExpiry = input.expiresAt === undefined ? d.expires_at : input.expiresAt;
      if (d.status === "expired" && effectiveExpiry !== null && effectiveExpiry.getTime() <= now.getTime()) {
        throw new GoLiveError("This dashboard has expired; set a new expiry date (or Never) to resume it.", 409);
      }
      scheduleEnabled = true;
    } else {
      scheduleEnabled = false;
    }
    push("status = $?", input.status);
    changes.status = { from: d.status, to: input.status };
  }

  if (!sets.length) return { dashboardId: d.id, slug: d.slug, title: d.title, changes };

  sets.push("updated_at = now()");
  vals.push(d.id);
  await db.$executeRawUnsafe(`UPDATE dashboards SET ${sets.join(", ")} WHERE id = $${vals.length}`, ...vals);

  if (scheduleEnabled !== null) {
    await db.$executeRawUnsafe(
      `UPDATE report_schedules SET enabled = $1, updated_by_id = $2, updated_at = now() WHERE dashboard_id = $3`,
      scheduleEnabled,
      input.adminId,
      d.slug,
    );
    changes.scheduleEnabled = scheduleEnabled;
  }

  return { dashboardId: d.id, slug: d.slug, title: d.title, changes };
}

export type PublishEditInput = {
  dashboardId: string;
  jobId: string;
  adminId: string;
  visibility?: VisibilityInput;
};

export type PublishEditResult = {
  dashboardId: string;
  slug: string;
  title: string;
  versionId: string;
  versionNo: number;
  previousVersionId: string | null;
};

/**
 * Publish a direct-edit (refine) compile job as the next version of a live
 * dashboard. Keeps expiry and schedule; keeps visibility unless given.
 */
export async function publishDashboardEdit(db: SqlClient, input: PublishEditInput): Promise<PublishEditResult> {
  const d = await loadDashboard(db, input.dashboardId);

  const [job] = await db.$queryRawUnsafe<(JobRow & { instruction: string | null; created_by_id: string | null })[]>(
    `SELECT id, kind, request_id, dashboard_id, status, connection_scope, result_program, result_template, result_kpis, created_at, instruction, created_by_id
       FROM dashboard_compile_jobs WHERE id = $1`,
    input.jobId,
  );
  if (!job || job.dashboard_id !== d.id || job.request_id) throw new GoLiveError("That compile job does not belong to this dashboard.", 404);
  if (job.status !== "preview_ready") throw new GoLiveError("Only a compile job with a ready preview can be published.", 409);
  if (!job.result_program || !job.result_template) throw new GoLiveError("The compile job has no program or template to publish.", 409);

  const [newest] = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM dashboard_compile_jobs
      WHERE dashboard_id = $1 AND request_id IS NULL AND status = 'preview_ready'
      ORDER BY created_at DESC LIMIT 1`,
    d.id,
  );
  if (!newest || newest.id !== job.id) throw new GoLiveError("A newer compile result exists; publish the latest preview.", 409);

  const kpis = job.result_kpis ?? d.kpis ?? [];
  const scope = job.connection_scope ?? d.connection_scope ?? { mode: "all" };
  const refineHistory: RefineHistoryEntry[] = [
    {
      instruction: job.instruction ?? "",
      jobId: job.id,
      at: job.created_at instanceof Date ? job.created_at.toISOString() : String(job.created_at),
      by: job.created_by_id,
    },
  ];
  const version = await insertDashboardVersion(db, {
    dashboardId: d.id,
    program: job.result_program,
    templateHtml: job.result_template,
    kpis,
    scope,
    refineHistory,
    jobId: job.id,
    adminId: input.adminId,
  });

  const sets = ["current_version_id = $1", "kpis = $2::jsonb", "connection_scope = $3::jsonb", "updated_at = now()"];
  const vals: unknown[] = [version.id, JSON.stringify(kpis), JSON.stringify(scope)];
  if (input.visibility) {
    const v = visibilityValues(input.visibility, d.requester_id);
    vals.push(v.visibleToAll, JSON.stringify(v.roleIds), JSON.stringify(v.userIds));
    sets.push(`visible_to_all = $${vals.length - 2}`, `visibility_role_ids = $${vals.length - 1}::jsonb`, `visibility_user_ids = $${vals.length}::jsonb`);
  }
  vals.push(d.id);
  await db.$executeRawUnsafe(`UPDATE dashboards SET ${sets.join(", ")} WHERE id = $${vals.length}`, ...vals);

  return { dashboardId: d.id, slug: d.slug, title: d.title, versionId: version.id, versionNo: version.version_no, previousVersionId: d.current_version_id };
}

export type RollbackResult = {
  dashboardId: string;
  slug: string;
  title: string;
  versionId: string;
  versionNo: number;
  previousVersionId: string | null;
};

/** Point `current_version_id` at an older version (and restore its KPIs/scope). */
export async function rollbackDashboard(
  db: SqlClient,
  input: { dashboardId: string; versionId: string; adminId: string },
): Promise<RollbackResult> {
  const d = await loadDashboard(db, input.dashboardId);
  const [v] = await db.$queryRawUnsafe<{ id: string; dashboard_id: string; version_no: number; kpis: unknown; connection_scope: unknown }[]>(
    `SELECT id, dashboard_id, version_no, kpis, connection_scope FROM dashboard_versions WHERE id = $1`,
    input.versionId,
  );
  if (!v || v.dashboard_id !== d.id) throw new GoLiveError("That version does not belong to this dashboard.", 404);
  if (d.current_version_id === v.id) throw new GoLiveError("That version is already current.", 409);

  await db.$executeRawUnsafe(
    `UPDATE dashboards SET current_version_id = $1, kpis = $2::jsonb, connection_scope = $3::jsonb, updated_at = now() WHERE id = $4`,
    v.id,
    JSON.stringify(v.kpis ?? []),
    JSON.stringify(v.connection_scope ?? { mode: "all" }),
    d.id,
  );
  return { dashboardId: d.id, slug: d.slug, title: d.title, versionId: v.id, versionNo: Number(v.version_no), previousVersionId: d.current_version_id };
}

export type SetScheduleResult = {
  dashboardId: string;
  slug: string;
  title: string;
  enabled: boolean;
  description: string;
};

/**
 * Set (or replace) a live dashboard's refresh schedule from the dashboard page.
 * `enabled: false` pauses only the schedule; the dashboard itself stays live.
 * `next_run_at = now()` so Fab Orchestrator's next tick picks it up.
 */
export async function setDashboardSchedule(
  db: SqlClient,
  input: { dashboardId: string; adminId: string; schedule: ScheduleInput; sourceKey?: string },
): Promise<SetScheduleResult> {
  const d = await loadDashboard(db, input.dashboardId);
  await upsertReportSchedule(db, {
    dashboardSlug: d.slug,
    schedule: input.schedule,
    updatedById: input.adminId,
    sourceKey: input.sourceKey,
    enabled: input.schedule.enabled,
  });
  return { dashboardId: d.id, slug: d.slug, title: d.title, enabled: input.schedule.enabled, description: describeSchedule(input.schedule) };
}
