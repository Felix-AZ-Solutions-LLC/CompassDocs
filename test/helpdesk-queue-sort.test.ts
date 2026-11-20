// Helpdesk 1.20.36: the queue's sort is the agent's (lib/helpdesk/queue-sort-shared,
// components/helpdesk/desk/queue/views and queue-sort, notify-prefs queue_sort).
//
//   - the stored value is sanitised: a sort, or null for the desk's default;
//     anything else reads as the default and a patch carrying it is refused
//     with a sentence;
//   - which sort a list shows: an explicit ?sort= beats the agent's sort,
//     which beats the default; the Parked view (by name, a filtered list or a
//     saved view starting from it) ignores both; only an explicit ?sort= is
//     written back into the list's links, and a view picked in the rail drops it;
//   - through PUT/GET /api/helpdesk/me/notification-prefs: saved and read per
//     agent, reset to the default with null, other preferences untouched; a
//     body naming someone else is refused and nobody else's changes; a
//     requester gets 403 and no session 401;
//   - the desk layout's read (agentReadingPrefs) hands the saved sort to the
//     first paint;
//   - the list the queue asks for is in that order, and Parked (the view, or
//     status_group=parked from Reports or a saved view) stays soonest to wake
//     first whatever the agent chose; the CSV export comes out in the same
//     order; every sort ends on a unique key;
//   - each window's store (queue/queue-sort): saves go one after another and
//     a save overtaken before it was sent is skipped; another window's saved
//     change is taken only when newer, so a late or stale message never
//     wins; a refused save goes back to the last value known saved and never
//     over a newer change; a window that is not on the queue follows a
//     change made in another; an older save landing after another window's
//     newer one is repaired; the state belongs to one agent.
//
// Same rig as test/helpdesk-email-inline (route handlers called directly with
// real sessions, next/headers and lib/ee stubbed). Parallel-safe: everything
// is this file's own (STAMP).
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-queue-sort.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";
import {
  HD_QUEUE_SORTS,
  QUEUE_SORT_DEFAULT,
  cleanQueueSort,
  isQueueSort,
  queueSortLabel,
  resolveQueueSort,
} from "../src/lib/helpdesk/queue-sort-shared";
import { defaultPrefs, prefsPatchProblem, resolvePrefs } from "../src/lib/helpdesk/notify-prefs-shared";
import { SORTS, apiQs, fixSavedOrder, fixedOrder, readSel, selQs, startsFromParked } from "../src/components/helpdesk/desk/queue/views";

// --- The request scope outside Next and the licence -------------------------------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-queue-sort.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-queue-sort.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
{
  const virtual = (file: string, exports: Record<string, unknown>) => {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
  };
  virtual(HEADERS_STUB, {
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
  });
  virtual(EE_STUB, {
    ee: () => ({ present: true, features: ["helpdesk"] }),
    eePresent: () => true,
    featureEnabled: async (feature: string) => feature === "helpdesk",
    featureEnforced: async (feature: string) => feature === "helpdesk",
  });
  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee" || request === "../../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) {
      return EE_STUB;
    }
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const rolesShared = require("../src/lib/helpdesk/roles-shared") as typeof import("../src/lib/helpdesk/roles-shared");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const notifyPrefs = require("../src/lib/helpdesk/notify-prefs") as typeof import("../src/lib/helpdesk/notify-prefs");
const prefsRoute = require("../src/app/api/helpdesk/me/notification-prefs/route") as typeof import("../src/app/api/helpdesk/me/notification-prefs/route");
const ticketsRoute = require("../src/app/api/helpdesk/tickets/route") as typeof import("../src/app/api/helpdesk/tickets/route");
const deskAccess = require("../src/app/(desk)/desk-access") as typeof import("../src/app/(desk)/desk-access");
const ticketsLib = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const ticketExport = require("../src/lib/helpdesk/ticket-export") as typeof import("../src/lib/helpdesk/ticket-export");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdRole } from "../src/lib/helpdesk/roles-shared";

// --- Calling routes -------------------------------------------------------------------------

interface Answer {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function call(handler: unknown, r: Request): Promise<Answer> {
  currentRequest = r;
  try {
    const res = await (handler as (req: Request) => Promise<Response>)(r);
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, text, body };
  } finally {
    currentRequest = null;
  }
}

