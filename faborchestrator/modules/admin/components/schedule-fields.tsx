"use client";

import { toFrequency, type ReportFrequency } from "@/modules/admin/lib/dashboards/report-schedule";
import { browserTz, canonicalTz, listTimezones } from "@/shared/lib/timezones";

/** Client-side schedule state shared by the in-chat card and the approve form. */
export type ScheduleValue = {
  frequency: ReportFrequency;
  intervalMinutes: number;
  atTime: string; // "HH:MM"
  timezone: string;
  daysOfWeek: number[]; // 0-6
  dayOfMonth: number; // 1-31
  windowStart: string; // "HH:MM" or ""
  windowEnd: string; // "HH:MM" or ""
};

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const TZ_OPTIONS = listTimezones();

export function defaultScheduleValue(overrides: Partial<ScheduleValue> = {}): ScheduleValue {
  return {
    frequency: "daily",
    intervalMinutes: 60,
    atTime: "06:00",
    timezone: browserTz(),
    daysOfWeek: [1],
    dayOfMonth: 1,
    windowStart: "",
    windowEnd: "",
    ...overrides,
  };
}

/** Build a ScheduleValue from a loose/partial source (marker JSON or a DB row). */
export function scheduleValueFrom(src: {
  frequency?: string | null;
  intervalMinutes?: number | null;
  atTime?: string | null;
  timezone?: string | null;
  daysOfWeek?: number[] | null;
  dayOfMonth?: number | null;
  windowStart?: string | null;
  windowEnd?: string | null;
}): ScheduleValue {
  const days =
    src.daysOfWeek && src.daysOfWeek.length
      ? [...new Set(src.daysOfWeek.filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b)
      : [1];
  return {
    frequency: toFrequency(src.frequency),
    intervalMinutes: src.intervalMinutes || 60,
    atTime: src.atTime || "06:00",
    timezone: (src.timezone && canonicalTz(src.timezone)) || browserTz(),
    daysOfWeek: days,
    dayOfMonth: src.dayOfMonth ?? 1,
    windowStart: src.windowStart || "",
    windowEnd: src.windowEnd || "",
  };
}

/** Validation flags the parent uses to gate its submit button. */
export function scheduleValueErrors(v: ScheduleValue): { weeklyDaysMissing: boolean; windowInvalid: boolean; valid: boolean } {
  const weeklyDaysMissing = v.frequency === "weekly" && v.daysOfWeek.length === 0;
  const windowInvalid = v.frequency === "hourly" && !!v.windowStart && !!v.windowEnd && v.windowStart >= v.windowEnd;
  return { weeklyDaysMissing, windowInvalid, valid: !weeklyDaysMissing && !windowInvalid };
}

/** The POST body fields the schedule APIs accept (only the ones relevant to the frequency). */
export function scheduleValueToBody(v: ScheduleValue) {
  return {
    frequency: v.frequency,
    intervalMinutes: v.frequency === "hourly" ? v.intervalMinutes : undefined,
    atTime: v.frequency !== "hourly" ? v.atTime : undefined,
    daysOfWeek: v.frequency === "weekly" ? v.daysOfWeek : undefined,
    dayOfMonth: v.frequency === "monthly" ? v.dayOfMonth : undefined,
    timezone: v.timezone,
    windowStart: v.frequency === "hourly" && v.windowStart ? v.windowStart : undefined,
    windowEnd: v.frequency === "hourly" && v.windowEnd ? v.windowEnd : undefined,
  };
}

/** "daily at 06:00 Asia/Kolkata" — for confirmations. */
export function describeScheduleValue(v: ScheduleValue): string {
  const win = v.windowStart && v.windowEnd ? ` between ${v.windowStart}–${v.windowEnd} ${v.timezone}` : "";
  if (v.frequency === "hourly") return `every ${v.intervalMinutes} min${win}`;
  if (v.frequency === "daily") return `daily at ${v.atTime} ${v.timezone}`;
  if (v.frequency === "weekly") return `weekly on ${v.daysOfWeek.map((d) => DOW_SHORT[d]).join(", ")} at ${v.atTime} ${v.timezone}`;
  return `monthly on day ${v.dayOfMonth} at ${v.atTime} ${v.timezone}`;
}

export const scheduleSelectCls =
  "w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring";
export const scheduleLabelCls = "block text-xs font-medium text-muted-foreground mb-1";

/**
 * Frequency / interval / time / timezone / days / day-of-month / active-window
 * controls. Controlled: the parent owns the `ScheduleValue`. Renders as grid
 * cells, so wrap it in a `grid` container alongside any extra fields.
 */
export function ScheduleFields({
  value,
  onChange,
  disabled = false,
}: {
  value: ScheduleValue;
  onChange: (next: ScheduleValue) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<ScheduleValue>) => onChange({ ...value, ...patch });
  const { weeklyDaysMissing, windowInvalid } = scheduleValueErrors(value);
  const toggleDay = (d: number) =>
    set({
      daysOfWeek: value.daysOfWeek.includes(d)
        ? value.daysOfWeek.filter((x) => x !== d)
        : [...value.daysOfWeek, d].sort((a, b) => a - b),
    });

  return (
    <>
      <div>
        <label className={scheduleLabelCls}>Frequency</label>
        <select
          className={scheduleSelectCls}
          value={value.frequency}
          disabled={disabled}
          onChange={(e) => set({ frequency: toFrequency(e.target.value) })}
        >
          <option value="hourly">Interval (every N min)</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>
      </div>

      {value.frequency === "hourly" && (
        <div>
          <label className={scheduleLabelCls}>Every (minutes)</label>
          <input
            type="number" min={5} max={1440} step={5}
            className={scheduleSelectCls} value={value.intervalMinutes} disabled={disabled}
            onChange={(e) => set({ intervalMinutes: Math.max(5, Number(e.target.value) || 60) })}
          />
        </div>
      )}

      {value.frequency === "hourly" && (
        <>
          <div>
            <label className={scheduleLabelCls}>Active from (optional)</label>
            <input type="time" className={scheduleSelectCls} value={value.windowStart} disabled={disabled} onChange={(e) => set({ windowStart: e.target.value })} />
          </div>
          <div>
            <label className={scheduleLabelCls}>Active until (optional)</label>
            <input type="time" className={scheduleSelectCls} value={value.windowEnd} disabled={disabled} onChange={(e) => set({ windowEnd: e.target.value })} />
          </div>
          {windowInvalid && <p className="text-xs text-destructive sm:col-span-2">Start time must be before end time.</p>}
        </>
      )}

      {value.frequency !== "hourly" && (
        <div>
          <label className={scheduleLabelCls}>Time</label>
          <input type="time" className={scheduleSelectCls} value={value.atTime} disabled={disabled} onChange={(e) => set({ atTime: e.target.value })} />
        </div>
      )}

      <div>
        <label className={scheduleLabelCls}>Timezone</label>
        <select className={scheduleSelectCls} value={value.timezone} disabled={disabled} onChange={(e) => set({ timezone: e.target.value })}>
          {TZ_OPTIONS.map((tz) => (
            <option key={tz.value} value={tz.value}>{tz.label}</option>
          ))}
        </select>
      </div>

      {value.frequency === "weekly" && (
        <div className="sm:col-span-2">
          <label className={scheduleLabelCls}>Days (pick one or more)</label>
          <div className="flex flex-wrap gap-1.5">
            {DOW_SHORT.map((d, i) => {
              const on = value.daysOfWeek.includes(i);
              return (
                <button
                  key={i}
                  type="button"
                  disabled={disabled}
                  onClick={() => toggleDay(i)}
                  title={DOW[i]}
                  className={
                    "h-8 min-w-[44px] rounded-md border px-2 text-xs font-medium transition-colors disabled:opacity-60 " +
                    (on
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background text-foreground hover:bg-accent")
                  }
                >
                  {d}
                </button>
              );
            })}
          </div>
          {weeklyDaysMissing && <p className="mt-1 text-xs text-destructive">Pick at least one day.</p>}
        </div>
      )}

      {value.frequency === "monthly" && (
        <div>
          <label className={scheduleLabelCls}>Day of month</label>
          <input
            type="number" min={1} max={31}
            className={scheduleSelectCls} value={value.dayOfMonth} disabled={disabled}
            onChange={(e) => set({ dayOfMonth: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })}
          />
        </div>
      )}
    </>
  );
}
