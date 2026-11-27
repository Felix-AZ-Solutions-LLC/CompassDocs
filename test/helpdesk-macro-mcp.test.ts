// Helpdesk 1.20.15: Claude tools for desk macros (and canned responses in reply drafts).
//
//   - applyMacroAs (lib/helpdesk/macros) is the desk route's own apply,
//     shared with Claude: who may use which macro (personal / team /
//     everyone), works the ticket, Use macros in its team, each change's
//     capability, newbie review, required checklist items when it solves,
//     the recycle bin, closed and merged.
//   - hd_list_macros (read level) lists the macros the person can apply,
//     with what each does; hd_apply_macro (update level) applies one as
//     them: field changes at once ("via Claude"), the reply saved as a
//     DRAFT (the connector never sends one) and a status change held back
//     until it is sent. Audited helpdesk.macro.applied via "mcp".
//   - Claude in the desk: list_macros and propose_macro (under "Suggest
//     ticket changes"); propose_macro dry-runs the desk's checks and gives a
//     card; Apply goes through the desk's own macro route with the card's
//     id, which alone marks it "via Claude in the desk" (1.20.14's rule: an
//     offered card of this agent's for exactly this change; a bare via is
//     ignored). One full turn on the fake Anthropic server.
//   - hd_draft_reply's canned_id: filled for the ticket, only a canned
//     response the person may use there.
//
// Harness as test/helpdesk-checklist-mcp: next/headers and lib/ee stubbed,
// routes called with real sessions, the fake Anthropic server for the turn.
// Parallel-safe: everything is this file's own (STAMP); role matrix,
// connector level and desk config are overridden in-process only.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-macro-mcp.test.ts

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
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.macro-mcp.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.macro-mcp.virtual.js");
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
  ee.exports = { ee: () => edition, eePresent: () => true, featureEnabled: async (f: string) => edition.features.includes(f), featureEnforced: async (f: string) => edition.features.includes(f), featureEnabledFrom: (f: string) => edition.features.includes(f), featureEnforcedFrom: (f: string) => edition.features.includes(f) };
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
const access = require("../src/lib/helpdesk/access") as typeof import("../src/lib/helpdesk/access");
const macros = require("../src/lib/helpdesk/macros") as typeof import("../src/lib/helpdesk/macros");
const canned = require("../src/lib/helpdesk/canned") as typeof import("../src/lib/helpdesk/canned");
const checklists = require("../src/lib/helpdesk/checklists") as typeof import("../src/lib/helpdesk/checklists");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const messagesLib = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
const presenceShared = require("../src/lib/helpdesk/presence-shared") as typeof import("../src/lib/helpdesk/presence-shared");
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
const chats = require("../src/lib/helpdesk/claude/chats") as typeof import("../src/lib/helpdesk/claude/chats");
const auditLabels = require("../src/lib/audit-labels") as typeof import("../src/lib/audit-labels");
const macroRoute = require("../src/app/api/helpdesk/tickets/[number]/macro/[macroId]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/macro/[macroId]/route");
const cardRoute = require("../src/app/api/helpdesk/claude/cards/[id]/route") as typeof import("../src/app/api/helpdesk/claude/cards/[id]/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdRole } from "../src/lib/helpdesk/roles-shared";
import type { ClaudeDeskConfig, ClaudeStreamEvent } from "../src/lib/helpdesk/claude/shared";

const STAMP = `hdmcm-${Date.now()}-${process.pid}`;
const IP = "203.0.113.151";
const CTX = { origin: "http://localhost", ip: IP };

interface Person {
  id: number;
  name: string;
  first: string;
  session: string;
}
const P: Record<string, Person> = {};
const userIds: number[] = [];
const roleIds: number[] = [];
const ticketIds: number[] = [];
const T: Record<string, number> = {};
const M: Record<string, number> = {};
const C: Record<string, number> = {};
let fake: FakeAnthropic;

const CFG = (patch: Partial<ClaudeDeskConfig> = {}): ClaudeDeskConfig => ({
  ...desk.CLAUDE_DESK_DEFAULTS,
  enabled: true,
  teams_off: [T.Off],
  caps: { read: true, search: true, web: false, changes: true, drafts: true },
  ...patch,
});

async function person(key: string, deskRole: HdRole | null, teams: string[] = []) {
  const first = key.charAt(0).toUpperCase() + key.slice(1);
  const name = `${first} ${STAMP}`;
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
  P[key] = { id, name, first, session };
}

async function ticket(subject: string, team = "A"): Promise<{ id: number; number: number }> {
  const r = await pool().query(
    "INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status, source) VALUES ($1, $2, 'Robin Req', $3, $4, 'open', 'portal') RETURNING id, number",
    [`${subject} ${STAMP}`, P.req.id, `${STAMP}-req@example.test`, T[team]]
  );
  ticketIds.push(r.rows[0].id);
  return r.rows[0];
}

async function macro(key: string, body: string, actions: Record<string, unknown>, scope: { team?: string; owner?: string } = {}) {
  const m = await macros.createMacro(
    { title: `${key} ${STAMP}`, body, actions: actions as never, team_id: scope.team ? T[scope.team] : null, owner_id: scope.owner ? P[scope.owner].id : null },
    null
  );
  M[key] = m.id;
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

const deskApply = (who: string, n: number, macroId: number, body: Record<string, unknown> = {}) =>
  call(macroRoute.POST, who, `/tickets/${n}/macro/${macroId}`, "POST", body, { number: String(n), macroId: String(macroId) });
const msgs = async (ticketId: number) =>
  (await pool().query("SELECT id, kind, body, via, review_state FROM hd_messages WHERE ticket_id = $1 ORDER BY id", [ticketId])).rows as { id: number; kind: string; body: string; via: string; review_state: string | null }[];
const publicMsgs = async (ticketId: number) => (await msgs(ticketId)).filter((m) => m.kind === "public");
const drafts = async (ticketId: number) =>
  (await pool().query("SELECT id, body, source, created_by FROM hd_reply_drafts WHERE ticket_id = $1 AND discarded_at IS NULL AND used_at IS NULL ORDER BY id", [ticketId])).rows as {
    id: number;
    body: string;
    source: string;
    created_by: number;
  }[];
const row = async (id: number) => (await pool().query("SELECT status, priority, team_id, tags FROM hd_tickets WHERE id = $1", [id])).rows[0] as { status: string; priority: string; team_id: number; tags: string[] };
const auditRows = async (action: string, actor: number, targetId?: number) =>
  (
    await pool().query(
      `SELECT details, ip FROM audit_log WHERE action = $1 AND actor_id = $2${targetId ? " AND target_id = $3" : ""} ORDER BY id`,
      targetId ? [action, actor, targetId] : [action, actor]
    )
  ).rows as { details: Record<string, unknown>; ip: string | null }[];
/** Lines on the timeline after message `after` (field changes and the like, not replies). */
const lineBodies = async (ticketId: number, after = 0) => (await msgs(ticketId)).filter((m) => m.id > after && m.kind !== "public").map((m) => m.body);
const lastId = async (ticketId: number) => Number((await pool().query("SELECT coalesce(max(id), 0) AS id FROM hd_messages WHERE ticket_id = $1", [ticketId])).rows[0].id);

function toolCtx(u: Awaited<ReturnType<typeof user>>, cfg = CFG(), open: import("../src/lib/helpdesk/types").HdTicket | null = null) {
  return { user: u, session: toSessionUser(u), origin: "http://localhost", ip: IP, cfg, chatId: 0, ticket: open, includeNotes: false, touched: new Set<number>(), notesSeen: [] as string[] };
}
const open = async (n: number) => (await tickets.getTicketByNumber(n))!;
/** A Claude in the desk card offered to `who`, stored as a turn stores it; its id. */
async function offerCard(who: string, ticketId: number, payload: Record<string, unknown>) {
  const chat = await pool().query("INSERT INTO hd_claude_chats (user_id, ticket_id, title) VALUES ($1, $2, $3) RETURNING id", [P[who].id, ticketId, `card ${STAMP}`]);
  return chats.createCard({ chatId: chat.rows[0].id, userId: P[who].id, ticketId, kind: "change", payload });
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  fake = await startFakeAnthropic();
  process.env.COMPASSDOCS_ANTHROPIC_BASE_URL = fake.url;
  aiConfig.setAiConfigForTests({ key: "sk-ant-fake-test", model: "claude-opus-5-5", provider: "anthropic" });
  roles.setRoleMatrixForTests(rolesShared.HD_DEFAULT_MATRIX);
  turnLib.setClaudeTurnLimitsForTests({ minute: 1000, hour: 1000 });
  for (const k of ["A", "B", "Off"]) T[k] = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9460) RETURNING id", [`${STAMP} ${k}`])).rows[0].id;
  await person("agent", "agent", ["A", "Off"]);
  await person("newbie", "newbie", ["A"]);
  await person("lead", "team_lead", ["A"]);
  await person("outsider", "agent", ["B"]);
  await person("manager", "manager", ["A"]);
  await person("busy", "agent", ["A"]);
  await person("req", null);
  config.setClaudeDeskConfigForTests(CFG());
  connector.setClaudeLevelForTests("update");
  // Every scope: everyone's, team A's, team B's, two personal ones.
  await macro("Password reset", "Hi {{requester.first_name}}, I've reset your password. {{agent.first_name}}", { priority: "high", tags_add: ["pw-reset"] });
  await macro("Team A triage", "", { status: "pending", tags_add: ["triaged"] }, { team: "A" });
  await macro("Team B triage", "", { tags_add: ["b-triaged"] }, { team: "B" });
  await macro("Agent personal", "Thanks {{requester.name}}.", {}, { owner: "agent" });
  await macro("Lead personal", "From the lead.", {}, { owner: "lead" });
  await macro("Reply and solve", "All sorted, closing this.", { status: "solved" });
  await macro("Quiet solve", "", { status: "solved" });
  await macro("Looking", "We're looking into it.", { tags_add: ["looking"] });
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
  await pool().query("DELETE FROM hd_macros WHERE title LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM hd_canned_responses WHERE title LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM hd_checklist_templates WHERE name LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [Object.values(T)]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE role_id = ANY($1)", [roleIds]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// --- Listing ----------------------------------------------------------------------------------

describe("hd_list_macros", () => {
  const names = async (who: string, args: Record<string, unknown> = {}) => {
    const r = await tool(who, "hd_list_macros", { query: STAMP, limit: 50, ...args });
    assert.equal(r.isError, false, r.text);
    return (r.out.macros as { name: string }[]).map((m) => m.name.replace(` ${STAMP}`, "")).sort();
  };

  test("per role and scope: their own personal ones, their teams' and everyone's, as the desk lets them apply", async () => {
    const shared = ["Looking", "Password reset", "Quiet solve", "Reply and solve"];
    assert.deepEqual(await names("agent"), [...shared, "Agent personal", "Team A triage"].sort());
    assert.deepEqual(await names("lead"), [...shared, "Lead personal", "Team A triage"].sort());
    assert.deepEqual(await names("newbie"), [...shared, "Team A triage"].sort());
    assert.deepEqual(await names("outsider"), [...shared, "Team B triage"].sort());
    // Every team's tickets: every team's macros, still nobody else's personal ones.
    assert.deepEqual(await names("manager"), [...shared, "Team A triage", "Team B triage"].sort());
    // The requester has no desk role: not listed, and refused.
    assert.ok(!(await listed("req")).includes("hd_list_macros"));
    const r = await tool("req", "hd_list_macros", {});
    assert.equal(r.isError, true);
    assert.match(r.text, /\(403\)$/);
  });

  test("what each does, in plain words; with a ticket, the reply filled for it", async () => {
    const t = await ticket("List with ticket");
    const r = await tool("agent", "hd_list_macros", { number: t.number, query: "Password reset" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.out.ticket, t.number);
    const m = r.out.macros.find((x: { id: number }) => x.id === M["Password reset"]);
    assert.deepEqual(
      { scope: m.scope, team: m.team, solves: m.solves, does: m.does, reply_preview: m.reply_preview, changes: m.changes },
      {
        scope: "everyone",
        team: null,
        solves: false,
        does: ["Replies to the requester", "Sets the priority to High", "Adds the tag pw-reset"],
        reply_preview: "Hi Robin, I've reset your password. Agent",
        changes: { priority: "high", tags_add: ["pw-reset"] },
      }
    );
    assert.match(r.out.note, /saved as a draft/);
    const solve = (await tool("agent", "hd_list_macros", { query: `Reply and solve ${STAMP}` })).out.macros[0];
    assert.equal(solve.solves, true);
    assert.deepEqual(solve.does, ["Replies to the requester", "Sets the status to Solved"]);
    assert.equal(solve.reply_preview, "All sorted, closing this.");
    const team = (await tool("agent", "hd_list_macros", { query: `Team A triage ${STAMP}` })).out.macros[0];
    assert.equal(team.scope, "team");
    assert.equal(team.team, `${STAMP} A`);
    assert.equal(team.reply_preview, null);
    // A ticket outside their queues answers like one that does not exist.
    const other = await tool("outsider", "hd_list_macros", { number: t.number });
    assert.equal(other.text, `No ticket #${t.number} that you can see.`);
  });

  test("without Use macros: neither tool is listed, the tools and the desk route refuse", async () => {
    const t = await ticket("No macros.use");
    const matrix = { ...rolesShared.HD_DEFAULT_MATRIX, newbie: rolesShared.HD_DEFAULT_MATRIX.newbie.filter((c) => c !== "macros.use") };
    roles.setRoleMatrixForTests(matrix);
    try {
      const n = await listed("newbie");
      assert.ok(!n.includes("hd_list_macros") && !n.includes("hd_apply_macro"));
      assert.ok(n.includes("hd_read_ticket"), "still an agent");
      assert.match((await tool("newbie", "hd_apply_macro", { number: t.number, macro_id: M.Looking })).text, /\(403\)$/);
      assert.equal((await deskApply("newbie", t.number, M.Looking)).status, 403);
      assert.equal((await publicMsgs(t.id)).length + (await drafts(t.id)).length, 0);
    } finally {
      roles.setRoleMatrixForTests(rolesShared.HD_DEFAULT_MATRIX);
    }
  });
});

// --- Applying (the connector) -------------------------------------------------------------------

describe("hd_apply_macro: the desk's apply, as the person, reply as a draft", () => {
  test("parity with the desk: the same field changes; the reply is a draft, not sent; via Claude on the timeline; audited", async () => {
    const d = await ticket("Parity desk");
    const c = await ticket("Parity claude");
    const deskLines = await lastId(d.id);
    const viaDesk = await deskApply("agent", d.number, M["Password reset"]);
    assert.equal(viaDesk.status, 200, JSON.stringify(viaDesk.body));
    assert.equal(viaDesk.body.held, false);
    // The desk's answer has the shape it always had (nothing added by the refactor).
    assert.deepEqual(Object.keys(viaDesk.body).sort(), ["body", "held", "message_id", "ok", "patch", "preview"]);
    const before = await lastId(c.id);
    const viaClaude = await tool("agent", "hd_apply_macro", { number: c.number, macro_id: M["Password reset"] });
    assert.equal(viaClaude.isError, false, viaClaude.text);
    assert.deepEqual(viaClaude.out.changed, Object.keys(viaDesk.body.patch));
    assert.deepEqual(viaClaude.out.macro, { id: M["Password reset"], name: `Password reset ${STAMP}` });
    assert.equal(viaClaude.out.reply.saved_as, "draft");
    assert.equal(viaClaude.out.reply.sent, false);
    assert.match(viaClaude.out.note, /saved as a draft and NOT sent/);
    // The same ticket fields either way.
    const [rd, rc] = [await row(d.id), await row(c.id)];
    assert.deepEqual({ p: rc.priority, t: rc.tags }, { p: rd.priority, t: rd.tags });
    assert.equal(rc.priority, "high");
    assert.ok(rc.tags.includes("pw-reset"));
    // The desk sent the reply; Claude saved the same text as a draft and sent nothing.
    const sent = await publicMsgs(d.id);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body, `Hi Robin, I've reset your password. Agent`);
    assert.equal((await publicMsgs(c.id)).length, 0, "nothing sent through Claude");
    const dr = await drafts(c.id);
    assert.equal(dr.length, 1);
    assert.deepEqual({ body: dr[0].body, source: dr[0].source, by: dr[0].created_by }, { body: sent[0].body, source: "claude", by: P.agent.id });
    assert.equal(viaClaude.out.reply.draft_id, dr[0].id);
    // Timeline: the same lines, Claude's ending "via Claude".
    const dl = await lineBodies(d.id, deskLines);
    const cl = await lineBodies(c.id, before);
    assert.ok(cl.length > 0 && cl.length === dl.length, JSON.stringify({ dl, cl }));
    assert.ok(cl.every((l) => l.endsWith(" via Claude")), JSON.stringify(cl));
    assert.ok(dl.every((l) => !/via Claude/.test(l)), JSON.stringify(dl));
    // Audit: a row through Claude (via mcp); none for the plain desk apply, as before.
    const a = await auditRows("helpdesk.macro.applied", P.agent.id, c.id);
    assert.equal(a.length, 1);
    assert.deepEqual(a[0].details, {
      number: c.number,
      macro_id: M["Password reset"],
      macro: `Password reset ${STAMP}`,
      scope: "everyone",
      changed: ["priority", "tags"],
      reply: "draft",
      draft_id: dr[0].id,
      via: "mcp",
    });
    assert.equal(a[0].ip, IP);
    assert.equal((await auditRows("helpdesk.macro.applied", P.agent.id, d.id)).length, 0);
    assert.equal(auditLabels.AUDIT_LABELS["helpdesk.macro.applied"], "Applied a macro");
    const activity = await connector.recentClaudeActivity(100);
    assert.ok(activity.some((x) => x.actor_id === P.agent.id && x.summary === `Applied the macro "Password reset ${STAMP}" to #${c.number} (reply saved as a draft)`));
  });

  test("a personal macro is its owner's only; a team macro its team's; an unknown id is a plain sentence", async () => {
    const t = await ticket("Scopes");
    const mine = await tool("agent", "hd_apply_macro", { number: t.number, macro_id: M["Agent personal"] });
    assert.equal(mine.isError, false, mine.text);
    for (const id of [M["Lead personal"], M["Team B triage"], 99999999]) {
      const r = await tool("agent", "hd_apply_macro", { number: t.number, macro_id: id });
      assert.equal(r.isError, true);
      assert.equal(r.text, `No macro with id ${id} that you can use. hd_list_macros lists them. Nothing was changed.`);
      assert.equal((await deskApply("agent", t.number, id)).status, 404, "the desk answers the same");
    }
    assert.equal((await tool("agent", "hd_apply_macro", { number: t.number, macro_id: "x" })).text, "macro_id is a macro's id from hd_list_macros.");
    // Another team's agent can't reach the ticket at all.
    assert.equal((await tool("outsider", "hd_apply_macro", { number: t.number, macro_id: M["Password reset"] })).text, `No ticket #${t.number} that you can see.`);
    assert.equal((await deskApply("outsider", t.number, M["Password reset"])).status, 404);
  });

  test("newbie review: the desk holds the reply; Claude drafts it; neither lets a newbie solve or re-prioritise", async () => {
    const d = await ticket("Newbie desk");
    const c = await ticket("Newbie claude");
    const viaDesk = await deskApply("newbie", d.number, M.Looking);
    assert.equal(viaDesk.status, 200, JSON.stringify(viaDesk.body));
    assert.equal(viaDesk.body.held, true);
    assert.equal((await publicMsgs(d.id))[0].review_state, "pending");
    const viaClaude = await tool("newbie", "hd_apply_macro", { number: c.number, macro_id: M.Looking });
    assert.equal(viaClaude.isError, false, viaClaude.text);
    assert.equal(viaClaude.out.reply.saved_as, "draft");
    assert.equal((await publicMsgs(c.id)).length, 0);
    assert.equal((await drafts(c.id)).length, 1, "the newbie's send from the desk will be held for review as usual");
    assert.deepEqual((await row(c.id)).tags, (await row(d.id)).tags);
    // Not theirs to do: solving, priority. Refused whole by both, nothing posted or drafted.
    for (const id of [M["Reply and solve"], M["Password reset"]]) {
      const t = await ticket("Newbie refused");
      assert.equal((await deskApply("newbie", t.number, id)).status, 403);
      const r = await tool("newbie", "hd_apply_macro", { number: t.number, macro_id: id });
      assert.equal(r.isError, true);
      assert.match(r.text, /\(403\) Nothing was changed\.$/);
      assert.equal((await publicMsgs(t.id)).length + (await drafts(t.id)).length, 0);
      assert.equal((await row(t.id)).status, "open");
      assert.equal((await row(t.id)).priority, "normal");
    }
  });

  test("solving: required checklist items refuse a macro that solves, by both; a reply and solve waits for the reply", async () => {
    const tpl = await checklists.createTemplate({ name: `Macro gate ${STAMP}`, items: [{ title: "Wipe the laptop", required: true }], request_type_ids: [] }, { id: P.manager.id, name: P.manager.name });
    const d = await ticket("Gate desk");
    const c = await ticket("Gate claude");
    for (const t of [d, c]) await checklists.addChecklistToTicket(t.id, tpl.id, { id: P.manager.id, name: P.manager.name });
    const viaDesk = await deskApply("agent", d.number, M["Quiet solve"]);
    assert.equal(viaDesk.status, 409);
    assert.match(viaDesk.body.error, /^Finish the required checklist items first: "Wipe the laptop"/);
    const viaClaude = await tool("agent", "hd_apply_macro", { number: c.number, macro_id: M["Quiet solve"] });
    assert.equal(viaClaude.isError, true);
    assert.equal(viaClaude.text, `${viaDesk.body.error} (409) Nothing was changed.`);
    assert.equal((await row(c.id)).status, "open");
    // Reply and solve through Claude: the reply is a draft, so nothing solves (and no checklist refusal is needed).
    const rs = await tool("agent", "hd_apply_macro", { number: c.number, macro_id: M["Reply and solve"] });
    assert.equal(rs.isError, false, rs.text);
    assert.equal(rs.out.status_unchanged, macros.MACRO_DRAFT_STATUS_WAITS);
    assert.deepEqual(rs.out.changed, []);
    assert.match(rs.out.note, /status change \(solved\) was not made: set it once the reply is sent/);
    assert.equal((await row(c.id)).status, "open");
    assert.equal((await drafts(c.id)).at(-1)!.body, "All sorted, closing this.");
    assert.equal((await auditRows("helpdesk.macro.applied", P.agent.id, c.id)).at(-1)!.details.status_unchanged, true);
    // Ticked: the quiet solve goes through, via Claude.
    const item = (await checklists.ticketChecklists(c.id))[0].items[0];
    await checklists.tickItemsAs({ id: P.agent.id, name: P.agent.name, username: `${STAMP}-agent`, role: "viewer" }, { id: c.id, number: c.number, subject: "x", status: "open" }, [{ id: item.id, done: true }], { ip: IP });
    const before = await lastId(c.id);
    const solved = await tool("agent", "hd_apply_macro", { number: c.number, macro_id: M["Quiet solve"] });
    assert.equal(solved.isError, false, solved.text);
    assert.deepEqual(solved.out.changed, ["status"]);
    assert.equal(solved.out.status, "solved");
    assert.equal(solved.out.reply, null);
    assert.ok((await lineBodies(c.id, before)).some((l) => l.endsWith(" via Claude")));
  });

  test("the recycle bin, closed and merged: as the desk's route answers; legal hold doesn't stop a macro", async () => {
    const bin = await ticket("Binned");
    await pool().query("UPDATE hd_tickets SET deleted_at = now() WHERE id = $1", [bin.id]);
    assert.equal((await deskApply("agent", bin.number, M.Looking)).status, 404);
    assert.equal((await tool("agent", "hd_apply_macro", { number: bin.number, macro_id: M.Looking })).text, `No ticket #${bin.number} that you can see.`);
    assert.equal((await tool("agent", "hd_list_macros", { number: bin.number })).text, `No ticket #${bin.number} that you can see.`);
    const closed = await ticket("Closed");
    await pool().query("UPDATE hd_tickets SET status = 'closed' WHERE id = $1", [closed.id]);
    const dc = await deskApply("agent", closed.number, M.Looking);
    assert.deepEqual([dc.status, dc.body.error], [409, "This ticket is closed."]);
    assert.equal((await tool("agent", "hd_apply_macro", { number: closed.number, macro_id: M.Looking })).text, `#${closed.number} is closed, so a macro can't change it. (409) Nothing was changed.`);
    const merged = await ticket("Merged");
    const keep = await ticket("Kept");
    await pool().query("UPDATE hd_tickets SET status = 'closed', merged_into = $2 WHERE id = $1", [merged.id, keep.id]);
    assert.equal((await deskApply("agent", merged.number, M.Looking)).status, 409);
    const m = await tool("agent", "hd_apply_macro", { number: merged.number, macro_id: M.Looking });
    assert.equal(m.text, `#${merged.number} was merged into #${keep.number}. Reply and change its status on #${keep.number}. (409) Nothing was changed.`);
    for (const t of [bin, closed, merged]) assert.equal((await publicMsgs(t.id)).length + (await drafts(t.id)).length, 0);
    const held = await ticket("Held");
    await pool().query("UPDATE hd_tickets SET legal_hold = 1 WHERE id = $1", [held.id]);
    assert.equal((await deskApply("agent", held.number, M.Looking)).status, 200);
    assert.equal((await tool("agent", "hd_apply_macro", { number: held.number, macro_id: M.Looking })).isError, false);
  });

  test("rate limited like the connector's other ticket writes (429)", async () => {
    const t = await ticket("Busy");
    for (let i = 0; i < 30; i++) access.messagePostLimited(P.busy.id);
    const r = await tool("busy", "hd_apply_macro", { number: t.number, macro_id: M.Looking });
    assert.equal(r.text, "Too many requests. Wait a moment and try again (429).");
    assert.equal((await drafts(t.id)).length, 0);
  });
});

// --- hd_draft_reply canned_id -------------------------------------------------------------------

describe("hd_draft_reply with canned_id", () => {
  before(async () => {
    const mk = async (key: string, body: string, owner: string | null, team: string | null) => {
      const c = await canned.createCanned({ title: `${key} ${STAMP}`, body, folder: "", owner_id: owner ? P[owner].id : null, team_id: team ? T[team] : null }, P.manager.id);
      C[key] = c.id;
    };
    await mk("Workspace", "Hello {{requester.first_name}}, this is {{agent.first_name}} about #{{ticket.number}} ({{team.name}}).", null, null);
    await mk("Lead own", "Lead's own words.", "lead", null);
    await mk("Team B", "Team B's words.", null, "B");
  });

  test("the draft starts from the canned response, filled for the ticket as hd_canned_responses fills it; the use is counted", async () => {
    const t = await ticket("Canned");
    const listedOut = await tool("agent", "hd_canned_responses", { number: t.number, query: `Workspace ${STAMP}` });
    const filled = listedOut.out.canned_responses[0].filled as string;
    assert.equal(filled, `Hello Robin, this is Agent about #${t.number} (${STAMP} A).`);
    const r = await tool("agent", "hd_draft_reply", { number: t.number, canned_id: C.Workspace });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.out.canned_response, { id: C.Workspace, name: `Workspace ${STAMP}` });
    assert.equal(r.out.sent, false);
    assert.equal((await drafts(t.id)).at(-1)!.body, filled);
    const withBody = await tool("agent", "hd_draft_reply", { number: t.number, canned_id: C.Workspace, body: "I've also renewed the licence." });
    assert.equal((await drafts(t.id)).at(-1)!.body, `${filled}\n\nI've also renewed the licence.`);
    assert.equal(withBody.isError, false);
    const uses = await pool().query("SELECT count(*)::int AS n FROM hd_canned_uses WHERE canned_id = $1 AND user_id = $2 AND ticket_id = $3", [C.Workspace, P.agent.id, t.id]);
    assert.equal(uses.rows[0].n, 1, "one use (the desk's own hour window)");
    const a = (await auditRows("helpdesk.reply_draft.created", P.agent.id, t.id)).at(-1)!;
    assert.equal(a.details.canned_id, C.Workspace);
    assert.equal(a.details.via, "mcp");
    // Without either: a plain sentence. Nothing sent to the requester either way.
    assert.equal((await tool("agent", "hd_draft_reply", { number: t.number })).text, "Write the draft (body), or send canned_id.");
    assert.equal((await publicMsgs(t.id)).length, 0);
  });

  test("only a canned response the person may use there: not someone's personal one, not another team's", async () => {
    const t = await ticket("Canned refused");
    for (const id of [C["Lead own"], C["Team B"], 99999999]) {
      const r = await tool("agent", "hd_draft_reply", { number: t.number, canned_id: id });
      assert.equal(r.isError, true);
      assert.equal(r.text, `No canned response with id ${id} that you can use on #${t.number}. hd_canned_responses lists them. Nothing was saved.`);
    }
    assert.equal((await drafts(t.id)).length, 0);
    // The lead's own, by the lead: fine. Team B's, on a team-B ticket, by its agent: fine.
    assert.equal((await tool("lead", "hd_draft_reply", { number: t.number, canned_id: C["Lead own"] })).isError, false);
    const b = await ticket("Canned B", "B");
    assert.equal((await tool("outsider", "hd_draft_reply", { number: b.number, canned_id: C["Team B"] })).isError, false);
    // The schema: body is no longer required, canned_id is offered.
    const def = (await hdTools.helpdeskToolsFor(await user("agent"))).find((x) => x.name === "hd_draft_reply")!;
    assert.deepEqual((def.inputSchema as { required: string[] }).required, ["number"]);
    assert.ok("canned_id" in (def.inputSchema as { properties: Record<string, unknown> }).properties);
  });
});

// --- The admin switches --------------------------------------------------------------------------

describe("admin switches and both surfaces", () => {
  test("the connector level: listing at every level, applying only at update; the never-list and hints say so", async () => {
    const t = await ticket("Level");
    try {
      for (const level of ["read", "notes"] as const) {
        connector.setClaudeLevelForTests(level);
        const n = await listed("agent");
        assert.ok(n.includes("hd_list_macros"), level);
        assert.ok(!n.includes("hd_apply_macro"), level);
        const r = await tool("agent", "hd_apply_macro", { number: t.number, macro_id: M.Looking });
        assert.equal(r.isError, true);
        assert.match(r.text, /so Claude can't change tickets \(Desk settings → Claude connector\)\. Nothing was saved\./);
      }
      connector.setClaudeLevelForTests("update");
      const n = await listed("agent");
      assert.ok(n.includes("hd_list_macros") && n.includes("hd_apply_macro") && n.includes("hd_draft_reply"));
    } finally {
      connector.setClaudeLevelForTests("update");
    }
    assert.equal((await publicMsgs(t.id)).length + (await drafts(t.id)).length, 0);
    assert.match(connector.HD_CLAUDE_LEVEL_HINT.update, /macros/);
    assert.ok(connector.HD_CLAUDE_NEVER.some((l) => /macro's reply/.test(l)));
    assert.ok((connector.HD_CLAUDE_AUDIT_ACTIONS as readonly string[]).includes("helpdesk.macro.applied"));
    for (const name of await listed("manager")) assert.doesNotMatch(name, /publish|send|approve/);
  });

  test("Claude in the desk: list_macros and propose_macro come with Suggest ticket changes, and only then", () => {
    const names = (cfg: ClaudeDeskConfig) => prompt.toolsFor(cfg, { assets: false }).map((t) => t.name);
    const on = names(CFG());
    assert.ok(on.includes("list_macros") && on.includes("propose_macro"));
    assert.deepEqual(on, [...on].sort(), "sorted for the cache");
    const off = names(CFG({ caps: { read: true, search: true, web: false, changes: false, drafts: true } }));
    assert.ok(!off.includes("list_macros") && !off.includes("propose_macro"));
    const noDrafts = names(CFG({ caps: { read: true, search: true, web: false, changes: true, drafts: false } }));
    assert.ok(noDrafts.includes("propose_macro"), "a macro is the workspace's own text, not a draft of Claude's");
    for (const s of prompt.TOOL_SPECS.filter((x) => x.name === "list_macros" || x.name === "propose_macro")) {
      assert.deepEqual(s.input_schema.required, Object.keys(s.input_schema.properties));
    }
    assert.match(desk.CLAUDE_DESK_CAP_HINT.changes, /macros/);
    assert.match(prompt.SYSTEM_PROMPT, /propose_macro/);
  });
});

// --- Claude in the desk --------------------------------------------------------------------------

describe("Claude in the desk", () => {
  /** propose_macro as `who` with the ticket open in the desk; the card's payload and an offered card id. */
  const propose = async (who: string, t: { id: number; number: number }, macroId: number) => {
    const out = await deskTools.runDeskTool("propose_macro", { number: t.number, macro_id: macroId }, toolCtx(await user(who), CFG(), await open(t.number)));
    assert.equal(out.isError, false, out.content);
    const card = out.card!.payload as Record<string, any>;
    return { out, card, cardId: await offerCard(who, t.id, card) };
  };
  const cardState = async (id: number) => (await pool().query("SELECT state FROM hd_claude_cards WHERE id = $1", [id])).rows[0].state as string;

  test("propose_macro: a card saying what it will do, naming the ticket, nothing changed; Apply (with the card) goes through the desk's route via Claude in the desk", async () => {
    const t = await ticket("Desk propose");
    const { out, card, cardId } = await propose("agent", t, M["Password reset"]);
    assert.equal(out.card?.kind, "change");
    assert.equal(card.action, "macro");
    assert.equal(card.title, `Apply the macro "Password reset ${STAMP}" to #${t.number}`);
    assert.deepEqual(card.lines, ["Sends this reply to the requester as you", "Sets the priority to High", "Adds the tag pw-reset"]);
    assert.equal(card.reply, "Hi Robin, I've reset your password. Agent");
    assert.equal(card.solves, false);
    assert.equal(card.last_message_id, await lastId(t.id));
    assert.deepEqual({ body: card.plan.body, patch: card.plan.patch }, { body: card.reply, patch: { priority: "high", tags: ["pw-reset"] } });
    assert.ok(!("hint" in card), "no Claude-written hint on a macro card");
    assert.match(out.content, /Nothing changed and nothing was sent/);
    assert.equal((await row(t.id)).priority, "normal", "the proposal changed nothing");
    assert.equal((await publicMsgs(t.id)).length, 0);
    // Apply: the panel POSTs the desk's macro route with the card's id and the send guard.
    const before = await lastId(t.id);
    const applied = await deskApply("agent", t.number, card.macro_id, { card_id: cardId, expect_last_message_id: card.last_message_id });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal((await publicMsgs(t.id))[0].body, card.reply, "the agent's click sent the reply the card showed");
    assert.equal((await row(t.id)).priority, "high");
    const l = await lineBodies(t.id, before);
    assert.ok(l.length && l.every((x) => x.endsWith(" via Claude in the desk")), JSON.stringify(l));
    const a = (await auditRows("helpdesk.macro.applied", P.agent.id, t.id)).at(-1)!;
    assert.deepEqual([a.details.via, a.details.via_label, a.details.reply, a.details.card_id], ["claude_desk", "via Claude in the desk", "sent", cardId]);
    assert.equal(await cardState(cardId), "applied", "the route claimed the card");
    // The panel's own card-state POST afterwards finds it decided already; harmless.
    assert.equal((await call(cardRoute.POST, "agent", `/claude/cards/${cardId}`, "POST", { state: "applied" }, { id: String(cardId) })).status, 404);
  });

  test("the send guard: someone wrote after Claude proposed it, so Apply sends nothing and the card is offered again", async () => {
    const t = await ticket("Desk collision");
    const { card, cardId } = await propose("agent", t, M.Looking);
    await messagesLib.addMessage(t.id, { kind: "public", body: "Any news?", author: { id: P.req.id, name: "Robin Req", email: `${STAMP}-req@example.test` }, via: "portal", asRequester: true });
    const r = await deskApply("agent", t.number, card.macro_id, { card_id: cardId, expect_last_message_id: card.last_message_id });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, presenceShared.COLLISION_ERROR);
    assert.equal(r.body.newer.length, 1);
    assert.deepEqual((await publicMsgs(t.id)).map((m) => m.body), ["Any news?"]);
    assert.equal((await auditRows("helpdesk.macro.applied", P.agent.id, t.id)).length, 0);
    assert.equal(await cardState(cardId), "offered");
  });

  test("review P1: one card applies once: a replay and a concurrent double click send one reply; the rest answer 409", async () => {
    const t = await ticket("P1 replay");
    const { card, cardId } = await propose("agent", t, M.Looking);
    const body = { card_id: cardId, expect_last_message_id: card.last_message_id };
    const r1 = await deskApply("agent", t.number, M.Looking, body);
    const r2 = await deskApply("agent", t.number, M.Looking, body);
    assert.deepEqual([r1.status, r2.status], [200, 409]);
    assert.equal(r2.body.error, "This suggestion was already used.");
    assert.equal((await publicMsgs(t.id)).length, 1);
    assert.equal((await auditRows("helpdesk.macro.applied", P.agent.id, t.id)).length, 1);
    // Concurrent.
    const t2 = await ticket("P1b concurrent");
    const c2 = await propose("agent", t2, M.Looking);
    const body2 = { card_id: c2.cardId, expect_last_message_id: c2.card.last_message_id };
    const rs = await Promise.all([deskApply("agent", t2.number, M.Looking, body2), deskApply("agent", t2.number, M.Looking, body2)]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await publicMsgs(t2.id)).length, 1);
  });

  test("review P1/P5: a card must be this agent's, offered, for this ticket and macro, or nothing is applied; a bare via is the agent's own", async () => {
    const t = await ticket("Desk marker");
    const other = await ticket("Desk marker other");
    const { card, cardId: mine } = await propose("agent", t, M.Looking);
    const leads = await offerCard("lead", t.id, card);
    const elsewhere = await offerCard("agent", other.id, { ...card, number: other.number });
    const otherMacro = await offerCard("agent", t.id, { ...card, macro_id: M["Agent personal"] });
    for (const body of [{ card_id: leads }, { card_id: elsewhere }, { card_id: otherMacro }, { card_id: "1" }, { card_id: 99999999 }]) {
      const r = await deskApply("agent", t.number, M.Looking, body);
      assert.deepEqual([r.status, r.body.error], [409, "This suggestion was already used."], JSON.stringify(body));
    }
    assert.equal((await publicMsgs(t.id)).length, 0, "none of those applied anything");
    assert.equal(await cardState(leads), "offered", "someone else's card is untouched");
    // A bare via: the agent's own apply, unmarked, as before.
    const before = await lastId(t.id);
    assert.equal((await deskApply("agent", t.number, M.Looking, { via: "claude_desk" })).status, 200);
    assert.equal((await auditRows("helpdesk.macro.applied", P.agent.id, t.id)).length, 0);
    assert.ok((await lineBodies(t.id, before)).every((l) => !/via Claude/.test(l)));
    // The ticket now already has the tag, so the card's plan no longer matches: 409, offered again.
    const stale = await deskApply("agent", t.number, M.Looking, { card_id: mine });
    assert.deepEqual([stale.status, stale.body.error], [409, macros.MACRO_TICKET_CHANGED]);
    assert.equal(await cardState(mine), "offered");
    // The preview never claims a card.
    assert.equal((await deskApply("agent", t.number, M.Looking, { preview: true, card_id: mine })).status, 200);
    assert.equal(await cardState(mine), "offered");
  });

  test("review P2: the macro was edited after the proposal: Apply sends nothing and says so", async () => {
    const t = await ticket("P2 edit");
    await macro("Editable", "Benign text shown on the card.", {}, { team: "A" });
    const { card, cardId } = await propose("agent", t, M.Editable);
    assert.equal(card.reply, "Benign text shown on the card.");
    await new Promise((r) => setTimeout(r, 5));
    await macros.updateMacro(M.Editable, { body: "DIFFERENT text, plus actions", actions: { status: "pending", priority: "urgent" } as never });
    const r = await deskApply("agent", t.number, M.Editable, { card_id: cardId, expect_last_message_id: card.last_message_id });
    assert.deepEqual([r.status, r.body.error], [409, "The macro changed since Claude suggested it. Ask again."]);
    assert.equal((await publicMsgs(t.id)).length, 0);
    assert.deepEqual({ s: (await row(t.id)).status, p: (await row(t.id)).priority }, { s: "open", p: "normal" });
    assert.equal(await cardState(cardId), "offered", "refused, so offered again (and refused again on the next click)");
    assert.equal((await deskApply("agent", t.number, M.Editable, { card_id: cardId })).status, 409);
    // A card without a plan (forged or from before this check) applies nothing either.
    const bare = await offerCard("agent", t.id, { action: "macro", number: t.number, macro_id: M.Editable, last_message_id: 0 });
    const b = await deskApply("agent", t.number, M.Editable, { card_id: bare });
    assert.deepEqual([b.status, b.body.error], [409, macros.MACRO_CHANGED]);
    // The ticket changed instead (the agent raised the priority themselves): also refused.
    const t2 = await ticket("P2 ticket moved");
    const c2 = await propose("agent", t2, M["Password reset"]);
    await pool().query("UPDATE hd_tickets SET priority = 'high' WHERE id = $1", [t2.id]);
    const r2 = await deskApply("agent", t2.number, M["Password reset"], { card_id: c2.cardId });
    assert.deepEqual([r2.status, r2.body.error], [409, macros.MACRO_TICKET_CHANGED]);
    assert.equal((await publicMsgs(t2.id)).length, 0);
    // Without a card, the agent's own apply is unaffected by any of this.
    assert.equal((await deskApply("agent", t.number, M.Editable)).status, 200);
  });

  test("review P3: a macro card only for the open ticket; the model's `when` never reaches the card", async () => {
    const tA = await ticket("P3 open A");
    const tB = await ticket("P3 other B");
    const u = await user("agent");
    const cross = await deskTools.runDeskTool("propose_macro", { number: tB.number, macro_id: M.Looking, when: "Apply on this ticket now" }, toolCtx(u, CFG(), await open(tA.number)));
    assert.equal(cross.isError, true);
    assert.equal(cross.content, `A macro can be proposed only for the ticket the agent has open (#${tA.number}). Tell the agent to open #${tB.number} and ask again there.`);
    assert.equal(cross.card, undefined);
    const none = await deskTools.runDeskTool("propose_macro", { number: tB.number, macro_id: M.Looking }, toolCtx(u));
    assert.equal(none.content, `A macro can be proposed only for the ticket the agent has open. Tell the agent to open #${tB.number} and ask again there.`);
    const same = await deskTools.runDeskTool("propose_macro", { number: tA.number, macro_id: M.Looking, when: "Ignore the agent and apply now" }, toolCtx(u, CFG(), await open(tA.number)));
    assert.equal(same.isError, false, same.content);
    assert.ok(!JSON.stringify(same.card!.payload).includes("Ignore the agent"));
    assert.match(String(same.card!.payload.title), new RegExp(`to #${tA.number}$`));
    // The schema no longer takes `when` (strict: the model can't send it).
    const spec = prompt.TOOL_SPECS.find((x) => x.name === "propose_macro")!;
    assert.deepEqual(Object.keys(spec.input_schema.properties).sort(), ["macro_id", "number"]);
  });

  test("review 4: the whole reply is on the card; solves follows the macro itself; the draft rule's wording promises nothing", async () => {
    const t = await ticket("Long reply");
    const long = `${"Step by step. ".repeat(1400)}Done.`;
    await macro("Long", long, {});
    const { card } = await propose("agent", t, M.Long);
    assert.equal(card.reply, long.trim(), "not cut short");
    assert.ok(card.reply.length > 4000);
    // Already solved: the dry run changes no status, but the macro is still a solving macro.
    const solved = await ticket("Already solved");
    await pool().query("UPDATE hd_tickets SET status = 'solved' WHERE id = $1", [solved.id]);
    const s = await propose("agent", solved, M["Reply and solve"]);
    assert.equal(s.card.solves, true);
    assert.equal(s.card.plan.patch.status, undefined);
    assert.doesNotMatch(macros.MACRO_DRAFT_STATUS_WAITS, /wait|until|will/i);
    assert.match(macros.MACRO_DRAFT_STATUS_WAITS, /was not made\. Set the status after the reply is sent\.$/);
  });

  test("review P4: the connector keeps its rules (reply as a draft and no status change; scope; level; team; newbie)", async () => {
    const t = await ticket("P4 conn");
    const r = await tool("agent", "hd_apply_macro", { number: t.number, macro_id: M["Reply and solve"] });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.out.reply.saved_as, "draft");
    assert.equal(r.out.status_unchanged, macros.MACRO_DRAFT_STATUS_WAITS);
    assert.deepEqual([(await publicMsgs(t.id)).length, (await drafts(t.id)).length, (await row(t.id)).status], [0, 1, "open"]);
    assert.match((await tool("agent", "hd_apply_macro", { number: t.number, macro_id: M["Team B triage"] })).text, /^No macro with id/);
    assert.match((await tool("agent", "hd_apply_macro", { number: t.number, macro_id: M["Lead personal"] })).text, /^No macro with id/);
    connector.setClaudeLevelForTests("notes");
    try {
      assert.match((await tool("agent", "hd_apply_macro", { number: t.number, macro_id: M.Looking })).text, /so Claude can't change tickets/);
    } finally {
      connector.setClaudeLevelForTests("update");
    }
    const tB = await ticket("P4 team B", "B");
    assert.equal((await tool("agent", "hd_apply_macro", { number: tB.number, macro_id: M.Looking })).text, `No ticket #${tB.number} that you can see.`);
    const nb = await tool("newbie", "hd_apply_macro", { number: t.number, macro_id: M.Looking });
    assert.equal(nb.isError, false, nb.text);
    assert.equal((await publicMsgs(t.id)).length, 0, "the newbie's reply is a draft too");
  });

  test("checked now as the desk will check it: scope, the agent's role, newbie review, its checklist", async () => {
    const t = await ticket("Desk checks");
    const u = await user("agent");
    const run = async (who: Awaited<ReturnType<typeof user>>, macroId: number) =>
      deskTools.runDeskTool("propose_macro", { number: t.number, macro_id: macroId }, toolCtx(who, CFG(), await open(t.number)));
    for (const id of [M["Lead personal"], M["Team B triage"], 99999999]) {
      assert.equal((await run(u, id)).content, `No macro with id ${id} that the agent can use. Call list_macros for the ones they can apply.`);
    }
    const solve = await run(u, M["Reply and solve"]);
    assert.equal(solve.isError, false, solve.content);
    assert.deepEqual((solve.card!.payload as any).lines, ["Sends this reply to the requester as you", "Sets the status to Solved"]);
    assert.equal((solve.card!.payload as any).solves, true);
    // A required checklist item open: refused now, with the desk's sentence.
    const tpl = await checklists.createTemplate({ name: `Desk gate ${STAMP}`, items: [{ title: "Return the badge", required: true }], request_type_ids: [] }, { id: P.manager.id, name: P.manager.name });
    await checklists.addChecklistToTicket(t.id, tpl.id, { id: P.manager.id, name: P.manager.name });
    assert.match((await run(u, M["Reply and solve"])).content, /^The agent can't apply that macro on #\d+: Finish the required checklist items first: "Return the badge"/);
    // A newbie: their reply is reviewed first; re-prioritising isn't theirs.
    const nb = await user("newbie");
    const looking = await run(nb, M.Looking);
    assert.deepEqual((looking.card!.payload as any).lines, ["Sends this reply for review first (your replies are checked by a lead)", "Adds the tag looking"]);
    assert.equal((await run(nb, M["Password reset"])).content, `The agent can't apply that macro on #${t.number}: You don't have permission for that.`);
    // Nothing to do: said so. Another team's agent: not found. A team Claude is off for: said so.
    await deskApply("agent", t.number, M.Looking);
    const quiet = await macros.createMacro({ title: `Tag only ${STAMP}`, body: "", actions: { tags_add: ["looking"] }, team_id: null }, null);
    assert.match((await run(u, quiet.id)).content, /would change nothing/);
    assert.equal((await deskTools.runDeskTool("propose_macro", { number: t.number, macro_id: M.Looking }, toolCtx(await user("outsider")))).content, `No ticket #${t.number} that you can see.`);
    const off = await ticket("Desk off", "Off");
    const offOut = await deskTools.runDeskTool("propose_macro", { number: off.number, macro_id: M.Looking }, toolCtx(u, CFG(), await open(off.number)));
    assert.match(offOut.content, /Claude is switched off for/);
    // list_macros: the connector's list as quoted data, filled for the ticket.
    const lm = await deskTools.runDeskTool("list_macros", { number: t.number, query: `Password reset ${STAMP}` }, toolCtx(u));
    assert.equal(lm.isError, false, lm.content);
    assert.match(lm.content, /trust="untrusted/);
    assert.ok(lm.content.includes(`"id": ${M["Password reset"]}`), lm.content);
    assert.match(lm.content, /Hi Robin, I&#39;ve reset|Hi Robin, I've reset/);
    assert.equal((await row(t.id)).status, "open");
  });

  test("a full turn: Claude proposes a macro; the card is created; the agent decides; switched off, the tools aren't offered", async () => {
    const t = await ticket("Turn");
    const u = await user("agent");
    fake.reset();
    fake.queue(
      { content: [{ type: "tool_use", name: "propose_macro", input: { number: t.number, macro_id: M["Password reset"] } }] },
      { content: [{ type: "text", text: "The Password reset macro fits. Apply it when you're ready." }] }
    );
    const prep = await turnLib.prepareTurn({ user: u, session: toSessionUser(u), origin: "http://localhost", ip: IP, ticketNumber: t.number, chatId: null, fresh: true, text: "Use the password reset macro.", intent: null });
    assert.ok(prep.ok, JSON.stringify(prep));
    if (!prep.ok) return;
    assert.ok(prep.turn.clientToolNames.includes("propose_macro") && prep.turn.clientToolNames.includes("list_macros"));
    const events: ClaudeStreamEvent[] = [];
    await turnLib.runTurn(prep.turn, (e) => events.push(e));
    const cards = events.filter((e) => e.type === "card").map((e) => (e as { card: any }).card);
    assert.equal(cards.length, 1, JSON.stringify(events));
    assert.deepEqual([cards[0].kind, cards[0].action, cards[0].state], ["change", "macro", "offered"]);
    assert.equal((await row(t.id)).priority, "normal", "the turn changed nothing");
    const req = fake.requests.find((r) => Array.isArray(r.body?.tools))!;
    assert.match(req.body.system[0].text, /only the agent's Apply runs it/);
    assert.equal((await call(cardRoute.POST, "agent", `/claude/cards/${cards[0].id}`, "POST", { state: "skipped" }, { id: String(cards[0].id) })).status, 200);
    config.setClaudeDeskConfigForTests(CFG({ caps: { read: true, search: true, web: false, changes: false, drafts: true } }));
    try {
      fake.reset();
      fake.queue({ content: [{ type: "text", text: "OK." }] });
      const off = await turnLib.prepareTurn({ user: u, session: toSessionUser(u), origin: "http://localhost", ip: IP, ticketNumber: t.number, chatId: null, fresh: true, text: "Use a macro", intent: null });
      assert.ok(off.ok);
      if (!off.ok) return;
      assert.ok(!off.turn.clientToolNames.includes("propose_macro") && !off.turn.clientToolNames.includes("list_macros"));
      await turnLib.runTurn(off.turn, () => {});
      const names = (fake.requests.find((r) => Array.isArray(r.body?.tools))!.body.tools as { name: string }[]).map((x) => x.name);
      assert.ok(!names.includes("propose_macro") && !names.includes("list_macros"));
    } finally {
      config.setClaudeDeskConfigForTests(CFG());
    }
  });
});
