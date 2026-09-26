/**
 * THE PIPELINE — user story in, validated artifact out.
 *
 *   story ──▶ [extract] ──▶ descriptor ──▶ [generate] ──▶ settings + gap report
 *                                              │
 *                              our code: $id, escape, assemble
 *                                              │
 *                                          [validate] ──▶ pass? done
 *                                              │  fail
 *                                              └──▶ feed findings back, regenerate
 *
 * Only FAIL findings trigger a regeneration. A WARN means "a human should look",
 * and looping on those would spend tokens chasing things the model cannot fix —
 * an unverifiable data path is a gap for Athena, not a defect to retry.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { applyPageProperties, assemble, fillShell, mergeSettings,
         rawSettings } from "./assemble";
import { auditIds } from "./ids";
import { call, usageLine, StreamStalledError, type CallResult } from "./client";
import { buildPackage, manifestTable, OUTPUT_CONTRACT, vocabularyPackage,
         type PromptPackage } from "./prompt";
import { parseGeneration, parseJsonBlock, ParseError } from "./parse";
import { assetPath, checkStorySize, querySourceRoots, readAsset,
         type PipelineConfig } from "./config";
import { effectiveSpec, parseDescriptor, pageFor, queryDefinitionFor,
         type EffectiveSpec, type PageSpecType, type SpecDescriptor } from "../descriptor";
import { assembleQuery, inputPortsOf, mandatoryPortsOf } from "./query";
import { completeQuery, formatQueryCompletion,
         type QueryChange } from "./query-complete";
import { addFields, relaxFilter } from "./query-edit";
import { parseEntityProperties } from "../prevalidate";
import { findQueryDefinitions } from "./query-read";
import { formatRevision, reviseDescriptor, type RevisionResult } from "./revise";
import { buildPrd, prdHtml, EMPTY_NARRATIVE, NARRATIVE_SCHEMA,
         type PrdNarrative } from "./prd";
import { buildMasterData, formatMasterData, loadKnownMessages, messageNamesIn,
         type MasterDataArtifact, type MasterDataConfig } from "./masterdata";
import { columnBrief } from "./column-brief";
import { loadRelations } from "./relations";
import { findDeliveredPage } from "./find-page";
import { checkEnumColumns } from "../enum-checks";
import { applyTemplates, formatTemplateOutcome, loadTemplateLibrary, parseSettings,
         type TemplateOutcome } from "./templates";
import { applyEdits, introducedUnknowns, diffSettings, parseEditOps, summariseDiff, unexpectedChanges,
         type Change, type Diff } from "./modify";
import { completeActionButtons, formatButtonCompletion, loadActionContracts,
         type ContractLibrary } from "./buttons";
import { completeDataSources, formatDataSourceCompletion } from "./datasources";
import { validateQuery, type QueryReport } from "../query-checks";
import { checkPageIntegrity } from "../page-integrity";
import { basePort, widgetBehind } from "../platform";
import { checkColumnCoverage, checkMandatoryBindings, checkReferenceColumns, checkWiring,
         type ColumnCoverageInput, type MandatoryBindingInput } from "../wiring-checks";
import { declaredTextIn, formatGuiReport, loadMessageText, loadSelectorLibrary,
         selectorBrief, validateSelectors, actionIdBrief, loadActionLibrary,
         type GuiReport } from "../gui-checks";
import { applyNamePrefix, clientName, loadConventions, pageTypeBrief } from "../conventions";
import { format, validate, type Report } from "../index";
import type { Result } from "../types";

export interface RunOptions {
  cfg: PipelineConfig;
  client: Anthropic;
  /** the user story; omitted when a descriptor is supplied directly */
  story?: string;
  descriptor?: SpecDescriptor;
  pageName: string;
  outDir: string;
  objectId: string;
  /** page-specific values the skeleton leaves open; defaults come from config */
  layoutColumns?: number;
  layoutWidth?: number;
  pageTitle?: string;
  /** keep the target page in the samples — contaminates the run; for debugging only */
  includeTargetSample?: boolean;
  /**
   * An exported page to PORT customTemplate markup from, for columns the
   * generator left with neither a type code nor a template.
   *
   * Deliberately has no default. Templates vary per page — `Name` carries two
   * different ones across Athena's own artifacts — so an unnamed source would
   * silently apply markup from an unrelated screen.
   */
  templatesFrom?: string;
  /**
   * Supply the values Athena's GUI tests constrain on this page (A-53).
   *
   * On by default: where their suite pins a widget name or a button id, that
   * value is given rather than chosen, and withholding it produces a page that
   * fails their suite. The switch exists so the prompt change can be measured
   * before and after — a read-through is not verification (F-63) — and it is a
   * labelled opt-out for exactly that use, not a routine setting.
   */
  guiBrief?: boolean;
  /**
   * Optional prompt-asset blocks to withhold, by name — the A/B control for any
   * config-driven asset. `--without services` is §1.3b's labelled control; the
   * mechanism is general so the next asset does not need its own flag.
   */
  withholdAssets?: readonly string[];
  /** Opt in to the precomputed data-path table. MEASURED SLOWER; off by default. */
  columnBrief?: boolean;
  log?: (line: string) => void;
  /**
   * The artifact as it is written, delta by delta.
   *
   * The CLI does not want this — it prints a character count and moves on. The
   * web app does: a three-minute generation with nothing on screen but a
   * spinner reads as a hang, and the thing the engineer actually wants to watch
   * is the file taking shape.
   *
   * Optional, so every existing caller and the offline replay are untouched.
   */
  onCode?: (delta: string, attempt: number) => void;
  /**
   * A FINISHED file, once it is on disk.
   *
   * The page definition streams from the model (`onCode`), but the queries and
   * the master-data unit do not — our code assembles those from the descriptor
   * after the model is done. Without this they appeared only as filenames in
   * the deployment-unit list, so two thirds of what a run produces was never
   * actually shown.
   *
   * Optional, like `onCode`: the CLI writes files and says so in one line.
   */
  onFile?: (name: string, content: string) => void;
}

/** One query the page consumes: either an artifact on disk, or a stated gap. */
export interface QueryOutcome {
  name: string;
  built: boolean;
  path?: string;
  /** the data-source input ports this query exposes — the page's links bind to these */
  inputPorts?: string[];
  /**
   * Of those ports, the ones a MANDATORY filter depends on.
   *
   * Separated from `inputPorts` because the consequence differs: an optional
   * filter left unbound drops itself, and a mandatory one left unbound compares
   * against NULL and empties the grid.
   */
  mandatoryPorts?: string[];
  /** the query validator's verdict, when the artifact was built */
  report?: QueryReport;
  /**
   * Every `<Alias value="…">` the WRITTEN query file carries.
   *
   * Read back from the file rather than derived from the definition, because
   * the two can differ: a transcribed query keeps their `__cmf_html_*` aliases,
   * which our own builder never produces. The reference-column check needs what
   * was actually emitted, not what we meant to emit.
   */
  aliases?: string[];
  /**
   * Column roots this query cannot supply because the join is not evidenced.
   *
   * Carried so the coverage check can say "named and unresolved" rather than
   * "missing", which are different findings and deserve different levels.
   */
  unevidenced?: string[];
  /**
   * What we changed in an artifact the client already ships.
   *
   * Carried out of the pipeline so the PACKAGE can state it: the recipient
   * imports a zip, not a run log, and "this replaces a live query" is not a
   * thing to learn afterwards.
   */
  changes?: QueryChange[];
  /**
   * The field paths this query SELECTS.
   *
   * Held so a grid's columns can be checked against it: a column bound to a
   * property the query never selected renders blank, and neither artifact is
   * wrong on its own.
   */
  fields?: string[];
  /**
   * The delivered export this was copied from, when it was copied rather than
   * generated. Present means the client already ships this query and the package
   * carries THEIR file, byte for byte.
   */
  transcribedFrom?: string;
  reason?: string;
}

/** The deployment unit, when one was written. */
export interface MasterDataOutcome {
  path: string;
  document: Record<string, unknown>;
  declared: string[];
  inherited: string[];
  derivedText: Array<{ name: string; text: string }>;
  fileName: string;
}

export interface RunResult {
  descriptor: SpecDescriptor;
  report: Report;
  attempts: number;
  artifactPath: string;
  usage: CallResult["usage"][];
  /** Query exports generated alongside the page (§ Phase-1d backend configuration) */
  queries: QueryOutcome[];
  /** the master-data deployment unit — without it the artifacts are not deployable */
  masterData?: MasterDataOutcome;
  /** what the template port did, when a source was named */
  templates?: TemplateOutcome;
  /** the page against Athena's own GUI-test selectors, when a scope covers it */
  gui?: GuiReport;
}

const noop = (): void => {};

/**
 * The descriptor schema AS SENT on the extraction call.
 *
 * MEASURED 2026-08-28, by probing the API rather than reasoning about it:
 *
 *   22 optionals · 3,856 B   ACCEPTED
 *   22 optionals · 4,114 B   REJECTED — "the compiled grammar is too large"
 *   24 optionals · 4,336 B   REJECTED
 *   16 optionals · 3,055 B   ACCEPTED   (the same schema without queryDefinitions)
 *
 * So the ceiling is grammar STRUCTURE, not the optional count the error message
 * mentions — two variants with the identical optional count fall on opposite
 * sides of it. And the descriptor schema was sitting **hard against that
 * ceiling** with nobody aware: the first field added to it, of any kind, took
 * every `--story` run down at call 1.
 *
 * WHAT IS OMITTED, AND WHY IT IS THE RIGHT THING TO OMIT
 *   `queryDefinitions` is query STRUCTURE — entity, fields, filters, joins. This
 *   project does not extract that from prose and has not since T-21: it is
 *   TRANSCRIBED from the exports the client already delivered, because a join
 *   cannot be inferred (`ProductionOrder -> Product` joins `ProductId ->
 *   DefinitionId`, which no naming rule predicts — F-125). An inferred query
 *   would run and return the wrong rows.
 *
 *   So the subtree costs a third of the grammar budget to constrain a field the
 *   pipeline fills from evidence afterwards. `query-read.ts` still populates it,
 *   hand-authored descriptors still carry it, and zod still validates it — only
 *   the WIRE schema for this one call omits it.
 *
 * Config-driven (`model.extractSchemaOmit`), so what is dropped is visible in a
 * diff and reversible without a code change.
 */
export function extractionSchema(cfg: PipelineConfig): unknown {
  const schema = JSON.parse(readFileSync(assetPath(cfg, "descriptorSchema"), "utf-8")) as
    { properties?: Record<string, unknown> };
  for (const key of cfg.model.extractSchemaOmit ?? []) {
    delete schema.properties?.[key];
  }
  return schema;
}

