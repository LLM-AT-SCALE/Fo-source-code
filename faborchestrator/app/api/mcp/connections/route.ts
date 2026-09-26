import { NextRequest, NextResponse } from 'next/server';
import { createMcpConnection, getUserMcpConnections } from '@/shared/lib/storage';
import { encrypt } from '@/shared/lib/encryption';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { mcpAccess, getDisabledManagedIds } from '@/modules/mcp/lib/mcp-access';
import { agentKeyFrom, isAgentKey, AGENT_KEYS } from '@/shared/lib/agents';
import { autoConnectMcp } from '@/modules/mcp/lib/mcp-connect';
import { prisma } from '@/shared/lib/db';
import { handleApiError } from '@/shared/lib/errors/api-error-handler';
import { applyRowCap } from '@/shared/lib/errors/row-cap';
import { FabOrchError } from '@/shared/lib/errors/faborch-errors';
import { ALLOWED_MCP_AUTH_TYPES } from '@/shared/lib/errors/parameter-values';

// GET /api/mcp/connections?agent=<key> - the user's personal + role-level
// connections for ONE agent (default: the chat agent). `agent=all` returns every
// agent's rows with their `agent` field (the settings page groups them).
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  try {
    // A role without the `mcp` permission sees no connections at all.
    const access = await mcpAccess(user.id);
    if (!access.enabled) return NextResponse.json([]);

    const userWithRole = await prisma.user.findUnique({
      where: { id: user.id },
      include: { role: true },
    });

    // Each agent sees only its own connections; nothing crosses over.
    const agentParam = req.nextUrl.searchParams.get('agent');
    const agent = agentParam === 'all' ? undefined : agentKeyFrom(agentParam);

    // Personal MCPs (owned by this user) and role-level MCPs (assigned by the admin).
    const personalRows = await getUserMcpConnections(user.id, agent);
    const roleRows = userWithRole?.roleId
      ? await prisma.mcpConnection.findMany({ where: { roleId: userWithRole.roleId, userId: null, isActive: true, ...(agent ? { agent } : {}) } })
      : [];

    // Every connection the role is entitled to is connected automatically, so a
    // user without configuration rights never has to press Connect. Only a
    // personal connection the user switched off on purpose is left alone.
    // A role-level row is shared by everyone in the role; a user who may manage
    // connections can switch it off for themselves only (stored on the user).
    const disabled = access.canEditPersonal ? await getDisabledManagedIds(user.id) : new Set<string>();
    const connected = await autoConnectMcp(
      [...personalRows, ...roleRows.filter((r) => !disabled.has(r.id))],
      { respectManualOff: access.canEditPersonal },
    );
    const byId = new Map(connected.map((c) => [c.id, c]));
    const roleIds = new Set(roleRows.map((r) => r.id));

    const personal = connected.filter((conn) => !roleIds.has(conn.id)).map((conn) => ({
      id: conn.id,
      name: conn.name,
      serverUrl: conn.serverUrl,
      authType: conn.authType,
      status: conn.status,
      lastError: conn.lastError,
      isActive: conn.isActive,
      availableTools: conn.availableTools,
      lastConnectedAt: conn.lastConnectedAt?.toISOString() || null,
      agent: conn.agent,
      source: 'personal',
      canDelete: true,
    }));

    // Role-level MCPs are always enabled for the role; the status reflects the
    // automatic connection attempt so an unreachable server is visible.
    const roleMcps = roleRows.map((row) => byId.get(row.id) ?? row).map((conn) => ({
      id: conn.id,
      name: conn.name,
      serverUrl: conn.serverUrl,
      authType: conn.authType,
      status: disabled.has(conn.id) ? 'disconnected' : conn.status,
      lastError: disabled.has(conn.id) ? null : conn.lastError,
      isActive: !disabled.has(conn.id),
      availableTools: conn.availableTools as unknown[],
      lastConnectedAt: conn.lastConnectedAt?.toISOString() || null,
      agent: conn.agent,
      source: 'role',
      canDelete: false,
    }));

    const all = [...personal, ...roleMcps];
    const { rows, warning } = applyRowCap(all);
    if (warning) {
      return NextResponse.json(rows, {
        headers: {
          'X-FabOrch-Warning': warning.type,
          'X-FabOrch-Warning-Message': warning.userMessage,
        },
      });
    }
    return NextResponse.json(rows);
  } catch (error) {
    return handleApiError(error, req, {
      route: '/api/mcp/connections',
      userId: user.id,
    });
  }
}

// POST /api/mcp/connections - Create a new personal MCP connection
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  try {
    // Check role permissions
    const access = await mcpAccess(user.id);
    if (!access.enabled) {
      return NextResponse.json({ error: 'Your role does not have MCP access.' }, { status: 403 });
    }
    const userWithRole = await prisma.user.findUnique({
      where: { id: user.id },
      include: { role: true },
    });

    if (userWithRole?.role && !access.isAdmin) {
      if (!access.canAddPersonal) {
        return NextResponse.json(
          { error: 'Your role does not allow adding your own MCP connections.' },
          { status: 403 }
        );
      }
      const currentCount = await prisma.mcpConnection.count({ where: { userId: user.id } });
      if (currentCount >= access.personalMaxCount) {
        return NextResponse.json(
          { error: `Maximum ${access.personalMaxCount} personal MCP connections reached.` },
          { status: 403 }
        );
      }
    }

    const body = await req.json();
    const { name, serverUrl, authType, oauthClientId, oauthClientSecret, apiKey, agent } = body;

    if (!name) throw FabOrchError.missingFilter({ parameter: 'name' }, 'A connection name is required.');
    if (!isAgentKey(agent)) throw FabOrchError.invalidParameter('agent', [...AGENT_KEYS], undefined, { badValue: agent });
    if (!serverUrl) throw FabOrchError.missingFilter({ parameter: 'serverUrl' }, 'A server URL is required.');

    try { new URL(serverUrl); } catch {
      throw FabOrchError.invalidParameter('serverUrl', undefined, undefined, { badValue: serverUrl });
    }

    if (authType && !ALLOWED_MCP_AUTH_TYPES.includes(authType)) {
      throw FabOrchError.invalidParameter('authType', ALLOWED_MCP_AUTH_TYPES, undefined, { badValue: authType });
    }

    let encryptedCredentials: string | undefined;
    if (authType === 'oauth' && oauthClientId && oauthClientSecret) {
      encryptedCredentials = encrypt(JSON.stringify({ clientId: oauthClientId, clientSecret: oauthClientSecret }));
    } else if (authType === 'api_key' && apiKey) {
      encryptedCredentials = encrypt(JSON.stringify({ apiKey }));
    }

    const connection = await createMcpConnection({
      userId: user.id,
      name,
      serverUrl,
      authType: authType || 'none',
      authCredentialsEncrypted: encryptedCredentials,
      agent,
    });

    return NextResponse.json({
      id: connection.id,
      name: connection.name,
      serverUrl: connection.serverUrl,
      authType: connection.authType,
      status: connection.status,
      isActive: connection.isActive,
      agent: connection.agent,
      source: 'personal',
    }, { status: 201 });
  } catch (error) {
    return handleApiError(error, req, {
      route: '/api/mcp/connections',
      userId: user.id,
    });
  }
}
