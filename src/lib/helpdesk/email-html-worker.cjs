"use strict";
// Helpdesk 1.20.8: the "View original" sanitiser, run in a worker thread
// (lib/helpdesk/email-html-sanitize starts it, one email at a time, and
// stops it after 3 seconds). Plain CommonJS on purpose: it is loaded by its
// path, in development, in tests and from the production standalone build
// (next.config.js outputFileTracingIncludes ships it; jsdom and dompurify
// come from node_modules), never bundled.
//
// The sender wrote every byte of the email and it is shown inside an agent's
// signed-in session, so it is treated as hostile. What comes out:
//   - HTML only (no SVG, no MathML). Gone with their content: script, style
//     sheets that load anything, iframe, frame, object, embed, applet,
//     noscript, template, audio, video, canvas, svg, math, title. Gone, their
//     text kept: form, input, button, select, textarea and the rest of a
//     form. Gone: meta (refresh included), base, link (style sheets
//     included), every on* handler, data-* attributes, srcset, the
//     background attribute, poster, ping, formaction.
//   - Links: http(s), mailto and tel only, each opening in a new tab with
//     rel="noopener noreferrer nofollow"; "#part" stays a jump within the
//     email. Anything else (javascript:, data:, a relative address that
//     would point into the desk) loses its address and stays as its text.
//   - Pictures: data:image/(png|jpeg|gif|webp) as they are; cid: from the
//     message's own pictures, none when there is no match; https only when
//     remoteImages is set (Show images), always with
//     referrerpolicy="no-referrer"; http and anything else never.
//   - CSS (style elements and style attributes): CSS escapes and comments
//     are undone again and again until nothing changes (an escape may hide
//     another: "\5c \5c 75rl(" is "url(" after two rounds), and any
//     declaration that still holds a backslash goes; then @import,
//     @font-face, url(), image-set(), image(), cross-fade(), element(),
//     expression(), behavior and -moz-binding are taken out, and "<" is
//     written as a CSS escape so no style text can close its element.
// The caller measures the email first (lib/helpdesk/html-scan) and the
// worker's 3 seconds bound whatever is left.
// 1.20.11, `opts.inline` (the desk conversation shows the email in place,
// lib/helpdesk/email-html originalView): the same cleaning, then the first
// quoted history folded into <details> (foldQuotes, below), pictures on the
// desk's own host dropped, the inline look (INLINE_CSS), and a
// <meta name="compass-email"> the desk reads (pictures hidden, quote folded).

const { JSDOM, VirtualConsole } = require("jsdom");
const purifyModule = require("dompurify");

const createDOMPurify = purifyModule.default || purifyModule;

/** Raised whenever what comes out changes, so kept results are made again (lib/helpdesk/email-html-shared). */
const SANITIZER_VERSION = 2;

// --- CSS -------------------------------------------------------------------------------

/** Functions that make CSS load something, run something, or put it on the page (a vendor prefix of at most 12 letters). */
const CSS_FUNCS = /(?:^|[^a-z0-9_-])((?:-[a-z]{1,12}-)?(?:url|image-set|image|cross-fade|element|expression|src|paint|env))\s*\(/i;

/** One round of undoing CSS escapes ("\75 rl(" is "url(") and comments. */
function decodeOnce(css) {
  return css
    .replace(/\\\r?\n/g, "")
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\r\n\f]?/g, (_m, h) => {
      const cp = parseInt(h, 16);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "�";
    })
    .replace(/\\([^\r\n])/g, "$1")
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ")
    .replace(/\u0000/g, "�");
}

/** Replace each function call the pattern names (to its closing parenthesis, strings respected) with `none`. */
function dropFunctions(css) {
  let out = "";
  let rest = css;
  for (let guard = 0; guard < 100000; guard++) {
    const m = CSS_FUNCS.exec(rest);
    if (!m) break;
    const start = m.index + m[0].indexOf(m[1]);
    let i = m.index + m[0].length;
    let level = 1;
    let quote = "";
    for (; i < rest.length && level > 0; i++) {
      const c = rest[i];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "(") level++;
      else if (c === ")") level--;
    }
    out += `${rest.slice(0, start)}none`;
    rest = rest.slice(i);
  }
  return out + rest;
}

