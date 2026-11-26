// What a support session may do (1.21.4, lib/support). Pure and dependency-
// free, because the request proxy (src/proxy.ts) reads it on every request.
//
// A support session is a CompassDocs staff member signed in to a cloud
// workspace through an approved request or an emergency grant (lib/support).
// It is its own account (a service user, never one of the customer's) and
// it is limited three ways, each enough on its own for what it covers:
//
//   1. The request proxy (supportRefusal): its cookie says what it is, by
//      the token's prefix (SUPPORT_TOKEN_PREFIX: the session table only
//      knows the token's hash, so a prefix can't be added or removed without
//      losing the session). Read-only sessions are refused every request
//      that is not GET, HEAD or OPTIONS, on every path (pages' server
//      actions included), but signing out. Both levels are refused the
//      areas in REFUSED_ALWAYS and the writes in REFUSED_WRITES.
//   2. Its permissions (supportPermissionAllowed, applied by lib/authz
//      grantsFor): never SUPPORT_DENIED_PERMISSIONS; read-only keeps only
//      the permissions that read.
//   3. The session itself (lib/auth currentSession): valid only while its
//      request is approved, not revoked, and before its end; it never
//      slides, never owes a sign-in step, and ends at its expiry.

export type SupportLevel = "read_only" | "admin";

/** A support session's cookie token: one of these, then 64 hex characters (lib/password newToken never makes an underscore). */
export const SUPPORT_TOKEN_PREFIX: Record<SupportLevel, string> = { read_only: "sup_ro_", admin: "sup_rw_" };

/** The level a session cookie's token names, or null for an ordinary session. */
export function supportLevelOfToken(token: string | undefined | null): SupportLevel | null {
  if (!token) return null;
  if (token.startsWith(SUPPORT_TOKEN_PREFIX.read_only)) return "read_only";
  if (token.startsWith(SUPPORT_TOKEN_PREFIX.admin)) return "admin";
  return null;
}

/** The session cookie's name (lib/auth SESSION_COOKIE; a test keeps them equal). */
export const SESSION_COOKIE_NAME = "compass_session";

/**
 * The request header the proxy tags a support session's page views and
 * changes with, "<nonce> <METHOD> <path>", for lib/auth to audit once per
 * request. Only the proxy writes it: one a client sent is always dropped.
 */
export const SUPPORT_ACTIVITY_HEADER = "x-compass-support-activity";

/** Where the proxy sends a page a support session may not open (it keeps the address). */
export const SUPPORT_NOT_ALLOWED_PAGE = "/support/not-allowed";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Is this a method that only reads? */
export function safeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/** Every method allowed here, at both levels: signing out (the app's and the support session's own end), and signing in again. */
const ALWAYS_ALLOWED: { method: string; path: string }[] = [
  { method: "POST", path: "/api/auth/logout" },
  { method: "DELETE", path: "/api/support/session" },
  // Signing in again with a new grant token (it replaces this session).
  { method: "POST", path: "/api/support/session" },
];

/**
 * Refused to every support session, whatever the method: its own access
 * (it can't see, approve or extend it), copies of the whole workspace, the
 * account security pages of the service account, and the OAuth consent
 * (an app connection would outlive the session).
 */
export const REFUSED_ALWAYS: readonly string[] = [
  "/admin/support-access",
  "/api/admin/support",
  "/api/admin/workspace-export",
  "/api/export",
  "/api/backups",
  "/account",
  "/api/account",
  "/oauth",
  "/api/oauth",
  "/api/helpdesk/admin/api",
];

/**
 * Refused writes for an administrator-level session: passwords, sign-in and
 * single sign-on, people, roles and groups, the license, section delegation.
 * (Reading them stays: support often needs to see how they are set up.)
 */
export const REFUSED_WRITES: readonly string[] = [
  "/api/auth",
  "/api/admin/users",
  "/api/admin/groups",
  "/api/admin/rbac",
  "/api/admin/sso",
  "/api/admin/saml",
  "/api/admin/scim",
  "/api/admin/duo",
  "/api/admin/sign-in-security",
  "/api/admin/license",
  "/api/admin/section-access",
  "/api/admin/backup-destinations",
  "/api/scim",
];

