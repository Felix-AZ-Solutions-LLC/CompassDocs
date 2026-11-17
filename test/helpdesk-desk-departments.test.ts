// Helpdesk 1.20.23: desk departments (lib/helpdesk/desk-departments).
//
//   upgrade     a database from before departments: one "General" default
//               department holds every team and every shared item; personal
//               macros and canned responses carry none; a second and third
//               boot change nothing (own database, child-process boots)
//   invariant   a team is in exactly one department (NOT NULL, FK RESTRICT);
//               new rows land in the default department, never All; the
//               default can't be deleted; names are unique whatever the case
//   visibility  agents see and use their departments' and All departments'
//               macros, canned responses, checklists and request types /
//               workflows; another department's by id is refused on every
//               path: the desk's routes, the Claude connector (MCP), Claude in
//               the desk's tools, Start a workflow, New ticket; admins and
//               every-team agents see all; API v1 /me names the departments
//   managing    "Manage a desk department" (matrix v6) manages its holder's
//               departments' content and never All departments; a feature
//               capability alone is limited to one's departments; recurring
//               tickets follow their team's department
//   matrix      v6 lifts the capability onto a customised Manager column
//   automations a ticket meets its team's department's rules and All
//               departments'; no team: the default department's; a rule that
//               routes it hands the rest of the run to the new department
//   team move   the team's own team macros go along, nothing else; its tickets
//               meet the new department's rules; agents' visibility follows;
//               audited; Admin only
//   delete      refused with teams, with content unless moved, for the default
//
// Parallel-safe: every account, team, department and item is this file's own
// (STAMP); rules match only this file's keyword; the role matrix is set for
// this process only.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-desk-departments.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { pool, getSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

let currentRequest: Request | null = null;
function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-dd.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-dd.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
const edition = { present: true, features: ["helpdesk"] as string[] };
{
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const jar = cookieJar();
      return {
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
      };
    },
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;
  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = { ee: () => edition, eePresent: () => true, featureEnabled: async (f: string) => edition.features.includes(f), featureEnforced: async (f: string) => edition.features.includes(f) };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as { _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) return EE_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const dd = require("../src/lib/helpdesk/desk-departments") as typeof import("../src/lib/helpdesk/desk-departments");
const ddShared = require("../src/lib/helpdesk/desk-departments-shared") as typeof import("../src/lib/helpdesk/desk-departments-shared");
const { HD_DESK_DEPARTMENTS_SCHEMA } = require("../src/lib/helpdesk/desk-departments-schema") as typeof import("../src/lib/helpdesk/desk-departments-schema");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const rolesShared = require("../src/lib/helpdesk/roles-shared") as typeof import("../src/lib/helpdesk/roles-shared");
const macros = require("../src/lib/helpdesk/macros") as typeof import("../src/lib/helpdesk/macros");
const canned = require("../src/lib/helpdesk/canned") as typeof import("../src/lib/helpdesk/canned");
const checklists = require("../src/lib/helpdesk/checklists") as typeof import("../src/lib/helpdesk/checklists");
const automations = require("../src/lib/helpdesk/automations") as typeof import("../src/lib/helpdesk/automations");
const workflows = require("../src/lib/helpdesk/workflows") as typeof import("../src/lib/helpdesk/workflows");
const requestTypes = require("../src/lib/helpdesk/request-types") as typeof import("../src/lib/helpdesk/request-types");
const recurring = require("../src/lib/helpdesk/recurring") as typeof import("../src/lib/helpdesk/recurring");
const ws = require("../src/lib/helpdesk/workflow-start") as typeof import("../src/lib/helpdesk/workflow-start");
const notify = require("../src/lib/helpdesk/notify") as typeof import("../src/lib/helpdesk/notify");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const connector = require("../src/lib/helpdesk/claude-connector") as typeof import("../src/lib/helpdesk/claude-connector");
const hdTools = require("../src/lib/mcp/helpdesk-tools") as typeof import("../src/lib/mcp/helpdesk-tools");
const deskTools = require("../src/lib/helpdesk/claude/tools") as typeof import("../src/lib/helpdesk/claude/tools");
const claudeShared = require("../src/lib/helpdesk/claude/shared") as typeof import("../src/lib/helpdesk/claude/shared");
const apiV1 = require("../src/lib/helpdesk/api-v1") as typeof import("../src/lib/helpdesk/api-v1");
const auditLabels = require("../src/lib/audit-labels") as typeof import("../src/lib/audit-labels");
const { getUserById } = require("../src/lib/db") as typeof import("../src/lib/db");
const { toSessionUser } = require("../src/lib/auth") as typeof import("../src/lib/auth");
const access = require("../src/app/(desk)/desk-access") as typeof import("../src/app/(desk)/desk-access");
const deptRoute = require("../src/app/api/helpdesk/admin/desk-departments/route") as typeof import("../src/app/api/helpdesk/admin/desk-departments/route");
const deptIdRoute = require("../src/app/api/helpdesk/admin/desk-departments/[id]/route") as typeof import("../src/app/api/helpdesk/admin/desk-departments/[id]/route");
const deptTeamsRoute = require("../src/app/api/helpdesk/admin/desk-departments/[id]/teams/route") as typeof import("../src/app/api/helpdesk/admin/desk-departments/[id]/teams/route");
const choicesRoute = require("../src/app/api/helpdesk/desk-departments/route") as typeof import("../src/app/api/helpdesk/desk-departments/route");
const macrosRoute = require("../src/app/api/helpdesk/macros/route") as typeof import("../src/app/api/helpdesk/macros/route");
const adminMacrosRoute = require("../src/app/api/helpdesk/admin/macros/route") as typeof import("../src/app/api/helpdesk/admin/macros/route");
const macroApplyRoute = require("../src/app/api/helpdesk/tickets/[number]/macro/[macroId]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/macro/[macroId]/route");
const cannedRoute = require("../src/app/api/helpdesk/canned/route") as typeof import("../src/app/api/helpdesk/canned/route");
const cannedUseRoute = require("../src/app/api/helpdesk/canned/[id]/use/route") as typeof import("../src/app/api/helpdesk/canned/[id]/use/route");
const checklistLibRoute = require("../src/app/api/helpdesk/checklists/route") as typeof import("../src/app/api/helpdesk/checklists/route");
const ticketChecklistsRoute = require("../src/app/api/helpdesk/tickets/[number]/checklists/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/checklists/route");
const startRoute = require("../src/app/api/helpdesk/tickets/[number]/start-workflow/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/start-workflow/route");
const newTicketTypesRoute = require("../src/app/api/helpdesk/tickets/request-types/route") as typeof import("../src/app/api/helpdesk/tickets/request-types/route");
const autoRoute = require("../src/app/api/helpdesk/admin/automations/route") as typeof import("../src/app/api/helpdesk/admin/automations/route");
const autoIdRoute = require("../src/app/api/helpdesk/admin/automations/[id]/route") as typeof import("../src/app/api/helpdesk/admin/automations/[id]/route");
const autoReorderRoute = require("../src/app/api/helpdesk/admin/automations/reorder/route") as typeof import("../src/app/api/helpdesk/admin/automations/reorder/route");
const rtRoute = require("../src/app/api/helpdesk/admin/request-types/route") as typeof import("../src/app/api/helpdesk/admin/request-types/route");
const teamsRoute = require("../src/app/api/helpdesk/admin/teams/route") as typeof import("../src/app/api/helpdesk/admin/teams/route");
const macroIdRoute = require("../src/app/api/helpdesk/admin/macros/[id]/route") as typeof import("../src/app/api/helpdesk/admin/macros/[id]/route");
const wfRoute = require("../src/app/api/helpdesk/admin/workflows/route") as typeof import("../src/app/api/helpdesk/admin/workflows/route");
const wfIdRoute = require("../src/app/api/helpdesk/admin/workflows/[id]/route") as typeof import("../src/app/api/helpdesk/admin/workflows/[id]/route");
const rtIdRoute = require("../src/app/api/helpdesk/admin/request-types/[id]/route") as typeof import("../src/app/api/helpdesk/admin/request-types/[id]/route");
const clAdminRoute = require("../src/app/api/helpdesk/admin/checklists/route") as typeof import("../src/app/api/helpdesk/admin/checklists/route");
const clAdminIdRoute = require("../src/app/api/helpdesk/admin/checklists/[id]/route") as typeof import("../src/app/api/helpdesk/admin/checklists/[id]/route");
const recurringAdminRoute = require("../src/app/api/helpdesk/admin/recurring/route") as typeof import("../src/app/api/helpdesk/admin/recurring/route");
const recurringIdRoute = require("../src/app/api/helpdesk/admin/recurring/[id]/route") as typeof import("../src/app/api/helpdesk/admin/recurring/[id]/route");
const recurringRunRoute = require("../src/app/api/helpdesk/admin/recurring/[id]/run/route") as typeof import("../src/app/api/helpdesk/admin/recurring/[id]/run/route");
const recurringPreviewRoute = require("../src/app/api/helpdesk/admin/recurring/preview/route") as typeof import("../src/app/api/helpdesk/admin/recurring/preview/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdFormField, HdWorkflowStep } from "../src/lib/helpdesk/types";
import type { HdCap } from "../src/lib/helpdesk/roles-shared";

const STAMP = `hddd-${Date.now()}-${process.pid}`;
/** The word this file's rules match on (whole words), so they never touch another file's tickets. */
const KW = `ddkw${process.pid}x${Date.now().toString(36)}`;
const KW2 = `ddroute${process.pid}x${Date.now().toString(36)}`;
const IP = "203.0.113.223";
const CTX = { origin: "http://localhost", ip: IP };

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(handler: unknown, who: string, url: string, method = "GET", body?: unknown, params: Record<string, string> = {}) {
  currentRequest = new Request(`http://localhost/api/helpdesk${url}`, {
    method,
    headers: { cookie: `compass_session=${P[who].session}`, "content-type": "application/json", "x-forwarded-for": IP, host: "localhost" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const res = await (handler as Handler)(currentRequest, { params: Promise.resolve(params) });
    const raw = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* none */
    }
    return { status: res.status, body: json };
  } finally {
    currentRequest = null;
  }
}

// --- Fixtures ------------------------------------------------------------------------------

interface Person {
  id: number;
  name: string;
  email: string;
  session: string;
}
const P: Record<string, Person> = {};
const userIds: number[] = [];
const roleIds: number[] = [];
const ticketIds: number[] = [];
const D: Record<string, number> = {};
const T: Record<string, number> = {};
const M: Record<string, number> = {};
const C: Record<string, number> = {};
const CL: Record<string, number> = {};
const RT: Record<string, number> = {};
const WF: Record<string, number> = {};
const RULE: Record<string, number> = {};
const recurringIds: number[] = [];
let generalId = 0;

async function person(key: string, deskRole: string | null, teams: string[] = []) {
  const addr = `${STAMP}-${key}@example.test`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [`${STAMP}-${key}`, `${key} ${STAMP}`, addr]);
  const id = r.rows[0].id as number;
  userIds.push(id);
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  const role = await fixtureQuery("INSERT INTO roles (key, name) VALUES ($1, $1) RETURNING id", [`${STAMP}-req-${key}`]);
  roleIds.push(role.rows[0].id);
  await fixtureQuery("INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'helpdesk.request')", [role.rows[0].id]);
  await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [role.rows[0].id, id]);
  if (deskRole) await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [id, deskRole]);
  for (const tm of teams) await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [T[tm], id, deskRole === "team_lead" ? "lead" : "agent"]);
  P[key] = { id, name: `${key} ${STAMP}`, email: addr, session };
}

