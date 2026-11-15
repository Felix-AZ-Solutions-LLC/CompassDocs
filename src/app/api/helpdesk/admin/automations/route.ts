// GET  /api/helpdesk/admin/automations   every automation, in run order, with the event labels
// POST /api/helpdesk/admin/automations   { name, event, conditions?, actions, active?, position? }
// Helpdesk 1.19.0 (automations.manage, agent J's capability). Audited as helpdesk.automation.created.
// 1.20.16: POST { draft: true, card_id } is "Save as draft" on a Claude in the desk automation card:
//      the card's rule (this person's offered card; 400 otherwise) is saved as a draft
//      (lib/helpdesk/automations saveAutomationDraft): a new rule switched off and unpublished, or
//      changes beside the rule the card names. Checked as Desk settings checks a rule. Audited
//      helpdesk.automation.created / .updated with draft and via "claude_desk"; the card is used once.

import { NextResponse } from "next/server";
import type { SessionUser } from "@/lib/types";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { auditDraftCardApplied, claimDraftCard, releaseDraftCard } from "@/lib/helpdesk/claude/draft-cards";
import { draftViaDetails } from "@/lib/helpdesk/claude-drafts-shared";
import {
  AutomationDraftError,
  AutomationLimitError,
  saveAutomationDraft,
  HD_AUTOMATION_EVENT_LABEL,
  createAutomation,
  listAutomations,
  validateAutomationInput,
  type AutomationInput,
} from "@/lib/helpdesk/automations";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("automations.manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ automations: await listAutomations(), events: HD_AUTOMATION_EVENT_LABEL });
}

export async function POST(req: Request) {
  const gate = await hdCapGate("automations.manage");
  if (gate instanceof NextResponse) return gate;
  const body = await readJson(req, 64 * 1024);
  if (!body) return NextResponse.json({ error: "Send the automation as JSON." }, { status: 400 });
  if (body.draft === true) return saveDraftFromCard(req, gate, body.card_id);
  const input = await validateAutomationInput(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  let automation;
  try {
    automation = await createAutomation(input.value as AutomationInput);
  } catch (e) {
    if (e instanceof AutomationLimitError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.automation.created",
    targetType: "helpdesk_automation",
    targetId: automation.id,
    targetLabel: automation.name,
    details: { event: automation.event, conditions: automation.conditions, actions: Object.keys(automation.actions), active: automation.active },
    ip: ipFrom(req),
  });
  return NextResponse.json({ automation }, { status: 201 });
}

/** 1.20.16: Save as draft on a Claude in the desk card. */
async function saveDraftFromCard(req: Request, gate: SessionUser, cardId: unknown) {
  const card = await claimDraftCard(gate.id, cardId, "automation");
  if (!card) return NextResponse.json({ error: "Save as draft works from the Claude card it came from. Create a rule with New rule instead." }, { status: 400 });
  try {
    const r = await saveAutomationDraft(card.draft, { id: gate.id, name: gate.name || gate.username, via: "claude_desk" }, card.target_id ?? undefined);
    const a = r.automation;
    const shape = a.draft ?? a;
    const details = { event: shape.event, conditions: shape.conditions, actions: Object.keys(shape.actions ?? {}), draft: true, ...draftViaDetails("claude_desk"), card_id: card.id };
    if (r.kind === "new") {
      await audit({ actor: actorFrom(gate), action: "helpdesk.automation.created", targetType: "helpdesk_automation", targetId: a.id, targetLabel: a.name, details: { ...details, active: 0, published: false }, ip: ipFrom(req) });
    } else {
      await audit({ actor: actorFrom(gate), action: "helpdesk.automation.updated", targetType: "helpdesk_automation", targetId: a.id, targetLabel: a.name, details: { changed: ["draft"], ...details, published: a.published }, ip: ipFrom(req) });
    }
    await auditDraftCardApplied(gate, card, ipFrom(req));
    return NextResponse.json({ automation: a }, { status: r.kind === "new" ? 201 : 200 });
  } catch (e) {
    await releaseDraftCard(gate.id, card.id);
    if (e instanceof AutomationDraftError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
