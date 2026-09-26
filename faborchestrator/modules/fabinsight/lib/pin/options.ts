/**
 * What a user chooses when they pin a chat dashboard (the one-step Pin dialog).
 *
 * - type: `static` keeps the dashboard exactly as it is now (never refreshed);
 *   `scheduled` refreshes it automatically on a schedule.
 * - scheduled only: the refresh schedule, a From date (first refresh on or after
 *   it) and a To date (the dashboard expires after it) or no expiry.
 * - who can see it: every role (default), some roles, or only the person pinning.
 *
 * The same choices drive both outcomes: an admin's pin goes live at once; anyone
 * else's is stored on the request (`dashboard_requests.decision.requested`) so the
 * admin's approval screen opens pre-filled. Pure and client-safe (no database).
 */

import { parseScheduleInput, type ScheduleInput } from '@/modules/admin/lib/dashboards/report-schedule';
import { zonedToUtc } from '@/modules/fabinsight/lib/replay/tz';

export type PinType = 'static' | 'scheduled';
export type PinVisibilityMode = 'all' | 'roles' | 'me';

/** The body fields the Pin dialog sends (besides title/html/messageId). */
export type PinChoicesBody = {
  type: PinType;
  schedule?: Record<string, unknown>;
  /** "YYYY-MM-DD" in the schedule's timezone; empty = start now. */
  from?: string | null;
  /** "YYYY-MM-DD" in the schedule's timezone; ignored when noExpiry. */
  to?: string | null;
  noExpiry?: boolean;
  visibility: { mode: PinVisibilityMode; roleIds?: string[] };
};

/** Validated choices, as stored on the request and used to publish. */
export type PinChoices = {
  type: PinType;
  /** null for a static pin. */
  schedule: ScheduleInput | null;
  /** ISO instant of the first refresh (null = as soon as it is ready). */
  startsAt: string | null;
  /** ISO instant the dashboard expires (null = no expiry). */
  expiresAt: string | null;
  /** Calendar dates as the user typed them, for display. */
  fromDate: string | null;
  toDate: string | null;
  visibilityMode: PinVisibilityMode;
  visibleToAll: boolean;
  roleIds: string[];
};

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Wall-clock start (00:00) or end (23:59:59) of a calendar day in `tz`. */
function dayInstant(raw: string, tz: string, end: boolean): Date | null {
  const m = DAY.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return end ? zonedToUtc(y, mo, d, 23, 59, tz, 59) : zonedToUtc(y, mo, d, 0, 0, tz);
}

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && !!x.trim()))] : [];

/**
 * Validate the dialog's choices. Errors are written for the person pinning:
 * they name the field to fix, never an internal rule.
 */
export function parsePinChoices(body: unknown, now: Date = new Date()): PinChoices | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const type: PinType = b.type === 'static' ? 'static' : b.type === 'scheduled' ? 'scheduled' : ('' as PinType);
  if (!type) return { error: 'Choose whether the dashboard is a static snapshot or refreshed on a schedule.' };

  const v = (b.visibility && typeof b.visibility === 'object' ? b.visibility : {}) as Record<string, unknown>;
  const visibilityMode: PinVisibilityMode = v.mode === 'roles' ? 'roles' : v.mode === 'me' ? 'me' : 'all';
  const roleIds = visibilityMode === 'roles' ? strList(v.roleIds) : [];
  if (visibilityMode === 'roles' && roleIds.length === 0) return { error: 'Pick at least one role who can see the dashboard.' };
  const visibility = { visibilityMode, visibleToAll: visibilityMode === 'all', roleIds };

  if (type === 'static') {
    return { type, schedule: null, startsAt: null, expiresAt: null, fromDate: null, toDate: null, ...visibility };
  }

  const schedule = parseScheduleInput(b.schedule);
  if ('error' in schedule) return { error: schedule.error };
  if (schedule.frequency === 'weekly' && schedule.daysOfWeek.length === 0) return { error: 'Pick at least one day for the weekly refresh.' };
  const tz = schedule.timezone || 'UTC';

  const fromRaw = typeof b.from === 'string' ? b.from.trim() : '';
  let startsAt: Date | null = null;
  if (fromRaw) {
    startsAt = dayInstant(fromRaw, tz, false);
    if (!startsAt) return { error: 'The From date is not a valid date.' };
    // A From date of today (or earlier) simply means "start now".
    if (startsAt.getTime() <= now.getTime()) startsAt = null;
  }

  const noExpiry = b.noExpiry === true;
  const toRaw = !noExpiry && typeof b.to === 'string' ? b.to.trim() : '';
  let expiresAt: Date | null = null;
  if (!noExpiry) {
    if (!toRaw) return { error: 'Pick a To date, or choose No expiry.' };
    expiresAt = dayInstant(toRaw, tz, true);
    if (!expiresAt) return { error: 'The To date is not a valid date.' };
    if (expiresAt.getTime() <= now.getTime()) return { error: 'The To date must be in the future.' };
    if (startsAt && expiresAt.getTime() <= startsAt.getTime()) return { error: 'The To date must be after the From date.' };
  }

  return {
    type,
    schedule,
    startsAt: startsAt ? startsAt.toISOString() : null,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    fromDate: fromRaw || null,
    toDate: noExpiry ? null : toRaw || null,
    ...visibility,
  };
}

/** Read stored choices back from a request's decision (null when absent/invalid). */
export function storedPinChoices(decision: unknown): PinChoices | null {
  const d = (decision && typeof decision === 'object' ? decision : null) as Record<string, unknown> | null;
  const r = (d?.requested && typeof d.requested === 'object' ? d.requested : null) as Partial<PinChoices> | null;
  if (!r || (r.type !== 'static' && r.type !== 'scheduled')) return null;
  return {
    type: r.type,
    schedule: (r.schedule as ScheduleInput | null) ?? null,
    startsAt: typeof r.startsAt === 'string' ? r.startsAt : null,
    expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt : null,
    fromDate: typeof r.fromDate === 'string' ? r.fromDate : null,
    toDate: typeof r.toDate === 'string' ? r.toDate : null,
    visibilityMode: r.visibilityMode === 'roles' || r.visibilityMode === 'me' ? r.visibilityMode : 'all',
    visibleToAll: r.visibilityMode ? r.visibilityMode === 'all' : r.visibleToAll !== false,
    roleIds: strList(r.roleIds),
  };
}

/**
 * Where a pinned dashboard stands before it has a refresh program of its own
 * (computed server-side in setup-state.ts): `static` snapshot, `preparing`
 * (automatic refresh being set up) or `setup_failed`; null = a normal dashboard.
 */
export type PinSetup = 'static' | 'preparing' | 'setup_failed' | null;

/** What a viewer is told about a dashboard in each state (business language). */
export const PIN_SETUP_TEXT: Record<Exclude<PinSetup, null>, string> = {
  static: 'Static snapshot, taken when it was pinned. It is not refreshed.',
  preparing: 'Automatic refresh is being set up. You are seeing the snapshot taken when it was pinned; it updates on its own once refresh is ready.',
  setup_failed: 'Automatic refresh could not be set up yet, so this is the snapshot taken when it was pinned. An administrator has been notified.',
};
