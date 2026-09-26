/**
 * Per-user CMF database access resolution.
 *
 * A user may only see/use the CMF connections granted to them. A grant lives in
 * `cmf_access` and is either direct (user_id) or inherited from the user's role
 * (role_id). Effective access = the UNION of both. Admins bypass entirely.
 *
 * This is the single source of truth the three enforcement points call:
 *   - app/api/cmf/connections (filter the toggle list)
 *   - modules/master-data-load/lib/cmf/request-db (validate the loader's target DB)
 *   - app/api/modeling-agent/chat (validate export/load DB from the request body)
 *
 * Never trust a client-supplied dbKey — always intersect it with this set.
 */

import { prisma } from "@/shared/lib/db";
import { isPlatformAdmin } from '@/shared/lib/permissions';

export type CmfAccess = {
  /** Admin (or otherwise unrestricted) — may use every connection. */
  all: boolean;
  /** The specific db_keys this user may use (ignored when `all`). */
  keys: Set<string>;
};

/** Resolve a user's effective CMF access (union of user + role grants). Fails
 *  CLOSED (empty set) on any error so a fault can't widen access. */
export async function getUserCmfAccess(userId: string | null | undefined): Promise<CmfAccess> {
  if (!userId) return { all: false, keys: new Set() };
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { isAdmin: true, roleId: true, role: { select: { name: true, permissions: true } } },
    });
    if (!user) return { all: false, keys: new Set() };
    if (isPlatformAdmin(user)) return { all: true, keys: new Set() };

    const grants = await prisma.cmfAccess.findMany({
      where: { OR: [{ userId }, ...(user.roleId ? [{ roleId: user.roleId }] : [])] },
      select: { dbKey: true },
    });
    return { all: false, keys: new Set(grants.map((g) => g.dbKey)) };
  } catch (e) {
    console.error("[cmf-access] getUserCmfAccess failed — denying access", e);
    return { all: false, keys: new Set() };
  }
}

/** The subset of `candidates` (enabled connections) this user may use, in order. */
export function grantedKeys(access: CmfAccess, candidates: readonly string[]): string[] {
  return access.all ? [...candidates] : candidates.filter((k) => access.keys.has(k));
}

/**
 * Pick the db_key the user actually uses: the requested `preferred` when it is
 * an enabled connection they are granted, else the FIRST granted enabled
 * connection, else `null` — there is no database. `candidates` is the list of
 * enabled connections (`listEnabledConnections`); nothing outside it is ever
 * returned, so a disabled/removed connection can't be selected via a stale
 * preference or a crafted header.
 */
export function pickAllowedKey(
  access: CmfAccess,
  preferred: string | null | undefined,
  candidates: readonly string[],
): string | null {
  const granted = grantedKeys(access, candidates);
  if (preferred && granted.includes(preferred)) return preferred;
  return granted[0] ?? null;
}
