"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Textarea } from "@/shared/components/ui/textarea";
import { DashboardPreview } from "@/modules/admin/components/dashboard-preview";
import { Disclosure } from "@/modules/admin/components/disclosure";
import { Loader2, Rocket, Wand2 } from "lucide-react";
import type { CompileProgress } from "@/modules/fabinsight/lib/compiler/types";

export type CompileJob = {
  id: string;
  kind: string; // create | extend | refine
  instruction: string | null;
  status: string; // queued | claimed | preview_ready | failed
  attempts: number;
  claimedAt: string | null;
  finishedAt: string | null;
  resultHtml: string | null;
  resultKpis: unknown;
  resultNotes: unknown;
  /** While a compile runs this carries `{ progress }`; afterwards, the totals. */
  usage: unknown;
  error: string | null;
  createdBy: { id: string; name: string | null; email: string | null } | null;
  createdAt: string;
};

export const isJobRunning = (j: CompileJob) => j.status === "queued" || j.status === "claimed";

/** Live compile progress, written by the compiler onto the job row (`usage.progress`). */
type Progress = CompileProgress;

/** Read progress off a job, or null when the compile has not reported yet. */
function progressOf(j: CompileJob | undefined): Progress | null {
  const u = j?.usage as { progress?: Progress } | null | undefined;
  const p = u?.progress;
  return p && typeof p.step === "number" && typeof p.phase === "string" ? p : null;
}

const PHASE_TEXT: Record<Progress["phase"], string> = {
  starting: "Attaching the MCP tools",
  reading: "Reading data from the servers",
  checking: "Checking the program it has drafted",
  dryRun: "Running the program for real",
  finishing: "Writing the finished program",
};

/**
 * HOW FAR ALONG A COMPILE IS.
 *
 * A compile is bounded (a step budget and a wall-clock timeout), and it moves
 * through known stages, so it can be shown honestly — no invented percentage,
 * and no bar that sits full while work continues:
 *
 *   • each STAGE owns a band of the bar. Reaching a stage means reaching its
 *     band, and the stages only ever move forward: attaching → reading →
 *     checking → live run → writing.
 *   • inside the reading stage, where nearly all the time goes, the position
 *     follows the steps actually spent against the budget.
 *   • a long single step would otherwise freeze the bar, so elapsed time
 *     against the timeout acts as a floor — it keeps creeping, and it cannot
 *     push past the current stage's band.
 *   • the bar never goes backwards (a later report can only raise it) and it
 *     stops at 99% until the compile has really finished.
 */
/** Strip the `mcp_<conn8>__` namespace so a tool reads as a person named it. */
function toolLabel(tool: string | null): string | null {
  if (!tool) return null;
  return tool.replace(/^mcp_[0-9a-f]{8}__/i, "").replace(/_/g, " ");
}

