/**
 * Platform permissions and the built-in Admin role.
 *
 * Every role stores a JSON array of permission keys (`roles.permissions`).
 * The keys below are the complete catalogue; the Admin role always carries all
 * of them, and any user who is a platform admin passes every permission check
 * regardless of what their role row says — so a future permission can never
 * lock administrators out.
 *
 * A user is a platform admin when any of these holds:
 *   - `users.is_admin` is set (the bootstrap flag),
 *   - their role is the built-in Admin role,
 *   - their role carries the `admin` permission.
 */

export const ADMIN_ROLE_NAME = 'Admin';

export const PERMISSIONS = {
  ADMIN: 'admin',
  CHAT: 'chat',
  MCP: 'mcp',
  ARTIFACTS: 'artifacts',
  FILE_UPLOAD: 'file_upload',
  WEB_SEARCH: 'web_search',
  DASHBOARDS: 'dashboards',
  MODELING_AGENT: 'modeling_agent',
  BACKEND_AGENT: 'backend_agent',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** The full catalogue, in display order. */
export const ALL_PERMISSIONS: readonly PermissionKey[] = [
  PERMISSIONS.ADMIN,
  PERMISSIONS.CHAT,
  PERMISSIONS.MCP,
  PERMISSIONS.ARTIFACTS,
  PERMISSIONS.FILE_UPLOAD,
  PERMISSIONS.WEB_SEARCH,
  PERMISSIONS.DASHBOARDS,
  PERMISSIONS.MODELING_AGENT,
  PERMISSIONS.BACKEND_AGENT,
];

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  admin: 'Admin Console',
  chat: 'Chat',
  mcp: 'MCP',
  artifacts: 'Artifacts',
  file_upload: 'File upload',
  web_search: 'Web search',
  dashboards: 'Dashboard Scheduling',
  modeling_agent: 'Modeling Agent',
  backend_agent: 'Coding Agent',
};

/** What the built-in Admin role always looks like (enforced on boot, seed and every save). */
export const ADMIN_ROLE_DEFAULTS = {
  name: ADMIN_ROLE_NAME,
  description: 'Full access to the entire platform. Built in; cannot be restricted or deleted.',
  isSystemRole: true,
  permissions: [...ALL_PERMISSIONS] as string[],
  customInstructionsEnabled: true,
  customInstructionsMaxLength: 4000,
  personalMcpEnabled: true,
  personalMcpMaxCount: 99,
  dailyRequestLimit: null as number | null,
  dailyTokenLimit: null as number | null,
} as const;

export type AdminSubject = {
  isAdmin?: boolean | null;
  role?: { name?: string | null; permissions?: unknown } | null;
} | null | undefined;

function permissionList(role: { permissions?: unknown } | null | undefined): string[] {
  const p = role?.permissions;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
}

/** True for the bootstrap flag, the built-in Admin role, or any role carrying `admin`. */
export function isPlatformAdmin(user: AdminSubject): boolean {
  if (!user) return false;
  if (user.isAdmin === true) return true;
  if (user.role?.name === ADMIN_ROLE_NAME) return true;
  return permissionList(user.role).includes(PERMISSIONS.ADMIN);
}

/** Permission check that platform admins always pass. */
export function hasPermission(user: AdminSubject, permission: PermissionKey | string): boolean {
  if (isPlatformAdmin(user)) return true;
  return permissionList(user?.role).includes(permission);
}
