/**
 * Friendly-error mapping — turns raw CMF errors (codes + messages) into
 * user-readable titles + descriptions + a suggested next action.
 *
 * Add new mappings as we learn about more codes. Unknown codes fall back to
 * the CMF Message text, which is usually already readable.
 */

import { CmfApiError } from "./cmf-client";
import { CmfNoDatabaseError } from "@/modules/master-data-load/lib/cmf/db-registry";
import { isCapturedError } from "@/shared/lib/errors/capture";

export type FriendlyAction =
  | "rename"
  | "refresh"
  | "retry"
  | "select-types"
  | "check-network"
  | undefined;

export type FriendlyError = {
  /** Short title (Sonner toast main line). */
  title: string;
  /** One-sentence explanation (Sonner description / inline body). */
  description: string;
  /** Suggested next action — UIs can branch on this (focus an input, show a Refresh button, etc.). */
  action: FriendlyAction;
  /** HTTP status the API surfaces to the client (200/4xx/5xx). */
  httpStatus: number;
  /** Raw CMF code if we have one — useful for support tickets. */
  cmfCode?: string;
  /** Raw CMF message — preserved so power users / support can see the original. */
  cmfMessage?: string;
  /** Id of the error_audit_logs record, when the failure was captured — what an
   *  admin looks up in the Admin Console error log. */
  errorId?: string;
};

/**
 * Known CMF error codes we want to dress up.
 *
 * `Db20005` — "The data for object X of type Y already exists." (duplicate name)
 * `Val50046` — "The data for object … has been changed by another user." (optimistic concurrency)
 * `Db20001` — generic "Data … not found" (we wrap as a soft 404)
 *
 * Extend as we discover more.
 */
const KNOWN: Record<
  string,
  (cmfMessage: string | undefined, ctx: { entityName?: string }) => FriendlyError
> = {
  Db20005: (cmfMessage, ctx) => ({
    title: ctx.entityName
      ? `A package named "${ctx.entityName}" already exists`
      : "That name is already in use",
    description:
      "Pick a different package name and try again. Package names must be unique across all master-data packages.",
    action: "rename",
    httpStatus: 409,
    cmfCode: "Db20005",
    cmfMessage,
  }),
  Val50046: (cmfMessage) => ({
    title: "This package was changed by someone else",
    description:
      "The package was modified between when you opened it and now. Refresh to load the latest version and try again.",
    action: "refresh",
    httpStatus: 409,
    cmfCode: "Val50046",
    cmfMessage,
  }),
  Db20001: (cmfMessage) => ({
    title: "Not found in CMF",
    description: cmfMessage ?? "The referenced object does not exist in CMF.",
    action: "retry",
    httpStatus: 404,
    cmfCode: "Db20001",
    cmfMessage,
  }),
};

/**
 * Extract a candidate entity-name from a CMF message like:
 *   "The data for object test11 of type Master Data Package already exists."
 */
function extractEntityName(msg?: string): string | undefined {
  if (!msg) return undefined;
  const m = msg.match(/data for object\s+([^\s]+)\s+of type/i);
  return m?.[1];
}

/**
 * Map any thrown error → FriendlyError. Safe to call on anything.
 */
export function toFriendly(err: unknown): FriendlyError {
  /*
   * CMF, SQL and S3 calls are wrapped in withCapture (lib/cmf/cmf-client.ts,
   * cmf-sql.ts, s3-object.ts) so every failure is recorded. The wrapper
   * rethrows a captured FabOrchError, which hid the original: `instanceof
   * CmfApiError` never matched, known CMF codes were no longer mapped, CMF's
   * own HTTP status was lost, and the network check read the summary instead
   * of the driver's message. The original is kept as `cause` — map THAT,
   * exactly as before the wrapper — but keep two things the record knows:
   * WHICH system failed (so an S3 failure is not titled as a CMF one) and the
   * record's id (so the wizard's toast can be looked up in the error log).
   */
  if (isCapturedError(err)) {
    const original = (err as { cause?: unknown }).cause;
    const system = err.detail.connector;
    const base =
      original !== undefined && original !== err ? mapError(original, system) : mapError(err, system);
    return { ...base, errorId: err.detail.errorId };
  }
  return mapError(err);
}

/**
 * Map one raw error. `system` is the captured system name when known
 * ("CMF", "CMF database (source)", "File storage (S3)") — it titles the
 * failures that are not CMF business errors, so a rejected S3 key is never
 * announced as a CMF server problem.
 */
