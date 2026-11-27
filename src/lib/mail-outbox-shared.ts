// 1.20.32: the outbox for the workspace's email through Microsoft 365, the
// pure half (no database, no server-only imports): the limits, the priority
// of each kind of mail, the pacing arithmetic, how a refusal is read, and
// the shapes the Email settings page and the desk read. The server half is
// lib/mail-outbox.
//
// Exchange Online lets one mailbox send about 30 messages a minute and
// 10,000 recipients a day. The outbox keeps under both, for the whole
// workspace (every instance together):
//
//   pace      at most MAIL_SENDS_PER_MINUTE sends in any 60 seconds, and at
//             least 60 s / that apart, so a burst is spread over the minute
//             instead of going out at its top.
//   per day   at most MAIL_DAILY_SAFE_CAP recipients in any 24 hours; the
//             rest waits (queued, never bounced). Urgent mail (a sign-in
//             link, a helpdesk reply to a requester) may use the margin, up
//             to MAIL_DAILY_URGENT_CAP.
//   order     urgent first, then ordinary notifications, then bulk
//             (digests, announcements, reminders, subscriber mail,
//             newsletters); oldest first within each.
//
// 1.21.5: Azure Communication Services (lib/mail-acs) goes through the same
// outbox with its own limits (acsPace): COMPASSDOCS_ACS_PER_MINUTE and
// COMPASSDOCS_ACS_PER_HOUR emails (30 and 100 by default, ACS's defaults for
// a custom domain, which hold for the whole Azure subscription), at most 50
// recipients each, and no daily recipient cap of its own.

import type { MailMethod } from "./mail-m365-shared";

/** Exchange Online's limit, recipients a day for one mailbox. */
export const MAIL_DAILY_RECIPIENT_LIMIT = 10_000;
/** Ordinary and bulk mail stop here, leaving a margin under the limit. */
export const MAIL_DAILY_SAFE_CAP = 9_500;
/** Urgent mail may use the margin, up to here (a little is left for people sending from the mailbox themselves). */
export const MAIL_DAILY_URGENT_CAP = 9_900;
/** Sends in any 60 seconds, under Exchange Online's 30 a minute. */
export const MAIL_SENDS_PER_MINUTE = 25;
/** Microsoft asking to slow down pauses everything at least this long. */
export const MAIL_RATE_PAUSE_MIN_MS = 60_000;
/** A refusal that repeats for everyone pauses the outbox; it tries once more after this long (or as soon as the settings are saved). */
export const MAIL_REFUSAL_PAUSE_MS = 10 * 60_000;
/** Sent, discarded, failed and uncertain rows are pruned after this many days. */
export const MAIL_OUTBOX_KEEP_DAYS = 30;
/** A row claimed this long ago by an instance that never finished it is taken back. */
export const MAIL_OUTBOX_CLAIM_MS = 3 * 60_000;

export const PRIORITY = { urgent: 0, normal: 1, bulk: 2 } as const;
export type MailPriority = (typeof PRIORITY)[keyof typeof PRIORITY];

/**
 * What a message is, for the order it goes out in and the admin's list.
 * Urgent: someone is waiting for it right now. Bulk: it can wait an hour.
 */
const URGENT_KINDS = new Set(["password_reset", "sign_in_link", "verification", "invite", "helpdesk_reply"]);
const BULK_KINDS = new Set([
  "digest",
  "notification_digest",
  "team_digest",
  "announcement",
  "training",
  "review",
  "subscription",
  "newsletter",
  "compliance",
  "compliance_report",
  "directory_export",
  "helpdesk_report",
]);

export function mailPriority(kind: string | undefined | null): MailPriority {
  const k = (kind ?? "").trim();
  if (URGENT_KINDS.has(k)) return PRIORITY.urgent;
  if (BULK_KINDS.has(k)) return PRIORITY.bulk;
  return PRIORITY.normal;
}

export const PRIORITY_LABEL: Record<MailPriority, string> = { 0: "Urgent", 1: "Normal", 2: "Bulk" };

