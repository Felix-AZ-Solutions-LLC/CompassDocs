// Helpdesk 1.20.14: Claude tools for desk checklists.
//
//   - hd_draft_checklist (the Claude connector) saves a checklist DRAFT: a
//     new unpublished template (in no picker, added by no request type,
//     named by no workflow task) or changes proposed beside a published one;
//     validation is the settings API's; a person publishes or discards it in
//     Desk settings → Checklists (the admin routes); hd_list_checklists reads.
//   - hd_update_checklist ticks / unticks items and adds a library checklist
//     on a ticket as the agent: the desk route's own library function
//     (tickItemsAs / addChecklistAs), so the same rules (works the ticket,
//     newbies too, the recycle bin hides it, legal hold doesn't stop it,
//     closed and merged are read-only), the same timeline lines and audit
//     rows, plus the Claude marker. Solving stays gated by required items.
//   - Claude in the desk: propose_checklist_ticks and draft_checklist give
//     cards; Apply / Save as draft go through the desk's own routes with
//     via "claude_desk". One full turn on the fake Anthropic server.
//   - The admin switches: the connector level (draft = notes, tick =
//     update) and Claude in the desk's caps (draft = drafts, tick = changes)
//     list or hide the tools on both surfaces.
//
// Harness as test/helpdesk-checklists and test/helpdesk-claude-desk:
// next/headers and lib/ee stubbed, routes called with real sessions, the
// fake Anthropic server for the turn. Parallel-safe: everything is this
// file's own (STAMP); role matrix, connector level and desk config are
// overridden in-process only.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-checklist-mcp.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession, getUserById } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";
import { startFakeAnthropic, type FakeAnthropic } from "./support/fake-anthropic";

process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";

