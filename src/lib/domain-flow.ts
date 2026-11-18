// Saving a custom domain without locking anyone out (1.20.29).
//
// Settings → Domain & HTTPS and the first-run wizard both come through
// saveDomainSettings. A new domain (or a new TLS mode for it) is checked
// first (lib/domain-check) whenever the bundled proxy is managed:
//
//   - it fails: NOT pushed. The proxy keeps serving the current address and
//     the request waits as the pending domain (settings key
//     `custom_domain_pending`, JSON, phase "waiting") with the reason.
//     custom_domain keeps the address that works, so links (lib/workspace-
//     origin) never point at a name that doesn't answer (domain.check_failed);
//   - it passes: the proxy is switched FIRST, to a transitional config that
//     serves the new domain and still serves the app on plain HTTP for any
//     other name (lib/caddy). A refused push changes nothing and the request
//     keeps waiting with the proxy's error. With TLS on, the row moves to
//     phase "verifying": the new domain is asked over HTTPS, at the address
//     the check proved, every ten seconds for two minutes while Caddy gets
//     its certificate (finishVerification). Only when that answers are the
//     settings switched (custom_domain, a certificate pasted with the
//     request), the final config pushed (plain HTTP on other names now
//     redirects to https://<domain>) and the switch audited (domain.applied).
//     If it never answers, the previous config is pushed back and the
//     request waits again with the reason (domain.rolled_back), its
//     automatic re-checks stopped until Check again;
//   - "Use it anyway" (force): saved and pushed without the check or the
//     HTTPS verification, for a setup the check can't see (domain.forced).
//
// A waiting domain is checked again in the background every five minutes
// for 24 hours (recheckPendingDomain, from the minute tick in
// instrumentation.ts), and at once with "Check again" (which also restarts
// the 24 hours). When one of those goes live, every administrator, and
// whoever asked, gets a bell notice. Each step is claimed with a
// compare-and-swap on the settings row, so two instances never check or
// apply the same request twice, and a request replaced while its check ran
// is never applied.
//
// Saving also remembers the hostname the admin was browsing on as a
// fallback address (lib/fallback-hosts) when it is a DNS name other than
// the new domain; it gets a public certificate only if it passes the same
// reachability check.
//
// Server-only.

import "server-only";
import { dbReady, pool } from "./db";
import { getAppSettings, updateAppSettings } from "./settings-store";
import { normalizeDomain, TLS_MODES, type SecureCookieMode, type TlsMode } from "./settings";
import {
  applyProxyConfig,
  clearPendingCert,
  hasCustomCert,
  promotePendingCert,
  proxyManaged,
  proxyStatus,
  storeCustomCert,
  storePendingCert,
  PENDING_KEY,
  type ApplyResult,
  type CaddyfileOptions,
  type ProxyTarget,
} from "./caddy";
import { checkDomain, checkMessage, verifyHttpsOnce, type DomainCheckResult, type HttpsVerifyResult } from "./domain-check";
import { audit, type AuditActor } from "./audit";
import {
  fallbackHostFromHostHeader,
  fallbackHosts,
  rememberFallbackHost,
  wouldRememberFallbackHost,
  type FallbackHost,
} from "./fallback-hosts";

export { PENDING_KEY };
export const RECHECK_INTERVAL_MS = 5 * 60_000;
export const RECHECK_WINDOW_MS = 24 * 60 * 60_000;
/** How long HTTPS on a switched domain may take to answer (Caddy getting its certificate). */
export const VERIFY_WINDOW_MS = 2 * 60_000;
export const VERIFY_POLL_MS = 10_000;

type SwitchOrigin = "settings" | "setup" | "background" | "check_again";

