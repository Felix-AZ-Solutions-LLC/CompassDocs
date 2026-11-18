// 1.20.32: the outbox of the workspace's email through Microsoft 365
// (lib/mail-outbox), for Settings → Notifications → Email → Outbox.
//
//   GET    → OutboxView (lib/mail-outbox-shared): how many wait, sent in the
//            last hour, the day's recipients against the limit, the pause and
//            why, and the failed and uncertain messages (subject, recipients,
//            when, why). Never a message's body.
//   PATCH  { action: "retry", id }    → queued again with the body it was
//            built with (an uncertain one may then arrive twice: the page
//            says so first)
//          { action: "discard", id }  → never sent; its body wiped
//          { action: "discard_waiting" } → every message still queued is
//            discarded (not one being sent this moment); answers how many
//          { action: "resume" }       → lift a pause for a refusal now (Try
//            now); Microsoft's own slow-down is never lifted early
//
// Same permissions as the rest of the email settings: integration.smtp_read
// to look, integration.smtp_manage to act. Retry and Discard are audited
// (settings.mail_outbox_retry, settings.mail_outbox_discard,
// settings.mail_outbox_discard_all), and so is Try now
// (settings.mail_outbox_resume).

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { OutboxError, discardAllWaiting, discardOutboxMessage, outboxView, resumeOutbox, retryOutboxMessage } from "@/lib/mail-outbox";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("admin", "integration.smtp_read");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await outboxView());
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin", "integration.smtp_manage");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  const by = { actor: actorFrom(user), ip: ipFrom(req) };
  let body: { action?: unknown; id?: unknown } | null = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const action = String(body?.action ?? "");
  const id = Number(body?.id);
  try {
    if (action === "retry" || action === "discard") {
      if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "Which email?" }, { status: 400 });
      if (action === "retry") await retryOutboxMessage(id, by);
      else await discardOutboxMessage(id, by);
      return NextResponse.json({ ok: true, outbox: await outboxView() });
    }
    if (action === "discard_waiting") {
      const discarded = await discardAllWaiting(by);
      return NextResponse.json({ ok: true, discarded, outbox: await outboxView() });
    }
    if (action === "resume") {
      await resumeOutbox({ onlyRefusal: true });
      await audit({ actor: by.actor, action: "settings.mail_outbox_resume", targetType: "settings", targetId: "mail", targetLabel: "Email outbox", ip: by.ip });
      return NextResponse.json({ ok: true, outbox: await outboxView() });
    }
  } catch (e) {
    if (e instanceof OutboxError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
