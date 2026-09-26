/**
 * FabOrch Audit — runtime loader for the canonical error catalog.
 *
 * Source of truth at runtime is the `error_catalog` table in RDS. The
 * frozen `FABORCH_ERROR_CATALOG` constant is kept ONLY as an emergency
 * fallback for the case where the DB read itself fails (network blip,
 * RDS unreachable, table dropped). In normal operation, every error
 * message rendered to a user comes from the table.
 *
 * Behaviour:
 *  - Lazy: first call returns the hardcoded fallback and kicks an
 *    async refresh.
 *  - Cached: subsequent calls hit memory (zero DB cost on the hot path).
 *  - Self-refreshing: every TTL_MS, the next call triggers a background
 *    refresh. Admin edits to the table propagate within ~1 min without
 *    redeploy.
 *  - Fail-safe: any DB read error is logged and silently swallowed —
 *    the cache (or hardcoded fallback) is reused. Error rendering must
 *    NEVER itself fail because of catalog issues.
 *  - Single-flight: concurrent refreshes collapse into one query.
 */
import { prisma } from '@/shared/lib/db';
import { logger } from '@/shared/lib/logger';
import {
  FABORCH_ERROR_CATALOG,
  FabOrchErrorPriority,
  FabOrchErrorType,
} from './error-catalog-defaults';
import type { FabOrchErrorEntry } from './error-catalog-defaults';

const TTL_MS = 60_000;

type CatalogMap = Record<FabOrchErrorType, FabOrchErrorEntry>;

// Lazy-init: don't touch FABORCH_ERROR_CATALOG at module init time
// because faborch-errors.ts imports getErrorEntry from this file (a
// circular import). At module init the binding can be undefined; by
// the time getErrorEntry is *called* at runtime, both modules are
// fully evaluated and the import resolves correctly.
let cache: CatalogMap | null = null;
let cacheLoadedAt = 0;
let inflight: Promise<void> | null = null;

interface CatalogRow {
  error_type: string;
  user_message: string;
  priority: string;
  http_status: number;
}

function isKnownPriority(s: string): s is FabOrchErrorPriority {
  return s === FabOrchErrorPriority.HIGH || s === FabOrchErrorPriority.MEDIUM;
}

function isKnownType(s: string): s is FabOrchErrorType {
  return Object.values(FabOrchErrorType).includes(s as FabOrchErrorType);
}

async function refreshCache(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const rows = (await prisma.$queryRawUnsafe(
        `SELECT error_type, user_message, priority, http_status FROM error_catalog`
      )) as CatalogRow[];

      // Start from the hardcoded fallback so any rows missing from the
      // table still resolve to a sensible value.
      const next: CatalogMap = { ...FABORCH_ERROR_CATALOG };
      for (const r of rows) {
        if (!isKnownType(r.error_type)) continue;     // unknown type — skip
        if (!isKnownPriority(r.priority)) continue;   // bad priority — skip, keep fallback
        next[r.error_type] = {
          type: r.error_type,
          userMessage: r.user_message,
          priority: r.priority,
          httpStatus: r.http_status,
        };
      }
      cache = next;
      cacheLoadedAt = Date.now();
    } catch (err) {
      // Never let catalog load failure break error rendering. Keep the
      // existing cache (or hardcoded fallback if this is the first load).
      logger.fabOrchError(err as Error, { route: 'error-catalog-loader' });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Synchronously return the catalog entry for a given type.
 *
 * If the cache is stale, this fires an async refresh and returns the
 * current (possibly stale, possibly hardcoded-fallback) value
 * immediately — the next call will get the fresh value.
 */
export function getErrorEntry(type: FabOrchErrorType): FabOrchErrorEntry {
  if (Date.now() - cacheLoadedAt > TTL_MS) {
    void refreshCache();
  }
  return cache?.[type] ?? FABORCH_ERROR_CATALOG[type];
}
