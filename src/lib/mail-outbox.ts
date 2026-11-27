// 1.20.32: the outbox for the workspace's email through Microsoft 365.
// Every message the workspace sends through Microsoft 365 (lib/mailer
// sendMail and workspaceTransport: notifications, digests, reminders,
// helpdesk mail, sign-in links) is queued here first and sent by a paced
// worker, so none is dropped because Microsoft asked to slow down. SMTP
// sends as before, on the spot. The pure half (limits, priorities, the
// pacing arithmetic, how a refusal is read) is lib/mail-outbox-shared.
//
//   queue     enqueueOutgoing builds the message to MIME at once (with the
//             same buildMime as a direct send, so attachment files may be
//             deleted afterwards), refuses one over the size limit at once,
//             and stores it SEALED with the master key (lib/secretbox, as
//             the Microsoft 365 client secret is: a message can hold a
//             sign-in link) before anything is tried. Then the worker is
//             kicked: with room in the budget it goes out within seconds.
//   claim     one transaction: the control row (mail_outbox_control) FOR
//             UPDATE, so every claimer in every instance takes its turn;
//             the next queued row by priority then age, FOR UPDATE SKIP
//             LOCKED; the budget (mail_send_ledger: sends in the last 60
//             seconds, the last one, recipients in the last 24 hours) and
//             the pause; a ledger row for the send; the row marked sending.
//             Newsletters (lib/newsletter-delivery) draw from the same
//             budget through takeMailSlot and give way to urgent and
//             ordinary mail, so the combined rate stays under the limit.
//   send      a sign-in first (no answer there: nothing left, try again
//             shortly), then posted_at is stamped and the MIME is posted
//             once. Sent: the body is wiped, the metadata kept 30 days.
//   429/503   the row stays queued with next_attempt_at from Retry-After
//             (at least a minute) and the whole outbox pauses until then:
//             the limit is the mailbox's, not the message's.
//   no answer after the post: Graph's sendMail is not idempotent, so the
//             row becomes `uncertain` and is never sent again by itself. If
//             the app may read the mailbox's Sent Items (it normally may
//             not: a 403 is "unknown"), the tick looks for its Message-ID
//             and settles it. Otherwise an admin chooses Retry or Discard.
//   refusals  one that repeats for everyone (the app may not sign in or
//             send, the mailbox is missing, the settings are incomplete)
//             pauses the outbox with the reason (rows stay queued; tried
//             again after 10 minutes, or at once when the settings are
//             saved); one that is this message's (too large, a bad
//             recipient) fails the row with Microsoft's reason in a
//             sentence (lib/mail-m365-errors). 500 and 502 are tried a few
//             times, then fail.
//   reclaim   a row left `sending` by an instance that died: back to queued
//             when it was never posted, else `uncertain`.
//   notices   workspace admins get one bell notice per pause (per reason,
//             at most daily) and one per burst of failures (at most
//             hourly); System diagnostics shows the outbox.
//   switch    after switching to SMTP the rows still queued go out by SMTP
//             (the From swapped for the SMTP From), unpaced; the switch
//             says how many first, and they can be discarded before.
//
// The worker runs in every instance (instrumentation, every minute, and on
// each enqueue); nothing it logs holds a message or a secret. Server-only.
//
// 1.21.5: Azure Communication Services (lib/mail-acs, chosen by the operator
// with COMPASSDOCS_MAIL_TRANSPORT=acs) goes through the same queue, budget,
// pauses, notices and admin actions, with these differences:
//
//   limits    the configured share of ACS's quota (lib/mail-outbox-shared
//             acsPace): per minute AND per hour, at most 50 recipients and
//             10 MB a message, no daily recipient cap.
//   send      the stored MIME is read back into ACS's JSON (lib/mail-acs-mime)
//             at send time, From the platform's sender; a sign-in first (as
//             for Microsoft 365), then posted_at and our own Operation-Id are
//             stamped, then one POST.
//   accepted  ACS answers 202: the row becomes `accepted` (handed over, the
//             result not known yet) and its operation is looked up later
//             (checkAcceptedAcs: the minute tick and each drain, at most 20 a
//             run, first after ACS's Retry-After or 5 to 60 seconds, then
//             backing off). Succeeded: `sent`. Failed or Canceled: `failed`
//             with ACS's reason. Still running after two hours: `uncertain`.
//             ACS also limits status lookups (60 a minute, 200 an hour per
//             subscription): one lookup per message is the usual case.
//   no answer after the post: `uncertain`, and since the Operation-Id is
//             ours, settleUncertain looks it up (three tries): found, it is
//             settled as above; never found, an admin decides.
//   429       as Microsoft's: everything waits, nothing is failed.

import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { PoolClient } from "pg";
import addressparser from "nodemailer/lib/addressparser";
import { pool } from "./db";
import { audit, type AuditActor } from "./audit";
import { openSecret, sealSecret } from "./secretbox";
import { getM365SendConfig, getMailMethod } from "./mail-config";
import { MailSendError, MailTooLargeError, assertSendable, buildMime, findInSentItems, postMimeM365, signInForSend, type OutgoingMail } from "./mail-m365";
import { MAIL_M365_MAX_MIME, MAIL_NOT_SET_UP, bareAddress, cleanFromName, pacedMethod, type MailMethod } from "./mail-m365-shared";
import { ACS_DEFAULT_PER_HOUR, ACS_DEFAULT_PER_MINUTE, MAIL_ACS_MAX_BYTES, MAIL_ACS_MAX_RECIPIENTS, acsConfig, acsSelected } from "./mail-acs-config";
import { decodeWords } from "./mail-acs-mime";
import { isCloud } from "./cloud";
import { countMail } from "./telemetry-hooks";
import type { M365SendConfig } from "./mail-config";
import {
  ACS_NO_RESULT_REASON,
  ACS_UNCERTAIN_REASON,
  DEFAULT_PACE,
  MAIL_DAILY_RECIPIENT_LIMIT,
  acsPace,
  MAIL_MAX_RECIPIENTS,
  MAIL_REFUSAL_ATTEMPTS,
  MAIL_OUTBOX_CLAIM_MS,
  MAIL_OUTBOX_KEEP_DAYS,
  MAIL_RATE_PAUSE_MIN_MS,
  MAIL_REFUSAL_PAUSE_MS,
  MAIL_TRANSIENT_ATTEMPTS,
  PRIORITY,
  UNCERTAIN_REASON,
  UNREADABLE_BODY,
  classifySendError,
  dailyWaitMs,
  mailPriority,
  paceDecision,
  tooManyRecipients,
  transientBackoffMs,
  type MailPriority,
  type OutboxWaiting,
  type OutboxProblem,
  type OutboxView,
  type PaceDecision,
  type PaceLimits,
} from "./mail-outbox-shared";

export interface OutboxMeta {
  /** What the message is ("password_reset", "helpdesk_reply", "digest"…): its priority and its label in the admin's list. */
  kind?: string;
  /** Overrides the kind's priority. */
  priority?: MailPriority;
  /** What it belongs to, so its owner can show where it stands (a desk message: { type: "hd_message", id }). */
  ref?: { type: string; id: number } | null;
}

const INSTANCE = `${hostname().slice(0, 40)}:${process.pid}:${randomBytes(3).toString("hex")}`;

// --- Test seams ------------------------------------------------------------------------------

interface TestHooks {
  /** false: enqueue does not start the worker, and no timer is set (a test drains by hand). */
  autoDrain?: boolean;
  limits?: Partial<PaceLimits>;
  /** Replace the POST to Microsoft (the fake Microsoft is used when this is unset). */
  post?: (mime: Buffer, cfg: M365SendConfig) => Promise<void>;
  /** Called after the sign-in and before the claim is stamped as posting (a test takes the claim away here). */
  beforePost?: (id: number) => Promise<void>;
  /** Replace the SMTP send of a leftover row after a switch to SMTP. */
  smtp?: (raw: Buffer, envelope: { from: string; to: string[] }) => Promise<void>;
}
let hooks: TestHooks = {};
/** Tests: hooks for the worker (null restores everything). */
export function setOutboxForTests(h: TestHooks | null): void {
  hooks = h ?? {};
}
/** The method whose limits apply when none is named: ACS while the operator chose it, else Microsoft 365. */
const currentPaced = (): MailMethod => (acsSelected() ? "acs" : "m365");
function paceFor(method: MailMethod): PaceLimits {
  if (method !== "acs") return DEFAULT_PACE;
  const c = acsConfig();
  return acsPace(c?.perMinute ?? ACS_DEFAULT_PER_MINUTE, c?.perHour ?? ACS_DEFAULT_PER_HOUR);
}
const limits = (method: MailMethod = currentPaced()): PaceLimits => ({ ...paceFor(method), ...(hooks.limits ?? {}) });
/** The service the outbox sends through, as the admins' notices say it. */
const serviceName = (method: MailMethod = currentPaced()) => (method === "acs" ? (isCloud() ? "CompassDocs Cloud's email service" : "Azure Communication Services") : "Microsoft 365");
const autoDrain = () => hooks.autoDrain !== false;

