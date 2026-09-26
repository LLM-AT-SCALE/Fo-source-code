import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Revoke a single CMF access grant (by cmf_access.id). Admin-gated + audited. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT db_key, user_id, role_id FROM cmf_access WHERE id = $1`,
      id,
    )) as Array<{ db_key: string; user_id: string | null; role_id: string | null }>;
    const row = rows[0];
    if (!row) return NextResponse.json({ error: "Grant not found." }, { status: 404 });

    await prisma.$executeRawUnsafe(`DELETE FROM cmf_access WHERE id = $1`, id);

    prisma.auditLog
      .create({
        data: {
          userId: auth.user.id,
          action: row.user_id ? "cmf_access.revoked_from_user" : "cmf_access.revoked_from_role",
          targetType: "CmfAccess",
          targetId: row.db_key,
          metadata: { dbKey: row.db_key, userId: row.user_id, roleId: row.role_id },
        },
      })
      .catch(() => {});

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("[api/admin/cmf-access/[id]] DELETE failed", e);
    return NextResponse.json({ error: "Could not revoke access." }, { status: 500 });
  }
}
