/**
 * Authentication Middleware for API routes
 * Provides utilities for validating sessions and protecting routes
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionByToken } from './storage';
import type { User, Role } from '@/lib/generated/prisma/client';
import { prisma } from './db';
import { checkAndRecordActivity, recordExpired } from './session-audit';
import { FabOrchError } from './errors/faborch-errors';
import { handleApiError } from './errors/api-error-handler';
import { logger } from './logger';
import { isPlatformAdmin } from '@/shared/lib/permissions';

interface AuthResult {
  authenticated: boolean;
  user?: User;
  error?: string;
  status?: number;
}

/**
 * Validate session token from Authorization header
 */
async function validateSession(req: NextRequest): Promise<AuthResult> {
  const authHeader = req.headers.get('Authorization');

  if (!authHeader) {
    return {
      authenticated: false,
      error: 'No authorization header provided',
      status: 401,
    };
  }

  if (!authHeader.startsWith('Bearer ')) {
    return {
      authenticated: false,
      error: 'Invalid authorization format. Use Bearer token',
      status: 401,
    };
  }

  const token = authHeader.slice(7);

  if (!token || token.length < 32) {
    return {
      authenticated: false,
      error: 'Invalid token format',
      status: 401,
    };
  }

  try {
    const session = await getSessionByToken(token);

    if (!session) {
      return {
        authenticated: false,
        error: 'Invalid or expired session',
        status: 401,
      };
    }

    // Absolute (30-day) expiry check.
    if (session.expiresAt < new Date()) {
      recordExpired(token, session.expiresAt).catch((e) =>
        logger.fabOrchError(e, { route: 'auth-middleware' })
      );
      return {
        authenticated: false,
        error: 'Your session has expired. Please log in again.',
        status: 401,
      };
    }

    // ── Single-clock activity + idle eviction (REQ-02 simplified) ──
    // user_session_logs.last_activity_at is the only signal. The helper
    // atomically:
    //   - evicts the row as CLOSED_IDLE if gap > 30 min (returns 'evicted'),
    //   - records an idle episode if gap > 60 s and bumps activity,
    //   - lazy-creates an ACTIVE audit row if the session token is
    //     valid but no ACTIVE row exists yet (covers users who came in
    //     with a stale token from an old login whose audit row was
    //     already closed — without this they'd never get evicted).
    // No heartbeat, no per-session "last used" column, no path check.
    // ──────────────────────────────────────────────────────────────
    const loginIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const loginUa = req.headers.get('user-agent') ?? null;
    const activityResult = await checkAndRecordActivity(token, {
      userId: session.user.id,
      loginIp,
      loginUserAgent: loginUa,
    }).catch((e) => {
      logger.fabOrchError(e, { route: 'auth-middleware' });
      return { status: 'not_found' as const };
    });
    if (activityResult.status === 'evicted') {
      try {
        const { deleteSession } = await import('./storage');
        await deleteSession(token);
      } catch (e) {
        logger.fabOrchError(e, { route: 'auth-middleware' });
      }
      return {
        authenticated: false,
        error: 'Your session has expired. Please log in again.',
        status: 401,
      };
    }

    return {
      authenticated: true,
      user: session.user,
    };
  } catch (error) {
    console.error('Session validation error:', error);
    return {
      authenticated: false,
      error: 'Failed to validate session',
      status: 500,
    };
  }
}

/**
 * Middleware helper for protected API routes
 * Use this in API route handlers that need authentication.
 * Also checks user status and forcePasswordChange flag.
 */
export async function requireAuth(
  req: NextRequest
): Promise<{ user: User } | NextResponse> {
  const auth = await validateSession(req);

  if (!auth.authenticated || !auth.user) {
    // Convert all 401 paths through the REQ-01 canonical envelope so the
    // client always sees the SESSION_TIMEOUT type+message shape.
    if ((auth.status || 401) === 401) {
      const fabErr = FabOrchError.sessionTimeout({ route: req.nextUrl.pathname });
      return handleApiError(fabErr, req);
    }
    return NextResponse.json(
      { error: auth.error || 'Unauthorized' },
      { status: auth.status || 401 }
    );
  }

  // Check if user is suspended or deleted (set in the Admin Console)
  const userStatus = (auth.user as User & { status?: string }).status;
  if (userStatus === 'SUSPENDED' || userStatus === 'DELETED') {
    return NextResponse.json(
      { error: 'Account is no longer active. Contact your administrator.' },
      { status: 403 }
    );
  }

  // Check if user must change password (set in the Admin Console)
  const pathname = req.nextUrl.pathname;
  if (
    (auth.user as User & { forcePasswordChange?: boolean }).forcePasswordChange &&
    !pathname.endsWith('/change-password') &&
    !pathname.endsWith('/logout')
  ) {
    return NextResponse.json(
      {
        error: 'Password change required',
        code: 'FORCE_PASSWORD_CHANGE',
        redirectTo: '/force-password-change',
      },
      { status: 403 }
    );
  }

  return { user: auth.user };
}

// ============================================
// Admin Auth
// ============================================

export interface AdminAuthContext {
  user: User & { role: Role | null };
}

/**
 * Same session checks as requireAuth (idle eviction, status, forced password
 * change), then requires the admin flag. Returns the user with their role so
 * admin routes can read permissions without a second query.
 */
export async function requireAdmin(
  req: NextRequest
): Promise<AdminAuthContext | NextResponse> {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  if (auth.user.status !== 'ACTIVE') {
    return NextResponse.json({ error: 'Account suspended' }, { status: 403 });
  }

  const userWithRole = await prisma.user.findUnique({
    where: { id: auth.user.id },
    include: { role: true },
  });
  if (!userWithRole) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }
  // The bootstrap flag, the built-in Admin role, or any role carrying `admin`.
  if (!isPlatformAdmin(userWithRole)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }
  return { user: userWithRole };
}

// ============================================
// IP Address Helper
// ============================================

export function getIpAddress(req: NextRequest): string | null {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    null
  );
}
