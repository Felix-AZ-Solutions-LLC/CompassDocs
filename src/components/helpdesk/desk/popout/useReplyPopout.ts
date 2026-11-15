"use client";

// The reply pop-out's two sides (1.20.18; the plumbing and the sync model
// are in ./reply-popout):
//
//   useReplyElsewhere(n)   the ticket pane: is the reply open in another
//                          window? Pop out, show it, bring it back; hears
//                          "sent" (reload, empty composer), "closed" (the
//                          unsent reply comes back) and "busy" (still
//                          sending there). It takes a reply back only when
//                          the pop-out hands it back or is truly gone; a
//                          pop-out that has a fresh heartbeat but doesn't
//                          answer is the agent's call, never silent.
//   usePopoutOwner(n)      the pop-out window: claims the reply for ticket n
//                          with an owner token (or finds another pop-out
//                          already has it), answers pings, keeps a
//                          heartbeat, relays typing, refuses to give the
//                          reply back mid-send, goes read-only when the
//                          desk took the reply back, and closes on sign-out.

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/Toasts";
import { clearTyping, noteTyping } from "../presence/presence";
import {
  POPOUT_ANSWER_MS,
  POPOUT_BEAT_MS,
  POPOUT_DEAD_MS,
  POPOUT_STALE_MS,
  clearAlive,
  clearHandoff,
  clearSending,
  clearTaken,
  markSending,
  markTaken,
  newOwnerToken,
  openChannel,
  popoutFeatures,
  popoutPath,
  popoutWindowName,
  readAlive,
  readHandoff,
  readSending,
  stampAlive,
  stillOwner,
  wasTaken,
  type PopoutMessage,
  type PopoutMode,
} from "./reply-popout";

/** The pop-outs this tab opened, by ticket (kept across ticket switches in the desk). */
const windows = new Map<number, Window>();
/** Tickets whose pop-out (opened by this tab) was seen closed: gone for sure. */
const closedSeen = new Set<number>();

function liveWindow(n: number): Window | null {
  const w = windows.get(n);
  if (!w) return null;
  if (w.closed) {
    windows.delete(n);
    closedSeen.add(n);
    return null;
  }
  return w;
}

export const POPUP_BLOCKED = "Your browser blocked the new window. Allow pop-ups for this site, then try again.";

/**
 * Open ticket n's pop-out, or bring the open one forward. Call it inside the
 * click (or key) handler itself: browsers only allow a new window there.
 */
export function openReplyWindow(n: number): "opened" | "focused" | "blocked" {
  const open = liveWindow(n);
  if (open) {
    try {
      open.focus();
    } catch {
      /* the browser decides */
    }
    return "focused";
  }
  let w: Window | null = null;
  try {
    w = window.open(
      popoutPath(n),
      popoutWindowName(n),
      popoutFeatures({ x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight })
    );
  } catch {
    w = null;
  }
  if (!w) return "blocked";
  windows.set(n, w);
  closedSeen.delete(n);
  return "opened";
}

/** Wide enough for the composer's Pop out (phones never get one: a new window means nothing there). */
export function popoutAllowed(): boolean {
  try {
    return typeof window !== "undefined" && window.matchMedia("(min-width: 640px)").matches;
  } catch {
    return false;
  }
}

/** What the pane shows while the reply is out. */
export type ElsewhereState =
  /** Replying in another window. */
  | "out"
  /** It is sending, uploading or asking a solve question: it can't give the reply back yet. */
  | "busy"
  /** It has a fresh heartbeat but doesn't answer: the agent decides. */
  | "unanswered"
  /** It closed mid-send: the ticket is being checked before the text comes back. */
  | "checking";

export interface ReplyElsewhere {
  /** The reply is open in another window: the pane shows the quiet state, not a composer. */
  away: boolean;
  state: ElsewhereState;
  /** Taken back from a pop-out that has not let go yet: the composer reads the hand-off but leaves it. */
  pendingAck: boolean;
  /** Pop the reply out (the composer has written its hand-off). False when blocked. */
  popOut: () => boolean;
  /** Bring the pop-out to the front. */
  show: () => void;
  /** Ask the pop-out to give the reply back. */
  bringBack: () => void;
  /** "Take it back" when the pop-out doesn't answer. */
  takeBackAnyway: () => void;
  /** "Keep waiting". */
  keepWaiting: () => void;
  /** Put text in the pop-out's composer (Claude's "Use as reply") and bring it forward. */
  fill: (text: string, mode?: PopoutMode, replace?: string | null) => void;
}