let currentRequest: Request | null = null;
function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.checklist-mcp.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.checklist-mcp.virtual.js");
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
  ee.exports = { ee: () => edition, eePresent: () => true, featureEnabled: async (f: string) => edition.features.includes(f) };
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
const { toSessionUser } = require("../src/lib/auth") as typeof import("../src/lib/auth");
const checklists = require("../src/lib/helpdesk/checklists") as typeof import("../src/lib/helpdesk/checklists");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const rolesShared = require("../src/lib/helpdesk/roles-shared") as typeof import("../src/lib/helpdesk/roles-shared");
const connector = require("../src/lib/helpdesk/claude-connector") as typeof import("../src/lib/helpdesk/claude-connector");
const hdTools = require("../src/lib/mcp/helpdesk-tools") as typeof import("../src/lib/mcp/helpdesk-tools");
const aiConfig = require("../src/lib/ai-config") as typeof import("../src/lib/ai-config");
const config = require("../src/lib/helpdesk/claude/config") as typeof import("../src/lib/helpdesk/claude/config");
const desk = require("../src/lib/helpdesk/claude/shared") as typeof import("../src/lib/helpdesk/claude/shared");
const prompt = require("../src/lib/helpdesk/claude/prompt") as typeof import("../src/lib/helpdesk/claude/prompt");
const deskTools = require("../src/lib/helpdesk/claude/tools") as typeof import("../src/lib/helpdesk/claude/tools");
const turnLib = require("../src/lib/helpdesk/claude/turn") as typeof import("../src/lib/helpdesk/claude/turn");
const adminRoute = require("../src/app/api/helpdesk/admin/checklists/route") as typeof import("../src/app/api/helpdesk/admin/checklists/route");
const adminOneRoute = require("../src/app/api/helpdesk/admin/checklists/[id]/route") as typeof import("../src/app/api/helpdesk/admin/checklists/[id]/route");
const libraryRoute = require("../src/app/api/helpdesk/checklists/route") as typeof import("../src/app/api/helpdesk/checklists/route");
const ticketListsRoute = require("../src/app/api/helpdesk/tickets/[number]/checklists/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/checklists/route");
const itemRoute = require("../src/app/api/helpdesk/tickets/[number]/checklists/items/[itemId]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/checklists/items/[itemId]/route");
const cardRoute = require("../src/app/api/helpdesk/claude/cards/[id]/route") as typeof import("../src/app/api/helpdesk/claude/cards/[id]/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdRole } from "../src/lib/helpdesk/roles-shared";
import type { ClaudeDeskConfig, ClaudeStreamEvent } from "../src/lib/helpdesk/claude/shared";

const STAMP = `hdckm-${Date.now()}-${process.pid}`;
const IP = "203.0.113.141";
const CTX = { origin: "http://localhost", ip: IP };

interface Person {
  id: number;
  name: string;
  session: string;
}
const P: Record<string, Person> = {};
const userIds: number[] = [];
const roleIds: number[] = [];
const ticketIds: number[] = [];
const typeIds: number[] = [];
const T: Record<string, number> = {};
let fake: FakeAnthropic;

const CFG = (patch: Partial<ClaudeDeskConfig> = {}): ClaudeDeskConfig => ({
  ...desk.CLAUDE_DESK_DEFAULTS,
  enabled: true,
  teams_off: [T.Off],
  caps: { read: true, search: true, web: false, changes: true, drafts: true },
  ...patch,
});

async function person(key: string, deskRole: HdRole | null, teams: string[] = []) {
  const name = `${key} ${STAMP}`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status, timezone) VALUES ($1, $2, $3, 'viewer', 'active', 'UTC') RETURNING id`, [
    `${STAMP}-${key}`,
    name,
    `${STAMP}-${key}@example.test`,
  ]);
  const id = r.rows[0].id as number;
  userIds.push(id);
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  const role = await fixtureQuery("INSERT INTO roles (key, name) VALUES ($1, $1) RETURNING id", [`${STAMP}-req-${key}`]);
  roleIds.push(role.rows[0].id);
  await fixtureQuery("INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'helpdesk.request')", [role.rows[0].id]);
  await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [role.rows[0].id, id]);
  if (deskRole) await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [id, deskRole]);
  for (const tm of teams) await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent') ON CONFLICT DO NOTHING", [T[tm], id]);
  P[key] = { id, name, session };
}

async function ticket(subject: string, team = "A", extra: Record<string, unknown> = {}): Promise<{ id: number; number: number }> {
  const r = await pool().query(
    "INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status, source, request_type_id) VALUES ($1, $2, 'Req', $3, $4, 'open', 'portal', $5) RETURNING id, number",
    [`${subject} ${STAMP}`, P.req.id, `${STAMP}-req@example.test`, T[team], extra.request_type_id ?? null]
  );
  ticketIds.push(r.rows[0].id);
  return r.rows[0];
}

const user = async (who: string) => (await getUserById(P[who].id))!;
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
const listed = async (who: string) => (await hdTools.helpdeskToolsFor(await user(who))).map((t) => t.name);

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

const tickRoute = (who: string, n: number, itemId: number, body: Record<string, unknown>) =>
  call(itemRoute.PATCH, who, `/tickets/${n}/checklists/items/${itemId}`, "PATCH", body, { number: String(n), itemId: String(itemId) });
const lines = async (ticketId: number) => (await pool().query("SELECT kind, body FROM hd_messages WHERE ticket_id = $1 ORDER BY id", [ticketId])).rows as { kind: string; body: string }[];
const auditRows = async (action: string, actor: number, targetId?: number) =>
  (
    await pool().query(
      `SELECT details, ip FROM audit_log WHERE action = $1 AND actor_id = $2${targetId ? " AND target_id = $3" : ""} ORDER BY id`,
      targetId ? [action, actor, targetId] : [action, actor]
    )
  ).rows as { details: Record<string, unknown>; ip: string | null }[];
const tplRow = async (id: number) =>
  (await pool().query("SELECT name, items, request_type_ids, published, draft, draft_by_name, draft_via FROM hd_checklist_templates WHERE id = $1", [id])).rows[0];
const myTemplates = async () => Number((await pool().query("SELECT count(*)::int AS n FROM hd_checklist_templates WHERE name LIKE $1", [`%${STAMP}%`])).rows[0].n);
const statusOf = async (id: number) => (await pool().query("SELECT status FROM hd_tickets WHERE id = $1", [id])).rows[0].status as string;

/** A published library checklist made the way Desk settings makes it. */
async function liveTemplate(name: string, items: Record<string, unknown>[], request_type_ids: number[] = []): Promise<number> {
  const t = await checklists.createTemplate({ name: `${name} ${STAMP}`, items, request_type_ids }, { id: P.manager.id, name: P.manager.name });
  return t.id;
}

/** A ticket with the template on it (added by the manager, by hand); its items. */
async function withChecklist(subject: string, tpl: number, team = "A") {
  const t = await ticket(subject, team);
  await checklists.addChecklistToTicket(t.id, tpl, { id: P.manager.id, name: P.manager.name });
  const lists = await checklists.ticketChecklists(t.id);
  return { t, list: lists[0], items: lists[0].items };
}

const LEAVER = [
  { title: "Disable sign-in on the leaving date", required: true },
  { title: "Transfer OneDrive files to the manager" },
  { title: "Collect the laptop and badge", due_days: 2 },
];

function toolCtx(u: Awaited<ReturnType<typeof user>>, cfg = CFG(), open: import("../src/lib/helpdesk/types").HdTicket | null = null) {
  return { user: u, session: toSessionUser(u), origin: "http://localhost", ip: IP, cfg, chatId: 0, ticket: open, includeNotes: false, touched: new Set<number>(), notesSeen: [] as string[] };
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  fake = await startFakeAnthropic();
  process.env.COMPASSDOCS_ANTHROPIC_BASE_URL = fake.url;
  aiConfig.setAiConfigForTests({ key: "sk-ant-fake-test", model: "claude-opus-5-5", provider: "anthropic" });
  roles.setRoleMatrixForTests(rolesShared.HD_DEFAULT_MATRIX);
  turnLib.setClaudeTurnLimitsForTests({ minute: 1000, hour: 1000 });
  for (const k of ["A", "B", "Off"]) T[k] = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9450) RETURNING id", [`${STAMP} ${k}`])).rows[0].id;
  await person("agent", "agent", ["A", "Off"]);
  await person("newbie", "newbie", ["A"]);
  await person("lead", "team_lead", ["A"]);
  await person("outsider", "agent", ["B"]);
  await person("manager", "manager", ["A"]);
  await person("dadmin", "admin", ["A"]);
  await person("req", null);
  // Set after the teams exist (CFG reads T.Off).
  config.setClaudeDeskConfigForTests(CFG());
  connector.setClaudeLevelForTests("update");
  const rt = await fixtureQuery("INSERT INTO hd_request_types (slug, title, team_id, active) VALUES ($1, $2, $3, 1) RETURNING id", [`${STAMP}-leaver`, `Leaver ${STAMP}`, T.A]);
  typeIds.push(rt.rows[0].id);
});

after(async () => {
  aiConfig.setAiConfigForTests(null);
  config.setClaudeDeskConfigForTests(null);
  connector.setClaudeLevelForTests(null);
  roles.setRoleMatrixForTests(null);
  turnLib.setClaudeTurnLimitsForTests(null);
  delete process.env.COMPASSDOCS_ANTHROPIC_BASE_URL;
  await fake.close();
  await pool().query("DELETE FROM hd_claude_usage WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_claude_chats WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_claude_chat_tickets WHERE ticket_id = ANY($1)", [ticketIds]);
  await pool().query("UPDATE hd_tickets SET merged_into = NULL WHERE id = ANY($1)", [ticketIds]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1) OR requester_id = ANY($2)", [ticketIds, userIds]);
  await pool().query("DELETE FROM hd_checklist_templates WHERE name LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM hd_request_types WHERE id = ANY($1)", [typeIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [Object.values(T)]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE role_id = ANY($1)", [roleIds]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// --- Drafting (the connector) --------------------------------------------------------------

describe("hd_draft_checklist: a draft a person publishes", () => {
  let draftId = 0;

  test("a new draft is saved unpublished, offered nowhere, audited via Claude and in Recent activity", async () => {
    const rt = typeIds[0];
    const r = await tool("manager", "hd_draft_checklist", {
      name: `Leaver: IT ${STAMP}`,
      items: [
        { title: "Disable sign-in on the leaving date", required: true },
        { title: "Transfer OneDrive files", team_id: T.B, due_days: 1 },
        { title: "Collect the laptop", due_days: 0 },
      ],
      request_type_ids: [rt],
    });
    assert.equal(r.isError, false, r.text);
    draftId = r.out.id;
    assert.equal(r.out.published, false);
    assert.equal(r.out.saved, "draft (not published)");
    assert.equal(r.out.items, 3);
    assert.match(r.out.note, /publishes it in Desk settings → Checklists/);
    assert.equal(r.out.edit_url, `http://localhost/desk/settings/checklists?id=${draftId}`);
    const row = await tplRow(draftId);
    assert.equal(row.published, 0);
    assert.equal(row.draft, null);
    assert.equal(row.draft_via, "mcp");
    assert.equal(row.draft_by_name, P.manager.name);
    assert.deepEqual(row.items[1], { key: "i2", title: "Transfer OneDrive files", team_id: T.B, due_days: 1 });

    // Offered nowhere: not in the picker, not by its request type, not to a workflow task, not by hand.
    assert.ok(!(await checklists.templateOptions()).some((o) => o.id === draftId));
    const lib = await call(libraryRoute.GET, "agent", "/checklists");
    assert.ok(!lib.body.templates.some((x: { id: number }) => x.id === draftId), "the agents' library leaves drafts out");
    const t = await ticket("Leaver Sam", "A", { request_type_id: rt });
    assert.equal(await checklists.addRequestTypeChecklists(t.id), 0, "the request type adds no draft");
    const byHand = await call(ticketListsRoute.POST, "agent", `/tickets/${t.number}/checklists`, "POST", { template_id: draftId }, { number: String(t.number) });
    assert.equal(byHand.status, 409);
    assert.match(byHand.body.error, /still a draft/);
    assert.match((await checklists.missingChecklistRef([draftId], "Laptop")) ?? "", /still a draft/);
    const viaTool = await tool("agent", "hd_update_checklist", { number: t.number, add_template_id: draftId });
    assert.equal(viaTool.isError, true);
    assert.match(viaTool.text, /No library checklist with id/);
    assert.equal((await checklists.ticketChecklists(t.id)).length, 0);

    const a = await auditRows("helpdesk.checklist_template.created", P.manager.id, draftId);
    assert.equal(a.length, 1);
    assert.deepEqual(a[0].details, { items: 3, required: 1, request_type_ids: [rt], draft: true, published: false, via: "mcp" });
    assert.equal(a[0].ip, IP);
    const activity = await connector.recentClaudeActivity(100);
    assert.ok(activity.some((x) => x.actor_id === P.manager.id && x.summary === `Saved a checklist draft: Leaver: IT ${STAMP}`));
  });

  test("validation mirrors Desk settings: plain sentences, nothing saved", async () => {
    const before = await myTemplates();
    const bad = async (args: Record<string, unknown>) => {
      const r = await tool("manager", "hd_draft_checklist", args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.text, /Nothing was saved\.$|^No checklist with id/);
      return r.text;
    };
    assert.match(await bad({ items: [{ title: "a" }] }), /^Give the checklist a name\./);
    assert.match(await bad({ name: `x ${STAMP}`, items: [] }), /Add at least one item/);
    assert.match(await bad({ name: `x ${STAMP}` }), /Add at least one item/);
    assert.match(await bad({ name: "y".repeat(121), items: [{ title: "a" }] }), /under 120 characters/);
    assert.match(await bad({ name: `x ${STAMP}`, items: Array.from({ length: 51 }, (_, i) => ({ title: `s${i}` })) }), /up to 50 items/);
    assert.match(await bad({ name: `x ${STAMP}`, items: [{ title: "z".repeat(301) }] }), /Item 1 is longer than 300 characters/);
    assert.match(await bad({ name: `x ${STAMP}`, items: [{ title: "a" }, { title: "" }] }), /Item 2 needs a title/);
    assert.match(await bad({ name: `x ${STAMP}`, items: [{ title: "a", due_days: 61 }] }), /0 to 60 business days/);
    assert.match(await bad({ name: `x ${STAMP}`, items: [{ title: "a", required: "yes" }] }), /Required is yes or no/);
    assert.match(await bad({ name: `x ${STAMP}`, items: [{ title: "a", team_id: 99999999 }] }), /owner teams no longer exists/);
    assert.match(await bad({ name: `x ${STAMP}`, items: [{ title: "a" }], request_type_ids: [99999999] }), /request types no longer exists/);
    assert.match(await bad({ name: `x ${STAMP}`, items: [{ title: "a" }], request_type_ids: "1" }), /Request types are a list of ids/);
    assert.match(await bad({ id: 99999999, name: `x ${STAMP}` }), /^No checklist with id 99999999\./);
    assert.equal(await myTemplates(), before, "nothing was saved");
  });

  test("the draft is listed for review; a person edits it, then publishing makes it a real template", async () => {
    const list = await call(adminRoute.GET, "manager", "/admin/checklists");
    assert.equal(list.status, 200);
    const row = list.body.templates.find((x: { id: number }) => x.id === draftId);
    assert.equal(row.published, false);
    assert.equal(row.draft_by_name, P.manager.name);
    assert.deepEqual(row.added_to, [`Request type Leaver ${STAMP} (once published)`]);
    const read = await tool("manager", "hd_list_checklists", {});
    assert.equal(read.out.checklists.find((x: { id: number }) => x.id === draftId).status, "draft (not published)");
    assert.ok(read.out.teams.some((x: { id: number }) => x.id === T.A));
    assert.ok(read.out.request_types.some((x: { id: number }) => x.id === typeIds[0]));

    // Save without publishing: still a draft.
    const save = await call(adminOneRoute.PUT, "manager", `/admin/checklists/${draftId}`, "PUT", { name: `Leaver: IT v2 ${STAMP}` }, { id: String(draftId) });
    assert.equal(save.status, 200, JSON.stringify(save.body));
    assert.equal(save.body.template.published, false);
    assert.equal(save.body.template.items.length, 3, "items kept");
    assert.equal((await checklists.templateOptions()).some((o) => o.id === draftId), false);
    // An agent can't publish.
    assert.equal((await call(adminOneRoute.PUT, "agent", `/admin/checklists/${draftId}`, "PUT", { publish: true }, { id: String(draftId) })).status, 403);
    const pub = await call(adminOneRoute.PUT, "manager", `/admin/checklists/${draftId}`, "PUT", { publish: true }, { id: String(draftId) });
    assert.equal(pub.status, 200);
    assert.equal(pub.body.template.published, true);
    assert.equal(pub.body.template.draft_by_name, "");
    const audit = await auditRows("helpdesk.checklist_template.published", P.manager.id, draftId);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].details.drafted_via, "mcp");
    assert.equal(audit[0].details.drafted_by, P.manager.name);

    // Now it is real: offered, added by its request type, addable by hand, valid in a workflow.
    assert.ok((await checklists.templateOptions()).some((o) => o.id === draftId));
    const t = await ticket("Leaver Kim", "A", { request_type_id: typeIds[0] });
    assert.equal(await checklists.addRequestTypeChecklists(t.id), 1);
    assert.equal(await checklists.missingChecklistRef([draftId], "Laptop"), null);
    const lists = await checklists.ticketChecklists(t.id);
    assert.equal(lists[0].name, `Leaver: IT v2 ${STAMP}`);
    assert.equal(lists[0].required_open, 1);
  });

  test("changes to a published checklist wait beside it; discarding keeps the live one; publishing applies them", async () => {
    const live = await liveTemplate("Starter", [{ title: "Order a laptop", required: true }, { title: "Create accounts" }]);
    const r = await tool("manager", "hd_draft_checklist", { id: live, items: [{ title: "Order a laptop", required: true }, { title: "Create accounts" }, { title: "Book a welcome call" }] });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.out.saved, "draft of changes (the live checklist is unchanged)");
    assert.equal(r.out.published, true);
    let row = await tplRow(live);
    assert.equal(row.items.length, 2, "the live copy is unchanged");
    assert.equal(row.draft.items.length, 3);
    assert.equal(row.draft.name, `Starter ${STAMP}`, "fields not sent come from the live copy");
    const upd = await auditRows("helpdesk.checklist_template.updated", P.manager.id, live);
    assert.deepEqual(upd.at(-1)!.details, { changed: ["draft"], items: 3, required: 1, request_type_ids: [], draft: true, published: true, via: "mcp" });
    // A ticket still gets the live copy.
    const { items } = await withChecklist("Starter Pat", live);
    assert.equal(items.length, 2);
    const one = await tool("manager", "hd_list_checklists", { id: live });
    assert.equal(one.out.status, "published, with changes waiting for review");
    assert.equal(one.out.items.length, 2);
    assert.equal(one.out.draft.items.length, 3);
    assert.equal(one.out.draft.asked_by, P.manager.name);

    // Discard: the draft goes, the live copy stays; a second discard has nothing to drop.
    const gone = await call(adminOneRoute.PUT, "manager", `/admin/checklists/${live}`, "PUT", { discard_draft: true }, { id: String(live) });
    assert.equal(gone.status, 200);
    assert.equal(gone.body.template.draft, null);
    assert.equal(gone.body.template.items.length, 2);
    assert.equal((await call(adminOneRoute.PUT, "manager", `/admin/checklists/${live}`, "PUT", { discard_draft: true }, { id: String(live) })).status, 409);
    assert.equal((await auditRows("helpdesk.checklist_template.draft_discarded", P.manager.id, live)).length, 1);

    // Draft again, then the person saves what the editor shows (the draft): published.
    await tool("manager", "hd_draft_checklist", { id: live, name: `Starter v2 ${STAMP}` });
    row = await tplRow(live);
    assert.equal(row.draft.items.length, 2);
    const pub = await call(adminOneRoute.PUT, "manager", `/admin/checklists/${live}`, "PUT", { items: [...row.draft.items, { title: "Book a welcome call" }] }, { id: String(live) });
    assert.equal(pub.status, 200);
    assert.equal(pub.body.template.name, `Starter v2 ${STAMP}`, "the draft's name, as the editor showed it");
    assert.equal(pub.body.template.items.length, 3);
    assert.equal(pub.body.template.draft, null);
    assert.equal((await auditRows("helpdesk.checklist_template.published", P.manager.id, live)).length, 1);
  });

  test("who may draft: Manager and Admin (checklist access); requester, agent, team lead, newbie and the unlicensed may not", async () => {
    for (const who of ["manager", "dadmin"]) {
      const names = await listed(who);
      assert.ok(names.includes("hd_draft_checklist") && names.includes("hd_list_checklists"), who);
    }
    for (const who of ["req", "agent", "lead", "newbie", "outsider"]) {
      const names = await listed(who);
      assert.ok(!names.includes("hd_draft_checklist") && !names.includes("hd_list_checklists"), who);
      const r = await tool(who, "hd_draft_checklist", { name: `no ${STAMP}`, items: [{ title: "a" }] });
      assert.equal(r.isError, true, who);
      assert.match(r.text, /\(403\)$/, who);
      assert.equal((await tool(who, "hd_list_checklists")).isError, true, who);
    }
    // A desk Admin's draft (settings.manage) works.
    const ok = await tool("dadmin", "hd_draft_checklist", { name: `Admin draft ${STAMP}`, items: [{ title: "a" }] });
    assert.equal(ok.isError, false, ok.text);
    edition.features = [];
    try {
      assert.deepEqual(await listed("manager"), []);
      const r = await tool("manager", "hd_draft_checklist", { name: `no ${STAMP}`, items: [{ title: "a" }] });
      assert.equal(r.isError, true);
      assert.match(r.text, /licence.*402/);
    } finally {
      edition.features = ["helpdesk"];
    }
    assert.equal(await myTemplates() > 0, true);
    assert.equal((await pool().query("SELECT 1 FROM hd_checklist_templates WHERE name = $1", [`no ${STAMP}`])).rowCount, 0, "no refused draft was saved");
  });
});

