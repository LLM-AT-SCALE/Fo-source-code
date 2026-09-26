/**
 * Numeric column detection for alerting / baselines. The shape written to
 * `metric_columns` is unchanged from the SQL era so the admin alert-threshold
 * UI and `baselines.customMetricKey` keep working.
 */

import type { ResultRow, SetResult } from './paths';

export type MetricColumn = { setKey: string; setLabel: string; column: string };

/** A column is numeric when every non-empty value in the rows is a number. */
export function isNumericColumn(rows: ResultRow[], key: string): boolean {
  let seen = 0;
  for (const r of rows) {
    const v = r[key];
    if (v === null || v === undefined || v === '') continue;
    seen++;
    if (typeof v === 'number') continue;
    if (typeof v === 'boolean') return false;
    if (Number.isNaN(Number(String(v).replace(/,/g, '')))) return false;
  }
  return seen > 0;
}

/** Columns worth tracking as metrics, in set order. Skips the synthetic `server` and `_item` columns. */
export function numericColumns(sets: Pick<SetResult, 'key' | 'label' | 'rows' | 'columns' | 'error'>[]): MetricColumn[] {
  const out: MetricColumn[] = [];
  for (const set of sets) {
    if (set.error || !set.rows.length) continue;
    const cols = set.columns.length ? set.columns : Object.keys(set.rows[0]);
    for (const col of cols) {
      if (col === 'server' || col === '_item') continue;
      if (isNumericColumn(set.rows, col)) out.push({ setKey: set.key, setLabel: set.label, column: col });
    }
  }
  return out;
}
