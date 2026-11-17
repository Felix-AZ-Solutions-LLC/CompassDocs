// Helpdesk 1.20.21: Start a workflow from the desk (lib/helpdesk/workflow-start).
//
//   capability  workflows.start: Agent, Team lead, Manager and Admin by default,
//               not Newbie; matrix v5 lifts it onto a column customised before
//               it existed when that column still works a queue; team-scoped
//   offered     a type is offered when it is switched on, starts a published
//               workflow with steps, and the ticket's requester could pick it
//               in Get help (everyone's, or one of their groups'); New ticket
//               also lists the requester's types with no workflow
//   this        a ticket with no request type and no run becomes the request:
//               type and answers set, the run on it, its progress readable, the
//               "Workflow started by …" internal note before the run's first
//               step, the audit entry naming workflow and version
//   new         a ticket with a type or a run: a new request for the same
//               requester (source desk, source_ref.started_from_ticket_id), the
//               run there, an internal note with a link on each ticket; the
//               ticket itself unchanged
//   idempotent  one client_start_id starts once, whether the tries race or
//               follow each other; two different starts racing on a fresh
//               ticket: one runs on it, the other is refused (the outcome it
//               showed changed), and no stray request is opened
//   refusals    required answers (validateAnswers), the outcome the dialog
//               showed, a type no longer offered, a solved ticket, a task
//               ticket, the capability, the team scope, the licence
//   New ticket  POST /api/helpdesk/tickets with a workflow type starts the run
//               on a source 'desk' ticket (verified, not assumed), needs the
//               capability and a type the requester may use
//   live        the change reaches the 1.20.19 queue triggers
//   review      (1.20.21 security review) a new request only in a team the agent
//               may open one in; no admins-only directory value prefilled for
//               an agent; portal contacts get the portal's types and a portal
//               ticket, blocked contacts and requesters with no account or
//               portal sign-in nothing; deactivated requesters and those
//               without Get help nothing, on both paths; a reviewed-reply
//               column isn't lifted; a failed start says why and can be retried
//               on the ticket (never confused with one still on its way); the
//               answers are checked again under the lock
//
// Parallel-safe: every account, group, team, request type, workflow and ticket
// is this file's own (STAMP); the role matrix is set for this process only.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-workflow-start.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { Client } from "pg";
import { pool, getSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";
import { lockWorkspaceMail, type WorkspaceMailLock } from "./support/mail-lock";

let currentRequest: Request | null = null;
function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-wfs.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-wfs.virtual.js");
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
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const rolesShared = require("../src/lib/helpdesk/roles-shared") as typeof import("../src/lib/helpdesk/roles-shared");
const notify = require("../src/lib/helpdesk/notify") as typeof import("../src/lib/helpdesk/notify");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const engine = require("../src/lib/helpdesk/engine") as typeof import("../src/lib/helpdesk/engine");
const workflows = require("../src/lib/helpdesk/workflows") as typeof import("../src/lib/helpdesk/workflows");
const requestTypes = require("../src/lib/helpdesk/request-types") as typeof import("../src/lib/helpdesk/request-types");
const ws = require("../src/lib/helpdesk/workflow-start") as typeof import("../src/lib/helpdesk/workflow-start");
const wsShared = require("../src/lib/helpdesk/workflow-start-shared") as typeof import("../src/lib/helpdesk/workflow-start-shared");
const { HD_WORKFLOW_START_SCHEMA } = require("../src/lib/helpdesk/workflow-start-schema") as typeof import("../src/lib/helpdesk/workflow-start-schema");
const { LIVE_COLUMNS } = require("../src/lib/helpdesk/live-schema") as typeof import("../src/lib/helpdesk/live-schema");
const auditLabels = require("../src/lib/audit-labels") as typeof import("../src/lib/audit-labels");
const { HELPDESK_SWEEPS } = require("../src/lib/periodic") as typeof import("../src/lib/periodic");
const { getUserById } = require("../src/lib/db") as typeof import("../src/lib/db");
const { toSessionUser } = require("../src/lib/auth") as typeof import("../src/lib/auth");
const startRoute = require("../src/app/api/helpdesk/tickets/[number]/start-workflow/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/start-workflow/route");
const typesRoute = require("../src/app/api/helpdesk/tickets/request-types/route") as typeof import("../src/app/api/helpdesk/tickets/request-types/route");
const ticketsRoute = require("../src/app/api/helpdesk/tickets/route") as typeof import("../src/app/api/helpdesk/tickets/route");
const detail = require("../src/lib/helpdesk/detail") as typeof import("../src/lib/helpdesk/detail");
const portalLib = require("../src/lib/helpdesk/portal") as typeof import("../src/lib/helpdesk/portal");
const { setSetting } = require("../src/lib/db") as typeof import("../src/lib/db");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdFormField, HdWorkflowStep } from "../src/lib/helpdesk/types";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(handler: unknown, who: string, url: string, method = "GET", body?: unknown, params: Record<string, string> = {}) {
  currentRequest = new Request(`http://localhost/api/helpdesk${url}`, {
    method,
    headers: { cookie: `compass_session=${P[who].session}`, "content-type": "application/json", host: "localhost" },
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

const STAMP = `hdws-${Date.now()}-${process.pid}`;
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
const workflowIds: number[] = [];
const typeIds: number[] = [];
const T: Record<string, number> = {};
const RT: Record<string, number> = {};
const WF: Record<string, { id: number; title: string }> = {};
let groupId = 0;
let mailLock: WorkspaceMailLock | null = null;
const contactIds: number[] = [];
let fieldKey = "";

async function person(key: string, name: string, deskRole: string | null, teams: [string, "agent" | "lead"][] = []) {
  const addr = `${STAMP}-${key}@example.test`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [`${STAMP}-${key}`, name, addr]);
  const id = r.rows[0].id as number;
  userIds.push(id);
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  const role = await fixtureQuery("INSERT INTO roles (key, name) VALUES ($1, $1) RETURNING id", [`${STAMP}-req-${key}`]);
  roleIds.push(role.rows[0].id);
  await fixtureQuery("INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'helpdesk.request')", [role.rows[0].id]);
  await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [role.rows[0].id, id]);
  if (deskRole) await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [id, deskRole]);
  for (const [tm, as] of teams) await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [T[tm], id, as]);
  P[key] = { id, name, email: addr, session };
}

const LAPTOP_FORM: HdFormField[] = [
  { key: "model", label: "Model", type: "text", required: true },
  { key: "budget", label: "Budget", type: "number" },
];
const WAIT: HdWorkflowStep[] = [{ key: "w", kind: "wait", title: "Give it a day", until: { after_hours: 24 } } as HdWorkflowStep];