// --- MIME --------------------------------------------------------------------------------------

/** The header block of a message and where its body starts. */
function headerBlock(mime: Buffer): { head: string; rest: Buffer } {
  const at = mime.indexOf("\r\n\r\n");
  if (at < 0) return { head: mime.toString("latin1"), rest: Buffer.alloc(0) };
  return { head: mime.subarray(0, at).toString("latin1"), rest: mime.subarray(at) };
}

/** The header lines grouped with their folded continuations. */
function headerGroups(head: string): string[] {
  const out: string[] = [];
  for (const line of head.split("\r\n")) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += `\r\n${line}`;
    else out.push(line);
  }
  return out;
}

/** One header's value, unfolded ('' when absent). */
export function mimeHeader(mime: Buffer, name: string): string {
  const want = name.toLowerCase();
  for (const g of headerGroups(headerBlock(mime).head)) {
    const i = g.indexOf(":");
    if (i > 0 && g.slice(0, i).trim().toLowerCase() === want) return g.slice(i + 1).replace(/\r\n[ \t]+/g, " ").trim();
  }
  return "";
}

/** The message with the headers named `names` replaced by `group` (a whole header as nodemailer writes it), where the first stood. */
export function replaceHeader(mime: Buffer, names: string[], group: string): Buffer {
  const { head, rest } = headerBlock(mime);
  const out: string[] = [];
  let placed = false;
  for (const g of headerGroups(head)) {
    const name = g.slice(0, Math.max(0, g.indexOf(":"))).trim().toLowerCase();
    if (names.includes(name)) {
      if (!placed) out.push(group);
      placed = true;
      continue;
    }
    out.push(g);
  }
  if (!placed) out.unshift(group);
  return Buffer.concat([Buffer.from(out.join("\r\n"), "latin1"), rest]);
}

/** The message with its From (and any Sender) replaced by `fromGroup`. */
export const replaceFrom = (mime: Buffer, fromGroup: string): Buffer => replaceHeader(mime, ["from", "sender"], fromGroup);

/** A From or Reply-To header for `value`, encoded as nodemailer encodes one. */
async function headerFor(name: "from" | "reply-to", value: string): Promise<string> {
  const probe = await buildMime({ from: name === "from" ? value : "probe@example.invalid", replyTo: name === "reply-to" ? value : undefined, to: "probe@example.invalid", subject: "", text: "" });
  const g = headerGroups(headerBlock(probe).head).find((x) => x.toLowerCase().startsWith(`${name}:`));
  return g ?? `${name === "from" ? "From" : "Reply-To"}: ${bareAddress(value)}`;
}

/** Bare addresses in a To or Cc value (an array, or one comma-separated string), lower-cased, once each (nodemailer's parser, as the MIME was built with). */
export function addressList(v: string | string[] | undefined | null): string[] {
  const parts = Array.isArray(v) ? v : [String(v ?? "")];
  const out: string[] = [];
  for (const p of parts) {
    for (const a of addressparser(String(p ?? ""), { flatten: true })) {
      const addr = (a.address ?? "").trim().toLowerCase();
      // As lenient as the parser: a quoted local part ("john doe"@x) is an address too.
      if (/^.+@[^@\s<>]+$/.test(addr) && !/[<>\r\n]/.test(addr) && !out.includes(addr)) out.push(addr);
    }
  }
  return out;
}

/**
 * The message From the CURRENT sending mailbox. A message is built with the
 * mailbox of the moment it was queued; if the admin changed the mailbox
 * since, Exchange would refuse the old From (SendAsDenied) for every one of
 * them. So the From's address is swapped for the mailbox's (its name kept),
 * and a Reply-To that was the old mailbox follows it. Anything else (a
 * newsletter sender's Reply-To, a help address's) is left as it is.
 */
export async function fromForMailbox(mime: Buffer, mailbox: string, fromName = ""): Promise<Buffer> {
  const mb = mailbox.trim().toLowerCase();
  if (!mb) return mime;
  const was = addressparser(decodeWords(mimeHeader(mime, "from")), { flatten: true })[0];
  const old = (was?.address ?? "").trim().toLowerCase();
  if (old === mb) return mime;
  const name = cleanFromName(was?.name ?? "") || cleanFromName(fromName);
  let out = replaceHeader(mime, ["from", "sender"], await headerFor("from", name ? `"${name}" <${mailbox}>` : mailbox));
  const rt = addressparser(decodeWords(mimeHeader(out, "reply-to")), { flatten: true });
  if (old && rt.length === 1 && (rt[0].address ?? "").toLowerCase() === old) {
    const rtName = cleanFromName(rt[0].name ?? "");
    out = replaceHeader(out, ["reply-to"], await headerFor("reply-to", rtName ? `"${rtName}" <${mailbox}>` : mailbox));
  }
  return out;
}

// --- Queueing ----------------------------------------------------------------------------------

/**
 * Queue one message built from its parts. Refuses one over the size limit
 * at once (MailTooLargeError), as a direct send would. Answers the row's id.
 */
export async function enqueueOutgoing(m: OutgoingMail, meta: OutboxMeta = {}): Promise<number> {
  const mime = await buildMime(m);
  const raw = [...(Array.isArray(m.to) ? m.to : [m.to]), ...(m.cc ? [m.cc] : [])].filter((x) => String(x ?? "").trim());
  return enqueueMime(mime, { recipients: raw, subject: m.subject }, meta);
}

/** The most recipients one queued message may have: what Graph takes in one send, and never more than the day's cap. */
export const recipientCap = (method: MailMethod = currentPaced()) => Math.min(method === "acs" ? MAIL_ACS_MAX_RECIPIENTS : MAIL_MAX_RECIPIENTS, limits(method).safeCap);

/**
 * Queue one built message. `recipients` as the caller gave them (bare
 * addresses or "Name <a@b>"). Refused at once: too large, no recipients,
 * more recipients than one send may have. Recipients given but none an
 * address: kept as a FAILED row with the reason, so the admin sees it in
 * the Outbox (and the desk on its message), not only the log.
 */
export async function enqueueMime(mime: Buffer, info: { recipients: string[]; subject: string }, meta: OutboxMeta = {}): Promise<number> {
  // 1.21.5: each service's own limits (ACS: 10 MB and 50 recipients; Microsoft 365: about 2.9 MB and 500).
  const method = acsSelected() ? "acs" : "m365";
  if (method === "acs" && mime.length > MAIL_ACS_MAX_BYTES) {
    const { acsTooLargeSentence } = await import("./mail-acs");
    throw new MailTooLargeError(mime.length, acsTooLargeSentence(mime.length));
  }
  if (method === "m365" && mime.length > MAIL_M365_MAX_MIME) throw new MailTooLargeError(mime.length);
  const given = info.recipients.map((r) => String(r ?? "").trim()).filter(Boolean);
  if (!given.length) throw new MailSendError("This email has no recipients.", 400, "no_recipients");
  const rcpt = addressList(given);
  const cap = recipientCap(method);
  if (rcpt.length > cap) throw new MailSendError(tooManyRecipients(rcpt.length, cap, method), 400, "too_many_recipients");
  const unusable = rcpt.length === 0;
  const priority = meta.priority ?? mailPriority(meta.kind);
  const shown = (unusable ? given : rcpt).join(", ").slice(0, 4000);
  const r = await pool().query<{ id: string }>(
    `INSERT INTO mail_outbox (priority, kind, recipient_count, recipients, rcpt, subject, message_id, mime, size, ref_type, ref_id, status, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [
      priority,
      (meta.kind ?? "").slice(0, 60),
      Math.max(1, rcpt.length),
      shown,
      rcpt,
      info.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 300),
      mimeHeader(mime, "message-id").slice(0, 400),
      sealSecret(mime.toString("base64")),
      mime.length,
      meta.ref?.type ?? null,
      meta.ref?.id ?? null,
      unusable ? "failed" : "queued",
      unusable ? NO_USABLE_RECIPIENT : "",
    ]
  );
  const id = Number(r.rows[0].id);
  if (unusable) {
    console.error(`[mail-outbox] #${id} failed: ${NO_USABLE_RECIPIENT}`);
    await noticeFailures();
  } else if (autoDrain()) kickOutbox();
  return id;
}

