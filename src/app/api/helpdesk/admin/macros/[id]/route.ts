// GET    /api/helpdesk/admin/macros/[id]
// PATCH  /api/helpdesk/admin/macros/[id]   any of { title, body, actions, team_id, personal, desk_department_id }
// DELETE /api/helpdesk/admin/macros/[id]
// Helpdesk 1.19.0. The caller needs the capability of the macro's scope
// (and, when a PATCH moves it, of the new one): see ../route.ts. Someone
// else's personal macro is a 404. Audited as helpdesk.macro.updated /
// .deleted. An automation that sends a deleted macro skips that step.
// 1.20.23: and the macro's desk department must be one they manage, before and after (macros
// macroManageable); another department's macro they can't see is a 404, an All departments one
// they see is a 403 unless desk Admin. A move between departments is also audited as
// helpdesk.desk_department.item_moved.
// Review M3/M4/L3: managing means a department of the caller's own teams. A move that would leave
// an automation of another department sending it answers 409 { code: "desk_department_dependents",
// dependents }. The write is guarded on the sharing read (department, team, owner): if an Admin
// moved it meanwhile, 409 { code: "changed" } and nothing is saved.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { HD_FORBIDDEN, hdAnyCapGate } from "@/lib/helpdesk/roles";
import { MACRO_MOVED_MEANWHILE, deleteMacro, getMacro, macroManageable, updateMacro, validateMacroInput, type HdMacroRow } from "@/lib/helpdesk/macros";
import {
  auditItemDeskDepartment,
  deskDepartmentAccess,
  guardDeptRace,
  maySeeDept,
  moveRefusal,
  resolveDeskDepartmentField,
  teamDeskDepartmentId,
  type DeskDepartmentAccess,
} from "@/lib/helpdesk/desk-departments";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const MANAGE_CAPS = ["macros.manage_personal", "macros.manage_team", "macros.manage_all", "departments.manage"] as const;

async function load(ctx: Ctx, user: SessionUser, access: DeskDepartmentAccess): Promise<HdMacroRow | null> {
  const n = Number((await ctx.params).id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const m = await getMacro(n);
  if (!m || (m.owner_id && m.owner_id !== user.id)) return null;
  if (!m.owner_id && !maySeeDept(access, m.desk_department_id)) return null;
  return m;
}

export async function GET(_req: Request, ctx: Ctx) {
  const gate = await hdAnyCapGate([...MANAGE_CAPS]);
  if (gate instanceof NextResponse) return gate;
  const access = await deskDepartmentAccess(gate, "macros");
  const macro = await load(ctx, gate, access);
  if (!macro) return NextResponse.json({ error: "Macro not found." }, { status: 404 });
  return NextResponse.json({ macro: { ...macro, can_edit: await macroManageable(gate, access, macro) } });
}

async function patchHandler(req: Request, ctx: Ctx) {
  const gate = await hdAnyCapGate([...MANAGE_CAPS]);
  if (gate instanceof NextResponse) return gate;
  const access = await deskDepartmentAccess(gate, "macros");
  const cur = await load(ctx, gate, access);
  if (!cur) return NextResponse.json({ error: "Macro not found." }, { status: 404 });
  const body = await readJson(req, 64 * 1024);
  if (!body) return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });
  const input = await validateMacroInput(body, true);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  const { personal, ...patch } = input.value;
  const owner_id = personal === undefined ? cur.owner_id : personal ? gate.id : null;
  const team_id = owner_id ? null : patch.team_id !== undefined ? patch.team_id : cur.team_id;
  let dept: number | null = null;
  if (!owner_id) {
    if (team_id) dept = await teamDeskDepartmentId(team_id);
    else {
      // A personal macro being shared starts where a new one would; otherwise it stays unless the body moves it.
      const d = await resolveDeskDepartmentField(access, body.desk_department_id, cur.owner_id ? undefined : (cur.desk_department_id ?? null));
      if (!d.ok) return NextResponse.json({ error: d.error, code: "desk_department" }, { status: d.status });
      dept = d.value;
    }
  }
  const next = { owner_id, team_id, desk_department_id: dept };
  if (!(await macroManageable(gate, access, cur)) || !(await macroManageable(gate, access, next))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  // Review M4 (a): a move that would leave an automation sending it from another department is refused, with the list.
  if (!cur.owner_id && !owner_id) {
    const blocked = await moveRefusal("macros", cur.id, cur.desk_department_id ?? null, dept);
    if (blocked) return blocked;
  }
  // Review L3: only while it is still shared as checked above.
  const macro = await updateMacro(
    cur.id,
    { ...patch, team_id, owner_id, desk_department_id: dept },
    { desk_department_id: cur.desk_department_id ?? null, team_id: cur.team_id ?? null, owner_id: cur.owner_id ?? null }
  );
  if (macro === "changed") return NextResponse.json({ error: MACRO_MOVED_MEANWHILE, code: "changed" }, { status: 409 });
  if (!macro) return NextResponse.json({ error: "Macro not found." }, { status: 404 });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.macro.updated",
    targetType: "helpdesk_macro",
    targetId: macro.id,
    targetLabel: macro.title,
    details: { changed: Object.keys(input.value), scope: owner_id ? "personal" : macro.team_id ? "team" : "everyone", team_id: macro.team_id },
    ip: ipFrom(req),
  });
  if (!cur.owner_id && !owner_id) {
    await auditItemDeskDepartment(gate, "macros", { id: macro.id, label: macro.title }, cur.desk_department_id ?? null, macro.desk_department_id ?? null, ipFrom(req));
  }
  return NextResponse.json({ macro });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await hdAnyCapGate([...MANAGE_CAPS]);
  if (gate instanceof NextResponse) return gate;
  const access = await deskDepartmentAccess(gate, "macros");
  const cur = await load(ctx, gate, access);
  if (!cur) return NextResponse.json({ error: "Macro not found." }, { status: 404 });
  if (!(await macroManageable(gate, access, cur))) return NextResponse.json({ error: HD_FORBIDDEN }, { status: 403 });
  const gone = await deleteMacro(cur.id);
  if (!gone) return NextResponse.json({ error: "Macro not found." }, { status: 404 });
  await audit({
    actor: actorFrom(gate),
    action: "helpdesk.macro.deleted",
    targetType: "helpdesk_macro",
    targetId: gone.id,
    targetLabel: gone.title,
    details: { scope: gone.owner_id ? "personal" : gone.team_id ? "team" : "everyone" },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true });
}

// 1.20.23 review L3: a save racing a desk department's deletion answers 409 with a sentence.
export const PATCH = guardDeptRace(patchHandler);
