// 1.20.31: how the workspace's outgoing email is sent, and the Microsoft 365
// half of it (the SMTP half stays lib/smtp-config). One choice for the whole
// workspace, `mail_method`: "smtp" (the default, everything as before) or
// "m365". Both configurations stay stored whichever is chosen, so switching
// back loses nothing.
//
// The Microsoft 365 configuration is settings-table keys like the SMTP
// one: the tenant, the app registration's client ID, its client secret
// (`mail_m365_client_secret`, one of lib/db's SENSITIVE_SETTINGS: sealed
// with the master key on write, write-only to the page), the one sending
// mailbox, an optional display name for From, and what is known about the
// app from its own token (the tenant it signs in to, its enterprise
// application's object ID, whether Entra granted it Mail.Send). The
// one-click setup (enterprise overlay, ee/workspace-mail-setup) also stores
// the secret's end date, for the warning before it expires.
//
// Every save signs in with the credentials first (a refusal refuses the
// save, in Microsoft's words made plain, lib/mail-m365-shared); the
// one-click setup may save before Microsoft has finished activating a new
// app (verify: false). Audited: settings.mail_method (the choice),
// settings.mail_m365 (the configuration: what changed, never the secret),
// settings.mail_m365_secret (a stored secret replaced). Server-only.

import "server-only";
import { getSetting, setSetting } from "./db";
import { audit, type AuditActor } from "./audit";
import { enterpriseLicensed } from "./ee";
import { getSmtpConfig, smtpConfigured } from "./smtp-config";
import { M365Error, m365TestBase, m365Token } from "./helpdesk/m365/graph";
import { isGuid } from "./helpdesk/m365-mail-shared";
import {
  cleanFromName,
  cleanSendingMailbox,
  mailM365Problem,
  type MailM365Check,
  type MailM365Input,
  type MailM365View,
  type MailMethod,
  type MailView,
} from "./mail-m365-shared";
import { m365SendSentence } from "./mail-m365-errors";

const KEYS = {
  method: "mail_method",
  tenant: "mail_m365_tenant",
  clientId: "mail_m365_client_id",
  secret: "mail_m365_client_secret",
  mailbox: "mail_m365_mailbox",
  fromName: "mail_m365_from_name",
  setup: "mail_m365_setup",
  secretExpires: "mail_m365_secret_expires",
  spObjectId: "mail_m365_sp_object_id",
  entraSend: "mail_m365_entra_send",
  check: "mail_m365_check",
} as const;

/** Every settings key this module writes (tests put them back). */
export const MAIL_CONFIG_KEYS: readonly string[] = Object.values(KEYS);

export class MailConfigError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = ""
  ) {
    super(message);
  }
}

export interface MailActor {
  actor: AuditActor;
  ip?: string | null;
}

export interface M365SendConfig {
  tenant: string;
  clientId: string;
  /** '' = none stored. Never sent to the page. */
  secret: string;
  mailbox: string;
  fromName: string;
  setup: "manual" | "one_click" | "";
  secretExpires: string;
  spObjectId: string;
  entraSend: boolean | null;
  lastCheck: MailM365Check | null;
}

export async function getMailMethod(): Promise<MailMethod> {
  return (await getSetting(KEYS.method)) === "m365" ? "m365" : "smtp";
}

export async function getM365SendConfig(): Promise<M365SendConfig> {
  const [tenant, clientId, secret, mailbox, fromName, setup, secretExpires, spObjectId, entraSend, check] = await Promise.all([
    getSetting(KEYS.tenant),
    getSetting(KEYS.clientId),
    getSetting(KEYS.secret).catch(() => ""),
    getSetting(KEYS.mailbox),
    getSetting(KEYS.fromName),
    getSetting(KEYS.setup),
    getSetting(KEYS.secretExpires),
    getSetting(KEYS.spObjectId),
    getSetting(KEYS.entraSend),
    getSetting(KEYS.check),
  ]);
  let lastCheck: MailM365Check | null = null;
  try {
    const v = check ? JSON.parse(check) : null;
    if (v && typeof v.at === "string" && typeof v.ok === "boolean" && typeof v.message === "string") lastCheck = { at: v.at, ok: v.ok, message: v.message };
  } catch {
    lastCheck = null;
  }
  return {
    tenant: tenant?.trim() || "",
    clientId: clientId?.trim() || "",
    secret: secret || "",
    mailbox: mailbox?.trim() || "",
    fromName: fromName?.trim() || "",
    setup: setup === "one_click" || setup === "manual" ? setup : "",
    secretExpires: secretExpires?.trim() || "",
    spObjectId: spObjectId?.trim() || "",
    entraSend: entraSend === "1" ? true : entraSend === "0" ? false : null,
    lastCheck,
  };
}

export function m365SendConfigured(c: Pick<M365SendConfig, "tenant" | "clientId" | "secret" | "mailbox">): boolean {
  return Boolean(c.tenant && c.clientId && c.secret && c.mailbox);
}

