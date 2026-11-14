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
// as the desk shows them to that agent). Sanitised every time
// (lib/helpdesk/email-html-sanitize); remote pictures only on "Show images",
// one message at a time; cid: pictures from that message's own attachments
// only, inlined as data: (the sandboxed frame has no cookies to fetch them
// with). Viewing is not audited: it is reading a message.
//
// Privacy. Anonymising a ticket deletes its rows (anonymiseOriginalHtmlTx);
// deleting a ticket or a message cascades; a removed account's blanked
// messages lose theirs (dropOriginalHtmlTx). Merging and the recycle bin
// move or keep messages by id, so the HTML stays with its message. The
// requester's personal data export carries the HTML of the emails they sent
// (originalHtmlFor). Server-only.

import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { logEvent } from "../log";
import { isValidStoredName, sniffImage, uploadDir } from "../uploads";
import { hq, hqOne } from "./db-core";
import { EMAIL_HTML_LIMITS, HD_ORIGINAL_COPY, type HdOriginalInfo } from "./email-html-shared";
import { cidKey, sanitizeEmailHtml } from "./email-html-sanitize";
import type { InboundEmail } from "./inbound-parse";

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

/** A removed account's blanked messages (lib/helpdesk/retention): their originals go. */
export async function dropOriginalHtmlTx(client: PoolClient, messageIds: number[]): Promise<void> {
  if (messageIds.length) await client.query("DELETE FROM hd_message_html WHERE message_id = ANY($1::int[])", [messageIds]);
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

export type OriginalView =
  | { ok: true; html: string; info: HdOriginalInfo }
  | { ok: false; status: 404 | 422; info: HdOriginalInfo };

// The info read and the frame's read come one after the other: the sanitised result is kept a minute for the second.
const recent = new Map<string, { at: number; view: OriginalView }>();
const RECENT_MS = 60_000;
const RECENT_MAX = 8;

/** Tests: forget the kept results. */
export function resetOriginalCacheForTests(): void {
  recent.clear();
}

const refused = (status: 404 | 422, error: string, extra: Partial<HdOriginalInfo> = {}): OriginalView => ({
  ok: false,
  status,
  info: { ok: false, error, remote_images: 0, insecure_images: 0, truncated: false, size: 0, ...extra },
});

/**
 * One message's original, sanitised for the frame (the caller has checked
 * that the viewer may read the message). `remoteImages`: Show images.
 */
export async function originalView(messageId: number, opts: { remoteImages?: boolean } = {}): Promise<OriginalView> {
  const stored = await getOriginalHtml(messageId);
  if (!stored) return refused(404, "This message has no original email.");
  const key = `${messageId}:${opts.remoteImages ? 1 : 0}:${stored.created_at}`;
  const now = Date.now();
  const hit = recent.get(key);
  if (hit && now - hit.at < RECENT_MS) return hit.view;
  const cids = await cidPictures(messageId, stored);
  const r = sanitizeEmailHtml(stored.html, { remoteImages: opts.remoteImages === true, cids });
  const view: OriginalView = r.ok
    ? {
        ok: true,
        html: r.html,
        info: { ok: true, remote_images: r.remoteImages, insecure_images: r.insecureImages, truncated: stored.truncated === true, size: Number(stored.size) },
      }
    : refused(422, HD_ORIGINAL_COPY.tooComplex, { truncated: stored.truncated === true, size: Number(stored.size) });
  for (const [k, v] of recent) if (now - v.at >= RECENT_MS) recent.delete(k);
  if (recent.size >= RECENT_MAX) recent.delete(recent.keys().next().value!);
  recent.set(key, { at: now, view });
  return view;
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