export function useReplyElsewhere(
  n: number,
  u: number,
  opts: {
    onSent: (m: Extract<PopoutMessage, { type: "sent" }>) => void;
    /** Reload after the pop-out applied a macro's other changes. */
    onChanged?: () => void;
    /** The pop-out closed mid-send: did that send go through? (Then the text is not given back.) */
    checkSent?: (mode: PopoutMode) => Promise<boolean>;
  }
): ReplyElsewhere {
  const [away, setAway] = useState(false);
  const [state, setState] = useState<ElsewhereState>("out");
  const [pendingAck, setPendingAck] = useState(false);
  const chan = useRef<ReturnType<typeof openChannel> | null>(null);
  /** When a pop-out for n last said anything. */
  const heard = useRef(0);
  /** The pop-out's owner token, as last heard or read from its heartbeat. */
  const token = useRef<string | null>(null);
  const checking = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** No "isn't answering" question before this time (after Keep waiting). */
  const snooze = useRef(0);
  /** The window this tab opened was seen closed: it is gone for sure, whatever its last heartbeat says. */
  const gone = useRef(false);
  /** Signed out in this browser: write nothing more (sign-out has just cleared every desk key). */
  const signedOut = useRef(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const awayRef = useRef(away);
  awayRef.current = away;
  const pendingRef = useRef(pendingAck);
  pendingRef.current = pendingAck;

  /** Take the reply back here: record the token as taken first, then mount the composer. */
  const takeBack = useCallback(
    async (forced: boolean) => {
      if (signedOut.current) return;
      const alive = readAlive(u, n);
      const t = token.current ?? alive?.token ?? null;
      const fresh = !!alive && alive.age < POPOUT_DEAD_MS && (!t || alive.token === t);
      if (t) {
        markTaken(u, n, t);
        chan.current?.post({ type: "taken", n, u, token: t });
        clearAlive(u, n, t);
      }
      // The hand-off stays until a pop-out that may still be there lets go (ack) or is truly gone.
      setPendingAck(forced && fresh);
      const sending = readSending(u, n);
      if (sending && optsRef.current.checkSent) {
        setState("checking");
        try {
          await optsRef.current.checkSent(sending.mode);
        } catch {
          /* the ticket couldn't be checked: the text comes back, and the send's key stops a second copy */
        }
      }
      clearSending(u, n);
      clearTyping(n);
      setState("out");
      setAway(false);
    },
    [n, u]
  );

  /** Is the pop-out still there? Ask; decide when nothing answers. */
  const verify = useCallback(
    (delay = 0) => {
      if (checking.current) return;
      checking.current = setTimeout(() => {
        const asked = Date.now();
        chan.current?.post({ type: "ping", n, u });
        checking.current = setTimeout(() => {
          checking.current = null;
          if (heard.current >= asked || !awayRef.current) return;
          if (windows.get(n)?.closed || closedSeen.has(n)) gone.current = true;
          const alive = readAlive(u, n);
          const fresh = alive && alive.age < POPOUT_DEAD_MS && !wasTaken(u, n, alive.token);
          if (!gone.current && (fresh || liveWindow(n))) {
            // The window is still open, or its heartbeat is recent, but it doesn't answer: never taken silently.
            if (Date.now() >= snooze.current) setState("unanswered");
            return;
          }
          void takeBack(false);
        }, POPOUT_ANSWER_MS);
      }, delay);
    },
    [n, u, takeBack]
  );

  useEffect(() => {
    heard.current = 0;
    snooze.current = 0;
    gone.current = false;
    setState("out");
    setPendingAck(false);
    const alive = readAlive(u, n);
    const out = liveWindow(n) !== null || (!!alive && alive.age < POPOUT_STALE_MS && !wasTaken(u, n, alive.token));
    token.current = alive?.token ?? null;
    setAway(out);
    const ch = openChannel((m) => {
      if (m.type === "signout") {
        signedOut.current = true;
        return;
      }
      if (m.n !== n || m.u !== u) return;
      if (m.type === "open" || m.type === "here") {
        if (wasTaken(u, n, m.token)) return;
        heard.current = Date.now();
        token.current = m.token;
        gone.current = false;
        if (!liveWindow(n)) closedSeen.delete(n);
        setAway(true);
        setState((s) => (s === "unanswered" ? "out" : s));
      } else if (m.type === "typing") {
        heard.current = Date.now();
        // Typing in the pop-out keeps this tab's heartbeat "replying" too, so the two never disagree.
        noteTyping(n);
      } else if (m.type === "busy") {
        heard.current = Date.now();
        setState("busy");
      } else if (m.type === "sent") {
        heard.current = 0;
        windows.delete(n);
        clearTyping(n);
        clearSending(u, n);
        setState("out");
        setAway(false);
        optsRef.current.onSent(m);
      } else if (m.type === "changed") {
        optsRef.current.onChanged?.();
      } else if (m.type === "closed" && awayRef.current) {
        // A reload says "closed" and then "open" again: wait a moment before taking the reply back.
        verify(800);
      } else if (m.type === "ack" && pendingRef.current && m.token === token.current) {
        clearHandoff(u, n);
        clearTaken(u, n);
        setPendingAck(false);
      }
    });
    chan.current = ch;
    ch.post({ type: "ping", n, u });
    const t = setInterval(() => {
      if (signedOut.current) return;
      if (pendingRef.current) {
        // Taken back from a silent pop-out: the hand-off goes once its heartbeat is truly gone.
        const a = readAlive(u, n);
        if (!a || a.age > POPOUT_DEAD_MS) {
          clearHandoff(u, n);
          setPendingAck(false);
        }
      }
      if (!awayRef.current) return;
      const w = windows.get(n);
      if (w && w.closed) {
        windows.delete(n);
        gone.current = true;
        verify();
        return;
      }
      if (w) return;
      const a = readAlive(u, n);
      if (!a || a.age > POPOUT_STALE_MS) verify();
    }, 3_000);
    return () => {
      clearInterval(t);
      if (checking.current) clearTimeout(checking.current);
      checking.current = null;
      ch.close();
      chan.current = null;
    };
  }, [n, u, verify]);

  // "Still sending" fades back to the plain line once the pop-out has had time to finish.
  useEffect(() => {
    if (state !== "busy") return;
    const t = setTimeout(() => setState((s) => (s === "busy" ? "out" : s)), 6_000);
    return () => clearTimeout(t);
  }, [state]);

  const popOut = useCallback(() => {
    const r = openReplyWindow(n);
    if (r === "blocked") {
      clearHandoff(u, n);
      toast("error", POPUP_BLOCKED);
      return false;
    }
    heard.current = Date.now();
    gone.current = false;
    setState("out");
    setPendingAck(false);
    setAway(true);
    return true;
  }, [n, u]);

  const show = useCallback(() => {
    const w = liveWindow(n);
    if (w) {
      try {
        w.focus();
      } catch {
        /* the browser decides */
      }
    } else chan.current?.post({ type: "focus", n, u });
  }, [n, u]);

  const bringBack = useCallback(() => {
    // The pop-out saves and closes itself, or answers "busy" while a send is on its way. It is never
    // closed from here: a send cut off mid-way is how a reply went out twice.
    chan.current?.post({ type: "bring-back", n, u });
    verify(1_200);
  }, [n, u, verify]);

  const takeBackAnyway = useCallback(() => void takeBack(true), [takeBack]);
  const keepWaiting = useCallback(() => {
    snooze.current = Date.now() + 30_000;
    setState("out");
  }, []);

  const fill = useCallback(
    (text: string, mode: PopoutMode = "public", replace: string | null = null) => {
      chan.current?.post({ type: "fill", n, u, text, mode, replace });
      show();
    },
    [n, u, show]
  );

  return { away, state, pendingAck, popOut, show, bringBack, takeBackAnyway, keepWaiting, fill };
}

/** The desk window's toast for a reply sent from a pop-out (any ticket of this agent). */
export function useReplyPopoutToasts(u: number, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const ch = openChannel((m) => {
      if (m.type !== "sent" || m.u !== u) return;
      const what = m.kind === "internal" ? "Note added" : m.kind === "review" ? "Sent for review" : "Reply sent";
      toast("ok", `${what} on #${m.n}.`);
      if (m.warning) toast("error", `Sent, but the status didn't change. ${m.warning}`);
    });
    return () => ch.close();
  }, [u, enabled]);
}

