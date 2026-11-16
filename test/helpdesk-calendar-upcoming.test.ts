// Helpdesk 1.20.24: upcoming events in the desk's top bar and today's count
// on the Calendar rail icon (lib/helpdesk/desk-calendar upcomingEvents, the
// rules in desk-calendar-upcoming-shared, GET /api/helpdesk/calendar/upcoming).
//
//   pure     the pill's event (in progress counts, all-day never), its
//            words, the badge's count (all-day, ended and tomorrow's never;
//            the day cut in the agent's zone, DST days 23 and 25 hours),
//            the dropdown's days (All day first, "Day N of M", a running
//            night event under Today), the next instant anything changes.
//   data     who sees what (their teams' and their own tickets, as the
//            Calendar page; never cancelled, binned or merged), the 14-day
//            horizon at both ends, all-day events entered in a far zone,
//            long events found through the indexed range.
//   route    signed in, licensed, an agent.
//
// Same harness as test/helpdesk-event-calendar (next/headers and lib/ee
// stubbed, routes called with real sessions). Parallel-safe on a shared
// database: its own teams and people (STAMP), and its data events are in
// 2031 with `now` given, so nothing real is ever due for them.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-calendar-upcoming.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

let currentRequest: Request | null = null;
let licensed = true;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-calendar-upcoming.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-calendar-upcoming.virtual.js");
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
  ee.exports = { ee: () => ({ present: true, features: ["helpdesk"] }), eePresent: () => true, featureEnabled: async (f: string) => licensed && f === "helpdesk" };
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
const up = require("../src/lib/helpdesk/desk-calendar-upcoming-shared") as typeof import("../src/lib/helpdesk/desk-calendar-upcoming-shared");
const shared = require("../src/lib/helpdesk/desk-calendar-shared") as typeof import("../src/lib/helpdesk/desk-calendar-shared");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const upcomingRoute = require("../src/app/api/helpdesk/calendar/upcoming/route") as typeof import("../src/app/api/helpdesk/calendar/upcoming/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HdUpcomingEvent } from "../src/lib/helpdesk/desk-calendar-upcoming-shared";

async function call(handler: unknown, req: Request): Promise<{ status: number; body: any }> {
  currentRequest = req;
  try {
    const res = await (handler as (r: Request) => Promise<Response>)(req);
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body };
  } finally {
    currentRequest = null;
  }
}

const get = (session: string | null) =>
  call(upcomingRoute.GET, new Request("http://localhost/api/helpdesk/calendar/upcoming", { headers: session ? { cookie: `compass_session=${session}` } : {} }));

// --- Pure ------------------------------------------------------------------------------

const at = (iso: string) => new Date(iso).getTime();
let seq = 0;
const timed = (start: string, end: string, extra: Partial<HdUpcomingEvent> = {}): HdUpcomingEvent => ({
  number: ++seq,
  subject: `Timed ${seq}`,
  place: "",
  starts_at: new Date(start).toISOString(),
  ends_at: new Date(end).toISOString(),
  all_day: false,
  start_date: null,
  end_date: null,
  ...extra,
});
const allDay = (first: string, last: string, tz = "UTC", extra: Partial<HdUpcomingEvent> = {}): HdUpcomingEvent => {
  const t = shared.allDayInstants(first, last, tz);
  return { number: ++seq, subject: `All day ${seq}`, place: "", starts_at: new Date(t.starts_at).toISOString(), ends_at: new Date(t.ends_at).toISOString(), all_day: true, start_date: first, end_date: last, ...extra };
};

