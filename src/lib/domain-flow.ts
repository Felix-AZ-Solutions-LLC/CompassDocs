// Saving a custom domain without locking anyone out (1.20.29).
//
// Settings → Domain & HTTPS and the first-run wizard both come through
// saveDomainSettings. A new domain (or a new TLS mode for it) is checked
// first (lib/domain-check) whenever the bundled proxy is managed:
//
//   - it passes: saved and pushed to the proxy, as before (domain.applied);
//   - it fails: NOT pushed. The proxy keeps serving the current address,
//     and the request waits as the pending domain (settings key
//     `custom_domain_pending`, JSON) with the reason. custom_domain keeps
//     the address that works, so links (lib/workspace-origin) never point
//     at a name that does not answer yet (domain.check_failed);
//   - "Use it anyway" (force): saved and pushed without the check, for a
//     setup the check cannot see (a proxy in front, split DNS) (domain.forced).
//
// A pending domain is checked again in the background every five minutes
// for 24 hours (recheckPendingDomain, from the minute tick in
// instrumentation.ts), and at once with "Check again" (which also restarts
// the 24 hours). When it passes it is applied and every administrator, and
// whoever asked, gets a bell notice. Each step is claimed with a
// compare-and-swap on the settings row, so two instances never check or
// apply the same request twice, and a request replaced while its check ran
// is never applied.
//
// Saving also remembers the hostname the admin was browsing on as a
// fallback address (lib/fallback-hosts) when it is a DNS name other than
// the new domain.
//
// Server-only.

import "server-only";
import { dbReady, pool } from "./db";
import { getAppSettings, updateAppSettings } from "./settings-store";
import { normalizeDomain, TLS_MODES, type TlsMode } from "./settings";
import { applyProxyConfig, hasCustomCert, proxyManaged, proxyStatus, type ApplyResult } from "./caddy";
import { checkDomain, type DomainCheckResult } from "./domain-check";
import { audit, type AuditActor } from "./audit";
import { fallbackHostFromHostHeader, fallbackHosts, rememberFallbackHost, type FallbackHost } from "./fallback-hosts";

export const PENDING_KEY = "custom_domain_pending";
export const RECHECK_INTERVAL_MS = 5 * 60_000;
export const RECHECK_WINDOW_MS = 24 * 60 * 60_000;

export interface PendingDomain {
  domain: string;
  tls_mode: TlsMode;
  tls_email: string;
  requested_at: string;
  requested_by: { id: number | null; name: string };
  /** Background re-checks run until then; Check again restarts the window. */
  auto_until: string;
  next_check_at: string;
  attempts: number;
  last_check: DomainCheckResult;
}

