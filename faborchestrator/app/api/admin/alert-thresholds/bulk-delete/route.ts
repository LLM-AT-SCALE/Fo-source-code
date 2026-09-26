import { NextRequest, NextResponse } from "next/server";
import prisma from "@/shared/lib/db";
import { requireAdmin, getIpAddress } from "@/shared/lib/auth-middleware";

/**
 * POST — delete several alert thresholds at once.
 *   { ids: string[] }         delete these ids
 *   { legacy: true }          delete every threshold whose metric key predates the
 *                             dashboard rearchitecture (not `custom:…`), which can
 *                             no longer be evaluated
 *   { dashboardId: "<slug>" } delete every threshold on one dashboard
 * Exactly one selector is required. Returns { deleted, metricKeys }.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: { ids?: unknown; legacy?: unknown; dashboardId?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === "string" && v.length > 0).slice(0, 500) : null;
  const legacy = body.legacy === true;
  const dashboardId = typeof body.dashboardId === "string" && body.dashboardId.trim() ? body.dashboardId.trim() : null;
  const selectors = [ids?.length ? 1 : 0, legacy ? 1 : 0, dashboardId ? 1 : 0].reduce((a, b) => a + b, 0);
  if (selectors !== 1) {
    return NextResponse.json({ error: "Pass exactly one of ids[], legacy:true or dashboardId." }, { status: 400 });
  }

  try {
    let rows: { id: string; metric_key: string }[];
    if (ids) {
      rows = (await prisma.$queryRawUnsafe(
        `DELETE FROM alert_thresholds WHERE id = ANY($1::text[]) RETURNING id, metric_key`,
        ids,
      )) as { id: string; metric_key: string }[];
    } else if (legacy) {
      rows = (await prisma.$queryRawUnsafe(
        `DELETE FROM alert_thresholds WHERE metric_key NOT LIKE 'custom:%' RETURNING id, metric_key`,
      )) as { id: string; metric_key: string }[];
    } else {
      rows = (await prisma.$queryRawUnsafe(
        `DELETE FROM alert_thresholds WHERE dashboard_id = $1 OR metric_key LIKE $2 RETURNING id, metric_key`,
        dashboardId,
        `custom:${dashboardId}:%`,
      )) as { id: string; metric_key: string }[];
    }

    if (rows.length) {
      prisma.auditLog
        .create({
          data: {
            userId: auth.user.id,
            action: "alert_threshold.bulk_delete",
            targetType: "AlertThreshold",
            targetId: legacy ? "legacy" : dashboardId ?? `${rows.length} ids`,
            metadata: { deleted: rows.length, metricKeys: rows.map((r) => r.metric_key).slice(0, 100), selector: legacy ? "legacy" : dashboardId ? "dashboard" : "ids" },
            ipAddress: getIpAddress(req),
          },
        })
        .catch(() => {});
    }
    return NextResponse.json({ deleted: rows.length, metricKeys: rows.map((r) => r.metric_key) });
  } catch (e) {
    console.error("[api/admin/alert-thresholds/bulk-delete] failed", e);
    return NextResponse.json({ error: "Failed to delete thresholds." }, { status: 500 });
  }
}
