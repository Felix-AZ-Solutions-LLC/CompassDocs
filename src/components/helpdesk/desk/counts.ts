"use client";

// The desk's counts (GET /api/helpdesk/counts): the views' and teams'
// numbers, the headline tiles and the approvals badge. Loaded once by the
// shell and polled every minute while the tab is visible; screens that
// change a ticket call refresh() so the numbers follow at once.
//
// 1.20.19: the shell also listens for live signals (./live): a change in
// the agent's queues reloads the counts at once and bumps `live`, which
// the queue layout watches to reload its list and the saved views' counts.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { HdCounts } from "@/lib/helpdesk/types";
import { getJson } from "./api";
import { useLiveSignal } from "./live";
import { pokeQueueReplyLocks, pokeReplyLock } from "./reply-lock/reply-lock";

export const DeskCountsContext = createContext<{ counts: HdCounts | null; refresh: () => void; live?: number }>({
  counts: null,
  refresh: () => {},
  live: 0,
});

export function useDeskCounts() {
  return useContext(DeskCountsContext);
}

export function useCountsPoll(enabled: boolean) {
  const [counts, setCounts] = useState<HdCounts | null>(null);
  const [live, setLive] = useState(0);
  // One counts request at a time: a signal during one asks for one more after it.
  const inFlight = useRef(false);
  const again = useRef(false);
  const refresh = useCallback(() => {
    if (!enabled) return;
    const run = () => {
      if (inFlight.current) {
        again.current = true;
        return;
      }
      inFlight.current = true;
      getJson<HdCounts>("/api/helpdesk/counts")
        .then((c) => setCounts(c))
        .catch(() => {
          // Counts are decoration: a failed poll keeps the last numbers.
        })
        .finally(() => {
          inFlight.current = false;
          if (again.current) {
            again.current = false;
            run();
          }
        });
    };
    run();
  }, [enabled]);

  useLiveSignal(enabled, () => {
    refresh();
    setLive((n) => n + 1);
    // 1.20.20: a reply lock taken, moved or gone signals too (lib/helpdesk/reply-lock-schema): fetch the locks now.
    pokeReplyLock();
    pokeQueueReplyLocks();
  });

  useEffect(() => {
    refresh();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 60_000);
    const onVis = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);

  return { counts, refresh, live };
}
