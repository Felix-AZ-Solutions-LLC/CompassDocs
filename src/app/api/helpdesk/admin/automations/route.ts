// GET  /api/helpdesk/admin/automations   every automation, in run order, with the event labels
//      (1.20.16, additive: in_words / draft_in_words, people (desk agents), macros (names))
// POST /api/helpdesk/admin/automations   { name, event, conditions?, actions, active?, position? }
// Helpdesk 1.19.0 (automations.manage, agent J's capability). Audited as helpdesk.automation.created.
// 1.20.16: POST { draft: true, card_id } is "Save as draft" on a Claude in the desk automation card:
//      the card's rule (this person's offered card; 400 otherwise) is saved as a draft
//      (lib/helpdesk/automations saveAutomationDraft): a new rule switched off and unpublished, or
//      changes beside the rule the card names. Checked as Desk settings checks a rule. Audited
//      helpdesk.automation.created / .updated with draft and via "claude_desk"; the card is used once.
// 1.20.23 (lib/helpdesk/desk-departments): a rule is in one desk department (desk_department_id;
//      null = All departments, desk Admin only; left out, the caller's starting department) and
//      runs on that department's tickets. The list shows the caller's departments' rules and All
//      departments' (?desk_department=<id>|all filters), each with can_edit; "Manage a desk
//      department" opens it for their own teams' departments (review M3). A rule's macro must be of its department or
//      All departments (400). A card's new draft goes into the caller's starting department.
// 1.20.33 (additive): GET also lists `fields` (the custom fields a rule can copy into: key, label, kind, options, teams;
//      archived ones marked) and `requesters` (the names of the people rules make the requester). A rule's "Copy a value
//      into a field" must name a field of a team in its desk department, or of all teams (400, code desk_department).

import { NextResponse } from "next/server";
import type { SessionUser } from "@/lib/types";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import {
  automationFieldsRefusal,
  automationMacroRefusal,
  deskDepartmentFieldOr,
  deskDepartmentGate,
  filterByDeskDepartment,
  guardDeptRace,
  itemRefusal,
  mayManageDept,
  maySeeDept,
  parseDeskDepartmentFilter,
  type DeskDepartmentAccess,
} from "@/lib/helpdesk/desk-departments";
import { auditDraftCardApplied, claimDraftCard, releaseDraftCard } from "@/lib/helpdesk/claude/draft-cards";
import { draftViaDetails } from "@/lib/helpdesk/claude-drafts-shared";
import {
  AutomationDraftError,
  AutomationLimitError,
  saveAutomationDraft,
  HD_AUTOMATION_EVENT_LABEL,
  createAutomation,
  getAutomation,
  listAutomations,
  validateAutomationInput,
  automationsInWords,
  type AutomationInput,
} from "@/lib/helpdesk/automations";
import { listDeskAgents } from "@/lib/helpdesk/roles-agents";
import { hq } from "@/lib/helpdesk/db-core";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await deskDepartmentGate("automations");
  if (g instanceof NextResponse) return g;
  // 1.20.16 (additive): each rule in plain words (and its draft's), the desk agents a rule can assign
  // or notify, and the names of the macros rules send, so a reviewer sees every action.
  const automations = filterByDeskDepartment(
    (await listAutomations()).filter((a) => maySeeDept(g.access, a.desk_department_id)),
    parseDeskDepartmentFilter(new URL(req.url).searchParams.get("desk_department"))
  );
  const shapes = automations.flatMap((a) => (a.draft ? [a, a.draft] : [a]));
  const words = await automationsInWords(shapes);
  let k = 0;
  const withWords = automations.map((a) => ({
    ...a,
    desk_department_id: a.desk_department_id ?? null,
    can_edit: mayManageDept(g.access, a.desk_department_id),
    in_words: words[k++],
    draft_in_words: a.draft ? words[k++] : null,
  }));
  const macroIds = [...new Set(shapes.map((a) => a.actions?.macro_id).filter((x): x is number => !!x))];
  // 1.20.33: the people rules make the requester (by name, even one who is no desk agent), and the fields rules can copy into.
  const requesterIds = [...new Set(shapes.map((a) => a.actions?.requester_set?.user_id).filter((x): x is number => !!x))];
  const { listCustomFields } = await import("@/lib/helpdesk/custom-fields");
  const [agents, macros, requesters, fields] = await Promise.all([
    listDeskAgents(),
    macroIds.length ? hq<{ id: number; title: string; owner_id: number | null }>("SELECT id, title, owner_id FROM hd_macros WHERE id = ANY($1::int[])", [macroIds]) : [],
    requesterIds.length ? hq<{ id: number; name: string }>("SELECT id, COALESCE(NULLIF(name, ''), username) AS name FROM users WHERE id = ANY($1::int[]) AND status = 'active'", [requesterIds]) : [],
    listCustomFields(),
  ]);
  return NextResponse.json({
    automations: withWords,
    events: HD_AUTOMATION_EVENT_LABEL,
    people: agents.filter((a) => a.role !== null).map((a) => ({ id: a.user_id, name: a.name || a.username })),
    macros: macros.map((m) => ({ id: m.id, title: m.title, shared: m.owner_id === null })),
    requesters,
    fields: fields.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options, all_teams: f.all_teams, team_ids: f.team_ids, archived: f.archived })),
  });
}

