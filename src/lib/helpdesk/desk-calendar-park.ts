// Helpdesk 1.20.34: "Hold until the event" (the pure half, the wake maths
// and the words, is lib/helpdesk/desk-calendar-park-shared; the columns are
// in lib/helpdesk/desk-calendar-schema).
//
// A ticket whose event is months away need not sit in the queue, age and
// breach its targets. Parking puts it on hold (status on_hold, so its SLA
// clocks pause as on hold always did) with a wake time; it comes back to
// open, to its owner or its team, the prep window's working days before its
// event's setup must be ready.
//
//   park      the Event block's Hold until the event, the API and the Claude
//             connector (`event: { park: "park" }`), by agents who may change
//             the ticket's status; or by itself, after the acknowledgement,
//             when a meeting invite opened the ticket or a request type that
//             goes on the calendar did (Desk settings → Event calendar, both
//             on by default). Refused, with one sentence and nothing changed,
//             when the wake time is past or within the hour; a ticket that
//             parks itself then simply stays open.
//   while     out of every view of open work (the Parked view lists them by
//             wake time, with a count); its clocks are paused (on hold); the
//             event's setup reminders, auto-assignment's away and unanswered
//             passes and retention's auto-close never touch it (each reads
//             only open, unpaused or solved tickets, or skips parked ones).
//             Agents' replies, notes and field changes leave it parked.
//   wake      the minute sweep (lib/periodic HELPDESK_SWEEPS hd_event_park)
//             takes each due ticket under its row lock, FOR UPDATE SKIP
//             LOCKED, so of several instances exactly one wakes it: back to
//             open, the clocks resume with the business time they had left,
//             parking cleared, an agents-only line ("Woke for the event on
//             Sun 15 Mar"), the ticket.updated webhook, and a notice to its
//             owner, else its team (bell, email and push by each agent's
//             Event reminders setting). As the workflow wait's wake, it runs
//             no "A ticket is updated" rules: a rule must not answer the
//             requester for a change nobody made. Also woken at once by: a
//             message from the requester or someone copied (lib/helpdesk/
//             messages), the event cancelled (with "The event was cancelled.
//             Close this ticket if nothing else is needed."), the event
//             removed, the event moved so near that its wake time has passed,
//             any status change (lib/helpdesk/tickets updateTicket clears
//             parking), or Wake now.
//   follows   a changed start, all-day flag or setup lead time (an agent, the
//             API, the connector, an updated invite) recomputes the wake time,
//             with a line when it moved (lib/helpdesk/desk-calendar calls
//             followEventChange after its commit).
//   requester Get help and the portal show a parked ticket as "Scheduled ·
//             Sun 15 Mar, 10:00 · Room 4"; park and wake send them nothing.
//             Optionally (off by default) one reminder email some days before
//             the event, once per event date (requesterReminderSweep).
//
// Every park, wake and prep window change is one agents-only activity line
// (via 'system', event 'change') and an audit row. Server-only.

import "server-only";
import { audit } from "../audit";
import { logEvent } from "../log";
import { hq, hqOne, withTx, type HdQueryable } from "./db-core";
import { mdInline } from "./md-inline";
import { HD_CHANGE_EVENT } from "./conversation-shared";
import { bankPausedBusiness, hoursForTeam, slaPolicyForTeam } from "./calendars";
import { resumedDues } from "./sla";
import { eventRow, getCalendarSettings, toEvent } from "./desk-calendar";
import { dayOf, eventWhen, leadLabel, readyByLabel, timeLabel, validZone, zoneLabel, type HdTicketEvent } from "./desk-calendar-shared";
import {
  checkPrepDays,
  eventDay,
  HD_PARK_REASONS,
  PARK_LIMITS,
  prepLabel,
  tooCloseToPark,
  wakeDay,
  wakeInstant,
  type HdParking,
  type HdParkingView,
  type HdParkReason,
} from "./desk-calendar-park-shared";
import { PARK_HISTORY_CLOSE_SQL } from "./desk-calendar-schema";
import type { HdBusinessHours, HdPriority, HdScheduled, HdStatus } from "./types";

/** A ticket parks itself only for an event starting within this many days (a by-hand park has no limit). */
export const AUTO_PARK_MAX_DAYS = 400;
/** The wake sweep gives up its usual steps after this many failed attempts on one ticket (see wakeFailed). */
export const PARK_WAKE_MAX_FAILURES = 5;

export * from "./desk-calendar-park-shared";

export class ParkError extends Error {
  constructor(message: string, public status = 409) {
    super(message);
  }
}

/** Who parked, woke or changed it, and through what (as lib/helpdesk/desk-calendar EventActor). */
export interface ParkActor {
  id: number | null;
  name: string;
  role?: string | null;
  via?: "mcp" | "api" | "claude_desk";
}

const SYSTEM: ParkActor = { id: null, name: "Helpdesk" };
const viaSuffix = (a: ParkActor) => (a.via === "mcp" ? " via Claude" : a.via === "api" ? " via API" : a.via === "claude_desk" ? " via Claude in the desk" : "");

interface ParkRow {
  id: number;
  number: number;
  subject: string;
  status: HdStatus;
  priority: HdPriority;
  team_id: number | null;
  assignee_id: number | null;
  merged_into: number | null;
  deleted_at: string | null;
  sla_paused_at: string | null;
  sla_paused_ms: number | string | null;
  first_reply_due: string | null;
  resolve_due: string | null;
  first_replied_at: string | null;
  parked_until: string | null;
  parked_at: string | null;
  park_reason: string;
  park_prep_days: number | null;
  park_wake_failures: number;
}

const ROW = `id, number, subject, status, priority, team_id, assignee_id, merged_into, deleted_at, sla_paused_at, sla_paused_ms,
  first_reply_due, resolve_due, first_replied_at, parked_until, parked_at, park_reason, park_prep_days, park_wake_failures`;

const PARKABLE: readonly HdStatus[] = ["new", "open", "pending", "on_hold"];

/** The ticket's team calendar, with a zone we can count in. */
async function calendarOf(teamId: number | null, client?: HdQueryable): Promise<HdBusinessHours> {
  const hours = await hoursForTeam(teamId, client);
  return validZone(hours.timezone) ? hours : { ...hours, timezone: "UTC" };
}

