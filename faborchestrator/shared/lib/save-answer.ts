/**
 * Saving an assistant answer — the ONE place that decides whether, and where in
 * the conversation, an answer is stored. Every chat route saves through here.
 *
 * Why it needs deciding at all: a turn keeps running on the server after the
 * user presses Stop (the stream is consumed to completion so usage is
 * recorded) and saves its answer when it finishes — seconds later. By then the
 * user may have asked something else, retried, edited, or deleted the
 * question. Each of those used to go wrong in its own way; the rules below
 * cover all of them by construction rather than case by case.
 *
 *  1. AN ANSWER BELONGS TO ITS QUESTION. If the question no longer exists
 *     (the user deleted it — possibly the whole conversation with it), the
 *     answer is not saved: it would be an answer to nothing.
 *  2. AN ANSWER SITS RIGHT AFTER ITS QUESTION. History is ordered by saved
 *     time. A stopped answer that finishes after the user's NEXT question would
 *     sort after that question — so retrying or deleting the next question
 *     (which clears "everything after it") would wipe an answer that belongs
 *     to an earlier one, and a reload would show it in the wrong place. When
 *     anything newer than the question already exists, the answer is saved
 *     just after its question instead of "now".
 *  3. AN EDIT OR RETRY REPLACES THE OLD ANSWER. The resend clears the replies
 *     after the question; a stopped turn finishing later must not put its
 *     stale answer back (lib/turn-registry).
 *
 * Rules 1 and 3 are checked before AND after the insert, so a Delete or a
 * resend landing during the write is caught either by its own delete or by the
 * re-check here.
 */
import prisma from '@/shared/lib/db';
import type { Message } from '@/lib/generated/prisma/client';
import { isSuperseded } from '@/shared/lib/turn-registry';

/** The turn an answer belongs to. */
export interface TurnRef {
  conversationId: string;
  /** From beginTurn() — order of arrival. */
  seq: number;
  /** The stored question this turn answers, when it was stored. */
  questionId?: string;
  /** That question's saved time (ms). */
  questionAt?: number;
}

export interface AnswerInput {
  id?: string;
  content: string;
  parts?: unknown[];
  metadata?: Record<string, unknown>;
}

async function questionGone(turn: TurnRef): Promise<boolean> {
  if (!turn.questionId) return false; // nothing stored to check against
  const q = await prisma.message.findUnique({ where: { id: turn.questionId }, select: { id: true } });
  return q === null;
}

/** Save the answer for `turn`, or return null when it must not be saved. */
export async function saveTurnAnswer(turn: TurnRef, data: AnswerInput): Promise<Message | null> {
  const { conversationId } = turn;
  try {
    if (isSuperseded(conversationId, turn.seq, turn.questionAt)) return null; // rule 3
    if (await questionGone(turn)) return null; // rule 1

    // Rule 2: only a LATE answer is re-anchored; a normal one keeps its real time.
    let createdAt: Date | undefined;
    if (turn.questionAt !== undefined) {
      const newer = await prisma.message.findFirst({
        where: { conversationId, createdAt: { gt: new Date(turn.questionAt) } },
        select: { id: true },
      });
      if (newer) createdAt = new Date(turn.questionAt + 1);
    }

    const saved = await prisma.message.create({
      data: {
        ...(data.id ? { id: data.id } : {}),
        ...(createdAt ? { createdAt } : {}),
        conversationId,
        role: 'assistant',
        content: data.content,
        parts: (data.parts as object) ?? null,
        metadata: (data.metadata as object) ?? {},
      },
    });

    // Re-check: a Delete or an Edit/Retry may have landed during the insert.
    if (isSuperseded(conversationId, turn.seq, turn.questionAt) || (await questionGone(turn))) {
      await prisma.message.delete({ where: { id: saved.id } }).catch(() => {});
      return null;
    }

    prisma.conversation
      .update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } })
      .catch((err) => console.error('Error updating lastMessageAt:', err));
    return saved;
  } catch (error) {
    console.error('Error saving answer:', error);
    return null;
  }
}
