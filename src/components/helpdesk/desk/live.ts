"use client";

// Live queue updates, the desk's side (1.20.19). One listener per desk tab
// (the shell's counts hook owns it): it hears "your queues changed" from
// GET /api/helpdesk/live and calls onSignal, and the desk reloads its list
// and counts through their own APIs.
//
//   stream      an EventSource. The browser reconnects by itself (after the
//               server's 2-6 s `retry`) and sends Last-Event-ID, so a change
//               missed in between still arrives.
//   long poll   when the stream never says hello within 8 s (a proxy that
//               buffers it), or is refused: GET ?wait=25.
//   polling     when the long poll is refused too (503 while the server
//               can't listen, 429): a plain reload every 30 s while visible.
//   From either fallback the stream is tried again after 30 s, doubling per
//   failure to 10 min, ±50 %, so one bad moment doesn't leave a tab polling
//   for good, and a deploy's worth of tabs doesn't come back at once.
//
// Every run carries a generation number: pausing (a hidden tab), showing
// again or a fallback starts a new generation and the old loops stop, so
// two loops can never run side by side. A hidden tab keeps listening for a
// minute, then closes; showing it again reconnects (after up to 1.5 s,
// random) with the last cursor. A signal while hidden waits for the tab.

import { useEffect, useRef } from "react";
import {
  LIVE_FALLBACK_POLL_MS,
  LIVE_HELLO_TIMEOUT_MS,
  LIVE_HIDDEN_CLOSE_MS,
  LIVE_LONGPOLL_PAUSE_MS,
  LIVE_RETRY_MAX_MS,
  LIVE_RETRY_MIN_MS,
} from "@/lib/helpdesk/live-shared";

const URL_BASE = "/api/helpdesk/live";

export type LiveMode = "stream" | "longpoll" | "poll";

const jitter = (ms: number) => ms * (0.5 + Math.random());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Calls onSignal when something in the agent's queues changed (folded by the server). */
export function useLiveSignal(enabled: boolean, onSignal: () => void): void {
  const cb = useRef(onSignal);
  cb.current = onSignal;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const canStream = typeof EventSource === "function";
    let gen = 0;
    let cursor = "";
    let mode: LiveMode = canStream ? "stream" : "longpoll";
    let retries = 0; // stream attempts that fell back, for the back-off
    let es: EventSource | null = null;
    let lpAbort: AbortController | null = null;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
    let missed = false;
    let disposed = false;

    const later = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
    };

    const fire = () => {
      if (document.visibilityState !== "visible") {
        missed = true;
        return;
      }
      cb.current();
    };

    /** Stop everything the current generation runs. */
    const stop = () => {
      gen++;
      es?.close();
      es = null;
      lpAbort?.abort();
      lpAbort = null;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };

    /** A fallback for this generation, and the stream tried again later. */
    const fallBack = (to: "longpoll" | "poll") => {
      stop();
      mode = to;
      const my = gen;
      if (to === "longpoll") void longPoll(my);
      else pollLoop(my);
      if (canStream) {
        const wait = jitter(Math.min(LIVE_RETRY_MAX_MS, LIVE_RETRY_MIN_MS * 2 ** retries));
        retries++;
        later(() => {
          if (gen !== my) return;
          stop();
          mode = "stream";
          openStream(gen);
        }, wait);
      }
    };

    function openStream(my: number) {
      const src = new EventSource(cursor ? `${URL_BASE}?since=${encodeURIComponent(cursor)}` : URL_BASE);
      es = src;
      let greeted = false;
      let errors = 0;
      later(() => gen === my && !greeted && fallBack("longpoll"), LIVE_HELLO_TIMEOUT_MS);
      src.addEventListener("hello", (e) => {
        if (gen !== my) return;
        greeted = true;
        errors = 0;
        retries = 0;
        cursor = (e as MessageEvent).lastEventId || cursor;
      });
      src.addEventListener("changed", (e) => {
        if (gen !== my) return;
        cursor = (e as MessageEvent).lastEventId || cursor;
        fire();
      });
      src.onerror = () => {
        if (gen !== my) return;
        // CLOSED: the server answered with an error (a 503, a 429); the browser won't retry.
        if (src.readyState === EventSource.CLOSED) return fallBack("longpoll");
        // CONNECTING: the browser retries by itself; a stream that keeps failing moves on.
        if (++errors >= 3 && !greeted) fallBack("longpoll");
      };
    }

    async function longPoll(my: number) {
      let failures = 0;
      while (gen === my && !disposed) {
        lpAbort = new AbortController();
        try {
          const res = await fetch(`${URL_BASE}?wait=25${cursor ? `&since=${encodeURIComponent(cursor)}` : ""}`, {
            headers: { accept: "application/json" },
            cache: "no-store",
            signal: lpAbort.signal,
          });
          if (gen !== my) return;
          if ([401, 402, 403, 429, 503].includes(res.status)) return fallBack("poll");
          if (!res.ok) throw new Error(String(res.status));
          const d = (await res.json()) as { changed?: boolean; cursor?: string };
          failures = 0;
          if (typeof d.cursor === "string") cursor = d.cursor;
          if (d.changed) {
            fire();
            await sleep(jitter(LIVE_LONGPOLL_PAUSE_MS));
          }
        } catch (e) {
          if ((e as Error).name === "AbortError" || gen !== my) return;
          if (++failures >= 3) return fallBack("poll");
          await sleep(jitter(2_000 * failures));
        }
      }
    }

    function pollLoop(my: number) {
      const tick = () => {
        if (gen !== my) return;
        if (document.visibilityState === "visible") cb.current();
        later(tick, LIVE_FALLBACK_POLL_MS);
      };
      later(tick, LIVE_FALLBACK_POLL_MS);
    }

    const begin = () => {
      if (disposed) return;
      stop();
      const my = gen;
      if (mode === "stream") openStream(my);
      else if (mode === "longpoll") fallBack("longpoll");
      else fallBack("poll");
    };

    const onVis = () => {
      if (document.visibilityState === "visible") {
        if (hiddenTimer) {
          clearTimeout(hiddenTimer);
          hiddenTimer = null;
        } else if (!es && !lpAbort && timers.size === 0) {
          // Paused while hidden: back, after a moment so a fleet of tabs doesn't reconnect together.
          mode = canStream ? "stream" : "longpoll";
          const my = gen;
          setTimeout(() => gen === my && begin(), Math.random() * 1_500);
        }
        if (missed) {
          missed = false;
          cb.current();
        }
      } else if (!hiddenTimer) {
        hiddenTimer = setTimeout(() => {
          hiddenTimer = null;
          stop();
        }, LIVE_HIDDEN_CLOSE_MS);
      }
    };

    begin();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      disposed = true;
      stop();
      if (hiddenTimer) clearTimeout(hiddenTimer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [enabled]);
}
