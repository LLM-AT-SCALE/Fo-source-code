import { NextRequest, NextResponse } from 'next/server';
import {
  streamText,
  stepCountIs,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from 'ai';
import { anthropic, type AnthropicLanguageModelOptions } from '@ai-sdk/anthropic';
import { requireAdmin } from '@/shared/lib/auth-middleware';
import { ADMIN_SYSTEM_PROMPT } from '@/modules/admin/lib/ai/admin-system-prompt';
import { getAdminTools } from '@/modules/admin/lib/ai/admin-tools';
import { handleApiError } from '@/shared/lib/errors/api-error-handler';
import { FabOrchError, isFabOrchError } from '@/shared/lib/errors/faborch-errors';
import { logger } from '@/shared/lib/logger';
import {
  recordPromptStart,
  recordPromptSuccess,
  recordPromptFailure,
  type PromptStartHandle,
  type ToolCallSummary,
} from '@/shared/lib/prompt-audit';
import { costForTurn, hasPricing } from '@/shared/lib/model-pricing';
import { bumpActivityIfActive } from '@/shared/lib/session-audit';

export const maxDuration = 120;

/**
 * Wrap an SSE Response so a keepalive comment is emitted during idle gaps. A long
 * tool call (e.g. the ~80s on-the-fly codegen) produces NO bytes while it runs;
 * CloudFront's origin read timeout (60s, and NOT raisable past 60 without an AWS
 * quota increase) would cut the stream. A `: keepalive` comment every 20s is
 * ignored by the SSE/AI-SDK parser but keeps CloudFront + the ALB from timing out.
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

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const bearerToken = req.headers.get('Authorization')?.slice(7) ?? null;

  try {
    const body = await req.json();
    const uiMessages = body.messages || [];
    const modelId = body.model || 'claude-sonnet-5';
    const tools = getAdminTools(auth.user.id);

    // Strip tool parts from conversation history — keep only text content.
    // Tool results from previous turns are not needed; Claude will re-call tools as needed.
    // This completely avoids the tool_use/tool_result pairing issue with Anthropic's API.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textOnlyMessages = uiMessages.map((msg: any) => {
      if (!msg.parts || !Array.isArray(msg.parts)) return msg;

      // Extract only text parts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const textParts = msg.parts.filter((p: any) => p.type === 'text' && p.text?.trim());

      // If no text parts, create a summary from tool results for context
      if (textParts.length === 0 && msg.role === 'assistant') {
        // Summarize: the assistant used tools but we keep just a marker
        return {
          ...msg,
          parts: [{ type: 'text', text: '[Used admin tools to process the request]' }],
        };
      }

      return { ...msg, parts: textParts.length > 0 ? textParts : [{ type: 'text', text: '...' }] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }).filter((msg: any) => msg.parts && msg.parts.length > 0);

    // Convert cleaned UI messages to model messages (no tool parts = no pairing issues)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modelMessages = await convertToModelMessages(textOnlyMessages as any);

    // ── REQ-04 — open prompt-audit row for this admin prompt ──
    const lastUserMsg = uiMessages[uiMessages.length - 1];
    let promptText = '';
    if (lastUserMsg?.role === 'user') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts = lastUserMsg.parts as any[] | undefined;
      promptText = parts
        ?.filter((p: { type: string }) => p.type === 'text')
        .map((p: { text?: string }) => p.text || '')
        .join('') || (lastUserMsg as { content?: string }).content || '';
    }
    let promptAuditHandle: PromptStartHandle | null = null;
    if (promptText) {
      promptAuditHandle = await recordPromptStart({
        userId: auth.user.id,
        userName: auth.user.name,
        userEmail: auth.user.email,
        userPrompt: promptText,
        app: 'faborch-admin',
        model: modelId,
      });
    }
    // ── End REQ-04 prompt-start ──

    // Inject the current date so the model never invents one (REQ-02 #3 needs
    // accurate "today" semantics for queries like "all sessions for today").
    const now = new Date();
    const dateContext = `\n\n## Current date and time
- ISO UTC: ${now.toISOString()}
- Date (UTC): ${now.toISOString().slice(0, 10)}
- For "today" queries, dateFrom = "${now.toISOString().slice(0, 10)}T00:00:00Z" and dateTo = "${now.toISOString().slice(0, 10)}T23:59:59Z".
- Never assume a different date.`;
    const systemPrompt = ADMIN_SYSTEM_PROMPT + dateContext;

    // Use createUIMessageStream for proper streaming
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const result = streamText({
          model: anthropic(modelId),
          system: systemPrompt,
          messages: modelMessages,
          tools,
          maxOutputTokens: 16384,
          stopWhen: stepCountIs(10),
          providerOptions: {
            anthropic: {
              disableParallelToolUse: true,
              contextManagement: {
                edits: [
                  {
                    type: 'clear_tool_uses_20250919',
                    trigger: { type: 'tool_uses', value: 15 },
                    keep: { type: 'tool_uses', value: 3 },
                    clearAtLeast: { type: 'input_tokens', value: 1000 },
                    clearToolInputs: true,
                  },
                ],
              },
            } satisfies AnthropicLanguageModelOptions,
          },
        });

        writer.merge(result.toUIMessageStream({ sendReasoning: true }));

        // ── REQ-04 — finalize prompt-audit row when stream completes ──
        if (promptAuditHandle) {
          (async () => {
            try {
              const [text, steps] = await Promise.all([result.text, result.steps]);
              const toolCalls: ToolCallSummary[] = [];
              // Per-turn token + cost bucketing for the prompt audit columns:
              //   turn 1 input        → request_*
              //   turns 2..N input    → retrieval_*
              //   all turns' output   → response_*
              // Cost is computed using the model id reported per step so a
              // conversation that switched models is priced correctly.
              let requestTokens = 0, retrievalTokens = 0, responseTokens = 0;
              let requestCost = 0,   retrievalCost = 0,   responseCost = 0;
              let unknownModelLogged = false;
              const stepsList = steps || [];
              for (let idx = 0; idx < stepsList.length; idx++) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const s = stepsList[idx] as any;
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
                    toolCalls.push({
                      name: tc.toolName || tc.name || 'unknown',
                      args: tc.input ?? tc.args,
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
                  if (!hasPricing(stepModel) && !unknownModelLogged) {
                    logger.fabOrchError(
                      new Error(`No pricing for model "${stepModel}" — cost will be 0`),
                      { route: '/api/admin/chat' }
                    );
                    unknownModelLogged = true;
                  }
                  const cost = costForTurn(stepModel, {
                    inputTokens: inTok,
                    outputTokens: outTok,
                    cachedInputTokens: readTok,
                    cacheCreationInputTokens: writeTok,
                  });
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
                userPrompt: promptText,
                llmResponse: text || '',
                toolCalls,
                requestTokens,
                retrievalTokens,
                responseTokens,
                requestCost,
                retrievalCost,
                responseCost,
              });
              // REQ-02 simplified — bump activity after streaming completes.
              if (bearerToken) bumpActivityIfActive(bearerToken).catch(() => {});
            } catch (e) {
              logger.fabOrchError(e, { route: '/api/admin/chat', userId: auth.user.id });
            }
          })();
        }
        // ── End REQ-04 admin prompt-success hook ──
      },
      onError: (error) => {
        const fabErr = isFabOrchError(error)
          ? error
          : (() => {
              const msg = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
              if (msg.includes('timeout') || msg.includes('aborted')) return FabOrchError.responseTimeout(error, { route: '/api/admin/chat' });
              if (msg.includes('rate_limit') || msg.includes('overloaded')) return FabOrchError.lambdaMcpCrash(error, { route: '/api/admin/chat' });
              return FabOrchError.lambdaMcpCrash(error, { route: '/api/admin/chat' });
            })();
        logger.fabOrchError(fabErr, { route: '/api/admin/chat' });
        // REQ-03 — persist stream-time errors.
        import('@/shared/lib/errors/error-audit').then(m =>
          m.recordError(fabErr, { userId: auth.user.id, route: '/api/admin/chat', method: 'POST' })
        ).catch(() => {});
        // REQ-04 — close the prompt-audit row.
        if (promptAuditHandle) {
          recordPromptFailure({
            rowId: promptAuditHandle.rowId,
            startedAtMs: promptAuditHandle.startedAtMs,
            errorEnvelope: {
              errorId: fabErr.errorId, type: fabErr.type,
              priority: fabErr.priority, userMessage: fabErr.userMessage,
            },
          }).catch(() => {});
        }
        return `${fabErr.userMessage} (errorId=${fabErr.errorId})`;
      },
    });

    return withKeepAlive(createUIMessageStreamResponse({
      stream,
      headers: {
        'X-Accel-Buffering': 'no',
        'Cache-Control': 'no-cache, no-transform',
      },
    }));
  } catch (error) {
    return handleApiError(error, req, { route: '/api/admin/chat' });
  }
}