/** A request type, optionally linked to a workflow (published or a draft only). */
async function makeType(
  key: string,
  opts: { workflow?: "published" | "draft" | null; visibility?: "all" | "groups"; active?: boolean; form?: HdFormField[]; team?: string } = {}
): Promise<number> {
  let workflowId: number | null = null;
  if (opts.workflow) {
    const title = `${STAMP} ${key} flow`;
    const meta = await workflows.validateWorkflowMeta({ title });
    assert.ok(meta.ok, !meta.ok ? meta.error : "");
    const def = workflows.parseWorkflowDefinition({ trigger: {}, steps: WAIT });
    assert.ok(def.ok, !def.ok ? def.error : "");
    const wf = await workflows.createWorkflow(meta.value, def.value);
    workflowIds.push(wf.id);
    workflowId = wf.id;
    WF[key] = { id: wf.id, title };
  }
  const input = await requestTypes.validateRequestTypeInput({
    title: `${STAMP} ${key}`,
    team_id: T[opts.team ?? "A"],
    form: opts.form ?? LAPTOP_FORM,
    workflow_id: workflowId,
    visibility: opts.visibility ?? "all",
    group_ids: opts.visibility === "groups" ? [groupId] : [],
    active: opts.active ?? true,
  });
  assert.ok(input.ok, !input.ok ? input.error : "");
  const rt = await requestTypes.createRequestType(input.value);
  typeIds.push(rt.id);
  if (opts.workflow === "published") {
    const pub = await workflows.publishWorkflow(workflowId!);
    assert.ok(pub.ok, !pub.ok ? pub.error : "");
  }
  RT[key] = rt.id;
  return rt.id;
}

async function raise(subject: string, opts: { team?: string; requester?: string; request_type_id?: number; answers?: Record<string, unknown>; parent?: number } = {}) {
  const who = P[opts.requester ?? "req"];
  const t = await tickets.createTicket(
    {
      subject: `${STAMP} ${subject}`,
      body: "My laptop is dying, could I get a new one?",
      requester: { id: who.id, name: who.name, email: who.email },
      team_id: T[opts.team ?? "A"],
      request_type_id: opts.request_type_id ?? null,
      answers: (opts.answers ?? {}) as never,
      parent_ticket_id: opts.parent ?? null,
    },
    { silent: true, actorId: who.id, actorName: who.name }
  );
  ticketIds.push(t.id);
  return (await tickets.getTicketById(t.id))!;
}

const options = (who: string, n: number) => call(startRoute.GET, who, `/tickets/${n}/start-workflow`, "GET", undefined, { number: String(n) });
const start = (who: string, n: number, body: Record<string, unknown>) => call(startRoute.POST, who, `/tickets/${n}/start-workflow`, "POST", body, { number: String(n) });
const key = () => `k${newToken().replace(/[^A-Za-z0-9]/g, "").slice(0, 30)}`;
const row = async (id: number) => (await pool().query("SELECT * FROM hd_tickets WHERE id = $1", [id])).rows[0];
const runsOn = async (id: number) => (await pool().query("SELECT * FROM hd_workflow_runs WHERE ticket_id = $1 ORDER BY id", [id])).rows;
const msgs = async (id: number) => (await pool().query("SELECT id, kind, body, author_id, author_name FROM hd_messages WHERE ticket_id = $1 ORDER BY id", [id])).rows;
const startedFrom = async (id: number) => (await pool().query("SELECT * FROM hd_tickets WHERE source_ref->>'started_from_ticket_id' = $1 ORDER BY id", [String(id)])).rows;
const agentOf = async (who: string) => toSessionUser((await getUserById(P[who].id))!);
const ours = (list: { title: string }[]) => list.filter((x) => x.title.startsWith(STAMP)).map((x) => x.title.slice(STAMP.length + 1)).sort();

before(async () => {
  mailLock = await lockWorkspaceMail("shared");
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(rolesShared.HD_DEFAULT_MATRIX);
  for (const k of ["A", "B"]) T[k] = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9471) RETURNING id", [`${STAMP} ${k}`])).rows[0].id;
  groupId = (await fixtureQuery("INSERT INTO groups (name) VALUES ($1) RETURNING id", [`${STAMP} Engineering`])).rows[0].id;
  await person("req", "Daniel Okafor", null);
  await person("req2", "Rosa Outsider", null);
  await person("sam", "Sam Lee", "agent", [["A", "agent"]]);
  await person("newbie", "Nico Newbie", "newbie", [["A", "agent"]]);
  await person("other", "Otto Other", "agent", [["B", "agent"]]);
  await person("lead", "Priya Natarajan", "team_lead", [["A", "lead"]]);
  await person("admin", "Ada Admin", "admin");
  await pool().query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [groupId, P.req.id]);
  await makeType("Laptop", { workflow: "published" });
  await makeType("Restricted", { workflow: "published", visibility: "groups" });
  await makeType("Draft", { workflow: "draft" });
  await makeType("Plain", { workflow: null, form: [] });
  await makeType("Off", { workflow: "published", active: false });
  notify.setAgentDeliverySpyForTests(() => {});
  email.setHelpdeskTransportForTests(async () => {});
});