/** Whether `method`'s configuration is complete enough to send. */
export async function methodConfigured(method: MailMethod): Promise<boolean> {
  return method === "m365" ? m365SendConfigured(await getM365SendConfig()) : smtpConfigured(await getSmtpConfig());
}

/** Whether the workspace can send email at all: the CHOSEN method is set up. Every "is email on?" check asks this. */
export async function mailConfigured(): Promise<boolean> {
  return methodConfigured(await getMailMethod());
}

/**
 * The workspace's own From for the chosen method ('' when it is not set
 * up): the SMTP From address, or the Microsoft 365 sending mailbox under
 * its display name.
 */
export async function workspaceFrom(): Promise<string> {
  if ((await getMailMethod()) === "m365") {
    const c = await getM365SendConfig();
    if (!m365SendConfigured(c)) return "";
    const name = cleanFromName(c.fromName);
    return name ? `"${name}" <${c.mailbox}>` : c.mailbox;
  }
  const s = await getSmtpConfig();
  return smtpConfigured(s) ? s.from : "";
}

/** Set up with Microsoft can run here: an Enterprise build with a current licence. */
export async function oneClickMailAvailable(): Promise<boolean> {
  try {
    return await enterpriseLicensed();
  } catch {
    return false;
  }
}

export function m365View(c: M365SendConfig): MailM365View {
  return {
    tenant: c.tenant,
    client_id: c.clientId,
    has_secret: Boolean(c.secret),
    mailbox: c.mailbox,
    from_name: c.fromName,
    setup: c.setup,
    secret_expires: c.secretExpires,
    sp_object_id: c.spObjectId,
    entra_send: c.entraSend,
    configured: m365SendConfigured(c),
    last_check: c.lastCheck,
  };
}

export async function mailView(): Promise<MailView> {
  const [method, smtp, m365, oneClick] = await Promise.all([getMailMethod(), getSmtpConfig(), getM365SendConfig(), oneClickMailAvailable()]);
  const smtpOk = smtpConfigured(smtp);
  return {
    method,
    configured: method === "m365" ? m365SendConfigured(m365) : smtpOk,
    smtp: { host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, has_pass: Boolean(smtp.pass), from: smtp.from, configured: smtpOk },
    m365: m365View(m365),
    one_click: oneClick ? "available" : "enterprise",
    test_base: m365TestBase(),
  };
}

/** Choose how mail is sent. Refused (409) when that method is not set up: nothing would go out. */
export async function setMailMethod(method: MailMethod, by: MailActor, opts: { force?: boolean } = {}): Promise<boolean> {
  const from = await getMailMethod();
  if (from === method) return false;
  if (!opts.force && !(await methodConfigured(method))) {
    throw new MailConfigError(method === "m365" ? "Set up Microsoft 365 first: nothing could be sent with it yet." : "Set up SMTP first: nothing could be sent with it yet.", 409, "not_set_up");
  }
  await setSetting(KEYS.method, method);
  await audit({ actor: by.actor, action: "settings.mail_method", targetType: "settings", targetId: "mail", targetLabel: "Email", details: { from, to: method }, ip: by.ip ?? null });
  return true;
}

/** What a token says about the app, kept for the page (which lock-down commands apply). */
async function recordTokenFacts(claims: { tid: string; oid: string; roles: string[] }): Promise<void> {
  if (claims.oid && isGuid(claims.oid)) await setSetting(KEYS.spObjectId, claims.oid);
  await setSetting(KEYS.entraSend, entraGrantsSend(claims.roles) ? "1" : "0");
}

/** Mail.Send (or a wider mail permission that includes sending) granted in Entra: the app reaches every mailbox. */
export function entraGrantsSend(roles: readonly string[]): boolean {
  return roles.some((r) => r === "Mail.Send" || r === "Mail.Send.All" || r === "Mail-Advanced.ReadWrite.All");
}

/** Keep the outcome of a check (diagnostics, Check connection), and what the token said, for the page. */
export async function recordM365Check(check: MailM365Check, claims?: { tid: string; oid: string; roles: string[] } | null): Promise<void> {
  await setSetting(KEYS.check, JSON.stringify(check));
  if (claims) await recordTokenFacts(claims).catch(() => {});
}

export interface SaveM365Options {
  setup?: "manual" | "one_click";
  /** false: save without signing in (the one-click setup, while Microsoft is still activating a new app). */
  verify?: boolean;
  /** The one-click setup: the tenant the app was made in, its service principal and the secret's end date. */
  tenantId?: string;
  spObjectId?: string;
  secretExpires?: string;
  /** After a good save, choose Microsoft 365 for the workspace's mail. */
  use?: boolean;
}

/**
 * Save the Microsoft 365 configuration, after signing in with it (unless
 * verify: false). An empty secret keeps the stored one while the tenant
 * and the client ID are unchanged. The tenant kept is the one the token
 * signs in to. Answers the page's view of it, and whether it signed in.
 */
