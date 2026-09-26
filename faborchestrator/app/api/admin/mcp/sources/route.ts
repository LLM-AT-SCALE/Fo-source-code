/**
 * On-the-Fly MCP — list data sources (control-plane lifecycle view).
 * GET → all data sources with non-secret fields only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/shared/lib/auth-middleware';
import prisma from '@/shared/lib/db';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const sources = await prisma.mcpDataSource.findMany({ orderBy: { createdAt: 'desc' } });
  return NextResponse.json({
    sources: sources.map((s) => ({
      id: s.id,
      name: s.name,
      engine: s.engine,
      status: s.status,
      host: s.host,
      port: s.port,
      database: s.database,
      schemas: s.schemasJson,
      hasSecret: !!s.secretArn,
      endpointUrl: s.endpointUrl,
      registryId: s.registryId,
      lastError: s.lastError,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
  });
}
