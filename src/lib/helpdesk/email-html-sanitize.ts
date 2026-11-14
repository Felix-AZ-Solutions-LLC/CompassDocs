// Helpdesk 1.20.8: an inbound email's original HTML made safe to show
// ("View original", lib/helpdesk/email-html). The sender wrote every byte of
// it and it is shown inside an agent's signed-in session, so it is treated
// as hostile. Sanitised on output, every time, on the server: DOMPurify on
// jsdom. The route that serves the result adds the second line of defence
// (a sandboxed frame with no scripts and its own origin, and a
// Content-Security-Policy that loads nothing but pictures).
//
// What comes out:
//   - HTML only (no SVG, no MathML). Gone with their content: script,
//     style sheets that load anything, iframe, frame, object, embed, applet,
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
//     message's own pictures (`cids`), none when there is no match; https
//     only when `remoteImages` is set (the agent pressed Show images), and
//     always with referrerpolicy="no-referrer"; http and anything else never.
//   - CSS (style elements and style attributes): CSS escapes and comments
//     are undone first, so they cannot hide anything; then @import,
//     @font-face, url(), image-set(), image(), cross-fade(), element(),
//     expression(), behavior and -moz-binding are taken out, and "<" is
//     written as a CSS escape so no style text can close its element.
//   - Bounds: more than EMAIL_HTML_LIMITS.tags tags or nesting deeper than
//     EMAIL_HTML_LIMITS.depth is refused before parsing ("too_complex"), as
//     is anything the parser or the sanitiser throws on.
//
// The email's own look is kept: no colours, fonts or widths are changed,
// apart from a white page with dark text under it (what an email client
// gives it) and pictures no wider than the frame. Pure apart from jsdom;
// server-only by use (jsdom does not run in a browser bundle).

import { JSDOM, VirtualConsole } from "jsdom";
import createDOMPurify from "dompurify";
import { EMAIL_HTML_LIMITS } from "./email-html-shared";

export interface SanitizeOptions {
  /** Show https pictures (Show images). Default false. */
  remoteImages?: boolean;
  /** Content-ID (normalised by cidKey) → a data: URI of the picture. */
  cids?: Map<string, string>;
}

export type SanitizeResult =
  | { ok: true; html: string; remoteImages: number; insecureImages: number; missingCids: number }
  | { ok: false; reason: "too_complex" };

/** A Content-ID as the HTML and the attachment name it: angle brackets, URL escapes and case undone. */
export function cidKey(raw: string): string {
  let s = String(raw ?? "").trim().replace(/^cid:/i, "");
  try {
    s = decodeURIComponent(s);
  } catch {
    /* kept as written */
  }
  return s.replace(/^<|>$/g, "").trim().toLowerCase().slice(0, 500);
}

// --- Before parsing: is it small and shallow enough to read? ------------------------

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "keygen"]);
/** Elements a browser closes on its own (an unclosed <p> or <td> is no nesting). */
const IMPLIED = new Set(["p", "li", "dt", "dd", "tr", "td", "th", "tbody", "thead", "tfoot", "option", "optgroup", "colgroup", "caption", "rb", "rt", "rp", "html", "head", "body"]);

/** How many elements (opening tags), and an estimate of how deep they nest, in one pass. */
export function htmlComplexity(html: string): { tags: number; depth: number } {
  let tags = 0;
  let depth = 0;
  let max = 0;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]{0,40})\b[^>]*?(\/?)>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1] === "/") {
      if (!VOID.has(m[2].toLowerCase()) && !IMPLIED.has(m[2].toLowerCase())) depth = Math.max(0, depth - 1);
      continue;
    }
    tags++;
    const name = m[2].toLowerCase();
    if (VOID.has(name) || IMPLIED.has(name) || m[3] === "/") continue;
    if (++depth > max) max = depth;
    if (tags > EMAIL_HTML_LIMITS.tags) break;
  }
  return { tags, depth: max };
}

// --- CSS -------------------------------------------------------------------------------

/** Functions and rules that make CSS load something, run something, or put it on the page. */
const CSS_FUNCS = /(?:^|[^a-z0-9_-])((?:-[a-z]+-)?(?:url|image-set|image|cross-fade|element|expression|src|paint|env))\s*\(/i;

/** Undo CSS escapes ("\75 rl(" is "url(") and comments, so nothing can hide behind them. */
function decodeCss(css: string): string {
  return css
    .replace(/\\\r?\n/g, "")
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\r\n\f]?/g, (_m, h: string) => {
      const cp = parseInt(h, 16);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "�";
    })
    .replace(/\\([^\r\n])/g, "$1")
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ")
    .replace(/\u0000/g, "�");
}

