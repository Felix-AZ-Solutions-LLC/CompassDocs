// POST /api/helpdesk/tickets/[number]/messages/[id]/resend
//   1.20.32: Send again on an agent's public reply whose email, through the
//   workspace's Microsoft 365 outbox (lib/mail-outbox), failed or may not
//   have gone out. Every such copy (the requester's, the people copied) is
//   queued again with the body it was built with. → 200 { resent: n }; 409
//   when there is nothing to send again (it went out, was discarded, or its
//   body is gone). Who may: an agent who works the ticket and may reply in
//   public on it. Refused (409) on a merged ticket, as a new reply is.
//   Audited against the ticket (helpdesk.reply_mail_resent).

import { NextResponse } from "next/server";
import { helpdeskGate, messagePostLimited, tooMany } from "@/lib/helpdesk/access";
import { loadTicketFor, notFound } from "@/lib/helpdesk/routes";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import { getMessage } from "@/lib/helpdesk/messages";
import { mergedLock } from "@/lib/helpdesk/merge";
import { resendForRef } from "@/lib/mail-outbox";
import { actorFrom, ipFrom } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ number: string; id: string }> }) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  if (messagePostLimited(gate.id)) return tooMany();
  const p = await params;
  const found = await loadTicketFor(gate, p.number, "work");
  if (found instanceof NextResponse) return found;
  const t = found.ticket;
  // As the messages POST: a merged ticket's conversation is read-only.
  const locked = await mergedLock(t);
  if (locked) return NextResponse.json({ error: locked }, { status: 409 });
  const id = Number(p.id);
  if (!Number.isSafeInteger(id) || id <= 0) return notFound();
  const m = await getMessage(id);
  if (!m || m.ticket_id !== t.id || m.kind !== "public") return notFound();
  if (!(await hdCan(gate, "tickets.reply_public", { teamId: t.team_id }))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  const resent = await resendForRef({ type: "hd_message", id }, { actor: actorFrom(gate), ip: ipFrom(req) }, { id: t.id, number: t.number, subject: t.subject });
  if (!resent) return NextResponse.json({ error: "There is nothing to send again: the email went out, was discarded, or can't be sent again." }, { status: 409 });
  return NextResponse.json({ ok: true, resent });
}
