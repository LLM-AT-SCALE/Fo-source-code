/**
 * How much of a streaming artifact is put on screen, bounded in CHARACTERS.
 *
 * WHY THIS IS NOT A LINE COUNT — it froze a browser.
 *   The chat showed `text.split("\n").slice(-40).join("\n")`: the last forty
 *   lines. A CMF page definition has NO NEWLINES AT ALL — the one measured here
 *   is 45,602 bytes on a single line — so `split` returned one element,
 *   `slice(-40)` kept it, and the cap silently did nothing.
 *
 *   The whole growing artifact was then handed to a syntax highlighter on EVERY
 *   streamed delta: O(n) tokenising per delta, O(n²) across a run, on the main
 *   thread. At around 40 KB the tab stops painting. The server had finished
 *   normally — the browser simply stopped executing JavaScript, which is why the
 *   run completed on disk while the screen sat there.
 *
 * A CAP MUST BE EXPRESSED IN THE UNIT THE INPUT ACTUALLY HAS. Characters are the
 * only unit every artifact is guaranteed to have; lines are a property of SOME
 * documents, and this one is never among them.
 *
 * IT LIVES IN ITS OWN MODULE so it can be TESTED. As a local inside a 3,500-line
 * client component it could only be checked by matching the source — which is
 * what let the original through, because the broken version read as though it
 * capped.
 */

/** Enough to watch the artifact being written; small enough to re-highlight freely. */
const STREAM_TAIL_CHARS = 4_000

/** Applied only after the character bound, so a wrapped file is not cut mid-line. */
const STREAM_TAIL_LINES = 40

export function streamTail(text: string): string {
  const bounded = text.length > STREAM_TAIL_CHARS ? text.slice(-STREAM_TAIL_CHARS) : text
  const lines = bounded.split("\n");
  return lines.length > STREAM_TAIL_LINES ? lines.slice(-STREAM_TAIL_LINES).join("\n") : bounded;
}
