// Helpdesk automations (1.19.0): "When <event> If <conditions> Then
// <actions>" rules an admin keeps in order under Desk → Settings →
// Automations.
//
//   events      ticket_created, ticket_updated, requester_message,
//               sla_nearing, sla_breached
//   conditions  every list given must match (any value within a list):
//               teams, categories, priorities, request types, sources, and
//               keywords (any word in the subject or the body; whole words,
//               any case). No conditions = every ticket.
//   actions     set team / assignee / priority / status / category (1.20.6:
//               and sub-category, both from the admin's list), add
//               tags, add an internal note, send a macro's reply, notify
//               (the assignee, the team or one person)
//
// Rules run in position order and each sees what the earlier ones did.
// Loop protection, two layers: every write a rule makes carries
// `fromAutomation`, which lib/helpdesk/events honours by running no rules
// for it, so a rule's own change cannot retrigger anything; and a chain
// guard (AsyncLocalStorage) caps nesting at MAX_DEPTH and runs each rule at
// most once per chain, for any path that reaches runAutomations again
// without that flag. A rule whose actions would change nothing (the fields
// already hold its values, and it has no note, macro or notice) is skipped
// rather than counted as a run, so "ticket_updated" rules settle.
//
// 1.20.16: drafts from Claude (saveAutomationDraft; the model of 1.20.14's
// checklist drafts, lib/helpdesk/claude-drafts-shared). A new rule Claude
// drafts is saved switched off and unpublished: it never runs (the run
// query asks published = 1 as well as active = 1) and can't be switched on
// until a person publishes it. Changes Claude proposes to a published rule
// wait in `draft` while the live rule keeps running unchanged. Publishing is
// explicit and names the reviewed draft (updateAutomation publish /
// publishDraft with draftAt). Every save locks the row. Validation is the
// settings API's own (validateAutomationInput).
//
// 1.20.33, the subject and the body (lib/helpdesk/automation-body-shared, the
// pure half the rule editor's "Try it" box shares):
//   conditions  "Subject contains" / "doesn't contain", "Body contains" /
//               "doesn't contain" (phrases: exact text, any case, not whole
//               words), and "Subject / Body matches pattern" (a regular
//               expression on a linear-time engine, re2js: up to 200
//               characters, the first 100 KB of the body, any case unless
//               "match case"; refused at save time when it isn't valid).
//   actions     "Change the requester": to a named person (requester_set),
//               or from the message (requester_from_message: an address
//               after a label such as "From:", or the first in the body),
//               only for a message whose actual sender is on the rule's list
//               (required: anyone could write "From: ceo@…") and never for
//               an email whose sender failed the sender check; never one of
//               the desk's own addresses, the sender's own, or a desk agent
//               unless allowed. Applied through lib/helpdesk/requester-change
//               changeRequester, the same primitive an agent's "Change
//               requester" uses. "Copy a value into a field" (copy_values, up
//               to 10): the text after a label, or a pattern's one capture
//               group, fitted to a custom field of the ticket's team (only
//               while it is empty, by default) or added as a tag, written
//               through updateTicket like any field change.
//   body        the message a rule already reads (the triggering requester
//               message, else the opening one) as agents see it: the stored
//               Markdown with its escapes undone (inbound-parse
//               markdownToPlain). An emailed message is stored as text (its
//               text part, or its HTML part walked into text) with a reply's
//               quoted history already cut (inbound-parse stripQuotedReply);
//               nothing more is cut here, so a forward's "From:" block stays
//               readable. Keywords still read the body as before.
// A requester or field a rule would set that the ticket already has changes
// nothing, so ticket_updated rules settle (effectivePatch). What a rule
// couldn't do (no usable address, a value that doesn't fit its field) is one
// agents-only activity line on the ticket, written once.
//
// 1.20.23, desk departments (lib/helpdesk/desk-departments): each rule is in
// one desk department (desk_department_id) or in All departments (NULL). The
// rules that run on a ticket are its department's and All departments': the
// department of the ticket's team at the moment each rule is checked (a rule
// that moves the ticket to another department's team hands the rest of the
// run to that department's rules), or the default desk department for a
// ticket with no team, so an unrouted ticket meets the rules it always did.
// A team moved to another department takes its tickets to that department's
// rules from then on; nothing already done is undone.
// Server-only.

import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { hq, hqOne, withTx } from "./db-core";
import { CATEGORY_LIST_SHARED_LOCK_SQL, categoriesReady } from "./categories";
import {
  CLEAR_DRAFT_SQL,
  DRAFT_COLS_SQL,
  NO_CHANGES_WAITING,
  STALE_DISCARD_MESSAGE,
  STALE_DRAFT_MESSAGE,
  sameDraftInstant,
  type HdDraftVia,
} from "./claude-drafts-shared";
import { logEvent } from "../log";
import { cleanTags, validateMacroActions } from "./macros";
import { HD_PRIORITIES, HD_SOURCES, HD_STATUSES } from "./types";
import type {
  HdAutomation,
  HdAutomationActions,
  HdAutomationCopy,
  HdAutomationDraft,
  HdAutomationConditions,
  HdAutomationEvent,
  HdAutomationPattern,
  HdAutomationRequesterFromMessage,
  HdAutomationRequesterSet,
  HdPriority,
  HdSource,
  HdStatus,
  HdTicketPatch,
  HdTicketRow,
} from "./types";
import {
  AUTOMATION_BODY_LIMITS,
  DEFAULT_REQUESTER_LABELS,
  addressAtDomain,
  requesterCandidate,
  cleanDomainList,
  cleanSenderList,
  compilePattern,
  extractCopyValue,
  fitFieldValue,
  patternHit,
  phraseHit,
  senderInScope,
} from "./automation-body-shared";
import type { HdCustomValue } from "./custom-fields-shared";
import { validRequesterEmail, type ResolvedRequester } from "./requester-change";
import { mdInline } from "./md-inline";
import { HD_CHANGE_EVENT } from "./conversation-shared";

export const HD_AUTOMATION_EVENTS: readonly HdAutomationEvent[] = [
  "ticket_created",
  "ticket_updated",
  "requester_message",
  "sla_nearing",
  "sla_breached",
];

export const HD_AUTOMATION_EVENT_LABEL: Record<HdAutomationEvent, string> = {
  ticket_created: "A ticket is created",
  ticket_updated: "A ticket is updated",
  requester_message: "The requester sends a message",
  sla_nearing: "An SLA target is close",
  sla_breached: "An SLA target is missed",
};

/** 1.20.33: with the subject and body limits (phrase, pattern, bodyBytes, label, labels, senders, copies; lib/helpdesk/automation-body-shared). */
export const AUTOMATION_LIMITS = { name: 120, rules: 200, list: 50, keyword: 60, note: 5000, category: 80, ...AUTOMATION_BODY_LIMITS } as const;

/** Nested rule runs allowed in one chain. */
export const MAX_DEPTH = 3;

// --- Matching (pure) -------------------------------------------------------------

