/**
 * After an admin saves a CMF connection: fetch its bearer token right away so
 * the response says whether the portal credentials work, instead of leaving
 * the admin to find out 45 minutes later. Shared by the create and update
 * routes of /api/admin/database-connections.
 *
 * Legacy path: `CMF_TOKEN_PROVISIONER=lambda` still provisions the per-connection
 * token Lambda (modules/admin/lib/mcp/cmf-lambda/provision.ts) for one release.
 */

import prisma from "@/shared/lib/db";
import {
  cmfTokenProvisioner,
  refreshCmfTokenFor,
  requestCmfTokenRefresh,
  type CmfTokenRefreshResult,
} from "@/modules/master-data-load/lib/cmf/token-refresh";
import { provisionConnectionLambda } from "@/modules/admin/lib/mcp/cmf-lambda/provision";

/** How long the save waits for the portal login before answering "still running". */
const WAIT_MS = Math.max(5_000, Number(process.env.CMF_TOKEN_SAVE_TIMEOUT_MS ?? "60000") || 60_000);

export interface SaveTokenOutcome {
  /** Read by the UI as the success toast. */
  message: string;
  /** Set when the save succeeded but the token could not be fetched — shown as an error toast. */
  warning?: string;
  token: { ok: boolean; pending?: boolean; queued?: boolean; error?: string; expiresAt?: string };
}

const SAVED_NO_CREDS: SaveTokenOutcome = {
  message: "Connection saved. Add a Portal User and Portal Password so the access token can be fetched.",
  warning: "Connection saved. Add Portal User + Portal Password so the access token can be fetched.",
  token: { ok: false },
};

function describe(verb: string, r: CmfTokenRefreshResult): SaveTokenOutcome {
  if (r.ok) {
    return { message: `Connection ${verb}; token fetched.`, token: { ok: true, expiresAt: r.expiresAt } };
  }
  if (r.pending) {
    return {
      message: `Connection ${verb}; the portal login is still running — the Refresher column shows the result.`,
      token: { ok: false, pending: true },
    };
  }
  if (r.skipped === "no-browser") {
    return {
      message: `Connection ${verb}; the background refresher fetches the token within a minute — the Refresher column shows the result.`,
      token: { ok: false, queued: true },
    };
  }
  const reason = r.error ?? "unknown reason";
  return {
    message: `Connection ${verb}.`,
    warning: `Connection ${verb}, but the portal login failed: ${reason} — fix the portal URL or credentials and save again.`,
    token: { ok: false, error: reason },
  };
}

/**
 * Fetch the token for a just-saved connection. `verb` is "saved" / "updated"
 * for the message. Never throws; a failure is in the outcome.
 */
export async function fetchTokenAfterSave(input: {
  dbKey: string;
  verb: "saved" | "updated";
  userId: string;
  hasPortalCredentials: boolean;
}): Promise<SaveTokenOutcome> {
  if (!input.hasPortalCredentials) return SAVED_NO_CREDS;
  try {
    const r = await refreshCmfTokenFor(input.dbKey, { timeoutMs: WAIT_MS, userId: input.userId });
    if (r.skipped === "no-browser") await requestCmfTokenRefresh(input.dbKey).catch(() => {});
    return describe(input.verb, r);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      message: `Connection ${input.verb}.`,
      warning: `Connection ${input.verb}, but the token could not be fetched: ${reason}`,
      token: { ok: false, error: reason },
    };
  }
}

/**
 * Legacy: (re)provision the connection's token Lambda + 45-min schedule and
 * store its ARN / schedule name on the row. Only when CMF_TOKEN_PROVISIONER=lambda.
 */
export async function provisionLambdaAfterSave(input: {
  id: string;
  verb: "saved" | "updated";
  portalPassword: string;
}): Promise<SaveTokenOutcome> {
  const row = await prisma.cmfConnection.findUnique({ where: { id: input.id } });
  if (!row) return { message: `Connection ${input.verb}.`, warning: "Connection not found after save.", token: { ok: false } };
  if (!(row.portalUser && input.portalPassword)) return SAVED_NO_CREDS;
  try {
    const existingFunctionName = row.lambdaArn ? row.lambdaArn.split(":function:")[1] || null : null;
    const { lambdaArn, scheduleName } = await provisionConnectionLambda({
      dbKey: row.dbKey,
      baseUrl: row.baseUrl,
      portalUser: row.portalUser,
      portalPassword: input.portalPassword,
      hostResolver: Array.isArray(row.hostResolver) ? (row.hostResolver as Array<[string, string]>) : [],
      tokenDbName: row.tokenDbName,
      tokenSecretId: row.tokenSecretId,
      existingFunctionName,
      existingScheduleName: row.scheduleName,
    });
    await prisma.cmfConnection.update({ where: { id: input.id }, data: { lambdaArn, scheduleName, updatedAt: new Date() } });
    return { message: `Connection ${input.verb}; token Lambda provisioned.`, token: { ok: true } };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("[cmf-connections] Lambda provisioning failed", e);
    return {
      message: `Connection ${input.verb}.`,
      warning: `Connection ${input.verb}, but provisioning the token Lambda failed: ${reason}. Fix the portal credentials and save again to retry.`,
      token: { ok: false, error: reason },
    };
  }
}

export const usesLambdaProvisioner = () => cmfTokenProvisioner() === "lambda";
