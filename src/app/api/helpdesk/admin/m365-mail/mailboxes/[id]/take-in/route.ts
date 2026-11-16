// POST /api/helpdesk/admin/m365-mail/mailboxes/[id]/take-in  { message } → { line, already?, gone?, view }
// Helpdesk 1.20.25 (lib/helpdesk/m365/mail takeInM365Anyway): "Take in anyway" on a dropped "Last messages" line.
// The message is read again from Microsoft by its id and run through the pipeline with only the rule that dropped
// it skipped (automatic mail, an account that can't use Get help, mail from outside the workspace); never loop
// protection or a blocked portal contact. A duplicate answers 409 with code "duplicate" (open the ticket instead).
// Exactly once: a second click answers `already`. channels.manage (settings.manage covers it), as Try again. Ten a
// minute per person. Audited (helpdesk.m365.taken_in_anyway).

import { NextResponse } from "next/server";
import { actorFrom, ipFrom } from "@/lib/audit";
import { hdRateLimited, readJson } from "@/lib/helpdesk/access";
import { M365MailError, m365MailView, takeInM365Anyway } from "@/lib/helpdesk/m365/mail";
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
  const b = await readJson(req, 8 * 1024);
  if (!b || typeof b.message !== "string" || !b.message) return badRequest("Say which message to take in.");
  if (hdRateLimited(`m365-take-in:${gate.id}`, 10, 60_000)) return NextResponse.json({ error: "Too many at once. Try again in a minute." }, { status: 429 });
  try {
    const r = await takeInM365Anyway(Number(raw), b.message, { actor: actorFrom(gate), ip: ipFrom(req) });
    if (!r) return notFound();
    return NextResponse.json({ ...r, view: await m365MailView() });
  } catch (e) {
    if (e instanceof M365MailError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    throw e;
  }
}
