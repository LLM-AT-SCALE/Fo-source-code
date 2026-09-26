/**
 * APPLY A READER'S PRD FEEDBACK TO THE DESCRIPTOR.
 *
 * WHY THIS EXISTS
 *   Until now, PRD feedback rewrote the NARRATIVE only — the descriptor was
 *   frozen, so a reader could tweak the document all day and the screen never
 *   moved. That was deliberate (it stops scope drifting in silently), but it
 *   makes the PRD a mirror rather than something you can shape.
 *
 *   Athena's team asked for the opposite: tweak the PRD until it says what you
 *   want, and see the UI preview follow. That only works if feedback can reach
 *   the descriptor, because the preview and the PRD are both derived from it.
 *
 * HOW THE SAFETY PROPERTY IS KEPT
 *   Not by forbidding change, but by making every change VISIBLE. The model
 *   returns the revised descriptor plus a list of what it changed; we then diff
 *   the two descriptors ourselves and reconcile the two accounts. A change the
 *   model made but did not report is exactly the silent scope drift the old
 *   design prevented by refusing to move at all — so it is surfaced, loudly.
 *
 *   The same shape as `modify.ts`, which already applies edits, diffs them, and
 *   reports `unexpectedChanges`.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { call, type CallResult } from "./client";
import { readAsset, type PipelineConfig } from "./config";
import { parseJsonBlock } from "./parse";
import { parseDescriptor, type PageSpecType, type SpecDescriptor } from "../descriptor";

export interface RevisionResult {
  descriptor: SpecDescriptor;
  /** what the model said it changed, in the reader's terms */
  claimed: string[];
  /** what actually changed, computed by us from the two descriptors */
  observed: string[];
  /** observed changes the model did not claim — silent scope drift */
  unreported: string[];
  changed: boolean;
  usage: CallResult["usage"];
}

/* ------------------------------------------------------------------ diffing */

const colNames = (p: PageSpecType, i: number): string[] =>
  (p.grids?.[i]?.columns ?? []).map((c) => c.name);

/**
 * The SHAPE of a column or field, minus its identity.
 *
 * Identity alone is not enough, and that gap was measured, not theorised.
 * Driving the app: "make Product a plain string field after all" changed the
 * filter from an entity picker to a free-text box — `scalarType` Reference to
 * String, `entity` Product to absent — and the change card reported NOTHING,
 * because the label was still "Product" on both sides. A silent spec edit is
 * exactly what this diff exists to prevent, so it has to look past the name.
 *
 * It matters beyond cosmetics: a Reference field renders a picker and binds a
 * typed parameter; a String field renders a text box and binds a string. Same
 * label, different screen, different query wiring.
 */
/*
 * Rendered as PROSE, not as a tuple. The first version emitted
 * "Reference/Product/- -> String/-/-", which is accurate and unreadable — and
 * this file's whole premise is that a structural diff beats a JSON patch
 * because a person can check it. A reader should be able to see
 * "a Product picker -> plain text" and say yes, that is what I asked for.
 */
const shapeOf = (x: { scalarType?: string; entity?: string; link?: boolean }): string => {
  const t = x.scalarType ?? "unspecified type";
  const base = x.entity ? `${t} to ${x.entity}` : t;
  return x.link ? `${base}, as a link` : base;
};

/** "Reference to Product -> String" reads as a change; identical shapes return null. */
function shapeChange(
  before: { scalarType?: string; entity?: string; link?: boolean } | undefined,
  after: { scalarType?: string; entity?: string; link?: boolean } | undefined,
): string | null {
  if (!before || !after) return null;
  const b = shapeOf(before), a = shapeOf(after);
  return b === a ? null : `${b} -> ${a}`;
}

/**
 * A human-readable diff of two descriptors, in the terms a reader would use.
 *
 * Deliberately structural rather than a JSON diff: "Materials grid: added column
 * Priority" is checkable by a person; a JSON patch is not.
 */
