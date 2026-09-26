/**
 * PROMPT PACKAGE — assembles the cached prefix Claude sees on every call.
 *
 * Up to SEVEN blocks, byte-identical on every request, in a fixed order:
 *
 *   rules -> skeleton -> [widgets] -> [entityTypes] -> [oobPages] -> dictionary -> samples
 *
 * The bracketed three are OPTIONAL and driven entirely by `pipeline.json` assets:
 * a key that is absent contributes no block, so package contents are config
 * rather than code. `rules`, `skeleton` and `dictionary` are mandatory; `samples`
 * may be empty only when `oobPages` is present, so the model always sees at least
 * one real page.
 *
 * ORDER IS DELIBERATE. Rules first, then the shape of the file, then what the
 * platform offers (widgets, schema), then stock pages for structure, then the
 * vocabulary, then Athena's own pages last — nearest the request, and the
 * authority on house style where they and a stock page disagree.
 *
 * A single cache_control breakpoint sits on the LAST block, so the whole prefix
 * is cached together. **Nothing volatile — timestamps, ids, the descriptor, the
 * per-page GUI-test brief — may appear before that breakpoint**, or the cache is
 * invalidated for every later request.
 *
 * The descriptor is deliberately NOT part of this. It goes in the user turn,
 * after the breakpoint, because it changes on every run.
 *
 * (This header said "four assets" until 2026-08-19, three blocks after that
 * stopped being true. If you add a block, correct it here.)
 */
import { basename } from "node:path";
import { readFileSync } from "node:fs";
import type { PipelineConfig } from "./config";
import { readAsset, samplePaths } from "./config";
import { loadConventions, rule, type Conventions } from "../conventions";

export interface PromptBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface PromptPackage {
  blocks: PromptBlock[];
  /** for reporting — which assets went in and how big they were */
  manifest: Array<{ name: string; chars: number }>;
}

/**
 * The output contract for the generation call.
 *
 * Deliberately explicit about the division of labour: the model fills five
 * arrays, our code does everything mechanical. Every job we take off the model
 * is a class of error it can no longer make.
 */
export const OUTPUT_CONTRACT = `
## What to return

Return exactly two fenced blocks, in this order, and nothing else outside them.

1. A \`\`\`json block containing ONLY the keys you are responsible for:
   \`widgets\`, \`links\`, \`actionButtons\`, \`dataSources\`, \`diagramModel\`,
   \`layoutWidgets\` and \`pageProperties\` (both described below).
   Do not repeat the keys the skeleton already supplies (__cmfVersion, id,
   version, layouts, definition, leftPanel, rightPanel, properties, revision).
   Emitting any other key is an error — CMF ignores unknown keys silently, so
   the page would import cleanly and not work.

### \`pageProperties\` — values the PAGE holds, so widgets can be wired together

A page property is how a value crosses the page: a wizard receives a selection
into one, a form writes an entered value into another, and a service call reads
them back out. The delivered pages in your samples show the pattern — look at
what each wizard declares beyond the standard plumbing, and at the links that
move values through them.

The settings shell declares only the standard plumbing properties. **Declare the
business ones here** and our code mints their ids, exactly as it does \`$id\`
markers. You never write a property id.

\`\`\`json
{ "name": "<PropertyName>",
  "type": { "type": 11, "collectionType": 1, "referenceType": 1,
            "referenceTypeName": "<EntityName>" } }
\`\`\`

\`type\` is the same shape a column carries: the scalar code, plus
\`referenceTypeName\` when it points at an entity. \`collectionType: 1\` means a
collection. A property with no \`type\` is rejected — CMF cannot bind what it
cannot type.

**Referring to one in a link.** Write \`prop$<Name>\` as the port, with the page
itself as the endpoint (\`"type": 0\`); our code substitutes the minted id and the
page's own id.

\`\`\`json
{ "id": "...", "source": { "id": "page", "type": 0 }, "output": "prop$<PropertyName>",
  "target": { "id": "<widget id>", "type": 1 }, "input": "property$<PropertyName>" }
\`\`\`

Naming a property that \`pageProperties\` does not declare is an **error**, not a
warning. A dangling endpoint imports cleanly into CMF and silently does nothing,
which is the one outcome worse than a missing link. If you cannot evidence the
wiring, declare no property and record it as a gap — that remains correct.

### \`layoutWidgets\` — where each widget sits on the screen

Declaring a widget is not enough. A widget that is never **placed** exists in the
file and never appears: the page imports cleanly and renders an empty canvas.

Return one entry per widget, in \`layoutWidgets\`. Our code moves the array into
\`layouts[0].widgets\`; the rest of the layout is supplied by the skeleton.

\`\`\`json
{ "id": "<the id of the widget you are placing>",
  "position":   { "row": 1, "column": 1, "panel": 2 },
  "dimensions": { "rows": 1, "columns": 8 },
  "collapsed": true }
\`\`\`

- \`row\` and \`column\` are 1-based grid coordinates; \`panel\` 2 is the centre pane.
- \`dimensions.columns\` is a span in layout columns. The grid's total width is
  given to you below as "layout columns" — the skeleton shows a placeholder there,
  not the real number, so use the value in the request. A widget must never end
  past the last column: \`position.column + dimensions.columns - 1\` must be less
  than or equal to the total.
- Lay the page out the way the story describes: stacked grids occupy the same
  column and increasing rows.
- Every id in \`layoutWidgets\` must be one you emitted in \`widgets\`, and every
  widget must appear exactly once.

2. A \`\`\`markdown block containing the gap report.

## What our code does, so you do not have to

- **\`$id\` markers.** Do NOT emit them. Our post-processor numbers every object
  in pre-order after you finish. Spend no effort or tokens on numbering.
- **XML escaping and the envelope.** You return plain JSON; we escape it and
  substitute it into the skeleton.
- **The page name, UIType and object id.** Supplied by our code.

Everything else — which widgets exist, which columns they carry, what each is
wired to, and what you could not determine — is yours.
`.trim();

