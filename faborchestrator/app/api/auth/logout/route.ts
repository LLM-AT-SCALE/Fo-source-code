import { deleteSession, getSessionByToken } from '@/shared/lib/storage';
import { recordLogout } from '@/shared/lib/session-audit';
import { logger } from '@/shared/lib/logger';

export async function POST(req: Request) {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return Response.json(
        { error: 'No token provided' },
        { status: 401 }
      );
    }

    const token = authHeader.slice(7);

    // Find session to get userId before deleting
    const session = await getSessionByToken(token);
    const userId = session?.user?.id;

    // REQ-02 — close the user_session_logs row before deleting Session.
    recordLogout(token).catch((e) => logger.fabOrchError(e, { route: '/api/auth/logout' }));

    // Delete the session
    const deleted = await deleteSession(token);

    if (!deleted) {
      return Response.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Audit log (fire-and-forget)
    if (userId) {
      const { prisma: db } = await import('@/shared/lib/db');
      db.auditLog.create({
        data: { userId, action: 'user.logout', targetType: 'User', targetId: userId },
      }).catch(() => {});
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    return Response.json(
      { error: 'Failed to logout' },
      { status: 500 }
    );
  }
}
