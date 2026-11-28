// GET /api/admin/plan/people → { month, count, by_kind, people: PlanPerson[] }
// GET /api/admin/plan/people?format=csv → the same list as a CSV download
//   Who counted as an active user this month (1.22.0, design A6). The list
//   never leaves the workspace: the console gets the count only. Each
//   person counts once, under their highest role. 404 outside cloud mode or
//   without a plan; workspace.settings_manage.

import { NextResponse } from "next/server";
import { csvCell } from "@/lib/csv";
import { planApiGate } from "@/lib/plan-api";
import { activePeople, activeUsers } from "@/lib/plan-usage";
import { monthKey } from "@/lib/plan-shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await planApiGate();
  if (gate instanceof NextResponse) return gate;
  const now = new Date();
  const [people, counts] = await Promise.all([activePeople(now), activeUsers(now, new Date(now.getTime() + 1))]);
  const month = monthKey(now);
  if (new URL(req.url).searchParams.get("format") === "csv") {
    const lines = [["Person", "Counted as", "Where", "Last sign-in (UTC)"].map(csvCell).join(",")];
    for (const p of people) lines.push([p.name, p.countedAs, p.detail, p.lastAt].map(csvCell).join(","));
    return new Response(`${lines.join("\r\n")}\r\n`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="active-users-${month}.csv"`,
        "cache-control": "no-store",
      },
    });
  }
  return NextResponse.json({ month, count: counts.count, by_kind: counts.byKind, people });
}
