/**
 * In-app CMF token refresher — replaces the per-connection `cmf-token-<key>`
 * Lambda + EventBridge schedule.
 *
 * For every ENABLED row of `cmf_connections` that carries portal credentials
 * it performs the portal login (./portal-login, the Lambda's flow) and UPSERTs
 * the JWT into `cmf_bearer_tokens` exactly as the Lambda did: keyed by the
 * connection's `token_db_name`, columns token / expires_at / updated_at. The
 * Master Data Load agent keeps reading the token from that table (cmf-auth.ts);
 * nothing on the consuming side changes.
 *
 * WHEN a connection is refreshed
 *   - its token is missing, expired (within the safety margin) or older than
 *     CMF_TOKEN_REFRESH_MIN minutes (default 45 — the Lambda's schedule), or
 *   - the connection row was saved after the token was written and after this
 *     process last tried it (an admin changed the credentials, or asked for a
 *     refresh from a pod that has no browser — see `requestCmfTokenRefresh`).
 *   After a failure the connection is retried every CMF_TOKEN_RETRY_MIN minutes
 *   (default 5) rather than every tick: a bad password must not launch a
 *   browser once a minute, and a VPN blip must not cost the agent 45 minutes.
 *
 * WHO runs it
 *   - the scheduler's `cmf-token` stage (fabinsight worker, every minute, throttled
 *     as above; the first tick ~10 s after boot is the boot refresh);
 *   - the admin API right after a connection is saved / on "Refresh token now",
 *     when the admin pod has a browser (`refreshCmfTokenFor`).
 *
 * Each connection is independent: one failing never stops the others. Every
 * failure is recorded through shared/lib/errors (system "CMF portal login",
 * target = the connection label) and kept in an in-memory map for the status
 * shown to admins (`cmfRefresherStatuses`), which also reads the latest
 * error_audit_logs record so a failure in the worker is visible from the admin
 * pod without any new column.
 */

import { cleanResolverPairs } from "@/modules/master-data-load/lib/cmf/server-address";
import type { Prisma } from "@/lib/generated/prisma/client";

import { prisma } from "@/shared/lib/db";
import { decrypt } from "@/shared/lib/encryption";
import { recordCaptured } from "@/shared/lib/errors/capture";
import { FabOrchErrorType } from "@/shared/lib/errors/error-catalog-defaults";

import {
  CmfPortalLoginError,
  loginCmfPortal,
  resolveChromiumExecutable,
} from "@/modules/master-data-load/lib/cmf/portal-login";

export const CMF_TOKEN_SYSTEM = "CMF portal login";

/** How old a token may get before it is minted again (the Lambda's 45-min schedule). */
export const CMF_TOKEN_REFRESH_MIN = Math.max(5, Number(process.env.CMF_TOKEN_REFRESH_MIN ?? "45") || 45);
/** After a failed login, how long before the same connection is tried again. */
export const CMF_TOKEN_RETRY_MIN = Math.max(1, Number(process.env.CMF_TOKEN_RETRY_MIN ?? "5") || 5);
/** A token this close to `expires_at` counts as expired (mirrors cmf-auth's TOKEN_SAFETY_MARGIN_SEC). */
const MARGIN_MS = Number(process.env.TOKEN_SAFETY_MARGIN_SEC ?? "60") * 1000;

const REFRESH_MS = CMF_TOKEN_REFRESH_MIN * 60_000;
const RETRY_MS = CMF_TOKEN_RETRY_MIN * 60_000;

/** `CMF_TOKEN_PROVISIONER=lambda` keeps the legacy per-connection Lambda for one release. */
export function cmfTokenProvisioner(): "in-app" | "lambda" {
  return (process.env.CMF_TOKEN_PROVISIONER ?? "").trim().toLowerCase() === "lambda" ? "lambda" : "in-app";
}

/** Whether THIS process can log in (a Chromium is available to it). */
export async function cmfPortalLoginAvailable(): Promise<boolean> {
  return (await resolveChromiumExecutable()) !== null;
}

/* ------------------------------------------------------------------------ */
/* In-memory state (per process)                                             */
/* ------------------------------------------------------------------------ */

