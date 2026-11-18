// Helpdesk 1.20.23: desk departments. Server-only.
//
// A desk department groups teams and holds content: macros, canned
// responses, checklists, workflows, request types and automations (the
// schema: desk-departments-schema; the pure half: desk-departments-shared).
// Not the requester's directory department (VIP lists, contact cards, the
// report filter `department=`), which this never touches.
//
// Whose departments (deskDepartmentScope):
//   a desk Admin (settings.manage) and anyone who sees every team's tickets
//   (tickets.view_all: Manager by default, helpdesk.agent_all) → every
//   department: they work every department's queue;
//   anyone else → the departments of the teams they belong to (an API
//   token's: its teams'). An agent on teams in two departments is in both.
// Queues and ticket access never change: they follow team membership
// exactly as before (lib/helpdesk/access). Departments decide only which
// content an agent sees, uses and manages.
//
// Seeing and using (every read and apply path, server-side): an item is
// visible when it is in one of the person's departments or in All
// departments (NULL). Personal macros and canned responses stay their
// owner's alone. A team-shared macro or canned response follows its team's
// rule (its team is in exactly one department, and moving the team takes
// them along: moveTeamToDeskDepartment). A request type is offered to an
// agent (Start a workflow, New ticket's request type, Claude) when it and
// the workflow it starts are both visible; Get help, the portal, chat and
// email intake are requesters' and never filtered.
//
// Managing (deskDepartmentAccess): a desk Admin manages every department
// and is the only one who sets or clears All departments. Anyone else
// manages an item only in the departments of the teams they BELONG to
// (deskDepartmentMemberScope; review M3, the owner's rule: "a Manager edits
// their own department's content"), never because they see every team's
// tickets: seeing and using follow ticket access, managing follows
// membership. There they need the feature's own capability
// (automations.manage, workflows.manage, …) OR "Manage a desk department"
// (departments.manage, matrix v6), which grants every department-held
// feature. All departments items are read-only to them. Departments
// themselves (create, rename, delete, which team is where) are Admin's
// (settings.manage).
//
// References between items stay inside a department (fitsDept): an item
// that is used by another (a macro an automation sends, a workflow a
// request type starts or whose trigger names it, a checklist a request type
// or a workflow task adds, a request type a recurring ticket files) must be
// in the user's department or in All departments. Saves check it; a move
// that would break it is refused with the list (moveDependents); a team move
// that changes what applies to the team answers 409 with what changes until
// it is confirmed (teamMoveImpact).

import "server-only";
import { cache } from "react";
import { NextResponse } from "next/server";
import type { Role, SessionUser } from "../types";
import { hq, hqOne, withTx, type HdQueryable } from "./db-core";
import { HD_FORBIDDEN, hdAnyCapGate, hdCan } from "./roles";
import type { HdCap } from "./roles-shared";
import { CHECKLIST_MANAGE_CAPS } from "./checklists-caps";
import {
  ALL_DESK_DEPARTMENTS_LABEL,
  DESK_DEPARTMENT_LIMITS,
  checkDeskDepartmentName,
  deskDepartmentInScope,
  type HdDeskDepartment,
  type HdDeskDepartmentChoices,
  type HdDeskDepartmentCounts,
  type HdDeskDepartmentFeature,
  type HdDeskDepartmentRow,
  type HdDeskDepartmentScope,
} from "./desk-departments-shared";

export * from "./desk-departments-shared";

type U = { id: number; role: Role };

export class DeskDepartmentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400
  ) {
    super(message);
  }
}

// --- Reads ------------------------------------------------------------------------------

const COLS = "id, name, is_default, position, created_at, updated_at";

export async function listDeskDepartments(client?: HdQueryable): Promise<HdDeskDepartment[]> {
  return hq<HdDeskDepartment>(`SELECT ${COLS} FROM hd_desk_departments ORDER BY is_default DESC, position, lower(name), id`, [], client);
}

export async function getDeskDepartment(id: number, client?: HdQueryable): Promise<HdDeskDepartment | undefined> {
  if (!Number.isInteger(id) || id <= 0) return undefined;
  return hqOne<HdDeskDepartment>(`SELECT ${COLS} FROM hd_desk_departments WHERE id = $1`, [id], client);
}

/** The default department's id ("General" unless renamed). Always exists (the schema makes it; it can't be deleted). */
export async function defaultDeskDepartmentId(client?: HdQueryable): Promise<number> {
  const r = await hqOne<{ id: number }>("SELECT hd_default_desk_department() AS id", [], client);
  if (!r?.id) throw new Error("No default desk department.");
  return r.id;
}

/**
 * The department a ticket of this team follows (its automations): the team's, or the
 * default department for a ticket with no team (or a team that is gone), so a ticket
 * nobody routed yet still meets the rules it met before departments existed.
 */
export async function teamDeskDepartmentId(teamId: number | null | undefined, client?: HdQueryable): Promise<number> {
  const r = await hqOne<{ id: number }>(
    "SELECT COALESCE((SELECT desk_department_id FROM hd_teams WHERE id = $1::int), hd_default_desk_department()) AS id",
    [teamId ?? null],
    client
  );
  return r!.id;
}

const COUNT_SQL = `
  SELECT d.id,
         (SELECT count(*)::int FROM hd_macros m WHERE m.desk_department_id = d.id AND m.owner_id IS NULL) AS macros,
         (SELECT count(*)::int FROM hd_canned_responses c WHERE c.desk_department_id = d.id AND c.owner_id IS NULL) AS canned,
         (SELECT count(*)::int FROM hd_checklist_templates x WHERE x.desk_department_id = d.id) AS checklists,
         (SELECT count(*)::int FROM hd_workflows w WHERE w.desk_department_id = d.id) AS workflows,
         (SELECT count(*)::int FROM hd_request_types r WHERE r.desk_department_id = d.id) AS request_types,
         (SELECT count(*)::int FROM hd_automations a WHERE a.desk_department_id = d.id) AS automations,
         (SELECT count(*)::int FROM hd_recurring s JOIN hd_teams t ON t.id = s.team_id WHERE t.desk_department_id = d.id) AS recurring
    FROM hd_desk_departments d`;

