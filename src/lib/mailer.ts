// The workspace's outgoing email. 1.20.31: by the method chosen under
// Settings → Notifications → Email (lib/mail-config): SMTP (a thin
// nodemailer wrapper over lib/smtp-config, as before) or Microsoft 365
// (lib/mail-m365: the same message, built by nodemailer, posted to Graph's
// sendMail as the one sending mailbox). Every caller goes through sendMail
// or, for mail that needs its own headers (the helpdesk), workspaceTransport.
//
// 1.20.32: through Microsoft 365 both QUEUE the message in the outbox
// (lib/mail-outbox) and return: a paced worker sends it under Exchange's
// limits, urgent mail first, so nothing is dropped when Microsoft asks to
// slow down. A message too large, or a method that is not set up, is still
// refused at once. SMTP sends on the spot, exactly as before. The test
// emails (sendMailWith, `direct`, workspaceTransport's sendNow) stay direct
// and synchronous, so the admin sees Microsoft's answer at once.
//
// 1.21.5: Azure Communication Services (lib/mail-acs, the operator's
// COMPASSDOCS_MAIL_TRANSPORT=acs) works as Microsoft 365 does: the same
// message is built, queued in the outbox and sent paced; the direct sends
// stay direct (a test email waits up to 30 seconds for ACS's result). From
// is always the platform's MailFrom address; a chosen sender, or a help
// address, becomes Reply-To (lib/mail-acs-mime).
// Server-only.

import "server-only";
import nodemailer from "nodemailer";
import { getSmtpConfig, smtpConfigured, type SmtpConfig } from "./smtp-config";
import { getMailMethod, getM365SendConfig, m365SendConfigured, workspaceFrom, SECRET_UNREADABLE } from "./mail-config";
import { MAIL_NOT_SET_UP, type MailMethod } from "./mail-m365-shared";
import { MailSendError, buildMime, mimeForM365, sendMimeM365, sendViaM365, type OutgoingMail } from "./mail-m365";
import type { OutboxMeta } from "./mail-outbox";
import { mailAttachmentsForSend, type MailAttachment } from "./uploads";
import { countMail, telemetryHooks } from "./telemetry-hooks";
import { acsConfig } from "./mail-acs-config";

export type { OutgoingMail, OutboxMeta };

export interface SendMailInput {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  /** Override the configured From (newsletters with a chosen sender). */
  fromOverride?: string;
  /** Real MIME attachments (newsletter files). */
  attachments?: MailAttachment[];
}

export interface SendMailOptions extends OutboxMeta {
  /**
   * Send now, in this call, even through Microsoft 365 (the test emails, and
   * a newsletter's recipient, which is paced by its own job): Microsoft's
   * answer is the caller's.
   */
  direct?: boolean;
  /** With `direct`: don't wait out a 429 inside the send (the caller pauses instead). */
  noWait?: boolean;
}

/** 1.21.5: one message now through Azure Communication Services (`waitResult`: the sender is watching, so ACS's result is waited for). */
async function sendNowAcs(mime: Buffer, rcpt: string[], opts: { wait429?: boolean; waitResult?: boolean } = {}): Promise<void> {
  const cfg = acsConfig();
  if (!cfg) throw new MailSendError(MAIL_NOT_SET_UP, 0, "not_set_up");
  const { sendAcsNow } = await import("./mail-acs");
  const { addressList } = await import("./mail-outbox");
  const { effectiveReplyTo } = await import("./mail-config");
  try {
    await sendAcsNow(mime, { config: cfg, rcpt: addressList(rcpt), replyTo: await effectiveReplyTo(), wait429: opts.wait429, waitResult: opts.waitResult });
    countMail("acs", true);
  } catch (e) {
    countMail("acs", false);
    throw e;
  }
}

/** sendMail's message for Azure Communication Services: From the platform's sender (a chosen sender is kept as From's address, which lib/mail-acs-mime turns into Reply-To). */
async function mimeForAcs(m: SendMailInput): Promise<Buffer> {
  const sender = acsConfig()?.sender ?? "";
  return buildMime({ from: m.fromOverride || sender, to: m.to, subject: m.subject, text: m.text, html: m.html, attachments: m.attachments });
}

/**
 * An SMTP transport for the saved settings (also the outbox's, for rows left after a switch to SMTP).
 * 1.21.1: with telemetry on, each send is one "smtp send" span and counts as mail sent or failed.
 */
