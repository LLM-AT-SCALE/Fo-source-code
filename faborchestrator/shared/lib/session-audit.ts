/**
 * FabOrch Audit — REQ-02 User Session Audit (single-clock model).
 *
 * One row per Session lifecycle. The interaction clock
 * (last_activity_at) is the single source of truth — it gets bumped
 * on every authenticated user-driven API call, and the same column
 * is checked for the 30-min idle eviction. No heartbeat, no
 * per-session "last used" column.
 *
 * Idle episode model: every gap between two activity bumps that
 * exceeds 60 seconds is appended to `idle_episodes` (JSONB array)
 * with {startedAt, endedAt, durationSeconds}. Aggregates kept in
 * `idle_episode_count` and `idle_seconds`. The 30-min eviction
 * itself appends a final 1800-second episode and closes the row.
 *
 * Uses raw SQL via Prisma — Prisma client cannot be regenerated under
 * the local Node 20.11 toolchain.
 */

import { createHash, randomUUID } from 'node:crypto';
import { prisma } from './db';

const IDLE_TIMEOUT_SEC = 1800;
const IDLE_EPISODE_THRESHOLD_SEC = 60;        // gap > 60s = recordable idle episode

export type SessionStatus =
  | 'ACTIVE'
  | 'CLOSED_LOGOUT'
  | 'CLOSED_IDLE'
  | 'CLOSED_ADMIN'
  | 'CLOSED_EXPIRED';

