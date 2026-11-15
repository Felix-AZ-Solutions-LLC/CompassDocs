"use client";

// 1.20.11: an emailed message, formatted, in the desk conversation. A
// message whose email had an HTML part shows that email in place of its
// text body, with no click: a frame on GET /api/helpdesk/messages/{id}/
// original?inline=1, which sanitises it on the server (the 1.20.8 sanitiser),
// folds a reply's quoted history under "Show quoted text" and serves it
// same-origin with the desk but with no script allowed (lib/helpdesk/
// email-html originalInlineHeaders says why that is safe). Same-origin is
// what lets the desk size the frame to the email: a ResizeObserver on the
// email's root, no polling, capped at 2,400 px with "Show the rest" (and
// never past 20,000 px; an email whose height follows the frame's is frozen
// and scrolls inside), so the conversation reads as one page and one giant
// email can't bury the thread.
//
// The text body stays the placeholder until the email has loaded, and the
// fallback: a refusal, a busy desk (after one retry), a slow answer or
// anything unreadable shows the text, silently, with "Shown as text" in the
// switch's tooltip. Frames load as they come near the screen (an
// IntersectionObserver, plus loading="lazy"), at most three at a time, so a
// ticket with forty emails never asks the server for them all at once.
//
// The email stays the sender's: white paper in both themes inside a quiet
// hairline edge (always visible, so the email can't pass its drawing off as
// the desk's), nothing of the desk's fonts or colours. Remote pictures stay
// hidden until "Show images", per message, never remembered.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppWindow, ChevronsDown, ImageOff, MailOpen, Type } from "lucide-react";
import { iconButtonClass } from "@/components/Button";
import { HD_INLINE_EMAIL_COPY, INLINE_EMAIL_HARD_MAX, INLINE_EMAIL_MAX_HEIGHT, originalInlineHref, type HdEmailView } from "@/lib/helpdesk/email-html-shared";
import { rememberEmailView, useEmailViewDefault } from "./email-view";

/** Frames loading at once, across the conversation. */
const MAX_LOADING = 3;
/** Past this, a frame that has not answered gives way to the text. */
const LOAD_TIMEOUT_MS = 20_000;
/** A busy desk is asked once more after this long. */
const BUSY_RETRY_MS = 1500;

let loading = 0;
const waiting: (() => void)[] = [];

/** Wait for a loading slot; the returned function gives it back (or stops waiting). Safe to call twice. */
function takeSlot(start: () => void): () => void {
  let held = false;
  let done = false;
  const go = () => {
    if (done) return;
    held = true;
    loading++;
    start();
  };
  if (loading < MAX_LOADING) go();
  else waiting.push(go);
  return () => {
    if (done) return;
    done = true;
    if (held) {
      loading--;
      waiting.shift()?.();
    } else {
      const i = waiting.indexOf(go);
      if (i >= 0) waiting.splice(i, 1);
    }
  };
}

type FrameState = "waiting" | "loading" | "ready" | "text";

interface Marked {
  remote: number;
  truncated: boolean;
}

/** One message's email: its switch, its "Open in a window" control and its body. */
export function useInlineEmail({ id, enabled, author, tinted, text, onOpenWindow }: {
  id: number;
  /** The message has an original and the viewer works the ticket. */
  enabled: boolean;
  author: string;
  /** On an internal note's amber card: the paper keeps a margin and an edge in both themes. */
  tinted: boolean;
  /** The message's text body as the card shows it. */
  text: ReactNode;
  onOpenWindow: () => void;
}): { controls: ReactNode; body: ReactNode } {
  const preferred = useEmailViewDefault();
  // The default as the message came on screen; switching it is this message's own from then on.
  const [view, setView] = useState<HdEmailView>(preferred);
  const [state, setState] = useState<FrameState>("waiting");

  const toggle = useCallback(() => {
    const next: HdEmailView = view === "formatted" && state !== "text" ? "plain" : "formatted";
    if (state === "text") setState("waiting");
    setView(next);
    rememberEmailView(next);
  }, [state, view]);

  if (!enabled) return { controls: null, body: text };

  const fellBack = view === "formatted" && state === "text";
  const plainShown = view === "plain";
  const label = plainShown || fellBack ? HD_INLINE_EMAIL_COPY.formatted : HD_INLINE_EMAIL_COPY.plainText;
  const controls = (
    <span className="-my-1 ml-auto flex items-center gap-0.5 print:hidden">
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        data-tt={fellBack ? HD_INLINE_EMAIL_COPY.shownAsText : label}
        data-testid="email-view-toggle"
        data-view={fellBack ? "text" : view}
        className={iconButtonClass("quiet", "sm")}
      >
        {plainShown || fellBack ? <MailOpen aria-hidden /> : <Type aria-hidden />}
      </button>
      <button
        type="button"
        onClick={onOpenWindow}
        aria-label={HD_INLINE_EMAIL_COPY.openWindow}
        data-tt={HD_INLINE_EMAIL_COPY.openWindow}
        data-testid="view-original"
        className={iconButtonClass("quiet", "sm")}
      >
        <AppWindow aria-hidden />
      </button>
    </span>
  );
  const body = (
    <InlineEmailBody id={id} author={author} tinted={tinted} text={text} formatted={view === "formatted"} state={state} setState={setState} />
  );
  return { controls, body };
}

