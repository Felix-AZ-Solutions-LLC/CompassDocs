// Helpdesk 1.20.33: what an automation reads in a ticket's subject and body,
// the pure half. No database and no server-only imports: the server's rules
// (lib/helpdesk/automations) and the rule editor's "Try it" box
// (components/helpdesk/desk/settings/AutomationsSettings) run these same
// functions, so what the box says is what a rule does.
//
//   phrases    "Subject contains" / "Body contains" (any phrase in the list
//              appears) and "doesn't contain" (none does): exact text, any
//              case, not whole words (the keyword condition stays whole
//              words).
//   patterns   regular expressions, run on untrusted email. The engine is
//              re2js (a pure-JavaScript port of RE2, MIT): matching time is
//              linear in the text, so a pattern such as (a+)+$ cannot
//              backtrack catastrophically. Lookarounds and backreferences
//              are not part of RE2 and are refused at save time. A pattern
//              is at most AUTOMATION_BODY_LIMITS.pattern characters and is
//              matched against at most the first AUTOMATION_BODY_LIMITS.
//              bodyBytes bytes of the body. Any case unless "match case".
//   values     "Copy a value into a field": the text after a label (the
//              rest of that line, trimmed) or a pattern's one capture group,
//              then fitted to the field's kind (fitFieldValue): a choice
//              must be one of its options (any case), numbers and dates
//              must parse, text is capped to the field's limit. A value that
//              doesn't fit is never written half-valid.
//   addresses  "Change the requester from the message": an address after a
//              label on the same line ("From:", "Email:"), or the first one
//              in the body, found with the desk's linear address scanner
//              (mailboxes-shared scanAddresses); and whether the message's
//              sender is on the rule's list (whole addresses and "@domain").

import { RE2JS } from "re2js";
import { re2Refusal } from "../re2-pattern";
import { bracketedAddress, scanAddresses } from "./mailboxes-shared";
import { cleanTrustedSenders } from "./inbound-senders-shared";
import type { HdFormFieldType, HdFormOption } from "./types";
import { AUTOMATION_BODY_LIMITS, DEFAULT_REQUESTER_LABELS } from "./automation-body-limits";

export { AUTOMATION_BODY_LIMITS, DEFAULT_REQUESTER_LABELS };

/** The body as a rule reads it: at most bodyBytes of UTF-8, cut on a character boundary. */
export function capBody(text: string, max = AUTOMATION_BODY_LIMITS.bodyBytes): string {
  // Fast path: even at 3 bytes a UTF-16 unit (4 for a pair, 2 units) it fits.
  if (text.length * 3 <= max) return text;
  const head = text.slice(0, max);
  const bytes = new TextEncoder().encode(head);
  if (bytes.length <= max) return head;
  return new TextDecoder().decode(bytes.subarray(0, max)).replace(/�+$/, "");
}

// --- Phrases ----------------------------------------------------------------------------------

/** Any of the phrases appears in the text: exact characters, any case (never whole words). */
export function phraseHit(phrases: readonly string[], text: string): boolean {
  const t = text.toLowerCase();
  return phrases.some((p) => {
    const q = p.trim().toLowerCase();
    return q !== "" && t.includes(q);
  });
}

// --- Patterns ---------------------------------------------------------------------------------

export type CompiledPattern = { ok: true; re: RE2JS; groups: number } | { ok: false; error: string };

const cache = new Map<string, CompiledPattern>();

/**
 * A pattern compiled for the linear-time engine, any case unless `matchCase`. Refusals are one plain sentence a
 * person can act on. Compiled patterns are kept (a rule's pattern is compiled once per process, not per ticket).
 */
