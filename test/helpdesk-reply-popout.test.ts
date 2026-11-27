// Helpdesk 1.20.18: the reply pop-out (/desk/tickets/[number]/reply,
// components/helpdesk/desk/popout). The pop-out adds no route of its own:
// it is a desk page that loads and sends through the ticket pane's routes.
// Covered:
//
//   hand-off   the channel messages and the hand-off record are shape-checked
//              (junk, wrong types, other fields, old records, a forged macro
//              are dropped or cleaned); the browser-storage wrappers never
//              throw where storage is missing or refused
//   review     (1.20.18 security review) keys and records carry the agent:
//              another agent's drafts are refused and pruned, 1.20.16's
//              unnamed drafts are adopted once by the agent who opens the
//              desk (never over their own), sign-out clears every desk key and nothing else, an
//              expired record is deleted when found; the owner token, the
//              taken record and the sending marker; the messages route's
//              idempotency key (same key twice, racing, reused after a
//              refusal, per agent and ticket, malformed, swept, a stuck
//              claim) and expect_user_id (another account signed in now)
//   address    the pop-out's address carries the ticket number only; the
//              desk shell's bare-page test matches it and nothing else; the
//              window is named per ticket; the Duo desk rule covers the path
//   page       the page itself: a bad number is a 404; an agent gets the
//              pop-out; someone with a desk permission but no queue gets a
//              refusal, not the composer
//   routes     what the pop-out calls, as the pane calls it: the ticket loads
//              for its team's agent and is refused (404, as missing) to an
//              agent of another team and (403) to a requester; a reply, a
//              note and a send-and-solve go through for the team's agent and
//              never for the other; the send guard answers 409 { newer }
//
// Parallel-safe: every account, team and ticket is this file's own (STAMP);
// nobody is a workspace administrator.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-reply-popout.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";
import {
  HANDOFF_MAX_AGE_MS,
  POPOUT_SIZE,
  aliveAge,
  clearAlive,
  adoptLegacyDrafts,
  clearHandoff,
  deskKeyOwner,
  forgetDeskOnSignOut,
  isReplyPopoutPath,
  markSending,
  markTaken,
  newOwnerToken,
  newSendId,
  parseHandoff,
  parsePopoutMessage,
  popoutFeatures,
  popoutPath,
  popoutWindowName,
  pruneDeskStorage,
  readAlive,
  readDraft,
  readHandoff,
  readSending,
  stampAlive,
  stillOwner,
  wasTaken,
  writeDraft,
  writeHandoff,
} from "../src/components/helpdesk/desk/popout/reply-popout";

