/**
 * Admin MCP single connection — DELETE role-level MCP
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import { recordAuditLogDirect } from '@/modules/admin/lib/services/audit-service';
import prisma from '@/shared/lib/db';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  try {
    const connection = await prisma.mcpConnection.findUnique({ where: { id } });
    if (!connection) {
      return NextResponse.json({ error: 'MCP connection not found' }, { status: 404 });
    }
    // Admin can remove any MCP connection (role-level, admin-assigned, or a
    // user's personal one) — the admin manages all user access.
    await prisma.mcpConnection.delete({ where: { id } });

    await recordAuditLogDirect(prisma, {
      userId: auth.user.id,
      action: connection.roleId ? 'mcp.unassigned_from_role' : 'mcp.unassigned_from_user',
      targetType: 'McpConnection',
      targetId: id,
      metadata: { name: connection.name, serverUrl: connection.serverUrl },
      ipAddress: getIpAddress(req),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete role MCP error:', error);
    return NextResponse.json({ error: 'Failed to delete MCP' }, { status: 500 });
  }
}
