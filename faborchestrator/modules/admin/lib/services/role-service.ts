/**
 * Role Service - CRUD operations for role management.
 */

import prisma from '@/shared/lib/db';
import { recordAuditLog } from './audit-service';
import { chipIdList, defaultChipIds, normalizeRoleChips, type ChipInfo } from '@/modules/admin/lib/dashboards/prompt-chips';
import { ADMIN_ROLE_DEFAULTS, ADMIN_ROLE_NAME } from '@/shared/lib/permissions';
import { ALLOWED_MODELS } from '@/shared/lib/errors/parameter-values';

export interface CreateRoleData {
  name: string;
  description?: string;
  permissions?: string[];
  allowedModels?: string[];
  systemInstructions?: string;
  customInstructionsEnabled?: boolean;
  customInstructionsMaxLength?: number;
  personalMcpEnabled?: boolean;
  personalMcpMaxCount?: number;
  dailyRequestLimit?: number | null;
  dailyTokenLimit?: number | null;
  /** Ordered prompt-chip ids, stored as sent. Omitted on create → the default chips when the 'dashboards' permission is set, else []. */
  promptChipIds?: string[];
}

// Minimal Prisma-like client for the chip lookup (works inside a transaction).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChipClient = { promptChip: { findMany: (args: any) => Promise<any[]> } };

/** Load the library rows the chip rules need (id, default/active flags, order). */
async function loadChipInfo(client: ChipClient): Promise<ChipInfo[]> {
  const rows = await client.promptChip.findMany({ select: { id: true, is_default: true, is_active: true, sort_order: true } });
  return rows.map((r: { id: string; is_default: boolean; is_active: boolean; sort_order: number }) => ({
    id: r.id, isDefault: r.is_default, isActive: r.is_active, sortOrder: r.sort_order,
  }));
}

