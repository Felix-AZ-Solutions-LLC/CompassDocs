// POST /api/helpdesk/tickets/[number]/macro/[macroId]   { preview?: boolean, expect_last_message_id?, force?, solve_answers?, via? }
// (1.20.5: a macro that solves a ticket a "Before you solve" requirement set matches is refused whole, 409 with the
// sentence, unless what the set asks for is there; solve_answers carries the closing fields, as on PATCH.)
// (1.19.1: a reply-sending macro takes the messages route's send guard: a
// newer message by someone else answers 409 { newer } unless force.)
// Helpdesk 1.19.0 (macros.use in the ticket's team, agent J's capability,
// and the caller must work the ticket).
// preview: the macro's reply filled for this ticket and the field changes
// it would make, nothing written (the composer inserts it for editing).
// Otherwise the reply is posted as the agent and the changes are made,
// checked first as the reply and PATCH routes check them: the reply needs
// reply_public or reply_needs_review (a Newbie's is held for review, and
// its status change waits with it), each field change its own capability
// (lib/helpdesk/patch-caps), and solving a workflow task its required
// hand-off (409 with `missing`, as PATCH answers). A refusal writes nothing.
// 1.20.15: the checks and the apply are lib/helpdesk/macros applyMacroAs, which Claude's
// tools share (same order, same answers). `card_id` from Apply on a Claude in the desk
// card (a bare `via` is ignored, as 1.20.14's checklist routes): the card is claimed first,
// in one statement (this agent's, still offered, this ticket and macro), so it applies once;
// otherwise 409 "This suggestion was already used." and nothing is written. The apply must
// then match the plan the card showed (the macro's version, the filled reply, the field
// changes), else 409 and nothing is written; a refusal offers the card again. It is marked
// "via Claude in the desk" on the timeline and audited (helpdesk.macro.applied).
// Without card_id it is the agent's own apply, exactly as before.

import { NextResponse } from "next/server";
import { ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { applyMacroAs } from "@/lib/helpdesk/macros";
import { claimMacroCard, releaseMacroCard } from "@/lib/helpdesk/claude/chats";
import { HdTicketError } from "@/lib/helpdesk/tickets";
import { requestOrigin } from "@/lib/oauth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string; macroId: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const gate = await hdCapGate("macros.use");
  if (gate instanceof NextResponse) return gate;
  const p = await ctx.params;
  const number = Number(String(p.number).replace(/^#/, ""));
  const macroId = Number(p.macroId);
  if (!Number.isInteger(number) || number <= 0 || !Number.isInteger(macroId) || macroId <= 0) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const body = (await readJson<Record<string, unknown>>(req, 4 * 1024)) ?? {};
  let card: Awaited<ReturnType<typeof claimMacroCard>>;
  if (body.preview !== true && body.card_id !== undefined && body.card_id !== null) {
    card = await claimMacroCard(gate.id, body.card_id, { number, macroId });
    if (!card) return NextResponse.json({ error: "This suggestion was already used." }, { status: 409 });
  }
  let r;
  try {
    r = await applyMacroAs(gate, number, macroId, {
      preview: body.preview === true,
      origin: requestOrigin(req),
      // 1.20.5: closing answers for a macro that solves ("Before you solve", lib/helpdesk/solve-requirements).
      solveAnswers: body.solve_answers,
      guard: body,
      ...(card ? { via: "claude_desk" as const, ip: ipFrom(req), expect: card.payload.plan ?? null, cardId: card.id } : {}),
    });
  } catch (e) {
    // Something may already be written (a reply before a failed field change): the card stays used.
    if (e instanceof HdTicketError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  if (!r.ok) {
    if (card) await releaseMacroCard(gate.id, card.id);
    return NextResponse.json({ error: r.error, ...(r.missing ? { missing: r.missing } : {}), ...(r.newer ? { newer: r.newer } : {}) }, { status: r.status });
  }
  return NextResponse.json(r.result);
}
