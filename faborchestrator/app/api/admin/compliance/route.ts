/**
 * Data Retention & Compliance — REQ-D controls for the prompt-audit log.
 *
 * GET   → retentionDays + audit-content stats (totals, oldest, redactable,
 *         already-redacted).
 * PATCH → update the platform-wide audit retention window (1..3650 days).
 * POST  → REDACT prompt/response/tool CONTENT older than a cutoff while
 *         keeping the audit METADATA (prompt_id, user, datetime, tokens,
 *         cost, topic, status, model).
 *
 * Every prompt_audit_logs access is wrapped so a missing table/column never
 * crashes the route (stats degrade to zeros; redact returns 0).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getIpAddress } from '@/shared/lib/auth-middleware';
import prisma from '@/shared/lib/db';
import { recordAuditLog } from '@/modules/admin/lib/services/audit-service';

const SINGLETON_ID = 'global';
const DEFAULT_RETENTION_DAYS = 90;

/** Read the platform retention window, defaulting to 90 if unset/missing. */
async function readRetentionDays(): Promise<number> {
  try {
    const row = await prisma.platformSettings.findUnique({ where: { id: SINGLETON_ID } });
    const n = row?.auditRetentionDays;
    return typeof n === 'number' && n > 0 ? n : DEFAULT_RETENTION_DAYS;
  } catch {
    return DEFAULT_RETENTION_DAYS;
  }
}

interface AuditStats {
  totalPrompts: number;
  oldestDatetime: string | null;
  redactablePrompts: number;
  redactedPrompts: number;
}

/** Compute content-redaction stats. Never throws — zeros on any error. */
async function readStats(retentionDays: number): Promise<AuditStats> {
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*)::bigint AS total,
         MIN(datetime) AS oldest,
         COUNT(*) FILTER (
           WHERE datetime < NOW() - ($1 || ' days')::interval
             AND user_prompt <> '[REDACTED]'
         )::bigint AS redactable,
         COUNT(*) FILTER (WHERE user_prompt = '[REDACTED]')::bigint AS redacted
       FROM "prompt_audit_logs"`,
      String(retentionDays)
    )) as Array<{ total: bigint; oldest: Date | null; redactable: bigint; redacted: bigint }>;
    const r = rows[0];
    return {
      totalPrompts: Number(r?.total ?? 0),
      oldestDatetime: r?.oldest ? new Date(r.oldest).toISOString() : null,
      redactablePrompts: Number(r?.redactable ?? 0),
      redactedPrompts: Number(r?.redacted ?? 0),
    };
  } catch {
    return { totalPrompts: 0, oldestDatetime: null, redactablePrompts: 0, redactedPrompts: 0 };
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const retentionDays = await readRetentionDays();
  const stats = await readStats(retentionDays);
  return NextResponse.json({ retentionDays, stats });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const retentionDays = Number(body?.retentionDays);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    return NextResponse.json(
      { error: 'retentionDays must be an integer between 1 and 3650' },
      { status: 400 }
    );
  }

  try {
    const row = await prisma.$transaction(async (tx) => {
      const r = await tx.platformSettings.upsert({
        where: { id: SINGLETON_ID },
        update: { auditRetentionDays: retentionDays, updatedById: auth.user.id },
        create: { id: SINGLETON_ID, auditRetentionDays: retentionDays, updatedById: auth.user.id },
      });
      await recordAuditLog(tx, {
        userId: auth.user.id,
        action: 'compliance.retention_updated',
        targetType: 'PlatformSettings',
        targetId: SINGLETON_ID,
        metadata: { retentionDays },
        ipAddress: getIpAddress(req),
      });
      return r;
    });
    return NextResponse.json({ retentionDays: row.auditRetentionDays });
  } catch (e) {
    console.error('[admin/compliance] PATCH error', e);
    return NextResponse.json({ error: 'Failed to update retention setting' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const retentionDays = await readRetentionDays();
  let olderThanDays = retentionDays;
  if (body?.olderThanDays !== undefined && body.olderThanDays !== null && body.olderThanDays !== '') {
    const n = Number(body.olderThanDays);
    if (!Number.isInteger(n) || n < 1 || n > 3650) {
      return NextResponse.json(
        { error: 'olderThanDays must be an integer between 1 and 3650' },
        { status: 400 }
      );
    }
    olderThanDays = n;
  }

  try {
    // Scrub sensitive CONTENT but keep the audit METADATA (prompt_id, user,
    // datetime, tokens, cost, topic, status, model). Irreversible.
    const redacted = await prisma.$executeRawUnsafe(
      `UPDATE "prompt_audit_logs"
          SET user_prompt    = '[REDACTED]',
              llm_response   = '[REDACTED]',
              data_retrieved = NULL,
              query_executed = NULL,
              tool_calls     = NULL
        WHERE datetime < NOW() - ($1 || ' days')::interval
          AND user_prompt <> '[REDACTED]'`,
      String(olderThanDays)
    );
    const count = Number(redacted);

    try {
      await recordAuditLog(prisma, {
        userId: auth.user.id,
        action: 'compliance.redacted',
        targetType: 'PromptAuditLog',
        metadata: { olderThanDays, redacted: count },
        ipAddress: getIpAddress(req),
      });
    } catch {
      // best-effort audit log
    }

    return NextResponse.json({ redacted: count });
  } catch (e) {
    console.error('[admin/compliance] POST redact error', e);
    return NextResponse.json({ error: 'Failed to redact prompts' }, { status: 500 });
  }
}
