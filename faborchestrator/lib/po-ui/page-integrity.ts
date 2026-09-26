/**
 * DOES THIS PAGE AGREE WITH ITSELF?  (T-48)
 *
 * `checks.ts` verifies a page's SHAPE — ids, envelope, placements, labels.
 * `wiring-checks.ts` verifies a page against its QUERIES. Neither asks whether
 * the page's own parts agree with each other, and that is where Athena's three
 * defects lived: a button whose declared inputs did not match what the platform
 * expects, a data source that never fetched, a grid bound to fields nothing
 * returned. Every artifact was valid; the relationships were not.
 *
 * So this module asks only relational questions, and every rule in it was
 * MEASURED across the 39 delivered pages before being written. That order
 * matters — `checkWiring` nearly shipped a rule that would have failed the
 * client's own files (F-118), and the discipline that caught it is the same one
 * used here: a candidate their pages break is not a rule, however obvious it
 * looks.
 *
 * Counts as at 2026-09-08, from `scripts/measure-invariants.mts`:
 *
 *   link into a button names a declared input or control port   999 / 0
 *   a converter `param` names a declared page property          316 / 0
 *   a grid feeding a button is itself fed with data               9 / 0
 *   a collection-input button is fed by a multi-select grid        6 / 0
 *
 * Candidates DELIBERATELY NOT turned into rules, because their own pages break
 * them — recorded here so nobody re-derives them and wastes the measurement:
 *
 *   every top-level widget is placed on a layout   118 / 44  (tab-hosted widgets)
 *   every data source is wired                      96 / 17  (ambient SystemDataSource)
 *   widget names are unique on a page               29 / 10  ("Sliding Grid" repeats)
 *   every button carries an actionId               948 / 155 (group/nested buttons)
 */
import type { Result } from "./types";
import { basePort } from "./platform";

/**
 * Ports a delivered page binds on an action button that are NOT in its `inputs`.
 *
 * MEASURED, exactly like `CONTROL_PORTS` in `wiring-checks.ts` and for the same
 * reason: flagging these would fail the client's own artifacts. `lessRelevant`
 * appears on their Step View pages, `hidden` on both Cluster pages.
 */
const BUTTON_CONTROL_PORTS: ReadonlySet<string> = new Set([
  "lessRelevant", "visible", "enabled", "hidden", "refresh",
]);

/* ------------------------------------------------------------------ shapes */

interface Node { id?: unknown; settings?: Record<string, unknown> }
interface Endpoint { id?: unknown }
interface Link {
  source?: Endpoint; target?: Endpoint;
  output?: unknown; input?: unknown;
  converter?: { param?: unknown }; param?: unknown;
}

/**
 * Every DECLARED object on the page, by id.
 *
 * Link endpoints are excluded on purpose. They carry `{id, type}` and nothing
 * else, so indexing them would let a link prove its own endpoint exists — a
 * check that verifies itself. A declaration is recognised by carrying
 * `settings`, which every widget, data source and button has and no endpoint
 * stub does.
 */
function declarations(page: unknown): {
  byId: Map<string, Node>; widgets: Set<Node>; buttons: Set<Node>;
} {
  const byId = new Map<string, Node>();
  const widgets = new Set<Node>();
  const buttons = new Set<Node>();

  const walk = (node: unknown, insideLinks: boolean): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) walk(n, insideLinks); return; }
    const o = node as Record<string, unknown>;
    const s = o["settings"] as Record<string, unknown> | undefined;
    if (!insideLinks && typeof o["id"] === "string" && s) {
      byId.set(o["id"], o as Node);
      if (s["columns"] || s["fields"]) widgets.add(o as Node);
      if (s["actionId"] || s["actionButtonId"]) buttons.add(o as Node);
    }
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === "object") walk(v, insideLinks || k === "links");
    }
  };
  walk(page, false);
  return { byId, widgets, buttons };
}

const nameOf = (n: Node | undefined): string =>
  String(n?.settings?.["name"] ?? n?.id ?? "?");

/* ------------------------------------------------------------------ checks */

