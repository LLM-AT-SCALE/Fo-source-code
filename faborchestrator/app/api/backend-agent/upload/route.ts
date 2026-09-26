import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { prisma } from '@/shared/lib/db';
import { documentText, DocumentError } from '@/lib/po-ui/docx';
import { saveStory } from '@/modules/coding-agent/lib/tools';
import { runPreValidation } from '@/modules/coding-agent/lib/prevalidation';
import { handleApiError } from '@/shared/lib/errors/api-error-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Word documents only — the requirement always arrives as one. */
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Attach the requirement document to a conversation.
 *
 * The text is extracted HERE, on the server, and stored beside the run it will
 * produce — not held in the browser and not re-sent with every turn. Two reasons:
 * the extractor also reads `word/comments.xml`, where a reviewer's accepted
 * decisions live and which the visible body text does not contain; and a
 * document the model never re-reads cannot drift between turns.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  const conversationId = String(form?.get('conversationId') ?? '');

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file was attached.' }, { status: 400 });
  }
  if (!conversationId) {
    return NextResponse.json({ error: 'No conversation was named.' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `That document is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 25 MB.` },
      { status: 413 },
    );
  }

  /* The conversation must belong to the caller. Without this check any signed-in
     user could write a requirement document into someone else's run directory. */
  const owned = await prisma.conversation.findFirst({
    where: { id: conversationId, userId: auth.user.id, deletedAt: null },
    select: { id: true },
  });
  if (!owned) {
    return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const text = documentText(file.name, bytes);
    saveStory(conversationId, text, file.name);

    /*
     * PRE-VALIDATION STARTS HERE AND IS NOT AWAITED.
     *
     * It needs a descriptor, and a descriptor needs a model call. This route
     * returns in ~200ms on purpose — the attachment appears in the transcript
     * before any network call finishes — so awaiting an extraction would undo
     * that for the sake of a panel the engineer has not opened yet.
     *
     * The result lands in `PREVALIDATION.json` in the run directory and the UI
     * polls for it. `runPreValidation` writes its own failures into that file
     * rather than throwing, so this cannot produce an unhandled rejection.
     */
    void runPreValidation(conversationId, text, file.name);

    return NextResponse.json({ name: file.name });
  } catch (e) {
    // A DocumentError already explains itself in the user's terms (wrong
    // format, unreadable section) — keep it, but record it.
    // A DocumentError already explains itself in the user's terms (wrong
    // format, unreadable section), so keep its wording.
    if (e instanceof DocumentError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    /*
     * Anything else was being replaced by "That document could not be read."
     * — which is the same sentence whether the file was corrupt, too large,
     * or the disk was full, and left no record at all.
     */
    return handleApiError(e, req, {
      route: '/api/backend-agent/upload',
      userId: auth.user.id,
    });
  }
}