/**
 * A style sheet or a style attribute with everything that loads, runs or
 * escapes taken out. Empty when nothing is left.
 */
function cleanCss(css) {
  let s = String(css == null ? "" : css).slice(0, 2000000);
  // Escapes and comments, undone until nothing changes.
  for (let round = 0; round < 12; round++) {
    const next = decodeOnce(s);
    if (next === s) break;
    s = next;
  }
  // Whatever still holds a backslash hides something: its declaration (the text between ; { and }) goes.
  if (s.includes("\\")) {
    s = s
      .split(/([;{}])/)
      .map((part) => (part.includes("\\") ? "" : part))
      .join("");
  }
  for (let pass = 0; pass < 4; pass++) {
    const before = s;
    s = s
      .replace(/@import\b[^;{}]*;?/gi, "")
      .replace(/@font-face\s*\{[^{}]*\}/gi, "")
      .replace(/@(?:font-face|namespace|document|-moz-document)\b[^;{}]*[;{]?/gi, "")
      .replace(/(?:behavior|-moz-binding|-ms-behavior)\s*:[^;}]*;?/gi, "")
      .replace(/(?:java|vb)script\s*:/gi, "");
    s = dropFunctions(s);
    if (s === before) break;
  }
  // Still something that loads after four passes: nothing of it is kept.
  if (CSS_FUNCS.test(s) || /@import|javascript\s*:/i.test(s)) return "";
  // No style text may close its element or open markup: "<" becomes a CSS escape (the same character to CSS).
  return s.replace(/</g, "\\3c ").trim();
}

// --- Links and pictures ------------------------------------------------------------------

const SAFE_IMAGE_DATA = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

/** A Content-ID as the HTML and the attachment name it: angle brackets, URL escapes and case undone (as lib/helpdesk/email-html-sanitize cidKey). */
function cidKey(raw) {
  let s = String(raw == null ? "" : raw).trim().replace(/^cid:/i, "");
  try {
    s = decodeURIComponent(s);
  } catch {
    /* kept as written */
  }
  return s.replace(/^</, "").replace(/>$/, "").trim().toLowerCase().slice(0, 500);
}

function absoluteUrl(raw, schemes) {
  const v = raw.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (!v || v.length > 4000) return null;
  try {
    const u = new URL(v);
    if (!schemes.includes(u.protocol)) return null;
    if ((u.protocol === "http:" || u.protocol === "https:") && (!u.hostname || u.username || u.password)) return null;
    return u.href;
  } catch {
    return null;
  }
}

// --- The sanitiser ----------------------------------------------------------------------

let state = null;
let purifier = null;

const FORBID_TAGS = [
  "script", "noscript", "template", "iframe", "frame", "frameset", "object", "embed", "applet", "param",
  "form", "input", "button", "select", "option", "optgroup", "textarea", "datalist", "output", "keygen", "fieldset", "legend", "label",
  "meta", "base", "link", "title", "svg", "math", "audio", "video", "source", "track", "canvas", "portal", "dialog", "slot",
  "xmp", "plaintext", "noembed", "noframes", "image", "isindex", "menuitem",
];
const FORBID_ATTR = ["srcset", "background", "poster", "ping", "formaction", "action", "lowsrc", "dynsrc", "longdesc", "xmlns", "autofocus", "accesskey", "tabindex", "contenteditable", "is", "popover", "target", "rel"];

