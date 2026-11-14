// Helpdesk 1.20.9: an email's original on paper ("View original" → Print).
//
// GET /api/helpdesk/messages/{id}/original?print=1 (with &images=1 when the
// agent pressed Show images) answers a print document: a small header the
// desk writes (the ticket, From, the ticket's CCs, when it was received in
// the workspace's time zone, who printed it and when), then the sanitised
// email exactly as the dialog's frame shows it, with print CSS (page
// margins, page numbers, no image cut in two, white paper). The dialog's
// Print opens it in a new tab and the agent prints with the browser's own
// print (Ctrl/Cmd+P); a bar on screen says so and is hidden on paper.
//
// It keeps every guarantee of the 1.20.8 view. The email is the sanitiser's
// output (lib/helpdesk/email-html-sanitize), never copied into a desk page;
// the document is served under the original's policy, run nothing, load
// nothing but pictures, its own opaque origin (sandbox, no allow-scripts,
// no allow-same-origin), with two changes for a page that is never framed
// and is meant to be printed: frame-ancestors 'none', and allow-modals,
// because the HTML standard's printing steps stop for a document whose
// sandbox lacks it (Ctrl+P could do nothing). Without allow-scripts no
// script can open a modal, so allow-modals grants the email nothing. There
// is no automatic print: that would need allow-scripts on a document full
// of sender markup, for the sake of one key press.
//
// The sender writes the email's markup and CSS, so the header is kept out
// of their reach:
//   - every header value (the subject, the names and addresses are the
//     sender's too) is set as text on a DOM node and serialised, never
//     pasted into markup;
//   - the email sits in a declarative shadow root, so its style sheets
//     apply to the email alone and cannot select, hide or restyle the
//     header (a shadow tree's @page rules are not applied either, and are
//     neutralised anyway);
//   - its box contains its layout (position: fixed stays inside it, it is a
//     stacking context of its own) and clips anything pulled above it,
//     while the header sits above it with an opaque, always-printed white;
//   - the page around the email (bar, header, the email's box) is built as
//     a DOM, serialised and read back, and refused unless it has exactly the
//     expected shape; the email goes into its template as the sanitiser
//     wrote it, refused if it holds "</template" anywhere, the only token
//     that could end a template early (its text and its style sheets cannot:
//     the serialiser escapes "<" in text and the sanitiser in CSS).
//
// Cost: the email itself is never parsed again here. The sanitiser does the
// parsing (and its bounds and time limit, 1.20.8); this file adds string
// work linear in the email's size and a small, fixed-size DOM for the page.
//
// The query: print=1, with images=1 or not; a repeated print or images is
// refused with 400, as the view refuses a repeated images.
//
// Not audited, like viewing the original: printing it is reading a message.
// Server-only.

import "server-only";
import { JSDOM, VirtualConsole } from "jsdom";
import { formatDateTime } from "../format";
import { getAppSettings } from "../settings-store";
import { listCcs } from "./ccs";
import { hqOne } from "./db-core";
import { originalHeaders, type OriginalView } from "./email-html";
import { HD_ORIGINAL_COPY } from "./email-html-shared";
import { HD_ORIGINAL_PRINT_COPY as COPY } from "./email-html-print-shared";

/** The print view's policy: the original's, never framed, and printable (see the top of this file). */
export function originalPrintCsp(baseCsp: string): string {
  return baseCsp
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      if (/^frame-ancestors\b/i.test(d)) return "frame-ancestors 'none'";
      if (/^sandbox\b/i.test(d)) {
        // Never scripts, never its own origin, whatever the base says.
        const flags = d.split(/\s+/).slice(1).filter((f) => !/^allow-(scripts|same-origin|top-navigation.*|forms|modals)$/i.test(f));
        return ["sandbox", ...flags, "allow-modals"].join(" ");
      }
      return d;
    })
    .join("; ");
}

/** The response headers of the print view (next.config.js states the same policy for ?print=1). */
export function originalPrintHeaders(remoteImages: boolean): Record<string, string> {
  const h = originalHeaders(remoteImages);
  return { ...h, "Content-Security-Policy": originalPrintCsp(h["Content-Security-Policy"]), "X-Frame-Options": "DENY" };
}

/** What the print header says; every value is plain text. */
export interface OriginalPrintHeader {
  number: number;
  subject: string;
  from: string;
  ccs: string;
  received: string;
  printed: string;
  internal: boolean;
  truncated: boolean;
  /** https pictures left out (Show images not pressed). */
  imagesLeftOut: number;
  insecure: number;
}

