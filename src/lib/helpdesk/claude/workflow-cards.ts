// Helpdesk 1.20.22: Claude in the desk suggests starting a workflow.
//
// Claude, acting as the agent, can list which request types' workflows could
// be started for the open ticket (list_startable_workflows) and suggest one
// (suggest_workflow), with answers drawn from the conversation. It never
// starts anything: the suggestion is a card (ClaudeWorkflowCard in ./shared,
// stored as kind "change", action "workflow") with Review and start and
// Dismiss.
//
// The one rule. What can be started is 1.20.21's own answer for the agent
// and the ticket (lib/helpdesk/workflow-start startWorkflowOptions: the
// requester's eligibility, the types they could pick, the destination-team
// rights for a new request, the directory prefill with the agent as viewer),
// never a parallel rule. Claude is shown each type's questions and whether a
// question is filled from the requester's directory, never a directory value.
//
// Claude's answers are checked when the card is made (checkSuggestedAnswers),
// one question at a time with Get help's own validateAnswers, so an invalid
// value is left out (and said so on the card) rather than refusing the whole
// suggestion: unknown questions, values of the wrong type, a choice that is
// not an option; a lookup that fails drops just that answer. A person is
// never taken on Claude's word: a person question takes an exact full name,
// or an email only when the agent may see the directory's email column,
// which must be exactly one active account (the accounts the dialog's people
// picker offers); never a number (only the card's own stored answer is an
// account id, re-checked at Review and by the start). A question the
// directory fills keeps the directory's value.
//
// Review and start (reviewWorkflowCard) claims the card first (offered →
// applied with a claim token; a claim lapses after
// WORKFLOW_CARD_CLAIM_MINUTES), so two tabs never both act on it, then checks
// the suggestion still holds (staleReason). For good (the requester changed,
// the outcome would differ, or its workflow already runs on the ticket or on
// a request opened from it) the card is marked stale with the reason; for
// now (the ticket solved, the requester's Get help access off, the type not
// offered to this agent here) the claim is given back with the reason and the
// card stays usable. Otherwise the
// desk opens the 1.20.21 dialog prefilled; the agent edits and submits it
// through the unchanged start-workflow route, adding `claude_card: { id,
// claim }`. That start takes the card under the ticket's row lock
// (takeCardForStart) and records the outcome in the same transaction, so a
// suggestion starts at most once. Closing the dialog gives the card back
// (releaseWorkflowCard); Dismiss marks it dismissed (no audit). The start's
// note and audit say "· suggested by Claude". Server-only.

import "server-only";
import { randomBytes } from "node:crypto";
import type { HdQueryable } from "../db-core";
import { hq, hqOne } from "../db-core";
import type { HdFormAnswers, HdFormField, HdTicket } from "../types";
import type { HdStartableType, HdStartWorkflowOptions, HdStartWorkflowResult } from "../workflow-start-shared";
import { WORKFLOW_CARD_CLAIM_MINUTES, WORKFLOW_CARD_CODES, type ClaudeWorkflowCard, type ClaudeWorkflowOutcome } from "./shared";

type Agent = { id: number; name: string; username: string; role: import("../../types").Role };

/** At most this many proposed answers are looked at. */
const MAX_ANSWERS = 60;

// --- What can be started -------------------------------------------------------------------

export interface StartableForClaude {
  options: HdStartWorkflowOptions;
  /** The workflow the ticket itself runs (its latest run), if any. */
  running: { workflow_id: number | null; title: string } | null;
  /** Open requests opened from this ticket (1.20.21 "new"), with their type. */
  openedFrom: { number: number; request_type_id: number | null }[];
}

/** 1.20.21's own answer for this agent and ticket, plus what already runs. */
export async function startableForClaude(agent: Agent, t: HdTicket): Promise<StartableForClaude> {
  const { startWorkflowOptions } = await import("../workflow-start");
  const { getRunForTicket } = await import("../engine");
  const [options, run, opened] = await Promise.all([
    startWorkflowOptions(t, agent),
    getRunForTicket(t.id),
    hq<{ number: number; request_type_id: number | null }>(
      `SELECT number, request_type_id FROM hd_tickets
        WHERE source_ref->>'started_from_ticket_id' = $1 AND deleted_at IS NULL AND status NOT IN ('solved', 'closed')
        ORDER BY id`,
      [String(t.id)]
    ),
  ]);
  const running = run ? { workflow_id: run.workflow_id ?? null, title: String((run.current as { workflow_title?: unknown } | null)?.workflow_title ?? "a workflow") } : null;
  return { options, running, openedFrom: opened };
}