const NO_USABLE_RECIPIENT = "None of this email's recipients is an email address, so it can't be sent. Check the addresses it was sent to.";

// --- The budget ----------------------------------------------------------------------------------

async function controlRow(client: PoolClient): Promise<{ pausedMs: number | null; nowMs: number }> {
  const q = () => client.query<{ paused_ms: number | null }>("SELECT (extract(epoch FROM paused_until) * 1000)::float8 AS paused_ms FROM mail_outbox_control WHERE id = 1 FOR UPDATE");
  let r = await q();
  if (!r.rows[0]) {
    await client.query("INSERT INTO mail_outbox_control (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
    r = await q();
  }
  // The time once the lock is held (a claim may have waited for it), so no send another claimer just made is "in the future".
  const now = (await client.query<{ now_ms: number }>("SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now_ms")).rows[0];
  const row = r.rows[0];
  return { pausedMs: row?.paused_ms == null ? null : Number(row.paused_ms), nowMs: Number(now?.now_ms ?? Date.now()) };
}

/**
 * The budget's answer for one more send, inside a claim's transaction (the
 * control row is locked). Wall-clock time (clock_timestamp), not the
 * transaction's start, since a claim may wait for the lock.
 */
async function budget(client: PoolClient, nowMs: number, pausedMs: number | null, recipients: number, priority: MailPriority, lim: PaceLimits = limits()): Promise<PaceDecision> {
  const s = (
    await client.query<{ last_ms: number | null; day: number; minute: number[] | null }>(
      `SELECT (extract(epoch FROM max(at)) * 1000)::float8 AS last_ms,
              COALESCE(sum(recipients), 0)::int AS day,
              array_agg((extract(epoch FROM at) * 1000)::float8 ORDER BY at) FILTER (WHERE at > clock_timestamp() - interval '60 seconds') AS minute
         FROM mail_send_ledger WHERE at > clock_timestamp() - interval '24 hours'`
    )
  ).rows[0];
  // 1.21.5: an hourly limit (ACS) needs the hour's sends too.
  const hour = Number.isFinite(lim.perHour)
    ? (
        // Only the hour's last perHour sends matter (the oldest of them is the one that must age out).
        await client.query<{ at_ms: number }>(
          `SELECT at_ms FROM (SELECT (extract(epoch FROM at) * 1000)::float8 AS at_ms FROM mail_send_ledger
              WHERE at > clock_timestamp() - interval '60 minutes' ORDER BY at DESC LIMIT $1) last ORDER BY at_ms`,
          [Math.min(lim.perHour, 1_000_000)]
        )
      ).rows.map((x) => Number(x.at_ms))
    : undefined;
  const d = paceDecision(
    { nowMs, pausedUntilMs: pausedMs, lastAtMs: s?.last_ms == null ? null : Number(s.last_ms), minute: (s?.minute ?? []).map(Number), dayRecipients: Number(s?.day ?? 0), hour },
    recipients,
    priority,
    lim
  );
  if (d.ok || d.why !== "daily") return d;
  const sends = (
    await client.query<{ at_ms: number; recipients: number }>(
      "SELECT (extract(epoch FROM at) * 1000)::float8 AS at_ms, recipients FROM mail_send_ledger WHERE at > clock_timestamp() - interval '24 hours' ORDER BY at"
    )
  ).rows.map((x) => ({ atMs: Number(x.at_ms), recipients: Number(x.recipients) }));
  return { ok: false, why: "daily", waitMs: dailyWaitMs(sends, nowMs, recipients, priority === PRIORITY.urgent ? lim.urgentCap : lim.safeCap) };
}

async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const takeLedger = async (client: PoolClient, recipients: number, source: string) =>
  Number((await client.query<{ id: string }>("INSERT INTO mail_send_ledger (at, recipients, source) VALUES (clock_timestamp(), $1, $2) RETURNING id", [recipients, source.slice(0, 40)])).rows[0].id);

/**
 * A send outside the outbox (a newsletter recipient, lib/newsletter-delivery)
 * takes its slot from the same budget: answered ok (and counted, `slotId`)
 * or how long to wait. Bulk mail gives way while urgent or ordinary mail is
 * waiting. A send that then reaches nothing gives its slot back
 * (releaseMailSlot).
 */
export async function takeMailSlot(opts: { recipients?: number; priority?: MailPriority; source: string }): Promise<PaceDecision & { slotId?: number }> {
  const recipients = Math.max(1, opts.recipients ?? 1);
  const priority = opts.priority ?? PRIORITY.bulk;
  const d = await inTx(async (client) => {
    const { pausedMs, nowMs } = await controlRow(client);
    if (priority > PRIORITY.urgent) {
      const ahead = await client.query("SELECT 1 FROM mail_outbox WHERE status = 'queued' AND priority < $1 AND next_attempt_at <= clock_timestamp() LIMIT 1", [priority]);
      if (ahead.rowCount) return { ok: false, why: "gap", waitMs: Math.max(1_000, limits().gapMs) } as PaceDecision;
    }
    const answer = await budget(client, nowMs, pausedMs, recipients, priority);
    if (!answer.ok) return answer;
    return { ...answer, slotId: await takeLedger(client, recipients, opts.source) };
  });
  if (!d.ok && d.why === "gap" && autoDrain()) kickOutbox();
  return d;
}

/** Give back a slot whose send reached nothing (Microsoft refused it, asked to slow down, or never heard it). */
export async function releaseMailSlot(slotId: number | null | undefined): Promise<void> {
  if (slotId) await pool().query("DELETE FROM mail_send_ledger WHERE id = $1", [slotId]);
}

// --- Pause and notices -----------------------------------------------------------------------------

/** Microsoft asked to slow down: everything waits at least a minute (shared with newsletters). */
export async function pauseOutboxForRate(retryAfterMs: number | null | undefined, reason: string): Promise<Date> {
  const ms = Math.max(MAIL_RATE_PAUSE_MIN_MS, Math.min(retryAfterMs ?? MAIL_RATE_PAUSE_MIN_MS, 3_600_000));
  const r = await pool().query<{ until: Date }>(
    `UPDATE mail_outbox_control SET
        pause_kind = CASE WHEN pause_kind = 'refusal' AND paused_until > now() THEN pause_kind ELSE 'rate' END,
        pause_reason = CASE WHEN pause_kind = 'refusal' AND paused_until > now() THEN pause_reason ELSE $2 END,
        rate_until = GREATEST(COALESCE(rate_until, now()), now() + ($1 || ' milliseconds')::interval),
        paused_until = GREATEST(COALESCE(paused_until, now()), now() + ($1 || ' milliseconds')::interval),
        updated_at = now()
      WHERE id = 1 RETURNING paused_until AS until`,
    [String(ms), reason.slice(0, 500)]
  );
  // (A timestamp may come back as text, by lib/db's parsers.)
  return r.rows[0]?.until ? new Date(r.rows[0].until) : new Date(Date.now() + ms);
}

/**
 * A refusal every message would get: pause with the reason (never shorter
 * than a slow-down already running); tell the admins once per reason (at
 * most daily).
 */
export async function pauseOutboxForRefusal(reason: string): Promise<void> {
  const text = reason.replace(/\s+/g, " ").trim().slice(0, 500);
  const r = await pool().query<{ tell: boolean }>(
    `WITH old AS (SELECT noticed_reason, noticed_at FROM mail_outbox_control WHERE id = 1 FOR UPDATE)
     UPDATE mail_outbox_control c SET
        paused_until = GREATEST(COALESCE(c.paused_until, now()), now() + ($2 || ' milliseconds')::interval),
        pause_reason = $1, pause_kind = 'refusal', updated_at = now(),
        noticed_reason = $1,
        noticed_at = CASE WHEN old.noticed_reason <> $1 OR old.noticed_at IS NULL OR old.noticed_at < now() - interval '24 hours' THEN now() ELSE old.noticed_at END
       FROM old WHERE c.id = 1
     RETURNING (old.noticed_reason <> $1 OR old.noticed_at IS NULL OR old.noticed_at < now() - interval '24 hours') AS tell`,
    [text, String(MAIL_REFUSAL_PAUSE_MS)]
  );
  console.error(`[mail-outbox] paused: ${text}`);
  if (r.rows[0]?.tell) await noticeAdmins("Email is paused", `Email through ${serviceName()} is paused: ${text} Messages wait in the outbox and go out once it is fixed.`);
}

const RATE_REASON = "Microsoft 365 asked this mailbox to slow down.";

/** What is left of the pause once a refusal is over: Microsoft's own slow-down, if it still runs. */
const LIFT_REFUSAL = `paused_until = CASE WHEN rate_until > now() THEN rate_until ELSE NULL END,
        pause_kind = CASE WHEN rate_until > now() THEN 'rate' ELSE '' END,
        pause_reason = CASE WHEN rate_until > now() THEN '${RATE_REASON}' ELSE '' END`;

/**
 * Lift the pause and let waiting rows go now. `onlyRefusal` (the settings
 * were saved, a check passed, the admin pressed Try now): only a pause for
 * a refusal is lifted, and Microsoft's own slow-down is kept (lifting it
 * early only earns another 429). Without it (the method changed),
 * everything is lifted.
 */
export async function resumeOutbox(opts: { onlyRefusal?: boolean } = {}): Promise<void> {
  const r = opts.onlyRefusal
    ? await pool().query(`UPDATE mail_outbox_control SET ${LIFT_REFUSAL}, updated_at = now() WHERE id = 1 AND pause_kind = 'refusal'`)
    : await pool().query("UPDATE mail_outbox_control SET paused_until = NULL, rate_until = NULL, pause_reason = '', pause_kind = '', updated_at = now() WHERE id = 1");
  if (opts.onlyRefusal && !r.rowCount) return;
  await pool().query("UPDATE mail_outbox SET next_attempt_at = now(), updated_at = now() WHERE status = 'queued' AND next_attempt_at > now()");
  if (autoDrain()) kickOutbox();
}

async function noticeFailures(): Promise<void> {
  const r = await pool().query(
    "UPDATE mail_outbox_control SET failure_notice_at = now() WHERE id = 1 AND (failure_notice_at IS NULL OR failure_notice_at < now() - interval '1 hour') RETURNING 1"
  );
  if (!r.rowCount) return;
  const n = (await pool().query<{ n: number }>("SELECT count(*)::int AS n FROM mail_outbox WHERE status IN ('failed', 'uncertain') AND updated_at > now() - interval '1 hour'")).rows[0]?.n ?? 1;
  await noticeAdmins(
    n === 1 ? "An email wasn't sent" : `${n} emails weren't sent`,
    `${n === 1 ? "An email" : `${n} emails`} through ${serviceName()} failed or may not have gone out. Open Settings, Notifications, Email to see why, then retry or discard ${n === 1 ? "it" : "them"}.`
  );
}

let noticeForTests: ((title: string, body: string) => void) | null = null;
/** Tests: see the admin notices (they are still sent). */
export function setOutboxNoticeSpyForTests(fn: typeof noticeForTests): void {
  noticeForTests = fn;
}

async function noticeAdmins(title: string, body: string): Promise<void> {
  noticeForTests?.(title, body);
  try {
    const { notify } = await import("./notifications");
    const ids = (await pool().query<{ id: number }>("SELECT id FROM users WHERE role = 'admin' AND status = 'active'")).rows.map((x) => x.id);
    await notify(ids, { kind: "service_status", event: "mail_outbox", title, body, link: "/admin/notifications/email#outbox" });
  } catch (e) {
    console.error("[mail-outbox] could not notify the admins:", e instanceof Error ? e.message : String(e));
  }
}

// --- The worker ------------------------------------------------------------------------------------

type Claim = { kind: "row"; id: number } | { kind: "wait"; waitMs: number } | { kind: "none"; nextMs: number | null };

async function claimNext(method: MailMethod): Promise<Claim> {
  return inTx(async (client) => {
    const { pausedMs, nowMs } = await controlRow(client);
    const row = (
      await client.query<{ id: string; priority: number; recipient_count: number }>(
        `SELECT id, priority, recipient_count FROM mail_outbox
          WHERE status = 'queued' AND next_attempt_at <= clock_timestamp()
          ORDER BY priority, id LIMIT 1 FOR UPDATE SKIP LOCKED`
      )
    ).rows[0];
    if (!row) {
      const next = (await client.query<{ ms: number | null }>("SELECT (extract(epoch FROM min(next_attempt_at) - clock_timestamp()) * 1000)::float8 AS ms FROM mail_outbox WHERE status = 'queued'")).rows[0];
      return { kind: "none", nextMs: next?.ms == null ? null : Math.max(0, Number(next.ms)) } as Claim;
    }
    // Microsoft 365's limits are the mailbox's, ACS's the subscription's; a leftover row going out by SMTP after a switch is not paced.
    let ledgerId: number | null = null;
    if (pacedMethod(method)) {
      const d = await budget(client, nowMs, pausedMs, row.recipient_count, row.priority as MailPriority, limits(method));
      if (!d.ok) return { kind: "wait", waitMs: d.waitMs } as Claim;
      ledgerId = await takeLedger(client, row.recipient_count, "outbox");
    }
    await client.query(
      "UPDATE mail_outbox SET status = 'sending', claimed_at = clock_timestamp(), claimed_by = $2, posted_at = NULL, attempts = attempts + 1, ledger_id = $3, updated_at = now() WHERE id = $1",
      [row.id, INSTANCE, ledgerId]
    );
    return { kind: "row", id: Number(row.id) } as Claim;
  });
}

const oneLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 500);

