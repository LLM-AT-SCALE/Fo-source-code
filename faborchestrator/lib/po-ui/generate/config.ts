/**
 * PIPELINE CONFIGURATION — loaded from po-ui-assets/config/pipeline.json.
 *
 * Model id, effort, token ceiling, retry count and every asset path live in the
 * config file, not in source. Changing where the package lives, or which model
 * runs, must never require a code edit.
 *
 * RESOLVED FROM THE PROCESS WORKING DIRECTORY, not from this file's location.
 *   The standalone app used `import.meta.dirname`, which is exact when Node runs
 *   the TypeScript directly. Next.js bundles server code, so a module's runtime
 *   location is a build artifact and `import.meta.dirname` points into `.next/`
 *   rather than at the repository — the assets would resolve to nothing, and the
 *   first symptom would be a generation that fails deep inside the pipeline
 *   rather than an honest "asset missing" at startup.
 *
 *   `PO_UI_ASSETS_DIR` overrides it, which is what a container image with the
 *   assets mounted elsewhere needs.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ASSET_ROOT } from "../asset-root";

/** po-ui-assets/ — the root every relative path in the config resolves against */
export const APP_ROOT = ASSET_ROOT;

export const CONFIG_PATH = join(APP_ROOT, "config", "pipeline.json");

export interface ModelConfig {
  id: string;
  /**
   * Top-level descriptor keys left OUT of the schema sent on the extraction call.
   *
   * The structured-output grammar has a hard ceiling and the descriptor schema
   * sits against it (see extractionSchema in pipeline.ts for the probe). Config
   * rather than a constant so what is dropped is visible in a diff.
   */
  extractSchemaOmit?: string[];
  maxTokens: number;
  extractEffort: string;
  generateEffort: string;
  serverSideFallback: boolean;
  /**
   * Abort a streaming model call that goes this long without a character.
   *
   * WHY THIS EXISTS: on 2026-09-10 a generation streamed 28,038 characters and
   * then produced nothing further — no bytes, no error, no close. `call()`
   * awaits `finalMessage()`, so a stream that simply stops leaves the request
   * open for ever: the retry loop never fires (a hang is not an exception), the
   * HTTP request never returns, and the engineer watches a spinner with no way
   * to tell a slow run from a dead one.
   *
   * ARMED BEFORE THE FIRST TOKEN, so it also bounds time-to-first-token, and
   * reset on every character, so a long run is never cut short mid-flow.
   *
   * The number must clear the slowest legitimate silence, which is the wait for
   * the first token — measured at 23-29s (medium), 50-59s (high) and 86.5s
   * (xhigh); the worst observed in a real run was 49.2s. Mid-stream gaps are far
   * smaller. 120s leaves better than 2x headroom over the worst measurement and
   * still fails fast against a hang that would otherwise never end.
   *
   * Set to 0 to disable.
   */
  streamIdleSeconds?: number;
}

export interface PageDefaults {
  layoutColumns: number;
  layoutWidth: number;
  titleFollowsName: boolean;
}

export interface MasterDataConfigRaw {
  cultures: string[];
  primaryCulture: string;
  featurePrefix: string;
  messageType: string;
  loadOrder: Record<string, number>;
}

export interface EntityTypesConfigRaw {
  /** the schema dump to build ENTITY-TYPES.md from */
  source: string;
  /** entities whose FULL property list goes in the asset; everything else is indexed by name */
  detail: string[];
}

export interface GuiTestsConfigRaw {
  /** where Athena's Selenium suite lives; read by scripts/extract-selectors.ts */
  source: string;
  /** where the live localized-message dump lives; read by scripts/extract-message-text.ts */
  messageSource?: string;
  /** the culture whose text the selectors are written against */
  culture?: string;
}