const user = async (who: string) => (await getUserById(P[who].id))!;
const session = async (who: string) => toSessionUser(await user(who));

async function tool(who: string, name: string, args: Record<string, unknown> = {}) {
  const r = (await hdTools.callHelpdeskTool(await user(who), name, args, CTX)) as { content: { text: string }[]; isError: boolean };
  const text = r.content[0]?.text ?? "";
  let out: any = null;
  try {
    out = JSON.parse(text);
  } catch {
    /* a sentence */
  }
  return { isError: r.isError, text, out };
}

const CFG = (): import("../src/lib/helpdesk/claude/shared").ClaudeDeskConfig => ({
  ...claudeShared.CLAUDE_DESK_DEFAULTS,
  enabled: true,
  teams_off: [],
  caps: { read: true, search: true, web: false, changes: true, drafts: true },
});
async function toolCtx(who: string, open: import("../src/lib/helpdesk/types").HdTicket | null) {
  const u = await user(who);
  return { user: u, session: toSessionUser(u), origin: "http://localhost", ip: IP, cfg: CFG(), chatId: 0, ticket: open, includeNotes: false, touched: new Set<number>(), notesSeen: [] as string[] };
}

async function raise(subject: string, team: string | null) {
  const who = P.req;
  const t = await tickets.createTicket(
    { subject: `${STAMP} ${subject}`, body: "Please help.", requester: { id: who.id, name: who.name, email: who.email }, team_id: team ? T[team] : null },
    { silent: true, actorId: who.id, actorName: who.name }
  );
  ticketIds.push(t.id);
  return (await tickets.getTicketById(t.id))!;
}

const WAIT: HdWorkflowStep[] = [{ key: "w", kind: "wait", title: "Give it a day", until: { after_hours: 24 } } as HdWorkflowStep];
const FORM: HdFormField[] = [{ key: "why", label: "Why", type: "text" }];

/** A request type with a published workflow, both in `dept` (or the workflow in `wfDept`). */
async function startable(key: string, dept: number | null, wfDept: number | null = dept) {
  const meta = await workflows.validateWorkflowMeta({ title: `${STAMP} ${key} flow` });
  assert.ok(meta.ok);
  const def = workflows.parseWorkflowDefinition({ trigger: {}, steps: WAIT });
  assert.ok(def.ok);
  const wf = await workflows.createWorkflow(meta.value, def.value, wfDept);
  WF[key] = wf.id;
  const input = await requestTypes.validateRequestTypeInput({ title: `${STAMP} ${key}`, team_id: T.A, form: FORM, workflow_id: wf.id, active: true });
  assert.ok(input.ok, !input.ok ? input.error : "");
  const rt = await requestTypes.createRequestType(input.value, dept);
  RT[key] = rt.id;
  const pub = await workflows.publishWorkflow(wf.id);
  assert.ok(pub.ok);
}

const titles = (list: { title: string }[]) => list.filter((m) => m.title.includes(STAMP)).map((m) => m.title.replace(STAMP, "").trim()).sort();
const auditRows = async (action: string, targetId?: number) =>
  (await pool().query(`SELECT details, actor_id FROM audit_log WHERE action = $1${targetId ? " AND target_id = $2" : ""} AND actor_id = ANY($${targetId ? 3 : 2}) ORDER BY id`, targetId ? [action, targetId, userIds] : [action, userIds]))
    .rows as { details: Record<string, unknown>; actor_id: number }[];

// The matrix for this process: the defaults, plus a Team lead column that holds "Manage a desk
// department", an Agent-like "dina" role (Newbie column) for the feature-capability case.
function matrix() {
  const Dm = rolesShared.HD_DEFAULT_MATRIX;
  return {
    ...Dm,
    team_lead: [...Dm.team_lead, "departments.manage"] as HdCap[],
    newbie: [...Dm.newbie.filter((c) => c !== "tickets.reply_needs_review"), "tickets.reply_public", "automations.manage"] as HdCap[],
  };
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(matrix());
  notify.setAgentDeliverySpyForTests(() => {});
  email.setHelpdeskTransportForTests(async () => {});
  connector.setClaudeLevelForTests("update");
  generalId = await dd.defaultDeskDepartmentId();
  D.IT = (await dd.createDeskDepartment(`${STAMP} IT`)).id;
  D.HR = (await dd.createDeskDepartment(`${STAMP} HR`)).id;
  for (const [k, dept] of [["A", D.IT], ["B", D.HR], ["G", generalId]] as const) {
    T[k] = (await fixtureQuery("INSERT INTO hd_teams (name, position, desk_department_id) VALUES ($1, 9480, $2) RETURNING id", [`${STAMP} ${k}`, dept])).rows[0].id;
  }
  await person("req", null);
  await person("admin", "admin");
  await person("mgr", "manager");
  await person("alice", "agent", ["A"]);
  await person("bob", "agent", ["B"]);
  await person("carol", "agent", ["A", "B"]);
  await person("lead", "team_lead", ["A"]);
  await person("fiona", "newbie", ["A"]);
  await person("mgrA", "manager", ["A"]);
  // Macros: each department's, All departments', a team's, the default department's, a personal one.
  const mk = async (key: string, dept: number | null | undefined, opts: { team?: string; owner?: string } = {}) => {
    M[key] = (
      await macros.createMacro(
        { title: `${key} ${STAMP}`, body: `Reply ${key}.`, actions: {}, team_id: opts.team ? T[opts.team] : null, owner_id: opts.owner ? P[opts.owner].id : null, desk_department_id: dept },
        null
      )
    ).id;
  };
  await mk("it", D.IT);
  await mk("hr", D.HR);
  await mk("shared", null);
  await mk("general", undefined);
  await mk("teamA", undefined, { team: "A" });
  await mk("teamB", undefined, { team: "B" });
  await mk("mine", D.HR, { owner: "alice" });
  const cn = async (key: string, dept: number | null | undefined) => {
    C[key] = (await canned.createCanned({ title: `${key} ${STAMP}`, body: `Canned ${key}.`, folder: "", owner_id: null, team_id: null, desk_department_id: dept }, null)).id;
  };
  await cn("it", D.IT);
  await cn("hr", D.HR);
  await cn("shared", null);
  const tpl = async (key: string, dept: number | null) => {
    CL[key] = (await checklists.createTemplate({ name: `${key} ${STAMP}`, items: [{ key: "i1", title: "Do it" }], request_type_ids: [] }, { id: null, name: "test" }, dept)).id;
  };
  await tpl("it", D.IT);
  await tpl("hr", D.HR);
  await tpl("shared", null);
  await startable("it", D.IT);
  await startable("hr", D.HR);
  await startable("shared", null);
  await startable("itTypeHrFlow", D.IT, D.HR);
});