export interface MatchTarget {
  team_id: number | null;
  category: string;
  /** 1.20.6: the ticket's sub-category ('' = none). */
  subcategory?: string;
  priority: HdPriority;
  request_type_id: number | null;
  source: HdSource;
  subject: string;
  /** The body the keywords are looked for in (the triggering message, or the opening one). */
  body: string;
  /** 1.20.33: that body as agents read it (Markdown escapes undone), for phrases, patterns and the body actions; `body` when absent. */
  text?: string;
  /**
   * 1.20.33: who sent that message: their address (an account's current one), and, for an email (`byEmail`), whether
   * its sender passed the sender check (null: not recorded, mail from before 1.20.33; always null for other messages).
   * An imported message (`imported`) never counts as checked.
   */
  sender?: { email: string; verified: boolean | null; byEmail?: boolean; imported?: boolean };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive: "vpn" matches "VPN keeps dropping", not "vpnclient". */
export function keywordHit(keywords: string[], text: string): boolean {
  return keywords.some((k) => {
    const w = k.trim();
    if (!w) return false;
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}($|[^\\p{L}\\p{N}])`, "iu").test(text);
  });
}

export function automationMatches(c: HdAutomationConditions, t: MatchTarget): boolean {
  const has = <T>(list: T[] | undefined): list is T[] => Array.isArray(list) && list.length > 0;
  if (has(c.team_ids) && (t.team_id === null || !c.team_ids.includes(t.team_id))) return false;
  // 1.20.6: "Category is any of" lists whole categories (`categories`) and single sub-categories (`subcategories`).
  if (has(c.categories) || has(c.subcategories)) {
    const cat = t.category.toLowerCase();
    const sub = (t.subcategory ?? "").toLowerCase();
    const whole = (c.categories ?? []).some((x) => x.toLowerCase() === cat);
    const one = (c.subcategories ?? []).some((x) => x.category.toLowerCase() === cat && x.subcategory.toLowerCase() === sub);
    if (!whole && !one) return false;
  }
  if (has(c.priorities) && !c.priorities.includes(t.priority)) return false;
  if (has(c.request_type_ids) && (t.request_type_id === null || !c.request_type_ids.includes(t.request_type_id))) return false;
  if (has(c.sources) && !c.sources.includes(t.source)) return false;
  if (has(c.keywords) && !keywordHit(c.keywords, `${t.subject}\n${t.body}`)) return false;
  // 1.20.33: phrases (exact text, any case) and patterns (linear-time engine), on the body as agents read it.
  const text = t.text ?? t.body;
  if (has(c.subject_contains) && !phraseHit(c.subject_contains, t.subject)) return false;
  if (has(c.subject_not_contains) && phraseHit(c.subject_not_contains, t.subject)) return false;
  if (has(c.body_contains) && !phraseHit(c.body_contains, text)) return false;
  if (has(c.body_not_contains) && phraseHit(c.body_not_contains, text)) return false;
  if (c.subject_pattern?.pattern && !patternHit(c.subject_pattern, t.subject)) return false;
  if (c.body_pattern?.pattern && !patternHit(c.body_pattern, text)) return false;
  return true;
}

/** 1.20.33: what a rule's body actions found on a ticket, for effectivePatch (lib/helpdesk/automations applyRule). */
export interface RuleFindings {
  /** The requester the rule would make it (resolved), when it would change one. */
  requester?: ResolvedRequester | null;
  /** Values copied into custom fields, by key (already fitted to the field). */
  custom?: Record<string, HdCustomValue>;
  /** Those fields' values on the ticket now (absent: empty). */
  customNow?: Record<string, HdCustomValue | undefined>;
  /** Tags copied from the subject or body. */
  tags?: string[];
}

/** 1.20.33: the field changes plus the requester a rule would set. */
export type AutomationPatch = HdTicketPatch & { requester?: ResolvedRequester };

/** The field changes a rule would make to this ticket, without the ones it already has. */
export function effectivePatch(
  a: HdAutomationActions,
  t: Pick<HdTicketRow, "team_id" | "assignee_id" | "priority" | "status" | "category" | "tags"> & {
    subcategory?: string;
    requester_id?: number | null;
    requester_email?: string;
  },
  found: RuleFindings = {}
): AutomationPatch {
  const p: AutomationPatch = {};
  if (a.team_id !== undefined && a.team_id !== t.team_id) p.team_id = a.team_id;
  if (a.assignee_id !== undefined && a.assignee_id !== t.assignee_id) p.assignee_id = a.assignee_id;
  if (a.priority !== undefined && a.priority !== t.priority) p.priority = a.priority;
  if (a.status !== undefined && a.status !== t.status) p.status = a.status;
  // 1.20.6: a rule that names a sub-category sets both; one that names only the category leaves a sub-category of it alone.
  if (a.category !== undefined && a.subcategory) {
    if (a.category !== t.category || a.subcategory !== (t.subcategory ?? "")) {
      p.category = a.category;
      p.subcategory = a.subcategory;
    }
  } else if (a.category !== undefined && a.category !== t.category) p.category = a.category;
  const add = [...(a.tags_add ?? []), ...(found.tags ?? [])];
  if (add.length) {
    const next = [...t.tags];
    for (const tag of add) if (!next.includes(tag)) next.push(tag);
    if (next.length !== t.tags.length) p.tags = next;
  }
  // 1.20.33: a value a field already holds, or a requester the ticket already has, changes nothing (the rule settles).
  if (found.custom) {
    const cf: Record<string, HdCustomValue> = {};
    for (const [k, v] of Object.entries(found.custom)) {
      if (JSON.stringify(found.customNow?.[k] ?? null) !== JSON.stringify(v)) cf[k] = v;
    }
    if (Object.keys(cf).length) p.custom_fields = cf;
  }
  const r = found.requester;
  if (r) {
    const same = r.id !== null ? t.requester_id === r.id : (t.requester_id ?? null) === null && (t.requester_email ?? "").toLowerCase() === r.email.toLowerCase();
    if (!same) p.requester = r;
  }
  return p;
}

// --- Validation ------------------------------------------------------------------

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function idList(raw: unknown, what: string): Checked<number[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.length > AUTOMATION_LIMITS.list) return { ok: false, error: `${what} must be a list.` };
  const out: number[] = [];
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: `${what} must be a list of ids.` };
    if (!out.includes(n)) out.push(n);
  }
  return { ok: true, value: out.length ? out : undefined };
}

function enumList<T extends string>(raw: unknown, allowed: readonly T[], what: string): Checked<T[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.length > AUTOMATION_LIMITS.list) return { ok: false, error: `${what} must be a list.` };
  const out: T[] = [];
  for (const v of raw) {
    if (!allowed.includes(v as T)) return { ok: false, error: `Unknown ${what.toLowerCase()}: ${String(v).slice(0, 40)}.` };
    if (!out.includes(v as T)) out.push(v as T);
  }
  return { ok: true, value: out.length ? out : undefined };
}

function strList(raw: unknown, max: number, what: string, phrases = false): Checked<string[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.length > AUTOMATION_LIMITS.list) return { ok: false, error: phrases ? `${what}: list up to ${AUTOMATION_LIMITS.list} phrases.` : `${what} must be a list.` };
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") return { ok: false, error: phrases ? `${what}: each phrase is text.` : `${what} must be words.` };
    const s = v.trim();
    if (!s) continue;
    if (s.length > max) return { ok: false, error: phrases ? `${what}: keep each phrase under ${max} characters.` : `Keep each of ${what.toLowerCase()} under ${max} characters.` };
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return { ok: true, value: out.length ? out : undefined };
}

/** 1.20.33: a pattern condition: { pattern, match_case? } (or the pattern alone), compiled for the linear-time engine. */
function patternField(raw: unknown, what: string): Checked<HdAutomationPattern | undefined> {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
  const o = typeof raw === "string" ? { pattern: raw } : raw;
  if (typeof o !== "object" || Array.isArray(o)) return { ok: false, error: `${what}: send { pattern, match_case }.` };
  const { pattern, match_case } = o as { pattern?: unknown; match_case?: unknown };
  if (pattern === undefined || pattern === null || pattern === "") return { ok: true, value: undefined };
  if (typeof pattern !== "string") return { ok: false, error: `${what}: the pattern is text.` };
  if (match_case !== undefined && typeof match_case !== "boolean") return { ok: false, error: `${what}: match_case is true or false.` };
  if (!pattern.trim()) return { ok: true, value: undefined };
  const c = compilePattern(pattern, match_case === true);
  if (!c.ok) return { ok: false, error: `${what}: ${c.error}` };
  return { ok: true, value: { pattern, ...(match_case === true ? { match_case: true } : {}) } };
}

const isBool = (v: unknown) => v === undefined || v === null || typeof v === "boolean";

/** 1.20.33: "Change the requester" to a named person: an account (user_id) or an address. */
function requesterSetField(raw: unknown): Checked<HdAutomationRequesterSet | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Change the requester: name a person or an email address." };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!["user_id", "email", "name", "keep_cc"].includes(k)) return { ok: false, error: `Change the requester: unknown setting ${k.slice(0, 40)}.` };
  if (!isBool(r.keep_cc)) return { ok: false, error: "Change the requester: keep_cc is true or false." };
  const hasUser = r.user_id !== undefined && r.user_id !== null && r.user_id !== "" && r.user_id !== 0;
  const email = typeof r.email === "string" ? r.email.trim().toLowerCase() : "";
  if (r.email !== undefined && r.email !== null && typeof r.email !== "string") return { ok: false, error: "Change the requester: the address is text." };
  if (hasUser && email) return { ok: false, error: "Change the requester: name a person or an address, not both." };
  const keep = r.keep_cc === true ? { keep_cc: true } : {};
  if (hasUser) {
    const n = Number(r.user_id);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "Change the requester: unknown person." };
    return { ok: true, value: { user_id: n, ...keep } };
  }
  if (!email) return { ok: false, error: "Change the requester: pick the person to make the requester." };
  if (!validRequesterEmail(email)) return { ok: false, error: `Change the requester: "${email.slice(0, 80)}" isn't a single email address.` };
  if (r.name !== undefined && r.name !== null && typeof r.name !== "string") return { ok: false, error: "Change the requester: the name is text." };
  const name = typeof r.name === "string" ? r.name.replace(/[\r\n<>"]/g, " ").trim().slice(0, 200) : "";
  return { ok: true, value: { email, ...(name ? { name } : {}), ...keep } };
}

/** 1.20.33: the scope sentence a "from the message" action without senders is refused with. */
export const REQUESTER_SCOPE_REQUIRED =
  'Change the requester from the message: list the senders it applies to under "Only for messages from" (the forwarding mailbox, alert system or web form, or its @domain). Without it, anyone could write "From:" with someone else\'s address and take over the ticket and its replies.';

/** 1.20.33: "Change the requester from the message" (sender-scoped). */
function requesterFromMessageField(raw: unknown): Checked<HdAutomationRequesterFromMessage | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Change the requester from the message: send { find, labels, senders, domains, keep_cc, allow_agents }." };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (!["find", "labels", "senders", "domains", "keep_cc", "allow_agents"].includes(k)) return { ok: false, error: `Change the requester from the message: unknown setting ${k.slice(0, 40)}.` };
  }
  const find = r.find === undefined || r.find === null || r.find === "" ? "label" : r.find;
  if (find !== "label" && find !== "first") return { ok: false, error: 'Change the requester from the message: find is "label" (after a label) or "first" (the first address in the body).' };
  if (!isBool(r.keep_cc) || !isBool(r.allow_agents)) return { ok: false, error: "Change the requester from the message: keep_cc and allow_agents are true or false." };
  const senders = cleanSenderList(r.senders ?? []);
  if (senders.problem) return { ok: false, error: `Change the requester from the message, only for messages from: ${senders.problem}` };
  if (!senders.list.length) return { ok: false, error: REQUESTER_SCOPE_REQUIRED };
  const domains = cleanDomainList(r.domains ?? []);
  if (domains.problem) return { ok: false, error: `Change the requester from the message, only addresses at: ${domains.problem}` };
  let labels: string[] | undefined;
  if (find === "label") {
    const l = strList(r.labels, AUTOMATION_LIMITS.label, "Change the requester from the message: labels");
    if (!l.ok) return { ok: false, error: l.error.replace("Keep each of change the requester from the message: labels", "Change the requester from the message: keep each label") };
    if ((l.value?.length ?? 0) > AUTOMATION_LIMITS.labels) return { ok: false, error: `Change the requester from the message: list up to ${AUTOMATION_LIMITS.labels} labels.` };
    labels = l.value ?? [...DEFAULT_REQUESTER_LABELS];
  }
  return {
    ok: true,
    value: {
      find,
      ...(labels ? { labels } : {}),
      senders: senders.list,
      ...(domains.list.length ? { domains: domains.list } : {}),
      ...(r.keep_cc === true ? { keep_cc: true } : {}),
      ...(r.allow_agents === true ? { allow_agents: true } : {}),
    },
  };
}

/** 1.20.33: "Copy a value into a field", each: where from, how found, where to. */
function copyValuesField(raw: unknown): Checked<HdAutomationCopy[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return { ok: false, error: "Copy a value into a field: send a list." };
  if (raw.length > AUTOMATION_LIMITS.copies) return { ok: false, error: `A rule can copy up to ${AUTOMATION_LIMITS.copies} values.` };
  const out: HdAutomationCopy[] = [];
  for (let i = 0; i < raw.length; i++) {
    const at = raw.length > 1 ? `Copy a value into a field (${i + 1})` : "Copy a value into a field";
    const c = raw[i] as Record<string, unknown> | null;
    if (!c || typeof c !== "object" || Array.isArray(c)) return { ok: false, error: `${at}: send { from, label or pattern, field_key or tag }.` };
    for (const k of Object.keys(c)) if (!["from", "label", "pattern", "match_case", "field_key", "tag", "only_if_empty"].includes(k)) return { ok: false, error: `${at}: unknown setting ${k.slice(0, 40)}.` };
    const from = c.from === undefined || c.from === null || c.from === "" ? "body" : c.from;
    if (from !== "subject" && from !== "body") return { ok: false, error: `${at}: copy from "subject" or "body".` };
    if (!isBool(c.match_case) || !isBool(c.tag) || !isBool(c.only_if_empty)) return { ok: false, error: `${at}: match_case, tag and only_if_empty are true or false.` };
    const label = typeof c.label === "string" ? c.label.trim() : "";
    const pattern = typeof c.pattern === "string" ? c.pattern : "";
    if ((c.label !== undefined && c.label !== null && typeof c.label !== "string") || (c.pattern !== undefined && c.pattern !== null && typeof c.pattern !== "string")) {
      return { ok: false, error: `${at}: the label and the pattern are text.` };
    }
    if (label && pattern.trim()) return { ok: false, error: `${at}: find the value after a label or with a pattern, not both.` };
    if (!label && !pattern.trim()) return { ok: false, error: `${at}: say where the value is: the label before it (like "Asset tag:"), or a pattern.` };
    if (label.length > AUTOMATION_LIMITS.label) return { ok: false, error: `${at}: keep the label under ${AUTOMATION_LIMITS.label} characters.` };
    if (pattern.trim()) {
      const p = compilePattern(pattern, c.match_case === true);
      if (!p.ok) return { ok: false, error: `${at}: ${p.error}` };
      if (p.groups !== 1) {
        return {
          ok: false,
          error: `${at}: the pattern needs exactly one group in brackets around the value to copy, like Asset tag:\\s*(\\S+). Write other groups as (?:…).`,
        };
      }
    }
    const key = typeof c.field_key === "string" ? c.field_key.trim() : "";
    if (c.field_key !== undefined && c.field_key !== null && typeof c.field_key !== "string") return { ok: false, error: `${at}: field_key is a custom field's key.` };
    if (key && c.tag === true) return { ok: false, error: `${at}: copy into a field or add a tag, not both.` };
    if (!key && c.tag !== true) return { ok: false, error: `${at}: pick the custom field to copy into, or add the value as a tag.` };
    if (key && (key.length > 40 || !/^[a-z][a-z0-9_]*$/.test(key))) return { ok: false, error: `${at}: "${key.slice(0, 40)}" isn't a custom field's key.` };
    out.push({
      from,
      ...(label ? { label } : { pattern }),
      ...(c.match_case === true ? { match_case: true } : {}),
      ...(key ? { field_key: key } : { tag: true }),
      ...(key && c.only_if_empty === false ? { only_if_empty: false } : {}),
    });
  }
  return { ok: true, value: out.length ? out : undefined };
}

export function validateConditions(raw: unknown): Checked<HdAutomationConditions> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Conditions must be an object." };
  const c = raw as Record<string, unknown>;
  const known = [
    "team_ids",
    "categories",
    "subcategories",
    "priorities",
    "request_type_ids",
    "keywords",
    "sources",
    // 1.20.33: the subject and the body.
    "subject_contains",
    "subject_not_contains",
    "body_contains",
    "body_not_contains",
    "subject_pattern",
    "body_pattern",
  ];
  for (const k of Object.keys(c)) if (!known.includes(k)) return { ok: false, error: `Unknown condition: ${k}.` };
  const out: HdAutomationConditions = {};
  const steps: [keyof HdAutomationConditions, Checked<unknown>][] = [
    ["team_ids", idList(c.team_ids, "Teams")],
    ["request_type_ids", idList(c.request_type_ids, "Request types")],
    ["priorities", enumList(c.priorities, HD_PRIORITIES, "Priorities")],
    ["sources", enumList(c.sources, HD_SOURCES, "Sources")],
    ["categories", strList(c.categories, AUTOMATION_LIMITS.category, "Categories")],
    ["keywords", strList(c.keywords, AUTOMATION_LIMITS.keyword, "Keywords")],
    ["subject_contains", strList(c.subject_contains, AUTOMATION_LIMITS.phrase, "Subject contains phrases", true)],
    ["subject_not_contains", strList(c.subject_not_contains, AUTOMATION_LIMITS.phrase, "Subject doesn't contain phrases", true)],
    ["body_contains", strList(c.body_contains, AUTOMATION_LIMITS.phrase, "Body contains phrases", true)],
    ["body_not_contains", strList(c.body_not_contains, AUTOMATION_LIMITS.phrase, "Body doesn't contain phrases", true)],
    ["subject_pattern", patternField(c.subject_pattern, "Subject matches pattern")],
    ["body_pattern", patternField(c.body_pattern, "Body matches pattern")],
  ];
  for (const [k, r] of steps) {
    if (!r.ok) return r;
    if (r.value !== undefined) (out as Record<string, unknown>)[k] = r.value;
  }
  // 1.20.6: single sub-categories, each with the category it belongs to.
  if (c.subcategories !== undefined && c.subcategories !== null) {
    if (!Array.isArray(c.subcategories) || c.subcategories.length > AUTOMATION_LIMITS.list) return { ok: false, error: "Sub-categories must be a list." };
    const pairs: { category: string; subcategory: string }[] = [];
    for (const v of c.subcategories) {
      const o = v as { category?: unknown; subcategory?: unknown } | null;
      if (!o || typeof o !== "object" || typeof o.category !== "string" || typeof o.subcategory !== "string") {
        return { ok: false, error: "Each sub-category is { category, subcategory }." };
      }
      const pair = { category: o.category.trim(), subcategory: o.subcategory.trim() };
      if (!pair.category || !pair.subcategory) continue;
      if (pair.category.length > AUTOMATION_LIMITS.category || pair.subcategory.length > AUTOMATION_LIMITS.category) {
        return { ok: false, error: `Keep each of sub-categories under ${AUTOMATION_LIMITS.category} characters.` };
      }
      if (!pairs.some((x) => x.category.toLowerCase() === pair.category.toLowerCase() && x.subcategory.toLowerCase() === pair.subcategory.toLowerCase())) pairs.push(pair);
    }
    if (pairs.length) out.subcategories = pairs;
  }
  return { ok: true, value: out };
}

export function validateActions(raw: unknown): Checked<HdAutomationActions> {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Choose at least one action." };
  const a = raw as Record<string, unknown>;
  const known = ["team_id", "assignee_id", "priority", "status", "category", "subcategory", "tags_add", "internal_note", "macro_id", "notify", "requester_set", "requester_from_message", "copy_values"];
  for (const k of Object.keys(a)) if (!known.includes(k)) return { ok: false, error: `Unknown action: ${k}.` };
  const out: HdAutomationActions = {};
  const id = (v: unknown, what: string): Checked<number | undefined> => {
    if (v === undefined || v === null || v === "") return { ok: true, value: undefined };
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? { ok: true, value: n } : { ok: false, error: `Unknown ${what}.` };
  };
  for (const [k, what] of [["team_id", "team"], ["assignee_id", "assignee"], ["macro_id", "macro"]] as const) {
    const r = id(a[k], what);
    if (!r.ok) return r;
    if (r.value !== undefined) out[k] = r.value;
  }
  if (a.priority !== undefined && a.priority !== null && a.priority !== "") {
    if (!(HD_PRIORITIES as readonly string[]).includes(String(a.priority))) return { ok: false, error: "Unknown priority." };
    out.priority = a.priority as HdPriority;
  }
  if (a.status !== undefined && a.status !== null && a.status !== "") {
    if (!(HD_STATUSES as readonly string[]).includes(String(a.status))) return { ok: false, error: "Unknown status." };
    out.status = a.status as HdStatus;
  }
  if (a.category !== undefined && a.category !== null) {
    if (typeof a.category !== "string" || a.category.trim().length > AUTOMATION_LIMITS.category) return { ok: false, error: "The category is too long." };
    out.category = a.category.trim();
  }
  // 1.20.6: a sub-category goes with its category.
  if (a.subcategory !== undefined && a.subcategory !== null && a.subcategory !== "") {
    if (typeof a.subcategory !== "string" || a.subcategory.trim().length > AUTOMATION_LIMITS.category) return { ok: false, error: "The sub-category is too long." };
    if (!out.category) return { ok: false, error: "Choose the category the sub-category belongs to." };
    if (a.subcategory.trim()) out.subcategory = a.subcategory.trim();
  }
  if (a.tags_add !== undefined && a.tags_add !== null) {
    const tags = cleanTags(a.tags_add);
    if (!tags) return { ok: false, error: "Tags must be a list of short words." };
    if (tags.length) out.tags_add = tags;
  }
  if (a.internal_note !== undefined && a.internal_note !== null && a.internal_note !== "") {
    if (typeof a.internal_note !== "string" || a.internal_note.length > AUTOMATION_LIMITS.note) return { ok: false, error: "The note is too long." };
    if (a.internal_note.trim()) out.internal_note = a.internal_note.trim();
  }
  if (a.notify !== undefined && a.notify !== null && a.notify !== "") {
    if (a.notify === "assignee" || a.notify === "team") out.notify = a.notify;
    else if (typeof a.notify === "object" && a.notify && Number.isInteger(Number((a.notify as { user_id?: unknown }).user_id)) && Number((a.notify as { user_id?: unknown }).user_id) > 0) {
      out.notify = { user_id: Number((a.notify as { user_id: unknown }).user_id) };
    } else return { ok: false, error: "Notify the assignee, the team or one person." };
  }
  // 1.20.33: the requester and the body.
  const rs = requesterSetField(a.requester_set);
  if (!rs.ok) return rs;
  const rm = requesterFromMessageField(a.requester_from_message);
  if (!rm.ok) return rm;
  if (rs.value && rm.value) return { ok: false, error: "Change the requester to a person or from the message, not both." };
  if (rs.value) out.requester_set = rs.value;
  if (rm.value) out.requester_from_message = rm.value;
  const cv = copyValuesField(a.copy_values);
  if (!cv.ok) return cv;
  if (cv.value) out.copy_values = cv.value;
  if (!Object.keys(out).length) return { ok: false, error: "Choose at least one action." };
  // The field-change part has the same rules as a macro's.
  const m = validateMacroActions({ status: out.status, priority: out.priority, team_id: out.team_id, tags_add: out.tags_add });
  if (!m.ok) return m;
  return { ok: true, value: out };
}

export interface AutomationInput {
  name: string;
  event: HdAutomationEvent;
  conditions: HdAutomationConditions;
  actions: HdAutomationActions;
  active: number;
  position?: number;
}

/**
 * 1.20.30: the teams and request types a stored rule names (live, and in a
 * waiting draft). A save may keep naming one that was deleted since: see
 * validateAutomationInput.
 */
export interface AutomationStoredRefs {
  teams: readonly number[];
  types: readonly number[];
  /** 1.20.33: the person "Change the requester" names. */
  people?: readonly number[];
  /** 1.20.33: the address "Change the requester" names (lower-case). */
  addresses?: readonly string[];
  /** 1.20.33: the custom fields "Copy a value into a field" writes, by key. */
  fields?: readonly string[];
}

export const NO_AUTOMATION_REFS: AutomationStoredRefs = { teams: [], types: [], people: [], addresses: [], fields: [] };

type RuleRefs = { conditions?: HdAutomationConditions | null; actions?: HdAutomationActions | null } | null | undefined;

export function automationStoredRefs(...rules: RuleRefs[]): AutomationStoredRefs {
  const teams = new Set<number>();
  const types = new Set<number>();
  const people = new Set<number>();
  const addresses = new Set<string>();
  const fields = new Set<string>();
  for (const r of rules) {
    for (const id of r?.conditions?.team_ids ?? []) teams.add(id);
    if (r?.actions?.team_id) teams.add(r.actions.team_id);
    for (const id of r?.conditions?.request_type_ids ?? []) types.add(id);
    if (r?.actions?.requester_set?.user_id) people.add(r.actions.requester_set.user_id);
    if (r?.actions?.requester_set?.email) addresses.add(r.actions.requester_set.email.toLowerCase());
    for (const c of r?.actions?.copy_values ?? []) if (c.field_key) fields.add(c.field_key);
  }
  return { teams: [...teams], types: [...types], people: [...people], addresses: [...addresses], fields: [...fields] };
}

/** 1.20.30: what a save says when a team or request type the rule named was deleted (see validateAutomationInput). */
export const AUTOMATION_GONE = {
  teamCondition: "The team this rule checks for was deleted, so the rule matches no tickets. Under If, pick another team, or remove the deleted team to run the rule on tickets of any team.",
  typeCondition:
    "The request type this rule checks for was deleted, so the rule matches no tickets. Under If, pick another request type, or remove the deleted one to run the rule on tickets of any request type.",
  teamAction: "The team this rule moved tickets to was deleted, so the rule no longer moves them.",
  teamOnlyAction: "The team this rule moved tickets to was deleted, and moving them was all the rule did. Under Then, pick another team or another action, or delete the rule.",
  // 1.20.33: the person "Change the requester" names, and the fields "Copy a value into a field" writes.
  requesterAction:
    "The person this rule made the requester can no longer be one (their account is gone or can't use Get help, or outside senders were switched off), so the rule no longer changes the requester.",
  requesterOnlyAction:
    "The person this rule made the requester can no longer be one (their account is gone or can't use Get help, or outside senders were switched off), and changing the requester was all the rule did. Under Then, pick another person or another action, or delete the rule.",
  fieldAction: "A custom field this rule copied a value into was deleted, so the rule no longer copies that value.",
  fieldOnlyAction: "The custom field this rule copied a value into was deleted, and copying it was all the rule did. Under Then, pick another field or another action, or delete the rule.",
} as const;

/** Validation that passed, with what a save should tell the person (1.20.30: a deleted team the rule no longer moves tickets to). */
export type CheckedAutomation = { ok: true; value: Partial<AutomationInput>; notices: string[] } | { ok: false; error: string };

/**
 * Validate a create (or, `partial`, an update) body, checking that named teams, people, macros and request types exist.
 *
 * 1.20.30: `stored`, the teams and request types the rule already names (automationStoredRefs:
 * live and draft). One of those deleted since is no refusal that no edit could clear (the page
 * can't show a deleted team), and never silently changes what the rule does:
 *   - in a condition's list beside others that exist, it is dropped (no ticket has it any more);
 *   - when it was all the list held, the save is refused with what to do (dropping it would
 *     turn "only team X" into "any team"; the page shows the deleted entry with Remove);
 *   - as the team the rule moves tickets to, it is dropped, which changes nothing (the move
 *     already failed and was skipped), and the save says so (`notices`); refused with what to
 *     do when moving was the rule's only action.
 * A team or request type the rule did not name before must exist ("Unknown team.").
 */
export async function validateAutomationInput(raw: Record<string, unknown>, partial = false, stored: AutomationStoredRefs = NO_AUTOMATION_REFS): Promise<CheckedAutomation> {
  const out: Partial<AutomationInput> = {};
  const notices: string[] = [];
  if (!partial || raw.name !== undefined) {
    if (typeof raw.name !== "string" || !raw.name.trim()) return { ok: false, error: "Give the automation a name." };
    if (raw.name.trim().length > AUTOMATION_LIMITS.name) return { ok: false, error: `Keep the name under ${AUTOMATION_LIMITS.name} characters.` };
    out.name = raw.name.trim();
  }
  if (!partial || raw.event !== undefined) {
    if (!HD_AUTOMATION_EVENTS.includes(raw.event as HdAutomationEvent)) return { ok: false, error: "Choose when the automation runs." };
    out.event = raw.event as HdAutomationEvent;
  }
  if (!partial || raw.conditions !== undefined) {
    const c = validateConditions(raw.conditions);
    if (!c.ok) return c;
    out.conditions = c.value;
  }
  if (!partial || raw.actions !== undefined) {
    const a = validateActions(raw.actions);
    if (!a.ok) return a;
    out.actions = a.value;
  }
  if (raw.active !== undefined) out.active = raw.active === true || raw.active === 1 ? 1 : 0;
  else if (!partial) out.active = 1;
  if (raw.position !== undefined) {
    const p = Number(raw.position);
    if (!Number.isInteger(p) || p < 0 || p > 10_000) return { ok: false, error: "Bad position." };
    out.position = p;
  }
  // References must exist (1.20.30: or be ones the rule already named, see above).
  const teamIds = [...new Set([...(out.conditions?.team_ids ?? []), ...(out.actions?.team_id ? [out.actions.team_id] : [])])];
  if (teamIds.length) {
    const live = new Set((await hq<{ id: number }>("SELECT id FROM hd_teams WHERE id = ANY($1)", [teamIds])).map((r) => r.id));
    if (teamIds.some((id) => !live.has(id) && !stored.teams.includes(id))) return { ok: false, error: "Unknown team." };
    if (out.conditions?.team_ids?.length) {
      const kept = out.conditions.team_ids.filter((id) => live.has(id));
      if (!kept.length) return { ok: false, error: AUTOMATION_GONE.teamCondition };
      out.conditions.team_ids = kept;
    }
    if (out.actions?.team_id && !live.has(out.actions.team_id)) {
      const { team_id: _gone, ...rest } = out.actions;
      if (!Object.keys(rest).length) return { ok: false, error: AUTOMATION_GONE.teamOnlyAction };
      out.actions = rest;
      notices.push(AUTOMATION_GONE.teamAction);
    }
  }
  if (out.conditions?.request_type_ids?.length) {
    const ids = out.conditions.request_type_ids;
    const live = new Set((await hq<{ id: number }>("SELECT id FROM hd_request_types WHERE id = ANY($1)", [ids])).map((r) => r.id));
    if (ids.some((id) => !live.has(id) && !stored.types.includes(id))) return { ok: false, error: "Unknown request type." };
    const kept = ids.filter((id) => live.has(id));
    if (!kept.length) return { ok: false, error: AUTOMATION_GONE.typeCondition };
    out.conditions.request_type_ids = kept;
  }
  if (out.actions?.macro_id) {
    // A rule sends shared macros only, never someone's personal one.
    const { ensureMacroSchema } = await import("./macros");
    await ensureMacroSchema();
    if (!(await hqOne("SELECT 1 FROM hd_macros WHERE id = $1 AND owner_id IS NULL", [out.actions.macro_id]))) return { ok: false, error: "Unknown macro." };
  }
  // 1.20.6 (lib/helpdesk/categories): categories come from the admin's list. A rule sets one that is not archived;
  // its conditions may name any that is listed (old tickets keep an archived one). Names are stored as the list spells them.
  if (out.actions?.category || out.conditions?.categories?.length || out.conditions?.subcategories?.length) {
    const { categoryTree } = await import("./categories");
    const { findCategory, listNames, resolveCategoryPick } = await import("./categories-shared");
    const tree = await categoryTree();
    if (out.actions?.category) {
      const pick = resolveCategoryPick(tree, { category: out.actions.category, subcategory: out.actions.subcategory ?? "" });
      if (!pick.ok) return { ok: false, error: pick.error };
      out.actions.category = pick.category;
      if (pick.subcategory) out.actions.subcategory = pick.subcategory;
    }
    const names = tree.map((x) => x.name);
    const none = names.length ? `Categories: ${listNames(names)}.` : "No categories are set up yet. An admin adds them in Desk settings, Categories.";
    if (out.conditions?.categories) {
      const fixed: string[] = [];
      for (const name of out.conditions.categories) {
        const hit = findCategory(tree, name);
        if (!hit) return { ok: false, error: `"${name}" is not a category on the list. ${none}` };
        fixed.push(hit.name);
      }
      out.conditions.categories = fixed;
    }
    if (out.conditions?.subcategories) {
      const fixed: { category: string; subcategory: string }[] = [];
      for (const p of out.conditions.subcategories) {
        const cat = findCategory(tree, p.category);
        if (!cat) return { ok: false, error: `"${p.category}" is not a category on the list. ${none}` };
        const sub = findCategory(cat.subcategories, p.subcategory);
        if (!sub) return { ok: false, error: `"${p.subcategory}" is not a sub-category of ${cat.name}.` };
        fixed.push({ category: cat.name, subcategory: sub.name });
      }
      out.conditions.subcategories = fixed;
    }
  }
  // 1.20.16 review fix: who a rule assigns to or notifies is someone on the desk (an active desk
  // agent, as the desk's assignee and people pickers offer), never a requester or anyone else.
  const people = [out.actions?.assignee_id, typeof out.actions?.notify === "object" ? out.actions.notify.user_id : undefined].filter((x): x is number => !!x);
  if (people.length) {
    const { listDeskAgents } = await import("./roles-agents");
    const found = new Set((await listDeskAgents({ userIds: [...new Set(people)] })).filter((a) => a.role !== null).map((a) => a.user_id));
    if (out.actions?.assignee_id && !found.has(out.actions.assignee_id)) return { ok: false, error: "Assign to someone on the desk: that person is not a desk agent." };
    if (typeof out.actions?.notify === "object" && !found.has(out.actions.notify.user_id)) return { ok: false, error: "Notify someone on the desk: that person is not a desk agent." };
  }
  // 1.20.33: the person "Change the requester" names must be able to be a requester (an account that can use Get help,
  // or an address); one the rule named before whose account is gone since follows the 1.20.30 rules for a deleted team.
  const rs = out.actions?.requester_set;
  if (rs && out.actions) {
    const { resolveRequester } = await import("./requester-change");
    const r = await resolveRequester(rs.user_id ? { user_id: rs.user_id } : { email: rs.email, name: rs.name });
    if (!r.ok) {
      // Review L5 (the 1.20.30 rule): a person or address the rule already named who can no longer be a requester
      // (gone, no Get help, a blocked portal contact, outside senders switched off) is dropped with a notice, never
      // refused; refused only when changing the requester was all the rule did. One it never named must qualify.
      const named = rs.user_id ? (stored.people ?? []).includes(rs.user_id) : !!rs.email && (stored.addresses ?? []).includes(rs.email.toLowerCase());
      if (named && r.code !== "invalid_email") {
        const { requester_set: _gone, ...rest } = out.actions;
        if (!Object.keys(rest).length) return { ok: false, error: AUTOMATION_GONE.requesterOnlyAction };
        out.actions = rest;
        notices.push(AUTOMATION_GONE.requesterAction);
      } else if (r.code === "not_found") return { ok: false, error: "Change the requester: unknown person. Pick someone with an active account, or an address." };
      else return { ok: false, error: `Change the requester: ${r.error}` };
    }
  }
  // 1.20.33 review M3: the requester changes only on a new ticket or the requester's message.
  if (out.event && (out.actions?.requester_set || out.actions?.requester_from_message) && !REQUESTER_ACTION_EVENTS.includes(out.event)) {
    return { ok: false, error: REQUESTER_EVENT_REFUSED };
  }
  // 1.20.33: copy into custom fields that exist and are not archived (one the rule named before may be deleted or archived since).
  const copies = out.actions?.copy_values ?? [];
  const keys = [...new Set(copies.map((c) => c.field_key).filter((k): k is string => !!k))];
  if (keys.length && out.actions) {
    const defs = await hq<{ key: string; label: string; archived_at: string | null }>("SELECT key, label, archived_at FROM hd_custom_fields WHERE key = ANY($1::text[])", [keys]);
    const was = new Set(stored.fields ?? []);
    const kept: HdAutomationCopy[] = [];
    let dropped = false;
    for (const c of copies) {
      if (!c.field_key) {
        kept.push(c);
        continue;
      }
      const d = defs.find((x) => x.key === c.field_key);
      if (!d) {
        if (!was.has(c.field_key)) return { ok: false, error: `Copy a value into a field: there is no custom field with the key "${c.field_key}".` };
        dropped = true;
        continue;
      }
      if (d.archived_at && !was.has(c.field_key)) return { ok: false, error: `Copy a value into a field: "${d.label}" is archived, so a rule can't fill it in. Restore it in Desk settings → Custom fields, or pick another field.` };
      kept.push(c);
    }
    if (dropped) {
      const { copy_values: _all, ...rest } = out.actions;
      const next = kept.length ? { ...rest, copy_values: kept } : rest;
      if (!Object.keys(next).length) return { ok: false, error: AUTOMATION_GONE.fieldOnlyAction };
      out.actions = next;
      notices.push(AUTOMATION_GONE.fieldAction);
    }
  }
  return { ok: true, value: out, notices };
}

// --- Storage ---------------------------------------------------------------------

// 1.20.16: with the draft columns (Claude's drafts).
// 1.20.23: and its desk department.
const COLS = `id, name, event, conditions, actions, active, position, created_at, updated_at, last_run_at, desk_department_id, ${DRAFT_COLS_SQL}`;
/** 1.20.16 review fix: the row as a save reads it, with the live rule's updated_at when the changes were drafted. */
const LOCK_COLS = `${COLS}, draft_base_at`;
type LockedRule = HdAutomation & { draft_base_at: string | null };

export async function listAutomations(): Promise<HdAutomation[]> {
  return hq<HdAutomation>(`SELECT ${COLS} FROM hd_automations ORDER BY position, id`);
}

export async function getAutomation(id: number): Promise<HdAutomation | undefined> {
  return hqOne<HdAutomation>(`SELECT ${COLS} FROM hd_automations WHERE id = $1`, [id]);
}

export class AutomationLimitError extends Error {}

/** 1.20.16: a draft or publish refused (the sentence, and the status the route answers). */
export class AutomationDraftError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** 1.20.23: `deskDepartmentId` (checked by the caller; null = All departments, left out = the default desk department). */
export async function createAutomation(input: AutomationInput, deskDepartmentId?: number | null): Promise<HdAutomation> {
  await categoriesReady();
  const { deptArg, deptInsertSql } = await import("./desk-departments");
  return withTx(async (client) => {
    // 1.20.16 review fix: rule writes take the category list's lock, shared, first (a rename or merge
    // rewriting the rules waits for them, and they for it), then the rows: one order everywhere.
    await client.query(CATEGORY_LIST_SHARED_LOCK_SQL);
    const n = await hqOne<{ n: number; max: number | null }>("SELECT count(*)::int AS n, max(position) AS max FROM hd_automations", [], client);
    if ((n?.n ?? 0) >= AUTOMATION_LIMITS.rules) throw new AutomationLimitError(`A workspace can keep up to ${AUTOMATION_LIMITS.rules} automations.`);
    const position = input.position ?? (n?.max ?? -1) + 1;
    return (await hqOne<HdAutomation>(
      `INSERT INTO hd_automations (name, event, conditions, actions, active, position, desk_department_id) VALUES ($1, $2, $3, $4, $5, $6, ${deptInsertSql(7)}) RETURNING ${COLS}`,
      [input.name, input.event, JSON.stringify(input.conditions), JSON.stringify(input.actions), input.active, position, deptArg(deskDepartmentId)],
      client
    ))!;
  });
}

const draftOf = (a: Pick<HdAutomation, "name" | "event" | "conditions" | "actions">): HdAutomationDraft => ({
  name: a.name,
  event: a.event,
  conditions: a.conditions ?? {},
  actions: a.actions ?? {},
});

/**
 * Update a rule (Desk settings → Automations' PATCH, already checked with
 * validateAutomationInput(…, true)). The row is locked while it is read and
 * written. 1.20.16, drafts from Claude (the 1.20.14 review's rules):
 *   - a plain save edits the live rule, or the unpublished draft, and keeps
 *     any changes waiting; an unpublished draft can't be switched on (409);
 *   - `publish` (an unpublished draft) makes it a real rule and switches it
 *     on (unless the save says active 0); `publishDraft` applies the changes
 *     waiting on a published rule (fields not sent come from that draft) and
 *     keeps its on/off. Both name the draft the person reviewed (`draftAt`,
 *     409 when Claude saved a newer one) and check the whole rule again as
 *     Desk settings would (categories may have changed since).
 */
export async function updateAutomation(
  id: number,
  patch: Partial<AutomationInput>,
  /** 1.20.23 review N4: `dept` (a PATCH's desk department) is written in the same transaction as the edit. */
  opts: { publish?: boolean; publishDraft?: boolean; draftAt?: unknown; dept?: number | null } = {}
): Promise<{ before: HdAutomation; after: HdAutomation; published: boolean; notices: string[] } | undefined> {
  // The list's adoption takes its lock outright: never from inside a transaction that holds it shared.
  await categoriesReady();
  return withTx(async (client) => {
    await client.query(CATEGORY_LIST_SHARED_LOCK_SQL);
    const cur = await hqOne<LockedRule>(`SELECT ${LOCK_COLS} FROM hd_automations WHERE id = $1 FOR UPDATE`, [id], client);
    if (!cur) return undefined;
    const publish = opts.publish === true && !cur.published;
    const publishDraft = opts.publishDraft === true;
    if (publishDraft && !(cur.published && cur.draft)) throw new AutomationDraftError(NO_CHANGES_WAITING, 409);
    if ((publish || publishDraft) && !sameDraftInstant(cur.draft_at, opts.draftAt)) throw new AutomationDraftError(STALE_DRAFT_MESSAGE, 409);
    // Review fix: the changes were drafted against the rule as it was; a person's edit since would be undone unseen.
    if (publishDraft && cur.draft_base_at && new Date(cur.updated_at).getTime() > new Date(cur.draft_base_at).getTime()) {
      throw new AutomationDraftError(RULE_CHANGED_SINCE, 409);
    }
    // The draft is the base only when publishing it; otherwise the copy the row holds.
    const base = publishDraft ? { ...cur, ...cur.draft! } : cur;
    let next: HdAutomation = { ...base, ...patch } as HdAutomation;
    const notices: string[] = [];
    // 1.20.33 review M3: a save that sends only the event or only the actions is checked against the rest of the rule.
    // (Only a save that changes either: switching a rule off always works.)
    const touches = patch.event !== undefined || patch.actions !== undefined || publish || publishDraft;
    if (touches && (next.actions?.requester_set || next.actions?.requester_from_message) && !REQUESTER_ACTION_EVENTS.includes(next.event)) {
      throw new AutomationDraftError(REQUESTER_EVENT_REFUSED, 400);
    }
    if (publish || publishDraft) {
      const full = await validateAutomationInput({ name: next.name, event: next.event, conditions: next.conditions, actions: next.actions }, false, automationStoredRefs(cur, cur.draft));
      if (!full.ok) throw new AutomationDraftError(full.error, 400);
      notices.push(...full.notices);
      next = { ...next, ...full.value, active: next.active, position: next.position } as HdAutomation;
    }
    let active = next.active;
    const editsDraft = !cur.published && !publish;
    if (editsDraft) {
      // Only a person's publish switches a draft on.
      if (patch.active === 1) throw new AutomationDraftError("This rule is a draft from Claude. Publish it to switch it on.", 409);
      active = 0;
    } else if (publish) active = patch.active === 0 ? 0 : 1;
    const after = await hqOne<HdAutomation>(
      `UPDATE hd_automations SET name = $2, event = $3, conditions = $4, actions = $5, active = $6, position = $7, updated_at = now()${
        publish ? ", published = 1" : ""
      }${publish || publishDraft ? `, ${CLEAR_DRAFT_SQL}, draft_base_at = NULL` : ""}${
        // Review fix: a person's edit of an unpublished draft is a new version: a publish must name it.
        editsDraft ? ", draft_at = now()" : ""
      }
        WHERE id = $1 RETURNING ${COLS}`,
      [id, next.name, next.event, JSON.stringify(next.conditions ?? {}), JSON.stringify(next.actions ?? {}), active, next.position],
      client
    );
    if (after && opts.dept !== undefined) {
      await (await import("./desk-departments")).setItemDeskDepartment("automations", id, opts.dept, client);
      after.desk_department_id = opts.dept;
    }
    return after ? { before: cur, after, published: publish || publishDraft, notices } : undefined;
  });
}

/** 1.20.16 review fix: publishing changes over a rule a person edited after Claude drafted them. */
export const RULE_CHANGED_SINCE = "The rule changed since this draft was made. Review it again: discard the changes, or ask Claude for new ones.";

/**
 * 1.20.16: check an automation draft as Desk settings would, without saving
 * it (the connector's hd_draft_automation and Claude in the desk's card).
 * With `base` (an existing rule's draft or live copy), fields not sent come
 * from it. Answers the rule in the shape the list stores.
 */
export async function checkAutomationDraft(raw: unknown, base?: HdAutomationDraft, stored: AutomationStoredRefs = automationStoredRefs(base)): Promise<HdAutomationDraft> {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    name: r.name ?? base?.name,
    event: r.event ?? base?.event,
    conditions: r.conditions ?? base?.conditions,
    actions: r.actions ?? base?.actions,
  };
  const v = await validateAutomationInput(merged, false, stored);
  if (!v.ok) throw new AutomationDraftError(v.error, 400);
  return draftOf(v.value as AutomationInput);
}