export function checkPageIntegrity(page: unknown): Result[] {
  const p = (page ?? {}) as { links?: Link[]; properties?: Array<Record<string, unknown>> };
  const links = p.links ?? [];
  const { byId, widgets, buttons } = declarations(page);
  const out: Result[] = [];

  /* ── 1. a link into a button must name an input that button declares ──
     999 of 999. This is the Hold/Release family seen from the other side: the
     button declaring too few inputs, and a link naming a port that is not
     there, are the same defect from either end. A link to a port that does not
     exist imports cleanly and silently delivers nothing. */
  {
    let checked = 0;
    const dead: string[] = [];
    for (const l of links) {
      const t = byId.get(String(l?.target?.id ?? ""));
      if (!t || !buttons.has(t)) continue;
      /* `inner$materials` on a Filter-hosted grid is the same port as
         `materials`; see `basePort`. */
      const port = basePort(String(l?.input ?? ""));
      if (BUTTON_CONTROL_PORTS.has(port)) continue;
      checked += 1;
      const declared = ((t.settings?.["inputs"] ?? []) as Array<{ name?: unknown }>)
        .map((i) => String(i?.name ?? ""));
      if (!declared.includes(port)) {
        dead.push(`"${nameOf(t)}" has no input "${port}" (declares ${declared.join(", ") || "none"})`);
      }
    }
    if (dead.length) {
      for (const d of dead) {
        out.push({
          level: "FAIL",
          name: "a link feeds an action-button port that does not exist",
          detail: `${d}. The link imports cleanly and delivers nothing, so the button ` +
                  `runs with no selection or does not enable at all.`,
        });
      }
    } else if (checked) {
      out.push({ level: "PASS", name: `action-button links name declared inputs ${checked}/${checked}`, detail: "" });
    }
  }

  /* ── 2. a converter `param` must name a declared page property ──
     316 of 316. A parameterised converter reads its argument from a page
     property; a `param` naming nothing is a converter that cannot run. */
  {
    const declared = new Set(
      (p.properties ?? []).map((x) => String(x?.["id"] ?? x?.["name"] ?? "")),
    );
    let checked = 0;
    const dangling: string[] = [];
    for (const l of links) {
      const param = l?.converter?.param ?? l?.param;
      if (param === undefined || param === null || param === "") continue;
      checked += 1;
      if (!declared.has(String(param))) dangling.push(String(param));
    }
    for (const d of [...new Set(dangling)]) {
      out.push({
        level: "FAIL",
        name: "a converter reads a page property the page does not declare",
        detail: `param "${d}" — declared: ${[...declared].join(", ") || "(none)"}. ` +
                `The converter has nothing to read, so the value it should transform ` +
                `never arrives.`,
      });
    }
    if (!dangling.length && checked) {
      out.push({ level: "PASS", name: `converter params resolve ${checked}/${checked}`, detail: "" });
    }
  }

  /* ── 3. a grid whose selection drives a button must itself be filled ──
     9 of 9. Logically necessary as well as measured: a grid nothing fills can
     never have a selection, so the button it feeds can never be enabled. */
  {
    const filled = new Set(
      links.filter((l) => basePort(String(l?.input ?? "")) === "data")
        .map((l) => String(l?.target?.id ?? "")),
    );
    let checked = 0;
    const starved = new Set<string>();
    for (const l of links) {
      if (basePort(String(l?.output ?? "")) !== "selectedChange") continue;
      const b = byId.get(String(l?.target?.id ?? ""));
      const w = byId.get(String(l?.source?.id ?? ""));
      if (!b || !buttons.has(b) || !w || !widgets.has(w)) continue;
      checked += 1;
      if (!filled.has(String(w.id))) starved.add(`${nameOf(w)} -> ${nameOf(b)}`);
    }
    for (const s of starved) {
      out.push({
        level: "FAIL",
        name: "a grid drives a button but nothing fills the grid",
        detail: `${s}. With no data the grid can never hold a selection, so that ` +
                `button can never be used.`,
      });
    }
    if (!starved.size && checked) {
      out.push({ level: "PASS", name: `grids driving buttons are fed ${checked}/${checked}`, detail: "" });
    }
  }

  /* ── 4. a button taking a COLLECTION should be fed by a multi-select grid ──
     6 of 6 — and reported as a WARN rather than a FAIL because six occurrences
     is thin evidence. It is stated because the failure is invisible: the button
     renders, the operator selects several rows, and the action receives one. */
  {
    for (const b of buttons) {
      const takesCollection = ((b.settings?.["inputs"] ?? []) as Array<{ input?: { collectionType?: unknown } }>)
        .some((i) => i?.input?.collectionType === 1);
      if (!takesCollection) continue;
      for (const l of links) {
        if (basePort(String(l?.output ?? "")) !== "selectedChange"
          || String(l?.target?.id ?? "") !== String(b.id)) continue;
        const w = byId.get(String(l?.source?.id ?? ""));
        if (!w || !widgets.has(w)) continue;
        if (w.settings?.["selectionMode"] === 2) continue;
        out.push({
          level: "WARN",
          name: "a button expecting several rows is fed by a single-select grid",
          detail: `"${nameOf(b)}" declares a collection input and reads "${nameOf(w)}", ` +
                  `whose selectionMode is ${String(w.settings?.["selectionMode"])}. On ` +
                  `6 of 6 delivered pages such a grid is multi-select (2). Thin evidence, ` +
                  `so this is stated rather than enforced — but the failure is silent.`,
        });
      }
    }
  }

  return out;
}
