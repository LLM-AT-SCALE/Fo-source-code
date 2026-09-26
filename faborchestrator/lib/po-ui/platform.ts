/**
 * PLATFORM CONSTANTS — facts about CMF itself.
 *
 * Everything here is a property of the platform, not of any user story, client or
 * tenant. These are the only values in the codebase that are legitimately fixed:
 * a second user story does not change them, and a different client does not either.
 *
 * WHAT DOES **NOT** BELONG HERE
 *   - anything from a user story (column names, button names, query names)
 *       -> the spec descriptor
 *   - client conventions (the `Custom` prefix, `\Dashboards`, `Scope=General`)
 *       -> config. Those are Athena's standards; another client would differ.
 *   - vocabulary (field paths, message names, action ids)
 *       -> the dictionary, with provenance
 *
 * PROVENANCE
 *   Values marked "live" were read from a running CMF instance on 2026-08-06 and
 *   are evidenced in _working/pkg/cmf-live/EXTRACTION-FINDINGS.md. Values marked
 *   "samples" were derived from the artifacts Athena supplied. Nothing here is a
 *   guess; where we do not know a value it is absent and must be reported.
 */

/* ------------------------------------------------------------------ envelope */

export const EXPORT_ROOT = "CMF.ExportFile";
export const UIPAGE_TYPE_MARKER = "UIPage";

/** CMF version this project targets. From the supplied exports. */
export const CMF_VERSION = "10.2.0.0";

/* ------------------------------------------------------- selection semantics */

/**
 * How many rows a user may select in a grid.
 * The descriptor says "single"/"multiple"; CMF stores 1/2. This is the ONLY
 * place that translation happens.
 */
export const SELECTION_MODE = {
  none: 0,
  single: 1,
  multiple: 2,
} as const satisfies Record<string, number>;

export type SelectionName = keyof typeof SELECTION_MODE;

export function selectionModeOf(name: SelectionName): number {
  return SELECTION_MODE[name];
}

/* --------------------------------------------------------------- scalar types */

/**
 * Column/property `type` codes.
 *
 * SOURCE (2026-08-07): read directly from the CMF client bundle — the enum the
 * framework itself exports as `PfT`, in `main.js`. This is the authority, not an
 * inference. It confirmed all five codes we had derived from samples
 * (DateTime 2, Boolean 3, String 4, Integer 5, Reference 11 — CMF names the last
 * `ReferenceType`) and supplied the twenty we did not have.
 *
 * The old comment here said "There is deliberately NO entry for decimal: we have
 * never observed one." That was the right call at the time and it is now
 * resolved: **Decimal is 1.** It was the single UNKNOWN in the best measured run
 * (`ProductionOrder.Quantity`, confirmed Decimal in the live entity schema).
 *
 * (live) — see _working/pkg/cmf-live/RENDER-EXPORT-FINDINGS.md
 */
export const TYPE_CODE = {
  Long: 0,
  Decimal: 1,
  DateTime: 2,
  Boolean: 3,
  String: 4,
  Integer: 5,
  Url: 6,
  Date: 7,
  Time: 8,
  Currency: 9,
  Object: 10,
  /** CMF calls this `ReferenceType`; paired with REFERENCE_TYPE_ENTITY */
  Reference: 11,
  TimeSpan: 12,
  Color: 13,
  StateModel: 14,
  StateModelState: 15,
  Password: 16,
  HTML: 17,
  State: 18,
  JSON: 19,
  Image: 20,
  EntityType: 21,
  ScalarType: 22,
  DataGroup: 23,
  Text: 24,
  Float8: 25,
} as const satisfies Record<string, number>;

/** paired with Reference (11) */
export const REFERENCE_TYPE_ENTITY = 1;

export const COLLECTION_TYPE = { none: 0, list: 1, map: 2 } as const;

/* -------------------------------------------------------------------- UIType */

