/**
 * Dashboard visibility.
 *
 * A dashboard is visible to a user when it is live AND any of:
 *   - it is visible to all,
 *   - the user requested or created it,
 *   - the user is listed in visibility_user_ids,
 *   - the user's role is listed in visibility_role_ids.
 * Admins see every dashboard (including paused / expired) so they can manage them.
 *
 * `canSee` is the pure rule (unit-tested); `visibilityWhere` is the same rule as a
 * Prisma `where` for list queries; `visibleUserEmails` fans a dashboard out to the
 * people allowed to see it (shift summaries, alerts).
 */

import type { Prisma } from '@/lib/generated/prisma/client';

export type VisibilityUser = {
  id: string;
  roleId: string | null;
  isAdmin: boolean;
};

export type VisibilityDashboard = {
  status: string;
  visibleToAll: boolean;
  visibilityRoleIds: unknown;
  visibilityUserIds: unknown;
  createdById: string | null;
  requesterId: string | null;
};

function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function canSee(dash: VisibilityDashboard, user: VisibilityUser): boolean {
  if (user.isAdmin) return true;
  if (dash.status !== 'live') return false;
  if (dash.visibleToAll) return true;
  if (dash.requesterId === user.id || dash.createdById === user.id) return true;
  if (ids(dash.visibilityUserIds).includes(user.id)) return true;
  if (user.roleId && ids(dash.visibilityRoleIds).includes(user.roleId)) return true;
  return false;
}

/** Prisma `where` equivalent of `canSee` for `prisma.dashboard.findMany`. */
export function visibilityWhere(user: VisibilityUser): Prisma.DashboardWhereInput {
  if (user.isAdmin) return {};
  const or: Prisma.DashboardWhereInput[] = [
    { visibleToAll: true },
    { requesterId: user.id },
    { createdById: user.id },
    { visibilityUserIds: { array_contains: [user.id] } },
  ];
  if (user.roleId) or.push({ visibilityRoleIds: { array_contains: [user.roleId] } });
  return { status: 'live', OR: or };
}

type UserLookup = {
  findMany(args: {
    where: Record<string, unknown>;
    select: { id: true; email: true; roleId: true; isAdmin: true };
  }): Promise<{ id: string; email: string; roleId: string | null; isAdmin: boolean }[]>;
};

/**
 * Distinct, lower-cased emails of active users who can see the dashboard.
 * `roleFilter` narrows to specific roles (e.g. a shift summary's recipient roles).
 */
export async function visibleUserEmails(
  dash: VisibilityDashboard,
  opts: { roleFilter?: string[]; includeAdmins?: boolean; users?: UserLookup } = {},
): Promise<string[]> {
  const users = opts.users ?? (await import('@/shared/lib/db')).prisma.user;
  const where: Record<string, unknown> = { status: 'ACTIVE' };
  if (opts.roleFilter?.length) where.roleId = { in: opts.roleFilter };
  const rows = await users.findMany({ where, select: { id: true, email: true, roleId: true, isAdmin: true } });
  const out = new Set<string>();
  for (const u of rows) {
    const visible = canSee(dash, { id: u.id, roleId: u.roleId, isAdmin: opts.includeAdmins === false ? false : u.isAdmin });
    if (!visible) continue;
    const e = (u.email || '').trim().toLowerCase();
    if (e) out.add(e);
  }
  return [...out];
}