export interface PendingDomain {
  domain: string;
  tls_mode: TlsMode;
  tls_email: string;
  /** A certificate pasted with the request waits beside it (lib/caddy storePendingCert). */
  has_cert?: boolean;
  requested_at: string;
  requested_by: { id: number | null; name: string };
  /** Background re-checks run until then; Check again restarts the window. */
  auto_until: string;
  next_check_at: string;
  attempts: number;
  last_check: DomainCheckResult;
  /** "waiting" for its check (absent on rows written before the phase existed), or "verifying" HTTPS after the switch. */
  phase?: "waiting" | "verifying";
  verify?: { address: string; until: string; origin: SwitchOrigin };
}

export interface DomainFlowDeps {
  check: (domain: string, mode: TlsMode) => Promise<DomainCheckResult>;
  /** Push a config: the saved settings (no target), or a target being verified. */
  apply: (target?: ProxyTarget, opts?: CaddyfileOptions) => Promise<ApplyResult>;
  /** One HTTPS attempt on a switched domain at the checked address. */
  verifyHttps: (domain: string, mode: TlsMode, address: string) => Promise<HttpsVerifyResult>;
  managed: () => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Run the HTTPS verification after the response returns (tests run it inline). */
  schedule: (job: () => Promise<unknown>) => void;
  /** The bell notice that a waiting domain went live. */
  notifyLive: (domain: string, requestedBy: number | null) => Promise<void>;
}

async function notifyLiveDefault(domain: string, requestedBy: number | null): Promise<void> {
  const { notify } = await import("./notifications");
  const r = await pool().query<{ id: number }>("SELECT id FROM users WHERE role = 'admin' AND status = 'active'");
  const ids = r.rows.map((x) => x.id);
  if (requestedBy) ids.push(requestedBy);
  await notify(ids, {
    kind: "service_status",
    event: "domain_live",
    title: `${domain} is live`,
    body: "The custom domain passed its check and the proxy now serves it.",
    link: "/admin/domain",
  });
}

const DEFAULT_DEPS: DomainFlowDeps = {
  check: (d, m) => checkDomain(d, m),
  apply: (t, o) => applyProxyConfig(t, o),
  verifyHttps: (d, m, a) => verifyHttpsOnce(d, m, a),
  managed: proxyManaged,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  schedule: (job) => {
    void job().catch((e) => console.error("[domain] HTTPS verification error:", e));
  },
  notifyLive: notifyLiveDefault,
};

function withDefaults(deps: Partial<DomainFlowDeps> | undefined): DomainFlowDeps {
  return { ...DEFAULT_DEPS, ...(deps ?? {}) };
}

// --- The pending row ------------------------------------------------------------------

function parsePending(raw: string | undefined | null): PendingDomain | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PendingDomain;
    if (!p || typeof p.domain !== "string" || !normalizeDomain(p.domain)) return null;
    if (!TLS_MODES.includes(p.tls_mode)) return null;
    if (p.phase === "verifying" && !p.verify?.address) return null;
    return p;
  } catch {
    return null;
  }
}

async function readPendingRaw(): Promise<{ raw: string; pending: PendingDomain } | null> {
  // Read the stored text itself (not getSetting's opened value): the
  // compare-and-swap below matches on it.
  await dbReady();
  const r = await pool().query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [PENDING_KEY]);
  const raw = r.rows[0]?.value;
  const pending = parsePending(raw);
  return raw && pending ? { raw, pending } : null;
}

/** The domain waiting for its check (or having its HTTPS verified), or null. */
export async function getPendingDomain(): Promise<PendingDomain | null> {
  return (await readPendingRaw())?.pending ?? null;
}

async function writePending(p: PendingDomain): Promise<string> {
  const raw = JSON.stringify(p);
  await pool().query(
    "INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [PENDING_KEY, raw]
  );
  return raw;
}

/** Replace the row only if it still holds `expected`. The new text when it did. */
async function swapPending(expected: string, next: PendingDomain): Promise<string | null> {
  const raw = JSON.stringify(next);
  const r = await pool().query("UPDATE settings SET value = $3 WHERE key = $1 AND value = $2", [PENDING_KEY, expected, raw]);
  return r.rowCount ? raw : null;
}

