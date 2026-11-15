"use client";

// The reply lock on the desk (1.20.20, lib/helpdesk/reply-lock): one shared
// store per ticket number, so the composer, the header strip and anything
// else on the page read the same answer from one poll.
//
//   useReplyLockState(n)       who holds ticket n's reply (polls GET every 4 s
//                              while the tab is visible and locks are on;
//                              every 30 s while they are off, to notice the
//                              setting being switched on)
//   useComposerReplyLock(...)  the composer's side: take on the first change
//                              to the Reply box, refresh while it is in use,
//                              release when the box is emptied or the composer
//                              goes away, Let go, Take over
//   useQueueReplyLocks(rows)   the queue's row badges (one GET for the list)
//
// The live channel seam (1.20.19 adds one): call pokeReplyLock(n) (or with no
// number, every ticket on the page) and pokeQueueReplyLocks() when a
// "reply lock changed" signal arrives; the stores fetch at once instead of
// waiting for their next poll. The polls stay as the fallback.
//
// The pop-out seam (1.20.18): the pop-out window hosts the same Composer, so
// it takes, refreshes and releases the lock itself. Each tab has an id
// (./tab): the server releases a lock only for the tab that holds it. When the
// reply pops out, the pane calls `await handOffReplyLock(n, id)` with the id
// it minted for the new window (newDeskTabId), before the window opens; the
// window adopts that id (adoptDeskTabId) and the pane's unmount releases
// nothing.

import { useCallback, useEffect, useRef, useState } from "react";
import { deskTabId, homeTabId } from "./tab";
import {
  REPLY_LOCK_POLL_MS,
  REPLY_LOCK_REFRESH_MS,
  type HdReplyLockBrief,
  type HdReplyLockState,
} from "@/lib/helpdesk/reply-lock-shared";

const OFF_POLL_MS = 30_000;
/** A remount of the same ticket within this keeps the lock (as presence's leave). */
const RELEASE_DELAY_MS = 2_000;

interface Entry {
  state: HdReplyLockState | null;
  subs: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  /** This page believes it holds the lock (it took it, or found it its own). */
  holding: boolean;
  /** The last change to, or focus in, the Reply box. */
  lastActivity: number;
  lastRefresh: number;
  pendingRelease: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<number, Entry>();

function entry(n: number): Entry {
  let e = entries.get(n);
  if (!e) {
    e = { state: null, subs: new Set(), timer: null, inFlight: false, holding: false, lastActivity: 0, lastRefresh: 0, pendingRelease: null };
    entries.set(n, e);
  }
  return e;
}

const url = (n: number) => `/api/helpdesk/tickets/${n}/reply-lock`;
const tabbed = (body?: Record<string, unknown>) => (body ? { tab: deskTabId(), ...body } : undefined);

function publish(n: number, state: HdReplyLockState | null) {
  const e = entry(n);
  // This tab holds it (not another tab of the agent's, or the reply's pop-out): only then does it refresh or release.
  if (state) e.holding = !!state.lock?.mine && state.lock.this_tab !== false;
  // Unchanged (most polls): keep the same object, so nothing re-renders.
  if (JSON.stringify(state) === JSON.stringify(e.state)) return;
  e.state = state;
  for (const s of e.subs) s();
}

async function request(n: number, method: "GET" | "POST" | "DELETE", body?: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: HdReplyLockState & { error?: string } }> {
  // 1.20.20: every call says which tab it comes from; a release counts only from the tab that holds the lock.
  const res = await fetch(method === "POST" ? url(n) : `${url(n)}?tab=${encodeURIComponent(deskTabId())}`, {
    method,
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(tabbed(body)) : undefined,
    cache: "no-store",
    keepalive: method === "DELETE",
  });
  const data = (await res.json().catch(() => ({}))) as HdReplyLockState & { error?: string };
  return { ok: res.ok, status: res.status, data };
}

function idleMs(e: Entry): number {
  return (e.state?.idle_minutes ?? 2) * 60_000;
}

async function tick(n: number) {
  const e = entry(n);
  if (e.timer) clearTimeout(e.timer);
  e.timer = null;
  if (!e.subs.size) return;
  const schedule = () => {
    if (!e.subs.size) return;
    e.timer = setTimeout(() => void tick(n), e.state && !e.state.enabled ? OFF_POLL_MS : REPLY_LOCK_POLL_MS);
  };
  if (document.visibilityState !== "visible" || e.inFlight) return schedule();
  e.inFlight = true;
  try {
    const now = Date.now();
    // The holder's heartbeat: only while the box was touched within the idle time.
    const refresh = e.holding && now - e.lastActivity < idleMs(e) && now - e.lastRefresh >= REPLY_LOCK_REFRESH_MS;
    // The server measures idle from the last touch it is told of (idle_ms), not from this heartbeat.
    const r = await request(n, refresh ? "POST" : "GET", refresh ? { action: "refresh", idle_ms: now - e.lastActivity } : undefined);
    if (refresh) e.lastRefresh = now;
    if (r.ok) publish(n, r.data);
  } catch {
    /* offline: try again next time */
  } finally {
    e.inFlight = false;
    schedule();
  }
}

/** Fetch now (the live channel's seam): ticket `n`, or every ticket on the page. */
export function pokeReplyLock(n?: number): void {
  for (const k of n === undefined ? [...entries.keys()] : [n]) if (entries.get(k)?.subs.size) void tick(k);
}

/**
 * The pop-out seam (see the header): move this tab's lock on ticket `n` to the
 * tab `newTabId` (the pop-out window's). This tab stops holding it at once (so
 * its unmount releases nothing); resolves whether the server moved it.
 */
export function handOffReplyLock(n: number, newTabId: string): Promise<boolean> {
  return moveReplyLock(n, deskTabId(), newTabId);
}

/**
 * Move the agent's lock on ticket `n` from tab `fromTab` to tab `toTab` (the
 * pop-out's hand-off and hand-back; the server moves it only while `fromTab`
 * holds it). `keepalive`, so a closing window still sends it.
 */
export async function moveReplyLock(n: number, fromTab: string, toTab: string): Promise<boolean> {
  if (fromTab === deskTabId()) entry(n).holding = false;
  try {
    const res = await fetch(url(n), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ action: "hand_off", tab: fromTab, to: toTab }),
      cache: "no-store",
      keepalive: true,
    });
    const d = (await res.json().catch(() => ({}))) as { handed_off?: boolean };
    if (toTab === deskTabId() && d.handed_off) {
      entry(n).holding = true;
      pokeReplyLock(n);
    }
    return res.ok && d.handed_off === true;
  } catch {
    return false;
  }
}

