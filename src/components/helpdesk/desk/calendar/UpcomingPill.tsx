"use client";

// 1.20.24: the desk top bar's upcoming-events pill and its dropdown
// (STYLEGUIDE §Helpdesk: the event calendar → "Upcoming events"; rules in
// lib/helpdesk/desk-calendar-upcoming-shared, data from ./upcoming, which
// the shell holds so the rail's count reads the same copy).
//
// The pill is the next timed event that has not ended: "Change freeze ·
// 2:00 PM", "Tomorrow 9:00 AM", "Now" while it runs. Whole-day events never
// make the pill; with no timed event in the next 14 days there is no pill.
// Same family as the status pill: `rounded-full border h-8`, the subject
// from xl, the time from sm, a 32px icon circle under sm (the summary in
// its data-tt and aria-label). It opens a menu: by day, each day's All day
// events first ("Day 2 of 5" on a multi-day one), then the timed events by
// start; each opens that day in the Calendar; Open calendar at the foot.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CalendarDays, ChevronDown, Sun } from "lucide-react";
import { Popover } from "@/components/Popover";
import { RAIL_GROUP_TEXT } from "@/components/RailLink";
import { useAppSettings } from "@/components/SettingsProvider";
import { timeLabel, zoneLabel } from "@/lib/helpdesk/desk-calendar-shared";
import {
  allDayToday,
  allDayTodayLabel,
  calendarDayHref,
  dayOfLabel,
  inProgress,
  nextTimedEvent,
  pillSummary,
  pillWhen,
  rowTimes,
  upcomingDays,
} from "@/lib/helpdesk/desk-calendar-upcoming-shared";
import type { UpcomingState } from "./upcoming";

const ROW = "flex w-full items-start gap-3 px-4 py-1.5 text-left hover:bg-slate-100 focus-visible:bg-slate-100";
const WHEN_COL = "w-18 shrink-0 pt-px text-xs font-medium tabular-nums";

export function UpcomingPill({ upcoming }: { upcoming: UpcomingState }) {
  const { time_format } = useAppSettings();
  const h12 = time_format === "12h";
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const { data, now } = upcoming;
  const tz = data?.timezone ?? "UTC";
  const next = data ? nextTimedEvent(data.events, now) : null;
  const days = useMemo(() => (data && open ? upcomingDays(data.events, now, tz, data.horizon_days) : []), [data, open, now, tz]);
  // Stable, so a reload or the clock re-rendering the bar never re-opens the menu's focus on its first item.
  const close = useCallback(() => setOpen(false), []);
  // 1.20.24 review: when the pill goes (the last timed event ended), the menu closes with it, so a later reload
  // that brings the pill back never mounts it already open and takes focus from whatever the agent is typing in.
  const shown = !!data && !!next;
  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);
  if (!data || !next) return null;

  const running = inProgress(next, now);
  const when = pillWhen(next, now, tz, h12);
  const summary = pillSummary(next, now, tz, h12);
  const allDay = allDayTodayLabel(allDayToday(data.events, now, tz));
  // The menu's header and truncation note sit outside its items, where a screen reader walking the menu never
  // goes: the trigger's name carries them.
  const spoken = [summary, allDay, `Times in ${zoneLabel(tz)}`, data.truncated ? "More events than the list shows; the calendar has them all" : ""].filter(Boolean).join(". ");

  return (
    <div className="relative print:hidden">
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${spoken}. Show upcoming events`}
        data-tt={summary}
        data-tt-pos="bottom"
        data-tt-wrap
        data-testid="upcoming-pill"
        className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-slate-200 bg-surface px-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 max-sm:w-8 max-sm:justify-center max-sm:px-0"
      >
        <CalendarDays className={`h-3.5 w-3.5 shrink-0 ${running ? "text-compass-ink" : "text-slate-500"}`} aria-hidden />
        <span className="hidden max-w-48 truncate xl:inline" data-testid="upcoming-pill-subject">
          {next.subject}
        </span>
        <span className="hidden text-slate-400 xl:inline" aria-hidden>
          ·
        </span>
        <span className={`max-sm:hidden ${running ? "font-semibold text-compass-ink" : "text-slate-600"}`} data-testid="upcoming-pill-when">
          {when}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500 max-sm:hidden" aria-hidden />
      </button>
      <Popover
        open={open}
        onClose={close}
        triggerRef={btn}
        role="menu"
        label="Upcoming events"
        align="end"
        width="w-[min(23rem,calc(100vw-1rem))]"
        padding="p-0"
        className="mt-2 overflow-hidden rounded-xl"
      >
        <div className="border-b border-slate-100 px-4 py-3" data-testid="upcoming-menu">
          <p className="text-sm font-semibold text-slate-900">Upcoming events</p>
          <p className="mt-0.5 text-xs text-slate-500">
            The next {data.horizon_days} days · times in {zoneLabel(tz)}
          </p>
          {allDay && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-700" data-testid="upcoming-allday-today">
              <Sun className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
              {allDay}
            </p>
          )}
        </div>
        <div className="max-h-[min(24rem,60vh)] overflow-y-auto py-1">
          {days.map((d) => (
            <div key={d.day} role="group" aria-label={d.heading} data-testid="upcoming-day" data-day={d.day}>
              <p className={`${RAIL_GROUP_TEXT} px-4 pb-1 pt-2`} aria-hidden>
                {d.heading}
              </p>
              {d.allDay.map((a) => {
                const extra = [dayOfLabel(a), a.event.place].filter(Boolean).join(" · ");
                return (
                  <Link key={`a${a.event.number}`} href={calendarDayHref(d.day)} role="menuitem" onClick={close} className={ROW} data-testid="upcoming-allday">
                    <span className={`${WHEN_COL} text-slate-500`}>All day</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-slate-900">{a.event.subject}</span>
                      {extra && <span className="block truncate text-xs text-slate-500">{extra}</span>}
                    </span>
                  </Link>
                );
              })}
              {d.timed.map(({ event: e, now: live }) => (
                <Link key={`t${e.number}`} href={calendarDayHref(d.day)} role="menuitem" onClick={close} className={ROW} data-testid="upcoming-timed">
                  <span className={`${WHEN_COL} ${live ? "font-semibold text-compass-ink" : "text-slate-600"}`}>{live ? "Now" : timeLabel(e.starts_at, tz, h12)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-slate-900">{e.subject}</span>
                    <span className="block truncate text-xs text-slate-500">
                      {rowTimes(e, d.day, tz, h12)}
                      {e.place ? ` · ${e.place}` : ""}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          ))}
        </div>
        {data.truncated && <p className="border-t border-slate-100 px-4 py-1.5 text-xs text-slate-500">More events than fit here. The calendar has them all.</p>}
        <div className="border-t border-slate-100 p-1">
          <Link href="/desk/calendar" role="menuitem" onClick={close} className="flex w-full items-center gap-2 rounded-sm px-3 py-1.5 text-sm font-medium text-compass-600 hover:bg-slate-100 focus-visible:bg-slate-100">
            <CalendarDays className="h-4 w-4 shrink-0" aria-hidden />
            Open calendar
          </Link>
        </div>
      </Popover>
    </div>
  );
}
