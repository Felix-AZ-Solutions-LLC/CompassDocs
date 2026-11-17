// Helpdesk 1.20.8: filtering the queue by a custom field
// (lib/helpdesk/custom-field-filters) and the ticket CSV export
// (lib/helpdesk/ticket-export, GET /api/helpdesk/tickets/export).
//
//   conditions   every condition of every kind, through the queue's own parser
//                and listTickets; AND-ed with each other and the other filters
//   teams        a value only matches on the field's teams; "empty" counts only
//                those teams' tickets; an "All teams" field covers no-team tickets
//   archived     an archived field still filters; a saved view using it counts
//   refusals     unknown key, a condition that doesn't fit, too many, repeated,
//                too long; SQL injection in values and keys changes nothing
//   saved views  round-trip with cf.* filters; a 1.20.7 view still counts
//   API / MCP    GET /api/helpdesk/v1/tickets?cf.<key>=…, hd_queue custom_fields
//   export       gating (tickets.export), visibility (the list's scope), BOM,
//                columns, values, escaping (commas, quotes, newlines, unicode,
//                formula prefixes), every page, the cap, the audit row; a
//                requester gets nothing
//
// Same harness as test/helpdesk-custom-fields: next/headers and lib/ee
// stubbed, routes called with real sessions. Parallel-safe on the shared
// database: every field is assigned to this file's own teams, never to "All
// teams" (the All teams case runs on an in-memory definition), and every
// query is narrowed to this file's requester. Everything made is removed.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-custom-field-filter.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession, getUserById } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { parseCsv } from "../src/lib/csv";
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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-cf-filter.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-cf-filter.virtual.js");
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
  ee.exports = { ee: () => ({ present: true, features: ["helpdesk"] }), eePresent: () => true, featureEnabled: async (f: string) => f === "helpdesk", featureEnforced: async (f: string) => f === "helpdesk" };
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
const cf = require("../src/lib/helpdesk/custom-fields") as typeof import("../src/lib/helpdesk/custom-fields");
const cff = require("../src/lib/helpdesk/custom-field-filters") as typeof import("../src/lib/helpdesk/custom-field-filters");
const filtersLib = require("../src/lib/helpdesk/ticket-filters") as typeof import("../src/lib/helpdesk/ticket-filters");
const savedShared = require("../src/lib/helpdesk/saved-views-shared") as typeof import("../src/lib/helpdesk/saved-views-shared");
const savedViews = require("../src/lib/helpdesk/saved-views") as typeof import("../src/lib/helpdesk/saved-views");
const exportShared = require("../src/lib/helpdesk/ticket-export-shared") as typeof import("../src/lib/helpdesk/ticket-export-shared");
const exportLib = require("../src/lib/helpdesk/ticket-export") as typeof import("../src/lib/helpdesk/ticket-export");
const csvLib = require("../src/lib/csv") as typeof import("../src/lib/csv");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const claude = require("../src/lib/helpdesk/claude-connector") as typeof import("../src/lib/helpdesk/claude-connector");
const hdTools = require("../src/lib/mcp/helpdesk-tools") as typeof import("../src/lib/mcp/helpdesk-tools");
const audLabels = require("../src/lib/audit-labels") as typeof import("../src/lib/audit-labels");
const listRoute = require("../src/app/api/helpdesk/tickets/route") as typeof import("../src/app/api/helpdesk/tickets/route");
const exportRoute = require("../src/app/api/helpdesk/tickets/export/route") as typeof import("../src/app/api/helpdesk/tickets/export/route");
const fieldsRoute = require("../src/app/api/helpdesk/custom-fields/route") as typeof import("../src/app/api/helpdesk/custom-fields/route");
const viewsRoute = require("../src/app/api/helpdesk/views/route") as typeof import("../src/app/api/helpdesk/views/route");
const viewRoute = require("../src/app/api/helpdesk/views/[id]/route") as typeof import("../src/app/api/helpdesk/views/[id]/route");
const tokensRoute = require("../src/app/api/helpdesk/admin/api/tokens/route") as typeof import("../src/app/api/helpdesk/admin/api/tokens/route");
const v1ListRoute = require("../src/app/api/helpdesk/v1/tickets/route") as typeof import("../src/app/api/helpdesk/v1/tickets/route");
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, req: Request, params: Record<string, string> = {}): Promise<{ status: number; body: any; text: string; headers: Headers }> {
  currentRequest = req;
  try {
    const res = await (handler as Handler)(req, { params: Promise.resolve(params) });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString("utf8");
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body, text, headers: res.headers };
  } finally {
    currentRequest = null;
  }
}

