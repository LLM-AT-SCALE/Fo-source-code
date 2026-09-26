/**
 * COPY-AND-MODIFY — an existing artifact plus a change request, out comes the
 * modified artifact.
 *
 * WHY THIS IS THE SHAPE OF THE FEATURE
 *   Measured across Entegris' own repository (F-114): five of their custom pages
 *   are 92–100% copies of a stock CMF page, one of them identical in widgets,
 *   buttons and links. Their developers do not write pages from scratch — they
 *   take the closest existing page and change it.
 *
 *   That makes Athena's scope item (a) "refer to OOB templates as a baseline" and
 *   item (e) "modify an existing screen" the SAME operation. Only the starting
 *   file differs: a stock page for (a), the customer's own for (e).
 *
 * THE DESIGN CONSTRAINT THAT DECIDES EVERYTHING
 *   Ask B3: *what must never be altered.* An enhancement that silently renumbers,
 *   reorders or drops unrelated content is a regression even when the requested
 *   change is perfectly correct — and it is exactly the kind of damage that
 *   survives review, because the thing you asked for did happen.
 *
 *   So the model does NOT rewrite the file. It emits **named operations**, and our
 *   code applies them to a copy of the original. Everything not named by an
 *   operation is carried across untouched by construction, and `diffSettings`
 *   proves it rather than asserting it.
 *
 * WHY NOT ASK FOR THE WHOLE FILE BACK
 *   A page definition runs to 30,000+ characters. Regenerating it to add one
 *   button means re-emitting every unrelated widget, column and link, and any
 *   drift in that re-emission is a silent regression. Operations make the blast
 *   radius the size of the request.
 */
import { INNER_WIDGET_KEYS } from "../platform";
import type { PageSettings } from "../types";

export class ModifyError extends Error {}

/* ------------------------------------------------------------- operations */

/**
 * The edit vocabulary. Deliberately small and concrete — each operation names
 * exactly what it touches, so a reader of the change report can see the blast
 * radius without reading the artifact.
 */
export type EditOp =
  | { op: "addColumn"; grid: string; column: Record<string, unknown>; after?: string }
  | { op: "removeColumn"; grid: string; path: string }
  /*
   * ADD OR REMOVE A FILTER FIELD.
   *
   * Added 2026-08-28 because its absence was a crash. Asked to add a missing
   * `Storage Step` filter, the model found no operation that fitted and returned
   * ZERO edits; `applyEdits` refuses an empty op list on purpose, so the whole
   * revision died with "the artifact could not be finished" and the engineer was
   * told to try again in different words. There were no different words — the
   * operation did not exist.
   *
   * `filters` arrived on the descriptor with the Filter widget (F-177) and the
   * modify path never got the matching pair, which is the same gap `placeWidget`
   * was added to close: an operation missing is a change request that cannot be
   * expressed at all.
   */
  | { op: "addFilter"; widget: string; filter: Record<string, unknown>; after?: string }
  | { op: "removeFilter"; widget: string; property: string }
  | { op: "addActionButton"; button: Record<string, unknown> }
  | { op: "removeActionButton"; name: string }
  | { op: "addWidget"; widget: Record<string, unknown>; placement?: Record<string, unknown> }
  | { op: "addDataSource"; dataSource: Record<string, unknown> }
  | { op: "addLink"; link: Record<string, unknown> }
  | { op: "removeLink"; output: string; input: string }
  | { op: "setWidgetSetting"; widget: string; key: string; value: unknown }
  /**
   * Place a widget on the layout, or correct an existing placement.
   *
   * Added when writing the fix prompt made the gap obvious: a widget declared but
   * never PLACED is the commonest defect we have (defect 11 — the page imports
   * cleanly and renders an empty canvas), and until this existed the fixer could
   * not repair it. `addWidget` carries a placement, but a widget that already
   * exists and is merely unplaced had no operation at all.
   *
   * Also repairs defect 12 — a span running past the last column — by rewriting
   * the dimensions of a placement that is already there.
   */
  | { op: "placeWidget"; widget: string; position: Record<string, unknown>;
      dimensions: Record<string, unknown> };

