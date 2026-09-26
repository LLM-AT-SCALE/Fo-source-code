/**
 * Admin Tools - Tool definitions for AI-powered admin chat.
 * Each tool calls the same service layer as the API routes.
 * Uses plain objects compatible with AI SDK v6 streamText().
 */

import { z } from 'zod';
import { listUsers, updateUserStatus, changeUserRole, forcePasswordReset, deleteUser } from '@/modules/admin/lib/services/admin-user-service';
import { listRoles, createRole, updateRole, deleteRole } from '@/modules/admin/lib/services/role-service';
import { createInvitation, listInvitations, revokeInvitation, resendInvitation } from '@/modules/admin/lib/services/invitation-service';
import { getSystemUsageSummary } from '@/modules/admin/lib/services/usage-service';
import { getRequirements } from '@/modules/admin/lib/mcp/mcp-onthefly/requirements';
import {
  listDataSources,
  connectDataSource,
  setDataSourceSchema,
  generateDataSourceManifest,
  deployDataSource,
  assignDataSource,
  unassignDataSource,
} from '@/modules/admin/lib/mcp/mcp-onthefly/service';
import prisma from '@/shared/lib/db';
import { getSchedulableDashboards, resolveAgainst } from '@/modules/admin/lib/dashboards/report-dashboards';
import { parseMetricKey } from '@/modules/admin/lib/dashboards/alert-metrics';
import { displayToolCallNames, mergeByDisplayName, stripMcpPrefixes } from '@/modules/admin/lib/mcp/mcp-tool-name';

// ── Recent Reports refresh scheduling ───────────────────────────────────────
// Schedulable dashboards = the live/paused rows of the shared `dashboards`
// table (seeded + approved custom dashboards). The list comes from
// getSchedulableDashboards() (keyed by dashboards.slug, labelled by title);
// resolveAgainst() maps a user-supplied name/id/"all" to dashboard ids. The
// admin app writes report_schedules (raw SQL below) with next_run_at = now(), so
// the row is due on Fab Orch's next tick; Fab Orch computes every later run.

type ReportFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

async function resolveUserId(userId?: string, userEmail?: string): Promise<string | null> {
  if (userId) return userId;
  if (userEmail) {
    const user = await prisma.user.findFirst({
      where: { email: { equals: userEmail, mode: 'insensitive' } },
    });
    return user?.id || null;
  }
  return null;
}

