"use client";

// The dark style (1.20.35, lib/dark-style) on <html>, kept right after the
// first paint. The root layout stamps data-dark-style on the server, but a
// layout is not re-rendered on a client-side navigation, so each shell mounts
// this with the style it should show: the app and the desk the person's, the
// portal, the public site and sign-in pages the workspace default.
//
// With `pref` (a signed-in shell) it also keeps this browser's cookie in step
// with the account, the way UiScaleSync keeps localStorage: a choice made on
// another device, or a sign-in that did not set the cookie (single sign-on),
// is written here so the next page is server-rendered in it. Renders nothing.

import { useLayoutEffect } from "react";
import { DARK_STYLE_COOKIE, darkStyleCookieString, type DarkStyle, type DarkStylePref } from "@/lib/dark-style";

export function applyDarkStyle(style: DarkStyle) {
  if (document.documentElement.getAttribute("data-dark-style") !== style) {
    document.documentElement.setAttribute("data-dark-style", style);
  }
}

/** Write this browser's copy of the person's choice (the server writes the same on save and at sign-in). */
export function storeDarkStylePref(pref: DarkStylePref) {
  try {
    document.cookie = darkStyleCookieString(pref, location.protocol === "https:");
  } catch {
    /* cookies blocked: the account still has it, and this page already shows it */
  }
}

function cookiePref(): string | null {
  try {
    const m = document.cookie.match(new RegExp(`(?:^|; )${DARK_STYLE_COOKIE}=([^;]*)`));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * The style a signed-in shell resolved, for the desk's offline page
 * (public/desk-offline.html), which has no server to ask and whose cookie may
 * only say "workspace". Never on the portal or sign-in pages: those show the
 * workspace's, not this person's.
 */
export function rememberDarkStyle(style: DarkStyle) {
  try {
    localStorage.setItem(DARK_STYLE_COOKIE, style);
  } catch {
    /* storage blocked: the offline page falls back to the cookie, else Slate */
  }
}

export function DarkStyleSync({ style, pref }: { style: DarkStyle; pref?: DarkStylePref }) {
  useLayoutEffect(() => {
    applyDarkStyle(style);
    if (pref) {
      rememberDarkStyle(style);
      if (cookiePref() !== pref) storeDarkStylePref(pref);
    }
  }, [style, pref]);
  return null;
}