/** Every write a worker makes about its claim holds only while the claim is still its own (a reclaim, a Retry or a Discard wins). */
const MINE = "status = 'sending' AND claimed_by = $2";

/** Give back the claim's budget slot: nothing reached Microsoft. */
async function releaseLedger(ledgerId: number | null): Promise<void> {
  if (ledgerId) await pool().query("DELETE FROM mail_send_ledger WHERE id = $1", [ledgerId]);
}

async function markSent(id: number): Promise<boolean> {
  const r = await pool().query(
    `UPDATE mail_outbox SET status = 'sent', sent_at = now(), mime = NULL, last_error = '', claimed_by = NULL, claimed_at = NULL, ledger_id = NULL, updated_at = now() WHERE id = $1 AND ${MINE} RETURNING id`,
    [id, INSTANCE]
  );
  // Sending works again: a pause for a refusal is over (Microsoft's own slow-down is kept), and the next refusal is news.
  await pool().query(
    `UPDATE mail_outbox_control SET noticed_reason = '', updated_at = now(),
        paused_until = CASE WHEN pause_kind = 'refusal' THEN (CASE WHEN rate_until > now() THEN rate_until ELSE NULL END) ELSE paused_until END,
        pause_reason = CASE WHEN pause_kind = 'refusal' THEN (CASE WHEN rate_until > now() THEN '${RATE_REASON}' ELSE '' END) ELSE pause_reason END,
        pause_kind = CASE WHEN pause_kind = 'refusal' THEN (CASE WHEN rate_until > now() THEN 'rate' ELSE '' END) ELSE pause_kind END
      WHERE id = 1 AND (pause_kind = 'refusal' OR noticed_reason <> '')`
  );
  return Boolean(r.rowCount);
}

interface ClaimedRow {
  id: number;
  attempts: number;
  transient_attempts: number;
  refusals: number;
  refused_at: Date | string | null;
  signin_failures: number;
  ledger_id: number | null;
  rcpt: string[];
}

/** Back to the queue, if the claim is still ours; `release`: nothing reached Microsoft, so the budget slot is given back. */
async function requeue(row: ClaimedRow, waitMs: number, error: string, opts: { release?: boolean; set?: string } = {}): Promise<boolean> {
  const r = await pool().query(
    `UPDATE mail_outbox SET status = 'queued', next_attempt_at = now() + ($3 || ' milliseconds')::interval, last_error = $4, claimed_by = NULL, claimed_at = NULL,
            posted_at = NULL, ledger_id = NULL, updated_at = now()${opts.set ? `, ${opts.set}` : ""}
      WHERE id = $1 AND ${MINE} RETURNING id`,
    [row.id, INSTANCE, String(Math.max(0, Math.round(waitMs))), error]
  );
  if (!r.rowCount) return false;
  if (opts.release) await releaseLedger(row.ledger_id);
  return true;
}

