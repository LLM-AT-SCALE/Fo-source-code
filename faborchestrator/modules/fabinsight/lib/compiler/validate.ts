/**
 * Program validation — pure, injectable, shared by the compiler's
 * `validate_program` / `emit_program` tools and the unit tests.
 *
 * Checks, in order:
 *   1. zod schema (`safeParseProgram`);
 *   2. `edits` apply cleanly to the template (each `find` occurs exactly once);
 *   3. every KPI path has a `data-fab-bind` in the template;
 *   4. every call's tool exists on every server (missing → error when NO server
 *      has it, warning listing the servers that lack it otherwise);
 *   5. multi-server scope: a `rows[n].Col` text binding without an aggregate
 *      would silently show one server's value → error;
 *   6. optional dry run through the runtime: `allFailed` → error, drift → error
 *      (a program that cannot fill its own template is not shippable).
 */

import { safeParseProgram, type Program } from '@/modules/fabinsight/lib/replay/program';
import type { RunResult } from '@/modules/fabinsight/lib/replay/execute';

export type TemplateEdit = { find: string; replace: string };

export type ServerTools = { registryId: string; label: string; toolNames: string[] };

export type ValidateInput = {
  program: unknown;
  /** The base template the edits apply to (captured HTML, or the base version's template). */
  template: string;
  edits?: TemplateEdit[];
  /** Full-template replacement (only allowed for small templates; see MAX_FULL_TEMPLATE). */
  templateHtml?: string;
  /** Tool names available per resolved server. Omit to skip the tool check. */
  servers?: ServerTools[];
  /** Runtime dry run; omit to skip. */
  dryRun?: (program: Program, template: string) => Promise<RunResult>;
};

export type ValidateOutput = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  drift: string[];
  perServer: RunResult['perServer'];
  notes: string[];
  /** Present when the schema + edits passed. */
  program?: Program;
  template?: string;
  verify?: RunResult;
};

const MAX_FULL_TEMPLATE = 20_000;

/** Apply `{find, replace}` edits; every `find` must occur exactly once. */
export function applyEdits(template: string, edits: TemplateEdit[]): { html: string; errors: string[] } {
  const errors: string[] = [];
  let html = template;
  edits.forEach((e, i) => {
    if (!e || typeof e.find !== 'string' || !e.find.length) {
      errors.push(`edit ${i + 1}: empty find`);
      return;
    }
    const first = html.indexOf(e.find);
    if (first < 0) {
      errors.push(`edit ${i + 1}: find text not present: ${JSON.stringify(e.find.slice(0, 80))}`);
      return;
    }
    if (html.indexOf(e.find, first + 1) >= 0) {
      errors.push(`edit ${i + 1}: find text occurs more than once (make it unique): ${JSON.stringify(e.find.slice(0, 80))}`);
      return;
    }
    html = html.slice(0, first) + (e.replace ?? '') + html.slice(first + e.find.length);
  });
  return { html, errors };
}

const BIND_ATTR_RE = /\sdata-fab-(bind|repeat|json)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/** Every path referenced by a `data-fab-bind|repeat|json` attribute in the template. */
export function boundPaths(template: string): Set<string> {
  const out = new Set<string>();
  for (const m of template.matchAll(BIND_ATTR_RE)) out.add((m[2] ?? m[3] ?? m[4] ?? '').trim());
  return out;
}

const ROW_INDEX_BIND_RE = /\sdata-fab-bind\s*=\s*(?:"([^"]*)"|'([^']*)')(?![^>]*data-fab-aggregate)/g;
const ROW_INDEX_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*\.rows\[\d+\]\./;

export async function validateProgram(input: ValidateInput): Promise<ValidateOutput> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  // 1. schema
  const parsed = safeParseProgram(input.program);
  if (!parsed.ok) {
    return { ok: false, errors: parsed.errors.map((e) => `program: ${e}`), warnings, drift: [], perServer: [], notes };
  }
  const program = parsed.program;

  // 2. template
  let template = input.template;
  if (typeof input.templateHtml === 'string' && input.templateHtml.length) {
    if (input.template.length >= MAX_FULL_TEMPLATE) {
      errors.push(`templateHtml replacement is only allowed for templates under ${MAX_FULL_TEMPLATE} chars (this one is ${input.template.length}); use edits`);
    } else {
      template = input.templateHtml;
    }
  }
  if (input.edits?.length) {
    const applied = applyEdits(template, input.edits);
    errors.push(...applied.errors);
    template = applied.html;
  }
  if (errors.length) return { ok: false, errors, warnings, drift: [], perServer: [], notes, program, template };

  // 3. KPI bindings
  const bound = boundPaths(template);
  for (const k of program.kpis) {
    if (!bound.has(k.path)) errors.push(`KPI "${k.label}" (path ${k.path}) has no data-fab-bind in the template`);
  }
  if (!bound.size) errors.push('the template has no data-fab-* markers — nothing would refresh');

  // 4. tools per server
  if (input.servers && input.servers.length) {
    for (const c of program.calls) {
      const lacking = input.servers.filter((s) => !s.toolNames.includes(c.toolName));
      if (lacking.length === input.servers.length) {
        errors.push(`call "${c.id}": tool "${c.toolName}" does not exist on any resolved server`);
      } else if (lacking.length) {
        warnings.push(`call "${c.id}": tool "${c.toolName}" is missing on ${lacking.map((s) => s.label).join(', ')} — those servers will be reported unavailable for this dashboard`);
      }
    }
  }

  // 5. multi-server single-row bindings
  const multi = program.scope.mode === 'all' || (program.scope.mode === 'fixed' && program.scope.servers.length > 1);
  if (multi) {
    for (const m of template.matchAll(ROW_INDEX_BIND_RE)) {
      const path = (m[1] ?? m[2] ?? '').trim();
      if (ROW_INDEX_PATH_RE.test(path)) {
        errors.push(`multi-server scope: binding "${path}" reads one row of a merged set; add data-fab-aggregate="sum|avg|min|max" or use a data-fab-repeat with the server column`);
      }
    }
    for (const k of program.kpis) {
      if (ROW_INDEX_PATH_RE.test(k.path) && !k.aggregate) {
        errors.push(`multi-server scope: KPI "${k.label}" (${k.path}) needs aggregate: 'sum' | 'avg' | 'none'`);
      }
    }
  }

  if (errors.length) return { ok: false, errors, warnings, drift: [], perServer: [], notes, program, template };

  // 6. dry run
  let verify: RunResult | undefined;
  if (input.dryRun) {
    try {
      verify = await input.dryRun(program, template);
    } catch (e) {
      errors.push(`dry run threw: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, errors, warnings, drift: [], perServer: [], notes, program, template };
    }
    if (verify.allFailed) {
      const why = verify.sets.find((s) => s.error)?.error ?? verify.perServer.find((s) => !s.ok)?.error ?? 'every call failed';
      errors.push(`dry run: every call failed — ${why}`);
    }
    for (const d of verify.drift) errors.push(`dry run: path "${d}" did not resolve against the live result (check column names)`);
    for (const s of verify.perServer) {
      if (!s.ok) warnings.push(`server ${s.label}: ${s.reason ?? 'error'}${s.error ? ` — ${s.error}` : ''}`);
    }
    notes.push(...verify.notes);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    drift: verify?.drift ?? [],
    perServer: verify?.perServer ?? [],
    notes,
    program,
    template,
    verify,
  };
}
