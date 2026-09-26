import { PrismaClient } from '@/lib/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

// Create PostgreSQL connection pool
// SSL is disabled for both local and AWS RDS (POC mode)
//
// Hardened against the "silent wedge" outage class: an unbounded pool with no
// acquire timeout meant that once every connection was busy (a slow query, a
// leak, or a burst), every subsequent request awaited pool.connect() FOREVER —
// the process stayed alive but served nothing until a manual restart-app-server
// (prod incidents 2026-08-10 and 2026-08-19). The settings below make the app
// fail fast and self-recover instead:
//   • connectionTimeoutMillis — a request that can't get a connection within
//     10s errors (and the user can retry) rather than hanging the whole app.
//   • statement_timeout / query_timeout — a runaway query is killed at ~30s so
//     it can't hold a connection (and starve the pool) indefinitely.
//   • idleTimeoutMillis — release idle connections back to RDS.
//   • max — explicit ceiling with headroom for the in-app scheduler + users.
// Overridable via env without a code change.
const connectionPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
  max: Number(process.env.PG_POOL_MAX ?? "15"),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? "30000"),
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? "10000"),
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? "30000"),
  query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS ?? "30000"),
});

// Create Prisma adapter for PostgreSQL
const adapter = new PrismaPg(connectionPool);

// PrismaClient singleton for Next.js
// Prevents multiple instances during development hot reload

const globalForPrisma = globalThis as unknown as {
  prisma: InstanceType<typeof PrismaClient> | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
