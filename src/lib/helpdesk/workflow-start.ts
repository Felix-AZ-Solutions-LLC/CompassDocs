// Helpdesk 1.20.21: Start a workflow from the desk. Before this a workflow
// started only when someone sent a request of a type linked to it (Get help,
// the customer portal, email intake); now an agent starts one without
// leaving the desk, from an open ticket ("Start a workflow…" in the ticket's
// … menu) or as they raise a ticket (New ticket's Request type).
//
// Who it can be started for (requesterOf), from the ticket's requester:
//   account  an active account that may use Get help (helpdesk.request, as
//            Get help's own gate asks). Deactivated people and those without
//            Get help are offered nothing.
//   portal   a customer-portal contact (portal_contact_id), not blocked:
//            only the types the portal offers them (portal offeredTypes:
//            exposed, nothing directory-bound), sent to the portal's team for
//            the type, never prefilled from the directory
//   none     anyone else (an email sender with no account and no portal
//            sign-in, an alert's sender): nothing is offered, and the dialog
//            says why. There is nobody whose request the run could be: no
//            Get help or portal to follow it in, no directory entry for a
//            manager approval.
//
// Which request types are offered (startableTypes; the dialog, New ticket
// and the server's own re-check use the same rule), for an account:
//   - the type is switched on, and
//   - it starts a published workflow with at least one step (engine
//     workflowForRequestType: what startWorkflowForRequest itself would run),
//     and
//   - the requester could pick it in Get help themselves: an everyone type,
//     or a type restricted to groups one of which the requester belongs to.
//   The agent's own groups never widen it: the run is the requester's
//   request (their manager approves, their access is granted, they hear the
//   notices), so an agent starts only what the requester could have asked
//   for. New ticket lists the same types plus those with no workflow (it
//   files any request type; only a workflow needs workflows.start).
//   1.20.21 security review: when the run will go on a new request, only the
//   types whose team the agent may file into (mayFileInto: the POST
//   /api/helpdesk/tickets own-teams rule, and workflows.start in that team).
//   Prefilled answers never carry a directory value the agent may not see
//   (detail directoryDefaults `viewer`).
//
// Which tickets (startRefusal): open (not solved or closed), not a workflow
// task or another child ticket, not merged away, not in the recycle bin.
// Capability workflows.start in the ticket's team (roles-shared), and the
// agent must work the ticket (lib/helpdesk/routes loadTicketFor "work").
//
// The two outcomes (workflow-start-shared HdStartMode), decided under the
// ticket's row lock: `this` (no request type and no run: the ticket becomes
// the request and the run lives on it) or `new` (a new request of the type
// for the same requester, linked by an internal note on each ticket: source
// 'desk' for an account; for a portal contact source 'portal_external' with
// its portal_contact_id, as the portal files it, so the contact sees it and
// the notices are the portal's). A ticket whose type an earlier desk start
// set but whose run never started (source_ref.desk_workflow_start names that
// type, no run exists, and that start is over: it marked itself failed, or
// is older than two minutes) is `this` again, so the start can be retried on
// it; one still on its way is not, so a racing second start gets `new`. The dialog sends the outcome it showed; a ticket that changed
// meanwhile answers 409 and nothing is written.
//
// Idempotency: client_start_id (hd_workflow_start_ids, workflow-start-schema)
// is written in the same transaction as the change, after the ticket's FOR
// UPDATE lock, so two tries with one key serialise on the lock and the second
// reads the first's row and answers with its outcome (duplicate: true). The
// answers are checked again inside that transaction against the type as it
// is then.
//
// 1.20.22: a start from a Claude in the desk suggestion card (Review and
// start) carries `claude_card: { id, claim }`. Inside the same transaction,
// after every other check and before anything is written, the card is locked
// and must be this agent's, for this ticket and type, held by that review and
// unused (claude/workflow-cards takeCardForStart; else 409
// claude_card_taken); it records the outcome there too, so one card starts
// once. The note and the audit say "· suggested by Claude" (audit details
// suggested_by "claude_desk", claude_card_id). Without it nothing changes.
//
// After the commit: the request type's calendar event and checklists (as
// afterTicketCreated gives a new request), then the run
// (startWorkflowForRequest, or afterTicketCreated for a new request). The
// "Workflow started by <agent>: <workflow> (version n)" internal note is
// written inside the run's insert transaction (engine `onStarted`), so it
// precedes the run's first step and names the version the run pinned. The
// audit entry (helpdesk.workflow_run.started) follows. A run that did not
// start leaves a note saying why (no published workflow any more, the ticket
// solved first, or an error) and can be retried. The desk hears the change
// through 1.20.19's hd_tickets triggers (request_type_id, workflow_run_id and
// updated_at are LIVE_COLUMNS; a new request is an INSERT).
//
// Server-only.