/** The kind as the admin's list says it. */
export function kindLabel(kind: string): string {
  const k = kind.trim();
  if (!k) return "Email";
  const known: Record<string, string> = {
    password_reset: "Password reset",
    sign_in_link: "Sign-in link",
    verification: "Verification",
    invite: "Invitation",
    helpdesk_reply: "Helpdesk reply",
    helpdesk_notice: "Helpdesk notice",
    helpdesk_report: "Helpdesk report",
    digest: "Weekly digest",
    notification_digest: "Notification digest",
    team_digest: "Team digest",
    announcement: "Announcement",
    training: "Training reminder",
    review: "Review reminder",
    subscription: "Subscription",
    newsletter: "Newsletter",
    newsletter_test: "Newsletter test",
    compliance: "Read confirmation",
    compliance_report: "Compliance report",
    directory_export: "Directory export",
    directory_report: "Directory sync report",
    mention: "Mention",
    webhook_alert: "Webhook alert",
    workflow_notice: "Newsletter review",
  };
  return known[k] ?? k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// --- Pacing ---------------------------------------------------------------------------------

export interface PaceLimits {
  perMinute: number;
  /** 1.21.5: sends in any 60 minutes (Infinity: no such limit, Microsoft 365). */
  perHour: number;
  /** The least time between two sends; 0 = none (tests). */
  gapMs: number;
  safeCap: number;
  urgentCap: number;
}

export const DEFAULT_PACE: PaceLimits = {
  perMinute: MAIL_SENDS_PER_MINUTE,
  perHour: Number.POSITIVE_INFINITY,
  gapMs: Math.ceil(60_000 / MAIL_SENDS_PER_MINUTE),
  safeCap: MAIL_DAILY_SAFE_CAP,
  urgentCap: MAIL_DAILY_URGENT_CAP,
};

/** 1.21.5: no daily recipient cap through ACS (its quota is per minute and per hour). */
const NO_DAILY_CAP = Number.MAX_SAFE_INTEGER;

/** The outbox's limits through Azure Communication Services: the configured share of the subscription's quota. */
export function acsPace(perMinute: number, perHour: number): PaceLimits {
  const m = Math.max(1, Math.floor(perMinute));
  return { perMinute: m, perHour: Math.max(1, Math.floor(perHour)), gapMs: Math.ceil(60_000 / m), safeCap: NO_DAILY_CAP, urgentCap: NO_DAILY_CAP };
}

export interface PaceState {
  nowMs: number;
  /** The pause's end, when the outbox is paused (null or past: not paused). */
  pausedUntilMs: number | null;
  /** The last send handed to Microsoft (null: none in the last day). */
  lastAtMs: number | null;
  /** Sends in the last 60 seconds, oldest first. */
  minute: number[];
  /** 1.21.5: sends in the last 60 minutes, oldest first (only read when the limits have a perHour). */
  hour?: number[];
  /** Recipients sent to in the last 24 hours. */
  dayRecipients: number;
}

export type PaceDecision = { ok: true } | { ok: false; why: "paused" | "gap" | "minute" | "hour" | "daily"; waitMs: number };

/**
 * Whether one more message to `recipients` people may go now, and if not
 * how long until it may (except for "daily", whose wait needs the day's
 * sends: dailyWaitMs). Pure, so it is tested on its own.
 */
export function paceDecision(s: PaceState, recipients: number, priority: MailPriority, limits: PaceLimits = DEFAULT_PACE): PaceDecision {
  if (s.pausedUntilMs !== null && s.pausedUntilMs > s.nowMs) return { ok: false, why: "paused", waitMs: s.pausedUntilMs - s.nowMs };
  const cap = priority === PRIORITY.urgent ? limits.urgentCap : limits.safeCap;
  if (s.dayRecipients + Math.max(1, recipients) > cap) return { ok: false, why: "daily", waitMs: 0 };
  const hour = s.hour ?? [];
  if (Number.isFinite(limits.perHour) && hour.length >= limits.perHour) {
    const oldest = hour[hour.length - limits.perHour];
    return { ok: false, why: "hour", waitMs: Math.max(1, oldest + 3_600_000 - s.nowMs) };
  }
  if (s.minute.length >= limits.perMinute) {
    const oldest = s.minute[s.minute.length - limits.perMinute];
    return { ok: false, why: "minute", waitMs: Math.max(1, oldest + 60_000 - s.nowMs) };
  }
  if (limits.gapMs > 0 && s.lastAtMs !== null && s.nowMs - s.lastAtMs < limits.gapMs) {
    return { ok: false, why: "gap", waitMs: Math.max(1, s.lastAtMs + limits.gapMs - s.nowMs) };
  }
  return { ok: true };
}

/**
 * Over the daily cap: how long until enough of the last 24 hours' sends
 * (`sends`, oldest first) have aged out for `recipients` more to fit under
 * `cap`. At least a minute, so a full day is not polled.
 */
export function dailyWaitMs(sends: { atMs: number; recipients: number }[], nowMs: number, recipients: number, cap: number): number {
  let used = sends.reduce((n, x) => n + x.recipients, 0);
  const need = Math.max(1, recipients);
  for (const x of sends) {
    if (used + need <= cap) break;
    used -= x.recipients;
    if (used + need <= cap) return Math.max(60_000, x.atMs + 86_400_000 - nowMs);
  }
  return used + need <= cap ? 60_000 : 86_400_000;
}

// --- Reading a refusal ----------------------------------------------------------------------

/**
 * What a failed send means for the outbox, from the error's shape (a
 * MailSendError from lib/mail-m365: the HTTP status, 0 when nothing came
 * back; Graph's code; the kind: "auth" for a refused sign-in, "timeout" or
 * "network" when no answer came).
 *
 *   rate       Microsoft asks to slow down (429, or 503 with Retry-After):
 *              the row stays queued and the whole outbox pauses.
 *   repeat     the same refusal would come for every message (the app may
 *              not sign in or send as the mailbox, the mailbox is gone, the
 *              settings are incomplete or unreadable): pause with the reason.
 *   uncertain  the request left and nothing came back (a timeout, a cut
 *              connection, a gateway timeout): it may have gone out, so it
 *              is never sent again by itself.
 *   transient  Microsoft answered that it had a problem (500, 502): nothing
 *              was accepted; tried again a few times, then failed.
 *   failed     this message is refused (too large, a bad recipient): kept
 *              with the sentence.
 */
export type SendOutcome = "rate" | "repeat" | "uncertain" | "transient" | "failed";

export function classifySendError(e: { status?: number; code?: string; kind?: string; name?: string } | null | undefined): SendOutcome {
  // 1.21.5 (lib/mail-acs): "config" is a setting every message shares (the sender, the endpoint).
  const status = Number(e?.status ?? 0);
  const code = String(e?.code ?? "").toLowerCase();
  const kind = String(e?.kind ?? "");
  if (e?.name === "MailTooLargeError" || kind === "too_large") return "failed";
  if (status === 429 || status === 503) return "rate";
  if (kind === "auth" || kind === "config" || code === "not_set_up" || code === "secret_unreadable" || status === 401 || status === 403 || status === 404) return "repeat";
  if (code === "errorsendasdenied" || code === "mailboxnotenabledforrestapi" || code === "mailboxnotsupportedforrestapi" || code === "errorinvaliduser") return "repeat";
  if (status === 0) return kind === "blocked" ? "repeat" : "uncertain";
  if (status === 504) return "uncertain";
  if (status >= 500) return "transient";
  return "failed";
}

/** Transient refusals (500, 502) are tried this many times in all before the row fails. 429s are not counted. */
export const MAIL_TRANSIENT_ATTEMPTS = 5;

/**
 * A row refused this many times with a refusal that "repeats for everyone"
 * fails with the reason, so one message can never hold the outbox for good.
 * (A row refused again after other mail went out since its last refusal
 * fails at once: the refusal is its own.)
 */
export const MAIL_REFUSAL_ATTEMPTS = 5;

/** Microsoft Graph takes at most 500 recipients in one message. */
export const MAIL_MAX_RECIPIENTS = 500;

/** The sentence for a message to more people than one send can take. */
export function tooManyRecipients(n: number, cap: number, method: MailMethod = "m365"): string {
  const who = method === "acs" ? "Azure Communication Services" : "Microsoft 365";
  return `This email has ${n} recipients. ${who} takes at most ${cap} in one email from this workspace: send it in smaller groups.`;
}

/** The wait before the next try of a transient refusal: 1, 2, 4, 8 minutes. */
export const transientBackoffMs = (attempts: number) => Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));