/** No control characters, no runaway lengths: a header line stays a line. */
function line(v: unknown, max = 500): string {
  // eslint-disable-next-line no-control-regex
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function person(name: string, email: string): string {
  const n = line(name, 200);
  const e = line(email, 320);
  if (n && e && n.toLowerCase() !== e.toLowerCase()) return `${n} <${e}>`;
  return n || e || "Unknown";
}

/** The header for one message (the caller has checked the viewer may read it). */
export async function originalPrintHeader(
  viewer: { name?: string | null; username?: string | null },
  ticket: { id: number; number: number; subject: string },
  messageId: number,
  info: { truncated: boolean; remote_images: number; insecure_images: number },
  remoteImages: boolean,
  now = new Date()
): Promise<OriginalPrintHeader> {
  const [settings, msg, ccs] = await Promise.all([
    getAppSettings(),
    hqOne<{ author_name: string; author_email: string; kind: string; created_at: string | Date }>(
      "SELECT author_name, author_email, kind, created_at FROM hd_messages WHERE id = $1",
      [messageId]
    ),
    listCcs(ticket.id),
  ]);
  // The workspace's time zone and formats (not the viewer's own): a printed record reads the same whoever prints it.
  const zone = settings.timezone ? ` (${settings.timezone})` : "";
  const at = (d: string | Date | undefined) => (d ? `${formatDateTime(new Date(d).toISOString(), settings)}${zone}` : "");
  return {
    number: ticket.number,
    subject: line(ticket.subject, 1000),
    from: person(msg?.author_name ?? "", msg?.author_email ?? ""),
    ccs: ccs.map((c) => person(c.name, c.email)).join(", ") || COPY.noCcs,
    received: at(msg?.created_at),
    printed: COPY.printed(line(viewer.name || viewer.username || "", 200) || "Unknown", at(now)),
    internal: msg?.kind === "internal",
    truncated: info.truncated,
    imagesLeftOut: remoteImages ? 0 : info.remote_images,
    insecure: info.insecure_images,
  };
}

// --- The document ------------------------------------------------------------------------

/** The page around the email: screen preview, paper, the header. Static apart from the ticket number. */
function pageCss(number: number): string {
  const n = Number.isSafeInteger(number) ? number : 0;
  return `@page {
  size: auto;
  margin: 16mm 15mm 18mm;
  @bottom-left { content: "Ticket #${n} \\B7  Original email"; font: 7.5pt system-ui, sans-serif; color: #475569; vertical-align: top; padding-top: 2.5mm; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 7.5pt system-ui, sans-serif; color: #475569; vertical-align: top; padding-top: 2.5mm; }
}
html { color-scheme: light; background: #f1f5f9; color: #000; }
body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.cd-bar { position: sticky; top: 0; z-index: 2147483647; display: flex; justify-content: center; padding: 10px 16px; background: #1e293b; color: #fff; font-size: 13px; text-align: center; }
.cd-sheet { box-sizing: border-box; max-width: 860px; margin: 24px auto; padding: 32px 40px; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; }
.cd-head { position: relative; z-index: 2147483646; background: #fff; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; padding-bottom: 12px; margin-bottom: 16px; border-bottom: 1.5px solid #000; break-inside: avoid; break-after: avoid; }
.cd-head h1 { margin: 0 0 8px; font-size: 18px; line-height: 1.3; font-weight: 700; color: #000; overflow-wrap: anywhere; }
.cd-head dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 16px; margin: 0; font-size: 12.5px; }
.cd-head dt { color: #334155; }
.cd-head dd { margin: 0; color: #000; overflow-wrap: anywhere; }
.cd-head p { margin: 8px 0 0; font-size: 12px; color: #000; }
.cd-head .cd-printed { color: #334155; }
.cd-mail { contain: layout; isolation: isolate; overflow-y: clip; overflow-x: visible; }
.cd-host { display: block; }
@media print {
  html, body { background: #fff; }
  .cd-bar { display: none; }
  .cd-sheet { max-width: none; margin: 0; padding: 0; border: 0; border-radius: 0; }
}
@media (max-width: 640px) {
  .cd-sheet { margin: 0; padding: 20px 16px; border: 0; border-radius: 0; }
}`;
}

/** Inside the shadow root, before the email's own sheets: the dialog's base look, and pictures and rows that do not split. */
const SHADOW_BASE_CSS =
  ":host{display:block}" +
  ".cd-body{color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;overflow-wrap:break-word}" +
  "img{max-width:100%;break-inside:avoid}tr,img,figure{break-inside:avoid}h1,h2,h3,h4,h5,h6{break-after:avoid}";

/** A shadow tree's @page rules are ignored by browsers; an unknown at-rule is ignored whole, so make them that too. */
function neutralise(css: string): string {
  return css.replace(/@page\b/gi, "@x-cd-page");
}

/** The end of the start tag at `at` in serialiser output (attribute values double-quoted), or -1. */
function tagEnd(s: string, at: number): number {
  let quoted = false;
  for (let i = at; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34) quoted = !quoted;
    else if (c === 62 && !quoted) return i;
  }
  return -1;
}