/**
 * 1.20.16: save an automation draft for a person to review (Claude's
 * hd_draft_automation, and Save as draft on a Claude in the desk card).
 * Without `id`: a new rule, switched off and unpublished, at the end of the
 * order. With `id`: an unpublished draft is replaced; a published rule keeps
 * running as it is and gets the proposal in `draft` (replacing an earlier
 * one). Fields not sent come from the current draft, else the live rule. The
 * row is locked, so a person publishing at the same moment is either before
 * this (and the proposal goes beside the live rule) or after it, never
 * overwritten into the live rule. Never switches anything on.
 */
export async function saveAutomationDraft(
  raw: unknown,
  actor: { id: number | null; name: string; via: HdDraftVia },
  id?: number,
  /** 1.20.23: a new draft's desk department (checked by the caller; left out = the default one). */
  deskDepartmentId?: number | null
): Promise<{ automation: HdAutomation; kind: "new" | "replaced" | "changes" }> {
  const meta = [actor.id, actor.name, actor.via];
  // 1.20.33 review L4: a draft copies only into fields its desk department's teams have (as Desk settings checks a save).
  const fieldsFit = async (dept: number | null, actions: HdAutomationActions) => {
    const { automationFieldsRefusal } = await import("./desk-departments");
    const refused = await automationFieldsRefusal(dept, actions.copy_values);
    if (refused) throw new AutomationDraftError(refused, 400);
  };
  if (id === undefined) {
    const input = await checkAutomationDraft(raw);
    await fieldsFit(deskDepartmentId === undefined ? await (await import("./desk-departments")).defaultDeskDepartmentId() : deskDepartmentId, input.actions);
    await categoriesReady();
    const { deptArg, deptInsertSql } = await import("./desk-departments");
    return withTx(async (client) => {
      await client.query(CATEGORY_LIST_SHARED_LOCK_SQL);
      await client.query("LOCK TABLE hd_automations IN SHARE ROW EXCLUSIVE MODE");
      const n = await hqOne<{ n: number; max: number | null }>("SELECT count(*)::int AS n, max(position) AS max FROM hd_automations", [], client);
      if ((n?.n ?? 0) >= AUTOMATION_LIMITS.rules) throw new AutomationDraftError(`A workspace can keep up to ${AUTOMATION_LIMITS.rules} automations.`, 409);
      const a = await hqOne<HdAutomation>(
        `INSERT INTO hd_automations (name, event, conditions, actions, active, position, published, draft_by, draft_by_name, draft_at, draft_via, desk_department_id)
         VALUES ($1, $2, $3, $4, 0, $5, 0, $6, $7, now(), $8, ${deptInsertSql(9)}) RETURNING ${COLS}`,
        [input.name, input.event, JSON.stringify(input.conditions), JSON.stringify(input.actions), (n?.max ?? -1) + 1, ...meta, deptArg(deskDepartmentId)],
        client
      );
      return { automation: a!, kind: "new" as const };
    });
  }
  // Checked against the row as it is now (outside the lock: validation reads other tables), then again under it.
  const peek = await getAutomation(id);
  if (!peek) throw new AutomationDraftError(`No automation with id ${id}.`, 404);
  const input = await checkAutomationDraft(raw, peek.draft ?? draftOf(peek), automationStoredRefs(peek, peek.draft));
  await fieldsFit(peek.desk_department_id ?? null, input.actions);
  await categoriesReady();
  return withTx(async (client) => {
    await client.query(CATEGORY_LIST_SHARED_LOCK_SQL);
    const before = await hqOne<HdAutomation>(`SELECT ${COLS} FROM hd_automations WHERE id = $1 FOR UPDATE`, [id], client);
    if (!before) throw new AutomationDraftError(`No automation with id ${id}.`, 404);
    if (!before.published) {
      const a = await hqOne<HdAutomation>(
        `UPDATE hd_automations SET name = $2, event = $3, conditions = $4, actions = $5, active = 0, updated_at = now(),
                draft_by = $6, draft_by_name = $7, draft_at = now(), draft_via = $8
          WHERE id = $1 AND published = 0 RETURNING ${COLS}`,
        [id, input.name, input.event, JSON.stringify(input.conditions), JSON.stringify(input.actions), ...meta],
        client
      );
      if (!a) throw new AutomationDraftError("That automation changed while saving. Try again.", 409);
      return { automation: a, kind: "replaced" as const };
    }
    const a = await hqOne<HdAutomation>(
      // draft_base_at: the live rule these changes were drafted against (a person's later edit makes publishing them refuse).
      `UPDATE hd_automations SET draft = $2, draft_by = $3, draft_by_name = $4, draft_at = now(), draft_via = $5, draft_base_at = updated_at WHERE id = $1 RETURNING ${COLS}`,
      [id, JSON.stringify(input), ...meta],
      client
    );
    return { automation: a!, kind: "changes" as const };
  });
}

