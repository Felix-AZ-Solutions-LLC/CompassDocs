// POST /api/helpdesk/tickets/[number]/requester   { user_id } | { email, name? }, keep_cc?
//        "Change requester" on the ticket's requester strip (1.20.33): make someone else the
//        requester, say to put right a requester an automation set wrongly. Any agent who works
//        the ticket, as for its other field edits (category, tags, custom fields). The person is
//        an account that can use Get help, or an address (an account's, else someone outside the
//        workspace while Desk settings → Email accepts outside senders). keep_cc keeps the
//        previous requester as a CC; otherwise they are dropped. One agents-only activity line,
//        audited helpdesk.ticket.requester_changed, the ticket.updated webhook and the
//        ticket_updated rules (lib/helpdesk/requester-change changeRequester, the primitive
//        automations use too). A ticket with no requester gets one the same way. From then on no
//        automation changes the ticket's requester (requester_set_by_agent_at). Closed tickets and
//        tickets on legal hold change like any other field edit.
//   → 200 { ticket, changed } (changed false: they already were the requester).
//   400 with a sentence when the person can't be a requester; 409 on a merged ticket.
// Helpdesk 1.20.33 (helpdesk.agent).

import { NextResponse } from "next/server";
import { ipFrom } from "@/lib/audit";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { badRequest, loadTicketFor, notFound, originOf } from "@/lib/helpdesk/routes";
import { getTicketById } from "@/lib/helpdesk/tickets";
import { RequesterChangeError, changeRequester } from "@/lib/helpdesk/requester-change";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ number: string }> }) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  const b = await readJson(req, 8 * 1024);
  if (!b) return badRequest("Send the new requester as JSON.");
  const userId = b.user_id === undefined || b.user_id === null || b.user_id === "" ? null : Number(b.user_id);
  if (userId !== null && (!Number.isInteger(userId) || userId <= 0)) return badRequest("Unknown person.");
  const email = typeof b.email === "string" ? b.email : "";
  if (userId === null && !email.trim()) return badRequest("Pick the person to make the requester, or type an email address.");
  if (userId !== null && email.trim()) return badRequest("Pick a person or type an address, not both.");
  if (b.keep_cc !== undefined && typeof b.keep_cc !== "boolean") return badRequest("keep_cc is true or false.");
  try {
    const r = await changeRequester(
      found.ticket.id,
      userId !== null ? { user_id: userId } : { email, name: typeof b.name === "string" ? b.name : undefined },
      { id: gate.id, name: gate.name || gate.username, role: gate.role },
      { keepCc: b.keep_cc === true, ctx: { origin: originOf(req) }, ip: ipFrom(req), by: "agent" }
    );
    if (!r) return notFound();
    return NextResponse.json({ ticket: (await getTicketById(found.ticket.id)) ?? found.ticket, changed: r.changed, ...(r.cc ? { cc: r.cc } : {}) });
  } catch (e) {
    if (e instanceof RequesterChangeError) return NextResponse.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status });
    throw e;
  }
}
