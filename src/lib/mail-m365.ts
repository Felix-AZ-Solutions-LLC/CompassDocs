// 1.20.31: the workspace's outgoing email through Microsoft 365. Every
// message is built by the same library that sends SMTP (nodemailer, as
// RFC 822 bytes: From, To, Cc, Reply-To, Subject, the text and HTML parts,
// attachments, Message-ID and any headers) and handed to Microsoft Graph
// whole, as base64 text:
//
//   POST /v1.0/users/{sending mailbox}/sendMail   content-type: text/plain
//
// signed in as the workspace's app registration with the client-credentials
// grant. The Graph client is the helpdesk's (lib/helpdesk/m365/graph): its
// token cache, its transport through lib/safe-fetch, its 20 second limit
// and its test seam (COMPASSDOCS_M365_MAIL_TEST_BASE, loopback only), so
// the suites and the e2e rig never contact Microsoft. The message lands in
// the mailbox's Sent Items.
//
//   From         the sending mailbox (lib/mail-m365-shared m365FromFor): a
//                newsletter's chosen sender becomes Reply-To unless it is
//                the mailbox itself.
//   size         at most MAIL_M365_MAX_MIME (about 2.9 MB of MIME, under
//                Graph's 4 MB request limit once base64): a larger message
//                is refused before anything is sent (MailTooLargeError).
//   429          Microsoft limits how fast one mailbox sends: a refusal
//                with Retry-After up to a minute is waited out and tried
//                again, twice at most. A 429 means nothing was sent.
//   no answer    a timeout or a cut connection after the request left
//                throws, with no second try: the first may have gone out.
//
// probeM365Send checks a configuration without sending anything: it signs
// in (fresh), then asks Graph to send a message with NO recipients as the
// mailbox. Graph checks who may act on the mailbox before it looks at the
// message, so a 400 about the recipients means the mailbox exists and the
// app may send as it; 403, 404 and the mailbox codes say what is wrong. A
// message without recipients can never be delivered, and it is not saved
// to Sent Items. Server-only.

import "server-only";
import nodemailer from "nodemailer";
import { M365Error, graph, m365Token, userPath, type M365Credentials } from "./helpdesk/m365/graph";
import { SECRET_UNREADABLE, entraGrantsSend, getM365SendConfig, graphUserOf, m365SendConfigured, recordM365Check, type M365SendConfig } from "./mail-config";
import { m365SendSentence } from "./mail-m365-errors";
import { MAIL_M365_MAX_MIME, MAIL_NOT_SET_UP, cleanSendingMailbox, m365FromFor, mailTooLarge, type MailM365Check } from "./mail-m365-shared";

/** A message as the transports take it (the helpdesk's carries threading headers; the rest a subset). */
export interface OutgoingMail {
  from: string;
  to: string | string[];
  cc?: string;
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  messageId?: string;
  references?: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; path: string }[];
}

/** A refusal from Microsoft, in a sentence (lib/mail-m365-errors). SMTP-like fields let the helpdesk's sender checks read it. */
export class MailSendError extends Error {
  /** 550 for a refused From (ErrorSendAsDenied), as an SMTP server answers one; undefined otherwise. */
  responseCode?: number;
  response?: string;
  constructor(
    message: string,
    public status: number,
    public code = "",
    public kind = "",
    /** A 429's Retry-After, when Microsoft gave one. */
    public retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "MailSendError";
    if (code.toLowerCase() === "errorsendasdenied") {
      this.responseCode = 550;
      this.response = `550 5.7.60 SendAsDenied: ${message}`;
    }
  }
}

export class MailTooLargeError extends MailSendError {
  constructor(public bytes: number) {
    super(mailTooLarge(bytes), 413, "too_large", "too_large");
    this.name = "MailTooLargeError";
  }
}

