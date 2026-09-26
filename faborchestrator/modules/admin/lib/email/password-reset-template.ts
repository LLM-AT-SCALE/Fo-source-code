/**
 * Password Reset Email HTML Template
 */

export function buildPasswordResetEmailHtml(params: {
  userName: string;
  resetUrl: string;
  expiresInMinutes?: number;
  expiresInDays?: number;
}): string {
  const { userName, resetUrl, expiresInMinutes, expiresInDays } = params;
  const expiryText = expiresInDays ? `${expiresInDays} days` : `${expiresInMinutes || 60} minutes`;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f6f9fc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f9fc;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;">
          <!-- Header -->
          <tr>
            <td style="background:#1a3a2a;padding:24px 32px;">
              <span style="color:#fff;font-size:18px;font-weight:600;">LLMatscale.ai</span>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px 32px;">
              <h1 style="color:#171717;font-size:24px;font-weight:600;margin:0 0 16px;">
                Reset your password
              </h1>
              <p style="color:#484848;font-size:16px;line-height:26px;margin:0 0 8px;">
                Hi ${userName || 'there'},
              </p>
              <p style="color:#484848;font-size:16px;line-height:26px;margin:0 0 32px;">
                We received a request to reset your password. Click the button below to choose a new one.
              </p>
              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center">
                    <a href="${resetUrl}" style="background:#1a3a2a;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;display:inline-block;font-size:16px;font-weight:600;">
                      Reset Password
                    </a>
                  </td>
                </tr>
              </table>
              <p style="color:#898989;font-size:13px;line-height:22px;margin:32px 0 0;">
                This link expires in ${expiryText}. If you didn't request a password reset, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:24px 32px;border-top:1px solid #e6ebf1;">
              <p style="color:#898989;font-size:12px;text-align:center;margin:0;">
                LLMatscale.ai &mdash; Secure, role-based access to AI
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}