async function deletePending(expected?: string): Promise<boolean> {
  const r = expected
    ? await pool().query("DELETE FROM settings WHERE key = $1 AND value = $2", [PENDING_KEY, expected])
    : await pool().query("DELETE FROM settings WHERE key = $1", [PENDING_KEY]);
  return !!r.rowCount;
}

/** A result for a failure the flow found after the check itself passed. */
function laterFailure(p: PendingDomain, code: DomainCheckResult["code"], now: number, address: string | null, detail?: string): DomainCheckResult {
  const tried = address ? [address] : p.last_check.tried;
  const base = { code, domain: p.domain, cname: p.last_check.cname, addresses: p.last_check.addresses, tried };
  return { ...base, ok: false, message: checkMessage({ ...base, detail }, p.tls_mode), checked_at: new Date(now).toISOString() };
}

// --- Switching -------------------------------------------------------------------------------

interface SwitchResult {
  status: "applied" | "verifying" | "pending" | "superseded";
  applied: boolean;
  proxyError?: string;
  pending: PendingDomain | null;
}

/**
 * The settings change itself, after HTTPS answered (or with TLS off): the
 * domain triple, a certificate pasted with it, the final config, the audit
 * row and, for a switch nobody was watching, the bell.
 */
async function commitSwitch(p: PendingDomain, origin: SwitchOrigin, d: DomainFlowDeps, actor: AuditActor, ip: string | null | undefined, https: boolean): Promise<ApplyResult> {
  await updateAppSettings({ custom_domain: p.domain, tls_mode: p.tls_mode, tls_email: p.tls_email });
  if (p.has_cert) await promotePendingCert();
  const final = await d.apply();
  await audit({
    actor,
    action: "domain.applied",
    targetType: "domain",
    targetLabel: p.domain,
    details: {
      domain: p.domain,
      tls_mode: p.tls_mode,
      addresses: p.last_check.addresses,
      applied: final.ok,
      https_verified: https,
      via: origin,
      attempts: p.attempts,
      requested_by: p.requested_by.name,
    },
    ip: ip ?? null,
  });
  if (origin === "background" || origin === "check_again") {
    try {
      await d.notifyLive(p.domain, p.requested_by.id);
    } catch (e) {
      console.error("[domain] could not send the go-live notice:", e);
    }
  }
  return final;
}

/**
 * Switch the proxy to a request whose check passed. `expectedRaw`: the row
 * as claimed (a re-check), so a request replaced meanwhile isn't applied;
 * null for a fresh save, which owns the row.
 */
async function switchTo(
  p: PendingDomain,
  check: DomainCheckResult,
  origin: SwitchOrigin,
  d: DomainFlowDeps,
  actor: AuditActor,
  ip: string | null | undefined,
  expectedRaw: string | null
): Promise<SwitchResult> {
  const now = d.now();
  const target: ProxyTarget = { domain: p.domain, tls_mode: p.tls_mode, tls_email: p.tls_email, cert: p.has_cert ? "pending" : "live" };
  const store = async (next: PendingDomain | null): Promise<boolean> => {
    if (expectedRaw === null) {
      if (next) await writePending(next);
      else await deletePending();
      return true;
    }
    return next ? !!(await swapPending(expectedRaw, next)) : await deletePending(expectedRaw);
  };

  // Push first; nothing is saved unless the proxy took it (review M4).
  const res = await d.apply(target, p.tls_mode === "off" ? {} : { transitional: true });
  if (!res.ok) {
    const waiting: PendingDomain = { ...p, phase: "waiting", verify: undefined, last_check: laterFailure(p, "proxy_error", now, null, res.error) };
    if (!(await store(waiting))) return { status: "superseded", applied: false, pending: await getPendingDomain() };
    return { status: "pending", applied: false, proxyError: res.error, pending: waiting };
  }

  if (p.tls_mode === "off") {
    // TLS is terminated elsewhere: nothing on 443 to verify.
    if (!(await store(null))) {
      await d.apply();
      return { status: "superseded", applied: false, pending: await getPendingDomain() };
    }
    const final = await commitSwitch(p, origin, d, actor, ip, false);
    return { status: "applied", applied: final.ok, proxyError: final.ok ? undefined : final.error, pending: null };
  }

  const verifying: PendingDomain = {
    ...p,
    phase: "verifying",
    verify: { address: check.tried[0] ?? check.addresses[0], until: new Date(now + VERIFY_WINDOW_MS).toISOString(), origin },
  };
  if (!(await store(verifying))) {
    await d.apply(); // whatever the row says now
    return { status: "superseded", applied: false, pending: await getPendingDomain() };
  }
  d.schedule(() => finishVerification({ actor, ip }, d));
  return { status: "verifying", applied: true, pending: verifying };
}

