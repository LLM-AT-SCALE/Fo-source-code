/**
 * MCP health checks — proves that every registry server not only answers but
 * can read its database.
 *
 * Three stages, in order (see ./mcp-health-types for the contract):
 *   1 reachable  `initialize` answered                 → fails: `down`
 *   2 tools      `tools/list` returned ≥ 1 tool        → fails: `degraded`
 *   3 data       one read-only tool call returned data → fails: `degraded`
 *                (no read-only call could be chosen    → `unknown`: not tested)
 *
 * Stages 1–2 are tried up to 3 times and the data call twice before a failure
 * counts, so a cold start, a 5xx or a throttle does not report an outage.
 *
 * Stages 1–2 reuse the connect probe (`probeMcpServer`, no row written); stage
 * 3 calls one tool over the same transport (`callMcpToolRaw`). The chat's
 * `executeMcpTool` is deliberately NOT used here: it requires the connection
 * row to be `connected`, reads the row's stale session id, and writes an
 * error-log row on every failure — which would defeat the transition-only
 * recording below.
 *
 * The result is stored on `mcp_registry` (latest) and `mcp_health_checks`
 * (history, last 200 per server). Failures reach the error log only on a
 * status transition, or once an hour while a server stays failed; admins are
 * emailed on a transition into down/degraded and on recovery.
 */

import type { McpConnection, McpRegistry, Prisma } from '@/lib/generated/prisma/client';

import prisma from '@/shared/lib/db';
import { AGENT_KEYS, AGENT_LABELS } from '@/shared/lib/agents';
import { recordCaptured } from '@/shared/lib/errors/capture';
import { FabOrchErrorType } from '@/shared/lib/errors/error-catalog-defaults';
import { looksLikeErrorPayload } from '@/shared/lib/errors/mcp-error-payload';
import { ADMIN_ROLE_NAME } from '@/shared/lib/permissions';
import { disabledManagedIdsFrom } from '@/modules/mcp/lib/mcp-access';
import { probeMcpServer, callMcpToolRaw, McpCredentialsError, type McpProbe } from '@/modules/mcp/lib/mcp-connect';
import { suggestProbeCandidates, type ProbeCandidate } from '@/modules/mcp/lib/mcp-health-probe-llm';
import {
  MCP_HEALTH_LABELS,
  MCP_HEALTH_STATUSES,
  healthLayers,
  worstStatus,
  type McpHealthAgentView,
  type McpHealthDetail,
  type McpHealthProbe,
  type McpHealthServerView,
  type McpHealthStatus,
  type McpHealthSummary,
} from '@/modules/mcp/lib/mcp-health-types';

/**
 * Stage 1–2 budget per call. A scale-to-zero container or a cold Lambda pays
 * its start-up on the first request; the chat's 10 s default is too tight to
 * call a server down on.
 */
const REACH_TIMEOUT_MS = 15_000;
/** A server is only called down after this many attempts all fail (one blip is not an outage). */
const REACH_ATTEMPTS = 3;
/** Pause before each retry: [before attempt 2, before attempt 3]. */
const REACH_RETRY_DELAYS_MS = [2_000, 5_000];
/**
 * Stage-3 tool call budget — the chat's tool budget. A cold SQL pool (e.g. a
 * named SQL Server instance behind the VPN) needs ~20 s for its first connect.
 */
const DATA_TIMEOUT_MS = 30_000;
/** The data probe gets one retry: the first call often only warms the pool. */
const DATA_ATTEMPTS = 2;
const DATA_RETRY_DELAY_MS = 3_000;
/** History kept per server. */
const HISTORY_KEEP = 200;
/** How many servers are checked at once by the scheduled run. */
const CONCURRENCY = 5;
/** Minimum gap between two scheduled runs in this process (env override). */
const INTERVAL_MS = Math.max(15_000, Number(process.env.MCP_HEALTH_INTERVAL_MS ?? 5 * 60_000) || 5 * 60_000);
/** While a server stays failed, its failure is re-recorded at most this often. */
const RERECORD_MS = 60 * 60_000;

/** Tools that read catalogue-style data from the database, by name. */
const PROBE_NAME_RE = /(^|_)(list_tables|list_schemas|get_object_types|list_parameter_values|list_[a-z_]+)$/i;
/**
 * Tools that answer from the server's own code, never from the database — a
 * success from one of them says nothing about the database, so they are never
 * the data probe.
 */
