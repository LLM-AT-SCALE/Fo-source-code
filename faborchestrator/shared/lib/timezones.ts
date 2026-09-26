/**
 * Timezone list for the scheduling + reports UIs.
 *
 * Uses the browser/runtime's canonical IANA zone list (Intl.supportedValuesOf),
 * so there are no deprecated duplicates (e.g. "Asia/Calcutta" vs "Asia/Kolkata").
 * Each option is labelled with its current UTC offset, e.g. "Asia/Kolkata
 * (GMT+05:30)", and the list is sorted by offset. Falls back to a curated list on
 * older runtimes.
 */

const FALLBACK = [
  "UTC",
  "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Sao_Paulo",
  "Europe/London", "Europe/Berlin", "Europe/Moscow",
  "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Shanghai", "Asia/Tokyo",
  "Australia/Sydney",
];

/** Deprecated IANA aliases → their canonical name (so we never show duplicates). */
const ALIASES: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "Pacific/Ponape": "Pacific/Pohnpei",
};

export function canonicalTz(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  return ALIASES[tz] ?? tz;
}

export function browserTz(): string {
  try {
    return canonicalTz(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  } catch {
    return "UTC";
  }
}

/** Current offset of `tz` in minutes east of UTC (e.g. Asia/Kolkata → 330). */
function offsetMinutes(tz: string, at: Date = new Date()): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p: Record<string, string> = {};
    for (const x of dtf.formatToParts(at)) if (x.type !== "literal") p[x.type] = x.value;
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return Math.round((asUtc - at.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/** "GMT+05:30" from an offset in minutes. */
function fmtOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `GMT${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

export type TzOption = { value: string; label: string; offset: number };

/** The full canonical zone list, each labelled with its offset, sorted by offset. */
export function listTimezones(): TzOption[] {
  let zones: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    zones = (Intl as any).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  if (!zones.length) zones = FALLBACK;
  if (!zones.includes("UTC")) zones = ["UTC", ...zones];

  const seen = new Set<string>();
  const out: TzOption[] = [];
  for (const raw of zones) {
    const z = canonicalTz(raw);
    if (seen.has(z)) continue;
    seen.add(z);
    const off = offsetMinutes(z);
    out.push({ value: z, label: `${z.replace(/_/g, " ")} (${fmtOffset(off)})`, offset: off });
  }
  out.sort((a, b) => a.offset - b.offset || a.value.localeCompare(b.value));
  return out;
}
