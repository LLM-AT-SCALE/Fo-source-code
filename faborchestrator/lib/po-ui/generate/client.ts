/**
 * CLAUDE API CLIENT — the two call sites, and everything that can go wrong at them.
 *
 * Both calls stream. Artifacts run to ~50,000 characters and a non-streaming
 * request at that size hits the SDK's HTTP timeout; `.finalMessage()` gives us
 * the assembled response without handling individual events.
 *
 * Opus 5 can decline a request outright (`stop_reason: "refusal"`) with a normal
 * HTTP 200 and empty content. Code that reads content[0] without checking breaks
 * on that, so every read here goes through `textOf`.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ModelConfig } from "./config";
import type { PromptBlock } from "./prompt";
import { preflight, formatFindings } from "./schema-preflight";

/**
 * Fallback idle ceiling, used only when config carries no `streamIdleSeconds`.
 *
 * A number lives here as well as in `pipeline.json` for the same reason the
 * load order does: an unreadable or older config must not silently restore the
 * hang this exists to prevent.
 */
const DEFAULT_IDLE_SECONDS = 120;

/** beta flag for the `fallbacks: "default"` scalar form */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class ApiError extends Error {}

/**
 * A stream that stopped producing characters and never ended.
 *
 * Its own class because the generation loop RETRIES it. A stalled stream is not
 * a bad request and not a refusal — the same call usually succeeds — so it must
 * be distinguishable from the errors that should stop a run.
 */
export class StreamStalledError extends ApiError {
  readonly afterChars: number;
  readonly idleSeconds: number;
  constructor(afterChars: number, idleSeconds: number) {
    super(
      `the model stream produced nothing for ${idleSeconds}s after ` +
      `${afterChars} character(s) and was abandoned`,
    );
    this.afterChars = afterChars;
    this.idleSeconds = idleSeconds;
  }
}
export class RefusalError extends ApiError {
  readonly category: string | null;
  readonly explanation: string | null;
  constructor(category: string | null, explanation: string | null) {
    super(
      `Claude declined this request (category: ${category ?? "unspecified"})` +
      (explanation ? ` — ${explanation}` : ""),
    );
    this.category = category;
    this.explanation = explanation;
  }
}

export function makeClient(): Anthropic {
  // No apiKey argument: the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
  // or an `ant auth login` profile, in that order.
  return new Anthropic();
}

export interface CallInput {
  client: Anthropic;
  model: ModelConfig;
  system: PromptBlock[];
  user: string;
  effort: string;
  /** JSON Schema for a structured response, when the shape is known up front */
  schema?: unknown;
  onProgress?: (chars: number) => void;
  /**
   * The streamed text itself, not just how much of it there is.
   *
   * `onProgress` reports a running character count, which is all a CLI needs to
   * draw "streaming… 12000 chars". The browser wants the artifact as it is
   * written, so this hands over each delta.
   *
   * Optional and unused by every existing caller, so nothing changes for the
   * CLI paths or for the offline replay in test:pipeline.
   */
  onText?: (delta: string) => void;
}

export interface CallResult {
  text: string;
  usage: {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
  };
  model: string;
  stopReason: string | null;
  /**
   * Wall-clock for this call, milliseconds.
   *
   * Added 2026-08-24: the pipeline reported tokens on every call and time on
   * none, so "generation is slow" could not be attributed to a step, to effort,
   * or to the retry loop. Optimising an unmeasured cost is guessing.
   */
  ms: number;
  /** Time to the FIRST streamed character — what a user actually waits for. */
  firstTokenMs: number | null;
}

/** Pull the text out of a response, refusing to guess when there is none. */
function textOf(msg: Anthropic.Message): string {
  const parts = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text);
  if (parts.length === 0) {
    throw new ApiError(
      `the response carried no text block (stop_reason: ${msg.stop_reason}). ` +
      `This usually means max_tokens was reached during thinking, or the ` +
      `request was declined.`,
    );
  }
  return parts.join("");
}

