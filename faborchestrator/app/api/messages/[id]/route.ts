/**
 * Message edit + delete.
 *
 * The UI has had Edit and Delete buttons on every user message since the first
 * commit, but no endpoint behind them — clicking did nothing. These are those
 * endpoints.
 *
 *   PATCH  /api/messages/[id]   edit a user message
 *   DELETE /api/messages/[id]   delete a message and its reply
 *
 * BOTH ARE TRUNCATING, and that is deliberate. A conversation is a chain: every
 * answer after a given message was produced in response to it. Editing message
 * 3 without removing 4..n leaves answers that reply to text that no longer
 * exists, and the next turn resends that contradictory history to the model.
 * So an edit drops everything after the edited message, and the client re-runs
 * from there. Delete does the same for the pair it removes.
 *
 * Ownership is enforced through the conversation, never from the request body.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/shared/lib/auth-middleware';
import prisma from '@/shared/lib/db';
import { handleApiError } from '@/shared/lib/errors/api-error-handler';
import { FabOrchError } from '@/shared/lib/errors/faborch-errors';
import { validateOrThrow } from '@/shared/lib/validation';
import { logger } from '@/shared/lib/logger';
import { deleteConversation } from '@/shared/lib/storage';
import { beginTurn, markResend } from '@/shared/lib/turn-registry';

const EditSchema = z.object({
  content: z.string().trim().min(1, 'Message cannot be empty').max(100_000),
});

/** Load the message and prove the caller owns the conversation it belongs to. */
async function loadOwned(messageId: string, userId: string) {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { conversation: { select: { id: true, userId: true } } },
  });
  if (!message) return { error: NextResponse.json({ error: 'Message not found' }, { status: 404 }) };
  if (message.conversation.userId !== userId) {
    // 404 rather than 403: do not confirm that someone else's message exists.
    return { error: NextResponse.json({ error: 'Message not found' }, { status: 404 }) };
  }
  return { message };
}

// ── PATCH — edit a user message ─────────────────────────────────────────────
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  try {
    const { id } = await params;
    const { message, error } = await loadOwned(id, user.id);
    if (error) return error;

    if (message.role !== 'user') {
      throw FabOrchError.invalidParameter('role', ['user'], undefined, {
        reason: 'Only your own messages can be edited.',
        badValue: message.role,
      });
    }

    const { content } = validateOrThrow(EditSchema, await req.json());

    // An edit replaces this question's answer. Register it BEFORE the delete,
    // like any resend (lib/turn-registry): a stopped turn still generating the
    // answer to the OLD text must not attach it to the edited question — even
    // if the client's follow-up send never arrives.
    markResend(message.conversationId, beginTurn(), message.createdAt.getTime());

    // Everything after this message answered the OLD text. Remove it in the
    // same transaction as the edit so the transcript is never inconsistent.
    const [, removed] = await prisma.$transaction([
      prisma.message.update({
        where: { id },
        data: {
          content,
          // Keep parts in step with content: a user turn's parts are the text
          // plus any attachments, and a stale text part would be re-sent to the
          // model on the next turn and silently override the edit.
          parts: rewriteTextPart(message.parts, content),
          editedAt: new Date(),
        },
      }),
      prisma.message.deleteMany({
        where: { conversationId: message.conversationId, createdAt: { gt: message.createdAt } },
      }),
    ]);

    logger.info('[Messages] user message edited', {
      route: '/api/messages/[id]',
      userId: user.id,
      messageId: id,
      removedAfter: removed.count,
    });

    return NextResponse.json({
      id,
      content,
      conversationId: message.conversationId,
      /** The client re-runs the turn when this is > 0. */
      removedAfter: removed.count,
    });
  } catch (err) {
    return handleApiError(err, req, { route: '/api/messages/[id]', userId: user.id });
  }
}

// ── DELETE — remove a message and the reply it produced ─────────────────────
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  try {
    const { id } = await params;
    const { message, error } = await loadOwned(id, user.id);
    if (error) return error;

    /*
     * Deleting a question leaves its answer dangling, which reads as the
     * assistant talking to itself and poisons the next turn's history. So a
     * user message takes the assistant turns that follow it (up to the next
     * user message) with it. Deleting an assistant message removes only that.
     */
    const ids = [id];
    if (message.role === 'user') {
      const after = await prisma.message.findMany({
        where: { conversationId: message.conversationId, createdAt: { gt: message.createdAt } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, role: true },
      });
      for (const m of after) {
        if (m.role === 'user') break; // next question — stop here
        ids.push(m.id);
      }
    }

    const removed = await prisma.message.deleteMany({ where: { id: { in: ids } } });

    /*
     * Deleting the last message leaves an empty conversation behind — a
     * sidebar entry titled after a question that no longer exists. Remove the
     * conversation too, the same way the sidebar's own Delete does.
     */
    const remaining = await prisma.message.count({ where: { conversationId: message.conversationId } });
    const conversationDeleted = remaining === 0 ? await deleteConversation(message.conversationId) : false;

    logger.info('[Messages] message deleted', {
      route: '/api/messages/[id]',
      userId: user.id,
      messageId: id,
      deletedCount: removed.count,
      conversationDeleted,
    });

    return NextResponse.json({
      deleted: ids,
      count: removed.count,
      conversationId: message.conversationId,
      /** True when that was the last message and the conversation was removed. */
      conversationDeleted,
    });
  } catch (err) {
    return handleApiError(err, req, { route: '/api/messages/[id]', userId: user.id });
  }
}

/**
 * Replace the text in a stored parts array, preserving file attachments and
 * any other part types. Returns undefined when there is nothing to rewrite, so
 * Prisma leaves the column untouched.
 */
function rewriteTextPart(parts: unknown, content: string): object | undefined {
  if (!Array.isArray(parts)) return undefined;
  let replaced = false;
  const next = parts.map((p) => {
    const part = p as { type?: string };
    if (!replaced && part?.type === 'text') {
      replaced = true;
      return { ...part, text: content };
    }
    return p;
  });
  if (!replaced) next.unshift({ type: 'text', text: content });
  return next as unknown as object;
}
