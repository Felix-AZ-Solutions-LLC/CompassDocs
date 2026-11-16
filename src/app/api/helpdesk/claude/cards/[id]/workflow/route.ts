// POST /api/helpdesk/claude/cards/[id]/workflow   { op: "review" | "release" | "dismiss", claim? }
//
// Helpdesk 1.20.22, Claude in the desk: what the agent does with one of their
// workflow suggestion cards (suggest_workflow; lib/helpdesk/claude/workflow-cards).
// Nothing here starts anything: the start is the agent's own submit of the
// Start a workflow dialog through POST /api/helpdesk/tickets/[number]/start-workflow
// (unchanged, with `claude_card: { id, claim }`), which records the outcome.
//
//   review    Review and start: claims the card (one review at a time; a
//             claim lapses after 10 minutes) and checks the suggestion still
//             holds → 200 { claim, card, request_type_id, answers } (Claude's
//             answers checked again against the form as it is now). Another
//             tab holds it, or it was used → 409 { code: "claude_card_taken" };
//             it no longer holds (the requester changed, the ticket became a
//             request, or the workflow already runs) → 409 { code:
//             "claude_card_stale", card }, and the card says why from then on;
//             it can't start right now (the ticket solved, the requester's Get
//             help access off, the type not offered here now) → 409 { code:
//             "claude_card_not_now", card }, the claim given back and the card
//             still usable. The agent must work the
//             ticket (404 otherwise) and hold workflows.start in its team (403).
//   release   the dialog closed without starting: the card is offered again
//             (only with the review's claim) → 200 { card }; 404 otherwise.
//   dismiss   Dismiss: an offered card, or the one this review holds → 200
//             { card }; 404 otherwise. Not audited (the start is).
// Only the agent's own cards, never one of another kind (404).

import { NextResponse } from "next/server";
import { hdRateLimited, helpdeskGate, readJson, tooMany } from "@/lib/helpdesk/access";
import { badRequest } from "@/lib/helpdesk/routes";
import { dismissWorkflowCard, releaseWorkflowCard, reviewWorkflowCard } from "@/lib/helpdesk/claude/workflow-cards";

export const dynamic = "force-dynamic";

const NOT_FOUND = () => NextResponse.json({ error: "No such card, or it was already decided." }, { status: 404 });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0 || id >= 2 ** 31) return NOT_FOUND();
  if (hdRateLimited(`hd-claude-wfcard:${gate.id}`, 60, 60_000)) return tooMany();
  const b = await readJson(req, 1024);
  const op = b?.op;
  const claim = typeof b?.claim === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(b.claim) ? (b.claim as string) : null;
  if (op === "review") {
    const r = await reviewWorkflowCard(gate, id);
    if (!r.ok) return NextResponse.json({ error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.card ? { card: r.card } : {}) }, { status: r.status });
    return NextResponse.json({ claim: r.claim, card: r.card, request_type_id: r.request_type_id, answers: r.answers });
  }
  if (op === "release") {
    if (!claim) return badRequest("Send the review's claim.");
    const card = await releaseWorkflowCard(gate.id, id, claim);
    return card ? NextResponse.json({ card }) : NOT_FOUND();
  }
  if (op === "dismiss") {
    const card = await dismissWorkflowCard(gate.id, id, claim);
    return card ? NextResponse.json({ card }) : NOT_FOUND();
  }
  return badRequest('Send { "op": "review" | "release" | "dismiss" }.');
}