function req(url: string, session: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Request {
  return new Request(`http://localhost/api/helpdesk${url}`, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const STAMP = `hdcff-${Date.now()}-${process.pid}`;
const K = `f${Date.now().toString(36)}${process.pid.toString(36)}`;
const P: Record<string, { id: number; session: string; name: string }> = {};
const userIds: number[] = [];
const T: Record<string, number> = {};
const F: Record<string, number> = {};
const N: Record<string, number> = {};
const ID: Record<string, number> = {};
const ticketIds: number[] = [];
const viewIds: number[] = [];
const tokenIds: number[] = [];
const key = (name: string) => `${K}_${name}`;
const cfk = (name: string) => `cf.${key(name)}`;

async function person(k: string, deskRole: string | null) {
  const name = `${k} ${STAMP}`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [
    `${STAMP}-${k}`,
    name,
    `${STAMP}-${k}@example.test`,
  ]);
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  userIds.push(id);
  if (deskRole) await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [id, deskRole]);
  P[k] = { id, session, name };
}

async function ticket(name: string, team: string | null, subject = `${name} ${STAMP}`, extra: { status?: string; tags?: string[] } = {}) {
  const r = await pool().query(
    `INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status, source, tags)
     VALUES ($1, $2, 'Req Person', $3, $4, $5, 'portal', $6) RETURNING id, number`,
    [subject, P.req.id, `${STAMP}-req@example.test`, team ? T[team] : null, extra.status ?? "open", extra.tags ?? []]
  );
  ticketIds.push(r.rows[0].id);
  ID[name] = r.rows[0].id;
  N[name] = r.rows[0].number;
}

/** Store a value as the desk would (directly, so a value can also sit on a ticket whose team the field doesn't cover). */
async function value(t: string, field: string, v: unknown, display = "") {
  await pool().query(
    "INSERT INTO hd_ticket_custom_values (ticket_id, field_id, value, display) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (ticket_id, field_id) DO UPDATE SET value = EXCLUDED.value",
    [ID[t], F[field], JSON.stringify(v), display]
  );
}

async function field(name: string, input: Record<string, unknown> = {}): Promise<number> {
  const f = await cf.createCustomField({ label: `${name} ${STAMP}`, key: key(name), team_ids: [T.A], ...input }, { id: P.dadmin.id });
  F[name] = f.id;
  return f.id;
}

/** Ticket names a query finds, narrowed to this file's requester, every status. */
async function found(params: Record<string, string>, who = "manager"): Promise<string[]> {
  const parsed = await filtersLib.parseTicketFilters(new URLSearchParams({ view: "all", requester: String(P.req.id), ...params }));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  const user = (await getUserById(P[who].id))!;
  const { rows } = await tickets.listTickets(user, { ...parsed.filters, limit: 100 });
  const byNumber = new Map(Object.entries(N).map(([k, n]) => [n, k]));
  return rows.map((r) => byNumber.get(r.number) ?? `#${r.number}`).sort();
}

async function refusal(params: Record<string, string>): Promise<string> {
  const parsed = await filtersLib.parseTicketFilters(new URLSearchParams(params));
  assert.equal(parsed.ok, false, `expected a refusal for ${JSON.stringify(params)}`);
  return parsed.ok ? "" : parsed.error;
}

const DEVICE = [
  { value: "laptop", label: "Laptop" },
  { value: "desktop", label: "Desktop" },
  { value: "phone", label: "Phone" },
  { value: "dock,usb", label: "Dock, USB" },
];

before(async () => {
  await getSetting("__schema_bootstrap__");
  // Agents may export in this file (a manager's capability by default), so the scope test has a narrow exporter.
  roles.setRoleMatrixForTests({ ...roles.HD_DEFAULT_MATRIX, agent: [...roles.HD_DEFAULT_MATRIX.agent, "tickets.export"] });
  for (const k of ["A", "B", "C"]) {
    const r = await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9430) RETURNING id", [`${STAMP} ${k}`]);
    T[k] = r.rows[0].id;
  }
  await person("agent", "agent");
  await person("agent2", "agent");
  await person("newbie", "newbie");
  await person("manager", "manager");
  await person("dadmin", "admin");
  await person("req", null);
  // agent: teams A and B; agent2 and newbie: A. Team C is nobody's here (the manager sees every team).
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($1, $3, 'agent'), ($1, $4, 'agent'), ($5, $2, 'agent')", [
    T.A,
    P.agent.id,
    P.agent2.id,
    P.newbie.id,
    T.B,
  ]);
  await field("device", { type: "select", options: DEVICE, visibility: "public" });
  await field("serial", { type: "text" });
  await field("notes", { type: "textarea" });
  await field("cost", { type: "number" });
  await field("due", { type: "date" });
  await field("when", { type: "datetime" });
  await field("owner", { type: "user" });
  await field("billable", { type: "checkbox" });
  await field("site", { type: "select", options: [{ label: "North" }, { label: "South" }], team_ids: [T.A, T.B] });
  await field("old", { type: "text" });

  await ticket("t1", "A", `Laptop "won't" boot, again ${STAMP}`, { tags: ["hw", "vip"] });
  await ticket("t2", "A", `=HYPERLINK("http://x.test") ${STAMP}`);
  await ticket("t3", "A", `Ünïcode ✓ line one\nline two ${STAMP}`);
  await ticket("t4", "B");
  await ticket("t5", "C");
  await ticket("t6", null);
  await ticket("t7", "A");

  await value("t1", "device", "laptop", "Laptop");
  await value("t1", "serial", "ABC-123 dock");
  await value("t1", "cost", 5);
  await value("t1", "due", "2026-11-20");
  await value("t1", "when", "2026-11-20T14:00");
  await value("t1", "owner", P.agent2.id, P.agent2.name);
  await value("t1", "billable", true);
  await value("t1", "site", "south", "South");
  await value("t1", "notes", "-1 line\n+ two, \"three\"");

  await value("t2", "device", "phone", "Phone");
  await value("t2", "serial", "50%_off\\path");
  await value("t2", "cost", 12.5);
  await value("t2", "due", "2026-12-01");
  await value("t2", "billable", false);
  await value("t2", "old", "kept");

  await value("t7", "device", "dock,usb", "Dock, USB");
  await value("t7", "cost", -3);

  // On teams the fields don't cover: never a match, never "empty".
  await value("t4", "device", "laptop");
  await value("t4", "site", "north", "North");
  await value("t5", "device", "laptop");
  await value("t6", "device", "laptop");
  cf.invalidateCustomFields();
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  claude.setClaudeLevelForTests(null);
  await pool().query("DELETE FROM hd_saved_views WHERE id = ANY($1) OR name LIKE $2", [viewIds, `%${STAMP}%`]);
  const all = (await pool().query("SELECT id FROM hd_tickets WHERE id = ANY($1) OR team_id = ANY($2) OR requester_id = $3", [ticketIds, Object.values(T), P.req.id])).rows.map(
    (r) => r.id as number
  );
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_custom_fields WHERE label LIKE $1 OR key LIKE $2", [`%${STAMP}%`, `${K}%`]);
  cf.invalidateCustomFields();
  await pool().query("DELETE FROM hd_api_tokens WHERE id = ANY($1) OR name LIKE $2", [tokenIds, `${STAMP}%`]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1) OR name LIKE $2", [Object.values(T), `${STAMP}%`]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR target_label LIKE $2", [userIds, `%${STAMP}%`]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

