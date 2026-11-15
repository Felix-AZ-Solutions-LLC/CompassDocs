// Helpdesk 1.20.16: Claude drafts for categories, automations and recurring
// tickets (the model of 1.20.14's checklist drafts and its review fixes).
//
//   - Connector: hd_list_categories / hd_draft_categories, hd_list_automations
//     / hd_draft_automation, hd_list_recurring / hd_draft_recurring. A draft
//     never takes effect without a person: a draft rule never fires, a draft
//     schedule never opens a ticket, a drafted category is in no picker and
//     refused by hd_update_ticket until it is published. Changes wait beside
//     the live thing. Validation is the settings API's own.
//   - Settings routes: publish / publish_draft name the reviewed draft_at
//     (409 otherwise), a plain save keeps a pending draft, discard; audit
//     .published / .draft_discarded; row locks (a publish racing a Claude
//     draft never takes Claude's content live).
//   - Claude in the desk: draft_categories / draft_automation /
//     draft_recurring give cards (under Draft replies and internal notes);
//     Save as draft goes through the settings route with a claimed,
//     single-use card.
//   - Permissions per role, licence and connector level.
//
// Harness as test/helpdesk-checklist-mcp. Parallel-safe: everything is this
// file's own (STAMP); the category draft is a single row, so this file
// leaves none behind.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-automation-drafts.test.ts

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
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.automation-drafts.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.automation-drafts.virtual.js");
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
const automations = require("../src/lib/helpdesk/automations") as typeof import("../src/lib/helpdesk/automations");
const recurring = require("../src/lib/helpdesk/recurring") as typeof import("../src/lib/helpdesk/recurring");
const categories = require("../src/lib/helpdesk/categories") as typeof import("../src/lib/helpdesk/categories");
const catDrafts = require("../src/lib/helpdesk/category-drafts") as typeof import("../src/lib/helpdesk/category-drafts");
const catDraftsShared = require("../src/lib/helpdesk/category-drafts-shared") as typeof import("../src/lib/helpdesk/category-drafts-shared");
const auditLabels = require("../src/lib/audit-labels") as typeof import("../src/lib/audit-labels");
const autoRoute = require("../src/app/api/helpdesk/admin/automations/route") as typeof import("../src/app/api/helpdesk/admin/automations/route");
const autoOneRoute = require("../src/app/api/helpdesk/admin/automations/[id]/route") as typeof import("../src/app/api/helpdesk/admin/automations/[id]/route");
const recRoute = require("../src/app/api/helpdesk/admin/recurring/route") as typeof import("../src/app/api/helpdesk/admin/recurring/route");
const recOneRoute = require("../src/app/api/helpdesk/admin/recurring/[id]/route") as typeof import("../src/app/api/helpdesk/admin/recurring/[id]/route");
const recRunRoute = require("../src/app/api/helpdesk/admin/recurring/[id]/run/route") as typeof import("../src/app/api/helpdesk/admin/recurring/[id]/run/route");
const catRoute = require("../src/app/api/helpdesk/admin/categories/route") as typeof import("../src/app/api/helpdesk/admin/categories/route");
const catDraftRoute = require("../src/app/api/helpdesk/admin/categories/draft/route") as typeof import("../src/app/api/helpdesk/admin/categories/draft/route");
const cardRoute = require("../src/app/api/helpdesk/claude/cards/[id]/route") as typeof import("../src/app/api/helpdesk/claude/cards/[id]/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdRole } from "../src/lib/helpdesk/roles-shared";
import type { ClaudeDeskConfig, ClaudeStreamEvent } from "../src/lib/helpdesk/claude/shared";

const STAMP = `hdad-${Date.now()}-${process.pid}`;
// A word only this file's tickets carry (keywords match whole words).
const WORD = `zq${process.pid}x${Date.now().toString(36)}`;
const IP = "203.0.113.161";
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
const T: Record<string, number> = {};
let fake: FakeAnthropic;

const CFG = (patch: Partial<ClaudeDeskConfig> = {}): ClaudeDeskConfig => ({
  ...desk.CLAUDE_DESK_DEFAULTS,
  enabled: true,
  teams_off: [],
  caps: { read: true, search: true, web: false, changes: true, drafts: true },
  ...patch,
});

async function person(key: string, deskRole: HdRole | null, teams: string[] = [], teamRole = "agent") {
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
  for (const tm of teams) await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [T[tm], id, teamRole]);
  P[key] = { id, name, session };
}

