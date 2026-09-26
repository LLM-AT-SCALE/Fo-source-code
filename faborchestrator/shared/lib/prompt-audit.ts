/**
 * FabOrch Audit — REQ-04 Prompt & Response Audit Log helpers.
 *
 * Schema is the doc-spec 10-field set + user_email (split out from
 * UserName at the user's request) + a uuid PK. Topic taxonomy is the
 * 7 use cases from the Entegris End-User Use Cases plan, plus a
 * sentinel value `AdminData` for any prompt that originates in the
 * admin chat (regardless of content).
 *
 * Columns in prompt_audit_logs:
 *   id, prompt_id, datetime, user_name, user_email, user_prompt,
 *   topic_matched, query_executed, data_retrieved, llm_response,
 *   response_time_ms, status
 *
 * Uses raw SQL via Prisma — same approach as REQ-02/03.
 */

import { randomUUID } from 'node:crypto';
import { prisma } from './db';

type PromptAuditStatus =
  | 'PENDING'
  | 'SUCCESS'
  | 'FAILED'
  | 'TIMEOUT'
  | 'CANCELLED';

const MAX_TEXT_LEN = 100_000; // cap any single text field at ~100KB

function truncate(text: string | null | undefined): string {
  if (!text) return '';
  if (text.length <= MAX_TEXT_LEN) return text;
  return text.slice(0, MAX_TEXT_LEN) + '\n[…truncated]';
}

// ─── Topic taxonomy: 7 use cases + AdminData sentinel ──────────────
const TOPIC = {
  UC1: 'Material Genealogy + Hold/Disposition',
  UC2: 'Equipment OEE Report',
  UC3: 'Scrap Pareto Analysis',
  UC4: 'Bottleneck Analysis',
  UC5: 'Cycle Time Outlier Detection',
  UC6: 'Operator Performance Analysis',
  UC7: 'Overall Facility Performance Insights',
  ADMIN: 'AdminData',
  /* The Coding Agent. Never INFERRED — the classifier's patterns are
     manufacturing ones, and a requirement document for a materials screen
     matches them by accident. Its route passes this as `topicOverride`. */
  CODING: 'Coding Agent',
} as const;

/** The topic the Coding Agent's route stamps on its rows. */
export const CODING_AGENT_TOPIC: string = TOPIC.CODING;

// Tool-name patterns — matched against the concatenation of tool names + args
// of the MCP tool calls executed during the prompt. First match wins, so
// the more-specific patterns come first.
const TOOL_TOPIC_PATTERNS: ReadonlyArray<{ test: RegExp; topic: string }> = [
  // UC-1 — Material Genealogy + Hold/Disposition
  { test: /genealogy|traceab|trace_|disposition|ascendant|descendant|parent.?child|where.?used|lineage|family.?tree|search.?material|find.?material|material.?search|lot.?id|batch.?id|material_id|hold_material|release_hold|place.?on.?hold|scrap_material/i, topic: TOPIC.UC1 },

  // UC-3 — Scrap Pareto Analysis (handle before generic "defect" patterns)
  { test: /pareto|defect_pareto|defect.?code|non.?conform|ncr|ncm|rework|scrap|reject|yield.?loss|fail.?mode|defective|qc_fail|reject_rate|scrap_rate/i, topic: TOPIC.UC3 },

  // UC-4 — Bottleneck Analysis
  { test: /bottleneck|wip|queue|backlog|constraint|choke.?point|capacity.?constraint|line.?balance|congest|pile.?up|backed.?up|slow.?step/i, topic: TOPIC.UC4 },

  // UC-5 — Cycle Time Outlier Detection (before UC-2 because cycle_time is shared)
  { test: /outlier|sigma|std.?dev|standard.?deviation|variance|p95|percentile|anomal|deviation_from|takt|spread/i, topic: TOPIC.UC5 },

  // UC-2 — Equipment OEE Report (broad: OEE, uptime, equipment state, ideal vs actual)
  { test: /oee|availability|downtime|uptime|utilization|run.?time|idle.?time|mtbf|mttr|equipment_state|machine_state|fault_code|alarm|tool_status|equipment|machine|ideal.?cycle|overall.?equipment/i, topic: TOPIC.UC2 },

  // UC-5 — Cycle Time (generic; comes after UC-2 so OEE wins on overlap)
  { test: /cycle.?time|processing.?time|process.?time|move.?history|operation.?time/i, topic: TOPIC.UC5 },

  // UC-6 — Operator Performance Analysis
  { test: /operator|technician|worker|shift_performance|by.?operator|per.?operator|peer|individual.?perf/i, topic: TOPIC.UC6 },

  // UC-7 — Overall Facility Performance Insights (broad executive / multi-KPI tools)
  { test: /facility|fab.?wide|plant.?wide|executive|dashboard|kpi|overall_perf|otd|otif|on.?time.?delivery|daily.?summary|shift.?summary|multi.?metric/i, topic: TOPIC.UC7 },
];

