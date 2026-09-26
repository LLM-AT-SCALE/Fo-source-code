/**
 * SMTP Email Transport - Nodemailer
 */

import nodemailer from 'nodemailer';

const SMTP_SERVER = process.env.SMTP_SERVER;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USERNAME = process.env.SMTP_USERNAME;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;

const SMTP_FROM = process.env.SMTP_FROM_EMAIL
  ? `LLMatscale.ai <${process.env.SMTP_FROM_EMAIL}>`
  : null;

const smtpTransport = (SMTP_SERVER && SMTP_USERNAME && SMTP_PASSWORD)
  ? nodemailer.createTransport({
      host: SMTP_SERVER,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: {
        user: SMTP_USERNAME,
        pass: SMTP_PASSWORD,
      },
    })
  : null;

/**
 * Send an email via SMTP.
 * Returns true if sent, false if SMTP not configured.
 */
export async function sendSmtpEmail(params: {
  to: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  if (!smtpTransport || !SMTP_FROM) {
    return false;
  }

  await smtpTransport.sendMail({
    from: SMTP_FROM,
    to: params.to,
    subject: params.subject,
    html: params.html,
  });

  return true;
}
