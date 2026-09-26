/**
 * CMF database registry — which Critical Manufacturing databases the Master
 * Data Load agent can talk to, and how to reach each one.
 *
 * The ONLY databases the agent knows are the ENABLED rows an admin created in
 * Admin → Database Connections (`cmf_connections`), narrowed per user by their
 * grants (`cmf_access`). There is no default database: with no enabled rows the
 * toggle is empty, the health pill has nothing to count and every CMF-touching
 * tool/route answers with `CmfNoDatabaseError` instead of silently using an
 * env-default profile.
 *
 *  - NON-SECRET connection facts (SQL host/instance/db, REST base URL, host→IP,
 *    token secret id) live on the connection row.
 *  - The only real SECRET — the SQL password — is the row's encrypted column,
 *    decrypted into the in-memory cache by connection-store.
 *  - The bearer TOKEN is never minted here: a separate Lambda mints it and
 *    publishes it (see cmf-auth.ts); we only READ it by `tokenDbName`.
 *
 * Local development only: `CMF_BUILTIN_PROFILES=1` adds two env-driven profiles
 * ("source" / "target", from CMF_SQL_* / CMF_BASE_URL / HOST_RESOLVER and their
 * *_TARGET twins) so a developer can point at a CMF without an admin row. It is
 * off by default and must stay off in every deployed environment.
 */

import { getCachedProfile, ensureConnectionsFresh, refreshConnections } from "@/modules/master-data-load/lib/cmf/connection-store";
import { prisma } from "@/shared/lib/db";

/** A CMF database key: an admin-created connection's `db_key`. Any string. */
export type CmfDbKey = string;

interface CmfDbSqlConfig {
  server: string;
  database: string;
  instanceName?: string;
  user: string;
  /** Plaintext SQL password, decrypted from the connection row at load. Absent
   *  when the row has none — the SQL connector then refuses to connect. */
  password?: string;
}

export interface CmfDbProfile {
  id: CmfDbKey;
  /** Human label for the toggle UI. */
  label: string;
  sql: CmfDbSqlConfig;
  /** CMF MES REST base URL. */
  baseUrl: string;
  /** host→IP pairs merged into the undici resolver (on-prem hosts w/o public DNS). */
  hostResolver: Array<[host: string, ip: string]>;
  /** AWS Secrets Manager secret id holding this DB's bearer token (legacy source;
   *  used as a fallback while migrating to the DB-backed token table). */
  tokenSecretId: string;
  /** Key into the `cmf_bearer_tokens` table (the auth Lambda writes the JWT here
   *  every ~45 min, keyed by CMF database name). Preferred token source. */
  tokenDbName: string;
}

/** A selectable connection as the toggle / health pill / chat route see it. */
export type CmfConnectionOption = { key: CmfDbKey; label: string };

/** What a user reads when the agent has no database to work with. */
export const NO_DATABASE_MESSAGE =
  "No database connection is available for the Master Data Load agent. " +
  "An administrator adds one in Admin → Database Connections and grants you access to it.";

/**
 * Thrown wherever CMF work is attempted with no selected/known database. It is
 * an EXPECTED condition (an empty Admin → Database Connections), not a fault:
 * callers turn it into a calm message and never record it in the error log.
 */
export class CmfNoDatabaseError extends Error {
  constructor(message: string = NO_DATABASE_MESSAGE) {
    super(message);
    this.name = "CmfNoDatabaseError";
  }
}

/* ------------------------------------------------------------------------ */
/* Local-development built-ins (opt-in)                                      */
/* ------------------------------------------------------------------------ */

/** `CMF_BUILTIN_PROFILES=1` (local development only) enables the two env-driven profiles below. */
const BUILTIN_PROFILES_ENABLED = process.env.CMF_BUILTIN_PROFILES === "1";

/** Parse "host=ip[,host=ip]" (the legacy HOST_RESOLVER format) into pairs. */
function parseHostResolver(raw: string | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const pair of (raw ?? "").split(",")) {
    const [host, ip] = pair.split("=").map((s) => s.trim());
    if (host && ip) out.push([host, ip]);
  }
  return out;
}