const NON_DATA_RE = /(instruction|help|ping|echo|version|about|server_info|capabilit|list_tools|list_prompts|list_resources)/i;
const BUILT_IN_PROBE = 'health_check';

type ProbeSource = NonNullable<McpHealthDetail['probeSource']>;
type DiscoveredTool = McpProbe['tools'][number];

export type CheckOptions = { source: 'scheduled' | 'manual' };

// ── helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name || 'Unknown error';
  return typeof e === 'string' ? e : JSON.stringify(e);
}

function asStatus(v: unknown): McpHealthStatus {
  return (MCP_HEALTH_STATUSES as readonly string[]).includes(String(v)) ? (v as McpHealthStatus) : 'unknown';
}

/** The admin-set probe on the registry row, when it is well-formed. */
export function parseHealthProbe(v: unknown): McpHealthProbe | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.tool !== 'string' || !o.tool.trim()) return null;
  const args = o.arguments;
  const okArgs = args === undefined || (args !== null && typeof args === 'object' && !Array.isArray(args));
  return {
    tool: o.tool.trim(),
    ...(okArgs && args ? { arguments: args as Record<string, unknown> } : {}),
    ...(o.source === 'llm' || o.source === 'admin' ? { source: o.source } : {}),
    ...(typeof o.reason === 'string' && o.reason ? { reason: o.reason } : {}),
  };
}

function hasNoRequiredArgs(t: DiscoveredTool): boolean {
  const req = (t.inputSchema as { required?: unknown } | undefined)?.required;
  return !Array.isArray(req) || req.length === 0;
}

/**
 * Which tool the data stage calls. The saved probe wins while the server still
 * lists that tool; then the built-in `health_check` of the on-the-fly
 * runtimes; then a catalogue-style tool by name; then any other tool. Only
 * tools that need no arguments qualify (the automatic pick calls with `{}`, so
 * a tool with required arguments would fail on the call, not on the database),
 * and tools that answer without touching the database never do. Null when no
 * such tool exists — the model picks then.
 */
export function chooseProbe(
  tools: DiscoveredTool[],
  configured: McpHealthProbe | null,
): { tool: string; arguments: Record<string, unknown>; probeSource: ProbeSource } | null {
  // A saved probe whose tool was renamed or removed would fail forever; pick again.
  if (configured && tools.some((t) => t.name === configured.tool)) {
    return { tool: configured.tool, arguments: configured.arguments ?? {}, probeSource: configured.source === 'llm' ? 'llm' : 'configured' };
  }
  if (tools.some((t) => t.name === BUILT_IN_PROBE)) return { tool: BUILT_IN_PROBE, arguments: {}, probeSource: 'built-in' };
  const callable = tools.filter((t) => hasNoRequiredArgs(t) && !NON_DATA_RE.test(t.name));
  const pick = callable.find((t) => PROBE_NAME_RE.test(t.name)) ?? callable[0];
  return pick ? { tool: pick.name, arguments: {}, probeSource: 'automatic' } : null;
}

/**
 * Prefer the admin-managed (role-level) row, then a row that is currently
 * connected, then any active row. When the server is assigned to nobody the
 * check still runs, with the connector's own credentials from the registry —
 * a server's health does not depend on whether someone has been given it.
 */
async function pickConnection(registry: McpRegistry): Promise<McpConnection> {
  const rows = await prisma.mcpConnection.findMany({ where: { registryId: registry.id, isActive: true } });
  const row = rows.find((c) => c.userId === null) ?? rows.find((c) => c.status === 'connected') ?? rows[0];
  if (row) return row;
  return {
    id: `registry:${registry.id}`,
    userId: null,
    roleId: null,
    registryId: registry.id,
    name: registry.displayName,
    serverUrl: registry.serverUrl,
    authType: registry.authType,
    authCredentialsEncrypted: registry.authCredentialsEncrypted,
    availableTools: [],
    isActive: true,
    status: 'disconnected',
    lastError: null,
    lastConnectedAt: null,
    agent: 'fabinsight',
    createdAt: registry.createdAt,
    updatedAt: registry.updatedAt,
  } as unknown as McpConnection;
}

// ── the check ───────────────────────────────────────────────────────────────

/**
 * Run the three stages against one registry server, persist the outcome and
 * return the detail. Never throws for a server-side failure — that is the
 * result; only a database failure on our side propagates.
 */