/**
 * 1.20.16: drop the changes waiting on a published rule (it keeps running as
 * it is). Undefined when there is no such rule or nothing waits. With
 * `draftAt`, only the draft the person saw (409 when Claude saved a newer one).
 */
export async function discardAutomationDraft(id: number, draftAt?: unknown): Promise<HdAutomation | undefined> {
  await categoriesReady();
  return withTx(async (client) => {
    await client.query(CATEGORY_LIST_SHARED_LOCK_SQL);
    const before = await hqOne<HdAutomation>(`SELECT ${COLS} FROM hd_automations WHERE id = $1 FOR UPDATE`, [id], client);
    if (!before || !before.published || !before.draft) return undefined;
    if (draftAt !== undefined && draftAt !== null && !sameDraftInstant(before.draft_at, draftAt)) throw new AutomationDraftError(STALE_DISCARD_MESSAGE, 409);
    await client.query(`UPDATE hd_automations SET ${CLEAR_DRAFT_SQL}, draft_base_at = NULL WHERE id = $1`, [id]);
    return before;
  });
}

export async function deleteAutomation(id: number): Promise<HdAutomation | undefined> {
  await categoriesReady();
  return withTx(async (client) => {
    await client.query(CATEGORY_LIST_SHARED_LOCK_SQL);
    return hqOne<HdAutomation>(`DELETE FROM hd_automations WHERE id = $1 RETURNING ${COLS}`, [id], client);
  });
}