// Prompt-text patterns — matched against the user's natural-language prompt.
// Order matters (first match wins); list more-specific patterns first.
const PROMPT_TOPIC_PATTERNS: ReadonlyArray<{ test: RegExp; topic: string }> = [
  // UC-1 — anything about lots/materials/holds/disposition/lineage
  { test: /\b(genealogy|traceab|trace\b|disposition|ascendant|descendant|parent.?child|lineage|family.?tree|where.?used|wherever.?used)/i, topic: TOPIC.UC1 },
  { test: /\b(find|search|look.?up|locate)\b.{0,30}\b(material|materials|lot|lots|batch|batches|serial|product|part)\b/i, topic: TOPIC.UC1 },
  { test: /\b(hold|on.?hold|release.?hold|place.?on.?hold|put.?on.?hold|disposition.?(it|that|this|lot|material))\b/i, topic: TOPIC.UC1 },
  { test: /\b(lot|batch|material|product).{0,20}\b(id|number|name|history|trace)\b/i, topic: TOPIC.UC1 },

  // UC-3 — Scrap / Pareto / Defects / NCR / Quality losses
  { test: /\b(pareto|defect.?code|non.?conform|ncr|ncm|fishbone|root.?cause)/i, topic: TOPIC.UC3 },
  { test: /\b(scrap|reject|rework|yield.?loss|defective|qc.?fail|rejection.?rate|scrap.?rate|defects?|failure.?mode)\b/i, topic: TOPIC.UC3 },
  { test: /\b(top|most|biggest|largest|ranked|highest)\b.{0,30}\b(defect|reject|scrap)/i, topic: TOPIC.UC3 },

  // UC-4 — Bottleneck / WIP / Queue / Throughput constraint
  { test: /\b(bottleneck|wip\b|queue.?depth|queue.?length|backlog|constraint|choke.?point|capacity.?constraint|line.?balanc)/i, topic: TOPIC.UC4 },
  { test: /\b(slow|slowest|congest|pile.?up|backed.?up|stuck|bottleneck)\b.{0,30}\b(step|operation|process|station|line|work.?center)\b/i, topic: TOPIC.UC4 },
  { test: /\b(work.?in.?process|in.?process|waiting.?time|wait.?time)\b/i, topic: TOPIC.UC4 },

  // UC-5 — Cycle time outliers, statistical analysis (before generic OEE so cycle_time outliers win)
  { test: /\b(outlier|sigma|std.?dev|standard.?deviation|variance|p95|p99|percentile|anomaly|anomalous|abnormal|deviation.?from.?mean|takt|spread.?of|distribution.?of)/i, topic: TOPIC.UC5 },
  { test: /\b(cycle.?time|processing.?time|process.?time|operation.?time|move.?history)\b/i, topic: TOPIC.UC5 },

  // UC-2 — OEE / Equipment / Availability / Uptime
  { test: /\b(oee|overall.?equipment.?effectiveness|availability|downtime|uptime|utilization|mtbf|mttr|fault.?code|alarm.?history|equipment.?state|machine.?state|ideal.?cycle|run.?time|idle.?time)\b/i, topic: TOPIC.UC2 },
  { test: /\b(equipment|machine|tool|line).{0,15}\b(status|state|down|broken|faulty|fault|alarm|alarming|performance|efficiency)\b/i, topic: TOPIC.UC2 },

  // UC-6 — Operator Performance
  { test: /\b(operator|technician|worker|crew).{0,15}\b(performance|productivity|throughput|comparison|metrics|score|ranking|by|per)\b/i, topic: TOPIC.UC6 },
  { test: /\b(per.?operator|by.?operator|operator.?id|individual.?perf|peer.?comparison|shift.?level)/i, topic: TOPIC.UC6 },
  { test: /\b(who.?(ran|operated|moved|produced))/i, topic: TOPIC.UC6 },

  // UC-7 — Facility-wide / Executive / Multi-KPI
  { test: /\b(facility|fab.?wide|plant.?wide|executive|kpi|on.?time.?delivery|otd\b|otif\b|multi.?kpi|multi.?metric)/i, topic: TOPIC.UC7 },
  { test: /\b(overall|top.?level|plant|fab|facility|fab|line).{0,15}\b(dashboard|summary|overview|performance|insights|health|snapshot|status)\b/i, topic: TOPIC.UC7 },
  { test: /\b(daily|shift|weekly|monthly|end.?of.?(day|shift)).{0,15}\b(summary|report|review)\b/i, topic: TOPIC.UC7 },
];

