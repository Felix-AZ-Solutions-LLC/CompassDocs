// Helpdesk 1.20.34: "Hold until the event" (lib/helpdesk/desk-calendar-park
// and its -shared half). The wake maths (working days, whole days in the
// desk's zone, the setup lead time, a ticket's own prep window, holidays, a
// calendar with no open hours, the too-close refusal); parking and waking
// from the desk, the API and the Claude connector, with who may; the views
// and counts; the SLA pause and resume; no reminders and no auto-close while
// parked; the minute sweep and its claim across instances; what wakes it
// (the requester, the event cancelled, removed or moved near, a status
// change, Wake now) and what doesn't (an agent's reply, note or field
// change); the event moving; auto-park after the acknowledgement for meeting
// invites and calendar request types; updated and cancelled invites threading
// into the same ticket, and a stranger's same-UID invite touching nothing;
// the requester's Scheduled view and their optional reminder; the reports'
// counts; the upgrade.
//
// Same harness as test/helpdesk-event-calendar: next/headers and lib/ee
// stubbed, routes called with real sessions. Parallel-safe on a shared
// database: everything is in this file's own teams (STAMP), every sweep is
// limited to this file's tickets, and the calendar settings this file needs
// are set for this process only (setCalendarSettingsForTests), never stored.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-event-parking.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { lockWorkspaceMail, type WorkspaceMailLock } from "./support/mail-lock";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession, getUserById } from "../src/lib/db";
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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-event-parking.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-event-parking.virtual.js");
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
const cal = require("../src/lib/helpdesk/desk-calendar") as typeof import("../src/lib/helpdesk/desk-calendar");
const shared = require("../src/lib/helpdesk/desk-calendar-shared") as typeof import("../src/lib/helpdesk/desk-calendar-shared");
const pk = require("../src/lib/helpdesk/desk-calendar-park") as typeof import("../src/lib/helpdesk/desk-calendar-park");
const pks = require("../src/lib/helpdesk/desk-calendar-park-shared") as typeof import("../src/lib/helpdesk/desk-calendar-park-shared");
const icsMod = require("../src/lib/helpdesk/desk-calendar-ics") as typeof import("../src/lib/helpdesk/desk-calendar-ics");
const schema = require("../src/lib/helpdesk/desk-calendar-schema") as typeof import("../src/lib/helpdesk/desk-calendar-schema");
const db = require("../src/lib/db") as typeof import("../src/lib/db");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const messages = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
const requestTypes = require("../src/lib/helpdesk/request-types") as typeof import("../src/lib/helpdesk/request-types");
const calendars = require("../src/lib/helpdesk/calendars") as typeof import("../src/lib/helpdesk/calendars");
const retention = require("../src/lib/helpdesk/retention") as typeof import("../src/lib/helpdesk/retention");
const dbSla = require("../src/lib/helpdesk/db-sla") as typeof import("../src/lib/helpdesk/db-sla");
const reminders = require("../src/lib/helpdesk/desk-calendar-reminders") as typeof import("../src/lib/helpdesk/desk-calendar-reminders");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const outboxShared = require("../src/lib/mail-outbox-shared") as typeof import("../src/lib/mail-outbox-shared");
const inbound = require("../src/lib/helpdesk/inbound") as typeof import("../src/lib/helpdesk/inbound");
const notify = require("../src/lib/helpdesk/notify") as typeof import("../src/lib/helpdesk/notify");
const hooks = require("../src/lib/helpdesk/webhooks") as typeof import("../src/lib/helpdesk/webhooks");
const claude = require("../src/lib/helpdesk/claude-connector") as typeof import("../src/lib/helpdesk/claude-connector");
const hdTools = require("../src/lib/mcp/helpdesk-tools") as typeof import("../src/lib/mcp/helpdesk-tools");
const detail = require("../src/lib/helpdesk/detail") as typeof import("../src/lib/helpdesk/detail");
const periodic = require("../src/lib/periodic") as typeof import("../src/lib/periodic");
const mdi = require("../src/lib/helpdesk/md-inline") as typeof import("../src/lib/helpdesk/md-inline");
const conv = require("../src/lib/helpdesk/conversation-shared") as typeof import("../src/lib/helpdesk/conversation-shared");
const assignStore = require("../src/lib/helpdesk/assignment/store") as typeof import("../src/lib/helpdesk/assignment/store");
const assignEngine = require("../src/lib/helpdesk/assignment/engine") as typeof import("../src/lib/helpdesk/assignment/engine");
const ticketFilters = require("../src/lib/helpdesk/ticket-filters") as typeof import("../src/lib/helpdesk/ticket-filters");
const savedShared = require("../src/lib/helpdesk/saved-views-shared") as typeof import("../src/lib/helpdesk/saved-views-shared");
const analytics = require("../src/lib/helpdesk/analytics/engine") as typeof import("../src/lib/helpdesk/analytics/engine");
const eventRoute = require("../src/app/api/helpdesk/tickets/[number]/event/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/event/route");
const parkRoute = require("../src/app/api/helpdesk/tickets/[number]/event/park/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/event/park/route");
const ticketRoute = require("../src/app/api/helpdesk/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/route");
const messagesRoute = require("../src/app/api/helpdesk/tickets/[number]/messages/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/messages/route");
const requestRoute = require("../src/app/api/helpdesk/requests/[number]/route") as typeof import("../src/app/api/helpdesk/requests/[number]/route");
const requestMsgRoute = require("../src/app/api/helpdesk/requests/[number]/messages/route") as typeof import("../src/app/api/helpdesk/requests/[number]/messages/route");
const tokensRoute = require("../src/app/api/helpdesk/admin/api/tokens/route") as typeof import("../src/app/api/helpdesk/admin/api/tokens/route");
const v1TicketRoute = require("../src/app/api/helpdesk/v1/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/v1/tickets/[number]/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdBusinessHours, HdFormField } from "../src/lib/helpdesk/types";
import type { InboundEmail } from "../src/lib/helpdesk/inbound-parse";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, req: Request, params: Record<string, string> = {}): Promise<{ status: number; body: any; text: string }> {
  currentRequest = req;
  try {
    const res = await (handler as Handler)(req, { params: Promise.resolve(params) });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body, text };
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

const STAMP = `hdpk-${Date.now()}-${process.pid}`;
const ALIAS = `${STAMP}-rooms@example.test`;
const P: Record<string, { id: number; session: string; name: string; email: string }> = {};
const userIds: number[] = [];
const T: Record<string, number> = {};
const typeIds: number[] = [];
const ticketIds: number[] = [];
const tokenIds: number[] = [];
const hookIds: number[] = [];
const deliveries: { userId: number; event: string; title: string; email?: string }[] = [];
const mails: { to: string; subject: string; text: string }[] = [];

async function person(key: string, deskRole: string | null, timezone = "") {
  const name = `${key} ${STAMP}`;
  const mail = `${STAMP}-${key}@example.test`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status, timezone) VALUES ($1, $2, $3, 'viewer', 'active', $4) RETURNING id`, [`${STAMP}-${key}`, name, mail, timezone]);
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  userIds.push(id);
  if (deskRole) await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [id, deskRole]);
  P[key] = { id, session, name, email: mail };
}

async function ticket(subject: string, extra: { team?: string; status?: string; assignee?: number | null; requesterEmail?: string } = {}): Promise<{ id: number; number: number }> {
  const outside = extra.requesterEmail !== undefined;
  const r = await pool().query(
    "INSERT INTO hd_tickets (subject, requester_id, requester_name, requester_email, team_id, status, source, assignee_id) VALUES ($1, $2, 'Req Person', $3, $4, $5, 'portal', $6) RETURNING id, number",
    [`${subject} ${STAMP}`, outside ? null : P.req.id, outside ? extra.requesterEmail : P.req.email, T[extra.team ?? "A"], extra.status ?? "open", extra.assignee ?? null]
  );
  ticketIds.push(r.rows[0].id);
  return r.rows[0];
}

const lines = async (ticketId: number) =>
  (await pool().query("SELECT kind, body, via, event, author_name FROM hd_messages WHERE ticket_id = $1 ORDER BY id", [ticketId])).rows as { kind: string; body: string; via: string; event: string | null; author_name: string }[];
const rowOf = async (id: number) => (await pool().query("SELECT * FROM hd_tickets WHERE id = $1", [id])).rows[0];
const iso = (v: unknown) => new Date(v as string).toISOString();
const DAY = 86_400_000;
let HOURS: HdBusinessHours;
let TZ = "UTC";

const putEvent = (who: string, n: number, body: Record<string, unknown>) => call(eventRoute.PUT, req(`/tickets/${n}/event`, P[who].session, body, "PUT"), { number: String(n) });
const delEvent = (who: string, n: number) => call(eventRoute.DELETE, req(`/tickets/${n}/event`, P[who].session, undefined, "DELETE"), { number: String(n) });
const park = (who: string, n: number, body: Record<string, unknown>) => call(parkRoute.POST, req(`/tickets/${n}/event/park`, P[who].session, body), { number: String(n) });
const parkView = (who: string, n: number, q = "") => call(parkRoute.GET, req(`/tickets/${n}/event/park${q}`, P[who].session), { number: String(n) });
const patch = (who: string, n: number, body: Record<string, unknown>) => call(ticketRoute.PATCH, req(`/tickets/${n}`, P[who].session, body, "PATCH"), { number: String(n) });
const send = (who: string, n: number, body: Record<string, unknown>) => call(messagesRoute.POST, req(`/tickets/${n}/messages`, P[who].session, body), { number: String(n) });
const actor = () => ({ id: P.agent.id, name: P.agent.name });

/** A timed event `days` ahead of now (at 14:00 UTC that day), 90 minutes long. */
const ahead = (days: number, minutes = 90) => {
  const d = new Date(Date.now() + days * DAY);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 14, 0);
  return { starts_at: new Date(start).toISOString(), ends_at: new Date(start + minutes * 60_000).toISOString() };
};
/** A ticket with an event `days` ahead; assigned to the agent unless said otherwise. */
async function eventTicket(subject: string, days = 90, extra: { assignee?: number | null; setup?: number; place?: string } = {}) {
  const t = await ticket(subject, { assignee: extra.assignee === undefined ? P.agent.id : extra.assignee });
  const r = await putEvent("agent", t.number, { ...ahead(days), place: extra.place ?? `Room 4 ${STAMP}`, setup_minutes: extra.setup ?? 30 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return t;
}
/** The wake time the desk works out for this ticket's event now. */
async function expectedWake(ticketId: number, prep = 10): Promise<string> {
  const e = (await cal.getTicketEvent(ticketId))!;
  return new Date(pks.wakeInstant(e, prep, HOURS)).toISOString();
}
const sweepAt = (when: string | number, ids: number[]) => pk.parkSweep(new Date(typeof when === "number" ? when : Date.parse(when) + 60_000), { only: ids });

let mailLock: WorkspaceMailLock | null = null;

before(async () => {
  mailLock = await lockWorkspaceMail("shared");
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(roles.HD_DEFAULT_MATRIX);
  email.setHelpdeskTransportForTests(async (m) => {
    mails.push({ to: m.to, subject: m.subject, text: m.text });
  });
  hooks.setWebhookAutoSendForTests(false);
  notify.setAgentDeliverySpyForTests((userId, event, p) => deliveries.push({ userId, event, title: p.title, email: p.email?.template }));
  inbound.resetInboundRateLimitsForTests();
  // The settings this file relies on, in this process only: parking as shipped (the stored row is shared).
  cal.setCalendarSettingsForTests({ park_prep_days: 10, park_invites: true, park_request_types: true, remind_requester: false, remind_requester_days: 2 });
  T.A = (await fixtureQuery("INSERT INTO hd_teams (name, email_alias, position) VALUES ($1, $2, 9421) RETURNING id", [`${STAMP} A`, ALIAS])).rows[0].id;
  T.B = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9421) RETURNING id", [`${STAMP} B`])).rows[0].id;
  T.C = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9421) RETURNING id", [`${STAMP} C`])).rows[0].id;
  HOURS = await calendars.hoursForTeam(T.A);
  TZ = HOURS.timezone;
  await person("agent", "agent", "UTC");
  await person("agent2", "agent");
  await person("newbie", "newbie");
  await person("other", "agent");
  await person("dadmin", "admin");
  await person("req", null, "UTC");
  await person("org", null, "UTC");
  await person("stranger", null);
  await pool().query(
    "INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($1, $3, 'agent'), ($1, $4, 'agent'), ($5, $6, 'agent'), ($5, $2, 'agent')",
    [T.A, P.agent.id, P.agent2.id, P.newbie.id, T.B, P.other.id]
  );
});

after(async () => {
  cal.setCalendarSettingsForTests(null);
  roles.setRoleMatrixForTests(null);
  claude.setClaudeLevelForTests(null);
  await email.helpdeskMailSettledForTests().catch(() => {});
  email.setHelpdeskTransportForTests(null);
  hooks.setWebhookAutoSendForTests(true);
  notify.setAgentDeliverySpyForTests(null);
  const more = await pool().query("SELECT id FROM hd_tickets WHERE team_id = ANY($1) OR requester_email LIKE $2", [Object.values(T), `${STAMP}%`]);
  const all = [...new Set([...ticketIds, ...more.rows.map((r) => r.id as number)])];
  await pool().query("DELETE FROM hd_webhooks WHERE id = ANY($1) OR name LIKE $2", [hookIds, `${STAMP}%`]);
  await pool().query("UPDATE hd_tickets SET workflow_run_id = NULL, parent_ticket_id = NULL, merged_into = NULL WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_workflow_runs WHERE ticket_id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_request_types WHERE id = ANY($1)", [typeIds]);
  await pool().query("DELETE FROM hd_api_tokens WHERE id = ANY($1) OR name LIKE $2", [tokenIds, `${STAMP}%`]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [Object.values(T)]);
  await pool().query("DELETE FROM hd_calendars WHERE name LIKE $1", [`${STAMP}%`]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR target_label LIKE $2", [userIds, `%${STAMP}%`]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await mailLock?.release(email);
  await pool().end();
});

// =======================================================================================

describe("the wake time (pure)", () => {
  const LONDON: HdBusinessHours = { timezone: "Europe/London", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", holidays: [] };
  const ev = (starts_at: string, setup = 0, all_day = false, start_date: string | null = null) => ({ starts_at, all_day, start_date, setup_minutes: setup });

  test("working days before the day setup is due, at the day's opening; the day itself never counts; weekends and holidays are passed over", () => {
    const w = (e: ReturnType<typeof ev>, prep: number, h = LONDON) => new Date(pks.wakeInstant(e, prep, h)).toISOString();
    // Sun 15 Mar 2026, 10:00 London: ten working days back is Mon 2 Mar, at 09:00 (GMT).
    assert.equal(w(ev("2026-03-15T10:00:00Z"), 10), "2026-03-02T09:00:00.000Z");
    assert.equal(w(ev("2026-03-15T10:00:00Z"), 1), "2026-03-13T09:00:00.000Z", "Friday");
    // A setup lead time of three days: ready Thu 12 Mar, so one working day before is Wed 11 Mar.
    assert.equal(w(ev("2026-03-15T10:00:00Z", 3 * 1440), 1), "2026-03-11T09:00:00.000Z");
    // A holiday on Fri 13 Mar is passed over.
    assert.equal(w(ev("2026-03-15T10:00:00Z"), 1, { ...LONDON, holidays: ["2026-03-13"] }), "2026-03-12T09:00:00.000Z");
    // Summer time: the opening is 09:00 BST.
    assert.equal(w(ev("2026-07-15T10:00:00Z"), 2), "2026-07-13T08:00:00.000Z");
    // No prep window: the moment setup is due.
    assert.equal(w(ev("2026-03-15T10:00:00Z", 30), 0), "2026-03-15T09:30:00.000Z");
    // A calendar with no open hours counts calendar days back from that moment.
    assert.equal(w(ev("2026-03-15T10:00:00Z", 30), 3, { ...LONDON, days: [] }), "2026-03-12T09:30:00.000Z");
  });

  test("an all-day event starts at the start of its first day in the desk's zone, whatever zone it was entered in", () => {
    const e = ev("2026-03-14T23:00:00Z", 0, true, "2026-03-15");
    assert.equal(new Date(pks.wakeInstant(e, 0, LONDON)).toISOString(), "2026-03-15T00:00:00.000Z");
    // New York is on summer time from 8 March: its midnight is 04:00 UTC.
    assert.equal(new Date(pks.wakeInstant(e, 0, { ...LONDON, timezone: "America/New_York" })).toISOString(), "2026-03-15T04:00:00.000Z");
    assert.equal(new Date(pks.wakeInstant({ ...e, setup_minutes: 120 }, 0, LONDON)).toISOString(), "2026-03-14T22:00:00.000Z", "less the setup lead time");
  });

  test("too close to park: past, or within the hour; the sentence says today or the day", () => {
    const now = Date.parse("2026-03-10T12:00:00Z");
    assert.equal(pks.tooCloseToPark(now + 2 * 3_600_000, now, "UTC"), null);
    assert.equal(pks.tooCloseToPark(now + 30 * 60_000, now, "UTC"), "This event is too close to park: it would wake today.");
    assert.equal(pks.tooCloseToPark(now - 3_600_000, now, "UTC"), "This event is too close to park: it would wake today.");
    assert.equal(pks.tooCloseToPark(Date.parse("2026-03-02T09:00:00Z"), now, "UTC"), "This event is too close to park: it would have woken on Mon 2 Mar.");
  });

  test("the words: the Parked chip, the requester's Scheduled chip, the prep window; checks", () => {
    const now = Date.parse("2026-01-10T12:00:00Z");
    const e = { starts_at: "2026-03-15T10:00:00Z", all_day: false, start_date: null, place: "Room 4" };
    assert.equal(pks.parkedChipLabel("2026-03-03T09:00:00Z", e, "Europe/London", now), "Parked until Tue 3 Mar · for the event on Sun 15 Mar");
    assert.equal(pks.scheduledLabel(e, "Europe/London", false, now), "Scheduled · Sun 15 Mar, 10:00 · Room 4");
    assert.equal(pks.scheduledLabel({ ...e, place: "" }, "America/New_York", true, now), "Scheduled · Sun 15 Mar, 6:00 AM");
    assert.equal(pks.scheduledLabel({ ...e, all_day: true, start_date: "2026-03-15" }, "UTC", false, now), "Scheduled · Sun 15 Mar · Room 4");
    assert.equal(pks.eventDay({ ...e, starts_at: "2027-03-15T10:00:00Z" }, "UTC", now), "Mon 15 Mar 2027", "another year says so");
    assert.deepEqual([pks.prepLabel(0), pks.prepLabel(1), pks.prepLabel(10)], ["no prep time", "1 working day", "10 working days"]);
    assert.deepEqual(pks.checkPrepDays(null), { ok: true, value: null });
    assert.deepEqual(pks.checkPrepDays("5"), { ok: true, value: 5 });
    for (const bad of [-1, 61, 2.5, "x", true]) assert.equal(pks.checkPrepDays(bad).ok, false, String(bad));
    // The settings: defaults, and what a save may send.
    const d = shared.resolveCalendarSettings(null);
    assert.deepEqual([d.park_prep_days, d.park_invites, d.park_request_types, d.remind_requester, d.remind_requester_days], [10, true, true, false, 2]);
    assert.equal(shared.checkCalendarSettings({ park_prep_days: 61 }, d).ok, false);
    assert.equal(shared.checkCalendarSettings({ park_invites: "yes" }, d).ok, false);
    assert.equal(shared.checkCalendarSettings({ remind_requester_days: 0 }, d).ok, false);
    const ok = shared.checkCalendarSettings({ park_prep_days: 0, park_invites: false, remind_requester: true, remind_requester_days: 7 }, d);
    assert.ok(ok.ok && ok.value.park_prep_days === 0 && !ok.value.park_invites && ok.value.remind_requester && ok.value.remind_requester_days === 7);
    // The activity line's icon.
    const icon = (body: string, author = "Helpdesk") => conv.activityIcon({ kind: "internal", body, author_name: author, event: "change", via: "system" } as never);
    assert.equal(icon("Woke for the event on Sun 15 Mar"), "park");
    assert.equal(icon("Ana parked the ticket until Tue 3 Mar", "Ana"), "park");
  });
});

// =======================================================================================

describe("park and wake", () => {
  test("Hold until the event: who may; on hold with the wake time, the clocks paused; one agents-only activity line, an audit row and the webhook", async () => {
    const hook = await pool().query("INSERT INTO hd_webhooks (name, url, events, team_ids, secret_sealed) VALUES ($1, 'https://hooks.example.test/p', '{ticket.updated}', $2, 'sealed') RETURNING id", [`${STAMP} hook`, [T.A]]);
    hookIds.push(hook.rows[0].id);
    const t = await eventTicket("Board meeting");
    // The Event block's view: it can be parked, and when it would wake.
    const view = await parkView("agent", t.number);
    assert.equal(view.status, 200);
    assert.deepEqual([view.body.can_park, view.body.can_change, view.body.parked_until, view.body.prep_days, view.body.preview.refusal], [true, true, null, 10, null]);
    assert.equal(view.body.preview.wake_at, await expectedWake(t.id));
    assert.equal((await parkView("agent", t.number, "?prep_days=3")).body.preview.wake_at, await expectedWake(t.id, 3));
    assert.equal((await parkView("agent", t.number, "?prep_days=99")).status, 400);
    const ev = await call(eventRoute.GET, req(`/tickets/${t.number}/event`, P.agent.session), { number: String(t.number) });
    assert.equal(ev.body.parking.can_park, true, "the Event block reads it with the event");
    // Who: not a newbie (no Change status), not an agent of another team (404, as if it did not exist).
    assert.equal((await park("newbie", t.number, { action: "park" })).status, 403);
    assert.equal((await park("other", t.number, { action: "park" })).status, 404);
    assert.equal((await parkView("newbie", t.number)).body.can_park, false);
    assert.equal((await park("agent", t.number, { action: "nap" })).status, 400);
    const before = await rowOf(t.id);
    const r = await park("agent", t.number, { action: "park" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = await rowOf(t.id);
    assert.deepEqual([row.status, iso(row.parked_until), row.park_reason, row.park_prep_days, !!row.sla_paused_at, !!row.parked_at], ["on_hold", await expectedWake(t.id), "agent", null, true, true]);
    assert.equal(before.sla_paused_at, null);
    const l = (await lines(t.id)).at(-1)!;
    assert.deepEqual([l.kind, l.via, l.event], ["internal", "system", "change"]);
    assert.match(l.body, new RegExp(`^${P.agent.name.replace(/[-]/g, "\\-")} parked the ticket until .* for the event on .*: it wakes 10 working days before the event's setup is due$`));
    assert.ok(!(await lines(t.id)).some((x) => x.kind === "system" && /On hold/.test(x.body)), "no requester-visible status line");
    const audit = (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.ticket.parked' AND target_id = $1", [String(t.id)])).rows[0];
    assert.deepEqual([audit.details.reason, audit.details.prep_days, audit.details.from_status], ["agent", 10, "open"]);
    const hooked = (await pool().query("SELECT payload FROM hd_webhook_deliveries WHERE hook_id = $1 AND ticket_id = $2 AND event = 'ticket.updated' ORDER BY id DESC LIMIT 1", [hook.rows[0].id, t.id])).rows[0];
    assert.ok(hooked, "ticket.updated is queued");
    // Parked already: refused, nothing changes.
    const again = await park("agent", t.number, { action: "park" });
    assert.deepEqual([again.status, again.body.error], [409, "This ticket is already parked. Change its prep window, or wake it."]);
    // The ticket detail and the header's data.
    const d = await detail.ticketDetail({ id: P.agent.id, role: "viewer" }, (await tickets.getTicketById(t.id))!, true);
    assert.equal(d.parking?.parked_until, iso(row.parked_until));
  });

  test("refused with one plain sentence when the event is too close, missing, cancelled, or the ticket solved; the ticket stays as it is", async () => {
    const near = await eventTicket("Too close", 2);
    const r = await park("agent", near.number, { action: "park" });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /^This event is too close to park: it would (wake today|have woken on \w{3} \d{1,2} \w{3})\.$/);
    assert.deepEqual([(await rowOf(near.id)).status, (await rowOf(near.id)).parked_until], ["open", null]);
    // With no prep window it parks until setup is due (30 minutes before the start, two days ahead).
    const zero = await park("agent", near.number, { action: "park", prep_days: 0 });
    assert.equal(zero.status, 200, JSON.stringify(zero.body));
    assert.deepEqual([iso((await rowOf(near.id)).parked_until), (await rowOf(near.id)).park_prep_days], [await expectedWake(near.id, 0), 0]);
    const none = await ticket("No event");
    assert.equal((await park("agent", none.number, { action: "park" })).body.error, "This ticket has no event to hold it for. Add the event first.");
    const gone = await eventTicket("Cancelled");
    await cal.cancelTicketEvent(gone.id, actor(), "Cancelled by hand.");
    assert.equal((await park("agent", gone.number, { action: "park" })).body.error, "The event was cancelled, so there is nothing to hold this ticket for.");
    const solved = await eventTicket("Solved");
    await pool().query("UPDATE hd_tickets SET status = 'solved', solved_at = now() WHERE id = $1", [solved.id]);
    assert.equal((await park("agent", solved.number, { action: "park" })).body.error, "A solved or closed ticket can't be parked. Reopen it first.");
  });

  test("out of every view of open work and counted in Parked, soonest to wake first; Reports leave it out of open work and count it apart", async () => {
    const later = await eventTicket("View later", 120);
    const sooner = await eventTicket("View sooner", 60);
    const working = await eventTicket("View working", 90);
    for (const t of [later, sooner]) assert.equal((await park("agent", t.number, { action: "park" })).status, 200);
    const user = { id: P.agent.id, role: "viewer" as const };
    const nums = async (f: Parameters<typeof tickets.listTickets>[1]) => (await tickets.listTickets(user, { ...f, team_id: T.A, limit: 200 })).rows.map((r) => r.number);
    for (const view of ["open", "mine", "waiting", "overdue", "workflow"] as const) {
      const n = await nums({ view });
      assert.ok(!n.includes(later.number) && !n.includes(sooner.number), view);
    }
    assert.ok((await nums({ view: "open" })).includes(working.number));
    assert.ok(!(await nums({ view: { team_id: T.A } })).includes(sooner.number), "the team's view");
    const parkedList = (await tickets.listTickets(user, { view: "parked", team_id: T.A, limit: 200 })).rows;
    const order = parkedList.map((r) => r.number).filter((n) => n === later.number || n === sooner.number);
    assert.deepEqual(order, [sooner.number, later.number], "soonest to wake first");
    const row = parkedList.find((r) => r.number === sooner.number)!;
    assert.equal(iso(row.parked_until), await expectedWake(sooner.id));
    assert.equal(iso(row.parked_event!.starts_at), iso((await cal.getTicketEvent(sooner.id))!.starts_at));
    assert.deepEqual(tickets.parseView("parked"), "parked");
    const counts = await tickets.countViews(user);
    assert.ok(counts.views.parked >= 2 && counts.headline.parked === counts.views.parked);
    const teamOpen = counts.teams.find((t) => t.team_id === T.A)!.open;
    const realOpen = (await pool().query("SELECT count(*)::int AS n FROM hd_tickets WHERE team_id = $1 AND status IN ('new','open','pending','on_hold') AND parked_until IS NULL AND deleted_at IS NULL", [T.A])).rows[0].n;
    assert.equal(teamOpen, realOpen, "the team's open count leaves parked tickets out");
    assert.ok((await nums({ status_group: "parked", view: "all" })).includes(sooner.number));
    assert.ok(!(await nums({ status_group: "open", view: "all" })).includes(sooner.number));
    // Reports: Open now leaves them out and says "Parked: N" beside it; Parked now counts them.
    const viewer = (await getUserById(P.dadmin.id))!;
    const filters = { team: [T.A] } as never;
    const open = await analytics.runQuery({ measure: "open_now", groupBy: [], filters, range: { preset: "today" } } as never, viewer as never, { fresh: true });
    const parkedNow = await analytics.runQuery({ measure: "parked_now", groupBy: [], filters, range: { preset: "today" } } as never, viewer as never, { fresh: true });
    assert.equal(open.total.value, realOpen);
    assert.equal(parkedNow.total.value, (await pool().query("SELECT count(*)::int AS n FROM hd_tickets WHERE team_id = $1 AND parked_until IS NOT NULL AND status = 'on_hold' AND deleted_at IS NULL", [T.A])).rows[0].n);
    assert.deepEqual(open.aside, { label: "Parked", value: parkedNow.total.value });
  });

  test("while parked: the clocks are paused (no breach), no setup reminder, no auto-close; on waking the clocks resume", async () => {
    const t = await eventTicket("Clocks", 60);
    const due = new Date(Date.now() + 2 * 3_600_000).toISOString();
    await pool().query("UPDATE hd_tickets SET first_reply_due = $2, resolve_due = $2 WHERE id = $1", [t.id, due]);
    assert.equal((await park("agent", t.number, { action: "park" })).status, 200);
    const parked = await rowOf(t.id);
    // A day later: nothing breaches.
    const later = new Date(Date.now() + DAY);
    const sla = await dbSla.claimSlaEvents(later, [t.id]);
    assert.ok(!sla.events.some((e) => e.ticket_id === t.id));
    assert.equal((await rowOf(t.id)).first_reply_breached_at, null);
    // The setup reminders, at a time one is due: none while parked (it goes once the ticket wakes).
    const e = (await cal.getTicketEvent(t.id))!;
    const reminderAt = new Date(Date.parse(e.ready_at) - 30 * 60_000);
    assert.deepEqual((await reminders.eventReminderSweep(reminderAt, { only: [t.id] })).sent, []);
    // Auto-close reads only solved tickets: the plan (which takes no lock, so other files' runs are not held up) closes nothing.
    const plan = await retention.planRetention({ at: new Date(Date.now() + 400 * DAY), only: [t.id], settings: { ...(await retention.getRetentionSettings()), auto_close_enabled: true, retention_enabled: false } });
    assert.deepEqual([plan.counts.close, (await rowOf(t.id)).status], [0, "on_hold"]);
    // Wake: open, paused time banked, the clock running again.
    const wakeAt = Date.parse(parked.parked_until) + 60_000;
    const r = await sweepAt(wakeAt, [t.id]);
    assert.deepEqual(r.woke, [t.id]);
    const after = await rowOf(t.id);
    assert.deepEqual([after.status, after.parked_until, after.sla_paused_at, after.park_reason], ["open", null, null, ""]);
    assert.ok(Number(after.sla_paused_ms) >= wakeAt - Date.parse(parked.sla_paused_at) - 1000, "the parked time is banked");
    const policy = await calendars.slaPolicyForTeam(after.priority, T.A);
    if (policy) assert.ok(Date.parse(after.resolve_due) > Date.parse(due), "the resolution due moved on by the time it was paused");
    assert.deepEqual((await reminders.eventReminderSweep(reminderAt, { only: [t.id] })).sent.map((s) => s.ticket_id), [t.id], "now the reminder goes");
  });

  test("the wake sweep: not before its time; then back to open with \"Woke for the event on …\", the owner told (else the team), the audit row; registered every minute", async () => {
    const mine = await eventTicket("Wake owner", 60);
    const team = await eventTicket("Wake team", 61, { assignee: null });
    for (const t of [mine, team]) assert.equal((await park("agent", t.number, { action: "park" })).status, 200);
    const w1 = (await rowOf(mine.id)).parked_until as string;
    const w2 = (await rowOf(team.id)).parked_until as string;
    assert.deepEqual((await pk.parkSweep(new Date(Date.parse(w1) - 60_000), { only: [mine.id, team.id] })).woke, []);
    deliveries.length = 0;
    const sweepTime = Math.max(Date.parse(w1), Date.parse(w2)) + 60_000;
    const r = await pk.parkSweep(new Date(sweepTime), { only: [mine.id, team.id] });
    assert.deepEqual(r.woke.sort(), [mine.id, team.id].sort());
    const day = pks.eventDay((await cal.getTicketEvent(mine.id))!, TZ, sweepTime);
    const last = (await lines(mine.id)).at(-1)!;
    assert.deepEqual([last.body, last.kind, last.author_name], [`Woke for the event on ${mdi.mdInline(day)}`, "internal", "Helpdesk"]);
    assert.equal((await rowOf(mine.id)).status, "open");
    const toOwner = deliveries.filter((d) => d.title.startsWith(`#${mine.number}:`));
    assert.deepEqual(toOwner.map((d) => [d.userId, d.event, d.email]), [[P.agent.id, "event_reminder", "hd_event_reminder"]]);
    const toTeam = deliveries.filter((d) => d.title.startsWith(`#${team.number}:`)).map((d) => d.userId).sort();
    assert.deepEqual(toTeam, [P.agent.id, P.agent2.id, P.newbie.id].sort(), "nobody owns it: its team");
    const audit = (await pool().query("SELECT details FROM audit_log WHERE action = 'helpdesk.ticket.woke' AND target_id = $1", [String(mine.id)])).rows[0];
    assert.equal(audit.details.why, "due");
    assert.ok(periodic.HELPDESK_SWEEPS.some((s) => s.name === "hd_event_park"));
  });

  test("several instances: each due ticket is woken exactly once", async () => {
    const ts = [await eventTicket("Race 1", 70), await eventTicket("Race 2", 71), await eventTicket("Race 3", 72)];
    for (const t of ts) assert.equal((await park("agent", t.number, { action: "park" })).status, 200);
    const ids = ts.map((t) => t.id);
    const at = new Date(Date.now() + 200 * DAY);
    const runs = await Promise.all([pk.parkSweep(at, { only: ids }), pk.parkSweep(at, { only: ids }), pk.parkSweep(at, { only: ids })]);
    assert.deepEqual(runs.flatMap((r) => r.woke).sort(), [...ids].sort(), "each once in all");
    for (const id of ids) assert.equal((await lines(id)).filter((l) => l.body.startsWith("Woke for the event")).length, 1);
    // Two direct claims of one ticket: one wins.
    const one = await eventTicket("Race 4", 73);
    await park("agent", one.number, { action: "park" });
    const both = await Promise.all([pk.wakeTicket(one.id, { id: null, name: "Helpdesk" }, { why: "due", dueOnly: true, now: at }), pk.wakeTicket(one.id, { id: null, name: "Helpdesk" }, { why: "due", dueOnly: true, now: at })]);
    assert.equal(both.filter(Boolean).length, 1);
  });

  test("the requester (or someone copied) writing wakes it; an agent's reply, note or field change doesn't; a status change ends the parking", async () => {
    const t = await eventTicket("Requester writes", 80);
    await park("agent", t.number, { action: "park" });
    assert.equal((await send("agent", t.number, { kind: "internal", body: "Booked the projector." })).status, 201);
    assert.equal((await send("agent", t.number, { kind: "public", body: "All in hand, we'll be in touch nearer the day." })).status, 201);
    assert.equal((await patch("agent", t.number, { priority: "high" })).status, 200);
    assert.deepEqual([(await rowOf(t.id)).status, !!(await rowOf(t.id)).parked_until], ["on_hold", true], "still parked");
    const r = await call(requestMsgRoute.POST, req(`/requests/${t.number}/messages`, P.req.session, { body: "Can we add ten more chairs?" }), { number: String(t.number) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const row = await rowOf(t.id);
    assert.deepEqual([row.status, row.parked_until, row.sla_paused_at], ["open", null, null]);
    assert.ok((await lines(t.id)).some((l) => l.kind === "internal" && /^Woke for a new message from the requester/.test(l.body)));
    // On hold without parking stays on hold when the requester writes (as before).
    const held = await ticket("Plain hold", { status: "on_hold" });
    await call(requestMsgRoute.POST, req(`/requests/${held.number}/messages`, P.req.session, { body: "Any news?" }), { number: String(held.number) });
    assert.equal((await rowOf(held.id)).status, "on_hold");
    // A status change by an agent ends the parking with a line.
    const s = await eventTicket("Status change", 81);
    await park("agent", s.number, { action: "park" });
    assert.equal((await patch("agent", s.number, { status: "pending" })).status, 200);
    assert.deepEqual([(await rowOf(s.id)).status, (await rowOf(s.id)).parked_until], ["pending", null]);
    assert.ok((await lines(s.id)).some((l) => l.kind === "internal" && l.body.endsWith("ended the parking: the ticket no longer waits for its event")));
  });

  test("the event moves: the wake time follows (a line); moved near, it wakes; the setup lead time and whole days count; cancelled and removed wake it", async () => {
    const t = await eventTicket("Moves", 90);
    await park("agent", t.number, { action: "park" });
    const was = iso((await rowOf(t.id)).parked_until);
    assert.equal((await putEvent("agent", t.number, ahead(100))).status, 200);
    const now1 = iso((await rowOf(t.id)).parked_until);
    assert.notEqual(now1, was);
    assert.equal(now1, await expectedWake(t.id));
    assert.ok((await lines(t.id)).some((l) => /^The event moved to .*, so the ticket now wakes /.test(l.body)));
    // A longer setup lead time moves it too; a change to the place alone doesn't.
    await putEvent("agent", t.number, { setup_minutes: 3 * 1440 });
    assert.equal(iso((await rowOf(t.id)).parked_until), await expectedWake(t.id));
    const moves = async () => (await lines(t.id)).filter((l) => /so the ticket now wakes/.test(l.body)).length;
    const m0 = await moves();
    await putEvent("agent", t.number, { place: "Room 9" });
    assert.equal(await moves(), m0, "a new place alone doesn't move it");
    // All day: counted from the first day's start in the desk's zone.
    const day = new Date(Date.now() + 120 * DAY).toISOString().slice(0, 10);
    await putEvent("agent", t.number, { all_day: true, start_date: day, end_date: day, setup_minutes: 0 });
    assert.equal(iso((await rowOf(t.id)).parked_until), new Date(pks.wakeInstant({ starts_at: "", all_day: true, start_date: day, setup_minutes: 0 }, 10, HOURS)).toISOString());
    // Moved so near that its wake time has passed: it wakes now.
    await putEvent("agent", t.number, { ...ahead(3), all_day: false });
    assert.deepEqual([(await rowOf(t.id)).status, (await rowOf(t.id)).parked_until], ["open", null]);
    assert.ok((await lines(t.id)).some((l) => /^Woke: the event moved to .*, so it is inside its prep window now\.$/.test(l.body)));

    const c = await eventTicket("Cancelled later", 90);
    await park("agent", c.number, { action: "park" });
    await cal.cancelTicketEvent(c.id, { id: null, name: "Helpdesk" }, "The meeting was cancelled.");
    assert.equal((await rowOf(c.id)).status, "open");
    assert.ok((await lines(c.id)).some((l) => l.body === "The event was cancelled. Close this ticket if nothing else is needed." && l.kind === "internal"));

    const rm = await eventTicket("Removed", 90);
    await park("agent", rm.number, { action: "park" });
    assert.equal((await delEvent("agent", rm.number)).status, 200);
    assert.equal((await rowOf(rm.id)).status, "open");
    assert.ok((await lines(rm.id)).some((l) => l.body === "Woke: the event was removed from this ticket."));
  });

  test("Wake now and the ticket's own prep window", async () => {
    const t = await eventTicket("Prep", 50);
    assert.equal((await park("agent", t.number, { action: "prep", prep_days: 3 })).status, 200, "set before parking");
    assert.equal((await rowOf(t.id)).park_prep_days, 3);
    await park("agent", t.number, { action: "park" });
    assert.equal(iso((await rowOf(t.id)).parked_until), await expectedWake(t.id, 3));
    const changed = await park("agent", t.number, { action: "prep", prep_days: 5 });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(iso((await rowOf(t.id)).parked_until), await expectedWake(t.id, 5));
    assert.ok((await lines(t.id)).some((l) => / changed the prep window to 5 working days: the ticket now wakes /.test(l.body)));
    assert.equal((await park("agent", t.number, { action: "prep", prep_days: 60 })).status, 409, "it would wake in the past");
    assert.equal((await park("agent", t.number, { action: "prep", prep_days: 61 })).status, 400);
    assert.equal((await park("agent", t.number, { action: "prep" })).status, 400);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'helpdesk.ticket.park_changed' AND target_id = $1", [String(t.id)])).rows[0].n, 2);
    const woke = await park("agent", t.number, { action: "wake" });
    assert.equal(woke.status, 200);
    assert.deepEqual([(await rowOf(t.id)).status, (await rowOf(t.id)).park_prep_days], ["open", 5], "the window is kept");
    assert.ok((await lines(t.id)).some((l) => / woke the ticket \(it was parked for the event on .*\)$/.test(l.body)));
    assert.equal((await park("agent", t.number, { action: "wake" })).status, 409);
  });
});