export interface Change {
  op: EditOp["op"];
  /** what it touched, in the artifact's own vocabulary — e.g. "Materials.columns" */
  target: string;
  /**
   * The top-level settings key touched — "widgets", "actionButtons", "links"…
   *
   * Separate from `target` because they speak different languages: `target` names
   * the widget a human asked about, the diff walks the structure. Comparing the
   * two directly made the B3 check compare "Materials" against "widgets" and
   * report every legitimate edit as an unexpected change.
   */
  area: string;
  detail: string;
}

export interface ModifyResult {
  settings: PageSettings;
  changes: Change[];
}

/* -------------------------------------------------------- op validation */

/** Required fields per operation, so a malformed edit is refused at the door. */
const REQUIRED: Record<EditOp["op"], string[]> = {
  addColumn: ["grid", "column"],
  removeColumn: ["grid", "path"],
  addFilter: ["widget", "filter"],
  removeFilter: ["widget", "property"],
  addActionButton: ["button"],
  removeActionButton: ["name"],
  addWidget: ["widget"],
  addDataSource: ["dataSource"],
  addLink: ["link"],
  removeLink: ["output", "input"],
  setWidgetSetting: ["widget", "key", "value"],
  placeWidget: ["widget", "position", "dimensions"],
};

/**
 * Turn whatever the model returned into operations, or refuse.
 *
 * The payloads (`column`, `button`, `link`…) are raw CMF JSON, so they cannot be
 * constrained by a schema — which is exactly why they are checked here instead.
 * An operation naming a field it does not carry would otherwise reach `applyEdits`
 * and fail with a confusing message far from the cause.
 */
export function parseEditOps(raw: unknown): EditOp[] {
  const list = Array.isArray(raw)
    ? raw
    : (raw as { operations?: unknown } | null)?.operations;
  if (!Array.isArray(list)) {
    throw new ModifyError(
      "expected an array of operations, or an object with an `operations` array",
    );
  }
  return list.map((o, i) => {
    if (o === null || typeof o !== "object") {
      throw new ModifyError(`operation ${i + 1} is not an object`);
    }
    const rec = o as Record<string, unknown>;
    const op = rec["op"];
    if (typeof op !== "string" || !(op in REQUIRED)) {
      throw new ModifyError(
        `operation ${i + 1} has an unknown op ${JSON.stringify(op)}. ` +
        `Valid: ${Object.keys(REQUIRED).join(", ")}`,
      );
    }
    const missing = (REQUIRED[op as EditOp["op"]]).filter((k) => rec[k] === undefined);
    if (missing.length) {
      throw new ModifyError(
        `operation ${i + 1} (${op}) is missing: ${missing.join(", ")}`,
      );
    }
    return rec as unknown as EditOp;
  });
}

/* ------------------------------------------------------------- accessors */

const settingsName = (e: { settings?: { name?: string | null } | null }): string =>
  e.settings?.name ?? "";

/** A widget by its `settings.name` — the identifier a change request would use. */
function findWidget(j: PageSettings, name: string): Record<string, unknown> {
  const hit = (j.widgets ?? []).find((w) => settingsName(w) === name);
  if (!hit) {
    const have = (j.widgets ?? []).map(settingsName).filter(Boolean).join(", ");
    throw new ModifyError(
      `the source page has no widget named "${name}" (has: ${have || "none"}). ` +
      `An operation that targets nothing would silently do nothing.`,
    );
  }
  return hit as unknown as Record<string, unknown>;
}

/**
 * A Filter widget's field list, created when the widget has none yet.
 *
 * Unlike `columnsOf`, an ABSENT list is not an error: a Filter with no fields is
 * a legitimate starting point, and refusing to add the first one would leave the
 * commonest version of this request — "the page has no filters, add one" —
 * unexpressible, which is the defect this operation exists to fix.
 */
