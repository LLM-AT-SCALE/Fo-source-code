/**
 * CUSTOM TEMPLATE PORTING — copy evidenced column markup, never author it.
 *
 * WHY THIS IS OUR CODE'S JOB, NOT THE MODEL'S
 *   A `customTemplate` is hand-written Kendo markup living inside the page
 *   definition — `# … #` executable JS, `#: … #` encoded output, `data._obj.<P>`
 *   for the row. We have never had evidence for what one should contain, so
 *   `SYSTEM_PROMPT.md` forbids authoring one and the generator emits the column
 *   with neither a type code nor a template.
 *
 *   Since 2026-08-19 we hold Athena's delivered pages, so for a column that
 *   exists on one of their artifacts the markup is no longer unknown — it is
 *   *evidence*. Copying it verbatim is the same act as using an evidenced data
 *   path: **inventing is forbidden, using an evidenced value is right.**
 *
 *   And it is mechanical. Like `$id`, escaping and the envelope, it needs no
 *   judgement, so it belongs here rather than being threaded through the
 *   descriptor as a 400-character blob. The descriptor deliberately speaks the
 *   user story's language; raw CMF markup has no place in it.
 *
 * WHY THE SOURCE MUST BE NAMED, AND CANNOT BE A GLOBAL LIBRARY
 *   Measured across Athena's 27 custom pages: only 9 templated columns over 7
 *   distinct paths — and **`Name` carries two DIFFERENT templates on two
 *   different pages.** A library keyed by column path would therefore have
 *   applied the wrong markup with no way to notice. The others appear exactly
 *   once, which is not evidence of stability, only absence of disagreement.
 *
 *   So porting is always "copy column X from THIS artifact", never "look up X".
 *   There is no default source: defaulting would silently pull markup from an
 *   unrelated page, which is the exact failure this design exists to prevent.
 */
import { readFileSync } from "node:fs";
import { rawSettings } from "./assemble";
import type { PageSettings, Widget } from "../types";

export class TemplateError extends Error {}

export interface TemplateEntry {
  path: string;
  template: string;
  /** the column's label on the source page, for the report */
  label: string;
}

/** Every templated column on one exported page, keyed by data path. */
export type TemplateLibrary = Map<string, TemplateEntry>;

/** Un-escape the XML-attribute encoding CMF uses for the Settings payload. */
function unescapeAttribute(s: string): string {
  return s
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#xD;/g, "\r").replace(/&#xA;/g, "\n").replace(/&#x9;/g, "\t")
    .replace(/&amp;/g, "&");
}

export function parseSettings(xml: string): PageSettings {
  const raw = rawSettings(xml);
  if (raw === null) throw new TemplateError("no <Settings> payload in the source artifact");
  return JSON.parse(unescapeAttribute(raw)) as PageSettings;
}

/**
 * Read every `customTemplate` out of one exported page.
 *
 * A duplicate path WITHIN one page is refused rather than resolved: two columns
 * on the same page rendering the same path differently is exactly the ambiguity
 * that makes silent porting dangerous, and a coin-flip would hide it.
 */
export function loadTemplateLibrary(xmlPath: string): TemplateLibrary {
  let xml: string;
  try {
    xml = readFileSync(xmlPath, "utf-8");
  } catch {
    throw new TemplateError(`template source not found: ${xmlPath}`);
  }
  const settings = parseSettings(xml);
  const lib: TemplateLibrary = new Map();
  const clashes: string[] = [];

  for (const w of settings.widgets ?? []) {
    for (const c of w.settings?.columns ?? []) {
      const tmpl = c.customTemplate;
      const path = c.path;
      if (!tmpl || !path) continue;
      const existing = lib.get(path);
      if (existing && existing.template !== tmpl) { clashes.push(path); continue; }
      lib.set(path, { path, template: tmpl, label: c.name ?? path });
    }
  }

  if (clashes.length) {
    throw new TemplateError(
      `${xmlPath} renders ${[...new Set(clashes)].join(", ")} with more than one template. ` +
      `Porting by path would be a guess — split the source or port by hand.`,
    );
  }
  return lib;
}

