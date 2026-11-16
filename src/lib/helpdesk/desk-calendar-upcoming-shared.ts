// Helpdesk 1.20.24: upcoming events in the desk's top bar and today's count
// on the Calendar rail icon (STYLEGUIDE §Helpdesk: the event calendar →
// "Upcoming events"). The rules the server, the desk and the tests share.
// Pure: safe in client components.
//
// GET /api/helpdesk/calendar/upcoming (lib/helpdesk/desk-calendar
// upcomingEvents) answers the events the agent may see on the calendar
// (their teams' and their own tickets', as the Calendar page) that are not
// cancelled and still to come in the next UPCOMING_HORIZON_DAYS calendar
// days, counted in the agent's own zone from today. Everything else is
// worked out here, against the browser's clock, so the pill and the badge
// move on as events end without asking the server again:
//
//   pill     the next TIMED event that has not ended (one in progress
//            counts, and comes first: it started earliest). Whole-day
//            events are never the pill. No timed event in the horizon: no
//            pill.
//   badge    today's TIMED events (they touch today in the agent's zone)
//            that have not ended. In progress counts; ended, whole-day and
//            cancelled events do not. 0: no badge.
//   list     the dropdown: by day (Today, Tomorrow, then dates), each day an
//            "All day" part first (a multi-day event on each of its days,
//            "Day 2 of 5"), then the timed events by start. A timed event is
//            listed on the day it starts, or on Today while it is running.
//   change   the next instant any of that changes (an end, a start, the
//            agent's midnight): the desk sets one timer for it.

import { addDays, dayLabel, dayOf, dayStart, daysBetween, eventWhen, timeLabel, weekdayShort } from "./desk-calendar-shared";

/** How far ahead the pill and the dropdown look, in calendar days counted from today (today included). */
export const UPCOMING_HORIZON_DAYS = 14;
/** At most this many events in one answer (the earliest first). */
export const UPCOMING_LIMIT = 200;

/** One event the top bar knows about. */
export interface HdUpcomingEvent {
  number: number;
  subject: string;
  place: string;
  /** ISO instants (UTC). An all-day event's are its days' midnights in the zone it was entered in. */
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  /** All-day only: "YYYY-MM-DD", inclusive. */
  start_date: string | null;
  end_date: string | null;
}

/** GET /api/helpdesk/calendar/upcoming. */
export interface HdUpcomingEvents {
  /** The zone days are counted in: the agent's own, else the workspace's (as the Calendar page). */
  timezone: string;
  /** Today in that zone when the server answered, "YYYY-MM-DD". */
  today: string;
  horizon_days: number;
  /** Ordered by start. */
  events: HdUpcomingEvent[];
  /** More than UPCOMING_LIMIT were found: the latest ones were left out. */
  truncated: boolean;
}

const ms = (iso: string) => new Date(iso).getTime();

/** The timed events that have not ended at `now`, earliest start first. */
function timedLeft(events: HdUpcomingEvent[], now: number): HdUpcomingEvent[] {
  return events.filter((e) => !e.all_day && ms(e.ends_at) > now).sort((a, b) => ms(a.starts_at) - ms(b.starts_at) || a.number - b.number);
}

/** The pill's event: the next timed event that has not ended (in progress counts); null when there is none. */
export function nextTimedEvent(events: HdUpcomingEvent[], now: number): HdUpcomingEvent | null {
  return timedLeft(events, now)[0] ?? null;
}

/** Is the event running at `now`? */
export function inProgress(e: Pick<HdUpcomingEvent, "starts_at" | "ends_at">, now: number): boolean {
  return ms(e.starts_at) <= now && ms(e.ends_at) > now;
}

/** The badge: today's timed events (touching today in `tz`) that have not ended at `now`. */
export function todayLeft(events: HdUpcomingEvent[], now: number, tz: string): number {
  const tomorrow = dayStart(addDays(dayOf(now, tz), 1), tz);
  return timedLeft(events, now).filter((e) => ms(e.starts_at) < tomorrow).length;
}

/**
 * The start of the last event a truncated answer kept (events come earliest
 * first): past it, events the answer left out may be the next ones, so the
 * desk reloads. Null when the answer was whole.
 */
export function truncatedFrom(d: Pick<HdUpcomingEvents, "events" | "truncated">): number | null {
  const last = d.events[d.events.length - 1];
  return d.truncated && last ? ms(last.starts_at) : null;
}

/**
 * Could the badge undercount? Only when the answer was truncated before the
 * end of today: events left out may start today too. The badge then reads
 * "12+" ("99+" past 99).
 */
export function todayLeftMore(d: Pick<HdUpcomingEvents, "events" | "truncated">, now: number, tz: string): boolean {
  const from = truncatedFrom(d);
  return from !== null && from < dayStart(addDays(dayOf(now, tz), 1), tz);
}

/** The rail badge's text: "3", "12+" (could be more), "99+". */
export function badgeText(count: number, more = false): string {
  return count > 99 ? "99+" : `${count}${more ? "+" : ""}`;
}

/** "Today", "Tomorrow", or "Thu 19 Nov". */
export function dayHeading(day: string, today: string): string {
  const n = daysBetween(today, day);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  return dayLabel(day, { year: false });
}

/**
 * When, on the pill: "Now" (running), "2:00 PM" (later today), "Tomorrow
 * 9:00 AM", "Thu 9:00 AM" (this coming week), "Thu 26 Nov, 9:00 AM".
 */
export function pillWhen(e: Pick<HdUpcomingEvent, "starts_at" | "ends_at">, now: number, tz: string, hour12 = false): string {
  if (inProgress(e, now)) return "Now";
  const start = ms(e.starts_at);
  const day = dayOf(start, tz);
  const n = daysBetween(dayOf(now, tz), day);
  const time = timeLabel(start, tz, hour12);
  if (n <= 0) return time;
  if (n === 1) return `Tomorrow ${time}`;
  if (n < 7) return `${weekdayShort(day)} ${time}`;
  return `${dayLabel(day, { year: false })}, ${time}`;
}

