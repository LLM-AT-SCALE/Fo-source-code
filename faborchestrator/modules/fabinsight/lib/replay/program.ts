/**
 * Replay program — the declarative, versioned description of how a pinned
 * dashboard is refreshed WITHOUT a model in the loop.
 *
 * A program is an ordered list of MCP tool calls (whose arguments may contain
 * relative-time expressions and references to earlier results), a list of
 * KPIs (paths into those results), and a summary recipe. The values are bound
 * into the captured HTML template through `data-fab-*` markers (see bind.ts).
 *
 * Everything here is pure: zod validation + the path grammar. No I/O.
 */

import { z } from 'zod';

// ── Time / reference expressions ─────────────────────────────────────────────

const TIME_FORMATS = ['iso', 'date', 'datetime-local', 'epoch'] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];

const TIME_UNITS = ['day', 'week', 'month', 'shift'] as const;
export type TimeUnit = (typeof TIME_UNITS)[number];

/** "-7d", "+1d", "-24h", "-30m", "-1w", "-1M" (months), "-90s". */
export const REL_RE = /^([+-]?\d+)\s*(s|m|h|d|w|M)$/;

const FormatSchema = z.enum(TIME_FORMATS).optional();

const TimeExprSchema = z.union([
  z.object({ $now: z.literal(true), format: FormatSchema }).strict(),
  z.object({ $rel: z.string().regex(REL_RE, 'relative offset like "-7d"'), format: FormatSchema }).strict(),
  z.object({ $startOf: z.enum(TIME_UNITS), offset: z.string().regex(REL_RE).optional(), format: FormatSchema }).strict(),
  z.object({ $endOf: z.enum(TIME_UNITS), offset: z.string().regex(REL_RE).optional(), format: FormatSchema }).strict(),
  z
    .object({
      $shift: z.enum(['current', 'previous']),
      part: z.enum(['start', 'end', 'name']),
      format: FormatSchema,
    })
    .strict(),
]);
export type TimeExpr = z.infer<typeof TimeExprSchema>;

const RefExprSchema = z.object({ $ref: z.string().min(1), join: z.string().optional() }).strict();
export type RefExpr = z.infer<typeof RefExprSchema>;

const VarExprSchema = z.object({ $var: z.string().min(1) }).strict();
export type VarExpr = z.infer<typeof VarExprSchema>;

/** A string with `{{name}}` slots filled from `vars` — for arguments such as a
 *  query text that embed dates: `{"$template":"... >= '{{from}}'", "vars":{"from":{"$rel":"-7d","format":"date"}}}`. */
const TemplateExprSchema = z
  .object({
    $template: z.string().min(1),
    vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), TimeExprSchema, RefExprSchema, VarExprSchema])).default({}),
  })
  .strict();
export type TemplateExpr = z.infer<typeof TemplateExprSchema>;

const ArgValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  TimeExprSchema,
  RefExprSchema,
  VarExprSchema,
  TemplateExprSchema,
]);
export type ArgValue = z.infer<typeof ArgValueSchema>;

export function isTimeExpr(v: unknown): v is TimeExpr {
  return !!v && typeof v === 'object' && ('$now' in v || '$rel' in v || '$startOf' in v || '$endOf' in v || '$shift' in v);
}
export function isRefExpr(v: unknown): v is RefExpr {
  return !!v && typeof v === 'object' && '$ref' in v;
}
export function isVarExpr(v: unknown): v is VarExpr {
  return !!v && typeof v === 'object' && '$var' in v;
}
export function isTemplateExpr(v: unknown): v is TemplateExpr {
  return !!v && typeof v === 'object' && '$template' in v;
}

// ── Calls, KPIs, summary ─────────────────────────────────────────────────────

const CALL_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_FOR_EACH = 25;