/** Why this type's workflow is already going for the ticket, or null. */
export function alreadyStarted(t: Pick<HdTicket, "number" | "request_type_id">, type: Pick<HdStartableType, "id" | "title" | "workflow">, s: Pick<StartableForClaude, "running" | "openedFrom">): string | null {
  if (s.running && ((type.workflow && s.running.workflow_id === type.workflow.id) || t.request_type_id === type.id)) {
    return `#${t.number} already runs ${s.running.title}.`;
  }
  const o = s.openedFrom.find((x) => x.request_type_id === type.id);
  if (o) return `Request #${o.number} was already opened from #${t.number} as a ${type.title} request.`;
  return null;
}

/** The type list as Claude reads it: questions and whether the directory fills one, never a directory value. */
export function typesForClaude(t: Pick<HdTicket, "number" | "request_type_id">, s: StartableForClaude) {
  return s.options.types.map((x) => ({
    id: x.id,
    title: x.title,
    description: x.description,
    workflow: x.workflow ? { title: x.workflow.title, version: x.workflow.version } : null,
    team: x.team_name,
    already_started: alreadyStarted(t, x, s),
    questions: x.form.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      required: !!f.required,
      ...(f.options?.length ? { options: f.options.map((o) => ({ value: o.value, label: o.label })) } : {}),
      ...(f.help ? { help: f.help } : {}),
      ...(f.key in x.defaults ? { filled_from_directory: true } : {}),
      ...(f.type === "user" ? { answer_with: "the person's email or full name" } : {}),
      ...(f.type === "date" ? { answer_with: "YYYY-MM-DD" } : f.type === "datetime" ? { answer_with: "YYYY-MM-DDTHH:MM" } : {}),
    })),
  }));
}

// --- Claude's answers --------------------------------------------------------------------------

export interface CheckedSuggestion {
  answers: HdFormAnswers;
  /** `person`: a person question (the card and the dialog ask the agent to check it). */
  lines: { key: string; label: string; text: string; person?: boolean }[];
  dropped: { label: string; why: string }[];
  missing: string[];
}

export interface CheckOpts {
  /** Who will review the card (their directory visibility decides whether an email may be matched). */
  agent: Pick<Agent, "role">;
  /**
   * Answers the card itself stored (re-checked at Review): a person question then holds the account id
   * the card resolved. Claude's own values are never taken as ids (security review: "employee 2231").
   */
  stored?: boolean;
}

/** May this agent match a person by email (the directory's email column is not admins-only for them)? */
async function emailVisibleTo(agent: Pick<Agent, "role">): Promise<boolean> {
  const [{ isDirectoryAdmin }, { getColumnVisibility }] = await Promise.all([import("../../directory-viewer"), import("../../directory")]);
  if (isDirectoryAdmin(agent)) return true;
  return (await getColumnVisibility()).email !== "admins";
}

const INT4_MAX = 2 ** 31 - 1;

/**
 * One active account for a person question; else why not. Claude's values: an email (only when the
 * agent may see the directory's email column) or an exact full name, never a number. A stored card
 * answer: the account id the card resolved, in range and still active.
 */