/** The pop-out took over the pane's last touch of the reply (from the hand-off record), so idle keeps counting from it. */
export function inheritReplyTouch(n: number, at: number): void {
  if (Number.isFinite(at) && at > 0 && at <= Date.now()) entry(n).lastActivity = Math.max(entry(n).lastActivity, at);
}

/** When this tab last touched ticket `n`'s Reply box (for the pop-out's hand-off record). */
export function lastReplyTouch(n: number): number {
  return entries.get(n)?.lastActivity ?? 0;
}

/** Who holds ticket `n`'s public reply, kept fresh while mounted. */
export function useReplyLockState(n: number, enabled = true): HdReplyLockState | null {
  const [state, setState] = useState<HdReplyLockState | null>(() => (n ? (entries.get(n)?.state ?? null) : null));
  useEffect(() => {
    if (!enabled || !n) return;
    const e = entry(n);
    const sub = () => setState(e.state);
    e.subs.add(sub);
    setState(e.state);
    if (e.subs.size === 1 || !e.timer) void tick(n);
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick(n);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      e.subs.delete(sub);
      document.removeEventListener("visibilitychange", onVisible);
      if (!e.subs.size && e.timer) {
        clearTimeout(e.timer);
        e.timer = null;
      }
    };
  }, [n, enabled]);
  return enabled ? state : null;
}

export interface ComposerReplyLock {
  state: HdReplyLockState | null;
  /** Someone else holds it: the Reply box is read-only. */
  lockedByOther: boolean;
  /** This person holds it. */
  mine: boolean;
  /** A lead took it from this person (while the lead holds it), until dismissed. */
  takenOver: { by_name: string; at: string } | null;
  dismissTakenOver: () => void;
  /** The Reply box changed (typed, pasted, inserted) or was focused with text. */
  touch: (hasText: boolean) => void;
  /** A public reply was sent (the server released the lock with it). */
  sent: () => void;
  letGo: () => Promise<void>;
  takeOver: () => Promise<string | null>;
  /** A lead's or admin's Release (the take over's rule): the lock goes, nobody takes it. */
  release: () => Promise<string | null>;
}

/**
 * The composer's side of the lock for ticket `n`. `publicMode`: the Reply tab
 * is showing; `hasText`: the Reply box has text. Notes never touch the lock.
 */
