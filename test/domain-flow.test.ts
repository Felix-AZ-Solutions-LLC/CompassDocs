// Saving a custom domain without locking anyone out (1.20.29,
// lib/domain-flow), against the database with the check, the proxy push,
// the HTTPS verification and the bell injected:
//   - a failed check leaves the live address alone and the domain pending (audited);
//   - a passing check switches the proxy FIRST (transitional), verifies
//     HTTPS, and only then switches the settings; HTTPS that never answers
//     rolls the proxy back and the request waits again (audited);
//   - a refused proxy push changes no setting and sends no bell (review M4);
//   - the background re-check waits for its five minutes, fails quietly,
//     then switches, verifies, notifies and audits;
//   - Check again restarts the 24 hours; the same request saved again does
//     not (review L5); a PATCH-less re-apply never touches it;
//   - a certificate pasted for a waiting domain waits with it (review M1);
//   - "Use it anyway" switches without the check, audited;
//   - a request replaced while its check ran is never applied;
//   - the admin's DNS hostname is remembered as a fallback, with a public
//     certificate only when it passes the check; an IP never is.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/domain-flow.test.ts

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pool, getSetting, setSetting } from "../src/lib/db";
import { getAppSettings } from "../src/lib/settings-store";
import {
  PENDING_KEY,
  RECHECK_INTERVAL_MS,
  RECHECK_WINDOW_MS,
  VERIFY_WINDOW_MS,
  discardPendingDomain,
  getPendingDomain,
  recheckPendingDomain,
  saveDomainSettings,
  type DomainFlowDeps,
} from "../src/lib/domain-flow";
import { rememberedFallbackHosts } from "../src/lib/fallback-hosts";
import type { DomainCheckResult, HttpsVerifyResult } from "../src/lib/domain-check";
import type { CaddyfileOptions, ProxyTarget } from "../src/lib/caddy";
import type { TlsMode } from "../src/lib/settings";

const KEYS = ["custom_domain", "tls_mode", "tls_email", PENDING_KEY, "fallback_hosts", "tls_cert_pem", "tls_key_pem", "tls_cert_pem_pending", "tls_key_pem_pending"];
const STAMP = `domflow-${Date.now()}`;
const actor = { id: null, name: STAMP, role: "admin" };
const saved = new Map<string, string>();
/**
 * test/domain-routes.test.ts writes the same settings rows, and node:test
 * runs files in parallel: one advisory lock, held on its own connection for
 * the whole file, keeps the two apart.
 */
const DOMAIN_SETTINGS_LOCK = 1202901;
let lockClient: import("pg").PoolClient | null = null;
const PEM = (n: string) => ({ cert: `-----BEGIN CERTIFICATE-----\n${n}\n-----END CERTIFICATE-----`, key: `-----BEGIN PRIVATE KEY-----\n${n}\n-----END PRIVATE KEY-----` });

function result(domain: string, ok: boolean, code: DomainCheckResult["code"] = ok ? "ok" : "nxdomain"): DomainCheckResult {
  return {
    ok,
    code,
    domain,
    addresses: ok ? ["20.30.40.50"] : [],
    cname: null,
    tried: ok ? ["20.30.40.50"] : [],
    message: ok ? `${domain} reaches this server.` : `${domain} doesn't exist in DNS yet (no record found).`,
    checked_at: new Date().toISOString(),
  };
}