function filtersOf(w: Record<string, unknown>, name: string): Array<Record<string, unknown>> {
  const st = w["settings"] as Record<string, unknown> | undefined;
  if (!st) throw new ModifyError(`widget "${name}" has no settings to modify`);
  if (!Array.isArray(st["filters"])) st["filters"] = [];
  return st["filters"] as Array<Record<string, unknown>>;
}

function columnsOf(w: Record<string, unknown>, name: string): Array<Record<string, unknown>> {
  const st = w["settings"] as Record<string, unknown> | undefined;
  const cols = st?.["columns"];
  if (!Array.isArray(cols)) {
    throw new ModifyError(`widget "${name}" has no columns to modify`);
  }
  return cols as Array<Record<string, unknown>>;
}

/* --------------------------------------------------------------- applier */

/**
 * Apply the operations to a DEEP COPY of the source.
 *
 * Every operation that cannot find its target throws rather than doing nothing:
 * a change request that silently applies zero of its three edits, and reports
 * success, is the worst outcome available here.
 */
/**
 * A HOSTED WIDGET IS THE SAME OBJECT SERIALISED TWICE, AND BOTH COPIES MUST MOVE.
 *
 * A Filter contains the widget it narrows under `settings.widgetModel`, and that
 * widget is ALSO declared in `widgets[]` under the same id (F-173). Two copies,
 * one object. `findWidget` searches `widgets[]` only, so every operation edited
 * the declaration and left the hosted copy behind.
 *
 * That is worse than it sounds, because THE LAYOUT PLACES THE HOST. CMF draws
 * the Filter, and the Filter draws its own inner copy - so the edited
 * declaration is the copy nobody renders.
 *
 * MEASURED 2026-09-01 on US-1122. "Rename the Serial column heading to SN"
 * reported success, the file changed, and the screen would have kept saying
 * $(CustomSerial): the top-level grid said SN, the hosted grid still said
 * $(CustomSerial), and no check compared them. A change that silently does
 * nothing while reporting that it worked is the failure mode this pipeline
 * exists to refuse.
 *
 * Applied as a pass AFTER the operations rather than inside each of them: it
 * then holds for every operation, including ones added later that nobody
 * remembers to make host-aware.
 *
 * The DECLARATION is canonical. It is the entry the operations target and the
 * one `widgets[]` is keyed by; the hosted copy is a rendering of it.
 *
 * `$id` is not a problem here even though this duplicates markers: `assemble`
 * re-numbers every marker in document order on write, which is the same reason
 * `$id` is excluded from the blast-radius diff below.
 */
function syncHostedCopies(j: PageSettings): void {
  const byId = new Map<string, Record<string, unknown>>();
  for (const w of j.widgets ?? []) {
    const id = (w as Record<string, unknown>)["id"];
    if (typeof id === "string" && id) byId.set(id, w as unknown as Record<string, unknown>);
  }
  if (byId.size === 0) return;

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const v of node) walk(v); return; }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    for (const key of INNER_WIDGET_KEYS) {
      const held = o[key];
      if (!held || typeof held !== "object" || Array.isArray(held)) continue;
      const id = (held as Record<string, unknown>)["id"];
      const canonical = typeof id === "string" ? byId.get(id) : undefined;
      /* Only when the declaration exists. A hosted widget with no top-level
         entry is a different shape, and overwriting it with nothing would
         delete a widget the page needs. */
      if (canonical) o[key] = JSON.parse(JSON.stringify(canonical)) as unknown;
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(j as unknown);
}

