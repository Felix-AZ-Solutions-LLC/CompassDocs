// Helpdesk 1.19.1: recurring tickets (agent V8). Schedules per team that
// open a ticket on a pattern (lib/helpdesk/recurring-shared), honouring the
// team's calendar (agent L): a holiday moves, skips or keeps the date.
//
//   Engine      recurringSweep, one entry in lib/periodic HELPDESK_SWEEPS.
//               Under its own transaction-scoped advisory try-lock it claims
//               the due schedules (FOR UPDATE SKIP LOCKED), and for each
//               claims the occurrence key in hd_recurring_runs in the same
//               transaction that inserts the ticket (A's insertTicketTx) and
//               moves next_run_at on, so a crash, a retry or a second
//               instance never opens two. After commit the usual
//               after-create hooks run (A's afterTicketCreated: assignment,
//               rules, workflow start, notices), exactly what createTicket
//               does. A schedule that fell behind (the server was down)
//               opens one ticket for the missed run, then carries on from
//               now.
//   Tickets     source 'recurring', source_ref {recurring_id, occurrence},
//               no requester (nobody gets a receipt), the opening message
//               from "Recurring schedule". With a due in business days the
//               resolve due is the close of that working day.
//   Open now    openRecurringNow: one ticket straight away under its own
//               key; the schedule's next run is unchanged.
//
// Permissions (the routes): settings.manage for every team, else
// agents.manage_team in the schedule's team (a team lead). Server-only.
//
// 1.20.16: drafts from Claude (saveRecurringDraft; the model of 1.20.14's
// checklist drafts, lib/helpdesk/claude-drafts-shared). A new schedule
// Claude drafts is saved paused and unpublished: the sweep (published = 1)
// and Open one now never open a ticket from it, and it can't be switched on
// until a person publishes it. Changes Claude proposes to a published
// schedule wait in `draft` while the live one keeps running. Publishing is
// explicit and names the reviewed draft (saveRecurring publish /
// publishDraft with draftAt). Saves lock the row. Validation is the settings
// API's own (validateRecurringInput).

import "server-only";
import type { PoolClient } from "pg";
import { logEvent } from "../log";
import { hq, hqOne, withTx, type HdQueryable } from "./db-core";
import { CLEAR_DRAFT_SQL, NO_CHANGES_WAITING, STALE_DISCARD_MESSAGE, STALE_DRAFT_MESSAGE, sameDraftInstant, type HdDraftVia } from "./claude-drafts-shared";
import { hoursForTeam, invalidateCalendarCache } from "./calendars";
import { hdCan } from "./roles";
import { assignable, isPriorityValue } from "./tickets";
import { wallClock } from "./sla";
import type { HdTicketRow } from "./types";
import type { SessionUser } from "../types";
import {
  HD_ASSIGN_MODES,
  RECURRING_LIMITS,
  dayNumber,
  dueAfterBusinessDays,
  fromDayNumber,
  isHolidayRule,
  nextOccurrences,
  occurrenceForKey,
  occurrenceNote,
  parseIsoDate,
  renderTemplate,
  shortDateLabel,
  validTimezone,
  validatePattern,
  type CivilDate,
  type HdHolidayRule,
  type HdRecurring,
  type HdRecurringAssignMode,
  type HdRecurringDraft,
  type HdRecurringPreviewItem,
  type RecurringPattern,
} from "./recurring-shared";

/**
 * The sweep's advisory lock (one instance sweeps at a time; the row claims
 * make it safe anyway). Every helpdesk lock key is its own:
 *   7_281_901 SLA sweep (db-sla)          7_281_917 calendar recompute
 *   7_281_931 retention batches           7_281_962 assignment per-agent class (two-key)
 *   7_281_963 assignment sweep            7_281_971 recurring sweep (this)
 *   7_281_983 status services per team (two-key with the service id, status-teams)
 *   7_281_991 asset source sync claim (assets ASSETS_SYNC_LOCK)
 *   7_281_992 Intune device sync claim (assets INTUNE_SYNC_LOCK, 1.19.4)
 *   7_281_947 recycle bin purge sweep (1.19.4 C7, recycle-bin BIN_PURGE_LOCK)
 *   7_281_977 webhook delivery upkeep (1.19.4 C2, webhooks WEBHOOK_SWEEP_LOCK; two-key with the hook id for claims)
 * test/helpdesk-recurring checks they stay distinct.
 */
export const RECURRING_SWEEP_LOCK = 7_281_971;

/** The opening message's author and the ticket's requester name. */
export const RECURRING_AUTHOR = "Recurring schedule";

// --- Rows -------------------------------------------------------------------------------

interface Row {
  id: number;
  team_id: number;
  team_name: string;
  desk_department_id: number;
  subject: string;
  body: string;
  priority: string;
  request_type_id: number | null;
  assign_mode: string;
  assignee_id: number | null;
  assignee_name: string | null;
  due_business_days: number | null;
  pattern: RecurringPattern;
  holiday_rule: string;
  timezone: string;
  enabled: number;
  next_run_at: string | null;
  next_key: string | null;
  last_run_at: string | null;
  last_ticket_number: number | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  published: number;
  draft: HdRecurringDraft | null;
  draft_by_name: string;
  draft_at: string | null;
  draft_via: string;
  draft_base_at: string | null;
}