/** The pill's tooltip and accessible name: "Next event: Change freeze, Fri 20 Nov 2026, 2:00 PM to 3:00 PM at Boardroom A". */
export function pillSummary(e: HdUpcomingEvent, now: number, tz: string, hour12 = false): string {
  const lead = inProgress(e, now) ? "Happening now" : "Next event";
  return `${lead}: ${e.subject}, ${eventWhen(e, tz, hour12)}${e.place ? ` at ${e.place}` : ""}`;
}

/**
 * A timed event's times on a dropdown row listed under `day`: "2:00 PM to
 * 3:30 PM"; a start or end on another day carries its date ("Thu 19 Nov,
 * 10:00 PM to 1:00 AM" for a night event still running today).
 */
export function rowTimes(e: Pick<HdUpcomingEvent, "starts_at" | "ends_at">, day: string, tz: string, hour12 = false): string {
  const s = ms(e.starts_at);
  const en = ms(e.ends_at);
  const at = (t: number) => (dayOf(t, tz) === day ? timeLabel(t, tz, hour12) : `${dayLabel(dayOf(t, tz), { year: false })}, ${timeLabel(t, tz, hour12)}`);
  return `${at(s)} to ${at(en)}`;
}

/** A whole-day event on one of its days. `of` > 1 for a multi-day event: "Day `n` of `of`". */
export interface UpcomingAllDay {
  event: HdUpcomingEvent;
  n: number;
  of: number;
}

export interface UpcomingDay {
  day: string;
  heading: string;
  allDay: UpcomingAllDay[];
  timed: { event: HdUpcomingEvent; now: boolean }[];
}

/** "Day 2 of 5", or "" for a one-day event. */
export function dayOfLabel(a: Pick<UpcomingAllDay, "n" | "of">): string {
  return a.of > 1 ? `Day ${a.n} of ${a.of}` : "";
}

/** The dropdown, by day from today for `days` days; days with nothing on them are left out. */
export function upcomingDays(events: HdUpcomingEvent[], now: number, tz: string, days = UPCOMING_HORIZON_DAYS): UpcomingDay[] {
  const today = dayOf(now, tz);
  const last = addDays(today, days - 1);
  const map = new Map<string, UpcomingDay>();
  const at = (day: string) => {
    let d = map.get(day);
    if (!d) map.set(day, (d = { day, heading: dayHeading(day, today), allDay: [], timed: [] }));
    return d;
  };
  for (const e of events) {
    if (e.all_day) {
      if (!e.start_date || !e.end_date) continue;
      const of = daysBetween(e.start_date, e.end_date) + 1;
      // A whole day lasts until the agent's midnight: today's stay listed all day.
      for (let day = e.start_date > today ? e.start_date : today; day <= e.end_date && day <= last; day = addDays(day, 1)) {
        at(day).allDay.push({ event: e, n: daysBetween(e.start_date, day) + 1, of });
      }
      continue;
    }
    if (ms(e.ends_at) <= now) continue;
    const startDay = dayOf(ms(e.starts_at), tz);
    const day = startDay < today ? today : startDay;
    if (day > last) continue;
    at(day).timed.push({ event: e, now: inProgress(e, now) });
  }
  const out = [...map.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  for (const d of out) {
    d.allDay.sort((a, b) => (a.event.start_date! < b.event.start_date! ? -1 : a.event.start_date! > b.event.start_date! ? 1 : a.event.number - b.event.number));
    d.timed.sort((a, b) => ms(a.event.starts_at) - ms(b.event.starts_at) || a.event.number - b.event.number);
  }
  return out;
}

/** Today's whole-day events (the dropdown's "Today: 2 all-day events" line). */
export function allDayToday(events: HdUpcomingEvent[], now: number, tz: string): number {
  const today = dayOf(now, tz);
  return events.filter((e) => e.all_day && e.start_date && e.end_date && e.start_date <= today && e.end_date >= today).length;
}

/** "Today: 1 all-day event", "Today: 3 all-day events"; "" for none. */
export function allDayTodayLabel(count: number): string {
  return count > 0 ? `Today: ${count} all-day ${count === 1 ? "event" : "events"}` : "";
}

/** The badge's words for its link: "Calendar, 3 events left today". */
export function badgeWords(count: number, more = false): string {
  if (more) return "or more events left today";
  return `${count === 1 ? "event" : "events"} left today`;
}

/**
 * The next instant after `now` at which the pill, the badge or the list can
 * change: an event's end or start, the agent's next midnight, or `reloadAt`
 * (a truncated answer's last kept start).
 */
export function nextChangeAt(events: HdUpcomingEvent[], now: number, tz: string, reloadAt: number | null = null): number {
  let next = dayStart(addDays(dayOf(now, tz), 1), tz);
  // 1.20.24 review: a truncated answer is reloaded once the clock reaches its last kept start (truncatedFrom).
  if (reloadAt !== null && reloadAt > now && reloadAt < next) next = reloadAt;
  for (const e of events) {
    if (e.all_day) continue;
    for (const t of [ms(e.starts_at), ms(e.ends_at)]) if (t > now && t < next) next = t;
  }
  return next;
}

/**
 * Where an event opens: the Calendar's day view on that day, for all the
 * agent's teams (team=0), so a saved team filter never hides it. Following
 * the link never changes what the Calendar page remembers (CalendarPage).
 */
export function calendarDayHref(day: string): string {
  return `/desk/calendar?view=day&date=${day}&team=0`;
}
