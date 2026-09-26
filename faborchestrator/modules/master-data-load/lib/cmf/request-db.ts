import { NextResponse, type NextRequest } from "next/server";

import {
  listEnabledConnections,
  NO_DATABASE_MESSAGE,
  type CmfDbKey,
} from "@/modules/master-data-load/lib/cmf/db-registry";
import { prisma } from "@/shared/lib/db";
import { getUserCmfAccess, pickAllowedKey } from "@/modules/master-data-load/lib/cmf/access";

/**
 * Resolve which CMF database a Master Data Loader request targets.
 *
 * The loader wizard's REST routes (stage/register, validate, load, status,
 * package list) are standalone — unlike the chat tools, they don't receive a
 * `cmfDbs`/`loadDbKey` body. This resolves the active database for them so the
 * `CmfDatabaseToggle` on the loader page actually changes where the load lands.
 *
 * Priority (each step only accepts an ENABLED connection the user is granted):
 *   1. the explicit `x-cmf-db-key` request header — set by the loader's toggle
 *      via `cmfFetch`, so a just-flipped toggle takes effect immediately (before
 *      its async settings PATCH has landed);
 *   2. the user's saved preference (`preferences.cmfLoadDbKey`, or the single
 *      enabled key in `preferences.cmfDb`);
 *   3. the first granted enabled connection;
 *   4. `null` — there is no database (Admin → Database Connections is empty,
 *      or nothing is granted to this user). Routes answer with
 *      `noCmfDatabaseResponse()`; nothing falls back to an env default.
 */
const CMF_DB_HEADER = "x-cmf-db-key";

export async function resolveCmfDbKey(
  request: NextRequest,
  userId?: string | null,
): Promise<CmfDbKey | null> {
  const enabled = (await listEnabledConnections()).map((c) => c.key);
  if (enabled.length === 0) return null;
  const candidate = await resolveCandidateKey(request, userId, new Set(enabled));
  // Enforce per-user access: if the resolved key isn't one the user is granted,
  // fall back to a key they ARE allowed to use (admins bypass via `all`).
  const access = await getUserCmfAccess(userId);
  return pickAllowedKey(access, candidate, enabled);
}

/** The raw key from header → saved preference → none, BEFORE access checks.
 *  Only keys in `enabled` are returned. */
async function resolveCandidateKey(
  request: NextRequest,
  userId: string | null | undefined,
  enabled: Set<string>,
): Promise<CmfDbKey | null> {
  const header = request.headers.get(CMF_DB_HEADER);
  if (header && enabled.has(header)) return header;

  if (userId) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { preferences: true },
      });
      const prefs = (user?.preferences ?? {}) as Record<string, unknown>;
      const loadKey = prefs.cmfLoadDbKey;
      if (typeof loadKey === "string" && enabled.has(loadKey)) return loadKey;
      const cmfDb = prefs.cmfDb as Partial<Record<string, boolean>> | undefined;
      const on = Object.entries(cmfDb ?? {}).filter(([k, v]) => v && enabled.has(k)).map(([k]) => k);
      if (on.length === 1) return on[0];
    } catch {
      /* preference read is best-effort — fall through */
    }
  }

  return null;
}

/**
 * The response a loader route returns when `resolveCmfDbKey` found no database.
 * Same `{ error: { title, description } }` shape as `friendlyErrorPayload`, so
 * the wizard shows it as an ordinary toast. 409: the request is well-formed;
 * the platform is missing the connection it needs.
 */
export function noCmfDatabaseResponse(): NextResponse {
  return NextResponse.json(
    { error: { title: "No database connection", description: NO_DATABASE_MESSAGE, noDatabase: true } },
    { status: 409 },
  );
}
