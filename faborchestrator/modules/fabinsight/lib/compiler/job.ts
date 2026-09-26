/**
 * Compile-job runner — claimed by the Fab AI scheduler tick.
 *
 * The admin app inserts `dashboard_compile_jobs` rows (approve → create|extend,
 * refine → refine). Each tick calls `claimCompileJobs()`, which atomically
 * claims up to `max` queued jobs (SKIP LOCKED, so several instances never
 * double-claim) and runs the compiler on them IN THE BACKGROUND: the promise
 * returned here resolves as soon as the claim is done, never after a
 * multi-minute compile, and a module-level guard keeps at most one compile
 * batch in flight per process.
 */

import { prisma } from '@/shared/lib/db';
import { compileDashboard } from './index';
import type { CompileInput, CompileMode } from './types';
import type { TraceStep } from '@/modules/fabinsight/lib/pin/trace';
import { safeParseProgram, type ConnectionScope, type Program } from '@/modules/fabinsight/lib/replay/program';

import { recordCaptured } from '@/shared/lib/errors/capture';
import { goLive, sendDashboardLiveEmail } from '@/modules/admin/lib/dashboards/dashboard-service';
import { FabOrchErrorType } from '@/shared/lib/errors/error-catalog-defaults';


/**
 * Put a compile failure in the error log. The admin watching the request sees
 * the reason on the job row; this is the record behind it, attributed to the
 * admin who approved the request.
 */
function recordCompileFailure(job: Pick<JobRow, 'id' | 'kind' | 'request_id' | 'dashboard_id' | 'created_by_id'>, message: string): void {
  recordCaptured(
    {
      system: 'Dashboard compiler',
      operation: 'compileDashboard',
      type: FabOrchErrorType.LAMBDA_MCP_CRASH,
      // The job id is part of the target: each compile attempt is its own
      // fact, so a re-approved request failing the same way within the repeat
      // window is still recorded (repeat keys include the target).
      target: `${job.request_id ? `request ${job.request_id}` : job.dashboard_id ? `dashboard ${job.dashboard_id}` : 'compile'} · job ${job.id}`,
      userId: job.created_by_id,
      extra: { jobId: job.id, kind: job.kind, requestId: job.request_id, dashboardId: job.dashboard_id },
    },
    new Error(message),
  );
}

/**
 * Move a request to a new status. A failed write here used to be swallowed,
 * which left a request showing "Compiling…" for a job that had long finished.
 */
async function setRequestStatus(requestId: string, status: string, job: Pick<JobRow, 'id' | 'kind' | 'request_id' | 'dashboard_id' | 'created_by_id'>): Promise<void> {
  try {
    await prisma.dashboardRequest.update({ where: { id: requestId }, data: { status } });
  } catch (e) {
    recordCaptured(
      { system: 'Dashboard requests', operation: 'setRequestStatus', type: FabOrchErrorType.LAMBDA_MCP_CRASH, target: `request ${requestId}`, userId: job.created_by_id, extra: { status, jobId: job.id } },
      e,
    );
  }
}

type JobRow = {
  id: string;
  kind: string;
  request_id: string | null;
  dashboard_id: string | null;
  base_version_id: string | null;
  instruction: string | null;
  connection_scope: unknown;
  attempts: number;
  created_by_id: string | null;
};

const STUCK_MINUTES = 15;
const MAX_ATTEMPTS = 2;

let inFlight: Promise<void> | null = null;

/** Requeue jobs whose claim went stale (process died mid-compile), once. */
async function requeueStuck(): Promise<number> {
  const n = await prisma
    .$executeRawUnsafe(
      `UPDATE dashboard_compile_jobs
          SET status = 'queued', claimed_at = NULL
        WHERE status = 'claimed'
          AND claimed_at < now() - ($1 || ' minutes')::interval
          AND attempts < $2`,
      String(STUCK_MINUTES),
      MAX_ATTEMPTS,
    )
    .catch(() => 0);
  // Jobs that exhausted their attempts are failed for good — and so is their
  // request, which otherwise showed "Compiling…" forever with nothing behind it.
  const exhausted = (await prisma
    .$queryRawUnsafe(
      `UPDATE dashboard_compile_jobs
          SET status = 'failed', finished_at = now(),
              error = 'The compile never finished: the process running it stopped ' || attempts || ' time(s) (server restart or crash), so it was abandoned. Approve the request again to retry.'
        WHERE status = 'claimed'
          AND claimed_at < now() - ($1 || ' minutes')::interval
          AND attempts >= $2
        RETURNING id, kind, request_id, dashboard_id, created_by_id, error`,
      String(STUCK_MINUTES),
      MAX_ATTEMPTS,
    )
    .catch(() => [])) as Array<Pick<JobRow, 'id' | 'kind' | 'request_id' | 'dashboard_id' | 'created_by_id'> & { error: string }>;
  for (const j of exhausted) {
    if (j.request_id) await setRequestStatus(j.request_id, 'compile_failed', j);
    recordCompileFailure(j, j.error);
  }
  return typeof n === 'number' ? n : 0;
}

