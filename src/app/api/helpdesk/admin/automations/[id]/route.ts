// GET    /api/helpdesk/admin/automations/[id]
// PATCH  /api/helpdesk/admin/automations/[id]   any of { name, event, conditions, actions, active, position }
// DELETE /api/helpdesk/admin/automations/[id]
// Helpdesk 1.19.0 (automations.manage, agent J's capability). Audited as helpdesk.automation.updated / .deleted.
// 1.20.16, drafts from Claude (lib/helpdesk/automations; the rules of 1.20.14's checklist review):
//        PATCH { …, publish: true, draft_at } publishes a new rule Claude drafted and switches it on
//        (active 0 in the same body keeps it off); PATCH { …, publish_draft: true, draft_at } applies
//        the changes waiting on a published rule (fields not sent come from that draft; on/off kept).
//        Both audited helpdesk.automation.published; 409 when draft_at isn't the current draft's.
//        A plain PATCH edits the live rule (or the unpublished draft) and keeps a pending draft; an
//        unpublished draft can't be switched on (409). PATCH { discard_draft: true, draft_at? } drops the
//        changes waiting on a published rule (helpdesk.automation.draft_discarded; 409 when there are
//        none or a newer one). An unpublished draft is discarded with DELETE.
//        Review fixes: a publish must send name, event, conditions and actions (400 otherwise);
//        publish_draft over a rule edited after the draft was made is refused (409).