/** dir, lang and style of a serialised start tag's attributes, as written (the serialiser escaped their values). */
function keptAttrs(attrs: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of attrs.matchAll(/\s([a-zA-Z][-a-zA-Z0-9_:.]*)="([^"]*)"/g)) {
    const name = m[1].toLowerCase();
    if ((name === "dir" || name === "lang" || name === "style") && !out.has(name)) out.set(name, m[2]);
  }
  return out;
}

/**
 * The sanitiser's whole document ("<!doctype html>" then <html…><head>…</head><body…>…</body></html>)
 * as the inside of the email's box: everything within <html>, plus the attributes the box keeps from
 * <body> (and <html>). Null when it is not that shape.
 */
function splitSanitised(doc: string): { inner: string; attrs: string } | null {
  const lead = /^\s*<!doctype html>\s*<html\b/i.exec(doc);
  if (!lead) return null;
  const htmlOpen = lead[0].length - "<html".length;
  const htmlEnd = tagEnd(doc, htmlOpen);
  const close = doc.lastIndexOf("</html>");
  if (htmlEnd < 0 || close < htmlEnd || doc.slice(close + 7).trim()) return null;
  const inner = doc.slice(htmlEnd + 1, close);
  const b = inner.indexOf("</head><body");
  if (b < 0 || !/[\s>]/.test(inner.charAt(b + 12))) return null;
  const bodyEnd = tagEnd(inner, b + 7);
  if (bodyEnd < 0) return null;
  // dir and lang from <html> unless <body> says otherwise; style from <body> alone.
  const kept = keptAttrs(doc.slice(htmlOpen + 5, htmlEnd));
  kept.delete("style");
  for (const [k, v] of keptAttrs(inner.slice(b + 12, bodyEnd))) kept.set(k, v);
  return { inner, attrs: [...kept].map(([k, v]) => ` ${k}="${v}"`).join("") };
}

const MARK = "cd-email";

/** The page around the email, as a DOM: the bar, the header (every value set as text), the email's box with an empty template. */
function pageSkeleton(h: OriginalPrintHeader): string {
  const out = new JSDOM(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title></title><style></style></head><body></body></html>',
    { virtualConsole: new VirtualConsole() }
  ).window.document;
  out.title = COPY.pageTitle(h.number);
  out.head.querySelector("style")!.textContent = pageCss(h.number);

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const e = out.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const bar = el("div", "cd-bar", COPY.bar);
  bar.setAttribute("role", "note");
  out.body.appendChild(bar);

  const sheet = el("main", "cd-sheet");
  out.body.appendChild(sheet);
  const head = el("header", "cd-head");
  head.appendChild(el("h1", undefined, `#${h.number} ${h.subject}`));
  const dl = el("dl");
  for (const [k, v] of [
    [COPY.from, h.from],
    [COPY.ccs, h.ccs],
    [COPY.received, h.received],
  ] as const) {
    dl.appendChild(el("dt", undefined, k));
    dl.appendChild(el("dd", undefined, v));
  }
  head.appendChild(dl);
  if (h.internal) head.appendChild(el("p", undefined, COPY.internal));
  if (h.truncated) head.appendChild(el("p", undefined, COPY.truncated));
  if (h.imagesLeftOut > 0) head.appendChild(el("p", undefined, COPY.imagesLeftOut));
  if (h.insecure > 0) head.appendChild(el("p", undefined, COPY.insecure(h.insecure)));
  head.appendChild(el("p", "cd-printed", h.printed));
  sheet.appendChild(head);

  const mail = el("div", "cd-mail");
  const host = el("div", "cd-host");
  const tpl = el("template");
  tpl.setAttribute("shadowrootmode", "open");
  tpl.content.appendChild(out.createComment(MARK));
  host.appendChild(tpl);
  mail.appendChild(host);
  sheet.appendChild(mail);
  return `<!doctype html>\n${out.documentElement.outerHTML}`;
}