async function postHandler(req: Request) {
  const g = await deskDepartmentGate("automations");
  if (g instanceof NextResponse) return g;
  const gate = g.user;
  const body = await readJson(req, 64 * 1024);
  if (!body) return NextResponse.json({ error: "Send the automation as JSON." }, { status: 400 });
  if (body.draft === true) return saveDraftFromCard(req, gate, g.access, body.card_id);
  const dept = await deskDepartmentFieldOr(g.access, body.desk_department_id);
  if (dept instanceof NextResponse) return dept;
  const input = await validateAutomationInput(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  const mismatch = (await automationMacroRefusal(dept.value, input.value.actions?.macro_id)) ?? (await automationFieldsRefusal(dept.value, input.value.actions?.copy_values));
  if (mismatch) return NextResponse.json({ error: mismatch, code: "desk_department" }, { status: 400 });
  let automation;
  try {
    automation = await createAutomation(input.value as AutomationInput, dept.value);
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
    details: {
      event: automation.event,
      conditions: automation.conditions,
      actions: Object.keys(automation.actions),
      active: automation.active,
      desk_department_id: automation.desk_department_id ?? null,
    },
    ip: ipFrom(req),
  });
  return NextResponse.json({ automation }, { status: 201 });
}

/** 1.20.16: Save as draft on a Claude in the desk card. 1.20.23: only on a rule they manage; a new one in their starting desk department. */
async function saveDraftFromCard(req: Request, gate: SessionUser, access: DeskDepartmentAccess, cardId: unknown) {
  const card = await claimDraftCard(gate.id, cardId, "automation");
  if (!card) return NextResponse.json({ error: "Save as draft works from the Claude card it came from. Create a rule with New rule instead." }, { status: 400 });
  let dept: number | null | undefined;
  if (card.target_id) {
    const target = await getAutomation(card.target_id);
    const refused = target ? itemRefusal(access, target.desk_department_id, "Automation not found.") : null;
    if (refused) {
      await releaseDraftCard(gate.id, card.id);
      return refused;
    }
  } else {
    const d = await deskDepartmentFieldOr(access, undefined);
    if (d instanceof NextResponse) {
      await releaseDraftCard(gate.id, card.id);
      return d;
    }
    dept = d.value;
  }
  try {
    const r = await saveAutomationDraft(card.draft, { id: gate.id, name: gate.name || gate.username, via: "claude_desk" }, card.target_id ?? undefined, dept);
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

// 1.20.23 review L3: a save racing a desk department's deletion answers 409 with a sentence.
export const POST = guardDeptRace(postHandler);
