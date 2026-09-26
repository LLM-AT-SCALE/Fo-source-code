/**
 * Shared helpers for the Recent Reports refresh schedule.
 *
 * The admin screens only VALIDATE a schedule and write it to `report_schedules`
 * with `next_run_at = now()` (due on the scheduler's next tick).
 * `claimDueSchedules` (modules/fabinsight/lib/schedule.ts) computes every later
 * run, so there is no timezone math here — it all lives in
 * modules/fabinsight/lib/replay/tz.ts.
 */

export type ReportFrequency = "hourly" | "daily" | "weekly" | "monthly";

/** Narrow a free-form string to a valid frequency (no unsafe casts). */
export function toFrequency(f?: string | null): ReportFrequency {
  return f === "hourly" || f === "daily" || f === "weekly" || f === "monthly" ? f : "daily";
}

/** The 7 curated FabInsight dashboards (id ↔ label). */
export const REPORT_DASHBOARDS: { id: string; label: string }[] = [
  { id: "factory-operations", label: "Factory Operations" },
  { id: "lot-history", label: "Lot History" },
  { id: "process-analytics", label: "Process Analytics" },
  { id: "maintenance-prediction", label: "Maintenance" },
  { id: "bottleneck-prediction", label: "Bottleneck Risk" },
  { id: "analytics-dashboard", label: "Product Analytics" },
  { id: "executive-overview", label: "Executive Overview" },
];

export const REPORT_SOURCES: { key: string; label: string }[] = [
  { key: "lumentum", label: "Lumentum" },
];

// ── Schedule input parsing ───────────────────────────────────────────────────

/** A sanitised schedule, ready to be written to `report_schedules`. */
export type ScheduleInput = {
  frequency: ReportFrequency;
  /** Minutes between runs; only meaningful for "hourly" (interval) schedules. */
  intervalMinutes: number | null;
  /** "HH:MM" wall-clock time in `timezone`; daily/weekly/monthly. */
  atTime: string | null;
  /** Weekly: sorted, de-duplicated weekdays (0 = Sunday). */
  daysOfWeek: number[];
  /** Weekly: the same list as a "1,3,5" string for the DB column (null when empty). */
  daysOfWeekStr: string | null;
  dayOfMonth: number | null;
  enabled: boolean;
  /** IANA timezone; "UTC" default. */
  timezone: string;
  /** Interval schedules only: active window "HH:MM" (null otherwise). */
  windowStart: string | null;
  windowEnd: string | null;
};

const isHM = (v: unknown): v is string => typeof v === "string" && /^(\d{1,2}):(\d{2})$/.test(v.trim());

function intOrNull(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * Sanitise a raw schedule body (from the in-chat card, the approve form, or the
 * admin chat tool) into a `ScheduleInput`. Only structural problems are
 * errors (a window that ends before it starts); everything else falls back to a
 * sensible default, matching the old route behaviour.
 */
export function parseScheduleInput(body: unknown): ScheduleInput | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const frequency = toFrequency(typeof b.frequency === "string" ? b.frequency : undefined);
  const timezone = typeof b.timezone === "string" && b.timezone.trim() ? b.timezone.trim() : "UTC";
  const enabled = typeof b.enabled === "boolean" ? b.enabled : true;

  const intervalMinutes = frequency === "hourly" ? intOrNull(b.intervalMinutes, 1, 1440) : null;
  const atTime = frequency !== "hourly" && isHM(b.atTime) ? b.atTime.trim() : null;

  // Active window only applies to interval ("hourly") schedules.
  const windowStart = frequency === "hourly" && isHM(b.windowStart) ? b.windowStart.trim() : null;
  const windowEnd = frequency === "hourly" && isHM(b.windowEnd) ? b.windowEnd.trim() : null;
  if (windowStart && windowEnd && windowStart >= windowEnd) {
    return { error: "The active window must start before it ends." };
  }

  // Weekly can run on several days ("1,3,5"). Sanitise to 0-6 ints.
  const daysOfWeek = Array.isArray(b.daysOfWeek)
    ? [...new Set(b.daysOfWeek.map((d) => intOrNull(d, 0, 6)).filter((d): d is number => d !== null))].sort((x, y) => x - y)
    : [];
  const daysOfWeekStr = daysOfWeek.length ? daysOfWeek.join(",") : null;

  const dayOfMonth = intOrNull(b.dayOfMonth, 1, 31);

  return {
    frequency,
    intervalMinutes,
    atTime,
    daysOfWeek,
    daysOfWeekStr,
    dayOfMonth,
    enabled,
    timezone,
    windowStart,
    windowEnd,
  };
}

// ── Expiry ───────────────────────────────────────────────────────────────────

export const EXPIRY_PRESETS = [7, 14, 30, 90] as const;
type ExpiryPreset = (typeof EXPIRY_PRESETS)[number];

export type ExpiryInput = { preset: ExpiryPreset | "custom" | "never"; date?: string | null };

/** The form value for "no end date"; resolves to `null` (the dashboard never expires). */
export const EXPIRY_NEVER = "never" as const;

/**
 * Resolve an expiry choice to an absolute instant, or `null` for "never" (no end
 * date: the dashboard keeps refreshing until an admin pauses or expires it).
 * Presets are `now + N days`; "custom" takes an ISO date ("YYYY-MM-DD" is read
 * as end of that day, UTC) and must be in the future.
 */
export function resolveExpiry(expiry: unknown, now: Date = new Date()): Date | null | { error: string } {
  const e = (expiry && typeof expiry === "object" ? expiry : {}) as Record<string, unknown>;
  if (e.preset === EXPIRY_NEVER || e.preset === null) return null;
  const preset = typeof e.preset === "string" && e.preset !== "custom" ? Number(e.preset) : e.preset;

  if (typeof preset === "number") {
    if (!(EXPIRY_PRESETS as readonly number[]).includes(preset)) {
      return { error: `Expiry must be one of ${EXPIRY_PRESETS.join(", ")} days, a custom date, or "never".` };
    }
    return new Date(now.getTime() + preset * 86_400_000);
  }
  if (preset === "custom") {
    const raw = typeof e.date === "string" ? e.date.trim() : "";
    if (!raw) return { error: "Pick a custom expiry date." };
    const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T23:59:59.000Z`) : new Date(raw);
    if (Number.isNaN(d.getTime())) return { error: "The custom expiry date is not valid." };
    if (d.getTime() <= now.getTime()) return { error: "The custom expiry date must be in the future." };
    return d;
  }
  return { error: "Pick an expiry." };
}
