// The license from the CompassDocs console (1.21.3): COMPASSDOCS_LICENSE_URL.
//
// In cloud mode a workspace's license is renewed by the console without a
// restart. COMPASSDOCS_LICENSE_KEY stays the bootstrap (the license the
// workspace starts with); with COMPASSDOCS_LICENSE_URL set, the app also
// asks the console for the workspace's current license: shortly after start,
// then about every 6 hours (with jitter, and skipped when another replica
// asked recently), and when an administrator presses Check now
// (Settings → License).
//
// The request (the contract is in README "License from the console"):
//
//   GET COMPASSDOCS_LICENSE_URL
//   Authorization: Bearer <credential>
//   Accept: text/plain
//   If-None-Match: <the ETag of the license held>   (when one is held)
//   X-CompassDocs-Workspace: COMPASSDOCS_WORKSPACE_ID
//
// The credential is a Microsoft Entra token for the managed identity
// (COMPASSDOCS_LICENSE_AUDIENCE, the console's app ID URI; recommended: no
// secret exists) or COMPASSDOCS_LICENSE_TOKEN. The request is limited:
// FETCH_TIMEOUT_MS in all, a body of at most MAX_BODY_BYTES, redirects only
// to the same origin (MAX_REDIRECTS), and at most one request at a time.
//
// A fetched license is used only when (judgeLicense):
//
//   - it verifies with the vendor's key (lib/license parseLicense: the same
//     key and code as every other license, never anything weaker);
//   - its `workspace` claim is this workspace (COMPASSDOCS_WORKSPACE_ID);
//   - it has not expired (its grace period counts as expired here: a
//     license past its date is never newly installed);
//   - it ranks at or above the license in force (lib/license
//     licenseRanksAbove): it runs at least as long and was issued no
//     earlier. Never a downgrade, never an older or shorter license.
//
// The last good one is kept in the database (lib/license
// CLOUD_LICENSE_SETTING), written under an advisory lock that compares
// again with what another replica may have stored, so a restart during a
// console outage keeps it. A console that can't be reached, refuses the
// credential or sends a license that fails any check changes nothing: the
// license in force stays, the outcome is noted (Settings → License shows
// it), it is logged once until it changes, and the next try backs off
// (BACKOFF_MIN_MS doubling to BACKOFF_MAX_MS, or the console's Retry-After).
//
// Self-hosted, or in cloud mode without COMPASSDOCS_LICENSE_URL, nothing
// here runs.

import "server-only";
import pkg from "../../package.json";
import { audienceScope, licensePullConfig, type LicensePullConfig } from "./cloud";
import { CachedToken } from "./azure-credential";
import { getSetting, withAdvisoryLock } from "./db";
import { CLOUD_LICENSE_SETTING, evaluate, licenseCandidates, licenseRanksAbove, parseLicense, pickLicenseKey, type License } from "./license";
import { audit } from "./audit";
import { logEvent } from "./log";
import { after, runJob } from "./shutdown";

/** Where the last check's outcome is kept (JSON, PullStatus). */
export const CLOUD_LICENSE_STATUS_SETTING = "license_cloud_status";

export const PULL_INTERVAL_MS = 6 * 60 * 60_000;
/** ± this share of the interval, so replicas and workspaces don't ask at once. */
export const PULL_JITTER = 0.1;
export const START_DELAY_MS = 5_000;
export const BACKOFF_MIN_MS = 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;
/** A license the console sent but that failed a check: asked again after this long. */
export const REJECTED_RETRY_MS = 60 * 60_000;
/** The whole request, redirects and body included. */
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_REDIRECTS = 2;
/** No two Check now requests from this process closer than this (it answers 429 inside it); the schedule is spaced on its own. */
export const MIN_CHECK_GAP_MS = 30_000;
/** Retry-After is honoured within these bounds. */
const RETRY_AFTER_MIN_MS = 60_000;
const RETRY_AFTER_MAX_MS = PULL_INTERVAL_MS;

