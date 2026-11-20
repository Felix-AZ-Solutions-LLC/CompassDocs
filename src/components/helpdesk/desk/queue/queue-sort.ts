"use client";

// 1.20.36: the agent's queue sort (lib/helpdesk/queue-sort-shared), the
// order the ticket list shows in every view unless the address names one
// (?sort=, for that list only) or the view fixes its own (Parked). The page
// starts from the agent's desk preference as the server read it (DeskMe
// queue_sort, so the first paint is already in their order).
//
// One store per window, keyed by the agent:
//   - a pick (the queue's Sort, or the Notifications card) shows at once and
//     joins this window's one save queue (PUT /api/helpdesk/me/notification-
//     prefs), so this window's saves reach the server in the order they were
//     made; a save a newer change has overtaken before it was sent is
//     skipped;
//   - every change carries a revision (when it was picked, then a window id);
//     once saved it is told to the agent's other desk windows in this browser
//     (a BroadcastChannel DeskShell opens on every desk page), which take it
//     only when it is newer than anything they have seen;
//   - a refused save puts back the last value known to be saved (the
//     server's, this window's last good save, or another window's saved
//     change), with the server's sentence in a toast, and only when nothing
//     newer happened meanwhile;
//   - if another window's newer change arrives while this window's older save
//     is on its way, the newer value is saved again after it, so the server
//     ends on the newest choice;
//   - a desk page that mounts after a client navigation, and a window coming
//     back into view, read the saved preference again (a safety net for a
//     message missed while no desk page listened).

import { useEffect, useSyncExternalStore } from "react";
import { toast } from "@/components/Toasts";
import { QUEUE_SORT_DEFAULT, cleanQueueSort, isQueueSort, queueSortLabel, type HdQueueSort } from "@/lib/helpdesk/queue-sort-shared";
import { getJson, sendJson } from "../api";
import { useDeskMe } from "../me";

const CHANNEL = "compass-desk-queue-sort";
const PREFS = "/api/helpdesk/me/notification-prefs";

/** A change's revision: when it was picked, then the window that picked it (a tie-break). */
export interface QueueSortRev {
  at: number;
  tab: string;
}
export const isNewerRev = (a: QueueSortRev, b: QueueSortRev): boolean => a.at > b.at || (a.at === b.at && a.tab > b.tab);
const ZERO: QueueSortRev = { at: 0, tab: "" };

const TAB = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

interface State {
  /** The agent this window's state belongs to (0: nobody yet). */
  user: number;
  /** What this window shows; undefined: the value the page loaded with. */
  shown: HdQueueSort | null | undefined;
  /** The last value known to be saved; undefined: the value the page loaded with. */
  confirmed: HdQueueSort | null | undefined;
  /** The newest change this window has seen (its own picks and other windows' saved changes). */
  latest: QueueSortRev;
  latestSort: HdQueueSort | null | undefined;
}

const fresh = (user: number): State => ({ user, shown: undefined, confirmed: undefined, latest: ZERO, latestSort: undefined });
let st: State = fresh(0);
/** Bumped by every change (a pick here, another window's newer saved change, a sign-in as someone else). */
let seq = 0;
/** This window's saves, one after another. */
let chain: Promise<unknown> = Promise.resolve();
let queued = 0;
const listeners = new Set<() => void>();

/** The seams the store talks through (tests replace them). */
const deps = {
  put: (sort: HdQueueSort | null) => sendJson(PREFS, "PUT", { queue_sort: sort }, "Couldn't save your sort."),
  get: async (): Promise<unknown> => (await getJson<{ prefs?: { queue_sort?: unknown } }>(PREFS, "Couldn't load your sort.")).prefs?.queue_sort,
  toast: (text: string) => toast("error", text),
  now: () => Date.now(),
};

/** Tests only: replace the network, the toast or the clock. */
export function setQueueSortDepsForTests(d: Partial<typeof deps>): void {
  Object.assign(deps, d);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  for (const fn of listeners) fn();
}

/** Make the state the agent's (L6: a window signed in as someone else never shows the last person's sort). */
function own(userId: number): void {
  if (st.user === userId) return;
  st = fresh(userId);
  seq++;
  emit();
}

function show(sort: HdQueueSort | null): void {
  if (st.shown === sort) return;
  st.shown = sort;
  emit();
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  queued++;
  const run = chain.then(task).finally(() => void queued--);
  chain = run.catch(() => undefined);
  return run;
}

function nextRev(): QueueSortRev {
  return { at: Math.max(deps.now(), st.latest.at + 1), tab: TAB };
}

/** The sort this window shows for `userId`, given the value the page loaded with. */
export function currentQueueSort(userId: number, loaded: HdQueueSort | null): HdQueueSort | null {
  return st.user === userId && st.shown !== undefined ? st.shown : loaded;
}

// --- Other windows -------------------------------------------------------------------------

let channel: BroadcastChannel | null = null;

function channelFor(userId: number): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined" || !userId) return null;
  own(userId);
  if (channel) return channel;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (e: MessageEvent) => receive(e.data);
  return channel;
}

