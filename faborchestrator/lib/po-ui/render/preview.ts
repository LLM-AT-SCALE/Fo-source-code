/**
 * PREVIEW — render a CMF UI Page export the way CMF renders it.
 *
 * WHAT CHANGED, AND WHY (D-05, decided 2026-08-20)
 *   This was a deliberately neutral wireframe. The user's decision is that the
 *   preview should show what a developer will actually see in the CMF client, so
 *   an engineer can judge the screen before it is ever imported.
 *
 * WHERE THE LINE IS, AND IT IS A REAL ONE
 *   - Every style below is OURS. No Critical Manufacturing stylesheet, LESS file
 *     or compiled CSS is copied or shipped.
 *   - No CMF icon font. Their icons are a distributed binary asset; we draw a
 *     small set of inline SVG approximations and always keep the declared icon
 *     class visible in the inspect overlay, so nothing is silently faked.
 *   - `customTemplate` markup is STILL NOT EXECUTED. It is untrusted client HTML
 *     and JS arriving from a generated file; running it in an engineer's browser
 *     to make a mock prettier is a bad trade. Those cells render a static
 *     approximation and are labelled as such.
 *   - Colours and metrics are OBSERVED VALUES read from the running client
 *     (`_working/pkg/cmf-live/CMF-THEME.json`) — the same class of knowledge as
 *     every enum we have read from the public bundle. Targeting the same values
 *     is not the same act as shipping their stylesheet.
 *
 * STILL TRUE, AND STILL THE POINT
 *   Passing this preview proves the page is laid out as the story asked. It
 *   proves nothing about whether CMF will import the file.
 *
 * NO APPLICATION BAR (2026-08-27)
 *   The blue product strip with its burger menu used to head every preview. The
 *   argument for it was that it helps an engineer read the mock as sitting
 *   inside the target client — but it is chrome the generator does not produce
 *   and cannot be asked to change, so it spent the widest band of the preview
 *   on the one part of the screen that is not the subject. It was already being
 *   cut from every copy that went to the client (LEDGER §21), which is the
 *   clearest signal available that it was not earning its place.
 *
 *   The tab strip below it stays: that one carries the PAGE NAME, which is a
 *   value this generator does own.
 */
import { existsSync, readFileSync } from "node:fs";
import { INNER_WIDGET_KEYS, SELECTION_MODE } from "../platform";
import { loadPipelineConfig } from "../generate/config";

const UNKNOWN = /UNKNOWN/i;

/* ---------------------------------------------------------------- theme
 * Observed from the running client, default Blue theme. Slot meanings come from
 * the public Design System documentation. Kept as one block so a different theme
 * is a data change rather than a code change.
 */
const T = {
  bg: "#fafafa",          // styleColor000 page background
  primary: "#0066a1",     // styleColor001 primary
  secondary: "#afcde1",   // styleColor002
  selected: "#c8e1f0",    // styleColor003
  text: "#000000",        // styleColor004
  widgetBg: "#ffffff",    // styleColor005 widget background
  onPrimary: "#ffffff",   // styleColor008
  tabBg: "#007ac9",       // styleColor201 tab background
  toolbarBg: "#fafafa",   // styleColor301
  red: "#ea4232", green: "#50b450", yellow: "#f9c833", orange: "#e15532", gray: "#8c8c8c",
  line: "rgba(0,0,0,.1)",
};

export interface PreviewMeta {
  title: string;
  source: string;
  note?: string;
  /**
   * What the structure was read FROM, named in the footer.
   *
   * Defaults to the generated page definition, which is where it came from until
   * 2026-08-21. A descriptor-sourced preview must say so instead: the footer
   * claiming a generated definition while the header says "drawn from the
   * requirement" is a contradiction a reader would rightly not trust.
   */
  origin?: string;
}

/* ---------------------------------------------------------------- labels */

let LABELS: Record<string, string> = {};

