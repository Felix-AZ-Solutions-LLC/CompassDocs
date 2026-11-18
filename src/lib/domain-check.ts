// Does this name reach THIS server? (1.20.29)
//
// Before a custom domain is handed to the bundled Caddy, CompassDocs checks
// it. The incident behind this: a domain saved before its DNS was visible
// made Caddy serve only that name, the name did not work, the address the
// install had been reached on stopped working too, and the admin was locked
// out of the UI.
//
// The check, in order:
//   1. Resolve the name through DNS (A and AAAA, which follow a CNAME; the
//      CNAME itself is recorded too). No record → "doesn't exist in DNS yet".
//   2. Classify the answer. Loopback, link-local and unspecified addresses
//      are never fetched. A private (RFC 1918, CGNAT, ULA) answer is fetched
//      for the self-signed, own-certificate and plain-HTTP modes (a LAN
//      name), never for Let's Encrypt, which must reach the name from the
//      internet: that is refused with the reason.
//   3. Prove it is this server: the app issues a short-lived token (an
//      expiry and a nonce, signed with the workspace's master key), asks
//      http://<domain>/.well-known/compassdocs-domain-check/<token>,
//      connecting to the address DNS gave, and expects back a proof only a
//      process holding the same master key can compute (HMAC of the token).
//      An echo of the token would not do: plenty of servers print the path
//      they were asked for in a 404 page. The request reaches the app
//      through the CURRENT proxy config: the bootstrap `:80` catch-all, and
//      since 1.20.29 every generated config keeps a plain-HTTP route for
//      this path on any host (lib/caddy).
//
// Why this request is not safeFetch: it targets our own public address on
// purpose (possibly a private one on a LAN), so the private-range block
// would refuse the LAN case. The exception is kept narrow instead: port 80
// only, this fixed path with a random token, GET, no redirects followed, no
// outbound proxy, a body read of at most 512 bytes that is only compared and
// never shown, the connection pinned to the address that was classified
// (no DNS rebinding), loopback/link-local/metadata never, and only from the
// admin-only domain routes, the first-run wizard and the background
// re-check of a pending domain. safeFetch and its rules are untouched for
// everything else.
//
// The decision is pure over injected deps (DomainCheckDeps), so the tests
// drive NXDOMAIN, a wrong address, a timeout, a wrong answer and a pass
// without touching the network.
//
// Server-only.

import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { getMasterKey } from "./secretbox";
import { addressBlocked, pinnedLookup, readResponseCapped } from "./safe-fetch";
import type { TlsMode } from "./settings";

export const DOMAIN_CHECK_PATH = "/.well-known/compassdocs-domain-check/";
/** How long an issued token is answered. */
export const CHECK_TOKEN_TTL_MS = 2 * 60_000;
/** The whole HTTP part of one check, across every address tried. */
export const CHECK_TIMEOUT_MS = 8_000;
const DNS_TIMEOUT_MS = 2_500;
const MAX_ADDRESSES_TRIED = 4;

// --- The token and its proof ---------------------------------------------------

function mac(input: string): string {
  return createHmac("sha256", getMasterKey()).update(`compassdocs-domain-check-v1|${input}`).digest("hex");
}

/** A fresh token: base36 expiry, 128-bit nonce, signature. URL-safe. */
export function issueCheckToken(now = Date.now()): string {
  const exp = (now + CHECK_TOKEN_TTL_MS).toString(36);
  const nonce = randomBytes(16).toString("hex");
  return `${exp}.${nonce}.${mac(`token|${exp}|${nonce}`).slice(0, 32)}`;
}

const TOKEN_RE = /^([0-9a-z]{1,12})\.([0-9a-f]{32})\.([0-9a-f]{32})$/;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True for a token this install issued that has not expired. */
export function checkTokenValid(token: string, now = Date.now()): boolean {
  const m = TOKEN_RE.exec(token);
  if (!m) return false;
  const exp = parseInt(m[1], 36);
  if (!Number.isFinite(exp) || exp < now || exp > now + CHECK_TOKEN_TTL_MS + 60_000) return false;
  try {
    return safeEqual(m[3], mac(`token|${m[1]}|${m[2]}`).slice(0, 32));
  } catch {
    return false; // no usable master key
  }
}