/** An agents-only activity line (1.20.28: via 'system', event 'change'), and the ticket's updated_at. */
async function line(client: HdQueryable, ticketId: number, actor: ParkActor, body: string, now: Date): Promise<void> {
  await client.query(
    `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, created_at, event) VALUES ($1, $2, $3, 'internal', $4, 'system', $5, $6)`,
    [ticketId, actor.id, actor.name.slice(0, 200), `${body}${viaSuffix(actor)}`, now, HD_CHANGE_EVENT]
  );
}

/** "Tue 3 Mar, 09:00 (London time)": a wake time in a line (Markdown: the ":" escaped). */
function wakeWords(at: number, tz: string, now: number): string {
  return mdInline(`${wakeDay(at, tz, now)}, ${timeLabel(at, tz)} (${zoneLabel(tz)})`);
}

const isReason = (v: unknown): v is HdParkReason => (HD_PARK_REASONS as readonly unknown[]).includes(v);

// --- Reads ----------------------------------------------------------------------------

/** The ticket's parking (lib/helpdesk/detail, the API, the connector). Null for a ticket with no event that isn't parked. */
export async function parkingOf(ticketId: number, client?: HdQueryable): Promise<HdParking | null> {
  const t = await hqOne<ParkRow>(`SELECT ${ROW} FROM hd_tickets WHERE id = $1`, [ticketId], client);
  if (!t) return null;
  const e = await eventRow(ticketId, client);
  if (!e && !t.parked_until) return null;
  const settings = await getCalendarSettings();
  return parkingFields(t, settings.park_prep_days);
}

function parkingFields(t: ParkRow, deskPrep: number): HdParking {
  const parked = !!t.parked_until;
  return {
    parked_until: parked ? new Date(t.parked_until!).toISOString() : null,
    parked_at: parked && t.parked_at ? new Date(t.parked_at).toISOString() : null,
    reason: parked && isReason(t.park_reason) ? t.park_reason : null,
    prep_days: t.park_prep_days ?? deskPrep,
    prep_override: t.park_prep_days ?? null,
    default_prep_days: deskPrep,
  };
}

/**
 * The Event block's view: the parking, whether the viewer may change it, and
 * when it would wake now with `prepDays` (default: what applies to it).
 */
export async function parkingView(ticketId: number, canChange: boolean, opts: { prepDays?: number | null; now?: Date } = {}): Promise<HdParkingView | null> {
  const t = await hqOne<ParkRow>(`SELECT ${ROW} FROM hd_tickets WHERE id = $1`, [ticketId]);
  if (!t) return null;
  const e = await eventRow(ticketId);
  const settings = await getCalendarSettings();
  const base = parkingFields(t, settings.park_prep_days);
  const live = !!e && !e.cancelled_at;
  const open = PARKABLE.includes(t.status) && !t.merged_into && !t.deleted_at;
  const prep = opts.prepDays !== undefined ? opts.prepDays ?? settings.park_prep_days : base.prep_days;
  let preview: HdParkingView["preview"] = null;
  if (live) {
    const hours = await calendarOf(t.team_id);
    const now = (opts.now ?? new Date()).getTime();
    const wake = wakeInstant(toEvent(e), prep, hours);
    preview = { wake_at: new Date(wake).toISOString(), refusal: tooCloseToPark(wake, now, hours.timezone) };
  }
  return { ...base, can_change: canChange && open, can_park: canChange && open && live && !t.parked_until, preview };
}

/** The API's top-level fields (GET and PATCH /api/helpdesk/v1/tickets/{number}): parked_until, park_reason and the prep window that applies. */
export async function parkingApiFields(ticketId: number): Promise<{ parked_until: string | null; park_reason: HdParkReason | null; park_prep_days: number; park_prep_days_own: number | null }> {
  try {
    const t = await hqOne<ParkRow>(`SELECT ${ROW} FROM hd_tickets WHERE id = $1`, [ticketId]);
    const settings = await getCalendarSettings();
    const p = t ? parkingFields(t, settings.park_prep_days) : null;
    return { parked_until: p?.parked_until ?? null, park_reason: p?.reason ?? null, park_prep_days: p?.prep_days ?? settings.park_prep_days, park_prep_days_own: p?.prep_override ?? null };
  } catch {
    return { parked_until: null, park_reason: null, park_prep_days: 10, park_prep_days_own: null };
  }
}

/** Get help and the portal: the parked tickets' events among these ids (when and where only). */
export async function scheduledFor(ticketIds: number[]): Promise<Map<number, HdScheduled>> {
  const out = new Map<number, HdScheduled>();
  if (!ticketIds.length) return out;
  try {
    const rows = await hq<{ ticket_id: number; starts_at: string; all_day: number; start_date: string | null; place: string }>(
      `SELECT e.ticket_id, e.starts_at, e.all_day, to_char(e.start_date, 'YYYY-MM-DD') AS start_date, e.place
         FROM hd_ticket_events e JOIN hd_tickets t ON t.id = e.ticket_id
        WHERE e.ticket_id = ANY($1::int[]) AND t.parked_until IS NOT NULL AND t.status = 'on_hold' AND e.cancelled_at IS NULL`,
      [ticketIds]
    );
    for (const r of rows) {
      out.set(r.ticket_id, { starts_at: new Date(r.starts_at).toISOString(), all_day: r.all_day === 1, start_date: r.all_day === 1 ? r.start_date : null, place: r.place });
    }
  } catch (e) {
    logEvent("error", "helpdesk.park_read_failed", { error: e instanceof Error ? e.message : String(e) });
  }
  return out;
}

// --- Park --------------------------------------------------------------------------------

export interface ParkOptions {
  /** The ticket's own prep window: a number sets it, null clears it (the desk's applies), undefined keeps it. */
  prepDays?: number | null;
  reason?: HdParkReason;
  /** A ticket parking itself: a refusal is answered, not thrown. */
  auto?: boolean;
  origin?: string;
  now?: Date;
}

export interface ParkResult {
  parked: boolean;
  wake_at: string | null;
  /** Why it was not parked (auto only). */
  refusal?: string;
}

/**
 * Park the ticket until its event: on hold (its clocks paused) with a wake
 * time. Throws ParkError with one sentence (and changes nothing) when it
 * can't be: no live event, solved, closed, merged, already parked, or the
 * wake time is past or within the hour. With `auto`, those are answered.
 */
