/**
 * On-the-Fly MCP — Step 2: test connectivity + discover schema. Thin wrapper over
 * the shared service (lib/mcp/mcp-onthefly/service.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import { connectDataSource } from '@/modules/admin/lib/mcp/mcp-onthefly/service';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  const r = await connectDataSource(id, auth.user.id, getIpAddress(req) || 'api');
  if (!r.ok) {
    // `details` carries which side failed (platform | target) and the error-log id.
    const d = (r.details ?? {}) as { kind?: string; errorId?: string };
    return NextResponse.json({ error: r.error, kind: d.kind, errorId: d.errorId }, { status: r.httpStatus });
  }
  return NextResponse.json({ reachable: true, latencyMs: r.latencyMs, tableCount: r.tableCount, tables: r.tables });
}
