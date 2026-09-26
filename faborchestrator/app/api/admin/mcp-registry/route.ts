/**
 * MCP Registry — the catalog of available MCP connectors.
 * GET: list all connectors (+ assignment counts)
 * POST: add a new connector (unique name + url)
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import { recordAuditLogDirect } from '@/modules/admin/lib/services/audit-service';
import prisma from '@/shared/lib/db';
import { encrypt } from '@/shared/lib/encryption';

const AUTH_TYPES = ['none', 'api_key', 'oauth'];

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const servers = await prisma.mcpRegistry.findMany({ orderBy: { displayName: 'asc' } });
    // Count every connection pointing at each connector's server URL — this
    // includes role assignments, user assignments, AND users' personal
    // connections (which have no registry_id link). Matched by serverUrl,
    // the connector's natural key.
    const counts = await prisma.mcpConnection.groupBy({
      by: ['serverUrl'],
      _count: { _all: true },
    });
    const countByUrl = new Map(counts.map((c) => [c.serverUrl, c._count._all]));
    // Per-URL breakdown for the connector cards: role vs user assignments, the
    // tool count Fab AI discovered, and the most recent successful connection.
    const conns = await prisma.mcpConnection.findMany({
      select: { serverUrl: true, roleId: true, userId: true, availableTools: true, lastConnectedAt: true, status: true },
    });
    type Stats = { roleCount: number; userCount: number; toolCount: number | null; toolNames: Set<string>; lastConnectedAt: Date | null; connected: boolean };
    const statsByUrl = new Map<string, Stats>();
    for (const c of conns) {
      const st = statsByUrl.get(c.serverUrl) ?? { roleCount: 0, userCount: 0, toolCount: null, toolNames: new Set<string>(), lastConnectedAt: null, connected: false };
      if (c.roleId) st.roleCount += 1;
      if (c.userId) st.userCount += 1;
      const tools = Array.isArray(c.availableTools) ? c.availableTools.length : null;
      if (tools !== null) st.toolCount = Math.max(st.toolCount ?? 0, tools);
      // Distinct discovered tool names across every connection to this server —
      // the health-probe picker offers them.
      if (Array.isArray(c.availableTools)) {
        for (const t of c.availableTools) {
          const name = t && typeof t === 'object' && 'name' in t ? (t as { name?: unknown }).name : null;
          if (typeof name === 'string' && name) st.toolNames.add(name);
        }
      }
      if (c.lastConnectedAt && (!st.lastConnectedAt || c.lastConnectedAt > st.lastConnectedAt)) st.lastConnectedAt = c.lastConnectedAt;
      if (c.status === 'connected') st.connected = true;
      statsByUrl.set(c.serverUrl, st);
    }

    return NextResponse.json({
      servers: servers.map((s) => ({
        id: s.id,
        displayName: s.displayName,
        description: s.description,
        serverUrl: s.serverUrl,
        authType: s.authType,
        hasCredentials: !!s.authCredentialsEncrypted,
        isActive: s.isActive,
        assignmentCount: countByUrl.get(s.serverUrl) || 0,
        roleCount: statsByUrl.get(s.serverUrl)?.roleCount ?? 0,
        userCount: statsByUrl.get(s.serverUrl)?.userCount ?? 0,
        toolCount: statsByUrl.get(s.serverUrl)?.toolCount ?? null,
        toolNames: [...(statsByUrl.get(s.serverUrl)?.toolNames ?? [])].sort(),
        lastConnectedAt: statsByUrl.get(s.serverUrl)?.lastConnectedAt ?? null,
        connected: statsByUrl.get(s.serverUrl)?.connected ?? false,
        healthStatus: s.healthStatus,
        healthCheckedAt: s.healthCheckedAt,
        healthDetail: s.healthDetail,
        healthProbe: s.healthProbe,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    });
  } catch (error) {
    console.error('List MCP registry error:', error);
    return NextResponse.json({ error: 'Failed to list connectors' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { displayName, serverUrl, authType, apiKey, description } = await req.json();
    const name = String(displayName || '').trim();
    const url = String(serverUrl || '').trim();

    if (!name || !url) {
      return NextResponse.json({ error: 'Name and server URL are required' }, { status: 400 });
    }
    try { new URL(url); } catch {
      return NextResponse.json({ error: 'Invalid server URL' }, { status: 400 });
    }
    const at = AUTH_TYPES.includes(authType) ? authType : 'none';

    // Uniqueness — no duplicate connectors (by URL or name).
    const dupe = await prisma.mcpRegistry.findFirst({
      where: { OR: [{ serverUrl: url }, { displayName: { equals: name, mode: 'insensitive' } }] },
    });
    if (dupe) {
      return NextResponse.json(
        { error: dupe.serverUrl === url ? 'A connector with this URL already exists' : 'A connector with this name already exists' },
        { status: 409 }
      );
    }

    const encryptedCreds = at === 'api_key' && apiKey ? encrypt(JSON.stringify({ apiKey })) : null;

    const server = await prisma.mcpRegistry.create({
      data: {
        displayName: name,
        description: description ? String(description).trim() : null,
        serverUrl: url,
        authType: at,
        authCredentialsEncrypted: encryptedCreds,
      },
    });

    await recordAuditLogDirect(prisma, {
      userId: auth.user.id,
      action: 'mcp.connector_created',
      targetType: 'McpRegistry',
      targetId: server.id,
      metadata: { displayName: name, serverUrl: url, authType: at },
      ipAddress: getIpAddress(req),
    });

    return NextResponse.json({ id: server.id, displayName: server.displayName }, { status: 201 });
  } catch (error) {
    console.error('Create MCP connector error:', error);
    return NextResponse.json({ error: 'Failed to create connector' }, { status: 500 });
  }
}
