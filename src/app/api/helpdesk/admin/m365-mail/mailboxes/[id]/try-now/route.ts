// POST /api/helpdesk/admin/m365-mail/mailboxes/[id]/try-now  { message? } → { tried, line?, ok, busy?, error?, view }
// Helpdesk 1.20.25 (lib/helpdesk/m365/mail tryM365Now): "Try now" on a waiting "Last messages" line (`message`), or
// "Try all waiting now" on the mailbox row (no `message`). The wait is cleared and the message is taken in at once,
// in an intake slot like any other; the answer carries the line as it now stands. channels.manage (settings.manage
// covers it), as Try again. Ten a minute per person. Audited (helpdesk.m365.retry_requested, now: true).

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { hdRateLimited, readJson } from "@/lib/helpdesk/access";
import { M365MailError, m365MailView, tryM365Now } from "@/lib/helpdesk/m365/mail";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import type { HdCap } from "@/lib/helpdesk/roles";
import { badRequest, notFound } from "@/lib/helpdesk/routes";

export const dynamic = "force-dynamic";

const CAPS: HdCap[] = ["settings.manage", "channels.manage"];
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const gate = await hdAnyCapGate(CAPS);
  if (gate instanceof NextResponse) return gate;
  const raw = (await params).id;
  if (!/^\d{1,9}$/.test(raw)) return notFound();
  const b = (await readJson(req, 8 * 1024)) ?? {};
  if (b.message !== undefined && (typeof b.message !== "string" || !b.message)) return badRequest("Say which message to try.");
  if (hdRateLimited(`m365-try-now:${gate.id}`, 10, 60_000)) return NextResponse.json({ error: "Too many checks. Try again in a minute." }, { status: 429 });
  try {
    const r = await tryM365Now(Number(raw), typeof b.message === "string" ? b.message : null, { actor: actorFrom(gate), ip: ipFrom(req) });
    if (!r) return notFound();
    return NextResponse.json({ ...r, view: await m365MailView() });
  } catch (e) {
    if (e instanceof M365MailError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