describe("the pill (pure)", () => {
  test("the next timed event that hasn't ended: one in progress first; ended and all-day never", () => {
    const now = at("2026-11-20T12:00:00Z");
    const ended = timed("2026-11-20T09:00:00Z", "2026-11-20T10:00:00Z");
    const running = timed("2026-11-20T11:30:00Z", "2026-11-20T12:30:00Z");
    const later = timed("2026-11-20T14:00:00Z", "2026-11-20T15:00:00Z");
    const wholeDay = allDay("2026-11-20", "2026-11-20");
    assert.equal(up.nextTimedEvent([later, wholeDay, running, ended], now)?.number, running.number);
    assert.equal(up.nextTimedEvent([later, wholeDay, ended], now)?.number, later.number);
    assert.equal(up.nextTimedEvent([wholeDay, ended], now), null, "only whole days and the past: no pill");
    assert.equal(up.nextTimedEvent([], now), null);
    // It moves on the moment the running one ends (its end is not "still running").
    assert.equal(up.nextTimedEvent([running, later], at("2026-11-20T12:30:00Z"))?.number, later.number);
    assert.equal(up.inProgress(running, now), true);
    assert.equal(up.inProgress(later, now), false);
  });

  test("its words: Now, a time today, Tomorrow, a weekday this week, a date after that; 12- or 24-hour", () => {
    const now = at("2026-11-20T12:00:00Z"); // a Friday
    const e = (start: string) => timed(start, new Date(at(start) + 3_600_000).toISOString());
    assert.equal(up.pillWhen(e("2026-11-20T11:30:00Z"), now, "UTC", true), "Now");
    assert.equal(up.pillWhen(e("2026-11-20T11:00:00Z"), now, "UTC", true), "11:00 AM", "ended exactly now: no longer running (the pill has moved on by then)");
    assert.equal(up.pillWhen(e("2026-11-20T14:00:00Z"), now, "UTC", true), "2:00 PM");
    assert.equal(up.pillWhen(e("2026-11-20T14:00:00Z"), now, "UTC"), "14:00");
    assert.equal(up.pillWhen(e("2026-11-21T09:00:00Z"), now, "UTC", true), "Tomorrow 9:00 AM");
    assert.equal(up.pillWhen(e("2026-11-26T09:00:00Z"), now, "UTC", true), "Thu 9:00 AM");
    assert.equal(up.pillWhen(e("2026-11-27T09:00:00Z"), now, "UTC", true), "Fri 27 Nov, 9:00 AM");
    // Read in the agent's zone: 23:30 UTC is already tomorrow in Tokyo.
    assert.equal(up.pillWhen(e("2026-11-20T23:30:00Z"), now, "Asia/Tokyo", true), "Tomorrow 8:30 AM");
    const ev = timed("2026-11-20T14:00:00Z", "2026-11-20T15:00:00Z", { subject: "Change freeze", place: "Boardroom A" });
    assert.equal(up.pillSummary(ev, now, "UTC", true), "Next event: Change freeze, Fri 20 Nov 2026, 2:00 PM to 3:00 PM at Boardroom A");
    assert.equal(up.pillSummary(ev, at("2026-11-20T14:10:00Z"), "UTC", true), "Happening now: Change freeze, Fri 20 Nov 2026, 2:00 PM to 3:00 PM at Boardroom A");
  });
});