async function resolvePerson(v: unknown, opts: CheckOpts & { emails: boolean }): Promise<{ id: number } | { why: string }> {
  if (opts.stored) {
    const id = typeof v === "number" ? v : NaN;
    const u = Number.isInteger(id) && id > 0 && id <= INT4_MAX ? await hqOne<{ id: number }>("SELECT id FROM users WHERE id = $1 AND status = 'active'", [id]) : undefined;
    return u ? { id: u.id } : { why: "no longer an active person in this workspace" };
  }
  const s = typeof v === "string" ? v.trim().slice(0, 200) : "";
  if (!s || /^[\d\s+()#.-]+$/.test(s)) return { why: "a person is answered with their email or full name" };
  if (s.includes("@")) {
    if (!opts.emails) return { why: "people are matched by their full name here (email addresses are hidden in the directory)" };
    const rows = await hq<{ id: number }>("SELECT id FROM users WHERE status = 'active' AND lower(email) = lower($1) LIMIT 2", [s]);
    return rows.length === 1 ? { id: rows[0].id } : { why: rows.length ? `more than one person has that email` : `no active person has that email` };
  }
  const rows = await hq<{ id: number }>("SELECT id FROM users WHERE status = 'active' AND lower(name) = lower($1) LIMIT 2", [s]);
  if (rows.length === 1) return { id: rows[0].id };
  return { why: rows.length ? `more than one person is called "${s.slice(0, 60)}"` : `no active person is called "${s.slice(0, 60)}"` };
}

/** A proposed value in the shape the form takes (a choice by its label too). */
function coerce(f: HdFormField, v: unknown): unknown {
  if ((f.type === "choice" || f.type === "select") && typeof v === "string") {
    const want = v.trim().toLowerCase();
    const o = f.options?.find((x) => x.value === v) ?? f.options?.find((x) => x.value.toLowerCase() === want || x.label.toLowerCase() === want);
    return o ? o.value : v;
  }
  if (f.type === "checkbox" && typeof v === "string") return v.trim().toLowerCase() === "true" || v.trim().toLowerCase() === "yes" ? true : v.trim().toLowerCase() === "false" || v.trim().toLowerCase() === "no" ? false : v;
  return v;
}

/** Answers Claude proposed (a list of { key, value }, or an object), as `raw` from the tool. */
function proposed(raw: unknown): { key: string; value: unknown }[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((x): x is { key: unknown; value: unknown } => !!x && typeof x === "object")
      .map((x) => ({ key: String(x.key ?? ""), value: x.value }))
      .slice(0, MAX_ANSWERS);
  }
  if (raw && typeof raw === "object") return Object.entries(raw as Record<string, unknown>).slice(0, MAX_ANSWERS).map(([key, value]) => ({ key, value }));
  return [];
}

/**
 * Claude's answers against the type's form, one question at a time (Get help's validateAnswers), so a
 * bad value is left out with the reason. Questions the directory fills keep the directory's value.
 */
export async function checkSuggestedAnswers(type: Pick<HdStartableType, "form" | "defaults">, raw: unknown, requester: string, opts: CheckOpts): Promise<CheckedSuggestion> {
  const { validateAnswers, answerText } = await import("../request-types");
  const answers: HdFormAnswers = {};
  const dropped: CheckedSuggestion["dropped"] = [];
  const seen = new Set<string>();
  const emails = type.form.some((f) => f.type === "user") ? await emailVisibleTo(opts.agent).catch(() => false) : false;
  for (const { key, value } of proposed(raw)) {
    // Security review: a lookup that fails drops that one answer, never the whole turn.
    try {
      await checkOne(key, value);
    } catch {
      const f = type.form.find((x) => x.key === key);
      dropped.push({ label: f?.label ?? key.trim().slice(0, 80), why: "couldn't be checked" });
      if (f) delete answers[f.key];
    }
  }
  async function checkOne(key: string, value: unknown): Promise<void> {
    const f = type.form.find((x) => x.key === key) ?? type.form.find((x) => x.label.toLowerCase() === key.trim().toLowerCase());
    if (!f) {
      if (key.trim()) dropped.push({ label: key.trim().slice(0, 80), why: "not a question on this form" });
      return;
    }
    if (seen.has(f.key)) return;
    seen.add(f.key);
    if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return;
    if (f.key in type.defaults) {
      dropped.push({ label: f.label, why: `filled from ${requester}'s directory entry` });
      return;
    }
    let v = coerce(f, value);
    if (f.type === "user") {
      const p = await resolvePerson(v, { ...opts, emails });
      if ("why" in p) {
        dropped.push({ label: f.label, why: p.why });
        return;
      }
      v = p.id;
    }
    const c = await validateAnswers([{ ...f, required: false }], { [f.key]: v });
    if (!c.ok) {
      dropped.push({ label: f.label, why: c.error.replace(/\.$/, "") });
      return;
    }
    if (f.key in c.value) answers[f.key] = c.value[f.key];
  }
  const ids = type.form.filter((f) => f.type === "user" && typeof answers[f.key] === "number").map((f) => answers[f.key] as number);
  const names = new Map(
    ids.length
      ? (await hq<{ id: number; name: string }>("SELECT id, coalesce(nullif(name, ''), username) AS name FROM users WHERE id = ANY($1::int[])", [ids]).catch(() => [])).map((r) => [r.id, r.name] as const)
      : []
  );
  const lines = type.form
    .filter((f) => f.key in answers)
    .map((f) => ({ key: f.key, label: f.label, text: answerText(f, answers[f.key], names), ...(f.type === "user" ? { person: true } : {}) }));
  // A required checkbox counts as answered only when ticked (as the dialog's answerErrors and validateAnswers treat it).
  const answered = (f: HdFormField) => (f.type === "checkbox" ? answers[f.key] === true : f.key in answers);
  const missing = type.form.filter((f) => f.required && !answered(f) && !(f.key in type.defaults)).map((f) => f.label);
  return { answers, lines, dropped, missing };
}

// --- The card's payload ---------------------------------------------------------------------

export type WorkflowCardPayload = Omit<ClaudeWorkflowCard, "id" | "kind" | "state" | "claimed" | "outcome"> & {
  /** Who the run would be for, when Claude suggested it (a change makes the card stale). */
  requester: { id: number | null; portal_contact_id: number | null };
};

export function workflowCardPayload(t: HdTicket, type: HdStartableType, s: StartableForClaude, checked: CheckedSuggestion, reason: string): WorkflowCardPayload {
  return {
    action: "workflow",
    number: t.number,
    title: `Start "${type.title}"`,
    request_type_id: type.id,
    request_type_title: type.title,
    workflow: { id: type.workflow!.id, title: type.workflow!.title, version: type.workflow!.version },
    mode: s.options.mode,
    answers: checked.answers,
    lines: checked.lines,
    dropped: checked.dropped,
    missing: checked.missing,
    hint: reason.trim().slice(0, 300),
    requester: { id: t.requester_id ?? null, portal_contact_id: t.portal_contact_id ?? null },
  };
}

/** What the panel may see of a stored payload: never the claim's token. */
export function workflowCardOut(payload: Record<string, any>, state: string): Partial<ClaudeWorkflowCard> {
  const { claim, requester: _requester, ...rest } = payload;
  void _requester;
  const at = claim && typeof claim.at === "string" ? Date.parse(claim.at) : NaN;
  const live = state === "applied" && !rest.outcome && Number.isFinite(at) && Date.now() - at < WORKFLOW_CARD_CLAIM_MINUTES * 60_000;
  return { ...rest, claimed: live };
}

// --- Review, release, dismiss -----------------------------------------------------------------

type CardRow = { id: number; ticket_id: number | null; state: string; payload: Record<string, any>; decided_at?: string | null };

async function loadCard(userId: number, cardId: number): Promise<CardRow | undefined> {
  return hqOne<CardRow>(
    "SELECT id, ticket_id, state, payload, decided_at FROM hd_claude_cards WHERE id = $1 AND user_id = $2 AND kind = 'change' AND payload->>'action' = 'workflow'",
    [cardId, userId]
  );
}

const cardView = (c: CardRow): ClaudeWorkflowCard => ({ ...(workflowCardOut(c.payload, c.state) as ClaudeWorkflowCard), id: c.id, kind: "change", action: "workflow", state: c.state as ClaudeWorkflowCard["state"] });

export type ReviewOutcome =
  | { ok: true; claim: string; card: ClaudeWorkflowCard; request_type_id: number; answers: HdFormAnswers }
  | { ok: false; status: 403 | 404 | 409; error: string; code?: string; card?: ClaudeWorkflowCard };

const TAKEN = "This suggestion is already open in another tab, or was used. Nothing was started.";

/** Mark a card stale (it is no longer true); answers the card as it now is. */
async function markStale(c: CardRow, reason: string): Promise<ClaudeWorkflowCard | undefined> {
  const outcome: ClaudeWorkflowOutcome = { kind: "stale", reason };
  const r = await hqOne<CardRow>(
    `UPDATE hd_claude_cards SET state = 'skipped', decided_at = now(), payload = (payload - 'claim') || jsonb_build_object('outcome', $2::jsonb)
      WHERE id = $1 AND NOT (payload ? 'outcome') RETURNING id, ticket_id, state, payload`,
    [c.id, JSON.stringify(outcome)]
  );
  return r ? cardView(r) : undefined;
}

/** Why the suggestion on this card no longer holds for the ticket as it is now, or null. */
export function staleReason(t: HdTicket, p: Record<string, any>, s: StartableForClaude): { reason: string; permanent: boolean } | null {
  // Permanent (the card is marked stale): the requester changed, the workflow already runs, or the
  // ticket became a request since (so the outcome the card showed can't happen any more).
  const req = (p.requester ?? {}) as { id?: number | null; portal_contact_id?: number | null };
  if ((req.id ?? null) !== (t.requester_id ?? null) || (req.portal_contact_id ?? null) !== (t.portal_contact_id ?? null)) {
    return { reason: `#${t.number}'s requester changed since Claude suggested this.`, permanent: true };
  }
  const own = { id: Number(p.request_type_id), title: String(p.request_type_title ?? "that request type"), workflow: p.workflow ?? null };
  const already = alreadyStarted(t, own, s);
  if (already) return { reason: already, permanent: true };
  if (p.mode !== s.options.mode) {
    return {
      reason:
        s.options.mode === "new"
          ? `#${t.number} became a request or started a workflow since Claude suggested this, so it would now open a new request.`
          : `#${t.number} changed since Claude suggested this.`,
      permanent: true,
    };
  }
  // Security review (3): transient (the card stays usable): the ticket solved for now, the requester's
  // Get help access off for now, the type not offered to this agent right now.
  if (!s.options.eligible) return { reason: s.options.reason ?? "A workflow can't be started from this ticket right now.", permanent: false };
  if (!s.options.types.some((x) => x.id === own.id)) {
    return { reason: `${own.title} doesn't start a workflow for ${s.options.requester.name} here right now.`, permanent: false };
  }
  return null;
}

/**
 * Review and start: claim the card (one review at a time), then check the suggestion still holds.
 * The agent must work the ticket and hold workflows.start in its team (the start route's own gate).
 */
export async function reviewWorkflowCard(agent: Agent, cardId: number): Promise<ReviewOutcome> {
  const c = await loadCard(agent.id, cardId);
  if (!c || !c.ticket_id) return { ok: false, status: 404, error: "No such card." };
  const [{ getTicketById }, { canWorkTicket }, { hdCan, HD_FORBIDDEN }] = await Promise.all([import("../tickets"), import("../access"), import("../roles")]);
  const t = await getTicketById(c.ticket_id);
  if (!t || t.deleted_at || !(await canWorkTicket(agent, t))) return { ok: false, status: 404, error: "No such card." };
  if (!(await hdCan(agent, "workflows.start", { teamId: t.team_id }))) return { ok: false, status: 403, error: HD_FORBIDDEN };
  if (c.payload.outcome) return { ok: false, status: 409, error: TAKEN, code: WORKFLOW_CARD_CODES.taken, card: cardView((await settleStartingCards([c]))[0]) };
  const token = randomBytes(18).toString("base64url");
  const claimed = await hqOne<CardRow>(
    `UPDATE hd_claude_cards SET state = 'applied', decided_at = now(),
            payload = payload || jsonb_build_object('claim', jsonb_build_object('token', $3::text, 'at', now()))
      WHERE id = $1 AND user_id = $2 AND kind = 'change' AND payload->>'action' = 'workflow' AND NOT (payload ? 'outcome')
        AND (state = 'offered' OR (state = 'applied' AND decided_at < now() - make_interval(mins => $4)))
      RETURNING id, ticket_id, state, payload`,
    [c.id, agent.id, token, WORKFLOW_CARD_CLAIM_MINUTES]
  );
  if (!claimed) {
    const now = await loadCard(agent.id, cardId);
    return { ok: false, status: 409, error: TAKEN, code: WORKFLOW_CARD_CODES.taken, ...(now ? { card: cardView(now) } : {}) };
  }
  // Checked after the claim, so two tabs never both pass it.
  const s = await startableForClaude(agent, t);
  const why = staleReason(t, claimed.payload, s);
  if (why?.permanent) {
    const card = await markStale(claimed, why.reason);
    return { ok: false, status: 409, error: why.reason, code: WORKFLOW_CARD_CODES.stale, ...(card ? { card } : {}) };
  }
  if (why) {
    // Not now, but perhaps later: the claim is given back and the card stays as it was.
    const card = await releaseWorkflowCard(agent.id, claimed.id, token);
    return { ok: false, status: 409, error: why.reason, code: WORKFLOW_CARD_CODES.notNow, ...(card ? { card } : {}) };
  }
  const type = s.options.types.find((x) => x.id === Number(claimed.payload.request_type_id))!;
  // The card's answers checked again against the form as it is now (a person: the account it stored, still active).
  const checked = await checkSuggestedAnswers(type, claimed.payload.answers ?? {}, s.options.requester.name, { agent, stored: true });
  return { ok: true, claim: token, card: cardView(claimed), request_type_id: type.id, answers: checked.answers };
}

/** The dialog was closed without starting: the card is offered again (only by the tab that holds the claim). */
export async function releaseWorkflowCard(userId: number, cardId: number, claim: string): Promise<ClaudeWorkflowCard | undefined> {
  const r = await hqOne<CardRow>(
    `UPDATE hd_claude_cards SET state = 'offered', decided_at = NULL, payload = payload - 'claim'
      WHERE id = $1 AND user_id = $2 AND kind = 'change' AND payload->>'action' = 'workflow' AND state = 'applied'
        AND NOT (payload ? 'outcome') AND payload->'claim'->>'token' = $3
      RETURNING id, ticket_id, state, payload`,
    [cardId, userId, claim]
  );
  return r ? cardView(r) : undefined;
}

/** Dismiss: an offered card, or the one this tab holds the claim on. Not audited. */
export async function dismissWorkflowCard(userId: number, cardId: number, claim: string | null): Promise<ClaudeWorkflowCard | undefined> {
  const outcome: ClaudeWorkflowOutcome = { kind: "dismissed" };
  const r = await hqOne<CardRow>(
    `UPDATE hd_claude_cards SET state = 'skipped', decided_at = now(), payload = (payload - 'claim') || jsonb_build_object('outcome', $3::jsonb)
      WHERE id = $1 AND user_id = $2 AND kind = 'change' AND payload->>'action' = 'workflow' AND NOT (payload ? 'outcome')
        AND (state = 'offered' OR (state = 'applied' AND payload->'claim'->>'token' = $4)
             OR (state = 'applied' AND decided_at < now() - make_interval(mins => $5)))
      RETURNING id, ticket_id, state, payload`,
    [cardId, userId, JSON.stringify(outcome), claim ?? "", WORKFLOW_CARD_CLAIM_MINUTES]
  );
  return r ? cardView(r) : undefined;
}

// --- A start from the card (lib/helpdesk/workflow-start) -------------------------------------------

export interface CardRef {
  id: number;
  claim: string;
}

/** The start body's `claude_card`: absent (null), a reference, or "bad". */
export function cleanCardRef(v: unknown): CardRef | null | "bad" {
  if (v === undefined || v === null) return null;
  if (!v || typeof v !== "object") return "bad";
  const o = v as Record<string, unknown>;
  const id = o.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || id >= 2 ** 31) return "bad";
  if (typeof o.claim !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(o.claim)) return "bad";
  return { id, claim: o.claim };
}