export interface CmfTokenAttempt {
  /** ms epoch of the attempt. */
  at: number;
  ok: boolean;
  /** The login's own message when it failed. */
  error?: string;
  /** `cmf_connections.updated_at` (ms) as seen at the attempt, to notice a later re-save. */
  rowUpdatedAt: number;
}

const attempts = new Map<string, CmfTokenAttempt>();
const inflight = new Map<string, Promise<CmfTokenRefreshResult>>();

/** The last attempt this process made per connection key (read by the status API). */
export function lastCmfTokenAttempts(): ReadonlyMap<string, CmfTokenAttempt> {
  return attempts;
}

/* ------------------------------------------------------------------------ */
/* Rows                                                                      */
/* ------------------------------------------------------------------------ */

type ConnectionRow = Prisma.CmfConnectionGetPayload<object>;

interface TokenRow {
  tokenDbName: string;
  expiresAt: number | null;
  updatedAt: number;
}

function parseResolver(raw: unknown): Array<[string, string]> {
  // Rows saved before the server field was normalised can map the portal host
  // to "10.10.1.224/ONLINE"; keep only the address part.
  return cleanResolverPairs(raw);
}

function hasPortalCredentials(row: ConnectionRow): boolean {
  return !!(row.portalUser && row.portalUser.trim() && row.portalPasswordEncrypted);
}

async function loadTokens(tokenDbNames: string[]): Promise<Map<string, TokenRow>> {
  const out = new Map<string, TokenRow>();
  if (!tokenDbNames.length) return out;
  const rows = await prisma.cmfBearerToken.findMany({ where: { cmfDatabaseName: { in: tokenDbNames } } });
  for (const r of rows) {
    out.set(r.cmfDatabaseName, {
      tokenDbName: r.cmfDatabaseName,
      expiresAt: r.expiresAt ? r.expiresAt.getTime() : null,
      updatedAt: r.updatedAt.getTime(),
    });
  }
  return out;
}

/** Same write as the Lambda: UPSERT by token_db_name, token + expires_at + updated_at = now(). */
async function writeToken(tokenDbName: string, token: string, expiresAt: number): Promise<void> {
  const expires = new Date(expiresAt);
  await prisma.cmfBearerToken.upsert({
    where: { cmfDatabaseName: tokenDbName },
    create: { cmfDatabaseName: tokenDbName, token, expiresAt: expires, updatedAt: new Date() },
    update: { token, expiresAt: expires, updatedAt: new Date() },
  });
}

/* ------------------------------------------------------------------------ */
/* Refresh                                                                   */
/* ------------------------------------------------------------------------ */

export interface CmfTokenRefreshResult {
  dbKey: string;
  label: string;
  ok: boolean;
  /** Why nothing was attempted. */
  skipped?: "no-credentials" | "fresh" | "throttled" | "no-browser" | "disabled" | "not-found";
  /** The login's own message when it failed. */
  error?: string;
  /** When the login was still running after the caller's wait (`refreshCmfTokenFor` with a timeout). */
  pending?: boolean;
  expiresAt?: string;
  refreshedAt?: string;
}

function tokenIsStale(token: TokenRow | undefined, now: number): boolean {
  if (!token) return true;
  if (!token.expiresAt || token.expiresAt <= now + MARGIN_MS) return true;
  return now - token.updatedAt >= REFRESH_MS;
}

/** Error type for the record: credentials → INVALID_PARAMETER, else inferred from the error (timeouts, network codes). */
function errorType(err: unknown): FabOrchErrorType | undefined {
  if (err instanceof CmfPortalLoginError) {
    if (err.kind === "credentials") return FabOrchErrorType.INVALID_PARAMETER;
    if (err.kind === "browser") return FabOrchErrorType.INVALID_PARAMETER; // a configuration gap, not a data failure
  }
  const status = (err as { status?: number; httpStatus?: number })?.status ?? (err as { httpStatus?: number })?.httpStatus;
  if (status === 401) return FabOrchErrorType.INVALID_PARAMETER;
  return undefined;
}

/**
 * Log in for ONE connection row and store the token. Never throws: the outcome
 * is the result, the failure is recorded and remembered. Deduplicated per key
 * so the scheduler and an admin's save never run two browsers for one connection.
 */
