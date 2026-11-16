// POST /api/helpdesk/admin/workflows/[id]/publish
// The draft, checked again, becomes what new requests run (version + 1).
// Requests already on their way keep the version they started with.
// Helpdesk 1.19.0 (desk capability workflows.manage).
// 1.20.23: only a workflow of a desk department the caller manages (lib/helpdesk/desk-departments;
// "Manage a desk department" too; All departments: desk Admin only).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { getWorkflow, publishWorkflow } from "@/lib/helpdesk/workflows";
import { deskDepartmentGate, itemRefusal } from "@/lib/helpdesk/desk-departments";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const g = await deskDepartmentGate("workflows");
  if (g instanceof NextResponse) return g;
  const gate = g.user;
  const raw = (await ctx.params).id;
  if (!/^\d{1,9}$/.test(raw)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const existing = await getWorkflow(Number(raw));
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const refused = itemRefusal(g.access, existing.desk_department_id);
  if (refused) return refused;
  const result = await publishWorkflow(Number(raw));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.workflow.published",
    targetType: "helpdesk_workflow",
    targetId: result.workflow.id,
    targetLabel: result.workflow.title,
    details: { version: result.version, steps: result.workflow.definition.steps.length },
    ip: ipFrom(req),
  });
  return NextResponse.json({ workflow: result.workflow, version: result.version });
}
