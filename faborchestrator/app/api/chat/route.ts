import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { streamText, convertToModelMessages, stepCountIs, hasToolCall, createUIMessageStream, createUIMessageStreamResponse, tool } from 'ai';
import { z } from 'zod';
import { anthropic, forwardAnthropicContainerIdFromLastStep, createAnthropicWithContainerUploads } from '@/shared/lib/anthropic';
import { createProgressNudge } from '@/shared/lib/progress-nudge';
import { addMessage, getMessages, clientMessageId, prepareResend } from '@/shared/lib/storage';
import { beginTurn, markResend } from '@/shared/lib/turn-registry';
import { saveTurnAnswer } from '@/shared/lib/save-answer';
import { loadActiveMcpToolsWithDescriptions, type McpToolGroup } from '@/modules/mcp/lib/mcp-client';
import { autoConnectMcp } from '@/modules/mcp/lib/mcp-connect';
import { mcpAccessFrom, disabledManagedIdsFrom } from '@/modules/mcp/lib/mcp-access';
import { agentKeyFrom } from '@/shared/lib/agents';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { getAnthropicFilesClient } from '@/modules/support-engineer/lib/anthropic-files';
import { uploadUserFileToS3, presignKey } from '@/modules/support-engineer/lib/s3-upload';
import { buildSystemPromptWithTools, buildUploadedFilesBlock } from '@/modules/support-engineer/lib/system-prompts';
import { fitMessagesToContextWindow } from '@/modules/support-engineer/lib/context-window';
import { validateOrThrow, ChatRequestSchema } from '@/shared/lib/validation';
import { FabOrchError, isFabOrchError } from '@/shared/lib/errors/faborch-errors';
import { captureError, groupFailures, summarize as summarizeError, type ErrorDetail } from '@/shared/lib/errors/error-detail';
import { isCapturedError } from '@/shared/lib/errors/capture';
import { streamToolFailures } from '@/shared/lib/errors/stream-tool-failures';
import { recordSilentFailure } from '@/shared/lib/errors/silent-failure';
import { askUserShown, diagnoseTurnEnd } from '@/shared/lib/errors/turn-outcome';
import { handleApiError } from '@/shared/lib/errors/api-error-handler';
import { ALLOWED_MODELS } from '@/shared/lib/errors/parameter-values';
import { logger } from '@/shared/lib/logger';
import {
  recordPromptStart,
  recordPromptSuccess,
  recordPromptFailure,
  recordPromptTimings,
  type PromptStartHandle,
  type ToolCallSummary,
} from '@/shared/lib/prompt-audit';
import { costForTurn, costForTurnWithRates, hasPricing, type ModelRates } from '@/shared/lib/model-pricing';
import { getAllowedModelIds, getRegistryRates, getThinkingConfig } from '@/shared/lib/model-registry';
import { bumpActivityIfActive } from '@/shared/lib/session-audit';
import { glossaryBlock } from '@/modules/fabinsight/lib/aliases';
import { PhaseTimer } from '@/shared/lib/perf-timer';
import { isPlatformAdmin } from '@/shared/lib/permissions';

export const maxDuration = 300;

/** Tool-loop steps allowed in one reply. The end-of-turn check names it when it runs out. */
const CHAT_MAX_STEPS = 20;
/**
 * A connector that stays down is reported on EVERY turn by every user of it —
 * correctly, each of them is missing data. But writing a fresh admin record
 * each time buries the log under one sentence. The user still gets the card
 * every turn; the record is written once per connector + cause per window.
 */
const CONNECTOR_RECORD_WINDOW_MS = 15 * 60_000;
const lastConnectorRecord = new Map<string, { at: number; errorId: string }>();
/**
 * The id of the record already written for this connector + cause inside the
 * window, or null when a new record should be written (and is remembered).
 * A repeat's card then points at that existing record — linking to its own,
 * never-written id sent "View error details" to a page that did not exist.
 */
function priorConnectorRecord(connectionId: string, reason: string, errorId: string): string | null {
  const key = `${connectionId}::${reason.slice(0, 200)}`;
  const now = Date.now();
  const last = lastConnectorRecord.get(key);
  if (last && now - last.at < CONNECTOR_RECORD_WINDOW_MS) return last.errorId;
  lastConnectorRecord.set(key, { at: now, errorId });
  if (lastConnectorRecord.size > 500) {
    for (const [k, v] of lastConnectorRecord) if (now - v.at >= CONNECTOR_RECORD_WINDOW_MS) lastConnectorRecord.delete(k);
  }
  return null;
}

/** Output tokens per model call, thinking included. See the note at streamConfig. */
const CHAT_MAX_OUTPUT_TOKENS = Number(process.env.CHAT_MAX_OUTPUT_TOKENS ?? '64000') || 64000;

/**
 * Wrap an SSE Response so a keepalive comment is emitted during idle gaps. A long
 * tool call (e.g. an on-the-fly MCP runtime cold-start over the VPN, ~30-60s) or
 * slow first token produces NO bytes while it runs; CloudFront's origin read
 * timeout (60s, not raisable past 60 without an AWS quota increase) would cut the
 * stream. A `: keepalive` comment every 20s is ignored by the SSE/AI-SDK parser
 * but keeps CloudFront + the ALB from timing out.
 */
function withKeepAlive(res: Response, intervalMs = 20000): Response {
  if (!res.body) return res;
  const encoder = new TextEncoder();
  const source = res.body;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      const timer = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keepalive\n\n')); } catch { /* closed */ }
      }, intervalMs);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
      } catch (e) {
        clearInterval(timer);
        controller.error(e);
        return;
      }
      clearInterval(timer);
      controller.close();
    },
  });
  return new Response(stream, { headers: res.headers, status: res.status, statusText: res.statusText });
}

/**
 * Reasoning effort for adaptive-thinking models.
 *
 * Opus was pinned to 'max', the most expensive setting: on this workload the
 * slowest turns averaged ~198s, and thinking is a large part of that. 'high'
 * keeps strong reasoning at a materially lower latency, so it is the default.
 *
 * Env-tunable (server-side, read at RUNTIME — no rebuild needed) so the trade
 * can be A/B'd against the new `perf` timings without a code change:
 *   CHAT_THINKING_EFFORT = low | medium | high | max
 * 'max' is Opus-only; on Sonnet it is downgraded to 'high' by the API contract,
 * so we downgrade explicitly rather than send something the model rejects.
 */
const VALID_EFFORTS = ['low', 'medium', 'high', 'max'] as const;
type ThinkingEffort = (typeof VALID_EFFORTS)[number];

function resolveEffort(modelId: string): ThinkingEffort {
  const raw = (process.env.CHAT_THINKING_EFFORT ?? '').trim().toLowerCase();
  const configured = (VALID_EFFORTS as readonly string[]).includes(raw)
    ? (raw as ThinkingEffort)
    : 'high';
  const isOpus = modelId.startsWith('claude-opus-') || modelId.startsWith('claude-fable-');
  return configured === 'max' && !isOpus ? 'high' : configured;
}

// Models that support adaptive thinking (type: "adaptive" + effort)
const ADAPTIVE_THINKING_MODELS = [
  'claude-sonnet-5',   // FabOrchestrator 1
  'claude-opus-5',     // FabOrchestrator 2
  'claude-fable-5',    // FabOrchestrator 3
  'claude-fable-5-1',  // FabOrchestrator 4
];

// Models that support manual thinking (type: "enabled" + budgetTokens)
const MANUAL_THINKING_MODELS: string[] = [];

function getThinkingMode(modelId: string): 'adaptive' | 'manual' | 'none' {
  if (ADAPTIVE_THINKING_MODELS.includes(modelId)) return 'adaptive';
  if (MANUAL_THINKING_MODELS.includes(modelId)) return 'manual';
  return 'none';
}

// Server-side / provider-executed tools (Anthropic runs these in its own
// sandbox and returns the result inline). Identified by providerExecuted, by
// the `srvtoolu_` tool-use id prefix Anthropic assigns them, or by name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isServerTool(c: any): boolean {
  return (
    c?.providerExecuted === true ||
    (typeof c?.toolCallId === 'string' && c.toolCallId.startsWith('srvtoolu_')) ||
    [
      'code_execution',
      'bash_code_execution',
      'text_editor_code_execution',
      'web_search',
      'web_fetch',
    ].includes(c?.toolName)
  );
}