/**
 * THE `UNKNOWN` MARKERS THIS EDIT INTRODUCED, COUNTED BY US RATHER THAN NARRATED.
 *
 * A caption must be a `$(MessageName)`. When a change request asks for wording
 * no evidenced name renders, the correct answer is `$(UNKNOWN_<Wording>)` - a
 * marker that cannot be mistaken for a real name and tells the engineer which
 * message they need to create.
 *
 * MEASURED 2026-09-01. The edit emitted `$(UNKNOWN_SN)` correctly, and the
 * summary told the engineer the opposite: that the heading had been written as
 * "plain text rather than a $(...) reference", and that this was "legitimate -
 * plain captions are common in your own pages". Neither half was true. Plain
 * captions FAIL the label rule, and the file did not contain one.
 *
 * A summary that contradicts the artifact is worse than no summary: the
 * engineer believes the page is finished when a message still has to be
 * created. So the facts are extracted here and handed to the narration, rather
 * than left to be remembered.
 *
 * INTRODUCED, not merely present: a page that already carried a marker has
 * already been reported on, and repeating it every revision trains the reader
 * to skip the line.
 */
export function introducedUnknowns(before: PageSettings, after: PageSettings): string[] {
  const find = (v: unknown): Set<string> => {
    const out = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      if (typeof node === "string") {
        const m = /^\$\(UNKNOWN_[^)]*\)$/.exec(node);
        if (m) out.add(node);
        return;
      }
      if (!node || typeof node !== "object") return;
      for (const x of Object.values(node as Record<string, unknown>)) walk(x);
    };
    walk(v);
    return out;
  };
  const was = find(before);
  return [...find(after)].filter((u) => !was.has(u)).sort();
}

