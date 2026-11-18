// Helpdesk 1.20.8: an inbound email's original HTML ("View original").
//
// Keeping it. When an inbound email becomes a message (lib/helpdesk/inbound:
// a new ticket, a reply, a follow-up, a forward, an agent's reply or
// internal note by email; from the webhook or a Microsoft 365 mailbox), its
// HTML part is stored as it arrived in hd_message_html beside the message
// (lib/helpdesk/email-html-schema), quoted history and forwarded content
// included: that is the point. The message's own body stays the text it
// always was. At most 1 MB is kept (the first part, marked truncated); mail
// with no HTML part stores nothing; nothing is back-filled. Inline pictures
// are mapped by their Content-ID to the attachments the same message stored,
// and a tiny one the attachment rules skip (a signature logo under 4 KB) is
// kept with the HTML itself. Storing never fails the email: a failure is
// logged and the message stands as text.
//
// Showing it. Only through GET /api/helpdesk/messages/{id}/original, to an
// agent who works the ticket (the same check the desk's ticket read uses:
// licence, desk role, queues, the Duo desk rule; internal notes included,
// as the desk shows them to that agent). Sanitised from the stored copy in a
// worker thread, bounded (lib/helpdesk/email-html-sanitize); the result is
// kept ten minutes in this process per message, per Show images and per
// sanitiser version, so a repeat view is cheap and a better sanitiser
// applies to old mail. Remote pictures only on "Show images",
// one message at a time; cid: pictures from that message's own attachments
// only, inlined as data: (the sandboxed frame has no cookies to fetch them
// with). Viewing is not audited: it is reading a message.
//
// Privacy. Anonymising a ticket deletes its rows (anonymiseOriginalHtmlTx);
// deleting a ticket or a message cascades; a removed account
// (dropOriginalHtmlForPersonTx, 1.20.8 security review) takes the originals
// of every ticket the person asked, was copied on or wrote on, since other
// people's emails quote theirs. Merging and the recycle bin
// move or keep messages by id, so the HTML stays with its message. The
// requester's personal data export carries the HTML of the emails they sent
// (originalHtmlFor). Server-only.
//
// 1.20.11, in place. The desk's conversation shows each such message's email
// formatted, in a frame of its own, from ?inline=1 (originalView's `inline`,
// originalInlineHeaders): the same sanitiser and the same pictures rule, plus
// the first quoted history folded under "Show quoted text" when the message's
// text body had it cut (a reply: see quoteFolding), and a document the desk
// may read (same origin, still no script: originalInlineHeaders says why).

import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { logEvent } from "../log";
import { isValidStoredName, sniffImage, uploadDir } from "../uploads";
import { hq, hqOne } from "./db-core";
import { EMAIL_HTML_LIMITS, EMAIL_HTML_SANITIZER_VERSION, HD_ORIGINAL_COPY, type HdOriginalInfo } from "./email-html-shared";
import { cidKey, sanitizeEmailHtml } from "./email-html-sanitize";
import type { InboundEmail } from "./inbound-parse";
import type { HdMessage } from "./types";

export interface StoredOriginal {
  message_id: number;
  html: string;
  size: number;
  truncated: boolean;
  cids: Record<string, { attachment_id?: number; mime?: string; data?: string }>;
  created_at: string;
}

/** The first `max` bytes of a UTF-8 string, never cutting a character in two. */
export function truncateUtf8(s: string, max: number): { text: string; size: number; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return { text: s, size: buf.length, truncated: false };
  let end = max;
  // Back up over continuation bytes (10xxxxxx) to the start of a character.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), size: buf.length, truncated: true };
}

/**
 * Keep an email's HTML part beside the message it became. `cids` maps the
 * Content-IDs of the pictures stored from the same email to their attachment
 * ids (lib/helpdesk/inbound storeAttachments). Does nothing for mail with no
 * HTML; never throws.
 */
