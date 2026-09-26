/**
 * Whether a turn's answer was replaced by an Edit or Retry of its question.
 *
 * A turn keeps generating on the server after the user presses Stop (the model
 * stream is consumed to completion so usage is recorded) and then saves its
 * answer. That is right in general: after Stop — or Stop and a NEW question —
 * the answer the user saw stays in the conversation.
 *
 * The exception is an Edit or Retry. The resend clears every reply after the
 * question it resends (prepareResend), so an answer to THAT question or any
 * LATER one is replaced — and a stopped turn finishing afterwards must not
 * save its stale answer. An answer to an EARLIER question is untouched by that
 * resend and must still be saved.
 *
 * Each turn is identified by a number (order of arrival) and by the saved time
 * of the question it answers. A resend supersedes a turn when the resend
 * started later AND the resent question is the turn's question or an earlier
 * one.
 *
 * Scope: one server process. A resend served by a different instance than the
 * stopped turn is not covered; the stale answer then remains visible and
 * deletable, as before.
 */
let seq = 0;
/** Resends per conversation: which turn, and the saved time of the question it resent. */
const resends = new Map<string, Array<{ turn: number; questionAt: number }>>();

/** Number this request's turn. Numbers only grow. */
export function beginTurn(): number {
  seq += 1;
  return seq;
}

/**
 * This turn is an Edit/Retry of the question saved at `questionAt`.
 * Call BEFORE the old replies are deleted, so an answer saved during the
 * delete can see it (see isSuperseded).
 */
export function markResend(conversationId: string, turn: number, questionAt: number): void {
  const list = resends.get(conversationId) ?? [];
  list.push({ turn, questionAt });
  if (list.length > 20) list.shift();
  resends.set(conversationId, list);
  if (resends.size > 5000) {
    let n = 0;
    for (const k of resends.keys()) {
      resends.delete(k);
      if (++n >= 1000) break;
    }
  }
}

/**
 * True when an Edit/Retry that started after this turn resent this turn's
 * question or an earlier one — so this turn's answer was cleared and replaced.
 * Unknown question time → not superseded (keep the answer).
 */
export function isSuperseded(conversationId: string, turn: number, questionAt: number | undefined): boolean {
  if (questionAt === undefined) return false;
  return (resends.get(conversationId) ?? []).some((r) => r.turn > turn && r.questionAt <= questionAt);
}