// --- Ticking (the connector) ---------------------------------------------------------------

describe("hd_update_checklist: ticking as the agent", () => {
  let tpl = 0;
  before(async () => {
    tpl = await liveTemplate("Leaver", LEAVER);
  });

  test("the same timeline lines and audit rows as the desk, plus via Claude; batches; idempotent; unticking", async () => {
    const { t, items } = await withChecklist("Leaver Lee", tpl);
    // In the desk: the route.
    const deskTick = await tickRoute("agent", t.number, items[1].id, { done: true });
    assert.equal(deskTick.status, 200, JSON.stringify(deskTick.body));
    const deskRow = (await auditRows("helpdesk.checklist.item_ticked", P.agent.id, t.id)).at(-1)!;
    // Through Claude: two at once.
    const r = await tool("agent", "hd_update_checklist", { number: t.number, items: [{ id: items[0].id, done: true }, { id: items[2].id, done: true }] });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(
      r.out.items.map((x: any) => [x.id, x.done, x.changed]),
      [
        [items[0].id, true, true],
        [items[2].id, true, true],
      ]
    );
    assert.equal(r.out.items[0].required, true);
    assert.deepEqual(r.out.required_open, []);
    assert.equal(r.out.checklists[0].progress, "3 of 3 done");
    const rows = (await auditRows("helpdesk.checklist.item_ticked", P.agent.id, t.id)).slice(-2);
    assert.equal(rows.length, 2);
    // The same kind of row as the desk's, with the Claude marker.
    assert.deepEqual(Object.keys(rows[0].details).sort(), [...Object.keys(deskRow.details), "via"].sort());
    assert.equal(rows[0].details.via, "mcp");
    assert.equal(rows[0].details.item_id, items[0].id);
    assert.equal(rows[0].details.required, true);
    assert.equal(rows[0].ip, IP);
    assert.ok(!("via" in deskRow.details));
    const l = (await lines(t.id)).filter((x) => /ticked/.test(x.body));
    const cl = `Leaver ${STAMP}`;
    assert.deepEqual(l, [
      { kind: "internal", body: `${P.agent.name} ticked "Transfer OneDrive files to the manager" (${cl})` },
      { kind: "internal", body: `${P.agent.name} ticked "Disable sign-in on the leaving date" (${cl}) via Claude` },
      { kind: "internal", body: `${P.agent.name} ticked "Collect the laptop and badge" (${cl}) via Claude` },
    ]);
    // Again: nothing changes, no new row.
    const again = await tool("agent", "hd_update_checklist", { number: t.number, items: [{ id: items[0].id, done: true }] });
    assert.equal(again.out.items[0].changed, false);
    assert.equal((await auditRows("helpdesk.checklist.item_ticked", P.agent.id, t.id)).length, 3);
    // Untick.
    const un = await tool("agent", "hd_update_checklist", { number: t.number, items: [{ id: items[0].id, done: false }] });
    assert.equal(un.isError, false, un.text);
    assert.deepEqual(un.out.required_open.map((x: any) => x.id), [items[0].id]);
    const unRow = (await auditRows("helpdesk.checklist.item_unticked", P.agent.id, t.id)).at(-1)!;
    assert.equal(unRow.details.via, "mcp");
    assert.equal((await lines(t.id)).at(-1)!.body, `${P.agent.name} unticked "Disable sign-in on the leaving date" (${cl}) via Claude`);
    // Recent activity via Claude names the tick.
    const activity = await connector.recentClaudeActivity(100);
    assert.ok(activity.some((x) => x.actor_id === P.agent.id && x.summary === `Unticked "Disable sign-in on the leaving date" on #${t.number}`));
  });

  test("a batch with an item from another ticket changes nothing; bad shapes are plain sentences", async () => {
    const a = await withChecklist("Batch A", tpl);
    const b = await withChecklist("Batch B", tpl);
    const r = await tool("agent", "hd_update_checklist", { number: a.t.number, items: [{ id: a.items[1].id, done: true }, { id: b.items[0].id, done: true }] });
    assert.equal(r.isError, true);
    assert.match(r.text, new RegExp(`Item ${b.items[0].id} isn't on this ticket\\. Nothing was changed\\. \\(404\\)`));
    assert.equal((await checklists.ticketChecklists(a.t.id))[0].done, 0);
    const bad = async (args: Record<string, unknown>, re: RegExp) => {
      const x = await tool("agent", "hd_update_checklist", { number: a.t.number, ...args });
      assert.equal(x.isError, true);
      assert.match(x.text, re);
    };
    await bad({}, /Say what to do/);
    await bad({ items: "all" }, /list of \{ id, done \}/);
    await bad({ items: [{ id: a.items[0].id }] }, /Item 1 needs an id .* and done true or false/);
    await bad({ items: [{ id: a.items[0].id, done: true }, { id: a.items[0].id, done: false }] }, /both ticked and unticked/);
    await bad({ items: Array.from({ length: 51 }, () => ({ id: a.items[0].id, done: true })) }, /Up to 50 items/);
    await bad({ add_template_id: "x" }, /add_template_id is a checklist id/);
    assert.equal((await checklists.ticketChecklists(a.t.id))[0].done, 0);
  });

  test("adding a library checklist: as the desk does, via Claude; twice is refused", async () => {
    const t = await ticket("Add one");
    const read = await tool("agent", "hd_read_ticket", { number: t.number });
    assert.ok(read.out.checklist_templates.some((x: { id: number }) => x.id === tpl), "hd_read_ticket lists what can be added");
    const r = await tool("agent", "hd_update_checklist", { number: t.number, add_template_id: tpl });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.out.added.name, `Leaver ${STAMP}`);
    assert.equal(r.out.checklists[0].items.length, 3);
    assert.ok(r.out.checklists[0].items.every((i: { id: number }) => Number.isInteger(i.id)));
    assert.match((await lines(t.id)).at(-1)!.body, / added the checklist "Leaver .*" via Claude$/);
    const row = (await auditRows("helpdesk.checklist.added", P.agent.id, t.id)).at(-1)!;
    assert.equal(row.details.via, "mcp");
    assert.equal(row.details.template_id, tpl);
    const again = await tool("agent", "hd_update_checklist", { number: t.number, add_template_id: tpl });
    assert.equal(again.isError, true);
    assert.match(again.text, /already on this ticket\. \(409\)/);
    const after = await tool("agent", "hd_read_ticket", { number: t.number });
    assert.ok(!after.out.checklist_templates.some((x: { id: number }) => x.id === tpl), "one it has is not offered again");
  });

  test("solving stays blocked while required items are open; ticking never solves", async () => {
    const { t, items } = await withChecklist("Solve gate", tpl);
    const blocked = await tool("agent", "hd_update_ticket", { number: t.number, status: "solved" });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /^Finish the required checklist items first: "Disable sign-in on the leaving date"/);
    const opt = await tool("agent", "hd_update_checklist", { number: t.number, items: [{ id: items[1].id, done: true }, { id: items[2].id, done: true }], status: "solved" });
    assert.equal(opt.isError, false, opt.text);
    assert.equal(opt.out.required_open.length, 1);
    assert.match(opt.out.note, /can't be solved yet/);
    assert.equal(await statusOf(t.id), "open", "ticking (even with a stray status) never solves");
    assert.equal((await tool("agent", "hd_update_ticket", { number: t.number, status: "solved" })).isError, true);
    await tool("agent", "hd_update_checklist", { number: t.number, items: [{ id: items[0].id, done: true }] });
    assert.equal(await statusOf(t.id), "open");
    const ok = await tool("agent", "hd_update_ticket", { number: t.number, status: "solved" });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(await statusOf(t.id), "solved");
  });

  test("who may tick: anyone who works the ticket (newbies and team leads too); another team's agent, the requester and the unlicensed may not", async () => {
    const { t, items } = await withChecklist("Who ticks", tpl);
    const newbie = await tool("newbie", "hd_update_checklist", { number: t.number, items: [{ id: items[1].id, done: true }] });
    assert.equal(newbie.isError, false, newbie.text);
    assert.equal((await tickRoute("newbie", t.number, items[1].id, { done: false })).status, 200, "the route lets newbies tick too");
    assert.equal((await tool("lead", "hd_update_checklist", { number: t.number, items: [{ id: items[1].id, done: true }] })).isError, false);
    const outsider = await tool("outsider", "hd_update_checklist", { number: t.number, items: [{ id: items[0].id, done: true }] });
    assert.equal(outsider.isError, true);
    assert.equal(outsider.text, `No ticket #${t.number} that you can see.`);
    assert.equal((await tickRoute("outsider", t.number, items[0].id, { done: true })).status, 404, "as the route");
    const req = await tool("req", "hd_update_checklist", { number: t.number, items: [{ id: items[0].id, done: true }] });
    assert.equal(req.isError, true);
    assert.match(req.text, /\(403\)$/);
    assert.ok(!(await listed("req")).includes("hd_update_checklist"));
    edition.features = [];
    try {
      const r = await tool("agent", "hd_update_checklist", { number: t.number, items: [{ id: items[0].id, done: true }] });
      assert.match(r.text, /licence.*402/);
    } finally {
      edition.features = ["helpdesk"];
    }
    assert.equal((await checklists.ticketChecklists(t.id))[0].items[0].done, false, "the required item was never ticked by those refused");
  });

  test("recycle bin, legal hold, closed and merged: as the desk's route answers", async () => {
    // Recycle bin: not found, by both.
    const bin = await withChecklist("Binned", tpl);
    await pool().query("UPDATE hd_tickets SET deleted_at = now() WHERE id = $1", [bin.t.id]);
    const binTool = await tool("agent", "hd_update_checklist", { number: bin.t.number, items: [{ id: bin.items[0].id, done: true }] });
    assert.equal(binTool.text, `No ticket #${bin.t.number} that you can see.`);
    assert.equal((await tickRoute("agent", bin.t.number, bin.items[0].id, { done: true })).status, 404);
    assert.equal((await pool().query("SELECT done_at FROM hd_ticket_checklist_items WHERE id = $1", [bin.items[0].id])).rows[0].done_at, null);
    // Legal hold: the route lets it change, and so does the tool.
    const held = await withChecklist("Held", tpl);
    await pool().query("UPDATE hd_tickets SET legal_hold = 1 WHERE id = $1", [held.t.id]);
    assert.equal((await tickRoute("agent", held.t.number, held.items[1].id, { done: true })).status, 200);
    assert.equal((await tool("agent", "hd_update_checklist", { number: held.t.number, items: [{ id: held.items[2].id, done: true }] })).isError, false);
    // Closed: read-only, 409 from both.
    const closed = await withChecklist("Closed", tpl);
    await pool().query("UPDATE hd_tickets SET status = 'closed' WHERE id = $1", [closed.t.id]);
    const c = await tool("agent", "hd_update_checklist", { number: closed.t.number, items: [{ id: closed.items[0].id, done: true }] });
    assert.equal(c.isError, true);
    assert.match(c.text, /is closed, so its checklists can't change \(409\)/);
    assert.equal((await tickRoute("agent", closed.t.number, closed.items[0].id, { done: true })).status, 409);
    // Merged: read-only too.
    const merged = await withChecklist("Merged", tpl);
    const keep = await ticket("Kept");
    await pool().query("UPDATE hd_tickets SET merged_into = $2 WHERE id = $1", [merged.t.id, keep.id]);
    const m = await tool("agent", "hd_update_checklist", { number: merged.t.number, items: [{ id: merged.items[0].id, done: true }] });
    assert.match(m.text, /was merged into another ticket.*\(409\)/);
    assert.equal((await tickRoute("agent", merged.t.number, merged.items[0].id, { done: true })).status, 409);
  });
});