/** Call 1 — user story to spec descriptor. */
export async function extractDescriptor(
  cfg: PipelineConfig, client: Anthropic, story: string,
  log: (l: string) => void = noop,
): Promise<SpecDescriptor> {
  /* The client's page-class habit, appended to the extract instructions rather
     than written into `EXTRACT_PROMPT.md`: it is a fact about THIS client and
     the prompt asset is the same for every one. §1.2 - the trap is that a page
     NAMED "...Step" reads as `uiType: Step`, and this client ships those as
     `Page`. Empty string when the convention is not configured, so the prompt is
     unchanged for a client who has no such habit. */
  const pageClass = pageTypeBrief(loadConventions());
  const instructions = pageClass
    ? `${readAsset(cfg, "extractPrompt")}

${pageClass}`
    : readAsset(cfg, "extractPrompt");
  const schema = extractionSchema(cfg);

  /*
   * THE VOCABULARY REACHES THE CALL THAT DECIDES THE VOCABULARY.
   *
   * Until 2026-08-28 this call had `EXTRACT_PROMPT.md` and nothing else, so
   * every asset built to answer "what CMF path does this word mean" arrived at
   * the call that WRITES the page and never at the one that DECIDES it. This is
   * where "Storage Step" becomes `Step` and "Batch" becomes
   * `ManufacturerLotNumber`; it was choosing blind.
   *
   * The vocabulary subset, not the whole package: extraction fills in no
   * skeleton and copies no sample, and handing it those would be tokens spent
   * on a job it is not doing.
   */
  const vocab = vocabularyPackage(cfg);

  log("  extracting descriptor from the user story...");
  const res = await call({
    client,
    model: cfg.model,
    effort: cfg.model.extractEffort,
    system: [...vocab.blocks, { type: "text", text: instructions }],
    user: `Here is the user story.\n\n---\n${story}\n---`,
    schema,
  });
  log(`  <- ${usageLine(res)}`);

  // The API enforces the schema; zod is the contract we actually trust, and its
  // errors name the exact field. Both run.
  return parseDescriptor(parseJsonBlock(res.text), "<extracted>");
}

/**
 * Phase 1(b) — requirement document to PRD.
 *
 * Two calls at most: extract a descriptor (skipped when one is supplied), then ask
 * for the narrative. Everything factual is derived from the descriptor by
 * `buildPrd`, so this function's only job is to get the prose and write the files.
 *
 * `feedback` carries the user's reaction on a re-run — the "brain storming where
 * the user can give more detail and feedback" step. Since 2026-08-21 it may change
 * the SPECIFICATION and not only the prose: a reader tweaks the PRD until it says
 * what they want, and the UI preview follows, because both are derived from the
 * descriptor. Every change is diffed and reported (`revise.ts`); nothing moves
 * silently.
 */
export async function runPrd(opts: PrdOptions): Promise<PrdResult> {
  const { cfg, client } = opts;
  const log = opts.log ?? noop;
  const usage: CallResult["usage"][] = [];

  mkdirSync(opts.outDir, { recursive: true });

  let descriptor = opts.descriptor;
  if (!descriptor) {
    if (!opts.story) throw new Error("runPrd() needs either a story or a descriptor");
    checkStorySize(cfg, opts.story);
    descriptor = await extractDescriptor(cfg, client, opts.story, log);
  }

  /*
   * ALWAYS write the descriptor beside the PRD, however we got it.
   *
   * This used to be written only when we EXTRACTED one — but in the chat path the
   * model supplies the descriptor to `write_prd`, so that branch was skipped and
   * the file never appeared. The PRD-stage preview reads it from here, so asking
   * to see the screen failed with an internal error even though the PRD existed.
   *
   * It is also what a later revision diffs against, so it must be on disk before
   * any feedback arrives, not only after the first one.
   */
  writeFileSync(join(opts.outDir, "descriptor.json"),
    JSON.stringify(descriptor, null, 2), "utf-8");

  /*
   * Feedback may CHANGE THE SPECIFICATION, not just the prose.
   *
   * Until 2026-08-21 it could only rewrite the narrative, so a reader could tweak
   * the PRD indefinitely and the screen never moved — the PRD was a mirror. The
   * team asked for the opposite: tweak until it says what you want, and watch the
   * UI preview follow. That requires feedback to reach the descriptor, because
   * the preview and the PRD are both derived from it.
   *
   * The safety property is kept by making every change VISIBLE rather than by
   * refusing to change: `reviseDescriptor` diffs the two descriptors itself and
   * reports anything the model changed without saying so.
   */
  let revision: RevisionResult | undefined;
  if (opts.feedback) {
    revision = await reviseDescriptor(cfg, client, descriptor, opts.feedback, opts.story, log);
    usage.push(revision.usage);
    for (const line of formatRevision(revision)) log(line);
    if (revision.changed) {
      descriptor = revision.descriptor;
      writeFileSync(join(opts.outDir, "descriptor.json"),
        JSON.stringify(descriptor, null, 2), "utf-8");
    }
  }

  log("  writing the PRD narrative...");
  const instructions = readAsset(cfg, "prdPrompt");
  const parts = [
    "Here is the requirement document.",
    "",
    "---",
    opts.story ?? "(not supplied — work from the descriptor alone and say so in assumptions)",
    "---",
    "",
    "And here is the spec descriptor extracted from it. The page names in",
    "`pagePurpose` must match these exactly.",
    "",
    "```json",
    JSON.stringify(descriptor, null, 2),
    "```",
  ];
  if (opts.feedback) {
    parts.push("", "---", "",
      "The reader has reviewed an earlier draft and replied. Rewrite the narrative",
      "taking this into account. Do not treat it as a new requirement unless they",
      "are plainly stating one — if they are, say so in `assumptions`.",
      "", opts.feedback);
  }

  const res = await call({
    client, model: cfg.model, effort: cfg.model.extractEffort,
    /* The same vocabulary the extraction now gets. The narrative explains the
       descriptor's choices to a reader, and it cannot say WHY a term maps to a
       path without the evidence that decided it. */
    system: [...vocabularyPackage(cfg).blocks, { type: "text", text: instructions }],
    user: parts.join("\n"),
    schema: NARRATIVE_SCHEMA,
  });
  usage.push(res.usage);
  log(`  <- ${usageLine(res)}`);

  const narrative = { ...EMPTY_NARRATIVE, ...(parseJsonBlock(res.text) as PrdNarrative) };
  const markdown = buildPrd({
    descriptor, narrative, source: opts.sourceName ?? "requirement document",
    generatedAt: opts.generatedAt,
  });
  const title = descriptor.title ?? descriptor.pages[0]?.name ?? "UI screen";

  const mdPath = join(opts.outDir, "PRD.md");
  const htmlPath = join(opts.outDir, "PRD.html");
  writeFileSync(mdPath, markdown, "utf-8");
  writeFileSync(htmlPath, prdHtml(markdown, `PRD — ${title}`), "utf-8");
  log(`  PRD written: ${mdPath}`);
  log(`               ${htmlPath}  (downloadable — opens in a browser or Word)`);

  return { descriptor, narrative, markdown, mdPath, htmlPath, usage, revision };
}

export interface PrdOptions {
  cfg: PipelineConfig;
  client: Anthropic;
  story?: string;
  descriptor?: SpecDescriptor;
  outDir: string;
  /** shown in the PRD's provenance line */
  sourceName?: string;
  /** the reader's reaction to a previous draft — the brainstorming loop */
  feedback?: string;
  /** injected for reproducible tests */
  generatedAt?: string;
  log?: (line: string) => void;
}

export interface PrdResult {
  descriptor: SpecDescriptor;
  /** what the reader's feedback changed about the SPECIFICATION, if anything */
  revision?: RevisionResult;
  narrative: PrdNarrative;
  markdown: string;
  mdPath: string;
  htmlPath: string;
  usage: CallResult["usage"][];
}

/**
 * COPY-AND-MODIFY — an existing artifact plus a change request, out comes the
 * modified artifact.
 *
 * Serves BOTH of Athena's scope items in one operation: (a) "refer to OOB
 * templates as a baseline" when the source is a stock CMF page, and (e) "modify
 * an existing screen" when it is the customer's own. Their developers work this
 * way — five of their custom pages are 92–100% copies of a stock page (F-114).
 *
 * The model returns operations, never a rewritten file, and `unexpectedChanges`
 * proves nothing outside the claimed areas moved. That is ask B3 made checkable.
 */
export async function runModify(opts: ModifyOptions): Promise<ModifyRunResult> {
  const { cfg, client } = opts;
  const log = opts.log ?? noop;
  const usage: CallResult["usage"][] = [];

  mkdirSync(opts.outDir, { recursive: true });

  const sourceXml = readFileSync(opts.sourcePath, "utf-8");
  const source = parseSettings(sourceXml);
  const widgetNames = (source.widgets ?? [])
    .map((w) => w.settings?.name).filter(Boolean).join(", ");
  log(`  source: ${opts.sourcePath}`);
  log(`          ${(source.widgets ?? []).length} widget(s) [${widgetNames}], ` +
      `${(source.actionButtons ?? []).length} button(s), ${(source.links ?? []).length} link(s)`);

  // The change request is judged against the page as it actually is, so the model
  // sees the real definition rather than a summary of it.
  const instructions = readAsset(cfg, "modifyPrompt");
  // The registered action ids matter MORE here than on the create path: a change
  // request that adds a button ("add a Print button") almost never names the
  // action behind it, and US-455387 emitted `actionId: UNKNOWN` while the answer
  // sat in the client's own front-end registration (T-31).
  const modifyActions = actionBrief(cfg, log);
  const user = [
    "## The page as it exists today",
    "",
    "```json",
    JSON.stringify(source),
    "```",
    ...(modifyActions ? ["", modifyActions] : []),
    "",
    "## The change request",
    "",
    opts.changeRequest,
  ].join("\n");

  log("  reading the change request against the page...");
  const res = await call({
    client, model: cfg.model, effort: cfg.model.generateEffort,
    system: [...buildPackage(cfg, { excludePage: opts.excludePage }).blocks,
             { type: "text", text: instructions }],
    user,
  });
  usage.push(res.usage);
  log(`  <- ${usageLine(res)}`);

  const produced = parseGeneration(res.text);
  const ops = parseEditOps(produced.settings);
  log(`  ${ops.length} operation(s) proposed:`);
  for (const o of ops) log(`      ${o.op}`);

  const applied = applyEdits(source, ops);
  const diff = diffSettings(source, applied.settings);
  const unexpected = unexpectedChanges(diff, applied.changes);

  log("  changes applied:");
  for (const c of applied.changes) log(`      ${c.target} — ${c.detail}`);
  log(`  blast radius: ${summariseDiff(diff).join("  |  ") || "none"}`);
  if (unexpected.length) {
    log(`    !! B3 VIOLATION — these areas moved and no operation claimed them: ${unexpected.join(", ")}`);
  } else {
    log("    B3: nothing outside the claimed areas moved");
  }

  // Both output forms, because B2 is unanswered: Athena has not told us whether
  // they want the whole file or just the change. Operations give us both for free,
  // so we ship both rather than guess.
  const buttonsDone = completeActionButtons(
    applied.settings, loadConventions(), actionContracts(cfg, log));
  for (const line of formatButtonCompletion(buttonsDone.completion)) log(line);
  /* Runs after the blast-radius diff above, so completing an artifact never
     reads as an unclaimed change. A modified page whose grid opens empty is
     still a broken page. */
  const completed = completeDataSources(buttonsDone.settings);
  for (const line of formatDataSourceCompletion(completed.completion)) log(line);

  const outXml = join(opts.outDir, "MODIFIED.xml");
  const built = assemble({
    skeleton: readAsset(cfg, "skeleton"), settings: completed.settings,
    pageName: opts.pageName, uiType: opts.uiType ?? "Page", objectId: opts.objectId,
    assignIds: cfg.postProcess.assignIds,
  });
  writeFileSync(outXml, built.xml, "utf-8");
  writeFileSync(join(opts.outDir, "CHANGES.md"), formatChangeReport(applied.changes, diff, unexpected, opts),
    "utf-8");
  writeFileSync(join(opts.outDir, "GAP_REPORT.md"), produced.gapReport, "utf-8");

  const ids = auditIds(built.settings);
  log(`  assembled: ${built.xml.length} chars, ${ids.markers}/${ids.objects} $id markers`);

  const report = validate(outXml, assetPath(cfg, "dictionary"), opts.spec);
  const { PASS, WARN, FAIL } = report.counts;
  log(`  validated: PASS ${PASS}  WARN ${WARN}  FAIL ${FAIL}`);
  writeFileSync(join(opts.outDir, "REPORT.txt"),
    format(report, outXml, assetPath(cfg, "dictionary")), "utf-8");

  // An enhancement can break their suite as easily as a fresh build can — renaming
  // a widget is a one-line edit. No master data here, so declared labels are
  // unavailable and a new label resolves to nothing; that is reported as
  // unresolvable rather than as a mismatch.
  const gui = checkGui(cfg, outXml, opts.pageName, undefined, log);
  if (gui) writeFileSync(join(opts.outDir, "GUI_REPORT.md"),
    formatGuiFile(gui, opts.pageName, clientName(loadConventions())), "utf-8");

  return { changes: applied.changes, diff, unexpected, artifactPath: outXml, report, usage,
           gapReport: produced.gapReport, gui,
           /* Counted from the two files, not remembered from the edit. */
           unknowns: introducedUnknowns(source, applied.settings) };
}

