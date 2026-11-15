"use client";

// 1.20.20 (review): this browser tab's id for the reply lock and presence. A
// lock is released only by the tab that holds it, and a presence row ends only
// when the last of an agent's tabs leaves the ticket, so closing one tab never
// drops what another tab of the same agent is doing.
//
// The pop-out (1.20.18): the pane mints an id for the new window with
// newDeskTabId(), calls handOffReplyLock(n, thatId) (reply-lock.ts) before
// the window opens and puts both ids in the pop-out's hand-off record (never
// the address); the window calls adoptDeskTabId(thatId, paneId) before its
// composer mounts, and hands the lock back to paneId when it closes unsent.

let current: string | null = null;
/** In a reply pop-out: the desk tab it came from (the lock goes back there when it closes unsent). */
let home: string | null = null;

/** A fresh tab id: letters, digits and dashes, as the server accepts. */
export function newDeskTabId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
}

/** This tab's id (made once per page load). */
export function deskTabId(): string {
  if (!current) current = newDeskTabId();
  return current;
}

const OK = /^[A-Za-z0-9_-]{6,64}$/;

/** The pop-out window takes the id the pane handed its lock to, and remembers the pane's (`homeId`) to hand it back. */
export function adoptDeskTabId(id: string, homeId?: string | null): void {
  if (OK.test(id)) current = id;
  home = homeId && OK.test(homeId) ? homeId : null;
}

/** The desk tab this pop-out came from, or null (not a pop-out). */
export function homeTabId(): string | null {
  return home;
}
