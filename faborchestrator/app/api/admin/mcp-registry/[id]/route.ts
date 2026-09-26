/**
 * MCP Registry single connector.
 * PATCH: edit a connector — changes propagate to every role/user it's assigned to.
 *        Also sets `healthProbe` ({ tool, arguments? } | null), the data probe the
 *        health check calls; null = pick automatically.
 * DELETE: remove a connector + all its assignments.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import { recordAuditLogDirect } from '@/modules/admin/lib/services/audit-service';
import prisma from '@/shared/lib/db';
import { encrypt } from '@/shared/lib/encryption';
import { Prisma } from '@/lib/generated/prisma/client';

const AUTH_TYPES = ['none', 'api_key', 'oauth'];
const PROBE_TOOL_MAX = 120;

/** `{ tool, arguments? }` or null to clear; a string return is the validation error. */
function parseProbe(v: unknown): { tool: string; arguments?: Record<string, unknown> } | null | string {
  if (v === null) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'healthProbe must be an object { tool, arguments } or null';
  const o = v as Record<string, unknown>;
  const tool = typeof o.tool === 'string' ? o.tool.trim() : '';
  if (!tool) return 'healthProbe.tool is required';
  if (tool.length > PROBE_TOOL_MAX) return `healthProbe.tool must be at most ${PROBE_TOOL_MAX} characters`;
  if (o.arguments !== undefined && o.arguments !== null) {
    if (typeof o.arguments !== 'object' || Array.isArray(o.arguments)) return 'healthProbe.arguments must be an object';
    return { tool, arguments: o.arguments as Record<string, unknown> };
  }
  return { tool };
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  try {
    const existing = await prisma.mcpRegistry.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Connector not found' }, { status: 404 });

    const body = await req.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = {};
    let name = existing.displayName;
    let url = existing.serverUrl;
    let at = existing.authType;

    if (body.displayName !== undefined) { name = String(body.displayName).trim(); data.displayName = name; }
    if (body.description !== undefined) data.description = body.description ? String(body.description).trim() : null;
    if (body.serverUrl !== undefined) {
      url = String(body.serverUrl).trim();
      try { new URL(url); } catch { return NextResponse.json({ error: 'Invalid server URL' }, { status: 400 }); }
      data.serverUrl = url;
    }
    if (body.authType !== undefined) { at = AUTH_TYPES.includes(body.authType) ? body.authType : 'none'; data.authType = at; }
    if (body.isActive !== undefined) data.isActive = !!body.isActive;
    if (body.healthProbe !== undefined) {
      const probe = parseProbe(body.healthProbe);
      if (typeof probe === 'string') return NextResponse.json({ error: probe }, { status: 400 });
      // Prisma Json column: null clears it (DbNull), an object stores it.
      data.healthProbe = probe === null ? Prisma.DbNull : probe;
    }
    // Re-encrypt credentials only when a new key is supplied; clear when switching away from api_key.
    let credsChanged = false;
    let newCreds: string | null = existing.authCredentialsEncrypted;
    if (at !== 'api_key') { if (existing.authCredentialsEncrypted) { data.authCredentialsEncrypted = null; newCreds = null; credsChanged = true; } }
    else if (body.apiKey) { newCreds = encrypt(JSON.stringify({ apiKey: body.apiKey })); data.authCredentialsEncrypted = newCreds; credsChanged = true; }

    // Uniqueness guard (exclude self).
    if (data.displayName || data.serverUrl) {
      const dupe = await prisma.mcpRegistry.findFirst({
        where: {
          id: { not: id },
          OR: [{ serverUrl: url }, { displayName: { equals: name, mode: 'insensitive' } }],
        },
      });
      if (dupe) {
        return NextResponse.json(
          { error: dupe.serverUrl === url ? 'A connector with this URL already exists' : 'A connector with this name already exists' },
          { status: 409 }
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.mcpRegistry.update({ where: { id }, data });

      // Propagate to every assignment (role + user) derived from this connector.
      // Match by registryId AND by the connector's (old) serverUrl: some copies
      // are created without a registryId back-link (the add_mcp_to_role chat tool,
      // and users' own personal connections to the same server), so a
      // registryId-only updateMany left those rows showing the stale name in Fab
      // Orch. serverUrl uniquely identifies a connector (enforced by the
      // uniqueness guard above), so this is safe. `registryId: id` in the payload
      // also backfills the link on those orphaned rows so future edits match
      // directly. Note: match on existing.serverUrl (the pre-edit URL) so rows are
      // found even when this same request is also changing the URL.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const propagate: any = { name, serverUrl: url, authType: at, registryId: id };
      if (credsChanged) propagate.authCredentialsEncrypted = newCreds;
      await tx.mcpConnection.updateMany({
        where: { OR: [{ registryId: id }, { serverUrl: existing.serverUrl }] },
        data: propagate,
      });

      await recordAuditLogDirect(tx, {
        userId: auth.user.id,
        action: 'mcp.connector_updated',
        targetType: 'McpRegistry',
        targetId: id,
        metadata: { displayName: name, serverUrl: url, fields: Object.keys(data) },
        ipAddress: getIpAddress(req),
      });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Update MCP connector error:', error);
    return NextResponse.json({ error: 'Failed to update connector' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  try {
    const existing = await prisma.mcpRegistry.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Connector not found' }, { status: 404 });

    const result = await prisma.$transaction(async (tx) => {
      // Remove all assignments derived from this connector, then the connector itself.
      const removed = await tx.mcpConnection.deleteMany({ where: { registryId: id } });
      await tx.mcpRegistry.delete({ where: { id } });
      await recordAuditLogDirect(tx, {
        userId: auth.user.id,
        action: 'mcp.connector_deleted',
        targetType: 'McpRegistry',
        targetId: id,
        metadata: { displayName: existing.displayName, serverUrl: existing.serverUrl, assignmentsRemoved: removed.count },
        ipAddress: getIpAddress(req),
      });
      return removed.count;
    });

    return NextResponse.json({ success: true, assignmentsRemoved: result });
  } catch (error) {
    console.error('Delete MCP connector error:', error);
    return NextResponse.json({ error: 'Failed to delete connector' }, { status: 500 });
  }
}
