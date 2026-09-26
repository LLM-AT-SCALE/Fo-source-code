import { AsyncLocalStorage } from "node:async_hooks";
import { CmfNoDatabaseError, type CmfDbKey } from "@/modules/master-data-load/lib/cmf/db-registry";

/**
 * Request-scoped "which CMF database" selector.
 *
 * The app can talk to any number of admin-managed CMF databases. A single chat
 * turn can EXPORT from one and LOAD into another, so "which DB" is per-operation,
 * not per-process. Rather than thread a `dbKey` parameter through the ~6-level
 * export/load call chains (error-prone: one un-threaded intermediate silently
 * falls back to a default), we carry it in an AsyncLocalStorage store.
 *
 * The leaf connection primitives (cmfQuery, getMesToken, baseUrl) and the
 * per-DB caches call `currentDbKey()` to resolve the active database. There is
 * NO default: a code path not wrapped in `runWithCmfDb` — or wrapped with no
 * database because Admin → Database Connections is empty — gets a
 * `CmfNoDatabaseError`, which the tools and routes turn into a calm message.
 * Nothing ever falls back to an env-configured database.
 *
 * AsyncLocalStorage propagates across await / Promise.all / timers / the undici
 * fetch stack (Node ≥16), so a store entered at the tool boundary is inherited
 * by every descendant CMF call.
 */

type CmfDbStore = { dbKey: CmfDbKey };

const als = new AsyncLocalStorage<CmfDbStore>();

/** Run `fn` with `dbKey` as the active CMF database for all nested CMF calls. */
export function runWithCmfDb<T>(dbKey: CmfDbKey, fn: () => Promise<T>): Promise<T> {
  return als.run({ dbKey }, fn);
}

/** The active CMF database key for the current async context, or null when none is selected. */
export function currentDbKeyOrNull(): CmfDbKey | null {
  return als.getStore()?.dbKey ?? null;
}

/** The active CMF database key; throws `CmfNoDatabaseError` when none is selected. */
export function currentDbKey(): CmfDbKey {
  const key = currentDbKeyOrNull();
  if (!key) throw new CmfNoDatabaseError();
  return key;
}