export interface PipelineConfig {
  packageDir: string;
  samplesDir: string;
  assets: Record<string, string>;
  samples: readonly string[];
  model: ModelConfig;
  page: PageDefaults;
  loop: { maxAttempts: number };
  postProcess: { assignIds: boolean };
  /** the deployment unit's shape — optional, so an older config still loads */
  masterData?: MasterDataConfigRaw;
  /** sources for the generated GUI-test assets — optional for the same reason */
  guiTests?: GuiTestsConfigRaw;
  /** how ENTITY-TYPES.md is built — which entities go in full, which are only indexed */
  entityTypes?: EntityTypesConfigRaw;
  /**
   * Which widget kinds get a transcribed exemplar in `WIDGET-SHAPES.json`.
   *
   * Counts are harvested for every kind the client has delivered; `detail` only
   * decides which ones are worth the prompt budget of a full settings block.
   * Config for the same reason `entityTypes.detail` is: the asset sits before the
   * cache breakpoint, so what goes in it is a cost decision, not a code one.
   */
  widgetShapes?: { detail?: string[]; exemplarsPerKind?: number };
  /**
   * Placeholder row values the preview shows, by pool name.
   *
   * The pools were the client's own vocabulary written into `preview.ts` — their
   * sites, their lot-id format, and two employees' login names. Config now, with
   * neutral defaults in code, so a mock for one client cannot show another
   * client's data. Omit it and the neutral defaults stand.
   */
  preview?: { sampleData?: Record<string, string[]> };
  /** input guards — optional, so a config written before they existed still loads */
  limits?: { storyChars?: number };
  /** where already-delivered query exports live, for transcription (T-21) */
  querySources?: { roots?: string[]; excludeContaining?: string[] };
  /**
   * Where the LIVE PORTAL harvest lives — base-tenant JSON, read-only.
   *
   * Separate from `querySources` on purpose. Those roots hold the CLIENT's
   * delivered `.xml`; this holds a different tenant's pages in JSON, and the two
   * carry different weight. Merging them is how a base-tenant label would
   * silently outrank a delivered one, which DICTIONARY.md's TENANTS section
   * exists to forbid.
   *
   * Measured 2026-08-28: 66 pages, 325 labelled sites, adding 102 paths the
   * label assets had never seen — all of it harvested and then read by nothing,
   * because the extractors walked `.xml` only.
   */
  liveSources?: { roots?: string[] };
  /**
   * Harvested sources that are deliberately NOT read, each with its reason.
   *
   * `scripts/audit-harvest.ts --check` fails on anything under
   * `liveSources.roots` that no consumer reads and this does not explain. The
   * invariant is not "every byte is used" — it is that no harvested file is one
   * nobody has thought about.
   */
  harvestAudit?: { unused?: Array<{ file: string; why: string }> };
  /**
   * The extracted `.txt` copies of the requirement documents, and where their
   * `.docx` originals live.
   *
   * The `.txt` files are DERIVED — `scripts/extract-stories.ts` writes them
   * through the same `documentText()` the application uses, and `--check` fails
   * when they drift. They had drifted: 14 of 18 were missing content, up to
   * 2,748 characters, and what they were missing was the Word review comments —
   * the part carrying accepted decisions that never reach the body text (§2.5).
   */
  stories?: { dir?: string; sources?: string[] };
  /**
   * Where OUR OWN generated artifacts live, so the evidence audit can tell them
   * from the client's (F-169).
   *
   * Config rather than a constant for the standing no-hardcoding reason, and
   * because the distinction is subtle enough to be worth writing down: a run
   * directory holds both what we produced and what we ran against, so ours is
   * identified by the FILENAMES we write, not by the directory.
   */
  evidenceAudit?: { ourOutputRoots?: string[]; ourOutputFiles?: string[] };
  /** where the client registers their custom action ids (T-31) */
  actionIds?: { source?: string };
  /**
   * Whether the intake conversation is a SEQUENCE or a set of tools the model
   * may reach for in any order.
   *
   * `requirePrdBeforeGenerate` REVERSES a decision this project made
   * deliberately and recorded twice (LEDGER §8, §13.9): the PRD was a step and
   * not a gate, so an engineer who said "just build it" got that. It is a gate
   * now because the client asked for the flow to be enforced — requirement
   * document, then questions, then a PRD they can argue with, and only then
   * code.
   *
   * Config rather than a constant so the reversal is one edit to undo, and so
   * a different client can have the old behaviour without a code change.
   */
  flow?: { requirePrdBeforeGenerate?: boolean; requirePrdReview?: boolean };
}

export class ConfigError extends Error {}

function req<T>(value: T | undefined, what: string): T {
  if (value === undefined || value === null) {
    throw new ConfigError(`pipeline.json is missing ${what}`);
  }
  return value;
}

