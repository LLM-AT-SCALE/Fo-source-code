/**
 * Report-refresh scheduling for the Recent Reports (pinned dashboards).
 *
 * A schedule is one row per (dashboard, source) in `report_schedules`, written
 * by the admin app's chat tool and read here by the cron tick. All times are
 * UTC. `claimDueSchedules` is the concurrency-safe claim: it advances a row's
 * `nextRunAt` with a compare-and-set on the exact value it read, so if two app
 * instances tick at once only one wins each row (no double refresh).
 */

import { prisma } from "@/shared/lib/db";
import {
  partsInTz,
  zonedToUtc,
  localDayToUtc,
  monthlyToUtc,
  hmOrNull,
  localMinutes,
} from "./replay/tz";

export type ScheduleRow = {
  id: string;
  dashboardId: string;
  sourceKey: string;
  frequency: string; // hourly | daily | weekly | monthly
  intervalMinutes: number | null;
  atTime: string | null; // "HH:MM" — wall-clock in `timezone`
  daysOfWeek: number[] | null; // 0-6 list — weekly can run on several days
  dayOfMonth: number | null; // 1-31
  timezone: string; // IANA tz the atTime/day are interpreted in (default "UTC")
  windowStart: string | null; // "HH:MM" — interval active-window start (in tz)
  windowEnd: string | null; // "HH:MM" — interval active-window end (in tz)
  nextRunAt: Date | null;
};

/** Parse a stored "1,3,5" days string to a sorted, de-duped 0-6 list. */
function parseDaysOfWeek(s: string | null): number[] {
  if (!s) return [];
  const out = new Set<number>();
  for (const part of s.split(",")) {
    const n = parseInt(part.trim(), 10);
    if (Number.isInteger(n) && n >= 0 && n <= 6) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

function parseHM(s: string | null): [number, number] {
  if (!s) return [0, 0];
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return [0, 0];
  const hh = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const mm = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return [hh, mm];
}

// ── Timezone-aware wall-clock math ───────────────────────────────────────────
// The Intl helpers live in ./replay/tz.ts (shared with the replay expression
// resolver).

/** Push a candidate interval time into the next [start,end) window (in `tz`). */
function clampToWindow(next: Date, from: Date, tz: string, ws: string | null, we: string | null): Date {
  const s = hmOrNull(ws);
  const e = hmOrNull(we);
  if (!s || !e) return next;
  const startMin = s[0] * 60 + s[1];
  const endMin = e[0] * 60 + e[1];
  const nm = localMinutes(next, tz);
  if (nm >= startMin && nm < endMin) return next;
  const p = partsInTz(next, tz);
  let cand = zonedToUtc(p.y, p.mon, p.day, s[0], s[1], tz);
  if (nm >= endMin || cand <= from) cand = localDayToUtc(p.y, p.mon, p.day, 1, s[0], s[1], tz);
  return cand;
}

/** Next run time (UTC), strictly after `from`, honouring the schedule's timezone. */
export function computeNextRun(s: ScheduleRow, from: Date): Date {
  const tz = s.timezone && s.timezone.trim() ? s.timezone.trim() : "UTC";
  const [hh, mm] = parseHM(s.atTime);

  if (s.frequency === "hourly") {
    const mins = s.intervalMinutes && s.intervalMinutes > 0 ? s.intervalMinutes : 60;
    const next = new Date(from.getTime() + mins * 60_000);
    return clampToWindow(next, from, tz, s.windowStart, s.windowEnd);
  }

  const now = partsInTz(from, tz); // "today" in the schedule's timezone

  if (s.frequency === "daily") {
    let cand = zonedToUtc(now.y, now.mon, now.day, hh, mm, tz);
    if (cand <= from) cand = localDayToUtc(now.y, now.mon, now.day, 1, hh, mm, tz);
    return cand;
  }
  if (s.frequency === "weekly") {
    const days = s.daysOfWeek && s.daysOfWeek.length ? s.daysOfWeek : [1]; // no days stored: Monday
    let best: Date | null = null;
    for (const d of days) {
      const delta = (d - now.dow + 7) % 7;
      let cand = localDayToUtc(now.y, now.mon, now.day, delta, hh, mm, tz);
      if (cand <= from) cand = localDayToUtc(now.y, now.mon, now.day, delta + 7, hh, mm, tz);
      if (!best || cand < best) best = cand;
    }
    return best ?? new Date(from.getTime() + 7 * 86_400_000);
  }
  if (s.frequency === "monthly") {
    const dom = s.dayOfMonth ?? 1;
    let cand = monthlyToUtc(now.y, now.mon, dom, hh, mm, tz);
    if (cand <= from) {
      const ny = now.mon === 12 ? now.y + 1 : now.y;
      const nm = now.mon === 12 ? 1 : now.mon + 1;
      cand = monthlyToUtc(ny, nm, dom, hh, mm, tz);
    }
    return cand;
  }
  return new Date(from.getTime() + 60 * 60_000);
}

/**
 * Claim every schedule that is due (enabled and nextRunAt <= now), advancing
 * each claimed row's nextRunAt. Returns the rows this caller won. Safe across
 * concurrent instances via a compare-and-set on the observed nextRunAt.
 */
export async function claimDueSchedules(now: Date = new Date()): Promise<ScheduleRow[]> {
  const due = await prisma.reportSchedule.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
  });

  const claimed: ScheduleRow[] = [];
  for (const row of due) {
    const s: ScheduleRow = {
      id: row.id,
      dashboardId: row.dashboardId,
      sourceKey: row.sourceKey,
      frequency: row.frequency,
      intervalMinutes: row.intervalMinutes,
      atTime: row.atTime,
      daysOfWeek: parseDaysOfWeek(row.daysOfWeek),
      dayOfMonth: row.dayOfMonth,
      timezone: row.timezone ?? "UTC",
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      nextRunAt: row.nextRunAt,
    };
    const next = computeNextRun(s, now);
    const res = await prisma.reportSchedule.updateMany({
      // Atomic claim: re-assert "still due" in the UPDATE itself. Postgres row
      // locking serializes concurrent ticks — the first advances nextRunAt into
      // the future, the second re-evaluates this WHERE against the new value and
      // matches 0 rows. (We must NOT compare the exact observed nextRunAt: it's
      // a microsecond-precision timestamptz that a JS Date truncates to ms, so
      // an equality filter would never match and nothing would ever be claimed.)
      where: { id: row.id, enabled: true, nextRunAt: { lte: now } },
      data: { nextRunAt: next, lastRunAt: now },
    });
    if (res.count === 1) claimed.push(s);
  }
  return claimed;
}