export function diffDescriptors(before: SpecDescriptor, after: SpecDescriptor): string[] {
  const out: string[] = [];

  const beforePages = new Map(before.pages.map((p) => [p.name, p]));
  const afterPages = new Map(after.pages.map((p) => [p.name, p]));

  for (const name of afterPages.keys()) {
    if (!beforePages.has(name)) out.push(`page added: "${name}"`);
  }
  for (const name of beforePages.keys()) {
    if (!afterPages.has(name)) out.push(`page removed: "${name}"`);
  }

  for (const [name, a] of afterPages) {
    const b = beforePages.get(name);
    if (!b) continue;

    if (a.uiType !== b.uiType) out.push(`${name}: type ${b.uiType} -> ${a.uiType}`);
    if ((a.title ?? "") !== (b.title ?? "")) out.push(`${name}: title changed`);

    // Self-refresh is a real page property, so a change to it is a real spec
    // change. Reported in the terms an engineer asked in ("every 30 seconds"),
    // not as the raw duration.
    const refresh = (p: typeof a): string =>
      p.autoRefresh ? `refreshes itself every ${p.autoRefreshInterval ?? "PT1M"}`
                    : "does not refresh itself";
    if ((a.autoRefresh ?? false) !== (b.autoRefresh ?? false) ||
        (a.autoRefresh && a.autoRefreshInterval !== b.autoRefreshInterval)) {
      out.push(`${name}: ${refresh(b)} -> ${refresh(a)}`);
    }

    const bg = b.grids ?? [], ag = a.grids ?? [];
    if (ag.length !== bg.length) out.push(`${name}: ${bg.length} grid(s) -> ${ag.length}`);
    for (let i = 0; i < Math.min(bg.length, ag.length); i += 1) {
      const label = `${name} / ${ag[i]?.entity ?? `grid ${i + 1}`}`;
      if (bg[i]?.entity !== ag[i]?.entity) out.push(`${label}: entity was ${bg[i]?.entity}`);
      if (bg[i]?.selection !== ag[i]?.selection) {
        out.push(`${label}: selection ${bg[i]?.selection} -> ${ag[i]?.selection}`);
      }
      const bc = colNames(b, i), ac = colNames(a, i);
      for (const c of ac) if (!bc.includes(c)) out.push(`${label}: added column "${c}"`);
      for (const c of bc) if (!ac.includes(c)) out.push(`${label}: removed column "${c}"`);
      if (bc.length === ac.length && bc.join("|") !== ac.join("|") &&
          bc.every((c) => ac.includes(c))) {
        out.push(`${label}: columns reordered`);
      }
      // A column that KEPT its name can still have changed what it renders.
      const bcol = new Map((b.grids?.[i]?.columns ?? []).map((c) => [c.name, c]));
      for (const c of a.grids?.[i]?.columns ?? []) {
        const moved = shapeChange(bcol.get(c.name), c);
        if (moved) out.push(`${label}: column "${c.name}" ${moved}`);
      }
    }

    const bb = (b.actionButtons ?? []).map((x) => x.name);
    const ab = (a.actionButtons ?? []).map((x) => x.name);
    for (const x of ab) if (!bb.includes(x)) out.push(`${name}: added button "${x}"`);
    for (const x of bb) if (!ab.includes(x)) out.push(`${name}: removed button "${x}"`);

    const bFields = (b.forms ?? []).flatMap((f) => f.fields ?? []);
    const aFields = (a.forms ?? []).flatMap((f) => f.fields ?? []);
    const bf = bFields.map((x) => x.label), af = aFields.map((x) => x.label);
    for (const x of af) if (!bf.includes(x)) out.push(`${name}: added form field "${x}"`);
    for (const x of bf) if (!af.includes(x)) out.push(`${name}: removed form field "${x}"`);
    // Same label, different control. See the note on shapeOf.
    const bByLabel = new Map(bFields.map((x) => [x.label, x]));
    for (const x of aFields) {
      const moved = shapeChange(bByLabel.get(x.label), x);
      if (moved) out.push(`${name}: form field "${x.label}" ${moved}`);
    }
  }

  const bq = before.queries ?? [], aq = after.queries ?? [];
  for (const q of aq) if (!bq.includes(q)) out.push(`query added: "${q}"`);
  for (const q of bq) if (!aq.includes(q)) out.push(`query removed: "${q}"`);

  return out;
}

/** loose match: did the model's claim mention the thing we observed changing? */
function claimCovers(claimed: readonly string[], observed: string): boolean {
  const quoted = /"([^"]+)"/.exec(observed)?.[1]?.toLowerCase();
  const hay = claimed.join(" \n ").toLowerCase();
  if (quoted) return hay.includes(quoted);
  // no quoted subject — fall back to the leading noun ("selection", "type", …)
  const word = observed.split(":").pop()?.trim().split(" ")[0]?.toLowerCase() ?? "";
  return word.length > 3 && hay.includes(word);
}

