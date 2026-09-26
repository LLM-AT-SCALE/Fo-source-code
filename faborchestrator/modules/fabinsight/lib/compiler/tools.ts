/**
 * Tools the compiler agent can call.
 *
 *   mcp_<conn8>__<tool>   the in-scope servers' OWN MCP tools, attached directly
 *                         (one server → its tools; several → all of them), so the
 *                         model can inspect the source while it writes the program.
 *   validate_program      schema + edits + bindings + tools + ONE live dry run
 *   emit_program          same validation (reuses the dry run when unchanged);
 *                         on success records the result.
 *
 * Everything closes over one compile's state so the loop in index.ts stays small.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { createHash } from 'node:crypto';

import { convertMcpToolsToAiTools, type McpTool } from '@/modules/mcp/lib/mcp-client';
import { runProgram, type RunResult } from '@/modules/fabinsight/lib/replay/execute';
import type { Program } from '@/modules/fabinsight/lib/replay/program';
import type { ResolvedServer } from '@/modules/fabinsight/lib/replay/servers';
import { validateProgram, type ServerTools, type TemplateEdit, type ValidateOutput } from './validate';

export type CompilerDeps = {
  listTools: (connectionId: string) => Promise<McpTool[]>;
  exec: (connectionId: string, toolName: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
  /** Builds the AI-SDK tools for one server (defaults to the real MCP client). Injectable for tests. */
  attach?: (tools: McpTool[], server: ResolvedServer) => Record<string, unknown>;
};

export type AttachedTool = { key: string; toolName: string; registryId: string; server: string; description: string };

export type CompilerState = {
  servers: ResolvedServer[];
  baseTemplate: string;
  now: Date;
  /** Cap on direct MCP tool calls the model may make during one compile. */
  maxMcpCalls: number;
  mcpCalls: number;
  emitted?: { program: Program; templateHtml: string; notes: string[]; verify: RunResult };
  /** Cached per-server tool lists (fetched once). */
  toolCache?: Map<string, McpTool[]>;
  /** Tools attached for the prompt's TOOL MAP. */
  attached?: AttachedTool[];
  /** Steps whose output hit the token cap (their tool call was cut off). */
  truncatedSteps?: number;
  /** Last validation, keyed by input hash, so emit_program does not re-run the dry run. */
  lastValidation?: { hash: string; result: ValidateOutput };
};

const EditSchema = z.object({ find: z.string().min(1), replace: z.string() }).strict();

async function serverToolLists(state: CompilerState, deps: CompilerDeps): Promise<{ server: ResolvedServer; tools: McpTool[] }[]> {
  state.toolCache ??= new Map();
  const out: { server: ResolvedServer; tools: McpTool[] }[] = [];
  for (const s of state.servers) {
    if (!s.connectionId) {
      out.push({ server: s, tools: [] });
      continue;
    }
    let tools = state.toolCache.get(s.connectionId);
    if (!tools) {
      try {
        tools = await deps.listTools(s.connectionId);
      } catch {
        tools = [];
      }
      state.toolCache.set(s.connectionId, tools);
    }
    out.push({ server: s, tools });
  }
  return out;
}

async function serverToolNames(state: CompilerState, deps: CompilerDeps): Promise<ServerTools[]> {
  const lists = await serverToolLists(state, deps);
  return lists.map(({ server, tools }) => ({ registryId: server.registryId, label: server.label, toolNames: tools.map((t) => t.name) }));
}

/**
 * Attach every in-scope server's MCP tools to the agent, namespaced per
 * connection (`mcp_<conn8>__<name>`), with a per-compile call cap so an
 * exploring model cannot run up an unbounded bill. Returns the tool map used
 * by the prompt: key → (server, raw toolName).
 */
export async function attachMcpTools(state: CompilerState, deps: CompilerDeps): Promise<{ tools: Record<string, unknown>; map: AttachedTool[] }> {
  const attach =
    deps.attach ??
    ((tools: McpTool[], server: ResolvedServer) =>
      convertMcpToolsToAiTools(tools, server.connectionId!, null, { registryId: server.registryId, serverUrl: server.serverUrl, name: server.label }));

  const merged: Record<string, unknown> = {};
  const map: AttachedTool[] = [];
  for (const { server, tools } of await serverToolLists(state, deps)) {
    if (!server.connectionId || !tools.length) continue;
    const built = attach(tools, server) as Record<string, { description?: string; execute?: (...a: unknown[]) => Promise<unknown> }>;
    for (const [key, def] of Object.entries(built)) {
      const raw = tools.find((t) => key.endsWith(`__${t.name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 50)}`))?.name ?? key.replace(/^mcp_[0-9a-f]{8}__/, '');
      const inner = def.execute;
      merged[key] = {
        ...def,
        execute: async (...args: unknown[]) => {
          if (state.maxMcpCalls > 0 && state.mcpCalls >= state.maxMcpCalls) {
            return { error: `compile call cap reached (${state.maxMcpCalls} data-tool calls); use the trace samples and validate_program instead`, isError: true };
          }
          state.mcpCalls++;
          console.log(`[compiler] data call ${state.mcpCalls}${state.maxMcpCalls ? `/${state.maxMcpCalls}` : ''} ${key}: ${JSON.stringify(args[0] ?? {}).slice(0, 240)}`);
          return inner ? inner(...args) : { error: 'tool has no executor', isError: true };
        },
      };
      map.push({ key, toolName: raw, registryId: server.registryId, server: server.label, description: (def.description ?? '').slice(0, 200) });
    }
  }
  state.attached = map;
  return { tools: merged, map };
}

