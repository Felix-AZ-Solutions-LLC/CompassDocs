// Settings → Sign-in security (1.20.27): who must use two-step sign-in, how
// long a session may last, and the break-glass accounts that may still use
// a password when "SSO only" is on. Server-only; the shapes and labels are
// in sign-in-security-shared.

import "server-only";
import { getAllSettings, getSetting } from "./db";
import { roleAtLeast, type Role } from "./types";
import type { PermissionKey } from "./permissions";
import {
  asTwoStepScope,
  clampSessionMaxDays,
  parseBreakGlass,
  SESSION_MAX_DAYS_DEFAULT,
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
 * Who may make a personal API token that never expires (1.20.27, security
 * review H4): administrators of the workspace's settings, for service
 * integrations they look after. Everyone else chooses 30, 90 or 365 days.
 */
export async function mayMintForever(user: { id: number; role: Role }): Promise<boolean> {
  const { userHolds } = await import("./access");
  return userHolds(user, "workspace.settings_manage", { legacyMin: "admin" });
}
