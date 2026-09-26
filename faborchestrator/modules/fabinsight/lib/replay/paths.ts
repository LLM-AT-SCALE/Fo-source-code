/**
 * Resolve a result path (see program.ts grammar) against executed result sets.
 *
 * `undefined` means the path does not resolve — the call is missing, the row
 * index is out of range, or no row carries the column. Callers treat that as
 * result-shape drift, never as a blank.
 */

import { parsePath, type ParsedPath } from './program';

export type ResultRow = Record<string, unknown>;

export type SetResult = {
  /** The call id this set came from. */
  key: string;
  label: string;
  rows: ResultRow[];
  columns: string[];
  capped?: boolean;
  /** Set when the rows were produced by one server of a multi-server run. */
  server?: string;
  error?: string;
  /** Multi-server: per-server errors for this call (label → message). */
  serverErrors?: Record<string, string>;
};

export type Results = Map<string, SetResult> | Record<string, SetResult>;

function getSet(results: Results, id: string): SetResult | undefined {
  return results instanceof Map ? results.get(id) : results[id];
}

/** Numeric coercion tolerant of decimal-as-string and bit-as-boolean. */
export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** True when at least one row carries the column (case-sensitive). */
function hasColumn(rows: ResultRow[], column: string): boolean {
  return rows.some((r) => Object.prototype.hasOwnProperty.call(r, column));
}

function resolveParsed(p: ParsedPath, results: Results): unknown {
  const set = getSet(results, p.callId);
  if (!set) return undefined;
  if (set.error && !set.rows.length) return undefined;
  const rows = set.rows;
  switch (p.kind) {
    case 'rows':
      return rows;
    case 'rowCount':
      return rows.length;
    case 'columns':
      return set.columns.length ? set.columns : rows.length ? Object.keys(rows[0]) : [];
    case 'row':
      return p.index < rows.length ? rows[p.index] : undefined;
    case 'cell': {
      if (p.index >= rows.length) return undefined;
      const row = rows[p.index];
      return Object.prototype.hasOwnProperty.call(row, p.column) ? row[p.column] : undefined;
    }
    case 'column': {
      if (rows.length && !hasColumn(rows, p.column)) return undefined;
      return rows.map((r) => r[p.column]);
    }
    case 'agg': {
      if (p.agg === 'count' && p.column === null) return rows.length;
      if (p.column === null) return undefined;
      if (rows.length && !hasColumn(rows, p.column)) return undefined;
      const nums = rows.map((r) => toNumber(r[p.column as string])).filter((x): x is number => x !== null);
      switch (p.agg) {
        case 'count':
          return nums.length;
        case 'sum':
          return nums.reduce((a, b) => a + b, 0);
        case 'avg':
          return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
        case 'min':
          return nums.length ? Math.min(...nums) : null;
        case 'max':
          return nums.length ? Math.max(...nums) : null;
      }
    }
  }
  return undefined;
}

/**
 * Resolve `path` against `results`. Returns `undefined` for drift and for a
 * malformed path (the validator should have rejected the latter earlier).
 */
export function resolvePath(path: string, results: Results): unknown {
  const p = parsePath(path);
  if (!p) return undefined;
  return resolveParsed(p, results);
}