after(async () => {
  notify.setAgentDeliverySpyForTests(null);
  email.setHelpdeskTransportForTests(null);
  connector.setClaudeLevelForTests(null);
  roles.setRoleMatrixForTests(null);
  const all = (await pool().query("SELECT id FROM hd_tickets WHERE id = ANY($1) OR requester_id = ANY($2)", [ticketIds, userIds])).rows.map((r) => r.id as number);
  await pool().query("UPDATE hd_tickets SET workflow_run_id = NULL, parent_ticket_id = NULL WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_workflow_runs WHERE ticket_id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_recurring WHERE id = ANY($1)", [recurringIds]);
  await pool().query("DELETE FROM hd_automations WHERE name LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM hd_macros WHERE title LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM hd_canned_responses WHERE title LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM hd_checklist_templates WHERE name LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM hd_request_types WHERE title LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM hd_workflows WHERE title LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM hd_teams WHERE name LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM hd_desk_departments WHERE name LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// --- Upgrade --------------------------------------------------------------------------------

describe("upgrade: one General department holds everything, and a second boot changes nothing", () => {
  const BASE = process.env.DATABASE_URL ?? "";
  const DB = `compass_deskdept_${process.pid}`;
  const urlFor = (db: string) => {
    const u = new URL(BASE);
    u.pathname = `/${db}`;
    return u.toString();
  };
  const boot = () => {
    const r = spawnSync(process.execPath, [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "--tsconfig", "tsconfig.test.json", "test/support/boot.ts"], {
      env: { ...process.env, DATABASE_URL: urlFor(DB), COMPASSDOCS_ADMIN_USER: "dd_admin", COMPASSDOCS_ADMIN_PASSWORD: "DeskDept!12345" },
      encoding: "utf8",
      timeout: 180_000,
    });
    return { ok: r.status === 0, out: `${r.stdout}\n${r.stderr}` };
  };
  const admin = async <X,>(fn: (c: Client) => Promise<X>) => {
    const c = new Client({ connectionString: BASE });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  let db: Client;

  before(async () => {
    await admin((c) => c.query(`CREATE DATABASE ${DB}`));
    const first = boot();
    assert.ok(first.ok, `fresh boot:\n${first.out}`);
    db = new Client({ connectionString: urlFor(DB) });
    await db.connect();
  });
  after(async () => {
    await db?.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`));
  });

  test("a new desk starts with General, the default", async () => {
    const r = await db.query("SELECT name, is_default FROM hd_desk_departments");
    assert.deepEqual(r.rows, [{ name: "General", is_default: true }]);
  });

  test("a 1.20.22 database: every team and shared item lands in General, personal ones in none; boots after that change nothing", async () => {
    // Shape the database as 1.20.22 left it: no departments anywhere.
    for (const t of ["hd_teams", "hd_macros", "hd_canned_responses", "hd_checklist_templates", "hd_workflows", "hd_request_types", "hd_automations"]) {
      await db.query(`ALTER TABLE ${t} DROP COLUMN desk_department_id`);
    }
    await db.query("DROP FUNCTION hd_default_desk_department()");
    await db.query("DROP TABLE hd_desk_departments");
    const owner = (await db.query("INSERT INTO users (username, name, email, role) VALUES ('dd-owner', 'Owner', 'dd-owner@example.test', 'viewer') RETURNING id")).rows[0].id;
    const teams = (await db.query("INSERT INTO hd_teams (name) VALUES ('IT'), ('HR') RETURNING id")).rows.map((r) => r.id);
    await db.query("INSERT INTO hd_macros (title, team_id) VALUES ('everyone', NULL), ('team', $1)", [teams[0]]);
    await db.query("INSERT INTO hd_macros (title, owner_id) VALUES ('personal', $1)", [owner]);
    await db.query("INSERT INTO hd_canned_responses (title, body) VALUES ('workspace', 'x')");
    await db.query("INSERT INTO hd_canned_responses (title, body, owner_id) VALUES ('personal', 'x', $1)", [owner]);
    await db.query("INSERT INTO hd_checklist_templates (name) VALUES ('list')");
    await db.query("INSERT INTO hd_workflows (slug, title) VALUES ('dd-flow', 'Flow')");
    await db.query("INSERT INTO hd_request_types (slug, title) VALUES ('dd-type', 'Type')");
    await db.query("INSERT INTO hd_automations (name, event) VALUES ('rule', 'ticket_created')");

    const second = boot();
    assert.ok(second.ok, `upgrade boot:\n${second.out}`);
    const deps = (await db.query("SELECT id, name, is_default FROM hd_desk_departments")).rows;
    assert.equal(deps.length, 1);
    assert.deepEqual({ name: deps[0].name, is_default: deps[0].is_default }, { name: "General", is_default: true });
    const general = deps[0].id;
    assert.deepEqual((await db.query("SELECT DISTINCT desk_department_id AS d FROM hd_teams")).rows, [{ d: general }], "every team in General");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM hd_teams WHERE desk_department_id IS NULL")).rows[0].n, 0);
    const macroDepts = Object.fromEntries((await db.query("SELECT title, desk_department_id FROM hd_macros")).rows.map((r) => [r.title, r.desk_department_id]));
    assert.deepEqual(macroDepts, { everyone: general, team: general, personal: null });
    const cannedDepts = Object.fromEntries((await db.query("SELECT title, desk_department_id FROM hd_canned_responses")).rows.map((r) => [r.title, r.desk_department_id]));
    assert.deepEqual(cannedDepts, { workspace: general, personal: null });
    for (const t of ["hd_checklist_templates", "hd_workflows", "hd_request_types", "hd_automations"]) {
      assert.deepEqual((await db.query(`SELECT DISTINCT desk_department_id AS d FROM ${t}`)).rows, [{ d: general }], `${t} in General`);
    }
    // New rows that name no department (an import, the starter set, an older binary) land in General, never All departments.
    await db.query("INSERT INTO hd_teams (name) VALUES ('Facilities')");
    await db.query("INSERT INTO hd_macros (title) VALUES ('later')");
    assert.equal((await db.query("SELECT desk_department_id AS d FROM hd_teams WHERE name = 'Facilities'")).rows[0].d, general);
    assert.equal((await db.query("SELECT desk_department_id AS d FROM hd_macros WHERE title = 'later'")).rows[0].d, general);

    const snap = async () => JSON.stringify((await db.query("SELECT 'm' AS k, id, desk_department_id FROM hd_macros UNION ALL SELECT 't', id, desk_department_id FROM hd_teams ORDER BY 1, 2")).rows);
    const before3 = await snap();
    const third = boot();
    assert.ok(third.ok, `third boot:\n${third.out}`);
    assert.equal(await snap(), before3, "the third boot changes nothing");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM hd_desk_departments")).rows[0].n, 1, "General is made once");
  });

  test("the schema: guarded, every reference RESTRICT, the function a STABLE default", () => {
    assert.match(HD_DESK_DEPARTMENTS_SCHEMA, /CREATE OR REPLACE FUNCTION hd_default_desk_department\(\) RETURNS integer LANGUAGE sql STABLE/);
    const adds = HD_DESK_DEPARTMENTS_SCHEMA.match(/ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS desk_department_id[^;]+;/g) ?? [];
    assert.equal(adds.length, 7);
    for (const a of adds) assert.match(a, /DEFAULT hd_default_desk_department\(\) REFERENCES hd_desk_departments\(id\) ON DELETE RESTRICT/);
    assert.match(adds.find((a) => a.includes("hd_teams")) ?? "", /integer NOT NULL DEFAULT/, "a team's department is never NULL");
  });
});

// --- The invariant -------------------------------------------------------------------------

describe("a team is in exactly one desk department", () => {
  test("never NULL, never a department that is gone; a new team without one is in the default", async () => {
    await assert.rejects(pool().query("UPDATE hd_teams SET desk_department_id = NULL WHERE id = $1", [T.A]), /null value/);
    await assert.rejects(pool().query("DELETE FROM hd_desk_departments WHERE id = $1", [D.IT]), (e: { code?: string }) => e.code === "23503", "RESTRICT");
    const r = await call(teamsRoute.POST, "admin", "/admin/teams", "POST", { name: `${STAMP} New` });
    assert.equal(r.status, 201);
    assert.equal(r.body.team.desk_department_id, generalId);
    const named = await call(teamsRoute.POST, "admin", "/admin/teams", "POST", { name: `${STAMP} New HR`, desk_department_id: D.HR });
    assert.equal(named.status, 201);
    assert.equal(named.body.team.desk_department_id, D.HR);
    // A Manager (teams.manage) creates teams, but only a desk Admin says which department.
    const mgr = await call(teamsRoute.POST, "mgr", "/admin/teams", "POST", { name: `${STAMP} New mgr`, desk_department_id: D.HR });
    assert.equal(mgr.status, 403);
  });

  test("names are unique whatever their case, and All departments is not a name", async () => {
    const dup = await call(deptRoute.POST, "admin", "/admin/desk-departments", "POST", { name: `${STAMP} it` });
    assert.equal(dup.status, 409);
    const all = await call(deptRoute.POST, "admin", "/admin/desk-departments", "POST", { name: "all departments" });
    assert.equal(all.status, 400);
    assert.equal(ddShared.checkDeskDepartmentName("  ").ok, false);
  });

  test("only a desk Admin manages departments", async () => {
    for (const who of ["mgr", "lead", "alice"]) {
      assert.equal((await call(deptRoute.GET, who, "/admin/desk-departments")).status, 403, who);
      assert.equal((await call(deptRoute.POST, who, "/admin/desk-departments", "POST", { name: `${STAMP} x ${who}` })).status, 403, who);
      assert.equal((await call(deptTeamsRoute.PUT, who, `/admin/desk-departments/${D.HR}/teams`, "PUT", { team_id: T.A }, { id: String(D.HR) })).status, 403, who);
    }
    const list = await call(deptRoute.GET, "admin", "/admin/desk-departments");
    assert.equal(list.status, 200);
    const it = list.body.departments.find((d: { id: number }) => d.id === D.IT);
    assert.deepEqual(it.teams.map((t: { id: number }) => t.id), [T.A]);
    assert.ok(it.counts.macros >= 2, "its macro and team A's");
    assert.equal(list.body.departments[0].is_default, true, "the default first");
    assert.equal(await access.canOpenSettings((await session("admin")) as never, "departments"), true);
    assert.equal(await access.canOpenSettings((await session("mgr")) as never, "departments"), false);
  });
});

// --- Visibility ------------------------------------------------------------------------------

describe("agents see and use their departments' content and All departments'", () => {
  test("whose departments: their teams'; every department for an Admin and for every-team agents", async () => {
    assert.deepEqual(await dd.deskDepartmentScope(await session("alice")), [D.IT]);
    assert.deepEqual((await dd.deskDepartmentScope(await session("carol"))) as number[], [D.IT, D.HR].sort((a, b) => a - b));
    assert.equal(await dd.deskDepartmentScope(await session("mgr")), "all", "a Manager sees every team's tickets");
    assert.equal(await dd.deskDepartmentScope(await session("admin")), "all");
    assert.deepEqual(await dd.deskDepartmentScope(await session("req")), [], "a requester is in none");
  });

  test("macros: the composer's list, and applying one by id", async () => {
    const list = async (who: string) => titles((await call(macrosRoute.GET, who, "/macros")).body.macros);
    assert.deepEqual(await list("alice"), ["it", "mine", "shared", "teamA"]);
    assert.deepEqual(await list("bob"), ["hr", "shared", "teamB"]);
    assert.deepEqual(await list("carol"), ["hr", "it", "shared", "teamA", "teamB"]);
    assert.deepEqual(await list("mgr"), ["general", "hr", "it", "shared", "teamA", "teamB"]);
    const t = await raise("macro apply", "A");
    const apply = (who: string, id: number) =>
      call(macroApplyRoute.POST, who, `/tickets/${t.number}/macro/${id}`, "POST", { preview: true }, { number: String(t.number), macroId: String(id) });
    assert.equal((await apply("alice", M.it)).status, 200);
    assert.equal((await apply("alice", M.shared)).status, 200);
    const refused = await apply("alice", M.hr);
    assert.equal(refused.status, 404, "another department's macro by id");
    assert.equal(refused.body.error, "Macro not found.");
    assert.equal((await apply("alice", M.general)).status, 404, "the default department's, which alice is not in");
    assert.equal((await apply("carol", M.hr)).status, 200, "carol is in both");
    assert.equal((await apply("mgr", M.general)).status, 200);
  });

  test("macros through the Claude connector and Claude in the desk", async () => {
    const t = await raise("macro mcp", "A");
    const listed = await tool("alice", "hd_list_macros", { number: t.number, limit: 50 });
    assert.equal(listed.isError, false, listed.text);
    const names = (listed.out.macros as { name: string }[]).map((m) => m.name).filter((n) => n.includes(STAMP));
    assert.ok(names.some((n) => n.startsWith("it ")) && !names.some((n) => n.startsWith("hr ")), names.join(", "));
    const applied = await tool("alice", "hd_apply_macro", { number: t.number, macro_id: M.hr });
    assert.equal(applied.isError, true, "the connector refuses another department's macro");
    const open = (await tickets.getTicketByNumber(t.number))!;
    const proposed = await deskTools.runDeskTool("propose_macro", { number: t.number, macro_id: M.hr }, await toolCtx("alice", open));
    assert.equal(proposed.isError, true);
    assert.match(proposed.content, /No macro with id/);
    const desk = await deskTools.runDeskTool("list_macros", { number: t.number }, await toolCtx("alice", open));
    assert.equal(desk.isError, false);
    assert.ok(desk.content.includes(`it ${STAMP}`) && !desk.content.includes(`hr ${STAMP}`));
  });

  test("canned responses: the picker, inserting one, the connector", async () => {
    const t = await raise("canned", "A");
    const picker = await call(cannedRoute.GET, "alice", `/canned?ticket=${t.number}`);
    assert.deepEqual(titles(picker.body.canned), ["it", "shared"]);
    const use = (who: string, id: number) => call(cannedUseRoute.POST, who, `/canned/${id}/use`, "POST", { number: t.number }, { id: String(id) });
    assert.equal((await use("alice", C.it)).status, 200);
    assert.equal((await use("alice", C.hr)).status, 404, "another department's by id");
    const mcp = await tool("alice", "hd_canned_responses", { number: t.number, limit: 50 });
    assert.equal(mcp.isError, false, mcp.text);
    assert.ok(mcp.text.includes(`it ${STAMP}`) && !mcp.text.includes(`hr ${STAMP}`));
    const draft = await tool("alice", "hd_draft_reply", { number: t.number, canned_id: C.hr });
    assert.equal(draft.isError, true, "a draft from another department's canned response");
  });

  test("checklists: the library, adding one by hand, the connector, Claude's suggestion", async () => {
    const lib = await call(checklistLibRoute.GET, "alice", "/checklists");
    const names = (lib.body.templates as { name: string }[]).map((x) => x.name).filter((n) => n.includes(STAMP)).sort();
    assert.deepEqual(names, [`it ${STAMP}`, `shared ${STAMP}`]);
    const t = await raise("checklist", "A");
    const add = (who: string, id: number) => call(ticketChecklistsRoute.POST, who, `/tickets/${t.number}/checklists`, "POST", { template_id: id }, { number: String(t.number) });
    assert.equal((await add("alice", CL.hr)).status, 404);
    assert.equal((await add("alice", CL.it)).status, 201);
    const view = await call(ticketChecklistsRoute.GET, "alice", `/tickets/${t.number}/checklists`, "GET", undefined, { number: String(t.number) });
    assert.ok(!(view.body.templates as { id: number }[]).some((x) => x.id === CL.hr), "the ticket's picker");
    const mcp = await tool("alice", "hd_update_checklist", { number: t.number, add_template_id: CL.hr });
    assert.equal(mcp.isError, true);
    const read = await tool("alice", "hd_read_ticket", { number: t.number });
    assert.ok(!(read.out.checklist_templates as { id: number }[]).some((x) => x.id === CL.hr));
    const open = (await tickets.getTicketByNumber(t.number))!;
    const claude = await deskTools.runDeskTool("suggest_checklist", { number: t.number, template_id: CL.hr }, await toolCtx("alice", open));
    assert.equal(claude.isError, true);
  });

  test("request types and workflows: Start a workflow, New ticket, Claude's list", async () => {
    const t = await raise("start", "A");
    const opts = await call(startRoute.GET, "alice", `/tickets/${t.number}/start-workflow`, "GET", undefined, { number: String(t.number) });
    assert.equal(opts.status, 200);
    const offered = titles(opts.body.types);
    assert.deepEqual(offered, ["it", "shared"], "the HR type, and the IT type whose workflow is HR's, are not offered");
    const carol = titles((await call(startRoute.GET, "carol", `/tickets/${t.number}/start-workflow`, "GET", undefined, { number: String(t.number) })).body.types);
    assert.deepEqual(carol, ["hr", "it", "itTypeHrFlow", "shared"]);
    const refused = await call(
      startRoute.POST,
      "alice",
      `/tickets/${t.number}/start-workflow`,
      "POST",
      { request_type_id: RT.hr, client_start_id: `k${newToken().replace(/[^A-Za-z0-9]/g, "").slice(0, 30)}`, answers: {} },
      { number: String(t.number) }
    );
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, ws.NOT_IN_AGENT_DEPARTMENTS);
    const nt = await call(newTicketTypesRoute.GET, "alice", `/tickets/request-types?requester_id=${P.req.id}`);
    assert.equal(nt.status, 200, JSON.stringify(nt.body));
    const ntTitles = titles(nt.body.request_types);
    assert.ok(ntTitles.includes("it") && !ntTitles.includes("hr"), ntTitles.join(", "));
    const open = (await tickets.getTicketByNumber(t.number))!;
    const claude = await deskTools.runDeskTool("list_startable_workflows", { number: t.number }, await toolCtx("alice", open));
    assert.equal(claude.isError, false);
    assert.ok(claude.content.includes(`${STAMP} it`) && !claude.content.includes(`${STAMP} hr`), claude.content.slice(0, 400));
  });

  test("API v1: /me names the token's desk departments (review L4: a team-limited token's teams')", async () => {
    const me = async (who: string, teams: number[]) =>
      apiV1.getMe({ req: new Request("http://localhost/api/helpdesk/v1/me"), origin: "http://localhost", user: (await session(who)) as never, p: { token_id: 0, token_name: "t", role: "agent", team_ids: teams, expires_at: null, user: (await session(who)) as never } });
    const a = await me("alice", [T.A]);
    assert.deepEqual((a.body as any).acts_as.desk_departments, [{ id: D.IT, name: `${STAMP} IT` }]);
    assert.equal(((await me("mgr", [])).body as any).acts_as.desk_departments, "all", "not team-limited: the account's");
    assert.deepEqual(((await me("mgr", [T.B])).body as any).acts_as.desk_departments, [{ id: D.HR, name: `${STAMP} HR` }], "limited to team B: HR only");
    assert.deepEqual(((await me("carol", [T.A])).body as any).acts_as.desk_departments, [{ id: D.IT, name: `${STAMP} IT` }], "carol is in both; the token only IT");
    assert.deepEqual(((await me("alice", [T.B])).body as any).acts_as.desk_departments, [], "never wider than its account's");
  });
});

// --- Managing -----------------------------------------------------------------------------------

describe("who manages a department's content", () => {
  test("the matrix (v6): Manage a desk department is Manager's and Admin's by default, lifted onto a customised Manager", () => {
    const Dm = rolesShared.HD_DEFAULT_MATRIX;
    assert.equal(rolesShared.HD_MATRIX_VERSION, 6);
    assert.equal(rolesShared.HD_CAPS_SINCE["departments.manage"], 6);
    assert.ok(Dm.manager.includes("departments.manage") && Dm.admin.includes("departments.manage"));
    for (const r of ["newbie", "agent", "team_lead"] as const) assert.ok(!Dm[r].includes("departments.manage"), r);
    assert.equal(rolesShared.HD_CAPABILITIES["departments.manage"].section, "configuration");
    const v5 = Dm.manager.filter((c) => c !== "departments.manage");
    assert.ok(rolesShared.resolveMatrix({ manager: v5, v: 5 }).manager.includes("departments.manage"), "a v5 Manager column gets it");
    const noConfig = v5.filter((c) => !["macros.manage_all", "automations.manage", "request_types.manage", "workflows.manage"].includes(c));
    assert.ok(!rolesShared.resolveMatrix({ manager: noConfig, v: 5 }).manager.includes("departments.manage"), "one that manages none of it is not");
    // Review H1: the lift grants nothing new, so a column missing ANY feature it stands in for is not lifted.
    // Review N2: teams.manage too.
    for (const removed of ["automations.manage", "workflows.manage", "request_types.manage", "macros.manage_all", "agents.manage_team", "teams.manage"] as const) {
      const r = rolesShared.resolveMatrix({ manager: v5.filter((c) => c !== removed), v: 5 }).manager;
      assert.ok(!r.includes("departments.manage"), `a v5 Manager without ${removed} is not lifted`);
      assert.ok(!r.includes(removed), `and ${removed} doesn't come back`);
    }
    assert.ok(!rolesShared.resolveMatrix({ manager: v5, v: 6 }).manager.includes("departments.manage"), "removed on purpose since v6: stays off");
    assert.ok(!rolesShared.resolveMatrix({ team_lead: Dm.team_lead, v: 5 }).team_lead.includes("departments.manage"), "Team lead's default lacks it");
    assert.ok(rolesShared.resolveMatrix({}).admin.includes("departments.manage"));
  });

  test("the Department field's choices: their departments; All departments for an Admin only", async () => {
    const lead = await call(choicesRoute.GET, "lead", "/desk-departments?feature=automations");
    assert.equal(lead.status, 200);
    assert.deepEqual(lead.body.departments.filter((d: { manageable: boolean }) => d.manageable).map((d: { id: number }) => d.id), [D.IT]);
    assert.equal(lead.body.can_all, false);
    assert.equal(lead.body.default_id, D.IT, "General is not theirs, so their first department");
    const admin = await call(choicesRoute.GET, "admin", "/desk-departments?feature=automations");
    assert.equal(admin.body.can_all, true);
    assert.equal(admin.body.default_id, generalId);
    assert.equal((await call(choicesRoute.GET, "alice", "/desk-departments?feature=nope")).status, 400);
  });

  test("a department manager: their departments' automations, never another's or All departments'", async () => {
    const rule = (name: string, extra: Record<string, unknown> = {}) => ({ name: `${STAMP} ${name}`, event: "ticket_created", conditions: { keywords: ["never-matches-" + KW] }, actions: { tags_add: ["x"] }, ...extra });
    const mine = await call(autoRoute.POST, "lead", "/admin/automations", "POST", rule("lead it", { desk_department_id: D.IT }));
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    assert.equal(mine.body.automation.desk_department_id, D.IT);
    const started = await call(autoRoute.POST, "lead", "/admin/automations", "POST", rule("lead default"));
    assert.equal(started.body.automation.desk_department_id, D.IT, "left out: their starting department");
    assert.equal((await call(autoRoute.POST, "lead", "/admin/automations", "POST", rule("lead hr", { desk_department_id: D.HR }))).status, 403);
    assert.equal((await call(autoRoute.POST, "lead", "/admin/automations", "POST", rule("lead all", { desk_department_id: null }))).status, 403, "All departments is Admin's");
    const hr = await call(autoRoute.POST, "admin", "/admin/automations", "POST", rule("admin hr", { desk_department_id: D.HR }));
    const shared = await call(autoRoute.POST, "admin", "/admin/automations", "POST", rule("admin all", { desk_department_id: null }));
    assert.equal(shared.status, 201);
    assert.equal(shared.body.automation.desk_department_id, null);
    const list = await call(autoRoute.GET, "lead", "/admin/automations");
    const ours = (list.body.automations as { id: number; can_edit: boolean }[]).filter((a) => [mine.body.automation.id, hr.body.automation.id, shared.body.automation.id].includes(a.id));
    assert.deepEqual(
      ours.map((a) => [a.id, a.can_edit]).sort(),
      [
        [mine.body.automation.id, true],
        [shared.body.automation.id, false],
      ].sort(),
      "their department's, editable; All departments', read-only; HR's not listed"
    );
    const patch = (who: string, id: number, body: Record<string, unknown>) => call(autoIdRoute.PATCH, who, `/admin/automations/${id}`, "PATCH", body, { id: String(id) });
    assert.equal((await patch("lead", hr.body.automation.id, { name: "x" })).status, 404);
    assert.equal((await patch("lead", shared.body.automation.id, { name: "x" })).status, 403);
    assert.equal((await patch("lead", mine.body.automation.id, { desk_department_id: D.HR })).status, 403, "can't move it out of their departments");
    const moved = await patch("admin", mine.body.automation.id, { desk_department_id: D.HR });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.automation.desk_department_id, D.HR);
    const audit = await auditRows("helpdesk.desk_department.item_moved", mine.body.automation.id);
    assert.equal(audit.at(-1)?.details.from_id, D.IT);
    assert.equal(audit.at(-1)?.details.to_id, D.HR);
    // Reordering: they send their own rules only; everyone else's order is untouched.
    const partial = await call(autoReorderRoute.POST, "lead", "/admin/automations/reorder", "POST", { ids: [] });
    assert.equal(partial.status, 400, "every rule they manage must be named");
    const others = async () =>
      (await pool().query("SELECT id FROM hd_automations WHERE name LIKE $1 AND id <> $2 ORDER BY position, id", [`%${STAMP}%`, started.body.automation.id])).rows.map((r) => r.id);
    const before = await others();
    const reorder = await call(autoReorderRoute.POST, "lead", "/admin/automations/reorder", "POST", { ids: [started.body.automation.id] });
    assert.equal(reorder.status, 200, "their one rule (the other moved to HR)");
    assert.deepEqual(await others(), before, "rules they don't manage keep their places");
    // Not a holder at all.
    assert.equal((await call(autoRoute.GET, "alice", "/admin/automations")).status, 403);
  });

  test("the Claude connector's admin tools: lists by department, drafts only where they manage", async () => {
    const hrRule = await automations.createAutomation({ name: `${STAMP} connector hr`, event: "ticket_created", conditions: {}, actions: { tags_add: ["c"] }, active: 0 } as never, D.HR);
    const shared = await automations.createAutomation({ name: `${STAMP} connector all`, event: "ticket_created", conditions: {}, actions: { tags_add: ["c"] }, active: 0 } as never, null);
    const list = await tool("lead", "hd_list_automations");
    assert.equal(list.isError, false, list.text);
    const byId = new Map((list.out.automations as { id: number; can_change: boolean; desk_department: string }[]).map((a) => [a.id, a]));
    assert.ok(!byId.has(hrRule.id), "another department's rule is not listed");
    assert.equal(byId.get(shared.id)?.can_change, false);
    assert.equal(byId.get(shared.id)?.desk_department, ddShared.ALL_DESK_DEPARTMENTS_LABEL);
    assert.equal((await tool("lead", "hd_list_automations", { id: hrRule.id })).isError, true);
    const changes = await tool("lead", "hd_draft_automation", { id: shared.id, name: `${STAMP} connector all v2` });
    assert.equal(changes.isError, true, "All departments: Admin only");
    const fresh = await tool("lead", "hd_draft_automation", { name: `${STAMP} connector new`, event: "ticket_created", conditions: {}, actions: { tags_add: ["n"] } });
    assert.equal(fresh.isError, false, fresh.text);
    assert.equal((await automations.getAutomation(fresh.out.id))?.desk_department_id, D.IT, "a new draft lands in their department");
    const cl = await tool("lead", "hd_list_checklists");
    const clIds = (cl.out.checklists as { id: number }[]).map((x) => x.id);
    assert.ok(clIds.includes(CL.it) && clIds.includes(CL.shared) && !clIds.includes(CL.hr));
    const wf = await tool("lead", "hd_list_workflows");
    const wfIds = (wf.out.workflows as { id: number }[]).map((x) => x.id);
    assert.ok(wfIds.includes(WF.it) && !wfIds.includes(WF.hr));
  });

  test("a feature capability alone is limited to its holder's departments", async () => {
    const r = (dept: number | null) => ({ name: `${STAMP} fiona ${dept}`, event: "ticket_created", conditions: {}, actions: { tags_add: ["f"] }, desk_department_id: dept });
    assert.equal((await call(autoRoute.POST, "fiona", "/admin/automations", "POST", r(D.IT))).status, 201);
    assert.equal((await call(autoRoute.POST, "fiona", "/admin/automations", "POST", r(D.HR))).status, 403);
    assert.equal((await call(autoRoute.POST, "fiona", "/admin/automations", "POST", r(null))).status, 403);
    // Review M3: a Manager manages their own teams' departments only, though they see every team's
    // tickets; one on no team manages none.
    assert.equal((await call(autoRoute.POST, "mgr", "/admin/automations", "POST", r(D.HR))).status, 403);
    assert.equal((await call(autoRoute.POST, "mgrA", "/admin/automations", "POST", r(D.IT))).status, 201);
    assert.equal((await call(autoRoute.POST, "mgrA", "/admin/automations", "POST", r(D.HR))).status, 403);
    assert.equal((await call(autoRoute.POST, "mgrA", "/admin/automations", "POST", r(null))).status, 403);
  });

  test("review M3: a default Manager in an IT team manages IT's content, not HR's, yet sees and uses HR's", async () => {
    assert.equal(await dd.deskDepartmentScope(await session("mgrA")), "all", "sees every department (every team's tickets)");
    const choices = await call(choicesRoute.GET, "mgrA", "/desk-departments?feature=macros");
    assert.deepEqual(choices.body.departments.filter((d: { manageable: boolean }) => d.manageable).map((d: { id: number }) => d.id), [D.IT]);
    const hrRule = await automations.createAutomation({ name: `${STAMP} m3 hr`, event: "ticket_created", conditions: {}, actions: { tags_add: ["m3"] }, active: 0 } as never, D.HR);
    const itRule = await automations.createAutomation({ name: `${STAMP} m3 it`, event: "ticket_created", conditions: {}, actions: { tags_add: ["m3"] }, active: 0 } as never, D.IT);
    const patchRule = (id: number) => call(autoIdRoute.PATCH, "mgrA", `/admin/automations/${id}`, "PATCH", { name: `${STAMP} m3 renamed ${id}` }, { id: String(id) });
    assert.equal((await patchRule(itRule.id)).status, 200, "IT's rule");
    const refused = await patchRule(hrRule.id);
    assert.equal(refused.status, 403, "HR's rule: seen, not managed");
    assert.equal(refused.body.code, "desk_department");
    const read = await call(autoIdRoute.GET, "mgrA", `/admin/automations/${hrRule.id}`, "GET", undefined, { id: String(hrRule.id) });
    assert.equal(read.status, 200);
    assert.equal(read.body.automation.can_edit, false);
    const patchMacro = (id: number) => call(macroIdRoute.PATCH, "mgrA", `/admin/macros/${id}`, "PATCH", { body: "Changed." }, { id: String(id) });
    assert.equal((await patchMacro(M.hr)).status, 403, "HR's macro");
    const wf = await call(wfIdRoute.PATCH, "mgrA", `/admin/workflows/${WF.hr}`, "PATCH", { description: "x" }, { id: String(WF.hr) });
    assert.equal(wf.status, 403, "HR's workflow");
    // Using HR's content on an HR ticket is unchanged.
    const t = await raise("m3 hr ticket", "B");
    const apply = await call(macroApplyRoute.POST, "mgrA", `/tickets/${t.number}/macro/${M.hr}`, "POST", { preview: true }, { number: String(t.number), macroId: String(M.hr) });
    assert.equal(apply.status, 200, JSON.stringify(apply.body));
    const list = titles((await call(macrosRoute.GET, "mgrA", "/macros")).body.macros);
    assert.ok(list.includes("hr") && list.includes("it"), list.join(", "));
  });

  test("macros: a department manager writes everyone's and teams' macros in their departments only", async () => {
    const post = (body: Record<string, unknown>) => call(adminMacrosRoute.POST, "lead", "/admin/macros", "POST", { title: `${STAMP} lead ${JSON.stringify(body)}`.slice(0, 110), body: "Hi.", ...body });
    const everyone = await post({ desk_department_id: D.IT });
    assert.equal(everyone.status, 201, JSON.stringify(everyone.body));
    assert.equal(everyone.body.macro.desk_department_id, D.IT);
    assert.equal((await post({ desk_department_id: D.HR })).status, 403);
    assert.equal((await post({ desk_department_id: null })).status, 403);
    const teamB = await post({ team_id: T.B });
    assert.equal(teamB.status, 403, "team B is in HR");
    const teamA = await post({ team_id: T.A, desk_department_id: D.HR });
    assert.equal(teamA.status, 201);
    assert.equal(teamA.body.macro.desk_department_id, D.IT, "a team macro is always in its team's department");
    // An agent's own personal macro needs no department.
    const personal = await call(adminMacrosRoute.POST, "alice", "/admin/macros", "POST", { title: `${STAMP} alice own`, body: "Mine.", personal: true });
    assert.equal(personal.status, 201);
    assert.equal(personal.body.macro.desk_department_id, null);
  });

  test("request types: a workflow of another department is refused; an automation's macro too", async () => {
    const rt = await call(rtRoute.POST, "admin", "/admin/request-types", "POST", { title: `${STAMP} mismatch`, workflow_id: WF.hr, desk_department_id: D.IT });
    assert.equal(rt.status, 400);
    assert.match(rt.body.error, /desk department/);
    const ok = await call(rtRoute.POST, "admin", "/admin/request-types", "POST", { title: `${STAMP} shared flow`, workflow_id: WF.shared, desk_department_id: D.IT });
    assert.equal(ok.status, 201);
    const rule = await call(autoRoute.POST, "admin", "/admin/automations", "POST", { name: `${STAMP} macro mismatch`, event: "ticket_created", conditions: {}, actions: { macro_id: M.hr }, desk_department_id: D.IT });
    assert.equal(rule.status, 400);
  });

  test("recurring tickets follow their team's department", async () => {
    const sid = (await pool().query("INSERT INTO hd_recurring (team_id, subject, pattern, enabled) VALUES ($1, $2, '{\"kind\":\"weekly\",\"weekdays\":[1]}'::jsonb, 0) RETURNING id", [T.B, `${STAMP} weekly`])).rows[0].id;
    recurringIds.push(sid);
    assert.equal((await recurring.getRecurring(sid))?.desk_department_id, D.HR);
    // A department manager who isn't a lead of the team: theirs when the team is in their department.
    roles.setRoleMatrixForTests({ ...matrix(), agent: [...rolesShared.HD_DEFAULT_MATRIX.agent, "departments.manage"] });
    try {
      assert.equal(await recurring.canManageRecurringTeam(await session("bob"), T.B), true, "Manage a desk department: their department's team");
      assert.equal(await recurring.canManageRecurringTeam(await session("bob"), T.A), false, "not another department's");
    } finally {
      roles.setRoleMatrixForTests(matrix());
    }
    assert.equal(await recurring.canManageRecurringTeam(await session("bob"), T.B), false, "a plain agent never");
  });
});

// --- Automations -------------------------------------------------------------------------------

describe("automations run per desk department", () => {
  before(async () => {
    const mk = async (key: string, dept: number | null | undefined, kw: string, actions: Record<string, unknown>) => {
      const input = await automations.validateAutomationInput({ name: `${STAMP} rule ${key}`, event: "ticket_created", conditions: { keywords: [kw] }, actions });
      assert.ok(input.ok, !input.ok ? input.error : "");
      RULE[key] = (await automations.createAutomation(input.value as never, dept)).id;
    };
    await mk("route", undefined, KW2, { team_id: T.B });
    await mk("it", D.IT, KW, { tags_add: ["dd-it"] });
    await mk("hr", D.HR, KW, { tags_add: ["dd-hr"] });
    await mk("all", null, KW, { tags_add: ["dd-all"] });
    await mk("general", undefined, KW, { tags_add: ["dd-general"] });
    await mk("hr2", D.HR, KW2, { tags_add: ["dd-after-route"] });
  });

  const tagsAfter = async (subject: string, team: string | null) => {
    const t = await raise(subject, team);
    await automations.runAutomations("ticket_created", t.id);
    return ((await pool().query("SELECT tags FROM hd_tickets WHERE id = $1", [t.id])).rows[0].tags as string[]).filter((x) => x.startsWith("dd-")).sort();
  };

  test("a ticket meets its team's department's rules and All departments'", async () => {
    assert.deepEqual(await tagsAfter(`about ${KW} on A`, "A"), ["dd-all", "dd-it"]);
    assert.deepEqual(await tagsAfter(`about ${KW} on B`, "B"), ["dd-all", "dd-hr"]);
  });

  test("a ticket with no team meets the default department's, as before departments", async () => {
    assert.deepEqual(await tagsAfter(`about ${KW} unrouted`, null), ["dd-all", "dd-general"]);
  });

  test("a rule that routes the ticket hands the rest of the run to the new department's rules", async () => {
    assert.deepEqual(await tagsAfter(`about ${KW2} to route`, null), ["dd-after-route"]);
  });
});

// --- Moving a team -----------------------------------------------------------------------------

describe("moving a team to another desk department", () => {
  test("review M4: refused while an automation outside the new department sends one of the team's macros", async () => {
    const rule = await automations.createAutomation({ name: `${STAMP} sends team A's macro`, event: "ticket_created", conditions: {}, actions: { macro_id: M.teamA }, active: 0 } as never, D.IT);
    try {
      const r = await call(deptTeamsRoute.PUT, "admin", `/admin/desk-departments/${D.HR}/teams`, "PUT", { team_id: T.A, confirm: true }, { id: String(D.HR) });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, "desk_department_dependents");
      assert.deepEqual(r.body.dependents, [{ kind: "automation", id: rule.id, title: `${STAMP} sends team A's macro` }]);
      assert.match(r.body.error, /the automation .*sends team A's macro/);
      assert.equal((await pool().query("SELECT desk_department_id AS d FROM hd_teams WHERE id = $1", [T.A])).rows[0].d, D.IT, "nothing moved");
    } finally {
      await pool().query("DELETE FROM hd_automations WHERE id = $1", [rule.id]);
    }
  });

  test("its team macros go along, nothing else; its agents and tickets follow; audited", async () => {
    // Review M5: what stops applying to the team is answered first, and the move waits for confirm.
    const asked = await call(deptTeamsRoute.PUT, "admin", `/admin/desk-departments/${D.HR}/teams`, "PUT", { team_id: T.A }, { id: String(D.HR) });
    assert.equal(asked.status, 409, JSON.stringify(asked.body));
    assert.equal(asked.body.code, "confirm_team_move");
    const ids = (k: string) => (asked.body.affected[k] as { id: number }[]).map((x) => x.id);
    assert.ok(ids("request_types").includes(RT.it), "IT's request types that route to team A");
    assert.ok(!ids("request_types").includes(RT.hr), "HR's own types route there still, in its department");
    assert.ok(ids("agents").includes(P.alice.id) && ids("agents").includes(P.carol.id), "alice and carol lose IT's content");
    assert.ok(!ids("agents").includes(P.mgrA.id), "a Manager sees every department anyway");
    assert.equal((await pool().query("SELECT desk_department_id AS d FROM hd_teams WHERE id = $1", [T.A])).rows[0].d, D.IT, "nothing moved yet");
    const moved = await call(deptTeamsRoute.PUT, "admin", `/admin/desk-departments/${D.HR}/teams`, "PUT", { team_id: T.A, confirm: true }, { id: String(D.HR) });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.ok(moved.body.moved.macros >= 2, "team A's macros (and the lead's)");
    const dept = async (id: number) => (await pool().query("SELECT desk_department_id AS d FROM hd_macros WHERE id = $1", [id])).rows[0].d;
    assert.equal(await dept(M.teamA), D.HR, "the team's own macro went with it");
    assert.equal(await dept(M.it), D.IT, "the department-wide macro stayed");
    assert.equal((await pool().query("SELECT desk_department_id AS d FROM hd_checklist_templates WHERE id = $1", [CL.it])).rows[0].d, D.IT);
    // Alice is now in HR only: HR's content, not IT's.
    assert.deepEqual(await dd.deskDepartmentScope(await session("alice")), [D.HR]);
    assert.deepEqual(titles((await call(macrosRoute.GET, "alice", "/macros")).body.macros).filter((x) => ["it", "hr", "teamA"].includes(x)), ["hr", "teamA"]);
    // Team A's tickets meet HR's rules from now on.
    const t = await raise(`about ${KW} after the move`, "A");
    await automations.runAutomations("ticket_created", t.id);
    const tags = ((await pool().query("SELECT tags FROM hd_tickets WHERE id = $1", [t.id])).rows[0].tags as string[]).filter((x) => x.startsWith("dd-")).sort();
    assert.deepEqual(tags, ["dd-all", "dd-hr"]);
    const audit = await auditRows("helpdesk.desk_department.team_moved", T.A);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].details.from_id, D.IT);
    assert.equal(audit[0].details.to_id, D.HR);
    assert.equal(audit[0].details.confirmed, true);
    assert.deepEqual(
      ((audit[0].details.affected as Record<string, { id: number }[]>).request_types ?? []).map((x) => x.id).sort(),
      ids("request_types").sort(),
      "the audit carries what changed"
    );
    // The same move again changes nothing.
    const again = await call(deptTeamsRoute.PUT, "admin", `/admin/desk-departments/${D.HR}/teams`, "PUT", { team_id: T.A }, { id: String(D.HR) });
    assert.equal(again.body.moved, null);
    // And back, for the tests after (HR's types route to team A, so confirmed too).
    const back = await call(deptTeamsRoute.PUT, "admin", `/admin/desk-departments/${D.IT}/teams`, "PUT", { team_id: T.A }, { id: String(D.IT) });
    assert.equal(back.status, 409);
    assert.equal((await call(deptTeamsRoute.PUT, "admin", `/admin/desk-departments/${D.IT}/teams`, "PUT", { team_id: T.A, confirm: true }, { id: String(D.IT) })).status, 200);
  });
});

