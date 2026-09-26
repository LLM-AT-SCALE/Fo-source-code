/**
 * MCP assignments — links catalog connectors (mcp_registry) to roles or users,
 * always for ONE agent: an assignment is (connector, target, agent), and the
 * agent sees only its own assignments.
 * GET  ?roleId= | ?userId= [&agent=]  → list that target's assigned connectors.
 * POST { registryId, roleId | userId, agent } → assign a catalog connector (copies
 *        its fields onto an mcp_connections row; prevents duplicate assignment).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import { recordAuditLogDirect } from '@/modules/admin/lib/services/audit-service';
import prisma from '@/shared/lib/db';
import { AGENT_KEYS, isAgentKey } from '@/shared/lib/agents';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const sp = req.nextUrl.searchParams;
    const userId = sp.get('userId');
    const roleId = sp.get('roleId');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let where: any;
    if (userId) where = { userId }; // ALL of this user's MCPs (admin-assigned, legacy, and personal)
    else if (roleId) where = { roleId };
    else where = { roleId: { not: null } }; // legacy default: all role-level
    const agent = sp.get('agent');
    if (agent && isAgentKey(agent)) where = { ...where, agent };

    const connections = await prisma.mcpConnection.findMany({
      where,
      include: {
        role: { select: { id: true, name: true } },
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({
      connections: connections.map((c) => ({
        id: c.id,
        registryId: c.registryId,
        name: c.name,
        serverUrl: c.serverUrl,
        authType: c.authType,
        status: c.status,
        isActive: c.isActive,
        agent: c.agent,
        role: c.role ? { id: c.role.id, name: c.role.name } : null,
        user: c.user ? { id: c.user.id, name: c.user.name, email: c.user.email } : null,
        assignType: c.roleId ? 'role' : c.userId ? 'user' : 'unknown',
        createdAt: c.createdAt,
      })),
    });
  } catch (error) {
    console.error('List MCP assignments error:', error);
    return NextResponse.json({ error: 'Failed to list assignments' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { registryId, roleId, userId, agent } = await req.json();
    if (!registryId) return NextResponse.json({ error: 'registryId is required' }, { status: 400 });
    if (!roleId && !userId) return NextResponse.json({ error: 'Either role or user must be specified' }, { status: 400 });
    if (!isAgentKey(agent)) return NextResponse.json({ error: `agent must be one of ${AGENT_KEYS.join(', ')}` }, { status: 400 });

    const connector = await prisma.mcpRegistry.findUnique({ where: { id: registryId } });
    if (!connector) return NextResponse.json({ error: 'Connector not found' }, { status: 404 });

    let targetName = '';
    if (roleId) {
      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role) return NextResponse.json({ error: 'Role not found' }, { status: 404 });
      targetName = role.name;
    } else {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
      targetName = user.name || user.email;
    }

    // Prevent assigning the same connector to the same target twice for the same agent.
    const dupe = await prisma.mcpConnection.findFirst({
      where: { registryId, agent, ...(roleId ? { roleId } : { userId }) },
    });
    if (dupe) return NextResponse.json({ error: 'This connector is already assigned to that target for this agent' }, { status: 409 });

    const conn = await prisma.mcpConnection.create({
      data: {
        userId: userId || null,
        roleId: roleId || null,
        registryId,
        agent,
        name: connector.displayName,
        serverUrl: connector.serverUrl,
        authType: connector.authType,
        authCredentialsEncrypted: connector.authCredentialsEncrypted,
      },
    });

    await recordAuditLogDirect(prisma, {
      userId: auth.user.id,
      action: roleId ? 'mcp.assigned_to_role' : 'mcp.assigned_to_user',
      targetType: 'McpConnection',
      targetId: conn.id,
      metadata: { connector: connector.displayName, target: targetName, registryId, agent },
      ipAddress: getIpAddress(req),
    });

    return NextResponse.json({ id: conn.id, name: conn.name, target: targetName }, { status: 201 });
  } catch (error) {
    console.error('Assign MCP error:', error);
    return NextResponse.json({ error: 'Failed to assign connector' }, { status: 500 });
  }
}
