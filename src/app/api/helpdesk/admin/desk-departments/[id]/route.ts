// PATCH  /api/helpdesk/admin/desk-departments/[id]   { name } → { department }
// DELETE /api/helpdesk/admin/desk-departments/[id]?move_content_to=<id> → { ok, moved, to }
// Helpdesk 1.20.23 (lib/helpdesk/desk-departments), desk Admin only (settings.manage).
// Delete is refused with a sentence (409) for the default department ("General" unless renamed)
// and while any team is in it (move the teams first: a team is always in a department). Content
// still in it is refused too, unless move_content_to names another department, which then takes
// its macros, canned responses, checklists, workflows, request types and automations in the same
// transaction. Audited helpdesk.desk_department.renamed / .deleted (with what moved where).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { badRequest, notFound } from "@/lib/helpdesk/routes";
import { DeskDepartmentError, deleteDeskDepartment, renameDeskDepartment } from "@/lib/helpdesk/desk-departments";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const idOf = (raw: string) => (/^\d{1,9}$/.test(raw) ? Number(raw) : null);

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await ctx.params).id);
  if (id === null) return notFound();
  const b = await readJson(req, 4 * 1024);
  if (!b) return badRequest("Send the changes as JSON.");
  try {
    const { before, after } = await renameDeskDepartment(id, b.name);
    if (before.name !== after.name) {
      await audit({
        actor: actorFrom(gate),
        action: "helpdesk.desk_department.renamed",
        targetType: "helpdesk_desk_department",
        targetId: id,
        targetLabel: after.name,
        details: { from: before.name, to: after.name },
        ip: ipFrom(req),
      });
    }
    return NextResponse.json({ department: after });
  } catch (e) {
    if (e instanceof DeskDepartmentError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const id = idOf((await ctx.params).id);
  if (id === null) return notFound();
  const raw = new URL(req.url).searchParams.get("move_content_to");
  const moveTo = raw ? idOf(raw) : null;
  if (raw && moveTo === null) return badRequest("move_content_to is a desk department's id.");
  try {
    const r = await deleteDeskDepartment(id, moveTo);
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.desk_department.deleted",
      targetType: "helpdesk_desk_department",
      targetId: id,
      targetLabel: r.department.name,
      details: { ...(r.to ? { moved_to_id: r.to.id, moved_to: r.to.name, moved: r.moved } : {}) },
      ip: ipFrom(req),
    });
    return NextResponse.json({ ok: true, moved: r.to ? r.moved : null, to: r.to });
  } catch (e) {
    if (e instanceof DeskDepartmentError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
