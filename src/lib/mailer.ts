// The workspace's outgoing email. 1.20.31: by the method chosen under
// Settings → Notifications → Email (lib/mail-config): SMTP (a thin
// nodemailer wrapper over lib/smtp-config, as before) or Microsoft 365
// (lib/mail-m365: the same message, built by nodemailer, posted to Graph's
// sendMail as the one sending mailbox). Every caller goes through sendMail
// or, for mail that needs its own headers (the helpdesk), workspaceTransport.
// Server-only.

import "server-only";
import nodemailer from "nodemailer";
import { getSmtpConfig, smtpConfigured, type SmtpConfig } from "./smtp-config";
import { getMailMethod, getM365SendConfig, m365SendConfigured, workspaceFrom } from "./mail-config";
import { MAIL_NOT_SET_UP, type MailMethod } from "./mail-m365-shared";
import { buildMime, sendMimeM365, sendViaM365, type OutgoingMail } from "./mail-m365";

export type { OutgoingMail };

export interface SendMailInput {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  /** Override the configured From (newsletters with a chosen sender). */
  fromOverride?: string;
  /** Real MIME attachments (newsletter files). */
  attachments?: { filename: string; path: string }[];
}

function smtpTransportFor(cfg: SmtpConfig) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure === "tls",
    ignoreTLS: cfg.secure === "none",
    requireTLS: cfg.secure === "starttls",
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 8000,
    socketTimeout: 10000,
  });
}

/** Send one email with a given method (the settings page's test of the method on screen). Throws with a useful message. */
export async function sendMailWith(method: MailMethod, m: SendMailInput): Promise<void> {
  if (method === "m365") {
    await sendViaM365(m);
    return;
  }
  const cfg = await getSmtpConfig();
  if (!smtpConfigured(cfg)) throw new Error(MAIL_NOT_SET_UP);
  await smtpTransportFor(cfg).sendMail({
    from: m.fromOverride || cfg.from,
    to: m.to.join(", "),
    subject: m.subject,
    text: m.text,
    html: m.html,
    attachments: m.attachments?.length ? m.attachments : undefined,
  });
}

/** Send one email to a list of recipients, by the chosen method. Throws with a useful message. */
export async function sendMail(
  to: string[],
  subject: string,
  text: string,
  html?: string,
  /** Override the configured From (newsletters with a chosen sender). */
  fromOverride?: string,
  /** Real MIME attachments (newsletter files). */
  attachments?: { filename: string; path: string }[]
): Promise<void> {
  await sendMailWith(await getMailMethod(), { to, subject, text, html, fromOverride, attachments });
}

/**
 * The chosen method as a transport for mail that carries its own headers
 * (the helpdesk: Reply-To, Message-ID, References). `from` is the
 * workspace's own From. Null when the chosen method is not set up.
 */
export async function workspaceTransport(): Promise<{ method: MailMethod; from: string; send: (m: OutgoingMail) => Promise<void> } | null> {
  const method = await getMailMethod();
  if (method === "m365") {
    const cfg = await getM365SendConfig();
    if (!m365SendConfigured(cfg)) return null;
    return { method, from: await workspaceFrom(), send: async (m) => sendMimeM365(await buildMime(m), cfg) };
  }
  const cfg = await getSmtpConfig();
  if (!smtpConfigured(cfg)) return null;
  const transport = smtpTransportFor(cfg);
  return {
    method,
    from: cfg.from,
    send: async (m) => {
      await transport.sendMail({
        from: m.from,
        to: Array.isArray(m.to) ? m.to.join(", ") : m.to,
        cc: m.cc,
        replyTo: m.replyTo,
        subject: m.subject,
        text: m.text,
        html: m.html,
        messageId: m.messageId,
        references: m.references,
        headers: m.headers,
        attachments: m.attachments?.length ? m.attachments : undefined,
      });
    },
  };
}