export async function parkTicket(ticketId: number, actor: ParkActor, opts: ParkOptions = {}): Promise<ParkResult> {
  const now = opts.now ?? new Date();
  const reason = opts.reason ?? "agent";
  const settings = await getCalendarSettings();
  let prepIn: number | null | undefined = opts.prepDays;
  if (prepIn !== undefined) {
    const c = checkPrepDays(prepIn);
    if (!c.ok) throw new ParkError(c.error, 400);
    prepIn = c.value;
  }
  const refuse = (msg: string, status = 409): ParkResult => {
    if (opts.auto) return { parked: false, wake_at: null, refusal: msg };
    throw new ParkError(msg, status);
  };
  const res = await withTx(async (client) => {
    const t = await hqOne<ParkRow>(`SELECT ${ROW} FROM hd_tickets WHERE id = $1 FOR UPDATE`, [ticketId], client);
    if (!t || t.deleted_at) return refuse("That ticket no longer exists.", 404);
    if (t.merged_into) return refuse("This ticket was merged into another, so it can't be parked.");
    if (!PARKABLE.includes(t.status)) return refuse("A solved or closed ticket can't be parked. Reopen it first.");
    if (t.parked_until) return refuse("This ticket is already parked. Change its prep window, or wake it.");
    const e = await eventRow(ticketId, client);
    if (!e) return refuse("This ticket has no event to hold it for. Add the event first.");
    if (e.cancelled_at) return refuse("The event was canceled, so there is nothing to hold this ticket for.");
    const event = toEvent(e);
    const prepOwn = prepIn !== undefined ? prepIn : t.park_prep_days;
    const prep = prepOwn ?? settings.park_prep_days;
    const hours = await calendarOf(t.team_id, client);
    const tz = hours.timezone;
    const wake = wakeInstant(event, prep, hours);
    const close = tooCloseToPark(wake, now.getTime(), tz);
    if (close) return refuse(close);
    await client.query(
      `UPDATE hd_tickets SET status = 'on_hold', parked_until = $2, parked_at = $3, park_reason = $4, park_prep_days = $5,
              sla_paused_at = COALESCE(sla_paused_at, $3), updated_at = $3
        WHERE id = $1`,
      [ticketId, new Date(wake), now, reason, prepOwn]
    );
    // Reports' backlog reads this history, so a ticket that wakes later doesn't change the past.
    await client.query(PARK_HISTORY_CLOSE_SQL, [ticketId, now]);
    await client.query("INSERT INTO hd_ticket_parkings (ticket_id, parked_at, reason) VALUES ($1, $2, $3)", [ticketId, now, reason]);
    const when = wakeWords(wake, tz, now.getTime());
    const forEvent = mdInline(eventDay(event, tz, now.getTime()));
    const why = `it wakes ${prepLabel(prep)} before the event's setup is due`;
    const body =
      reason === "agent"
        ? `${mdInline(actor.name) || "Someone"} parked the ticket until ${when} for the event on ${forEvent}: ${why}`
        : `Parked until ${when} for the event on ${forEvent}, after the acknowledgment (${reason === "invite" ? "a ticket from a meeting invite" : "a request type that goes on the calendar"}): ${why}`;
    await line(client, ticketId, actor, body, now);
    return { parked: true, wake_at: new Date(wake).toISOString(), ticket: t, prep, tz, event };
  });
  if (!("ticket" in res)) return { parked: false, wake_at: null, refusal: (res as ParkResult).refusal };
  const r = res as ParkResult & { ticket: ParkRow; prep: number; event: HdTicketEvent };
  await audit({
    actor: { id: actor.id, name: actor.name, role: actor.role ?? null },
    action: "helpdesk.ticket.parked",
    targetType: "helpdesk_ticket",
    targetId: ticketId,
    targetLabel: `#${r.ticket.number} ${r.ticket.subject}`.slice(0, 300),
    details: { number: r.ticket.number, parked_until: r.wake_at, reason, prep_days: r.prep, from_status: r.ticket.status, ...(actor.via ? { via: actor.via } : {}) },
  });
  await afterChange(ticketId, ["status", "parking"], actor, opts.origin);
  return { parked: true, wake_at: r.wake_at };
}

// --- Wake --------------------------------------------------------------------------------

/** Why a ticket woke. */
export type WakeWhy = "due" | "manual" | "requester" | "message" | "cancelled" | "removed" | "moved";

export interface WakeOptions {
  why: WakeWhy;
  /** The line's words, when the reason has its own (the cancel note, the moved event). */
  note?: string;
  /** The sweep: only when its wake time has come, and never waiting for another instance's lock. */
  dueOnly?: boolean;
  origin?: string;
  now?: Date;
}

export interface WakeResult {
  number: number;
  status: HdStatus;
}

/**
 * Wake a parked ticket: back to open with its clocks resumed (the business
 * time they had left), parking cleared, an agents-only line. Then the audit
 * row, the ticket.updated webhook and, except when the requester wrote (their
 * message is its own notice), a notice to the owner, else the team.
 * Null when it was not parked (or, with dueOnly, not due or being woken by
 * another instance).
 */
