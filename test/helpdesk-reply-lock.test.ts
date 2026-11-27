// Helpdesk 1.20.20: the reply lock (lib/helpdesk/reply-lock).
//
//   take       atomic: of agents starting at once exactly one holds it; the
//              holder takes again (a refresh), nobody else does
//   refresh    the holder's heartbeat; never takes a free lock
//   expiry     an idle heartbeat or a gone presence row ends it on read; the
//              sweep deletes it
//   release    on the holder's public reply (any path), Let go, the box
//              emptied
//   refusal    a public reply by anyone else is refused 409 (code
//              reply_locked) on every send path: the messages route, a
//              macro (desk and Claude in the desk), addMessage itself (the
//              API's replies, incident updates), review approval; an agent's
//              emailed reply becomes an internal note. Internal notes, field
//              changes, requesters, system sends and drafts are never held
//   take over  Team lead of the ticket's team, Manager and Admin (the
//              replies.take_over capability), not Agent or Newbie; the
//              previous holder is told and keeps their text; audited
//   setting    off = 1.19.1 behaviour: nothing taken, shown or refused; the
//              upgrade default is off, a new desk's on; the registry finds it
//   licence    no helpdesk in the licence: the routes answer 402
//
// Parallel-safe: every account, team and ticket is this file's own (STAMP).
// The setting is global: switched on for the run and put back after.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-reply-lock.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, setSetting, createSession } from "../src/lib/db";
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
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-rl.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-rl.virtual.js");
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
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const messagesLib = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
const macros = require("../src/lib/helpdesk/macros") as typeof import("../src/lib/helpdesk/macros");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const rolesShared = require("../src/lib/helpdesk/roles-shared") as typeof import("../src/lib/helpdesk/roles-shared");
const notify = require("../src/lib/helpdesk/notify") as typeof import("../src/lib/helpdesk/notify");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const inbound = require("../src/lib/helpdesk/inbound") as typeof import("../src/lib/helpdesk/inbound");
const automations = require("../src/lib/helpdesk/automations") as typeof import("../src/lib/helpdesk/automations");
const presenceLib = require("../src/lib/helpdesk/presence") as typeof import("../src/lib/helpdesk/presence");
const popout = require("../src/components/helpdesk/desk/popout/reply-popout") as typeof import("../src/components/helpdesk/desk/popout/reply-popout");
const lockLib = require("../src/lib/helpdesk/reply-lock") as typeof import("../src/lib/helpdesk/reply-lock");
const lockShared = require("../src/lib/helpdesk/reply-lock-shared") as typeof import("../src/lib/helpdesk/reply-lock-shared");
const { HD_REPLY_LOCK_SCHEMA } = require("../src/lib/helpdesk/reply-lock-schema") as typeof import("../src/lib/helpdesk/reply-lock-schema");
const registry = require("../src/lib/helpdesk/desk-settings-registry") as typeof import("../src/lib/helpdesk/desk-settings-registry");
const auditLabels = require("../src/lib/audit-labels") as typeof import("../src/lib/audit-labels");
const { HELPDESK_SWEEPS } = require("../src/lib/periodic") as typeof import("../src/lib/periodic");
const { getUserById } = require("../src/lib/db") as typeof import("../src/lib/db");
const { toSessionUser } = require("../src/lib/auth") as typeof import("../src/lib/auth");
const lockRoute = require("../src/app/api/helpdesk/tickets/[number]/reply-lock/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/reply-lock/route");
const locksRoute = require("../src/app/api/helpdesk/reply-locks/route") as typeof import("../src/app/api/helpdesk/reply-locks/route");
const settingsRoute = require("../src/app/api/helpdesk/admin/reply-lock/route") as typeof import("../src/app/api/helpdesk/admin/reply-lock/route");
const presenceRoute = require("../src/app/api/helpdesk/tickets/[number]/presence/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/presence/route");
const messagesRoute = require("../src/app/api/helpdesk/tickets/[number]/messages/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/messages/route");
const macroRoute = require("../src/app/api/helpdesk/tickets/[number]/macro/[macroId]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/macro/[macroId]/route");
const reviewRoute = require("../src/app/api/helpdesk/reviews/[id]/route") as typeof import("../src/app/api/helpdesk/reviews/[id]/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { InboundEmail } from "../src/lib/helpdesk/inbound-parse";

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

const STAMP = `hdrl-${Date.now()}-${process.pid}`;
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
const macroIds: number[] = [];
const T: Record<string, number> = {};
const ALIAS = `${STAMP}-it@example.test`;
let originalSetting: string | undefined;

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

async function raise(subject: string, team = "A") {
  const t = await tickets.createTicket(
    {
      subject: `${STAMP} ${subject}`,
      body: "The VPN client says Authentication failed since this morning.",
      requester: { id: P.req.id, name: P.req.name, email: P.req.email },
      team_id: T[team],
      answers: {} as never,
    } as never,
    { silent: true, actorId: P.req.id, actorName: P.req.name }
  );
  ticketIds.push(t.id);
  return (await tickets.getTicketById(t.id))!;
}

const lock = (who: string, n: number, body: Record<string, unknown>) => call(lockRoute.POST, who, `/tickets/${n}/reply-lock`, "POST", body, { number: String(n) });
const look = (who: string, n: number) => call(lockRoute.GET, who, `/tickets/${n}/reply-lock`, "GET", undefined, { number: String(n) });
const letGo = (who: string, n: number) => call(lockRoute.DELETE, who, `/tickets/${n}/reply-lock`, "DELETE", undefined, { number: String(n) });
const post = (who: string, n: number, body: Record<string, unknown>) => call(messagesRoute.POST, who, `/tickets/${n}/messages`, "POST", body, { number: String(n) });
const applyMacro = (who: string, n: number, macroId: number, body: Record<string, unknown> = {}) =>
  call(macroRoute.POST, who, `/tickets/${n}/macro/${macroId}`, "POST", body, { number: String(n), macroId: String(macroId) });
const msgs = async (ticketId: number) => (await pool().query("SELECT id, kind, body, via, author_id FROM hd_messages WHERE ticket_id = $1 ORDER BY id", [ticketId])).rows;
const lockRow = async (ticketId: number) => (await pool().query("SELECT user_id, prev_user_id FROM hd_reply_locks WHERE ticket_id = $1", [ticketId])).rows[0] ?? null;
const sessionUser = async (who: string) => toSessionUser((await getUserById(P[who].id))!);

async function setOn(enabled: boolean, idle = 2) {
  lockLib.forgetReplyLockSettings();
  const r = await lockLib.saveReplyLockSettings({ enabled, idle_minutes: idle });
  assert.ok(!("error" in r));
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  originalSetting = await getSetting(lockLib.HD_REPLY_LOCK_KEY);
  roles.setRoleMatrixForTests(rolesShared.HD_DEFAULT_MATRIX);
  for (const k of ["A", "B"]) T[k] = (await fixtureQuery("INSERT INTO hd_teams (name, email_alias, position) VALUES ($1, $2, 9470) RETURNING id", [`${STAMP} ${k}`, k === "A" ? ALIAS : ""])).rows[0].id;
  await person("req", "Daniel Okafor", null);
  await person("sam", "Sam Lee", "agent", [["A", "agent"]]);
  await person("ana", "Ana Kowalski", "agent", [["A", "agent"]]);
  await person("priya", "Priya Natarajan", "team_lead", [["A", "lead"]]);
  await person("leadB", "Lars Berg", "team_lead", [["B", "lead"]]);
  await person("mgr", "Mona Grant", "manager");
  await person("admin", "Ada Admin", "admin");
  await person("newbie", "Nico Newbie", "newbie", [["A", "agent"]]);
  await person("other", "Otto Other", "agent", [["B", "agent"]]);
  notify.setAgentDeliverySpyForTests(() => {});
  email.setHelpdeskTransportForTests(async () => {});
  await setOn(true);
});