/**
 * Is this delivered page the page we are generating?
 *
 * The two names are written differently by the two systems: a delivered export
 * carries `<Name value="Load Materials to Feeder">` while the artifact we build
 * is `CustomLoadMaterialsToFeeder`. An exact comparison would never fire, and the
 * withholding it guards would be decoration.
 *
 * So: case, spacing and punctuation are ignored, and the client's artifact-name
 * prefix is dropped before comparing.
 *
 * THE PREFIX IS READ FROM `client-conventions.json`, NOT WRITTEN HERE. `Custom`
 * is a choice this client made — `conventions.ts` says so in its own header, and
 * `applyNamePrefix()` already reads it from config. A literal here would be the
 * same case-specific-value-in-source breach the 2026-08-19 audit found three of
 * (F-147), and it would silently stop matching for a client who prefixes
 * differently.
 *
 * DELIBERATELY ERRING TOWARD WITHHOLDING. A false match costs one exemplar out of
 * several, and the counts still teach the shape. A false miss hands the model the
 * answer it is being measured on, which is §13.8 — the contamination that
 * invalidated the first run this project ever scored.
 */
export function samePage(
  deliveredName: string, targetName: string, conventions: Conventions = loadConventions(),
): boolean {
  const prefix = (rule(conventions, "namePrefix")?.value ?? "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
  const norm = (s: string): string => {
    const flat = s.toLowerCase().replace(/[^a-z0-9]/g, "");
    return prefix && flat.startsWith(prefix) ? flat.slice(prefix.length) : flat;
  };
  const a = norm(deliveredName), b = norm(targetName);
  return a.length > 0 && a === b;
}

export interface PackageOptions {
  /**
   * Page being generated. Any sample whose file is that same page is dropped.
   *
   * Without this the target page sits in the sample block and the model can
   * simply copy it — the run then measures transcription, not generation, and
   * reports zero unknowns because it was handed every answer.
   */
  excludePage?: string;
  /**
   * Optional asset blocks to leave OUT of the package, by name.
   *
   * The A/B control for every config-driven asset, in one mechanism rather than a
   * flag per asset. `--no-gui-brief` exists because A-53 needed a labelled
   * control; §1.3b then asked for `--no-services` for the same reason, and the
   * next asset would have asked for a third flag.
   *
   * WITHHOLDING IS ANNOUNCED, never silent: a run whose prompt quietly lost a
   * block would produce a worse result with nothing saying why, which is the
   * measurement equivalent of a lying PASS line (defect 18).
   *
   * Only OPTIONAL blocks can be withheld. `rules`, `skeleton` and `dictionary`
   * are refused, because a package without them does not describe the job.
   */
  withhold?: readonly string[];
  onExclude?: (file: string) => void;
}

/** Blocks the package cannot do without — withholding one is a mistake, not a control. */
export const MANDATORY_BLOCKS: readonly string[] = ["rules", "skeleton", "dictionary"];

export class PackageError extends Error {}

export function buildPackage(cfg: PipelineConfig, opts: PackageOptions = {}): PromptPackage {
  const manifest: Array<{ name: string; chars: number }> = [];
  const parts: string[] = [];

  const withheld = new Set(opts.withhold ?? []);
  for (const name of withheld) {
    if (MANDATORY_BLOCKS.includes(name)) {
      throw new PackageError(
        `"${name}" cannot be withheld — a package without it does not describe the ` +
        `job. Withholding is an A/B control for the OPTIONAL assets ` +
        `(${Object.keys(cfg.assets).join(", ")}).`,
      );
    }
  }

  const add = (name: string, header: string, body: string): void => {
    if (withheld.has(name)) {
      /* Announced, never silent: a prompt that quietly lost a block produces a
         worse result with nothing saying why. */
      opts.onExclude?.(`the ${name} block (withheld — A/B control)`);
      return;
    }
    manifest.push({ name, chars: body.length });
    parts.push(`${header}\n\n${body}`);
  };

  add("rules", "# RULES", readAsset(cfg, "rules"));

  add(
    "skeleton",
    "# SKELETON — the file you are filling in",
    "The XML envelope (placeholders are filled by our code):\n\n```xml\n" +
      readAsset(cfg, "skeleton") +
      "\n```\n\nThe settings shell. The five empty arrays are your job:\n\n```json\n" +
      readAsset(cfg, "skeletonSettings") +
      "\n```",
  );

  // Optional static assets, driven entirely by pipeline.json `assets`. A key that is
  // absent simply contributes no block — the package contents are config, not code.
  // Both sit BEFORE the cache breakpoint, so both must stay static.
  if (cfg.assets["widgets"] !== undefined) {
    add(
      "widgets",
      "# WIDGETS — the components CMF offers, and their ports",
      readAsset(cfg, "widgets"),
    );
  }
  if (cfg.assets["entityTypes"] !== undefined) {
    add(
      "entityTypes",
      "# ENTITY PROPERTY TYPES — from the live CMF schema",
      readAsset(cfg, "entityTypes"),
    );
  }

  // Athena scope item (a): "refer to OOB templates given in CMF to use as a
  // baseline". Deliberately placed BEFORE the samples block and labelled as
  // structure-only: the samples are Athena's own pages, and where a stock page
  // and Athena's page disagree on a convention, Athena is what we are judged on.
  if (cfg.assets["oobPages"] !== undefined) {
    add(
      "oobPages",
      "# OOB BASELINE — stock CMF pages, for STRUCTURE (house style comes from the samples)",
      readAsset(cfg, "oobPages"),
    );
  }

  add("dictionary", "# VOCABULARY", readAsset(cfg, "dictionary"));

  /*
   * SERVICE CONTRACTS — what a `ServiceCallDataSource` needs in order to exist.
   *
   * Config-driven and optional, like `oobPages` and `actionIds`: remove the asset
   * and the generator goes back to reporting the service as a gap, which is what
   * it did before this existed and remains correct behaviour without evidence.
   *
   * Measured 2026-08-27: given page properties to bind to, the model still
   * emitted no service call and named this exact absence as the reason.
   */
  if (cfg.assets["services"] !== undefined) {
    add(
      "services",
      "# SERVICE CONTRACTS — transcribed from delivered pages; a service absent here is UNKNOWN",
      readAsset(cfg, "services"),
    );
  }

  /*
   * COLUMN LABELS — the hop the dictionary does not carry.
   *
   * §1 maps a term to a path; §6 lists which message names exist; nothing joins
   * them. Measured over three runs from one descriptor, the PO page's Quantity
   * column resolved to `$(PrimaryQuantityColumnLabel)` twice and
   * `$(UNKNOWN_Quantity)` once — the model correctly refusing to extrapolate a
   * naming pattern that has four competing forms.
   *
   * Config-driven and removable, like the two blocks above.
   */
  if (cfg.assets["columnLabels"] !== undefined) {
    add(
      "columnLabels",
      "# COLUMN LABELS — path + type + referenceTypeName to message name; a conflict means UNKNOWN",
      readAsset(cfg, "columnLabels"),
    );
  }

  /*
   * MESSAGE NAMES — the client's OWN label vocabulary, and where each is used.
   *
   * Rule 2 wants a `$(MessageName)`; Rule 1 forbids composing one. Between them,
   * a story saying "label the column Batch" had nowhere to go: `KNOWN-MESSAGES.txt`
   * carries 4,533 PLATFORM names with no text, and `COLUMN-LABELS.json` joins a
   * path to a name for GRID COLUMNS only.
   *
   * Measured 2026-08-28: the client's own master data declares 199 custom message
   * names WITH their English text, and not one is in the platform list. 31 of the
   * 53 label sites this asset carries are filters, form fields and button titles —
   * places nothing previously covered.
   *
   * Config-driven and removable, like the blocks around it.
   */
  if (cfg.assets["messageNames"] !== undefined) {
    add(
      "messageNames",
      "# MESSAGE NAMES — the client's own label vocabulary; a conflict means UNKNOWN",
      readAsset(cfg, "messageNames"),
    );
  }

  /*
   * ENTITY QUERIES — the shape of a reference field's picker.
   *
   * A field that references an entity picks from the whole entity by default,
   * or from a NAMED QUERY written as `entityTypeQuery`. Nothing harvested that,
   * so the generator had never seen one — and on US-1122, whose story states
   * that the Feeder Resource picker is driven by an existing query, it declared
   * the query, wired it to nothing, and reported to Athena that no such shape
   * was evidenced. Their own exports carry it four times.
   *
   * The asset leads with the null majority (27 of 31) precisely so this block
   * does not read as "reference fields take queries". It is here to let the
   * model WRITE one when the story names it, not to make it want one.
   *
   * Generation only, deliberately: this is a fact about serialising a page, and
   * extraction serialises nothing. It is not in VOCABULARY_BLOCKS.
   *
   * Config-driven and removable, like the blocks around it.
   */
  if (cfg.assets["entityQueries"] !== undefined) {
    add(
      "entityQueries",
      "# ENTITY QUERIES — a reference field's picker; null is the majority, a conflict means UNKNOWN",
      readAsset(cfg, "entityQueries"),
    );
  }

  /*
   * WIDGET SHAPES — how many of each kind the client has delivered, what keys
   * each carries and how often, and a transcribed exemplar for the kinds config
   * names.
   *
   * This block exists because of a specific, measured failure. `WIDGETS.md`
   * documents the settings shape of Grid, Form and UiPageWidget — precisely the
   * three we had ever emitted — so a story asking for filter fields and a button
   * in the page body got a `Form` and an `actionButton` (F-171 items 2 and 3).
   *
   * It is deliberately NOT a second worked example. One citation and a rule are
   * indistinguishable to a reader, which is how one wizard example in
   * `DICTIONARY.md` suppressed every service call on an ordinary Page (F-172).
   * What earns its place here is the distribution: 8 Filters over 5 pages, 8 of 8
   * hosting an inner widget, `property` on 41 of 41 filter entries.
   *
   * THE TARGET PAGE'S OWN EXEMPLAR IS WITHHELD, for the same reason its sample is
   * (§13.8). Exemplars are harvested one per page precisely so that dropping one
   * still leaves the shape taught.
   */
  if (cfg.assets["widgetShapes"] !== undefined) {
    const shapes = JSON.parse(readAsset(cfg, "widgetShapes")) as {
      widgets?: Array<{ kind: string; exemplars?: Array<{ page: string }> }>;
    };
    let withheld = 0;
    for (const w of shapes.widgets ?? []) {
      if (!w.exemplars || !opts.excludePage) continue;
      const keep = w.exemplars.filter((e) => !samePage(e.page, opts.excludePage!));
      withheld += w.exemplars.length - keep.length;
      w.exemplars = keep;
    }
    if (withheld) opts.onExclude?.(`${withheld} widget exemplar(s) from ${opts.excludePage}`);
    add(
      "widgetShapes",
      "# WIDGET SHAPES — counted across the delivered corpus; read the counts, not the example",
      "```json\n" + JSON.stringify(shapes, null, 2) + "\n```",
    );
  }

  const sampleParts: string[] = [];
  for (const p of samplePaths(cfg)) {
    const file = basename(p);
    if (opts.excludePage && file === `${opts.excludePage}.xml`) {
      opts.onExclude?.(file);
      continue;
    }
    sampleParts.push(`## ${file}\n\n\`\`\`xml\n${readFileSync(p, "utf-8")}\n\`\`\``);
  }
  // The model must see at least ONE real page. Athena's samples and the OOB block
  // both qualify, so the error fires only when neither is present — which lets an
  // OOB-only package be measured rather than argued about.
  if (sampleParts.length === 0 && cfg.assets["oobPages"] === undefined) {
    throw new Error(
      "every sample was excluded and no oobPages asset is configured — the model " +
      "would have no example of the format at all",
    );
  }
  if (sampleParts.length > 0) {
    add(
      "samples",
      "# SAMPLES — real pages CMF has already accepted",
      sampleParts.join("\n\n"),
    );
  }

  // one breakpoint, on the last block — caches rules+skeleton+dictionary+samples together
  const blocks: PromptBlock[] = parts.map((text, i) => (
    i === parts.length - 1
      ? { type: "text" as const, text, cache_control: { type: "ephemeral" as const } }
      : { type: "text" as const, text }
  ));

  return { blocks, manifest };
}

/**
 * THE VOCABULARY BLOCKS ONLY — for the calls that DECIDE terms rather than build.
 *
 * WHY THIS EXISTS
 *   Traced 2026-08-28, after being asked whether the harvest is used at every
 *   stage. It was not:
 *
 *     extractDescriptor   EXTRACT_PROMPT.md and nothing else
 *     runPrd (narrative)  PRD_PROMPT.md and nothing else
 *     generate / modify / fix / chat intake   the full package
 *
 *   So every asset built to answer "what CMF path does this word mean" reached
 *   the call that WRITES the page and not the call that DECIDES it. Extraction
 *   is where "Storage Step" becomes `Step`, "Batch" becomes
 *   `ManufacturerLotNumber` and "Material" becomes `Name` — and it was making
 *   those decisions with none of the evidence.
 *
 *   Worse in the web app, which is the path the client uses: `write_prd` calls
 *   `runPrd` with a story and no descriptor, so `runPrd` extracts one INTERNALLY,
 *   blind. The model could discuss the vocabulary in the conversation (the chat
 *   system prompt does carry it) while the descriptor underneath was written
 *   without it — which is exactly the observed split, where the PRD prose said
 *   "Storage Step maps to Step" and the gap report called an evidenced path
 *   unevidenced.
 *
 * WHY A SUBSET AND NOT THE WHOLE PACKAGE
 *   Extraction does not fill in a skeleton, does not choose a widget and does not
 *   copy a sample; handing it the XML shell and four sample pages would be tokens
 *   spent on a job it is not doing, and would invite it to start writing the page
 *   in the descriptor. What it needs is the words: the dictionary, the label
 *   joins and the service contracts.
 *
 * The list is DERIVED from the full package by name, so a block added to
 * `buildPackage` is one decision away from reaching extraction too, and a block
 * renamed here fails the gate rather than silently vanishing.
 */
export const VOCABULARY_BLOCKS: readonly string[] =
  ["dictionary", "columnLabels", "messageNames", "services", "entityTypes"];

export function vocabularyPackage(cfg: PipelineConfig): PromptPackage {
  const full = buildPackage(cfg, {});
  const keep = new Set(VOCABULARY_BLOCKS);
  const idx = full.manifest
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => keep.has(m.name));

  const blocks: PromptBlock[] = idx.map(({ i }, n) => {
    const b = full.blocks[i]!;
    /* One breakpoint, on the last kept block, exactly as the full package does.
       Without it every extraction pays full price for a prefix that never
       changes between runs. */
    return n === idx.length - 1
      ? { type: "text" as const, text: b.text, cache_control: { type: "ephemeral" as const } }
      : { type: "text" as const, text: b.text };
  });
  return { blocks, manifest: idx.map(({ m }) => m) };
}

export function manifestTable(pkg: PromptPackage): string {
  const total = pkg.manifest.reduce((a, m) => a + m.chars, 0);
  const rows = pkg.manifest.map(
    (m) => `    ${m.name.padEnd(12)} ${String(m.chars).padStart(8)} chars`,
  );
  return [...rows, `    ${"TOTAL".padEnd(12)} ${String(total).padStart(8)} chars (cached prefix)`]
    .join("\n");
}
