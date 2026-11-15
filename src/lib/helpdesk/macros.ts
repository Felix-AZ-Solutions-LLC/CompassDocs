// Helpdesk macros (1.19.0): canned replies with placeholders and optional
// field changes. An agent picks one in the composer ("/" or the Macro
// button): the preview fills the placeholders for that ticket and the agent
// edits before sending, or the macro is applied in one go (POST
// /api/helpdesk/tickets/[n]/macro/[id]), which posts the reply and makes
// the field changes. Automations apply macros the same way.
//
// Placeholders (unknown ones stay visible, like the email templates'):
//   {{requester.first_name}} {{requester.name}} {{requester.email}}
//   {{ticket.number}} {{ticket.subject}} {{ticket.status}} {{ticket.priority}}
//   {{ticket.url}} (the requester's link) {{team.name}}
//   {{agent.first_name}} {{agent.name}} {{agent.email}} {{org.name}}
// Values are names and subjects people typed, so each is escaped for the
// markdown the body is: "*Bob*" stays those characters in the reply.
//
// Visibility: a macro with no team is everyone's; a team macro is its
// team's (and every agent_all agent's).
//
// 1.20.15: applying as an agent is one library function, applyMacroAs,
// which the desk's route (POST …/macro/[id]) and Claude share: the same
// checks in the same order (the recycle bin, works the ticket, Use macros
// in its team, the macro's scope, closed and merged, the send guard, the
// reply and field-change capabilities, a workflow task's hand-off,
// required checklist items and "Before you solve", newbie review). The
// Claude connector's hd_apply_macro saves the macro's reply as a reply
// DRAFT instead of sending it (its rule: replies are drafts only), so the
// macro's status change is not made (an agent sets it after sending the
// reply), as for a reply held for review. A change
// through Claude is audited (helpdesk.macro.applied, via "mcp" or
// "claude_desk") and its timeline lines say "via Claude".
// Server-only.

import "server-only";
import { hq, hqOne } from "./db-core";
import { mdInline } from "./md-inline";
import { HD_PRIORITIES, HD_PRIORITY_LABEL, HD_STATUSES, HD_STATUS_LABEL_REQUESTER } from "./types";
import type { HdMacro, HdMacroActions, HdPriority, HdStatus } from "./types";

export const MACRO_LIMITS = { title: 120, body: 20_000, tags: 20, tag: 40, macros: 500 } as const;

// --- Placeholders ----------------------------------------------------------------

export interface MacroContext {
  requester: { name: string; email: string };
  ticket: { number: number; subject: string; status: HdStatus; priority: HdPriority };
  team: { name: string };
  agent: { name: string; email: string };
  org: { name: string };
  /** Absolute origin for {{ticket.url}} ('' = relative). */
  origin?: string;
}

/** The placeholders the composer's help lists. */
export const MACRO_PLACEHOLDERS: { tag: string; label: string }[] = [
  { tag: "requester.first_name", label: "Requester's first name" },
  { tag: "requester.name", label: "Requester's full name" },
  { tag: "requester.email", label: "Requester's email" },
  { tag: "ticket.number", label: "Ticket number" },
  { tag: "ticket.subject", label: "Ticket subject" },
  { tag: "ticket.status", label: "Ticket status (as the requester reads it)" },
  { tag: "ticket.priority", label: "Ticket priority" },
  { tag: "ticket.url", label: "Link to the request in Get help" },
  { tag: "team.name", label: "Team" },
  { tag: "agent.first_name", label: "Your first name" },
  { tag: "agent.name", label: "Your full name" },
  { tag: "agent.email", label: "Your email" },
  { tag: "org.name", label: "Workspace name" },
];

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

/**
 * One inline value escaped for markdown (no line breaks survive): lib/helpdesk/md-inline,
 * so a subject or name can't become a link (www. and addresses too), a directive, emphasis
 * or code, or a heading or list at the start of a line (1.19.4 review).
 */
export function escapeInline(s: string): string {
  return mdInline(s);
}

