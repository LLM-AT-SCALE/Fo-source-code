/**
 * WHAT A CONVERSATION HAS PRODUCED SO FAR — read from disk, not from memory.
 *
 * The standalone app kept this in a `sessions` Map in the server process. That
 * is why it was pinned to a single instance: the files were on disk all along,
 * but which chat they belonged to lived only in RAM, so a restart or a second
 * instance lost the association. FabOrchestrator runs behind a load balancer, so
 * that design could not come across unchanged.
 *
 * Everything here is therefore DERIVED from the run directory:
 *
 *   <runs>/<conversationId>/
 *     story.txt                 the requirement document's text
 *     story-name.txt            its original filename
 *     PRD.md                    the current draft
 *     descriptor.json           the specification the PRD was written from
 *     <PageName>/               one per generated page
 *       GENERATED.xml           the page export
 *       queries/                the queries it consumes
 *       reports/                GAP_REPORT.md, REPORT.txt, GUI_REPORT.md
 *
 * The one thing not derivable is the DRAFT COUNT, which is a fact about the
 * conversation rather than about the files. It is counted from the messages,
 * where it already exists.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "./runs";

export interface ArtifactState {
  /** the page name, which is also its directory */
  name: string;
  dir: string;
  /** the page export itself */
  xmlPath: string;
  generatedAt: number;
  /** the validator's verdict on this page, when one was recorded */
  verdict?: { PASS: number; WARN: number; FAIL: number };
}

export interface AgentState {
  conversationId: string;
  dir: string;
  /** the requirement document's text, when one has been attached */
  storyText?: string;
  storyName?: string;
  /** the current PRD draft */
  prdMarkdown?: string;
  descriptorPath?: string;
  descriptorAt?: number;
  /** every page generated in this conversation, newest first */
  artifacts: ArtifactState[];
  /** the page `download`, `revise` and `preview` act on */
  primary?: ArtifactState;
}

const mtime = (p: string): number => {
  try { return statSync(p).mtimeMs; } catch { return 0; }
};

const readIf = (p: string): string | undefined => {
  try { return existsSync(p) ? readFileSync(p, "utf-8") : undefined; } catch { return undefined; }
};

export function readState(conversationId: string): AgentState {
  const dir = runDir(conversationId);
  const state: AgentState = { conversationId, dir, artifacts: [] };
  if (!existsSync(dir)) return state;

  state.storyText = readIf(join(dir, "story.txt"));
  state.storyName = readIf(join(dir, "story-name.txt"))?.trim();
  state.prdMarkdown = readIf(join(dir, "PRD.md"));

  const descriptor = join(dir, "descriptor.json");
  if (existsSync(descriptor)) {
    state.descriptorPath = descriptor;
    state.descriptorAt = mtime(descriptor);
  }

  /* A subdirectory holding a GENERATED.xml is a generated page. Anything else in
     here — `queries/`, a stray folder — is not, and is ignored rather than
     guessed at. */
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const xmlPath = join(dir, entry.name, "GENERATED.xml");
    if (!existsSync(xmlPath)) continue;
    /* Written beside the page by `generate_artifact`. Absent on pages built
       before verdicts were recorded, so the badge is omitted rather than shown
       as zero — "0 passed" and "not measured" are different claims. */
    let verdict: ArtifactState["verdict"];
    const raw = readIf(join(dir, entry.name, "verdict.json"));
    if (raw) {
      try {
        const v = JSON.parse(raw) as Record<string, unknown>;
        if (typeof v.PASS === "number" && typeof v.WARN === "number"
            && typeof v.FAIL === "number") {
          verdict = { PASS: v.PASS, WARN: v.WARN, FAIL: v.FAIL };
        }
      } catch {
        /* a corrupt verdict is a missing verdict, never a broken conversation */
      }
    }
    state.artifacts.push({
      name: entry.name,
      dir: join(dir, entry.name),
      xmlPath,
      generatedAt: mtime(xmlPath),
      ...(verdict ? { verdict } : {}),
    });
  }
  state.artifacts.sort((a, b) => b.generatedAt - a.generatedAt);
  state.primary = state.artifacts[0];
  return state;
}

/**
 * Whether the SPECIFICATION has moved past the artifact built from it.
 *
 * Carried over from the standalone app, where `show_preview` decided what to
 * draw on existence alone — an artifact exists, therefore draw the artifact.
 * That is wrong the moment an engineer revises the PRD of a page that has
 * already been generated: the descriptor gains a field, the artifact on disk
 * does not, and the preview shows the old page while the model reports the
 * change is on it. Measured 2026-09-02 running the job aid, on a step whose
 * entire purpose is to confirm a change by looking at it.
 */
export function specIsNewerThanArtifact(state: AgentState): boolean {
  if (!state.descriptorAt || !state.primary) return false;
  return state.descriptorAt > state.primary.generatedAt;
}