interface IdleEpisode {
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ────────────────────────────────────────────────────────────────
// Login / logout / admin-force / expired
// ────────────────────────────────────────────────────────────────

export async function recordLogin(params: {
  userId: string;
  sessionToken: string;
  loginIp?: string | null;
  loginUserAgent?: string | null;
}): Promise<string> {
  const id = randomUUID();
  const tokenHash = hashToken(params.sessionToken);
  await prisma.$executeRawUnsafe(
    `INSERT INTO "user_session_logs"
       (id, user_id, session_token_hash, login_time, last_activity_at,
        idle_seconds, idle_episodes, idle_episode_count,
        session_status, login_ip, login_user_agent, created_at)
     VALUES ($1, $2, $3, NOW(), NOW(),
             0, '[]'::jsonb, 0,
             'ACTIVE', $4, $5, NOW())`,
    id,
    params.userId,
    tokenHash,
    params.loginIp ?? null,
    params.loginUserAgent ?? null
  );
  return id;
}

async function closeActiveSession(params: {
  sessionToken: string;
  status: Exclude<SessionStatus, 'ACTIVE'>;
  reason?: string;
  logoutTime?: Date;
}): Promise<boolean> {
  const tokenHash = hashToken(params.sessionToken);
  const result = await prisma.$executeRawUnsafe(
    `UPDATE "user_session_logs"
        SET session_status = $2::"session_status",
            logout_time    = COALESCE($4::timestamptz, NOW()),
            closed_reason  = COALESCE($3::text, $2::text)
      WHERE session_token_hash = $1
        AND session_status = 'ACTIVE'`,
    tokenHash,
    params.status,
    params.reason ?? null,
    params.logoutTime ?? null
  );
  return Number(result) > 0;
}

export const recordLogout = (sessionToken: string) =>
  closeActiveSession({ sessionToken, status: 'CLOSED_LOGOUT', reason: 'logout' });

export const recordExpired = (sessionToken: string, expiresAt?: Date | null) =>
  closeActiveSession({
    sessionToken,
    status: 'CLOSED_EXPIRED',
    reason: 'absolute_expiry',
    logoutTime: expiresAt ? new Date(expiresAt) : undefined,
  });

export async function closeAllUserSessions(params: {
  userId: string;
  status: Exclude<SessionStatus, 'ACTIVE'>;
  reason?: string;
}): Promise<number> {
  const result = await prisma.$executeRawUnsafe(
    `UPDATE "user_session_logs"
        SET session_status = $2::"session_status",
            logout_time    = NOW(),
            closed_reason  = COALESCE($3::text, $2::text)
      WHERE user_id = $1
        AND session_status = 'ACTIVE'`,
    params.userId,
    params.status,
    params.reason ?? null
  );
  return Number(result);
}

// ────────────────────────────────────────────────────────────────
// Idle eviction + activity bump (single hot path)
// ────────────────────────────────────────────────────────────────

export type ActivityResult =
  | { status: 'active' }                                // session valid, activity bumped
  | { status: 'evicted'; logoutTime: Date }             // 30-min threshold crossed; row closed
  | { status: 'not_found' };                            // no matching ACTIVE log row (legacy session)

/**
 * Single hot-path call from auth-middleware on every authenticated
 * request. Atomically:
 *   1. Looks up the matching ACTIVE row by token hash.
 *   2. If gap since last_activity_at > 30 min  → CLOSED_IDLE,
 *      logout_time = last_activity + 30 min, append final episode.
 *      Returns 'evicted' so middleware can 401 the request.
 *   3. Else                                    → bump last_activity_at,
 *      if gap > 60 s append idle episode + counters.
 *      Returns 'active' so middleware lets the request through.
 *   4. No matching row (legacy pre-REQ-02 session) → 'not_found',
 *      middleware lets the request through unchanged.
 *
 * Two SELECT/UPDATE round-trips. No race because we fix on the row
 * id we read in step 1; if a concurrent request sneaks in, the
 * UPDATE's WHERE clause filters by id+ACTIVE so only one path wins.
 */
export async function checkAndRecordActivity(
  sessionToken: string,
  /**
   * Optional context for the lazy-create path. When the token is valid
   * (sessions row exists) but no matching ACTIVE audit row is found,
   * we now lazy-create one so the 30-min idle eviction can take effect
   * from this moment forward — instead of letting the request through
   * unchecked the way the old `not_found` branch did.
   *
   * If `userId` is omitted (e.g. legacy callers), we fall through to
   * the historical 'not_found' behaviour, so existing call sites stay
   * safe.
   */
  ctx?: { userId?: string | null; loginIp?: string | null; loginUserAgent?: string | null }
): Promise<ActivityResult> {
  const tokenHash = hashToken(sessionToken);

  // Step 1: read current state.
   
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id,
            last_activity_at,
            CAST(EXTRACT(EPOCH FROM (NOW() - last_activity_at)) AS INTEGER) AS gap_seconds
       FROM "user_session_logs"
      WHERE session_token_hash = $1 AND session_status = 'ACTIVE'
      LIMIT 1`,
    tokenHash
  )) as Array<{ id: string; last_activity_at: Date; gap_seconds: number }>;

  if (rows.length === 0) {
    // No ACTIVE audit row — but the caller already verified the token
    // is in the `sessions` table, so the session itself is legitimate.
    // The user just landed here with a stale token from an earlier
    // login that's already been closed in the audit table. Lazy-create
    // a fresh ACTIVE row so future eviction works.
    if (ctx?.userId) {
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "user_session_logs"
             (id, user_id, session_token_hash, login_time, last_activity_at,
              session_status, login_ip, login_user_agent, idle_episodes,
              idle_episode_count, idle_seconds, created_at)
           VALUES ($1, $2, $3, NOW(), NOW(),
                   'ACTIVE'::"session_status", $4, $5, '[]'::jsonb,
                   0, 0, NOW())`,
          randomUUID(),
          ctx.userId,
          tokenHash,
          ctx.loginIp ?? null,
          ctx.loginUserAgent ?? null,
        );
        return { status: 'active' };
      } catch {
        // Race: another concurrent request beat us to it. Fall through
        // — next request will find the ACTIVE row and behave normally.
        return { status: 'active' };
      }
    }
    return { status: 'not_found' };
  }

  const { id, last_activity_at: _last_activity_at, gap_seconds } = rows[0];

  // Step 2a: idle eviction.
  if (gap_seconds > IDLE_TIMEOUT_SEC) {
     
    const out = (await prisma.$queryRawUnsafe(
      `UPDATE "user_session_logs"
          SET session_status      = 'CLOSED_IDLE',
              logout_time         = last_activity_at + INTERVAL '${IDLE_TIMEOUT_SEC} seconds',
              closed_reason       = 'idle_timeout',
              idle_episodes       = idle_episodes || jsonb_build_object(
                'startedAt',       to_char(last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'endedAt',         to_char((last_activity_at + INTERVAL '${IDLE_TIMEOUT_SEC} seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'durationSeconds', ${IDLE_TIMEOUT_SEC}
              ),
              idle_episode_count  = idle_episode_count + 1,
              idle_seconds        = idle_seconds + ${IDLE_TIMEOUT_SEC}
        WHERE id = $1 AND session_status = 'ACTIVE'
       RETURNING logout_time`,
      id
    )) as Array<{ logout_time: Date }>;
    if (out.length === 0) return { status: 'not_found' }; // raced; treat as not_found
    return { status: 'evicted', logoutTime: out[0].logout_time };
  }

  // Step 2b: normal activity bump (with optional idle-episode capture).
  await prisma.$executeRawUnsafe(
    `UPDATE "user_session_logs"
        SET last_activity_at = NOW(),
            idle_episodes = CASE
              WHEN EXTRACT(EPOCH FROM (NOW() - last_activity_at)) > ${IDLE_EPISODE_THRESHOLD_SEC}
              THEN idle_episodes || jsonb_build_object(
                'startedAt',       to_char(last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'endedAt',         to_char(NOW() AT TIME ZONE 'UTC',           'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'durationSeconds', CAST(EXTRACT(EPOCH FROM (NOW() - last_activity_at)) AS INTEGER)
              )
              ELSE idle_episodes
            END,
            idle_episode_count = idle_episode_count + CASE
              WHEN EXTRACT(EPOCH FROM (NOW() - last_activity_at)) > ${IDLE_EPISODE_THRESHOLD_SEC} THEN 1 ELSE 0
            END,
            idle_seconds = idle_seconds + CASE
              WHEN EXTRACT(EPOCH FROM (NOW() - last_activity_at)) > ${IDLE_EPISODE_THRESHOLD_SEC}
              THEN CAST(EXTRACT(EPOCH FROM (NOW() - last_activity_at)) AS INTEGER)
              ELSE 0
            END
      WHERE id = $1 AND session_status = 'ACTIVE'`,
    id
  );
  return { status: 'active' };
}