/**
 * Inside the start's transaction, under the ticket's row lock: the card must be this agent's
 * workflow card for this ticket and type, claimed by this review (`claim`) and not yet used.
 * Locks it until the start commits. Answers the refusal sentence, or null.
 */
export async function takeCardForStart(client: HdQueryable, userId: number, ticketId: number, ref: CardRef, typeId: number): Promise<string | null> {
  const c = await hqOne<CardRow>(
    `SELECT id, ticket_id, state, payload FROM hd_claude_cards
      WHERE id = $1 AND user_id = $2 AND ticket_id = $3 AND kind = 'change' AND payload->>'action' = 'workflow' FOR UPDATE`,
    [ref.id, userId, ticketId],
    client
  );
  if (!c) return "That Claude suggestion isn't one of yours on this ticket. Nothing was started.";
  if (c.state !== "applied" || c.payload.outcome || c.payload.claim?.token !== ref.claim) return TAKEN;
  if (Number(c.payload.request_type_id) !== typeId) return `Claude's suggestion is for ${String(c.payload.request_type_title ?? "another request type")}. Start it without the suggestion, or choose that type.`;
  return null;
}

/** In the same transaction: the card records that it was started (the run follows after the commit). */
export async function recordCardStart(client: HdQueryable, cardId: number, outcome: Extract<ClaudeWorkflowOutcome, { kind: "started" }>): Promise<void> {
  await client.query(
    "UPDATE hd_claude_cards SET state = 'applied', decided_at = now(), payload = (payload - 'claim') || jsonb_build_object('outcome', $2::jsonb) WHERE id = $1",
    [cardId, JSON.stringify(outcome)]
  );
}