after(async () => {
  notify.setAgentDeliverySpyForTests(null);
  email.setHelpdeskTransportForTests(null);
  roles.setRoleMatrixForTests(null);
  const all = (
    await pool().query("SELECT id FROM hd_tickets WHERE id = ANY($1) OR requester_id = ANY($2) OR parent_ticket_id = ANY($1)", [ticketIds, userIds])
  ).rows.map((r) => r.id as number);
  await pool().query("UPDATE hd_tickets SET workflow_run_id = NULL, parent_ticket_id = NULL WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_workflow_runs WHERE ticket_id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_request_types WHERE id = ANY($1)", [typeIds]);
  await pool().query("DELETE FROM hd_workflows WHERE id = ANY($1)", [workflowIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [Object.values(T)]);
  await pool().query("DELETE FROM groups WHERE id = $1", [groupId]);
  if (contactIds.length) await pool().query("DELETE FROM hd_portal_contacts WHERE id = ANY($1)", [contactIds]);
  if (fieldKey) await pool().query("DELETE FROM directory_fields WHERE key = $1", [fieldKey]);
  const dps = (await pool().query("SELECT directory_person_id AS id FROM users WHERE id = ANY($1) AND directory_person_id IS NOT NULL", [userIds])).rows.map((r) => r.id);
  await pool().query("UPDATE users SET directory_person_id = NULL WHERE id = ANY($1)", [userIds]);
  if (dps.length) await pool().query("DELETE FROM directory_people WHERE id = ANY($1)", [dps]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await mailLock?.release(email);
  await pool().end();
});

// --- The capability -----------------------------------------------------------------------------

describe("the capability (matrix v5)", () => {
  const D = () => rolesShared.HD_DEFAULT_MATRIX;
  test("Agent, Team lead, Manager and Admin hold it by default; Newbie doesn't", () => {
    for (const r of ["agent", "team_lead", "manager", "admin"] as const) assert.ok(D()[r].includes("workflows.start"), r);
    assert.ok(!D().newbie.includes("workflows.start"));
    assert.equal(rolesShared.HD_CAPABILITIES["workflows.start"].label, "Start a workflow");
    assert.equal(rolesShared.HD_CAPABILITIES["workflows.start"].section, "tickets");
    assert.equal(rolesShared.HD_CAP_SCOPE["workflows.start"], "tickets.view_all", "checked on the ticket's team");
    // 1.20.23: v6 added "Manage a desk department"; workflows.start stays a v5 capability.
    assert.ok(rolesShared.HD_MATRIX_VERSION >= 5);
    assert.equal(rolesShared.HD_CAPS_SINCE["workflows.start"], 5);
  });

  test("the v5 migration lifts it onto columns customised before it, when they still work a queue", () => {
    const agentV4 = D().agent.filter((c) => c !== "workflows.start");
    const m = rolesShared.resolveMatrix({ agent: agentV4, team_lead: D().team_lead.filter((c) => c !== "workflows.start"), v: 4 });
    assert.ok(m.agent.includes("workflows.start"), "a v4 Agent column gets it");
    assert.ok(m.team_lead.includes("workflows.start"), "a v4 Team lead column gets it");
    // A column that sees no queue at all doesn't.
    const noQueue = agentV4.filter((c) => c !== "tickets.view_team" && c !== "tickets.view_all");
    assert.ok(!rolesShared.resolveMatrix({ agent: noQueue, v: 4 }).agent.includes("workflows.start"));
    // A Manager seeing every team (no view_team) does.
    const mgr = D().manager.filter((c) => c !== "workflows.start" && c !== "tickets.view_team");
    assert.ok(rolesShared.resolveMatrix({ manager: mgr, v: 4 }).manager.includes("workflows.start"));
    // Newbie's default lacks it: never lifted.
    assert.ok(!rolesShared.resolveMatrix({ newbie: D().newbie, v: 4 }).newbie.includes("workflows.start"));
    // 1.20.21 review (5): a column whose replies wait for review isn't lifted, whatever else it holds.
    const reviewed = agentV4.filter((c) => c !== "tickets.reply_public").concat("tickets.reply_needs_review" as never);
    assert.ok(!rolesShared.resolveMatrix({ agent: reviewed, v: 4 }).agent.includes("workflows.start"));
    assert.deepEqual(rolesShared.HD_CAPS_SINCE_NEEDS["workflows.start"], { all: ["tickets.reply_public"], any: ["tickets.view_team", "tickets.view_all"] });
    // Removed on purpose since (saved under v5): stays off.
    assert.ok(!rolesShared.resolveMatrix({ agent: agentV4, v: 5 }).agent.includes("workflows.start"));
    // Admin always.
    assert.ok(rolesShared.resolveMatrix({}).admin.includes("workflows.start"));
  });

  test("the audit label, the sweep and the schema", () => {
    assert.equal(auditLabels.actionLabel("helpdesk.workflow_run.started"), "Started a workflow");
    assert.ok(HELPDESK_SWEEPS.some((s) => s.name === "hd_workflow_start_ids"));
    assert.match(HD_WORKFLOW_START_SCHEMA, /PRIMARY KEY \(user_id, ticket_id, client_start_id\)/);
  });
});

// --- Shared ---------------------------------------------------------------------------------------

describe("the shared words", () => {
  test("keys, outcome sentences and the primary's label", () => {
    assert.equal(wsShared.cleanStartId("short"), "bad");
    assert.equal(wsShared.cleanStartId(undefined), "bad");
    assert.equal(wsShared.cleanStartId("abc def ghi jkl mno"), "bad");
    assert.equal(wsShared.cleanStartId("0123456789abcdef"), "0123456789abcdef");
    const t = { number: 7, request_type_title: null, in_workflow: false };
    assert.match(wsShared.startModeSentence("this", t, "Daniel"), /runs on this ticket, #7, which becomes Daniel's request/);
    assert.match(wsShared.startModeSentence("new", { ...t, request_type_title: "New laptop" }, "Daniel"), /#7 is already a New laptop request, so a new request is opened for Daniel/);
    assert.match(wsShared.startModeSentence("new", t, "Daniel"), /#7 already has a workflow/);
    assert.equal(wsShared.startButtonLabel("this"), "Start on this ticket");
    assert.equal(wsShared.startButtonLabel("new"), "Open a request and start");
    assert.equal(wsShared.startedLine("Sam Lee", "New starter", 3), "Workflow started by Sam Lee: New starter (version 3)");
  });
});

// --- Which types ----------------------------------------------------------------------------------

describe("the request types offered", () => {
  test("switched on, a published workflow with steps, and the requester's to use", async () => {
    const t = await raise("offered");
    const r = await options("sam", t.number);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.eligible, true);
    assert.equal(r.body.mode, "this");
    assert.equal(r.body.requester.name, "Daniel Okafor");
    assert.deepEqual(ours(r.body.types), ["Laptop", "Restricted"], "not the draft-only, the workflow-less or the switched-off type");
    const laptop = r.body.types.find((x: any) => x.id === RT.Laptop);
    assert.deepEqual(laptop.form.map((f: any) => f.key), ["model", "budget"]);
    assert.equal(laptop.workflow.title, WF.Laptop.title);
    assert.equal(laptop.workflow.version, 1);
    assert.equal(laptop.workflow.steps, 1);
  });

  test("a group-restricted type only for a requester in its group; the agent's own groups don't widen it", async () => {
    await pool().query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [groupId, P.sam.id]);
    try {
      const t = await raise("outsider", { requester: "req2" });
      const r = await options("sam", t.number);
      assert.deepEqual(ours(r.body.types), ["Laptop"]);
    } finally {
      await pool().query("DELETE FROM group_members WHERE group_id = $1 AND user_id = $2", [groupId, P.sam.id]);
    }
  });

  test("a requester with no account and no portal sign-in: nothing is offered, and the dialog says why", async () => {
    assert.deepEqual(await ws.startableTypes(null), []);
    const t = await raise("no account");
    await pool().query("UPDATE hd_tickets SET requester_id = NULL, requester_name = 'Walk In', requester_email = $2 WHERE id = $1", [t.id, `${STAMP}-walkin@example.test`]);
    const o = await options("sam", t.number);
    assert.equal(o.status, 200);
    assert.equal(o.body.eligible, false);
    assert.match(o.body.reason, /^Walk In has no account and no customer portal sign-in/);
    assert.deepEqual(o.body.types, []);
    const r = await start("sam", t.number, { request_type_id: RT.Laptop, answers: { model: "x" }, client_start_id: key() });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "workflow_not_startable");
    assert.equal((await row(t.id)).request_type_id, null);
  });

  test("a deactivated requester, or one without Get help, is offered nothing on either path (1.20.21 review, 8)", async () => {
    const t = await raise("inactive");
    await pool().query("UPDATE users SET status = 'disabled' WHERE id = $1", [P.req2.id]);
    await pool().query("UPDATE hd_tickets SET requester_id = $2 WHERE id = $1", [t.id, P.req2.id]);
    try {
      const o = await options("sam", t.number);
      assert.equal(o.body.eligible, false);
      assert.match(o.body.reason, /can't use Get help/);
      assert.equal((await start("sam", t.number, { request_type_id: RT.Laptop, answers: { model: "x" }, client_start_id: key() })).status, 409);
      assert.equal((await call(typesRoute.GET, "sam", `/tickets/request-types?requester_id=${P.req2.id}`)).status, 400);
    } finally {
      await pool().query("UPDATE users SET status = 'active' WHERE id = $1", [P.req2.id]);
    }
    // Active, but no helpdesk.request (their only role taken away).
    await pool().query("DELETE FROM role_assignments WHERE user_id = $1", [P.req2.id]);
    try {
      assert.equal((await options("sam", t.number)).body.eligible, false);
      assert.equal((await call(typesRoute.GET, "sam", `/tickets/request-types?requester_id=${P.req2.id}`)).status, 400);
      const nt = await call(ticketsRoute.POST, "sam", "/tickets", "POST", { requester_id: P.req2.id, subject: `${STAMP} x`, request_type_id: RT.Laptop, answers: { model: "x" } });
      assert.equal(nt.status, 400);
      assert.match(nt.body.error, /can't use Get help/);
    } finally {
      const rid = roleIds[userIds.indexOf(P.req2.id)];
      await pool().query("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [rid, P.req2.id]);
    }
    assert.equal((await options("sam", t.number)).body.eligible, true, "back with access");
  });

  test("New ticket's list: the requester's types, with or without a workflow", async () => {
    const r = await call(typesRoute.GET, "sam", `/tickets/request-types?requester_id=${P.req.id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(ours(r.body.request_types), ["Draft", "Laptop", "Plain", "Restricted"]);
    assert.equal(r.body.request_types.find((x: any) => x.id === RT.Plain).workflow, null);
    assert.equal(r.body.request_types.find((x: any) => x.id === RT.Draft).workflow, null, "a draft-only workflow starts nothing");
    const r2 = await call(typesRoute.GET, "sam", `/tickets/request-types?requester_id=${P.req2.id}`);
    assert.deepEqual(ours(r2.body.request_types), ["Draft", "Laptop", "Plain"]);
    assert.equal((await call(typesRoute.GET, "newbie", `/tickets/request-types?requester_id=${P.req.id}`)).status, 403);
    assert.equal((await call(typesRoute.GET, "sam", `/tickets/request-types?requester_id=999999999`)).status, 400);
  });
});

// --- On this ticket -------------------------------------------------------------------------------

describe("on this ticket", () => {
  test("the ticket becomes the request and the run lives on it", async () => {
    const t = await raise("this");
    const r = await start("sam", t.number, { request_type_id: RT.Laptop, answers: { model: "ThinkPad X1", budget: "1800", junk: "x" }, client_start_id: key(), expect: "this" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mode, "this");
    assert.equal(r.body.started, true);
    assert.equal(r.body.duplicate, false);
    assert.equal(r.body.request.number, t.number);
    assert.deepEqual(r.body.workflow, { title: WF.Laptop.title, version: 1 });
    const after = await row(t.id);
    assert.equal(after.request_type_id, RT.Laptop);
    assert.deepEqual(after.form_answers, { model: "ThinkPad X1", budget: 1800 }, "validateAnswers cleaned them");
    const runs = await runsOn(t.id);
    assert.equal(runs.length, 1);
    assert.equal(after.workflow_run_id, runs[0].id);
    assert.equal(runs[0].workflow_version, 1);
    // Its progress is what the side panel's Workflow card reads.
    const progress = await engine.getWorkflowProgress(t.id, "agent");
    assert.ok(progress);
    assert.equal(progress!.workflow_title, WF.Laptop.title);
    assert.equal(progress!.steps[0].title, "Give it a day");
    // The agent's note, before anything the run wrote.
    const m = await msgs(t.id);
    const note = m.find((x) => x.kind === "internal" && x.body.startsWith("Workflow started by Sam Lee"));
    assert.ok(note, JSON.stringify(m));
    assert.equal(note.author_id, P.sam.id);
    assert.match(note.body, /\(version 1\)\. This ticket is now a .*Laptop request\./);
    const firstRunLine = m.find((x) => x.author_name === "Workflow");
    if (firstRunLine) assert.ok(note.id < firstRunLine.id, "the note precedes the run's own lines");
    // The audit entry names the workflow and the version.
    const a = (await pool().query("SELECT * FROM audit_log WHERE actor_id = $1 AND action = 'helpdesk.workflow_run.started' AND target_id = $2", [P.sam.id, String(t.number)])).rows;
    assert.equal(a.length, 1);
    assert.equal(a[0].target_label, `#${t.number} · ${WF.Laptop.title} (version 1)`);
    assert.equal(a[0].details.summary, `Workflow started by Sam Lee: ${WF.Laptop.title} (version 1)`);
    assert.equal(a[0].details.mode, "this");
    assert.equal(a[0].details.run_id, runs[0].id);
    // Now the ticket has a run: the next start opens a new request.
    assert.equal((await options("sam", t.number)).body.mode, "new");
  });

  test("the version is the one the run pinned", async () => {
    const t = await raise("version");
    // A second published version of the Laptop flow.
    const def = workflows.parseWorkflowDefinition({ trigger: {}, steps: [{ key: "w2", kind: "wait", title: "Two days", until: { after_hours: 48 } }] });
    assert.ok(def.ok);
    await pool().query("UPDATE hd_workflows SET draft = $2::jsonb WHERE id = $1", [WF.Laptop.id, JSON.stringify(def.ok ? def.value : null)]);
    const pub = await workflows.publishWorkflow(WF.Laptop.id);
    assert.ok(pub.ok && pub.version === 2, JSON.stringify(pub));
    const r = await start("sam", t.number, { request_type_id: RT.Laptop, answers: { model: "Mac" }, client_start_id: key(), expect: "this" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.workflow.version, 2);
    const note = (await msgs(t.id)).find((x) => x.kind === "internal" && x.body.startsWith("Workflow started by"));
    assert.match(note.body, /\(version 2\)/);
  });
});

// --- On a new request -----------------------------------------------------------------------------

describe("on a new request", () => {
  test("a ticket that already has a request type: a linked new request for the same requester", async () => {
    const t = await raise("typed", { request_type_id: RT.Plain });
    const o = await options("sam", t.number);
    assert.equal(o.body.mode, "new");
    assert.equal(o.body.ticket.request_type_title, `${STAMP} Plain`);
    const r = await start("sam", t.number, { request_type_id: RT.Laptop, answers: { model: "Dell" }, client_start_id: key(), expect: "new", subject: "New laptop: Dell" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mode, "new");
    assert.equal(r.body.started, true);
    assert.notEqual(r.body.request.number, t.number);
    const made = await startedFrom(t.id);
    assert.equal(made.length, 1);
    const n = made[0];
    assert.equal(n.number, r.body.request.number);
    assert.equal(n.subject, "New laptop: Dell");
    assert.equal(n.requester_id, P.req.id);
    assert.equal(n.source, "desk");
    assert.equal(n.request_type_id, RT.Laptop);
    assert.deepEqual(n.form_answers, { model: "Dell" });
    assert.equal((await runsOn(n.id)).length, 1, "the run is on the new request");
    // This ticket is unchanged: its type, no run.
    const same = await row(t.id);
    assert.equal(same.request_type_id, RT.Plain);
    assert.equal(same.workflow_run_id, null);
    assert.equal((await runsOn(t.id)).length, 0);
    // An internal note on each, linking to the other.
    const onNew = (await msgs(n.id)).find((x) => x.kind === "internal" && x.body.startsWith("Workflow started by Sam Lee"));
    assert.ok(onNew);
    assert.ok(onNew.body.includes(`](/desk/tickets/${t.number})`), onNew.body);
    const onOld = (await msgs(t.id)).find((x) => x.kind === "internal" && x.body.startsWith("Workflow started by Sam Lee"));
    assert.ok(onOld);
    assert.ok(onOld.body.includes(`on a new request: [#${n.number} `), onOld.body);
    assert.ok(onOld.body.includes(`](/desk/tickets/${n.number})`));
    const a = (await pool().query("SELECT details FROM audit_log WHERE actor_id = $1 AND action = 'helpdesk.workflow_run.started' AND target_id = $2", [P.sam.id, String(n.number)])).rows;
    assert.equal(a.length, 1);
    assert.equal(a[0].details.mode, "new");
    assert.equal(a[0].details.from_ticket, t.number);
  });

  test("a ticket already running a workflow gets a new request too", async () => {
    const t = await raise("running", { request_type_id: RT.Laptop, answers: { model: "x" } });
    assert.ok((await row(t.id)).workflow_run_id, "createTicket started its run");
    const r = await start("sam", t.number, { request_type_id: RT.Laptop, answers: { model: "y" }, client_start_id: key(), expect: "new" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mode, "new");
    assert.equal(r.body.request.subject, `${STAMP} Laptop`, "the type's title when no subject is sent");
    assert.equal((await runsOn(t.id)).length, 1, "the first run is untouched");
  });
});

// --- Idempotent and race-safe ----------------------------------------------------------------------

describe("double submits and races", () => {
  test("one key, two tries at once: one start, the other answers duplicate (this ticket)", async () => {
    const t = await raise("double this");
    const agent = await agentOf("sam");
    const k = key();
    const body = { request_type_id: RT.Laptop, answers: { model: "A" }, client_start_id: k, expect: "this" };
    const [a, b] = await Promise.all([ws.startWorkflowFromTicket(agent, t.id, body), ws.startWorkflowFromTicket(agent, t.id, body)]);
    assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
    if (!a.ok || !b.ok) return;
    assert.deepEqual([a.result.duplicate, b.result.duplicate].sort(), [false, true]);
    assert.equal(a.result.request.number, t.number);
    assert.equal(b.result.request.number, t.number);
    assert.equal((await runsOn(t.id)).length, 1);
    assert.equal((await startedFrom(t.id)).length, 0, "no new request");
    const notes = (await msgs(t.id)).filter((x) => x.kind === "internal" && x.body.startsWith("Workflow started by"));
    assert.equal(notes.length, 1);
  });

  test("one key, two tries at once on a typed ticket: exactly one new request", async () => {
    const t = await raise("double new", { request_type_id: RT.Plain });
    const agent = await agentOf("sam");
    const body = { request_type_id: RT.Laptop, answers: { model: "B" }, client_start_id: key(), expect: "new" };
    const results = await Promise.all([1, 2, 3].map(() => ws.startWorkflowFromTicket(agent, t.id, body)));
    assert.ok(results.every((x) => x.ok));
    const made = await startedFrom(t.id);
    assert.equal(made.length, 1, "one request, however many tries");
    for (const x of results) if (x.ok) assert.equal(x.result.request.number, made[0].number);
    assert.equal(results.filter((x) => x.ok && !x.result.duplicate).length, 1);
  });

  test("the same key again through the route answers the first outcome and does nothing", async () => {
    const t = await raise("repeat");
    const k = key();
    const first = await start("sam", t.number, { request_type_id: RT.Laptop, answers: { model: "C" }, client_start_id: k, expect: "this" });
    assert.equal(first.status, 200);
    // The dialog's retry: the ticket has a type now, but the key wins, so nothing new is opened.
    const again = await start("sam", t.number, { request_type_id: RT.Laptop, answers: { model: "C" }, client_start_id: k, expect: "this" });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.mode, "this");
    assert.equal(again.body.request.number, t.number);
    assert.equal(again.body.started, true);
    assert.equal((await startedFrom(t.id)).length, 0);
    assert.equal((await runsOn(t.id)).length, 1);
  });

  test("two different starts racing on a fresh ticket: one runs on it, the other is told the outcome changed", async () => {
    const t = await raise("race");
    const sam = await agentOf("sam");
    const lead = await agentOf("lead");
    const [a, b] = await Promise.all([
      ws.startWorkflowFromTicket(sam, t.id, { request_type_id: RT.Laptop, answers: { model: "D" }, client_start_id: key(), expect: "this" }),
      ws.startWorkflowFromTicket(lead, t.id, { request_type_id: RT.Laptop, answers: { model: "E" }, client_start_id: key(), expect: "this" }),
    ]);
    const okOnes = [a, b].filter((x) => x.ok);
    const refused = [a, b].filter((x) => !x.ok);
    assert.equal(okOnes.length, 1, JSON.stringify([a, b]));
    assert.equal(refused.length, 1);
    const no = refused[0];
    if (!no.ok) {
      assert.equal(no.status, 409);
      assert.equal(no.code, "workflow_mode_changed");
      assert.equal(no.mode, "new");
    }
    assert.equal((await runsOn(t.id)).length, 1);
    assert.equal((await startedFrom(t.id)).length, 0, "the refused one opened nothing");
  });
});

// --- Refusals -------------------------------------------------------------------------------------

describe("refusals", () => {
  test("required answers are enforced on the server; nothing is written", async () => {
    const t = await raise("required");
    const r = await start("sam", t.number, { request_type_id: RT.Laptop, answers: { budget: 10 }, client_start_id: key(), expect: "this" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, '"Model" is required.');
    const n = await start("sam", t.number, { request_type_id: RT.Laptop, answers: { model: "x", budget: "lots" }, client_start_id: key(), expect: "this" });
    assert.equal(n.status, 400);
    assert.equal(n.body.error, '"Budget" must be a number.');
    assert.equal((await row(t.id)).request_type_id, null);
    assert.equal((await runsOn(t.id)).length, 0);
  });

  test("a key, a type and the outcome are checked", async () => {
    const t = await raise("checks");
    assert.equal((await start("sam", t.number, { request_type_id: RT.Laptop, answers: { model: "x" } })).status, 400, "no key");
    assert.equal((await start("sam", t.number, { request_type_id: RT.Laptop, answers: { model: "x" }, client_start_id: "nope" })).status, 400);
    assert.equal((await start("sam", t.number, { answers: {}, client_start_id: key() })).status, 400, "no type");
    const changed = await start("sam", t.number, { request_type_id: RT.Laptop, answers: { model: "x" }, client_start_id: key(), expect: "new" });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, "workflow_mode_changed");
    assert.equal(changed.body.mode, "this");
    for (const k of ["Draft", "Off", "Plain"]) {
      const r = await start("sam", t.number, { request_type_id: RT[k], answers: { model: "x" }, client_start_id: key(), expect: "this" });
      assert.equal(r.status, 409, k);
      assert.equal(r.body.code, "request_type_unavailable", k);
    }
    // A restricted type for a requester outside its group.
    const t2 = await raise("restricted", { requester: "req2" });
    const rr = await start("sam", t2.number, { request_type_id: RT.Restricted, answers: { model: "x" }, client_start_id: key(), expect: "this" });
    assert.equal(rr.status, 409);
    assert.equal(rr.body.code, "request_type_unavailable");
    assert.equal((await row(t.id)).request_type_id, null, "nothing was written");
    assert.equal((await row(t2.id)).request_type_id, null);
  });

  test("a solved ticket and a task ticket can't start one", async () => {
    const t = await raise("solved");
    await tickets.updateTicket(t.id, { status: "solved" }, { id: P.sam.id, name: P.sam.name }, { silent: true });
    const o = await options("sam", t.number);
    assert.equal(o.body.eligible, false);
    assert.match(o.body.reason, /This ticket is solved/);
    assert.deepEqual(o.body.types, []);
    const r = await start("sam", t.number, { request_type_id: RT.Laptop, answers: { model: "x" }, client_start_id: key() });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "workflow_not_startable");
    const parent = await raise("parent");
    const child = await raise("child", { parent: parent.id });
    const c = await start("sam", child.number, { request_type_id: RT.Laptop, answers: { model: "x" }, client_start_id: key() });
    assert.equal(c.status, 409);
    assert.match(c.body.error, /task of another request/);
  });

  test("the capability, the team scope and the licence", async () => {
    const t = await raise("perm");
    const body = () => ({ request_type_id: RT.Laptop, answers: { model: "x" }, client_start_id: key(), expect: "this" });
    // Newbie: no capability by default.
    assert.equal((await options("newbie", t.number)).status, 403);
    assert.equal((await start("newbie", t.number, body())).status, 403);
    // An agent of another team doesn't work the ticket: the same 404 as a missing one.
    assert.equal((await options("other", t.number)).status, 404);
    assert.equal((await start("other", t.number, body())).status, 404);
    // The capability switched off for Agent: refused, nothing written.
    roles.setRoleMatrixForTests({ ...rolesShared.HD_DEFAULT_MATRIX, agent: rolesShared.HD_DEFAULT_MATRIX.agent.filter((c) => c !== "workflows.start") });
    try {
      assert.equal((await options("sam", t.number)).status, 403);
      assert.equal((await start("sam", t.number, body())).status, 403);
      assert.equal((await call(typesRoute.GET, "sam", `/tickets/request-types?requester_id=${P.req.id}`)).status, 403);
    } finally {
      roles.setRoleMatrixForTests(rolesShared.HD_DEFAULT_MATRIX);
    }
    assert.equal((await row(t.id)).request_type_id, null);
    // Admin works every team.
    assert.equal((await options("admin", t.number)).status, 200);
    // No helpdesk in the licence.
    edition.features = [];
    try {
      assert.equal((await options("sam", t.number)).status, 402);
      assert.equal((await start("sam", t.number, body())).status, 402);
    } finally {
      edition.features = ["helpdesk"];
    }
  });
});

// --- New ticket -----------------------------------------------------------------------------------

describe("New ticket with a request type", () => {
  const newTicket = (who: string, body: Record<string, unknown>) => call(ticketsRoute.POST, who, "/tickets", "POST", body);

  test("a desk ticket of a workflow type starts its run on create (source desk)", async () => {
    const r = await newTicket("sam", { requester_id: P.req.id, subject: `${STAMP} phoned in`, request_type_id: RT.Laptop, answers: { model: "Surface" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ticketIds.push(r.body.ticket.id);
    const t = await row(r.body.ticket.id);
    assert.equal(t.source, "desk");
    assert.equal(t.team_id, T.A, "the type's team");
    assert.ok(t.workflow_run_id, "startWorkflowForRequest ran for a source 'desk' ticket");
    const runs = await runsOn(t.id);
    assert.equal(runs.length, 1);
    const note = (await msgs(t.id)).find((x) => x.kind === "internal" && x.body.startsWith("Workflow started by Sam Lee"));
    assert.ok(note);
    const a = (await pool().query("SELECT details FROM audit_log WHERE actor_id = $1 AND action = 'helpdesk.workflow_run.started' AND target_id = $2", [P.sam.id, String(t.number)])).rows;
    assert.equal(a.length, 1);
    assert.equal(a[0].details.mode, "new_ticket");
  });

  test("required answers, the capability and the requester's types are enforced", async () => {
    const missing = await newTicket("sam", { requester_id: P.req.id, subject: `${STAMP} x`, request_type_id: RT.Laptop, answers: {} });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, '"Model" is required.');
    const nb = await newTicket("newbie", { requester_id: P.req.id, subject: `${STAMP} x`, request_type_id: RT.Laptop, answers: { model: "x" } });
    assert.equal(nb.status, 403, "a Newbie can't start a workflow");
    const outsider = await newTicket("sam", { requester_id: P.req2.id, subject: `${STAMP} x`, request_type_id: RT.Restricted, answers: { model: "x" } });
    assert.equal(outsider.status, 400);
    assert.match(outsider.body.error, /isn't a request type Rosa Outsider can use/);
    // A type with no workflow is filed as before, by anyone who files tickets.
    const plain = await newTicket("newbie", { requester_id: P.req.id, subject: `${STAMP} plain`, request_type_id: RT.Plain, answers: {} });
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    ticketIds.push(plain.body.ticket.id);
    assert.equal((await row(plain.body.ticket.id)).workflow_run_id, null);
  });
});

// --- Live and sweep ---------------------------------------------------------------------------------

describe("the desk hears it, and old keys go", () => {
  test("the queue triggers see the change (1.20.19)", async () => {
    for (const c of ["request_type_id", "workflow_run_id", "updated_at"]) assert.ok((LIVE_COLUMNS as readonly string[]).includes(c), c);
    const t = await raise("live");
    const listener = new Client({ connectionString: process.env.DATABASE_URL });
    await listener.connect();
    const heard: string[] = [];
    listener.on("notification", (n) => heard.push(n.payload ?? ""));
    await listener.query("LISTEN hd_queue_live");
    try {
      const r = await start("sam", t.number, { request_type_id: RT.Laptop, answers: { model: "live" }, client_start_id: key(), expect: "this" });
      assert.equal(r.status, 200);
      const until = Date.now() + 3000;
      while (!heard.some((p) => p.split(",")[2] === String(T.A)) && Date.now() < until) await new Promise((res) => setTimeout(res, 50));
      const triggers = (await pool().query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'hd_tickets_live_update'")).rows[0].n;
      if (triggers > 0) assert.ok(heard.some((p) => p.split(",")[2] === String(T.A)), `a notify for team ${T.A}: ${JSON.stringify(heard.slice(0, 5))}`);
    } finally {
      await listener.end();
    }
  });

  test("the sweep forgets keys older than a day", async () => {
    const t = await raise("sweep");
    await pool().query(
      "INSERT INTO hd_workflow_start_ids (user_id, ticket_id, client_start_id, request_ticket_id, mode, created_at) VALUES ($1, $2, 'old-key-0123456789', $2, 'this', now() - interval '25 hours'), ($1, $2, 'new-key-0123456789', $2, 'this', now())",
      [P.sam.id, t.id]
    );
    await ws.sweepStartIds();
    const left = (await pool().query("SELECT client_start_id FROM hd_workflow_start_ids WHERE ticket_id = $1 ORDER BY 1", [t.id])).rows.map((r) => r.client_start_id);
    assert.deepEqual(left, ["new-key-0123456789"]);
  });
});

// --- 1.20.21 security review -----------------------------------------------------------------------

/** Hold ticket `id`'s row lock on a connection of its own until `release()`; `waiting()` resolves once another backend queues behind it. */
async function holdTicketLock(id: number) {
  const c = await pool().connect();
  await c.query("BEGIN");
  await c.query("SELECT 1 FROM hd_tickets WHERE id = $1 FOR UPDATE", [id]);
  const pid = (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
  return {
    waiting: async () => {
      for (let i = 0; i < 200; i++) {
        const r = await pool().query("SELECT 1 FROM pg_locks WHERE NOT granted AND pid <> $1 AND locktype IN ('transactionid', 'tuple') LIMIT 1", [pid]);
        if (r.rows.length) return;
        await new Promise((res) => setTimeout(res, 25));
      }
      throw new Error("nobody queued behind the lock");
    },
    release: async () => {
      await c.query("COMMIT");
      c.release();
    },
  };
}

describe("security review: a new request goes only where the agent may open one (2)", () => {
  test("a type of another team: offered on this ticket, not for a new request; refused 403 there", async () => {
    await makeType("Elsewhere", { workflow: "published", team: "B" });
    // On this ticket the request stays in team A: offered.
    const fresh = await raise("elsewhere this");
    assert.ok((await options("sam", fresh.number)).body.types.some((x: any) => x.id === RT.Elsewhere));
    // A typed ticket (a new request would go to team B, which Sam doesn't work): not offered, and refused.
    const t = await raise("elsewhere new", { request_type_id: RT.Plain });
    const o = await options("sam", t.number);
    assert.equal(o.body.mode, "new");
    assert.ok(!o.body.types.some((x: any) => x.id === RT.Elsewhere));
    assert.ok(o.body.types.some((x: any) => x.id === RT.Laptop), "team A's types still are");
    const r = await start("sam", t.number, { request_type_id: RT.Elsewhere, answers: { model: "x" }, client_start_id: key(), expect: "new" });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /only open tickets for your own teams/);
    assert.equal((await startedFrom(t.id)).length, 0, "nothing opened");
    // An admin works every team.
    const a = await start("admin", t.number, { request_type_id: RT.Elsewhere, answers: { model: "x" }, client_start_id: key(), expect: "new" });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const made = await startedFrom(t.id);
    assert.equal(made.length, 1);
    assert.equal(made[0].team_id, T.B);
  });
});

describe("security review: no hidden directory value is prefilled for someone else (1)", () => {
  test("an admins-only field is left out for an agent, kept for the requester and a directory admin", async () => {
    fieldKey = `hdws_${process.pid}_${Date.now().toString(36)}`;
    await pool().query("INSERT INTO directory_fields (key, label, visibility) VALUES ($1, 'Secret code', 'admins')", [fieldKey]);
    const dp = await pool().query("INSERT INTO directory_people (name, email, department, custom) VALUES ($1, $2, 'Finance', $3::jsonb) RETURNING id", [
      `${STAMP} Daniel`,
      `${STAMP}-dp@example.test`,
      JSON.stringify({ [fieldKey]: "S3CRET" }),
    ]);
    await pool().query("UPDATE users SET directory_person_id = $2 WHERE id = $1", [P.req.id, dp.rows[0].id]);
    await makeType("Directory", {
      workflow: "published",
      form: [
        { key: "model", label: "Model", type: "text", required: true },
        { key: "dept", label: "Department", type: "text", default_from: "directory:department" },
        { key: "code", label: "Code", type: "text", default_from: `directory:${fieldKey}` },
      ],
    });
    const t = await raise("directory");
    const o = await options("sam", t.number);
    const d = o.body.types.find((x: any) => x.id === RT.Directory);
    assert.deepEqual(d.defaults, { dept: "Finance" }, "the admins-only value never reaches the agent");
    const nt = await call(typesRoute.GET, "sam", `/tickets/request-types?requester_id=${P.req.id}`);
    assert.deepEqual(nt.body.request_types.find((x: any) => x.id === RT.Directory).defaults, { dept: "Finance" });
    const form = (await requestTypes.getRequestType(RT.Directory))!.form;
    assert.deepEqual(await detail.directoryDefaults(P.req.id, form), { dept: "Finance", code: "S3CRET" }, "Get help: their own entry, whole");
    assert.deepEqual(await detail.directoryDefaults(P.req.id, form, { viewer: { id: P.req.id, role: "viewer" } }), { dept: "Finance", code: "S3CRET" });
    assert.deepEqual(await detail.directoryDefaults(P.req.id, form, { viewer: { id: P.admin.id, role: "admin" } }), { dept: "Finance", code: "S3CRET" }, "a directory admin sees it");
  });
});

describe("security review: portal contacts get the portal's types and portal tickets (3)", () => {
  const LOCK = 728661;
  let lockClient: import("pg").PoolClient | null = null;
  let saved: string | undefined;

  before(async () => {
    // The portal's settings are one workspace key: written under helpdesk-portal.test's advisory lock and put back.
    lockClient = await pool().connect();
    await lockClient.query("SELECT pg_advisory_lock($1)", [LOCK]);
    saved = await getSetting(portalLib.HD_PORTAL_SETTINGS_KEY);
    await makeType("Portal", { workflow: "published" });
    await setSetting(portalLib.HD_PORTAL_SETTINGS_KEY, JSON.stringify(portalLib.cleanPortalSettings({ enabled: true, access: "anyone", types: [{ id: RT.Portal, team_id: null }] })));
  });

  after(async () => {
    if (saved === undefined) await pool().query("DELETE FROM settings WHERE key = $1", [portalLib.HD_PORTAL_SETTINGS_KEY]);
    else await setSetting(portalLib.HD_PORTAL_SETTINGS_KEY, saved);
    await lockClient?.query("SELECT pg_advisory_unlock($1)", [LOCK]);
    lockClient?.release();
  });

  async function portalTicket(subject: string, typeId?: number) {
    const addr = `${STAMP}-cust-${contactIds.length}@clientco.test`;
    const c = (await pool().query("INSERT INTO hd_portal_contacts (email, name) VALUES ($1, 'Casey Customer') RETURNING id", [addr])).rows[0].id as number;
    contactIds.push(c);
    const t = await raise(subject, { request_type_id: typeId });
    await pool().query(
      "UPDATE hd_tickets SET requester_id = NULL, requester_name = 'Casey Customer', requester_email = $2, portal_contact_id = $3, source = 'portal_external' WHERE id = $1",
      [t.id, addr, c]
    );
    return { ...t, contact: c, email: addr };
  }

  test("only the portal's offered types, never the workspace's everyone-types", async () => {
    const t = await portalTicket("portal offered");
    const o = await options("sam", t.number);
    assert.equal(o.body.eligible, true, JSON.stringify(o.body));
    assert.equal(o.body.requester.portal, true);
    assert.deepEqual(ours(o.body.types), ["Portal"]);
    assert.deepEqual(o.body.types[0].defaults, {}, "no directory prefill outside the directory");
    const r = await start("sam", t.number, { request_type_id: RT.Laptop, answers: { model: "x" }, client_start_id: key(), expect: "this" });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "request_type_unavailable");
    const ok = await start("sam", t.number, { request_type_id: RT.Portal, answers: { model: "x" }, client_start_id: key(), expect: "this" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.started, true);
    assert.equal((await row(t.id)).source, "portal_external", "still the contact's portal ticket");
  });

  test("a new request for a portal contact is a portal ticket of theirs", async () => {
    const t = await portalTicket("portal new", RT.Plain);
    const r = await start("sam", t.number, { request_type_id: RT.Portal, answers: { model: "x" }, client_start_id: key(), expect: "new" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.started, true);
    const n = (await startedFrom(t.id))[0];
    assert.equal(n.portal_contact_id, t.contact, "the contact sees it in the portal");
    assert.equal(n.source, "portal_external");
    assert.equal(n.requester_id, null);
    assert.equal(n.requester_email, t.email);
    assert.equal((await runsOn(n.id)).length, 1);
  });

  test("a blocked contact is offered nothing", async () => {
    const t = await portalTicket("portal blocked");
    await pool().query("UPDATE hd_portal_contacts SET blocked = 1 WHERE id = $1", [t.contact]);
    const o = await options("sam", t.number);
    assert.equal(o.body.eligible, false);
    assert.match(o.body.reason, /blocked from the customer portal/);
  });
});

describe("security review: a start that didn't run says why, and can be retried on the ticket (6)", () => {
  test("a ticket left typed by a desk start with no run offers `this` again, and the retry runs on it", async () => {
    const t = await raise("retry");
    // A start still on its way (its mark, no run yet, not failed): never a retry.
    await pool().query(
      `UPDATE hd_tickets SET request_type_id = $2, form_answers = '{"model":"old"}'::jsonb,
              source_ref = source_ref || jsonb_build_object('desk_workflow_start', jsonb_build_object('request_type_id', $2::int, 'by', $3::int, 'at', now()::text))
        WHERE id = $1`,
      [t.id, RT.Laptop, P.sam.id]
    );
    assert.equal((await options("sam", t.number)).body.mode, "new");
    // What a failed start leaves: the mark says it failed, no run.
    await pool().query("UPDATE hd_tickets SET source_ref = jsonb_set(source_ref, '{desk_workflow_start,failed}', 'true'::jsonb) WHERE id = $1", [t.id]);
    const o = await options("sam", t.number);
    assert.equal(o.body.mode, "this");
    const r = await start("sam", t.number, { request_type_id: RT.Laptop, answers: { model: "new" }, client_start_id: key(), expect: "this" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mode, "this");
    assert.equal(r.body.started, true);
    assert.equal(r.body.request.number, t.number);
    assert.deepEqual((await row(t.id)).form_answers, { model: "new" });
    assert.equal((await startedFrom(t.id)).length, 0);
    // A type set some other way stays `new` (a Plain request isn't re-typed under its requester).
    const typed = await raise("typed other", { request_type_id: RT.Plain });
    assert.equal((await options("sam", typed.number)).body.mode, "new");
  });

  test("startModeFor: a type set by a desk start that's over with no run is `this`; one on its way, any other type, or a run, is `new`", () => {
    const now = Date.parse("2026-11-16T12:00:00Z");
    const mark = { desk_workflow_start: { request_type_id: 5, by: 1, failed: true } };
    const fresh = { desk_workflow_start: { request_type_id: 5, by: 1, at: "2026-11-16T11:59:30Z" } };
    const stale = { desk_workflow_start: { request_type_id: 5, by: 1, at: "2026-11-16T11:57:00Z" } };
    assert.equal(ws.startModeFor({ request_type_id: null, workflow_run_id: null }, false), "this");
    assert.equal(ws.startModeFor({ request_type_id: 5, workflow_run_id: null, source_ref: mark }, false), "this");
    assert.equal(ws.startModeFor({ request_type_id: 5, workflow_run_id: null, source_ref: fresh }, false, now), "new", "a start still on its way");
    assert.equal(ws.startModeFor({ request_type_id: 5, workflow_run_id: null, source_ref: stale }, false, now), "this", "one that died on the way");
    assert.equal(ws.startModeFor({ request_type_id: 6, workflow_run_id: null, source_ref: mark }, false), "new", "a type set some other way");
    assert.equal(ws.startModeFor({ request_type_id: 5, workflow_run_id: null, source_ref: {} }, false), "new");
    assert.equal(ws.startModeFor({ request_type_id: 5, workflow_run_id: null, source_ref: mark }, true), "new");
    assert.equal(ws.startModeFor({ request_type_id: 5, workflow_run_id: 9, source_ref: mark }, false), "new");
  });

  test("the not-started reasons are told apart: no workflow, an error, solved first", async () => {
    const t = await raise("reasons", { request_type_id: RT.Plain });
    assert.match((await ws.whyNotStarted(t.id, RT.Plain, null))!, /no longer published/);
    assert.match((await ws.whyNotStarted(t.id, RT.Laptop, new Error("boom")))!, /something went wrong/);
    assert.match((await ws.whyNotStarted(t.id, RT.Laptop, null))!, /didn't start\. Try Start a workflow again/);
    await tickets.updateTicket(t.id, { status: "solved" }, { id: P.sam.id, name: P.sam.name }, { silent: true });
    assert.match((await ws.whyNotStarted(t.id, RT.Laptop, null))!, /was solved before its workflow could start/);
  });
});

describe("security review: answers are checked again under the lock (7)", () => {
  test("a question made required while the start waited for the lock: refused, nothing written", async () => {
    await makeType("Grows", { workflow: "published", form: [{ key: "model", label: "Model", type: "text", required: true }] });
    const t = await raise("grows");
    const agent = await agentOf("sam");
    const lock = await holdTicketLock(t.id);
    let pending: Promise<Awaited<ReturnType<typeof ws.startWorkflowFromTicket>>>;
    try {
      pending = ws.startWorkflowFromTicket(agent, t.id, { request_type_id: RT.Grows, answers: { model: "x" }, client_start_id: key(), expect: "this" });
      await lock.waiting();
      // While it waits (its first check passed), the form gains a required question.
      await pool().query("UPDATE hd_request_types SET form = $2::jsonb WHERE id = $1", [
        RT.Grows,
        JSON.stringify([{ key: "model", label: "Model", type: "text", required: true }, { key: "serial", label: "Serial", type: "text", required: true }]),
      ]);
    } finally {
      await lock.release();
    }
    const out = await pending!;
    assert.equal(out.ok, false, JSON.stringify(out));
    if (!out.ok) {
      assert.equal(out.status, 400);
      assert.equal(out.error, '"Serial" is required.');
    }
    assert.equal((await row(t.id)).request_type_id, null, "nothing written");
    assert.equal((await runsOn(t.id)).length, 0);
  });
});
