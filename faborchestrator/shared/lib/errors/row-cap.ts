/**
 * FabOrch Audit — REQ-01 row-cap helper.
 *
 * Soft-caps any list result at 1000 rows. Returns a structured warning
 * envelope when the cap is hit so callers can surface the canonical
 * ROW_CAP_EXCEEDED message to the user without rejecting the response.
 */

import {
  FABORCH_ERROR_CATALOG,
  FabOrchErrorPriority,
  FabOrchErrorType,
  ROW_CAP_LIMIT,
} from './faborch-errors';

interface RowCapWarning {
  type: FabOrchErrorType.ROW_CAP_EXCEEDED;
  priority: FabOrchErrorPriority;
  userMessage: string;
  limit: number;
  totalCount?: number;
}

export interface RowCappedResult<T> {
  rows: T[];
  warning?: RowCapWarning;
}

/**
 * Apply the 1000-row soft cap to an array. If the array exceeds the
 * cap it is truncated and a warning envelope is returned alongside.
 */
export function applyRowCap<T>(rows: T[], totalCount?: number): RowCappedResult<T> {
  if (rows.length <= ROW_CAP_LIMIT && (totalCount === undefined || totalCount <= ROW_CAP_LIMIT)) {
    return { rows };
  }
  const entry = FABORCH_ERROR_CATALOG[FabOrchErrorType.ROW_CAP_EXCEEDED];
  return {
    rows: rows.slice(0, ROW_CAP_LIMIT),
    warning: {
      type: FabOrchErrorType.ROW_CAP_EXCEEDED,
      priority: entry.priority,
      userMessage: entry.userMessage,
      limit: ROW_CAP_LIMIT,
      totalCount,
    },
  };
}

/**
 * Clamp a "limit" / "take" parameter to the row cap. Returns the
 * smaller of the requested value and ROW_CAP_LIMIT.
 */
export function clampLimit(requested: number | undefined, fallback = 100): number {
  const n = Number.isFinite(requested) ? Number(requested) : fallback;
  if (n <= 0) return fallback;
  return Math.min(n, ROW_CAP_LIMIT);
}

export { ROW_CAP_LIMIT };
