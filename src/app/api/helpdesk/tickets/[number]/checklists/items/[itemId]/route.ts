// PATCH /api/helpdesk/tickets/[number]/checklists/items/[itemId]  { done: boolean }
//       → { checklists, can_edit, can_remove, templates }. Ticks or unticks an item; a change
//       leaves an internal timeline line ("Ana ticked "Image the laptop" (New starter: IT)") and
//       is audited (helpdesk.checklist.item_ticked / helpdesk.checklist.item_unticked).
// Helpdesk 1.19.2 (agent W3, lib/helpdesk/checklists). Anyone who works the ticket, newbies too.
// 1.20.14: { done, via: "claude_desk" } from a Claude in the desk card: the same checks, the line
//       ends "via Claude in the desk" and the audit row carries via "claude_desk".

import { NextResponse } from "next/server";
import { ipFrom } from "@/lib/audit";
import { helpdeskGate, readJson } from "@/lib/helpdesk/access";
import { badRequest, loadTicketFor, notFound } from "@/lib/helpdesk/routes";
import { ChecklistError, checklistsEditable, tickItemsAs, ticketChecklistView } from "@/lib/helpdesk/checklists";

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
  // 1.20.14: the library's tickItemsAs, which Claude's tools share (the same line and audit row);
  // via "claude_desk" marks a tick the agent applied from a Claude in the desk card.
  try {
    await tickItemsAs(gate, t, [{ id: itemId, done: b.done }], { ip: ipFrom(req), ...(b.via === "claude_desk" ? { via: "claude_desk" as const } : {}) });
  } catch (e) {
    if (e instanceof ChecklistError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  return NextResponse.json(await ticketChecklistView(gate, t));
}
