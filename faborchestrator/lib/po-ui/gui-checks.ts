/**
 * VALIDATOR — a generated page against Athena's own GUI-test selectors.  (A-54)
 *
 * WHY THIS EXISTS
 *   Their Selenium suite drives the pages we generate, and its selectors pin down
 *   values the requirement document never mentions: the Materials grid's
 *   `settings.name` must be exactly `ProductionOrder Materials`, the Hold button's
 *   `actionButtonId` must be exactly `Material.Hold` (F-116). A page correct on
 *   every column, path, type and link still FAILS their suite if it misses one.
 *
 *   A document states intent and can be read two ways — that ambiguity is the
 *   whole of Q-01. A test executes. Where their suite constrains a value, that
 *   value is not a matter of interpretation, and it is checkable by us OFFLINE:
 *   the selectors are strings in files we hold. No browser, no login, no CMF.
 *
 *   Same discipline as the Python oracle and "every rule must accept their real
 *   exports": an external authority, mechanically enforced, on every run.
 *
 * TYPESCRIPT-ONLY BY DESIGN, like query-checks.ts.
 *   checks.ts is a literal port of validate.py so the two can be diffed line for
 *   line, and the oracle gate proves they agree. There is no Python original for
 *   this, so a mirror would be duplicated effort with nothing to prove — and
 *   adding it to checks.ts instead would break the parity the oracle exists to
 *   hold. It reports separately for exactly that reason.
 *
 * THE SEVERITY SPLIT IS MEASURED, NOT CHOSEN — see `severityOf` below.
 */
import { existsSync, readFileSync } from "node:fs";
import { FRAMEWORK_BUTTONS } from "./platform";
import type { Level, PageSettings, Result } from "./types";

/* ------------------------------------------------------------ the library */

/**
 * What a selector pins down in a page artifact.
 *
 *   widget  `div[data-widget-name='X']`  -> a widget whose settings.name is X
 *   button  `[button-id='X']`            -> an action button whose actionButtonId is X
 *   label   `[data-label='X']`           -> a form field whose label RENDERS as X
 *   title   `[title='X']`                -> a caption or column header that RENDERS as X
 */
export type SelectorKind = "widget" | "button" | "label" | "title";

export interface Selector {
  kind: SelectorKind;
  value: string;
  line: number;
}

export interface SelectorScope {
  name: string;
  file: string;
  pageHint: string | null;
  attributedVia?: string;
  selectors: Selector[];
}

export interface SelectorLibrary {
  source: string;
  filesScanned: number;
  scopes: SelectorScope[];
  skipped: Array<{ file: string; line: number; reason: string; text: string }>;
}

export interface MessageTextAsset {
  culture: string;
  count: number;
  text: Record<string, string>;
}

export class GuiCheckError extends Error {}

export function loadSelectorLibrary(path: string): SelectorLibrary {
  if (!existsSync(path)) {
    throw new GuiCheckError(
      `GUI selector library not found at ${path}. Generate it with ` +
      `\`node scripts/extract-selectors.ts\`; without it their acceptance ` +
      `criteria are not checked at all.`,
    );
  }
  return JSON.parse(readFileSync(path, "utf-8")) as SelectorLibrary;
}

export function loadMessageText(path: string): MessageTextAsset {
  if (!existsSync(path)) {
    throw new GuiCheckError(
      `message-text asset not found at ${path}. Generate it with ` +
      `\`node scripts/extract-message-text.ts\`.`,
    );
  }
  return JSON.parse(readFileSync(path, "utf-8")) as MessageTextAsset;
}

/**
 * Scopes whose selectors describe this page.
 *
 * EXACT name match only. A scope whose `pageHint` is null is not matched to a
 * page by resemblance — grading a page against another page's contract would be
 * worse than not grading it, and "no test covers this page" is the honest and
 * common answer: 7 of their 9 selector scopes describe artifacts that are not UI
 * Pages at all (the Operator UI Angular component, F-109) or that we hold no
 * page name for.
 */
export function scopesFor(lib: SelectorLibrary, pageName: string): SelectorScope[] {
  return lib.scopes.filter((s) => s.pageHint === pageName);
}

/* ------------------------------------------------------ label resolution */