const CallSchema = z
  .object({
    id: z.string().regex(CALL_ID_RE, 'call id must be a simple identifier'),
    /** Human label shown for this result set (defaults to the id). */
    label: z.string().max(120).optional(),
    toolName: z.string().min(1),
    args: z.record(z.string(), ArgValueSchema).default({}),
    /** Expand into one call per item of an earlier result (rows get `_item`). */
    forEach: z
      .object({
        $ref: z.string().min(1),
        as: z.string().regex(CALL_ID_RE),
        max: z.number().int().positive().max(MAX_FOR_EACH).optional(),
      })
      .strict()
      .optional(),
    /** A failing optional call does not count toward `allFailed`. */
    optional: z.boolean().optional(),
  })
  .strict();
export type Call = z.infer<typeof CallSchema>;

const KpiSchema = z
  .object({
    label: z.string().min(1).max(120),
    path: z.string().min(1),
    unit: z.string().max(24).optional(),
    numeric: z.boolean(),
    /** Multi-server: how per-server values combine. 'none' = one KPI per server. */
    aggregate: z.enum(['sum', 'avg', 'none']).optional(),
  })
  .strict();

const SummarySchema = z.union([
  z.object({ kind: z.literal('template'), text: z.string().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal('auto') }).strict(),
]);

const ShiftSchema = z
  .object({
    name: z.string().min(1).max(40),
    start: z.string().regex(/^\d{1,2}:\d{2}$/),
    end: z.string().regex(/^\d{1,2}:\d{2}$/),
  })
  .strict();
export type Shift = z.infer<typeof ShiftSchema>;

/** Default three-shift pattern used when a program declares none. */
export const DEFAULT_SHIFTS: Shift[] = [
  { name: 'Shift 1', start: '06:00', end: '14:00' },
  { name: 'Shift 2', start: '14:00', end: '22:00' },
  { name: 'Shift 3', start: '22:00', end: '06:00' },
];

const ConnectionScopeSchema = z.union([
  z
    .object({
      mode: z.literal('fixed'),
      servers: z.array(z.object({ registryId: z.string().min(1), serverUrl: z.string().min(1) }).strict()).min(1),
    })
    .strict(),
  z.object({ mode: z.literal('all') }).strict(),
]);
export type ConnectionScope = z.infer<typeof ConnectionScopeSchema>;

// ── Path grammar ─────────────────────────────────────────────────────────────

export type ParsedPath =
  | { callId: string; kind: 'rows' }
  | { callId: string; kind: 'rowCount' }
  | { callId: string; kind: 'columns' }
  | { callId: string; kind: 'row'; index: number }
  | { callId: string; kind: 'cell'; index: number; column: string }
  | { callId: string; kind: 'column'; column: string } // rows[*].Col
  | { callId: string; kind: 'agg'; agg: 'sum' | 'avg' | 'min' | 'max' | 'count'; column: string | null };

const PATH_SIMPLE_RE = /^([A-Za-z_][A-Za-z0-9_]*)\.(rows|rowCount|columns)$/;
const PATH_INDEX_RE = /^([A-Za-z_][A-Za-z0-9_]*)\.rows\[(\d+|\*)\](?:\.(.+))?$/;
const PATH_AGG_RE = /^([A-Za-z_][A-Za-z0-9_]*)\.rows\.(sum|avg|min|max|count)\((.*)\)$/;

/** Parse a result path; returns null when it is not in the grammar. */
export function parsePath(path: string): ParsedPath | null {
  const p = path.trim();
  let m = PATH_SIMPLE_RE.exec(p);
  if (m) return { callId: m[1], kind: m[2] as 'rows' | 'rowCount' | 'columns' };
  m = PATH_AGG_RE.exec(p);
  if (m) {
    const col = m[3].trim();
    return { callId: m[1], kind: 'agg', agg: m[2] as 'sum' | 'avg' | 'min' | 'max' | 'count', column: col ? col : null };
  }
  m = PATH_INDEX_RE.exec(p);
  if (m) {
    const column = m[3]?.trim();
    if (m[2] === '*') {
      if (!column) return { callId: m[1], kind: 'rows' };
      return { callId: m[1], kind: 'column', column };
    }
    const index = parseInt(m[2], 10);
    if (!column) return { callId: m[1], kind: 'row', index };
    return { callId: m[1], kind: 'cell', index, column };
  }
  return null;
}

