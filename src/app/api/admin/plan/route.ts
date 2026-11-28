// GET /api/admin/plan → PlanOverview (lib/plan-shared)
//   Settings → Plan & usage (1.22.0): the plan from the licence, this
//   month's four meters with their six-month trends, storage by area, AI by
//   feature and the spending choice, the billing contact, and a licence that
//   names another workspace (design F). 404 outside cloud mode or without a
//   plan; workspace.settings_manage.

import { NextResponse } from "next/server";
import { planApiGate } from "@/lib/plan-api";
import { planOverview } from "@/lib/plan-usage";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await planApiGate();
  if (gate instanceof NextResponse) return gate;
  const overview = await planOverview();
  if (!overview) return NextResponse.json({ error: "This workspace has no CompassDocs Cloud plan.", code: "no_plan" }, { status: 404 });
  const { getAiSpending } = await import("@/lib/plan-usage");
  return NextResponse.json({ ...overview, spending: await getAiSpending() });
}
