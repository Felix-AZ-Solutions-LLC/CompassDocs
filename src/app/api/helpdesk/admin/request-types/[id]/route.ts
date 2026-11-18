// GET    /api/helpdesk/admin/request-types/[id]   the type (with open_requests for the delete dialog)
// PATCH  /api/helpdesk/admin/request-types/[id]   any of the POST fields; left out = unchanged
// DELETE /api/helpdesk/admin/request-types/[id]   its requests keep their answers (request_type_id SET NULL)
// Helpdesk 1.19.0 (desk capability request_types.manage).
// 1.20.23 (lib/helpdesk/desk-departments): only a type of a desk department the caller manages
// (another department's is a 404, an All departments one a 403 unless desk Admin; GET reads any
// they see, with can_edit). desk_department_id moves it (to one they manage; null = All
// departments, Admin only), audited helpdesk.desk_department.item_moved; its workflow must then
// be in the same department or All departments.
// Review M3/M4: managing means a department of the caller's own teams. The workflow check runs only
// when the workflow or the department changes ({ active: 0 } always works). A move that would leave
// a workflow triggering on it, a checklist it adds or a recurring ticket filing it across
// departments answers 409 { code: "desk_department_dependents", dependents } and moves nothing.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import {
  deleteRequestType,
  getRequestType,
  openRequestCount,
  updateRequestType,
  validateRequestTypeInput,
} from "@/lib/helpdesk/request-types";
import {
  dependentsResponse,
  deskDepartmentFieldOr,
  deskDepartmentGate,
  deskDepartmentName,
  guardDeptRace,
  itemRefusal,
  mayManageDept,
  maySeeDept,
  moveDependents,
  auditItemDeskDepartment,
  requestTypeWorkflowRefusal,
} from "@/lib/helpdesk/desk-departments";
import { portalPruneDetails, type PortalPruneResult } from "@/lib/helpdesk/portal-refs";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const idOf = (raw: string) => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);

export async function GET(_req: Request, ctx: Ctx) {
  const g = await deskDepartmentGate("request_types");
  if (g instanceof NextResponse) return g;
  const id = idOf((await ctx.params).id);
  const rt = id === null ? undefined : await getRequestType(id);
  if (!rt || !maySeeDept(g.access, rt.desk_department_id)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ request_type: { ...rt, can_edit: mayManageDept(g.access, rt.desk_department_id) }, open_requests: await openRequestCount(rt.id) });
}

async function patchHandler(req: Request, ctx: Ctx) {
  const g = await deskDepartmentGate("request_types");
  if (g instanceof NextResponse) return g;
  const gate = g.user;
  const id = idOf((await ctx.params).id);
  const existing = id === null ? undefined : await getRequestType(id);
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const refused = itemRefusal(g.access, existing.desk_department_id);
  if (refused) return refused;
  const body = await readJson(req, 128 * 1024);
  if (!body) return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });
  const dept = await deskDepartmentFieldOr(g.access, body.desk_department_id, existing.desk_department_id ?? null);
  if (dept instanceof NextResponse) return dept;
  const input = await validateRequestTypeInput(body, existing);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  // Review M4 (b): checked only when the workflow or the department changes, so switching a type off
  // (or editing its form) always works, whatever moved meanwhile.
  const from = existing.desk_department_id ?? null;
  const moved = (dept.value ?? null) !== from;
  if (moved || (input.value.workflow_id ?? null) !== (existing.workflow_id ?? null)) {
    const mismatch = await requestTypeWorkflowRefusal(dept.value, input.value.workflow_id);
    if (mismatch) return NextResponse.json({ error: mismatch, code: "desk_department" }, { status: 400 });
  }
  if (moved) {
    // Review M1/M2/M4 (a): what uses it (workflows triggering on it, checklists it adds, recurring
    // tickets filing it) must fit its new department; its own (new) workflow_id was checked just
    // above. Review N3: a workflow whose trigger names it is listed even if it was its workflow_id.
    const deps = await moveDependents("request_types", existing.id, dept.value, { ownWorkflowChecked: true });
    if (deps.length) return dependentsResponse(deps, await deskDepartmentName(dept.value));
  }
  let rt;
  try {
    rt = await updateRequestType(existing.id, input.value, dept.value);
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      return NextResponse.json({ error: "Another request type already uses that address name." }, { status: 409 });
    }
    throw e;
  }
  if (!rt) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await auditItemDeskDepartment(gate, "request_types", { id: rt.id, label: rt.title }, existing.desk_department_id ?? null, dept.value, ipFrom(req));
  rt = { ...rt, desk_department_id: dept.value };
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.request_type.updated",
    targetType: "helpdesk_request_type",
    targetId: rt.id,
    targetLabel: rt.title,
    details: { fields: Object.keys(body).slice(0, 20), workflow_id: rt.workflow_id, active: rt.active },
    ip: ipFrom(req),
  });
  return NextResponse.json({ request_type: rt });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const g = await deskDepartmentGate("request_types");
  if (g instanceof NextResponse) return g;
  const gate = g.user;
  const id = idOf((await ctx.params).id);
  const existing = id === null ? undefined : await getRequestType(id);
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const refused = itemRefusal(g.access, existing.desk_department_id);
  if (refused) return refused;
  const pruned: { portal?: PortalPruneResult | null } = {};
  const removed = await deleteRequestType(existing.id, pruned);
  if (!removed) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.request_type.deleted",
    targetType: "helpdesk_request_type",
    targetId: removed.id,
    targetLabel: removed.title,
    // 1.20.30: and what left the customer portal's settings with it.
    details: { slug: removed.slug, ...portalPruneDetails(pruned.portal) },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

// 1.20.23 review L3: a save racing a desk department's deletion answers 409 with a sentence.
export const PATCH = guardDeptRace(patchHandler);
