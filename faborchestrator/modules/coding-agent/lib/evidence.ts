/**
 * THE CLIENT'S EVIDENCE — is it installed, and what to do when it is not.
 *
 * `po-ui-assets/` holds two kinds of thing. The curated part (prompts,
 * skeletons, dictionaries, `pipeline.json`) is committed and always present.
 * The client's own material is not: `samples/` (their delivered pages, which
 * the generator copies the house style from) and `corpus/` (their query and
 * page exports, which pre-validation matches against and generation
 * transcribes queries from) are git-ignored, provisioned per environment, and
 * pointed at with `PO_UI_ASSETS_DIR` when they live elsewhere.
 *
 * WHY THIS MODULE EXISTS
 *   `buildPackage()` reads every sample `pipeline.json` lists, and on a checkout
 *   without `samples/` the FIRST symptom was the chat route dying with a bare
 *   `ENOENT` before a single byte was streamed, and pre-validation storing the
 *   same raw path as its reason. Nothing said "the client corpus is not
 *   installed", nothing named the folder, and the rest of the agent — upload,
 *   conversation, PRD — was refused along with the part that genuinely needs
 *   the evidence.
 *
 * WHAT IT DOES INSTEAD
 *   `loadAgentConfig()` hands the pipeline a config whose sample list names only
 *   the files that are on disk, so everything that does not need the client's
 *   pages keeps working. The package's own guard still holds: with no samples
 *   AND no `oobPages` asset it refuses, and that refusal now carries the hint.
 *   Every degradation is reported as a plain sentence — in the pre-validation
 *   card, in the generation progress, in the tool result the model reads — so
 *   an engineer sees which folder is empty and which variable points at it.
 *
 * KEPT OUT OF `lib/po-ui/`, which is ported verbatim from the standalone app and
 * must not diverge. The pipeline is unchanged; this is the seam in front of it.
 */
import { existsSync } from "node:fs";
import { basename, relative } from "node:path";

import { ASSET_ROOT } from "@/lib/po-ui/asset-root";
import {
  loadPipelineConfig,
  querySourceRoots,
  resolvePath,
  samplePaths,
  type PipelineConfig,
} from "@/lib/po-ui/generate/config";
import { logger } from "@/shared/lib/logger";

export interface EvidenceStatus {
  /** where the pipeline looked; what `PO_UI_ASSETS_DIR` would replace */
  assetRoot: string;
  /** the client's delivered pages listed in `pipeline.json` */
  samples: { dir: string; present: string[]; missing: string[] };
  /** the delivered query and page exports (`querySources.roots`) */
  corpus: { present: string[]; missing: string[] };
  /** true when every listed sample and every corpus root is on disk */
  complete: boolean;
  /**
   * What is missing and what it costs, one sentence each, followed by how to
   * put it right. Empty when `complete`. Written for the engineer, so they are
   * shown as-is.
   */
  notices: string[];
}

/** The one actionable sentence, shared by every message about missing evidence. */
export function evidenceHint(assetRoot: string = ASSET_ROOT): string {
  return (
    `Provision the client evidence package into ${assetRoot} ` +
    `(samples/ and corpus/ beside config/ and package/), or set PO_UI_ASSETS_DIR ` +
    `to a populated assets root and restart the app.`
  );
}

/** A path as the engineer knows it: relative to the assets root when it is inside it. */
function shown(p: string, root: string): string {
  const rel = relative(root, p);
  return rel && !rel.startsWith("..") ? rel : p;
}

