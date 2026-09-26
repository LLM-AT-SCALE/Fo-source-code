/**
 * THE DEPLOYMENT UNIT — what an engineer actually imports into CMF.
 *
 * A generated `.xml` is not deployable on its own (F-98). A screen ships as the
 * page, the queries it consumes, and the master-data file that declares its
 * labels and imports the artifacts IN DEPENDENCY ORDER — a page that imports
 * before its queries fails. So the download is the whole set, named with the
 * load-order prefixes the client's own repository uses.
 *
 * THIS MODULE NO LONGER DECIDES WHAT GOES IN THE ARCHIVE.
 *   It had its own copy of that rule — its own load-order lookup, its own list
 *   of reports, its own README — and the copy had drifted. Measured against the
 *   unit actually sent to Athena, a download from here was missing:
 *
 *     - `reports/QUERY_CHANGES.md`, the list of edits made to queries the client
 *       already ships;
 *     - the README line saying the unit OVERWRITES those queries;
 *     - the check that every row of the master-data manifest names a file the
 *       archive actually holds — the exact defect that reached them once;
 *     - the check that every query the page BINDS TO was built, which listing
 *       the queries directory cannot see.
 *
 *   All four exist in `packageRun`, so this delegates to it. A second
 *   implementation of "what deploys" is a second thing to keep true, and this
 *   one was already false.
 */
import { basename } from "node:path";
import { packageRun } from "@/lib/po-ui/package-run";
import type { ZipEntry } from "@/lib/po-ui/zip";
import { loadPipelineConfig } from "@/lib/po-ui/generate/config";
import { readState, type ArtifactState } from "./state";

export interface Unit {
  filename: string;
  bytes: Buffer;
}

/** Config is advisory here: packaging must not fail because config is unreadable. */
function config(): ReturnType<typeof loadPipelineConfig> | undefined {
  try {
    return loadPipelineConfig();
  } catch {
    return undefined;
  }
}

export interface UnitFile {
  /** the name it carries inside the archive */
  name: string;
  chars: number;
}

/**
 * What the unit contains, WITHOUT building the archive.
 *
 * The chat card and the download must never disagree about what was produced, so
 * both read this one function rather than each deciding for itself. Listing is
 * cheap; zipping 140 KB on every panel refresh is not.
 */
export function unitContents(artifactDir: string): UnitFile[] {
  return unitEntries(artifactDir).map((e) => ({
    name: e.name,
    /* CHARACTERS, NOT BYTES. Files read off disk arrive as Buffers, and
       `Buffer.length` is the byte count — so a report containing an em dash was
       listed as 8,506 "chars" while the panel that opens it counts 8,494. Both
       numbers describe the same file, which is exactly why only one of them may
       be on screen. Decoded here because this is the one place the count is
       derived, and every card and label reads it from here. */
    chars: typeof e.data === 'string' ? e.data.length : e.data.toString('utf-8').length,
  }));
}

/**
 * The unit's files WITH their contents.
 *
 * So the panel can show one artifact without building and re-reading a zip. It
 * shares `packageRun` with the download, which is the point: what an engineer
 * reads on screen and what lands in the archive are the same bytes, chosen by
 * the same rule. That now includes `README.txt` — it used to be appended by the
 * download alone, so the panel listed a unit one file short of the one that
 * shipped.
 */
export function unitEntries(artifactDir: string, pageName?: string): ZipEntry[] {
  return packageRun(artifactDir, pageName ?? basename(artifactDir), config()).entries;
}

/**
 * Build the unit for one generated page.
 *
 * Returns null when the page has not been generated — the caller turns that into
 * a 404 rather than an empty archive, because an empty archive downloads
 * successfully and fails silently at import.
 */
export function buildUnit(conversationId: string, pageName?: string): Unit | null {
  const state = readState(conversationId);
  const artifact: ArtifactState | undefined = pageName
    ? state.artifacts.find((a) => a.name === pageName)
    : state.primary;
  if (!artifact) return null;

  const packaged = packageRun(artifact.dir, artifact.name, config());
  /* README.txt is always emitted, so it alone is not evidence of a build. An
     archive holding nothing but its own instructions is the empty-archive case
     the null return exists for. */
  if (packaged.files.filter((f) => f !== "README.txt").length === 0) return null;

  return { filename: `${artifact.name}-deployment.zip`, bytes: packaged.buffer };
}
