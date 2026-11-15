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
// Server-only.

import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { hq, hqOne, withTx } from "./db-core";
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
  HdAutomationDraft,
  HdAutomationConditions,
  HdAutomationEvent,
  HdPriority,
  HdSource,
  HdStatus,
  HdTicketPatch,
  HdTicketRow,
} from "./types";

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

export const AUTOMATION_LIMITS = { name: 120, rules: 200, list: 50, keyword: 60, note: 5000, category: 80 } as const;

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
  return true;
}

/** The field changes a rule would make to this ticket, without the ones it already has. */
export function effectivePatch(
  a: HdAutomationActions,
  t: Pick<HdTicketRow, "team_id" | "assignee_id" | "priority" | "status" | "category" | "tags"> & { subcategory?: string }
): HdTicketPatch {
  const p: HdTicketPatch = {};
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
  if (a.tags_add?.length) {
    const next = [...t.tags];
    for (const tag of a.tags_add) if (!next.includes(tag)) next.push(tag);
    if (next.length !== t.tags.length) p.tags = next;
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

function strList(raw: unknown, max: number, what: string): Checked<string[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.length > AUTOMATION_LIMITS.list) return { ok: false, error: `${what} must be a list.` };
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") return { ok: false, error: `${what} must be words.` };
    const s = v.trim();
    if (!s) continue;
    if (s.length > max) return { ok: false, error: `Keep each of ${what.toLowerCase()} under ${max} characters.` };
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return { ok: true, value: out.length ? out : undefined };
}

export function validateConditions(raw: unknown): Checked<HdAutomationConditions> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Conditions must be an object." };
  const c = raw as Record<string, unknown>;
  const known = ["team_ids", "categories", "subcategories", "priorities", "request_type_ids", "keywords", "sources"];
  for (const k of Object.keys(c)) if (!known.includes(k)) return { ok: false, error: `Unknown condition: ${k}.` };
  const out: HdAutomationConditions = {};
  const steps: [keyof HdAutomationConditions, Checked<unknown>][] = [
    ["team_ids", idList(c.team_ids, "Teams")],
    ["request_type_ids", idList(c.request_type_ids, "Request types")],
    ["priorities", enumList(c.priorities, HD_PRIORITIES, "Priorities")],
    ["sources", enumList(c.sources, HD_SOURCES, "Sources")],
    ["categories", strList(c.categories, AUTOMATION_LIMITS.category, "Categories")],
    ["keywords", strList(c.keywords, AUTOMATION_LIMITS.keyword, "Keywords")],
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
  const known = ["team_id", "assignee_id", "priority", "status", "category", "subcategory", "tags_add", "internal_note", "macro_id", "notify"];
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

/** Validate a create (or, `partial`, an update) body, checking that named teams, people, macros and request types exist. */
export async function validateAutomationInput(raw: Record<string, unknown>, partial = false): Promise<Checked<Partial<AutomationInput>>> {
  const out: Partial<AutomationInput> = {};
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
  // References must exist.
  const teamIds = [...(out.conditions?.team_ids ?? []), ...(out.actions?.team_id ? [out.actions.team_id] : [])];
  if (teamIds.length) {
    const n = await hq("SELECT id FROM hd_teams WHERE id = ANY($1)", [teamIds]);
    if (n.length !== new Set(teamIds).size) return { ok: false, error: "Unknown team." };
  }
  if (out.conditions?.request_type_ids?.length) {
    const n = await hq("SELECT id FROM hd_request_types WHERE id = ANY($1)", [out.conditions.request_type_ids]);
    if (n.length !== out.conditions.request_type_ids.length) return { ok: false, error: "Unknown request type." };
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
  const people = [out.actions?.assignee_id, typeof out.actions?.notify === "object" ? out.actions.notify.user_id : undefined].filter((x): x is number => !!x);
  if (people.length) {
    const n = await hq("SELECT id FROM users WHERE id = ANY($1) AND status = 'active'", [people]);
    if (n.length !== new Set(people).size) return { ok: false, error: "Unknown person." };
  }
  return { ok: true, value: out };
}

// --- Storage ---------------------------------------------------------------------

// 1.20.16: with the draft columns (Claude's drafts).
const COLS = `id, name, event, conditions, actions, active, position, created_at, updated_at, last_run_at, ${DRAFT_COLS_SQL}`;

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

export async function createAutomation(input: AutomationInput): Promise<HdAutomation> {
  const n = await hqOne<{ n: number; max: number | null }>("SELECT count(*)::int AS n, max(position) AS max FROM hd_automations");
  if ((n?.n ?? 0) >= AUTOMATION_LIMITS.rules) throw new AutomationLimitError(`A workspace can keep up to ${AUTOMATION_LIMITS.rules} automations.`);
  const position = input.position ?? (n?.max ?? -1) + 1;
  return (await hqOne<HdAutomation>(
    `INSERT INTO hd_automations (name, event, conditions, actions, active, position) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
    [input.name, input.event, JSON.stringify(input.conditions), JSON.stringify(input.actions), input.active, position]
  ))!;
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
  opts: { publish?: boolean; publishDraft?: boolean; draftAt?: unknown } = {}
): Promise<{ before: HdAutomation; after: HdAutomation; published: boolean } | undefined> {
  return withTx(async (client) => {
    const cur = await hqOne<HdAutomation>(`SELECT ${COLS} FROM hd_automations WHERE id = $1 FOR UPDATE`, [id], client);
    if (!cur) return undefined;
    const publish = opts.publish === true && !cur.published;
    const publishDraft = opts.publishDraft === true;
    if (publishDraft && !(cur.published && cur.draft)) throw new AutomationDraftError(NO_CHANGES_WAITING, 409);
    if ((publish || publishDraft) && !sameDraftInstant(cur.draft_at, opts.draftAt)) throw new AutomationDraftError(STALE_DRAFT_MESSAGE, 409);
    // The draft is the base only when publishing it; otherwise the copy the row holds.
    const base = publishDraft ? { ...cur, ...cur.draft! } : cur;
    let next: HdAutomation = { ...base, ...patch } as HdAutomation;
    if (publish || publishDraft) {
      const full = await validateAutomationInput({ name: next.name, event: next.event, conditions: next.conditions, actions: next.actions });
      if (!full.ok) throw new AutomationDraftError(full.error, 400);
      next = { ...next, ...full.value, active: next.active, position: next.position } as HdAutomation;
    }
    let active = next.active;
    if (!cur.published && !publish) {
      // Only a person's publish switches a draft on.
      if (patch.active === 1) throw new AutomationDraftError("This rule is a draft from Claude. Publish it to switch it on.", 409);
      active = 0;
    } else if (publish) active = patch.active === 0 ? 0 : 1;
    const after = await hqOne<HdAutomation>(
      `UPDATE hd_automations SET name = $2, event = $3, conditions = $4, actions = $5, active = $6, position = $7, updated_at = now()${
        publish ? ", published = 1" : ""
      }${publish || publishDraft ? `, ${CLEAR_DRAFT_SQL}` : ""}
        WHERE id = $1 RETURNING ${COLS}`,
      [id, next.name, next.event, JSON.stringify(next.conditions ?? {}), JSON.stringify(next.actions ?? {}), active, next.position],
      client
    );
    return after ? { before: cur, after, published: publish || publishDraft } : undefined;
  });
}

/**
 * 1.20.16: check an automation draft as Desk settings would, without saving
 * it (the connector's hd_draft_automation and Claude in the desk's card).
 * With `base` (an existing rule's draft or live copy), fields not sent come
 * from it. Answers the rule in the shape the list stores.
 */
export async function checkAutomationDraft(raw: unknown, base?: HdAutomationDraft): Promise<HdAutomationDraft> {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    name: r.name ?? base?.name,
    event: r.event ?? base?.event,
    conditions: r.conditions ?? base?.conditions,
    actions: r.actions ?? base?.actions,
  };
  const v = await validateAutomationInput(merged);
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
  id?: number
): Promise<{ automation: HdAutomation; kind: "new" | "replaced" | "changes" }> {
  const meta = [actor.id, actor.name, actor.via];
  if (id === undefined) {
    const input = await checkAutomationDraft(raw);
    return withTx(async (client) => {
      await client.query("LOCK TABLE hd_automations IN SHARE ROW EXCLUSIVE MODE");
      const n = await hqOne<{ n: number; max: number | null }>("SELECT count(*)::int AS n, max(position) AS max FROM hd_automations", [], client);
      if ((n?.n ?? 0) >= AUTOMATION_LIMITS.rules) throw new AutomationDraftError(`A workspace can keep up to ${AUTOMATION_LIMITS.rules} automations.`, 409);
      const a = await hqOne<HdAutomation>(
        `INSERT INTO hd_automations (name, event, conditions, actions, active, position, published, draft_by, draft_by_name, draft_at, draft_via)
         VALUES ($1, $2, $3, $4, 0, $5, 0, $6, $7, now(), $8) RETURNING ${COLS}`,
        [input.name, input.event, JSON.stringify(input.conditions), JSON.stringify(input.actions), (n?.max ?? -1) + 1, ...meta],
        client
      );
      return { automation: a!, kind: "new" as const };
    });
  }
  // Checked against the row as it is now (outside the lock: validation reads other tables), then again under it.
  const peek = await getAutomation(id);
  if (!peek) throw new AutomationDraftError(`No automation with id ${id}.`, 404);
  const input = await checkAutomationDraft(raw, peek.draft ?? draftOf(peek));
  return withTx(async (client) => {
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
      `UPDATE hd_automations SET draft = $2, draft_by = $3, draft_by_name = $4, draft_at = now(), draft_via = $5 WHERE id = $1 RETURNING ${COLS}`,
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
  return withTx(async (client) => {
    const before = await hqOne<HdAutomation>(`SELECT ${COLS} FROM hd_automations WHERE id = $1 FOR UPDATE`, [id], client);
    if (!before || !before.published || !before.draft) return undefined;
    if (draftAt !== undefined && draftAt !== null && !sameDraftInstant(before.draft_at, draftAt)) throw new AutomationDraftError(STALE_DISCARD_MESSAGE, 409);
    await client.query(`UPDATE hd_automations SET ${CLEAR_DRAFT_SQL} WHERE id = $1`, [id]);
    return before;
  });
}

export async function deleteAutomation(id: number): Promise<HdAutomation | undefined> {
  return hqOne<HdAutomation>(`DELETE FROM hd_automations WHERE id = $1 RETURNING ${COLS}`, [id]);
}

/**
 * 1.20.16: a rule in plain words, for Claude's hd_list_automations and the
 * draft cards ("When a ticket is created", "If the team is IT and it
 * mentions "vpn"", "Then set the priority to High"). Names are looked up.
 */
export async function automationInWords(a: Pick<HdAutomation, "event" | "conditions" | "actions">): Promise<{ when: string; if: string[]; then: string[] }> {
  const c = a.conditions ?? {};
  const x = a.actions ?? {};
  const teamIds = [...(c.team_ids ?? []), ...(x.team_id ? [x.team_id] : [])];
  const teams = new Map((teamIds.length ? await hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams WHERE id = ANY($1::int[])", [teamIds]) : []).map((t) => [t.id, t.name]));
  const types = new Map(
    (c.request_type_ids?.length ? await hq<{ id: number; title: string }>("SELECT id, title FROM hd_request_types WHERE id = ANY($1::int[])", [c.request_type_ids]) : []).map((t) => [t.id, t.title])
  );
  const people = [x.assignee_id, typeof x.notify === "object" ? x.notify.user_id : undefined].filter((n): n is number => !!n);
  const names = new Map(
    (people.length ? await hq<{ id: number; name: string }>("SELECT id, COALESCE(NULLIF(name, ''), username) AS name FROM users WHERE id = ANY($1::int[])", [people]) : []).map((u) => [u.id, u.name])
  );
  const macro = x.macro_id ? await hqOne<{ title: string }>("SELECT title FROM hd_macros WHERE id = $1", [x.macro_id]).catch(() => undefined) : undefined;
  const { HD_PRIORITY_LABEL, HD_SOURCE_LABEL, HD_STATUS_LABEL } = await import("./types");
  const or = (xs: string[]) => xs.join(" or ");
  const when = HD_AUTOMATION_EVENT_LABEL[a.event] ?? a.event;
  const ifs: string[] = [];
  if (c.team_ids?.length) ifs.push(`the team is ${or(c.team_ids.map((id) => teams.get(id) ?? `team ${id}`))}`);
  const cats = [...(c.categories ?? []), ...(c.subcategories ?? []).map((p) => `${p.category} › ${p.subcategory}`)];
  if (cats.length) ifs.push(`the category is ${or(cats)}`);
  if (c.priorities?.length) ifs.push(`the priority is ${or(c.priorities.map((p) => HD_PRIORITY_LABEL[p]))}`);
  if (c.request_type_ids?.length) ifs.push(`the request type is ${or(c.request_type_ids.map((id) => types.get(id) ?? `request type ${id}`))}`);
  if (c.sources?.length) ifs.push(`it came in through ${or(c.sources.map((s) => HD_SOURCE_LABEL[s]))}`);
  if (c.keywords?.length) ifs.push(`it mentions ${or(c.keywords.map((k) => `"${k}"`))}`);
  const then: string[] = [];
  if (x.team_id) then.push(`move it to ${teams.get(x.team_id) ?? `team ${x.team_id}`}`);
  if (x.assignee_id) then.push(`assign it to ${names.get(x.assignee_id) ?? `person ${x.assignee_id}`}`);
  if (x.priority) then.push(`set the priority to ${HD_PRIORITY_LABEL[x.priority]}`);
  if (x.status) then.push(`set the status to ${HD_STATUS_LABEL[x.status]}`);
  if (x.category) then.push(`set the category to ${x.subcategory ? `${x.category} › ${x.subcategory}` : x.category}`);
  if (x.tags_add?.length) then.push(`add the ${x.tags_add.length === 1 ? "tag" : "tags"} ${x.tags_add.join(", ")}`);
  if (x.internal_note) then.push("add an internal note");
  if (x.macro_id) then.push(`send the macro reply "${macro?.title ?? x.macro_id}"`);
  if (x.notify === "assignee") then.push("notify the owner");
  else if (x.notify === "team") then.push("notify the team");
  else if (x.notify) then.push(`notify ${names.get(x.notify.user_id) ?? "one person"}`);
  return { when, if: ifs.length ? ifs : ["any ticket"], then };
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

async function matchTarget(event: HdAutomationEvent, t: HdTicketRow): Promise<MatchTarget> {
  // The body: the requester's latest public message for requester_message,
  // otherwise the opening message.
  const msg =
    event === "requester_message"
      ? await hqOne<{ body: string }>(
          `SELECT body FROM hd_messages WHERE ticket_id = $1 AND kind = 'public'
              AND (author_id = $2 OR ($2::int IS NULL AND lower(author_email) = lower($3)))
            ORDER BY created_at DESC, id DESC LIMIT 1`,
          [t.id, t.requester_id, t.requester_email]
        )
      : await hqOne<{ body: string }>(
          "SELECT body FROM hd_messages WHERE ticket_id = $1 AND kind <> 'system' ORDER BY created_at, id LIMIT 1",
          [t.id]
        );
  return {
    team_id: t.team_id,
    category: t.category,
    subcategory: t.subcategory ?? "",
    priority: t.priority,
    request_type_id: t.request_type_id,
    source: t.source,
    subject: t.subject,
    body: msg?.body ?? "",
  };
}

/**
 * Run the active rules of `event` on one ticket (after the write that
 * caused it committed). Never throws: a failing rule is logged and the next
 * one runs.
 */
export async function runAutomations(event: HdAutomationEvent, ticketId: number): Promise<RunResult> {
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
    for (const rule of rules) {
      const key = `${rule.id}:${ticketId}`;
      if (chain.fired.has(key)) continue;
      try {
        const t = await hqOne<HdTicketRow>("SELECT * FROM hd_tickets WHERE id = $1", [ticketId]);
        if (!t) break;
        if (!automationMatches(rule.conditions ?? {}, await matchTarget(event, t))) continue;
        const acted = await applyRule(rule, t);
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

/** Apply one rule's actions. Answers whether it did anything. Exported for tests (1.19.2, W3). */
export async function applyRule(rule: HdAutomation, t: HdTicketRow): Promise<boolean> {
  const a = rule.actions ?? {};
  const patch = effectivePatch(a, t);
  const actor = { id: null, name: `Automation: ${rule.name}` };
  const ctx = { fromAutomation: true, actorName: actor.name };
  let acted = false;
  if (Object.keys(patch).length) {
    const { updateTicket } = await import("./tickets");
    // Refusals peel off only what was refused, then the rest applies: a blocked
    // solve (1.19.2, required checklist items, agent W3) drops the status alone;
    // an assignee who is not on the team, or a team that was deleted, drops the
    // assignee and team. At most three tries (each drops something).
    let left: typeof patch = { ...patch };
    for (let attempt = 0; attempt < 3 && Object.keys(left).length; attempt++) {
      try {
        await updateTicket(t.id, left, actor, ctx);
        acted = true;
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
  if (a.macro_id) {
    const { applyMacroToTicket } = await import("./macros");
    const r = await applyMacroToTicket(t.id, a.macro_id, { id: null, name: actor.name, email: "" }, { fromAutomation: true });
    if (r.ok) acted = true;
  }
  if (a.notify) {
    const { notifyFromAutomation } = await import("./notify");
    await notifyFromAutomation(t.id, a.notify, rule.name);
    acted = true;
  }
  return acted;
}

/** For tests: whether a run is inside a rule chain right now. */
export function currentChainDepth(): number | null {
  return chainStore.getStore()?.depth ?? null;
}
