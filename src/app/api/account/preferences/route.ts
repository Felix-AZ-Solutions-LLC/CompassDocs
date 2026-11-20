import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { setPageWidth, setUserPrefs } from "@/lib/db";
import type { SessionUser } from "@/lib/types";
import { secureCookie, setDarkStyleCookie } from "@/lib/auth";
import { sanitizeDarkStylePref } from "@/lib/dark-style";

export const dynamic = "force-dynamic";

const WIDTHS = ["normal", "wide", "full"] as const;
const THEMES = ["light", "dark", "system"] as const;
const SCALES = ["compact", "default", "large", "larger"] as const;
const DATE_FORMATS = ["auto", "medium", "long", "iso", "us", "eu"] as const;

function validTimezone(tz: string): boolean {
  if (tz === "") return true; // auto — follow the browser
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Personal UI preferences: page width, interface scale, theme, dark style, time zone, date format.
export async function PATCH(req: Request) {
  const gate = await apiGuard("viewer", "account.preferences_manage");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  // Every field is checked before any is saved (1.20.35): a request with one
  // bad field changes nothing, so the account and this browser's dark-style
  // cookie never disagree.
  const bad = (error: string) => NextResponse.json({ error }, { status: 400 });
  const prefs: Parameters<typeof setUserPrefs>[1] = {};
  let pageWidth: string | undefined;
  if (body?.page_width !== undefined) {
    if (!WIDTHS.includes(body.page_width)) return bad("page_width must be normal, wide, or full.");
    pageWidth = body.page_width;
  }
  if (body?.ui_scale !== undefined) {
    if (!SCALES.includes(body.ui_scale)) return bad("ui_scale must be compact, default, large, or larger.");
    prefs.ui_scale = body.ui_scale;
  }
  if (body?.theme !== undefined) {
    if (!THEMES.includes(body.theme)) return bad("theme must be light, dark, or system.");
    prefs.theme = body.theme;
  }
  // The dark style (1.20.35, lib/dark-style): saved to the account and, once
  // saved, to this browser's cookie, which the root layout reads for a
  // browser with no session.
  if (body?.dark_style !== undefined) {
    const darkStyle = sanitizeDarkStylePref(body.dark_style);
    if (!darkStyle) return bad("dark_style must be workspace, slate, graphite or black.");
    prefs.dark_style = darkStyle;
  }
  if (body?.timezone !== undefined) {
    const tz = typeof body.timezone === "string" ? body.timezone.trim().slice(0, 100) : null;
    if (tz === null || !validTimezone(tz)) return bad("Unknown time zone.");
    prefs.timezone = tz;
  }
  if (body?.single_key_shortcuts !== undefined) {
    if (typeof body.single_key_shortcuts !== "boolean") return bad("single_key_shortcuts must be true or false.");
    prefs.single_key_shortcuts = body.single_key_shortcuts;
  }
  if (body?.date_format !== undefined) {
    if (!DATE_FORMATS.includes(body.date_format)) return bad("date_format must be auto, us, iso, or eu.");
    prefs.date_format = body.date_format;
  }

  if (pageWidth !== undefined) await setPageWidth(user.id, pageWidth);
  await setUserPrefs(user.id, prefs);
  const res = NextResponse.json({ ok: true });
  if (prefs.dark_style) setDarkStyleCookie(res, prefs, await secureCookie(req));
  return res;
}