/** What the well-known route answers for a valid token, and what the check expects back. */
export function checkProof(token: string): string {
  return mac(`proof|${token}`);
}

// --- Cloudflare's proxy ranges ---------------------------------------------------
// https://www.cloudflare.com/ips/ (stable for years). Only used to word the
// failure: an orange-cloud name answers from Cloudflare, not this server.

const CLOUDFLARE_V4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
];
const CLOUDFLARE_V6 = [
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
  "2a06:98c0::/29", "2c0f:f248::/32",
];

function v4ToBig(ip: string): bigint {
  return ip.split(".").reduce((acc, p) => (acc << 8n) | BigInt(Number(p)), 0n);
}

function v6ToBig(ip: string): bigint | null {
  let s = ip.toLowerCase().split("%")[0];
  if (s.includes(".")) {
    // ::ffff:1.2.3.4 style tail
    const i = s.lastIndexOf(":");
    const v4 = v4ToBig(s.slice(i + 1));
    s = `${s.slice(0, i)}:${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = s.includes("::") ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array(Math.max(0, fill)).fill("0"), ...t];
  if (parts.length !== 8) return null;
  let n = 0n;
  for (const p of parts) n = (n << 16n) | BigInt(parseInt(p || "0", 16));
  return n;
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = BigInt(Number(bitsRaw));
  const v = isIP(ip);
  if (v === 4 && isIP(base) === 4) {
    const shift = 32n - bits;
    return v4ToBig(ip) >> shift === v4ToBig(base) >> shift;
  }
  if (v === 6 && isIP(base) === 6) {
    const a = v6ToBig(ip);
    const b = v6ToBig(base);
    if (a === null || b === null) return false;
    const shift = 128n - bits;
    return a >> shift === b >> shift;
  }
  return false;
}

/** True when the address is in one of Cloudflare's proxy ranges. */
export function isCloudflareAddress(ip: string): boolean {
  const list = isIP(ip) === 6 ? CLOUDFLARE_V6 : CLOUDFLARE_V4;
  return list.some((c) => inCidr(ip, c));
}

// --- The check -----------------------------------------------------------------------

export type DomainCheckCode =
  | "ok"
  | "nxdomain"
  | "no_address"
  | "dns_error"
  | "unusable_address"
  | "private_address"
  | "cloudflare"
  | "timeout"
  | "refused"
  | "unreachable"
  | "wrong_server";

export interface DomainCheckResult {
  ok: boolean;
  code: DomainCheckCode;
  domain: string;
  /** The DNS answer: A then AAAA addresses. */
  addresses: string[];
  /** The CNAME the name points at, when it has one. */
  cname: string | null;
  /** The address that answered with the proof, or the one(s) that did not. */
  tried: string[];
  /** The HTTP status something other than this server answered with (wrong_server). */
  http_status: number | null;
  /** The plain-language reason (or "reaches this server"), for the admin. */
  message: string;
  checked_at: string;
}

export interface ChallengeResponse {
  status: number;
  body: string;
}

export interface DomainCheckDeps {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  resolveCname(host: string): Promise<string[]>;
  /** GET http://<host><path>, connected to `address`, never following a redirect. Throws on a network failure. */
  get(input: { host: string; address: string; path: string; timeoutMs: number }): Promise<ChallengeResponse>;
  issueToken(): string;
  proofFor(token: string): string;
  now(): number;
}

/** Map a fetch failure to the check's reason. */
export function classifyFetchError(e: unknown): "timeout" | "refused" | "unreachable" {
  const err = e as { name?: string; code?: string; cause?: { name?: string; code?: string } } | null;
  const names = [err?.name, err?.cause?.name];
  const codes = [err?.code, err?.cause?.code];
  if (names.includes("TimeoutError") || names.includes("AbortError") || names.includes("ConnectTimeoutError")) return "timeout";
  if (codes.includes("ETIMEDOUT") || codes.includes("UND_ERR_CONNECT_TIMEOUT") || codes.includes("UND_ERR_HEADERS_TIMEOUT") || codes.includes("UND_ERR_BODY_TIMEOUT")) return "timeout";
  if (codes.includes("ECONNREFUSED")) return "refused";
  return "unreachable";
}

function listAddrs(a: string[]): string {
  if (a.length <= 1) return a[0] ?? "";
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
}

/** The admin-facing sentence for a result. */
export function checkMessage(
  r: Pick<DomainCheckResult, "code" | "domain" | "cname" | "tried" | "addresses" | "http_status"> & { dns_code?: string },
  mode: TlsMode
): string {
  const d = r.domain;
  const at = listAddrs(r.tried.length ? r.tried : r.addresses);
  switch (r.code) {
    case "ok":
      return `${d} reaches this server.`;
    case "nxdomain":
      return r.cname
        ? `${d} points at ${r.cname} (a CNAME record), which doesn't exist in DNS yet (no record found).`
        : `${d} doesn't exist in DNS yet (no record found).`;
    case "no_address":
      return r.cname
        ? `${d} points at ${r.cname} (a CNAME record), which has no A or AAAA record yet.`
        : `${d} is in DNS but has no A or AAAA record yet, so it doesn't point at any server.`;
    case "dns_error":
      return `Couldn't look up ${d}: the DNS server didn't answer${r.dns_code ? ` (${r.dns_code})` : ""}. Try again in a few minutes.`;
    case "unusable_address":
      return `${d} points at ${at}, a loopback or link-local address, not this server's public address.`;
    case "private_address":
      return `${d} points at ${at}, a private address. Let's Encrypt has to reach ${d} from the internet: point it at this server's public IP, or choose a self-signed certificate for a name used only on your network.`;
    case "cloudflare":
      return mode === "off"
        ? `${d} is behind Cloudflare's proxy (orange cloud) and the check didn't come back through it: check how Cloudflare reaches this server for this name.`
        : `Cloudflare's proxy is on for ${d} (orange cloud): turn it off until the certificate is issued.`;
    case "timeout":
      return `Couldn't reach ${d} on port 80 (timed out at ${at}): check that ports 80 and 443 are open.`;
    case "refused":
      return `Couldn't reach ${d} on port 80 (connection refused at ${at}): check that ports 80 and 443 are open and that ${at} is this server.`;
    case "unreachable":
      return `Couldn't reach ${d} on port 80 (no route to ${at}): check that ${at} is this server's public address.`;
    case "wrong_server":
      return `${d} points at ${at}; this server didn't answer there.`;
  }
}

