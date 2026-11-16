// GET  /api/helpdesk/admin/checklists → { templates: HdChecklistTemplateRow[], teams, request_types }
// POST /api/helpdesk/admin/checklists   { name, items, request_type_ids } → { template } (201).
//      Audited (helpdesk.checklist_template.created).
// Helpdesk 1.19.2 (agent W3; mock-up c2): Desk settings → Checklists. Desk capability
// settings.manage, request_types.manage or workflows.manage (lib/helpdesk/checklists-caps).
// 1.20.14: POST { draft: true, card_id, name, items, request_type_ids } is "Save as draft" on a
//      Claude in the desk card: a new unpublished checklist for a person to publish
//      (lib/helpdesk/checklists saveTemplateDraft). Only with card_id naming this person's offered
//      draft card with exactly this checklist (400 otherwise; review fix). Audited like the
//      connector's drafts, with via "claude_desk".

// 1.20.23 (lib/helpdesk/desk-departments): each checklist is in one desk department
//      (desk_department_id; null = All departments, desk Admin only). The list shows the
//      caller's departments' and All departments' (?desk_department=<id>|all filters), each with
//      can_edit; a new one goes into the body's department (one they manage) or their starting
//      one. "Manage a desk department" opens this page for their own teams' departments (review M3).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hq } from "@/lib/helpdesk/db-core";
import { checkTemplateInput, ChecklistError, createTemplate, listTemplateRows, saveTemplateDraft } from "@/lib/helpdesk/checklists";
import { offeredChecklistCard } from "@/lib/helpdesk/claude/chats";
import {
  deskDepartmentFieldOr,
  deskDepartmentGate,
  filterByDeskDepartment,
  guardDeptRace,
  mayManageDept,
  maySeeDept,
  parseDeskDepartmentFilter,
  requestTypeOptions,
} from "@/lib/helpdesk/desk-departments";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await deskDepartmentGate("checklists");
  if (g instanceof NextResponse) return g;
  const [templates, teams, types] = await Promise.all([
    listTemplateRows(),
    hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams ORDER BY position, lower(name), id"),
    // Review L1: only the request types of the caller's departments (and All departments').
    requestTypeOptions(g.access.scope).then((l) => l.map(({ id, title, active }) => ({ id, title, active }))),
  ]);
  const seen = filterByDeskDepartment(
    templates.filter((t) => maySeeDept(g.access, t.desk_department_id)),
    parseDeskDepartmentFilter(new URL(req.url).searchParams.get("desk_department"))
  ).map((t) => ({ ...t, desk_department_id: t.desk_department_id ?? null, can_edit: mayManageDept(g.access, t.desk_department_id) }));
  return NextResponse.json({ templates: seen, teams, request_types: types });
}

async function postHandler(req: Request) {
  const g = await deskDepartmentGate("checklists");
  if (g instanceof NextResponse) return g;
  const gate = g.user;
  const b = await readJson(req, 64 * 1024);
  if (!b) return NextResponse.json({ error: "Send the checklist as JSON." }, { status: 400 });
  try {
    if (b.draft === true) {
      const id = b.id === undefined || b.id === null ? undefined : typeof b.id === "number" && Number.isInteger(b.id) && b.id > 0 ? b.id : null;
      if (id === null) return NextResponse.json({ error: "No such checklist." }, { status: 404 });
      // Review fix: a draft "from Claude" needs the Claude card it came from, offered to this person, with exactly this checklist.
      const shape = checkTemplateInput(b);
      if (!shape.ok) return NextResponse.json({ error: shape.error }, { status: 400 });
      if (id !== undefined || !(await offeredChecklistCard(gate.id, b.card_id, { action: "draft", draft: shape.value }))) {
        return NextResponse.json({ error: "Save as draft works from the Claude card it came from. Create a checklist with New checklist instead." }, { status: 400 });
      }
      // 1.20.23: a new draft goes into the caller's starting desk department (never All departments).
      const dept = await deskDepartmentFieldOr(g.access, undefined);
      if (dept instanceof NextResponse) return dept;
      const r = await saveTemplateDraft(b, { id: gate.id, name: gate.name || gate.username, via: "claude_desk" }, id, dept.value);
      const d = r.template.draft ?? r.template;
      const counts = { items: d.items.length, required: d.items.filter((i) => i.required).length, request_type_ids: d.request_type_ids, draft: true, via: "claude_desk", via_label: "via Claude in the desk" };
      if (r.kind === "new") {
        await audit({ actor: actorFrom(gate), action: "helpdesk.checklist_template.created", targetType: "helpdesk_checklist", targetId: r.template.id, targetLabel: r.template.name, details: { ...counts, published: false }, ip: ipFrom(req) });
      } else {
        await audit({ actor: actorFrom(gate), action: "helpdesk.checklist_template.updated", targetType: "helpdesk_checklist", targetId: r.template.id, targetLabel: r.template.name, details: { changed: ["draft"], ...counts, published: r.template.published }, ip: ipFrom(req) });
      }
      return NextResponse.json({ template: r.template }, { status: r.kind === "new" ? 201 : 200 });
    }
    const dept = await deskDepartmentFieldOr(g.access, b.desk_department_id);
    if (dept instanceof NextResponse) return dept;
    const t = await createTemplate(b, { id: gate.id, name: gate.name || gate.username }, dept.value);
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.checklist_template.created",
      targetType: "helpdesk_checklist",
      targetId: t.id,
      targetLabel: t.name,
      details: { items: t.items.length, required: t.items.filter((i) => i.required).length, request_type_ids: t.request_type_ids, desk_department_id: t.desk_department_id ?? null },
      ip: ipFrom(req),
    });
    return NextResponse.json({ template: t }, { status: 201 });
  } catch (e) {
    if (e instanceof ChecklistError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

// 1.20.23 review L3: a save racing a desk department's deletion answers 409 with a sentence.
export const POST = guardDeptRace(postHandler);
