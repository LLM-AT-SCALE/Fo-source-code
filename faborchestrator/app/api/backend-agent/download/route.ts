import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { prisma } from '@/shared/lib/db';
import { buildUnit } from '@/modules/coding-agent/lib/unit';
import { recordBackendAudit, clientIp } from '@/modules/coding-agent/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Download the deployment unit for a conversation's generated page.
 *
 * Scoped to the owner: the run directory is keyed on the conversation id, so
 * without the ownership check a signed-in user could read another user's
 * generated artifacts by guessing an id.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(req.url);
  const conversationId = searchParams.get('conversationId') ?? '';
  const page = searchParams.get('page') ?? undefined;

  const owned = await prisma.conversation.findFirst({
    where: { id: conversationId, userId: auth.user.id, deletedAt: null },
    select: { id: true },
  });
  if (!owned) {
    return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
  }

  const unit = buildUnit(conversationId, page);
  if (!unit) {
    return NextResponse.json(
      { error: 'Nothing has been generated in this conversation yet.' },
      { status: 404 },
    );
  }

  /* Who took the artifacts, and when. The unit is what actually reaches a
     tenant, so the download is the moment worth recording. */
  void recordBackendAudit('DOWNLOAD', {
    userId: auth.user.id,
    conversationId,
    ip: clientIp(req),
    metadata: { filename: unit.filename, bytes: unit.bytes.length, page: page ?? null },
  });

  const safeName = unit.filename.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return new Response(new Uint8Array(unit.bytes), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Length': String(unit.bytes.length),
    },
  });
}