/** Every department with its teams and what it holds (Desk settings → Desk departments). */
export async function listDeskDepartmentRows(): Promise<HdDeskDepartmentRow[]> {
  const [deps, teams, counts] = await Promise.all([
    listDeskDepartments(),
    hq<{ id: number; name: string; desk_department_id: number }>("SELECT id, name, desk_department_id FROM hd_teams ORDER BY position, lower(name), id"),
    hq<HdDeskDepartmentCounts & { id: number }>(COUNT_SQL),
  ]);
  const byId = new Map(counts.map((c) => [c.id, c]));
  return deps.map((d) => {
    const c = byId.get(d.id);
    return {
      ...d,
      teams: teams.filter((t) => t.desk_department_id === d.id).map((t) => ({ id: t.id, name: t.name })),
      counts: {
        macros: c?.macros ?? 0,
        canned: c?.canned ?? 0,
        checklists: c?.checklists ?? 0,
        workflows: c?.workflows ?? 0,
        request_types: c?.request_types ?? 0,
        automations: c?.automations ?? 0,
        recurring: c?.recurring ?? 0,
      },
    };
  });
}

// --- Whose departments ---------------------------------------------------------------------

/** The departments of these teams. */
export async function departmentsOfTeams(teamIds: number[]): Promise<number[]> {
  if (!teamIds.length) return [];
  const rows = await hq<{ id: number }>("SELECT DISTINCT desk_department_id AS id FROM hd_teams WHERE id = ANY($1::int[]) ORDER BY 1", [teamIds]);
  return rows.map((r) => r.id);
}

let scopeOverride: ((user: U) => Promise<HdDeskDepartmentScope> | HdDeskDepartmentScope) | null = null;
/** Test seam (never in production code paths). */
export function setDeskDepartmentScopeForTests(fn: typeof scopeOverride): void {
  scopeOverride = fn;
}

const scopeOf = cache(async (userId: number, role: Role): Promise<HdDeskDepartmentScope> => {
  const user = { id: userId, role };
  if ((await hdCan(user, "settings.manage")) || (await hdCan(user, "tickets.view_all"))) return "all";
  const { memberTeamIds } = await import("./access");
  return departmentsOfTeams(await memberTeamIds(userId));
});

/**
 * The desk departments whose content this person sees and uses: "all" for a desk Admin
 * and for anyone who sees every team's tickets; else the departments of their teams.
 * All departments items come on top, whatever this says.
 */
export async function deskDepartmentScope(user: U): Promise<HdDeskDepartmentScope> {
  if (scopeOverride) return scopeOverride(user);
  return scopeOf(user.id, user.role);
}

const memberScopeOf = cache(async (userId: number): Promise<number[]> => {
  const { memberTeamIds } = await import("./access");
  return departmentsOfTeams(await memberTeamIds(userId));
});

/**
 * 1.20.23 review (M3): the departments a non-Admin may MANAGE content in: those of the teams they
 * belong to (an API token's: its teams'), whatever tickets they see. A desk Admin manages every one
 * (deskDepartmentAccess). Seeing and using stay deskDepartmentScope.
 */
export async function deskDepartmentMemberScope(user: U): Promise<number[]> {
  return memberScopeOf(user.id);
}

/** `scope` as a query parameter: NULL for "all" (with deptVisibleSql). */
export function scopeParam(scope: HdDeskDepartmentScope): number[] | null {
  return scope === "all" ? null : scope;
}

/** SQL: is `col` (a desk_department_id) visible for the scope in parameter $n (scopeParam)? */
export function deptVisibleSql(col: string, n: number): string {
  return `(${col} IS NULL OR $${n}::int[] IS NULL OR ${col} = ANY($${n}::int[]))`;
}

/**
 * Review L1: the request types a picker or list offers someone whose departments are `scope`
 * (theirs and All departments'), so no list names another department's types.
 */
export async function requestTypeOptions(
  scope: HdDeskDepartmentScope
): Promise<{ id: number; title: string; team_id: number | null; active: number; desk_department_id: number | null }[]> {
  return hq(
    `SELECT id, title, team_id, active, desk_department_id FROM hd_request_types WHERE ${deptVisibleSql("desk_department_id", 1)} ORDER BY position, lower(title), id`,
    [scopeParam(scope)]
  );
}

// --- Managing ------------------------------------------------------------------------------

/** The capabilities each feature's own management needs (any one); departments.manage stands in for them in one's departments. */
export const DESK_DEPARTMENT_FEATURE_CAPS: Record<HdDeskDepartmentFeature, readonly HdCap[]> = {
  macros: ["macros.manage_team", "macros.manage_all"],
  canned: ["macros.manage_team", "macros.manage_all"],
  checklists: CHECKLIST_MANAGE_CAPS,
  workflows: ["workflows.manage"],
  request_types: ["request_types.manage"],
  automations: ["automations.manage"],
  recurring: ["settings.manage", "agents.manage_team"],
};

/** What a person may do with one feature's items, by department. */
export interface DeskDepartmentAccess {
  /** A desk Admin: every department, and All departments. */
  admin: boolean;
  /** Departments whose items they see (All departments items too). */
  scope: HdDeskDepartmentScope;
  /** Departments where they may create, edit and delete items: their teams' (M3). Never All departments unless admin. */
  manage: HdDeskDepartmentScope;
  /** They hold "Manage a desk department". */
  departmentManager: boolean;
}

export async function deskDepartmentAccess(user: U, feature: HdDeskDepartmentFeature): Promise<DeskDepartmentAccess> {
  const admin = await hdCan(user, "settings.manage");
  const scope: HdDeskDepartmentScope = admin ? "all" : await deskDepartmentScope(user);
  const departmentManager = await hdCan(user, "departments.manage");
  if (admin) return { admin, scope, manage: "all", departmentManager };
  let holds = departmentManager;
  for (const c of DESK_DEPARTMENT_FEATURE_CAPS[feature]) if (!holds && (await hdCan(user, c))) holds = true;
  // Review M3: managing follows team membership, never "sees every team's tickets".
  return { admin, scope, manage: holds ? await deskDepartmentMemberScope(user) : [], departmentManager };
}