/**
 * UIType is serialised DIFFERENTLY on the two surfaces:
 *   - the XML export writes a string:  <UIType value="Page" />
 *   - the service API returns a number: UIType: 0
 *
 * The numeric mapping was established from the 66 live pages, where the naming
 * is unambiguous — every UIType 2 name ends `_Wizard`, every UIType 3 ends
 * `_Cluster`, every UIType 1 is a wizard step. (live)
 * (Recorded as "198 live pages" until 2026-08-18; the dump holds each page three
 * times — F-94. The mapping is unaffected, only the population size.)
 */
export const UI_TYPE_BY_CODE = {
  0: "Page",
  1: "Step",
  2: "Wizard",
  3: "Cluster",
} as const;

export type UiTypeName = (typeof UI_TYPE_BY_CODE)[keyof typeof UI_TYPE_BY_CODE];

export function uiTypeName(code: number | string): UiTypeName | undefined {
  return UI_TYPE_BY_CODE[String(code) as unknown as keyof typeof UI_TYPE_BY_CODE];
}

/* ------------------------------------------------- action bar (framework side) */

/**
 * Buttons CMF renders on every page whether or not the page declares them.
 * A generated page must never emit these — doing so duplicates them in the bar.
 * Established by observing a completed page run: six buttons in the bar, three in
 * `actionButtons`.
 */
export const FRAMEWORK_BUTTONS: readonly string[] = ["New", "Refresh", "Lock", "More"];

/* --------------------------------------------- action button boilerplate */

/**
 * Keys every serialised action button carries, at a value that never varies.
 *
 * MEASURED across **1,694 real buttons** — 1,015 on the 66 base-tenant pages and
 * 679 on Entegris' 27 custom pages. Each of these is present on every single one
 * at exactly this value, in both populations:
 *
 *   isPrimary          false   1015/1015 · 679/679
 *   backgroundColor    null    1015/1015 · 679/679
 *   rule               null    1015/1015 · 679/679
 *   textColor          null    1015/1015 · 679/679
 *   preventNavigation  false   every instance present
 *
 * Because they never vary, they are ours to write — the same reasoning that puts
 * `$id` and escaping in our code rather than the model's. Asking a model to
 * remember five invariant keys on every button is five chances to forget one.
 *
 * Keys that DO vary stay with the model: `executionType` (0 in 987/990 and
 * 670/679, but 2 exists), `autoRefresh` (~80% false), `requiredFunctionality`,
 * and the caption and icon.
 */
export const ACTION_BUTTON_DEFAULTS: Readonly<Record<string, unknown>> = {
  isPrimary: false,
  backgroundColor: null,
  rule: null,
  textColor: null,
  preventNavigation: false,
};

/**
 * `actionButtonId` equals `actionId` on 784 of 857 base-tenant buttons and 547 of
 * 572 Entegris ones — ~93% in both. Athena's own page follows it for Hold and
 * Release, and departs for the two custom actions
 * (`Custom.ChangePriorityAction` -> `…ActionButton`).
 *
 * So it is a default worth applying when the model did not supply one, and never
 * an override when it did.
 */
export const ACTION_BUTTON_ID_FOLLOWS_ACTION_ID = true;

/**
 * Keys CMF always serialises whose value is dominant rather than invariant.
 *
 *   executionType  0 (Action)  987/990 base-tenant · 670/679 Entegris  = 99.7% / 98.7%
 *   autoRefresh    false       784/1015 · 585/679                      = ~80%
 *
 * Separated from ACTION_BUTTON_DEFAULTS because the distinction is real: those
 * never vary, these usually do not. Both are filled and both are overridable, but
 * a reader should know which is a fact and which is a bet.
 *
 * They are filled at all because **absent is not a decision** — CMF writes these
 * on every button, so omitting them produces an artifact CMF would not have
 * written. `executionType: 0` holds even for a button that opens a page: Athena's
 * Change Priority opens a wizard and is still 0.
 */
