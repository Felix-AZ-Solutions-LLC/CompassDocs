// Helpdesk 1.20.34: "Hold until the event" (lib/helpdesk/desk-calendar-park),
// the pure half: when a parked ticket wakes, the sentences and the chips.
// Safe in client components.
//
// A parked ticket is on hold with a wake time. It wakes the prep window's
// working days before its event's setup must be ready:
//
//   start       the event's start; an all-day event starts at the start of
//               its first day in the desk's zone (the ticket's team
//               calendar's), whatever zone it was entered in
//   ready       start minus the event's setup lead time
//   wake        the opening of the Nth working day before the ready day in
//               that calendar (lib/helpdesk/business-waits-shared: the day
//               itself never counts; holidays and closed days are passed
//               over). N = 0: the ready time itself. A calendar with no open
//               hours counts N calendar days back from the ready time.
//
// Parking is refused when the wake time is already past or within the next
// hour: "This event is too close to park: it would wake today."

import { shiftBusinessDays } from "./business-waits-shared";
import { hasOpenHours } from "./sla";
import { dayLabel, dayOf, dayStart, timeLabel, type HdTicketEvent } from "./desk-calendar-shared";
import type { HdBusinessHours } from "./types";

export const PARK_LIMITS = {
  /** The prep window, in working days. */
  prepDaysMax: 60,
  /** A wake time closer than this is "too close to park". */
  minLeadMs: 3_600_000,
} as const;

/** Why a ticket was parked: by a person (the Event block, the API, Claude), or by itself after a meeting invite or a calendar request type. */
export type HdParkReason = "agent" | "invite" | "request_type";
export const HD_PARK_REASONS: readonly HdParkReason[] = ["agent", "invite", "request_type"];

/** The ticket's parking as the desk, the API and the connector read it. */
export interface HdParking {
  /** When it wakes (ISO); null when it is not parked. */
  parked_until: string | null;
  parked_at: string | null;
  reason: HdParkReason | null;
  /** The prep window that applies (the ticket's own, else the desk's). */
  prep_days: number;
  /** The ticket's own prep window; null: the desk's. */
  prep_override: number | null;
  /** The desk's (Desk settings → Event calendar). */
  default_prep_days: number;
}

/** GET /api/helpdesk/tickets/[number]/event/park and the Event block. */
export interface HdParkingView extends HdParking {
  /** The viewer may park, wake and change the prep window (they may change the ticket's status). */
  can_change: boolean;
  /** The ticket can be parked now (a live event, not solved, closed, merged or binned, not parked). */
  can_park: boolean;
  /** When it would wake with `prep_days` (ISO), and the sentence that refuses parking when that is too close. */
  preview: { wake_at: string | null; refusal: string | null } | null;
}

type WakeEvent = Pick<HdTicketEvent, "starts_at" | "all_day" | "start_date" | "setup_minutes">;

/** The instant the event starts for parking: an all-day event at the start of its first day in `tz`. */
export function parkStart(e: WakeEvent, tz: string): number {
  if (e.all_day && e.start_date) return dayStart(e.start_date, tz);
  return new Date(e.starts_at).getTime();
}

/** When a ticket parked for this event wakes (see the header). `hours` is the ticket's team calendar. */
export function wakeInstant(e: WakeEvent, prepDays: number, hours: HdBusinessHours): number {
  const tz = hours.timezone;
  const ready = parkStart(e, tz) - Math.max(0, e.setup_minutes) * 60_000;
  const n = Math.max(0, Math.min(PARK_LIMITS.prepDaysMax, Math.floor(prepDays)));
  if (n === 0) return ready;
  if (hasOpenHours(hours)) {
    const r = shiftBusinessDays(dayOf(ready, tz), -n, hours, "open");
    if (r.at !== null) return Math.min(r.at, ready);
  }
  return ready - n * 86_400_000;
}

/** Null when `wake` leaves room to park at `now`; else the sentence that refuses it. */
export function tooCloseToPark(wake: number, now: number, tz: string): string | null {
  if (wake > now + PARK_LIMITS.minLeadMs) return null;
  const day = dayOf(wake, tz);
  const today = dayOf(now, tz);
  if (day === today) return "This event is too close to park: it would wake today.";
  if (wake < now) return `This event is too close to park: it would have woken on ${dayLabel(day, { year: false })}.`;
  return `This event is too close to park: it would wake on ${dayLabel(day, { year: false })}.`;
}

/** "Sun 15 Mar" (with the year when it isn't this year's): the day the event starts, in `tz` for a timed one. */
export function eventDay(e: Pick<HdTicketEvent, "starts_at" | "all_day" | "start_date">, tz: string, now: number = Date.now()): string {
  const day = e.all_day && e.start_date ? e.start_date : dayOf(e.starts_at, tz);
  return dayLabel(day, { year: day.slice(0, 4) !== dayOf(now, tz).slice(0, 4) });
}

/** "Tue 3 Mar" for a wake instant in `tz`. */
export function wakeDay(at: string | number, tz: string, now: number = Date.now()): string {
  const day = dayOf(at, tz);
  return dayLabel(day, { year: day.slice(0, 4) !== dayOf(now, tz).slice(0, 4) });
}

/** The desk's header chip: "Parked until Tue 3 Mar · for the event on Sun 15 Mar". */
export function parkedChipLabel(until: string, e: Pick<HdTicketEvent, "starts_at" | "all_day" | "start_date"> | null, tz: string, now?: number): string {
  const head = `Parked until ${wakeDay(until, tz, now)}`;
  return e ? `${head} · for the event on ${eventDay(e, tz, now)}` : head;
}

/** The requester's chip: "Scheduled · Sun 15 Mar, 10:00 · Room 4" (whole days: no time; no place: none). */
export function scheduledLabel(e: Pick<HdTicketEvent, "starts_at" | "all_day" | "start_date" | "place">, tz: string, hour12 = false, now?: number): string {
  const when = e.all_day ? eventDay(e, tz, now) : `${eventDay(e, tz, now)}, ${timeLabel(e.starts_at, tz, hour12)}`;
  return `Scheduled · ${when}${e.place ? ` · ${e.place}` : ""}`;
}

/** "10 working days", "1 working day", "no prep time". */
export function prepLabel(days: number): string {
  if (days <= 0) return "no prep time";
  return `${days} working ${days === 1 ? "day" : "days"}`;
}

/** A prep window sent by a caller: a whole number 0 to 60, or null (the desk's). */
export function checkPrepDays(raw: unknown): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null };
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > PARK_LIMITS.prepDaysMax) {
    return { ok: false, error: `The prep window is 0 to ${PARK_LIMITS.prepDaysMax} working days, or null for the desk's.` };
  }
  return { ok: true, value: n };
}

/**
 * lib/helpdesk/tickets updateTicket, inside its transaction: a status change on a parked ticket ends the parking (any
 * change: a solve, back to open, waiting on the requester). The columns to clear and the agents-only line, or null.
 */
export function endParkingSets(before: { parked_until?: string | null }, whoMd: string): { sets: Record<string, unknown>; line: string } | null {
  if (!before.parked_until) return null;
  return { sets: { parked_until: null, parked_at: null, park_reason: "", park_wake_failures: 0, park_wake_error: "", park_wake_retry_at: null }, line: `${whoMd} ended the parking: the ticket no longer waits for its event` };
}
