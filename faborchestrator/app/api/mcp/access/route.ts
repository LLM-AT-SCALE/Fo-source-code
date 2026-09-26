import { NextRequest, NextResponse } from 'next/server';

import { requireAuth } from '@/shared/lib/auth-middleware';
import { mcpAccess } from '@/modules/mcp/lib/mcp-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Tells the UI which MCP surfaces to render for this user:
 *  - `enabled`: role has the `mcp` permission → show the Connectors menu and the
 *    MCP settings tab; otherwise hide them entirely.
 *  - `canEditPersonal`: the user may add / edit / delete personal connections.
 * The server enforces the same rules independently.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json(await mcpAccess(auth.user.id));
}
