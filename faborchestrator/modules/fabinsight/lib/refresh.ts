/**
 * Refresh dashboards by replaying their compiled program through the MCP client
 * and caching the rendered snapshot on the `dashboards` row.
 *
 * No SQL, no database sockets: a dashboard's current version holds a declarative
 * replay program + an HTML template with `data-fab-*` markers (see
 * lib/fabinsight/replay). `runProgram` resolves each server in the program's
 * scope to an MCP connection, makes the calls, and fills the template.
 *
 * Failure policy (unchanged from the previous scheduler): when EVERY call fails
 * the last good snapshot is KEPT — cachedHtml/cachedSummary/refreshedAt are not
 * touched, only lastStatus flips to "stale: …". Partial failures (one server of
 * several down, one call drifting) still write the snapshot and record the
 * detail in perServerStatus / lastStatus so the UI can show it.
 */

import { prisma } from "@/shared/lib/db";
import { claimDueSchedules } from "@/modules/fabinsight/lib/schedule";
import { resolveAlertRecipients } from "@/modules/fabinsight/lib/alert-recipients";
import { sendMail } from "@/modules/fabinsight/lib/mailer";
import { runProgram, safeParseProgram, numericColumns, type RunResult } from "@/modules/fabinsight/lib/replay";
import { recordCaptured } from "@/shared/lib/errors/capture";
import { runWithErrorContext } from "@/shared/lib/errors/run-context";
import { esc } from "@/modules/fabinsight/lib/html-escape";


export type RefreshOutcome = {
  ok: boolean;
  /** Human-readable reason when not ok, or the partial-failure detail. */
  error?: string;
  /** Every server failed — snapshot kept. */
  unreachable?: boolean;
  /** Some servers / calls failed but a snapshot was written. */
  partial?: boolean;
  run?: RunResult;
};

type DashboardRow = {
  id: string;
  slug: string;
  title: string;
  status: string;
  currentVersionId: string | null;
};

const DASH_SELECT = { id: true, slug: true, title: true, status: true, currentVersionId: true } as const;

/** What went wrong on one server, in words — never a blanket "unreachable". */
function whyWords(reason: string | undefined): string {
  return reason === "no-connection" ? "not connected"
    : reason === "missing-tool" ? "tool missing"
    : reason === "timeout" ? "timed out"
    : "failed";
}

/**
 * Summarise a run's per-server outcome as the `lastStatus` text.
 *
 * The `stale:` / `partial:` / `ok` prefixes are parsed by the snapshot banner
 * and must stay. What follows them is the real cause: it used to say
 * "unreachable" for every failure, including a login rejected or a query the
 * source refused, which sent people to check the network when the network
 * was fine. A server that answered but lost some calls is partial too.
 */
export function statusLine(run: Pick<RunResult, "perServer" | "drift" | "allFailed">): string {
  if (run.allFailed) {
    const first = run.perServer.find((s) => !s.ok);
    if (!first) return "stale: source unreachable";
    return `stale: ${first.label} ${whyWords(first.reason)}${first.error ? ` — ${first.error.slice(0, 160)}` : ""}`;
  }
  const bits: string[] = [];
  for (const s of run.perServer) {
    if (!s.ok) bits.push(`${s.label} ${whyWords(s.reason)}${s.error ? ` — ${s.error.slice(0, 120)}` : ""}`);
    else if (s.failedCalls) bits.push(`${s.label}: ${s.error ?? `${s.failedCalls} call(s) failed`}`.slice(0, 160));
  }
  if (run.drift.length) bits.push(`shape drift ${run.drift[0]}${run.drift.length > 1 ? ` (+${run.drift.length - 1})` : ""}`);
  return bits.length ? `partial: ${bits.join("; ")}` : "ok";
}

/**
 * Put a refresh failure in the error log, with its real cause.
 *
 * These used to reach `audit_logs` only (a scheduled run) or nothing at all (a
 * manual refresh), so the error log never showed a dashboard failing. The
 * running job's context (lib/errors/run-context) attributes it to the schedule
 * and the admin who set it; repeats from the scheduler's heartbeat are
 * suppressed there, not here.
 */
function recordRefreshFailure(dash: DashboardRow, message: string, run?: RunResult, userId?: string | null): void {
  const failing = run?.perServer.filter((s) => !s.ok || s.failedCalls) ?? [];
  recordCaptured(
    {
      system: failing.length ? failing.map((s) => s.label).join(", ") : "Dashboard refresh",
      operation: "refreshDashboard",
      target: `dashboard ${dash.slug}`,
      userId: userId ?? null,
      extra: {
        dashboardId: dash.id,
        dashboard: dash.title,
        ...(failing.length ? { servers: failing.map((s) => ({ server: s.label, reason: s.reason ?? "partial", error: s.error })) } : {}),
      },
    },
    new Error(message),
  );
}