/**
 * Anthropic rejects any request whose messages contain a tool_use without a
 * valid matching tool_result. With server-executed tools (code_execution →
 * `bash_code_execution` / `text_editor_code_execution`, web_search, web_fetch)
 * the AI SDK can produce THREE flavours of this:
 *
 *  1. ERRORED server tool: the SDK packs the error result inline next to the
 *     tool-call; Anthropic rejects that inline error block. (vercel/ai #11855)
 *  2. ORPHANED tool_use with no result at all (interrupted turn, replay).
 *  3. SPLIT provider result: when a server tool runs in PARALLEL with a regular
 *     /MCP tool, the SDK moves the server tool's result into a SEPARATE `tool`
 *     message instead of keeping it inline in the assistant message. Anthropic
 *     requires server tool_results inline, so on replay it sees the server
 *     tool_use "without a corresponding result". (vercel/ai #8112)
 *
 * This happens on replay AND mid multi-step loop, so we run this on the initial
 * messages *and* via streamText's `prepareStep`.
 *
 * Fix: drop every tool-call/tool-result block (by toolCallId) that is errored,
 * orphaned, or a server tool whose result is not inline with its call. Balanced,
 * successful, correctly-placed pairs are left untouched.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cleanToolMessages(modelMessages: any[]): any[] {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  const erroredIds = new Set<string>();
  for (const m of modelMessages) {
    if (!Array.isArray(m?.content)) continue;
    for (const c of m.content) {
      if (c?.type === 'tool-call' && c.toolCallId) callIds.add(c.toolCallId);
      if (c?.type === 'tool-result' && c.toolCallId) {
        resultIds.add(c.toolCallId);
        const outType = c.output?.type;
        if (outType === 'error-json' || outType === 'error-text' || c.isError === true) {
          erroredIds.add(c.toolCallId);
        }
      }
    }
  }
  const dropIds = new Set<string>(erroredIds);
  for (const id of callIds) if (!resultIds.has(id)) dropIds.add(id);   // tool_use with no result
  for (const id of resultIds) if (!callIds.has(id)) dropIds.add(id);   // result with no tool_use
  // #8112: a server tool's result MUST be inline in the same assistant message.
  // If a server tool-call has no result block inside its OWN message, the result
  // was split elsewhere (parallel-tool bug) — drop the whole interaction.
  for (const m of modelMessages) {
    if (!Array.isArray(m?.content)) continue;
    const inlineResultIds = new Set(
      m.content
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((c: any) => c?.type === 'tool-result' && c.toolCallId)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => c.toolCallId)
    );
    for (const c of m.content) {
      if (c?.type === 'tool-call' && isServerTool(c) && !inlineResultIds.has(c.toolCallId)) {
        dropIds.add(c.toolCallId);
      }
    }
  }
  if (dropIds.size === 0) return modelMessages;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  for (const m of modelMessages) {
    if (!Array.isArray(m?.content)) { out.push(m); continue; }
    const content = m.content.filter(
      (c: { type?: string; toolCallId?: string }) =>
        !((c?.type === 'tool-call' || c?.type === 'tool-result') && dropIds.has(c.toolCallId ?? ''))
    );
    if (content.length > 0) out.push({ ...m, content });
  }
  return out;
}

export async function POST(req: NextRequest) {
  // Phase timer, constructed FIRST so the clock covers the whole handler —
  // including the preflight the prompt-audit row used to start after.
  const perf = new PhaseTimer('chat', { route: '/api/chat', method: 'POST' });

  /*
   * Failures that happen BEFORE the model runs and silently degrade the answer
   * — connectors that would not load, an attachment that never uploaded. The
   * turn still succeeds, so nothing else would ever mention them, and the user
   * would receive a confident answer built on less than they provided.
   * Streamed to the client once the response opens.
   */
  const preflightFailures: unknown[] = [];
  const requestStartedAtMs = Date.now();
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;
  // Capture the bearer token so the streaming onFinish callback can bump
  // the user's activity clock once the response has fully streamed
  // (responses can run multi-minute; we don't want the original POST
  // timestamp to be the only activity event).
  const bearerToken = req.headers.get('Authorization')?.slice(7) ?? null;
  perf.mark('auth');

  try {
    // Validate request body — throws canonical INVALID_PARAMETER on bad input.
    const body = await req.json();
    const validated = validateOrThrow(ChatRequestSchema, body);
    perf.mark('parseBody');
    const {
      messages: uiMessages,
      model: requestedModel,
      enableReasoning = true,
      conversationId,
      webSearch = false,
      activeMcpIds = [],
      agent: requestedAgent,
      interactiveChoices = false,
    } = validated;

    /*
     * The conversation must be the caller's own. Without this, anyone who
     * knew another user's conversation id could post into it — and, since a
     * resend clears the replies after a message (prepareResend), delete from it.
     */
    if (conversationId) {
      const { prisma: ownerDb } = await import('@/shared/lib/db');
      const owned = await ownerDb.conversation.findFirst({
        where: { id: conversationId, userId: user.id, deletedAt: null },
        select: { id: true },
      });
      if (!owned) {
        return NextResponse.json({ error: { message: 'This conversation was not found.' } }, { status: 404 });
      }
    }
    // This request is now the conversation's current turn (see lib/turn-registry).
    const turnSeq = beginTurn();
    /** Saved time of the question this turn answers (see lib/turn-registry). */
    let questionAt: number | undefined;
    let questionId: string | undefined;

    // Use the model ID directly (frontend sends full Bedrock model IDs)
    const modelId = requestedModel || 'claude-fable-5-1';

    // Reject unknown models with INVALID_PARAMETER + valid options (REQ-01 #5).
    // Allow a model if it's active in the shared model_registry OR (fallback)
    // in the hardcoded ALLOWED_MODELS list. When the registry is empty/missing,
    // getAllowedModelIds() returns [] and we rely entirely on ALLOWED_MODELS.
    const registryAllowedIds = await getAllowedModelIds();
    perf.mark('registryAllowedIds');
    const isModelAllowed = registryAllowedIds.includes(modelId) || ALLOWED_MODELS.includes(modelId);
    if (!isModelAllowed) {
      const validOptions = registryAllowedIds.length > 0 ? registryAllowedIds : ALLOWED_MODELS;
      throw FabOrchError.invalidParameter('model', validOptions, undefined, {
        badValue: modelId,
      });
    }

    // REQ-04 — load registry per-token rates ONCE up front so the streaming
    // onFinish callback can price each step synchronously without blocking the
    // stream. Empty when the registry is missing/empty → cost math below falls
    // back to the hardcoded costForTurn/MODEL_PRICING map.
    const registryRatesByModel = new Map<string, ModelRates>();
    try {
      const rates = await getRegistryRates(modelId);
      if (rates) registryRatesByModel.set(modelId, rates);
    } catch {
      // Registry unavailable — fall back to hardcoded pricing.
    }
    perf.mark('registryRates');

    // ── Role-based model access control (managed in the Admin Console) ──
    // Fetch user with role to check permissions
    const { prisma: prismaDb } = await import('@/shared/lib/db');
    const userWithRole = await prismaDb.user.findUnique({
      where: { id: user.id },
      include: { role: true },
    });
    perf.mark('userRoleQuery');

    if (userWithRole?.role) {
      const allowedModels = Array.isArray(userWithRole.role.allowedModels)
        ? userWithRole.role.allowedModels as string[]
        : [];

      // Only enforce the role's model restriction if it actually references a
      // currently-available model. Roles that still list ONLY retired ids (from
      // before the model-registry rebrand) don't block the new models — otherwise
      // every user is locked out until an admin re-edits each role. Admins are
      // never model-restricted here (mirrors /api/user/models).
      const currentValidIds = new Set<string>([...registryAllowedIds, ...ALLOWED_MODELS]);
      const roleRestrictsCurrent = allowedModels.some((m) => currentValidIds.has(m));

      if (!isPlatformAdmin(userWithRole) && roleRestrictsCurrent && !allowedModels.includes(modelId)) {
        throw FabOrchError.invalidParameter(
          'model',
          allowedModels.filter((m) => currentValidIds.has(m)),
          undefined,
          { badValue: modelId, reason: 'role-restricted' }
        );
      }

      // Check usage limits (rolling 24h)
      if (userWithRole.role.dailyRequestLimit || userWithRole.role.dailyTokenLimit) {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const usage = await prismaDb.usageRecord.aggregate({
          where: { userId: user.id, createdAt: { gte: twentyFourHoursAgo } },
          _count: true,
          _sum: { inputTokens: true, outputTokens: true, thinkingTokens: true },
        });
        perf.mark('usageLimitQuery');

        if (userWithRole.role.dailyRequestLimit && usage._count >= userWithRole.role.dailyRequestLimit) {
          return NextResponse.json(
            { error: 'Daily request limit reached. Please try again later.' },
            { status: 429 }
          );
        }

        const totalTokens = (usage._sum.inputTokens || 0) + (usage._sum.outputTokens || 0) + (usage._sum.thinkingTokens || 0);
        if (userWithRole.role.dailyTokenLimit && totalTokens >= userWithRole.role.dailyTokenLimit) {
          return NextResponse.json(
            { error: 'Daily token limit reached. Please try again later.' },
            { status: 429 }
          );
        }
      }
    }
    // ── End role-based access control ──

    // Check if reasoning should be enabled for this model.
    // Prefer the registry's thinkingType for this model; fall back to the
    // hardcoded ADAPTIVE_THINKING_MODELS/MANUAL_THINKING_MODELS sets.
    const registryThinking = await getThinkingConfig(modelId);
    perf.mark('thinkingConfig');
    const resolvedThinkingMode = registryThinking?.type ?? getThinkingMode(modelId);
    const thinkingMode = enableReasoning ? resolvedThinkingMode : 'none';
    // Manual-thinking budget: registry value if provided, else the default.
    const manualThinkingBudget = registryThinking?.budget ?? 16000;

    // Get the last user message to save to database
    const lastUserMessage = uiMessages[uiMessages.length - 1];

    // ── REQ-04 — open the prompt-audit row up front (status=PENDING) ──
    // We extract the prompt text now so we can fill the row whether the
    // stream finishes, fails, or times out.
    let promptAuditUserText = '';
    if (lastUserMessage?.role === 'user') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts2 = lastUserMessage.parts as any[] | undefined;
      promptAuditUserText = parts2
        ?.filter((p: { type: string }) => p.type === 'text')
        .map((p: { text?: string }) => p.text || '')
        .join('') || (lastUserMessage as { content?: string }).content || '';
    }
    let promptAuditHandle: PromptStartHandle | null = null;
    if (promptAuditUserText) {
      promptAuditHandle = await recordPromptStart({
        startedAtMs: requestStartedAtMs,
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        userPrompt: promptAuditUserText,
        app: 'faborch',
        model: modelId,
      });
    }
    perf.mark('promptAuditStart');
    // ── End REQ-04 prompt-start hook ──

    // ── Store this turn's attached files in S3 (faborch-user-uploads) ──
    // Every newly attached file is persisted to S3 and the durable S3 *key* is
    // saved in the message metadata, so on later turns we can regenerate a fresh
    // presigned URL (they expire) without re-uploading. Only the current turn's
    // file parts (which still carry the base64 data URL) are uploaded — history
    // is never re-uploaded. A storage failure is logged and never breaks the chat.
    const currentS3Refs: { key: string; filename: string; mediaType: string }[] = [];
    if (lastUserMessage?.role === 'user' && Array.isArray((lastUserMessage as { parts?: unknown[] }).parts)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fileParts = ((lastUserMessage as any).parts as any[]).filter(
        (p) => p?.type === 'file' && typeof p.url === 'string' && p.url.startsWith('data:')
      );
      if (fileParts.length > 0) {
        const results = await Promise.allSettled(
          fileParts.map((p) =>
            uploadUserFileToS3({
              dataUrl: p.url as string,
              filename: (p.filename as string) || 'file',
              mediaType: p.mediaType as string | undefined,
              userId: user.id,
              conversationId: conversationId ?? null,
            })
          )
        );
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) {
            currentS3Refs.push({ key: r.value.key, filename: r.value.filename, mediaType: r.value.mediaType });
          } else if (r.status === 'rejected') {
            /*
             * The attachment was not stored. The turn continues, so the answer
             * still arrives — but the file is not retrievable on a later turn,
             * and previously nothing said so. `uploadUserFileToS3` wraps the
             * call in withCapture, so the record already exists; surface it.
             */
            logger.error('[Chat] S3 upload failed for an attachment', {
              route: '/api/chat',
              userId: user.id,
              cause: r.reason instanceof Error ? r.reason.message : String(r.reason),
            });
            if (isCapturedError(r.reason)) {
              preflightFailures.push(r.reason.detail);
            }
          }
        }
        if (currentS3Refs.length > 0) {
          console.log(`[Chat] Stored ${currentS3Refs.length} upload(s) in S3:`, currentS3Refs.map((f) => f.key));
        }
      }
    }
    // ── End S3 upload ──

    // Save user message to database if we have a conversation
    if (conversationId && lastUserMessage?.role === 'user') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts = lastUserMessage.parts as any[] | undefined;
      const userContent = parts
        ?.filter((p: { type: string }) => p.type === 'text')
        .map((p: { text?: string }) => p.text || '')
        .join('') || lastUserMessage.content || '';

      const hasFiles = parts?.some((p: { type: string }) => p.type === 'file') || false;

      const resend = await prepareResend(conversationId, (lastUserMessage as { id?: unknown }).id, (at) => { questionAt = at.getTime(); questionId = String((lastUserMessage as { id?: unknown }).id); markResend(conversationId, turnSeq, questionAt); });
      if ((userContent || hasFiles) && !resend) {
        const keepId = await clientMessageId((lastUserMessage as { id?: unknown }).id);
        const savedQuestion = await addMessage(conversationId, {
          ...(keepId ? { id: keepId } : {}),
          role: 'user',
          content: userContent || '(file attachment)',
          parts: lastUserMessage.parts,
          // Persist the durable S3 keys so later turns can re-expose the file URL.
          ...(currentS3Refs.length > 0 ? { metadata: { s3Files: currentS3Refs } } : {}),
        });
        questionAt = savedQuestion ? new Date(savedQuestion.createdAt).getTime() : undefined;
        questionId = savedQuestion?.id;
      }
    }

    // ── Per-tool timing (REQ-04 metadata) ──
    // `experimental_onToolCallFinish` fires once per tool execution with the
    // real wall-clock duration. It fires ONLY for tools we execute in-process
    // (MCP tools): Anthropic's provider-executed tools (code_execution,
    // web_search, web_fetch) run in Anthropic's sandbox, so the SDK never calls
    // our executor and they are absent here by design.
    const toolTimings = new Map<string, { durationMs: number; stepNumber: number; success: boolean }>();

    // Build tools object
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: Record<string, any> = {};

    // Code execution - always enabled
    tools.code_execution = anthropic.tools.codeExecution_20250825();

    // Memory tool - persistent memory across conversations (disabled)
    /*
    tools.memory = anthropic.tools.memory_20250818({
      execute: async (action) => {
        switch (action.command) {
          case 'view': {
            const isDirectory = action.path === '/' || action.path === '/memories' || action.path === '/global'
              || action.path.endsWith('/') || (action.path.startsWith('/') && !action.path.includes('.'));
            if (isDirectory) {
              const allFiles = await getAllVisibleMemoryFiles(user.id);
              const prefix = action.path.replace(/\/$/, '');
              const files = (prefix === '/' || prefix === '')
                ? allFiles
                : allFiles.filter(f => f.path.startsWith(prefix));
              if (files.length === 0) return 'No memory files found. Directory is empty.';
              return files.map(f => `${f.path} [${f.scope}]`).join('\n');
            }
            const file = await getMemoryFile(user.id, action.path);
            if (!file) return `Error: File not found: ${action.path}`;
            const lines = file.content.split('\n');
            if (action.view_range) {
              const [start, end] = action.view_range;
              return lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join('\n');
            }
            return lines.map((l, i) => `${i + 1}\t${l}`).join('\n');
          }
          case 'create': {
            const existing = await getMemoryFile(user.id, action.path);
            if (existing) return `Error: File already exists: ${action.path}. Use str_replace to modify it.`;
            await createMemoryFile({ userId: user.id, path: action.path, content: action.file_text });
            return `File created successfully: ${action.path}`;
          }
          case 'str_replace': {
            const file = await getMemoryFile(user.id, action.path);
            if (!file) return `Error: File not found: ${action.path}`;
            if (!file.content.includes(action.old_str)) return `Error: old_str not found in file`;
            const newContent = file.content.replace(action.old_str, action.new_str);
            await updateMemoryFileContent(user.id, action.path, newContent);
            return `Successfully replaced text in ${action.path}`;
          }
          case 'insert': {
            const file = await getMemoryFile(user.id, action.path);
            if (!file) return `Error: File not found: ${action.path}`;
            const insertLines = file.content.split('\n');
            insertLines.splice(action.insert_line, 0, action.insert_text);
            await updateMemoryFileContent(user.id, action.path, insertLines.join('\n'));
            return `Successfully inserted text at line ${action.insert_line} in ${action.path}`;
          }
          case 'delete': {
            const deleted = await deleteMemoryFile(user.id, action.path);
            if (!deleted) return `Error: File not found: ${action.path}`;
            return `File deleted: ${action.path}`;
          }
          case 'rename': {
            const renamed = await renameMemoryFile(user.id, action.old_path, action.new_path);
            if (!renamed) return `Error: File not found: ${action.old_path}`;
            return `File renamed from ${action.old_path} to ${action.new_path}`;
          }
        }
      },
    });
    */

    // Web search + web fetch - controlled by existing webSearch toggle
    if (webSearch) {
      tools.web_search = anthropic.tools.webSearch_20250305({ maxUses: 5 });
      tools.web_fetch = anthropic.tools.webFetch_20250910({
        maxUses: 3,
      });
    }

    // Track MCP tool descriptions for system prompt (+ per-server groups for the
    // multi-server rules, and the server the user already picked this conversation).
    let mcpToolDescriptions: { name: string; description: string }[] = [];
    let mcpGroups: McpToolGroup[] = [];
    let selectedConnectionId: string | null = null;

    // Filter activeMcpIds against authorized set (personal if role allows + role-level)
    let authorizedMcpIds: string[] = [];
    const access = mcpAccessFrom(userWithRole);
    if (activeMcpIds && activeMcpIds.length > 0 && userWithRole && access.enabled) {
      const role = userWithRole.role;
      // Query authorized MCP connections
      const agentKey = agentKeyFrom(requestedAgent);
      const authorizedConnections = await prismaDb.mcpConnection.findMany({
        where: {
          isActive: true,
          // Only this agent's connections; an id from another agent is ignored.
          agent: agentKey,
          OR: [
            // Role-level MCPs (assigned by admin, userId=null)
            ...(role ? [{ roleId: role.id, userId: null }] : []),
            // Personal MCPs (only if role permits)
            ...(role?.personalMcpEnabled ? [{ userId: user.id }] : []),
          ],
        },
      });
      // Assigned servers this user switched off for themselves (only possible with the manage option).
      const disabled = access.canEditPersonal ? disabledManagedIdsFrom(userWithRole.preferences) : new Set<string>();
      const authorizedSet = new Set(authorizedConnections.filter(c => !disabled.has(c.id)).map(c => c.id));
      authorizedMcpIds = activeMcpIds.filter((id: string) => authorizedSet.has(id));
      // Entitled connections are connected automatically (no-op when already connected),
      // so a managed server the user never "tested" still contributes its tools.
      await autoConnectMcp(authorizedConnections.filter(c => authorizedMcpIds.includes(c.id)), { respectManualOff: access.canEditPersonal });

      /*
       * A connector the user selected but is NOT entitled to use was dropped
       * here without a word — the request proceeded with fewer tools, and the
       * answer came back looking complete. Dropping it is correct; doing so
       * silently is not, because the user is left believing that connector
       * was consulted.
       */
      const refused = (activeMcpIds as string[]).filter((id) => !authorizedSet.has(id) && !disabled.has(id));
      // (A server the user switched off for themselves is a choice, not a failure.)
      const refusedRows = refused.length
        ? await prismaDb.mcpConnection.findMany({
            where: { id: { in: refused } },
            select: { id: true, name: true, isActive: true, userId: true, roleId: true },
          })
        : [];
      for (const id of refused) {
        const row = refusedRows.find((r) => r.id === id);
        // Say which rule excluded it — each has a different remedy, and a
        // generic "not available" sent people hunting in the wrong place.
        const reason = !row
          ? 'This connector no longer exists — it was deleted, so it was not used for this answer.'
          : !row.isActive
            ? `"${row.name}" is switched off (inactive), so it was not used for this answer. It has to be re-enabled before it can be used again.`
            : row.userId && row.userId !== user.id
              ? `"${row.name}" belongs to another user's account, so it cannot be used from yours.`
              : row.userId === user.id
                ? `"${row.name}" is one of your personal connectors, but your role no longer allows personal connectors, so it was not used.`
                : `"${row.name}" is not assigned to your role, so it was not used for this answer.`;
        const fabErr = FabOrchError.lambdaMcpCrash(new Error(reason), {
          route: '/api/chat',
          userId: user.id,
          extra: { stage: 'connectorNotAuthorized', connectionId: id },
        });
        const detail = captureError({
          errorId: fabErr.errorId,
          cause: new Error(reason),
          type: fabErr.type,
          connector: row?.name ?? 'Connector',
          toolName: 'authorize',
        });
        logger.warn('[Chat] selected connector excluded', {
          route: '/api/chat', userId: user.id, connectionId: id, reason,
        });
        import('@/shared/lib/errors/error-audit').then((m) =>
          m.recordError(fabErr, {
            userId: user.id,
            route: '/api/chat',
            method: 'POST',
            technicalMessage: reason,
            requestContext: detail as unknown as Record<string, unknown>,
          }),
        ).catch(() => {});
        preflightFailures.push(detail);
      }
    } else if (activeMcpIds && activeMcpIds.length > 0 && userWithRole && !access.enabled) {
      // Connectors are still selected in the browser, but the role lost MCP
      // access. Every one is dropped — say so once, rather than answering as
      // though they had been consulted.
      const reason = `Your role does not include connector (MCP) access, so the ${activeMcpIds.length} selected connector${activeMcpIds.length === 1 ? ' was' : 's were'} not used for this answer.`;
      const fabErr = FabOrchError.lambdaMcpCrash(new Error(reason), {
        route: '/api/chat', userId: user.id, extra: { stage: 'mcpPermissionMissing' },
      });
      const detail = captureError({ errorId: fabErr.errorId, cause: new Error(reason), type: fabErr.type, connector: 'Connectors', toolName: 'authorize' });
      import('@/shared/lib/errors/error-audit').then((m) =>
        m.recordError(fabErr, { userId: user.id, route: '/api/chat', method: 'POST', technicalMessage: reason, requestContext: detail as unknown as Record<string, unknown> }),
      ).catch(() => {});
      preflightFailures.push(detail);
    }
    perf.mark('mcpAuthzQuery');

    // Load MCP tools if any authorized connections are active
    if (authorizedMcpIds.length > 0) {
      console.log(`[Chat] Loading MCP tools from ${authorizedMcpIds.length} authorized connections`);
      try {
        const { tools: mcpTools, descriptions, groups, unusable } = await loadActiveMcpToolsWithDescriptions(authorizedMcpIds, user.id);

        /*
         * A connector the user SELECTED that produced no tools.
         *
         * Nothing threw — the connector is simply not usable (never tested, no
         * tools discovered, deleted, or its last attempt failed). The old code
         * logged a line and carried on, so the model answered with fewer tools
         * than the user believed it had, or none at all, and the answer looked
         * authoritative. This is the "why can't it find my data" case.
         */
        for (const u of unusable) {
          const fabErr = FabOrchError.lambdaMcpCrash(new Error(u.reason), {
            route: '/api/chat',
            userId: user.id,
            extra: { stage: 'connectorUnusable', connectionId: u.connectionId },
          });
          const detail = captureError({
            errorId: fabErr.errorId,
            cause: new Error(u.reason),
            type: fabErr.type,
            connector: u.name,
            toolName: 'loadTools',
          });
          logger.warn('[Chat] connector produced no tools', {
            route: '/api/chat',
            userId: user.id,
            connector: u.name,
            reason: u.reason,
          });
          const prior = priorConnectorRecord(u.connectionId, u.reason, fabErr.errorId);
          if (prior) {
            (detail as { errorId: string }).errorId = prior; // same cause, already on record
          } else {
            import('@/shared/lib/errors/error-audit').then((m) =>
              m.recordError(fabErr, {
                userId: user.id,
                route: '/api/chat',
                method: 'POST',
                technicalMessage: u.reason,
                requestContext: detail as unknown as Record<string, unknown>,
              }),
            ).catch(() => {});
          }
          preflightFailures.push(detail);
        }
        const mcpToolCount = Object.keys(mcpTools).length;
        if (mcpToolCount > 0) {
          Object.assign(tools, mcpTools);
          mcpGroups = groups;
          // Cache breakpoint on the LAST tool definition. Tools sit first in
          // Anthropic's cacheable prefix (tools -> system -> messages), so this
          // one covers the entire tool block — the largest stable chunk of the
          // request, re-sent on every step of every turn.
          //
          // Deliberately an MCP tool: provider-executed tools (code_execution,
          // web_search) take a different path in the provider and never consume
          // a breakpoint, so marking one would silently do nothing.
          const lastMcpTool = Object.keys(mcpTools).at(-1);
          if (lastMcpTool && tools[lastMcpTool]) {
            tools[lastMcpTool] = {
              ...tools[lastMcpTool],
              providerOptions: {
                ...(tools[lastMcpTool].providerOptions ?? {}),
                anthropic: {
                  ...(tools[lastMcpTool].providerOptions?.anthropic ?? {}),
                  cacheControl: { type: 'ephemeral' as const },
                },
              },
            };
            console.log(`[Chat] Cache breakpoint on tool block (last: ${lastMcpTool})`);
          }
          mcpToolDescriptions = descriptions;
          console.log(`[Chat] Successfully loaded ${mcpToolCount} MCP tools:`, Object.keys(mcpTools));
          console.log(`[Chat] MCP tool descriptions for prompt:`, descriptions.map(d => d.name));
        } else {
          console.log(`[Chat] No MCP tools loaded. Ensure connections are tested and tools are discovered.`);
        }
      } catch (error) {
        /*
         * The connectors could not be loaded, so the model is about to answer
         * this question with NO tools — it will say it cannot find the data,
         * or worse, answer from memory. That is the most misleading failure in
         * the product and it was only ever a console line.
         *
         * Capture it so the reader is told the connectors are unavailable and
         * why, instead of receiving a confident answer built on nothing.
         */
        console.error('[Chat] Error loading MCP tools:', error);
        const fabErr = FabOrchError.lambdaMcpCrash(error, {
          route: '/api/chat',
          userId: user.id,
          extra: { stage: 'loadMcpTools', activeMcpIds },
        });
        const detail = captureError({
          errorId: fabErr.errorId,
          cause: error,
          type: fabErr.type,
          connector: 'Connected systems',
          toolName: 'loadMcpTools',
        });
        logger.fabOrchError(fabErr, { route: '/api/chat', userId: user.id });
        import('@/shared/lib/errors/error-audit').then((m) =>
          m.recordError(fabErr, {
            userId: user.id,
            route: '/api/chat',
            method: 'POST',
            technicalMessage: detail.message ?? null,
            requestContext: detail as unknown as Record<string, unknown>,
          }),
        ).catch(() => {});
        preflightFailures.push(detail);
      }
      perf.mark('mcpToolLoad');
    }

    // Multi-server: when more than one data server is connected the system prompt
    // carries the scope rules, and `select_server` lets the model record the
    // user's answer to "which server?" so it sticks for the conversation.
    if (mcpGroups.length > 1) {
      if (conversationId) {
        selectedConnectionId =
          (await prismaDb.conversation.findUnique({ where: { id: conversationId }, select: { selectedConnectionId: true } }))
            ?.selectedConnectionId ?? null;
        // Stored as one id or several comma-separated; keep only ids still connected.
        if (selectedConnectionId) {
          const kept = selectedConnectionId.split(',').filter((id) => mcpGroups.some((g) => g.connectionId === id));
          selectedConnectionId = kept.length ? kept.join(',') : null;
        }
      }
      const serverIds = mcpGroups.map((g) => g.connectionId);
      tools.select_server = tool({
        description:
          'Record which connected data server(s) the user chose for this conversation (after you asked "which server?"). ' +
          'Call it once with the id(s) from <multi-server-rules>; later scoped questions then use those servers without asking again. ' +
          'Several ids = the user wants those servers together: query each and label the results. ' +
          'Do not call it for cross-server questions the user phrased as "all servers".',
        inputSchema: z.object({
          connectionIds: z.array(z.string()).min(1).describe('Server id(s) from the multi-server list, in the order the user picked them.'),
        }),
        execute: async ({ connectionIds: picked }: { connectionIds: string[] }) => {
          // A wrong id is the model's own slip, fixed on its next step from the
          // list below. It is not a system failure, so it must not raise an
          // error card ('retry', not 'error').
          const chosen = [...new Set(picked)];
          const unknown = chosen.filter((id) => !serverIds.includes(id));
          if (unknown.length) return { status: 'retry', message: `Unknown server id(s): ${unknown.join(', ')} — use only these ids.`, servers: mcpGroups.map((g) => ({ id: g.connectionId, name: g.name })) };
          const servers = chosen.map((id) => { const g = mcpGroups.find((x) => x.connectionId === id)!; return { id: g.connectionId, name: g.name }; });
          if (conversationId) {
            try {
              // Several ids are stored comma-separated in the single text column.
              await prismaDb.conversation.update({ where: { id: conversationId }, data: { selectedConnectionId: chosen.join(',') } });
            } catch (e) {
              // The choice still applies to this reply; it just will not be
              // remembered, so the user would be asked again next time with no
              // reason given. Record why, and tell the model so it can say so.
              recordSilentFailure(e, { stage: 'rememberServerChoice', system: 'Conversation storage', userId: user.id, route: '/api/chat' });
              return { status: 'ok', servers, remembered: false, note: 'Using these servers for this reply, but the choice could not be saved for later questions.' };
            }
          }
          return { status: 'ok', servers };
        },
      });
    }

    // Clickable clarifying questions. The model calls ask_user instead of writing
    // "A, B or C?" as a bullet list; the chat renders the options as a card the
    // user picks from with a click or the keyboard, and the pick comes back as
    // the next user message. The tool does nothing server-side — it exists so the
    // choices arrive as structured data, and the turn stops on it (stopWhen) so
    // the model cannot carry on as though the user had already answered.
    // Only offered to clients that render it; anywhere else the question would
    // be invisible.
    if (interactiveChoices) {
      tools.ask_user = tool({
        description:
          'Ask the user to choose between a few concrete options, shown as clickable choices. ' +
          'Use it whenever you would otherwise write "which one: A, B or C?" — which site/server, which time range, which metric, which format. ' +
          'Up to 4 questions in one call when several things are unclear; 2–6 options each, the most likely first. ' +
          'The user can always type their own answer instead, so never add an "Other" option. ' +
          'After calling it, end your turn: write nothing more. Their answer arrives as the next message.',
        inputSchema: z.object({
          questions: z.array(z.object({
            question: z.string().describe('The full question, ending with "?".'),
            // No hard max: an over-long label is truncated by the card; a
            // schema rejection would fail the whole question over cosmetics.
            header: z.string().optional().describe('1–3 word tab label, e.g. "Site", "Period".'),
            options: z.array(z.object({
              label: z.string().describe('Short choice text, 1–6 words.'),
              description: z.string().optional().describe('One line on what picking it means.'),
            })).min(2).max(8),
            multiSelect: z.boolean().optional().describe('True when several options may be picked together.'),
          })).min(1).max(4),
        }),
        execute: async () => ({
          status: 'shown_to_user',
          note: 'The choices are on screen. End your turn now; the answer arrives as the next user message.',
        }),
      });
    }

    // Supported MIME types for inline file parts (Anthropic API):
    // - Images: image/jpeg, image/png, image/gif, image/webp
    // - Documents: application/pdf, text/plain
    // Unsupported types (xlsx, docx, pptx, csv) must use code execution tool via container_upload.
    const SUPPORTED_INLINE_MIMES = new Set([
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/pdf', 'text/plain',
    ]);

    // Collect unsupported files for container_upload (will be uploaded to Files API)
     
    const containerUploadFiles: Array<{ data: string; filename: string; mediaType: string }> = [];

    // Sanitize messages before converting — strip parts that convertToModelMessages can't handle
    // (e.g. tool-memory, tool-code_execution, file-download, step-start loaded from DB)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sanitizedMessages = uiMessages.map((msg: any) => {
      if (!msg.parts || !Array.isArray(msg.parts)) return msg;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resultParts: any[] = [];
      for (const part of msg.parts) {
        const type = part?.type as string;
        if (!type) continue;

        if (type === 'file') {
          const mime = (part.mediaType || '') as string;
          if (SUPPORTED_INLINE_MIMES.has(mime)) {
            // Supported inline — keep the file part as-is
            resultParts.push(part);
          } else if (part.url && msg.role === 'user') {
            // Unsupported (xlsx, docx, pptx, csv) — collect for Files API upload + container_upload
            containerUploadFiles.push({
              data: part.url as string, // data:... URL
              filename: part.filename || 'file',
              mediaType: mime,
            });
            // Add text hint so the model knows a file is available in the sandbox
            resultParts.push({
              type: 'text',
              text: `[File "${part.filename || 'file'}" (${mime}) has been uploaded to the sandbox. Use code execution to read and process it.]`,
            });
          }
          continue;
        }

        // Keep standard parts. Reasoning is deliberately dropped: a thinking
        // block is only accepted back with its original signature, which is
        // bound to the model that produced it — replaying it after a model
        // switch (or any edit) fails with "thinking blocks ... cannot be
        // modified", and a fresh user turn never needs previous-turn thinking.
        if (type === 'text' || type === 'tool-invocation' || type === 'tool-result') {
          resultParts.push(part);
        }
        // An ask_user card would be dropped with the other tool-* parts, leaving
        // the next turn with a bare "Both" and no record of the question. Replay
        // it as text so the model knows what the user was answering.
        if (type === 'tool-ask_user' && msg.role === 'assistant' && part.input?.questions) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const qs = (part.input.questions as any[]).map((q) =>
            `${q.question} Options: ${(q.options ?? []).map((o: { label: string }) => o.label).join(' / ')}`);
          resultParts.push({ type: 'text', text: `[I asked the user, as clickable choices]\n${qs.join('\n')}` });
        }
        // Drop everything else (reasoning, tool-*, step-start, file-download, data-*, source-*, etc.)
      }
      // Ensure at least one text part exists
      if (resultParts.length === 0 && msg.content) {
        resultParts.push({ type: 'text', text: msg.content });
      }
      return { ...msg, parts: resultParts };
    });

    // Upload unsupported files to Anthropic Files API for container_upload
    const containerUploadFileIds: Array<{ fileId: string; filename: string }> = [];
    if (containerUploadFiles.length > 0) {
      const filesClient = getAnthropicFilesClient();
      for (const file of containerUploadFiles) {
        try {
          // Extract base64 data from data URL (data:mime;base64,XXXXX)
          const base64Match = file.data.match(/^data:[^;]+;base64,(.+)$/);
          if (!base64Match) continue;
          const buffer = Buffer.from(base64Match[1], 'base64');
          const blob = new Blob([buffer], { type: file.mediaType });
          const uploadFile = new File([blob], file.filename, { type: file.mediaType });
          const uploaded = await filesClient.beta.files.upload({ file: uploadFile });
          containerUploadFileIds.push({ fileId: uploaded.id, filename: file.filename });
          console.log(`[Chat] Uploaded file for container: ${file.filename} → ${uploaded.id}`);
        } catch (err) {
          /*
           * This attachment never reached the model. Without saying so, the
           * answer silently ignores a file the user explicitly provided — they
           * have no way to tell it was dropped.
           */
          console.error(`[Chat] Failed to upload file ${file.filename}:`, err);
          const fabErr = FabOrchError.lambdaMcpCrash(err, {
            route: '/api/chat',
            userId: user.id,
            extra: { stage: 'containerUpload', filename: file.filename },
          });
          const detail = captureError({
            errorId: fabErr.errorId,
            cause: err,
            type: fabErr.type,
            connector: 'File upload',
            toolName: 'containerUpload',
            toolArgs: { filename: file.filename, mediaType: file.mediaType },
          });
          logger.fabOrchError(fabErr, { route: '/api/chat', userId: user.id });
          import('@/shared/lib/errors/error-audit').then((m) =>
            m.recordError(fabErr, {
              userId: user.id,
              route: '/api/chat',
              method: 'POST',
              technicalMessage: detail.message ?? null,
              requestContext: detail as unknown as Record<string, unknown>,
            }),
          ).catch(() => {});
          preflightFailures.push(detail);
        }
      }
    }

    // Convert UI messages to model messages format, then drop any orphaned
    // tool_use / tool_result blocks (e.g. an interrupted server-side code
    // execution replayed from history) so Anthropic doesn't 400 the request.
    perf.mark('anthropicFileUpload');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages = cleanToolMessages(await convertToModelMessages(sanitizedMessages as any));
    perf.mark('convertMessages');

    // The last user message — the glossary block below attaches to it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lastUserMsg = [...messages].reverse().find((m: any) => m.role === 'user');
    const lastUserText = Array.isArray(lastUserMsg?.content)
      ? lastUserMsg.content
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((c: any) => c?.type === 'text')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((c: any) => c.text as string)
          .join('\n')
      : typeof lastUserMsg?.content === 'string'
        ? lastUserMsg.content
        : '';
    // ── Fab shorthand glossary ────────────────────────────────────────────
    // Attach the meaning of whichever shortforms this message used, so any
    // turn reads them the way the fab floor does. Appended to the last user
    // message (not the system prompt) so it never busts the cached prefix.
    if (lastUserMsg && lastUserText) {
      const glossary = glossaryBlock(lastUserText);
      if (glossary) {
        if (Array.isArray(lastUserMsg.content)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (lastUserMsg.content as any[]).push({ type: 'text' as const, text: glossary });
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (lastUserMsg as any).content = `${lastUserText}\n\n${glossary}`;
        }
        logger.info(`[Chat] Alias glossary attached (${glossary.split('\n').length - 4} term(s))`);
      }
    }

    // Use a custom provider with transformRequestBody when we have container uploads
    const modelProvider = containerUploadFileIds.length > 0
      ? createAnthropicWithContainerUploads(containerUploadFileIds.map(f => f.fileId))
      : anthropic;

    // Log available tools
    const toolNames = Object.keys(tools);
    const hasTools = toolNames.length > 0;
    console.log(`[Chat] Available tools (${toolNames.length}):`, toolNames);

    // Collect every S3 file in this conversation so the model always has the
    // file's real URL — the current turn's uploads plus any earlier uploads
    // recorded in message metadata. Presigned URLs are regenerated fresh each
    // turn (the underlying object persists; only the signed URL expires).
    const s3RefMap = new Map<string, { filename: string; mediaType?: string }>();
    for (const r of currentS3Refs) s3RefMap.set(r.key, { filename: r.filename, mediaType: r.mediaType });
    if (conversationId) {
      try {
        const saved = await getMessages(conversationId);
        for (const m of saved) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const s3 = (m as any).metadata?.s3Files;
          if (Array.isArray(s3)) {
            for (const f of s3) {
              if (f?.key && !s3RefMap.has(f.key)) {
                s3RefMap.set(f.key, { filename: f.filename, mediaType: f.mediaType });
              }
            }
          }
        }
      } catch (e) {
        logger.warn('[Chat] Could not load conversation for S3 file refs', {
          route: '/api/chat',
          cause: e instanceof Error ? e.message : String(e),
        });
      }
    }
    perf.mark('historyLoad');
    const promptFileRefs = await Promise.all(
      [...s3RefMap.entries()].map(async ([key, meta]) => ({
        filename: meta.filename,
        mediaType: meta.mediaType,
        url: await presignKey(key),
      }))
    );

    perf.mark('s3Presign');

    // ── Uploaded-file URLs ────────────────────────────────────────────────
    // Attached to the last user message, NOT the system prompt: presigned URLs
    // change every request, and a volatile system prefix disabled prompt caching
    // for the entire turn. See buildUploadedFilesBlock.
    if (lastUserMsg && promptFileRefs.length > 0) {
      const filesBlock = buildUploadedFilesBlock(promptFileRefs);
      if (Array.isArray(lastUserMsg.content)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (lastUserMsg.content as any[]).push({ type: 'text' as const, text: filesBlock });
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (lastUserMsg as any).content = `${lastUserText}\n\n${filesBlock}`;
      }
      logger.info(`[Chat] Uploaded-file block attached (${promptFileRefs.length} file(s))`);
    }

    const buildStream = () => {
    // Build dynamic system prompt with available tools (+ this conversation's S3 file URLs)
    const systemPrompt = buildSystemPromptWithTools(toolNames, mcpToolDescriptions, { groups: mcpGroups, selectedConnectionId });
    console.log(`[Chat] System prompt includes ${mcpToolDescriptions.length} MCP tool descriptions (${promptFileRefs.length} S3 file(s) carried on the user message)`);

    // Fit messages within the context window (trim tool results + drop old groups)
    const fittedMessages = fitMessagesToContextWindow(messages, systemPrompt);

    // ── Prompt caching (Anthropic, via AI SDK `cacheControl`) ──
    // Cache the large stable prefix (tools + system) and the growing
    // conversation history so repeat turns read them at ~0.1x instead of full
    // input price, and shave time-to-first-token. Prompt caching is a PREFIX
    // match: any byte change before a breakpoint wastes the cache write.
    //
    // Presigned S3 URLs used to live in the system prompt, which made that
    // prefix volatile and forced caching OFF for every turn with an attachment.
    // They now ride on the last user message instead (see
    // buildUploadedFilesBlock), so the system prefix is byte-stable and caching
    // stays on — attachments included.
    const cacheEnabled = fittedMessages.length > 0;
    const ephemeral = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let outboundMessages: any[] = fittedMessages;
    if (cacheEnabled) {
      // Anthropic allows FOUR cache breakpoints and reads the longest matching
      // prefix. We spend them on the four boundaries that are stable for
      // different lengths of time:
      //
      //   1. the tool block           (set above, on the last MCP tool)
      //   2. the system prompt        (stable for the life of the deployment)
      //   3. the end of PRIOR history (stable for the whole of this turn)
      //   4. the current last message (stable across this turn's tool loop)
      //
      // #3 is the one that matters for the slow turns. A multi-step turn re-sends
      // its whole context on every step — the 5k-output bucket averages ~682k
      // input tokens against a 200k window — so without a breakpoint behind the
      // growing tail, each step reprocesses the entire conversation cold.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mark = (m: any) => ({
        ...m,
        providerOptions: { ...(m?.providerOptions ?? {}), ...ephemeral },
      });

      const msgs = [
        { role: 'system', content: systemPrompt, providerOptions: ephemeral },
        ...fittedMessages,
      ];
      // Second-to-last message = the end of everything that existed before this
      // turn started. Skipped when there is no prior history to cache, so a
      // breakpoint is never wasted on a one-message conversation.
      if (msgs.length >= 3) {
        msgs[msgs.length - 2] = mark(msgs[msgs.length - 2]);
      }
      msgs[msgs.length - 1] = mark(msgs[msgs.length - 1]);
      outboundMessages = msgs;
    }
    console.log(`[Chat] Prompt caching ${cacheEnabled ? `ENABLED (${outboundMessages.length >= 3 ? 3 : 2} message breakpoints + tool block)` : 'disabled (no messages)'}`);

    // Build streamText configuration
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // Every ~8 tool calls without a word to the user, the next model call is
    // asked for a short progress note first (shared/lib/progress-nudge.ts).
    const progress = createProgressNudge();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const streamConfig: Record<string, any> = {
      model: modelProvider(modelId),
      // When caching, the system prompt is carried as a leading system message
      // (with a cache breakpoint) instead of the top-level `system` field.
      ...(cacheEnabled ? {} : { system: systemPrompt }),
      messages: outboundMessages,
      /*
       * `maxOutputTokens`, not the v4 name `maxTokens` — SDK v6 silently ignores
       * the old key. With it ignored, @ai-sdk/anthropic falls back to its own
       * table, which does not know the Claude 5 ids and caps them at 4,096
       * tokens INCLUDING thinking: long answers were cut off, and a turn could
       * spend the whole budget thinking and write no answer at all.
       */
      maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
      // `temperature` is deprecated/unsupported on the current Claude model
      // generation (Opus 4.8, Sonnet 5, Opus 4.7) — sending it makes the API
      // reject the request. We omit it and let the model use its default
      // sampling. Per-model thinking (adaptive/manual/none) is set below in
      // providerOptions.anthropic instead.
      // Before each step, strip errored/orphaned server-tool blocks (e.g. a failed
      // code_execution whose error result the SDK packs inline) so Anthropic never
      // sees a `bash_code_execution` tool_use without a valid result. (vercel/ai #11855)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prepareStep: ({ messages: stepMessages }: { messages: any[] }) => {
        const cleaned = progress.messages(cleanToolMessages(stepMessages));
        return cleaned === stepMessages ? {} : { messages: cleaned };
      },
      // Log tool calls for debugging - this is called after each step (including tool executions)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onStepFinish: (event: any) => {
        progress.stepFinished(event);
        // Each step = one model call + the tools it triggered. Marking it names
        // where a slow MCP round-trip or code-execution container actually sat.
        const stepToolNames = (event?.toolCalls ?? [])
          .map((tc: { toolName?: string }) => tc.toolName || 'unknown')
          .join('+');
        perf.mark(stepToolNames ? `step:${stepToolNames}` : 'step:text');
        console.log(`[Chat] ========== STEP FINISHED ==========`);
        console.log(`[Chat] Step type: ${event.stepType}`);
        console.log(`[Chat] Finish reason: ${event.finishReason}`);

        if (event.toolCalls && event.toolCalls.length > 0) {
          console.log(`[Chat] Tool calls made:`, event.toolCalls.map((tc: Record<string, unknown>) => ({
            name: tc.toolName,
            args: JSON.stringify(tc.args ?? {}).substring(0, 200)
          })));
        }

        if (event.toolResults && event.toolResults.length > 0) {
          console.log(`[Chat] Tool results received:`);
          event.toolResults.forEach((tr: Record<string, unknown>, i: number) => {
            const trResult = tr.result;
            const resultStr = trResult === undefined || trResult === null
              ? '(no result)'
              : typeof trResult === 'string'
                ? trResult.substring(0, 300)
                : JSON.stringify(trResult).substring(0, 300);
            console.log(`[Chat]   Result ${i + 1} (${tr.toolName || 'unknown'}):`, resultStr);
            // Log file_ids from code execution results
            if (trResult && typeof trResult === 'object') {
              const resultObj = trResult as Record<string, unknown>;
              const content = resultObj.content as Array<Record<string, unknown>> | undefined;
              if (content && Array.isArray(content) && content.length > 0) {
                const fileIds = content.filter(c => c.file_id).map(c => c.file_id);
                if (fileIds.length > 0) {
                  console.log(`[Chat]   File IDs in result:`, fileIds);
                }
              }
            }
          });
        }

        if (event.text) {
          console.log(`[Chat] Text generated: ${event.text.substring(0, 200)}...`);
        }
        console.log(`[Chat] ========================================`);
      },
    };

    // Add tools if any are defined
    if (hasTools) {
      streamConfig.tools = tools;
      // Enable multi-step tool calls - model continues after tool results until done
      // ask_user hands the turn back to the user, so the loop ends once the
      // question is actually on screen — not when a malformed call errored,
      // which the model should get the chance to fix.
      streamConfig.stopWhen = [stepCountIs(CHAT_MAX_STEPS), askUserShown];
      console.log(`[Chat] Tools attached to model config:`, Object.keys(tools));
    }

    // Build anthropic provider options
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anthropicOptions: Record<string, any> = {};

    if (thinkingMode === 'adaptive') {
      anthropicOptions.thinking = { type: 'adaptive' };
      const effort = resolveEffort(modelId);
      anthropicOptions.effort = effort;
      console.log(`[Chat] Adaptive thinking enabled (effort: ${effort})`);
    } else if (thinkingMode === 'manual') {
      anthropicOptions.thinking = { type: 'enabled', budgetTokens: manualThinkingBudget };
      console.log(`[Chat] Manual thinking enabled (budget: ${manualThinkingBudget})`);
    }

    // Agent skills for code execution (always enabled)
    anthropicOptions.container = {
      skills: [
        { type: 'anthropic', skillId: 'pptx', version: 'latest' },
        { type: 'anthropic', skillId: 'docx', version: 'latest' },
        { type: 'anthropic', skillId: 'pdf', version: 'latest' },
        { type: 'anthropic', skillId: 'xlsx', version: 'latest' },
        /*
         * The custom skill, when this deployment has one.
         *
         * A custom skill id belongs to ONE Anthropic workspace. It used to be
         * hardcoded here, which silently bound the whole app to that workspace:
         * point the API key anywhere else and Anthropic rejects EVERY chat
         * request with HTTP 400 "Skill not found" — one bad id in the list
         * fails the entire request, before the model runs. That is exactly what
         * happens on any machine using a different key.
         *
         * Read from the environment instead, so each deployment supplies its
         * own (and a deployment without one simply omits it).
         *
         * ⚠️ PRODUCTION MUST SET THIS or it loses the skill:
         *      ANTHROPIC_CUSTOM_SKILL_ID=skill_01JcCJjnPE6Pah8SceXsBy6P
         */
        ...(process.env.ANTHROPIC_CUSTOM_SKILL_ID
          ? [{ type: 'custom' as const, skillId: process.env.ANTHROPIC_CUSTOM_SKILL_ID }]
          : []),
      ],
    };

    streamConfig.providerOptions = { anthropic: anthropicOptions };

    // Record each tool's execution time so the prompt-audit row can carry it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    streamConfig.experimental_onToolCallFinish = (event: any) => {
      const id = event?.toolCall?.toolCallId;
      if (!id) return;
      const name = event?.toolCall?.toolName ?? 'unknown';
      const durationMs = Math.round(event?.durationMs ?? 0);
      const stepNumber = event?.stepNumber ?? -1;
      const success = event?.success !== false;
      toolTimings.set(id, { durationMs, stepNumber, success });
      // Same measurement into the phase timer, which derives the concurrency
      // view (waited vs serial vs straggler blocking) across the whole turn.
      perf.recordTool(name, durationMs, success, stepNumber);
    };

    // Time-to-first-token: the first chunk off the model stream is what the user
    // perceives as "the response started". markFirstToken() no-ops after the
    // first call, so this is safe to fire on every chunk.
    streamConfig.onChunk = () => perf.markFirstToken();

    /*
     * ROOT CAUSE, NOT THE WRAPPER.
     *
     * When the model stream fails, the UI stream's own `onError` receives the
     * AI SDK's outer error — typically "No output generated. Check the stream
     * for errors." The error that actually explains it (e.g. the provider's
     * "Skill not found: skill_01Jc…") is delivered HERE first, and was
     * previously only logged by the SDK and dropped.
     *
     * We keep the first one we see and prefer it downstream, so the user is
     * told what really happened rather than that nothing was produced.
     */
    streamConfig.onError = (e: unknown) => {
      const err = (e as { error?: unknown })?.error ?? e;
      if (!rootStreamError) rootStreamError = err;
      logger.fabOrchError(err, { route: '/api/chat', userId: user.id, model: modelId });
    };

    // Propagate container ID between steps for code execution continuity — on
    // top of the message clean-up and the progress note, which this used to
    // replace outright.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    streamConfig.prepareStep = async (options: any) => {
      const forwarded = (await forwardAnthropicContainerIdFromLastStep(options)) ?? {};
      const cleaned = progress.messages(cleanToolMessages(options.messages));
      return cleaned === options.messages ? forwarded : { ...forwarded, messages: cleaned };
    };

    // Create the streaming response using createUIMessageStream
    // This keeps the HTTP response open so we can merge the AI stream,
    // then write file-download data chunks after completion - all in one response.
    // DB persistence uses onFinish which receives responseMessage.parts — the exact
    // parts the client saw (including step-start, interleaved text/tool parts).
    perf.mark('streamSetup');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return streamText(streamConfig as any);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = buildStream();
    // Issue 18: Ensure backend completes even if client disconnects
    result.consumeStream();

    // Shared state between execute and onFinish
    /*
     * HAS THIS TURN BEEN WRITTEN DOWN YET?
     *
     * Persistence lives in the UI stream's `onFinish`, and that callback is tied
     * to the HTTP RESPONSE: if the browser goes away mid-turn — navigating to
     * another page, closing the tab, a flaky network — the stream is cancelled
     * and `onFinish` never runs. `result.consumeStream()` above keeps the MODEL
     * running to completion, but nothing was recording the outcome, so the turn
     * vanished: no assistant message, and a `prompt_audit_logs` row left PENDING
     * for ever.
     *
     * MEASURED: a 3.1-minute deck build was lost exactly this way, and eight
     * rows were already stuck PENDING before it — one of them another
     * "Create a PPT" request. Long turns are precisely when someone switches
     * tab, so the bug bites hardest where the work cost the most.
     *
     * This flag is the idempotency guard for the watchdog registered after the
     * response is returned. Whichever path finishes first writes; the other sees
     * this and does nothing.
     */
    let turnPersisted = false;

    /** First error raised by the model stream — the root cause behind the AI
     *  SDK's generic wrapper. Set by streamConfig.onError, read in the UI
     *  stream's onError so the user is told what actually failed rather than
     *  that nothing was produced. */
    let rootStreamError: unknown = null;
    const fileDownloadParts: Array<Record<string, unknown>> = [];

    // One id for the assistant message across the stream (`start` chunk → client
    // useChat), onFinish's responseMessage, and the persisted row — so the client
    // can reference the message (pin an artifact for scheduling) before a reload.
    const assistantMessageId = randomUUID();

    const stream = createUIMessageStream({
      generateId: () => assistantMessageId,
      execute: async ({ writer }) => {
        // Anything that degraded this turn before the model started.
        for (const f of preflightFailures) {
          try {
            writer.write({ type: 'data-errorDetail', data: f });
          } catch { /* stream already closed — the record is in the DB */ }
        }

        // Keep-alive: send SSE comments every 15s to prevent AWS App Runner
        // from dropping the connection during long tool executions or thinking.
        const keepAlive = setInterval(() => {
          try {
            writer.write({ type: 'data-keepalive', data: {} });
          } catch {
            // Stream already closed
            clearInterval(keepAlive);
          }
        }, 15_000);

        try {
        // 1. Merge AI stream (tokens flow to client in real-time).
        writer.merge(result.toUIMessageStream({ sendStart: true, sendReasoning: true, sendSources: true, generateMessageId: () => assistantMessageId }));

        // 2. Wait for completion
        const [finalText, , steps] = await Promise.all([
          result.text, result.reasoning, result.steps,
        ]);

        // Everything up to here is time the user spends watching tokens arrive;
        // everything after is tail latency — the text has stopped but the stream
        // is still open, so the UI still looks busy.
        perf.mark('modelStream');

        /*
         * 2d. FAILURES ARE REPORTED FROM DATA, NOT FROM THE MODEL'S PROSE.
         *
         * Failed tool calls become `data-errorDetail` parts, which the UI
         * renders verbatim. The model paraphrases and softens; a data part does
         * not, and it carries the errorId the action button resolves. Shared
         * with the other two agents so all three behave identically.
         */
        const shownFailures = streamToolFailures(steps, writer, {
          userId: user.id,
          route: '/api/chat',
        });

        // 3. Extract file_ids from code_execution outputs and write to stream
        if (conversationId && steps && steps.length > 0) {
          const fileDownloads: Array<{ fileId: string; filename: string; mimeType: string; sizeBytes: number }> = [];
          const seenFileIds = new Set<string>();

          const extractFileIds = (output: unknown) => {
            if (!output || typeof output !== 'object') return;
            const obj = output as Record<string, unknown>;

            if (typeof obj.file_id === 'string' && obj.file_id.startsWith('file_') && !seenFileIds.has(obj.file_id)) {
              seenFileIds.add(obj.file_id);
              fileDownloads.push({
                fileId: obj.file_id,
                filename: (obj.file_name as string) || (obj.filename as string) || 'download',
                mimeType: (obj.file_type as string) || (obj.mime_type as string) || 'application/octet-stream',
                sizeBytes: (obj.file_size as number) || (obj.size_bytes as number) || 0,
              });
            }

            const content = obj.content as Array<Record<string, unknown>> | undefined;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (typeof block.file_id === 'string' && block.file_id.startsWith('file_') && !seenFileIds.has(block.file_id)) {
                  seenFileIds.add(block.file_id);
                  fileDownloads.push({
                    fileId: block.file_id,
                    filename: (block.file_name as string) || (block.filename as string) || 'download',
                    mimeType: (block.file_type as string) || (block.mime_type as string) || 'application/octet-stream',
                    sizeBytes: (block.file_size as number) || (block.size_bytes as number) || 0,
                  });
                }
              }
            }
          };

          // Scan tool results for file IDs
          for (const step of steps) {
            if (step.toolResults) {
              for (const tr of step.toolResults) {
                const trAny = tr as Record<string, unknown>;
                extractFileIds(trAny.result);
                extractFileIds(trAny.output);
              }
            }
          }

          // Deduplicate by filename — code execution often produces intermediate
          // and final versions of the same file with different file_ids.
          // Keep the last file_id per filename (the final version).
          const fileByName = new Map<string, typeof fileDownloads[0]>();
          for (const file of fileDownloads) {
            fileByName.set(file.filename, file);
          }
          let uniqueFiles = Array.from(fileByName.values());

          // Guard: when the model already delivered an inline HTML artifact, an
          // HTML file it ALSO wrote in the sandbox is a duplicate of the visual
          // (the app renders + downloads the artifact itself). Drop it so the
          // user doesn't see two tiles for the same content.
          if (String(finalText ?? '').includes('<antArtifact')) {
            const before = uniqueFiles.length;
            uniqueFiles = uniqueFiles.filter(
              (f) => !(/\.html?$/i.test(f.filename) || /^text\/html\b/i.test(f.mimeType)),
            );
            if (uniqueFiles.length !== before) {
              console.log(`[Chat] Dropped ${before - uniqueFiles.length} HTML file(s) duplicating an inline artifact`);
            }
          }

          // Enrich with metadata from Files API and write data chunks to stream
          for (const file of uniqueFiles) {
            try {
              const client = getAnthropicFilesClient();
              const metadata = await client.beta.files.retrieveMetadata(file.fileId);
              if (metadata.filename) file.filename = metadata.filename;
              if (metadata.mime_type) file.mimeType = metadata.mime_type;
              if (metadata.size_bytes) file.sizeBytes = metadata.size_bytes;
            } catch {
              // Use what we have from the output
            }

            console.log(`[Chat] File download: ${file.fileId} (${file.filename})`);

            // Write file-download data chunk through the SSE stream
            writer.write({
              type: 'data-fileDownload',
              data: {
                fileId: file.fileId,
                filename: file.filename,
                mimeType: file.mimeType,
                sizeBytes: file.sizeBytes,
              },
            });

            // Save for DB persistence in onFinish
            fileDownloadParts.push({
              type: 'file-download',
              fileId: file.fileId,
              filename: file.filename,
              mimeType: file.mimeType,
              sizeBytes: file.sizeBytes,
            });
          }
        }

        /*
         * 4. DID THE USER ACTUALLY GET AN ANSWER?
         *
         * A turn can close cleanly and still leave nothing usable: the step
         * limit stopped it mid-gathering, the reply ran out of tokens, a
         * filter cut it, or the model simply wrote nothing. Each used to look
         * like the assistant ignoring the question. The cause comes from the
         * SDK's own finish data (see lib/errors/turn-outcome).
         */
        const incomplete = diagnoseTurnEnd({
          steps,
          maxSteps: CHAT_MAX_STEPS,
          maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
          failuresShown: preflightFailures.length + shownFailures.length,
          filesProduced: fileDownloadParts.length,
        });
        if (incomplete) {
          recordSilentFailure(new Error(incomplete.message), {
            stage: incomplete.stage,
            system: 'Answer generation',
            userId: user.id,
            route: '/api/chat',
            writer,
          });
        }
        } finally {
          clearInterval(keepAlive);
        }
      },
      onFinish: async ({ responseMessage }) => {
        // Tail latency: between the model's last token and the stream closing.
        perf.mark('streamTail');
        // Emit + persist timings FIRST — the persistence below returns early
        // when there is no conversation, and the record must not depend on it.
        const timings = perf.snapshot({ userId: user.id, model: modelId, outcome: 'ok' });
        logger.info('perf', timings);
        if (promptAuditHandle) {
          recordPromptTimings(promptAuditHandle.rowId, timings).catch(() => {});
        }

        // Persist the message to DB using the exact parts the client received.
        // responseMessage.parts has step-start, text, tool-*, reasoning parts
        // in the correct interleaved order — matching what the streaming view showed.
        // Usage and the prompt-audit row are recorded for EVERY turn. They used
        // to sit behind an early return for turns with no conversation (the
        // cockpit's Ask panel), which left those rows PENDING forever and their
        // cost out of the analytics. Only saving the message needs a conversation.
        try {
          /*
           * A failed model stream makes result.text reject. That failure is
           * already recorded with its real cause by the stream's own error
           * path; letting it fall into the catch below added a second,
           * misleading "Conversation storage" record. Nothing to save — stop.
           */
          const text = await Promise.resolve(result.text).catch(() => null);
          if (text === null) return;
          if (conversationId) {
            // Convert the streaming parts to a serializable format for DB storage
            const streamParts = Array.isArray(responseMessage.parts) ? responseMessage.parts : [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const dbParts: Array<Record<string, unknown>> = streamParts.map((part: any) => {
              const partType = part.type as string;

              if (partType === 'text') {
                return { type: 'text', text: part.text || '' };
              }

              if (partType === 'reasoning') {
                return { type: 'reasoning', text: part.text || '' };
              }

              if (partType === 'step-start') {
                return { type: 'step-start' };
              }

              if (partType?.startsWith('tool-')) {
                return {
                  type: partType,
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input ?? part.args ?? {},
                  output: part.output ?? part.result ?? undefined,
                  state: part.state || 'output-available',
                  // Persist the measured duration so a reloaded conversation can
                  // still show what each round of tools cost. Absent for
                  // provider-executed tools, which we never time locally.
                  ...(part.toolCallId ? toolTimings.get(part.toolCallId) ?? {} : {}),
                };
              }

              if (partType === 'dynamic-tool') {
                return {
                  type: `tool-${part.toolName || 'unknown'}`,
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input ?? part.args ?? {},
                  output: part.output ?? part.result ?? undefined,
                  state: part.state || 'output-available',
                  ...(part.toolCallId ? toolTimings.get(part.toolCallId) ?? {} : {}),
                };
              }

              if (partType === 'data-errorDetail') {
                // Keep failures in the saved transcript. Every other data-* part
                // is either transport noise (keepalive) or re-added below
                // (fileDownload), but a failure must still be visible — with its
                // errorId — when the conversation is reopened later.
                return { type: 'data-errorDetail', data: part.data };
              }

              if (partType?.startsWith('data-')) {
                // data-fileDownload parts are handled separately
                return null;
              }

              // Pass through other parts (source-url, source-document, file, etc.)
              return { ...part };
            }).filter(Boolean) as Array<Record<string, unknown>>;

            // Append file-download parts at the end
            dbParts.push(...fileDownloadParts);

            // Extract plain text for the content field
            const reasoning = await result.reasoning;
            const steps = await result.steps;

            // Ensure we have at least one part
            if (dbParts.length === 0 && text) {
              dbParts.push({ type: 'text', text });
            }

            const persistedText = text;

            /* Claimed BEFORE the write, not after: check-and-set is atomic here, so
               the disconnect watchdog and this path can never both save the answer,
               and the watchdog backs off even if what follows throws. */
            if (!turnPersisted) {
              turnPersisted = true;
              // Whether, and where in the history, the answer is stored: lib/save-answer.
              await saveTurnAnswer({ conversationId, seq: turnSeq, questionId, questionAt }, {
                // Keep the stream's message id so the client can reference this
                // message (e.g. pin an artifact for scheduling) before a reload.
                ...(typeof responseMessage.id === 'string' && responseMessage.id ? { id: responseMessage.id } : {}),
                content: persistedText || '',
                parts: dbParts.length > 0 ? dbParts : [{ type: 'text', text: text || '' }],
                metadata: {
                  reasoning: reasoning || null,
                  stepsCount: steps?.length || 0,
                  model: modelId,
                },
              });
            }
          }

          // ── Record usage for Admin Console tracking ──
          try {
            const steps = await result.steps;
            let inputTokens = 0, outputTokens = 0, thinkingTokens = 0;
            let cacheReadTokens = 0, cacheCreationTokens = 0;
            for (const step of (steps || [])) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const u = (step as any).usage;
              if (u) {
                // AI SDK v6 fields: inputTokens/outputTokens (+ reasoningTokens,
                // cachedInputTokens, cacheCreationInputTokens). v5 used
                // promptTokens/completionTokens. Read v6 first, fall back to v5,
                // so usage_records (the admin usage/cost dashboard source) gets
                // real counts instead of zeros.
                inputTokens         += u.inputTokens              ?? u.promptTokens     ?? 0;
                outputTokens        += u.outputTokens             ?? u.completionTokens ?? 0;
                thinkingTokens      += u.reasoningTokens          ?? 0;
                cacheReadTokens     += u.cachedInputTokens        ?? 0;
                cacheCreationTokens += u.cacheCreationInputTokens ?? 0;
              }
            }
            const { prisma: pDb } = await import('@/shared/lib/db');
            await pDb.usageRecord.create({
              data: {
                userId: user.id,
                model: modelId,
                inputTokens,
                outputTokens,
                thinkingTokens,
                cacheReadTokens,
                cacheCreationTokens,
                conversationId: conversationId || null,
                // Column existed in the schema but was never written. Real
                // end-to-end wall time, measured from handler entry.
                requestDurationMs: Math.round(perf.elapsed()),
              },
            });
          } catch (usageErr) {
            console.error('[Chat] Usage recording failed:', usageErr);
          }
          // ── End usage recording ──

          // ── REQ-04 — finalize prompt-audit row on success ──
          if (promptAuditHandle) {
            try {
              const allSteps = await result.steps;
              const toolCalls: ToolCallSummary[] = [];
              // Per-turn token + cost bucketing:
              //   turn 1 input        → request_*
              //   turns 2..N input    → retrieval_*
              //   all turns' output   → response_*
              // Cost is priced per step using that step's own model id, so
              // mixed-model conversations (rare) are accurate.
              let requestTokens = 0, retrievalTokens = 0, responseTokens = 0;
              let requestCost = 0,   retrievalCost = 0,   responseCost = 0;
              let unknownModelLogged = false;
              const stepsList = allSteps || [];
              for (let idx = 0; idx < stepsList.length; idx++) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const s = stepsList[idx] as any;
                // Map toolCallId → server output so we can pair inputs
                // with their corresponding outputs for the audit log.
                // Vercel AI SDK v6 names them `input`/`output`; older
                // versions used `args`/`result`. Read both to stay
                // compatible across SDK upgrades.
                const resultsByCallId = new Map<string, unknown>();
                if (Array.isArray(s.toolResults)) {
                  for (const tr of s.toolResults) {
                    if (tr.toolCallId) resultsByCallId.set(tr.toolCallId, tr.output ?? tr.result);
                  }
                }
                if (Array.isArray(s.toolCalls)) {
                  for (const tc of s.toolCalls) {
                    const timing = tc.toolCallId ? toolTimings.get(tc.toolCallId) : undefined;
                    toolCalls.push({
                      name: tc.toolName || tc.name || 'unknown',
                      args: tc.input ?? tc.args,
                      // Absent for provider-executed tools — see toolTimings.
                      ...(timing ?? {}),
                      // `result` holds the FULL MCP-server response — that
                      // typically includes the SQL the MCP built + the rows.
                      // Persisted into prompt_audit_logs.tool_calls.
                      result: tc.toolCallId ? resultsByCallId.get(tc.toolCallId) : undefined,
                      toolCallId: tc.toolCallId,
                    } as ToolCallSummary & { toolCallId?: string });
                  }
                }
                if (s.usage) {
                  // SDK v6 uses inputTokens/outputTokens; legacy used
                  // promptTokens/completionTokens. Try v6 first.
                  const inTok    = s.usage.inputTokens               ?? s.usage.promptTokens     ?? 0;
                  const outTok   = s.usage.outputTokens              ?? s.usage.completionTokens ?? 0;
                  const readTok  = s.usage.cachedInputTokens         ?? 0;
                  const writeTok = s.usage.cacheCreationInputTokens  ?? 0;
                  const stepModel = s.response?.modelId || s.modelId || modelId;
                  // Prefer registry rates loaded once up front; else hardcoded.
                  const registryRate = registryRatesByModel.get(stepModel);
                  if (!registryRate && !hasPricing(stepModel) && !unknownModelLogged) {
                    logger.fabOrchError(
                      new Error(`No pricing for model "${stepModel}" — cost will be 0`),
                      { route: '/api/chat' }
                    );
                    unknownModelLogged = true;
                  }
                  const stepUsage = {
                    inputTokens: inTok,
                    outputTokens: outTok,
                    cachedInputTokens: readTok,
                    cacheCreationInputTokens: writeTok,
                  };
                  const cost = registryRate
                    ? costForTurnWithRates(registryRate, stepUsage)
                    : costForTurn(stepModel, stepUsage);
                  const stepInputTokens = inTok + readTok + writeTok;
                  if (idx === 0) {
                    requestTokens += stepInputTokens;
                    requestCost   += cost.inputCost;
                  } else {
                    retrievalTokens += stepInputTokens;
                    retrievalCost   += cost.inputCost;
                  }
                  responseTokens += outTok;
                  responseCost   += cost.outputCost;
                }
              }
              await recordPromptSuccess({
                rowId: promptAuditHandle.rowId,
                startedAtMs: promptAuditHandle.startedAtMs,
                app: promptAuditHandle.app,
                userPrompt: promptAuditUserText,
                llmResponse: text || '',
                toolCalls,
                requestTokens,
                retrievalTokens,
                responseTokens,
                requestCost,
                retrievalCost,
                responseCost,
              });
              // REQ-02 simplified — bump the activity clock now that the
              // multi-minute streaming response has finished, so a 2-min
              // chat doesn't look like 2 min of idle to the admin chat.
              if (bearerToken) bumpActivityIfActive(bearerToken).catch(() => {});
            } catch (e) {
              logger.fabOrchError(e, { route: '/api/chat', userId: user.id });
            }
          }
          // ── End REQ-04 prompt-success hook ──

        } catch (error) {
          /*
           * The answer is on screen but was NOT saved — it disappears when the
           * conversation is reopened, with nothing to explain where it went.
           * The stream has closed by now so no card can be drawn, but the
           * failure must at least be recorded rather than vanish into a
           * console line.
           */
          console.error('[Chat] Error persisting message:', error);
          recordSilentFailure(error, {
            stage: 'persistAssistantMessage',
            system: 'Conversation storage',
            userId: user.id,
          });
        }
      },
      onError: (error) => {
        // Normalize every stream error through the REQ-01 catalog so the
        // user sees a canonical message and we get a structured log line.
        const fabErr = isFabOrchError(error)
          ? error
          : (() => {
              const msg = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
              if (msg.includes('rate_limit') || msg.includes('rate limit') || msg.includes('overloaded') || msg.includes('529')) {
                return FabOrchError.lambdaMcpCrash(error, { route: '/api/chat' });
              }
              if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted')) {
                return FabOrchError.responseTimeout(error, { route: '/api/chat' });
              }
              if (msg.includes('invalid_api_key') || msg.includes('authentication') || msg.includes('credit') || msg.includes('billing')) {
                return FabOrchError.lambdaMcpCrash(error, { route: '/api/chat', extra: { reason: 'auth_or_billing' } });
              }
              return FabOrchError.lambdaMcpCrash(error, { route: '/api/chat' });
            })();
        logger.fabOrchError(fabErr, { route: '/api/chat' });
        perf.flush({ userId: user.id, model: modelId, outcome: 'stream-error', errorId: fabErr.errorId });

        /*
         * Capture what ACTUALLY failed, not just the category.
         *
         * This is the most-hit failure path in the product — any error thrown
         * while the model streams lands here — and it used to discard the real
         * cause entirely. A live example: the provider returned
         * "Skill not found: skill_01Jc…", the user was shown "The backend
         * service is temporarily unavailable. Please try again in a moment",
         * and retrying could never have helped.
         *
         * The full record goes to error_audit_logs so the action button can
         * read it back, and the real text goes into the message below.
         */
        const streamDetail = captureError({
          // Prefer the root error the model stream raised over the SDK's
          // outer wrapper, which only says that nothing was produced.
          cause: rootStreamError ?? (fabErr as { cause?: unknown }).cause ?? error,
          errorId: fabErr.errorId,
          type: fabErr.type,
          priority: fabErr.priority as 'HIGH' | 'MEDIUM',
        });
        // REQ-03 — persist stream-time errors to error_audit_logs, in full.
        import('@/shared/lib/errors/error-audit').then(m =>
          m.recordError(fabErr, {
            userId: user.id,
            route: '/api/chat',
            method: 'POST',
            technicalMessage: streamDetail.message ?? null,
            stackPreview: streamDetail.stack ?? null,
            requestContext: { ...streamDetail, model: modelId, conversationId } as unknown as Record<string, unknown>,
          })
        ).catch(() => {});
        // REQ-04 — close the prompt-audit row with the error envelope.
        if (promptAuditHandle) {
          recordPromptTimings(
            promptAuditHandle.rowId,
            perf.snapshot({ userId: user.id, model: modelId, outcome: 'stream-error', errorId: fabErr.errorId })
          ).catch(() => {});
          recordPromptFailure({
            rowId: promptAuditHandle.rowId,
            startedAtMs: promptAuditHandle.startedAtMs,
            errorEnvelope: {
              errorId: fabErr.errorId,
              type: fabErr.type,
              priority: fabErr.priority,
              userMessage: fabErr.userMessage,
            },
          }).catch(() => {});
        }
        /*
         * The client renders this as the failure text. It carries the REAL
         * cause and the errorId, because the catalog line alone ("temporarily
         * unavailable") is both unactionable and often wrong about whether a
         * retry would help. The errorId is what the action button resolves.
         */
        return `${summarizeError(streamDetail)} (errorId=${fabErr.errorId})`;
      },
    });

    /*
     * THE TURN IS WRITTEN DOWN EVEN IF NOBODY IS LISTENING.
     *
     * Detached on purpose — it must outlive the response. `result.consumeStream()`
     * already drives the model to completion when the client disconnects; this
     * awaits that completion and records the outcome if the UI stream's
     * `onFinish` never got the chance.
     *
     * The saved fallback is TEXT ONLY. `onFinish` has `responseMessage.parts` —
     * the interleaved step/tool/reasoning parts the client saw — and those exist
     * only on the stream that was cancelled. A plain-text record of what the
     * model said is a poor substitute for that and an enormous improvement on
     * losing the turn, which is what happens today.
     */
    void (async () => {
      try {
        if (!conversationId) return;
        for (let i = 0; i < 60 && !result; i++) await new Promise((r) => setTimeout(r, 1000));
        if (!result) return;

        const text: string = (await result.text) ?? '';
        /*
         * Step in ONLY when the client really went away. A fixed 5 s wait used
         * to guess instead: on a slow tail (fetching metadata for several
         * produced files) the watchdog won, claimed the save with plain text,
         * and onFinish — which has the tool parts, error cards and file tiles —
         * then skipped. Now: wait for onFinish while the client is connected;
         * after a disconnect give onFinish 5 s of grace; and if neither happens
         * within 10 minutes, save the text rather than lose the turn.
         */
        const deadline = Date.now() + 10 * 60_000;
        let disconnectedAt = 0;
        while (!turnPersisted && Date.now() < deadline) {
          if (req.signal?.aborted) {
            if (!disconnectedAt) disconnectedAt = Date.now();
            else if (Date.now() - disconnectedAt >= 5000) break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (turnPersisted) return;

        logger.info('[Chat] client disconnected mid-turn — persisting from the watchdog', {
          conversationId, model: modelId,
        });

        turnPersisted = true; // claimed before the write — see onFinish
        // Whether, and where in the history, the answer is stored: lib/save-answer.
        await saveTurnAnswer({ conversationId, seq: turnSeq, questionId, questionAt }, {
          content: text,
          parts: [{ type: 'text', text }],
          metadata: { model: modelId, persistedBy: 'disconnect-watchdog' },
        });

        /* And close the audit row, which would otherwise sit PENDING for ever
           and be counted as neither a success nor a failure. */
        if (promptAuditHandle) {
          await recordPromptSuccess({
            rowId: promptAuditHandle.rowId,
            startedAtMs: promptAuditHandle.startedAtMs,
            app: promptAuditHandle.app,
            userPrompt: promptAuditUserText,
            llmResponse: text,
          }).catch(() => { /* the message is saved; the ledger is best effort */ });
        }
      } catch (e) {
        logger.error('[Chat] disconnect watchdog failed', {
          conversationId, error: e instanceof Error ? e.message : String(e),
        });
      }
    })();

    return withKeepAlive(createUIMessageStreamResponse({
      stream,
      headers: {
        // Prevent reverse proxies (Nginx, AWS ALB, Cloudflare) from buffering SSE
        'X-Accel-Buffering': 'no',
        'Cache-Control': 'no-cache, no-transform',
      },
    }));
  } catch (error) {
    // REQ-04 — close the prompt-audit row if we opened one.
    // promptAuditHandle is declared inside the try; we re-look-up via the
    // outer let-binding pattern below if you ever extract it.
    perf.flush({ userId: user.id, outcome: 'preflight-error' });
    return handleApiError(error, req, { route: '/api/chat', userId: user.id });
  }
}

// GET endpoint to return available models
export async function GET() {
  const models = [
    { id: 'claude-sonnet-5', name: 'FabOrchestrator 1', description: 'Fast and efficient for everyday work', supportsReasoning: true },
    { id: 'claude-opus-5', name: 'FabOrchestrator 2', description: 'Strong reasoning for complex tasks', supportsReasoning: true },
    { id: 'claude-fable-5', name: 'FabOrchestrator 3', description: 'Advanced reasoning for demanding work', supportsReasoning: true },
    { id: 'claude-fable-5-1', name: 'FabOrchestrator 4', description: 'Most capable model', supportsReasoning: true },
  ];

  return Response.json({
    models,
    defaultModel: 'claude-fable-5-1'
  });
}