describe("the condition grammar (pure)", () => {
  const sel = { label: "Device", type: "select" as const, options: DEVICE };
  test("ops fit the kind; arguments fit the op; the error is a sentence", () => {
    const p = cff.parseCfCondition;
    assert.deepEqual(p(sel, "any:laptop,phone"), { ok: true, cond: { op: "any", values: ["laptop", "phone"], arg: "" } });
    assert.deepEqual(p(sel, "any:dock,usb,laptop"), { ok: true, cond: { op: "any", values: ["dock,usb", "laptop"], arg: "" } }, "an option value with a comma");
    assert.equal(p(sel, "any:tablet").ok, false);
    assert.equal(p(sel, "contains:x").ok, false, "a pick-one field has no contains");
    assert.equal(p({ label: "N", type: "number", options: [] }, "gte:1e3").ok, false, "plain decimals only");
    assert.equal(p({ label: "N", type: "number", options: [] }, "gte:-2.5").ok, true);
    assert.equal(p({ label: "D", type: "date", options: [] }, "on:2026-02-31").ok, false, "a real calendar day");
    assert.equal(p({ label: "D", type: "datetime", options: [] }, "after:2026-02-28").ok, true);
    assert.equal(p({ label: "U", type: "user", options: [] }, "is:abc").ok, false);
    assert.equal(p({ label: "B", type: "checkbox", options: [] }, "yes:1").ok, false, "yes takes nothing after it");
    assert.equal(p({ label: "S", type: "text", options: [] }, `contains:${"x".repeat(201)}`).ok, false, "bounded length");
    const e = p({ label: "Serial", type: "text", options: [] }, "gte:3");
    assert.ok(!e.ok && /^"Serial" can't be filtered with "gte"\. Use contains, empty, filled\.$/.test(e.error), JSON.stringify(e));
  });

  test("conditions read as words; a round trip keeps them", () => {
    const t = (raw: string, f: { label: string; type: any; options: any[] } = sel) => {
      const p = cff.parseCfCondition(f, raw);
      assert.ok(p.ok);
      assert.equal(cff.formatCfCondition(p.cond), raw);
      return cff.cfConditionText(f, p.cond, new Map([[7, "Ana Lee"]]));
    };
    assert.equal(t("any:laptop,phone"), "Device: Laptop, Phone");
    assert.equal(t("any_or_empty:laptop"), "Device: Laptop or not filled in");
    assert.equal(t("empty"), "Device: not filled in");
    assert.equal(t("yes", { label: "Billable", type: "checkbox", options: [] }), "Billable: Yes");
    assert.equal(t("contains:AB", { label: "Serial", type: "text", options: [] }), 'Serial: contains "AB"');
    assert.equal(t("gte:50", { label: "Cost", type: "number", options: [] }), "Cost: at least 50");
    assert.equal(t("before:2026-11-20", { label: "Due", type: "date", options: [] }), "Due: before 2026-11-20");
    assert.equal(t("is:7", { label: "Approver", type: "user", options: [] }), "Approver: Ana Lee");
    const summary = savedShared.filterSummary({ view: "all", "cf.device_type": "any:laptop" }, [], [{ key: "device_type", label: "Device type", type: "select", options: DEVICE, archived: false }]);
    assert.equal(summary, "Device type: Laptop");
    assert.equal(savedShared.filterSummary({ "cf.gone": "empty" }, [], []), "gone: deleted field");
  });
});

describe("security review (1.20.8): hostile option lists finish fast", () => {
  const ms = (fn: () => unknown) => {
    const t = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - t) / 1e6;
  };

  test("a 6,000-character list of one repeated option is refused with a sentence, at once", () => {
    const pc = { label: "Kind", type: "select" as const, options: [{ value: "pc", label: "PC" }] };
    const raw = `any:${"pc,".repeat(1997)}nope`;
    assert.ok(raw.length <= cff.CF_VALUE_MAX);
    let r: ReturnType<typeof cff.parseCfCondition> | undefined;
    assert.ok(ms(() => (r = cff.parseCfCondition(pc, raw))) < 50);
    assert.deepEqual(r, { ok: false, error: '"Kind" has 1 option, so list each at most once.' });
    // The splitter alone (no piece count first) is linear too.
    assert.ok(ms(() => assert.equal(cff.splitOptionValues(raw.slice(4), pc.options), null)) < 50);
    const one = { label: "Kind", type: "select" as const, options: "abcdefghij".split("").map((c) => ({ value: c, label: c })) };
    assert.ok(ms(() => assert.equal(cff.parseCfCondition(one, `any:${"a,".repeat(2900)}z`).ok, false)) < 50);
  });

  test("options that are other options joined by commas: no exponential search; a valid list still reads", () => {
    const options = [{ value: "a", label: "A" }, { value: "a,a", label: "A, A" }, ...Array.from({ length: 48 }, (_, i) => ({ value: `o${i}`, label: `O${i}` }))];
    assert.equal(cff.cfMaxPieces(options), 51);
    const f = { label: "Mix", type: "select" as const, options };
    const hostile = `${"a,".repeat(50)}b`; // 51 pieces, within the count, and no reading
    assert.ok(ms(() => assert.equal(cff.splitOptionValues(hostile, options), null)) < 50);
    assert.ok(ms(() => assert.equal(cff.parseCfCondition(f, `any:${hostile}`).ok, false)) < 50);
    assert.deepEqual(cff.splitOptionValues("a,a,o3", options), ["a", "o3"], "the shortest value that lets the rest be read");
    assert.deepEqual(cff.splitOptionValues("o1,a,a", options), ["o1", "a"]);
    assert.deepEqual(cff.splitOptionValues("a,a", options), ["a,a"], "a whole option wins first");
  });

  test("through the queue's parser on a real field: refused fast with a sentence", async () => {
    const raw = `any:${"laptop,".repeat(800)}nope`;
    const t = Date.now();
    const parsed = await filtersLib.parseTicketFilters(new URLSearchParams({ [cfk("device")]: raw }));
    assert.ok(Date.now() - t < 1000, "one definition read, then linear work");
    assert.equal(parsed.ok, false);
    assert.match((parsed as { error: string }).error, /has 4 options, so list each at most once\.$/);
  });
});

