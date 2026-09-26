/**
 * Shared date-range + audit-filter helpers for the analytics pages
 * (Performance, Usage, home Dashboard). Pure: safe on the server and client.
 *
 * URL contract (kept by components/admin/date-range-control.tsx):
 *   ?range=7|30|90                 preset, ending now
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD custom, inclusive whole days (UTC)
 *   ?days=N                        legacy alias of range=N
 *   ?user=<id or email>&model=<id> optional filters
 */

export const RANGE_PRESETS = ["7", "30", "90"] as const;
type RangePreset = (typeof RANGE_PRESETS)[number] | "custom";
const DEFAULT_RANGE_DAYS = 30;
export const MAX_RANGE_DAYS = 365;

const DAY_MS = 86_400_000;

export type DateRange = {
  from: Date;
  to: Date;
  preset: RangePreset;
  /** Whole days the range spans (≥ 1). */
  days: number;
};

type ParamSource = URLSearchParams | Record<string, string | string[] | null | undefined> | null | undefined;

function getParam(src: ParamSource, key: string): string | null {
  if (!src) return null;
  if (src instanceof URLSearchParams) return src.get(key);
  const v = src[key];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

const isPreset = (v: string | null): v is (typeof RANGE_PRESETS)[number] => !!v && (RANGE_PRESETS as readonly string[]).includes(v);

/** "YYYY-MM-DD" → UTC start of that day; a full ISO datetime is taken as-is. */
function parseDateParam(v: string | null | undefined, endOfDay = false): Date | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function presetRange(days: number, now: Date = new Date()): DateRange {
  const n = Math.min(MAX_RANGE_DAYS, Math.max(1, Math.floor(days)));
  const preset: RangePreset = isPreset(String(n)) ? (String(n) as RangePreset) : "custom";
  return { from: new Date(now.getTime() - n * DAY_MS), to: now, preset, days: n };
}

/** Days spanned by [from, to], rounded up, at least 1. */
function spanDays(from: Date, to: Date): number {
  return Math.max(1, Math.ceil((to.getTime() - from.getTime()) / DAY_MS));
}

/**
 * Resolve the range from query params. Defaults to the last 30 days; invalid
 * or reversed dates fall back / swap; spans longer than 365 days are clamped
 * by moving `from` forward.
 */
export function parseRange(params: ParamSource, now: Date = new Date()): DateRange {
  const fromRaw = getParam(params, "from");
  const toRaw = getParam(params, "to");
  if (fromRaw || toRaw) {
    let from = parseDateParam(fromRaw);
    let to = parseDateParam(toRaw, true);
    if (!to) to = new Date(Math.max(now.getTime(), from?.getTime() ?? 0));
    if (!from) from = new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
    if (from.getTime() > to.getTime()) [from, to] = [to, from];
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) from = new Date(to.getTime() - MAX_RANGE_DAYS * DAY_MS);
    return { from, to, preset: "custom", days: spanDays(from, to) };
  }
  const rangeRaw = getParam(params, "range") ?? getParam(params, "days");
  if (rangeRaw) {
    const n = parseInt(rangeRaw, 10);
    if (Number.isFinite(n) && n > 0) return presetRange(n, now);
  }
  return presetRange(DEFAULT_RANGE_DAYS, now);
}

/** Query-string fields that reproduce a range. */
export function rangeToParams(r: DateRange): Record<string, string> {
  if (r.preset !== "custom") return { range: r.preset };
  return { from: r.from.toISOString().slice(0, 10), to: r.to.toISOString().slice(0, 10) };
}

const fmtDay = (d: Date) => d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "Last 30 days" or "12 Aug 2026 – 17 Sep 2026". */
export function describeRange(r: DateRange): string {
  if (r.preset !== "custom") return `Last ${r.preset} days`;
  return `${fmtDay(r.from)} – ${fmtDay(r.to)}`;
}

// ── SQL filter builder ───────────────────────────────────────────────────────

export type UserFilter = { id?: string | null; email?: string | null };

/** `?user=` is an id or an email; emails contain "@". */
export function parseUserParam(v: string | null | undefined): UserFilter | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  return s.includes("@") ? { email: s } : { id: s };
}

export type AuditFilterInput = {
  from: Date;
  to: Date;
  user?: UserFilter | null;
  model?: string | null;
};

export type AuditFilterOptions = {
  /** Timestamp column (default "datetime"). */
  dateColumn?: string;
  /** Table alias prefix, e.g. "p" → "p.datetime". */
  alias?: string;
  /** Column holding the user id (default "user_id"); null disables the user filter. */
  userIdColumn?: string | null;
  /** Column holding the user email (default "user_email"); null when the table has none. */
  userEmailColumn?: string | null;
  /** Model column (default "model"); null disables the model filter. */
  modelColumn?: string | null;
  /** First positional parameter number (default 1). */
  startIndex?: number;
};

/**
 * Build a WHERE fragment + positional params for prompt_audit_logs-shaped
 * tables: `datetime >= $1 AND datetime <= $2 [AND (user_id = $3 OR user_email = $4)] [AND model = $5]`.
 * A user filter that the table cannot express (email only, no email column)
 * is skipped rather than guessed.
 */
export function buildAuditFilters(f: AuditFilterInput, opts: AuditFilterOptions = {}): { sql: string; params: unknown[] } {
  const prefix = opts.alias ? `${opts.alias}.` : "";
  const dateCol = `${prefix}${opts.dateColumn ?? "datetime"}`;
  const userIdCol = opts.userIdColumn === null ? null : `${prefix}${opts.userIdColumn ?? "user_id"}`;
  const userEmailCol = opts.userEmailColumn === null ? null : `${prefix}${opts.userEmailColumn ?? "user_email"}`;
  const modelCol = opts.modelColumn === null ? null : `${prefix}${opts.modelColumn ?? "model"}`;
  let n = (opts.startIndex ?? 1) - 1;
  const next = () => `$${++n}`;
  const params: unknown[] = [];
  const parts: string[] = [];

  parts.push(`${dateCol} >= ${next()}`);
  params.push(f.from);
  parts.push(`${dateCol} <= ${next()}`);
  params.push(f.to);

  if (f.user) {
    const clauses: string[] = [];
    if (f.user.id && userIdCol) {
      clauses.push(`${userIdCol} = ${next()}`);
      params.push(f.user.id);
    }
    if (f.user.email && userEmailCol) {
      clauses.push(`${userEmailCol} = ${next()}`);
      params.push(f.user.email);
    }
    if (clauses.length) parts.push(clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`);
  }

  if (f.model && modelCol) {
    parts.push(`${modelCol} = ${next()}`);
    params.push(f.model);
  }

  return { sql: parts.join(" AND "), params };
}

/** Every UTC day key from `from` to `to`, for zero-filled series. */
export function dayKeys(from: Date, to: Date): string[] {
  const out: string[] = [];
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  for (let t = start; t <= end && out.length <= MAX_RANGE_DAYS + 1; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