export function applyEdits(source: PageSettings, ops: readonly EditOp[]): ModifyResult {
  if (ops.length === 0) {
    throw new ModifyError(
      "no operations — a change request that produces no edits has been misread, " +
      "and returning the file unchanged would hide that",
    );
  }
  const j = JSON.parse(JSON.stringify(source)) as PageSettings;
  const changes: Change[] = [];

  for (const op of ops) {
    switch (op.op) {
      case "addColumn": {
        const w = findWidget(j, op.grid);
        const cols = columnsOf(w, op.grid);
        const path = String(op.column["path"] ?? "");
        if (cols.some((c) => c["path"] === path)) {
          throw new ModifyError(`"${op.grid}" already has a column with path "${path}"`);
        }
        let at = cols.length;
        if (op.after !== undefined) {
          const i = cols.findIndex((c) => c["path"] === op.after);
          if (i < 0) throw new ModifyError(`"${op.grid}" has no column "${op.after}" to insert after`);
          at = i + 1;
        }
        cols.splice(at, 0, op.column);
        changes.push({ op: op.op, target: `${op.grid}.columns`, area: "widgets",
          detail: `added "${path}" at position ${at + 1} of ${cols.length}` });
        break;
      }
      case "removeColumn": {
        const w = findWidget(j, op.grid);
        const cols = columnsOf(w, op.grid);
        const i = cols.findIndex((c) => c["path"] === op.path);
        if (i < 0) throw new ModifyError(`"${op.grid}" has no column with path "${op.path}"`);
        cols.splice(i, 1);
        changes.push({ op: op.op, target: `${op.grid}.columns`, area: "widgets", detail: `removed "${op.path}"` });
        break;
      }
      case "addFilter": {
        const w = findWidget(j, op.widget);
        const list = filtersOf(w, op.widget);
        const prop = String(op.filter["property"] ?? "");
        if (list.some((f) => f["property"] === prop)) {
          throw new ModifyError(`"${op.widget}" already has a filter on "${prop}"`);
        }
        let at = list.length;
        if (op.after !== undefined) {
          const i = list.findIndex((f) => f["property"] === op.after);
          if (i < 0) {
            throw new ModifyError(`"${op.widget}" has no filter "${op.after}" to insert after`);
          }
          at = i + 1;
        }
        list.splice(at, 0, op.filter);
        changes.push({ op: op.op, target: `${op.widget}.filters`, area: "widgets",
          detail: `added "${prop}" at position ${at + 1} of ${list.length}` });
        break;
      }
      case "removeFilter": {
        const w = findWidget(j, op.widget);
        const list = filtersOf(w, op.widget);
        const i = list.findIndex((f) => f["property"] === op.property);
        if (i < 0) {
          throw new ModifyError(`"${op.widget}" has no filter on "${op.property}"`);
        }
        list.splice(i, 1);
        changes.push({ op: op.op, target: `${op.widget}.filters`, area: "widgets",
          detail: `removed "${op.property}"` });
        break;
      }
      case "addActionButton": {
        const list = (j.actionButtons ??= []);
        const name = String((op.button["settings"] as Record<string, unknown> | undefined)?.["name"] ?? "");
        if (list.some((b) => settingsName(b) === name)) {
          throw new ModifyError(`the source page already has an action button named "${name}"`);
        }
        list.push(op.button as never);
        changes.push({ op: op.op, target: "actionButtons", area: "actionButtons", detail: `added "${name}"` });
        break;
      }
      case "removeActionButton": {
        const list = j.actionButtons ?? [];
        const i = list.findIndex((b) => settingsName(b) === op.name);
        if (i < 0) throw new ModifyError(`no action button named "${op.name}"`);
        list.splice(i, 1);
        changes.push({ op: op.op, target: "actionButtons", area: "actionButtons", detail: `removed "${op.name}"` });
        break;
      }
      case "addWidget": {
        const list = (j.widgets ??= []);
        const name = String((op.widget["settings"] as Record<string, unknown> | undefined)?.["name"] ?? "");
        list.push(op.widget as never);
        let placed = "";
        if (op.placement) {
          const layouts = (j as { layouts?: Array<Record<string, unknown>> }).layouts;
          const l0 = layouts?.[0];
          if (!l0) throw new ModifyError("the source page has no layouts[0] to place a widget into");
          const pl = (l0["widgets"] ??= []) as Array<Record<string, unknown>>;
          pl.push(op.placement);
          placed = " and placed on the layout";
        }
        changes.push({ op: op.op, target: "widgets", area: "widgets", detail: `added "${name}"${placed}` });
        if (op.placement) changes.push({ op: op.op, target: "layouts[0].widgets", area: "layouts", detail: `placed "${name}"` });
        break;
      }
      case "addDataSource": {
        const list = (j.dataSources ??= []);
        const name = String((op.dataSource["settings"] as Record<string, unknown> | undefined)?.["name"] ?? "");
        list.push(op.dataSource as never);
        changes.push({ op: op.op, target: "dataSources", area: "dataSources", detail: `added "${name}"` });
        break;
      }
      case "addLink": {
        const list = (j.links ??= []);
        list.push(op.link as never);
        changes.push({ op: op.op, target: "links", area: "links",
          detail: `added ${String(op.link["output"])} -> ${String(op.link["input"])}` });
        break;
      }
      case "removeLink": {
        const list = j.links ?? [];
        const i = list.findIndex((l) => l.output === op.output && l.input === op.input);
        if (i < 0) throw new ModifyError(`no link ${op.output} -> ${op.input}`);
        list.splice(i, 1);
        changes.push({ op: op.op, target: "links", area: "links", detail: `removed ${op.output} -> ${op.input}` });
        break;
      }
      case "placeWidget": {
        const w = findWidget(j, op.widget);
        const id = w["id"];
        if (typeof id !== "string" || !id) {
          throw new ModifyError(`widget "${op.widget}" has no id, so it cannot be placed`);
        }
        const layouts = (j as { layouts?: Array<Record<string, unknown>> }).layouts;
        const l0 = layouts?.[0];
        if (!l0) throw new ModifyError("the page has no layouts[0] to place a widget into");
        const list = (l0["widgets"] ??= []) as Array<Record<string, unknown>>;

        // A span past the last column puts part of the widget off-screen — the
        // same rule the framework's own packer applies, so a "fix" that violated
        // it would just move the defect.
        const total = Number(l0["columns"] ?? 0);
        const col = Number(op.position["column"] ?? 1);
        const span = Number(op.dimensions["columns"] ?? 1);
        if (total > 0 && col + span - 1 > total) {
          throw new ModifyError(
            `placing "${op.widget}" at column ${col} spanning ${span} ends at ` +
            `${col + span - 1}, past the ${total}-column grid`,
          );
        }

        const existing = list.findIndex((pl) => pl["id"] === id);
        if (existing >= 0) {
          list[existing] = { ...list[existing], position: op.position, dimensions: op.dimensions };
          changes.push({ op: op.op, target: "layouts[0].widgets", area: "layouts",
            detail: `repositioned "${op.widget}" to row ${String(op.position["row"])} ` +
                    `column ${col}, spanning ${span}` });
        } else {
          list.push({ id, position: op.position, dimensions: op.dimensions });
          changes.push({ op: op.op, target: "layouts[0].widgets", area: "layouts",
            detail: `placed "${op.widget}" at row ${String(op.position["row"])} ` +
                    `column ${col}, spanning ${span} — it was declared but never rendered` });
        }
        break;
      }
      case "setWidgetSetting": {
        const w = findWidget(j, op.widget);
        // A dotted key is a misunderstanding, not a path. This sets ONE key on
        // `settings`; it cannot traverse. A fix run once sent
        // `placement.dimensions.columns` here and silently created a key with
        // dots in its name — the operation "succeeded", the defect remained, and
        // the artifact gained a nonsense field. Refuse and point at the right op.
        if (op.key.includes(".")) {
          throw new ModifyError(
            `setWidgetSetting cannot traverse "${op.key}" — it sets a single key on ` +
            `settings. For layout geometry use placeWidget.`,
          );
        }
        const st = w["settings"] as Record<string, unknown>;
        const was = st[op.key];
        st[op.key] = op.value;
        changes.push({ op: op.op, target: `${op.widget}.${op.key}`, area: "widgets",
          detail: `${JSON.stringify(was)} -> ${JSON.stringify(op.value)}` });
        break;
      }
      default: {
        throw new ModifyError(`unknown operation: ${JSON.stringify(op)}`);
      }
    }
  }

  /* Both copies of every hosted widget, before anything reads the result. */
  syncHostedCopies(j);

  return { settings: j, changes };
}

