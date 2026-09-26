/**
 * Shift-summary emails (V06 "Scheduled Dashboard").
 *
 * At each configured send time (a shift boundary, wall-clock in the row's tz —
 * default PST) the scheduler emails each recipient ROLE a summary of the
 * dashboards that role can see: every dashboard's cached summary from its last
 * replay snapshot, its health note, and a link to open the reports page. No
 * source is queried at send time. One row per send time in `shift_summaries`
 * (written by the admin app). Concurrency-safe via an atomic claim on
 * next_send_at, same as report refresh. Logged to audit_logs.
 */
import { prisma } from "@/shared/lib/db";
import { recordCaptured } from "@/shared/lib/errors/capture";
import { FabOrchErrorType } from "@/shared/lib/errors/error-catalog-defaults";
import { computeNextRun } from "@/modules/fabinsight/lib/schedule";
import { resolveAlertRecipients } from "@/modules/fabinsight/lib/alert-recipients";
import { sendMail } from "@/modules/fabinsight/lib/mailer";
import { groupDashboardsByRole, snapshotNote } from "@/modules/fabinsight/lib/snapshot-metrics";
import { esc } from "@/modules/fabinsight/lib/html-escape";

const REPORTS_BASE = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");

type ShiftRow = {
  id: string;
  name: string;
  sendTime: string;
  timezone: string;
  recipientRoleIds: unknown;
  dashboardIds: unknown;
  sourceKey: string;
  nextSendAt: Date | null;
};

type DashRow = {
  id: string;
  slug: string;
  title: string;
  status: string;
  cachedHtml: string | null;
  cachedSummary: string | null;
  lastStatus: string | null;
  refreshedAt: Date | null;
  visibleToAll: boolean;
  visibilityRoleIds: unknown;
  visibilityUserIds: unknown;
  createdById: string;
  requesterId: string | null;
};

/** Next occurrence of `sendTime` (HH:MM in `tz`), strictly after `from`. */
function nextSend(sendTime: string, tz: string, from: Date): Date {
  return computeNextRun(
    {
      id: "", dashboardId: "", sourceKey: "", frequency: "daily",
      intervalMinutes: null, atTime: sendTime, daysOfWeek: null,
      dayOfMonth: null, timezone: tz, windowStart: null, windowEnd: null, nextRunAt: null,
    },
    from,
  );
}

/** Live dashboards the row names (by slug or id); empty list ⇒ all live dashboards. */
async function loadDashboards(dashIds: string[]): Promise<DashRow[]> {
  const select = {
    id: true, slug: true, title: true, status: true, cachedHtml: true, cachedSummary: true,
    lastStatus: true, refreshedAt: true, visibleToAll: true, visibilityRoleIds: true,
    visibilityUserIds: true, createdById: true, requesterId: true,
  } as const;
  if (!dashIds.length) {
    return prisma.dashboard.findMany({ where: { status: "live" }, orderBy: { createdAt: "asc" }, select });
  }
  const rows = await prisma.dashboard.findMany({
    where: { status: "live", OR: [{ slug: { in: dashIds } }, { id: { in: dashIds } }] },
    select,
  });
  // Keep the row's declared order.
  const rank = new Map(dashIds.map((id, i) => [id, i]));
  return rows.sort((a, b) => (rank.get(a.slug) ?? rank.get(a.id) ?? 0) - (rank.get(b.slug) ?? rank.get(b.id) ?? 0));
}

/** Email body for one role group. */
function buildSummaryHtml(name: string, dashboards: DashRow[], now: Date, recipientsCount: number): string {
  const link = REPORTS_BASE ? `${REPORTS_BASE}/reports` : "";
  const openLink = link ? ` <a href="${link}">Open reports</a>` : "";
  const items = dashboards
    .map((d) => {
      const note = snapshotNote(d.lastStatus, d.refreshedAt, !!d.cachedHtml);
      const summary = d.cachedSummary?.trim() ? esc(d.cachedSummary) : "—";
      const warn = /failed|No snapshot|did not answer/.test(note)
        ? `<br/><span style="color:#b45309">⚠ ${esc(note)}</span>`
        : note
          ? `<br/><span style="color:#888;font-size:12px">${esc(note)}</span>`
          : "";
      return `<li style="margin-bottom:8px"><b>${esc(d.title)}</b><br/><span style="color:#444">${summary}</span>${warn}</li>`;
    })
    .join("");
  return `
    <p><b>${esc(name)}</b> — shift summary</p>
    <p>Snapshot of your dashboards as of ${now.toISOString()} (UTC).${openLink}</p>
    <ul style="padding-left:18px">${items || "<li>No dashboards are shared with your role yet.</li>"}</ul>
    <p style="color:#888;font-size:12px">Sent to ${recipientsCount} member(s) of this role.</p>`;
}