export function compilePattern(pattern: string, matchCase = false): CompiledPattern {
  const key = `${matchCase ? "1" : "0"}${pattern}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let out: CompiledPattern;
  if (!pattern.trim()) out = { ok: false, error: "Write a pattern, or remove the condition." };
  else if (pattern.length > AUTOMATION_BODY_LIMITS.pattern) out = { ok: false, error: `Keep a pattern under ${AUTOMATION_BODY_LIMITS.pattern} characters.` };
  else {
    try {
      const re = RE2JS.compile(pattern, matchCase ? 0 : RE2JS.CASE_INSENSITIVE);
      out = { ok: true, re, groups: re.groupCount() };
    } catch (e) {
      out = { ok: false, error: `${re2Refusal(pattern, e)}. Try it in the box below the pattern.` };
    }
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, out);
  return out;
}

const short = (s: string) => (s.length > 60 ? `${s.slice(0, 59)}…` : s);

export interface PatternResult {
  matched: boolean;
  /** What the whole pattern matched ('' when it didn't). */
  match: string;
  /** Each capture group's text, in order (null for a group that took no part). */
  groups: (string | null)[];
}

/** Run a compiled pattern on text (capped as a body is). */
export function runPattern(re: RE2JS, text: string): PatternResult {
  const m = re.matcher(capBody(text));
  if (!m.find()) return { matched: false, match: "", groups: [] };
  const groups: (string | null)[] = [];
  for (let i = 1; i <= m.groupCount(); i++) groups.push(m.group(i));
  return { matched: true, match: m.group(0) ?? "", groups };
}

/** Does the pattern match the text? An invalid pattern never matches (it can't be saved; this is for rows from before). */
export function patternHit(p: { pattern: string; match_case?: boolean }, text: string): boolean {
  const c = compilePattern(p.pattern, p.match_case === true);
  return c.ok && runPattern(c.re, text).matched;
}

/** "Try it": the same compile and match a rule makes, as the box shows it. */
export function tryPattern(pattern: string, matchCase: boolean, sample: string): { error: string } | PatternResult {
  const c = compilePattern(pattern, matchCase);
  if (!c.ok) return { error: c.error };
  return runPattern(c.re, sample.slice(0, AUTOMATION_BODY_LIMITS.sample));
}

// --- Values for "Copy a value into a field" ----------------------------------------------------

/**
 * The rest of the first line that starts with `label` (after whitespace and ">"; any case unless matchCase) and has
 * something after it, trimmed; null when none. 1.20.33: a label starts its line, so "Old asset tag:" is not "Asset tag:".
 */
export function textAfterLabel(text: string, label: string, matchCase = false): string | null {
  const l = label.trim();
  if (!l) return null;
  for (const line of capBody(text).split(/\r\n?|\n/)) {
    const body = line.replace(LINE_START, "");
    if (!(matchCase ? body.startsWith(l) : body.toLowerCase().startsWith(l.toLowerCase()))) continue;
    const rest = body.slice(l.length).trim();
    if (rest) return rest;
  }
  return null;
}

/** A pattern's first capture group, trimmed ('' or no match: null). */
export function capturedValue(pattern: string, matchCase: boolean, text: string): string | null {
  const c = compilePattern(pattern, matchCase);
  if (!c.ok) return null;
  const r = runPattern(c.re, text);
  const v = r.matched ? (r.groups[0] ?? "").trim() : "";
  return v || null;
}

/** The value one copy action extracts from the subject or the body (null: nothing found). */
export function extractCopyValue(c: { from: "subject" | "body"; label?: string; pattern?: string; match_case?: boolean }, subject: string, body: string): string | null {
  const text = c.from === "subject" ? subject : body;
  if (c.label) return textAfterLabel(text, c.label, c.match_case === true);
  if (c.pattern) return capturedValue(c.pattern, c.match_case === true, text);
  return null;
}

/** The field's text limit (the request form's: lib/helpdesk/request-types FORM_LIMITS). */
export const FIELD_TEXT_LIMIT: Partial<Record<HdFormFieldType, number>> = { text: 500, textarea: 10_000 };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");

function realDate(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const x = new Date(Date.UTC(y, m - 1, d));
  return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/** A date written plainly: 2026-11-20, 2026/11/20, 20 Nov 2026, November 20, 2026. Day-first and month-first numbers are ambiguous: refused. */
export function parsePlainDate(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m) return realDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(t);
  if (m) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    return mo < 0 ? null : realDate(Number(m[3]), mo + 1, Number(m[1]));
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(t);
  if (m) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    return mo < 0 ? null : realDate(Number(m[3]), mo + 1, Number(m[2]));
  }
  return null;
}

/** A number written plainly: 42, -3.5, 1,234.50 (thousands with commas). */
export function parsePlainNumber(s: string): number | null {
  const t = s.trim();
  if (!/^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) && Math.abs(n) <= 1e12 ? n : null;
}

export type FitResult = { ok: true; value: string | number | boolean } | { ok: false; why: string };

/**
 * Fit an extracted value to a custom field's kind, or say why it doesn't fit. "A person" fields take an address,
 * resolved by the server (the value comes back as the address, lower-cased, for it to look up).
 */
export function fitFieldValue(f: { label: string; type: HdFormFieldType; options?: HdFormOption[] }, raw: string): FitResult {
  const v = raw.replace(/\s+/g, " ").trim();
  if (!v) return { ok: false, why: "it was empty" };
  switch (f.type) {
    case "text":
    case "textarea": {
      const max = FIELD_TEXT_LIMIT[f.type] ?? 500;
      // Multi-line text keeps its lines; a short text field one line.
      const keep = f.type === "textarea" ? raw.trim() : v;
      return { ok: true, value: keep.length > max ? keep.slice(0, max).trim() : keep };
    }
    case "select":
    case "choice": {
      const lower = v.toLowerCase();
      const o = (f.options ?? []).find((x) => x.value.toLowerCase() === lower || x.label.toLowerCase() === lower);
      return o ? { ok: true, value: o.value } : { ok: false, why: `"${short(v)}" is not one of its options` };
    }
    case "number": {
      const n = parsePlainNumber(v);
      return n === null ? { ok: false, why: `"${short(v)}" is not a number` } : { ok: true, value: n };
    }
    case "date": {
      const d = parsePlainDate(v);
      return d ? { ok: true, value: d } : { ok: false, why: `"${short(v)}" is not a date it can read (write it as 2026-11-20 or 20 Nov 2026)` };
    }
    case "datetime": {
      const m = /^(.+?)[T\s]+(\d{1,2}):(\d{2})$/.exec(v);
      const d = m ? parsePlainDate(m[1]) : null;
      const h = m ? Number(m[2]) : NaN;
      const min = m ? Number(m[3]) : NaN;
      return d && h >= 0 && h <= 23 && min >= 0 && min <= 59 ? { ok: true, value: `${d}T${pad(h)}:${pad(min)}` } : { ok: false, why: `"${short(v)}" is not a date and time it can read` };
    }
    case "checkbox": {
      if (/^(yes|y|true|1|on|x|ticked|checked)$/i.test(v)) return { ok: true, value: true };
      if (/^(no|n|false|0|off|unticked|unchecked)$/i.test(v)) return { ok: true, value: false };
      return { ok: false, why: `"${short(v)}" is not yes or no` };
    }
    case "user": {
      const a = scanAddresses(v, 1)[0];
      return a ? { ok: true, value: a.toLowerCase() } : { ok: false, why: `"${short(v)}" has no email address to find the person by` };
    }
  }
  return { ok: false, why: "the field's kind can't be filled in by a rule" };
}

/** A value as a tag (the macro rule: lower-case, spaces to hyphens, letters, digits and _ . : -). */
export function valueAsTag(raw: string, maxLength = 40): string | null {
  const tag = raw.trim().toLowerCase().replace(/\s+/g, "-");
  if (!tag || tag.length > maxLength || !/^[\p{L}\p{N}_.:-]+$/u.test(tag)) return null;
  return tag;
}

// --- Addresses for "Change the requester from the message" -------------------------------------

export interface FoundAddress {
  email: string;
  /** The display name written before a bracketed address ("Jane Doe <jane@…>"), '' when none or not a plain name. */
  name: string;
}

/**
 * The address a line holds, as a mail header would be read: the bracketed one when there is one (the display name
 * never picks the address: `"ceo@company.com" <attacker@evil.example>` is attacker@evil.example), else the first
 * address. A display name is kept only as a plain name: one holding an address or an encoded word ("=?…?=") is
 * dropped.
 */
export function lineAddress(text: string): FoundAddress | null {
  const b = bracketedAddress(text);
  if (b) {
    let name = text.slice(0, b.start).trim();
    // An unquoted name never holds ":", so whatever precedes the last one is a label ("Contact: Jane Doe <…>").
    if (!name.startsWith('"')) name = (name.split(":").pop() ?? "").trim();
    name = name
      .replace(/^"(.*)"$/, "$1")
      .replace(/\\"/g, '"')
      .trim();
    if (!name || name.includes("@") || name.includes("=?") || name.length > 120) name = "";
    return { email: b.address.toLowerCase(), name };
  }
  const a = scanAddresses(text, 1)[0];
  return a ? { email: a.toLowerCase(), name: "" } : null;
}

/** Where a line's text starts: after leading whitespace and quote markers (">", "> >"). */
const LINE_START = /^[\s>]*/;

/** The label this line starts with (after whitespace and ">"), any case; null when none. "Reply-From:" never starts with "From:". */
export function lineLabel(line: string, labels: readonly string[]): { label: string; rest: string } | null {
  const body = line.replace(LINE_START, "");
  const lower = body.toLowerCase();
  for (const label of labels) {
    const l = label.trim();
    if (l && lower.startsWith(l.toLowerCase())) return { label: l, rest: body.slice(l.length) };
  }
  return null;
}

/**
 * The one address a "from the message" action may pick, and where it came from. "label": the topmost line that
 * starts with one of the labels decides; its address (the bracketed one when there is one) is the candidate, and no
 * later line is read (a later line may be quoted history). "first": the first line with an address, its address read
 * the same way. Null address: the label line holds none, or nothing was found.
 */
export function requesterCandidate(body: string, find: "label" | "first", labels: readonly string[] = DEFAULT_REQUESTER_LABELS): { address: FoundAddress | null; label: string | null } {
  const lines = capBody(body).split(/\r\n?|\n/);
  const use = labels.length ? labels : DEFAULT_REQUESTER_LABELS;
  for (const line of lines) {
    if (find === "first") {
      const a = lineAddress(line);
      if (a) return { address: a, label: null };
      continue;
    }
    const hit = lineLabel(line, use);
    if (hit) return { address: lineAddress(hit.rest), label: hit.label };
  }
  return { address: null, label: null };
}

/** The sender a message came from is on the list: the whole address, or "@" and its domain exactly. */
export function senderInScope(address: string, list: readonly string[]): boolean {
  const a = (address ?? "").trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 1) return false;
  return list.some((x) => x === a || (x.startsWith("@") && x === a.slice(at)));
}

/** An address is at one of these domains ("@example.com", exactly). */
export function addressAtDomain(address: string, domains: readonly string[]): boolean {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  return at > 0 && domains.includes(a.slice(at));
}

/**
 * Free-mail providers: anyone can have an address there, so a whole-domain sender entry would let anyone in. Exact
 * addresses at them are fine. Each entry is a domain, or a name ending in ".*" for every top-level domain (gmx.de,
 * gmx.net; yandex.ru, yandex.com).
 */
export const FREE_MAIL_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.*",
  "mail.com",
  "yandex.*",
  "zoho.com",
];

/** Is this domain a free-mail provider's (FREE_MAIL_DOMAINS)? */
export function freeMailDomain(domain: string): boolean {
  const d = domain.replace(/^@/, "").trim().toLowerCase();
  return FREE_MAIL_DOMAINS.some((f) => (f.endsWith(".*") ? d.startsWith(f.slice(0, -1)) && !d.slice(f.length - 1).includes(".") : d === f));
}

/** A list of senders (addresses and "@domain"), cleaned as Desk settings → Email's trusted senders are. */
export function cleanSenderList(raw: unknown): { list: string[]; problem: string } {
  const r = cleanTrustedSenders(raw);
  if (r.problem) return r;
  const free = r.list.find((x) => x.startsWith("@") && freeMailDomain(x));
  if (free) {
    return {
      list: [],
      problem: `${free} is a free email provider anyone can sign up to, so a whole-domain entry would let anyone in. List the forwarder's exact address instead.`,
    };
  }
  if (r.list.length > AUTOMATION_BODY_LIMITS.senders) return { list: [], problem: `List up to ${AUTOMATION_BODY_LIMITS.senders} senders.` };
  return r;
}

/** A list of domains, each "@example.com" (a bare "example.com" is taken as "@example.com"). */
export function cleanDomainList(raw: unknown): { list: string[]; problem: string } {
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\n,;\s]+/) : [];
  const fixed = items.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => (x.trim().startsWith("@") ? x.trim() : `@${x.trim()}`));
  const r = cleanTrustedSenders(fixed);
  if (r.problem) return { list: [], problem: r.problem.replace("an email address or a domain written as", "a domain written as") };
  if (r.list.some((x) => !x.startsWith("@"))) return { list: [], problem: "List domains only, each written as @example.com." };
  if (r.list.length > AUTOMATION_BODY_LIMITS.senders) return { list: [], problem: `List up to ${AUTOMATION_BODY_LIMITS.senders} domains.` };
  return r;
}
