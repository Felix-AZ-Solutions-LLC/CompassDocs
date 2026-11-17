// Helpdesk 1.20.19 live queue updates.
//
//   trigger    every insert, update and delete on hd_tickets notifies
//              'hd_queue_live' with only the team and owner before and
//              after; the schema creates it once, behind pg_trigger
//   stream     GET /api/helpdesk/live says hello, then `changed` within a
//              couple of seconds of a change in the agent's scope (their
//              teams, the tickets they own) and never for one outside it;
//              a burst is folded; frames carry no ticket and stay tiny;
//              Last-Event-ID / ?since= replay a missed change
//   long poll  ?wait= answers changed / not changed the same way
//   scope      a scope change (left the team, off the desk) applies at the
//              next refresh; agent_all hears everything
//   gate       401 without a session, 402 without the licence, 403 for a
//              requester; 429 past 6 streams or 30 connections a minute
//   listener   a dropped LISTEN reconnects and every stream reloads
//   counts     the counts API agrees: another team's ticket changes nothing
//
// Parallel-safe: every account, team and ticket is this file's own (STAMP).
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-live-queue.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { Client } from "pg";
import { pool, getSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-live.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-live.virtual.js");
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
  ee.exports = {
    ee: () => edition,
    eePresent: () => true,
    featureEnabled: async (feature: string) => edition.features.includes(feature), featureEnforced: async (feature: string) => edition.features.includes(feature),
    featureEnabledFrom: (feature: string) => edition.features.includes(feature), featureEnforcedFrom: (feature: string) => edition.features.includes(feature),
  };
  require.cache[EE_STUB] = ee;

  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) {
      return EE_STUB;
    }
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const notify = require("../src/lib/helpdesk/notify") as typeof import("../src/lib/helpdesk/notify");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const live = require("../src/lib/helpdesk/live") as typeof import("../src/lib/helpdesk/live");
const shared = require("../src/lib/helpdesk/live-shared") as typeof import("../src/lib/helpdesk/live-shared");
const { HD_LIVE_SCHEMA } = require("../src/lib/helpdesk/live-schema") as typeof import("../src/lib/helpdesk/live-schema");
const liveRoute = require("../src/app/api/helpdesk/live/route") as typeof import("../src/app/api/helpdesk/live/route");
const countsRoute = require("../src/app/api/helpdesk/counts/route") as typeof import("../src/app/api/helpdesk/counts/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdTicket } from "../src/lib/helpdesk/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const URL_BASE = "http://localhost/api/helpdesk";

function req(url: string, session: string | null, opts: { signal?: AbortSignal; headers?: Record<string, string> } = {}): Request {
  return new Request(`${URL_BASE}${url}`, {
    headers: { ...(session ? { cookie: `compass_session=${session}` } : {}), ...(opts.headers ?? {}) },
    signal: opts.signal,
  });
}

async function callGet(handler: (r: Request) => Promise<Response>, r: Request): Promise<Response> {
  currentRequest = r;
  try {
    return await handler(r);
  } finally {
    currentRequest = null;
  }
}

/** An open stream: its frames as they arrive. */
class Tap {
  buf = "";
  closed = false;
  private abort = new AbortController();
  res!: Response;
  static async open(who: Person, opts: { since?: string; lastEventId?: string } = {}): Promise<Tap> {
    const t = new Tap();
    const q = opts.since ? `?since=${encodeURIComponent(opts.since)}` : "";
    t.res = await callGet(liveRoute.GET, req(`/live${q}`, who.session, { signal: t.abort.signal, headers: opts.lastEventId ? { "last-event-id": opts.lastEventId } : {} }));
    if (t.res.status === 200) t.pump();
    taps.push(t);
    return t;
  }
  private pump() {
    const reader = this.res.body!.getReader();
    const dec = new TextDecoder();
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) {
          this.closed = true;
          return;
        }
        this.buf += dec.decode(value, { stream: true });
      }
    })();
  }
  frames(): { event: string; id: string; data: string; raw: string }[] {
    return this.buf
      .split("\n\n")
      .filter((f) => f.trim() && !f.startsWith(":"))
      .map((raw) => {
        const get = (k: string) => raw.split("\n").find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2) ?? "";
        return { event: get("event"), id: get("id"), data: get("data"), raw };
      });
  }
  changed() {
    return this.frames().filter((f) => f.event === "changed");
  }
  async until(pred: () => boolean, ms: number): Promise<number> {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) return -1;
      await sleep(25);
    }
    return Date.now() - t0;
  }
  close() {
    this.abort.abort();
  }
}
const taps: Tap[] = [];

// --- Fixtures ----------------------------------------------------------------------

const STAMP = `hdlive-${Date.now()}-${process.pid}`;
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
let B = 0;
/** A team nobody is in: the trigger tests' own. */
let C = 0;
/**
 * Quinn's only team, which holds no ticket until a test raises one there.
 * Other files' sweeps legitimately change every open ticket in the database
 * (a default calendar or SLA target change retimes them all), and those are
 * real changes in the scope of whoever's queue holds them; an empty team is
 * the only scope that is quiet for certain (the CI failure of 1.20.19).
 */