function instance() {
  if (purifier) return purifier;
  // No scripts run and nothing is fetched (jsdom's defaults); a sender's broken CSS is not the server log's business.
  const { window } = new JSDOM("<!doctype html><html><head></head><body></body></html>", { virtualConsole: new VirtualConsole() });
  const p = createDOMPurify(window);
  p.addHook("uponSanitizeElement", (node) => {
    // A style sheet: cleaned before DOMPurify's own checks see it (its "<" check would otherwise drop the email's whole look).
    if (node.nodeName === "STYLE") node.textContent = cleanCss(node.textContent || "");
  });
  p.addHook("afterSanitizeAttributes", (el) => {
    if (!el.getAttribute) return;
    const s = state;
    const tag = el.nodeName;
    if (el.hasAttribute("style")) {
      const clean = cleanCss(el.getAttribute("style") || "");
      if (clean) el.setAttribute("style", clean);
      else el.removeAttribute("style");
    }
    for (const attr of ["xlink:href", "href"]) {
      if (!el.hasAttribute(attr)) continue;
      const raw = el.getAttribute(attr) || "";
      el.removeAttribute(attr);
      if (attr !== "href" || (tag !== "A" && tag !== "AREA")) continue;
      if (/^#[^\s]{0,200}$/.test(raw.trim())) {
        el.setAttribute("href", raw.trim());
        continue;
      }
      const url = absoluteUrl(raw, ["http:", "https:", "mailto:", "tel:"]);
      if (!url) continue;
      el.setAttribute("href", url);
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer nofollow");
      el.setAttribute("referrerpolicy", "no-referrer");
    }
    if (tag === "IMG") {
      const raw = (el.getAttribute("src") || "").trim();
      el.removeAttribute("src");
      el.setAttribute("referrerpolicy", "no-referrer");
      if (/^cid:/i.test(raw)) {
        const data = s.cids.get(cidKey(raw));
        if (data) el.setAttribute("src", data);
        else s.missingCids++;
      } else if (/^data:/i.test(raw)) {
        if (raw.length <= 2000000 && SAFE_IMAGE_DATA.test(raw)) el.setAttribute("src", raw);
      } else if (/^https:/i.test(raw)) {
        const url = absoluteUrl(raw, ["https:"]);
        // 1.20.11: the inline variant is same-origin with the desk, so a picture on the desk's own host
        // (which would carry the agent's cookies) is never loaded nor offered.
        if (url && s.selfHost && new URL(url).hostname.toLowerCase() === s.selfHost) return;
        if (url && s.remote) el.setAttribute("src", url);
        else if (url) s.remoteImages++;
      } else if (/^http:/i.test(raw)) {
        s.insecureImages++;
      }
    }
  });
  purifier = p;
  return p;
}

// --- Quoted history (1.20.11, the desk conversation's inline variant only) ----------------
//
// A reply's HTML carries the whole earlier thread, which the conversation already shows message by message.
// The first quote is folded into <details><summary>Show quoted text</summary>…</details> (no script needed),
// from where it starts to the end of the email. Conservative, as lib/helpdesk/inbound-parse stripQuotedReply is
// for the text body: when unsure, nothing is folded. What starts a quote:
//   - Gmail: div.gmail_quote (its "On … wrote:" line is inside it);
//   - Yahoo: an element whose class or id holds "yahoo_quoted";
//   - Outlook on the web and new Outlook: #appendonsend, #divRplyFwdMsg (with the rule just before it),
//     #mail-editor-reference-message-container;
//   - Outlook desktop: a block with a solid top border whose text is a "From: … Sent: … To:/Subject: …" header;
//   - "-----Original Message-----" (and its translations) starting a line;
//   - Apple Mail and Thunderbird: blockquote[type=cite], with the "On … wrote:" line (or .moz-cite-prefix) just before it;
//   - any other blockquote with an "On … wrote:" line (or a translation) just before it.
// Never folded: a forward (its marker before the quote or at its top: the forwarded part is the content), a
// quote with new text after it outside the quote (an answer written below or between quoted lines), and an
// email with nothing but the quote (nothing would be left to read).