/** A rule as plain words: When, If (each condition), Then (each action, naming who and which macro). */
export interface AutomationWords {
  when: string;
  if: string[];
  then: string[];
}

/**
 * 1.20.16: rules in plain words, for Claude's hd_list_automations, the draft cards and the review
 * strip ("What this rule will do"): every trigger, condition and action, naming the team, the
 * person assigned or notified and the macro whose reply is sent. One batch of lookups for all the
 * rules (review fix: no queries per rule).
 */
export async function automationsInWords(rules: Pick<HdAutomation, "event" | "conditions" | "actions">[]): Promise<AutomationWords[]> {
  const teamIds = new Set<number>();
  const typeIds = new Set<number>();
  const people = new Set<number>();
  const macros = new Set<number>();
  const fieldKeys = new Set<string>();
  for (const a of rules) {
    const c = a.conditions ?? {};
    const x = a.actions ?? {};
    for (const id of c.team_ids ?? []) teamIds.add(id);
    if (x.team_id) teamIds.add(x.team_id);
    for (const id of c.request_type_ids ?? []) typeIds.add(id);
    if (x.assignee_id) people.add(x.assignee_id);
    if (x.notify && typeof x.notify === "object") people.add(x.notify.user_id);
    if (x.macro_id) macros.add(x.macro_id);
    if (x.requester_set?.user_id) people.add(x.requester_set.user_id);
    for (const cv of x.copy_values ?? []) if (cv.field_key) fieldKeys.add(cv.field_key);
  }
  const map = <T extends { id: number }>(rows: T[], f: (r: T) => string) => new Map(rows.map((r) => [r.id, f(r)]));
  const teams = map(teamIds.size ? await hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams WHERE id = ANY($1::int[])", [[...teamIds]]) : [], (r) => r.name);
  const types = map(typeIds.size ? await hq<{ id: number; title: string }>("SELECT id, title FROM hd_request_types WHERE id = ANY($1::int[])", [[...typeIds]]) : [], (r) => r.title);
  const names = map(
    people.size ? await hq<{ id: number; name: string }>("SELECT id, COALESCE(NULLIF(name, ''), username) AS name FROM users WHERE id = ANY($1::int[])", [[...people]]) : [],
    (r) => r.name
  );
  const macroNames = map(macros.size ? await hq<{ id: number; title: string }>("SELECT id, title FROM hd_macros WHERE id = ANY($1::int[])", [[...macros]]).catch(() => []) : [], (r) => r.title);
  // 1.20.33: the custom fields copy actions write, by key.
  const fieldLabels = new Map(
    (fieldKeys.size ? await hq<{ key: string; label: string }>("SELECT key, label FROM hd_custom_fields WHERE key = ANY($1::text[])", [[...fieldKeys]]).catch(() => []) : []).map((r) => [r.key, r.label])
  );
  const { HD_PRIORITY_LABEL, HD_SOURCE_LABEL, HD_STATUS_LABEL } = await import("./types");
  const or = (xs: string[]) => xs.join(" or ");
  return rules.map((a) => {
    const c = a.conditions ?? {};
    const x = a.actions ?? {};
    const ifs: string[] = [];
    if (c.team_ids?.length) ifs.push(`the team is ${or(c.team_ids.map((id) => teams.get(id) ?? `team ${id}`))}`);
    const cats = [...(c.categories ?? []), ...(c.subcategories ?? []).map((p) => `${p.category} › ${p.subcategory}`)];
    if (cats.length) ifs.push(`the category is ${or(cats)}`);
    if (c.priorities?.length) ifs.push(`the priority is ${or(c.priorities.map((p) => HD_PRIORITY_LABEL[p]))}`);
    if (c.request_type_ids?.length) ifs.push(`the request type is ${or(c.request_type_ids.map((id) => types.get(id) ?? `request type ${id}`))}`);
    if (c.sources?.length) ifs.push(`it came in through ${or(c.sources.map((s) => HD_SOURCE_LABEL[s]))}`);
    if (c.keywords?.length) ifs.push(`it mentions ${or(c.keywords.map((k) => `"${k}"`))}`);
    // 1.20.33: the subject and the body.
    const quoted = (xs: string[]) => xs.map((k) => `"${k}"`);
    if (c.subject_contains?.length) ifs.push(`the subject contains ${or(quoted(c.subject_contains))}`);
    if (c.subject_not_contains?.length) ifs.push(`the subject contains none of ${quoted(c.subject_not_contains).join(", ")}`);
    if (c.body_contains?.length) ifs.push(`the message contains ${or(quoted(c.body_contains))}`);
    if (c.body_not_contains?.length) ifs.push(`the message contains none of ${quoted(c.body_not_contains).join(", ")}`);
    if (c.subject_pattern?.pattern) ifs.push(`the subject matches the pattern ${patternWords(c.subject_pattern)}`);
    if (c.body_pattern?.pattern) ifs.push(`the message matches the pattern ${patternWords(c.body_pattern)}`);
    const then: string[] = [];
    if (x.team_id) then.push(`move it to ${teams.get(x.team_id) ?? `team ${x.team_id}`}`);
    if (x.assignee_id) then.push(`assign it to ${names.get(x.assignee_id) ?? `person ${x.assignee_id}`}`);
    if (x.priority) then.push(`set the priority to ${HD_PRIORITY_LABEL[x.priority]}`);
    if (x.status) then.push(`set the status to ${HD_STATUS_LABEL[x.status]}`);
    if (x.category) then.push(`set the category to ${x.subcategory ? `${x.category} › ${x.subcategory}` : x.category}`);
    if (x.tags_add?.length) then.push(`add the ${x.tags_add.length === 1 ? "tag" : "tags"} ${x.tags_add.join(", ")}`);
    if (x.internal_note) then.push(`add the internal note "${x.internal_note.length > 120 ? `${x.internal_note.slice(0, 119)}…` : x.internal_note}"`);
    if (x.macro_id) then.push(`send the macro reply "${macroNames.get(x.macro_id) ?? `macro ${x.macro_id}`}" to the requester`);
    if (x.notify === "assignee") then.push("notify the owner");
    else if (x.notify === "team") then.push("notify the team");
    else if (x.notify) then.push(`notify ${names.get(x.notify.user_id) ?? `person ${x.notify.user_id}`}`);
    // 1.20.33: the requester and copied values.
    if (x.requester_set) {
      const r = x.requester_set;
      const who = r.user_id ? (names.get(r.user_id) ?? `person ${r.user_id}`) : r.name ? `${r.name} (${r.email})` : (r.email ?? "");
      then.push(`make ${who} the requester${r.keep_cc ? ", keeping the previous requester as a CC" : ""}`);
    }
    if (x.requester_from_message) then.push(requesterFromMessageWords(x.requester_from_message));
    for (const cv of x.copy_values ?? []) then.push(copyWords(cv, cv.field_key ? (fieldLabels.get(cv.field_key) ?? `the field ${cv.field_key}`) : ""));
    return { when: HD_AUTOMATION_EVENT_LABEL[a.event] ?? a.event, if: ifs.length ? ifs : ["any ticket"], then };
  });
}

/** 1.20.33: a pattern as the summary shows it: /…/, with "(match case)" when it does. */
function patternWords(p: HdAutomationPattern): string {
  return `/${p.pattern}/${p.match_case ? " (match case)" : ""}`;
}

const orList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);

