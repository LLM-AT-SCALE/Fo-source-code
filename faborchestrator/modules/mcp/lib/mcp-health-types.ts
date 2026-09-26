/**
 * MCP health — shared types for the checker, the admin cards and the cockpit.
 *
 * A check runs three stages in order and the status is the highest stage that
 * passed:
 *   1 reachable  `initialize` answered (transport + auth + process alive)
 *   2 tools      `tools/list` returned at least one tool
 *   3 data       one read-only tool call returned data (not an error payload)
 *
 *   healthy   all three passed
 *   degraded  stage 1 or 2 only — the server is up, its database is not answering
 *   down      stage 1 failed
 *   unknown   never checked, or the server is up but no read-only call could be
 *             chosen, so its database was not tested
 */
export type McpHealthStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

export const MCP_HEALTH_STATUSES: readonly McpHealthStatus[] = ['healthy', 'degraded', 'down', 'unknown'];

/** Worst-first order used to aggregate several servers into one status. */
export const MCP_HEALTH_SEVERITY: Record<McpHealthStatus, number> = { down: 3, degraded: 2, unknown: 1, healthy: 0 };

export function worstStatus(statuses: McpHealthStatus[]): McpHealthStatus {
  if (!statuses.length) return 'unknown';
  return statuses.reduce((w, s) => (MCP_HEALTH_SEVERITY[s] > MCP_HEALTH_SEVERITY[w] ? s : w), 'healthy' as McpHealthStatus);
}

/** Plain-language labels: what an operator needs to know, not the internal state name. */
export const MCP_HEALTH_LABELS: Record<McpHealthStatus, string> = {
  healthy: 'Healthy',
  degraded: 'DB down',
  down: 'Server down',
  unknown: 'Not checked',
};

/**
 * Saved data probe on mcp_registry.health_probe; null = the checker's own pick.
 * `source` says who chose it: the model ('llm') or an API caller ('admin').
 */
export type McpHealthProbe = { tool: string; arguments?: Record<string, unknown>; source?: 'llm' | 'admin'; reason?: string };

/** Stored on mcp_registry.health_detail and returned by the routes. */
export type McpHealthDetail = {
  status: McpHealthStatus;
  /** Highest stage that passed: 0 none, 1 reachable, 2 tools, 3 data. */
  stage: 0 | 1 | 2 | 3;
  checkedAt: string;
  reachMs?: number;
  toolsMs?: number;
  dataMs?: number;
  toolCount?: number;
  /** The tool the data probe called, and whether an admin chose it. */
  toolUsed?: string;
  /** configured = saved by an API caller, llm = chosen by the model and verified, automatic = heuristic pick, built-in = the runtime's health_check. */
  probeSource?: 'configured' | 'llm' | 'automatic' | 'built-in';
  error?: string;
  source: 'scheduled' | 'manual';
  /**
   * The latest attempt that could NOT run on our side (unreadable key, no
   * AWS access). The verdict above is kept; this says why it was not renewed.
   */
  lastAttempt?: { at: string; error: string };
};

/** The MCP server itself: answered `initialize` + `tools/list`, or not. */
export type McpServerLayer = 'up' | 'down' | 'not-checked';
/** The database behind it: a read-only call returned data, failed, or was not run. */
export type McpDatabaseLayer = 'ok' | 'failed' | 'not-tested';

/** Split a check result into its two layers — what the cockpit shows per server. */
export function healthLayers(detail: Pick<McpHealthDetail, 'status' | 'stage'> | null | undefined): { server: McpServerLayer; database: McpDatabaseLayer } {
  if (!detail) return { server: 'not-checked', database: 'not-tested' };
  if (detail.stage === 0) return { server: detail.status === 'down' ? 'down' : 'not-checked', database: 'not-tested' };
  if (detail.stage === 3) return { server: 'up', database: 'ok' };
  // Stage 2 = tools listed; a degraded result there means the data call failed.
  return { server: 'up', database: detail.stage === 2 && detail.status === 'degraded' ? 'failed' : 'not-tested' };
}

/** GET /api/mcp/health — what the cockpit shows. */
export type McpHealthServerView = {
  registryId: string;
  name: string;
  status: McpHealthStatus;
  checkedAt: string | null;
  server: McpServerLayer;
  database: McpDatabaseLayer;
  /** The read-only tool the database check called. */
  toolUsed?: string;
  error?: string;
  /** Set when the latest check could not run on our side; the row shows the previous result. */
  recheckFailed?: string;
};
export type McpHealthAgentView = {
  agent: string;
  label: string;
  status: McpHealthStatus;
  servers: McpHealthServerView[];
};
export type McpHealthSummary = {
  overall: McpHealthStatus;
  checkedAt: string | null;
  agents: McpHealthAgentView[];
  counts: Record<McpHealthStatus, number>;
  /**
   * Whether the automatic checks are actually running: when the last
   * scheduled run happened (null = never) and how often it is meant to run.
   */
  autoCheck?: { lastRunAt: string | null; intervalMs: number };
};