export const UNCERTAIN_REASON = "Microsoft didn't answer, so this may have gone out. Check the sending mailbox's Sent Items, then Retry or Discard.";
/** 1.21.5: no answer from ACS after the request left; the outbox looks the send up by its operation id. */
export const ACS_UNCERTAIN_REASON = "Azure Communication Services didn't answer, so this may have gone out. It is looked up again shortly; if it can't be found, Retry or Discard.";
/** 1.21.5: ACS accepted it and never said how it went. */
export const ACS_NO_RESULT_REASON = "Azure Communication Services accepted this email but never said whether it was delivered. Check the resource's email logs, then Retry or Discard.";
export const UNREADABLE_BODY = "This email can't be read any more: the server's secret key changed since it was queued. Discard it.";

// --- Shapes ---------------------------------------------------------------------------------

/** 1.21.5: "accepted": handed to ACS, its result not known yet (lib/mail-outbox looks it up). */
export type OutboxStatus = "queued" | "sending" | "accepted" | "sent" | "failed" | "uncertain" | "discarded";

/** A failed or uncertain message, as the admin's list shows it. */
export interface OutboxProblem {
  id: number;
  status: "failed" | "uncertain";
  kind: string;
  subject: string;
  recipients: string;
  recipient_count: number;
  created_at: string;
  updated_at: string;
  reason: string;
  /** The body is still kept, so Retry can send it. */
  can_retry: boolean;
}