describe("the rail badge (pure)", () => {
  test("today's timed events not yet ended: in progress counts; ended, all-day and tomorrow's don't", () => {
    const now = at("2026-11-20T12:00:00Z");
    const events = [
      timed("2026-11-20T08:00:00Z", "2026-11-20T09:00:00Z"), // ended
      timed("2026-11-20T11:00:00Z", "2026-11-20T12:15:00Z"), // running
      timed("2026-11-20T15:00:00Z", "2026-11-20T16:00:00Z"), // later today
      timed("2026-11-20T23:00:00Z", "2026-11-21T01:00:00Z"), // starts today, ends tomorrow
      timed("2026-11-21T00:00:00Z", "2026-11-21T01:00:00Z"), // tomorrow at midnight
      timed("2026-11-19T22:00:00Z", "2026-11-20T13:00:00Z"), // began yesterday, still running
      allDay("2026-11-20", "2026-11-20"),
      allDay("2026-11-18", "2026-11-22"),
    ];
    assert.equal(up.todayLeft(events, now, "UTC"), 4);
    // The count drops as each ends, with no reload.
    assert.equal(up.todayLeft(events, at("2026-11-20T12:15:00Z"), "UTC"), 3);
    assert.equal(up.todayLeft(events, at("2026-11-20T13:00:00Z"), "UTC"), 2);
    assert.equal(up.todayLeft(events, at("2026-11-20T16:00:00Z"), "UTC"), 1);
    assert.equal(up.todayLeft(events, at("2026-11-20T23:59:00Z"), "UTC"), 1);
    assert.equal(up.todayLeft([allDay("2026-11-20", "2026-11-20")], now, "UTC"), 0, "all-day events never count");
    assert.equal(up.badgeWords(3), "events left today");
    assert.equal(up.badgeWords(1), "event left today");
  });

  test("today is the agent's: Tokyo and Los Angeles cut the same events differently", () => {
    const now = at("2026-11-20T12:00:00Z"); // 21:00 Fri in Tokyo, 04:00 Fri in Los Angeles
    const events = [
      timed("2026-11-20T14:00:00Z", "2026-11-20T15:00:00Z"), // Tokyo: 23:00 Fri. LA: 06:00 Fri.
      timed("2026-11-20T16:00:00Z", "2026-11-20T17:00:00Z"), // Tokyo: 01:00 Sat. LA: 08:00 Fri.
      timed("2026-11-21T09:00:00Z", "2026-11-21T10:00:00Z"), // Tokyo: 18:00 Sat. LA: 01:00 Sat.
    ];
    assert.equal(up.todayLeft(events, now, "Asia/Tokyo"), 1);
    assert.equal(up.todayLeft(events, now, "America/Los_Angeles"), 2);
    assert.equal(up.todayLeft(events, now, "UTC"), 2);
  });

  test("a day the clocks change is 23 or 25 hours long, and the count follows the real midnight", () => {
    // London, 29 March 2026: the clocks go forward; the day ends at 23:00 UTC.
    const spring = at("2026-03-29T12:00:00Z");
    const lateSpring = timed("2026-03-29T22:30:00Z", "2026-03-29T22:45:00Z"); // 23:30 BST: today
    const pastMidnight = timed("2026-03-29T23:30:00Z", "2026-03-29T23:45:00Z"); // 00:30 BST on the 30th: tomorrow
    assert.equal(up.todayLeft([lateSpring, pastMidnight], spring, "Europe/London"), 1);
    // London, 25 October 2026: the clocks go back; the day runs from 23:00 UTC on the 24th to 00:00 UTC on the 26th.
    const autumn = at("2026-10-25T12:00:00Z");
    const lateAutumn = timed("2026-10-25T23:30:00Z", "2026-10-25T23:45:00Z"); // 23:30 GMT: still today (25 hours)
    assert.equal(up.todayLeft([lateAutumn], autumn, "Europe/London"), 1);
    assert.equal(up.nextChangeAt([], autumn, "Europe/London"), at("2026-10-26T00:00:00Z"), "the next midnight, 25 hours after the last");
    assert.equal(up.nextChangeAt([], spring, "Europe/London"), at("2026-03-29T23:00:00Z"));
    assert.equal(up.pillWhen(pastMidnight, spring, "Europe/London"), "Tomorrow 00:30");
  });

  test("the timer: the next end, start or midnight after now", () => {
    const now = at("2026-11-20T12:00:00Z");
    const running = timed("2026-11-20T11:00:00Z", "2026-11-20T12:40:00Z");
    const later = timed("2026-11-20T12:20:00Z", "2026-11-20T13:00:00Z");
    assert.equal(up.nextChangeAt([running, later], now, "UTC"), at("2026-11-20T12:20:00Z"), "a start turns the pill to Now");
    assert.equal(up.nextChangeAt([running], now, "UTC"), at("2026-11-20T12:40:00Z"), "an end drops the count");
    assert.equal(up.nextChangeAt([allDay("2026-11-20", "2026-11-21")], now, "UTC"), at("2026-11-21T00:00:00Z"), "whole days change at midnight");
    assert.equal(up.nextChangeAt([timed("2026-11-25T10:00:00Z", "2026-11-25T11:00:00Z")], now, "Asia/Tokyo"), at("2026-11-20T15:00:00Z"), "Tokyo's midnight");
    assert.equal(up.nextChangeAt([running], now, "UTC", at("2026-11-20T12:30:00Z")), at("2026-11-20T12:30:00Z"), "a truncated answer's reload point");
    assert.equal(up.nextChangeAt([running], now, "UTC", at("2026-11-20T11:30:00Z")), at("2026-11-20T12:40:00Z"), "a reload point already passed is not a wait");
  });

  test("a truncated answer: reloaded at its last kept start; the badge says it could be more when that is today", () => {
    const now = at("2026-11-20T12:00:00Z");
    const a = timed("2026-11-20T11:00:00Z", "2026-11-20T13:00:00Z");
    const b = timed("2026-11-20T15:00:00Z", "2026-11-20T16:00:00Z");
    const c = timed("2026-11-22T15:00:00Z", "2026-11-22T16:00:00Z");
    assert.equal(up.truncatedFrom({ events: [a, b], truncated: false }), null);
    assert.equal(up.truncatedFrom({ events: [a, b], truncated: true }), at("2026-11-20T15:00:00Z"));
    assert.equal(up.todayLeftMore({ events: [a, b], truncated: true }, now, "UTC"), true, "cut today: tomorrow's 200th could hide today's");
    assert.equal(up.todayLeftMore({ events: [a, b, c], truncated: true }, now, "UTC"), false, "cut after today: today's count is whole");
    assert.equal(up.todayLeftMore({ events: [a, b], truncated: false }, now, "UTC"), false);
    assert.deepEqual([up.badgeText(3), up.badgeText(12, true), up.badgeText(100), up.badgeText(150, true)], ["3", "12+", "99+", "99+"]);
    assert.equal(up.badgeWords(12, true), "or more events left today");
  });
});

