/**
 * Dashboard compiler agent.
 *
 * `compileDashboard()` runs a bounded AI SDK tool loop that turns a pin
 * request (MCP call trace + approved HTML) — or a base version + instruction —
 * into a replay program and a marked template, verified by a live dry run.
 * The model never writes SQL and never retypes the HTML: it emits `edits`.
 */

import { generateText, stepCountIs, type ModelMessage } from 'ai';
import type { CompilePhase, CompileProgress } from './types';

import { anthropic } from '@/shared/lib/anthropic';
import { executeMcpTool, getMcpTools } from '@/modules/mcp/lib/mcp-client';
import { resolveServers, type ResolvedServer } from '@/modules/fabinsight/lib/replay/servers';
import { buildSystemPrompt, buildUserPrompt } from './prompt';
import { attachMcpTools, buildCompilerTools, type CompilerDeps, type CompilerState } from './tools';
import { compactTrace } from './trace';
import type { CompileInput, CompileOutput, CompileUsage } from './types';

export type { CompileInput, CompileOutput, CompileMode, CompileUsage } from './types';
export { validateProgram, applyEdits, boundPaths } from './validate';
export { compactTrace, summarizeStoredResult } from './trace';

const MAX_HTML_BYTES = 300_000;
// No step cap by default: a step is one model turn and may carry several tool
// calls, so a fixed count could cut a legitimate compile short. The timeout
// below is the safety net. Set FABINSIGHT_COMPILER_MAX_STEPS to re-enable one.
/*
 * A compile is BOUNDED. Removing the caps entirely was tried and does not work:
 * with nothing to spend, a compile ran 254 queries in 15 minutes and never even
 * tried to write the program. Successful compiles finish in ~25 steps, so the
 * budget below is generous — and, unlike a timeout, it is a number the admin
 * can be shown progress against.
 *
 * 0 disables a cap (the timeout then bounds the run on its own).
 */
const MAX_STEPS = Number(process.env.FABINSIGHT_COMPILER_MAX_STEPS ?? '40') || 0;
// Per-step output cap. A tool call is a few KB of JSON (program + short edits);
// 32k tokens of output takes ~5 minutes to generate and was the cause of the
// original compile timeouts, so keep steps small and let the loop iterate.
const MAX_OUTPUT_TOKENS = Number(process.env.FABINSIGHT_COMPILER_MAX_TOKENS ?? '10000');
const TIMEOUT_MS = Number(process.env.FABINSIGHT_COMPILER_TIMEOUT_MS ?? String(15 * 60_000));
/** Direct MCP data-tool calls per compile; 0 = unlimited (default). Set FABINSIGHT_COMPILER_MAX_MCP_CALLS to cap. */
/** Live data-tool calls one compile may spend exploring. 0 = no cap. */
const MAX_MCP_CALLS = Number(process.env.FABINSIGHT_COMPILER_MAX_MCP_CALLS ?? '15') || 0;

/*
 * KEEPING AN UNCAPPED COMPILE FROM WANDERING.
 *
 * With no step or call cap, nothing makes the model stop exploring: a compile
 * was seen running 254 queries in 15 minutes without once trying to write the
 * program, then failing on the timeout. Successful compiles finish in ~25
 * steps. A cap is the wrong cure (it cuts off a compile that was going fine);
 * what is needed is pressure to move on:
 *
 *   from NUDGE_AFTER_STEPS  every step is told what it has spent and that the
 *                           trace already holds the answers — write the program;
 *   from FORCE_AFTER_STEPS  validate_program is the ONLY tool it may call, so
 *                           exploring ends and the program gets written.
 */
const NUDGE_AFTER_STEPS = Number(
  process.env.FABINSIGHT_COMPILER_NUDGE_AFTER ?? (MAX_STEPS > 0 ? Math.ceil(MAX_STEPS * 0.5) : 12),
);
const FORCE_AFTER_STEPS = Number(
  process.env.FABINSIGHT_COMPILER_FORCE_AFTER ?? (MAX_STEPS > 0 ? Math.ceil(MAX_STEPS * 0.75) : 25),
);