describe("conditions per kind", () => {
  test("pick one: any of, any of or not filled in, not filled in, filled in; an option with a comma", async () => {
    assert.deepEqual(await found({ [cfk("device")]: "any:laptop" }), ["t1"], "t4 (team B), t5 (team C) and t6 (no team) hold laptop but the field is team A's");
    assert.deepEqual(await found({ [cfk("device")]: "any:laptop,phone" }), ["t1", "t2"]);
    assert.deepEqual(await found({ [cfk("device")]: "any:dock,usb" }), ["t7"]);
    assert.deepEqual(await found({ [cfk("device")]: "any_or_empty:laptop" }), ["t1", "t3"]);
    assert.deepEqual(await found({ [cfk("device")]: "empty" }), ["t3"], "empty counts team A's tickets only");
    assert.deepEqual(await found({ [cfk("device")]: "filled" }), ["t1", "t2", "t7"]);
  });

  test("yes / no: Yes, No, not filled in", async () => {
    assert.deepEqual(await found({ [cfk("billable")]: "yes" }), ["t1"]);
    assert.deepEqual(await found({ [cfk("billable")]: "no" }), ["t2"]);
    assert.deepEqual(await found({ [cfk("billable")]: "empty" }), ["t3", "t7"]);
  });

  test("text and long text: contains (any case, LIKE characters are literal), empty, not empty", async () => {
    assert.deepEqual(await found({ [cfk("serial")]: "contains:abc" }), ["t1"]);
    assert.deepEqual(await found({ [cfk("serial")]: "contains:DOCK" }), ["t1"]);
    assert.deepEqual(await found({ [cfk("serial")]: "contains:%" }), ["t2"], "% is a character, not a wildcard");
    assert.deepEqual(await found({ [cfk("serial")]: "contains:_" }), ["t2"]);
    assert.deepEqual(await found({ [cfk("serial")]: "contains:\\" }), ["t2"]);
    assert.deepEqual(await found({ [cfk("serial")]: "empty" }), ["t3", "t7"]);
    assert.deepEqual(await found({ [cfk("serial")]: "filled" }), ["t1", "t2"]);
    assert.deepEqual(await found({ [cfk("notes")]: 'contains:"three"' }), ["t1"]);
  });

  test("number: equals, at least, at most, empty", async () => {
    assert.deepEqual(await found({ [cfk("cost")]: "eq:5" }), ["t1"]);
    assert.deepEqual(await found({ [cfk("cost")]: "eq:5.0" }), ["t1"]);
    assert.deepEqual(await found({ [cfk("cost")]: "gte:6" }), ["t2"]);
    assert.deepEqual(await found({ [cfk("cost")]: "lte:12.5" }), ["t1", "t2", "t7"]);
    assert.deepEqual(await found({ [cfk("cost")]: "lte:-1" }), ["t7"]);
    assert.deepEqual(await found({ [cfk("cost")]: "empty" }), ["t3"]);
  });

  test("date and date-and-time: on, before, after (by day), empty", async () => {
    assert.deepEqual(await found({ [cfk("due")]: "on:2026-11-20" }), ["t1"]);
    assert.deepEqual(await found({ [cfk("due")]: "before:2026-11-21" }), ["t1"]);
    assert.deepEqual(await found({ [cfk("due")]: "after:2026-11-20" }), ["t2"]);
    assert.deepEqual(await found({ [cfk("due")]: "empty" }), ["t3", "t7"]);
    assert.deepEqual(await found({ [cfk("when")]: "on:2026-11-20" }), ["t1"], "a date and time is compared by its day");
    assert.deepEqual(await found({ [cfk("when")]: "before:2026-11-20" }), []);
    assert.deepEqual(await found({ [cfk("when")]: "after:2026-11-19" }), ["t1"]);
  });

  test("a person: is, empty", async () => {
    assert.deepEqual(await found({ [cfk("owner")]: `is:${P.agent2.id}` }), ["t1"]);
    assert.deepEqual(await found({ [cfk("owner")]: `is:${P.agent.id}` }), []);
    assert.deepEqual(await found({ [cfk("owner")]: "empty" }), ["t2", "t3", "t7"]);
  });

  test("several conditions are AND-ed with each other and with the other filters", async () => {
    assert.deepEqual(await found({ [cfk("device")]: "any:laptop,phone", [cfk("billable")]: "yes" }), ["t1"]);
    assert.deepEqual(await found({ [cfk("device")]: "any:laptop,phone", [cfk("cost")]: "gte:1", tag: "hw" }), ["t1"]);
    assert.deepEqual(await found({ [cfk("device")]: "any:laptop,phone", team: String(T.B) }), []);
    assert.deepEqual(await found({ [cfk("device")]: "any:phone", q: "HYPERLINK" }), ["t2"]);
  });
});

