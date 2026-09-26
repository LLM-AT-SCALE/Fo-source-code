/**
 * On-the-Fly MCP — Step 4 (deploy + validate) and Step 5 (register in mcp_registry).
 * Thin wrapper over the shared service, which re-runs the static gate before deploy.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import { deployDataSource } from '@/modules/admin/lib/mcp/mcp-onthefly/service';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  const r = await deployDataSource(id, auth.user.id, getIpAddress(req) || 'api');
  if (!r.ok) return NextResponse.json({ error: r.error, details: r.details }, { status: r.httpStatus });
  return NextResponse.json({
    status: r.status, registryId: r.registryId, endpointUrl: r.endpointUrl,
    message: 'Server deployed, validated, and registered. Assign it to a user/role via POST /api/admin/mcp.',
  });
}