// --- Deleting ----------------------------------------------------------------------------------

describe("deleting a desk department", () => {
  test("refused with teams, with content unless it is moved, and for the default", async () => {
    const del = (id: number, q = "") => call(deptIdRoute.DELETE, "admin", `/admin/desk-departments/${id}${q}`, "DELETE", undefined, { id: String(id) });
    const withTeams = await del(D.HR);
    assert.equal(withTeams.status, 409);
    assert.match(withTeams.body.error, /Move its .*team/);
    const def = await del(generalId);
    assert.equal(def.status, 409);
    assert.match(def.body.error, /default department/);
    const x = (await call(deptRoute.POST, "admin", "/admin/desk-departments", "POST", { name: `${STAMP} Facilities` })).body.department.id as number;
    const m = await macros.createMacro({ title: `facilities ${STAMP}`, body: "x", actions: {}, team_id: null, desk_department_id: x }, null);
    const held = await del(x);
    assert.equal(held.status, 409);
    assert.match(held.body.error, /still holds 1 macro/);
    const gone = await del(x, `?move_content_to=${D.IT}`);
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal((await pool().query("SELECT desk_department_id AS d FROM hd_macros WHERE id = $1", [m.id])).rows[0].d, D.IT);
    assert.equal((await auditRows("helpdesk.desk_department.deleted", x)).length, 1);
    const renamed = await call(deptIdRoute.PATCH, "admin", `/admin/desk-departments/${generalId}`, "PATCH", { name: "General" }, { id: String(generalId) });
    assert.equal(renamed.status, 200, "renaming to the same name is fine");
  });

  test("every action has its audit label", () => {
    for (const a of ["created", "renamed", "deleted", "team_moved", "item_moved"]) {
      assert.ok(auditLabels.hasActionLabel(`helpdesk.desk_department.${a}`), a);
    }
  });
});