import "server-only";
import type { PoolClient } from "pg";
import { audit, actorFrom } from "../audit";
import type { Role } from "../types";
import { logEvent } from "../log";
import { hq, hqOne, withTx } from "./db-core";
import type { HdQueryable } from "./db-core";
import { mdInline } from "./md-inline";
import { getRequestType, listRequestTypes, validateAnswers } from "./request-types";
import { getRunForTicket, startWorkflowForRequest, workflowForRequestType } from "./engine";
import type { StartedRun } from "./engine";
import { getTicketRow, insertTicketTx, TICKET_LIMITS } from "./tickets";
import { addSystemMessage } from "./messages";
import type { HdHookContext } from "./events";
import type { HdFormAnswers, HdFormField, HdRequestType, HdTicketRow } from "./types";
import { startedLine, cleanStartId, WORKFLOW_START_CODES } from "./workflow-start-shared";
import { WORKFLOW_CARD_CODES } from "./claude/shared";
import type { HdStartMode, HdStartableType, HdStartWorkflowOptions, HdStartWorkflowResult } from "./workflow-start-shared";

/** How long a finished start's key is remembered. */
export const START_ID_KEEP_SECONDS = 24 * 60 * 60;

export interface StartAgent {
  id: number;
  name: string;
  username: string;
  role: Role;
}

const agentName = (a: StartAgent) => a.name || a.username;

// --- Who it is for ------------------------------------------------------------------------

export type StartRequester =
  | { kind: "account"; id: number; name: string }
  | { kind: "portal"; contactId: number; name: string }
  | { kind: "none"; name: string; reason: string };

type RequesterFacts = Pick<HdTicketRow, "requester_id" | "requester_name" | "requester_email"> & { portal_contact_id?: number | null };

/** May this account use Get help (active, helpdesk.request)? The one rule for the ticket and New ticket paths. */
export async function accountMayRequest(userId: number): Promise<boolean> {
  const u = await hqOne<{ id: number; role: Role; status: string }>("SELECT id, role, status FROM users WHERE id = $1", [userId]);
  if (!u || u.status !== "active") return false;
  const { hdHolds } = await import("./access");
  return hdHolds(u, "helpdesk.request");
}

/** Whose request a run started from this ticket would be (the header's three kinds). */
export async function requesterOf(t: RequesterFacts): Promise<StartRequester> {
  const name = t.requester_name || t.requester_email || "the requester";
  if (t.requester_id) {
    if (!(await accountMayRequest(t.requester_id))) {
      return { kind: "none", name, reason: `${name} can't use Get help (their account is switched off or has no access), so no workflow can be started for them.` };
    }
    return { kind: "account", id: t.requester_id, name };
  }
  if (t.portal_contact_id) {
    const c = await hqOne<{ blocked: number }>("SELECT blocked FROM hd_portal_contacts WHERE id = $1", [t.portal_contact_id]);
    if (!c || Number(c.blocked) === 1) return { kind: "none", name, reason: `${name} is blocked from the customer portal, so no workflow can be started for them.` };
    return { kind: "portal", contactId: t.portal_contact_id, name };
  }
  return {
    kind: "none",
    name,
    reason: `${name} has no account and no customer portal sign-in, so there's nobody to start a workflow for. Raise a New ticket for someone with an account instead.`,
  };
}

// --- Where a new request may go ------------------------------------------------------------

/**
 * May the agent open a request in `teamId` (the request type's, or the
 * portal's team for it)? The POST /api/helpdesk/tickets rule (an agent files
 * into the teams they work; with one team, a request with no team goes to
 * it) plus workflows.start in that team. Answers the team it lands in.
 */
export async function mayFileInto(agent: StartAgent, teamId: number | null): Promise<{ ok: true; teamId: number | null } | { ok: false; error: string }> {
  const [{ agentTeamIds }, { hdCan }] = await Promise.all([import("./access"), import("./roles")]);
  const teams = await agentTeamIds(agent);
  let dest = teamId;
  if (dest == null && teams !== "all" && teams.length === 1) dest = teams[0];
  if (dest == null) {
    return (await hdCan(agent, "tickets.view_all")) && (await hdCan(agent, "workflows.start"))
      ? { ok: true, teamId: null }
      : { ok: false, error: "This request type has no team, and you can only open tickets for your own teams." };
  }
  if (teams !== "all" && !teams.includes(dest)) return { ok: false, error: "That request type's team isn't one of yours, and you can only open tickets for your own teams." };
  if (!(await hdCan(agent, "workflows.start", { teamId: dest }))) return { ok: false, error: "You can't start workflows in that request type's team." };
  return { ok: true, teamId: dest };
}

// --- The rule ---------------------------------------------------------------------------

/** The groups a requester belongs to (none without an account). */
async function requesterGroups(requesterId: number | null, client?: HdQueryable): Promise<Set<number>> {
  if (!requesterId) return new Set();
  const rows = await hq<{ group_id: number }>("SELECT group_id FROM group_members WHERE user_id = $1", [requesterId], client);
  return new Set(rows.map((r) => Number(r.group_id)));
}

/** Could this requester pick the type in Get help (switched on; everyone's, or one of their groups')? */
function requesterMayUse(rt: Pick<HdRequestType, "active" | "visibility" | "group_ids">, groups: Set<number>): boolean {
  if (Number(rt.active) !== 1) return false;
  if (rt.visibility === "all") return true;
  return (rt.group_ids ?? []).some((g) => groups.has(Number(g)));
}

