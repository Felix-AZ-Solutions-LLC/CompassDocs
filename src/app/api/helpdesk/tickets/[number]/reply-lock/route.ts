// GET    /api/helpdesk/tickets/[number]/reply-lock[?tab=]   → HdReplyLockState (this_tab: whether that tab holds it)
//          who holds the ticket's public reply, as the caller sees it (theirs, someone else's with
//          can_take_over, or nobody), and whether reply locks are on
// POST   /api/helpdesk/tickets/[number]/reply-lock   { action, tab?, idle_ms?, from?, to? }
//          take       the composer's first change to the Reply box (from browser tab `tab`): 200
//                     HdReplyLockState with the caller's lock, or 409 { error, code: "reply_locked",
//                     ...HdReplyLockState }. Over 3 locks, the caller's oldest is released (audited
//                     helpdesk.reply_lock.cap_released).
//          refresh    the holder's heartbeat; `idle_ms`: how long since the box was last touched (the
//                     server measures idle from then). Never takes a free lock.
//          take_over  "Take over a reply" (lib/helpdesk/reply-lock mayTakeOver): moves the lock from
//                     its holder (`from`: the user id the confirm named; anyone else holding it, or
//                     the lock gone meanwhile, answers 409). Audited helpdesk.reply_lock.taken_over.
//          hand_off   the pop-out seam: move the caller's lock from tab `tab` to tab `to`.
//          release    a lead's or admin's Release (the take over's rule): the lock goes, whoever holds
//                     it. Audited helpdesk.reply_lock.released.
// DELETE /api/helpdesk/tickets/[number]/reply-lock[?tab=]   let go (or the box was emptied, the tab
//          closed): only while that tab holds it → HdReplyLockState
// Helpdesk 1.20.20. Agents who work the ticket only (the presence route's rule): anyone else gets
// the same 404 as a missing ticket. 120 calls a minute per person.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { hdRateLimited, helpdeskGate, readJson, tooMany } from "@/lib/helpdesk/access";
import { badRequest, loadTicketFor } from "@/lib/helpdesk/routes";
import { hdCan, HD_FORBIDDEN } from "@/lib/helpdesk/roles";
import {
  activeReplyLock,
  cleanTabId,
  forceReleaseReplyLocks,
  handOffReplyLock,
  mayTakeOver,
  refreshReplyLock,
  releaseReplyLock,
  replyLockState,
  takeOverReplyLock,
  takeReplyLock,
} from "@/lib/helpdesk/reply-lock";
import { REPLY_LOCK_CODE, lockRefusal } from "@/lib/helpdesk/reply-lock-shared";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string }> };

async function load(params: Ctx["params"]) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  if (hdRateLimited(`hd-reply-lock:${gate.id}`, 120, 60_000)) return tooMany();
  const found = await loadTicketFor(gate, (await params).number, "work");
  if (found instanceof NextResponse) return found;
  return { gate, ticket: found.ticket };
}

export async function GET(req: Request, { params }: Ctx) {
  const ctx = await load(params);
  if (ctx instanceof NextResponse) return ctx;
  return NextResponse.json(await replyLockState(ctx.ticket, ctx.gate, cleanTabId(new URL(req.url).searchParams.get("tab"))));
}

