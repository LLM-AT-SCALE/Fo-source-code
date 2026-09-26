import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/shared/lib/auth-middleware";
import prisma from "@/shared/lib/db";
import {
  cmfTokenProvisioner,
  refreshCmfTokenFor,
  requestCmfTokenRefresh,
} from "@/modules/master-data-load/lib/cmf/token-refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long the request waits for the portal login before answering "still running". */
const WAIT_MS = Math.max(5_000, Number(process.env.CMF_TOKEN_SAVE_TIMEOUT_MS ?? "60000") || 60_000);

/**
 * POST /api/admin/database-connections/[id]/refresh-token — "Refresh token now".
 * Logs in to the CMF portal for this connection at once (when this process has
 * a browser) and reports the portal's own outcome, so an admin can retry
 * without re-saving. Without a browser here, the worker is asked to do it on
 * its next tick. Admin-only, audited.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    const row = await prisma.cmfConnection.findUnique({ where: { id }, select: { dbKey: true, label: true } });
    if (!row) return NextResponse.json({ error: "Connection not found." }, { status: 404 });

    if (cmfTokenProvisioner() === "lambda") {
      return NextResponse.json(
        { error: "The token is refreshed by the connection's Lambda (CMF_TOKEN_PROVISIONER=lambda); there is nothing to run here." },
        { status: 409 },
      );
    }

    const result = await refreshCmfTokenFor(row.dbKey, { timeoutMs: WAIT_MS, userId: auth.user.id });

    prisma.auditLog
      .create({
        data: {
          userId: auth.user.id,
          action: "cmf_connection.refresh_token",
          targetType: "CmfConnection",
          targetId: id,
          metadata: { dbKey: row.dbKey, ok: result.ok, skipped: result.skipped ?? null, pending: !!result.pending, error: result.error ?? null },
        },
      })
      .catch(() => {});

    if (result.skipped === "no-browser") {
      await requestCmfTokenRefresh(row.dbKey);
      return NextResponse.json({
        ok: false,
        queued: true,
        message: `Refresh requested: this service has no browser, so the background refresher will log in to the portal within a minute. Reload the list for the result.`,
      });
    }
    if (result.pending) {
      return NextResponse.json({
        ok: false,
        pending: true,
        message: `The portal login is still running after ${Math.round(WAIT_MS / 1000)} s; the Refresher column shows the result when it finishes.`,
      });
    }
    if (result.ok) {
      const expires = result.expiresAt ? ` It expires ${new Date(result.expiresAt).toLocaleString()}.` : "";
      return NextResponse.json({ ok: true, message: `Token fetched for "${row.label}".${expires}`, expiresAt: result.expiresAt });
    }
    return NextResponse.json({
      ok: false,
      message: `The portal login failed: ${result.error ?? "unknown reason"}`,
      error: result.error,
    });
  } catch (e) {
    console.error("[api/admin/database-connections/[id]/refresh-token] failed", e);
    return NextResponse.json({ error: "Could not refresh the token." }, { status: 500 });
  }
}
