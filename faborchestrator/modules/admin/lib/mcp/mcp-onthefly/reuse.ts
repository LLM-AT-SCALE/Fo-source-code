/**
 * On-the-Fly MCP — credential reuse at intake.
 *
 * Every upload used to create a new Secrets Manager secret, so one database
 * ended up with half a dozen identical secrets. Before storing a new one, look
 * for data sources that already hold the SAME login (host, port, database and
 * user) and offer them back to the admin. The comparison happens here, on the
 * server, against the stored secret; only non-secret facts leave this module.
 */
import prisma from '@/shared/lib/db';
import { readTargetSecret } from './secrets';
import type { CredsDoc } from './types';

export interface ReusableSource {
  id: string;
  name: string;
  engine: string;
  status: string;
  host: string | null;
  database: string | null;
  createdAt: Date;
  /** The uploaded password is the one already stored; false = same login, new password. */
  samePassword: boolean;
}

const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

/** Data sources (not retired, with a secret) that hold the same login as `creds`. */
export async function findReusableSources(engine: string, creds: CredsDoc): Promise<ReusableSource[]> {
  const rows = await prisma.mcpDataSource.findMany({
    where: {
      engine,
      status: { not: 'RETIRED' },
      secretArn: { not: null },
      host: { equals: creds.host.trim(), mode: 'insensitive' },
      database: { equals: creds.database.trim(), mode: 'insensitive' },
    },
    orderBy: { createdAt: 'desc' },
    take: 25,
  });
  const out: ReusableSource[] = [];
  const seenArn = new Set<string>();
  for (const r of rows) {
    if (!r.secretArn || seenArn.has(r.secretArn)) continue;
    if ((r.port ?? null) !== (creds.port ?? null)) continue;
    const stored = await readTargetSecret(r.secretArn);
    if (!stored || norm(stored.user) !== norm(creds.user)) continue;
    seenArn.add(r.secretArn);
    out.push({
      id: r.id, name: r.name, engine: r.engine, status: r.status, host: r.host, database: r.database,
      createdAt: r.createdAt, samePassword: stored.password === creds.password,
    });
  }
  return out;
}

/** True when another live data source still uses this secret (do not delete it). */
export async function secretStillInUse(secretArn: string, exceptSourceId: string): Promise<boolean> {
  const n = await prisma.mcpDataSource.count({
    where: { secretArn, status: { not: 'RETIRED' }, id: { not: exceptSourceId } },
  });
  return n > 0;
}