/** "3m 12s" / "47s" — the same wording whether it is running or finished. */
function durationText(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

const STAGE_BANDS: Record<Progress["phase"], [number, number]> = {
  starting: [2, 8],
  reading: [8, 62],
  checking: [62, 80],
  dryRun: [80, 93],
  finishing: [93, 99],
};

function percentFor(p: Progress, elapsedMs: number): number {
  const [from, to] = STAGE_BANDS[p.phase] ?? STAGE_BANDS.reading;
  let within = 0;
  if (p.phase === "reading" && p.maxSteps > 0) {
    within = Math.min(1, p.step / p.maxSteps);
  } else if (p.timeoutMs > 0) {
    // No step budget to measure against in this stage: let time carry it,
    // slowly, across the stage's own band.
    within = Math.min(1, (elapsedMs / p.timeoutMs) * 2);
  }
  const staged = from + (to - from) * within;
  // Time floor, so a slow step still shows movement — never past this stage.
  const byTime = p.timeoutMs > 0 ? Math.min(to, (elapsedMs / p.timeoutMs) * 93) : 0;
  return Math.max(2, Math.min(99, staged, Math.max(staged, byTime)));
}

function ProgressTrack({ percent, title }: { percent: number; title?: string }) {
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Compile progress"
      title={title}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function CompleteTrack({ tone }: { tone: "done" | "failed" }) {
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuenow={100}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={tone === "done" ? "Compile complete" : "Compile stopped"}
    >
      <div className={`h-full w-full rounded-full ${tone === "done" ? "bg-emerald-500" : "bg-destructive"}`} />
    </div>
  );
}

function CompileProgressBar({ progress }: { progress: Progress }) {
  /*
   * Keep the clock — and so the bar — moving between polls.
   *
   * The server reports after each model step and the page re-fetches every few
   * seconds, so anything driven only by those reports would freeze and jump.
   * Time is passing for real, so the last report is carried forward by the
   * wall-clock since it arrived.
   */
  const [now, setNow] = useState(() => Date.now());
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const reportedMs = progress.elapsedMs;

  useEffect(() => {
    setReceivedAt(Date.now());
    setNow(Date.now());
  }, [reportedMs, progress.step, progress.phase]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const elapsedMs = reportedMs + Math.max(0, now - receivedAt);

  // Never backwards: a re-render, a late report or a stage change can only
  // raise it. A bar that slips back reads as work being undone.
  const highest = useRef(0);
  const percent = Math.max(highest.current, percentFor(progress, elapsedMs));
  highest.current = percent;

  const leftMs = progress.timeoutMs > 0 ? progress.timeoutMs - elapsedMs : 0;
  const nearTimeout = progress.timeoutMs > 0 && leftMs < 3 * 60_000;

  /*
   * The detail an engineer wants (steps, data calls, the tool in flight, the
   * model) lives in the tooltip. On the face of it those counters read as
   * noise — what an admin needs is the stage, how far along, and how long.
   */
  const detail = [
    progress.maxSteps > 0 ? `step ${progress.step} of ${progress.maxSteps}` : `step ${progress.step}`,
    progress.maxDataCalls > 0
      ? `${progress.dataCalls} of ${progress.maxDataCalls} data calls`
      : `${progress.dataCalls} data calls`,
    toolLabel(progress.tool),
    progress.model,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{PHASE_TEXT[progress.phase]}</span>
        <span className="tabular-nums text-xs text-muted-foreground">
          {Math.round(percent)}% · {durationText(elapsedMs)}
        </span>
      </div>

      <ProgressTrack percent={percent} title={detail} />

      {nearTimeout && (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          {durationText(Math.max(0, leftMs))} left before the compile times out. If it does, approve again
          with specific servers in scope rather than all of them.
        </p>
      )}
    </div>
  );
}

/**
 * The finished state: the only moment a full bar is true.
 *
 * Duration comes from the job's own claimed/finished stamps rather than the
 * progress report, because the report is replaced by the usage totals the
 * moment a compile ends.
 */
function CompileOutcome({ job }: { job: CompileJob }) {
  const failed = job.status === "failed";
  const started = job.claimedAt ? new Date(job.claimedAt).getTime() : null;
  const ended = job.finishedAt ? new Date(job.finishedAt).getTime() : null;
  const tookMs = started && ended ? ended - started : null;
  const steps = (job.usage as { steps?: number } | null)?.steps;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{failed ? "Compile stopped" : "Compile complete"}</span>
        {tookMs !== null && (
          <span className="tabular-nums text-xs text-muted-foreground">{durationText(tookMs)}</span>
        )}
      </div>
      <CompleteTrack tone={failed ? "failed" : "done"} />
      {typeof steps === "number" && steps > 0 && (
        <div className="text-xs tabular-nums text-muted-foreground">{steps} steps</div>
      )}
    </div>
  );
}

function JobStatusBadge({ status }: { status: string }) {
  if (status === "preview_ready") return <Badge variant="success">Preview ready</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (status === "claimed") return <Badge variant="warning">Compiling…</Badge>;
  return <Badge variant="secondary">Queued</Badge>;
}

function fmt(d: string | null | undefined): string {
  if (!d) return "—";
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? "—" : x.toLocaleString();
}

function notesList(notes: unknown): string[] {
  if (Array.isArray(notes)) return notes.map((n) => (typeof n === "string" ? n : JSON.stringify(n)));
  if (typeof notes === "string") return [notes];
  if (notes && typeof notes === "object") return Object.entries(notes as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return [];
}

/**
 * The compiler's output for one request or dashboard: the newest preview with
 * its Publish button, then a refine box. Job history and compiler notes sit
 * behind disclosures. `jobs` is newest first; while one is queued/claimed the
 * panel calls `onRefresh` every 5 s so the parent re-fetches.
 */
export function CompilePanel({
  jobs,
  onRefine,
  onGoLive,
  onRefresh,
  busy = false,
  canGoLive = true,
  publishLabel = "Publish",
}: {
  jobs: CompileJob[];
  onRefine: (instruction: string) => Promise<void> | void;
  onGoLive: (jobId: string) => void;
  onRefresh: () => void;
  busy?: boolean;
  canGoLive?: boolean;
  publishLabel?: string;
}) {
  const [instruction, setInstruction] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const latest = jobs[0] ?? null;
  const running = jobs.some(isJobRunning);
  const newestReady = jobs.find((j) => j.status === "preview_ready") ?? null;

  useEffect(() => {
    if (!running) return;
    const t = setInterval(onRefresh, 5000);
    return () => clearInterval(t);
  }, [running, onRefresh]);

  const shown = (selectedId ? jobs.find((j) => j.id === selectedId) : null) ?? newestReady ?? latest;
  const shownIsNewestReady = !!shown && !!newestReady && shown.id === newestReady.id;

  const submitRefine = async () => {
    const text = instruction.trim();
    if (!text) return;
    await onRefine(text);
    setInstruction("");
    setSelectedId(null);
  };

  if (!latest) {
    return <p className="text-sm text-muted-foreground">No compile job yet. Approve the request to start one.</p>;
  }

  const notes = shown ? notesList(shown.resultNotes) : [];

  return (
    <div className="space-y-4">
      {running && (
        <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-sm">
          {(() => {
            const progress = progressOf(latest);
            // Until the first step lands there is genuinely nothing measured to
            // show, so say that plainly rather than animate an empty bar.
            if (!progress) {
              return (
                <div className="flex items-center gap-3">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  <span>
                    <span className="font-medium">Waiting for the compiler</span>
                    <span className="text-muted-foreground">
                      {" "}— the job is queued. The Fab app picks it up on its next tick, within a minute.
                    </span>
                  </span>
                </div>
              );
            }
            return <CompileProgressBar progress={progress} />;
          })()}
        </div>
      )}

      {!running && latest.status === "failed" && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <div className="mb-3">
            <CompileOutcome job={latest} />
          </div>
          <p className="font-medium text-destructive">Compile failed</p>
          <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{latest.error || "No error detail recorded."}</p>
          <p className="mt-2 text-xs text-muted-foreground">Tell the compiler what to do differently below, and it will try again.</p>
        </div>
      )}

      {shown && shown.status === "preview_ready" && (
        <div className="space-y-2">
          {/* The bar's only honest 100%: the compile really did finish. */}
          <div className="rounded-md border bg-muted/30 px-3 py-2.5">
            <CompileOutcome job={shown} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">
              <span className="font-medium">{shownIsNewestReady ? "Compiled preview" : "Earlier preview"}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {shown.instruction ? `“${shown.instruction.slice(0, 80)}${shown.instruction.length > 80 ? "…" : ""}” · ` : ""}{fmt(shown.finishedAt ?? shown.createdAt)}
              </span>
            </p>
            {shownIsNewestReady && canGoLive && (
              <Button onClick={() => onGoLive(shown.id)} disabled={busy || running} className="bg-primary">
                <Rocket className="mr-2 h-4 w-4" /> {publishLabel}
              </Button>
            )}
            {!shownIsNewestReady && newestReady && (
              <Button variant="outline" size="sm" onClick={() => setSelectedId(null)}>Back to latest</Button>
            )}
          </div>
          <DashboardPreview html={shown.resultHtml} title="Compiled dashboard preview" />
        </div>
      )}

      {(latest.status === "preview_ready" || latest.status === "failed") && (
        <div className="space-y-2">
          <Textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            aria-label="Refine the compiled dashboard"
            placeholder={
              latest.status === "failed"
                ? "e.g. “use the hourly moves tool instead of the daily one”"
                : "Not quite right? Describe the change, e.g. “show the last 7 days instead of 30” or “add a yield-by-product table”."
            }
            className="min-h-16"
            disabled={busy || running}
          />
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={submitRefine} disabled={busy || running || !instruction.trim()}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
              {latest.status === "failed" ? "Retry with this change" : "Refine & recompile"}
            </Button>
          </div>
        </div>
      )}

      {notes.length > 0 && (
        <Disclosure title="Compiler notes" count={notes.length}>
          <ul className="list-disc space-y-0.5 pl-4 text-xs">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </Disclosure>
      )}

      {jobs.length > 1 && (
        <Disclosure title="Compile history" count={jobs.length} hint="Open an earlier preview">
          <ul className="divide-y rounded-md border text-sm">
            {jobs.map((j) => {
              const active = shown?.id === j.id;
              return (
                <li key={j.id}>
                  <button
                    type="button"
                    disabled={j.status !== "preview_ready"}
                    onClick={() => setSelectedId(j.id)}
                    className={`flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left disabled:cursor-default ${active ? "bg-accent" : "hover:bg-accent/50"}`}
                  >
                    <Badge variant="outline" className="capitalize">{j.kind}</Badge>
                    <JobStatusBadge status={j.status} />
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {j.instruction || (j.kind === "refine" ? "(no instruction)" : "initial compile")}
                    </span>
                    <span className="text-xs text-muted-foreground">{fmt(j.finishedAt ?? j.createdAt)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}