export const ACTION_BUTTON_CONVENTIONS: Readonly<Record<string, unknown>> = {
  executionType: 0,
  autoRefresh: false,
};

/* ------------------------------------------------- ambient data sources */

/**
 * Data-source components that are legitimately declared without any link.
 *
 * Most data sources are wired: something drives them, and something reads what
 * they return. `SystemDataSource` is not — it supplies ambient tenant/system
 * context that widgets read directly, so it appears in `dataSources[]` and in no
 * link at all.
 *
 * MEASURED, not assumed: across the 66 distinct base-tenant pages, **5 of 5**
 * `SystemDataSource` declarations are referenced by no link — 100%, never once
 * wired. Every other data-source class is orphaned in only 4 of 138 cases. A
 * check that did not exempt this one would fire on every page that uses it and
 * teach a reader to ignore the warning.
 *
 * Same shape of fact as FRAMEWORK_BUTTONS above: a thing the platform treats
 * specially, which a generated page must not be judged against.
 */
export const AMBIENT_DATA_SOURCES: readonly string[] = ["SystemDataSource"];

/**
 * The settings keys under which a widget HOSTS another whole widget.
 *
 * A `Filter` wraps the widget it filters: the inner widget is declared in
 * `widgets[]` with its own id AND serialised in place under one of these keys.
 * It is drawn by its host, so it deliberately carries no layout placement of its
 * own — which is why `checkLayoutPlacement` has to know these key names, or it
 * rejects the client's own delivered pages (measured: 8 of 8 delivered Filters
 * host an inner widget).
 *
 * A PLATFORM FACT, so it lives here rather than in the three places that need
 * it. It is how CMF serialises a composed widget, not a choice any client made —
 * the same shape of fact as FRAMEWORK_BUTTONS and AMBIENT_DATA_SOURCES above.
 * Mirrored by INNER_WIDGET_KEYS in platform_cmf.py, which validate.py reads.
 */
export const INNER_WIDGET_KEYS: readonly string[] = ["widgetModel", "leftWidgetModel"];

/**
 * The marker that says "this label has NO evidenced message name".
 *
 * `$(UNKNOWN_StorageStep)` is not a message name. It is this tool telling the
 * reader that the story asked for a label and the vocabulary does not carry one,
 * in a form that cannot be mistaken for a real reference — which a plausible
 * invented name like `$(CustomStorageStepLabel)` absolutely can be (Rule 2).
 *
 * ONE PLACE, because two things depend on agreeing about it: the generator emits
 * it, and the master-data writer must NOT declare it as a localized message to
 * import. Declaring a placeholder would create vocabulary nobody asked for in
 * the client's tenant — the exact harm that made a previous edit soften Rule 2
 * toward plain text, which then collided with `checkLabels` and cost a run three
 * attempts. Fixing the harm at its source is what lets the rule be stated once.
 */
export const UNKNOWN_LABEL_PREFIX = "UNKNOWN_";

/** Is this `$(...)` reference our own placeholder rather than a real message? */
export function isPlaceholderMessage(name: string): boolean {
  return name.startsWith(UNKNOWN_LABEL_PREFIX);
}

/* ------------------------------------------------- the service-call envelope */

/**
 * The fields a `ServiceCallDataSource`'s input object carries besides the ones
 * the service is actually about — and the RATE at which each appears.
 *
 * MEASURED across **120 live service calls on 198 base-tenant pages**
 * (2026-08-27, read-only). The counts are the finding, and they are the reason
 * this is a list of frequencies rather than a shape to emit:
 *
 * **No field appears in all 120.** The envelope is a strong CONVENTION, not a
 * contract. Athena's own `CustomUpdateMaterialsPriority` carries `OperationTarget`
 * and `ExtraParameters` and *omits* `IsNewDefinition`, which is exactly the
 * variation these counts predict.
 *
 * SO THIS IS EVIDENCE, NOT A TEMPLATE. A generator that synthesised "the standard
 * envelope" from it would produce a contract no service actually has — which is
 * why `SERVICES.json` records each service's port list WHOLE, transcribed, and
 * why a service absent from that asset is a gap rather than something to compose
 * (F-172). These counts exist so a reader can tell an unusual envelope from a
 * wrong one.
 */