export type PullResult =
  /** A newer license was installed. */
  | "updated"
  /** The console sent the license in force (or 304). */
  | "unchanged"
  /** The console has no license for this workspace (204 or 404). */
  | "none"
  /** The console sent a license that failed a check: kept the one in force. */
  | "rejected"
  /** No answer: network, timeout, 429, 5xx. */
  | "unreachable"
  /** 401 or 403, or no credential could be had. */
  | "unauthorized"
  /** Anything else the console answered (a redirect elsewhere, a bad body, another status). */
  | "error";

export interface PullStatus {
  /** When the last check finished (ISO). */
  checkedAt: string;
  result: PullResult;
  /** One sentence for an administrator; never a token. */
  message: string;
  /** When the console last answered (ISO). */
  contactedAt?: string;
  /** When a license from the console was last installed (ISO). */
  updatedAt?: string;
  /** The ETag of the license held (If-None-Match). */
  etag?: string;
}

type Parse = (raw: string) => { license?: License; error?: string };
type Log = (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => void;

export interface PullDeps {
  fetch: typeof fetch;
  /** Only ever lib/license parseLicense in the app (the vendor's key); tests sign with their own key. */
  parse: Parse;
  now: () => number;
  random: () => number;
  /** The bearer credential for the request. */
  credential: (cfg: LicensePullConfig) => Promise<string>;
  log: Log;
  /** The whole request (FETCH_TIMEOUT_MS). */
  timeoutMs: number;
}

// --- Judging a fetched license -------------------------------------------------------------

export type Judgement =
  | { accept: true; license: License }
  | { accept: false; reason: "invalid" | "wrong_workspace" | "expired" | "older" | "unchanged"; message: string };

const day = (iso: string) => iso.slice(0, 10);

/**
 * Should `raw` (fetched) replace `current` (the license in force, or "")?
 * Pure; `parse` is lib/license parseLicense in the app.
 */
export function judgeLicense(raw: string, current: string, workspaceId: string, now: Date, parse: Parse = parseLicense): Judgement {
  const token = raw.trim();
  const { license, error } = parse(token);
  if (!license) return { accept: false, reason: "invalid", message: `The console sent a license that does not verify: ${error || "it is empty"}` };
  if (license.workspace !== workspaceId) {
    return {
      accept: false,
      reason: "wrong_workspace",
      message: license.workspace
        ? `The console sent a license for another workspace (${String(license.workspace).slice(0, 64)}).`
        : "The console sent a license that names no workspace.",
    };
  }
  if (evaluateWith(token, now, parse) !== "active") {
    return { accept: false, reason: "expired", message: `The console sent a license that expired on ${day(license.expires)}.` };
  }
  if (current && current.trim() === token) return { accept: false, reason: "unchanged", message: "The license in force is the console's latest." };
  const held = current ? parse(current.trim()).license : undefined;
  if (held && !licenseRanksAbove(license, held)) {
    return {
      accept: false,
      reason: "older",
      message: `The console sent a license older or shorter than the one in force (it expires ${day(license.expires)}, issued ${day(
        license.issued
      )}; the one in force expires ${day(held.expires)}, issued ${day(held.issued)}).`,
    };
  }
  return { accept: true, license };
}

/** lib/license evaluate's dates with this module's parse (the same rules: active until the expiry, then grace). */
function evaluateWith(token: string, now: Date, parse: Parse): "active" | "past" {
  if (parse === parseLicense) return evaluate(token, now).status === "active" ? "active" : "past";
  const l = parse(token).license;
  return l && now <= new Date(l.expires) ? "active" : "past";
}

// --- The request ------------------------------------------------------------------------------

export type FetchOutcome =
  | { kind: "license"; token: string; etag?: string }
  | { kind: "not_modified" }
  | { kind: "none"; status: number }
  | { kind: "unauthorized"; status: number }
  | { kind: "unreachable"; message: string; retryAfterMs?: number }
  | { kind: "error"; message: string };

const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function retryAfter(h: string | null, now: number): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(h) - now;
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, ms));
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function describeFailure(e: unknown, timeoutMs: number): string {
  const x = e as { name?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  if (x?.name === "TimeoutError" || x?.name === "AbortError") return `no answer within ${Math.round(timeoutMs / 100) / 10} s`;
  const code = x?.cause?.code;
  const msg = (x?.cause?.message || x?.message || String(e)).split("\n")[0].slice(0, 200);
  return code && !msg.includes(code) ? `${code}: ${msg}` : msg;
}

/**
 * One GET of the console's license endpoint, by the contract above: same-
 * origin redirects only, FETCH_TIMEOUT_MS in all, MAX_BODY_BYTES at most.
 */
export async function fetchLicense(
  cfg: LicensePullConfig,
  credential: string,
  opts: { etag?: string; fetchImpl?: typeof fetch; now?: number; timeoutMs?: number } = {}
): Promise<FetchOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential}`,
    Accept: "text/plain",
    "User-Agent": `CompassDocs/${pkg.version}`,
    "X-CompassDocs-Workspace": cfg.workspaceId,
    "X-CompassDocs-Version": pkg.version,
  };
  if (opts.etag) headers["If-None-Match"] = opts.etag;
  let url = new URL(cfg.url.toString());
  try {
    for (let hop = 0; ; hop++) {
      const res = await fetchImpl(url, { method: "GET", headers, redirect: "manual", signal, cache: "no-store" });
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        await res.body?.cancel().catch(() => {});
        const loc = res.headers.get("location");
        if (!loc) return { kind: "error", message: `The console answered ${res.status} with no Location.` };
        let next: URL;
        try {
          next = new URL(loc, url);
        } catch {
          return { kind: "error", message: `The console redirected to an address that is not a URL.` };
        }
        if (next.origin !== cfg.url.origin) {
          return { kind: "error", message: `The console redirected to another host (${next.host}); the request was not followed.` };
        }
        if (hop >= MAX_REDIRECTS) return { kind: "error", message: `The console redirected more than ${MAX_REDIRECTS} times.` };
        url = next;
        continue;
      }
      const now = opts.now ?? Date.now();
      if (res.status === 304) {
        await res.body?.cancel().catch(() => {});
        return opts.etag ? { kind: "not_modified" } : { kind: "error", message: "The console answered 304 to a request that named no license." };
      }
      if (res.status === 204 || res.status === 404) {
        await res.body?.cancel().catch(() => {});
        return { kind: "none", status: res.status };
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => {});
        return { kind: "unauthorized", status: res.status };
      }
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel().catch(() => {});
        return { kind: "unreachable", message: `The console answered ${res.status}.`, retryAfterMs: retryAfter(res.headers.get("retry-after"), now) };
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        return { kind: "error", message: `The console answered ${res.status}.` };
      }
      const body = await readCapped(res, MAX_BODY_BYTES);
      if (body === null) return { kind: "error", message: `The console's answer is larger than ${MAX_BODY_BYTES / 1024} KB; it was not read.` };
      const token = body.trim();
      if (!TOKEN_SHAPE.test(token)) return { kind: "error", message: "The console's answer is not a license (text/plain, one signed token)." };
      const etag = res.headers.get("etag")?.trim() || undefined;
      return { kind: "license", token, ...(etag && etag.length <= 200 ? { etag } : {}) };
    }
  } catch (e) {
    return { kind: "unreachable", message: `The console can't be reached: ${describeFailure(e, timeoutMs)}.` };
  }
}

