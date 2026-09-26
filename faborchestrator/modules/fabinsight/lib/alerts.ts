/**
 * Discrepancy alerts.
 *
 * Thresholds live in `alert_thresholds` (written by the admin app). Each one
 * names a dashboard column by metric key `custom:<dashboardSlug>:<setKey>:<column>`
 * and is evaluated against that dashboard's LAST replay snapshot
 * (`dashboards.cached_sets`) — the alert pass never queries a source itself. A
 * breach emails the threshold's recipient roles (restricted to people who can
 * actually open the dashboard) and is logged to audit_logs. Throttled per
 * threshold so it does not spam while the value stays over.
 */
import { prisma } from "@/shared/lib/db";
import { resolveAlertRecipients } from "@/modules/fabinsight/lib/alert-recipients";
import { sendMail } from "@/modules/fabinsight/lib/mailer";
import { recordCaptured } from "@/shared/lib/errors/capture";
import { FabOrchErrorType } from "@/shared/lib/errors/error-catalog-defaults";

import { metricFromSets, parseCachedSets, parseCustomMetricKey } from "@/modules/fabinsight/lib/snapshot-metrics";
import { visibleUserEmails } from "@/modules/fabinsight/lib/visibility";
import { esc } from "@/modules/fabinsight/lib/html-escape";

type ThresholdRow = {
  id: string;
  metricKey: string;
  label: string | null;
  comparator: string;
  minValue: number | null;
  maxValue: number | null;
  throttleMin: number;
  recipientRoleIds: unknown;
  dashboardId: string | null;
  customSetKey: string | null;
  customColumn: string | null;
  /** The admin who set the alert — a record about it is attributed to them. */
  createdById: string | null;
};

type DashRow = {
  id: string;
  slug: string;
  title: string;
  status: string;
  cachedSets: unknown;
  visibleToAll: boolean;
  visibilityRoleIds: unknown;
  visibilityUserIds: unknown;
  createdById: string;
  requesterId: string | null;
};

/** True when `value` breaches the threshold. Missing bounds → not breached. */
export function isBreached(t: Pick<ThresholdRow, "comparator" | "minValue" | "maxValue">, value: number): boolean {
  switch (t.comparator) {
    case "gt":
      return t.maxValue !== null && value > t.maxValue;
    case "lt":
      return t.minValue !== null && value < t.minValue;
    case "outside":
      return (t.minValue !== null && value < t.minValue) || (t.maxValue !== null && value > t.maxValue);
    default:
      return false;
  }
}

/** Human-readable bound description for the email/subject. */
function boundText(t: ThresholdRow): string {
  if (t.comparator === "gt") return `above ${t.maxValue}`;
  if (t.comparator === "lt") return `below ${t.minValue}`;
  return `outside ${t.minValue}–${t.maxValue}`;
}

/** Skip if this threshold already alerted within its throttle window. */
async function isThrottled(thresholdId: string, throttleMin: number): Promise<boolean> {
  const recent = (await prisma.$queryRawUnsafe(
    `SELECT 1 FROM audit_logs
      WHERE action = 'alert.discrepancy'
        AND metadata->>'thresholdId' = $1
        AND created_at > now() - ($2 || ' minutes')::interval
      LIMIT 1`,
    thresholdId,
    String(throttleMin),
  )) as unknown[];
  return recent.length > 0;
}


/**
 * Recipients = the threshold's roles (or the default alert roles) ∩ people who
 * can open the dashboard. Empty intersection ⇒ admins only, so a misconfigured
 * threshold still reaches someone who can fix it.
 */
async function alertRecipients(dash: DashRow, roleIds: string[]): Promise<string[]> {
  const byRole = await resolveAlertRecipients(roleIds);
  // Admins pass `canSee` unconditionally; exclude them here so the intersection
  // reflects real role visibility, then fall back to admins when it is empty.
  const canOpen = await visibleUserEmails(dash, { includeAdmins: false });
  const both = intersectRecipients(byRole, canOpen);
  if (both.length) return both;
  const admins = await prisma.user.findMany({ where: { status: "ACTIVE", isAdmin: true }, select: { email: true } });
  return [...new Set(admins.map((u) => (u.email || "").trim().toLowerCase()).filter(Boolean))];
}