export const SERVICE_ENVELOPE_FIELDS: ReadonlyArray<{
  field: string;
  /** how many of the 120 live service calls carry it */
  seenIn: number;
  of: number;
}> = [
  { field: "PageNumber", seenIn: 117, of: 120 },
  { field: "PageSize", seenIn: 117, of: 120 },
  { field: "IgnoreLastServiceId", seenIn: 114, of: 120 },
  { field: "NumberOfRetries", seenIn: 114, of: 120 },
  { field: "OperationAttributes", seenIn: 114, of: 120 },
  { field: "ServiceComments", seenIn: 114, of: 120 },
  { field: "IsNewDefinition", seenIn: 99, of: 120 },
];

/** Is this input port envelope plumbing rather than something the service is about? */
export function isEnvelopeField(name: string): boolean {
  return SERVICE_ENVELOPE_FIELDS.some((f) => f.field === name);
}

/* -------------------------------------------------------------- $id numbering */

/**
 * `$id` is a pre-order, document-order counter over every JSON object. Arrays are
 * not counted. Root is "1". Contiguous, no gaps, no duplicates. Verified 227/227
 * on the reference page and reproduced by every generated round since.
 */
export const ID_ROOT = "1";

/* ------------------------------------------------- hosted-widget ports */

/**
 * A port name with the hosted-widget prefix removed.
 *
 * A Filter widget HOSTS the grid it narrows, and CMF then exposes the inner
 * widget's ports through the host with an `inner$` prefix: `inner$data`,
 * `inner$selectedChange`, `inner$loading`. Semantically these are the same
 * ports — the difference is who owns the widget, not what the link means.
 *
 * MEASURED across the 39 delivered pages: **12 use an `inner$` port**, and
 * `inner$selectedChange` is the MOST COMMON selection output of all —
 *
 *     inner$selectedChange  41      inner$data     30
 *     selectedChange        14      data           43
 *
 * This matters because every relational check compares port names. Matching
 * `"data"` exactly made those checks silently NOT RUN on a Filter-hosted page,
 * which is worse than a wrong answer: the run reports PASS because nothing was
 * examined. Found 2026-09-09 on the first US-1122 page driven through the
 * corrected pipeline — the column-coverage and reference-column checks produced
 * no findings at all, on a page that genuinely had one.
 */
export function basePort(port: string): string {
  return port.startsWith("inner$") ? port.slice("inner$".length) : port;
}

/**
 * The widget that actually carries the columns behind a link's target.
 *
 * A Filter widget HOSTS the grid it narrows, keeping the hosted copy under
 * `widgetModel` (see `INNER_WIDGET_KEYS`). A `dataChange -> inner$data` link
 * therefore targets the FILTER, and the columns live one level in.
 *
 * Found 2026-09-09 alongside `basePort`, and it is the same defect twice: the
 * first US-1122 page driven through the corrected pipeline produced NO column
 * findings at all, because the check looked up the link's target, found a Filter
 * with no `columns`, and quietly moved on. A check that examines nothing reports
 * PASS, which is the worst way to be wrong.
 */
export function widgetBehind(target: unknown): unknown {
  if (!target || typeof target !== "object") return target;
  const s = (target as { settings?: Record<string, unknown> }).settings;
  if (!s) return target;
  if (Array.isArray((s as { columns?: unknown }).columns)) return target;
  for (const key of INNER_WIDGET_KEYS) {
    const held = s[key];
    if (held && typeof held === "object" && !Array.isArray(held)) return held;
  }
  return target;
}