// --- One check ------------------------------------------------------------------------------

const G = globalThis as unknown as {
  __compassLicensePull?: {
    inflight: Promise<CheckOutcome> | null;
    lastStartedAt: number;
    /** When Check now last asked (MIN_CHECK_GAP_MS applies between these). */
    lastManualAt: number;
    failures: number;
    /** The outcome last logged, so a repeated one is said once. */
    logged: string;
    deps: Partial<PullDeps> | null;
    token: CachedToken | null;
    tokenScope: string;
    started: boolean;
  };
};

function state() {
  return (G.__compassLicensePull ??= { inflight: null, lastStartedAt: 0, lastManualAt: 0, failures: 0, logged: "", deps: null, token: null, tokenScope: "", started: false });
}

async function defaultCredential(cfg: LicensePullConfig): Promise<string> {
  if (cfg.auth.kind === "token") return cfg.auth.token;
  const s = state();
  const scope = audienceScope(cfg.auth.audience);
  if (!s.token || s.tokenScope !== scope) {
    s.token = new CachedToken(scope);
    s.tokenScope = scope;
  }
  return s.token.get();
}

function deps(): PullDeps {
  const d = state().deps ?? {};
  return {
    fetch: d.fetch ?? fetch,
    parse: d.parse ?? parseLicense,
    now: d.now ?? Date.now,
    random: d.random ?? Math.random,
    credential: d.credential ?? defaultCredential,
    log: d.log ?? ((level, event, fields) => logEvent(level, event, fields)),
    timeoutMs: d.timeoutMs ?? FETCH_TIMEOUT_MS,
  };
}