/**
 * Replay one dashboard's current version and cache the result.
 * `now` is injectable for tests; `exec`/`resolveServers` pass through to the runtime.
 */
export async function refreshDashboard(
  dash: DashboardRow,
  opts: {
    now?: Date;
    ctx?: Parameters<typeof runProgram>[2];
    userId?: string | null;
    /** Write failures to the error log (default). Set false only for dry runs. */
    record?: boolean;
  } = {},
): Promise<RefreshOutcome> {
  const now = opts.now ?? new Date();
  // Explicit, not inferred from `ctx`: a real caller passing its own exec or
  // resolver must not silently stop recording failures.
  const record = opts.record !== false;
  const fail = async (msg: string): Promise<RefreshOutcome> => {
    await prisma.dashboard.update({ where: { id: dash.id }, data: { lastStatus: `error: ${msg.slice(0, 300)}` } }).catch(() => {});
    if (record) recordRefreshFailure(dash, `Dashboard "${dash.title}" could not refresh: ${msg}`, undefined, opts.userId);
    return { ok: false, error: msg };
  };

  try {
    if (!dash.currentVersionId) return fail("no live version");
    const version = await prisma.dashboardVersion.findUnique({
      where: { id: dash.currentVersionId },
      select: { program: true, templateHtml: true },
    });
    if (!version) return fail("version not found");

    const parsed = safeParseProgram(version.program);
    if (!parsed.ok) return fail(`invalid program: ${parsed.errors[0] ?? "schema"}`);

    const run = await runProgram(parsed.program, version.templateHtml, { now, ...(opts.ctx ?? {}) });
    const perServerStatus = Object.fromEntries(
      run.perServer.map((s) => [s.registryId || s.serverUrl, s.ok ? "ok" : `${s.reason ?? "error"}${s.error ? `: ${s.error.slice(0, 200)}` : ""}`]),
    );

    if (run.allFailed) {
      // Every server failed — keep the last good snapshot untouched.
      const line = statusLine(run);
      await prisma.dashboard
        .update({ where: { id: dash.id }, data: { lastStatus: line, perServerStatus } })
        .catch(() => {});
      const first = run.perServer.find((s) => !s.ok);
      if (record) recordRefreshFailure(dash, `Dashboard "${dash.title}" did not refresh — the last good snapshot was kept. ${line.replace(/^stale: /, "")}`, run, opts.userId);
      return { ok: false, unreachable: true, error: first?.error ?? line, run };
    }

    const line = statusLine(run);
    await prisma.dashboard.update({
      where: { id: dash.id },
      data: {
        cachedHtml: run.html,
        cachedSummary: run.summary,
        cachedSets: JSON.parse(JSON.stringify(run.sets)),
        metricColumns: numericColumns(run.sets),
        refreshedAt: now,
        lastStatus: line,
        perServerStatus,
      },
    });
    const partial = line !== "ok";
    // Refreshed, but with blank panels: a real failure for whoever reads it.
    if (partial && record) recordRefreshFailure(dash, `Dashboard "${dash.title}" refreshed with missing data: ${line.replace(/^partial: /, "")}`, run, opts.userId);
    return { ok: true, partial, error: partial ? line : undefined, run };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "refresh failed");
  }
}

/** Refresh the dashboard behind a schedule row (schedules key on the dashboard slug). */
export async function refreshDashboardBySlug(slug: string): Promise<{ refreshed: number; failed: number; unreachable: number; partial?: number; reason?: string; title?: string; skipped?: string }> {
  const dash = await prisma.dashboard.findUnique({ where: { slug }, select: DASH_SELECT });
  if (!dash) return { refreshed: 0, failed: 0, unreachable: 0, skipped: "no dashboard" };
  if (dash.status !== "live") return { refreshed: 0, failed: 0, unreachable: 0, title: dash.title, skipped: dash.status };
  const r = await refreshDashboard(dash);
  return {
    refreshed: r.ok ? 1 : 0,
    failed: r.ok ? 0 : 1,
    unreachable: r.unreachable ? 1 : 0,
    partial: r.partial ? 1 : 0,
    reason: r.error,
    title: dash.title,
  };
}