export async function checkRegistryHealth(registryId: string, opts: CheckOptions): Promise<McpHealthDetail> {
  const registry = await prisma.mcpRegistry.findUnique({ where: { id: registryId } });
  if (!registry) throw new Error(`MCP server ${registryId} not found`);

  const detail = await runStages(registry, opts.source);
  // Our side could not run the check (unreadable key, no AWS access): that
  // says nothing about the server, so it must not overwrite a real verdict.
  if (notRunOnOurSide.has(detail) && registry.healthCheckedAt && registry.healthDetail) {
    console.warn('[mcp-health] check not run for', registry.displayName, '—', detail.error);
    // Keep the verdict; record why it was not renewed so the screens can say so.
    const kept: McpHealthDetail = {
      ...(registry.healthDetail as unknown as McpHealthDetail),
      lastAttempt: { at: detail.checkedAt, error: detail.error ?? 'The check could not run' },
    };
    await prisma.mcpRegistry.update({ where: { id: registry.id }, data: { healthDetail: kept as unknown as Prisma.InputJsonValue } });
    return kept;
  }
  await persist(registry, detail);
  await afterCheck(registry, detail);
  return detail;
}

/** Results where the check never reached the server because of a problem on our side. */
const notRunOnOurSide = new WeakSet<McpHealthDetail>();

async function runStages(registry: McpRegistry, source: CheckOptions['source']): Promise<McpHealthDetail> {
  const checkedAt = new Date().toISOString();
  const base = { checkedAt, source } as const;

  const connection = await pickConnection(registry);

  // Stage 1 + 2 — reachable, tools. Retried: one timeout, 5xx or throttle is
  // not an outage, and "down" pages every admin.
  const reached = await reachWithRetry(connection);
  if (!reached.probe) {
    // Unreadable stored credentials: the server was never contacted, so it is not "down".
    if (reached.credentials) {
      const notRun: McpHealthDetail = { ...base, status: 'unknown', stage: 0, error: reached.error };
      notRunOnOurSide.add(notRun);
      return notRun;
    }
    return { ...base, status: 'down', stage: 0, error: reached.error };
  }
  const probe = reached.probe;
  const timings = { reachMs: probe.reachMs, ...(probe.toolsMs !== undefined ? { toolsMs: probe.toolsMs } : {}) };
  if (!probe.tools.length) {
    return {
      ...base, ...timings, status: 'degraded', stage: 1, toolCount: 0,
      error: probe.toolsError ?? 'The server answered but listed no tools',
    };
  }
  const withTools = { ...base, ...timings, toolCount: probe.tools.length };

  // Stage 3 — data.
  const chosen = chooseProbe(probe.tools, parseHealthProbe(registry.healthProbe));
  if (chosen) {
    const outcome = await callProbeWithRetry(connection, probe, chosen.tool, chosen.arguments);
    return outcome.ok
      ? { ...withTools, status: 'healthy', stage: 3, dataMs: outcome.dataMs, toolUsed: chosen.tool, probeSource: chosen.probeSource }
      : { ...withTools, status: 'degraded', stage: 2, dataMs: outcome.dataMs, toolUsed: chosen.tool, probeSource: chosen.probeSource, error: outcome.error };
  }

  // No safe tool by heuristics: let the model choose, verify its choice, keep it.
  const picked = await pickProbeWithModel(registry, connection, probe);
  if (picked.winner) {
    return { ...withTools, status: 'healthy', stage: 3, dataMs: picked.winner.dataMs, toolUsed: picked.winner.tool, probeSource: 'llm' };
  }
  if (picked.tried.length) {
    // A read ran against the database and failed: that is the database talking.
    return { ...withTools, status: 'degraded', stage: 2, toolUsed: picked.tried[picked.tried.length - 1].tool, probeSource: 'llm', error: picked.error };
  }
  // Nothing was called, so the database was not tested — do not report it as down.
  return { ...withTools, status: 'unknown', stage: 2, error: `Server reachable (${probe.tools.length} tools), database not tested: ${picked.error}` };
}

/** AWS refused OUR call before the function ran: missing / expired credentials or no invoke permission. */
const AWS_SIDE_RE = /ExpiredToken|UnrecognizedClientException|InvalidClientTokenId|InvalidSignatureException|security token included in the request|Could not load credentials|CredentialsProviderError|AccessDeniedException[^]*lambda:InvokeFunction/i;