/**
 * The text a `$(MessageName)` reference renders as.
 *
 * Two sources, in order of authority:
 *   1. `declared` — messages THIS run's master data introduces. Authoritative,
 *      because the run is what will create them.
 *   2. `platform` — the message table the CMF instance itself holds.
 *
 * Kept separate on purpose. Folding generated labels into the platform list is
 * precisely defect 20, which had a story finding its own labels "already
 * existing" and deploying a page with six blank column headers.
 *
 * A label that is already plain text resolves to itself — Athena's own
 * `CustomChangePriorityStep` carries plain `Priority` and `IsHot` field labels,
 * so a resolver that only understood `$(...)` would call their own artifact
 * unresolvable.
 */
export function resolveLabel(
  raw: string | null | undefined,
  platform: Readonly<Record<string, string>>,
  declared: Readonly<Record<string, string>> = {},
): { text: string | null; via: "declared" | "platform" | "literal" | "unresolved"; name?: string } {
  const s = (raw ?? "").trim();
  if (!s) return { text: null, via: "unresolved" };
  const m = s.match(/^\$\((\w+)\)$/);
  if (!m) return { text: s, via: "literal" };
  const name = m[1] as string;
  if (name in declared) return { text: declared[name] as string, via: "declared", name };
  if (name in platform) return { text: platform[name] as string, via: "platform", name };
  return { text: null, via: "unresolved", name };
}

/* ------------------------------------------------------------- the anchors */

/** every widget's internal name — what `data-widget-name` renders from */
function widgetNames(j: PageSettings): string[] {
  return (j.widgets ?? [])
    .map((w) => (w.settings?.name ?? "").trim())
    .filter((n) => n !== "");
}

/**
 * every action button's `actionButtonId` — what `button-id` renders from.
 *
 * Read from the raw settings object rather than the typed `ActionButton` shape:
 * `actionButtonId` is boilerplate our own code fills (A-27), and types.ts models
 * only what the older checks read.
 */
function buttonIds(j: PageSettings): string[] {
  return (j.actionButtons ?? [])
    .map((b) => String((b.settings as Record<string, unknown> | null | undefined)?.["actionButtonId"] ?? "").trim())
    .filter((v) => v !== "");
}

interface Rendered { text: string; where: string }

/** every form-field label on the page, rendered */
function fieldLabels(
  j: PageSettings, platform: Readonly<Record<string, string>>,
  declared: Readonly<Record<string, string>>,
): { rendered: Rendered[]; unresolved: string[] } {
  const rendered: Rendered[] = [];
  const unresolved: string[] = [];
  for (const w of j.widgets ?? []) {
    const where = w.settings?.name || w.name || "(unnamed widget)";
    for (const f of w.settings?.fields ?? []) {
      const raw = f.property?.label;
      if (!raw) continue;
      const r = resolveLabel(raw, platform, declared);
      if (r.text === null) unresolved.push(r.name ?? String(raw));
      else rendered.push({ text: r.text, where });
    }
  }
  return { rendered, unresolved };
}

/**
 * everything that renders into a `title` attribute: button captions and column
 * headers. Both appear in their suite — `[title='Change Priority']` is a button,
 * `[title='Comments']` a column header.
 */
function titles(
  j: PageSettings, platform: Readonly<Record<string, string>>,
  declared: Readonly<Record<string, string>>,
): { rendered: Rendered[]; unresolved: string[] } {
  const rendered: Rendered[] = [];
  const unresolved: string[] = [];
  const take = (raw: unknown, where: string): void => {
    if (typeof raw !== "string" || !raw) return;
    const r = resolveLabel(raw, platform, declared);
    if (r.text === null) unresolved.push(r.name ?? raw);
    else rendered.push({ text: r.text, where });
  };
  for (const b of j.actionButtons ?? []) {
    take(b.settings?.buttonTitle, `button ${b.settings?.name ?? "?"}`);
  }
  for (const w of j.widgets ?? []) {
    const where = w.settings?.name || w.name || "(unnamed widget)";
    for (const c of w.settings?.columns ?? []) take(c.name, `column on ${where}`);
  }
  return { rendered, unresolved };
}

/* ------------------------------------------------------------- severity */

