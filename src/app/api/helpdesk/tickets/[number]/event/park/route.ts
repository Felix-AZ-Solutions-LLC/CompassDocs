// GET  /api/helpdesk/tickets/[number]/event/park[?prep_days=N] → HdParkingView
//        The ticket's parking (1.20.34 Hold until the event, lib/helpdesk/desk-calendar-park): when it wakes, its prep
//        window, and when it would wake with `prep_days` (the dialog's preview) or the sentence that refuses it.
// POST /api/helpdesk/tickets/[number]/event/park  { action: "park", prep_days? } | { action: "wake" } | { action: "prep", prep_days }
//        Park it until its event (on hold, out of the queue, its targets paused), wake it now, or change its own prep
//        window (0 to 60 working days; null: the desk's). → HdParkingView. 409 with one sentence when it can't be
//        parked (no live event, solved or closed, already parked, or the event too close: "This event is too close to
//        park: it would wake today."). Each is an agents-only timeline line and an audit row.
// Agents who work the ticket and may change its status (tickets.change_status), as the status menu.

import { NextResponse } from "next/server";
import { actorFrom } from "@/lib/audit";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { badRequest, loadTicketFor, originOf } from "@/lib/helpdesk/routes";
import { HD_FORBIDDEN, hdCan } from "@/lib/helpdesk/roles";
import { ParkError, checkPrepDays, parkTicket, parkingView, setPrepDays, wakeTicket } from "@/lib/helpdesk/desk-calendar-park";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  const raw = new URL(req.url).searchParams.get("prep_days");
  let prepDays: number | null | undefined;
  if (raw !== null && raw !== "") {
    const c = checkPrepDays(raw);
    if (!c.ok) return badRequest(c.error);
    prepDays = c.value;
  }
  const may = await hdCan(gate, "tickets.change_status", { teamId: found.ticket.team_id });
  return NextResponse.json(await parkingView(found.ticket.id, may, { prepDays }));
}

export async function POST(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  if (!(await hdCan(gate, "tickets.change_status", { teamId: found.ticket.team_id }))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  const b = await readJson(req, 1024);
  if (!b || (b.action !== "park" && b.action !== "wake" && b.action !== "prep")) return badRequest('Send { action: "park" }, { action: "wake" } or { action: "prep", prep_days }.');
  const a = actorFrom(gate);
  const actor = { id: gate.id, name: gate.name || gate.username, role: a.role ?? null };
  const origin = originOf(req);
  try {
    if (b.action === "park") {
      await parkTicket(found.ticket.id, actor, { prepDays: b.prep_days === undefined ? undefined : (b.prep_days as number | null), reason: "agent", origin });
    } else if (b.action === "wake") {
      if (!(await wakeTicket(found.ticket.id, actor, { why: "manual", origin }))) return NextResponse.json({ error: "This ticket isn't parked." }, { status: 409 });
    } else {
      if (b.prep_days === undefined) return badRequest("Send prep_days: 0 to 60 working days, or null for the desk's.");
      await setPrepDays(found.ticket.id, b.prep_days, actor, { origin });
    }
  } catch (e) {
    if (e instanceof ParkError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  return NextResponse.json(await parkingView(found.ticket.id, true));
}