/** True if we already emailed a failure notice for this dashboard within `windowMin`. */
async function failureAlreadyNotified(dashboardId: string, windowMin: number): Promise<boolean> {
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT 1 FROM audit_logs
        WHERE action = 'report.schedule_failed'
          AND metadata->>'dashboardId' = $1
          AND metadata->>'notified' = 'true'
          AND created_at > now() - ($2 || ' minutes')::interval
        LIMIT 1`,
      dashboardId,
      String(windowMin),
    )) as unknown[];
    return rows.length > 0;
  } catch {
    return true; // if the lookback fails, err on the side of not spamming
  }
}

/**
 * One scheduler pass: claim every due schedule and refresh its dashboard. Shared
 * by the in-app timer (instrumentation) and the manual `/cron/tick` endpoint.
 * Concurrency-safe via the atomic claim in `claimDueSchedules`.
 */
export async function runDueReportRefresh(
  now: Date = new Date(),
): Promise<{ claimed: number; refreshed: number; failed: number; results: Array<Record<string, unknown>> }> {
  const claimed = await claimDueSchedules(now);
  let refreshed = 0;
  let failed = 0;
  const results: Array<Record<string, unknown>> = [];

  for (const s of claimed) {
    let r: Awaited<ReturnType<typeof refreshDashboardBySlug>>;
    try {
      // Everything recorded while refreshing is attributed to THIS schedule
      // and the admin who last set it — not an anonymous background row.
      const configuredBy = await prisma.reportSchedule
        .findUnique({ where: { id: s.id }, select: { updatedById: true } })
        .then((row) => row?.updatedById ?? null)
        .catch(() => null);
      r = await runWithErrorContext(
        {
          origin: "scheduled",
          userId: configuredBy,
          job: { kind: "Scheduled report refresh", name: s.dashboardId, dashboardId: s.dashboardId, configuredBy },
        },
        () => refreshDashboardBySlug(s.dashboardId),
      );
    } catch (e) {
      r = { refreshed: 0, failed: 1, unreachable: 0, reason: e instanceof Error ? e.message : "refresh failed" };
    }
    refreshed += r.refreshed;
    failed += r.failed;
    results.push({ dashboardId: s.dashboardId, sourceKey: s.sourceKey, ...r });

    if (r.skipped) {
      await prisma.reportSchedule
        .updateMany({ where: { id: s.id }, data: { lastStatus: `skipped: ${r.skipped}` } })
        .catch(() => {});
      continue;
    }

    const status = r.failed === 0 ? "ok" : "error";
    await prisma.reportSchedule
      .updateMany({
        where: { id: s.id },
        data: {
          lastStatus: r.failed
            ? `failed: ${(r.reason ?? "").slice(0, 120)}`
            // A partial run DID refresh, but not completely — say so.
            : r.partial ? `refreshed with gaps: ${(r.reason ?? "").replace(/^partial: /, "").slice(0, 110)}` : "refreshed",
        },
      })
      .catch(() => {});

    const action = status === "error" ? "report.schedule_failed" : "report.schedule_ran";
    const dashboardName = r.title || s.dashboardId;

    // A failed run means the last good snapshot was KEPT. Notify the alert
    // recipients, throttled so we don't email every tick while a source is down.
    let notified = false;
    if (status === "error") {
      try {
        const windowMin = Number(process.env.FABINSIGHT_REFRESH_FAIL_NOTIFY_MIN ?? "60");
        if (!(await failureAlreadyNotified(s.dashboardId, windowMin))) {
          const reason = r.reason ?? "the scheduled refresh could not complete";
          const recipients = await resolveAlertRecipients();
          const html = `
            <p><b>Scheduled refresh failed</b></p>
            <p><b>${esc(dashboardName)}</b> did not refresh at its scheduled time.</p>
            <ul>
              <li>Reason: ${esc(reason)}</li>
              <li>As of ${now.toISOString()} (UTC)</li>
            </ul>
            <p>The last successful snapshot has been kept — no data was overwritten. It will refresh automatically once the source is reachable again.</p>`;
          notified = await sendMail(recipients, `⚠️ Scheduled refresh failed — ${dashboardName}`, html, "FabOrchestrator Alerts");
        }
      } catch (e) {
        console.warn("[refresh] failure notice not sent:", e instanceof Error ? e.message : e);
      }
    }

    await prisma
      .$executeRawUnsafe(
        `INSERT INTO audit_logs (id, user_id, action, target_type, target_id, metadata, created_at)
         VALUES (gen_random_uuid()::text, NULL, $1, 'ReportSchedule', $2, $3::jsonb, now())`,
        action,
        s.dashboardId,
        JSON.stringify({
          dashboardId: s.dashboardId,
          dashboardName,
          sourceKey: s.sourceKey,
          refreshed: r.refreshed,
          failed: r.failed,
          status,
          unreachable: r.unreachable > 0,
          partial: (r.partial ?? 0) > 0,
          reason: r.reason ?? null,
          notified,
          trigger: "schedule",
        }),
      )
      .catch(() => {});
  }

  return { claimed: claimed.length, refreshed, failed, results };
}
