/**
 * Next.js server-boot hook. Runs once when the Node server starts.
 *
 * Starts the background workers that must run in exactly one process:
 *   - the report-refresh scheduler (Recent Reports auto-refresh, compile jobs,
 *     expiry, alerts, shift summaries)
 *   - the session-log retention sweep (90-day purge of user_session_logs)
 *
 * Both are gated by REPORT_SCHEDULER_ENABLED (default on) so the web images
 * of the per-module deployment can switch them off and leave them to the
 * FabInsight worker. Guarded to the Node.js runtime only — Next also compiles
 * this file for the Edge runtime, which can't run the pg-backed workers, so we
 * bail there and only import the (Node-only) runners inside the guard.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // The built-in Admin role exists by default with full access — repaired on
  // every boot so it never has to be created or fixed by hand.
  try {
    const { ensureAdminRole } = await import("@/modules/admin/lib/services/role-service");
    const r = await ensureAdminRole();
    console.log(`[admin-role] built-in Admin role ${r.created ? "created" : "verified"}`);
  } catch (e) {
    console.error("[admin-role] could not verify the built-in Admin role:", e instanceof Error ? e.message : e);
  }
  const enabled = (process.env.REPORT_SCHEDULER_ENABLED ?? "true").toLowerCase();
  if (enabled === "false" || enabled === "0" || enabled === "off") {
    // The MCP health checks alone may still run here (MCP_HEALTH_SCHEDULER_ENABLED),
    // without the dashboard jobs, alerts or the session sweep.
    const healthOnly = (process.env.MCP_HEALTH_SCHEDULER_ENABLED ?? "false").toLowerCase();
    if (healthOnly === "true" || healthOnly === "1" || healthOnly === "on") {
      const { startMcpHealthScheduler } = await import("@/modules/mcp/lib/mcp-health");
      startMcpHealthScheduler();
    }
    return;
  }
  const [{ startReportScheduler }, { startSessionRetentionWorker }] = await Promise.all([
    import("@/modules/fabinsight/lib/scheduler-runner"),
    import("@/shared/lib/session-retention-worker"),
  ]);
  startReportScheduler();
  startSessionRetentionWorker();
}
