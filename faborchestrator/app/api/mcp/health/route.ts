import { NextRequest, NextResponse } from 'next/server';

import { requireAuth } from '@/shared/lib/auth-middleware';
import { checkServersForUser, getMcpHealthSummary } from '@/modules/mcp/lib/mcp-health';
import { isAgentKey } from '@/shared/lib/agents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The cockpit's view of MCP health for the signed-in user: per agent, only the
 * servers that user is entitled to (role assignments + own connections), each
 * with its latest status, and the worst of them as the overall status.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const summary = await getMcpHealthSummary(auth.user.id);
    return NextResponse.json(summary, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('MCP health summary error:', error);
    return NextResponse.json({ error: 'Failed to read MCP health' }, { status: 500 });
  }
}

/**
 * The cockpit's "Check now": re-check the signed-in user's own MCP servers
 * immediately (MCP server + database) and return the fresh summary.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const agentParam = request.nextUrl.searchParams.get('agent');
    const summary = await checkServersForUser(auth.user.id, isAgentKey(agentParam) ? agentParam : undefined);
    return NextResponse.json(summary, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('MCP health check-now error:', error);
    return NextResponse.json({ error: 'Failed to check the MCP servers' }, { status: 500 });
  }
}
