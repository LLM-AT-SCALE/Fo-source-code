/**
 * The checks. A direct port of _working/scripts/validate.py.
 *
 * Deliberately a LITERAL port, including message wording and number formatting,
 * so the Python original can be run as a test oracle against this one and the
 * outputs compared line for line (see test/oracle.ts). Improvements belong in a
 * later commit, after parity is proven — otherwise a divergence is ambiguous:
 * is it a porting bug, or the improvement?
 */
import { readFileSync, existsSync } from "node:fs";
import { attr, child, type XmlNode } from "./load";
import type { EffectiveSpec, GridSpec } from "./descriptor";
import { AMBIENT_DATA_SOURCES, CMF_VERSION, EXPORT_ROOT, INNER_WIDGET_KEYS,
         SELECTION_MODE, UIPAGE_TYPE_MARKER, UNKNOWN_LABEL_PREFIX,
         type SelectionName } from "./platform";
import { loadConventions, rule, type Conventions } from "./conventions";
import type { Column, DataSource, PageSettings, Result, Widget } from "./types";

/* ------------------------------------------------------------ origin policy */

/**
 * WHERE THE ARTIFACT CAME FROM, which decides how strict a check may be.
 *
 * The validator has always had two jobs, and one severity per check cannot serve
 * both (T-09):
 *
 *   "generated"  we produced it, so OUR rules are the specification. Strict.
 *   "external"   CMF or the client produced it, so REALITY is the specification.
 *                A rule that rejects a file CMF itself produced is a wrong rule.
 *
 * Measured over the 30 delivered UI pages, the strict-everywhere policy rejected
 * **28 of 30** — including Athena's own `CustomChangePriorityStep`, one of the
 * three samples the rules were calibrated against.
 */
export type Origin = "generated" | "external";

/**
 * Checks that state a CONVENTION rather than a platform law, with the measured
 * rate at which real CMF artifacts break each. On `external` input these drop to
 * WARN: still reported, no longer a rejection.
 *
 * Everything absent from this list stays FAIL for both origins — a malformed
 * envelope or a missing `Object` element is broken whoever wrote it.
 */
export const CONVENTION_CHECKS: Readonly<Record<string, string>> = {
  // 32 of 90 column labels on real pages are plain text, across 9 of 30 pages
  "every label is a $(...) reference": "36% of real column labels are plain text",
  // 18 of 111 buttons on 007-CustomCoreStepView_Cluster receive nothing
  "every action button receives input": "real pages leave buttons unwired",
  // 30 of 130 widgets unplaced across 12 of 30 pages
  "every widget is placed on the layout": "23% of real widgets are never placed",
  // the inverse, on 3 files
  "layout placements resolve to real widgets": "real pages place absent widgets",
  // CMF's own wizard: 318 markers for 355 objects
  "$id coverage": "CMF's serialiser numbers ~90% of objects on some pages",
  "$id contiguous": "follows from partial coverage",
  // 52 of 3,292 endpoints on real pages point at nested buttons / panels
  "all link references resolve": "CMF's own exports carry ~1.6% dangling refs",
  // Athena's own Transfer Tote / Bin Inventory carry no Custom prefix
  "name carries Custom prefix": "the client's own artifacts break their own rule",
};

/** Apply the origin policy. `generated` is unchanged, so Python parity is untouched. */
export function applyOrigin(results: Result[], origin: Origin): Result[] {
  if (origin === "generated") return results;
  return results.map((r) => {
    if (r.level !== "FAIL") return r;
    const key = Object.keys(CONVENTION_CHECKS).find((k) => r.name.startsWith(k));
    if (key === undefined) return r;
    return { ...r, level: "WARN" as const,
             detail: r.detail ? `${r.detail}  [convention: ${CONVENTION_CHECKS[key]}]`
                              : `[convention: ${CONVENTION_CHECKS[key]}]` };
  });
}

/* ------------------------------------------------------------ python parity */

/** Python's `%r` for the values this validator formats. */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  const s = String(v);
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), "\\" + q) + q;
}

/** Python's `%.0f` — round-half-to-even, unlike JS toFixed. */
export function pctFmt(n: number): string {
  const floor = Math.floor(n);
  const diff = n - floor;
  if (Math.abs(diff - 0.5) < Number.EPSILON) {
    return String(floor % 2 === 0 ? floor : floor + 1);
  }
  return String(Math.round(n));
}

const norm = (s: unknown): string => String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");

/* ------------------------------------------------------------------- checks */

/**
 * Envelope checks.
 *
 * The structural parts (root element, object type, CMF version) are PLATFORM
 * facts from platform.ts. The naming, scope and revision expectations are CLIENT
 * CONVENTIONS from config — Athena chose them, another client would differ.
 */
export function checkEnvelope(
  root: XmlNode | undefined, rootTag: string | undefined, conv: Conventions, r: Result[],
): void {
  if (rootTag !== EXPORT_ROOT) {
    r.push({ level: "FAIL", name: `root is ${EXPORT_ROOT}`, detail: rootTag ?? "" });
    return;
  }
  const obj = child(root, "Object");
  if (!obj) {
    r.push({ level: "FAIL", name: "Object element present", detail: "" });
    return;
  }
  const t = attr(obj, "type") ?? "";
  if (!t.includes(UIPAGE_TYPE_MARKER)) {
    r.push({ level: "FAIL", name: `Object type is ${UIPAGE_TYPE_MARKER}`, detail: t.slice(0, 60) });
    return;
  }
  if (!t.includes(CMF_VERSION)) {
    r.push({
      level: "WARN", name: `CMF version ${CMF_VERSION} in type string`, detail: t.slice(0, 60),
    });
  } else {
    r.push({ level: "PASS", name: "envelope + version string", detail: "" });
  }

  for (const [tag, key] of [["Scope", "expectedScope"], ["Revision", "expectedRevision"]] as const) {
    const cr = rule(conv, key);
    if (!cr) continue;
    const el = child(obj, tag);
    const got = el ? attr(el, "value") : undefined;
    if (el && got !== cr.value) {
      r.push({
        level: cr.severity, name: `${tag} == ${cr.value}`, detail: `found ${pyRepr(got ?? null)}`,
      });
    }
  }

  const pr = rule(conv, "namePrefix");
  if (pr) {
    const nm = child(obj, "Name");
    const nmVal = nm ? attr(nm, "value") : undefined;
    if (nm && !(nmVal ?? "").startsWith(pr.value)) {
      r.push({ level: pr.severity, name: `name carries ${pr.value} prefix`, detail: nmVal ?? "" });
    } else {
      r.push({ level: "PASS", name: `name carries ${pr.value} prefix`, detail: "" });
    }
  }
}