/** Injected deps: the check answers from `passes`, HTTPS from `https`, the clock is ours, every push, job and notice is recorded. */
function rig(start = Date.now()) {
  const state = {
    now: start,
    passes: new Set<string>(),
    https: new Map<string, HttpsVerifyResult>(),
    checks: [] as { domain: string; mode: TlsMode }[],
    applies: [] as { target?: ProxyTarget; opts?: CaddyfileOptions }[],
    applyOk: true,
    verifies: [] as { domain: string; address: string }[],
    notices: [] as { domain: string; requestedBy: number | null }[],
    jobs: [] as (() => Promise<unknown>)[],
    onCheck: null as null | (() => Promise<void>),
  };
  const deps: Partial<DomainFlowDeps> = {
    check: async (domain, mode) => {
      state.checks.push({ domain, mode });
      if (state.onCheck) await state.onCheck();
      return result(domain, state.passes.has(domain));
    },
    apply: async (target, opts) => {
      state.applies.push({ target, opts });
      return state.applyOk ? { ok: true } : { ok: false, error: "Proxy rejected the configuration (400)." };
    },
    verifyHttps: async (domain, _mode, address) => {
      state.verifies.push({ domain, address });
      return state.https.get(domain) ?? { ok: false, code: "https_certificate", detail: "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR" };
    },
    managed: () => true,
    now: () => state.now,
    sleep: async (ms) => {
      state.now += ms;
    },
    schedule: (job) => {
      state.jobs.push(job);
    },
    notifyLive: async (domain, requestedBy) => {
      state.notices.push({ domain, requestedBy });
    },
  };
  /** Run the HTTPS verifications the flow scheduled. */
  const drain = async () => {
    while (state.jobs.length) await state.jobs.shift()!();
  };
  return { state, deps, drain };
}

async function auditRows(action: string) {
  const r = await pool().query<{ action: string; actor_name: string; details: Record<string, unknown>; target_label: string }>(
    "SELECT action, actor_name, details, target_label FROM audit_log WHERE action = $1 AND (actor_name = $2 OR details->>'requested_by' = $2) ORDER BY id",
    [action, STAMP]
  );
  return r.rows;
}

async function reset(domain = "live.example.com", mode: TlsMode = "auto") {
  await pool().query("DELETE FROM settings WHERE key = ANY($1)", [[PENDING_KEY, "fallback_hosts", "tls_cert_pem", "tls_key_pem", "tls_cert_pem_pending", "tls_key_pem_pending"]]);
  await setSetting("custom_domain", domain);
  await setSetting("tls_mode", mode);
  await setSetting("tls_email", "");
}

