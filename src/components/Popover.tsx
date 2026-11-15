"use client";

// The one floating panel (STYLEGUIDE §Overlays and modals): a menu, a
// column picker, a QR card, the notifications dropdown. Anchored to its
// trigger (the parent is `relative`), the floating elevation tier, closes
// on outside click and on Escape through the overlay stack (so a palette
// opened on top owns Escape, and one keypress never closes two layers),
// and hands focus back to the trigger. The caller renders the trigger and
// owns `open`; the trigger should carry aria-expanded and aria-haspopup.
//
//   <div className="relative">
//     <button ref={btn} aria-expanded={open} aria-haspopup="menu" onClick=…>Export</button>
//     <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} role="menu" label="Export" align="end" width="w-64">
//       …
//     </Popover>
//   </div>

import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { pushOverlay, bindEscapeDispatcher } from "@/lib/overlay-stack";
import { visibleBox } from "./TooltipPlacer";

/** How close to a clipping edge a panel may sit. */
const EDGE = 4;
/** The inline styles placePanel may set (cleared before each placing). */
const PLACED = ["translate", "max-width", "max-height", "overflow-y", "position", "top", "bottom", "left", "right", "margin-top", "margin-bottom"];

/**
 * Where an open panel goes (1.20.12). It always shows whole and next to its trigger:
 *
 *  - Anchored (the documented case: the parent is `relative`): it hangs from the parent as its
 *    classes say. If it would run past the bottom (or top) of what clips it (a scrolling pane, the
 *    viewport) it opens on the other side when there is more room there; one that crosses a side
 *    edge slides back inside, as a data-tt bubble does (TooltipPlacer), never wider than the box.
 *  - Floating: when the parent is not positioned (a row's actions in a table), or the anchored
 *    panel cannot show whole inside what clips it (a short table's sideways-scroll wrapper), it
 *    becomes position: fixed at its trigger, flipped or capped (scrolling inside) to fit the
 *    viewport, and follows the trigger while anything scrolls. Before, such a panel hung from a
 *    far ancestor; in the desk that was the page, which then scrolled to show it.
 *
 * Returns the cleanup for the floating case.
 */
function placePanel(el: HTMLElement, trigger: HTMLElement | null, align: "start" | "end", side: "bottom" | "top"): (() => void) | undefined {
  const anchor = el.parentElement;
  if (!anchor) return;
  for (const p of PLACED) el.style.removeProperty(p);
  const gap = parseFloat(getComputedStyle(el)[side === "top" ? "marginBottom" : "marginTop"]) || 4;
  if (el.offsetParent === anchor && placeAnchored(el, anchor, side, gap)) return;
  for (const p of PLACED) el.style.removeProperty(p);
  const at = trigger && anchor.contains(trigger) ? trigger : anchor;
  const place = () => placeFloating(el, at, align, side, gap);
  place();
  let raf = 0;
  const again = (e: Event) => {
    if (e.target instanceof Node && el.contains(e.target)) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(place);
  };
  window.addEventListener("scroll", again, true);
  window.addEventListener("resize", again);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("scroll", again, true);
    window.removeEventListener("resize", again);
    for (const p of PLACED) el.style.removeProperty(p);
  };
}

/** Anchored placing; false when the panel cannot show whole inside what clips it. */
function placeAnchored(el: HTMLElement, anchor: HTMLElement, side: "bottom" | "top", gap: number): boolean {
  const box = visibleBox(anchor);
  // Sideways: never wider than the box, slid back inside it.
  const room = box.right - box.left - 2 * EDGE;
  let r = el.getBoundingClientRect();
  if (room > 0 && r.width > room) {
    el.style.maxWidth = `${Math.floor(room)}px`;
    r = el.getBoundingClientRect();
  }
  let shift = 0;
  if (r.right > box.right - EDGE) shift = box.right - EDGE - r.right;
  if (r.left + shift < box.left + EDGE) shift = box.left + EDGE - r.left;
  if (Math.abs(shift) >= 1) {
    // On top of any translate the caller's classes give it (a centred panel's -translate-x-1/2).
    const given = getComputedStyle(el).translate;
    const [x = "0px", ...rest] = given === "none" ? [] : given.split(" ");
    el.style.translate = [`calc(${x} + ${Math.round(shift)}px)`, ...(rest.length ? rest : ["0px"])].join(" ");
  }
  // Up and down: the side it was asked for, else the other one if it fits there.
  const a = anchor.getBoundingClientRect();
  const below = box.bottom - EDGE - a.bottom - gap;
  const above = a.top - gap - (box.top + EDGE);
  const h = r.height;
  if (h <= (side === "top" ? above : below)) return true;
  if (h > (side === "top" ? below : above)) return false;
  if (side === "top") {
    el.style.bottom = "auto";
    el.style.top = "100%";
    el.style.marginBottom = "0px";
    el.style.marginTop = `${gap}px`;
  } else {
    el.style.top = "auto";
    el.style.bottom = "100%";
    el.style.marginTop = "0px";
    el.style.marginBottom = `${gap}px`;
  }
  return true;
}