/**
 * How loudly a missed selector is reported — MEASURED against the artifact
 * Athena themselves delivered, not chosen for comfort.
 *
 * Run the seven selectors of their `CustomProductionOrderManagementUIPage` scope
 * against their own `300_CustomProductionOrderManagementUI.xml`:
 *
 *   widget / button   4 of 4 satisfied     -> FAIL on a miss
 *   label / title     2 of 3 satisfied     -> WARN on a miss
 *
 * The one text selector their own page does not satisfy is `[title='Comments']`,
 * and it is not a defect in their page: the property is named `HistoryComments`
 * and it targets CMF's stock history view, which the page never declares. Their
 * `[title='Refresh']` selectors are the same shape — the framework supplies that
 * button on every page (Rule 4), so no page declares it either.
 *
 * So a text selector can legitimately target chrome no artifact contains, and
 * FAILing on one would reject the file the authority produced — the identical
 * trap that caught the query validator's contiguity assumption (F-89) and forced
 * checkDataSourceUse down to WARN (F-92). Structural selectors carry no such
 * escape: a widget name and a button id exist only where the page puts them.
 *
 * WARN also keeps text selectors out of the regeneration loop, where only FAIL
 * feeds back. Pushing a model to make a label render as "Comments" would invite
 * it to invent a message name, which is the outcome this project exists to avoid.
 */
export function severityOf(kind: SelectorKind): Level {
  return kind === "widget" || kind === "button" ? "FAIL" : "WARN";
}

/* --------------------------------------------------------------- the check */

export interface GuiReport {
  results: Result[];
  counts: Record<Level, number>;
  ok: boolean;
  /** scopes that were checked; empty means no GUI test covers this page */
  scopes: string[];
  /** selectors examined */
  checked: number;
}

export interface GuiCheckOptions {
  settings: PageSettings;
  /** the page being graded — decides which scopes apply */
  pageName: string;
  library: SelectorLibrary;
  /** platform message text, from MESSAGE-TEXT.json */
  platform?: Readonly<Record<string, string>>;
  /** message text this run's master data declares, name -> text */
  declared?: Readonly<Record<string, string>>;
}

export function validateSelectors(opts: GuiCheckOptions): GuiReport {
  const { settings: j, pageName, library } = opts;
  const platform = opts.platform ?? {};
  const declared = opts.declared ?? {};
  const results: Result[] = [];

  const scopes = scopesFor(library, pageName);
  if (scopes.length === 0) {
    // Not a finding. Most pages have no GUI test, and inventing one would be
    // worse than saying so.
    results.push({
      level: "PASS", name: "GUI-test selectors",
      detail: `no test scope names ${pageName} — nothing to check`,
    });
    return { results, counts: tally(results), ok: true, scopes: [], checked: 0 };
  }

  const names = new Set(widgetNames(j));
  const ids = new Set(buttonIds(j));
  const labels = fieldLabels(j, platform, declared);
  const caps = titles(j, platform, declared);
  const labelSet = new Set(labels.rendered.map((r) => r.text));
  const titleSet = new Set(caps.rendered.map((r) => r.text));

  let checked = 0;
  for (const scope of scopes) {
    for (const sel of scope.selectors) {
      checked += 1;
      const where = `${sel.kind} '${sel.value}'`;

      // The framework renders New/Refresh/Lock/More on every page whether or not
      // the page declares them, and Rule 4 forbids declaring them. A selector on
      // one is satisfied by the platform, so reporting it as missing would be
      // reporting the rule working.
      if (sel.kind === "title" && FRAMEWORK_BUTTONS.includes(sel.value)) {
        results.push({
          level: "PASS", name: `selector ${where}`,
          detail: "framework button — CMF renders it; the page must not declare it (Rule 4)",
        });
        continue;
      }

      let hit = false;
      let detail = "";
      switch (sel.kind) {
        case "widget":
          hit = names.has(sel.value);
          detail = hit ? "widgets[].settings.name" : `page has: ${list([...names])}`;
          break;
        case "button":
          hit = ids.has(sel.value);
          detail = hit
            ? "actionButtons[].settings.actionButtonId"
            : ids.size
              ? `page has: ${list([...ids])}`
              : "no action button carries an actionButtonId";
          break;
        case "label":
          hit = labelSet.has(sel.value);
          detail = hit ? "form field label" : renderedDetail(labels, "field label");
          break;
        case "title":
          hit = titleSet.has(sel.value);
          detail = hit ? "button caption or column header" : renderedDetail(caps, "caption/header");
          break;
      }

      results.push(
        hit
          ? { level: "PASS", name: `selector ${where}`, detail }
          : { level: severityOf(sel.kind), name: `selector ${where} not satisfied`, detail },
      );
    }
  }

  // Unresolvable labels are stated rather than swallowed: a text selector that
  // "missed" because we could not resolve the reference is a different fact from
  // one that missed because the page says something else, and a reader must be
  // able to tell them apart.
  const unresolved = [...new Set([...labels.unresolved, ...caps.unresolved])];
  if (unresolved.length) {
    results.push({
      level: "WARN", name: "message references we could not resolve to text",
      detail:
        `${unresolved.length} not in the platform table or this run's master data: ` +
        `${list(unresolved)} — text selectors cannot be judged against them`,
    });
  }

  const counts = tally(results);
  return {
    results, counts, ok: counts.FAIL === 0,
    scopes: scopes.map((s) => s.name), checked,
  };
}