/** 1.20.33: "Change the requester from the message" in plain words, its sender scope included. */
export function requesterFromMessageWords(m: HdAutomationRequesterFromMessage): string {
  const where =
    m.find === "first" ? "the first email address in the message" : `the email address after ${orList((m.labels?.length ? m.labels : DEFAULT_REQUESTER_LABELS).map((l) => `"${l}"`))} in the message`;
  const parts = [`make ${where} the requester, only for messages from ${orList(m.senders)}`];
  if (m.domains?.length) parts.push(`only addresses at ${orList(m.domains)}`);
  if (m.allow_agents) parts.push("desk agents allowed");
  if (m.keep_cc) parts.push("keeping the original sender as a CC");
  return parts.join(", ");
}

/** 1.20.33: one "Copy a value into a field" in plain words. */
export function copyWords(c: HdAutomationCopy, fieldLabel: string): string {
  const where = c.from === "subject" ? "the subject" : "the message";
  const what = c.label ? `the text after "${c.label}" in ${where}` : `what the pattern /${c.pattern}/${c.match_case ? " (match case)" : ""} finds in ${where}`;
  if (c.tag) return `add ${what} as a tag`;
  return `copy ${what} into ${fieldLabel}${c.only_if_empty === false ? "" : " while it is empty"}`;
}

/** One rule in plain words (automationsInWords for a single rule). */
export async function automationInWords(a: Pick<HdAutomation, "event" | "conditions" | "actions">): Promise<AutomationWords> {
  return (await automationsInWords([a]))[0];
}

// --- Running ---------------------------------------------------------------------

interface Chain {
  depth: number;
  fired: Set<string>;
}

const chainStore = new AsyncLocalStorage<Chain>();

export interface RunResult {
  /** The automations that acted, in order. */
  ran: number[];
  /** Why the run stopped early, when it did. */
  stopped?: "depth";
}

type BodyRow = { body: string; author_email: string; account_email: string | null; via: string; sender_verified: boolean | null; imported: boolean };
// 1.20.33: who sent it (an account's current address), the sender check of an email (lib/helpdesk/automation-body-schema),
// and whether it was imported (lib/helpdesk/import: its sender was never checked).
const BODY_COLS = "m.body, m.author_email, u.email AS account_email, m.via, m.sender_verified, (m.import_ref IS NOT NULL) AS imported";

/** 1.20.33: the message a run reads (its body as agents see it, and its real sender), read once per run. */
export interface TriggeringMessage {
  body: string;
  text: string;
  sender?: MatchTarget["sender"];
}

/**
 * The message rules of `event` read: for requester_message the message that set them off (`messageId`, from
 * lib/helpdesk/events afterMessageAdded; a CC's message is a CC's, with its own sender), else the requester's latest
 * public message; for every other event the opening message. Read once per run (1.20.33), so a rule that changes the
 * requester doesn't change what the rules after it read.
 */
