// Helpdesk 1.20.8 (security review): a sender's HTML measured, and turned
// into plain text, in one linear pass, before anything parses it. No regular
// expression runs over the sender's markup here: every loop moves forward and
// every search (indexOf) starts where the last one ended, so a hostile email
// costs time in proportion to its length and nothing more.
//
//   scanHtml       how many elements, attributes (per tag and in all) and how
//                  deep the elements really nest, with an open-element stack:
//                  a closing tag that was never opened lowers nothing, a
//                  self-closing "/>" on an ordinary element opens it as a
//                  browser does, and a browser's implied closings (<p>, <li>,
//                  <td>…) are not counted as nesting. It stops at the first
//                  limit passed and says which (`over`).
//   linearHtmlText the text of HTML that is over the limits (no parser):
//                  tags dropped, scripts and styles with their content,
//                  block tags as line breaks, the common entities decoded.
//
// Used before the email's HTML is parsed for its text (lib/helpdesk/
// inbound-parse htmlToText) and before it is sanitised for "View original"
// (lib/helpdesk/email-html). Pure.

export const HTML_SCAN_LIMITS = {
  /** Elements (opening tags). */
  elements: 60_000,
  /** How deep elements nest. */
  depth: 400,
  /** Attributes on one tag. */
  tagAttrs: 200,
  /** Attributes in all. */
  attrs: 200_000,
} as const;

export interface HtmlShape {
  elements: number;
  depth: number;
  attrs: number;
  maxTagAttrs: number;
  /** The first limit passed, or false. */
  over: false | "elements" | "depth" | "tag_attrs" | "attrs";
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "keygen", "frame", "basefont", "bgsound", "image"]);
/** Elements a browser closes on its own: an unclosed <p> or <td> is no nesting. */
const IMPLIED = new Set(["p", "li", "dt", "dd", "tr", "td", "th", "tbody", "thead", "tfoot", "option", "optgroup", "colgroup", "caption", "rb", "rt", "rp", "rtc", "html", "head", "body"]);
/** Elements whose content is text up to their own closing tag. */
const RAW = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"]);

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameChar = (c: number) => isAlpha(c) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95 || c === 46;

interface Tag {
  /** Lower-cased name, '' when the "<" opens no tag (plain text). */
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: number;
  /** Index just after the tag (or the comment, or the declaration). */
  end: number;
  /** A comment, a doctype or a processing instruction. */
  other: boolean;
}

/** The tag that starts at `lt` (s[lt] === "<"), read forward only. */
function readTag(s: string, lt: number): Tag {
  const n = s.length;
  let i = lt + 1;
  const c = s.charCodeAt(i);
  if (c === 33 || c === 63) {
    // <!-- comment -->, <!doctype …>, <![CDATA[…]]>, <?…>
    if (s.startsWith("!--", i)) {
      const e = s.indexOf("-->", i + 3);
      return { name: "", closing: false, selfClosing: false, attrs: 0, end: e < 0 ? n : e + 3, other: true };
    }
    const e = s.indexOf(">", i);
    return { name: "", closing: false, selfClosing: false, attrs: 0, end: e < 0 ? n : e + 1, other: true };
  }
  let closing = false;
  if (c === 47) {
    closing = true;
    i++;
  }
  if (!isAlpha(s.charCodeAt(i))) return { name: "", closing: false, selfClosing: false, attrs: 0, end: lt + 1, other: false };
  const start = i;
  while (i < n && isNameChar(s.charCodeAt(i))) i++;
  const name = s.slice(start, Math.min(i, start + 40)).toLowerCase();
  let attrs = 0;
  let selfClosing = false;
  while (i < n) {
    let ch = s.charCodeAt(i);
    if (isSpace(ch)) {
      i++;
      continue;
    }
    if (ch === 62) {
      selfClosing = s.charCodeAt(i - 1) === 47;
      i++;
      break;
    }
    if (ch === 47) {
      i++;
      continue;
    }
    // An attribute: its name, then maybe "=" and a value.
    const a0 = i;
    i++;
    while (i < n) {
      ch = s.charCodeAt(i);
      if (isSpace(ch) || ch === 47 || ch === 62 || ch === 61) break;
      i++;
    }
    attrs++;
    while (i < n && isSpace(s.charCodeAt(i))) i++;
    if (s.charCodeAt(i) === 61 && i > a0) {
      i++;
      while (i < n && isSpace(s.charCodeAt(i))) i++;
      const q = s.charCodeAt(i);
      if (q === 34 || q === 39) {
        const e = s.indexOf(q === 34 ? '"' : "'", i + 1);
        i = e < 0 ? n : e + 1;
      } else {
        while (i < n) {
          ch = s.charCodeAt(i);
          if (isSpace(ch) || ch === 62) break;
          i++;
        }
      }
    }
  }
  return { name, closing, selfClosing, attrs, end: i, other: false };
}