/** Signing out or in again: allowed at both levels, and not a change to the workspace (never counted or audited as one). */
export function sessionControl(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  const p = normalPath(pathname);
  return ALWAYS_ALLOWED.some((a) => a.method === m && p === a.path);
}

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

export type SupportRefusalCode = "support_read_only" | "support_not_allowed";

export interface SupportRefusal {
  code: SupportRefusalCode;
  error: string;
}

/** Normalise a path the way a route matches it: no trailing slash, no doubled slashes, case kept. */
function normalPath(pathname: string): string {
  let p = pathname.replace(/\/{2,}/g, "/");
  try {
    p = decodeURI(p);
  } catch {
    /* left as it came */
  }
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/**
 * Must the proxy refuse this request of a support session at `level`?
 * Null when it may go on. Pure.
 */
export function supportRefusal(level: SupportLevel, method: string, pathname: string): SupportRefusal | null {
  const m = method.toUpperCase();
  const p = normalPath(pathname);
  if (ALWAYS_ALLOWED.some((a) => a.method === m && p === a.path)) return null;
  if (REFUSED_ALWAYS.some((x) => under(p, x))) {
    return { code: "support_not_allowed", error: "A CompassDocs support session can't use this part of the workspace." };
  }
  if (SAFE_METHODS.has(m)) return null;
  if (level === "read_only") {
    return { code: "support_read_only", error: "This is a read-only CompassDocs support session: nothing can be changed." };
  }
  if (REFUSED_WRITES.some((x) => under(p, x))) {
    return { code: "support_not_allowed", error: "A CompassDocs support session can't change sign-in, people, roles or the license." };
  }
  return null;
}

/**
 * Permissions a support session never holds, at either level: its own
 * credentials, people and roles, sign-in and SSO, the license, copies of
 * the workspace, and every outbound channel or credential that would
 * outlive the session (webhooks, mail and AI keys, directory sync, a public
 * site or a public share link).
 */
export const SUPPORT_DENIED_PERMISSIONS: readonly string[] = [
  "account.connection_read",
  "account.connection_revoke",
  "account.password_change",
  "account.profile_manage",
  "account.session_read",
  "account.session_revoke",
  "account.token_create",
  "account.token_read",
  "account.token_revoke",
  "account.twofa_manage",
  "user.create",
  "user.delete",
  "user.link_directory",
  "user.reset_password",
  "user.update_role",
  "user.update_status",
  "group.create",
  "group.delete",
  "group.manage_members",
  "group.update",
  "role.assign",
  "role.manage",
  "workspace.section_access_manage",
  "identity.saml_manage",
  "identity.scim_manage",
  "identity.scim_token_mint",
  "identity.sso_manage",
  "license.install",
  "system.backup_create",
  "system.backup_delete",
  "system.backup_download",
  "system.backup_restore",
  "system.export",
  "system.migrate_run",
  "system.update_apply",
  "integration.ai_config_manage",
  "integration.backup_destination_manage",
  "integration.chat_ask_manage",
  "integration.smtp_manage",
  "integration.webhook_manage",
  "directory.sync_manage",
  "workspace.domain_manage",
  "workspace.public_site_manage",
  "document.share_create",
];

/** Permissions that only open what they gate for reading, beyond the ones named like a read. */
const READ_GATES = new Set(["space.member", "ui.command_palette", "helpdesk.agent", "helpdesk.agent_all", "helpdesk.reports", "workspace.settings_read"]);

/** Does this permission only read (read-only sessions keep these and no others)? */
export function readPermission(key: string): boolean {
  if (READ_GATES.has(key)) return true;
  const action = key.split(".")[1] ?? "";
  return /(?:^|_)(?:read|search|query|lookup|preview|list)(?:_[a-z]+)*$/.test(action);
}

/** May a support session at `level` hold `key`? (lib/authz grantsFor filters a support user's grants with it.) */
export function supportPermissionAllowed(level: SupportLevel, key: string): boolean {
  if (SUPPORT_DENIED_PERMISSIONS.includes(key)) return false;
  return level === "admin" || readPermission(key);
}
