// GET /api/helpdesk/tickets/export?<the queue's own parameters>
//   The tickets a queue list holds (any view, team, saved view's filters or filtered list, every page,
//   in the list's order and the caller's scope) as CSV, at most 10,000 (lib/helpdesk/ticket-export).
//   The parameters are the list's, GET /api/helpdesk/tickets (lib/helpdesk/ticket-filters), custom field
//   conditions (cf.<key>) included; limit and offset are ignored. A bad parameter: 400 with a sentence.
//   Headers: x-compass-export-rows (tickets written), x-compass-export-total (tickets the list holds),
//   x-compass-export-capped: 1 when the list was cut at the cap.
// Helpdesk 1.20.8. tickets.export (as the time and report CSVs). Audited helpdesk.tickets.exported with
// the count and the filters, never a ticket's content.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { badRequest } from "@/lib/helpdesk/routes";
import { helpdeskTimezone } from "@/lib/helpdesk/tickets";
import { parseTicketFilters } from "@/lib/helpdesk/ticket-filters";
import { planTicketExport, ticketExportStream } from "@/lib/helpdesk/ticket-export";
import { filterSummary } from "@/lib/helpdesk/saved-views-shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await hdCapGate("tickets.export");
  if (gate instanceof NextResponse) return gate;
  const p = new URL(req.url).searchParams;
  p.delete("limit");
  p.delete("offset");
  const parsed = await parseTicketFilters(p);
  if (!parsed.ok) return badRequest(parsed.error);
  const f = parsed.filters;
  const plan = await planTicketExport(gate, f);
  const tz = await helpdeskTimezone();
  const stream = await ticketExportStream(plan.ids, tz);
  // The filters as sent (the list's own parameters) and in words; no ticket's content.
  const filters: Record<string, string> = {};
  for (const [k, v] of p) if (k !== "sort" && v) filters[k.slice(0, 60)] = v.slice(0, 200);
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.tickets.exported",
    targetType: "helpdesk_tickets",
    targetLabel: `${plan.ids.length} ${plan.ids.length === 1 ? "ticket" : "tickets"}`,
    details: {
      count: plan.ids.length,
      total: plan.total,
      capped: plan.capped,
      filters,
      summary: filterSummary(filters, [], f.custom),
    },
    ip: ipFrom(req),
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="tickets-${stamp}.csv"`,
      "cache-control": "no-store",
      "x-compass-export-rows": String(plan.ids.length),
      "x-compass-export-total": String(plan.total),
      "x-compass-export-capped": plan.capped ? "1" : "0",
    },
  });
}