/**
 * 1.20.23 (lib/helpdesk/desk-departments): an agent is offered a request type, and may start or
 * file it, only when the type and the workflow it starts are each in one of the agent's desk
 * departments or in All departments. A requester's own choices (Get help, the portal) are never
 * filtered: this is the desk side only.
 */
export async function typeInAgentDepartments(
  agent: { id: number; role: Role },
  rt: { desk_department_id?: number | null },
  w: { desk_department_id?: number | null } | null | undefined
): Promise<boolean> {
  const { deskDepartmentScope, deskDepartmentInScope } = await import("./desk-departments");
  const scope = await deskDepartmentScope(agent);
  return deskDepartmentInScope(rt.desk_department_id ?? null, scope) && (!w || deskDepartmentInScope(w.desk_department_id ?? null, scope));
}

/** The refusal for a type outside the agent's desk departments (as for a type no longer offered). */
export const NOT_IN_AGENT_DEPARTMENTS = "That request type isn't one of your desk departments'. Choose another.";

async function teamNames(): Promise<Map<number, string>> {
  return new Map((await hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams")).map((r) => [r.id, r.name]));
}

/** A portal contact's types (portal offeredTypes), as this module lists them. 1.20.23: `viewer`'s desk departments' only. */
async function portalTypes(workflowOnly: boolean, viewer?: { id: number; role: Role }): Promise<HdStartableType[]> {
  const { offeredTypes } = await import("./portal");
  const [offered, names] = await Promise.all([offeredTypes(), teamNames()]);
  const out: HdStartableType[] = [];
  for (const o of offered) {
    const w = await workflowForRequestType(o.id);
    if (!w && workflowOnly) continue;
    const rt = await getRequestType(o.id);
    if (!rt || Number(rt.active) !== 1) continue;
    if (viewer && !(await typeInAgentDepartments(viewer, rt, w))) continue;
    out.push({
      id: o.id,
      slug: rt.slug,
      title: o.title,
      description: o.description,
      icon: o.icon,
      team_id: o.team_id,
      team_name: o.team_id ? (names.get(o.team_id) ?? null) : null,
      form: o.form,
      defaults: {},
      workflow: w ? { id: w.id, title: w.title, version: w.version, steps: w.definition.steps.length } : null,
    });
  }
  return out;
}

/**
 * The request types offered for a requester (the header's rule), in the
 * settings page's order. `workflowOnly` (the dialog): only those that start
 * a workflow; without it (New ticket) every type an account may use.
 * `viewer`: who will see the prefilled answers (never a directory value
 * hidden from them). `team_id` is where a new request of the type goes.
 * 1.20.23: with a `viewer`, only the types (and workflows) of their desk
 * departments and All departments (typeInAgentDepartments).
 */
export async function startableTypes(
  requester: StartRequester | { kind: "account"; id: number; name?: string } | null,
  opts: { workflowOnly?: boolean; viewer?: { id: number; role: Role } } = {}
): Promise<HdStartableType[]> {
  const workflowOnly = opts.workflowOnly ?? true;
  // A requester with no account (the 1.20.21 first pass's `null`): the portal path or nothing.
  if (!requester || requester.kind === "none") return [];
  if (requester.kind === "portal") return portalTypes(workflowOnly, opts.viewer);
  const [all, groups] = await Promise.all([listRequestTypes({ activeOnly: true }), requesterGroups(requester.id)]);
  const out: HdStartableType[] = [];
  const { directoryDefaults } = await import("./detail");
  for (const rt of all) {
    if (!requesterMayUse(rt, groups)) continue;
    const w = await workflowForRequestType(rt.id);
    if (!w && workflowOnly) continue;
    if (opts.viewer && !(await typeInAgentDepartments(opts.viewer, rt, w))) continue;
    const form: HdFormField[] = Array.isArray(rt.form) ? rt.form : [];
    out.push({
      id: rt.id,
      slug: rt.slug,
      title: rt.title,
      description: rt.description,
      icon: rt.icon,
      team_id: rt.team_id,
      team_name: rt.team_name ?? null,
      form,
      defaults: await directoryDefaults(requester.id, form, { viewer: opts.viewer }).catch(() => ({})),
      workflow: w ? { id: w.id, title: w.title, version: w.version, steps: w.definition.steps.length } : null,
    });
  }
  return out;
}

/** Is the type still offered for this account (inside the start's transaction)? Answers the workflow it starts. */
async function accountOffer(typeId: number, requesterId: number, client: HdQueryable) {
  const rt = await getRequestType(typeId, client);
  if (!rt || !requesterMayUse(rt, await requesterGroups(requesterId, client))) return null;
  const w = await workflowForRequestType(typeId, client);
  return w ? { rt, w } : null;
}

type TicketFacts = Pick<HdTicketRow, "status" | "source" | "parent_ticket_id"> & { merged_into?: number | null; deleted_at?: string | null };

/** Why no workflow may be started from this ticket, or null. */
export function startRefusal(t: TicketFacts): string | null {
  if (t.deleted_at) return "This ticket is in the recycle bin.";
  if (t.merged_into) return "This ticket was merged into another. Start the workflow there.";
  if (t.parent_ticket_id || t.source === "workflow") return "This ticket is a task of another request. Start a workflow from the request instead.";
  if (t.status === "solved" || t.status === "closed") return `This ticket is ${t.status}. Reopen it to start a workflow from it.`;
  return null;
}

/** A desk start whose run hasn't appeared this long after its commit is taken to have died on the way (a retry may go). */
export const START_PENDING_SECONDS = 120;

/**
 * `this` while the ticket has no request type and no run, or (a retry) its
 * type is the one an earlier desk start set (source_ref.desk_workflow_start)
 * and that start is over without a run: it recorded that it failed, or it is
 * older than START_PENDING_SECONDS. A start still on its way (committed, its
 * run not yet created) is never a retry, so a second agent racing the first
 * gets `new`. Otherwise `new`.
 */
export function startModeFor(
  t: Pick<HdTicketRow, "request_type_id" | "workflow_run_id"> & { source_ref?: Record<string, unknown> | null },
  hasRun: boolean,
  now: number = Date.now()
): HdStartMode {
  if (t.workflow_run_id || hasRun) return "new";
  if (!t.request_type_id) return "this";
  const mark = (t.source_ref ?? {}).desk_workflow_start as { request_type_id?: unknown; failed?: unknown; at?: unknown } | undefined;
  if (!mark || Number(mark.request_type_id) !== Number(t.request_type_id)) return "new";
  const at = typeof mark.at === "string" ? Date.parse(mark.at) : NaN;
  return mark.failed === true || (Number.isFinite(at) && now - at > START_PENDING_SECONDS * 1000) ? "this" : "new";
}

/** The start didn't run: its mark says so, so the ticket offers the start on itself again. */
async function markFailed(ticketId: number): Promise<void> {
  await hq(
    `UPDATE hd_tickets SET source_ref = jsonb_set(source_ref, '{desk_workflow_start,failed}', 'true'::jsonb)
      WHERE id = $1 AND source_ref ? 'desk_workflow_start'`,
    [ticketId]
  ).catch(() => undefined);
}

async function hasRunOn(ticketId: number, client?: HdQueryable): Promise<boolean> {
  return Boolean(await hqOne("SELECT 1 FROM hd_workflow_runs WHERE ticket_id = $1 LIMIT 1", [ticketId], client));
}

/** What the dialog needs: whether it may start, what will happen, and the types. */
export async function startWorkflowOptions(
  t: HdTicketRow & { request_type_title: string | null; in_workflow: boolean; portal_contact_id?: number | null },
  agent: StartAgent
): Promise<HdStartWorkflowOptions> {
  const who = await requesterOf(t);
  const reason = startRefusal(t) ?? (who.kind === "none" ? who.reason : null);
  const mode = startModeFor(t, await hasRunOn(t.id));
  let types: HdStartableType[] = [];
  if (!reason) {
    types = await startableTypes(who, { workflowOnly: true, viewer: agent });
    // A new request goes to the type's team: only those the agent may open one in.
    if (mode === "new") {
      const keep: HdStartableType[] = [];
      for (const x of types) if ((await mayFileInto(agent, x.team_id)).ok) keep.push(x);
      types = keep;
    }
  }
  return {
    eligible: reason === null,
    reason,
    mode,
    ticket: { number: t.number, subject: t.subject, request_type_title: t.request_type_title, in_workflow: t.in_workflow },
    requester: { id: t.requester_id, name: who.name, portal: who.kind === "portal" },
    types,
  };
}

// --- The note and the audit ---------------------------------------------------------------

const ticketLink = (n: number, subject: string) => `[#${n} ${mdInline(subject)}](/desk/tickets/${n})`;

/**
 * The engine `onStarted` hook a desk start passes: it writes the agent's
 * internal notes inside the run's insert transaction and remembers the run
 * for the audit. `notes` says which tickets get which words.
 */
export function deskStartTracker(
  agent: StartAgent,
  notes: (line: string, run: StartedRun) => { ticketId: number; body: string }[],
  /** 1.20.22: started from a Claude in the desk suggestion card ("… · suggested by Claude"). */
  opts: { suggested?: boolean } = {}
) {
  const state: { run: StartedRun | null } = { run: null };
  const hook = async (client: PoolClient, run: StartedRun) => {
    state.run = run;
    const line = startedLine(mdInline(agentName(agent)), mdInline(run.workflow_title), run.workflow_version, { suggested: opts.suggested });
    const touched: number[] = [];
    for (const n of notes(line, run)) {
      await addSystemMessage(n.ticketId, n.body, { internal: true, author: { id: agent.id, name: agentName(agent) }, client });
      touched.push(n.ticketId);
    }
    // A note on another ticket (the one it was started from) moves that ticket too, so its pane and queue row hear it.
    if (touched.length) await client.query("UPDATE hd_tickets SET updated_at = now() WHERE id = ANY($1::int[])", [touched]);
  };
  return { state, hook };
}

/** The audit entry for a run an agent started from the desk ("Started a workflow · #456 · New starter (version 3)"). */
export async function auditDeskStart(
  agent: StartAgent,
  run: StartedRun,
  info: {
    requestNumber: number;
    requestType: { id: number; title: string };
    mode: HdStartMode | "new_ticket";
    fromNumber?: number | null;
    ip?: string | null;
    /** 1.20.22: the Claude in the desk card the agent started it from. */
    claudeCardId?: number | null;
  }
): Promise<void> {
  const suggested = !!info.claudeCardId;
  await audit({
    actor: actorFrom(agent),
    action: "helpdesk.workflow_run.started",
    targetType: "helpdesk_ticket",
    targetId: info.requestNumber,
    targetLabel: `#${info.requestNumber} · ${run.workflow_title} (version ${run.workflow_version})`,
    details: {
      summary: startedLine(agentName(agent), run.workflow_title, run.workflow_version, { suggested }),
      run_id: run.run_id,
      workflow_id: run.workflow_id,
      workflow_title: run.workflow_title,
      workflow_version: run.workflow_version,
      request_type_id: info.requestType.id,
      request_type: info.requestType.title,
      mode: info.mode,
      ...(info.fromNumber ? { from_ticket: info.fromNumber } : {}),
      via: "desk",
      ...(suggested ? { suggested_by: "claude_desk", claude_card_id: info.claudeCardId } : {}),
    },
    ip: info.ip ?? null,
  });
}

/**
 * Why a run that should have started did not (for the note), or null when
 * one is there after all. Kept apart: the workflow gone, the ticket solved
 * before the run could start (by an automation or a person), or an error.
 */
export async function whyNotStarted(ticketId: number, typeId: number, error: unknown): Promise<string | null> {
  if (await getRunForTicket(ticketId)) return null;
  const t = await hqOne<{ status: string }>("SELECT status FROM hd_tickets WHERE id = $1", [ticketId]);
  if (t && (t.status === "solved" || t.status === "closed")) return `the ticket was ${t.status} before its workflow could start (an automation may have done it)`;
  if (!(await workflowForRequestType(typeId))) return "its workflow is no longer published";
  return error
    ? "something went wrong while starting it. Try Start a workflow again"
    : "it didn't start. Try Start a workflow again";
}

// --- Start from a ticket ------------------------------------------------------------------

export interface StartInput {
  request_type_id?: unknown;
  answers?: unknown;
  client_start_id?: unknown;
  /** The outcome the dialog showed ("this" | "new"); a different one answers 409. */
  expect?: unknown;
  /** A new request's subject (the dialog derives it as Get help does); the type's title when empty. */
  subject?: unknown;
  /**
   * 1.20.22: { id, claim } when the agent starts it from a Claude in the desk suggestion card
   * (claude/workflow-cards): the card must be theirs, for this ticket and type, and held by this
   * review; it records the outcome in the start's own transaction. Else 409 and nothing is done.
   */
  claude_card?: unknown;
}

export type StartOutcome =
  | { ok: true; result: HdStartWorkflowResult }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string; code?: string; mode?: HdStartMode };

type Locked = HdTicketRow & { merged_into: number | null; deleted_at: string | null; portal_contact_id: number | null };

/**
 * Start a request type's workflow from ticket `ticketId` (the route has
 * checked the agent works it and holds workflows.start in its team). Never
 * starts twice for one key. See the header for the two outcomes.
 */
export async function startWorkflowFromTicket(
  agent: StartAgent,
  ticketId: number,
  raw: StartInput,
  ctx: { origin?: string; ip?: string | null } = {}
): Promise<StartOutcome> {
  const key = cleanStartId(raw.client_start_id);
  if (key === "bad") return { ok: false, status: 400, error: "Send client_start_id: 16 to 64 letters, digits, - or _, the same for every try of one start." };
  const expect = raw.expect === undefined || raw.expect === null ? null : raw.expect;
  if (expect !== null && expect !== "this" && expect !== "new") return { ok: false, status: 400, error: 'expect is "this" or "new".' };
  const typeId = Number(raw.request_type_id);
  if (!Number.isInteger(typeId) || typeId <= 0) return { ok: false, status: 400, error: "Choose a request type." };
  const cards = await import("./claude/workflow-cards");
  const cardRef = cards.cleanCardRef(raw.claude_card);
  if (cardRef === "bad") return { ok: false, status: 400, error: "claude_card is the { id, claim } that Review and start gave." };
  const rt0 = await getRequestType(typeId);
  if (!rt0) return { ok: false, status: 400, error: "That request type no longer exists.", code: WORKFLOW_START_CODES.typeUnavailable };
  // 1.20.23: the type and its workflow in the agent's desk departments (or All departments), as the dialog offers them.
  if (!(await typeInAgentDepartments(agent, rt0, await workflowForRequestType(typeId)))) {
    return { ok: false, status: 409, error: NOT_IN_AGENT_DEPARTMENTS, code: WORKFLOW_START_CODES.typeUnavailable };
  }
  // Required fields and every value's type, as Get help's own POST checks them (again under the lock below).
  const first = await validateAnswers(rt0.form ?? [], raw.answers ?? {});
  if (!first.ok) return { ok: false, status: 400, error: first.error };
  const subjectIn = typeof raw.subject === "string" ? raw.subject.trim().slice(0, TICKET_LIMITS.subject) : "";
  const who = agentName(agent);

  // Who it is for, and where a new request of the type would go: read before the lock (they need the
  // pool's own connections) and pinned, so the transaction refuses if the ticket's requester changed.
  const pre = (await getTicketRow(ticketId)) as Locked | undefined;
  if (!pre || pre.deleted_at) return { ok: false, status: 404, error: "Not found." };
  const requester = await requesterOf(pre);
  const portalOffer = requester.kind === "portal" ? (await portalTypes(true, agent)).find((x) => x.id === typeId) ?? null : null;
  const destination = requester.kind === "none" ? null : await mayFileInto(agent, portalOffer ? portalOffer.team_id : rt0.team_id);

  type Done =
    | { kind: "refused"; out: Extract<StartOutcome, { ok: false }> }
    | { kind: "duplicate"; mode: HdStartMode; requestTicketId: number | null }
    | { kind: "this"; source: Locked; rt: HdRequestType }
    | { kind: "new"; source: Locked; rt: HdRequestType; row: HdTicketRow };
  const refuse = (status: 400 | 403 | 404 | 409, error: string, code?: string, mode?: HdStartMode): Done => ({
    kind: "refused",
    out: { ok: false, status, error, ...(code ? { code } : {}), ...(mode ? { mode } : {}) },
  });

  const done: Done = await withTx(async (client): Promise<Done> => {
    const t = await hqOne<Locked>("SELECT * FROM hd_tickets WHERE id = $1 FOR UPDATE", [ticketId], client);
    if (!t || t.deleted_at) return refuse(404, "Not found.");
    // The same key again (a double-click, a retry): the first try's outcome, nothing done twice.
    const prior = await hqOne<{ mode: HdStartMode; request_ticket_id: number | null }>(
      "SELECT mode, request_ticket_id FROM hd_workflow_start_ids WHERE user_id = $1 AND ticket_id = $2 AND client_start_id = $3",
      [agent.id, t.id, key],
      client
    );
    if (prior) return { kind: "duplicate", mode: prior.mode, requestTicketId: prior.request_ticket_id };
    const why = startRefusal(t);
    if (why) return refuse(409, why, WORKFLOW_START_CODES.notEligible);
    if (requester.kind === "none") return refuse(409, requester.reason, WORKFLOW_START_CODES.notEligible);
    if ((t.requester_id ?? null) !== (pre.requester_id ?? null) || (t.portal_contact_id ?? null) !== (pre.portal_contact_id ?? null)) {
      return refuse(409, `#${t.number}'s requester changed while you were choosing. Check and start again.`, WORKFLOW_START_CODES.modeChanged, startModeFor(t, true));
    }
    const mode = startModeFor(t, await hasRunOn(t.id, client));
    if (expect !== null && expect !== mode) {
      return refuse(
        409,
        mode === "new"
          ? `#${t.number} became a request or started a workflow while you were choosing, so this would now open a new request. Check and start again.`
          : `#${t.number} changed while you were choosing. Check and start again.`,
        WORKFLOW_START_CODES.modeChanged,
        mode
      );
    }
    // Re-checked under the lock: the type may have been switched off, restricted or unlinked meanwhile.
    const unavailable = () => refuse(409, "That request type no longer starts a workflow for this requester. Choose another.", WORKFLOW_START_CODES.typeUnavailable);
    let rt: HdRequestType;
    if (requester.kind === "account") {
      const offer = await accountOffer(typeId, requester.id, client);
      if (!offer) return unavailable();
      rt = offer.rt;
    } else {
      const now = await getRequestType(typeId, client);
      if (!portalOffer || !now || Number(now.active) !== 1 || !(await workflowForRequestType(typeId, client))) return unavailable();
      rt = now;
    }
    // The answers against the form as it is now.
    const checked = await validateAnswers(rt.form ?? [], raw.answers ?? {}, client);
    if (!checked.ok) return refuse(400, checked.error);
    const answers: HdFormAnswers = checked.value;
    // 1.20.22: from a Claude suggestion card: taken here, under the ticket's lock, so one card starts once.
    if (cardRef) {
      const cardWhy = await cards.takeCardForStart(client, agent.id, t.id, cardRef, typeId);
      if (cardWhy) return refuse(409, cardWhy, WORKFLOW_CARD_CODES.taken);
    }
    const mark = { request_type_id: typeId, by: agent.id, at: new Date().toISOString() };
    let row: HdTicketRow | null = null;
    if (mode === "this") {
      await client.query(
        `UPDATE hd_tickets SET request_type_id = $2, form_answers = $3::jsonb, updated_at = now(),
                source_ref = coalesce(source_ref, '{}'::jsonb) || jsonb_build_object('desk_workflow_start', $4::jsonb)
          WHERE id = $1`,
        [t.id, typeId, JSON.stringify(answers), JSON.stringify(mark)]
      );
    } else {
      // A new request goes where the agent may open one (the own-teams rule, workflows.start there).
      if (!destination?.ok) return refuse(403, destination ? destination.error : "You can't open a request there.");
      const portal = requester.kind === "portal";
      row = await insertTicketTx(client, {
        subject: subjectIn || rt.title,
        body: "",
        requester: { id: t.requester_id, name: t.requester_name, email: t.requester_email },
        author: { id: agent.id, name: who, email: "" },
        via: "desk",
        // A portal contact's request is a portal ticket (theirs to see, the portal's notices), as the portal files it.
        source: portal ? "portal_external" : "desk",
        source_ref: { started_from_ticket_id: t.id, desk_workflow_start: mark },
        request_type_id: typeId,
        answers,
        team_id: destination.teamId,
      });
      if (portal) await client.query("UPDATE hd_tickets SET portal_contact_id = $2 WHERE id = $1", [row.id, t.portal_contact_id]);
    }
    await client.query(
      "INSERT INTO hd_workflow_start_ids (user_id, ticket_id, client_start_id, request_ticket_id, mode) VALUES ($1, $2, $3, $4, $5)",
      [agent.id, t.id, key, row ? row.id : t.id, mode]
    );
    if (cardRef) await cards.recordCardStart(client, cardRef.id, { kind: "started", mode, number: row ? row.number : t.number, started: null });
    return row ? { kind: "new", source: t, rt, row } : { kind: "this", source: t, rt };
  });

  if (done.kind === "refused") return done.out;
  if (done.kind === "duplicate") {
    const again = await outcomeOf(done.mode, done.requestTicketId ?? ticketId, true);
    // 1.20.22 (security review 4): a repeat settles the card too, should the first try have stopped before it could.
    if (cardRef) await cards.finishCardStart(cardRef.id, agent.id, again);
    return { ok: true, result: again };
  }

  // A portal contact's notices link to the portal (never the request's Host), as the portal's own hooks do.
  const origin = requester.kind === "portal" ? await (await import("./portal")).portalHookOrigin() : ctx.origin;
  const hookCtx: HdHookContext = { actorId: agent.id, actorName: who, origin };
  const source = done.source;
  // 1.20.22: a start from a Claude suggestion card says so in its note and audit, and the card records the outcome.
  const suggested = { suggested: !!cardRef };
  const claudeCardId = cardRef ? cardRef.id : null;
  const finish = async (r: HdStartWorkflowResult): Promise<StartOutcome> => {
    if (cardRef) await cards.finishCardStart(cardRef.id, agent.id, r);
    return { ok: true, result: r };
  };
  if (done.kind === "this") {
    const tracker = deskStartTracker(agent, (line) => [{ ticketId: source.id, body: `${line}. This ticket is now a ${mdInline(done.rt.title)} request.` }], suggested);
    // What a new request of the type gets (lib/helpdesk/events afterTicketCreated): its event and checklists, then the run.
    await safely("calendar.requestType", async () => (await import("./desk-calendar")).eventFromRequestType(source.id, { origin }));
    await safely("checklists.requestType", async () => (await import("./checklists")).addRequestTypeChecklists(source.id));
    let error: unknown = null;
    try {
      await startWorkflowForRequest(source.id, { onStarted: tracker.hook });
    } catch (e) {
      error = e;
      logEvent("error", "helpdesk.workflow_start_step_failed", { step: "engine.startWorkflowForRequest", error: e instanceof Error ? e.message : String(e) });
    }
    // Webhooks and the ticket_updated rules hear the change.
    await safely("events.updated", async () => (await import("./events")).afterTicketUpdated(source.id, { assigneeChangedTo: undefined, solved: false, changed: ["request_type_id"] }, hookCtx));
    if (tracker.state.run) await auditDeskStart(agent, tracker.state.run, { requestNumber: source.number, requestType: done.rt, mode: "this", ip: ctx.ip, claudeCardId });
    else {
      const reason = await whyNotStarted(source.id, done.rt.id, error);
      if (reason) {
        await markFailed(source.id);
        await addSystemMessage(source.id, `${mdInline(who)} made this ticket a ${mdInline(done.rt.title)} request, but its workflow didn't start: ${mdInline(reason)}.`, {
          internal: true,
          author: { id: agent.id, name: who },
        }).catch(() => undefined);
      }
    }
    return finish(await outcomeOf("this", source.id, false));
  }

  const row = done.row;
  const tracker = deskStartTracker(
    agent,
    (line) => [
      { ticketId: row.id, body: `${line}. Opened from ${ticketLink(source.number, source.subject)}.` },
      { ticketId: source.id, body: `${line}, on a new request: ${ticketLink(row.number, row.subject)}.` },
    ],
    suggested
  );
  const { afterTicketCreated } = await import("./events");
  // afterTicketCreated never throws (each step is caught and logged); whyNotStarted tells an error from the rest.
  await afterTicketCreated(row, { ...hookCtx, onWorkflowStarted: tracker.hook });
  if (tracker.state.run) {
    await auditDeskStart(agent, tracker.state.run, { requestNumber: row.number, requestType: done.rt, mode: "new", fromNumber: source.number, ip: ctx.ip, claudeCardId });
  } else {
    const reason = await whyNotStarted(row.id, done.rt.id, null);
    if (reason) {
      await markFailed(row.id);
      const n = `${mdInline(who)} opened ${ticketLink(row.number, row.subject)} from ${ticketLink(source.number, source.subject)} as a ${mdInline(done.rt.title)} request, but its workflow didn't start: ${mdInline(reason)}.`;
      for (const id of [row.id, source.id]) await addSystemMessage(id, n, { internal: true, author: { id: agent.id, name: who } }).catch(() => undefined);
    }
  }
  return finish(await outcomeOf("new", row.id, false));
}

async function safely(step: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    logEvent("error", "helpdesk.workflow_start_step_failed", { step, error: e instanceof Error ? e.message : String(e) });
  }
}

