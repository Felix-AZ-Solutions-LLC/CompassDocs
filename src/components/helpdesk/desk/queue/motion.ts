"use client";

// The queue list's motion when a live update lands (1.20.19). No library:
// the Web Animations API on the rows, FLIP for rows that move.
//
//   QueueLayout calls snapshot() just before it puts a reloaded list in
//   place: where every row is on screen, and which row holds the agent's
//   place (the focused row, else the open ticket's row, else, when the
//   list is scrolled or rows are selected, the first row in view).
//   TicketList calls play() in a layout effect once the new rows are in
//   the DOM, before the browser paints:
//     - the row holding the agent's place stays exactly where it was on
//       screen (the list scrolls by what was added or removed above it);
//     - a new row below that place grows from no height while it fades
//       and slides in (260 ms, ease-out), pushing the rows under it down
//       smoothly; a row that left collapses and fades out (ghosts kept
//       for the length of it by TicketList); a row that changed place
//       moves from its old spot to its new one (FLIP);
//     - a new row above the place is put in at once, out of view, and
//       counted for the "N new tickets" pill;
//     - every new row wears `hd-live-new` for 2.2 s: a soft accent
//       background that fades (globals.css).
//   With reduced motion nothing slides, grows or moves: the rows change at
//   once, the place is kept and the highlight shows, still, then goes.

import { useCallback, useMemo, useRef, useState, type RefObject } from "react";

export const ENTER_MS = 260;
export const LEAVE_MS = 220;
export const MOVE_MS = 260;
export const HIGHLIGHT_MS = 2_200;
const EASE_OUT = "cubic-bezier(0.2, 0, 0, 1)";