/** 1.20.16 review fix: publishing changes over a schedule a person edited after Claude drafted them. */
export const SCHEDULE_CHANGED_SINCE = "The schedule changed since this draft was made. Review it again: discard the changes, or ask Claude for new ones.";

const SELECT = `SELECT r.*, t.name AS team_name, t.desk_department_id, u.name AS assignee_name,
       (SELECT tk.number FROM hd_recurring_runs rr JOIN hd_tickets tk ON tk.id = rr.ticket_id
         WHERE rr.recurring_id = r.id AND tk.deleted_at IS NULL ORDER BY rr.created_at DESC LIMIT 1) AS last_ticket_number
  FROM hd_recurring r JOIN hd_teams t ON t.id = r.team_id LEFT JOIN users u ON u.id = r.assignee_id`;

function toApi(r: Row): HdRecurring {
  return {
    id: r.id,
    team_id: r.team_id,
    team_name: r.team_name,
    desk_department_id: r.desk_department_id,
    subject: r.subject,
    body: r.body,
    priority: r.priority,
    request_type_id: r.request_type_id,
    assign_mode: (HD_ASSIGN_MODES as readonly string[]).includes(r.assign_mode) ? (r.assign_mode as HdRecurringAssignMode) : "team_rules",
    assignee_id: r.assignee_id,
    assignee_name: r.assignee_name,
    due_business_days: r.due_business_days,
    pattern: r.pattern,
    holiday_rule: isHolidayRule(r.holiday_rule) ? r.holiday_rule : "next_working_day",
    timezone: r.timezone,
    enabled: r.enabled === 1,
    next_run_at: r.next_run_at,
    last_run_at: r.last_run_at,
    last_ticket_number: r.last_ticket_number,
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    published: r.published === 1,
    draft: r.draft ?? null,
    draft_by_name: r.draft_by_name ?? "",
    draft_at: r.draft_at ?? null,
    draft_via: r.draft_via ?? "",
  };
}

export async function getRecurring(id: number): Promise<HdRecurring | undefined> {
  const r = await hqOne<Row>(`${SELECT} WHERE r.id = $1`, [id]);
  return r ? toApi(r) : undefined;
}

/** Schedules of these teams ("all" = every team), soonest first, paused last. */
export async function listRecurring(teams: number[] | "all"): Promise<HdRecurring[]> {
  const rows =
    teams === "all"
      ? await hq<Row>(`${SELECT} ORDER BY r.enabled DESC, r.next_run_at ASC NULLS LAST, r.id`)
      : await hq<Row>(`${SELECT} WHERE r.team_id = ANY($1::int[]) ORDER BY r.enabled DESC, r.next_run_at ASC NULLS LAST, r.id`, [teams]);
  return rows.map(toApi);
}

// --- Permissions ---------------------------------------------------------------------------

/** May this person manage schedules of every team? */
export function canManageAllRecurring(user: SessionUser): Promise<boolean> {
  return hdCan(user, "settings.manage");
}

/**
 * May this person manage this team's schedules (settings.manage, or agents.manage_team in it)?
 * 1.20.23 (lib/helpdesk/desk-departments): a schedule is its team's and so in its team's desk
 * department; "Manage a desk department" manages every schedule of the teams in the departments
 * of the teams they belong to (review M3: membership, never "sees every team's tickets").
 * Review N1: for anyone but a desk Admin the team's department must be one of their own teams'
 * FIRST; only then does agents.manage_team in the team (which teams.manage widens to every
 * team) or "Manage a desk department" count.
 */
export async function canManageRecurringTeam(user: SessionUser, teamId: number, ctx?: RecurringManageContext): Promise<boolean> {
  const c = ctx ?? (await recurringManageContext(user));
  if (c.all) return true;
  if (!c.departments.length) return false;
  const deptId = c.teamDept?.get(teamId) ?? (await hqOne<{ desk_department_id: number }>("SELECT desk_department_id FROM hd_teams WHERE id = $1", [teamId]))?.desk_department_id;
  if (deptId === undefined || !c.departments.includes(deptId)) return false;
  return c.departmentManager || hdCan(user, "agents.manage_team", { teamId });
}

/** What canManageRecurringTeam needs about the person, worked out once per request (review L5). */
export interface RecurringManageContext {
  /** settings.manage: every team. */
  all: boolean;
  /** The desk departments of the teams they belong to (review N1: the only ones whose schedules they manage). */
  departments: number[];
  /** They hold "Manage a desk department": every team of those departments. */
  departmentManager: boolean;
  /** Teams' departments already loaded (recurringTeams), to skip a lookup per team. */
  teamDept?: Map<number, number>;
}

export async function recurringManageContext(user: SessionUser): Promise<RecurringManageContext> {
  if (await hdCan(user, "settings.manage")) return { all: true, departments: [], departmentManager: true };
  const { deskDepartmentMemberScope } = await import("./desk-departments");
  return { all: false, departments: await deskDepartmentMemberScope(user), departmentManager: await hdCan(user, "departments.manage") };
}

/** 1.20.23: who opens Desk settings → Recurring tickets and the recurring routes (any one). */
export const RECURRING_GATE_CAPS = ["settings.manage", "agents.manage_team", "departments.manage"] as const;