export async function storeOriginalHtml(messageId: number, email: Pick<InboundEmail, "html" | "files">, cids: Map<string, number> = new Map()): Promise<boolean> {
  try {
    const raw = String(email.html ?? "").replace(/\u0000/g, "");
    if (!raw.trim()) return false;
    const { text, size, truncated } = truncateUtf8(raw, EMAIL_HTML_LIMITS.storeBytes);
    const map: StoredOriginal["cids"] = {};
    for (const [cid, id] of cids) if (cid && Number.isInteger(id)) map[cidKey(cid)] = { attachment_id: id };
    // A tiny inline picture (a signature logo, under the attachment rules' 4 KB floor) is kept with the HTML.
    let tiny = 0;
    for (const f of email.files) {
      const key = f.contentId ? cidKey(f.contentId) : "";
      if (!key || map[key] || tiny >= EMAIL_HTML_LIMITS.tinyCids || f.data.length === 0 || f.data.length >= 4 * 1024) continue;
      const img = sniffImage(f.data);
      if (!img || !/^image\/(png|jpeg|gif|webp)$/.test(img.mime)) continue;
      map[key] = { mime: img.mime, data: f.data.toString("base64") };
      tiny++;
    }
    await hq(
      `INSERT INTO hd_message_html (message_id, html, size, truncated, cids) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (message_id) DO NOTHING`,
      [messageId, text, size, truncated, JSON.stringify(map)]
    );
    return true;
  } catch (e) {
    logEvent("error", "helpdesk.email_html_store_failed", { message_id: messageId, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

export async function getOriginalHtml(messageId: number): Promise<StoredOriginal | undefined> {
  return hqOne<StoredOriginal>("SELECT message_id, html, size, truncated, cids, created_at FROM hd_message_html WHERE message_id = $1", [messageId]);
}

/** Anonymising a ticket (lib/helpdesk/retention): every message's original goes. */
export async function anonymiseOriginalHtmlTx(client: PoolClient, ticketId: number): Promise<void> {
  await client.query("DELETE FROM hd_message_html WHERE message_id IN (SELECT id FROM hd_messages WHERE ticket_id = $1)", [ticketId]);
}

/** Messages blanked elsewhere (lib/helpdesk/retention): their originals go. */
export async function dropOriginalHtmlTx(client: PoolClient, messageIds: number[]): Promise<void> {
  if (messageIds.length) await client.query("DELETE FROM hd_message_html WHERE message_id = ANY($1::int[])", [messageIds]);
}

/**
 * A removed account (lib/helpdesk/retention anonymiseRemovedAccountTx, in its
 * transaction, before CC rows and authors are cleared): the originals of
 * every message on every ticket the person was the requester of, was copied
 * on, or wrote on, by account or by address. Other people's emails quote
 * theirs ("Jane Doe <jane@…> wrote: …"), so not only their own go. Tickets on
 * legal hold keep theirs, as their messages are kept.
 */
export async function dropOriginalHtmlForPersonTx(client: PoolClient, userId: number, email: string, opts: { ccs: boolean }): Promise<number> {
  const r = await client.query(
    `DELETE FROM hd_message_html h USING hd_messages m, hd_tickets t
      WHERE h.message_id = m.id AND t.id = m.ticket_id AND t.legal_hold = 0
        AND m.ticket_id IN (
          SELECT id FROM hd_tickets WHERE requester_id = $1 OR ($2 <> '' AND lower(requester_email) = $2)
          ${opts.ccs ? "UNION SELECT ticket_id FROM hd_ticket_ccs WHERE user_id = $1 OR ($2 <> '' AND lower(email) = $2)" : ""}
          UNION SELECT ticket_id FROM hd_messages WHERE author_id = $1 OR ($2 <> '' AND lower(author_email) = $2))`,
    [userId, email.trim().toLowerCase()]
  );
  return r.rowCount ?? 0;
}

/** The personal data export: message id → the stored HTML of those messages (the caller picks the person's own). */
export async function originalHtmlFor(messageIds: number[]): Promise<Map<number, { html: string; truncated: boolean }>> {
  if (!messageIds.length) return new Map();
  const rows = await hq<{ message_id: number; html: string; truncated: boolean }>(
    "SELECT message_id, html, truncated FROM hd_message_html WHERE message_id = ANY($1::int[])",
    [messageIds]
  );
  return new Map(rows.map((r) => [Number(r.message_id), { html: r.html, truncated: r.truncated === true }]));
}

// --- Showing it ------------------------------------------------------------------------

/** The message's own pictures its HTML names by Content-ID, as data: URIs (the message's attachments only, within the view's budget). */
async function cidPictures(messageId: number, stored: StoredOriginal): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = new Map<number, string[]>();
  for (const [key, v] of Object.entries(stored.cids ?? {})) {
    if (v && typeof v.data === "string" && /^image\/(png|jpeg|gif|webp)$/.test(String(v.mime))) out.set(key, `data:${v.mime};base64,${v.data}`);
    else if (v && Number.isInteger(v.attachment_id)) ids.set(v.attachment_id!, [...(ids.get(v.attachment_id!) ?? []), key]);
  }
  if (!ids.size) return out;
  // The same message's attachments only, whatever the map says: never another message's, never another ticket's.
  const rows = await hq<{ id: number; stored_name: string; mime_type: string; size: number }>(
    `SELECT id, stored_name, mime_type, size FROM hd_attachments
      WHERE id = ANY($1::bigint[]) AND message_id = $2 AND mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')
      ORDER BY id`,
    [[...ids.keys()], messageId]
  );
  let budget: number = EMAIL_HTML_LIMITS.inlineBytes;
  for (const r of rows) {
    if (r.size > budget || !isValidStoredName(r.stored_name)) continue;
    let buf: Buffer;
    try {
      buf = await readFile(join(uploadDir(), r.stored_name));
    } catch {
      continue;
    }
    const img = sniffImage(buf);
    if (!img || img.mime !== r.mime_type) continue;
    budget -= buf.length;
    for (const key of ids.get(Number(r.id)) ?? []) out.set(key, `data:${img.mime};base64,${buf.toString("base64")}`);
  }
  return out;
}

/**
 * 1.20.28: the desk's ticket read marks each attachment its message's formatted email draws itself (`inline`): a
 * picture the stored HTML names by cid ("cid:image001.png@01DB…") that the cids map points at, within the inline
 * view's picture budget in the same order cidPictures spends it. Outlook re-attaches every signature picture of the
 * quoted chain to the newest email; those are drawn inside the email (the quoted ones under "Show quoted text"), so
 * the desk leaves them out of the message's file list while the email shows formatted. A file that carries a
 * Content-ID the HTML never names (some mail apps give every part one) stays listed. Only messages with an
 * original are read; the HTML never leaves the database here.
 */
export async function markInlineAttachments<M extends Pick<HdMessage, "id" | "attachments" | "has_original_html">>(messages: M[]): Promise<M[]> {
  const isPicture = (type: string) => /^image\/(png|jpeg|gif|webp)$/.test(type);
  const ids = messages.filter((m) => m.has_original_html === true && (m.attachments ?? []).some((a) => isPicture(a.type))).map((m) => m.id);
  if (!ids.length) return messages;
  const rows = await hq<{ message_id: number; ids: (number | string)[] | null }>(
    `SELECT h.message_id, array_agg(DISTINCT (e.value->>'attachment_id')::bigint) AS ids
       FROM hd_message_html h
            CROSS JOIN LATERAL (SELECT lower(h.html) AS html) l
            CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(h.cids) = 'object' THEN h.cids ELSE '{}'::jsonb END) e
      WHERE h.message_id = ANY($1::int[])
        AND jsonb_typeof(e.value->'attachment_id') = 'number'
        AND e.key <> '' AND strpos(l.html, 'cid:' || e.key) > 0
      GROUP BY h.message_id`,
    [ids]
  );
  const named = new Map(rows.map((r) => [Number(r.message_id), new Set((r.ids ?? []).map(Number))]));
  return messages.map((m) => {
    const refs = named.get(m.id);
    if (!refs?.size) return m;
    // cidPictures' budget, spent in attachment id order: a picture past it is not drawn, so it stays listed.
    let budget: number = EMAIL_HTML_LIMITS.inlineBytes;
    const inline = new Set<number>();
    for (const a of [...m.attachments].sort((x, y) => x.id - y.id)) {
      if (!refs.has(a.id) || !isPicture(a.type) || a.size > budget) continue;
      budget -= a.size;
      inline.add(a.id);
    }
    if (!inline.size) return m;
    return { ...m, attachments: m.attachments.map((a) => (inline.has(a.id) ? { ...a, inline: true } : a)) };
  });
}

export type OriginalView =
  | { ok: true; html: string; info: HdOriginalInfo }
  | { ok: false; status: 404 | 422 | 503; info: HdOriginalInfo };

// 1.20.8 (security review): sanitised results are kept, in this process, per message, per Show images and per
// sanitiser version (so a better sanitiser makes them again), for ten minutes after the work is done; a refusal too,
// so a hostile email is worked on once, not on every view. The info read and the frame's read that follow each other
// share one piece of work while it runs. At most 32 results and about 48 MB are kept; the oldest go first.
const kept = new Map<string, { at: number; view: OriginalView; bytes: number }>();
const working = new Map<string, Promise<OriginalView>>();
const KEPT_MS = 10 * 60_000;
const KEPT_MAX = 32;
const KEPT_BYTES = 48 * 1024 * 1024;

/** Tests: forget the kept results. */
export function resetOriginalCacheForTests(): void {
  kept.clear();
  working.clear();
  refusedMessages.clear();
}

// 1.20.11 security review: an email refused as too complex (or past its time) is refused for the message as a
// whole, whichever variant, picture choice or host asked, for as long as a result is kept: one hostile reply that
// every agent opens costs the worker once, not once per view.
const refusedMessages = new Map<string, { at: number; view: OriginalView }>();
const REFUSED_MAX = 256;

function keep(key: string, view: OriginalView): void {
  const now = Date.now();
  for (const [k, v] of kept) if (now - v.at >= KEPT_MS) kept.delete(k);
  const bytes = view.ok ? view.html.length * 2 : 256;
  let total = bytes;
  for (const v of kept.values()) total += v.bytes;
  while (kept.size && (kept.size >= KEPT_MAX || total > KEPT_BYTES)) {
    const [oldest, v] = kept.entries().next().value!;
    kept.delete(oldest);
    total -= v.bytes;
  }
  if (bytes <= KEPT_BYTES) kept.set(key, { at: now, view, bytes });
}

const refused = (status: 404 | 422 | 503, error: string, extra: Partial<HdOriginalInfo> = {}): OriginalView => ({
  ok: false,
  status,
  info: { ok: false, error, remote_images: 0, insecure_images: 0, truncated: false, size: 0, ...extra },
});

/**
 * 1.20.11: whether the inline view folds a message's quoted history: when its text body had the quote cut at
 * arrival (lib/helpdesk/inbound inboundBody's `reply`). That is every emailed message after the one that opened
 * its ticket (or, for a message a merge moved, the ticket it came from), and a follow-up's opening message. The
 * message that opened a ticket keeps everything: new mail, or a forward, whose forwarded part is the content.
 */
export async function quoteFolding(messageId: number): Promise<boolean> {
  const row = await hqOne<{ opening: boolean; follow_up: boolean }>(
    `SELECT NOT EXISTS (
              SELECT 1 FROM hd_messages e
               WHERE e.ticket_id = m.ticket_id AND e.kind <> 'system' AND e.merged_from IS NOT DISTINCT FROM m.merged_from
                 AND (e.created_at, e.id) < (m.created_at, m.id)) AS opening,
            m.body LIKE '\\_Follow-up to #%' AS follow_up
       FROM hd_messages m WHERE m.id = $1`,
    [messageId]
  );
  return !!row && (!row.opening || row.follow_up);
}

/**
 * One message's original, sanitised for the frame (the caller has checked
 * that the viewer may read the message). `remoteImages`: Show images.
 * `inline` (1.20.11): the desk conversation's variant (quoted history folded
 * when quoteFolding says so, no picture from `selfHost`, the desk's mark).
 */
export async function originalView(messageId: number, opts: { remoteImages?: boolean; inline?: { selfHost: string } } = {}): Promise<OriginalView> {
  const stored = await getOriginalHtml(messageId);
  if (!stored) return refused(404, "This message has no original email.");
  const inline = opts.inline ? `:i:${opts.inline.selfHost.toLowerCase()}` : "";
  const messageKey = `${messageId}:${EMAIL_HTML_SANITIZER_VERSION}:${new Date(stored.created_at).getTime()}`;
  const key = `${messageId}:${opts.remoteImages ? 1 : 0}:${EMAIL_HTML_SANITIZER_VERSION}:${new Date(stored.created_at).getTime()}${inline}`;
  const no = refusedMessages.get(messageKey);
  if (no && Date.now() - no.at < KEPT_MS) return no.view;
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < KEPT_MS) return hit.view;
  const running = working.get(key);
  if (running) return running;
  const work = (async (): Promise<OriginalView> => {
    const cids = await cidPictures(messageId, stored);
    const extra = { truncated: stored.truncated === true, size: Number(stored.size) };
    const folding = opts.inline ? { collapseQuotes: await quoteFolding(messageId), selfHost: opts.inline.selfHost, truncated: extra.truncated } : undefined;
    const r = await sanitizeEmailHtml(stored.html, { remoteImages: opts.remoteImages === true, cids, ...(folding ? { inline: folding } : {}) });
    if (r.ok) {
      const info: HdOriginalInfo = { ok: true, remote_images: r.remoteImages, insecure_images: r.insecureImages, ...extra, ...(folding ? { quoted: r.quoted === true } : {}) };
      return { ok: true, html: r.html, info };
    }
    if (r.reason === "busy" || r.reason === "failed") return refused(503, r.reason === "busy" ? HD_ORIGINAL_COPY.busy : HD_ORIGINAL_COPY.failed, extra);
    return refused(422, HD_ORIGINAL_COPY.tooComplex, extra);
  })();
  working.set(key, work);
  try {
    const view = await work;
    // Kept from when the work ended (a slow one is not done again for the next read); a busy desk is not kept.
    if (view.ok || view.status !== 503) keep(key, view);
    if (!view.ok && view.status === 422) {
      if (refusedMessages.size >= REFUSED_MAX) refusedMessages.delete(refusedMessages.keys().next().value!);
      refusedMessages.set(messageKey, { at: Date.now(), view });
    }
    return view;
  } finally {
    working.delete(key);
  }
}

/**
 * The response headers of the original's document: a policy that loads
 * nothing but pictures (https ones only with Show images), runs nothing,
 * submits nothing, and keeps the document in a sandbox of its own (links
 * may open a new tab, nothing else).
 */
export function originalHeaders(remoteImages: boolean): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": [
      "default-src 'none'",
      `img-src data:${remoteImages ? " https:" : ""}`,
      "style-src 'unsafe-inline'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'self'",
      "sandbox allow-popups allow-popups-to-escape-sandbox",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, no-store",
    "X-Frame-Options": "SAMEORIGIN",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

/**
 * 1.20.11: the inline variant's headers (?inline=1, the desk conversation). The same policy as the original's, but
 * the sandbox adds allow-same-origin (and the frame's sandbox attribute says the same): the document is
 * same-origin with the desk, so the desk can read its height and its mark and follow its resizes. No script can
 * run in it: the sandbox has no allow-scripts (inline script, handlers and javascript: links are all blocked, and
 * so is any page the frame is navigated to, as the frame's own sandbox attribute stays), and default-src 'none'
 * gives it no script-src, which also blocks a javascript: link opened in a new tab (the initiator's policy
 * applies). Same-origin only goes one way: the desk's scripts may reach the email's document; nothing in the
 * email can run to reach the desk. Pictures: data: (and https: with Show images). The sanitiser drops a picture
 * on the desk's own host, but a picture elsewhere can redirect to the desk, and from a same-origin frame that
 * request would be same-site and carry the desk's Lax cookies: src/proxy.ts takes the Cookie header off every
 * cross-site or same-site picture, media, font, style or script request (1.20.11 security review), so it reaches
 * the desk signed out. Forms: none, and form-action 'none'. Framed only by the desk (frame-ancestors 'self',
 * X-Frame-Options SAMEORIGIN).
 */
export function originalInlineCsp(remoteImages: boolean): string {
  return originalHeaders(remoteImages)["Content-Security-Policy"].replace(
    "sandbox allow-popups allow-popups-to-escape-sandbox",
    "sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox"
  );
}

export function originalInlineHeaders(remoteImages: boolean): Record<string, string> {
  return { ...originalHeaders(remoteImages), "Content-Security-Policy": originalInlineCsp(remoteImages) };
}

/** The inline variant's page when the email is not shown (the desk reads its mark and shows the text instead). */
export function inlineRefusalPage(reason: "too_complex" | "busy" | "not_here"): string {
  // "not_here": opened as a page or from elsewhere; it says so to whoever sees it (1.20.11 security review).
  const body =
    reason === "not_here"
      ? `<p style="font:14px/1.5 system-ui,sans-serif;color:#475569;margin:12px">${HD_ORIGINAL_COPY.inlineElsewhere}</p>`
      : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="compass-email" content="refused" data-reason="${reason}"></head><body>${body}</body></html>`;
}