export interface ToolCallSummary {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result?: any;
  toolCallId?: string;
  rowsReturned?: number;
  /** Wall-clock execution time, from the SDK's onToolCallFinish. */
  durationMs?: number;
  /** Zero-based step this call belonged to. Calls sharing a step ran CONCURRENTLY. */
  stepNumber?: number;
  /** False when the tool threw; the step still waited for it. */
  success?: boolean;
}

/**
 * Build the JSONB payload written to prompt_audit_logs.tool_calls.
 * Per the MCP team's spec, each entry stores three fields:
 *   - name:   the tool that was executed
 *   - input:  the parameters the LLM passed to the tool
 *   - output: the full tool response (which, for our MCP tools, already
 *             includes the underlying SQL/SP via `_executed_sql`)
 *
 * Timing/identity fields are ADDITIVE — the three fields above keep their exact
 * names and meaning, so any existing consumer of this JSONB is unaffected.
 * They are omitted entirely when unknown (e.g. Anthropic's provider-executed
 * tools run in Anthropic's sandbox, never call our executor, and therefore have
 * no local duration), so `durationMs` is absent rather than a misleading 0.
 *
 * NOTE ON AGGREGATION: calls that share a `stepNumber` ran CONCURRENTLY and the
 * step waited only for the SLOWEST. Summing `durationMs` across a turn
 * OVERSTATES the time the user waited. Use, per step, max(durationMs).
 */
function buildToolCallsPayload(toolCalls: ToolCallSummary[]): unknown[] {
  return toolCalls.map((t) => ({
    name: t.name,
    input: t.args ?? null,
    output: t.result ?? null,
    ...(t.durationMs !== undefined ? { durationMs: t.durationMs } : {}),
    ...(t.stepNumber !== undefined ? { stepNumber: t.stepNumber } : {}),
    ...(t.success !== undefined ? { success: t.success } : {}),
    ...(t.toolCallId ? { toolCallId: t.toolCallId } : {}),
    ...(t.rowsReturned !== undefined ? { rowsReturned: t.rowsReturned } : {}),
  }));
}

/**
 * Map a prompt + tool-call set + originating app to one of the 7 use cases
 * (or `AdminData` for admin-app prompts, or `null` if no match).
 */
function classifyTopic(
  userPrompt: string,
  toolCalls: ToolCallSummary[],
  app: 'faborch' | 'faborch-admin' = 'faborch'
): string | null {
  if (app === 'faborch-admin') return TOPIC.ADMIN;

  if (toolCalls && toolCalls.length > 0) {
    const hay = toolCalls
      .map((t) => `${t.name} ${t.args ? JSON.stringify(t.args) : ''}`)
      .join(' ');
    for (const p of TOOL_TOPIC_PATTERNS) {
      if (p.test.test(hay)) return p.topic;
    }
  }

  for (const p of PROMPT_TOPIC_PATTERNS) {
    if (p.test.test(userPrompt)) return p.topic;
  }

  return null;
}