/** Floating placing: fixed at the trigger, inside the viewport. */
function placeFloating(el: HTMLElement, at: HTMLElement, align: "start" | "end", side: "bottom" | "top", gap: number) {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  Object.assign(el.style, { position: "fixed", right: "auto", bottom: "auto", marginTop: "0px", marginBottom: "0px", translate: "none" });
  el.style.removeProperty("max-height");
  el.style.removeProperty("overflow-y");
  if (el.offsetWidth > vw - 2 * EDGE) el.style.maxWidth = `${vw - 2 * EDGE}px`;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const a = at.getBoundingClientRect();
  const left = Math.min(Math.max(align === "end" ? a.right - w : a.left, EDGE), vw - EDGE - w);
  const below = vh - EDGE - a.bottom - gap;
  const above = a.top - gap - EDGE;
  let down = side === "bottom";
  if (down && h > below && above > below) down = false;
  else if (!down && h > above && below > above) down = true;
  const room = Math.max(down ? below : above, 48);
  if (h > room) {
    el.style.maxHeight = `${Math.floor(room)}px`;
    el.style.overflowY = "auto";
  }
  const top = down ? a.bottom + gap : a.top - gap - Math.min(h, room);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  // A transformed or filtered ancestor makes itself the fixed box: measure and correct.
  const r = el.getBoundingClientRect();
  const dx = left - r.left;
  const dy = top - r.top;
  if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
    el.style.left = `${Math.round(left + dx)}px`;
    el.style.top = `${Math.round(top + dy)}px`;
  }
}

/**
 * The items arrows walk in a role="menu" panel: plain actions and the
 * single-choice rows of a picker menu (FindModeMenu), skipping disabled ones.
 */
const MENU_ITEMS = ['[role="menuitem"]', '[role="menuitemradio"]', '[role="menuitemcheckbox"]']
  .map((r) => `${r}:not([disabled])`)
  .join(", ");

export function Popover({
  open,
  onClose,
  triggerRef,
  role = "dialog",
  label,
  align = "start",
  side = "bottom",
  width = "w-64",
  padding = "p-1",
  className = "",
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** The control that opened it; focus returns here on Escape. */
  triggerRef?: RefObject<HTMLElement | null>;
  role?: "dialog" | "menu" | "listbox" | "group";
  /** The accessible name of the panel. */
  label: string;
  /** Which edge of the trigger the panel hangs from. */
  align?: "start" | "end";
  side?: "bottom" | "top";
  width?: string;
  padding?: string;
  className?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  // 1.20.12: the panel is placed once it is open, before a menu moves focus into it (so focus
  // never scrolls a pane): see placePanel below.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    return placePanel(el, triggerRef?.current ?? null, align, side);
  }, [open, align, side, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const unbind = bindEscapeDispatcher();
    const pop = pushOverlay(() => {
      onClose();
      triggerRef?.current?.focus();
    });
    function onPointer(e: MouseEvent) {
      const t = e.target as Node;
      if (panel.current?.contains(t)) return;
      if (triggerRef?.current?.contains(t)) return;
      // A toast's action (Undo after "Stop requiring" in the shield popover)
      // answers something the panel just did: it is not a click away from it.
      if (t instanceof Element && t.closest('[role="status"]')) return;
      onClose();
    }
    document.addEventListener("mousedown", onPointer);
    // A real menu: focus moves into it on open and arrows walk the items.
    // A picker menu (menuitemradio) opens on its checked choice, as a
    // listbox opens on its selection; any other menu on its first item.
    let raf = 0;
    if (role === "menu") {
      raf = requestAnimationFrame(() => {
        const items = panel.current?.querySelectorAll<HTMLElement>(MENU_ITEMS);
        const checked = Array.from(items ?? []).find((el) => el.getAttribute("aria-checked") === "true");
        (checked ?? items?.[0])?.focus();
      });
    }
    return () => {
      document.removeEventListener("mousedown", onPointer);
      if (raf) cancelAnimationFrame(raf);
      pop();
      unbind();
    };
  }, [open, onClose, triggerRef, role]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (role !== "menu" || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(MENU_ITEMS));
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = i < 0 || i === items.length - 1 ? 0 : i + 1;
    else if (e.key === "ArrowUp") next = i <= 0 ? items.length - 1 : i - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Tab") {
      // Tab leaves the menu: close it and let focus continue naturally.
      onClose();
      return;
    }
    if (next === null) return;
    e.preventDefault();
    items[next].focus();
  }

  if (!open) return null;
  const pos = `${side === "top" ? "bottom-full mb-1" : "top-full mt-1"} ${align === "end" ? "right-0" : "left-0"}`;
  return (
    <div
      ref={panel}
      role={role}
      aria-label={label}
      onKeyDown={onKeyDown}
      className={`absolute z-30 ${pos} ${width} ${padding} rounded-lg border border-slate-200 bg-surface shadow-float ${className}`.trim()}
    >
      {children}
    </div>
  );
}

/** A menu row inside a Popover with role="menu". */
export function MenuItem({
  children,
  icon,
  danger = false,
  className = "",
  ...rest
}: {
  children: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  className?: string;
} & Omit<React.ComponentProps<"button">, "children" | "className">) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm disabled:opacity-50 ${
        danger ? "text-red-600 hover-danger" : "text-slate-700 hover:bg-slate-50"
      } ${className}`.trim()}
      {...rest}
    >
      {icon && (
        <span className="shrink-0 text-slate-400 [&>svg]:h-4 [&>svg]:w-4" aria-hidden>
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

/** A hairline between menu groups. */
export function MenuSeparator() {
  return <div role="separator" className="my-1 border-t border-slate-100" />;
}
