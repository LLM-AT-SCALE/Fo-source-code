"use client";

/**
 * Client-side auth for the Modeling Agent wizard fetches.
 *
 * The ported cmf-loader wizard called `fetch()` relying on a NextAuth cookie.
 * The fab app authenticates with a bearer token (localStorage), so wizard
 * requests must carry the Authorization header. `cmfFetch` injects it.
 */
const AUTH_TOKEN_KEY = "llmatscale_auth_token";
/** Active CMF database (an admin-created connection's db_key) chosen by the CmfDatabaseToggle. */
export const CMF_ACTIVE_DB_KEY = "cmf_active_db";
const CMF_DB_HEADER = "x-cmf-db-key";

export function authHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Which CMF database the loader routes should target, mirrored to a header.
 *  The server accepts it only if it names an enabled connection the user is
 *  granted (request-db.ts), so any string is safe to send. */
function cmfDbHeader(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const db = localStorage.getItem(CMF_ACTIVE_DB_KEY);
  return db ? { [CMF_DB_HEADER]: db } : {};
}

export function cmfFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: { ...authHeaders(), ...cmfDbHeader(), ...(init.headers ?? {}) },
  });
}
