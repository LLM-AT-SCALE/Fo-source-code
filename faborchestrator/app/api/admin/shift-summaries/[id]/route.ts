import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Existing = { id: string; name: string; send_time: string; timezone: string };

const isHM = (v: unknown) => typeof v === "string" && /^(\d{1,2}):(\d{2})$/.test(v.trim());

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT id, name, send_time, timezone FROM shift_summaries WHERE id = $1`,
      id,
    )) as Existing[];
    const existing = rows[0];
    if (!existing) return NextResponse.json({ error: "Shift summary not found." }, { status: 404 });

    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const sendTime = b.sendTime !== undefined ? String(b.sendTime).trim() : existing.send_time;
    const timezone = b.timezone !== undefined ? String(b.timezone).trim() : existing.timezone;
    if (!isHM(sendTime)) return NextResponse.json({ error: "Send time must be HH:MM." }, { status: 400 });

    const sets: string[] = [];
    const vals: unknown[] = [];
    let n = 1;
    const push = (col: string, v: unknown) => { sets.push(`${col} = $${n++}`); vals.push(v); };

    if (b.name !== undefined) push("name", String(b.name).trim());
    if (b.sendTime !== undefined || b.timezone !== undefined) {
      push("send_time", sendTime);
      push("timezone", timezone);
      // Reset the next send when the time or tz changes; Fab Orch re-initialises
      // it on its next tick (without sending) from send_time + timezone.
      sets.push("next_send_at = NULL");
    }
    if (b.recipientRoleIds !== undefined && Array.isArray(b.recipientRoleIds)) {
      sets.push(`recipient_role_ids = $${n++}::jsonb`);
      vals.push(JSON.stringify((b.recipientRoleIds as unknown[]).filter((x): x is string => typeof x === "string")));
    }
    if (b.dashboardIds !== undefined && Array.isArray(b.dashboardIds)) {
      sets.push(`dashboard_ids = $${n++}::jsonb`);
      vals.push(JSON.stringify((b.dashboardIds as unknown[]).filter((x): x is string => typeof x === "string")));
    }
    if (b.isActive !== undefined) push("is_active", !!b.isActive);
    if (!sets.length) return NextResponse.json({ success: true });
    sets.push("updated_at = now()");

    vals.push(id);
    await prisma.$executeRawUnsafe(`UPDATE shift_summaries SET ${sets.join(", ")} WHERE id = $${n}`, ...vals);

    prisma.auditLog
      .create({
        data: {
          userId: auth.user.id,
          action: "shift_summary.update",
          targetType: "ShiftSummary",
          targetId: existing.name,
          metadata: { id, fields: Object.keys(b) },
        },
      })
      .catch(() => {});

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("[api/admin/shift-summaries/[id]] PATCH failed", e);
    return NextResponse.json({ error: "Could not update the shift summary." }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT name FROM shift_summaries WHERE id = $1`,
      id,
    )) as { name: string }[];
    if (!rows.length) return NextResponse.json({ error: "Shift summary not found." }, { status: 404 });

    await prisma.$executeRawUnsafe(`DELETE FROM shift_summaries WHERE id = $1`, id);

    prisma.auditLog
      .create({
        data: {
          userId: auth.user.id,
          action: "shift_summary.delete",
          targetType: "ShiftSummary",
          targetId: rows[0].name,
          metadata: { id },
        },
      })
      .catch(() => {});

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("[api/admin/shift-summaries/[id]] DELETE failed", e);
    return NextResponse.json({ error: "Could not delete the shift summary." }, { status: 500 });
  }
}