/**
 * Message name -> on-screen text, so the mock shows the words a user reads.
 *
 * Accepts BOTH shapes, and merges them:
 *   - `dictionary.json`   `{ messageText: [{key,value}] }`  — ~20 entries
 *   - `MESSAGE-TEXT.json` `{ text: {name: text} }`          — 4,518 EN-US entries
 *
 * The second is the platform's own message table, built for the GUI-test gate and
 * validated against the server's own resolver at 86/86 (F-139). Loading only the
 * first left most labels unresolved, so the mock showed a derived guess in orange
 * where CMF shows the real word.
 */
export function loadLabels(...paths: string[]): number {
  const merged: Record<string, string> = {};
  for (const p of paths) {
    if (!p || !existsSync(p)) continue;
    try {
      const d = JSON.parse(readFileSync(p, "utf-8")) as {
        messageText?: Array<{ key: string; value: string }>;
        text?: Record<string, string>;
      };
      for (const e of d.messageText ?? []) merged[e.key] = e.value;
      for (const [k, v] of Object.entries(d.text ?? {})) if (!(k in merged)) merged[k] = v;
    } catch { /* a malformed source contributes nothing rather than throwing */ }
  }
  LABELS = merged;
  return Object.keys(LABELS).length;
}

const esc = (x: unknown): string => String(x ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** the words a user would see; the raw token when we cannot resolve it */
function labelText(text: unknown): { shown: string; resolved: boolean; raw: string } {
  const s = String(text ?? "");
  const m = /^\$\((\w+)\)$/.exec(s);
  if (m?.[1] && LABELS[m[1]]) return { shown: LABELS[m[1]] as string, resolved: true, raw: s };
  if (m?.[1]) return { shown: m[1].replace(/([a-z0-9])([A-Z])/g, "$1 $2"), resolved: false, raw: s };
  return { shown: s || "—", resolved: !UNKNOWN.test(s), raw: s };
}

/* ------------------------------------------------------------ sample data
 * A grid with no rows tells an engineer nothing about spacing or truncation, so
 * we draw a few plausible rows. They are OBVIOUSLY placeholders and the overlay
 * says so — inventing data that looked real would be its own kind of lie.
 */
/**
 * A stable per-COLUMN offset, so two columns of the same type never twin.
 *
 * The first version varied by row only. Every reference column in a row
 * therefore showed the same lot id, and every integer column the same number —
 * `Material` and `Step` both read `544428031Y23|AGRTis`, `Priority` and
 * `HoldCount` both read `5`. That makes the preview read as though the screen
 * duplicates data, which is the opposite of what it is for.
 *
 * Hashed rather than indexed by position, so a column keeps its values when a
 * neighbour is added or removed. That matters more than it looks: the preview is
 * the thing an engineer compares before and after a change, and values that
 * shuffle on every edit would swamp the change they were looking for.
 */
function columnSeed(path: string): number {
  let h = 2166136261;
  for (let i = 0; i < path.length; i += 1) {
    h = Math.imul(h ^ path.charCodeAt(i), 16777619) >>> 0;
  }
  return h;
}

const pick = <T,>(pool: readonly T[] | undefined, path: string, row: number): T | string =>
  pool && pool.length ? (pool[(columnSeed(path) + row) % pool.length] as T) : "";

/*
 * Pools chosen so a REFERENCE column looks like the thing it points at. A Step
 * column showing a lot id is wrong in a way an engineer notices immediately, and
 * "it is only sample data" does not excuse it — the point of the preview is that
 * it reads like the real screen.
 *
 * THE VALUES ARE CONFIG, AND THE DEFAULTS BELOW ARE DELIBERATELY NEUTRAL.
 * They were the client's own vocabulary until 2026-08-28 — their site names,
 * their lot-id format, and the login names of two people who work there. That is
 * a case-specific value in source under any reading of the standing rule, and the
 * personal names make it worse than most: a mock screen for a different client
 * would have shown them.
 *
 * `preview.sampleData` in `pipeline.json` overrides any pool by name, so a
 * deployment that wants domain-flavoured mock data says so in config. Nothing
 * here is load-bearing for correctness — every preview carries a disclaimer
 * naming this as placeholder data.
 */
const DEFAULT_POOL: Readonly<Record<string, readonly string[]>> = {
  lot: ["LOT-000181|0001", "LOT-000182|0001", "LOT-000183|0002", "LOT-000184|0002"],
  product: ["PRD-1000-A", "PRD-1000-B", "PRD-2000-A", "PRD-2000-B"],
  step: ["Assembly", "Inspection", "Packing", "Test"],
  resource: ["RES-01", "RES-02", "RES-03", "RES-04"],
  user: ["operator1", "operator2", "supervisor1", "system"],
  site: ["Site A", "Site B", "Site C", "Site D"],
  state: ["In Process", "Queued", "Closed", "On Hold"],
  text: ["Holding time", "Awaiting material", "Priority raised", "Split from parent"],
  date: ["07/16/2026 10:45 AM", "07/16/2026 11:10 AM", "02/18/2026 08:00 PM",
         "11/03/2026 06:20 AM"],
};

/** Config-supplied pools win per key; anything unnamed keeps its neutral default. */
function samplePools(): Readonly<Record<string, readonly string[]>> {
  let configured: Record<string, string[]> = {};
  try {
    configured = loadPipelineConfig().preview?.sampleData ?? {};
  } catch { /* the preview must render without a pipeline config */ }
  const out: Record<string, readonly string[]> = { ...DEFAULT_POOL };
  for (const [k, v] of Object.entries(configured)) {
    if (Array.isArray(v) && v.length) out[k] = v;
  }
  return out;
}

const POOL = samplePools();

/*
 * Numbers are DERIVED, not picked from a pool.
 *
 * A six-value pool put two numeric columns on the same value whenever their
 * seeds were congruent mod 6 — a one-in-six chance per pair, which duly hit both
 * `Quantity`/`ActiveMaterialsCount` and `HoldCount`/`Priority`. Deriving from
 * the hash gives each column its own base and its own stride, so twinning needs
 * an actual collision rather than a modular coincidence.
 *
 * Kept small and plausible: a HoldCount of 837 would be its own kind of lie.
 */
function sampleNumber(seed: string, row: number): number {
  const h = columnSeed(seed);
  const base = 1 + (h % 37);
  const stride = 1 + ((h >>> 8) % 5);
  return base + row * stride;
}

function sampleCell(path: string, type: number | null, row: number): string {
  const p = (path || "").toLowerCase();
  if (type === 3) return (columnSeed(p) + row) % 2 ? "✓" : "✕";
  if (type === 2 || /date|on$/.test(p)) return pick(POOL.date, p, row);
  if (type === 5 || type === 1 || /count|quantity|priority|sequence/.test(p)) {
    return String(sampleNumber(p, row));
  }
  if (/state|status/.test(p)) return pick(POOL.state, p, row);
  // Reference columns, narrowed to the entity the path names.
  if (/step|operation|route/.test(p)) return pick(POOL.step, p, row);
  if (/resource|equipment|tool|chamber/.test(p)) return pick(POOL.resource, p, row);
  if (/product/.test(p)) return pick(POOL.product, p, row);
  if (/facility|site|area|location/.test(p)) return pick(POOL.site, p, row);
  if (/by$|user|owner|operator/.test(p)) return pick(POOL.user, p, row);
  if (/name|id$/.test(p) || type === 11) return pick(POOL.lot, p, row);
  return pick(POOL.text, p, row);
}

/* ---------------------------------------------------------------- icons
 * Our own glyphs. The declared CMF class is always shown in the overlay.
 */
const ICONS: Record<string, string> = {
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/>',
  new: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
  hold: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  release: '<path d="M7 4l12 8-12 8z"/>',
  print: '<path d="M6 9V3h12v6M6 18H4v-6h16v6h-2M8 14h8v7H8z"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
};
function iconFor(cls: string): string {
  const c = (cls || "").toLowerCase();
  for (const k of Object.keys(ICONS)) if (c.includes(k)) return ICONS[k] as string;
  return '<circle cx="12" cy="12" r="7"/>';
}
const svg = (body: string, size = 22): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
  `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/* ---------------------------------------------------------------- widgets */

interface Widget { id?: string; name?: string; package?: string; settings?: Record<string, unknown> }

function gridWidget(w: Widget): string {
  const st = (w.settings ?? {}) as Record<string, unknown>;
  const cols = (st["columns"] ?? []) as Array<Record<string, unknown>>;
  const mode = st["selectionMode"];
  const multi = mode === SELECTION_MODE.multiple;
  const title = String(st["title"] ?? "") || String(st["name"] ?? "");
  const rows = 6;

  const head = cols.map((c) => {
    const L = labelText(c["name"]);
    const warn = !L.resolved ? ' class="w"' : "";
    return `<th${warn} title="${esc(L.raw)}">${esc(L.shown)}</th>`;
  }).join("");

  const body = Array.from({ length: rows }, (_, r) => {
    const tds = cols.map((c) => {
      const path = String(c["path"] ?? "");
      /*
       * The seed falls back to the LABEL, and that fallback is the whole fix.
       *
       * A descriptor-derived preview has no data paths at all — paths are decided
       * during generation, so every column arrives with `path: ""`. Seeding on
       * path alone therefore gave every column an identical hash and every cell
       * in a row the same value, which is exactly the twinning this replaced.
       * The label is the one identifier a column always has.
       */
      const seed = path || labelText(c["name"]).shown || String(c["name"] ?? "");
      const type = ((c["type"] ?? {}) as { type?: number }).type ?? null;
      if (c["customTemplate"]) {
        const v = sampleCell(seed, type, r);
        return `<td><span class="chip" data-t="1">${esc(v)}</span></td>`;
      }
      if (UNKNOWN.test(path)) return `<td><span class="unk">UNKNOWN</span></td>`;
      return `<td>${esc(sampleCell(seed, type, r))}</td>`;
    }).join("");
    return `<tr>${multi ? `<td class="sel"><i class="cb"></i></td>` : ""}${tds}</tr>`;
  }).join("");

  return `
<div class="wg">
  <div class="wg-h"><span class="wg-t">${esc(title || "Grid")}</span><span class="cnt">(${rows})</span>
    <span class="sp"></span>${svg('<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M9 4v16M15 4v16"/>', 15)}
    ${svg(ICONS["more"] as string, 15)}</div>
  <div class="wg-b scroll">
    <table class="grid"><thead><tr>${multi ? '<th class="sel"><i class="cb"></i></th>' : ""}${head}</tr></thead>
    <tbody>${body}</tbody></table>
  </div>
  <div class="wg-f">Rows per Page: 25 <b>▾</b><span class="sp"></span>Page 1 of 1 <span class="rec">(${rows} Records)</span></div>
</div>`;
}

function formWidget(w: Widget): string {
  const st = (w.settings ?? {}) as Record<string, unknown>;
  const fields = (st["fields"] ?? []) as Array<Record<string, unknown>>;
  const cells = fields.map((f) => {
    const pr = (f["property"] ?? {}) as Record<string, unknown>;
    const L = labelText(pr["label"] ?? pr["name"]);
    const isRef = Boolean(pr["referenceTypeName"]);
    return `<div class="fld"><label${L.resolved ? "" : ' class="w"'} title="${esc(L.raw)}">${esc(L.shown)}:</label>
      <div class="inp${isRef ? " ref" : ""}"><span class="ph">${isRef ? esc(String(pr["referenceTypeName"])) : ""}</span>
      ${isRef ? svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', 14) : ""}</div></div>`;
  }).join("");
  return `<div class="wg flat"><div class="wg-b filter">${cells}</div></div>`;
}

