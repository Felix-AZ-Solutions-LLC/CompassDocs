// SSRF-guarded fetch for server-side requests to URLs an admin typed in
// (link icons, workspace logos, webhooks) or that AI/embeddings endpoints use.
// Secure by default: it refuses cloud-metadata endpoints, link-local and
// loopback addresses, AND RFC1918/CGNAT/ULA private ranges. Deployments that
// intentionally point quick links or webhooks at internal tools can opt back
// in with COMPASSDOCS_FETCH_ALLOW_PRIVATE=1. Redirects are followed manually so
// every hop is re-validated.
//
// Locked-down networks: when HTTPS_PROXY/HTTP_PROXY is set, outbound requests
// go through that proxy (NO_PROXY exclusions honored). Proxied requests skip
// the local DNS/IP resolution check — the server often *can't* resolve
// external names on such networks, and the proxy is the egress policy —
// while hostname-level blocks (localhost, metadata endpoints, literal
// private IPs) still apply. Server-only.

import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

const MAX_REDIRECTS = 4;

// --- Outbound proxy (HTTPS_PROXY / HTTP_PROXY / NO_PROXY) ------------------------

function proxyEnv(): string {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ""
  ).trim();
}

let envAgent: EnvHttpProxyAgent | null | undefined;
function proxyAgent(): EnvHttpProxyAgent | null {
  if (envAgent === undefined) {
    envAgent = proxyEnv() ? new EnvHttpProxyAgent() : null;
  }
  return envAgent;
}

/** True when this host's request will be routed through the configured proxy
 * (mirrors EnvHttpProxyAgent's NO_PROXY semantics for the SSRF-check skip). */
function willProxy(host: string): boolean {
  if (!proxyEnv()) return false;
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || "").trim();
  if (noProxy === "*") return false;
  const h = host.toLowerCase();
  for (const raw of noProxy.split(",")) {
    const entry = raw.trim().toLowerCase().replace(/^\./, "").replace(/:\d+$/, "");
    if (!entry) continue;
    if (h === entry || h.endsWith(`.${entry}`)) return false;
  }
  return true;
}

const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data", // legacy AWS alias
]);