/** May they create, edit or delete an item of department `deptId` (null = All departments)? */
export function mayManageDept(access: DeskDepartmentAccess, deptId: number | null | undefined): boolean {
  if (access.admin) return true;
  if (deptId === null || deptId === undefined) return false;
  return access.manage !== "all" ? access.manage.includes(deptId) : true;
}

/** May they see an item of department `deptId`? */
export function maySeeDept(access: Pick<DeskDepartmentAccess, "scope">, deptId: number | null | undefined): boolean {
  return deskDepartmentInScope(deptId ?? null, access.scope);
}

/** The department a new item starts in for them: the default one if theirs to manage, else their first; null when none. */
export async function startingDeptFor(access: DeskDepartmentAccess): Promise<number | null> {
  const deps = await listDeskDepartments();
  const mine = deps.filter((d) => mayManageDept(access, d.id));
  return (mine.find((d) => d.is_default) ?? mine[0])?.id ?? null;
}

/**
 * The department an item is saved in, from a body's `desk_department_id`:
 * left out keeps `current` (or, for a new item, the starting department);
 * null is All departments (desk Admin only); a number must be a department
 * they manage. The sentence says why not.
 */
export async function resolveDeskDepartmentField(
  access: DeskDepartmentAccess,
  raw: unknown,
  current?: number | null
): Promise<{ ok: true; value: number | null } | { ok: false; status: 400 | 403; error: string }> {
  if (raw === undefined) {
    if (current !== undefined) return { ok: true, value: current };
    const start = await startingDeptFor(access);
    if (start === null) return { ok: false, status: 403, error: "You don't manage any desk department to put it in." };
    return { ok: true, value: start };
  }
  if (raw === null || raw === "all") {
    if (current === null) return { ok: true, value: null };
    return access.admin ? { ok: true, value: null } : { ok: false, status: 403, error: `Only a desk Admin can share it with ${ALL_DESK_DEPARTMENTS_LABEL.toLowerCase()}.` };
  }
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0 || !(await getDeskDepartment(id))) return { ok: false, status: 400, error: "That desk department no longer exists. Pick another." };
  if (id === current) return { ok: true, value: id };
  if (!mayManageDept(access, id)) return { ok: false, status: 403, error: "You can only put it in a desk department you manage." };
  return { ok: true, value: id };
}

/** The Department field's choices for one feature (GET /api/helpdesk/desk-departments?feature=). */
export async function deskDepartmentChoices(user: U, feature: HdDeskDepartmentFeature): Promise<HdDeskDepartmentChoices> {
  const access = await deskDepartmentAccess(user, feature);
  const deps = await listDeskDepartments();
  const seen = deps.filter((d) => maySeeDept(access, d.id));
  return {
    departments: deps.map((d) => ({ id: d.id, name: d.name, is_default: d.is_default, manageable: mayManageDept(access, d.id) })),
    can_all: access.admin,
    default_id: await startingDeptFor(access),
    filter: seen.length > 1,
  };
}

/**
 * The gate of a feature's settings routes: same-origin, signed in, licensed, then the
 * feature's own capabilities or "Manage a desk department" (403). Returns the user and
 * what they may do by department.
 */
export async function deskDepartmentGate(
  feature: HdDeskDepartmentFeature,
  extraCaps: readonly HdCap[] = []
): Promise<{ user: SessionUser; access: DeskDepartmentAccess } | NextResponse> {
  const gate = await hdAnyCapGate([...DESK_DEPARTMENT_FEATURE_CAPS[feature], ...extraCaps, "departments.manage"]);
  if (gate instanceof NextResponse) return gate;
  return { user: gate, access: await deskDepartmentAccess(gate, feature) };
}

/** The 403 an edit outside one's departments answers. */
export function notYourDeskDepartment(deptId: number | null | undefined): NextResponse {
  return NextResponse.json(
    {
      error:
        deptId === null || deptId === undefined
          ? `This is shared with ${ALL_DESK_DEPARTMENTS_LABEL.toLowerCase()}: only a desk Admin can change it.`
          : "This belongs to a desk department you don't manage.",
      code: "desk_department",
    },
    { status: 403 }
  );
}

export { HD_FORBIDDEN };

/**
 * An [id] settings route's department check on an existing item: 404 (the same answer as a
 * missing one) when it is in a department they don't see, 403 when they see it but don't
 * manage it (another department of theirs read-only, or All departments). Null: go on.
 */
export function itemRefusal(access: DeskDepartmentAccess, deptId: number | null | undefined, notFoundError = "Not found."): NextResponse | null {
  if (!maySeeDept(access, deptId)) return NextResponse.json({ error: notFoundError }, { status: 404 });
  if (!mayManageDept(access, deptId)) return notYourDeskDepartment(deptId);
  return null;
}

/** A body's desk_department_id for a save (resolveDeskDepartmentField), or the response refusing it. */
export async function deskDepartmentFieldOr(
  access: DeskDepartmentAccess,
  raw: unknown,
  current?: number | null
): Promise<{ value: number | null } | NextResponse> {
  const d = await resolveDeskDepartmentField(access, raw, current);
  if (!d.ok) return NextResponse.json({ error: d.error, code: "desk_department" }, { status: d.status });
  return { value: d.value };
}

/** After an item's save: move it to `to` when that differs from `from`, and audit the move. */
export async function moveItemDeskDepartment(
  user: { id: number; name?: string | null; username?: string | null; role: Role },
  what: DeskDepartmentContent,
  item: { id: number; label: string },
  from: number | null,
  to: number | null,
  ip: string | null
): Promise<void> {
  if (from === to) return;
  await setItemDeskDepartment(what, item.id, to);
  await auditItemDeskDepartment(user, what, item, from, to, ip);
}

// --- Writing an item's department -------------------------------------------------------------

const CONTENT_TABLES = {
  macros: "hd_macros",
  canned: "hd_canned_responses",
  checklists: "hd_checklist_templates",
  workflows: "hd_workflows",
  request_types: "hd_request_types",
  automations: "hd_automations",
} as const;
export type DeskDepartmentContent = keyof typeof CONTENT_TABLES;

