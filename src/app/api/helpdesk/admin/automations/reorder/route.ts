// POST /api/helpdesk/admin/automations/reorder   { ids: number[] }  the run order, first to last
// Helpdesk 1.19.0 (automations.manage, agent J's capability). Every automation must be named once.
// Audited as helpdesk.automation.reordered.
// 1.20.23 (lib/helpdesk/desk-departments): every automation the caller manages must be named once
// (a desk Admin: every automation, as before). Their rules swap places among the positions they
// already hold, so the order of the rules they can't change (other departments', All
// departments') is never touched. "Manage a desk department" may reorder the rules of their own teams' departments (review M3).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { withTx } from "@/lib/helpdesk/db-core";
import { listAutomations } from "@/lib/helpdesk/automations";
import { deskDepartmentGate, mayManageDept, maySeeDept } from "@/lib/helpdesk/desk-departments";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await deskDepartmentGate("automations");
  if (g instanceof NextResponse) return g;
  const body = await readJson<{ ids?: unknown }>(req, 16 * 1024);
  const ids = Array.isArray(body?.ids) ? body.ids.map(Number) : null;
  const all = await listAutomations();
  const mine = all.filter((a) => mayManageDept(g.access, a.desk_department_id));
  if (!ids || ids.length !== mine.length || new Set(ids).size !== ids.length || !mine.every((a) => ids.includes(a.id))) {
    return NextResponse.json({ error: "Send the id of every automation you manage once, in the new order." }, { status: 400 });
  }
  await withTx(async (client) => {
    if (mine.length === all.length) {
      for (const [i, id] of ids.entries()) await client.query("UPDATE hd_automations SET position = $2, updated_at = now() WHERE id = $1", [id, i]);
      return;
    }
    // The positions their rules hold now, in run order, given out again in the order they sent. Only when two
    // rules share a position (ties run by id) are everyone's renumbered in run order first, so the slots are
    // distinct; the run order of the rules they don't manage never changes.
    let order = all;
    if (new Set(all.map((a) => a.position)).size !== all.length) {
      for (const [i, a] of all.entries()) await client.query("UPDATE hd_automations SET position = $2 WHERE id = $1 AND position <> $2", [a.id, i]);
      order = all.map((a, i) => ({ ...a, position: i }));
    }
    const slots = order.filter((a) => mine.some((m) => m.id === a.id)).map((a) => a.position);
    for (const [i, id] of ids.entries()) await client.query("UPDATE hd_automations SET position = $2, updated_at = now() WHERE id = $1", [id, slots[i]]);
  });
  await audit({
    actor: actorFrom(g.user),
    action: "helpdesk.automation.reordered",
    targetType: "helpdesk_automation",
    details: { ids },
    ip: ipFrom(req),
  });
  return NextResponse.json({ automations: (await listAutomations()).filter((a) => maySeeDept(g.access, a.desk_department_id)) });
}
