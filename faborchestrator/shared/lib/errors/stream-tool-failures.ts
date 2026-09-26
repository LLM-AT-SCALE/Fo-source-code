/**
 * Turn a turn's failed tool calls into `data-errorDetail` stream parts.
 *
 * Shared by all three chat routes so the Fab chat, the Modeling Agent and the
 * Coding Agent report failures identically. Written once because three copies
 * would drift, and the difference would show up as "why does this agent
 * explain errors differently from that one?".
 *
 * It handles BOTH shapes a failed tool can produce, which matters because the
 * three agents' tool belts are written differently:
 *
 *  1. A tool that CATCHES its own failure and returns `{ errorDetail, … }` —
 *     the MCP tools and the CMF tool belt do this, and the record is already
 *     complete.
 *  2. A tool that THROWS — the Coding Agent's tools mostly do. The AI SDK
 *     converts the throw into an error result, and all that survives is text.
 *     We capture that text rather than let the failure pass unrecorded.
 *
 * Case 2 is the reason this is not a three-line loop: without it, an agent
 * whose tools throw would silently report nothing, and the gap would only be
 * noticed when someone asked why a failure never appeared in the error log.
 */

import { captureError } from './error-detail';
import { FabOrchError } from './faborch-errors';
import { logger } from '../logger';

/** Minimal shape of what we read off a finished step. */
interface StepLike {
  /** Every part the step produced — the only place a `tool-error` appears. */
  content?: ReadonlyArray<unknown>;
  toolResults?: Array<Record<string, unknown>>;
  toolCalls?: Array<Record<string, unknown>>;
}

/** Readable text for whatever a `tool-error` part carries as its error. */
function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * The step's tool outcomes — successes AND failures.
 *
 * In AI SDK v6 `step.toolResults` holds only `tool-result` parts. A tool that
 * THROWS, or is called with input that fails its schema, produces a separate
 * `tool-error` part that exists only in `step.content`. Reading `toolResults`
 * alone therefore dropped exactly the failures with no other trace: no card,
 * no record, and — when the throw ended the turn — no answer either. Each
 * `tool-error` is normalised here into the error-output shape the rest of
 * this file already understands.
 */
function outcomesOf(step: StepLike): Array<Record<string, unknown>> {
  if (!Array.isArray(step.content)) return step.toolResults ?? [];
  const out: Array<Record<string, unknown>> = [];
  for (const raw of step.content) {
    const part = raw as Record<string, unknown> | null;
    if (part?.type === 'tool-result') out.push(part);
    else if (part?.type === 'tool-error') {
      out.push({
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        isError: true,
        output: { type: 'error-text', value: errorMessageOf(part.error) },
      });
    }
  }
  return out;
}

/**
 * Just the part of the stream writer we need.
 *
 * Loosely typed on purpose: the AI SDK's `UIMessageStreamWriter` is generic
 * over the message's data types, and a custom part like `data-errorDetail` is
 * not in its union. Narrowing to "something with a write method" keeps this
 * helper usable from all three routes without each one casting.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WriterLike = { write: (part: any) => void };

/** The error text the AI SDK puts on a failed tool result, whatever the shape. */
function errorTextOf(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  const o = output as Record<string, unknown>;

  // AI SDK v6 error outputs.
  if (o.type === 'error-text' && typeof o.value === 'string') return o.value;
  if (o.type === 'error-json') {
    try {
      return JSON.stringify(o.value);
    } catch {
      return String(o.value);
    }
  }
  // Tools that return a plain `{ error }` without a detail.
  if (typeof o.error === 'string' && o.error.trim()) return o.error;
  // Tools that use the `{ status: 'error', message }` convention (the
  // dashboard tools do). Shape-based, like everything else here.
  if (o.status === 'error' && typeof o.message === 'string' && o.message.trim()) return o.message;
  return null;
}

/**
 * Emit one part per distinct failure in this turn.
 *
 * Deduped by errorId, because a model that retries a failing tool produces the
 * same failure in several steps and the user should see it once.
 *
 * Returns the ids emitted, so the caller can log how many failures a turn
 * actually produced.
 */
