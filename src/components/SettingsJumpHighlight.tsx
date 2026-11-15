"use client";

// 1.20.13: a settings search result (or any link) that ends in #anchor
// lands on that setting: once the card with that id is on the page (many
// settings pages load their cards after the first paint), it is scrolled
// into view and flashed for a moment (`data-settings-flash`, globals.css:
// an accent outline that fades; a still outline with reduced motion).
// Mounted once by each settings layout (CompassDocs settings and the
// desk's). Same-page jumps (the address does not change page) come through
// the event the rail sends, since pushState fires no hashchange.

import { useEffect } from "react";
import { usePathname } from "next/navigation";

const EVENT = "compass:settings-jump";
const WAIT_MS = 30_000;
const FLASH_MS = 2400;

/** Tell the page a settings link was followed (the rail calls this). */
export function announceSettingsJump(href: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: href }));
}

export function SettingsJumpHighlight() {
  const pathname = usePathname();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop = false;

    function land(hash: string) {
      const id = decodeURIComponent(hash.replace(/^#/, ""));
      if (!id) return;
      if (timer) clearTimeout(timer);
      const started = Date.now();
      const tick = () => {
        if (stop) return;
        const el = document.getElementById(id);
        if (!el) {
          if (Date.now() - started < WAIT_MS) timer = setTimeout(tick, 150);
          return;
        }
        el.removeAttribute("data-settings-flash");
        void el.offsetWidth; // restart the animation on a second jump to the same card
        el.setAttribute("data-settings-flash", "");
        const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        el.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
        timer = setTimeout(() => el.removeAttribute("data-settings-flash"), FLASH_MS);
      };
      tick();
    }

    land(window.location.hash);
    const onHash = () => land(window.location.hash);
    const onJump = (e: Event) => {
      const href = String((e as CustomEvent<string>).detail ?? "");
      const at = href.indexOf("#");
      // Another page: the pathname change re-runs this effect, which reads the new hash.
      if (at < 0 || href.slice(0, at).split("?")[0] !== window.location.pathname) return;
      setTimeout(() => land(href.slice(at)), 0);
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener(EVENT, onJump);
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener(EVENT, onJump);
    };
  }, [pathname]);

  return null;
}
