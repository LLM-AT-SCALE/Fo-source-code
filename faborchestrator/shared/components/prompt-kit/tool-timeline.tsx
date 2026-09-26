"use client"

import * as React from "react"
import type { ToolPart } from "@/shared/components/prompt-kit/tool"
import type { Artifact } from "@/shared/lib/artifacts"
import LoadingState from "@/shared/components/prompt-kit/loading-state"
import { isMcpToolKey, stripMcpToolKey } from "@/modules/mcp/lib/mcp-tool-key"

/**
 * The working indicator shown while the assistant is busy.
 *
 * This is now a single component — the pixel-grid LoadingState — driven
 * directly off real tool state. It replaces a three-stage text machine
 * ("Received your prompt" → "Retrieval in progress..." → "Generating
 * Response...") that had two problems:
 *
 *   1. Its stage transitions were ONE-WAY and evaluated `toolsActive` a single
 *      time, 900ms in. Whenever the model thought for longer than that before
 *      its first tool call — the common case — it latched to the final stage
 *      and could never go back, so the retrieval state was simply never shown.
 *   2. The final label persisted after streaming finished, leaving a stale
 *      "Generating Response..." line under every completed message.
 *
 * Reading `toolsActive` on every render fixes both: the loader tracks what is
 * actually happening, in either direction, for as long as it is happening.
 *
 * When the work finishes the loader is NOT unmounted — it freezes, holding its
 * final elapsed time, so the turn keeps showing how long the tools took. That
 * only works because the element stays mounted across the transition; the timer
 * lives inside it. A message re-rendered from history never streamed in this
 * session has no live clock — but the durations were persisted with it, so the
 * recorded time is replayed instead of showing a misleading 0.0s.
 *
 * Frozen is a RESTING state, never a terminal one. A turn is a loop — text,
 * tool, text, tool — so the indicator wakes for every tool the model uses and
 * settles again between them. Nothing here may latch, or later tool calls in
 * the same response go unshown.
 */

type Phrase = { active: string; done: string }

/**
 * Business-language phrases for every tool the user can see running.
 *
 * Users here run manufacturing operations and are not technical, and the
 * Modeling Agent's own system prompt forbids exposing internal tool names to
 * them. "Ran Mcp Run Semi Opc Query" breaks that; "Queried manufacturing data"
 * says what they were actually waiting for.
 *
 * Stored as active/done PAIRS rather than a noun prefixed with "Running"/"Ran":
 * no single noun reads well after both verbs ("Running the load into CMF"), and
 * the tense carries real meaning — whether a production write is still
 * happening or has finished.
 *
 * Naming CMF is fine — it is the system these users work in daily, and the agent
 * must name the target database before any load. What is banned is HOW the
 * system connects: hosts, tables, SQL, error codes.
 */