describe("the dropdown (pure)", () => {
  test("by day: Today, Tomorrow, then dates; All day first with Day N of M on each day; timed by start; the horizon", () => {
    const now = at("2026-11-20T12:00:00Z"); // Friday
    const running = timed("2026-11-19T22:00:00Z", "2026-11-20T13:00:00Z", { subject: "Night works" });
    const ended = timed("2026-11-20T08:00:00Z", "2026-11-20T09:00:00Z", { subject: "Done" });
    const today3 = timed("2026-11-20T15:00:00Z", "2026-11-20T16:00:00Z", { subject: "Board", place: "Room 1" });
    const tomorrow = timed("2026-11-21T09:00:00Z", "2026-11-21T10:00:00Z", { subject: "Saturday" });
    const conf = allDay("2026-11-18", "2026-11-22", "UTC", { subject: "Conference" });
    const holiday = allDay("2026-11-20", "2026-11-20", "UTC", { subject: "Holiday" });
    const late = timed("2026-12-03T09:00:00Z", "2026-12-03T10:00:00Z", { subject: "Day 13" });
    const tooLate = timed("2026-12-04T09:00:00Z", "2026-12-04T10:00:00Z", { subject: "Day 14" });
    const longFair = allDay("2026-12-02", "2026-12-10", "UTC", { subject: "Fair" });
    const days = up.upcomingDays([today3, tomorrow, conf, holiday, running, ended, late, tooLate, longFair], now, "UTC", 14);
    assert.deepEqual(
      days.map((d) => d.heading),
      ["Today", "Tomorrow", "Sun 22 Nov", "Wed 2 Dec", "Thu 3 Dec"]
    );
    const [t, tm, sun, wed, thu] = days;
    assert.deepEqual(t.allDay.map((a) => [a.event.subject, up.dayOfLabel(a)]), [["Conference", "Day 3 of 5"], ["Holiday", ""]]);
    assert.deepEqual(t.timed.map((x) => [x.event.subject, x.now]), [["Night works", true], ["Board", false]], "the night event that is still running is listed under Today; the ended one is gone");
    assert.deepEqual(tm.allDay.map((a) => up.dayOfLabel(a)), ["Day 4 of 5"]);
    assert.deepEqual(tm.timed.map((x) => x.event.subject), ["Saturday"]);
    assert.deepEqual(sun.allDay.map((a) => up.dayOfLabel(a)), ["Day 5 of 5"]);
    assert.deepEqual(wed.allDay.map((a) => [a.event.subject, up.dayOfLabel(a)]), [["Fair", "Day 1 of 9"]]);
    assert.deepEqual(thu.allDay.map((a) => up.dayOfLabel(a)), ["Day 2 of 9"]);
    assert.deepEqual(thu.timed.map((x) => x.event.subject), ["Day 13"], "day 14 is past the horizon");
    assert.equal(up.allDayToday([conf, holiday, tomorrow], now, "UTC"), 2);
    assert.equal(up.allDayTodayLabel(2), "Today: 2 all-day events");
    assert.equal(up.allDayTodayLabel(1), "Today: 1 all-day event");
    assert.equal(up.allDayTodayLabel(0), "");
    assert.equal(up.rowTimes(running, "2026-11-20", "UTC", true), "Thu 19 Nov, 10:00 PM to 1:00 PM");
    assert.equal(up.rowTimes(today3, "2026-11-20", "UTC", true), "3:00 PM to 4:00 PM");
    assert.equal(up.calendarDayHref("2026-11-20"), "/desk/calendar?view=day&date=2026-11-20&team=0", "all the agent's teams, whatever filter the Calendar remembers");
  });

  test("whole days are calendar days wherever they were entered; timed events land on the agent's day", () => {
    const now = at("2026-11-20T20:00:00Z"); // 12:00 Fri in Los Angeles
    // Entered in Auckland: its instants begin on the 19th in LA, but it is the 20th.
    const auck = allDay("2026-11-20", "2026-11-20", "Pacific/Auckland", { subject: "Auckland day" });
    const evening = timed("2026-11-21T03:00:00Z", "2026-11-21T04:00:00Z", { subject: "LA evening" }); // 19:00 Fri in LA
    const days = up.upcomingDays([auck, evening], now, "America/Los_Angeles");
    assert.equal(days.length, 1);
    assert.equal(days[0].day, "2026-11-20");
    assert.deepEqual([days[0].allDay[0].event.subject, days[0].timed[0].event.subject], ["Auckland day", "LA evening"]);
    assert.equal(up.todayLeft([auck, evening], now, "America/Los_Angeles"), 1);
  });
});

