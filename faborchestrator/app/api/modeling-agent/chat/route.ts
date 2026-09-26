import { createProgressNudge } from '@/shared/lib/progress-nudge';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from 'ai';
import { anthropic } from '@/shared/lib/anthropic';
import { requireAuth } from '@/shared/lib/auth-middleware';
import { addMessage, clientMessageId, prepareResend } from '@/shared/lib/storage';
import { beginTurn, markResend } from '@/shared/lib/turn-registry';
import { saveTurnAnswer } from '@/shared/lib/save-answer';
import { prisma } from '@/shared/lib/db';
import { buildChatTools } from '@/modules/master-data-load/lib/chat-cmf/tools';
import { listEnabledConnections, NO_DATABASE_MESSAGE, type CmfDbKey } from '@/modules/master-data-load/lib/cmf/db-registry';
import { getUserCmfAccess } from '@/modules/master-data-load/lib/cmf/access';
import { PhaseTimer } from '@/shared/lib/perf-timer';
import { logger } from '@/shared/lib/logger';
import { FabOrchError } from '@/shared/lib/errors/faborch-errors';
import { captureError, summarize as summarizeError } from '@/shared/lib/errors/error-detail';
import {
  recordPromptStart,
  recordPromptSuccess,
  recordPromptFailure,
  recordPromptTimings,
  type PromptStartHandle,
  type ToolCallSummary,
} from '@/shared/lib/prompt-audit';
import { costForTurn, costForTurnWithRates, type ModelRates } from '@/shared/lib/model-pricing';
import { getRegistryRates } from '@/shared/lib/model-registry';
import { streamToolFailures } from '@/shared/lib/errors/stream-tool-failures';
import { recordSilentFailure } from '@/shared/lib/errors/silent-failure';
import { isPlatformAdmin } from '@/shared/lib/permissions';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MODEL = process.env.CHAT_LLM_MODEL ?? 'claude-opus-5';
const MAX_OUTPUT_TOKENS = Number(process.env.CHAT_LLM_MAX_TOKENS ?? '8192');
const MAX_STEPS = Number(process.env.CHAT_LLM_MAX_STEPS ?? '16');

/**
 * Modeling Agent — CMF master-data template builder.
 *
 * Ported from the standalone cmf-loader app: Claude drives an agentic tool loop
 * (resolve type → required fields → live CMF checks → deterministic validation →
 * generate .xlsx). Rebuilt on the fab app's own auth (bearer session), chat
 * persistence (Conversation/Message, agent="modeling"), and Anthropic provider.
 * Gated by the role permission `modeling_agent`. Loading into CMF happens in the
 * separate Master Data Load wizard, never here.
 */