/** Listen for the agent's other desk windows (DeskShell, on every desk page). */
export function openQueueSortChannel(userId: number): void {
  channelFor(userId);
}

/** Tests only: stop listening, so the process can end. */
export function closeQueueSortChannelForTests(): void {
  channel?.close();
  channel = null;
}

/** Another window's saved change: taken only when it is this agent's, well formed, and newer than anything seen here. */
export function receive(data: unknown): boolean {
  const d = data as { user?: unknown; sort?: unknown; at?: unknown; tab?: unknown } | null;
  if (!d || d.user !== st.user || !st.user) return false;
  if (!(d.sort === null || isQueueSort(d.sort)) || typeof d.at !== "number" || !Number.isFinite(d.at) || typeof d.tab !== "string") return false;
  const rev = { at: d.at, tab: d.tab };
  if (!isNewerRev(rev, st.latest)) return false; // stale: an older change that arrived late
  seq++; // a save of this window's still waiting is overtaken, and a refusal now never undoes this
  st.latest = rev;
  st.latestSort = d.sort as HdQueueSort | null;
  st.confirmed = d.sort as HdQueueSort | null; // another window sends only what it saved
  show(d.sort as HdQueueSort | null);
  return true;
}

function tell(userId: number, sort: HdQueueSort | null, rev: QueueSortRev): void {
  try {
    channelFor(userId)?.postMessage({ user: userId, sort, at: rev.at, tab: rev.tab });
  } catch {
    /* a closed channel: the other windows read the saved preference when they next look */
  }
}

// --- Changes -------------------------------------------------------------------------------

/**
 * The agent picked a sort (the queue's Sort, or Settings → Notifications): shown at once and saved as their
 * preference after this window's earlier saves. `loaded` is the value the page loaded with. On a refusal the last
 * value known to be saved comes back and a toast says why. Resolves true once saved, false when refused or
 * overtaken before it was sent.
 */
export function chooseQueueSort(userId: number, sort: HdQueueSort | null, loaded: HdQueueSort | null): Promise<boolean> {
  own(userId);
  if (st.confirmed === undefined) st.confirmed = loaded;
  const mine = ++seq;
  const rev = nextRev();
  st.latest = rev;
  st.latestSort = sort;
  show(sort);
  return enqueue(async () => {
    if (mine !== seq) return false; // overtaken before it was sent: the newer change is saved by whoever made it
    try {
      await deps.put(sort);
    } catch (e) {
      if (mine === seq && st.user === userId) {
        const back = st.confirmed ?? null;
        show(back);
        deps.toast(`${(e as Error).message} Your sort is back to ${queueSortLabel(back ?? QUEUE_SORT_DEFAULT)}.`);
      }
      return false;
    }
    if (st.user !== userId) return true;
    if (mine === seq) {
      st.confirmed = sort;
      tell(userId, sort, rev);
    } else if (st.latest.tab === TAB) {
      st.confirmed = sort; // a newer pick here follows in the queue; if it is refused, this is what comes back
    } else if (st.latestSort !== undefined && st.latestSort !== sort) {
      // Another window's newer change arrived while this older one was on its way: save the newer value again.
      const again = st.latestSort;
      void enqueue(() => deps.put(again).catch(() => undefined));
    }
    return true;
  });
}

/** Read the saved preference again (a page mounted after a client navigation, or the window came back into view). */
export async function refreshQueueSort(userId: number): Promise<void> {
  own(userId);
  const at = seq;
  let v: HdQueueSort | null;
  try {
    v = cleanQueueSort(await deps.get());
  } catch {
    return; // keep what is shown; the next look tries again
  }
  // Anything that happened meanwhile (a pick, a save on its way, another window's change) knows better.
  if (seq !== at || queued > 0 || st.user !== userId) return;
  st.confirmed = v;
  show(v);
}

// --- Hooks ---------------------------------------------------------------------------------

/** The first desk page of this document reads its value from the server render; later ones read it again. */
let firstPage = true;

/**
 * The agent's saved sort as this window knows it (null: the desk's default). `refresh`: the page reads the saved
 * value again when it mounts after a client navigation (the queue, the Notifications card).
 */
export function useQueueSortPref(opts: { refresh?: boolean } = {}): HdQueueSort | null {
  const me = useDeskMe();
  const loaded = cleanQueueSort(me.queue_sort);
  const refresh = !!opts.refresh;
  useEffect(() => {
    if (!refresh) return;
    if (firstPage) {
      firstPage = false;
      return;
    }
    void refreshQueueSort(me.id);
  }, [me.id, refresh]);
  return useSyncExternalStore(subscribe, () => currentQueueSort(me.id, loaded), () => loaded);
}

/** DeskShell: listen for the agent's other windows on every desk page, and read the saved value again on return. */
export function useQueueSortSync(userId: number, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !userId) return;
    openQueueSortChannel(userId);
    let lastLook = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastLook < 10_000) return;
      lastLook = Date.now();
      void refreshQueueSort(userId);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [userId, enabled]);
}