function hashInput(input: unknown): string {
  return createHash('sha1').update(JSON.stringify(input) ?? '').digest('hex');
}

export function buildCompilerTools(state: CompilerState, deps: CompilerDeps) {
  type ValidateArgs = { program: unknown; edits?: TemplateEdit[]; templateHtml?: string; dryRun?: boolean };
  const validate = async (input: ValidateArgs, forceDryRun = false): Promise<ValidateOutput> => {
    const live = forceDryRun || input.dryRun !== false;
    const { dryRun: _ignored, ...payload } = input;
    void _ignored;
    const hash = hashInput(payload);
    // A live validation of the same payload is reused (emit after validate = one dry run).
    if (live && state.lastValidation?.hash === hash) return state.lastValidation.result;
    const servers = await serverToolNames(state, deps);
    const result = await validateProgram({
      program: payload.program,
      template: state.baseTemplate,
      edits: payload.edits,
      templateHtml: payload.templateHtml,
      servers,
      dryRun: live
        ? (program, template) => runProgram(program, template, { now: state.now, servers: state.servers, exec: deps.exec, perCallTimeoutMs: 60_000, retries: 0 })
        : undefined,
    });
    if (live) state.lastValidation = { hash, result };
    console.log(
      `[compiler] validate(${live ? 'live' : 'fast'}) ok=${result.ok} calls=${Array.isArray((payload.program as { calls?: unknown[] })?.calls) ? (payload.program as { calls: unknown[] }).calls.length : '?'} edits=${payload.edits?.length ?? 0}${payload.templateHtml ? ` templateHtml=${payload.templateHtml.length}B` : ''}` +
        (result.errors.length ? `\n  errors: ${result.errors.slice(0, 6).join(' | ').slice(0, 900)}` : '') +
        (result.warnings.length ? `\n  warnings: ${result.warnings.slice(0, 4).join(' | ').slice(0, 400)}` : ''),
    );
    return result;
  };

  const summarize = (v: ValidateOutput) => ({
    ok: v.ok,
    errors: v.errors,
    warnings: v.warnings,
    drift: v.drift,
    perServer: v.perServer.map((s) => ({ server: s.label, ok: s.ok, reason: s.reason, error: s.error })),
    notes: v.notes,
    ...(v.verify
      ? {
          dryRun: {
            sets: v.verify.sets.map((s) => ({ call: s.key, rows: s.rows.length, columns: s.columns.slice(0, 40), error: s.error })),
            kpis: v.verify.kpis,
          },
        }
      : {}),
  });

  return {
    validate_program: tool({
      description:
        'Validate a candidate program + template edits: schema, that each edit "find" is unique, that every KPI path has a data-fab-bind, that every call toolName exists on the in-scope servers, multi-server aggregate rules. With dryRun=false (fast, no data calls) it checks structure only — use it first and iterate until clean. With dryRun=true (default) it ALSO replays the program live through the real servers once (slow: every call runs) and reports drift = a path that did not resolve against the real result. Fix every error before emit_program.',
      inputSchema: z.object({
        program: z.unknown(),
        edits: z.array(EditSchema).max(200).optional().describe('Ordered {find, replace} edits applied to the base template.'),
        templateHtml: z.string().optional().describe('Whole-template replacement; only accepted for small templates (< 20 KB).'),
        dryRun: z.boolean().optional().describe('false = structural checks only (fast). true/omitted = also run the program live once.'),
      }),
      execute: async (input) => summarize(await validate(input as ValidateArgs)),
    }),

    emit_program: tool({
      description:
        'Emit the FINAL program, template edits and notes. Runs the same validation (the dry run is reused when nothing changed since validate_program); on success the compile is complete. Call exactly once, after validate_program passes.',
      inputSchema: z.object({
        program: z.unknown(),
        edits: z.array(EditSchema).max(200).optional(),
        templateHtml: z.string().optional(),
        notes: z.array(z.string().max(500)).max(50).default([]),
      }),
      execute: async (input) => {
        const { notes, ...rest } = input;
        const v = await validate(rest as ValidateArgs, true);
        if (v.ok && v.program && v.template && v.verify) {
          state.emitted = { program: v.program, templateHtml: v.template, notes: [...(notes ?? []), ...v.warnings], verify: v.verify };
          return { ok: true, message: 'program emitted' };
        }
        return summarize(v);
      },
    }),
  };
}