/**
 * Drop `pattern` from a schema on its way to structured output.
 *
 * 2026-08-27 — `autoRefreshInterval` (added 2026-08-26) carries an ISO 8601
 * regex with two lookaheads, `(?!$)` and `(?=\d)`, guarding the degenerate `P`
 * and `PT`. The structured-output validator's regex engine has no lookahead and
 * rejects the whole request:
 *
 *     output_config.format.schema: Invalid regex in pattern field:
 *     Quantifier '?' without preceding element
 *
 * So every `--story` run failed at call 1 for a day while the chat flow kept
 * working — it sends the same schema as a tool `input_schema`, a validator that
 * does accept lookahead. That asymmetry is why nothing caught it.
 *
 * Stripped HERE, at the one point where a schema goes on the wire, rather than
 * at each call site: `extractDescriptor` and `reviseDescriptor` both send this
 * schema and both were broken, and the next one to send it should not have to
 * know. Nothing is lost — zod runs on the reply regardless and is the contract
 * we actually trust; its message names the exact field. Rewriting the regex
 * lookahead-free was the alternative and it would have traded a correct
 * validator for one that merely survives a stricter parser.
 */
function withoutPatterns(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutPatterns);
  if (node === null || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node as Record<string, unknown>)
      .filter(([k]) => k !== "pattern")
      .map(([k, v]) => [k, withoutPatterns(v)]),
  );
}