/**
 * Called explicitly from chat-stream onFinish to bump activity once
 * the response has finished streaming (a multi-minute response
 * shouldn't count as one activity event at minute 0 only).
 *
 * Same logic as checkAndRecordActivity but doesn't 401; if the
 * session was already idle-evicted concurrently, returns silently.
 */
export async function bumpActivityIfActive(sessionToken: string): Promise<void> {
  const r = await checkAndRecordActivity(sessionToken);
  // Caller doesn't need to know — the stream has already returned.
  void r;
}

// ────────────────────────────────────────────────────────────────
// Reconciler — close stale ACTIVE rows when admin queries land.
// Runs at the top of every querySessionLogs() so chat answers are
// always honest even if no request from the user has arrived to
// trigger eviction.
// ────────────────────────────────────────────────────────────────

async function reconcileStaleActiveSessions(): Promise<{ idle: number }> {
  // Every session follows the same idle policy now that admin is a module
  // of this app, so the reconciler no longer skips admins. Two passes:
  //   1. UPDATE the stale audit rows to CLOSED_IDLE, capturing the
  //      session_token_hash of each via RETURNING.
  //   2. DELETE the matching live `sessions` rows so the user's browser
  //      actually gets 401 on its next request — without this the
  //      admin's "logged out" answer would be a lie until the user
  //      themselves came back and tripped the auth-middleware path.
  const evicted = (await prisma.$queryRawUnsafe(
    `UPDATE "user_session_logs" l
        SET session_status = 'CLOSED_IDLE',
            logout_time    = l.last_activity_at + INTERVAL '${IDLE_TIMEOUT_SEC} seconds',
            closed_reason  = 'idle_timeout (lazy reconcile)',
            idle_episodes  = l.idle_episodes || jsonb_build_object(
              'startedAt',       to_char(l.last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'endedAt',         to_char((l.last_activity_at + INTERVAL '${IDLE_TIMEOUT_SEC} seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              'durationSeconds', ${IDLE_TIMEOUT_SEC}
            ),
            idle_episode_count = l.idle_episode_count + 1,
            idle_seconds       = l.idle_seconds + ${IDLE_TIMEOUT_SEC}
       FROM "users" u
      WHERE u.id = l.user_id
        AND l.session_status = 'ACTIVE'
        AND l.last_activity_at < NOW() - INTERVAL '${IDLE_TIMEOUT_SEC} seconds'
   RETURNING l.session_token_hash`
  )) as Array<{ session_token_hash: string | null }>;

  const hashes = evicted.map((r) => r.session_token_hash).filter((h): h is string => !!h);
  if (hashes.length > 0) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "sessions"
        WHERE encode(sha256(token::bytea), 'hex') = ANY($1::text[])`,
      hashes
    );
  }

  return { idle: evicted.length };
}

// ────────────────────────────────────────────────────────────────
// Admin-side queries
// ────────────────────────────────────────────────────────────────

export interface SessionQueryFilters {
  userId?: string | null;
  email?: string | null;
  nameLike?: string | null;
  userKey?: string | null;
  dateFrom?: Date | null;
  dateTo?: Date | null;
  status?: 'active' | 'closed' | 'all';
  idleMinutesGt?: number | null;
  limit?: number;
}

export interface SessionQueryRow {
  id: string;
  userId: string;
  userName: string | null;
  userEmail: string;
  loginTime: Date;
  logoutTime: Date | null;
  sessionDurationSeconds: number;
  idleSeconds: number;
  activeSeconds: number;
  idleEpisodes: IdleEpisode[];
  idleEpisodeCount: number;
  currentIdleSeconds: number;
  isIdleNow: boolean;
  engagementLabel: string;
  sessionStatus: SessionStatus;
  closedReason: string | null;
  loginIp: string | null;
}

function humanGap(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m} min ${s} sec` : `${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm > 0 ? `${h} hr ${mm} min` : `${h} hr`;
}

function buildEngagementLabel(args: {
  status: SessionStatus;
  currentIdle: number;
  logoutTime: Date | null;
}): string {
  if (args.status !== 'ACTIVE') {
    const closedAt = args.logoutTime
      ? new Date(args.logoutTime).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
      : 'unknown time';
    if (args.status === 'CLOSED_LOGOUT') return `Not currently logged in (logged out at ${closedAt})`;
    if (args.status === 'CLOSED_IDLE') return `Not currently logged in (idle-evicted at ${closedAt})`;
    if (args.status === 'CLOSED_ADMIN') return `Not currently logged in (admin force-logout at ${closedAt})`;
    if (args.status === 'CLOSED_EXPIRED') return `Not currently logged in (session expired at ${closedAt})`;
    return `Not currently logged in`;
  }
  if (args.currentIdle > 60) return `Idle right now (last interaction ~${humanGap(args.currentIdle)} ago)`;
  return `Actively engaged (last interaction ${humanGap(args.currentIdle)} ago)`;
}

export async function querySessionLogs(
  filters: SessionQueryFilters
): Promise<SessionQueryRow[]> {
  // Self-heal stale rows so the read is honest.
  await reconcileStaleActiveSessions().catch(() => {});

  const limit = Math.min(Math.max(1, filters.limit ?? 100), 1000);
  const conds: string[] = [];
  const values: unknown[] = [];
  const push = (sql: string, v: unknown) => {
    values.push(v);
    conds.push(sql.replace('$?', `$${values.length}`));
  };

  if (filters.userId) push(`l.user_id = $?`, filters.userId);
  if (filters.email) push(`u.email = $?`, filters.email.toLowerCase());
  if (filters.nameLike) push(`u.name ILIKE $?`, `%${filters.nameLike}%`);
  if (filters.userKey) {
    const key = `%${filters.userKey}%`;
    values.push(key, key, key);
    const a = `$${values.length - 2}`,
      b = `$${values.length - 1}`,
      c = `$${values.length}`;
    conds.push(
      `(u.name ILIKE ${a} OR u.email ILIKE ${b} OR split_part(u.email, '@', 1) ILIKE ${c})`
    );
  }
  if (filters.dateFrom) push(`l.login_time >= $?`, filters.dateFrom);
  if (filters.dateTo) push(`l.login_time <= $?`, filters.dateTo);
  if (filters.status === 'active') conds.push(`l.session_status = 'ACTIVE'`);
  else if (filters.status === 'closed') conds.push(`l.session_status <> 'ACTIVE'`);
  if (typeof filters.idleMinutesGt === 'number') {
    conds.push(
      `(l.session_status = 'ACTIVE'
         AND EXTRACT(EPOCH FROM (NOW() - l.last_activity_at)) > ${Math.floor(filters.idleMinutesGt * 60)})`
    );
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const sql = `
    SELECT l.id, l.user_id, u.name AS user_name, u.email AS user_email,
           l.login_time, l.logout_time,
           CASE
             WHEN l.session_status = 'ACTIVE'
               THEN CAST(EXTRACT(EPOCH FROM (NOW() - l.login_time)) AS INTEGER)
             ELSE CAST(EXTRACT(EPOCH FROM (l.logout_time - l.login_time)) AS INTEGER)
           END AS session_duration_seconds,
           l.idle_seconds,
           l.idle_episodes,
           l.idle_episode_count,
           CASE
             WHEN l.session_status = 'ACTIVE'
               THEN CAST(EXTRACT(EPOCH FROM (NOW() - l.last_activity_at)) AS INTEGER)
             ELSE 0
           END AS current_idle_seconds,
           l.session_status, l.closed_reason, l.login_ip
      FROM "user_session_logs" l
      JOIN "users" u ON u.id = l.user_id
      ${where}
     ORDER BY l.login_time DESC
     LIMIT ${limit}
  `;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await prisma.$queryRawUnsafe(sql, ...values)) as any[];
  return rows.map((r) => {
    const dur = Number(r.session_duration_seconds || 0);
    const idle = Number(r.idle_seconds || 0);
    const currentIdle = Number(r.current_idle_seconds || 0);
    const status = r.session_status as SessionStatus;
    const episodes = Array.isArray(r.idle_episodes) ? (r.idle_episodes as IdleEpisode[]) : [];
    return {
      id: r.id,
      userId: r.user_id,
      userName: r.user_name,
      userEmail: r.user_email,
      loginTime: r.login_time,
      logoutTime: r.logout_time,
      sessionDurationSeconds: dur,
      idleSeconds: idle,
      activeSeconds: Math.max(0, dur - idle),
      idleEpisodes: episodes,
      idleEpisodeCount: Number(r.idle_episode_count || 0),
      currentIdleSeconds: currentIdle,
      isIdleNow: status === 'ACTIVE' && currentIdle > 60,
      engagementLabel: buildEngagementLabel({
        status,
        currentIdle,
        logoutTime: r.logout_time,
      }),
      sessionStatus: status,
      closedReason: r.closed_reason,
      loginIp: r.login_ip,
    };
  });
}

export async function purgeOldSessionLogs(): Promise<number> {
  const result = await prisma.$executeRawUnsafe(
    `DELETE FROM "user_session_logs"
      WHERE login_time < NOW() - INTERVAL '90 days'`
  );
  return Number(result);
}