// --- Data and route --------------------------------------------------------------------

const STAMP = `hdup-${Date.now()}-${process.pid}`;
const P: Record<string, { id: number; session: string }> = {};
const T: Record<string, number> = {};
const userIds: number[] = [];
const ticketIds: number[] = [];

async function person(key: string, deskRole: string | null, timezone = "") {
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status, timezone) VALUES ($1, $2, $3, 'viewer', 'active', $4) RETURNING id`, [`${STAMP}-${key}`, `${key} ${STAMP}`, `${STAMP}-${key}@example.test`, timezone]);
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  userIds.push(id);
  if (deskRole) await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [id, deskRole]);
  P[key] = { id, session };
}

async function ticket(subject: string, team: string | null = "A", extra: { assignee?: number | null } = {}): Promise<{ id: number; number: number }> {
  const r = await pool().query(
    "INSERT INTO hd_tickets (subject, requester_name, requester_email, team_id, status, source, assignee_id) VALUES ($1, 'Req', $2, $3, 'open', 'portal', $4) RETURNING id, number",
    [`${subject} ${STAMP}`, `${STAMP}-req@example.test`, team ? T[team] : null, extra.assignee ?? null]
  );
  ticketIds.push(r.rows[0].id);
  return r.rows[0];
}

/** A ticket with an event, written straight to the table (times in the past included, as an event that has run). */
async function evTicket(subject: string, when: { start: string; end: string } | { days: [string, string]; tz?: string }, o: { team?: string | null; assignee?: number; cancelled?: boolean } = {}) {
  const t = await ticket(subject, o.team === undefined ? "A" : o.team, { assignee: o.assignee ?? null });
  const day = "days" in when;
  const inst = day ? shared.allDayInstants(when.days[0], when.days[1], when.tz ?? "UTC") : { starts_at: at(when.start), ends_at: at(when.end) };
  await pool().query(
    `INSERT INTO hd_ticket_events (ticket_id, starts_at, ends_at, all_day, start_date, end_date, timezone, place, place_key, setup_minutes, ready_at, cancelled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '', '', 0, $2, $8)`,
    [t.id, new Date(inst.starts_at), new Date(inst.ends_at), day ? 1 : 0, day ? when.days[0] : null, day ? when.days[1] : null, day ? (when.tz ?? "UTC") : "UTC", o.cancelled ? new Date() : null]
  );
  return t;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(roles.HD_DEFAULT_MATRIX);
  T.A = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9424) RETURNING id", [`${STAMP} A`])).rows[0].id;
  T.B = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9424) RETURNING id", [`${STAMP} B`])).rows[0].id;
  await person("agent", "agent", "UTC");
  await person("tokyo", "agent", "Asia/Tokyo");
  await person("other", "agent", "UTC");
  await person("admin", "manager", "UTC");
  await person("req", null, "UTC");
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent'), ($1, $3, 'agent'), ($4, $5, 'agent')", [T.A, P.agent.id, P.tokyo.id, T.B, P.other.id]);
});

after(async () => {
  roles.setRoleMatrixForTests(null);
  licensed = true;
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [ticketIds]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [Object.values(T)]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

describe("the data (upcomingEvents)", () => {
  // Monday 10 March 2031, noon UTC.
  const NOW = new Date("2031-03-10T12:00:00Z");
  const E: Record<string, number> = {};

  before(async () => {
    const mk = async (k: string, when: Parameters<typeof evTicket>[1], o: Parameters<typeof evTicket>[2] = {}) => (E[k] = (await evTicket(k, when, o)).number);
    await mk("ended", { start: "2031-03-10T09:00:00Z", end: "2031-03-10T10:00:00Z" });
    await mk("running", { start: "2031-03-10T11:00:00Z", end: "2031-03-10T13:00:00Z" });
    await mk("later", { start: "2031-03-10T15:00:00Z", end: "2031-03-10T16:00:00Z" });
    await mk("wholeToday", { days: ["2031-03-10", "2031-03-10"] });
    await mk("conference", { days: ["2031-03-08", "2031-03-12"] });
    await mk("wholeYesterday", { days: ["2031-03-09", "2031-03-09"] });
    await mk("tomorrow", { start: "2031-03-11T09:00:00Z", end: "2031-03-11T10:00:00Z" });
    await mk("day13", { start: "2031-03-23T09:00:00Z", end: "2031-03-23T10:00:00Z" });
    await mk("day14", { start: "2031-03-24T09:00:00Z", end: "2031-03-24T10:00:00Z" });
    await mk("fairFrom13", { days: ["2031-03-23", "2031-03-26"] });
    await mk("fairFrom14", { days: ["2031-03-24", "2031-03-26"] });
    await mk("cancelled", { start: "2031-03-10T14:00:00Z", end: "2031-03-10T14:30:00Z" }, { cancelled: true });
    await mk("teamB", { start: "2031-03-10T14:30:00Z", end: "2031-03-10T15:30:00Z" }, { team: "B" });
    await mk("mineInB", { start: "2031-03-10T17:00:00Z", end: "2031-03-10T18:00:00Z" }, { team: "B", assignee: P.agent.id });
    await mk("binned", { start: "2031-03-10T14:00:00Z", end: "2031-03-10T15:00:00Z" });
    await mk("merged", { start: "2031-03-10T14:00:00Z", end: "2031-03-10T15:00:00Z" });
    // The longest event there is (31 days), still running: found by its end, however long ago it started.
    await mk("marathon", { start: "2031-02-08T12:30:00Z", end: "2031-03-11T12:30:00Z" });
    // Entered in Auckland: its instants start on the 9th in UTC, but its day is the 10th.
    await mk("auckland", { days: ["2031-03-10", "2031-03-10"], tz: "Pacific/Auckland" });
    // The far edge of the slack: entered at UTC+14, its day is over (in UTC) a whole day before it ends at UTC−11.
    await mk("kiritimati", { days: ["2031-04-09", "2031-04-09"], tz: "Pacific/Kiritimati" });
    await pool().query("UPDATE hd_tickets SET deleted_at = now() WHERE number = $1", [E.binned]);
    await pool().query("UPDATE hd_tickets SET merged_into = (SELECT id FROM hd_tickets WHERE number = $2) WHERE number = $1", [E.merged, E.later]);
  });

  const mine = (events: HdUpcomingEvent[]) => new Set(events.map((e) => e.number).filter((n) => Object.values(E).includes(n)));
  const name = (n: number) => Object.keys(E).find((k) => E[k] === n);
  const names = (events: HdUpcomingEvent[]) => [...mine(events)].map(name).sort();

  test("an agent gets their teams' and their own tickets' events still to come in 14 days; never cancelled, binned, merged or past", async () => {
    const d = await cal.upcomingEvents({ id: P.agent.id, role: "viewer" }, { tz: "UTC", now: NOW });
    assert.equal(d.timezone, "UTC");
    assert.equal(d.today, "2031-03-10");
    assert.equal(d.horizon_days, 14);
    assert.deepEqual(names(d.events), ["auckland", "conference", "day13", "fairFrom13", "later", "marathon", "mineInB", "running", "tomorrow", "wholeToday"].sort());
    const ours = d.events.filter((e) => mine([e]).size);
    const starts = ours.map((e) => e.starts_at);
    assert.deepEqual(starts, [...starts].sort(), "ordered by start");
    const conf = ours.find((e) => e.number === E.conference)!;
    assert.deepEqual([conf.all_day, conf.start_date, conf.end_date, conf.subject], [true, "2031-03-08", "2031-03-12", `conference ${STAMP}`]);
    const run = ours.find((e) => e.number === E.running)!;
    assert.deepEqual([run.all_day, run.start_date, run.starts_at, run.ends_at], [false, null, "2031-03-10T11:00:00.000Z", "2031-03-10T13:00:00.000Z"]);

    // What the desk makes of it: the pill, the badge and the dropdown.
    const now = NOW.getTime();
    // The marathon started weeks ago and still runs, so it comes first; without it the 11:00 meeting does.
    assert.equal(up.nextTimedEvent(ours, now)?.number, E.marathon);
    assert.equal(up.nextTimedEvent(ours.filter((e) => e.number !== E.marathon), now)?.number, E.running);
    assert.equal(up.todayLeft(ours, now, "UTC"), 4, "the marathon, the running one, the 15:00 and their own in team B");
    assert.equal(up.todayLeft(ours, at("2031-03-10T13:00:00Z"), "UTC"), 3);
    assert.equal(up.todayLeft(ours, at("2031-03-10T18:00:00Z"), "UTC"), 1, "only the marathon is left");
    assert.equal(up.allDayToday(ours, now, "UTC"), 3);
    const days = up.upcomingDays(ours, now, "UTC", d.horizon_days);
    assert.deepEqual(days.map((x) => x.heading), ["Today", "Tomorrow", "Wed 12 Mar", "Sun 23 Mar"]);
    // All day first: by first day, then as created (the Auckland one was entered after the plain one).
    assert.deepEqual(days[0].allDay.map((a) => [name(a.event.number), up.dayOfLabel(a)]), [["conference", "Day 3 of 5"], ["wholeToday", ""], ["auckland", ""]]);
    assert.deepEqual(days[0].timed.map((x) => name(x.event.number)), ["marathon", "running", "later", "mineInB"]);
    assert.deepEqual(days[3].allDay.map((a) => up.dayOfLabel(a)), ["Day 1 of 4"]);
    assert.deepEqual(days[3].timed.map((x) => name(x.event.number)), ["day13"]);
  });

  test("another team's agent sees only theirs; a manager sees every team", async () => {
    const other = await cal.upcomingEvents({ id: P.other.id, role: "viewer" }, { tz: "UTC", now: NOW });
    assert.deepEqual(names(other.events), ["mineInB", "teamB"].sort());
    const admin = await cal.upcomingEvents({ id: P.admin.id, role: "viewer" }, { tz: "UTC", now: NOW });
    assert.ok(names(admin.events).includes("teamB") && names(admin.events).includes("running"));
    assert.ok(!names(admin.events).includes("cancelled") && !names(admin.events).includes("binned") && !names(admin.events).includes("merged"));
    const req = await cal.upcomingEvents({ id: P.req.id, role: "viewer" }, { tz: "UTC", now: NOW });
    assert.equal(mine(req.events).size, 0, "someone who works no team sees nothing");
  });

  test("today and the horizon are the agent's own: Tokyo's day ends at 15:00 UTC", async () => {
    const d = await cal.upcomingEvents({ id: P.tokyo.id, role: "viewer" }, { tz: "Asia/Tokyo", now: NOW });
    assert.equal(d.today, "2031-03-10", "21:00 on the 10th in Tokyo");
    const ours = d.events.filter((e) => mine([e]).size);
    // In Tokyo the 15:00 UTC meeting is at midnight on the 11th: tomorrow, not today.
    assert.equal(up.todayLeft(ours, NOW.getTime(), "Asia/Tokyo"), 2, "the marathon and the running one");
    // The last day in Tokyo is the 23rd there: 09:00 UTC on the 23rd is 18:00 on the 23rd (in), on the 24th is 18:00 on the 24th (out).
    assert.ok(names(ours).includes("day13") && !names(ours).includes("day14"));
    // A viewer far west of the event's own zone still gets the Auckland day as the 10th.
    const la = await cal.upcomingEvents({ id: P.agent.id, role: "viewer" }, { tz: "America/Los_Angeles", now: new Date("2031-03-10T20:00:00Z") });
    assert.ok(names(la.events).includes("auckland"));
    assert.ok(names(la.events).includes("wholeToday"));
    // 23:00 on 9 April in Pago Pago (UTC−11) is 10:00 UTC on the 10th: the Kiritimati day (UTC+14) ended 24 hours
    // earlier in UTC, yet it is still today here. The search reaches back 2 days by end, so it is found.
    const pago = await cal.upcomingEvents({ id: P.agent.id, role: "viewer" }, { tz: "Pacific/Pago_Pago", now: new Date("2031-04-10T10:00:00Z") });
    assert.equal(pago.today, "2031-04-09");
    assert.ok(names(pago.events).includes("kiritimati"));
    assert.equal(up.allDayToday(pago.events.filter((e) => e.number === E.kiritimati), Date.parse("2031-04-10T10:00:00Z"), "Pacific/Pago_Pago"), 1);
    assert.ok(!names((await cal.upcomingEvents({ id: P.agent.id, role: "viewer" }, { tz: "UTC", now: new Date("2031-04-10T10:00:00Z") })).events).includes("kiritimati"), "in UTC the 9th is over");
  });

  test("a bad zone reads as UTC", async () => {
    const d = await cal.upcomingEvents({ id: P.agent.id, role: "viewer" }, { tz: "Not/AZone", now: NOW });
    assert.equal(d.timezone, "UTC");
  });
});

describe("the route", () => {
  test("signed in, licensed, an agent: the agent's own zone, today and the events to come", async () => {
    const t = await evTicket("Route soon", { start: new Date(Date.now() + 3_600_000).toISOString(), end: new Date(Date.now() + 7_200_000).toISOString() });
    const r = await get(P.agent.session);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.timezone, "UTC");
    assert.equal(r.body.today, shared.dayOf(Date.now(), "UTC"));
    assert.equal(r.body.horizon_days, up.UPCOMING_HORIZON_DAYS);
    assert.equal(typeof r.body.truncated, "boolean");
    const e = r.body.events.find((x: HdUpcomingEvent) => x.number === t.number);
    assert.ok(e, "the event an hour from now is there");
    assert.deepEqual(Object.keys(e).sort(), ["all_day", "end_date", "ends_at", "number", "place", "start_date", "starts_at", "subject"], "only what the pill, the list and the badge need");
    const tokyo = await get(P.tokyo.session);
    assert.equal(tokyo.body.timezone, "Asia/Tokyo");
    assert.equal((await get(P.other.session)).body.events.some((x: HdUpcomingEvent) => x.number === t.number), false, "another team's agent doesn't see it");
  });

  test("refused without a session (401), without the licence (402), and to someone who isn't an agent (403)", async () => {
    assert.equal((await get(null)).status, 401);
    assert.equal((await get(P.req.session)).status, 403);
    licensed = false;
    try {
      assert.equal((await get(P.agent.session)).status, 402);
    } finally {
      licensed = true;
    }
  });
});