/* ------------------------------------------------------------------ diff */

export interface Diff {
  added: string[];
  removed: string[];
  changed: Array<{ path: string; from: unknown; to: unknown }>;
}

/**
 * Structural diff of two page definitions.
 *
 * `$id` is EXCLUDED on purpose. It is a positional counter our code assigns, so
 * inserting anything necessarily renumbers everything after it — that is
 * arithmetic, not a content change, and including it would drown the real diff.
 *
 * *(Worth confirming with Athena: B3 lists "the numbering of unrelated elements"
 * among the things that must not change. For `$id` that is not achievable while
 * inserting, and CMF reassigns the root marker on import anyway.)*
 */
export function diffSettings(before: unknown, after: unknown, path = ""): Diff {
  const out: Diff = { added: [], removed: [], changed: [] };

  const walk = (a: unknown, b: unknown, p: string): void => {
    if (p.endsWith(".$id")) return;

    const aArr = Array.isArray(a), bArr = Array.isArray(b);
    if (aArr || bArr) {
      const A = (aArr ? a : []) as unknown[];
      const B = (bArr ? b : []) as unknown[];

      // MATCH BY IDENTITY, NOT POSITION.
      //
      // Comparing arrays index-by-index makes an insertion look like a rewrite:
      // adding one column at position 2 shifts every column after it, and the
      // diff reported "2 added, 7 removed, 22 changed" for a single addition.
      // That is not a blast radius, it is an artefact of the comparison — and it
      // would have buried a genuine unrelated change in the noise.
      //
      // Elements are matched on the first stable identifier they carry: `id` for
      // widgets, buttons, links and placements; `path` for columns; `name`
      // otherwise. Positional comparison is the fallback for arrays of scalars.
      const keyOf = (v: unknown): string | undefined => {
        if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
        const o = v as Record<string, unknown>;
        for (const k of ["id", "path", "name"]) {
          const x = o[k];
          if (typeof x === "string" && x) return `${k}=${x}`;
        }
        return undefined;
      };
      const aKeys = A.map(keyOf), bKeys = B.map(keyOf);
      const keyed = A.length > 0 && B.length > 0 &&
        aKeys.every(Boolean) && bKeys.every(Boolean) &&
        new Set(aKeys).size === A.length && new Set(bKeys).size === B.length;

      if (keyed) {
        const bMap = new Map(B.map((v, i) => [bKeys[i] as string, v]));
        const aMap = new Map(A.map((v, i) => [aKeys[i] as string, v]));
        for (const [k, av] of aMap) {
          const bv = bMap.get(k);
          if (bv === undefined) out.removed.push(`${p}[${k}]`);
          else walk(av, bv, `${p}[${k}]`);
        }
        for (const k of bMap.keys()) if (!aMap.has(k)) out.added.push(`${p}[${k}]`);
        return;
      }

      for (let i = 0; i < Math.max(A.length, B.length); i++) {
        if (i >= A.length) out.added.push(`${p}[${i}]`);
        else if (i >= B.length) out.removed.push(`${p}[${i}]`);
        else walk(A[i], B[i], `${p}[${i}]`);
      }
      return;
    }

    const aObj = a !== null && typeof a === "object";
    const bObj = b !== null && typeof b === "object";
    if (aObj && bObj) {
      const A = a as Record<string, unknown>;
      const B = b as Record<string, unknown>;
      for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
        if (k === "$id") continue;
        const q = p ? `${p}.${k}` : k;
        if (!(k in A)) out.added.push(q);
        else if (!(k in B)) out.removed.push(q);
        else walk(A[k], B[k], q);
      }
      return;
    }

    if (JSON.stringify(a) !== JSON.stringify(b)) out.changed.push({ path: p, from: a, to: b });
  };

  walk(before, after, path);
  return out;
}