function InlineEmailBody({ id, author, tinted, text, formatted, state, setState }: {
  id: number;
  author: string;
  tinted: boolean;
  text: ReactNode;
  formatted: boolean;
  state: FrameState;
  setState: (s: FrameState) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const release = useRef<(() => void) | null>(null);
  const retried = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [images, setImages] = useState(false);
  const [marked, setMarked] = useState<Marked | null>(null);
  const [height, setHeight] = useState(0);
  const [whole, setWhole] = useState(false);
  const [frozen, setFrozen] = useState(false);

  const giveBack = useCallback(() => {
    release.current?.();
    release.current = null;
  }, []);

  // Near the screen, and a slot free: load.
  useEffect(() => {
    if (!formatted || state !== "waiting") return;
    const el = holder.current;
    if (!el) return;
    let cancelled = false;
    const start = () => {
      if (cancelled) return;
      release.current = takeSlot(() => !cancelled && setState("loading"));
    };
    if (typeof IntersectionObserver === "undefined") {
      start();
      return () => {
        cancelled = true;
      };
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          start();
        }
      },
      { rootMargin: "800px 0px" }
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [formatted, state, setState]);

  // The slot goes back when the message leaves the page.
  useEffect(() => giveBack, [giveBack]);

  // A frame that never answers gives way to the text.
  useEffect(() => {
    if (state !== "loading") return;
    const t = setTimeout(() => {
      giveBack();
      setState("text");
    }, LOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [state, attempt, giveBack, setState]);

  const onLoad = useCallback(() => {
    let doc: Document | null = null;
    try {
      doc = frame.current?.contentDocument ?? null;
    } catch {
      doc = null;
    }
    const mark = doc?.querySelector('meta[name="compass-email"]') ?? null;
    if (!doc || !mark || mark.getAttribute("content") !== "ok") {
      if (state === "ready") return; // a reload for Show images that went wrong: the email shown stays
      if (mark?.getAttribute("data-reason") === "busy" && !retried.current) {
        retried.current = true;
        setTimeout(() => setAttempt((a) => a + 1), BUSY_RETRY_MS);
        return;
      }
      giveBack();
      setState("text");
      return;
    }
    giveBack();
    setMarked({ remote: Number(mark.getAttribute("data-remote-images")) || 0, truncated: mark.getAttribute("data-truncated") === "1" });
    const first = Math.ceil(doc.documentElement.getBoundingClientRect().height);
    if (first > 0) setHeight(first);
    setState("ready");
  }, [giveBack, setState, state]);

  // Ready: the frame follows the email's height (Show quoted text, pictures, a narrower pane).
  useEffect(() => {
    if (state !== "ready" || !formatted) return;
    const f = frame.current;
    let doc: Document | null = null;
    try {
      doc = f?.contentDocument ?? null;
    } catch {
      doc = null;
    }
    const root = doc?.documentElement;
    if (!f || !root) return;
    // 1.20.11 security review: an email whose height follows the frame's own (100vh plus a margin) would grow
    // without end. When it grows by the same amount right after each resize, three times running, its height is
    // frozen where it is and it scrolls inside; and nothing is ever taller than INLINE_EMAIL_HARD_MAX.
    let lastSet = 0;
    let lastDelta = -1;
    let streak = 0;
    let stopped = false;
    const scrollInside = () => root.style.setProperty("overflow-y", "auto", "important");
    const measure = () => {
      if (stopped) return;
      const content = Math.ceil(root.getBoundingClientRect().height);
      if (content <= 0) return;
      // A wide email scrolls sideways inside: its scrollbar is added, never covers the last line.
      const bar = root.scrollWidth > root.clientWidth ? Math.max(0, f.clientHeight - root.clientHeight) : 0;
      const target = content + bar;
      const shown = Math.round(f.getBoundingClientRect().height);
      if (lastSet > 0 && Math.abs(shown - lastSet) <= 1 && target > shown + 1) {
        const delta = target - shown;
        streak = Math.abs(delta - lastDelta) <= 1 ? streak + 1 : 0;
        lastDelta = delta;
        if (streak >= 2) {
          stopped = true;
          scrollInside();
          setFrozen(true);
          return;
        }
      } else {
        streak = 0;
        lastDelta = -1;
      }
      if (target > INLINE_EMAIL_HARD_MAX) scrollInside();
      lastSet = Math.min(target, INLINE_EMAIL_HARD_MAX);
      setHeight(lastSet);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [state, formatted, images, attempt]);

  const showFrame = formatted && state === "ready";
  // Once loaded the frame stays (hidden in the plain view), so switching back is instant.
  const loadingFrame = state === "loading" || state === "ready";
  const capped = !whole && height > INLINE_EMAIL_MAX_HEIGHT;
  const shownHeight = Math.min(capped ? INLINE_EMAIL_MAX_HEIGHT : height, INLINE_EMAIL_HARD_MAX);

  return (
    <div className="relative min-w-0" data-testid="inline-email" data-state={formatted ? state : "plain"} data-frozen={frozen ? "1" : undefined}>
      {/* The text: the plain view, the placeholder while the email loads, the fallback, and the desk page on paper. */}
      <div className={showFrame ? "hidden print:block" : ""} data-testid="email-text">
        {text}
      </div>
      {showFrame && marked && marked.remote > 0 && !images && (
        <p className="mb-2 flex flex-wrap items-center gap-x-1.5 text-xs text-slate-500 print:hidden" data-testid="inline-images-bar">
          <ImageOff className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
          <span>{HD_INLINE_EMAIL_COPY.imagesHidden}</span>
          <span aria-hidden>·</span>
          <button type="button" onClick={() => setImages(true)} className="font-medium text-compass-700 underline-offset-2 hover:underline">
            {HD_INLINE_EMAIL_COPY.showImages}
          </button>
        </p>
      )}
      {/* One element for the frame from first load on (moving an iframe reloads it): hidden and out of the flow while it loads. */}
      <div
        ref={holder}
        className={
          showFrame
            ? "print:hidden"
            : "pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden"
        }
        aria-hidden={showFrame ? undefined : true}
      >
        {/* The paper: literal white in both themes (STYLEGUIDE §Helpdesk: the desk, "Email shows as sent"), with a constant
            hairline edge (1.20.11 security review: nothing the email draws can pass for the desk around it). */}
        <div
          className={`relative overflow-hidden bg-white ${
            tinted ? "border-amber-200 dark:border-white/10" : "border-slate-200 dark:border-white/15"
          } rounded-lg border p-3`}
          data-testid="inline-email-paper"
        >
          {loadingFrame && (
            <iframe
              key={attempt}
              ref={frame}
              src={originalInlineHref(id, images)}
              title={HD_INLINE_EMAIL_COPY.frameTitle(author)}
              sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              loading="lazy"
              tabIndex={showFrame ? undefined : -1}
              onLoad={onLoad}
              data-testid="inline-email-frame"
              className="block w-full border-0 bg-white"
              style={{ height: showFrame && shownHeight > 0 ? shownHeight : 320 }}
            />
          )}
          {showFrame && capped && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-white/0 to-white" aria-hidden />
          )}
        </div>
        {showFrame && capped && (
          <button
            type="button"
            onClick={() => setWhole(true)}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-compass-700 hover:bg-compass-50"
            data-testid="inline-email-rest"
          >
            <ChevronsDown className="h-3.5 w-3.5" aria-hidden />
            {HD_INLINE_EMAIL_COPY.showRest}
          </button>
        )}
        {showFrame && marked?.truncated && <p className="mt-1.5 text-xs text-slate-500">{HD_INLINE_EMAIL_COPY.truncated}</p>}
      </div>
    </div>
  );
}
