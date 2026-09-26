/**
 * PRE-VALIDATION — what we can build from evidence, and what needs the engineer.
 *
 * WHY THIS EXISTS
 *   Until now the first thing an engineer learned about their document came from
 *   the model's intake reply: prose, different every run, and unverifiable.
 *   Everything the tool actually KNOWS about the document — which columns resolve
 *   to real CMF paths, which buttons map to registered actions, which queries
 *   already exist in their delivered export — was discovered silently inside
 *   generation and surfaced afterwards, in a gap report the model writes.
 *
 *   That is backwards. The evidence exists before the conversation starts and it
 *   is deterministic. This runs it early and reports it.
 *
 * DETERMINISTIC, AND THAT IS THE POINT
 *   Not a model call. The gap report is already model-authored prose; a second
 *   opinion in the same voice would add nothing. This one is reproducible and
 *   diffable — run it twice on the same document and it says the same thing, or
 *   it is broken.
 *
 * NO NEW EVIDENCE
 *   Every check below resolves against an asset the generator already ships and
 *   already consults. This is the same resolution, run early and REPORTED rather
 *   than consumed. It cannot therefore know something generation does not, and
 *   it must never claim to.
 *
 * THE THREE STATES, AND WHY THE MIDDLE ONE CARRIES THE WEIGHT
 *   `resolved`  evidence exists, and the finding NAMES it.
 *   `assumed`   we can proceed, but it is inference — a path taken from a
 *               delivered page rather than the document, display text derived
 *               from a message name.
 *   `missing`   no evidence. Says what would close it. Never a guess.
 *
 *   A count of "22 resolved" is worthless if one of them was invented. The
 *   middle state is what stops that happening quietly, so a `resolved` finding
 *   without `evidence` is a defect and the gate treats it as one.
 */
import { existsSync, readFileSync } from "node:fs";

import type { PipelineConfig } from "./generate/config";
import { assetPath, resolvePath } from "./generate/config";
import {
  candidates, parseDictionary, resolveTerm, type DictEntry,
} from "./generate/column-brief";
import { findDeliveredPage } from "./generate/find-page";
import { findQueryDefinitions, scanQueries } from "./generate/query-read";
import { loadActionLibrary, type RegisteredAction } from "./gui-checks";
import { queryDefinitionFor, type SpecDescriptor } from "./descriptor";

export type Dimension =
  | "page" | "column" | "property" | "label"
  | "action" | "query" | "service" | "unstated";

export type State = "resolved" | "assumed" | "missing";

export interface Finding {
  dimension: Dimension;
  /** the thing being reported on, in the story's own words where possible */
  subject: string;
  state: State;
  /** what was found, or what is not known */
  detail: string;
  /** the artifact this came from. REQUIRED when `resolved`. */
  evidence?: string;
  /** what the engineer could say to settle it */
  closes?: string;
}

export interface PreValidation {
  document: string;
  counts: { resolved: number; assumed: number; missing: number };
  findings: Finding[];
}

export interface PreValidateInput {
  cfg: PipelineConfig;
  descriptor: SpecDescriptor;
  /** the requirement document's file name, for the report header */
  document: string;
}

/* ─────────────────────────── asset readers ─────────────────────────── */

const readIf = (p: string): string | undefined => {
  try { return existsSync(p) ? readFileSync(p, "utf-8") : undefined; } catch { return undefined; }
};

const asset = (cfg: PipelineConfig, key: string): string | undefined => {
  try { return readIf(assetPath(cfg, key)); } catch { return undefined; }
};

/**
 * `Entity -> property -> UI type code`, from the platform's own schema dump.
 *
 * `ENTITY-TYPES.md` lists each entity as `### Material — 192 properties` followed
 * by one line of `Name:DbType=Code` pairs. Parsed rather than pattern-matched on
 * the document, because "is this a real property of that entity" is the check
 * that caught `TrackInResource` — named in a requirement as a Material column,
 * and not a property of Material at all.
 */
export function parseEntityProperties(text: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = /^###\s+([A-Za-z][\w.]*)\s+—\s+\d+\s+properties/.exec(lines[i] ?? "");
    if (!head) continue;
    const entity = head[1]!;
    const props = new Map<string, string>();
    /* The pairs sit on the next non-empty line. Scanning forward a couple of
       lines rather than assuming adjacency: the generator has put a blank line
       there before and the parse went silently empty. */
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const body = lines[j] ?? "";
      if (!body.trim() || body.startsWith("#")) continue;
      for (const m of body.matchAll(/([A-Za-z][\w]*):([\w]+)=(\d+\*?)/g)) {
        props.set(m[1]!, m[3]!);
      }
      if (props.size) break;
    }
    if (props.size) out.set(entity, props);
  }
  return out;
}

