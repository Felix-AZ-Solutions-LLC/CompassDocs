// GET /api/helpdesk/calendar/upcoming → HdUpcomingEvents
//       1.20.24 (lib/helpdesk/desk-calendar upcomingEvents; the rules in desk-calendar-upcoming-shared): the desk
//       top bar's upcoming-events pill and dropdown, and the Calendar rail icon's count of today's events left.
//       The events the caller may see on the Calendar page (their teams' and their own tickets'), not cancelled,
//       still to come in the next 14 calendar days in the caller's own time zone. No parameters.
// Agents (helpdesk.agent), licensed, as the Calendar page.

import { NextResponse } from "next/server";
import { helpdeskGate } from "@/lib/helpdesk/access";
import { upcomingEvents, viewerZone } from "@/lib/helpdesk/desk-calendar";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await helpdeskGate("agent");
  if (gate instanceof NextResponse) return gate;
  const data = await upcomingEvents(gate, { tz: await viewerZone(gate) });
  return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
}
