import { prisma } from "@/shared/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";

/**
 * BACK-END AGENT AUDIT — what was generated, for whom, and how it graded.
 *
 * Written into the SHARED `audit_logs` table as `backend.*` rows, exactly as the
 * Modeling Agent writes `cmf.*` rows. That is deliberate and copied: it needs no
 * new table and no migration on a schema the client is testing against, and the
 * trail shows up in the existing Admin Console audit page and `list_audit_logs` tool
 * without anyone building a second viewer for it.
 *
 * WHAT IS WORTH RECORDING, AND WHY
 *   The standalone app kept a `runs` row per draft and per generation, and the
 *   reason was not bookkeeping: a page that took five PRD drafts and three
 *   generation attempts is a different fact about the requirement document than
 *   one that passed first time. The validation counts belong here for the same
 *   reason — "23 passed, 2 warnings" is the claim this tool makes about its own
 *   output, and a claim nobody can audit later is worth very little.
 *
 * APPEND-ONLY, AND NEVER FATAL. An audit write that fails must not fail the turn
 * the engineer just watched succeed — the artifacts are on disk either way. It
 * is logged and swallowed, which is what the CMF helper does.
 */

export type BackendAuditAction = "PRD" | "GENERATE" | "REVISE" | "DOWNLOAD";

const ACTION_MAP: Record<BackendAuditAction, string> = {
  PRD: "backend.prd",
  GENERATE: "backend.generate",
  REVISE: "backend.revise",
  DOWNLOAD: "backend.download",
};

export interface BackendAuditContext {
  userId?: string | null;
  /** the conversation the run belongs to — the run directory is keyed on it */
  conversationId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export async function recordBackendAudit(
  action: BackendAuditAction,
  ctx: BackendAuditContext = {},
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: ACTION_MAP[action],
        userId: ctx.userId ?? null,
        /* Targeted at the CONVERSATION rather than the page: that is what the
           run directory, the transcript and the download are all keyed on, so it
           is the id someone reading the trail can actually follow. */
        targetType: ctx.conversationId ? "Conversation" : null,
        targetId: ctx.conversationId ?? null,
        metadata: (ctx.metadata ?? {}) as Prisma.InputJsonValue,
        ipAddress: ctx.ip ?? null,
      },
    });
  } catch (err) {
    console.error("[backend-agent-audit] failed to record", action, err);
  }
}

/** The client's address, for the audit row. */
export function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip");
}