/** number of JSON objects; arrays are not counted, matching CMF's $id rule */
export function countObjects(o: unknown): number {
  if (Array.isArray(o)) return o.reduce<number>((n, x) => n + countObjects(x), 0);
  if (o !== null && typeof o === "object") {
    return 1 + Object.values(o as Record<string, unknown>).reduce<number>((n, v) => n + countObjects(v), 0);
  }
  return 0;
}

export function checkIds(j: PageSettings, r: Result[]): void {
  const blob = JSON.stringify(j);
  const ids = [...blob.matchAll(/"\$id":\s*"(\d+)"/g)].map((m) => m[1] as string);
  const objects = countObjects(j);

  if (ids.length === 0) {
    r.push({ level: "FAIL", name: "$id markers present", detail: `none found; ${objects} objects need them` });
    return;
  }

  const cov = objects ? (100 * ids.length) / objects : 0;
  if (cov < 90) {
    r.push({
      level: "FAIL", name: "$id coverage",
      detail: `only ${ids.length} markers for ${objects} objects (${pctFmt(cov)}%) - most objects unnumbered`,
    });
  } else {
    r.push({ level: "PASS", name: `$id coverage ${ids.length}/${objects} objects (${pctFmt(cov)}%)`, detail: "" });
  }

  const nums = ids.map(Number).sort((a, b) => a - b);
  const first = nums[0] as number;
  const dupes = ids.length - new Set(ids).size;
  const contiguous = nums.every((n, i) => n === first + i);

  if (dupes) {
    r.push({ level: "FAIL", name: "$id unique", detail: `${dupes} duplicates` });
  } else if (!contiguous) {
    const have = new Set(nums);
    const missing: number[] = [];
    for (let n = first; n <= (nums[nums.length - 1] as number); n++) if (!have.has(n)) missing.push(n);
    r.push({ level: "FAIL", name: "$id contiguous", detail: `gaps at ${pyRepr(missing.slice(0, 10))}` });
  } else if (first !== 1) {
    r.push({ level: "WARN", name: "$id starts at 1", detail: `starts at ${first}` });
  } else {
    r.push({ level: "PASS", name: `$id contiguous 1..${nums[nums.length - 1]}, no duplicates`, detail: "" });
  }
}

/**
 * Every id a link endpoint may legitimately name.
 *
 * MEASURED over all 30 delivered UI pages — 3,292 link endpoints (T-02):
 *   type 0  910  the PAGE itself. The id equals the page's own `id`, 910 of 910.
 *   type 1 2372  a widget / dataSource / actionButton, INCLUDING action buttons
 *                nested inside another button, which is why this walks the
 *                subtree rather than reading the top-level array.
 *   type 4   10  a page PANEL — `<prefix>_rightPanel`, matching the leftPanel /
 *                rightPanel keys. The prefix is NOT always the page id.
 *
 * Resolving only against the three top-level arrays — what this did until
 * 2026-08-20 — reported 910 correct references as dangling, 147 on one page.
 */
function collectIds(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const v of node) collectIds(v, into);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (typeof o["id"] === "string") into.add(o["id"]);
  for (const [k, v] of Object.entries(o)) {
    // `$id` is the serialiser's object counter, never a reference target
    if (k !== "$id") collectIds(v, into);
  }
}

export function checkReferences(j: PageSettings, r: Result[]): void {
  const defined = new Map<string, string>();
  for (const grp of ["widgets", "dataSources", "actionButtons"] as const) {
    for (const e of (j[grp] as Array<{ id?: string; settings?: { name?: string | null } | null }>) ?? []) {
      if (e?.id) defined.set(e.id, `${grp}:${e.settings?.name ?? "None"}`);
    }
  }

  // everything ABOVE is the top-level element map, kept because other messages
  // use its labels. What follows is the full resolvable set.
  const resolvable = new Set<string>(defined.keys());
  if (typeof j["id"] === "string") resolvable.add(j["id"] as string);
  for (const grp of ["widgets", "dataSources", "actionButtons",
                     "leftPanel", "rightPanel", "properties"] as const) {
    collectIds(j[grp], resolvable);
  }

  const bad: string[] = [];
  const links = j.links ?? [];
  links.forEach((l, i) => {
    for (const end of ["source", "target"] as const) {
      const v = l[end];
      const rid = v && typeof v === "object" ? v.id : (v as string | null | undefined);
      if (rid && !resolvable.has(rid)) bad.push(`link[${i}].${end} -> ${rid}`);
    }
  });

  if (bad.length) {
    r.push({
      level: "FAIL", name: "all link references resolve",
      detail: `${bad.length} dangling: ${bad.slice(0, 6).join("; ")}`,
    });
  } else {
    r.push({ level: "PASS", name: `all ${2 * links.length} link references resolve`, detail: "" });
  }
}

export function checkLabels(j: PageSettings, r: Result[]): void {
  const plain: string[] = [];
  let total = 0;

  for (const w of j.widgets ?? []) {
    const st = w.settings ?? {};
    for (const c of st.columns ?? []) {
      total += 1;
      const n = c.name ?? "";
      if (!n.startsWith("$(")) plain.push(`column ${pyRepr(n)}`);
    }
    for (const f of st.fields ?? []) {
      const lab = f.property?.label ?? "";
      total += 1;
      if (lab && !lab.startsWith("$(")) plain.push(`field ${pyRepr(lab)}`);
    }
    /*
     * A FILTER's labels are user-visible too, and were going unjudged.
     *
     * Rule 2 is this project's most-cited rule and it was applied to grid columns,
     * form fields and button titles — every place a label appears EXCEPT the one
     * widget we had never emitted. Measured across the delivered corpus: 31 of the
     * 37 non-empty filter labels are `$(...)` references.
     *
     * The empty-label guard is what keeps this from rejecting the authority's own
     * file, exactly as it does for form fields: 4 of the delivered filter labels
     * are `""`, because a filter on a typed reference renders its entity's own
     * caption. An empty label is not an unlocalised one.
     */
    for (const f of (st as { filters?: Array<{ label?: string }> }).filters ?? []) {
      const lab = f.label ?? "";
      total += 1;
      if (lab && !lab.startsWith("$(")) plain.push(`filter ${pyRepr(lab)}`);
    }
  }
  for (const b of j.actionButtons ?? []) {
    const t = b.settings?.buttonTitle ?? "";
    if (t) {
      total += 1;
      if (!t.startsWith("$(")) plain.push(`button title ${pyRepr(t)}`);
    }
  }

  if (plain.length) {
    r.push({
      level: "FAIL", name: "every label is a $(...) reference",
      detail: `${plain.length} of ${total} are plain text: ${plain.slice(0, 6).join("; ")}`,
    });
  } else {
    r.push({ level: "PASS", name: `all ${total} labels are $(...) references`, detail: "" });
  }
}

