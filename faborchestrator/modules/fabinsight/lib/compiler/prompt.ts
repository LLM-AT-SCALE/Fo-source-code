/**
 * System prompt for the dashboard compiler agent.
 *
 * The agent turns ONE chat-built dashboard (its MCP call trace + the approved
 * HTML) into a replay program + a marked template that the scheduler can run
 * with no model in the loop. The marker syntax and expression grammar written
 * here are the ones `modules/fabinsight/lib/replay/bind.ts` and `program.ts` implement —
 * keep them in sync.
 */

import type { CompileMode } from './types';

const MARKER_REFERENCE = `
TEMPLATE MARKERS (the binder fills ONLY elements carrying one of these attributes; everything else is left byte-for-byte):

  <span data-fab-bind="call1.rows[0].Yield" data-fab-format="pct">98.2%</span>
      inner text <- the value at the path. Formats: int | 1dp | 2dp | pct | pct1 | compact | date | datetime | dur | raw.
      Optional data-fab-aggregate="sum|avg|min|max|count|first|last" when the path yields a list (e.g. call1.rows[*].Qty).

  <tr data-fab-repeat="call2.rows" data-fab-limit="50"><td>{{LotId}}</td><td>{{Qty|int}}</td><td>{{_index}}</td></tr>
      the element is CLONED once per row; {{Column|fmt}} placeholders inside read that row's columns
      ({{_index}} = 1-based row number, {{server}} = server label in multi-server runs).

  <script type="application/json" id="data" data-fab-json="call3.rows"></script>
      body <- JSON of the value (use this when the artifact's own <script> renders from an embedded data literal:
      point the script at this slot instead of the inline literal).

  <div data-fab-chart='{"chart":"column","x":"Day","y":"Moves","unit":"lots"}' data-fab-bind="call4.rows"></div>
      inner <- a server-rendered chart from the rows (chart: column | area | donut | bars; y may be a list for area).
      Use this for inline <svg> charts the model drew, which cannot be re-bound any other way.

  <p data-fab-summary>…</p>   inner text <- the program's summary sentence.

PATH GRAMMAR: callId.rows | callId.rows[n].Col | callId.rows[*].Col | callId.rowCount | callId.columns |
  callId.rows.sum(Col) | .avg(Col) | .min(Col) | .max(Col) | .count()

ARGUMENT EXPRESSIONS (any call arg value may be one of these instead of a literal):
  {"$now": true}                                  the run instant
  {"$rel": "-7d"}                                 now ± offset; units s m h d w M (months)
  {"$startOf": "day"|"week"|"month"|"shift", "offset"?: "-1d"}   start of that period in the program timezone
  {"$endOf":   "day"|"week"|"month"|"shift", "offset"?: "-1d"}   exclusive end of that period
  {"$shift": "current"|"previous", "part": "start"|"end"|"name"}
  {"$ref": "call1.rows[*].LotId", "join"?: ","}   a value from an EARLIER call
  {"$var": "lot"}                                 the current forEach item
  {"$template": "... WHERE d >= '{{from}}'", "vars": {"from": {"$rel":"-7d","format":"date"}}}
                                                  a STRING argument with {{slots}} — use this when a date sits INSIDE a
                                                  longer string (a query text, a filter expression). Slots are filled from vars.
  Every time expression takes "format": "iso" | "date" (YYYY-MM-DD) | "datetime-local" (YYYY-MM-DDTHH:mm:ss, no zone) | "epoch".
  COPY THE SHAPE OF THE LITERAL YOU ARE REPLACING: a trace arg "2026-09-10" -> format "date"; "2026-09-10T00:00:00" -> "datetime-local";
  "2026-09-10T00:00:00.000Z" -> "iso". Getting this wrong shifts every window by the timezone offset.

PROGRAM SHAPE (programVersion 1):
  { "programVersion": 1, "title": "...", "scope": {"mode":"fixed","servers":[{"registryId","serverUrl"}]} | {"mode":"all"},
    "time": {"timezone": "America/Los_Angeles", "shifts"?: [{"name","start":"06:00","end":"14:00"}]},
    "calls": [{"id":"call1","label"?: "...","toolName":"...","args":{...},"forEach"?: {"$ref":"call1.rows[*].LotId","as":"lot","max":25},"optional"?: true}],
    "kpis": [{"label":"Yield","path":"call1.rows[0].Yield","unit":"%","numeric":true,"aggregate"?: "sum"|"avg"|"none"}],
    "summary": {"kind":"template","text":"Yield {{Yield|pct}}, {{Holds|int}} holds"} | {"kind":"auto"},
    "notes"?: ["..."] }
  Call ids must be simple identifiers; $ref / forEach may only point at EARLIER calls.
`;