/**
 * `label -> path`, from the columns their delivered pages actually render.
 *
 * A third source of evidence, and a necessary one: the dictionary records paths
 * their artifacts USE, the schema records what the platform HAS, and this
 * records what they CALL things. `Batch` is in none of the first two and is the
 * label on `ManufacturerLotNumber` in the third.
 *
 * Keyed on the label normalised the same way a term is — `$(CustomSerial)` and
 * `Serial` reach the same row — so the lookup cannot be more precious about
 * wording than the brief the model reads.
 */
function deliveredLabels(cfg: PipelineConfig): Map<string, { path: string; label: string }> {
  const out = new Map<string, { path: string; label: string }>();
  const raw = asset(cfg, "columnLabels");
  if (!raw) return out;
  let cols: Array<{ path?: string; label?: string }> = [];
  try { cols = (JSON.parse(raw) as { columns?: typeof cols }).columns ?? []; } catch { return out; }
  for (const c of cols) {
    if (!c.path || !c.label) continue;
    for (const key of candidates(c.label)) {
      const k = key.toLowerCase();
      if (!out.has(k)) out.set(k, { path: c.path, label: c.label });
    }
  }
  return out;
}

/** The delivered corpus roots, as absolute paths. */
function corpusRoots(cfg: PipelineConfig): string[] {
  return (cfg.querySources?.roots ?? []).map((r) => resolvePath(r));
}

/* ─────────────────────────────── checks ─────────────────────────────── */

/** Does this page already exist in what they have shipped? */
function checkPages(cfg: PipelineConfig, d: SpecDescriptor, out: Finding[]): void {
  const roots = corpusRoots(cfg);
  for (const page of d.pages) {
    const hit = roots.length ? findDeliveredPage(roots, page.name) : null;
    out.push(hit
      ? {
          dimension: "page", subject: page.name, state: "resolved",
          detail: `Existing page definition. Regenerated against the current specification.`,
          evidence: hit.path,
        }
      : {
          dimension: "page", subject: page.name, state: "assumed",
          detail: `No existing page definition. Structure derived from the ` +
                  `specification and comparable page classes.`,
        });
  }
}

/**
 * Every column and field term, against the dictionary and the schema.
 *
 * Two questions, deliberately separate. The DICTIONARY answers "what path have
 * your own artifacts used for this word" — transcription. The SCHEMA answers "is
 * that a real property of that entity" — the platform's own truth. A term can
 * resolve on the first and fail the second, and that gap is the single most
 * useful thing this report says: it is exactly the `TrackInResource` case.
 */
function checkTerms(
  cfg: PipelineConfig, d: SpecDescriptor, out: Finding[],
): void {
  const dictText = asset(cfg, "dictionary");
  const dict: ReadonlyMap<string, DictEntry> =
    dictText ? parseDictionary(dictText) : new Map();
  const schemaText = asset(cfg, "entityTypes");
  const schema = schemaText ? parseEntityProperties(schemaText) : new Map();
  const labels = deliveredLabels(cfg);

  const seen = new Set<string>();
  for (const page of d.pages) {
    for (const g of page.grids ?? []) {
      for (const c of g.columns ?? []) {
        if (seen.has(`${g.entity}.${c.name}`)) continue;
        seen.add(`${g.entity}.${c.name}`);
        termFinding(dict, schema, labels, c.name, g.entity, `${g.entity} grid`, out);
      }
    }
    for (const f of page.forms ?? []) {
      for (const x of f.fields ?? []) {
        if (seen.has(`form.${x.label}`)) continue;
        seen.add(`form.${x.label}`);
        termFinding(dict, schema, labels, x.label, undefined, "form", out);
      }
    }
    for (const fp of page.filters ?? []) {
      for (const cap of fp.fields ?? []) {
        /* Keyed on the ENTITY, not on "filter", so a column and the filter that
           narrows it are one finding rather than two identical ones. */
        if (seen.has(`${fp.entity}.${cap}`)) continue;
        seen.add(`${fp.entity}.${cap}`);
        termFinding(dict, schema, labels, cap, fp.entity, `${fp.entity} filter`, out);
      }
    }
  }
}

