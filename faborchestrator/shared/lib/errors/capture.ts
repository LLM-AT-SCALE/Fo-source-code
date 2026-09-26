/**
 * One boundary for every outbound call the product makes.
 *
 * WHY THIS EXISTS
 * ---------------
 * MCP is only one of the ways this app reaches outside itself. It also talks
 * directly to the MES over SQL Server, to CMF over SQL and REST, to Postgres,
 * to S3 and to SMTP. Each of those had its own idea of what to do when a call
 * failed, and most of them had none: the FabInsight dashboards, for instance,
 * render EMPTY while still reporting status "ok" when the MES is unreachable,
 * so a user sees blank tiles and no explanation whatsoever.
 *
 * Rather than repeat the capture in eight places — and drift in eight
 * directions — every integration wraps its call in `withCapture`. It:
 *
 *   1. runs the call,
 *   2. on failure reads the REAL error object (see ./error-detail),
 *   3. writes the full record to error_audit_logs,
 *   4. rethrows a FabOrchError carrying that record, so the chat can render
 *      the same card it renders for an MCP failure.
 *
 * DESIGN RULE, same as the rest of this work: capture everything, invent
 * nothing. There is no list of known failures here. The only thing a caller
 * supplies is the NAME of the system being called, because "the MES did not
 * answer" is useful and "something went wrong" is not — and that name comes
 * from the caller, not from a lookup table in this file.
 */

import { FabOrchError, FabOrchErrorType } from './faborch-errors';
import { captureError, summarize, type ErrorDetail } from './error-detail';
import { logger } from '../logger';
import { currentErrorContext } from './run-context';

export interface CaptureContext {
  /**
   * The system being called, in the words a user would recognise —
   * "MES (Opcenter)", "CMF", "File storage", "Email". Appears in the failure
   * shown to the user, so it must name a thing they can act on, not a module.
   */
  system: string;
  /** What was being attempted: 'fabQuery', 'uploadAttachment', 'sendReport'. */
  operation: string;
  /** Who was doing it, when known — lets an admin filter the error list. */
  userId?: string | null;
  /** Where it was reached: a host, a URL, a bucket. Recorded, never guessed. */
  target?: string;
  /** Anything else worth having in the record (query shape, file name, …).
   *  Never put credentials here. */
  extra?: Record<string, unknown>;
  /**
   * The failure's category, when the caller KNOWS it. Otherwise it is inferred
   * from the error itself (network code, HTTP status) — and an error with
   * neither falls back to SQL_CALL_FAILURE ("cannot reach the data"), which is
   * wrong for a misconfigured alert or a crashed compile.
   */
  type?: FabOrchErrorType;
}

/** A FabOrchError that carries the captured record. */
export interface CapturedError extends FabOrchError {
  detail: ErrorDetail;
}

export function isCapturedError(e: unknown): e is CapturedError {
  return e instanceof FabOrchError && 'detail' in e;
}

/**
 * Choose the catalog category from what the error IS, not from a message
 * lookup. Only used to bucket the record for reporting — the text the user
 * reads always comes from the captured error itself.
 */
function categorise(detail: ErrorDetail): FabOrchErrorType {
  const code = detail.code ?? '';
  const status = detail.httpStatus;

  // Timeouts and aborts: the request never completed.
  if (
    detail.name === 'AbortError' ||
    detail.name === 'TimeoutError' ||
    code === 'ETIMEDOUT' ||
    code === 'ETIMEOUT' ||
    code === 'ESOCKETTIMEDOUT'
  ) {
    return FabOrchErrorType.RESPONSE_TIMEOUT;
  }

  // Rejected credentials or permissions.
  if (status === 401 || status === 403) return FabOrchErrorType.SESSION_TIMEOUT;

  // Anything that names a connection is a reachability problem, which for a
  // data source is a call failure.
  if (
    code.startsWith('ECONN') ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'EPIPE'
  ) {
    return FabOrchErrorType.SQL_CALL_FAILURE;
  }

  if (typeof status === 'number' && status >= 500) return FabOrchErrorType.LAMBDA_MCP_CRASH;
  if (status === 400) return FabOrchErrorType.INVALID_PARAMETER;

  return FabOrchErrorType.SQL_CALL_FAILURE;
}


/*
 * REPEAT SUPPRESSION FOR SCHEDULED FAILURES
 *
 * The report scheduler re-runs every dashboard every minute. When the MES is
 * unreachable that is ~13 identical failures a minute, and recording each one
 * turned the error log into a wall of the same sentence — real user failures
 * buried under a background job's heartbeat.
 *
 * So a failure that no user is waiting on (a scheduled job) is recorded once
 * per job, and identical repeats within the window are counted rather than
 * written. When the window lapses the next record carries how many were
 * suppressed, so the frequency is not lost — only the noise. User-facing
 * failures are never suppressed: each is a person who did not get an answer.
 */
const SUPPRESS_WINDOW_MS = Number(process.env.ERROR_REPEAT_WINDOW_MS ?? 15 * 60 * 1000);
const recent = new Map<string, { lastWrittenAt: number; suppressed: number }>();

/** One key per (job, system, operation, cause): each job's failure gets its own record. */
function repeatKey(ctx: CaptureContext, detail: ErrorDetail, job?: { kind: string; name: string }): string {
  // `target` too: two different requests or alerts failing the same way are
  // two facts and both deserve a record.
  return `${job?.kind ?? ''}::${job?.name ?? ''}::${ctx.system}::${ctx.operation}::${ctx.target ?? ''}::${(detail.message ?? '').slice(0, 200)}`;
}

