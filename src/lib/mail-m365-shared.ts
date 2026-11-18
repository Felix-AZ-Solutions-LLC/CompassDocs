// 1.20.31: the workspace's outgoing email through Microsoft 365, the pure
// half (no database, no server-only imports): the shapes Settings →
// Notifications → Email reads, the checks the form and the API share, the
// Exchange Online PowerShell that limits the app to the one sending
// mailbox, and the client secret's expiry.
//
// How mail is sent is one choice for the whole workspace (lib/mail-config):
// SMTP (lib/smtp-config, as before) or Microsoft 365 (an app registration
// that signs in with the client-credentials grant and posts each message to
// POST /users/{mailbox}/sendMail, lib/mail-m365). Both configurations stay
// stored when the choice changes.
//
// Limiting the app to one mailbox. Microsoft has two ways, and which one
// applies depends on how the app was given Mail.Send:
//
//   granted in Entra (the one-click setup does this; most guides do too)
//       Mail.Send as an application permission with admin consent reaches
//       EVERY mailbox in the organisation. An Exchange "application access
//       policy" (New-ApplicationAccessPolicy -AccessRight RestrictAccess
//       over a mail-enabled security group holding the one mailbox) limits
//       it: accessPolicyCommands.
//   not granted in Entra
//       the app can send as nobody until Exchange gives it the "Application
//       Mail.Send" role over a management scope that names the one mailbox
//       (Microsoft's newer "RBAC for Applications", which is what the
//       helpdesk's Microsoft 365 mailboxes use): rbacCommands. This does not
//       limit a permission granted in Entra (the two add up), so for such an
//       app it applies only once the Entra permission is removed.
//
// Which case an app is in is read from its own access token (the `roles`
// claim lists what Entra granted), each time the connection is saved,
// tested or checked.

import { cleanM365Address, isGuid, m365AddressProblem, m365CredentialsProblem, psLiteral, scopeFilter } from "./helpdesk/m365-mail-shared";

export type MailMethod = "smtp" | "m365";

export const MAIL_METHODS: { value: MailMethod; label: string }[] = [
  { value: "smtp", label: "SMTP" },
  { value: "m365", label: "Microsoft 365" },
];

/** The method's name as the page and diagnostics say it. */
export const methodLabel = (m: MailMethod) => (m === "m365" ? "Microsoft 365" : "SMTP");

/** The app registration the one-click setup makes, or finds by this name and reuses. */
export const MAIL_M365_APP_NAME = "CompassDocs Workspace Mail";
/** The mail-enabled security group (access policy) and the management scope (RBAC) the commands make. */
export const MAIL_M365_GROUP_NAME = "CompassDocs sending mailbox";
export const MAIL_M365_GROUP_ALIAS = "compassdocs-sending-mailbox";
export const MAIL_M365_POLICY_DESCRIPTION = "CompassDocs sending mailbox";

/**
 * The largest message (MIME, attachments included) sent in one Graph call.
 * Graph refuses requests over about 4 MB and the MIME travels as base64
 * (4/3 of its size). A larger message would need an upload session on a
 * draft, which takes Mail.ReadWrite: more than an app that only sends
 * should hold. So a larger one is refused, with a sentence (MAIL_TOO_LARGE).
 */
export const MAIL_M365_MAX_MIME = 2_900_000;

/** Warn this many days before the client secret ends. */
export const MAIL_SECRET_WARN_DAYS = 30;

export const MAIL_NOT_SET_UP = "Outgoing email isn't set up yet. An admin can set it up under Settings → Notifications → Email.";

export interface MailM365Check {
  at: string;
  ok: boolean;
  /** One sentence: what was checked, or what is wrong. */
  message: string;
}

export interface MailM365View {
  tenant: string;
  client_id: string;
  has_secret: boolean;
  mailbox: string;
  from_name: string;
  setup: "manual" | "one_click" | "";
  /** YYYY-MM-DD, '' when not known (a secret pasted by hand). */
  secret_expires: string;
  /** The app's enterprise application (service principal) object ID, for the RBAC commands ('' until it signed in once). */
  sp_object_id: string;
  /** Mail.Send granted in Entra (the token's roles): true, false, or null when it has not signed in yet. */
  entra_send: boolean | null;
  configured: boolean;
  last_check: MailM365Check | null;
}

export interface SmtpView {
  host: string;
  port: number;
  secure: string;
  user: string;
  has_pass: boolean;
  from: string;
  configured: boolean;
}