/**
 * The blast radius, as one line per touched area.
 *
 * Collapsed to the top two path segments: a reader wants "one column was added to
 * the Materials grid", not eleven leaf paths under the new column.
 */
export function summariseDiff(d: Diff): string[] {
  const area = (p: string): string => p.split(".").slice(0, 2).join(".") || p;
  const seen = new Map<string, { added: number; removed: number; changed: number }>();
  const bump = (p: string, k: "added" | "removed" | "changed"): void => {
    const a = area(p);
    const e = seen.get(a) ?? { added: 0, removed: 0, changed: 0 };
    e[k] += 1;
    seen.set(a, e);
  };
  d.added.forEach((p) => bump(p, "added"));
  d.removed.forEach((p) => bump(p, "removed"));
  d.changed.forEach((c) => bump(c.path, "changed"));

  return [...seen].map(([a, e]) => {
    const bits = [
      e.added ? `${e.added} added` : "",
      e.removed ? `${e.removed} removed` : "",
      e.changed ? `${e.changed} changed` : "",
    ].filter(Boolean);
    return `${a}: ${bits.join(", ")}`;
  });
}

/**
 * Did anything change outside the areas the operations claimed to touch?
 *
 * This is the B3 guarantee made checkable. `applyEdits` makes untouched content
 * impossible to disturb by construction; this proves it against the actual
 * before/after, so a future operation that reaches further than it says cannot
 * pass silently.
 */
export function unexpectedChanges(diff: Diff, changes: readonly Change[]): string[] {
  const claimed = new Set(changes.map((c) => c.area));
  const area = (p: string): string => (p.split(/[.[]/)[0] ?? p);
  const all = [...diff.added, ...diff.removed, ...diff.changed.map((c) => c.path)];
  return [...new Set(all.map(area))].filter((a) => a && !claimed.has(a));
}