/**
 * After the run (and on a repeat of the same start key): whether it started, and the workflow and
 * version it pinned. Only this agent's card whose recorded start is that request.
 */
export async function finishCardStart(cardId: number, userId: number, r: HdStartWorkflowResult): Promise<void> {
  const outcome: ClaudeWorkflowOutcome = { kind: "started", mode: r.mode, number: r.request.number, started: r.started, workflow: r.workflow };
  await hq(
    `UPDATE hd_claude_cards SET payload = jsonb_set(payload, '{outcome}', $3::jsonb)
      WHERE id = $1 AND user_id = $2 AND payload->>'action' = 'workflow'
        AND payload->'outcome'->>'kind' = 'started' AND (payload->'outcome'->>'number')::int = $4`,
    [cardId, userId, JSON.stringify(outcome), r.request.number]
  ).catch(() => undefined);
}

/**
 * Security review (4): cards whose start was recorded but whose run never reported (the process
 * stopped between the commit and finishCardStart) are settled when they are loaded: the request's run
 * if there is one, else "didn't start" once the start is clearly over (START_PENDING_SECONDS).
 * Mutates and answers the rows.
 */
export async function settleStartingCards<R extends { id: number; payload: Record<string, any>; decided_at?: string | null }>(rows: R[]): Promise<R[]> {
  const pending = rows.filter((c) => c.payload?.action === "workflow" && c.payload.outcome?.kind === "started" && (c.payload.outcome.started ?? null) === null);
  if (!pending.length) return rows;
  const [{ getRunForTicket }, { START_PENDING_SECONDS }] = await Promise.all([import("../engine"), import("../workflow-start")]);
  for (const c of pending) {
    try {
      const o = c.payload.outcome as Extract<ClaudeWorkflowOutcome, { kind: "started" }>;
      const t = await hqOne<{ id: number }>("SELECT id FROM hd_tickets WHERE number = $1", [Number(o.number)]);
      const run = t ? await getRunForTicket(t.id) : undefined;
      const at = c.decided_at ? Date.parse(String(c.decided_at)) : NaN;
      let next: typeof o | null = null;
      if (run) next = { ...o, started: true, workflow: { title: String((run.current as { workflow_title?: unknown } | null)?.workflow_title ?? "Workflow"), version: Number(run.workflow_version) } };
      else if (!t || (Number.isFinite(at) && Date.now() - at > START_PENDING_SECONDS * 1000)) next = { ...o, started: false, workflow: null };
      if (!next) continue;
      await hq("UPDATE hd_claude_cards SET payload = jsonb_set(payload, '{outcome}', $2::jsonb) WHERE id = $1", [c.id, JSON.stringify(next)]);
      c.payload = { ...c.payload, outcome: next };
    } catch {
      /* left as "Starting…" for the next load */
    }
  }
  return rows;
}
