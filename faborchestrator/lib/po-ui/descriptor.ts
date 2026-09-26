/**
 * SPEC DESCRIPTOR — the contract between a user story and everything downstream.
 *
 *   user story (prose) ──► descriptor ──► generator ──► artifact
 *                              │                            │
 *                              └────────► validator ◄───────┘
 *
 * WHY THIS EXISTS
 *   The validator used to carry US-455386's columns, buttons and queries as a
 *   constant. That grades exactly one page correctly and silently misgrades every
 *   other. The descriptor makes the requirement an INPUT.
 *
 * TWO PRINCIPLES, both load-bearing:
 *
 *   1. The descriptor speaks the USER STORY's language, never CMF's.
 *      "Integer", not `type: 5`. "multiple", not `selectionMode: 2`. Encodings are
 *      platform facts and live in the platform constants module (D-2). If a CMF
 *      encoding ever appears in this file, the separation has been broken.
 *
 *   2. Nothing is optional-by-omission.
 *      Every collection is REQUIRED, even when empty. `actionButtons: []` states
 *      that the story asks for no buttons; a missing key would only mean nobody
 *      thought about it. For a tool whose product is an honest gap report, the
 *      difference matters.
 *
 * This zod schema is the single source of truth: the TypeScript type is inferred
 * from it, the runtime validator is it, and schema/spec-descriptor.schema.json is
 * emitted from it for the Python oracle. There is no hand-maintained copy to drift.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSET_ROOT } from "./asset-root";
import { z } from "zod";

/** Types as a user story states them. Mapping to CMF codes belongs in D-2. */
export const ScalarType = z.enum([
  "String", "Integer", "Boolean", "DateTime", "Decimal", "Reference",
]);

/** How many rows a user may select. Maps to CMF's selectionMode elsewhere. */
export const Selection = z.enum(["single", "multiple", "none"]);

/**
 * The classes of screen the TARGET platform recognises (T-16).
 *
 * This was `z.enum(["Page", "Wizard", "Cluster", "Step"])` written into source.
 * Everything else in this file is generic UI vocabulary — entity, columns, forms,
 * grids, actionButtons, filters, joins — but `Cluster` and `Step` are **CMF page
 * classes**, not universal concepts. They were the last target-specific term in
 * what is meant to be the target-neutral layer.
 *
 * Read from `config/pipeline.json` -> `target.pageTypes` so a second UI
 * technology declares its own vocabulary without editing this file. Deliberately
 * read HERE rather than imported from `platform.ts`: the descriptor must not
 * depend on a platform module, or the neutrality is only nominal.
 *
 * Falls back to CMF's four if the config is absent or unreadable — this module is
 * imported by the validator and every CLI, so a missing key must not stop the
 * whole application from loading.
 */
function targetPageTypes(): [string, ...string[]] {
  const CMF_DEFAULT: [string, ...string[]] = ["Page", "Wizard", "Cluster", "Step"];
  try {
    /* Read through the pipeline's asset root; a bundled module cannot locate
       its own source directory. See `generate/config.ts`. */
    const path = join(ASSET_ROOT, "config", "pipeline.json");
    const raw = JSON.parse(readFileSync(path, "utf-8")) as {
      target?: { pageTypes?: unknown };
    };
    const list = raw.target?.pageTypes;
    if (!Array.isArray(list) || !list.length) return CMF_DEFAULT;
    const names = list.filter((v): v is string => typeof v === "string" && v.length > 0);
    return names.length ? (names as [string, ...string[]]) : CMF_DEFAULT;
  } catch {
    return CMF_DEFAULT;
  }
}

export const PAGE_TYPES: readonly string[] = targetPageTypes();
export const UiType = z.enum(targetPageTypes());