/** Fill a macro body for one ticket. Pure. */
export function renderMacro(body: string, ctx: MacroContext): string {
  const values: Record<string, string> = {
    "requester.first_name": escapeInline(firstName(ctx.requester.name) || "there"),
    "requester.name": escapeInline(ctx.requester.name || "there"),
    "requester.email": escapeInline(ctx.requester.email),
    "ticket.number": String(ctx.ticket.number),
    "ticket.subject": escapeInline(ctx.ticket.subject),
    "ticket.status": HD_STATUS_LABEL_REQUESTER[ctx.ticket.status] ?? ctx.ticket.status,
    "ticket.priority": HD_PRIORITY_LABEL[ctx.ticket.priority] ?? ctx.ticket.priority,
    "ticket.url": `${ctx.origin ?? ""}/help/requests/${ctx.ticket.number}`,
    "team.name": escapeInline(ctx.team.name),
    "agent.first_name": escapeInline(firstName(ctx.agent.name)),
    "agent.name": escapeInline(ctx.agent.name),
    "agent.email": escapeInline(ctx.agent.email),
    "org.name": escapeInline(ctx.org.name),
  };
  return body.replace(/\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/gi, (whole, tag: string) => {
    const key = tag.toLowerCase();
    return key in values ? values[key] : whole;
  });
}

/** The context for one ticket and one agent (by ids). */
export async function macroContext(ticketId: number, agent: { id: number | null; name: string; email?: string }, origin = ""): Promise<MacroContext | null> {
  const t = await hqOne<{
    number: number;
    subject: string;
    status: HdStatus;
    priority: HdPriority;
    requester_name: string;
    requester_email: string;
    team_name: string | null;
  }>(
    `SELECT t.number, t.subject, t.status, t.priority, t.requester_name, t.requester_email, tm.name AS team_name
       FROM hd_tickets t LEFT JOIN hd_teams tm ON tm.id = t.team_id WHERE t.id = $1`,
    [ticketId]
  );
  if (!t) return null;
  let agentEmail = agent.email ?? "";
  if (!agentEmail && agent.id) {
    agentEmail = (await hqOne<{ email: string }>("SELECT email FROM users WHERE id = $1", [agent.id]))?.email ?? "";
  }
  let org = "CompassDocs";
  try {
    const { getAppSettings } = await import("../settings-store");
    org = (await getAppSettings()).company_name || org;
  } catch {
    /* default name */
  }
  return {
    requester: { name: t.requester_name, email: t.requester_email },
    ticket: { number: t.number, subject: t.subject, status: t.status, priority: t.priority },
    team: { name: t.team_name ?? "" },
    agent: { name: agent.name, email: agentEmail },
    org: { name: org },
    origin,
  };
}

// --- Validation ------------------------------------------------------------------