export function useComposerReplyLock(n: number, publicMode: boolean, hasText: boolean): ComposerReplyLock {
  const state = useReplyLockState(n);
  const taking = useRef(false);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const take = useCallback(async () => {
    if (taking.current) return;
    taking.current = true;
    try {
      const r = await request(n, "POST", { action: "take" });
      if (r.ok || r.status === 409) publish(n, r.data);
    } catch {
      /* offline: the server still refuses another's send */
    } finally {
      taking.current = false;
    }
  }, [n]);

  const touch = useCallback(
    (text: boolean) => {
      const ent = entry(n);
      ent.lastActivity = Date.now();
      if (!text) return;
      const s = ent.state;
      if (s && !s.enabled) return;
      if (s?.lock && !s.lock.mine) return; // read-only meanwhile; the poll lifts it
      if (!ent.holding) void take();
    },
    [n, take]
  );

  // A pending release from a moment ago (a remount of the same ticket) is cancelled.
  useEffect(() => {
    const ent = entry(n);
    if (ent.pendingRelease) {
      clearTimeout(ent.pendingRelease);
      ent.pendingRelease = null;
    }
    return () => {
      const cur = entry(n);
      if (!cur.holding) return;
      cur.pendingRelease = setTimeout(() => {
        cur.pendingRelease = null;
        // Handed to the pop-out meanwhile: nothing to release here.
        if (!cur.holding) return;
        cur.holding = false;
        void request(n, "DELETE").catch(() => {});
      }, RELEASE_DELAY_MS);
    };
  }, [n]);

  // Closing the page lets go at once.
  useEffect(() => {
    const leave = () => {
      if (!entry(n).holding) return;
      // The reply's pop-out closing unsent hands the lock back to the desk tab it came from; anything else lets go.
      const home = homeTabId();
      if (home) void moveReplyLock(n, deskTabId(), home);
      else void request(n, "DELETE").catch(() => {});
    };
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, [n]);

  // The Reply box was emptied (cleared, discarded): the lock goes. Only on a change this composer saw (text, then
  // none): a remount starts empty for a moment before its draft loads, and must not drop the lock.
  const hadText = useRef<{ n: number; v: boolean } | null>(null);
  useEffect(() => {
    const was = hadText.current?.n === n ? hadText.current.v : null;
    hadText.current = { n, v: publicMode && hasText };
    if (!publicMode || hasText || was !== true) return;
    const ent = entry(n);
    if (!ent.holding) return;
    ent.holding = false;
    void request(n, "DELETE")
      .then((r) => r.ok && publish(n, r.data))
      .catch(() => {});
  }, [n, publicMode, hasText]);

  const letGo = useCallback(async () => {
    entry(n).holding = false;
    entry(n).lastActivity = 0;
    try {
      const r = await request(n, "DELETE");
      if (r.ok) publish(n, r.data);
    } catch {
      /* it lapses on its own */
    }
  }, [n]);

  const takeOver = useCallback(async (): Promise<string | null> => {
    const from = entry(n).state?.lock?.user_id;
    const r = await request(n, "POST", { action: "take_over", ...(from ? { from } : {}) });
    publish(n, r.data && "enabled" in r.data ? r.data : entry(n).state);
    if (!r.ok) return r.data.error || "Couldn't take over the reply.";
    entry(n).lastActivity = Date.now();
    entry(n).lastRefresh = Date.now();
    return null;
  }, [n]);

  const release = useCallback(async (): Promise<string | null> => {
    const r = await request(n, "POST", { action: "release" });
    if (r.data && "enabled" in r.data) publish(n, r.data);
    return r.ok ? null : r.data.error || "Couldn't release the reply.";
  }, [n]);

  const sent = useCallback(() => {
    entry(n).holding = false;
    pokeReplyLock(n);
  }, [n]);

  const on = !!state?.enabled;
  const lock = on ? (state?.lock ?? null) : null;
  const taken = on && state?.taken_from_you ? state.taken_from_you : null;
  const takenOver = taken && dismissed !== taken.at ? { by_name: taken.by_name, at: taken.at } : null;
  return {
    state,
    lockedByOther: !!lock && !lock.mine,
    mine: !!lock?.mine,
    takenOver,
    dismissTakenOver: () => setDismissed(taken?.at ?? null),
    touch,
    sent,
    letGo,
    takeOver,
    release,
  };
}

/** The queue's badges: who is replying on which of these tickets (number → brief). */
export function useQueueReplyLocks(numbers: number[]): Map<number, HdReplyLockBrief> {
  const key = numbers.slice(0, 200).join(",");
  const [locks, setLocks] = useState<Map<number, HdReplyLockBrief>>(new Map());
  useEffect(() => {
    if (!key) {
      setLocks((m) => (m.size ? new Map() : m));
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let enabled = true;
    let last = "";
    const load = async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        if (document.visibilityState === "visible") {
          const res = await fetch(`/api/helpdesk/reply-locks?numbers=${key}`, { headers: { accept: "application/json" }, cache: "no-store" });
          if (res.ok) {
            const d = (await res.json()) as { enabled?: boolean; locks?: HdReplyLockBrief[] };
            enabled = d.enabled !== false;
            // A new map only when something changed, so the list does not re-render on every poll.
            const next = JSON.stringify(d.locks ?? []);
            if (alive && next !== last) {
              last = next;
              setLocks(new Map((d.locks ?? []).map((l) => [l.number, l])));
            }
          }
        }
      } catch {
        /* next time */
      }
      if (alive) timer = setTimeout(() => void load(), enabled ? QUEUE_POLL_MS : OFF_POLL_MS);
    };
    queuePokers.add(load);
    void load();
    return () => {
      alive = false;
      queuePokers.delete(load);
      if (timer) clearTimeout(timer);
    };
  }, [key]);
  return locks;
}

const QUEUE_POLL_MS = 8_000;
const queuePokers = new Set<() => Promise<void>>();

/** Reload the queue's badges now (the live channel's seam). */
export function pokeQueueReplyLocks(): void {
  for (const p of queuePokers) void p();
}
