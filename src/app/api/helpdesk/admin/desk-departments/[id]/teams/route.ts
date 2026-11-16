// PUT /api/helpdesk/admin/desk-departments/[id]/teams   { team_id, confirm? } → { team, from, to, moved }
// Helpdesk 1.20.23 (lib/helpdesk/desk-departments moveTeamToDeskDepartment), desk Admin only.
// Moves one team into this desk department (a team is in exactly one). The team's own
// team-shared macros and canned responses go with it; nothing else moves (department-wide
// content stays, request types that route to the team stay). From now on the team's tickets
// meet the new department's automations and its recurring tickets are the new department's;
// workflow runs already on their way finish on the version they pinned. Moving a team to the
// department it is in answers 200 with moved: null and writes nothing. Audited
// helpdesk.desk_department.team_moved (from, to, what went with it, what it changed).
// Review M4/M5 (lib/helpdesk/desk-departments teamMoveImpact):
//   - an automation outside the new department sending one of the team's macros would break:
//     409 { code: "desk_department_dependents", dependents } and nothing moves;
//   - what stops applying to the team (rules of other departments naming it, request types,
//     checklists and workflows routing to it, recurring tickets of it whose request type the new
//     department doesn't see, and its agents who lose the old department's content) answers
//     409 { code: "confirm_team_move", affected } unless the body says confirm: true. The audit
//     carries that list.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hqOne } from "@/lib/helpdesk/db-core";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { badRequest, notFound } from "@/lib/helpdesk/routes";
import {
  DeskDepartmentError,
  dependentsResponse,
  getDeskDepartment,
  guardDeptRace,
  moveTeamToDeskDepartment,
  teamMoveChangesSomething,
  teamMoveImpact,
} from "@/lib/helpdesk/desk-departments";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function putHandler(req: Request, ctx: Ctx) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const raw = (await ctx.params).id;
  const id = /^\d{1,9}$/.test(raw) ? Number(raw) : null;
  const dept = id === null ? undefined : await getDeskDepartment(id);
  if (id === null || !dept) return notFound();
  const b = await readJson(req, 1024);
  const teamId = Number(b?.team_id);
  if (!Number.isInteger(teamId) || teamId <= 0) return badRequest("Choose a team to move.");
  const team = await hqOne<{ desk_department_id: number }>("SELECT desk_department_id FROM hd_teams WHERE id = $1", [teamId]);
  if (!team) return NextResponse.json({ error: "Team not found." }, { status: 404 });
  // Review M4/M5: what the move would break (refused) and what it changes (confirmed first).
  const impact = team.desk_department_id === id ? null : await teamMoveImpact(teamId, id);
  if (impact?.dependents.length) return dependentsResponse(impact.dependents, dept.name);
  if (impact && teamMoveChangesSomething(impact.affected) && b?.confirm !== true) {
    return NextResponse.json(
      { error: `Moving the team to ${dept.name} changes what applies to it. Review the list and confirm.`, code: "confirm_team_move", affected: impact.affected },
      { status: 409 }
    );
  }
  try {
    const r = await moveTeamToDeskDepartment(teamId, id);
    if (!r) return NextResponse.json({ ok: true, moved: null });
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.desk_department.team_moved",
      targetType: "helpdesk_team",
      targetId: r.team.id,
      targetLabel: r.team.name,
      details: {
        from_id: r.from.id,
        from: r.from.name,
        to_id: r.to.id,
        to: r.to.name,
        team_macros: r.moved.macros,
        team_canned_responses: r.moved.canned,
        ...(impact && teamMoveChangesSomething(impact.affected) ? { confirmed: true, affected: impact.affected } : {}),
      },
      ip: ipFrom(req),
    });
    return NextResponse.json({ ok: true, team: r.team, from: { id: r.from.id, name: r.from.name }, to: { id: r.to.id, name: r.to.name }, moved: r.moved });
  } catch (e) {
    if (e instanceof DeskDepartmentError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

// 1.20.23 review L3: a save racing a desk department's deletion answers 409 with a sentence.
export const PUT = guardDeptRace(putHandler);