export interface MacroInput {
  title: string;
  body: string;
  actions: HdMacroActions;
  team_id: number | null;
  /** A personal macro (the route sets owner_id to the caller); team_id is then ignored. */
  personal?: boolean;
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** Clean field-change actions (shared with automations' macro step). */
export function validateMacroActions(raw: unknown): Checked<HdMacroActions> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Actions must be an object." };
  const a = raw as Record<string, unknown>;
  const out: HdMacroActions = {};
  for (const k of Object.keys(a)) if (!["status", "priority", "team_id", "tags_add"].includes(k)) return { ok: false, error: `Unknown macro action: ${k}.` };
  if (a.status !== undefined && a.status !== null && a.status !== "") {
    if (!(HD_STATUSES as readonly string[]).includes(String(a.status))) return { ok: false, error: "Unknown status." };
    out.status = a.status as HdStatus;
  }
  if (a.priority !== undefined && a.priority !== null && a.priority !== "") {
    if (!(HD_PRIORITIES as readonly string[]).includes(String(a.priority))) return { ok: false, error: "Unknown priority." };
    out.priority = a.priority as HdPriority;
  }
  if (a.team_id !== undefined && a.team_id !== null && a.team_id !== "") {
    const id = Number(a.team_id);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Unknown team." };
    out.team_id = id;
  }
  if (a.tags_add !== undefined && a.tags_add !== null) {
    const tags = cleanTags(a.tags_add);
    if (!tags) return { ok: false, error: `Tags must be a list of up to ${MACRO_LIMITS.tags} short words.` };
    if (tags.length) out.tags_add = tags;
  }
  return { ok: true, value: out };
}

/** Lower-case, trimmed, de-duplicated tags; null when the shape is wrong. */
export function cleanTags(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MACRO_LIMITS.tags) return null;
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") return null;
    const tag = t.trim().toLowerCase().replace(/\s+/g, "-");
    if (!tag) continue;
    if (tag.length > MACRO_LIMITS.tag || !/^[\p{L}\p{N}_.:-]+$/u.test(tag)) return null;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

export async function validateMacroInput(raw: Record<string, unknown>, partial = false): Promise<Checked<Partial<MacroInput>>> {
  const out: Partial<MacroInput> = {};
  if (!partial || raw.title !== undefined) {
    if (typeof raw.title !== "string" || !raw.title.trim()) return { ok: false, error: "Give the macro a title." };
    if (raw.title.trim().length > MACRO_LIMITS.title) return { ok: false, error: `Keep the title under ${MACRO_LIMITS.title} characters.` };
    out.title = raw.title.trim();
  }
  if (!partial || raw.body !== undefined) {
    if (typeof raw.body !== "string") return { ok: false, error: "The reply must be text." };
    if (raw.body.length > MACRO_LIMITS.body) return { ok: false, error: "The reply is too long." };
    out.body = raw.body.replace(/\u0000/g, "");
  }
  if (!partial || raw.actions !== undefined) {
    const a = validateMacroActions(raw.actions);
    if (!a.ok) return a;
    out.actions = a.value;
  }
  if (!partial || raw.team_id !== undefined) {
    if (raw.team_id === null || raw.team_id === undefined || raw.team_id === "") out.team_id = null;
    else {
      const id = Number(raw.team_id);
      if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Unknown team." };
      out.team_id = id;
    }
  }
  if (raw.personal !== undefined) {
    if (typeof raw.personal !== "boolean") return { ok: false, error: "personal is true or false." };
    out.personal = raw.personal;
    if (raw.personal) out.team_id = null;
  }
  // Teams named must exist.
  const teamIds = [out.team_id, out.actions?.team_id].filter((x): x is number => typeof x === "number");
  if (teamIds.length) {
    const found = await hq<{ id: number }>("SELECT id FROM hd_teams WHERE id = ANY($1)", [teamIds]);
    if (found.length !== new Set(teamIds).size) return { ok: false, error: "Unknown team." };
  }
  if (out.body !== undefined && !out.body.trim() && out.actions && !Object.keys(out.actions).length) {
    return { ok: false, error: "A macro needs a reply, a field change or both." };
  }
  return { ok: true, value: out };
}

// --- Storage ---------------------------------------------------------------------
//
// Three scopes (agent J's capabilities decide who may write each):
//   personal   owner_id set: the owner's own, visible to nobody else
//              (macros.manage_personal)
//   team       team_id set: that team's agents (macros.manage_team in it)
//   everyone   neither (macros.manage_all)
// owner_id is added by lib/db's boot schema (the Helpdesk block carries the
// MACRO_SCHEMA statement below); this module runs no DDL of its own.

export const MACRO_SCHEMA = `
  ALTER TABLE hd_macros ADD COLUMN IF NOT EXISTS owner_id integer REFERENCES users(id) ON DELETE CASCADE;
  CREATE INDEX IF NOT EXISTS idx_hd_macros_owner ON hd_macros(owner_id) WHERE owner_id IS NOT NULL;
`;

let schemaReady: Promise<void> | null = null;
export function ensureMacroSchema(): Promise<void> {
  schemaReady ??= (async () => {
    try {
      // The boot schema (lib/db SCHEMA_SQL) applies MACRO_SCHEMA under its
      // lock with guarded ALTERs; raw DDL here would lock hd_macros on every
      // process start (review #32).
      const { dbReady } = await import("../db");
      await dbReady();
    } catch (e) {
      schemaReady = null;
      throw e;
    }
  })();
  return schemaReady;
}

export type MacroScope = "personal" | "team" | "everyone";

export type HdMacroRow = HdMacro & { owner_id: number | null; team_name?: string | null };

export function macroScope(m: { owner_id?: number | null; team_id: number | null }): MacroScope {
  if (m.owner_id) return "personal";
  return m.team_id ? "team" : "everyone";
}

const COLS = "id, title, body, actions, team_id, owner_id, created_by, created_at, updated_at";
const MCOLS = COLS.split(", ").map((c) => `m.${c}`).join(", ");

/**
 * Macros for a list. `teams` "all" = every shared macro; an array = the
 * everyone macros and those teams'. `ownerId` adds that person's personal
 * macros (nobody else's are ever listed).
 */
export async function listMacros(teams: number[] | "all" = "all", ownerId: number | null = null): Promise<(HdMacroRow & { scope: MacroScope })[]> {
  await ensureMacroSchema();
  const rows = await hq<HdMacroRow>(
    `SELECT ${MCOLS}, t.name AS team_name FROM hd_macros m LEFT JOIN hd_teams t ON t.id = m.team_id
      WHERE (m.owner_id IS NULL AND ($1::int[] IS NULL OR m.team_id IS NULL OR m.team_id = ANY($1::int[])))
         OR (m.owner_id IS NOT NULL AND m.owner_id = $2::int)
      ORDER BY lower(m.title), m.id`,
    [teams === "all" ? null : teams, ownerId]
  );
  return rows.map((m) => ({ ...m, scope: macroScope(m) }));
}

export async function getMacro(id: number): Promise<HdMacroRow | undefined> {
  await ensureMacroSchema();
  return hqOne<HdMacroRow>(`SELECT ${COLS} FROM hd_macros WHERE id = $1`, [id]);
}

export async function createMacro(input: MacroInput & { owner_id?: number | null }, createdBy: number | null): Promise<HdMacroRow> {
  await ensureMacroSchema();
  const count = await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_macros");
  if ((count?.n ?? 0) >= MACRO_LIMITS.macros) throw new MacroLimitError(`A workspace can keep up to ${MACRO_LIMITS.macros} macros.`);
  const owner = input.owner_id ?? null;
  const row = await hqOne<HdMacroRow>(
    `INSERT INTO hd_macros (title, body, actions, team_id, owner_id, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
    [input.title, input.body, JSON.stringify(input.actions ?? {}), owner ? null : input.team_id, owner, createdBy]
  );
  return row!;
}

export class MacroLimitError extends Error {}

export async function updateMacro(id: number, patch: Partial<MacroInput> & { owner_id?: number | null }): Promise<HdMacroRow | undefined> {
  const cur = await getMacro(id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  const owner = next.owner_id ?? null;
  return hqOne<HdMacroRow>(
    `UPDATE hd_macros SET title = $2, body = $3, actions = $4, team_id = $5, owner_id = $6, updated_at = now() WHERE id = $1 RETURNING ${COLS}`,
    [id, next.title, next.body, JSON.stringify(next.actions ?? {}), owner ? null : next.team_id, owner]
  );
}

export async function deleteMacro(id: number): Promise<HdMacroRow | undefined> {
  await ensureMacroSchema();
  return hqOne<HdMacroRow>(`DELETE FROM hd_macros WHERE id = $1 RETURNING ${COLS}`, [id]);
}

/** May this agent (with these teams) use the macro? A personal macro is its owner's only. */
export function macroVisibleTo(macro: { team_id: number | null; owner_id?: number | null }, teams: number[] | "all", userId?: number | null): boolean {
  if (macro.owner_id) return macro.owner_id === userId;
  return macro.team_id === null || teams === "all" || teams.includes(macro.team_id);
}

/** The capability (agent J) that writes a macro of this scope, and the team it is checked in. */
export function macroManageCap(m: { owner_id?: number | null; team_id: number | null }): { cap: "macros.manage_personal" | "macros.manage_team" | "macros.manage_all"; teamId: number | null } {
  const scope = macroScope(m);
  if (scope === "personal") return { cap: "macros.manage_personal", teamId: null };
  if (scope === "team") return { cap: "macros.manage_team", teamId: m.team_id };
  return { cap: "macros.manage_all", teamId: null };
}

// --- Applying --------------------------------------------------------------------

export interface MacroApplyActor {
  id: number | null;
  name: string;
  email?: string;
  /** 1.20.15: through the Claude connector ("mcp") or a Claude in the desk card ("claude_desk"): the field changes' timeline lines say so. */
  via?: MacroVia;
}

/** 1.20.15: how a macro reached the ticket through Claude. */
export type MacroVia = "mcp" | "claude_desk";

/** 1.20.15: why a macro's status change was not made when its reply was saved as a draft (the Claude connector). Nothing sets it later. */
export const MACRO_DRAFT_STATUS_WAITS = "The reply was saved as a draft, not sent, so the macro's status change was not made. Set the status after the reply is sent.";

export type MacroApplyResult =
  | {
      ok: true;
      preview: boolean;
      body: string;
      patch: import("./types").HdTicketPatch;
      message_id: number | null;
      /** The reply was held for a lead's review (a Newbie's): not sent, and its status change not made. */
      held?: boolean;
      /** 1.19.2: the status change was left out because required checklist items are open (an automation's macro, or a race); the sentence. */
      status_unchanged?: string;
      /** 1.20.15: the reply was saved as this reply draft (replyAs "draft"), not sent. */
      draft_id?: number;
      /** 1.20.15: every check passed and nothing was written (dryRun). */
      dry_run?: true;
    }
  | { ok: false; status: 403 | 404 | 409; error: string; missing?: string[] };

/**
 * The route's say on what a macro would write, before anything is: the
 * filled reply and the field changes. A refusal stops the whole macro
 * (nothing is posted or changed).
 */
export type MacroAuthorize = (
  what: { body: string; patch: import("./types").HdTicketPatch }
) => Promise<{ status: 403 | 409; error: string; missing?: string[] } | null>;

/**
 * Fill a macro for a ticket and, unless `preview`, post its reply (public,
 * from the actor) and make its field changes (tags are added to the
 * ticket's). The reply goes first, so "reply and solve" reads in order.
 * Automations pass `fromAutomation`, so the writes run no rules.
 */
export async function applyMacroToTicket(
  ticketId: number,
  macroId: number,
  actor: MacroApplyActor,
  opts: {
    preview?: boolean;
    fromAutomation?: boolean;
    origin?: string;
    authorize?: MacroAuthorize;
    /** 1.20.5: closing answers for a macro that solves (lib/helpdesk/solve-requirements). */
    solveAnswers?: unknown;
    /** 1.20.15: "draft" saves the reply as a reply draft for an agent to send (the Claude connector) and holds back the status change. */
    replyAs?: "send" | "draft";
    /** 1.20.15: run every check (authorize, required checklist items, "Before you solve", newbie review) and write nothing. */
    dryRun?: boolean;
  } = {}
): Promise<MacroApplyResult> {
  const macro = await getMacro(macroId);
  if (!macro) return { ok: false, status: 404, error: "Macro not found." };
  const ctx = await macroContext(ticketId, actor, opts.origin ?? "");
  if (!ctx) return { ok: false, status: 404, error: "Ticket not found." };
  const body = renderMacro(macro.body, ctx).trim();
  const t = await hqOne<{ status: HdStatus; priority: HdPriority; team_id: number | null; tags: string[]; requester_id: number | null }>(
    "SELECT status, priority, team_id, tags, requester_id FROM hd_tickets WHERE id = $1",
    [ticketId]
  );
  if (!t) return { ok: false, status: 404, error: "Ticket not found." };
  const a = macro.actions ?? {};
  const patch: import("./types").HdTicketPatch = {};
  if (a.status && a.status !== t.status) patch.status = a.status;
  if (a.priority && a.priority !== t.priority) patch.priority = a.priority;
  if (a.team_id && a.team_id !== t.team_id) patch.team_id = a.team_id;
  if (a.tags_add?.length) {
    const tags = [...t.tags];
    for (const tag of a.tags_add) if (!tags.includes(tag)) tags.push(tag);
    if (tags.length !== t.tags.length) patch.tags = tags;
  }
  if (opts.preview) return { ok: true, preview: true, body, patch, message_id: null };
  if (opts.authorize) {
    const refused = await opts.authorize({ body, patch });
    if (refused) return { ok: false, ...refused };
  }
  let statusDropped: string | undefined;
  // 1.20.15: a reply saved as a draft is not sent, so its status change waits (as for a reply
  // held for review below): "reply and solve" must not solve while the requester has no reply.
  // Checked after authorize, so a macro the agent may not apply in full is refused as in the desk.
  const asDraft = opts.replyAs === "draft" && !!body;
  if (asDraft && patch.status !== undefined) {
    delete patch.status;
    statusDropped = MACRO_DRAFT_STATUS_WAITS;
  }
  // 1.19.2 (agent W3): required checklist items block the macro's solve before its reply
  // is posted, for every caller. A person's macro is refused whole (409); an automation's
  // drops only the status change and still sends the reply and makes the rest.
  const checklists = await import("./checklists");
  if (checklists.solvesForChecklists(t.status, patch.status)) {
    const held = await checklists.checklistSolveRefusal(ticketId);
    if (held && !opts.fromAutomation) return { ok: false, status: 409, error: held.error };
    if (held) {
      delete patch.status;
      statusDropped = held.error;
    }
  }
  // 1.20.5: "Before you solve" requirement sets block it the same way (lib/helpdesk/solve-requirements): a person's macro
  // is refused whole before its reply is posted, an automation's drops only the status change. The macro's own reply and
  // field changes count towards what the sets ask for.
  const solveReqs = await import("./solve-requirements");
  if (patch.status !== undefined && solveReqs.solvesForRequirements(t.status, patch.status)) {
    const needs = await solveReqs.solveRequirementRefusal(ticketId, { answers: opts.solveAnswers, patch: { team_id: patch.team_id, tags: patch.tags }, replyPending: !!body });
    if (needs && !opts.fromAutomation) return { ok: false, status: needs.status === 400 ? 409 : needs.status, error: needs.error };
    if (needs) {
      delete patch.status;
      statusDropped = needs.error;
    }
  }
  // 1.20.15: a dry run (a Claude in the desk proposal) stops here, every check passed; whether a
  // newbie's reply would be held is asked as addMessage asks it, and its status change waits then too.
  if (opts.dryRun) {
    let wouldHold = false;
    if (body && !asDraft && actor.id) {
      const { prepareReply } = await import("./review");
      wouldHold = (await prepareReply({ id: actor.id }, { id: ticketId, requester_id: t.requester_id, team_id: t.team_id }, { kind: "public" })).review_state === "pending";
    }
    if (wouldHold && patch.status !== undefined) delete patch.status;
    return { ok: true, preview: false, body, patch, message_id: null, held: wouldHold, dry_run: true, ...(statusDropped ? { status_unchanged: statusDropped } : {}) };
  }
  const hook = { fromAutomation: opts.fromAutomation, actorId: actor.id, actorName: actor.name, origin: opts.origin };
  // 1.20.15: field changes through Claude end "via Claude" / "via Claude in the desk" on the timeline (lib/helpdesk/tickets).
  const updater = { id: actor.id, name: actor.name, ...(actor.via ? { via: actor.via } : {}) };
  let messageId: number | null = null;
  let draftId: number | undefined;
  let held = false;
  if (asDraft) {
    // The connector's rule: a reply is a draft that waits above the composer as "Draft from Claude" (lib/helpdesk/drafts).
    const { createReplyDraft } = await import("./drafts");
    draftId = (await createReplyDraft(ticketId, body, actor.id, "claude")).id;
  } else if (body) {
    const { addMessage } = await import("./messages");
    const r = await addMessage(
      ticketId,
      { kind: "public", body, author: { id: actor.id, name: actor.name, email: actor.email ?? "" }, via: actor.id ? "desk" : "system", asRequester: false },
      hook
    );
    messageId = r?.message.id ?? null;
    held = r?.held === true;
  }
  // A reply held for review is not sent, so its status change waits too (as
  // addMessage's then_status does): "reply and solve" must not solve, and
  // send the survey, while the requester has no reply.
  if (held && patch.status !== undefined) delete patch.status;
  if (Object.keys(patch).length) {
    const { updateTicket } = await import("./tickets");
    try {
      await updateTicket(ticketId, patch, updater, hook, { solveAnswers: opts.solveAnswers });
    } catch (e) {
      // An item unticked since the check above: the reply is out, so keep the rest of the change (W3).
      // 1.20.5: the same when a "Before you solve" requirement refuses it now (a reply held for review doesn't count as sent).
      const msg = e instanceof Error ? e.message : "";
      if (patch.status === undefined || !(checklists.isChecklistBlock(msg) || solveReqs.isSolveRequirementBlock(msg))) throw e;
      delete patch.status;
      statusDropped = msg;
      if (Object.keys(patch).length) await updateTicket(ticketId, patch, updater, hook);
    }
  }
  return {
    ok: true,
    preview: false,
    body,
    patch,
    message_id: messageId,
    held,
    ...(statusDropped ? { status_unchanged: statusDropped } : {}),
    ...(draftId !== undefined ? { draft_id: draftId } : {}),
  };
}

// --- As an agent: the desk's route and Claude's tools (1.20.15) ---------------------------

/** Who applies (a desk session, or the connector's user as a session). */
export type MacroAgent = import("../types").SessionUser;

/**
 * 1.20.15 (review fix): what a macro would write on a ticket, as Claude in the desk's card
 * showed it: the macro's version (updated_at), the filled reply and the field changes
 * before any is held back. Apply with a card must match it exactly or writes nothing.
 */
export interface MacroPlan {
  macro_updated_at: string;
  body: string;
  patch: import("./types").HdTicketPatch;
}

export const MACRO_CHANGED = "The macro changed since Claude suggested it. Ask again.";
export const MACRO_TICKET_CHANGED = "The ticket changed since Claude suggested this, so the macro would now do something else. Ask again.";

const isoOf = (v: unknown): string => {
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? String(v ?? "") : d.toISOString();
};

/** JSON with object keys sorted (a plan read back from jsonb has its keys reordered). */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export type MacroAsOutcome =
  | { ok: false; status: 400 | 403 | 404 | 409; error: string; missing?: string[]; newer?: unknown[]; merged?: boolean }
  | {
      ok: true;
      result: Extract<MacroApplyResult, { ok: true }>;
      ticket: { id: number; number: number; subject: string };
      macro: HdMacroRow & { scope: MacroScope };
      /** 1.20.15: what it wrote, or (dryRun) would write, for a card to carry. */
      plan?: MacroPlan;
    };

/**
 * Apply a macro to a ticket as `user`: the desk's POST
 * /api/helpdesk/tickets/[n]/macro/[id] (whose caller holds Use macros
 * somewhere, hdCapGate) and Claude's tools. In order, as the route always
 * checked: not in the recycle bin and worked by the caller (404), Use
 * macros in the ticket's team (403), the macro is theirs to use (personal:
 * its owner; team: their teams; everyone's) (404); then, unless previewing,
 * a closed or merged ticket (409) and the send guard (`guard`: the body's
 * expect_last_message_id / force) for a macro with a reply; then
 * applyMacroToTicket with the route's authorize (reply capability, each
 * field change's capability, a workflow task's hand-off), required
 * checklist items, "Before you solve" and newbie review. A refusal writes
 * nothing. Through Claude (`via`), a change is audited as
 * helpdesk.macro.applied with the marker.
 */
export async function applyMacroAs(
  user: MacroAgent,
  number: number,
  macroId: number,
  opts: {
    preview?: boolean;
    origin?: string;
    solveAnswers?: unknown;
    guard?: Record<string, unknown>;
    replyAs?: "send" | "draft";
    dryRun?: boolean;
    via?: MacroVia;
    ip?: string | null;
    /**
     * 1.20.15 (review fix): Apply on a Claude in the desk card: the plan the card showed (null
     * when the card has none). Any difference refuses the whole apply with a 409, writing nothing.
     */
    expect?: MacroPlan | null;
    /** The card, for the audit row. */
    cardId?: number;
  } = {}
): Promise<MacroAsOutcome> {
  const [{ agentTeamIds, canWorkTicket }, { HD_FORBIDDEN, hdCan }, { patchRefusal }] = await Promise.all([
    import("./access"),
    import("./roles"),
    import("./patch-caps"),
  ]);
  if (!(await hdCan(user, "macros.use"))) return { ok: false, status: 403, error: HD_FORBIDDEN };
  const ticket = await hqOne<
    Pick<import("./types").HdTicketRow, "id" | "number" | "subject" | "requester_id" | "team_id" | "assignee_id" | "status" | "priority" | "source"> & { merged_into: number | null }
  >(
    // 1.19.4 (C7): not a ticket in the recycle bin.
    "SELECT id, number, subject, requester_id, team_id, assignee_id, status, priority, source, merged_into FROM hd_tickets WHERE number = $1 AND deleted_at IS NULL",
    [number]
  );
  if (!ticket || !(await canWorkTicket(user, ticket))) return { ok: false, status: 404, error: "Ticket not found." };
  if (!(await hdCan(user, "macros.use", { teamId: ticket.team_id }))) return { ok: false, status: 403, error: HD_FORBIDDEN };
  const macro = await getMacro(macroId);
  if (!macro || !macroVisibleTo(macro, await agentTeamIds(user), user.id)) return { ok: false, status: 404, error: "Macro not found." };
  if (opts.expect !== undefined && (!opts.expect || isoOf(opts.expect.macro_updated_at) !== isoOf(macro.updated_at))) {
    return { ok: false, status: 409, error: MACRO_CHANGED };
  }
  const preview = opts.preview === true;
  // A merged ticket is closed into the one it joined (lib/helpdesk/merge), so this answers it too.
  if (!preview && ticket.status === "closed") return { ok: false, status: 409, error: "This ticket is closed.", ...(ticket.merged_into ? { merged: true } : {}) };
  // 1.19.1 collision warning (lib/helpdesk/presence): a macro's reply is a send too. A draft sends nothing.
  if (!preview && !opts.dryRun && opts.replyAs !== "draft" && macro.body.trim()) {
    const { collisionCheck } = await import("./presence");
    const collided = await collisionCheck(ticket.id, user.id, opts.guard);
    if (collided) return { ok: false, ...collided };
  }
  const teamId = ticket.team_id;
  let plan: MacroPlan | undefined;
  const result = await applyMacroToTicket(
    ticket.id,
    macroId,
    { id: user.id, name: user.name || user.username, email: user.email, ...(opts.via ? { via: opts.via } : {}) },
    {
      preview,
      origin: opts.origin,
      solveAnswers: opts.solveAnswers,
      ...(opts.replyAs === "draft" ? { replyAs: "draft" as const } : {}),
      ...(opts.dryRun ? { dryRun: true } : {}),
      authorize: async ({ body: reply, patch }) => {
        plan = { macro_updated_at: isoOf(macro.updated_at), body: reply, patch: { ...patch } };
        // 1.20.15 (review fix): exactly what the card showed, or nothing (the ticket moved on since).
        if (opts.expect && (opts.expect.body !== reply || stableJson(opts.expect.patch) !== stableJson(patch))) {
          return { status: 409, error: MACRO_TICKET_CHANGED };
        }
        if (reply && !(await hdCan(user, "tickets.reply_public", { teamId })) && !(await hdCan(user, "tickets.reply_needs_review", { teamId }))) {
          return { status: 403, error: HD_FORBIDDEN };
        }
        const refused = await patchRefusal(user, ticket, patch);
        if (refused) return { status: 403, error: refused };
        if (ticket.source === "workflow" && (patch.status === "solved" || patch.status === "closed")) {
          const { validateTaskSolve } = await import("./engine");
          const missing = await validateTaskSolve(ticket.id);
          if (missing) return { status: 409, error: missing.error, missing: missing.missing_keys };
        }
        return null;
      },
    }
  );
  if (!result.ok) return result;
  if (opts.via && !preview && !result.dry_run) {
    const { audit, actorFrom } = await import("../audit");
    await audit({
      actor: actorFrom(user),
      action: "helpdesk.macro.applied",
      targetType: "helpdesk_ticket",
      targetId: ticket.id,
      targetLabel: `#${ticket.number} ${ticket.subject}`.slice(0, 200),
      details: {
        number: ticket.number,
        macro_id: macro.id,
        macro: macro.title,
        scope: macroScope(macro),
        changed: Object.keys(result.patch),
        reply: result.draft_id !== undefined ? "draft" : result.held ? "held" : result.body ? "sent" : "none",
        ...(result.draft_id !== undefined ? { draft_id: result.draft_id } : {}),
        ...(result.message_id ? { message_id: result.message_id } : {}),
        ...(result.status_unchanged ? { status_unchanged: true } : {}),
        ...(opts.cardId ? { card_id: opts.cardId } : {}),
        ...(opts.via === "mcp" ? { via: "mcp" } : { via: "claude_desk", via_label: "via Claude in the desk" }),
      },
      ip: opts.ip ?? null,
    });
  }
  return { ok: true, result, ticket: { id: ticket.id, number: ticket.number, subject: ticket.subject }, macro: { ...macro, scope: macroScope(macro) }, ...(plan ? { plan } : {}) };
}

