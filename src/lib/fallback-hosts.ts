// The way back in (1.20.29): addresses that keep reaching CompassDocs after a
// custom domain is applied.
//
// A client's Azure install stopped answering on <label>.<region>.cloudapp.
// azure.com the moment their custom domain was saved: the bundled Caddy was
// told to serve that one name and nothing else, and the name was not in DNS
// yet. Now the proxy config (lib/caddy buildCaddyfile) also serves:
//
//   - COMPASSDOCS_FALLBACK_HOSTS, comma-separated DNS names from the
//     environment (the Azure template writes the VM's cloudapp name there);
//   - the hostname an administrator was browsing on when they saved a new
//     domain (remembered in the settings table, at most five, newest first),
//     when it is a DNS name and not the new domain itself.
//
// Each is its own site (lib/caddy buildCaddyfile): over HTTPS with a
// certificate, plain HTTP redirecting to it, the plain-HTTP app only when TLS
// is off. A name from the environment gets a public certificate in the
// automatic and own-certificate modes. A remembered name gets one only when
// it passed the reachability check (lib/domain-check) when it was
// remembered; otherwise the internal CA, so a split-horizon intranet name
// (*.corp) never sends Caddy into endless Let's Encrypt attempts. The
// canonical address for links stays the custom domain (lib/workspace-origin):
// nothing here is ever used to build a link.
//
// Server-only.

import "server-only";
import { getSetting, setSetting } from "./db";
import { normalizeDomain } from "./settings";

const REMEMBERED_KEY = "fallback_hosts";
export const MAX_REMEMBERED_FALLBACKS = 5;

export interface FallbackHost {
  host: string;
  /** "env": COMPASSDOCS_FALLBACK_HOSTS (changed only on the server); "remembered": the address an admin saved a domain from. */
  source: "env" | "remembered";
  /** May Caddy ask Let's Encrypt for it? Env names: yes. Remembered: only if it passed the check. */
  acme: boolean;
}

/** A remembered name and whether it passed the reachability check when remembered. */
export interface RememberedFallback {
  host: string;
  acme: boolean;
}

/**
 * A strict DNS hostname, or null: lowercase letters, digits and hyphens in
 * two or more labels with a letter TLD (so never an IP address), no scheme,
 * port, path, user info or wildcard, never localhost. One trailing dot is
 * dropped. Used on COMPASSDOCS_FALLBACK_HOSTS entries and on the Host header
 * of an admin's request.
 */
export function validFallbackHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let h = raw.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h || h.length > 253 || !/^[a-z0-9.-]+$/.test(h)) return null;
  if (h === "localhost" || h.endsWith(".localhost")) return null;
  // normalizeDomain also strips a scheme, path or port; demanding it return
  // the input unchanged means none of those were there.
  return normalizeDomain(h) === h ? h : null;
}

/**
 * The hostname of a Host header ("docs.example.com:8443" → "docs.example.com"),
 * when it is a DNS name a fallback may use. An IPv4 address, a bracketed IPv6
 * address, localhost, a single label or anything malformed is null.
 */
export function fallbackHostFromHostHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  const v = header.trim();
  if (!v || v.startsWith("[") || v.includes(",") || v.includes("/") || v.includes("@")) return null;
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(v);
  if (!m) return null;
  return validFallbackHost(m[1]);
}

/** COMPASSDOCS_FALLBACK_HOSTS as valid hostnames, in order, without duplicates. Invalid entries are skipped. */
export function envFallbackHosts(raw: string | undefined = process.env.COMPASSDOCS_FALLBACK_HOSTS): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    if (!part) continue;
    const h = validFallbackHost(part);
    if (h && !out.includes(h)) out.push(h);
    else if (!h && !warned.has(part)) {
      warned.add(part);
      console.warn(`[proxy] COMPASSDOCS_FALLBACK_HOSTS: ignoring "${part.slice(0, 80)}" (not a DNS hostname)`);
    }
  }
  return out;
}
const warned = new Set<string>();

/** The remembered hostnames, newest first. */
export async function rememberedFallbackHosts(): Promise<RememberedFallback[]> {
  const raw = await getSetting(REMEMBERED_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const out: RememberedFallback[] = [];
    for (const v of list) {
      // A bare string is a name remembered before it carried the flag: no public certificate.
      const h = validFallbackHost(typeof v === "string" ? v : v?.host);
      if (h && !out.some((x) => x.host === h)) out.push({ host: h, acme: typeof v === "object" && v?.acme === true });
    }
    return out.slice(0, MAX_REMEMBERED_FALLBACKS);
  } catch {
    return [];
  }
}

/** True when `host` would be newly remembered (a valid name, not from the environment, not already first). */
export async function wouldRememberFallbackHost(host: string): Promise<boolean> {
  const h = validFallbackHost(host);
  if (!h || envFallbackHosts().includes(h)) return false;
  const list = await rememberedFallbackHosts();
  return list[0]?.host !== h;
}

/**
 * Remember `host` (already validated) as a fallback, newest first, at most
 * MAX_REMEMBERED_FALLBACKS, with whether it passed the reachability check
 * (`acme`). Returns true when the list changed.
 *
 * Read-modify-write without a lock (review L4, left as is): two admins
 * saving a domain in the same instant can each drop the other's name. The
 * name the request came from is remembered again on the next save.
 */
export async function rememberFallbackHost(host: string, acme = false): Promise<boolean> {
  const h = validFallbackHost(host);
  if (!h) return false;
  if (envFallbackHosts().includes(h)) return false; // already a fallback, from the server
  const list = await rememberedFallbackHosts();
  if (list[0]?.host === h && list[0].acme === acme) return false;
  const next = [{ host: h, acme }, ...list.filter((x) => x.host !== h)].slice(0, MAX_REMEMBERED_FALLBACKS);
  await setSetting(REMEMBERED_KEY, JSON.stringify(next));
  return true;
}

/** Forget a remembered fallback. Returns true when it was there. */
export async function forgetFallbackHost(host: string): Promise<boolean> {
  const h = validFallbackHost(host);
  if (!h) return false;
  const list = await rememberedFallbackHosts();
  if (!list.some((x) => x.host === h)) return false;
  await setSetting(REMEMBERED_KEY, JSON.stringify(list.filter((x) => x.host !== h)));
  return true;
}

/**
 * Every fallback address: the environment's first, then the remembered
 * ones, never `exclude` (the custom domain itself) and never twice.
 */
export function mergeFallbackHosts(env: string[], remembered: RememberedFallback[], exclude: string[] = []): FallbackHost[] {
  const skip = new Set(exclude.filter(Boolean).map((x) => x.toLowerCase()));
  const out: FallbackHost[] = [];
  const seen = new Set<string>();
  const all: FallbackHost[] = [
    ...env.map((host) => ({ host, source: "env" as const, acme: true })),
    ...remembered.map((r) => ({ host: r.host, source: "remembered" as const, acme: r.acme })),
  ];
  for (const f of all) {
    if (skip.has(f.host) || seen.has(f.host)) continue;
    seen.add(f.host);
    out.push(f);
  }
  return out;
}

/** The fallback addresses for a config serving `domain`. */
export async function fallbackHosts(domain: string): Promise<FallbackHost[]> {
  let remembered: RememberedFallback[] = [];
  try {
    remembered = await rememberedFallbackHosts();
  } catch {
    /* settings unreadable: the environment's still apply */
  }
  return mergeFallbackHosts(envFallbackHosts(), remembered, [domain]);
}