// ─── Daily counter for human-readable PROMPT IDs ───────────────────
async function nextPromptId(): Promise<string> {
  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO prompt_audit_daily_counter (counter_date, last_seq)
     VALUES (CURRENT_DATE, 1)
     ON CONFLICT (counter_date)
       DO UPDATE SET last_seq = prompt_audit_daily_counter.last_seq + 1
     RETURNING counter_date, last_seq`
  )) as Array<{ counter_date: Date; last_seq: number }>;
  const d = rows[0].counter_date;
  const yyyymmdd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const seq = String(rows[0].last_seq).padStart(4, '0');
  return `PRO-${yyyymmdd}-${seq}`;
}

// ─── Public API ────────────────────────────────────────────────────

export interface PromptStartParams {
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  userPrompt: string;
  app?: 'faborch' | 'faborch-admin';
  model?: string;
  /**
   * True request start (handler entry), in ms.
   *
   * Without it the clock starts HERE — after auth, validation and ~5 sequential
   * registry/role/limit queries have already run — so response_time_ms
   * understated the wait by exactly the preflight we most want to see. Callers
   * pass the timestamp they took on entry.
   */
  startedAtMs?: number;
}

export interface PromptStartHandle {
  rowId: string;
  promptId: string;
  startedAtMs: number;
  app: 'faborch' | 'faborch-admin';
}

export async function recordPromptStart(
  params: PromptStartParams
): Promise<PromptStartHandle | null> {
  try {
    const promptId = await nextPromptId();
    const id = randomUUID();
    const startedAtMs = params.startedAtMs ?? Date.now();
    const app = params.app ?? 'faborch';
    await prisma.$executeRawUnsafe(
      `INSERT INTO "prompt_audit_logs"
         (id, prompt_id, datetime, user_id, user_name, user_email, user_prompt, status, model)
       VALUES ($1, $2, NOW(), $3, $4, $5, $6, 'PENDING'::"prompt_audit_status", $7)`,
      id,
      promptId,
      params.userId,
      params.userName,
      params.userEmail,
      truncate(params.userPrompt),
      params.model ?? null
    );
    return { rowId: id, promptId, startedAtMs, app };
  } catch {
    return null;
  }
}

interface PromptUsageBuckets {
  /** Input tokens of turn 1 (model reading the user's question). */
  requestTokens?: number | null;
  /** Sum of input tokens of turns 2..N (cost of feeding tool results back). */
  retrievalTokens?: number | null;
  /** Sum of output tokens across all turns. */
  responseTokens?: number | null;
  /** USD cost of the request bucket (turn 1 input, with cache-aware rates). */
  requestCost?: number | null;
  /** USD cost of the retrieval bucket (turns 2..N input, with cache-aware rates). */
  retrievalCost?: number | null;
  /** USD cost of the response bucket (all turns' output). */
  responseCost?: number | null;
}

export interface PromptSuccessParams extends PromptUsageBuckets {
  rowId: string;
  startedAtMs: number;
  app: 'faborch' | 'faborch-admin';
  llmResponse: string;
  toolCalls?: ToolCallSummary[];
  rowsRetrieved?: number;
  topicOverride?: string | null;
  userPrompt: string;
}

function buildQueryExecuted(toolCalls: ToolCallSummary[]): string {
  if (!toolCalls.length) return '';
  const lines = [`${toolCalls.length} tool${toolCalls.length === 1 ? '' : 's'} executed:`];
  for (const t of toolCalls) {
    const argsStr = t.args ? ` ${JSON.stringify(t.args)}` : '';
    lines.push(`  • ${t.name}${argsStr}`);
  }
  return lines.join('\n');
}

function buildDataRetrieved(toolCalls: ToolCallSummary[], rowsRetrieved?: number): string {
  if (rowsRetrieved !== undefined && rowsRetrieved !== null) {
    return `${toolCalls.length} tool${toolCalls.length === 1 ? '' : 's'}, ${rowsRetrieved} rows returned`;
  }
  if (toolCalls.length === 0) return '';
  return `${toolCalls.length} tool${toolCalls.length === 1 ? '' : 's'} returned data`;
}

export async function recordPromptSuccess(p: PromptSuccessParams): Promise<void> {
  try {
    const tools = p.toolCalls ?? [];
    const topic = p.topicOverride ?? classifyTopic(p.userPrompt, tools, p.app);
    const queryExecuted = buildQueryExecuted(tools);
    const dataRetrieved = buildDataRetrieved(tools, p.rowsRetrieved);
    const responseTimeMs = Date.now() - p.startedAtMs;

    const toolCallsPayload = tools.length > 0
      ? JSON.stringify(buildToolCallsPayload(tools))
      : null;

    await prisma.$executeRawUnsafe(
      `UPDATE "prompt_audit_logs"
          SET status            = 'SUCCESS'::"prompt_audit_status",
              llm_response      = $2,
              topic_matched     = $3,
              query_executed    = NULLIF($4, ''),
              data_retrieved    = NULLIF($5, ''),
              response_time_ms  = $6,
              tool_calls        = $7::jsonb,
              request_tokens    = $8,
              retrieval_tokens  = $9,
              response_tokens   = $10,
              request_cost      = $11,
              retrieval_cost    = $12,
              response_cost     = $13
        WHERE id = $1`,
      p.rowId,
      truncate(p.llmResponse),
      topic,
      queryExecuted,
      dataRetrieved,
      responseTimeMs,
      toolCallsPayload,
      p.requestTokens   ?? null,
      p.retrievalTokens ?? null,
      p.responseTokens  ?? null,
      p.requestCost     ?? null,
      p.retrievalCost   ?? null,
      p.responseCost    ?? null
    );
  } catch {
    // Best-effort; never break the request.
  }
}

/**
 * Store the full phase/tool timing record on an audit row.
 *
 * Deliberately its own statement, wrapped in its own try/catch: the `timings`
 * column is added by an additive migration, and until that has been run against
 * a given database this must fail alone rather than roll back the audit write
 * it is attached to.
 */
export async function recordPromptTimings(
  rowId: string,
  timings: Record<string, unknown>
): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "prompt_audit_logs" SET timings = $2::jsonb WHERE id = $1`,
      rowId,
      JSON.stringify(timings)
    );
  } catch {
    // Column not present yet (migration not run) — timings still reach the logs.
  }
}