async function claimRows(max: number): Promise<JobRow[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `UPDATE dashboard_compile_jobs
        SET status = 'claimed', claimed_at = now(), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM dashboard_compile_jobs
         WHERE status = 'queued'
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING id, kind, request_id, dashboard_id, base_version_id, instruction, connection_scope, attempts, created_by_id`,
    max,
  )) as JobRow[];
  return rows;
}

function parseScope(v: unknown): ConnectionScope {
  const o = (v ?? {}) as { mode?: string; servers?: unknown };
  if (o.mode === 'fixed') {
    const servers = (Array.isArray(o.servers) ? (o.servers as { registryId?: string; serverUrl?: string }[]) : [])
      .filter((s) => s && typeof s.registryId === 'string')
      .map((s) => ({ registryId: String(s.registryId), serverUrl: String(s.serverUrl ?? '') }));
    if (servers.length) return { mode: 'fixed', servers };
    // The admin chose SPECIFIC servers. Quietly compiling against every server
    // instead would build the dashboard from data they did not approve.
    throw new Error('The approved server scope names no valid servers. Open the request, choose the servers again, and re-approve.');
  }
  return { mode: 'all' };
}

function parseStoredProgram(v: unknown): Program | null {
  const r = safeParseProgram(v);
  return r.ok ? r.program : null;
}

async function audit(action: string, targetId: string, metadata: Record<string, unknown>, userId: string | null = null): Promise<void> {
  await prisma
    .$executeRawUnsafe(
      `INSERT INTO audit_logs (id, user_id, action, target_type, target_id, metadata, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, 'DashboardCompileJob', $3, $4::jsonb, now())`,
      userId,
      action,
      targetId,
      JSON.stringify(metadata),
    )
    .catch(() => {});
}

/** Gather everything a job needs into a CompileInput. */
async function buildInput(job: JobRow): Promise<{ input: CompileInput; requestId: string | null }> {
  const mode = (['create', 'extend', 'refine'].includes(job.kind) ? job.kind : 'create') as CompileMode;
  const scope = parseScope(job.connection_scope);

  const request = job.request_id
    ? await prisma.dashboardRequest.findUnique({
        where: { id: job.request_id },
        select: { id: true, title: true, reason: true, html: true, kpis: true, trace: true, decision: true, createdAt: true },
      })
    : null;

  const decision = (request?.decision ?? {}) as { schedule?: { timezone?: string } };
  const timezone = decision.schedule?.timezone || 'UTC';

  // Base program/template: an explicit base version, else the target dashboard's
  // current version, else (pre-live refine) the newest preview_ready job of the request.
  let base: CompileInput['base'];
  const versionId =
    job.base_version_id ??
    (job.dashboard_id
      ? (await prisma.dashboard.findUnique({ where: { id: job.dashboard_id }, select: { currentVersionId: true } }))?.currentVersionId ?? null
      : null);
  if (versionId) {
    const v = await prisma.dashboardVersion.findUnique({ where: { id: versionId }, select: { program: true, templateHtml: true } });
    const program = v ? parseStoredProgram(v.program) : null;
    if (v && program) base = { program, templateHtml: v.templateHtml };
  }
  if (!base && job.request_id && mode !== 'create') {
    const prev = await prisma.dashboardCompileJob.findFirst({
      where: { requestId: job.request_id, status: 'preview_ready', id: { not: job.id } },
      orderBy: { createdAt: 'desc' },
      select: { resultProgram: true, resultTemplate: true },
    });
    const program = prev ? parseStoredProgram(prev.resultProgram) : null;
    if (prev && program && prev.resultTemplate) base = { program, templateHtml: prev.resultTemplate };
  }

  // Earlier refine instructions on the same request / dashboard, oldest first.
  const history = (
    await prisma.dashboardCompileJob.findMany({
      where: {
        kind: 'refine',
        id: { not: job.id },
        status: 'preview_ready',
        ...(job.request_id ? { requestId: job.request_id } : job.dashboard_id ? { dashboardId: job.dashboard_id } : { id: '__none__' }),
      },
      orderBy: { createdAt: 'asc' },
      select: { instruction: true },
    })
  )
    .map((j) => j.instruction)
    .filter((s): s is string => !!s);

  // Trace for a dashboard edit with no request: reuse the source request's trace when there is one.
  let trace = (request?.trace as TraceStep[] | undefined) ?? [];
  let html = request?.html ?? '';
  let kpis = (request?.kpis as CompileInput['kpis'] | undefined) ?? [];
  let reason = request?.reason ?? '';
  let title = request?.title;
  if (!request && job.dashboard_id) {
    const dash = await prisma.dashboard.findUnique({ where: { id: job.dashboard_id }, select: { title: true, kpis: true, sourceRequestId: true, cachedHtml: true } });
    title = dash?.title;
    kpis = (dash?.kpis as CompileInput['kpis'] | undefined) ?? [];
    if (dash?.sourceRequestId) {
      const src = await prisma.dashboardRequest.findUnique({ where: { id: dash.sourceRequestId }, select: { trace: true, html: true, reason: true } });
      trace = (src?.trace as TraceStep[] | undefined) ?? [];
      html = src?.html ?? '';
      reason = src?.reason ?? '';
    }
    if (!html) html = dash?.cachedHtml ?? base?.templateHtml ?? '';
  }

  return {
    requestId: request?.id ?? null,
    input: {
      mode,
      trace,
      html,
      kpis,
      reason,
      scope,
      timezone,
      capturedAt: request?.createdAt ?? undefined,
      base,
      instruction: job.instruction ?? undefined,
      history,
      title,
    },
  };
}