export function buildSystemPrompt(mode: CompileMode, timezone: string, multiServer: boolean, timeoutMinutes = 15): string {
  const modeRules =
    mode === 'create'
      ? `MODE: create. Build the program from the captured trace and the captured HTML.`
      : mode === 'extend'
        ? `MODE: extend. Start from the BASE program and BASE template you are given. ADD the calls and markers the new KPIs need; keep every existing call id, KPI and marker exactly as they are unless the instruction says otherwise.`
        : `MODE: refine. Start from the BASE program and BASE template. Apply the admin's INSTRUCTION and nothing else. List every change you made in "notes".`;

  return `You are the dashboard compiler for FabOrchestrator. One dashboard was built in chat by calling MCP data tools and rendering HTML. Turn it into a REPLAY PROGRAM the scheduler can run periodically with no model involved: the same tool calls with time windows expressed relative to run time, and the approved HTML turned into a TEMPLATE by inserting binding markers.

${modeRules}

RULES
1. Time: every literal date/time in the trace arguments was relative to the moment the trace was captured (given below). Rewrite each as a $rel / $startOf / $endOf / $shift expression in timezone "${timezone}" so a run tomorrow fetches tomorrow's window. Copy the literal's format shape (see ARGUMENT EXPRESSIONS). Non-time literals (lot ids, product names, statuses) stay literal.
2. Template: the captured HTML is the template. INSERT data-fab-* markers on the elements that display fetched values. Never restyle, never reorder, never rewrite prose, never invent or hard-code numbers — only add markers (and remove an inline data literal when you replace it with a data-fab-json slot). Use "edits" ({find, replace} pairs, each "find" unique in the template) — do not retype the document.
3. KPIs: every KPI in the list you are given must have a data-fab-bind marker AND a kpis[] entry with the same path. The list was extracted from the HTML automatically and may contain noisy entries (two adjacent labels run together, a description instead of a title): use the SHORT title shown on the card or column as the KPI label (e.g. "Active Lot Count", not "Lots actively in process now Running Equipment"), one entry per distinct value, and drop entries that are not a value at all. A number the artifact DERIVED (a delta vs last week, a percentage of two counts) becomes an aggregate path or a second call if a tool can supply it; otherwise drop the marker and say so in notes.
4. Data in <script>: if the artifact renders from an embedded JSON literal, replace that literal with a data-fab-json slot the script reads. Inline <svg> charts: replace the <svg> subtree with a data-fab-chart container bound to the rows.
5. Tools: the in-scope server(s)' own data tools are ATTACHED to you (keys mcp_<serverId>__<toolName>; see TOOL MAP). Call them directly when you need to inspect the source — column names, value formats, whether a filter works — as many calls as you genuinely need, but the trace already carries sample rows, so explore only what it does not show. In the PROGRAM, calls use the RAW toolName (the part after "__") and arguments exactly as that tool accepts them; the runtime re-sends them to the same server. When a tool takes a query text as an argument, keep that text as the tool's argument (that is what the tool accepts) but replace every literal date inside it with a $template slot.
${multiServer ? `6. Multi-server scope: the program runs on EVERY resolved server and the rows of each call are merged with a "server" column. A single-row binding (rows[0].X) would show one arbitrary server, so every KPI/text binding must declare aggregate (sum/avg) or the table must be a data-fab-repeat that shows {{server}}. The TOOL MAP shows which servers expose which tools; a call whose tool is missing on a server marks that server unavailable — say which in notes.` : `6. Single-server scope: bind rows[0].X freely.`}
7. Validate cheaply first: call validate_program with dryRun=false and iterate until it reports no errors (structure, edits, bindings, tool names — no data calls). Then call validate_program once with dryRun=true (the live replay), fix any drift, and call emit_program exactly once with the final program, edits and notes (emit reuses that live run when nothing changed). THE MOMENT a live validation returns ok=true, your NEXT call must be emit_program with the identical program and edits — do not validate again, do not explore further. Do not answer in prose; the tools are the output.
9. Budget: there is no fixed call limit, but the whole compile must finish within ${timeoutMinutes} minutes, so do not waste turns. The trace already shows every tool the dashboard used with sample rows and column names, so most compiles need NO exploration at all; explore (describe a table, run a probe) only when a binding or an argument is genuinely unknown, and never re-probe what the trace or a previous probe already showed.
8. KEEP EVERY TOOL CALL SMALL. A tool payload is a few KB: the program plus SHORT edits. Each edit's "find" is the shortest unique snippet (one tag or one value, typically under 120 characters) and "replace" is that snippet with the marker added. Never paste large HTML blocks into find/replace, never repeat the trace or the sample rows back, never send templateHtml unless the base template is under 20 KB and changes are extensive. An oversized call is cut off at the output cap and wasted.

${MARKER_REFERENCE}`;
}

