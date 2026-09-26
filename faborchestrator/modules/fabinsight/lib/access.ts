/**
 * Who may manage dashboards, and who may pin one for scheduling.
 *
 * - `isDashboardAdmin`: platform admins (isAdmin flag or the Admin role). They
 *   delete/refresh dashboards in Fab AI; approval itself happens in the admin app.
 * - `canPinDashboards`: any user whose role carries the `dashboards` permission
 *   (set per role in the admin app), plus admins. Pinning is a *request* — it
 *   never publishes anything until an admin approves it.
 *
 * The checks mirror the Modeling Agent gate (`/api/modeling-agent/access`) so the
 * app has one notion of "admin" and one of "role permission".
 */

import { prisma } from '@/shared/lib/db';
import { isPlatformAdmin } from '@/shared/lib/permissions';

/** Role permission value (stored in roles.permissions JSON array) that enables pinning. */
const DASHBOARDS_PERMISSION = 'dashboards';

type AccessUser = {
  isAdmin: boolean;
  role: { name: string; permissions: unknown; promptChipIds?: unknown } | null;
};

export type PromptChipView = { id: string; label: string; blurb: string; prompt: string; icon: string };

function isAdminUser(user: AccessUser | null | undefined): boolean {
  return isPlatformAdmin(user);
}

function hasPermission(user: AccessUser | null | undefined, permission: string): boolean {
  const perms = user?.role?.permissions;
  return Array.isArray(perms) && perms.includes(permission);
}

async function loadAccessUser(userId: string): Promise<AccessUser | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { isAdmin: true, role: { select: { name: true, permissions: true, promptChipIds: true } } },
  });
}

export async function isDashboardAdmin(userId: string): Promise<boolean> {
  return isAdminUser(await loadAccessUser(userId));
}

export async function canPinDashboards(userId: string): Promise<boolean> {
  const user = await loadAccessUser(userId);
  return isAdminUser(user) || hasPermission(user, DASHBOARDS_PERMISSION);
}

/**
 * The role's prompt chips, in the role's order, active only. Every chip is
 * selectable for every role; what shows is exactly what the admin chose.
 */
async function roleChips(user: AccessUser | null): Promise<PromptChipView[]> {
  if (!user) return [];
  const ids = Array.isArray(user.role?.promptChipIds)
    ? (user.role!.promptChipIds as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  if (!ids.length) return [];
  const rows = await prisma.promptChip.findMany({
    where: { id: { in: ids }, isActive: true },
    select: { id: true, label: true, blurb: true, prompt: true, icon: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
}

/** One round-trip for the access endpoint. */
export async function dashboardAccess(userId: string): Promise<{ isAdmin: boolean; canPin: boolean; chips: PromptChipView[] }> {
  const user = await loadAccessUser(userId);
  const admin = isAdminUser(user);
  return {
    isAdmin: admin,
    canPin: admin || hasPermission(user, DASHBOARDS_PERMISSION),
    chips: await roleChips(user),
  };
}