function termFinding(
  dict: ReadonlyMap<string, DictEntry>,
  schema: Map<string, Map<string, string>>,
  labels: ReadonlyMap<string, { path: string; label: string }>,
  term: string,
  entity: string | undefined,
  where: string,
  out: Finding[],
): void {
  /*
   * THE GLOSS IS NOT PART OF THE NAME.
   *
   * Requirement tables write a column as `Name (Production Order Name, link)`:
   * the name, then a parenthetical saying what it holds and how it renders.
   * Looking the whole string up matches nothing anywhere, and the column was
   * reported as having no data path at all — a false alarm that asks an
   * engineer to specify something the document had already said.
   *
   * Six runs of one document settled it: extraction that wrote `Name` resolved,
   * extraction that wrote `Name (Production Order Name)` did not. A verdict must
   * not turn on how the term was transcribed.
   *
   * Only the LOOKUP is normalised. `subject` keeps the document's wording so the
   * row is still the one the reader is looking for.
   */
  const looked = term.replace(/\s*\([^)]*\)\s*$/, "").trim() || term;

  const props = entity ? schema.get(entity) : undefined;
  const asProperty = looked.replace(/\s+/g, "");
  const inSchema = Boolean(props && (props.has(looked) || props.has(asProperty)));

  /* THE ENTITY'S OWN LINK COLUMN.
     A `Material` column on a Material grid resolves to `Id` — the convention on
     every delivered page, not a discrepancy. Reported as a mismatch it read as
     "Material is not a property of Material", which is true, useless, and
     alarming. */
  if (entity && asProperty.toLowerCase() === entity.toLowerCase()) {
    out.push({
      dimension: "column", subject: term, state: "resolved",
      detail: `Entity link column on ${entity}. Binds the row identifier.`,
      evidence: "the convention on your delivered pages",
    });
    return;
  }

  const entry = resolveTerm(dict, looked);
  if (!entry) {
    /* THE DICTIONARY IS NOT THE ONLY EVIDENCE. It is a transcription of what
       their artifacts have USED; the schema is the platform's own truth. A
       column absent from one and present in the other is resolved — `Name` and
       `Quantity` were both reported missing on the first document for want of
       this. */
    if (inSchema) {
      out.push({
        dimension: "column", subject: term, state: "resolved",
        detail: `Declared property \`${entity}.${asProperty}\` in the CMF schema.`,
        evidence: "the CMF schema",
      });
      return;
    }
    /* Third source: what their own pages CALL a path. `Batch` is in neither the
       dictionary nor the schema, and is the label on `ManufacturerLotNumber`. */
    const labelled = labels.get(looked.toLowerCase())
      ?? labels.get(asProperty.toLowerCase());
    if (labelled) {
      /* When the label IS the path, there is no naming difference — reporting
         "your pages label `Quantity` as Quantity" asks for an engineer's
         attention and gives them nothing to look at. */
      if (labelled.path.toLowerCase() === asProperty.toLowerCase()) {
        out.push({
          dimension: "column", subject: term, state: "resolved",
          detail: `Data path \`${labelled.path}\`. Caption matches an existing ` +
                  `rendered column.`,
          evidence: "the columns your delivered pages render",
        });
        return;
      }
      out.push({
        dimension: "column", subject: term, state: "assumed",
        detail: `Caption-to-path mapping only. \`${labelled.path}\` renders as ` +
                `"${labelled.label}"; no schema property of this name exists.`,
        evidence: "the columns your delivered pages render",
        closes: `Confirm \`${labelled.path}\` is the intended data path.`,
      });
      return;
    }

    out.push({
      dimension: "column", subject: term, state: "missing",
      detail: `No data path resolved. Term absent from delivered artifacts, the CMF ` +
              `schema and rendered column captions.`,
      closes: `Specify the CMF property this column binds to.`,
    });
    return;
  }

  /*
   * The path resolved. The second question is about the DOCUMENT'S WORD, not
   * about the path — and getting that backwards is a mistake this file already
   * made once.
   *
   * Checking whether the resolved path is a real property answers nothing: the
   * dictionary only ever yields paths their own artifacts use, so it passes
   * almost always. `TrackInResource` maps to `LastProcessedResource`, which IS a
   * property of `Material` — so that check called it resolved and said nothing.
   *
   * The useful question is whether the word the REQUIREMENT used is itself a
   * property of that entity. When it is, the schema and the document agree and
   * there is nothing to report. When it is not, their export has quietly renamed
   * something, and that is the finding: the path is usable, it came from their
   * artifact rather than from the schema, and it deserves an engineer's eye.
   */
  if (props && !inSchema) {
    out.push({
      dimension: "property", subject: term, state: "assumed",
      detail: `Not a declared property of \`${entity}\`. Mapped to \`${entry.path}\` ` +
              `per delivered page bindings; specification term and schema term diverge.`,
      evidence: "your delivered export, checked against the CMF schema",
      closes: `Confirm \`${entry.path}\` is the intended data path.`,
    });
    return;
  }

  out.push({
    dimension: "column", subject: term, state: "resolved",
    detail: `Data path \`${entry.path}\`${entry.type ? `, type ${entry.type}` : ""}.`,
    evidence: entry.files
      ? `your delivered artifacts (${entry.files} file${entry.files === 1 ? "" : "s"})`
      : "your delivered artifacts",
  });
}

