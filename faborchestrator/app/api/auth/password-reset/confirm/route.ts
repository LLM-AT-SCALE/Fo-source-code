/**
 * POST /api/auth/password-reset/confirm
 * Confirm password reset with DB-backed token.
 */

import { prisma } from '@/shared/lib/db';
import { hashPassword } from '@/shared/lib/encryption';

export async function POST(req: Request) {
  try {
    const { token, newPassword } = await req.json();

    if (!token || !newPassword) {
      return Response.json({ error: 'Token and new password are required' }, { status: 400 });
    }
    if (newPassword.length < 8) {
      return Response.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    }

    const resetToken = await prisma.passwordResetToken.findUnique({ where: { token } });
    if (!resetToken) {
      return Response.json({ error: 'Invalid or expired reset token' }, { status: 400 });
    }
    if (resetToken.usedAt) {
      return Response.json({ error: 'This reset token has already been used' }, { status: 400 });
    }
    if (resetToken.expiresAt < new Date()) {
      return Response.json({ error: 'Reset token has expired. Please request a new one.' }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email: resetToken.email } });
    if (!user) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }

    const passwordHash = await hashPassword(newPassword);

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, forcePasswordChange: false, passwordChangedAt: new Date() },
      });
      await tx.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usedAt: new Date() },
      });
      await tx.session.deleteMany({ where: { userId: user.id } });
      await tx.auditLog.create({
        data: { userId: user.id, action: 'user.password_reset', targetType: 'User', targetId: user.id, metadata: { email: user.email } },
      });
    });

    return Response.json({
      message: 'Password has been reset successfully. Please login with your new password.',
    });
  } catch (error) {
    console.error('Password reset confirm error:', error);
    return Response.json({ error: 'Failed to reset password' }, { status: 500 });
  }
}
