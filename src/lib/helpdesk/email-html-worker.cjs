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

/** The light look an email client gives an email, under the email's own styles. */
const BASE_CSS =
  "html{color-scheme:light;background:#fff;color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5}" +
  "body{overflow-wrap:break-word}img{max-width:100%}";

/**
 * The email as a whole HTML document, safe to serve under the original
 * route's policy. `opts.cids`: [Content-ID key, data: URI] pairs.
 * { ok: true, html, remoteImages, insecureImages, missingCids } or
 * { ok: false, reason: "too_complex" }.
 */
function sanitize(html, opts) {
  const o = opts || {};
  const p = instance();
  state = { remote: o.remoteImages === true, cids: new Map(o.cids || []), remoteImages: 0, insecureImages: 0, missingCids: 0 };
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
    return { ok: true, html: `<!doctype html>\n${root.outerHTML}`, remoteImages: state.remoteImages, insecureImages: state.insecureImages, missingCids: state.missingCids };
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