/**
 * FIX A UI BUG - Athena scope item (e), third capability.
 *
 * The differentiator: **we do not need to be told what is wrong.** The validators
 * already detect the defect classes that matter - a widget declared but never
 * placed, a span running off the grid, a button nothing feeds, a data source
 * nothing reads. So a fix run starts by DIAGNOSING, and the bug report, when
 * there is one, is extra evidence rather than the only input.
 *
 * Everything else is runModify's machinery: the model returns operations, our
 * code applies them, and the diff proves nothing else moved. A repair that also
 * "improves" something nobody reported is a regression wearing a fix's clothes.
 */
export async function runFix(opts: FixOptions): Promise<FixRunResult> {
  const { cfg, client } = opts;
  const log = opts.log ?? noop;
  const usage: CallResult["usage"][] = [];
  mkdirSync(opts.outDir, { recursive: true });

  const dictPath = assetPath(cfg, "dictionary");
  const before = validate(opts.artifactPath, dictPath, opts.spec);
  const problems = before.results.filter((r) => r.level !== "PASS");
  log(`  diagnosed: PASS ${before.counts.PASS}  WARN ${before.counts.WARN}  FAIL ${before.counts.FAIL}`);
  for (const p of problems) log(`      ${p.level} ${p.name}${p.detail ? ` - ${p.detail}` : ""}`);

  const EMPTY_DIFF: Diff = { added: [], removed: [], changed: [] };

  if (problems.length === 0 && !opts.bugReport) {
    log("  nothing to fix: the validator finds no defect and no bug was reported");
    return { before, after: before, changes: [], diff: EMPTY_DIFF, unexpected: [],
             artifactPath: opts.artifactPath, usage, gapReport: "", fixed: 0 };
  }

  const source = parseSettings(readFileSync(opts.artifactPath, "utf-8"));
  const user = [
    "## The page",
    "",
    "```json",
    JSON.stringify(source),
    "```",
    "",
    "## What the validator found",
    "",
    problems.length
      ? problems.map((p) => `- **${p.level}** ${p.name}${p.detail ? ` - ${p.detail}` : ""}`).join("\n")
      : "_Nothing. Work from the bug report alone._",
    ...(opts.bugReport ? ["", "## The bug report", "", opts.bugReport] : []),
  ].join("\n");

  log("  proposing fixes...");
  const res = await call({
    client, model: cfg.model, effort: cfg.model.generateEffort,
    system: [...buildPackage(cfg, { excludePage: opts.pageName }).blocks,
             { type: "text", text: readAsset(cfg, "fixPrompt") }],
    user,
  });
  usage.push(res.usage);
  log(`  <- ${usageLine(res)}`);

  const produced = parseGeneration(res.text);
  const ops = parseEditOps(produced.settings);

  if (ops.length === 0) {
    // A legitimate answer, and a better one than a page altered until the checks
    // stopped complaining. The gap report says what information would be needed.
    log("  no fixes proposed - see the gap report for what is missing");
    writeFileSync(join(opts.outDir, "GAP_REPORT.md"), produced.gapReport, "utf-8");
    return { before, after: before, changes: [], diff: EMPTY_DIFF, unexpected: [],
             artifactPath: opts.artifactPath, usage, gapReport: produced.gapReport, fixed: 0 };
  }

  log(`  ${ops.length} fix operation(s):`);
  for (const o of ops) log(`      ${o.op}`);

  const applied = applyEdits(source, ops);
  const diff = diffSettings(source, applied.settings);
  const unexpected = unexpectedChanges(diff, applied.changes);
  for (const c of applied.changes) log(`      ${c.target} - ${c.detail}`);
  if (unexpected.length) {
    log(`    !! these areas moved and no fix claimed them: ${unexpected.join(", ")}`);
  }

  const buttonsDone = completeActionButtons(
    applied.settings, loadConventions(), actionContracts(cfg, log));
  for (const line of formatButtonCompletion(buttonsDone.completion)) log(line);
  /* Runs after the blast-radius diff above, so completing an artifact never
     reads as an unclaimed change. A modified page whose grid opens empty is
     still a broken page. */
  const completed = completeDataSources(buttonsDone.settings);
  for (const line of formatDataSourceCompletion(completed.completion)) log(line);

  const outXml = join(opts.outDir, "FIXED.xml");
  const built = assemble({
    skeleton: readAsset(cfg, "skeleton"), settings: completed.settings,
    pageName: opts.pageName, uiType: opts.uiType ?? "Page", objectId: opts.objectId,
    assignIds: cfg.postProcess.assignIds,
  });
  writeFileSync(outXml, built.xml, "utf-8");

  const after = validate(outXml, dictPath, opts.spec);
  const fixed = before.counts.FAIL - after.counts.FAIL;
  log(`  re-validated: PASS ${after.counts.PASS}  WARN ${after.counts.WARN}  FAIL ${after.counts.FAIL}` +
      `  (${fixed >= 0 ? fixed : 0} FAIL fixed${fixed < 0 ? `, ${-fixed} INTRODUCED` : ""})`);
  for (const p of after.results.filter((r) => r.level === "FAIL")) {
    log(`      still failing: ${p.name}${p.detail ? ` - ${p.detail}` : ""}`);
  }

  writeFileSync(join(opts.outDir, "GAP_REPORT.md"), produced.gapReport, "utf-8");
  writeFileSync(join(opts.outDir, "REPORT.txt"), format(after, outXml, dictPath), "utf-8");
  writeFileSync(join(opts.outDir, "FIXES.md"),
    formatFixReport(before, after, applied.changes, diff, unexpected, opts), "utf-8");

  return { before, after, changes: applied.changes, diff, unexpected,
           artifactPath: outXml, usage, gapReport: produced.gapReport, fixed };
}

function formatFixReport(
  before: Report, after: Report, changes: readonly Change[], diff: Diff,
  unexpected: readonly string[], opts: FixOptions,
): string {
  const s: string[] = [];
  s.push(`# Fix report - ${opts.pageName}`);
  s.push("");
  s.push(`Artifact: \`${opts.artifactPath}\``);
  s.push("");
  s.push("| | Before | After |");
  s.push("|---|---|---|");
  s.push(`| FAIL | ${before.counts.FAIL} | ${after.counts.FAIL} |`);
  s.push(`| WARN | ${before.counts.WARN} | ${after.counts.WARN} |`);
  s.push(`| PASS | ${before.counts.PASS} | ${after.counts.PASS} |`);
  s.push("");
  if (opts.bugReport) {
    s.push("## The bug report");
    s.push("");
    s.push("> " + opts.bugReport.split("\n").join("\n> "));
    s.push("");
  }
  s.push("## Defects found, and what happened to each");
  s.push("");
  for (const r of before.results.filter((x) => x.level !== "PASS")) {
    const gone = !after.results.some((a) => a.level === r.level && a.name === r.name);
    s.push(`- **${r.level}** ${r.name}${r.detail ? ` - ${r.detail}` : ""} - ${gone ? "**fixed**" : "still present"}`);
  }
  s.push("");
  s.push("## What was changed");
  s.push("");
  s.push("| Operation | Where | Detail |");
  s.push("|---|---|---|");
  for (const c of changes) s.push(`| \`${c.op}\` | ${c.target} | ${c.detail} |`);
  s.push("");
  s.push("## Nothing else was touched");
  s.push("");
  for (const l of summariseDiff(diff)) s.push(`- ${l}`);
  s.push("");
  s.push(unexpected.length
    ? `**WARNING - ${unexpected.join(", ")} changed without a fix claiming it.**`
    : "Verified: every change falls inside an area a fix operation named.");
  s.push("");
  return s.join("\n");
}

export interface FixOptions {
  cfg: PipelineConfig;
  client: Anthropic;
  artifactPath: string;
  /** optional - the validator diagnoses on its own */
  bugReport?: string;
  pageName: string;
  uiType?: string;
  objectId: string;
  outDir: string;
  spec?: EffectiveSpec;
  log?: (line: string) => void;
}

export interface FixRunResult {
  before: Report;
  after: Report;
  changes: Change[];
  diff: Diff;
  unexpected: string[];
  artifactPath: string;
  usage: CallResult["usage"][];
  gapReport: string;
  /** FAIL findings removed; negative would mean the fix made it worse */
  fixed: number;
}