let D = 0;

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

async function raise(teamId: number, subject: string, extra: Record<string, unknown> = {}): Promise<HdTicket> {
  const t = await tickets.createTicket(
    {
      subject,
      body: "The second floor printer jams on every duplex job.",
      requester: { id: P.req.id, name: P.req.name, email: P.req.email },
      team_id: teamId,
      answers: {} as never,
      ...extra,
    } as never,
    { silent: true, actorId: P.req.id, actorName: P.req.name }
  );
  ticketIds.push(t.id);
  return (await tickets.getTicketById(t.id))!;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  await pool().query(roles.HD_ROLES_SCHEMA);
  for (const [k, n] of [
    ["req", "Daniel Okafor"],
    ["sam", "Sam Lee"],
    ["ana", "Ana Kowalski"],
    ["other", "Otto Other"],
    ["boss", "Bea Manager"],
    ["many", "Max Tabs"],
    ["rate", "Rita Reload"],
    ["gone", "Gil Leaving"],
    ["par", "Pat Parallel"],
    ["rev", "Rosa Revoked"],
    ["dis", "Dirk Disabled"],
    ["quiet", "Quinn Quiet"],
  ] as const) {
    await person(k, n);
  }
  const role = await fixtureQuery("INSERT INTO roles (key, name) VALUES ($1, $1) RETURNING id", [`${STAMP}-request`]);
  roleIds.push(role.rows[0].id);
  await fixtureQuery("INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'helpdesk.request')", [role.rows[0].id]);
  for (const id of personIds) await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [role.rows[0].id, id]);
  for (const [k, r] of [["sam", "agent"], ["ana", "agent"], ["other", "agent"], ["boss", "manager"], ["many", "agent"], ["rate", "agent"], ["gone", "agent"], ["par", "agent"], ["rev", "agent"], ["dis", "agent"], ["quiet", "agent"]] as const) {
    await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [P[k].id, r]);
  }
  A = await team("IT", [["sam", "agent"], ["ana", "agent"], ["many", "agent"], ["rate", "agent"], ["gone", "agent"], ["par", "agent"], ["rev", "agent"], ["dis", "agent"]]);
  B = await team("Facilities", [["other", "agent"]]);
  C = await team("Quiet", []);
  D = await team("Night shift", [["quiet", "agent"]]);
  notify.setAgentDeliverySpyForTests(() => {});
  email.setHelpdeskTransportForTests(async () => {});
});