function mapError(err: unknown, system?: string): FriendlyError {
  // No admin-created database connection (or none granted): an expected state
  // of the platform, not a fault — say what to do, no VPN advice, no 5xx.
  if (err instanceof CmfNoDatabaseError) {
    return {
      title: "No database connection",
      description: err.message,
      action: undefined,
      httpStatus: 409,
    };
  }
  if (err instanceof CmfApiError) {
    const entityName = extractEntityName(err.cmfMessage);
    const code = err.cmfCode;
    if (code && KNOWN[code]) {
      return KNOWN[code](err.cmfMessage, { entityName });
    }
    // Unknown CMF code — surface the platform message directly, but cleanly.
    return {
      title:
        err.status >= 500
          ? "The CMF server reported an error"
          : err.status >= 400
            ? "CMF rejected the request"
            : "Operation failed",
      description:
        err.cmfMessage ??
        `${err.path}: HTTP ${err.status} — see server logs for details.`,
      action: undefined,
      httpStatus: err.status,
      cmfCode: code,
      cmfMessage: err.cmfMessage,
    };
  }

  // Generic JS / network errors
  const msg = err instanceof Error ? err.message : String(err);
  const isCmfSystem = !system || /\bcmf\b/i.test(system);
  if (
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|ETIMEDOUT|ETIMEOUT|ESOCKET|EPIPE|socket hang up|Failed to connect|Could not connect|SQL Browser|getaddrinfo/i.test(msg)
  ) {
    // The advice stays (the VPN is the usual cause for CMF), but the driver's
    // own words follow it: "Check the VPN" alone reads the same for a dead
    // tunnel, a wrong port and a stopped SQL Browser.
    return {
      title: isCmfSystem ? "Can't reach the CMF server" : `Can't reach ${system}`,
      description: isCmfSystem
        ? `Check that you're connected to the Athenatec VPN and that the CMF host is reachable. Details: ${msg.slice(0, 300)}`
        : msg.slice(0, 400),
      action: "check-network",
      httpStatus: 503,
    };
  }
  if (/Select at least one object type/i.test(msg)) {
    return {
      title: "No object types selected",
      description:
        "Choose at least one object type from the list before running Validate or Load.",
      action: "select-types",
      httpStatus: 400,
    };
  }

  // Name the system that failed when the capture told us; "Something went
  // wrong" was the title for a rejected S3 key, an unreadable token secret
  // and a genuine bug alike.
  return {
    title: system ? `${system} request failed` : "Something went wrong",
    description: msg.slice(0, 400),
    action: undefined,
    httpStatus: 500,
  };
}

/** Matches an IPv4 address or a `HOST\INSTANCE` token — anything we must never
 *  hand to the business-facing chat agent. */
// HOST\INSTANCE is tried first, so "10.10.1.224\ONLINE" is replaced whole
// instead of leaving the instance name behind after the IP.
const HOST_OR_IP = /\b[A-Za-z0-9_.-]+\\[A-Za-z0-9_.-]+\b|\b\d{1,3}(?:\.\d{1,3}){3}\b/g;

/**
 * Error text safe to hand to the CHAT AGENT (Modeling Agent), which surfaces it
 * to a business user. Unlike `toFriendly` (used by the operator-facing loader
 * wizard, where "check the VPN / CMF host" is helpful), this never mentions a
 * host, IP address, port, VPN, driver code, or internal config setting.
 *
 * - Any reachability / timeout failure collapses to one calm line.
 * - Internal misconfiguration is kept generic (never names the env var).
 * - Genuine CMF business messages (e.g. duplicate name) pass through, but with
 *   any host/IP token scrubbed as a last line of defence.
 */
export function toModelSafeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ETIMEOUT|ESOCKET|EPIPE|socket hang up|Failed to connect|Could not connect|connection is closed|connection timeout|SQL Browser|getaddrinfo|fetch failed|network error/i.test(
      raw,
    )
  ) {
    // Keep the real reason. Collapsing every reachability fault into one
    // sentence meant a rejected login, a missing setting and an unreachable
    // host all read the same, and all implied "wait and retry" — which is
    // wrong for most of them.
    // ...but never the address: this text reaches a business user, and the
    // record behind the card keeps the full driver text for administrators.
    const scrubbed = raw.replace(HOST_OR_IP, "the system").replace(/(the system):\d{2,5}\b/g, "$1");
    return `The manufacturing system could not be reached: ${scrubbed.slice(0, 300)}`;
  }
  if (/not configured|is not set|missing .*env|environment variable/i.test(raw)) {
    return "This capability isn't available right now. Please contact your administrator.";
  }
  const f = toFriendly(err);
  const text = f.cmfMessage ?? f.description ?? raw;
  return text.replace(HOST_OR_IP, "the system").slice(0, 400);
}

/**
 * Server-route helper: shape the JSON body returned on error so the client
 * can render a friendly message without re-parsing.
 */
export function friendlyErrorPayload(err: unknown): {
  status: number;
  body: {
    error: {
      title: string;
      description: string;
      action: FriendlyAction;
      cmfCode?: string;
      cmfMessage?: string;
      errorId?: string;
    };
  };
} {
  const f = toFriendly(err);
  return {
    status: f.httpStatus,
    body: {
      error: {
        title: f.title,
        description: f.description,
        action: f.action,
        cmfCode: f.cmfCode,
        cmfMessage: f.cmfMessage,
        errorId: f.errorId,
      },
    },
  };
}

/**
 * Client-side shape used after `await res.json()` on a non-2xx response.
 */
export type FriendlyErrorPayload = {
  error: {
    title: string;
    description: string;
    action: FriendlyAction;
    cmfCode?: string;
    cmfMessage?: string;
    errorId?: string;
  };
};
