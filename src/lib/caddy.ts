// Runtime control of the bundled Caddy reverse proxy.
//
// When CompassDocs runs behind the HTTPS compose profile, Caddy exposes its
// admin API on the internal Docker network (COMPASSDOCS_CADDY_ADMIN, e.g.
// http://caddy:2019). We translate the domain/TLS settings the admin picks in
// the GUI into a Caddyfile and POST it to `/load`, which Caddy applies with no
// downtime. The database is the source of truth: the same config is re-pushed
// on server boot, so a restart (or a config drift) heals itself.
//
// This module is server-only (fs + admin-API fetch); never import it from a
// client component.

import { promises as fs } from "fs";
import path from "path";
import { getSetting, pool, setSetting } from "./db";
import { getAppSettings } from "./settings-store";
import type { TlsMode } from "./settings";
import { DOMAIN_CHECK_PATH } from "./domain-check";
import { fallbackHosts } from "./fallback-hosts";

// Base URL of Caddy's admin API. Empty → no managed proxy is attached, so the
// GUI shows the domain settings as informational only.
const CADDY_ADMIN = (process.env.COMPASSDOCS_CADDY_ADMIN || "").replace(/\/+$/, "");

// Where the app writes bring-your-own cert files. This directory is a volume
// shared with the Caddy container, which reads it at CADDY_CERT_PATH.
const CERT_DIR = process.env.COMPASSDOCS_CADDY_CERT_DIR || "/caddy-certs";
// The same files as Caddy sees them (fixed mount point inside the caddy image).
const CADDY_CERT_PATH = "/etc/caddy/certs";

const CERT_KEY = "tls_cert_pem";
const KEY_KEY = "tls_key_pem";

/** True when a reconfigurable reverse proxy is attached to this deployment. */
export function proxyManaged(): boolean {
  return !!CADDY_ADMIN;
}

export interface ProxyStatus {
  /** Whether a manageable proxy (Caddy admin API) is configured at all. */
  managed: boolean;
  /** Whether the admin API responded to a health probe just now. */
  reachable: boolean;
}

// Node's fetch (undici) stamps every request with `Sec-Fetch-Mode: cors`,
// which makes Caddy's admin API treat it as a browser cross-origin request and
// demand an allowed Origin header — without one it 403s ("client is not
// allowed to access from origin ''"). A config with a bare `admin
// 0.0.0.0:2019` only allows its own listen address as the origin, so derive
// that (it also appears in the origins of every config we generate), and fall
// back to the admin URL itself for customized setups.
function adminOrigins(): string[] {
  let port = "2019";
  try {
    port = new URL(CADDY_ADMIN).port || "2019";
  } catch {}
  return [`http://0.0.0.0:${port}`, CADDY_ADMIN];
}