/** The mail as RFC 822 bytes, built by the library that sends SMTP. */
export async function buildMime(m: OutgoingMail): Promise<Buffer> {
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const info = await composer.sendMail({
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
  return info.message as unknown as Buffer;
}

const creds = (c: M365SendConfig): M365Credentials => ({ tenant: c.tenant, clientId: c.clientId, secret: c.secret });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Longest Retry-After waited out inside one send, and how many times. */
const RETRY_AFTER_MAX_MS = 60_000;
const RETRIES_429 = 2;
let waitFor429 = sleep;
/** Tests: how a 429 is waited out (null restores the real wait). */
export function setM365RetryWaitForTests(fn: ((ms: number) => Promise<unknown>) | null): void {
  waitFor429 = (fn as typeof sleep) ?? sleep;
}

const asSendError = (e: M365Error, mailbox: string) => new MailSendError(m365SendSentence(e, mailbox), e.status, e.code, e.kind, e.retryAfterMs);

/** Hand one built message to Graph as the configured mailbox. Throws MailSendError (or MailTooLargeError) with a sentence. */
export async function sendMimeM365(mime: Buffer, cfg?: M365SendConfig): Promise<void> {
  const c = cfg ?? (await getM365SendConfig());
  if (!m365SendConfigured(c)) throw new MailSendError(MAIL_NOT_SET_UP, 0, "not_set_up");
  if (c.secretUnreadable) throw new MailSendError(SECRET_UNREADABLE, 0, "secret_unreadable", "auth");
  if (mime.length > MAIL_M365_MAX_MIME) throw new MailTooLargeError(mime.length);
  const value = mime.toString("base64");
  for (let attempt = 0; ; attempt++) {
    try {
      await graph(creds(c), { method: "POST", path: `${userPath(graphUserOf(c))}/sendMail`, text: { value, type: "text/plain" }, what: "send mail as this mailbox", timeoutMs: 60_000 });
      return;
    } catch (e) {
      if (!(e instanceof M365Error)) throw e;
      const wait = e.retryAfterMs ?? 2_000;
      if (e.status === 429 && attempt < RETRIES_429 && wait <= RETRY_AFTER_MAX_MS) {
        await waitFor429(wait);
        continue;
      }
      throw asSendError(e, c.mailbox);
    }
  }
}

/** sendMail's message through Microsoft 365: From the mailbox (a chosen sender becomes Reply-To), with its attachments. */
export async function sendViaM365(
  m: { to: string[]; subject: string; text: string; html?: string; fromOverride?: string; attachments?: { filename: string; path: string }[] },
  cfg?: M365SendConfig
): Promise<void> {
  const c = cfg ?? (await getM365SendConfig());
  if (!m365SendConfigured(c)) throw new MailSendError(MAIL_NOT_SET_UP, 0, "not_set_up");
  if (c.secretUnreadable) throw new MailSendError(SECRET_UNREADABLE, 0, "secret_unreadable", "auth");
  const who = m365FromFor(c.mailbox, c.fromName, m.fromOverride);
  const mime = await buildMime({ from: who.from, replyTo: who.replyTo, to: m.to, subject: m.subject, text: m.text, html: m.html, attachments: m.attachments });
  await sendMimeM365(mime, c);
}

/** One send with no recipients as `user`: the answer says whether the app may send as it. Sends nothing. */
async function maySendAs(c: M365SendConfig, user: string): Promise<{ allowed: true } | { allowed: false; error: M365Error }> {
  try {
    await graph(creds(c), {
      method: "POST",
      path: `${userPath(user)}/sendMail`,
      body: {
        message: { subject: "CompassDocs connection check", body: { contentType: "Text", content: "This message has no recipients and is never delivered." }, toRecipients: [] },
        saveToSentItems: false,
      },
      what: "send mail as this mailbox",
    });
    return { allowed: true };
  } catch (e) {
    if (!(e instanceof M365Error)) throw e;
    const lc = e.code.toLowerCase();
    const mailboxProblem = lc === "mailboxnotenabledforrestapi" || lc === "mailboxnotsupportedforrestapi" || lc === "errorinvaliduser" || lc === "resourcenotfound";
    // Past the access check: Graph only complained about the message, which has no recipients on purpose.
    if (e.status === 400 && !mailboxProblem) return { allowed: true };
    return { allowed: false, error: e };
  }
}

/**
 * Check the saved configuration without sending: a fresh sign-in, then a
 * send with no recipients as the mailbox (see the top of this file). With
 * `other` (the admin's own address), the same as that mailbox too: an app
 * that may send as it is not limited to the sending mailbox yet (limited:
 * false, and the page says to run the lock-down commands). Kept for the
 * page (recordM365Check) unless `record` is false.
 */
export async function probeM365Send(opts: { record?: boolean; cfg?: M365SendConfig; other?: string | null } = {}): Promise<MailM365Check & { entra_send: boolean | null }> {
  const c = opts.cfg ?? (await getM365SendConfig());
  const at = new Date().toISOString();
  const done = async (ok: boolean, message: string, claims: { tid: string; oid: string; roles: string[] } | null, limited: boolean | null = null, other = "") => {
    const check: MailM365Check = { at, ok, message, limited, other };
    if (opts.record !== false) await recordM365Check(check, claims).catch(() => {});
    return { ...check, entra_send: claims ? entraGrantsSend(claims.roles) : null };
  };
  if (!m365SendConfigured(c)) return done(false, "Microsoft 365 is not set up: enter the tenant, the app, its secret and the sending mailbox.", null);
  if (c.secretUnreadable) return done(false, SECRET_UNREADABLE, null);
  let claims: { tid: string; oid: string; roles: string[] };
  try {
    claims = (await m365Token(creds(c), true)).claims;
  } catch (e) {
    if (e instanceof M365Error) return done(false, m365SendSentence(e, c.mailbox), null);
    throw e;
  }
  const own = await maySendAs(c, graphUserOf(c));
  if (!own.allowed) return done(false, m365SendSentence(own.error, c.mailbox), claims);
  const okLine = `Signed in, and the app may send as ${c.mailbox}. Nothing was sent.`;
  const other = cleanSendingMailbox(opts.other ?? "");
  if (!other || other === c.mailbox.toLowerCase() || other === c.graphUser.toLowerCase()) return done(true, okLine, claims, null, "");
  const probe = await maySendAs(c, other);
  if (probe.allowed) {
    return done(true, `${okLine} The app can also send as ${other}: it is not limited to ${c.mailbox} yet. Run the lock-down commands below.`, claims, false, other);
  }
  if (probe.error.status === 403) return done(true, `${okLine} It can't send as ${other}, as it should.`, claims, true, other);
  return done(true, `${okLine} Whether it is limited to ${c.mailbox} is not known: ${other} is not a mailbox it could be tried with.`, claims, null, other);
}

/**
 * A refusal that will be the same for every recipient (the message is too
 * large, the app may not sign in or send as the mailbox): a loop over
 * recipients stops at the first, and says why, instead of trying each.
 */
export function refusalRepeats(e: unknown): boolean {
  if (e instanceof MailTooLargeError) return true;
  if (!(e instanceof MailSendError)) return false;
  return e.kind === "auth" || e.code === "not_set_up" || e.status === 401 || e.status === 403 || e.status === 404;
}