export function checkPaths(j: PageSettings, dictPath: string | undefined, r: Result[]): void {
  const known = new Set<string>();
  if (dictPath && existsSync(dictPath)) {
    const text = readFileSync(dictPath, "utf-8");
    for (const m of text.matchAll(/`([A-Za-z][A-Za-z0-9_.]*)`/g)) known.add(m[1] as string);
  }

  const unknownMarked: string[] = [];
  const invented: string[] = [];
  for (const w of j.widgets ?? []) {
    for (const c of w.settings?.columns ?? []) {
      const p = c.path;
      if (!p) continue;
      if (String(p).toUpperCase().startsWith("UNKNOWN")) unknownMarked.push(c.name ?? "");
      else if (known.size && !known.has(p)) invented.push(`${c.name} -> ${p}`);
    }
  }

  if (unknownMarked.length) {
    r.push({ level: "PASS", name: "unknown paths explicitly marked", detail: `${unknownMarked.length} marked UNKNOWN` });
  }
  if (invented.length) {
    r.push({
      level: "WARN", name: "paths not found in dictionary",
      detail: `${invented.length} unverifiable: ${invented.slice(0, 8).join("; ")}`,
    });
  } else if (!unknownMarked.length) {
    r.push({ level: "PASS", name: "all column paths appear in the dictionary", detail: "" });
  }
}

const gridsOf = (j: PageSettings): Widget[] =>
  (j.widgets ?? []).filter((w) => (w.settings?.columns?.length ?? 0) > 0);

/**
 * `Button` WIDGETS — a control in the page body, as opposed to the action bar.
 *
 * Matched on the widget's component name, case-insensitively: delivered pages
 * carry both `Button` and, under an older settings schema, `button` and the tail
 * of a `path`. Reading only the current spelling reported 0 where the answer was
 * 18 — the measurement error THINGSTOIMPLEMENT §1.4b records, made once already
 * during the harvest that produced these figures.
 */
const buttonWidgetsOf = (j: PageSettings): Widget[] =>
  (j.widgets ?? []).filter((w) => {
    const raw = (w as { name?: string; path?: string }).name ??
                ((w as { path?: string }).path ?? "").split("/").pop() ?? "";
    return raw.toLowerCase() === "button";
  });

const labelStem = (c: Column): string =>
  (c.name ?? "").replace(/^\$\((\w+?)(Column|Grid)?Label\)$/, "$1");

/**
 * Every way one label might be written, normalised for comparison.
 *
 * A story says "Storage Step". The artifact may carry that as the data path
 * `Step`, as `$(CustomStorageStepColumnLabel)`, as `$(CustomBatch)`, or — where
 * no message name is evidenced — as our own placeholder `$(UNKNOWN_StorageStep)`.
 * All of those are the field the story asked for.
 *
 * WRITTEN BECAUSE THE FIRST VERSION WAS WRONG. It compared the story's name
 * against the property and the `…ColumnLabel` stem only, and duly reported
 * `missing ['Storage Step', 'Batch']` on a page carrying `$(UNKNOWN_StorageStep)`
 * and `$(CustomBatch)` — a FAIL against an artifact that was right, which under
 * the regeneration loop is worse than no check at all (F-76).
 *
 * The two prefixes stripped are the two this system adds itself: the client's
 * artifact-name prefix from `client-conventions.json`, and the placeholder marker
 * from `platform.ts`. Neither is a guess about the client's vocabulary.
 */
function labelKeys(value: unknown): string[] {
  const raw = String(value ?? "");
  if (!raw) return [];
  const out = new Set<string>([norm(raw)]);
  const inner = /^\$\((.*)\)$/.exec(raw)?.[1] ?? raw;
  out.add(norm(inner));
  out.add(norm(labelStem({ name: raw } as Column)));
  /* our own placeholder marker, and the client's artifact prefix */
  const prefix = rule(loadConventions(), "namePrefix")?.value ?? "";
  for (const stem of [inner.replace(new RegExp(`^${UNKNOWN_LABEL_PREFIX}`), ""),
                      prefix ? inner.replace(new RegExp(`^${prefix}`), "") : inner]) {
    out.add(norm(stem));
    out.add(norm(stem.replace(/(Column|Grid)?Label$/, "")));
  }
  out.delete("");
  return [...out];
}

/**
 * The business record a grid lists.
 *
 * The artifact does not state it, so it is derived: a column whose path is
 * exactly "Id" refers to the grid's OWN record and carries the entity in
 * referenceTypeName. A column on a joined entity uses "<Entity>.Id" instead, so
 * a bare "Id" is unambiguous. Verified against every artifact we hold — all four
 * generated rounds, both sample pages and Athena's own page.
 */
export function deriveEntity(settings: Widget["settings"]): string | null {
  for (const c of settings?.columns ?? []) {
    if ((c.path ?? "") === "Id" && c.type?.referenceTypeName) {
      return c.type.referenceTypeName;
    }
  }
  return null;
}

/**
 * Pair each descriptor grid with the artifact grid that displays its entity.
 *
 * Shared by checkSpecCoverage and checkSelection so the two can never end up
 * grading different grids.
 */
export function matchGrids(
  j: PageSettings, spec: EffectiveSpec,
): Array<{ idx: number; sgrid: GridSpec; match: Widget | undefined }> {
  const grids = gridsOf(j);
  const pool = grids.map((w) => ({ w, entity: deriveEntity(w.settings) }));
  const used = new Set<number>();
  return spec.grids.map((sgrid, idx) => {
    let match: Widget | undefined;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      if (!used.has(i) && p && p.entity === sgrid.entity) { match = p.w; used.add(i); break; }
    }
    return { idx, sgrid, match };
  });
}

/**
 * Grade the artifact's grids against the spec descriptor.
 *
 * Grids are matched to the descriptor BY ENTITY, never by position. The old code
 * compared grids[0] to the first expected grid and grids[1] to the second, which
 * graded the wrong grid without failing whenever the widget order differed from
 * the spec's declaration order.
 */
/**
 * Name of the query a data source is bound to, or null.
 *
 * Defensive on purpose: a generator that does not know the query-reference shape
 * may emit a bare string (round 5 emitted "UNKNOWN", which is the CORRECT
 * behaviour — visible rather than invented). The validator must report on
 * whatever it is given and never throw on an unexpected shape.
 */
export function queryNameOf(ds: DataSource): string | null {
  const q = (ds.settings as { query?: unknown } | null | undefined)?.query;
  if (q && typeof q === "object") return (q as { Name?: string }).Name ?? null;
  if (typeof q === "string") return q;   // "UNKNOWN" simply will not match
  return null;
}

/**
 * Every query named by an `entityTypeQuery`, anywhere in the page.
 *
 * A reference field narrows its picker either with the entity's default lookup
 * (27 of the 31 evidenced fields) or with a named query written here. The
 * second is a real way to CONSUME a query and carries no data source, so any
 * check asking "is this query used" has to look in both places.
 *
 * Walks the whole settings tree rather than a known list of widget kinds: the
 * field may sit in a Form, and that Form may itself be hosted inside a Filter
 * (F-173). A fixed path would miss the nested case, which is the shape the
 * client's own page uses.
 */