export function streamToolFailures(
  steps: StepLike[] | undefined,
  writer: WriterLike,
  ctx: { system?: string; userId?: string | null; route?: string } = {},
): string[] {
  if (!steps?.length) return [];
  const seen = new Set<string>();
  const seenCauses = new Set<string>();

  /*
   * Which tools SUCCEEDED, and at which step. A failure followed by a success
   * of the same tool later in the turn is one the model recovered from — the
   * answer is complete — and is rendered as a quiet note rather than a
   * warning. The failure is still recorded; only its presentation changes.
   */
  const lastSuccessStep = new Map<string, number>();
  steps.forEach((step, idx) => {
    for (const tr of outcomesOf(step)) {
      const name = typeof tr.toolName === 'string' ? tr.toolName : undefined;
      if (!name) continue;
      const out = tr.output ?? tr.result;
      const o = out as Record<string, unknown> | undefined;
      const failed =
        tr.isError === true ||
        o?.isError === true ||
        o?.status === 'error' ||
        o?.type === 'error-text' ||
        o?.type === 'error-json' ||
        (o as { errorDetail?: unknown } | undefined)?.errorDetail !== undefined;
      if (!failed) lastSuccessStep.set(name, idx);
    }
  });
  const recoveredAt = (toolName: string | undefined, stepIdx: number) =>
    toolName !== undefined && (lastSuccessStep.get(toolName) ?? -1) > stepIdx;

  for (const [stepIdx, step] of steps.entries()) {
    for (const tr of outcomesOf(step)) {
      const output = tr.output ?? tr.result;
      const toolName = typeof tr.toolName === 'string' ? tr.toolName : undefined;
      const recovered = recoveredAt(toolName, stepIdx);

      // ── 1. The tool already captured its own failure ──────────────────
      const carried = (output as { errorDetail?: Record<string, unknown> } | undefined)?.errorDetail;
      if (carried && typeof carried === 'object') {
        const id = (carried as { errorId?: string }).errorId;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        safeWrite(writer, recovered ? { ...carried, recovered: true } : carried);
        continue;
      }

      // ── 2. The tool threw; only text survived ─────────────────────────
      const isErrored =
        tr.isError === true ||
        (output as { isError?: boolean } | undefined)?.isError === true ||
        (output as { status?: string } | undefined)?.status === 'error' ||
        (output as { type?: string } | undefined)?.type === 'error-text' ||
        (output as { type?: string } | undefined)?.type === 'error-json';
      if (!isErrored) continue;

      const text = errorTextOf(output);
      if (!text) continue;

      // One fault, one card and one record: a model retrying a tool that keeps
      // failing the same way produces the same text each time. Keyed by the
      // cause — a fresh error id per occurrence could never match.
      const causeKey = `${toolName ?? ''}::${text.slice(0, 300)}`;
      if (seenCauses.has(causeKey)) continue;
      seenCauses.add(causeKey);

      // The error FIRST, so the card carries the id the record is stored
      // under. A separate random id for the card meant its "View error
      // details" link pointed at a record that did not exist.
      const fabErr = FabOrchError.lambdaMcpCrash(new Error(text), { toolName, route: ctx.route });
      const detail = captureError({
        errorId: fabErr.errorId,
        cause: new Error(text),
        connector: ctx.system,
        toolName,
      });
      if (recovered) detail.recovered = true;
      if (seen.has(detail.errorId)) continue;
      seen.add(detail.errorId);

      // Record it — a thrown tool error previously left no trace at all.
      import('./error-audit')
        .then((m) =>
          m.recordError(fabErr, {
            userId: ctx.userId ?? null,
            route: ctx.route ?? null,
            method: 'TOOL',
            technicalMessage: detail.message ?? null,
            requestContext: detail as unknown as Record<string, unknown>,
          }),
        )
        .catch(() => {});

      safeWrite(writer, detail);
    }
  }

  if (seen.size > 0) {
    logger.warn('[chat] tool failures surfaced to the user', {
      route: ctx.route,
      userId: ctx.userId ?? undefined,
      count: seen.size,
      errorIds: [...seen],
    });
  }
  return [...seen];
}

function safeWrite(writer: WriterLike, data: unknown) {
  try {
    writer.write({ type: 'data-errorDetail', data });
  } catch {
    /* stream already closed — the record is in the database regardless */
  }
}
