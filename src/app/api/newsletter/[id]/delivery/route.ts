// 1.20.31: a newsletter's background send through Microsoft 365
// (lib/newsletter-delivery).
//   GET  → { delivery: NewsletterDeliveryView | null }  (anyone who may view the newsletter)
//   POST { action: "retry" }  → the recipients that failed are queued again
//   POST { action: "resume" } → a stopped send goes on
// POST takes an approver of this newsletter (canApprove), whether it is still approved or already sent.

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { getNewsletter, getNewsletterApproverIds } from "@/lib/db";
import { canApprove, canView } from "@/lib/newsletter-access";
import { NewsletterSendError, newsletterDelivery, resumeNewsletterSend } from "@/lib/newsletter-delivery";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

async function load(id: string) {
  const n = await getNewsletter(Number(id));
  if (!n) return null;
  return { n, approverIds: await getNewsletterApproverIds(n.id) };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const got = await load((await params).id);
  if (!got || !canView(user, got.n, got.approverIds)) return NextResponse.json({ error: "Newsletter not found." }, { status: 404 });
  return NextResponse.json({ delivery: await newsletterDelivery(got.n.id) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await apiGuard();
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const got = await load((await params).id);
  if (!got) return NextResponse.json({ error: "Newsletter not found." }, { status: 404 });
  if (!canApprove(user, got.approverIds)) return NextResponse.json({ error: "Only an approver can retry a send." }, { status: 403 });
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* no body */
  }
  const what = body?.action === "retry" ? "failed" : body?.action === "resume" ? "stopped" : null;
  if (!what) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  try {
    const delivery = await resumeNewsletterSend(got.n.id, what);
    await audit({ actor: actorFrom(user), action: what === "failed" ? "newsletter.send_retried" : "newsletter.send_resumed", targetType: "newsletter", targetId: got.n.id, targetLabel: got.n.subject, details: { queued: delivery.queued }, ip: ipFrom(req) });
    return NextResponse.json({ delivery });
  } catch (e) {
    if (e instanceof NewsletterSendError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
