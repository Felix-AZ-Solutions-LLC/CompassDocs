// GET    /api/helpdesk/admin/workflows/[id]   the workflow (published definition + draft)
// PATCH  /api/helpdesk/admin/workflows/[id]   { title?, slug?, description?, draft? }
//          draft: the builder's steps, saved unpublished; draft: null throws the edits away
// DELETE /api/helpdesk/admin/workflows/[id]   linked request types stop starting runs;
//          runs already on their way finish on the version they pinned
// Helpdesk 1.19.0 (desk capability workflows.manage).
// 1.20.23 (lib/helpdesk/desk-departments): only a workflow of a desk department the caller
// manages (another department's is a 404, an All departments one a 403 unless desk Admin; GET
// reads any they see, with can_edit). PATCH { desk_department_id } moves it (to one they manage;
// null = All departments, Admin only), audited helpdesk.desk_department.item_moved. Runs on
// their way are unaffected: they finish on the version they pinned.
// Review M1/M2/M3/M4: managing means a department of the caller's own teams. The draft's trigger
// request type and its tasks' checklists must be in the workflow's department or in All
// departments (400 with the sentence). A move that would leave a request type starting it, or
// a checklist it adds, across departments answers 409 { code: "desk_department_dependents",
// dependents: [{kind,id,title}] } and moves nothing.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import {
  deleteWorkflow,
  discardWorkflowDraft,
  getWorkflow,
  saveWorkflowDraft,
  validateWorkflowDefinition,
  validateWorkflowMeta,
} from "@/lib/helpdesk/workflows";
import {
  deskDepartmentFieldOr,
  deskDepartmentGate,
  guardDeptRace,
  itemRefusal,
  mayManageDept,
  maySeeDept,
  auditItemDeskDepartment,
  moveRefusal,
} from "@/lib/helpdesk/desk-departments";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const idOf = (raw: string) => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);

export async function GET(_req: Request, ctx: Ctx) {
  const g = await deskDepartmentGate("workflows");
  if (g instanceof NextResponse) return g;
  const id = idOf((await ctx.params).id);
  const workflow = id === null ? undefined : await getWorkflow(id);
  if (!workflow || !maySeeDept(g.access, workflow.desk_department_id)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ workflow: { ...workflow, can_edit: mayManageDept(g.access, workflow.desk_department_id) } });
}

async function patchHandler(req: Request, ctx: Ctx) {
  const g = await deskDepartmentGate("workflows");
  if (g instanceof NextResponse) return g;
  const gate = g.user;
  const id = idOf((await ctx.params).id);
  const existing = id === null ? undefined : await getWorkflow(id);
  if (!existing || id === null) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const refused = itemRefusal(g.access, existing.desk_department_id);
  if (refused) return refused;
  const body = await readJson(req, 256 * 1024);
  if (!body) return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });
  const dept = await deskDepartmentFieldOr(g.access, body.desk_department_id, existing.desk_department_id ?? null);
  if (dept instanceof NextResponse) return dept;
  // Review M4: a move that would leave a request type or a checklist across departments is refused, with the list.
  const blocked = await moveRefusal("workflows", id, existing.desk_department_id ?? null, dept.value);
  if (blocked) return blocked;

  if (body.draft === null) {
    if (!existing.published) return NextResponse.json({ error: "An unpublished workflow has only its draft." }, { status: 400 });
    const workflow = await discardWorkflowDraft(id);
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.workflow.draft_discarded",
      targetType: "helpdesk_workflow",
      targetId: id,
      targetLabel: existing.title,
      ip: ipFrom(req),
    });
    return NextResponse.json({ workflow });
  }

  const meta = await validateWorkflowMeta(body, existing);
  if (!meta.ok) return NextResponse.json({ error: meta.error }, { status: 400 });
  let draft;
  if (body.draft !== undefined) {
    const checked = await validateWorkflowDefinition(body.draft, id, dept.value);
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
    draft = checked.value;
  }
  let workflow = await saveWorkflowDraft(id, meta.value, draft, dept.value);
  if (!workflow) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await auditItemDeskDepartment(gate, "workflows", { id, label: workflow.title }, existing.desk_department_id ?? null, dept.value, ipFrom(req));
  workflow = { ...workflow, desk_department_id: dept.value };
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.workflow.updated",
    targetType: "helpdesk_workflow",
    targetId: id,
    targetLabel: workflow.title,
    details: {
      fields: Object.keys(body).filter((k) => ["title", "slug", "description", "draft"].includes(k)),
      steps: draft ? draft.steps.length : undefined,
    },
    ip: ipFrom(req),
  });
  return NextResponse.json({ workflow });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const g = await deskDepartmentGate("workflows");
  if (g instanceof NextResponse) return g;
  const gate = g.user;
  const id = idOf((await ctx.params).id);
  const existing = id === null ? undefined : await getWorkflow(id);
  if (!existing) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const refused = itemRefusal(g.access, existing.desk_department_id);
  if (refused) return refused;
  const removed = await deleteWorkflow(existing.id);
  if (!removed) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.workflow.deleted",
    targetType: "helpdesk_workflow",
    targetId: removed.id,
    targetLabel: removed.title,
    details: { version: removed.version, published: removed.published === 1, runs_open: removed.runs_open },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

// 1.20.23 review L3: a save racing a desk department's deletion answers 409 with a sentence.
export const PATCH = guardDeptRace(patchHandler);