/** Failures that repeat identically on every attempt: the function is gone, or the server refuses our key / URL. */
const DEFINITIVE_RE = /Function not found|ResourceNotFoundException|HTTP 40[134]\b/i;

/** The raw error plus what an admin has to do about it. */
function explainDefinitive(error: string): string {
  if (/Function not found|ResourceNotFoundException/i.test(error)) {
    return `${error} — the Lambda this connector points at no longer exists; redeploy the server or update its URL in the MCP registry`;
  }
  if (/HTTP 40[13]\b/.test(error)) {
    return `${error} — the server refused the saved API key (it may have been redeployed with a new token); re-enter the key in the MCP registry`;
  }
  return `${error} — the server has nothing at this URL; check the connector's URL`;
}

/** Stages 1–2 with retries. `probe` is the first attempt that listed tools, else the last one that answered at all. */
async function reachWithRetry(
  connection: McpConnection,
): Promise<{ probe: McpProbe; error?: undefined; credentials?: undefined } | { probe: null; error: string; credentials?: boolean }> {
  let answered: McpProbe | null = null;
  let lastError = '';
  for (let attempt = 1; attempt <= REACH_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(REACH_RETRY_DELAYS_MS[attempt - 2] ?? REACH_RETRY_DELAYS_MS[REACH_RETRY_DELAYS_MS.length - 1]);
    try {
      const probe = await probeMcpServer(connection, { timeoutMs: REACH_TIMEOUT_MS });
      if (probe.tools.length) return { probe };
      answered = probe;
    } catch (e) {
      // Deterministic and on our side — retrying cannot help.
      if (e instanceof McpCredentialsError) return { probe: null, credentials: true, error: `Not checked: ${e.message}` };
      lastError = errorText(e);
      // This app instance cannot call AWS (expired / missing keys, no invoke permission): our side, not the server's.
      if (AWS_SIDE_RE.test(lastError)) {
        return { probe: null, credentials: true, error: `Not checked: this app cannot call AWS Lambda right now (${lastError.slice(0, 160)})` };
      }
      // A missing function or a refused key is an answer, not a blip — retrying only delays it.
      if (DEFINITIVE_RE.test(lastError)) return { probe: null, error: explainDefinitive(lastError) };
    }
  }
  if (answered) return { probe: answered };
  return { probe: null, error: REACH_ATTEMPTS > 1 ? `${lastError} (failed ${REACH_ATTEMPTS} attempts)` : lastError };
}

/** The chosen data probe, retried once (the first call after idle often only warms the database pool). */
async function callProbeWithRetry(connection: McpConnection, probe: McpProbe, tool: string, args: Record<string, unknown>): Promise<ProbeOutcome> {
  let outcome = await callProbe(connection, probe, tool, args);
  for (let attempt = 2; !outcome.ok && attempt <= DATA_ATTEMPTS; attempt++) {
    await sleep(DATA_RETRY_DELAY_MS);
    outcome = await callProbe(connection, probe, tool, args);
  }
  return outcome;
}

type ProbeOutcome = { ok: true; dataMs: number } | { ok: false; dataMs: number; error: string };

/** One data call, judged: not thrown, not isError, not an error payload. */
async function callProbe(connection: McpConnection, probe: McpProbe, tool: string, args: Record<string, unknown>): Promise<ProbeOutcome> {
  const t0 = Date.now();
  try {
    const result = await callMcpToolRaw(connection, { name: tool, arguments: args, sessionId: probe.sessionId, timeoutMs: DATA_TIMEOUT_MS });
    const dataMs = Date.now() - t0;
    const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n').trim();
    if (result.isError) return { ok: false, dataMs, error: text || 'The tool reported an error' };
    if (looksLikeErrorPayload(text)) return { ok: false, dataMs, error: text.slice(0, 500) };
    return { ok: true, dataMs };
  } catch (e) {
    return { ok: false, dataMs: Date.now() - t0, error: errorText(e) };
  }
}

export type ProbeAttempt = { tool: string; arguments: Record<string, unknown>; reason: string; ok: boolean; dataMs: number; error?: string };
type ModelPick = { winner: (ProbeAttempt & { ok: true }) | null; tried: ProbeAttempt[]; error: string };

// One model call per server per hour at most from the scheduled path, so a
// server the model cannot solve does not cost a call every five minutes. The
// candidates it proposed are kept and re-run on the throttled checks: the
// model is rationed, the database test is not.
const modelTried = new Map<string, { at: number; candidates: ProbeCandidate[] }>();
const MODEL_RETRY_MS = 60 * 60 * 1000;