function formatChangeReport(
  changes: readonly Change[], diff: Diff, unexpected: readonly string[], opts: ModifyOptions,
): string {
  const s: string[] = [];
  s.push(`# Change report — ${opts.pageName}`);
  s.push("");
  s.push(`Source: \`${opts.sourcePath}\``);
  s.push("");
  s.push("## The change request");
  s.push("");
  s.push("> " + opts.changeRequest.split("\n").join("\n> "));
  s.push("");
  s.push("## What changed");
  s.push("");
  s.push("| Operation | Where | Detail |");
  s.push("|---|---|---|");
  for (const c of changes) s.push(`| \`${c.op}\` | ${c.target} | ${c.detail} |`);
  s.push("");
  s.push("## Blast radius");
  s.push("");
  s.push("Computed by diffing the file before and after, matching elements by identity rather than");
  s.push("position — so an inserted column does not read as a rewrite of everything after it.");
  s.push("");
  for (const l of summariseDiff(diff)) s.push(`- ${l}`);
  s.push("");
  s.push("## Nothing else was touched");
  s.push("");
  if (unexpected.length) {
    s.push(`**WARNING — these areas changed and no operation claimed them: ${unexpected.join(", ")}.**`);
    s.push("Treat this as a defect: an enhancement must not alter what it was not asked to.");
  } else {
    s.push("Verified: every change falls inside an area an operation named. `$id` markers are");
    s.push("excluded — they are a positional counter our code reassigns, so any insertion renumbers");
    s.push("everything after it.");
  }
  s.push("");
  return s.join("\n");
}

export interface ModifyOptions {
  cfg: PipelineConfig;
  client: Anthropic;
  /** the exported page to change — a stock CMF page, or the customer's own */
  sourcePath: string;
  changeRequest: string;
  pageName: string;
  uiType?: string;
  objectId: string;
  outDir: string;
  /** graded against this, when the caller has a descriptor for the result */
  spec?: EffectiveSpec;
  excludePage?: string;
  log?: (line: string) => void;
}

export interface ModifyRunResult {
  changes: Change[];
  diff: Diff;
  /** areas that moved without an operation claiming them — should always be empty */
  unexpected: string[];
  artifactPath: string;
  report: Report;
  usage: CallResult["usage"][];
  gapReport: string;
  /** the modified page against Athena's GUI-test selectors */
  gui?: GuiReport;
  /**
   * `$(UNKNOWN_*)` captions this edit introduced.
   *
   * Extracted by comparing the two files rather than left to the summary. A
   * revision once emitted `$(UNKNOWN_SN)` and reported that it had written
   * plain text and that plain text was fine - two false claims in one sentence,
   * either of which would have sent the page to import with a message still
   * uncreated.
   */
  unknowns: string[];
}

