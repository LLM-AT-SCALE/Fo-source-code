/**
 * PRE-VALIDATION, RUN ON UPLOAD — what we can evidence, before anyone types.
 *
 * `lib/po-ui/prevalidate.ts` is the resolver: given a descriptor it says, for
 * every column, label, action and query the story names, whether we can point at
 * an artifact that settles it. It has been tested since it was written and until
 * now NOTHING CALLED IT — the engineer had no way to see any of it. This module
 * is the missing half.
 *
 * WHY IT RUNS HERE AND NOT INSIDE THE UPLOAD RESPONSE
 *   Pre-validation needs a descriptor, and a descriptor needs one model call. The
 *   upload route returns in ~200ms on purpose (the attachment appears before
 *   either network call completes), and blocking it on an extraction would undo
 *   that. So the upload responds, then this runs behind it and writes its result
 *   into the run directory for the UI to poll.
 *
 * WHY THE RESULT IS A FILE AND NOT MEMORY
 *   The same reason the story and the PRD are files: a Next.js route handler is
 *   not a place to keep state. The run directory already holds `story.txt`,
 *   `PRD.md` and the artifacts, and this sits beside them.
 *
 * THE FINDINGS ARE NOT SENT TO THE MODEL, AND THAT IS THE DESIGN.
 *   A `preValidationBrief()` helper lived here and fed the open findings into
 *   the intake system message. It was removed on 2026-09-09: the report earns
 *   its place by being an INDEPENDENT reader, and a model primed with its
 *   findings echoes them instead of disagreeing with them.
 *
 *   On US-455386 the two overlapped on one item of eight and disagreed on the
 *   one that mattered — the model called `TrackInResource` and `TrackInId`
 *   settled, the resolver marked both `assumed`. That contradiction is the most
 *   useful line in the report and cannot survive the injection.
 *
 *   If this is ever reinstated, the thing to preserve is the ability to
 *   CONTRADICT, not the tidiness of two lists agreeing.
 *
 * FAILURE IS NEVER FATAL
 *   A pre-validation that cannot run must not stop somebody building a page. Any
 *   error is written into the file as a `status: "failed"` with its reason, so
 *   the UI can say what happened instead of spinning.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeClient } from "@/lib/po-ui/generate/client";
import { extractDescriptor } from "@/lib/po-ui/generate/pipeline";
import { prevalidate, type PreValidation } from "@/lib/po-ui/prevalidate";
import { loadAgentConfig } from "./evidence";
import { ensureRunDir } from "./runs";

const FILE = "PREVALIDATION.json";

/**
 * The resolver's report, plus what it could not consult.
 *
 * `notices` names the client evidence that is not installed on this machine —
 * the delivered exports the resolver matches against. Without them every query
 * and page reads as `missing`, which is true of this environment and says
 * nothing about the requirement; the card shows the notice above the findings
 * so the counts are read for what they are.
 */
export type PreValidationReport = PreValidation & { notices?: string[] };

/** What the UI polls for. `running` is the absence of a result, not a flag. */
export type PreValidationStatus =
  | { status: "running" }
  | { status: "done"; report: PreValidationReport }
  | { status: "failed"; reason: string };

function path(conversationId: string): string {
  return join(ensureRunDir(conversationId), FILE);
}

/** The stored result, or `running` when it has not landed yet. */
export function readPreValidation(conversationId: string): PreValidationStatus {
  const p = path(conversationId);
  if (!existsSync(p)) return { status: "running" };
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as PreValidationStatus;
  } catch {
    return { status: "failed", reason: "the stored report could not be read" };
  }
}

/**
 * Extract a descriptor from the document and resolve every term it names.
 *
 * Deliberately NOT awaited by the upload route. The caller fires it and returns;
 * this writes when it is done.
 *
 * Uses `makeClient()` — the same credential path generation already takes —
 * rather than resolving a key here. Two ways to reach the model is two things to
 * keep in step.
 */
export async function runPreValidation(
  conversationId: string, story: string, documentName: string,
): Promise<void> {
  const out = path(conversationId);
  /* A previous document's report must not be read as this one's while the
     model call is in flight: the poll treats any file as the answer. */
  rmSync(out, { force: true });
  try {
    /* The runnable config: samples reduced to what is on disk, and the gaps
       named. Extraction needs only the vocabulary blocks, so it runs without the
       client's pages; the resolver runs without the corpus and says so. */
    const { cfg, evidence } = loadAgentConfig();
    const client = makeClient();
    const descriptor = await extractDescriptor(cfg, client, story);
    const report: PreValidationReport = {
      ...prevalidate({ cfg, descriptor, document: documentName }),
      ...(evidence.notices.length ? { notices: evidence.notices } : {}),
    };
    writeFileSync(out, JSON.stringify({ status: "done", report }, null, 1), "utf-8");
  } catch (e) {
    /* Written rather than thrown: an unhandled rejection in a fire-and-forget
       task is invisible, and the UI would poll forever. */
    writeFileSync(out, JSON.stringify({
      status: "failed",
      reason: e instanceof Error ? e.message : String(e),
    }, null, 1), "utf-8");
  }
}