function ipBlocked(ip: string, blockPrivate: boolean): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 0) return true;
    if (blockPrivate) {
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    }
    return false;
  }
  if (v === 6) {
    // Judged on the address's eight words, never its spelling: the URL
    // parser writes [::ffff:127.0.0.1] as ::ffff:7f00:1, so a text prefix
    // can't find the IPv4 inside.
    const words = expandV6(ip.toLowerCase());
    if (!words) return true; // unparseable: refuse
    const zero = (from: number, to: number) => words.slice(from, to).every((w) => w === 0);
    const v4 = () => v4FromWords(words[6], words[7]);
    // ::ffff:0:0/96, IPv4-mapped: the IPv4 address it carries.
    if (zero(0, 5) && words[5] === 0xffff) return ipBlocked(v4(), blockPrivate);
    if (zero(0, 6)) {
      if (words[6] === 0 && words[7] <= 1) return true; // :: unspecified, ::1 loopback
      // ::/96, the deprecated IPv4-compatible form: never a public route,
      // and refused outright when what it carries is loopback/link-local.
      return blockPrivate || ipBlocked(v4(), blockPrivate);
    }
    if ((words[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if (blockPrivate && (words[0] & 0xffc0) === 0xfec0) return true; // site-local fec0::/10 (deprecated)
    if (blockPrivate && (words[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
    // 1.20.29: IPv4 carried inside IPv6. NAT64 (64:ff9b::/96, the IPv4 in
    // the last 32 bits) and 6to4 (2002::/16, the IPv4 in bits 16-47) reach
    // the IPv4 address they carry, so they are judged as that address.
    if (words[0] === 0x64 && words[1] === 0xff9b && zero(2, 6)) return ipBlocked(v4(), blockPrivate);
    if (words[0] === 0x2002) return ipBlocked(v4FromWords(words[1], words[2]), blockPrivate);
    return false;
  }
  return true; // not an IP at all — refuse
}

/** An IPv6 address as its eight 16-bit words, or null. Handles "::" and a dotted IPv4 tail. */
function expandV6(ip: string): number[] | null {
  let s = ip.split("%")[0];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted[2].split(".").map(Number);
    s = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const parts = [...head, ...Array(fill).fill("0"), ...tail];
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
}

function v4FromWords(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * The address rules above, for the one caller that classifies an address
 * without fetching through this module: the custom-domain check (1.20.29,
 * lib/domain-check), which must tell loopback/link-local (never fetched)
 * from private (fetched only for that check, see there) from public. A
 * non-IP string counts as blocked.
 */
export function addressBlocked(ip: string, blockPrivate: boolean): boolean {
  return ipBlocked(ip, blockPrivate);
}

function blockPrivateRanges(): boolean {
  // Secure by default. Opt out on trusted networks that fetch internal hosts.
  if (process.env.COMPASSDOCS_FETCH_ALLOW_PRIVATE === "1") return false;
  if (process.env.COMPASSDOCS_FETCH_BLOCK_PRIVATE === "0") return false; // legacy opt-out
  return true;
}

type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
let resolverForTests: Resolver | null = null;

/** Tests: answer DNS lookups of the checks with `r` (null restores node:dns). */
export function setSafeFetchResolverForTests(r: Resolver | null): void {
  resolverForTests = r;
}

/** Throws when the URL points somewhere server-side fetches must not go. */
export async function assertPublicTarget(rawUrl: string): Promise<URL> {
  return (await checkTarget(rawUrl)).url;
}

/**
 * The checks behind assertPublicTarget, also returning the address the name
 * resolved to (null for a literal IP or a proxied request), so a caller can
 * connect to exactly that address (safeFetchOnce).
 */
async function checkTarget(rawUrl: string): Promise<{ url: URL; resolved: { address: string; family: number } | null }> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Blocked URL scheme: ${url.protocol}`);
  }
  // An IPv6 literal's hostname keeps its brackets ("[::1]"), which isIP()
  // does not take: unbracketed, it is judged as the address it is, so a
  // proxied request to [::1] or [fd00::1] can't skip the literal-IP check.
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(host) || host === "localhost" || host.endsWith(".localhost")) {
    throw new Error(`Blocked host: ${host}`);
  }
  const blockPrivate = blockPrivateRanges();
  if (isIP(host)) {
    if (ipBlocked(host, blockPrivate)) throw new SafeFetchBlocked(`Blocked address: ${host}`);
    return { url, resolved: null };
  }
  // A proxied request never touches an address this server resolves — the
  // proxy resolves and connects. Skip local resolution (which may not even
  // work on egress-locked networks); the hostname checks above still apply.
  if (willProxy(host)) return { url, resolved: null };
  let addrs;
  try {
    addrs = resolverForTests ? await resolverForTests(host) : await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve host: ${host}`);
  }
  for (const a of addrs) {
    if (ipBlocked(a.address, blockPrivate)) {
      // 1.20.27 (security review app L1): the address the name resolved to
      // is never in the message. It would map internal names to internal
      // addresses for whoever supplied the URL (an MCP caller, an editor).
      throw new SafeFetchBlocked(`Blocked address for ${host}`);
    }
  }
  if (!addrs.length) throw new Error(`Could not resolve host: ${host}`);
  return { url, resolved: { address: addrs[0].address, family: addrs[0].family } };
}

/** The target is not one server-side fetches may reach (private, loopback, link-local, metadata). */
export class SafeFetchBlocked extends Error {}

/**
 * A net/tls `lookup` that always answers with one address: the connection
 * goes to the address that was checked, never to whatever a second DNS
 * answer says (DNS rebinding). TLS still verifies the certificate against
 * the URL's host name.
 */
export function pinnedLookup(address: string, family: number) {
  return (_host: string, opts: unknown, cb?: (...args: unknown[]) => void): void => {
    const done = (typeof opts === "function" ? opts : cb) as (...args: unknown[]) => void;
    if (opts && typeof opts === "object" && (opts as { all?: boolean }).all) done(null, [{ address, family }]);
    else done(null, address, family);
  };
}

/**
 * One hop with the same SSRF validation and proxy routing as safeFetch, but
 * a redirect comes back as it is (status 3xx with its Location) for the
 * caller to judge: an integration that must never follow a redirect to
 * another host (1.19.3 Snipe-IT, lib/helpdesk/assets/http) checks the hop
 * itself and calls this again for the next one. A direct (unproxied)
 * request connects to the address the check resolved (pinnedLookup), so a
 * name that resolves somewhere else a moment later can't steer it.
 */
export async function safeFetchOnce(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  const { url, resolved } = await checkTarget(rawUrl);
  if (resolved) {
    const pinned = new Agent({ connect: { lookup: pinnedLookup(resolved.address, resolved.family) as never }, keepAliveTimeout: 1_000, keepAliveMaxTimeout: 1_000 });
    return (await undiciFetch(url.toString(), { ...(init as any), redirect: "manual", dispatcher: pinned })) as unknown as Response;
  }
  const agent = proxyAgent();
  return agent
    ? ((await undiciFetch(url.toString(), { ...(init as any), redirect: "manual", dispatcher: agent })) as unknown as Response)
    : await fetch(url, { ...init, redirect: "manual" });
}

/**
 * fetch() with SSRF validation on the initial URL and on every redirect hop.
 * Pass init as usual; `redirect` is managed internally. With HTTPS_PROXY set,
 * requests route through the proxy (undici's fetch + EnvHttpProxyAgent — the
 * dispatcher must come from the same undici build as the fetch that uses it).
 */
export async function safeFetch(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  // 1.20.27 (security review app L1): every hop goes through safeFetchOnce,
  // which connects to the address its check resolved (pinnedLookup). Before,
  // fetch() resolved the name a second time, so a name that answered with a
  // public address for the check and a private one a moment later (DNS
  // rebinding) reached the private one.
  let url = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await safeFetchOnce(url, init);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      if (hop === MAX_REDIRECTS) throw new Error("Too many redirects");
      url = new URL(loc, url).toString();
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects");
}

/**
 * A response body read up to `maxBytes` and no further (1.20.27, security
 * review app L1): a lying or missing Content-Length cannot make the server
 * buffer more. Null when the body is larger.
 */
export async function readResponseCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks);
}