export interface RecurringTeam {
  id: number;
  name: string;
  /** The team calendar's zone (a new schedule's default). */
  timezone: string;
  /** Who a schedule can assign to: the team's active members. */
  members: { id: number; name: string }[];
  /** 1.20.23: the team's desk department (a schedule's request type is one it sees). */
  desk_department_id: number;
}

/** The teams whose schedules this person manages, with each team's calendar zone and members. */
export async function recurringTeams(user: SessionUser): Promise<RecurringTeam[]> {
  const teams = await hq<{ id: number; name: string; desk_department_id: number; members: { id: number; name: string }[] }>(
    `SELECT t.id, t.name, t.desk_department_id,
            COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', COALESCE(NULLIF(u.name, ''), u.username)) ORDER BY u.name)
                        FROM hd_team_members m JOIN users u ON u.id = m.user_id AND u.status = 'active' WHERE m.team_id = t.id), '[]') AS members
       FROM hd_teams t ORDER BY t.position, t.name`
  );
  // Review L5: the person's side once, not per team.
  const ctx: RecurringManageContext = { ...(await recurringManageContext(user)), teamDept: new Map(teams.map((t) => [t.id, t.desk_department_id])) };
  const out: RecurringTeam[] = [];
  for (const t of teams) {
    if (!(await canManageRecurringTeam(user, t.id, ctx))) continue;
    out.push({ ...t, timezone: (await hoursForTeam(t.id)).timezone });
  }
  return out;
}

// --- Input ------------------------------------------------------------------------------------

export interface RecurringInput {
  team_id: number;
  subject: string;
  body: string;
  priority: string;
  request_type_id: number | null;
  assign_mode: HdRecurringAssignMode;
  assignee_id: number | null;
  due_business_days: number | null;
  pattern: RecurringPattern;
  holiday_rule: HdHolidayRule;
  timezone: string;
  enabled: boolean;
}

type Check<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The full input from a request body merged onto `base` (an existing
 * schedule for a PATCH), checked against the database: the team exists,
 * the request type exists, a named assignee can take the team's tickets.
 * An empty time zone means the team calendar's.
 */
export async function validateRecurringInput(raw: Record<string, unknown>, base?: RecurringInput): Promise<Check<RecurringInput>> {
  const pick = <K extends keyof RecurringInput>(k: K): unknown => (raw[k] !== undefined ? raw[k] : base?.[k]);
  const teamId = pick("team_id");
  if (typeof teamId !== "number" || !Number.isInteger(teamId) || teamId <= 0) return { ok: false, error: "Choose a team." };
  const team = await hqOne<{ id: number }>("SELECT id FROM hd_teams WHERE id = $1", [teamId]);
  if (!team) return { ok: false, error: "That team does not exist." };

  const subject = typeof pick("subject") === "string" ? (pick("subject") as string).trim() : "";
  if (!subject) return { ok: false, error: "Give the ticket a subject." };
  if (subject.length > RECURRING_LIMITS.subject) return { ok: false, error: `Keep the subject under ${RECURRING_LIMITS.subject} characters.` };
  const body = pick("body") ?? "";
  if (typeof body !== "string" || body.length > RECURRING_LIMITS.body) return { ok: false, error: "The description is too long." };

  const priority = pick("priority") ?? "normal";
  if (!isPriorityValue(priority)) return { ok: false, error: "Choose a priority." };

  const rtRaw = pick("request_type_id") ?? null;
  let requestTypeId: number | null = null;
  if (rtRaw !== null) {
    if (typeof rtRaw !== "number" || !Number.isInteger(rtRaw)) return { ok: false, error: "Choose a request type." };
    if (!(await hqOne("SELECT 1 FROM hd_request_types WHERE id = $1", [rtRaw]))) return { ok: false, error: "That request type does not exist." };
    requestTypeId = rtRaw;
    // 1.20.23 review L2: a request type of the team's desk department or of All departments. Checked
    // when the type or the team changes, so switching an older schedule off always works.
    if (!base || base.request_type_id !== requestTypeId || base.team_id !== teamId) {
      const { recurringTypeRefusal } = await import("./desk-departments");
      const refusal = await recurringTypeRefusal(teamId, requestTypeId);
      if (refusal) return { ok: false, error: refusal };
    }
  }

  const mode = pick("assign_mode") ?? "team_rules";
  if (!(HD_ASSIGN_MODES as readonly unknown[]).includes(mode)) return { ok: false, error: "Choose who the ticket goes to." };
  let assigneeId: number | null = null;
  if (mode === "user") {
    const a = pick("assignee_id");
    if (typeof a !== "number" || !Number.isInteger(a)) return { ok: false, error: "Choose who the ticket is assigned to." };
    if (!(await assignable(a, teamId))) return { ok: false, error: "That person can't take this team's tickets." };
    assigneeId = a;
  }

  const dueRaw = pick("due_business_days") ?? null;
  let due: number | null = null;
  if (dueRaw !== null) {
    if (typeof dueRaw !== "number" || !Number.isInteger(dueRaw) || dueRaw < 1 || dueRaw > RECURRING_LIMITS.dueDays) {
      return { ok: false, error: `A due date is 1 to ${RECURRING_LIMITS.dueDays} business days.` };
    }
    due = dueRaw;
  }

  const p = validatePattern(pick("pattern"));
  if (!p.ok) return p;
  const rule = pick("holiday_rule") ?? "next_working_day";
  if (!isHolidayRule(rule)) return { ok: false, error: "Say what a holiday does to the date." };

  let tz = pick("timezone") ?? "";
  if (tz === "" || tz === null) tz = (await hoursForTeam(teamId)).timezone;
  if (!validTimezone(tz)) return { ok: false, error: "That time zone isn't recognized." };

  const enabled = pick("enabled") ?? true;
  if (typeof enabled !== "boolean") return { ok: false, error: "Enabled is on or off." };

  return {
    ok: true,
    value: {
      team_id: teamId,
      subject,
      body,
      priority,
      request_type_id: requestTypeId,
      assign_mode: mode as HdRecurringAssignMode,
      assignee_id: assigneeId,
      due_business_days: due,
      pattern: p.value,
      holiday_rule: rule,
      timezone: tz as string,
      enabled,
    },
  };
}