// =======================================================================================

describe("parking itself after the acknowledgement", () => {
  const icsText = (method: string, uid: string, lines_: string[]) =>
    ["BEGIN:VCALENDAR", "VERSION:2.0", `METHOD:${method}`, "BEGIN:VEVENT", `UID:${uid}`, ...lines_, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  function mail(over: Partial<InboundEmail> = {}): InboundEmail {
    return {
      provider: "generic",
      from: { email: P.req.email, name: "Req Person" },
      to: [{ email: ALIAS, name: "" }],
      cc: [],
      recipients: [],
      subject: `${STAMP} Conference room booking`,
      text: "Please set up the room for this.",
      html: "",
      stripped: "",
      messageId: `${newToken()}@mail.example.test`,
      inReplyTo: "",
      references: [],
      headers: {},
      auth: { dmarc: "pass" },
      files: [],
      ...over,
    };
  }
  const file = (text: string) => ({ name: "invite.ics", type: "text/calendar; method=REQUEST", data: Buffer.from(text, "utf8") });
  const byNumber = async (n: number) => (await pool().query("SELECT * FROM hd_tickets WHERE number = $1", [n])).rows[0];
  const UID = `${STAMP}-booking@calendar.example.test`;
  const start = new Date(Date.now() + 90 * DAY);
  start.setUTCHours(10, 0, 0, 0);
  const at = (d: Date, h = 0) => stamp(new Date(d.getTime() + h * 3_600_000));
  let booking = 0;

  test("a meeting invite: the acknowledgement goes out first, then the ticket parks itself; nothing about it reaches the requester", async () => {
    mails.length = 0;
    // The requester forwards the organiser's invite: the ORGANIZER isn't the sender, so no organiser is recorded.
    const r = await inbound.processInboundEmail(
      mail({ files: [file(icsText("REQUEST", UID, ["SEQUENCE:0", `DTSTAMP:${at(new Date())}`, `ORGANIZER;CN=Org:mailto:${P.org.email.toUpperCase()}`, `DTSTART:${at(start)}`, `DTEND:${at(start, 2)}`, "LOCATION:Room 4"]))] }),
      { outsideSenders: false }
    );
    assert.deepEqual([r.status, r.body.outcome], [200, "created"]);
    const t = await byNumber(r.body.ticket!);
    ticketIds.push(t.id);
    booking = t.number;
    assert.deepEqual([t.status, t.park_reason, iso(t.parked_until)], ["on_hold", "invite", await expectedWake(t.id)]);
    const e = (await pool().query("SELECT ics_organizer, ics_dtstamp FROM hd_ticket_events WHERE ticket_id = $1", [t.id])).rows[0];
    assert.equal(e.ics_organizer, "", "the organiser is recorded only from the organiser's own address");
    assert.ok(e.ics_dtstamp);
    const ls = await lines(t.id);
    const added = ls.findIndex((l) => l.body.startsWith("Event added from the meeting invite"));
    const parked = ls.findIndex((l) => l.body.startsWith("Parked until ") && /after the acknowledgement \(a ticket from a meeting invite\)/.test(l.body));
    assert.ok(added >= 0 && parked > added, JSON.stringify(ls));
    await email.helpdeskMailSettledForTests();
    assert.ok(mails.some((m) => m.to.includes(P.req.email) && /received/i.test(m.subject)), "the acknowledgement went out");
    assert.ok(!mails.some((m) => /park|scheduled|on hold/i.test(m.subject)), "no notice of the parking");
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_ticket_parkings WHERE ticket_id = $1 AND woke_at IS NULL", [t.id])).rows[0].n, 1, "its parking history");
  });

  test("an updated invite (same UID, a later revision) threads into the same ticket and keeps it parked, the wake time moved; an older one changes nothing; one with a message wakes it", async () => {
    const t = await byNumber(booking);
    const moved = new Date(start.getTime() + 14 * DAY);
    const r = await inbound.processInboundEmail(
      mail({ subject: `${STAMP} Updated: Conference room booking`, text: "", files: [file(icsText("REQUEST", UID, ["SEQUENCE:1", `DTSTAMP:${at(new Date(), 1)}`, `DTSTART:${at(moved)}`, `DTEND:${at(moved, 2)}`, "LOCATION:Room 4"]))] }),
      { outsideSenders: false }
    );
    assert.deepEqual([r.body.outcome, r.body.ticket], ["appended", booking], "no second ticket");
    const row = await rowOf(t.id);
    assert.equal(row.status, "on_hold", "still parked");
    assert.equal(iso(row.parked_until), await expectedWake(t.id));
    assert.equal(iso((await cal.getTicketEvent(t.id))!.starts_at), moved.toISOString());
    assert.ok((await lines(t.id)).some((l) => /^The event moved to .*, so the ticket now wakes /.test(l.body)));
    // The same SEQUENCE with an earlier DTSTAMP (seconds count) is an older copy: ignored, and still parked.
    const olderBy = new Date(Date.parse(iso((await pool().query("SELECT ics_dtstamp FROM hd_ticket_events WHERE ticket_id = $1", [t.id])).rows[0].ics_dtstamp)) - 20_000);
    const stale = await inbound.processInboundEmail(mail({ text: "", files: [file(icsText("REQUEST", UID, ["SEQUENCE:1", `DTSTAMP:${stamp(olderBy)}`, `DTSTART:${at(start)}`]))] }), { outsideSenders: false });
    assert.equal(stale.body.outcome, "appended");
    assert.equal(iso((await cal.getTicketEvent(t.id))!.starts_at), moved.toISOString());
    assert.equal((await rowOf(t.id)).status, "on_hold");
    // Only the description or attendees changed, and the calendar app's own text: added to the ticket, nothing else.
    const boiler = "Microsoft Teams meeting\nJoin on your computer, mobile app or room device\nClick here to join the meeting\nMeeting ID: 123 456 789\nPasscode: abc\n________________\nLearn More | Meeting options";
    const n = (await lines(t.id)).filter((l) => l.kind === "internal").length;
    await inbound.processInboundEmail(mail({ text: boiler, files: [file(icsText("REQUEST", UID, ["SEQUENCE:2", `DTSTAMP:${at(new Date(), 2)}`, `DTSTART:${at(moved)}`, `DTEND:${at(moved, 2)}`, "LOCATION:Room 4", "DESCRIPTION:More people"]))] }), { outsideSenders: false });
    assert.equal((await lines(t.id)).filter((l) => l.kind === "internal").length, n, "no event line");
    assert.equal((await rowOf(t.id)).status, "on_hold");
    // An update carrying a message a person wrote: the ticket wakes, so the message is seen.
    await inbound.processInboundEmail(mail({ text: `Can we have the room an hour earlier for rehearsal?\n\n${boiler}`, files: [file(icsText("REQUEST", UID, ["SEQUENCE:3", `DTSTAMP:${at(new Date(), 3)}`, `DTSTART:${at(moved)}`, `DTEND:${at(moved, 2)}`, "LOCATION:Room 4"]))] }), { outsideSenders: false });
    assert.deepEqual([(await rowOf(t.id)).status, (await rowOf(t.id)).parked_until], ["open", null]);
    assert.ok((await lines(t.id)).some((l) => /^Woke for a new message from the requester/.test(l.body)));
    // Parked again for the tests below.
    assert.equal((await park("agent", t.number, { action: "park" })).status, 200);
  });

  test("the message an invite's email carries: the calendar app's own text doesn't count (pure)", () => {
    const inv = { summary: "Conference room booking", location: "Room 4" };
    assert.equal(icsMod.inviteMessageText("", inv), "");
    assert.equal(icsMod.inviteMessageText("Conference room booking\nWhen: Sun 15 Mar 10:00\nWhere: Room 4\nhttps://teams.example/join/abc\nMeeting ID: 123 456\nThanks!", inv), "");
    assert.equal(icsMod.inviteMessageText("Invitation from Google Calendar\nYou are receiving this email because you are an attendee\nForwarding this invitation could allow any recipient", inv), "");
    assert.match(icsMod.inviteMessageText("Please add a projector and twelve chairs.\nMicrosoft Teams meeting", inv), /^Please add a projector/);
    assert.equal(icsMod.stampOf("20261120T140530Z"), Date.UTC(2026, 10, 20, 14, 5, 30), "DTSTAMP keeps its seconds");
    assert.equal(icsMod.stampOf("20261120T140530"), null, "DTSTAMP is UTC");
  });

  test("the organiser: recorded only from their own verified address; their update lands as an agents-only note, applied, and keeps the ticket parked (a message wakes it); never on the sender check's say-so alone", async () => {
    const uid = `${STAMP}-org@calendar.example.test`;
    const later = new Date(start.getTime() + 7 * DAY);
    const made = await inbound.processInboundEmail(
      mail({ from: { email: P.org.email, name: "Org" }, subject: `${STAMP} Organised`, files: [file(icsText("REQUEST", uid, ["SEQUENCE:0", `DTSTAMP:${at(new Date())}`, `ORGANIZER;CN=Org:mailto:${P.org.email.toUpperCase()}`, `DTSTART:${at(start)}`, `DTEND:${at(start, 2)}`]))] }),
      { outsideSenders: false }
    );
    const t = await byNumber(made.body.ticket!);
    ticketIds.push(t.id);
    assert.equal((await pool().query("SELECT ics_organizer FROM hd_ticket_events WHERE ticket_id = $1", [t.id])).rows[0].ics_organizer, P.org.email.toLowerCase());
    // The organiser's PA is the requester now.
    await pool().query("UPDATE hd_tickets SET requester_id = $2, requester_email = $3 WHERE id = $1", [t.id, P.req.id, P.req.email]);
    const upd = await inbound.processInboundEmail(
      mail({ from: { email: P.org.email, name: "Org" }, subject: `${STAMP} Updated: Organised`, text: "", files: [file(icsText("REQUEST", uid, ["SEQUENCE:1", `DTSTAMP:${at(new Date(), 1)}`, `DTSTART:${at(later)}`, `DTEND:${at(later, 2)}`]))] }),
      { outsideSenders: false }
    );
    assert.deepEqual([upd.body.outcome, upd.body.ticket], ["appended", t.number]);
    assert.equal(iso((await cal.getTicketEvent(t.id))!.starts_at), later.toISOString(), "the update is applied");
    const note = (await pool().query("SELECT kind, body FROM hd_messages WHERE ticket_id = $1 AND via = 'email' ORDER BY id DESC LIMIT 1", [t.id])).rows[0];
    assert.equal(note.kind, "internal", "never a public requester message");
    assert.match(note.body, /\(the meeting's organiser\) wrote/);
    assert.equal((await rowOf(t.id)).status, "on_hold", "still parked");
    // A message from the organiser with their update: the ticket wakes so it is read.
    await inbound.processInboundEmail(
      mail({ from: { email: P.org.email, name: "Org" }, text: "We are expecting forty people now, not twenty.", files: [file(icsText("REQUEST", uid, ["SEQUENCE:2", `DTSTAMP:${at(new Date(), 2)}`, `DTSTART:${at(later)}`, `DTEND:${at(later, 2)}`]))] }),
      { outsideSenders: false }
    );
    assert.equal((await rowOf(t.id)).status, "open");
    assert.ok((await lines(t.id)).some((l) => /^Woke for a message that came with the meeting update/.test(l.body)));
    // With no sender check result, a trusted-address setting is not enough to be the organiser: a ticket of its own.
    const unchecked = await inbound.processInboundEmail(
      mail({ from: { email: P.org.email, name: "Org" }, subject: `${STAMP} unchecked`, auth: {}, files: [file(icsText("REQUEST", uid, ["SEQUENCE:5", `DTSTAMP:${at(new Date(), 5)}`, `DTSTART:${at(start)}`]))] }),
      { outsideSenders: false, trustUnverified: true }
    );
    assert.notEqual(unchecked.body.ticket, t.number);
    if (unchecked.body.ticket) ticketIds.push((await byNumber(unchecked.body.ticket)).id);
    assert.equal(iso((await cal.getTicketEvent(t.id))!.starts_at), later.toISOString(), "untouched");
  });

  test("an attendee's planted ORGANIZER and two honest forwarders: no organiser is recorded, so the real organiser's mail reaches neither; with two tickets organised alike, none is picked", async () => {
    const uid = `${STAMP}-plant@calendar.example.test`;
    // An attendee (a verified account) sends the invite in naming the real organiser: it is their own ticket, with no organiser.
    const plant = await inbound.processInboundEmail(
      mail({ from: { email: P.stranger.email, name: "Attendee" }, subject: `${STAMP} planted`, files: [file(icsText("REQUEST", uid, [`ORGANIZER:mailto:${P.org.email}`, `DTSTART:${at(start)}`]))] }),
      { outsideSenders: false }
    );
    const pt = await byNumber(plant.body.ticket!);
    ticketIds.push(pt.id);
    assert.equal((await pool().query("SELECT ics_organizer FROM hd_ticket_events WHERE ticket_id = $1", [pt.id])).rows[0].ics_organizer, "");
    // A second honest forwarder of the same meeting: their own ticket, also with no organiser.
    const fwd = await inbound.processInboundEmail(
      mail({ from: { email: P.req.email, name: "Req" }, subject: `${STAMP} forwarded`, files: [file(icsText("REQUEST", uid, [`ORGANIZER:mailto:${P.org.email}`, `DTSTART:${at(start)}`]))] }),
      { outsideSenders: false }
    );
    assert.notEqual(fwd.body.ticket, plant.body.ticket);
    const ft = await byNumber(fwd.body.ticket!);
    ticketIds.push(ft.id);
    // The real organiser's update reaches neither: a ticket of its own.
    const org = await inbound.processInboundEmail(
      mail({ from: { email: P.org.email, name: "Org" }, subject: `${STAMP} real update`, files: [file(icsText("REQUEST", uid, ["SEQUENCE:3", `DTSTART:${at(new Date(start.getTime() + DAY))}`]))] }),
      { outsideSenders: false }
    );
    assert.ok(![plant.body.ticket, fwd.body.ticket].includes(org.body.ticket));
    if (org.body.ticket) ticketIds.push((await byNumber(org.body.ticket)).id);
    for (const id of [pt.id, ft.id]) assert.equal(iso((await cal.getTicketEvent(id))!.starts_at), start.toISOString(), "untouched");
    // Each forwarder's own update still reaches their own ticket.
    const own = await inbound.processInboundEmail(mail({ from: { email: P.req.email, name: "Req" }, text: "", files: [file(icsText("REQUEST", uid, ["SEQUENCE:4", `DTSTART:${at(start)}`]))] }), { outsideSenders: false });
    assert.equal(own.body.ticket, fwd.body.ticket);
    // Two live tickets that both recorded the same organiser for one UID: the organiser matches neither. (The organiser's
    // own new ticket above is theirs as requester; it is moved off this UID so only the organiser rule is in play.)
    if (org.body.ticket) await pool().query("UPDATE hd_ticket_events SET ics_uid = ics_uid || '-own' WHERE ticket_id = $1", [(await byNumber(org.body.ticket)).id]);
    await pool().query("UPDATE hd_ticket_events SET ics_organizer = $2 WHERE ticket_id = ANY($1)", [[pt.id, ft.id], P.org.email.toLowerCase()]);
    assert.equal(await cal.ticketForInviteUid(uid, { id: P.org.id, email: P.org.email }, { organiserOk: true }), null);
    assert.equal(await cal.isInviteOrganiser(pt.id, uid, P.org.email), false);
    await pool().query("UPDATE hd_ticket_events SET ics_organizer = '' WHERE ticket_id = $1", [ft.id]);
    assert.equal(await cal.ticketForInviteUid(uid, { id: P.org.id, email: P.org.email }, { organiserOk: true }), pt.id, "exactly one: that one");
    assert.equal(await cal.ticketForInviteUid(uid, { id: P.org.id, email: P.org.email }, { organiserOk: false }), null, "not on trust alone");
  });

  test("someone copied: their invite never adds or changes an event on the ticket, and records no organiser", async () => {
    const t = await ticket("CC invite");
    const token = `cc${Date.now().toString(36)}`.padEnd(16, "x").slice(0, 16);
    await pool().query("UPDATE hd_tickets SET reply_token = $2 WHERE id = $1", [t.id, token]);
    await pool().query("INSERT INTO hd_ticket_ccs (ticket_id, user_id, email, name) VALUES ($1, $2, $3, 'Org')", [t.id, P.org.id, P.org.email]);
    const r = await inbound.processInboundEmail(
      mail({ from: { email: P.org.email, name: "Org" }, subject: `Re: [#${t.number} ref:${token}]`, files: [file(icsText("REQUEST", `${STAMP}-cc@calendar.example.test`, [`ORGANIZER:mailto:${P.org.email}`, `DTSTART:${at(start)}`]))] }),
      { outsideSenders: false }
    );
    assert.deepEqual([r.body.outcome, r.body.ticket], ["appended", t.number]);
    assert.equal(await cal.getTicketEvent(t.id), null, "no event added");
    assert.ok((await lines(t.id)).some((l) => /isn't from the requester, so it wasn't put on the ticket/.test(l.body)));
  });

  test("a cancellation (METHOD:CANCEL) cancels the event and wakes the ticket with the note; a late copy of the request can't bring it back", async () => {
    const t = await byNumber(booking);
    const cancelStamp = new Date(Date.now() + 10 * 3_600_000);
    const r = await inbound.processInboundEmail(
      mail({ subject: `Canceled: ${STAMP} Conference room booking`, text: "", files: [{ name: "cancel.ics", type: "text/calendar; method=CANCEL", data: Buffer.from(icsText("CANCEL", UID, ["SEQUENCE:4", `DTSTAMP:${stamp(cancelStamp)}`, `DTSTART:${at(start)}`]), "utf8") }] }),
      { outsideSenders: false }
    );
    assert.deepEqual([r.body.outcome, r.body.ticket], ["appended", booking]);
    assert.equal((await cal.getTicketEvent(t.id))!.cancelled, true);
    const row = await rowOf(t.id);
    assert.deepEqual([row.status, row.parked_until], ["open", null]);
    assert.ok((await lines(t.id)).some((l) => l.body === "The event was cancelled. Close this ticket if nothing else is needed."));
    assert.equal(iso((await pool().query("SELECT ics_dtstamp FROM hd_ticket_events WHERE ticket_id = $1", [t.id])).rows[0].ics_dtstamp), new Date(Math.floor(cancelStamp.getTime() / 1000) * 1000).toISOString(), "the CANCEL's DTSTAMP is kept");
    // The same SEQUENCE with an older DTSTAMP, arriving late: still cancelled.
    await inbound.processInboundEmail(mail({ text: "", files: [file(icsText("REQUEST", UID, ["SEQUENCE:4", `DTSTAMP:${stamp(new Date(cancelStamp.getTime() - 3_600_000))}`, `DTSTART:${at(start)}`]))] }), { outsideSenders: false });
    assert.equal((await cal.getTicketEvent(t.id))!.cancelled, true);
    assert.equal((await pool().query("SELECT woke_at FROM hd_ticket_parkings WHERE ticket_id = $1 ORDER BY id DESC LIMIT 1", [t.id])).rows[0].woke_at !== null, true, "its parking history closed");
  });

  test("an invite from a sender who didn't pass the check, or for an event more than 400 days out, doesn't park itself", async () => {
    const unchecked = await inbound.processInboundEmail(
      mail({ from: { email: `${STAMP}-outside@elsewhere.example.test`, name: "Outside" }, subject: `${STAMP} unchecked invite`, auth: { dmarc: "fail" }, files: [file(icsText("REQUEST", `${UID}-unv`, [`DTSTART:${at(start)}`]))] }),
      { outsideSenders: true, trustUnverified: false }
    );
    const u = await byNumber(unchecked.body.ticket!);
    ticketIds.push(u.id);
    assert.deepEqual([u.status, u.parked_until], ["new", null]);
    const far = new Date(Date.now() + (pk.AUTO_PARK_MAX_DAYS + 30) * DAY);
    const farMail = await inbound.processInboundEmail(mail({ subject: `${STAMP} far away`, files: [file(icsText("REQUEST", `${UID}-far`, [`DTSTART:${at(far)}`]))] }), { outsideSenders: false });
    const f = await byNumber(farMail.body.ticket!);
    ticketIds.push(f.id);
    assert.deepEqual([f.status, f.parked_until], ["new", null]);
    assert.ok((await lines(f.id)).some((l) => l.body === `Not parked: the event is more than ${pk.AUTO_PARK_MAX_DAYS} days away, so the ticket stays in the queue. Park it by hand if that date is right.`));
    // By hand there is no limit.
    assert.equal((await park("agent", f.number, { action: "park" })).status, 200);
  });

  test("switched off, or too close to its event, an invite's ticket stays open", async () => {
    try {
      cal.setCalendarSettingsForTests({ park_invites: false });
      const off = await inbound.processInboundEmail(mail({ subject: `${STAMP} not parked`, files: [file(icsText("REQUEST", `${UID}-off`, [`DTSTART:${at(start)}`]))] }), { outsideSenders: false });
      const t = await byNumber(off.body.ticket!);
      ticketIds.push(t.id);
      assert.deepEqual([t.status, t.parked_until], ["new", null]);
    } finally {
      cal.setCalendarSettingsForTests({ park_prep_days: 10, park_invites: true, park_request_types: true, remind_requester: false, remind_requester_days: 2 });
    }
    const soon = new Date(Date.now() + 2 * DAY);
    const near = await inbound.processInboundEmail(mail({ subject: `${STAMP} soon`, files: [file(icsText("REQUEST", `${UID}-near`, [`DTSTART:${at(soon)}`]))] }), { outsideSenders: false });
    const n = await byNumber(near.body.ticket!);
    ticketIds.push(n.id);
    assert.deepEqual([n.status, n.parked_until], ["new", null]);
  });

  test("a request type that goes on the calendar: after the rules and the acknowledgement the request parks itself; switched off, it doesn't", async () => {
    const FORM: HdFormField[] = [{ key: "starts", label: "When?", type: "datetime", required: true }];
    const input = await requestTypes.validateRequestTypeInput({ title: `${STAMP} Room booking`, team_id: T.A, form: FORM });
    assert.ok(input.ok);
    if (!input.ok) return;
    const rt = await requestTypes.createRequestType(input.value);
    typeIds.push(rt.id);
    await pool().query("UPDATE hd_request_types SET calendar = $2 WHERE id = $1", [rt.id, JSON.stringify({ enabled: true, start_field: "starts", end_field: "", place_field: "", lead_minutes: 30 })]);
    const when = new Date(Date.now() + 80 * DAY).toISOString().slice(0, 10) + "T10:00";
    const make = () => tickets.createTicket({ subject: `${STAMP} Training day`, body: "Room for twelve.", requester: { id: P.req.id, name: P.req.name, email: P.req.email }, request_type_id: rt.id, answers: { starts: when } }, { actorId: P.req.id, actorName: P.req.name });
    const t = await make();
    ticketIds.push(t.id);
    const row = await rowOf(t.id);
    assert.deepEqual([row.status, row.park_reason, iso(row.parked_until)], ["on_hold", "request_type", await expectedWake(t.id)]);
    try {
      cal.setCalendarSettingsForTests({ park_request_types: false });
      const t2 = await make();
      ticketIds.push(t2.id);
      assert.equal((await rowOf(t2.id)).parked_until, null);
    } finally {
      cal.setCalendarSettingsForTests({ park_prep_days: 10, park_invites: true, park_request_types: true, remind_requester: false, remind_requester_days: 2 });
    }
  });
});

// =======================================================================================

describe("after review: assignment, recomputing, failures, saved views, the backlog's history", () => {
  test("auto-assignment: a parked ticket counts in nobody's load, leaves the queue and is never assigned; waking puts it back", async () => {
    const before = (await assignStore.loadOf([P.agent2.id])).get(P.agent2.id)!.open_count;
    const t = await eventTicket("Load", 90, { assignee: P.agent2.id });
    assert.equal((await assignStore.loadOf([P.agent2.id])).get(P.agent2.id)!.open_count, before + 1);
    await park("agent", t.number, { action: "park" });
    assert.equal((await assignStore.loadOf([P.agent2.id])).get(P.agent2.id)!.open_count, before, "out of the load");
    const q = await eventTicket("Queued", 90, { assignee: null });
    await pool().query("INSERT INTO hd_assignment_ticket (ticket_id, queued_since, queued_reason) VALUES ($1, now() - interval '1 hour', 'test') ON CONFLICT (ticket_id) DO UPDATE SET queued_since = EXCLUDED.queued_since", [q.id]);
    await park("agent", q.number, { action: "park" });
    assert.deepEqual(await assignEngine.assignTicket(q.id, { trigger: "retry" }), { outcome: "skipped", reason: "The ticket is parked until its event." });
    let left = false;
    for (let i = 0; i < 10 && !left; i++) {
      const r = await assignEngine.assignmentSweep(new Date(), { teamIds: [T.A] });
      left = r.ran && !(await pool().query("SELECT queued_since FROM hd_assignment_ticket WHERE ticket_id = $1", [q.id])).rows[0]?.queued_since;
      if (!left) await new Promise((res) => setTimeout(res, 300));
    }
    assert.ok(left, "the queue's clean-up lets a parked ticket go");
    // Woken, it is open work again: back in the load of whoever owns it, and assignable.
    await pk.wakeTicket(t.id, actor(), { why: "manual" });
    assert.equal((await assignStore.loadOf([P.agent2.id])).get(P.agent2.id)!.open_count, before + 1);
    await pk.wakeTicket(q.id, actor(), { why: "manual" });
    assert.notDeepEqual(await assignEngine.assignTicket(q.id, { trigger: "retry" }), { outcome: "skipped", reason: "The ticket is parked until its event." });
  });

  test("the wake time is worked out again when the ticket changes team, the team's calendar changes, or the desk's prep window does", async () => {
    // Team B gets a calendar of its own: Auckland, weekdays 08:00 to 12:00.
    const day = [{ start: "08:00", end: "12:00" }];
    const calB = await calendars.createCalendar({ name: `${STAMP} Auckland`, timezone: "Pacific/Auckland", schedule: [[], day, day, day, day, day, []] });
    const inB = await ticket("Team B parked", { team: "B", assignee: P.other.id });
    assert.equal((await putEvent("other", inB.number, { ...ahead(90), setup_minutes: 0 })).status, 200);
    assert.equal((await park("other", inB.number, { action: "park" })).status, 200);
    await calendars.assignTeamCalendar(T.B, calB.id);
    const hoursB = await calendars.hoursForTeam(T.B);
    assert.equal(hoursB.timezone, "Pacific/Auckland");
    const want = (id: number, h: HdBusinessHours, prep = 10) => cal.getTicketEvent(id).then((e) => new Date(pks.wakeInstant(e!, prep, h)).toISOString());
    assert.equal(iso((await rowOf(inB.id)).parked_until), await want(inB.id, hoursB), "the calendar's change");
    assert.ok((await lines(inB.id)).some((l) => /^Its team's business calendar changed, so the ticket now wakes /.test(l.body)));
    // A parked ticket moved from team A to team B wakes by team B's calendar.
    const moves = await eventTicket("Team move", 90);
    await park("agent", moves.number, { action: "park" });
    assert.equal((await patch("agent", moves.number, { team_id: T.B })).status, 200);
    assert.equal(iso((await rowOf(moves.id)).parked_until), await want(moves.id, hoursB));
    assert.ok((await lines(moves.id)).some((l) => /^The ticket moved to another team, so the ticket now wakes /.test(l.body)));
    // The desk's prep window: tickets without their own follow it; one with its own keeps it.
    const own = await eventTicket("Own prep", 90);
    await park("agent", own.number, { action: "park", prep_days: 3 });
    const follows = await eventTicket("Desk prep", 70);
    await park("agent", follows.number, { action: "park" });
    try {
      cal.setCalendarSettingsForTests({ park_prep_days: 4 });
      const r = await pk.recomputeParked({ kind: "desk_prep" }, { only: [own.id, follows.id] });
      assert.deepEqual([r.checked, r.moved], [1, 1], "only the ticket without its own");
      assert.equal(iso((await rowOf(follows.id)).parked_until), await expectedWake(follows.id, 4));
      assert.equal(iso((await rowOf(own.id)).parked_until), await expectedWake(own.id, 3));
      // A recomputed time already past is due now: the next sweep wakes it.
      cal.setCalendarSettingsForTests({ park_prep_days: 60 });
      const r2 = await pk.recomputeParked({ kind: "desk_prep" }, { only: [follows.id] });
      assert.equal(r2.due, 1);
      assert.ok(Date.parse((await rowOf(follows.id)).parked_until) <= Date.now());
      assert.deepEqual((await pk.parkSweep(new Date(Date.now() + 60_000), { only: [follows.id] })).woke, [follows.id]);
    } finally {
      cal.setCalendarSettingsForTests({ park_prep_days: 10, park_invites: true, park_request_types: true, remind_requester: false, remind_requester_days: 2 });
    }
  });

  test("a wake that fails: after a cancelled event the ticket is due at once; the sweep backs off a failing ticket, then wakes it by a plain status change after five tries", async () => {
    const c = await eventTicket("Wake fails on cancel", 90);
    await park("agent", c.number, { action: "park" });
    pk.setSweepWakeForTests(async () => {
      throw new Error("simulated failure");
    });
    try {
      await cal.cancelTicketEvent(c.id, { id: null, name: "Helpdesk" }, "Cancelled.");
      assert.ok(Date.parse((await rowOf(c.id)).parked_until) <= Date.now() + 1000, "due now");
      const f = await eventTicket("Wake keeps failing", 90);
      await park("agent", f.number, { action: "park" });
      await pool().query("UPDATE hd_tickets SET parked_until = now() - interval '1 minute' WHERE id = $1", [f.id]);
      let t0 = Date.now();
      const first = await pk.parkSweep(new Date(t0), { only: [f.id] });
      assert.deepEqual(first.failed, [f.id]);
      let row = await rowOf(f.id);
      assert.deepEqual([row.park_wake_failures, row.park_wake_error], [1, "simulated failure"]);
      assert.ok(Date.parse(row.park_wake_retry_at) > t0, "waits before trying again");
      assert.deepEqual((await pk.parkSweep(new Date(t0), { only: [f.id] })).failed, [], "not tried again inside its delay");
      for (let i = 2; i <= pk.PARK_WAKE_MAX_FAILURES; i++) {
        t0 = Date.parse((await rowOf(f.id)).park_wake_retry_at) + 1000;
        await pk.parkSweep(new Date(t0), { only: [f.id] });
      }
      row = await rowOf(f.id);
      assert.deepEqual([row.status, row.parked_until, row.park_wake_failures], ["open", null, 0], "woken by a plain status change");
      assert.ok((await lines(f.id)).some((l) => /^Woke without its usual steps after 5 failed attempts \(simulated failure\)/.test(l.body)));
    } finally {
      pk.setSweepWakeForTests(null);
    }
    assert.deepEqual((await pk.parkSweep(new Date(Date.now() + 60_000), { only: [c.id] })).woke, [c.id], "the cancelled one wakes on the next sweep");
    assert.ok((await lines(c.id)).some((l) => l.body.startsWith("Woke for the event") || l.body.startsWith("Woke:")));
  });

  test("saved views: Not solved leaves parked tickets out unless Include parked tickets is ticked; the summary says which", async () => {
    const t = await eventTicket("Saved view", 90);
    await park("agent", t.number, { action: "park" });
    const user = { id: P.agent.id, role: "viewer" as const };
    const has = async (q: string) => {
      const parsed = await ticketFilters.parseTicketFilters(new URLSearchParams(q));
      assert.ok(parsed.ok, q);
      if (!parsed.ok) return false;
      return (await tickets.listTickets(user, { ...parsed.filters, team_id: T.A, limit: 200 })).rows.some((r) => r.number === t.number);
    };
    assert.equal(await has("view=all&status_group=open"), false, "existing views keep leaving them out");
    assert.equal(await has("view=all&status_group=open&include_parked=1"), true);
    assert.equal((await ticketFilters.parseTicketFilters(new URLSearchParams("include_parked=yes"))).ok, false);
    assert.match(savedShared.filterSummary({ status_group: "open" }), /Not solved, parked left out/);
    assert.match(savedShared.filterSummary({ status_group: "open", include_parked: "1" }), /Not solved, parked included/);
  });

  test("the backlog reads the parking history, so past days stay as they were when a ticket wakes", async () => {
    const t = await ticket("Backlog history", { team: "C" });
    const now = Date.now();
    await pool().query("UPDATE hd_tickets SET created_at = $2 WHERE id = $1", [t.id, new Date(now - 10 * DAY)]);
    await pool().query("INSERT INTO hd_ticket_parkings (ticket_id, parked_at, woke_at, reason) VALUES ($1, $2, $3, 'agent')", [t.id, new Date(now - 6 * DAY), new Date(now - 3 * DAY)]);
    const viewer = (await getUserById(P.dadmin.id))!;
    const first = await analytics.runQuery({ measure: "backlog", groupBy: [], filters: { team: [T.C] }, range: { preset: "today" } } as never, viewer as never, { fresh: true });
    const tz = first.range.timezone;
    const day = (n: number) => shared.dayOf(now - n * DAY, tz);
    const daily = await analytics.runQuery({ measure: "backlog", groupBy: ["day"], filters: { team: [T.C] }, range: { from: day(8), to: day(1) } } as never, viewer as never, { fresh: true });
    const byDay = new Map(daily.rows.map((r) => [r.keys[0], r.value]));
    assert.deepEqual([8, 7, 6, 5, 4, 3, 2, 1].map((n) => byDay.get(day(n))), [1, 1, 0, 0, 0, 1, 1, 1], JSON.stringify(daily.rows));
  });
});

describe("the requester's side", () => {
  test("Get help shows a parked request as Scheduled with its day, time and place; the list too; the portal reads the same", async () => {
    const t = await eventTicket("Scheduled view", 90, { place: "Room 4" });
    await park("agent", t.number, { action: "park" });
    const r = await call(requestRoute.GET, req(`/requests/${t.number}`, P.req.session), { number: String(t.number) });
    assert.equal(r.status, 200);
    const e = (await cal.getTicketEvent(t.id))!;
    assert.deepEqual(r.body.request.scheduled, { starts_at: e.starts_at, all_day: false, start_date: null, place: "Room 4" });
    assert.ok(!JSON.stringify(r.body.request).includes("parked_until"), "the requester never reads the wake time");
    const mine = await tickets.listMyRequests(P.req.id, { limit: 200 });
    assert.equal(mine.find((x) => x.number === t.number)!.scheduled?.place, "Room 4");
    assert.equal(mine.find((x) => x.number !== t.number && x.status !== "on_hold")?.scheduled, undefined);
    const portal = await pk.scheduledFor([t.id]);
    assert.equal(portal.get(t.id)?.place, "Room 4");
    await park("agent", t.number, { action: "wake" });
    assert.equal((await pk.scheduledFor([t.id])).size, 0, "awake: the status again");
  });

  test("the reminder before the event: off by default; on, one email once per event date, again when the event moves; a normal-priority mail", async () => {
    const t = await ticket("Reminder", { requesterEmail: `${STAMP}-outside@example.test` });
    assert.equal((await putEvent("agent", t.number, { ...ahead(1), place: "Room 4" })).status, 200);
    assert.deepEqual(await pk.requesterReminderSweep(new Date(), { only: [t.id] }), [], "off by default");
    mails.length = 0;
    try {
      cal.setCalendarSettingsForTests({ remind_requester: true, remind_requester_days: 2 });
      assert.deepEqual(await pk.requesterReminderSweep(new Date(), { only: [t.id] }), [t.id]);
      assert.deepEqual(await pk.requesterReminderSweep(new Date(), { only: [t.id] }), [], "once");
      await email.helpdeskMailSettledForTests();
      const sent = mails.filter((m) => m.to.includes(`${STAMP}-outside@example.test`));
      assert.equal(sent.length, 1);
      const day = pks.eventDay((await cal.getTicketEvent(t.id))!, TZ);
      assert.match(sent[0].subject, new RegExp(`Reminder: Reminder ${STAMP} on ${day}`));
      assert.match(sent[0].text, /Room 4/);
      // Moved: it goes again for the new date.
      const was = Date.parse((await cal.getTicketEvent(t.id))!.starts_at);
      assert.equal((await putEvent("agent", t.number, { starts_at: new Date(was + 3 * 3_600_000).toISOString() })).status, 200);
      assert.deepEqual(await pk.requesterReminderSweep(new Date(), { only: [t.id] }), [t.id]);
      // Too far ahead: not yet.
      const far = await ticket("Reminder far", { requesterEmail: `${STAMP}-far@example.test` });
      await putEvent("agent", far.number, ahead(20));
      assert.deepEqual(await pk.requesterReminderSweep(new Date(), { only: [far.id] }), []);
    } finally {
      cal.setCalendarSettingsForTests({ park_prep_days: 10, park_invites: true, park_request_types: true, remind_requester: false, remind_requester_days: 2 });
    }
    assert.equal(outboxShared.mailPriority(email.helpdeskMailKind("hd_event_requester_reminder", true)), outboxShared.PRIORITY.normal);
  });
});

// =======================================================================================

describe("the API and the Claude connector", () => {
  test("REST: GET carries parked_until, park_reason and the prep window; PATCH event.park parks and wakes, validated; a newbie's token may not", async () => {
    const mk = async (role: string) => {
      const made = await call(tokensRoute.POST, new Request("http://localhost/api/helpdesk/admin/api/tokens", {
        method: "POST",
        headers: { cookie: `compass_session=${P.dadmin.session}`, "content-type": "application/json" },
        body: JSON.stringify({ name: `${STAMP} ${role}`, role, team_ids: [T.A], expires_at: null }),
      }));
      assert.equal(made.status, 201, JSON.stringify(made.body));
      tokenIds.push(made.body.view.id);
      userIds.push((await pool().query("SELECT principal_id FROM hd_api_tokens WHERE id = $1", [made.body.view.id])).rows[0].principal_id);
      return made.body.token as string;
    };
    const agentToken = await mk("agent");
    const api = (token: string, n: number, method: string, body?: unknown) =>
      call(method === "GET" ? v1TicketRoute.GET : v1TicketRoute.PATCH, new Request(`http://localhost/api/helpdesk/v1/tickets/${n}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.79" }, body: body === undefined ? undefined : JSON.stringify(body) }), { number: String(n) });
    const t = await eventTicket("API park", 90);
    let g = await api(agentToken, t.number, "GET");
    assert.deepEqual([g.body.parked_until, g.body.park_reason, g.body.park_prep_days, g.body.park_prep_days_own], [null, null, 10, null]);
    assert.equal((await api(agentToken, t.number, "PATCH", { event: { park: "nap" } })).status, 400);
    assert.equal((await api(agentToken, t.number, "PATCH", { event: { park: "park", prep_days: 99 } })).status, 400);
    // A refused park leaves the event fields sent with it unsaved.
    const was = (await cal.getTicketEvent(t.id))!.starts_at;
    const half = await api(agentToken, t.number, "PATCH", { event: { ...ahead(2), park: "park" } });
    assert.equal(half.status, 409, JSON.stringify(half.body));
    assert.match(half.body.error, /^This event is too close to park/);
    assert.equal((await cal.getTicketEvent(t.id))!.starts_at, was, "the event is as it was");
    const p = await api(agentToken, t.number, "PATCH", { event: { park: "park", prep_days: 4 } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual([p.body.ticket.parked_until, p.body.ticket.park_reason, p.body.ticket.park_prep_days, p.body.changed], [await expectedWake(t.id, 4), "agent", 4, ["event"]]);
    assert.ok((await lines(t.id)).some((l) => / parked the ticket until .* via API$/.test(l.body)));
    g = await api(agentToken, t.number, "GET");
    assert.equal(g.body.parked_until, await expectedWake(t.id, 4));
    const w = await api(agentToken, t.number, "PATCH", { event: { park: "wake" } });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.deepEqual([w.body.ticket.parked_until, (await rowOf(t.id)).status], [null, "open"]);
    assert.equal((await api(agentToken, t.number, "PATCH", { event: { park: "wake" } })).status, 409);
    const newbieToken = await mk("newbie").catch(() => null);
    if (newbieToken) assert.equal((await api(newbieToken, t.number, "PATCH", { event: { park: "park" } })).status, 403);
  });

  test("the Claude connector: hd_read_ticket shows the parking; hd_update_ticket's event parks and wakes it", async () => {
    claude.setClaudeLevelForTests("update");
    const t = await eventTicket("Connector park", 90);
    const user = (await getUserById(P.agent.id))!;
    const ctx = { origin: "http://localhost", ip: null };
    const tool = async (name: string, args: Record<string, unknown>) => {
      const r = await hdTools.callHelpdeskTool(user, name, args, ctx);
      return { isError: r.isError, text: r.content[0].text as string };
    };
    let read = JSON.parse((await tool("hd_read_ticket", { number: t.number })).text);
    assert.deepEqual([read.parking.parked_until, read.parking.prep_days], [null, 10]);
    const parked = await tool("hd_update_ticket", { number: t.number, event: { park: "park" } });
    assert.equal(parked.isError, false, parked.text);
    assert.equal(JSON.parse(parked.text).status, "on_hold");
    read = JSON.parse((await tool("hd_read_ticket", { number: t.number })).text);
    assert.equal(read.parking.parked_until, await expectedWake(t.id));
    assert.ok((await lines(t.id)).some((l) => / parked the ticket until .* via Claude$/.test(l.body)));
    const tooClose = await tool("hd_update_ticket", { number: t.number, event: { park: "park" } });
    assert.equal(tooClose.isError, true);
    // A refused park with event fields: nothing is saved.
    await tool("hd_update_ticket", { number: t.number, event: { park: "wake" } });
    const was = (await cal.getTicketEvent(t.id))!.starts_at;
    const half = await tool("hd_update_ticket", { number: t.number, event: { ...ahead(2), park: "park" } });
    assert.equal(half.isError, true, half.text);
    assert.equal((await cal.getTicketEvent(t.id))!.starts_at, was);
    assert.equal((await tool("hd_update_ticket", { number: t.number, event: { park: "park" } })).isError, false);
    const woke = await tool("hd_update_ticket", { number: t.number, event: { park: "wake" } });
    assert.equal(woke.isError, false, woke.text);
    assert.equal((await rowOf(t.id)).status, "open");
    const def = hdTools.HELPDESK_TOOL_DEFS.find((x) => x.name === "hd_update_ticket") as unknown as { inputSchema: { properties: { event: { description: string } } } };
    assert.match(def.inputSchema.properties.event.description, /park "park"/);
  });
});

// =======================================================================================

describe("upgrade", () => {
  test("the columns and the wake index are additive and can be applied again and again; nothing is parked by them", async () => {
    const sql = db.guardCreateIndexes(db.guardAddColumns(schema.HD_DESK_CALENDAR_SCHEMA));
    await pool().query(sql);
    await pool().query(sql);
    const cols = (await pool().query("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'hd_tickets' AND column_name IN ('parked_until', 'parked_at', 'park_reason', 'park_prep_days') ORDER BY column_name")).rows;
    assert.deepEqual(cols.map((c) => c.column_name), ["park_prep_days", "park_reason", "parked_at", "parked_until"]);
    const idx = (await pool().query("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_hd_tickets_parked'")).rows[0];
    assert.match(idx.indexdef, /WHERE \(parked_until IS NOT NULL\)/);
    assert.ok(!/\bDROP\b|\bTRUNCATE\b|DELETE FROM|UPDATE hd_tickets/i.test(schema.HD_DESK_CALENDAR_SCHEMA), "no data is changed");
    // The parking history is filled once from tickets parked before it existed: one open entry each, however often it runs.
    const t = await eventTicket("Parked before the history", 90);
    await park("agent", t.number, { action: "park" });
    await pool().query("DELETE FROM hd_ticket_parkings WHERE ticket_id = $1", [t.id]);
    await pool().query(sql);
    await pool().query(sql);
    const rows = (await pool().query("SELECT parked_at, woke_at, reason FROM hd_ticket_parkings WHERE ticket_id = $1", [t.id])).rows;
    assert.deepEqual([rows.length, rows[0].woke_at, rows[0].reason, iso(rows[0].parked_at)], [1, null, "agent", iso((await rowOf(t.id)).parked_at)]);
  });
});
