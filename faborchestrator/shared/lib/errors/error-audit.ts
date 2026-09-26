/**
 * FabOrch Audit — REQ-03 Error Audit Log helpers.
 *
 * Persists every FabOrchError flowing through `handleApiError()` into
 * the `error_audit_logs` table, generates the human-friendly
 * `ERR-YYYYMMDD-NNNN` IDs atomically, and exposes admin-side query
 * + resolve + retention helpers.
 *
 * Uses raw SQL via Prisma (`$executeRawUnsafe` / `$queryRawUnsafe`)
 * because the Prisma client cannot be regenerated under the local
 * Node 20.11 + Prisma 7 toolchain. Switching to typed `prisma.errorAuditLog.*`
 * is a one-line change once the client is regenerated.
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '../db';
import type { FabOrchError, FabOrchErrorEnvelope } from './faborch-errors';
import { FabOrchErrorType } from './faborch-errors';

export type ErrorAuditStatus = 'OPEN' | 'RESOLVED';

export interface ErrorAuditContext {
  userId?: string | null;
  route?: string | null;
  method?: string | null;
  technicalMessage?: string | null;
  stackPreview?: string | null;
  requestContext?: Record<string, unknown> | null;
}

/**
 * REQ-01 #8 — SESSION_TIMEOUT for an unauthenticated request fires
 * on every page load by a logged-out user. We deliberately skip
 * those so the table doesn't fill with low-signal noise; CloudWatch
 * keeps the full record. Authenticated SESSION_TIMEOUT (idle eviction
 * mid-flight) IS persisted because it has a userId.
 */
function shouldPersist(envelope: FabOrchErrorEnvelope, ctx: ErrorAuditContext): boolean {
  if (envelope.type === FabOrchErrorType.SESSION_TIMEOUT && !ctx.userId) {
    return false;
  }
  return true;
}

/**
 * Atomically generate the next ERR-YYYYMMDD-NNNN id for the given
 * UTC date. Uses an ON CONFLICT upsert against `error_audit_daily_counter`
 * so concurrent inserts never collide.
 */