function renderedDetail(r: { rendered: Rendered[] }, what: string): string {
  return r.rendered.length
    ? `page renders ${what}s: ${list(r.rendered.map((x) => x.text))}`
    : `page renders no ${what}`;
}

const list = (v: readonly string[]): string =>
  v.slice(0, 8).map((x) => JSON.stringify(x)).join(", ") + (v.length > 8 ? ", …" : "");

function tally(results: readonly Result[]): Record<Level, number> {
  const counts: Record<Level, number> = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const r of results) counts[r.level] += 1;
  return counts;
}

/** Message name -> text, from a master-data document this run produced. */
export function declaredTextIn(doc: Record<string, unknown>): Record<string, string> {
  const section = doc["<SM>LocalizedMessageKey"] as Record<string, Record<string, string>> | undefined;
  const out: Record<string, string> = {};
  for (const entry of Object.values(section ?? {})) {
    if (entry?.Name) out[entry.Name] = entry.Description ?? "";
  }
  return out;
}

/* ----------------------------------------------------- telling the generator */

/**
 * The constraints Athena's suite places on THIS page, as a prompt section.  (A-53)
 *
 * WHY THIS RATHER THAN A NAMING CONVENTION
 *   A-53 proposed stating a convention in SYSTEM_PROMPT.md: their two grids are
 *   `ProductionOrder` and `ProductionOrder Materials`, so "entity, then entity and
 *   role". **Measured across all 36 exported pages in MES_CORE, that rule explains
 *   2 of 18 grids.** The actual distribution is `Grid` x9 — the builder's own
 *   default — plus `$(CustomHeaderBinInventory)` and `$(CustomTerminatedMaterials)`
 *   (message references used as widget names), `Materials` x2, one empty, and the
 *   two the rule was drawn from.
 *
 *   So there is no convention to state. Writing one would teach the model a rule
 *   their own corpus contradicts sixteen times out of eighteen, and it would
 *   misname grids on every story that has no test to correct it — the same shape
 *   of error as the `Action` -> `ActionButton` hypothesis that explained 0.1% of
 *   1,429 real pairs (F-115).
 *
 *   What IS true is narrower and much stronger: **where a page already has a GUI
 *   test, the values that test selects on are a contract.** That is not a
 *   convention to generalise, it is an input to supply — so we supply it, per
 *   page, from the extracted asset. Nothing is hardcoded: a page with no scope
 *   gets no section, and a page Athena writes a new test for is covered the day
 *   the asset is regenerated.
 *
 * GOES IN THE USER MESSAGE, NOT THE CACHED PACKAGE. It varies per page, and the
 * package's single cache breakpoint requires everything before it to be static.
 */
export function selectorBrief(
  lib: SelectorLibrary, pageName: string, client = "the client",
): string {
  const scopes = scopesFor(lib, pageName);
  if (scopes.length === 0) return "";

  const all = scopes.flatMap((s) => s.selectors);
  const of = (k: SelectorKind): string[] =>
    [...new Set(all.filter((s) => s.kind === k).map((s) => s.value))].sort();

  const widgets = of("widget");
  const buttons = of("button");
  const texts = [...of("label"), ...of("title")]
    .filter((v) => !FRAMEWORK_BUTTONS.includes(v));

  const s: string[] = [];
  s.push(`## Values ${client}'s automated test suite requires on this page`);
  s.push("");
  s.push("Their Selenium suite drives this page and selects elements by these exact");
  s.push("strings. A page that is right on every column, path, type and link still fails");
  s.push("their suite if one of these is different, so treat them as given rather than as");
  s.push("choices. They come from their test files, not from the requirement document.");
  s.push("");
  if (widgets.length) {
    s.push("**Widget `settings.name` — must match exactly:**");
    s.push("");
    for (const v of widgets) s.push(`- \`${v}\``);
    s.push("");
    s.push("Use these names for the widgets they describe. If the page needs a widget they");
    s.push("do not name, name that one as you see fit and say so in the gap report.");
    s.push("");
  }
  if (buttons.length) {
    s.push("**Action button `actionButtonId` — must match exactly:**");
    s.push("");
    for (const v of buttons) s.push(`- \`${v}\``);
    s.push("");
  }
  if (texts.length) {
    s.push("**Text that must RENDER on screen** (a label or caption). These are the resolved");
    s.push("values of `$(MessageName)` references, so choose message names whose text is");
    s.push("this — do not write the text itself, Rule 2 still applies:");
    s.push("");
    for (const v of texts) s.push(`- "${v}"`);
    s.push("");
  }
  s.push("Some of these may belong to a different artifact in the same story (a wizard or");
  s.push("step page). Satisfy the ones this page owns; do not invent a widget to host one.");
  return s.join("\n");
}

