// 1.21.5: the workspace's email through Azure Communication Services (ACS)
// Email, the configuration half: environment only, no database, no
// server-only marker (the tests and the start-up check read it).
//
// A third way out for the workspace's mail, beside SMTP and Microsoft 365
// (lib/mail-config), and the one CompassDocs Cloud uses. It is chosen by
// the operator, never in Settings:
//
//   COMPASSDOCS_MAIL_TRANSPORT=acs        opt in (unset: everything as before)
//   COMPASSDOCS_ACS_ENDPOINT              https://<resource>.communication.azure.com
//   COMPASSDOCS_ACS_SENDER                the MailFrom address, on a domain verified
//                                         in ACS and linked to the resource
//   COMPASSDOCS_ACS_REPLY_TO              optional: where replies go when the
//                                         workspace has not set its own reply address
//   COMPASSDOCS_ACS_PER_MINUTE / _PER_HOUR   this workspace's share of the
//                                         subscription's sending quota (30 and 100,
//                                         ACS's defaults for a custom domain)
//   COMPASSDOCS_ACS_CONNECTION_STRING     development only: endpoint=…;accesskey=…
//
// The app signs in with its managed identity (lib/azure-credential: a
// Microsoft Entra token for https://communication.azure.com/.default), so no
// key is kept anywhere. A connection string holds the resource's access key:
// it is accepted for a loopback endpoint (a local mock) anywhere, and for a
// real resource only on a self-hosted install (with a warning). Cloud mode
// refuses to start with one, as it does a storage connection string
// (lib/file-store).
//
// Self-hosted installs that do not set COMPASSDOCS_MAIL_TRANSPORT never read
// any of this.

import { isCloud, type Env } from "./cloud";

/** The Entra scope ACS takes tokens for. */
export const ACS_SCOPE = "https://communication.azure.com/.default";
/** The Email data-plane API version (GA). */
export const ACS_API_VERSION = "2023-03-31";
/** ACS's default sending limits for a custom domain, per subscription. */
export const ACS_DEFAULT_PER_MINUTE = 30;
export const ACS_DEFAULT_PER_HOUR = 100;
/** One ACS email takes at most 50 recipients (To, Cc and Bcc together). */
export const MAIL_ACS_MAX_RECIPIENTS = 50;
/**
 * The largest request ACS takes: 10 MB with the attachments base64-encoded.
 * Counted on the JSON body as sent, and on the built message when it is
 * queued (its base64 attachments are the same size).
 */
export const MAIL_ACS_MAX_BYTES = 10_000_000;

export type AcsAuth = { kind: "entra"; scope: string } | { kind: "key"; accessKey: string };

export interface AcsConfig {
  /** The resource's origin, no trailing slash. */
  endpoint: string;
  /** COMPASSDOCS_ACS_SENDER: the MailFrom address every message leaves from. */
  sender: string;
  auth: AcsAuth;
  /** COMPASSDOCS_ACS_REPLY_TO, '' when unset (the workspace's own reply address wins: lib/mail-config). */
  replyTo: string;
  perMinute: number;
  perHour: number;
}

/**
 * One bare address: a local part, then dot-separated domain labels. The labels
 * exclude "." so the pattern is unambiguous and runs in linear time.
 */
const ADDRESS = /^[^\s@<>",;]+@(?:[^\s@<>",;.]+\.)+[^\s@<>",;.]+$/;

/** Is this one bare email address (at most 254 characters)? */
export function isBareAddress(v: string): boolean {
  return v.length <= 254 && ADDRESS.test(v);
}

function loopbackHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(host);
}

/** COMPASSDOCS_MAIL_TRANSPORT=acs: the operator chose ACS. Read on every call (tests flip it). */
export function acsSelected(env: Env = process.env): boolean {
  return env.COMPASSDOCS_MAIL_TRANSPORT?.trim().toLowerCase() === "acs";
}

/** The endpoint and access key of an ACS connection string ("endpoint=https://…/;accesskey=…"), or null. */
export function parseAcsConnectionString(cs: string): { endpoint: string; accessKey: string } | null {
  const parts = new Map<string, string>();
  for (const p of cs.split(";")) {
    const i = p.indexOf("=");
    if (i > 0) parts.set(p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim());
  }
  const endpoint = parts.get("endpoint") ?? "";
  const accessKey = parts.get("accesskey") ?? "";
  if (!endpoint || !accessKey) return null;
  try {
    const u = new URL(endpoint);
    return { endpoint: u.origin, accessKey };
  } catch {
    return null;
  }
}