/*
 * WHY EVERY CONTRACT BELOW IS A `.describe()` AND NOT ONLY A COMMENT.
 *
 * `extractionSchema` sends the JSON Schema emitted from THIS file to the model
 * as the structured-output contract. `z.toJSONSchema` emits `description` from
 * `.describe()` and nothing from JSDoc - so until 2026-08-31 the emitted schema
 * was 4475 bytes carrying **zero** descriptions, and every field contract
 * written here was addressed to a human reader the extraction call never had.
 *
 * That was not free. The extraction call is also handed the VOCABULARY package,
 * whose whole job is teaching it that "Storage Step" means `Step` and "Batch"
 * means `ManufacturerLotNumber`. With the mapping present and the contract
 * absent, filter fields came back as CMF paths in **5 of 11** measured runs -
 * and the PRD-stage screen then showed an engineer `STEP` where their document
 * said "Storage Step", at the exact moment they were asked to approve it.
 *
 * So the fields that must hold the STORY'S WORDS say so to the model, in the
 * same breath as the schema that shapes its answer. Keep these one line each:
 * they are re-sent on every extraction call and are not inside the cached
 * prompt package.
 */
const Column = z.object({
  /** the column name as the story writes it, e.g. "PlannedStartDate" */
  name: z.string().min(1)
    .describe("The column heading in the story's own words. Not a CMF data " +
              "path and not a message name - both are decided later, from " +
              "evidence this call does not have."),
  /** the story marked it "(link)" */
  link: z.boolean().optional()
    .describe("True only where the story marks the column as a link."),
  /** the entity a link column points at, where the story says so */
  entity: z.string().min(1).optional()
    .describe("The entity a link column points at, only where the story says."),
  /** stated only when the story states it; absent means "not specified" */
  scalarType: ScalarType.optional()
    .describe("Only when the story states the type. Absent means not specified; " +
              "do not infer one from the column name."),
}).strict();

const Grid = z.object({
  /** the business record this grid lists, e.g. "ProductionOrder" */
  entity: z.string().min(1)
    .describe("The business record this grid lists, e.g. \"ProductionOrder\"."),
  /**
   * Discriminator for the case where one page shows two grids of the SAME entity.
   * Grids are matched to the artifact by entity, so without this such a page
   * would be ambiguous. Omit unless the entity alone is not unique.
   */
  role: z.string().min(1).optional()
    .describe("Only when one page shows two grids of the SAME entity, to tell " +
              "them apart. Omit otherwise."),
  selection: Selection
    .describe("How many rows the story lets the user pick at once."),
  columns: z.array(Column).min(1)
    .describe("The columns the story asks for, in the order it lists them."),
}).strict();

const Field = z.object({
  label: z.string().min(1)
    .describe("The field's caption in the story's own words - what an operator " +
              "would read on screen. Not a CMF path, not a message name."),
  scalarType: ScalarType
    .describe("The kind of value the field holds."),
  entity: z.string().min(1).optional()
    .describe("For a reference field, the entity it points at."),
}).strict();

const Form = z.object({
  /**
   * What the form is for — free text, from the story.
   *
   * NOT "filter". A form that narrows a list belongs in `filters`, and the
   * example that used to sit on this line said the opposite. Measured
   * 2026-09-02 on US-455386: the extractor returned this form with the purpose
   * "Filter production orders" and left `filters` null, so the two stages drew
   * the panel in different places. The renderer no longer depends on the
   * choice, but the descriptor should still say what the story meant.
   */
  purpose: z.string().min(1).optional()
    .describe("A short phrase for what this form is for, from the story. " +
              "A few words, not a sentence - it is shown as the widget's title. " +
              "If the form's job is to NARROW a list shown on this page, it is " +
              "not a form: put it in `filters` instead, naming the list it " +
              "narrows. A form collects values; a filter restricts a list."),
  fields: z.array(Field).min(1)
    .describe("The fields this form collects, in the order the story lists them."),
}).strict();

/**
 * A set of filters and THE LIST THEY NARROW.
 *
 * Distinct from a `Form`, and the distinction is the story's, not CMF's: a form
 * collects values, a filter restricts what a list shows. Both end up as widgets,
 * but only a filter is *about* another widget — which is why the grid it narrows
 * is named here rather than left to be guessed at generation time.
 *
 * The target platform has two ways to build this and the corpus uses both — 41
 * Forms over 12 pages, 8 Filter widgets over 5 — so the descriptor deliberately
 * does NOT choose one. It records what the story asked for; `SYSTEM_PROMPT.md`
 * carries the counted guidance on which mechanism expresses it.
 *
 * NO OPTIONAL MEMBERS, and that is a budget decision rather than a modelling one.
 * The structured-output API refuses a schema with more than **24 optional
 * parameters** — measured, by a 400 on the first call after this field was added
 * with four of them. Field names alone are enough: resolving a name to a data
 * path is the generator's job under Rule 1, and it has evidence the extractor
 * does not.
 */