function compilerModel(): string {
  return process.env.FABINSIGHT_COMPILER_MODEL || 'claude-sonnet-5';
}

export type CompileDeps = Partial<CompilerDeps> & {
  resolveServers?: (scope: CompileInput['scope']) => Promise<ResolvedServer[]>;
  /** Test hook: replaces the model loop entirely (must drive the tools itself). */
  runLoop?: (args: { system: string; messages: LoopMessage[]; tools: ReturnType<typeof buildCompilerTools> }) => Promise<CompileUsage>;
};

export type LoopMessage = ModelMessage;

function scopeText(scope: CompileInput['scope'], servers: ResolvedServer[]): string {
  const list = servers.map((s) => `${s.label} (registryId ${s.registryId}${s.connectionId ? '' : ', NOT connected'})`).join('; ');
  return scope.mode === 'all' ? `all connected servers — currently: ${list || 'none'}` : `fixed — ${list || 'none resolved'}`;
}

export async function compileDashboard(input: CompileInput, deps: CompileDeps = {}): Promise<CompileOutput> {
  let startedAt = Date.now();
  const notes: string[] = [];
  const baseHtml = input.mode === 'create' ? input.html : (input.base?.templateHtml ?? input.html);
  if (!baseHtml || !baseHtml.trim()) return { ok: false, error: 'no HTML to compile', notes };
  if (baseHtml.length > MAX_HTML_BYTES) {
    return { ok: false, error: `artifact too large to compile (${Math.round(baseHtml.length / 1024)} KB > ${MAX_HTML_BYTES / 1024} KB)`, notes };
  }
  if (input.mode !== 'create' && !input.base) return { ok: false, error: `${input.mode} needs a base program`, notes };
  if (input.mode === 'refine' && !input.instruction?.trim()) return { ok: false, error: 'refine needs an instruction', notes };

  const servers = await (deps.resolveServers ?? resolveServers)(input.scope);
  if (!servers.length) return { ok: false, error: 'no servers resolved for the connection scope', notes };
  const connected = servers.filter((s) => s.connectionId && (!s.connectionStatus || s.connectionStatus === 'connected'));
  if (!connected.length) {
    return { ok: false, error: `none of the resolved servers has a connected MCP connection (${servers.map((s) => s.label).join(', ')})`, notes };
  }
  for (const s of servers) if (!connected.includes(s)) notes.push(`server ${s.label} has no connected MCP connection and was skipped during compile`);

  const capturedAt = input.capturedAt ?? new Date();
  const state: CompilerState = {
    servers: connected,
    baseTemplate: baseHtml,
    now: capturedAt,
    maxMcpCalls: MAX_MCP_CALLS,
    mcpCalls: 0,
  };
  const toolDeps: CompilerDeps = {
    listTools: deps.listTools ?? getMcpTools,
    exec: deps.exec ?? ((connectionId, toolName, args) => executeMcpTool(connectionId, toolName, args, null)),
    attach: deps.attach,
  };
  // The in-scope servers' own MCP tools go straight into the model's tool set
  // (one server → its tools; several → all of them), next to validate/emit.
  const attached = await attachMcpTools(state, toolDeps);
  const tools = { ...attached.tools, ...buildCompilerTools(state, toolDeps) };
  for (const s of connected) {
    if (!attached.map.some((t) => t.registryId === s.registryId)) notes.push(`server ${s.label} exposed no tools to the compiler (run "Discover tools" on its connection)`);
  }

  const multi = input.scope.mode === 'all' || (input.scope.mode === 'fixed' && input.scope.servers.length > 1);
  const system = buildSystemPrompt(input.mode, input.timezone, multi, Math.round(TIMEOUT_MS / 60_000));
  const user = buildUserPrompt({
    mode: input.mode,
    reason: input.reason,
    kpis: input.kpis.map((k) => k.label),
    capturedAt: capturedAt.toISOString(),
    timezone: input.timezone,
    scopeText: scopeText(input.scope, servers),
    toolMap: attached.map,
    trace: compactTrace(input.trace),
    instruction: input.instruction,
    history: input.history,
    base: input.base ? { program: input.base.program } : undefined,
  });
  const ephemeral = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };
  const messages: LoopMessage[] = [
    { role: 'user', content: user },
    // The HTML is the large, stable block — cache it so every step re-reads it for free.
    { role: 'user', content: (input.mode === 'create' ? 'CAPTURED HTML:\n' : 'BASE TEMPLATE:\n') + baseHtml, providerOptions: ephemeral },
  ];

  let usage: CompileUsage = { inputTokens: 0, outputTokens: 0, steps: 0 };
  try {
    if (deps.runLoop) {
      usage = await deps.runLoop({ system, messages, tools });
    } else {
      startedAt = Date.now();
      console.log(`[compiler] start mode=${input.mode} servers=${connected.map((s) => s.label).join(',')} tools=${attached.map.length} html=${baseHtml.length}B trace=${input.trace.length} calls model=${compilerModel()}`);

      /*
       * Report real progress to whoever asked for it.
       *
       * A compile runs for minutes in this process while an admin watches the
       * other app. Nothing here is invented: the phase is read off the tool the
       * model just called, and the counts are the budgets actually being spent.
       * A failure to report must never break the compile, hence the try/catch.
       */
      let reportedSteps = 0;
      const report = (phase: CompilePhase, tool: string | null, inTok: number, outTok: number) => {
        if (!input.onProgress) return;
        const p: CompileProgress = {
          phase,
          step: reportedSteps,
          maxSteps: MAX_STEPS,
          dataCalls: state.mcpCalls,
          maxDataCalls: MAX_MCP_CALLS,
          elapsedMs: Date.now() - startedAt,
          timeoutMs: TIMEOUT_MS,
          tool,
          inputTokens: inTok,
          outputTokens: outTok,
          model: compilerModel(),
        };
        try {
          input.onProgress(p);
        } catch {
          /* reporting must never fail a compile */
        }
      };

      /** The phase is whatever the model just did, in the order it matters. */
      const phaseOf = (names: string[], args: Record<string, unknown>[]): CompilePhase => {
        if (names.includes('emit_program')) return 'finishing';
        if (names.includes('validate_program')) {
          // The same tool does both; only a live dry run touches the servers.
          return args.some((a) => a?.dryRun === true) ? 'dryRun' : 'checking';
        }
        return 'reading';
      };

      report('starting', null, 0, 0);
      const result = await generateText({
        model: anthropic(compilerModel()),
        system,
        messages,
        tools,
        // The tools ARE the output: every step must call one (the loop ends on
        // emit_program). Without this the model narrates instead of acting.
        toolChoice: 'required',
        /*
         * Escalating pressure to stop exploring (see the constants above).
         * `system` is overridden rather than a message appended: Anthropic takes
         * the system prompt separately, and a system message mid-conversation is
         * not accepted.
         */
        prepareStep: ({ stepNumber }) => {
          if (state.emitted) return {};
          /*
           * A program that already passed the LIVE dry run is finished work:
           * the only thing left is to emit it. One compile validated
           * successfully and then spent its remaining minutes re-validating
           * until the timeout, producing nothing.
           */
          if (state.lastValidation?.result?.ok) {
            return {
              system: `${system}

<budget>
Your program already passed the live check. Call emit_program with it NOW. Do not validate again and do not call any data tool.
</budget>`,
              toolChoice: { type: 'tool', toolName: 'emit_program' } as const,
            };
          }
          if (stepNumber < NUDGE_AFTER_STEPS) return {};
          const spent =
            `You have used ${stepNumber}${MAX_STEPS > 0 ? ` of ${MAX_STEPS}` : ''} steps ` +
            `and ${state.mcpCalls}${MAX_MCP_CALLS > 0 ? ` of ${MAX_MCP_CALLS}` : ''} data call(s).`;
          if (stepNumber < FORCE_AFTER_STEPS) {
            return {
              system: `${system}\n\n<budget>\n${spent} STOP exploring. The captured trace and its sample rows already show the tools, arguments and columns this dashboard used — rely on them for anything you have not verified yourself. Write the program NOW: call validate_program, fix what it reports, then emit_program.\n</budget>`,
            };
          }
          return {
            system: `${system}\n\n<budget>\n${spent} Exploration is over. Call validate_program with your best program built from the trace, then emit_program. Do not call any data tool again.\n</budget>`,
            toolChoice: { type: 'tool', toolName: 'validate_program' } as const,
          };
        },
        stopWhen: MAX_STEPS > 0 ? [stepCountIs(MAX_STEPS), () => !!state.emitted] : [() => !!state.emitted],
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
        providerOptions: ephemeral,
        onStepFinish: (step) => {
          const calls = step.toolCalls?.map((c) => c.toolName).join(',') || '-';
          const truncated = step.finishReason === 'length';
          console.log(`[compiler] step ${state.mcpCalls}${MAX_MCP_CALLS ? `/${MAX_MCP_CALLS}` : ''} data calls, +${Math.round((Date.now() - startedAt) / 1000)}s: tools=${calls} tokens=${step.usage?.inputTokens ?? 0}/${step.usage?.outputTokens ?? 0}${truncated ? ' TRUNCATED (output cap)' : ''}${state.emitted ? ' EMITTED' : ''}`);
          if (truncated) state.truncatedSteps = (state.truncatedSteps ?? 0) + 1;
          if ((truncated || !step.toolCalls?.length) && step.text) console.log(`[compiler] step text (first 300 chars): ${step.text.slice(0, 300).replace(/\s+/g, ' ')}`);

          reportedSteps += 1;
          const names = step.toolCalls?.map((c) => c.toolName) ?? [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const args = (step.toolCalls ?? []).map((c) => ((c as any).input ?? {}) as Record<string, unknown>);
          report(
            phaseOf(names, args),
            names[0] ?? null,
            step.usage?.inputTokens ?? 0,
            step.usage?.outputTokens ?? 0,
          );
        },
      });
      console.log(`[compiler] done in ${Math.round((Date.now() - startedAt) / 1000)}s, steps=${result.steps?.length ?? 0}, emitted=${!!state.emitted}`);
      usage = {
        inputTokens: result.totalUsage?.inputTokens ?? 0,
        outputTokens: result.totalUsage?.outputTokens ?? 0,
        steps: result.steps?.length ?? 0,
      };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Only the compile's own time budget is a "timeout". Matching /abort/ in
    // the text also caught a network call that aborted after seconds, and
    // reported it as "timed out after 15 min" — a cause that never happened.
    const timedOut =
      (e as { name?: string })?.name === 'TimeoutError' || Date.now() - startedAt >= TIMEOUT_MS - 1000;
    return {
      ok: false,
      error: timedOut
        ? `compile timed out after ${Math.round(TIMEOUT_MS / 60_000)} min`
        : `compile failed: ${msg.slice(0, 400)}`,
      notes,
      usage,
    };
  }

  if (!state.emitted) {
    const why = state.truncatedSteps
      ? `${state.truncatedSteps} step(s) hit the ${MAX_OUTPUT_TOKENS}-token output cap (tool payload too large — the template edits must stay small)`
      : MAX_STEPS > 0 ? `did not emit a valid program within ${MAX_STEPS} steps` : 'stopped without emitting a valid program';
    return { ok: false, error: `the compiler ${why}`, notes, usage };
  }
  return {
    ok: true,
    program: state.emitted.program,
    templateHtml: state.emitted.templateHtml,
    notes: [...notes, ...state.emitted.notes],
    verify: state.emitted.verify,
    usage,
  };
}