/** Move one item to a department (null = All departments). Answers the department it was in, or undefined when the item is gone. */
export async function setItemDeskDepartment(
  what: DeskDepartmentContent,
  id: number,
  deptId: number | null,
  client?: HdQueryable
): Promise<{ before: number | null } | undefined> {
  const table = CONTENT_TABLES[what];
  const r = await hqOne<{ before: number | null }>(
    `UPDATE ${table} x SET desk_department_id = $2 FROM (SELECT id, desk_department_id AS before FROM ${table} WHERE id = $1 FOR UPDATE) old
      WHERE x.id = old.id RETURNING old.before`,
    [id, deptId],
    client
  );
  return r ? { before: r.before } : undefined;
}

/** A department's name for an audit row ("All departments" for null). */
export async function deskDepartmentName(deptId: number | null | undefined, client?: HdQueryable): Promise<string> {
  if (deptId === null || deptId === undefined) return ALL_DESK_DEPARTMENTS_LABEL;
  return (await getDeskDepartment(deptId, client))?.name ?? `Desk department ${deptId}`;
}

/** The audit target type each feature's own rows use. */
const AUDIT_TARGET: Record<DeskDepartmentContent | "recurring", string> = {
  macros: "helpdesk_macro",
  canned: "helpdesk_canned",
  checklists: "helpdesk_checklist",
  workflows: "helpdesk_workflow",
  request_types: "helpdesk_request_type",
  automations: "helpdesk_automation",
  recurring: "helpdesk_recurring",
};

/** The audit row of an item moved between departments (helpdesk.desk_department.item_moved). */
export async function auditItemDeskDepartment(
  user: { id: number; name?: string | null; username?: string | null; role: Role },
  what: DeskDepartmentContent | "recurring",
  item: { id: number; label: string },
  from: number | null,
  to: number | null,
  ip: string | null
): Promise<void> {
  if (from === to) return;
  const { audit, actorFrom } = await import("../audit");
  await audit({
    actor: actorFrom({ id: user.id, name: user.name ?? "", username: user.username ?? "", role: user.role }),
    action: "helpdesk.desk_department.item_moved",
    targetType: AUDIT_TARGET[what],
    targetId: item.id,
    targetLabel: item.label.slice(0, 200),
    details: { kind: what, from_id: from, from: await deskDepartmentName(from), to_id: to, to: await deskDepartmentName(to) },
    ip,
  });
}

/**
 * A request type starts its workflow for whoever is offered the type, so the workflow must be
 * in the type's desk department or in All departments (an All departments type: an All
 * departments workflow). The sentence when not; null when fine.
 */
export async function requestTypeWorkflowRefusal(typeDept: number | null, workflowId: number | null | undefined): Promise<string | null> {
  if (!workflowId) return null;
  const w = await hqOne<{ title: string; desk_department_id: number | null }>("SELECT title, desk_department_id FROM hd_workflows WHERE id = $1", [workflowId]);
  if (!w || w.desk_department_id === null || w.desk_department_id === typeDept) return null;
  return `The workflow ${w.title} is in the ${await deskDepartmentName(w.desk_department_id)} desk department. Put the request type there too, or pick a workflow of ${
    typeDept === null ? ALL_DESK_DEPARTMENTS_LABEL.toLowerCase() : `${await deskDepartmentName(typeDept)} or of ${ALL_DESK_DEPARTMENTS_LABEL.toLowerCase()}`
  }.`;
}

/**
 * An automation sends its macro's reply on its department's tickets, so the macro must be in the
 * rule's desk department or in All departments (an All departments rule: an All departments
 * macro). The sentence when not; null when fine.
 */
export async function automationMacroRefusal(ruleDept: number | null, macroId: number | null | undefined): Promise<string | null> {
  if (!macroId) return null;
  const m = await hqOne<{ title: string; desk_department_id: number | null }>("SELECT title, desk_department_id FROM hd_macros WHERE id = $1 AND owner_id IS NULL", [macroId]);
  if (!m || m.desk_department_id === null || m.desk_department_id === ruleDept) return null;
  return `The macro ${m.title} is in the ${await deskDepartmentName(m.desk_department_id)} desk department, so this rule can't send it. Pick a macro of ${
    ruleDept === null ? ALL_DESK_DEPARTMENTS_LABEL.toLowerCase() : `${await deskDepartmentName(ruleDept)} or of ${ALL_DESK_DEPARTMENTS_LABEL.toLowerCase()}`
  }.`;
}

/**
 * 1.20.33: a rule copies values only into custom fields its desk department's tickets can have: a field of All teams,
 * or one assigned to at least one of the department's teams (a rule of All departments may name any). The sentence
 * a save is refused with, or null.
 */
export async function automationFieldsRefusal(ruleDept: number | null, copies: readonly { field_key?: string }[] | null | undefined): Promise<string | null> {
  const keys = [...new Set((copies ?? []).map((c) => c.field_key).filter((k): k is string => !!k))];
  if (ruleDept === null || !keys.length) return null;
  const fields = await hq<{ key: string; label: string; all_teams: number; team_ids: number[] | null }>("SELECT key, label, all_teams, team_ids FROM hd_custom_fields WHERE key = ANY($1::text[])", [keys]);
  const teams = new Set((await hq<{ id: number }>("SELECT id FROM hd_teams WHERE desk_department_id = $1", [ruleDept])).map((r) => r.id));
  for (const f of fields) {
    if (f.all_teams === 1 || (f.team_ids ?? []).some((id) => teams.has(id))) continue;
    return `The custom field ${f.label} isn't a field of any team in the ${await deskDepartmentName(ruleDept)} desk department, so this rule can't copy into it. Pick a field of one of its teams, or of all teams.`;
  }
  return null;
}

// --- References stay inside a department (1.20.23 review: M1, M2, M4, L2) -----------------------

/** May an item of `usedDept` be used by one of `userDept`? When it is in that department, or in All departments. */
export function fitsDept(usedDept: number | null | undefined, userDept: number | null | undefined): boolean {
  return usedDept === null || usedDept === undefined || usedDept === (userDept ?? null);
}

const allLower = () => ALL_DESK_DEPARTMENTS_LABEL.toLowerCase();
async function ofDeptOrAll(dept: number | null): Promise<string> {
  return dept === null ? allLower() : `${await deskDepartmentName(dept)} or of ${allLower()}`;
}

interface StepLike {
  kind?: string;
  checklist_ids?: unknown;
  steps?: StepLike[];
}