/** Buttons, against the client's own front-end registration. */
function checkActions(cfg: PipelineConfig, d: SpecDescriptor, out: Finding[]): void {
  let actions: RegisteredAction[] = [];
  try { actions = loadActionLibrary(assetPath(cfg, "actionIds")); } catch { /* none */ }

  const byTitle = new Map<string, RegisteredAction>();
  for (const a of actions) if (a.title) byTitle.set(a.title.toLowerCase(), a);

  const seen = new Set<string>();
  for (const page of d.pages) {
    for (const b of page.actionButtons ?? []) {
      if (seen.has(b.name)) continue;
      seen.add(b.name);
      const hit = byTitle.get(b.name.toLowerCase());
      if (!hit) {
        out.push({
          dimension: "action", subject: b.name, state: "missing",
          detail: `No registered action id for this caption. Control would render ` +
                  `without a bound handler.`,
          closes: `Specify the registered action id.`,
        });
        continue;
      }
      /* THE HANDLER FLAG ONLY MEANS SOMETHING FOR THEIR OWN ACTIONS.
         A platform action — `Material.Hold`, `OperatorViewAction.Release` — has
         no custom handler to find and never will; the platform implements it.
         Flagging those reported three non-issues on the first document and
         would have sent an engineer looking for code that should not exist. */
      const isCustom = hit.actionId.startsWith("Custom");
      const unimplemented = isCustom && !hit.hasHandler;
      out.push({
        dimension: "action", subject: b.name, state: unimplemented ? "assumed" : "resolved",
        detail: unimplemented
          ? `Action id \`${hit.actionId}\` registered; no front-end handler located.`
          : `Action id \`${hit.actionId}\` registered.`,
        evidence: "your front-end action registration",
        ...(unimplemented ? { closes: `Confirm this action is implemented in the target tenant.` } : {}),
      });
    }
  }
}