async function nextErrorId(): Promise<string> {
   
  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO error_audit_daily_counter (counter_date, last_seq)
     VALUES (CURRENT_DATE, 1)
     ON CONFLICT (counter_date)
       DO UPDATE SET last_seq = error_audit_daily_counter.last_seq + 1
     RETURNING last_seq, to_char(counter_date, 'YYYYMMDD') AS day`
  )) as Array<{ last_seq: number; day: string }>;
  const r = rows[0];
  const seq = String(r.last_seq).padStart(4, '0');
  return `ERR-${r.day}-${seq}`;
}

/**
 * Persist a FabOrchError to error_audit_logs. Fire-and-forget from the
 * call site — never throw. Returns the human ErrorID on success, null
 * on persistence failure (which is itself logged via the caller).
 */
export async function recordError(
  err: FabOrchError,
  ctx: ErrorAuditContext = {}
): Promise<string | null> {
  const envelope = err.toEnvelope();
  if (!shouldPersist(envelope, ctx)) return null;

  try {
    const errorId = await nextErrorId();
    const id = randomUUID();
    const cause = (err as { cause?: unknown }).cause;
    const technicalMessage =
      ctx.technicalMessage
      ?? (cause instanceof Error ? cause.message : (typeof cause === 'string' ? cause : null));
    const stack = ctx.stackPreview ?? (err.stack ? err.stack.slice(0, 2000) : null);
    const requestCtx = ctx.requestContext ?? envelope.context ?? null;

    await prisma.$executeRawUnsafe(
      `INSERT INTO "error_audit_logs"
         (id, error_id, error_uuid, error_type, user_id, datetime,
          user_message, technical_message, priority, status,
          route, http_method, http_status, stack_preview, request_context, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW(),
               $6, $7, $8, 'OPEN'::"error_audit_status",
               $9, $10, $11, $12, $13::jsonb, NOW())`,
      id,
      errorId,
      envelope.errorId,
      envelope.type,
      ctx.userId ?? null,
      envelope.userMessage,
      technicalMessage,
      envelope.priority,
      ctx.route ?? envelope.context?.route ?? null,
      ctx.method ?? envelope.context?.method ?? null,
      envelope.httpStatus,
      stack,
      requestCtx ? JSON.stringify(requestCtx) : null
    );

    return errorId;
  } catch {
    // Persistence must never break the request path; CloudWatch already has it.
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// Admin-side queries (called by the admin chat tools)
// ────────────────────────────────────────────────────────────────

export interface ErrorAuditFilters {
  userId?: string | null;
  userKey?: string | null;
  errorType?: string | null;
  priority?: 'HIGH' | 'MEDIUM' | null;
  status?: ErrorAuditStatus | 'all' | null;
  dateFrom?: Date | null;
  dateTo?: Date | null;
  errorIdLike?: string | null;
  limit?: number;
}

export interface ErrorAuditRow {
  id: string;
  errorId: string;
  errorType: string;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  datetime: Date;
  userMessage: string;
  technicalMessage: string | null;
  priority: string;
  status: ErrorAuditStatus;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  route: string | null;
  httpStatus: number | null;
}

export async function queryErrorAudit(
  filters: ErrorAuditFilters
): Promise<{ rows: ErrorAuditRow[]; truncated: boolean }> {
  const limit = Math.min(Math.max(1, filters.limit ?? 100), 1000);
  const conds: string[] = [];
  const values: unknown[] = [];
  const push = (sql: string, v: unknown) => {
    values.push(v);
    conds.push(sql.replace('$?', `$${values.length}`));
  };

  if (filters.userId) push(`l.user_id = $?`, filters.userId);
  if (filters.userKey) {
    const key = `%${filters.userKey}%`;
    values.push(key, key, key);
    const a = `$${values.length - 2}`;
    const b = `$${values.length - 1}`;
    const c = `$${values.length}`;
    conds.push(
      `(u.name ILIKE ${a} OR u.email ILIKE ${b} OR split_part(u.email, '@', 1) ILIKE ${c})`
    );
  }
  if (filters.errorType) push(`l.error_type = $?`, filters.errorType);
  if (filters.priority) push(`l.priority = $?`, filters.priority);
  if (filters.status && filters.status !== 'all') push(`l.status = $?::"error_audit_status"`, filters.status);
  if (filters.dateFrom) push(`l.datetime >= $?`, filters.dateFrom);
  if (filters.dateTo) push(`l.datetime <= $?`, filters.dateTo);
  if (filters.errorIdLike) {
    // Match EITHER id: chat shows users the UUID (error_uuid), while this
    // table's own key is the human ERR-YYYYMMDD-NNNN (error_id). An admin
    // following up on an errorId from a user is pasting the UUID.
    const k = `%${filters.errorIdLike}%`;
    values.push(k, k);
    conds.push(`(l.error_id ILIKE $${values.length - 1} OR l.error_uuid ILIKE $${values.length})`);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const sql = `
    SELECT l.id, l.error_id, l.error_type,
           l.user_id, u.name AS user_name, u.email AS user_email,
           l.datetime, l.user_message, l.technical_message,
           l.priority, l.status,
           l.resolved_by, ru.name AS resolved_by_name, l.resolved_at, l.resolution_note,
           l.route, l.http_status
      FROM "error_audit_logs" l
      LEFT JOIN "users" u  ON u.id  = l.user_id
      LEFT JOIN "users" ru ON ru.id = l.resolved_by
      ${where}
     ORDER BY l.datetime DESC
     LIMIT ${limit + 1}
  `;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (await prisma.$queryRawUnsafe(sql, ...values)) as any[];
  const truncated = raw.length > limit;
  const rows = raw.slice(0, limit).map((r) => ({
    id: r.id,
    errorId: r.error_id,
    errorType: r.error_type,
    userId: r.user_id,
    userName: r.user_name,
    userEmail: r.user_email,
    datetime: r.datetime,
    userMessage: r.user_message,
    technicalMessage: r.technical_message,
    priority: r.priority,
    status: r.status as ErrorAuditStatus,
    resolvedBy: r.resolved_by,
    resolvedByName: r.resolved_by_name,
    resolvedAt: r.resolved_at,
    resolutionNote: r.resolution_note,
    route: r.route,
    httpStatus: r.http_status,
  }));
  return { rows, truncated };
}

export async function countErrorAudit(filters: ErrorAuditFilters): Promise<number> {
  const conds: string[] = [];
  const values: unknown[] = [];
  const push = (sql: string, v: unknown) => {
    values.push(v);
    conds.push(sql.replace('$?', `$${values.length}`));
  };
  if (filters.userId) push(`l.user_id = $?`, filters.userId);
  if (filters.userKey) {
    const key = `%${filters.userKey}%`;
    values.push(key, key, key);
    const a = `$${values.length - 2}`, b = `$${values.length - 1}`, c = `$${values.length}`;
    conds.push(`(u.name ILIKE ${a} OR u.email ILIKE ${b} OR split_part(u.email,'@',1) ILIKE ${c})`);
  }
  if (filters.errorType) push(`l.error_type = $?`, filters.errorType);
  if (filters.priority) push(`l.priority = $?`, filters.priority);
  if (filters.status && filters.status !== 'all') push(`l.status = $?::"error_audit_status"`, filters.status);
  if (filters.dateFrom) push(`l.datetime >= $?`, filters.dateFrom);
  if (filters.dateTo) push(`l.datetime <= $?`, filters.dateTo);
  if (filters.errorIdLike) {
    // Match EITHER id: chat shows users the UUID (error_uuid), while this
    // table's own key is the human ERR-YYYYMMDD-NNNN (error_id). An admin
    // following up on an errorId from a user is pasting the UUID.
    const k = `%${filters.errorIdLike}%`;
    values.push(k, k);
    conds.push(`(l.error_id ILIKE $${values.length - 1} OR l.error_uuid ILIKE $${values.length})`);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const sql = `SELECT COUNT(*)::int AS c FROM "error_audit_logs" l
                 LEFT JOIN "users" u ON u.id = l.user_id ${where}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await prisma.$queryRawUnsafe(sql, ...values)) as any[];
  return Number(rows[0]?.c || 0);
}

export async function markErrorResolved(params: {
  errorId: string; // ERR-YYYYMMDD-NNNN
  adminUserId: string;
  note?: string;
}): Promise<boolean> {
  const result = await prisma.$executeRawUnsafe(
    `UPDATE "error_audit_logs"
        SET status = 'RESOLVED'::"error_audit_status",
            resolved_by = $2,
            resolved_at = NOW(),
            resolution_note = $3
      WHERE (error_id = $1 OR error_uuid = $1)
        AND status = 'OPEN'`,
    params.errorId,
    params.adminUserId,
    params.note ?? null
  );
  return Number(result) > 0;
}

/**
 * REQ-03 retention — delete error_audit_logs rows older than 90 days.
 */
export async function purgeOldErrors(): Promise<number> {
  const result = await prisma.$executeRawUnsafe(
    `DELETE FROM "error_audit_logs"
      WHERE datetime < NOW() - INTERVAL '90 days'`
  );
  return Number(result);
}