/** Failed or uncertain, if the claim is still ours. A failed send reached nothing: its slot is given back; an uncertain one may have. */
async function settle(row: ClaimedRow, status: "failed" | "uncertain", error: string): Promise<boolean> {
  const r = await pool().query(
    `UPDATE mail_outbox SET status = $3, last_error = $4, claimed_by = NULL, claimed_at = NULL, ledger_id = NULL, updated_at = now() WHERE id = $1 AND ${MINE} RETURNING id`,
    [row.id, INSTANCE, status, error]
  );
  if (!r.rowCount) return false;
  if (status === "failed") await releaseLedger(row.ledger_id);
  console.error(`[mail-outbox] #${row.id} ${status}: ${error}`);
  await noticeFailures();
  return true;
}

/** What to do with a send that did not go through. `posted`: the request may have left. */
async function handleFailure(row: ClaimedRow, e: unknown, posted: boolean, method: MailMethod = "m365"): Promise<void> {
  const msg = oneLine(e);
  let outcome = classifySendError(e as { status?: number; code?: string; kind?: string; name?: string });
  // Nothing left (the sign-in got no answer): try again with a growing wait (1, 2, 4… up to 10 minutes), its slot given back.
  if (!posted && outcome === "uncertain") {
    await requeue(row, Math.min(10 * 60_000, transientBackoffMs(row.signin_failures + 1)), msg, { release: true, set: "signin_failures = signin_failures + 1" });
    return;
  }
  if (!(e instanceof MailSendError) && !(e instanceof Error && e.name === "MailTooLargeError")) outcome = posted ? "uncertain" : "transient";
  switch (outcome) {
    case "rate": {
      // Not counted as an attempt: Microsoft took nothing and said when to come back.
      const err = e as MailSendError;
      const until = await pauseOutboxForRate(err.retryAfterMs, msg);
      await requeue(row, Math.max(MAIL_RATE_PAUSE_MIN_MS, until.getTime() - Date.now()), msg, { release: true });
      return;
    }
    case "repeat": {
      // Refused again although other mail went out since its last refusal: the refusal is this message's own.
      if (row.refusals > 0 && row.refused_at) {
        const since = await pool().query("SELECT 1 FROM mail_outbox WHERE status = 'sent' AND sent_at > $1 LIMIT 1", [row.refused_at]);
        if (since.rowCount) {
          await settle(row, "failed", msg);
          return;
        }
      }
      const n = row.refusals + 1;
      if (n >= MAIL_REFUSAL_ATTEMPTS) {
        await settle(row, "failed", `${msg} (refused ${n} times)`);
        return pauseOutboxForRefusal(msg);
      }
      // Rotate: back of the line, past the pause's end, so another message is the next one tried.
      await requeue(row, MAIL_REFUSAL_PAUSE_MS * n + 60_000, msg, { release: true, set: "refusals = refusals + 1, refused_at = now()" });
      return pauseOutboxForRefusal(msg);
    }
    case "uncertain":
      await settle(row, "uncertain", method === "acs" ? ACS_UNCERTAIN_REASON : UNCERTAIN_REASON);
      return;
    case "transient": {
      const n = row.transient_attempts + 1;
      if (n >= MAIL_TRANSIENT_ATTEMPTS) {
        await pool().query(`UPDATE mail_outbox SET transient_attempts = $3 WHERE id = $1 AND ${MINE}`, [row.id, INSTANCE, n]);
        await settle(row, "failed", msg);
        return;
      }
      await requeue(row, transientBackoffMs(n), msg, { release: true, set: "transient_attempts = transient_attempts + 1" });
      return;
    }
    default:
      await settle(row, "failed", msg);
  }
}

/** Stamp the claim as about to post, if it is still ours (refreshing it). False: someone took it back; send nothing. */
async function stampPosting(id: number, providerOp = ""): Promise<boolean> {
  const r = await pool().query(`UPDATE mail_outbox SET posted_at = clock_timestamp(), claimed_at = clock_timestamp(), provider_op = $3 WHERE id = $1 AND ${MINE} RETURNING id`, [id, INSTANCE, providerOp]);
  return Boolean(r.rowCount);
}

async function deliver(id: number, method: MailMethod): Promise<void> {
  const found = (
    await pool().query<Omit<ClaimedRow, "id"> & { mime: string | null }>(
      `SELECT mime, attempts, transient_attempts, refusals, refused_at, signin_failures, ledger_id, rcpt FROM mail_outbox WHERE id = $1 AND ${MINE}`,
      [id, INSTANCE]
    )
  ).rows[0];
  if (!found) return;
  const row: ClaimedRow = { ...found, id, ledger_id: found.ledger_id == null ? null : Number(found.ledger_id), rcpt: found.rcpt ?? [] };
  const b64 = found.mime ? openSecret(found.mime) : "";
  if (!b64) {
    await settle(row, "failed", UNREADABLE_BODY);
    return;
  }
  let mime: Buffer = Buffer.from(b64, "base64");
  if (method === "smtp") return deliverSmtp(row, mime);
  if (method === "acs") return deliverAcs(row, mime);
  const cfg = await getM365SendConfig();
  try {
    assertSendable(cfg, mime);
    // From the mailbox as it is now, not as it was when the message was queued.
    mime = await fromForMailbox(mime, cfg.mailbox, cfg.fromName);
    assertSendable(cfg, mime);
    if (!hooks.post) await signInForSend(cfg);
  } catch (e) {
    return handleFailure(row, e, false);
  }
  await hooks.beforePost?.(id);
  if (!(await stampPosting(id))) return;
  try {
    await (hooks.post ?? postMimeM365)(mime, cfg);
  } catch (e) {
    return handleFailure(row, e, true);
  }
  await markSent(id);
}

// --- Azure Communication Services (1.21.5) -----------------------------------------------------

const ACS_NOT_SET_UP = "Azure Communication Services isn't set up: set COMPASSDOCS_ACS_ENDPOINT and COMPASSDOCS_ACS_SENDER.";
/** The first look at an accepted send's result: ACS's Retry-After, within these bounds. */
const ACS_FIRST_CHECK_MIN_MS = 5_000;
const ACS_FIRST_CHECK_MAX_MS = 60_000;
/** Then looked at again after these waits (the last one repeats). */
const ACS_CHECK_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000];
/** Still running this long after it was handed over: uncertain, for an admin. */
const ACS_RESULT_GIVE_UP_MS = 2 * 3_600_000;
/** Lookups in one run (ACS limits them: 60 a minute, 200 an hour per subscription). */
const ACS_CHECKS_PER_RUN = 20;

/** One message through ACS: read back into ACS's JSON, a sign-in, then one POST with our own Operation-Id. */
async function deliverAcs(row: ClaimedRow, mime: Buffer): Promise<void> {
  const cfg = acsConfig();
  if (!cfg) {
    await requeue(row, MAIL_REFUSAL_PAUSE_MS, ACS_NOT_SET_UP, { release: true });
    return pauseOutboxForRefusal(ACS_NOT_SET_UP);
  }
  const acs = await import("./mail-acs");
  let req: Awaited<ReturnType<typeof acs.acsRequestFor>>;
  try {
    const { effectiveReplyTo } = await import("./mail-config");
    req = acs.acsRequestFor(mime, cfg, { rcpt: row.rcpt, replyTo: await effectiveReplyTo() });
    await acs.acsSignIn(cfg);
  } catch (e) {
    return handleFailure(row, e, false, "acs");
  }
  const operationId = randomUUID();
  await hooks.beforePost?.(row.id);
  if (!(await stampPosting(row.id, operationId))) return;
  let op: Awaited<ReturnType<typeof acs.postAcsEmail>>;
  try {
    op = await acs.postAcsEmail(req, cfg, operationId);
    countMail("acs", true);
  } catch (e) {
    countMail("acs", false);
    return handleFailure(row, e, true, "acs");
  }
  if (op.status === "Succeeded") {
    await markSent(row.id);
    return;
  }
  if (op.status === "Failed" || op.status === "Canceled") {
    await settle(row, "failed", acs.operationSentence(op));
    return;
  }
  const firstMs = Math.min(ACS_FIRST_CHECK_MAX_MS, Math.max(ACS_FIRST_CHECK_MIN_MS, op.retryAfterMs ?? 10_000));
  // Handed over: the budget slot stays spent (ACS counted it), the claim ends, the result is looked up later.
  await pool().query(
    `UPDATE mail_outbox SET status = 'accepted', provider_op = $3, provider_check_at = now() + ($4 || ' milliseconds')::interval, settle_checks = 0,
            last_error = '', claimed_by = NULL, claimed_at = NULL, ledger_id = NULL, updated_at = now()
      WHERE id = $1 AND ${MINE}`,
    [row.id, INSTANCE, op.id, String(firstMs)]
  );
  scheduleKick(firstMs);
}