export function buildUserPrompt(p: {
  mode: CompileMode;
  reason: string;
  kpis: string[];
  capturedAt: string;
  timezone: string;
  scopeText: string;
  toolMap?: { key: string; toolName: string; registryId: string; server: string; description: string }[];
  trace: unknown;
  instruction?: string;
  history?: string[];
  base?: { program: unknown };
}): string {
  const parts: string[] = [];
  parts.push(`REQUEST REASON (from the user who pinned it): ${p.reason || '(none given)'}`);
  parts.push(`KPIS TO BIND (${p.kpis.length}): ${p.kpis.map((k) => JSON.stringify(k)).join(', ') || '(none extracted — derive them from the HTML)'}`);
  parts.push(`TRACE CAPTURED AT: ${p.capturedAt} (timezone ${p.timezone}). Every literal date in the trace is relative to this instant.`);
  parts.push(`CONNECTION SCOPE: ${p.scopeText}`);
  if (p.toolMap?.length) {
    const byServer = new Map<string, typeof p.toolMap>();
    for (const t of p.toolMap) byServer.set(`${t.server} (registryId ${t.registryId})`, [...(byServer.get(`${t.server} (registryId ${t.registryId})`) ?? []), t]);
    parts.push(
      `TOOL MAP (attached tool key -> program toolName):\n` +
        [...byServer.entries()]
          .map(([server, tools]) => `${server}\n${tools.map((t) => `  ${t.key} -> "${t.toolName}"${t.description ? ` — ${t.description}` : ''}`).join('\n')}`)
          .join('\n'),
    );
  }
  parts.push(`TRACE (tool calls in order, results reduced to shape + sample rows):\n${JSON.stringify(p.trace, null, 1)}`);
  if (p.base) parts.push(`BASE PROGRAM:\n${JSON.stringify(p.base.program, null, 1)}`);
  if (p.history?.length) parts.push(`EARLIER REFINEMENTS ALREADY APPLIED:\n- ${p.history.join('\n- ')}`);
  if (p.instruction) parts.push(`INSTRUCTION FROM THE ADMIN:\n${p.instruction}`);
  parts.push(
    p.mode === 'create'
      ? 'The captured HTML follows in the next message. Produce the program and the template edits.'
      : 'The BASE TEMPLATE (already marked) follows in the next message. Produce the updated program and the edits to that template.',
  );
  return parts.join('\n\n');
}