/** The call id a path refers to, or null when the path is malformed. */
function pathCallId(path: string): string | null {
  return parsePath(path)?.callId ?? null;
}

// ── Program ──────────────────────────────────────────────────────────────────

export const PROGRAM_VERSION = 1 as const;

/** `{{Label|fmt}}` placeholders in a summary template. */
export const PLACEHOLDER_RE = /\{\{\s*([^}|]+?)\s*(?:\|\s*([A-Za-z0-9]+)\s*)?\}\}/g;

const ProgramSchema = z
  .object({
    programVersion: z.literal(PROGRAM_VERSION),
    title: z.string().min(1).max(160),
    scope: ConnectionScopeSchema,
    time: z
      .object({
        timezone: z.string().min(1),
        shifts: z.array(ShiftSchema).min(1).max(6).optional(),
      })
      .strict(),
    calls: z.array(CallSchema).min(1).max(40),
    kpis: z.array(KpiSchema).max(60).default([]),
    summary: SummarySchema.default({ kind: 'auto' }),
    notes: z.array(z.string().max(500)).max(50).optional(),
  })
  .strict()
  .superRefine((prog, ctx) => {
    const seen = new Set<string>();
    prog.calls.forEach((c, i) => {
      if (seen.has(c.id)) ctx.addIssue({ code: 'custom', path: ['calls', i, 'id'], message: `duplicate call id "${c.id}"` });
      seen.add(c.id);
    });
    // $ref / forEach may only point at EARLIER calls (they run in order).
    const before = new Set<string>();
    prog.calls.forEach((c, i) => {
      const check = (ref: string, path: (string | number)[]) => {
        const id = pathCallId(ref);
        if (!id) ctx.addIssue({ code: 'custom', path, message: `invalid path "${ref}"` });
        else if (!before.has(id)) ctx.addIssue({ code: 'custom', path, message: `"${ref}" must reference an earlier call` });
      };
      for (const [k, v] of Object.entries(c.args)) if (isRefExpr(v)) check(v.$ref, ['calls', i, 'args', k]);
      if (c.forEach) check(c.forEach.$ref, ['calls', i, 'forEach', '$ref']);
      before.add(c.id);
    });
    prog.kpis.forEach((k, i) => {
      const id = pathCallId(k.path);
      if (!id) ctx.addIssue({ code: 'custom', path: ['kpis', i, 'path'], message: `invalid path "${k.path}"` });
      else if (!seen.has(id)) ctx.addIssue({ code: 'custom', path: ['kpis', i, 'path'], message: `unknown call "${id}"` });
    });
    if (prog.summary.kind === 'template') {
      const labels = new Set(prog.kpis.map((k) => k.label));
      for (const m of prog.summary.text.matchAll(PLACEHOLDER_RE)) {
        if (!labels.has(m[1].trim())) {
          ctx.addIssue({ code: 'custom', path: ['summary', 'text'], message: `unknown KPI "${m[1].trim()}" in summary` });
        }
      }
    }
  });

export type Program = z.infer<typeof ProgramSchema>;

/** Validate + normalise an unknown value into a Program. Throws on invalid input. */
export function parseProgram(input: unknown): Program {
  return ProgramSchema.parse(input);
}

/** Non-throwing variant for validators that want the issue list. */
export function safeParseProgram(input: unknown): { ok: true; program: Program } | { ok: false; errors: string[] } {
  const r = ProgramSchema.safeParse(input);
  if (r.success) return { ok: true, program: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}

/** Shifts a program resolves against (declared or the default three). */
export function programShifts(p: Pick<Program, 'time'>): Shift[] {
  return p.time.shifts && p.time.shifts.length ? p.time.shifts : DEFAULT_SHIFTS;
}
