// 1.21.5: a built message (RFC 822, as lib/mail-m365 buildMime writes it with
// nodemailer) as the JSON Azure Communication Services Email takes (POST
// {endpoint}/emails:send). Pure: no database, no network, no server-only
// marker, so it is tested on its own.
//
// Why from MIME: every message the workspace sends is built once, by the
// same library, before anything is tried, and the outbox (lib/mail-outbox)
// keeps it sealed in that form until it goes. Keeping that one form means a
// message queued for Microsoft 365 or SMTP can still go out through ACS
// after the operator switches (and the other way round), and nothing about
// queueing, sealing, Retry or the size check changes. The parser only has
// to read what nodemailer writes: folded headers, RFC 2047 words, RFC 2231
// parameters, multipart/mixed, alternative and related, base64,
// quoted-printable and 7/8 bit bodies.
//
// What ACS gets:
//
//   senderAddress  always COMPASSDOCS_ACS_SENDER (ACS sends from verified
//                  MailFrom addresses only). The From display name is the
//                  sender username's own, set in Azure: the API has no field
//                  for it.
//   recipients     To and Cc from the headers, limited to the envelope the
//                  outbox kept (rcpt); envelope addresses in neither are Bcc.
//   replyTo        the message's Reply-To; else its From when that is
//                  another address (a help address, a newsletter's chosen
//                  sender), so answers still reach it; else the workspace's
//                  reply address.
//   content        subject, plainText, html.
//   attachments    name, contentType, contentInBase64 (inline parts too: the
//                  workspace's mail has none, and 2023-03-31 has no contentId).
//   headers        everything that is not structure ACS builds itself:
//                  Message-ID, In-Reply-To and References (the helpdesk's
//                  threading), List-Unsubscribe and List-Unsubscribe-Post,
//                  Auto-Submitted, X-… .
//   userEngagementTrackingDisabled   true: no open or click tracking.

import addressparser from "nodemailer/lib/addressparser";

export interface AcsAddress {
  address: string;
  displayName?: string;
}

export interface AcsAttachment {
  name: string;
  contentType: string;
  contentInBase64: string;
}

export interface AcsEmailRequest {
  senderAddress: string;
  recipients: { to: AcsAddress[]; cc?: AcsAddress[]; bcc?: AcsAddress[] };
  content: { subject: string; plainText?: string; html?: string };
  replyTo?: AcsAddress[];
  attachments?: AcsAttachment[];
  headers?: Record<string, string>;
  userEngagementTrackingDisabled: boolean;
}

export interface ParsedMail {
  from: AcsAddress | null;
  replyTo: AcsAddress[];
  to: AcsAddress[];
  cc: AcsAddress[];
  subject: string;
  text: string | null;
  html: string | null;
  attachments: AcsAttachment[];
  /** Headers ACS passes through, decoded, in the order they stood. */
  headers: Record<string, string>;
}

/** The message can't be read back (it was not built by buildMime, or it is damaged). */
export class MimeReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MimeReadError";
  }
}

// --- Headers -----------------------------------------------------------------------------------

/** A header value with its RFC 2047 encoded words decoded (a From name or subject in UTF-8). */
export function decodeWords(v: string): string {
  return v.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(?:\s+(?==\?))?/g, (_m, charset: string, enc: string, text: string) => {
    const bytes =
      enc.toUpperCase() === "B"
        ? Buffer.from(text, "base64")
        : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
    return decodeText(bytes, charset);
  });
}

function decodeText(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset.trim().toLowerCase() || "utf-8").decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

interface Header {
  name: string;
  /** Unfolded, still encoded. */
  value: string;
}

/** Split a part into its headers (unfolded) and its body. */
function splitPart(part: Buffer): { headers: Header[]; body: Buffer } {
  let at = part.indexOf("\r\n\r\n");
  let sep = 4;
  if (at < 0) {
    at = part.indexOf("\n\n");
    sep = 2;
  }
  const head = (at < 0 ? part : part.subarray(0, at)).toString("latin1");
  const body = at < 0 ? Buffer.alloc(0) : part.subarray(at + sep);
  const headers: Header[] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length) {
      const h = headers[headers.length - 1];
      h.value = h.value ? `${h.value} ${line.trim()}` : line.trim();
      continue;
    }
    const i = line.indexOf(":");
    if (i > 0) headers.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
  }
  return { headers, body };
}