export interface VerifyOutcome {
  status: "none" | "applied" | "rolled_back" | "superseded";
  pending?: PendingDomain | null;
}

/**
 * Ask the switched domain over HTTPS until it answers or its two minutes
 * are up, then keep it (commit) or go back (roll back). Run after the
 * response by switchTo, and by the minute tick for a verification whose
 * process died (one attempt, past its deadline).
 */
export async function finishVerification(
  opts: { actor?: AuditActor; ip?: string | null } = {},
  deps?: Partial<DomainFlowDeps>
): Promise<VerifyOutcome> {
  const d = withDefaults(deps);
  const row = await readPendingRaw();
  if (!row || row.pending.phase !== "verifying" || !row.pending.verify) return { status: "none" };
  const { raw, pending: p } = row;
  const v = p.verify!;
  let r: HttpsVerifyResult;
  for (;;) {
    r = await d.verifyHttps(p.domain, p.tls_mode, v.address);
    if (r.ok || d.now() >= Date.parse(v.until)) break;
    await d.sleep(VERIFY_POLL_MS);
  }
  const actor: AuditActor = v.origin === "background" ? { name: "system" } : opts.actor ?? { name: "system" };

  if (r.ok) {
    // Narrow window (review L4, left as is): an admin's save landing between
    // this delete and the settings write below is overwritten by this switch.
    if (!(await deletePending(raw))) return { status: "superseded", pending: await getPendingDomain() };
    await commitSwitch(p, v.origin, d, actor, opts.ip, true);
    return { status: "applied", pending: null };
  }

  const now = d.now();
  const code = r.code === "internal_error" ? "https_certificate" : r.code;
  const back: PendingDomain = {
    ...p,
    phase: "waiting",
    verify: undefined,
    last_check: laterFailure(p, code, now, v.address, r.detail),
    next_check_at: new Date(now + RECHECK_INTERVAL_MS).toISOString(),
    // Stop the automatic re-checks: each would switch, ask Let's Encrypt
    // again and roll back, into its rate limits. Check again restarts them.
    auto_until: new Date(now).toISOString(),
  };
  if (!(await swapPending(raw, back))) return { status: "superseded", pending: await getPendingDomain() };
  await d.apply(); // the saved settings: the previous address
  await audit({
    actor,
    action: "domain.rolled_back",
    targetType: "domain",
    targetLabel: p.domain,
    details: { domain: p.domain, tls_mode: p.tls_mode, code, reason: back.last_check.message, via: v.origin },
    ip: opts.ip ?? null,
  });
  return { status: "rolled_back", pending: back };
}

// --- Saving ---------------------------------------------------------------------------------

export interface DomainSaveInput {
  /** The domain as entered (validated by the caller; normalised here). "" clears it. */
  domain: string;
  tls_mode?: TlsMode;
  /** Validated by the caller (settings validTlsEmail). */
  tls_email?: string;
  /** A certificate and key pasted with the save (validated by the caller). */
  cert?: { cert: string; key: string };
  /** "Use it anyway": skip the check. */
  force?: boolean;
  actor: AuditActor;
  ip?: string | null;
  /** The request's Host header, for the remembered fallback address. */
  hostHeader?: string | null;
  via: "settings" | "setup";
}