const EXACT_PHRASES: Record<string, Phrase> = {
  // ── Modeling Agent (CMF master-data tools) ──
  resolveObjectType:      { active: "Identifying the record type",          done: "Identified the record type" },
  getRequiredFields:      { active: "Checking which fields are required",   done: "Checked which fields are required" },
  getObjectComposition:   { active: "Working out the sheet layout",         done: "Worked out the sheet layout" },
  lookupExisting:         { active: "Looking up existing records",          done: "Looked up existing records" },
  suggestFieldValues:     { active: "Finding suggested values",             done: "Found suggested values" },
  browseCmfRecords:       { active: "Searching existing records",           done: "Searched existing records" },
  fillFromExisting:       { active: "Pre-filling from existing records",    done: "Pre-filled from existing records" },
  prefillFormFromInput:   { active: "Checking the values you gave",         done: "Checked the values you gave" },
  renderEntryForm:        { active: "Preparing the entry form",             done: "Prepared the entry form" },
  generateTemplate:       { active: "Building the template",                done: "Built the template" },
  generateExcel:          { active: "Building your spreadsheet",            done: "Built your spreadsheet" },
  exportWithDependencies: { active: "Gathering everything this depends on", done: "Gathered everything this depends on" },
  removeFromLoader:       { active: "Removing it from the file",            done: "Removed it from the file" },
  validateTemplate:       { active: "Checking the file",                    done: "Checked the file" },
  previewLoadImpact:      { active: "Previewing what will change",          done: "Previewed what will change" },
  validateForLoad:        { active: "Running the validation checks",        done: "Ran the validation checks" },
  loadToCmf:              { active: "Loading into CMF",                     done: "Loaded into CMF" },

  // ── Back-end Agent (PO UI generation) ──
  write_prd:         { active: "Writing the PRD",              done: "Wrote the PRD" },
  generate_artifact: { active: "Generating the CMF export",    done: "Generated the CMF export" },
  revise_artifact:   { active: "Revising the page",            done: "Revised the page" },
  show_preview:      { active: "Rendering the screen",         done: "Rendered the screen" },

  // ── Fab AI chat (fixed tools) ──
  code_execution:             { active: "Running the analysis",         done: "Ran the analysis" },
  bash_code_execution:        { active: "Running the analysis",         done: "Ran the analysis" },
  text_editor_code_execution: { active: "Preparing the document",       done: "Prepared the document" },
  web_search:                 { active: "Searching the web",            done: "Searched the web" },
  web_fetch:                  { active: "Reading the page",             done: "Read the page" },
  query_manufacturing_data:   { active: "Pulling manufacturing data",   done: "Pulled manufacturing data" },
  artifacts:                  { active: "Preparing the document",       done: "Prepared the document" },

  // ── Admin Console assistant (modules/admin/lib/ai/admin-tools.ts) ──
  // Without these the snake_case admin tools fall through the MCP patterns
  // to the generic "Working on your request", which tells an admin nothing.
  list_users:                  { active: "Looking up users",                 done: "Looked up users" },
  invite_user:                 { active: "Sending the invitation",           done: "Sent the invitation" },
  suspend_user:                { active: "Suspending the user",              done: "Suspended the user" },
  activate_user:               { active: "Reactivating the user",            done: "Reactivated the user" },
  delete_user:                 { active: "Deleting the user",                done: "Deleted the user" },
  change_user_role:            { active: "Changing the user's role",         done: "Changed the user's role" },
  bulk_assign_role:            { active: "Assigning the role",               done: "Assigned the role" },
  force_password_reset:        { active: "Sending the password reset",       done: "Sent the password reset" },
  list_roles:                  { active: "Looking up roles",                 done: "Looked up roles" },
  create_role:                 { active: "Creating the role",                done: "Created the role" },
  update_role:                 { active: "Updating the role",                done: "Updated the role" },
  delete_role:                 { active: "Deleting the role",                done: "Deleted the role" },
  list_invitations:            { active: "Looking up invitations",           done: "Looked up invitations" },
  revoke_invitation:           { active: "Revoking the invitation",          done: "Revoked the invitation" },
  resend_invitation:           { active: "Resending the invitation",         done: "Resent the invitation" },
  add_mcp_to_role:             { active: "Assigning the data source",        done: "Assigned the data source" },
  list_role_mcps:              { active: "Looking up data source access",    done: "Looked up data source access" },
  remove_role_mcp:             { active: "Removing the data source",         done: "Removed the data source" },
  check_usage:                 { active: "Gathering usage statistics",       done: "Gathered usage statistics" },
  list_audit_logs:             { active: "Reading the audit log",            done: "Read the audit log" },
  query_user_sessions:         { active: "Looking up sessions",              done: "Looked up sessions" },
  query_user_mcp_tools:        { active: "Checking the user's data access",  done: "Checked the user's data access" },
  query_error_audit:           { active: "Searching the error log",          done: "Searched the error log" },
  mark_error_resolved:         { active: "Marking the error resolved",       done: "Marked the error resolved" },
  purge_old_errors:            { active: "Clearing old error records",       done: "Cleared old error records" },
  query_prompt_audit:          { active: "Searching the prompt history",     done: "Searched the prompt history" },
  prompt_quality_summary:      { active: "Summarising prompt quality",       done: "Summarised prompt quality" },
  purge_old_prompts:           { active: "Clearing old prompt records",      done: "Cleared old prompt records" },
  list_error_catalog:          { active: "Reading the error catalog",        done: "Read the error catalog" },
  update_error_catalog_message:{ active: "Updating the error message",       done: "Updated the error message" },
  get_report_schedules:        { active: "Looking up report schedules",      done: "Looked up report schedules" },
  list_mcp_datasources:        { active: "Looking up data sources",          done: "Looked up data sources" },
  list_mcp_datasource_requirements: { active: "Checking what the connection needs", done: "Checked what the connection needs" },
  set_mcp_datasource_schema:   { active: "Saving the data source layout",    done: "Saved the data source layout" },
  assign_mcp_datasource:       { active: "Assigning the data source",        done: "Assigned the data source" },
  unassign_mcp_datasource:     { active: "Removing the data source",         done: "Removed the data source" },
  connect_mcp_datasource:      { active: "Connecting to the data source",    done: "Connected to the data source" },
  generate_mcp_datasource_manifest: { active: "Preparing the look-up tools", done: "Prepared the look-up tools" },
  deploy_mcp_datasource:       { active: "Deploying the data source",        done: "Deployed the data source" },
}