export function entityTypeQueryNames(j: PageSettings): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const v of node) walk(v); return; }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const q = o["entityTypeQuery"];
    if (q && typeof q === "object") {
      const n = (q as { Name?: unknown }).Name;
      if (typeof n === "string" && n) out.push(n);
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(j as unknown);
  return out;
}

/**
 * A HOSTED WIDGET AND ITS DECLARATION MUST BE THE SAME OBJECT.
 *
 * A Filter contains the widget it narrows under `settings.widgetModel`, and that
 * widget is also declared in `widgets[]` under the same id (F-173). One object,
 * serialised twice. If the two copies disagree, the page has two answers to the
 * same question - and the LAYOUT PLACES THE HOST, so the copy CMF actually draws
 * is the nested one, not the declaration.
 *
 * MEASURED 2026-09-01. A revision renamed a grid column; it edited the
 * declaration and left the hosted copy untouched. The tool reported success,
 * the file changed, the validator passed everything except an unrelated label
 * rule, and the screen would have shown the OLD heading. Nothing compared the
 * two copies, so nothing could have caught it.
 *
 * FAIL, not WARN. Only FAIL feeds the regeneration loop, and this is precisely
 * the case where a run must not be allowed to report success: the artifact
 * imports cleanly and does the wrong thing.
 */
export function checkHostedCopies(j: PageSettings, r: Result[]): void {
  const byId = new Map<string, unknown>();
  for (const w of j.widgets ?? []) {
    const id = (w as unknown as Record<string, unknown>)["id"];
    if (typeof id === "string" && id) byId.set(id, w);
  }

  let compared = 0;
  const bad: string[] = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const v of node) walk(v); return; }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    for (const key of INNER_WIDGET_KEYS) {
      const held = o[key];
      if (!held || typeof held !== "object" || Array.isArray(held)) continue;
      const id = (held as Record<string, unknown>)["id"];
      const decl = typeof id === "string" ? byId.get(id) : undefined;
      if (decl === undefined) continue;      // hosted only - a different shape
      compared += 1;
      /* `$id` is a positional counter our own code assigns at write time, so it
         legitimately differs between two copies of the same object. Everything
         else must match. */
      if (stripIds(held) !== stripIds(decl)) bad.push(String(id));
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(j as unknown);

  if (compared === 0) {
    r.push({ level: "PASS", name: "no widget is hosted inside another",
             detail: "nothing to compare on this page" });
    return;
  }
  if (bad.length) {
    r.push({
      level: "FAIL", name: "hosted widgets match their declaration",
      detail: `${pyRepr(bad)} differ between widgets[] and the host that draws ` +
              `them - the page would render the hosted copy, not the declared one`,
    });
    return;
  }
  r.push({ level: "PASS", name: `all ${compared} hosted widget(s) match their declaration`, detail: "" });
}