/** GET /api/admin/mail/outbox. */
export interface OutboxView {
  /** Mail goes out through Microsoft 365 now. */
  m365: boolean;
  /** 1.21.5: how mail goes out now (the outbox paces "m365" and "acs"). */
  method: MailMethod;
  /** 1.21.5: sends allowed in any hour (ACS), null when there is no hourly limit. */
  per_hour: number | null;
  queued: number;
  /** Queued messages that are urgent. */
  queued_urgent: number;
  sent_last_hour: number;
  /** Recipients sent to in the last 24 hours, against the limits. */
  day_recipients: number;
  daily_limit: number;
  daily_cap: number;
  per_minute: number;
  paused: { until: string | null; reason: string; kind: "rate" | "refusal" } | null;
  problems: OutboxProblem[];
  /** More problems than the list holds. */
  problems_total: number;
  /** The first messages still waiting (queued or being sent), oldest first by priority; `queued` is how many in all. */
  waiting: OutboxWaiting[];
}

/** A message still waiting, as the admin's list shows it (so it can be discarded, say before a switch to SMTP). */
export interface OutboxWaiting {
  id: number;
  status: "queued" | "sending";
  kind: string;
  priority: MailPriority;
  subject: string;
  recipients: string;
  recipient_count: number;
  queued_at: string;
  next_attempt_at: string;
  /** Why the last try did not go (a slow-down, a refusal); '' on the first wait. */
  reason: string;
}

/** A desk message's email, as the agent sees it on the ticket (lib/helpdesk/messages). */
export interface MessageMailState {
  state: "failed" | "uncertain" | "queued" | "discarded";
  /** Who the copy that did not go out was for. */
  to: string;
  reason: string;
  /** Send again is possible (the body is still kept). */
  can_resend: boolean;
}

/** "in 3 minutes", "in 40 seconds", for a pause's end. */
export function untilWords(untilMs: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.round((untilMs - nowMs) / 1000));
  if (s < 60) return `in ${Math.max(1, s)} second${s === 1 ? "" : "s"}`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  return `in ${h} hour${h === 1 ? "" : "s"}`;
}
