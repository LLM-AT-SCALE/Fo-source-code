import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-user / per-role CMF database access grants (`cmf_access`, shared DB).
 *
 * Mirrors `/api/admin/mcp`: the "catalog" is `cmf_connections` (managed at
 * /admin/database-connections); this route lists/grants/revokes which of those a
 * user or role may use. A grant is polymorphic — exactly one of userId/roleId.
 * Fab Orch reads these to filter the DB toggle and gate export/load. Raw SQL
 * (consistent with the cmf_connections routes), admin-gated + audited.
 */

type GrantRow = { id: string; db_key: string; label: string | null };

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const userId = req.nextUrl.searchParams.get("userId");
  const roleId = req.nextUrl.searchParams.get("roleId");
  if ((!userId && !roleId) || (userId && roleId)) {
    return NextResponse.json({ error: "Provide exactly one of userId or roleId." }, { status: 400 });
  }

  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT a.id, a.db_key, c.label
         FROM cmf_access a
         LEFT JOIN cmf_connections c ON c.db_key = a.db_key
        WHERE ${userId ? "a.user_id" : "a.role_id"} = $1
        ORDER BY c.label NULLS LAST, a.db_key`,
      userId ?? roleId,
    )) as GrantRow[];
    return NextResponse.json({
      grants: rows.map((r) => ({ id: r.id, dbKey: r.db_key, label: r.label ?? r.db_key })),
    });
  } catch (e) {
    console.error("[api/admin/cmf-access] GET failed", e);
    return NextResponse.json({ error: "Could not load CMF access grants." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const b = (await req.json().catch(() => ({}))) as { dbKey?: unknown; userId?: unknown; roleId?: unknown };
    const dbKey = typeof b.dbKey === "string" ? b.dbKey.trim() : "";
    const userId = typeof b.userId === "string" && b.userId.trim() ? b.userId.trim() : null;
    const roleId = typeof b.roleId === "string" && b.roleId.trim() ? b.roleId.trim() : null;

    if (!dbKey) return NextResponse.json({ error: "dbKey is required." }, { status: 400 });
    if ((!userId && !roleId) || (userId && roleId)) {
      return NextResponse.json({ error: "Provide exactly one of userId or roleId." }, { status: 400 });
    }

    // Connection must exist.
    const conn = (await prisma.$queryRawUnsafe(
      `SELECT db_key, label FROM cmf_connections WHERE db_key = $1 LIMIT 1`,
      dbKey,
    )) as Array<{ db_key: string; label: string }>;
    if (!conn.length) return NextResponse.json({ error: `No connection with key "${dbKey}".` }, { status: 404 });

    // Target must exist.
    if (userId) {
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!u) return NextResponse.json({ error: "User not found." }, { status: 404 });
    } else if (roleId) {
      const r = await prisma.role.findUnique({ where: { id: roleId }, select: { id: true } });
      if (!r) return NextResponse.json({ error: "Role not found." }, { status: 404 });
    }

    // Dedupe.
    const existing = (await prisma.$queryRawUnsafe(
      `SELECT 1 FROM cmf_access WHERE db_key = $1 AND ${userId ? "user_id" : "role_id"} = $2 LIMIT 1`,
      dbKey,
      userId ?? roleId,
    )) as unknown[];
    if (existing.length) {
      return NextResponse.json({ error: "That database is already granted." }, { status: 409 });
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO cmf_access (id, db_key, user_id, role_id, created_by_id, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, now())`,
      dbKey,
      userId,
      roleId,
      auth.user.id,
    );

    prisma.auditLog
      .create({
        data: {
          userId: auth.user.id,
          action: userId ? "cmf_access.granted_to_user" : "cmf_access.granted_to_role",
          targetType: "CmfAccess",
          targetId: dbKey,
          metadata: { dbKey, label: conn[0].label, userId, roleId },
        },
      })
      .catch(() => {});

    return NextResponse.json({ success: true, dbKey, label: conn[0].label }, { status: 201 });
  } catch (e) {
    console.error("[api/admin/cmf-access] POST failed", e);
    return NextResponse.json({ error: "Could not grant access." }, { status: 500 });
  }
}