function req(url: string, session: string | null, init: { method?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  if (session) headers.cookie = `compass_session=${session}`;
  return new Request(`http://localhost/api/helpdesk${url}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const put = (session: string | null, body: unknown) => call(prefsRoute.PUT, req("/me/notification-prefs", session, { method: "PUT", body }));
const get = (session: string | null) => call(prefsRoute.GET, req("/me/notification-prefs", session));

// --- Fixtures ---------------------------------------------------------------------------------

const STAMP = `hdqs${Date.now().toString(36)}${process.pid}`;
interface Person {
  id: number;
  session: string;
}
const P: Record<string, Person> = {};
const userIds: number[] = [];
const roleIds: number[] = [];
let T1 = 0;
/** The fixture tickets by name, as their numbers. */
const N: Record<string, number> = {};

async function person(key: string, name: string): Promise<Person> {
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [
    `${STAMP}-${key}`,
    name,
    `${STAMP}-${key}@people.example`,
  ]);
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  userIds.push(id);
  P[key] = { id, session };
  return P[key];
}

async function grant(userId: number, perms: string[], tag: string): Promise<void> {
  const r = await fixtureQuery("INSERT INTO roles (key, name) VALUES ($1, $1) RETURNING id", [`${STAMP}-${tag}`]);
  roleIds.push(r.rows[0].id);
  for (const p of perms) await fixtureQuery("INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)", [r.rows[0].id, p]);
  await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [r.rows[0].id, userId]);
}

async function deskRole(userId: number, role: HdRole) {
  await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [userId, role]);
}

/** A ticket in T1 raised by the agent; `ageMin` minutes old, due in `dueMin`, updated `updatedMin` ago. */
async function ticket(key: string, o: { ageMin: number; dueMin: number; updatedMin: number; priority: string }): Promise<number> {
  const r = await call(
    ticketsRoute.POST,
    req("/tickets", P.agent.session, { body: { subject: `${STAMP} ${key}`, body: "Reported at the desk.", team_id: T1, priority: o.priority } })
  );
  assert.equal(r.status, 201, r.text);
  const n = r.body.ticket.number as number;
  await pool().query(
    `UPDATE hd_tickets SET created_at = now() - make_interval(mins => $2), updated_at = now() - make_interval(mins => $4),
       first_replied_at = now(), first_reply_due = NULL, resolve_due = now() + make_interval(mins => $3), priority = $5
     WHERE number = $1`,
    [n, o.ageMin, o.dueMin, o.updatedMin, o.priority]
  );
  N[key] = n;
  return n;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(rolesShared.HD_DEFAULT_MATRIX);
  await person("agent", "Ana Sorter");
  await person("agent2", "Abe Sorter");
  await person("req", "Daniel Requester");
  T1 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9361) RETURNING id", [`${STAMP} IT`])).rows[0].id;
  for (const k of ["agent", "agent2"]) {
    await deskRole(P[k].id, "agent");
    await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent') ON CONFLICT DO NOTHING", [T1, P[k].id]);
  }
  for (const k of ["agent", "agent2", "req"]) await grant(P[k].id, ["helpdesk.request"], k);
  // Oldest to newest: A (due last, low), B (due first, urgent), C (due in between, normal, touched most recently).
  await ticket("A", { ageMin: 300, dueMin: 900, updatedMin: 200, priority: "low" });
  await ticket("B", { ageMin: 200, dueMin: 60, updatedMin: 100, priority: "urgent" });
  await ticket("C", { ageMin: 100, dueMin: 400, updatedMin: 5, priority: "normal" });
  // Two parked tickets: the older wakes later, so wake order and newest first disagree.
  await ticket("P1", { ageMin: 250, dueMin: 30, updatedMin: 250, priority: "normal" });
  await ticket("P2", { ageMin: 150, dueMin: 30, updatedMin: 150, priority: "normal" });
  await pool().query("UPDATE hd_tickets SET status = 'on_hold', parked_until = now() + interval '20 days' WHERE number = $1", [N.P1]);
  await pool().query("UPDATE hd_tickets SET status = 'on_hold', parked_until = now() + interval '10 days' WHERE number = $1", [N.P2]);
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  const all = (await pool().query("SELECT id FROM hd_tickets WHERE team_id = $1 OR subject LIKE $2", [T1, `${STAMP}%`])).rows.map((r) => r.id);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_teams WHERE id = $1", [T1]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR (target_type = 'helpdesk_ticket' AND target_id = ANY($2))", [userIds, all.map(String)]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_notify_prefs WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// --- Unit: the stored value -------------------------------------------------------------------

describe("the stored value", () => {
  test("a sort or null; anything else reads as the default (null)", () => {
    for (const s of HD_QUEUE_SORTS) {
      assert.equal(cleanQueueSort(s), s);
      assert.equal(resolvePrefs({ queue_sort: s }).queue_sort, s);
    }
    for (const junk of [undefined, null, "", "number", "DUE", "due ", 7, true, {}, ["due"], "__proto__"]) {
      assert.equal(cleanQueueSort(junk), null, String(junk));
      assert.equal(resolvePrefs({ queue_sort: junk }).queue_sort, null, String(junk));
    }
    assert.equal(defaultPrefs().queue_sort, null, "nobody starts with a sort of their own");
    // A row from before 1.20.36 (no queue_sort) and a corrupt row read as the default; the rest is kept.
    assert.equal(resolvePrefs({ ticket_order: "oldest" }).queue_sort, null);
    assert.equal(resolvePrefs({ ticket_order: "oldest" }).ticket_order, "oldest");
    assert.equal(resolvePrefs("garbage").queue_sort, null);
    // "number" is an API sort, not one the queue offers.
    assert.equal(isQueueSort("number"), false);
  });

  test("a patch: a sort or null is accepted; anything else is refused with a sentence", () => {
    for (const s of [...HD_QUEUE_SORTS, null]) assert.equal(prefsPatchProblem({ queue_sort: s }), null, String(s));
    for (const junk of ["number", "", "newest", 3, false, {}, ["due"]]) {
      assert.equal(prefsPatchProblem({ queue_sort: junk }), "Sort the queue due first, priority first, recently updated or newest first.", String(junk));
    }
  });

  test("the labels are the Sort menu's, Due first the default", () => {
    assert.equal(QUEUE_SORT_DEFAULT, "due");
    assert.deepEqual(
      SORTS.map((s) => [s.value, s.label]),
      [
        ["due", "Due first"],
        ["priority", "Priority first"],
        ["updated", "Recently updated"],
        ["created", "Newest first"],
      ]
    );
    assert.equal(queueSortLabel("created"), "Newest first");
  });
});

// --- Unit: which sort a list shows ------------------------------------------------------------

describe("resolution order", () => {
  const sp = (q: string) => new URLSearchParams(q);

  test("the address beats the agent's sort, which beats the default", () => {
    assert.deepEqual(resolveQueueSort({ url: "priority", pref: "created" }), { sort: "priority", from: "url" });
    assert.deepEqual(resolveQueueSort({ url: null, pref: "created" }), { sort: "created", from: "pref" });
    assert.deepEqual(resolveQueueSort({ url: "bogus", pref: "created" }), { sort: "created", from: "pref" }, "a bad ?sort= is no sort");
    assert.deepEqual(resolveQueueSort({ url: null, pref: null }), { sort: "due", from: "default" });
    assert.deepEqual(resolveQueueSort({ url: null, pref: "bogus" }), { sort: "due", from: "default" });
    // An explicit ?sort=due is explicit: it beats the agent's Newest first.
    assert.deepEqual(resolveQueueSort({ url: "due", pref: "created" }), { sort: "due", from: "url" });
  });

  test("Parked keeps its own order whatever the address or the agent says", () => {
    assert.deepEqual(resolveQueueSort({ url: "created", pref: "updated", fixed: true }), { sort: "due", from: "fixed" });
    for (const q of ["view=parked", "view=parked&sort=created", "from=filter&view=parked&q=room", "from=filter&view=parked&sort=priority"]) {
      const sel = readSel(sp(q), "created");
      assert.equal(sel.sort, "due", q);
      assert.equal(fixedOrder(sel), true, q);
      // "due" on the Parked view is what the server lists soonest to wake first (lib/helpdesk/tickets WAKE_SORT_SQL).
      assert.match(apiQs(sel), /(^|&)view=parked(&|$)/, q);
      assert.match(apiQs(sel), /(^|&)sort=due(&|$)/, q);
      assert.doesNotMatch(selQs(sel), /sort=/, `${q}: Parked's order is never written into its links`);
    }
    // Every other view follows the agent.
    for (const q of ["", "view=open", "view=overdue", "view=waiting", "team=3", "from=reports&priority=high", "from=filter&view=open&q=vpn"]) {
      const sel = readSel(sp(q), "created");
      assert.deepEqual([sel.sort, sel.sortFrom, fixedOrder(sel)], ["created", "pref", false], q);
      assert.match(apiQs(sel), /(^|&)sort=created(&|$)/, q);
    }
  });

  test("status_group=parked (Reports' Parked now, a saved view) is Parked's order too", () => {
    assert.equal(startsFromParked({ status_group: "parked" }), true);
    assert.equal(startsFromParked({ status_group: "open", include_parked: "1" }), false, "open work with parked included is ordinary");
    for (const q of ["from=reports&status_group=parked", "from=reports&status_group=parked&sort=created&team=3", "from=filter&status_group=parked"]) {
      const sel = readSel(sp(q), "updated");
      assert.deepEqual([sel.sort, sel.sortFrom], ["due", "fixed"], q);
      assert.match(apiQs(sel), /(^|&)sort=due(&|$)/, q);
    }
    const saved = fixSavedOrder(readSel(sp("saved=4"), "created"), { status_group: "parked" });
    assert.deepEqual([saved.sort, saved.sortFrom], ["due", "fixed"]);
    assert.equal(fixedOrder(readSel(sp("from=reports&status_group=open"), "created")), false);
  });

  test("a saved view follows the agent unless its filters start from Parked", () => {
    const sel = readSel(sp("saved=12"), "updated");
    assert.deepEqual([sel.sort, sel.sortFrom], ["updated", "pref"]);
    assert.equal(fixSavedOrder(sel, { view: "open", q: "vpn" }), sel, "an ordinary saved view is left alone");
    assert.equal(fixSavedOrder(sel, undefined), sel, "while the views load");
    const parked = fixSavedOrder(sel, { view: "parked" });
    assert.deepEqual([parked.sort, parked.sortFrom], ["due", "fixed"]);
    // An explicit ?sort= on a saved view's link wins (saved views store no sort of their own).
    const linked = readSel(sp("saved=12&sort=priority"), "updated");
    assert.deepEqual([linked.sort, linked.sortFrom], ["priority", "url"]);
    assert.equal(selQs(linked), "?saved=12&sort=priority");
  });

  test("only an explicit ?sort= is written back, and a view picked in the rail drops it", () => {
    // The agent's own sort needs no parameter: links stay as they were before 1.20.36.
    assert.equal(selQs(readSel(sp("view=overdue"), "created")), "?view=overdue");
    assert.equal(selQs(readSel(sp(""), "created")), "");
    // A link that names a sort keeps it while tickets open beside the list, even ?sort=due.
    const linked = readSel(sp("view=overdue&sort=due"), "created");
    assert.equal(selQs(linked), "?view=overdue&sort=due");
    const drill = readSel(sp("from=reports&priority=high&sort=updated"), "created");
    assert.equal(drill.sort, "updated");
    assert.equal(selQs(drill), "?from=reports&priority=high&sort=updated");
    // A drill-down without ?sort= (Reports' links carry none) follows the agent.
    assert.equal(readSel(sp("from=reports&priority=high"), "created").sort, "created");
    // The rail's links: another view, the agent's sort again.
    assert.equal(selQs({ ...linked, view: "open", sortFrom: undefined }), "?view=open");
  });

  test("before 1.20.36 nothing was stored: the default, exactly as the address read then", () => {
    for (const [q, sort] of [
      ["", "due"],
      ["sort=priority", "priority"],
      ["view=open&sort=created", "created"],
      ["sort=number", "due"],
    ] as const) {
      assert.equal(readSel(sp(q), null).sort, sort, q);
    }
  });
});