function attemptRefresh(row: ConnectionRow, userId?: string | null): Promise<CmfTokenRefreshResult> {
  const running = inflight.get(row.dbKey);
  if (running) return running;

  const p = (async (): Promise<CmfTokenRefreshResult> => {
    const startedAt = Date.now();
    const base: CmfTokenRefreshResult = { dbKey: row.dbKey, label: row.label, ok: false };
    let password = "";
    try {
      password = row.portalPasswordEncrypted ? decrypt(row.portalPasswordEncrypted) : "";
    } catch (e) {
      const err = new Error(
        `The stored portal password for "${row.label}" cannot be decrypted (was KEY_ENCRYPTION_SECRET changed?): ${e instanceof Error ? e.message : String(e)}`,
      );
      return remember(row, startedAt, base, err, userId, FabOrchErrorType.INVALID_PARAMETER);
    }
    try {
      const { token, expiresAt, source } = await loginCmfPortal({
        baseUrl: row.baseUrl,
        user: row.portalUser ?? "",
        pass: password,
        hostResolver: parseResolver(row.hostResolver),
      });
      await writeToken(row.tokenDbName, token, expiresAt);
      attempts.set(row.dbKey, { at: startedAt, ok: true, rowUpdatedAt: row.updatedAt.getTime() });
      console.log(
        `[cmf-token] refreshed "${row.label}" (${row.dbKey}) from ${source}; expires ${new Date(expiresAt).toISOString()}`,
      );
      return { ...base, ok: true, expiresAt: new Date(expiresAt).toISOString(), refreshedAt: new Date().toISOString() };
    } catch (err) {
      return remember(row, startedAt, base, err, userId, errorType(err));
    }
  })().finally(() => {
    inflight.delete(row.dbKey);
  });
  inflight.set(row.dbKey, p);
  return p;
}

function remember(
  row: ConnectionRow,
  startedAt: number,
  base: CmfTokenRefreshResult,
  err: unknown,
  userId: string | null | undefined,
  type: FabOrchErrorType | undefined,
): CmfTokenRefreshResult {
  const message = err instanceof Error ? err.message : String(err);
  attempts.set(row.dbKey, { at: startedAt, ok: false, error: message, rowUpdatedAt: row.updatedAt.getTime() });
  recordCaptured(
    {
      system: CMF_TOKEN_SYSTEM,
      operation: "login",
      target: row.label,
      userId: userId ?? null,
      type,
      // dbKey lets the status API find this connection's latest record; never the password.
      extra: { dbKey: row.dbKey, baseUrl: row.baseUrl, portalUser: row.portalUser ?? "" },
    },
    err,
  );
  console.error(`[cmf-token] refresh failed for "${row.label}" (${row.dbKey}): ${message}`);
  return { ...base, ok: false, error: message };
}

/**
 * The scheduled pass: every enabled connection with portal credentials whose
 * token is missing / expired / older than CMF_TOKEN_REFRESH_MIN, one at a time
 * (one browser at a time), each failure isolated. `force` ignores the age and
 * the throttle (used by the boot-time and admin-triggered paths).
 */