/** The answer for a start (or a repeat of one): where the run lives and what it pinned. */
async function outcomeOf(mode: HdStartMode, requestTicketId: number, duplicate: boolean): Promise<HdStartWorkflowResult> {
  const [t, run] = await Promise.all([
    hqOne<{ number: number; subject: string }>("SELECT number, subject FROM hd_tickets WHERE id = $1", [requestTicketId]),
    getRunForTicket(requestTicketId),
  ]);
  const title = run ? String((run.current as { workflow_title?: unknown } | null)?.workflow_title ?? "Workflow") : null;
  return {
    mode,
    started: Boolean(run),
    duplicate,
    request: { number: t?.number ?? 0, subject: t?.subject ?? "" },
    run_id: run?.id ?? null,
    workflow: run && title ? { title, version: Number(run.workflow_version) } : null,
  };
}

// --- New ticket (POST /api/helpdesk/tickets) -------------------------------------------------

/**
 * New ticket with a request type (1.20.21): when the type starts a workflow,
 * the agent needs workflows.start in the ticket's team and the requester
 * must be able to use the type (an active account with Get help, and the
 * header's rule). Answers the refusal, or the hook context that writes the
 * "Workflow started by …" note, plus `after` for the audit once the ticket
 * is created. A type with no workflow is filed as before.
 */
