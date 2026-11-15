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

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { AutomationDraftError, deleteAutomation, discardAutomationDraft, getAutomation, updateAutomation, validateAutomationInput } from "@/lib/helpdesk/automations";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function idOf(ctx: Ctx): Promise<number | null> {
  const n = Number((await ctx.params).id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(_req: Request, ctx: Ctx) {
  const gate = await hdCapGate("automations.manage");
  if (gate instanceof NextResponse) return gate;
  const id = await idOf(ctx);
  const automation = id ? await getAutomation(id) : undefined;
  if (!automation) return NextResponse.json({ error: "Automation not found." }, { status: 404 });
  return NextResponse.json({ automation });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await hdCapGate("automations.manage");
  if (gate instanceof NextResponse) return gate;
  const id = await idOf(ctx);
  if (!id) return NextResponse.json({ error: "Automation not found." }, { status: 404 });
  const body = await readJson(req, 64 * 1024);
  if (!body) return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });
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
    const input = await validateAutomationInput(body, true);
    if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
    const r = await updateAutomation(id, input.value, { publish: body.publish === true, publishDraft: body.publish_draft === true, draftAt: body.draft_at });
    if (!r) return NextResponse.json({ error: "Automation not found." }, { status: 404 });
    const automation = r.after;
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
  const gate = await hdCapGate("automations.manage");
  if (gate instanceof NextResponse) return gate;
  const id = await idOf(ctx);
  const gone = id ? await deleteAutomation(id) : undefined;
  if (!gone) return NextResponse.json({ error: "Automation not found." }, { status: 404 });
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