/* ----------------------------------------------------------------- the call */

/**
 * Ask the model whether this feedback changes the specification, and if so to
 * return the descriptor with that change applied.
 *
 * `descriptor` is deliberately schema-free in REVISION_SCHEMA and validated with
 * zod afterwards instead: the descriptor's own JSON Schema is large, nesting it
 * inside another schema costs tokens on every revision, and `parseDescriptor` is
 * the contract we actually trust — it is what the rest of the pipeline uses.
 *
 * 2026-08-27 — THE CODE HAD DRIFTED FROM THIS NOTE. It read the descriptor
 * schema off disk and spliced it in as `properties.descriptor`, which is the
 * one thing the paragraph above says not to do. The result was not slow, it was
 * broken: every PRD revision came back
 *
 *   400 invalid_request_error: The compiled grammar is too large, which would
 *   cause performance issues. Simplify your tool schemas …
 *
 * so asking to change a PRD failed outright. Found by asking for one column to
 * be removed and watching the turn fail.
 *
 * Removing the splice alone was not enough: an unconstrained `{type:"object"}`
 * is ALSO rejected, because structured outputs demand
 * `additionalProperties: false` everywhere. There is no way to say "any object"
 * in that mode, so the revision sends no schema at all and asks for a fenced
 * JSON block instead. The shape is stated in the prompt, which is now the only
 * place it is stated — a schema constant nothing sends is just dead code.
 */
export async function reviseDescriptor(
  cfg: PipelineConfig, client: Anthropic,
  descriptor: SpecDescriptor, feedback: string,
  story: string | undefined, log: (l: string) => void = () => {},
): Promise<RevisionResult> {
  const instructions = readAsset(cfg, "revisePrompt");

  const user = [
    "Here is the spec descriptor as it stands.",
    "",
    "```json",
    JSON.stringify(descriptor, null, 2),
    "```",
    ...(story ? ["", "And the requirement document it was extracted from.", "",
                 "---", story, "---"] : []),
    "",
    "The reader has reviewed the PRD and replied:",
    "",
    feedback,
    "",
    "Return ONE fenced ```json block holding an object with two keys: " +
    "`descriptor` (the whole descriptor, revised or unchanged) and `changes` " +
    "(an array of strings saying what you changed, empty if nothing). " +
    "No prose outside the block.",
  ].join("\n");

  log("  reading the feedback against the specification...");
  const res = await call({
    client, model: cfg.model, effort: cfg.model.extractEffort,
    system: [{ type: "text", text: instructions }],
    user,
    /*
     * NO structured-output schema, and this is forced rather than preferred.
     *
     * Structured outputs require `additionalProperties: false` on every object,
     * so "an object we do not constrain" cannot be expressed at all — asking
     * for one is a 400. The only two expressible options are the full
     * descriptor schema, which the API rejects as too large a grammar, or no
     * schema. So: no schema, a fenced block asked for in the prompt, and
     * `parseDescriptor` doing the validating — which is what the note above
     * always said was the contract we trust.
     */
  });

  const raw = parseJsonBlock(res.text) as { descriptor?: unknown; changes?: unknown };
  const revised = parseDescriptor(raw.descriptor, "<revised>");
  const claimed = Array.isArray(raw.changes)
    ? raw.changes.filter((c): c is string => typeof c === "string") : [];

  const observed = diffDescriptors(descriptor, revised);
  const unreported = observed.filter((o) => !claimCovers(claimed, o));

  return {
    descriptor: revised, claimed, observed, unreported,
    changed: observed.length > 0, usage: res.usage,
  };
}

/** How the revision is reported to the reader — their terms, and nothing hidden. */
export function formatRevision(r: RevisionResult): string[] {
  if (!r.changed) {
    return ["  the specification is unchanged — that feedback was about the wording"];
  }
  const lines = [`  the specification changed (${r.observed.length}):`];
  for (const o of r.observed) lines.push(`    - ${o}`);
  if (r.unreported.length) {
    lines.push(`  !! ${r.unreported.length} change(s) the model did not report:`);
    for (const u of r.unreported) lines.push(`    !! ${u}`);
  }
  return lines;
}
