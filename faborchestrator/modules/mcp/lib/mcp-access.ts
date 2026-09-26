/**
 * What a user may do with MCP connections, derived from their role:
 *
 *  - `enabled`         the role carries the `mcp` permission (admins always) —
 *                      without it no connections are listed, no tools are loaded
 *                      and the UI hides every MCP surface;
 *  - `canEditPersonal` the role's "users can manage MCP connections" option
 *                      (`personalMcpEnabled`). With it the user may connect /
 *                      disconnect ANY server they are entitled to — the ones the
 *                      admin assigned to the role as well as their own — and
 *                      add, edit, test and delete their own connections.
 *                      Without it every entitled server is simply connected.
 *  - `canAddPersonal`  same as `canEditPersonal`: managing implies adding own
 *                      servers, up to `personalMaxCount` (at least 1; admins
 *                      unlimited). A server a user adds is visible to that user only.
 *
 * An admin-assigned (role-level) connection is one row shared by everyone in
 * the role, so a user's disconnect of it is stored per user, in
 * `users.preferences.mcpDisabledIds`, never on the shared row.
 */

import { prisma } from '@/shared/lib/db';
import type { Prisma } from '@/lib/generated/prisma/client';
import { isPlatformAdmin } from '@/shared/lib/permissions';

const MCP_PERMISSION = 'mcp';

export type McpAccess = {
  enabled: boolean;
  canEditPersonal: boolean;
  canAddPersonal: boolean;
  isAdmin: boolean;
  personalMaxCount: number;
};

type RoleBits = { name: string; permissions: unknown; personalMcpEnabled: boolean; personalMcpMaxCount: number } | null;

/** Pure form, for callers that already loaded the user with their role. */
export function mcpAccessFrom(user: { isAdmin: boolean; role: RoleBits } | null): McpAccess {
  const isAdmin = isPlatformAdmin(user);
  const perms = Array.isArray(user?.role?.permissions) ? (user!.role!.permissions as unknown[]) : [];
  const enabled = isAdmin || perms.includes(MCP_PERMISSION);
  const canEditPersonal = enabled && (isAdmin || user?.role?.personalMcpEnabled === true);
  // Managing implies adding at least one own server (roles saved before this rule may still hold 0).
  const personalMaxCount = canEditPersonal ? Math.max(1, user?.role?.personalMcpMaxCount ?? 1) : 0;
  return {
    enabled,
    canEditPersonal,
    canAddPersonal: canEditPersonal,
    isAdmin,
    personalMaxCount,
  };
}

export async function mcpAccess(userId: string): Promise<McpAccess> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isAdmin: true, role: { select: { name: true, permissions: true, personalMcpEnabled: true, personalMcpMaxCount: true } } },
  });
  return mcpAccessFrom(user);
}

const DISABLED_KEY = 'mcpDisabledIds';

/** Ids of role-level connections this user switched off, from `users.preferences`. */
export function disabledManagedIdsFrom(preferences: unknown): Set<string> {
  const raw = preferences && typeof preferences === 'object' ? (preferences as Record<string, unknown>)[DISABLED_KEY] : undefined;
  return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
}

export async function getDisabledManagedIds(userId: string): Promise<Set<string>> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { preferences: true } });
  return disabledManagedIdsFrom(user?.preferences);
}

/** Record (or clear) this user's disconnect of a role-level connection. */
export async function setManagedDisabled(userId: string, connectionId: string, disabled: boolean): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { preferences: true } });
  const prefs = user?.preferences && typeof user.preferences === 'object' ? { ...(user.preferences as Record<string, unknown>) } : {};
  const ids = disabledManagedIdsFrom(prefs);
  if (disabled) ids.add(connectionId); else ids.delete(connectionId);
  prefs[DISABLED_KEY] = [...ids];
  await prisma.user.update({ where: { id: userId }, data: { preferences: prefs as Prisma.InputJsonObject } });
}
