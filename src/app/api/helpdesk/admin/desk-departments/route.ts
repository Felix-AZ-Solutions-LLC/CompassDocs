// GET  /api/helpdesk/admin/desk-departments   every desk department with its teams and counts → { departments }
// POST /api/helpdesk/admin/desk-departments   { name } → 201 { department }
// Helpdesk 1.20.23 (lib/helpdesk/desk-departments). Desk Admin only (settings.manage): departments,
// and which team is in which, are the Admin's; "Manage a desk department" manages content inside one.
// A name is unique whatever its case (409). Audited helpdesk.desk_department.created.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { badRequest } from "@/lib/helpdesk/routes";
import { createDeskDepartment, DeskDepartmentError, listDeskDepartmentRows } from "@/lib/helpdesk/desk-departments";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ departments: await listDeskDepartmentRows() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 4 * 1024);
  if (!b) return badRequest("Send the desk department as JSON.");
  try {
    const department = await createDeskDepartment(b.name);
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.desk_department.created",
      targetType: "helpdesk_desk_department",
      targetId: department.id,
      targetLabel: department.name,
      ip: ipFrom(req),
    });
    return NextResponse.json({ department }, { status: 201 });
  } catch (e) {
    if (e instanceof DeskDepartmentError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