after(async () => {
  for (const t of taps) t.close();
  await sleep(50);
  await live.stopLiveForTests();
  notify.setAgentDeliverySpyForTests(null);
  email.setHelpdeskTransportForTests(null);
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

// --- Pure parts ----------------------------------------------------------------------

describe("payloads, scope and the gap", () => {
  test("a payload names teams and owners only; anything malformed is dropped", () => {
    assert.deepEqual(shared.parseLivePayload(",,4,"), { teams: [4], users: [] });
    assert.deepEqual(shared.parseLivePayload("4,9,5,9"), { teams: [4, 5], users: [9] });
    assert.deepEqual(shared.parseLivePayload("4,,,"), { teams: [4], users: [] });
    assert.equal(shared.parseLivePayload("4,9,5"), null);
    assert.equal(shared.parseLivePayload("x,,,"), null);
    assert.equal(shared.parseLivePayload("1;DROP,,,"), null);
  });

  test("a change concerns the agent's teams, what they own, or everyone with agent_all", () => {
    const sam = { teams: new Set([1, 2]), userId: 7 };
    assert.equal(shared.liveConcerns({ teams: [2], users: [] }, sam), true);
    assert.equal(shared.liveConcerns({ teams: [3], users: [] }, sam), false);
    assert.equal(shared.liveConcerns({ teams: [3], users: [7] }, sam), true);
    assert.equal(shared.liveConcerns({ teams: [], users: [] }, sam), false);
    assert.equal(shared.liveConcerns({ teams: [], users: [], all: true }, sam), true);
    assert.equal(shared.liveConcerns({ teams: [3], users: [] }, { teams: "all", userId: 1 }), true);
  });

  test("the gap between two signals grows with the open streams and is capped", () => {
    assert.equal(shared.liveGapMs(1), 1_500);
    assert.equal(shared.liveGapMs(100), 2_000);
    assert.equal(shared.liveGapMs(500), 10_000);
    assert.equal(shared.liveGapMs(50_000), 15_000);
  });
});

// --- The trigger ---------------------------------------------------------------------

describe("trigger", () => {
  test("the schema creates the three triggers once, behind pg_trigger lookups, and drops the pre-release one", async () => {
    for (const name of ["hd_tickets_live_insert", "hd_tickets_live_update", "hd_tickets_live_delete"]) {
      assert.match(HD_LIVE_SCHEMA, new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM pg_trigger[^;]*?'${name}'\\) THEN\\s+CREATE TRIGGER ${name}`));
    }
    const r = await pool().query("SELECT tgname FROM pg_trigger WHERE tgrelid = 'hd_tickets'::regclass AND tgname LIKE 'hd_tickets_%live%' ORDER BY 1");
    assert.deepEqual(r.rows.map((x) => x.tgname), ["hd_tickets_live_delete", "hd_tickets_live_insert", "hd_tickets_live_update"]);
    // A second run changes nothing and takes no lock on hd_tickets.
    await pool().query(HD_LIVE_SCHEMA);
  });

  test("insert, update and delete each notify with the team and owner only", async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const got: string[] = [];
    c.on("notification", (n) => n.channel === "hd_queue_live" && got.push(n.payload ?? ""));
    await c.query("LISTEN hd_queue_live");
    try {
      const t = await raise(A, `${STAMP} trigger`);
      await pool().query("UPDATE hd_tickets SET assignee_id = $2 WHERE id = $1", [t.id, P.sam.id]);
      await pool().query("UPDATE hd_tickets SET team_id = $2 WHERE id = $1", [t.id, B]);
      const extra = await raise(A, `${STAMP} trigger delete`);
      await pool().query("DELETE FROM hd_tickets WHERE id = $1", [extra.id]);
      await sleep(300);
      const mine = got.filter((p) => p.split(",").some((x) => [String(A), String(B), String(P.sam.id)].includes(x)));
      assert.ok(mine.includes(`,,${A},`), `insert: ${mine}`);
      assert.ok(mine.includes(`${A},,${A},${P.sam.id}`), `assign: ${mine}`);
      assert.ok(mine.includes(`${A},${P.sam.id},${B},${P.sam.id}`), `move: ${mine}`);
      assert.ok(mine.includes(`${A},,,`), `delete: ${mine}`);
      for (const p of got) assert.match(p, /^\d*,\d*,\d*,\d*$/, "only ids, never the subject or the number");
      // Back to IT, unassigned, for the tests below.
      await pool().query("UPDATE hd_tickets SET team_id = $2, assignee_id = NULL WHERE id = $1", [t.id, A]);
    } finally {
      await c.end();
    }
  });
});

// --- The stream ------------------------------------------------------------------------

describe("stream", () => {
  test("hello, then `changed` within two seconds of a change in the agent's team; none for another team", async () => {
    const sam = await Tap.open(P.sam);
    const other = await Tap.open(P.other);
    assert.equal(sam.res.status, 200);
    assert.match(sam.res.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.match(sam.res.headers.get("cache-control") ?? "", /no-transform/);
    assert.equal(sam.res.headers.get("x-accel-buffering"), "no");
    assert.ok((await sam.until(() => sam.frames().some((f) => f.event === "hello"), 3_000)) >= 0, "hello");
    assert.ok((await other.until(() => other.frames().some((f) => f.event === "hello"), 3_000)) >= 0, "hello");
    const hello = sam.frames().find((f) => f.event === "hello")!;
    assert.match(hello.id, /^[0-9a-z]+\.[0-9a-f]{8}$/);
    const retry = Number(/^retry: (\d+)\n/.exec(hello.raw)?.[1]);
    assert.ok(retry >= 2_000 && retry < 6_000, `retry ${retry} is 2-6 s`);
    assert.equal(hello.data, "{}", "the hello says nothing about the server");
    await sleep(1_700); // past any gap from earlier changes

    const t = await raise(A, `${STAMP} secret subject 4711`);
    const took = await sam.until(() => sam.changed().length > 0, 2_500);
    assert.ok(took >= 0 && took < 2_500, `sam heard it (${took} ms)`);
    await sleep(600);
    assert.equal(other.changed().length, 0, "another team's agent hears nothing");
    for (const f of [...sam.frames(), ...other.frames()]) {
      assert.ok(Buffer.byteLength(f.raw) < 120, `a frame is tiny: ${f.raw}`);
      assert.doesNotMatch(f.raw, /secret|4711|printer/);
      assert.doesNotMatch(f.raw, new RegExp(`\\b${t.number}\\b`));
    }
    const sig = sam.changed()[0];
    assert.equal(sig.data, "{}");
    assert.match(sig.id, /^[0-9a-z]+\.[0-9a-f]{8}$/);
    sam.close();
    other.close();
    await sam.until(() => sam.closed, 2_000);
    assert.ok(sam.closed, "aborting the request ends the stream");
  });

  test("a ticket in another team that the agent owns signals them, as the queue lists it", async () => {
    const sam = await Tap.open(P.sam);
    await sam.until(() => sam.frames().length > 0, 3_000);
    await sleep(1_700);
    const t = await raise(B, `${STAMP} owned elsewhere`);
    await sleep(400);
    const before = sam.changed().length;
    await pool().query("UPDATE hd_tickets SET assignee_id = $2 WHERE id = $1", [t.id, P.sam.id]);
    assert.ok((await sam.until(() => sam.changed().length > before, 2_500)) >= 0, "the owner hears it");
    const listed = await tickets.listTickets({ id: P.sam.id, role: "viewer" }, { view: "mine" });
    assert.ok(listed.rows.some((r) => r.id === t.id), "and the queue API lists it for them");
    sam.close();
  });

  test("a burst of changes is folded into one or two signals", async () => {
    const ana = await Tap.open(P.ana);
    await ana.until(() => ana.frames().length > 0, 3_000);
    await sleep(1_700);
    const t = await raise(A, `${STAMP} burst`);
    for (let i = 0; i < 10; i++) await pool().query("UPDATE hd_tickets SET updated_at = now() WHERE id = $1", [t.id]);
    await sleep(2_500);
    const n = ana.changed().length;
    assert.ok(n >= 1 && n <= 2, `11 changes, ${n} signals`);
    ana.close();
  });

  test("agent_all (a Manager) hears every team", async () => {
    const boss = await Tap.open(P.boss);
    await boss.until(() => boss.frames().length > 0, 3_000);
    await sleep(1_700);
    await raise(B, `${STAMP} for everyone`);
    assert.ok((await boss.until(() => boss.changed().length > 0, 2_500)) >= 0);
    boss.close();
  });

  test("Last-Event-ID or ?since= replays a missed change; an up-to-date cursor replays nothing", async () => {
    const cursor = live.liveCursor();
    await raise(A, `${STAMP} while away`);
    await sleep(300);
    const back = await Tap.open(P.sam, { lastEventId: cursor });
    assert.ok((await back.until(() => back.changed().length > 0, 2_500)) >= 0, "Last-Event-ID");
    back.close();
    const viaQuery = await Tap.open(P.ana, { since: cursor });
    assert.ok((await viaQuery.until(() => viaQuery.changed().length > 0, 2_500)) >= 0, "?since=");
    viaQuery.close();
    // Another team's agent with the same cursor missed nothing of theirs.
    const other = await Tap.open(P.other, { since: cursor });
    await other.until(() => other.frames().length > 0, 2_000);
    await sleep(2_000);
    assert.equal(other.changed().length, 0);
    other.close();
    // A cursor this process can't vouch for (malformed, or older than its listener) counts as missed: one extra reload, never a lost one.
    const foreign = await Tap.open(P.other, { since: "garbage" });
    assert.ok((await foreign.until(() => foreign.changed().length > 0, 2_500)) >= 0);
    foreign.close();
    // An up-to-date cursor replays nothing.
    const fresh = await Tap.open(P.sam, { since: live.liveCursor() });
    await fresh.until(() => fresh.frames().length > 0, 2_000);
    await sleep(2_000);
    assert.equal(fresh.changed().length, 0);
    fresh.close();
  });
});

// --- Long poll -------------------------------------------------------------------------

describe("long poll", () => {
  const poll = async (who: Person, q: string) => {
    const res = await callGet(liveRoute.GET, req(`/live?${q}`, who.session));
    return { status: res.status, body: (await res.json()) as { changed: boolean; cursor: string } };
  };

  test("no change: changed false after `wait`; a change in scope: true at once; another team's: false", async () => {
    const t0 = Date.now();
    const idle = await poll(P.sam, `wait=1&since=${live.liveCursor()}`);
    assert.equal(idle.status, 200);
    assert.equal(idle.body.changed, false);
    assert.ok(Date.now() - t0 >= 900);
    assert.deepEqual(Object.keys(idle.body).sort(), ["changed", "cursor"], "nothing about the server's streams");
    const cursor = idle.body.cursor;
    await raise(A, `${STAMP} poll`);
    await sleep(300);
    const hit = await poll(P.sam, `wait=5&since=${cursor}`);
    assert.equal(hit.body.changed, true);
    const miss = await poll(P.other, `wait=1&since=${cursor}`);
    assert.equal(miss.body.changed, false);
  });

  test("a change while waiting answers within about two seconds", async () => {
    const waiting = poll(P.ana, `wait=10&since=${live.liveCursor()}`);
    await sleep(300);
    const t0 = Date.now();
    await raise(A, `${STAMP} poll wait`);
    const r = await waiting;
    assert.equal(r.body.changed, true);
    assert.ok(Date.now() - t0 < 2_500, `${Date.now() - t0} ms`);
  });
});

// --- Scope changes ---------------------------------------------------------------------

describe("scope", () => {
  test("an agent who left the team stops hearing it at the next scope refresh", async () => {
    const gone = await Tap.open(P.gone);
    await gone.until(() => gone.frames().length > 0, 3_000);
    await pool().query("DELETE FROM hd_team_members WHERE team_id = $1 AND user_id = $2", [A, P.gone.id]);
    await live.rescopeLiveForTests();
    await sleep(1_700);
    await raise(A, `${STAMP} after leaving`);
    await sleep(2_200);
    assert.equal(gone.changed().length, 0);
    assert.equal(gone.closed, false, "still on the desk: the stream stays open");
    // Off the desk entirely: the stream ends.
    await pool().query("DELETE FROM hd_agent_roles WHERE user_id = $1", [P.gone.id]);
    await live.rescopeLiveForTests();
    assert.ok((await gone.until(() => gone.closed, 2_000)) >= 0, "the stream ended");
  });
});

// --- The gate and the limits -------------------------------------------------------------

describe("gate and limits", () => {
  test("401 without a session, 403 for a requester, 402 without the licence", async () => {
    assert.equal((await callGet(liveRoute.GET, req("/live?wait=1", null))).status, 401);
    assert.equal((await callGet(liveRoute.GET, req("/live?wait=1", P.req.session))).status, 403);
    assert.equal((await callGet(liveRoute.GET, req("/live", P.req.session))).status, 403);
    edition.features = [];
    try {
      const res = await callGet(liveRoute.GET, req("/live", P.sam.session));
      assert.equal(res.status, 402);
    } finally {
      edition.features = ["helpdesk"];
    }
  });

  test("six streams a person; the seventh is refused with 429", async () => {
    const open: Tap[] = [];
    for (let i = 0; i < 6; i++) open.push(await Tap.open(P.many));
    for (const t of open) assert.equal(t.res.status, 200);
    await Promise.all(open.map((t) => t.until(() => t.frames().length > 0, 3_000)));
    const seventh = await Tap.open(P.many);
    assert.equal(seventh.res.status, 429);
    open[0].close();
    await open[0].until(() => open[0].closed, 2_000);
    await sleep(50);
    const again = await Tap.open(P.many);
    assert.equal(again.res.status, 200, "a closed tab frees its place");
    for (const t of [...open, again]) t.close();
  });

  test("thirty connections a minute a person; then 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await callGet(liveRoute.GET, req(`/live?wait=1&since=${live.liveCursor()}`, P.rate.session, { signal: AbortSignal.timeout(50) }));
      statuses.push(res.status);
    }
    assert.ok(statuses.slice(0, 30).every((s) => s === 200), statuses.join(","));
    assert.equal(statuses[30], 429);
  });
});

// --- The listener ------------------------------------------------------------------------

describe("listener", () => {
  test("a dropped LISTEN reconnects and every stream is told to reload", async () => {
    const other = await Tap.open(P.other);
    await other.until(() => other.frames().length > 0, 3_000);
    await sleep(1_700);
    await live.dropLiveListenerForTests();
    assert.ok((await other.until(() => other.changed().length > 0, 5_000)) >= 0, "reloaded after the reconnect");
    // And it hears changes again.
    await sleep(1_700);
    const n = other.changed().length;
    await raise(B, `${STAMP} after reconnect`);
    assert.ok((await other.until(() => other.changed().length > n, 2_500)) >= 0);
    other.close();
  });
});

// --- Review fixes (1.20.19 security and robustness review, probes R1-R5) ---------------------

/** Notifications on hd_queue_live naming `team`, heard on a client of our own. */
async function listenFor(team: number): Promise<{ got: string[]; end: () => Promise<void> }> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const got: string[] = [];
  c.on("notification", (n) => n.channel === "hd_queue_live" && (n.payload ?? "").split(",").includes(String(team)) && got.push(n.payload ?? ""));
  await c.query("LISTEN hd_queue_live");
  return { got, end: () => c.end() };
}

describe("review fixes", () => {
  test("R1: cursors are time, not counts; another team's activity moves nothing an agent can see", async () => {
    // The listener is up and stays up for the whole probe (a reconnect rightly answers "changed": it can't vouch for the gap).
    assert.equal(await live.ensureListening(), true);
    const upSince = live.liveStateForTests().upSince;
    const first = await callGet(liveRoute.GET, req(`/live?wait=1`, P.quiet.session));
    const c0 = ((await first.json()) as { cursor: string }).cursor;
    const parsed = shared.parseLiveCursor(c0)!;
    assert.ok(Math.abs(parsed.ms - Date.now()) < 3_000, "the cursor is the server's clock");
    // Fifty writes in a team Quinn isn't in.
    const t = await raise(B, `${STAMP} secret facilities ticket`);
    for (let i = 0; i < 49; i++) await pool().query("UPDATE hd_tickets SET updated_at = now() WHERE id = $1", [t.id]);
    await sleep(300);
    const after = await callGet(liveRoute.GET, req(`/live?wait=1&since=${c0}`, P.quiet.session));
    const d1 = (await after.json()) as { changed: boolean; cursor: string };
    assert.equal(live.liveStateForTests().upSince, upSince, "the listener did not reconnect during the probe");
    const inScope = live.liveRingForTests().filter((e) => e.at > parsed.ms && shared.liveConcerns(e, { teams: new Set([D]), userId: P.quiet.id }));
    assert.equal(d1.changed, false, `the catch-up answer depends only on Quinn's scope (in scope since: ${JSON.stringify(inScope)})`);
    // Two cursors around twenty more out-of-scope writes differ only by the time they took.
    const a = shared.parseLiveCursor(live.liveCursor())!.ms;
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) await pool().query("UPDATE hd_tickets SET updated_at = now() WHERE id = $1", [t.id]);
    const b = shared.parseLiveCursor(live.liveCursor())!.ms;
    assert.ok(b - a >= 0 && b - a <= Date.now() - t0 + 1, `${b - a} ms between cursors`);
    // And a stream's hello carries the same kind of cursor.
    const q = await Tap.open(P.quiet);
    await q.until(() => q.frames().length > 0, 3_000);
    assert.ok(Math.abs(shared.parseLiveCursor(q.frames()[0].id)!.ms - Date.now()) < 3_000);
    q.close();
  });

  test("multi-process: a cursor from another process answers from time with a 2 s margin, not 'always changed'", async () => {
    const otherBoot = "0a0b0c0d";
    assert.equal(await live.ensureListening(), true);
    const upSince = live.liveStateForTests().upSince;
    assert.ok(Date.now() - upSince > 2 * shared.LIVE_LIMITS.skewMs, "the listener has been up longer than the cursors below reach back");
    // Handed out by another process just now; nothing in Quinn's scope, ever: no reload.
    const now = shared.formatLiveCursor(Date.now(), otherBoot);
    const quiet = await callGet(liveRoute.GET, req(`/live?wait=1&since=${now}`, P.quiet.session));
    assert.equal(((await quiet.json()) as { changed: boolean }).changed, false);
    // Even one from almost the whole margin ago (another process's clock a little behind).
    const behind = shared.formatLiveCursor(Date.now() - shared.LIVE_LIMITS.skewMs + 300, otherBoot);
    const still = await callGet(liveRoute.GET, req(`/live?wait=1&since=${behind}`, P.quiet.session));
    assert.equal(((await still.json()) as { changed: boolean }).changed, false);
    // A change in scope a moment before another process's cursor may not have reached it: counted.
    // (A stream of Quinn's proves the listener has heard it before the cursors below are taken.)
    const q = await Tap.open(P.quiet);
    await q.until(() => q.frames().length > 0, 3_000);
    await raise(D, `${STAMP} skew`);
    const raised = Date.now();
    assert.ok((await q.until(() => q.changed().length > 0, 5_000)) >= 0, "the listener heard the change");
    q.close();
    // Another process's cursor from half a second after the change: inside the margin, so counted.
    const skewed = shared.formatLiveCursor(raised + 500, otherBoot);
    const hit = await callGet(liveRoute.GET, req(`/live?wait=1&since=${skewed}`, P.quiet.session));
    assert.equal(((await hit.json()) as { changed: boolean }).changed, true);
    // The same cursor from this process (no margin) after the change: not counted.
    const mine = live.liveCursor();
    const own = await callGet(liveRoute.GET, req(`/live?wait=1&since=${mine}`, P.quiet.session));
    assert.equal(((await own.json()) as { changed: boolean }).changed, false);
    // Earlier than this process's listener: it can't vouch, so one reload.
    const ancient = shared.formatLiveCursor(1_000, otherBoot);
    const old = await callGet(liveRoute.GET, req(`/live?wait=1&since=${ancient}`, P.quiet.session));
    assert.equal(((await old.json()) as { changed: boolean }).changed, true);
    assert.equal(live.liveStateForTests().upSince, upSince, "the listener did not reconnect during the probe");
  });

  test("R1 and multi-process, with synthetic changes only: the answer is decided by the scope and the clock", async () => {
    // No database traffic at all decides this one: subscribers with made-up teams, changes published straight to the bus.
    const QUIET = 980_000_000 + (process.pid % 1000);
    const NOISY = QUIET + 1;
    live.setLiveScopeForTests(async () => ({ teams: [QUIET], agent: true }));
    try {
      assert.equal(await live.ensureListening(), true);
      const { sub, close } = await live.subscribeLive({ id: 2_100_000_000, role: "viewer" }, { signal: () => {}, end: () => {} });
      try {
        const boot = live.liveCursor().split(".")[1];
        const c0 = live.liveCursor();
        await sleep(5);
        for (let i = 0; i < 200; i++) live.publishLiveChange({ teams: [NOISY], users: [2_100_000_001] });
        assert.equal(live.changedSince(c0, sub), false, "200 changes elsewhere: not changed");
        const foreignNow = shared.formatLiveCursor(Date.now(), "0a0b0c0d");
        assert.equal(live.changedSince(foreignNow, sub), false, "another process's cursor: not 'always changed'");
        assert.equal(boot.length, 8);
        await sleep(5);
        const before = Date.now();
        live.publishLiveChange({ teams: [QUIET], users: [] });
        assert.equal(live.changedSince(c0, sub), true, "a change in scope after the cursor");
        assert.equal(live.changedSince(live.liveCursor(), sub), false, "this process's cursor after it: no margin, not changed");
        assert.equal(live.changedSince(shared.formatLiveCursor(before + 500, "0a0b0c0d"), sub), true, "another process's cursor within the margin after it: changed");
        assert.equal(live.changedSince(shared.formatLiveCursor(before + shared.LIVE_LIMITS.skewMs + 500, "0a0b0c0d"), sub), false, "past the margin: not changed");
        assert.equal(live.changedSince(shared.formatLiveCursor(1_000, "0a0b0c0d"), sub), true, "older than the listener: can't vouch");
        assert.equal(live.changedSince("not a cursor", sub), true);
      } finally {
        close();
      }
    } finally {
      live.setLiveScopeForTests(null);
    }
  });

  test("R2: twenty parallel connects by one person open exactly six", async () => {
    const before = live.liveStateForTests().reserved;
    const ts = await Promise.all(Array.from({ length: 20 }, () => Tap.open(P.par)));
    const statuses = ts.map((t) => t.res.status);
    assert.equal(statuses.filter((x) => x === 200).length, 6, statuses.join(","));
    assert.equal(statuses.filter((x) => x === 429).length, 14);
    for (const t of ts) t.close();
    await Promise.all(ts.filter((t) => t.res.status === 200).map((t) => t.until(() => t.closed, 2_000)));
    await sleep(100);
    assert.equal(live.liveStateForTests().reserved, before, "every place is given back");
  });

  test("R3: a revoked session or a disabled account ends the stream at the next refresh", async () => {
    const rev = await Tap.open(P.rev);
    const dis = await Tap.open(P.dis);
    const ok = await Tap.open(P.ana);
    await Promise.all([rev, dis, ok].map((t) => t.until(() => t.frames().length > 0, 3_000)));
    await pool().query("DELETE FROM sessions WHERE user_id = $1", [P.rev.id]);
    await pool().query("UPDATE users SET status = 'disabled' WHERE id = $1", [P.dis.id]);
    await live.rescopeLiveForTests();
    assert.ok((await rev.until(() => rev.closed, 2_000)) >= 0, "signed out: closed");
    assert.ok((await dis.until(() => dis.closed, 2_000)) >= 0, "disabled: closed");
    assert.equal(ok.closed, false, "a good session stays");
    ok.close();
    await pool().query("UPDATE users SET status = 'active' WHERE id = $1", [P.dis.id]);
  });

  test("R4: edits to a ticket in the recycle bin notify nothing", async () => {
    const tk = await raise(C, `${STAMP} binned`);
    const l = await listenFor(C);
    try {
      await pool().query("UPDATE hd_tickets SET deleted_at = now() WHERE id = $1", [tk.id]);
      await sleep(200);
      assert.equal(l.got.length, 1, "binning it is a change the queue shows");
      await pool().query("UPDATE hd_tickets SET subject = subject || '!', priority = 'high', updated_at = now() WHERE id = $1", [tk.id]);
      await pool().query("DELETE FROM hd_tickets WHERE id = $1", [tk.id]);
      await sleep(300);
      assert.equal(l.got.length, 1, "edits and the purge of a binned ticket are silent");
    } finally {
      await l.end();
    }
  });

  test("R5: a no-op update, or one to a column no queue shows, notifies nothing; a queue column does", async () => {
    const tk = await raise(C, `${STAMP} noop`);
    const l = await listenFor(C);
    try {
      await pool().query("UPDATE hd_tickets SET subject = subject WHERE id = $1", [tk.id]);
      await pool().query("UPDATE hd_tickets SET csat_comment = 'thanks', sla_warned_at = now(), language = 'en' WHERE id = $1", [tk.id]);
      await sleep(300);
      assert.equal(l.got.length, 0, `${l.got}`);
      await pool().query("UPDATE hd_tickets SET priority = 'urgent' WHERE id = $1", [tk.id]);
      await sleep(300);
      assert.deepEqual(l.got, [`${C},,${C},`]);
    } finally {
      await l.end();
    }
  });

  test("the trigger is skipped, not waited on, while hd_tickets is busy (lock_timeout), and the setting is restored", async () => {
    const probe = `hd_live_probe_${process.pid}`;
    const doBlock = HD_LIVE_SCHEMA.slice(HD_LIVE_SCHEMA.indexOf("DO $$ BEGIN")).replace(/\bhd_tickets\b/g, probe);
    await pool().query(`CREATE TABLE ${probe} (LIKE hd_tickets)`);
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`LOCK TABLE ${probe} IN ROW EXCLUSIVE MODE`);
      const t0 = Date.now();
      const r = await pool().query(`${doBlock} SELECT current_setting('lock_timeout') AS lt`);
      const took = Date.now() - t0;
      const rows = (Array.isArray(r) ? r[r.length - 1] : r).rows;
      assert.ok(took < 5_000, `gave up after ${took} ms`);
      assert.equal(rows[0].lt, "0", "lock_timeout is back to what it was");
      const none = await pool().query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = $1::regclass", [probe]);
      assert.equal(none.rows[0].n, 0, "skipped while busy");
      await holder.query("COMMIT");
      await pool().query(doBlock);
      const made = await pool().query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = $1::regclass", [probe]);
      assert.equal(made.rows[0].n, 3, "created on the next run");
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
      await pool().query(`DROP TABLE IF EXISTS ${probe}`);
    }
  });

  test("the listener proves itself: a NOTIFY through the pool comes back", async () => {
    assert.equal(await live.selfCheckLiveForTests(), true);
    assert.equal(live.liveStateForTests().state, "up");
  });
});