const FilterPanel = z.object({
  /** the list these filters narrow, matched to a grid the same way grids are */
  entity: z.string().min(1)
    .describe("The entity of the list these filters narrow. Must equal the " +
              "`entity` of the grid they filter, which is how the two are paired."),
  /** the fields to filter by, exactly as the story names them */
  fields: z.array(z.string().min(1)).min(1)
    /* NO EXAMPLE TERMS HERE. An earlier draft illustrated this with the two
       captions from the story that exposed the problem, which put one client's
       vocabulary into source that every client runs. The rule is stated by
       property instead: copy the caption, do not translate it. */
    /* "VERBATIM" alone was too strong, and the correction is measured: on a
       story listing its filters as "<caption> (<control type>) - Mandatory
       field", the extractor returned the whole line as the caption and the
       approval screen showed the annotations as if they were the label. The
       rule is the CAPTION only - the story's wording for the thing being
       filtered, minus the notes the story adds ABOUT it. */
    .describe("The filter CAPTIONS in the story's own wording - the name of " +
              "the thing being filtered, and nothing else. Strip the story's " +
              "annotations about the field: its control type, and whether it " +
              "is mandatory or optional. Those are facts about the field, not " +
              "part of its caption. Do not translate a caption into a data " +
              "path either; you have been given a vocabulary that maps " +
              "captions to paths and it does NOT apply in this field, because " +
              "resolving a caption to a path is the generation call's job. " +
              "This text is shown to the engineer who approves the " +
              "specification, and they can only check it in their own words."),
}).strict();

/**
 * WHERE a control appears and WHAT it acts on — one optional, two facts.
 *
 * Carried together because the schema had room for exactly two more optional
 * parameters and this project needed both facts. They belong together anyway:
 * each answers a question about the control that the other does not, and the
 * generation call sees only the descriptor — never the story — so anything the
 * story said about a button has to arrive here or not at all.
 *
 * `placement` is REQUIRED once this object is present, because the whole reason
 * it exists is that placement cannot be inferred: 581 of 679 delivered
 * action-bar entries carry typed inputs too, so "it takes inputs, therefore it
 * sits in the body" is measurably wrong (F-115's shape, third occurrence).
 */
const ButtonControl = z.object({
  /**
   * `actionBar` — the strip along the top of the page, drawn by the framework.
   * `screen` — a control placed in the page body, next to what it acts on.
   * `null` — the story does not say. Distinct from `actionBar`, which is the
   * story SAYING the action bar.
   *
   * NULLABLE RATHER THAN OPTIONAL, and the first run proved why it must be one
   * or the other. With `placement` strictly required, a story that describes what
   * a button acts on but not where it sits could express NEITHER fact, and the
   * extractor said so in its own notes: *"Its inputs are described … but
   * control.inputs cannot be recorded without a placement."* It was right, and
   * the two facts had been welded together by a schema-budget decision rather
   * than by anything about buttons. Nullable costs no optional slot and unwelds
   * them.
   */
  placement: z.enum(["actionBar", "screen"]).nullable()
    .describe("\"actionBar\" = the strip along the top of the page. " +
              "\"screen\" = a control in the page body, next to what it acts " +
              "on. null = the story does not say, which is different from the " +
              "story saying action bar."),
  /**
   * The values the button acts on, as the story names them — "attach THESE
   * MATERIALS to THIS RESOURCE". Empty when the story does not say.
   */
  inputs: z.array(z.string().min(1))
    .describe("What the button acts on, as the story names them - \"attach " +
              "THESE MATERIALS to THIS RESOURCE\". Empty when the story does " +
              "not say."),
}).strict();

const ActionButton = z.object({
  name: z.string().min(1)
    .describe("The button's caption as the story writes it."),
  /** the UI page this button opens, if the story names one */
  opensPage: z.string().min(1).optional()
    .describe("The UI page this button opens, only if the story names one."),
  /** the service or API this button calls, if the story names one */
  dataSource: z.string().min(1).optional()
    .describe("The service or API this button calls, only if the story names it."),
  /**
   * Where the control appears and what it acts on, when the story says.
   *
   * Omitted means the story did not say. The action bar is then the majority
   * reading — 679 entries over 10 delivered pages, against 18 body buttons over
   * 6 — and that is stated in `EXTRACT_PROMPT.md` rather than defaulted here, so
   * "the story was silent" stays distinguishable from "the story said action
   * bar".
   */
  control: ButtonControl.optional(),
}).strict();

