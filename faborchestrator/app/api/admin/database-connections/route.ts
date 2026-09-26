import { splitServerAddress } from "@/modules/master-data-load/lib/cmf/server-address";
import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";
import { encrypt } from "@/shared/lib/encryption";
import { cmfRefresherStatuses, type CmfRefresherStatus } from "@/modules/master-data-load/lib/cmf/token-refresh";
import {
  fetchTokenAfterSave,
  provisionLambdaAfterSave,
  usesLambdaProvisioner,
} from "@/modules/admin/lib/cmf-connections/token-after-save";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-managed CMF database connections (the `cmf_connections` table, shared DB).
 * Fab Orch reads these at runtime (lib/cmf/connection-store) instead of the old
 * hardcoded profiles; the bearer token itself lives in `cmf_bearer_tokens`,
 * written by the in-app refresher (modules/master-data-load/lib/cmf/token-refresh —
 * the scheduler's `cmf-token` stage, plus an immediate fetch on save; the
 * per-connection Lambda only when CMF_TOKEN_PROVISIONER=lambda). Raw SQL for the
 * writes, admin-gated and audited. Secrets are NEVER returned — only a
 * `hasPassword` flag.
 */

type ConnRow = {
  id: string;
  db_key: string;
  label: string;
  engine: string;
  sql_server: string;
  sql_instance: string | null;
  sql_database: string;
  sql_user: string;
  sql_password_encrypted: string | null;
  base_url: string;
  host_resolver: unknown;
  token_db_name: string;
  token_secret_id: string | null;
  portal_user: string | null;
  portal_password_encrypted: string | null;
  lambda_arn: string | null;
  schedule_name: string | null;
  enabled: boolean;
  updated_at: Date;
};

function toClient(r: ConnRow, refresher?: CmfRefresherStatus) {
  return {
    id: r.id,
    dbKey: r.db_key,
    label: r.label,
    engine: r.engine,
    sqlServer: r.sql_server,
    sqlInstance: r.sql_instance,
    sqlDatabase: r.sql_database,
    sqlUser: r.sql_user,
    hasPassword: !!r.sql_password_encrypted,
    baseUrl: r.base_url,
    hostResolver: Array.isArray(r.host_resolver) ? r.host_resolver : [],
    tokenDbName: r.token_db_name,
    tokenSecretId: r.token_secret_id,
    portalUser: r.portal_user,
    hasPortalPassword: !!r.portal_password_encrypted,
    lambdaArn: r.lambda_arn,
    scheduleName: r.schedule_name,
    provisioned: !!r.lambda_arn,
    /** In-app token refresher status: "In-app · refreshed 5 min ago · expires in 52 min", "In-app · failed: …", "No portal credentials". */
    refresher: refresher ?? null,
    enabled: r.enabled,
    updatedAt: r.updated_at,
  };
}

/** Normalize host_resolver input into a clean [[host,ip], ...] array. */
/** Derive the host→IP mapping from the base URL host + server IP, so on-prem
 *  hosts (no public DNS) resolve without the admin entering it by hand. */
function deriveResolver(baseUrl: string, server: string): Array<[string, string]> {
  try {
    const host = new URL(baseUrl).host;
    return host && server ? [[host, server]] : [];
  } catch {
    return [];
  }
}