export interface DomainFlowDeps {
  check: (domain: string, mode: TlsMode) => Promise<DomainCheckResult>;
  apply: () => Promise<ApplyResult>;
  managed: () => boolean;
  now: () => number;
  /** The bell notice that a pending domain went live. */
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
  apply: applyProxyConfig,
  managed: proxyManaged,
  now: () => Date.now(),
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

/** The domain waiting for its check, or null. */
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

/** Replace the row only if it still holds `expected`. True when it did. */
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

// --- Saving ---------------------------------------------------------------------------------

export interface DomainSaveInput {
  /** The domain as entered (validated by the caller; normalised here). "" clears it. */
  domain: string;
  tls_mode?: TlsMode;
  tls_email?: string;
  /** "Use it anyway": skip the check. */
  force?: boolean;
  actor: AuditActor;
  ip?: string | null;
  /** The request's Host header, for the remembered fallback address. */
  hostHeader?: string | null;
  via: "settings" | "setup";
}

export interface DomainSaveOutcome {
  /** applied: checked and switched; pending: the check failed, nothing switched; forced: switched without the check; saved: no check was needed. */
  outcome: "applied" | "pending" | "forced" | "saved";
  /** Whether the proxy took a new config. */
  applied: boolean;
  proxyError?: string;
  check?: DomainCheckResult;
  pending: PendingDomain | null;
  /** The hostname newly remembered as a fallback, if any. */
  remembered_fallback: string | null;
}

/**
 * Save the domain/TLS triple: checked, switched, forced or left pending.
 * The caller saved everything else (cookies, a pasted certificate) already.
 */
export async function saveDomainSettings(input: DomainSaveInput, deps?: Partial<DomainFlowDeps>): Promise<DomainSaveOutcome> {
  const d = withDefaults(deps);
  const cur = await getAppSettings();
  const domain = normalizeDomain(input.domain ?? "");
  const mode: TlsMode = input.tls_mode && TLS_MODES.includes(input.tls_mode) ? input.tls_mode : cur.tls_mode;
  const email = (input.tls_email ?? cur.tls_email).trim().slice(0, 254);
  const changing = domain !== cur.custom_domain || mode !== cur.tls_mode;
  const managed = d.managed();

  // The way back in: the DNS name the admin is on now keeps working.
  let remembered: string | null = null;
  if (domain && changing) {
    const host = fallbackHostFromHostHeader(input.hostHeader);
    if (host && host !== domain && (await rememberFallbackHost(host))) remembered = host;
  }

  const switchNow = async (): Promise<ApplyResult> => {
    await updateAppSettings({ custom_domain: domain, tls_mode: mode, tls_email: email });
    await deletePending();
    return d.apply();
  };

  // Nothing to check: no proxy to switch, no domain, or the same domain and
  // mode (a re-apply, a new email or certificate).
  if (!managed || !domain || !changing) {
    const applied = await switchNow();
    return { outcome: "saved", applied: applied.ok, proxyError: applied.ok ? undefined : applied.error, pending: null, remembered_fallback: remembered };
  }

  if (input.force) {
    const applied = await switchNow();
    await audit({
      actor: input.actor,
      action: "domain.forced",
      targetType: "domain",
      targetLabel: domain,
      details: { domain, tls_mode: mode, applied: applied.ok, via: input.via, previous: cur.custom_domain || null },
      ip: input.ip ?? null,
    });
    return { outcome: "forced", applied: applied.ok, proxyError: applied.ok ? undefined : applied.error, pending: null, remembered_fallback: remembered };
  }

  const check = await d.check(domain, mode);
  if (check.ok) {
    const applied = await switchNow();
    await audit({
      actor: input.actor,
      action: "domain.applied",
      targetType: "domain",
      targetLabel: domain,
      details: { domain, tls_mode: mode, addresses: check.addresses, applied: applied.ok, via: input.via, previous: cur.custom_domain || null },
      ip: input.ip ?? null,
    });
    return { outcome: "applied", applied: applied.ok, proxyError: applied.ok ? undefined : applied.error, check, pending: null, remembered_fallback: remembered };
  }

  const now = d.now();
  const pending: PendingDomain = {
    domain,
    tls_mode: mode,
    tls_email: email,
    requested_at: new Date(now).toISOString(),
    requested_by: { id: input.actor.id ?? null, name: input.actor.name ?? "system" },
    auto_until: new Date(now + RECHECK_WINDOW_MS).toISOString(),
    next_check_at: new Date(now + RECHECK_INTERVAL_MS).toISOString(),
    attempts: 1,
    last_check: check,
  };
  await writePending(pending);
  await audit({
    actor: input.actor,
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
  status: "none" | "waiting" | "busy" | "superseded" | "pending" | "applied";
  check?: DomainCheckResult;
  pending?: PendingDomain | null;
  applied?: boolean;
  proxyError?: string;
}

/**
 * Check the pending domain again. Background (`manual` false): only when
 * its next check is due and inside its 24 hours. Manual ("Check again"):
 * now, and a failure restarts the 24 hours. Applies it when it passes.
 */
export async function recheckPendingDomain(
  opts: { manual?: boolean; actor?: AuditActor; ip?: string | null } = {},
  deps?: Partial<DomainFlowDeps>
): Promise<RecheckOutcome> {
  const d = withDefaults(deps);
  const row = await readPendingRaw();
  if (!row) return { status: "none" };
  const { raw, pending: p } = row;
  const now = d.now();
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

  if (check.ok) {
    // Still the request that was checked? (An admin may have saved another
    // domain, forced one or discarded this one meanwhile.)
    if (!(await deletePending(claimedRaw))) return { status: "superseded", check, pending: await getPendingDomain() };
    await updateAppSettings({ custom_domain: p.domain, tls_mode: p.tls_mode, tls_email: p.tls_email });
    const applied = await d.apply();
    await audit({
      actor,
      action: "domain.applied",
      targetType: "domain",
      targetLabel: p.domain,
      details: {
        domain: p.domain,
        tls_mode: p.tls_mode,
        addresses: check.addresses,
        applied: applied.ok,
        via: opts.manual ? "check_again" : "background",
        attempts: p.attempts + 1,
        requested_by: p.requested_by.name,
      },
      ip: opts.ip ?? null,
    });
    try {
      await d.notifyLive(p.domain, p.requested_by.id);
    } catch (e) {
      console.error("[domain] could not send the go-live notice:", e);
    }
    return { status: "applied", check, applied: applied.ok, proxyError: applied.ok ? undefined : applied.error, pending: null };
  }

  const next: PendingDomain = {
    ...claimed,
    attempts: p.attempts + 1,
    last_check: check,
    ...(opts.manual ? { auto_until: new Date(now + RECHECK_WINDOW_MS).toISOString() } : {}),
  };
  const nextRaw = await swapPending(claimedRaw, next);
  if (opts.manual) {
    await audit({
      actor,
      action: "domain.check_failed",
      targetType: "domain",
      targetLabel: p.domain,
      details: { domain: p.domain, tls_mode: p.tls_mode, code: check.code, reason: check.message, addresses: check.addresses, cname: check.cname, via: "check_again" },
      ip: opts.ip ?? null,
    });
  }
  return { status: nextRaw ? "pending" : "superseded", check, pending: nextRaw ? next : await getPendingDomain() };
}

/** "Keep the current address": drop the pending domain. True when there was one. */
export async function discardPendingDomain(actor: AuditActor, ip?: string | null): Promise<boolean> {
  const row = await readPendingRaw();
  if (!row || !(await deletePending(row.raw))) return false;
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
  secure_cookies: import("./settings").SecureCookieMode;
  has_custom_cert: boolean;
  proxy: { managed: boolean; reachable: boolean };
  /** The domain waiting for its check. */
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