/** Replace each function call the pattern names (to its closing parenthesis, strings respected) with `none`. */
function dropFunctions(css: string): string {
  let out = "";
  let rest = css;
  for (let guard = 0; guard < 10_000; guard++) {
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
export function cleanCss(css: string): string {
  let s = decodeCss(String(css ?? "").slice(0, 2_000_000));
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

function absoluteUrl(raw: string, schemes: string[]): string | null {
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

interface CallState {
  remote: boolean;
  cids: Map<string, string>;
  remoteImages: number;
  insecureImages: number;
  missingCids: number;
}

let state: CallState | null = null;
let purifier: ReturnType<typeof createDOMPurify> | null = null;

const FORBID_TAGS = [
  "script", "noscript", "template", "iframe", "frame", "frameset", "object", "embed", "applet", "param",
  "form", "input", "button", "select", "option", "optgroup", "textarea", "datalist", "output", "keygen", "fieldset", "legend", "label",
  "meta", "base", "link", "title", "svg", "math", "audio", "video", "source", "track", "canvas", "portal", "dialog", "slot",
  "xmp", "plaintext", "noembed", "noframes", "image", "isindex", "menuitem",
];
const FORBID_ATTR = ["srcset", "background", "poster", "ping", "formaction", "action", "lowsrc", "dynsrc", "longdesc", "xmlns", "autofocus", "accesskey", "tabindex", "contenteditable", "is", "popover", "target", "rel"];

function instance(): ReturnType<typeof createDOMPurify> {
  if (purifier) return purifier;
  // No scripts run and nothing is fetched (jsdom's defaults); a sender's broken CSS is not the server log's business.
  const { window } = new JSDOM("<!doctype html><html><head></head><body></body></html>", { virtualConsole: new VirtualConsole() });
  const p = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);
  p.addHook("uponSanitizeElement", (node) => {
    // A style sheet: cleaned before DOMPurify's own checks see it (its "<" check would otherwise drop the email's whole look).
    if ((node as Element).nodeName === "STYLE") {
      const clean = cleanCss(node.textContent ?? "");
      node.textContent = clean;
    }
  });
  p.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    if (!el.getAttribute) return;
    const s = state!;
    const tag = el.nodeName;
    if (el.hasAttribute("style")) {
      const clean = cleanCss(el.getAttribute("style") ?? "");
      if (clean) el.setAttribute("style", clean);
      else el.removeAttribute("style");
    }
    for (const attr of ["xlink:href", "href"]) {
      if (!el.hasAttribute(attr)) continue;
      const raw = el.getAttribute(attr) ?? "";
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
      const raw = (el.getAttribute("src") ?? "").trim();
      el.removeAttribute("src");
      el.setAttribute("referrerpolicy", "no-referrer");
      if (/^cid:/i.test(raw)) {
        const data = s.cids.get(cidKey(raw));
        if (data) el.setAttribute("src", data);
        else s.missingCids++;
      } else if (/^data:/i.test(raw)) {
        if (SAFE_IMAGE_DATA.test(raw) && raw.length <= 2_000_000) el.setAttribute("src", raw);
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
 * route's policy. Refuses ("too_complex") an email too large, too deep or
 * too odd to read in bounded time.
 */
export function sanitizeEmailHtml(html: string, opts: SanitizeOptions = {}): SanitizeResult {
  const input = String(html ?? "");
  if (input.length > EMAIL_HTML_LIMITS.storeBytes * 2) return { ok: false, reason: "too_complex" };
  const shape = htmlComplexity(input);
  if (shape.tags > EMAIL_HTML_LIMITS.tags || shape.depth > EMAIL_HTML_LIMITS.depth) return { ok: false, reason: "too_complex" };
  const p = instance();
  state = { remote: opts.remoteImages === true, cids: opts.cids ?? new Map(), remoteImages: 0, insecureImages: 0, missingCids: 0 };
  try {
    const root = p.sanitize(input, {
      WHOLE_DOCUMENT: true,
      RETURN_DOM: true,
      USE_PROFILES: { html: true },
      FORBID_TAGS,
      FORBID_ATTR,
      ALLOW_DATA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
    }) as unknown as HTMLElement;
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
    const out = `<!doctype html>\n${root.outerHTML}`;
    return { ok: true, html: out, remoteImages: state.remoteImages, insecureImages: state.insecureImages, missingCids: state.missingCids };
  } catch {
    // A stack the parser or the sanitiser could not climb, or anything else: refused, never half-shown.
    return { ok: false, reason: "too_complex" };
  } finally {
    state = null;
  }
}