/** The checklists a definition's tasks add (task and parallel steps). */
function definitionChecklistIds(def: { steps?: StepLike[] } | null | undefined): number[] {
  const out = new Set<number>();
  for (const s of def?.steps ?? []) {
    const tasks = s.kind === "task" ? [s] : s.kind === "parallel" ? (s.steps ?? []) : [];
    for (const t of tasks) if (Array.isArray(t.checklist_ids)) for (const id of t.checklist_ids) if (Number.isInteger(id)) out.add(id as number);
  }
  return [...out];
}

/**
 * A workflow's own references (M1, M2): the request type its trigger names starts it, so the
 * workflow must be in that type's department or in All departments; a task's checklists must be in
 * the workflow's department or in All departments. The sentence when not; null when fine.
 */
export async function workflowRefsRefusal(
  workflowDept: number | null,
  def: { trigger?: { request_type_id?: number | null } | null; steps?: StepLike[] } | null | undefined
): Promise<string | null> {
  const typeId = Number(def?.trigger?.request_type_id);
  if (Number.isInteger(typeId) && typeId > 0) {
    const rt = await hqOne<{ title: string; desk_department_id: number | null }>("SELECT title, desk_department_id FROM hd_request_types WHERE id = $1", [typeId]);
    if (rt && !fitsDept(workflowDept, rt.desk_department_id)) {
      return `It starts for the request type ${rt.title}, which is in ${await deskDepartmentName(rt.desk_department_id)}: put the workflow in ${await ofDeptOrAll(rt.desk_department_id)}, or start it from another request type.`;
    }
  }
  const ids = definitionChecklistIds(def);
  if (ids.length) {
    const bad = await hq<{ name: string; desk_department_id: number }>(
      "SELECT name, desk_department_id FROM hd_checklist_templates WHERE id = ANY($1::int[]) AND desk_department_id IS NOT NULL AND desk_department_id IS DISTINCT FROM $2::int ORDER BY name",
      [ids, workflowDept]
    );
    if (bad.length) {
      return `A task adds the checklist ${bad[0].name}, which is in ${await deskDepartmentName(bad[0].desk_department_id)}. A task adds checklists of ${await ofDeptOrAll(workflowDept)} only.`;
    }
  }
  return null;
}

/** A checklist that request types add (M2): each type must be in the checklist's department, unless the checklist is in All departments. */
export async function checklistRefsRefusal(checklistDept: number | null, requestTypeIds: readonly number[]): Promise<string | null> {
  if (checklistDept === null || !requestTypeIds.length) return null;
  const bad = await hq<{ title: string; desk_department_id: number | null }>(
    "SELECT title, desk_department_id FROM hd_request_types WHERE id = ANY($1::int[]) AND desk_department_id IS DISTINCT FROM $2::int ORDER BY title",
    [requestTypeIds, checklistDept]
  );
  if (!bad.length) return null;
  return `The request type ${bad[0].title} is in ${await deskDepartmentName(bad[0].desk_department_id)}, so it can't add a checklist of ${await deskDepartmentName(checklistDept)}. Share the checklist with ${allLower()}, or leave that type out.`;
}

/** A recurring ticket's request type (L2): one its team's department sees (that department's, or All departments'). */
export async function recurringTypeRefusal(teamId: number, requestTypeId: number | null | undefined): Promise<string | null> {
  if (!requestTypeId) return null;
  const r = await hqOne<{ title: string; rt_dept: number | null; team_dept: number }>(
    "SELECT rt.title, rt.desk_department_id AS rt_dept, t.desk_department_id AS team_dept FROM hd_request_types rt, hd_teams t WHERE rt.id = $1 AND t.id = $2",
    [requestTypeId, teamId]
  );
  if (!r || fitsDept(r.rt_dept, r.team_dept)) return null;
  return `The request type ${r.title} is in ${await deskDepartmentName(r.rt_dept)}, and the team's desk department is ${await deskDepartmentName(r.team_dept)}. Pick a request type of ${await ofDeptOrAll(r.team_dept)}.`;
}

/** Something that would use an item of another department after a move. */
export interface DeskDepartmentDependent {
  kind: "automation" | "request_type" | "workflow" | "checklist" | "macro" | "recurring";
  id: number;
  title: string;
}

const TRIGGER_SQL = (alias: string) =>
  `(NULLIF(${alias}.definition->'trigger'->>'request_type_id', '')::int = $1 OR NULLIF(${alias}.draft->'trigger'->>'request_type_id', '')::int = $1)`;
const NAMES_CHECKLIST_SQL = (alias: string) =>
  `(jsonb_path_exists(${alias}.definition, '$.**.checklist_ids[*] ? (@ == $c)', jsonb_build_object('c', $1::int))
    OR jsonb_path_exists(COALESCE(${alias}.draft, '{}'::jsonb), '$.**.checklist_ids[*] ? (@ == $c)', jsonb_build_object('c', $1::int)))`;

/**
 * M4: what would break if item `id` moved to department `to` (null = All departments): every item
 * that uses it or that it uses and would then reference another department's (fitsDept). Empty
 * when the move is fine. A move with dependents is refused with the list (dependentsResponse).
 */
