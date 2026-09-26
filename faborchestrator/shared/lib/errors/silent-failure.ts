/**
 * Record a failure that would otherwise vanish into a console line.
 *
 * Some failures do not stop a turn but do degrade it, and those are the ones
 * that go unnoticed for months because nothing visibly breaks:
 *
 *  - the dashboard was built but never reached the client, so the answer talks
 *    about "the attached dashboard" that is not there;
 *  - the assistant's reply was never saved, so it is on screen now and gone
 *    when the conversation is reopened;
 *  - an attachment was not stored, so it cannot be referenced on a later turn.
 *
 * Every one of these used to be a `console.error` and nothing else. They are
 * invisible to the user, invisible to an admin, and absent from the error log.
 *
 * Where a stream writer is still open the failure is also shown to the user;
 * where it is not (a failure inside `onFinish`, after the response has closed)
 * the record is still written, so at least an admin can see it happened.
 */

import { FabOrchError } from './faborch-errors';
import { captureError } from './error-detail';
import { logger } from '../logger';

interface SilentFailureContext {
  /** Where in the turn it happened: 'persistAssistantMessage', … */
  stage: string;
  /** The system, named for a reader: 'Conversation storage', 'Dashboard rendering'. */
  system: string;
  userId?: string | null;
  route?: string;
  /** When the stream is still open, the failure is shown to the user too. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writer?: { write: (part: any) => void };
}

export function recordSilentFailure(error: unknown, ctx: SilentFailureContext): void {
  const fabErr = FabOrchError.lambdaMcpCrash(error, {
    route: ctx.route ?? '/api/chat',
    userId: ctx.userId ?? undefined,
    extra: { stage: ctx.stage, system: ctx.system },
  });

  const detail = captureError({
    errorId: fabErr.errorId,
    cause: error,
    type: fabErr.type,
    connector: ctx.system,
    toolName: ctx.stage,
  });

  logger.fabOrchError(fabErr, { route: ctx.route, userId: ctx.userId ?? undefined });

  import('./error-audit')
    .then((m) =>
      m.recordError(fabErr, {
        userId: ctx.userId ?? null,
        route: ctx.route ?? null,
        method: ctx.stage,
        technicalMessage: detail.message ?? null,
        stackPreview: detail.stack ?? null,
        requestContext: detail as unknown as Record<string, unknown>,
      }),
    )
    .catch(() => {});

  // Best effort — the stream may already be closed, which is exactly the case
  // the persisted record covers.
  if (ctx.writer) {
    try {
      ctx.writer.write({ type: 'data-errorDetail', data: detail });
    } catch {
      /* closed; the record is in the database */
    }
  }
}