// --- What a macro does, in words (Claude's tools, 1.20.15) --------------------------------

/**
 * "Replies to the requester", "Sets the status to Solved", "Adds the tags vpn, mfa", …
 * for a macro's own actions (not checked against a ticket). Macros never change the assignee.
 */
export async function macroDoes(m: Pick<HdMacro, "body" | "actions">): Promise<{ lines: string[]; solves: boolean }> {
  const { HD_STATUS_LABEL } = await import("./types");
  const a = m.actions ?? {};
  const lines: string[] = [];
  if (m.body.trim()) lines.push("Replies to the requester");
  if (a.status) lines.push(`Sets the status to ${HD_STATUS_LABEL[a.status] ?? a.status}`);
  if (a.priority) lines.push(`Sets the priority to ${HD_PRIORITY_LABEL[a.priority] ?? a.priority}`);
  if (a.team_id) {
    const team = await hqOne<{ name: string }>("SELECT name FROM hd_teams WHERE id = $1", [a.team_id]);
    lines.push(`Moves it to the team ${team?.name ?? "that no longer exists"}`);
  }
  if (a.tags_add?.length) lines.push(`Adds ${a.tags_add.length === 1 ? "the tag" : "the tags"} ${a.tags_add.join(", ")}`);
  return { lines, solves: a.status === "solved" || a.status === "closed" };
}