export function loadPipelineConfig(path: string = CONFIG_PATH): PipelineConfig {
  if (!existsSync(path)) {
    throw new ConfigError(
      `pipeline configuration not found at ${path} — the generator cannot ` +
      `locate the prompt package without it`,
    );
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError(`pipeline.json is not valid JSON: ${(e as Error).message}`);
  }

  const model = req(raw["model"] as ModelConfig | undefined, "model");
  const loop = req(raw["loop"] as { maxAttempts: number } | undefined, "loop");
  const page = req(raw["page"] as PageDefaults | undefined, "page");
  const post = req(raw["postProcess"] as { assignIds: boolean } | undefined, "postProcess");

  return {
    packageDir: req(raw["packageDir"] as string | undefined, "packageDir"),
    samplesDir: req(raw["samplesDir"] as string | undefined, "samplesDir"),
    assets: req(raw["assets"] as Record<string, string> | undefined, "assets"),
    samples: req(raw["samples"] as string[] | undefined, "samples"),
    model: {
      id: req(model.id, "model.id"),
      maxTokens: req(model.maxTokens, "model.maxTokens"),
      extractEffort: req(model.extractEffort, "model.extractEffort"),
      generateEffort: req(model.generateEffort, "model.generateEffort"),
      serverSideFallback: model.serverSideFallback !== false,
      extractSchemaOmit: model.extractSchemaOmit ?? [],
      /* Passed through rather than defaulted here: `client.ts` owns the
         fallback, so a config that omits this and a config that cannot be read
         at all end up at the same ceiling instead of two different ones. */
      streamIdleSeconds: model.streamIdleSeconds,
    },
    page: {
      layoutColumns: req(page.layoutColumns, "page.layoutColumns"),
      layoutWidth: req(page.layoutWidth, "page.layoutWidth"),
      titleFollowsName: page.titleFollowsName !== false,
    },
    loop: { maxAttempts: req(loop.maxAttempts, "loop.maxAttempts") },
    postProcess: { assignIds: post.assignIds !== false },
    // Optional on purpose: master data is a later addition, and a config written
    // before it existed must still load rather than fail at startup.
    masterData: raw["masterData"] as MasterDataConfigRaw | undefined,
    guiTests: raw["guiTests"] as GuiTestsConfigRaw | undefined,
    entityTypes: raw["entityTypes"] as EntityTypesConfigRaw | undefined,
    widgetShapes: raw["widgetShapes"] as PipelineConfig["widgetShapes"],
    preview: raw["preview"] as PipelineConfig["preview"],
    limits: raw["limits"] as { storyChars?: number } | undefined,
    querySources: raw["querySources"] as
      { roots?: string[]; excludeContaining?: string[] } | undefined,
    liveSources: raw["liveSources"] as PipelineConfig["liveSources"],
    harvestAudit: raw["harvestAudit"] as PipelineConfig["harvestAudit"],
    stories: raw["stories"] as PipelineConfig["stories"],
    actionIds: raw["actionIds"] as { source?: string } | undefined,
    evidenceAudit: raw["evidenceAudit"] as PipelineConfig["evidenceAudit"],
    flow: raw["flow"] as PipelineConfig["flow"],
  };
}

/**
 * Refuse a story that cannot be sent, with a message the user can act on.
 *
 * Without this a runaway document reached the model and failed as an opaque API
 * error (T-23). The web upload's 5 MB body cap did not help: 5 MB of text is
 * roughly 1.2 million tokens, far past what any request can carry.
 */
export function checkStorySize(cfg: PipelineConfig, story: string, what = "story"): void {
  const max = cfg.limits?.storyChars;
  if (!max || story.length <= max) return;
  // Thousands separators, not toLocaleString(): that follows the machine's
  // locale and rendered 4,483,997 as "44,83,997" on this one.
  const group = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  throw new ConfigError(
    `the ${what} is ${group(story.length)} characters, over the ` +
    `${group(max)} limit in pipeline.json (limits.storyChars). ` +
    `For scale, the largest document the client has sent is about 43,000. ` +
    `Split it, or raise the limit in config if this one is genuine.`,
  );
}

/**
 * THE SAME PATH, AS THE FILESYSTEM ACTUALLY SPELLS IT.
 *
 * A config path is UTF-8, because `pipeline.json` is. The name on disk is
 * whatever the tool that wrote it produced - and a deployment bundle crosses
 * zip, unzip, Docker and a host locale on its way to the instance. Any one of
 * them can re-encode a non-ASCII character in the name.
 *
 * MEASURED on the first Elastic Beanstalk deployment, 2026-09-01. The evidence
 * package directory contains an EN DASH. On the instance the tree was extracted
 * intact - `CMF exports` counted 69, exactly as locally, because counting WALKS
 * the tree and a walk never has to spell a name. But `samplesDir` is a DIRECT
 * lookup, an exact byte comparison, and it failed: `samples 0`, and the boot
 * banner correctly refused to call the deployment sound.
 *
 * So the walk is the reliable operation and the direct lookup is the fragile
 * one. This makes the direct lookup fall back to a walk: for each segment that
 * does not exist verbatim, read the parent and look for an entry that matches
 * once Unicode normalisation is removed from the question, then for exactly one
 * entry that matches with every non-ASCII character treated as a wildcard.
 *
 * EXACTLY ONE, never the first of several. Two directories differing only in a
 * character we cannot compare is a situation where guessing would pick the
 * wrong evidence silently, which is the failure this project treats as worse
 * than stopping.
 *
 * Returns the input unchanged when it exists, and when nothing matches - so a
 * genuinely missing path still reports as missing rather than as a near miss.
 */