export function getAdminTools(adminUserId: string) {
  return {
    list_users: {
      description: 'List all users with optional search, role, and status filters',
      inputSchema: z.object({
        search: z.string().optional().describe('Search by name or email'),
        status: z.enum(['ACTIVE', 'SUSPENDED']).optional().describe('Filter by status'),
        roleId: z.string().optional().describe('Filter by role ID'),
      }),
      execute: async ({ search, status, roleId }: { search?: string; status?: string; roleId?: string }) => {
        const result = await listUsers({ search, status, roleId });
        return {
          total: result.total,
          users: result.users.map((u) => ({
            id: u.id,
            name: u.name,
            email: u.email,
            role: u.role?.name || 'No role',
            roleId: u.role?.id || null,
            status: u.status,
            isAdmin: u.isAdmin,
            lastLogin: u.lastLogin,
          })),
        };
      },
    },

    list_mcp_datasource_requirements: {
      description:
        'List the connection parameters an admin must provide to create an on-the-fly MCP data source (Step 1 of the flow). Data sources are ALWAYS on-premises Microsoft SQL Server — NEVER mention, offer, or compare PostgreSQL or any other database type/engine. Use this when the user asks what is needed to add/create an MCP server or data source. Explain that credentials must be uploaded via the secure upload control (which posts to /api/admin/mcp/secrets) and NEVER pasted into chat, since chat content is sent to the model and stored.',
      inputSchema: z.object({}),
      execute: async () => {
        return getRequirements('sqlserver');
      },
    },

    list_mcp_datasources: {
      description:
        'List all on-the-fly MCP data sources and their lifecycle status (DRAFT, CONNECTED, GENERATED, DEPLOYING, ACTIVE, FAILED, RETIRED). Use to check progress of a data source the admin created by uploading credentials.',
      inputSchema: z.object({}),
      execute: async () => {
        const sources = await listDataSources();
        return { total: sources.length, sources };
      },
    },

    connect_mcp_datasource: {
      description:
        'ALWAYS the first step after a data source is created: connect to it and AUTOMATICALLY discover the available tables/columns (read-only). This works for all supported targets, including on-prem databases (discovery runs securely from inside the network). Do NOT ask the user for the tables/columns — call this to find them automatically. Requires the data source id. Advances status to CONNECTED.',
      inputSchema: z.object({
        dataSourceId: z.string().describe('The MCP data source id'),
      }),
      execute: async ({ dataSourceId }: { dataSourceId: string }) => {
        const r = await connectDataSource(dataSourceId, adminUserId);
        if (!r.ok) {
          const d = (r.details ?? {}) as { kind?: 'platform' | 'target'; errorId?: string };
          const platform = d.kind === 'platform';
          return {
            error: r.error,
            failureKind: platform ? 'platform' : 'target',
            errorId: d.errorId,
            adminMessage: platform
              ? `The platform's discovery service is not available right now, so the connection could not be checked. The connection details are NOT the cause — do not ask the admin to re-upload them. Say the platform team has to restore the discovery service${d.errorId ? ` and that the failure is recorded in Admin → Errors under id ${d.errorId}` : ''}, then STOP.`
              : 'The discovery service ran but could not reach or sign in to the data source. Ask the admin to re-check the connection details (host, port, database, login) via the secure upload control, then STOP.',
          };
        }
        return { reachable: true, latencyMs: r.latencyMs, tableCount: r.tableCount, tables: r.tables };
      },
    },

    set_mcp_datasource_schema: {
      description:
        'FALLBACK ONLY — do NOT use this by default. Use connect_mcp_datasource first; it auto-discovers the tables/columns. Only call this if connect_mcp_datasource genuinely fails to reach the data source, in which case the admin can supply the tables/columns manually. Advances status to CONNECTED.',
      inputSchema: z.object({
        dataSourceId: z.string(),
        tables: z.array(z.object({
          schema: z.string().describe('Schema name, e.g. cammes'),
          table: z.string().describe('Table name'),
          columns: z.array(z.object({
            column: z.string(),
            type: z.string().describe('SQL type, e.g. int, nvarchar, datetime'),
            nullable: z.boolean().optional(),
          })).min(1),
        })).min(1),
      }),
      execute: async ({ dataSourceId, tables }: { dataSourceId: string; tables: Array<{ schema: string; table: string; columns: Array<{ column: string; type: string; nullable?: boolean }> }> }) => {
        const r = await setDataSourceSchema(dataSourceId, tables, adminUserId);
        if (!r.ok) return { error: r.error };
        return { ok: true, tableCount: r.tableCount, note: 'Schema set. Next: generate_mcp_datasource_manifest.' };
      },
    },

    generate_mcp_datasource_manifest: {
      description:
        'Step 3 — generate the read-only SELECT tool manifest for a CONNECTED data source. The LLM produces tool specs (data), which are static-checked for read-only safety. Returns the tools for the admin to REVIEW before deploying. Advances status to GENERATED.',
      inputSchema: z.object({
        dataSourceId: z.string().describe('The MCP data source id'),
      }),
      execute: async ({ dataSourceId }: { dataSourceId: string }) => {
        const r = await generateDataSourceManifest(dataSourceId, adminUserId);
        if (!r.ok) return { error: r.error, details: r.details };
        // Distinct tables the tools read from — used for the safety summary.
        const tables = new Set<string>();
        for (const t of r.manifest?.tools || []) {
          for (const m of t.sql.matchAll(/\b(?:from|join)\s+\[?[A-Za-z0-9_]+\]?\.\[?([A-Za-z0-9_]+)\]?/gi)) tables.add(m[1]);
        }
        // Did the tools cover EVERY table discovery exposed? (small DB, all areas
        // tooled) vs a focused SUBSET (large DB). Drives the wording of the review
        // disclaimer so we don't say "not every table" when it IS every table.
        const discoveredTableCount = r.discoveredTableCount ?? tables.size;
        const coversAllData = tables.size >= discoveredTableCount;
        return {
          ok: true,
          toolCount: r.staticCheck.toolCount,
          tableCount: tables.size,
          discoveredTableCount,
          coversAllData,
          // Pre-deploy VALIDATION summary — every item here is enforced by the
          // static safety gate + the fixed read-only runtime, so these are true
          // guarantees, not marketing. Surface them to the admin before deploy.
          validation: {
            passed: true,
            checks: [
              'Read-only look-ups only — the tools can view information but can never change, add, or delete anything',
              'No update, delete, or structural commands are possible — every request is a plain look-up',
              'Every field was checked against your real data, so there are no invalid or made-up fields',
              'All search inputs are handled safely (nothing a user types can be misused)',
              'Login details stay stored securely and are never shared with the AI or shown in chat',
            ],
          },
          tools: (r.manifest?.tools || []).map((t) => ({ name: t.name, description: t.description })),
          note: 'Show the tools as a Markdown TABLE (Tool | What your users can look up) and ask whether to make it live. For the disclaimer line: if coversAllData is TRUE, reassure that ALL of the data is covered (do NOT say "not every table"); if coversAllData is FALSE, say this is a focused subset. Do NOT show the validation/safety details yet — the validation.checks are shown as a table at the DEPLOY step, right before deploying.',
        };
      },
    },

    deploy_mcp_datasource: {
      description:
        'Step 4+5 — deploy a GENERATED data source as a per-source Lambda, validate it, and register it so it can be assigned. Only call after the admin has reviewed the generated tools. Advances status to ACTIVE. (Creates a real AWS Lambda — requires the AWS substrate to be provisioned.)',
      inputSchema: z.object({
        dataSourceId: z.string().describe('The MCP data source id'),
      }),
      execute: async ({ dataSourceId }: { dataSourceId: string }) => {
        const r = await deployDataSource(dataSourceId, adminUserId);
        if (!r.ok) return { error: r.error, details: r.details };
        return {
          status: r.status,
          toolCount: r.toolCount,
          note: 'The data source is now securely deployed and running. Give a CRISP but information-rich confirmation: it is now securely DEPLOYED and running (live), its <toolCount> read-only look-up tools are active and ready for people to use in chat, it stays read-only (view only, never changes data), and its login details remain stored securely. It is fine to say it is "deployed and running securely", but do NOT expose deep infrastructure jargon (no AWS/Lambda/VPC/URLs/IDs/status words). Then ask who should have access.',
        };
      },
    },

    assign_mcp_datasource: {
      description:
        'Step 6 — assign an ACTIVE on-the-fly MCP data source to a role or a user, so FabOrchestrator users can use its tools in chat. Provide the data source id plus a role name OR a user email.',
      inputSchema: z.object({
        dataSourceId: z.string().describe('The MCP data source id'),
        roleName: z.string().optional().describe('Role to assign to'),
        userEmail: z.string().optional().describe('User email to assign to'),
      }),
      execute: async ({ dataSourceId, roleName, userEmail }: { dataSourceId: string; roleName?: string; userEmail?: string }) => {
        let roleId: string | undefined;
        let userId: string | undefined;
        if (roleName) {
          const role = await prisma.role.findFirst({ where: { name: { equals: roleName, mode: 'insensitive' } } });
          if (!role) return { error: `Role "${roleName}" not found` };
          roleId = role.id;
        } else if (userEmail) {
          const resolved = await resolveUserId(undefined, userEmail);
          if (!resolved) return { error: `User "${userEmail}" not found` };
          userId = resolved;
        } else {
          return { error: 'Provide a roleName or a userEmail' };
        }
        const r = await assignDataSource(dataSourceId, { roleId, userId }, adminUserId);
        if (!r.ok) return { error: r.error };
        return { success: true, connectionId: r.connectionId, target: r.target };
      },
    },

    unassign_mcp_datasource: {
      description:
        'Remove a user or role\'s access to an on-the-fly MCP data source (the opposite of assign). Use when the admin says things like "remove <data source> from <person>", "disconnect X from Y", "revoke <team>\'s access", or "take it away from <email>". Identify the data source by its NAME (or id) plus a user email OR a role name. After removal, that person/team no longer sees the data source\'s tools in their chat.',
      inputSchema: z.object({
        dataSourceId: z.string().optional().describe('The MCP data source id, if known'),
        dataSourceName: z.string().optional().describe('The data source name (used to look up the id when the id is not given)'),
        roleName: z.string().optional().describe('Role to remove access from'),
        userEmail: z.string().optional().describe('User email to remove access from'),
      }),
      execute: async ({ dataSourceId, dataSourceName, roleName, userEmail }: { dataSourceId?: string; dataSourceName?: string; roleName?: string; userEmail?: string }) => {
        // Resolve the data source id from its name if the id wasn't supplied.
        let id = dataSourceId;
        if (!id && dataSourceName) {
          const sources = await listDataSources();
          const key = dataSourceName.trim().toLowerCase();
          const match = sources.find((s) => s.name.toLowerCase() === key) || sources.find((s) => s.name.toLowerCase().includes(key));
          if (!match) return { error: `No data source named "${dataSourceName}" found` };
          id = match.id;
        }
        if (!id) return { error: 'Provide the data source name or id' };
        let roleId: string | undefined;
        let userId: string | undefined;
        if (roleName) {
          const role = await prisma.role.findFirst({ where: { name: { equals: roleName, mode: 'insensitive' } } });
          if (!role) return { error: `Role "${roleName}" not found` };
          roleId = role.id;
        } else if (userEmail) {
          const resolved = await resolveUserId(undefined, userEmail);
          if (!resolved) return { error: `User "${userEmail}" not found` };
          userId = resolved;
        } else {
          return { error: 'Provide a roleName or a userEmail' };
        }
        const r = await unassignDataSource(id, { roleId, userId }, adminUserId);
        if (!r.ok) return { error: r.error };
        return { success: true, removed: r.removed, target: r.target };
      },
    },

    invite_user: {
      description: 'Invite a new user by sending an invitation email. The user will set their own password. Requires email and role.',
      inputSchema: z.object({
        email: z.string().email().describe('User email address to invite'),
        roleName: z.string().optional().describe('Role name (e.g. "Technical", "Business", "Basic"). If not provided, list roles first to get the ID.'),
        roleId: z.string().optional().describe('Role ID to assign. Use this if you already know the ID.'),
      }),
      execute: async ({ email, roleName, roleId }: { email: string; roleName?: string; roleId?: string }) => {
        // Resolve role by name if roleId not provided
        let resolvedRoleId = roleId;
        if (!resolvedRoleId && roleName) {
          const role = await prisma.role.findFirst({
            where: { name: { equals: roleName, mode: 'insensitive' } },
          });
          if (!role) {
            const allRoles = await prisma.role.findMany({ select: { id: true, name: true, description: true } });
            return {
              needsRole: true,
              message: `Role "${roleName}" not found. Here are the available roles:`,
              availableRoles: allRoles.map(r => ({ id: r.id, name: r.name, description: r.description })),
              pendingEmail: email,
            };
          }
          resolvedRoleId = role.id;
        }
        if (!resolvedRoleId) {
          const allRoles = await prisma.role.findMany({ select: { id: true, name: true, description: true } });
          return {
            needsRole: true,
            message: `Which role should ${email} be invited with? Here are the available roles:`,
            availableRoles: allRoles.map(r => ({ id: r.id, name: r.name, description: r.description })),
            pendingEmail: email,
          };
        }

        try {
          const result = await createInvitation({
            email,
            roleId: resolvedRoleId,
            adminUserId,
            ipAddress: 'chat-admin',
          });
          return {
            success: true,
            message: `Invitation sent to ${email}`,
            role: result.role,
            expiresAt: result.expiresAt,
            acceptUrl: result.acceptUrl,
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Failed to send invitation' };
        }
      },
    },

    suspend_user: {
      description: 'Suspend a user account (blocks login, deletes sessions). Can lookup by email.',
      inputSchema: z.object({
        userId: z.string().optional().describe('User ID to suspend'),
        userEmail: z.string().optional().describe('User email to look up'),
      }),
      execute: async ({ userId, userEmail }: { userId?: string; userEmail?: string }) => {
        const id = await resolveUserId(userId, userEmail);
        if (!id) return { error: 'Provide userId or userEmail' };
        try {
          await updateUserStatus(id, 'SUSPENDED', adminUserId, 'chat-admin');
          return { success: true, message: 'User suspended and all sessions terminated' };
        } catch (err) { return { error: err instanceof Error ? err.message : 'Failed' }; }
      },
    },

    activate_user: {
      description: 'Activate a suspended user account. Can lookup by email.',
      inputSchema: z.object({
        userId: z.string().optional().describe('User ID to activate'),
        userEmail: z.string().optional().describe('User email to look up'),
      }),
      execute: async ({ userId, userEmail }: { userId?: string; userEmail?: string }) => {
        const id = await resolveUserId(userId, userEmail);
        if (!id) return { error: 'Provide userId or userEmail' };
        try {
          await updateUserStatus(id, 'ACTIVE', adminUserId, 'chat-admin');
          return { success: true, message: 'User activated' };
        } catch (err) { return { error: err instanceof Error ? err.message : 'Failed' }; }
      },
    },

    bulk_assign_role: {
      description: 'Assign a role to multiple users at once. Use this when changing role for more than one user. Provide either a list of user emails or "all_without_role" to target users with no role assigned.',
      inputSchema: z.object({
        userEmails: z.array(z.string()).optional().describe('List of user email addresses'),
        allWithoutRole: z.boolean().optional().describe('If true, target all users without a role'),
        excludeEmails: z.array(z.string()).optional().describe('Emails to exclude (e.g. admin)'),
        roleName: z.string().optional().describe('Role name to assign'),
        roleId: z.string().optional().describe('Role ID to assign'),
      }),
      execute: async ({ userEmails, allWithoutRole, excludeEmails, roleName, roleId }: { userEmails?: string[]; allWithoutRole?: boolean; excludeEmails?: string[]; roleName?: string; roleId?: string }) => {
        // Resolve role
        let resolvedRoleId = roleId;
        if (!resolvedRoleId && roleName) {
          const role = await prisma.role.findFirst({ where: { name: { equals: roleName, mode: 'insensitive' } } });
          if (!role) return { error: `Role "${roleName}" not found` };
          resolvedRoleId = role.id;
        }
        if (!resolvedRoleId) return { error: 'Provide roleName or roleId' };

        // Get target users
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const where: any = {};
        if (allWithoutRole) {
          where.roleId = null;
        } else if (userEmails && userEmails.length > 0) {
          where.email = { in: userEmails.map(e => e.toLowerCase()) };
        } else {
          return { error: 'Provide userEmails or set allWithoutRole=true' };
        }
        if (excludeEmails && excludeEmails.length > 0) {
          where.email = { ...where.email, notIn: excludeEmails.map(e => e.toLowerCase()) };
        }

        const users = await prisma.user.findMany({ where, select: { id: true, email: true, name: true } });
        if (users.length === 0) return { error: 'No matching users found' };

        // Bulk update
        const updated = await prisma.user.updateMany({
          where: { id: { in: users.map(u => u.id) } },
          data: { roleId: resolvedRoleId },
        });

        const roleName2 = (await prisma.role.findUnique({ where: { id: resolvedRoleId }, select: { name: true } }))?.name;

        return {
          success: true,
          message: `Assigned "${roleName2}" role to ${updated.count} users`,
          count: updated.count,
          users: users.map(u => u.name || u.email),
        };
      },
    },

    change_user_role: {
      description: 'Change a single user\'s assigned role. Can lookup user by name, email, or ID. Can lookup role by name. If role not specified, lists available roles.',
      inputSchema: z.object({
        userId: z.string().optional().describe('User ID (if known)'),
        userEmail: z.string().optional().describe('User email to look up'),
        userName: z.string().optional().describe('User display name to look up'),
        roleId: z.string().optional().describe('New role ID to assign'),
        roleName: z.string().optional().describe('Role name to assign (e.g. Technical, Business)'),
      }),
      execute: async ({ userId, userEmail, userName, roleId, roleName }: { userId?: string; userEmail?: string; userName?: string; roleId?: string; roleName?: string }) => {
        // Resolve user by ID, email, or name
        let resolvedUserId = userId;
        let resolvedUserName = '';
        if (!resolvedUserId && userEmail) {
          const user = await prisma.user.findFirst({ where: { email: { equals: userEmail, mode: 'insensitive' } } });
          if (!user) return { error: `User with email "${userEmail}" not found` };
          resolvedUserId = user.id;
          resolvedUserName = user.name || user.email;
        }
        if (!resolvedUserId && userName) {
          const users = await prisma.user.findMany({
            where: { name: { contains: userName, mode: 'insensitive' }, status: { not: 'DELETED' } },
            select: { id: true, name: true, email: true, role: { select: { name: true } } },
          });
          if (users.length === 0) return { error: `No user found with name "${userName}"` };
          if (users.length > 1) return {
            needsSelection: true,
            message: `Multiple users found matching "${userName}":`,
            users: users.map(u => ({ id: u.id, name: u.name, email: u.email, currentRole: u.role?.name || 'No role' })),
          };
          resolvedUserId = users[0].id;
          resolvedUserName = users[0].name || users[0].email;
        }
        if (!resolvedUserId) return { error: 'Provide userId, userEmail, or userName' };

        // Resolve role — if not provided, list available roles
        let resolvedRoleId = roleId;
        if (!resolvedRoleId && roleName) {
          const role = await prisma.role.findFirst({ where: { name: { equals: roleName, mode: 'insensitive' } } });
          if (!role) {
            const allRoles = await prisma.role.findMany({ select: { id: true, name: true, description: true } });
            return { needsRole: true, message: `Role "${roleName}" not found. Available roles:`, availableRoles: allRoles, pendingUser: resolvedUserName };
          }
          resolvedRoleId = role.id;
        }
        if (!resolvedRoleId) {
          const allRoles = await prisma.role.findMany({ select: { id: true, name: true, description: true } });
          return { needsRole: true, message: `Which role for ${resolvedUserName}?`, availableRoles: allRoles, pendingUser: resolvedUserName };
        }

        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const user = await changeUserRole(resolvedUserId, resolvedRoleId, adminUserId, 'chat-admin') as any;
          return { success: true, message: `Role changed to ${user.role?.name}`, userName: user.name, newRole: user.role?.name };
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Failed to change role' };
        }
      },
    },

    force_password_reset: {
      description: 'Force a user to change their password. Sends a password reset email valid for 7 days and logs them out. Can lookup by email.',
      inputSchema: z.object({
        userId: z.string().optional().describe('User ID'),
        userEmail: z.string().optional().describe('User email to look up'),
      }),
      execute: async ({ userId, userEmail }: { userId?: string; userEmail?: string }) => {
        const id = await resolveUserId(userId, userEmail);
        if (!id) return { error: 'Provide userId or userEmail' };
        try {
          const { emailSent } = await forcePasswordReset(id, adminUserId, 'chat-admin');
          return emailSent
            ? { success: true, emailSent, message: 'Password reset email sent. Link valid for 7 days. All sessions terminated.' }
            : { success: true, emailSent, message: 'Password reset created and all sessions terminated, but the reset email was NOT sent: email (SMTP) is not configured or the send failed. The user cannot reset until email works or an admin shares the link from the server log.' };
        } catch (err) { return { error: err instanceof Error ? err.message : 'Failed' }; }
      },
    },

    list_roles: {
      description: 'List all roles with member counts and configurations',
      inputSchema: z.object({}),
      execute: async () => {
        const roles = await listRoles();
        return {
          total: roles.length,
          roles: roles.map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            memberCount: r.memberCount,
            models: Array.isArray(r.allowedModels) ? (r.allowedModels as string[]).length : 0,
            requestLimit: r.dailyRequestLimit,
            tokenLimit: r.dailyTokenLimit,
            mcpEnabled: r.personalMcpEnabled,
          })),
        };
      },
    },

    create_role: {
      description: 'Create a new role. If models, permissions, or limits are not specified, return available options so the admin can choose.',
      inputSchema: z.object({
        name: z.string().describe('Role name'),
        description: z.string().optional().describe('Role description'),
        allowedModels: z.array(z.string()).optional().describe('Array of allowed model IDs. If empty or not provided, return available models to choose from.'),
        permissions: z.array(z.string()).optional().describe('Permissions: chat, mcp, artifacts, file_upload, web_search, modeling_agent (Modeling Agent), backend_agent (Coding Agent), dashboards (Dashboard Scheduling). The built-in Admin role always has all of them. Defaults to ["chat"] if not provided.'),
        dailyRequestLimit: z.number().nullable().optional().describe('Daily request limit (null=unlimited)'),
        dailyTokenLimit: z.number().nullable().optional().describe('Daily token limit (null=unlimited)'),
        personalMcpEnabled: z.boolean().optional().describe('Allow personal MCP connections'),
      }),
      execute: async (params: { name: string; description?: string; allowedModels?: string[]; permissions?: string[]; dailyRequestLimit?: number | null; dailyTokenLimit?: number | null; personalMcpEnabled?: boolean }) => {
        // If no models specified, return available options for the admin to pick
        if (!params.allowedModels || params.allowedModels.length === 0) {
          return {
            needsInput: true,
            message: `To create the "${params.name}" role, which models should users have access to?`,
            availableModels: [
              { id: 'claude-sonnet-5', name: 'FabOrchestrator 1 (Claude Sonnet 5)', tier: 'Tier 1 — Fast and efficient for everyday work' },
              { id: 'claude-opus-5', name: 'FabOrchestrator 2 (Claude Opus 5)', tier: 'Tier 2 — Strong reasoning for complex tasks' },
              { id: 'claude-fable-5', name: 'FabOrchestrator 3 (Claude Fable 5)', tier: 'Tier 3 — Advanced reasoning for demanding work' },
              { id: 'claude-fable-5-1', name: 'FabOrchestrator 4 (Claude Fable 5.1)', tier: 'Tier 4 — Most capable model' },
            ],
            availablePermissions: ['chat', 'mcp', 'artifacts', 'file_upload', 'web_search', 'modeling_agent', 'backend_agent', 'dashboards'],
            hint: 'Also specify permissions and daily limits if needed. Defaults: permissions=["chat"], limits=unlimited.',
            pendingRoleName: params.name,
            pendingDescription: params.description,
          };
        }

        const roleData = {
          ...params,
          allowedModels: params.allowedModels,
          permissions: params.permissions || ['chat'],
        };

        try {
          const role = await createRole(roleData, adminUserId, 'chat-admin');
          return { success: true, role: { id: role.id, name: role.name } };
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Failed to create role' };
        }
      },
    },

    delete_user: {
      description: 'Permanently delete a user account and all their data. Cannot be undone. Can lookup by email.',
      inputSchema: z.object({
        userId: z.string().optional().describe('User ID to delete'),
        userEmail: z.string().optional().describe('User email to look up'),
        confirm: z.boolean().describe('Must be true to confirm deletion'),
      }),
      execute: async ({ userId, userEmail, confirm }: { userId?: string; userEmail?: string; confirm: boolean }) => {
        if (!confirm) return { error: 'Set confirm=true to proceed with deletion' };
        const id = await resolveUserId(userId, userEmail);
        if (!id) return { error: 'Provide userId or userEmail' };
        try {
          await deleteUser(id, adminUserId, 'chat-admin');
          return { success: true, message: 'User permanently deleted' };
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Failed to delete user' };
        }
      },
    },

    update_role: {
      description: 'Update an existing role — change name, description, allowed models, permissions, limits, or MCP settings',
      inputSchema: z.object({
        roleId: z.string().optional().describe('Role ID to update'),
        roleName: z.string().optional().describe('Role name to find (if roleId not known)'),
        name: z.string().optional().describe('New role name'),
        description: z.string().optional().describe('New description'),
        allowedModels: z.array(z.string()).optional().describe('New allowed model IDs list'),
        permissions: z.array(z.string()).optional().describe('New permissions list'),
        dailyRequestLimit: z.number().nullable().optional().describe('New daily request limit (null=unlimited)'),
        dailyTokenLimit: z.number().nullable().optional().describe('New daily token limit (null=unlimited)'),
        personalMcpEnabled: z.boolean().optional().describe('Allow personal MCP connections'),
        personalMcpMaxCount: z.number().optional().describe('Max personal MCP connections'),
        systemInstructions: z.string().optional().describe('Role-specific system instructions'),
      }),
      execute: async (params: { roleId?: string; roleName?: string; name?: string; description?: string; allowedModels?: string[]; permissions?: string[]; dailyRequestLimit?: number | null; dailyTokenLimit?: number | null; personalMcpEnabled?: boolean; personalMcpMaxCount?: number; systemInstructions?: string }) => {
        let resolvedId = params.roleId;
        if (!resolvedId && params.roleName) {
          const role = await prisma.role.findFirst({
            where: { name: { equals: params.roleName, mode: 'insensitive' } },
          });
          if (!role) return { error: `Role "${params.roleName}" not found` };
          resolvedId = role.id;
        }
        if (!resolvedId) return { error: 'Provide roleId or roleName' };

        const { roleId: _rid, roleName: _rn, ...updateData } = params;
        try {
          const role = await updateRole(resolvedId, updateData, adminUserId, 'chat-admin');
          return { success: true, role: { id: role.id, name: role.name } };
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Failed to update role' };
        }
      },
    },

    delete_role: {
      description: 'Delete a role (any role, including seeded ones). A role that still has assigned users cannot be deleted until they are reassigned, and the last role with admin access is protected. Shows user count and asks for confirmation first.',
      inputSchema: z.object({
        roleId: z.string().optional().describe('Role ID to delete'),
        roleName: z.string().optional().describe('Role name to find'),
        confirm: z.boolean().optional().describe('Set to true to confirm deletion after reviewing details'),
      }),
      execute: async ({ roleId, roleName, confirm }: { roleId?: string; roleName?: string; confirm?: boolean }) => {
        let resolvedId = roleId;
        if (!resolvedId && roleName) {
          const role = await prisma.role.findFirst({ where: { name: { equals: roleName, mode: 'insensitive' } } });
          if (!role) return { error: `Role "${roleName}" not found` };
          resolvedId = role.id;
        }
        if (!resolvedId) return { error: 'Provide roleId or roleName' };

        // Get role details with user count
        const role = await prisma.role.findUnique({
          where: { id: resolvedId },
          include: { _count: { select: { users: true } } },
        });
        if (!role) return { error: 'Role not found' };

        // If not confirmed, show details and ask
        if (!confirm) {
          return {
            needsConfirmation: true,
            role: role.name,
            isSystemRole: role.isSystemRole,
            userCount: role._count.users,
            message:
              role._count.users > 0
                ? `Cannot delete "${role.name}" — ${role._count.users} user(s) are assigned to this role. Reassign them first.`
                : `Delete role "${role.name}"? This cannot be undone. Say "yes" to confirm.`,
            canDelete: role._count.users === 0,
          };
        }

        try {
          await deleteRole(resolvedId, adminUserId, 'chat-admin');
          return { success: true, message: `Role "${role.name}" deleted` };
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Failed to delete role' };
        }
      },
    },

    list_invitations: {
      description: 'List all invitations with their status (PENDING, ACCEPTED, EXPIRED, REVOKED)',
      inputSchema: z.object({}),
      execute: async () => {
        const invitations = await listInvitations();
        return {
          total: invitations.length,
          invitations: invitations.map((inv) => ({
            id: inv.id,
            email: inv.email,
            role: inv.role.name,
            status: inv.status,
            invitedBy: inv.invitedBy.name,
            createdAt: inv.createdAt,
            expiresAt: inv.expiresAt,
          })),
        };
      },
    },

    revoke_invitation: {
      description: 'Revoke a pending invitation so it can no longer be accepted',
      inputSchema: z.object({
        invitationId: z.string().describe('Invitation ID to revoke'),
      }),
      execute: async ({ invitationId }: { invitationId: string }) => {
        try {
          await revokeInvitation(invitationId, adminUserId, 'chat-admin');
          return { success: true, message: 'Invitation revoked' };
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Failed to revoke invitation' };
        }
      },
    },

    resend_invitation: {
      description: 'Resend an invitation email (generates a new token and resets expiry to 7 days)',
      inputSchema: z.object({
        invitationId: z.string().describe('Invitation ID to resend'),
      }),
      execute: async ({ invitationId }: { invitationId: string }) => {
        try {
          await resendInvitation(invitationId, adminUserId, 'chat-admin');
          return { success: true, message: 'Invitation resent with new 7-day expiry' };
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Failed to resend invitation' };
        }
      },
    },

    // ── MCP Management Tools ──

    add_mcp_to_role: {
      description: 'Add an MCP server connection to a role. All users in that role will have access to this MCP.',
      inputSchema: z.object({
        name: z.string().describe('Display name for the MCP connection'),
        serverUrl: z.string().describe('MCP server URL'),
        roleName: z.string().optional().describe('Role name to assign to'),
        roleId: z.string().optional().describe('Role ID to assign to'),
        authType: z.enum(['none', 'api_key']).optional().describe('Auth type (default: none)'),
        apiKey: z.string().optional().describe('API key if authType is api_key'),
      }),
      execute: async ({ name, serverUrl, roleName, roleId, authType, apiKey }: { name: string; serverUrl: string; roleName?: string; roleId?: string; authType?: string; apiKey?: string }) => {
        // Resolve role
        let resolvedRoleId = roleId;
        if (!resolvedRoleId && roleName) {
          const role = await prisma.role.findFirst({
            where: { name: { equals: roleName, mode: 'insensitive' } },
          });
          if (!role) return { error: `Role "${roleName}" not found` };
          resolvedRoleId = role.id;
        }
        if (!resolvedRoleId) {
          const allRoles = await prisma.role.findMany({ select: { id: true, name: true } });
          return { needsRole: true, message: 'Which role should this MCP be assigned to?', availableRoles: allRoles };
        }

        try {
          let encryptedCreds = null;
          if (authType === 'api_key' && apiKey) {
            const { encrypt } = await import('@/shared/lib/encryption');
            encryptedCreds = encrypt(JSON.stringify({ apiKey }));
          }

          // Link to the catalog connector with the same URL (if any) so a later
          // registry rename propagates to this copy via registryId, not just the
          // serverUrl fallback. serverUrl is unique per connector in the registry.
          const reg = await prisma.mcpRegistry.findFirst({ where: { serverUrl }, select: { id: true } });

          const conn = await prisma.mcpConnection.create({
            data: { userId: null, roleId: resolvedRoleId, name, serverUrl, authType: authType || 'none', authCredentialsEncrypted: encryptedCreds, registryId: reg?.id ?? null },
            include: { role: { select: { name: true } } },
          });
          return { success: true, message: `MCP "${name}" added to role ${conn.role?.name}`, id: conn.id };
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Failed to create MCP' };
        }
      },
    },

    list_role_mcps: {
      description: 'List all role-level MCP connections (assigned by admin, not personal)',
      inputSchema: z.object({}),
      execute: async () => {
        const connections = await prisma.mcpConnection.findMany({
          where: { userId: null },
          include: { role: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        });
        return {
          total: connections.length,
          connections: connections.map((c) => ({
            id: c.id,
            name: c.name,
            serverUrl: c.serverUrl,
            role: c.role?.name || 'Unassigned',
            status: c.status,
            isActive: c.isActive,
            toolCount: Array.isArray(c.availableTools) ? (c.availableTools as unknown[]).length : 0,
          })),
        };
      },
    },

    // ──────────────────────────────────────────────────────────────
    // FabOrch Audit — per-user MCP visibility
    // ──────────────────────────────────────────────────────────────
    query_user_mcp_tools: {
      description:
        'Inspect every MCP server (and the tools each exposes) that a specific user has access to. Returns BOTH their personal MCP connections (if their role allows personal MCPs) AND the role-level MCP connections assigned to their role. Use this when an admin asks "what MCP tools does X have?", "list MCPs for X", or "what tools is X allowed to use?". Accepts a fuzzy userKey (matches name OR email OR email local-part).',
      inputSchema: z.object({
        userKey: z.string().optional().describe('Fuzzy identifier (preferred). Matches user.name, user.email, OR email local-part. Example: "bevincent" finds Bevin Edward / bevincent@llmatscale.ai.'),
        userEmail: z.string().email().optional().describe('Exact email lookup (only if you have the full address).'),
        userId: z.string().uuid().optional().describe('Direct user ID (rare; prefer userKey).'),
        includeInactive: z.boolean().optional().describe('If true, include MCPs with isActive=false. Default false.'),
      }),
      execute: async (input: {
        userKey?: string;
        userEmail?: string;
        userId?: string;
        includeInactive?: boolean;
      }) => {
        // 1. Resolve the user.
        let target = null as
          | (Awaited<ReturnType<typeof prisma.user.findFirst>> & { role: unknown })
          | null;
        if (input.userId) {
          target = await prisma.user.findUnique({
            where: { id: input.userId },
            include: { role: true },
          });
        } else if (input.userEmail) {
          target = await prisma.user.findFirst({
            where: { email: { equals: input.userEmail, mode: 'insensitive' } },
            include: { role: true },
          });
        } else if (input.userKey) {
          target = await prisma.user.findFirst({
            where: {
              OR: [
                { name: { contains: input.userKey, mode: 'insensitive' } },
                { email: { contains: input.userKey, mode: 'insensitive' } },
              ],
            },
            include: { role: true },
          });
        }

        if (!target) {
          return {
            found: false,
            message: 'No data found for that request.',
          };
        }

        // 2. Build query: union of personal (userId=target) and
        //    role-scoped (roleId=target.roleId, userId=null) MCPs.
        const userWithRole = target as typeof target & {
          roleId: string | null;
          role: { id: string; name: string; personalMcpEnabled: boolean } | null;
        };
        const role = userWithRole.role;

        const includeInactive = input.includeInactive === true;
        const activeFilter = includeInactive ? {} : { isActive: true };

        const personal = role?.personalMcpEnabled
          ? await prisma.mcpConnection.findMany({
              where: { userId: target.id, ...activeFilter },
              orderBy: { createdAt: 'desc' },
            })
          : [];

        const roleMcps = role
          ? await prisma.mcpConnection.findMany({
              where: { roleId: role.id, userId: null, ...activeFilter },
              orderBy: { createdAt: 'desc' },
            })
          : [];

        // 3. Shape the response.
        const formatConn = (c: (typeof personal)[number], source: 'personal' | 'role') => {
          const tools = Array.isArray(c.availableTools)
            ? (c.availableTools as Array<Record<string, unknown>>)
            : [];
          return {
            id: c.id,
            name: c.name,
            serverUrl: c.serverUrl,
            source,
            authType: c.authType,
            isActive: c.isActive,
            status: c.status,
            lastError: c.lastError,
            lastConnectedAt: c.lastConnectedAt,
            createdAt: c.createdAt,
            toolCount: tools.length,
            tools: tools.map((t) => ({
              name: t.name as string | undefined,
              description: t.description as string | undefined,
            })),
          };
        };

        const personalFormatted = personal.map((c) => formatConn(c, 'personal'));
        const roleFormatted = roleMcps.map((c) => formatConn(c, 'role'));
        const all = [...personalFormatted, ...roleFormatted];

        // 4. REQ-02 #4 style — record the audit query itself.
        prisma.auditLog
          .create({
            data: {
              userId: adminUserId,
              action: 'mcp_audit_query',
              targetType: 'McpConnection',
              targetId: target.id,
              metadata: {
                targetUser: { id: target.id, email: target.email, name: target.name },
                includeInactive,
                resultCount: all.length,
              },
            },
          })
          .catch(() => {});

        return {
          found: true,
          user: {
            id: target.id,
            name: target.name,
            email: target.email,
            status: target.status,
            role: role ? { id: role.id, name: role.name } : null,
            personalMcpEnabled: role?.personalMcpEnabled ?? false,
          },
          summary: {
            totalConnections: all.length,
            personalConnections: personalFormatted.length,
            roleConnections: roleFormatted.length,
            totalTools: all.reduce((sum, c) => sum + c.toolCount, 0),
          },
          connections: all,
          ...(all.length === 0
            ? {
                note: role?.personalMcpEnabled
                  ? `${target.name || target.email} has no MCP connections (personal nor role-level).`
                  : `${target.name || target.email}'s role does not allow personal MCPs and no role-level MCPs are assigned. They have no MCP access.`,
              }
            : {}),
        };
      },
    },

    remove_role_mcp: {
      description: 'Remove an MCP connection from a role',
      inputSchema: z.object({
        mcpId: z.string().describe('MCP connection ID to remove'),
        confirm: z.boolean().describe('Must be true to confirm'),
      }),
      execute: async ({ mcpId, confirm }: { mcpId: string; confirm: boolean }) => {
        if (!confirm) return { error: 'Set confirm=true to proceed' };
        const conn = await prisma.mcpConnection.findUnique({ where: { id: mcpId } });
        if (!conn) return { error: 'MCP connection not found' };
        if (conn.userId) return { error: 'This is a personal MCP, not a role-level one' };

        await prisma.mcpConnection.delete({ where: { id: mcpId } });
        return { success: true, message: `MCP "${conn.name}" removed` };
      },
    },

    check_usage: {
      description: 'Check system-wide usage statistics',
      inputSchema: z.object({
        days: z.number().optional().describe('Number of days to look back (default 30)'),
      }),
      execute: async ({ days }: { days?: number }) => {
        const data = await getSystemUsageSummary(days || 30);
        return {
          period: `Last ${days || 30} days`,
          totalRequests: data.totalRequests,
          totalTokens: data.totalTokens,
          modelBreakdown: data.perModel,
        };
      },
    },

    query_cmf_runs: {
      description:
        'Query CMF master-data LOAD/VALIDATE runs from the Modeling Agent (Data Loader). Use for "show CMF loads today", "who loaded X", "how many loads failed this week", "recent data-loader activity". Returns per-run: packageName, operation (LOAD/VALIDATE), status, result (0=success,1=failure), user email, startedAt/endedAt. Optional filters: userKey (fuzzy email/name), status, operation, dateFrom/dateTo, limit (default 50, cap 500).',
      inputSchema: z.object({
        userKey: z.string().optional().describe('Fuzzy match on the loading user (email or name).'),
        operation: z.enum(['LOAD', 'VALIDATE']).optional(),
        status: z.enum(['QUEUED', 'RUNNING', 'SUCCESS', 'FAILURE', 'EXPIRED']).optional(),
        dateFrom: z.string().optional().describe('ISO 8601 lower bound on startedAt'),
        dateTo: z.string().optional().describe('ISO 8601 upper bound on startedAt'),
        limit: z.number().optional().describe('Max rows (default 50, cap 500).'),
      }),
      execute: async (input: {
        userKey?: string;
        operation?: 'LOAD' | 'VALIDATE';
        status?: 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILURE' | 'EXPIRED';
        dateFrom?: string;
        dateTo?: string;
        limit?: number;
      }) => {
        const take = Math.min(Math.max(1, input.limit ?? 50), 500);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const where: any = {};
        if (input.operation) where.operation = input.operation;
        if (input.status) where.status = input.status;
        if (input.dateFrom || input.dateTo) {
          where.startedAt = {};
          if (input.dateFrom) where.startedAt.gte = new Date(input.dateFrom);
          if (input.dateTo) where.startedAt.lte = new Date(input.dateTo);
        }
        if (input.userKey) {
          where.user = {
            OR: [
              { email: { contains: input.userKey, mode: 'insensitive' } },
              { name: { contains: input.userKey, mode: 'insensitive' } },
            ],
          };
        }
        try {
          const runs = await prisma.run.findMany({
            where,
            take,
            orderBy: { startedAt: 'desc' },
            include: { package: { select: { name: true } }, user: { select: { email: true } } },
          });
          return {
            total: runs.length,
            rows: runs.map((r) => ({
              packageName: r.package?.name ?? '—',
              operation: r.operation,
              status: r.status,
              result: r.result,
              publicResult: r.result === 0 ? 'Success' : r.result === 1 ? 'Failure' : null,
              user: r.user?.email ?? '—',
              startedAt: r.startedAt,
              endedAt: r.endedAt,
            })),
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Could not query CMF runs (table missing?)' };
        }
      },
    },

    list_audit_logs: {
      description: 'View recent admin audit log entries',
      inputSchema: z.object({
        limit: z.number().optional().describe('Number of entries (default 20)'),
      }),
      execute: async ({ limit }: { limit?: number }) => {
        const logs = await prisma.auditLog.findMany({
          include: { user: { select: { email: true } } },
          orderBy: { createdAt: 'desc' },
          take: limit || 20,
        });
        return {
          total: logs.length,
          logs: logs.map((l) => ({
            time: l.createdAt,
            action: l.action,
            admin: l.user?.email || 'system',
            target: l.targetType ? `${l.targetType}:${l.targetId}` : null,
          })),
        };
      },
    },

    // ──────────────────────────────────────────────────────────────
    // FabOrch Audit — REQ-02 User Session Audit
    // ──────────────────────────────────────────────────────────────
    query_user_sessions: {
      description:
        'Query user_session_logs to answer admin questions like "is X idle now?", "when did X log in?", "who is currently logged in?", "idle > 30 min?", "all sessions today", "what idle gaps did X have?". Each row includes: userName/userEmail, loginTime, logoutTime, sessionDurationSeconds, idleSeconds (cumulative >60s gaps), activeSeconds, currentIdleSeconds (gap since last user-driven request), isIdleNow (true if ACTIVE and currentIdle>60), engagementLabel (PRE-DECIDED plain-English answer to "is the user idle/active/logged-in right now?" — quote it verbatim), idleEpisodes (array of {startedAt,endedAt,durationSeconds} — every gap that exceeded 60 seconds during the session), idleEpisodeCount, sessionStatus. PREFER `userKey` for fuzzy name/email matches. Capped at 1000 rows.',
      inputSchema: z.object({
        userKey: z.string().optional().describe('Fuzzy match. Substring against user.name OR user.email OR email local-part. Use this for ANY name/handle the admin mentions (e.g. "bevincent" matches both Bevin Edward and bevincent@llmatscale.ai).'),
        userEmail: z.string().email().optional().describe('Exact user email match. Only use when you have the complete email address.'),
        userNameLike: z.string().optional().describe('Substring match against user.name only (case-insensitive). Prefer userKey for general searches.'),
        userId: z.string().uuid().optional().describe('Direct user id (rare; prefer userKey or email)'),
        dateFrom: z.string().optional().describe('ISO 8601 lower bound on loginTime'),
        dateTo: z.string().optional().describe('ISO 8601 upper bound on loginTime'),
        status: z.enum(['active', 'closed', 'all']).optional().describe('Filter by current session status'),
        idleMinutesGt: z.number().optional().describe('Only ACTIVE sessions whose current idle gap exceeds this many minutes'),
        limit: z.number().optional().describe('Max rows (default 100, hard cap 1000)'),
      }),
      execute: async (input: {
        userKey?: string;
        userEmail?: string;
        userNameLike?: string;
        userId?: string;
        dateFrom?: string;
        dateTo?: string;
        status?: 'active' | 'closed' | 'all';
        idleMinutesGt?: number;
        limit?: number;
      }) => {
        const { querySessionLogs } = await import('@/shared/lib/session-audit');
        const rows = await querySessionLogs({
          userId: input.userId ?? null,
          email: input.userEmail ?? null,
          nameLike: input.userNameLike ?? null,
          userKey: input.userKey ?? null,
          dateFrom: input.dateFrom ? new Date(input.dateFrom) : null,
          dateTo: input.dateTo ? new Date(input.dateTo) : null,
          status: input.status ?? 'all',
          idleMinutesGt: input.idleMinutesGt ?? null,
          limit: input.limit,
        });

        // REQ-02 #4 — every session-audit query is itself logged.
        prisma.auditLog.create({
          data: {
            userId: adminUserId,
            action: 'session_audit_query',
            targetType: 'UserSessionLog',
            targetId: null,
            metadata: {
              filters: input,
              resultCount: rows.length,
            },
          },
        }).catch(() => {});

        const limit = Math.min(Math.max(1, input.limit ?? 100), 1000);
        const truncated = rows.length === limit;
        return {
          total: rows.length,
          truncated,
          rows: rows.map((r) => ({
            userName: r.userName,
            userEmail: r.userEmail,
            loginTime: r.loginTime,
            logoutTime: r.logoutTime,
            sessionDurationSeconds: r.sessionDurationSeconds,
            idleSeconds: r.idleSeconds,
            activeSeconds: r.activeSeconds,
            currentIdleSeconds: r.currentIdleSeconds,
            isIdleNow: r.isIdleNow,
            engagementLabel: r.engagementLabel,
            idleEpisodes: r.idleEpisodes,
            idleEpisodeCount: r.idleEpisodeCount,
            sessionStatus: r.sessionStatus,
            closedReason: r.closedReason,
            loginIp: r.loginIp,
          })),
          ...(truncated
            ? { note: 'Returned the first 1000 rows. Please refine your filter to narrow the results.' }
            : {}),
        };
      },
    },

    // ──────────────────────────────────────────────────────────────
    // FabOrch Audit — REQ-03 Error Audit Log
    // ──────────────────────────────────────────────────────────────
    query_error_audit: {
      description:
        'Query error_audit_logs to answer admin questions like "show errors today", "what errors did X hit this week?", "how many SQL Call Failures in the last 7 days?", "all HIGH priority errors this month", "which errors are unresolved?", "errors between A and B". Each row carries the doc-spec 9 fields: errorId (ERR-YYYYMMDD-NNNN), errorType (one of the 10 from REQ-01), userName/userEmail, datetime, userMessage (plain-English), priority (HIGH/MEDIUM), status (OPEN/RESOLVED), resolvedBy/resolvedByName, resolvedAt — plus technicalMessage, route, httpStatus for context. Use userKey for fuzzy user lookup. When the admin asks "how many", combine with the count tool variant or report the rows.length. Capped at 1000.',
      inputSchema: z.object({
        userKey: z.string().optional().describe('Fuzzy user identifier (matches name OR email OR email local-part).'),
        userEmail: z.string().email().optional().describe('Exact user email.'),
        userId: z.string().uuid().optional(),
        errorType: z.enum([
          'SQL_CALL_FAILURE','RESPONSE_TIMEOUT','NO_ROWS_RETURNED','MISSING_FILTER',
          'INVALID_PARAMETER','DDL_DML_REJECTED','LAMBDA_MCP_CRASH','SESSION_TIMEOUT',
          'ROW_CAP_EXCEEDED','UNLISTED_STORED_PROC',
        ]).optional().describe('Filter by error type.'),
        priority: z.enum(['HIGH','MEDIUM']).optional().describe('Filter by priority.'),
        status: z.enum(['OPEN','RESOLVED','all']).optional().describe('Filter by resolution status.'),
        dateFrom: z.string().optional().describe('ISO 8601 lower bound on datetime'),
        dateTo: z.string().optional().describe('ISO 8601 upper bound on datetime'),
        errorIdLike: z.string().optional().describe('Substring match on the human ErrorID (e.g. "ERR-20260505-").'),
        limit: z.number().optional().describe('Max rows (default 100, hard cap 1000).'),
      }),
      execute: async (input: {
        userKey?: string; userEmail?: string; userId?: string;
        errorType?: string; priority?: 'HIGH'|'MEDIUM'; status?: 'OPEN'|'RESOLVED'|'all';
        dateFrom?: string; dateTo?: string; errorIdLike?: string; limit?: number;
      }) => {
        const { queryErrorAudit } = await import('@/shared/lib/errors/error-audit');
        const { rows, truncated } = await queryErrorAudit({
          userId: input.userId ?? null,
          userKey: input.userKey ?? null,
          errorType: input.errorType ?? null,
          priority: input.priority ?? null,
          status: input.status ?? 'all',
          dateFrom: input.dateFrom ? new Date(input.dateFrom) : null,
          dateTo: input.dateTo ? new Date(input.dateTo) : null,
          errorIdLike: input.errorIdLike ?? null,
          limit: input.limit,
        });

        // Self-log the audit query (mirrors REQ-02 pattern).
        prisma.auditLog.create({
          data: {
            userId: adminUserId,
            action: 'error_audit_query',
            targetType: 'ErrorAuditLog',
            targetId: null,
            metadata: { filters: input, resultCount: rows.length },
          },
        }).catch(() => {});

        return {
          total: rows.length,
          truncated,
          rows: rows.map((r: typeof rows[number]) => ({
            errorId: r.errorId,
            errorType: r.errorType,
            userName: r.userName,
            userEmail: r.userEmail,
            datetime: r.datetime,
            errorMessage: r.userMessage,
            technicalMessage: r.technicalMessage,
            priority: r.priority,
            status: r.status,
            resolvedBy: r.resolvedByName || r.resolvedBy,
            resolvedAt: r.resolvedAt,
            resolutionNote: r.resolutionNote,
            route: r.route,
            httpStatus: r.httpStatus,
          })),
          ...(truncated
            ? { note: 'Returned the first 1000 rows. Please refine your filter to narrow the results.' }
            : {}),
        };
      },
    },

    mark_error_resolved: {
      description:
        'Mark a specific error_audit_logs row as RESOLVED. Use when the admin says "mark ERR-... as resolved" or "close ERR-... with note ...". Confirms by returning the updated row.',
      inputSchema: z.object({
        errorId: z.string().describe('Human ErrorID, e.g. "ERR-20260505-0007".'),
        note: z.string().optional().describe('Optional resolution note (audit trail).'),
      }),
      execute: async ({ errorId, note }: { errorId: string; note?: string }) => {
        const { markErrorResolved } = await import('@/shared/lib/errors/error-audit');
        const ok = await markErrorResolved({ errorId, adminUserId, note });
        if (!ok) {
          return {
            success: false,
            message: `Either ${errorId} does not exist or it is already resolved.`,
          };
        }
        prisma.auditLog.create({
          data: {
            userId: adminUserId,
            action: 'error_audit_resolve',
            targetType: 'ErrorAuditLog',
            targetId: errorId,
            metadata: { note: note ?? null },
          },
        }).catch(() => {});
        return { success: true, errorId, note: note ?? null, resolvedAt: new Date() };
      },
    },

    purge_old_errors: {
      description:
        'Manually run the 90-day error_audit_logs retention sweep. Returns the count of rows deleted. Only use when the admin explicitly asks to "purge old errors" or "clean up the error log".',
      inputSchema: z.object({
        confirm: z.boolean().describe('Must be true to proceed.'),
      }),
      execute: async ({ confirm }: { confirm: boolean }) => {
        if (!confirm) return { error: 'Set confirm=true to proceed.' };
        const { purgeOldErrors } = await import('@/shared/lib/errors/error-audit');
        const deleted = await purgeOldErrors();
        prisma.auditLog.create({
          data: {
            userId: adminUserId,
            action: 'error_audit_purge',
            targetType: 'ErrorAuditLog',
            targetId: null,
            metadata: { deleted },
          },
        }).catch(() => {});
        return { success: true, deletedRows: deleted };
      },
    },

    // ──────────────────────────────────────────────────────────────
    // FabOrch Audit — REQ-04 Prompt & Response Audit Log
    // ──────────────────────────────────────────────────────────────
    query_prompt_audit: {
      description:
        'Query prompt_audit_logs to answer admin questions like "show all prompts today", "what did X ask this week?", "show failed prompts in the last 7 days", "what did PRO-... cost?", "who is the most expensive user this week?". Each row carries: promptId (PRO-YYYYMMDD-NNNN), userId (FK to users.id), userName, userEmail, datetime, userPrompt, topicMatched (one of the 7 use-case names or "AdminData" or null), queryExecuted (tool-call summary), dataRetrieved (tools+rows summary), llmResponse, responseTimeMs, status, toolCalls (array of {name, input, output} — output typically includes the SQL the MCP built plus the rows). PLUS per-turn token+cost columns: requestTokens/requestCost (turn 1 input — the model reading the user question), retrievalTokens/retrievalCost (turns 2..N input — feeding tool results back), responseTokens/responseCost (all turns\' output). totalTokens and totalCost are returned per row as computed sums. All costs are USD priced dynamically per-turn using each turn\'s model rate. Use userKey for fuzzy user lookup. Capped at 1000 rows. IMPORTANT: llmResponse and toolCalls are HEAVY (a single row can be megabytes) and are OMITTED by default — for counts, lists, "how many", "by user/account", cost/token, or any analysis question, leave includeDetail OFF. Only set includeDetail=true when the admin asks about ONE specific prompt\'s actual response or tool calls (e.g. a single PRO-... id), and it is auto-capped to 25 rows.',
      inputSchema: z.object({
        userKey: z.string().optional().describe('Fuzzy user identifier (matches user_name, user_email, or email local-part).'),
        userEmail: z.string().email().optional().describe('Exact user email.'),
        publicStatus: z.enum(['Success','Failed']).optional().describe('Doc-style status. "Success" or "Failed" (collapses TIMEOUT/CANCELLED into Failed).'),
        status: z.enum(['PENDING','SUCCESS','FAILED','TIMEOUT','CANCELLED','all']).optional().describe('Granular internal status.'),
        topicMatched: z.enum([
          'Material Genealogy + Hold/Disposition',
          'Equipment OEE Report',
          'Scrap Pareto Analysis',
          'Bottleneck Analysis',
          'Cycle Time Outlier Detection',
          'Operator Performance Analysis',
          'Overall Facility Performance Insights',
          'AdminData',
        ]).optional().describe('Exact topic label — one of the 7 use cases or "AdminData".'),
        promptIdLike: z.string().optional().describe('Substring on the human PromptID, e.g. "PRO-20260505-".'),
        app: z.enum(['faborch','faborch-admin']).optional().describe('Restrict to FabOrch chat (topic_matched != AdminData) or admin chat (topic_matched = AdminData).'),
        dateFrom: z.string().optional().describe('ISO 8601 lower bound on datetime'),
        dateTo: z.string().optional().describe('ISO 8601 upper bound on datetime'),
        limit: z.number().optional().describe('Max rows (default 100, hard cap 1000; auto-capped to 25 when includeDetail is true).'),
        includeDetail: z.boolean().optional().describe('Include the HEAVY per-row fields (llmResponse + full toolCalls). DEFAULT false — leave OFF for counts/lists/analysis/"by account". Only set true for a SPECIFIC prompt\'s response/tool calls (a single PRO-... id).'),
      }),
      execute: async (input: {
        userKey?: string; userEmail?: string;
        publicStatus?: 'Success'|'Failed';
        status?: 'PENDING'|'SUCCESS'|'FAILED'|'TIMEOUT'|'CANCELLED'|'all';
        topicMatched?: string; promptIdLike?: string;
        app?: 'faborch'|'faborch-admin';
        dateFrom?: string; dateTo?: string; limit?: number; includeDetail?: boolean;
      }) => {
        const { queryPromptAudit } = await import('@/shared/lib/prompt-audit');
        const detail = input.includeDetail ?? false;
        // Detail rows carry the full response + tool I/O (megabytes each), so cap
        // them hard. Non-detail rows drop those + truncate text, so a broad query
        // ("last 2 days by account") can never overflow the model's token budget.
        const effLimit = detail ? Math.min(input.limit ?? 25, 25) : input.limit;
        const trunc = (v: unknown, n: number): string | null => {
          if (v === null || v === undefined) return null;
          const s = typeof v === 'string' ? v : JSON.stringify(v);
          return s.length > n ? s.slice(0, n) + '…[truncated]' : s;
        };
        const { rows, truncated } = await queryPromptAudit({
          userKey: input.userKey ?? null,
          userEmail: input.userEmail ?? null,
          publicStatus: input.publicStatus ?? null,
          status: input.status ?? 'all',
          topicMatched: input.topicMatched ?? null,
          promptIdLike: input.promptIdLike ?? null,
          app: input.app ?? null,
          dateFrom: input.dateFrom ? new Date(input.dateFrom) : null,
          dateTo: input.dateTo ? new Date(input.dateTo) : null,
          limit: effLimit,
        });

        prisma.auditLog.create({
          data: {
            userId: adminUserId,
            action: 'prompt_audit_query',
            targetType: 'PromptAuditLog',
            targetId: null,
            metadata: { filters: input, resultCount: rows.length },
          },
        }).catch(() => {});

        return {
          total: rows.length,
          truncated,
          detail,
          rows: rows.map((r: typeof rows[number]) => ({
            promptId: r.promptId,
            userId: r.userId,
            userName: r.userName,
            userEmail: r.userEmail,
            datetime: r.datetime,
            // Text fields truncated so a broad query stays small.
            userPrompt: trunc(r.userPrompt, 300),
            topicMatched: r.topicMatched,
            queryExecuted: trunc(r.queryExecuted, 200),
            dataRetrieved: trunc(r.dataRetrieved, 200),
            responseTimeMs: r.responseTimeMs,
            status: r.status,
            publicStatus: r.status === 'SUCCESS' ? 'Success' : 'Failed',
            // Per-turn token counts and USD costs (priced dynamically
            // per turn using that turn's model rate).
            requestTokens:   r.requestTokens,
            retrievalTokens: r.retrievalTokens,
            responseTokens:  r.responseTokens,
            totalTokens:
              (r.requestTokens ?? 0) + (r.retrievalTokens ?? 0) + (r.responseTokens ?? 0) || null,
            requestCost:   r.requestCost,
            retrievalCost: r.retrievalCost,
            responseCost:  r.responseCost,
            totalCost:
              ((r.requestCost   ? Number(r.requestCost)   : 0) +
               (r.retrievalCost ? Number(r.retrievalCost) : 0) +
               (r.responseCost  ? Number(r.responseCost)  : 0)) || null,
            // Heavy fields ONLY in detail mode, and still truncated — llmResponse
            // is the model's answer text; toolCalls is [{name,input,output}] where
            // output holds the executed SQL + the rows the MCP returned.
            ...(detail
              ? { llmResponse: trunc(r.llmResponse, 1500), toolCalls: trunc(displayToolCallNames(r.toolCalls), 3000) }
              : {}),
          })),
          ...(truncated
            ? { note: `Returned the first ${rows.length} rows. Refine your filter to narrow the results.` }
            : {}),
          ...(!detail
            ? { hint: 'Response text and tool calls were omitted (analysis mode). For one specific prompt, call again with includeDetail=true (and its promptId) to see them.' }
            : {}),
        };
      },
    },

    purge_old_prompts: {
      description:
        'Manually run the 90-day prompt_audit_logs retention sweep. Returns the count of rows deleted. Only use when the admin explicitly asks to "purge old prompts" or "clean up the prompt log".',
      inputSchema: z.object({
        confirm: z.boolean().describe('Must be true to proceed.'),
      }),
      execute: async ({ confirm }: { confirm: boolean }) => {
        if (!confirm) return { error: 'Set confirm=true to proceed.' };
        const { purgeOldPrompts } = await import('@/shared/lib/prompt-audit');
        const deleted = await purgeOldPrompts();
        prisma.auditLog.create({
          data: {
            userId: adminUserId,
            action: 'prompt_audit_purge',
            targetType: 'PromptAuditLog',
            targetId: null,
            metadata: { deleted },
          },
        }).catch(() => {});
        return { success: true, deletedRows: deleted };
      },
    },

    // ──────────────────────────────────────────────────────────────
    // REQ-04 Quality / Analytics — aggregate metrics from prompt_audit_logs
    // ──────────────────────────────────────────────────────────────
    prompt_quality_summary: {
      description:
        'Aggregate quality metrics from prompt_audit_logs over a date range. Use this when the admin asks about "success rate", "how many prompts failed today", "what % of prompts succeeded this week", "average response time", "slowest prompts", "topic distribution", "which topics fail the most", "any prompts cancelled", "total cost today", "total token usage this week", "cost by topic", "top spenders", "most expensive prompt". Returns counts, rates, response-time percentiles, status breakdown, topic distribution, top users (by volume AND by cost), token totals, USD cost totals, and per-topic cost. ALWAYS use this for any aggregate / "how many" / "what %" / "average" / "total cost" / "total tokens" question; never invent numbers. Date filters default to last 7 days if both omitted.',
      inputSchema: z.object({
        dateFrom: z.string().optional().describe('ISO 8601 lower bound on datetime. Default: 7 days ago.'),
        dateTo: z.string().optional().describe('ISO 8601 upper bound on datetime. Default: now.'),
        userKey: z.string().optional().describe('Restrict to a single user (fuzzy match on user_name/user_email).'),
        userEmail: z.string().email().optional().describe('Restrict to one exact user_email.'),
        app: z.enum(['faborch','faborch-admin']).optional().describe('Restrict to FabOrch chat (topic_matched != AdminData) or admin chat (topic_matched = AdminData).'),
        topicMatched: z.enum([
          'Material Genealogy + Hold/Disposition',
          'Equipment OEE Report',
          'Scrap Pareto Analysis',
          'Bottleneck Analysis',
          'Cycle Time Outlier Detection',
          'Operator Performance Analysis',
          'Overall Facility Performance Insights',
          'AdminData',
        ]).optional().describe('Restrict to a single topic.'),
      }),
      execute: async (input: {
        dateFrom?: string; dateTo?: string;
        userKey?: string; userEmail?: string;
        app?: 'faborch'|'faborch-admin';
        topicMatched?: string;
      }) => {
        // Build WHERE clause incrementally so the same filter logic feeds all
        // aggregation CTEs below.
        const conds: string[] = [];
        const values: unknown[] = [];
        const push = (sql: string, v: unknown) => {
          values.push(v);
          conds.push(sql.replace('$?', `$${values.length}`));
        };
        const dateFrom = input.dateFrom
          ? new Date(input.dateFrom)
          : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const dateTo = input.dateTo ? new Date(input.dateTo) : new Date();
        push(`datetime >= $?`, dateFrom);
        push(`datetime <= $?`, dateTo);
        if (input.userEmail) push(`user_email = $?`, input.userEmail);
        if (input.userKey) {
          const key = `%${input.userKey}%`;
          values.push(key, key, key);
          const a = `$${values.length - 2}`;
          const b = `$${values.length - 1}`;
          const c = `$${values.length}`;
          conds.push(
            `(user_name ILIKE ${a} OR user_email ILIKE ${b} OR split_part(user_email, '@', 1) ILIKE ${c})`
          );
        }
        if (input.app === 'faborch-admin') conds.push(`topic_matched = 'AdminData'`);
        else if (input.app === 'faborch') conds.push(`(topic_matched IS NULL OR topic_matched <> 'AdminData')`);
        if (input.topicMatched) push(`topic_matched = $?`, input.topicMatched);

        const where = `WHERE ${conds.join(' AND ')}`;

        // 1) Counts + rates + timing percentiles + token/cost totals in one pass.
         
        const summary = (await prisma.$queryRawUnsafe(
          `SELECT
              COUNT(*)::int                                                          AS total,
              SUM(CASE WHEN status='SUCCESS'   THEN 1 ELSE 0 END)::int               AS success_count,
              SUM(CASE WHEN status='FAILED'    THEN 1 ELSE 0 END)::int               AS failed_count,
              SUM(CASE WHEN status='TIMEOUT'   THEN 1 ELSE 0 END)::int               AS timeout_count,
              SUM(CASE WHEN status='CANCELLED' THEN 1 ELSE 0 END)::int               AS cancelled_count,
              SUM(CASE WHEN status='PENDING'   THEN 1 ELSE 0 END)::int               AS pending_count,
              ROUND(AVG(response_time_ms))::int                                      AS avg_response_ms,
              PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY response_time_ms)::int    AS p50_response_ms,
              PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms)::int    AS p95_response_ms,
              MAX(response_time_ms)::int                                             AS max_response_ms,
              COALESCE(SUM(request_tokens),   0)::bigint                             AS request_tokens_total,
              COALESCE(SUM(retrieval_tokens), 0)::bigint                             AS retrieval_tokens_total,
              COALESCE(SUM(response_tokens),  0)::bigint                             AS response_tokens_total,
              COALESCE(SUM(request_cost),     0)::numeric(14,6)                      AS request_cost_total,
              COALESCE(SUM(retrieval_cost),   0)::numeric(14,6)                      AS retrieval_cost_total,
              COALESCE(SUM(response_cost),    0)::numeric(14,6)                      AS response_cost_total
            FROM prompt_audit_logs
            ${where}`,
          ...values
        )) as Array<Record<string, number | string>>;
        const s = summary[0] || {};
        const total = Number(s.total ?? 0);
        const successCount = Number(s.success_count ?? 0);
        const successRate = total > 0 ? Math.round((successCount / total) * 1000) / 10 : null; // 1 dp

        // 2) Topic distribution.
        const topics = (await prisma.$queryRawUnsafe(
          `SELECT COALESCE(topic_matched, '(unmatched)') AS topic, COUNT(*)::int AS n
             FROM prompt_audit_logs
             ${where}
            GROUP BY 1
            ORDER BY n DESC`,
          ...values
        )) as Array<{ topic: string; n: number }>;

        // 3) Top users by prompt volume.
        const users = (await prisma.$queryRawUnsafe(
          `SELECT user_id, user_name, user_email, COUNT(*)::int AS n,
                  SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END)::int AS success_n,
                  COALESCE(SUM(COALESCE(request_cost,0)+COALESCE(retrieval_cost,0)+COALESCE(response_cost,0)), 0)::numeric(14,6) AS total_cost,
                  COALESCE(SUM(COALESCE(request_tokens,0)+COALESCE(retrieval_tokens,0)+COALESCE(response_tokens,0)), 0)::bigint AS total_tokens
             FROM prompt_audit_logs
             ${where}
            GROUP BY user_id, user_name, user_email
            ORDER BY n DESC
            LIMIT 10`,
          ...values
        )) as Array<{ user_id: string | null; user_name: string | null; user_email: string | null; n: number; success_n: number; total_cost: string; total_tokens: bigint }>;

        // 3b) Top users by total cost (separate ranking — biggest spenders).
        const topSpenders = (await prisma.$queryRawUnsafe(
          `SELECT user_id, user_name, user_email, COUNT(*)::int AS n,
                  COALESCE(SUM(COALESCE(request_cost,0)+COALESCE(retrieval_cost,0)+COALESCE(response_cost,0)), 0)::numeric(14,6) AS total_cost
             FROM prompt_audit_logs
             ${where}
            GROUP BY user_id, user_name, user_email
            ORDER BY total_cost DESC
            LIMIT 10`,
          ...values
        )) as Array<{ user_id: string | null; user_name: string | null; user_email: string | null; n: number; total_cost: string }>;

        // 3c) Cost per topic (so the admin can see which use case is most expensive).
        const costByTopic = (await prisma.$queryRawUnsafe(
          `SELECT COALESCE(topic_matched, '(unmatched)') AS topic,
                  COUNT(*)::int AS n,
                  COALESCE(SUM(COALESCE(request_cost,0)+COALESCE(retrieval_cost,0)+COALESCE(response_cost,0)), 0)::numeric(14,6) AS total_cost,
                  COALESCE(AVG(COALESCE(request_cost,0)+COALESCE(retrieval_cost,0)+COALESCE(response_cost,0)), 0)::numeric(14,6) AS avg_cost_per_prompt
             FROM prompt_audit_logs
             ${where}
            GROUP BY 1
            ORDER BY total_cost DESC`,
          ...values
        )) as Array<{ topic: string; n: number; total_cost: string; avg_cost_per_prompt: string }>;

        // 4) Topics with the worst failure rate (only topics with >=3 prompts).
        const failingTopics = (await prisma.$queryRawUnsafe(
          `SELECT COALESCE(topic_matched, '(unmatched)') AS topic,
                  COUNT(*)::int AS n,
                  SUM(CASE WHEN status IN ('FAILED','TIMEOUT','CANCELLED') THEN 1 ELSE 0 END)::int AS failed_n,
                  ROUND(100.0 * SUM(CASE WHEN status IN ('FAILED','TIMEOUT','CANCELLED') THEN 1 ELSE 0 END) / COUNT(*), 1) AS failure_rate
             FROM prompt_audit_logs
             ${where}
            GROUP BY 1
           HAVING COUNT(*) >= 3
            ORDER BY failure_rate DESC, n DESC
            LIMIT 5`,
          ...values
        )) as Array<{ topic: string; n: number; failed_n: number; failure_rate: number }>;

        prisma.auditLog.create({
          data: {
            userId: adminUserId,
            action: 'prompt_quality_summary',
            targetType: 'PromptAuditLog',
            targetId: null,
            metadata: { filters: input, total },
          },
        }).catch(() => {});

        // Bigint columns come back from pg as actual BigInt — serialize for JSON.
        const stringifyBig = (v: unknown) =>
          typeof v === 'bigint' ? Number(v) : v;

        const reqTok = Number(stringifyBig(s.request_tokens_total)   ?? 0);
        const retTok = Number(stringifyBig(s.retrieval_tokens_total) ?? 0);
        const resTok = Number(stringifyBig(s.response_tokens_total)  ?? 0);
        const reqCost = Number(s.request_cost_total   ?? 0);
        const retCost = Number(s.retrieval_cost_total ?? 0);
        const resCost = Number(s.response_cost_total  ?? 0);

        return {
          window: { dateFrom: dateFrom.toISOString(), dateTo: dateTo.toISOString() },
          totals: {
            total,
            success: s.success_count ?? 0,
            failed: s.failed_count ?? 0,
            timeout: s.timeout_count ?? 0,
            cancelled: s.cancelled_count ?? 0,
            pending: s.pending_count ?? 0,
          },
          successRatePct: successRate,
          responseTimeMs: {
            avg: s.avg_response_ms ?? null,
            p50: s.p50_response_ms ?? null,
            p95: s.p95_response_ms ?? null,
            max: s.max_response_ms ?? null,
          },
          tokenTotals: {
            request:   reqTok,
            retrieval: retTok,
            response:  resTok,
            total:     reqTok + retTok + resTok,
          },
          costTotalsUsd: {
            request:   reqCost,
            retrieval: retCost,
            response:  resCost,
            total:     +(reqCost + retCost + resCost).toFixed(6),
            avgPerPrompt: total > 0
              ? +((reqCost + retCost + resCost) / total).toFixed(6)
              : 0,
          },
          topicDistribution: topics,
          topUsers: users.map((u) => ({
            ...u,
            total_tokens: Number(stringifyBig(u.total_tokens) ?? 0),
            total_cost:   Number(u.total_cost ?? 0),
          })),
          topSpenders: topSpenders.map((u) => ({
            ...u,
            total_cost: Number(u.total_cost ?? 0),
          })),
          costByTopic: costByTopic.map((t) => ({
            ...t,
            total_cost:          Number(t.total_cost ?? 0),
            avg_cost_per_prompt: Number(t.avg_cost_per_prompt ?? 0),
          })),
          worstFailureRateTopics: failingTopics,
        };
      },
    },

    // ──────────────────────────────────────────────────────────────
    // Error Catalog — admin can view + edit user-facing error messages
    // ──────────────────────────────────────────────────────────────
    list_error_catalog: {
      description:
        'List all 10 canonical error types and their current user-facing messages. Use this when the admin asks things like "show me the error messages", "what does SQL_CALL_FAILURE say?", "list all error types". Read-only.',
      inputSchema: z.object({
        errorType: z.string().optional().describe('Optional: filter to one specific error_type (e.g. "MISSING_FILTER").'),
      }),
      execute: async ({ errorType }: { errorType?: string }) => {
        const rows = (await prisma.$queryRawUnsafe(
          errorType
            ? `SELECT error_type, user_message, priority, http_status, updated_at, updated_by FROM error_catalog WHERE error_type = $1`
            : `SELECT error_type, user_message, priority, http_status, updated_at, updated_by FROM error_catalog ORDER BY error_type ASC`,
          ...(errorType ? [errorType] : [])
        )) as Array<{
          error_type: string;
          user_message: string;
          priority: string;
          http_status: number;
          updated_at: Date;
          updated_by: string;
        }>;
        return { count: rows.length, entries: rows };
      },
    },

    update_error_catalog_message: {
      description:
        'Update the user-facing message for ONE error type. Use this when the admin says things like "change the SQL_CALL_FAILURE message to ...", "update MISSING_FILTER to say ...". Only `user_message` is editable — error_type, priority, and http_status are part of the canonical taxonomy and are locked. Changes propagate to the chat app within ~60 seconds (cache TTL); no redeploy needed.',
      inputSchema: z.object({
        errorType: z.enum([
          'SQL_CALL_FAILURE',
          'RESPONSE_TIMEOUT',
          'NO_ROWS_RETURNED',
          'MISSING_FILTER',
          'INVALID_PARAMETER',
          'DDL_DML_REJECTED',
          'LAMBDA_MCP_CRASH',
          'SESSION_TIMEOUT',
          'ROW_CAP_EXCEEDED',
          'UNLISTED_STORED_PROC',
        ]).describe('The canonical error type whose user_message you want to change.'),
        newMessage: z.string().min(1).max(500).describe('The new user-facing message (1–500 characters).'),
        confirm: z.boolean().describe('Must be true. Acts as a guard against accidental edits — set this only after the admin has explicitly approved the new wording.'),
      }),
      execute: async ({
        errorType,
        newMessage,
        confirm,
      }: {
        errorType: string;
        newMessage: string;
        confirm: boolean;
      }) => {
        if (!confirm) {
          return { error: 'Set confirm=true to proceed. Show the proposed new message to the admin first and ask them to confirm.' };
        }
        const trimmed = newMessage.trim();
        if (!trimmed) return { error: 'newMessage is empty after trimming.' };
        if (trimmed.length > 500) return { error: 'newMessage exceeds 500 characters.' };

        // Resolve editor email for the audit trail.
        const editor = await prisma.user.findUnique({
          where: { id: adminUserId },
          select: { email: true },
        });
        const editorEmail = editor?.email ?? 'admin';

        const updated = (await prisma.$queryRawUnsafe(
          `UPDATE error_catalog
              SET user_message = $1,
                  updated_at   = NOW(),
                  updated_by   = $2
            WHERE error_type   = $3
           RETURNING error_type, user_message, priority, http_status, updated_at, updated_by`,
          trimmed,
          editorEmail,
          errorType
        )) as Array<{
          error_type: string;
          user_message: string;
          priority: string;
          http_status: number;
          updated_at: Date;
          updated_by: string;
        }>;

        if (updated.length === 0) {
          return { error: `No row found for error_type ${errorType}.` };
        }

        prisma.auditLog.create({
          data: {
            userId: adminUserId,
            action: 'error_catalog_update',
            targetType: 'ErrorCatalog',
            targetId: errorType,
            metadata: { newMessage: trimmed, errorType },
          },
        }).catch(() => {});

        return {
          success: true,
          message: 'Updated. The chat app will show the new message within ~60 seconds (cache TTL).',
          entry: updated[0],
        };
      },
    },

    set_report_schedule: {
      description:
        'Set or change the automatic refresh schedule for the Recent Reports — ANY live dashboard (seeded ones plus custom dashboards that went live through the approval flow). Use when the admin asks to schedule/reschedule how often reports refresh, e.g. "refresh all reports every hour", "Product Analytics daily at 6am", "schedule my Scrap-by-Product dashboard hourly", "disable the Lot History schedule". Times are UTC. Pass ["all"] to apply to every dashboard, or specific dashboard names to give each its own timing. If you are unsure what exists, call get_report_schedules first — it lists every dashboard and which are not yet scheduled. Fab Orch picks up the change on its next tick (~5 min).',
      inputSchema: z.object({
        dashboards: z.array(z.string()).describe('Dashboard names/ids, or ["all"] for every dashboard'),
        frequency: z.enum(['hourly', 'daily', 'weekly', 'monthly']).describe('Refresh cadence'),
        intervalMinutes: z.number().int().positive().optional().describe('For hourly: minutes between refreshes (default 60)'),
        atTime: z.string().optional().describe('For daily/weekly/monthly: time of day "HH:MM" in UTC (24h)'),
        daysOfWeek: z.array(z.number().int().min(0).max(6)).optional().describe('For weekly: one or more weekdays, 0=Sunday … 6=Saturday (default Monday)'),
        dayOfMonth: z.number().int().min(1).max(31).optional().describe('For monthly: day of month 1-31'),
        enabled: z.boolean().optional().describe('Set false to pause the schedule (default true)'),
        sourceKey: z.string().optional().describe('Data source key (default "lumentum")'),
      }),
      execute: async (args: {
        dashboards: string[];
        frequency: ReportFrequency;
        intervalMinutes?: number;
        atTime?: string;
        daysOfWeek?: number[];
        dayOfMonth?: number;
        enabled?: boolean;
        sourceKey?: string;
      }) => {
        const sourceKey = (args.sourceKey || 'lumentum').trim();
        const enabled = args.enabled ?? true;
        // Weekly days are stored as "1,3,5" (sorted, de-duplicated); null when none given.
        const daysOfWeek = [...new Set((args.daysOfWeek ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
        const daysOfWeekStr = daysOfWeek.length ? daysOfWeek.join(',') : null;

        // Resolve against the LIVE list of pinned dashboards (7 curated + custom).
        const list = await getSchedulableDashboards();
        if (list.length === 0) {
          return { error: 'No dashboards are live yet. Approve a dashboard request before scheduling it.' };
        }
        const ids = resolveAgainst(list, args.dashboards);
        const unknown = args.dashboards.filter(
          (d) => d.toLowerCase().trim() !== 'all' && resolveAgainst(list, d).length === 0,
        );
        if (ids.length === 0) {
          return {
            error: `No dashboards matched. Available: ${list.map((d) => d.label).join(', ')}, or "all".`,
            unknown,
          };
        }

        for (const id of ids) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO report_schedules
               (id, dashboard_id, source_key, frequency, interval_minutes, at_time, days_of_week, day_of_month, enabled, next_run_at, updated_by_id, updated_at)
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, now(), $9, now())
             ON CONFLICT (dashboard_id, source_key) DO UPDATE SET
               frequency = EXCLUDED.frequency,
               interval_minutes = EXCLUDED.interval_minutes,
               at_time = EXCLUDED.at_time,
               days_of_week = EXCLUDED.days_of_week,
               day_of_month = EXCLUDED.day_of_month,
               enabled = EXCLUDED.enabled,
               next_run_at = EXCLUDED.next_run_at,
               updated_by_id = EXCLUDED.updated_by_id,
               updated_at = now()`,
            id,
            sourceKey,
            args.frequency,
            args.intervalMinutes ?? null,
            args.atTime ?? null,
            daysOfWeekStr,
            args.dayOfMonth ?? null,
            enabled,
            adminUserId,
          );
        }

        prisma.auditLog
          .create({
            data: {
              userId: adminUserId,
              action: 'report.schedule_set',
              targetType: 'ReportSchedule',
              targetId: sourceKey,
              metadata: {
                dashboards: ids,
                frequency: args.frequency,
                intervalMinutes: args.intervalMinutes ?? null,
                atTime: args.atTime ?? null,
                daysOfWeek: daysOfWeekStr,
                dayOfMonth: args.dayOfMonth ?? null,
                enabled,
                sourceKey,
              },
            },
          })
          .catch(() => {});

        return {
          success: true,
          updated: ids.map((id) => list.find((d) => d.id === id)?.label ?? id),
          frequency: args.frequency,
          enabled,
          sourceKey,
          nextRunAtUtc: 'next tick',
          note: 'Fab Orch runs the first refresh on its next scheduled tick (within ~5 minutes) and computes later runs. All times are UTC.',
          ...(unknown.length ? { ignored: unknown } : {}),
        };
      },
    },

    get_report_schedules: {
      description:
        'Show the current report-refresh schedules (cadence, next/last run, enabled, timezone), the full list of live dashboards flagging which are NOT yet scheduled, AND `recentRuns` — the last 20 scheduled job executions (dashboard, when it ran, refreshed/failed counts, status ok/partial/error). Use when the admin asks what the report schedule is, when a report next refreshes, to confirm a change, to find newly-added dashboards that still need a schedule, or to answer "which scheduled jobs ran / failed / succeeded recently?". When some live dashboards are unscheduled, tell the admin which ones and offer to schedule them. When you render a Frequency column, use each row\'s `frequencyLabel` (it shows "Interval" for sub-hourly cadences — never label a "every 5 min" schedule as "Hourly") and use `cadence` for the human details (it already includes any active-time window).',
      inputSchema: z.object({}),
      execute: async () => {
        const list = await getSchedulableDashboards();
        const rows = await prisma.$queryRawUnsafe<
          Array<{
            dashboard_id: string;
            source_key: string;
            frequency: string;
            interval_minutes: number | null;
            at_time: string | null;
            days_of_week: string | null;
            day_of_month: number | null;
            enabled: boolean;
            next_run_at: Date | null;
            last_run_at: Date | null;
            last_status: string | null;
            timezone: string | null;
            window_start: string | null;
            window_end: string | null;
          }>
        >(
          `SELECT dashboard_id, source_key, frequency, interval_minutes, at_time, days_of_week, day_of_month, enabled, next_run_at, last_run_at, last_status, timezone, window_start, window_end
           FROM report_schedules ORDER BY dashboard_id`,
        );
        // Recent RUN history from the shared audit_logs (same as the Audit Logs page):
        // scheduled runs are logged as report.schedule_ran / report.schedule_failed.
        type RunRow = { action: string; target_id: string | null; created_at: Date; metadata: unknown };
        const runs = await prisma
          .$queryRawUnsafe<RunRow[]>(
            `SELECT action, target_id, created_at, metadata FROM audit_logs
              WHERE action IN ('report.schedule_ran','report.schedule_failed')
              ORDER BY created_at DESC LIMIT 20`,
          )
          .catch(() => [] as RunRow[]);
        return {
          total: rows.length,
          schedules: rows.map((r) => {
            const tz = r.timezone ?? "UTC";
            // "Interval" reads correctly for a sub-hour cadence (e.g. every 5 min);
            // "Hourly" was confusing. Capitalize the others.
            const frequencyLabel =
              r.frequency === "hourly" ? "Interval" : r.frequency.charAt(0).toUpperCase() + r.frequency.slice(1);
            const win = r.window_start && r.window_end ? ` (${r.window_start}–${r.window_end} ${tz})` : "";
            const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
            const daysOfWeek = (r.days_of_week ?? "")
              .split(",")
              .map((n) => parseInt(n.trim(), 10))
              .filter((n) => n >= 0 && n <= 6);
            const cadence =
              r.frequency === "hourly"
                ? `every ${r.interval_minutes ?? 60} min${win}`
                : r.frequency === "daily"
                  ? `daily at ${r.at_time ?? "00:00"} ${tz}`
                  : r.frequency === "weekly"
                    ? `weekly on ${(daysOfWeek.length ? daysOfWeek : [1]).map((d) => dow[d]).join(", ")} at ${r.at_time ?? "00:00"} ${tz}`
                    : `monthly on day ${r.day_of_month ?? 1} at ${r.at_time ?? "00:00"} ${tz}`;
            return {
              dashboard: list.find((d) => d.id === r.dashboard_id)?.label ?? r.dashboard_id,
              dashboardId: r.dashboard_id,
              sourceKey: r.source_key,
              frequency: r.frequency,
              frequencyLabel,
              cadence,
              intervalMinutes: r.interval_minutes,
              atTime: r.at_time,
              timezone: tz,
              windowStart: r.window_start,
              windowEnd: r.window_end,
              daysOfWeek,
              dayOfMonth: r.day_of_month,
              enabled: r.enabled,
              nextRunUtc: r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
              lastRunUtc: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
              lastStatus: r.last_status,
            };
          }),
          // Live dashboards that have NO schedule yet — offer to schedule these
          // ("these N are newly added and not scheduled — want to schedule them?").
          unscheduled: list
            .filter((d) => d.status === 'live' && !d.scheduled)
            .map((d) => ({ dashboard: d.label, dashboardId: d.id, kind: d.kind })),
          dashboardsTotal: list.length,
          // Run history — the last 20 scheduled refreshes (from audit_logs).
          recentRuns: runs.map((r) => {
            const md = (r.metadata ?? {}) as { refreshed?: number; failed?: number; status?: string };
            return {
              dashboard: list.find((d) => d.id === r.target_id)?.label ?? r.target_id,
              ranAt: r.created_at ? new Date(r.created_at).toISOString() : null,
              refreshed: md.refreshed ?? null,
              failed: md.failed ?? null,
              status: r.action === "report.schedule_failed" ? "failed" : md.status ?? "ok",
            };
          }),
        };
      },
    },

    get_alert_thresholds: {
      description:
        'List the current discrepancy alert thresholds (metric, condition, recipient roles, active, throttle) and what CAN be alerted on — every live dashboard and how many of its numeric columns are alertable — plus the last few times any alert fired. Use for "what alerts are set?", "which metrics can I alert on?", "did any alert fire recently?". To CREATE/CHANGE an alert, do not use this tool — emit an [[alert-threshold: {...}]] marker instead.',
      inputSchema: z.object({}),
      execute: async () => {
        type TRow = {
          id: string; metric_key: string; label: string | null; comparator: string;
          min_value: number | null; max_value: number | null; throttle_min: number;
          is_active: boolean; recipient_role_ids: unknown; custom_column: string | null;
        };
        const rows = await prisma.$queryRawUnsafe<TRow[]>(
          `SELECT id, metric_key, label, comparator, min_value, max_value, throttle_min, is_active, recipient_role_ids, custom_column
             FROM alert_thresholds ORDER BY metric_key`,
        );
        const roles = await prisma.role.findMany({ select: { id: true, name: true } });
        const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
        const thresholds = rows.map((r) => {
          const parsed = parseMetricKey(r.metric_key);
          const unit = "";
          const cond =
            r.comparator === "gt" ? `> ${r.max_value}${unit}`
              : r.comparator === "lt" ? `< ${r.min_value}${unit}`
                : `outside ${r.min_value}${unit}–${r.max_value}${unit}`;
          const ids = Array.isArray(r.recipient_role_ids) ? (r.recipient_role_ids as string[]) : [];
          return {
            id: r.id,
            metric: r.label || r.custom_column || parsed?.column || r.metric_key,
            condition: cond,
            recipients: ids.length ? ids.map(roleName).join(", ") : "default roles (Shift Lead, Shift Supervisor, Admin)",
            active: r.is_active,
            throttleMin: r.throttle_min,
          };
        });
        const dashboards = await prisma
          .$queryRawUnsafe<{ title: string; slug: string; status: string; n: number }[]>(
            `SELECT title, slug, status, jsonb_array_length(COALESCE(metric_columns,'[]'::jsonb)) AS n
               FROM dashboards WHERE status IN ('live','paused') ORDER BY title`,
          )
          .catch(() => [] as { title: string; slug: string; status: string; n: number }[]);
        const availableDashboards = dashboards.map((d) => ({ dashboard: d.title, dashboardId: d.slug, status: d.status, alertableColumns: Number(d.n) }));
        type FRow = { target_id: string | null; metadata: unknown; created_at: Date };
        const fires = await prisma
          .$queryRawUnsafe<FRow[]>(
            `SELECT target_id, metadata, created_at FROM audit_logs WHERE action='alert.discrepancy' ORDER BY created_at DESC LIMIT 10`,
          )
          .catch(() => [] as FRow[]);
        return {
          total: thresholds.length,
          thresholds,
          availableDashboards,
          recentFires: fires.map((f) => {
            const md = (f.metadata ?? {}) as { metricKey?: string; value?: number; emailed?: boolean };
            return { metricKey: md.metricKey, value: md.value, emailed: md.emailed, at: f.created_at ? new Date(f.created_at).toISOString() : null };
          }),
        };
      },
    },

    delete_alert_threshold: {
      description:
        'Delete discrepancy alert thresholds. Pass ONE of: `id` (a single threshold from get_alert_thresholds), `ids` (several), `dashboardId` (every alert on that dashboard slug), or `legacy: true` (every alert whose metric key predates the dashboard rearchitecture — those are paused and can never fire again). Confirm with the admin before calling.',
      inputSchema: z.object({
        id: z.string().optional().describe('One threshold id'),
        ids: z.array(z.string()).max(500).optional().describe('Several threshold ids'),
        dashboardId: z.string().optional().describe('Delete every threshold on this dashboard slug'),
        legacy: z.boolean().optional().describe('true = delete every legacy (non custom:…) threshold'),
      }),
      execute: async ({ id, ids, dashboardId, legacy }: { id?: string; ids?: string[]; dashboardId?: string; legacy?: boolean }) => {
        const idList = [...(id ? [id] : []), ...(ids ?? [])].filter(Boolean);
        const selectors = (idList.length ? 1 : 0) + (dashboardId ? 1 : 0) + (legacy ? 1 : 0);
        if (selectors !== 1) return { error: 'Pass exactly one of id/ids, dashboardId or legacy:true.' };
        let rows: { id: string; metric_key: string }[];
        if (idList.length) {
          rows = await prisma.$queryRawUnsafe<{ id: string; metric_key: string }[]>(
            `DELETE FROM alert_thresholds WHERE id = ANY($1::text[]) RETURNING id, metric_key`,
            idList,
          );
        } else if (legacy) {
          rows = await prisma.$queryRawUnsafe<{ id: string; metric_key: string }[]>(
            `DELETE FROM alert_thresholds WHERE metric_key NOT LIKE 'custom:%' RETURNING id, metric_key`,
          );
        } else {
          rows = await prisma.$queryRawUnsafe<{ id: string; metric_key: string }[]>(
            `DELETE FROM alert_thresholds WHERE dashboard_id = $1 OR metric_key LIKE $2 RETURNING id, metric_key`,
            dashboardId,
            `custom:${dashboardId}:%`,
          );
        }
        if (!rows.length) return { error: 'No matching alert thresholds found.' };
        await prisma.auditLog
          .create({
            data: {
              userId: adminUserId,
              action: rows.length === 1 ? 'alert_threshold.delete' : 'alert_threshold.bulk_delete',
              targetType: 'AlertThreshold',
              targetId: rows.length === 1 ? rows[0].metric_key : legacy ? 'legacy' : dashboardId ?? `${rows.length} ids`,
              metadata: { deleted: rows.length, metricKeys: rows.map((r) => r.metric_key).slice(0, 100), via: 'chat' },
            },
          })
          .catch(() => {});
        return { success: true, deleted: rows.length, metricKeys: rows.map((r) => r.metric_key), message: rows.length === 1 ? 'Alert deleted.' : `${rows.length} alerts deleted.` };
      },
    },

    query_performance: {
      description:
        'Answer questions about RESPONSE TIME and TOOL SPEED from the per-request timing breakdown in prompt_audit_logs.timings. Use for questions like "what is our median response time?", "which tool is slowest?", "how many turns finish under 40 seconds?", "what is the slowest phase?", "which user has the slowest turns?", "is response time getting worse?", "how much time do we spend waiting on tools?". ' +
        'Each measured turn records: totalMs (whole request, from handler entry), ttftMs (time to first token — what the user perceives as "it started"), streamMs (first token to last), phases (named stages including step:<toolname>), toolDetail (per tool: name, ms, ok, step), toolWaitedMs (what the turn ACTUALLY waited on tools — the sum over steps of each step\'s SLOWEST call, because tools in one step run concurrently), toolSerialMs (the same tools run one after another), toolBlockingMs (time finished tools sat idle waiting on a slower sibling). ' +
        'IMPORTANT: only turns run AFTER the timing instrumentation was deployed carry this data — older turns are excluded, so counts here are smaller than total prompt counts. Provider-executed tools (code_execution, web_search, web_fetch) run in Anthropic\'s sandbox and have NO individual duration; their cost appears inside the enclosing step phase instead. ' +
        'Never sum toolDetail durations to get "time waited" — that overstates it whenever tools ran in parallel; use toolWaitedMs.',
      inputSchema: z.object({
        metric: z
          .enum(['summary', 'by_tool', 'by_phase', 'by_user', 'trend', 'slowest_turns'])
          .describe(
            'summary = percentiles + share under thresholds; by_tool = per-tool call count/avg/max/total; by_phase = which named phases cost most; by_user = per-user medians; trend = per-day median/p95; slowest_turns = the worst individual requests.',
          ),
        days: z.number().optional().describe('Look-back window in days (default 30, max 90).'),
        userKey: z.string().optional().describe('Restrict to one user (matches email or name, case-insensitive substring).'),
        route: z.enum(['chat', 'modeling-agent']).optional().describe('Restrict to one agent.'),
        limit: z.number().optional().describe('Max rows for list-style metrics (default 15, cap 50).'),
      }),
      execute: async (input: {
        metric: 'summary' | 'by_tool' | 'by_phase' | 'by_user' | 'trend' | 'slowest_turns';
        days?: number; userKey?: string; route?: string; limit?: number;
      }) => {
        const days = Math.min(90, Math.max(1, input.days ?? 30));
        const limit = Math.min(50, Math.max(1, input.limit ?? 15));
        // Only measured turns — mixing instrumented and uninstrumented rows
        // would silently skew every percentile.
        const where: string[] = ["timings IS NOT NULL", `datetime >= NOW() - INTERVAL '${days} days'`];
        const params: unknown[] = [];
        if (input.userKey) {
          params.push(`%${input.userKey}%`);
          where.push(`(user_email ILIKE $${params.length} OR user_name ILIKE $${params.length})`);
        }
        if (input.route) {
          params.push(input.route);
          where.push(`timings->>'label' = $${params.length}`);
        }
        const W = where.join(' AND ');

        const run = async <T>(sql: string): Promise<T[]> => {
          try {
            return await prisma.$queryRawUnsafe<T[]>(sql, ...params);
          } catch {
            return [];
          }
        };
        // BigInt/Decimal from raw SQL are not JSON-serialisable; normalise.
        const clean = (rows: Record<string, unknown>[]) =>
          rows.map((r) => {
            const o: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(r)) {
              o[k] = typeof v === 'bigint' ? Number(v)
                : v !== null && typeof v === 'object' && 'toNumber' in (v as object)
                  ? Number(v as unknown as number)
                  : typeof v === 'string' && /^[0-9.]+$/.test(v) && k !== 'day' ? Number(v)
                    : v;
            }
            return o;
          });

        const note =
          'Measured turns only (instrumented after the timing deploy). toolWaitedMs is the real wait; ' +
          'summing individual tool durations overstates it when tools ran in parallel.';

        switch (input.metric) {
          case 'summary': {
            const rows = await run<Record<string, unknown>>(`
              SELECT COUNT(*) AS measured_turns,
                ROUND((percentile_cont(0.5)  WITHIN GROUP (ORDER BY (timings->>'totalMs')::numeric))::numeric) AS total_p50_ms,
                ROUND((percentile_cont(0.95) WITHIN GROUP (ORDER BY (timings->>'totalMs')::numeric))::numeric) AS total_p95_ms,
                ROUND(MAX((timings->>'totalMs')::numeric)) AS total_max_ms,
                ROUND((percentile_cont(0.5)  WITHIN GROUP (ORDER BY (timings->>'ttftMs')::numeric))::numeric) AS ttft_p50_ms,
                ROUND(AVG((timings->>'toolWaitedMs')::numeric)) AS avg_tool_wait_ms,
                ROUND(AVG((timings->>'toolBlockingMs')::numeric)) AS avg_straggler_ms,
                ROUND(100.0*COUNT(*) FILTER (WHERE (timings->>'totalMs')::numeric <= 40000)/NULLIF(COUNT(*),0),1) AS pct_under_40s,
                ROUND(100.0*COUNT(*) FILTER (WHERE (timings->>'totalMs')::numeric <= 60000)/NULLIF(COUNT(*),0),1) AS pct_under_60s
              FROM prompt_audit_logs WHERE ${W}`);
            return { windowDays: days, note, summary: clean(rows)[0] ?? null };
          }
          case 'by_tool': {
            const rows = await run<Record<string, unknown>>(`
              SELECT d->>'name' AS tool, COUNT(*) AS calls,
                     ROUND(AVG((d->>'ms')::numeric)) AS avg_ms,
                     ROUND(MAX((d->>'ms')::numeric)) AS max_ms,
                     ROUND(SUM((d->>'ms')::numeric)) AS total_ms,
                     COUNT(*) FILTER (WHERE (d->>'ok') = 'false') AS failures
              FROM prompt_audit_logs p, LATERAL jsonb_array_elements(p.timings->'toolDetail') AS d
              WHERE ${W} GROUP BY 1 ORDER BY total_ms DESC LIMIT ${limit}`);
            return {
              windowDays: days,
              note: note + ' Ranked by TOTAL time contributed, not average.',
              tools: mergeByDisplayName(clean(rows), 'tool', { sum: ['calls', 'total_ms', 'failures'], max: ['max_ms'], avg: ['avg_ms', 'calls'] })
                .sort((a, b) => Number(b.total_ms) - Number(a.total_ms)),
            };
          }
          case 'by_phase': {
            const rows = await run<Record<string, unknown>>(`
              SELECT ph.key AS phase, COUNT(*) AS turns,
                     ROUND(AVG(ph.value::text::numeric)) AS avg_ms,
                     ROUND(SUM(ph.value::text::numeric)) AS total_ms
              FROM prompt_audit_logs p, LATERAL jsonb_each(p.timings->'phases') AS ph
              WHERE ${W} GROUP BY 1 ORDER BY total_ms DESC LIMIT ${limit}`);
            return {
              windowDays: days,
              note: note + ' A "step:<tools>" phase covers one model call PLUS the tools it triggered.',
              phases: clean(rows).map((r) => ({ ...r, phase: stripMcpPrefixes(String(r.phase ?? '')) })),
            };
          }
          case 'by_user': {
            const rows = await run<Record<string, unknown>>(`
              SELECT COALESCE(user_email, user_name, '-') AS account, COUNT(*) AS turns,
                     ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY (timings->>'totalMs')::numeric))::numeric) AS median_ms,
                     ROUND(MAX((timings->>'totalMs')::numeric)) AS worst_ms,
                     ROUND(AVG((timings->>'toolWaitedMs')::numeric)) AS avg_tool_wait_ms
              FROM prompt_audit_logs WHERE ${W} GROUP BY 1 ORDER BY median_ms DESC LIMIT ${limit}`);
            return { windowDays: days, note, users: clean(rows) };
          }
          case 'trend': {
            const rows = await run<Record<string, unknown>>(`
              SELECT to_char(datetime,'YYYY-MM-DD') AS day, COUNT(*) AS turns,
                     ROUND((percentile_cont(0.5)  WITHIN GROUP (ORDER BY (timings->>'totalMs')::numeric))::numeric) AS median_ms,
                     ROUND((percentile_cont(0.95) WITHIN GROUP (ORDER BY (timings->>'totalMs')::numeric))::numeric) AS p95_ms,
                     ROUND(AVG((timings->>'ttftMs')::numeric)) AS avg_ttft_ms
              FROM prompt_audit_logs WHERE ${W} GROUP BY 1 ORDER BY 1`);
            return { windowDays: days, note, trend: clean(rows) };
          }
          case 'slowest_turns': {
            const rows = await run<Record<string, unknown>>(`
              SELECT prompt_id, COALESCE(user_email,user_name,'-') AS account,
                     to_char(datetime,'YYYY-MM-DD HH24:MI') AS at,
                     timings->>'label' AS agent,
                     ROUND((timings->>'totalMs')::numeric) AS total_ms,
                     ROUND((timings->>'ttftMs')::numeric) AS ttft_ms,
                     (timings->>'toolCalls')::int AS tool_calls,
                     timings->'slowest'->>0 AS dominant_phase,
                     left(user_prompt, 160) AS prompt_preview
              FROM prompt_audit_logs WHERE ${W}
              ORDER BY (timings->>'totalMs')::numeric DESC NULLS LAST LIMIT ${limit}`);
            return {
              windowDays: days,
              note,
              slowestTurns: clean(rows).map((r) => ({ ...r, dominant_phase: stripMcpPrefixes(String(r.dominant_phase ?? '')) || null })),
            };
          }
        }
      },
    },
  };
}