/**
 * The print document: the header, then the sanitised email (`emailHtml`, the
 * sanitiser's whole document) in its own shadow root. Null when the page
 * does not read back in its shape or the email is not the sanitiser's shape
 * or could end its template (it is then not served). Pure: string in,
 * string out.
 */
export function buildOriginalPrintDocument(emailHtml: string, h: OriginalPrintHeader): string | null {
  const email = splitSanitised(String(emailHtml ?? ""));
  if (!email || /<\/template/i.test(email.inner)) return null;
  const page = pageSkeleton(h);
  if (!hasExpectedShape(page)) return null;
  const parts = page.split(`<!--${MARK}-->`);
  if (parts.length !== 2) return null;
  // Inside a template the email's <html>, <head> and <body> tags are ignored; its style sheets apply within the shadow root.
  const inner = email.inner.replace(/(<style\b[^>]*>)([^<]*)(<\/style>)/gi, (_m, a: string, css: string, z: string) => a + neutralise(css) + z);
  return `${parts[0]}<style>${SHADOW_BASE_CSS}</style><div class="cd-body"${email.attrs}>${inner}</div>${parts[1]}`;
}

/**
 * Read a page back the way a browser's parser will: the head is ours
 * alone, the body is the bar and the sheet, the sheet is the header and the
 * email's box, and the box holds one template and nothing else.
 */
export function hasExpectedShape(html: string): boolean {
  try {
    const doc = new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document;
    const tags = (p: Element | null | undefined) => [...(p?.children ?? [])].map((c) => `${c.tagName.toLowerCase()}${c.className ? `.${c.className}` : ""}`).join(" ");
    if (tags(doc.head) !== "meta meta title style") return false;
    if (tags(doc.body) !== "div.cd-bar main.cd-sheet") return false;
    const sheet = doc.body.children[1];
    if (tags(sheet) !== "header.cd-head div.cd-mail") return false;
    // The header: a heading, the rows, then lines; text only all the way down.
    const header = sheet.children[0];
    if (!/^h1 dl( p)* p\.cd-printed$/.test(tags(header))) return false;
    if (!/^(dt dd)( dt dd)*$/.test(tags(header.children[1]))) return false;
    if (header.querySelectorAll("*").length !== header.children.length + header.children[1].children.length) return false;
    if (tags(sheet.children[1]) !== "div.cd-host") return false;
    const host = sheet.children[1].children[0];
    if (tags(host) !== "template" || host.childNodes.length !== 1) return false;
    if (host.children[0].getAttribute("shadowrootmode") !== "open") return false;
    // One template in the document's own tree, and no element anywhere outside it but ours.
    if (doc.querySelectorAll("template").length !== 1) return false;
    // The bar, the sheet, the header and what is in it, the email's box, its host and the template: nothing else.
    if (doc.querySelectorAll("body *").length !== 6 + header.querySelectorAll("*").length) return false;
    return true;
  } catch {
    return false;
  }
}

/** The query's print flag: none, print=1, or refused (print, or images beside print=1, given more than once). */
export function printQuery(url: URL): "none" | "print" | "repeated" {
  const print = url.searchParams.getAll("print");
  if (print.length > 1) return "repeated";
  if (print[0] !== "1") return "none";
  return url.searchParams.getAll("images").length > 1 ? "repeated" : "print";
}

/** The answer to a repeated print or images. */
export function repeatedPrintQuery(): Response {
  return Response.json({ error: "Give print and images once each." }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
}

/** The route's answer for ?print=1 (the caller has checked the viewer may read the message). */
export async function originalPrintResponse(
  viewer: { name?: string | null; username?: string | null },
  ticket: { id: number; number: number; subject: string },
  messageId: number,
  view: OriginalView,
  remoteImages: boolean
): Promise<Response> {
  const refuse = () => {
    const page = `<!doctype html><html><head><meta charset="utf-8"><style>html{font-family:system-ui,sans-serif;font-size:14px;color:#1f2937;background:#fff}</style></head><body><p>${HD_ORIGINAL_COPY.tooComplex}</p></body></html>`;
    return new Response(page, { status: 422, headers: originalPrintHeaders(false) });
  };
  if (!view.ok) return refuse();
  const header = await originalPrintHeader(viewer, ticket, messageId, view.info, remoteImages);
  const doc = buildOriginalPrintDocument(view.html, header);
  if (!doc) return refuse();
  return new Response(doc, { status: 200, headers: originalPrintHeaders(remoteImages) });
}
