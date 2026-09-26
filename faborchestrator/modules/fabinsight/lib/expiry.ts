/**
 * Dashboard expiry.
 *
 * Every dashboard the admin approves carries an `expiresAt`. Each scheduler tick:
 *   - warns the requester + admins once, WARN_DAYS before expiry (`expiryWarnedAt`),
 *   - expires dashboards past their date: status → `expired`, schedule disabled,
 *     audit row, notification. Expired dashboards are hidden from users (see
 *     visibility.ts) and stay in the admin app for reactivation / extension.
 *
 * Pure decision helpers are exported for tests; the runner takes an injectable
 * `deps` so it can run without a database.
 */

import { prisma as defaultPrisma } from "@/shared/lib/db";
import { sendMail } from "@/modules/fabinsight/lib/mailer";
import { esc } from "@/modules/fabinsight/lib/html-escape";

const EXPIRY_WARN_DAYS = Number(process.env.FABINSIGHT_EXPIRY_WARN_DAYS ?? "3");
const DAY_MS = 86_400_000;

type ExpiryRow = {
  id: string;
  slug: string;
  title: string;
  status: string;
  expiresAt: Date | null;
  expiryWarnedAt: Date | null;
  requesterId: string | null;
};

type ExpiryDecision = "expire" | "warn" | "none";

/** What to do with a dashboard at `now`. */
export function decideExpiry(row: Pick<ExpiryRow, "status" | "expiresAt" | "expiryWarnedAt">, now: Date, warnDays = EXPIRY_WARN_DAYS): ExpiryDecision {
  if (row.status !== "live" || !row.expiresAt) return "none";
  const t = row.expiresAt.getTime();
  if (t <= now.getTime()) return "expire";
  if (!row.expiryWarnedAt && t - now.getTime() <= warnDays * DAY_MS) return "warn";
  return "none";
}

type ExpiryDeps = {
  prisma: typeof defaultPrisma;
  mail?: typeof sendMail;
  adminEmails?: () => Promise<string[]>;
  userEmail?: (id: string) => Promise<string | null>;
};

async function defaultAdminEmails(prisma: typeof defaultPrisma): Promise<string[]> {
  const rows = await prisma.user.findMany({ where: { status: "ACTIVE", isAdmin: true }, select: { email: true } });
  return [...new Set(rows.map((r) => r.email.trim().toLowerCase()).filter(Boolean))];
}

/** One pass. Returns counts for the tick log. */
export async function runExpiry(now: Date = new Date(), deps?: Partial<ExpiryDeps>): Promise<{ warned: number; expired: number }> {
  const prisma = deps?.prisma ?? defaultPrisma;
  const mail = deps?.mail ?? sendMail;
  const adminEmails = deps?.adminEmails ?? (() => defaultAdminEmails(prisma));
  const userEmail =
    deps?.userEmail ??
    (async (id: string) => (await prisma.user.findUnique({ where: { id }, select: { email: true } }))?.email ?? null);

  const horizon = new Date(now.getTime() + EXPIRY_WARN_DAYS * DAY_MS);
  const rows: ExpiryRow[] = await prisma.dashboard.findMany({
    where: { status: "live", expiresAt: { not: null, lte: horizon } },
    select: { id: true, slug: true, title: true, status: true, expiresAt: true, expiryWarnedAt: true, requesterId: true },
  });

  let warned = 0;
  let expired = 0;
  for (const row of rows) {
    const decision = decideExpiry(row, now);
    if (decision === "none") continue;

    const recipients = new Set(await adminEmails().catch(() => [] as string[]));
    if (row.requesterId) {
      const e = await userEmail(row.requesterId).catch(() => null);
      if (e) recipients.add(e.trim().toLowerCase());
    }
    const when = row.expiresAt!.toISOString();

    if (decision === "warn") {
      await prisma.dashboard.update({ where: { id: row.id }, data: { expiryWarnedAt: now } }).catch(() => {});
      warned++;
      try {
        await mail(
          [...recipients],
          `Dashboard expiring soon — ${row.title}`,
          `<p><b>${esc(row.title)}</b> expires on ${when} (UTC).</p>
           <p>Its scheduled refresh stops and it is hidden from users at that time. An admin can extend the expiry in the admin app under Dashboards.</p>`,
          "FabOrchestrator Dashboards",
        );
      } catch (e) {
        console.warn("[expiry] warn email failed:", e instanceof Error ? e.message : e);
      }
      continue;
    }

    // expire — a failure here leaves the dashboard LIVE past its expiry.
    try {
      await prisma.dashboard.update({ where: { id: row.id }, data: { status: "expired" } });
    } catch (e) {
      if (!deps) {
        const { recordCaptured } = await import("@/shared/lib/errors/capture");
        const { FabOrchErrorType } = await import("@/shared/lib/errors/error-catalog-defaults");
        recordCaptured(
          { system: "Dashboard expiry", operation: "expireDashboard", type: FabOrchErrorType.LAMBDA_MCP_CRASH, target: `dashboard ${row.slug}`, extra: { dashboardId: row.id, expiresAt: when } },
          e,
        );
      }
      continue;
    }
    await prisma.reportSchedule.updateMany({ where: { dashboardId: row.slug }, data: { enabled: false, lastStatus: "expired" } }).catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `INSERT INTO audit_logs (id, user_id, action, target_type, target_id, metadata, created_at)
         VALUES (gen_random_uuid()::text, NULL, 'dashboard.expired', 'Dashboard', $1, $2::jsonb, now())`,
        row.id,
        JSON.stringify({ slug: row.slug, title: row.title, expiresAt: when }),
      )
      .catch(() => {});
    expired++;
    try {
      await mail(
        [...recipients],
        `Dashboard expired — ${row.title}`,
        `<p><b>${esc(row.title)}</b> reached its expiry (${when} UTC).</p>
         <p>Scheduled refresh has stopped and the dashboard is no longer shown to users. An admin can extend it from the admin app under Dashboards to bring it back.</p>`,
        "FabOrchestrator Dashboards",
      );
    } catch (e) {
      console.warn("[expiry] expired email failed:", e instanceof Error ? e.message : e);
    }
  }
  return { warned, expired };
}
