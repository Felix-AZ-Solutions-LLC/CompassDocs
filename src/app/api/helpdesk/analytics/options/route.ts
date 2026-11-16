// GET /api/helpdesk/analytics/options → what the filter bar and the pickers offer the
// caller: { teams, agents, request_types, workflows, tags, categories, can: { export,
// share_everyone, set_default, manage_shared }, timezone, scope }
// Helpdesk 1.19.0 reports (agent K). Teams and agents are those of the
// caller's report scope; tags those seen on its tickets in the last year.
// 1.20.6: categories are the desk admin's list (lib/helpdesk/categories), in
// its order, archived ones included (old tickets still carry them).
// 1.20.23 review L1: request types and workflows are those of the caller's desk departments
// (and All departments'; lib/helpdesk/desk-departments), plus any that appear on tickets in the
// caller's report scope, so a report can still name what its tickets carry. Every one with an
// "all" report scope.

import { NextResponse } from "next/server";
import { hq } from "@/lib/helpdesk/db-core";
import { categoryTree } from "@/lib/helpdesk/categories";
import { deptVisibleSql, deskDepartmentScope, scopeParam } from "@/lib/helpdesk/desk-departments";
import { reportScope } from "@/lib/helpdesk/analytics/engine";
import { reportTimezone } from "@/lib/helpdesk/analytics/hours";
import { dashboardRights } from "@/lib/helpdesk/analytics/store";
import { NO_STORE, canExport, errorResponse, reportsGate } from "@/lib/helpdesk/analytics/http";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await reportsGate();
  if (gate instanceof NextResponse) return gate;
  try {
    const [scope, rights, exp, timezone] = await Promise.all([reportScope(gate), dashboardRights(gate), canExport(gate), reportTimezone()]);
    if (!scope) return NextResponse.json({ error: "You don't have permission to read reports." }, { status: 403 });
    const teamIds = scope.kind === "all" ? null : scope.kind === "teams" ? scope.teams : rights.teams;
    const ticketScope =
      scope.kind === "all" ? "TRUE" : scope.kind === "own" ? "t.assignee_id = $2" : scope.own ? "(t.team_id = ANY($1::int[]) OR t.assignee_id = $2)" : "t.team_id = ANY($1::int[])";
    const p = [teamIds ?? [], gate.id];
    // Review L1: types and workflows by desk department, or on a ticket in scope ($2 teams, $3 the caller).
    const depts = scope.kind === "all" ? null : scopeParam(await deskDepartmentScope(gate));
    const inScope =
      scope.kind === "all" ? "TRUE" : scope.kind === "own" ? "t.assignee_id = $3" : scope.own ? "(t.team_id = ANY($2::int[]) OR t.assignee_id = $3)" : "t.team_id = ANY($2::int[])";
    const typed = "$2::int[] IS NOT NULL AND $3::int IS NOT NULL";
    const p3 = [depts, teamIds ?? [], gate.id];
    const [teams, agents, types, workflows, tags, categories] = await Promise.all([
      hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams WHERE ($1::int[] IS NULL OR id = ANY($1::int[])) ORDER BY position, name", [teamIds]),
      scope.kind === "own"
        ? hq<{ id: number; name: string }>("SELECT id, COALESCE(NULLIF(name, ''), username) AS name FROM users WHERE id = $1", [gate.id])
        : hq<{ id: number; name: string }>(
            `SELECT DISTINCT u.id, COALESCE(NULLIF(u.name, ''), u.username) AS name FROM hd_team_members m JOIN users u ON u.id = m.user_id
              WHERE ($1::int[] IS NULL OR m.team_id = ANY($1::int[])) ORDER BY 2 LIMIT 500`,
            [teamIds]
          ),
      hq<{ id: number; name: string }>(
        `SELECT rt.id, rt.title AS name FROM hd_request_types rt
          WHERE ${deptVisibleSql("rt.desk_department_id", 1)}
             OR EXISTS (SELECT 1 FROM hd_tickets t WHERE t.request_type_id = rt.id AND t.deleted_at IS NULL AND ${inScope} AND ${typed})
          ORDER BY rt.position, rt.title LIMIT 500`,
        p3
      ),
      hq<{ id: number; name: string }>(
        `SELECT w.id, w.title AS name FROM hd_workflows w
          WHERE ${deptVisibleSql("w.desk_department_id", 1)}
             OR EXISTS (SELECT 1 FROM hd_workflow_runs r JOIN hd_tickets t ON t.id = r.ticket_id WHERE r.workflow_id = w.id AND t.deleted_at IS NULL AND ${inScope} AND ${typed})
          ORDER BY w.title LIMIT 500`,
        p3
      ),
      hq<{ v: string }>(
        `SELECT DISTINCT tg AS v FROM hd_tickets t CROSS JOIN LATERAL unnest(t.tags) tg
          WHERE t.created_at > now() - interval '365 days' AND t.deleted_at IS NULL AND ${ticketScope} AND $1::int[] IS NOT NULL AND $2::int IS NOT NULL ORDER BY 1 LIMIT 200`,
        p
      ),
      categoryTree().then((list) => list.map((c) => ({ v: c.name }))),
    ]);
    // Automated tickets (alerts, API: agent P's hd_tickets.automated) offer the "Include alerts" toggle.
    const auto = await hq<{ yes: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'hd_tickets' AND column_name = 'automated') AS yes"
    );
    const hasAutomated = auto[0]?.yes ? Boolean((await hq<{ yes: boolean }>("SELECT EXISTS (SELECT 1 FROM hd_tickets WHERE automated = 1) AS yes"))[0]?.yes) : false;
    return NextResponse.json(
      {
        has_automated: hasAutomated,
        teams,
        agents,
        request_types: types,
        workflows,
        tags: tags.map((r) => r.v),
        categories: categories.map((r) => r.v),
        can: { export: exp, share_everyone: rights.all || rights.team, set_default: rights.all, manage_shared: rights.all || rights.manager },
        scope: scope.kind,
        timezone,
        me: gate.id,
      },
      { headers: NO_STORE }
    );
  } catch (e) {
    return errorResponse(e);
  }
}
