// POST /api/admin/plan/upgrade { target, reply_to, note? } → 200 { sent: true } | 200 { sent: false, mailto }
//   Request an upgrade (1.22.0, design A9 and C3): the console's billing
//   hand-off isn't built yet, so the dialog sends CompassDocs sales an email
//   through the workspace's own outgoing mail (lib/mailer), with the
//   admin's address to reply to. When the workspace can't send email, the
//   answer is a mailto: link the page opens instead. Counts and the plan
//   only, plus what the admin typed. Audited. 404 outside cloud mode or
//   without a plan; workspace.settings_manage.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { planUpgradeRateLimited } from "@/lib/rate-limit";
import { planApiGate } from "@/lib/plan-api";
import { workspaceId } from "@/lib/plan";
import { PLAN_CATALOGUE, PLAN_NAMES, planLabel, SALES_EMAIL, validEmail, type PlanName } from "@/lib/plan-shared";

export const dynamic = "force-dynamic";

const NOTE_MAX = 2000;

export async function POST(req: Request) {
  const gate = await planApiGate();
  if (gate instanceof NextResponse) return gate;
  if (planUpgradeRateLimited(String(gate.user.id))) {
    return NextResponse.json({ error: "You've sent several requests this hour. We'll be in touch." }, { status: 429 });
  }
  const b = await readJson(req, 8 * 1024);
  if (!b) return NextResponse.json({ error: "Send the request as JSON." }, { status: 400 });
  const target = b.target as PlanName;
  const current = gate.state.plan.name;
  if (!(PLAN_NAMES as readonly unknown[]).includes(target) || target === current) return NextResponse.json({ error: "Choose the plan to move to." }, { status: 400 });
  const replyTo = typeof b.reply_to === "string" ? b.reply_to.trim() : "";
  if (!validEmail(replyTo) || replyTo.length > 254) return NextResponse.json({ error: "Enter the address we should reply to." }, { status: 400 });
  const note = typeof b.note === "string" ? b.note.trim().slice(0, NOTE_MAX) : "";
  const { getAppSettings } = await import("@/lib/settings-store");
  const name = (await getAppSettings()).company_name || "A CompassDocs Cloud workspace";
  const ws = workspaceId() ?? "unknown";
  const subject = `Upgrade request: ${name} (${ws}) from ${planLabel(current)} to ${planLabel(target)}`;
  const text = [
    `${name} asks to move from ${planLabel(current)} to ${planLabel(target)}.`,
    "",
    `Workspace: ${ws}`,
    `License: ${gate.state.license.id ?? "unknown"}`,
    `Renews: ${gate.state.plan.renewsAt}`,
    `Reply to: ${replyTo}`,
    "",
    note ? `They wrote:\n${note}` : "They added no note.",
  ].join("\n");
  let sent = false;
  try {
    const { sendMail } = await import("@/lib/mailer");
    await sendMail([SALES_EMAIL], subject, `${text}\n\nSent from Settings → Plan & usage by ${gate.user.name || gate.user.username}.`, undefined, undefined, undefined, { kind: "plan_upgrade" });
    sent = true;
  } catch {
    sent = false;
  }
  await audit({
    actor: actorFrom(gate.user),
    action: "plan.upgrade_requested",
    details: { from: current, to: target, sent, has_note: !!note },
    ip: ipFrom(req),
  });
  if (sent) return NextResponse.json({ sent: true, to: SALES_EMAIL, plan: PLAN_CATALOGUE[target].label });
  const mailto = `mailto:${SALES_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  return NextResponse.json({ sent: false, mailto, to: SALES_EMAIL });
}