function positiveInt(raw: string | undefined): number | null | "bad" {
  const s = raw?.trim();
  if (!s) return null;
  if (!/^\d{1,7}$/.test(s) || Number(s) < 1) return "bad";
  return Number(s);
}

/**
 * Why ACS can't be used as configured, one sentence each (fatal: the process
 * refuses to start), and what is merely worth saying. Empty when ACS is not
 * chosen and none of its variables is set.
 */
export function acsProblems(env: Env = process.env): { fatal: string[]; warnings: string[] } {
  const fatal: string[] = [];
  const warnings: string[] = [];
  const raw = env.COMPASSDOCS_MAIL_TRANSPORT?.trim();
  if (raw && raw.toLowerCase() !== "acs") {
    fatal.push(`COMPASSDOCS_MAIL_TRANSPORT must be "acs" or unset (it is "${raw.slice(0, 40)}"). SMTP and Microsoft 365 are chosen under Settings → Notifications → Email.`);
    return { fatal, warnings };
  }
  if (!acsSelected(env)) {
    const set = ["COMPASSDOCS_ACS_ENDPOINT", "COMPASSDOCS_ACS_SENDER", "COMPASSDOCS_ACS_CONNECTION_STRING"].filter((k) => env[k]?.trim());
    if (set.length) warnings.push(`${set.join(", ")} ${set.length === 1 ? "is" : "are"} set but COMPASSDOCS_MAIL_TRANSPORT is not "acs": email goes out as chosen in Settings, not through Azure Communication Services.`);
    return { fatal, warnings };
  }
  const cloud = isCloud(env);
  const sender = env.COMPASSDOCS_ACS_SENDER?.trim() ?? "";
  if (!sender) fatal.push("COMPASSDOCS_ACS_SENDER is not set: give the MailFrom address, on a domain verified in Azure Communication Services, e.g. DoNotReply@mail.example.com.");
  else if (!isBareAddress(sender)) fatal.push("COMPASSDOCS_ACS_SENDER must be one email address alone (no display name): the display name is the sender username's, set in Azure.");
  const replyTo = env.COMPASSDOCS_ACS_REPLY_TO?.trim() ?? "";
  if (replyTo && !isBareAddress(replyTo)) fatal.push("COMPASSDOCS_ACS_REPLY_TO must be one email address.");
  for (const [name, v] of [
    ["COMPASSDOCS_ACS_PER_MINUTE", env.COMPASSDOCS_ACS_PER_MINUTE],
    ["COMPASSDOCS_ACS_PER_HOUR", env.COMPASSDOCS_ACS_PER_HOUR],
  ] as const) {
    if (positiveInt(v) === "bad") fatal.push(`${name} must be a whole number of emails, at least 1.`);
  }

  const cs = env.COMPASSDOCS_ACS_CONNECTION_STRING?.trim() ?? "";
  const endpointRaw = env.COMPASSDOCS_ACS_ENDPOINT?.trim() ?? "";
  if (cs) {
    const parsed = parseAcsConnectionString(cs);
    if (!parsed) {
      fatal.push("COMPASSDOCS_ACS_CONNECTION_STRING can't be read: it must be endpoint=https://<resource>.communication.azure.com/;accesskey=<key>.");
    } else if (!loopbackHost(new URL(parsed.endpoint).hostname)) {
      if (cloud) {
        fatal.push("COMPASSDOCS_ACS_CONNECTION_STRING is for development only: cloud mode signs in with its managed identity. Unset it and set COMPASSDOCS_ACS_ENDPOINT.");
      } else {
        warnings.push("COMPASSDOCS_ACS_CONNECTION_STRING holds the resource's access key: fine for development, but prefer COMPASSDOCS_ACS_ENDPOINT with a managed identity.");
      }
    }
    if (endpointRaw) warnings.push("COMPASSDOCS_ACS_ENDPOINT is ignored while COMPASSDOCS_ACS_CONNECTION_STRING is set.");
    return { fatal, warnings };
  }
  if (!endpointRaw) {
    fatal.push("COMPASSDOCS_ACS_ENDPOINT is not set: give the Communication Services resource's address, e.g. https://acme-mail.communication.azure.com.");
    return { fatal, warnings };
  }
  let u: URL | null = null;
  try {
    u = new URL(endpointRaw);
  } catch {
    fatal.push("COMPASSDOCS_ACS_ENDPOINT is not a valid URL: e.g. https://acme-mail.communication.azure.com.");
  }
  if (u) {
    if (u.search || u.username || u.password) fatal.push("COMPASSDOCS_ACS_ENDPOINT must be the bare resource address, with no key or query string: the app signs in with its managed identity.");
    else if (u.protocol !== "https:" && !(u.protocol === "http:" && loopbackHost(u.hostname))) fatal.push(`COMPASSDOCS_ACS_ENDPOINT must be an https:// address (it is ${u.protocol}//…).`);
    else if (u.pathname !== "/" && u.pathname !== "") fatal.push("COMPASSDOCS_ACS_ENDPOINT is the resource's address only, e.g. https://acme-mail.communication.azure.com.");
    else if (!loopbackHost(u.hostname) && !/\.communication\.azure\.(com|us|cn)$/i.test(u.hostname)) {
      warnings.push(`COMPASSDOCS_ACS_ENDPOINT (${u.hostname}) is not a *.communication.azure.com address: check it is the Communication Services resource's endpoint.`);
    }
  }
  return { fatal, warnings };
}

