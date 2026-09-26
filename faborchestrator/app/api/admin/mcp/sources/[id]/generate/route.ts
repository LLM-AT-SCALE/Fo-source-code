/**
 * On-the-Fly MCP — Step 3: generate + static-check the manifest. Thin wrapper over
 * the shared service. Returns the manifest for the admin to REVIEW before deploy.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import { generateDataSourceManifest } from '@/modules/admin/lib/mcp/mcp-onthefly/service';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  const r = await generateDataSourceManifest(id, auth.user.id, getIpAddress(req) || 'api');
  if (!r.ok) return NextResponse.json({ error: r.error, details: r.details }, { status: r.httpStatus });
  return NextResponse.json({ ok: true, staticCheck: r.staticCheck, manifest: r.manifest });
}