export interface DomainSaveOutcome {
  /**
   * applied: checked and switched; verifying: checked, switched, HTTPS
   * being verified (the settings follow when it answers); pending: not
   * switched (the check failed, or the proxy refused); forced: switched
   * without the check; saved: no check was needed.
   */
  outcome: "applied" | "verifying" | "pending" | "forced" | "saved";
  /** Whether the proxy took a new config. */
  applied: boolean;
  proxyError?: string;
  check?: DomainCheckResult;
  pending: PendingDomain | null;
  /** The hostname newly remembered as a fallback, if any. */
  remembered_fallback: string | null;
}

/**
 * Save the domain/TLS triple: checked and switched, forced, left pending,
 * or (nothing to switch) saved. The caller saved everything else (cookies)
 * already; a pasted certificate comes in `cert` and is stored with the
 * outcome: live when the switch is immediate, with the request otherwise.
 */
export async function saveDomainSettings(input: DomainSaveInput, deps?: Partial<DomainFlowDeps>): Promise<DomainSaveOutcome> {
  const d = withDefaults(deps);
  const cur = await getAppSettings();
  const domain = normalizeDomain(input.domain ?? "");
  const mode: TlsMode = input.tls_mode && TLS_MODES.includes(input.tls_mode) ? input.tls_mode : cur.tls_mode;
  const email = (input.tls_email ?? cur.tls_email).trim().slice(0, 254);
  const changing = domain !== cur.custom_domain || mode !== cur.tls_mode;
  const managed = d.managed();
  const existing = await readPendingRaw();
  const actor = input.actor;
  const origin: SwitchOrigin = input.via;

  // The same waiting request saved again (the form shows it): that is
  // Check again, without restarting its 24 hours or writing another
  // check_failed row (review L5).
  if (managed && domain && changing && !input.force && existing && existing.pending.domain === domain && existing.pending.tls_mode === mode) {
    if (existing.pending.phase === "verifying") {
      return { outcome: "verifying", applied: true, pending: existing.pending, remembered_fallback: null };
    }
    if (input.cert || existing.pending.tls_email !== email) {
      if (input.cert) await storePendingCert(input.cert.cert, input.cert.key);
      await swapPending(existing.raw, { ...existing.pending, tls_email: email, has_cert: existing.pending.has_cert || !!input.cert });
    }
    const r = await recheckPendingDomain({ manual: true, quiet: true, actor, ip: input.ip, origin }, d);
    const outcome = r.status === "applied" ? "applied" : r.status === "verifying" ? "verifying" : "pending";
    return { outcome, applied: !!r.applied, proxyError: r.proxyError, check: r.check, pending: r.pending ?? null, remembered_fallback: null };
  }

  // The way back in: the DNS name the admin is on now keeps working. It
  // gets a public certificate only if it passes the reachability check.
  let candidate: string | null = null;
  if (domain && changing) {
    const host = fallbackHostFromHostHeader(input.hostHeader);
    if (host && host !== domain && (await wouldRememberFallbackHost(host))) candidate = host;
  }
  const candidateCheck = candidate && managed ? d.check(candidate, "auto").catch(() => null) : Promise.resolve(null);
  const remember = async (): Promise<string | null> => {
    if (!candidate) return null;
    const c = await candidateCheck;
    return (await rememberFallbackHost(candidate, !!c?.ok)) ? candidate : null;
  };

  // Nothing to check: no proxy to switch, no domain, the same domain and
  // mode (a re-apply, a new email or certificate), or "Use it anyway".
  if (!managed || !domain || !changing || input.force) {
    if (input.cert) await storeCustomCert(input.cert.cert, input.cert.key);
    await updateAppSettings({ custom_domain: domain, tls_mode: mode, tls_email: email });
    if (existing) {
      await deletePending(existing.raw);
      await clearPendingCert();
      // Dropped by a save for something else: say so in the log.
      if (!(input.force && existing.pending.domain === domain)) {
        await audit({
          actor,
          action: "domain.pending_discarded",
          targetType: "domain",
          targetLabel: existing.pending.domain,
          details: { domain: existing.pending.domain, tls_mode: existing.pending.tls_mode, attempts: existing.pending.attempts, replaced_by: domain || null },
          ip: input.ip ?? null,
        });
      }
    }
    const remembered = await remember();
    const applied = await d.apply();
    const forced = !!input.force && managed && !!domain && changing;
    if (forced) {
      await audit({
        actor,
        action: "domain.forced",
        targetType: "domain",
        targetLabel: domain,
        details: { domain, tls_mode: mode, applied: applied.ok, via: input.via, previous: cur.custom_domain || null },
        ip: input.ip ?? null,
      });
    }
    return {
      outcome: forced ? "forced" : "saved",
      applied: applied.ok,
      proxyError: applied.ok ? undefined : applied.error,
      pending: null,
      remembered_fallback: remembered,
    };
  }

  // A new request: its certificate waits with it.
  if (input.cert) await storePendingCert(input.cert.cert, input.cert.key);
  else await clearPendingCert();
  const [check] = await Promise.all([d.check(domain, mode), candidateCheck]);
  const remembered = await remember();
  const now = d.now();
  const pending: PendingDomain = {
    domain,
    tls_mode: mode,
    tls_email: email,
    has_cert: !!input.cert,
    requested_at: new Date(now).toISOString(),
    requested_by: { id: actor.id ?? null, name: actor.name ?? "system" },
    auto_until: new Date(now + RECHECK_WINDOW_MS).toISOString(),
    next_check_at: new Date(now + RECHECK_INTERVAL_MS).toISOString(),
    attempts: 1,
    last_check: check,
    phase: "waiting",
  };

  if (check.ok) {
    const r = await switchTo(pending, check, origin, d, actor, input.ip, null);
    const outcome = r.status === "applied" ? "applied" : r.status === "verifying" ? "verifying" : "pending";
    return { outcome, applied: r.applied, proxyError: r.proxyError, check, pending: r.pending, remembered_fallback: remembered };
  }

  await writePending(pending);
  // It replaced a switch being verified: back to the saved config.
  if (existing?.pending.phase === "verifying") await d.apply();
  await audit({
    actor,
    action: "domain.check_failed",
    targetType: "domain",
    targetLabel: domain,
    details: { domain, tls_mode: mode, code: check.code, reason: check.message, addresses: check.addresses, cname: check.cname, via: input.via },
    ip: input.ip ?? null,
  });
  return { outcome: "pending", applied: false, check, pending, remembered_fallback: remembered };
}

