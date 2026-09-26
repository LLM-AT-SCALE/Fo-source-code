/**
 * In-app report-refresh scheduler.
 *
 * Runs inside the always-on Elastic Beanstalk Node process (started from
 * instrumentation.ts on server boot). Replaces the external EventBridge trigger:
 * a lightweight timer calls the same `runDueReportRefresh()` in-process every
 * ~minute. Concurrency-safe even under the ASG's 1→2 scaling because the DB
 * claim is atomic — no external infrastructure required.
 *
 * A globalThis singleton guard ensures only one timer runs per process even if
 * `register()` is invoked more than once (dev HMR, double module eval).
 */

import { runDueReportRefresh } from "@/modules/fabinsight/lib/refresh";
import { runDiscrepancyAlerts } from "@/modules/fabinsight/lib/alerts";
import { sampleMetricBaselines } from "@/modules/fabinsight/lib/baselines";
import { runDueShiftSummaries } from "@/modules/fabinsight/lib/shift-summary";
import { runExpiry } from "@/modules/fabinsight/lib/expiry";
import { claimCompileJobs } from "@/modules/fabinsight/lib/compiler/job";
import { runMcpHealthChecks } from "@/modules/mcp/lib/mcp-health";
import { cmfTokenProvisioner, refreshCmfTokens } from "@/modules/master-data-load/lib/cmf/token-refresh";
import { recordCaptured } from "@/shared/lib/errors/capture";
import { FabOrchErrorType } from "@/shared/lib/errors/error-catalog-defaults";

import { runWithErrorContext } from "@/shared/lib/errors/run-context";

/** Run one stage; a failure is logged and never aborts the rest of the pass. */
/**
 * Run one stage of the tick. Everything the stage records is attributed to it
 * (lib/errors/run-context), and a stage that fails outright is recorded too —
 * it used to be a console line only, so a whole job (every alert, every
 * refresh) could stop working with nothing in the error log.
 */
async function stage(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await runWithErrorContext({ origin: "scheduled", job: { kind: "Scheduler", name } }, fn);
  } catch (err) {
    console.error(`[report-scheduler] ${name} failed`, err);
    runWithErrorContext({ origin: "scheduled", job: { kind: "Scheduler", name } }, async () => {
      recordCaptured({ system: "Scheduler", operation: name, type: FabOrchErrorType.LAMBDA_MCP_CRASH }, err);
    }).catch(() => {});
  }
}

const g = globalThis as unknown as { __fabReportSchedulerStarted?: boolean };

export function startReportScheduler(): void {
  if (g.__fabReportSchedulerStarted) return;
  g.__fabReportSchedulerStarted = true;

  // Heartbeat interval — the effective per-dashboard cadence still lives in the
  // report_schedules table; this is just how often we check "anything due?".
  const intervalMs = Math.max(15_000, Number(process.env.REPORT_TICK_INTERVAL_MS ?? "60000"));
  // Hard ceiling on a single pass. A refresh replays every due dashboard through
  // its MCP servers; if a source degrades those calls slow to their own
  // timeouts and a pass could otherwise outlive its interval. The cap bounds how
  // long one pass can hold DB/MES connections so passes can't pile up.
  const tickTimeoutMs = Math.max(30_000, Number(process.env.REPORT_TICK_TIMEOUT_MS ?? "120000"));

  // Non-overlap guard: setInterval fires on a fixed clock regardless of whether
  // the previous pass finished. If a pass runs long (slow MES), a naive timer
  // would stack overlapping passes, each holding pool connections — the exact
  // amplifier that can starve the pool and wedge the instance. Skip a tick while
  // one is still in flight.
  let running = false;

  const tick = async () => {
    // Lock stays held until the REAL work settles — not until a timeout fires —
    // because the underlying SQL promises aren't cancellable. This guarantees no
    // two passes ever run concurrently. Per-query timeouts (pg 30s, mssql 60s)
    // ensure the real work always settles, so the lock can't be held forever.
    if (running) {
      console.warn("[report-scheduler] previous pass still running — skipping this tick");
      return;
    }
    running = true;
    // Warn (don't abort) if a pass overruns its budget — a signal the MES/VPN is
    // degraded and passes are running long.
    const warnTimer = setTimeout(
      () => console.warn(`[report-scheduler] pass still running after ${tickTimeoutMs}ms — MES/VPN may be degraded`),
      tickTimeoutMs,
    );
    try {
      // Compile jobs queued by the admin app (approve / refine / edit). The claim
      // returns immediately; the compile itself runs in the background behind a
      // one-at-a-time guard so it never delays the refresh pass.
      await stage("compile-jobs", async () => {
        const out = await claimCompileJobs({ max: 2 });
        if (out.claimed > 0) console.log(`[report-scheduler] claimed ${out.claimed} compile job(s)`);
      });
      // Scheduled refresh — replay each due dashboard's program through MCP.
      await stage("refresh", async () => {
        const out = await runDueReportRefresh();
        if (out.claimed > 0) {
          console.log(`[report-scheduler] claimed ${out.claimed}, refreshed ${out.refreshed}, failed ${out.failed}`);
        }
      });
      // Expiry — warn before, expire after; hides the dashboard and disables its schedule.
      await stage("expiry", async () => {
        const out = await runExpiry();
        if (out.warned || out.expired) console.log(`[report-scheduler] expiry: warned ${out.warned}, expired ${out.expired}`);
      });
      // Discrepancy alerts — evaluated each tick against admin-set thresholds,
      // throttled per-threshold internally.
      await stage("alerts", () => runDiscrepancyAlerts());
      // Metric baselines — sample metric values for the admin's dynamic "normal
      // range"; globally throttled (default every 15 min) inside the call.
      await stage("baselines", () => sampleMetricBaselines());
      // Shift-summary emails — send at each configured shift boundary.
      await stage("shift-summaries", () => runDueShiftSummaries());
      // MCP health — every active registry server, three stages (reachable,
      // tools, data); throttled to MCP_HEALTH_INTERVAL_MS (5 min) inside the call.
      await stage("mcp-health", () => runMcpHealthChecks());
      // CMF bearer tokens — log in to the CMF portal for every enabled connection
      // whose token is missing, expired or older than CMF_TOKEN_REFRESH_MIN (45 min);
      // throttled per connection inside the call. The first tick after boot is the
      // boot refresh, so a fresh deployment never waits 45 minutes. Skipped when the
      // legacy per-connection Lambda still owns the token (CMF_TOKEN_PROVISIONER=lambda).
      if (cmfTokenProvisioner() === "in-app") {
        await stage("cmf-token", async () => {
          const out = await refreshCmfTokens();
          const refreshed = out.filter((r) => r.ok && !r.skipped).length;
          const failed = out.filter((r) => !r.ok && !r.skipped).length;
          if (refreshed || failed) console.log(`[report-scheduler] cmf-token: refreshed ${refreshed}, failed ${failed}`);
        });
      }
    } catch (err) {
      console.error("[report-scheduler] tick failed", err);
    } finally {
      clearTimeout(warnTimer);
      running = false;
    }
  };

  // Small delay after boot so the DB pool is warm, then run on the interval.
  setTimeout(() => void tick(), 10_000);
  setInterval(() => void tick(), intervalMs);
  console.log(`[report-scheduler] in-app timer started (every ${intervalMs}ms, tick cap ${tickTimeoutMs}ms)`);
}