/**
 * One page the story asks for. A story routinely asks for several — US-455386
 * asks for a Wizard and a Page — and each becomes its own artifact, so the
 * descriptor carries them all and the validator selects the one it is grading.
 */
const PageSpec = z.object({
  name: z.string().min(1)
    .describe("The artifact name for this page."),
  uiType: UiType
    .describe("Which kind of UI object the story asks for."),
  title: z.string().min(1).optional()
    .describe("The heading shown on the page, if the story gives one."),
  forms: z.array(Form)
    .describe("Forms the story asks for. A form COLLECTS values; a set of " +
              "controls that narrows a list belongs in `filters`, not here."),
  grids: z.array(Grid)
    .describe("Lists of records the story asks the page to show."),
  actionButtons: z.array(ActionButton)
    .describe("Buttons the story asks for, wherever it places them."),
  /**
   * Filters the story asks for, and which list each narrows.
   *
   * OPTIONAL, which breaks this file's second principle ("nothing is
   * optional-by-omission") and does so knowingly. Every descriptor already
   * written — the shipped sample, the fixed descriptors the measured runs are
   * replayed from, and every one stored against a saved conversation — predates
   * this field, and a required key would invalidate all of them at once. That is
   * the same reason `queries` is optional here.
   *
   * Unlike `queries`, omitted and `[]` mean the same thing: the story asks for no
   * filters. There is no third state to lose.
   */
  filters: z.array(FilterPanel).optional()
    .describe("Sets of controls that NARROW a list, and which list each " +
              "narrows. Omit when the story asks for none."),
  /**
   * The queries THIS page consumes — distinct from the story's `queries`, which are
   * the queries the story asks us to DELIVER.
   *
   * Those two coincide for a one-page story and diverge the moment a story asks for
   * several pages. Conflating them was a real defect: a wizard page that consumes no
   * query was still graded against the whole story list, so the validator FAILED it
   * and the regeneration loop pushed the model into declaring data sources the page
   * does not need — wired to nothing. Athena's own wizard has none.
   *
   * Optional, and deliberately so. Omitted means "fall back to the story's list",
   * which keeps every existing descriptor behaving exactly as before. An explicit
   * empty array means "this page consumes no queries" — which is the wizard's case
   * and cannot be expressed any other way.
   */
  queries: z.array(z.string().min(1)).optional(),
  /**
   * Whether the page refreshes itself, and how often.
   *
   * Added because the descriptor had nowhere to put it. An engineer asked for
   * "auto-refresh every 30 seconds", the model recorded it correctly — but only
   * in `notes`, as prose, because no typed field existed. A note reaches a human
   * reading the PRD; it does not reach `definition.autoRefresh` in the artifact.
   * The change was real, honest and inert.
   *
   * Both are page-level properties CMF already has: the settings shell ships
   * `autoRefresh: false` / `autoRefreshInterval: "PT1M"`, and every delivered
   * page carries them. This does not invent a field, it stops dropping one.
   *
   * Absent means "the story did not say", and the shell's default stands.
   */
  autoRefresh: z.boolean().optional(),
  /**
   * ISO 8601 duration, the format CMF itself uses (`PT1M`, `PT30S`, `PT2H30M`).
   * Constrained rather than free text: "30 seconds" would import as a malformed
   * duration and the page would silently never refresh.
   */
  autoRefreshInterval: z.string()
    .regex(/^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/,
           "must be an ISO 8601 duration, e.g. PT30S or PT1M")
    .optional(),
}).strict().superRefine((p, ctx) => {
  // An interval with the switch off is a spec that contradicts itself: the page
  // would carry a 30-second cadence and never refresh. Say so rather than
  // silently honouring one half.
  if (p.autoRefreshInterval !== undefined && p.autoRefresh !== true) {
    ctx.addIssue({
      code: "custom",
      path: ["autoRefreshInterval"],
      message: "autoRefreshInterval is set but autoRefresh is not true — the page " +
               "would carry an interval it never uses. Set autoRefresh: true, or " +
               "drop the interval.",
    });
  }
  const seen = new Set<string>();
  p.grids.forEach((g, i) => {
    const key = gridKey(g);
    if (seen.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: ["grids", i],
        message:
          `duplicate grid key ${JSON.stringify(key)}. Grids are matched to the ` +
          `artifact by entity, so two grids of the same entity must be told apart ` +
          `by a "role".`,
      });
    }
    seen.add(key);
  });
});