// --- Checking again ---------------------------------------------------------------------

export interface RecheckOutcome {
  status: "none" | "waiting" | "busy" | "superseded" | "pending" | "verifying" | "applied" | "rolled_back";
  check?: DomainCheckResult;
  pending?: PendingDomain | null;
  applied?: boolean;
  proxyError?: string;
}

/**
 * Check the waiting domain again. Background (`manual` false): only when
 * its next check is due and inside its 24 hours; also finishes a HTTPS
 * verification whose process died. Manual ("Check again"): now, and a
 * failure restarts the 24 hours and is audited, unless `quiet` (the same
 * request saved again). Switches it when it passes.
 */
export async function recheckPendingDomain(
  opts: { manual?: boolean; quiet?: boolean; actor?: AuditActor; ip?: string | null; origin?: SwitchOrigin } = {},
  deps?: Partial<DomainFlowDeps>
): Promise<RecheckOutcome> {
  const d = withDefaults(deps);
  const row = await readPendingRaw();
  if (!row) return { status: "none" };
  const { raw, pending: p } = row;
  const now = d.now();

  if (p.phase === "verifying") {
    // Its own process finishes it; a minute past the deadline, it died.
    if (!opts.manual && p.verify && now > Date.parse(p.verify.until) + 60_000) {
      const v = await finishVerification({ actor: opts.actor, ip: opts.ip }, d);
      return { status: v.status === "none" ? "none" : v.status === "applied" ? "applied" : v.status === "rolled_back" ? "rolled_back" : "superseded", pending: v.pending };
    }
    return { status: "verifying", pending: p };
  }
  if (!opts.manual && (now < Date.parse(p.next_check_at) || now > Date.parse(p.auto_until))) {
    return { status: "waiting", pending: p };
  }

  // Claim this check: push the next one out first, so another instance's
  // minute tick (or a second click) does not run it too.
  const claimed: PendingDomain = { ...p, next_check_at: new Date(now + RECHECK_INTERVAL_MS).toISOString() };
  const claimedRaw = await swapPending(raw, claimed);
  if (!claimedRaw) return { status: "busy", pending: await getPendingDomain() };

  const check = await d.check(p.domain, p.tls_mode);
  const actor: AuditActor = opts.actor ?? { name: "system" };
  const next: PendingDomain = { ...claimed, attempts: p.attempts + 1, last_check: check };

  if (check.ok) {
    const origin: SwitchOrigin = opts.origin ?? (opts.manual ? "check_again" : "background");
    const r = await switchTo(next, check, origin, d, actor, opts.ip, claimedRaw);
    return { status: r.status, check, applied: r.applied, proxyError: r.proxyError, pending: r.pending };
  }

  const failed: PendingDomain = {
    ...next,
    ...(opts.manual && !opts.quiet ? { auto_until: new Date(now + RECHECK_WINDOW_MS).toISOString() } : {}),
  };
  const nextRaw = await swapPending(claimedRaw, failed);
  if (opts.manual && !opts.quiet) {
    await audit({
      actor,
      action: "domain.check_failed",
      targetType: "domain",
      targetLabel: p.domain,
      details: { domain: p.domain, tls_mode: p.tls_mode, code: check.code, reason: check.message, addresses: check.addresses, cname: check.cname, via: "check_again" },
      ip: opts.ip ?? null,
    });
  }
  return { status: nextRaw ? "pending" : "superseded", check, pending: nextRaw ? failed : await getPendingDomain() };
}