export async function moveDependents(
  what: DeskDepartmentContent,
  id: number,
  to: number | null,
  /** Request types (review N3): the caller checks the type's own (new) workflow_id itself; a workflow whose trigger names it is listed whatever its workflow_id. */
  opts: { ownWorkflowChecked?: boolean } = {}
): Promise<DeskDepartmentDependent[]> {
  const out: DeskDepartmentDependent[] = [];
  const add = (kind: DeskDepartmentDependent["kind"], rows: { id: number; title: string }[]) => out.push(...rows.map((r) => ({ kind, id: r.id, title: r.title })));
  // A department `to` item used by these: they must be in `to` (unless it moves to All departments).
  const usedBy = "($2::int IS NOT NULL AND desk_department_id IS DISTINCT FROM $2::int)";
  // Items `to` uses: they must be in `to` or All departments.
  const uses = "(desk_department_id IS NOT NULL AND desk_department_id IS DISTINCT FROM $2::int)";
  switch (what) {
    case "macros":
      add("automation", await hq(`SELECT id, name AS title FROM hd_automations WHERE NULLIF(actions->>'macro_id', '')::int = $1 AND ${usedBy} ORDER BY name`, [id, to]));
      break;
    case "automations":
      add("macro", await hq(`SELECT m.id, m.title FROM hd_macros m JOIN hd_automations a ON NULLIF(a.actions->>'macro_id', '')::int = m.id WHERE a.id = $1 AND m.owner_id IS NULL AND ${uses.replaceAll("desk_department_id", "m.desk_department_id")}`, [id, to]));
      break;
    case "workflows":
      add("request_type", await hq(`SELECT rt.id, rt.title FROM hd_request_types rt, hd_workflows w WHERE w.id = $1 AND (rt.workflow_id = w.id OR rt.id = NULLIF(w.definition->'trigger'->>'request_type_id', '')::int OR rt.id = NULLIF(w.draft->'trigger'->>'request_type_id', '')::int) AND ${usedBy.replaceAll("desk_department_id", "rt.desk_department_id")} ORDER BY rt.title`, [id, to]));
      {
        const w = await hqOne<{ definition: { steps?: StepLike[] }; draft: { steps?: StepLike[] } | null }>("SELECT definition, draft FROM hd_workflows WHERE id = $1", [id]);
        const ids = [...new Set([...definitionChecklistIds(w?.definition), ...definitionChecklistIds(w?.draft)])];
        if (ids.length) add("checklist", await hq(`SELECT id, name AS title FROM hd_checklist_templates WHERE id = ANY($3::int[]) AND $1::int IS NOT NULL AND ${uses} ORDER BY name`, [id, to, ids]));
      }
      break;
    case "request_types":
      add("workflow", await hq(`SELECT w.id, w.title FROM hd_workflows w WHERE (${opts.ownWorkflowChecked ? "FALSE" : "w.id = (SELECT workflow_id FROM hd_request_types WHERE id = $1)"} OR ${TRIGGER_SQL("w")}) AND ${uses.replaceAll("desk_department_id", "w.desk_department_id")} ORDER BY w.title`, [id, to]));
      add("checklist", await hq(`SELECT id, name AS title FROM hd_checklist_templates WHERE $1 = ANY(request_type_ids) AND ${uses} ORDER BY name`, [id, to]));
      add("recurring", await hq(`SELECT r.id, r.subject AS title FROM hd_recurring r JOIN hd_teams t ON t.id = r.team_id WHERE r.request_type_id = $1 AND $2::int IS NOT NULL AND t.desk_department_id IS DISTINCT FROM $2::int ORDER BY r.subject`, [id, to]));
      break;
    case "checklists":
      add("request_type", await hq(`SELECT rt.id, rt.title FROM hd_request_types rt WHERE rt.id = ANY((SELECT request_type_ids FROM hd_checklist_templates WHERE id = $1)::int[]) AND ${usedBy.replaceAll("desk_department_id", "rt.desk_department_id")} ORDER BY rt.title`, [id, to]));
      add("workflow", await hq(`SELECT w.id, w.title FROM hd_workflows w WHERE ${NAMES_CHECKLIST_SQL("w")} AND ${usedBy.replaceAll("desk_department_id", "w.desk_department_id")} ORDER BY w.title`, [id, to]));
      break;
    case "canned":
      break;
  }
  return out;
}

const KIND_WORD: Record<DeskDepartmentDependent["kind"], string> = {
  automation: "the automation",
  request_type: "the request type",
  workflow: "the workflow",
  checklist: "the checklist",
  macro: "the macro",
  recurring: "the recurring ticket",
};

