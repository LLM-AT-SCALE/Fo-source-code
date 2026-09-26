/**
 * Who — or what — is running right now.
 *
 * WHY THIS EXISTS
 * ---------------
 * A chat request knows its user and passes it to every capture boundary. The
 * scheduler does not: it wakes every minute, refreshes every dashboard, checks
 * every alert threshold, and the MES query at the bottom of that stack has no
 * idea which job asked for it or which admin configured that job. So every
 * scheduled failure used to land in the error log as "user: —", and the log
 * became a wall of identical rows nobody could attribute to anything.
 *
 * This is an AsyncLocalStorage the scheduler sets at the top of each job. It
 * travels down the async call chain for free — no signature in the dashboard
 * layer changes — and `withCapture` reads it when the caller did not name a
 * user itself. The record then says:
 *
 *   origin:  scheduled
 *   job:     { kind: "Discrepancy alert", name: "fo_lots_on_hold",
 *              dashboardId: "factory-operations", configuredBy: <admin id> }
 *   user_id: the admin who configured that alert (joins to a name in the list)
 *
 * Nothing here is invented at display time: it is what the job knew when it
 * ran, written down with the failure.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface JobContext {
  /** What kind of job: "Discrepancy alert", "Scheduled report refresh", … */
  kind: string;
  /** The specific instance: the alert's label or metric key, the dashboard's title. */
  name: string;
  dashboardId?: string;
  /** The admin whose configuration made this job run, when the row records one. */
  configuredBy?: string | null;
}

export interface RunContext {
  origin: 'user' | 'scheduled';
  /** For a scheduled job: the admin who configured it, so the failure has an owner. */
  userId?: string | null;
  job?: JobContext;
}

const store = new AsyncLocalStorage<RunContext>();

/** Run `fn` with this context visible to every capture boundary beneath it. */
export function runWithErrorContext<T>(ctx: RunContext, fn: () => Promise<T>): Promise<T> {
  return store.run(ctx, fn);
}

/** The context of the current async chain, if one was set. */
export function currentErrorContext(): RunContext | undefined {
  return store.getStore();
}