/**
 * ACS as configured, when it is chosen and every setting is usable; null
 * otherwise (not chosen, or acsProblems has a fatal sentence).
 */
export function acsConfig(env: Env = process.env): AcsConfig | null {
  if (!acsSelected(env) || acsProblems(env).fatal.length) return null;
  const cs = env.COMPASSDOCS_ACS_CONNECTION_STRING?.trim() ?? "";
  const parsed = cs ? parseAcsConnectionString(cs) : null;
  const perMinute = positiveInt(env.COMPASSDOCS_ACS_PER_MINUTE);
  const perHour = positiveInt(env.COMPASSDOCS_ACS_PER_HOUR);
  return {
    endpoint: parsed ? parsed.endpoint : new URL(env.COMPASSDOCS_ACS_ENDPOINT!.trim()).origin,
    sender: env.COMPASSDOCS_ACS_SENDER!.trim(),
    auth: parsed ? { kind: "key", accessKey: parsed.accessKey } : { kind: "entra", scope: ACS_SCOPE },
    replyTo: env.COMPASSDOCS_ACS_REPLY_TO?.trim() ?? "",
    perMinute: typeof perMinute === "number" ? perMinute : ACS_DEFAULT_PER_MINUTE,
    perHour: typeof perHour === "number" ? perHour : ACS_DEFAULT_PER_HOUR,
  };
}

/** What the start-up line and the settings page say the app signs in with (never a key). */
export function acsAuthLabel(c: AcsConfig): string {
  return c.auth.kind === "entra" ? "managed identity" : "connection string (development)";
}

/**
 * Start-up (instrumentation), whatever the mode: nothing unless ACS is
 * chosen or its variables are set. A setting that can't work is one error
 * line each and the process exits 1 before it serves anything (no mail
 * would go out); otherwise one line says how mail is sent. Nothing is sent
 * or asked of ACS here: the first send signs in.
 */
export async function checkMailTransportStartup(
  log: (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => void,
  exit: (code: number) => void = (code) => process.exit(code),
  env: Env = process.env
): Promise<boolean> {
  const { fatal, warnings } = acsProblems(env);
  for (const w of warnings) log("warn", "mail.config", { message: w });
  if (fatal.length) {
    for (const f of fatal) log("error", "mail.refused_to_start", { message: `Email through Azure Communication Services can't start: ${f}` });
    await new Promise((r) => setTimeout(r, 200));
    exit(1);
    return false;
  }
  const c = acsConfig(env);
  if (c) {
    log("info", "mail.transport", {
      message: `Email is sent through Azure Communication Services from ${c.sender} at ${new URL(c.endpoint).host} (${acsAuthLabel(c)}), at most ${c.perMinute} a minute and ${c.perHour} an hour.`,
    });
  }
  return true;
}