/** "the automation VPN, the request type Laptop and 2 more". */
export function dependentsInWords(deps: readonly DeskDepartmentDependent[], max = 5): string {
  const names = deps.slice(0, max).map((d) => `${KIND_WORD[d.kind]} ${d.title}`);
  if (deps.length > max) names.push(`${deps.length - max} more`);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The 409 a move with dependents answers: the sentence names them; `dependents` lists them all. */
export function dependentsResponse(deps: readonly DeskDepartmentDependent[], to: string): NextResponse {
  return NextResponse.json(
    {
      error: `It can't move to ${to}: ${dependentsInWords(deps)} would then use something of another desk department. Move or change ${deps.length === 1 ? "it" : "them"} first.`,
      code: "desk_department_dependents",
      dependents: deps,
    },
    { status: 409 }
  );
}

/** A PATCH moving item `id` from `from` to `to`: the 409 with its dependents, or null (no move, or nothing breaks). */
export async function moveRefusal(what: DeskDepartmentContent, id: number, from: number | null, to: number | null): Promise<NextResponse | null> {
  if ((from ?? null) === (to ?? null)) return null;
  const deps = await moveDependents(what, id, to);
  return deps.length ? dependentsResponse(deps, to === null ? allLower() : await deskDepartmentName(to)) : null;
}

/** What changes for a team moved to `to` (M5), and what would break (M4: the team macros it takes along). */
export interface TeamMoveImpact {
  /** Automations elsewhere that send the team's own macros: the move is refused while there are any. */
  dependents: DeskDepartmentDependent[];
  /** Applies no more to the team once it moves; shown, and confirmed, before the move. */
  affected: {
    rules: { id: number; title: string }[];
    request_types: { id: number; title: string }[];
    checklists: { id: number; title: string }[];
    workflows: { id: number; title: string }[];
    recurring: { id: number; title: string }[];
    agents: { id: number; title: string }[];
  };
}

export async function teamMoveImpact(teamId: number, to: number): Promise<TeamMoveImpact> {
  const team = await hqOne<{ desk_department_id: number }>("SELECT desk_department_id FROM hd_teams WHERE id = $1", [teamId]);
  const from = team?.desk_department_id ?? null;
  const elsewhere = "(desk_department_id IS NOT NULL AND desk_department_id <> $2::int)";
  const [dependents, rules, requestTypes, checklists, workflows, recurring, members] = await Promise.all([
    hq<{ id: number; title: string }>(
      `SELECT a.id, a.name AS title FROM hd_automations a JOIN hd_macros m ON m.id = NULLIF(a.actions->>'macro_id', '')::int
        WHERE m.team_id = $1 AND m.owner_id IS NULL AND a.desk_department_id IS DISTINCT FROM $2::int ORDER BY a.name`,
      [teamId, to]
    ),
    hq<{ id: number; title: string }>(`SELECT id, name AS title FROM hd_automations WHERE conditions->'team_ids' @> to_jsonb($1::int) AND ${elsewhere} ORDER BY position, id`, [teamId, to]),
    hq<{ id: number; title: string }>(`SELECT id, title FROM hd_request_types WHERE team_id = $1 AND ${elsewhere} ORDER BY title`, [teamId, to]),
    hq<{ id: number; title: string }>(`SELECT id, name AS title FROM hd_checklist_templates WHERE items @> jsonb_build_array(jsonb_build_object('team_id', $1::int)) AND ${elsewhere} ORDER BY name`, [teamId, to]),
    hq<{ id: number; title: string }>(
      `SELECT id, title FROM hd_workflows WHERE (jsonb_path_exists(definition, '$.**.team_id ? (@ == $t)', jsonb_build_object('t', $1::int))
         OR jsonb_path_exists(COALESCE(draft, '{}'::jsonb), '$.**.team_id ? (@ == $t)', jsonb_build_object('t', $1::int))) AND ${elsewhere} ORDER BY title`,
      [teamId, to]
    ),
    hq<{ id: number; title: string }>(
      `SELECT r.id, r.subject AS title FROM hd_recurring r JOIN hd_request_types rt ON rt.id = r.request_type_id
        WHERE r.team_id = $1 AND rt.desk_department_id IS NOT NULL AND rt.desk_department_id <> $2::int ORDER BY r.subject`,
      [teamId, to]
    ),
    // Members with no other team in the department the team leaves.
    hq<{ id: number; title: string; role: Role }>(
      `SELECT u.id, COALESCE(NULLIF(u.name, ''), u.username) AS title, u.role FROM hd_team_members m JOIN users u ON u.id = m.user_id AND u.status = 'active'
        WHERE m.team_id = $1 AND NOT EXISTS (SELECT 1 FROM hd_team_members o JOIN hd_teams t ON t.id = o.team_id
                                              WHERE o.user_id = m.user_id AND o.team_id <> $1 AND t.desk_department_id = $2::int)
        ORDER BY 2`,
      [teamId, from]
    ),
  ]);
  const agents: { id: number; title: string }[] = [];
  if (from !== null && from !== to) {
    // Those who see every department anyway (every team's tickets, desk Admin) lose nothing.
    for (const m of members) if ((await deskDepartmentScope({ id: m.id, role: m.role })) !== "all") agents.push({ id: m.id, title: m.title });
  }
  return {
    dependents: dependents.map((d) => ({ kind: "automation" as const, id: d.id, title: d.title })),
    affected: { rules, request_types: requestTypes, checklists, workflows, recurring, agents },
  };
}

/** Is there anything in a team move's `affected`? */
export function teamMoveChangesSomething(a: TeamMoveImpact["affected"]): boolean {
  return Object.values(a).some((l) => l.length > 0);
}

// --- A save racing a department's deletion (L3) ---------------------------------------------------

/** A foreign-key error naming a desk_department_id column: the department was deleted mid-save. */
export function isDeskDepartmentGone(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string } | null;
  return !!err && err.code === "23503" && typeof err.constraint === "string" && err.constraint.includes("desk_department_id");
}

export const DESK_DEPARTMENT_GONE = "That desk department was deleted just now. Pick another and save again.";

/** Wrap a route handler: a save that raced a department's deletion answers 409 with a sentence, not a 500. */
export function guardDeptRace<A extends unknown[]>(fn: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (isDeskDepartmentGone(e)) return NextResponse.json({ error: DESK_DEPARTMENT_GONE, code: "desk_department_gone" }, { status: 409 });
      throw e;
    }
  };
}

// --- Departments (Admin) -----------------------------------------------------------------------

export async function createDeskDepartment(rawName: unknown): Promise<HdDeskDepartment> {
  const name = checkDeskDepartmentName(rawName);
  if (!name.ok) throw new DeskDepartmentError(name.error);
  return withTx(async (client) => {
    await client.query("LOCK TABLE hd_desk_departments IN SHARE ROW EXCLUSIVE MODE");
    const n = await hqOne<{ n: number; max: number | null }>("SELECT count(*)::int AS n, max(position) AS max FROM hd_desk_departments", [], client);
    if ((n?.n ?? 0) >= DESK_DEPARTMENT_LIMITS.departments) throw new DeskDepartmentError(`A desk has at most ${DESK_DEPARTMENT_LIMITS.departments} desk departments.`, 409);
    if (await hqOne("SELECT 1 FROM hd_desk_departments WHERE lower(name) = lower($1)", [name.value], client)) {
      throw new DeskDepartmentError(`There is already a desk department called ${name.value}.`, 409);
    }
    return (await hqOne<HdDeskDepartment>(
      `INSERT INTO hd_desk_departments (name, position) VALUES ($1, $2) RETURNING ${COLS}`,
      [name.value, (n?.max ?? 0) + 1],
      client
    ))!;
  });
}

