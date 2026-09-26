/**
 * Resolve the expressions a program's call arguments may contain:
 *
 *   { $now: true }                    the run instant
 *   { $rel: "-7d" }                   now ± offset (s/m/h/d/w/M)
 *   { $startOf: "day", offset? }      start of the (offset) day/week/month/shift in the program tz
 *   { $endOf: "day", offset? }        exclusive end (= start of the next one)
 *   { $shift: "current"|"previous", part: "start"|"end"|"name" }
 *   { $ref: "call1.rows[*].LotId", join? }   a value from an earlier result
 *   { $var: "lot" }                   the current forEach item
 *
 * Every time value is formatted per `format` (default ISO-8601 UTC). Week
 * starts on Monday. Shifts may wrap midnight (22:00 → 06:00).
 */

import {
  isRefExpr,
  isTimeExpr,
  isVarExpr,
  programShifts,
  REL_RE,
  type ArgValue,
  type Shift,
  type TimeExpr,
  type TimeFormat, isTemplateExpr } from './program';
import { resolvePath, type Results } from './paths';
import { hmOrNull, localDayToUtc, partsInTz, zonedToUtc } from './tz';

export class ExpressionError extends Error {
  constructor(
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

export type ExprContext = {
  now: Date;
  tz: string;
  shifts?: Shift[];
  results: Results;
  vars?: Record<string, unknown>;
};

// ── Relative offsets ─────────────────────────────────────────────────────────

/** Apply "-7d" style offsets. Days/weeks are LOCAL calendar days in `tz`; months are calendar months. */
export function applyRel(base: Date, rel: string, tz: string): Date {
  const m = REL_RE.exec(rel.trim());
  if (!m) throw new ExpressionError(`bad relative offset "${rel}"`);
  const n = parseInt(m[1], 10);
  const unit = m[2];
  switch (unit) {
    case 's':
      return new Date(base.getTime() + n * 1000);
    case 'm':
      return new Date(base.getTime() + n * 60_000);
    case 'h':
      return new Date(base.getTime() + n * 3_600_000);
    case 'd':
    case 'w': {
      const days = unit === 'w' ? n * 7 : n;
      const p = partsInTz(base, tz);
      return localDayToUtc(p.y, p.mon, p.day, days, p.h, p.mi, tz);
    }
    case 'M': {
      const p = partsInTz(base, tz);
      const idx = p.y * 12 + (p.mon - 1) + n;
      const y = Math.floor(idx / 12);
      const mon = (idx % 12) + 1;
      const dim = new Date(Date.UTC(y, mon, 0)).getUTCDate();
      return zonedToUtc(y, mon, Math.min(p.day, dim), p.h, p.mi, tz, p.s);
    }
  }
  throw new ExpressionError(`bad relative unit "${unit}"`);
}

// ── Period boundaries ────────────────────────────────────────────────────────

function startOfDay(at: Date, tz: string): Date {
  const p = partsInTz(at, tz);
  return zonedToUtc(p.y, p.mon, p.day, 0, 0, tz);
}

/** Monday 00:00 of the week containing `at` (in `tz`). */
function startOfWeek(at: Date, tz: string): Date {
  const p = partsInTz(at, tz);
  const back = (p.dow + 6) % 7; // Mon=0 … Sun=6
  return localDayToUtc(p.y, p.mon, p.day, -back, 0, 0, tz);
}

function startOfMonth(at: Date, tz: string): Date {
  const p = partsInTz(at, tz);
  return zonedToUtc(p.y, p.mon, 1, 0, 0, tz);
}

type ShiftWindow = { shift: Shift; start: Date; end: Date };

/** The shift window containing `at`, and the one before it. */
export function shiftWindows(at: Date, tz: string, shifts: Shift[]): { current: ShiftWindow; previous: ShiftWindow } {
  const p = partsInTz(at, tz);
  const minutes = p.h * 60 + p.mi;
  // Candidate windows: each shift on yesterday, today and tomorrow (wrapping shifts span two days).
  const wins: ShiftWindow[] = [];
  for (const shift of shifts) {
    const s = hmOrNull(shift.start);
    const e = hmOrNull(shift.end);
    if (!s || !e) continue;
    const sMin = s[0] * 60 + s[1];
    const eMin = e[0] * 60 + e[1];
    const wraps = eMin <= sMin;
    for (const dayOff of [-1, 0, 1]) {
      const start = localDayToUtc(p.y, p.mon, p.day, dayOff, s[0], s[1], tz);
      const end = localDayToUtc(p.y, p.mon, p.day, dayOff + (wraps ? 1 : 0), e[0], e[1], tz);
      wins.push({ shift, start, end });
    }
  }
  wins.sort((a, b) => a.start.getTime() - b.start.getTime());
  const t = at.getTime();
  let idx = wins.findIndex((w) => w.start.getTime() <= t && t < w.end.getTime());
  if (idx < 0) {
    // Gap between shifts: take the most recent one that started.
    idx = wins.reduce((best, w, i) => (w.start.getTime() <= t ? i : best), -1);
    if (idx < 0) throw new ExpressionError(`no shift covers ${at.toISOString()} (${minutes} min into the day)`);
  }
  const current = wins[idx];
  // Windows are sorted by start over three days, so the one before is the previous shift.
  const previous = wins[Math.max(0, idx - 1)];
  return { current, previous };
}

// ── Formatting ───────────────────────────────────────────────────────────────

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function formatTime(d: Date, format: TimeFormat | undefined, tz: string): string | number {
  switch (format ?? 'iso') {
    case 'iso':
      return d.toISOString();
    case 'epoch':
      return d.getTime();
    case 'date': {
      const p = partsInTz(d, tz);
      return `${p.y}-${pad(p.mon)}-${pad(p.day)}`;
    }
    case 'datetime-local': {
      const p = partsInTz(d, tz);
      return `${p.y}-${pad(p.mon)}-${pad(p.day)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
    }
  }
  return d.toISOString();
}

/** Resolve one time expression to a Date (or the shift name). */
function resolveTimeValue(expr: TimeExpr, now: Date, tz: string, shifts: Shift[]): Date | string {
  if ('$now' in expr) return now;
  if ('$rel' in expr) return applyRel(now, expr.$rel, tz);
  if ('$shift' in expr) {
    const w = shiftWindows(now, tz, shifts);
    const win = expr.$shift === 'current' ? w.current : w.previous;
    if (expr.part === 'name') return win.shift.name;
    return expr.part === 'start' ? win.start : win.end;
  }
  const unit = '$startOf' in expr ? expr.$startOf : expr.$endOf;
  const isEnd = '$endOf' in expr;
  const at = expr.offset ? applyRel(now, expr.offset, tz) : now;
  let start: Date;
  let end: Date;
  switch (unit) {
    case 'day':
      start = startOfDay(at, tz);
      end = applyRel(start, '+1d', tz);
      break;
    case 'week':
      start = startOfWeek(at, tz);
      end = applyRel(start, '+7d', tz);
      break;
    case 'month':
      start = startOfMonth(at, tz);
      end = applyRel(start, '+1M', tz);
      break;
    case 'shift': {
      const w = shiftWindows(at, tz, shifts).current;
      start = w.start;
      end = w.end;
      break;
    }
  }
  return isEnd ? end : start;
}

export function resolveTime(expr: TimeExpr, now: Date, tz: string, shifts: Shift[]): string | number {
  const v = resolveTimeValue(expr, now, tz, shifts);
  return v instanceof Date ? formatTime(v, expr.format, tz) : v;
}

// ── Arguments ────────────────────────────────────────────────────────────────

function resolveOne(v: unknown, ctx: ExprContext, key: string): unknown {
  if (isTimeExpr(v)) return resolveTime(v, ctx.now, ctx.tz, ctx.shifts ?? programShifts({ time: { timezone: ctx.tz } }));
  if (isRefExpr(v)) {
    const out = resolvePath(v.$ref, ctx.results);
    if (out === undefined) throw new ExpressionError(`unresolved reference "${v.$ref}" for argument "${key}"`, v.$ref);
    if (Array.isArray(out) && v.join !== undefined) return out.map((x) => String(x ?? '')).join(v.join);
    return out;
  }
  if (isVarExpr(v)) {
    if (!ctx.vars || !(v.$var in ctx.vars)) throw new ExpressionError(`unbound variable "${v.$var}" for argument "${key}"`);
    return ctx.vars[v.$var];
  }
  if (isTemplateExpr(v)) {
    const vars: Record<string, unknown> = {};
    for (const [name, x] of Object.entries(v.vars ?? {})) vars[name] = resolveOne(x, ctx, `${key}.${name}`);
    return v.$template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, name: string) => {
      if (!(name in vars)) throw new ExpressionError(`template variable "${name}" is not defined for argument "${key}"`);
      const val = vars[name];
      return Array.isArray(val) ? val.map((x) => String(x ?? '')).join(',') : String(val ?? '');
    });
  }
  if (Array.isArray(v)) return v.map((x, i) => resolveOne(x, ctx, `${key}[${i}]`));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = resolveOne(x, ctx, `${key}.${k}`);
    return o;
  }
  return v;
}

/** Resolve every argument of a call. Throws `ExpressionError` on an unresolvable reference. */
export function resolveArgs(args: Record<string, ArgValue>, ctx: ExprContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = resolveOne(v, ctx, k);
  return out;
}
