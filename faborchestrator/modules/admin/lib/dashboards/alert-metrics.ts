/**
 * Discrepancy-alert helpers (admin side — compute-free).
 *
 * Alertable metrics are the numeric columns Fab Orchestrator discovers on each
 * live dashboard (`dashboards.metric_columns`, shape `[{setKey, setLabel, column}]`),
 * keyed as `custom:<slug>:<setKey>:<column>`. The admin app never computes
 * metric values; evaluation lives in Fab Orch's scheduler.
 */

export type Comparator = "gt" | "lt" | "outside";

const METRIC_KEY_PREFIX = "custom:";

export type MetricColumn = { setKey: string; setLabel?: string; column: string };

/** `custom:<slug>:<setKey>:<column>` — the key Fab Orch's alerts/baselines use. */
export function metricKey(slug: string, setKey: string, column: string): string {
  return `${METRIC_KEY_PREFIX}${slug}:${setKey}:${column}`;
}

/** Parse a metric key back into its parts (null for non-dashboard keys). */
export function parseMetricKey(key: string): { slug: string; setKey: string; column: string } | null {
  if (!key.startsWith(METRIC_KEY_PREFIX)) return null;
  const rest = key.slice(METRIC_KEY_PREFIX.length);
  const first = rest.indexOf(":");
  const last = rest.lastIndexOf(":");
  if (first <= 0 || last <= first) return null;
  return { slug: rest.slice(0, first), setKey: rest.slice(first + 1, last), column: rest.slice(last + 1) };
}

/** Sanitise a `metric_columns` JSON value into typed columns. */
export function asMetricColumns(v: unknown): MetricColumn[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (c): c is MetricColumn => !!c && typeof c === "object" && typeof (c as MetricColumn).setKey === "string" && typeof (c as MetricColumn).column === "string",
  );
}

/** Validate comparator + that the bound(s) it needs are present numbers. */
export function validateBounds(comparator: string, minValue: unknown, maxValue: unknown): string | null {
  if (!["gt", "lt", "outside"].includes(comparator)) return "Invalid comparator.";
  const hasMin = typeof minValue === "number" && Number.isFinite(minValue);
  const hasMax = typeof maxValue === "number" && Number.isFinite(maxValue);
  if (comparator === "gt" && !hasMax) return "An upper bound (max) is required for 'greater than'.";
  if (comparator === "lt" && !hasMin) return "A lower bound (min) is required for 'less than'.";
  if (comparator === "outside" && (!hasMin || !hasMax)) return "Both min and max are required for 'outside range'.";
  if (comparator === "outside" && hasMin && hasMax && (minValue as number) >= (maxValue as number)) return "Min must be less than max.";
  return null;
}