/**
 * Ask the model for candidates, run each, save the first that returns data as
 * the server's probe (source 'llm'). `force` skips the hourly throttle (the
 * admin pressed the button).
 */
async function pickProbeWithModel(registry: McpRegistry, connection: McpConnection, probe: McpProbe, force = false): Promise<ModelPick> {
  const tried: ProbeAttempt[] = [];
  const run = async (candidates: ProbeCandidate[]): Promise<ModelPick | null> => {
    for (const c of candidates) {
      const outcome = await callProbe(connection, probe, c.tool, c.arguments);
      const attempt: ProbeAttempt = { ...c, ok: outcome.ok, dataMs: outcome.dataMs, ...(outcome.ok ? {} : { error: outcome.error }) };
      tried.push(attempt);
      if (outcome.ok) {
        const saved = { tool: c.tool, arguments: c.arguments, source: 'llm', reason: c.reason };
        await prisma.mcpRegistry.update({ where: { id: registry.id }, data: { healthProbe: saved as Prisma.InputJsonValue } });
        return { winner: attempt as ProbeAttempt & { ok: true }, tried, error: '' };
      }
    }
    return null;
  };
  const failed = (fallback: string): ModelPick => {
    const lastError = tried.length ? `${tried[tried.length - 1].tool}: ${tried[tried.length - 1].error}` : fallback;
    return { winner: null, tried, error: tried.length ? `No read-only call returned data (${lastError})` : lastError };
  };

  const previous = modelTried.get(registry.id);
  if (!force && previous && Date.now() - previous.at < MODEL_RETRY_MS) {
    const known = previous.candidates.filter((c) => probe.tools.some((t) => t.name === c.tool));
    return (await run(known)) ?? failed('No safe read-only tool found yet — the model will try again within the hour, or press "Let AI choose" on the card');
  }

  const proposed: ProbeCandidate[] = [];
  let candidates: ProbeCandidate[] = await suggestProbeCandidates(registry, probe.tools);
  for (let round = 0; round < 2 && candidates.length; round++) {
    proposed.push(...candidates);
    const won = await run(candidates);
    if (won) {
      modelTried.set(registry.id, { at: Date.now(), candidates: [] });
      return won;
    }
    // Second round: tell the model what failed.
    candidates = round === 0 ? await suggestProbeCandidates(registry, probe.tools, tried.map((t) => t.tool)) : [];
  }
  modelTried.set(registry.id, { at: Date.now(), candidates: proposed });
  return failed('the model proposed no safe read-only tool');
}

/**
 * The admin's "Let AI choose" button: re-run the model pick (no throttle),
 * then a full check with whatever was saved. Returns the attempts so the
 * screen can show what was tried and why.
 */
export async function chooseProbeWithModel(registryId: string): Promise<{ probe: McpHealthProbe | null; tried: ProbeAttempt[]; health: McpHealthDetail; error?: string }> {
  const registry = await prisma.mcpRegistry.findUnique({ where: { id: registryId } });
  if (!registry) throw new Error(`MCP server ${registryId} not found`);
  const connection = await pickConnection(registry);
  const reached = await reachWithRetry(connection);
  if (!reached.probe) {
    const health = await checkRegistryHealth(registryId, { source: 'manual' });
    return { probe: parseHealthProbe(registry.healthProbe), tried: [], health, error: `The server is not reachable: ${reached.error}` };
  }
  const probe = reached.probe;
  if (!probe.tools.length) {
    const health = await checkRegistryHealth(registryId, { source: 'manual' });
    return { probe: parseHealthProbe(registry.healthProbe), tried: [], health, error: 'The server lists no tools to choose from' };
  }
  const picked = await pickProbeWithModel(registry, connection, probe, true);
  const health = await checkRegistryHealth(registryId, { source: 'manual' });
  const fresh = await prisma.mcpRegistry.findUnique({ where: { id: registryId }, select: { healthProbe: true } });
  return { probe: parseHealthProbe(fresh?.healthProbe), tried: picked.tried, health, ...(picked.winner ? {} : { error: picked.error }) };
}

