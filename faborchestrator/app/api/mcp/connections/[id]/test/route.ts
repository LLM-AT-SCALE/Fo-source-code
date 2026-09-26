import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';
import prisma from '@/shared/lib/db';
import { connectMcpConnection } from '@/modules/mcp/lib/mcp-connect';
import { mcpAccess, setManagedDisabled } from '@/modules/mcp/lib/mcp-access';

// POST /api/mcp/connections/[id]/test - Connect / test a connection the user is
// entitled to (initialize + tools/list, result persisted on the row). Needs the
// role's "manage MCP connections" option. On an admin-assigned (role-level)
// connection it also clears the user's own switch-off.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  try {
    const { id } = await params;
    const connection = await prisma.mcpConnection.findUnique({ where: { id } });

    if (!connection) {
      return NextResponse.json(
        { error: 'MCP connection not found' },
        { status: 404 }
      );
    }

    const access = await mcpAccess(user.id);
    if (!access.canEditPersonal) {
      return NextResponse.json(
        { error: 'Your role does not allow configuring MCP connections' },
        { status: 403 }
      );
    }

    // An assigned (role-level) row: re-enable it for this user, then make sure
    // the shared row itself is connected.
    if (connection.userId == null && connection.roleId != null) {
      const me = await prisma.user.findUnique({ where: { id: user.id }, select: { roleId: true } });
      if (me?.roleId !== connection.roleId) {
        return NextResponse.json({ error: 'Not authorized to test this MCP connection' }, { status: 403 });
      }
      await setManagedDisabled(user.id, id, false);
      return NextResponse.json(await connectMcpConnection(connection));
    }

    // Verify ownership
    if (connection.userId !== user.id) {
      return NextResponse.json(
        { error: 'Not authorized to test this MCP connection' },
        { status: 403 }
      );
    }

    return NextResponse.json(await connectMcpConnection(connection));
  } catch (error) {
    console.error('Error testing MCP connection:', error);
    return NextResponse.json(
      { error: 'Failed to test MCP connection' },
      { status: 500 }
    );
  }
}
