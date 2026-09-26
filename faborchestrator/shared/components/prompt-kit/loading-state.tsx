"use client";

import { useEffect, useState } from "react";

import { SHOW_TOOL_TIMER } from "@/shared/lib/ui-flags";

/* ─────────────────────────────────────────────────────────
 * LOADING STATE — pixel-grid loader for long-running work
 *
 * Variants:
 *   Drive  — square cells, chevron wavefront driving right;
 *            the 650ms cycle is shorter than the sweep, so
 *            two fronts are always in flight
 *   Dots   — same wavefront, circular cells
 *   Orbit  — a comet lapping the grid perimeter
 *   Surfer — the Drive loader paired with a meme video below
 *
 * Paired with a shimmering label and a live elapsed timer
 * in mono tabular figures. Reduced motion freezes the grid
 * to its dim state; the timer still ticks.
 *
 * Colours bind DIRECTLY to the app's established tokens
 * (--text-100/300/400, --bg-300) rather than through an alias
 * layer: an unresolved var() silently invalidates
 * background-color and gradients, which renders the grid and
 * the label invisible while leaving the timer visible. Only
 * the keyframes and the shadow-overlay utility come from
 * app/globals.css.
 *
 * `stopped` freezes the loader: the timer holds its final
 * value and the animations stop, so a finished step keeps
 * showing how long it took instead of vanishing.
 *
 * `showElapsed` gates the seconds counter. It defaults to
 * SHOW_TOOL_TIMER — on in development, off in production —
 * because a stopwatch ticking up at a waiting user reads as a
 * defect. When it is off no interval is started at all, so
 * the hidden timer costs nothing.
 * ───────────────────────────────────────────────────────── */

const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3), c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

const PATTERNS: Record<string, { delays: (number | null)[]; dur: number; round: boolean }> = {
  Drive: { delays: chevron, dur: 650, round: false },
  Dots: { delays: chevron, dur: 650, round: true },
  Orbit: { delays: orbit, dur: 950, round: false },
};

function LoaderGrid({
  delays,
  dur,
  round,
  stopped = false,
}: {
  delays: (number | null)[];
  dur: number;
  round: boolean;
  stopped?: boolean;
}) {
  return (
    <span aria-hidden className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
      {delays.map((delay, index) => (
        <span
          key={index}
          className={round ? "size-[4px] rounded-full" : "size-[4px] rounded-[1px]"}
          style={{
            background: "var(--text-100)",
            // Frozen cells sit at a visible rest level — 0.15 is meant to be
            // the dim half of a pulse, and reads as blank once it stops.
            opacity: stopped ? (delay === null ? 0.15 : 0.4) : delay === null ? 0.07 : 0.15,
            animation:
              stopped || delay === null
                ? "none"
                : `pixel-on ${dur}ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

function formatSeconds(total: number) {
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

/**
 * Live elapsed time. `fixedMs`, when given, is a duration measured earlier and
 * replayed — a reloaded conversation has no live clock to run, but the time the
 * work took was recorded when it happened, so it can still be shown.
 */
function useElapsed(stopped: boolean, fixedMs: number | null | undefined, enabled: boolean) {
  const [ds, setDs] = useState(0);
  const replay = fixedMs !== undefined && fixedMs !== null;
  const unknown = fixedMs === null;
  useEffect(() => {
    // No interval when the value is hidden — a disabled timer must cost nothing,
    // not tick invisibly ten times a second behind every tool call.
    if (!enabled || stopped || replay || unknown) return; // hold the last value
    const t = setInterval(() => setDs((d) => d + 1), 100);
    return () => clearInterval(t);
  }, [enabled, stopped, replay, unknown]);
  if (!enabled) return null;
  if (unknown) return null; // never measured — show the row without a time
  return formatSeconds(replay ? (fixedMs as number) / 1000 : ds / 10);
}

export default function LoadingState({
  label,
  variant = "Drive",
  /** the meme feed for the Surfer variant; drop the file in /public to light it up */
  videoSrc = "/subway-surfers.mp4",
  stopped = false,
  elapsedMs,
  showElapsed = SHOW_TOOL_TIMER,
}: {
  label?: string;
  variant?: string;
  videoSrc?: string;
  /** Freeze: hold the final elapsed time and stop the animation. */
  stopped?: boolean;
  /** A previously measured duration to display instead of running a live
   *  clock — used when replaying a conversation from history. `null` means the
   *  work was never timed, so the row renders without a time rather than
   *  vanishing or inventing one. */
  elapsedMs?: number | null;
  /** Show the seconds counter. Defaults to SHOW_TOOL_TIMER (dev on, prod off);
   *  pass explicitly to override for a particular surface. */
  showElapsed?: boolean;
}) {
  const elapsed = useElapsed(stopped, elapsedMs, showElapsed);
  const surfer = variant === "Surfer";
  const resolvedLabel = label ?? (surfer ? "Subway surfing" : "Churning");
  const [videoOk, setVideoOk] = useState(true);
  const { delays, dur, round } = PATTERNS[variant] ?? PATTERNS.Drive;

  const labelEl = stopped ? (
    <span className="text-[13px] font-medium" style={{ color: "var(--text-300)" }}>
      {resolvedLabel}
    </span>
  ) : (
    <span
      className="bg-clip-text text-[13px] font-medium text-transparent"
      style={{
        backgroundImage:
          "linear-gradient(90deg, var(--text-300) 35%, var(--text-100) 50%, var(--text-300) 65%)",
        backgroundSize: "200% 100%",
        animation: "shimmer-text 1.4s linear infinite",
      }}
    >
      {resolvedLabel}
    </span>
  );
  const elapsedEl = elapsed ? (
    <span className="font-mono text-[12px] tabular-nums" style={{ color: "var(--text-300)" }}>
      {elapsed}
    </span>
  ) : null;

  if (surfer) {
    return (
      <div role="status" className="flex w-fit flex-col items-start">
        <div className="flex items-center gap-2.5">
          <LoaderGrid {...PATTERNS.Drive} stopped={stopped} />
          {labelEl}
          {elapsedEl}
        </div>

        {/* the context card follows the status text it is illustrating */}
        <div
          className="mt-2 w-56 overflow-hidden rounded-[10px] shadow-overlay"
          style={{ animation: "pop-in 200ms cubic-bezier(0.16,1,0.3,1) both", transformOrigin: "top left" }}
        >
          <div className="relative aspect-video w-full" style={{ background: "var(--bg-300)" }}>
            {videoOk ? (
              <video
                src={videoSrc}
                autoPlay
                muted
                loop
                playsInline
                onError={() => setVideoOk(false)}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-1.5">
                <LoaderGrid {...PATTERNS.Drive} />
                <span className="px-3 text-center font-mono text-[10px]" style={{ color: "var(--text-400)" }}>
                  Video unavailable
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div role="status" className="flex w-fit items-center gap-2.5">
      <LoaderGrid delays={delays} dur={dur} round={round} stopped={stopped} />
      {labelEl}
      {elapsedEl}
    </div>
  );
}