export async function refreshCmfTokens(opts: { force?: boolean; dbKeys?: string[] } = {}): Promise<CmfTokenRefreshResult[]> {
  const rows = await prisma.cmfConnection.findMany({
    where: { enabled: true, ...(opts.dbKeys?.length ? { dbKey: { in: opts.dbKeys } } : {}) },
    orderBy: { dbKey: "asc" },
  });
  const tokens = await loadTokens(rows.map((r) => r.tokenDbName));
  const results: CmfTokenRefreshResult[] = [];
  const browserOk = await cmfPortalLoginAvailable();
  let browserReported = false;

  for (const row of rows) {
    const base: CmfTokenRefreshResult = { dbKey: row.dbKey, label: row.label, ok: false };
    if (!hasPortalCredentials(row)) {
      results.push({ ...base, skipped: "no-credentials" });
      continue;
    }
    const now = Date.now();
    const token = tokens.get(row.tokenDbName);
    const last = attempts.get(row.dbKey);
    const rowUpdated = row.updatedAt.getTime();
    const forced = opts.force || (rowUpdated > (last?.at ?? 0) && rowUpdated > (token?.updatedAt ?? 0));
    if (!forced && !tokenIsStale(token, now)) {
      results.push({ ...base, ok: true, skipped: "fresh", expiresAt: token?.expiresAt ? new Date(token.expiresAt).toISOString() : undefined });
      continue;
    }
    if (!forced && last && now - last.at < (last.ok ? REFRESH_MS : RETRY_MS)) {
      results.push({ ...base, skipped: "throttled", error: last.error });
      continue;
    }
    if (!browserOk) {
      // One record for the process, not one per connection: the gap is the image, not the row.
      if (!browserReported) {
        browserReported = true;
        recordCaptured(
          { system: CMF_TOKEN_SYSTEM, operation: "launch browser", type: FabOrchErrorType.INVALID_PARAMETER },
          new CmfPortalLoginError("browser", "No Chromium is available in this process; set CMF_CHROMIUM_PATH (the fabinsight and admin images install it)."),
        );
      }
      results.push({ ...base, skipped: "no-browser" });
      continue;
    }
    results.push(await attemptRefresh(row));
  }
  return results;
}

/**
 * Refresh ONE connection now (after a save, or "Refresh token now"), waiting at
 * most `timeoutMs` for the login so the admin sees the outcome in the response.
 * If the login is still running when the wait ends, the result says `pending`
 * and the login carries on in the background (its outcome lands in the token
 * table / the error log and shows on the next list load).
 */