function dnsCode(e: unknown): string {
  return String((e as { code?: string } | null)?.code ?? "");
}

const NO_SUCH = new Set(["ENOTFOUND"]);
const NO_DATA = new Set(["ENODATA"]);

/**
 * Check that `domain` reaches this server, for a config in TLS `mode`.
 * Never throws: every failure is a result with a reason.
 */
export async function checkDomain(domain: string, mode: TlsMode, deps: DomainCheckDeps = defaultDeps()): Promise<DomainCheckResult> {
  const started = deps.now();
  const base = { domain, cname: null as string | null, addresses: [] as string[], tried: [] as string[], http_status: null as number | null };
  const done = (code: DomainCheckCode, extra: Partial<typeof base> & { dns_code?: string } = {}): DomainCheckResult => {
    const r = { ...base, ...extra, code };
    return {
      ok: code === "ok",
      code,
      domain,
      addresses: r.addresses,
      cname: r.cname,
      tried: r.tried,
      http_status: r.http_status,
      message: checkMessage(r, mode),
      checked_at: new Date(deps.now()).toISOString(),
    };
  };

  // 1. DNS.
  const [v4, v6, cn] = await Promise.allSettled([deps.resolve4(domain), deps.resolve6(domain), deps.resolveCname(domain)]);
  if (cn.status === "fulfilled" && cn.value.length) base.cname = cn.value[0].replace(/\.$/, "").toLowerCase();
  const a4 = v4.status === "fulfilled" ? v4.value.filter((a) => isIP(a) === 4) : [];
  const a6 = v6.status === "fulfilled" ? v6.value.filter((a) => isIP(a) === 6) : [];
  base.addresses = [...a4, ...a6];
  if (!base.addresses.length) {
    const errs = [v4, v6].map((s) => (s.status === "rejected" ? dnsCode(s.reason) : "ENODATA"));
    if (errs.every((c) => NO_SUCH.has(c))) return done("nxdomain");
    const failed = errs.find((c) => !NO_SUCH.has(c) && !NO_DATA.has(c));
    if (failed) return done("dns_error", { dns_code: failed });
    return done(errs.some((c) => NO_SUCH.has(c)) && !base.cname ? "nxdomain" : "no_address");
  }

  // 2. Classify.
  const usable = base.addresses.filter((a) => !addressBlocked(a, false));
  if (!usable.length) return done("unusable_address", { tried: base.addresses });
  let candidates = usable;
  if (mode === "auto") {
    candidates = usable.filter((a) => !addressBlocked(a, true));
    if (!candidates.length) return done("private_address", { tried: usable });
  }
  // IPv4 first: a container often has no IPv6 route out. AAAA-only names
  // are still tried over IPv6.
  candidates = candidates.slice(0, MAX_ADDRESSES_TRIED);
  const cloudflare = candidates.every(isCloudflareAddress);

  // 3. Prove it is this server.
  const token = deps.issueToken();
  const expected = deps.proofFor(token);
  const tried: string[] = [];
  let answeredStatus: number | null = null;
  let firstFailure: "timeout" | "refused" | "unreachable" | null = null;
  for (const address of candidates) {
    const left = CHECK_TIMEOUT_MS - (deps.now() - started);
    if (left <= 0) {
      firstFailure ??= "timeout";
      break;
    }
    tried.push(address);
    try {
      const res = await deps.get({ host: domain, address, path: `${DOMAIN_CHECK_PATH}${token}`, timeoutMs: left });
      if (res.status === 200 && safeEqual(res.body.trim(), expected)) {
        return done("ok", { tried: [address] });
      }
      answeredStatus ??= res.status;
    } catch (e) {
      firstFailure ??= classifyFetchError(e);
    }
  }
  if (cloudflare) return done("cloudflare", { tried, http_status: answeredStatus });
  if (answeredStatus !== null) return done("wrong_server", { tried, http_status: answeredStatus });
  return done(firstFailure ?? "unreachable", { tried });
}