/**
 * A `Filter` — its own fields, and the widget it WRAPS.
 *
 * The dispatcher below chose a renderer by looking for `settings.columns` (a
 * grid) or `settings.fields` (a form). A Filter has neither: it carries
 * `settings.filters`, and the thing it narrows is serialised INSIDE it under
 * `settings.widgetModel`. So it fell through to `otherWidget` and drew an empty
 * box labelled "Filter" — on a page whose entire point is the filtered list.
 *
 * Measured 2026-08-31 on US-1122: the generated page was correct (PASS 20, FAIL
 * 0) and its preview showed no filters, no columns and no grid. The reader
 * cannot tell that apart from the generator having failed.
 *
 * The Filter and Button widgets were added to the descriptor, the generator and
 * the validator on 2026-08-28 (F-177). Neither renderer was told.
 */
function filterWidget(w: Widget, body: (inner: Widget) => string): string {
  const st = (w.settings ?? {}) as Record<string, unknown>;
  const filters = (st["filters"] ?? []) as Array<Record<string, unknown>>;
  const name = String(st["title"] ?? "") || String(st["name"] ?? "Filter");

  const cells = filters.map((f) => {
    /* A filter's caption may be a message reference, and may legitimately be
       empty — 4 of the 28 delivered filter entries are, because a filter on a
       typed reference renders its entity's own caption. Fall back to the
       PROPERTY so the reader still sees what is being filtered on. */
    const L = labelText(f["label"] || f["property"]);
    return `<div class="fld"><label${L.resolved ? "" : ' class="w"'} title="${esc(L.raw)}">${esc(L.shown)}:</label>
      <div class="inp"><span class="ph"></span></div></div>`;
  }).join("");

  /* The hosted widget, rendered in place. It is a real widget with its own id,
     and CMF draws it here rather than from the layout — which is why it carries
     no placement of its own (F-173). */
  let inner = "";
  for (const k of INNER_WIDGET_KEYS) {
    const h = st[k];
    if (h && typeof h === "object" && !Array.isArray(h)) inner += body(h as Widget);
  }

  return `<div class="wg"><div class="wg-h"><span class="wg-t">${esc(name)}</span></div>
    <div class="wg-b"><div class="frow">${cells}</div>${inner}</div></div>`;
}

