"use client";

// 1.20.27 (STYLEGUIDE §Tables, §Settings pages): a strip that scrolls
// sideways says so. Put `edge-fade` on the scroll container and this hook's
// ref on it: while there is more to see past an edge it sets `data-fade`
// ("start" | "end" | "both"), and globals.css fades the content out over 2rem
// at that edge. Nothing is set while everything fits, so a desktop tab row or
// a table that fits its card looks exactly as before.

import { useEffect, useRef } from "react";

export function useEdgeFade<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      // A pixel of slack: zoomed layouts round scrollWidth up.
      const start = max > 1 && el.scrollLeft > 1;
      const end = max > 1 && el.scrollLeft < max - 1;
      const v = start && end ? "both" : start ? "start" : end ? "end" : "";
      if (v) el.setAttribute("data-fade", v);
      else el.removeAttribute("data-fade");
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, []);
  return ref;
}