export async function wakeTicket(ticketId: number, actor: ParkActor, opts: WakeOptions): Promise<WakeResult | null> {
  const now = opts.now ?? new Date();
  const res = await withTx(async (client) => {
    const t = await hqOne<ParkRow>(
      `SELECT ${ROW} FROM hd_tickets WHERE id = $1 AND parked_until IS NOT NULL${opts.dueOnly ? " AND parked_until <= $2 AND deleted_at IS NULL AND (park_wake_retry_at IS NULL OR park_wake_retry_at <= $2)" : ""}
        FOR UPDATE${opts.dueOnly ? " SKIP LOCKED" : ""}`,
      opts.dueOnly ? [ticketId, now] : [ticketId],
      client
    );
    if (!t) return null;
    const e = await eventRow(ticketId, client);
    const hours = await calendarOf(t.team_id, client);
    const tz = hours.timezone;
    const forEvent = e ? mdInline(eventDay(toEvent(e), tz, now.getTime())) : "";
    // Back to open from on hold, the clocks resumed as updateTicket resumes them; a ticket whose status already moved
    // on (a path that set it without clearing parking) only loses its parking.
    const resume = t.status === "on_hold" && !t.merged_into && !t.deleted_at;
    const sets: string[] = ["parked_until = NULL", "parked_at = NULL", "park_reason = ''", "park_wake_failures = 0", "park_wake_error = ''", "park_wake_retry_at = NULL", "updated_at = $2"];
    const params: unknown[] = [ticketId, now];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (resume) {
      set("status", "open");
      if (t.sla_paused_at) {
        const pausedAt = Date.parse(t.sla_paused_at);
        await bankPausedBusiness(client, ticketId, now);
        set("sla_paused_at", null);
        set("sla_paused_ms", Number(t.sla_paused_ms ?? 0) + Math.max(0, now.getTime() - pausedAt));
        const policy = await slaPolicyForTeam(t.priority, t.team_id, client);
        if (policy) {
          const d = resumedDues({ first_reply_due: t.first_reply_due, resolve_due: t.resolve_due, first_replied_at: t.first_replied_at }, pausedAt, now.getTime(), policy, hours);
          set("first_reply_due", d.first_reply_due);
          set("resolve_due", d.resolve_due);
          set("sla_warned_at", null);
        }
      }
    }
    await client.query(`UPDATE hd_tickets SET ${sets.join(", ")} WHERE id = $1`, params);
    await client.query(PARK_HISTORY_CLOSE_SQL, [ticketId, now]);
    const who = mdInline(actor.name) || "Someone";
    let body: string;
    switch (opts.why) {
      case "due":
        body = forEvent ? `Woke for the event on ${forEvent}` : "Woke: its wake time came";
        break;
      case "manual":
        body = `${who} woke the ticket${forEvent ? ` (it was parked for the event on ${forEvent})` : ""}`;
        break;
      case "requester":
        body = `Woke for a new message from the requester${forEvent ? ` (it was parked for the event on ${forEvent})` : ""}`;
        break;
      case "message":
        body = `Woke for a message that came with the meeting update${forEvent ? ` (it was parked for the event on ${forEvent})` : ""}`;
        break;
      case "cancelled":
        body = "The event was canceled. Close this ticket if nothing else is needed.";
        break;
      case "removed":
        body = "Woke: the event was removed from this ticket.";
        break;
      case "moved":
        body = opts.note ?? `Woke: the event moved${forEvent ? ` to ${forEvent}` : ""}, inside its prep window.`;
        break;
    }
    if (opts.note && opts.why !== "moved") body = opts.note;
    await line(client, ticketId, opts.why === "manual" ? actor : { ...SYSTEM, via: actor.via }, body, now);
    return { t, resumed: resume, event: e ? toEvent(e) : null, tz };
  });
  if (!res) return null;
  const { t } = res;
  await audit({
    actor: { id: actor.id, name: actor.name, role: actor.role ?? null },
    action: "helpdesk.ticket.woke",
    targetType: "helpdesk_ticket",
    targetId: ticketId,
    targetLabel: `#${t.number} ${t.subject}`.slice(0, 300),
    details: { number: t.number, why: opts.why, parked_until: t.parked_until ? new Date(t.parked_until).toISOString() : null, ...(actor.via ? { via: actor.via } : {}) },
  });
  await afterChange(ticketId, res.resumed ? ["status", "parking"] : ["parking"], actor, opts.origin);
  if (res.resumed && opts.why !== "requester") await notifyWoke(t, res.event, res.tz, opts.why, actor, opts.origin);
  // Nobody owns it: it joins its team's auto-assignment again (parked, it was left out of the queue and of everyone's load).
  if (res.resumed && !t.assignee_id) {
    try {
      await (await import("./assignment/engine")).assignTicket(ticketId, { trigger: "reopened", now });
    } catch (e) {
      logEvent("error", "helpdesk.park_assign_failed", { ticket_id: ticketId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { number: t.number, status: res.resumed ? "open" : t.status };
}

/**
 * Before an API or connector call changes anything: would parking this ticket
 * (with these event fields laid over its event, and this prep window) be
 * refused? The sentence, or null. Lets a refused park leave the event as it
 * was (lib/helpdesk/desk-calendar applyEventPatch).
 */
export async function parkRefusal(ticketId: number, opts: { times?: import("./desk-calendar-shared").HdEventTimes | null; prepDays?: number | null; now?: Date } = {}): Promise<string | null> {
  const t = await hqOne<ParkRow>(`SELECT ${ROW} FROM hd_tickets WHERE id = $1`, [ticketId]);
  if (!t || t.deleted_at) return "That ticket no longer exists.";
  if (t.merged_into) return "This ticket was merged into another, so it can't be parked.";
  if (!PARKABLE.includes(t.status)) return "A solved or closed ticket can't be parked. Reopen it first.";
  if (t.parked_until) return "This ticket is already parked. Change its prep window, or wake it.";
  const e = await eventRow(ticketId);
  const times = opts.times ?? (e ? { starts_at: new Date(e.starts_at), all_day: e.all_day === 1, start_date: e.start_date, setup_minutes: e.setup_minutes } : null);
  if (!times) return "This ticket has no event to hold it for. Add the event first.";
  if (!opts.times && e?.cancelled_at) return "The event was canceled, so there is nothing to hold this ticket for.";
  const settings = await getCalendarSettings();
  const prep = (opts.prepDays !== undefined ? opts.prepDays : t.park_prep_days) ?? settings.park_prep_days;
  const hours = await calendarOf(t.team_id);
  const wake = wakeInstant({ starts_at: times.starts_at.toISOString(), all_day: times.all_day, start_date: times.start_date, setup_minutes: times.setup_minutes }, prep, hours);
  return tooCloseToPark(wake, (opts.now ?? new Date()).getTime(), hours.timezone);
}

/**
 * The sweep could not wake this ticket: count it and try again after a
 * growing delay (2, 4, 8, 16 minutes …, at most an hour), so it never holds
 * the head of the due list. At PARK_WAKE_MAX_FAILURES it is woken by a plain
 * status change instead (back to open, parking cleared, the paused time
 * banked in wall-clock time only, its dues left as they were) with an
 * agents-only note saying so and what failed, so a ticket never stays
 * parked past its time.
 */
async function wakeFailed(ticketId: number, error: string, now: Date): Promise<void> {
  try {
    const r = await hqOne<{ park_wake_failures: number }>(
      `UPDATE hd_tickets SET park_wake_failures = park_wake_failures + 1, park_wake_error = $2,
              park_wake_retry_at = $3::timestamptz + make_interval(mins => LEAST(60, power(2, park_wake_failures + 1)::int))
        WHERE id = $1 AND parked_until IS NOT NULL RETURNING park_wake_failures`,
      [ticketId, error.slice(0, 500), now]
    );
    if (!r || r.park_wake_failures < PARK_WAKE_MAX_FAILURES) return;
    await withTx(async (client) => {
      const t = await hqOne<ParkRow>(`SELECT ${ROW} FROM hd_tickets WHERE id = $1 AND parked_until IS NOT NULL FOR UPDATE`, [ticketId], client);
      if (!t) return;
      const paused = t.sla_paused_at ? Math.max(0, now.getTime() - Date.parse(t.sla_paused_at)) : 0;
      await client.query(
        `UPDATE hd_tickets SET status = CASE WHEN status = 'on_hold' THEN 'open' ELSE status END, parked_until = NULL, parked_at = NULL, park_reason = '',
                sla_paused_at = CASE WHEN status = 'on_hold' THEN NULL ELSE sla_paused_at END,
                sla_paused_ms = sla_paused_ms + CASE WHEN status = 'on_hold' THEN $3::bigint ELSE 0 END,
                park_wake_failures = 0, park_wake_retry_at = NULL, updated_at = $2
          WHERE id = $1`,
        [ticketId, now, paused]
      );
      await client.query(PARK_HISTORY_CLOSE_SQL, [ticketId, now]);
      await line(client, ticketId, SYSTEM, `Woke without its usual steps after ${PARK_WAKE_MAX_FAILURES} failed attempts (${mdInline(error.slice(0, 200))}). Check its targets and its owner.`, now);
    });
    logEvent("error", "helpdesk.park_wake_forced", { ticket_id: ticketId, error: error.slice(0, 200) });
  } catch (e) {
    logEvent("error", "helpdesk.park_wake_failed", { ticket_id: ticketId, step: "failure_record", error: e instanceof Error ? e.message : String(e) });
  }
}

/** The ticket.updated webhook after a park, wake or move. Never throws. */
async function afterChange(ticketId: number, changed: string[], actor: ParkActor, origin?: string): Promise<void> {
  try {
    await (await import("./webhooks")).emitHelpdeskWebhookEvent("ticket.updated", { ticketId, changed, actor: { id: actor.id, name: actor.name }, origin });
  } catch (e) {
    logEvent("error", "helpdesk.hook_failed", { step: "park.webhooks", error: e instanceof Error ? e.message : String(e) });
  }
}

/** The owner (else the team's agents) hears that the ticket is back: Event reminders in their notification settings decide how. Never throws. */
async function notifyWoke(t: ParkRow, event: HdTicketEvent | null, tz: string, why: WakeWhy, actor: ParkActor, origin?: string): Promise<void> {
  try {
    const { reminderRecipients } = await import("./desk-calendar-reminders");
    const ids = await reminderRecipients(t, "lead:0", { recipients: "owner_else_team" });
    if (!ids.length) return;
    const { deliverToAgent } = await import("./notify");
    const { hdLinks, helpdeskOrigin } = await import("./email");
    const base = await helpdeskOrigin(origin).catch(() => "");
    const url = hdLinks.ticket(t.number);
    const headline =
      why === "cancelled" ? "Back in the queue: the event was canceled" : why === "removed" ? "Back in the queue: the event was removed" : "Back in the queue for its event";
    const when = event ? (event.all_day ? eventWhen(event, tz) : `${eventWhen(event, tz)} (${zoneLabel(tz)})`) : "No event";
    const readyBy = event ? `${readyByLabel(event, tz)}${event.setup_minutes > 0 ? ` (${leadLabel(event.setup_minutes)} before)` : ""}` : "";
    for (const id of ids) {
      await deliverToAgent(
        id,
        "event_reminder",
        {
          ticketNumber: t.number,
          title: `#${t.number}: ${headline}`,
          body: `${t.subject}${event ? ` · ${when}${event.place ? ` · ${event.place}` : ""}` : ""}`,
          urgent: false,
          url,
          teamId: t.team_id,
          email: {
            template: "hd_event_reminder",
            vars: { ticket_number: String(t.number), subject: t.subject, headline, event_when: when, event_place: event?.place || "No place given", ready_by: readyBy, ticket_url: url },
          },
        },
        { origin: base, actorId: why === "manual" ? actor.id : null }
      );
    }
  } catch (e) {
    logEvent("error", "helpdesk.park_notify_failed", { ticket: t.number, error: e instanceof Error ? e.message : String(e) });
  }
}

// --- The prep window ---------------------------------------------------------------------

/**
 * Set the ticket's own prep window (null: the desk's). On a parked ticket the
 * wake time moves with it; a window that would wake it now is refused (wake
 * it instead). Answers the parking as it now stands.
 */
export async function setPrepDays(ticketId: number, raw: unknown, actor: ParkActor, opts: { origin?: string; now?: Date } = {}): Promise<HdParking> {
  const c = checkPrepDays(raw);
  if (!c.ok) throw new ParkError(c.error, 400);
  const now = opts.now ?? new Date();
  const settings = await getCalendarSettings();
  const res = await withTx(async (client) => {
    const t = await hqOne<ParkRow>(`SELECT ${ROW} FROM hd_tickets WHERE id = $1 FOR UPDATE`, [ticketId], client);
    if (!t || t.deleted_at) throw new ParkError("That ticket no longer exists.", 404);
    if (t.merged_into || !PARKABLE.includes(t.status)) throw new ParkError("This ticket isn't open, so its prep window can't change.");
    const prep = c.value ?? settings.park_prep_days;
    if (c.value === t.park_prep_days) return { t, moved: false, changed: false, wake: t.parked_until ? Date.parse(t.parked_until) : null, prep };
    let wake: number | null = null;
    const who = mdInline(actor.name) || "Someone";
    const label = c.value === null ? `the desk's (${prepLabel(prep)})` : prepLabel(prep);
    if (t.parked_until) {
      const e = await eventRow(ticketId, client);
      if (!e || e.cancelled_at) throw new ParkError("The event was canceled or removed. Wake the ticket instead.");
      const hours = await calendarOf(t.team_id, client);
      wake = wakeInstant(toEvent(e), prep, hours);
      if (wake <= now.getTime() + PARK_LIMITS.minLeadMs) {
        throw new ParkError(`With ${prepLabel(prep)} to prepare, this ticket would wake ${dayOf(wake, hours.timezone) === dayOf(now.getTime(), hours.timezone) ? "today" : "in the past"}. Wake it now instead, or choose fewer days.`);
      }
      await client.query("UPDATE hd_tickets SET park_prep_days = $2, parked_until = $3, updated_at = $4 WHERE id = $1", [ticketId, c.value, new Date(wake), now]);
      await line(client, ticketId, actor, `${who} changed the prep window to ${label}: the ticket now wakes ${wakeWords(wake, hours.timezone, now.getTime())}`, now);
    } else {
      await client.query("UPDATE hd_tickets SET park_prep_days = $2, updated_at = $3 WHERE id = $1", [ticketId, c.value, now]);
      await line(client, ticketId, actor, `${who} changed the prep window to ${label}`, now);
    }
    return { t, moved: wake !== null, changed: true, wake, prep };
  });
  if (res.changed) {
    await audit({
      actor: { id: actor.id, name: actor.name, role: actor.role ?? null },
      action: "helpdesk.ticket.park_changed",
      targetType: "helpdesk_ticket",
      targetId: ticketId,
      targetLabel: `#${res.t.number} ${res.t.subject}`.slice(0, 300),
      details: { number: res.t.number, prep_days: c.value, parked_until: res.wake !== null ? new Date(res.wake).toISOString() : null, ...(actor.via ? { via: actor.via } : {}) },
    });
    if (res.moved) await afterChange(ticketId, ["parking"], actor, opts.origin);
  }
  return (await parkingOf(ticketId)) ?? parkingFields({ ...res.t, park_prep_days: c.value }, settings.park_prep_days);
}

// --- The event changed -------------------------------------------------------------------

/**
 * lib/helpdesk/desk-calendar, after its commit: the parked ticket's event
 * moved (start, all-day flag or setup lead time), was cancelled or removed.
 * Moved: the wake time is worked out again (a line when it moved; woken now
 * when the new one has passed). Cancelled or removed: woken now. Nothing for
 * a ticket that isn't parked. Never throws.
 */
export async function followEventChange(ticketId: number, change: "moved" | "cancelled" | "removed", opts: { origin?: string; now?: Date } = {}): Promise<void> {
  const now = opts.now ?? new Date();
  let parked = false;
  try {
    parked = !!(await hqOne(`SELECT 1 AS x FROM hd_tickets WHERE id = $1 AND parked_until IS NOT NULL`, [ticketId]));
  } catch (e) {
    logEvent("error", "helpdesk.park_follow_failed", { ticket_id: ticketId, change, step: "read", error: e instanceof Error ? e.message : String(e) });
    if (change !== "moved") await dueNow(ticketId);
    return;
  }
  if (!parked) return;
  if (change === "cancelled" || change === "removed") {
    try {
      await (wakeForTests ?? wakeTicket)(ticketId, SYSTEM, { why: change, origin: opts.origin, now });
    } catch (e) {
      // The event is gone: the ticket must not stay parked. The minute sweep wakes it (with its usual steps).
      logEvent("error", "helpdesk.park_follow_failed", { ticket_id: ticketId, change, error: e instanceof Error ? e.message : String(e) });
      await dueNow(ticketId);
    }
    return;
  }
  try {
    const r = await recomputeWake(ticketId, `The event moved`, { origin: opts.origin, now });
    if (r === "past") await wakeTicket(ticketId, SYSTEM, { why: "moved", note: r === "past" ? await movedNote(ticketId, now) : undefined, origin: opts.origin, now });
  } catch (e) {
    logEvent("error", "helpdesk.park_follow_failed", { ticket_id: ticketId, change, error: e instanceof Error ? e.message : String(e) });
  }
}

async function movedNote(ticketId: number, now: Date): Promise<string | undefined> {
  const t = await hqOne<{ team_id: number | null }>("SELECT team_id FROM hd_tickets WHERE id = $1", [ticketId]);
  const e = await eventRow(ticketId);
  if (!t || !e) return undefined;
  const hours = await calendarOf(t.team_id);
  return `Woke: the event moved to ${mdInline(eventDay(toEvent(e), hours.timezone, now.getTime()))}, so it is inside its prep window now.`;
}

/** A parked ticket that must wake but couldn't now: due at once, so the minute sweep wakes it. Logs, never throws. */
async function dueNow(ticketId: number): Promise<void> {
  try {
    await hq("UPDATE hd_tickets SET parked_until = now(), park_wake_retry_at = NULL, updated_at = now() WHERE id = $1 AND parked_until IS NOT NULL", [ticketId]);
  } catch (e) {
    logEvent("error", "helpdesk.park_follow_failed", { ticket_id: ticketId, step: "due_now", error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Work a parked ticket's wake time out again (its event, its team's calendar,
 * its prep window or the desk's). "moved": it changed (a line says why, with
 * `because`); "same"; "past": the new time has passed (the caller wakes it, or
 * leaves it due for the sweep); null: not parked, or no live event.
 */
async function recomputeWake(ticketId: number, because: string, opts: { origin?: string; now: Date; pastIsDue?: boolean }): Promise<"moved" | "same" | "past" | null> {
  const settings = await getCalendarSettings();
  const out = await withTx(async (client) => {
    const cur = await hqOne<ParkRow>(`SELECT ${ROW} FROM hd_tickets WHERE id = $1 AND parked_until IS NOT NULL FOR UPDATE`, [ticketId], client);
    if (!cur) return null;
    const e = await eventRow(ticketId, client);
    if (!e || e.cancelled_at) return "past" as const;
    const event = toEvent(e);
    const hours = await calendarOf(cur.team_id, client);
    const tz = hours.timezone;
    const wake = wakeInstant(event, cur.park_prep_days ?? settings.park_prep_days, hours);
    if (wake <= opts.now.getTime()) {
      // Already past: due now, so the next sweep wakes it.
      if (opts.pastIsDue) await client.query("UPDATE hd_tickets SET parked_until = $2, updated_at = $2 WHERE id = $1", [ticketId, opts.now]);
      return "past" as const;
    }
    if (Date.parse(cur.parked_until!) === wake) return "same" as const;
    await client.query("UPDATE hd_tickets SET parked_until = $2, updated_at = $3 WHERE id = $1", [ticketId, new Date(wake), opts.now]);
    const forEvent = mdInline(eventDay(event, tz, opts.now.getTime()));
    await line(client, ticketId, SYSTEM, because === "The event moved" ? `The event moved to ${forEvent}, so the ticket now wakes ${wakeWords(wake, tz, opts.now.getTime())}` : `${because}, so the ticket now wakes ${wakeWords(wake, tz, opts.now.getTime())}`, opts.now);
    return "moved" as const;
  });
  if (out === "moved") await afterChange(ticketId, ["parking"], SYSTEM, opts.origin);
  return out;
}

/** What made the parked tickets' wake times change. */
export type RecomputeScope =
  | { kind: "team"; ticketId: number }
  | { kind: "desk_prep" }
  | { kind: "calendar"; teamIds: number[]; noTeam: boolean };

/** At most this many parked tickets are worked out again in one save (the rest keep their time; logged). */
export const RECOMPUTE_LIMIT = 2000;

/**
 * After a save that changes when parked tickets wake: the ticket moved to
 * another team (lib/helpdesk/tickets updateTicket), the desk's prep window
 * changed (tickets without their own), or a business calendar's hours or
 * holidays changed (lib/helpdesk/calendars). One bounded pass; a time that
 * has passed is due now, so the next sweep wakes it. Never throws.
 */
export async function recomputeParked(scope: RecomputeScope, opts: { now?: Date; origin?: string; /** Tests: only these tickets. */ only?: number[] } = {}): Promise<{ checked: number; moved: number; due: number }> {
  const now = opts.now ?? new Date();
  const out = { checked: 0, moved: 0, due: 0 };
  try {
    const ids =
      scope.kind === "team"
        ? [scope.ticketId]
        : (
            await hq<{ id: number }>(
              `SELECT id FROM hd_tickets WHERE parked_until IS NOT NULL AND deleted_at IS NULL
                 ${scope.kind === "desk_prep" ? "AND park_prep_days IS NULL" : "AND (team_id = ANY($1::int[]) OR ($2::boolean AND team_id IS NULL))"}
               ORDER BY parked_until, id LIMIT ${RECOMPUTE_LIMIT + 1}`,
              scope.kind === "desk_prep" ? [] : [scope.teamIds, scope.noTeam]
            )
          ).map((r) => r.id);
    if (opts.only) {
      const keep = new Set(opts.only);
      for (let i = ids.length - 1; i >= 0; i--) if (!keep.has(ids[i])) ids.splice(i, 1);
    }
    if (ids.length > RECOMPUTE_LIMIT) {
      logEvent("warn", "helpdesk.park_recompute_capped", { scope: scope.kind, limit: RECOMPUTE_LIMIT });
      ids.length = RECOMPUTE_LIMIT;
    }
    const because = scope.kind === "team" ? "The ticket moved to another team" : scope.kind === "desk_prep" ? "The desk's prep window changed" : "Its team's business calendar changed";
    for (const id of ids) {
      out.checked++;
      try {
        const r = await recomputeWake(id, because, { now, origin: opts.origin, pastIsDue: true });
        if (r === "moved") out.moved++;
        if (r === "past") out.due++;
      } catch (e) {
        logEvent("error", "helpdesk.park_recompute_failed", { ticket_id: id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } catch (e) {
    logEvent("error", "helpdesk.park_recompute_failed", { scope: scope.kind, error: e instanceof Error ? e.message : String(e) });
  }
  return out;
}

// --- Parking itself after the acknowledgement ----------------------------------------------

/**
 * A ticket a meeting invite opened (lib/helpdesk/inbound, after the event was
 * filled in) or a request type that goes on the calendar raised
 * (lib/helpdesk/events afterTicketCreated, after the rules, the workflow
 * start and the acknowledgement): it parks itself when Desk settings → Event
 * calendar says so and its wake time is still ahead. Too close: it stays
 * open. Never throws.
 */
export async function autoPark(
  ticketId: number,
  kind: "invite" | "request_type",
  ctx: { origin?: string; now?: Date; /** An invite: its sender passed the sender check, or is a known workspace account. */ senderTrusted?: boolean } = {}
): Promise<ParkResult> {
  try {
    const settings = await getCalendarSettings();
    if (kind === "invite" ? !settings.park_invites : !settings.park_request_types) return { parked: false, wake_at: null };
    // An invite anyone could have sent (no sender check passed, no account) never takes a ticket out of the queue by itself.
    if (kind === "invite" && ctx.senderTrusted !== true) return { parked: false, wake_at: null, refusal: "untrusted" };
    const t = await hqOne<{ status: HdStatus; parked_until: string | null; merged_into: number | null; deleted_at: string | null }>(
      "SELECT status, parked_until, merged_into, deleted_at FROM hd_tickets WHERE id = $1",
      [ticketId]
    );
    // A rule may already have put it on hold or solved it: that stands.
    if (!t || t.parked_until || t.merged_into || t.deleted_at || !["new", "open"].includes(t.status)) return { parked: false, wake_at: null };
    const e = await eventRow(ticketId);
    if (!e || e.cancelled_at || e.source !== (kind === "invite" ? "invite" : "request")) return { parked: false, wake_at: null };
    const now = ctx.now ?? new Date();
    if (Date.parse(e.starts_at) > now.getTime() + AUTO_PARK_MAX_DAYS * 86_400_000) {
      await withTx((client) => line(client, ticketId, SYSTEM, `Not parked: the event is more than ${AUTO_PARK_MAX_DAYS} days away, so the ticket stays in the queue. Park it by hand if that date is right.`, now));
      return { parked: false, wake_at: null, refusal: "too_far" };
    }
    return await parkTicket(ticketId, SYSTEM, { reason: kind, auto: true, origin: ctx.origin, now });
  } catch (e) {
    logEvent("error", "helpdesk.auto_park_failed", { ticket_id: ticketId, kind, error: e instanceof Error ? e.message : String(e) });
    return { parked: false, wake_at: null };
  }
}

// --- The minute sweep ----------------------------------------------------------------------

const BATCH = 200;

/**
 * lib/periodic HELPDESK_SWEEPS (hd_event_park), every minute on every
 * instance: wake every parked ticket whose time has come. Each is taken under
 * its row lock with SKIP LOCKED and the due check repeated under it, so two
 * instances never wake one ticket twice. Parking that a direct status write
 * left behind (merged, solved by a workflow) is cleared. Then the requester
 * reminders. `only` limits it to these tickets (tests).
 */
export async function parkSweep(now: Date = new Date(), opts: { only?: number[] } = {}): Promise<{ woke: number[]; reminded: number[]; failed: number[] }> {
  const only = opts.only ?? null;
  const stale = await hq<{ id: number }>(
    `UPDATE hd_tickets SET parked_until = NULL, parked_at = NULL, park_reason = '', park_wake_failures = 0, park_wake_error = '', park_wake_retry_at = NULL
      WHERE parked_until IS NOT NULL AND (status <> 'on_hold' OR merged_into IS NOT NULL) AND ($1::int[] IS NULL OR id = ANY($1::int[]))
      RETURNING id`,
    [only]
  );
  for (const r of stale) await hq(PARK_HISTORY_CLOSE_SQL, [r.id, now]);
  // A ticket whose wake keeps failing waits out its delay (park_wake_retry_at), so it never holds the head of the list.
  const due = await hq<{ id: number }>(
    `SELECT id FROM hd_tickets WHERE parked_until IS NOT NULL AND parked_until <= $1 AND deleted_at IS NULL
        AND (park_wake_retry_at IS NULL OR park_wake_retry_at <= $1) AND ($2::int[] IS NULL OR id = ANY($2::int[]))
      ORDER BY parked_until, id LIMIT ${BATCH}`,
    [now, only]
  );
  const woke: number[] = [];
  const failed: number[] = [];
  for (const d of due) {
    try {
      const r = await (wakeForTests ?? wakeTicket)(d.id, SYSTEM, { why: "due", dueOnly: true, now });
      if (r) woke.push(d.id);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logEvent("error", "helpdesk.park_wake_failed", { ticket_id: d.id, error });
      failed.push(d.id);
      await wakeFailed(d.id, error, now);
    }
  }
  const reminded = await requesterReminderSweep(now, { only });
  return { woke, reminded, failed };
}

let wakeForTests: typeof wakeTicket | null = null;
/** Tests: the sweep (and a cancelled or removed event's wake) goes through this instead, to make a wake fail. Null restores. */
export function setSweepWakeForTests(fn: typeof wakeTicket | null): void {
  wakeForTests = fn;
}

// --- The requester's reminder ---------------------------------------------------------------

/**
 * Desk settings → Event calendar → "Remind the requester before the event"
 * (off by default): one short email (hd_event_requester_reminder, through the
 * requester's notification settings, Get help's or the portal's link) the set
 * number of days before an event that is still on. Claimed in
 * hd_event_reminders as 'requester:<start>', so it goes once per event date,
 * and again if the event moves. Not for a solved, closed, merged or binned
 * ticket, a cancelled event, an automated ticket or one with no requester.
 */
export async function requesterReminderSweep(now: Date = new Date(), opts: { only?: number[] | null } = {}): Promise<number[]> {
  const settings = await getCalendarSettings();
  if (!settings.remind_requester) return [];
  const rows = await hq<{ ticket_id: number; starts_at: string; all_day: number; start_date: string | null; place: string; ends_at: string; team_id: number | null }>(
    `SELECT e.ticket_id, e.starts_at, e.ends_at, e.all_day, to_char(e.start_date, 'YYYY-MM-DD') AS start_date, e.place, t.team_id
       FROM hd_ticket_events e JOIN hd_tickets t ON t.id = e.ticket_id
      WHERE e.cancelled_at IS NULL AND t.deleted_at IS NULL AND t.merged_into IS NULL AND t.status IN ('new', 'open', 'pending', 'on_hold')
        AND COALESCE(t.automated, 0) = 0 AND (t.requester_id IS NOT NULL OR t.requester_email <> '')
        AND e.starts_at > $1 AND e.starts_at <= $1::timestamptz + make_interval(days => $2)
        AND ($3::int[] IS NULL OR e.ticket_id = ANY($3::int[]))
        AND NOT EXISTS (SELECT 1 FROM hd_event_reminders r WHERE r.ticket_id = e.ticket_id AND r.kind = 'requester:' || to_char(e.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI'))
      ORDER BY e.starts_at LIMIT ${BATCH}`,
    [now, settings.remind_requester_days, opts.only ?? null]
  );
  const sent: number[] = [];
  for (const r of rows) {
    try {
      const kind = `requester:${new Date(r.starts_at).toISOString().slice(0, 16)}`;
      const won = await hq("INSERT INTO hd_event_reminders (ticket_id, kind, time_rev, sent_at) VALUES ($1, $2, 0, $3) ON CONFLICT DO NOTHING RETURNING ticket_id", [r.ticket_id, kind, now]);
      if (!won.length) continue;
      const hours = await calendarOf(r.team_id);
      const tz = hours.timezone;
      const e = { starts_at: new Date(r.starts_at).toISOString(), ends_at: new Date(r.ends_at).toISOString(), all_day: r.all_day === 1, start_date: r.all_day === 1 ? r.start_date : null, end_date: null };
      const day = eventDay({ starts_at: e.starts_at, all_day: e.all_day, start_date: e.start_date }, tz, now.getTime());
      const time = e.all_day ? "All day" : `${timeLabel(e.starts_at, tz)} (${zoneLabel(tz)})`;
      const { notifyEventRequesterReminder } = await import("./notify");
      await notifyEventRequesterReminder(r.ticket_id, { event_date: day, event_time: time, event_place: r.place });
      await hq("UPDATE hd_event_reminders SET recipients = 1 WHERE ticket_id = $1 AND kind = $2 AND time_rev = 0", [r.ticket_id, kind]);
      sent.push(r.ticket_id);
    } catch (e) {
      logEvent("error", "helpdesk.requester_reminder_failed", { ticket_id: r.ticket_id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return sent;
}