/**
 * A `Button` WIDGET — a control in the page body, not in the action bar.
 *
 * Distinct from `actionButtons[]`, which the ribbon draws. The delivered corpus
 * uses both, and which one a story means is not inferable from the artifact —
 * "has typed inputs" is refuted 581 times (F-174) — so the specification says,
 * and the preview has to show what the specification asked for.
 */
function buttonWidget(w: Widget): string {
  const st = (w.settings ?? {}) as Record<string, unknown>;
  const name = String(st["name"] ?? "Button");
  const inputs = ((st["inputs"] ?? []) as Array<unknown>)
    .map((i) => (i && typeof i === "object" ? String((i as Record<string, unknown>)["name"] ?? "") : String(i)))
    .filter(Boolean);
  return `<div class="wg"><div class="wg-b btnw">
    <button class="pbtn">${esc(name)}</button>
    ${inputs.length ? `<span class="bin">acts on ${esc(inputs.join(", "))}</span>` : ""}
  </div></div>`;
}

function otherWidget(w: Widget): string {
  const st = (w.settings ?? {}) as Record<string, unknown>;
  const name = String(st["name"] ?? w.name ?? "widget");
  return `<div class="wg"><div class="wg-h"><span class="wg-t">${esc(name)}</span></div>
    <div class="wg-b empty">${esc(String(w.name ?? w.package ?? "component"))}</div></div>`;
}