/** Sent, from a row that is no longer claimed (accepted, or uncertain and found). */
async function resolveSent(id: number, from: "accepted" | "uncertain"): Promise<boolean> {
  const r = await pool().query(
    `UPDATE mail_outbox SET status = 'sent', sent_at = COALESCE(posted_at, now()), mime = NULL, last_error = '', provider_check_at = NULL, updated_at = now()
      WHERE id = $1 AND status = $2 RETURNING id`,
    [id, from]
  );
  return Boolean(r.rowCount);
}

/** Failed with ACS's reason (or uncertain, given up on), from a row that is no longer claimed. */
async function resolveProblem(id: number, from: "accepted" | "uncertain", status: "failed" | "uncertain", reason: string): Promise<void> {
  const r = await pool().query(
    `UPDATE mail_outbox SET status = $3, last_error = $4, provider_check_at = NULL, settle_checks = CASE WHEN $3 = 'uncertain' THEN 3 ELSE settle_checks END, updated_at = now()
      WHERE id = $1 AND status = $2 RETURNING id`,
    [id, from, status, reason.slice(0, 1000)]
  );
  if (!r.rowCount) return;
  console.error(`[mail-outbox] #${id} ${status}: ${reason}`);
  await noticeFailures();
}

type AcsLookup = Awaited<ReturnType<typeof import("./mail-acs").getAcsOperation>>;

/** What a looked-up operation means for a row in `from`. Answers false while it is still running. */
async function applyOperation(id: number, from: "accepted" | "uncertain", op: AcsLookup): Promise<boolean> {
  if (op.status === "Succeeded") {
    await resolveSent(id, from);
    return true;
  }
  if (op.status === "Failed" || op.status === "Canceled") {
    const { operationSentence } = await import("./mail-acs");
    await resolveProblem(id, from, "failed", operationSentence(op));
    return true;
  }
  return false;
}

/**
 * Look up the result of sends ACS accepted whose time has come (at most
 * ACS_CHECKS_PER_RUN, each row leased for two minutes so one instance looks
 * at a time). A 429 puts every waiting look off by its Retry-After. Answers
 * how many were settled. Never throws for one row.
 */
export async function checkAcceptedAcs(): Promise<number> {
  const cfg = acsConfig();
  if (!cfg) return 0;
  const rows = (
    await pool().query<{ id: string; provider_op: string; settle_checks: number; posted_ms: number | null }>(
      `UPDATE mail_outbox SET provider_check_at = now() + interval '2 minutes'
        WHERE id IN (SELECT id FROM mail_outbox WHERE status = 'accepted' AND provider_check_at <= now() ORDER BY provider_check_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, provider_op, settle_checks, (extract(epoch FROM posted_at) * 1000)::float8 AS posted_ms`,
      [ACS_CHECKS_PER_RUN]
    )
  ).rows;
  if (!rows.length) return 0;
  const { getAcsOperation } = await import("./mail-acs");
  let settled = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const id = Number(r.id);
    const later = async (ms: number, note = "") =>
      pool().query(
        `UPDATE mail_outbox SET settle_checks = settle_checks + 1, provider_check_at = now() + ($2 || ' milliseconds')::interval, last_error = $3, updated_at = now() WHERE id = $1 AND status = 'accepted'`,
        [id, String(ms), note.slice(0, 500)]
      );
    const tooOld = r.posted_ms != null && Date.now() - Number(r.posted_ms) > ACS_RESULT_GIVE_UP_MS;
    const backoff = ACS_CHECK_BACKOFF_MS[Math.min(r.settle_checks, ACS_CHECK_BACKOFF_MS.length - 1)];
    try {
      const op = await getAcsOperation(r.provider_op, cfg);
      if (await applyOperation(id, "accepted", op)) settled++;
      else if (tooOld) await resolveProblem(id, "accepted", "uncertain", ACS_NO_RESULT_REASON);
      else await later(Math.max(backoff, op.retryAfterMs ?? 0));
    } catch (e) {
      const err = e as { status?: number; retryAfterMs?: number | null; code?: string };
      if (err.status === 429) {
        // ACS's status lookups are limited too: this one and every other in the run wait.
        const ms = Math.max(MAIL_RATE_PAUSE_MIN_MS, err.retryAfterMs ?? MAIL_RATE_PAUSE_MIN_MS);
        const ids = rows.slice(i).map((x) => x.id);
        await pool().query("UPDATE mail_outbox SET provider_check_at = now() + ($2 || ' milliseconds')::interval WHERE id = ANY($1::bigint[]) AND status = 'accepted'", [ids, String(ms)]);
        break;
      }
      if (tooOld) await resolveProblem(id, "accepted", "uncertain", ACS_NO_RESULT_REASON);
      else await later(backoff, err.code === "not_found" ? "" : oneLine(e));
    }
  }
  return settled;
}

/**
 * An uncertain row that went to ACS (no answer to the POST): its operation
 * is ours, so it is looked up. Found and finished: settled; found and still
 * running: accepted (looked up again like the rest); not found: another look
 * a minute later, three in all, then it waits for an admin.
 */
async function settleUncertainAcs(): Promise<number> {
  const cfg = acsConfig();
  if (!cfg) return 0;
  const rows = (
    await pool().query<{ id: string; provider_op: string }>(
      `SELECT id, provider_op FROM mail_outbox WHERE status = 'uncertain' AND settle_checks < 3 AND provider_op <> ''
          AND updated_at < now() - interval '1 minute' ORDER BY id LIMIT 5`
    )
  ).rows;
  if (!rows.length) return 0;
  const { getAcsOperation } = await import("./mail-acs");
  let settled = 0;
  for (const r of rows) {
    const id = Number(r.id);
    try {
      const op = await getAcsOperation(r.provider_op, cfg);
      if (await applyOperation(id, "uncertain", op)) settled++;
      else {
        await pool().query(
          "UPDATE mail_outbox SET status = 'accepted', last_error = '', settle_checks = 0, provider_check_at = now() + interval '30 seconds', updated_at = now() WHERE id = $1 AND status = 'uncertain'",
          [id]
        );
      }
    } catch (e) {
      if ((e as { status?: number }).status === 429) break;
      await pool().query("UPDATE mail_outbox SET settle_checks = settle_checks + 1, updated_at = now() WHERE id = $1 AND status = 'uncertain'", [id]);
    }
  }
  return settled;
}

/** A leftover row after a switch to SMTP: the same message, From the SMTP From, to the same people. */
async function deliverSmtp(row: ClaimedRow, mime: Buffer): Promise<void> {
  const { getSmtpConfig, smtpConfigured } = await import("./smtp-config");
  const cfg = await getSmtpConfig();
  if (!hooks.smtp && !smtpConfigured(cfg)) {
    await requeue(row, MAIL_REFUSAL_PAUSE_MS, MAIL_NOT_SET_UP);
    return;
  }
  const from = cfg.from || "compassdocs@localhost";
  const raw = replaceFrom(mime, await headerFor("from", from));
  const envelope = { from: bareAddress(from), to: row.rcpt };
  if (!envelope.to.length) {
    await settle(row, "failed", NO_USABLE_RECIPIENT);
    return;
  }
  // Stamped before the hand-over: a crash in the middle is taken back as uncertain, never sent again by itself.
  if (!(await stampPosting(row.id))) return;
  try {
    if (hooks.smtp) await hooks.smtp(raw, envelope);
    else {
      const { smtpTransportFor } = await import("./mailer");
      await smtpTransportFor(cfg).sendMail({ envelope, raw });
    }
  } catch (e) {
    const code = Number((e as { responseCode?: unknown })?.responseCode ?? 0);
    const n = row.transient_attempts + 1;
    if (code >= 500 || n >= MAIL_TRANSIENT_ATTEMPTS) {
      await settle(row, "failed", oneLine(e));
      return;
    }
    await requeue(row, transientBackoffMs(n), oneLine(e), { set: "transient_attempts = transient_attempts + 1" });
    return;
  }
  await markSent(row.id);
}