export interface TemplateOutcome {
  applied: Array<{ path: string; label: string; chars: number }>;
  /**
   * Columns that HAD a type code which the source says is templated. The code is
   * cleared and the template applied — a column carries one or the other, never
   * both (17/17 on the reference page). Reported separately from `applied`
   * because it overrides a decision the generator made.
   */
  retyped: Array<{ path: string; wasType: number }>;
  /** columns left alone: typed, and the source has no template for them */
  skippedTyped: string[];
  /** columns with neither type nor template, and nothing in the source to supply */
  unmatched: string[];
  /** templates in the source this page has no column for */
  unusedInSource: string[];
}

/**
 * Apply evidenced templates to the columns the generator deliberately left blank.
 *
 * THE SAFETY RULE: only a column with **no type code and no template** is
 * eligible. A typed column is a decision the generator made from the schema, and
 * overwriting it here would silently replace a correct scalar rendering with
 * someone else's markup. A column that already has a template is left alone too.
 *
 * Mutates a deep copy; the caller's object is untouched.
 */
export function applyTemplates(
  settings: PageSettings, lib: TemplateLibrary,
): { settings: PageSettings; outcome: TemplateOutcome } {
  const copy = JSON.parse(JSON.stringify(settings)) as PageSettings;
  const outcome: TemplateOutcome = {
    applied: [], retyped: [], skippedTyped: [], unmatched: [], unusedInSource: [],
  };
  const used = new Set<string>();

  for (const w of (copy.widgets ?? []) as Widget[]) {
    for (const c of w.settings?.columns ?? []) {
      const path = c.path;
      if (!path) continue;
      const hasType = c.type?.type !== undefined && c.type?.type !== null;
      const hasTmpl = Boolean(c.customTemplate);
      if (hasTmpl) continue;
      const entry = lib.get(path);

      if (hasType) {
        // The named source renders THIS path by template, so the model's type
        // code is contradicted by direct evidence about the same column on the
        // same page. A column carries a type code OR a template, never both, so
        // the guess yields to the evidence — loudly, via `retyped`.
        if (!entry) { outcome.skippedTyped.push(path); continue; }
        outcome.retyped.push({ path, wasType: c.type?.type as number });
        c.type = { ...(c.type ?? {}), type: null };
        c.customTemplate = entry.template;
        used.add(path);
        outcome.applied.push({ path, label: entry.label, chars: entry.template.length });
        continue;
      }

      if (!entry) { outcome.unmatched.push(path); continue; }
      c.customTemplate = entry.template;
      used.add(path);
      outcome.applied.push({ path, label: entry.label, chars: entry.template.length });
    }
  }

  outcome.unusedInSource = [...lib.keys()].filter((p) => !used.has(p));
  return { settings: copy, outcome };
}

/** One-line-per-item summary for the run log. */
export function formatTemplateOutcome(o: TemplateOutcome, source: string): string[] {
  const lines: string[] = [];
  lines.push(`  templates: ${o.applied.length} ported from ${source}`);
  for (const a of o.applied) lines.push(`      ${a.path}  (${a.chars} chars)  ${a.label}`);
  if (o.unmatched.length) {
    lines.push(`    ! ${o.unmatched.length} column(s) still have neither type nor template — ` +
               `no evidence in the source: ${o.unmatched.join(", ")}`);
  }
  for (const r of o.retyped) {
    lines.push(`    ~ ${r.path}: type ${r.wasType} CLEARED — the source renders it by template, ` +
               `and a column carries one or the other, never both`);
  }
  if (o.skippedTyped.length) {
    lines.push(`    - ${o.skippedTyped.length} typed column(s) left alone; the source has no ` +
               `template for them: ${o.skippedTyped.join(", ")}`);
  }
  if (o.unusedInSource.length) {
    lines.push(`    - ${o.unusedInSource.length} template(s) in the source this page does not use: ` +
               `${o.unusedInSource.join(", ")}`);
  }
  return lines;
}