export async function listRoles() {
  const roles = await prisma.role.findMany({
    include: { _count: { select: { users: true, mcpConnections: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return roles.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    isSystemRole: r.isSystemRole,
    permissions: r.permissions,
    allowedModels: r.allowedModels,
    systemInstructions: r.systemInstructions,
    customInstructionsEnabled: r.customInstructionsEnabled,
    customInstructionsMaxLength: r.customInstructionsMaxLength,
    personalMcpEnabled: r.personalMcpEnabled,
    personalMcpMaxCount: r.personalMcpMaxCount,
    dailyRequestLimit: r.dailyRequestLimit,
    dailyTokenLimit: r.dailyTokenLimit,
    promptChipIds: chipIdList(r.promptChipIds),
    memberCount: r._count.users,
    mcpCount: r._count.mcpConnections,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/**
 * The built-in Admin role exists by default and always has full access.
 *
 * Idempotent: creates the row when missing and re-applies the full-access
 * fields when present (every permission, every active platform model, personal
 * MCP on, no daily limits, system role). Called on server boot, by the seed,
 * and after every save of the role, so nobody has to create or repair it by hand.
 */
export async function ensureAdminRole(): Promise<{ id: string; created: boolean }> {
  const registry = await prisma.modelRegistry.findMany({ where: { isActive: true }, select: { modelId: true } }).catch(() => []);
  const allowedModels = registry.length ? registry.map((m) => m.modelId) : [...ALLOWED_MODELS];
  const fullAccess = {
    description: ADMIN_ROLE_DEFAULTS.description,
    isSystemRole: true,
    permissions: [...ADMIN_ROLE_DEFAULTS.permissions],
    allowedModels,
    customInstructionsEnabled: ADMIN_ROLE_DEFAULTS.customInstructionsEnabled,
    customInstructionsMaxLength: ADMIN_ROLE_DEFAULTS.customInstructionsMaxLength,
    personalMcpEnabled: ADMIN_ROLE_DEFAULTS.personalMcpEnabled,
    personalMcpMaxCount: ADMIN_ROLE_DEFAULTS.personalMcpMaxCount,
    dailyRequestLimit: null,
    dailyTokenLimit: null,
  };
  const existing = await prisma.role.findUnique({ where: { name: ADMIN_ROLE_NAME }, select: { id: true } });
  if (existing) {
    await prisma.role.update({ where: { id: existing.id }, data: fullAccess });
    return { id: existing.id, created: false };
  }
  const created = await prisma.role.create({ data: { name: ADMIN_ROLE_NAME, ...fullAccess } });
  return { id: created.id, created: true };
}

export async function createRole(
  data: CreateRoleData,
  adminUserId: string,
  ipAddress: string | null
) {
  // Check name uniqueness
  const existing = await prisma.role.findUnique({ where: { name: data.name } });
  if (existing) throw new Error(`Role "${data.name}" already exists`);

  return prisma.$transaction(async (tx) => {
    const permissions = data.permissions || [];
    const promptChipIds =
      data.promptChipIds === undefined
        ? defaultChipIds(await loadChipInfo(tx), permissions)
        : normalizeRoleChips(data.promptChipIds);
    const role = await tx.role.create({
      data: {
        name: data.name,
        description: data.description || null,
        permissions: data.permissions || [],
        allowedModels: data.allowedModels || [],
        systemInstructions: data.systemInstructions || null,
        customInstructionsEnabled: data.customInstructionsEnabled ?? true,
        customInstructionsMaxLength: data.customInstructionsMaxLength ?? 1000,
        personalMcpEnabled: data.personalMcpEnabled ?? false,
        // Managing implies adding: at least 1 own server while the option is on.
        personalMcpMaxCount: data.personalMcpEnabled ? Math.max(1, data.personalMcpMaxCount ?? 3) : (data.personalMcpMaxCount ?? 3),
        dailyRequestLimit: data.dailyRequestLimit ?? null,
        dailyTokenLimit: data.dailyTokenLimit ?? null,
        promptChipIds,
      },
    });

    await recordAuditLog(tx, {
      userId: adminUserId,
      action: 'role.created',
      targetType: 'Role',
      targetId: role.id,
      metadata: { name: role.name },
      ipAddress,
    });

    return role;
  });
}

export async function updateRole(
  roleId: string,
  data: Partial<CreateRoleData>,
  adminUserId: string,
  ipAddress: string | null
) {
  // If name is changing, check uniqueness
  if (data.name) {
    const existing = await prisma.role.findFirst({
      where: { name: data.name, id: { not: roleId } },
    });
    if (existing) throw new Error(`Role "${data.name}" already exists`);
  }

  const current = await prisma.role.findUnique({ where: { id: roleId }, select: { name: true, isSystemRole: true } });
  if (!current) throw new Error('Role not found');
  const isBuiltInAdmin = current.name === ADMIN_ROLE_NAME && current.isSystemRole;
  if (isBuiltInAdmin && data.name !== undefined && data.name !== ADMIN_ROLE_NAME) {
    throw new Error('The built-in Admin role cannot be renamed.');
  }

  const saved = await prisma.$transaction(async (tx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.permissions !== undefined) updateData.permissions = data.permissions;
    if (data.allowedModels !== undefined) updateData.allowedModels = data.allowedModels;
    if (data.systemInstructions !== undefined) updateData.systemInstructions = data.systemInstructions;
    if (data.customInstructionsEnabled !== undefined) updateData.customInstructionsEnabled = data.customInstructionsEnabled;
    if (data.customInstructionsMaxLength !== undefined) updateData.customInstructionsMaxLength = data.customInstructionsMaxLength;
    if (data.personalMcpEnabled !== undefined) updateData.personalMcpEnabled = data.personalMcpEnabled;
    if (data.personalMcpMaxCount !== undefined) updateData.personalMcpMaxCount = data.personalMcpMaxCount;
    // Managing implies adding: at least 1 own server while the option is on.
    if (data.personalMcpEnabled === true && (data.personalMcpMaxCount ?? 0) < 1) updateData.personalMcpMaxCount = Math.max(1, data.personalMcpMaxCount ?? 1);
    if (data.dailyRequestLimit !== undefined) updateData.dailyRequestLimit = data.dailyRequestLimit;
    if (data.dailyTokenLimit !== undefined) updateData.dailyTokenLimit = data.dailyTokenLimit;

    // Chips are stored exactly as chosen (cleaned); permissions never filter them.
    if (data.promptChipIds !== undefined) updateData.promptChipIds = normalizeRoleChips(data.promptChipIds);

    const role = await tx.role.update({
      where: { id: roleId },
      data: updateData,
    });

    await recordAuditLog(tx, {
      userId: adminUserId,
      action: 'role.updated',
      targetType: 'Role',
      targetId: roleId,
      metadata: { name: role.name, updatedFields: Object.keys(updateData) },
      ipAddress,
    });

    return role;
  });

  // Whatever the form sent, the built-in Admin role keeps full access.
  if (isBuiltInAdmin) {
    await ensureAdminRole();
    return prisma.role.findUniqueOrThrow({ where: { id: roleId } });
  }
  return saved;
}

export async function deleteRole(
  roleId: string,
  adminUserId: string,
  ipAddress: string | null
) {
  const role = await prisma.role.findUnique({
    where: { id: roleId },
    include: { _count: { select: { users: true } } },
  });

  if (!role) throw new Error('Role not found');
  if (role.name === ADMIN_ROLE_NAME && role.isSystemRole) {
    throw new Error('The built-in Admin role cannot be deleted.');
  }
  if (role._count.users > 0) {
    throw new Error(`"${role.name}" still has ${role._count.users} assigned user${role._count.users === 1 ? '' : 's'}. Reassign them to another role first, then delete it.`);
  }
  // Never remove the last role that grants admin access — that would lock every
  // administrator out of this console after their next role change.
  const perms = Array.isArray(role.permissions) ? (role.permissions as unknown[]) : [];
  if (perms.includes('admin')) {
    const otherAdminRoles = await prisma.role.count({ where: { id: { not: roleId }, permissions: { array_contains: ['admin'] } } });
    if (otherAdminRoles === 0) throw new Error(`"${role.name}" is the only role with admin access and cannot be deleted.`);
  }

  return prisma.$transaction(async (tx) => {
    await tx.role.delete({ where: { id: roleId } });

    await recordAuditLog(tx, {
      userId: adminUserId,
      action: 'role.deleted',
      targetType: 'Role',
      targetId: roleId,
      metadata: { name: role.name },
      ipAddress,
    });
  });
}