let draining = false;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let timerAt = 0;

function scheduleKick(ms: number): void {
  if (!autoDrain() || ms > 65_000) return; // the minute tick picks up anything later
  const at = Date.now() + ms;
  if (timer && timerAt <= at) return;
  if (timer) clearTimeout(timer);
  timerAt = at;
  timer = setTimeout(() => {
    timer = null;
    kickOutbox();
  }, Math.max(20, ms + 20));
  timer.unref?.();
}

/** Start the worker in this instance (no-op while it runs; it looks again when done). Never throws. */
export function kickOutbox(): void {
  if (draining) {
    again = true;
    return;
  }
  void drain().catch((e) => console.error("[mail-outbox] worker error:", oneLine(e)));
}

async function drain(): Promise<{ sent: number; waitMs: number | null }> {
  draining = true;
  let handled = 0;
  let waitMs: number | null = null;
  try {
    // 1.21.5: the results ACS owes us first (cheap when there are none).
    if (acsSelected()) {
      await checkAcceptedAcs().catch((e) => console.error("[mail-outbox] ACS result lookup failed:", oneLine(e)));
      const next = (await pool().query<{ ms: number | null }>("SELECT (extract(epoch FROM min(provider_check_at) - clock_timestamp()) * 1000)::float8 AS ms FROM mail_outbox WHERE status = 'accepted'")).rows[0];
      if (next?.ms != null) scheduleKick(Math.max(0, Number(next.ms)));
    }
    for (let i = 0; i < 1000; i++) {
      again = false;
      const method = await getMailMethod();
      const c = await claimNext(method);
      if (c.kind === "row") {
        await deliver(c.id, method);
        handled++;
        continue;
      }
      waitMs = c.kind === "wait" ? c.waitMs : c.nextMs;
      if (waitMs !== null) scheduleKick(waitMs);
      if (!again) break;
    }
  } finally {
    draining = false;
  }
  if (again && autoDrain()) kickOutbox();
  return { sent: handled, waitMs };
}

/** Tests: run the worker now and wait for it (handled rows; how long until the next could go). */
export async function drainOutboxForTests(): Promise<{ sent: number; waitMs: number | null }> {
  while (draining) await new Promise((r) => setTimeout(r, 10));
  return drain();
}

/** A row left `sending` by an instance that died: back to queued when it was never posted, else uncertain. */
export async function reclaimStale(olderThanMs = MAIL_OUTBOX_CLAIM_MS): Promise<{ requeued: number; uncertain: number }> {
  const r = await pool().query<{ status: string; old_ledger: string | null }>(
    `WITH stale AS (
       SELECT id, ledger_id FROM mail_outbox
        WHERE status = 'sending' AND claimed_at < clock_timestamp() - ($1 || ' milliseconds')::interval FOR UPDATE SKIP LOCKED)
     UPDATE mail_outbox m SET
        status = CASE WHEN m.posted_at IS NULL THEN 'queued' ELSE 'uncertain' END,
        last_error = CASE WHEN m.posted_at IS NULL THEN m.last_error ELSE $2 END,
        next_attempt_at = now(), claimed_by = NULL, claimed_at = NULL, ledger_id = NULL, updated_at = now()
       FROM stale WHERE m.id = stale.id
     RETURNING m.status, CASE WHEN m.status = 'queued' THEN stale.ledger_id END AS old_ledger`,
    [String(olderThanMs), UNCERTAIN_REASON]
  );
  // Never posted: nothing reached Microsoft, so the budget slot goes back.
  const give = r.rows.map((x) => x.old_ledger).filter((x): x is string => x != null);
  if (give.length) await pool().query("DELETE FROM mail_send_ledger WHERE id = ANY($1::bigint[])", [give]);
  const uncertain = r.rows.filter((x) => x.status === "uncertain").length;
  if (uncertain) await noticeFailures();
  return { requeued: r.rows.length - uncertain, uncertain };
}

/**
 * Uncertain rows the app may be able to settle: a message with its
 * Message-ID in the mailbox's Sent Items went out. Three looks at most, a
 * minute apart; an app that may not read the mailbox (the usual case)
 * answers "unknown" and the row waits for an admin.
 */
export async function settleUncertain(): Promise<number> {
  const method = await getMailMethod();
  if (method === "acs") return settleUncertainAcs();
  if (method !== "m365") return 0;
  const rows = (
    await pool().query<{ id: string; message_id: string }>(
      `SELECT id, message_id FROM mail_outbox WHERE status = 'uncertain' AND settle_checks < 3 AND message_id <> ''
          AND updated_at < now() - interval '1 minute' ORDER BY id LIMIT 5`
    )
  ).rows;
  let settled = 0;
  const cfg = rows.length ? await getM365SendConfig() : null;
  for (const r of rows) {
    const found = await findInSentItems(r.message_id, cfg ?? undefined);
    if (found === "found") {
      await pool().query("UPDATE mail_outbox SET status = 'sent', sent_at = COALESCE(posted_at, now()), mime = NULL, last_error = '', updated_at = now() WHERE id = $1 AND status = 'uncertain'", [r.id]);
      settled++;
    } else {
      // Not there (yet): look again a minute later. Not readable: stop looking.
      await pool().query("UPDATE mail_outbox SET settle_checks = CASE WHEN $2 THEN 3 ELSE settle_checks + 1 END, updated_at = now() WHERE id = $1", [r.id, found === "unknown"]);
    }
  }
  return settled;
}

/** Sent, discarded, failed and uncertain rows after 30 days, and the budget's rows after a day (lib/db runDbMaintenance). */
export async function pruneOutbox(): Promise<void> {
  await pool().query(`DELETE FROM mail_outbox WHERE status IN ('sent', 'discarded', 'failed', 'uncertain') AND updated_at < now() - make_interval(days => ${MAIL_OUTBOX_KEEP_DAYS})`);
  await pool().query("DELETE FROM mail_send_ledger WHERE at < now() - interval '25 hours'");
}

/** The minute tick (instrumentation): take back dead claims, settle what can be, and send. Never throws. */
export async function outboxTick(): Promise<void> {
  try {
    await reclaimStale();
    await settleUncertain();
    // 1.21.5: sends ACS accepted whose result can no longer be looked up (ACS is no longer chosen): uncertain after two hours, for an admin.
    if (!acsConfig()) {
      await pool().query(
        `UPDATE mail_outbox SET status = 'uncertain', last_error = $1, settle_checks = 3, provider_check_at = NULL, updated_at = now()
          WHERE status = 'accepted' AND posted_at < now() - interval '2 hours'`,
        [ACS_NO_RESULT_REASON]
      );
    }
    // 1.21.5: ACS results are looked up by the worker each time it runs (drain), which this starts.
    kickOutbox();
  } catch (e) {
    console.error("[mail-outbox] tick error:", oneLine(e));
  }
}

// --- The admin's view and actions ------------------------------------------------------------------

