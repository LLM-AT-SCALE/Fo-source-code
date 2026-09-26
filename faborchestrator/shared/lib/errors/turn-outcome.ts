/**
 * Why a chat turn ended without a complete answer.
 *
 * A turn can finish "successfully" — no exception, stream closed normally —
 * and still leave the user with nothing usable. Three ways it happens, each
 * with a different fix, and none of which used to say anything:
 *
 *  1. STEP LIMIT. The model is still gathering data ("Let me pull the count.")
 *     when the per-turn tool-step cap stops the loop. The last visible line is
 *     a promise of work that never comes.
 *  2. LENGTH. The reply hits the output-token limit mid-sentence — or, with
 *     thinking on, spends the whole budget reasoning and writes nothing.
 *  3. FILTER / EMPTY. A content filter stops the reply, or the model ends its
 *     turn without writing any text at all.
 *
 * The cause is read from what the SDK reports for the final step
 * (`finishReason`, the step count), never inferred from the prose. A turn that
 * ends on an ask_user question has no text by design and is NOT a failure.
 */

interface StepLike {
  text?: string;
  finishReason?: string;
  content?: ReadonlyArray<unknown>;
}

/** True when the step put an ask_user question on screen. */
function showedAskUser(step: StepLike | undefined): boolean {
  return !!step?.content?.some((raw) => {
    const p = raw as { type?: unknown; toolName?: unknown } | null;
    return p?.type === 'tool-result' && p.toolName === 'ask_user';
  });
}

/**
 * Stop condition for the tool loop: end the turn once an ask_user question
 * has been shown. A malformed ask_user call errors instead of producing a
 * result, and the model is left to correct it rather than the turn ending on
 * nothing.
 */
export function askUserShown({ steps }: { steps: StepLike[] }): boolean {
  return showedAskUser(steps[steps.length - 1]);
}

export interface IncompleteTurn {
  /** Machine-readable stage for the error record. */
  stage: 'stepLimit' | 'outputLength' | 'contentFilter' | 'emptyAnswer';
  /** The true cause, written for the person reading the chat. */
  message: string;
}

export function diagnoseTurnEnd(opts: {
  steps: StepLike[] | undefined;
  maxSteps: number;
  maxOutputTokens: number;
  /** Failures already shown this turn — an empty answer they explain needs no second card. */
  failuresShown: number;
  /** Files produced this turn — a turn whose answer IS a file has no text by design. */
  filesProduced: number;
}): IncompleteTurn | null {
  const steps = opts.steps ?? [];
  const last = steps[steps.length - 1];
  if (!last) return null;
  if (showedAskUser(last)) return null;

  const text = steps.map((s) => s.text ?? '').join('').trim();
  const reason = last.finishReason;

  if (steps.length >= opts.maxSteps && reason === 'tool-calls') {
    return {
      stage: 'stepLimit',
      message:
        `The answer was cut off: the assistant used all ${opts.maxSteps} tool steps allowed in one reply ` +
        `while it was still gathering data, so it never wrote its final answer. ` +
        `Reply "continue" to let it carry on, or ask a narrower question.`,
    };
  }

  if (reason === 'length') {
    return {
      stage: 'outputLength',
      message: text
        ? `The answer was cut off: it reached the maximum reply length (${opts.maxOutputTokens.toLocaleString('en-US')} tokens) before it finished. Reply "continue" for the rest.`
        : `No answer was written: the reply reached its maximum length (${opts.maxOutputTokens.toLocaleString('en-US')} tokens) before any text was produced.`,
    };
  }

  if (reason === 'content-filter') {
    return {
      stage: 'contentFilter',
      message: "The model's content filter stopped this reply before it was complete.",
    };
  }

  // 'error' is reported by the stream's own error path, with the real cause.
  if (!text && reason !== 'error' && opts.failuresShown === 0 && opts.filesProduced === 0) {
    return {
      stage: 'emptyAnswer',
      message: `The assistant ended its turn without writing an answer (finish reason: ${reason ?? 'unknown'}). Try asking again.`,
    };
  }

  return null;
}
