/**
 * "Your dashboard is live" email — sent to the requester when an admin
 * publishes their pinned dashboard. Plain HTML, same shell as the invitation mail.
 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildDashboardLiveEmailHtml(params: {
  requesterName: string | null;
  title: string;
  reportsUrl: string;
  /** "create" → a new dashboard; "extend" → an existing dashboard got a new version. */
  mode: "create" | "extend";
  expiresAt?: Date | null;
  scheduleText?: string | null;
}): string {
  const { requesterName, title, reportsUrl, mode, expiresAt, scheduleText } = params;
  const greeting = requesterName ? `Hi ${esc(requesterName)},` : "Hi,";
  const what =
    mode === "extend"
      ? `Your request <strong>${esc(title)}</strong> was approved and merged into an existing dashboard as a new version.`
      : `Your request <strong>${esc(title)}</strong> was approved and is now a live dashboard.`;
  const expiry = expiresAt ? `<p style="color:#484848;font-size:14px;line-height:22px;margin:0 0 8px;">It refreshes automatically until <strong>${esc(expiresAt.toUTCString())}</strong>. An admin can extend it before then.</p>` : "";
  const sched = scheduleText ? `<p style="color:#484848;font-size:14px;line-height:22px;margin:0 0 8px;">Refresh schedule: ${esc(scheduleText)}.</p>` : "";

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
          <tr>
            <td style="background:#1a3a2a;padding:24px 32px;">
              <span style="color:#fff;font-size:18px;font-weight:600;">FabOrchestrator</span>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 32px;">
              <h1 style="color:#171717;font-size:22px;font-weight:600;margin:0 0 16px;">Your dashboard is live</h1>
              <p style="color:#484848;font-size:16px;line-height:26px;margin:0 0 8px;">${greeting}</p>
              <p style="color:#484848;font-size:16px;line-height:26px;margin:0 0 16px;">${what}</p>
              ${sched}
              ${expiry}
              <table cellpadding="0" cellspacing="0" width="100%" style="margin-top:24px;">
                <tr>
                  <td align="center">
                    <a href="${esc(reportsUrl)}" style="background:#1a3a2a;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;display:inline-block;font-size:16px;font-weight:600;">
                      Open Reports
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background:#f6f9fc;padding:16px 32px;">
              <p style="color:#898989;font-size:12px;line-height:18px;margin:0;">You received this because you pinned a dashboard for scheduling in FabOrchestrator.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