/** Decide whether to write this scheduled failure; returns suppressed count to attach. */
function shouldRecord(key: string): { write: boolean; suppressed: number } {
  const now = Date.now();
  const r = recent.get(key);
  if (r && now - r.lastWrittenAt < SUPPRESS_WINDOW_MS) {
    r.suppressed += 1;
    return { write: false, suppressed: r.suppressed };
  }
  const suppressed = r?.suppressed ?? 0;
  recent.set(key, { lastWrittenAt: now, suppressed: 0 });
  // Bound the map so a long-running process cannot grow it without limit.
  if (recent.size > 500) {
    const oldest = [...recent.entries()].sort((a, b) => a[1].lastWrittenAt - b[1].lastWrittenAt)[0];
    if (oldest) recent.delete(oldest[0]);
  }
  return { write: true, suppressed };
}

/**
 * Who this failure belongs to. The caller's own userId wins; otherwise the
 * running job's context (see ./run-context) names the admin who configured
 * the job. A call with neither is a genuine background failure.
 */
function attribution(ctx: CaptureContext) {
  const run = currentErrorContext();
  const userId = ctx.userId ?? run?.userId ?? null;
  // Inside a scheduled job the failure IS scheduled, even when the caller names
  // an admin (the alert's creator, the approving admin) for attribution. Letting
  // an explicit userId make it 'user' switched repeat suppression off, so a
  // broken alert wrote a new row on every tick.
  const origin: 'user' | 'scheduled' | 'background' =
    run?.origin ?? (ctx.userId ? 'user' : 'background');
  return { userId, origin, job: run?.job };
}

/** Writes the record; returns false when it was a suppressed scheduled repeat. */
function persist(fabErr: FabOrchError, detail: ErrorDetail, ctx: CaptureContext): boolean {
  const { userId, origin, job } = attribution(ctx);

  let suppressedNote: Record<string, unknown> = {};
  // Suppress repeats ONLY for the scheduler's own heartbeat (origin 'scheduled',
  // set by lib/errors/run-context). A failure that merely has no logged-in user
  // — a dashboard the chat built, a warm-up ping — is a real request and is
  // ALWAYS written, exactly as it was before suppression existed. Conflating
  // "no user" with "background" is what dropped chat errors from the table.
  if (origin === 'scheduled') {
    const { write, suppressed } = shouldRecord(repeatKey(ctx, detail, job));
    if (!write) return false;
    if (suppressed > 0) suppressedNote = { repeatsSuppressedSinceLastRecord: suppressed };
  }

  // Fire-and-forget: a failure to record must never replace the real failure.
  import('./error-audit')
    .then((m) =>
      m.recordError(fabErr, {
        userId,
        route: ctx.target ?? null,
        method: ctx.operation,
        technicalMessage: detail.message ?? null,
        stackPreview: detail.stack ?? null,
        requestContext: {
          ...detail,
          system: ctx.system,
          // Say where the failure came from, so the list never shows a bare
          // dash and leaves the reader guessing. `job` is what the scheduler
          // knew when it ran — kind, instance, dashboard, configuring admin.
          origin,
          ...(job ? { job } : {}),
          ...suppressedNote,
        } as unknown as Record<string, unknown>,
      }),
    )
    .catch(() => {});
  return true;
}

/**
 * Run an outbound call with full failure capture.
 *
 * On success the value is returned untouched — this adds nothing to the happy
 * path but a try/catch. On failure the record is persisted and a
 * `CapturedError` is thrown, whose `detail` the chat renders directly.
 *
 * Callers that already handle their own failures can catch it; callers that
 * don't get a far better error than they had before simply by wrapping.
 */
/**
 * Record a failure that has ALREADY been caught — without throwing.
 *
 * For background work that must carry on after a failure (a scheduled refresh
 * keeps the last snapshot, an alert check moves to the next threshold) but
 * whose failure must still reach the error log with its real cause, under the
 * running job's attribution. Same record, same suppression, as withCapture.
 */
export function recordCaptured(ctx: CaptureContext, raw: unknown): CapturedError {
  if (isCapturedError(raw)) return raw;

  const detail = captureError({
    errorId: crypto.randomUUID(),
    cause: raw,
    connector: ctx.system,
    connectorUrl: ctx.target,
    toolName: ctx.operation,
    toolArgs: ctx.extra,
  });

  const type = ctx.type ?? categorise(detail);
  const fabErr = new FabOrchError(type, {
    cause: raw,
    context: {
      route: ctx.target,
      userId: attribution(ctx).userId ?? undefined,
      toolName: ctx.operation,
      extra: { system: ctx.system, ...ctx.extra },
    },
    // What the user reads: the real cause, named by system.
    messageOverride: summarize({ ...detail, type }),
  });
  // Keep the ids aligned so the record, the log line and the card all agree.
  (detail as { errorId: string }).errorId = fabErr.errorId;
  (fabErr as CapturedError).detail = detail;

  // A suppressed scheduled repeat is neither recorded nor logged: the same
  // line once a minute buried the server log exactly as it buried the table.
  if (persist(fabErr, detail, ctx)) {
    logger.fabOrchError(fabErr, {
      route: ctx.target,
      userId: attribution(ctx).userId ?? undefined,
      toolName: ctx.operation,
    });
  }
  return fabErr as CapturedError;
}

export async function withCapture<T>(ctx: CaptureContext, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (raw) {
    // Already captured deeper in the stack (nested withCapture) — don't
    // double-record or re-wrap; the innermost capture is the specific one.
    throw recordCaptured(ctx, raw);
  }
}

/**
 * Synchronous variant, for call sites that are not async.
 */
export function withCaptureSync<T>(ctx: CaptureContext, fn: () => T): T {
  try {
    return fn();
  } catch (raw) {
    // Same record, category (ctx.type), suppression and logging as the async path.
    throw recordCaptured(ctx, raw);
  }
}
