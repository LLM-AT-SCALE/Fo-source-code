/**
 * POST /api/auth/password-reset
 * Request a password reset email. Uses DB-backed tokens + SMTP.
 */

import { prisma } from '@/shared/lib/db';
import { generateToken } from '@/shared/lib/encryption';

const RESET_EXPIRY_MINUTES = 60;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { email } = body;

    if (!email) {
      return Response.json({ error: 'Email is required' }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    // No account or deleted account
    if (!user || (user as { status?: string }).status === 'DELETED') {
      return Response.json({
        error: 'No active account found with this email address.',
      }, { status: 404 });
    }

    // Suspended account
    if ((user as { status?: string }).status === 'SUSPENDED') {
      return Response.json({
        error: 'This account has been suspended. Contact your administrator.',
      }, { status: 403 });
    }

    // Active user — send reset email
    {
      const token = generateToken(32);
      const expiresAt = new Date(Date.now() + RESET_EXPIRY_MINUTES * 60 * 1000);

      await prisma.passwordResetToken.create({
        data: { email: user.email, token, expiresAt },
      });

      // Audit log
      prisma.auditLog.create({
        data: { userId: user.id, action: 'user.password_reset_requested', targetType: 'User', targetId: user.id, metadata: { email: user.email } },
      }).catch(() => {});

      const APP_URL = process.env.APP_URL || 'http://localhost:3000';
      const resetUrl = `${APP_URL}/reset-password?token=${token}`;

      // Try SMTP
      try {
        const nodemailer = await import('nodemailer');
        const SMTP_SERVER = process.env.SMTP_SERVER;
        const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
        const SMTP_USERNAME = process.env.SMTP_USERNAME;
        const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
        const SMTP_FROM = process.env.SMTP_FROM_EMAIL;

        if (SMTP_SERVER && SMTP_USERNAME && SMTP_PASSWORD && SMTP_FROM) {
          const transport = nodemailer.default.createTransport({
            host: SMTP_SERVER,
            port: SMTP_PORT,
            secure: SMTP_PORT === 465,
            auth: { user: SMTP_USERNAME, pass: SMTP_PASSWORD },
          });

          await transport.sendMail({
            from: `LLMatscale.ai <${SMTP_FROM}>`,
            to: user.email,
            subject: 'Reset your password - LLMatscale.ai',
            html: `
              <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:40px 20px;">
                <h2 style="color:#171717;">Reset your password</h2>
                <p>Hi ${user.name || 'there'},</p>
                <p>Click the button below to reset your password. This link expires in ${RESET_EXPIRY_MINUTES} minutes.</p>
                <p style="text-align:center;margin:32px 0;">
                  <a href="${resetUrl}" style="background:#D97757;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;">Reset Password</a>
                </p>
                <p style="color:#888;font-size:13px;">If you didn't request this, ignore this email.</p>
                <hr style="border:none;border-top:1px solid #eee;margin:32px 0;">
                <p style="color:#888;font-size:12px;text-align:center;">LLMatscale.ai</p>
              </div>
            `,
          });
          console.log('[SMTP] Password reset email sent to:', user.email);
        } else {
          console.log('[DEV] Password reset link:', resetUrl);
        }
      } catch (err) {
        console.error('[SMTP] Failed:', err);
        console.log('[DEV] Password reset link:', `http://localhost:3000/reset-password?token=${token}`);
      }
    }

    return Response.json({
      message: 'Password reset instructions have been sent to your email.',
    });
  } catch (error) {
    console.error('Password reset error:', error);
    return Response.json({ error: 'Failed to process request' }, { status: 500 });
  }
}
