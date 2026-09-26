import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";
import { asMetricColumns, metricKey as buildMetricKey, parseMetricKey, validateBounds } from "@/modules/admin/lib/dashboards/alert-metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-managed discrepancy alert thresholds (the `alert_thresholds` table, shared
 * DB). Fab Orch reads + evaluates these on its scheduler tick (lib/fabinsight/
 * alerts.ts). Raw SQL, admin-gated and audited. Mirrors the database-connections
 * and report-schedule routes.
 */

type ThresholdRow = {
  id: string;
  metric_key: string;
  label: string | null;
  comparator: string;
  min_value: number | null;
  max_value: number | null;
  dashboard_id: string | null;
  source_key: string;
  throttle_min: number;
  is_active: boolean;
  recipient_role_ids: unknown;
  custom_set_key: string | null;
  custom_column: string | null;
  created_at: Date;
  updated_at: Date;
};

function toClient(r: ThresholdRow) {
  const parsed = parseMetricKey(r.metric_key);
  return {
    id: r.id,
    metricKey: r.metric_key,
    metricLabel: r.custom_column ?? parsed?.column ?? r.metric_key,
    /** Pre-rearchitecture curated key (no longer evaluated). Must be re-created on a live dashboard. */
    legacy: !parsed,
    unit: "",
    label: r.label,
    comparator: r.comparator,
    minValue: r.min_value,
    maxValue: r.max_value,
    dashboardId: r.dashboard_id,
    sourceKey: r.source_key,
    throttleMin: r.throttle_min,
    isActive: r.is_active,
    recipientRoleIds: Array.isArray(r.recipient_role_ids) ? (r.recipient_role_ids as string[]) : [],
    customSetKey: r.custom_set_key,
    customColumn: r.custom_column,
    updatedAt: r.updated_at,
  };
}

