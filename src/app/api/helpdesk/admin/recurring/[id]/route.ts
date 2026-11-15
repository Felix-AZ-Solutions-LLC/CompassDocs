// GET    /api/helpdesk/admin/recurring/[id]   one schedule.
// PATCH  /api/helpdesk/admin/recurring/[id]   change it (any fields; the next run is recomputed). helpdesk.recurring.updated.
// DELETE /api/helpdesk/admin/recurring/[id]   delete it (tickets it opened stay). helpdesk.recurring.deleted.
// Helpdesk 1.19.1 (agent V8). settings.manage, or agents.manage_team in the schedule's team (and in the
// team it moves to). A schedule of a team the caller doesn't manage answers 404.
// 1.20.16, drafts from Claude (lib/helpdesk/recurring; the rules of 1.20.14's checklist review):
//        PATCH { …, publish: true, draft_at } publishes a new schedule Claude drafted and switches it on
//        (enabled false in the same body keeps it paused); PATCH { …, publish_draft: true, draft_at }
//        applies the changes waiting on a published schedule (fields not sent come from that draft; on
//        or off kept). Both audited helpdesk.recurring.published; 409 when draft_at isn't the current
//        draft's. A plain PATCH edits the live schedule (or the unpublished draft) and keeps a pending
//        draft; an unpublished draft can't be switched on (409). PATCH { discard_draft: true, draft_at? }
//        drops the changes waiting (helpdesk.recurring.draft_discarded; 409 when there are none or a
//        newer one). An unpublished draft is discarded with DELETE.

import { NextResponse } from "next/server";
import { hdAnyCapGate } from "@/lib/helpdesk/roles";
import {
  RecurringDraftError,
  auditRecurring,
  canManageRecurringTeam,
  deleteRecurring,
  discardRecurringDraft,
  getRecurring,
  saveRecurring,
} from "@/lib/helpdesk/recurring";
import { scheduleTitle } from "@/lib/helpdesk/recurring-shared";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function load(ctx: Ctx) {
  const gate = await hdAnyCapGate(["settings.manage", "agents.manage_team"]);
  if (gate instanceof NextResponse) return gate;
  const id = Number((await ctx.params).id);
  const s = Number.isInteger(id) && id > 0 && id < 2 ** 31 ? await getRecurring(id) : undefined;
  if (!s || !(await canManageRecurringTeam(gate, s.team_id))) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return { user: gate as SessionUser, s };
}

export async function GET(_req: Request, ctx: Ctx) {
  const l = await load(ctx);
  if (l instanceof NextResponse) return l;
  return NextResponse.json({ schedule: l.s });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const l = await load(ctx);
  if (l instanceof NextResponse) return l;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });
  try {
    if (body.discard_draft === true) {
      const gone = await discardRecurringDraft(l.s.id, body.draft_at);
      if (!gone) return NextResponse.json({ error: "There are no changes waiting on this schedule." }, { status: 409 });
      await auditRecurring(req, l.user, "helpdesk.recurring.draft_discarded", l.s.id, scheduleTitle(l.s.subject), { drafted_by: gone.draft_by_name, drafted_via: gone.draft_via });
      return NextResponse.json({ schedule: await getRecurring(l.s.id) });
    }
    if (typeof body.team_id === "number" && body.team_id !== l.s.team_id && !(await canManageRecurringTeam(l.user, body.team_id))) {
      return NextResponse.json({ error: "You can only schedule tickets for teams you lead." }, { status: 403 });
    }
    const fields = { ...body };
    for (const k of ["publish", "publish_draft", "draft_at", "discard_draft"]) delete fields[k];
    const r = await saveRecurring(l.s.id, fields, {
      publish: body.publish === true,
      publishDraft: body.publish_draft === true,
      draftAt: body.draft_at,
      // A draft's changes may name another team: the person must manage that one too.
      mayUseTeam: (teamId) => canManageRecurringTeam(l.user, teamId),
    });
    if (!r) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const schedule = r.after;
    if (r.published) {
      const changed = (["team_id", "subject", "body", "priority", "request_type_id", "assign_mode", "assignee_id", "due_business_days", "pattern", "holiday_rule", "timezone", "enabled"] as const).filter(
        (k) => JSON.stringify(r.before[k]) !== JSON.stringify(schedule[k])
      );
      await auditRecurring(req, l.user, "helpdesk.recurring.published", schedule.id, scheduleTitle(schedule.subject), {
        changed,
        enabled: schedule.enabled,
        drafted_by: r.before.draft_by_name,
        drafted_via: r.before.draft_via,
      });
    } else {
      const changed = Object.keys(fields).filter((k) => JSON.stringify((r.before as unknown as Record<string, unknown>)[k]) !== JSON.stringify(fields[k]));
      await auditRecurring(req, l.user, "helpdesk.recurring.updated", schedule.id, scheduleTitle(schedule.subject), {
        changed,
        ...(schedule.published ? {} : { draft: true, published: false }),
      });
    }
    return NextResponse.json({ schedule });
  } catch (e) {
    if (e instanceof RecurringDraftError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const l = await load(ctx);
  if (l instanceof NextResponse) return l;
  await deleteRecurring(l.s.id);
  await auditRecurring(req, l.user, "helpdesk.recurring.deleted", l.s.id, scheduleTitle(l.s.subject), {
    team_id: l.s.team_id,
    ...(l.s.published === false ? { draft: true, published: false } : {}),
  });
  return NextResponse.json({ ok: true });
}
