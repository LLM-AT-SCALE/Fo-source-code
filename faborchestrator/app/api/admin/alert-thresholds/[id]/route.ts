import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";
import { validateBounds } from "@/modules/admin/lib/dashboards/alert-metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PATCH: edit a threshold's comparator/bounds/throttle/active/label. DELETE: remove it. */

type Existing = {
  id: string;
  metric_key: string;
  comparator: string;
  min_value: number | null;
  max_value: number | null;
};

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT id, metric_key, comparator, min_value, max_value FROM alert_thresholds WHERE id = $1`,
      id,
    )) as Existing[];
    const existing = rows[0];
    if (!existing) return NextResponse.json({ error: "Threshold not found." }, { status: 404 });

    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const comparator = b.comparator !== undefined ? String(b.comparator).trim() : existing.comparator;
    const minValue =
      b.minValue !== undefined
        ? b.minValue === null || b.minValue === "" ? null : Number(b.minValue)
        : existing.min_value;
    const maxValue =
      b.maxValue !== undefined
        ? b.maxValue === null || b.maxValue === "" ? null : Number(b.maxValue)
        : existing.max_value;

    const boundErr = validateBounds(comparator, minValue, maxValue);
    if (boundErr) return NextResponse.json({ error: boundErr }, { status: 400 });

    const label = b.label !== undefined ? (typeof b.label === "string" && b.label.trim() ? b.label.trim() : null) : undefined;
    const dashboardId =
      b.dashboardId !== undefined ? (typeof b.dashboardId === "string" && b.dashboardId.trim() ? b.dashboardId.trim() : null) : undefined;
    const throttleMin =
      b.throttleMin !== undefined && Number.isFinite(Number(b.throttleMin)) && Number(b.throttleMin) > 0
        ? Math.floor(Number(b.throttleMin))
        : undefined;
    const isActive = b.isActive !== undefined ? !!b.isActive : undefined;
    if (isActive === true) {
      const cur = (await prisma.$queryRawUnsafe(`SELECT metric_key FROM alert_thresholds WHERE id = $1`, id)) as { metric_key: string }[];
      if (cur[0] && !cur[0].metric_key.startsWith("custom:")) {
        return NextResponse.json(
          { error: "This alert uses a metric from the previous dashboard system and can no longer be evaluated. Delete it and create a new alert on a live dashboard column." },
          { status: 409 },
        );
      }
    }
    const recipientRoleIds =
      b.recipientRoleIds !== undefined && Array.isArray(b.recipientRoleIds)
        ? (b.recipientRoleIds as unknown[]).filter((x): x is string => typeof x === "string")
        : undefined;

    // Build the update set dynamically (only touched fields).
    const sets: string[] = ["comparator = $2", "min_value = $3", "max_value = $4"];
    const vals: unknown[] = [id, comparator, minValue, maxValue];
    let n = 5;
    if (label !== undefined) { sets.push(`label = $${n++}`); vals.push(label); }
    if (dashboardId !== undefined) { sets.push(`dashboard_id = $${n++}`); vals.push(dashboardId); }
    if (throttleMin !== undefined) { sets.push(`throttle_min = $${n++}`); vals.push(throttleMin); }
    if (isActive !== undefined) { sets.push(`is_active = $${n++}`); vals.push(isActive); }
    if (recipientRoleIds !== undefined) { sets.push(`recipient_role_ids = $${n++}::jsonb`); vals.push(JSON.stringify(recipientRoleIds)); }
    sets.push("updated_at = now()");

    await prisma.$executeRawUnsafe(`UPDATE alert_thresholds SET ${sets.join(", ")} WHERE id = $1`, ...vals);

    prisma.auditLog
      .create({
        data: {
          userId: auth.user.id,
          action: "alert_threshold.update",
          targetType: "AlertThreshold",
          targetId: existing.metric_key,
          metadata: { id, comparator, minValue, maxValue, throttleMin, isActive, dashboardId },
        },
      })
      .catch(() => {});

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("[api/admin/alert-thresholds/[id]] PATCH failed", e);
    return NextResponse.json({ error: "Could not update the threshold." }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT metric_key FROM alert_thresholds WHERE id = $1`,
      id,
    )) as { metric_key: string }[];
    if (!rows.length) return NextResponse.json({ error: "Threshold not found." }, { status: 404 });

    await prisma.$executeRawUnsafe(`DELETE FROM alert_thresholds WHERE id = $1`, id);

    prisma.auditLog
      .create({
        data: {
          userId: auth.user.id,
          action: "alert_threshold.delete",
          targetType: "AlertThreshold",
          targetId: rows[0].metric_key,
          metadata: { id },
        },
      })
      .catch(() => {});

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("[api/admin/alert-thresholds/[id]] DELETE failed", e);
    return NextResponse.json({ error: "Could not delete the threshold." }, { status: 500 });
  }
}