export async function triggeringMessage(event: HdAutomationEvent, t: HdTicketRow, messageId?: number | null): Promise<TriggeringMessage> {
  const msg =
    event === "requester_message" && messageId
      ? await hqOne<BodyRow>(`SELECT ${BODY_COLS} FROM hd_messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.id = $1 AND m.ticket_id = $2`, [messageId, t.id])
      : event === "requester_message"
        ? await hqOne<BodyRow>(
            `SELECT ${BODY_COLS} FROM hd_messages m LEFT JOIN users u ON u.id = m.author_id
              WHERE m.ticket_id = $1 AND m.kind = 'public'
                AND (m.author_id = $2 OR ($2::int IS NULL AND lower(m.author_email) = lower($3)))
              ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
            [t.id, t.requester_id, t.requester_email]
          )
        : await hqOne<BodyRow>(
            `SELECT ${BODY_COLS} FROM hd_messages m LEFT JOIN users u ON u.id = m.author_id
              WHERE m.ticket_id = $1 AND m.kind <> 'system' ORDER BY m.created_at, m.id LIMIT 1`,
            [t.id]
          );
  // As agents read it: the stored Markdown with its escapes undone (an HTML-only email is stored as its text rendering).
  const { markdownToPlain } = await import("./inbound-parse");
  const raw = msg?.body ?? "";
  const imported = msg?.imported === true || !!t.import_source;
  return {
    body: raw,
    text: raw ? markdownToPlain(raw.slice(0, AUTOMATION_LIMITS.bodyBytes * 2)) : "",
    sender: msg
      ? {
          email: (msg.account_email || msg.author_email || "").trim().toLowerCase(),
          verified: imported ? false : msg.via === "email" ? (msg.sender_verified ?? null) : null,
          byEmail: msg.via === "email",
          ...(imported ? { imported: true } : {}),
        }
      : undefined,
  };
}

/** Exported for tests (1.20.33): what a rule reads on a ticket for an event (the ticket's fields now, and the run's message). */
export async function matchTarget(event: HdAutomationEvent, t: HdTicketRow, message?: TriggeringMessage): Promise<MatchTarget> {
  const m = message ?? (await triggeringMessage(event, t));
  return {
    team_id: t.team_id,
    category: t.category,
    subcategory: t.subcategory ?? "",
    priority: t.priority,
    request_type_id: t.request_type_id,
    source: t.source,
    subject: t.subject,
    body: m.body,
    text: m.text,
    sender: m.sender,
  };
}

/**
 * Run the active rules of `event` on one ticket (after the write that
 * caused it committed). Never throws: a failing rule is logged and the next
 * one runs.
 */
export async function runAutomations(
  event: HdAutomationEvent,
  ticketId: number,
  /** 1.20.33: `messageId`, the message that set off requester_message rules (lib/helpdesk/events). */
  opts: { triggeredBy?: number | null; messageId?: number | null } = {}
): Promise<RunResult> {
  const parent = chainStore.getStore();
  const chain: Chain = parent ? { depth: parent.depth + 1, fired: parent.fired } : { depth: 0, fired: new Set() };
  if (chain.depth >= MAX_DEPTH) {
    logEvent("warn", "helpdesk.automation_loop_stopped", { event, ticket_id: ticketId, depth: chain.depth });
    return { ran: [], stopped: "depth" };
  }
  return chainStore.run(chain, async () => {
    const result: RunResult = { ran: [] };
    let rules: HdAutomation[];
    try {
      // 1.20.16: a draft from Claude never runs, even if it were somehow on (published = 1 too).
      rules = await hq<HdAutomation>(`SELECT ${COLS} FROM hd_automations WHERE event = $1 AND active = 1 AND published = 1 ORDER BY position, id`, [event]);
    } catch (e) {
      logEvent("error", "helpdesk.automation_failed", { event, error: String(e) });
      return result;
    }
    // 1.20.23: a team's desk department, read once per team for this run (the default department for no team).
    const deptOfTeam = new Map<number | null, number>();
    const { teamDeskDepartmentId } = await import("./desk-departments");
    // 1.20.33: the message every rule of this run reads, read once (as the run starts).
    let message: TriggeringMessage | undefined;
    for (const rule of rules) {
      const key = `${rule.id}:${ticketId}`;
      if (chain.fired.has(key)) continue;
      try {
        const t = await hqOne<HdTicketRow>("SELECT * FROM hd_tickets WHERE id = $1", [ticketId]);
        if (!t) break;
        // 1.20.23: only the ticket's desk department's rules and All departments' (NULL), the department as it is now.
        if (rule.desk_department_id !== null && rule.desk_department_id !== undefined) {
          if (!deptOfTeam.has(t.team_id)) deptOfTeam.set(t.team_id, await teamDeskDepartmentId(t.team_id));
          if (deptOfTeam.get(t.team_id) !== rule.desk_department_id) continue;
        }
        message ??= await triggeringMessage(event, t, opts.messageId);
        const target = await matchTarget(event, t, message);
        if (!automationMatches(rule.conditions ?? {}, target)) continue;
        const acted = await applyRule(rule, t, opts.triggeredBy ?? null, target);
        if (!acted) continue;
        chain.fired.add(key);
        result.ran.push(rule.id);
        await hq("UPDATE hd_automations SET last_run_at = now() WHERE id = $1", [rule.id]);
      } catch (e) {
        logEvent("error", "helpdesk.automation_failed", { automation: rule.id, ticket_id: ticketId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return result;
  });
}

/** 1.20.20: the agent whose action set an automation off, for the reply lock: someone who works the ticket and isn't its requester. */
async function agentWhoSetItOff(userId: number | null, t: HdTicketRow): Promise<number | null> {
  if (!userId || userId === t.requester_id) return null;
  const { getUserById } = await import("../db");
  const { toSessionUser } = await import("../auth");
  const u = await getUserById(userId);
  if (!u) return null;
  const { canWorkTicket } = await import("./access");
  return (await canWorkTicket(toSessionUser(u), t)) ? userId : null;
}

/**
 * Apply one rule's actions. Answers whether it did anything. Exported for tests (1.19.2, W3).
 * 1.20.33: `target`, what the rule read for its event (runAutomations passes it; read here when a body action needs it).
 */
export async function applyRule(rule: HdAutomation, t: HdTicketRow, triggeredBy: number | null = null, target?: MatchTarget): Promise<boolean> {
  const a = rule.actions ?? {};
  const actor = { id: null, name: `Automation: ${rule.name}` };
  const ctx = { fromAutomation: true, actorName: actor.name };
  // 1.20.33: the requester and the values the body actions find; what they couldn't do is one line on the ticket.
  const skipped: string[] = [];
  const found = a.requester_set || a.requester_from_message || a.copy_values?.length ? await bodyFindings(rule, t, target ?? (await matchTarget(rule.event, t)), skipped) : {};
  const { requester, ...patch } = effectivePatch(a, t, found);
  let acted = false;
  if (requester) {
    const { changeRequester, RequesterChangeError } = await import("./requester-change");
    const keepCc = a.requester_set ? a.requester_set.keep_cc === true : a.requester_from_message?.keep_cc === true;
    try {
      const r = await changeRequester(t.id, { ok: true, who: requester }, actor, {
        keepCc,
        ctx,
        by: "automation",
        auditDetails: { automation: rule.id, automation_name: rule.name, how: a.requester_set ? "person" : "from_message" },
      });
      if (r?.changed) {
        acted = true;
        // Review L3: the acknowledgement goes to an address read from the body, so anyone using a web form on the
        // sender list could have the desk mail any address. At most REQUESTER_ACK_LIMITS: past them the requester
        // still changes, the acknowledgement is held (notify reads requester_ack_held_at) and the ticket says so.
        if (a.requester_from_message && rule.event === "ticket_created") {
          const held = await requesterAckHeld(rule.id, requester.email);
          if (held) {
            await hq("UPDATE hd_tickets SET requester_ack_held_at = now() WHERE id = $1", [t.id]);
            skipped.push(held);
          }
        }
      }
    } catch (e) {
      if (!(e instanceof RequesterChangeError)) throw e;
      skipped.push(`couldn't change the requester: ${e.code === "agent_set" ? e.message : lowerFirst(e.message)}`);
    }
  }
  if (Object.keys(patch).length) {
    const { updateTicket } = await import("./tickets");
    // Refusals peel off only what was refused, then the rest applies: a blocked
    // solve (1.19.2, required checklist items, agent W3) drops the status alone;
    // an assignee who is not on the team, or a team that was deleted, drops the
    // assignee and team. At most three tries (each drops something).
    let left: typeof patch = { ...patch };
    for (let attempt = 0; attempt < 3 && Object.keys(left).length; attempt++) {
      try {
        const res = await updateTicket(t.id, left, actor, ctx);
        acted = true;
        // 1.20.33: values a rule copied from the subject or body into fields or tags are audited, as the change it made.
        const copied = (res?.changed ?? []).filter((k) => (k === "custom_fields" && found.custom) || (k === "tags" && found.tags?.length));
        if (res && copied.length) {
          const { audit } = await import("../audit");
          await audit({
            actor: { id: null, name: actor.name },
            action: "helpdesk.ticket.updated",
            targetType: "helpdesk_ticket",
            targetId: t.id,
            targetLabel: `#${t.number} ${t.subject}`.slice(0, 200),
            details: {
              number: t.number,
              changed: copied,
              ...(left.custom_fields ? { fields: Object.keys(left.custom_fields) } : {}),
              automation: rule.id,
              automation_name: rule.name,
              via: "automation",
            },
          });
        }
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logEvent("warn", "helpdesk.automation_patch_refused", { automation: rule.id, error: msg });
        const next = { ...left };
        // 1.20.5: a "Before you solve" requirement set refuses the solve the same way (lib/helpdesk/solve-requirements).
        // 1.20.6: a category that left the list since the rule was saved (lib/helpdesk/categories) drops the category alone.
        const code = (e as { extra?: { code?: unknown } }).extra?.code;
        if (code === "category_not_listed" || code === "subcategory_not_listed") {
          delete next.category;
          delete next.subcategory;
        } else if ((await import("./checklists-shared")).isChecklistBlock(msg) || (await import("./solve-requirements-shared")).isSolveRequirementBlock(msg)) delete next.status;
        else {
          delete next.assignee_id;
          delete next.team_id;
          // 1.20.33: values copied into custom fields were checked before (bodyFindings); one refused now (a field
          // changed meanwhile) goes last, so the rest still applies.
          if (Object.keys(next).length === Object.keys(left).length && next.custom_fields) {
            delete next.custom_fields;
            skipped.push(`couldn't copy into a custom field: ${lowerFirst(msg)}`);
          }
        }
        if (Object.keys(next).length === Object.keys(left).length) throw e;
        left = next;
      }
    }
  }
  if (a.internal_note) {
    const { addMessage } = await import("./messages");
    await addMessage(
      t.id,
      { kind: "internal", body: a.internal_note, author: { id: null, name: actor.name, email: "" }, via: "system", asRequester: false },
      ctx
    );
    acted = true;
  }
  // 1.20.23 review M4 (c): a macro no longer of the rule's desk department (or All departments), say
  // after an Admin moved it, is skipped, with a note on the ticket and a log line; the rest runs.
  const macroDept = a.macro_id ? await hqOne<{ d: number | null }>("SELECT desk_department_id AS d FROM hd_macros WHERE id = $1", [a.macro_id]) : undefined;
  const { fitsDept } = await import("./desk-departments");
  // (A rule read without its department, undefined, is not checked; a stored rule always has the column.)
  if (a.macro_id && macroDept && rule.desk_department_id !== undefined && !fitsDept(macroDept.d, rule.desk_department_id)) {
    logEvent("warn", "helpdesk.automation_macro_skipped", { automation: rule.id, ticket_id: t.id, macro: a.macro_id, reason: "desk_department" });
    const { addMessage } = await import("./messages");
    await addMessage(
      t.id,
      {
        kind: "internal",
        body: `The automation "${rule.name}" skipped its macro reply: the macro is no longer in the rule's desk department. Ask a desk admin to pick another macro for the rule.`,
        author: { id: null, name: actor.name, email: "" },
        via: "system",
        asRequester: false,
      },
      ctx
    );
  } else if (a.macro_id) {
    const { applyMacroToTicket } = await import("./macros");
    // 1.20.20: set off by an agent's action (not the requester's, not the system's): the macro's reply meets the reply
    // lock as that agent's (lib/helpdesk/reply-lock). Refused, the rest of the rule still runs.
    const lockAs = await agentWhoSetItOff(triggeredBy, t);
    try {
      const r = await applyMacroToTicket(t.id, a.macro_id, { id: null, name: actor.name, email: "" }, { fromAutomation: true, lockAs });
      if (r.ok) acted = true;
    } catch (e) {
      if (!(e instanceof Error && (e as { extra?: { code?: unknown } }).extra?.code === "reply_locked")) throw e;
      logEvent("info", "helpdesk.automation_reply_locked", { automation: rule.id, ticket_id: t.id });
    }
  }
  if (a.notify) {
    const { notifyFromAutomation } = await import("./notify");
    await notifyFromAutomation(t.id, a.notify, rule.name);
    acted = true;
  }
  if (skipped.length) await recordSkips(rule, t.id, skipped);
  return acted;
}