// --- Review fixes: references stay inside a department ----------------------------------------

describe("review: what one item uses is of its desk department or All departments", () => {
  const KW3 = `ddskip${process.pid}x${Date.now().toString(36)}`;
  const trig = (id: number) => ({ trigger: { request_type_id: id }, steps: WAIT });
  const task = (checklistIds: number[]) => ({ trigger: {}, steps: [{ key: "t", kind: "task", title: "Set it up", team_id: T.A, checklist_ids: checklistIds }] });

  test("M1: a workflow's trigger names a request type of its department, unless the workflow is in All departments", async () => {
    assert.equal((await workflows.validateWorkflowDefinition(trig(RT.it), null, D.IT)).ok, true);
    const bad = await workflows.validateWorkflowDefinition(trig(RT.it), null, D.HR);
    assert.equal(bad.ok, false);
    assert.match(!bad.ok ? bad.error : "", /request type .* is in .*IT/);
    assert.equal((await workflows.validateWorkflowDefinition(trig(RT.it), null, null)).ok, true, "a workflow of All departments");
    const post = await call(wfRoute.POST, "admin", "/admin/workflows", "POST", { title: `${STAMP} m1 hr`, desk_department_id: D.HR, definition: trig(RT.it) });
    assert.equal(post.status, 400, JSON.stringify(post.body));
    // Publishing re-checks: a draft saved before the rule can't go live.
    const meta = await workflows.validateWorkflowMeta({ title: `${STAMP} m1 legacy` });
    assert.ok(meta.ok);
    const parsed = workflows.parseWorkflowDefinition(trig(RT.it));
    assert.ok(parsed.ok);
    const legacy = await workflows.createWorkflow(meta.value, parsed.value, D.HR);
    const pub = await workflows.publishWorkflow(legacy.id);
    assert.equal(pub.ok, false);
    assert.equal(!pub.ok && pub.status, 400);
  });

  test("M1/M4: moving a request type or a workflow that would leave the trigger across departments is refused, with the list", async () => {
    const rt = await call(rtRoute.POST, "admin", "/admin/request-types", "POST", { title: `${STAMP} m1 plain`, desk_department_id: D.IT });
    assert.equal(rt.status, 201, JSON.stringify(rt.body));
    const rtId = rt.body.request_type.id as number;
    const wf = await call(wfRoute.POST, "admin", "/admin/workflows", "POST", { title: `${STAMP} m1 trig`, desk_department_id: D.IT, definition: trig(rtId) });
    assert.equal(wf.status, 201, JSON.stringify(wf.body));
    const wfId = wf.body.workflow.id as number;
    const moveRt = (dept: number | null) => call(rtIdRoute.PATCH, "admin", `/admin/request-types/${rtId}`, "PATCH", { desk_department_id: dept }, { id: String(rtId) });
    const moveWf = (dept: number | null) => call(wfIdRoute.PATCH, "admin", `/admin/workflows/${wfId}`, "PATCH", { desk_department_id: dept }, { id: String(wfId) });
    const r1 = await moveRt(D.HR);
    assert.equal(r1.status, 409);
    assert.equal(r1.body.code, "desk_department_dependents");
    assert.deepEqual(r1.body.dependents, [{ kind: "workflow", id: wfId, title: `${STAMP} m1 trig` }]);
    assert.match(r1.body.error, /the workflow .*m1 trig/);
    const r2 = await moveWf(D.HR);
    assert.equal(r2.status, 409);
    assert.deepEqual(r2.body.dependents, [{ kind: "request_type", id: rtId, title: `${STAMP} m1 plain` }]);
    assert.equal((await moveWf(null)).status, 200, "to All departments: fine");
    assert.equal((await moveRt(D.HR)).status, 200, "and then the type moves");
  });

  test("M2: a checklist's request types, and a workflow task's checklists, are of its department", async () => {
    const post = (dept: number | null, types: number[]) =>
      call(clAdminRoute.POST, "admin", "/admin/checklists", "POST", { name: `${STAMP} m2 ${dept} ${types.join("-")}`, items: [{ key: "i1", title: "Do it", required: true }], request_type_ids: types, desk_department_id: dept });
    const bad = await post(D.HR, [RT.it]);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /request type .* is in .*IT/);
    assert.equal((await post(null, [RT.it])).status, 201, "a checklist of All departments goes on any type");
    const ok = await post(D.IT, [RT.it]);
    assert.equal(ok.status, 201);
    const clId = ok.body.template.id as number;
    // A plain save that keeps the list always works; moving it away from the type doesn't.
    const put = (body: Record<string, unknown>) => call(clAdminIdRoute.PUT, "admin", `/admin/checklists/${clId}`, "PUT", body, { id: String(clId) });
    assert.equal((await put({ name: `${STAMP} m2 renamed` })).status, 200);
    const moved = await put({ desk_department_id: D.HR });
    assert.equal(moved.status, 409);
    assert.deepEqual(moved.body.dependents.map((d: { kind: string; id: number }) => [d.kind, d.id]), [["request_type", RT.it]]);
    assert.equal((await put({ request_type_ids: [RT.it, RT.hr] })).status, 400, "adding another department's type");
    // Workflow tasks.
    const t = await workflows.validateWorkflowDefinition(task([CL.hr]), null, D.IT);
    assert.equal(t.ok, false);
    assert.match(!t.ok ? t.error : "", /checklist .*hr/);
    assert.equal((await workflows.validateWorkflowDefinition(task([CL.shared, CL.it]), null, D.IT)).ok, true);
    const wf = await call(wfRoute.POST, "admin", "/admin/workflows", "POST", { title: `${STAMP} m2 task`, desk_department_id: D.IT, definition: task([clId]) });
    assert.equal(wf.status, 201, JSON.stringify(wf.body));
    const move = await put({ desk_department_id: null });
    assert.equal(move.status, 200, "to All departments: the IT type and the IT workflow may use it");
    const back = await put({ desk_department_id: D.HR });
    assert.equal(back.status, 409);
    assert.deepEqual(back.body.dependents.map((d: { kind: string }) => d.kind).sort(), ["request_type", "workflow"]);
  });

  test("M4: a macro an automation sends can't move away; a rule whose macro moved still switches off, and skips it with a note", async () => {
    const m = await macros.createMacro({ title: `m4 ${STAMP}`, body: "Macro reply m4.", actions: {}, team_id: null, desk_department_id: D.IT }, null);
    const input = await automations.validateAutomationInput({ name: `${STAMP} m4 rule`, event: "ticket_created", conditions: { keywords: [KW3] }, actions: { macro_id: m.id } });
    assert.ok(input.ok, !input.ok ? input.error : "");
    const rule = await automations.createAutomation(input.value as never, D.IT);
    const moveMacro = await call(macroIdRoute.PATCH, "admin", `/admin/macros/${m.id}`, "PATCH", { desk_department_id: D.HR }, { id: String(m.id) });
    assert.equal(moveMacro.status, 409);
    assert.equal(moveMacro.body.code, "desk_department_dependents");
    assert.deepEqual(moveMacro.body.dependents, [{ kind: "automation", id: rule.id, title: `${STAMP} m4 rule` }]);
    // As if it had moved before this check existed.
    await pool().query("UPDATE hd_macros SET desk_department_id = $2 WHERE id = $1", [m.id, D.HR]);
    const patch = (body: Record<string, unknown>) => call(autoIdRoute.PATCH, "admin", `/admin/automations/${rule.id}`, "PATCH", body, { id: String(rule.id) });
    assert.equal((await patch({ name: `${STAMP} m4 rule renamed` })).status, 200, "a rename doesn't trip on it");
    const t = await raise(`about ${KW3}`, "A");
    await automations.runAutomations("ticket_created", t.id);
    const msgs = (await pool().query("SELECT kind, body FROM hd_messages WHERE ticket_id = $1 ORDER BY id", [t.id])).rows as { kind: string; body: string }[];
    assert.ok(!msgs.some((x) => x.body.includes("Macro reply m4")), "the macro was not sent");
    assert.ok(msgs.some((x) => x.kind === "internal" && /skipped its macro reply/.test(x.body)), JSON.stringify(msgs));
    assert.equal((await patch({ active: 0 })).status, 200, "switching it off always works");
    const swap = await patch({ actions: { macro_id: M.hr } });
    assert.equal(swap.status, 400, "a new macro is still checked");
  });

  test("L1: the checklist and recurring pages offer only the caller's departments' request types", async () => {
    const cl = await call(clAdminRoute.GET, "lead", "/admin/checklists");
    assert.equal(cl.status, 200);
    const clTypes = (cl.body.request_types as { id: number }[]).map((x) => x.id);
    assert.ok(clTypes.includes(RT.it) && clTypes.includes(RT.shared) && !clTypes.includes(RT.hr), "checklists");
    const rc = await call(recurringAdminRoute.GET, "lead", "/admin/recurring");
    assert.equal(rc.status, 200);
    const rcTypes = (rc.body.request_types as { id: number }[]).map((x) => x.id);
    assert.ok(rcTypes.includes(RT.it) && !rcTypes.includes(RT.hr), "recurring");
    const mcp = await tool("lead", "hd_list_checklists");
    assert.ok(!(mcp.out.request_types as { id: number }[]).some((x) => x.id === RT.hr), "the connector");
  });

  test("L2: a recurring ticket's request type is one its team's department sees", async () => {
    const raw = (rt: number) => ({ team_id: T.A, subject: `${STAMP} l2`, pattern: { kind: "daily", time: "09:00" }, request_type_id: rt });
    const bad = await recurring.validateRecurringInput(raw(RT.hr));
    assert.equal(bad.ok, false);
    assert.match(!bad.ok ? bad.error : "", /request type .* is in .*HR/);
    assert.equal((await recurring.validateRecurringInput(raw(RT.shared))).ok, true);
    const ok = await recurring.validateRecurringInput(raw(RT.it));
    assert.ok(ok.ok);
    // An older schedule that already has one keeps saving (switching it off) until the type or the team changes.
    const base = { ...ok.value, request_type_id: RT.hr };
    assert.equal((await recurring.validateRecurringInput({ enabled: false }, base)).ok, true);
    assert.equal((await recurring.validateRecurringInput({ team_id: T.G }, base)).ok, false);
  });

  test("L3: a stale save never reverts a move; a save racing a deletion is a 409 sentence", async () => {
    const m = await macros.createMacro({ title: `l3 ${STAMP}`, body: "x", actions: {}, team_id: null, desk_department_id: D.IT }, null);
    await pool().query("UPDATE hd_macros SET desk_department_id = NULL WHERE id = $1", [m.id]); // an Admin shared it meanwhile
    const stale = await macros.updateMacro(m.id, { title: `l3 ${STAMP} stale`, desk_department_id: D.IT }, { desk_department_id: D.IT, team_id: null, owner_id: null });
    assert.equal(stale, "changed");
    assert.equal((await pool().query("SELECT desk_department_id AS d, title FROM hd_macros WHERE id = $1", [m.id])).rows[0].d, null, "the move stands");
    const c = await canned.createCanned({ title: `l3 ${STAMP}`, body: "x", folder: "", owner_id: null, team_id: null, desk_department_id: D.IT }, null);
    await pool().query("UPDATE hd_canned_responses SET desk_department_id = $2 WHERE id = $1", [c.id, D.HR]);
    await assert.rejects(canned.updateCanned(c.id, { title: `l3 ${STAMP} stale` }, { owner_id: null, team_id: null, desk_department_id: D.IT }), (e: Error & { status?: number }) => e.status === 409);
    // The foreign key a create meets when the department was deleted under it.
    let fk: unknown = null;
    await pool()
      .query("INSERT INTO hd_macros (title, desk_department_id) VALUES ($1, 2147483000)", [`l3 gone ${STAMP}`])
      .catch((e) => (fk = e));
    assert.ok(dd.isDeskDepartmentGone(fk), String(fk));
    const res = await dd.guardDeptRace(async () => {
      throw fk;
    })();
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: dd.DESK_DEPARTMENT_GONE, code: "desk_department_gone" });
  });
});

