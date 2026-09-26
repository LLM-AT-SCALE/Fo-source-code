import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-managed shift-summary email sends (the `shift_summaries` table, shared
 * DB). Fab Orch fires them on its scheduler tick. Raw SQL, admin-gated, audited.
 * Mirrors the alert-thresholds / report-schedule routes.
 */

type Row = {
  id: string;
  name: string;
  send_time: string;
  timezone: string;
  recipient_role_ids: unknown;
  dashboard_ids: unknown;
  is_active: boolean;
  next_send_at: Date | null;
  last_send_at: Date | null;
  last_status: string | null;
  updated_at: Date;
};

function toClient(r: Row) {
  return {
    id: r.id,
    name: r.name,
    sendTime: r.send_time,
    timezone: r.timezone,
    recipientRoleIds: Array.isArray(r.recipient_role_ids) ? (r.recipient_role_ids as string[]) : [],
    dashboardIds: Array.isArray(r.dashboard_ids) ? (r.dashboard_ids as string[]) : [],
    isActive: r.is_active,
    nextSendAt: r.next_send_at,
    lastSendAt: r.last_send_at,
    lastStatus: r.last_status,
    updatedAt: r.updated_at,
  };
}

const isHM = (v: unknown) => typeof v === "string" && /^(\d{1,2}):(\d{2})$/.test(v.trim());

/** Live/paused dashboards for the picker, keyed by slug (the id the Fab sender + scheduler resolve by). */
async function dashboardOptions(): Promise<{ id: string; title: string }[]> {
  const rows = (await prisma
    .$queryRawUnsafe(`SELECT slug, title FROM dashboards WHERE status IN ('live', 'paused') ORDER BY title`)
    .catch(() => [])) as { slug: string; title: string }[];
  return rows.map((r) => ({ id: r.slug, title: r.title }));
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT id, name, send_time, timezone, recipient_role_ids, dashboard_ids, is_active,
              next_send_at, last_send_at, last_status, updated_at
         FROM shift_summaries ORDER BY send_time`,
    )) as Row[];
    const roles = await prisma.role.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
    const dashboards = await dashboardOptions();
    return NextResponse.json({ shifts: rows.map(toClient), roles, dashboards });
  } catch (e) {
    console.error("[api/admin/shift-summaries] GET failed", e);
    return NextResponse.json({ error: "Could not load shift summaries." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = String(b.name ?? "").trim();
    const sendTime = String(b.sendTime ?? "").trim();
    if (!name) return NextResponse.json({ error: "A name is required." }, { status: 400 });
    if (!isHM(sendTime)) return NextResponse.json({ error: "Send time must be HH:MM." }, { status: 400 });

    const timezone = typeof b.timezone === "string" && b.timezone.trim() ? b.timezone.trim() : "America/Los_Angeles";
    const isActive = b.isActive === undefined ? true : !!b.isActive;
    const sourceKey = typeof b.sourceKey === "string" && b.sourceKey.trim() ? b.sourceKey.trim() : "lumentum";
    const recipientRoleIds = Array.isArray(b.recipientRoleIds)
      ? (b.recipientRoleIds as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const dashboardIds = Array.isArray(b.dashboardIds)
      ? (b.dashboardIds as unknown[]).filter((x): x is string => typeof x === "string")
      : [];

    // next_send_at is left NULL: Fab Orch initialises it on its next tick without
    // sending (see lib/fabinsight/shift-summary.ts) and computes every later send.
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO shift_summaries
           (id, name, send_time, timezone, recipient_role_ids, dashboard_ids, source_key, is_active, next_send_at, created_by_id, created_at, updated_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, NULL, $8, now(), now())`,
        name,
        sendTime,
        timezone,
        JSON.stringify(recipientRoleIds),
        JSON.stringify(dashboardIds),
        sourceKey,
        isActive,
        auth.user.id,
      );
    } catch (err) {
      if (String((err as { message?: string })?.message ?? "").includes("shift_summaries_name_uidx")) {
        return NextResponse.json({ error: "A shift summary with this name already exists." }, { status: 409 });
      }
      throw err;
    }

    prisma.auditLog
      .create({
        data: {
          userId: auth.user.id,
          action: "shift_summary.create",
          targetType: "ShiftSummary",
          targetId: name,
          metadata: { name, sendTime, timezone, recipientRoleIds, dashboardIds, isActive },
        },
      })
      .catch(() => {});

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("[api/admin/shift-summaries] POST failed", e);
    return NextResponse.json({ error: "Could not create the shift summary." }, { status: 500 });
  }
}
