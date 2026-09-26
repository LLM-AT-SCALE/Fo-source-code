/**
 * MCP Registry — health of one connector.
 * POST: run a check now (reachable → tools → data) and return the detail.
 * GET:  the latest detail plus the last 20 checks (newest first).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/shared/lib/auth-middleware';
import prisma from '@/shared/lib/db';
import { checkRegistryHealth } from '@/modules/mcp/lib/mcp-health';
import type { McpHealthDetail } from '@/modules/mcp/lib/mcp-health-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HISTORY_ROWS = 20;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  try {
    const existing = await prisma.mcpRegistry.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return NextResponse.json({ error: 'Connector not found' }, { status: 404 });
    const health = await checkRegistryHealth(id, { source: 'manual' });
    return NextResponse.json({ health }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('MCP health check error:', error);
    return NextResponse.json({ error: 'Failed to run the health check' }, { status: 500 });
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  try {
    const existing = await prisma.mcpRegistry.findUnique({ where: { id }, select: { id: true, healthDetail: true } });
    if (!existing) return NextResponse.json({ error: 'Connector not found' }, { status: 404 });
    const history = await prisma.mcpHealthCheck.findMany({
      where: { registryId: id },
      orderBy: { checkedAt: 'desc' },
      take: HISTORY_ROWS,
    });
    const health = (existing.healthDetail as McpHealthDetail | null) ?? null;
    return NextResponse.json({ health, history }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('MCP health read error:', error);
    return NextResponse.json({ error: 'Failed to read the health history' }, { status: 500 });
  }
}