export async function call(input: CallInput): Promise<CallResult> {
  const { client, model } = input;
  const started = Date.now();
  let firstToken: number | null = null;

  /*
   * PREFLIGHT — fail here, with the reason, rather than on a 400.
   *
   * Run on the schema as SENT (patterns already stripped), because that is what
   * the validator sees. Three separate rejections shipped green on 2026-08-27,
   * each killing a whole code path and each reported to the user as an opaque
   * API error with a stack trace. The rules are in `schema-preflight.ts`, taken
   * from those failures and from nothing else.
   *
   * Errors only. Size is a warning there — we have two data points and no
   * threshold — and warnings must not stop a call that would have worked.
   */
  const wireSchema = input.schema === undefined ? undefined : withoutPatterns(input.schema);
  if (wireSchema !== undefined) {
    const bad = preflight(wireSchema).filter((f) => f.level === "error");
    if (bad.length) {
      throw new ApiError(
        `this request's output schema is one the API will reject, so it was not ` +
        `sent:\n${formatFindings(bad)}`,
      );
    }
  }

  const body: Record<string, unknown> = {
    model: model.id,
    max_tokens: model.maxTokens,
    thinking: { type: "adaptive" },
    output_config: input.schema
      ? { effort: input.effort, format: { type: "json_schema", schema: wireSchema } }
      : { effort: input.effort },
    system: input.system,
    messages: [{ role: "user", content: input.user }],
  };

  const attempt = async (withFallback: boolean): Promise<Anthropic.Message> => {
    const params = withFallback
      ? { ...body, fallbacks: "default", betas: [FALLBACK_BETA] }
      : body;
    const api = withFallback ? client.beta.messages : client.messages;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = (api as any).stream(params);
    let seen = 0;

    /*
     * THE IDLE WATCHDOG — the only thing standing between a stalled stream and
     * a request that never returns.
     *
     * Armed BEFORE the first token, so the wait for the first character is
     * bounded too, and rearmed on every character, so a long generation is never
     * cut short while it is still producing. On expiry the stream is aborted,
     * which makes `finalMessage()` reject — and `stalled` tells the catch below
     * that the rejection is ours rather than the API's.
     */
    const idleSeconds = model.streamIdleSeconds ?? DEFAULT_IDLE_SECONDS;
    const idleMs = idleSeconds > 0 ? idleSeconds * 1000 : 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stalled = false;
    const rearm = (): void => {
      if (!idleMs) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        /* Abort rather than throw: the socket is what is holding the request
           open, and leaving it dangling would leak it for the process's life. */
        try { stream.abort(); } catch { /* already closed — nothing to abort */ }
      }, idleMs);
    };

    // Always subscribe: the first-token timestamp is needed whether or not a
    // caller wants progress, and it is the number that decides whether slowness
    // is the model thinking or us waiting for a whole document.
    stream.on("text", (delta: string) => {
      if (firstToken === null) firstToken = Date.now() - started;
      seen += delta.length;
      rearm();
      input.onProgress?.(seen);
      input.onText?.(delta);
    });

    rearm();
    try {
      return (await stream.finalMessage()) as Anthropic.Message;
    } catch (e) {
      /* Reported as what it is. Without this the abort surfaces as a generic
         "terminated"/"aborted" and reads like a network fault, which sends the
         next person debugging the wrong layer. */
      if (stalled) throw new StreamStalledError(seen, idleSeconds);
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  let msg: Anthropic.Message;
  try {
    msg = await attempt(model.serverSideFallback);
  } catch (e) {
    // The account may not have the fallback beta. That is not a reason to fail
    // the run — retry once without it and carry on.
    if (model.serverSideFallback && isBetaRejection(e)) {
      process.stderr.write(
        "  note: server-side fallback beta unavailable on this account — " +
        "continuing without it\n",
      );
      msg = await attempt(false);
    } else {
      throw e;
    }
  }

  if (msg.stop_reason === "refusal") {
    /*
     * Read defensively rather than off the typed field.
     *
     * FabOrchestrator pins `@anthropic-ai/sdk` at ^0.78, which predates
     * `stop_details` in the `Message` typings; the standalone app was on ^0.115,
     * where it is declared. The FIELD is on the wire either way — this is a
     * typings gap, not an API difference — and bumping the host application's
     * SDK to satisfy one optional property would change the version every other
     * FO feature runs on. Narrow cast here, no dependency churn there.
     */
    const d = (msg as { stop_details?: { category?: string; explanation?: string } | null })
      .stop_details ?? null;
    throw new RefusalError(d?.category ?? null, d?.explanation ?? null);
  }
  if (msg.stop_reason === "max_tokens") {
    throw new ApiError(
      `the response hit max_tokens (${model.maxTokens}) and is truncated. ` +
      `Raise model.maxTokens in pipeline.json, or lower generateEffort.`,
    );
  }

  const u = msg.usage;
  return {
    text: textOf(msg),
    usage: {
      input: u.input_tokens,
      output: u.output_tokens,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
    },
    model: msg.model,
    stopReason: msg.stop_reason,
    ms: Date.now() - started,
    firstTokenMs: firstToken,
  };
}

function isBetaRejection(e: unknown): boolean {
  if (!(e instanceof Anthropic.APIError)) return false;
  if (e.status !== 400 && e.status !== 403) return false;
  const m = String(e.message).toLowerCase();
  return m.includes("beta") || m.includes("fallback");
}

/** Seconds to one decimal — the unit a human reads a run in. */
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export function usageLine(r: CallResult): string {
  const { input, output, cacheWrite, cacheRead } = r.usage;
  const cached = cacheRead > 0 ? `, ${cacheRead} cached` : cacheWrite > 0 ? `, ${cacheWrite} cache-write` : "";
  /*
   * Time, and TIME TO FIRST TOKEN, on every call.
   *
   * The split is the diagnostic: a long ttft with a short tail is the model
   * thinking, which effort controls. A short ttft with a long tail is output
   * volume, which effort does not fix. Reporting one total number cannot tell
   * those apart, and they have opposite remedies.
   */
  const t = r.firstTokenMs !== null
    ? `${secs(r.ms)} (first token ${secs(r.firstTokenMs)})`
    : secs(r.ms);
  return `${input} in / ${output} out${cached}  ${t}  [${r.model}]`;
}
