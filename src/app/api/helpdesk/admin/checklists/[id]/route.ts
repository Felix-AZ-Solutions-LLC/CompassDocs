// PUT    /api/helpdesk/admin/checklists/[id]  { name?, items?, request_type_ids? } → { template }.
//        Tickets keep the copy they have. Audited (helpdesk.checklist_template.updated, what changed).
// DELETE /api/helpdesk/admin/checklists/[id] → { ok }. 409 while a workflow task adds it.
//        Tickets keep their copies. Audited (helpdesk.checklist_template.deleted).
// Helpdesk 1.19.2 (agent W3). Desk capability settings.manage, request_types.manage or
// workflows.manage (lib/helpdesk/checklists-caps).
// 1.20.14, drafts from Claude (review fixes: a save never publishes or clears a draft it
//        wasn't asked to, and each publish names the draft the person reviewed):
//        PUT { …, publish: true, draft_at } saves and publishes an unpublished draft;
//        PUT { …, publish_draft: true, draft_at } publishes the changes waiting on a published
//        checklist (fields not sent come from that draft). Both audited
//        helpdesk.checklist_template.published; 409 when draft_at isn't the current draft's.
//        A plain PUT edits the live copy (or the unpublished draft) and keeps a pending draft.
//        PUT { discard_draft: true, draft_at? } drops the changes waiting on a published checklist
//        (helpdesk.checklist_template.draft_discarded; 409 when there are none or a newer one).
//        An unpublished draft is discarded with DELETE.

// 1.20.23 (lib/helpdesk/desk-departments): only a checklist of a desk department the caller
//        manages (another department's is a 404, an All departments one a 403 unless desk Admin);
//        desk_department_id in the body moves it (to one they manage; null = All departments,
//        Admin only), audited helpdesk.desk_department.item_moved.
//        Review M2/M3/M4: managing means a department of the caller's own teams; a request type
//        newly added is one of the checklist's department (any, when it is in All departments),
//        400 otherwise; a move that would leave a request type or a workflow task adding it
//        across departments answers 409 { code: "desk_department_dependents", dependents }.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { notFound } from "@/lib/helpdesk/routes";
import { ChecklistError, deleteTemplate, discardTemplateDraft, getTemplate, updateTemplate } from "@/lib/helpdesk/checklists";
import {
  deskDepartmentFieldOr,
  deskDepartmentGate,
  guardDeptRace,
  itemRefusal,
  auditItemDeskDepartment,
  moveRefusal,
} from "@/lib/helpdesk/desk-departments";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const idOf = (raw: string) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function putHandler(req: Request, { params }: Ctx) {
  const g = await deskDepartmentGate("checklists");
  if (g instanceof NextResponse) return g;
  const gate = g.user;
  const id = idOf((await params).id);
  if (!id) return notFound();
  const cur = await getTemplate(id);
  if (!cur) return notFound();
  const refused = itemRefusal(g.access, cur.desk_department_id);
  if (refused) return refused;
  const b = await readJson(req, 64 * 1024);
  if (!b) return NextResponse.json({ error: "Send the checklist as JSON." }, { status: 400 });
  const dept = await deskDepartmentFieldOr(g.access, b.desk_department_id, cur.desk_department_id ?? null);
  if (dept instanceof NextResponse) return dept;
  try {
    if (b.discard_draft === true) {
      const gone = await discardTemplateDraft(id, b.draft_at);
      if (!gone) return (await getTemplate(id)) ? NextResponse.json({ error: "There are no changes waiting on this checklist." }, { status: 409 }) : notFound();
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.checklist_template.draft_discarded",
        targetType: "helpdesk_checklist",
        targetId: id,
        targetLabel: gone.name,
        details: { drafted_by: gone.draft_by_name, drafted_via: gone.draft_via },
        ip: ipFrom(req),
      });
      return NextResponse.json({ template: await getTemplate(id) });
    }
    const { desk_department_id: _dept, ...fields } = b;
    // Review M2/M4: a move that would leave a request type or a workflow task adding it across departments is refused, with the list.
    const blocked = await moveRefusal("checklists", id, cur.desk_department_id ?? null, dept.value);
    if (blocked) return blocked;
    const r = await updateTemplate(id, fields, { publish: b.publish === true, publishDraft: b.publish_draft === true, draftAt: b.draft_at, dept: dept.value });
    if (!r) return notFound();
    await auditItemDeskDepartment(gate, "checklists", { id, label: r.after.name }, cur.desk_department_id ?? null, dept.value, ipFrom(req));
    r.after = { ...r.after, desk_department_id: dept.value };
    const changed = (["name", "items", "request_type_ids"] as const).filter((k) => JSON.stringify(r.before[k]) !== JSON.stringify(r.after[k]));
    // 1.20.14: a Claude draft made live, only on an explicit publish (a new one, or the changes waiting on a published one).
    if (r.published) {
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.checklist_template.published",
        targetType: "helpdesk_checklist",
        targetId: id,
        targetLabel: r.after.name,
        details: {
          changed,
          items: r.after.items.length,
          required: r.after.items.filter((i) => i.required).length,
          request_type_ids: r.after.request_type_ids,
          drafted_by: r.before.draft_by_name,
          drafted_via: r.before.draft_via,
        },
        ip: ipFrom(req),
      });
    } else if (changed.length) {
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.checklist_template.updated",
        targetType: "helpdesk_checklist",
        targetId: id,
        targetLabel: r.after.name,
        details: {
          changed,
          ...(changed.includes("name") ? { name_before: r.before.name } : {}),
          items: r.after.items.length,
          required: r.after.items.filter((i) => i.required).length,
          request_type_ids: r.after.request_type_ids,
        },
        ip: ipFrom(req),
      });
    }
    return NextResponse.json({ template: r.after });
  } catch (e) {
    if (e instanceof ChecklistError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const g = await deskDepartmentGate("checklists");
  if (g instanceof NextResponse) return g;
  const gate = g.user;
  const id = idOf((await params).id);
  if (!id) return notFound();
  const cur = await getTemplate(id);
  if (!cur) return notFound();
  const refused = itemRefusal(g.access, cur.desk_department_id);
  if (refused) return refused;
  try {
    const t = await deleteTemplate(id);
    if (!t) return notFound();
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.checklist_template.deleted",
      targetType: "helpdesk_checklist",
      targetId: id,
      targetLabel: t.name,
      details: { items: t.items.length },
      ip: ipFrom(req),
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ChecklistError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

// 1.20.23 review L3: a save racing a desk department's deletion answers 409 with a sentence.
export const PUT = guardDeptRace(putHandler);