export async function newTicketWorkflowCheck(
  agent: StartAgent,
  rt: HdRequestType,
  requester: { id: number | null; name: string },
  teamId: number | null,
  ctx: { ip?: string | null } = {}
): Promise<
  | { ok: false; status: 400 | 403; error: string }
  | { ok: true; workflow: boolean; onWorkflowStarted?: HdHookContext["onWorkflowStarted"]; after: (ticket: { number: number }) => Promise<void> }
> {
  const w = await workflowForRequestType(rt.id);
  // 1.20.23: New ticket files only its desk departments' types (and All departments'), with or without a workflow.
  if (!(await typeInAgentDepartments(agent, rt, w))) return { ok: false, status: 403, error: NOT_IN_AGENT_DEPARTMENTS };
  if (!w) return { ok: true, workflow: false, after: async () => undefined };
  const { hdCan, HD_FORBIDDEN } = await import("./roles");
  if (!(await hdCan(agent, "workflows.start", { teamId }))) return { ok: false, status: 403, error: HD_FORBIDDEN };
  const who = requester.name || "this requester";
  if (!requester.id || !(await accountMayRequest(requester.id))) {
    return { ok: false, status: 400, error: `${who} can't use Get help, so ${rt.title}'s workflow can't start for them.` };
  }
  if (!requesterMayUse(rt, await requesterGroups(requester.id))) {
    return { ok: false, status: 400, error: `${rt.title} isn't a request type ${who} can use, so its workflow can't start for them.` };
  }
  const tracker = deskStartTracker(agent, (line, run) => [{ ticketId: run.ticket_id, body: `${line}.` }]);
  return {
    ok: true,
    workflow: true,
    onWorkflowStarted: tracker.hook,
    after: async (ticket) => {
      if (tracker.state.run) await auditDeskStart(agent, tracker.state.run, { requestNumber: ticket.number, requestType: rt, mode: "new_ticket", ip: ctx.ip });
    },
  };
}

// --- Sweep ----------------------------------------------------------------------------------

/** Forget start keys older than a day (the hd_workflow_start_ids sweep). */
export async function sweepStartIds(now: Date = new Date()): Promise<number> {
  const r = await hq<{ ticket_id: number }>(
    "DELETE FROM hd_workflow_start_ids WHERE created_at < $1::timestamptz - make_interval(secs => $2) RETURNING ticket_id",
    [now.toISOString(), START_ID_KEEP_SECONDS]
  );
  return r.length;
}