/**
 * Comparison conditions a query filter can use.
 *
 * These are the builder's own dropdown labels with the spaces removed — "Is Equal
 * To" is serialised `IsEqualTo`. Taken from the step-by-step build document and
 * confirmed against the delivered query exports.
 */
export const QueryOperator = z.enum([
  "IsEqualTo", "IsNotEqualTo", "Contains", "StartsWith",
  "GreaterThan", "GreaterThanOrEqualTo", "LessThan", "LessThanOrEqualTo",
  "Like", "NotLike", "In", "NotIn",
  // Added 2026-08-19 from Athena's own exports, which use them on three filters.
  // A null test takes no value: leave `value` unset and omit `parameter`.
  "IsNull", "IsNotNull",
]);

const QueryFilter = z.object({
  /** property path from the query's root entity, e.g. "Name" or "Product.Name" */
  path: z.string().min(1),
  operator: QueryOperator,
  /** the value comes from a query parameter the caller supplies */
  parameter: z.boolean().optional(),
  /** a literal value; ignored when `parameter` is true */
  value: z.string().optional(),
  optional: z.boolean().optional(),
  logicalOperator: z.enum(["AND", "OR"]).optional(),
}).strict();

/**
 * A join the query must make to reach a property on a related entity.
 *
 * Declared explicitly and NOT inferred: the foreign-key columns are real schema
 * (`ProductionOrder.ProductId` -> `Product.DefinitionId` on the reference page)
 * and a guess would produce a query that runs and returns the wrong rows.
 */
const QueryJoin = z.object({
  /** path segment(s) this join provides, e.g. "Product" */
  path: z.string().min(1),
  /** the entity being joined to */
  entity: z.string().min(1),
  sourceProperty: z.string().min(1),
  targetProperty: z.string().min(1),
  joinType: z.enum(["InnerJoin", "LeftJoin", "RightJoin", "FullJoin"]).optional(),
}).strict();

/**
 * Enough to GENERATE a query, as opposed to merely naming one.
 *
 * `queries` (story level) and `pages[].queries` carry NAMES — what to deliver and
 * what a page consumes. This carries the structure. It is optional because a
 * descriptor that only names its queries is still valid; we simply cannot build
 * them, which is a gap to report rather than an error.
 */
const QueryDefinition = z.object({
  name: z.string().min(1),
  /** the root entity the query returns */
  entity: z.string().min(1),
  /** returned columns, in display order; paths from the root entity */
  fields: z.array(z.string().min(1)).min(1),
  filters: z.array(QueryFilter),
  joins: z.array(QueryJoin).optional(),
  distinct: z.boolean().optional(),
}).strict();

/**
 * ONE WORD THE STORY USES, AND THE CMF PATH IT WAS RESOLVED TO.
 *
 * WHY THE DESCRIPTOR RECORDS THIS AT ALL
 *   Requirement documents are written in the client's words and CMF stores
 *   properties under its own. "Storage Step" is `Step`, "Batch" is
 *   `ManufacturerLotNumber`, "Serial" is `DateCode`. That resolution is the
 *   single most frequent thing the generator has had to ask about — 18 of 19 gap
 *   reports — and until now it happened invisibly at generation time and was
 *   never written down anywhere a human could correct it.
 *
 *   So the descriptor states it. Not as a per-site field but as a VOCABULARY
 *   TABLE, because the same word means the same path wherever it appears: as a
 *   filter, as a column, as a form field. One table answers all three, and it is
 *   the same table the requirement-document template asks Athena to supply.
 *
 * `path: null` IS A REAL ANSWER, and the important one. It means the word was
 * met and could NOT be resolved from evidence — which is a gap to report, not a
 * blank to fill. A term absent from this table entirely means the model never
 * had to decide; a term here with a null path means it decided it could not.
 *
 * `why` is what makes the table reviewable. "Batch" -> `ManufacturerLotNumber`
 * is only checkable if the reader is told it came from `$(CustomBatch)` on a
 * delivered page rather than from a guess.
 */