/** GET /api/admin/mail. */
export interface MailView {
  method: MailMethod;
  /** The chosen method is complete enough to send. */
  configured: boolean;
  smtp: SmtpView;
  m365: MailM365View;
  /** "available": Set up with Microsoft can run here; "enterprise": it is an Enterprise feature this workspace lacks. */
  one_click: "available" | "enterprise";
  /** Test rigs only: the fake Microsoft's address (COMPASSDOCS_M365_MAIL_TEST_BASE), else null. */
  test_base: string | null;
}

export interface MailM365Input {
  tenant?: unknown;
  client_id?: unknown;
  secret?: unknown;
  mailbox?: unknown;
  from_name?: unknown;
}

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** A display name for From: one line, no characters that would break the header, at most 80. */
export function cleanFromName(raw: unknown): string {
  return s(raw).replace(/["\r\n<>\\]/g, "").replace(/\s{2,}/g, " ").slice(0, 80).trim();
}

/** The sending mailbox as stored: its sign-in name or main address, lower-cased; null when it is not one. */
export function cleanSendingMailbox(raw: unknown): string | null {
  return cleanM365Address(raw);
}

/**
 * Why the Microsoft 365 form is refused ('' = fine). The API answers the
 * same sentences. `secretOptional`: a secret is already stored for this app.
 */
export function mailM365Problem(raw: MailM365Input, secretOptional = false): string {
  const creds = m365CredentialsProblem({ tenant: raw.tenant, client_id: raw.client_id, secret: raw.secret }, secretOptional);
  if (creds) return creds;
  return sendingMailboxProblem(raw.mailbox);
}

/** Why the sending mailbox typed is refused ('' = fine). */
export function sendingMailboxProblem(raw: unknown): string {
  const mb = s(raw);
  if (!mb) return "Enter the sending mailbox: the address mail goes out from, such as compassdocs@yourcompany.com.";
  const why = m365AddressProblem(mb);
  return why ? why.replace("Enter the mailbox's main address", "Enter the sending mailbox's sign-in name or main address") : "";
}

/** Bare address of a From such as `"Name" <a@b>` or `a@b`, lower-cased. */
export function bareAddress(from: string): string {
  return (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
}

/** The display name of a From such as `"Name" <a@b>` ('' when it has none). */
export function displayName(from: string): string {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
  return m ? cleanFromName(m[1]) : "";
}

/**
 * Who a message is From when it goes through Microsoft 365, and where
 * answers go. Graph sends as the mailbox: a From of another address is
 * refused unless the mailbox has Send As permission on it, so
 *
 *   no override, or the override IS the mailbox   From the mailbox (under
 *       the override's name, else the configured name).
 *   another address (a newsletter's chosen sender)   From the mailbox under
 *       that sender's name, Reply-To the sender: answers reach them.
 */
export function m365FromFor(mailbox: string, fromName: string, override?: string | null): { from: string; replyTo?: string } {
  const quote = (name: string) => (name ? `"${name}" <${mailbox}>` : mailbox);
  const o = (override ?? "").trim();
  if (!o) return { from: quote(cleanFromName(fromName)) };
  const addr = bareAddress(o);
  const name = displayName(o) || cleanFromName(fromName);
  if (addr === mailbox.toLowerCase()) return { from: quote(name) };
  if (!/^[^\s@<>",;]+@[^\s@<>",;]+$/.test(addr)) return { from: quote(cleanFromName(fromName)) };
  const own = displayName(o);
  return { from: quote(name), replyTo: own ? `"${own}" <${addr}>` : addr };
}

/** The sentence for a message over MAIL_M365_MAX_MIME. */
export function mailTooLarge(bytes: number): string {
  const mb = (n: number) => (n / 1_000_000).toFixed(1);
  return `This email is ${mb(bytes)} MB with its attachments. Microsoft 365 takes at most ${mb(MAIL_M365_MAX_MIME)} MB per email this way. Attach smaller files or share a link to them, or send it by SMTP.`;
}

// --- Limiting the app to the sending mailbox -----------------------------------------

/**
 * Exchange Online PowerShell for an app whose Mail.Send is granted in Entra:
 * a mail-enabled security group holding the one mailbox (hidden from the
 * address book), an application access policy that lets the app reach that
 * group's members and nobody else, and the check. Every value is a
 * single-quoted literal. Null when the app or mailbox is not known yet.
 */
export function accessPolicyCommands(opts: { clientId: string; mailbox: string }): string | null {
  const mailbox = cleanM365Address(opts.mailbox);
  const app = opts.clientId.trim().toLowerCase();
  if (!mailbox || !isGuid(app)) return null;
  const group = psLiteral(MAIL_M365_GROUP_NAME);
  return [
    "Connect-ExchangeOnline",
    `New-DistributionGroup -Name ${group} -Alias ${psLiteral(MAIL_M365_GROUP_ALIAS)} -Type Security -Members ${psLiteral(mailbox)}`,
    `Set-DistributionGroup -Identity ${group} -HiddenFromAddressListsEnabled $true`,
    `New-ApplicationAccessPolicy -AppId ${psLiteral(app)} -PolicyScopeGroupId ${group} -AccessRight RestrictAccess -Description ${psLiteral(MAIL_M365_POLICY_DESCRIPTION)}`,
    `Test-ApplicationAccessPolicy -Identity ${psLiteral(mailbox)} -AppId ${psLiteral(app)}`,
  ].join("\n");
}

/** When the sending mailbox changes later: the group's one member is replaced. */
export function accessPolicyUpdateCommands(mailbox: string): string | null {
  const mb = cleanM365Address(mailbox);
  if (!mb) return null;
  return ["Connect-ExchangeOnline", `Update-DistributionGroupMember -Identity ${psLiteral(MAIL_M365_GROUP_NAME)} -Members ${psLiteral(mb)} -Confirm:$false`].join("\n");
}

/**
 * Exchange Online PowerShell for an app with NO mail permission in Entra
 * (RBAC for Applications, as the helpdesk's mailboxes): register the app's
 * service principal in Exchange, a management scope naming the one
 * mailbox, the "Application Mail.Send" role over it, and the check. Null
 * until the app's object ID is known (it signs in once first).
 */
export function rbacCommands(opts: { clientId: string; spObjectId: string; mailbox: string }): string | null {
  const mailbox = cleanM365Address(opts.mailbox);
  if (!mailbox || !isGuid(opts.clientId) || !isGuid(opts.spObjectId)) return null;
  const sp = psLiteral(opts.spObjectId.trim().toLowerCase());
  const scope = psLiteral(MAIL_M365_GROUP_NAME);
  return [
    "Connect-ExchangeOnline",
    `New-ServicePrincipal -AppId ${psLiteral(opts.clientId.trim().toLowerCase())} -ObjectId ${sp} -DisplayName ${psLiteral(MAIL_M365_APP_NAME)}`,
    `New-ManagementScope -Name ${scope} -RecipientRestrictionFilter ${psLiteral(scopeFilter([mailbox]))}`,
    `New-ManagementRoleAssignment -Name ${psLiteral("CompassDocs workspace Mail.Send")} -App ${sp} -Role ${psLiteral("Application Mail.Send")} -CustomResourceScope ${scope}`,
    `Test-ServicePrincipalAuthorization -Identity ${sp} -Resource ${psLiteral(mailbox)} | Format-Table RoleName, GrantedPermissions, AllowedResourceScope, InScope`,
  ].join("\n");
}

// --- The client secret's end ----------------------------------------------------------

export type SecretExpiry = { state: "unknown" } | { state: "ok" | "soon" | "expired"; days: number; date: string };

/** Where the secret stands on `now` (its expiry is a date, the end of that day UTC). */
export function secretExpiry(expires: string, now: Date = new Date()): SecretExpiry {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) return { state: "unknown" };
  const end = Date.parse(`${expires}T23:59:59Z`);
  if (!Number.isFinite(end)) return { state: "unknown" };
  const days = Math.ceil((end - now.getTime()) / 86_400_000);
  if (end < now.getTime()) return { state: "expired", days, date: expires };
  return { state: days <= MAIL_SECRET_WARN_DAYS ? "soon" : "ok", days, date: expires };
}

/** One sentence about the secret's end, or '' while it is far off or unknown. */
export function secretExpirySentence(expires: string, now: Date = new Date()): string {
  const e = secretExpiry(expires, now);
  if (e.state === "expired") return `The client secret expired on ${e.date}. Create a new secret for the app in Entra and paste it here.`;
  if (e.state === "soon")
    return `The client secret expires on ${e.date} (${e.days <= 1 ? "within a day" : `in ${e.days} days`}). Create a new secret for the app in Entra and paste it here before then.`;
  return "";
}
