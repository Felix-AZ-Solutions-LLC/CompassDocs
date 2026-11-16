// GET  /api/helpdesk/admin/recurring   the schedules the caller manages, the teams they may schedule for
//                                       (with each team calendar's zone), the request types, can_manage_all.
// POST /api/helpdesk/admin/recurring   create a schedule → { schedule }. Audited helpdesk.recurring.created.
// Helpdesk 1.19.1 (agent V8). settings.manage (every team) or agents.manage_team (a lead, their teams).
// 1.20.16: POST { draft: true, card_id } is "Save as draft" on a Claude in the desk recurring card:
//      the card's schedule (this person's offered card; 400 otherwise) is saved as a draft
//      (lib/helpdesk/recurring saveRecurringDraft): a new schedule paused and unpublished, or changes
//      beside the schedule the card names. Checked as Desk settings checks a schedule, and only for
//      teams the person manages (403). Audited helpdesk.recurring.created / .updated with draft and
//      via "claude_desk"; the card is used once.

import { NextResponse } from "next/server";
import { ipFrom } from "@/lib/audit";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import { hq } from "@/lib/helpdesk/db-core";
import { deskDepartmentScope, requestTypeOptions } from "@/lib/helpdesk/desk-departments";
import { auditDraftCardApplied, claimDraftCard, releaseDraftCard } from "@/lib/helpdesk/claude/draft-cards";
import { draftViaDetails } from "@/lib/helpdesk/claude-drafts-shared";
import type { SessionUser } from "@/lib/types";
import {
  RecurringDraftError,
  checkRecurringDraft,
  draftOfSchedule,
  getRecurring,
  saveRecurringDraft,
  auditRecurring,
  canManageAllRecurring,
  canManageRecurringTeam,
  createRecurring,
  listRecurring,
  RECURRING_GATE_CAPS,
  recurringTeams,
  validateRecurringInput,
} from "@/lib/helpdesk/recurring";
import { RECURRING_LIMITS, scheduleTitle } from "@/lib/helpdesk/recurring-shared";

export const dynamic = "force-dynamic";

// 1.20.23: "Manage a desk department" too, for the teams in the desk departments of their own teams
// (review M3: membership; recurring canManageRecurringTeam). A schedule's request type is one its
// team's department sees (review L2: validateRecurringInput).
const GATE = RECURRING_GATE_CAPS;

export async function GET() {
  const gate = await hdAnyCapGate([...GATE]);
  if (gate instanceof NextResponse) return gate;
  const [all, teams] = await Promise.all([canManageAllRecurring(gate), recurringTeams(gate)]);
  const [schedules, requestTypes] = await Promise.all([
    listRecurring(all ? "all" : teams.map((t) => t.id)),
    // Review L1/L2: the request types of the caller's desk departments and All departments', each with
    // its department so the form offers a schedule's team only those its department sees.
    deskDepartmentScope(gate).then(requestTypeOptions).then((l) => l.map(({ id, title, team_id, desk_department_id }) => ({ id, title, team_id, desk_department_id }))),
  ]);
  return NextResponse.json({ schedules, teams, request_types: requestTypes, can_manage_all: all });
}

export async function POST(req: Request) {
  const gate = await hdAnyCapGate([...GATE]);
  if (gate instanceof NextResponse) return gate;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Send the schedule as JSON." }, { status: 400 });
  if (body.draft === true) return saveDraftFromCard(req, gate, body.card_id);
  if (typeof body.team_id === "number" && !(await canManageRecurringTeam(gate, body.team_id))) {
    return NextResponse.json({ error: "You can only schedule tickets for teams you lead." }, { status: 403 });
  }
  const v = await validateRecurringInput(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const count = await hq<{ n: number }>("SELECT count(*)::int AS n FROM hd_recurring WHERE team_id = $1", [v.value.team_id]);
  if ((count[0]?.n ?? 0) >= RECURRING_LIMITS.perTeam) {
    return NextResponse.json({ error: `A team can have at most ${RECURRING_LIMITS.perTeam} recurring tickets.` }, { status: 400 });
  }
  const schedule = await createRecurring(v.value, gate.id);
  await auditRecurring(req, gate, "helpdesk.recurring.created", schedule.id, scheduleTitle(schedule.subject), {
    team_id: schedule.team_id,
    pattern: schedule.pattern,
  });
  return NextResponse.json({ schedule }, { status: 201 });
}

/** 1.20.16: Save as draft on a Claude in the desk card. */
async function saveDraftFromCard(req: Request, gate: SessionUser, cardId: unknown) {
  const card = await claimDraftCard(gate.id, cardId, "recurring");
  if (!card) return NextResponse.json({ error: "Save as draft works from the Claude card it came from. Create one with New schedule instead." }, { status: 400 });
  try {
    const live = card.target_id ? await getRecurring(card.target_id) : undefined;
    if (card.target_id && (!live || !(await canManageRecurringTeam(gate, live.team_id)))) throw new RecurringDraftError("Not found.", 404);
    const draft = await checkRecurringDraft(card.draft, live ? live.draft ?? draftOfSchedule(live) : undefined);
    if (!(await canManageRecurringTeam(gate, draft.team_id))) throw new RecurringDraftError("You can only schedule tickets for teams you lead.", 403);
    const r = await saveRecurringDraft(draft, { id: gate.id, name: gate.name || gate.username, via: "claude_desk" }, card.target_id ?? undefined);
    const details = { team_id: draft.team_id, pattern: draft.pattern, draft: true, ...draftViaDetails("claude_desk"), card_id: card.id };
    if (r.kind === "new") await auditRecurring(req, gate, "helpdesk.recurring.created", r.schedule.id, scheduleTitle(draft.subject), { ...details, enabled: false, published: false });
    else await auditRecurring(req, gate, "helpdesk.recurring.updated", r.schedule.id, scheduleTitle(r.schedule.subject), { changed: ["draft"], ...details, published: r.schedule.published });
    await auditDraftCardApplied(gate, card, ipFrom(req));
    return NextResponse.json({ schedule: r.schedule }, { status: r.kind === "new" ? 201 : 200 });
  } catch (e) {
    await releaseDraftCard(gate.id, card.id);
    if (e instanceof RecurringDraftError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