const get = (headers: Header[], name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";

/**
 * A structured header value: the value before the first ";" (lower-cased)
 * and its parameters, with quoted strings and RFC 2231 (name*=, name*0*=)
 * decoded.
 */
export function parseParams(raw: string): { value: string; params: Record<string, string> } {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"' && raw[i - 1] !== "\\") quoted = !quoted;
    if (c === ";" && !quoted) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  const value = (parts.shift() ?? "").trim().toLowerCase();
  const plain: Record<string, string> = {};
  const continued: Record<string, { i: number; v: string; enc: boolean }[]> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const key = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    const m = key.match(/^([^*]+)\*(?:(\d+)\*?)?$/);
    if (m) {
      const enc = key.endsWith("*");
      (continued[m[1]] ??= []).push({ i: m[2] === undefined ? 0 : Number(m[2]), v, enc });
    } else plain[key] = v;
  }
  for (const [name, list] of Object.entries(continued)) {
    list.sort((a, b) => a.i - b.i);
    let charset = "utf-8";
    const bytes: number[] = [];
    list.forEach((seg, n) => {
      let v = seg.v;
      if (n === 0 && seg.enc) {
        const q = v.match(/^([^']*)'[^']*'(.*)$/);
        if (q) {
          charset = q[1] || "utf-8";
          v = q[2];
        }
      }
      if (seg.enc) {
        for (let i = 0; i < v.length; i++) {
          if (v[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(v.slice(i + 1, i + 3))) {
            bytes.push(parseInt(v.slice(i + 1, i + 3), 16));
            i += 2;
          } else bytes.push(...Buffer.from(v[i], "utf8"));
        }
      } else bytes.push(...Buffer.from(v, "latin1"));
    });
    plain[name] = decodeText(Buffer.from(bytes), charset);
  }
  for (const k of Object.keys(plain)) plain[k] = decodeWords(plain[k]);
  return { value, params: plain };
}

function addresses(raw: string): AcsAddress[] {
  if (!raw.trim()) return [];
  const out: AcsAddress[] = [];
  for (const a of addressparser(decodeWords(raw), { flatten: true })) {
    const address = (a.address ?? "").trim();
    if (!/^.+@[^@\s<>]+$/.test(address) || /[<>\r\n]/.test(address)) continue;
    if (out.some((x) => x.address.toLowerCase() === address.toLowerCase())) continue;
    const name = (a.name ?? "").replace(/[\r\n]+/g, " ").trim();
    out.push(name ? { address, displayName: name } : { address });
  }
  return out;
}

// --- Bodies ------------------------------------------------------------------------------------

function decodeQuotedPrintable(s: string): Buffer {
  const bytes: number[] = [];
  const text = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(text.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeBody(body: Buffer, cte: string): Buffer {
  const enc = cte.trim().toLowerCase();
  if (enc === "base64") return Buffer.from(body.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (enc === "quoted-printable") return decodeQuotedPrintable(body.toString("latin1"));
  return body;
}

/** The parts of a multipart body between its boundaries. */
function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const s = body.toString("latin1");
  const marker = `--${boundary}`;
  const out: Buffer[] = [];
  let pos = s.indexOf(marker);
  if (pos < 0) throw new MimeReadError("A multipart section has no boundary.");
  for (;;) {
    const lineEnd = s.indexOf("\n", pos);
    if (s.startsWith(`${marker}--`, pos) || lineEnd < 0) break;
    const next = s.indexOf(`\n${marker}`, lineEnd);
    if (next < 0) throw new MimeReadError("A multipart section is not closed.");
    let end = next;
    if (s[end - 1] === "\r") end--;
    out.push(Buffer.from(s.slice(lineEnd + 1, end), "latin1"));
    pos = next + 1;
  }
  return out;
}

const bareType = (t: string) => t || "text/plain";

function walk(part: Buffer, out: ParsedMail, depth: number): void {
  if (depth > 8) throw new MimeReadError("The message nests its parts too deeply.");
  const { headers, body } = splitPart(part);
  const ct = parseParams(get(headers, "content-type") || "text/plain; charset=utf-8");
  const type = bareType(ct.value);
  if (type.startsWith("multipart/")) {
    const boundary = ct.params.boundary;
    if (!boundary) throw new MimeReadError("A multipart section has no boundary.");
    for (const p of splitMultipart(body, boundary)) walk(p, out, depth + 1);
    return;
  }
  const disp = parseParams(get(headers, "content-disposition"));
  const filename = disp.params.filename || ct.params.name || "";
  const cte = get(headers, "content-transfer-encoding");
  // A single-part message ends with the line break that ends the message (a multipart's parts lose theirs at the boundary).
  const own = depth === 0 && cte.trim().toLowerCase() !== "base64" && body.subarray(-2).toString("latin1") === "\r\n" ? body.subarray(0, -2) : body;
  const data = decodeBody(own, cte);
  const isAttachment = disp.value === "attachment" || Boolean(filename) || (type !== "text/plain" && type !== "text/html");
  if (!isAttachment && type === "text/plain" && out.text === null) {
    out.text = decodeText(data, ct.params.charset || "utf-8");
    return;
  }
  if (!isAttachment && type === "text/html" && out.html === null) {
    out.html = decodeText(data, ct.params.charset || "utf-8");
    return;
  }
  out.attachments.push({ name: filename || `attachment-${out.attachments.length + 1}`, contentType: type, contentInBase64: data.toString("base64") });
}

/** Headers that are the message's structure, which ACS builds itself from the request's fields. */
const STRUCTURE = new Set([
  "from",
  "sender",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "date",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "content-disposition",
  "content-id",
  "return-path",
  "received",
  "dkim-signature",
]);

/** Read a built message back into its parts. Throws MimeReadError when it can't be. */
export function parseBuiltMime(mime: Buffer): ParsedMail {
  const { headers } = splitPart(mime);
  if (!headers.length) throw new MimeReadError("The message has no headers.");
  const out: ParsedMail = {
    from: addresses(get(headers, "from"))[0] ?? null,
    replyTo: addresses(get(headers, "reply-to")),
    to: addresses(get(headers, "to")),
    cc: addresses(get(headers, "cc")),
    subject: decodeWords(get(headers, "subject")),
    text: null,
    html: null,
    attachments: [],
    headers: {},
  };
  for (const h of headers) {
    const k = h.name.toLowerCase();
    if (STRUCTURE.has(k) || !/^[A-Za-z0-9-]{1,76}$/.test(h.name)) continue;
    out.headers[h.name] = decodeWords(h.value);
  }
  walk(mime, out, 0);
  return out;
}

const lc = (s: string) => s.trim().toLowerCase();

/**
 * The ACS request for a built message, sent from `sender` to the envelope
 * `rcpt` (the outbox's bare addresses; empty: the To and Cc headers).
 * `replyTo`: the workspace's reply address, used when the message names none.
 */
export function acsRequestFromMime(mime: Buffer, opts: { sender: string; rcpt?: string[]; replyTo?: string }): AcsEmailRequest {
  const p = parseBuiltMime(mime);
  const envelope = (opts.rcpt ?? []).map(lc).filter(Boolean);
  const inEnvelope = (a: AcsAddress) => !envelope.length || envelope.includes(lc(a.address));
  const to = p.to.filter(inEnvelope);
  const cc = p.cc.filter((a) => inEnvelope(a) && !to.some((t) => lc(t.address) === lc(a.address)));
  const named = new Set([...to, ...cc].map((a) => lc(a.address)));
  let bcc: AcsAddress[] = envelope.filter((a) => !named.has(a)).map((address) => ({ address }));
  if (!to.length && !cc.length && bcc.length) {
    // ACS wants someone in To; the envelope is who it is for.
    to.push(...bcc);
    bcc = [];
  }
  if (!to.length && !cc.length) throw new MimeReadError("The message has no recipients.");
  const sender = opts.sender.trim();
  let replyTo: AcsAddress[] | undefined = p.replyTo.length ? p.replyTo : undefined;
  if (!replyTo && p.from && lc(p.from.address) !== lc(sender)) replyTo = [p.from];
  if (!replyTo && opts.replyTo?.trim()) replyTo = [{ address: opts.replyTo.trim() }];
  const content: AcsEmailRequest["content"] = { subject: p.subject };
  if (p.text !== null) content.plainText = p.text;
  if (p.html !== null) content.html = p.html;
  if (content.plainText === undefined && content.html === undefined) content.plainText = "";
  return {
    senderAddress: sender,
    recipients: { to, ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}) },
    content,
    ...(replyTo ? { replyTo } : {}),
    ...(p.attachments.length ? { attachments: p.attachments } : {}),
    ...(Object.keys(p.headers).length ? { headers: p.headers } : {}),
    userEngagementTrackingDisabled: true,
  };
}

/** The request's size as ACS counts it: the JSON body's bytes. */
export function acsRequestBytes(req: AcsEmailRequest): number {
  return Buffer.byteLength(JSON.stringify(req), "utf8");
}
