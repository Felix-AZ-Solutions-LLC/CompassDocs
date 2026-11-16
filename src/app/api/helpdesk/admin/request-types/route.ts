// GET  /api/helpdesk/admin/request-types   every request type (switched-off ones too)
// POST /api/helpdesk/admin/request-types   { title, slug?, description?, icon?, team_id?, category?,
//        form?, workflow_id?, sla_priority?, visibility?, group_ids?, active?, position?, eta_label?,
//        desk_department_id? }
// Helpdesk 1.19.0 (desk capability request_types.manage). The form is checked field by field
// (lib/helpdesk/request-types validateFormFields).
// 1.20.23 (lib/helpdesk/desk-departments): a request type is in one desk department
// (desk_department_id; null = All departments, desk Admin only). It decides which agents are
// offered it (Start a workflow, New ticket, Claude), never which requesters may use it (Get help,
// the portal: visibility and groups, as before). Its workflow must be in the same department or
// in All departments (400 with the sentence). The list shows the caller's departments' types and
// All departments' (?desk_department=<id>|all filters), each with can_edit; "Manage a desk
// department" opens this page for their own teams' departments (review M3).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { createRequestType, listRequestTypes, validateRequestTypeInput } from "@/lib/helpdesk/request-types";
import {
  deskDepartmentFieldOr,
  deskDepartmentGate,
  filterByDeskDepartment,
  guardDeptRace,
  mayManageDept,
  maySeeDept,
  parseDeskDepartmentFilter,
  requestTypeWorkflowRefusal,
} from "@/lib/helpdesk/desk-departments";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await deskDepartmentGate("request_types");
  if (g instanceof NextResponse) return g;
  const types = filterByDeskDepartment(
    (await listRequestTypes()).filter((t) => maySeeDept(g.access, t.desk_department_id)),
    parseDeskDepartmentFilter(new URL(req.url).searchParams.get("desk_department"))
  );
  return NextResponse.json({ request_types: types.map((t) => ({ ...t, desk_department_id: t.desk_department_id ?? null, can_edit: mayManageDept(g.access, t.desk_department_id) })) });
}

async function postHandler(req: Request) {
  const g = await deskDepartmentGate("request_types");
  if (g instanceof NextResponse) return g;
  const gate = g.user;
  const body = await readJson(req, 128 * 1024);
  if (!body) return NextResponse.json({ error: "Send the request type as JSON." }, { status: 400 });
  const dept = await deskDepartmentFieldOr(g.access, body.desk_department_id);
  if (dept instanceof NextResponse) return dept;
  const input = await validateRequestTypeInput(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  const mismatch = await requestTypeWorkflowRefusal(dept.value, input.value.workflow_id);
  if (mismatch) return NextResponse.json({ error: mismatch, code: "desk_department" }, { status: 400 });
  let rt;
  try {
    rt = await createRequestType(input.value, dept.value);
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      return NextResponse.json({ error: "Another request type already uses that address name." }, { status: 409 });
    }
    throw e;
  }
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.request_type.created",
    targetType: "helpdesk_request_type",
    targetId: rt.id,
    targetLabel: rt.title,
    details: { slug: rt.slug, team_id: rt.team_id, workflow_id: rt.workflow_id, fields: rt.form.length, visibility: rt.visibility, desk_department_id: rt.desk_department_id ?? null },
    ip: ipFrom(req),
  });
  return NextResponse.json({ request_type: rt }, { status: 201 });
}

// 1.20.23 review L3: a save racing a desk department's deletion answers 409 with a sentence.
export const POST = guardDeptRace(postHandler);