export async function refreshCmfTokenFor(
  dbKey: string,
  opts: { timeoutMs?: number; userId?: string | null } = {},
): Promise<CmfTokenRefreshResult> {
  const row = await prisma.cmfConnection.findUnique({ where: { dbKey } });
  if (!row) return { dbKey, label: dbKey, ok: false, skipped: "not-found", error: "Connection not found." };
  if (!row.enabled) return { dbKey, label: row.label, ok: false, skipped: "disabled", error: "The connection is disabled." };
  if (!hasPortalCredentials(row)) {
    return { dbKey, label: row.label, ok: false, skipped: "no-credentials", error: "The connection has no portal user / password." };
  }
  if (!(await cmfPortalLoginAvailable())) return { dbKey, label: row.label, ok: false, skipped: "no-browser" };

  const work = attemptRefresh(row, opts.userId);
  if (!opts.timeoutMs) return work;
  let timer: NodeJS.Timeout | undefined;
  const wait = new Promise<CmfTokenRefreshResult>((resolve) => {
    timer = setTimeout(() => resolve({ dbKey, label: row.label, ok: false, pending: true }), opts.timeoutMs);
  });
  try {
    return await Promise.race([work, wait]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ask the worker to refresh a connection on its next tick — for a pod that has
 * no browser of its own. Touching `updated_at` is the signal the scheduled pass
 * reads (a row saved after the last attempt is retried at once); no new column.
 */
export async function requestCmfTokenRefresh(dbKey: string): Promise<void> {
  await prisma.cmfConnection.update({ where: { dbKey }, data: { updatedAt: new Date() } });
}

/* ------------------------------------------------------------------------ */
/* Status for admins                                                         */
/* ------------------------------------------------------------------------ */

export interface CmfRefresherStatus {
  mode: "in-app" | "lambda";
  state: "ok" | "failed" | "pending" | "no-credentials" | "disabled" | "lambda";
  /** ISO — when the current token was written. */
  refreshedAt?: string;
  /** ISO — when the current token expires. */
  expiresAt?: string;
  /** The last failure's message and time, when it is newer than the token. */
  error?: string;
  errorAt?: string;
  /** One line for the list: "In-app · refreshed 5 min ago · expires in 52 min". */
  text: string;
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function inFuture(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "less than a minute";
  if (m < 60) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

interface LatestFailureRow {
  db_key: string;
  technical_message: string | null;
  user_message: string | null;
  datetime: Date;
}

/** The newest recorded login failure per connection (any process), last 7 days. */
async function latestRecordedFailures(dbKeys: string[]): Promise<Map<string, { message: string; at: number }>> {
  const out = new Map<string, { message: string; at: number }>();
  if (!dbKeys.length) return out;
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ON (request_context->'toolArgs'->>'dbKey')
              request_context->'toolArgs'->>'dbKey' AS db_key,
              technical_message, user_message, datetime
         FROM error_audit_logs
        WHERE request_context->>'system' = $1
          AND request_context->'toolArgs'->>'dbKey' = ANY($2::text[])
          AND datetime > now() - interval '7 days'
        ORDER BY request_context->'toolArgs'->>'dbKey', datetime DESC`,
      CMF_TOKEN_SYSTEM,
      dbKeys,
    )) as LatestFailureRow[];
    for (const r of rows) {
      out.set(r.db_key, { message: r.technical_message || r.user_message || "login failed", at: new Date(r.datetime).getTime() });
    }
  } catch (e) {
    console.error("[cmf-token] could not read the latest login failures", e);
  }
  return out;
}

/**
 * Status per connection key for the admin list, derived from cmf_bearer_tokens
 * (last written / expires), this process's attempts and the error log — no
 * new column. A failure counts only while it is newer than the stored token.
 */
export async function cmfRefresherStatuses(
  rows: Array<{
    dbKey: string;
    tokenDbName: string;
    enabled: boolean;
    portalUser: string | null;
    hasPortalPassword: boolean;
    lambdaArn: string | null;
  }>,
): Promise<Map<string, CmfRefresherStatus>> {
  const mode = cmfTokenProvisioner();
  const tokens = await loadTokens(rows.map((r) => r.tokenDbName));
  const recorded = mode === "in-app" ? await latestRecordedFailures(rows.map((r) => r.dbKey)) : new Map();
  const now = Date.now();
  const out = new Map<string, CmfRefresherStatus>();

  for (const r of rows) {
    const token = tokens.get(r.tokenDbName);
    const tokenPart = token
      ? `refreshed ${ago(now - token.updatedAt)} · ${
          token.expiresAt ? (token.expiresAt > now ? `expires in ${inFuture(token.expiresAt - now)}` : `expired ${ago(now - token.expiresAt)}`) : "no expiry"
        }`
      : null;
    const base: Pick<CmfRefresherStatus, "refreshedAt" | "expiresAt"> = {
      refreshedAt: token ? new Date(token.updatedAt).toISOString() : undefined,
      expiresAt: token?.expiresAt ? new Date(token.expiresAt).toISOString() : undefined,
    };

    if (mode === "lambda") {
      out.set(r.dbKey, {
        mode,
        state: "lambda",
        ...base,
        text: r.lambdaArn ? `Lambda · provisioned${tokenPart ? ` · ${tokenPart}` : ""}` : "Lambda · not provisioned",
      });
      continue;
    }
    if (!(r.portalUser && r.portalUser.trim() && r.hasPortalPassword)) {
      out.set(r.dbKey, { mode, state: "no-credentials", ...base, text: "No portal credentials" });
      continue;
    }
    if (!r.enabled) {
      out.set(r.dbKey, { mode, state: "disabled", ...base, text: `Disabled${tokenPart ? ` · ${tokenPart}` : ""}` });
      continue;
    }
    // The newest failure known here: this process's own attempt, else the error log.
    const local = attempts.get(r.dbKey);
    const rec = recorded.get(r.dbKey);
    let failure: { message: string; at: number } | undefined;
    if (local && !local.ok && local.error) failure = { message: local.error, at: local.at };
    if (rec && (!failure || rec.at > failure.at)) failure = rec;
    if (failure && (!token || failure.at > token.updatedAt)) {
      out.set(r.dbKey, {
        mode,
        state: "failed",
        ...base,
        error: failure.message,
        errorAt: new Date(failure.at).toISOString(),
        text: `In-app · failed: ${failure.message}${tokenPart ? ` (last token ${tokenPart})` : ""}`,
      });
      continue;
    }
    if (!token) {
      out.set(r.dbKey, { mode, state: "pending", text: "In-app · waiting for the first refresh" });
      continue;
    }
    out.set(r.dbKey, { mode, state: "ok", ...base, text: `In-app · ${tokenPart}` });
  }
  return out;
}
