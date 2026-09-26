import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { prisma } from '@/shared/lib/db';
import { readState } from '@/modules/coding-agent/lib/state';
import { prdToDocx } from '@/modules/coding-agent/lib/prd-docx';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The PRD, as a Word document.
 *
 * Converted HERE rather than in the browser: the markdown on disk is the one the
 * tools wrote and the one the panel renders, so building the download from it
 * keeps the file the reader forwards and the document they were looking at the
 * same thing. A client-side conversion would be a second renderer, free to
 * disagree with the first.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const conversationId = new URL(req.url).searchParams.get('conversationId') ?? '';

  /* Scoped to the owner: the run directory is keyed on the conversation id, so
     without this a signed-in user could read another user's PRD by guessing. */
  const owned = await prisma.conversation.findFirst({
    where: { id: conversationId, userId: auth.user.id, deletedAt: null },
    select: { id: true },
  });
  if (!owned) {
    return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
  }

  const state = readState(conversationId);
  if (!state.prdMarkdown) {
    return NextResponse.json(
      { error: 'No PRD has been written in this conversation yet.' },
      { status: 404 },
    );
  }

  /* Named after the page it specifies, falling back to the requirement document
     — a folder of files all called `PRD.docx` helps nobody. */
  const base = state.primary?.name
    ?? state.storyName?.replace(/\.[^.]+$/, '')
    ?? 'PRD';
  const filename = `${base.replace(/[^A-Za-z0-9._-]+/g, '_')}-PRD.docx`;

  const bytes = await prdToDocx(state.prdMarkdown, base);

  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(bytes.length),
    },
  });
}