export async function outboxView(): Promise<OutboxView> {
  const [method, counts, day, ctl, problems, waiting] = await Promise.all([
    getMailMethod(),
    pool().query<{ queued: number; urgent: number; sent_hour: number; problems: number }>(
      `SELECT count(*) FILTER (WHERE status IN ('queued', 'sending', 'accepted'))::int AS queued,
              count(*) FILTER (WHERE status = 'queued' AND priority = 0)::int AS urgent,
              count(*) FILTER (WHERE status = 'sent' AND sent_at > now() - interval '1 hour')::int AS sent_hour,
              count(*) FILTER (WHERE status IN ('failed', 'uncertain'))::int AS problems
         FROM mail_outbox`
    ),
    pool().query<{ n: number }>("SELECT COALESCE(sum(recipients), 0)::int AS n FROM mail_send_ledger WHERE at > now() - interval '24 hours'"),
    pool().query<{ paused_until: Date | null; pause_reason: string; pause_kind: string }>("SELECT paused_until, pause_reason, pause_kind FROM mail_outbox_control WHERE id = 1"),
    pool().query<{ id: string; status: "failed" | "uncertain"; kind: string; subject: string; recipients: string; recipient_count: number; created_at: Date; updated_at: Date; last_error: string; has_body: boolean }>(
      `SELECT id, status, kind, subject, recipients, recipient_count, created_at, updated_at, last_error, mime IS NOT NULL AS has_body
         FROM mail_outbox WHERE status IN ('failed', 'uncertain') ORDER BY updated_at DESC, id DESC LIMIT 50`
    ),
    pool().query<{ id: string; status: "queued" | "sending"; kind: string; priority: number; subject: string; recipients: string; recipient_count: number; queued_at: Date; next_attempt_at: Date; last_error: string }>(
      `SELECT id, CASE WHEN status = 'accepted' THEN 'sending' ELSE status END AS status, kind, priority, subject, recipients, recipient_count, queued_at,
              COALESCE(provider_check_at, next_attempt_at) AS next_attempt_at,
              CASE WHEN status = 'accepted' THEN 'Handed to Azure Communication Services; waiting for its result.' ELSE last_error END AS last_error
         FROM mail_outbox WHERE status IN ('queued', 'sending', 'accepted') ORDER BY priority, id LIMIT 50`
    ),
  ]);
  const c = counts.rows[0];
  const p = ctl.rows[0];
  const pausedNow = p && p.paused_until && new Date(p.paused_until).getTime() > Date.now();
  const lim = limits(pacedMethod(method) ? method : "m365");
  return {
    m365: method === "m365",
    method,
    per_hour: Number.isFinite(lim.perHour) ? lim.perHour : null,
    queued: c?.queued ?? 0,
    queued_urgent: c?.urgent ?? 0,
    sent_last_hour: c?.sent_hour ?? 0,
    day_recipients: day.rows[0]?.n ?? 0,
    daily_limit: MAIL_DAILY_RECIPIENT_LIMIT,
    daily_cap: lim.safeCap,
    per_minute: lim.perMinute,
    paused: pausedNow ? { until: new Date(p.paused_until!).toISOString(), reason: p.pause_reason, kind: p.pause_kind === "refusal" ? "refusal" : "rate" } : null,
    problems: problems.rows.map(
      (r): OutboxProblem => ({
        id: Number(r.id),
        status: r.status,
        kind: r.kind,
        subject: r.subject,
        recipients: r.recipients.length > 300 ? `${r.recipients.slice(0, 300)}…` : r.recipients,
        recipient_count: r.recipient_count,
        created_at: new Date(r.created_at).toISOString(),
        updated_at: new Date(r.updated_at).toISOString(),
        reason: r.last_error,
        can_retry: r.has_body,
      })
    ),
    problems_total: c?.problems ?? 0,
    waiting: waiting.rows.map(
      (r): OutboxWaiting => ({
        id: Number(r.id),
        status: r.status,
        kind: r.kind,
        priority: r.priority as MailPriority,
        subject: r.subject,
        recipients: r.recipients.length > 300 ? `${r.recipients.slice(0, 300)}…` : r.recipients,
        recipient_count: r.recipient_count,
        queued_at: new Date(r.queued_at).toISOString(),
        next_attempt_at: new Date(r.next_attempt_at).toISOString(),
        reason: r.last_error,
      })
    ),
  };
}

export class OutboxError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

/** Retry a failed or uncertain message: queued again with the body it was built with, its counts from zero. Audited (unless `audited: false`, when the caller audits). */
export async function retryOutboxMessage(id: number, by: { actor: AuditActor; ip?: string | null }, opts: { audited?: boolean } = {}): Promise<{ was: string; kind: string; subject: string; recipient_count: number }> {
  const r = await pool().query<{ was: string; kind: string; subject: string; recipient_count: number }>(
    `WITH old AS (SELECT id, status FROM mail_outbox WHERE id = $1 FOR UPDATE)
     UPDATE mail_outbox m SET status = 'queued', next_attempt_at = now(), queued_at = now(), last_error = '', settle_checks = 0, attempts = 0, transient_attempts = 0,
            refusals = 0, refused_at = NULL, signin_failures = 0, claimed_by = NULL, claimed_at = NULL, posted_at = NULL, ledger_id = NULL,
            provider_op = '', provider_check_at = NULL, updated_at = now()
       FROM old WHERE m.id = old.id AND old.status IN ('failed', 'uncertain') AND m.mime IS NOT NULL
     RETURNING old.status AS was, m.kind, m.subject, m.recipient_count`,
    [id]
  );
  const row = r.rows[0];
  if (!row) throw new OutboxError("That email can't be retried: it was sent, discarded, or its body is gone.", 409);
  if (opts.audited !== false) {
    await audit({
      actor: by.actor,
      action: "settings.mail_outbox_retry",
      targetType: "settings",
      targetId: "mail",
      targetLabel: "Email outbox",
      details: { id, was: row.was, kind: row.kind, subject: row.subject.slice(0, 200), recipients: row.recipient_count },
      ip: by.ip ?? null,
    });
  }
  if (autoDrain()) kickOutbox();
  return row;
}

/** Discard a failed, uncertain or waiting message: never sent, its body wiped. Audited. */
export async function discardOutboxMessage(id: number, by: { actor: AuditActor; ip?: string | null }): Promise<void> {
  const r = await pool().query<{ was: string; kind: string; subject: string; recipient_count: number }>(
    `WITH old AS (SELECT id, status FROM mail_outbox WHERE id = $1 FOR UPDATE)
     UPDATE mail_outbox m SET status = 'discarded', mime = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = now()
       FROM old WHERE m.id = old.id AND old.status IN ('failed', 'uncertain', 'queued')
     RETURNING old.status AS was, m.kind, m.subject, m.recipient_count`,
    [id]
  );
  const row = r.rows[0];
  if (!row) throw new OutboxError("That email can't be discarded: it is being sent, or it was sent or discarded already.", 409);
  await audit({
    actor: by.actor,
    action: "settings.mail_outbox_discard",
    targetType: "settings",
    targetId: "mail",
    targetLabel: "Email outbox",
    details: { id, was: row.was, kind: row.kind, subject: row.subject.slice(0, 200), recipients: row.recipient_count },
    ip: by.ip ?? null,
  });
}

/**
 * Discard every message still waiting in the queue (not one being sent this
 * moment): never sent, bodies wiped. The way out before a switch to SMTP, or
 * of a queue an admin no longer wants. Audited once, with the count.
 */
export async function discardAllWaiting(by: { actor: AuditActor; ip?: string | null }): Promise<number> {
  const r = await pool().query<{ id: string }>(
    "UPDATE mail_outbox SET status = 'discarded', mime = NULL, updated_at = now() WHERE status = 'queued' RETURNING id"
  );
  const n = r.rowCount ?? 0;
  await audit({ actor: by.actor, action: "settings.mail_outbox_discard_all", targetType: "settings", targetId: "mail", targetLabel: "Email outbox", details: { discarded: n }, ip: by.ip ?? null });
  return n;
}

/** How many messages are still waiting (queued or being sent): the switch away from Microsoft 365 says so. */
export async function outboxWaiting(): Promise<number> {
  try {
    return (await pool().query<{ n: number }>("SELECT count(*)::int AS n FROM mail_outbox WHERE status IN ('queued', 'sending')")).rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * 1.20.32: the desk's Send again on a reply (lib/helpdesk/messages): every
 * copy of it that failed or may not have gone out is queued again with the
 * body it was built with. Answers how many; audited as the agent's.
 */
export async function resendForRef(
  ref: { type: string; id: number },
  by: { actor: AuditActor; ip?: string | null },
  /** The desk's ticket, for the audit row. */
  ticket?: { id: number; number: number; subject?: string }
): Promise<number> {
  const rows = (
    await pool().query<{ id: string }>("SELECT id FROM mail_outbox WHERE ref_type = $1 AND ref_id = $2 AND status IN ('failed', 'uncertain') AND mime IS NOT NULL ORDER BY id", [ref.type, ref.id])
  ).rows;
  const done: { id: number; was: string }[] = [];
  for (const r of rows) {
    try {
      const row = await retryOutboxMessage(Number(r.id), by, { audited: false });
      done.push({ id: Number(r.id), was: row.was });
    } catch (e) {
      if (!(e instanceof OutboxError)) throw e;
    }
  }
  if (done.length) {
    await audit({
      actor: by.actor,
      action: "helpdesk.reply_mail_resent",
      targetType: ticket ? "helpdesk_ticket" : "settings",
      targetId: ticket ? ticket.id : "mail",
      targetLabel: ticket ? `#${ticket.number}${ticket.subject ? ` ${ticket.subject.slice(0, 120)}` : ""}` : "Email outbox",
      details: { ticket: ticket?.number ?? null, message: ref.id, emails: done.map((d) => d.id), was: done.map((d) => d.was) },
      ip: by.ip ?? null,
    });
  }
  return done.length;
}
