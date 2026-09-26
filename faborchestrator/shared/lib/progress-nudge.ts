/**
 * Progress updates during long tool-using turns.
 *
 * A turn that runs twenty or forty tool calls in silence feels frozen to the
 * user. This hook counts the tool calls made since the model last wrote to the
 * user and, once the budget is spent, slips a one-off instruction in front of
 * the next model call: write two or three sentences on what was found and what
 * comes next, then carry on. The instruction lives only in that model call; it
 * is never persisted and never shown.
 *
 * Wire it into streamText: `prepareStep` runs `messages` through
 * `nudge.messages(...)`, and `onStepFinish` calls `nudge.stepFinished(event)`.
 * `CHAT_PROGRESS_EVERY` (default 8) sets the budget; 0 turns it off.
 */
const DEFAULT_EVERY = 8;
const MIN_UPDATE_CHARS = 60;

export interface ProgressNudge {
  /** Append the update instruction when the budget is spent; else the same array. */
  messages<T>(messages: T[]): T[];
  /** Feed every finished step (its tool calls and any text it wrote). */
  stepFinished(event: { toolCalls?: unknown[]; text?: string } | undefined): void;
}

export function updateInstruction(calls: number): string {
  return (
    `Progress update needed: you have made ${calls} tool calls since you last wrote to the user. ` +
    'Before the next tool call, write two or three plain sentences for the user — what you have found so far and what you will do next — ' +
    'then continue the work in the same turn without waiting for a reply. Keep the final answer complete; this is only an interim note.'
  );
}

export function createProgressNudge(every = Number(process.env.CHAT_PROGRESS_EVERY ?? DEFAULT_EVERY)): ProgressNudge {
  let sinceUpdate = 0;
  return {
    messages<T>(messages: T[]): T[] {
      if (!(every > 0) || sinceUpdate < every) return messages;
      const calls = sinceUpdate;
      sinceUpdate = 0;
      return [...messages, { role: 'user', content: [{ type: 'text', text: updateInstruction(calls) }] } as unknown as T];
    },
    stepFinished(event) {
      const text = (event?.text ?? '').trim();
      if (text.length >= MIN_UPDATE_CHARS) sinceUpdate = 0;
      sinceUpdate += event?.toolCalls?.length ?? 0;
    },
  };
}
