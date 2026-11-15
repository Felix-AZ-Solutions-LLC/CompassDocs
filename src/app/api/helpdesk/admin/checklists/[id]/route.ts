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

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import { notFound } from "@/lib/helpdesk/routes";
import { ChecklistError, deleteTemplate, discardTemplateDraft, getTemplate, updateTemplate } from "@/lib/helpdesk/checklists";
import { CHECKLIST_MANAGE_CAPS } from "@/lib/helpdesk/checklists-caps";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const idOf = (raw: string) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function PUT(req: Request, { params }: Ctx) {
  const gate = await hdAnyCapGate([...CHECKLIST_MANAGE_CAPS]);
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  if (!id) return notFound();
  const b = await readJson(req, 64 * 1024);
  if (!b) return NextResponse.json({ error: "Send the checklist as JSON." }, { status: 400 });
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
    const r = await updateTemplate(id, b, { publish: b.publish === true, publishDraft: b.publish_draft === true, draftAt: b.draft_at });
    if (!r) return notFound();
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
  const gate = await hdAnyCapGate([...CHECKLIST_MANAGE_CAPS]);
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await params).id);
  if (!id) return notFound();
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
