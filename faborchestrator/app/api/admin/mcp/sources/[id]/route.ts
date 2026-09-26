/**
 * On-the-Fly MCP — get one data source, or RETIRE it (full deprovision).
 * GET    → non-secret detail (incl. the generated manifest for review).
 * DELETE → delete the Lambda + Function URL, the Secrets Manager secret, the
 *          mcp_registry row + its mcp_connections assignments, then mark RETIRED.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import { recordAuditLogDirect } from '@/modules/admin/lib/services/audit-service';
import prisma from '@/shared/lib/db';
import { deleteRuntime } from '@/modules/admin/lib/mcp/mcp-onthefly/deploy';
import { deleteTargetSecret } from '@/modules/admin/lib/mcp/mcp-onthefly/secrets';
import { secretStillInUse } from '@/modules/admin/lib/mcp/mcp-onthefly/reuse';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  const s = await prisma.mcpDataSource.findUnique({ where: { id } });
  if (!s) return NextResponse.json({ error: 'Data source not found' }, { status: 404 });
  return NextResponse.json({
    id: s.id, name: s.name, engine: s.engine, status: s.status,
    host: s.host, port: s.port, database: s.database, schemas: s.schemasJson,
    hasSecret: !!s.secretArn, discoveredSchema: s.discoveredSchema, manifest: s.manifest,
    staticCheck: s.staticCheck, endpointUrl: s.endpointUrl, registryId: s.registryId,
    lastError: s.lastError, createdAt: s.createdAt, updatedAt: s.updatedAt,
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  const ds = await prisma.mcpDataSource.findUnique({ where: { id } });
  if (!ds) return NextResponse.json({ error: 'Data source not found' }, { status: 404 });

  const cleanup: Record<string, string> = {};

  // 1) Lambda (Function URL + reserved concurrency are removed with the function).
  if (ds.lambdaArn) {
    try { await deleteRuntime(ds.id); } catch (e) { cleanup.lambda = e instanceof Error ? e.message : 'error'; }
  }
  // 2) Secrets Manager secret — unless another live data source shares it
  //    (credential reuse at intake), in which case only this row lets go of it.
  if (ds.secretArn) {
    if (await secretStillInUse(ds.secretArn, ds.id)) {
      cleanup.secret = 'kept: still used by another data source';
    } else {
      try { await deleteTargetSecret(ds.secretArn); } catch (e) { cleanup.secret = e instanceof Error ? e.message : 'error'; }
    }
  }
  // 3) mcp_registry row + its assignments (mirrors the registry DELETE behaviour).
  if (ds.registryId) {
    try {
      await prisma.$transaction([
        prisma.mcpConnection.deleteMany({ where: { registryId: ds.registryId } }),
        prisma.mcpRegistry.delete({ where: { id: ds.registryId } }),
      ]);
    } catch (e) { cleanup.registry = e instanceof Error ? e.message : 'error'; }
  }

  // 4) Mark RETIRED and drop sensitive references.
  await prisma.mcpDataSource.update({
    where: { id },
    data: { status: 'RETIRED', secretArn: null, endpointAuthEncrypted: null, registryId: null, lastError: Object.keys(cleanup).length ? JSON.stringify(cleanup) : null },
  });
  await recordAuditLogDirect(prisma, {
    userId: auth.user.id,
    action: 'mcp_otf.retired',
    targetType: 'McpDataSource',
    targetId: id,
    metadata: { cleanup },
    ipAddress: getIpAddress(req),
  });

  return NextResponse.json({ status: 'RETIRED', cleanup });
}