export interface PromptFailureParams extends PromptUsageBuckets {
  rowId: string;
  startedAtMs: number;
  errorEnvelope: {
    errorId: string;
    type: string;
    priority: string;
    userMessage: string;
  };
  status?: Exclude<PromptAuditStatus, 'PENDING' | 'SUCCESS'>;
  partialResponse?: string;
}

export async function recordPromptFailure(p: PromptFailureParams): Promise<void> {
  try {
    const status =
      p.status ??
      (p.errorEnvelope.type === 'RESPONSE_TIMEOUT' ? 'TIMEOUT' : 'FAILED');
    const responseTimeMs = Date.now() - p.startedAtMs;

    // The error_envelope column is gone; we still use the envelope's `type`
    // to pick TIMEOUT vs FAILED. Partial response (if any) is preserved.
    // Token/cost columns are also written: even failed prompts may have
    // consumed tokens before the error.
    await prisma.$executeRawUnsafe(
      `UPDATE "prompt_audit_logs"
          SET status            = $2::"prompt_audit_status",
              llm_response      = COALESCE($3, llm_response),
              response_time_ms  = $4,
              request_tokens    = $5,
              retrieval_tokens  = $6,
              response_tokens   = $7,
              request_cost      = $8,
              retrieval_cost    = $9,
              response_cost     = $10
        WHERE id = $1`,
      p.rowId,
      status,
      p.partialResponse ? truncate(p.partialResponse) : null,
      responseTimeMs,
      p.requestTokens   ?? null,
      p.retrievalTokens ?? null,
      p.responseTokens  ?? null,
      p.requestCost     ?? null,
      p.retrievalCost   ?? null,
      p.responseCost    ?? null
    );
  } catch {
    // ignore
  }
}

// ────────────────────────────────────────────────────────────────
// Admin-side queries
// ────────────────────────────────────────────────────────────────

export interface PromptAuditFilters {
  userKey?: string | null;
  userEmail?: string | null;
  status?: PromptAuditStatus | 'all' | null;
  publicStatus?: 'Success' | 'Failed' | null;
  topicMatched?: string | null;
  promptIdLike?: string | null;
  /** Filter by originating app — translates to topic_matched inclusion/exclusion. */
  app?: 'faborch' | 'faborch-admin' | null;
  dateFrom?: Date | null;
  dateTo?: Date | null;
  limit?: number;
}