export function resolveOnDisk(p: string): string {
  if (existsSync(p)) return p;

  const parts = p.split(/[\\/]/);
  if (parts.length < 2) return p;

  /* Absolute paths start with a drive or an empty segment; keep whichever it is
     as the root and rebuild from there. */
  let cur = parts[0] === "" ? "/" : parts[0]!;
  for (const seg of parts.slice(1)) {
    if (!seg) continue;
    const direct = join(cur, seg);
    if (existsSync(direct)) { cur = direct; continue; }

    let entries: string[];
    try { entries = readdirSync(cur); } catch { return p; }

    // Same characters, different Unicode composition.
    const norm = (x: string): string => x.normalize("NFC");
    let hit = entries.filter((e) => norm(e) === norm(seg));

    /* Still nothing: compare with the non-ASCII parts wildcarded, which is
       precisely the class of difference a re-encoding introduces.

       A RUN of non-ASCII collapses to ONE marker, and that "+" is the whole
       point. Re-encoding rarely swaps one character for one character; it
       EXPANDS. An en dash is three UTF-8 bytes, and a reader that takes them
       for Latin-1 produces three characters where there was one. Wildcarding
       per character then compares a 1-marker name against a 3-marker name and
       finds nothing - which is exactly what the first deployment did. */
    if (hit.length === 0) {
      const fold = (x: string): string => x.replace(/[^\x20-\x7E]+/g, "\u0001");
      hit = entries.filter((e) => fold(e) === fold(seg));
    }

    if (hit.length !== 1) return p;   // absent, or ambiguous - say so
    cur = join(cur, hit[0]!);
  }
  return cur;
}

/** Resolve a config-relative path against app/, leaving absolute paths alone. */
export function resolvePath(p: string, base: string = APP_ROOT): string {
  return resolveOnDisk(isAbsolute(p) ? p : resolve(base, p));
}

/** Resolve an asset inside the package directory. */
export function assetPath(cfg: PipelineConfig, key: string): string {
  const rel = cfg.assets[key];
  if (rel === undefined) {
    throw new ConfigError(
      `pipeline.json assets has no entry "${key}" (have: ${Object.keys(cfg.assets).join(", ")})`,
    );
  }
  return resolveOnDisk(isAbsolute(rel)
    ? rel
    : resolve(resolvePath(cfg.packageDir), rel));
}

export function readAsset(cfg: PipelineConfig, key: string): string {
  const p = assetPath(cfg, key);
  if (!existsSync(p)) {
    throw new ConfigError(`asset "${key}" not found at ${p}`);
  }
  return readFileSync(p, "utf-8");
}

export function samplePaths(cfg: PipelineConfig): string[] {
  const dir = resolvePath(cfg.samplesDir);
  return cfg.samples.map((s) => resolveOnDisk(join(dir, s)));
}

/** Absolute roots to search for delivered query exports. Empty disables transcription. */
export function querySourceRoots(cfg: PipelineConfig): string[] {
  return (cfg.querySources?.roots ?? []).map((r) => resolvePath(r));
}

/**
 * Paths inside the evidence roots that must NOT be treated as evidence.
 *
 * 2026-08-27. Athena sent a requirement document and its delivered output as a
 * pair for us to test against, and dropped it inside `CLIENT SRC` — which is an
 * evidence root. Within one `npm test` the extractors had absorbed it: the page
 * count went 32 -> 33, form-field message references 33 -> 35, and
 * `AttachConsumablesToResource` was suddenly sourced from the test pair's own
 * output file.
 *
 * That is circular. A pair exists to answer "could we have produced this?", and
 * it cannot answer that once its answer is in the dictionary the generator
 * reads. The staleness gates caught it, which is the only reason it was noticed
 * within minutes rather than surfacing as a suspiciously good score.
 *
 * Config-driven so a new drop is one line, and so the exclusion is visible in a
 * diff rather than buried in a scanner.
 */
export function isExcludedFromEvidence(cfg: PipelineConfig, path: string): boolean {
  const patterns = cfg.querySources?.excludeContaining ?? [];
  if (!patterns.length) return false;
  const norm = path.replace(/\\/g, "/").toLowerCase();
  return patterns.some((p) => norm.includes(p.replace(/\\/g, "/").toLowerCase()));
}