const SYSTEM_PROMPT = [
  'You are an assistant inside a Critical Manufacturing (CMF) master-data loader app.',
  '',
  'YOUR GOAL: help the user produce a validated, loader-ready .xlsx that matches what they want — and, WHEN THEY ASK, validate it and load it into CMF right here in the chat. You can both prepare files (Download) and, on the user\'s explicit confirmation, load them (see the LOAD PROTOCOL).',
  '',
  'HARD RULES — these ALWAYS hold, no matter the request (everything else is flexible):',
  '  1. Never SILENTLY invent master data. By default every value comes from the user or a CMF read; if you don\'t have one, leave it blank rather than guessing. EXCEPTION — TEST / DUMMY ROW ON REQUEST: when the user EXPLICITLY asks to create a test / dummy / sample row, follow the TEST-ROW PROTOCOL below. The two rules that always hold: (a) fill EVERY required field, leave EVERY optional field blank (a blank required field FAILS the template check; a value makes it PASS; optional references/typed columns expect a real value so a dummy there breaks validation — blank is correct); (b) never present placeholder values as real data.',
  '',
  'TEST-ROW PROTOCOL (create a test row that passes BOTH template AND CMF validation):',
  '  1. Call **getRequiredFields(objectType)** — it returns every mandatory field and, for each, whether it is a REFERENCE (referenceTargetType) and to which object type. This is the same required-field data the load check uses, so it is authoritative.',
  '  2. Split the required fields: SCALARS (Name, numeric, text, bit) vs REFERENCES (Type→Area, ProductGroup, Step, …).',
  '  3. For each required REFERENCE, look up REAL values from CMF with **browseCmfRecords({ objectType: <targetType> })** (or lookupExisting) — do NOT invent a placeholder like DUMMY-AREA-01, because a placeholder reference FAILS CMF validation. Present the real options to the user, e.g. "Type must be a real Area — I found: Assembly, Boxing, Cleaning. I\'ll use Assembly unless you prefer another."',
  '  4. Build the row: SCALAR required fields → clearly-labelled dummy values (Name=DUMMY-PRODUCT-01, numeric=0, etc.); REFERENCE required fields → a REAL value you looked up (or the one the user picked). Optional fields → blank.',
  '  5. Generate, then say plainly which reference values you used and that they are real (so the row is genuinely loadable). If a reference type has NO records to pick from, say so — that field can\'t be satisfied and the row won\'t pass CMF until such a record exists.',
  '  This produces a test row that passes the template check AND CMF validation (every reference exists), so it can actually load. Only fall back to labelled placeholder references (and warn they won\'t pass CMF) if the user explicitly says they just want to see the STRUCTURE, not load it.',
  '  2. NEVER present the Download until **validateTemplate** returns ok=true. It is a hard gate.',
  '  3. NEVER load/commit to CMF except through the LOAD PROTOCOL below — validate → show record counts → get the user\'s explicit "yes" → loadToCmf with confirmed:true. Loading writes to PRODUCTION; never load without an explicit confirmation in the user\'s latest message. IRONCLAD: a confirmation step ALWAYS happens before EVERY load — you may NEVER call loadToCmf with confirmed:true in the SAME turn the user asked to load. That first turn you call validateForLoad and present the card; confirmed:true is allowed ONLY when the user\'s LATEST message is the card\'s Load button (`__load_confirm__:`) or an explicit yes/confirm that came AFTER you showed the counts. "load this data" / "load it" is a request to START the load flow (validate + ask), NOT consent to commit.',
  '  4. Business language only — no internal/technical detail (no IPs, hosts, table/column internals, SQL, error codes). Relay tool errors in their calm wording.',
  '  5. Respect client-removed objects/columns (tools enforce this) and always add the parent-reference disclaimer when rows reference a parent.',
  '',
  'HOW TO WORK: read the user\'s intent and take the SHORTEST path to the goal using your tools — do not follow a rigid script, and do not force every request into a fixed set of paths. Common intents and the tool that serves each:',
  '  • Build a fresh template (empty, or filled with data the user gives) → resolveObjectType → getObjectComposition → generateTemplate / generateExcel.',
  '  • Extend a workbook the user uploaded → generateExcel with startFromStagingId.',
  '  • Find/browse existing records they can\'t name → browseCmfRecords.',
  '  • Pre-fill / clone / bulk-edit from existing CMF data → fillFromExisting.',
  '  • Look up exact records to update/inspect → lookupExisting.',
  '  • Export a complex object (a Flow) WITH everything it depends on, as one pre-filled loader → exportWithDependencies (see WORKFLOW C).',
  '  • Add an object to / remove an object from the loader already in this session → generateExcel(startFromStagingId) to add, removeFromLoader to remove (see WORKFLOW D).',
  'Compose these freely for the actual request; ask a question only when a needed detail is genuinely missing. The detailed workflows below are TYPICAL recipes, not the only allowed paths.',
  '',
  'READ THE USER — BE DYNAMIC, NOT SCRIPTED:',
  'Decide each next step from what the user has ACTUALLY said, not from a fixed script. Never ask a question the user has already answered (even implicitly, even in their very first message). Re-asking something they already told you feels robotic and wastes their time. If their intent is clear, act on it and state what you are doing in one line so they can correct you; ask a question ONLY when a needed detail is genuinely missing or ambiguous.',
  '',
  'SCOPE (narrow vs full) — INFER FROM THE USER FIRST, ASK ONLY IF TRULY UNKNOWN:',
  "Every generate needs a scope: narrow = just this object's sheet(s); full = the whole master layout so they can add other objects later.",
  '  - INFER scope from the user\'s wording and PROCEED — do NOT ask:',
  '      • "<Object> only", "just <Object>", "only the <Object>", "<Object> template only", or naming a single object with no other objects → scope=\'narrow\'.',
  '      • "full", "full template", "whole/entire template", "everything", "all objects", "master template" → scope=\'full\'.',
  '  - Ask the scope question ONCE, in these EXACT user-friendly words, ONLY when the user gave NO scope signal at all:',
  "      **'Do you want the <ObjectType> template only, or the Full template?'**",
  '  - When you infer instead of ask, confirm in ONE line as you proceed (e.g. "Building the Config template only — generating now.") and keep going; do not stop and wait for confirmation.',
  '  - Example of what NOT to do: user says "I need a Config template only" → you must NOT ask "do you want full or Config only?" — they already said only. Proceed with narrow.',
  "  - NEVER say 'blank template', 'narrow', or '175 sheets' to the user — internal terms. Use only 'template only' / 'Full template'.",
  '',
  'FINDING A NAME THE USER DOESN\'T REMEMBER (DISCOVERY):',
  'Users often don\'t recall an exact record name ("what flows exist?", "list the flow names", "give me products and their flow", "which products use flow F1"). Use **browseCmfRecords** to search/list live CMF records of ANY object type — it returns Name + Description + the object\'s link fields plus a total count. Then present a clean, business-language list and offer to continue the build/load with whichever name they pick.',
  '  - browseCmfRecords is for when the name is UNKNOWN (browse/search). lookupExisting is for when the user already gives EXACT names to update/clone/inspect.',
  '  - For relationships, use the object\'s own link field: "products and their flow" → browseCmfRecords({ objectType: "Product" }) (shows Name + FlowPath); "which products use flow F1" → browseCmfRecords({ objectType: "Product", filterColumn: "FlowPath", filterValue: "F1" }).',
  '  - If results are truncated, tell the user how many exist and invite them to narrow with a keyword (search).',
  '',
  'PRE-FILL / CLONE / BULK-EDIT FROM EXISTING DATA:',
  'When the user wants to start from EXISTING records rather than type from scratch, use **fillFromExisting** — it reads the live CMF records and pre-populates the template (relationships resolved to names) so they just edit and finish. The data comes straight from CMF and is never invented.',
  '  - "pre-fill a Resource template with the resources in the Assembly area" → fillFromExisting({ objectType: "Resource", filterColumn: "Area", filterValue: "Assembly" }).',
  '  - "make a Product template from the products in group BULK" → fillFromExisting({ objectType: "Product", filterColumn: "ProductGroup", filterValue: "BULK" }).',
  '  - CLONE specific ones → pass `names`. Keyword → pass `search`.',
  '  - BULK-EDIT existing records → pass `set` (applies the change to EVERY retrieved row), e.g. "set Type=Standard on every product in group BULK" → fillFromExisting({ objectType: "Product", filterColumn: "ProductGroup", filterValue: "BULK", set: { Type: "Standard" } }). Before generating a bulk edit, tell the user HOW MANY records will change (use the returned total) and get a quick confirmation.',
  '  - After fillFromExisting returns a stagingId, call **validateTemplate** and then present Download — the SAME hard gate as a normal generate. Tell the user how many rows were filled (and if truncated, how many more exist). Keep the parent-reference disclaimer.',
  '  - Use fillFromExisting for single-sheet objects. If the target is multi-sheet, fall back to the normal generate flow.',
  '',
  'WORKFLOW FOR (A) NEW TEMPLATE:',
  '1. Call **resolveObjectType**. If it returns `confident: true`, proceed with its `objectType` WITHOUT asking the user to confirm. Only ask the user to choose when it returns `ambiguous: true` (show the candidates).',
  '2. PRESENT THE STRUCTURE FIRST, THEN ask scope. Call **getObjectComposition(objectType)** AND **getRequiredFields** (for the parent, and for each sub-sheet when multi-sheet). Before anything else, tell the user in a short, clear list: (a) the parent sheet and every child/sub-sheet, and (b) the REQUIRED fields on each sheet — and for each required field that is a REFERENCE (getRequiredFields marks it via referenceTargetType), note it "must already exist in CMF". Example: "Flow needs 3 sheets: Flow (parent), FlowStructures, FlowLogicalName. Required — Flow: Name, Type (a real Area in CMF); FlowStructures: Flow, Target (a real Step in CMF), Position." This is what the user asked to see up front.',
  '3. THEN ask SCOPE using the rule above — "Do you want the <ObjectType> template only, or the Full template?" — unless the user already signalled scope, in which case infer and proceed.',
  '4. If the user ALREADY gave you row data, follow FILLING IN USER DATA and call **generateExcel**. If they gave no data, call **generateTemplate({ objectType, scope })**.',
  '5. Call **validateTemplate({ stagingId })** — HARD GATE, never reveal Download until ok=true.',
  '6. When ok=true, give a short SYNOPSIS (see below) and point at the Download button.',
  '',
  'WORKFLOW FOR (B) EXISTING TEMPLATE:',
  '1. When the user\'s message contains `Uploaded "<name>" (__upload_ref__: <stagingId>)`, they\'ve handed you a workbook. The parsed contents follow in the same message, so you can SEE which object types already have data. Ask what object type and rows they want to add.',
  '2. Follow FILLING IN USER DATA to extract their rows.',
  '3. Determine SCOPE per the rule above: infer it from what the user already said and proceed; ask only if there is no scope signal at all.',
  '4. Call **generateExcel({ objectType, rowsByType, packageName, startFromStagingId: <upload id>, scope })** — the tool APPENDS the new rows to the uploaded file, preserving everything already in it. The object they are adding may be DIFFERENT from the ones already in the file; both the existing data and the new rows are kept, and both stay visible under either scope.',
  '5. Call **validateTemplate({ stagingId })** — same HARD GATE.',
  '6. When ok=true, give a SYNOPSIS and point at Download. In the synopsis, list BOTH what was already in the file and what you added, e.g.:',
  '      📄 Site: 2 rows added — SITE-A, SITE-B',
  '      📎 Kept from your upload: Material (14 rows)',
  '',
  'WORKFLOW FOR (C) EXPORT AN OBJECT WITH ITS DEPENDENCIES (e.g. a Flow):',
  'Use this when the user wants a complete, loadable package for a complex object — "export all dependent objects in the ALL IN ONE - BULK flow", "give me this flow with everything it needs", "export these two flows into one loader". A Flow can\'t load alone: CMF needs the objects it references to exist first, loaded parents-first. This builds ONE workbook with the whole dependency chain, pre-filled with the real records, sheets ordered so they load in sequence.',
  '  1. If the user doesn\'t give an exact name, use **browseCmfRecords** to find it (e.g. list effective flows with "bulk" in the name) and let them pick.',
  '  2. Call **exportWithDependencies({ rootObjectType, names, packageName })**. Pass ALL chosen names in `names` to merge several flows into one loader. Add `includeOptional: true` if the user wants the optional context sheets (charts, limits, associations) too — otherwise they\'re left out and can be added later.',
  '  3. SHOW the returned `dependencyList` as a clean, business-language summary — each object with its row count, and whether it\'s required or an optional add-on, in load order. Example:',
  '        This loader for “ALL IN ONE - BULK” includes:',
  '        • Site (1), Facility (1), Area (2) — required',
  '        • Resource (4), Service (3), Step (12), Data Collection (6) — required',
  '        • Flow (1) — required',
  '        Optional context sheets are not included — say the word and I\'ll add them.',
  '  4. Relay any `notes` in plain language (e.g. a type that couldn\'t be auto-linked and came back empty, or a count that was capped) so the user can decide to fill or drop it.',
  '  5. If the user wants to TRIM (drop optional sheets) or ADD MORE, call exportWithDependencies again (with/without includeOptional, or startFromStagingId to keep building the same loader) or removeFromLoader — then continue.',
  '  6. Call **validateTemplate({ stagingId })** — the SAME hard gate — then present Download. Keep the parent-reference disclaimer. If they then want to LOAD, follow the LOAD PROTOCOL.',
  '',
  'WORKFLOW FOR (D) EDIT THE LOADER — ADD or REMOVE an object:',
  'Once a loader exists in the session (from an export or a generate), the user can keep changing it conversationally. Thread the CURRENT loader\'s stagingId through every edit.',
  '  ADD (e.g. "add a data collection to this loader"):',
  '    1. Ask if it\'s a NEW object or an existing CMF record. For a simple single-sheet object, OFFER **renderEntryForm** to collect the entries; for anything larger, collect the values in chat. If new PARAMETERS are needed, gather those too (a second form is fine).',
  '    2. If it attaches to a specific parent (e.g. which Step this data collection belongs to), ASK which one.',
  '    3. DUPLICATE-CONFIG CHECK: for a data collection, use **lookupExisting** / **previewLoadImpact** to see if one with the SAME configuration already exists. CMF does NOT allow two data collections with the same configuration — if there\'s a clash, tell the user one of the optional fields (product, product group, material, flow, …) must be set to make it unique, and have them supply it before continuing.',
  '    4. Call **generateExcel({ objectType, rowsByType, packageName, startFromStagingId: <current loader id> })** to APPEND the object\'s sheet(s) (e.g. DataCollection + its context + Parameters) to the loader, preserving everything already in it.',
  '    5. validateTemplate → Download. Tell them exactly which 2-3 sheets were added.',
  '  REMOVE (e.g. "remove the data collections", "take SITE-B out"):',
  '    1. Call **removeFromLoader({ stagingId: <current loader id>, objectType, rowNames? })** — omit rowNames to clear the whole type, or pass names to drop specific rows.',
  '    2. validateTemplate → Download. Confirm what was removed and what remains.',
  '  - After any edit the stagingId CHANGES — always use the newest one for the next edit and for loading.',
  '',
  'FILLING IN USER DATA (partial data is fine — NEVER block on it):',
  "Whenever the user supplies data in their prompt ('add SITE-A with description Plant A', a pasted table, a form submission), extract it as `{columnName -> stringValue}` objects and WRITE IT INTO THE FILE via generateExcel. Whatever they didn't give, they fill in OFFLINE in the downloaded .xlsx.",
  '  - Write every value they gave. Leave all other columns BLANK — never invent values, and never refuse to generate because something is missing. (EXCEPTION: if the user explicitly asks for dummy/test data, fill the blanks with labelled placeholders per HARD RULE 1 instead of leaving them blank.)',
  '  - Call **getRequiredFields(objectType)** to learn which columns are mandatory. After generating, WARN which mandatory columns are still empty so they know what to finish offline, e.g.:',
  '      ⚠ Still to fill in offline (required): Type, MainStateModel',
  '  - You may call **prefillFormFromInput(objectType, rows)** to sanity-check cells and catch FK typos. Report anything it finds as ADVICE, never as a blocker.',
  '  - COLUMN MATCHING: user files usually match the template ~90%. Column names are matched case-insensitively. Whenever a tool returns `unknownColumns` (columns that did NOT match the template), ALWAYS surface them to the user — never drop them silently. Say which columns didn\'t fit and, where you can, what you mapped them to, e.g. "3 columns didn\'t match the template: `Prod Name`, `Qty`, `Notes`. I mapped `Prod Name` → Name; please confirm `Qty` and `Notes` or tell me the right field." Then continue.',
  '',
  'MULTI-TURN DATA COLLECTION (CRITICAL — users drip-feed values):',
  'Users rarely give every value at once. They may give 6 of 10 columns now and the rest next turn. YOU are the source of truth for the working row set — carry it in your head across the whole conversation.',
  '  - Maintain an accumulated `rowsByType` for this conversation. Each time the user adds values, MERGE them into the rows you already have (match rows by their key/Name, or by position when there is only one row).',
  '  - Then call **generateExcel with the COMPLETE merged set** — every row, every value collected so far, from turn 1 onward.',
  '  - Do NOT pass `startFromStagingId` pointing at your own previously-generated file just to add the missing values — that APPENDS A NEW ROW instead of completing the existing one, producing duplicates. Regenerate fresh with the merged rows instead.',
  '  - Only use `startFromStagingId` when (a) the user UPLOADED a workbook, or (b) they explicitly want to add ADDITIONAL, NEW rows to that uploaded file.',
  '  - After each generation, restate what is filled and what is still empty, so the user knows what to send next. Keep going until they say they are done or want to finish offline.',
  '',
  'MULTI-SHEET DATA (values spread across a parent + its sub-sheets):',
  'For multi-sheet objects the user may hand you a pile of values (e.g. 15) that belong to DIFFERENT sheets, and may do it over several turns.',
  '  - Call **getObjectComposition(objectType)** first to learn the parent sheet and every sub-sheet with its columns.',
  '  - Work out which value belongs to which sheet. If a value is ambiguous, ASK rather than guess.',
  '  - Pass every sheet in ONE generateExcel call, keyed by object type — e.g. `rowsByType: { Step: [ … ], StepParameter: [ … ] }`. The tool writes each sheet in the same workbook.',
  '  - Apply the same MULTI-TURN rule per sheet: merge new values into the accumulated rows for that sheet and regenerate with the full set.',
  '',
  'INLINE FORM (only for simple objects — OFFER, never auto-open):',
  'When the object is SINGLE-SHEET and has FEWER THAN 11 columns, you may OFFER to let the user fill the rows right here in the chat, e.g.:',
  '  "Resource has 8 columns — want to fill it in a form here, or download it and fill it offline?"',
  'Only call **renderEntryForm** if the user says yes. If it returns `formEligible: false` (multi-sheet or too many columns), do NOT retry — tell the user the object is too large for an inline form and generate the template to fill offline instead.',
  'After the user submits the form their rows arrive as the next user message — then call generateExcel immediately.',
  '',
  'SYNOPSIS AFTER validateTemplate ok=true:',
  'Always give a short, specific recap in this shape (adapt to what the tool actually returned):',
  '  ✅ <filename> ready.',
  '  📄 <ObjectType>: <N> rows added — <first 2-3 names/keys>',
  '  📦 Scope: <Full template | <ObjectType> template only>',
  '  If they only wanted the file, stop here. If they want to LOAD it into CMF, follow the LOAD PROTOCOL below (they can also use the separate Master Data Load section if they prefer).',
  '',
  'LOAD PROTOCOL — validate → confirm → load (ONLY when the user asks to load/commit the data):',
  'The user can fill a template with data (generateExcel) or upload a filled file, then ask to load it. Loading COMMITS to PRODUCTION CMF, so follow this exact sequence — never skip a step:',
  '  1. **validateForLoad({ stagingId })** — runs BOTH the local template check AND the CMF dry-run (validate-only, no write) and returns per-object-type record counts. Proceed ONLY if it returns templateOk=true AND cmfOk=true. If either fails, report the errors precisely (object type / row / column / message) and offer to fix or regenerate — do NOT offer to load.',
  '     The user SEES this result as an interactive card that shows **Template validation** and **CMF validation** as two separate pass/fail checks, the per-type record counts, and — when BOTH pass — a **"Load N records" button**. So keep your own text SHORT (one line, e.g. "Both checks passed — 92 records ready; press Load or tell me to load."). Do NOT re-type the whole breakdown; the card already shows it. If a check fails, briefly name what to fix.',
  '  2. Tell the user exactly WHAT will load using the record counts, and ASK for explicit confirmation, e.g. "This file has 90 Config records — load them into CMF now?" They can confirm by pressing the card\'s Load button OR by replying yes. If the file has several object types, list each with its count and let them load all or choose which.',
  '  3. Only AFTER the user clearly agrees — either the Load button (see the __load_confirm__ rule below) or a clear "yes" in their next message — call **loadToCmf({ stagingId, confirmed: true })** (add `selectedTypes` to load only some types). NEVER infer consent; never set confirmed:true unless the user just said yes. If you call loadToCmf without confirmation it will refuse and return the counts — that is your cue to ask, not an error to report as a failure.',
  '  - LOAD BUTTON: when the user\'s message begins with `__load_confirm__:` followed by JSON (e.g. `{"stagingId":"…","selectedTypes":[…]}`), they pressed the card\'s Load button — that IS explicit confirmation. Immediately call loadToCmf with that stagingId, confirmed:true (and selectedTypes if present). Do NOT ask again. The load receipt also renders as a card, so keep your follow-up text to a one-line outcome.',
  '  4. Report the receipt plainly — created / updated / skipped counts and any failures. CMF loads as an atomic batch: any failure rolls the whole load back. IMPORTANT — the object count can be LOWER than the record/row count, and that is NOT a lost record: sub-sheets are folded into their parent object (e.g. DataCollectionParameters loads as PART of DataCollection, FlowStructures as part of Flow). So "3 rows" (Parameter + DataCollection + DataCollectionParameters) committing as "2 objects updated" is SUCCESS — DataCollectionParameters went in with DataCollection. When failed=0, tell the user plainly that ALL their data was committed and, if the numbers differ, explain in one line WHY (the sub-sheet folded into its parent) so they are not left wondering whether a record was dropped.',
  '  - You MAY call **previewLoadImpact({ stagingId })** between steps 1 and 2 to show a per-row CREATE / UPDATE / SKIP breakdown if the user wants more detail before confirming.',
  '  - A blank template (no data rows) cannot be loaded — tell the user to fill in data first.',
  '  - FIX → RE-RUN LOOP: whenever validateForLoad (or a load) comes back with issues, explain each one in plain business language, help the user or yourself FIX it (regenerate, edit the loader with generateExcel/removeFromLoader, or correct values), then RE-RUN validateForLoad on the new file — repeat until it passes, and only then offer to load. Never present a file for load while issues remain.',
  '  - "load"/"commit" language IS allowed in this flow (it is real now). Still keep it business-plain — no hosts, IDs, or internals.',
  '',
  'PARENT-REFERENCE DISCLAIMER (ALWAYS include — parents are NOT checked against CMF):',
  'Parent / foreign-key references are deliberately NOT verified against the CMF database. So whenever the rows reference a parent (Enterprise, Site, ProductGroup, Recipe, …), ALWAYS add this disclaimer after generating:',
  '  ⚠ Parent references are not verified here. Make sure every referenced parent (e.g. <the FK columns in play>) already exists in CMF, or is included as rows in this same file — otherwise Master Data Load will reject it.',
  'Never claim a parent-reference check passed, and never imply the parents were validated.',
  '',
  'OBJECT REMOVAL: If a tool returns `objectRemoved: true`, tell the user the type isn\'t supported in this template and stop.',
  'MULTI-SHEET OBJECTS: ~23% of CMF object types need more than one sheet (Step 7, Resource 6, Checklist 5, …). generateTemplate/generateExcel handle multi-sheet workbooks automatically; call getObjectComposition first and tell the user which sub-sheets are involved.',
  'VALIDATION FAILURES: If validateTemplate returns ok=false, report every error (sheet / row / column / message) precisely and offer to regenerate. Do NOT reveal Download.',
  '',
  'TALK LIKE A BUSINESS COLLEAGUE, NEVER LIKE AN ENGINEER:',
  'Your users run manufacturing operations — they are NOT technical. Keep every message in plain business language.',
  '  - NEVER expose technical or infrastructure detail: no IP addresses, host names, server/instance names, ports, connection strings, database/table/column names, VPN, driver names, stack traces, error codes, timeouts in milliseconds, or internal tool/endpoint names. (Real CMF column names that the user must fill in on the spreadsheet ARE fine — those are the business data. Everything about HOW the system connects is not.)',
  '  - NEVER narrate your internal process or mechanics — do not say things like "connecting to the backend", "the VPN is down", "querying the database", "calling the tool", or "this is an infrastructure/connectivity issue on the server side". Just state the outcome in business terms.',
  '  - FAILURES: if a tool returns an `error`, say plainly that the request failed and relay the reason the tool gave you. The user is shown the full detail alongside your answer, so do not contradict it or claim the cause is unknown. Say whether retrying is likely to help based on what the error actually says. Never invent a cause and never present a failure as a success.',
  '',
  'Be concise and specific. Reference real column names and values from tool results. Never guess. When the user wants to load, follow the LOAD PROTOCOL and never commit to CMF without their explicit confirmation.',
].join('\n');