export function inputOf(r: HdRecurring): RecurringInput {
  return {
    team_id: r.team_id,
    subject: r.subject,
    body: r.body,
    priority: r.priority,
    request_type_id: r.request_type_id,
    assign_mode: r.assign_mode,
    assignee_id: r.assignee_id,
    due_business_days: r.due_business_days,
    pattern: r.pattern,
    holiday_rule: r.holiday_rule,
    timezone: r.timezone,
    enabled: r.enabled,
  };
}

// --- Next runs ----------------------------------------------------------------------------------

/**
 * The next run after `after`: the first occurrence (holiday rule applied)
 * whose key has not opened a ticket yet. Null when the pattern never falls
 * again (or the schedule is off).
 */
export async function computeNextRun(
  s: Pick<RecurringInput, "team_id" | "pattern" | "holiday_rule" | "timezone" | "enabled"> & { id?: number },
  after: number,
  client?: HdQueryable
): Promise<{ at: Date; key: string } | null> {
  if (!s.enabled) return null;
  const hours = await hoursForTeam(s.team_id, client);
  const occ = nextOccurrences(s.pattern, { tz: s.timezone, rule: s.holiday_rule, hours, after, count: 6 });
  if (!occ.length) return null;
  let ran = new Set<string>();
  if (s.id) {
    const rows = await hq<{ occurrence_key: string }>(
      "SELECT occurrence_key FROM hd_recurring_runs WHERE recurring_id = $1 AND occurrence_key = ANY($2::text[])",
      [s.id, occ.map((o) => o.key)],
      client
    );
    ran = new Set(rows.map((r) => r.occurrence_key));
  }
  const o = occ.find((x) => !ran.has(x.key));
  return o ? { at: new Date(o.at), key: o.key } : null;
}

/** The next `count` runs as the editor previews them ("Mon Dec 7", with what a holiday did). */
export async function previewRuns(
  s: Pick<RecurringInput, "team_id" | "pattern" | "holiday_rule" | "timezone">,
  count = 3,
  now = Date.now()
): Promise<HdRecurringPreviewItem[]> {
  const hours = await hoursForTeam(s.team_id);
  return nextOccurrences(s.pattern, { tz: s.timezone, rule: s.holiday_rule, hours, after: now, count }).map((o) => ({
    at: new Date(o.at).toISOString(),
    label: shortDateLabel(o.date),
    note: occurrenceNote(o),
  }));
}

// --- Writes -------------------------------------------------------------------------------------------