/** fetch() against the admin API, retrying across the allowed-origin candidates. */
async function adminFetch(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let last: Response | null = null;
  for (const origin of adminOrigins()) {
    last = await fetch(`${CADDY_ADMIN}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Origin: origin },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (last.status !== 403) return last;
  }
  return last!;
}

/** Probe the proxy admin API so the GUI can show a live connection state. */
export async function proxyStatus(): Promise<ProxyStatus> {
  if (!CADDY_ADMIN) return { managed: false, reachable: false };
  try {
    const res = await adminFetch("/config/", { method: "GET" }, 3000);
    return { managed: true, reachable: res.ok };
  } catch {
    return { managed: true, reachable: false };
  }
}

/** Whether a bring-your-own certificate + key are stored. */
export async function hasCustomCert(): Promise<boolean> {
  const [cert, key] = await Promise.all([getSetting(CERT_KEY), getSetting(KEY_KEY)]);
  return !!(cert && cert.includes("BEGIN") && key && key.includes("BEGIN"));
}

/** The certificate/key pair after the checks storeCustomCert makes, or an error message. */
export function validateCustomCert(cert: string, key: string): { cert: string; key: string } | { error: string } {
  const c = (cert ?? "").trim();
  const k = (key ?? "").trim();
  if (!c.includes("BEGIN CERTIFICATE")) return { error: "Certificate is not valid PEM." };
  if (!k.includes("BEGIN")) return { error: "Private key is not valid PEM." };
  return { cert: c, key: k };
}

/** Persist a pasted certificate + private key (PEM). Both must look like PEM. */
export async function storeCustomCert(cert: string, key: string): Promise<void> {
  const v = validateCustomCert(cert, key);
  if ("error" in v) throw new Error(v.error);
  await setSetting(CERT_KEY, v.cert);
  await setSetting(KEY_KEY, v.key);
}

// A certificate pasted for a domain that is still waiting for its check
// (1.20.29 review M1) waits beside it, so the live domain keeps its own until
// the switch. lib/domain-flow promotes it when the new domain goes live and
// drops it when the request is discarded or replaced.
const PENDING_CERT_KEY = "tls_cert_pem_pending";
const PENDING_KEY_KEY = "tls_key_pem_pending"; // sealed (lib/db SENSITIVE_SETTINGS)

/** Keep a pasted pair with the pending domain. */
export async function storePendingCert(cert: string, key: string): Promise<void> {
  const v = validateCustomCert(cert, key);
  if ("error" in v) throw new Error(v.error);
  await setSetting(PENDING_CERT_KEY, v.cert);
  await setSetting(PENDING_KEY_KEY, v.key);
}

/** Whether a pair waits with the pending domain. */
export async function hasPendingCert(): Promise<boolean> {
  const [cert, key] = await Promise.all([getSetting(PENDING_CERT_KEY), getSetting(PENDING_KEY_KEY)]);
  return !!(cert && cert.includes("BEGIN") && key && key.includes("BEGIN"));
}

/** The pending pair becomes the live one. No-op without one. */
export async function promotePendingCert(): Promise<void> {
  const [cert, key] = await Promise.all([getSetting(PENDING_CERT_KEY), getSetting(PENDING_KEY_KEY)]);
  if (cert && key) {
    await setSetting(CERT_KEY, cert);
    await setSetting(KEY_KEY, key);
  }
  await clearPendingCert();
}

export async function clearPendingCert(): Promise<void> {
  await pool().query("DELETE FROM settings WHERE key = ANY($1)", [[PENDING_CERT_KEY, PENDING_KEY_KEY]]);
}

/** A fallback site: its name, and whether Caddy may ask Let's Encrypt for it (else the internal CA). */
export interface FallbackSite {
  host: string;
  acme?: boolean;
}

export interface CaddyfileOptions {
  /**
   * While HTTPS on a newly switched domain is being verified (lib/domain-
   * flow), plain HTTP on any other name still serves the app, as before the
   * switch, so nobody on the old address is redirected to a domain whose
   * certificate may not exist yet.
   */
  transitional?: boolean;
}

/** Thrown when a value would not be one plain token in the Caddyfile (review M2). */
export class UnsafeCaddyValue extends Error {}

// Names and the email are validated where they are saved; this is the last
// line: never render a value Caddyfile syntax could read as more than one
// token (whitespace, braces, quotes, comments, placeholders, newlines).
function token(kind: string, v: string): string {
  if (!v || /[\s{}"'`#;\\]/.test(v) || v.length > 254) throw new UnsafeCaddyValue(`Refusing to write an unsafe ${kind} into the proxy configuration.`);
  return v;
}

// Build a Caddyfile from the saved settings. Every config keeps the admin API
// listening on the Docker network — WITH our hostname in the allowed origins,
// or Caddy would 403 the very next /load push and lock us out on reload.
//
// 1.20.29: a config that serves a custom domain also serves
//   - each fallback host (lib/fallback-hosts) as its own site, so the
//     address the install was reached on keeps working. With TLS on, it is
//     served like the domain: HTTPS with a certificate (Let's Encrypt when
//     the host may use it, else the internal CA; the internal CA for the
//     internal mode) and plain HTTP redirecting to it; the plain-HTTP app
//     only when TLS is off;
//   - a plain-HTTP route for the domain check's path on ANY host
//     (lib/domain-check), so a new name can be checked through the current
//     config before the proxy is switched to it. The custom domain and each
//     fallback get an explicit http:// site for the same reason: their
//     HTTP→HTTPS redirect is written out instead of left to Caddy, which
//     would redirect the check too. Any other plain-HTTP request is sent to
//     https://<custom domain> (never to the Host it came with: an IP has no
//     certificate), or, with TLS off, gets Caddy's empty answer.
export function buildCaddyfile(
  domain: string,
  mode: TlsMode,
  email: string,
  fallbacks: (string | FallbackSite)[] = [],
  opts: CaddyfileOptions = {}
): string {
  const globals =
    "{\n\tadmin 0.0.0.0:2019 {\n\t\torigins caddy:2019 localhost:2019 127.0.0.1:2019 0.0.0.0:2019\n\t}\n}\n\n";

  // No custom domain configured — serve the app over plain HTTP on any host so
  // the site stays reachable (e.g. by IP) until a domain is set. That also
  // serves the domain check and every fallback host.
  if (!domain) {
    return `${globals}:80 {\n\treverse_proxy app:3000\n}\n`;
  }

  const d = token("domain", domain);
  const mail = email ? token("email", email) : "";
  const check = `\thandle ${DOMAIN_CHECK_PATH}* {\n\t\treverse_proxy app:3000\n\t}\n`;
  const redirectTo = (host: string) => `\thandle {\n\t\tredir https://${host}{uri} 308\n\t}\n`;
  const app = ["\tencode zstd gzip", "\treverse_proxy app:3000"];
  const blocks: string[] = [];

  const body = [...app];
  if (mode === "auto") {
    if (mail) body.push(`\ttls ${mail}`); // else fully automatic
  } else if (mode === "internal") {
    body.push("\ttls internal");
  } else if (mode === "custom") {
    body.push(`\ttls ${CADDY_CERT_PATH}/cert.pem ${CADDY_CERT_PATH}/key.pem`);
  }
  if (mode === "off") {
    blocks.push(`http://${d} {\n${body.join("\n")}\n}\n`);
  } else {
    blocks.push(`http://${d} {\n${check}${redirectTo(d)}}\n`);
    blocks.push(`${d} {\n${body.join("\n")}\n}\n`);
  }

  for (const f of fallbacks) {
    const host = token("fallback host", typeof f === "string" ? f : f.host);
    const acme = typeof f === "string" ? true : f.acme !== false;
    if (host === d) continue;
    if (mode === "off") {
      blocks.push(`http://${host} {\n${app.join("\n")}\n}\n`);
      continue;
    }
    const fb = [...app];
    // The pasted certificate names only the custom domain, so in that mode
    // a fallback gets its own: Let's Encrypt when it may, else the internal CA.
    if (mode === "internal" || !acme) fb.push("\ttls internal");
    else if (mail) fb.push(`\ttls ${mail}`);
    blocks.push(`http://${host} {\n${check}${redirectTo(host)}}\n`);
    blocks.push(`${host} {\n${fb.join("\n")}\n}\n`);
  }

  // Any other host on plain HTTP: the domain check, then the custom domain
  // (or, while a switch is being verified, the app as before it).
  if (opts.transitional) blocks.push(`http:// {\n\treverse_proxy app:3000\n}\n`);
  else blocks.push(`http:// {\n${check}${mode === "off" ? "" : redirectTo(d)}}\n`);
  return `${globals}${blocks.join("\n")}`;
}

async function writeCertFiles(cert: string, key: string): Promise<void> {
  await fs.mkdir(CERT_DIR, { recursive: true });
  await fs.writeFile(path.join(CERT_DIR, "cert.pem"), cert.trim() + "\n", { mode: 0o600 });
  await fs.writeFile(path.join(CERT_DIR, "key.pem"), key.trim() + "\n", { mode: 0o600 });
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
}

/** What to serve, when it isn't the saved settings (a switch being verified). */
export interface ProxyTarget {
  domain: string;
  tls_mode: TlsMode;
  tls_email: string;
  /** Which stored certificate the custom mode uses: the live one, or the one waiting with the pending domain. */
  cert?: "live" | "pending";
}

/**
 * The row lib/domain-flow keeps for a domain waiting for (or verifying) its
 * switch. Read here only to learn whether a switch is being verified, so a
 * restart re-applies the config being verified rather than the saved one.
 */
export const PENDING_KEY = "custom_domain_pending";

async function verifyingTarget(): Promise<ProxyTarget | null> {
  try {
    const raw = await getSetting(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p?.phase !== "verifying" || typeof p.domain !== "string") return null;
    return { domain: p.domain, tls_mode: p.tls_mode, tls_email: p.tls_email ?? "", cert: p.has_cert ? "pending" : "live" };
  } catch {
    return null;
  }
}

/**
 * Render a config and push it to the live proxy: the saved settings, or
 * `target` (a switch being verified: `transitional`). With neither, a
 * switch being verified (after a restart) is re-applied as it was.
 * Returns `{ ok: false, error }` (never throws) so callers can surface a
 * friendly message. Caddy's /load is atomic: a refused config leaves the
 * running one in place.
 */
export async function applyProxyConfig(target?: ProxyTarget, opts: CaddyfileOptions = {}): Promise<ApplyResult> {
  if (!CADDY_ADMIN) {
    return { ok: false, error: "No managed reverse proxy is attached to this deployment." };
  }

  let t = target;
  let transitional = !!opts.transitional;
  if (!t) {
    const verifying = await verifyingTarget();
    if (verifying) {
      t = verifying;
      transitional = true;
    } else {
      const s = await getAppSettings();
      t = { domain: s.custom_domain, tls_mode: s.tls_mode, tls_email: s.tls_email, cert: "live" };
    }
  }

  if (t.domain && t.tls_mode === "custom") {
    const pending = t.cert === "pending";
    const [cert, key] = await Promise.all([
      getSetting(pending ? PENDING_CERT_KEY : CERT_KEY),
      getSetting(pending ? PENDING_KEY_KEY : KEY_KEY),
    ]);
    if (!cert || !key) {
      return { ok: false, error: "Custom TLS mode needs a certificate and key — add them first." };
    }
    try {
      await writeCertFiles(cert, key);
    } catch (e: any) {
      return { ok: false, error: `Could not write certificate files: ${e?.message || e}` };
    }
  }

  let caddyfile: string;
  try {
    const fallbacks = t.domain ? await fallbackHosts(t.domain) : [];
    caddyfile = buildCaddyfile(t.domain, t.tls_mode, t.tls_email, fallbacks, { transitional });
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
  try {
    const res = await adminFetch(
      "/load",
      { method: "POST", headers: { "Content-Type": "text/caddyfile" }, body: caddyfile },
      15000
    );
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 400);
      return { ok: false, error: `Proxy rejected the configuration (${res.status}). ${text}`.trim() };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `Could not reach the reverse proxy: ${e?.message || e}` };
  }
}

/**
 * Best-effort re-apply of the saved proxy config at server startup, with a few
 * retries to let Caddy finish booting. No-op when no proxy is attached.
 */
export async function applyProxyConfigOnBoot(): Promise<void> {
  if (!CADDY_ADMIN) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await applyProxyConfig();
    if (res.ok) {
      console.log("[proxy] applied saved domain/TLS configuration");
      return;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 10_000));
    else console.warn("[proxy] could not apply configuration on boot:", res.error);
  }
}