/** Turn a label into a stable, URL/Lambda-safe internal key. */
function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** The row id for a connection key (the Lambda path updates the row by id). */
async function idForKey(dbKey: string): Promise<string | null> {
  const rows = (await prisma.$queryRawUnsafe(`SELECT id FROM cmf_connections WHERE db_key = $1`, dbKey)) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/** Return `base`, or `base-2`/`base-3`/… if it's already taken. */
async function uniqueKey(base: string): Promise<string> {
  const root = base || "db";
  let key = root;
  for (let i = 2; i < 1000; i++) {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT 1 FROM cmf_connections WHERE db_key = $1 LIMIT 1`,
      key,
    )) as unknown[];
    if (!rows.length) return key;
    key = `${root}-${i}`;
  }
  return `${root}-${Date.now()}`;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT id, db_key, label, engine, sql_server, sql_instance, sql_database, sql_user,
              sql_password_encrypted, base_url, host_resolver, token_db_name,
              token_secret_id, portal_user, portal_password_encrypted, lambda_arn, schedule_name,
              enabled, updated_at
         FROM cmf_connections
        ORDER BY db_key`,
    )) as ConnRow[];
    const statuses = await cmfRefresherStatuses(
      rows.map((r) => ({
        dbKey: r.db_key,
        tokenDbName: r.token_db_name,
        enabled: r.enabled,
        portalUser: r.portal_user,
        hasPortalPassword: !!r.portal_password_encrypted,
        lambdaArn: r.lambda_arn,
      })),
    );
    return NextResponse.json({ connections: rows.map((r) => toClient(r, statuses.get(r.db_key))) });
  } catch (e) {
    console.error("[api/admin/database-connections] GET failed", e);
    return NextResponse.json({ error: "Could not load database connections." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const label = String(b.label ?? "").trim();
    // "10.10.1.224/ONLINE" or "10.10.1.224\\ONLINE" is split into server + instance.
    const serverParts = splitServerAddress(String(b.sqlServer ?? ""));
    const sqlServer = serverParts.host;
    const sqlDatabase = String(b.sqlDatabase ?? "").trim();
    const sqlUser = String(b.sqlUser ?? "").trim();
    const baseUrl = String(b.baseUrl ?? "").trim();
    // Token key is set to the UNIQUE db_key below (not the database name) — see note there.

    const missing = [
      ["label", label],
      ["sqlServer", sqlServer],
      ["sqlDatabase", sqlDatabase],
      ["sqlUser", sqlUser],
      ["baseUrl", baseUrl],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      return NextResponse.json({ error: `Missing required field(s): ${missing.join(", ")}.` }, { status: 400 });
    }

    // Key is an INTERNAL stable identifier — the user never sets or sees it. It is
    // auto-derived from the label (an explicit b.dbKey is honoured only for
    // advanced/import use), made unique with a numeric suffix.
    const keyBase = typeof b.dbKey === "string" && b.dbKey.trim() ? slugify(b.dbKey) : slugify(label);
    const dbKey = await uniqueKey(keyBase);

    // Token key = the UNIQUE connection key, NOT the database name. Two
    // connections can legitimately share a database name (e.g.
    // "CriticalManufacturing" on different servers); keying the bearer-token row
    // by database name made them overwrite each other's token. db_key is unique
    // per connection, so each gets its own token row. The refresher writes the
    // token under this same value, and Fab Orch reads it by the connection's
    // token_db_name — so the two always match.
    const tokenDbName = dbKey;

    const password = typeof b.password === "string" ? b.password : "";
    if (!password) {
      return NextResponse.json({ error: "SQL password is required." }, { status: 400 });
    }
    const encrypted = encrypt(password);
    // Host→IP mapping is auto-derived from the base URL host + server IP (on-prem
    // hosts have no public DNS). Not a user-facing field.
    const resolver = deriveResolver(baseUrl, sqlServer);
    const sqlInstance = typeof b.sqlInstance === "string" && b.sqlInstance.trim() ? b.sqlInstance.trim() : serverParts.instance ?? null;
    const tokenSecretId = null; // token comes from the DB (written by the refresher Lambda); no legacy fallback needed
    const engine = typeof b.engine === "string" && b.engine.trim() ? b.engine.trim() : "mssql";
    const enabled = b.enabled === undefined ? true : !!b.enabled;

    // Portal login credentials — used by the token refresher to log in to the
    // CMF portal (DISTINCT from the SQL user/password).
    const portalUser = typeof b.portalUser === "string" && b.portalUser.trim() ? b.portalUser.trim() : null;
    const portalPassword = typeof b.portalPassword === "string" ? b.portalPassword : "";
    const portalEncrypted = portalPassword ? encrypt(portalPassword) : null;

    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO cmf_connections
           (id, db_key, label, engine, sql_server, sql_instance, sql_database, sql_user,
            sql_password_encrypted, base_url, host_resolver, token_db_name,
            token_secret_id, portal_user, portal_password_encrypted, enabled, created_by_id, created_at, updated_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, now(), now())`,
        dbKey,
        label,
        engine,
        sqlServer,
        sqlInstance,
        sqlDatabase,
        sqlUser,
        encrypted,
        baseUrl,
        JSON.stringify(resolver),
        tokenDbName,
        tokenSecretId,
        portalUser,
        portalEncrypted,
        enabled,
        auth.user.id,
      );
    } catch (err) {
      // Unique violation on db_key
      if (String((err as { message?: string })?.message ?? "").includes("cmf_connections_db_key_key")) {
        return NextResponse.json({ error: `A connection with key "${dbKey}" already exists.` }, { status: 409 });
      }
      throw err;
    }

    // Fetch the token now (in-app portal login, awaited up to CMF_TOKEN_SAVE_TIMEOUT_MS)
    // so the admin learns within seconds whether the portal credentials work. The
    // row is already saved; a login failure is reported, never hides the save.
    // Legacy: CMF_TOKEN_PROVISIONER=lambda provisions the per-connection Lambda instead.
    const hasPortalCredentials = !!(portalUser && portalPassword);
    const outcome = usesLambdaProvisioner()
      ? await provisionLambdaAfterSave({ id: (await idForKey(dbKey)) ?? "", verb: "saved", portalPassword })
      : await fetchTokenAfterSave({ dbKey, verb: "saved", userId: auth.user.id, hasPortalCredentials });

    prisma.auditLog
      .create({
        data: {
          userId: auth.user.id,
          action: "cmf_connection.create",
          targetType: "CmfConnection",
          targetId: dbKey,
          metadata: {
            dbKey, label, sqlServer, sqlDatabase, baseUrl, tokenDbName,
            passwordStored: !!encrypted, portalCreds: hasPortalCredentials, enabled,
            token: outcome.token,
          },
        },
      })
      .catch(() => {});

    return NextResponse.json({ success: true, dbKey, message: outcome.message, warning: outcome.warning, token: outcome.token });
  } catch (e) {
    console.error("[api/admin/database-connections] POST failed", e);
    return NextResponse.json({ error: "Could not create the connection." }, { status: 500 });
  }
}