interface Snapshot {
  /** The list's identity (its query): a different list is never animated. */
  key: string;
  /** Each row's top on screen, by ticket number. */
  tops: Map<number, number>;
  /** The rows that may hold the agent's place, best first. */
  candidates: number[];
  /** The ticket number whose link had focus, and its index. */
  focused: number | null;
  focusedIndex: number;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const rowsOf = (ul: Element, withLeaving = false) =>
  Array.from(ul.querySelectorAll<HTMLLIElement>(withLeaving ? ":scope > li[data-number]" : ":scope > li[data-number]:not([data-leaving])"));
const numOf = (li: Element) => Number((li as HTMLElement).dataset.number);

export interface QueueMotion {
  /** Before a reload of list `key` is put in place. */
  snapshot: (key: string) => void;
  /** Whether a snapshot waits for list `key` (TicketList keeps leaving rows as ghosts only then). */
  pendingFor: (key: string) => boolean;
  /** After the rows of list `key` are in the DOM (TicketList's layout effect). */
  play: (ul: HTMLUListElement, key: string, onGhostsDone: () => void) => void;
  /** New tickets put in above the agent's place, not yet seen. */
  above: number[];
  /** Scroll to the top and show them. */
  showAbove: () => void;
  /** The list scrolled: at the top, the pill goes. */
  onScroll: () => void;
  /** A different list: forget everything. */
  reset: () => void;
}

export function useQueueMotion(scrollRef: RefObject<HTMLDivElement | null>): QueueMotion {
  const pending = useRef<Snapshot | null>(null);
  const [above, setAbove] = useState<number[]>([]);
  const aboveRef = useRef<number[]>([]);
  aboveRef.current = above;

  const snapshot = useCallback(
    (key: string) => {
      const c = scrollRef.current;
      const ul = c?.querySelector("ul");
      if (!c || !ul) {
        pending.current = null;
        return;
      }
      const box = c.getBoundingClientRect();
      const lis = rowsOf(ul);
      const tops = new Map<number, number>();
      const visible: HTMLLIElement[] = [];
      for (const li of lis) {
        const r = li.getBoundingClientRect();
        tops.set(numOf(li), r.top);
        if (r.bottom > box.top + 1 && r.top < box.bottom - 1) visible.push(li);
      }
      const active = document.activeElement;
      const focusedLi = active && ul.contains(active) ? active.closest<HTMLLIElement>("li[data-number]") : null;
      const openLi = ul.querySelector<HTMLAnchorElement>(":scope > li[data-number] > a[aria-current='page']")?.parentElement ?? null;
      const selecting = !!ul.querySelector("input[type='checkbox']:checked");
      let first: HTMLLIElement | null = null;
      if (focusedLi && visible.includes(focusedLi)) first = focusedLi;
      else if (openLi && visible.includes(openLi as HTMLLIElement)) first = openLi as HTMLLIElement;
      else if (c.scrollTop > 2 || selecting) first = visible[0] ?? null;
      const candidates: number[] = [];
      if (first) {
        const i = visible.indexOf(first);
        for (const li of [...visible.slice(i), ...visible.slice(0, i).reverse()]) candidates.push(numOf(li));
      }
      pending.current = {
        key,
        tops,
        candidates,
        focused: focusedLi ? numOf(focusedLi) : null,
        focusedIndex: focusedLi ? lis.indexOf(focusedLi) : -1,
      };
    },
    [scrollRef]
  );

  const pendingFor = useCallback((key: string) => pending.current?.key === key, []);

  const play = useCallback(
    (ul: HTMLUListElement, key: string, onGhostsDone: () => void) => {
      const snap = pending.current;
      pending.current = null;
      const c = scrollRef.current;
      if (!snap || snap.key !== key || !c) return;
      const reduced = prefersReducedMotion();
      const all = rowsOf(ul, true);
      // Our own animations from the previous update stop (the highlight, a CSS animation, runs on).
      for (const li of all) for (const a of li.getAnimations()) if (!("animationName" in a)) a.cancel();
      const live = all.filter((li) => !li.hasAttribute("data-leaving"));
      const ghosts = all.filter((li) => li.hasAttribute("data-leaving"));
      // A row that left and came straight back is the same element: undo what its leaving set.
      for (const li of live) if (li.style.display || li.style.overflow) li.style.display = li.style.overflow = "";
      const fresh = live.filter((li) => !snap.tops.has(numOf(li)));

      // The row holding the agent's place, if it is still listed.
      const anchorNum = snap.candidates.find((n) => live.some((li) => numOf(li) === n));
      const anchor = anchorNum === undefined ? null : live.find((li) => numOf(li) === anchorNum)!;
      const anchorAt = anchor ? all.indexOf(anchor) : -1;
      const moves = (li: HTMLLIElement) => !reduced && (anchorAt < 0 || all.indexOf(li) > anchorAt);

      // Rows that grow: their height first, then none, so the layout below them starts where it was.
      const grow = fresh.filter(moves);
      const heights = new Map<HTMLLIElement, number>();
      for (const li of grow) heights.set(li, li.offsetHeight);
      for (const g of ghosts) if (!moves(g)) g.style.display = "none";
      for (const li of grow) li.style.height = "0px";

      // Keep the agent's place: the anchor row back where it was on screen.
      if (anchor) {
        const shift = anchor.getBoundingClientRect().top - snap.tops.get(anchorNum!)!;
        if (Math.abs(shift) >= 1) c.scrollTop += shift;
      }

      const box = c.getBoundingClientRect();
      if (!reduced) {
        // FLIP: a row whose place changed moves from where it was.
        for (const li of live) {
          const was = snap.tops.get(numOf(li));
          if (was === undefined) continue;
          const now = li.getBoundingClientRect().top;
          const d = was - now;
          if (Math.abs(d) < 1) continue;
          const inView = (y: number) => y + li.offsetHeight > box.top && y < box.bottom;
          if (!inView(was) && !inView(now)) continue;
          li.animate([{ transform: `translateY(${d}px)` }, { transform: "translateY(0)" }], { duration: MOVE_MS, easing: EASE_OUT });
        }
        for (const li of grow) {
          const h = heights.get(li) ?? 0;
          li.style.height = "";
          li.style.overflow = "hidden";
          const a = li.animate(
            [
              { height: "0px", opacity: 0, transform: "translateY(-6px)" },
              { height: `${h}px`, opacity: 1, transform: "translateY(0)" },
            ],
            { duration: ENTER_MS, easing: EASE_OUT }
          );
          const done = () => (li.style.overflow = "");
          a.onfinish = done;
          a.oncancel = done;
        }
        const leaving = ghosts.filter(moves);
        for (const g of leaving) {
          g.style.overflow = "hidden";
          g.animate(
            [
              { height: `${g.offsetHeight}px`, opacity: 1 },
              { height: "0px", opacity: 0 },
            ],
            { duration: LEAVE_MS, easing: "ease-in", fill: "forwards" }
          );
        }
      } else {
        for (const li of grow) li.style.height = "";
      }
      if (ghosts.length) setTimeout(onGhostsDone, reduced ? 0 : LEAVE_MS + 20);

      // The highlight on every new row; the ones put in out of view above go on the pill.
      const out: number[] = [];
      for (const li of fresh) {
        li.classList.add("hd-live-new");
        setTimeout(() => li.classList.remove("hd-live-new"), HIGHLIGHT_MS);
        if (anchor && all.indexOf(li) < anchorAt && li.getBoundingClientRect().bottom <= box.top + 1) out.push(numOf(li));
      }
      const listed = new Set(live.map(numOf));
      const kept = aboveRef.current.filter((n) => listed.has(n));
      const next = [...kept, ...out.filter((n) => !kept.includes(n))];
      if (next.length !== aboveRef.current.length || next.some((n, i) => n !== aboveRef.current[i])) setAbove(next);

      // Focus that sat on a row that left goes to the row now in its place, without scrolling.
      if (snap.focused !== null && !ul.contains(document.activeElement)) {
        const same = live.find((li) => numOf(li) === snap.focused);
        const target = same ?? live[Math.min(Math.max(0, snap.focusedIndex), live.length - 1)];
        target?.querySelector<HTMLAnchorElement>("a[data-row]")?.focus({ preventScroll: true });
      }
    },
    [scrollRef]
  );

  const showAbove = useCallback(() => {
    const c = scrollRef.current;
    const ul = c?.querySelector("ul");
    const nums = aboveRef.current;
    setAbove([]);
    if (!c) return;
    c.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    if (!ul) return;
    for (const li of rowsOf(ul)) {
      if (!nums.includes(numOf(li))) continue;
      li.classList.remove("hd-live-new");
      void li.offsetWidth; // restart the fade
      li.classList.add("hd-live-new");
      setTimeout(() => li.classList.remove("hd-live-new"), HIGHLIGHT_MS);
    }
  }, [scrollRef]);

  const onScroll = useCallback(() => {
    const c = scrollRef.current;
    if (c && c.scrollTop <= 2 && aboveRef.current.length) setAbove([]);
  }, [scrollRef]);

  const reset = useCallback(() => {
    pending.current = null;
    setAbove([]);
  }, []);

  return useMemo(() => ({ snapshot, pendingFor, play, above, showAbove, onScroll, reset }), [snapshot, pendingFor, play, above, showAbove, onScroll, reset]);
}

/**
 * The rows to draw: `rows` plus the ones that just left, each kept after
 * the row it followed (or first) until its collapse is done.
 */
export function withGhosts<T extends { number: number }>(rows: T[], ghosts: { row: T; after: number | null }[]): (T & { leaving?: true })[] {
  if (!ghosts.length) return rows;
  const out: (T & { leaving?: true })[] = [...rows];
  for (const g of ghosts) {
    if (out.some((r) => r.number === g.row.number)) continue;
    const i = g.after === null ? -1 : out.findIndex((r) => r.number === g.after);
    out.splice(i + 1, 0, { ...g.row, leaving: true });
  }
  return out;
}

/** The rows of `prev` missing from `next`, each with the nearest earlier row of `prev` that stayed. */
export function leftRows<T extends { number: number }>(prev: T[], next: T[]): { row: T; after: number | null }[] {
  const stay = new Set(next.map((r) => r.number));
  const out: { row: T; after: number | null }[] = [];
  let after: number | null = null;
  for (const r of prev) {
    if (!stay.has(r.number)) out.push({ row: r, after });
    after = r.number; // a run of leaving rows keeps its order: each follows the one before
  }
  return out;
}