function envBuiltins(): Record<string, CmfDbProfile> {
  const source: CmfDbProfile = {
    id: "source",
    label: process.env.CMF_LABEL ?? "Source (env)",
    sql: {
      server: process.env.CMF_SQL_SERVER ?? "",
      database: process.env.CMF_SQL_DB ?? "",
      instanceName: process.env.CMF_SQL_INSTANCE || undefined,
      user: process.env.CMF_SQL_USER ?? "",
      password: process.env.CMF_SQL_PASS,
    },
    baseUrl: process.env.CMF_BASE_URL ?? "",
    hostResolver: parseHostResolver(process.env.HOST_RESOLVER),
    tokenSecretId: process.env.CMF_TOKEN_SECRET_ID ?? "",
    tokenDbName: process.env.CMF_SQL_DB ?? "",
  };
  const target: CmfDbProfile = {
    id: "target",
    label: process.env.CMF_LABEL_TARGET ?? "Target (env)",
    sql: {
      server: process.env.CMF_SQL_SERVER_TARGET ?? "",
      database: process.env.CMF_SQL_DB_TARGET ?? "",
      instanceName: process.env.CMF_SQL_INSTANCE_TARGET || undefined,
      user: process.env.CMF_SQL_USER_TARGET ?? "",
      password: process.env.CMF_SQL_PASS_TARGET,
    },
    baseUrl: process.env.CMF_BASE_URL_TARGET ?? "",
    hostResolver: parseHostResolver(process.env.HOST_RESOLVER_TARGET),
    tokenSecretId: process.env.CMF_TOKEN_SECRET_ID_TARGET ?? "",
    tokenDbName: process.env.CMF_SQL_DB_TARGET ?? "",
  };
  // Only a profile with at least a REST base URL or a SQL server is offered.
  const out: Record<string, CmfDbProfile> = {};
  for (const p of [source, target]) if (p.baseUrl || p.sql.server) out[p.id] = p;
  return out;
}

const BUILTINS: Record<string, CmfDbProfile> = BUILTIN_PROFILES_ENABLED ? envBuiltins() : {};

/** The opt-in local-development profiles; empty unless CMF_BUILTIN_PROFILES=1. */
export function builtinProfiles(): Readonly<Record<string, CmfDbProfile>> {
  return BUILTINS;
}

/* ------------------------------------------------------------------------ */
/* Lookup                                                                    */
/* ------------------------------------------------------------------------ */

/** True if `key` names a KNOWN CMF database — an enabled admin-managed
 *  connection currently in the cache (or an opt-in built-in). Used to validate
 *  untrusted input (request headers, saved prefs) before selecting a database. */
export function isCmfDbKey(key: string): boolean {
  if (!key) return false;
  return getCachedProfile(key) !== undefined || key in BUILTINS;
}

/**
 * Resolve a profile by key. Throws `CmfNoDatabaseError` on an unknown key.
 *
 * Reads the admin-managed connection row from the in-memory cache that
 * connection-store fills from `cmf_connections` (refreshed in the background;
 * this call never blocks on the DB). There is no env fallback: a key with no
 * enabled row is not a database the agent may use.
 */
export function profileFor(key: string): CmfDbProfile {
  const cached = getCachedProfile(key);
  void ensureConnectionsFresh();
  const p = cached ?? BUILTINS[key];
  if (!p) {
    throw new CmfNoDatabaseError(
      key
        ? `The database connection "${key}" is not available. It may have been disabled or removed in Admin → Database Connections.`
        : NO_DATABASE_MESSAGE,
    );
  }
  return p;
}

/**
 * The ENABLED connections, straight from `cmf_connections` (plus the opt-in
 * built-ins), as `{ key, label }` sorted by label. This is the single list the
 * toggle, the health pill and the request/chat routes select from — read from
 * the DB (not the cache) so a connection an admin just added is usable at once.
 * NOT filtered by user grants; callers intersect with `getUserCmfAccess`.
 */
export async function listEnabledConnections(): Promise<CmfConnectionOption[]> {
  const rows = await prisma.cmfConnection.findMany({
    where: { enabled: true },
    select: { dbKey: true, label: true },
    orderBy: { label: "asc" },
  });
  const out: CmfConnectionOption[] = rows.map((r) => ({ key: r.dbKey, label: r.label }));
  // A row the profile cache hasn't seen yet (just created, or a cold process)
  // would make `profileFor` fail for a key this very list offers — warm it now.
  if (out.some((c) => getCachedProfile(c.key) === undefined)) await refreshConnections();
  const seen = new Set(out.map((c) => c.key));
  for (const p of Object.values(BUILTINS)) {
    if (!seen.has(p.id)) out.push({ key: p.id, label: p.label });
  }
  return out;
}
