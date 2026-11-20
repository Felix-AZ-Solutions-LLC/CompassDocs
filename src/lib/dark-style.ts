// Dark styles (1.20.35): which dark ramp someone sees when the page is dark.
// Slate is the ramp dark mode always had (and the default, so nothing changes
// on upgrade); Graphite is neutral grey with no blue cast; Black is a true
// black page with neutral surfaces stepping up from it.
//
// The ramps themselves live in globals.css as token override sets on
// <html data-dark-style="…">; this module only names the styles, cleans what
// a person or an admin sends, decides which one applies, and carries the few
// values the swatch previews draw (test/dark-style.test.ts checks those
// against globals.css, so the two cannot drift).
//
// Pure module: no server imports, so client components use it too.

export const DARK_STYLES = ["slate", "graphite", "black"] as const;
export type DarkStyle = (typeof DARK_STYLES)[number];

/** A person's choice: one of the styles, or whatever the workspace default is. */
export type DarkStylePref = DarkStyle | "workspace";
export const DARK_STYLE_PREFS: readonly DarkStylePref[] = ["workspace", ...DARK_STYLES];

/** The style everyone gets until someone chooses another. */
export const DEFAULT_DARK_STYLE: DarkStyle = "slate";

/** Holds the person's choice (a DarkStylePref) so the server can stamp <html> before first paint. */
export const DARK_STYLE_COOKIE = "compass-dark-style";
export const DARK_STYLE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const DARK_STYLE_LABEL: Record<DarkStyle, string> = {
  slate: "Slate",
  graphite: "Graphite",
  black: "Black",
};

export const DARK_STYLE_DESCRIPTION: Record<DarkStyle, string> = {
  slate: "Deep blue-grey, the classic dark look.",
  graphite: "Neutral greys with no blue tint.",
  black: "A true black page, for OLED screens and dim rooms.",
};

export function isDarkStyle(v: unknown): v is DarkStyle {
  return typeof v === "string" && (DARK_STYLES as readonly string[]).includes(v);
}

/** A workspace default as stored or sent: a known style, else null (the caller keeps what it had). */
export function sanitizeDarkStyle(v: unknown): DarkStyle | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return isDarkStyle(s) ? s : null;
}

/** A person's choice as stored or sent: a known style or "workspace", else null. */
export function sanitizeDarkStylePref(v: unknown): DarkStylePref | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s === "workspace") return "workspace";
  return isDarkStyle(s) ? s : null;
}

/**
 * The style that applies: the person's own choice, else the workspace
 * default, else Slate. Anything unrecognised at either step falls through
 * to the next, so a stale cookie or a hand-edited setting never paints an
 * unstyled page.
 */
export function resolveDarkStyle(personPref: unknown, workspaceDefault: unknown): DarkStyle {
  const own = sanitizeDarkStylePref(personPref);
  if (own && own !== "workspace") return own;
  return sanitizeDarkStyle(workspaceDefault) ?? DEFAULT_DARK_STYLE;
}

/**
 * Pages that follow the workspace default whoever is looking: the customer
 * portal and its help centre, the public site, share and upload links, and
 * the sign-in surfaces (first-run setup and the OAuth consent screen too). Nobody has a per-person choice there (or, signing in,
 * has not said who they are yet).
 */
const WORKSPACE_ONLY_PREFIXES = [
  "/support",
  "/public",
  "/share",
  "/upload",
  "/login",
  "/setup",
  "/oauth",
  "/account/password",
  "/account/two-step",
];

export function workspaceOnlyPath(path: string): boolean {
  const p = (path || "").split(/[?#]/)[0];
  return WORKSPACE_ONLY_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`));
}

/** The style the server stamps on <html> for a page: the root layout's one decision. */
export function darkStyleForPage(path: string, cookiePref: unknown, workspaceDefault: unknown): DarkStyle {
  return workspaceOnlyPath(path) ? resolveDarkStyle("workspace", workspaceDefault) : resolveDarkStyle(cookiePref, workspaceDefault);
}

/**
 * Each style's canvas, the colour dark-mode accent tints (compass-50 / -100)
 * blend toward (lib/theme accentCss), so a tint never carries another
 * style's blue. "R G B", as in globals.css.
 */
export const DARK_STYLE_CANVAS: Record<DarkStyle, [number, number, number]> = {
  slate: [9, 13, 22],
  graphite: [16, 16, 18],
  black: [0, 0, 0],
};

/**
 * What a swatch preview draws (Account → Preferences, Settings → Workspace):
 * the page, a card on it, the card's edge, body text and muted text. The
 * same "R G B" values as globals.css (--canvas, --surface, --slate-200,
 * --slate-900, --slate-500); test/dark-style.test.ts fails if they differ.
 */
export const DARK_STYLE_SWATCH: Record<DarkStyle, { canvas: string; surface: string; edge: string; ink: string; muted: string }> = {
  slate: { canvas: "9 13 22", surface: "19 26 40", edge: "45 56 78", ink: "237 241 247", muted: "148 161 181" },
  graphite: { canvas: "16 16 18", surface: "24 24 26", edge: "52 52 55", ink: "241 241 242", muted: "163 163 167" },
  black: { canvas: "0 0 0", surface: "13 13 14", edge: "46 46 48", ink: "242 242 243", muted: "160 160 163" },
};

/**
 * The cookie line a browser stores the choice under (client-side writes; the
 * server sets the same). Secure on an https page: a browser will not let a
 * plain cookie replace the Secure one the server set.
 */
export function darkStyleCookieString(pref: DarkStylePref, secure = false): string {
  return `${DARK_STYLE_COOKIE}=${pref}; Path=/; Max-Age=${DARK_STYLE_COOKIE_MAX_AGE}; SameSite=Lax${secure ? "; Secure" : ""}`;
}