/**
 * 1.22.0: the bearer credential the console's endpoints take: the same one
 * the licence request sends (lib/plan-report sends the daily usage with it).
 * Tests stand in for it through setLicensePullDepsForTests.
 */
export async function consoleCredential(cfg: LicensePullConfig): Promise<string> {
  return deps().credential(cfg);
}

/** Tests: stand in for the network, the clock, the credential or the verifier (null: the real ones). */
export function setLicensePullDepsForTests(d: Partial<PullDeps> | null): void {
  state().deps = d;
}

/** Tests: forget what this process knows (a restart). */
export function resetLicensePullForTests(): void {
  const deps = G.__compassLicensePull?.deps ?? null;
  G.__compassLicensePull = undefined;
  state().deps = deps;
}

export interface CheckOutcome {
  status: PullStatus;
  /** Set when the check did not run: Check now inside MIN_CHECK_GAP_MS (ms to wait). */
  retryInMs?: number;
  /** When the next scheduled check should run (ms from now). */
  nextInMs: number;
}

export async function readPullStatus(): Promise<PullStatus | null> {
  const raw = await getSetting(CLOUD_LICENSE_STATUS_SETTING);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as PullStatus;
    return o && typeof o.checkedAt === "string" && typeof o.result === "string" ? o : null;
  } catch {
    return null;
  }
}

function jittered(ms: number, share: number, random: () => number): number {
  return Math.round(ms * (1 - share + 2 * share * random()));
}

/** When to ask next, after an outcome: the interval on success, a backoff (or Retry-After) on failure. */
export function nextDelayMs(result: PullResult, failures: number, random: () => number, retryAfterMs?: number): number {
  if (result === "updated" || result === "unchanged" || result === "none") return jittered(PULL_INTERVAL_MS, PULL_JITTER, random);
  if (result === "rejected") return jittered(REJECTED_RETRY_MS, PULL_JITTER, random);
  if (retryAfterMs) return retryAfterMs;
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, Math.min(failures - 1, 20)));
  return jittered(base, 0.2, random);
}

/** The license in force and the console's last good one, read through `client` (inside the lock) or the pool. */
async function readLicenses(client?: { query: (t: string, p?: unknown[]) => Promise<{ rows: { key: string; value: string }[] }> }) {
  let stored: string | undefined;
  let managed: string | undefined;
  if (client) {
    const r = await client.query("SELECT key, value FROM settings WHERE key = ANY($1)", [["license_key", CLOUD_LICENSE_SETTING]]);
    for (const row of r.rows) {
      if (row.key === "license_key") stored = row.value;
      else managed = row.value;
    }
  } else {
    [stored, managed] = await Promise.all([getSetting("license_key"), getSetting(CLOUD_LICENSE_SETTING)]);
  }
  return { stored, managed };
}

async function writeStatus(s: PullStatus): Promise<void> {
  await withAdvisoryLock("license-cloud", async (client) => {
    await client.query("INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [
      CLOUD_LICENSE_STATUS_SETTING,
      JSON.stringify(s),
    ]);
  });
}

function sayOnce(key: string, level: "info" | "warn" | "error", event: string, message: string): void {
  const s = state();
  if (s.logged === key) return;
  s.logged = key;
  deps().log(level, event, { message });
}

