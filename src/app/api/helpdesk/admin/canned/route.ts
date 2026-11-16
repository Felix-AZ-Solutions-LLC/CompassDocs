// GET  /api/helpdesk/admin/canned   the library: every response the caller may see, each with can_edit and its uses in 30 days, plus share_options and placeholders
//      (1.20.23: ?desk_department=<id>|all filters by desk department)
// POST /api/helpdesk/admin/canned   { title, body, folder?, share: "me" | "workspace" | "team:<id>", desk_department_id? }
//   (30 a minute per person; 200 personal ones per owner, 2,000 shared ones in all)
// With macros.manage_all, GET also lists inactive_owners: deactivated people
// who still own personal responses, with a count only (./inactive deletes them).
// Helpdesk 1.19.2 (agent W4). Desk settings → Canned responses. Who writes
// which sharing is agent J's macro capabilities (lib/helpdesk/canned):
// only me macros.manage_personal, a team macros.manage_team in that team
// (its team leads), the workspace macros.manage_all. Audited as
// helpdesk.canned.created.
// 1.20.23 (lib/helpdesk/desk-departments): "workspace" is everyone in the response's desk
// department (desk_department_id; null = All departments, desk Admin only; left out, the
// caller's starting department). A team's response is in its team's department. A shared one is
// written only in a department the caller manages, where "Manage a desk department" stands in for
// the team and workspace capabilities (canned mayManageCanned). The library lists the caller's
// departments' responses, All departments' (read-only unless Admin), their teams' and their own.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { agentTeamIds, hdRateLimited, readJson, tooMany } from "@/lib/helpdesk/access";
import { HD_FORBIDDEN, hdAnyCapGate, hdCan } from "@/lib/helpdesk/roles";
import {
  CANNED_MANAGE_CAPS,
  CANNED_PLACEHOLDERS,
  CannedError,
  cannedScope,
  createCanned,
  inactiveOwners,
  listCanned,
  mayManageCanned,
  shareOptionsFor,
  validateCannedInput,
  type CannedInput,
} from "@/lib/helpdesk/canned";
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

export async function GET(req: Request) {
  const gate = await hdAnyCapGate(CANNED_MANAGE_CAPS);
  if (gate instanceof NextResponse) return gate;
  const all = await hdCan(gate, "macros.manage_all");
  const access = await deskDepartmentAccess(gate, "canned");
  const wide = all || access.admin || access.departmentManager;
  const list = (await listCanned(wide ? "all" : await agentTeamIds(gate), gate.id, access.scope)).filter((c) => c.owner_id || maySeeDept(access, c.desk_department_id));
  const canned = [];
  for (const c of filterByDeskDepartment(list, parseDeskDepartmentFilter(new URL(req.url).searchParams.get("desk_department")))) {
    canned.push({ ...c, can_edit: await mayManageCanned(gate, c, access) });
  }
  return NextResponse.json(
    { canned, share_options: await shareOptionsFor(gate, access), placeholders: CANNED_PLACEHOLDERS, ...(all ? { inactive_owners: await inactiveOwners() } : {}) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

async function postHandler(req: Request) {
  const gate = await hdAnyCapGate(CANNED_MANAGE_CAPS);
  if (gate instanceof NextResponse) return gate;
  if (hdRateLimited(`hd-canned-new:${gate.id}`, 30, 60_000)) return tooMany();
  const body = await readJson(req, 64 * 1024);
  if (!body) return NextResponse.json({ error: "Send the canned response as JSON." }, { status: 400 });
  try {
    const input = (await validateCannedInput(body, gate.id)) as CannedInput;
    const access = await deskDepartmentAccess(gate, "canned");
    if (!input.owner_id && !input.team_id) {
      const d = await resolveDeskDepartmentField(access, body.desk_department_id);
      if (!d.ok) return NextResponse.json({ error: d.error, code: "desk_department" }, { status: d.status });
      input.desk_department_id = d.value;
    } else if (input.team_id) {
      input.desk_department_id = await teamDeskDepartmentId(input.team_id);
    }
    if (!(await mayManageCanned(gate, input, access))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
    const c = await createCanned(input, gate.id);
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.canned.created",
      targetType: "helpdesk_canned",
      targetId: c.id,
      targetLabel: c.title,
      details: { scope: cannedScope(c), team_id: c.team_id, folder: c.folder || null, ...(c.owner_id ? {} : { desk_department_id: c.desk_department_id ?? null }) },
      ip: ipFrom(req),
    });
    return NextResponse.json({ canned: { ...c, can_edit: true } }, { status: 201 });
  } catch (e) {
    if (e instanceof CannedError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

// 1.20.23 review L3: a save racing a desk department's deletion answers 409 with a sentence.
export const POST = guardDeptRace(postHandler);