async function persist(registry: McpRegistry, detail: McpHealthDetail): Promise<void> {
  const checkedAt = new Date(detail.checkedAt);
  await prisma.$transaction(async (tx) => {
    await tx.mcpRegistry.update({
      where: { id: registry.id },
      data: { healthStatus: detail.status, healthCheckedAt: checkedAt, healthDetail: detail as unknown as Prisma.InputJsonValue },
    });
    await tx.mcpHealthCheck.create({
      data: {
        registryId: registry.id,
        checkedAt,
        status: detail.status,
        stage: detail.stage,
        reachMs: detail.reachMs ?? null,
        toolsMs: detail.toolsMs ?? null,
        dataMs: detail.dataMs ?? null,
        toolUsed: detail.toolUsed ?? null,
        error: detail.error ?? null,
        source: detail.source,
      },
    });
    // Keep the last HISTORY_KEEP rows per server.
    const stale = await tx.mcpHealthCheck.findMany({
      where: { registryId: registry.id }, orderBy: { checkedAt: 'desc' }, skip: HISTORY_KEEP, select: { id: true },
    });
    if (stale.length) await tx.mcpHealthCheck.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
  });
}

// ── error log + admin email, on transitions only ─────────────────────────────

const lastRecordedAt = new Map<string, number>();

async function afterCheck(registry: McpRegistry, detail: McpHealthDetail): Promise<void> {
  const previous = asStatus(registry.healthStatus);
  const status = detail.status;
  const failed = status === 'down' || status === 'degraded';
  const transition = previous !== status;

  if (failed) {
    const last = lastRecordedAt.get(registry.id) ?? 0;
    if (transition || Date.now() - last >= RERECORD_MS) {
      lastRecordedAt.set(registry.id, Date.now());
      try {
        recordCaptured(
          {
            system: registry.displayName,
            operation: 'mcp-health',
            target: registry.serverUrl,
            type: status === 'down' ? FabOrchErrorType.LAMBDA_MCP_CRASH : FabOrchErrorType.SQL_CALL_FAILURE,
            extra: { stage: detail.stage, previousStatus: previous, toolUsed: detail.toolUsed, source: detail.source },
          },
          new Error(detail.error ?? `MCP server is ${status}`),
        );
      } catch (e) {
        console.error('[mcp-health] could not record the failure for', registry.displayName, e);
      }
    }
  } else {
    lastRecordedAt.delete(registry.id);
  }

  const wasFailed = previous === 'down' || previous === 'degraded';
  if (transition && (failed || (status === 'healthy' && wasFailed))) {
    await notifyAdmins(registry, previous, detail);
  }
}

async function notifyAdmins(registry: McpRegistry, previous: McpHealthStatus, detail: McpHealthDetail): Promise<void> {
  try {
    const admins = await prisma.user.findMany({
      where: { status: 'ACTIVE', OR: [{ isAdmin: true }, { role: { name: ADMIN_ROLE_NAME } }, { role: { permissions: { array_contains: ['admin'] } } }] },
      select: { email: true },
    });
    const to = [...new Set(admins.map((a) => (a.email || '').trim().toLowerCase()).filter(Boolean))];
    if (!to.length) return;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
    const base = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
    const label = MCP_HEALTH_LABELS[detail.status];
    const recovered = detail.status === 'healthy';
    const html = `
      <p><b>MCP server ${esc(registry.displayName)} is ${esc(label.toLowerCase())}</b></p>
      <p>Status changed from ${esc(MCP_HEALTH_LABELS[previous])} to ${esc(label)} at ${esc(detail.checkedAt)}.</p>
      ${recovered ? '<p>The server answers and its data is readable again.</p>' : `<p>${esc(detail.error ?? 'No detail was recorded.')}</p>`}
      ${detail.toolUsed ? `<p>Probe: ${esc(detail.toolUsed)}</p>` : ''}
      <p><a href="${base}/admin/mcp">Open the MCP servers in the Admin Console</a></p>`;
    const { sendSmtpEmail } = await import('@/modules/admin/lib/email/smtp');
    const sent = await sendSmtpEmail({ to: to.join(', '), subject: `MCP server ${label.toLowerCase()} — ${registry.displayName}`, html });
    if (!sent) console.log('[mcp-health] SMTP not configured; admin notification skipped for', registry.displayName);
  } catch (e) {
    console.warn('[mcp-health] admin notification failed:', e instanceof Error ? e.message : e);
  }
}

// ── the scheduled run ───────────────────────────────────────────────────────

let lastRunAt = 0;

export type HealthRunSummary = { checked: number; healthy: number; degraded: number; down: number; unknown: number };

