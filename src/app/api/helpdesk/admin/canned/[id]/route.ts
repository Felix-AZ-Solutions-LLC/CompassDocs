// PATCH  /api/helpdesk/admin/canned/[id]   any of { title, body, folder, share, desk_department_id }
// DELETE /api/helpdesk/admin/canned/[id]
// Helpdesk 1.19.2 (agent W4). The caller needs the capability of the
// response's sharing and, when a PATCH changes it, of the new one too (see
// ../route.ts). Someone else's personal response, or one the caller can't
// see, is a 404. A PATCH writes only the fields sent, and only while the
// sharing is still the one checked (a concurrent move is a 409). Audited as
// helpdesk.canned.updated (the fields that really changed) / .deleted.
// 1.20.23: and its desk department, before and after, must be one they manage (canned
// mayManageCanned); another department's response is a 404. A move between departments is also
// audited as helpdesk.desk_department.item_moved.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { agentTeamIds, readJson } from "@/lib/helpdesk/access";
import { HD_FORBIDDEN, hdAnyCapGate, hdCan } from "@/lib/helpdesk/roles";
import {
  CANNED_MANAGE_CAPS,
  CannedError,
  changedFields,
  cannedScope,
  cannedVisibleTo,
  deleteCanned,
  getCanned,
  mayManageCanned,
  updateCanned,
  validateCannedInput,
} from "@/lib/helpdesk/canned";
import type { HdCanned } from "@/lib/helpdesk/canned-shared";
import {
  auditItemDeskDepartment,
  deskDepartmentAccess,
  guardDeptRace,
  resolveDeskDepartmentField,
  teamDeskDepartmentId,
  type DeskDepartmentAccess,
} from "@/lib/helpdesk/desk-departments";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function load(ctx: Ctx, user: SessionUser, access: DeskDepartmentAccess): Promise<HdCanned | null> {
  const c = await getCanned(Number((await ctx.params).id));
  if (!c) return null;
  const teams = (await hdCan(user, "macros.manage_all")) || access.admin || access.departmentManager ? "all" : await agentTeamIds(user);
  if (!cannedVisibleTo(c, user.id, teams, null, access.scope)) return null;
  // A team's response outside the caller's desk departments (seen only through "all" teams above) is not theirs to open.
  if (!c.owner_id && c.team_id && c.desk_department_id != null && access.scope !== "all" && !access.scope.includes(c.desk_department_id)) return null;
  return c;
}

const NOT_FOUND = () => NextResponse.json({ error: "Canned response not found." }, { status: 404 });

async function patchHandler(req: Request, ctx: Ctx) {
  const gate = await hdAnyCapGate(CANNED_MANAGE_CAPS);
  if (gate instanceof NextResponse) return gate;
  const access = await deskDepartmentAccess(gate, "canned");
  const cur = await load(ctx, gate, access);
  if (!cur) return NOT_FOUND();
  const body = await readJson(req, 64 * 1024);
  if (!body) return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });
  try {
    const patch = await validateCannedInput(body, gate.id, true);
    // Moving a personal response keeps its owner only when it stays personal.
    const owner_id = patch.owner_id !== undefined ? patch.owner_id : cur.owner_id;
    const team_id = owner_id ? null : patch.team_id !== undefined ? patch.team_id : cur.team_id;
    let dept: number | null = null;
    if (!owner_id) {
      if (team_id) dept = await teamDeskDepartmentId(team_id);
      else {
        const d = await resolveDeskDepartmentField(access, body.desk_department_id, cur.owner_id ? undefined : (cur.desk_department_id ?? null));
        if (!d.ok) return NextResponse.json({ error: d.error, code: "desk_department" }, { status: d.status });
        dept = d.value;
      }
    }
    const next = { owner_id, team_id, desk_department_id: dept };
    if (!(await mayManageCanned(gate, cur, access)) || !(await mayManageCanned(gate, next, access))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
    if (!owner_id) patch.desk_department_id = dept;
    // Review L3: guarded on the department read too, so a stale save never reverts an Admin's move.
    const c = await updateCanned(cur.id, patch, { owner_id: cur.owner_id, team_id: cur.team_id, desk_department_id: cur.desk_department_id ?? null });
    if (!c) return NOT_FOUND();
    const changed = changedFields(cur, c);
    if (!changed.length) return NextResponse.json({ canned: { ...c, can_edit: await mayManageCanned(gate, c, access) } });
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.canned.updated",
      targetType: "helpdesk_canned",
      targetId: c.id,
      targetLabel: c.title,
      details: {
        changed,
        scope: cannedScope(c),
        team_id: c.team_id,
        ...(cannedScope(cur) !== cannedScope(c) || cur.team_id !== c.team_id ? { from_scope: cannedScope(cur), from_team_id: cur.team_id } : {}),
      },
      ip: ipFrom(req),
    });
    if (!cur.owner_id && !c.owner_id) {
      await auditItemDeskDepartment(gate, "canned", { id: c.id, label: c.title }, cur.desk_department_id ?? null, c.desk_department_id ?? null, ipFrom(req));
    }
    return NextResponse.json({ canned: { ...c, can_edit: await mayManageCanned(gate, c, access) } });
  } catch (e) {
    if (e instanceof CannedError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await hdAnyCapGate(CANNED_MANAGE_CAPS);
  if (gate instanceof NextResponse) return gate;
  const access = await deskDepartmentAccess(gate, "canned");
  const cur = await load(ctx, gate, access);
  if (!cur) return NOT_FOUND();
  if (!(await mayManageCanned(gate, cur, access))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  const gone = await deleteCanned(cur.id);
  if (!gone) return NOT_FOUND();
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.canned.deleted",
    targetType: "helpdesk_canned",
    targetId: gone.id,
    targetLabel: gone.title,
    details: { scope: cannedScope(gone), team_id: gone.team_id },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

// 1.20.23 review L3: a save racing a desk department's deletion answers 409 with a sentence.
export const PATCH = guardDeptRace(patchHandler);