export async function createRecurring(input: RecurringInput, createdBy: number | null, now = Date.now()): Promise<HdRecurring> {
  const next = await computeNextRun(input, now);
  const row = await hqOne<{ id: number }>(
    `INSERT INTO hd_recurring (team_id, subject, body, priority, request_type_id, assign_mode, assignee_id, due_business_days,
        pattern, holiday_rule, timezone, enabled, next_run_at, next_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
    [
      input.team_id,
      input.subject,
      input.body,
      input.priority,
      input.request_type_id,
      input.assign_mode,
      input.assignee_id,
      input.due_business_days,
      JSON.stringify(input.pattern),
      input.holiday_rule,
      input.timezone,
      input.enabled ? 1 : 0,
      next?.at ?? null,
      next?.key ?? null,
      createdBy,
    ]
  );
  return (await getRecurring(row!.id))!;
}

export async function updateRecurring(id: number, input: RecurringInput, now = Date.now()): Promise<HdRecurring | undefined> {
  const next = await computeNextRun({ ...input, id }, now);
  const row = await hqOne<{ id: number }>(
    `UPDATE hd_recurring SET team_id = $2, subject = $3, body = $4, priority = $5, request_type_id = $6, assign_mode = $7, assignee_id = $8,
        due_business_days = $9, pattern = $10, holiday_rule = $11, timezone = $12, enabled = $13, next_run_at = $14, next_key = $15, updated_at = now()
      WHERE id = $1 RETURNING id`,
    [
      id,
      input.team_id,
      input.subject,
      input.body,
      input.priority,
      input.request_type_id,
      input.assign_mode,
      input.assignee_id,
      input.due_business_days,
      JSON.stringify(input.pattern),
      input.holiday_rule,
      input.timezone,
      input.enabled ? 1 : 0,
      next?.at ?? null,
      next?.key ?? null,
    ]
  );
  return row ? getRecurring(id) : undefined;
}

export async function deleteRecurring(id: number): Promise<HdRecurring | undefined> {
  const s = await getRecurring(id);
  if (!s) return undefined;
  await hq("DELETE FROM hd_recurring WHERE id = $1", [id]);
  return s;
}

// --- Drafts from Claude (1.20.16) --------------------------------------------------------------------

/** A draft or publish refused (the sentence, and the status the route answers). */
export class RecurringDraftError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const draftOfInput = (i: RecurringInput): HdRecurringDraft => {
  const { enabled: _enabled, ...rest } = i;
  void _enabled;
  return rest;
};

/** The schedule's own fields as a draft (what a proposal starts from). */
export const draftOfSchedule = (s: HdRecurring): HdRecurringDraft => draftOfInput(inputOf(s));

/**
 * Check a recurring draft as Desk settings would, without saving it (the
 * connector's hd_draft_recurring and Claude in the desk's card). Fields not
 * sent come from `base` (an existing schedule's draft or live copy). Never
 * carries on or off.
 */
export async function checkRecurringDraft(raw: unknown, base?: HdRecurringDraft): Promise<HdRecurringDraft> {
  const r = { ...((raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>) };
  delete r.enabled;
  const v = await validateRecurringInput(r, base ? { ...base, enabled: false } : undefined);
  if (!v.ok) throw new RecurringDraftError(v.error, 400);
  return draftOfInput(v.value);
}

const DRAFT_SET = (from: number) =>
  `team_id = $${from}, subject = $${from + 1}, body = $${from + 2}, priority = $${from + 3}, request_type_id = $${from + 4}, assign_mode = $${from + 5}, assignee_id = $${from + 6},
   due_business_days = $${from + 7}, pattern = $${from + 8}, holiday_rule = $${from + 9}, timezone = $${from + 10}`;
const draftValues = (d: HdRecurringDraft) => [
  d.team_id,
  d.subject,
  d.body,
  d.priority,
  d.request_type_id,
  d.assign_mode,
  d.assignee_id,
  d.due_business_days,
  JSON.stringify(d.pattern),
  d.holiday_rule,
  d.timezone,
];

/**
 * Save a recurring draft for a person to review (Claude's
 * hd_draft_recurring, and Save as draft on a Claude in the desk card). The
 * caller checked the person may manage the team(s). Without `id`: a new
 * schedule, paused and unpublished, with no next run. With `id`: an
 * unpublished draft is replaced; a published schedule keeps running and gets
 * the proposal in `draft` (replacing an earlier one). Fields not sent come
 * from the current draft, else the live schedule. The row is locked.
 */
export async function saveRecurringDraft(
  draft: HdRecurringDraft,
  actor: { id: number | null; name: string; via: HdDraftVia },
  id?: number
): Promise<{ schedule: HdRecurring; kind: "new" | "replaced" | "changes" }> {
  const meta = [actor.id, actor.name, actor.via];
  if (id === undefined) {
    const newId = await withTx(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [RECURRING_SWEEP_LOCK, draft.team_id]);
      const n = await hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_recurring WHERE team_id = $1", [draft.team_id], client);
      if ((n?.n ?? 0) >= RECURRING_LIMITS.perTeam) throw new RecurringDraftError(`A team can have at most ${RECURRING_LIMITS.perTeam} recurring tickets.`, 409);
      const row = await hqOne<{ id: number }>(
        `INSERT INTO hd_recurring (team_id, subject, body, priority, request_type_id, assign_mode, assignee_id, due_business_days,
            pattern, holiday_rule, timezone, enabled, next_run_at, next_key, created_by, published, draft_by, draft_by_name, draft_at, draft_via)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, NULL, NULL, $12, 0, $12, $13, now(), $14) RETURNING id`,
        [...draftValues(draft), ...meta],
        client
      );
      return row!.id;
    });
    return { schedule: (await getRecurring(newId))!, kind: "new" };
  }
  const kind = await withTx(async (client) => {
    const before = await hqOne<{ published: number }>("SELECT published FROM hd_recurring WHERE id = $1 FOR UPDATE", [id], client);
    if (!before) throw new RecurringDraftError(`No recurring ticket with id ${id}.`, 404);
    if (before.published !== 1) {
      await client.query(
        `UPDATE hd_recurring SET ${DRAFT_SET(2)}, enabled = 0, next_run_at = NULL, next_key = NULL, updated_at = now(),
                draft_by = $13, draft_by_name = $14, draft_at = now(), draft_via = $15
          WHERE id = $1 AND published = 0`,
        [id, ...draftValues(draft), ...meta]
      );
      return "replaced" as const;
    }
    // draft_base_at (review fix): the live schedule these changes were drafted against.
    await client.query("UPDATE hd_recurring SET draft = $2, draft_by = $3, draft_by_name = $4, draft_at = now(), draft_via = $5, draft_base_at = updated_at WHERE id = $1", [
      id,
      JSON.stringify(draft),
      ...meta,
    ]);
    return "changes" as const;
  });
  return { schedule: (await getRecurring(id))!, kind };
}

/**
 * Save a schedule from Desk settings (the PATCH; the caller checked the
 * team). The row is locked while it is read and written. 1.20.16:
 *   - a plain save edits the live schedule, or the unpublished draft, and
 *     keeps any changes waiting; an unpublished draft stays paused (switching
 *     it on is refused, 409);
 *   - `publish` (an unpublished draft) makes it a real schedule and switches
 *     it on (unless the save says enabled false); `publishDraft` applies the
 *     changes waiting on a published schedule (fields not sent come from that
 *     draft) and keeps it on or off as it is. Both name the draft the person
 *     reviewed (`draftAt`, 409 when Claude saved a newer one).
 * Answers the input it saved too, so the route can check the team it moved to.
 */
export async function saveRecurring(
  id: number,
  raw: Record<string, unknown>,
  opts: { publish?: boolean; publishDraft?: boolean; draftAt?: unknown; mayUseTeam?: (teamId: number) => Promise<boolean> } = {},
  now = Date.now()
): Promise<{ before: HdRecurring; after: HdRecurring; published: boolean } | undefined> {
  const out = await withTx(async (client) => {
    const row = await hqOne<Row>(`${SELECT} WHERE r.id = $1 FOR UPDATE OF r`, [id], client);
    if (!row) return undefined;
    const before = toApi(row);
    const publish = opts.publish === true && !before.published;
    const publishDraft = opts.publishDraft === true;
    if (publishDraft && !(before.published && before.draft)) throw new RecurringDraftError(NO_CHANGES_WAITING, 409);
    if ((publish || publishDraft) && !sameDraftInstant(before.draft_at, opts.draftAt)) throw new RecurringDraftError(STALE_DRAFT_MESSAGE, 409);
    // Review fix: the changes were drafted against the schedule as it was; a person's edit since would be undone unseen.
    if (publishDraft && row.draft_base_at && new Date(row.updated_at).getTime() > new Date(row.draft_base_at).getTime()) {
      throw new RecurringDraftError(SCHEDULE_CHANGED_SINCE, 409);
    }
    const base: RecurringInput = publishDraft ? { ...before.draft!, enabled: before.enabled } : inputOf(before);
    const v = await validateRecurringInput(raw, base);
    if (!v.ok) throw new RecurringDraftError(v.error, 400);
    const input = v.value;
    if (input.team_id !== before.team_id && opts.mayUseTeam && !(await opts.mayUseTeam(input.team_id))) {
      throw new RecurringDraftError("You can only schedule tickets for teams you lead.", 403);
    }
    const editsDraft = !before.published && !publish;
    if (editsDraft) {
      if (raw.enabled === true) throw new RecurringDraftError("This schedule is a draft from Claude. Publish it to switch it on.", 409);
      input.enabled = false;
    } else if (publish) input.enabled = raw.enabled !== false;
    const next = await computeNextRun({ ...input, id }, now, client);
    await client.query(
      `UPDATE hd_recurring SET ${DRAFT_SET(2)}, enabled = $13, next_run_at = $14, next_key = $15, updated_at = now()${publish ? ", published = 1" : ""}${
        publish || publishDraft ? `, ${CLEAR_DRAFT_SQL}, draft_base_at = NULL` : ""
      }${
        // Review fix: a person's edit of an unpublished draft is a new version: a publish must name it.
        editsDraft ? ", draft_at = now()" : ""
      }
        WHERE id = $1`,
      [id, ...draftValues(draftOfInput(input)), input.enabled ? 1 : 0, next?.at ?? null, next?.key ?? null]
    );
    return { before, published: publish || publishDraft };
  });
  if (!out) return undefined;
  return { before: out.before, after: (await getRecurring(id))!, published: out.published };
}

/**
 * Drop the changes waiting on a published schedule (it keeps running as it
 * is). Undefined when nothing waits. With `draftAt`, only the draft the
 * person saw (409 when Claude saved a newer one).
 */
export async function discardRecurringDraft(id: number, draftAt?: unknown): Promise<HdRecurring | undefined> {
  const gone = await withTx(async (client) => {
    const row = await hqOne<Row>(`${SELECT} WHERE r.id = $1 FOR UPDATE OF r`, [id], client);
    if (!row || row.published !== 1 || !row.draft) return undefined;
    if (draftAt !== undefined && draftAt !== null && !sameDraftInstant(row.draft_at, draftAt)) throw new RecurringDraftError(STALE_DISCARD_MESSAGE, 409);
    await client.query(`UPDATE hd_recurring SET ${CLEAR_DRAFT_SQL}, draft_base_at = NULL WHERE id = $1`, [id]);
    return toApi(row);
  });
  return gone;
}

/** A schedule in plain words, for Claude's hd_list_recurring and the draft cards. */
export async function recurringInWords(d: HdRecurringDraft): Promise<string[]> {
  const { patternSummary, HD_HOLIDAY_RULE_LABEL: HOL } = await import("./recurring-shared");
  const team = await hqOne<{ name: string }>("SELECT name FROM hd_teams WHERE id = $1", [d.team_id]);
  const who = d.assign_mode === "user" && d.assignee_id ? await hqOne<{ name: string }>("SELECT COALESCE(NULLIF(name, ''), username) AS name FROM users WHERE id = $1", [d.assignee_id]) : undefined;
  const type = d.request_type_id ? await hqOne<{ title: string }>("SELECT title FROM hd_request_types WHERE id = $1", [d.request_type_id]) : undefined;
  const { HD_PRIORITY_LABEL } = await import("./types");
  const lines = [
    `Opens "${d.subject}" for ${team?.name ?? "a team"}`,
    `${patternSummary(d.pattern)} (${d.timezone})`,
    who ? `Assigned to ${who.name}` : "Assigned by the team's rules",
    `Priority ${HD_PRIORITY_LABEL[d.priority as keyof typeof HD_PRIORITY_LABEL] ?? d.priority}`,
  ];
  if (type) lines.push(`Request type ${type.title}`);
  if (d.due_business_days) lines.push(`Due in ${d.due_business_days} business ${d.due_business_days === 1 ? "day" : "days"}`);
  lines.push(`On a holiday: ${HOL[d.holiday_rule].toLowerCase()}`);
  return lines;
}

// --- Opening tickets -----------------------------------------------------------------------------------

interface DbSchedule {
  id: number;
  team_id: number;
  team_name: string;
  subject: string;
  body: string;
  priority: string;
  request_type_id: number | null;
  assign_mode: string;
  assignee_id: number | null;
  due_business_days: number | null;
  pattern: RecurringPattern;
  holiday_rule: string;
  timezone: string;
  enabled: number;
  next_key: string | null;
  next_run_at: Date | string | null;
}

function localDate(t: number, tz: string): CivilDate {
  const w = wallClock(t, tz);
  return fromDayNumber(dayNumber(w.y, w.m, w.d));
}

/**
 * Claim `key` for the schedule and insert its ticket on `client`, inside the
 * caller's transaction. Null when the key was already claimed (the
 * occurrence opened a ticket before).
 */
async function openOccurrence(client: PoolClient, s: DbSchedule, key: string, forDate: CivilDate, at: number): Promise<HdTicketRow | null> {
  const claim = await client.query(
    "INSERT INTO hd_recurring_runs (recurring_id, occurrence_key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING recurring_id",
    [s.id, key]
  );
  if (!claim.rowCount) return null;
  const { insertTicketTx } = await import("./tickets");
  // A named assignee who has since left the team falls back to the team's rules.
  const assignee = s.assign_mode === "user" && s.assignee_id && (await assignable(s.assignee_id, s.team_id, client)) ? s.assignee_id : null;
  const vars = { date: forDate, team: s.team_name };
  const who = { id: null, name: RECURRING_AUTHOR, email: "" };
  const row = await insertTicketTx(client, {
    subject: renderTemplate(s.subject, vars),
    body: renderTemplate(s.body, vars),
    requester: who,
    author: who,
    via: "system",
    first_message_kind: "public",
    source: "recurring",
    source_ref: { recurring_id: s.id, occurrence: key },
    team_id: s.team_id,
    assignee_id: assignee,
    priority: isPriorityValue(s.priority) ? s.priority : "normal",
    request_type_id: s.request_type_id,
    created_at: new Date(at),
  });
  if (s.due_business_days) {
    const due = dueAfterBusinessDays(at, s.due_business_days, await hoursForTeam(s.team_id, client));
    await client.query("UPDATE hd_tickets SET resolve_due = $2 WHERE id = $1", [row.id, new Date(due)]);
    row.resolve_due = new Date(due).toISOString();
  }
  await client.query("UPDATE hd_recurring_runs SET ticket_id = $3 WHERE recurring_id = $1 AND occurrence_key = $2", [s.id, key, row.id]);
  return row;
}

async function runHooks(rows: { row: HdTicketRow; actorId: number | null; actorName?: string }[]): Promise<void> {
  if (!rows.length) return;
  const { afterTicketCreated } = await import("./events");
  for (const r of rows) await afterTicketCreated(r.row, { actorId: r.actorId, actorName: r.actorName });
}

/**
 * The periodic pass (lib/periodic HELPDESK_SWEEPS): open the due
 * occurrences and move each schedule to its next run. Returns what it
 * opened.
 */
export async function recurringSweep(now: Date = new Date()): Promise<{ opened: { recurring_id: number; ticket_id: number; key: string }[] }> {
  const created: { row: HdTicketRow; actorId: null; schedule: DbSchedule; key: string }[] = [];
  await withTx(async (client) => {
    const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [RECURRING_SWEEP_LOCK]);
    if (!lock.rows[0]?.ok) return;
    const due = await client.query<DbSchedule>(
      `SELECT r.*, t.name AS team_name FROM hd_recurring r JOIN hd_teams t ON t.id = r.team_id
        WHERE r.enabled = 1 AND r.published = 1 AND r.next_run_at IS NOT NULL AND r.next_run_at <= $1
        ORDER BY r.next_run_at, r.id LIMIT 50 FOR UPDATE OF r SKIP LOCKED`,
      [now]
    );
    // Read the calendars fresh: another instance may have changed a holiday in the last 30 seconds.
    if (due.rows.length) invalidateCalendarCache();
    for (const s of due.rows) {
      await client.query("SAVEPOINT hd_recurring_one");
      try {
        const at = new Date(s.next_run_at as Date | string).getTime();
        const key = s.next_key ?? `at:${at}`;
        const forDate = parseIsoDate(key) ?? localDate(at, s.timezone);
        const live = { id: s.id, team_id: s.team_id, pattern: s.pattern, holiday_rule: isHolidayRule(s.holiday_rule) ? s.holiday_rule : "next_working_day", timezone: s.timezone, enabled: true } as const;
        // The calendar may have changed since next_run_at was worked out (a holiday added
        // or removed): ask again what this occurrence is today. Skipped now, or moved past
        // now, it opens nothing yet.
        const check = await occurrenceToday(live, key, client, now.getTime());
        if (check.state === "later") {
          await client.query("UPDATE hd_recurring SET next_run_at = $2 WHERE id = $1", [s.id, new Date(check.at)]);
          await client.query("RELEASE SAVEPOINT hd_recurring_one");
          continue;
        }
        // The ticket is created now (a late run's clocks start when it opens, not when it was due).
        const row = check.state === "due" ? await openOccurrence(client, s, key, forDate, now.getTime()) : null;
        const next = await computeNextRun(live, now.getTime(), client);
        await client.query("UPDATE hd_recurring SET next_run_at = $2, next_key = $3, last_run_at = CASE WHEN $5 THEN $4 ELSE last_run_at END WHERE id = $1", [
          s.id,
          next?.at ?? null,
          next?.key ?? null,
          now,
          check.state === "due",
        ]);
        await client.query("RELEASE SAVEPOINT hd_recurring_one");
        if (row) created.push({ row, actorId: null, schedule: s, key });
      } catch (e) {
        await client.query("ROLLBACK TO SAVEPOINT hd_recurring_one");
        logEvent("error", "helpdesk.recurring_failed", { recurring_id: s.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  });
  await runHooks(created);
  if (created.length) {
    const { audit } = await import("../audit");
    for (const c of created) {
      await audit({
        actor: null,
        action: "helpdesk.recurring.run",
        targetType: "helpdesk_recurring",
        targetId: c.schedule.id,
        targetLabel: c.row.subject,
        details: { ticket: c.row.number, occurrence: c.key, via: "schedule" },
      });
    }
  }
  return { opened: created.map((c) => ({ recurring_id: c.schedule.id, ticket_id: c.row.id, key: c.key })) };
}

/**
 * What a stored occurrence is under today's calendar: due (open it), moved
 * later (a holiday was added: wait until `at`), or gone (now skipped, or the
 * key is not a pattern date any more). A key that isn't a date (a legacy
 * row) is due.
 */
async function occurrenceToday(
  s: Pick<RecurringInput, "team_id" | "pattern" | "holiday_rule" | "timezone">,
  key: string,
  client: HdQueryable,
  now = Date.now()
): Promise<{ state: "due" } | { state: "later"; at: number } | { state: "gone" }> {
  if (!parseIsoDate(key)) return { state: "due" };
  const hours = await hoursForTeam(s.team_id, client);
  // The occurrence itself, moved or not, searched from the local day before its date.
  const o = occurrenceForKey(s.pattern, key, { tz: s.timezone, rule: s.holiday_rule, hours });
  if (!o) return { state: "gone" };
  return o.at > now ? { state: "later", at: o.at } : { state: "due" };
}

/** "Open one now": one ticket straight away, under its own key; the next scheduled run stays. */
export async function openRecurringNow(id: number, actor: { id: number; name: string }, requestKey?: string, now = Date.now()): Promise<HdTicketRow | null> {
  const key = `manual:${requestKey && /^[\w-]{6,64}$/.test(requestKey) ? requestKey : now}`;
  const row = await withTx(async (client) => {
    const s = (
      await client.query<DbSchedule>(`SELECT r.*, t.name AS team_name FROM hd_recurring r JOIN hd_teams t ON t.id = r.team_id WHERE r.id = $1 FOR UPDATE OF r`, [id])
    ).rows[0];
    if (!s) return null;
    // 1.20.16: a draft from Claude opens nothing until a person publishes it.
    if ((s as DbSchedule & { published?: number }).published === 0) throw new RecurringDraftError("This schedule is a draft from Claude. Publish it first.", 409);
    const opened = await openOccurrence(client, s, key, localDate(now, s.timezone), now);
    if (opened) await client.query("UPDATE hd_recurring SET last_run_at = $2 WHERE id = $1", [id, new Date(now)]);
    return opened;
  });
  if (row) await runHooks([{ row, actorId: actor.id, actorName: actor.name }]);
  return row;
}

// --- Audit -------------------------------------------------------------------------------------------------

export type RecurringAuditAction =
  | "helpdesk.recurring.created"
  | "helpdesk.recurring.updated"
  | "helpdesk.recurring.deleted"
  | "helpdesk.recurring.run"
  // 1.20.16: a person publishes a schedule Claude drafted, or discards the changes it proposed.
  | "helpdesk.recurring.published"
  | "helpdesk.recurring.draft_discarded";

export async function auditRecurring(
  req: Request,
  user: SessionUser,
  action: RecurringAuditAction,
  id: number,
  label: string,
  details: Record<string, unknown>
): Promise<void> {
  const { audit, actorFrom, ipFrom } = await import("../audit");
  await audit({ actor: actorFrom(user), action, targetType: "helpdesk_recurring", targetId: id, targetLabel: label, details, ip: ipFrom(req) });
}