describe("teams and archived fields", () => {
  test("a field on two teams: values match on both; empty counts only tickets of those teams", async () => {
    assert.deepEqual(await found({ [cfk("site")]: "any:north" }), ["t4"]);
    assert.deepEqual(await found({ [cfk("site")]: "any:north,south" }), ["t1", "t4"]);
    assert.deepEqual(await found({ [cfk("site")]: "empty" }), ["t2", "t3", "t7"], "not t5 (team C) or t6 (no team)");
  });

  test("an All teams field covers every team and tickets with no team (in-memory definition)", async () => {
    const parsed = await filtersLib.parseTicketFilters(new URLSearchParams({ view: "all", requester: String(P.req.id), [cfk("device")]: "any:laptop" }));
    assert.ok(parsed.ok);
    const user = (await getUserById(P.manager.id))!;
    const allTeams = parsed.filters.custom!.map((c) => ({ ...c, all_teams: true, team_ids: [] }));
    const { rows } = await tickets.listTickets(user, { ...parsed.filters, custom: allTeams, limit: 100 });
    assert.deepEqual(rows.map((r) => r.number).sort(), [N.t1, N.t4, N.t5, N.t6].sort());
    const empty = allTeams.map((c) => ({ ...c, cond: { op: "empty" as const, values: [], arg: "" } }));
    const e = await tickets.listTickets(user, { ...parsed.filters, custom: empty, limit: 100 });
    assert.deepEqual(e.rows.map((r) => r.number).sort(), [N.t3].sort(), "every other ticket of this requester holds a device value");
  });

  test("an archived field still filters, and a saved view that uses it keeps its count", async () => {
    const created = await call(viewsRoute.POST, req("/views", P.agent.session, { name: `Old ${STAMP}`, filters: { view: "all", requester: String(P.req.id), [cfk("old")]: "filled" } }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    viewIds.push(created.body.view.id);
    await cf.updateCustomField(F.old, { archived: true });
    assert.deepEqual(await found({ [cfk("old")]: "filled" }), ["t2"]);
    savedViews.clearViewCountCache();
    const list = await call(viewsRoute.GET, req("/views", P.agent.session));
    assert.equal(list.body.views.find((v: { id: number }) => v.id === created.body.view.id).count, 1);
    // The definitions route marks it; the dialog offers only live fields.
    const defs = await call(fieldsRoute.GET, req("/custom-fields", P.agent.session));
    assert.equal(defs.status, 200);
    assert.equal(defs.body.fields.find((f: { key: string }) => f.key === key("old")).archived, true);
    assert.equal(defs.body.fields.find((f: { key: string }) => f.key === key("device")).archived, false);
    assert.equal((await call(fieldsRoute.GET, req("/custom-fields", P.req.session))).status, 403, "requesters get no definitions");
  });
});

describe("refusals and injection", () => {
  test("unknown key, wrong condition, too many, repeated: 400 with a sentence", async () => {
    assert.match(await refusal({ "cf.nope_nothing": "empty" }), /^There is no custom field with the key "nope_nothing"\./);
    assert.match(await refusal({ [cfk("cost")]: "contains:3" }), /can't be filtered with "contains"/);
    assert.match(await refusal({ [cfk("cost")]: "gte:three" }), /is compared with a number/);
    assert.match(await refusal({ [cfk("due")]: "on:20-11-2026" }), /YYYY-MM-DD/);
    assert.match(await refusal({ [cfk("device")]: "any:tablet" }), /option values, comma-separated: laptop, desktop, phone, dock,usb\./);
    assert.match(await refusal({ [cfk("serial")]: "" }), /Give a condition/);
    const many = new URLSearchParams();
    for (let i = 0; i < 11; i++) many.set(`cf.k${i}`, "empty");
    assert.match((await filtersLib.parseTicketFilters(many) as { error: string }).error, /up to 10 custom fields/);
    const twice = new URLSearchParams();
    twice.append(cfk("serial"), "empty");
    twice.append(cfk("serial"), "filled");
    assert.match((await filtersLib.parseTicketFilters(twice) as { error: string }).error, /One condition per custom field/);
    const r = await call(listRoute.GET, req(`/tickets?${new URLSearchParams({ [cfk("cost")]: "gte:x" })}`, P.agent.session));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /is compared with a number/);
  });

  test("SQL in values and keys is data: nothing breaks, nothing extra matches", async () => {
    const before = (await pool().query("SELECT count(*)::int AS n FROM hd_tickets")).rows[0].n;
    assert.deepEqual(await found({ [cfk("serial")]: "contains:'; DROP TABLE hd_tickets; --" }), []);
    assert.deepEqual(await found({ [cfk("serial")]: "contains:' OR '1'='1" }), []);
    assert.match(await refusal({ [cfk("device")]: "any:laptop' OR '1'='1" }), /option values/);
    assert.match(await refusal({ [`${cfk("device")}' OR 1=1 --`]: "empty" }), /There is no custom field with the key/);
    assert.match(await refusal({ "cf.x\"); DELETE FROM users; --": "empty" }), /There is no custom field/);
    assert.match(await refusal({ [cfk("owner")]: "is:1 OR 1=1" }), /user id/);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_tickets")).rows[0].n >= before, true, "the table is still there");
  });
});

describe("saved views and the desk's list", () => {
  test("a view holds cf.* filters, lists with them and counts them; a bad one is refused", async () => {
    const filters = { view: "all", requester: String(P.req.id), [cfk("device")]: "any:laptop,phone", [cfk("cost")]: "gte:10" };
    const made = await call(viewsRoute.POST, req("/views", P.agent.session, { name: `Phones ${STAMP}`, filters }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    viewIds.push(made.body.view.id);
    assert.deepEqual(made.body.view.filters, filters, "round-trips unchanged");
    savedViews.clearViewCountCache();
    const list = await call(viewsRoute.GET, req("/views", P.agent.session));
    assert.equal(list.body.views.find((v: { id: number }) => v.id === made.body.view.id).count, 1);
    // The list the desk asks for with the view's filters.
    const r = await call(listRoute.GET, req(`/tickets?${new URLSearchParams({ ...filters, sort: "updated" })}`, P.agent.session));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.tickets.map((t: { number: number }) => t.number), [N.t2]);
    const patched = await call(viewRoute.PATCH, req(`/views/${made.body.view.id}`, P.agent.session, { filters: { ...filters, [cfk("cost")]: "lte:10" } }, "PATCH"), { id: String(made.body.view.id) });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.view.filters[cfk("cost")], "lte:10");
    const bad = await call(viewsRoute.POST, req("/views", P.agent.session, { name: `Bad ${STAMP}`, filters: { [cfk("cost")]: "contains:1" } }));
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /can't be filtered with "contains"/);
    const unknown = await call(viewsRoute.POST, req("/views", P.agent.session, { name: `Bad ${STAMP}`, filters: { "c.x": "1" } }));
    assert.equal(unknown.status, 400);
  });

  test("upgrade: a 1.20.7 view (no cf.* keys) still parses and counts; nothing is read for it", async () => {
    const r = await pool().query("INSERT INTO hd_saved_views (name, owner_id, filters, position) VALUES ($1, $2, $3::jsonb, 99) RETURNING id", [
      `Pre ${STAMP}`,
      P.agent.id,
      JSON.stringify({ view: "all", requester: String(P.req.id), tag: "hw" }),
    ]);
    viewIds.push(r.rows[0].id);
    savedViews.clearViewCountCache();
    const list = await call(viewsRoute.GET, req("/views", P.agent.session));
    assert.equal(list.body.views.find((v: { id: number }) => v.id === r.rows[0].id).count, 1);
    const parsed = await filtersLib.parseTicketFilters(new URLSearchParams({ tag: "hw" }));
    assert.ok(parsed.ok && parsed.filters.custom === undefined);
  });
});

describe("API v1 and the Claude connector", () => {
  test("GET /v1/tickets takes cf.<key>=…; a bad one is 400 with a sentence", async () => {
    const made = await call(
      tokensRoute.POST,
      new Request("http://localhost/api/helpdesk/admin/api/tokens", {
        method: "POST",
        headers: { cookie: `compass_session=${P.dadmin.session}`, "content-type": "application/json" },
        body: JSON.stringify({ name: `${STAMP} sync`, role: "agent", team_ids: [T.A], expires_at: null }),
      })
    );
    assert.equal(made.status, 201, JSON.stringify(made.body));
    tokenIds.push(made.body.view.id);
    userIds.push((await pool().query("SELECT principal_id FROM hd_api_tokens WHERE id = $1", [made.body.view.id])).rows[0].principal_id);
    const api = (qs: Record<string, string>) =>
      call(
        v1ListRoute.GET,
        new Request(`http://localhost/api/helpdesk/v1/tickets?${new URLSearchParams(qs)}`, {
          headers: { authorization: `Bearer ${made.body.token}`, "x-forwarded-for": "203.0.113.81" },
        })
      );
    const ok = await api({ view: "all", q: STAMP, [cfk("device")]: "any:laptop,phone", [cfk("billable")]: "no" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.tickets.map((t: { number: number }) => t.number), [N.t2]);
    const bad = await api({ [cfk("billable")]: "maybe" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /can't be filtered with "maybe"\. Use yes, no, empty\./);
    const unknown = await api({ "cf.not_a_field": "empty" });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /There is no custom field with the key "not_a_field"/);
  });

  test("hd_queue takes custom_fields and lists the fields it can filter on", async () => {
    claude.setClaudeLevelForTests("update");
    const user = (await getUserById(P.manager.id))!;
    const ctx = { origin: "http://localhost", ip: null };
    const r = await hdTools.callHelpdeskTool(user, "hd_queue", { view: "all", query: STAMP, custom_fields: { [key("device")]: "any:laptop", [key("cost")]: "eq:5" } }, ctx);
    assert.equal(r.isError, false, r.content[0].text);
    const out = JSON.parse(r.content[0].text);
    assert.deepEqual(out.tickets.map((t: { number: number }) => t.number), [N.t1]);
    assert.ok(out.custom_fields.some((f: { key: string; options?: string[] }) => f.key === key("device") && f.options?.includes("phone")));
    assert.ok(!out.custom_fields.some((f: { key: string }) => f.key === key("old")), "archived fields are not offered");
    const bad = await hdTools.callHelpdeskTool(user, "hd_queue", { custom_fields: { [key("cost")]: "gte:lots" } }, ctx);
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /is compared with a number/);
    const shape = await hdTools.callHelpdeskTool(user, "hd_queue", { custom_fields: [key("cost")] }, ctx);
    assert.equal(shape.isError, true);
    const def = hdTools.HELPDESK_TOOL_DEFS.find((d) => d.name === "hd_queue")!;
    assert.ok((def.inputSchema as { properties: Record<string, unknown> }).properties.custom_fields, "additive: a new argument");
  });
});

describe("the CSV export", () => {
  const exp = (who: string, qs: Record<string, string>) => call(exportRoute.GET, req(`/tickets/export?${new URLSearchParams(qs)}`, P[who].session));
  const rowsOf = (text: string) => parseCsv(text, ",");

  test("only with tickets.export; requesters and agents without it get nothing", async () => {
    assert.equal((await exp("newbie", { view: "all" })).status, 403);
    assert.equal((await exp("req", { view: "all" })).status, 403);
    assert.equal((await exp("agent2", { view: "all", [cfk("cost")]: "gte:x" })).status, 400, "the list's own 400");
  });

  test("BOM, the fixed columns then one per live custom field; values in words; numbers bare; every page", async () => {
    const r = await exp("manager", { view: "all", requester: String(P.req.id), sort: "number" });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.match(r.headers.get("content-type") ?? "", /^text\/csv; charset=utf-8/);
    assert.match(r.headers.get("content-disposition") ?? "", /^attachment; filename="tickets-\d{4}-\d{2}-\d{2}\.csv"$/);
    assert.equal(r.text.charCodeAt(0), 0xfeff, "a BOM for Excel");
    assert.ok(r.text.includes("\r\n"));
    const { header, rows } = rowsOf(r.text);
    assert.deepEqual(header.slice(0, exportShared.TICKET_EXPORT_COLUMNS.length), [...exportShared.TICKET_EXPORT_COLUMNS]);
    for (const n of ["device", "serial", "notes", "cost", "due", "when", "owner", "billable", "site"]) assert.ok(header.includes(`${n} ${STAMP}`), n);
    assert.ok(!header.includes(`old ${STAMP}`), "archived fields are left out");
    assert.equal(rows.length, 7, "all seven of this requester's tickets, not a page");
    assert.equal(r.headers.get("x-compass-export-rows"), "7");
    assert.equal(r.headers.get("x-compass-export-capped"), "0");
    const col = (name: string) => header.indexOf(name);
    const row = (t: string) => rows.find((x) => x[0] === String(N[t]))!;
    const t1 = row("t1");
    assert.equal(t1[col("Subject")], `Laptop "won't" boot, again ${STAMP}`, "commas and quotes survive");
    assert.equal(t1[col("Status")], "Open");
    assert.equal(t1[col("Priority")], "Normal");
    assert.equal(t1[col("Team")], `${STAMP} A`);
    assert.equal(t1[col("Requester")], "Req Person");
    assert.equal(t1[col("Requester email")], `${STAMP}-req@example.test`);
    assert.equal(t1[col("Tags")], "hw, vip");
    assert.equal(t1[col("Channel")], "Get help");
    assert.match(t1[col("Created")], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(t1[col(`device ${STAMP}`)], "Laptop");
    assert.equal(t1[col(`cost ${STAMP}`)], "5");
    assert.equal(t1[col(`due ${STAMP}`)], "2026-11-20");
    assert.equal(t1[col(`when ${STAMP}`)], "2026-11-20 14:00");
    assert.equal(t1[col(`owner ${STAMP}`)], P.agent2.name);
    assert.equal(t1[col(`billable ${STAMP}`)], "Yes");
    assert.equal(t1[col(`site ${STAMP}`)], "South");
    assert.equal(t1[col(`notes ${STAMP}`)], "'-1 line\n+ two, \"three\"", "a newline and quotes inside a cell; a leading - is defused");
    assert.equal(row("t2")[col("Subject")], `'=HYPERLINK("http://x.test") ${STAMP}`, "a formula gets a leading quote");
    assert.equal(row("t2")[col(`billable ${STAMP}`)], "No");
    assert.equal(row("t3")[col("Subject")], `Ünïcode ✓ line one\nline two ${STAMP}`);
    assert.equal(row("t7")[col(`cost ${STAMP}`)], "-3", "a number goes out bare, never quoted as a formula");
    assert.equal(row("t4")[col(`device ${STAMP}`)], "", "a field not on the ticket's team is not filled in");
    assert.equal(row("t4")[col(`site ${STAMP}`)], "North");
    // The raw line keeps the number bare and quotes every text cell.
    const raw = r.text.slice(1).split("\r\n").find((l) => l.startsWith(`${N.t7},`))!;
    assert.ok(raw.includes(",-3"), raw);
  });

  test("a cell or a heading that starts with = + - @, a tab or a CR is defused", async () => {
    await field("risk", { label: `+Risk ${STAMP}`, type: "text" });
    for (const [t, v] of [["t1", "=1+1"], ["t2", "@SUM(A1)"], ["t3", "\tx"], ["t7", "\rcr"]] as const) await value(t, "risk", v);
    try {
      const r = await exp("manager", { view: "all", requester: String(P.req.id), [cfk("risk")]: "filled" });
      const { header, rows } = rowsOf(r.text);
      const c = header.indexOf(`'+Risk ${STAMP}`);
      assert.ok(c > 0, "the heading is defused too");
      assert.deepEqual(rows.map((x) => x[c]).sort(), ["'\tx", "'\rcr", "'=1+1", "'@SUM(A1)"].sort());
    } finally {
      await cf.deleteCustomField(F.risk);
    }
  });

  test("csvCell also defuses a line feed, full-width formula characters, and a formula after spaces or control characters", () => {
    const c = csvLib.csvCell;
    for (const v of ["\nx", "\r=1", "\t@x", "＝1+1", "＋1", "－1", "＠SUM(A1)", "  =1+1", " \t+1", "\u0000=1", "\u0007@x", "\u3000=1", "\u00a0-2", "\ufeff=1"]) {
      assert.equal(c(v), `"'${v.replace(/"/g, '""')}"`, JSON.stringify(v));
    }
    for (const v of [" hello", "a=b", "x+1", "50%", "Ünïcode ✓", ""]) assert.equal(c(v), `"${v}"`, JSON.stringify(v));
  });

  test("a ticket moved to the recycle bin after the plan is not written", async () => {
    const user = (await getUserById(P.manager.id))!;
    const parsed = await filtersLib.parseTicketFilters(new URLSearchParams({ view: "all", requester: String(P.req.id) }));
    assert.ok(parsed.ok);
    const plan = await exportLib.planTicketExport(user, parsed.filters);
    assert.ok(plan.ids.includes(ID.t3));
    await pool().query("UPDATE hd_tickets SET deleted_at = now() WHERE id = $1", [ID.t3]);
    try {
      const reader = (await exportLib.ticketExportStream(plan.ids, "UTC")).getReader();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString("utf8");
      }
      const numbers = parseCsv(text, ",").rows.map((x) => Number(x[0]));
      assert.ok(!numbers.includes(N.t3), "the binned ticket is left out");
      assert.equal(numbers.length, plan.ids.length - 1);
    } finally {
      await pool().query("UPDATE hd_tickets SET deleted_at = NULL WHERE id = $1", [ID.t3]);
    }
  });

  test("the export holds exactly the list: filters, saved view filters, and the exporter's scope", async () => {
    const filtered = await exp("manager", { view: "all", requester: String(P.req.id), [cfk("device")]: "any:laptop,phone" });
    assert.deepEqual(rowsOf(filtered.text).rows.map((x) => Number(x[0])).sort(), [N.t1, N.t2].sort());
    // The agent works teams A and B: t5 (team C) and t6 (no team) are not theirs.
    const scoped = await exp("agent", { view: "all", requester: String(P.req.id) });
    assert.equal(scoped.status, 200);
    const got = rowsOf(scoped.text).rows.map((x) => Number(x[0]));
    assert.ok(!got.includes(N.t5) && !got.includes(N.t6), "never a ticket the list wouldn't show them");
    assert.deepEqual(got.sort(), [N.t1, N.t2, N.t3, N.t4, N.t7].sort());
    const user = (await getUserById(P.agent.id))!;
    const parsed = await filtersLib.parseTicketFilters(new URLSearchParams({ view: "all", requester: String(P.req.id) }));
    assert.ok(parsed.ok);
    assert.equal((await tickets.listTickets(user, { ...parsed.filters, countOnly: true })).total, got.length, "the same count as the list");
  });

  test("each export is audited with the count and the filters, never a ticket's content", async () => {
    await exp("manager", { view: "all", requester: String(P.req.id), [cfk("device")]: "any:laptop" });
    const a = (await pool().query("SELECT target_label, details FROM audit_log WHERE action = 'helpdesk.tickets.exported' AND actor_id = $1 ORDER BY id DESC LIMIT 1", [P.manager.id])).rows[0];
    assert.equal(a.target_label, "1 ticket");
    assert.equal(a.details.count, 1);
    assert.equal(a.details.capped, false);
    assert.equal(a.details.filters[cfk("device")], "any:laptop");
    assert.match(a.details.summary, new RegExp(`device ${STAMP}: Laptop`));
    assert.ok(!JSON.stringify(a.details).includes("boot, again"), "no subject in the audit row");
    assert.equal(audLabels.actionLabel("helpdesk.tickets.exported"), "Exported tickets as CSV");
  });

  test("the cap: at most 10,000 tickets, and the response says it was cut", async () => {
    const extra = await pool().query(
      `INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status, source)
       SELECT 'Bulk ' || g || ' ${STAMP}', $1, 'Req Person', $2, $3, 'solved', 'portal' FROM generate_series(1, $4::int) g RETURNING id`,
      [P.req.id, `${STAMP}-req@example.test`, T.A, exportShared.TICKET_EXPORT_MAX_ROWS]
    );
    const ids = extra.rows.map((r) => r.id as number);
    try {
      const r = await exp("manager", { view: "all", requester: String(P.req.id) });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-compass-export-capped"), "1");
      assert.equal(r.headers.get("x-compass-export-rows"), String(exportShared.TICKET_EXPORT_MAX_ROWS));
      assert.equal(r.headers.get("x-compass-export-total"), String(exportShared.TICKET_EXPORT_MAX_ROWS + 7));
      assert.equal(rowsOf(r.text).rows.length, exportShared.TICKET_EXPORT_MAX_ROWS);
      const a = (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.tickets.exported' AND actor_id = $1 ORDER BY id DESC LIMIT 1", [P.manager.id])).rows[0];
      assert.equal(a.details.capped, true);
    } finally {
      await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [ids]);
    }
  });
});
