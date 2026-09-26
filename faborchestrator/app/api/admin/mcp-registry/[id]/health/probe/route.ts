import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/shared/lib/auth-middleware';
import { chooseProbeWithModel } from '@/modules/mcp/lib/mcp-health';
import { prisma } from '@/shared/lib/db';
import { Prisma } from '@/lib/generated/prisma/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** "Let AI choose": the model proposes read-only calls, each is verified, the first that returns data is saved. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    const result = await chooseProbeWithModel(id);
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('MCP probe suggestion error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to choose a probe' }, { status: 500 });
  }
}

/** "Reset to automatic": forget the saved probe; the next check picks again. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    await prisma.mcpRegistry.update({ where: { id }, data: { healthProbe: Prisma.DbNull } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('MCP probe reset error:', error);
    return NextResponse.json({ error: 'Failed to reset the probe' }, { status: 500 });
  }
}