after(async () => {
  notify.setAgentDeliverySpyForTests(null);
  email.setHelpdeskTransportForTests(null);
  roles.setRoleMatrixForTests(null);
  // The setting back as it was (the shared database's other users must not see locks switched on).
  if (originalSetting === undefined) await pool().query("DELETE FROM settings WHERE key = $1", [lockLib.HD_REPLY_LOCK_KEY]);
  else await setSetting(lockLib.HD_REPLY_LOCK_KEY, originalSetting);
  lockLib.forgetReplyLockSettings();
  await pool().query("DELETE FROM hd_reply_locks WHERE ticket_id = ANY($1) OR user_id = ANY($2)", [ticketIds, userIds]);
  await pool().query("DELETE FROM hd_ticket_presence WHERE ticket_id = ANY($1) OR user_id = ANY($2)", [ticketIds, userIds]);
  await pool().query("DELETE FROM hd_reply_drafts WHERE ticket_id = ANY($1)", [ticketIds]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [ticketIds]);
  await pool().query("DELETE FROM hd_macros WHERE id = ANY($1)", [macroIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [Object.values(T)]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// --- Take, refresh, expiry, release -------------------------------------------------------------

describe("the lock", () => {
  test("of two agents starting at once exactly one holds it, every time", async () => {
    for (let i = 0; i < 8; i++) {
      const t = await raise(`race ${i}`);
      const [a, b] = await Promise.all([lockLib.takeReplyLock(t.id, P.sam.id), lockLib.takeReplyLock(t.id, P.ana.id)]);
      assert.equal([a.ok, b.ok].filter(Boolean).length, 1, `round ${i}: one winner`);
      const holder = (await lockRow(t.id)).user_id;
      assert.equal(holder, a.ok ? P.sam.id : P.ana.id);
      const loser = a.ok ? b : a;
      assert.ok(!loser.ok && "holder" in loser && loser.holder.user_id === holder, "the loser is told who holds it");
    }
    // Through the route (one at a time: this file's request stub is one global): the second taker gets 409 with the holder.
    const t = await raise("race route");
    assert.equal((await lock("sam", t.number, { action: "take" })).status, 200);
    const refused = await lock("ana", t.number, { action: "take" });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "reply_locked");
    assert.match(refused.body.error, /is replying to this ticket, so your reply wasn't sent/);
    assert.equal(refused.body.lock.mine, false);
  });

  test("the holder sees it as theirs; others see the holder's name, initials and since", async () => {
    const t = await raise("view");
    const took = await lock("sam", t.number, { action: "take" });
    assert.equal(took.status, 200, JSON.stringify(took.body));
    assert.equal(took.body.enabled, true);
    assert.equal(took.body.lock.mine, true);
    const seen = await look("ana", t.number);
    assert.equal(seen.body.lock.name, "Sam Lee");
    assert.equal(seen.body.lock.initials, "SL");
    assert.equal(seen.body.lock.mine, false);
    assert.equal(seen.body.lock.can_take_over, false, "an Agent may not take over");
    assert.ok(Date.parse(seen.body.lock.since) > Date.now() - 60_000);
    // The holder taking again keeps `since` (a refresh), and nobody else takes it.
    const again = await lock("sam", t.number, { action: "take" });
    assert.equal(again.body.lock.since, took.body.lock.since);
    assert.equal((await lock("ana", t.number, { action: "take" })).status, 409);
    // The presence strip's other half: the holder is present (the lock keeps their row alive).
    const pres = await call(presenceRoute.GET, "ana", `/tickets/${t.number}/presence`, "GET", undefined, { number: String(t.number) });
    assert.ok(pres.body.present.some((p: any) => p.user_id === P.sam.id));
  });

  test("refresh keeps the holder's lock and never takes a free one", async () => {
    const t = await raise("refresh");
    await lock("sam", t.number, { action: "take" });
    await pool().query("UPDATE hd_reply_locks SET seen_at = now() - interval '60 seconds' WHERE ticket_id = $1", [t.id]);
    const r = await lock("sam", t.number, { action: "refresh" });
    assert.equal(r.status, 200);
    const age = Number((await pool().query("SELECT extract(epoch from now() - seen_at) AS s FROM hd_reply_locks WHERE ticket_id = $1", [t.id])).rows[0].s);
    assert.ok(age < 5, "the heartbeat moved seen_at");
    // Ana's refresh on Sam's lock changes nothing; on a free ticket it takes nothing.
    await lock("ana", t.number, { action: "refresh" });
    assert.equal((await lockRow(t.id)).user_id, P.sam.id);
    const free = await raise("refresh free");
    const fr = await lock("ana", free.number, { action: "refresh" });
    assert.equal(fr.body.lock, null);
    assert.equal(await lockRow(free.id), null);
  });

  test("an idle holder loses it on read, someone else can take it, and the sweep deletes it", async () => {
    const t = await raise("idle");
    await lock("sam", t.number, { action: "take" });
    await pool().query("UPDATE hd_reply_locks SET seen_at = now() - interval '121 seconds' WHERE ticket_id = $1", [t.id]);
    assert.equal((await look("ana", t.number)).body.lock, null, "past the 2 minute idle time");
    assert.equal(await lockLib.replyLockCheck(t.id, P.ana.id), null, "and nothing is refused");
    assert.equal((await lock("ana", t.number, { action: "take" })).status, 200);
    assert.equal((await lockRow(t.id)).user_id, P.ana.id);
    // The idle time is the setting's.
    await setOn(true, 5);
    await pool().query("UPDATE hd_reply_locks SET seen_at = now() - interval '4 minutes' WHERE ticket_id = $1", [t.id]);
    await pool().query("UPDATE hd_ticket_presence SET seen_at = now() WHERE ticket_id = $1", [t.id]);
    assert.equal((await look("sam", t.number)).body.lock?.name, "Ana Kowalski", "4 minutes is within 5");
    await setOn(true, 2);
    assert.ok(HELPDESK_SWEEPS.some((s) => s.name === "hd_reply_locks"));
    await lockLib.sweepReplyLocks();
    assert.equal(await lockRow(t.id), null, "swept");
  });

  test("closing the ticket (the presence row goes) ends the lock at once", async () => {
    const t = await raise("closed tab");
    await lock("sam", t.number, { action: "take" });
    const del = await call(presenceRoute.DELETE, "sam", `/tickets/${t.number}/presence`, "DELETE", undefined, { number: String(t.number) });
    assert.equal(del.status, 200);
    assert.equal((await look("ana", t.number)).body.lock, null);
    assert.equal((await lock("ana", t.number, { action: "take" })).status, 200);
  });

  test("Let go releases it; someone else's let go does nothing", async () => {
    const t = await raise("let go");
    await lock("sam", t.number, { action: "take" });
    await letGo("ana", t.number);
    assert.equal((await lockRow(t.id)).user_id, P.sam.id);
    const r = await letGo("sam", t.number);
    assert.equal(r.status, 200);
    assert.equal(r.body.lock, null);
    assert.equal(await lockRow(t.id), null);
  });

  test("sending a public reply releases the holder's lock", async () => {
    const t = await raise("send");
    await lock("sam", t.number, { action: "take" });
    const sent = await post("sam", t.number, { kind: "public", body: "I've reset your VPN token." });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(await lockRow(t.id), null);
    assert.equal((await look("ana", t.number)).body.lock, null, "Ana's box unlocks");
    assert.equal((await post("ana", t.number, { kind: "public", body: "Following up." })).status, 201);
  });
});

// --- Enforcement on every send path --------------------------------------------------------

describe("refusal", () => {
  test("the messages route refuses another agent's public reply, posting nothing; a note goes through", async () => {
    const t = await raise("messages route");
    await lock("sam", t.number, { action: "take" });
    const before = (await msgs(t.id)).length;
    const r = await post("ana", t.number, { kind: "public", body: "Could you re-pair the client?" });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "reply_locked");
    assert.equal(r.body.error, "Sam Lee is replying to this ticket, so your reply wasn't sent. You can still add an internal note.");
    assert.equal(r.body.holder.name, "Sam Lee");
    // force (the collision dialog's Send anyway) does not get past it either.
    assert.equal((await post("ana", t.number, { kind: "public", body: "Anyway", force: true })).status, 409);
    assert.equal((await msgs(t.id)).length, before, "nothing was posted");
    const note = await post("ana", t.number, { kind: "internal", body: "Sam is on it; the token was reset last week too." });
    assert.equal(note.status, 201, "internal notes are never locked");
    // Field changes are not blocked either.
    const patched = await tickets.updateTicket(t.id, { priority: "high" }, { id: P.ana.id, name: P.ana.name });
    assert.equal(patched?.ticket.priority, "high");
    assert.equal((await lockRow(t.id)).user_id, P.sam.id, "and Sam still holds it");
  });

  test("a macro with a reply is refused whole, in the desk and for Claude in the desk; a draft (the connector) is not", async () => {
    const m = await macros.createMacro({ title: `${STAMP} reset`, body: "We've reset your token.", actions: { status: "pending" } as never, team_id: null, owner_id: null }, null);
    macroIds.push(m.id);
    const t = await raise("macro");
    await lock("sam", t.number, { action: "take" });
    const desk = await applyMacro("ana", t.number, m.id);
    assert.equal(desk.status, 409);
    assert.match(desk.body.error, /^Sam Lee is replying/);
    const row = (await pool().query("SELECT status FROM hd_tickets WHERE id = $1", [t.id])).rows[0];
    assert.notEqual(row.status, "pending", "its status change was not made either");
    const ana = await sessionUser("ana");
    const dry = await macros.applyMacroAs(ana, t.number, m.id, { dryRun: true, origin: "http://localhost" });
    assert.equal(dry.ok, false, "Claude in the desk's proposal is refused before it is offered");
    const draft = await macros.applyMacroAs(ana, t.number, m.id, { replyAs: "draft", via: "mcp", origin: "http://localhost" });
    assert.equal(draft.ok, true, "the connector only drafts, so it goes through");
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_reply_drafts WHERE ticket_id = $1", [t.id])).rows[0].n, 1);
    assert.equal((await msgs(t.id)).filter((x: any) => x.kind === "public" && x.author_id === P.ana.id).length, 0);
    // The holder's own macro goes through and releases the lock.
    const own = await applyMacro("sam", t.number, m.id);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(await lockRow(t.id), null);
  });

  test("addMessage itself refuses (the API's replies and incident updates go through it); system sends and requesters are exempt", async () => {
    const t = await raise("core");
    await lock("sam", t.number, { action: "take" });
    await assert.rejects(
      messagesLib.addMessage(t.id, { kind: "public", body: "From the API.", author: { id: P.ana.id, name: P.ana.name, email: "" }, via: "api", asRequester: false }),
      (e: any) => e instanceof tickets.HdTicketError && e.status === 409 && e.extra?.code === "reply_locked" && e.messageUnsent === true
    );
    // An automation (no author, via system) and the requester are never held.
    assert.ok(await messagesLib.addMessage(t.id, { kind: "public", body: "Automatic: we got your request.", author: { id: null, name: "Helpdesk", email: "" }, via: "system", asRequester: false }));
    assert.ok(await messagesLib.addMessage(t.id, { kind: "public", body: "Still broken.", author: { id: P.req.id, name: P.req.name, email: P.req.email }, via: "portal", asRequester: true }));
    // An automation's macro (fromAutomation: no actor) too.
    const m = await macros.createMacro({ title: `${STAMP} auto`, body: "Thanks, we're on it.", actions: {} as never, team_id: null, owner_id: null }, null);
    macroIds.push(m.id);
    const auto = await macros.applyMacroToTicket(t.id, m.id, { id: null, name: "Automation", email: "" }, { fromAutomation: true });
    assert.equal(auto.ok, true);
    assert.equal((await lockRow(t.id)).user_id, P.sam.id);
  });

  test("a newbie's reply for review is refused too, and approving one waits while someone else replies", async () => {
    const t = await raise("review");
    const held = await post("newbie", t.number, { kind: "public", body: "Have you tried restarting it?" });
    assert.equal(held.status, 201);
    assert.equal(held.body.held, true);
    await lock("sam", t.number, { action: "take" });
    assert.equal((await post("newbie", t.number, { kind: "public", body: "And the router?" })).status, 409);
    const approve = await call(reviewRoute.POST, "priya", `/reviews/${held.body.message.id}`, "POST", { decision: "approve" }, { id: String(held.body.message.id) });
    assert.equal(approve.status, 409);
    assert.match(approve.body.error, /Sam Lee is replying to this ticket\. Approve this reply once they have sent theirs\./);
    await letGo("sam", t.number);
    const ok = await call(reviewRoute.POST, "priya", `/reviews/${held.body.message.id}`, "POST", { decision: "approve" }, { id: String(held.body.message.id) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  test("an agent's emailed reply while someone else replies is kept as an internal note, not sent", async () => {
    const t = await raise("email");
    const token = await email.ensureReplyToken(t.id);
    await lock("sam", t.number, { action: "take" });
    const mail: InboundEmail = {
      provider: "generic",
      from: { email: P.ana.email, name: "" },
      to: [{ email: ALIAS, name: "" }],
      cc: [],
      recipients: [],
      subject: `Re: ${t.subject} [#${t.number} ref:${token}]`,
      text: "Please re-pair the client from Settings.",
      html: "",
      stripped: "",
      messageId: `${newToken()}@mail.example.test`,
      inReplyTo: "",
      references: [],
      headers: {},
      auth: { dmarc: "pass" },
      files: [],
    } as InboundEmail;
    const r = await inbound.processInboundEmail(mail, { outsideSenders: false });
    assert.equal(r.body.outcome, "appended");
    const last = (await msgs(t.id)).at(-1)!;
    assert.equal(last.kind, "internal");
    assert.equal(last.author_id, P.ana.id);
    assert.match(last.body, /^Sent by email while Sam Lee was replying, so it was added as an internal note and not sent to the requester\./);
    assert.match(last.body, /re-pair the client/);
  });
});

// --- Take over ---------------------------------------------------------------------------------

describe("take over", () => {
  test("Team lead of the ticket's team, Manager and Admin may; Agent, Newbie and another team's lead may not", async () => {
    const d = rolesShared.HD_DEFAULT_MATRIX;
    for (const r of ["team_lead", "manager", "admin"] as const) assert.ok(d[r].includes("replies.take_over"), r);
    for (const r of ["agent", "newbie"] as const) assert.ok(!d[r].includes("replies.take_over"), r);
    assert.equal(rolesShared.HD_CAPABILITIES["replies.take_over"].label, "Take over a reply");
    const t = await raise("roles");
    await lock("sam", t.number, { action: "take" });
    assert.equal((await lock("ana", t.number, { action: "take_over" })).status, 403);
    assert.equal((await lock("newbie", t.number, { action: "take_over" })).status, 403);
    assert.equal((await lock("leadB", t.number, { action: "take_over" })).status, 404, "a lead of another team doesn't work the ticket");
    assert.equal((await look("priya", t.number)).body.lock.can_take_over, true);
    assert.equal((await look("mgr", t.number)).body.lock.can_take_over, true);
    assert.equal((await look("admin", t.number)).body.lock.can_take_over, true);
    // A Team lead takes it from an Agent; a Manager from the lead; an Admin from the Manager.
    for (const who of ["priya", "mgr", "admin"]) {
      const r = await lock(who, t.number, { action: "take_over" });
      assert.equal(r.status, 200, `${who}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.lock.mine, true);
      assert.equal((await lockRow(t.id)).user_id, P[who].id);
    }
  });

  test("a role customised before 1.20.20 gains it only where it still replies", () => {
    const lead = rolesShared.HD_DEFAULT_MATRIX.team_lead.filter((c) => c !== "replies.take_over");
    const m = rolesShared.resolveMatrix({ team_lead: lead, v: 3 });
    assert.ok(m.team_lead.includes("replies.take_over"), "lifted onto a v3 Team lead");
    const noReply = lead.filter((c) => c !== "tickets.reply_public");
    assert.ok(!rolesShared.resolveMatrix({ team_lead: noReply, v: 3 }).team_lead.includes("replies.take_over"));
    assert.ok(!rolesShared.resolveMatrix({ team_lead: lead, v: rolesShared.HD_MATRIX_VERSION }).team_lead.includes("replies.take_over"), "removed on purpose since");
    assert.equal(rolesShared.HD_CAP_SCOPE["replies.take_over"], "tickets.view_all");
  });

  test("the lock moves, the previous holder is told and can't take it back, and it is audited with both people", async () => {
    const t = await raise("takeover");
    await lock("sam", t.number, { action: "take" });
    // The confirm named Sam; someone else holding it now is refused.
    const wrong = await lock("priya", t.number, { action: "take_over", from: P.ana.id });
    assert.equal(wrong.status, 409);
    const r = await lock("priya", t.number, { action: "take_over", from: P.sam.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.taken_over, true);
    const sam = await look("sam", t.number);
    assert.equal(sam.body.lock.name, "Priya Natarajan");
    assert.equal(sam.body.lock.mine, false);
    assert.equal(sam.body.taken_from_you.by_name, "Priya Natarajan");
    assert.equal(lockShared.takenOverNotice(sam.body.taken_from_you.by_name), "Priya took over this reply. Your text is kept as a draft.");
    // Sam's composer keeps polling: a refresh or a take never gets it back, and Sam's send is refused (his text is not lost:
    // it stays in his composer and his draft, client side).
    await lock("sam", t.number, { action: "refresh" });
    assert.equal((await lock("sam", t.number, { action: "take" })).status, 409);
    assert.equal((await post("sam", t.number, { kind: "public", body: "My half-written answer" })).status, 409);
    assert.equal((await lockRow(t.id)).user_id, P.priya.id);
    // Others see Priya; nobody else is told "taken from you".
    assert.equal((await look("ana", t.number)).body.taken_from_you, null);
    const a = (await pool().query("SELECT details, target_id FROM audit_log WHERE action = 'helpdesk.reply_lock.taken_over' AND actor_id = $1 AND target_id = $2", [P.priya.id, String(t.id)])).rows;
    assert.equal(a.length, 1);
    assert.deepEqual(
      { from: a[0].details.from_user_id, from_name: a[0].details.from_name, to: a[0].details.to_user_id, to_name: a[0].details.to_name, number: a[0].details.number },
      { from: P.sam.id, from_name: "Sam Lee", to: P.priya.id, to_name: "Priya Natarajan", number: t.number }
    );
    assert.equal(auditLabels.actionLabel("helpdesk.reply_lock.taken_over"), "Took over a reply");
    // Priya sends: the lock goes, Sam's box unlocks and the notice with it.
    assert.equal((await post("priya", t.number, { kind: "public", body: "I'll take this one." })).status, 201);
    const after = await look("sam", t.number);
    assert.equal(after.body.lock, null);
    assert.equal(after.body.taken_from_you, null);
  });

  test("taking over a ticket nobody is replying on just takes it (no audit row)", async () => {
    const t = await raise("takeover free");
    const r = await lock("priya", t.number, { action: "take_over" });
    assert.equal(r.status, 200);
    assert.equal(r.body.taken_over, false);
    const a = await pool().query("SELECT 1 FROM audit_log WHERE action = 'helpdesk.reply_lock.taken_over' AND target_id = $1", [String(t.id)]);
    assert.equal(a.rowCount, 0);
  });
});

// --- The queue, the setting, the licence ----------------------------------------------------------------

describe("queue badges", () => {
  test("the queue's locks list only tickets the viewer works", async () => {
    const a = await raise("queue A");
    const b = await raise("queue B", "B");
    await lock("sam", a.number, { action: "take" });
    await lockLib.takeReplyLock(b.id, P.other.id);
    const seen = await call(locksRoute.GET, "ana", `/reply-locks?numbers=${a.number},${b.number},999999999`);
    assert.equal(seen.status, 200);
    assert.deepEqual(
      seen.body.locks.map((l: any) => [l.number, l.name, l.initials, l.mine]),
      [[a.number, "Sam Lee", "SL", false]]
    );
    const mine = await call(locksRoute.GET, "sam", `/reply-locks?numbers=${a.number}`);
    assert.equal(mine.body.locks[0].mine, true);
    const otherTeam = await call(locksRoute.GET, "other", `/reply-locks?numbers=${a.number},${b.number}`);
    assert.deepEqual(otherTeam.body.locks.map((l: any) => l.number), [b.number]);
    assert.equal((await call(locksRoute.GET, "req", `/reply-locks?numbers=${a.number}`)).status, 403, "requesters never see it");
  });
});

describe("setting", () => {
  test("off is today's behaviour: nothing taken, shown or refused, and switching off drops every lock", async () => {
    const t = await raise("off");
    await lock("sam", t.number, { action: "take" });
    const save = await call(settingsRoute.PUT, "admin", "/admin/reply-lock", "PUT", { enabled: false });
    assert.equal(save.status, 200);
    assert.equal(save.body.settings.enabled, false);
    assert.equal(await lockRow(t.id), null, "dropped");
    const took = await lock("sam", t.number, { action: "take" });
    assert.equal(took.status, 200);
    assert.equal(took.body.enabled, false);
    assert.equal(took.body.lock, null);
    assert.equal(await lockRow(t.id), null, "nothing taken");
    assert.equal((await post("ana", t.number, { kind: "public", body: "Answering as before." })).status, 201);
    assert.deepEqual((await call(locksRoute.GET, "ana", `/reply-locks?numbers=${t.number}`)).body, { enabled: false, locks: [] });
    // The 1.19.1 send guard still works as before.
    const start = Number((await pool().query("SELECT max(id) AS id FROM hd_messages WHERE ticket_id = $1", [t.id])).rows[0].id);
    await post("sam", t.number, { kind: "public", body: "One more thing.", expect_last_message_id: start });
    assert.equal((await post("ana", t.number, { kind: "public", body: "Crossed.", expect_last_message_id: start })).status, 409);
    const audit = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.reply_lock.settings_updated' AND actor_id = $1", [P.admin.id]);
    assert.equal(audit.rowCount, 1);
    assert.deepEqual(audit.rows[0].details.changed, ["enabled"]);
    await setOn(true);
  });

  test("the settings route checks its values and its capability", async () => {
    assert.equal((await call(settingsRoute.PUT, "admin", "/admin/reply-lock", "PUT", { idle_minutes: 0 })).status, 400);
    assert.equal((await call(settingsRoute.PUT, "admin", "/admin/reply-lock", "PUT", { enabled: "yes" })).status, 400);
    assert.equal((await call(settingsRoute.GET, "priya", "/admin/reply-lock")).status, 403, "a Team lead doesn't hold Helpdesk settings");
    const r = await call(settingsRoute.PUT, "admin", "/admin/reply-lock", "PUT", { idle_minutes: 5 });
    assert.equal(r.body.settings.idle_minutes, 5);
    assert.equal((await call(settingsRoute.GET, "admin", "/admin/reply-lock")).body.settings.idle_minutes, 5);
    await setOn(true, 2);
  });

  test("the upgrade default is off and a new desk's is on (written once, never again)", async () => {
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      // The setting's guarded block only (the table's DDL would lock tables other suites use).
      const insertOnly = HD_REPLY_LOCK_SCHEMA.slice(HD_REPLY_LOCK_SCHEMA.indexOf("DO $$"));
      await client.query("DELETE FROM settings WHERE key = 'helpdesk_reply_lock'");
      await client.query(insertOnly);
      const upgrade = JSON.parse((await client.query("SELECT value FROM settings WHERE key = 'helpdesk_reply_lock'")).rows[0].value);
      assert.deepEqual(upgrade, { enabled: false, idle_minutes: 2 }, "a desk with messages: off");
      // 1.20.20 review: a desk with teams (or tickets, or help addresses) but no messages yet is in use too: off.
      // Temporary empty tables shadow the real ones in this transaction.
      await client.query("DELETE FROM settings WHERE key = 'helpdesk_reply_lock'");
      for (const tbl of ["hd_messages", "hd_tickets", "hd_mailboxes"]) await client.query(`CREATE TEMP TABLE ${tbl} (id integer) ON COMMIT DROP`);
      await client.query(insertOnly);
      assert.equal(JSON.parse((await client.query("SELECT value FROM settings WHERE key = 'helpdesk_reply_lock'")).rows[0].value).enabled, false, "teams only: off");
      // A desk with nothing yet: on.
      await client.query("DELETE FROM settings WHERE key = 'helpdesk_reply_lock'");
      await client.query("CREATE TEMP TABLE hd_teams (id integer) ON COMMIT DROP");
      await client.query(insertOnly);
      const fresh = JSON.parse((await client.query("SELECT value FROM settings WHERE key = 'helpdesk_reply_lock'")).rows[0].value);
      assert.deepEqual(fresh, { enabled: true, idle_minutes: 2 }, "a new desk: on");
      // Later boots never overwrite the admin's choice.
      await client.query("UPDATE settings SET value = '{\"enabled\":false,\"idle_minutes\":7}' WHERE key = 'helpdesk_reply_lock'");
      await client.query(insertOnly);
      assert.match((await client.query("SELECT value FROM settings WHERE key = 'helpdesk_reply_lock'")).rows[0].value, /"idle_minutes":7/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    // Garbage stored is read as off with the default idle time.
    assert.deepEqual(lockShared.resolveReplyLockSettings({ enabled: "on", idle_minutes: 99 }), { enabled: false, idle_minutes: 2 });
  });

  test("Desk settings finds it by the words people use", () => {
    const admin = { caps: rolesShared.HD_DEFAULT_MATRIX.admin };
    for (const q of ["lock", "collision", "reply lock", "takeover"]) {
      assert.ok(registry.searchDeskSettings(admin, q).some((h) => h.href.startsWith("/desk/settings/reply-lock")), q);
    }
    assert.equal(registry.searchDeskSettings(admin, "reply lock")[0]?.href.split("#")[0], "/desk/settings/reply-lock");
    assert.ok(!registry.searchDeskSettings({ caps: rolesShared.HD_DEFAULT_MATRIX.team_lead }, "reply lock").some((h) => h.href.startsWith("/desk/settings/reply-lock")));
  });
});

// --- 1.20.20 security review: regressions ---------------------------------------------------------

const settled = <T>(p: Promise<T>, ms = 500) => Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
const isLocked = (e: any) => e instanceof tickets.HdTicketError && e.status === 409 && e.extra?.code === "reply_locked";

describe("review fixes", () => {
  test("#1 a take over waits for an in-flight send (lock row FOR SHARE) and then finds the reply sent: 409, nothing moves", async () => {
    const t = await raise("race send then take over");
    await lock("sam", t.number, { action: "take" });
    const c = await pool().connect();
    try {
      await c.query("BEGIN");
      // Sam's send, inside its transaction: the check passes and holds the lock row.
      assert.equal(await lockLib.replyLockCheck(t.id, P.sam.id, c), null);
      const over = lockLib.takeOverReplyLock(t.id, P.priya.id, P.sam.id);
      assert.equal(await settled(over), false, "the take over waits for the send");
      await lockLib.releaseReplyLock(t.id, P.sam.id, c); // the send releases its lock in the same transaction
      await c.query("COMMIT");
      assert.deepEqual(await over, { ok: false, status: 409, error: lockShared.LOCK_CHANGED });
    } finally {
      c.release();
    }
    assert.equal(await lockRow(t.id), null, "nobody holds it: the reply went out first");
  });

  test("#1 a send that starts while a take over is in flight waits, then is refused: the lead's reply is the one", async () => {
    const t = await raise("race take over then send");
    await lock("sam", t.number, { action: "take" });
    const c = await pool().connect();
    let send: Promise<unknown> | null = null;
    try {
      await c.query("BEGIN");
      // As takeOverReplyLock does: Priya's presence first, then the lock row FOR UPDATE.
      await c.query(
        `INSERT INTO hd_ticket_presence (ticket_id, user_id, state) VALUES ($1, $2, 'replying') ON CONFLICT (ticket_id, user_id) DO UPDATE SET seen_at = now()`,
        [t.id, P.priya.id]
      );
      await c.query("SELECT ticket_id FROM hd_reply_locks WHERE ticket_id = $1 FOR UPDATE", [t.id]);
      send = messagesLib.addMessage(t.id, { kind: "public", body: "Sam's answer", author: { id: P.sam.id, name: P.sam.name, email: "" }, via: "desk", asRequester: false });
      send.catch(() => {});
      assert.equal(await settled(send), false, "the send waits for the take over");
      await c.query("UPDATE hd_reply_locks SET user_id = $2, prev_user_id = $3, taken_over_at = now(), since = now(), touched_at = now() WHERE ticket_id = $1", [t.id, P.priya.id, P.sam.id]);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    await assert.rejects(send!, isLocked);
    assert.equal((await msgs(t.id)).filter((m: any) => m.kind === "public" && m.author_id === P.sam.id).length, 0, "Sam's reply never went out");
    assert.equal((await lockRow(t.id)).user_id, P.priya.id);
  });

  test("#1 an agent's email that meets a lock taken after the first check is still kept as an internal note", async () => {
    const t = await raise("email race");
    const token = await email.ensureReplyToken(t.id);
    inbound.setInboundBeforeAppendForTests(async (id) => {
      if (id === t.id) await lockLib.takeReplyLock(t.id, P.sam.id);
    });
    try {
      const r = await inbound.processInboundEmail(
        {
          provider: "generic",
          from: { email: P.ana.email, name: "" },
          to: [{ email: ALIAS, name: "" }],
          cc: [],
          recipients: [],
          subject: `Re: ${t.subject} [#${t.number} ref:${token}]`,
          text: "Try the other VPN gateway.",
          html: "",
          stripped: "",
          messageId: `${newToken()}@mail.example.test`,
          inReplyTo: "",
          references: [],
          headers: {},
          auth: { dmarc: "pass" },
          files: [],
        } as InboundEmail,
        { outsideSenders: false }
      );
      assert.equal(r.body.outcome, "appended");
    } finally {
      inbound.setInboundBeforeAppendForTests(null);
    }
    const last = (await msgs(t.id)).at(-1)!;
    assert.equal(last.kind, "internal");
    assert.match(last.body, /^Sent by email while Sam Lee was replying/);
    assert.match(last.body, /other VPN gateway/);
  });

  test("#2 an agent holds at most three locks: a fourth releases their oldest, audited", async () => {
    await lockLib.forceReleaseReplyLocks({ userId: P.sam.id });
    const ts = [];
    for (let i = 0; i < 4; i++) ts.push(await raise(`cap ${i}`));
    for (const t of ts.slice(0, 3)) assert.equal((await lock("sam", t.number, { action: "take" })).status, 200);
    assert.equal((await lock("sam", ts[3].number, { action: "take" })).status, 200);
    assert.equal(await lockRow(ts[0].id), null, "the oldest went");
    for (const t of ts.slice(1)) assert.equal((await lockRow(t.id)).user_id, P.sam.id);
    const a = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.reply_lock.cap_released' AND actor_id = $1 AND target_id = $2", [P.sam.id, String(ts[3].id)]);
    assert.deepEqual(a.rows[0]?.details.released, [ts[0].number]);
    assert.equal(auditLabels.hasActionLabel("helpdesk.reply_lock.cap_released"), true);
  });

  test("#2/#4 idle is the server's, from the last touch: a heartbeat alone can't keep it; a claimed touch can, for an hour at most", async () => {
    const t = await raise("idle from last touch");
    const tab = "tab-idle-0001";
    await lock("sam", t.number, { action: "take", tab });
    await pool().query("UPDATE hd_reply_locks SET touched_at = now() - interval '100 seconds' WHERE ticket_id = $1", [t.id]);
    // Heartbeats that say "last touched 100 s ago" keep the heartbeat fresh but not the touch.
    await lock("sam", t.number, { action: "refresh", tab, idle_ms: 100_000 });
    await pool().query("UPDATE hd_reply_locks SET touched_at = now() - interval '125 seconds' WHERE ticket_id = $1", [t.id]);
    assert.equal(await lockLib.refreshReplyLock(t.id, P.sam.id, tab, 125_000), false, "past the idle time: gone");
    assert.equal((await look("ana", t.number)).body.lock, null);
    // A real touch (idle_ms near 0) is trusted from the agent ...
    await lock("sam", t.number, { action: "take", tab });
    await pool().query("UPDATE hd_reply_locks SET touched_at = now() - interval '100 seconds' WHERE ticket_id = $1", [t.id]);
    await lock("sam", t.number, { action: "refresh", tab, idle_ms: 0 });
    const age = Number((await pool().query("SELECT extract(epoch from now() - touched_at) AS s FROM hd_reply_locks WHERE ticket_id = $1", [t.id])).rows[0].s);
    assert.ok(age < 5);
    // ... but never past an hour without a send.
    await pool().query("UPDATE hd_reply_locks SET since = now() - interval '61 minutes' WHERE ticket_id = $1", [t.id]);
    await lock("sam", t.number, { action: "refresh", tab, idle_ms: 0 });
    assert.equal((await look("ana", t.number)).body.lock, null, "an hour without a send: gone");
    assert.equal(lockShared.REPLY_LOCK_MAX_HOLD_MINUTES, 60);
  });

  test("#2 Release: a lead releases one ticket's lock (audited); an Agent can't; an admin releases all of Sam's", async () => {
    const t1 = await raise("release one");
    const t2 = await raise("release all 1");
    const t3 = await raise("release all 2");
    await lockLib.forceReleaseReplyLocks({ userId: P.sam.id });
    for (const t of [t1, t2, t3]) await lock("sam", t.number, { action: "take" });
    assert.equal((await lock("ana", t1.number, { action: "release" })).status, 403);
    const one = await lock("priya", t1.number, { action: "release" });
    assert.equal(one.status, 200);
    assert.equal(one.body.lock, null);
    const a1 = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.reply_lock.released' AND actor_id = $1", [P.priya.id]);
    assert.deepEqual(a1.rows.at(-1)?.details.numbers, [t1.number]);
    // The settings page lists who holds what, and releases all of one person's.
    const list = await call(settingsRoute.GET, "admin", "/admin/reply-lock");
    assert.deepEqual(
      list.body.locks.filter((l: any) => l.user_id === P.sam.id).map((l: any) => l.number).sort(),
      [t2.number, t3.number].sort()
    );
    assert.equal((await call(settingsRoute.POST, "priya", "/admin/reply-lock", "POST", { release: { user_id: P.sam.id } })).status, 403);
    const all = await call(settingsRoute.POST, "admin", "/admin/reply-lock", "POST", { release: { user_id: P.sam.id } });
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.released.map((r: any) => r.number).sort(), [t2.number, t3.number].sort());
    assert.equal(await lockRow(t2.id), null);
    const a2 = await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.reply_lock.released' AND actor_id = $1", [P.admin.id]);
    assert.equal(a2.rows.at(-1)?.details.all, true);
    assert.equal(a2.rows.at(-1)?.details.from_name, "Sam Lee");
  });

  test("#3 per tab: only the tab that holds it releases it; presence ends with the last tab; hand-off moves it to another tab", async () => {
    const t = await raise("tabs");
    const A = "tab-aaaaaaaa", B = "tab-bbbbbbbb", C = "tab-cccccccc";
    await lock("sam", t.number, { action: "take", tab: A });
    await call(lockRoute.DELETE, "sam", `/tickets/${t.number}/reply-lock?tab=${B}`, "DELETE", undefined, { number: String(t.number) });
    assert.equal((await lockRow(t.id))?.user_id, P.sam.id, "another tab closing leaves it");
    // Hand-off to the pop-out's tab: then the pane's tab closing leaves it too.
    const h = await lock("sam", t.number, { action: "hand_off", tab: A, to: C });
    assert.equal(h.body.handed_off, true);
    await call(lockRoute.DELETE, "sam", `/tickets/${t.number}/reply-lock?tab=${A}`, "DELETE", undefined, { number: String(t.number) });
    assert.equal((await lockRow(t.id))?.user_id, P.sam.id, "handed off: the pane's close releases nothing");
    await call(lockRoute.DELETE, "sam", `/tickets/${t.number}/reply-lock?tab=${C}`, "DELETE", undefined, { number: String(t.number) });
    assert.equal(await lockRow(t.id), null, "the holding tab's close releases it");
    // Presence: two tabs beat; one leaves; the row stays until the last one leaves.
    const t2 = await raise("tabs presence");
    for (const tab of [A, B]) await call(presenceRoute.POST, "sam", `/tickets/${t2.number}/presence`, "POST", { state: "viewing", tab }, { number: String(t2.number) });
    await call(presenceRoute.DELETE, "sam", `/tickets/${t2.number}/presence?tab=${A}`, "DELETE", undefined, { number: String(t2.number) });
    assert.ok((await look("ana", t2.number)).status === 200);
    const pres = async () => (await pool().query("SELECT tabs FROM hd_ticket_presence WHERE ticket_id = $1 AND user_id = $2", [t2.id, P.sam.id])).rows[0];
    assert.deepEqual(Object.keys((await pres()).tabs), [B]);
    await presenceLib.leavePresence(t2.id, P.sam.id, B);
    assert.equal(await pres(), undefined, "the last tab left");
  });

  test("#5 an automation an agent's action set off meets the lock as that agent's; the requester's and the system's stay exempt", async () => {
    const m = await macros.createMacro({ title: `${STAMP} auto ack`, body: "Thanks, {{requester.first_name}}: we're on it.", actions: {} as never, team_id: null, owner_id: null }, null);
    macroIds.push(m.id);
    const t = await raise("automation lock");
    await lock("sam", t.number, { action: "take" });
    await assert.rejects(macros.applyMacroToTicket(t.id, m.id, { id: null, name: "Automation", email: "" }, { fromAutomation: true, lockAs: P.ana.id }), isLocked);
    const rule = { id: 0, name: "Acknowledge", actions: { macro_id: m.id } } as never;
    const row = (await pool().query("SELECT * FROM hd_tickets WHERE id = $1", [t.id])).rows[0];
    const before = (await msgs(t.id)).filter((x: any) => x.kind === "public").length;
    assert.equal(await automations.applyRule(rule, row, P.ana.id), false, "set off by Ana: refused, nothing posted");
    assert.equal((await msgs(t.id)).filter((x: any) => x.kind === "public").length, before);
    assert.equal(await automations.applyRule(rule, row, P.sam.id), true, "set off by the holder: sent");
    assert.equal(await automations.applyRule(rule, row, P.req.id), true, "set off by the requester: exempt");
    assert.equal(await automations.applyRule(rule, row, null), true, "the system's own: exempt");
  });

  test("#6 a Team lead takes over only in teams they lead, never from a Manager or Admin; Managers and Admins anywhere", async () => {
    const t = await raise("rank");
    await lockLib.takeReplyLock(t.id, P.mgr.id);
    assert.equal((await look("priya", t.number)).body.lock.can_take_over, false);
    assert.equal((await lock("priya", t.number, { action: "take_over" })).status, 403, "a lead can't take it from a Manager");
    assert.equal((await lock("admin", t.number, { action: "take_over" })).status, 200, "an Admin can");
    // A lead who can see every team (a customised role) still takes over only in the teams they lead.
    roles.setRoleMatrixForTests({ ...rolesShared.HD_DEFAULT_MATRIX, team_lead: [...rolesShared.HD_DEFAULT_MATRIX.team_lead, "tickets.view_all"] });
    try {
      const t2 = await raise("rank lead elsewhere");
      await lock("sam", t2.number, { action: "take" });
      assert.equal((await look("leadB", t2.number)).status, 200, "Lars works it (view_all)");
      assert.equal((await look("leadB", t2.number)).body.lock.can_take_over, false);
      assert.equal((await lock("leadB", t2.number, { action: "take_over" })).status, 403);
      assert.equal((await lock("priya", t2.number, { action: "take_over" })).status, 200, "the team's own lead can");
    } finally {
      roles.setRoleMatrixForTests(rolesShared.HD_DEFAULT_MATRIX);
    }
  });

  test("#8 three takers at once: exactly one is told ok, and ok always means the row is theirs", async () => {
    for (let i = 0; i < 6; i++) {
      const t = await raise(`three-way ${i}`);
      const who = [P.sam.id, P.ana.id, P.priya.id];
      const rs = await Promise.all(who.map((u) => lockLib.takeReplyLock(t.id, u, `tab-race-${u}`)));
      const winners = rs.map((r, k) => (r.ok ? who[k] : 0)).filter(Boolean);
      assert.equal(winners.length, 1, `round ${i}`);
      assert.equal((await lockRow(t.id)).user_id, winners[0]);
    }
  });

  test("#9 a macro's refusal carries code reply_locked and the holder, checked on its filled reply", async () => {
    const m = await macros.createMacro({ title: `${STAMP} filled`, body: "Hi {{requester.first_name}}, the token is reset.", actions: { priority: "low" } as never, team_id: null, owner_id: null }, null);
    macroIds.push(m.id);
    const t = await raise("macro body");
    await lock("sam", t.number, { action: "take" });
    const r = await applyMacro("ana", t.number, m.id);
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { error: lockShared.lockRefusal("Sam Lee"), code: "reply_locked", holder: { user_id: P.sam.id, name: "Sam Lee" } });
    assert.notEqual((await pool().query("SELECT priority FROM hd_tickets WHERE id = $1", [t.id])).rows[0].priority, "low", "nothing changed");
  });

  test("#10 approving a held reply after someone else replied asks first; send anyway approves it", async () => {
    const t = await raise("approve after reply");
    const held = await post("newbie", t.number, { kind: "public", body: "Please restart the laptop." });
    assert.equal(held.body.held, true);
    assert.equal((await post("ana", t.number, { kind: "public", body: "I've pushed a new VPN profile." })).status, 201);
    const url = `/reviews/${held.body.message.id}`;
    const ask = await call(reviewRoute.POST, "priya", url, "POST", { decision: "approve" }, { id: String(held.body.message.id) });
    assert.equal(ask.status, 409);
    assert.equal(ask.body.code, "collision");
    assert.equal(ask.body.error, "Ana Kowalski replied after this was written. Send anyway?");
    assert.equal(ask.body.newer[0].author_name, "Ana Kowalski");
    const ok = await call(reviewRoute.POST, "priya", url, "POST", { decision: "approve", force: true }, { id: String(held.body.message.id) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });
});

describe("with the pop-out (1.20.18) and live updates (1.20.19)", () => {
  test("a lock taken, moved to someone else or gone signals the live bus with the ticket's team and owner only; a heartbeat doesn't", async () => {
    const t = await raise("live signal");
    const c = await pool().connect();
    const heard: string[] = [];
    const on = (m: { channel: string; payload?: string }) => m.channel === "hd_queue_live" && heard.push(m.payload ?? "");
    c.on("notification", on);
    await c.query("LISTEN hd_queue_live");
    const want = `,,${T.A},`;
    const settle = () => new Promise((r) => setTimeout(r, 300));
    try {
      await lock("sam", t.number, { action: "take", tab: "tab-live-0001" });
      await settle();
      assert.ok(heard.includes(want), `taken: ${JSON.stringify(heard)}`);
      heard.length = 0;
      await lock("sam", t.number, { action: "refresh", tab: "tab-live-0001", idle_ms: 0 });
      await lock("sam", t.number, { action: "take", tab: "tab-live-0002" });
      await settle();
      assert.ok(!heard.includes(want), "a heartbeat, a re-take or a tab move is no news");
      await lock("priya", t.number, { action: "take_over" });
      await settle();
      assert.ok(heard.includes(want), "moved to Priya");
      heard.length = 0;
      await lock("priya", t.number, { action: "release" });
      await settle();
      assert.ok(heard.includes(want), "gone");
      for (const p of heard) assert.match(p, /^[\d,]*$/, "ids only: no names, no number");
    } finally {
      await c.query("UNLISTEN hd_queue_live");
      c.off("notification", on);
      c.release();
    }
  });

  test("the holder's tabs know which of them holds it (this_tab); the pop-out's hand-off moves it and back", async () => {
    const t = await raise("this tab");
    const pane = "tab-pane-00001", pop = "tab-popout-0001";
    await lock("sam", t.number, { action: "take", tab: pane });
    const as = async (tab: string) => (await call(lockRoute.GET, "sam", `/tickets/${t.number}/reply-lock?tab=${tab}`, "GET", undefined, { number: String(t.number) })).body.lock;
    assert.equal((await as(pane)).this_tab, true);
    assert.equal((await as(pop)).this_tab, false);
    assert.equal((await lock("sam", t.number, { action: "hand_off", tab: pane, to: pop })).body.handed_off, true);
    assert.equal((await as(pop)).this_tab, true);
    assert.equal((await as(pane)).this_tab, false);
    // The pane's refresh while the reply is out would take it back to the pane: the desk only refreshes from the
    // tab that holds it (this_tab), and a release from the pane does nothing.
    await call(lockRoute.DELETE, "sam", `/tickets/${t.number}/reply-lock?tab=${pane}`, "DELETE", undefined, { number: String(t.number) });
    assert.equal((await lockRow(t.id)).user_id, P.sam.id);
    // Bring back: the pop-out hands it home.
    assert.equal((await lock("sam", t.number, { action: "hand_off", tab: pop, to: pane })).body.handed_off, true);
    assert.equal((await as(pane)).this_tab, true);
    // A hand-off from a tab that doesn't hold it moves nothing; nobody else's view says this_tab.
    assert.equal((await lock("sam", t.number, { action: "hand_off", tab: pop, to: "tab-elsewhere-1" })).body.handed_off, false);
    assert.equal((await look("ana", t.number)).body.lock.this_tab, undefined);
  });

  test("the pop-out's hand-off record carries the lock's tabs and last touch, checked", () => {
    const now = Date.now();
    const h = popout.parseHandoff({ u: 7, mode: "public", files: [], macro: null, send_id: null, lock_tab: "tab-popout-0001", lock_home: "tab-pane-00001", lock_at: now - 5_000, at: now }, 7, now);
    assert.equal(h?.lock_tab, "tab-popout-0001");
    assert.equal(h?.lock_home, "tab-pane-00001");
    assert.equal(h?.lock_at, now - 5_000);
    const bad = popout.parseHandoff({ u: 7, mode: "public", files: [], macro: null, lock_tab: "x", lock_home: "<script>", lock_at: now + 3_600_000, at: now }, 7, now);
    assert.deepEqual([bad?.lock_tab, bad?.lock_home, bad?.lock_at], [null, null, null]);
  });
});

describe("licence", () => {
  test("without the helpdesk in the licence the routes answer 402 and nothing is taken", async () => {
    const t = await raise("licence");
    edition.features = [];
    try {
      assert.equal((await lock("sam", t.number, { action: "take" })).status, 402);
      assert.equal((await look("sam", t.number)).status, 402);
      assert.equal((await call(locksRoute.GET, "sam", `/reply-locks?numbers=${t.number}`)).status, 402);
      assert.equal((await call(settingsRoute.GET, "admin", "/admin/reply-lock")).status, 402);
    } finally {
      edition.features = ["helpdesk"];
    }
    assert.equal(await lockRow(t.id), null);
  });
});
