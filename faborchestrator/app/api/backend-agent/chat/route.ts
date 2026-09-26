import { createProgressNudge } from '@/shared/lib/progress-nudge';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from 'ai';
import { anthropic } from '@/shared/lib/anthropic';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { addMessage, clientMessageId, prepareResend } from '@/shared/lib/storage';
import { beginTurn, markResend } from '@/shared/lib/turn-registry';
import { saveTurnAnswer } from '@/shared/lib/save-answer';
import { prisma } from '@/shared/lib/db';
import { logger } from '@/shared/lib/logger';
import { FabOrchError } from '@/shared/lib/errors/faborch-errors';
import { captureError, summarize as summarizeError } from '@/shared/lib/errors/error-detail';
import { ConfigError, loadPipelineConfig, type PipelineConfig } from '@/lib/po-ui/generate/config';
import {
  explainPackageFailure,
  loadAgentConfig,
  type EvidenceStatus,
} from '@/modules/coding-agent/lib/evidence';
import { makeClient } from '@/lib/po-ui/generate/client';
import { buildBackendAgentTools } from '@/modules/coding-agent/lib/tools';
import { chatSystem } from '@/modules/coding-agent/lib/system-prompt';
import { readState } from '@/modules/coding-agent/lib/state';
import { clientIp } from '@/modules/coding-agent/lib/audit';
import { canUseBackendAgent, requiresPermission, DENIED_MESSAGE } from '@/modules/coding-agent/lib/access';
import {
  recordPromptStart,
  recordPromptSuccess,
  recordPromptFailure,
  CODING_AGENT_TOPIC,
  type PromptStartHandle,
  type ToolCallSummary,
} from '@/shared/lib/prompt-audit';
import {
  costForTurn,
  costForTurnWithRates,
  hasPricing,
  type ModelRates,
} from '@/shared/lib/model-pricing';
import { getRegistryRates } from '@/shared/lib/model-registry';
import { streamToolFailures } from '@/shared/lib/errors/stream-tool-failures';
import { recordSilentFailure } from '@/shared/lib/errors/silent-failure';
import { isPlatformAdmin } from '@/shared/lib/permissions';

export const runtime = 'nodejs';

/**
 * Generation is slow ON PURPOSE — the pipeline makes several model calls and
 * revalidates between them, and the standalone app measured full runs at four to
 * six minutes. The default Next timeout would cut them off partway, leaving a
 * half-written run directory.
 */
export const maxDuration = 800;

/**
 * THE SAME MODEL THE PIPELINE USES, read from `pipeline.json`.
 *
 * This was hard-coded to FabOrchestrator's own default, which split the agent in
 * two: the CONVERSATION ran on one model while GENERATION ran on whatever
 * `pipeline.json` names. That is not a cosmetic difference — the intake model is
 * the one that decides what the document leaves open and what to ask about, and
 * on the same requirement document the two answered differently: the pipeline's
 * model asked which query to ship and whether the filters were optional; the
 * other reported "nothing is blocking" and offered to proceed.
 *
 * One source of truth, so the agent cannot be quietly reconfigured by editing
 * only half of it. The env var still overrides, for a deliberate experiment.
 */
function conversationModel(): string {
  const configured = process.env.BACKEND_AGENT_MODEL;
  if (configured) return configured;
  try {
    return loadPipelineConfig().model.id;
  } catch {
    return 'claude-opus-5';
  }
}
const MAX_OUTPUT_TOKENS = Number(process.env.BACKEND_AGENT_MAX_TOKENS ?? '8192');

/**
 * The pipeline's config and the prompt package, or the reason there is none.
 *
 * Both used to be built bare in the handler. On a checkout without the client's
 * `samples/` the package reader threw `ENOENT` and the browser got a 500 with
 * an EMPTY body — no sentence, no folder name, nothing to act on. The package
 * is now built from what is on disk (`loadAgentConfig`), and the one failure
 * that remains — no example page at all, or an unreadable `pipeline.json` — is
 * answered in words, naming the folder and the variable that fix it.
 *
 * The system prompt carries the PACKAGE — the rules, the harvested CMF
 * dictionary, the delivered sample pages. It is large and stable, which is
 * exactly what prompt caching is for; `chatSystem` marks the breakpoints.
 * Flattened to text here because the AI SDK takes a single system string.
 */
