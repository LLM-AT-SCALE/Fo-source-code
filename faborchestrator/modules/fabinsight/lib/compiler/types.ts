import type { TraceStep } from '@/modules/fabinsight/lib/pin/trace';
import type { ConnectionScope, Program } from '@/modules/fabinsight/lib/replay/program';
import type { RunResult } from '@/modules/fabinsight/lib/replay/execute';

export type CompileMode = 'create' | 'extend' | 'refine';

export type CompileInput = {
  mode: CompileMode;
  trace: TraceStep[];
  html: string;
  kpis: { label: string; key?: string; source?: string }[];
  reason: string;
  scope: ConnectionScope;
  timezone: string;
  /** When the trace was captured (defaults to now). Literal dates are relative to it. */
  capturedAt?: Date;
  base?: { program: Program; templateHtml: string };
  instruction?: string;
  history?: string[];
  title?: string;
  /**
   * Called after every model step with what the compiler has ACTUALLY done so
   * far. A compile runs for minutes inside the Fab process while the admin
   * watches a spinner in the other app, so the caller persists this and the
   * admin UI reads it back. Every field is measured, never estimated: the
   * phase comes from the tool the model just called, the counts are the real
   * budgets being spent. Optional, and a throw here must never fail a compile.
   */
  onProgress?: (p: CompileProgress) => void;
};

/**
 * A measured snapshot of a running compile.
 *
 * `phase` is derived from the tool the model called on the last step, so it
 * says what the compiler is doing rather than guessing how far along it is:
 *
 *   starting  - attaching tools, before the first step
 *   reading   - calling a data tool on an MCP server
 *   checking  - validating the program it has drafted (cheap, no live calls)
 *   dryRun    - running the program for real against the servers
 *   finishing - emitting the finished program
 */
export type CompilePhase = 'starting' | 'reading' | 'checking' | 'dryRun' | 'finishing';

export type CompileProgress = {
  phase: CompilePhase;
  /** Model steps completed. */
  step: number;
  maxSteps: number;
  /** Live MCP data calls spent, and the cap they are spent against. */
  dataCalls: number;
  maxDataCalls: number;
  /** Milliseconds since the compile started. */
  elapsedMs: number;
  /**
   * The wall-clock budget this compile dies at.
   *
   * Sent with every report because it, together with `maxSteps`, is what
   * actually BOUNDS a compile: the run ends when the model emits, when the
   * steps run out, or when this elapses. Nothing else stops it — notably not
   * `maxDataCalls`, which is spent well before the end of a wandering run.
   */
  timeoutMs: number;
  /** The tool called on the last step, as the model named it. */
  tool: string | null;
  inputTokens: number;
  outputTokens: number;
  /** The model doing the compiling, so the admin can see which tier ran. */
  model: string;
};

export type CompileUsage = { inputTokens: number; outputTokens: number; steps: number };

export type CompileOutput =
  | { ok: true; program: Program; templateHtml: string; notes: string[]; verify: RunResult; usage: CompileUsage }
  | { ok: false; error: string; notes: string[]; usage?: CompileUsage };