// --- The real network -------------------------------------------------------------

/** GET over a connection pinned to `address`, no proxy, no redirect, 512-byte body cap. */
async function pinnedGet(input: { host: string; address: string; path: string; timeoutMs: number }): Promise<ChallengeResponse> {
  const family = isIP(input.address);
  const agent = new Agent({
    connect: { lookup: pinnedLookup(input.address, family) as never, timeout: input.timeoutMs },
    keepAliveTimeout: 1_000,
    keepAliveMaxTimeout: 1_000,
  });
  try {
    const res = (await undiciFetch(`http://${input.host}${input.path}`, {
      method: "GET",
      redirect: "manual",
      dispatcher: agent,
      signal: AbortSignal.timeout(input.timeoutMs),
      headers: { "user-agent": "CompassDocs-domain-check" },
    })) as unknown as Response;
    const body = await readResponseCapped(res, 512).catch(() => null);
    return { status: res.status, body: body ? body.toString("utf8") : "" };
  } finally {
    void agent.close().catch(() => {});
  }
}

function defaultDeps(): DomainCheckDeps {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
  return {
    resolve4: (h) => resolver.resolve4(h),
    resolve6: (h) => resolver.resolve6(h),
    resolveCname: (h) => resolver.resolveCname(h),
    get: pinnedGet,
    issueToken: () => issueCheckToken(),
    proofFor: checkProof,
    now: () => Date.now(),
  };
}

/** Tests and callers that want the network deps with one piece swapped. */
export function domainCheckDeps(overrides: Partial<DomainCheckDeps> = {}): DomainCheckDeps {
  return { ...defaultDeps(), ...overrides };
}