function failureFeedback(results: readonly Result[]): string {
  const fails = results.filter((r) => r.level === "FAIL");
  const lines = fails.map(
    (r) => `- **${r.name}**${r.detail ? ` — ${r.detail}` : ""}`,
  );
  return [
    "Your previous attempt did not pass validation. These checks FAILED:",
    "",
    ...lines,
    "",
    "Fix exactly these. Do not change anything that already passed, and do not",
    "start guessing at values to make a check go green — if something is genuinely",
    "unknown, keep it marked UNKNOWN and record it in the gap report.",
    "",
    "Return the same two fenced blocks as before.",
  ].join("\n");
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const { cfg, client, outDir, objectId } = opts;
  const log = opts.log ?? noop;
  const usage: CallResult["usage"][] = [];

  /*
   * The client's artifact-name prefix is applied HERE, by code (T-25).
   *
   * The page name is a placeholder the assembler substitutes; the model never
   * writes it. So a missing prefix is a FAIL the model **cannot** fix, and the
   * retry loop would spend every remaining attempt regenerating a page body that
   * was never the problem — measured: 3 attempts, same FAIL each time.
   *
   * Applied only on the CREATE path. `runModify` deliberately does not do this:
   * renaming an artifact that already exists in the target system would break
   * every reference to it.
   */
  const pageName = opts.pageName;
  const named = applyNamePrefix(loadConventions(), pageName);
  /**
   * The prefix names the ARTIFACT. It must not name the LOOKUP.
   *
   * `pageName` selects which page of the descriptor to build, and the descriptor
   * says whatever the story said — so prefixing it first made the lookup fail
   * with "the descriptor has no page named CustomOrderConsole". Two distinct
   * uses of one variable; only the emitted name takes the prefix.
   */
  const artifactName = named.name;
  if (named.changed) {
    log(`  artifact name: "${pageName}" -> "${artifactName}" ` +
        `(the ${named.prefix} prefix is a stated client requirement, applied by code — ` +
        `the model cannot set this field, so a missing prefix is an unfixable FAIL)`);
  }

  mkdirSync(outDir, { recursive: true });

  // ---------------------------------------------------------------- package
  const pkg: PromptPackage = buildPackage(cfg, {
    // exclude the page we are BUILDING from the samples. Matched on the emitted
    // name, because that is what could collide with a delivered sample.
    excludePage: opts.includeTargetSample ? undefined : artifactName,
    withhold: opts.withholdAssets,
    onExclude: (f) => log(`  excluded from samples: ${f} (it is the page being built)`),
  });
  log("  prompt package assembled:");
  log(manifestTable(pkg));

  // ---------------------------------------------------------------- descriptor
  let descriptor = opts.descriptor;
  if (!descriptor) {
    if (!opts.story) throw new Error("run() needs either a story or a descriptor");
    checkStorySize(cfg, opts.story);
    descriptor = await extractDescriptor(cfg, client, opts.story, log);
    writeFileSync(
      join(outDir, "descriptor.json"),
      JSON.stringify(descriptor, null, 2), "utf-8",
    );
    log(`  descriptor written: ${descriptor.pages.length} page(s)`);
  }

  const page = pageFor(descriptor, pageName);
  if (!page) {
    throw new Error(
      `the descriptor has no page named "${pageName}" ` +
      `(has: ${descriptor.pages.map((p) => p.name).join(", ")})`,
    );
  }
  const spec = effectiveSpec(descriptor, page);
  if (page.queries !== undefined && page.queries.length !== (descriptor.queries ?? []).length) {
    log(`  queries for this page: ${page.queries.length ? page.queries.join(", ") : "(none)"}` +
        `  [story declares ${(descriptor.queries ?? []).length}]`);
  }

  // ---------------------------------------------------------------- generate loop
  const pageUid = `UIPage_${objectId}`;
  if (!opts.pageTitle && !cfg.page.titleFollowsName) {
    throw new Error(
      "config sets page.titleFollowsName=false, so definition.title must be given " +
      "explicitly (--title). It matches the page name in only 40 of 66 live pages, " +
      "so defaulting to the name is a convention, not a rule.",
    );
  }
  const shellValues = {
    pageUid,
    pageTitle: opts.pageTitle ?? artifactName,
    layoutColumns: opts.layoutColumns ?? cfg.page.layoutColumns,
    layoutWidth: opts.layoutWidth ?? cfg.page.layoutWidth,
    // Stated by the story, or absent. `fillShell` leaves the shell's own default
    // alone when it is absent, so a run that never mentions refresh is unchanged.
    ...(page.autoRefresh !== undefined ? { autoRefresh: page.autoRefresh } : {}),
    ...(page.autoRefreshInterval !== undefined
      ? { autoRefreshInterval: page.autoRefreshInterval } : {}),
  };
  log(`  page values: title="${shellValues.pageTitle}" columns=${shellValues.layoutColumns} ` +
      `width=${shellValues.layoutWidth} uid=${pageUid}`);
  if (page.autoRefresh !== undefined) {
    log(`  page refresh: autoRefresh=${page.autoRefresh}` +
        (page.autoRefresh && page.autoRefreshInterval
          ? ` every ${page.autoRefreshInterval}` : ""));
  }
  // The settings shell can vary by UIType. A Wizard page carries seven extra page-level
  // properties (wizardComments, wizardError, wizardHeader*, wizardActionLabel) that a
  // plain Page does not — measured on 14 live wizard pages. The mapping is CONFIG:
  // an `assets` key of the form "skeletonSettings.<UIType>" overrides the default, so
  // adding a Step or Cluster variant later needs no code change.
  const uiType = page.uiType ?? "Page";
  const shellKey = cfg.assets[`skeletonSettings.${uiType}`] !== undefined
    ? `skeletonSettings.${uiType}`
    : "skeletonSettings";
  if (shellKey !== "skeletonSettings") log(`  settings shell: ${shellKey}`);
  const shell = fillShell(readAsset(cfg, shellKey), shellValues);
  const skeleton = readAsset(cfg, "skeleton");
  const dictPath = assetPath(cfg, "dictionary");
  const artifactPath = join(outDir, "GENERATED.xml");

  // A-53. Where Athena's own test suite constrains values on this page, those
  // values are given, not chosen — see selectorBrief() for why this is supplied
  // as per-page data rather than stated as a naming convention.
  const brief = opts.guiBrief === false
    ? (log("  GUI-test constraints: WITHHELD (--no-gui-brief) — this is the A/B control"), "")
    : guiBrief(cfg, artifactName, log);
  const actions = actionBrief(cfg, log);

  /*
   * The dictionary lookups, done in code. Same shape as the GUI brief above:
   * per-page data in the USER message, never a convention in the cached prefix.
   * See column-brief.ts for why this is transcription rather than inference.
   */
  /*
   * OFF BY DEFAULT, and the measurement is why.
   *
   * The idea was sound: do the dictionary lookups in code so the model spends
   * its thinking on judgement instead of search. Measured over 3 runs each way
   * on US-455386 _New, it made things WORSE - 6% more wall clock, 16% more time
   * to the first token, 3% more output - with accuracy unchanged at 24/5 against
   * Athena's page. Reading a 735-token table apparently costs more than finding
   * 15 rows in a dictionary that is already in the cached prefix.
   *
   * Kept, opt-in, because the result may not hold for a story with far more
   * columns, where the search really could dominate. Re-measure before trusting
   * it; do not switch it on because it sounds like it should help.
   */
  const paths = opts.columnBrief !== true
    ? ""
    : (() => {
        const b = columnBrief(dictPath, page);
        if (b) {
          // Count the table rows without splitting on a newline literal.
          const rows = (b.match(/^\| (?!Term)/gm) ?? []).length;
          log(`  data paths resolved for the model (${rows} term(s))`);
        }
        return b;
      })();

  const baseUser = [
    OUTPUT_CONTRACT,
    "",
    "## Layout geometry (use these numbers, not the skeleton's placeholders)",
    "",
    `- layout columns: **${shellValues.layoutColumns}** — every widget must fit inside this`,
    `- layout width: ${shellValues.layoutWidth} px`,
    ...(brief ? ["", brief] : []),
    ...(actions ? ["", actions] : []),
    ...(paths ? ["", paths] : []),
    "",
    "## The page to build",
    "",
    "```json",
    JSON.stringify({ ...descriptor, pages: [page] }, null, 2),
    "```",
  ].join("\n");

  let report: Report | undefined;
  let templates: TemplateOutcome | undefined;
  // explicit flag wins; otherwise discovered once, on the first attempt
  let templateSource: string | undefined = opts.templatesFrom;
  let attempt = 0;
  let feedback = "";

  while (attempt < cfg.loop.maxAttempts) {
    attempt += 1;
    log(`\n  attempt ${attempt}/${cfg.loop.maxAttempts} — generating...`);

    /*
     * A STALLED STREAM IS RETRIED, not thrown.
     *
     * `call()` aborts a stream that goes `model.streamIdleSeconds` without a
     * character and reports it as `StreamStalledError`. It is retried here for
     * the same reason a parse failure is: the request was well formed and the
     * same call usually succeeds — what failed is the stream, not the page
     * being asked for. Without this the abort would END the run, which is a
     * worse outcome than the hang it replaced.
     *
     * `feedback` is deliberately NOT touched. Nothing was produced to
     * criticise, so the next attempt asks exactly what this one asked.
     */
    let res;
    try {
      res = await call({
        client,
        model: cfg.model,
        effort: cfg.model.generateEffort,
        system: pkg.blocks,
        user: feedback ? `${baseUser}\n\n---\n\n${feedback}` : baseUser,
        onProgress: (n) => {
          if (n % 4000 < 60) process.stderr.write(`\r    streaming… ${n} chars`);
        },
        // `attempt` rides along so a regeneration replaces the previous file on
        // screen rather than appending to it — otherwise attempt 2 would read as
        // a continuation of attempt 1's abandoned output.
        ...(opts.onCode ? { onText: (t: string) => opts.onCode!(t, attempt) } : {}),
      });
    } catch (e) {
      process.stderr.write("\r".padEnd(40) + "\r");
      if (e instanceof StreamStalledError && attempt < cfg.loop.maxAttempts) {
        log(`  ${e.message} — starting it again`);
        continue;
      }
      throw e;
    }
    process.stderr.write("\r".padEnd(40) + "\r");
    usage.push(res.usage);
    log(`  <- ${usageLine(res)}`);

    let produced;
    try {
      produced = parseGeneration(res.text);
    } catch (e) {
      if (e instanceof ParseError && attempt < cfg.loop.maxAttempts) {
        log(`  !! ${e.message} — retrying`);
        feedback = `Your previous response could not be parsed: ${e.message}`;
        continue;
      }
      writeFileSync(join(outDir, "RAW_RESPONSE.txt"), res.text, "utf-8");
      throw e;
    }

    // ------------------------------------------------------------ our exact steps
    let merged = mergeSettings(shell, produced.settings);

    /* Page properties are minted and their links rewritten BEFORE $id numbering
       and escaping, so the numbering sees the finished object — the same
       ordering the template port already relies on. */
    const props = applyPageProperties(merged, pageUid);
    if (props.declared.length) {
      log(`  page properties: ${props.declared.length} declared (${props.declared.join(", ")})` +
          `, ${props.wired} link endpoint(s) wired`);
    }

    // Port evidenced templates BEFORE assembly, so $id numbering and escaping
    // see the finished object. Never authored — copied from a named artifact.
    /*
     * The template SOURCE, explicit or discovered.
     *
     * `--templates-from` names it. The chat path cannot pass a flag, so it never
     * did — every web run produced 0 templated columns where the CLI produced 4,
     * and the tool's own users got the worse of its two outputs.
     *
     * Discovery is deliberately narrow: a delivered page with the SAME NAME as
     * the one being built. Not a similar page and not a default, because
     * templates vary per page (A-49) — `Name` carries two different ones across
     * Athena's own artifacts. A page of the same name is the same page, so its
     * markup is evidence for these columns rather than a guess.
     */
    if (!templateSource) {
      const hit = findDeliveredPage(querySourceRoots(cfg), artifactName);
      if (hit) {
        templateSource = hit.path;
        log(`  templates: found a delivered "${artifactName}" — porting from ${basename(hit.path)}`);
      }
    }

    if (templateSource) {
      const lib = loadTemplateLibrary(templateSource);
      const ported = applyTemplates(merged, lib);
      merged = ported.settings as typeof merged;
      templates = ported.outcome;
      for (const line of formatTemplateOutcome(ported.outcome, templateSource)) log(line);
    }

    // Boilerplate every real action button carries, and the input contract its
    // action expects. Measured invariants, so our code writes them — the model
    // keeps the judgement calls.
    {
      const done = completeActionButtons(merged, loadConventions(), actionContracts(cfg, log));
      merged = done.settings as typeof merged;
      for (const line of formatButtonCompletion(done.completion)) log(line);
    }

    /* A data source that fills a widget must fetch when the page opens. Decided
       here rather than by the model because the evidence is a LINK — whether
       anything reads this source is not visible from the source itself. */
    {
      const done = completeDataSources(merged);
      merged = done.settings as typeof merged;
      for (const line of formatDataSourceCompletion(done.completion)) log(line);
    }

    const built = assemble({
      skeleton, settings: merged, pageName: artifactName,
      uiType: page.uiType ?? "Page", objectId,
      assignIds: cfg.postProcess.assignIds,
    });

    const ids = auditIds(built.settings);
    log(`  assembled: ${built.xml.length} chars, ${ids.markers}/${ids.objects} $id markers`);

    writeFileSync(artifactPath, built.xml, "utf-8");
    writeFileSync(join(outDir, "GAP_REPORT.md"), produced.gapReport, "utf-8");

    // ------------------------------------------------------------ validate
    report = validate(artifactPath, dictPath, spec);

    /*
     * DOES THE PAGE AGREE WITH ITSELF? (T-48)
     *
     * Folded into the LOOP rather than reported after it, which is the whole
     * difference between a tripwire and a fix: a link naming a button port that
     * does not exist is something the model can correct when told, and
     * `checkWiring`'s inability to do that is recorded as its known limitation.
     *
     * Kept out of `validate()` on purpose. That function is mirrored line for
     * line by `validate.py` and diffed by `test/oracle.ts`, so a check added
     * there costs two implementations and breaks parity until both exist.
     * Porting these is A-73; until then they run here, where they still reach
     * the model.
     */
    for (const f of checkPageIntegrity(settingsOfArtifact(artifactPath))) {
      report.results.push(f);
      report.counts[f.level] = (report.counts[f.level] ?? 0) + 1;
      if (f.level === "FAIL") report.ok = false;
      if (f.level !== "PASS") log(`  [${f.level}] ${f.name} - ${f.detail}`);
    }

    const { PASS, WARN, FAIL } = report.counts;
    log(`  validated: PASS ${PASS}  WARN ${WARN}  FAIL ${FAIL}`);

    if (report.ok) break;
    if (attempt >= cfg.loop.maxAttempts) break;

    /* WORDING IS LOAD-BEARING HERE. This is the last line an engineer sees
       before the artifact on screen is replaced by a freshly written one, and
       "feeding failures back" made a routine second pass read as a breakdown.
       It now says what happens next rather than what went wrong — the counts on
       the line above already carry that, and carry it more precisely. */
    log("  refining the page against the validation findings...");
    feedback = failureFeedback(report.results);
  }

  if (!report) throw new Error("the generation loop produced no report");

  // ---------------------------------------------------------------- query artifacts
  /* The page is assembled by now, so a query can be built to serve the grid it
     actually fills rather than to the descriptor's idea of it. That ordering is
     the whole reason the two can be reconciled at all. */
  const queries = writeQueries(cfg, descriptor, spec, outDir, objectId, log,
    demandOnQueries(settingsOfArtifact(artifactPath)),
    cfg.assets["entityTypes"]
      ? parseEntityProperties(readFileSync(assetPath(cfg, "entityTypes"), "utf-8"))
      : new Map());

  /*
   * WHAT WE CHANGED IN ARTIFACTS THEY ALREADY OWN.
   *
   * Written only when there is something to say. A unit that overwrites a live
   * query must carry that fact in the package rather than only in a run log the
   * recipient never sees — they import the zip, not the console.
   */
  {
    const edited = queries.filter((q) => q.transcribedFrom && q.changes?.length);
    const gaps = queries.filter((q) => q.unevidenced?.length);
    if (edited.length || gaps.length) {
      const lines: string[] = [
        `# CHANGES TO QUERIES YOU ALREADY SHIP — ${descriptor.userStory}`,
        "",
        "The queries in this package are **your own delivered exports**, edited. They",
        "are not regenerated: every byte this page did not need is the byte your",
        "system already runs, including the `__cmf_html_*` field aliases that make",
        "your reference columns render as names rather than ids.",
        "",
        "Importing this unit **replaces** those objects. Each edit below states what",
        "changed and what breaks without it.",
        "",
      ];
      for (const q of edited) {
        lines.push(`## ${q.name}`, "");
        /* The file name, never our path. The recipient is being told WHICH of
           their exports this came from, and our directory layout is not their
           business — nor is it stable. */
        lines.push(`Source: your \`${basename(q.transcribedFrom!)}\``, "");
        for (const c of q.changes ?? []) lines.push(`- **${c.kind}** — ${c.detail}`);
        lines.push("");
      }
      if (gaps.length) {
        lines.push("## Still open", "");
        for (const q of gaps) {
          lines.push(`- \`${q.name}\`: a column reads ` +
            `${(q.unevidenced ?? []).map((u) => `\`${u}\``).join(", ")}, which needs a join ` +
            `no artifact available here states. Those cells will be blank. Name the ` +
            `join and it can be added — it has not been guessed.`);
        }
        lines.push("");
      }
      writeFileSync(join(outDir, "QUERY_CHANGES.md"), lines.join("\n"), "utf-8");
      log(`  query changes: QUERY_CHANGES.md — ${edited.length} of your quer(ies) edited, ` +
          `${gaps.length} open gap(s)`);
    }
  }

  // ---------------------------------------------------------------- deployment unit
  const masterData = writeMasterData(cfg, descriptor, page, outDir, artifactPath, queries, log);

  /*
   * SHOW EVERY FILE THE RUN PRODUCED, not just the one the model wrote.
   *
   * The page definition streams while it is being generated. The queries and
   * the master-data unit are assembled by OUR code from the descriptor, so
   * they never stream — and until this they surfaced only as filenames in the
   * deployment-unit list. Two thirds of the output was named but never shown.
   *
   * Read back from disk rather than from the in-memory value, deliberately:
   * what is displayed is then the bytes that were actually written, which is
   * what the engineer will import.
   */
  if (opts.onFile) {
    try {
      opts.onFile(`${artifactName}.xml`, readFileSync(artifactPath, "utf-8"));
    } catch { /* the card is a courtesy; never fail a run for it */ }
    for (const q of queries) {
      if (!q.built || !q.path) continue;
      try { opts.onFile(`${q.name}.xml`, readFileSync(q.path, "utf-8")); } catch { /* as above */ }
    }
    if (masterData) {
      try {
        opts.onFile(masterData.fileName, readFileSync(masterData.path, "utf-8"));
      } catch { /* as above */ }
    }
  }

  /*
   * Enum columns, checked against CMF's own schema (F-154). Separate from the
   * page validator for the same reason as the GUI check: `checks.ts` is a
   * literal port of `validate.py`, and a rule added there costs two
   * implementations.
   */
  const relGraph = cfg.assets["entityRelations"]
    ? loadRelations(assetPath(cfg, "entityRelations"))
    : null;
  for (const f of checkEnumColumns(settingsOfArtifact(artifactPath) as never, relGraph)) {
    log(`  [${f.level}] ${f.name} - ${f.detail}`);
  }


  /*
   * DOES THE PAGE BIND WHAT THE QUERIES DECLARE?
   *
   * Run here because it is the first point where BOTH the page and its queries
   * exist — the page is assembled inside the regeneration loop above, the
   * queries are written after it. That ordering is also this check's limitation:
   * it cannot feed the loop, so it reports rather than triggers a retry. It is a
   * tripwire for a class of fault that shipped silently once (see
   * `wiring-checks.ts`), not the fix for it.
   */
  {
    const pageSettings = settingsOfArtifact(artifactPath);
    const declared = new Set<string>();
    for (const q of queries) for (const p of q.inputPorts ?? []) declared.add(p);

    const wiring = checkWiring({
      links: (pageSettings.links ?? []).map((l) => ({
        targetId: l.target?.id ?? null, input: l.input ?? null,
      })),
      /* QueryDataSource ONLY. A ServiceCallDataSource's ports are the service
         contract's arguments - on Load Materials to Feeder, `Resource` and
         `Materials` for AttachConsumablesToResource - and are not query
         parameters at all. */
      queryDataSourceIds: new Set((pageSettings.dataSources ?? [])
        .filter((d) => d.name === "QueryDataSource")
        .map((d) => d.id).filter((x): x is string => typeof x === "string")),
      declaredParameters: declared,
    });

    /*
     * AND THE OTHER DIRECTION, WHICH IS THE ONE THAT SHIPPED EMPTY.
     *
     * A mandatory filter whose parameter nothing supplies compares against NULL
     * and returns no rows. Only the sources that FILL a widget are considered,
     * and only their mandatory filters — see `checkMandatoryBindings`.
     */
    /* `PageSettings` models only the fields the assembler writes; this check
       reads two it does not (`links[].output`, `dataSources[].settings`), so it
       widens deliberately and in one place rather than loosening the type. */
    const raw = pageSettings as {
      links?: Array<{ output?: unknown; input?: unknown; source?: { id?: unknown } }>;
      dataSources?: Array<{ id?: unknown; name?: unknown; settings?: Record<string, unknown> }>;
    };

    const filled = new Set<string>();
    for (const l of raw.links ?? []) {
      if (basePort(String(l.output ?? "")) === "dataChange"
        && basePort(String(l.input ?? "")) === "data" && typeof l.source?.id === "string") {
        filled.add(l.source.id);
      }
    }
    const byQueryName = new Map(queries.filter((q) => q.built).map((q) => [q.name, q]));
    const pageDemand = demandOnQueries(pageSettings);
    const gridSources: Array<MandatoryBindingInput["sources"][number]> = [];
    for (const d of raw.dataSources ?? []) {
      if (d.name !== "QueryDataSource" || typeof d.id !== "string") continue;
      if (!filled.has(d.id)) continue;
      const qName = (d.settings?.["query"] as { Name?: unknown } | undefined)?.Name;
      const q = typeof qName === "string" ? byQueryName.get(qName) : undefined;
      if (!q?.mandatoryPorts?.length) continue;
      gridSources.push({
        id: d.id,
        name: String(d.settings?.["name"] ?? d.id),
        query: q.name,
        mandatoryParameters: q.mandatoryPorts,
        /* Read from the assembled page, not from the query: whether a port has
           a value on load is a fact about what FEEDS it. */
        emptyOnLoad: [...(pageDemand.get(q.name)?.emptyOnLoadPorts ?? [])],
      });
    }

    /*
     * AND WHETHER EACH GRID'S COLUMNS ARE IN THE ROWS IT WILL RECEIVE.
     *
     * Walked link-first, as the fetchOnLoad rule is: `dataChange -> data` names
     * the widget a source fills, which is the only reliable statement of which
     * query a grid reads.
     */
    const widgetById = new Map<string, Record<string, unknown>>();
    for (const w of (pageSettings as { widgets?: Array<Record<string, unknown>> }).widgets ?? []) {
      if (typeof w["id"] === "string") widgetById.set(w["id"], w);
    }
    const gridsToCheck: Array<ColumnCoverageInput["grids"][number]> = [];
    for (const l of raw.links ?? []) {
      if (basePort(String(l.output ?? "")) !== "dataChange"
        || basePort(String(l.input ?? "")) !== "data") continue;
      const from = typeof l.source?.id === "string" ? l.source.id : undefined;
      const to = typeof (l as { target?: { id?: unknown } }).target?.id === "string"
        ? String((l as { target: { id: string } }).target.id) : undefined;
      if (!from || !to) continue;

      const ds = (raw.dataSources ?? []).find((d) => d.id === from);
      const qName = (ds?.settings?.["query"] as { Name?: unknown } | undefined)?.Name;
      const q = typeof qName === "string" ? byQueryName.get(qName) : undefined;
      if (!q?.fields?.length) continue;

      const w = widgetBehind(widgetById.get(to)) as Record<string, unknown> | undefined;
      const cols = ((w?.["settings"] as { columns?: Array<{ path?: unknown }> } | undefined)?.columns ?? [])
        .map((c) => c.path).filter((x): x is string => typeof x === "string" && x.length > 0);
      if (cols.length === 0) continue;

      gridsToCheck.push({
        widget: String((w?.["settings"] as { name?: unknown } | undefined)?.name ?? to),
        query: q.name, columnPaths: cols, selected: q.fields,
        unevidenced: q.unevidenced ?? [],
      });
    }

    /* A reference column renders a NAME only when the query materialises the
       joined pair. Their Step column proves the mechanism; ours would show a
       raw id the first time we build a query for a page with one. */
    const refGrids = gridsToCheck.map((g) => ({
      widget: g.widget, query: g.query, columnPaths: g.columnPaths,
      aliases: byQueryName.get(g.query)?.aliases ?? [],
    })).filter((g) => g.aliases.length > 0);

    for (const f of [...wiring, ...checkReferenceColumns({ grids: refGrids }), ...checkMandatoryBindings({
      links: (pageSettings.links ?? []).map((l) => ({
        targetId: l.target?.id ?? null,
        input: l.input ? basePort(l.input) : null,
      })),
      sources: gridSources,
    }), ...checkColumnCoverage({ grids: gridsToCheck })]) {
      log(`  [${f.level}] ${f.name}${f.detail ? " - " + f.detail : ""}`);
      report.results.push(f);
      report.counts[f.level] = (report.counts[f.level] ?? 0) + 1;
    }
    /* `ok` is recomputed rather than left alone: a FAIL found here must show in
       the badge the engineer reads, or the check is decoration. */
    if (report.counts.FAIL > 0) report.ok = false;
  }

  // ------------------------------------------------- their acceptance criteria
  const gui = checkGui(cfg, artifactPath, artifactName, masterData, log);
  if (gui) writeFileSync(join(outDir, "GUI_REPORT.md"),
    formatGuiFile(gui, artifactName, clientName(loadConventions())), "utf-8");

  writeFileSync(
    join(outDir, "REPORT.txt"),
    format(report, artifactPath, dictPath, "<descriptor>", artifactName),
    "utf-8",
  );

  return { descriptor, report, attempts: attempt, artifactPath, usage, queries,
           masterData, templates, gui };
}

/**
 * The GUI-test constraints for this page, as a prompt section (A-53).
 *
 * Silent when no scope covers the page, which is the common case — most pages
 * have no test, and an empty section would be noise in the prompt.
 */
/**
 * The client's registered custom action ids, as data for the model (T-31).
 *
 * Same shape as guiBrief: supplied per run, never stated as a convention. Silent
 * when the asset is absent, so removing `assets.actionIds` from config restores
 * the previous behaviour exactly.
 */
/**
 * The transcribed input contracts, or nothing when the asset is not configured.
 *
 * Optional in exactly the way `actionBrief` is: remove `assets.actionContracts`
 * from config and the filler declines rather than the run failing. An absent
 * asset must never be the reason a page does not build.
 */
function actionContracts(cfg: PipelineConfig, log: (l: string) => void): ContractLibrary | undefined {
  if (cfg.assets["actionContracts"] === undefined) return undefined;
  try {
    return loadActionContracts(assetPath(cfg, "actionContracts"));
  } catch (e) {
    log(`  action input contracts: not supplied — ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

function actionBrief(cfg: PipelineConfig, log: (l: string) => void): string {
  if (cfg.assets["actionIds"] === undefined) return "";
  try {
    const lib = loadActionLibrary(assetPath(cfg, "actionIds"));
    const brief = actionIdBrief(lib, clientName(loadConventions()));
    if (brief) {
      log(`  registered action ids supplied to the model ` +
          `(${lib.filter((a) => a.actionId.startsWith("Custom")).length} custom action(s))`);
    }
    return brief;
  } catch (e) {
    log(`  registered action ids: not supplied — ${e instanceof Error ? e.message : String(e)}`);
    return "";
  }
}

function guiBrief(cfg: PipelineConfig, pageName: string, log: (l: string) => void): string {
  if (cfg.assets["guiSelectors"] === undefined) return "";
  try {
    const brief = selectorBrief(loadSelectorLibrary(assetPath(cfg, "guiSelectors")),
                                pageName, clientName(loadConventions()));
    if (brief) {
      log(`  GUI-test constraints supplied to the model for ${pageName} ` +
          `(${brief.split("\n").filter((l) => l.startsWith("- ")).length} value(s))`);
    }
    return brief;
  } catch (e) {
    log(`  GUI-test constraints: not supplied — ${e instanceof Error ? e.message : String(e)}`);
    return "";
  }
}

/**
 * Grade the page against Athena's own GUI-test selectors (A-54).
 *
 * Their Selenium suite is the strongest statement of "correct" we hold, because
 * it executes — where a selector constrains a value, that value is not a matter
 * of interpretation. Checked here on every run so a page that is right on every
 * column and path cannot quietly fail their suite on a widget name.
 *
 * Reported ALONGSIDE the page validator, never merged into it: `checks.ts` is a
 * literal port of `validate.py` and the oracle gate proves the two agree, so a
 * TypeScript-only check inside it would break the parity it exists to hold.
 *
 * A missing asset degrades to a note rather than an exception. The gate in
 * `test/gui.test.ts` is what guarantees the assets exist and are current; a
 * generation run failing outright because an optional asset was absent would be
 * a worse trade than saying so and carrying on.
 */
function checkGui(
  cfg: PipelineConfig, artifactPath: string, pageName: string,
  masterData: MasterDataOutcome | undefined, log: (l: string) => void,
): GuiReport | undefined {
  if (cfg.assets["guiSelectors"] === undefined) {
    log("  GUI-test selectors: no guiSelectors asset configured — not checked");
    return undefined;
  }
  try {
    const library = loadSelectorLibrary(assetPath(cfg, "guiSelectors"));
    const platform = cfg.assets["messageText"] !== undefined
      ? loadMessageText(assetPath(cfg, "messageText")).text
      : {};
    // Labels this run INTRODUCES resolve from the master data it just wrote;
    // everything else from the platform table. Keeping the two apart is the
    // lesson of defect 20.
    const declared = masterData ? declaredTextIn(masterData.document) : {};

    const report = validateSelectors({
      settings: parseSettings(readFileSync(artifactPath, "utf-8")),
      pageName, library, platform, declared,
    });
    for (const line of formatGuiReport(report)) log(line);
    return report;
  } catch (e) {
    log(`  GUI-test selectors: not checked — ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** The per-selector detail, written beside the artifact. */
function formatGuiFile(report: GuiReport, pageName: string, client: string): string {
  const s: string[] = [];
  s.push(`# GUI-test selectors — ${pageName}`);
  s.push("");
  s.push(`${client}'s own Selenium suite drives this page. Every line below is a selector`);
  s.push("from their test files checked against the artifact this run produced.");
  s.push("");
  if (!report.scopes.length) {
    s.push("**No test scope names this page**, so there is nothing to check. That is the");
    s.push("common case: most pages have no GUI test.");
    s.push("");
    return s.join("\n");
  }
  s.push(`Scopes: ${report.scopes.join(", ")}`);
  s.push("");
  s.push(`| | |`);
  s.push(`|---|---|`);
  s.push(`| PASS | ${report.counts.PASS} |`);
  s.push(`| WARN | ${report.counts.WARN} |`);
  s.push(`| FAIL | ${report.counts.FAIL} |`);
  s.push("");
  s.push("| Level | Selector | Detail |");
  s.push("|---|---|---|");
  for (const r of report.results) s.push(`| ${r.level} | ${r.name} | ${r.detail} |`);
  s.push("");
  s.push("A **widget** or **button** selector FAILs when unsatisfied: those values exist");
  s.push("only where the page puts them. A **label** or **title** selector WARNs, because");
  s.push("it asserts rendered text that can come from stock CMF chrome the page never");
  s.push(`declares — ${client}'s own delivered page does not satisfy \`[title='Comments']\`,`);
  s.push("which targets the history view. Failing on one would reject their own file.");
  s.push("");
  return s.join("\n");
}

/**
 * Write the master-data deployment unit for everything this run produced.
 *
 * Without it the artifacts are not deployable: the page has no menu entry, its new
 * labels do not exist, and nothing imports the XML (F-98). Skipped silently only
 * when no `masterData` config is present, so an older configuration still runs.
 */
function writeMasterData(
  cfg: PipelineConfig, descriptor: SpecDescriptor, page: PageSpecType,
  outDir: string, artifactPath: string, queries: readonly QueryOutcome[],
  log: (l: string) => void,
): MasterDataOutcome | undefined {
  if (!cfg.masterData) {
    log("  master data: no masterData config — skipping the deployment unit");
    return undefined;
  }
  const knownPath = cfg.assets["knownMessages"];
  if (knownPath === undefined) {
    log("  master data: no knownMessages asset — cannot tell new labels from existing ones, skipping");
    return undefined;
  }

  try {
    const known = loadKnownMessages(assetPath(cfg, "knownMessages"));

    // Message names come from the artifacts themselves, not from the descriptor:
    // the artifact is what will actually be deployed, so it is the only honest
    // source for which labels the screen really references.
    const pageXml = readFileSync(artifactPath, "utf-8");
    const names = new Set(messageNamesIn(pageXml));
    const artifacts: MasterDataArtifact[] = [];
    for (const q of queries) {
      if (!q.built || !q.path) continue;
      for (const n of messageNamesIn(readFileSync(q.path, "utf-8"))) names.add(n);
      artifacts.push({ file: `${q.name}.xml`, kind: "query" });
    }
    const kind: MasterDataArtifact["kind"] =
      page.uiType === "Wizard" ? "wizard" : page.uiType === "Step" ? "step" : "page";
    artifacts.push({ file: `${page.name}.xml`, kind });

    const built = buildMasterData({
      storyId: descriptor.userStory,
      featureName: page.name.replace(/^Custom/, ""),
      artifacts,
      messageNames: [...names],
      knownMessages: known,
      config: {
        cultures: cfg.masterData.cultures,
        primaryCulture: cfg.masterData.primaryCulture,
        featurePrefix: cfg.masterData.featurePrefix,
        messageType: cfg.masterData.messageType,
        loadOrder: cfg.masterData.loadOrder as MasterDataConfig["loadOrder"],
      },
    });

    const file = join(outDir, built.fileName);
    // Never silent: the id came from the model and we changed it to make a path.
    if (built.renamed) log(`    ! ${built.renamed}`);
    writeFileSync(file, formatMasterData(built.document), "utf-8");
    log(`  master data: ${built.fileName}  ` +
        `${built.declared.length} label(s) declared, ${built.inherited.length} reused, ` +
        `${artifacts.length} artifact(s) to import`);
    if (built.derivedText.length) {
      log(`    ! ${built.derivedText.length} display text(s) DERIVED from the message name — confirm before shipping:`);
      for (const d of built.derivedText) log(`        ${d.name} -> "${d.text}"`);
    }
    return { path: file, ...built };
  } catch (e) {
    log(`  master data: not written — ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/**
 * Write a Query export for every query THIS PAGE consumes that the descriptor also
 * defines structurally.
 *
 * Two lists, deliberately: `spec.queries` are the names the page consumes;
 * `descriptor.queryDefinitions` are the ones we know how to build. A name with no
 * definition is **not an error** — it is a gap, reported and carried on from, in
 * exactly the way an unknown data path is. The alternative would be inventing a
 * query body, which is the worst outcome available: it would import cleanly and
 * return the wrong rows.
 */
/** The Settings JSON out of an artifact on disk, for checks that run after assembly. */
interface PageSettings {
  widgets?: unknown[];
  links?: Array<{ input?: string; target?: { id?: string } }>;
  dataSources?: Array<{ id?: string; name?: string }>;
}

function settingsOfArtifact(xmlPath: string): PageSettings {
  try {
    const raw = rawSettings(readFileSync(xmlPath, "utf-8"));
    if (raw === null) return {};
    return JSON.parse(raw
      .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#xD;/g, "\r").replace(/&#xA;/g, "\n").replace(/&#x9;/g, "\t")
      .replace(/&amp;/g, "&")) as PageSettings;
  } catch { return {}; }
}

/**
 * What the assembled page ASKS OF each query: the columns it will render from
 * the rows, and the parameters it actually supplies.
 *
 * Read from the artifact rather than the descriptor, for the reason this file
 * gives everywhere else: the artifact is what will be imported.
 */
export interface QueryDemand {
  columnPaths: string[];
  boundPorts: Set<string>;
  /**
   * Ports whose only feeder is a control that is empty when the page opens.
   *
   * A Form or Filter field emits `field<Label>Change`, and until somebody types
   * there is nothing to emit — so a MANDATORY filter on such a port empties its
   * grid on load even though the link exists. A grid's `selectedChange` is
   * excluded on purpose: a detail grid is meant to be empty until a row is
   * picked.
   */
  emptyOnLoadPorts: Set<string>;
}

export function demandOnQueries(page: PageSettings): Map<string, QueryDemand> {
  const raw = page as {
    links?: Array<{ output?: unknown; input?: unknown;
                    source?: { id?: unknown }; target?: { id?: unknown } }>;
    widgets?: Array<Record<string, unknown>>;
    dataSources?: Array<{ id?: unknown; settings?: Record<string, unknown> }>;
  };

  const queryOf = new Map<string, string>();   // data-source id -> query name
  for (const d of raw.dataSources ?? []) {
    const n = (d.settings?.["query"] as { Name?: unknown } | undefined)?.Name;
    if (typeof d.id === "string" && typeof n === "string" && n && n !== "UNKNOWN") {
      queryOf.set(d.id, n);
    }
  }
  const widgetById = new Map<string, Record<string, unknown>>();
  for (const w of raw.widgets ?? []) {
    if (typeof w["id"] === "string") widgetById.set(w["id"], w);
  }

  const out = new Map<string, QueryDemand>();
  const demandFor = (q: string): QueryDemand => {
    if (!out.has(q)) {
      out.set(q, { columnPaths: [], boundPorts: new Set(), emptyOnLoadPorts: new Set() });
    }
    return out.get(q)!;
  };
  /* Every output that feeds a given (query, port), so a port fed by BOTH a
     filter field and something with a value is not mistaken for empty. */
  const feeders = new Map<string, Set<string>>();

  for (const l of raw.links ?? []) {
    const from = typeof l.source?.id === "string" ? l.source.id : undefined;
    const to = typeof l.target?.id === "string" ? l.target.id : undefined;

    // what a grid will render from this query's rows
    if (basePort(String(l.output ?? "")) === "dataChange"
      && basePort(String(l.input ?? "")) === "data" && from && to) {
      const q = queryOf.get(from);
      const w = widgetBehind(widgetById.get(to)) as Record<string, unknown> | undefined;
      if (q && w) {
        const cols = ((w["settings"] as { columns?: Array<{ path?: unknown }> } | undefined)?.columns ?? [])
          .map((c) => c.path).filter((x): x is string => typeof x === "string" && x.length > 0);
        demandFor(q).columnPaths.push(...cols);
      }
    }

    // what the page supplies to this query, and what kind of thing supplies it
    if (to && typeof l.input === "string" && l.input) {
      const q = queryOf.get(to);
      if (q) {
        const port = basePort(l.input);
        demandFor(q).boundPorts.add(port);
        const key = `${q} ${port}`;
        if (!feeders.has(key)) feeders.set(key, new Set());
        feeders.get(key)!.add(String(l.output ?? ""));
      }
    }
  }

  /* A port is empty-on-load when EVERY feeder is a form/filter field. The
     `field…Change` shape is how a Form announces one of its own controls; it is
     the same string the page's links carry, so this reads the artifact rather
     than assuming a widget kind. */
  for (const [key, outs] of feeders) {
    const [q, port] = key.split(" ") as [string, string];
    if (outs.size === 0) continue;
    if ([...outs].every((o) => /^field.*Change$/.test(basePort(o)))) {
      out.get(q)?.emptyOnLoadPorts.add(port);
    }
  }
  return out;
}

function writeQueries(
  cfg: PipelineConfig, descriptor: SpecDescriptor, spec: { queries: readonly string[] },
  outDir: string, pageObjectId: string, log: (l: string) => void,
  demand?: ReadonlyMap<string, QueryDemand>,
  pageSchema: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(),
): QueryOutcome[] {
  if (spec.queries.length === 0) return [];

  const skeletonPath = cfg.assets["skeletonQuery"];
  if (skeletonPath === undefined) {
    log("  queries: no skeletonQuery asset configured — skipping query generation");
    return [];
  }
  const skeleton = readAsset(cfg, "skeletonQuery");
  /*
   * The join graph, read from CMF's own schema (F-158). Where the descriptor
   * declares a path that crosses an entity boundary without a join, the schema
   * can state the foreign key rather than the builder refusing. Absent or
   * unreadable, every derivation declines and behaviour is exactly as before.
   */
  const relations = cfg.assets["entityRelations"]
    ? loadRelations(assetPath(cfg, "entityRelations"))
    : null;
  if (relations) log(`  entity relations loaded (${relations.entityCount ?? "?"} entity types)`);
  const dir = join(outDir, "queries");
  const out: QueryOutcome[] = [];
  let made = 0;

  /*
   * A story NAMES its queries; it does not describe them. Until 2026-08-20 that
   * ended the matter — `writeQueries` produced nothing and the run shipped a page
   * bound to queries that were not in the package (T-21). The only fix was a
   * hand-built descriptor, which a web-app user cannot produce.
   *
   * So where the client has already delivered that query, TRANSCRIBE it. This is
   * evidence, not inference: the `ProductionOrder -> Product` join is
   * `ProductId -> DefinitionId`, which no naming rule predicts (F-125), and a
   * chat run once reported inferring query bodies from grid columns — which
   * would eventually produce a query that runs and returns the wrong rows.
   *
   * THE DELIVERED FILE WINS, AND SHIPS VERBATIM  (T-46, reversing the earlier rule)
   *
   * This used to read "the descriptor still wins where it carries a definition:
   * an explicit statement of what THIS story wants outranks a file from an
   * earlier one." That was wrong, and Athena found it.
   *
   * The descriptor's `queryDefinitions` are not a statement of what the story
   * wants — a story NAMES its queries and never describes them, so those entries
   * are the model's reconstruction from the prose. On US-455386 that produced a
   * `CustomRetrievePOMaterials` with 9 fields against their delivered 10, a
   * `CustomRetrieveProductionOrders` with `Name IsEqualTo` where theirs has
   * `Contains`, no `Product` join and no `UniversalState` filter. A grid that
   * opens empty and a Materials grid with six blank columns followed.
   *
   * So: where the corpus holds the query, transcribe it, and say so when a
   * descriptor definition was set aside. Evidence beats a derivation — the rule
   * this file already applies to data paths, type codes and action ids.
   *
   * VERBATIM WHERE IT CAN BE, EXTENDED WHERE IT MUST BE.
   *
   * Byte for byte is preferred: a round trip through our reader and writer can
   * only lose what the reader does not model — display styles and formats,
   * `Top`, `Distinct`, field ordering — and their file is the one their own
   * master data deploys.
   *
   * But their file is not always sufficient. `CustomRetrievePOMaterials` selects
   * five fields and this story's grid binds ten columns, so six of them can
   * never render; that is the second thing Athena reported. Where the page needs
   * more than the delivered query gives, it is EXTENDED and every addition is
   * named — see `query-complete.ts`. Shipping their file unchanged would be
   * faithful and useless.
   */
  const transcribed = findQueryDefinitions(querySourceRoots(cfg), spec.queries);
  for (const [name, hit] of transcribed) {
    const supplanted = queryDefinitionFor(descriptor, name)
      ? " — the descriptor's own definition set aside, because this is the artifact " +
        "your tenant runs and that one is a reconstruction from the document"
      : "";
    log(`  queries: transcribed ${name} verbatim from ${basename(hit.source)}${supplanted}`);
  }

  spec.queries.forEach((name, i) => {
    const found = transcribed.get(name);
    // The delivered definition first — see the note above on why it outranks
    // the descriptor's reconstruction.
    const asDelivered = found?.def ?? queryDefinitionFor(descriptor, name);
    if (!asDelivered) {
      out.push({ name, built: false, reason: "no structure in the descriptor — names only" });
      return;
    }
    try {
      if (made === 0) mkdirSync(dir, { recursive: true });
      const file = join(dir, `${name}.xml`);

      /* Can this query serve the grid it fills, and can its filters ever be
         satisfied? Asked against the assembled page, which is the only place
         both facts exist. */
      const need = demand?.get(name);
      const completed = need
        ? completeQuery({
            def: asDelivered, columnPaths: need.columnPaths, boundPorts: need.boundPorts,
            emptyOnLoadPorts: need.emptyOnLoadPorts,
            ports: inputPortsOf(asDelivered), schema: pageSchema,
          })
        : { def: asDelivered, completion: { changes: [], unresolved: [], risky: [] } };
      const def = completed.def;
      for (const line of formatQueryCompletion(name, completed.completion)) log(line);

      if (found) {
        /*
         * THEIR FILE, EDITED IN PLACE — never re-serialised.
         *
         * A rebuild rewrites aliases our reader does not model, and on this
         * story that would have cost a working column: their Step field is
         * `__cmf_html_Step_Name`, which is what makes the cell read "SCCO2
         * Cleaning" rather than a row id. Six blank columns traded for one
         * newly-broken one is not a fix. See `query-edit.ts`.
         */
        let xml = readFileSync(found.source, "utf-8");
        const applied: string[] = [];

        for (const ch of completed.completion.changes) {
          if (ch.kind !== "optional") continue;
          const port = /^"([^"]+)"/.exec(ch.detail)?.[1];
          if (!port) continue;
          const r = relaxFilter(xml, port);
          if (r.changed) { xml = r.xml; applied.push(`${port} made optional`); }
          else log(`    ! ${name}: could not relax "${port}" — the filter was not found ` +
                   `where expected, so the file is unchanged and the grid may open empty.`);
        }

        /* Scalars on the root entity only. A joined path needs a Relation and a
           foreign key, which is a structural change this cannot make safely. */
        const scalars = completed.completion.changes
          .filter((c) => c.kind === "field")
          .map((c) => /^\+(\S+)/.exec(c.detail)?.[1])
          .filter((f): f is string => typeof f === "string" && !f.includes("."));
        const fx = addFields(xml, scalars.map((s) => ({
          name: s, alias: s, objectAlias: `${def.entity}_1`, objectName: def.entity,
        })));
        if (fx.added.length) { xml = fx.xml; applied.push(`+${fx.added.join(", +")}`); }

        for (const r of completed.completion.risky) {
          log(`    ! ${name}: "${r}" crosses a join, so it is NOT added here — that would ` +
              `mean inventing a Relation and a foreign key. The column will render blank ` +
              `until the join is confirmed. Reported, not guessed.`);
        }

        writeFileSync(file, xml, "utf-8");
        if (applied.length) {
          log(`    ! ${name}: REPLACES the one in your tenant — their file with exactly ` +
              `these edits and nothing else: ${applied.join("; ")}. Review before importing.`);
        }
      } else {
        // Distinct object ids per artifact; the page's id is the base.
        const objectId = (pageObjectId.slice(0, 19 - 2) + String(i + 1).padStart(2, "0")).slice(0, 19);
        /* The schema decides one thing: whether a materialised reference field
           also carries `Revision`. `Product` has one, `Step` does not. */
        let xml: string;
        try {
          xml = assembleQuery({ skeleton, def, objectId, relations, schema: pageSchema }).xml;
        } catch (e) {
          /* A field upgraded to a joined path (`Product` -> `Product.Id`) needs a
             join the relation graph may not evidence. Losing ONE column to that
             is a gap worth reporting; losing the whole query would take every
             other column with it. Revert only the risky ones and rebuild. */
          if (completed.completion.risky.length === 0) throw e;
          const risky = new Set(completed.completion.risky);
          def.fields = def.fields.map((f) => (risky.has(f) ? (f.split(".")[0] ?? f) : f));
          xml = assembleQuery({ skeleton, def, objectId, relations, schema: pageSchema }).xml;
          for (const r of completed.completion.risky) {
            log(`    ! ${name}: could not reach ${r} — the relation graph does not state ` +
                `the join (${e instanceof Error ? e.message : String(e)}). Left as the bare ` +
                `reference, so that column shows an id rather than a name.`);
          }
        }
        writeFileSync(file, xml, "utf-8");
      }
      made += 1;

      // CMF's import path will not catch a semantic defect in a query any more
      // than it will in a page, so check it here or nothing checks it. Their own
      // file is checked too — if a delivered artifact fails our rules, that is
      // worth seeing rather than exempting.
      const qr = validateQuery(file, loadConventions(), def);
      /* The fields of the FILE, not of the definition. Where their export was
         edited in place, a joined field was declined and never written, and a
         coverage check reading `def` would pass on a column that is blank. */
      const declined = new Set(found ? completed.completion.risky : []);
      out.push({
        name, built: true, path: file,
        inputPorts: inputPortsOf(def), mandatoryPorts: mandatoryPortsOf(def),
        fields: def.fields.filter((f) => !declined.has(f)),
        aliases: [...readFileSync(file, "utf-8")
          .matchAll(/<Alias value="([^"]*)"/g)].map((m) => m[1]!).filter(Boolean),
        unevidenced: [...declined].map((f) => f.split(".")[0] ?? f),
        /* Only what was actually WRITTEN. A joined field the editor declined is
           reported under "still open", and listing it as a change too would have
           the package contradict itself. */
        ...(found
          ? (() => {
              const applied = completed.completion.changes.filter((c) =>
                c.kind !== "field" ||
                ![...declined].some((d) => c.detail.startsWith(`+${d}`)));
              return applied.length ? { changes: applied } : {};
            })()
          : {}),
        report: qr,
        ...(found ? { transcribedFrom: found.source } : {}),
      });
    } catch (e) {
      out.push({ name, built: false, reason: e instanceof Error ? e.message : String(e) });
    }
  });

  const okCount = out.filter((q) => q.built).length;
  log(`  queries: ${okCount}/${spec.queries.length} generated` +
      (okCount ? ` -> ${dir}` : ""));
  for (const q of out.filter((x) => !x.built)) {
    log(`    ! ${q.name}: ${q.reason} — reported as a gap, not invented`);
  }
  for (const q of out.filter((x) => x.built)) {
    const c = q.report?.counts;
    log(`    ${q.name}: PASS ${c?.PASS ?? "?"} WARN ${c?.WARN ?? "?"} FAIL ${c?.FAIL ?? "?"}` +
        (q.inputPorts?.length ? `  ports: ${q.inputPorts.join(", ")}` : ""));
    for (const f of (q.report?.results ?? []).filter((x) => x.level === "FAIL")) {
      log(`      FAIL ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    }
  }
  return out;
}