/* ---------------------------------------------------------------- page */

export interface PageJson {
  layouts?: Array<Record<string, unknown>>;
  widgets?: Widget[];
  links?: Array<Record<string, unknown>>;
  actionButtons?: Array<Record<string, unknown>>;
  dataSources?: Array<Record<string, unknown>>;
}

export function renderPreview(j: PageJson, meta: PreviewMeta): string {
  const L0 = (j.layouts ?? [{}])[0] ?? {};
  const total = Number(L0["columns"] ?? 6) || 6;
  const placements = (L0["widgets"] ?? []) as Array<Record<string, unknown>>;
  const byId = new Map((j.widgets ?? []).map((w) => [w.id ?? "", w]));

  // widgets in placement order; anything unplaced is called out, because a widget
  // that is never placed is never rendered by CMF either (defect 11)
  const placed: Array<{ w: Widget; col: number; span: number; row: number }> = [];
  for (const p of placements) {
    const w = byId.get(String(p["id"] ?? ""));
    if (!w) continue;
    const pos = (p["position"] ?? {}) as Record<string, number>;
    const dim = (p["dimensions"] ?? {}) as Record<string, number>;
    placed.push({ w, col: Number(pos["column"] ?? 1), span: Number(dim["columns"] ?? total), row: Number(pos["row"] ?? 1) });
  }
  placed.sort((a, b) => a.row - b.row || a.col - b.col);
  /*
   * A HOSTED WIDGET IS PLACED BY ITS HOST, and counting it as unplaced is a
   * false alarm about a correct file.
   *
   * `checks.ts` learned this on 2026-08-28 (F-173) — a Filter wraps the widget
   * it filters, so the inner grid is declared in `widgets[]` and deliberately
   * absent from `layouts[0].widgets`. The PREVIEW was never told, so it drew the
   * warning "1 widget(s) declared but never placed" underneath a page that
   * renders perfectly well. That reads as a defect in the generated artifact,
   * which is the one thing a mock must never invent.
   */
  const hosted = new Set<string>();
  for (const w of j.widgets ?? []) {
    const st = (w.settings ?? {}) as Record<string, unknown>;
    for (const k of INNER_WIDGET_KEYS) {
      const h = st[k];
      if (h && typeof h === "object" && !Array.isArray(h)) {
        const id = (h as Record<string, unknown>)["id"];
        if (typeof id === "string" && id) hosted.add(id);
      }
    }
  }
  const unplaced = (j.widgets ?? [])
    .filter((w) => !placed.some((p) => p.w === w) && !hosted.has(String(w.id ?? "")));

  const bodyOf = (w: Widget): string => {
    const st = (w.settings ?? {}) as Record<string, unknown>;
    /* Filter FIRST: it carries a hosted grid, and that grid has `columns`, so
       testing for columns before filters would draw the inner grid and silently
       drop the filter fields wrapped around it. */
    if ((st["filters"] as unknown[] | undefined)?.length) return filterWidget(w, bodyOf);
    if ((st["columns"] as unknown[] | undefined)?.length) return gridWidget(w);
    if ((st["fields"] as unknown[] | undefined)?.length) return formWidget(w);
    if ((st["inputs"] as unknown[] | undefined)?.length) return buttonWidget(w);
    return otherWidget(w);
  };

  const cells = placed.map(({ w, col, span }) =>
    `<div class="cell" style="grid-column:${col} / span ${Math.min(span, total)}">${bodyOf(w)}</div>`).join("");

  // action bar — CMF always adds these four itself (Rule 4), so show them greyed
  const custom = (j.actionButtons ?? []).map((b) => {
    const s = (b["settings"] ?? {}) as Record<string, unknown>;
    const L = labelText(s["buttonTitle"] ?? s["name"]);
    return { text: L.shown, resolved: L.resolved, icon: String(s["iconClass"] ?? ""),
             group: String(s["actionGroupId"] ?? "General"), id: String(s["actionButtonId"] ?? s["actionId"] ?? "") };
  });
  const framework = [
    { text: "Refresh", icon: "refresh", group: "General" },
    { text: "New", icon: "new", group: "General" },
    { text: "Lock", icon: "lock", group: "General" },
  ];
  const btn = (t: string, icon: string, id: string, fw: boolean, warn = false): string =>
    `<button class="ab${fw ? " fw" : ""}" title="${esc(id || "supplied by CMF")}">
       ${svg(iconFor(icon))}<span${warn ? ' class="w"' : ""}>${esc(t)}</span></button>`;
  const groups = new Map<string, string[]>();
  for (const f of framework) (groups.get(f.group) ?? groups.set(f.group, []).get(f.group) as string[])
    .push(btn(f.text, f.icon, "", true));
  for (const c of custom) (groups.get(c.group) ?? groups.set(c.group, []).get(c.group) as string[])
    .push(btn(c.text, c.icon, c.id, false, !c.resolved));
  (groups.get("Actions") ?? groups.set("Actions", []).get("Actions") as string[]).push(btn("More", "more", "", true));
  const ribbon = [...groups].map(([g, bs]) =>
    `<div class="grp"><div class="grp-r">${bs.join("")}</div><div class="grp-n">${esc(g)}</div></div>`).join("");

  const warnings: string[] = [];
  if (unplaced.length) warnings.push(`${unplaced.length} widget(s) declared but never placed — CMF renders nothing for them`);
  const unknownCols = (j.widgets ?? []).flatMap((w) =>
    ((w.settings?.["columns"] ?? []) as Array<Record<string, unknown>>)
      .filter((c) => UNKNOWN.test(String(c["path"] ?? "")))).length;
  if (unknownCols) warnings.push(`${unknownCols} column(s) with an UNKNOWN data path`);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(meta.title)} — mock</title><style>