/**
 * 1.20.33 (review L3): whether the acknowledgement to `email`, a requester rule `ruleId` took from the message, is
 * held: past REQUESTER_ACK_LIMITS for that address in a day, or for that rule in an hour (lib/helpdesk/access
 * hdRateLimited, per app process). The sentence noted on the ticket, or null.
 */
export async function requesterAckHeld(ruleId: number, email: string): Promise<string | null> {
  const { hdRateLimited } = await import("./access");
  const key = email.trim().toLowerCase();
  const perAddress = hdRateLimited(`automation-ack:address:${key}`, REQUESTER_ACK_LIMITS.perAddressPerDay, 86_400_000);
  const perRule = hdRateLimited(`automation-ack:rule:${ruleId}`, REQUESTER_ACK_LIMITS.perRulePerHour, 3_600_000);
  if (perAddress) return `held the acknowledgment to ${key}: more than ${REQUESTER_ACK_LIMITS.perAddressPerDay} requests a day set it as the requester from a message`;
  if (perRule) return `held the acknowledgment to ${key}: this rule set more than ${REQUESTER_ACK_LIMITS.perRulePerHour} requesters from a message in the last hour`;
  return null;
}

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s).replace(/\.$/, "");

/**
 * 1.20.33: what a rule couldn't do, as one agents-only activity line per reason ("Automation: X couldn't change the
 * requester: …"), the way updateTicket writes a change (event 'change', via 'system'). Written once per ticket and
 * reason, so a ticket_updated rule doesn't repeat it on every update. Never counts as the rule running.
 */
async function recordSkips(rule: HdAutomation, ticketId: number, reasons: string[]): Promise<void> {
  const author = `Automation: ${rule.name}`;
  for (const why of [...new Set(reasons)]) {
    const body = `${mdInline(author)} ${mdInline(why)}`;
    logEvent("info", "helpdesk.automation_action_skipped", { automation: rule.id, ticket_id: ticketId, why: why.slice(0, 300) });
    try {
      const had = await hqOne("SELECT 1 FROM hd_messages WHERE ticket_id = $1 AND kind = 'internal' AND author_name = $2 AND body = $3 LIMIT 1", [ticketId, author, body]);
      if (had) continue;
      await hq(`INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, event) VALUES ($1, NULL, $2, 'internal', $3, 'system', $4)`, [
        ticketId,
        author,
        body,
        HD_CHANGE_EVENT,
      ]);
    } catch (e) {
      logEvent("error", "helpdesk.automation_failed", { automation: rule.id, ticket_id: ticketId, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** 1.20.33: who "from the message" would make the requester, or why it does nothing. */
type FromMessage = { kind: "found"; who: ResolvedRequester } | { kind: "skip"; why: string } | { kind: "not_in_scope" };

/**
 * 1.20.33: the address a "from the message" action picks on this ticket, as resolveRequester takes it, or why it
 * does nothing. One candidate only (review L1): the topmost line that starts with a label (or the first address, for
 * "first"); if that one may not be used, nothing else is tried and the reason is noted.
 */
export async function requesterFromMessage(m: HdAutomationRequesterFromMessage, target: MatchTarget, t: Pick<HdTicketRow, "id" | "requester_id" | "requester_email">): Promise<FromMessage> {
  const sender = target.sender;
  // Only a message whose actual sender is on the list (the forwarder): anyone else's "From:" moves nothing.
  if (!sender?.email || !senderInScope(sender.email, m.senders)) return { kind: "not_in_scope" };
  const no = (why: string): FromMessage => ({ kind: "skip", why: `couldn't change the requester: ${why}` });
  if (sender.imported) return no(`the message from ${sender.email} was imported, so its sender was never checked`);
  if (sender.verified === false) return no(`the message from ${sender.email} didn't pass the sender check (SPF, DKIM or DMARC aligned with its From)`);
  // An email whose sender check wasn't recorded (it came in before 1.20.33) is not trusted either.
  if (sender.byEmail && sender.verified === null) return no(`the email from ${sender.email} came in before its sender check was recorded`);
  const labels = m.labels?.length ? m.labels : DEFAULT_REQUESTER_LABELS;
  const c = requesterCandidate(target.text ?? target.body, m.find, labels);
  if (!c.address) {
    return no(m.find === "first" ? "no email address in the message" : c.label ? `no email address after "${c.label}" on its line` : `no line starts with ${orList(labels.map((l) => `"${l}"`))}`);
  }
  const f = c.address;
  const { ownDeskAddressMatcher, deskAgentAddressMatcher, resolveRequester } = await import("./requester-change");
  if (f.email === sender.email) return no(`${f.email} is the sender's own address`);
  if ((await ownDeskAddressMatcher())(f.email)) return no(`${f.email} is one of the desk's own addresses`);
  if (m.domains?.length && !addressAtDomain(f.email, m.domains)) return no(`${f.email} isn't at ${orList(m.domains)}`);
  // Desk agents, unless the rule allows them: any address a desk agent has here (their account's, their directory
  // entry's and its aliases), compared without a "+tag" and in any case (review L7).
  if (!m.allow_agents && (await deskAgentAddressMatcher())(f.email)) return no(`${f.email} belongs to a desk agent`);
  const r = await resolveRequester({ email: f.email, name: f.name });
  if (r.ok) return { kind: "found", who: r.who };
  return no(r.code === "outside_not_allowed" ? `nobody in the workspace has ${f.email}, and outside senders aren't accepted` : lowerFirst(r.error));
}

/** 1.20.33 (review M3): the events a rule may change the requester on. Others re-read the opening message on every edit. */
export const REQUESTER_ACTION_EVENTS: readonly HdAutomationEvent[] = ["ticket_created", "requester_message"];

export const REQUESTER_EVENT_REFUSED =
  'Change the requester only on "A ticket is created" or "The requester sends a message". On other events the rule would read the opening message again after every change, and undo an agent\'s correction.';

/** 1.20.33 (review L3): acknowledgements to a requester a rule took from the message, at most this many. */
export const REQUESTER_ACK_LIMITS = {
  /** To one address, per day. */
  perAddressPerDay: 5,
  /** From one rule, per hour. */
  perRulePerHour: 60,
} as const;

/** 1.20.33: what a rule's requester and copy actions find on this ticket (for effectivePatch); what they can't do goes in `skipped`. */
async function bodyFindings(rule: HdAutomation, t: HdTicketRow, target: MatchTarget, skipped: string[]): Promise<RuleFindings> {
  const a = rule.actions ?? {};
  const out: RuleFindings = {};
  const changesRequester = !!(a.requester_set || a.requester_from_message);
  if (changesRequester && !REQUESTER_ACTION_EVENTS.includes(rule.event)) {
    // Refused at save since 1.20.33 (review M3); a row from before is never run.
    logEvent("info", "helpdesk.automation_action_skipped", { automation: rule.id, ticket_id: t.id, why: `requester action on ${rule.event}` });
  } else if (changesRequester && t.requester_set_by_agent_at) {
    // An agent set this ticket's requester by hand: rules never change it again (review M3 b).
    skipped.push("couldn't change the requester: an agent set it by hand, so rules leave it as it is");
  } else if (a.requester_set) {
    const { resolveRequester } = await import("./requester-change");
    const r = await resolveRequester(a.requester_set.user_id ? { user_id: a.requester_set.user_id } : { email: a.requester_set.email, name: a.requester_set.name });
    if (r.ok) out.requester = r.who;
    else skipped.push(`couldn't change the requester: ${lowerFirst(r.error)}`);
  } else if (a.requester_from_message) {
    const r = await requesterFromMessage(a.requester_from_message, target, t);
    if (r.kind === "found") out.requester = r.who;
    else if (r.kind === "skip") skipped.push(r.why);
    else logEvent("info", "helpdesk.automation_action_skipped", { automation: rule.id, ticket_id: t.id, why: "sender not in scope" });
  }
  const copies = a.copy_values ?? [];
  if (!copies.length) return out;
  const text = target.text ?? target.body;
  // The fields of the team the rule leaves the ticket in (a rule that moves it fills the new team's fields).
  const teamAfter = a.team_id !== undefined ? a.team_id : t.team_id;
  const keys = [...new Set(copies.map((c) => c.field_key).filter((k): k is string => !!k))];
  const { customFieldsSnapshot, customFieldApplies } = await import("./custom-fields");
  const defs = keys.length ? (await customFieldsSnapshot()).filter((f) => keys.includes(f.key)) : [];
  const now = new Map<string, HdCustomValue>();
  if (keys.length) {
    for (const r of await hq<{ key: string; value: HdCustomValue }>(
      "SELECT f.key, v.value FROM hd_ticket_custom_values v JOIN hd_custom_fields f ON f.id = v.field_id WHERE v.ticket_id = $1 AND f.key = ANY($2::text[])",
      [t.id, keys]
    )) {
      now.set(r.key, r.value);
    }
  }
  const tags: string[] = [];
  const custom: Record<string, HdCustomValue> = {};
  for (const c of copies) {
    const value = extractCopyValue(c, t.subject, text);
    if (value === null) continue; // Nothing to copy on this ticket: not a failure.
    if (c.tag) {
      const tag = cleanTags([value]);
      if (!tag || !tag.length) skipped.push(`couldn't add "${value.slice(0, 60)}" as a tag: a tag is one short word (letters, digits, - _ . :)`);
      else tags.push(tag[0]);
      continue;
    }
    const def = defs.find((d) => d.key === c.field_key);
    if (!def || def.archived) {
      skipped.push(`couldn't copy "${value.slice(0, 60)}": the custom field ${c.field_key} is ${def ? "archived" : "gone"}`);
      continue;
    }
    if (!customFieldApplies(def, teamAfter)) {
      logEvent("info", "helpdesk.automation_action_skipped", { automation: rule.id, ticket_id: t.id, why: `field ${def.key} is not one of the team's` });
      continue;
    }
    if (c.only_if_empty !== false && now.has(def.key) && now.get(def.key) !== null && now.get(def.key) !== "") continue;
    const fit = fitFieldValue(def, value);
    if (!fit.ok) {
      skipped.push(`couldn't copy into ${def.label}: ${fit.why}`);
      continue;
    }
    let v: HdCustomValue = fit.value;
    if (def.type === "user") {
      const u = await hqOne<{ id: number }>("SELECT id FROM users WHERE lower(email) = $1 AND status = 'active' ORDER BY id LIMIT 1", [String(fit.value)]);
      if (!u) {
        skipped.push(`couldn't copy into ${def.label}: nobody in the workspace has the address ${String(fit.value)}`);
        continue;
      }
      v = u.id;
    }
    // Two copies into one field: the first that found a value wins.
    if (!(def.key in custom)) custom[def.key] = v;
  }
  if (tags.length) out.tags = tags;
  if (Object.keys(custom).length) {
    out.custom = custom;
    out.customNow = Object.fromEntries(now);
  }
  return out;
}

/** For tests: whether a run is inside a rule chain right now. */
export function currentChainDepth(): number | null {
  return chainStore.getStore()?.depth ?? null;
}