export async function POST(req: Request, { params }: Ctx) {
  const ctx = await load(params);
  if (ctx instanceof NextResponse) return ctx;
  const { gate, ticket } = ctx;
  const b = await readJson(req, 1024);
  const action = b?.action;
  if (action !== "take" && action !== "refresh" && action !== "take_over" && action !== "hand_off" && action !== "release") {
    return badRequest("action is take, refresh, take_over, hand_off or release.");
  }
  const tab = cleanTabId(b?.tab);
  const teamId = ticket.team_id;
  const mayReply = (await hdCan(gate, "tickets.reply_public", { teamId })) || (await hdCan(gate, "tickets.reply_needs_review", { teamId }));
  if (!mayReply) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  if (action === "refresh") {
    const idle = b?.idle_ms === undefined || b?.idle_ms === null ? undefined : Number(b.idle_ms);
    if (idle !== undefined && (!Number.isFinite(idle) || idle < 0)) return badRequest("idle_ms is the milliseconds since the reply was last touched.");
    await refreshReplyLock(ticket.id, gate.id, tab, idle);
    return NextResponse.json(await replyLockState(ticket, gate, tab));
  }
  if (action === "hand_off") {
    const to = cleanTabId(b?.to);
    if (!to || !tab) return badRequest("Send the tab that holds the reply (tab) and the tab to give it to (to).");
    const moved = await handOffReplyLock(ticket.id, gate.id, tab, to);
    return NextResponse.json({ ...(await replyLockState(ticket, gate, tab)), handed_off: moved });
  }
  if (action === "take") {
    const r = await takeReplyLock(ticket.id, gate.id, tab);
    if (!r.ok && "holder" in r) {
      return NextResponse.json({ error: lockRefusal(r.holder.name), code: REPLY_LOCK_CODE, ...(await replyLockState(ticket, gate, tab)) }, { status: 409 });
    }
    // Over the cap: the agent's oldest lock went. Audited (an ordinary take is not: it happens on every reply).
    if (r.ok && r.released.length) {
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.reply_lock.cap_released",
        targetType: "helpdesk_ticket",
        targetId: ticket.id,
        targetLabel: `#${ticket.number} ${ticket.subject}`.slice(0, 200),
        details: { number: ticket.number, released: r.released.map((x) => x.number) },
        ip: ipFrom(req),
      });
    }
    return NextResponse.json(await replyLockState(ticket, gate, tab));
  }
  if (action === "release") {
    const cur = await activeReplyLock(ticket.id);
    if (!cur) return NextResponse.json(await replyLockState(ticket, gate, tab));
    if (cur.user_id !== gate.id && !(await mayTakeOver(gate, teamId, cur.user_id))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
    const gone = await forceReleaseReplyLocks({ ticketId: ticket.id });
    if (gone.length && cur.user_id !== gate.id) {
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.reply_lock.released",
        targetType: "helpdesk_ticket",
        targetId: ticket.id,
        targetLabel: `#${ticket.number} ${ticket.subject}`.slice(0, 200),
        details: { numbers: [ticket.number], from_user_id: cur.user_id, from_name: cur.name },
        ip: ipFrom(req),
      });
    }
    return NextResponse.json(await replyLockState(ticket, gate, tab));
  }
  // take_over: from whoever the confirm named (else whoever holds it now), if the caller may take it from them.
  const raw = b?.from === undefined || b?.from === null ? undefined : Number(b.from);
  if (raw !== undefined && (!Number.isSafeInteger(raw) || raw <= 0)) return badRequest("from is the user id of the person replying.");
  const holder = raw ?? (await activeReplyLock(ticket.id))?.user_id;
  if (!(await mayTakeOver(gate, teamId, holder ?? null))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  if (!holder || holder === gate.id) {
    // Nobody is replying (or it is already theirs): a plain take.
    const t = await takeReplyLock(ticket.id, gate.id, tab);
    if (!t.ok && "holder" in t) return NextResponse.json({ error: lockRefusal(t.holder.name), code: REPLY_LOCK_CODE, ...(await replyLockState(ticket, gate, tab)) }, { status: 409 });
    return NextResponse.json({ ...(await replyLockState(ticket, gate, tab)), taken_over: false });
  }
  const r = await takeOverReplyLock(ticket.id, gate.id, holder, tab);
  if (!r.ok) return NextResponse.json({ error: r.error, ...(await replyLockState(ticket, gate, tab)) }, { status: r.status });
  if (r.from) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.reply_lock.taken_over",
      targetType: "helpdesk_ticket",
      targetId: ticket.id,
      targetLabel: `#${ticket.number} ${ticket.subject}`.slice(0, 200),
      details: { number: ticket.number, from_user_id: r.from.id, from_name: r.from.name, to_user_id: gate.id, to_name: gate.name || gate.username },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ ...(await replyLockState(ticket, gate, tab)), taken_over: r.from !== null });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const ctx = await load(params);
  if (ctx instanceof NextResponse) return ctx;
  const tab = cleanTabId(new URL(req.url).searchParams.get("tab"));
  await releaseReplyLock(ctx.ticket.id, ctx.gate.id, undefined, tab);
  return NextResponse.json(await replyLockState(ctx.ticket, ctx.gate, tab));
}