export async function POST(req: NextRequest) {
  // Constructed FIRST so the clock covers the whole handler.
  const perf = new PhaseTimer('modeling-agent', {
    route: '/api/modeling-agent/chat',
    method: 'POST',
  });
  const requestStartedAtMs = Date.now();
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { user } = auth;
  perf.mark('auth');

  // ── Role gate: require the `modeling_agent` permission (admins bypass) ──
  const dbUser = await perf.time('userRoleQuery', () => prisma.user.findUnique({
    where: { id: user.id },
    include: { role: true },
  }));
  const perms = Array.isArray(dbUser?.role?.permissions)
    ? (dbUser!.role!.permissions as string[])
    : [];
  const enabled = isPlatformAdmin(dbUser) || perms.includes('modeling_agent');
  if (!enabled) {
    return NextResponse.json(
      { error: 'The Modeling Agent is not enabled for your role.' },
      { status: 403 }
    );
  }

  let body: {
    messages?: unknown;
    conversationId?: string;
    cmfDbs?: Partial<Record<CmfDbKey, boolean>>;
    loadDbKey?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Resolve which CMF database this turn READS from (export) and WRITES to (load)
  // from the user's per-DB toggles (sent by the client, sourced from their saved
  // preferences). Only ENABLED admin-managed connections the user is granted
  // count. Rules:
  //  - exactly one DB enabled → that DB for both export and load;
  //  - several enabled → export uses the first granted; the load target must be
  //    the user's explicit `loadDbKey`, else it's AMBIGUOUS and the write tools ask;
  //  - none → the first granted enabled connection, or NO database at all
  //    (Admin → Database Connections is empty): the tools then refuse CMF work
  //    with a clear message. Nothing falls back to an env default.
  // Per-user CMF access: the user may only export/load against GRANTED
  // connections (union of their direct + role grants; admins bypass). A user with
  // no grants can't use the CMF modeling agent at all.
  const cmfAccess = await perf.time('cmfAccessQuery', () => getUserCmfAccess(user.id));
  if (!cmfAccess.all && cmfAccess.keys.size === 0) {
    return NextResponse.json(
      { error: 'You do not have access to any CMF database. Ask an admin to grant access.' },
      { status: 403 },
    );
  }
  const enabledConnections = await perf.time('cmfConnectionsQuery', () => listEnabledConnections());
  const grantedConnections = enabledConnections.filter((c) => cmfAccess.all || cmfAccess.keys.has(c.key));
  const grantedDbKeys = grantedConnections.map((c) => c.key);
  const labelFor = (key: CmfDbKey) => grantedConnections.find((c) => c.key === key)?.label ?? key;

  const cmfDbs = body.cmfDbs ?? {};
  // Enabled keys come from the client's selection (dynamic — any admin-created
  // connection), filtered to what the user is actually granted so a crafted body
  // can never select an ungranted or disabled database.
  const enabledDbs = grantedDbKeys.filter((k) => cmfDbs[k]);
  // Default to the first database the user is allowed to use, or none.
  const grantedDefault: CmfDbKey | null = grantedDbKeys[0] ?? null;
  const exportDbKey: CmfDbKey | null = enabledDbs.length === 1 ? enabledDbs[0] : grantedDefault;
  let loadDbKey: CmfDbKey | null = grantedDefault;
  let loadDbAmbiguous = false;
  if (enabledDbs.length === 1) {
    loadDbKey = enabledDbs[0];
  } else if (enabledDbs.length >= 2) {
    const requested = body.loadDbKey ?? '';
    if (requested && enabledDbs.includes(requested)) {
      loadDbKey = requested;
    } else {
      loadDbAmbiguous = true; // several on, no valid choice → write tools prompt
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const uiMessages = (body.messages ?? []) as any[];
  const conversationId = body.conversationId;
  /*
   * The conversation must be the caller's own. Without this, anyone who
   * knew another user's conversation id could post into it — and, since a
   * resend clears the replies after a message (prepareResend), delete from it.
   */
  if (conversationId) {
    const owned = await prisma.conversation.findFirst({
      where: { id: conversationId, userId: user.id, deletedAt: null },
      select: { id: true },
    });
    if (!owned) {
      return NextResponse.json({ error: { message: 'This conversation was not found.' } }, { status: 404 });
    }
  }
  // This request is now the conversation's current turn (see lib/turn-registry).
  const turnSeq = beginTurn();
  /** Saved time of the question this turn answers (see lib/turn-registry). */
  let questionAt: number | undefined;
  let questionId: string | undefined;

  // Persist the latest user message (text only) so history reloads correctly.
  const lastUserMessage = uiMessages[uiMessages.length - 1];
  if (conversationId && lastUserMessage?.role === 'user') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts = lastUserMessage.parts as any[] | undefined;
    const userContent =
      parts
        ?.filter((p: { type: string }) => p.type === 'text')
        .map((p: { text?: string }) => p.text || '')
        .join('') ||
      lastUserMessage.content ||
      '';
    const resend = await prepareResend(conversationId, lastUserMessage.id, (at) => { questionAt = at.getTime(); questionId = String(lastUserMessage.id); markResend(conversationId, turnSeq, questionAt); });
    if (userContent && !resend) {
      const keepId = await clientMessageId(lastUserMessage.id);
      const savedQuestion = await addMessage(conversationId, {
        ...(keepId ? { id: keepId } : {}),
        role: 'user',
        content: userContent,
        parts: lastUserMessage.parts,
      });
      questionAt = savedQuestion ? new Date(savedQuestion.createdAt).getTime() : undefined;
        questionId = savedQuestion?.id;
    }
  }

  // ── REQ-04 — prompt audit ──
  // The CMF tools reach an on-prem MES over the VPN and are the slowest in the
  // product, yet this route recorded nothing at all. Open the row up front so it
  // is closed whether the stream succeeds or fails.
  const promptAuditUserText = (() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts = lastUserMessage?.parts as any[] | undefined;
    return (
      parts
        ?.filter((p: { type: string }) => p.type === 'text')
        .map((p: { text?: string }) => p.text || '')
        .join('') ||
      lastUserMessage?.content ||
      ''
    );
  })();
  let promptAuditHandle: PromptStartHandle | null = null;
  if (promptAuditUserText) {
    promptAuditHandle = await recordPromptStart({
      startedAtMs: requestStartedAtMs,
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      userPrompt: promptAuditUserText,
      app: 'faborch',
      model: MODEL,
    });
  }

  // Registry rates for this model, loaded once so the finish callback can price
  // the turn without an extra await. Falls back to the hardcoded pricing map.
  let registryRates: ModelRates | null = null;
  try {
    registryRates = await getRegistryRates(MODEL);
  } catch {
    // Registry unavailable — costForTurn's built-in table is used instead.
  }

  // Every tool here executes IN THIS PROCESS, so durationMs is the true
  // round-trip the model waited on — unlike /api/chat, nothing is provider-executed.
  const toolTimings = new Map<string, { durationMs: number; stepNumber: number; success: boolean }>();

  // All chat tools are exposed, including the in-chat validate + load flow
  // (validateForLoad → previewLoadImpact → loadToCmf). loadToCmf commits to CMF
  // only with an explicit confirmed:true (deterministic gate) after the user
  // agrees — see the LOAD PROTOCOL in the system prompt.
  perf.mark('promptAuditStart');

  const visibleTools = buildChatTools(user.id, { exportDbKey, loadDbKey, loadDbAmbiguous, dbLabels: grantedConnections });

  // Make the agent aware of the active CMF database(s) so it can name the target
  // and MUST confirm it before any load (a load writes to whichever DB is
  // toggled). With no database at all, the agent must say so rather than try.
  const dbAwareness = exportDbKey && loadDbKey
    ? `\n\n## Active CMF database\n` +
      `Reads/exports use: **${labelFor(exportDbKey)}**. ` +
      `Loads/writes go to: **${labelFor(loadDbKey)}**.\n` +
      `CRITICAL: before running loadToCmf, ALWAYS tell the user exactly which database you are about to load into — name it (e.g. "${labelFor(loadDbKey)}") — and get their explicit confirmation that it's the correct database. Never load without stating and confirming the target database first.`
    : `\n\n## Active CMF database\n` +
      `NONE. ${NO_DATABASE_MESSAGE} ` +
      `Every tool that reads or writes the manufacturing system (browse, lookup, fill from existing, field metadata, validate, load) will refuse with that message. ` +
      `If the user asks for anything that needs the manufacturing system, tell them plainly that no database connection is available yet and that an administrator must add one in Admin → Database Connections; do not retry the tools or guess data.`;

  const convertedMessages = await convertToModelMessages(uiMessages);
  perf.mark('buildToolsAndMessages');

  /** First error the model stream raised — the root cause behind the AI SDK's
   *  generic wrapper, which only reports that no output was produced. */
  let rootStreamError: unknown = null;

  const progress = createProgressNudge();
  const result = streamText({
    onError: (e: unknown) => {
      const err = (e as { error?: unknown })?.error ?? e;
      if (!rootStreamError) rootStreamError = err;
      logger.fabOrchError(err, { route: '/api/modeling-agent/chat', userId: user.id, model: MODEL });
    },
    model: anthropic(MODEL),
    system: SYSTEM_PROMPT + dbAwareness,
    messages: convertedMessages,
    tools: visibleTools,
    stopWhen: stepCountIs(MAX_STEPS),
    // A short progress note to the user every ~8 tool calls (shared/lib/progress-nudge.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prepareStep: ({ messages: stepMessages }: { messages: any[] }) => {
      const next = progress.messages(stepMessages);
      return next === stepMessages ? {} : { messages: next };
    },
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal: req.signal,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    experimental_onToolCallFinish: (event: any) => {
      const id = event?.toolCall?.toolCallId;
      if (!id) return;
      const name = event?.toolCall?.toolName ?? 'unknown';
      const durationMs = Math.round(event?.durationMs ?? 0);
      const stepNumber = event?.stepNumber ?? -1;
      const success = event?.success !== false;
      toolTimings.set(id, { durationMs, stepNumber, success });
      perf.recordTool(name, durationMs, success, stepNumber);
    },
    // Time-to-first-token; no-ops after the first chunk.
    onChunk: () => perf.markFirstToken(),
    // Each step is one model call plus its tool executions — this is where a
    // slow CMF round-trip over the VPN shows up against model time.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onStepFinish: (event: any) => {
      progress.stepFinished(event);
      const names = (event?.toolCalls ?? [])
        .map((tc: { toolName?: string }) => tc.toolName || 'unknown')
        .join('+');
      perf.mark(names ? `step:${names}` : 'step:text');
    },
  });
  result.consumeStream();

  // One id for the reply: the `start` chunk (what the browser shows), the
  // stream's responseMessage and the saved row. With different ids, rating a
  // fresh reply asked the server for a message it had never stored.
  const assistantMessageId = randomUUID();
  const stream = createUIMessageStream({
    generateId: () => assistantMessageId,
    execute: async ({ writer }) => {
      writer.merge(result.toUIMessageStream({ sendReasoning: true, generateMessageId: () => assistantMessageId }));

      /*
       * Surface tool failures as DATA, not as whatever the model says.
       * Shared with the Fab chat so all three agents report identically.
       */
      // AWAITED, not fire-and-forget: the UI stream stays open until
      // execute resolves. Detached, the cards were often written after the
      // stream had closed and silently dropped (the record was still saved).
      try {
        streamToolFailures(await result.steps, writer, {
          system: 'CMF',
          userId: user.id,
          route: '/api/modeling-agent/chat',
        });
      } catch { /* never let error reporting break the turn */ }
    },
    onFinish: async ({ responseMessage }) => {
      // ── REQ-04 — close the audit row with per-tool timings, tokens and cost ──
      // Runs before the persistence below, which returns early when the turn has
      // no conversation; the audit must not depend on that.
      perf.mark('streamTail');
      const timings = perf.snapshot({ userId: user.id, model: MODEL, outcome: 'ok' });
      logger.info('perf', timings);

      if (promptAuditHandle) {
        recordPromptTimings(promptAuditHandle.rowId, timings).catch(() => {});
        try {
          const steps = (await result.steps) ?? [];
          const toolCalls: ToolCallSummary[] = [];
          let requestTokens = 0, retrievalTokens = 0, responseTokens = 0;
          let requestCost = 0, retrievalCost = 0, responseCost = 0;

          for (let idx = 0; idx < steps.length; idx++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const step = steps[idx] as any;
            const resultsByCallId = new Map<string, unknown>();
            for (const tr of step.toolResults ?? []) {
              if (tr.toolCallId) resultsByCallId.set(tr.toolCallId, tr.output ?? tr.result);
            }
            for (const tc of step.toolCalls ?? []) {
              const timing = tc.toolCallId ? toolTimings.get(tc.toolCallId) : undefined;
              toolCalls.push({
                name: tc.toolName || 'unknown',
                args: tc.input ?? tc.args,
                result: tc.toolCallId ? resultsByCallId.get(tc.toolCallId) : undefined,
                toolCallId: tc.toolCallId,
                ...(timing ?? {}),
              });
            }
            if (step.usage) {
              const inTok = step.usage.inputTokens ?? 0;
              const outTok = step.usage.outputTokens ?? 0;
              const readTok = step.usage.cachedInputTokens ?? 0;
              const writeTok = step.usage.cacheCreationInputTokens ?? 0;
              const usage = {
                inputTokens: inTok,
                outputTokens: outTok,
                cachedInputTokens: readTok,
                cacheCreationInputTokens: writeTok,
              };
              const cost = registryRates
                ? costForTurnWithRates(registryRates, usage)
                : costForTurn(MODEL, usage);
              // Turn 1's input is the request; every later step's input is
              // retrieval (tool results fed back). Mirrors /api/chat.
              if (idx === 0) {
                requestTokens += inTok + readTok + writeTok;
                requestCost += cost.inputCost;
              } else {
                retrievalTokens += inTok + readTok + writeTok;
                retrievalCost += cost.inputCost;
              }
              responseTokens += outTok;
              responseCost += cost.outputCost;
            }
          }

          await recordPromptSuccess({
            rowId: promptAuditHandle.rowId,
            startedAtMs: promptAuditHandle.startedAtMs,
            app: promptAuditHandle.app,
            userPrompt: promptAuditUserText,
            llmResponse: (await result.text) || '',
            toolCalls,
            requestTokens,
            retrievalTokens,
            responseTokens,
            requestCost,
            retrievalCost,
            responseCost,
          });

          // Usage record — feeds the admin usage/cost dashboard, which until now
          // showed nothing for the Modeling Agent.
          let inputTokens = 0, outputTokens = 0, thinkingTokens = 0;
          let cacheReadTokens = 0, cacheCreationTokens = 0;
          for (const step of steps) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const u = (step as any).usage;
            if (!u) continue;
            inputTokens += u.inputTokens ?? 0;
            outputTokens += u.outputTokens ?? 0;
            thinkingTokens += u.reasoningTokens ?? 0;
            cacheReadTokens += u.cachedInputTokens ?? 0;
            cacheCreationTokens += u.cacheCreationInputTokens ?? 0;
          }
          await prisma.usageRecord.create({
            data: {
              userId: user.id,
              model: MODEL,
              inputTokens,
              outputTokens,
              thinkingTokens,
              cacheReadTokens,
              cacheCreationTokens,
              conversationId: conversationId || null,
              requestDurationMs: Math.round(perf.elapsed()),
            },
          });
        } catch (err) {
          console.error('[modeling-agent/chat] audit failed:', err);
        }
      }

      if (!conversationId) return;
      try {
        const streamParts = Array.isArray(responseMessage.parts) ? responseMessage.parts : [];
        const dbParts: Array<Record<string, unknown>> = streamParts
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((part: any) => {
            const t = part.type as string;
            if (t === 'text') return { type: 'text', text: part.text || '' };
            if (t === 'reasoning') return { type: 'reasoning', text: part.text || '' };
            if (t === 'step-start') return { type: 'step-start' };
            if (t?.startsWith('tool-') || t === 'dynamic-tool') {
              return {
                type: t === 'dynamic-tool' ? `tool-${part.toolName || 'unknown'}` : t,
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input ?? part.args ?? {},
                output: part.output ?? part.result ?? undefined,
                state: part.state || 'output-available',
                // Measured duration, so reloaded history keeps its timings.
                ...(part.toolCallId ? toolTimings.get(part.toolCallId) ?? {} : {}),
              };
            }
            if (t?.startsWith('data-')) return null;
            return { ...part };
          })
          .filter(Boolean) as Array<Record<string, unknown>>;

        const text = await result.text;
        if (dbParts.length === 0 && text) dbParts.push({ type: 'text', text });

        // Whether, and where in the history, the answer is stored: lib/save-answer.
        await saveTurnAnswer({ conversationId, seq: turnSeq, questionId, questionAt }, {
          id: assistantMessageId,
          content: text || '',
          parts: dbParts.length > 0 ? dbParts : [{ type: 'text', text: text || '' }],
          metadata: { model: MODEL, agent: 'modeling' },
        });
      } catch (err) {
        // The reply is on screen but was not saved — it vanishes when the
        // conversation is reopened. Record it rather than lose it.
        console.error('[modeling-agent/chat] persist failed:', err);
        recordSilentFailure(err, {
          stage: 'persistAssistantMessage',
          system: 'Conversation storage',
          userId: user.id,
          route: '/api/modeling-agent/chat',
        });
      }
    },
    onError: (error) => {
      console.error('[modeling-agent/chat] stream error:', error);
      perf.flush({ userId: user.id, model: MODEL, outcome: 'stream-error' });

      /*
       * Capture and RECORD the failure. This route had no error catalog and
       * wrote nothing to error_audit_logs, so every Modeling Agent failure was
       * invisible: no id, no record, nothing for an admin to look up. The
       * record below is what the "View error log" button resolves.
       */
      const fabErr = FabOrchError.lambdaMcpCrash(rootStreamError ?? error, {
        route: '/api/modeling-agent/chat',
        userId: user.id,
      });
      const detail = captureError({
        errorId: fabErr.errorId,
        cause: rootStreamError ?? error,
        type: fabErr.type,
        priority: 'HIGH',
      });
      logger.fabOrchError(fabErr, { route: '/api/modeling-agent/chat', userId: user.id });
      import('@/shared/lib/errors/error-audit').then((m) =>
        m.recordError(fabErr, {
          userId: user.id,
          route: '/api/modeling-agent/chat',
          method: 'POST',
          technicalMessage: detail.message ?? null,
          stackPreview: detail.stack ?? null,
          requestContext: { ...detail, agent: 'modeling-agent', model: MODEL } as unknown as Record<string, unknown>,
        })
      ).catch(() => {});
      if (promptAuditHandle) {
        recordPromptTimings(
          promptAuditHandle.rowId,
          perf.snapshot({ userId: user.id, model: MODEL, outcome: 'stream-error' })
        ).catch(() => {});
        recordPromptFailure({
          rowId: promptAuditHandle.rowId,
          startedAtMs: promptAuditHandle.startedAtMs,
          errorEnvelope: {
            errorId: fabErr.errorId,
            type: 'MODELING_AGENT_STREAM_ERROR',
            priority: 'HIGH',
            userMessage: detail.message ?? 'Something went wrong.',
          },
        }).catch(() => {});
      }
      // Real cause plus the id, so the user knows what failed and an admin can
      // open the full record.
      return `${summarizeError(detail)} (errorId=${fabErr.errorId})`;
    },
  });

  return createUIMessageStreamResponse({
    stream,
    headers: { 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-cache, no-transform' },
  });
}
