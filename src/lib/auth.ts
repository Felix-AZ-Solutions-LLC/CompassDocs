import { createHash } from "node:crypto";
import { isCloud, PLAN_SECTION, sectionHiddenInMode } from "./cloud";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { loginHref } from "./return-to";
import {
  signInCandidates,
  getAllSettings,
  getSessionUser,
  createSession,
  deleteSession,
  touchSession,
  markLogin,
  consumeRecoveryCode,
  recordTotpStep,
  rehashUserPassword,
  sessionDarkStyle,
} from "./db";
import type { NextResponse } from "next/server";
import { verifyTotpStep } from "./totp";
import { openSecret } from "./secretbox";
import { verifyPassword, verifyNothing, newToken, needsRehash, hashPassword } from "./password";
import { signInSecurityFrom, twoStepCovers, type SignInSecurity } from "./sign-in-security";
import type { PendingStep } from "./sign-in-security-shared";
import { getSessionTimeoutMinutes, getSecureCookieMode, sessionTimeoutFrom } from "./settings-store";
import { DUO_NOTHING_OWED, DUO_NO_STANDING, duoStepHref, duoSwitchedOn, isDeskPath, type DuoStanding, type DuoVerdict } from "./duo-policy";
import { SESSION_TIMEOUT_MAX } from "./settings";
import { DARK_STYLE_COOKIE, DARK_STYLE_COOKIE_MAX_AGE, sanitizeDarkStylePref } from "./dark-style";
import { roleAtLeast } from "./types";
import type { Role, SessionUser, User } from "./types";

export const SESSION_COOKIE = "compass_session";

// The DB `expires_at` is the real idle-timeout enforcement (slid forward on each
// request). The cookie's max-age is only an outer safety cap so a long-dormant
// cookie can't linger forever in the browser.
export const SESSION_MAX_AGE = SESSION_TIMEOUT_MAX * 60;

// Don't rewrite `expires_at` on literally every request — only once the sliding
// window has advanced by at least this much (keeps it to ~1 write/min/session).
const TOUCH_THROTTLE_MS = 60_000;

