/**
 * FabOrch Audit — request phase timer.
 *
 * Answers "where did the seconds go?" for long request paths (chat
 * time-to-first-token in particular). Records the wall-clock cost of each named
 * phase and emits ONE structured JSON line per request via the logger, so the
 * data lands in CloudWatch without any extra wiring.
 *
 * Query the emitted lines in CloudWatch Logs Insights, e.g.:
 *
 *   fields @timestamp, ttftMs, totalMs, phases.mcpTools, phases.preflight
 *   | filter msg = "perf"
 *   | sort ttftMs desc
 *
 * Overhead is a `performance.now()` call per phase plus one JSON line per
 * request — safe to leave enabled in production.
 */

import { logger, type LogContext } from './logger';

export class PhaseTimer {
  private readonly startedAt: number;
  private lastMark: number;
  private readonly phases: Record<string, number> = {};
  private readonly order: string[] = [];
  private firstTokenMs: number | null = null;
  private readonly tools: Array<{
    name: string;
    ms: number;
    ok: boolean;
    step: number;
  }> = [];

  constructor(
    private readonly label: string,
    private readonly context: LogContext = {}
  ) {
    this.startedAt = performance.now();
    this.lastMark = this.startedAt;
  }

  /** Close out a phase: records the time elapsed since the previous mark. */
  mark(phase: string): void {
    const now = performance.now();
    // Repeat marks of the same name accumulate (e.g. a phase inside a loop).
    if (this.phases[phase] === undefined) {
      this.phases[phase] = 0;
      this.order.push(phase);
    }
    this.phases[phase] += round(now - this.lastMark);
    this.lastMark = now;
  }

  /** Time a single awaited step without having to bracket it with marks. */
  async time<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      const elapsed = round(performance.now() - start);
      if (this.phases[phase] === undefined) {
        this.phases[phase] = 0;
        this.order.push(phase);
      }
      this.phases[phase] += elapsed;
      this.lastMark = performance.now();
    }
  }

  /**
   * Stamp time-to-first-token. Safe to call on every chunk — only the first
   * call is recorded, so it can sit directly in a stream callback.
   */
  markFirstToken(): void {
    if (this.firstTokenMs === null) {
      this.firstTokenMs = round(performance.now() - this.startedAt);
    }
  }

  /**
   * Record one tool execution. Tool calls within a step run CONCURRENTLY (the
   * AI SDK fires each one as its input finishes streaming, with no cap), but
   * the step cannot advance until every one of them has resolved. So a step
   * costs `max(durations)`, not `sum(durations)` — one slow tool holds up the
   * whole step even when its siblings returned instantly. That gap is what
   * `toolBlockingMs` below measures.
   */
  recordTool(name: string, ms: number, ok: boolean, step: number): void {
    this.tools.push({ name, ms: round(ms), ok, step });
  }

  /** Milliseconds since the timer was constructed. */
  elapsed(): number {
    return round(performance.now() - this.startedAt);
  }

  /**
   * The full timing record for this request, as a plain object.
   *
   * Split out from `flush` so the SAME numbers can be both logged and
   * PERSISTED — the log line answers "which phase is slow right now", the
   * stored copy answers "is this user's experience getting worse over time".
   * Two questions, one measurement.
   */
  snapshot(extra: LogContext = {}): Record<string, unknown> {
    // Anything after the last mark that was never named.
    const accounted = this.order.reduce((sum, p) => sum + this.phases[p], 0);
    const total = this.elapsed();
    // Per-step tool analysis. Within a step the tools run in parallel, so the
    // step waits for the slowest; `blocking` is how much of that wait was pure
    // head-of-line blocking on a straggler.
    const byStep = new Map<number, Array<{ name: string; ms: number }>>();
    for (const t of this.tools) {
      if (!byStep.has(t.step)) byStep.set(t.step, []);
      byStep.get(t.step)!.push({ name: t.name, ms: t.ms });
    }
    let waited = 0;   // what the request actually waited: each step's slowest
    let serial = 0;   // what the same tools would cost run one after another
    let blocking = 0; // straggler wait: how long finished siblings sat idle
    const straggler: string[] = [];
    for (const [step, calls] of byStep) {
      const slowest = calls.reduce((a, b) => (b.ms > a.ms ? b : a));
      const fastest = calls.reduce((a, b) => (b.ms < a.ms ? b : a));
      waited += slowest.ms;
      serial += calls.reduce((sum, c) => sum + c.ms, 0);
      if (calls.length > 1) {
        blocking += slowest.ms - fastest.ms;
        straggler.push(
          `step${step}: ${calls.length} parallel, slowest ${slowest.name}=${slowest.ms}ms vs fastest ${fastest.name}=${fastest.ms}ms`
        );
      }
    }

    return {
      ...this.context,
      ...extra,
      label: this.label,
      totalMs: total,
      ttftMs: this.firstTokenMs,
      // Everything after the first token: the answer is arriving, the user is
      // reading. Separating it from ttft is what distinguishes "slow to start"
      // from "slow to finish" — very different fixes.
      streamMs: this.firstTokenMs === null ? null : round(total - this.firstTokenMs),
      unaccountedMs: round(total - accounted),
      phases: this.phases,
      toolCalls: this.tools.length,
      // What the request actually waited on tools (sum of each step's slowest).
      toolWaitedMs: round(waited),
      // What the same tools would have cost run one after another.
      toolSerialMs: round(serial),
      // Time the already-finished tools sat idle waiting on their slowest
      // sibling, summed across steps. High value = one bad tool is the problem,
      // not tool latency in general.
      toolBlockingMs: round(blocking),
      toolDetail: this.tools,
      parallelSteps: straggler,
      // Slowest phases first — the thing to fix is usually phases[0].
      slowest: [...this.order]
        .sort((a, b) => this.phases[b] - this.phases[a])
        .slice(0, 5)
        .map((p) => `${p}=${this.phases[p]}ms`),
    };
  }

  /** Emit the single summary line. Call once, when the request is done. */
  flush(extra: LogContext = {}): void {
    logger.info('perf', this.snapshot(extra));
  }
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}
