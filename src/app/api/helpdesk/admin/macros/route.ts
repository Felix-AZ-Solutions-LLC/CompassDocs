// GET  /api/helpdesk/admin/macros   the macros the caller may manage, each with can_edit, and the placeholders
//      (1.20.23: ?desk_department=<id>|all filters by desk department)
// POST /api/helpdesk/admin/macros   { title, body, actions?, team_id?, personal?, desk_department_id? }
// Helpdesk 1.19.0. Who writes which scope is agent J's capability matrix:
// personal (the caller's own) macros.manage_personal, a team's
// macros.manage_team in that team, everyone's macros.manage_all. A
// personal macro is never listed to anyone but its owner. Audited as
// helpdesk.macro.created.
// 1.20.23 (lib/helpdesk/desk-departments): a shared macro is in one desk department
// (desk_department_id; null = All departments, desk Admin only). The caller manages it only in
// their own departments, with the scope's capability or "Manage a desk department" (macros
// macroManageable). A team macro is always in its team's department (desk_department_id is
// ignored for it); a macro for everyone left without one starts in the caller's starting
// department. The list shows the caller's departments' macros and All departments' (read-only
// unless Admin), their teams' and their own.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { memberTeamIds, readJson } from "@/lib/helpdesk/access";
import { HD_FORBIDDEN, hdAnyCapGate, hdCan } from "@/lib/helpdesk/roles";
import {
  MACRO_PLACEHOLDERS,
  MacroLimitError,
  createMacro,
  listMacros,
  macroManageable,
  validateMacroInput,
  type MacroInput,
} from "@/lib/helpdesk/macros";
import {
  deskDepartmentAccess,
  filterByDeskDepartment,
  guardDeptRace,
  maySeeDept,
  parseDeskDepartmentFilter,
  resolveDeskDepartmentField,
  teamDeskDepartmentId,
} from "@/lib/helpdesk/desk-departments";

export const dynamic = "force-dynamic";

const MANAGE_CAPS = ["macros.manage_personal", "macros.manage_team", "macros.manage_all", "departments.manage"] as const;

export async function GET(req: Request) {
  const gate = await hdAnyCapGate([...MANAGE_CAPS]);
  if (gate instanceof NextResponse) return gate;
  const access = await deskDepartmentAccess(gate, "macros");
  const wide = access.admin || access.departmentManager || (await hdCan(gate, "macros.manage_all"));
  const list = (await listMacros(wide ? "all" : await memberTeamIds(gate.id), gate.id, access.scope)).filter((m) => m.owner_id || maySeeDept(access, m.desk_department_id));
  const macros = [];
  for (const m of filterByDeskDepartment(list, parseDeskDepartmentFilter(new URL(req.url).searchParams.get("desk_department")))) {
    macros.push({ ...m, desk_department_id: m.desk_department_id ?? null, can_edit: await macroManageable(gate, access, m) });
  }
  return NextResponse.json({ macros, placeholders: MACRO_PLACEHOLDERS });
}

async function postHandler(req: Request) {
  const gate = await hdAnyCapGate([...MANAGE_CAPS]);
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 64 * 1024);
  if (!body) return NextResponse.json({ error: "Send the macro as JSON." }, { status: 400 });
  const input = await validateMacroInput(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  const value = input.value as MacroInput;
  const owner_id = value.personal ? gate.id : null;
  const access = await deskDepartmentAccess(gate, "macros");
  let dept: number | null = null;
  if (!owner_id) {
    if (value.team_id) dept = await teamDeskDepartmentId(value.team_id);
    else {
      const d = await resolveDeskDepartmentField(access, body.desk_department_id);
      if (!d.ok) return NextResponse.json({ error: d.error, code: "desk_department" }, { status: d.status });
      dept = d.value;
    }
  }
  if (!(await macroManageable(gate, access, { owner_id, team_id: value.team_id, desk_department_id: dept }))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  let macro;
  try {
    macro = await createMacro({ ...value, owner_id, desk_department_id: dept }, gate.id);
  } catch (e) {
    if (e instanceof MacroLimitError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.macro.created",
    targetType: "helpdesk_macro",
    targetId: macro.id,
    targetLabel: macro.title,
    details: {
      scope: owner_id ? "personal" : macro.team_id ? "team" : "everyone",
      team_id: macro.team_id,
      actions: Object.keys(macro.actions ?? {}),
      ...(owner_id ? {} : { desk_department_id: macro.desk_department_id ?? null }),
    },
    ip: ipFrom(req),
  });
  return NextResponse.json({ macro }, { status: 201 });
}

// 1.20.23 review L3: a save racing a desk department's deletion answers 409 with a sentence.
export const POST = guardDeptRace(postHandler);
