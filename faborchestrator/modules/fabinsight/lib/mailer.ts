import { withCapture } from "@/shared/lib/errors/capture";
/**
 * Shared SMTP sender (nodemailer) for FabInsight notifications — discrepancy
 * alerts, shift summaries, and scheduled-refresh failure notices all use this.
 * Same env as the password-reset flow: SMTP_SERVER/PORT/USERNAME/PASSWORD/FROM_EMAIL.
 */
export async function sendMail(to: string[], subject: string, html: string, fromName = "FabOrchestrator"): Promise<boolean> {
  const host = process.env.SMTP_SERVER;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USERNAME;
  const pass = process.env.SMTP_PASSWORD;
  const from = process.env.SMTP_FROM_EMAIL;
  if (!host || !user || !pass || !from) {
    console.warn("[mailer] SMTP not configured (SMTP_SERVER/USERNAME/PASSWORD/FROM_EMAIL) — skipping email");
    return false;
  }
  if (!to.length) {
    console.warn("[mailer] no recipients resolved — skipping email");
    return false;
  }
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.default.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  // SMTP tells you exactly what it rejected — a bad password, an unverified
  // sender, a blocked port. Capturing it means a failed alert leaves a record
  // instead of disappearing into a background job nobody watches.
  await withCapture(
    {
      system: "Email (SMTP)",
      operation: "sendMail",
      target: `${host}:${port}`,
      // Subject and recipient COUNT only: addresses and bodies stay out of the
      // error record.
      extra: { recipients: to.length, subject },
    },
    () =>
      transport.sendMail({ from: `${fromName} <${from}>`, to: to.join(", "), subject, html }),
  );
  return true;
}
