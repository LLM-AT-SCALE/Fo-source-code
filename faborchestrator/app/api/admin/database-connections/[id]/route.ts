import { splitServerAddress } from "@/modules/master-data-load/lib/cmf/server-address";
import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";
import { encrypt, decrypt } from "@/shared/lib/encryption";
import { deprovisionConnectionLambda } from "@/modules/admin/lib/mcp/cmf-lambda/provision";
import {
  fetchTokenAfterSave,
  provisionLambdaAfterSave,
  usesLambdaProvisioner,
  type SaveTokenOutcome,
} from "@/modules/admin/lib/cmf-connections/token-after-save";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Update / delete a single CMF database connection (cmf_connections). db_key is
 * immutable (it's the stable identity Fab Orch selects by). Password is
 * write-only: send a non-empty `password` to (re)store it encrypted, send the
 * empty string / omit it to leave the stored one untouched. Admin-gated + audited.
 */

/** Derive the host→IP mapping from the base URL host + server IP (auto). */
function deriveResolver(baseUrl: string, server: string): Array<[string, string]> {
  try {
    const host = new URL(baseUrl).host;
    return host && server ? [[host, server]] : [];
  } catch {
    return [];
  }
}

/**
 * Return the connection's decrypted SQL + portal passwords so the admin Edit
 * dialog can pre-fill (and reveal) them. Admin-gated + audited. Only the edit
 * dialog calls this — the list endpoint still returns just a `hasPassword` flag.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT sql_password_encrypted, portal_password_encrypted FROM cmf_connections WHERE id = $1`,
      id,
    )) as Array<{ sql_password_encrypted: string | null; portal_password_encrypted: string | null }>;
    if (!rows.length) {
      return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    }
    const r = rows[0];
    let sqlPassword = "";
    let portalPassword = "";
    try { if (r.sql_password_encrypted) sqlPassword = decrypt(r.sql_password_encrypted); } catch { /* leave blank on decrypt failure */ }
    try { if (r.portal_password_encrypted) portalPassword = decrypt(r.portal_password_encrypted); } catch { /* leave blank */ }

    prisma.auditLog
      .create({
        data: {
          userId: auth.user.id,
          action: "cmf_connection.reveal",
          targetType: "CmfConnection",
          targetId: id,
          metadata: {},
        },
      })
      .catch(() => {});

    return NextResponse.json({ sqlPassword, portalPassword });
  } catch (e) {
    console.error("[api/admin/database-connections/[id]] GET failed", e);
    return NextResponse.json({ error: "Could not load the connection." }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  try {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const label = String(b.label ?? "").trim();
    // "10.10.1.224/ONLINE" or "10.10.1.224\\ONLINE" is split into server + instance.
    const serverParts = splitServerAddress(String(b.sqlServer ?? ""));
    const sqlServer = serverParts.host;
    const sqlDatabase = String(b.sqlDatabase ?? "").trim();
    const sqlUser = String(b.sqlUser ?? "").trim();
    const baseUrl = String(b.baseUrl ?? "").trim();
    // Token key = the connection's immutable, UNIQUE db_key — never the database
    // name (two connections can share one, e.g. "CriticalManufacturing" on
    // different servers, and would collide on a single bearer-token row). This
    // also migrates any pre-existing connection onto its own key when it's saved.
    const existingRow = (await prisma.$queryRawUnsafe(
      `SELECT db_key FROM cmf_connections WHERE id = $1`,
      id,
    )) as Array<{ db_key: string }>;
    if (!existingRow.length) {
      return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    }
    const tokenDbName = existingRow[0].db_key;

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

    const password = typeof b.password === "string" ? b.password : "";
    const resolver = deriveResolver(baseUrl, sqlServer);
    const sqlInstance = typeof b.sqlInstance === "string" && b.sqlInstance.trim() ? b.sqlInstance.trim() : serverParts.instance ?? null;
    const engine = typeof b.engine === "string" && b.engine.trim() ? b.engine.trim() : "mssql";
    const enabled = b.enabled === undefined ? true : !!b.enabled;

    // Passwords are optional on edit: only overwrite the ciphertext when a new
    // one is supplied. COALESCE keeps the existing value when we pass NULL.
    const newEncrypted = password ? encrypt(password) : null;
    const portalUser = typeof b.portalUser === "string" && b.portalUser.trim() ? b.portalUser.trim() : null;
    const portalPassword = typeof b.portalPassword === "string" ? b.portalPassword : "";
    const newPortalEncrypted = portalPassword ? encrypt(portalPassword) : null;

    const affected = await prisma.$executeRawUnsafe(
      `UPDATE cmf_connections SET
         label = $1,
         engine = $2,
         sql_server = $3,
         sql_instance = $4,
         sql_database = $5,
         sql_user = $6,
         sql_password_encrypted = COALESCE($7, sql_password_encrypted),
         base_url = $8,
         host_resolver = $9::jsonb,
         token_db_name = $10,
         portal_user = $11,
         portal_password_encrypted = COALESCE($12, portal_password_encrypted),
         enabled = $13,
         updated_at = now()
       WHERE id = $14`,
      label,
      engine,
      sqlServer,
      sqlInstance,
      sqlDatabase,
      sqlUser,
      newEncrypted,
      baseUrl,
      JSON.stringify(resolver),
      tokenDbName,
      portalUser,
      newPortalEncrypted,
      enabled,
      id,
    );

    if (!affected) {
      return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    }

    // Fetch the token with the edited credentials right away (in-app portal
    // login; the effective portal password is the just-supplied one, else the
    // stored one) so the admin sees whether they work. Never fails the save.
    // Legacy: CMF_TOKEN_PROVISIONER=lambda re-provisions the connection's Lambda.
    const after = (await prisma.$queryRawUnsafe(
      `SELECT db_key, portal_user, portal_password_encrypted FROM cmf_connections WHERE id = $1`,
      id,
    )) as Array<{ db_key: string; portal_user: string | null; portal_password_encrypted: string | null }>;
    const r = after[0];
    const hasPortalCredentials = !!(r?.portal_user && r.portal_password_encrypted);
    let outcome: SaveTokenOutcome;
    if (usesLambdaProvisioner()) {
      let effectivePortalPassword = portalPassword;
      if (!effectivePortalPassword && r?.portal_password_encrypted) {
        try { effectivePortalPassword = decrypt(r.portal_password_encrypted); } catch { effectivePortalPassword = ""; }
      }
      outcome = await provisionLambdaAfterSave({ id, verb: "updated", portalPassword: effectivePortalPassword });
    } else {
      outcome = await fetchTokenAfterSave({ dbKey: r?.db_key ?? tokenDbName, verb: "updated", userId: auth.user.id, hasPortalCredentials });
    }

    prisma.auditLog
      .create({
        data: {
          userId: auth.user.id,
          action: "cmf_connection.update",
          targetType: "CmfConnection",
          targetId: id,
          metadata: { label, sqlServer, sqlDatabase, baseUrl, tokenDbName, passwordChanged: !!newEncrypted, portalPasswordChanged: !!newPortalEncrypted, enabled, token: outcome.token },
        },
      })
      .catch(() => {});

    return NextResponse.json({ success: true, message: outcome.message, warning: outcome.warning, token: outcome.token });
  } catch (e) {
    console.error("[api/admin/database-connections/[id]] PATCH failed", e);
    return NextResponse.json({ error: "Could not update the connection." }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    // Look up the key first: its token row goes with it, and — legacy — its Lambda.
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT db_key, token_db_name, lambda_arn FROM cmf_connections WHERE id = $1`,
      id,
    )) as Array<{ db_key: string; token_db_name: string; lambda_arn: string | null }>;
    const dbKey = rows[0]?.db_key;
    if (!dbKey) {
      return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    }

    // Legacy only: tear down the token Lambda + schedule when the Lambda provisioner
    // is still in use and the row records one (best-effort; ignores NotFound). With
    // the in-app refresher there is no Lambda, so nothing to remove and no AWS call.
    if (usesLambdaProvisioner() && rows[0].lambda_arn) {
      await deprovisionConnectionLambda(dbKey).catch((e) =>
        console.error("[api/admin/database-connections/[id]] deprovision failed", e),
      );
    }

    const affected = await prisma.$executeRawUnsafe(`DELETE FROM cmf_connections WHERE id = $1`, id);
    if (!affected) {
      return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    }
    // The connection's bearer token is keyed by its own token_db_name; nothing else reads it.
    await prisma.$executeRawUnsafe(`DELETE FROM cmf_bearer_tokens WHERE cmf_database_name = $1`, rows[0].token_db_name).catch(() => {});
    prisma.auditLog
      .create({
        data: {
          userId: auth.user.id,
          action: "cmf_connection.delete",
          targetType: "CmfConnection",
          targetId: id,
          metadata: {},
        },
      })
      .catch(() => {});
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("[api/admin/database-connections/[id]] DELETE failed", e);
    return NextResponse.json({ error: "Could not delete the connection." }, { status: 500 });
  }
}
