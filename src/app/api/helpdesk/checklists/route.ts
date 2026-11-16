// GET /api/helpdesk/checklists → { templates: [{ id, name, items, required, desk_department_id }] }
// Helpdesk 1.19.2 (agent W3): the checklist library in short, for agents (the
// workflow builder's task step "Add checklist"). Names only: items are read on a ticket.
// 1.20.23: only the caller's desk departments' checklists and All departments'
// (lib/helpdesk/desk-departments; a desk Admin sees every one).

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { templateOptions } from "@/lib/helpdesk/checklists";
import { deskDepartmentScope } from "@/lib/helpdesk/desk-departments";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ templates: await templateOptions(await deskDepartmentScope(gate)) }, { headers: { "Cache-Control": "no-store" } });
}
