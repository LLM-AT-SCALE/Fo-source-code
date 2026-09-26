import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { mcpAccess, setManagedDisabled } from '@/modules/mcp/lib/mcp-access';
import prisma from '@/shared/lib/db';

// GET /api/mcp/connections/[id] - Get a single MCP connection
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  try {
    const { id } = await params;
    const connection = await prisma.mcpConnection.findUnique({
      where: { id },
    });

    if (!connection) {
      return NextResponse.json(
        { error: 'MCP connection not found' },
        { status: 404 }
      );
    }

    // Verify ownership
    if (connection.userId !== user.id) {
      return NextResponse.json(
        { error: 'Not authorized to access this MCP connection' },
        { status: 403 }
      );
    }

    return NextResponse.json({
      id: connection.id,
      name: connection.name,
      serverUrl: connection.serverUrl,
      authType: connection.authType,
      status: connection.status,
      lastError: connection.lastError,
      isActive: connection.isActive,
      availableTools: connection.availableTools,
      lastConnectedAt: connection.lastConnectedAt?.toISOString() || null,
    });
  } catch (error) {
    console.error('Error fetching MCP connection:', error);
    return NextResponse.json(
      { error: 'Failed to fetch MCP connection' },
      { status: 500 }
    );
  }
}

// PATCH /api/mcp/connections/[id] - Update an MCP connection
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  try {
    const { id } = await params;
    const body = await req.json();

    const connection = await prisma.mcpConnection.findUnique({
      where: { id },
    });
    if (!connection) {
      return NextResponse.json(
        { error: 'MCP connection not found' },
        { status: 404 }
      );
    }

    // Changing a connection needs the role's "manage MCP connections" option.
    if (!(await mcpAccess(user.id)).canEditPersonal) {
      return NextResponse.json(
        { error: 'Your role does not allow configuring MCP connections' },
        { status: 403 }
      );
    }

    // A role-level (admin-assigned) row is shared by the whole role: the only
    // change a user may make is switching it off / on for themselves.
    if (connection.userId == null && connection.roleId != null) {
      const me = await prisma.user.findUnique({ where: { id: user.id }, select: { roleId: true } });
      if (me?.roleId !== connection.roleId) {
        return NextResponse.json({ error: 'Not authorized to update this MCP connection' }, { status: 403 });
      }
      if (body.status !== 'connected' && body.status !== 'disconnected') {
        return NextResponse.json({ error: 'Only connect / disconnect is allowed on an assigned connection' }, { status: 400 });
      }
      await setManagedDisabled(user.id, id, body.status === 'disconnected');
      return NextResponse.json({ id, status: body.status, source: 'role' });
    }

    // Verify ownership
    if (connection.userId !== user.id) {
      return NextResponse.json(
        { error: 'Not authorized to update this MCP connection' },
        { status: 403 }
      );
    }

    // Filter allowed update fields
    const allowedFields = ['name', 'serverUrl', 'status', 'isActive', 'lastError', 'availableTools', 'lastConnectedAt'];
    const updateData: Record<string, unknown> = {};

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updateData[field] = body[field];
      }
    }

    const updated = await prisma.mcpConnection.update({
      where: { id },
      data: updateData,
    });

    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      serverUrl: updated.serverUrl,
      authType: updated.authType,
      status: updated.status,
      lastError: updated.lastError,
      isActive: updated.isActive,
      availableTools: updated.availableTools,
      lastConnectedAt: updated.lastConnectedAt?.toISOString() || null,
    });
  } catch (error) {
    console.error('Error updating MCP connection:', error);
    return NextResponse.json(
      { error: 'Failed to update MCP connection' },
      { status: 500 }
    );
  }
}

// DELETE /api/mcp/connections/[id] - Delete an MCP connection
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  try {
    const { id } = await params;

    const connection = await prisma.mcpConnection.findUnique({
      where: { id },
    });
    if (!connection) {
      return NextResponse.json(
        { error: 'MCP connection not found' },
        { status: 404 }
      );
    }

    // Verify ownership
    if (connection.userId !== user.id) {
      return NextResponse.json(
        { error: 'Not authorized to delete this MCP connection' },
        { status: 403 }
      );
    }

    if (!(await mcpAccess(user.id)).canEditPersonal) {
      return NextResponse.json(
        { error: 'Your role does not allow configuring MCP connections' },
        { status: 403 }
      );
    }

    await prisma.mcpConnection.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting MCP connection:', error);
    return NextResponse.json(
      { error: 'Failed to delete MCP connection' },
      { status: 500 }
    );
  }
}
