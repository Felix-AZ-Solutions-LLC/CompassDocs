// GET  /api/helpdesk/admin/reply-lock → { settings: HdReplyLockSettings, locks: HdLiveLock[] }
// PUT  /api/helpdesk/admin/reply-lock  { enabled?, idle_minutes? } → { settings }
//      Desk settings → Reply lock (1.20.20, lib/helpdesk/reply-lock): reply locks on or off, and how long
//      an idle holder keeps one (1 to 15 minutes, from their last touch of the reply). Switching off
//      drops every lock at once. Audited (helpdesk.reply_lock.settings_updated) with what changed.
// POST /api/helpdesk/admin/reply-lock  { release: { number } | { user_id } } → { released: [...], locks }
//      1.20.20 review: release one ticket's lock, or every lock one agent holds ("Release all of Sam's
//      locks"). Audited helpdesk.reply_lock.released with the tickets and the person.
// Desk capability settings.manage.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { badRequest } from "@/lib/helpdesk/routes";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { forceReleaseReplyLocks, getReplyLockSettings, liveReplyLocks, saveReplyLockSettings } from "@/lib/helpdesk/reply-lock";
import { hqOne } from "@/lib/helpdesk/db-core";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ settings: await getReplyLockSettings(), locks: await liveReplyLocks() });
}

export async function PUT(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 1024);
  if (!b) return badRequest("Send the settings as JSON.");
  const r = await saveReplyLockSettings(b);
  if ("error" in r) return badRequest(r.error);
  if (r.changed.length) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.reply_lock.settings_updated",
      targetType: "helpdesk_settings",
      targetId: null,
      targetLabel: "Reply lock",
      details: { changed: r.changed, enabled: r.settings.enabled, idle_minutes: r.settings.idle_minutes },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ settings: r.settings });
}

export async function POST(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 1024);
  const rel = b?.release && typeof b.release === "object" && !Array.isArray(b.release) ? (b.release as Record<string, unknown>) : null;
  if (!rel) return badRequest("Send { release: { number } } or { release: { user_id } }.");
  let released: Awaited<ReturnType<typeof forceReleaseReplyLocks>>;
  if (rel.user_id !== undefined) {
    const id = Number(rel.user_id);
    if (!Number.isSafeInteger(id) || id <= 0) return badRequest("user_id is a person's id.");
    released = await forceReleaseReplyLocks({ userId: id });
  } else {
    const n = Number(rel.number);
    if (!Number.isSafeInteger(n) || n <= 0) return badRequest("number is a ticket number.");
    const t = await hqOne<{ id: number }>("SELECT id FROM hd_tickets WHERE number = $1 AND deleted_at IS NULL", [n]);
    if (!t) return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
    released = await forceReleaseReplyLocks({ ticketId: Number(t.id) });
  }
  if (released.length) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.reply_lock.released",
      targetType: rel.user_id !== undefined ? "user" : "helpdesk_ticket",
      targetId: rel.user_id !== undefined ? released[0].user_id : released[0].ticket_id,
      targetLabel: rel.user_id !== undefined ? released[0].name : `#${released[0].number}`,
      details: { numbers: released.map((x) => x.number), from_user_id: released[0].user_id, from_name: released[0].name, all: rel.user_id !== undefined },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ released: released.map((x) => ({ number: x.number, user_id: x.user_id, name: x.name })), locks: await liveReplyLocks() });
}
