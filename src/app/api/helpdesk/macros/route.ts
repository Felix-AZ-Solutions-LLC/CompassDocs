// GET /api/helpdesk/macros   the macros an agent may use (everyone's, their teams', their own), for the composer
// Helpdesk 1.19.0 (macros.use, agent J's capability).
// 1.20.23: "everyone's" is everyone's in the agent's desk departments plus All departments
// (lib/helpdesk/desk-departments); applying one checks the same (macros applyMacroAs).

import { NextResponse } from "next/server";
import { agentTeamIds } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { MACRO_PLACEHOLDERS, listMacros } from "@/lib/helpdesk/macros";
import { deskDepartmentScope } from "@/lib/helpdesk/desk-departments";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("macros.use");
  if (gate instanceof NextResponse) return gate;
  const [teams, depts] = await Promise.all([agentTeamIds(gate), deskDepartmentScope(gate)]);
  const macros = (await listMacros(teams, gate.id, depts)).map((m) => ({
    id: m.id,
    title: m.title,
    body: m.body,
    actions: m.actions,
    team_id: m.team_id,
    team_name: m.team_name,
    scope: m.scope,
    desk_department_id: m.desk_department_id ?? null,
  }));
  return NextResponse.json({ macros, placeholders: MACRO_PLACEHOLDERS }, { headers: { "Cache-Control": "no-store" } });
}