// --- Counts agree ------------------------------------------------------------------------

describe("counts", () => {
  test("another team's new ticket changes none of the agent's counts; their own team's does", async () => {
    const counts = async (who: Person) => {
      const res = await callGet(countsRoute.GET as unknown as (r: Request) => Promise<Response>, req("/counts", who.session));
      assert.equal(res.status, 200);
      return (await res.json()) as { views: Record<string, number>; teams: { team_id: number; open: number }[] };
    };
    const before = await counts(P.other);
    await raise(A, `${STAMP} counts`);
    const after = await counts(P.other);
    assert.deepEqual(after.views, before.views);
    assert.deepEqual(after.teams, before.teams);
    assert.ok(!after.teams.some((t) => t.team_id === A), "no row for a team they aren't in");
    const samBefore = await counts(P.sam);
    await raise(A, `${STAMP} counts 2`);
    const samAfter = await counts(P.sam);
    assert.equal(samAfter.views.unassigned, samBefore.views.unassigned + 1);
    assert.equal(samAfter.views.open, samBefore.views.open + 1);
  });
});

// --- Fan-out, measured -----------------------------------------------------------------------

describe("fan-out", () => {
  test("simulated streams: signals are spread over the gap and capped by the process's bucket", async () => {
    const N = 400;
    const TEAM = 990_000_000 + (process.pid % 1000);
    live.setLiveScopeForTests(async () => ({ teams: [TEAM], agent: true }));
    const times: number[] = [];
    const subs: { close: () => void }[] = [];
    try {
      const teamsBefore = live.liveStateForTests().indexedTeams;
      for (let i = 0; i < N; i++) subs.push(await live.subscribeLive({ id: 2_000_000_000 + i, role: "viewer" }, { signal: () => times.push(Date.now()), end: () => {} }));
      assert.equal(live.liveStateForTests().indexedTeams, teamsBefore + 1, "indexed by team");
      // A change every 100 ms for 6 s, all in the team.
      const t0 = Date.now();
      while (Date.now() - t0 < 6_000) {
        live.publishLiveChange({ teams: [TEAM], users: [] });
        await sleep(100);
      }
      await sleep(2_000);
      const span = (Date.now() - t0) / 1000;
      const perSecond = new Map<number, number>();
      for (const t of times) perSecond.set(Math.floor((t - t0) / 1000), (perSecond.get(Math.floor((t - t0) / 1000)) ?? 0) + 1);
      const peak = Math.max(...perSecond.values());
      const rate = shared.LIVE_LIMITS.signalsPerSecond;
      console.log(`fan-out: ${N} streams, 60 changes in 6 s → ${times.length} signals in ${span.toFixed(1)} s, peak ${peak}/s, mean ${(times.length / span).toFixed(1)}/s (bucket ${rate}/s)`);
      assert.ok(peak <= rate * 2 + 2, `peak ${peak}/s within the bucket (${rate}/s plus its burst)`);
      assert.ok(times.length <= rate * span + rate + 2, `${times.length} signals: within the bucket (${rate}/s over ${span.toFixed(1)} s, plus its burst)`);
      // A listener reconnect ("everyone reload") is spread too, not one burst.
      times.length = 0;
      const t1 = Date.now();
      live.publishLiveChange({ teams: [], users: [], all: true });
      await sleep(4_000);
      const first = times.filter((t) => t - t1 < 1_000).length;
      console.log(`fan-out: "everyone reload" with ${N} streams: ${times.length} signals in 4 s, ${first} in the first second`);
      assert.ok(first <= rate * 2 + 2, `${first} in the first second`);
    } finally {
      for (const s of subs) s.close();
      live.setLiveScopeForTests(null);
    }
    assert.equal(live.liveStateForTests().indexedTeams >= 0, true);
  });
});

