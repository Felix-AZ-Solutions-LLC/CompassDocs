"use client";

// 1.20.24: the desk's upcoming events (GET /api/helpdesk/calendar/upcoming;
// rules in lib/helpdesk/desk-calendar-upcoming-shared). The shell holds one
// copy: the top bar's pill and its dropdown, and the Calendar rail icon's
// count, all read it. No poll of its own:
//
//   loads       once when the desk opens, then when the shell's live signal
//               bumps (1.20.19: a change in the agent's queues, which an
//               event change is: it touches its ticket), when the tab comes
//               back or the window takes focus, and every 5 minutes while
//               visible (a backstop for a desk whose live signal is down).
//               At most one load per 15 s; a load asked for sooner runs
//               once the 15 s are up.
//   the clock   one timer, for the next instant something changes (an event
//               ends or starts, or the agent's midnight): the pill moves on
//               and the count drops without asking the server. Capped at an
//               hour so a laptop that slept catches up; a new day reloads,
//               and so does reaching the last kept start of an answer that
//               was cut at 200 events (the ones left out may be next).

import { useCallback, useEffect, useRef, useState } from "react";
import { dayOf } from "@/lib/helpdesk/desk-calendar-shared";
import { nextChangeAt, todayLeft, todayLeftMore, truncatedFrom, type HdUpcomingEvents } from "@/lib/helpdesk/desk-calendar-upcoming-shared";
import { getJson } from "../api";

const MIN_GAP_MS = 15_000;
const BACKSTOP_MS = 5 * 60_000;
const MAX_TIMER_MS = 3_600_000;

export interface UpcomingState {
  data: HdUpcomingEvents | null;
  /** The clock the pill and the badge were worked out at (ms). */
  now: number;
  /** Today's timed events that have not ended (the rail badge). */
  left: number;
  /** The answer was cut short before the end of today: there may be more than `left` ("12+"). */
  leftMore: boolean;
  refresh: () => void;
}

export function useUpcomingEvents(enabled: boolean, live = 0): UpcomingState {
  const [data, setData] = useState<HdUpcomingEvents | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lastLoad = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(() => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    lastLoad.current = Date.now();
    getJson<HdUpcomingEvents>("/api/helpdesk/calendar/upcoming")
      .then((d) => {
        setData(d);
        setNow(Date.now());
      })
      .catch(() => {
        // Decoration, as the counts: a failed load keeps what was shown.
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [enabled]);

  const refresh = useCallback(() => {
    if (!enabled) return;
    const wait = lastLoad.current + MIN_GAP_MS - Date.now();
    if (wait <= 0) return load();
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      load();
    }, wait);
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled) return;
    load();
    const back = () => {
      if (document.visibilityState !== "visible") return;
      setNow(Date.now());
      refresh();
    };
    const t = setInterval(() => document.visibilityState === "visible" && refresh(), BACKSTOP_MS);
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
      if (pending.current) clearTimeout(pending.current);
      pending.current = null;
    };
  }, [enabled, load, refresh]);

  // The shell's live signal (1.20.19): something in the agent's queues changed.
  const seenLive = useRef(live);
  useEffect(() => {
    if (live === seenLive.current) return;
    seenLive.current = live;
    refresh();
  }, [live, refresh]);

  // The clock: wake at the next change.
  useEffect(() => {
    if (!data) return;
    const cut = truncatedFrom(data);
    const wait = Math.min(Math.max(nextChangeAt(data.events, now, data.timezone, cut) - Date.now() + 250, 250), MAX_TIMER_MS);
    const t = setTimeout(() => {
      const n = Date.now();
      setNow(n);
      if (dayOf(n, data.timezone) !== data.today || (cut !== null && n >= cut)) refresh();
    }, wait);
    return () => clearTimeout(t);
  }, [data, now, refresh]);

  const shown = enabled ? data : null;
  return {
    data: shown,
    now,
    left: shown ? todayLeft(shown.events, now, shown.timezone) : 0,
    leftMore: shown ? todayLeftMore(shown, now, shown.timezone) : false,
    refresh,
  };
}