export async function runDueShiftSummaries(now: Date = new Date()): Promise<void> {
  try {
    const rows = (await prisma.shiftSummary.findMany({
      where: { isActive: true },
      select: { id: true, name: true, sendTime: true, timezone: true, recipientRoleIds: true, dashboardIds: true, sourceKey: true, nextSendAt: true },
    })) as ShiftRow[];

    for (const row of rows) {
      const tz = row.timezone || "America/Los_Angeles";
      const next = nextSend(row.sendTime, tz, now);

      // First time we see the row (seeded with a null next_send_at): initialize
      // the schedule, do NOT send.
      if (!row.nextSendAt) {
        await prisma.shiftSummary.update({ where: { id: row.id }, data: { nextSendAt: next } }).catch(() => {});
        continue;
      }
      if (row.nextSendAt > now) continue;

      // Atomic claim — advance next_send_at; only one instance wins.
      const claim = await prisma.shiftSummary.updateMany({
        where: { id: row.id, isActive: true, nextSendAt: { lte: now } },
        data: { nextSendAt: next, lastSendAt: now },
      });
      if (claim.count !== 1) continue;

      const roleIds = Array.isArray(row.recipientRoleIds)
        ? (row.recipientRoleIds as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const dashIds = Array.isArray(row.dashboardIds)
        ? (row.dashboardIds as unknown[]).filter((x): x is string => typeof x === "string")
        : [];

      const dashboards = await loadDashboards(dashIds);
      const groups = groupDashboardsByRole(dashboards, roleIds);

      let emailedGroups = 0;
      let totalRecipients = 0;
      let totalDashboards = 0;
      const reasons = new Set<string>();
      const perRole: Record<string, { recipients: number; dashboards: number; emailed: boolean; reason?: string }> = {};
      for (const [roleId, visible] of groups) {
        // "*" = no explicit roles: the default alert roles get the visible-to-all set.
        const recipients = await resolveAlertRecipients(roleId === "*" ? undefined : [roleId]);
        totalRecipients += recipients.length;
        totalDashboards += visible.length;
        let emailed = false;
        let reason: string | undefined;
        if (visible.length === 0) {
          // Nothing to report: the shift's dashboards are not live or not visible to this role.
          reason = "no live dashboards to summarise for this role";
        } else if (recipients.length === 0) {
          reason = "no active users in the recipient role";
        } else {
          const html = buildSummaryHtml(row.name, visible, now, recipients.length);
          try {
            emailed = await sendMail(recipients, `Shift summary — ${row.name}`, html, "FabOrchestrator Reports");
            if (!emailed) reason = "SMTP is not configured";
          } catch (e) {
            // Keep the SMTP server's own words: "Invalid login", "connection refused", …
            reason = `email failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160)}`;
            console.error(`[shift-summary] email failed for "${row.name}" role ${roleId}`, e);
          }
        }
        if (emailed) emailedGroups++;
        if (reason) reasons.add(reason);
        perRole[roleId] = { recipients: recipients.length, dashboards: visible.length, emailed, ...(reason ? { reason } : {}) };
      }

      const emailed = emailedGroups > 0;
      const reason = [...reasons].join("; ");
      await prisma.shiftSummary
        .update({
          where: { id: row.id },
          data: { lastStatus: emailed ? `sent to ${totalRecipients} across ${emailedGroups} role(s)` : `not sent: ${reason || "unknown"}`.slice(0, 200) },
        })
        .catch(() => {});

      await prisma
        .$executeRawUnsafe(
          `INSERT INTO audit_logs (id, user_id, action, target_type, target_id, metadata, created_at)
           VALUES (gen_random_uuid()::text, NULL, $1, 'ShiftSummary', $2, $3::jsonb, now())`,
          emailed ? "report.shift_summary_sent" : "report.shift_summary_failed",
          row.id,
          JSON.stringify({
            name: row.name,
            sendTime: row.sendTime,
            timezone: tz,
            dashboards: totalDashboards,
            recipientsCount: totalRecipients,
            emailed,
            perRole,
            ...(emailed ? {} : { reason: reason || "not sent" }),
          }),
        )
        .catch(() => {});

      console.log(`[shift-summary] "${row.name}" sent=${emailed} to ${totalRecipients} across ${groups.size} role group(s), ${dashboards.length} dashboards`);
    }
  } catch (e) {
    console.error("[shift-summary] run failed", e);
    recordCaptured({ system: "Shift summaries", operation: "runDueShiftSummaries", type: FabOrchErrorType.LAMBDA_MCP_CRASH }, e);
  }
}