/**
 * Fallback phrasing driven by the MCP naming convention.
 *
 * An exhaustive list is impossible: the On-the-Fly MCP feature GENERATES tools
 * per data source, so new names appear whenever an admin connects a database
 * (~190 distinct names in the audit log already). Matching the convention means
 * a tool nobody has seen yet still reads as business language instead of
 * leaking `mcp_run_semi_opc_query` at a user.
 *
 * Order matters — most specific first.
 */
const PATTERN_PHRASES: Array<[RegExp, Phrase]> = [
  [/describe_(table|view)|list_(tables|schemas)|search_columns|get_relationships|discover_schema/,
    { active: "Checking the data structure",   done: "Checked the data structure" }],
  [/get_sample_data/,
    { active: "Sampling the data",             done: "Sampled the data" }],
  [/(validate|register|stage|load)_(package|file|objects|status)|get_load_status/,
    { active: "Preparing the data load",       done: "Prepared the data load" }],
  [/query|run_.*_query|stored_procedure/,
    { active: "Querying manufacturing data",   done: "Queried manufacturing data" }],
  [/topic_/,
    { active: "Looking up reference data",     done: "Looked up reference data" }],
  [/(^|_)search_/,
    { active: "Searching records",             done: "Searched records" }],
  [/(^|_)list_/,
    { active: "Listing records",               done: "Listed records" }],
  [/(^|_)get_/,
    { active: "Looking up details",            done: "Looked up details" }],
  [/(^|_)run_/,
    { active: "Running the request",           done: "Ran the request" }],
  [/(^|_)(update|set)_/,
    { active: "Updating the record",           done: "Updated the record" }],
  // Catch-all for any remaining MCP tool — including ones generated on the fly
  // for a data source connected long after this shipped. They are all reads
  // against a connected manufacturing system, so this is accurate as well as
  // safe; it is the difference between a vague "Working on your request" and
  // saying what is happening.
  [/^mcp_/,
    { active: "Looking up manufacturing data", done: "Looked up manufacturing data" }],
]

const GENERIC: Phrase = { active: "Working on your request", done: "Completed the step" }

/** Business phrase for a tool. Never returns a raw tool name. Exported so the
 *  mapping can be checked against the real tool names in the audit log. */
export function phraseFor(name: string): Phrase {
  const exact = EXACT_PHRASES[name]
  if (exact) return exact
  // Keys are namespaced per connection (`mcp_<conn8>__run_query`); match the
  // patterns on `mcp_run_query` so the 8 hex chars can never shape the phrase.
  const key = (isMcpToolKey(name) ? `mcp_${stripMcpToolKey(name)}` : name).toLowerCase()
  for (const [re, phrase] of PATTERN_PHRASES) {
    if (re.test(key)) return phrase
  }
  return GENERIC
}

/**
 * The measured cost of a group of tool calls — what the turn actually waited.
 *
 * NOT a plain sum. Calls sharing a step run CONCURRENTLY and the step only
 * waits for the slowest, so three parallel calls of 2s / 13.7s / 3s cost 13.7s,
 * not 18.7s. The figure is the sum, over steps, of each step's slowest call,
 * which keeps it consistent with the live wall-clock timer: a group reads the
 * same whether it is running or replayed from history.
 *
 * Returns undefined when nothing was timed — provider-executed tools run in
 * Anthropic's sandbox and carry no local duration.
 */
function measuredMs(tools: ToolPart[]): number | undefined {
  const timed = tools.filter((t) => typeof t.durationMs === "number")
  if (timed.length === 0) return undefined
  const slowestPerStep = new Map<number, number>()
  for (const t of timed) {
    const step = t.stepNumber ?? -1
    slowestPerStep.set(step, Math.max(slowestPerStep.get(step) ?? 0, t.durationMs as number))
  }
  return [...slowestPerStep.values()].reduce((a, b) => a + b, 0)
}