export async function saveM365SendConfig(raw: MailM365Input, by: MailActor, opts: SaveM365Options = {}): Promise<{ view: MailM365View; verified: boolean; changed: string[]; method_changed: boolean }> {
  const cur = await getM365SendConfig();
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const tenantTyped = str(raw.tenant).toLowerCase();
  const clientId = str(raw.client_id).toLowerCase();
  const sameApp = Boolean(cur.secret) && cur.clientId === clientId && (cur.tenant === tenantTyped || !tenantTyped);
  const problem = mailM365Problem({ ...raw, tenant: tenantTyped || (sameApp ? cur.tenant : ""), client_id: clientId }, sameApp);
  if (problem) throw new MailConfigError(problem);
  const secret = str(raw.secret) || cur.secret;
  const mailbox = cleanSendingMailbox(raw.mailbox)!;
  const fromName = raw.from_name === undefined ? cur.fromName : cleanFromName(raw.from_name);
  let tenant = tenantTyped || cur.tenant;
  const setup = opts.setup ?? "manual";
  if (setup === "one_click") {
    const tid = (opts.tenantId ?? "").trim().toLowerCase();
    if (!isGuid(tid) || tenant !== tid) throw new MailConfigError("The app registration's tenant must be the ID of the tenant it was created in.");
  }

  let verified = false;
  let claims: { tid: string; oid: string; roles: string[] } | null = null;
  if (opts.verify !== false) {
    try {
      claims = (await m365Token({ tenant, clientId, secret }, true)).claims;
      verified = true;
      if (claims.tid) tenant = claims.tid;
    } catch (e) {
      if (e instanceof M365Error) throw new MailConfigError(m365SendSentence(e, mailbox), e.kind === "auth" ? 409 : 502, e.kind === "auth" ? "signin" : "unreachable");
      throw e;
    }
  }

  const changed: string[] = [];
  if (cur.tenant !== tenant) changed.push("tenant");
  if (cur.clientId !== clientId) changed.push("client_id");
  if (cur.secret !== secret) changed.push("secret");
  if (cur.mailbox !== mailbox) changed.push("mailbox");
  if (cur.fromName !== fromName) changed.push("from_name");
  const appChanged = changed.includes("tenant") || changed.includes("client_id");

  const writes: [string, string][] = [
    [KEYS.tenant, tenant],
    [KEYS.clientId, clientId],
    [KEYS.mailbox, mailbox],
    [KEYS.fromName, fromName],
    [KEYS.setup, changed.length || !cur.setup ? setup : cur.setup],
  ];
  if (cur.secret !== secret) writes.push([KEYS.secret, secret]);
  // The end date is known for a secret the one-click setup made; a secret pasted by hand has none here.
  if (opts.secretExpires !== undefined) writes.push([KEYS.secretExpires, opts.secretExpires]);
  else if (cur.secret !== secret) writes.push([KEYS.secretExpires, ""]);
  if (claims) {
    if (claims.oid && isGuid(claims.oid)) writes.push([KEYS.spObjectId, claims.oid]);
    writes.push([KEYS.entraSend, entraGrantsSend(claims.roles) ? "1" : "0"]);
  } else if (appChanged) {
    writes.push([KEYS.spObjectId, isGuid(opts.spObjectId ?? "") ? opts.spObjectId!.toLowerCase() : ""], [KEYS.entraSend, ""]);
  }
  // A check of another app or mailbox says nothing about this one.
  if (appChanged || changed.includes("mailbox") || changed.includes("secret")) writes.push([KEYS.check, ""]);
  for (const [k, v] of writes) await setSetting(k, v);

  await audit({
    actor: by.actor,
    action: "settings.mail_m365",
    targetType: "settings",
    targetId: "mail",
    targetLabel: "Email: Microsoft 365",
    // What changed, the tenant, app and mailbox; never the secret.
    details: { created: !cur.clientId, changed, tenant, client_id: clientId, mailbox, setup, verified, entra_send: claims ? entraGrantsSend(claims.roles) : null, ...(opts.secretExpires ? { secret_expires: opts.secretExpires } : {}) },
    ip: by.ip ?? null,
  });
  if (cur.secret && cur.secret !== secret) {
    await audit({
      actor: by.actor,
      action: "settings.mail_m365_secret",
      targetType: "settings",
      targetId: "mail",
      targetLabel: "Email: Microsoft 365",
      details: { client_id: clientId, setup, ...(opts.secretExpires ? { secret_expires: opts.secretExpires } : {}) },
      ip: by.ip ?? null,
    });
  }
  let methodChanged = false;
  if (opts.use) methodChanged = await setMailMethod("m365", by);
  return { view: m365View(await getM365SendConfig()), verified, changed, method_changed: methodChanged };
}

/** What the one-click setup must know before it touches Entra: the app this workspace already uses, if any. */
export async function m365SendSetupState(): Promise<{ tenant: string; clientId: string; mailbox: string }> {
  const c = await getM365SendConfig();
  return { tenant: c.tenant, clientId: c.clientId, mailbox: c.mailbox };
}
