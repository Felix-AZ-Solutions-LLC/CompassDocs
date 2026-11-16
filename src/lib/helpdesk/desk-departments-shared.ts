// Helpdesk 1.20.23: desk departments, the pure half (types, labels, checks).
// The Desk departments settings page, every content editor's Department
// field and filter, and lib/helpdesk/desk-departments (server) share it. No
// server imports here.
//
// A desk department groups teams (each team is in exactly one) and holds the
// desk's content: macros, canned responses, checklists, workflows, request
// types and automations (each in exactly one department, or in "All
// departments", shared desk-wide). Recurring tickets are their team's and so
// in their team's department. Never confuse it with the requester's directory
// department (VIP lists, contact cards, the report filter `department=`): in
// copy it is a "desk department" wherever the two could be mixed up, and in
// code, the API and the database it is always desk_department.

/** One desk department. */
export interface HdDeskDepartment {
  id: number;
  name: string;
  /** The department that always exists ("General"): new teams and new content land here; it can't be deleted. */
  is_default: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}

/** What a desk department holds (the settings page and the delete refusal). */
export interface HdDeskDepartmentCounts {
  macros: number;
  canned: number;
  checklists: number;
  workflows: number;
  request_types: number;
  automations: number;
  /** Recurring tickets of its teams (they follow their team; not moved separately). */
  recurring: number;
}

/** A row of Desk settings → Desk departments. */
export interface HdDeskDepartmentRow extends HdDeskDepartment {
  teams: { id: number; name: string }[];
  counts: HdDeskDepartmentCounts;
}

/** The departments a person sees content of: "all", or these ids. "All departments" items are always seen. */
export type HdDeskDepartmentScope = "all" | number[];

export const DESK_DEPARTMENT_LIMITS = { name: 60, departments: 50 } as const;

/** The label of the shared, desk-wide choice (an item in no one department). */
export const ALL_DESK_DEPARTMENTS_LABEL = "All departments";

/** The content features that live in desk departments (the editors and the choices endpoint). */
export const DESK_DEPARTMENT_FEATURES = ["macros", "canned", "checklists", "workflows", "request_types", "automations", "recurring"] as const;
export type HdDeskDepartmentFeature = (typeof DESK_DEPARTMENT_FEATURES)[number];

export function isDeskDepartmentFeature(v: unknown): v is HdDeskDepartmentFeature {
  return typeof v === "string" && (DESK_DEPARTMENT_FEATURES as readonly string[]).includes(v);
}

/**
 * Is an item of department `deptId` (null = All departments) in `scope`?
 * Pure; the server's SQL (desk-departments deptVisibleSql) says the same.
 */
export function deskDepartmentInScope(deptId: number | null | undefined, scope: HdDeskDepartmentScope): boolean {
  if (deptId === null || deptId === undefined) return true;
  return scope === "all" || scope.includes(deptId);
}

/** A department's name, cleaned; or the sentence saying why not. */
export function checkDeskDepartmentName(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!name) return { ok: false, error: "Give the desk department a name." };
  if (name.length > DESK_DEPARTMENT_LIMITS.name) return { ok: false, error: `Keep the name under ${DESK_DEPARTMENT_LIMITS.name} characters.` };
  if (name.toLowerCase() === ALL_DESK_DEPARTMENTS_LABEL.toLowerCase()) return { ok: false, error: `"${ALL_DESK_DEPARTMENTS_LABEL}" is the name of the shared choice. Pick another name.` };
  return { ok: true, value: name };
}

/**
 * What an editor offers in its Department field and filter
 * (GET /api/helpdesk/desk-departments?feature=…). `departments` lists every
 * desk department (names are not secret) with whether this person may put
 * an item there; `can_all`: they may choose All departments (desk Admin);
 * `default_id`: the field's starting value for a new item; `filter`: show
 * the list's department filter (they see more than one department's items).
 */
export interface HdDeskDepartmentChoices {
  departments: { id: number; name: string; is_default: boolean; manageable: boolean }[];
  can_all: boolean;
  default_id: number | null;
  filter: boolean;
}

/** The name of an item's department for a list: the department's, or All departments. */
export function deskDepartmentLabel(deptId: number | null | undefined, departments: readonly { id: number; name: string }[]): string {
  if (deptId === null || deptId === undefined) return ALL_DESK_DEPARTMENTS_LABEL;
  return departments.find((d) => d.id === deptId)?.name ?? "Desk department";
}

/**
 * A list's `?desk_department=` filter: a department id, "all" (shared
 * desk-wide items only) or nothing. Unknown values are ignored (null).
 */
export function parseDeskDepartmentFilter(raw: string | null | undefined): number | "all" | null {
  if (!raw) return null;
  if (raw === "all") return "all";
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

/**
 * Apply a `?desk_department=` filter to rows that carry desk_department_id.
 * A personal macro or canned response (owner_id set) is in no department, so
 * any filter leaves it out.
 */
export function filterByDeskDepartment<T extends { desk_department_id?: number | null; owner_id?: number | null }>(rows: T[], filter: number | "all" | null): T[] {
  if (filter === null) return rows;
  const shared = rows.filter((r) => !r.owner_id);
  if (filter === "all") return shared.filter((r) => r.desk_department_id === null || r.desk_department_id === undefined);
  return shared.filter((r) => r.desk_department_id === filter);
}
