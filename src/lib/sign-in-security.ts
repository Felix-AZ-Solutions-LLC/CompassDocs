// Settings → Sign-in security (1.20.27): who must use two-step sign-in, how
// long a session may last, and the break-glass accounts that may still use
// a password when "SSO only" is on. Server-only; the shapes and labels are
// in sign-in-security-shared.

import "server-only";
import { getAllSettings, getSetting } from "./db";
import { ROLE_ORDER, roleAtLeast, type Role } from "./types";
import type { PermissionKey } from "./permissions";
import {
  asTwoStepScope,
  clampSessionMaxDays,
  parseBreakGlass,
  SESSION_MAX_DAYS_DEFAULT,
  ssoOnlyDisabledByEnv,
  SIGN_IN_SECURITY_KEYS as K,
  type TwoStepScope,
} from "./sign-in-security-shared";

export interface SignInSecurity {
  twoStep: TwoStepScope;
  sessionMaxDays: number;
  breakGlass: number[];
}

export function signInSecurityFrom(map: Record<string, string>): SignInSecurity {
  return {
    twoStep: asTwoStepScope(map[K.twoStep]),
    sessionMaxDays: map[K.sessionMaxDays] ? clampSessionMaxDays(map[K.sessionMaxDays]) : SESSION_MAX_DAYS_DEFAULT,
    breakGlass: parseBreakGlass(map[K.breakGlass]),
  };
}

export async function getSignInSecurity(): Promise<SignInSecurity> {
  return signInSecurityFrom(await getAllSettings());
}

export async function breakGlassIds(): Promise<number[]> {
  return parseBreakGlass(await getSetting(K.breakGlass));
}

export { ssoOnlyDisabledByEnv } from "./sign-in-security-shared";

/** Is "SSO only" saved as on (the raw setting; whether a provider is usable and licensed is lib/sign-in-routing's)? */
export function ssoOnlySavedOn(map: Record<string, string>): boolean {
  return map.sso_only === "1" && !ssoOnlyDisabledByEnv();
}

/**
 * The break-glass accounts among `ids` that can actually get in when single
 * sign-on fails (1.20.27): active, with a password, and an administrator in
 * the two-step rule's sense (isSecurityAdmin). "Remove local passwords",
 * saving SSO only or the list, and the upgrade's seeding all ask this.
 */
export async function usableBreakGlass(ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  const { getUserById, getUserByUsername } = await import("./db");
  const out: number[] = [];
  for (const id of ids) {
    const u = await getUserById(id);
    if (!u || u.status !== "active") continue;
    const full = await getUserByUsername(u.username);
    if (full?.password_hash && (await isSecurityAdmin(u))) out.push(id);
  }
  return out;
}

/**
 * Must `user` have an authenticator app set up? The two-step rule
 * (twoStepCovers), or (second review, Low) being a break-glass account
 * while SSO only is on. Such a person may not turn it off.
 */
export async function twoStepRequiredFor(user: { id: number; role: Role }): Promise<boolean> {
  const map = await getAllSettings();
  const sec = signInSecurityFrom(map);
  if (ssoOnlySavedOn(map) && sec.breakGlass.includes(user.id)) return true;
  return twoStepCovers(sec.twoStep, user);
}

/**
 * The permissions that make someone an administrator for "Require two-step
 * sign-in": whoever can change accounts, roles or the workspace's sign-in
 * settings. The Administrator role holds all of them.
 */
const ADMIN_KEYS: PermissionKey[] = ["user.update_role", "user.reset_password", "workspace.settings_manage", "identity.sso_manage", "role.manage", "role.assign"];

/** Is `user` an administrator in the two-step rule's sense? */
export async function isSecurityAdmin(user: { id: number; role: Role }): Promise<boolean> {
  if (user.role === "admin") return true;
  const { grantsFor, holds, legacyAuthzEnforcement } = await import("./authz");
  if (legacyAuthzEnforcement()) return roleAtLeast(user.role, "admin");
  const g = await grantsFor(user.id);
  return ADMIN_KEYS.some((k) => holds(g, k));
}

/**
 * Does the two-step rule cover `user`? (Whether they have already set an
 * authenticator up, and how the session was opened, are the caller's.)
 */
export async function twoStepCovers(scope: TwoStepScope, user: { id: number; role: Role }): Promise<boolean> {
  if (scope === "off") return false;
  if (scope === "everyone") return true;
  if (await isSecurityAdmin(user)) return true;
  if (scope !== "admins_agents") return false;
  const { hasDeskSideAccess } = await import("./helpdesk/access");
  return hasDeskSideAccess(user as never);
}

/**
 * Refuse a personal API token? (1.20.27, second review, Low.) A token that
 * never expires (made before 1.20.27, or by a settings administrator) of a
 * password account that "Require two-step sign-in" covers but that has no
 * authenticator set up yet: such an account could otherwise keep working
 * through the token without ever enrolling. It works again once its owner
 * sets two-step sign-in up. Single sign-on accounts are not asked (their
 * identity provider is their second factor), nor are expiring tokens,
 * which were made by a session that had to pass the rule.
 */
export async function bearerOwesTwoStep(user: {
  id: number;
  role: Role;
  auth_provider?: string | null;
  totp_enabled?: number;
  token_never_expires?: boolean;
}): Promise<boolean> {
  if (!user.token_never_expires || user.totp_enabled === 1) return false;
  if (user.auth_provider && user.auth_provider !== "local") return false;
  return twoStepRequiredFor(user).catch(() => false);
}

/**
 * May `actor` revoke the credentials of account `targetId`? (1.20.27, second
 * review, Low.) Their own, always; an administrator's, anyone's; anyone
 * else's, only an account whose role is below theirs, so a delegated role
 * cannot switch off an administrator's or an integration's token.
 */
export async function mayRevokeFor(actor: { id: number; role: Role }, targetId: number): Promise<"ok" | "not_found" | "forbidden"> {
  const { getUserById } = await import("./db");
  const target = await getUserById(targetId);
  if (!target) return "not_found";
  if (target.id === actor.id || actor.role === "admin") return "ok";
  return ROLE_ORDER.indexOf(target.role) < ROLE_ORDER.indexOf(actor.role) ? "ok" : "forbidden";
}

/**
 * Who may make a personal API token that never expires (1.20.27, security
 * review H4): administrators of the workspace's settings, for service
 * integrations they look after. Everyone else chooses 30, 90 or 365 days.
 */
export async function mayMintForever(user: { id: number; role: Role }): Promise<boolean> {
  const { userHolds } = await import("./access");
  return userHolds(user, "workspace.settings_manage", { legacyMin: "admin" });
}