/** Where the raw text of `name` ends: the next "</name" (any case), or the end. */
function rawEnd(s: string, from: number, name: string): number {
  if (name === "plaintext") return s.length;
  let i = from;
  for (;;) {
    const at = s.indexOf("</", i);
    if (at < 0) return s.length;
    if (s.slice(at + 2, at + 2 + name.length).toLowerCase() === name && !isNameChar(s.charCodeAt(at + 2 + name.length))) return at;
    i = at + 2;
  }
}

/** The shape of a sender's HTML, read in one forward pass; stops at the first limit passed. */
export function scanHtml(html: string, limits: { elements: number; depth: number; tagAttrs: number; attrs: number } = HTML_SCAN_LIMITS): HtmlShape {
  const s = String(html ?? "");
  const out: HtmlShape = { elements: 0, depth: 0, attrs: 0, maxTagAttrs: 0, over: false };
  const stack: string[] = [];
  const open = new Map<string, number>();
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) break;
    const t = readTag(s, lt);
    i = t.end;
    if (t.other || !t.name) continue;
    if (t.closing) {
      if (VOID.has(t.name) || IMPLIED.has(t.name) || !open.get(t.name)) continue;
      // Close up to the matching element: each element is popped once, so this is linear overall.
      for (;;) {
        const top = stack.pop()!;
        open.set(top, (open.get(top) ?? 1) - 1);
        if (top === t.name) break;
      }
      continue;
    }
    out.elements++;
    out.attrs += t.attrs;
    if (t.attrs > out.maxTagAttrs) out.maxTagAttrs = t.attrs;
    if (out.maxTagAttrs > limits.tagAttrs) return { ...out, over: "tag_attrs" };
    if (out.attrs > limits.attrs) return { ...out, over: "attrs" };
    if (out.elements > limits.elements) return { ...out, over: "elements" };
    if (RAW.has(t.name)) {
      i = rawEnd(s, i, t.name);
      continue;
    }
    if (VOID.has(t.name) || IMPLIED.has(t.name)) continue;
    // "/>" closes an element only inside SVG or MathML; elsewhere a browser opens it.
    if (t.selfClosing && ((open.get("svg") ?? 0) > 0 || (open.get("math") ?? 0) > 0)) continue;
    stack.push(t.name);
    open.set(t.name, (open.get(t.name) ?? 0) + 1);
    if (stack.length > out.depth) out.depth = stack.length;
    if (out.depth > limits.depth) return { ...out, over: "depth" };
  }
  return out;
}

const BLOCK = new Set(["p", "div", "br", "li", "tr", "table", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "hr", "section", "article", "header", "footer", "address", "dd", "dt"]);
const DROP = new Set(["script", "style", "head", "title", "noscript", "template", "xmp", "iframe", "noembed", "noframes", "textarea", "plaintext"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/**
 * The text of HTML too large or too complex to parse: tags dropped (with the
 * content of scripts, styles and the like), block tags as line breaks, the
 * common entities and numeric ones decoded. One forward pass, no parser.
 */
export function linearHtmlText(html: string): string {
  const s = String(html ?? "");
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      parts.push(s.slice(i));
      break;
    }
    if (lt > i) parts.push(s.slice(i, lt));
    const t = readTag(s, lt);
    if (!t.other && !t.name) {
      parts.push("<");
      i = lt + 1;
      continue;
    }
    i = t.end;
    if (t.other) continue;
    if (!t.closing && DROP.has(t.name)) {
      const e = rawEnd(s, i, t.name);
      const close = s.indexOf(">", e);
      i = e >= s.length ? s.length : close < 0 ? s.length : close + 1;
      continue;
    }
    if (BLOCK.has(t.name)) parts.push("\n");
    else if (t.name === "td" || t.name === "th") parts.push(" ");
  }
  return parts
    .join("")
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6}|#39);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (ENTITIES[k] !== undefined) return ENTITIES[k];
      const cp = k.startsWith("#x") ? parseInt(k.slice(2), 16) : k.startsWith("#") ? parseInt(k.slice(1), 10) : NaN;
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    })
    .replace(/[ \t\r\f ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