export function evidenceStatus(cfg: PipelineConfig, assetRoot: string = ASSET_ROOT): EvidenceStatus {
  const samplesDir = resolvePath(cfg.samplesDir);
  const samplesPresent: string[] = [];
  const samplesMissing: string[] = [];
  for (const p of samplePaths(cfg)) (existsSync(p) ? samplesPresent : samplesMissing).push(p);

  const corpusPresent: string[] = [];
  const corpusMissing: string[] = [];
  for (const r of querySourceRoots(cfg)) (existsSync(r) ? corpusPresent : corpusMissing).push(r);

  const notices: string[] = [];
  if (samplesMissing.length) {
    const listed = samplesPresent.length + samplesMissing.length;
    notices.push(
      `Client sample pages are not installed: ${samplesMissing.length} of the ${listed} ` +
      `listed in pipeline.json ${samplesMissing.length === 1 ? "is" : "are"} absent under ` +
      `${shown(samplesDir, assetRoot)} (${samplesMissing.map((p) => basename(p)).join(", ")}). ` +
      (samplesPresent.length
        ? `The page will be generated from the ${samplesPresent.length} that ` +
          `${samplesPresent.length === 1 ? "is" : "are"} present plus the stock CMF baseline.`
        : `The page will be generated from the stock CMF baseline only, without the ` +
          `client's house style.`),
    );
  }
  if (corpusMissing.length && corpusPresent.length === 0) {
    notices.push(
      `Delivered query and page exports are not installed: none of the evidence roots ` +
      `exist (${corpusMissing.map((r) => shown(r, assetRoot)).join(", ")}). Queries the ` +
      `requirement names will be reported as gaps rather than transcribed, and ` +
      `pre-validation cannot match pages, columns or labels against delivered artifacts.`,
    );
  } else if (corpusMissing.length) {
    notices.push(
      `Some evidence roots are not installed (${corpusMissing.map((r) => shown(r, assetRoot)).join(", ")}); ` +
      `only ${corpusPresent.map((r) => shown(r, assetRoot)).join(", ")} will be searched.`,
    );
  }
  if (notices.length) notices.push(evidenceHint(assetRoot));

  return {
    assetRoot,
    samples: { dir: samplesDir, present: samplesPresent, missing: samplesMissing },
    corpus: { present: corpusPresent, missing: corpusMissing },
    complete: notices.length === 0,
    notices,
  };
}

/**
 * The config the pipeline can actually run with: the same object, with the
 * sample list reduced to the files on disk. `buildPackage()` reads whatever is
 * listed and a listed file that is not there is an unhandled `ENOENT`; the
 * package's own "no example at all" guard is what should decide, and it can only
 * decide if it is reached.
 */
export function usableConfig(cfg: PipelineConfig, status: EvidenceStatus = evidenceStatus(cfg)): PipelineConfig {
  if (!status.samples.missing.length) return cfg;
  const missing = new Set(status.samples.missing.map((p) => basename(p)));
  return { ...cfg, samples: cfg.samples.filter((s) => !missing.has(basename(s))) };
}

/* Logged once per notice per process. A warning on every turn of every
   conversation is a log nobody reads; one line when the gap is first seen is one
   an operator acts on. */
const warned = new Set<string>();

/**
 * Load `pipeline.json` for the agent: the runnable config plus what it is
 * missing. Throws the pipeline's own `ConfigError` when the config itself cannot
 * be read — that is not a missing-evidence situation and must not be dressed up
 * as one.
 */
export function loadAgentConfig(): { cfg: PipelineConfig; evidence: EvidenceStatus } {
  const raw = loadPipelineConfig();
  const evidence = evidenceStatus(raw);
  for (const n of evidence.notices) {
    if (warned.has(n)) continue;
    warned.add(n);
    logger.warn("coding-agent evidence incomplete", { notice: n, assetRoot: evidence.assetRoot });
  }
  return { cfg: usableConfig(raw, evidence), evidence };
}

/**
 * A failure to assemble the prompt package, explained. `buildPackage()` refuses
 * when it has no example page at all; on a bare checkout that means the samples
 * are missing AND `oobPages` was removed from the config, and the engineer needs
 * to hear about the folder, not about a prompt block.
 */
export function explainPackageFailure(e: unknown, evidence?: EvidenceStatus): string {
  const why = (e instanceof Error ? e.message : String(e)).replace(/\.$/, "");
  /* Unknown status (the config itself failed) gets the hint too: the folder is
     still the most likely thing wrong on a fresh machine. */
  const hint = evidence?.complete ? "" : ` ${evidenceHint(evidence?.assetRoot)}`;
  return `The Coding Agent cannot assemble its reference material: ${why}.${hint}`;
}