const TermPath = z.object({
  /** the word as the requirement document writes it */
  term: z.string().min(1),
  /** the CMF property path, or null when the evidence does not settle it */
  path: z.string().min(1).nullable(),
  /** where the mapping came from, in one clause a reader can check */
  why: z.string().min(1),
}).strict();

export type TermPathSpec = z.infer<typeof TermPath>;

export const SpecDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  /** the story identifier, e.g. "455386" */
  userStory: z.string().min(1),
  /** the story's own title, where it has one */
  title: z.string().min(1).optional(),
  /**
   * Every spec word resolved to a CMF path, with the evidence for each.
   *
   * Optional so every descriptor written before 2026-08-28 still parses, and
   * because a story that uses CMF's own words needs no table at all. When the
   * model DOES resolve a word it must record it here — see EXTRACT_PROMPT.md.
   */
  termPaths: z.array(TermPath).optional(),
  /** every page the story asks for, in the order it names them */
  pages: z.array(PageSpec).min(1),
  /** story-level deliverables, not owned by any one page — NAMES only */
  queries: z.array(z.string().min(1)),
  api: z.array(z.string().min(1)),
  /**
   * Structure for the queries we are able to build. Optional and may cover only
   * some of `queries` — a named-but-undefined query is a gap, not an error.
   */
  queryDefinitions: z.array(QueryDefinition).optional(),
  /** anything the story left ambiguous — carried into the gap report */
  notes: z.array(z.string().min(1)).optional(),
}).strict().superRefine((d, ctx) => {
  const seen = new Set<string>();
  d.pages.forEach((p, i) => {
    if (seen.has(p.name)) {
      ctx.addIssue({
        code: "custom", path: ["pages", i],
        message: `duplicate page name ${JSON.stringify(p.name)}`,
      });
    }
    seen.add(p.name);
  });
});

export type SpecDescriptor = z.infer<typeof SpecDescriptorSchema>;
export type PageSpecType = SpecDescriptor["pages"][number];
export type QueryDefinitionType = z.infer<typeof QueryDefinition>;
export type QueryFilterType = z.infer<typeof QueryFilter>;

/** The structure for a named query, when the descriptor carries one. */
export function queryDefinitionFor(
  d: SpecDescriptor, name: string,
): QueryDefinitionType | undefined {
  return (d.queryDefinitions ?? []).find((q) => q.name === name);
}

/**
 * A page spec with the story-level query list attached. Queries are declared
 * once per story, not per page, so the caller composes this before validating.
 */
export type EffectiveSpec = PageSpecType & {
  queries: readonly string[];
  /**
   * True when this page did not state its own `queries` and a MULTI-PAGE story's
   * list was inherited — so the list is an assumption, not a requirement.
   *
   * See `effectiveSpec` for why that distinction has to travel with the spec.
   */
  queriesInherited: boolean;
  /**
   * The story-level term-to-path table, carried onto the page spec.
   *
   * A vocabulary fact is not page-scoped, but the validator is handed a page
   * spec and nothing else, so it travels here for the same reason `queries`
   * does. Empty when the descriptor declares none.
   */
  termPaths: readonly TermPathSpec[];
};
export type GridSpec = PageSpecType["grids"][number];
export type FilterPanelSpec = z.infer<typeof FilterPanel>;
export type ColumnSpec = GridSpec["columns"][number];
export type ActionButtonSpec = PageSpecType["actionButtons"][number];

/**
 * The page entry an artifact should be graded against. Returns undefined when the
 * story does not describe a page of that name — which is itself a finding, not an
 * error to swallow.
 */
export function pageFor(d: SpecDescriptor, pageName: string): PageSpecType | undefined {
  return d.pages.find((p) => p.name === pageName);
}

/**
 * Compose the spec a page is graded against.
 *
 * THE SINGLE PLACE the story-level/page-level query fallback is decided. Three
 * call sites used to spell `{...page, queries: d.queries}` out by hand, which is
 * how the two levels got conflated in the first place. Mirrored by
 * `effective_spec()` in _working/scripts/descriptor.py — keep them together.
 */
