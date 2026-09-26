/**
 * Pure helpers over a dashboard's cached snapshot (`dashboards.cached_sets`).
 *
 * The alert engine, the baseline sampler and the shift-summary mailer all read
 * metric values from the LAST replay run rather than re-querying any source, so
 * a scheduler pass never opens an MCP round-trip of its own. Everything here is
 * dependency-free so it can be unit-tested.
 */

import { isNumericColumn, type MetricColumn } from '@/modules/fabinsight/lib/replay/columns';
import type { VisibilityDashboard } from '@/modules/fabinsight/lib/visibility';
import { canSee } from '@/modules/fabinsight/lib/visibility';

/** Minimal shape of one cached result set (see replay/paths.ts `SetResult`). */
export type CachedSet = {
  key: string;
  label?: string;
  rows: Record<string, unknown>[];
  columns?: string[];
  error?: string;
  server?: string;
};

/** Coerce a cell to a finite number, else null (decimal-as-string, bit-as-bool tolerant). */
export function toMetricNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
}

/** Parse a stored `cached_sets` JSON value into a safe array of sets. */
export function parseCachedSets(value: unknown): CachedSet[] {
  if (!Array.isArray(value)) return [];
  const out: CachedSet[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.key !== 'string') continue;
    const rows = Array.isArray(s.rows)
      ? (s.rows.filter((r) => r && typeof r === 'object') as Record<string, unknown>[])
      : [];
    out.push({
      key: s.key,
      label: typeof s.label === 'string' ? s.label : s.key,
      rows,
      columns: Array.isArray(s.columns) ? s.columns.filter((c): c is string => typeof c === 'string') : undefined,
      error: typeof s.error === 'string' ? s.error : undefined,
      server: typeof s.server === 'string' ? s.server : undefined,
    });
  }
  return out;
}

/**
 * The value of `column` in the FIRST row of set `setKey`, or null when the set
 * is missing, errored, empty or the cell is not numeric.
 */
export function metricFromSets(sets: CachedSet[], setKey: string, column: string): number | null {
  const set = sets.find((s) => s.key === setKey);
  if (!set || set.error || !set.rows.length) return null;
  return toMetricNumber(set.rows[0][column]);
}

/** Synthetic metric key for a dashboard column. Mirrored in the admin app. */
export function customMetricKey(slug: string, setKey: string, column: string): string {
  return `custom:${slug}:${setKey}:${column}`;
}

/** Inverse of `customMetricKey`. Columns may contain ":" so only the first three parts split. */
export function parseCustomMetricKey(key: string): { slug: string; setKey: string; column: string } | null {
  if (!key.startsWith('custom:')) return null;
  const rest = key.slice('custom:'.length);
  const i = rest.indexOf(':');
  if (i < 0) return null;
  const j = rest.indexOf(':', i + 1);
  if (j < 0) return null;
  const slug = rest.slice(0, i);
  const setKey = rest.slice(i + 1, j);
  const column = rest.slice(j + 1);
  if (!slug || !setKey || !column) return null;
  return { slug, setKey, column };
}

export type Sample = { key: string; value: number };

/**
 * Numeric columns of every healthy set, plus one sample per column taken from the
 * first row — what the baseline sampler records and what the admin form lists.
 */
export function samplesFromSets(sets: CachedSet[], slug: string): { columns: MetricColumn[]; samples: Sample[] } {
  const columns: MetricColumn[] = [];
  const samples: Sample[] = [];
  for (const set of sets) {
    if (set.error || !set.rows.length) continue;
    const keys = set.columns?.length ? set.columns : Object.keys(set.rows[0]);
    for (const col of keys) {
      if (col === 'server' || col === '_item') continue; // fan-out / forEach bookkeeping, not metrics
      if (!isNumericColumn(set.rows, col)) continue;
      columns.push({ setKey: set.key, setLabel: set.label ?? set.key, column: col });
      const v = toMetricNumber(set.rows[0][col]);
      if (v !== null) samples.push({ key: customMetricKey(slug, set.key, col), value: Number(v.toFixed(4)) });
    }
  }
  return { columns, samples };
}

/** Human wording for a snapshot's health, from `last_status` + `refreshed_at`. */
export function snapshotNote(lastStatus: string | null | undefined, refreshedAt: Date | null | undefined, hasSnapshot: boolean): string {
  if (!hasSnapshot) return 'No snapshot yet — this dashboard has not been refreshed.';
  const status = lastStatus ?? '';
  const when = refreshedAt ? ` (last good snapshot ${refreshedAt.toISOString()} UTC)` : '';
  if (status.startsWith('stale:')) return `Last refresh failed — showing previous snapshot${when}. ${status.slice('stale:'.length).trim()}`.trim();
  if (status.startsWith('error:')) return `Last refresh failed — showing previous snapshot${when}. ${status.slice('error:'.length).trim()}`.trim();
  if (status.startsWith('partial')) return `Some sources did not answer at the last refresh${when}.`;
  return refreshedAt ? `Refreshed ${refreshedAt.toISOString()} UTC.` : '';
}

/**
 * Group dashboards by recipient role: a role gets a dashboard when a member of
 * that role (with no personal grants) could open it — visible to all, or the
 * role is listed. `roleIds` empty ⇒ one "all" group with everything that is
 * visible to all.
 */
export function groupDashboardsByRole<T extends VisibilityDashboard>(
  dashboards: T[],
  roleIds: string[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  const roles = roleIds.length ? roleIds : ['*'];
  for (const roleId of roles) {
    const user = { id: '', roleId: roleId === '*' ? null : roleId, isAdmin: false };
    out.set(
      roleId,
      dashboards.filter((d) => canSee(d, user)),
    );
  }
  return out;
}