export interface ToolTimelineProps {
  tools: ToolPart[]
  isStreaming: boolean
  /**
   * Kept for API compat. Deliberately UNUSED: gating on it froze the indicator
   * at the first tool, hiding every later tool call in the same response.
   */
  nextTextStarted?: boolean
  /**
   * The stage the caller is currently on, shown instead of the tool phrase.
   *
   * A tool phrase names what was CALLED; generation is one tool call that runs
   * for minutes while the pipeline moves through extracting, resolving paths,
   * building each query and validating. Without this the box reads "Generating
   * the CMF export" for three unbroken minutes and cannot be told from a hang.
   *
   * Optional, and only while streaming — a finished turn reports what it did,
   * not what it was doing.
   */
  liveLabel?: string | null
  /** Kept for API compat; artifacts now render once via the end-of-message
   *  ArtifactTile, not as a chip under every tool group. */
  artifacts?: Artifact[]
  onOpenArtifact?: (artifact: Artifact) => void
  defaultOpen?: boolean
}

export function ToolTimeline({
  tools,
  isStreaming,
  liveLabel,
}: ToolTimelineProps) {
  // Did this message stream in front of us? Only then is there a live clock.
  const timedRef = React.useRef(false)
  if (isStreaming) timedRef.current = true

  // A message that used no tools and is not streaming has nothing to report.
  if (!timedRef.current && tools.length === 0) return null

  // Replayed history has no live clock. Use the durations persisted with the
  // message; `null` when there are none — conversations saved before timings
  // were recorded, or groups made only of provider-executed tools. The row
  // still renders in that case, just without a time: the record that tools ran
  // here is the point, and hiding it left reloaded conversations looking as
  // though the model had answered out of thin air.
  const replayMs = timedRef.current ? undefined : measuredMs(tools) ?? null

  // Evaluated every render — not latched — so the loader follows the real
  // tool lifecycle in both directions across a multi-step turn.
  const running = tools.filter(
    (t) => t.state === "input-streaming" || t.state === "input-available"
  )

  // Active whenever tools are in flight, OR while we are still waiting for the
  // model's first move. Deliberately NOT latched on `nextTextStarted`: a turn
  // is a LOOP, so the model routinely writes text, calls another tool, writes
  // again. Latching froze the indicator at the first tool and every later tool
  // in the same response went unshown. Recomputing lets it light up again for
  // every tool the model uses.
  const active = isStreaming && (running.length > 0 || tools.length === 0)
  const stopped = !active

  // Name what is actually running; past tense once frozen so a finished line
  // doesn't read as still working.
  //
  // "in parallel" is claimed ONLY for tools running concurrently right now.
  // A frozen turn's `tools` holds every tool across every step, which is
  // usually sequential — calling that parallel would be plainly wrong, and
  // doubly so when the point of this label is to expose real concurrency.
  const named = running.length > 0 ? running : tools

  // Every tool resolves to a business phrase, so no raw tool name can reach the
  // screen on either agent — not even one generated on the fly by a data source
  // connected after this shipped.
  //
  // When several tools share a phrase (three `mcp_*_query` calls all reading
  // "Querying manufacturing data") the single phrase is used rather than a
  // count, because "Working on 3 steps" is vaguer than naming the one thing
  // actually happening.
  let label: string | undefined
  if (named.length >= 1) {
    const phrases = named.map((t) => phraseFor(t.type))
    const unique = [...new Set(phrases.map((p) => (stopped ? p.done : p.active)))]
    label =
      unique.length === 1
        ? unique[0]
        : stopped
          ? `Completed ${named.length} steps`
          : `Working on ${named.length} steps at once`
  } // else: nothing to name — LoadingState uses its own default

  /* The caller's live stage wins while the turn is still running: it is more
     specific than the tool phrase and it CHANGES, which is what tells a reader
     the run is alive. Once stopped the phrase returns, because a stage name
     frozen mid-run would read as the place it failed. */
  if (isStreaming && liveLabel) label = liveLabel

  return (
    <div className="my-2">
      <LoadingState label={label} stopped={stopped} elapsedMs={replayMs} />
    </div>
  )
}