/** One line per selector, for a run log. */
export function formatGuiReport(report: GuiReport): string[] {
  const MARK: Record<Level, string> = { FAIL: "[FAIL]", WARN: "[WARN]", PASS: "[ ok ]" };
  const lines: string[] = [];
  const { PASS, WARN, FAIL } = report.counts;
  lines.push(
    report.scopes.length
      ? `  GUI-test selectors (${report.scopes.join(", ")}): ` +
        `${report.checked} checked — PASS ${PASS} WARN ${WARN} FAIL ${FAIL}`
      : "  GUI-test selectors: no test scope covers this page",
  );
  for (const r of report.results) {
    if (r.level === "PASS" && report.counts.FAIL === 0 && report.counts.WARN === 0) continue;
    lines.push(`      ${MARK[r.level]} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  return lines;
}

/* ------------------------------------------------- registered action ids (T-31) */

export interface RegisteredAction {
  actionId: string;
  actionButtonId: string;
  title?: string;
  iconClass?: string;
  hasHandler: boolean;
}

export function loadActionLibrary(path: string): RegisteredAction[] {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as { actions?: RegisteredAction[] };
  return raw.actions ?? [];
}

/**
 * The client's registered custom actions, as data for the model (T-31).
 *
 * WHY THIS IS SUPPLIED RATHER THAN LEFT TO JUDGEMENT
 *   An `actionId` cannot be derived from a button's name. Their own registry holds
 *   `Custom.ChangePriorityAction` beside `CustomActionTransfer.Id` beside
 *   `Material.Rework` — three shapes, no rule. A guessed id produces a button that
 *   renders and does nothing when clicked, which is the silent-wrongness this
 *   project treats as the worst outcome.
 *
 *   Measured: these 22 registrations agree with **7 of 7** custom action ids used
 *   across the 30 delivered pages, with zero disagreements. And `CustomAction.Id`
 *   — which we emitted as UNKNOWN on US-455387 — is in here, with its button id,
 *   title and icon.
 *
 * PLATFORM actions are excluded. `Material.Hold` and friends come from CMF itself
 * and are already covered by DICTIONARY.md and the GUI selectors; repeating them
 * would spend prompt budget on what is already stated.
 */
export function actionIdBrief(actions: readonly RegisteredAction[], client = "the client"): string {
  const custom = actions.filter((a) => a.actionId.startsWith("Custom"));
  if (!custom.length) return "";
  const lines = custom.map((a) => {
    const bits = [`\`actionId: "${a.actionId}"\``, `\`actionButtonId: "${a.actionButtonId}"\``];
    if (a.title) bits.push(`caption "${a.title}"`);
    if (a.iconClass) bits.push(`\`iconClass: "${a.iconClass}"\``);
    return `- ${bits.join(" · ")}${a.hasHandler ? "  *(has a handler — it does something)*" : ""}`;
  });
  return [
    `## ${client}'s registered custom actions — use these ids, do not invent one`,
    "",
    `Read from their own front-end registration, so a button carrying one of these`,
    `will invoke something real. Where the story names an action that matches one`,
    `of these, USE the registered ids rather than emitting UNKNOWN.`,
    "",
    ...lines,
    "",
    `An action **not** in this list is still UNKNOWN — a wrong \`actionId\` gives a`,
    `button that renders and does nothing when clicked, so report it in the gap`,
    `report rather than guessing.`,
  ].join("\n");
}
