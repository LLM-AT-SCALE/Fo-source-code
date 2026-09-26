import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { prisma } from '@/shared/lib/db';
import { readState, specIsNewerThanArtifact } from '@/modules/coding-agent/lib/state';
import { unitContents } from '@/modules/coding-agent/lib/unit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The conversation's current work product, for the panel beside the chat.
 *
 * Read from the run directory rather than from the transcript: the PRD on disk
 * is the one the tools wrote, and the one the preview and the download are built
 * from. Reconstructing it from chat messages would let the panel and the
 * artifacts disagree.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(req.url);
  const conversationId = searchParams.get('conversationId') ?? '';

  const owned = await prisma.conversation.findFirst({
    where: { id: conversationId, userId: auth.user.id, deletedAt: null },
    select: { id: true },
  });
  if (!owned) {
    return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
  }

  const state = readState(conversationId);

  /* The unit's files, so the conversation can show what it produced even after a
     reload. Read from disk rather than from the transcript: the files ARE the
     deliverable, and a card reconstructed from chat text could disagree with
     what the download actually contains. */
  const unit = state.primary
    ? unitContents(state.primary.dir).map((f) => ({ name: f.name, chars: f.chars }))
    : [];

  return NextResponse.json({
    prd: state.prdMarkdown ?? null,
    document: state.storyName ?? null,
    hasArtifact: Boolean(state.primary),
    page: state.primary?.name ?? null,
    /* The validator's verdict travels with the artifact, so the panel badge and
       the sentence the model wrote in the transcript have one source. */
    verdict: state.primary?.verdict ?? null,
    unit,
    pages: state.artifacts.map((a) => a.name),
    /* The panel labels the screen honestly when the spec has moved past the
       artifact — the same rule the preview itself follows. */
    specNewerThanArtifact: specIsNewerThanArtifact(state),
  });
}
