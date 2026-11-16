// GET  /api/helpdesk/admin/workflows   every workflow, with run counts and linked request types
// POST /api/helpdesk/admin/workflows   { title, slug?, description?, definition?, desk_department_id? }  a new, unpublished workflow
// Helpdesk 1.19.0 (desk capability workflows.manage). The steps go into the draft; publishing
// (POST …/[id]/publish) makes them what new requests run.
// 1.20.23 (lib/helpdesk/desk-departments): a workflow is in one desk department
// (desk_department_id; null = All departments, desk Admin only; left out, the caller's starting
// department). The list shows the caller's departments' workflows and All departments'
// (?desk_department=<id>|all filters), each with can_edit; "Manage a desk department" opens the
// builder for their own teams' departments (review M3).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { createWorkflow, EMPTY_DEFINITION, listWorkflows, validateWorkflowDefinition, validateWorkflowMeta } from "@/lib/helpdesk/workflows";
import {
  deskDepartmentFieldOr,
  deskDepartmentGate,
  filterByDeskDepartment,
  guardDeptRace,
  mayManageDept,
  maySeeDept,
  parseDeskDepartmentFilter,
} from "@/lib/helpdesk/desk-departments";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await deskDepartmentGate("workflows");
  if (g instanceof NextResponse) return g;
  const rows = filterByDeskDepartment(
    (await listWorkflows()).filter((w) => maySeeDept(g.access, w.desk_department_id)),
    parseDeskDepartmentFilter(new URL(req.url).searchParams.get("desk_department"))
  );
  return NextResponse.json({ workflows: rows.map((w) => ({ ...w, desk_department_id: w.desk_department_id ?? null, can_edit: mayManageDept(g.access, w.desk_department_id) })) });
}

async function postHandler(req: Request) {
  const g = await deskDepartmentGate("workflows");
  if (g instanceof NextResponse) return g;
  const gate = g.user;
  const body = await readJson(req, 256 * 1024);
  if (!body) return NextResponse.json({ error: "Send the workflow as JSON." }, { status: 400 });
  const dept = await deskDepartmentFieldOr(g.access, body.desk_department_id);
  if (dept instanceof NextResponse) return dept;
  const meta = await validateWorkflowMeta(body);
  if (!meta.ok) return NextResponse.json({ error: meta.error }, { status: 400 });
  const def = body.definition === undefined ? { ok: true as const, value: EMPTY_DEFINITION } : await validateWorkflowDefinition(body.definition, null, dept.value);
  if (!def.ok) return NextResponse.json({ error: def.error }, { status: 400 });
  const workflow = await createWorkflow(meta.value, def.value, dept.value);
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.workflow.created",
    targetType: "helpdesk_workflow",
    targetId: workflow.id,
    targetLabel: workflow.title,
    details: { slug: workflow.slug, steps: def.value.steps.length, desk_department_id: workflow.desk_department_id ?? null },
    ip: ipFrom(req),
  });
  return NextResponse.json({ workflow }, { status: 201 });
}

// 1.20.23 review L3: a save racing a desk department's deletion answers 409 with a sentence.
export const POST = guardDeptRace(postHandler);
