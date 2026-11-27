// 1.20.31: starting a newsletter's background send through Microsoft 365
// (1.21.5: or Azure Communication Services)
// (lib/newsletter-delivery), from the Send button and from the scheduler.
// The mail is rendered once and its size checked before anything is queued:
// a newsletter too large for Microsoft 365 with its files is refused at
// once, in words, instead of stopping on the first recipient. Server-only.

import "server-only";
import { addNewsletterComment } from "./db";
import { mailConfigured, getM365SendConfig } from "./mail-config";
import { buildMime } from "./mail-m365";
import { MAIL_ACS_MAX_BYTES, acsConfig } from "./mail-acs-config";
import { MAIL_M365_MAX_MIME, m365FromFor, mailTooLarge } from "./mail-m365-shared";
import { newsletterMail, newsletterRecipients, type NewsletterSendInput } from "./newsletter";
import { NEWSLETTER_PER_TICK, NewsletterSendError, startNewsletterSend, type NewsletterDeliveryView } from "./newsletter-delivery";

export async function queueM365Send(
  newsletterId: number,
  input: NewsletterSendInput,
  audience: string,
  actor: { id?: number | null; name?: string } | null,
  opts: { scheduled?: boolean } = {}
): Promise<{ delivery: NewsletterDeliveryView } | { error: string; status: number }> {
  if (!(await mailConfigured())) return { error: "Email isn't set up (Settings → Notifications → Email).", status: 422 };
  const recipients = await newsletterRecipients(input.to);
  if (!recipients.length) return { error: "No recipients matched.", status: 422 };
  const mail = await newsletterMail(input);
  // 1.21.5: through Azure Communication Services, From the platform's sender and its 10 MB limit.
  const acs = acsConfig();
  let who: { from: string; replyTo?: string };
  if (acs) who = { from: input.from || acs.sender };
  else {
    const cfg = await getM365SendConfig();
    who = m365FromFor(cfg.mailbox, cfg.fromName, input.from);
  }
  const mime = await buildMime({ from: who.from, replyTo: who.replyTo, to: recipients[0], subject: mail.subject, text: mail.text, html: mail.html, attachments: input.attachments });
  if (acs && mime.length > MAIL_ACS_MAX_BYTES) return { error: (await import("./mail-acs")).acsTooLargeSentence(mime.length), status: 422 };
  if (!acs && mime.length > MAIL_M365_MAX_MIME) return { error: mailTooLarge(mime.length), status: 422 };
  try {
    const delivery = await startNewsletterSend(newsletterId, { ...mail, from: input.from || "", attachments: input.attachments ?? [] }, recipients, { audience, actor, scheduled: opts.scheduled });
    const minutes = Math.max(1, Math.ceil(delivery.total / NEWSLETTER_PER_TICK));
    await addNewsletterComment({
      newsletter_id: newsletterId,
      user_id: opts.scheduled ? null : (actor?.id ?? null),
      author_name: opts.scheduled ? "Scheduler" : actor?.name || "Email",
      body: `Sending to ${delivery.total} ${delivery.total === 1 ? "recipient" : "recipients"} through ${acs ? "Azure Communication Services" : "Microsoft 365"}, about ${NEWSLETTER_PER_TICK} a minute (${minutes === 1 ? "about a minute" : `about ${minutes} minutes`}).`,
      kind: "comment",
    }).catch(() => {});
    return { delivery };
  } catch (e) {
    if (e instanceof NewsletterSendError) return { error: e.message, status: e.status };
    throw e;
  }
}
