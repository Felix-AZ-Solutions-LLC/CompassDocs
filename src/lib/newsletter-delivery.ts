// 1.20.31: a newsletter sent through Microsoft 365 goes out in the
// background. Exchange Online lets one mailbox send about 30 messages a
// minute and 10,000 recipients a day, so a send to hundreds of people
// cannot finish inside one HTTP request (a proxy cuts it off at about a
// minute, and Microsoft starts answering 429). SMTP sends stay as they were
// (lib/newsletter sendNewsletter, in the request).
//
//   queue      startNewsletterSend renders the mail once and stores it on a
//              job (newsletter_send_jobs) with one row per recipient
//              (newsletter_deliveries: queued). The newsletter stays
//              "approved" while it is being sent; a second send is refused.
//   pace       newsletterDeliveryTick (instrumentation, every minute) takes
//              one job at a time (claimed, so two instances never send the
//              same row) and sends up to PER_TICK rows: about 25 a minute,
//              under Exchange's 30.
//   429        Microsoft asking to slow down beyond what one send waits out
//              (lib/mail-m365) pauses the job until Retry-After (at least a
//              minute); the row stays queued. Nothing is lost or doubled.
//   stop       a refusal that would repeat for everyone (too large with its
//              files, the app may not sign in or send) stops the job with
//              the reason; the rows stay queued and "Try again" resumes it.
//   failure    any other refusal is that recipient's: the row is failed with
//              Microsoft's reason, and the rest go on.
//   done       no queued row left: the newsletter is marked sent with the
//              real count, the thread says "sent to everyone" only when
//              nobody failed (else "sent to N of M; F failed"), it is
//              archived and audited, as a send in the request is. "Retry the
//              N that failed" queues the failed rows again; their outcome is
//              added to the count without sending anyone a second copy.
//
// Server-only.

import "server-only";
import { pool, getNewsletter, markNewsletterSent, addNewsletterComment } from "./db";
import { audit } from "./audit";
import { sendMail } from "./mailer";
import { MailSendError, refusalRepeats } from "./mail-m365";
import type { NewsletterDeliveryView } from "./newsletter-delivery-shared";

/** Sends per minute, under Exchange Online's 30 messages a minute per mailbox. */
export const NEWSLETTER_PER_TICK = 25;
/** A job left claimed this long (its instance died) is taken again. */
const CLAIM_MS = 3 * 60_000;

export interface NewsletterJobPayload {
  subject: string;
  text: string;
  html: string;
  from: string;
  attachments: { filename: string; path: string }[];
}

export type { NewsletterDeliveryView };

export class NewsletterSendError extends Error {
  constructor(
    message: string,
    public status = 409
  ) {
    super(message);
  }
}