/**
 * Check every active registry server (5 at a time). Skipped entirely when the
 * last run in this process is more recent than MCP_HEALTH_INTERVAL_MS, so the
 * one-minute scheduler tick becomes a five-minute health cadence.
 */
export async function runMcpHealthChecks(): Promise<HealthRunSummary> {
  const summary: HealthRunSummary = { checked: 0, healthy: 0, degraded: 0, down: 0, unknown: 0 };
  const now = Date.now();
  if (now - lastRunAt < INTERVAL_MS) return summary;
  lastRunAt = now;

  const registries = await prisma.mcpRegistry.findMany({ where: { isActive: true }, select: { id: true, displayName: true } });
  const queue = [...registries];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        const detail = await checkRegistryHealth(next.id, { source: 'scheduled' });
        summary.checked += 1;
        summary[detail.status] += 1;
      } catch (e) {
        // A failure on OUR side (a database write) — the server's own failures are results, not throws.
        console.error('[mcp-health] check failed for', next.displayName, e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  if (summary.checked) console.log('[mcp-health]', JSON.stringify(summary));
  return summary;
}

/**
 * Run ONLY the health checks on a timer, for a process that must not run the
 * rest of the scheduler (MCP_HEALTH_SCHEDULER_ENABLED without
 * REPORT_SCHEDULER_ENABLED — e.g. a developer machine on a shared database).
 * Ticks every minute; runMcpHealthChecks throttles itself to the interval.
 */
export function startMcpHealthScheduler(): void {
  const g = globalThis as unknown as { __fabMcpHealthSchedulerStarted?: boolean };
  if (g.__fabMcpHealthSchedulerStarted) return;
  g.__fabMcpHealthSchedulerStarted = true;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runMcpHealthChecks();
    } catch (e) {
      console.error('[mcp-health] scheduled run failed', e);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void tick(), 10_000);
  setInterval(() => void tick(), 60_000);
  console.log(`[mcp-health] health-check timer started (every ${Math.round(INTERVAL_MS / 1000)} s)`);
}

// ── the cockpit's "Check now" ───────────────────────────────────────────────

/** A server checked this recently is not checked again by "Check now" (double clicks, several users at once). */
const USER_RECHECK_MIN_MS = 60_000;

/**
 * Re-check, now, every registry server this user has (the ones their cockpit
 * lists), then return their fresh summary. Only servers the user already has
 * can be triggered; personal servers outside the registry are not probed.
 */
