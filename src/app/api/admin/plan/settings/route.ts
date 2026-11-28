// PUT /api/admin/plan/settings { ai_spending?, ai_cap_usd?, billing_contact? } → 200 { spending, billing_contact }
//   Plan & usage's choices (1.22.0): what happens past the AI allowance
//   (design D2: "keep" AI on, the default; "stop" at the allowance; "cap" at
//   an amount, never below the allowance) and the billing contact the
//   warning emails go to instead of every admin (Decision 5; "" = all
//   admins). Both are audited. 404 outside cloud mode or without a plan;
//   workspace.settings_manage.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { getSetting, setSetting } from "@/lib/db";
import { readJson } from "@/lib/helpdesk/access";
import { planApiGate } from "@/lib/plan-api";
import { BILLING_CONTACT_SETTING, getAiSpending, setAiSpending } from "@/lib/plan-usage";
import { AI_SPENDING, validEmail, type AiSpending } from "@/lib/plan-shared";

export const dynamic = "force-dynamic";

/** The highest cap accepted, in dollars a month. */
const MAX_CAP_USD = 100_000;

export async function PUT(req: Request) {
  const gate = await planApiGate();
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 4 * 1024);
  if (!b) return NextResponse.json({ error: "Send the settings as JSON." }, { status: 400 });
  const allowance = gate.state.plan.aiAllowanceUsd;
  const before = await getAiSpending();
  let spending = before;
  if (b.ai_spending !== undefined) {
    if (!(AI_SPENDING as readonly unknown[]).includes(b.ai_spending)) return NextResponse.json({ error: "Choose Keep AI on, Stop at the allowance or Cap at an amount." }, { status: 400 });
    const choice = b.ai_spending as AiSpending;
    let cap: number | null = null;
    if (choice === "cap") {
      const n = typeof b.ai_cap_usd === "number" ? b.ai_cap_usd : Number(b.ai_cap_usd);
      if (!Number.isFinite(n) || n <= 0 || n > MAX_CAP_USD) return NextResponse.json({ error: "Enter a monthly cap in dollars." }, { status: 400 });
      if (allowance !== null && n < allowance) {
        return NextResponse.json({ error: `The cap includes the $${allowance} allowance: enter at least $${allowance}, or choose Stop at the allowance.` }, { status: 400 });
      }
      cap = Math.round(n * 100) / 100;
    }
    spending = { spending: choice, capUsd: cap };
    if (choice !== before.spending || cap !== before.capUsd) {
      await setAiSpending(spending);
      await audit({
        actor: actorFrom(gate.user),
        action: "plan.ai_spending_changed",
        details: { before: before.spending, before_cap_usd: before.capUsd, after: choice, cap_usd: cap },
        ip: ipFrom(req),
      });
    }
  }
  let contact = ((await getSetting(BILLING_CONTACT_SETTING)) ?? "").trim();
  if (b.billing_contact !== undefined) {
    const next = typeof b.billing_contact === "string" ? b.billing_contact.trim() : "";
    if (next && (next.length > 254 || !validEmail(next))) return NextResponse.json({ error: "Enter the billing contact's email address, or leave it empty for all admins." }, { status: 400 });
    if (next !== contact) {
      await setSetting(BILLING_CONTACT_SETTING, next);
      await audit({ actor: actorFrom(gate.user), action: "plan.billing_contact_changed", details: { before: contact || null, after: next || null }, ip: ipFrom(req) });
      contact = next;
    }
  }
  return NextResponse.json({ spending, billing_contact: contact || gate.state.plan.billingContact || "" });
}
