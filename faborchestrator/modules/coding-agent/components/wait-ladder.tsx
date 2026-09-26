/**
 * THE WAITING STATE — what the engineer reads while the model is thinking.
 *
 * MEASURED, which is why this is not one static label. Instrumenting the
 * pipeline gave: extract 31s (19.7s before the first character), PRD narrative
 * 26s, and generation 205s with 86.5s of silence before a single token arrives.
 * A spinner captioned "reading the requirement…" for a minute and a half does
 * not read as work in progress, it reads as broken — and the honest fix is to
 * say what is happening and let the clock show.
 *
 * ONE LADDER PER PHASE, because one ladder was wrong most of the time. Answering
 * "The PRD looks fine, proceed" was captioned "Reading the requirement →
 * Matching the CMF vocabulary": both sentences describe work that finished two
 * turns earlier. A progress caption that is demonstrably about something else is
 * worse than none, because it teaches the reader to stop believing the ones that
 * are right.
 *
 * The phase comes from the SERVER, which is the only place that knows whether a
 * document is attached and whether a PRD exists. Every ladder escalates with
 * elapsed time and every line is true of the stage it names; the last one stops
 * promising and admits it is a long one, because claiming "almost there" at 90
 * seconds is how progress UI loses trust.
 *
 * NO TRAILING ELLIPSIS on any of these — the shimmer already says "in progress",
 * and a label ending in "…" beside it states the same thing twice.
 *
 * THE MESSAGES ARE THE STANDALONE'S; THE ANIMATION IS FABORCHESTRATOR'S. The
 * ladders are ported rung for rung, because they are measured and every line is
 * the answer to a real complaint. The animation is `LoadingState` — the same
 * pixel-grid box the AI Support Engineer runs, through the same component — so a
 * reader moving between the two agents sees one product.
 *
 * Two earlier attempts are worth recording, because both looked right in a
 * screenshot and were wrong in motion:
 *
 *   - The standalone's three travelling dots were ported across as well, which
 *     put two different loading animations side by side in one row.
 *   - This rendered at the FOOT of the transcript, so it sat below the streaming
 *     reply and walked down the page as the text grew. It belongs in the message
 *     flow, where it stays put and freezes when the work stops — which is what
 *     `LoadingState`'s `stopped` is for.
 */
"use client"

import { useEffect, useState } from "react"
import LoadingState from "@/shared/components/prompt-kit/loading-state"

export type WaitPhase = "answering" | "reading" | "deciding" | "reacting"

/** [elapsed seconds at which the line takes over, the line] */
const LADDERS: Record<WaitPhase, ReadonlyArray<readonly [number, string]>> = {
  /* No document attached: the model is answering a question about the tool. */
  answering: [
    [0, "Reading your message"],
    [8, "Working out what you need"],
    [22, "Putting the answer together"],
    [45, "Still writing"],
    [80, "Thinking, not stuck"],
  ],
  /* A document is attached and there is no PRD yet. */
  reading: [
    [0, "Reading the requirement"],
    [8, "Matching the CMF vocabulary"],
    [20, "Working out columns and data paths"],
    [38, "Wiring data sources and links"],
    [60, "Still working, this page is a big one"],
    [95, "Thinking, not stuck"],
  ],
  /* A PRD exists, so the engineer is responding TO something. */
  deciding: [
    [0, "Reading your reply"],
    [8, "Checking it against the spec"],
    [20, "Deciding what to change"],
    [40, "Getting the build ready"],
    [70, "Still working on it"],
    [100, "Thinking, not stuck"],
  ],
  /* Past the first pass: a tool has returned and the model is reading it. */
  reacting: [
    [0, "Reading the result"],
    [10, "Checking what came back"],
    [25, "Writing up what happened"],
    [50, "Still writing"],
    [85, "Thinking, not stuck"],
  ],
}

/* Used when the server sends no phase, or one this build does not know: an
   older server emits nothing and its behaviour must not change. */
const DEFAULT_PHASE: WaitPhase = "reading"

export function isWaitPhase(v: unknown): v is WaitPhase {
  return typeof v === "string" && v in LADDERS
}

/**
 * @param phase    what the server said this turn is
 * @param override a live line from the pipeline. A running TOOL narrates itself,
 *                 and its account of what it is doing beats any ladder — the
 *                 ladder exists for the model's thinking time, which is the part
 *                 with nothing else to look at.
 */
export function WaitLadder({
  phase,
  override,
  stopped = false,
}: {
  phase?: WaitPhase
  override?: string | null
  /** the work has finished: the box freezes holding its final time rather than
   *  vanishing, so the turn keeps showing what it cost */
  stopped?: boolean
}) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (stopped) return
    const started = Date.now()
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(t)
  }, [phase, stopped])

  const ladder = LADDERS[phase ?? DEFAULT_PHASE]
  const rung = ladder.reduce((best, r) => (elapsed >= r[0] ? r : best), ladder[0]!)
  /* `LoadingState` carries the clock itself, in the same mono tabular figures
     the AI Support Engineer shows — so the seconds are not rendered twice. */
  return <LoadingState label={override ?? rung[1]} stopped={stopped} />
}