export async function checkServersForUser(userId: string, agent?: string): Promise<McpHealthSummary> {
  const before = await getMcpHealthSummary(userId);
  // One agent's chat checks only that agent's servers.
  const scope = agent ? before.agents.filter((a) => a.agent === agent) : before.agents;
  const ids = [...new Set(scope.flatMap((a) => a.servers.map((s) => s.registryId)))].filter((id) => !id.startsWith('conn:'));
  const fresh = await prisma.mcpRegistry.findMany({
    where: { id: { in: ids }, healthCheckedAt: { gt: new Date(Date.now() - USER_RECHECK_MIN_MS) } },
    select: { id: true },
  });
  const skip = new Set(fresh.map((r) => r.id));
  const queue = ids.filter((id) => !skip.has(id));
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        await checkRegistryHealth(id, { source: 'manual' });
      } catch (e) {
        console.error('[mcp-health] check now failed for', id, e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return getMcpHealthSummary(userId);
}

// ── the cockpit summary ─────────────────────────────────────────────────────

/**
 * Per-agent view for ONE user: the servers that user has on each agent (their
 * role's assignments, minus the ones they switched off, plus all their own
 * connections), each with the registry row's latest status. Without a
 * user id the view is platform-wide (every active connection). An agent with
 * no servers is healthy — there is nothing to be unhealthy.
 */
export async function getMcpHealthSummary(userId?: string): Promise<McpHealthSummary> {
  let where: Prisma.McpConnectionWhereInput = { isActive: true };
  let disabled = new Set<string>();
  if (userId) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { roleId: true, preferences: true } });
    // Every server the user HAS: all their own connections — switched on or
    // not (a failed connect switches a personal row off, and those are exactly
    // the ones they need to see) — plus their role's active assignments.
    where = {
      OR: [{ userId }, ...(user?.roleId ? [{ roleId: user.roleId, userId: null, isActive: true }] : [])],
    };
    disabled = disabledManagedIdsFrom(user?.preferences);
  }
  const conns = (await prisma.mcpConnection.findMany({
    where,
    select: { id: true, name: true, registryId: true, serverUrl: true, agent: true, status: true, lastError: true },
  })).filter((c) => !disabled.has(c.id));

  // A user's own connection may point at a registry server without carrying its
  // id (added by URL) — match it by URL so it shows the server's real health.
  const urls = [...new Set(conns.map((c) => c.serverUrl))];
  const registries = urls.length
    ? await prisma.mcpRegistry.findMany({
        where: { OR: [{ id: { in: conns.map((c) => c.registryId).filter((x): x is string => !!x) } }, { serverUrl: { in: urls } }], isActive: true },
        select: { id: true, displayName: true, serverUrl: true, healthStatus: true, healthCheckedAt: true, healthDetail: true },
      })
    : [];
  const byId = new Map(registries.map((r) => [r.id, r]));
  const byUrl = new Map(registries.map((r) => [r.serverUrl, r]));

  const view = (c: (typeof conns)[number]): McpHealthServerView => {
    const r = (c.registryId && byId.get(c.registryId)) || byUrl.get(c.serverUrl);
    if (r) {
      const detail = r.healthDetail as Partial<McpHealthDetail> | null;
      const status = asStatus(r.healthStatus);
      const stage = detail?.stage;
      return {
        registryId: r.id,
        name: r.displayName,
        status,
        checkedAt: r.healthCheckedAt ? r.healthCheckedAt.toISOString() : null,
        ...healthLayers(r.healthCheckedAt && (stage === 0 || stage === 1 || stage === 2 || stage === 3) ? { status, stage } : null),
        ...(typeof detail?.toolUsed === 'string' && detail.toolUsed ? { toolUsed: detail.toolUsed } : {}),
        ...(typeof detail?.error === 'string' && detail.error ? { error: detail.error } : {}),
        // The latest attempt could not run on our side and came after the shown result.
        ...(detail?.lastAttempt?.error && r.healthCheckedAt && detail.lastAttempt.at > r.healthCheckedAt.toISOString()
          ? { recheckFailed: detail.lastAttempt.error }
          : {}),
      };
    }
    // A personal server outside the registry: the scheduler does not probe it,
    // so all we can honestly say is whether its last connect FAILED. Not yet
    // connected (`disconnected`) is not a failure.
    return {
      registryId: `conn:${c.id}`,
      name: c.name,
      status: c.status === 'error' ? 'down' : 'unknown',
      checkedAt: null,
      server: c.status === 'error' ? 'down' : c.status === 'connected' ? 'up' : 'not-checked',
      database: 'not-tested',
      ...(c.lastError ? { error: c.lastError } : {}),
    };
  };

  const agents: McpHealthAgentView[] = AGENT_KEYS.map((agent) => {
    const seen = new Set<string>();
    const servers: McpHealthServerView[] = [];
    for (const c of conns.filter((x) => x.agent === agent)) {
      const v = view(c);
      if (seen.has(v.registryId)) continue;
      seen.add(v.registryId);
      servers.push(v);
    }
    servers.sort((a, b) => a.name.localeCompare(b.name));
    return { agent, label: AGENT_LABELS[agent], status: servers.length ? worstStatus(servers.map((s) => s.status)) : 'healthy', servers };
  });

  const counts: Record<McpHealthStatus, number> = { healthy: 0, degraded: 0, down: 0, unknown: 0 };
  let newest: string | null = null;
  const counted = new Set<string>();
  for (const a of agents) {
    for (const s of a.servers) {
      if (counted.has(s.registryId)) continue;
      counted.add(s.registryId);
      counts[s.status] += 1;
      if (s.checkedAt && (!newest || s.checkedAt > newest)) newest = s.checkedAt;
    }
  }
  const withServers = agents.filter((a) => a.servers.length);
  // Read from the history, not from this process: the checks run in the worker.
  const lastScheduled = await prisma.mcpHealthCheck.findFirst({ where: { source: 'scheduled' }, orderBy: { checkedAt: 'desc' }, select: { checkedAt: true } });
  return {
    overall: worstStatus(withServers.map((a) => a.status)),
    checkedAt: newest,
    agents,
    counts,
    autoCheck: { lastRunAt: lastScheduled?.checkedAt.toISOString() ?? null, intervalMs: INTERVAL_MS },
  };
}