// --- Integration: saved and read through the route ---------------------------------------------

describe("the agent's sort through the route", () => {
  test("saved per agent, read back, reset with null; other preferences untouched", async () => {
    assert.equal((await get(P.agent.session)).body.prefs.queue_sort, null);
    await put(P.agent.session, { ticket_order: "oldest" });
    const r = await put(P.agent.session, { queue_sort: "created" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.prefs.queue_sort, "created");
    assert.equal(r.body.prefs.ticket_order, "oldest", "the rest stays");
    assert.equal((await get(P.agent.session)).body.prefs.queue_sort, "created");
    assert.equal((await notifyPrefs.getNotifyPrefs(P.agent.id)).queue_sort, "created");
    // The layout's read, which the queue's first paint uses.
    assert.equal((await deskAccess.agentReadingPrefs(P.agent.id)).queueSort, "created");
    assert.equal((await deskAccess.agentReadingPrefs(P.agent2.id)).queueSort, null, "another agent's is untouched");
    // Changing another preference keeps it.
    await put(P.agent.session, { email_view: "plain" });
    assert.equal((await notifyPrefs.getNotifyPrefs(P.agent.id)).queue_sort, "created");
    // Back to the default.
    const reset = await put(P.agent.session, { queue_sort: null });
    assert.equal(reset.status, 200, reset.text);
    assert.equal(reset.body.prefs.queue_sort, null);
    assert.equal((await deskAccess.agentReadingPrefs(P.agent.id)).queueSort, null);
    const stored = (await pool().query("SELECT prefs FROM hd_notify_prefs WHERE user_id = $1", [P.agent.id])).rows[0].prefs;
    assert.equal(stored.queue_sort, null);
    assert.equal(stored.ticket_order, "oldest");
  });

  test("a bad value is refused with the sentence and changes nothing", async () => {
    await put(P.agent2.session, { queue_sort: "priority" });
    const bad = await put(P.agent2.session, { queue_sort: "number" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "Sort the queue due first, priority first, recently updated or newest first.");
    assert.equal((await notifyPrefs.getNotifyPrefs(P.agent2.id)).queue_sort, "priority");
    // A corrupt stored value reads as the default.
    await pool().query(`UPDATE hd_notify_prefs SET prefs = prefs || '{"queue_sort": "sideways"}'::jsonb WHERE user_id = $1`, [P.agent2.id]);
    assert.equal((await get(P.agent2.session)).body.prefs.queue_sort, null);
    assert.equal((await deskAccess.agentReadingPrefs(P.agent2.id)).queueSort, null);
  });

  test("an agent changes only their own", async () => {
    await put(P.agent2.session, { queue_sort: "updated" });
    // There is no way to name someone else: the session is who it is for.
    for (const body of [
      { queue_sort: "created", user_id: P.agent2.id },
      { queue_sort: "created", userId: P.agent2.id },
      { prefs: { queue_sort: "created" }, user: P.agent2.id },
    ]) {
      const r = await put(P.agent.session, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.body.error, /^Unknown preference/);
    }
    assert.equal((await notifyPrefs.getNotifyPrefs(P.agent2.id)).queue_sort, "updated");
    assert.equal((await put(P.agent.session, { queue_sort: "created" })).status, 200);
    assert.equal((await notifyPrefs.getNotifyPrefs(P.agent2.id)).queue_sort, "updated", "agent 2's is still theirs");
    assert.equal((await notifyPrefs.getNotifyPrefs(P.agent.id)).queue_sort, "created");
    // A requester has no desk preferences; no session is no one.
    assert.equal((await put(P.req.session, { queue_sort: "created" })).status, 403);
    assert.equal((await notifyPrefs.getNotifyPrefs(P.req.id)).queue_sort, null);
    assert.equal((await put(null, { queue_sort: "created" })).status, 401);
  });
});

// --- Integration: the list is in the order the queue shows ---------------------------------------

describe("the list follows the sort that is shown", () => {
  /** The numbers of this file's tickets in the order the queue's request lists them. */
  async function listed(q: string, pref: unknown, session = P.agent.session): Promise<number[]> {
    const sel = readSel(new URLSearchParams(q), pref);
    const r = await call(ticketsRoute.GET, req(`/tickets?${apiQs(sel)}&team=${T1}`, session));
    assert.equal(r.status, 200, r.text);
    const mine = new Set(Object.values(N));
    return (r.body.tickets as { number: number }[]).map((t) => t.number).filter((n) => mine.has(n));
  }

  test("the agent's sort orders every view; an explicit ?sort= beats it", async () => {
    const pref = (await deskAccess.agentReadingPrefs(P.agent.id)).queueSort;
    assert.equal(pref, "created", "from the test above");
    assert.deepEqual(await listed("view=open", pref), [N.C, N.B, N.A], "Newest first");
    assert.deepEqual(await listed("view=open", null), [N.B, N.C, N.A], "the default: due first");
    assert.deepEqual(await listed("view=open&sort=due", pref), [N.B, N.C, N.A], "an explicit ?sort=due");
    assert.deepEqual(await listed("view=open", "updated"), [N.C, N.B, N.A], "recently updated");
    assert.deepEqual(await listed("view=open", "priority"), [N.B, N.C, N.A], "priority first");
    assert.deepEqual(await listed("from=reports&priority=low", pref), [N.A], "a drill-down follows the agent");
  });

  test("Parked stays soonest to wake first whatever the agent chose", async () => {
    for (const pref of [null, "created", "updated", "priority", "due"]) {
      assert.deepEqual(await listed("view=parked", pref), [N.P2, N.P1], String(pref));
    }
    assert.deepEqual(await listed("view=parked&sort=created", "updated"), [N.P2, N.P1], "even with a ?sort= in the address");
    assert.deepEqual(await listed("from=filter&view=parked", "created"), [N.P2, N.P1], "a filtered list from Parked");
    // Not a view of open work.
    assert.equal((await listed("view=open", "created")).some((n) => n === N.P1 || n === N.P2), false);
    // Reports' Parked now (status_group=parked) and a saved view built on it.
    assert.deepEqual(await listed("from=reports&status_group=parked", "created"), [N.P2, N.P1], "Reports' Parked now");
    assert.deepEqual(await listed("from=reports&status_group=parked&sort=created", "updated"), [N.P2, N.P1], "with a ?sort= in its link");
  });

  test("the CSV export comes out in the list's order, Parked's included", async () => {
    const ids = async (f: import("../src/lib/helpdesk/tickets").TicketListFilters) => {
      const byId = new Map((await pool().query("SELECT id, number FROM hd_tickets WHERE number = ANY($1)", [Object.values(N)])).rows.map((r) => [Number(r.id), r.number as number]));
      return (await ticketExport.planTicketExport({ id: P.agent.id, role: "viewer" }, { ...f, team_id: T1 })).ids.map((id) => byId.get(id)).filter((n) => n !== undefined);
    };
    assert.deepEqual(await ids({ view: "parked", sort: "due" }), [N.P2, N.P1], "the Parked view");
    assert.deepEqual(await ids({ view: "all", status_group: "parked", sort: "due" }), [N.P2, N.P1], "status_group=parked");
    assert.deepEqual(await ids({ view: "all", status_group: "parked" }), [N.P2, N.P1], "no sort asked for");
    assert.deepEqual(await ids({ view: "open", sort: "created" }), [N.C, N.B, N.A], "an ordinary list in its sort");
    // The API's contract is unchanged: an explicit other sort on parked tickets is honoured as asked.
    assert.deepEqual(await ids({ view: "parked", sort: "created" }), [N.P2, N.P1].sort((a, b) => b - a), "newest first (higher number) as asked");
  });

  test("every sort ends on a unique key", () => {
    for (const [k, sql] of Object.entries(ticketsLib.SORT_SQL)) assert.match(sql, /t\.(id|number)( DESC)?$/, k);
    assert.match(ticketsLib.sortSqlFor({ view: "parked" }), /t\.id$/);
    assert.equal(ticketsLib.sortSqlFor({ status_group: "parked", sort: "due" }), ticketsLib.sortSqlFor({ view: "parked" }));
    assert.equal(ticketsLib.sortSqlFor({ view: "open", sort: "due" }), ticketsLib.SORT_SQL.due);
  });
});

// --- Unit: each window's store (queue/queue-sort) ------------------------------------------------

type Store = typeof import("../src/components/helpdesk/desk/queue/queue-sort");
const STORE_PATH = require.resolve("../src/components/helpdesk/desk/queue/queue-sort");
const tabs: Store[] = [];

/** A desk window: its own copy of the store (as each tab has), talking to a fake server. */
function tab(server: FakeServer): Store {
  delete require.cache[STORE_PATH];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const t = require(STORE_PATH) as Store;
  const toasts: string[] = [];
  t.setQueueSortDepsForTests({ put: (sort) => server.put(sort), get: async () => server.value, toast: (m) => void toasts.push(m) });
  (t as Store & { toasts: string[] }).toasts = toasts;
  tabs.push(t);
  return t;
}
const toastsOf = (t: Store) => (t as Store & { toasts: string[] }).toasts;

/** The server's stored value, with each PUT held until the test lets it through (or refuses it). */
class FakeServer {
  value: unknown = null;
  sent: unknown[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private held: { sort: unknown; ok: () => void; fail: (e: Error) => void }[] = [];
  auto = true;
  put(sort: unknown): Promise<unknown> {
    this.sent.push(sort);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    return new Promise((resolve, reject) => {
      const done = () => void this.inFlight--;
      const h = {
        sort,
        ok: () => {
          this.value = sort;
          done();
          resolve({});
        },
        fail: (e: Error) => {
          done();
          reject(e);
        },
      };
      if (this.auto) setTimeout(h.ok, 5);
      else this.held.push(h);
    });
  }
  async next(ok = true, why = "Refused."): Promise<void> {
    await until(() => this.held.length > 0);
    const h = this.held.shift()!;
    if (ok) h.ok();
    else h.fail(new Error(why));
  }
}

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const ticks = () => new Promise((r) => setTimeout(r, 30));
const U1 = 9_000_001;

describe("each window's store", () => {
  after(() => {
    for (const t of tabs) t.closeQueueSortChannelForTests();
  });

  test("saves go one after another; one overtaken before it was sent is skipped", async () => {
    const server = new FakeServer();
    server.auto = false;
    const t = tab(server);
    // Three picks in one go: only the last is sent.
    const a = t.chooseQueueSort(U1, "priority", null);
    const b = t.chooseQueueSort(U1, "updated", null);
    const c = t.chooseQueueSort(U1, "created", null);
    await server.next();
    assert.deepEqual(await Promise.all([a, b, c]), [false, false, true]);
    assert.deepEqual(server.sent, ["created"]);
    // A pick while a save is on its way waits for it, then goes: the server ends on the newer one.
    const d = t.chooseQueueSort(U1, "priority", null);
    await until(() => server.sent.length === 2);
    const e = t.chooseQueueSort(U1, "updated", null);
    await ticks();
    assert.equal(server.sent.length, 2, "the second save waits for the first");
    await server.next();
    await server.next();
    assert.deepEqual(await Promise.all([d, e]), [true, true]);
    assert.deepEqual(server.sent, ["created", "priority", "updated"]);
    assert.equal(server.maxInFlight, 1, "never two saves at once from one window");
    assert.equal(server.value, "updated");
    assert.equal(t.currentQueueSort(U1, null), "updated");
  });

  test("another window's change is taken only when newer: a late or stale one never wins", () => {
    const t = tab(new FakeServer());
    t.openQueueSortChannel(U1);
    assert.equal(t.receive({ user: U1, sort: "priority", at: 2_000, tab: "b" }), true);
    assert.equal(t.receive({ user: U1, sort: "updated", at: 1_000, tab: "c" }), false, "older");
    assert.equal(t.receive({ user: U1, sort: "updated", at: 2_000, tab: "a" }), false, "same time, lower window id");
    assert.equal(t.currentQueueSort(U1, null), "priority");
    // Someone else's, malformed or junk messages are ignored.
    for (const m of [{ user: U1 + 1, sort: "created", at: 9_000, tab: "z" }, { user: U1, sort: "number", at: 9_000, tab: "z" }, { user: U1, sort: "created", tab: "z" }, null, "created"]) {
      assert.equal(t.receive(m), false, JSON.stringify(m));
    }
    assert.equal(t.currentQueueSort(U1, null), "priority");
    // A pick here is newer than anything seen (its revision is after the newest one).
    void t.chooseQueueSort(U1, "created", null);
    assert.equal(t.receive({ user: U1, sort: "updated", at: 2_000, tab: "z" }), false, "older than the pick here");
    assert.equal(t.currentQueueSort(U1, null), "created");
  });

  test("a refused save goes back to the last value known saved, never over a newer change", async () => {
    const server = new FakeServer();
    server.auto = false;
    const t = tab(server);
    t.openQueueSortChannel(U1);
    // The page loaded with Due first; another window then saved Priority first.
    assert.equal(t.receive({ user: U1, sort: "priority", at: 1, tab: "other" }), true);
    const p = t.chooseQueueSort(U1, "created", null);
    await server.next(false, "The desk is busy.");
    assert.equal(await p, false);
    assert.equal(t.currentQueueSort(U1, null), "priority", "the last saved value, not the page's");
    assert.deepEqual(toastsOf(t), ["The desk is busy. Your sort is back to Priority first."]);
    // A refusal that comes after another window's newer change leaves that change alone.
    const q = t.chooseQueueSort(U1, "created", null);
    await until(() => server.sent.length === 2);
    assert.equal(t.receive({ user: U1, sort: "updated", at: Date.now() + 60_000, tab: "other" }), true);
    await server.next(false);
    assert.equal(await q, false);
    assert.equal(t.currentQueueSort(U1, null), "updated");
    assert.equal(toastsOf(t).length, 1, "no toast: nothing was put back");
  });

  test("an older save landing after another window's newer change is saved again after it", async () => {
    const server = new FakeServer();
    server.auto = false;
    const t = tab(server);
    t.openQueueSortChannel(U1);
    const p = t.chooseQueueSort(U1, "created", null);
    await until(() => server.sent.length === 1);
    assert.equal(t.receive({ user: U1, sort: "priority", at: Date.now() + 60_000, tab: "other" }), true);
    await server.next(); // "created" lands last on the server
    assert.equal(await p, true);
    await server.next(); // the repair
    assert.deepEqual(server.sent, ["created", "priority"]);
    assert.equal(server.value, "priority");
    assert.equal(t.currentQueueSort(U1, null), "priority");
  });

  test("a window that is not on the queue follows a change made in another", async () => {
    const server = new FakeServer();
    const queueTab = tab(server);
    const reportsTab = tab(server); // DeskShell opened its channel; no queue mounted
    reportsTab.openQueueSortChannel(U1);
    queueTab.openQueueSortChannel(U1);
    assert.equal(reportsTab.currentQueueSort(U1, null), null);
    assert.equal(await queueTab.chooseQueueSort(U1, "created", null), true);
    await until(() => reportsTab.currentQueueSort(U1, null) === "created");
    // A refused save is never told to the other windows.
    server.put = () => Promise.reject(new Error("No."));
    assert.equal(await queueTab.chooseQueueSort(U1, "priority", null), false);
    await ticks();
    assert.equal(reportsTab.currentQueueSort(U1, null), "created");
    assert.equal(queueTab.currentQueueSort(U1, null), "created", "put back");
  });

  test("reading the saved value again: taken when nothing happened meanwhile", async () => {
    const server = new FakeServer();
    const t = tab(server);
    server.value = "updated";
    await t.refreshQueueSort(U1);
    assert.equal(t.currentQueueSort(U1, null), "updated");
    server.value = "bogus";
    await t.refreshQueueSort(U1);
    assert.equal(t.currentQueueSort(U1, "priority"), null, "a malformed stored value is the default");
    // A pick while the read is on its way wins.
    server.value = "priority";
    const r = t.refreshQueueSort(U1);
    void t.chooseQueueSort(U1, "created", null);
    await r;
    await ticks();
    assert.equal(t.currentQueueSort(U1, null), "created");
  });

  test("the state belongs to one agent", async () => {
    const t = tab(new FakeServer());
    await t.chooseQueueSort(U1, "created", null);
    assert.equal(t.currentQueueSort(U1, null), "created");
    assert.equal(t.currentQueueSort(U1 + 1, "priority"), "priority", "another agent sees their own value");
    t.openQueueSortChannel(U1 + 1);
    assert.equal(t.currentQueueSort(U1, null), null, "signed in as someone else, the last person's choice is gone");
  });
});
