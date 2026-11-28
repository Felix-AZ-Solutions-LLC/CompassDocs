// GET  /api/plan/notices → { notices: PlanNotice[], mismatch }
// POST /api/plan/notices { dismiss: [{ meter, threshold }] } → 200 { ok: true }
//   The admin banners (1.22.0, design B): one per meter at its highest
//   threshold this month (80% is a fact, notice-info; the limit and past
//   the buffer, notice-warn), less what this admin dismissed (per admin,
//   per threshold, per month: Decision 9), and the licence-mismatch notice
//   (design F). Only for whoever can open Plan & usage; everyone else
//   (and every self-hosted workspace) gets 404 and sees nothing.

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { isCloud } from "@/lib/cloud";
import { readJson } from "@/lib/helpdesk/access";
import { planResolution } from "@/lib/plan";
import { planApiGate } from "@/lib/plan-api";
import { dismissNotices, noticesFor } from "@/lib/plan-usage";
import { METER_KEYS, type MeterKey, type Threshold } from "@/lib/plan-shared";

export const dynamic = "force-dynamic";

const THRESHOLDS: readonly Threshold[] = ["80", "limit", "past", "paused"];

export async function GET() {
  // Not planApiGate: a licence naming another workspace is said even when no plan is left to run on (design F).
  if (!isCloud()) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const user = await apiGuard("admin", "workspace.settings_manage");
  if (user instanceof NextResponse) return user;
  const r = await planResolution();
  if (!r.state && !r.mismatch) return NextResponse.json({ error: "This workspace has no CompassDocs Cloud plan.", code: "no_plan" }, { status: 404 });
  return NextResponse.json({ notices: r.state ? await noticesFor(user.id) : [], mismatch: r.mismatch, plan: r.state ? r.state.plan.name : null });
}

export async function POST(req: Request) {
  const gate = await planApiGate();
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 4 * 1024);
  const items = Array.isArray(b?.dismiss) ? (b!.dismiss as unknown[]) : null;
  if (!items || !items.length || items.length > 8) return NextResponse.json({ error: "Name the banners to dismiss." }, { status: 400 });
  const ok = items.every(
    (i) => typeof i === "object" && i !== null && (METER_KEYS as readonly unknown[]).includes((i as { meter?: unknown }).meter) && (THRESHOLDS as readonly unknown[]).includes((i as { threshold?: unknown }).threshold)
  );
  if (!ok) return NextResponse.json({ error: "Unknown banner." }, { status: 400 });
  await dismissNotices(gate.user.id, items as { meter: MeterKey; threshold: Threshold }[]);
  return NextResponse.json({ ok: true });
}