/** The same object with every `$id` marker removed, as canonical JSON. */
function stripIds(v: unknown): string {
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(node as Record<string, unknown>).sort()) {
      if (k === "$id") continue;
      out[k] = clean((node as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(clean(v));
}

export function checkSpecCoverage(j: PageSettings, spec: EffectiveSpec, r: Result[]): void {
  // Uses matchGrids() — which is the whole reason that helper exists. This
  // function previously re-implemented the same loop inline, so the two ways of
  // pairing a descriptor grid to an artifact grid could drift apart while both
  // looked right, which is exactly the bug matchGrids was written to prevent.
  // Identical behaviour by construction; the oracle and baseline gates prove it.
  /*
   * A grid whose entity cannot be DERIVED is not the same as a grid that is
   * ABSENT, and telling them apart is what stops this check rejecting the
   * authority's own pages.
   *
   * `deriveEntity` needs a column whose path is exactly `Id` carrying a
   * referenceTypeName. Measured 2026-08-28 across the delivered corpus:
   * **7 of 16 grids (43.8%) carry no such column** — `Transfer Tote`'s three-column
   * grid, `BinInventory`'s, `CustomIntegrationPayloadConsolidation`'s. On our own
   * runs it is 3 of 200, because a story usually names an Id column.
   *
   * So when the page HAS grids but none of them can be identified, "grid N
   * present" is not a finding about the artifact — it is the check saying it
   * cannot tell. That is a WARN. When the page has no grids at all, or the grids
   * it has are identifiable and none is the one asked for, the grid really is
   * missing and it stays a FAIL.
   *
   * This matters beyond tidiness: only FAIL feeds the regeneration loop, and a
   * story that lists no grid columns produced a FAIL the model could not fix —
   * it spent all three attempts on it (T-25's second class of unfixable FAIL,
   * §13.11).
   */
  const undecidable = gridsOf(j).filter((w) => deriveEntity(w.settings) === null).length;

  for (const { idx, sgrid, match } of matchGrids(j, spec)) {
    if (!match) {
      if (undecidable > 0) {
        r.push({
          level: "WARN", name: `grid ${idx + 1} present`,
          detail: `${undecidable} grid(s) on the page carry no 'Id' column, so which ` +
                  `entity each lists cannot be derived - unmatched rather than absent`,
        });
      } else {
        r.push({ level: "FAIL", name: `grid ${idx + 1} present`, detail: "" });
      }
      continue;
    }
    const want: readonly string[] = sgrid.columns.map((c) => c.name);
    const g = match;
    const cols = g.settings?.columns ?? [];
    const got = new Set<string>();
    for (const c of cols) {
      got.add(norm(labelStem(c)));
      got.add(norm(c.path ?? ""));
    }
    const unmatched = want.filter((c) => !got.has(norm(c)));
    const nSpec = want.length;
    const nGot = cols.length;

    if (nGot < nSpec) {
      r.push({
        level: "FAIL", name: `grid ${idx + 1} column count`,
        detail: `${nGot} columns, spec asks for ${nSpec}`,
      });
    } else if (nGot > nSpec) {
      r.push({
        level: "FAIL", name: `grid ${idx + 1} has unrequested columns`,
        detail: `${nGot} columns, spec asks for ${nSpec}`,
      });
    } else {
      r.push({ level: "PASS", name: `grid ${idx + 1} column count == ${nSpec} (spec)`, detail: "" });
    }
    if (unmatched.length) {
      r.push({
        level: "WARN", name: `grid ${idx + 1}: could not auto-verify columns`,
        detail: `${pyRepr(unmatched.slice(0, 5))} (label/path naming diverges - human check)`,
      });
    }
  }

  // buttons and queries come from the descriptor, not a fixed list
  //
  // A button the story asks for may be built EITHER as an `actionButtons[]` entry
  // (the page's action bar) or as a `Button` WIDGET placed in the page body. Both
  // are real: the delivered corpus has 679 of the first over 10 pages and 18 of
  // the second over 6, and 2 pages carry both. Counting only the action bar made
  // emitting the right widget FAIL as a missing button, which — because only FAIL
  // feeds the regeneration loop — would have pushed the model to replace a
  // correct control with the wrong mechanism.
  const wantB = spec.actionButtons.map((b) => b.name);
  const gotB = [
    ...(j.actionButtons ?? []).map((b) => norm(b.settings?.name)),
    ...buttonWidgetsOf(j).map((w) => norm(w.settings?.name)),
  ];
  const missB = wantB.filter((b) => !gotB.includes(norm(b)));
  if (missB.length) {
    r.push({ level: "FAIL", name: "all spec buttons present", detail: `missing ${pyRepr(missB)}` });
  } else {
    r.push({ level: "PASS", name: `all ${wantB.length} spec buttons present`, detail: "" });
  }
  if (gotB.length > wantB.length) {
    r.push({
      level: "FAIL", name: "no unrequested buttons",
      detail: `${gotB.length - wantB.length} extra button(s)`,
    });
  }

  /*
   * A QUERY IS CONSUMED IN TWO WAYS, AND THIS CHECK ONLY KNEW ONE.
   *
   * Counting `dataSources` alone, a query that a reference field uses for its
   * PICKER reads as missing. That is not a hypothetical: Athena's delivered
   * Load Materials to Feeder page consumes `CustomLoadFeederResource` through
   * `entityTypeQuery` on the Feeder Resource field and does NOT declare it as a
   * data source at all - so this check, given a spec that lists that query,
   * FAILED the client's own artifact.
   *
   * Found 2026-08-31 by the change that taught the generator to emit the
   * picker: the page got MORE correct and the validator reported FAIL 1, which
   * is the F-118 shape exactly - a rule generalised from the one mechanism that
   * happened to be in front of us, rejecting the other one the corpus uses.
   *
   * Only FAIL feeds the regeneration loop, so the cost of leaving it was a loop
   * pushing the model to declare a redundant data source in order to satisfy a
   * check, undoing the binding that made the page right.
   */
  const qs = [
    ...(j.dataSources ?? []).map(queryNameOf),
    ...entityTypeQueryNames(j),
  ];
  const missQ = spec.queries.filter((q) => !qs.includes(q));
  if (missQ.length) {
    /* WARN, not FAIL, when the list was inherited rather than stated: the page
       never claimed these queries, a multi-page story's list was applied to it
       for want of anything better, and only FAIL feeds the regeneration loop.
       See `effectiveSpec` — this is the wizard case, measured. */
    r.push(spec.queriesInherited
      ? { level: "WARN", name: "spec queries wired",
          detail: `missing ${pyRepr(missQ)} (inherited from the story; this page ` +
                  `does not declare its own queries - state pages[].queries to settle it)` }
      : { level: "FAIL", name: "spec queries wired", detail: `missing ${pyRepr(missQ)}` });
  } else {
    // Count, not "both": a Wizard consumes no queries, and the old hardcoded
    // label reported "both spec queries wired" over an empty list. Passing was
    // correct; saying "both" about zero was not.
    r.push({ level: "PASS", name: `all ${spec.queries.length} spec queries wired`, detail: "" });
  }
}

/**
 * The filters the story asked for must exist — WHICHEVER widget carries them.
 *
 * A page narrows a list in one of two ways, and the client's own delivered pages
 * use both: a `Form` whose fields feed the query (41 Forms over 12 pages) or a
 * `Filter` widget wrapping the grid (8 over 5). Athena built the PO page's
 * filters as a Form and the Load-Materials page's as a Filter.
 *
 * So this check deliberately does NOT dictate the mechanism. Doing so would be
 * the F-118 error — a rule generalised from whichever example was in front of us,
 * rejecting the client's own artifacts on the other pattern. What it checks is
 * COVERAGE: the story asked to filter by three things, and three filterable
 * fields exist on the page.
 *
 * Silent when the descriptor declares no filters, so every descriptor written
 * before the field existed produces exactly the output it did before.
 */
/**
 * A DECLARED MAPPING MUST BE THE ONE THE ARTIFACT USES.
 *
 * `termPaths` records what each of the story's words was taken to mean, and the
 * PRD shows that table so a human can correct it. This is what makes the table
 * load-bearing rather than decorative: if the descriptor says "Batch means
 * `ManufacturerLotNumber`" and the page filters on something else, the document
 * the engineer approved and the file they are about to import disagree.
 *
 * WARN, not FAIL, and the severity is measured rather than chosen. A term may
 * legitimately go unused — the story mentions a word, the page turns out not to
 * need it — and only FAIL feeds the regeneration loop, which would push the model
 * to invent a use for it. What must never happen silently is a path being
 * declared and CONTRADICTED, so that is what is reported.
 */
export function checkTermPaths(j: PageSettings, spec: EffectiveSpec, r: Result[]): void {
  /*
   * `path: "UNKNOWN"` is NOT a declared path.
   *
   * The schema documents `null` as the answer for a term the evidence does not
   * settle, but the model writes this project's own UNKNOWN marker instead —
   * observed on a live run, and reasonably, since that is what Rule 1 asks for
   * everywhere else. `checkPaths` above already treats an UNKNOWN column path
   * as "explicitly marked" rather than as a value; a term is the same fact one
   * layer up. Without this the marker is read as a real path, and the check
   * then reports the model's honest refusal to guess as a contradiction.
   */
  const declared = (spec.termPaths ?? [])
    .filter((t) => t.path && !String(t.path).toUpperCase().startsWith("UNKNOWN"));
  if (!declared.length) return;

  /* Every path the artifact actually uses, from both mechanisms. */
  const used = new Set<string>();
  /*
   * WHERE A TERM COULD HAVE LANDED AT ALL.
   *
   * Counted for the same reason `checkFilterCoverage` counts unclaimed fields:
   * a term is only CONTRADICTED if the page had somewhere to put it and put it
   * somewhere else. On a page with no columns and no filters there is nothing
   * to contradict.
   *
   * MEASURED across the 36 delivered pages, 2026-08-31: **0 of 58 form fields
   * carry a `path`** and **118 of 118 grid columns do**. A form field is wired
   * by link, not bound by a path — so a page whose only widget is a Form can
   * never satisfy this check, however correct it is. **6 of those 36 pages have
   * fields and no columns**, and our own generated step page is one: it scored
   * `WARN declared term paths not used by the page` while carrying exactly the
   * two fields the requirement asked for.
   *
   * Eighth instance of F-89 / F-92 / F-118 / F-173 / F-180 / F-182 / F-189 — a
   * rule that reports a correct artifact as wrong. WARN kept it out of the
   * regeneration loop, which is why it cost a sentence rather than three
   * attempts; the model had to explain it away to the engineer instead.
   */
  let sites = 0;
  const visit = (w: unknown): void => {
    if (!w || typeof w !== "object") return;
    const st = (w as { settings?: Record<string, unknown> }).settings;
    if (!st) return;
    for (const c of (st["columns"] as Array<Record<string, unknown>> | undefined) ?? []) {
      sites += 1;
      if (c?.["path"]) used.add(String(c["path"]));
    }
    for (const f of (st["filters"] as Array<Record<string, unknown>> | undefined) ?? []) {
      sites += 1;
      if (f?.["property"]) used.add(String(f["property"]));
    }
    for (const k of INNER_WIDGET_KEYS) visit(st[k]);
  };
  for (const w of j.widgets ?? []) visit(w);

  if (sites === 0) {
    r.push({
      level: "PASS",
      name: `${declared.length} declared term path(s) - the page binds none`,
      // ASCII hyphen: the Python oracle compares this line byte for byte.
      detail: "no column or filter carries a path on this page, so there is " +
              "nothing for a declared term to contradict",
    });
    return;
  }

  const contradicted = declared.filter((t) => !used.has(String(t.path)));
  if (!contradicted.length) {
    r.push({
      level: "PASS",
      name: `all ${declared.length} declared term path(s) appear in the page`,
      detail: "",
    });
    return;
  }
  r.push({
    level: "WARN", name: "declared term paths not used by the page",
    // ASCII hyphen: the Python oracle compares this line byte for byte.
    detail: `${pyRepr(contradicted.map((t) => `${t.term}->${t.path}`))} - the descriptor ` +
            `resolved these and the page uses a different path`,
  });
}

export function checkFilterCoverage(
  j: PageSettings, spec: EffectiveSpec, r: Result[],
): void {
  const panels = spec.filters ?? [];
  if (!panels.length) return;

  /* Both shapes count, and nested widgets are walked because a Filter's fields
     may sit on the Filter while the grid it wraps sits inside it. */
  const offered = new Set<string>();
  /* COUNTED SEPARATELY FROM THE KEYS. `offered` holds normalised match keys and
     one filter contributes several of them (its property, its label, and the
     stems of each), so its size is not the number of fields the page offers.
     Using it as one made a page that really was short two filters report a
     naming divergence — the gate caught that on its first run. */
  let offeredCount = 0;
  const offer = (v: unknown): void => { for (const c of labelKeys(v)) offered.add(c); };
  const visit = (w: unknown): void => {
    if (!w || typeof w !== "object") return;
    const settings = (w as { settings?: Record<string, unknown> }).settings;
    if (!settings) return;
    for (const f of (settings["filters"] as Array<Record<string, unknown>> | undefined) ?? []) {
      offeredCount += 1;
      offer(f["property"]);
      offer(f["label"]);
    }
    for (const f of (settings["fields"] as Array<Record<string, unknown>> | undefined) ?? []) {
      offeredCount += 1;
      const prop = f["property"] as Record<string, unknown> | undefined;
      offer(prop?.["label"]);
      offer(prop?.["path"]);
      offer(prop?.["name"]);
    }
    for (const key of INNER_WIDGET_KEYS) visit(settings[key]);
  };
  for (const w of j.widgets ?? []) visit(w);

  const wanted = panels.flatMap((p) => p.fields);
  const unmatched = wanted.filter((name) => !labelKeys(name).some((k) => offered.has(k)));

  /*
   * A NAME THAT DOES NOT MATCH IS NOT THE SAME AS A FILTER THAT IS NOT THERE.
   *
   * Measured 2026-08-28 on a real run. The story asks to filter by "Storage
   * Step", "Batch" and "Material"; the page offered three filters — `Step`
   * labelled `$(StepColumnLabel)`, `ManufacturerLotNumber` labelled
   * `$(CustomBatch)`, `Name` labelled `$(MaterialColumnLabel)`. Two matched by
   * label. The third did not, because the SPEC TERM is "Storage Step" and the
   * CMF property is `Step` — a naming divergence, which is the very thing
   * DICTIONARY.md §13 exists to record, and which the model had mapped
   * correctly and said so in its PRD.
   *
   * So the page was right and the check was wrong, and it FAILED — which feeds
   * the regeneration loop, so the run spent attempts chasing a filter that was
   * already there, and the closing message told the engineer their mandatory
   * field was missing. Seventh instance of the F-89 / F-92 / F-118 / F-173 /
   * F-180 / F-182 trap.
   *
   * The distinction the evidence supports, and it is the one this file already
   * draws for grid columns two checks above: if the page offers FEWER filter
   * fields than the story asks for, something really is absent — FAIL. If it
   * offers as many but a term cannot be tied to one, that is a naming
   * divergence a human resolves — WARN, naming the term.
   */
  /* HOW MANY TERMS HAVE NOTHING LEFT TO CORRESPOND TO.
   *
   * Comparing the totals was the first attempt and it is too crude: a page can
   * offer as many fields as the story asks for and still be short one, if two of
   * its fields answer the same term. What decides it is whether each UNMATCHED
   * term still has an UNCLAIMED field it could plausibly be — a naming
   * divergence needs something on the page to diverge FROM.
   *
   * More unmatched terms than unclaimed fields means at least one of them
   * corresponds to nothing at all, and that is genuinely missing. */
  const unclaimed = offeredCount - (wanted.length - unmatched.length);
  const short = unmatched.length > unclaimed;

  if (unmatched.length && short) {
    r.push({
      level: "FAIL", name: "all spec filters present",
      // ASCII hyphen, not an em dash: the Python oracle compares this line byte
      // for byte and its source is ASCII. The first run of the parity pass caught
      // exactly this difference.
      detail: `missing ${pyRepr(unmatched)} - the story asks to filter by these and ` +
              `the page offers no field for them`,
    });
  } else if (unmatched.length) {
    r.push({
      level: "WARN", name: "spec filters: could not auto-verify",
      detail: `${pyRepr(unmatched)} (label/path naming diverges - human check)`,
    });
  } else {
    r.push({ level: "PASS", name: `all ${wanted.length} spec filters present`, detail: "" });
  }
}

/**
 * Every action button must receive at least one inbound link.
 *
 * Found by round 4: three buttons, zero inbound links. Reference integrity passed,
 * because a button nothing points at has no dangling pointer to find. The page
 * imports cleanly and the buttons operate on nothing — exactly the silent-failure
 * class this validator exists to catch.
 *
 * FAIL rather than WARN: a button that receives nothing cannot act on anything.
 * Both real files we hold (Athena's page, 4/4; round 3, 3/3) wire every button. If
 * a legitimate input-less button ever turns up, downgrade this to WARN.
 */
export function checkButtonInputs(j: PageSettings, r: Result[]): void {
  const buttons = new Map<string, string>();
  for (const b of j.actionButtons ?? []) {
    if (b.id) buttons.set(b.id, b.settings?.name ?? b.id);
  }
  /*
   * A `Button` WIDGET is judged the same way, but only once it DECLARES inputs.
   *
   * Its `inputs[]` are link target ports: an entry named `Materials` is fed by
   * `Grid.selectedChange -> Button.Materials`. A button declaring two inputs and
   * receiving no link runs with empty arguments — the same silent failure this
   * check was written for, one mechanism along.
   *
   * The `inputs.length` guard is what keeps this correct rather than merely
   * strict. 11 of the 18 delivered Button widgets declare none: they are plain
   * click handlers whose only wiring is outbound (`onButtonClick -> refresh`).
   * Requiring an inbound link would FAIL the client's own pages, which is the
   * wrong-rule trap this project keeps catching (F-89, F-92, F-118).
   */
  for (const w of buttonWidgetsOf(j)) {
    const declared = (w.settings as { inputs?: unknown[] } | undefined)?.inputs;
    if (w.id && Array.isArray(declared) && declared.length > 0) {
      buttons.set(w.id, w.settings?.name ?? w.id);
    }
  }
  if (buttons.size === 0) return;

  const fed = new Set<string>();
  for (const l of j.links ?? []) {
    const t = l.target;
    if (t && typeof t === "object" && t.id) fed.add(t.id);
  }

  const starved = [...buttons].filter(([id]) => !fed.has(id)).map(([, name]) => name);
  if (starved.length) {
    r.push({
      level: "FAIL", name: "every action button receives input",
      detail: `${starved.length} of ${buttons.size} receive nothing: ${starved.slice(0, 6).join("; ")}`,
    });
  } else {
    r.push({ level: "PASS", name: `all ${buttons.size} action buttons receive input`, detail: "" });
  }
}

/**
 * Every declared data source must be referenced by at least one link.
 *
 * A data source nothing points at is dead weight at best: the page imports
 * cleanly, the query never runs, and whatever was supposed to display its rows
 * shows nothing. Athena's build document states the consequence directly —
 * "a Grid will not display any data unless it is connected to a data source
 * through a Link" — and our own wizard run emitted two data sources wired to
 * nothing while every existing check passed.
 *
 * WARN, NOT FAIL — and that is an evidenced decision, not caution.
 *
 * A-34 called this "the data-source analogue of checkButtonInputs", which is a
 * FAIL. The analogy breaks at the severity. Measured over the 66 distinct
 * base-tenant pages: **4 of 138** non-ambient data sources are referenced by no
 * link, on 4 pages CMF itself holds. FAILing would reject files the authority
 * produced, which is a wrong rule rather than a finding — the same trap that
 * caught the query validator's contiguity assumption (F-89).
 *
 * WARN is also the safe level for a second reason. Only FAIL feeds the
 * regeneration loop, and pushing the model to wire an orphan would invite it to
 * invent a link. A human looking at an unused data source is the right outcome;
 * a generator inventing wiring to silence a check is not.
 *
 * BOTH ENDS COUNT. A data source can be driven (a grid's selection feeding its
 * parameter) or read (its dataChange feeding a grid). Requiring it to be a link
 * SOURCE would reject Athena's own CustomChangePriorityWizard, whose
 * `wizardServiceCall` is only ever written to — and 13 of the 66 live pages.
 */
export function checkDataSourceUse(j: PageSettings, r: Result[]): void {
  const sources = new Map<string, string>();
  let ambient = 0;
  for (const d of j.dataSources ?? []) {
    if (!d.id) continue;
    if (AMBIENT_DATA_SOURCES.includes(d.name ?? "")) { ambient += 1; continue; }
    sources.set(d.id, d.settings?.name ?? d.name ?? d.id);
  }
  if (sources.size === 0) return;

  const referenced = new Set<string>();
  for (const l of j.links ?? []) {
    for (const end of ["source", "target"] as const) {
      const v = l[end];
      const id = v && typeof v === "object" ? v.id : (v as string | null | undefined);
      if (id) referenced.add(id);
    }
  }

  const orphans = [...sources].filter(([id]) => !referenced.has(id)).map(([, n]) => n);
  // The exemption is stated rather than applied silently: a PASS line that
  // quietly excluded things would be the same defect as "both spec queries
  // wired" over an empty list.
  const note = ambient ? `${ambient} ambient source(s) not counted` : "";
  if (orphans.length) {
    r.push({
      level: "WARN", name: "every data source is used by a link",
      detail: `${orphans.length} of ${sources.size} referenced by nothing: ${orphans.slice(0, 6).join("; ")}`,
    });
  } else {
    r.push({
      level: "PASS", name: `all ${sources.size} data sources are used by a link`, detail: note,
    });
  }
}

/**
 * A column carries a type code OR a customTemplate, never both.
 *
 * Observed on the reference page 17/17 in both directions. That is one page, so a
 * divergence is reported as WARN rather than FAIL — the convention is well evidenced
 * but not proven across projects. The second half of the check is the useful one in
 * practice: it catches a generator that left `type: null` because it could not work
 * out whether a field was a date or a number.
 */
export function checkColumnTypes(j: PageSettings, r: Result[]): void {
  const tmplTyped: string[] = [];
  const plainUntyped: string[] = [];

  for (const w of j.widgets ?? []) {
    for (const c of w.settings?.columns ?? []) {
      const t = c.type?.type ?? null;
      const hasTmpl = Boolean(c.customTemplate);
      if (hasTmpl && t !== null) tmplTyped.push(c.name ?? "");
      else if (!hasTmpl && t === null) plainUntyped.push(c.name ?? "");
    }
  }

  if (tmplTyped.length) {
    r.push({
      level: "WARN", name: "customTemplate columns carry no type code",
      detail: `${tmplTyped.length} also set a type: ${tmplTyped.slice(0, 6).join("; ")}`,
    });
  }
  if (plainUntyped.length) {
    r.push({
      level: "WARN", name: "every plain column has a type code",
      detail: `${plainUntyped.length} have neither type nor template: ${plainUntyped.slice(0, 6).join("; ")}`,
    });
  }
  if (!tmplTyped.length && !plainUntyped.length) {
    r.push({ level: "PASS", name: "column type codes consistent with customTemplate rule", detail: "" });
  }
}

/**
 * Selection mode comes from the descriptor, not from a fixed list.
 *
 * Was `want = [1, 2]` — true only because THIS user story happens to ask for a
 * single-select PO grid above a multi-select Materials grid. The descriptor says
 * "single"/"multiple" in the story's own language; SELECTION_MODE translates.
 */
export function checkSelection(j: PageSettings, spec: EffectiveSpec, r: Result[]): void {
  for (const { idx, sgrid, match } of matchGrids(j, spec)) {
    if (!match) continue;          // absence is reported by checkSpecCoverage
    const want = SELECTION_MODE[sgrid.selection as SelectionName];
    const sm = match.settings?.selectionMode;
    if (sm !== want) {
      r.push({
        level: "FAIL", name: `grid ${idx + 1} selectionMode == ${want}`,
        detail: `found ${pyRepr(sm ?? null)}`,
      });
    } else {
      r.push({ level: "PASS", name: `grid ${idx + 1} selectionMode == ${want}`, detail: "" });
    }
  }
}


/**
 * Every widget must be PLACED on the layout, and every placement must point at a
 * real widget.
 *
 * A widget in `widgets[]` with no entry in `layouts[0].widgets` exists in the file
 * and never appears on screen: the page imports cleanly and renders an empty
 * canvas. This is the same failure family as an unwired action button — valid
 * JSON, silently inert — and it was found by previewing a generated page, not by
 * reading it.
 */
/**
 * A page with NO links at all is inert — it renders and does nothing.
 *
 * MEASURED: **0 of the 30 delivered UI pages have zero links.** Every real page
 * wires something, the smallest carrying 3. So unlike the convention checks this
 * is a property of real artifacts, not a house style, and it stays FAIL for both
 * origins.
 *
 * Found by generating Athena's Change Priority wizard from their own enhancement
 * story: it validated PASS 14 / FAIL 0 while carrying one Form, no data source
 * and no links, where their delivered wizard has a `UiPageWidget`, a
 * `ServiceCallDataSource` and 4 links (T-26). Nothing caught it, because no
 * check asked whether the page does anything.
 */
export function checkPageIsWired(j: PageSettings, r: Result[]): void {
  const links = (j.links ?? []).length;
  const widgets = (j.widgets ?? []).length;
  // A page with no widgets either is an empty shell — a different, louder problem
  // that other checks already report; do not pile on.
  if (widgets === 0) return;
  if (links > 0) {
    r.push({ level: "PASS", name: `page is wired (${links} link(s))`, detail: "" });
    return;
  }
  r.push({
    level: "FAIL", name: "page is wired",
    detail: `${widgets} widget(s) and NO links — nothing feeds them, so the page ` +
            `renders and does nothing. 0 of 30 delivered pages have zero links.`,
  });
}

/**
 * Widget ids that another widget HOSTS inside its own settings.
 *
 * A `Filter` wraps the widget it filters: the inner widget is declared in
 * `widgets[]` like any other AND embedded by id under `settings.widgetModel`.
 * It is rendered by its host, so it is deliberately absent from
 * `layouts[0].widgets`.
 *
 * WITHOUT THIS, THE VALIDATOR REJECTS THE AUTHORITY'S OWN FILE. Athena's
 * delivered `200_LoadMaterialsToFeeder.xml` places 4 of its 5 widgets and scored
 * `FAIL every widget is placed on the layout — 1 of 5 never appear on screen:
 * Materials`. The Materials grid appears on screen perfectly well; the Filter
 * draws it. Measured across the delivered corpus: 8 of 8 Filters host an inner
 * widget, so this is the normal shape of that widget and not an oddity.
 *
 * It also matters in the other direction. Only FAIL feeds the regeneration loop,
 * so a page that correctly used a Filter would have been sent back to the model
 * with an instruction to fix something that was already right — F-76's shape,
 * where a check that is wrong for one input forces a wrong artifact.
 */
function hostedWidgetIds(j: PageSettings): Set<string> {
  const hosted = new Set<string>();
  const visit = (w: unknown): void => {
    if (!w || typeof w !== "object") return;
    const settings = (w as { settings?: Record<string, unknown> }).settings;
    if (!settings) return;
    for (const key of INNER_WIDGET_KEYS) {
      const inner = settings[key];
      if (!inner || typeof inner !== "object" || Array.isArray(inner)) continue;
      const id = (inner as { id?: unknown }).id;
      if (typeof id === "string" && id) hosted.add(id);
      visit(inner);   // a host may itself host, and both are rendered by the outermost
    }
  };
  for (const w of j.widgets ?? []) visit(w);
  return hosted;
}

export function checkLayoutPlacement(j: PageSettings, r: Result[]): void {
  const widgets = new Map<string, string>();
  for (const w of j.widgets ?? []) {
    if (w.id) widgets.set(w.id, w.settings?.title ?? w.name ?? w.id);
  }
  if (widgets.size === 0) return;

  const layouts = (j as { layouts?: Array<{ widgets?: Array<{ id?: string }> }> }).layouts;
  const layout = (layouts ?? [])[0];
  const placed = new Set(
    (layout?.widgets ?? []).map((p) => p.id).filter((id): id is string => Boolean(id)),
  );
  // A hosted widget is placed BY ITS HOST. Counted as placed rather than skipped,
  // so the totals still describe every widget on the page.
  for (const id of hostedWidgetIds(j)) placed.add(id);

  const unplaced = [...widgets].filter(([id]) => !placed.has(id)).map(([, n]) => n);
  if (unplaced.length) {
    r.push({
      level: "FAIL",
      name: "every widget is placed on the layout",
      detail:
        `${unplaced.length} of ${widgets.size} never appear on screen: ` +
        `${unplaced.slice(0, 6).join("; ")}` +
        (placed.size === 0 ? " (layouts[0].widgets is empty)" : ""),
    });
  } else {
    r.push({
      level: "PASS", name: `all ${widgets.size} widgets are placed on the layout`, detail: "",
    });
  }

  // A span wider than the grid is not cosmetic: the widget is laid out past the
  // last column, so part or all of it is off-screen.
  const total = Number((layout as { columns?: unknown })?.columns ?? 0);
  if (total > 0) {
    const over: string[] = [];
    for (const pl of layout?.widgets ?? []) {
      const p2 = pl as { id?: string; position?: { column?: number }; dimensions?: { columns?: number } };
      const col = Number(p2.position?.column ?? 1);
      const span = Number(p2.dimensions?.columns ?? 1);
      if (col + span - 1 > total) {
        over.push(`${widgets.get(p2.id ?? "") ?? p2.id}: column ${col} + span ${span} ends at ${col + span - 1}`);
      }
    }
    if (over.length) {
      r.push({
        level: "FAIL", name: "widget placements fit the layout grid",
        detail: `grid is ${total} columns wide; ${over.length} placement(s) run past it — ${over.slice(0, 3).join("; ")}`,
      });
    } else {
      r.push({ level: "PASS", name: `all placements fit the ${total}-column grid`, detail: "" });
    }
  }

  // From the LAYOUT's own entries, not the augmented set: a hosted widget is not
  // a placement, so adding it here would invent an orphan whenever a host
  // embedded a widget that is not separately declared.
  const orphans = (layout?.widgets ?? [])
    .map((p) => p.id).filter((id): id is string => Boolean(id))
    .filter((id) => !widgets.has(id));
  if (orphans.length) {
    r.push({
      level: "FAIL", name: "layout placements resolve to real widgets",
      detail: `${orphans.length} placement(s) reference no widget: ${orphans.slice(0, 4).join("; ")}`,
    });
  }
}