// --- Second review ----------------------------------------------------------------------------

describe("second review: recurring by department, the trigger's own workflow, an edit and its move in one write", () => {
  test("N1: a default Manager on an IT team can't touch HR's team's recurring tickets on any path", async () => {
    const hrId = (await pool().query("INSERT INTO hd_recurring (team_id, subject, pattern, enabled) VALUES ($1, $2, '{\"kind\":\"daily\",\"time\":\"09:00\"}'::jsonb, 0) RETURNING id", [T.B, `${STAMP} n1 hr`])).rows[0].id as number;
    recurringIds.push(hrId);
    const s = await session("mgrA");
    assert.equal(await recurring.canManageRecurringTeam(s, T.A), true, "their own IT team");
    assert.equal(await recurring.canManageRecurringTeam(s, T.B), false, "HR's team, though teams.manage widens agents.manage_team");
    assert.equal(await recurring.canManageRecurringTeam(s, T.G), false, "General's team: not a department of theirs");
    const listed = await call(recurringAdminRoute.GET, "mgrA", "/admin/recurring");
    assert.equal(listed.status, 200);
    assert.deepEqual((listed.body.teams as { id: number }[]).map((t) => t.id).filter((id) => [T.A, T.B, T.G].includes(id)), [T.A]);
    assert.ok(!(listed.body.schedules as { id: number }[]).some((x) => x.id === hrId), "HR's schedule is not listed");
    const body = { team_id: T.B, subject: `${STAMP} n1 new`, pattern: { kind: "daily", time: "09:00" } };
    assert.equal((await call(recurringAdminRoute.POST, "mgrA", "/admin/recurring", "POST", body)).status, 403, "create");
    const one = { id: String(hrId) };
    assert.equal((await call(recurringIdRoute.GET, "mgrA", `/admin/recurring/${hrId}`, "GET", undefined, one)).status, 404, "read");
    assert.equal((await call(recurringIdRoute.PATCH, "mgrA", `/admin/recurring/${hrId}`, "PATCH", { subject: `${STAMP} n1 x` }, one)).status, 404, "edit");
    assert.equal((await call(recurringIdRoute.DELETE, "mgrA", `/admin/recurring/${hrId}`, "DELETE", undefined, one)).status, 404, "delete");
    assert.equal((await call(recurringRunRoute.POST, "mgrA", `/admin/recurring/${hrId}/run`, "POST", {}, one)).status, 404, "run now");
    assert.equal((await call(recurringPreviewRoute.POST, "mgrA", "/admin/recurring/preview", "POST", { team_id: T.B, pattern: { kind: "daily", time: "09:00" } })).status, 400, "preview");
    const mcpNew = await tool("mgrA", "hd_draft_recurring", body);
    assert.equal(mcpNew.isError, true, mcpNew.text);
    assert.match(mcpNew.text, /teams you lead|403/);
    assert.equal((await tool("mgrA", "hd_draft_recurring", { id: hrId, subject: `${STAMP} n1 y` })).isError, true, "connector: changes to HR's");
    assert.equal((await tool("mgrA", "hd_list_recurring", { id: hrId })).isError, true, "connector: reading HR's");
    const claude = await deskTools.runDeskTool("draft_recurring", { id: hrId, subject: `${STAMP} n1 z` }, await toolCtx("mgrA", null));
    assert.equal(claude.isError, true, "Claude in the desk");
    assert.equal((await recurring.getRecurring(hrId))?.subject, `${STAMP} n1 hr`, "untouched");
    // Their own team's still works.
    const mine = await call(recurringAdminRoute.POST, "mgrA", "/admin/recurring", "POST", { ...body, team_id: T.A });
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    recurringIds.push(mine.body.schedule.id);
  });

  test("N3: moving a type whose old workflow also triggers on it lists that workflow, even with a new workflow_id", async () => {
    const r = await call(rtRoute.POST, "admin", "/admin/request-types", "POST", { title: `${STAMP} n3 type`, desk_department_id: D.IT });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const rId = r.body.request_type.id as number;
    const w = await call(wfRoute.POST, "admin", "/admin/workflows", "POST", { title: `${STAMP} n3 W`, desk_department_id: D.IT, definition: trigSteps(rId) });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    const wId = w.body.workflow.id as number;
    const w2 = await call(wfRoute.POST, "admin", "/admin/workflows", "POST", { title: `${STAMP} n3 W2`, desk_department_id: D.HR });
    assert.equal(w2.status, 201, JSON.stringify(w2.body));
    const patch = (body: Record<string, unknown>) => call(rtIdRoute.PATCH, "admin", `/admin/request-types/${rId}`, "PATCH", body, { id: String(rId) });
    assert.equal((await patch({ workflow_id: wId })).status, 200, "W is R's workflow and triggers on R");
    const moved = await patch({ desk_department_id: D.HR, workflow_id: w2.body.workflow.id });
    assert.equal(moved.status, 409, JSON.stringify(moved.body));
    assert.deepEqual(moved.body.dependents, [{ kind: "workflow", id: wId, title: `${STAMP} n3 W` }]);
    const row = (await pool().query("SELECT desk_department_id AS d, workflow_id FROM hd_request_types WHERE id = $1", [rId])).rows[0];
    assert.deepEqual([row.d, row.workflow_id], [D.IT, wId], "nothing changed");
  });

  test("N4: an edit and its move are one write: a move racing the department's deletion saves nothing and audits nothing", async () => {
    const x = (await call(deptRoute.POST, "admin", "/admin/desk-departments", "POST", { name: `${STAMP} Doomed` })).body.department.id as number;
    const rule = await automations.createAutomation({ name: `${STAMP} n4 rule`, event: "ticket_created", conditions: {}, actions: { tags_add: ["n4"] }, active: 0 } as never, D.IT);
    // The department is deleted after the route checked it and before the save: the save is handed the gone id.
    await pool().query("DELETE FROM hd_desk_departments WHERE id = $1", [x]);
    await assert.rejects(automations.updateAutomation(rule.id, { name: `${STAMP} n4 renamed` }, { dept: x }), (e) => dd.isDeskDepartmentGone(e));
    const after = (await pool().query("SELECT name, desk_department_id AS d FROM hd_automations WHERE id = $1", [rule.id])).rows[0];
    assert.deepEqual([after.name, after.d], [`${STAMP} n4 rule`, D.IT], "the edit rolled back with the move");
    // The other three write the department with the edit too.
    const rt = await call(rtRoute.POST, "admin", "/admin/request-types", "POST", { title: `${STAMP} n4 type`, desk_department_id: D.IT });
    const input = await requestTypes.validateRequestTypeInput({ title: `${STAMP} n4 type renamed` }, rt.body.request_type);
    assert.ok(input.ok);
    await assert.rejects(requestTypes.updateRequestType(rt.body.request_type.id, input.value, x), (e) => dd.isDeskDepartmentGone(e));
    assert.equal((await pool().query("SELECT title FROM hd_request_types WHERE id = $1", [rt.body.request_type.id])).rows[0].title, `${STAMP} n4 type`);
    const meta = await workflows.validateWorkflowMeta({ title: `${STAMP} n4 flow` });
    assert.ok(meta.ok);
    const wf = await workflows.createWorkflow(meta.value, { trigger: {}, steps: [] } as never, D.IT);
    const meta2 = await workflows.validateWorkflowMeta({ title: `${STAMP} n4 flow renamed` }, wf);
    assert.ok(meta2.ok);
    await assert.rejects(workflows.saveWorkflowDraft(wf.id, meta2.value, undefined, x), (e) => dd.isDeskDepartmentGone(e));
    assert.equal((await workflows.getWorkflow(wf.id))?.title, `${STAMP} n4 flow`);
    await assert.rejects(checklists.updateTemplate(CL.it, { name: `${STAMP} n4 list` }, { dept: x }), (e) => dd.isDeskDepartmentGone(e));
    assert.equal((await checklists.getTemplate(CL.it))?.name, `it ${STAMP}`);
    // Through the route with a live department: saved and moved together, audited once.
    const viaRoute = await call(autoIdRoute.PATCH, "admin", `/admin/automations/${rule.id}`, "PATCH", { name: `${STAMP} n4 via route`, desk_department_id: D.HR }, { id: String(rule.id) });
    assert.equal(viaRoute.status, 200, "a live department: saved and moved together");
    const row = (await pool().query("SELECT name, desk_department_id AS d FROM hd_automations WHERE id = $1", [rule.id])).rows[0];
    assert.deepEqual([row.name, row.d], [`${STAMP} n4 via route`, D.HR]);
    assert.equal((await auditRows("helpdesk.desk_department.item_moved", rule.id)).length, 1, "audited once");
  });
});

function trigSteps(id: number) {
  return { trigger: { request_type_id: id }, steps: WAIT };
}