async function runJob(job: JobRow): Promise<'done' | 'failed'> {
  let requestId: string | null = job.request_id;
  /*
   * Progress writes are fire-and-forget, and the final result lands in the
   * SAME column (usage). A progress write still in flight when the compile
   * ended could land AFTER the result and replace the real token totals with
   * a stale {progress}. So: stop accepting progress when the compile ends, and
   * wait for the last write before writing the result.
   */
  let progressClosed = false;
  let progressWrite: Promise<unknown> = Promise.resolve();
  const closeProgress = async () => {
    progressClosed = true;
    await progressWrite.catch(() => {});
  };
  try {
    const built = await buildInput(job);
    requestId = built.requestId;
    if (requestId) await setRequestStatus(requestId, 'compiling', job);

    /*
     * Persist live progress so the admin app can show it.
     *
     * The compile runs here, in the Fab process; the admin watching it runs in
     * the other app. The only thing they share is this row, so the progress goes
     * onto it. It is written into `usage` (already JSONB, already this job's
     * "how much did it take" field) under a `progress` key, which needs no
     * migration and is replaced by the real usage totals when the compile ends.
     *
     * Throttled to one write per second: a step lands every ~2.5s, so nothing is
     * lost, and a fast model can't turn progress into a write storm. Failures are
     * swallowed — a dropped progress write must never affect the compile.
     */
    let lastProgressAt = 0;
    let progressInFlight = false;
    built.input.onProgress = (p) => {
      if (progressClosed) return;
      const now = Date.now();
      const isFinal = p.phase === 'finishing';
      if (!isFinal && (progressInFlight || now - lastProgressAt < 1000)) return;
      lastProgressAt = now;
      progressInFlight = true;
      // CHAINED onto the previous write, so writes land in order and
      // closeProgress() waits for all of them — the 'finishing' write skips
      // the throttle, and replacing the promise let an earlier write land after
      // the result.
      progressWrite = progressWrite
        .then(() => {
          if (progressClosed) return;
          return prisma.dashboardCompileJob.update({ where: { id: job.id }, data: { usage: { progress: p } } });
        })
        .catch(() => {})
        .finally(() => {
          progressInFlight = false;
        });
    };

    const out = await compileDashboard(built.input);
    await closeProgress();

    if (out.ok) {
      const kpis = out.program.kpis.map((k) => ({ label: k.label, key: k.label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), unit: k.unit ?? null, path: k.path }));
      await prisma.dashboardCompileJob.update({
        where: { id: job.id },
        data: {
          status: 'preview_ready',
          finishedAt: new Date(),
          resultProgram: JSON.parse(JSON.stringify(out.program)),
          resultTemplate: out.templateHtml,
          resultHtml: out.verify.html,
          resultKpis: kpis,
          resultNotes: out.notes,
          usage: out.usage,
          error: null,
        },
      });
      if (requestId) await setRequestStatus(requestId, 'preview_ready', job);
      if (requestId) await publishIfAutomatic(requestId, job);
      await audit('dashboard.compile_ready', job.id, {
        jobId: job.id,
        kind: job.kind,
        requestId,
        dashboardId: job.dashboard_id,
        calls: out.program.calls.length,
        kpis: kpis.length,
        notes: out.notes.slice(0, 10),
        usage: out.usage,
        perServer: out.verify.perServer.map((s) => ({ server: s.label, ok: s.ok, reason: s.reason ?? null })),
      });
      return 'done';
    }

    await prisma.dashboardCompileJob.update({
      where: { id: job.id },
      // `{}` when there is no usage: clears the last progress snapshot, which
      // the admin panel would otherwise keep showing for a finished job.
      data: { status: 'failed', finishedAt: new Date(), error: out.error.slice(0, 1000), resultNotes: out.notes, usage: out.usage ?? {} },
    });
    if (requestId) await setRequestStatus(requestId, 'compile_failed', job);
    await audit('dashboard.compile_failed', job.id, { jobId: job.id, kind: job.kind, requestId, dashboardId: job.dashboard_id, error: out.error, usage: out.usage ?? null });
    recordCompileFailure(job, out.error);
    return 'failed';
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
    await closeProgress();
    await prisma.dashboardCompileJob
      .update({ where: { id: job.id }, data: { status: 'failed', finishedAt: new Date(), error: msg, usage: {} } })
      .catch(() => {});
    if (requestId) await setRequestStatus(requestId, 'compile_failed', job);
    await audit('dashboard.compile_failed', job.id, { jobId: job.id, kind: job.kind, requestId, dashboardId: job.dashboard_id, error: msg });
    recordCompileFailure(job, msg);
    return 'failed';
  }
}