export function cookieOptions(maxAgeSeconds: number, secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

// --- The dark-style cookie (1.20.35, lib/dark-style) ------------------------
// One place writes it. It carries a person's choice (workspace | slate |
// graphite | black) so a page this browser opens is rendered in it; it is a
// display preference, not a credential, so it is readable by the page
// (DarkStyleSync keeps it in step with the account). Set at every sign-in
// that opens a session (password, setup, and single sign-on through
// darkStyleSetCookieHeader), cleared at sign-out so the next person on a
// shared browser never inherits it. While a session exists the root layout
// reads the account itself (requestDarkStylePref), so the cookie only ever
// decides for a browser with no session.

function darkStyleCookieAttrs(secure: boolean, maxAge: number) {
  return { path: "/", sameSite: "lax" as const, secure, maxAge, httpOnly: false };
}

/** Write the account's dark style to the response's cookie (a sign-in, or a saved preference). */
export function setDarkStyleCookie(res: NextResponse, user: { dark_style?: string | null }, secure: boolean): void {
  res.cookies.set(DARK_STYLE_COOKIE, sanitizeDarkStylePref(user.dark_style) ?? "workspace", darkStyleCookieAttrs(secure, DARK_STYLE_COOKIE_MAX_AGE));
}

/** Remove it (sign-out). */
export function clearDarkStyleCookie(res: NextResponse, secure: boolean): void {
  res.cookies.set(DARK_STYLE_COOKIE, "", darkStyleCookieAttrs(secure, 0));
}

/** The same cookie as one Set-Cookie line, for a response that writes its headers itself (the enterprise single sign-on callbacks). */
export function darkStyleSetCookieHeader(user: { dark_style?: string | null }, secure: boolean): string {
  const pref = sanitizeDarkStylePref(user.dark_style) ?? "workspace";
  return `${DARK_STYLE_COOKIE}=${pref}; Path=/; Max-Age=${DARK_STYLE_COOKIE_MAX_AGE}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/**
 * The person's dark style choice for this request: the signed-in account's
 * own (one read, only when a session cookie is present), else this
 * browser's cookie. Takes the values the caller already read from the
 * cookie jar, so a page that must not touch request data in a try block
 * (the root layout) can call it there. A database error falls back to the
 * cookie.
 */
export async function requestDarkStylePref(sessionToken: string | undefined, cookiePref: string | undefined): Promise<string | undefined> {
  if (sessionToken) {
    try {
      const own = await sessionDarkStyle(sessionToken);
      if (own) return own;
    } catch {
      /* no database: the cookie decides */
    }
  }
  return cookiePref;
}

/** True if the incoming request reached us over HTTPS (honoring a proxy). */
function requestIsHttps(req: Request): boolean {
  const xfproto = req.headers.get("x-forwarded-proto");
  if (xfproto) return xfproto.split(",")[0].trim().toLowerCase() === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Whether the session cookie should be marked `Secure` for THIS request. Driven
 * by the `secure_cookies` setting: `always` → true, `never` → false, `auto` →
 * match the request protocol (so plain-HTTP installs work with no config, and
 * HTTPS installs get Secure cookies). `COMPASSDOCS_INSECURE_COOKIES=1` forces
 * insecure in `auto` mode (config-as-code back-compat).
 */
export async function secureCookie(req: Request): Promise<boolean> {
  // 1.21.0: a CompassDocs Cloud workspace is only ever served over HTTPS
  // (the platform's ingress), and the setting lives on the hidden Domain &
  // HTTPS page, so the cookie is always Secure there.
  if (isCloud()) return true;
  const mode = await getSecureCookieMode();
  if (mode === "always") return true;
  if (mode === "never") return false;
  if (process.env.COMPASSDOCS_INSECURE_COOKIES === "1") return false;
  return requestIsHttps(req);
}

export function toSessionUser(u: User): SessionUser {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    email: u.email,
    role: u.role,
    must_change_password: u.must_change_password === 1,
    page_width: u.page_width === "normal" || u.page_width === "full" ? u.page_width : "wide",
    ui_scale: (["compact", "large", "larger"] as const).includes(u.ui_scale as never)
      ? (u.ui_scale as "compact" | "large" | "larger")
      : "default",
    single_key_shortcuts: u.single_key_shortcuts !== false,
    newsletter_role:
      u.newsletter_role === "contributor" || u.newsletter_role === "approver"
        ? u.newsletter_role
        : "none",
    theme: u.theme === "light" || u.theme === "dark" ? u.theme : "system",
    dark_style: sanitizeDarkStylePref(u.dark_style) ?? "workspace",
    timezone: u.timezone ?? "",
    date_format: (["medium", "long", "iso", "us", "eu"] as const).includes(u.date_format as never)
      ? (u.date_format as "medium" | "long" | "iso" | "us" | "eu")
      : "auto",
    avatar: u.avatar ?? "",
  };
}

/** The session behind the cookie (1.20.5): its user, and what it still owes the Duo check. */
export interface CurrentSession {
  user: SessionUser;
  /** The cookie's token, for the Duo step's own routes. */
  token: string;
  /** lib/duo-policy: `signIn` true means this session may not use CompassDocs yet, `desk` true that it may not use the desk yet. */
  duo: DuoVerdict;
  /**
   * 1.20.27: a step the session owes before it may use anything else: a new
   * password (must_change_password, security review M2) or two-step
   * sign-in set up ("Require two-step sign-in", H3). Null when nothing is.
   */
  pending: PendingStep | null;
}

/**
 * The step a session owes (1.20.27), or null. A forced password change
 * comes first. "Require two-step sign-in" covers sessions opened with a
 * password only (single sign-on brings its own second factor; a session
 * opened before 1.20.27 records no method and is asked at its next
 * sign-in), and only accounts without an authenticator set up.
 *
 * Duo counts as the second factor (second review M6): a session Duo
 * approved (sessions.mfa_at, method "duo") owes nothing, and one that still
 * owes its sign-in Duo approval is sent to Duo, not to the authenticator
 * set-up (currentSession). A session let in because Duo could not be
 * reached ("duo_unreachable") had no second factor and is asked.
 *
 * A session opened through the break-glass door (a password while SSO
 * only is on, Settings → Single sign-on) by an account with no
 * authenticator ("break_glass") must set one up first, whatever the
 * two-step rule says (second review, Low: the owner's "ideally requiring
 * TOTP"); lib/sign-in-security twoStepRequiredFor keeps it from being
 * turned off again.
 */
async function pendingStep(
  session: {
    id: number;
    role: Role;
    must_change_password: number;
    totp_enabled: number;
    session_auth_method: string | null;
    mfa_at?: string | null;
    mfa_method?: string | null;
  },
  sec: SignInSecurity
): Promise<PendingStep | null> {
  if (session.must_change_password === 1) return "password_change";
  if (session.totp_enabled === 1) return null;
  // Signed in through the break-glass door with no authenticator: one first, whatever the rule.
  if (session.session_auth_method === "break_glass") return "two_step";
  if (session.session_auth_method !== "password" && session.session_auth_method !== "setup") return null;
  if (session.mfa_at && session.mfa_method === "duo") return null;
  if (sec.twoStep === "off") return null;
  return (await twoStepCovers(sec.twoStep, session)) ? "two_step" : null;
}

/** Where a session that owes `step` is sent, coming back to `next` afterwards. */
export function pendingStepHref(step: PendingStep, next: string): string {
  const base = step === "password_change" ? "/account/password" : "/account/two-step";
  const back = next && next !== "/" && !next.startsWith(base) ? `?next=${encodeURIComponent(next)}` : "";
  return `${base}${back}`;
}

/**
 * The session behind the cookie, or null if there is none. Every session
 * check starts here. Since 1.20.5 it also says whether the session still
 * owes a Duo approval (lib/duo-policy), decided from the settings map and the
 * session row this function reads anyway: with no Duo rule switched on the
 * answer is "nothing owed" after two map lookups, with no further query.
 *
 * Almost nothing should call this directly: getCurrentUser, requireUser and
 * lib/api-auth apiSession apply the verdict. The exceptions are the Duo
 * step's own page and routes, which must see a session that has not passed
 * yet.
 */
export async function currentSession(): Promise<CurrentSession | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await getSessionUser(token);
  if (!session) return null;
  // 1.21.4: a CompassDocs support session (lib/support) is checked on its own terms.
  if (session.support_session_id) return supportSession(session, token);

  // One settings read serves the idle timeout, the absolute lifetime, the
  // two-step rule and the Duo rules.
  const settings = await getAllSettings();
  const sec = signInSecurityFrom(settings);
  // 1.20.27 (security review M8): an absolute lifetime from the session's
  // creation, whatever its activity (a polling desk tab never keeps one
  // alive past it). The idle timeout below slides within it.
  const created = new Date(session.session_created_at).getTime();
  const lifetimeEnd = Number.isNaN(created) ? Infinity : created + sec.sessionMaxDays * 86_400_000;
  if (Date.now() >= lifetimeEnd) {
    await deleteSession(token);
    return null;
  }
  // Sliding idle timeout: push the expiry back to now + configured window.
  // Throttled so an active session updates the row at most ~once a minute.
  const target = Math.min(Date.now() + sessionTimeoutFrom(settings) * 60_000, lifetimeEnd);
  const current = new Date(session.expires_at).getTime();
  if (!Number.isNaN(current) && target - current > TOUCH_THROTTLE_MS) {
    await touchSession(token, new Date(target).toISOString());
  }
  const user = toSessionUser(session);
  // 1.22.0: an active user this month (lib/plan-usage; cloud mode only, once a day, never waited on).
  (await import("./plan-usage")).noteActive("user", user.id);
  user.newsletter_role = await newsletterLevel(user);
  const pending = await pendingStep(session, sec);
  if (!duoSwitchedOn(settings)) return { user, token, duo: DUO_NOTHING_OWED, pending };
  const standing = await (await import("./duo-gate")).duoSessionStanding(settings, session, token);
  duoStandings.set(user, standing);
  // Duo at sign-in is still to come: it is the second factor, so it is asked first (M6).
  return { user, token, duo: standing.verdict, pending: pending === "two_step" && standing.verdict.signIn ? null : pending };
}

/**
 * A CompassDocs support session (1.21.4, lib/support): valid only while
 * support access is on, its support session has not ended and its request
 * is still approved; its end never slides (the access window is the
 * limit, not activity), it owes no sign-in step and no Duo check (the
 * staff member signed in to the console; the workspace's own rules are for
 * its own people), and what the proxy tagged this request with (a page
 * viewed, a change) goes in the audit log.
 */
async function supportSession(session: User & { support_session_id: number | null }, token: string): Promise<CurrentSession | null> {
  const { liveSupportSession, recordSupportActivity, SUPPORT_ACTIVITY_HEADER } = await import("./support");
  const live = await liveSupportSession(session.support_session_id!, session.id);
  if (!live) return null;
  const user = toSessionUser(session);
  user.newsletter_role = "none";
  user.email = "";
  user.support = {
    session_id: live.sessionId,
    level: live.level,
    staff_name: live.staffName,
    staff_email: live.staffEmail,
    reason: live.reason,
    emergency: live.emergency,
    expires_at: live.expiresAt,
  };
  let tag: string | null = null;
  try {
    tag = (await headers()).get(SUPPORT_ACTIVITY_HEADER);
  } catch {
    /* outside a request */
  }
  await recordSupportActivity(live, session.id, tag);
  return { user, token, duo: DUO_NOTHING_OWED, pending: null };
}

// What the Duo check says about the session a SessionUser came from, kept
// beside the object rather than on it (1.20.5). The gates hand that same
// object to the code they guard, so a later question ("does this person owe
// the desk its Duo approval?") is answered from here with no second session
// query. An object that did not come from currentSession (an API token's
// user, the MCP connector's, a notice's recipient) is not a browser session
// and has no entry: nothing is owed by it, which is right, because Duo is
// never asked of those.
const duoStandings = new WeakMap<object, DuoStanding>();

/** The Duo standing of the session `user` came from (lib/duo-policy DuoStanding). */
export function duoStandingOf(user: object): DuoStanding {
  return duoStandings.get(user) ?? DUO_NO_STANDING;
}

/**
 * Does the session `user` came from still owe the desk its Duo approval?
 * Asked wherever desk-side data is reached by a route or page that is not
 * itself under the desk gates: a ticket read through Get help by someone
 * who works it as an agent, a desk capability used from Settings, minting
 * an API token that could then reach the desk.
 */
export function owesDeskDuo(user: object): boolean {
  return duoStandingOf(user).verdict.desk;
}

/**
 * Read the current user from the session cookie, or null if not signed in.
 *
 * 1.20.5: a session that still owes its sign-in Duo approval is NOT signed
 * in, for every caller. That is the safe default: anything that reads the
 * session through here, today or later, in core or in the enterprise
 * overlay, treats such a session as a signed-out visitor without knowing
 * Duo exists. The gates that can say something more useful (requireUser
 * sends the page to the Duo step, lib/api-auth answers `mfa_required`) read
 * currentSession themselves.
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const s = await currentSession();
  // 1.20.27: so is one that owes a new password or two-step set-up
  // (CurrentSession.pending), for the same reason: the step's own page and
  // routes read currentSession, everything else sees no one signed in.
  return s && !s.duo.signIn && !s.pending ? s.user : null;
}

/**
 * The newsletter capability, derived from role assignments (0.94).
 *
 * `users.newsletter_role` was a fourth parallel authorization system: a text
 * column with its own three values and its own helper module. The column is
 * still written and read for display, but it is no longer what decides — the
 * seeded Newsletter contributor / approver roles are, so the capability can be
 * granted to a group, explained in the Roles console, and revoked in one place.
 *
 * The value is folded back onto SessionUser so lib/newsletter-access keeps its
 * simple synchronous shape and its ~20 call sites stay unchanged. Grants are
 * request-cached, so this costs nothing beyond the query the guard already ran.
 */
async function newsletterLevel(
  user: SessionUser
): Promise<"none" | "contributor" | "approver"> {
  const { grantsFor, holds, legacyAuthzEnforcement } = await import("./authz");
  // Break-glass: the column is the authority again, exactly as before 0.94.
  if (legacyAuthzEnforcement()) return user.newsletter_role;
  const grants = await grantsFor(user.id);
  if (holds(grants, "newsletter.send")) return "approver";
  if (holds(grants, "newsletter.use")) return "contributor";
  return "none";
}

/**
 * The page being rendered, as "/path?query", for a redirect that should come
 * back here afterwards (1.9.4). Server components cannot read the request
 * URL; src/proxy.ts forwards it as a header for every page request. Empty
 * when the header is missing (an API route, a test harness), in which case
 * the caller falls back to the dashboard.
 */
export async function currentPagePath(): Promise<string> {
  try {
    return (await headers()).get("x-compass-path") ?? "";
  } catch {
    return "";
  }
}

/**
 * For server components/pages: redirect to /login when not authenticated —
 * with the page they wanted as `?next=`, so a link to a document that was
 * opened signed-out lands on the document after sign-in, not the dashboard.
 */
export async function requireUser(
  scope: "app" | "desk" = "app",
  /** 1.20.27: the step's own page passes the step it serves, so it can render while that step is owed. */
  opts: { allowPending?: PendingStep } = {}
): Promise<SessionUser> {
  const s = await currentSession();
  if (!s) redirect(loginHref(await currentPagePath()));
  // 1.20.5: signed in, but the Duo check is still owed (lib/duo-policy): for
  // every page, or only for the desk (the "when opening the desk" rule).
  // The desk's layout and its print page say so themselves (scope "desk"),
  // which no request header can talk them out of. Each desk page's own call
  // is caught by its path as well, which src/proxy.ts sets for everything
  // under /desk. The step comes back to this page. The path is read only
  // when something is owed.
  if (s.duo.signIn || (s.duo.desk && (scope === "desk" || isDeskPath(await currentPagePath())))) {
    redirect(duoStepHref(await currentPagePath(), { desk: scope === "desk" }));
  }
  // 1.20.27: a new password or two-step set-up is owed: its page first, and back here after.
  if (s.pending && s.pending !== opts.allowPending) redirect(pendingStepHref(s.pending, await currentPagePath()));
  return s.user;
}

/**
 * For a page outside /desk that is about to show desk-side data (1.20.5):
 * sends a session that owes the desk its Duo approval to the Duo step, and
 * back here afterwards. Call it only once the page knows the data IS
 * desk-side for this viewer; a requester reading their own request is
 * never asked.
 */
export async function requireDeskDuo(user: SessionUser): Promise<void> {
  if (owesDeskDuo(user)) redirect(duoStepHref(await currentPagePath(), { desk: true }));
}

// requireRole(min) lived here until 1.0. Every page that used it now calls
// requirePermission, which asks the same question the API asks; a page gated on
// a rung would bounce someone the API would admit. Nothing calls it, so rather
// than leave a working ladder gate lying around for the next page to reach for,
// it is gone.

/**
 * The page-level counterpart to `apiGuard(min, permission)`, and the reason it
 * exists: once the API enforces permissions, a page still gated on the ladder
 * would bounce someone the API would have let in — a custom role that holds
 * `workspace.settings_manage` without being an Administrator would find the
 * settings page redirecting home while every request it makes succeeds.
 *
 * Same admission rule as the API guard, including the legacy break-glass.
 */
export async function requirePermission(
  min: Role,
  permission: import("./permissions").PermissionKey,
  spaceId?: number
): Promise<SessionUser> {
  const user = await requireUser();
  const { grantsFor, admits, legacyAuthzEnforcement } = await import("./authz");
  if (legacyAuthzEnforcement()) {
    if (!roleAtLeast(user.role, min)) redirect("/");
    return user;
  }
  if (!admits(await grantsFor(user.id), permission, spaceId)) redirect("/");
  return user;
}

/**
 * Guard for a settings section, keyed on its href.
 *
 * The permission lives in lib/settings-sections next to the section's label and
 * icon, so the page guard and the nav that links to it read the same value.
 * Before 0.93 the /admin layout gated the whole console on being an
 * Administrator, which meant a role holding exactly one settings permission
 * could call the API but not open the page that calls it.
 */
export async function requireSettingsSection(href: string): Promise<SessionUser> {
  // (1.21.0: a section CompassDocs Cloud manages still opens for whoever holds
  // its permission; the page shows "Managed by CompassDocs Cloud" in place of
  // its settings, and the rail and search leave it out: reachableSettingsSections.)
  const { settingsSection } = await import("./settings-sections");
  const section = settingsSection(href);
  if (!section) redirect("/");
  return requirePermission("admin", section.permission);
}

/**
 * Guard for a section's shared LAYOUT (1.19.1): any permission that opens
 * some page of the section lets the layout render (the header and the tab
 * row, which shows only the pages the viewer may open). Each page still
 * enforces its own permission: requireSettingsSection for the section's
 * pages, requirePermission for a page with its own (settings-sections
 * `pages[].permission`).
 */
export async function requireSettingsArea(href: string): Promise<SessionUser> {
  const { settingsSection, sectionPermissions } = await import("./settings-sections");
  const section = settingsSection(href);
  if (!section) redirect("/");
  const user = await requireUser();
  const { grantsFor, admits, legacyAuthzEnforcement } = await import("./authz");
  if (legacyAuthzEnforcement()) {
    if (!roleAtLeast(user.role, "admin")) redirect("/");
    return user;
  }
  const grants = await grantsFor(user.id);
  if (!sectionPermissions(section).some((p) => admits(grants, p))) redirect("/");
  return user;
}

/**
 * Which settings sections this user may open — the rail renders exactly
 * these — plus (1.19.1) the href of every page they may open by its own
 * permission (settings-sections `pages[].permission`), so a section reached
 * only through such a page shows in the rail, landing on that page, and its
 * tab shows. Read it with canOpenSection / sectionLanding / canOpenPage.
 */
export async function reachableSettingsSections(user: SessionUser): Promise<string[]> {
  const { SETTINGS_SECTIONS } = await import("./settings-sections");
  const { grantsFor, admits, legacyAuthzEnforcement } = await import("./authz");
  const ownPages = (ok: (p: import("./permissions").PermissionKey) => boolean) =>
    SETTINGS_SECTIONS.flatMap((s) => (s.pages ?? []).filter((p) => p.permission && p.href !== s.href && ok(p.permission)).map((p) => p.href));
  // 1.21.0: in cloud mode the sections CompassDocs Cloud manages (Domain &
  // HTTPS, Backups; lib/cloud) are left out, so the rail, its search, the
  // desk's address link and anything else reading this never offer them.
  // 1.22.0: Plan & usage, only in a cloud workspace whose licence carries a plan (lib/plan).
  const plan = isCloud() ? !!(await (await import("./plan")).cloudPlanState().catch(() => null)) : false;
  const shown = (href: string) => !sectionHiddenInMode(href) && (href !== PLAN_SECTION || plan);
  if (legacyAuthzEnforcement()) {
    return roleAtLeast(user.role, "admin") ? [...SETTINGS_SECTIONS.map((s) => s.href), ...ownPages(() => true)].filter(shown) : [];
  }
  const grants = await grantsFor(user.id);
  return [...SETTINGS_SECTIONS.filter((s) => admits(grants, s.permission)).map((s) => s.href), ...ownPages((p) => admits(grants, p))].filter(shown);
}

/** The longest identifier the sign-in accepts: an email address's maximum. */
export const IDENTIFIER_MAX = 254;

type SignInRecord = Awaited<ReturnType<typeof signInCandidates>>[number];

/**
 * The account an identifier names on the password step (1.16.0): the
 * username first, of any status, else the one active account with a password
 * whose email it is. Undefined when neither (or the email is ambiguous). One
 * query for every outcome (db signInCandidates).
 *
 * A row counts only when it equals the identifier under JS toLowerCase(), the
 * folding the sign-in throttle keys on (lib/login-guard): Postgres lower() in
 * a UTF-8 database also folds "İ" to "i", so "alİce" would sign in as "alice"
 * with five attempts of its own.
 */
export async function resolveSignInAccount(identifier: string): Promise<SignInRecord | undefined> {
  const id = identifier.trim();
  if (!id || id.length > IDENTIFIER_MAX) return undefined;
  const key = id.toLowerCase();
  const byName = (r: SignInRecord) => r.username.toLowerCase() === key;
  const rows = (await signInCandidates(id)).filter(
    (r) =>
      byName(r) ||
      (key.includes("@") && r.status === "active" && !!r.password_hash && (r.email || "").toLowerCase() === key)
  );
  return rows.find(byName) ?? (rows.length === 1 ? rows[0] : undefined);
}

/**
 * Verify credentials and open a session. Returns the token to set as a cookie,
 * null on failure (bad password/code, unknown user, or disabled account), or
 * a totp_required marker when the password checked out but the account has
 * two-factor auth and no (valid) code was supplied yet. `username` may be an
 * email (resolveSignInAccount). Every failure before the password check
 * spends the same scrypt as a real one, so timing says nothing about the
 * account.
 */
export type LoginRefusal = "sso_only" | "temp_expired";

export async function login(
  username: string,
  password: string,
  totpCode?: string,
  device?: { ip?: string | null; userAgent?: string | null },
  /** The account the sign-in route already resolved the identifier to (1.20.27: its throttle is the account's). */
  resolved?: { record: SignInRecord | undefined }
): Promise<{ token: string; user: User; breakGlass?: boolean } | { totp_required: true } | { refused: LoginRefusal } | null> {
  const record = resolved ? resolved.record : await resolveSignInAccount(username);
  // 1.20.27 (security review H1): "SSO only" is enforced here, not only by
  // hiding the form. With it on, a password signs in only an account on the
  // break-glass list (Settings → Single sign-on); every other attempt, an
  // unknown name or a wrong password included, gets the same refusal after
  // the same scrypt, so the answer says nothing about the account or the
  // password.
  const { signInSetup } = await import("./sign-in-routing");
  const ssoOnly = (await signInSetup()).ssoOnly;
  let breakGlass = false;
  if (ssoOnly) {
    const { breakGlassIds } = await import("./sign-in-security");
    breakGlass = !!record && (await breakGlassIds()).includes(record.id);
    if (!breakGlass) {
      await verifyNothing(password);
      return { refused: "sso_only" };
    }
  }
  if (!record || record.status !== "active" || !record.password_hash || !record.password_salt) {
    return (await verifyNothing(password)) || (ssoOnly ? { refused: "sso_only" } : null);
  }
  if (!(await verifyPassword(password, record.password_hash, record.password_salt))) {
    return ssoOnly ? { refused: "sso_only" } : null;
  }
  // 1.20.27 (security review M2): a temporary password stops working 72
  // hours after it was set (db TEMP_PASSWORD_HOURS). Said only to someone
  // who typed it correctly.
  const tempExpires = (record as { temp_password_expires_at?: string | Date | null }).temp_password_expires_at;
  if (record.must_change_password === 1 && tempExpires && new Date(tempExpires).getTime() < Date.now()) {
    return { refused: "temp_expired" };
  }
  // 1.20.27 (security review M7): a hash made with older scrypt parameters
  // is stored again under the current ones, now that the password is known.
  if (needsRehash(record.password_hash)) {
    try {
      const fresh = await hashPassword(password);
      await rehashUserPassword(record.id, record.password_hash, fresh.hash, fresh.salt);
    } catch (e) {
      console.error("[auth] could not rehash a password:", e);
    }
  }

  if (record.totp_enabled === 1 && record.totp_secret) {
    const code = (totpCode || "").trim();
    if (!code) return { totp_required: true };
    const secret = openSecret(record.totp_secret);
    const step = verifyTotpStep(secret, code);
    const lastStep = Number((record as { totp_last_step?: number }).totp_last_step) || 0;
    if (step !== null && step > lastStep) {
      // Valid, not-yet-used code — record its step so it can't be replayed.
      await recordTotpStep(record.id, step);
    } else {
      // Wrong code, or a replay of a code already consumed this window — fall
      // back to one-time recovery codes (xxxx-xxxx, consumed on use).
      const normalized = code.toLowerCase().replace(/[^a-z0-9]/g, "");
      const pretty = `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}`;
      const hash = createHash("sha256").update(pretty).digest("hex");
      if (normalized.length !== 8 || !(await consumeRecoveryCode(record.id, hash))) {
        return { totp_required: true };
      }
    }
  }

  const token = newToken();
  const timeoutMs = (await getSessionTimeoutMinutes()) * 60_000;
  const expires = new Date(Date.now() + timeoutMs).toISOString();
  // A break-glass sign-in without an authenticator is marked, so that session must set one up first (pendingStep).
  const method = record.totp_enabled === 1 && record.totp_secret ? "password_totp" : breakGlass ? "break_glass" : "password";
  await createSession(token, record.id, expires, device?.ip, device?.userAgent, method);
  await markLogin(record.id);
  return { token, user: record, ...(breakGlass ? { breakGlass: true } : {}) };
}

export async function logout(token: string | undefined): Promise<void> {
  if (token) await deleteSession(token);
}