/**
 * Ask the console now and act on the answer. One at a time per process
 * (a second caller shares the first's outcome); `manual` (Check now) is
 * refused inside MIN_CHECK_GAP_MS of the last request. Never throws.
 */
export function checkLicenseNow(trigger: "start" | "schedule" | "manual"): Promise<CheckOutcome> {
  const s = state();
  if (s.inflight) return s.inflight;
  const d = deps();
  const now = d.now();
  if (trigger === "manual" && now - s.lastManualAt < MIN_CHECK_GAP_MS) {
    const retryInMs = MIN_CHECK_GAP_MS - (now - s.lastManualAt);
    return readPullStatus()
      .catch(() => null)
      .then((status) => ({
        status: status ?? { checkedAt: new Date(s.lastManualAt).toISOString(), result: "unchanged", message: "Checked moments ago." },
        retryInMs,
        nextInMs: retryInMs,
      }));
  }
  s.lastStartedAt = now;
  if (trigger === "manual") s.lastManualAt = now;
  const p = runCheck().finally(() => {
    if (s.inflight === p) s.inflight = null;
  });
  s.inflight = p;
  return p;
}

async function runCheck(): Promise<CheckOutcome> {
  const s = state();
  const d = deps();
  const cfg = licensePullConfig();
  const nowIso = () => new Date(d.now()).toISOString();
  if (!cfg) {
    return { status: { checkedAt: nowIso(), result: "error", message: "COMPASSDOCS_LICENSE_URL is not configured." }, nextInMs: PULL_INTERVAL_MS };
  }
  let prev: PullStatus | null = null;
  try {
    prev = await readPullStatus();
  } catch {
    /* the database is down: carry on, the write below will say so */
  }
  const base: Pick<PullStatus, "contactedAt" | "updatedAt" | "etag"> = { contactedAt: prev?.contactedAt, updatedAt: prev?.updatedAt, etag: prev?.etag };
  let result: PullResult = "error";
  let message = "";
  let retryAfterMs: number | undefined;
  let etag = base.etag;
  let updatedAt = base.updatedAt;
  let contactedAt = base.contactedAt;
  let installed: string | null = null;

  let credential: string | null = null;
  try {
    credential = await d.credential(cfg);
  } catch (e) {
    const transient = (e as { transient?: boolean })?.transient === true;
    result = transient ? "unreachable" : "unauthorized";
    message = e instanceof Error ? e.message.split("\n")[0].slice(0, 300) : String(e);
  }

  if (credential !== null) {
    let held: string | undefined;
    try {
      held = (await readLicenses()).managed;
    } catch {
      held = undefined;
    }
    const out = await fetchLicense(cfg, credential, { etag: held?.trim() ? base.etag : undefined, fetchImpl: d.fetch, now: d.now(), timeoutMs: d.timeoutMs });
    switch (out.kind) {
      case "license": {
        contactedAt = nowIso();
        const r = await install(cfg, out.token, d);
        if (r.result === "updated") installed = out.token;
        result = r.result;
        message = r.message;
        if (r.result === "updated") updatedAt = nowIso();
        if (r.result === "updated" || r.result === "unchanged") etag = out.etag;
        break;
      }
      case "not_modified":
        contactedAt = nowIso();
        result = "unchanged";
        message = "The license in force is the console's latest.";
        break;
      case "none":
        contactedAt = nowIso();
        result = "none";
        message = `The console has no license for this workspace yet (${out.status}); the license in force is kept.`;
        break;
      case "unauthorized":
        result = "unauthorized";
        message = `The console refused the workspace's credential (${out.status}). Check ${
          cfg.auth.kind === "entra" ? "that the console accepts this workspace's managed identity for COMPASSDOCS_LICENSE_AUDIENCE" : "COMPASSDOCS_LICENSE_TOKEN"
        }.`;
        break;
      case "unreachable":
        result = "unreachable";
        message = out.message;
        retryAfterMs = out.retryAfterMs;
        break;
      default:
        result = "error";
        message = out.message;
    }
  }

  const ok = result === "updated" || result === "unchanged" || result === "none";
  s.failures = ok || result === "rejected" ? 0 : s.failures + 1;
  const status: PullStatus = { checkedAt: nowIso(), result: result, message: message, contactedAt, updatedAt, etag };
  try {
    await writeStatus(status);
  } catch {
    /* the database is down: the outcome is still logged */
  }

  // Logged once until it changes (a run of failures is one line; success after it is one more).
  if (result === "updated") {
    s.logged = "";
    d.log("info", "license.renewed", { message });
    const l = installed ? d.parse(installed).license : undefined;
    await audit({
      action: "license.renewed",
      targetLabel: l?.customer ?? null,
      details: l ? { plan: l.plan, issued: l.issued, expires: l.expires, source: "CompassDocs Cloud" } : null,
    });
  } else if (ok) {
    if (s.logged && s.logged !== "ok") sayOnce("ok", "info", "license.console_ok", "The CompassDocs console answers again; the license is current.");
    else s.logged = "ok";
  } else if (result === "unreachable") {
    sayOnce("unreachable", "warn", "license.console_unreachable", `${message} The license in force is kept; trying again with backoff.`);
  } else {
    sayOnce(`${result}:${message}`, result === "rejected" ? "warn" : "error", `license.console_${result}`, `${message} The license in force is kept.`);
  }
  return { status, nextInMs: nextDelayMs(result, s.failures, d.random, retryAfterMs) };
}