// --- The request scope outside Next ------------------------------------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-reply-popout.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-reply-popout.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
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
  ee.exports = { ee: () => ({ present: true, features: ["helpdesk"] }), eePresent: () => true, featureEnabled: async (f: string) => f === "helpdesk", featureEnforced: async (f: string) => f === "helpdesk", featureEnabledFrom: (f: string) => f === "helpdesk", featureEnforcedFrom: (f: string) => f === "helpdesk" };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as { _resolveFilename: (r: string, p: { filename?: string } | null, ...rest: unknown[]) => string };
  const orig = loader._resolveFilename;
  loader._resolveFilename = function (r: string, p: { filename?: string } | null, ...rest: unknown[]) {
    if (r === "next/headers") return HEADERS_STUB;
    if (r === "@/lib/ee") return EE_STUB;
    if ((r === "./ee" || r === "../ee") && p?.filename && path.resolve(path.dirname(p.filename), r) === EE_REAL) return EE_STUB;
    return orig.call(this, r, p, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const notify = require("../src/lib/helpdesk/notify") as typeof import("../src/lib/helpdesk/notify");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const duoPolicy = require("../src/lib/duo-policy") as typeof import("../src/lib/duo-policy");
const ticketRoute = require("../src/app/api/helpdesk/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/route");
const messagesRoute = require("../src/app/api/helpdesk/tickets/[number]/messages/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/messages/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdTicket } from "../src/lib/helpdesk/types";

type AnyHandler = (req: Request, ctx?: any) => Promise<Response>;

async function call(handler: AnyHandler, req: Request, params?: Record<string, string>): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = params ? await handler(req, { params: Promise.resolve(params) }) : await handler(req);
    let body: any = null;
    try {
      body = await res.clone().json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, body };
  } finally {
    currentRequest = null;
  }
}

function req(url: string, session: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `hdrp-${Date.now()}-${process.pid}`;
interface Person {
  id: number;
  session: string;
  name: string;
  email: string;
}
const P: Record<string, Person> = {};
const personIds: number[] = [];
const roleIds: number[] = [];
const teamIds: number[] = [];
const ticketIds: number[] = [];
let A = 0;

async function person(key: string, name: string): Promise<Person> {
  const addr = `${STAMP}-${key}@example.test`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [`${STAMP}-${key}`, name, addr]);
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  personIds.push(id);
  P[key] = { id, session, name, email: addr };
  return P[key];
}

async function team(name: string, members: [string, "agent" | "lead"][]): Promise<number> {
  const r = await fixtureQuery("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`${STAMP} ${name}`]);
  const id = r.rows[0].id as number;
  teamIds.push(id);
  for (const [k, role] of members) await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, $3)", [id, P[k].id, role]);
  return id;
}

async function raise(teamId: number, subject: string): Promise<HdTicket> {
  const t = await tickets.createTicket(
    {
      subject,
      body: "The shared drive opens read-only since this morning.",
      requester: { id: P.req.id, name: P.req.name, email: P.req.email },
      team_id: teamId,
      answers: {} as never,
    } as never,
    { silent: true, actorId: P.req.id, actorName: P.req.name }
  );
  ticketIds.push(t.id);
  return (await tickets.getTicketById(t.id))!;
}

const load = (who: Person, n: number) => call(ticketRoute.GET as AnyHandler, req(`/api/helpdesk/tickets/${n}`, who.session), { number: String(n) });
const post = (who: Person, n: number, body: Record<string, unknown>) =>
  call(messagesRoute.POST as AnyHandler, req(`/api/helpdesk/tickets/${n}/messages`, who.session, body), { number: String(n) });
const countMessages = async (ticketId: number) => Number((await pool().query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1", [ticketId])).rows[0].n);
const lastId = async (ticketId: number) => Number((await pool().query("SELECT max(id) AS id FROM hd_messages WHERE ticket_id = $1", [ticketId])).rows[0].id);

before(async () => {
  await getSetting("__schema_bootstrap__");
  await pool().query(roles.HD_ROLES_SCHEMA);
  for (const [k, n] of [
    ["req", "Daniel Okafor"],
    ["sam", "Sam Lee"],
    ["ana", "Ana Kowalski"],
    ["other", "Otto Other"],
  ] as const) {
    await person(k, n);
  }
  const role = await fixtureQuery("INSERT INTO roles (key, name) VALUES ($1, $1) RETURNING id", [`${STAMP}-request`]);
  roleIds.push(role.rows[0].id);
  await fixtureQuery("INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'helpdesk.request')", [role.rows[0].id]);
  for (const id of personIds) await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [role.rows[0].id, id]);
  for (const [k, r] of [["sam", "agent"], ["ana", "agent"], ["other", "agent"]] as const) {
    await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [P[k].id, r]);
  }
  A = await team("IT", [["sam", "agent"], ["ana", "agent"]]);
  await team("Facilities", [["other", "agent"]]);
  notify.setAgentDeliverySpyForTests(() => {});
  email.setHelpdeskTransportForTests(async () => {});
});

after(async () => {
  notify.setAgentDeliverySpyForTests(null);
  email.setHelpdeskTransportForTests(null);
  await pool().query("DELETE FROM hd_ticket_presence WHERE ticket_id = ANY($1) OR user_id = ANY($2)", [ticketIds, personIds]);
  await pool().query("DELETE FROM hd_message_send_ids WHERE ticket_id = ANY($1) OR user_id = ANY($2)", [ticketIds, personIds]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [ticketIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [teamIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [personIds]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [personIds]);
  await pool().end();
});

// --- The hand-off ----------------------------------------------------------------------

describe("hand-off messages and records", () => {
  test("channel messages: only the known events with a ticket number and agent; other fields are dropped", () => {
    const tok = "a".repeat(32);
    assert.deepEqual(parsePopoutMessage({ type: "open", n: 12, u: 4, token: tok }), { type: "open", n: 12, u: 4, token: tok });
    for (const type of ["ping", "typing", "changed", "closed", "focus", "bring-back", "busy"]) assert.deepEqual(parsePopoutMessage({ type, n: 3, u: 9 }), { type, n: 3, u: 9 });
    for (const type of ["here", "taken", "ack"]) assert.deepEqual(parsePopoutMessage({ type, n: 3, u: 9, token: tok }), { type, n: 3, u: 9, token: tok });
    assert.deepEqual(parsePopoutMessage({ type: "ping", n: 7, u: 2, text: "secret draft", role: "admin" }), { type: "ping", n: 7, u: 2 }, "nothing but the event, the number and the agent is kept");
    assert.deepEqual(parsePopoutMessage({ type: "sent", n: 5, u: 1, kind: "internal" }), { type: "sent", n: 5, u: 1, kind: "internal" });
    assert.deepEqual(parsePopoutMessage({ type: "sent", n: 5, u: 1, kind: "review", warning: "  A required checklist item is unticked.  " }), {
      type: "sent",
      n: 5,
      u: 1,
      kind: "review",
      warning: "A required checklist item is unticked.",
    });
    assert.equal((parsePopoutMessage({ type: "sent", n: 5, u: 1, kind: "public", warning: "x".repeat(1000) }) as { warning: string }).warning.length, 300);
    assert.deepEqual(parsePopoutMessage({ type: "fill", n: 5, u: 1, text: "Draft", mode: "internal", replace: 3 }), { type: "fill", n: 5, u: 1, text: "Draft", mode: "internal", replace: null });
    assert.deepEqual(parsePopoutMessage({ type: "signout", n: "x" }), { type: "signout" });
    for (const bad of [
      null,
      "open",
      12,
      [],
      { type: "ping", n: 4 },
      { type: "ping", u: 4 },
      { type: "open", n: 1, u: 1 },
      { type: "open", n: 1, u: 1, token: "not-hex!" },
      { type: "here", n: 1, u: 1, token: "ab" },
      { type: "ping", n: 0, u: 1 },
      { type: "ping", n: -3, u: 1 },
      { type: "ping", n: 1.5, u: 1 },
      { type: "ping", n: "12", u: 1 },
      { type: "grant", n: 4, u: 1 },
      { type: "sent", n: 4, u: 1 },
      { type: "sent", n: 4, u: 1, kind: "solve" },
      { type: "fill", n: 4, u: 1, text: "", mode: "public" },
      { type: "fill", n: 4, u: 1, text: "x".repeat(20_001), mode: "public" },
      { type: "fill", n: 4, u: 1, text: "x", mode: "solve" },
    ]) {
      assert.equal(parsePopoutMessage(bad), null, JSON.stringify(bad));
    }
  });

  test("a hand-off record is the agent's own, checked and cleaned; an old one is ignored", () => {
    const now = Date.now();
    const macro = { id: 9, title: "VPN reset", body: "Hi {{requester.first_name}}", actions: { status: "pending", priority: "high", team_id: 4, tags_add: ["vpn", 5, ""] }, team_id: null };
    const h = parseHandoff(
      {
        u: 7,
        mode: "internal",
        files: [{ id: 3, name: "log.txt", size: 12, type: "text/plain" }, { id: 3, name: "dup.txt", size: 1 }, { id: -1, name: "bad" }, { id: 4 }, "x"],
        macro,
        send_id: "0123456789abcdef0123",
        at: now - 1_000,
        text: "never read from here",
      },
      7,
      now
    );
    assert.ok(h);
    assert.equal(h.mode, "internal");
    assert.equal(h.send_id, "0123456789abcdef0123");
    assert.deepEqual(h.files, [{ id: 3, name: "log.txt", size: 12, type: "text/plain" }]);
    assert.deepEqual(h.macro?.actions, { status: "pending", priority: "high", team_id: 4, tags_add: ["vpn"] });
    assert.equal("text" in (h as object), false);
    // Another agent's record (a shared computer) is refused.
    assert.equal(parseHandoff({ u: 8, mode: "public", files: [], macro: null, at: now }, 7, now), null);
    assert.equal(parseHandoff({ mode: "public", files: [], macro: null, at: now }, 7, now), null, "a record naming no one is refused");
    // A malformed key is dropped, not sent.
    assert.equal(parseHandoff({ u: 7, mode: "public", files: [], macro: null, send_id: "short", at: now }, 7, now)?.send_id, null);
    // A forged macro action is dropped, not passed on.
    assert.deepEqual(parseHandoff({ u: 7, mode: "public", files: [], macro: { ...macro, actions: { status: "deleted", priority: "now", team_id: "4" } }, at: now }, 7, now)?.macro?.actions, {});
    assert.equal(parseHandoff({ u: 7, mode: "public", files: [], macro: { id: 1 }, at: now }, 7, now)?.macro, null);
    const many = Array.from({ length: 14 }, (_, i) => ({ id: i + 1, name: `f${i}.png`, size: 1, type: "image/png" }));
    assert.equal(parseHandoff({ u: 7, mode: "public", files: many, macro: null, at: now }, 7, now)?.files.length, 10);
    assert.equal(parseHandoff({ u: 7, mode: "public", files: [], macro: null, at: now - HANDOFF_MAX_AGE_MS - 1 }, 7, now), null);
    assert.equal(parseHandoff({ u: 7, mode: "public", files: [], macro: null, at: now + 3_600_000 }, 7, now), null);
    assert.equal(parseHandoff({ u: 7, mode: "solve", files: [], macro: null, at: now }, 7, now), null);
    assert.equal(parseHandoff("nonsense", 7, now), null);
  });

  test("the storage wrappers keep quiet where there is no storage, or it refuses", () => {
    const g = globalThis as unknown as { window?: unknown };
    assert.equal(g.window, undefined);
    assert.equal(readHandoff(1, 1), null);
    assert.doesNotThrow(() => writeHandoff(1, 1, { mode: "public", files: [], macro: null, send_id: null }));
    assert.equal(aliveAge(1, 1), null);
    assert.equal(pruneDeskStorage(null), 0);
    g.window = {
      get localStorage(): Storage {
        throw new Error("SecurityError");
      },
    };
    try {
      assert.doesNotThrow(() => writeHandoff(1, 1, { mode: "public", files: [], macro: null, send_id: null }));
      assert.doesNotThrow(() => stampAlive(1, 1, "a".repeat(32)));
      assert.doesNotThrow(() => clearHandoff(1, 1));
      assert.doesNotThrow(() => writeDraft(1, 1, "public", "x"));
      assert.equal(readDraft(1, 1, "public"), "");
      assert.equal(readHandoff(1, 1), null);
      assert.equal(aliveAge(1, 1), null);
      assert.equal(pruneDeskStorage(1), 0);
    } finally {
      delete g.window;
    }
  });

  test("keys carry the agent: another agent's and pre-1.20.18 keys are pruned; an expired record is deleted when found", () => {
    const g = globalThis as unknown as { window?: unknown };
    const mem = memoryWindow();
    g.window = mem.window;
    try {
      writeDraft(42, 7, "public", "Mine");
      writeDraft(43, 7, "public", "Someone else's");
      writeHandoff(42, 7, { mode: "internal", files: [{ id: 8, name: "a.pdf", size: 10, type: "application/pdf" }], macro: null, send_id: null });
      writeHandoff(43, 7, { mode: "public", files: [], macro: null, send_id: null });
      mem.map.set("compass-desk-draft:7:public", "a 1.20.16 draft that names no one");
      mem.map.set("compass-theme", "dark");
      assert.equal(deskKeyOwner("compass-desk-draft:42:7:public"), 42);
      assert.equal(deskKeyOwner("compass-desk-draft:7:public"), null);
      // Agent 43's record under agent 42's key is still refused.
      mem.map.set("compass-desk-reply-state:42:9", JSON.stringify({ u: 43, mode: "public", files: [], macro: null, at: Date.now() }));
      assert.equal(readHandoff(42, 9), null);
      assert.equal(mem.map.has("compass-desk-reply-state:42:9"), false, "a refused record is deleted as it is found");
      assert.equal(readHandoff(42, 7)?.mode, "internal");
      assert.equal(readHandoff(43, 7)?.mode, "public");
      assert.equal(pruneDeskStorage(42), 3);
      assert.deepEqual([...mem.map.keys()].sort(), ["compass-desk-draft:42:7:public", "compass-desk-reply-state:42:7", "compass-theme"]);
      // Sign-out: every desk key goes; the theme (a per-viewer convenience) stays.
      forgetDeskOnSignOut();
      assert.deepEqual([...mem.map.keys()], ["compass-theme"]);
      // An expired record is deleted when read.
      mem.map.set("compass-desk-reply-state:42:7", JSON.stringify({ u: 42, mode: "public", files: [], macro: null, at: Date.now() - HANDOFF_MAX_AGE_MS - 5 }));
      assert.equal(readHandoff(42, 7), null);
      assert.equal(mem.map.has("compass-desk-reply-state:42:7"), false);
    } finally {
      delete g.window;
    }
  });

  test("upgrade: 1.20.16 drafts are adopted once by the agent who opens the desk; their own drafts win", () => {
    const g = globalThis as unknown as { window?: unknown };
    const mem = memoryWindow();
    g.window = mem.window;
    try {
      mem.map.set("compass-desk-draft:7:public", "Half-written reply from before the upgrade");
      mem.map.set("compass-desk-draft:7:internal", "An old note");
      mem.map.set("compass-desk-draft:9:public", "Old text for 9");
      mem.map.set("compass-desk-draft:12:internal", "");
      writeDraft(42, 9, "public", "Agent 42's own, newer text for 9");
      mem.map.set("compass-theme", "dark");
      assert.equal(adoptLegacyDrafts(42), 2);
      assert.equal(readDraft(42, 7, "public"), "Half-written reply from before the upgrade");
      assert.equal(readDraft(42, 7, "internal"), "An old note");
      assert.equal(readDraft(42, 9, "public"), "Agent 42's own, newer text for 9", "an existing scoped draft is never overwritten");
      assert.equal([...mem.map.keys()].some((k) => /^compass-desk-draft:\d+:(public|internal)$/.test(k)), false, "every unscoped key is gone");
      // One time per browser: a later unscoped key (an old tab still open) is not adopted by the next agent.
      mem.map.set("compass-desk-draft:7:public", "Written by a 1.20.16 tab later");
      assert.equal(adoptLegacyDrafts(43), 0);
      assert.equal(readDraft(43, 7, "public"), "");
      // The desk's load order: adopt, then prune; the later unscoped key goes with the prune.
      pruneDeskStorage(43);
      assert.equal(mem.map.has("compass-desk-draft:7:public"), false);
      // Sign-out clears desk keys but not the one-time mark.
      forgetDeskOnSignOut();
      assert.deepEqual([...mem.map.keys()].sort(), ["compass-drafts-adopted-1.20.18", "compass-theme"]);
    } finally {
      delete g.window;
    }
  });

  test("ownership: a pop-out owns the reply until its token is taken; the sending marker", () => {
    const g = globalThis as unknown as { window?: unknown };
    const mem = memoryWindow();
    g.window = mem.window;
    try {
      const a = newOwnerToken();
      const b = newOwnerToken();
      assert.match(a, /^[a-f0-9]{32}$/);
      assert.notEqual(a, b);
      assert.match(newSendId(), /^[a-f0-9]{32}$/);
      assert.equal(stillOwner(42, 7, a), true, "no heartbeat yet: nobody else has it");
      stampAlive(42, 7, a);
      assert.equal(readAlive(42, 7)?.token, a);
      assert.equal(readAlive(43, 7), null, "another agent sees no heartbeat");
      assert.equal(stillOwner(42, 7, a), true);
      assert.equal(stillOwner(42, 7, b), false, "a second pop-out does not own it");
      // The pane takes it back: the token is recorded first.
      markTaken(42, 7, a);
      assert.equal(wasTaken(42, 7, a), true);
      assert.equal(stillOwner(42, 7, a), false);
      clearAlive(42, 7, b);
      assert.equal(readAlive(42, 7)?.token, a, "only the holder's token clears its heartbeat");
      clearAlive(42, 7, a);
      assert.equal(readAlive(42, 7), null);
      // A new pop-out, a new token: it owns the reply.
      stampAlive(42, 7, b);
      assert.equal(stillOwner(42, 7, b), true);
      // Closed mid-send.
      markSending(42, 7, "internal");
      assert.deepEqual(readSending(42, 7), { mode: "internal" });
      assert.equal(readSending(43, 7), null);
      mem.map.set("compass-desk-reply-sending:42:7", JSON.stringify({ u: 42, mode: "public", at: Date.now() - 11 * 60_000 }));
      assert.equal(readSending(42, 7), null, "an old marker is ignored and deleted");
      assert.equal(mem.map.has("compass-desk-reply-sending:42:7"), false);
    } finally {
      delete g.window;
    }
  });
});

/** A stand-in window with a working localStorage (and no BroadcastChannel). */
function memoryWindow() {
  const map = new Map<string, string>();
  const localStorage = {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  return { map, window: { localStorage } };
}

describe("the pop-out's address", () => {
  test("the ticket number only; one window name per ticket; sized like a compose window", () => {
    assert.equal(popoutPath(1047), "/desk/tickets/1047/reply");
    assert.equal(popoutWindowName(1047), "compass-reply-1047");
    assert.notEqual(popoutWindowName(1047), popoutWindowName(1048));
    const f = popoutFeatures({ x: 100, y: 50, width: 1440, height: 900 });
    assert.match(f, /^popup=yes,width=720,height=780,left=\d+,top=\d+$/);
    assert.equal(f.includes("noopener"), false, "the desk keeps the window so it can bring it forward");
    assert.deepEqual(POPOUT_SIZE, { width: 720, height: 780 });
  });

  test("the shell's bare page is this path and nothing else", () => {
    for (const p of ["/desk/tickets/1/reply", "/desk/tickets/1047/reply", "/desk/tickets/1047/reply/"]) assert.equal(isReplyPopoutPath(p), true, p);
    for (const p of ["/desk", "/desk/tickets/1047", "/desk/tickets/0/reply", "/desk/tickets/abc/reply", "/desk/tickets/12/reply/x", "/desk/settings/reply", "/x/desk/tickets/1/reply", "", null, undefined]) {
      assert.equal(isReplyPopoutPath(p as string), false, String(p));
    }
  });

  test("the Duo desk rule covers it, as every desk page", () => {
    assert.equal(duoPolicy.isDeskPath("/desk/tickets/1047/reply"), true);
  });
});

// --- What the pop-out calls --------------------------------------------------------------

describe("the routes the pop-out uses", () => {
  test("a fresh load: the team's agent works it; another team's agent and the requester are refused", async () => {
    const t = await raise(A, `${STAMP} load`);
    const ok = await load(P.sam, t.number);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.can_work, true);
    assert.equal(ok.body.ticket.number, t.number);
    assert.equal((await load(P.other, t.number)).status, 404, "another team's ticket reads as missing");
    assert.equal((await load(P.req, t.number)).status, 403, "a requester has no desk");
  });

  test("a reply and a note from the team's agent; nothing from another team's", async () => {
    const t = await raise(A, `${STAMP} send`);
    const before = await countMessages(t.id);
    const refused = await post(P.other, t.number, { kind: "public", body: "Not my team." });
    assert.equal(refused.status, 404);
    assert.equal((await post(P.other, t.number, { kind: "internal", body: "Nor this." })).status, 404);
    assert.equal(await countMessages(t.id), before, "nothing was posted");
    assert.equal((await post(P.sam, t.number, { kind: "internal", body: "Checking the share permissions." })).status, 201);
    assert.equal((await post(P.sam, t.number, { kind: "public", body: "Write access is back." })).status, 201);
  });

  test("send and set Solved, as the pop-out's split button sends it", async () => {
    const t = await raise(A, `${STAMP} solve`);
    const r = await post(P.sam, t.number, { kind: "public", body: "Fixed: the group has write access again.", then_status: "solved", expect_last_message_id: await lastId(t.id) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await tickets.getTicketById(t.id))?.status, "solved");
  });

  test("the send guard: a reply that landed while composing answers 409 { newer }, and nothing is posted", async () => {
    const t = await raise(A, `${STAMP} guard`);
    const start = await lastId(t.id);
    assert.equal((await post(P.ana, t.number, { kind: "public", body: "I've reset the permissions.", expect_last_message_id: start })).status, 201);
    const before = await countMessages(t.id);
    const r = await post(P.sam, t.number, { kind: "public", body: "Could you send a screenshot?", expect_last_message_id: start });
    assert.equal(r.status, 409);
    assert.equal(r.body.newer[0].author_name, "Ana Kowalski");
    assert.equal(await countMessages(t.id), before);
  });
});

// --- The page ------------------------------------------------------------------------------

describe("the send's idempotency key and the agent check (security review)", () => {
  const KEY = () => newSendId();

  test("the same client_send_id twice posts one message; the repeat answers 200 with the first", async () => {
    const t = await raise(A, `${STAMP} once`);
    const key = KEY();
    const before = await countMessages(t.id);
    const first = await post(P.sam, t.number, { kind: "public", body: "Write access is back.", client_send_id: key, expect_last_message_id: await lastId(t.id) });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    // The pop-out closed mid-send; the desk sends the same reply again with the same key (and a stale expectation).
    const again = await post(P.sam, t.number, { kind: "public", body: "Write access is back.", client_send_id: key, expect_last_message_id: 0 });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.message.id, first.body.message.id);
    // Even with other text: the key names that send, nothing is posted twice.
    const edited = await post(P.sam, t.number, { kind: "public", body: "Write access is back (edited).", client_send_id: key });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.message.id, first.body.message.id);
    assert.equal(await countMessages(t.id), before + 1);
    // A new key is a new message.
    assert.equal((await post(P.sam, t.number, { kind: "internal", body: "Told Daniel.", client_send_id: KEY() })).status, 201);
    assert.equal(await countMessages(t.id), before + 2);
  });

  test("two requests racing with one key post once", async () => {
    const t = await raise(A, `${STAMP} race`);
    const key = KEY();
    const before = await countMessages(t.id);
    const [a, b] = await Promise.all([
      post(P.sam, t.number, { kind: "public", body: "Racing reply.", client_send_id: key }),
      post(P.sam, t.number, { kind: "public", body: "Racing reply.", client_send_id: key }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.ok(statuses[0] === 200 || statuses[0] === 201, JSON.stringify(statuses));
    assert.ok(statuses.includes(201), JSON.stringify([a.body, b.body]));
    const other = a.status === 201 ? b : a;
    assert.ok(other.status === 200 ? other.body.duplicate === true : other.body.code === "send_in_progress", JSON.stringify(other.body));
    assert.equal(await countMessages(t.id), before + 1);
  });

  test("a key whose send posted nothing (a collision warning, a refusal) may be used again", async () => {
    const t = await raise(A, `${STAMP} reuse`);
    const start = await lastId(t.id);
    assert.equal((await post(P.ana, t.number, { kind: "public", body: "I've reset the permissions." })).status, 201);
    const key = KEY();
    const warned = await post(P.sam, t.number, { kind: "public", body: "Could you send a screenshot?", client_send_id: key, expect_last_message_id: start });
    assert.equal(warned.status, 409);
    assert.ok(Array.isArray(warned.body.newer));
    const rows = await pool().query("SELECT 1 FROM hd_message_send_ids WHERE user_id = $1 AND client_send_id = $2", [P.sam.id, key]);
    assert.equal(rows.rowCount, 0, "the claim was let go");
    const sent = await post(P.sam, t.number, { kind: "public", body: "Could you send a screenshot?", client_send_id: key, expect_last_message_id: start, force: true });
    assert.equal(sent.status, 201);
  });

  test("keys are per agent and per ticket; a malformed key is refused", async () => {
    const t = await raise(A, `${STAMP} per-agent`);
    const u = await raise(A, `${STAMP} per-ticket`);
    const key = KEY();
    assert.equal((await post(P.sam, t.number, { kind: "internal", body: "Sam's note.", client_send_id: key })).status, 201);
    assert.equal((await post(P.ana, t.number, { kind: "internal", body: "Ana's note.", client_send_id: key })).status, 201, "another agent's send is its own");
    assert.equal((await post(P.sam, u.number, { kind: "internal", body: "On the other ticket.", client_send_id: key })).status, 201, "another ticket's send is its own");
    for (const bad of ["short", "has spaces in it here", "x".repeat(65), 12345678901234567, { id: 1 }]) {
      const r = await post(P.sam, t.number, { kind: "internal", body: "Bad key.", client_send_id: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    // Another team's agent learns nothing from a key: the ticket is missing to them.
    assert.equal((await post(P.other, t.number, { kind: "internal", body: "Not mine.", client_send_id: key })).status, 404);
  });

  test("a day-old key is forgotten by the sweep; a stuck claim may be claimed again after two minutes", async () => {
    const t = await raise(A, `${STAMP} sweep`);
    const old = KEY();
    const stuck = KEY();
    assert.equal((await post(P.sam, t.number, { kind: "internal", body: "Old.", client_send_id: old })).status, 201);
    await pool().query("UPDATE hd_message_send_ids SET created_at = now() - interval '25 hours' WHERE client_send_id = $1", [old]);
    await pool().query("INSERT INTO hd_message_send_ids (user_id, ticket_id, client_send_id, created_at) VALUES ($1, $2, $3, now() - interval '3 minutes')", [P.sam.id, t.id, stuck]);
    const sendOnce = require("../src/lib/helpdesk/send-once") as typeof import("../src/lib/helpdesk/send-once"); // eslint-disable-line @typescript-eslint/no-require-imports
    assert.ok((await sendOnce.sweepSendIds(new Date())) >= 1);
    assert.equal((await pool().query("SELECT 1 FROM hd_message_send_ids WHERE client_send_id = $1", [old])).rowCount, 0);
    assert.equal((await post(P.sam, t.number, { kind: "internal", body: "Stuck claim, sent now.", client_send_id: stuck })).status, 201);
  });

  test("expect_user_id: a page loaded for one agent never sends as whoever is signed in now", async () => {
    const t = await raise(A, `${STAMP} other-user`);
    const before = await countMessages(t.id);
    // The pop-out was opened by Ana; Sam has signed in to the same browser since.
    const r = await post(P.sam, t.number, { kind: "public", body: "Ana's reply, Sam's cookie.", expect_user_id: P.ana.id, client_send_id: KEY() });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "other_user");
    assert.equal(await countMessages(t.id), before, "nothing was posted");
    assert.equal((await post(P.sam, t.number, { kind: "public", body: "Sam's own reply.", expect_user_id: P.sam.id })).status, 201);
  });
});

describe("the page", () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const page = require("../src/app/(desk)/desk/tickets/[number]/reply/page") as typeof import("../src/app/(desk)/desk/tickets/[number]/reply/page");
  const { ReplyPopout } = require("../src/components/helpdesk/desk/popout/ReplyPopout") as typeof import("../src/components/helpdesk/desk/popout/ReplyPopout");
  /* eslint-enable @typescript-eslint/no-require-imports */

  async function render(who: Person | null, raw: string): Promise<{ type?: unknown; props?: { number?: number } } | { thrown: string }> {
    currentRequest = new Request(`http://localhost/desk/tickets/${raw}/reply`, { headers: who ? { cookie: `compass_session=${who.session}`, "x-compass-path": `/desk/tickets/${raw}/reply` } : {} });
    try {
      return (await page.default({ params: Promise.resolve({ number: raw }) })) as { type?: unknown; props?: { number?: number } };
    } catch (e) {
      return { thrown: String((e as { digest?: string }).digest ?? (e as Error).message) };
    } finally {
      currentRequest = null;
    }
  }

  test("a bad number is a 404; an agent gets the pop-out for that ticket", async () => {
    for (const raw of ["0", "-4", "12.5", "1e3", "abc", "012"]) {
      const r = await render(P.sam, raw);
      assert.ok("thrown" in r && /404|NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND/.test(r.thrown), `${raw}: ${JSON.stringify(r)}`);
    }
    const r = await render(P.sam, "1047");
    assert.ok(!("thrown" in r), JSON.stringify(r));
    assert.equal(r.type, ReplyPopout);
    assert.equal(r.props?.number, 1047);
  });

  test("signed out goes to sign-in; a desk person with no queue gets a refusal, never the composer", async () => {
    const out = await render(null, "1047");
    assert.ok("thrown" in out && /NEXT_REDIRECT/.test(out.thrown), JSON.stringify(out));
    // The requester holds helpdesk.request only (the layout shows "not for you" first; the page refuses as well).
    const r = await render(P.req, "1047");
    assert.ok(!("thrown" in r));
    assert.notEqual(r.type, ReplyPopout);
    assert.match(JSON.stringify(r, (_k, v) => (typeof v === "function" ? undefined : v)), /Replies are for helpdesk agents/);
  });
});
