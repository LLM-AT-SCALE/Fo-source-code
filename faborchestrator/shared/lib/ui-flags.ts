/**
 * Client-visible UI flags.
 *
 * Next.js inlines `NEXT_PUBLIC_*` at BUILD time, so each must be referenced as a
 * full literal (`process.env.NEXT_PUBLIC_X`) — a destructured or computed lookup
 * is not substituted and silently reads as undefined in the browser.
 */

function flag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return fallback;
}

/**
 * Show the live elapsed-seconds counter on the tool-usage indicator.
 *
 * This is a DIAGNOSTIC, not product copy: it exists so we can see where a slow
 * turn spends its time. End users should not be shown a stopwatch counting up
 * while they wait — it draws attention to the delay and reads as a defect.
 *
 * Default: ON in development, OFF in production. Set
 * NEXT_PUBLIC_SHOW_TOOL_TIMER=1 to force it on in a deployed build (e.g. while
 * reproducing a customer's latency complaint), or =0 to silence it locally.
 *
 * The real timings are never lost either way — they go to CloudWatch and to
 * prompt_audit_logs.timings regardless of what the UI shows.
 */
export const SHOW_TOOL_TIMER = flag(
  process.env.NEXT_PUBLIC_SHOW_TOOL_TIMER,
  process.env.NODE_ENV !== 'production'
);