describe("custom domain flow", () => {
  before(async () => {
    process.env.COMPASSDOCS_SECRET_KEY ||= "cd".repeat(32); // the pending private key is sealed
    await getSetting("__schema_bootstrap__");
    lockClient = await pool().connect();
    await lockClient.query("SELECT pg_advisory_lock($1)", [DOMAIN_SETTINGS_LOCK]);
    for (const k of KEYS) {
      const v = await getSetting(k);
      if (v !== undefined) saved.set(k, v);
    }
    delete process.env.COMPASSDOCS_FALLBACK_HOSTS;
  });
  after(async () => {
    await pool().query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
    for (const [k, v] of saved) await setSetting(k, v);
    await lockClient?.query("SELECT pg_advisory_unlock($1)", [DOMAIN_SETTINGS_LOCK]);
    lockClient?.release();
    await pool().end();
  });
  beforeEach(() => reset());

  test("a failed check: nothing switched, the domain waits with its reason, audited", async () => {
    const { state, deps } = rig();
    const r = await saveDomainSettings(
      { domain: "Docs.Example.com", tls_mode: "auto", tls_email: "ops@example.com", actor, ip: "203.0.113.9", hostHeader: "myvm.eastus.cloudapp.azure.com", via: "settings" },
      deps
    );
    assert.equal(r.outcome, "pending");
    assert.equal(r.applied, false);
    assert.equal(state.applies.length, 0, "the proxy is not pushed");
    assert.deepEqual(state.checks.map((c) => c.domain).sort(), ["docs.example.com", "myvm.eastus.cloudapp.azure.com"]);
    assert.equal((await getAppSettings()).custom_domain, "live.example.com", "the live address stays");
    const p = await getPendingDomain();
    assert.equal(p?.domain, "docs.example.com");
    assert.equal(p?.phase, "waiting");
    assert.equal(p?.tls_email, "ops@example.com");
    assert.equal(p?.attempts, 1);
    assert.equal(p?.last_check.code, "nxdomain");
    assert.equal(Date.parse(p!.next_check_at) - state.now, RECHECK_INTERVAL_MS);
    assert.equal(Date.parse(p!.auto_until) - state.now, RECHECK_WINDOW_MS);
    const rows = await auditRows("domain.check_failed");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].details.code, "nxdomain");
    assert.match(String(rows[0].details.reason), /doesn't exist in DNS yet/);
    // The address the admin was on is remembered as a way back in; it failed
    // its own check, so it gets the internal CA, not Let's Encrypt (review H1).
    assert.equal(r.remembered_fallback, "myvm.eastus.cloudapp.azure.com");
    assert.deepEqual(await rememberedFallbackHosts(), [{ host: "myvm.eastus.cloudapp.azure.com", acme: false }]);
  });

  test("a remembered address that passes its check may use Let's Encrypt", async () => {
    const { state, deps } = rig();
    state.passes.add("myvm.eastus.cloudapp.azure.com");
    await saveDomainSettings({ domain: "docs.example.com", actor, hostHeader: "myvm.eastus.cloudapp.azure.com", via: "settings" }, deps);
    assert.deepEqual(await rememberedFallbackHosts(), [{ host: "myvm.eastus.cloudapp.azure.com", acme: true }]);
  });

  test("a pass switches the proxy first, verifies HTTPS, then the settings (review M3, M4)", async () => {
    const { state, deps, drain } = rig();
    state.passes.add("ready.example.com");
    state.https.set("ready.example.com", { ok: true, code: "ok" });
    const r = await saveDomainSettings({ domain: "ready.example.com", tls_mode: "auto", actor, via: "setup" }, deps);
    assert.equal(r.outcome, "verifying");
    assert.equal(r.applied, true);
    // The proxy serves the target, transitionally; the settings haven't moved.
    assert.deepEqual(state.applies, [{ target: { domain: "ready.example.com", tls_mode: "auto", tls_email: "", cert: "live" }, opts: { transitional: true } }]);
    assert.equal((await getAppSettings()).custom_domain, "live.example.com");
    assert.equal((await getPendingDomain())?.phase, "verifying");
    assert.equal((await getPendingDomain())?.verify?.address, "20.30.40.50");

    await drain();
    assert.deepEqual(state.verifies, [{ domain: "ready.example.com", address: "20.30.40.50" }]);
    assert.equal((await getAppSettings()).custom_domain, "ready.example.com");
    assert.equal(await getPendingDomain(), null);
    assert.equal(state.applies.length, 2);
    assert.equal(state.applies[1].target, undefined, "the final config, from the saved settings");
    const rows = (await auditRows("domain.applied")).filter((x) => x.target_label === "ready.example.com");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].details.via, "setup");
    assert.equal(rows[0].details.https_verified, true);
    assert.equal(state.notices.length, 0, "the admin is looking at it: no bell for a switch they made");
  });

  test("HTTPS that never answers rolls back: the previous config, the request waits, its re-checks stop", async () => {
    const { state, deps, drain } = rig();
    state.passes.add("nocert.example.com");
    const started = state.now;
    await saveDomainSettings({ domain: "nocert.example.com", actor, via: "settings" }, deps);
    await drain();
    assert.ok(state.verifies.length >= VERIFY_WINDOW_MS / 10_000, `polled through the window (${state.verifies.length})`);
    assert.ok(state.now - started >= VERIFY_WINDOW_MS);
    assert.equal((await getAppSettings()).custom_domain, "live.example.com", "the settings never moved");
    assert.equal(state.applies.at(-1)!.target, undefined, "the saved config pushed back");
    const p = await getPendingDomain();
    assert.equal(p?.phase, "waiting");
    assert.equal(p?.last_check.code, "https_certificate");
    assert.match(p!.last_check.message, /Let's Encrypt couldn't issue a certificate for nocert\.example\.com within 2 minutes/);
    assert.ok(Date.parse(p!.auto_until) <= state.now, "automatic re-checks stopped");
    assert.equal((await recheckPendingDomain({}, deps)).status, "waiting");
    const rows = (await auditRows("domain.rolled_back")).filter((x) => x.target_label === "nocert.example.com");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].details.code, "https_certificate");
  });

  test("port 443 closed has its own reason", async () => {
    const { state, deps, drain } = rig();
    state.passes.add("closed.example.com");
    state.https.set("closed.example.com", { ok: false, code: "https_port", detail: "timeout" });
    await saveDomainSettings({ domain: "closed.example.com", actor, via: "settings" }, deps);
    await drain();
    assert.match((await getPendingDomain())!.last_check.message, /^Port 443 didn't answer for closed\.example\.com at 20\.30\.40\.50/);
  });

  test("TLS off: nothing to verify on 443, switched at once", async () => {
    const { state, deps } = rig();
    state.passes.add("plain.example.com");
    const r = await saveDomainSettings({ domain: "plain.example.com", tls_mode: "off", actor, via: "settings" }, deps);
    assert.equal(r.outcome, "applied");
    assert.equal(state.verifies.length, 0);
    assert.equal((await getAppSettings()).custom_domain, "plain.example.com");
    assert.equal(state.applies[0].opts && state.applies[0].opts.transitional, undefined);
  });

  test("pending → background: waits, fails quietly, then switches, verifies, notifies and audits", async () => {
    const { state, deps, drain } = rig();
    await saveDomainSettings({ domain: "docs.example.com", tls_mode: "internal", actor, via: "settings" }, deps);
    const failedAudits = (await auditRows("domain.check_failed")).length;

    state.now += 60_000;
    assert.equal((await recheckPendingDomain({}, deps)).status, "waiting");

    state.now += RECHECK_INTERVAL_MS;
    const r1 = await recheckPendingDomain({}, deps);
    assert.equal(r1.status, "pending");
    assert.equal(r1.pending?.attempts, 2);
    assert.equal(state.applies.length, 0);
    assert.equal((await auditRows("domain.check_failed")).length, failedAudits);

    state.passes.add("docs.example.com");
    state.https.set("docs.example.com", { ok: true, code: "ok" });
    state.now += RECHECK_INTERVAL_MS;
    const r2 = await recheckPendingDomain({}, deps);
    assert.equal(r2.status, "verifying");
    assert.equal((await getAppSettings()).custom_domain, "live.example.com");
    await drain();
    const s = await getAppSettings();
    assert.equal(s.custom_domain, "docs.example.com");
    assert.equal(s.tls_mode, "internal");
    assert.equal(await getPendingDomain(), null);
    assert.deepEqual(state.notices, [{ domain: "docs.example.com", requestedBy: null }]);
    const applied = (await auditRows("domain.applied")).filter((x) => x.target_label === "docs.example.com");
    assert.equal(applied.length, 1);
    assert.equal(applied[0].actor_name, "system");
    assert.equal(applied[0].details.via, "background");
    assert.equal(applied[0].details.attempts, 3);
    assert.equal((await recheckPendingDomain({}, deps)).status, "none");
  });

  test("a background pass the proxy refuses: no setting moves, no bell, the request waits with the error (review M4)", async () => {
    const { state, deps, drain } = rig();
    await saveDomainSettings({ domain: "refused.example.com", actor, via: "settings" }, deps);
    state.passes.add("refused.example.com");
    state.applyOk = false;
    state.now += RECHECK_INTERVAL_MS;
    const r = await recheckPendingDomain({}, deps);
    assert.equal(r.status, "pending");
    await drain();
    assert.equal((await getAppSettings()).custom_domain, "live.example.com");
    assert.equal(state.notices.length, 0);
    const p = await getPendingDomain();
    assert.equal(p?.last_check.code, "proxy_error");
    assert.match(p!.last_check.message, /reaches this server, but the proxy didn't take the new configuration: Proxy rejected/);
  });

  test("a verification whose process died is finished by the minute tick", async () => {
    const { state, deps } = rig();
    state.passes.add("orphan.example.com");
    await saveDomainSettings({ domain: "orphan.example.com", actor, via: "settings" }, deps);
    state.jobs.length = 0; // the process died before it ran
    state.https.set("orphan.example.com", { ok: true, code: "ok" });
    assert.equal((await recheckPendingDomain({}, deps)).status, "verifying");
    state.now += VERIFY_WINDOW_MS + 61_000;
    assert.equal((await recheckPendingDomain({}, deps)).status, "applied");
    assert.equal((await getAppSettings()).custom_domain, "orphan.example.com");
  });

  test("the background stops after 24 hours; Check again runs now and restarts them", async () => {
    const { state, deps } = rig();
    await saveDomainSettings({ domain: "late.example.com", actor, via: "settings" }, deps);
    state.now += RECHECK_WINDOW_MS + 60_000;
    assert.equal((await recheckPendingDomain({}, deps)).status, "waiting");
    const r = await recheckPendingDomain({ manual: true, actor }, deps);
    assert.equal(r.status, "pending");
    assert.equal(Date.parse(r.pending!.auto_until) - state.now, RECHECK_WINDOW_MS);
    const rows = await auditRows("domain.check_failed");
    assert.equal(rows.filter((x) => x.details.via === "check_again" && x.target_label === "late.example.com").length, 1);
  });

  test("the same waiting request saved again is Check again, without a reset or another audit row (review L5)", async () => {
    const { state, deps } = rig();
    await saveDomainSettings({ domain: "again.example.com", actor, via: "settings" }, deps);
    const before = (await getPendingDomain())!;
    const rows = (await auditRows("domain.check_failed")).length;
    state.now += 60 * 60_000;
    const r = await saveDomainSettings({ domain: "again.example.com", tls_email: "ops@example.com", actor, via: "settings" }, deps);
    assert.equal(r.outcome, "pending");
    const after = (await getPendingDomain())!;
    assert.equal(after.attempts, 2);
    assert.equal(after.requested_at, before.requested_at);
    assert.equal(after.auto_until, before.auto_until, "the 24 hours are not restarted");
    assert.equal(after.tls_email, "ops@example.com");
    assert.equal((await auditRows("domain.check_failed")).length, rows);
  });

  test("a certificate pasted for a waiting domain waits with it, and is promoted at the switch (review M1)", async () => {
    const { state, deps, drain } = rig();
    await setSetting("tls_mode", "custom");
    await setSetting("tls_cert_pem", PEM("LIVE-A").cert);
    await setSetting("tls_key_pem", PEM("LIVE-A").key);
    await saveDomainSettings({ domain: "b.example.com", tls_mode: "custom", cert: PEM("FOR-B"), actor, via: "settings" }, deps);
    assert.match((await getSetting("tls_cert_pem"))!, /LIVE-A/, "the live domain keeps its certificate");
    assert.match((await getSetting("tls_cert_pem_pending"))!, /FOR-B/);
    assert.equal((await getPendingDomain())?.has_cert, true);
    // DNS arrives: the switch serves B with the pending pair, then promotes it.
    state.passes.add("b.example.com");
    state.https.set("b.example.com", { ok: true, code: "ok" });
    await recheckPendingDomain({ manual: true, actor }, deps);
    assert.equal(state.applies[0].target?.cert, "pending");
    assert.match((await getSetting("tls_cert_pem"))!, /LIVE-A/, "still A's until HTTPS answered");
    await drain();
    assert.match((await getSetting("tls_cert_pem"))!, /FOR-B/);
    assert.match((await getSetting("tls_key_pem"))!, /FOR-B/);
    assert.equal(await getSetting("tls_cert_pem_pending"), undefined);
  });

  test("Use it anyway: switched without the check, pending cleared, audited domain.forced", async () => {
    const { state, deps } = rig();
    await saveDomainSettings({ domain: "behind-lb.example.com", actor, via: "settings" }, deps);
    assert.ok(await getPendingDomain());
    const r = await saveDomainSettings({ domain: "behind-lb.example.com", force: true, actor, ip: "203.0.113.9", via: "settings" }, deps);
    assert.equal(r.outcome, "forced");
    assert.equal(state.checks.length, 1, "no second check");
    assert.equal(state.verifies.length, 0);
    assert.equal(state.applies.length, 1);
    assert.equal((await getAppSettings()).custom_domain, "behind-lb.example.com");
    assert.equal(await getPendingDomain(), null);
    const rows = (await auditRows("domain.forced")).filter((x) => x.target_label === "behind-lb.example.com");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].details.previous, "live.example.com");
    assert.equal((await auditRows("domain.pending_discarded")).filter((x) => x.target_label === "behind-lb.example.com").length, 0);
  });

  test("no check when nothing would switch: the same domain and mode, a cleared domain, or no managed proxy", async () => {
    const { state, deps } = rig();
    const same = await saveDomainSettings({ domain: "live.example.com", tls_mode: "auto", tls_email: "new@example.com", actor, via: "settings" }, deps);
    assert.equal(same.outcome, "saved");
    const cleared = await saveDomainSettings({ domain: "", actor, via: "settings" }, deps);
    assert.equal(cleared.outcome, "saved");
    assert.equal((await getAppSettings()).custom_domain, "");
    const unmanaged = await saveDomainSettings({ domain: "docs.example.com", actor, via: "settings" }, { ...deps, managed: () => false });
    assert.equal(unmanaged.outcome, "saved");
    assert.equal(state.checks.length, 0);
    assert.equal(state.applies.length, 3);
    await saveDomainSettings({ domain: "docs.example.com", tls_mode: "internal", actor, via: "settings" }, deps);
    assert.equal(state.checks.length, 1);
  });

  test("reverting the form to the live domain drops the waiting one, and says so in the log", async () => {
    const { deps } = rig();
    await saveDomainSettings({ domain: "maybe.example.com", actor, via: "settings" }, deps);
    await saveDomainSettings({ domain: "live.example.com", actor, via: "settings" }, deps);
    assert.equal(await getPendingDomain(), null);
    assert.equal((await auditRows("domain.pending_discarded")).filter((x) => x.target_label === "maybe.example.com").length, 1);
  });

  test("a request replaced while its check ran is never applied", async () => {
    const { state, deps } = rig();
    await saveDomainSettings({ domain: "first.example.com", actor, via: "settings" }, deps);
    state.passes.add("first.example.com");
    state.onCheck = async () => {
      state.onCheck = null;
      await saveDomainSettings({ domain: "second.example.com", actor, via: "settings" }, deps);
    };
    const r = await recheckPendingDomain({ manual: true, actor }, deps);
    assert.equal(r.status, "superseded");
    assert.equal((await getAppSettings()).custom_domain, "live.example.com");
    assert.equal((await getPendingDomain())?.domain, "second.example.com");
    // The transitional push for "first" was taken back.
    assert.equal(state.applies.at(-1)!.target, undefined);
  });

  test("Keep the current address discards the pending domain, audited", async () => {
    const { deps } = rig();
    await saveDomainSettings({ domain: "nope.example.com", cert: PEM("NOPE"), tls_mode: "custom", actor, via: "settings" }, deps);
    assert.equal(await discardPendingDomain(actor, null, deps), true);
    assert.equal(await getPendingDomain(), null);
    assert.equal(await getSetting("tls_cert_pem_pending"), undefined, "its certificate goes with it");
    assert.equal(await discardPendingDomain(actor, null, deps), false);
    assert.equal((await auditRows("domain.pending_discarded")).filter((x) => x.target_label === "nope.example.com").length, 1);
  });

  test("the remembered fallback: a DNS name other than the new domain, never an IP or localhost", async () => {
    const { deps } = rig();
    for (const host of ["20.1.2.3", "localhost:3000", "[2001:db8::1]", "docs.example.com", "bad_host.example.com"]) {
      await reset();
      const r = await saveDomainSettings({ domain: "docs.example.com", actor, hostHeader: host, via: "settings" }, deps);
      assert.equal(r.remembered_fallback, null, host);
    }
    assert.deepEqual(await rememberedFallbackHosts(), []);
    process.env.COMPASSDOCS_FALLBACK_HOSTS = "myvm.eastus.cloudapp.azure.com";
    try {
      const r = await saveDomainSettings({ domain: "other.example.com", actor, hostHeader: "myvm.eastus.cloudapp.azure.com", via: "settings" }, deps);
      assert.equal(r.remembered_fallback, null);
    } finally {
      delete process.env.COMPASSDOCS_FALLBACK_HOSTS;
    }
    for (let i = 1; i <= 7; i++) {
      await saveDomainSettings({ domain: `d${i}.example.com`, actor, hostHeader: `h${i}.example.org:443`, via: "settings" }, deps);
    }
    assert.deepEqual(
      (await rememberedFallbackHosts()).map((x) => x.host),
      ["h7.example.org", "h6.example.org", "h5.example.org", "h4.example.org", "h3.example.org"]
    );
  });
});