const ATTRIBUTION = [
  /^On\b[\s\S]{0,300}\bwrote:$/i,
  /^Le\b[\s\S]{0,300}\ba écrit\s*:$/i,
  /^Am\b[\s\S]{0,300}\bschrieb\b[\s\S]{0,200}:$/i,
  /^El\b[\s\S]{0,300}\bescribió:$/i,
  /^Op\b[\s\S]{0,300}\bschreef\b[\s\S]{0,200}:$/i,
];
const ORIGINAL_MESSAGE = /^-{2,}\s*(?:Original Message|Ursprüngliche Nachricht|Message d'origine|Oorspronkelijk bericht|Mensaje original)\s*-{2,}/i;
const FORWARD =
  /-{2,}\s*(?:Forwarded message|Forwarded Message|Message transféré|Weitergeleitete Nachricht|Mensaje reenviado|Doorgestuurd bericht)\s*-{2,}|Begin forwarded message:|Début du message réexpédié|Anfang der weitergeleiteten Nachricht/i;
const HEADER_FROM = /^(?:From|De|Von|Van|Da)\s?:/i;
const HEADER_SENT = /(?:^|\s)(?:Sent|Date|Envoyé|Gesendet|Verzonden|Inviato|Enviado|Datum)\s?:/i;
const HEADER_TO = /(?:^|\s)(?:To|Subject|À|An|Objet|Betreff|Aan|Onderwerp|Oggetto|Para|Asunto)\s?:/i;

const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();
const isAttribution = (s) => {
  const t = squash(s);
  return t.length > 0 && t.length < 400 && ATTRIBUTION.some((re) => re.test(t));
};

/** The node before `node` among its siblings, passing over whitespace and line breaks. */
function previousContent(node) {
  let p = node.previousSibling;
  while (p && ((p.nodeType === 3 && !p.nodeValue.trim()) || p.nodeName === "BR")) p = p.previousSibling;
  return p;
}

/** Text in the range from `start` to the end of `body`, outside the quote containers listed. */
function textAfter(doc, body, after) {
  const r = doc.createRange();
  r.setStartAfter(after);
  r.setEnd(body, body.childNodes.length);
  const frag = r.cloneContents();
  for (const q of frag.querySelectorAll("blockquote, div.gmail_quote, [class*='yahoo_quoted'], [id*='yahoo_quoted']")) q.remove();
  return squash(frag.textContent);
}

/** Where the quoted history starts and whether new text may follow it ("container": it must not), or null. */
function quoteStart(doc, body) {
  const found = [];
  const add = (start, end) => start && found.push({ start, end });
  for (const el of body.querySelectorAll("div.gmail_quote")) if (!el.parentElement.closest("div.gmail_quote")) add(el, el);
  for (const el of body.querySelectorAll("[class*='yahoo_quoted'], [id*='yahoo_quoted']")) add(el, el);
  for (const el of body.querySelectorAll("#appendonsend, #mail-editor-reference-message-container")) add(el, null);
  for (const el of body.querySelectorAll("#divRplyFwdMsg")) {
    const before = previousContent(el);
    add(before && before.nodeName === "HR" ? before : el, null);
  }
  for (const el of body.querySelectorAll("div[style*='border-top'], p[style*='border-top']")) {
    const style = el.getAttribute("style") || "";
    if (!/border-top(?:-style)?\s*:[^;]*\bsolid\b/i.test(style)) continue;
    if ((el.textContent || "").length > 1500) continue;
    // Its lines as the eye reads them (a line break between "Sent: …" and "To: …" is a space).
    const lines = el.cloneNode(true);
    for (const br of lines.querySelectorAll("br, p, div")) br.before(doc.createTextNode(" "));
    const t = squash(lines.textContent);
    if (HEADER_FROM.test(t) && HEADER_SENT.test(t) && HEADER_TO.test(t)) add(el, null);
  }
  const walker = doc.createTreeWalker(body, 4 /* text */);
  for (let n = walker.nextNode(), seen = 0; n && seen < 200000; n = walker.nextNode(), seen++) {
    if (ORIGINAL_MESSAGE.test(n.nodeValue.trim())) {
      add(n, null);
      break;
    }
  }
  for (const q of body.querySelectorAll("blockquote")) {
    if (q.parentElement.closest("blockquote")) continue;
    const before = previousContent(q);
    const prefix = before && before.nodeType === 1 && before.classList.contains("moz-cite-prefix");
    if (prefix || (before && isAttribution(before.textContent))) add(before, q);
    else if (q.getAttribute("type") === "cite") add(q, q);
  }
  if (!found.length) return null;
  // The first in the document wins.
  found.sort((a, b) => (a.start === b.start ? 0 : a.start.compareDocumentPosition(b.start) & 4 ? -1 : 1));
  return found[0];
}

/** Fold the first quoted history of the email's body. True when something was folded. */
function foldQuotes(doc, body) {
  const q = quoteStart(doc, body);
  if (!q) return false;
  const before = doc.createRange();
  before.setStart(body, 0);
  before.setEndBefore(q.start);
  const head = before.cloneContents();
  const kept = squash(head.textContent);
  // Nothing of its own before the quote: shown whole.
  if (!kept && !head.querySelector("img")) return false;
  // A forward: its marker before the quote, or at the quote's top.
  const startText = q.start.nodeType === 3 ? q.start.nodeValue : q.start.textContent;
  if (FORWARD.test(kept.slice(-2000)) || FORWARD.test(squash(startText).slice(0, 600))) return false;
  // An answer written after the quote (below it, or between quoted parts): shown whole.
  if (q.end && textAfter(doc, body, q.end)) return false;
  const range = doc.createRange();
  range.setStartBefore(q.start);
  range.setEnd(body, body.childNodes.length);
  const quoted = range.extractContents();
  const details = doc.createElement("details");
  details.setAttribute("class", "cd-quote");
  const summary = doc.createElement("summary");
  const show = doc.createElement("span");
  show.setAttribute("class", "cd-quote-show");
  show.textContent = "Show quoted text";
  const hide = doc.createElement("span");
  hide.setAttribute("class", "cd-quote-hide");
  hide.textContent = "Hide quoted text";
  summary.append(show, hide);
  const inner = doc.createElement("div");
  inner.setAttribute("class", "cd-quote-body");
  inner.append(quoted);
  details.append(summary, inner);
  body.append(details);
  return true;
}

/** The light look an email client gives an email, under the email's own styles. */
const BASE_CSS =
  "html{color-scheme:light;background:#fff;color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5}" +
  "body{overflow-wrap:break-word}img{max-width:100%}";

/**
 * 1.20.11, the inline variant: the email sits edge to edge in the desk's message card and the desk sizes the
 * frame to it (the root's height follows the content, never the frame's; nothing scrolls up and down inside),
 * and the folded quote's control looks the same in every email.
 */
const INLINE_CSS =
  "html:root{height:auto!important;min-height:0!important;max-height:none!important;overflow-y:hidden!important}body{margin:0}" +
  "details.cd-quote{display:block!important;margin:12px 0 0!important;padding:0!important;border:0!important}" +
  "details.cd-quote>summary{display:inline-block!important;list-style:none!important;cursor:pointer!important;margin:0!important;padding:1px 10px!important;" +
  "border:1px solid #cbd5e1!important;border-radius:999px!important;background:#f8fafc!important;color:#475569!important;visibility:visible!important;opacity:1!important;" +
  "font:500 12px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif!important;text-decoration:none!important}" +
  "details.cd-quote>summary::-webkit-details-marker{display:none}" +
  "details.cd-quote>summary:hover{background:#f1f5f9!important;color:#1e293b!important}" +
  "details.cd-quote>summary:focus-visible{outline:2px solid #475569!important;outline-offset:2px!important}" +
  "details.cd-quote[open]>summary .cd-quote-show,details.cd-quote:not([open])>summary .cd-quote-hide{display:none!important}" +
  "details.cd-quote>.cd-quote-body{margin-top:8px}";

/**
 * The email as a whole HTML document, safe to serve under the original
 * route's policy. `opts.cids`: [Content-ID key, data: URI] pairs.
 * { ok: true, html, remoteImages, insecureImages, missingCids } or
 * { ok: false, reason: "too_complex" }.
 */
function sanitize(html, opts) {
  const o = opts || {};
  const p = instance();
  // 1.20.11: `inline` (the desk conversation's variant): { collapseQuotes, selfHost, truncated }.
  const inline = o.inline && typeof o.inline === "object" ? o.inline : null;
  const selfHost = inline && typeof inline.selfHost === "string" ? inline.selfHost.toLowerCase() : "";
  state = { remote: o.remoteImages === true, cids: new Map(o.cids || []), remoteImages: 0, insecureImages: 0, missingCids: 0, selfHost };
  try {
    const root = p.sanitize(String(html == null ? "" : html), {
      WHOLE_DOCUMENT: true,
      RETURN_DOM: true,
      USE_PROFILES: { html: true },
      FORBID_TAGS,
      FORBID_ATTR,
      ALLOW_DATA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
    });
    const doc = root.ownerDocument;
    let head = root.querySelector("head");
    if (!head) {
      head = doc.createElement("head");
      root.insertBefore(head, root.firstChild);
    }
    const charset = doc.createElement("meta");
    charset.setAttribute("charset", "utf-8");
    const referrer = doc.createElement("meta");
    referrer.setAttribute("name", "referrer");
    referrer.setAttribute("content", "no-referrer");
    const base = doc.createElement("style");
    base.textContent = BASE_CSS;
    head.insertBefore(base, head.firstChild);
    head.insertBefore(referrer, head.firstChild);
    head.insertBefore(charset, head.firstChild);
    let quoted = false;
    if (inline) {
      let body = root.querySelector("body");
      if (!body) {
        body = doc.createElement("body");
        root.appendChild(body);
      }
      if (inline.collapseQuotes === true) quoted = foldQuotes(doc, body);
      const own = doc.createElement("style");
      own.textContent = INLINE_CSS;
      base.after(own);
      // What the desk reads from the frame (it is same-origin): the sender cannot write a meta element.
      const mark = doc.createElement("meta");
      mark.setAttribute("name", "compass-email");
      mark.setAttribute("content", "ok");
      mark.setAttribute("data-remote-images", String(state.remoteImages));
      mark.setAttribute("data-insecure-images", String(state.insecureImages));
      mark.setAttribute("data-quoted", quoted ? "1" : "0");
      mark.setAttribute("data-truncated", inline.truncated === true ? "1" : "0");
      referrer.after(mark);
    }
    return { ok: true, html: `<!doctype html>\n${root.outerHTML}`, remoteImages: state.remoteImages, insecureImages: state.insecureImages, missingCids: state.missingCids, quoted };
  } catch {
    // A stack the parser or the sanitiser could not climb, or anything else: refused, never half-shown.
    return { ok: false, reason: "too_complex" };
  } finally {
    state = null;
  }
}

module.exports = { cleanCss, cidKey, sanitize, SANITIZER_VERSION };

// As a worker: one email per message, answered with its id.
const threads = require("node:worker_threads");
if (!threads.isMainThread && threads.parentPort && threads.workerData && threads.workerData.role === "email-html") {
  threads.parentPort.on("message", (job) => {
    let result;
    try {
      result = sanitize(job.html, job.opts);
    } catch {
      result = { ok: false, reason: "too_complex" };
    }
    threads.parentPort.postMessage({ id: job.id, result });
  });
}
