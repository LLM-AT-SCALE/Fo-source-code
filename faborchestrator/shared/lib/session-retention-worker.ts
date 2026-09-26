/**
 * FabOrch Audit — REQ-02 90-day retention worker.
 *
 * Runs once at startup and then every 24 hours, deleting any
 * user_session_logs row older than 90 days. Implemented as a
 * setInterval daemon so we don't pull in a cron dependency.
 *
 * Started from instrumentation.ts next to the report scheduler (same
 * REPORT_SCHEDULER_ENABLED gate, so only the worker process runs it). Any
 * crash logs through the FabOrch logger but never throws — we don't
 * want the cleanup to take the app down.
 */

import { purgeOldSessionLogs } from './session-audit';
import { logger } from './logger';

const DAY_MS = 24 * 60 * 60 * 1000;

declare global {
   
  var __faborchSessionRetentionStarted: boolean | undefined;
}

async function runOnce() {
  const started = Date.now();
  try {
    const deleted = await purgeOldSessionLogs();
    logger.info('Session-log retention sweep complete', {
      deleted,
      durationMs: Date.now() - started,
    });
  } catch (e) {
    logger.fabOrchError(e, { route: 'session-retention-worker' });
  }
}

export function startSessionRetentionWorker() {
  if (globalThis.__faborchSessionRetentionStarted) return;
  globalThis.__faborchSessionRetentionStarted = true;

  // Defer first run by 60 seconds so a fresh boot doesn't immediately
  // pound the DB; then every 24h thereafter.
  setTimeout(runOnce, 60_000);
  setInterval(runOnce, DAY_MS);

  logger.info('Session retention worker scheduled', {
    intervalMs: DAY_MS,
    firstRunInMs: 60_000,
  });
}