// --- The admin switches ------------------------------------------------------------------------

describe("admin switches", () => {
  test("the connector level: reading at every level, drafting from notes up (with the other drafts), ticking only at update (with hd_update_ticket)", async () => {
    try {
      connector.setClaudeLevelForTests("read");
      let m = await listed("manager");
      assert.ok(m.includes("hd_list_checklists"));
      assert.ok(!m.includes("hd_draft_checklist") && !m.includes("hd_draft_macro"));
      assert.ok(!m.includes("hd_update_checklist") && !m.includes("hd_update_ticket"));
      const d = await tool("manager", "hd_draft_checklist", { name: `ro ${STAMP}`, items: [{ title: "a" }] });
      assert.match(d.text, /set to "Read only", so Claude can't save anything in the helpdesk.*Nothing was saved\./);
      connector.setClaudeLevelForTests("notes");
      m = await listed("manager");
      assert.ok(m.includes("hd_draft_checklist") && m.includes("hd_draft_macro"));
      assert.ok(!m.includes("hd_update_checklist") && !m.includes("hd_update_ticket"));
      const t = await ticket("Level");
      const u = await tool("agent", "hd_update_checklist", { number: t.number, add_template_id: 1 });
      assert.match(u.text, /so Claude can't change tickets/);
      connector.setClaudeLevelForTests("update");
      m = await listed("manager");
      assert.ok(m.includes("hd_update_checklist") && m.includes("hd_update_ticket") && m.includes("hd_draft_checklist"));
      assert.ok((await listed("agent")).includes("hd_update_checklist"));
    } finally {
      connector.setClaudeLevelForTests("update");
    }
    // Nothing on the never-list: no tool publishes.
    for (const n of await listed("manager")) assert.doesNotMatch(n, /publish|send|approve/);
    assert.ok(connector.HD_CLAUDE_NEVER.some((l) => /checklist/.test(l)));
  });

  test("Claude in the desk: ticking with Suggest ticket changes, drafting with Draft replies; both off, neither offered", () => {
    const names = (cfg: ClaudeDeskConfig) => prompt.toolsFor(cfg, { assets: false }).map((t) => t.name);
    const on = names(CFG());
    assert.ok(on.includes("propose_checklist_ticks") && on.includes("draft_checklist"));
    assert.deepEqual(on, [...on].sort(), "sorted for the cache");
    const noChanges = names(CFG({ caps: { read: true, search: true, web: false, changes: false, drafts: true } }));
    assert.ok(!noChanges.includes("propose_checklist_ticks") && !noChanges.includes("propose_ticket_change"));
    assert.ok(noChanges.includes("draft_checklist"));
    const noDrafts = names(CFG({ caps: { read: true, search: true, web: false, changes: true, drafts: false } }));
    assert.ok(!noDrafts.includes("draft_checklist") && !noDrafts.includes("draft_reply"));
    assert.ok(noDrafts.includes("propose_checklist_ticks"));
    // Strict schemas: every property required.
    for (const s of prompt.TOOL_SPECS.filter((x) => x.name === "propose_checklist_ticks" || x.name === "draft_checklist")) {
      assert.deepEqual(s.input_schema.required, Object.keys(s.input_schema.properties));
    }
  });
});

// --- Claude in the desk -------------------------------------------------------------------------

describe("Claude in the desk", () => {
  let tpl = 0;
  before(async () => {
    tpl = await liveTemplate("Desk leaver", LEAVER);
  });

  test("propose_checklist_ticks: a card, nothing changed; Apply goes through the desk's route, via Claude in the desk", async () => {
    const { t, items } = await withChecklist("Desk tick", tpl);
    const u = await user("agent");
    const out = await deskTools.runDeskTool("propose_checklist_ticks", { number: t.number, items: [{ id: items[0].id, done: true }, { id: items[1].id, done: true }], when: null }, toolCtx(u));
    assert.equal(out.isError, false, out.content);
    assert.equal(out.card?.kind, "checklist");
    assert.equal(out.card?.payload.action, "tick");
    assert.equal(out.card?.payload.title, "Tick 2 checklist items");
    assert.deepEqual((out.card?.payload.items as any[]).map((i) => i.id), [items[0].id, items[1].id]);
    assert.equal((await checklists.ticketChecklists(t.id))[0].done, 0, "nothing changed");
    // Apply: the panel PATCHes each item with via "claude_desk".
    for (const it of out.card!.payload.items as { id: number; done: boolean }[]) {
      assert.equal((await tickRoute("agent", t.number, it.id, { done: it.done, via: "claude_desk" })).status, 200);
    }
    const l = (await lines(t.id)).filter((x) => /ticked/.test(x.body));
    assert.ok(l.every((x) => x.body.endsWith(" via Claude in the desk")), JSON.stringify(l));
    const row = (await auditRows("helpdesk.checklist.item_ticked", P.agent.id, t.id)).at(-1)!;
    assert.equal(row.details.via, "claude_desk");
    assert.equal(row.details.via_label, "via Claude in the desk");
    // Already done: nothing to propose. Another team's agent: not found. Team switched off: said so. Closed: refused.
    const same = await deskTools.runDeskTool("propose_checklist_ticks", { number: t.number, items: [{ id: items[0].id, done: true }], when: null }, toolCtx(u));
    assert.match(same.content, /already as asked/);
    const outsider = await deskTools.runDeskTool("propose_checklist_ticks", { number: t.number, items: [{ id: items[2].id, done: true }], when: null }, toolCtx(await user("outsider")));
    assert.equal(outsider.content, `No ticket #${t.number} that you can see.`);
    const off = await withChecklist("Desk off", tpl, "Off");
    const offOut = await deskTools.runDeskTool("propose_checklist_ticks", { number: off.t.number, items: [{ id: off.items[0].id, done: true }], when: null }, toolCtx(u));
    assert.match(offOut.content, /Claude is switched off for/);
    const foreign = await deskTools.runDeskTool("propose_checklist_ticks", { number: t.number, items: [{ id: off.items[0].id, done: true }], when: null }, toolCtx(u));
    assert.match(foreign.content, /isn't on #\d+'s checklists/);
    await pool().query("UPDATE hd_tickets SET status = 'closed' WHERE id = $1", [t.id]);
    const closed = await deskTools.runDeskTool("propose_checklist_ticks", { number: t.number, items: [{ id: items[2].id, done: true }], when: null }, toolCtx(u));
    assert.match(closed.content, /closed/);
    // list_checklists now carries the ids it needs.
    const listedOut = await deskTools.runDeskTool("list_checklists", { number: off.t.number }, toolCtx(await user("agent"), CFG({ teams_off: [] })));
    assert.ok(listedOut.content.includes(`"id": ${off.items[0].id}`), listedOut.content);
  });

  test("draft_checklist: only for people who manage checklists; a card; Save as draft stores it unpublished via Claude in the desk", async () => {
    const input = { name: `Desk draft ${STAMP}`, items: [{ title: "Wipe the laptop", required: true, team_id: null, due_days: 1 }, { title: "Return the badge", required: false, team_id: T.A, due_days: null }] };
    const agentOut = await deskTools.runDeskTool("draft_checklist", input, toolCtx(await user("agent")));
    assert.equal(agentOut.isError, true);
    assert.match(agentOut.content, /can't manage checklists/);
    const before = await myTemplates();
    const out = await deskTools.runDeskTool("draft_checklist", input, toolCtx(await user("manager")));
    assert.equal(out.isError, false, out.content);
    assert.equal(out.card?.payload.action, "draft");
    assert.equal(out.card?.ticketId, null);
    const draft = out.card!.payload.draft as { name: string; items: unknown[] };
    assert.deepEqual(draft.items[0], { key: "i1", title: "Wipe the laptop", required: true, due_days: 1 });
    assert.equal(await myTemplates(), before, "nothing saved by the tool");
    const bad = await deskTools.runDeskTool("draft_checklist", { ...input, items: [{ title: "x", required: false, team_id: null, due_days: 61 }] }, toolCtx(await user("manager")));
    assert.match(bad.content, /0 to 60 business days/);
    // Save as draft: the settings route, with the agent's session.
    assert.equal((await call(adminRoute.POST, "agent", "/admin/checklists", "POST", { ...draft, draft: true })).status, 403);
    const saved = await call(adminRoute.POST, "manager", "/admin/checklists", "POST", { ...draft, draft: true });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.template.published, false);
    assert.equal(saved.body.template.draft_via, "claude_desk");
    const row = (await auditRows("helpdesk.checklist_template.created", P.manager.id, saved.body.template.id)).at(-1)!;
    assert.equal(row.details.via, "claude_desk");
    assert.equal(row.details.draft, true);
    assert.ok(!(await checklists.templateOptions()).some((o) => o.id === saved.body.template.id));
  });

  test("a full turn: Claude proposes ticks and drafts a checklist; the cards are created; the tools are offered only when switched on", async () => {
    const { t, items } = await withChecklist("Turn", tpl);
    const u = await user("manager");
    fake.reset();
    fake.queue(
      {
        content: [
          { type: "tool_use", name: "propose_checklist_ticks", input: { number: t.number, items: [{ id: items[0].id, done: true }], when: null } },
          { type: "tool_use", name: "draft_checklist", input: { name: `Turn draft ${STAMP}`, items: [{ title: "Step one", required: true, team_id: null, due_days: null }] } },
        ],
      },
      { content: [{ type: "text", text: "I prepared a tick and a checklist draft for you." }] }
    );
    const prep = await turnLib.prepareTurn({ user: u, session: toSessionUser(u), origin: "http://localhost", ip: IP, ticketNumber: t.number, chatId: null, fresh: true, text: "Sign-in is disabled. Tick it, and make a checklist for this.", intent: null });
    assert.ok(prep.ok, JSON.stringify(prep));
    if (!prep.ok) return;
    assert.ok(prep.turn.clientToolNames.includes("propose_checklist_ticks") && prep.turn.clientToolNames.includes("draft_checklist"));
    const events: ClaudeStreamEvent[] = [];
    await turnLib.runTurn(prep.turn, (e) => events.push(e));
    const cards = events.filter((e) => e.type === "card").map((e) => (e as { card: any }).card);
    assert.equal(cards.length, 2, JSON.stringify(events));
    assert.deepEqual(cards.map((c) => [c.kind, c.action, c.state]), [
      ["checklist", "tick", "offered"],
      ["checklist", "draft", "offered"],
    ]);
    assert.equal((await checklists.ticketChecklists(t.id))[0].items[0].done, false, "the turn changed nothing");
    // The prompt says ticking only on the agent's word; the model's ticket view has item ids.
    const req = fake.requests.find((r) => Array.isArray(r.body?.tools))!;
    assert.match(req.body.system[0].text, /Propose ticking an item only when the agent says the step is done/);
    const sent = (req.body.messages as any[]).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === "text").map((b: any) => b.text as string).join("\n");
    assert.ok(sent.includes(`"id": ${items[0].id}`), "the open ticket's checklist items carry their ids");
    // The agent's decision on the cards (the card route), then Apply's own route.
    assert.equal((await call(cardRoute.POST, "manager", `/claude/cards/${cards[0].id}`, "POST", { state: "applied" }, { id: String(cards[0].id) })).status, 200);
    assert.equal((await call(cardRoute.POST, "manager", `/claude/cards/${cards[1].id}`, "POST", { state: "skipped" }, { id: String(cards[1].id) })).status, 200);
    // Switched off: neither is offered to the model.
    config.setClaudeDeskConfigForTests(CFG({ caps: { read: true, search: true, web: false, changes: false, drafts: false } }));
    try {
      fake.reset();
      fake.queue({ content: [{ type: "text", text: "OK." }] });
      const off = await turnLib.prepareTurn({ user: u, session: toSessionUser(u), origin: "http://localhost", ip: IP, ticketNumber: t.number, chatId: null, fresh: true, text: "Tick it", intent: null });
      assert.ok(off.ok);
      if (!off.ok) return;
      assert.ok(!off.turn.clientToolNames.includes("propose_checklist_ticks") && !off.turn.clientToolNames.includes("draft_checklist"));
      await turnLib.runTurn(off.turn, () => {});
      const names = (fake.requests.find((r) => Array.isArray(r.body?.tools))!.body.tools as { name: string }[]).map((x) => x.name);
      assert.ok(!names.includes("propose_checklist_ticks") && !names.includes("draft_checklist"));
    } finally {
      config.setClaudeDeskConfigForTests(CFG());
    }
  });
});