/** "Keep the current address": drop the waiting domain. True when there was one. */
export async function discardPendingDomain(actor: AuditActor, ip?: string | null, deps?: Partial<DomainFlowDeps>): Promise<boolean> {
  const d = withDefaults(deps);
  const row = await readPendingRaw();
  if (!row || !(await deletePending(row.raw))) return false;
  await clearPendingCert();
  if (row.pending.phase === "verifying") await d.apply(); // back to the saved config
  await audit({
    actor,
    action: "domain.pending_discarded",
    targetType: "domain",
    targetLabel: row.pending.domain,
    details: { domain: row.pending.domain, tls_mode: row.pending.tls_mode, attempts: row.pending.attempts },
    ip: ip ?? null,
  });
  return true;
}

// --- What the Domain & HTTPS page shows ----------------------------------------------

export interface DomainState {
  custom_domain: string;
  tls_mode: TlsMode;
  tls_email: string;
  secure_cookies: SecureCookieMode;
  has_custom_cert: boolean;
  proxy: { managed: boolean; reachable: boolean };
  /** The domain waiting for its check, or having its HTTPS verified. */
  pending: PendingDomain | null;
  /** The addresses the proxy also serves while a custom domain is applied ("Also reachable at"). */
  fallbacks: FallbackHost[];
}

/** The page's state. The certificate and key are write-only: only whether one is stored. */
export async function domainState(): Promise<DomainState> {
  const s = await getAppSettings();
  const [proxy, customCert, pending, fallbacks] = await Promise.all([
    proxyStatus(),
    hasCustomCert(),
    getPendingDomain(),
    // Before a domain is applied every address reaches the app; the list
    // means something only once the proxy serves named sites.
    s.custom_domain ? fallbackHosts(s.custom_domain) : Promise.resolve([] as FallbackHost[]),
  ]);
  return {
    custom_domain: s.custom_domain,
    tls_mode: s.tls_mode,
    tls_email: s.tls_email,
    secure_cookies: s.secure_cookies,
    has_custom_cert: customCert,
    proxy,
    pending,
    fallbacks,
  };
}