async function ticket(subject: string, team = "A", extra: { category?: string; subcategory?: string } = {}): Promise<{ id: number; number: number }> {
  const r = await pool().query(
    "INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status, source, category, subcategory) VALUES ($1, $2, 'Req', $3, $4, 'open', 'portal', $5, $6) RETURNING id, number",
    [`${subject} ${STAMP}`, P.req.id, `${STAMP}-req@example.test`, T[team], extra.category ?? "", extra.subcategory ?? ""]
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
const patchRule = (who: string, id: number, body: Record<string, unknown>) => call(autoOneRoute.PATCH, who, `/admin/automations/${id}`, "PATCH", body, { id: String(id) });
/** What the review dialog sends on publish: the rule as shown (the draft's fields, else the row's). */
async function shown(id: number): Promise<Record<string, unknown>> {
  const a = (await automations.getAutomation(id))!;
  const d = a.draft ?? a;
  return { name: d.name, event: d.event, conditions: d.conditions, actions: d.actions };
}
const patchSched = (who: string, id: number, body: Record<string, unknown>) => call(recOneRoute.PATCH, who, `/admin/recurring/${id}`, "PATCH", body, { id: String(id) });
const putCatDraft = (who: string, body: Record<string, unknown>) => call(catDraftRoute.PUT, who, "/admin/categories/draft", "PUT", body);

const auditRows = async (action: string, actor: number, targetId?: number | null) =>
  (
    await pool().query(
      `SELECT details, ip, target_id FROM audit_log WHERE action = $1 AND actor_id = $2${targetId ? " AND target_id = $3" : ""} ORDER BY id`,
      targetId ? [action, actor, targetId] : [action, actor]
    )
  ).rows as { details: Record<string, unknown>; ip: string | null; target_id: number | null }[];
const ruleRow = async (id: number) => (await pool().query("SELECT name, active, published, conditions, actions, draft, draft_by_name, draft_via, draft_at FROM hd_automations WHERE id = $1", [id])).rows[0];
const schedRow = async (id: number) =>
  (await pool().query("SELECT subject, enabled, published, next_run_at, draft, draft_by_name, draft_via, draft_at FROM hd_recurring WHERE id = $1", [id])).rows[0];
const tagsOf = async (id: number) => (await pool().query("SELECT tags FROM hd_tickets WHERE id = $1", [id])).rows[0].tags as string[];
const ticketCat = async (id: number) => (await pool().query("SELECT category, subcategory FROM hd_tickets WHERE id = $1", [id])).rows[0] as { category: string; subcategory: string };
const draftRow = async () => (await pool().query("SELECT changes, draft_by_name, draft_via, draft_at FROM hd_category_draft WHERE id = 1")).rows[0];

function toolCtx(u: Awaited<ReturnType<typeof user>>, cfg = CFG()) {
  return { user: u, session: toSessionUser(u), origin: "http://localhost", ip: IP, cfg, chatId: 0, ticket: null, includeNotes: false, touched: new Set<number>(), notesSeen: [] as string[] };
}

/** A Claude in the desk card offered to `who` (as a turn stores it); its id. */
async function offerCard(who: string, payload: Record<string, unknown>, kind: "change" | "checklist" = "change"): Promise<number> {
  const chat = await pool().query("INSERT INTO hd_claude_chats (user_id, ticket_id, title) VALUES ($1, NULL, $2) RETURNING id", [P[who].id, `card ${STAMP}`]);
  return chats.createCard({ chatId: chat.rows[0].id, userId: P[who].id, ticketId: null, kind, payload });
}
const cardState = async (id: number) => (await pool().query("SELECT state FROM hd_claude_cards WHERE id = $1", [id])).rows[0].state as string;

/** A rule as Desk settings makes it: on, published, only for this file's tickets. */
async function liveRule(name: string, actions: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<number> {
  const v = await automations.validateAutomationInput({ name: `${name} ${STAMP}`, event: "ticket_created", conditions: { keywords: [WORD], ...(extra.conditions as object) }, actions });
  assert.ok(v.ok, JSON.stringify(v));
  return (await automations.createAutomation(v.value as import("../src/lib/helpdesk/automations").AutomationInput)).id;
}

const MONTHLY = { kind: "monthly", mode: "nth_weekday", nth: 1, weekday: 1, months: [], time: "09:00" };
async function liveSchedule(subject: string): Promise<number> {
  const v = await recurring.validateRecurringInput({ team_id: T.A, subject: `${subject} ${STAMP}`, pattern: MONTHLY, timezone: "UTC" });
  assert.ok(v.ok, JSON.stringify(v));
  return (await recurring.createRecurring(v.value, P.dadmin.id)).id;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  fake = await startFakeAnthropic();
  process.env.COMPASSDOCS_ANTHROPIC_BASE_URL = fake.url;
  aiConfig.setAiConfigForTests({ key: "sk-ant-fake-test", model: "claude-opus-5-5", provider: "anthropic" });
  roles.setRoleMatrixForTests(rolesShared.HD_DEFAULT_MATRIX);
  turnLib.setClaudeTurnLimitsForTests({ minute: 1000, hour: 1000 });
  for (const k of ["A", "B"]) T[k] = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9460) RETURNING id", [`${STAMP} ${k}`])).rows[0].id;
  await person("agent", "agent", ["A"]);
  await person("newbie", "newbie", ["A"]);
  await person("lead", "team_lead", ["A"], "lead");
  await person("manager", "manager", ["A"]);
  await person("dadmin", "admin", ["A"]);
  await person("req", null);
  config.setClaudeDeskConfigForTests(CFG());
  connector.setClaudeLevelForTests("notes");
  // The category draft is one row: none may be waiting when this file starts (another run's).
  await pool().query("DELETE FROM hd_category_draft WHERE draft_by_name LIKE $1", ["% hdad-%"]);
});

after(async () => {
  aiConfig.setAiConfigForTests(null);
  config.setClaudeDeskConfigForTests(null);
  connector.setClaudeLevelForTests(null);
  roles.setRoleMatrixForTests(null);
  turnLib.setClaudeTurnLimitsForTests(null);
  delete process.env.COMPASSDOCS_ANTHROPIC_BASE_URL;
  await fake.close();
  await pool().query("DELETE FROM hd_category_draft WHERE draft_by_name LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM hd_claude_usage WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_claude_chats WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1) OR requester_id = ANY($2) OR subject LIKE $3", [ticketIds, userIds, `%${STAMP}%`]);
  await pool().query("DELETE FROM hd_automations WHERE name LIKE $1", [`%${STAMP}%`]);
  await pool().query("DELETE FROM hd_recurring WHERE subject LIKE $1 OR team_id = ANY($2)", [`%${STAMP}%`, Object.values(T)]);
  await pool().query("DELETE FROM hd_categories WHERE name LIKE $1", [`%${STAMP}%`]);
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

// --- Automations ----------------------------------------------------------------------------------

describe("automations: a draft rule never fires until a person publishes it", () => {
  test("hd_draft_automation saves a new rule off and unpublished; it never runs, even switched on behind its back; publishing runs it", async () => {
    const r = await tool("manager", "hd_draft_automation", {
      name: `Tag VPN ${STAMP}`,
      event: "ticket_created",
      conditions: { keywords: [WORD] },
      actions: { tags_add: ["claude-drafted"], priority: "high" },
    });
    assert.equal(r.isError, false, r.text);
    const id = r.out.id as number;
    assert.equal(r.out.saved, "draft (switched off, not published)");
    assert.equal(r.out.active, false);
    assert.equal(r.out.published, false);
    assert.equal(r.out.edit_url, `http://localhost/desk/settings/automations?id=${id}`);
    assert.deepEqual(r.out.in_words.then, ["set the priority to High", "add the tag claude-drafted"]);
    let row = await ruleRow(id);
    assert.equal(row.active, 0);
    assert.equal(row.published, 0);
    assert.equal(row.draft_via, "mcp");
    assert.equal(row.draft_by_name, P.manager.name);
    const a = await auditRows("helpdesk.automation.created", P.manager.id, id);
    assert.equal(a.length, 1);
    assert.equal(a[0].details.draft, true);
    assert.equal(a[0].details.published, false);
    assert.equal(a[0].details.via, "mcp");
    assert.equal(a[0].ip, IP);
    assert.ok((await connector.recentClaudeActivity(100)).some((x) => x.actor_id === P.manager.id && x.summary === `Saved an automation draft: Tag VPN ${STAMP}`));

    // Never fires: off, and even if someone forced it on in the database, unpublished.
    const t1 = await ticket(`Printer ${WORD} one`);
    assert.ok(!(await automations.runAutomations("ticket_created", t1.id)).ran.includes(id));
    await pool().query("UPDATE hd_automations SET active = 1 WHERE id = $1", [id]);
    assert.ok(!(await automations.runAutomations("ticket_created", t1.id)).ran.includes(id), "a draft never runs");
    await pool().query("UPDATE hd_automations SET active = 0 WHERE id = $1", [id]);
    assert.ok(!(await tagsOf(t1.id)).includes("claude-drafted"));

    // Turn on is refused for a draft; a plain save keeps it a draft and off.
    const on = await patchRule("manager", id, { active: 1 });
    assert.equal(on.status, 409);
    assert.match(on.body.error, /Publish it to switch it on/);
    const saved = await patchRule("manager", id, { name: `Tag VPN v2 ${STAMP}` });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.automation.published, false);
    assert.equal(saved.body.automation.active, 0);
    // Publishing names the reviewed draft: without it, or a wrong one, 409; an agent can't.
    assert.equal((await patchRule("agent", id, { ...(await shown(id)), publish: true })).status, 403);
    assert.equal((await patchRule("manager", id, { ...(await shown(id)), publish: true })).status, 409);
    assert.equal((await patchRule("manager", id, { ...(await shown(id)), publish: true, draft_at: "2001-01-01T00:00:00Z" })).status, 409);
    const at = (await automations.getAutomation(id))!.draft_at;
    const pub = await patchRule("manager", id, { ...(await shown(id)), publish: true, draft_at: at });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.equal(pub.body.automation.published, true);
    assert.equal(pub.body.automation.active, 1, "publishing switches it on");
    assert.equal(pub.body.automation.draft_by_name, "");
    const p = await auditRows("helpdesk.automation.published", P.manager.id, id);
    assert.equal(p.length, 1);
    assert.equal(p[0].details.drafted_via, "mcp");
    assert.equal(p[0].details.drafted_by, P.manager.name);
    // Now it runs.
    const t2 = await ticket(`Printer ${WORD} two`);
    assert.ok((await automations.runAutomations("ticket_created", t2.id)).ran.includes(id));
    assert.ok((await tagsOf(t2.id)).includes("claude-drafted"));
    row = await ruleRow(id);
    assert.equal(row.draft, null);
    await automations.deleteAutomation(id);
  });

  test("changes beside a running rule: it keeps running unchanged; discard keeps it; publish_draft applies them", async () => {
    const id = await liveRule("Route", { tags_add: ["live-tag"] });
    const r = await tool("manager", "hd_draft_automation", { id, actions: { tags_add: ["draft-tag"] } });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.out.saved, "draft of changes (the live rule keeps running unchanged)");
    let row = await ruleRow(id);
    assert.deepEqual(row.actions, { tags_add: ["live-tag"] });
    assert.deepEqual(row.draft.actions, { tags_add: ["draft-tag"] });
    assert.equal(row.draft.name, `Route ${STAMP}`, "fields not sent come from the live rule");
    assert.deepEqual((await auditRows("helpdesk.automation.updated", P.manager.id, id)).at(-1)!.details.changed, ["draft"]);
    const t1 = await ticket(`Route ${WORD} one`);
    await automations.runAutomations("ticket_created", t1.id);
    assert.ok((await tagsOf(t1.id)).includes("live-tag") && !(await tagsOf(t1.id)).includes("draft-tag"), "the live rule runs as it was");
    const one = await tool("manager", "hd_list_automations", { id });
    assert.equal(one.out.status, "on, with changes from Claude waiting for review");
    assert.deepEqual(one.out.draft.actions, { tags_add: ["draft-tag"] });
    const all = await tool("manager", "hd_list_automations", {});
    assert.ok(all.out.automations.some((x: { id: number; status: string }) => x.id === id && /changes from Claude/.test(x.status)));

    // Discard: the rule stays; a second discard has nothing.
    const gone = await patchRule("manager", id, { discard_draft: true, draft_at: (await automations.getAutomation(id))!.draft_at });
    assert.equal(gone.status, 200);
    assert.equal(gone.body.automation.draft, null);
    assert.deepEqual(gone.body.automation.actions, { tags_add: ["live-tag"] });
    assert.equal((await patchRule("manager", id, { discard_draft: true })).status, 409);
    assert.equal((await auditRows("helpdesk.automation.draft_discarded", P.manager.id, id)).length, 1);

    // Draft again; publish_draft with the reviewed draft_at applies it (on/off kept).
    await tool("manager", "hd_draft_automation", { id, name: `Route v2 ${STAMP}`, actions: { tags_add: ["draft-tag"] } });
    await pool().query("UPDATE hd_automations SET active = 0 WHERE id = $1", [id]);
    const at = (await automations.getAutomation(id))!.draft_at;
    const pub = await patchRule("manager", id, { ...(await shown(id)), publish_draft: true, draft_at: at });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.equal(pub.body.automation.name, `Route v2 ${STAMP}`);
    assert.deepEqual(pub.body.automation.actions, { tags_add: ["draft-tag"] });
    assert.equal(pub.body.automation.active, 0, "publishing changes keeps on/off");
    assert.equal(pub.body.automation.draft, null);
    assert.equal((await patchRule("manager", id, { ...(await shown(id)), publish_draft: true, draft_at: at })).status, 409, "nothing waits any more");
    await automations.deleteAutomation(id);
  });

  test("validation is the settings API's: plain sentences, nothing saved", async () => {
    const n = async () => Number((await pool().query("SELECT count(*)::int AS n FROM hd_automations WHERE name LIKE $1", [`%${STAMP}%`])).rows[0].n);
    const before = await n();
    const bad = async (args: Record<string, unknown>, re: RegExp) => {
      const r = await tool("manager", "hd_draft_automation", args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.text, re);
    };
    await bad({ event: "ticket_created", actions: { priority: "high" } }, /Give the automation a name\. Nothing was saved\./);
    await bad({ name: `x ${STAMP}`, event: "whenever", actions: { priority: "high" } }, /Choose when the automation runs/);
    await bad({ name: `x ${STAMP}`, event: "ticket_created", actions: {} }, /Choose at least one action/);
    await bad({ name: `x ${STAMP}`, event: "ticket_created", conditions: { mood: ["sad"] }, actions: { priority: "high" } }, /Unknown condition: mood/);
    await bad({ name: `x ${STAMP}`, event: "ticket_created", conditions: { keywords: Array.from({ length: 51 }, (_, i) => `k${i}`) }, actions: { priority: "high" } }, /Keywords must be a list/);
    await bad({ name: `x ${STAMP}`, event: "ticket_created", actions: { team_id: 99999999 } }, /Unknown team/);
    await bad({ name: `x ${STAMP}`, event: "ticket_created", actions: { category: `Nope ${STAMP}` } }, /is not a category on the list/);
    await bad({ id: 99999999, name: `x ${STAMP}` }, /No automation with id 99999999/);
    assert.equal(await n(), before);
  });

  test("R1: a draft Claude saves while a person publishes never lands in the live rule", async () => {
    const d = await automations.saveAutomationDraft({ name: `Race ${STAMP}`, event: "ticket_created", conditions: { keywords: [WORD] }, actions: { tags_add: ["reviewed"] } }, { id: P.manager.id, name: P.manager.name, via: "mcp" });
    const c = await pool().connect();
    let r: Awaited<ReturnType<typeof automations.saveAutomationDraft>>;
    try {
      await c.query("BEGIN");
      await c.query("SELECT 1 FROM hd_automations WHERE id = $1 FOR UPDATE", [d.automation.id]);
      const pending = automations.saveAutomationDraft({ actions: { tags_add: ["unreviewed"] } }, { id: P.manager.id, name: P.manager.name, via: "mcp" }, d.automation.id);
      await new Promise((res) => setTimeout(res, 400));
      await c.query("UPDATE hd_automations SET published = 1, active = 1 WHERE id = $1", [d.automation.id]);
      await c.query("COMMIT");
      r = await pending;
    } finally {
      c.release();
    }
    assert.equal(r.kind, "changes", "it waited for the publish, then went beside the live rule");
    const row = await ruleRow(d.automation.id);
    assert.deepEqual(row.actions, { tags_add: ["reviewed"] });
    assert.deepEqual(row.draft.actions, { tags_add: ["unreviewed"] });
    const t = await ticket(`Race ${WORD}`);
    await automations.runAutomations("ticket_created", t.id);
    assert.ok((await tagsOf(t.id)).includes("reviewed") && !(await tagsOf(t.id)).includes("unreviewed"));
    await automations.deleteAutomation(d.automation.id);
  });

  test("R2: a plain save edits the live rule and keeps the draft; a partial save never takes Claude's fields", async () => {
    const id = await liveRule("Stale", { tags_add: ["live"] });
    await automations.saveAutomationDraft({ actions: { tags_add: ["claude"] } }, { id: P.manager.id, name: P.manager.name, via: "mcp" }, id);
    const r = await patchRule("manager", id, { name: `Stale renamed ${STAMP}` });
    assert.equal(r.status, 200);
    const row = await ruleRow(id);
    assert.deepEqual(row.actions, { tags_add: ["live"] });
    assert.equal(row.name, `Stale renamed ${STAMP}`);
    assert.deepEqual(row.draft.actions, { tags_add: ["claude"] }, "the draft is kept");
    assert.equal((await auditRows("helpdesk.automation.published", P.manager.id, id)).length, 0);
    // A newer draft since the person looked: publishing the old one is refused, nothing changes.
    const seen = row.draft_at;
    await new Promise((res) => setTimeout(res, 20));
    await automations.saveAutomationDraft({ actions: { tags_add: ["newer"] } }, { id: P.manager.id, name: P.manager.name, via: "mcp" }, id);
    const stale = await patchRule("manager", id, { ...(await shown(id)), publish_draft: true, draft_at: seen });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /newer draft/);
    assert.equal((await patchRule("manager", id, { discard_draft: true, draft_at: seen })).status, 409, "nor discarded unseen");
    assert.deepEqual((await ruleRow(id)).actions, { tags_add: ["live"] });
    await automations.deleteAutomation(id);
  });
});