// 1.20.23 (lib/helpdesk/desk-departments): only a rule of a desk department the caller manages
//        (another department's is a 404, an All departments one a 403 unless desk Admin; GET reads
//        any they see, with can_edit). desk_department_id moves it (to one they manage; null = All
//        departments, Admin only), audited helpdesk.desk_department.item_moved; its macro must then
//        be of the same department or All departments (400). From then on it runs on the new
//        department's tickets.
//        Review M3/M4: managing means a department of the caller's own teams. The macro check runs
//        only when the macro or the department changes (so { active: 0 } always works); a macro
//        that later stops fitting is skipped when the rule runs, with a note on the ticket.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { AutomationDraftError, deleteAutomation, discardAutomationDraft, getAutomation, updateAutomation, validateAutomationInput } from "@/lib/helpdesk/automations";
import {
  automationMacroRefusal,
  deskDepartmentFieldOr,
  deskDepartmentGate,
  guardDeptRace,
  itemRefusal,
  mayManageDept,
  maySeeDept,
  auditItemDeskDepartment,
} from "@/lib/helpdesk/desk-departments";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function idOf(ctx: Ctx): Promise<number | null> {
  const n = Number((await ctx.params).id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const NOT_FOUND = "Automation not found.";

export async function GET(_req: Request, ctx: Ctx) {
  const g = await deskDepartmentGate("automations");
  if (g instanceof NextResponse) return g;
  const id = await idOf(ctx);
  const automation = id ? await getAutomation(id) : undefined;
  if (!automation || !maySeeDept(g.access, automation.desk_department_id)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  return NextResponse.json({ automation: { ...automation, can_edit: mayManageDept(g.access, automation.desk_department_id) } });
}

async function patchHandler(req: Request, ctx: Ctx) {
  const g = await deskDepartmentGate("automations");
  if (g instanceof NextResponse) return g;
  const gate = g.user;
  const id = await idOf(ctx);
  if (!id) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  const cur = await getAutomation(id);
  if (!cur) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  const refused = itemRefusal(g.access, cur.desk_department_id, NOT_FOUND);
  if (refused) return refused;
  const body = await readJson(req, 64 * 1024);
  if (!body) return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });
  const dept = await deskDepartmentFieldOr(g.access, body.desk_department_id, cur.desk_department_id ?? null);
  if (dept instanceof NextResponse) return dept;
  try {
    if (body.discard_draft === true) {
      const gone = await discardAutomationDraft(id, body.draft_at);
      if (!gone) {
        return (await getAutomation(id))
          ? NextResponse.json({ error: "There are no changes waiting on this rule." }, { status: 409 })
          : NextResponse.json({ error: "Automation not found." }, { status: 404 });
      }
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.automation.draft_discarded",
        targetType: "helpdesk_automation",
        targetId: id,
        targetLabel: gone.name,
        details: { drafted_by: gone.draft_by_name, drafted_via: gone.draft_via },
        ip: ipFrom(req),
      });
      return NextResponse.json({ automation: await getAutomation(id) });
    }
    // 1.20.16 review fix: a publish sends the whole rule as the person reviewed it (every trigger,
    // condition and action the dialog shows), so nothing goes live that the form didn't show.
    if ((body.publish === true || body.publish_draft === true) && !["name", "event", "conditions", "actions"].every((k) => body[k] !== undefined && body[k] !== null)) {
      return NextResponse.json({ error: "Publish sends the rule as you reviewed it: its name, when, if and then." }, { status: 400 });
    }
    const { desk_department_id: _dept, ...fields } = body;
    const input = await validateAutomationInput(fields, true);
    if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
    const macroId = input.value.actions !== undefined ? input.value.actions.macro_id : body.publish_draft === true ? cur.draft?.actions?.macro_id : cur.actions?.macro_id;
    // Review M4 (b): checked only when the macro or the department changes, so switching a rule off
    // (or renaming it) always works, whatever moved meanwhile.
    const moved = (dept.value ?? null) !== (cur.desk_department_id ?? null);
    if (moved || (macroId ?? null) !== (cur.actions?.macro_id ?? null)) {
      const mismatch = await automationMacroRefusal(dept.value, macroId);
      if (mismatch) return NextResponse.json({ error: mismatch, code: "desk_department" }, { status: 400 });
    }
    const r = await updateAutomation(id, input.value, { publish: body.publish === true, publishDraft: body.publish_draft === true, draftAt: body.draft_at, dept: dept.value });
    if (!r) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    await auditItemDeskDepartment(gate, "automations", { id, label: r.after.name }, cur.desk_department_id ?? null, dept.value, ipFrom(req));
    const automation = { ...r.after, desk_department_id: dept.value };
    if (r.published) {
      // 1.20.16: a Claude draft made live, only on an explicit publish.
      const changed = (["name", "event", "conditions", "actions", "active"] as const).filter((k) => JSON.stringify(r.before[k]) !== JSON.stringify(r.after[k]));
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.automation.published",
        targetType: "helpdesk_automation",
        targetId: id,
        targetLabel: automation.name,
        details: { changed, active: automation.active, event: automation.event, drafted_by: r.before.draft_by_name, drafted_via: r.before.draft_via },
        ip: ipFrom(req),
      });
    } else {
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.automation.updated",
        targetType: "helpdesk_automation",
        targetId: id,
        targetLabel: automation.name,
        details: { changed: Object.keys(input.value), active: automation.active, event: automation.event, ...(automation.published ? {} : { draft: true, published: false }) },
        ip: ipFrom(req),
      });
    }
    return NextResponse.json({ automation });
  } catch (e) {
    if (e instanceof AutomationDraftError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const g = await deskDepartmentGate("automations");
  if (g instanceof NextResponse) return g;
  const gate = g.user;
  const id = await idOf(ctx);
  const cur = id ? await getAutomation(id) : undefined;
  if (!cur) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  const refused = itemRefusal(g.access, cur.desk_department_id, NOT_FOUND);
  if (refused) return refused;
  const gone = await deleteAutomation(cur.id);
  if (!gone) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.automation.deleted",
    targetType: "helpdesk_automation",
    targetId: gone.id,
    targetLabel: gone.name,
    details: { event: gone.event, ...(gone.published ? {} : { draft: true, published: false }) },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

// 1.20.23 review L3: a save racing a desk department's deletion answers 409 with a sentence.
export const PATCH = guardDeptRace(patchHandler);