function prepareAgent(
  userId: string,
): { cfg: PipelineConfig; evidence: EvidenceStatus; system: string } | NextResponse {
  let evidence: EvidenceStatus | undefined;
  try {
    const loaded = loadAgentConfig();
    evidence = loaded.evidence;
    const system = chatSystem(loaded.cfg).map((b) => b.text).join('\n\n');
    return { cfg: loaded.cfg, evidence, system };
  } catch (e) {
    const message = e instanceof ConfigError
      ? `The Coding Agent's pipeline configuration could not be read: ${e.message}`
      : explainPackageFailure(e, evidence);
    logger.fabOrchError(e, { route: '/api/backend-agent/chat', userId, message });
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
const MAX_STEPS = Number(process.env.BACKEND_AGENT_MAX_STEPS ?? '12');

/**
 * Back-end Agent — requirement document to validated CMF artifacts.
 *
 * Ported from the standalone PO UI Generation app: the MODEL reads the
 * requirement, asks what the document leaves open and writes the specification;
 * OUR CODE turns that specification into the page, its queries and the
 * master-data unit deterministically, then validates the result against the
 * client's own delivered corpus. The model never writes XML.
 *
 * Rebuilt on this application's auth (bearer session), chat persistence
 * (Conversation/Message, agent="backend") and Anthropic provider, exactly as the
 * Modeling Agent was.
 *
 * OPEN TO EVERY SIGNED-IN USER while the agent is being evaluated — unlike the
 * Modeling Agent, which is default-deny. Set BACKEND_AGENT_REQUIRE_PERMISSION=1
 * to switch on the `backend_agent` role check; see `lib/po-ui-agent/access.ts`.
 *
 * The pipeline still calls Anthropic through its OWN client rather than the AI
 * SDK: those calls use structured outputs, per-call effort levels and prompt
 * cache breakpoints that were tuned against measured accuracy, and re-expressing
 * them through a second abstraction would change generation behaviour for no
 * gain. The SDK drives the CONVERSATION; the raw client drives GENERATION.
 */
export async function POST(req: NextRequest) {
  /* TAKEN AT HANDLER ENTRY, not when the row is opened: the access check, the
     ownership query and the config load all run first, and timing the turn from
     after them understates the wait by exactly the part worth seeing. */
  const startedAtMs = Date.now();
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;

  /* ── Access gate ──
   *
   * Open to every signed-in user unless BACKEND_AGENT_REQUIRE_PERMISSION is set;
   * `lib/po-ui-agent/access.ts` holds the rule and the reasoning. Enforced HERE
   * as well as in the client gate, because a gate in the browser is a courtesy
   * and never a control — this is the one that decides. */
  if (requiresPermission()) {
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      include: { role: true },
    });
    const permissions = Array.isArray(dbUser?.role?.permissions)
      ? (dbUser!.role!.permissions as string[])
      : [];
    if (!canUseBackendAgent({ isAdmin: isPlatformAdmin(dbUser), permissions })) {
      return NextResponse.json({ error: DENIED_MESSAGE }, { status: 403 });
    }
  }

  let body: { messages?: unknown; conversationId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Malformed request body.' }, { status: 400 });
  }

  const conversationId = String(body.conversationId ?? '');
  const uiMessages = (Array.isArray(body.messages) ? body.messages : []) as UIMessage[];
  if (!conversationId) {
    return NextResponse.json({ error: 'No conversation was named.' }, { status: 400 });
  }

  const owned = await prisma.conversation.findFirst({
    where: { id: conversationId, userId: user.id, deletedAt: null },
    select: { id: true },
  });
  if (!owned) {
    return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
  }
  // This request is now the conversation's current turn (see lib/turn-registry).
  const turnSeq = beginTurn();
  /** Saved time of the question this turn answers (see lib/turn-registry). */
  let questionAt: number | undefined;
  let questionId: string | undefined;

  /*
   * THE PIPELINE'S CONFIG AND THE PROMPT PACKAGE, GUARDED.
   *
   * Both used to be built bare. On a checkout without the client's `samples/`
   * the package reader threw `ENOENT` here and the browser got a 500 with an
   * empty body — no sentence, no folder name, nothing to act on. The package is
   * now built from what is on disk (`loadAgentConfig`), and the one failure
   * that remains — no example page at all — is answered in words, with the
   * folder and the variable that fix it.
   */
  const prepared = prepareAgent(user.id);
  if (prepared instanceof NextResponse) return prepared;
  const { cfg, evidence, system } = prepared;
  const model = conversationModel();

  /* PER-TOKEN RATES, loaded ONCE up front: `onFinish` prices each step
     synchronously and must not block the stream on a query. Null when the
     registry has no row for this model, which falls back to the compiled
     table — so pricing a new model stays an administrator's config change
     rather than a deployment. */
  let registryRate: ModelRates | null = null;
  try {
    registryRate = await getRegistryRates(model);
  } catch {
    /* registry unavailable — the compiled table still prices the common models */
  }

  /*
   * THE PROMPT LEDGER — opened here, finalised in `onFinish`.
   *
   * Every turn of the other agent writes a `prompt_audit_logs` row; this route
   * wrote none, so the admin application reported zero prompts for engineers who
   * had run dozens. Opened AFTER the access and ownership checks — a refused
   * request is not a prompt — and before the model call, so a turn that dies
   * mid-stream still leaves a PENDING row rather than no trace at all.
   *
   * Failure to record never fails the turn: `recordPromptStart` returns null and
   * everything downstream is guarded.
   */
  const userPrompt = textOf(uiMessages[uiMessages.length - 1]);
  let auditHandle: PromptStartHandle | null = null;
  if (userPrompt) {
    auditHandle = await recordPromptStart({
      userId: user.id,
      userName: user.name ?? null,
      userEmail: user.email ?? null,
      userPrompt,
      model,
      startedAtMs,
    });
  }

  /*
   * Progress lines from inside the pipeline, forwarded to the browser.
   *
   * BUFFERED, because of an ordering problem: the AI SDK's `writer` only exists
   * inside `createUIMessageStream({ execute })`, and the tools have to be built
   * before that. A tool that starts executing early would otherwise have nothing
   * to push to and its lines would be lost — which is exactly what happened when
   * these were first dropped in the port.
   */
  const pendingProgress: string[] = [];
  let emitProgress: ((line: string) => void) | null = null;
  /*
   * SERVER PATHS DO NOT GO ON SCREEN.
   *
   * The pipeline's log lines carry absolute paths — `PRD written:
   * D:\...\runs\<id>\PRD.md` — because in the standalone they went to a
   * collapsible LOG that an engineer opened when something went wrong. Here the
   * same lines are the visible progress caption, so a Windows path from the
   * server was appearing in the chat mid-run.
   *
   * Reduced to the file name, which is the only part that means anything to the
   * reader. Done at this boundary rather than at each `log()` call: there are
   * dozens of them across the pipeline, they are shared with the standalone, and
   * a rule enforced in one place cannot be forgotten by the next line added.
   *
   * Matches a drive-letter path, a UNC share or a POSIX path, so it holds
   * wherever this is deployed rather than only on the machine it was found on.
   */
  const withoutServerPaths = (line: string): string =>
    line.replace(
      /(?:[A-Za-z]:[\\/]|\\\\[^\s\\]+[\\/]|\/(?:home|Users|var|opt|srv|tmp)\/)[^\s"'<>|]*/g,
      (p) => p.split(/[\\/]/).filter(Boolean).pop() ?? '',
    );

  /*
   * THE RETRY COUNTER IS OURS, NOT THEIRS.
   *
   * Generation validates its own output and re-generates when a check fails, up
   * to three times. "attempt 1/3 — generating..." reports that machinery to an
   * engineer who did not ask for it and cannot act on it — and on a first, clean
   * attempt it reads as though something has already gone wrong. The OUTCOME is
   * still reported honestly: the validator verdict sits on the panel and the gap
   * report ships inside the unit.
   */
  /*
   * LINES THAT DESCRIBE HOW THE RUN WORKS, NOT WHAT IT PRODUCED.
   *
   * A progress caption exists to tell an engineer what is happening to their
   * page. Everything else the pipeline logs is our own machinery: true, useful
   * in a server log, and noise on screen.
   *
   * Kept as ONE table because five separate predicates had accumulated here,
   * each added the day a line was reported — which is whack-a-mole, and it had
   * already produced a regex nobody could read. Each entry carries its reason,
   * so a later reader can tell a rule that earned its place from one added to
   * silence a complaint.
   */
  const INTERNAL: ReadonlyArray<readonly [RegExp, string]> = [
    [/(supplied to|resolved for) the model\b/i,
      'which reference material was assembled into the prompt'],
    [/PRD\.html\b/i,
      'an HTML rendering the interface never hands over — the PRD is delivered as Word'],
    [/^\s*(\[[^\]]*\]\s*)?<-\s/,
      'token accounting for one model call, and it names the model, which is ours'],
    [/page refresh: autoRefresh=/i,
      'a property of the page being written, not a step in writing it'],
  ];

  const isInternal = (line: string): boolean =>
    INTERNAL.some(([re]) => re.test(line));

  /*
   * THE PAGE'S TITLE IS WORTH SHOWING; ITS GEOMETRY IS NOT.
   *
   * `page values: title="X" columns=6 width=1024 uid=UIPage_178885…` — the
   * title is the page being built and the reader recognises it. The column
   * count, the pixel width and the generated object id are how the export is
   * assembled: not decisions being shown, and the uid means nothing outside the
   * file. Reduced rather than dropped, so the caption still names the page.
   */
  const trimPageValues = (line: string): string =>
    line.replace(
      /page values: (title="[^"]*")(?:\s+\w+=\S+)*/i,
      (_m, title: string) => `page title: ${title.slice(6)}`,
    );

  const withoutRetryCounter = (line: string): string => {
    const stripped = line.replace(/attempt \d+\s*\/\s*\d+\s*[—–-]\s*/gi, '').trim();
    /* What is left of that line is `[PageName] generating...`, which is the same
       claim the box beside it already makes — "Generating the CMF export" — with
       an internal page tag in front of it. Dropped whole rather than half. */
    return /^(\[[^\]]*\]\s*)?generating\.*$/i.test(stripped) ? '' : stripped;
  };

  const reportProgress = (line: string): void => {
    const shown = isInternal(line)
      ? ''
      : trimPageValues(withoutRetryCounter(withoutServerPaths(line))).trim();
    /*
     * BOTH THE RAW LINE AND WHAT WAS SHOWN.
     *
     * The log keeps the path — it is a server-side diagnostic, and knowing which
     * directory a run wrote to is exactly what makes it useful. It now also
     * records what actually reached the browser.
     *
     * That pairing exists because "the retry counter is still on screen" was
     * reported four times, and each time the only way to answer it was to reason
     * about the redaction rather than read what it did. One log line settles it:
     * if `shown` is empty the line never left the server, and if it is not, the
     * exact text that did is right here.
     */
    logger.info('backend-agent progress', { conversationId, line, shown });
    /* A line that was nothing but machinery is not worth a blank caption. */
    if (!shown) return;
    if (emitProgress) emitProgress(shown);
    else pendingProgress.push(shown);
  };

  /* The streaming page definition and the finished files, buffered for the same
     reason as progress: the writer does not exist when the tools are built. */
  type Streamed = { kind: 'code'; page: string; delta: string; attempt: number }
                | { kind: 'file'; name: string; chars: number };
  const pendingStream: Streamed[] = [];
  let emitStream: ((e: Streamed) => void) | null = null;
  const report = (e: Streamed): void => {
    if (emitStream) emitStream(e);
    else pendingStream.push(e);
  };

  const tools = buildBackendAgentTools({
    conversationId,
    userId: user.id,
    ip: clientIp(req),
    cfg,
    client: makeClient(),
    onProgress: reportProgress,
    onCode: (page, delta, attempt) => report({ kind: 'code', page, delta, attempt }),
    onFile: (name, content) => report({ kind: 'file', name, chars: content.length }),
    /* What this machine is missing, so a generation says so on screen and in
       the result the model reports from. */
    evidenceNotices: evidence.notices,
  });

  /*
   * The system prompt carries the PACKAGE — the rules, the harvested CMF
   * dictionary, the delivered sample pages. It is large and stable, which is
   * exactly what prompt caching is for; `chatSystem` marks the breakpoints.
   * Flattened to text here because the AI SDK takes a single system string.
   */
  const state = readState(conversationId);

  const documentNote = state.storyName
    ? `\n\nThe requirement document attached to this conversation is "${state.storyName}".`
    : '\n\nNo requirement document has been attached to this conversation yet.';

  /*
   * THE DOCUMENT ITSELF, PUT IN FRONT OF THE MODEL.
   *
   * The upload extracts the text server-side and stores it beside the run, so the
   * TOOLS have it. The CONVERSATION did not: this route sent the file name and a
   * note saying the text "is already available to the tools", and nothing else.
   *
   * That note is true of `write_prd` and false of the turn the engineer is having.
   * Measured 2026-09-08 against the standalone on the same document: asked what
   * the document left open, the model here discussed a Change Priority button. The
   * word "priority" appears NOWHERE in that document — it comes from the worked
   * sample in the package, which is an earlier revision of the same user story. It
   * was answering from the samples because it had never been shown the document,
   * and one run said so outright: "I have the filename and nothing else from it."
   *
   * The standalone replays the document ahead of the history for exactly this
   * reason, and its own note names the failure: "without this the model can see
   * the conversation discussing a document it cannot read." The port kept the
   * server-side extraction and dropped the replay.
   *
   * Ahead of the history rather than appended to the system prompt, so it sits in
   * the same place, in the same words, as it does in the standalone.
   */
  const documentReplay = state.storyText
    ? [
        {
          role: 'user' as const,
          content:
            `Here is the requirement document, ${state.storyName ?? 'attached'}.\n\n` +
            `---\n${state.storyText}\n---`,
        },
        { role: 'assistant' as const, content: 'Noted — I have the document.' },
      ]
    : [];

  /*
   * PROMPT CACHING — the difference between a fast turn and a cold one.
   *
   * The package is ~155,000 tokens of rules, harvested CMF dictionary and
   * delivered sample pages. It is byte-stable for the life of a deployment,
   * which is exactly what a cache breakpoint is for. Sent through the AI SDK's
   * top-level `system:` field it would be re-read COLD on every turn.
   *
   * Anthropic allows four breakpoints and reads the longest matching prefix, so
   * they are spent the same way `app/api/chat/route.ts` spends them:
   *   1. the system prompt        stable for the life of the deployment
   *   2. the end of prior history stable for the whole of this turn
   *   3. the current last message stable across this turn's tool loop
   *
   * #2 matters most here: a generation is a MULTI-STEP turn, and without a
   * breakpoint behind the growing tail every step reprocesses the whole
   * conversation from cold.
   */
  const ephemeral = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mark = (m: any) => ({ ...m, providerOptions: { ...(m?.providerOptions ?? {}), ...ephemeral } });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outbound: any[] = [
    /*
     * THE PRE-VALIDATION FINDINGS ARE DELIBERATELY NOT SENT.
     *
     * They were, briefly. The reasoning was sound on its face: the resolver has
     * already settled most of what the story names, so telling the model would
     * stop it re-asking. It was removed on 2026-09-09 because it destroys the
     * property that makes the report worth having.
     *
     * The two readers are useful because they are INDEPENDENT. The model reads
     * intent and scope — it catches "Change Priority is in the delivered version
     * and absent from this revision", which the resolver has no concept of. The
     * resolver is exhaustive and mechanical over every named term, and cannot be
     * talked out of a finding.
     *
     * On US-455386 they overlapped on ONE item of eight, and disagreed on the
     * one that mattered: the model called `TrackInResource` and `TrackInId`
     * settled, the resolver marked both `assumed` and asked for confirmation.
     * That contradiction is the single most valuable line in the report, and a
     * model primed with the resolver's findings cannot produce it — it would
     * echo them instead.
     *
     * The cost is accepted: the model may ask about something already resolved.
     * That is cheaper than losing a check that can disagree with it.
     */
    { role: 'system', content: system + documentNote, providerOptions: ephemeral },
    ...documentReplay,
    ...(await convertToModelMessages(uiMessages)),
  ];
  // Skipped on a one-message conversation, so a breakpoint is never wasted.
  if (outbound.length >= 3) outbound[outbound.length - 2] = mark(outbound[outbound.length - 2]);
  outbound[outbound.length - 1] = mark(outbound[outbound.length - 1]);

  logger.info('backend-agent prompt caching', {
    conversationId,
    systemChars: system.length,
    breakpoints: outbound.length >= 3 ? 3 : 2,
  });

  /** First error the model stream raised — the root cause behind the AI SDK's
   *  generic wrapper, which only reports that no output was produced. */
  let rootStreamError: unknown = null;

  // A short progress note to the user every ~8 tool calls (shared/lib/progress-nudge.ts).
  const progress = createProgressNudge();
  const result = streamText({
    model: anthropic(model),
    messages: outbound,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prepareStep: ({ messages: stepMessages }: { messages: any[] }) => {
      const next = progress.messages(stepMessages);
      return next === stepMessages ? {} : { messages: next };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onStepFinish: (event: any) => progress.stepFinished(event),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal: req.signal,
    onError: (e: unknown) => {
      const err = (e as { error?: unknown })?.error ?? e;
      if (!rootStreamError) rootStreamError = err;
      logger.fabOrchError(err, { route: '/api/backend-agent/chat', userId: user.id, model });
    },
  });
  result.consumeStream();

  // One id for the reply: the `start` chunk (what the browser shows), the
  // stream's responseMessage and the saved row. With different ids, rating a
  // fresh reply asked the server for a message it had never stored.
  const assistantMessageId = randomUUID();
  const stream = createUIMessageStream({
    generateId: () => assistantMessageId,
    execute: async ({ writer }) => {
      /*
       * WHICH WAITING LADDER THE CLIENT SHOULD RUN.
       *
       * The standalone captions the wait with one of four ladders and picks
       * between them ON THE SERVER (`waitPhase`), because only the server knows
       * whether a document is attached and whether a PRD exists. Derived from
       * what the conversation HAS, never from matching words in what the
       * engineer typed — "proceed" and "no, change the columns first" look alike
       * to a keyword and mean opposite things.
       *
       * Sent once, at the top of the turn. While a TOOL is running the client
       * shows that tool's own progress instead; this covers the model's thinking
       * time, which is the part with nothing else to look at.
       */
      writer.write({
        type: 'data-phase',
        data: { phase: !state.storyText ? 'answering' : state.prdMarkdown ? 'deciding' : 'reading' },
      });

      emitProgress = (line: string) => {
        try {
          writer.write({ type: 'data-progress', data: { line } });
        } catch {
          /* the stream closed; progress is a courtesy and never fails a turn */
        }
      };
      emitStream = (e: Streamed) => {
        try {
          if (e.kind === 'code') {
            writer.write({
              type: 'data-artifactCode',
              data: { page: e.page, delta: e.delta, attempt: e.attempt },
            });
          } else {
            writer.write({ type: 'data-artifactFile', data: { name: e.name, chars: e.chars } });
          }
        } catch {
          /* the stream closed; this is a courtesy and never fails a turn */
        }
      };

      // Anything the pipeline reported before the writer existed.
      for (const line of pendingProgress.splice(0)) emitProgress(line);
      for (const e of pendingStream.splice(0)) emitStream(e);

      writer.merge(result.toUIMessageStream({ sendReasoning: true, generateMessageId: () => assistantMessageId }));

      /*
       * Surface tool failures as DATA, not as whatever the model says.
       * Shared with the Fab chat so all three agents report identically.
       */
      // AWAITED, not fire-and-forget: the UI stream stays open until
      // execute resolves. Detached, the cards were often written after the
      // stream had closed and silently dropped (the record was still saved).
      try {
        streamToolFailures(await result.steps, writer, {
          system: 'Coding Agent',
          userId: user.id,
          route: '/api/backend-agent/chat',
        });
      } catch { /* never let error reporting break the turn */ }
    },
    onFinish: async ({ responseMessage }) => {
      /*
       * FINALISE THE PROMPT ROW — tokens, cost and the tools the turn ran.
       *
       * Bucketed exactly as `/api/chat` buckets it, so one table can be summed
       * across both agents:
       *   turn 1 input      -> request_*
       *   turns 2..N input  -> retrieval_*   (feeding tool results back)
       *   all turns' output -> response_*
       *
       * Priced per STEP against that step's own model id. Cached and
       * cache-written input are counted as input tokens — this agent sends a
       * 555,000-character cached prefix on every generate, so dropping them
       * would under-report its cost by most of it.
       */
      if (auditHandle) {
        try {
          const steps = (await result.steps) ?? [];
          const toolCalls: ToolCallSummary[] = [];
          let requestTokens = 0, retrievalTokens = 0, responseTokens = 0;
          let requestCost = 0, retrievalCost = 0, responseCost = 0;
          let pricingWarned = false;

          for (let i = 0; i < steps.length; i++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const s = steps[i] as any;
            if (Array.isArray(s.toolCalls)) {
              for (const tc of s.toolCalls) {
                toolCalls.push({
                  name: tc.toolName || tc.name || 'unknown',
                  args: tc.input ?? tc.args,
                } as ToolCallSummary);
              }
            }
            if (!s.usage) continue;
            const inTok = s.usage.inputTokens ?? s.usage.promptTokens ?? 0;
            const outTok = s.usage.outputTokens ?? s.usage.completionTokens ?? 0;
            const readTok = s.usage.cachedInputTokens ?? 0;
            const writeTok = s.usage.cacheCreationInputTokens ?? 0;
            const stepModel = s.response?.modelId || s.modelId || model;
            const stepUsage = {
              inputTokens: inTok,
              outputTokens: outTok,
              cachedInputTokens: readTok,
              cacheCreationInputTokens: writeTok,
            };
            /* A MODEL NOBODY HAS PRICED COSTS 0, WHICH READS AS FREE.
               Said once per turn, through the channel the team already watches,
               because this agent's turns are the expensive ones — a single
               generate carries a ~289,000-token cached prefix. */
            const rate = stepModel === model ? registryRate : null;
            if (!rate && !hasPricing(stepModel) && !pricingWarned) {
              pricingWarned = true;
              logger.fabOrchError(
                new Error(`No pricing for model "${stepModel}" — cost recorded as 0`),
                { route: '/api/backend-agent/chat', conversationId },
              );
            }
            const cost = rate
              ? costForTurnWithRates(rate, stepUsage)
              : costForTurn(stepModel, stepUsage);
            const stepInput = inTok + readTok + writeTok;
            if (i === 0) { requestTokens += stepInput; requestCost += cost.inputCost; }
            else { retrievalTokens += stepInput; retrievalCost += cost.inputCost; }
            responseTokens += outTok;
            responseCost += cost.outputCost;
          }

          await recordPromptSuccess({
            rowId: auditHandle.rowId,
            startedAtMs: auditHandle.startedAtMs,
            app: auditHandle.app,
            userPrompt,
            llmResponse: textOf(responseMessage),
            toolCalls,
            /* Stated, never inferred — see CODING_AGENT_TOPIC. */
            topicOverride: CODING_AGENT_TOPIC,
            requestTokens, retrievalTokens, responseTokens,
            requestCost, retrievalCost, responseCost,
          });
        } catch (e) {
          /* The turn succeeded in front of the engineer; a bookkeeping failure
             must not be reported to them as a failed run. Recorded so the row
             does not sit PENDING for ever with no explanation. */
          logger.error('backend-agent prompt audit failed', {
            conversationId,
            error: (e as Error).message,
          });
          await recordPromptFailure({
            rowId: auditHandle.rowId,
            startedAtMs: auditHandle.startedAtMs,
            errorEnvelope: {
              errorId: auditHandle.promptId,
              type: 'PROMPT_AUDIT_FAILED',
              priority: 'LOW',
              /* What the row is FOR is the prompt and its cost; the turn itself
                 was fine, and saying otherwise to whoever reads the admin list
                 would be worse than saying the accounting broke. */
              userMessage: 'The turn completed; its usage could not be recorded.',
            },
          }).catch(() => { /* nothing further to try */ });
        }
      }

      try {
        const last = uiMessages[uiMessages.length - 1];
        const resend = last?.role === 'user' ? await prepareResend(conversationId, last.id, (at) => { questionAt = at.getTime(); questionId = String(last.id); markResend(conversationId, turnSeq, questionAt); }) : false;
        if (last?.role === 'user' && !resend) {
          const keepId = await clientMessageId(last.id);
          const savedQuestion = await addMessage(conversationId, {
            ...(keepId ? { id: keepId } : {}),
            role: 'user',
            content: textOf(last),
            parts: last.parts ?? [],
            metadata: { agent: 'backend' },
          });
          questionAt = savedQuestion ? new Date(savedQuestion.createdAt).getTime() : undefined;
        questionId = savedQuestion?.id;
        }
        // Whether, and where in the history, the answer is stored: lib/save-answer.
        await saveTurnAnswer({ conversationId, seq: turnSeq, questionId, questionAt }, {
          id: assistantMessageId,
          content: textOf(responseMessage),
          parts: responseMessage.parts ?? [],
          metadata: { model, agent: 'backend' },
        });
      } catch (e) {
        // A transcript that failed to save must not also fail the turn the
        // engineer just watched succeed.
        // The reply is on screen but was not saved — it vanishes when the
        // conversation is reopened. Record it rather than lose it.
        logger.error('backend-agent persistence failed', {
          conversationId,
          error: (e as Error).message,
        });
        recordSilentFailure(e, {
          stage: 'persistAssistantMessage',
          system: 'Conversation storage',
          userId: user.id,
          route: '/api/backend-agent/chat',
        });
      }
    },
    /*
     * This route had NO error handler at all: a failure mid-stream surfaced as
     * the AI SDK's default text and was never recorded, so Coding Agent
     * failures left no trace — no id, no row in error_audit_logs, nothing for
     * an admin to look up. This records the real cause and hands back an id.
     */
    onError: (error) => {
      const fabErr = FabOrchError.lambdaMcpCrash(rootStreamError ?? error, {
        route: '/api/backend-agent/chat',
        userId: user.id,
      });
      const detail = captureError({
        errorId: fabErr.errorId,
        cause: rootStreamError ?? error,
        type: fabErr.type,
        priority: 'HIGH',
      });
      logger.fabOrchError(fabErr, { route: '/api/backend-agent/chat', userId: user.id });
      import('@/shared/lib/errors/error-audit').then((m) =>
        m.recordError(fabErr, {
          userId: user.id,
          route: '/api/backend-agent/chat',
          method: 'POST',
          technicalMessage: detail.message ?? null,
          stackPreview: detail.stack ?? null,
          requestContext: { ...detail, agent: 'coding-agent', model } as unknown as Record<string, unknown>,
        })
      ).catch(() => {});
      return `${summarizeError(detail)} (errorId=${fabErr.errorId})`;
    },
  });

  return createUIMessageStreamResponse({ stream });
}

/** The plain text of a UI message, for the `content` column. */
function textOf(m: UIMessage | undefined): string {
  if (!m?.parts) return '';
  return m.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim();
}