// --- Recurring tickets -----------------------------------------------------------------------------------

describe("recurring tickets: a draft schedule never opens a ticket until a person publishes it", () => {
  const opened = async (id: number) => Number((await pool().query("SELECT count(*)::int AS n FROM hd_recurring_runs WHERE recurring_id = $1", [id])).rows[0].n);

  test("hd_draft_recurring saves a new schedule paused; the sweep and Open one now open nothing; publishing switches it on", async () => {
    const r = await tool("lead", "hd_draft_recurring", { team_id: T.A, subject: `Backup test {{month}} ${STAMP}`, pattern: MONTHLY, timezone: "UTC", due_business_days: 2 });
    assert.equal(r.isError, false, r.text);
    const id = r.out.id as number;
    assert.equal(r.out.saved, "draft (paused, not published)");
    assert.equal(r.out.enabled, false);
    assert.ok(r.out.in_words.some((l: string) => /Due in 2 business days/.test(l)), JSON.stringify(r.out.in_words));
    let row = await schedRow(id);
    assert.equal(row.enabled, 0);
    assert.equal(row.published, 0);
    assert.equal(row.next_run_at, null);
    assert.equal(row.draft_via, "mcp");
    const a = await auditRows("helpdesk.recurring.created", P.lead.id, id);
    assert.equal(a[0].details.draft, true);
    assert.equal(a[0].details.via, "mcp");

    // Forced due behind its back: the sweep still opens nothing; Open one now is refused.
    await pool().query("UPDATE hd_recurring SET enabled = 1, next_run_at = now() - interval '1 minute', next_key = '2026-01-05' WHERE id = $1", [id]);
    await recurring.recurringSweep();
    assert.equal(await opened(id), 0, "a draft opens no ticket");
    await pool().query("UPDATE hd_recurring SET enabled = 0, next_run_at = NULL, next_key = NULL WHERE id = $1", [id]);
    const run = await call(recRunRoute.POST, "lead", `/admin/recurring/${id}/run`, "POST", {}, { id: String(id) });
    assert.equal(run.status, 409);
    assert.match(run.body.error, /draft from Claude/);
    await assert.rejects(recurring.openRecurringNow(id, { id: P.lead.id, name: "x" }), /draft from Claude/);
    assert.equal(await opened(id), 0);
    // Switching it on without publishing is refused.
    assert.equal((await patchSched("lead", id, { enabled: true })).status, 409);

    // Publish (the reviewed draft_at): on, with a next run; then it opens.
    assert.equal((await patchSched("lead", id, { publish: true })).status, 409);
    const at = (await recurring.getRecurring(id))!.draft_at;
    const pub = await patchSched("lead", id, { publish: true, draft_at: at });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.equal(pub.body.schedule.published, true);
    assert.equal(pub.body.schedule.enabled, true);
    assert.ok(pub.body.schedule.next_run_at);
    assert.equal((await auditRows("helpdesk.recurring.published", P.lead.id, id)).length, 1);
    const now = await call(recRunRoute.POST, "lead", `/admin/recurring/${id}/run`, "POST", { request_id: `${STAMP}-a` }, { id: String(id) });
    assert.equal(now.status, 201, JSON.stringify(now.body));
    assert.equal(await opened(id), 1);
    row = await schedRow(id);
    assert.equal(row.draft, null);
  });

  test("changes beside a live schedule; discard; publish_draft; a plain save keeps the draft", async () => {
    const id = await liveSchedule("Fire alarm");
    const live = (await recurring.getRecurring(id))!;
    const r = await tool("dadmin", "hd_draft_recurring", { id, subject: `Fire alarm v2 ${STAMP}`, priority: "high" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.out.saved, "draft of changes (the live schedule keeps running unchanged)");
    let row = await schedRow(id);
    assert.equal(row.subject, `Fire alarm ${STAMP}`);
    assert.equal(row.enabled, 1);
    assert.equal(new Date(row.next_run_at).getTime(), new Date(live.next_run_at!).getTime(), "the next run is untouched");
    assert.equal(row.draft.subject, `Fire alarm v2 ${STAMP}`);
    assert.equal(row.draft.priority, "high");
    // A plain save edits the live one and keeps the draft.
    const plain = await patchSched("dadmin", id, { body: "Test every floor." });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    row = await schedRow(id);
    assert.equal(row.subject, `Fire alarm ${STAMP}`);
    assert.ok(row.draft);
    // Discard, then draft again and publish it.
    assert.equal((await patchSched("dadmin", id, { discard_draft: true, draft_at: row.draft_at })).status, 200);
    assert.equal((await schedRow(id)).draft, null);
    assert.equal((await auditRows("helpdesk.recurring.draft_discarded", P.dadmin.id, id)).length, 1);
    await tool("dadmin", "hd_draft_recurring", { id, subject: `Fire alarm v3 ${STAMP}` });
    const at = (await recurring.getRecurring(id))!.draft_at;
    const pub = await patchSched("dadmin", id, { publish_draft: true, draft_at: at });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.equal(pub.body.schedule.subject, `Fire alarm v3 ${STAMP}`);
    assert.equal(pub.body.schedule.body, "Test every floor.", "fields the draft took from the live one");
    assert.equal(pub.body.schedule.enabled, true);
  });

  test("validation and teams: the settings API's sentences; a lead only for their teams", async () => {
    const bad = async (who: string, args: Record<string, unknown>, re: RegExp) => {
      const r = await tool(who, "hd_draft_recurring", args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.text, re);
    };
    await bad("lead", { team_id: T.A, pattern: MONTHLY }, /Give the ticket a subject/);
    await bad("lead", { team_id: T.A, subject: `x ${STAMP}`, pattern: { kind: "weekly", days: [], time: "09:00" } }, /day|Pick/i);
    await bad("lead", { team_id: T.A, subject: `x ${STAMP}`, pattern: MONTHLY, due_business_days: 61 }, /1 to 60 business days/);
    await bad("lead", { team_id: T.B, subject: `x ${STAMP}`, pattern: MONTHLY }, /teams you lead \(403\)/);
    const other = await liveSchedule("Other team");
    await pool().query("UPDATE hd_recurring SET team_id = $2 WHERE id = $1", [other, T.B]);
    await bad("lead", { id: other, subject: `x ${STAMP}` }, /No recurring ticket with id \d+ that you manage/);
    const list = await tool("lead", "hd_list_recurring", {});
    assert.ok(!list.out.recurring.some((s: { id: number }) => s.id === other), "another team's schedules aren't listed");
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_recurring WHERE subject = $1", [`x ${STAMP}`])).rows[0].n, 0);
  });

  test("R1: a draft Claude saves while a person publishes never lands in the live schedule", async () => {
    const d = await recurring.saveRecurringDraft(await recurring.checkRecurringDraft({ team_id: T.A, subject: `Race ${STAMP}`, pattern: MONTHLY, timezone: "UTC" }), { id: P.dadmin.id, name: P.dadmin.name, via: "mcp" });
    const id = d.schedule.id;
    const next = await recurring.checkRecurringDraft({ subject: `UNREVIEWED ${STAMP}` }, recurring.draftOfSchedule(d.schedule));
    const c = await pool().connect();
    let r: Awaited<ReturnType<typeof recurring.saveRecurringDraft>>;
    try {
      await c.query("BEGIN");
      await c.query("SELECT 1 FROM hd_recurring WHERE id = $1 FOR UPDATE", [id]);
      const pending = recurring.saveRecurringDraft(next, { id: P.dadmin.id, name: P.dadmin.name, via: "mcp" }, id);
      await new Promise((res) => setTimeout(res, 400));
      await c.query("UPDATE hd_recurring SET published = 1, enabled = 1 WHERE id = $1", [id]);
      await c.query("COMMIT");
      r = await pending;
    } finally {
      c.release();
    }
    assert.equal(r.kind, "changes");
    const row = await schedRow(id);
    assert.equal(row.subject, `Race ${STAMP}`);
    assert.equal(row.draft.subject, `UNREVIEWED ${STAMP}`);
  });
});

// --- Categories --------------------------------------------------------------------------------------

describe("categories: changes wait beside the list until a person publishes them", () => {
  const HW = `Hardware ${STAMP}`;
  let hw = 0;
  let laptop = 0;
  before(async () => {
    hw = (await categories.createCategory({ name: HW }, { id: P.dadmin.id })).id;
    laptop = (await categories.createCategory({ name: "Laptop", parent_id: hw }, { id: P.dadmin.id })).id;
  });

  test("hd_draft_categories: adds and renames are a draft; drafted names are offered nowhere and refused on tickets", async () => {
    const r = await tool("dadmin", "hd_draft_categories", {
      changes: [
        { kind: "add_category", name: `Printers ${STAMP}`, subcategories: ["Toner", "Paper jam"] },
        { kind: "add_subcategory", category: HW, name: "Dock" },
        { kind: "rename", id: laptop, to: "Notebook" },
      ],
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.out.saved, "draft of changes (the category list is unchanged)");
    assert.deepEqual(r.out.changes, [`Add the category "Printers ${STAMP}" with Toner, Paper jam`, `Add the sub-category "Dock" to ${HW}`, `Rename the sub-category ${HW} › Laptop to "Notebook"`]);
    assert.equal(r.out.edit_url, "http://localhost/desk/settings/categories");
    const d = await draftRow();
    assert.equal(d.draft_via, "mcp");
    assert.equal(d.changes.length, 3);
    assert.equal((await auditRows("helpdesk.category_draft.created", P.dadmin.id)).at(-1)!.details.via, "mcp");
    assert.ok((await connector.recentClaudeActivity(100)).some((x) => x.actor_id === P.dadmin.id && x.summary === "Saved a draft of 3 category changes"));

    // Offered nowhere: not in the pickers' list, refused by hd_update_ticket and the pick check.
    const active = await categories.activeCategories();
    assert.ok(!active.some((c) => c.name === `Printers ${STAMP}`));
    assert.ok(!active.find((c) => c.id === hw)!.subcategories.some((s) => s.name === "Dock" || s.name === "Notebook"));
    assert.equal((await categories.checkCategoryPick({ category: `Printers ${STAMP}` })).ok, false);
    const t = await ticket("Printer jam", "A", { category: HW, subcategory: "Laptop" });
    connector.setClaudeLevelForTests("update");
    try {
      const u = await tool("agent", "hd_update_ticket", { number: t.number, category: `Printers ${STAMP}` });
      assert.equal(u.isError, true);
      assert.match(u.text, /not a category on the list/);
      const s = await tool("agent", "hd_update_ticket", { number: t.number, category: HW, subcategory: "Notebook" });
      assert.equal(s.isError, true);
      assert.match(s.text, /not a sub-category/);
    } finally {
      connector.setClaudeLevelForTests("notes");
    }
    assert.deepEqual(await ticketCat(t.id), { category: HW, subcategory: "Laptop" });
    // The settings page reads it beside the list; the connector lists it for admins only.
    const page = await call(catRoute.GET, "dadmin", "/admin/categories");
    assert.equal(page.body.draft.changes.length, 3);
    const adminList = await tool("dadmin", "hd_list_categories");
    assert.equal(adminList.out.draft.changes.length, 3);
    const agentList = await tool("agent", "hd_list_categories");
    assert.equal(agentList.isError, false);
    assert.ok(agentList.out.categories.some((c: { id: number }) => c.id === hw));
    assert.equal(agentList.out.draft, undefined, "agents see the list, not the draft");
  });

  test("Claude adds to the waiting draft; deletes and merges are not possible; validation sentences", async () => {
    const before = (await draftRow()).changes.length;
    const more = await tool("dadmin", "hd_draft_categories", { changes: [{ kind: "rename", id: laptop, to: "Notebook PC" }] });
    assert.equal(more.isError, false, more.text);
    const d = await draftRow();
    assert.equal(d.changes.length, before, "a rename of the same entry replaces the earlier one");
    assert.equal(d.changes.at(-1).to, "Notebook PC");
    const bad = async (changes: unknown, re: RegExp) => {
      const r = await tool("dadmin", "hd_draft_categories", { changes });
      assert.equal(r.isError, true, JSON.stringify(changes));
      assert.match(r.text, re);
    };
    await bad([{ kind: "delete", id: hw }], /can't delete, archive or merge/);
    await bad([{ kind: "merge", id: hw }], /can't delete, archive or merge/);
    await bad([{ kind: "add_category", name: HW.toLowerCase() }], /already a category called/);
    await bad([{ kind: "rename", id: hw, to: `Printers ${STAMP}` }], /already a category called|renamed twice|Claude can't merge/);
    await bad([{ kind: "add_category", name: "A › B" }], /can't contain ›/);
    await bad([{ kind: "add_category", name: "x".repeat(81) }], /under 80 characters/);
    await bad([{ kind: "add_subcategory", category: `Nope ${STAMP}`, name: "x" }], /not on the list/);
    await bad([{ kind: "rename", id: 99999999, to: "x" }], /needs the id/);
    await bad(Array.from({ length: 51 }, (_, i) => ({ kind: "add_category", name: `n${i}` })), /up to 50/);
    await bad("rename everything", /list of up to 50/);
    assert.equal((await draftRow()).changes.length, before, "a refused change leaves the draft as it was");
  });

  test("publishing names the reviewed draft and renames exactly as the page does (tickets, rules, drafts too)", async () => {
    // A ticket on the sub-category, a rule and a rule's draft naming it.
    const t = await ticket("Old laptop", "A", { category: HW, subcategory: "Laptop" });
    const ruleId = await liveRule("Laptops", { priority: "high" }, { conditions: { subcategories: [{ category: HW, subcategory: "Laptop" }] } });
    await automations.saveAutomationDraft({ conditions: { subcategories: [{ category: HW, subcategory: "Laptop" }], keywords: [WORD] } }, { id: P.manager.id, name: P.manager.name, via: "mcp" }, ruleId);
    const seen = (await draftRow()).draft_at;
    // A person's edit (names changed, a change taken out) keeps it a draft.
    const cur = (await draftRow()).changes as import("../src/lib/helpdesk/category-drafts-shared").HdCategoryDraftChange[];
    const edited = cur.filter((c) => c.kind !== "add_subcategory").map((c) => (c.kind === "add_category" ? { ...c, subcategories: ["Toner"] } : c));
    assert.equal((await putCatDraft("manager", { changes: edited, draft_at: seen })).status, 403, "settings.manage only");
    const save = await putCatDraft("dadmin", { changes: edited, draft_at: seen });
    assert.equal(save.status, 200, JSON.stringify(save.body));
    assert.equal(save.body.draft.changes.length, 2);
    assert.ok(!(await categories.activeCategories()).some((c) => c.name === `Printers ${STAMP}`), "still a draft");
    // A newer draft from Claude since: publishing the old one is refused, nothing applied.
    await new Promise((res) => setTimeout(res, 20));
    await catDrafts.saveCategoryDraft([{ kind: "add_subcategory", category_id: hw, name: "Monitor" }], { id: P.dadmin.id, name: P.dadmin.name, via: "mcp" });
    const stale = await putCatDraft("dadmin", { publish: true, draft_at: seen });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /newer draft/);
    assert.equal((await putCatDraft("dadmin", { discard_draft: true, draft_at: seen })).status, 409, "nor discarded unseen");
    assert.deepEqual(await ticketCat(t.id), { category: HW, subcategory: "Laptop" });
    // Publish what the page shows now.
    const now = await draftRow();
    const pub = await putCatDraft("dadmin", { publish: true, draft_at: now.draft_at, changes: now.changes });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.deepEqual(pub.body.renamed, [{ from: "Laptop", to: "Notebook PC", tickets: 2 }], "both of this file's Laptop tickets");
    assert.equal(await draftRow(), undefined, "the draft is gone");
    // The same as a rename on the page: the ticket, the rule and the rule's draft carry the new name.
    assert.deepEqual(await ticketCat(t.id), { category: HW, subcategory: "Notebook PC" });
    const rule = await ruleRow(ruleId);
    assert.deepEqual(rule.conditions.subcategories, [{ category: HW, subcategory: "Notebook PC" }]);
    assert.deepEqual(rule.draft.conditions.subcategories, [{ category: HW, subcategory: "Notebook PC" }]);
    const active = await categories.activeCategories();
    const printers = active.find((c) => c.name === `Printers ${STAMP}`)!;
    assert.deepEqual(printers.subcategories.map((s) => s.name), ["Toner"]);
    assert.ok(active.find((c) => c.id === hw)!.subcategories.some((s) => s.name === "Monitor"));
    assert.equal((await categories.checkCategoryPick({ category: `Printers ${STAMP}`, subcategory: "Toner" })).ok, true, "now it can be set");
    // Audit: the publish, and each change as the page writes it.
    const p = (await auditRows("helpdesk.category_draft.published", P.dadmin.id)).at(-1)!;
    assert.equal(p.details.drafted_via, "mcp");
    const ren = (await auditRows("helpdesk.category.renamed", P.dadmin.id)).at(-1)!;
    assert.equal(ren.details.from_draft, true);
    assert.equal(ren.details.tickets, 2);
    assert.ok((await auditRows("helpdesk.category.created", P.dadmin.id)).some((x) => x.details.name === `Printers ${STAMP}` && x.details.from_draft === true));
    await automations.deleteAutomation(ruleId);
  });

  test("discard drops it; a draft that no longer fits the list publishes nothing", async () => {
    await catDrafts.saveCategoryDraft([{ kind: "add_category", name: `Phones ${STAMP}` }], { id: P.dadmin.id, name: P.dadmin.name, via: "mcp" });
    // Someone adds the same name on the page meanwhile: publishing is refused as a whole.
    await categories.createCategory({ name: `Phones ${STAMP}` }, { id: P.dadmin.id });
    const at = (await draftRow()).draft_at;
    const pub = await putCatDraft("dadmin", { publish: true, draft_at: at });
    assert.equal(pub.status, 409);
    assert.match(pub.body.error, /Change 1: there is already a category called/);
    const gone = await putCatDraft("dadmin", { discard_draft: true, draft_at: at });
    assert.equal(gone.status, 200);
    assert.equal(await draftRow(), undefined);
    assert.equal((await putCatDraft("dadmin", { discard_draft: true })).status, 409);
    assert.ok((await auditRows("helpdesk.category_draft.draft_discarded", P.dadmin.id)).length >= 1);
  });

  test("the pure planner: in order, against the list as each change leaves it", () => {
    const tree = [{ id: 1, name: "A", archived: false, subcategories: [{ id: 2, name: "x", archived: false }] }];
    const ok = catDraftsShared.planCategoryDraft(tree, [
      { kind: "rename", id: 1, to: "B" },
      { kind: "add_category", name: "A" },
      { kind: "add_subcategory", category: "A", name: "y" },
    ]);
    assert.ok(ok.ok, JSON.stringify(ok));
    if (ok.ok) assert.deepEqual(ok.changes[1], { kind: "add_category", name: "A", subcategories: ["y"] }, "a sub-category of a new category goes with it");
    const twice = catDraftsShared.planCategoryDraft(tree, [{ kind: "rename", id: 2, to: "z" }, { kind: "rename", id: 2, to: "w" }]);
    assert.equal(twice.ok, false);
  });
});

// --- Permissions and switches ---------------------------------------------------------------------------

describe("who may draft, and the admin switches", () => {
  test("per role: categories = settings.manage, automations = automations.manage, recurring = settings.manage or a team lead", async () => {
    const has = async (who: string) => new Set(await listed(who));
    const admin = await has("dadmin");
    for (const n of ["hd_list_categories", "hd_draft_categories", "hd_list_automations", "hd_draft_automation", "hd_list_recurring", "hd_draft_recurring"]) assert.ok(admin.has(n), n);
    const manager = await has("manager");
    assert.ok(manager.has("hd_draft_automation") && manager.has("hd_draft_recurring"));
    assert.ok(!manager.has("hd_draft_categories"), "categories need settings.manage");
    const lead = await has("lead");
    assert.ok(lead.has("hd_draft_recurring") && !lead.has("hd_draft_automation") && !lead.has("hd_draft_categories"));
    for (const who of ["agent", "newbie"]) {
      const s = await has(who);
      assert.ok(s.has("hd_list_categories"), `${who} reads the list`);
      for (const n of ["hd_draft_categories", "hd_draft_automation", "hd_draft_recurring", "hd_list_automations", "hd_list_recurring"]) assert.ok(!s.has(n), `${who}: ${n}`);
      for (const n of ["hd_draft_categories", "hd_draft_automation", "hd_draft_recurring"]) {
        const r = await tool(who, n, {});
        assert.equal(r.isError, true);
        assert.match(r.text, /\(403\)$/, `${who}: ${n}`);
      }
    }
    assert.deepEqual(await listed("req"), (await listed("req")).filter((n) => !/categor|automation|recurring/.test(n)));
    edition.features = [];
    try {
      assert.deepEqual(await listed("dadmin"), []);
      assert.match((await tool("dadmin", "hd_draft_automation", { name: "x" })).text, /licence.*402/);
    } finally {
      edition.features = ["helpdesk"];
    }
  });

  test("the connector level: listing at every level, drafting from notes up; no tool publishes or switches on", async () => {
    try {
      connector.setClaudeLevelForTests("read");
      const m = await listed("dadmin");
      assert.ok(m.includes("hd_list_automations") && m.includes("hd_list_recurring") && m.includes("hd_list_categories"));
      assert.ok(!m.includes("hd_draft_automation") && !m.includes("hd_draft_recurring") && !m.includes("hd_draft_categories"));
      const d = await tool("dadmin", "hd_draft_automation", { name: `ro ${STAMP}`, event: "ticket_created", actions: { priority: "high" } });
      assert.match(d.text, /set to "Read only".*Nothing was saved\./);
      connector.setClaudeLevelForTests("notes");
      const n = await listed("dadmin");
      assert.ok(n.includes("hd_draft_automation") && n.includes("hd_draft_recurring") && n.includes("hd_draft_categories"));
    } finally {
      connector.setClaudeLevelForTests("notes");
    }
    for (const n of await listed("dadmin")) assert.doesNotMatch(n, /publish|send|approve|enable|switch/);
    assert.ok(connector.HD_CLAUDE_NEVER.some((l) => /automation/.test(l) && /recurring/.test(l) && /category/.test(l)));
  });

  test("Claude in the desk: the draft tools only under Draft replies and internal notes; strict schemas", () => {
    const names = (cfg: ClaudeDeskConfig) => prompt.toolsFor(cfg, { assets: false }).map((t) => t.name);
    const NEW = ["list_desk_settings", "draft_categories", "draft_automation", "draft_recurring"];
    const on = names(CFG());
    for (const n of NEW) assert.ok(on.includes(n), n);
    const noDrafts = names(CFG({ caps: { read: true, search: true, web: false, changes: true, drafts: false } }));
    for (const n of NEW) assert.ok(!noDrafts.includes(n), n);
    const strict = (s: Record<string, any>) => {
      if (s.type === "object") {
        assert.deepEqual(s.required, Object.keys(s.properties));
        assert.equal(s.additionalProperties, false);
        for (const v of Object.values(s.properties)) strict(v as Record<string, any>);
      }
      if (s.type === "array" && s.items) strict(s.items);
      assert.equal(s.anyOf, undefined, "no union types (the strict schema budget)");
    };
    for (const s of prompt.TOOL_SPECS.filter((x) => NEW.includes(x.name))) strict(s.input_schema as Record<string, any>);
  });
});

// --- Claude in the desk ---------------------------------------------------------------------------------

describe("Claude in the desk: draft cards and Save as draft", () => {
  test("draft_automation: a card for people who manage automations; Save as draft (card_id, used once) saves it off", async () => {
    const input = {
      id: 0,
      name: `Desk rule ${STAMP}`,
      event: "ticket_created",
      conditions: { team_ids: [], categories: [], subcategories: [], priorities: [], request_type_ids: [], sources: [], keywords: [WORD] },
      actions: { team_id: T.B, assignee_id: 0, priority: "", status: "", category: "", subcategory: "", tags_add: ["desk"], internal_note: "", macro_id: 0, notify: "" },
    };
    const agentOut = await deskTools.runDeskTool("draft_automation", input, toolCtx(await user("agent")));
    assert.equal(agentOut.isError, true);
    assert.match(agentOut.content, /can't manage automations/);
    const out = await deskTools.runDeskTool("draft_automation", input, toolCtx(await user("manager")));
    assert.equal(out.isError, false, out.content);
    assert.equal(out.card?.kind, "change");
    assert.equal(out.card?.payload.action, "settings_draft");
    assert.equal(out.card?.payload.target, "automation");
    assert.deepEqual(out.card?.payload.draft, { name: `Desk rule ${STAMP}`, event: "ticket_created", conditions: { keywords: [WORD] }, actions: { team_id: T.B, tags_add: ["desk"] } });
    assert.deepEqual(out.card?.payload.lines, ["When a ticket is created", `If it mentions "${WORD}"`, `Then move it to ${STAMP} B, add the tag desk`]);
    const bad = await deskTools.runDeskTool("draft_automation", { ...input, actions: { ...input.actions, tags_add: [], team_id: 0 } }, toolCtx(await user("manager")));
    assert.match(bad.content, /Choose at least one action/);
    assert.equal((await pool().query("SELECT 1 FROM hd_automations WHERE name = $1", [`Desk rule ${STAMP}`])).rowCount, 0, "nothing saved by the tool");

    // Save as draft: only with this person's offered card.
    const cardId = await offerCard("manager", out.card!.payload);
    assert.equal((await call(autoRoute.POST, "manager", "/admin/automations", "POST", { draft: true })).status, 400);
    const otherCard = await offerCard("dadmin", out.card!.payload);
    assert.equal((await call(autoRoute.POST, "manager", "/admin/automations", "POST", { draft: true, card_id: otherCard })).status, 400, "another person's card");
    const wrongKind = await offerCard("manager", { ...out.card!.payload, target: "recurring" });
    assert.equal((await call(autoRoute.POST, "manager", "/admin/automations", "POST", { draft: true, card_id: wrongKind })).status, 400, "a card for something else");
    assert.equal((await call(autoRoute.POST, "agent", "/admin/automations", "POST", { draft: true, card_id: cardId })).status, 403);
    const saved = await call(autoRoute.POST, "manager", "/admin/automations", "POST", { draft: true, card_id: cardId, name: "IGNORED", actions: { status: "closed" } });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const a = saved.body.automation;
    assert.equal(a.name, `Desk rule ${STAMP}`, "the card's content, not the body's");
    assert.equal(a.published, false);
    assert.equal(a.active, 0);
    assert.equal(a.draft_via, "claude_desk");
    assert.equal(await cardState(cardId), "applied");
    assert.equal((await call(autoRoute.POST, "manager", "/admin/automations", "POST", { draft: true, card_id: cardId })).status, 400, "one card, one draft");
    const row = (await auditRows("helpdesk.automation.created", P.manager.id, a.id)).at(-1)!;
    assert.equal(row.details.via, "claude_desk");
    assert.equal(row.details.via_label, "via Claude in the desk");
    assert.equal(row.details.draft, true);
    assert.equal((await auditRows("helpdesk.claude.card", P.manager.id)).filter((x) => x.details.card_id === cardId).length, 1);
    const t = await ticket(`Desk ${WORD}`);
    assert.ok(!(await automations.runAutomations("ticket_created", t.id)).ran.includes(a.id), "Save as draft keeps it off");
    // Changes beside a rule from a card; a refused save gives the card back.
    const changes = await deskTools.runDeskTool("draft_automation", { ...input, id: a.id, name: `Desk rule ${STAMP}` }, toolCtx(await user("manager")));
    assert.equal(changes.card?.payload.target_id, a.id);
    const c2 = await offerCard("manager", changes.card!.payload);
    await automations.deleteAutomation(a.id);
    assert.equal((await call(autoRoute.POST, "manager", "/admin/automations", "POST", { draft: true, card_id: c2 })).status, 404);
    assert.equal(await cardState(c2), "offered", "released after a refused save");
  });

  test("draft_recurring and draft_categories: cards; Save as draft through the settings routes", async () => {
    const recIn = {
      id: 0,
      team_id: T.A,
      subject: `Desk schedule ${STAMP}`,
      body: "",
      priority: "normal",
      request_type_id: 0,
      assignee_id: 0,
      due_business_days: 0,
      pattern: { kind: "weekly", time: "08:30", days: [1, 3], mode: "day", nth: 1, weekday: 1, day: 1, months: [], unit: "weeks", every: 1, start: "2026-01-01" },
      holiday_rule: "skip",
      timezone: "UTC",
    };
    assert.match((await deskTools.runDeskTool("draft_recurring", recIn, toolCtx(await user("agent")))).content, /can't manage/);
    const out = await deskTools.runDeskTool("draft_recurring", recIn, toolCtx(await user("lead")));
    assert.equal(out.isError, false, out.content);
    assert.deepEqual((out.card!.payload.draft as any).pattern, { kind: "weekly", days: [1, 3], time: "08:30" });
    const cardId = await offerCard("lead", out.card!.payload);
    const saved = await call(recRoute.POST, "lead", "/admin/recurring", "POST", { draft: true, card_id: cardId });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.schedule.published, false);
    assert.equal(saved.body.schedule.enabled, false);
    assert.equal(saved.body.schedule.next_run_at, null);
    assert.equal(saved.body.schedule.draft_via, "claude_desk");
    assert.equal((await auditRows("helpdesk.recurring.created", P.lead.id, saved.body.schedule.id)).at(-1)!.details.via, "claude_desk");

    const catOut = await deskTools.runDeskTool(
      "draft_categories",
      { changes: [{ kind: "add_category", id: 0, category: "", name: `Access ${STAMP}`, subcategories: ["VPN"] }] },
      toolCtx(await user("dadmin"))
    );
    assert.equal(catOut.isError, false, catOut.content);
    assert.match((await deskTools.runDeskTool("draft_categories", { changes: [] }, toolCtx(await user("dadmin")))).content, /Propose 1 to 50/);
    assert.match((await deskTools.runDeskTool("draft_categories", { changes: [{ kind: "add_category", id: 0, category: "", name: "x", subcategories: [] }] }, toolCtx(await user("manager")))).content, /can't manage categories/);
    const cc = await offerCard("dadmin", catOut.card!.payload);
    const cs = await call(catDraftRoute.POST, "dadmin", "/admin/categories/draft", "POST", { card_id: cc });
    assert.ok(cs.status === 201 || cs.status === 200, JSON.stringify(cs.body));
    assert.equal(cs.body.draft.draft_via, "claude_desk");
    assert.ok(!(await categories.activeCategories()).some((c) => c.name === `Access ${STAMP}`));
    assert.equal((await call(catDraftRoute.POST, "dadmin", "/admin/categories/draft", "POST", { card_id: cc })).status, 400);
    await catDrafts.discardCategoryDraft();
    // Skip still goes through the card route.
    const skip = await offerCard("dadmin", catOut.card!.payload);
    assert.equal((await call(cardRoute.POST, "dadmin", `/claude/cards/${skip}`, "POST", { state: "skipped" }, { id: String(skip) })).status, 200);
    assert.equal(await cardState(skip), "skipped");
  });

  test("a full turn: Claude drafts an automation; the card is created, nothing is saved; switched off, not offered", async () => {
    const u = await user("manager");
    fake.reset();
    fake.queue(
      {
        content: [
          {
            type: "tool_use",
            name: "draft_automation",
            input: {
              id: 0,
              name: `Turn rule ${STAMP}`,
              event: "ticket_created",
              conditions: { team_ids: [], categories: [], subcategories: [], priorities: [], request_type_ids: [], sources: [], keywords: [WORD] },
              actions: { team_id: 0, assignee_id: 0, priority: "urgent", status: "", category: "", subcategory: "", tags_add: [], internal_note: "", macro_id: 0, notify: "" },
            },
          },
        ],
      },
      { content: [{ type: "text", text: "I drafted the rule; save it as a draft and someone publishes it." }] }
    );
    const prep = await turnLib.prepareTurn({ user: u, session: toSessionUser(u), origin: "http://localhost", ip: IP, ticketNumber: null, chatId: null, fresh: true, text: "Make a rule that sets urgent for these.", intent: null });
    assert.ok(prep.ok, JSON.stringify(prep));
    if (!prep.ok) return;
    assert.ok(prep.turn.clientToolNames.includes("draft_automation"));
    const events: ClaudeStreamEvent[] = [];
    await turnLib.runTurn(prep.turn, (e) => events.push(e));
    const cards = events.filter((e) => e.type === "card").map((e) => (e as { card: any }).card);
    assert.equal(cards.length, 1, JSON.stringify(events));
    assert.deepEqual([cards[0].kind, cards[0].action, cards[0].target, cards[0].state], ["change", "settings_draft", "automation", "offered"]);
    assert.equal((await pool().query("SELECT 1 FROM hd_automations WHERE name = $1", [`Turn rule ${STAMP}`])).rowCount, 0);
    const req = fake.requests.find((r) => Array.isArray(r.body?.tools))!;
    assert.match(req.body.system[0].text, /a drafted rule stays off and a drafted schedule stays paused/);
    config.setClaudeDeskConfigForTests(CFG({ caps: { read: true, search: true, web: false, changes: true, drafts: false } }));
    try {
      const off = await turnLib.prepareTurn({ user: u, session: toSessionUser(u), origin: "http://localhost", ip: IP, ticketNumber: null, chatId: null, fresh: true, text: "Make a rule", intent: null });
      assert.ok(off.ok);
      if (off.ok) assert.ok(!off.turn.clientToolNames.includes("draft_automation") && !off.turn.clientToolNames.includes("list_desk_settings"));
    } finally {
      config.setClaudeDeskConfigForTests(CFG());
    }
  });
});

// --- 1.20.16 security review: regression tests for findings F1 to F4 ------------------------------

describe("review fixes (F1 to F4)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const MCP = () => ({ id: P.manager.id, name: P.manager.name, via: "mcp" as const });

  test("F1: notify and assign only desk agents; GET lists every action in words; a publish must send the whole reviewed rule", async () => {
    // A requester (no desk role) can't be notified or assigned by a rule, Claude's or a person's.
    for (const actions of [{ notify: { user_id: P.req.id } }, { assignee_id: P.req.id }]) {
      const r = await tool("manager", "hd_draft_automation", { name: `Leak ${STAMP}`, event: "ticket_created", conditions: { keywords: [WORD] }, actions });
      assert.equal(r.isError, true, JSON.stringify(actions));
      assert.match(r.text, /not a desk agent\. Nothing was saved\./);
      const human = await call(autoRoute.POST, "manager", "/admin/automations", "POST", { name: `Leak ${STAMP}`, event: "ticket_created", conditions: { keywords: [WORD] }, actions });
      assert.equal(human.status, 400, "the settings page's own rule is the same");
    }
    // A shared macro the reviewer can't manage, a person to notify and to assign: all named for the reviewer.
    const mac = await pool().query("INSERT INTO hd_macros (title, body, actions) VALUES ($1, 'Hello', '{}') RETURNING id", [`Shared reply ${STAMP}`]);
    const macroId = mac.rows[0].id as number;
    try {
      const r = await tool("manager", "hd_draft_automation", {
        name: `Everything ${STAMP}`,
        event: "ticket_created",
        conditions: { keywords: [WORD] },
        actions: { notify: { user_id: P.agent.id }, assignee_id: P.agent.id, macro_id: macroId, internal_note: "Checked by Claude" },
      });
      assert.equal(r.isError, false, r.text);
      const id = r.out.id as number;
      const list = await call(autoRoute.GET, "manager", "/admin/automations");
      const row = list.body.automations.find((a: { id: number }) => a.id === id);
      assert.deepEqual(row.in_words.then, [
        `assign it to ${P.agent.name}`,
        `add the internal note "Checked by Claude"`,
        `send the macro reply "Shared reply ${STAMP}" to the requester`,
        `notify ${P.agent.name}`,
      ]);
      assert.ok(list.body.people.some((p: { id: number }) => p.id === P.agent.id), "desk agents to pick from");
      assert.ok(!list.body.people.some((p: { id: number }) => p.id === P.req.id), "never a requester");
      assert.deepEqual(list.body.macros.find((m: { id: number }) => m.id === macroId), { id: macroId, title: `Shared reply ${STAMP}`, shared: true });
      // Publishing without the reviewed form (an API call naming only draft_at) is refused.
      const at = (await automations.getAutomation(id))!.draft_at;
      const bare = await patchRule("manager", id, { publish: true, draft_at: at });
      assert.equal(bare.status, 400);
      assert.match(bare.body.error, /as you reviewed it/);
      assert.equal((await ruleRow(id)).published, 0);
      // The reviewer took the notification out: what goes live is what the form sent.
      const form = await shown(id);
      const pub = await patchRule("manager", id, { ...form, actions: { ...(form.actions as object), notify: undefined }, publish: true, draft_at: at });
      assert.equal(pub.status, 200, JSON.stringify(pub.body));
      assert.equal(pub.body.automation.actions.notify, undefined);
      await automations.deleteAutomation(id);
    } finally {
      await pool().query("DELETE FROM hd_macros WHERE id = $1", [macroId]);
    }
  });

  test("F2: a category rename racing a publish rewrites the published rule, never a stale copy; the draft stays gone", async () => {
    const cat = await categories.createCategory({ name: `Alpha ${STAMP}` }, { id: P.dadmin.id });
    const id = await liveRule("Racing", { priority: "low" }, { conditions: { categories: [`Alpha ${STAMP}`] } });
    await automations.saveAutomationDraft({ event: "ticket_updated", actions: { priority: "urgent", tags_add: ["x"] } }, MCP(), id);
    // A person's publish holds the row; the rename starts meanwhile.
    const h = await pool().connect();
    try {
      await h.query("BEGIN");
      await h.query("SELECT pg_advisory_xact_lock_shared(728346)");
      await h.query("SELECT id FROM hd_automations WHERE id = $1 FOR UPDATE", [id]);
      const rename = categories.renameCategory(cat.id, `Beta ${STAMP}`);
      await sleep(400);
      await h.query(
        "UPDATE hd_automations SET event = 'ticket_updated', actions = $2, updated_at = now(), draft = NULL, draft_by = NULL, draft_by_name = '', draft_at = NULL, draft_via = '', draft_base_at = NULL WHERE id = $1",
        [id, JSON.stringify({ priority: "urgent", tags_add: ["x"] })]
      );
      await h.query("COMMIT");
      await rename;
    } finally {
      h.release();
    }
    const row = (await pool().query("SELECT event, conditions, actions, draft, draft_at FROM hd_automations WHERE id = $1", [id])).rows[0];
    assert.equal(row.event, "ticket_updated");
    assert.deepEqual(row.actions, { priority: "urgent", tags_add: ["x"] }, "the published actions stand");
    assert.deepEqual(row.conditions, { categories: [`Beta ${STAMP}`], keywords: [WORD] }, "and carry the new name");
    assert.equal(row.draft, null, "the published draft does not come back");
    // The other order: the rename holds the list; a publish through updateAutomation waits for it, then sees the new name.
    await automations.saveAutomationDraft({ actions: { priority: "high" } }, MCP(), id);
    const at = (await automations.getAutomation(id))!.draft_at;
    const c = await pool().connect();
    let pub: Promise<unknown>;
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(728346)");
      pub = automations.updateAutomation(id, {}, { publishDraft: true, draftAt: at });
      await sleep(300);
      await c.query("UPDATE hd_categories SET name = $2 WHERE id = $1", [cat.id, `Gamma ${STAMP}`]);
      await c.query("UPDATE hd_automations SET conditions = $2 WHERE id = $1", [id, JSON.stringify({ categories: [`Gamma ${STAMP}`], keywords: [WORD] })]);
      await c.query("UPDATE hd_automations SET draft = jsonb_set(draft, '{conditions}', $2::jsonb) WHERE id = $1", [id, JSON.stringify({ categories: [`Gamma ${STAMP}`], keywords: [WORD] })]);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    await pub!;
    const after = await ruleRow(id);
    assert.deepEqual(after.conditions, { categories: [`Gamma ${STAMP}`], keywords: [WORD] });
    assert.deepEqual(after.actions, { priority: "high" });
    await automations.deleteAutomation(id);
  });

  test("F3: a stored rename or sub-category whose entry was renamed since is refused (409), nothing renamed", async () => {
    const pr = await categories.createCategory({ name: `Plotters ${STAMP}` }, { id: P.dadmin.id });
    const saved = await catDrafts.saveCategoryDraft(
      [
        { kind: "rename", id: pr.id, to: `Print ${STAMP}` },
        { kind: "add_subcategory", category_id: pr.id, name: "Toner" },
      ],
      { id: P.dadmin.id, name: P.dadmin.name, via: "mcp" }
    );
    const reviewed = saved.draft.changes;
    assert.equal((reviewed[0] as { from: string }).from, `Plotters ${STAMP}`);
    await categories.renameCategory(pr.id, `Hardware2 ${STAMP}`);
    const pub = await putCatDraft("dadmin", { publish: true, draft_at: saved.draft.draft_at, changes: reviewed });
    assert.equal(pub.status, 409);
    assert.match(pub.body.error, new RegExp(`Change 1: "Plotters ${STAMP}" is now called "Hardware2 ${STAMP}"\\. Review the draft again`));
    assert.equal((await pool().query("SELECT name FROM hd_categories WHERE id = $1", [pr.id])).rows[0].name, `Hardware2 ${STAMP}`, "nothing renamed");
    // Without the rename, the sub-category alone is stale too; and a publish must say what it renames.
    const sub = await putCatDraft("dadmin", { publish: true, draft_at: saved.draft.draft_at, changes: [reviewed[1]] });
    assert.equal(sub.status, 409);
    assert.match(sub.body.error, /the category "Print .*" is now called "Hardware2/);
    const bare = await putCatDraft("dadmin", { publish: true, draft_at: saved.draft.draft_at, changes: [{ kind: "rename", id: pr.id, to: "x" }] });
    assert.equal(bare.status, 400);
    // Claude adding to it now is refused the same way (the waiting change is stale).
    await assert.rejects(catDrafts.saveCategoryDraft([{ kind: "add_category", name: `Other ${STAMP}` }], MCP()), /is now called/);
    await catDrafts.discardCategoryDraft();
  });

  test("F4a: a person's edit of the category draft renews draft_at and names the editor", async () => {
    const saved = await catDrafts.saveCategoryDraft([{ kind: "add_category", name: `Edited ${STAMP}` }], MCP());
    const first = saved.draft.draft_at;
    await sleep(20);
    const edit = await putCatDraft("dadmin", { changes: [{ kind: "add_category", name: `Edited v2 ${STAMP}`, subcategories: [] }], draft_at: first });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(edit.body.draft.edited_by_name, P.dadmin.name);
    assert.notEqual(new Date(edit.body.draft.draft_at).getTime(), new Date(first).getTime());
    assert.equal((await auditRows("helpdesk.category_draft.updated", P.dadmin.id)).at(-1)!.details.edited_by, P.dadmin.name);
    // An API publish naming the version before the edit can't publish it unseen.
    assert.equal((await putCatDraft("dadmin", { publish: true, draft_at: first })).status, 409);
    assert.equal((await putCatDraft("dadmin", { discard_draft: true, draft_at: edit.body.draft.draft_at })).status, 200);
    // Automations and schedules: a person's save of an unpublished draft renews draft_at too.
    const d = await automations.saveAutomationDraft({ name: `Renew ${STAMP}`, event: "ticket_created", conditions: { keywords: [WORD] }, actions: { priority: "high" } }, MCP());
    await sleep(20);
    const saved2 = await patchRule("manager", d.automation.id, { name: `Renew v2 ${STAMP}` });
    assert.notEqual(new Date(saved2.body.automation.draft_at).getTime(), new Date(d.automation.draft_at!).getTime());
    assert.equal((await patchRule("manager", d.automation.id, { ...(await shown(d.automation.id)), publish: true, draft_at: d.automation.draft_at })).status, 409);
    await automations.deleteAutomation(d.automation.id);
  });

  test("F4b: publishing changes over a rule or schedule a person edited since is refused; a category rename isn't such an edit", async () => {
    const id = await liveRule("Edited live", { tags_add: ["one"] });
    await automations.saveAutomationDraft({ actions: { tags_add: ["claude"] } }, MCP(), id);
    await sleep(20);
    assert.equal((await patchRule("manager", id, { actions: { tags_add: ["person"] } })).status, 200, "a person edits the live rule");
    const at = (await automations.getAutomation(id))!.draft_at;
    const r = await patchRule("manager", id, { ...(await shown(id)), publish_draft: true, draft_at: at });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /The rule changed since this draft was made/);
    assert.deepEqual((await ruleRow(id)).actions, { tags_add: ["person"] }, "the person's edit stands");
    // A category rename rewrites the rule but is not a person's edit: the changes stay publishable.
    const cat = await categories.createCategory({ name: `Delta ${STAMP}` }, { id: P.dadmin.id });
    const id2 = await liveRule("Renamed under", { tags_add: ["one"] }, { conditions: { categories: [`Delta ${STAMP}`] } });
    await automations.saveAutomationDraft({ actions: { tags_add: ["two"] } }, MCP(), id2);
    await sleep(20);
    await categories.renameCategory(cat.id, `Epsilon ${STAMP}`);
    const at2 = (await automations.getAutomation(id2))!.draft_at;
    const ok = await patchRule("manager", id2, { ...(await shown(id2)), publish_draft: true, draft_at: at2 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.automation.conditions.categories, [`Epsilon ${STAMP}`]);
    await automations.deleteAutomation(id);
    await automations.deleteAutomation(id2);
    // Recurring: the same.
    const sid = await liveSchedule("Edited schedule");
    await tool("dadmin", "hd_draft_recurring", { id: sid, subject: `Claude subject ${STAMP}` });
    await sleep(20);
    assert.equal((await patchSched("dadmin", sid, { body: "A person's edit." })).status, 200);
    const sat = (await recurring.getRecurring(sid))!.draft_at;
    const sr = await patchSched("dadmin", sid, { publish_draft: true, draft_at: sat });
    assert.equal(sr.status, 409);
    assert.match(sr.body.error, /The schedule changed since this draft was made/);
  });

  test("F4c: Save as draft on a recurring card audits the caller's address", async () => {
    const out = await deskTools.runDeskTool(
      "draft_recurring",
      {
        id: 0,
        team_id: T.A,
        subject: `Ip check ${STAMP}`,
        body: "",
        priority: "normal",
        request_type_id: 0,
        assignee_id: 0,
        due_business_days: 0,
        pattern: { kind: "daily", time: "08:00", days: [], mode: "day", nth: 1, weekday: 1, day: 1, months: [], unit: "days", every: 1, start: "2026-01-01" },
        holiday_rule: "skip",
        timezone: "UTC",
      },
      toolCtx(await user("lead"))
    );
    const cardId = await offerCard("lead", out.card!.payload);
    assert.equal((await call(recRoute.POST, "lead", "/admin/recurring", "POST", { draft: true, card_id: cardId })).status, 201);
    const row = (await auditRows("helpdesk.claude.card", P.lead.id)).find((x) => x.details.card_id === cardId)!;
    assert.equal(row.ip, IP);
  });
});

describe("audit labels", () => {
  test("every new action has a label", () => {
    for (const a of [
      "helpdesk.automation.published",
      "helpdesk.automation.draft_discarded",
      "helpdesk.recurring.published",
      "helpdesk.recurring.draft_discarded",
      "helpdesk.category_draft.created",
      "helpdesk.category_draft.updated",
      "helpdesk.category_draft.published",
      "helpdesk.category_draft.draft_discarded",
    ]) {
      assert.ok(auditLabels.AUDIT_LABELS[a], a);
    }
  });
});