/** Named queries: transcribable from the corpus, buildable from a definition, or a gap. */
function checkQueries(cfg: PipelineConfig, d: SpecDescriptor, out: Finding[]): void {
  const roots = corpusRoots(cfg);
  const names = d.queries ?? [];
  /* Queries are NOT pages. `findDeliveredPage` requires a `widgets` payload, so
     it can never match a query export — which is why both of this story's
     queries were first reported missing while sitting in the corpus. */
  const delivered = roots.length && names.length
    ? findQueryDefinitions(roots, names)
    : new Map<string, { source: string }>();

  /*
   * DO THEIR OWN EXPORTS DISAGREE ABOUT THE NAME?
   *
   * v2.28.0 ships `CustomLoadFeederResource`; v2.39.0 ships
   * `CustomLoadFeederResources`. A requirement naming one of those is naming one
   * of two real things, and picking silently is how a page ends up bound to the
   * query nobody meant. Normalised on case and a trailing plural, which is the
   * shape the disagreement actually takes — not a general fuzzy match, which
   * would invent conflicts that are simply different queries.
   */
  const all = roots.length && names.length ? scanQueries(roots) : new Map<string, string>();
  const byShape = new Map<string, string[]>();
  for (const n of all.keys()) {
    const key = n.toLowerCase().replace(/s$/, "");
    byShape.set(key, [...(byShape.get(key) ?? []), n]);
  }

  for (const name of names) {
    const siblings = (byShape.get(name.toLowerCase().replace(/s$/, "")) ?? [])
      .filter((n) => n !== name);
    if (siblings.length) {
      out.push({
        dimension: "query", subject: name, state: "assumed",
        detail: `Variant definitions exist under ` +
                `${[name, ...siblings].map((n) => `\`${n}\``).join(" and ")}. ` +
                `Specification spelling bound; these are distinct objects.`,
        evidence: "your delivered exports",
        closes: `Confirm the target query.`,
      });
      continue;
    }

    const hit = delivered.get(name);
    if (hit) {
      out.push({
        dimension: "query", subject: name, state: "resolved",
        detail: `Existing query definition. Transcribed from the delivered export.`,
        evidence: hit.source,
      });
      continue;
    }
    if (queryDefinitionFor(d, name)) {
      out.push({
        dimension: "query", subject: name, state: "resolved",
        detail: `No existing definition. Entity, joins and filter criteria specified ` +
                `in the document; assembly supported.`,
        evidence: "the requirement document",
      });
      continue;
    }
    out.push({
      dimension: "query", subject: name, state: "missing",
      detail: `Named without definition. No delivered export and no specification ` +
              `of entity, fields or filters.`,
      closes: `Specify root entity, selected fields and filter criteria.`,
    });
  }
}

/** Services the document names, against the recorded contracts. */
function checkServices(cfg: PipelineConfig, d: SpecDescriptor, out: Finding[]): void {
  let contracts: Array<{ name: string; inputs?: unknown[]; outputs?: unknown[] }> = [];
  try {
    const raw = asset(cfg, "services");
    if (raw) contracts = (JSON.parse(raw) as { services?: typeof contracts }).services ?? [];
  } catch { /* none */ }

  for (const name of d.api ?? []) {
    const hit = contracts.find((c) => c.name === name);
    out.push(hit
      ? {
          dimension: "service", subject: name, state: "resolved",
          detail: `Contract recorded: ${hit.inputs?.length ?? 0} input(s), ` +
                  `${hit.outputs?.length ?? 0} output(s).`,
          evidence: "your recorded service contracts",
        }
      : {
          dimension: "service", subject: name, state: "missing",
          detail: `No recorded contract. Inputs and outputs undetermined.`,
          closes: `Supply the service contract, or confirm out of scope.`,
        });
  }
}

/**
 * What the document never says.
 *
 * Read from the descriptor's own optional fields being absent, which is exactly
 * what "the document is silent here" looks like once it has been extracted. This
 * is the half an engineer cannot get from reading their own document twice: it
 * is easy to miss what is NOT written.
 */
function checkUnstated(d: SpecDescriptor, out: Finding[]): void {
  for (const page of d.pages) {
    for (const g of page.grids ?? []) {
      const untyped = (g.columns ?? []).filter((c) => !c.scalarType).map((c) => c.name);
      if (untyped.length) {
        out.push({
          dimension: "unstated", subject: `${g.entity} column types`, state: "assumed",
          detail: `Type unspecified for ${untyped.length} column(s): ` +
                  `${untyped.slice(0, 4).join(", ")}${untyped.length > 4 ? ", …" : ""}. ` +
                  `Derived from the CMF schema and delivered column rendering.`,
          closes: `Override where the derived type is incorrect.`,
        });
      }
      /* ROW SELECTION IS NOT REPORTED, and the reason is worth recording: the
         descriptor REQUIRES `selection`, so it is always present and a silence
         in the document is indistinguishable from a statement in it. Reporting
         it would mean inventing a distinction the data cannot carry. */
    }
    for (const b of page.actionButtons ?? []) {
      if (!b.control?.placement) {
        out.push({
          dimension: "unstated", subject: `${b.name} placement`, state: "assumed",
          detail: `Placement unspecified. Defaulted to the action bar per delivered ` +
                  `page convention.`,
          closes: `Specify page-body placement if required.`,
        });
      }
    }
  }
}

/* ────────────────────────────── the report ────────────────────────────── */

export function prevalidate(input: PreValidateInput): PreValidation {
  const { cfg, descriptor, document } = input;
  const findings: Finding[] = [];

  checkPages(cfg, descriptor, findings);
  checkTerms(cfg, descriptor, findings);
  checkActions(cfg, descriptor, findings);
  checkQueries(cfg, descriptor, findings);
  checkServices(cfg, descriptor, findings);
  checkUnstated(descriptor, findings);

  /* A `resolved` finding with nothing behind it is the one failure mode this
     report cannot survive — it is the difference between "we know" and "we say
     we know". Demoted rather than dropped, so the subject still reaches the
     engineer instead of vanishing on a technicality. */
  for (const f of findings) {
    if (f.state === "resolved" && !f.evidence) {
      f.state = "assumed";
      f.detail = `${f.detail} (No artifact was recorded for this.)`;
    }
  }

  const counts = { resolved: 0, assumed: 0, missing: 0 };
  for (const f of findings) counts[f.state] += 1;

  return { document, counts, findings };
}

/** The findings the intake should ask about — never the resolved ones. */
export function openFindings(r: PreValidation): Finding[] {
  return r.findings.filter((f) => f.state !== "resolved");
}
