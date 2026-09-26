/**
 * Resolve discrepancy-alert recipients to distinct active email addresses.
 *
 * Each threshold can name its own recipient roles (multi-select in the admin UI,
 * stored as role ids). When a threshold has none, we fall back to the default
 * alert roles (Yogita's three) so the seeded idle alert still reaches someone.
 * isAdmin users are always included in the fallback so a flagged admin without
 * the "Admin" role still receives alerts.
 */
import { prisma } from "@/shared/lib/db";

const ALERT_RECIPIENT_ROLES = ["Shift Lead", "Shift Supervisor", "Admin"] as const;

export async function resolveAlertRecipients(roleIds?: string[]): Promise<string[]> {
  const useExplicit = Array.isArray(roleIds) && roleIds.length > 0;
  const users = await prisma.user.findMany({
    where: useExplicit
      ? { status: "ACTIVE", roleId: { in: roleIds } }
      : { status: "ACTIVE", OR: [{ isAdmin: true }, { role: { name: { in: [...ALERT_RECIPIENT_ROLES] } } }] },
    select: { email: true },
  });
  const seen = new Set<string>();
  for (const u of users) {
    const e = (u.email || "").trim().toLowerCase();
    if (e) seen.add(e);
  }
  return [...seen];
}