export type OwnerState =
  /** Checking whether another pop-out already has this reply. */
  | "checking"
  /** This window has the reply. */
  | "owner"
  /** Another pop-out has it. */
  | "duplicate"
  /** The desk took it back. */
  | "taken"
  /** Someone signed out in this browser. */
  | "signedout";

export interface PopoutOwner {
  state: OwnerState;
  /** The agent typed (throttled relay to the desk window). */
  typing: () => void;
  /** Sent: tell the desk, stop the heartbeat; nothing is handed back. */
  sent: (kind: "public" | "internal" | "review", warning?: string) => void;
  /** A macro's other changes were applied after the send: the desk reloads. */
  changed: () => void;
  /** Before a send: does this window still own the reply? (Not: it goes read-only.) */
  checkOwner: () => boolean;
}

/**
 * The pop-out window's side. `save` writes the composer's hand-off record (the text is
 * already in its draft); `busy` says whether a send, an upload or a solve question is in
 * progress; `onFill` takes text the desk forwards.
 */
export function usePopoutOwner(
  n: number,
  u: number,
  hooks: { save: () => void; busy: () => boolean; onFill: (text: string, mode: PopoutMode, replace: string | null) => void }
): PopoutOwner {
  const [state, setState] = useState<OwnerState>("checking");
  const claimed = useRef(false);
  const mine = useRef<string | null>(null);
  const dup = useRef(false);
  const done = useRef(false);
  const lastTyping = useRef(0);
  const chan = useRef<ReturnType<typeof openChannel> | null>(null);
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;
  const beat = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopBeat = () => {
    if (beat.current) clearInterval(beat.current);
    beat.current = null;
  };

  /** The desk took the reply back: stop, let go, read-only. */
  const giveUp = useCallback(() => {
    if (!claimed.current) return;
    claimed.current = false;
    stopBeat();
    const t = mine.current;
    if (t) chan.current?.post({ type: "ack", n, u, token: t });
    setState("taken");
  }, [n, u]);

  const checkOwner = useCallback(() => {
    if (!claimed.current || !mine.current) return false;
    if (stillOwner(u, n, mine.current)) return true;
    giveUp();
    return false;
  }, [n, u, giveUp]);

  useEffect(() => {
    claimed.current = false;
    dup.current = false;
    done.current = false;
    mine.current = null;
    setState("checking");
    /** On the way out (closed, reloaded, brought back): hand the reply back unless it was sent or taken. */
    const leave = () => {
      if (!claimed.current) return;
      const t = mine.current!;
      if (!done.current && stillOwner(u, n, t)) {
        // Closed mid-send: the desk checks the ticket before giving the text back (and the send's key stops a second copy).
        if (hooksRef.current.busy()) markSending(u, n, readHandoff(u, n)?.mode ?? "public");
        hooksRef.current.save();
        ch.post({ type: "closed", n, u });
      }
      clearAlive(u, n, t);
      claimed.current = false;
      stopBeat();
    };
    const ch = openChannel((m) => {
      if (m.type === "signout") {
        claimed.current = false;
        stopBeat();
        setState("signedout");
        try {
          window.close();
        } catch {
          /* the refusal shows */
        }
        return;
      }
      if (m.n !== n || m.u !== u) return;
      if (m.type === "ping" && claimed.current && mine.current) ch.post({ type: "here", n, u, token: mine.current });
      else if ((m.type === "here" || m.type === "open") && !claimed.current && m.token !== mine.current) {
        if (wasTaken(u, n, m.token)) return;
        dup.current = true;
        setState("duplicate");
      } else if (m.type === "taken" && m.token === mine.current) giveUp();
      else if (m.type === "focus" && claimed.current) {
        try {
          window.focus();
        } catch {
          /* the browser decides */
        }
      } else if (m.type === "fill" && claimed.current) {
        hooksRef.current.onFill(m.text, m.mode, m.replace);
        try {
          window.focus();
        } catch {
          /* the browser decides */
        }
      } else if (m.type === "bring-back" && claimed.current) {
        // Already taken back (this window was asleep): read-only, nothing to hand back.
        if (mine.current && !stillOwner(u, n, mine.current)) return giveUp();
        // Never mid-send: the desk would get the text back while the reply is on its way.
        if (hooksRef.current.busy()) ch.post({ type: "busy", n, u });
        else {
          leave();
          window.close();
        }
      }
    });
    chan.current = ch;
    ch.post({ type: "ping", n, u });
    // Nobody answered: this window has the reply, under a token of its own.
    const claim = setTimeout(() => {
      if (dup.current) return;
      const t = newOwnerToken();
      mine.current = t;
      claimed.current = true;
      stampAlive(u, n, t);
      beat.current = setInterval(() => {
        if (!claimed.current) return;
        if (!stillOwner(u, n, t)) return giveUp();
        stampAlive(u, n, t);
      }, POPOUT_BEAT_MS);
      ch.post({ type: "open", n, u, token: t });
      setState("owner");
    }, 400);
    // Back from the background (a hidden window's timers barely run): still the owner?
    const recheck = () => {
      if (claimed.current && mine.current && !stillOwner(u, n, mine.current)) giveUp();
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", recheck);
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      clearTimeout(claim);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", recheck);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
      leave();
      ch.close();
      chan.current = null;
    };
  }, [n, u, giveUp]);

  const typing = useCallback(() => {
    const now = Date.now();
    if (now - lastTyping.current < 3_000) return;
    lastTyping.current = now;
    chan.current?.post({ type: "typing", n, u });
  }, [n, u]);

  const sent = useCallback(
    (kind: "public" | "internal" | "review", warning?: string) => {
      done.current = true;
      if (mine.current) clearAlive(u, n, mine.current);
      claimed.current = false;
      stopBeat();
      chan.current?.post(warning ? { type: "sent", n, u, kind, warning } : { type: "sent", n, u, kind });
    },
    [n, u]
  );

  const changed = useCallback(() => chan.current?.post({ type: "changed", n, u }), [n, u]);

  return { state, typing, sent, changed, checkOwner };
}