/** Judge a fetched license against the one in force and, when it is better, store it (under a lock, compared again). */
async function install(cfg: LicensePullConfig, token: string, d: PullDeps): Promise<{ result: PullResult; message: string }> {
  const now = new Date(d.now());
  try {
    return await withAdvisoryLock("license-cloud", async (client) => {
      const { stored, managed } = await readLicenses(client as never);
      // The license in force by lib/license's own pick (with this module's verifier: parseLicense in the app).
      const current = pickLicenseKey(licenseCandidates(stored, managed), d.parse);
      const j = judgeLicense(token, current, cfg.workspaceId, now, d.parse);
      if (!j.accept) return { result: j.reason === "unchanged" ? "unchanged" : "rejected", message: j.message };
      await client.query("INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [
        CLOUD_LICENSE_SETTING,
        token,
      ]);
      const before = current ? d.parse(current).license : undefined;
      return {
        result: "updated",
        message: `Installed the license from CompassDocs Cloud: it expires ${day(j.license.expires)}${
          before ? ` (the one before expired ${day(before.expires)})` : ""
        }.`,
      };
    });
  } catch (e) {
    return { result: "error", message: `The license could not be saved: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` };
  }
}

// --- The schedule ------------------------------------------------------------------------------

/**
 * Start asking the console (instrumentation, cloud mode with
 * COMPASSDOCS_LICENSE_URL): shortly after start, then by nextDelayMs. A
 * scheduled check is skipped when another replica checked successfully
 * within three quarters of the interval (a start, within 5 minutes).
 * Stops with the drain (lib/shutdown after/runJob).
 */
export function startLicensePull(): void {
  const s = state();
  if (s.started || !licensePullConfig()) return;
  s.started = true;
  const d = deps();
  schedule("start", START_DELAY_MS + Math.round(d.random() * 10_000));
}

function schedule(trigger: "start" | "schedule", ms: number): void {
  after(ms, () =>
    runJob("license-pull", async () => {
      let next = PULL_INTERVAL_MS;
      try {
        const d = deps();
        const fresh = trigger === "start" ? 5 * 60_000 : PULL_INTERVAL_MS * 0.75;
        const last = await readPullStatus().catch(() => null);
        const lastOk = last && (last.result === "updated" || last.result === "unchanged" || last.result === "none");
        const age = last ? d.now() - Date.parse(last.checkedAt) : Infinity;
        if (lastOk && age >= 0 && age < fresh) {
          next = jittered(PULL_INTERVAL_MS - age, PULL_JITTER, d.random);
        } else {
          next = (await checkLicenseNow(trigger)).nextInMs;
        }
      } finally {
        schedule("schedule", Math.max(BACKOFF_MIN_MS / 2, next));
      }
    })
  );
}