export function effectiveSpec(d: SpecDescriptor, page: PageSpecType): EffectiveSpec {
  const own = page.queries !== undefined;
  /*
   * INHERITING A MULTI-PAGE STORY'S QUERY LIST IS A GUESS, AND IS MARKED AS ONE.
   *
   * The fallback below is deliberate and stays: a single-page descriptor written
   * before `pages[].queries` existed must grade exactly as it always did.
   *
   * But the same fallback recurred as a defect the first time a WIZARD was built
   * through the web app (2026-08-28). The model stated `queries: [...]` on the
   * management page and omitted it on the wizard; the wizard inherited all three
   * of the page's queries and failed `spec queries wired` for every one. Athena's
   * own wizard declares no data source at all, so the artifact was right and the
   * grading was wrong — and FAIL is what feeds the regeneration loop, so a second
   * attempt would have been pushed into wiring three data sources to nothing.
   *
   * THE SOFTENING IS STRUCTURAL, NOT BLANKET — and the first attempt was blanket,
   * which broke a gate immediately and deserved to. Round 5's replay of the
   * MANAGEMENT page carries a genuine unwired-query defect, and "the page did not
   * state its list" softened that to a WARN too. Wrong: that page has two grids,
   * and a grid is the thing a QueryDataSource feeds.
   *
   * So the flag asks what the page is MADE OF. A page with no grid and no filter
   * consumes no query — that is Athena's wizard exactly, one Form and nothing
   * else. A page with either keeps its FAIL, because for it the inherited list is
   * not a guess but the obvious reading.
   *
   * With ONE page, "omitted" can only mean the story's list, so nothing is
   * flagged there at all and every pre-existing descriptor grades as before.
   */
  const consumesNothing = page.grids.length === 0 && (page.filters?.length ?? 0) === 0;
  const inherited = !own && d.pages.length > 1 && (d.queries?.length ?? 0) > 0
    && consumesNothing;

  return { ...page, queries: page.queries ?? d.queries ?? [], queriesInherited: inherited,
           termPaths: d.termPaths ?? [] };
}

/**
 * The key a grid is matched on. Defined here, in one place, because the whole
 * point of the descriptor is that grids stop being matched by position.
 */
export function gridKey(g: { entity: string; role?: string | undefined }): string {
  return g.role ? `${g.entity}:${g.role}` : g.entity;
}

export class DescriptorError extends Error {
  readonly issues: string[];
  constructor(source: string, issues: string[]) {
    super(`invalid spec descriptor (${source}):\n  - ${issues.join("\n  - ")}` +
          DescriptorError.hint(issues));
    this.name = "DescriptorError";
    this.issues = issues;
  }

  /**
   * A story with no UI in it fails as `pages.0.name: Too small`, which is true
   * and tells the reader nothing (T-24). Backend-only stories are common in this
   * client's backlog — SAP confirmations, IoT, consolidation logic — so the
   * commonest reason for this error deserves to be named.
   */
  private static hint(issues: string[]): string {
    const noPage = issues.some((i) => /^pages(\.\d+)?\.(name|uiType)\b|^pages:/.test(i));
    if (!noPage) return "";
    return "\n\nThe usual cause is a story that does not describe a UI screen at all — " +
           "a backend, integration or logic story. This generator produces UI Page " +
           "artifacts, so such a story has nothing for it to build. If the story does " +
           "describe a screen, it did not name it clearly enough to extract.";
  }
}

/** Parse and validate. Reports EVERY problem at once, not just the first. */
export function parseDescriptor(data: unknown, source = "<inline>"): SpecDescriptor {
  const result = SpecDescriptorSchema.safeParse(data);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => {
    const where = i.path.length ? i.path.join(".") : "(root)";
    return `${where}: ${i.message}`;
  });
  throw new DescriptorError(source, issues);
}

export function loadDescriptor(path: string): SpecDescriptor {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new DescriptorError(path, ["file could not be read"]);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new DescriptorError(path, [`not valid JSON: ${e instanceof Error ? e.message : e}`]);
  }
  return parseDescriptor(data, path);
}
