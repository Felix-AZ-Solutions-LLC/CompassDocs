// PATCH /api/helpdesk/tickets/[number]/checklists/items/[itemId]  { done: boolean }
//       → { checklists, can_edit, can_remove, templates }. Ticks or unticks an item; a change
//       leaves an internal timeline line ("Ana ticked "Image the laptop" (New starter: IT)") and
//       is audited (helpdesk.checklist.item_ticked / helpdesk.checklist.item_unticked).
// Helpdesk 1.19.2 (agent W3, lib/helpdesk/checklists). Anyone who works the ticket, newbies too.
// 1.20.14: { done, card_id } from a Claude in the desk card: the same checks; when card_id is the
//       agent's offered card for this tick, the line ends "via Claude in the desk" and the audit
//       row carries via "claude_desk". Without one (or with only a bare `via`) it is the agent's own.

import { NextResponse } from "next/server";
import { ipFrom } from "@/lib/audit";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { badRequest, loadTicketFor, notFound } from "@/lib/helpdesk/routes";
import { ChecklistError, checklistsEditable, tickItemsAs, ticketChecklistView } from "@/lib/helpdesk/checklists";
import { offeredChecklistCard } from "@/lib/helpdesk/claude/chats";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ number: string; itemId: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const p = await params;
  const found = await loadTicketFor(gate, p.number, "work");
  if (found instanceof NextResponse) return found;
  const t = found.ticket;
  const itemId = Number(p.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0) return notFound();
  if (!checklistsEditable(t)) return NextResponse.json({ error: "This ticket can't change any more." }, { status: 409 });
  const b = await readJson(req, 1024);
  if (!b || typeof b.done !== "boolean") return badRequest("Send { done: true } or { done: false }.");
  // 1.20.14: the library's tickItemsAs, which Claude's tools share (the same line and audit row).
  // { card_id } from a Claude in the desk card marks it "via Claude in the desk", only when that is
  // one of this agent's offered cards for exactly this tick (review fix: a bare via is ignored).
  const fromCard = await offeredChecklistCard(gate.id, b.card_id, { action: "tick", ticketId: t.id, itemId, done: b.done });
  try {
    await tickItemsAs(gate, t, [{ id: itemId, done: b.done }], { ip: ipFrom(req), ...(fromCard ? { via: "claude_desk" as const } : {}) });
  } catch (e) {
    if (e instanceof ChecklistError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  return NextResponse.json(await ticketChecklistView(gate, t));
}
