/**
 * Audit Service - Records admin actions for compliance and debugging.
 */

// Use any Prisma-like client that supports auditLog.create
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TxClient = any;

export interface AuditEntry {
  userId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

/**
 * Record an audit log entry within a transaction.
 */
export async function recordAuditLog(tx: TxClient, entry: AuditEntry) {
  await tx.auditLog.create({
    data: {
      userId: entry.userId,
      action: entry.action,
      targetType: entry.targetType || null,
      targetId: entry.targetId || null,
      metadata: entry.metadata || {},
      ipAddress: entry.ipAddress || null,
    },
  });
}

/**
 * Record an audit log entry directly (no transaction).
 */
export async function recordAuditLogDirect(
  prisma: TxClient,
  entry: AuditEntry
) {
  await prisma.auditLog.create({
    data: {
      userId: entry.userId,
      action: entry.action,
      targetType: entry.targetType || null,
      targetId: entry.targetId || null,
      metadata: entry.metadata || {},
      ipAddress: entry.ipAddress || null,
    },
  });
}