// --- The listener when the database can't deliver -------------------------------------------

describe("listener unavailable", () => {
  test("a connection that accepts LISTEN but delivers nothing: live stays off, the desk is told to poll, and it says why", async () => {
    await live.stopLiveForTests();
    // Another database on the same server: LISTEN works, our NOTIFY never arrives (as through a transaction-mode pooler).
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = "/postgres";
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warned.push(a.map(String).join(" "));
    process.env.DATABASE_LISTEN_URL = url.toString();
    try {
      assert.equal(await live.ensureListening(), false);
      assert.ok(warned.some((w) => w.includes("helpdesk.live_unavailable") && w.includes("DATABASE_LISTEN_URL")), warned.join("\n"));
      const st = live.liveStateForTests();
      assert.equal(st.state, "down");
      assert.equal(st.reconnecting, true, "one timer redials");
      // While down: answered at once, without dialling.
      const t0 = Date.now();
      const res = await callGet(liveRoute.GET, req("/live?wait=5", P.sam.session));
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as { fallback: string }).fallback, "poll");
      assert.ok(Date.now() - t0 < 1_000, `${Date.now() - t0} ms`);
      assert.equal(await live.ensureListening(), false);
    } finally {
      console.warn = warn;
      delete process.env.DATABASE_LISTEN_URL;
      await live.stopLiveForTests();
    }
    // Pointed at the right database again: up.
    assert.equal(await live.ensureListening(), true);
  });
});