/** Queue a send. Refused while this newsletter already has a send under way or done. */
export async function startNewsletterSend(
  newsletterId: number,
  payload: NewsletterJobPayload,
  recipients: string[],
  meta: { audience: string; actor?: { id?: number | null; name?: string } | null; scheduled?: boolean }
): Promise<NewsletterDeliveryView> {
  const emails = [...new Set(recipients.map((e) => e.trim()).filter(Boolean))];
  if (!emails.length) throw new NewsletterSendError("No recipients matched.", 400);
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const made = await client.query(
      `INSERT INTO newsletter_send_jobs (newsletter_id, payload, audience, actor_id, actor_name, scheduled)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (newsletter_id) DO NOTHING RETURNING newsletter_id`,
      [newsletterId, JSON.stringify(payload), meta.audience.slice(0, 300), meta.actor?.id ?? null, meta.actor?.name ?? "", meta.scheduled === true]
    );
    if (!made.rowCount) {
      await client.query("ROLLBACK");
      throw new NewsletterSendError("This newsletter is already being sent.");
    }
    await client.query(
      `INSERT INTO newsletter_deliveries (newsletter_id, email) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
      [newsletterId, emails]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return (await newsletterDelivery(newsletterId))!;
}

/** Where a background send stands, or null when this newsletter has none. */
export async function newsletterDelivery(newsletterId: number): Promise<NewsletterDeliveryView | null> {
  const job = (await pool().query("SELECT * FROM newsletter_send_jobs WHERE newsletter_id = $1", [newsletterId])).rows[0];
  if (!job) return null;
  const counts = (
    await pool().query<{ state: string; n: number }>("SELECT state, count(*)::int AS n FROM newsletter_deliveries WHERE newsletter_id = $1 GROUP BY state", [newsletterId])
  ).rows;
  const n = (st: string) => counts.find((c) => c.state === st)?.n ?? 0;
  const failures = (
    await pool().query<{ email: string; error: string }>("SELECT email, error FROM newsletter_deliveries WHERE newsletter_id = $1 AND state = 'failed' ORDER BY updated_at, email LIMIT 10", [newsletterId])
  ).rows;
  const paused = job.paused_until && new Date(job.paused_until).getTime() > Date.now();
  return {
    state: job.state === "sending" && paused ? "paused" : job.state,
    total: n("queued") + n("sent") + n("failed"),
    sent: n("sent"),
    failed: n("failed"),
    queued: n("queued"),
    paused_until: paused ? new Date(job.paused_until).toISOString() : null,
    stop_reason: job.stop_reason,
    failures,
    started_at: new Date(job.created_at).toISOString(),
    finished_at: job.finished_at ? new Date(job.finished_at).toISOString() : null,
  };
}

/** "Retry the N that failed" (a finished send) or "Try again" (a stopped one). */
export async function resumeNewsletterSend(newsletterId: number, what: "failed" | "stopped"): Promise<NewsletterDeliveryView> {
  const job = (await pool().query("SELECT state FROM newsletter_send_jobs WHERE newsletter_id = $1", [newsletterId])).rows[0];
  if (!job) throw new NewsletterSendError("This newsletter has no send to retry.", 404);
  if (what === "failed") {
    const r = await pool().query("UPDATE newsletter_deliveries SET state = 'queued', error = '', updated_at = now() WHERE newsletter_id = $1 AND state = 'failed'", [newsletterId]);
    if (!r.rowCount) throw new NewsletterSendError("Nobody failed: there is nothing to retry.", 400);
  } else if (job.state !== "stopped") {
    throw new NewsletterSendError("This send is not stopped.", 400);
  }
  await pool().query("UPDATE newsletter_send_jobs SET state = 'sending', stop_reason = '', paused_until = NULL, finished_at = NULL WHERE newsletter_id = $1", [newsletterId]);
  return (await newsletterDelivery(newsletterId))!;
}

let sendForTests: typeof sendMail | null = null;
/** Tests: replace the mailer (null restores it). */
export function setNewsletterSenderForTests(fn: typeof sendMail | null): void {
  sendForTests = fn;
}

/** Tests: forget the one-batch-a-minute pacing. */
export async function resetNewsletterPacingForTests(): Promise<void> {
  await pool().query("UPDATE newsletter_send_jobs SET last_batch_at = NULL, claimed_until = NULL, paused_until = NULL");
}

/** One minute's sending: one job, up to NEWSLETTER_PER_TICK rows. Never throws. */
export async function newsletterDeliveryTick(): Promise<{ newsletter: number | null; sent: number; failed: number }> {
  const out = { newsletter: null as number | null, sent: 0, failed: 0 };
  let job: { newsletter_id: number; payload: string; audience: string; actor_id: number | null; actor_name: string; scheduled: boolean; finished_once: boolean } | undefined;
  try {
    job = (
      await pool().query(
        // One batch a minute for the whole workspace (one sending mailbox), whichever instance runs it:
        // the statement holds a lock of its own while it decides, and a batch less than 55 seconds old waits.
        `WITH gate AS (SELECT pg_try_advisory_xact_lock(hashtext('newsletter_delivery')) AS ok)
         UPDATE newsletter_send_jobs SET claimed_until = now() + ($1 || ' milliseconds')::interval, last_batch_at = now()
          WHERE (SELECT ok FROM gate)
            AND NOT EXISTS (SELECT 1 FROM newsletter_send_jobs o WHERE o.claimed_until > now() OR o.last_batch_at > now() - interval '55 seconds')
            AND newsletter_id = (
            SELECT newsletter_id FROM newsletter_send_jobs
             WHERE state = 'sending' AND (paused_until IS NULL OR paused_until <= now()) AND (claimed_until IS NULL OR claimed_until < now())
             ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING newsletter_id, payload, audience, actor_id, actor_name, scheduled, finished_once`,
        [String(CLAIM_MS)]
      )
    ).rows[0];
  } catch (e) {
    console.error("[newsletter] delivery claim failed:", e);
    return out;
  }
  if (!job) return out;
  out.newsletter = job.newsletter_id;
  const id = job.newsletter_id;
  const release = (extra = "", params: unknown[] = []) => pool().query(`UPDATE newsletter_send_jobs SET claimed_until = NULL${extra} WHERE newsletter_id = $1`, [id, ...params]);
  try {
    const payload = JSON.parse(job.payload) as NewsletterJobPayload;
    const rows = (await pool().query<{ email: string }>("SELECT email FROM newsletter_deliveries WHERE newsletter_id = $1 AND state = 'queued' ORDER BY email LIMIT $2", [id, NEWSLETTER_PER_TICK])).rows;
    const send = sendForTests ?? sendMail;
    for (const r of rows) {
      try {
        await send([r.email], payload.subject, payload.text, payload.html, payload.from || undefined, payload.attachments);
        await pool().query("UPDATE newsletter_deliveries SET state = 'sent', error = '', attempts = attempts + 1, updated_at = now() WHERE newsletter_id = $1 AND email = $2", [id, r.email]);
        out.sent++;
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 500);
        if (e instanceof MailSendError && e.status === 429) {
          // Slow down: this row stays queued; the job waits at least a minute.
          await release(", paused_until = now() + ($2 || ' milliseconds')::interval", [String(Math.max(60_000, Math.min(e.retryAfterMs ?? 60_000, 3_600_000)))]);
          return out;
        }
        if (refusalRepeats(e)) {
          await release(", state = 'stopped', stop_reason = $2", [msg]);
          await addNewsletterComment({ newsletter_id: id, user_id: null, author_name: "Email", body: `Sending stopped: ${msg} The rest were not sent. Fix the cause, then press Try again on the newsletter.`, kind: "comment" }).catch(() => {});
          return out;
        }
        await pool().query("UPDATE newsletter_deliveries SET state = 'failed', error = $3, attempts = attempts + 1, updated_at = now() WHERE newsletter_id = $1 AND email = $2", [id, r.email, msg]);
        out.failed++;
      }
    }
    const left = (await pool().query<{ n: number }>("SELECT count(*)::int AS n FROM newsletter_deliveries WHERE newsletter_id = $1 AND state = 'queued'", [id])).rows[0].n;
    if (left > 0) {
      await release();
      return out;
    }
    await release(", state = 'done', finished_at = now(), finished_once = true");
    await finish(id, job);
  } catch (e) {
    console.error(`[newsletter] delivery of #${id} failed:`, e);
    await release().catch(() => {});
  }
  return out;
}

/** The send is over: the newsletter's count, its thread, the archive and the audit log, as a send in the request. */
async function finish(id: number, job: { audience: string; actor_id: number | null; actor_name: string; scheduled: boolean; finished_once: boolean }): Promise<void> {
  const v = (await newsletterDelivery(id))!;
  const everyone = job.audience.toLowerCase() === "everyone";
  const target = everyone ? "everyone" : job.audience;
  if (job.finished_once) {
    // A retry of the ones that failed: the count grows, nobody is sent a second copy.
    await pool().query("UPDATE newsletters SET sent_count = $2, updated_at = now() WHERE id = $1", [id, v.sent]);
    await addNewsletterComment({ newsletter_id: id, user_id: null, author_name: "Email", body: v.failed ? `Retried: now sent to ${v.sent} of ${v.total}; ${v.failed} still failed.` : `Retried: now sent to all ${v.total} recipients.`, kind: "comment" });
    return;
  }
  await markNewsletterSent(id, job.audience, v.sent);
  const who = job.scheduled ? "Scheduler" : job.actor_name || "Email";
  const body = v.failed
    ? `Sent to ${v.sent} of ${v.total} ${v.total === 1 ? "recipient" : "recipients"} (${target}); ${v.failed} failed. Open the newsletter to see why and retry them.`
    : `Sent${job.scheduled ? " as scheduled" : ""} to ${target} — ${v.sent} ${v.sent === 1 ? "recipient" : "recipients"}.`;
  await addNewsletterComment({ newsletter_id: id, user_id: job.scheduled ? null : job.actor_id, author_name: who, body, kind: "sent" });
  const n = await getNewsletter(id);
  if (n) {
    const { archiveNewsletter } = await import("./newsletter");
    const archivedDocId = await archiveNewsletter(n).catch(() => null);
    if (archivedDocId) {
      await addNewsletterComment({ newsletter_id: id, user_id: null, author_name: "Archive", body: `Filed in the archive space as document #${archivedDocId}.`, kind: "comment" });
    }
  }
  await audit({
    actor: job.scheduled ? { name: "system" } : { id: job.actor_id, name: job.actor_name },
    action: "newsletter.sent",
    targetType: "newsletter",
    targetId: id,
    targetLabel: n?.subject ?? "",
    details: { audience: job.audience, sent: v.sent, failed: v.failed, via: "m365", ...(job.scheduled ? { scheduled: true } : {}) },
  });
}
