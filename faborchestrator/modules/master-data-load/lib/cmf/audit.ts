import { prisma } from "@/shared/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";

/**
 * CMF DataLoader (Modeling Agent) audit.
 *
 * Ported from cmf-loader's `recordAudit`, but instead of a dedicated
 * audit_events table we write into the shared `audit_logs` table as `cmf.*`
 * rows. This keeps the CMF load trail visible in the existing Admin Console
 * audit page + `list_audit_logs` tool with no new table. The call signature is
 * kept identical to the original so ported routes only need to swap the import.
 */

export type CmfAuditAction = "UPLOAD" | "VALIDATE" | "LOAD" | "LOGIN" | "SIGNUP";

const ACTION_MAP: Record<CmfAuditAction, string> = {
  UPLOAD: "cmf.upload",
  VALIDATE: "cmf.validate",
  LOAD: "cmf.load",
  LOGIN: "cmf.login",
  SIGNUP: "cmf.signup",
};

export type AuditContext = {
  userId?: string | null;
  packageId?: string | null;
  runId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
};

/** Append-only audit write. Never throws into the caller's happy path. */
export async function recordAudit(
  action: CmfAuditAction,
  ctx: AuditContext = {},
): Promise<void> {
  try {
    const metadata: Record<string, unknown> = { ...(ctx.metadata ?? {}) };
    if (ctx.runId) metadata.runId = ctx.runId;
    if (ctx.userAgent) metadata.userAgent = ctx.userAgent;
    await prisma.auditLog.create({
      data: {
        action: ACTION_MAP[action] ?? `cmf.${String(action).toLowerCase()}`,
        userId: ctx.userId ?? null,
        targetType: ctx.packageId ? "Package" : null,
        targetId: ctx.packageId ?? null,
        metadata: metadata as Prisma.InputJsonValue,
        ipAddress: ctx.ip ?? null,
      },
    });
  } catch (err) {
    console.error("[cmf-audit] failed to record", action, err);
  }
}