/** Emails present in both lists (case-insensitive, deduped, order of `a`). */
export function intersectRecipients(a: string[], b: string[]): string[] {
  const bset = new Set(b.map((e) => e.trim().toLowerCase()));
  const out: string[] = [];
  for (const e of a) {
    const k = e.trim().toLowerCase();
    if (k && bset.has(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * Evaluate all active discrepancy thresholds against the cached snapshots.
 * On breach: email + audit row. Throttled per-threshold. Safe to call every tick.
 */
export async function runDiscrepancyAlerts(now: Date = new Date()): Promise<void> {
  try {
    const thresholds = (await prisma.alertThreshold.findMany({
      where: { isActive: true },
      select: {
        id: true,
        metricKey: true,
        label: true,
        comparator: true,
        minValue: true,
        maxValue: true,
        throttleMin: true,
        createdById: true,
        recipientRoleIds: true,
        dashboardId: true,
        customSetKey: true,
        customColumn: true,
      },
    })) as ThresholdRow[];
    if (!thresholds.length) return;

    // Each dashboard's snapshot is loaded at most once per pass.
    const dashCache = new Map<string, DashRow | null>();
    const loadDash = async (ref: string): Promise<DashRow | null> => {
      if (dashCache.has(ref)) return dashCache.get(ref) ?? null;
      const row = await prisma.dashboard
        .findFirst({
          where: { OR: [{ slug: ref }, { id: ref }] },
          select: {
            id: true,
            slug: true,
            title: true,
            status: true,
            cachedSets: true,
            visibleToAll: true,
            visibilityRoleIds: true,
            visibilityUserIds: true,
            createdById: true,
            requesterId: true,
          },
        })
        .catch(() => null);
      dashCache.set(ref, row);
      return row;
    };

    for (const t of thresholds) {
      const parsed = parseCustomMetricKey(t.metricKey);
      // The key's second segment is the dashboard slug (legacy rows carried the
      // pin id); `dashboardId` on the row is the fallback reference.
      const ref = parsed?.slug || t.dashboardId;
      const setKey = parsed?.setKey || t.customSetKey;
      const column = parsed?.column || t.customColumn;
      // An alert that can never be evaluated is broken, not quiet: without a
      // record the admin believes the metric is being watched.
      const unusable = (why: string) =>
        recordCaptured(
          {
            system: "Discrepancy alerts",
            operation: "checkThreshold",
            // A configuration problem, not a data outage.
            type: FabOrchErrorType.INVALID_PARAMETER,
            target: `alert ${t.label || t.metricKey}`,
            userId: t.createdById,
            extra: { thresholdId: t.id, metricKey: t.metricKey },
          },
          new Error(`The alert "${t.label || t.metricKey}" cannot be checked: ${why}`),
        );
      if (!ref || !setKey || !column) {
        unusable(`its metric key "${t.metricKey}" does not name a dashboard, data set and column.`);
        continue;
      }

      const dash = await loadDash(ref);
      if (!dash) {
        unusable(`the dashboard it watches ("${ref}") no longer exists.`);
        continue;
      }
      // Expired / not yet live: intentionally not checked.
      if (dash.status !== "live") continue;
      const value = metricFromSets(parseCachedSets(dash.cachedSets), setKey, column);
      if (value === null) continue; // no snapshot / set errored — never a false breach
      if (!isBreached(t, value)) continue;
      if (await isThrottled(t.id, t.throttleMin)) continue;

      const roleIds = Array.isArray(t.recipientRoleIds)
        ? (t.recipientRoleIds as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const recipients = await alertRecipients(dash, roleIds);
      const name = t.label || column;
      const shown = Number.isInteger(value) ? String(value) : value.toFixed(2);
      const bound = boundText(t);
      const subject = `⚠️ Discrepancy: ${name} is ${shown} (${bound})`;
      const html = `
        <p><b>Discrepancy alert</b></p>
        <p><b>${esc(name)}</b> is <b>${shown}</b>, which is ${esc(bound)} the configured range.</p>
        <ul>
          <li>Metric: ${esc(name)}</li>
          <li>Current value: ${shown}</li>
          <li>Threshold: ${esc(bound)}</li>
          <li>Dashboard: ${esc(dash.title)}</li>
        </ul>
        <p>As of ${now.toISOString()} (UTC), from the dashboard's latest snapshot.</p>`;

      let emailed = false;
      try {
        emailed = await sendMail(recipients, subject, html, "FabOrchestrator Alerts");
      } catch (e) {
        console.error(`[alerts] email failed for threshold ${t.id}`, e);
      }

      await prisma
        .$executeRawUnsafe(
          `INSERT INTO audit_logs (id, user_id, action, target_type, target_id, metadata, created_at)
           VALUES (gen_random_uuid()::text, NULL, 'alert.discrepancy', 'Alert', $1, $2::jsonb, now())`,
          t.id,
          JSON.stringify({
            thresholdId: t.id,
            metricKey: t.metricKey,
            value: Number(value.toFixed(2)),
            min: t.minValue,
            max: t.maxValue,
            comparator: t.comparator,
            dashboardId: dash.slug,
            dashboardName: dash.title,
            recipientsCount: recipients.length,
            emailed,
          }),
        )
        .catch(() => {});

      console.log(`[alerts] ${t.metricKey}=${shown} breached (${bound}) — emailed=${emailed} to ${recipients.length}`);
    }
  } catch (e) {
    console.error("[alerts] discrepancy run failed", e);
    recordCaptured({ system: "Discrepancy alerts", operation: "runDiscrepancyAlerts", type: FabOrchErrorType.LAMBDA_MCP_CRASH }, e);
  }
}