export function smtpTransportFor(cfg: SmtpConfig) {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure === "tls",
    ignoreTLS: cfg.secure === "none",
    requireTLS: cfg.secure === "starttls",
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 8000,
    socketTimeout: 10000,
  });
  const send = transport.sendMail.bind(transport) as (m: Parameters<typeof transport.sendMail>[0]) => Promise<unknown>;
  (transport as { sendMail: unknown }).sendMail = (m: Parameters<typeof transport.sendMail>[0]) => {
    const t = telemetryHooks();
    return t ? t.smtp({ host: cfg.host, port: cfg.port }, () => send(m)) : send(m);
  };
  return transport;
}

/** Send one email with a given method, now (the settings page's test of the method on screen). Throws with a useful message. */
export async function sendMailWith(method: MailMethod, m: SendMailInput, opts: { wait429?: boolean; waitResult?: boolean } = {}): Promise<void> {
  if (method === "acs") {
    await sendNowAcs(await mimeForAcs(m), m.to, opts);
    return;
  }
  if (method === "m365") {
    await sendViaM365(m, undefined, opts);
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
    attachments: await mailAttachmentsForSend(m.attachments),
  });
}

/**
 * Send one email to a list of recipients, by the chosen method. Through
 * Microsoft 365 it is queued (lib/mail-outbox) unless `opts.direct`.
 * Throws with a useful message.
 */
export async function sendMail(
  to: string[],
  subject: string,
  text: string,
  html?: string,
  /** Override the configured From (newsletters with a chosen sender). */
  fromOverride?: string,
  /** Real MIME attachments (newsletter files). */
  attachments?: MailAttachment[],
  opts: SendMailOptions = {}
): Promise<void> {
  const method = await getMailMethod();
  const m = { to, subject, text, html, fromOverride, attachments };
  if (method === "smtp" || opts.direct) {
    await sendMailWith(method, m, { wait429: !opts.noWait });
    return;
  }
  if (method === "acs") {
    if (!acsConfig()) throw new MailSendError(MAIL_NOT_SET_UP, 0, "not_set_up");
    const { enqueueMime } = await import("./mail-outbox");
    await enqueueMime(await mimeForAcs(m), { recipients: to, subject }, { kind: opts.kind, priority: opts.priority, ref: opts.ref });
    return;
  }
  const cfg = await getM365SendConfig();
  if (!m365SendConfigured(cfg)) throw new MailSendError(MAIL_NOT_SET_UP, 0, "not_set_up");
  if (cfg.secretUnreadable) throw new MailSendError(SECRET_UNREADABLE, 0, "secret_unreadable", "auth");
  const { enqueueMime } = await import("./mail-outbox");
  await enqueueMime(await mimeForM365(m, cfg), { recipients: to, subject }, { kind: opts.kind, priority: opts.priority, ref: opts.ref });
}

export interface WorkspaceTransport {
  method: MailMethod;
  from: string;
  /** Through Microsoft 365 or ACS: queued in the outbox (lib/mail-outbox) with `meta`. By SMTP: sent now. */
  send: (m: OutgoingMail, meta?: OutboxMeta) => Promise<void>;
  /** Sent now, whatever the method (the desk's test emails). */
  sendNow: (m: OutgoingMail) => Promise<void>;
}

/**
 * The chosen method as a transport for mail that carries its own headers
 * (the helpdesk: Reply-To, Message-ID, References). `from` is the
 * workspace's own From. Null when the chosen method is not set up.
 */
export async function workspaceTransport(): Promise<WorkspaceTransport | null> {
  const method = await getMailMethod();
  if (method === "acs") {
    const cfg = acsConfig();
    if (!cfg) return null;
    return {
      method,
      from: cfg.sender,
      send: async (m, meta) => {
        const { enqueueOutgoing } = await import("./mail-outbox");
        await enqueueOutgoing(m, meta ?? {});
      },
      sendNow: async (m) => sendNowAcs(await buildMime(m), [...(Array.isArray(m.to) ? m.to : [m.to]), ...(m.cc ? [m.cc] : [])], { waitResult: true }),
    };
  }
  if (method === "m365") {
    const cfg = await getM365SendConfig();
    if (!m365SendConfigured(cfg)) return null;
    return {
      method,
      from: await workspaceFrom(),
      send: async (m, meta) => {
        if (cfg.secretUnreadable) throw new MailSendError(SECRET_UNREADABLE, 0, "secret_unreadable", "auth");
        const { enqueueOutgoing } = await import("./mail-outbox");
        await enqueueOutgoing(m, meta ?? {});
      },
      sendNow: async (m) => sendMimeM365(await buildMime(m), cfg),
    };
  }
  const cfg = await getSmtpConfig();
  if (!smtpConfigured(cfg)) return null;
  const transport = smtpTransportFor(cfg);
  const send = async (m: OutgoingMail) => {
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
      attachments: await mailAttachmentsForSend(m.attachments),
    });
  };
  return { method, from: cfg.from, send, sendNow: send };
}
