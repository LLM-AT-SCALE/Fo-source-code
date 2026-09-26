/**
 * Timezone-aware wall-clock math (built-in Intl, no dependency).
 *
 * Shared by the report scheduler (`schedule.ts`) and the replay expression
 * resolver.
 *
 * A wall-clock (y, mon, day, hh, mm) in `tz` is converted to the correct UTC
 * instant by recomputing the zone offset each time, so it stays correct across
 * DST.
 */

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export type TzParts = {
  y: number;
  mon: number; // 1-12
  day: number;
  dow: number; // 0-6, Sun=0
  h: number;
  mi: number;
  s: number;
};

/** The wall-clock parts a given UTC instant shows in `tz`. */
export function partsInTz(utc: Date, tz: string): TzParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const x of dtf.formatToParts(utc)) if (x.type !== "literal") p[x.type] = x.value;
  return {
    y: +p.year, mon: +p.month, day: +p.day, dow: DOW[p.weekday] ?? 0,
    h: +p.hour % 24, mi: +p.minute, s: +p.second,
  };
}

/** tz offset (ms) at a UTC instant = (its wall-clock read as UTC) − the instant. */
export function tzOffsetMs(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const x of dtf.formatToParts(new Date(utcMs))) if (x.type !== "literal") p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - utcMs;
}

/** UTC Date for wall-clock (y, mon[1-12], day, hh, mm[, ss]) interpreted in `tz`. DST-aware. */
export function zonedToUtc(y: number, mon: number, day: number, hh: number, mm: number, tz: string, ss = 0): Date {
  if (!tz || tz === "UTC") return new Date(Date.UTC(y, mon - 1, day, hh, mm, ss));
  const guess = Date.UTC(y, mon - 1, day, hh, mm, ss);
  let utc = guess - tzOffsetMs(guess, tz);
  utc = guess - tzOffsetMs(utc, tz); // one correction pass for DST boundaries
  return new Date(utc);
}

/** Add `n` LOCAL calendar days to (base y/mon/day) then resolve hh:mm in `tz` to UTC. */
export function localDayToUtc(y: number, mon: number, day: number, n: number, hh: number, mm: number, tz: string): Date {
  const d = new Date(Date.UTC(y, mon - 1, day + n)); // Date normalizes month/year rollover
  return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hh, mm, tz);
}

/** Monthly: clamp day-of-month to the month's length, then resolve in `tz`. */
export function monthlyToUtc(y: number, mon: number, dom: number, hh: number, mm: number, tz: string): Date {
  const dim = new Date(Date.UTC(y, mon, 0)).getUTCDate();
  return zonedToUtc(y, mon, Math.min(dom, dim), hh, mm, tz);
}

/** "HH:MM" → [h, m], or null. */
export function hmOrNull(s: string | null | undefined): [number, number] | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return [Math.min(23, Math.max(0, parseInt(m[1], 10))), Math.min(59, Math.max(0, parseInt(m[2], 10)))];
}

/** Minutes-of-day (0-1439) that a UTC instant reads as in `tz`. */
export function localMinutes(utc: Date, tz: string): number {
  const p = partsInTz(utc, tz);
  return p.h * 60 + p.mi;
}