/** Live/paused dashboards + the numeric columns Fab Orch discovered on each, as alertable metrics. */
type DashRow = { slug: string; title: string; status: string; metric_columns: unknown };
async function getCatalog(): Promise<{
  dashboards: { id: string; title: string; custom: boolean }[];
  metrics: { key: string; label: string; unit: string; dashboardId: string; suggestedComparator: string; suggestedThreshold: number; custom: boolean; setKey: string; column: string }[];
}> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT slug, title, status, metric_columns FROM dashboards WHERE status IN ('live', 'paused') ORDER BY title`,
  )) as DashRow[];
  const dashboards = rows.map((d) => ({ id: d.slug, title: d.status === "paused" ? `${d.title} (paused)` : d.title, custom: true }));
  const metrics: { key: string; label: string; unit: string; dashboardId: string; suggestedComparator: string; suggestedThreshold: number; custom: boolean; setKey: string; column: string }[] = [];
  for (const d of rows) {
    const cols = asMetricColumns(d.metric_columns);
    // Disambiguate identical column names coming from different result sets.
    const dupCols = new Set(cols.map((c) => c.column).filter((c, i, a) => a.indexOf(c) !== i));
    for (const c of cols) {
      const label = dupCols.has(c.column) && c.setLabel ? `${c.setLabel} · ${c.column}` : c.column;
      metrics.push({
        key: buildMetricKey(d.slug, c.setKey, c.column),
        label,
        unit: "count",
        dashboardId: d.slug,
        suggestedComparator: "gt",
        suggestedThreshold: 0,
        custom: true,
        setKey: c.setKey,
        column: c.column,
      });
    }
  }
  return { dashboards, metrics };
}

type StatRow = { metric_key: string; min_v: unknown; max_v: unknown; avg_v: unknown; n: number; since: Date | null };
type CurRow = { metric_key: string; value: unknown };

/** Per-metric dynamic normal range from metric_samples: 7-day min/avg/max + current. */
async function computeBaselines(): Promise<Record<string, { min: number; avg: number; max: number; count: number; current: number | null; since: Date | null }>> {
  const stats = (await prisma.$queryRawUnsafe(
    `SELECT metric_key, MIN(value) AS min_v, MAX(value) AS max_v, AVG(value) AS avg_v,
            COUNT(*)::int AS n, MIN(sampled_at) AS since
       FROM metric_samples
      WHERE sampled_at > now() - interval '7 days'
      GROUP BY metric_key`,
  )) as StatRow[];
  const current = (await prisma.$queryRawUnsafe(
    `SELECT DISTINCT ON (metric_key) metric_key, value
       FROM metric_samples ORDER BY metric_key, sampled_at DESC`,
  )) as CurRow[];
  const curByKey = new Map(current.map((r) => [r.metric_key, Number(r.value)]));
  const out: Record<string, { min: number; avg: number; max: number; count: number; current: number | null; since: Date | null }> = {};
  for (const s of stats) {
    out[s.metric_key] = {
      min: Number(s.min_v),
      avg: Number(s.avg_v),
      max: Number(s.max_v),
      count: s.n,
      current: curByKey.has(s.metric_key) ? (curByKey.get(s.metric_key) as number) : null,
      since: s.since,
    };
  }
  return out;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT id, metric_key, label, comparator, min_value, max_value, dashboard_id,
              source_key, throttle_min, is_active, recipient_role_ids, custom_set_key, custom_column,
              created_at, updated_at
         FROM alert_thresholds
        ORDER BY metric_key, created_at`,
    )) as ThresholdRow[];
    const roles = await prisma.role.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
    const baselines = await computeBaselines();
    const { dashboards, metrics } = await getCatalog();
    return NextResponse.json({ thresholds: rows.map(toClient), metrics, dashboards, roles, baselines });
  } catch (e) {
    console.error("[api/admin/alert-thresholds] GET failed", e);
    return NextResponse.json({ error: "Could not load alert thresholds." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const metricKeyStr = String(b.metricKey ?? "").trim();
    const parsed = parseMetricKey(metricKeyStr);
    if (!parsed) return NextResponse.json({ error: "Unknown metric." }, { status: 400 });
    // The key is authoritative; the explicit fields are kept for the scheduler's convenience.
    const customSetKey = typeof b.customSetKey === "string" && b.customSetKey.trim() ? b.customSetKey.trim() : parsed.setKey;
    const customColumn = typeof b.customColumn === "string" && b.customColumn.trim() ? b.customColumn.trim() : parsed.column;
    if (typeof b.dashboardId === "string" && b.dashboardId.trim() && b.dashboardId.trim() !== parsed.slug) {
      return NextResponse.json({ error: "The metric does not belong to that dashboard." }, { status: 400 });
    }
    const metricKey = metricKeyStr;
    const comparator = String(b.comparator ?? "gt").trim();
    const minValue = b.minValue === null || b.minValue === undefined || b.minValue === "" ? null : Number(b.minValue);
    const maxValue = b.maxValue === null || b.maxValue === undefined || b.maxValue === "" ? null : Number(b.maxValue);
    const boundErr = validateBounds(comparator, minValue, maxValue);
    if (boundErr) return NextResponse.json({ error: boundErr }, { status: 400 });

    const label = typeof b.label === "string" && b.label.trim() ? b.label.trim() : null;
    const dashboardId = parsed.slug;
    const throttleMin = Number.isFinite(Number(b.throttleMin)) && Number(b.throttleMin) > 0 ? Math.floor(Number(b.throttleMin)) : 60;
    const isActive = b.isActive === undefined ? true : !!b.isActive;
    const sourceKey = typeof b.sourceKey === "string" && b.sourceKey.trim() ? b.sourceKey.trim() : "lumentum";
    const recipientRoleIds = Array.isArray(b.recipientRoleIds)
      ? (b.recipientRoleIds as unknown[]).filter((x): x is string => typeof x === "string")
      : [];

    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO alert_thresholds
           (id, metric_key, label, comparator, min_value, max_value, dashboard_id, source_key,
            throttle_min, is_active, recipient_role_ids, custom_set_key, custom_column, created_by_id, created_at, updated_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, now(), now())`,
        metricKey,
        label,
        comparator,
        minValue,
        maxValue,
        dashboardId,
        sourceKey,
        throttleMin,
        isActive,
        JSON.stringify(recipientRoleIds),
        customSetKey,
        customColumn,
        auth.user.id,
      );
    } catch (err) {
      if (String((err as { message?: string })?.message ?? "").includes("alert_thresholds_metric_dash_uidx")) {
        return NextResponse.json({ error: "A threshold for this metric already exists." }, { status: 409 });
      }
      throw err;
    }

    prisma.auditLog
      .create({
        data: {
          userId: auth.user.id,
          action: "alert_threshold.create",
          targetType: "AlertThreshold",
          targetId: metricKey,
          metadata: { metricKey, comparator, minValue, maxValue, throttleMin, isActive, dashboardId },
        },
      })
      .catch(() => {});

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("[api/admin/alert-thresholds] POST failed", e);
    return NextResponse.json({ error: "Could not create the threshold." }, { status: 500 });
  }
}