/**
 * A pin that was approved to go live without a review step (an admin's own pin,
 * or an approval with "publish when ready") is published here, into the
 * dashboard that has been showing the pinned snapshot, with the schedule, dates
 * and visibility chosen at pin time. A failure leaves the preview ready for an
 * admin to publish by hand and is recorded in the error log.
 */
async function publishIfAutomatic(requestId: string, job: JobRow): Promise<void> {
  try {
    const req = await prisma.dashboardRequest.findUnique({ where: { id: requestId }, select: { decision: true, requesterId: true, decidedById: true } });
    const d = (req?.decision ?? {}) as { autoPublish?: unknown; visibility?: { visibleToAll?: unknown; roleIds?: unknown; userIds?: unknown }; decidedById?: unknown };
    if (!req || d.autoPublish !== true) return;
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const adminId = (typeof d.decidedById === 'string' && d.decidedById) || req.decidedById || job.created_by_id || req.requesterId;
    const visibility = { visibleToAll: d.visibility?.visibleToAll !== false, roleIds: ids(d.visibility?.roleIds), userIds: ids(d.visibility?.userIds) };
    const result = await prisma.$transaction((tx) => goLive(tx, { requestId, jobId: job.id, adminId, ...visibility }));
    // The person who pinned it hears it is live — unless they approved it themselves.
    const emailed = result.requesterId !== adminId ? await sendDashboardLiveEmail(prisma, result) : false;
    await prisma.auditLog
      .create({
        data: {
          userId: adminId,
          action: 'report.dashboard_live',
          targetType: 'Dashboard',
          targetId: requestId,
          metadata: JSON.parse(JSON.stringify({ requestId, dashboardId: result.dashboardId, slug: result.slug, title: result.title, mode: result.mode, versionId: result.versionId, versionNo: result.versionNo, jobId: job.id, automatic: true, ...visibility, expiresAt: result.expiresAt?.toISOString() ?? null, emailed })),
        },
      })
      .catch(() => {});
  } catch (e) {
    recordCaptured(
      { system: 'Dashboard publishing', operation: 'publishIfAutomatic', type: FabOrchErrorType.SQL_CALL_FAILURE, target: `request ${requestId} · job ${job.id}`, userId: job.created_by_id, extra: { jobId: job.id, requestId } },
      e,
    );
  }
}

export type ClaimResult = { claimed: number; done: number; failed: number; requeued: number; skipped?: 'in-flight' };

/**
 * Claim up to `max` queued compile jobs and run them in the background.
 * Resolves right after the claim; `done`/`failed` in the result are always 0
 * because the compiles are still running (their outcome lands on the job rows
 * and in audit_logs). Returns `skipped: 'in-flight'` when a batch is already running.
 */
export async function claimCompileJobs(opts: { max?: number } = {}): Promise<ClaimResult> {
  if (inFlight) return { claimed: 0, done: 0, failed: 0, requeued: 0, skipped: 'in-flight' };
  const requeued = await requeueStuck();
  const jobs = await claimRows(Math.max(1, Math.min(opts.max ?? 2, 5)));
  if (!jobs.length) return { claimed: 0, done: 0, failed: 0, requeued };

  inFlight = (async () => {
    for (const job of jobs) {
      const outcome = await runJob(job);
      console.log(`[compile] job ${job.id} (${job.kind}) ${outcome}`);
    }
  })()
    .catch((e) => {
      console.error('[compile] batch failed:', e instanceof Error ? e.message : e);
      recordCaptured({ system: 'Dashboard compiler', operation: 'compileBatch', type: FabOrchErrorType.LAMBDA_MCP_CRASH, extra: { jobs: jobs.map((j) => j.id) } }, e);
    })
    .finally(() => {
      inFlight = null;
    });

  return { claimed: jobs.length, done: 0, failed: 0, requeued };
}