export async function renameDeskDepartment(id: number, rawName: unknown): Promise<{ before: HdDeskDepartment; after: HdDeskDepartment }> {
  const name = checkDeskDepartmentName(rawName);
  if (!name.ok) throw new DeskDepartmentError(name.error);
  return withTx(async (client) => {
    const before = await hqOne<HdDeskDepartment>(`SELECT ${COLS} FROM hd_desk_departments WHERE id = $1 FOR UPDATE`, [id], client);
    if (!before) throw new DeskDepartmentError("Desk department not found.", 404);
    if (await hqOne("SELECT 1 FROM hd_desk_departments WHERE lower(name) = lower($1) AND id <> $2", [name.value, id], client)) {
      throw new DeskDepartmentError(`There is already a desk department called ${name.value}.`, 409);
    }
    const after = await hqOne<HdDeskDepartment>(`UPDATE hd_desk_departments SET name = $2, updated_at = now() WHERE id = $1 RETURNING ${COLS}`, [id, name.value], client);
    return { before, after: after! };
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 macros, 1 automation and 2 workflows" (non-zero only). */
export function countsInWords(c: Omit<HdDeskDepartmentCounts, "recurring">): string {
  const parts = [
    c.macros && plural(c.macros, "macro"),
    c.canned && plural(c.canned, "canned response"),
    c.checklists && plural(c.checklists, "checklist"),
    c.workflows && plural(c.workflows, "workflow"),
    c.request_types && plural(c.request_types, "request type"),
    c.automations && plural(c.automations, "automation"),
  ].filter(Boolean) as string[];
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Delete a department. Refused (409, with the sentence) for the default department, and
 * while teams are in it (move them first: a team is always in a department). Its content
 * moves to `moveContentTo` (another department) when given; without it, a department that
 * still holds content is refused too. One transaction, the department row locked.
 */
export async function deleteDeskDepartment(
  id: number,
  moveContentTo?: number | null
): Promise<{ department: HdDeskDepartment; moved: Omit<HdDeskDepartmentCounts, "recurring">; to: HdDeskDepartment | null }> {
  return withTx(async (client) => {
    const d = await hqOne<HdDeskDepartment>(`SELECT ${COLS} FROM hd_desk_departments WHERE id = $1 FOR UPDATE`, [id], client);
    if (!d) throw new DeskDepartmentError("Desk department not found.", 404);
    if (d.is_default) throw new DeskDepartmentError(`${d.name} is the desk's default department: new teams and new content go there. Rename it instead.`, 409);
    const teams = await hq<{ name: string }>("SELECT name FROM hd_teams WHERE desk_department_id = $1 ORDER BY position, lower(name) FOR UPDATE", [id], client);
    if (teams.length) {
      const names = teams.slice(0, 3).map((t) => t.name).join(", ") + (teams.length > 3 ? ` and ${teams.length - 3} more` : "");
      throw new DeskDepartmentError(`Move its ${plural(teams.length, "team")} (${names}) to another desk department first. A team is always in a department.`, 409);
    }
    const counts = (await hqOne<HdDeskDepartmentCounts & { id: number }>(`${COUNT_SQL} WHERE d.id = $1`, [id], client))!;
    const { id: _id, recurring: _r, ...content } = counts;
    const total = Object.values(content).reduce((a, b) => a + b, 0);
    // Personal items carry no department; this sweeps any stray reference so RESTRICT never trips on one.
    await client.query("UPDATE hd_macros SET desk_department_id = NULL WHERE desk_department_id = $1 AND owner_id IS NOT NULL", [id]);
    await client.query("UPDATE hd_canned_responses SET desk_department_id = NULL WHERE desk_department_id = $1 AND owner_id IS NOT NULL", [id]);
    let to: HdDeskDepartment | null = null;
    if (total > 0) {
      if (moveContentTo === undefined || moveContentTo === null) {
        throw new DeskDepartmentError(`${d.name} still holds ${countsInWords(content)}. Move them to another desk department, or delete them, first.`, 409);
      }
      if (moveContentTo === id) throw new DeskDepartmentError("Pick another desk department to move its content to.");
      to = (await hqOne<HdDeskDepartment>(`SELECT ${COLS} FROM hd_desk_departments WHERE id = $1 FOR SHARE`, [moveContentTo], client)) ?? null;
      if (!to) throw new DeskDepartmentError("The desk department to move its content to no longer exists.", 400);
      for (const table of Object.values(CONTENT_TABLES)) await client.query(`UPDATE ${table} SET desk_department_id = $2 WHERE desk_department_id = $1`, [id, to.id]);
    }
    await client.query("DELETE FROM hd_desk_departments WHERE id = $1", [id]);
    return { department: d, moved: content, to };
  });
}

/**
 * Move a team to another department (Admin). The team's own team-shared macros and canned
 * responses go with it (they are the team's; leaving them behind would hide them from the
 * team). Nothing else moves: department-wide content stays where it is, and so do request
 * types that route to the team. Its tickets and recurring tickets follow the team's
 * department from now on (automations: the new department's rules); workflow runs already
 * on their way finish on the version they pinned.
 */
export async function moveTeamToDeskDepartment(
  teamId: number,
  deptId: number
): Promise<{ team: { id: number; name: string }; from: HdDeskDepartment; to: HdDeskDepartment; moved: { macros: number; canned: number } } | null> {
  return withTx(async (client) => {
    const to = await hqOne<HdDeskDepartment>(`SELECT ${COLS} FROM hd_desk_departments WHERE id = $1 FOR SHARE`, [deptId], client);
    if (!to) throw new DeskDepartmentError("That desk department no longer exists.", 400);
    const team = await hqOne<{ id: number; name: string; desk_department_id: number }>("SELECT id, name, desk_department_id FROM hd_teams WHERE id = $1 FOR UPDATE", [teamId], client);
    if (!team) throw new DeskDepartmentError("Team not found.", 404);
    const from = (await hqOne<HdDeskDepartment>(`SELECT ${COLS} FROM hd_desk_departments WHERE id = $1`, [team.desk_department_id], client))!;
    if (team.desk_department_id === deptId) return null;
    await client.query("UPDATE hd_teams SET desk_department_id = $2 WHERE id = $1", [teamId, deptId]);
    const macros = await client.query("UPDATE hd_macros SET desk_department_id = $2 WHERE team_id = $1 AND owner_id IS NULL", [teamId, deptId]);
    const canned = await client.query("UPDATE hd_canned_responses SET desk_department_id = $2 WHERE team_id = $1 AND owner_id IS NULL", [teamId, deptId]);
    return { team: { id: team.id, name: team.name }, from, to, moved: { macros: macros.rowCount ?? 0, canned: canned.rowCount ?? 0 } };
  });
}

// --- SQL helpers for a create ---------------------------------------------------------------

/**
 * A create's department as a text parameter: "default" (the column's own default: the
 * default department), "all" (NULL) or the id. Use with deptInsertSql(n).
 */
export function deptArg(v: number | null | undefined): string {
  return v === undefined ? "default" : v === null ? "all" : String(v);
}

/** The INSERT value for parameter $n carrying deptArg(). */
export function deptInsertSql(n: number): string {
  return `(CASE $${n}::text WHEN 'default' THEN hd_default_desk_department() WHEN 'all' THEN NULL ELSE $${n}::text::int END)`;
}