export interface PromptAuditRow {
  id: string;
  promptId: string;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  datetime: Date;
  userPrompt: string;
  topicMatched: string | null;
  queryExecuted: string | null;
  dataRetrieved: string | null;
  llmResponse: string | null;
  responseTimeMs: number | null;
  status: PromptAuditStatus;
  toolCalls: unknown | null;
  requestTokens: number | null;
  retrievalTokens: number | null;
  responseTokens: number | null;
  requestCost: string | null;     // NUMERIC comes back as string from pg to preserve precision
  retrievalCost: string | null;
  responseCost: string | null;
}

export async function queryPromptAudit(
  filters: PromptAuditFilters
): Promise<{ rows: PromptAuditRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(1, filters.limit ?? 100), 1000);
  const conds: string[] = [];
  const values: unknown[] = [];
  const push = (sql: string, v: unknown) => {
    values.push(v);
    conds.push(sql.replace('$?', `$${values.length}`));
  };

  if (filters.userEmail) push(`l.user_email = $?`, filters.userEmail);
  if (filters.userKey) {
    const key = `%${filters.userKey}%`;
    values.push(key, key, key);
    const a = `$${values.length - 2}`;
    const b = `$${values.length - 1}`;
    const c = `$${values.length}`;
    conds.push(
      `(l.user_name ILIKE ${a} OR l.user_email ILIKE ${b} OR split_part(l.user_email, '@', 1) ILIKE ${c})`
    );
  }

  if (filters.publicStatus === 'Success') conds.push(`l.status = 'SUCCESS'::"prompt_audit_status"`);
  else if (filters.publicStatus === 'Failed') conds.push(`l.status IN ('FAILED','TIMEOUT','CANCELLED')`);
  else if (filters.status && filters.status !== 'all') push(`l.status = $?::"prompt_audit_status"`, filters.status);

  if (filters.topicMatched) push(`l.topic_matched = $?`, filters.topicMatched);
  if (filters.promptIdLike) push(`l.prompt_id ILIKE $?`, `%${filters.promptIdLike}%`);

  // The `app` column is gone from the table — admin prompts are flagged
  // by `topic_matched = 'AdminData'`. Translate the legacy `app` filter
  // to a topic filter so admin-chat questions still work as expected.
  if (filters.app === 'faborch-admin') {
    conds.push(`l.topic_matched = 'AdminData'`);
  } else if (filters.app === 'faborch') {
    conds.push(`(l.topic_matched IS NULL OR l.topic_matched <> 'AdminData')`);
  }

  if (filters.dateFrom) push(`l.datetime >= $?`, filters.dateFrom);
  if (filters.dateTo) push(`l.datetime <= $?`, filters.dateTo);

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const sql = `
    SELECT l.id, l.prompt_id, l.user_id, l.user_name, l.user_email,
           l.datetime, l.user_prompt, l.topic_matched,
           l.query_executed, l.data_retrieved,
           l.llm_response, l.response_time_ms, l.status,
           l.tool_calls,
           l.request_tokens, l.retrieval_tokens, l.response_tokens,
           l.request_cost,   l.retrieval_cost,   l.response_cost
      FROM "prompt_audit_logs" l
      ${where}
     ORDER BY l.datetime DESC
     LIMIT ${limit + 1}
  `;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (await prisma.$queryRawUnsafe(sql, ...values)) as any[];
  const truncated = raw.length > limit;
  const rows = raw.slice(0, limit).map((r) => ({
    id: r.id,
    promptId: r.prompt_id,
    userId: r.user_id,
    userName: r.user_name,
    userEmail: r.user_email,
    datetime: r.datetime,
    userPrompt: r.user_prompt,
    topicMatched: r.topic_matched,
    queryExecuted: r.query_executed,
    dataRetrieved: r.data_retrieved,
    llmResponse: r.llm_response,
    responseTimeMs: r.response_time_ms,
    status: r.status as PromptAuditStatus,
    toolCalls: r.tool_calls,
    requestTokens:   r.request_tokens,
    retrievalTokens: r.retrieval_tokens,
    responseTokens:  r.response_tokens,
    requestCost:     r.request_cost,
    retrievalCost:   r.retrieval_cost,
    responseCost:    r.response_cost,
  }));
  return { rows, truncated };
}

export async function purgeOldPrompts(): Promise<number> {
  const result = await prisma.$executeRawUnsafe(
    `DELETE FROM "prompt_audit_logs"
      WHERE datetime < NOW() - INTERVAL '90 days'`
  );
  return Number(result);
}