*{box-sizing:border-box}
body{margin:0;background:${T.bg};color:${T.text};
 font:15px/1.43 "Open Sans","Segoe UI",-apple-system,sans-serif}
.tab{background:#fff;color:${T.text};height:48px;display:flex;align-items:center;padding:0 14px;gap:10px;font-size:14px}
.ribbon{background:${T.widgetBg};border-bottom:1px solid ${T.line};display:flex;padding:6px 4px 0;gap:0}
.grp{display:flex;flex-direction:column;padding:0 8px;border-right:1px solid ${T.line}}
.grp-r{display:flex;align-items:flex-start}
.grp>div.grp-n{font-size:10px;color:#767676;text-align:center;padding:2px 0 4px}
.grp .row{display:flex}
.ab{display:flex;flex-direction:column;align-items:center;gap:3px;background:none;border:0;cursor:default;
 color:${T.primary};font:inherit;font-size:11px;padding:5px 10px 2px;min-width:56px}
.ab span{color:#3b3b3b}
.ab.fw{opacity:.55}
/* A filter row sits inside its widget, above the list it narrows. */
.frow{display:flex;flex-wrap:wrap;gap:14px 22px;padding:12px 14px;border-bottom:1px solid ${T.line}}
.btnw{display:flex;align-items:center;gap:12px;padding:12px 14px}
.pbtn{background:${T.primary};color:#fff;border:0;border-radius:3px;
 padding:7px 18px;font:inherit;font-size:14px;cursor:default}
.bin{font-size:12px;color:#767676}
.ab .w{color:${T.orange}}
.idbar{display:flex;align-items:center;gap:10px;padding:7px 14px;background:${T.widgetBg};
 border-bottom:1px solid ${T.line};font-size:13.5px}
.idbar .nm{font-weight:600}
.idbar .dd{color:${T.primary}}
.canvas{padding:14px;display:grid;grid-template-columns:repeat(${total},1fr);gap:12px;align-items:start}
.cell{min-width:0}
.wg{background:${T.widgetBg};border:1px solid ${T.line};min-width:0}
.wg.flat{border:0;background:transparent}
.wg-h{display:flex;align-items:center;gap:7px;padding:7px 10px;border-bottom:1px solid ${T.line};color:#4a4a4a}
.wg-t{font-size:13.5px}
.cnt{color:#8c8c8c;font-size:12.5px}
.sp{flex:1}
.wg-b{min-width:0}
.scroll{overflow-x:auto}
.wg-f{display:flex;align-items:center;padding:6px 10px;font-size:12px;color:#5a5a5a;border-top:1px solid ${T.line}}
.rec{color:#8c8c8c;margin-left:6px}
table.grid{border-collapse:collapse;width:100%}
table.grid th{font-size:11px;font-weight:400;line-height:35px;height:35px;text-transform:uppercase;
 text-align:left;color:rgba(0,0,0,.8);padding:0 8px;border-right:1px solid ${T.line};
 border-bottom:1px solid ${T.line};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
table.grid th.w{color:${T.orange}}
table.grid td{font-size:15px;padding:5px 8px;line-height:21.4px;border-bottom:1px solid rgba(0,0,0,.05);
 white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:230px}
table.grid tr:hover td{background:#f5fafd}
th.sel,td.sel{width:36px;text-align:center;padding:0 0 0 8px}
.cb{display:inline-block;width:13px;height:13px;border:1px solid #b5b5b5;background:#fff;vertical-align:middle}
.chip{display:inline-block;padding:1px 8px;border-radius:2px;background:${T.selected};
 color:#08507d;font-size:12.5px;border:1px dashed ${T.secondary}}
.unk{color:${T.red};font-weight:600;font-size:12.5px}
.filter{display:flex;flex-wrap:wrap;gap:18px;padding:4px 2px 10px}
.fld{display:flex;flex-direction:column;gap:4px;min-width:230px}
.fld label{font-size:11px;text-transform:uppercase;color:#5c5c5c;letter-spacing:.02em}
.fld label.w{color:${T.orange}}
.inp{height:32px;border:1px solid #c9c9c9;background:#fff;display:flex;align-items:center;
 padding:0 8px;gap:6px;color:#9b9b9b}
.inp.ref{justify-content:space-between}
.ph{font-size:13px;font-style:italic}
.empty{padding:26px;text-align:center;color:#9b9b9b;font-style:italic;font-size:13.5px}
.note{margin:0;padding:9px 14px;background:#fffdf3;border-top:1px solid #f0e2b6;
 font-size:12px;color:#7a5c12}
.note b{color:#5d460c}
.note ul{margin:5px 0 0;padding-left:18px}
</style></head><body>

<div style="display:flex;background:#eef2f5"><div class="tab">${esc(meta.title)}</div></div>

<div class="ribbon">${ribbon}</div>

<div class="idbar"><span class="nm">${esc(meta.title)}</span>
  <span class="dd">A (Default) ▾</span><span class="dd">1 (Effective) ▾</span>
  <span class="sp"></span><span style="color:#8c8c8c;font-size:12px">${esc(meta.source)}</span></div>

<div class="canvas">${cells}</div>

<p class="note"><b>Mock — not a CMF rendering.</b> Layout, widgets, columns, labels and wiring come from
${esc(meta.origin ?? "the generated page definition")}; <b>row values are placeholder sample data</b>. Styling approximates the
CMF client from observed theme values — no CMF stylesheet, icon font or code is used.
Cells drawn as <span class="chip">chips</span> are <code>customTemplate</code> columns, whose markup is
deliberately <b>not executed</b>. Labels in <span style="color:${T.orange}">orange</span> could not be
resolved to display text.
${warnings.length ? `<ul>${warnings.map((x) => `<li><b>${esc(x)}</b></li>`).join("")}</ul>` : ""}
</p>
</body></html>`;
}
