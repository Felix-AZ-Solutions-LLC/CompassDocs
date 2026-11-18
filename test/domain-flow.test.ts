// Saving a custom domain without locking anyone out (1.20.29,
// lib/domain-flow), against the database with the check, the proxy push and
// the bell injected: a failed check leaves the live address alone and the
// domain pending (audited), the background re-check waits for its five
// minutes, keeps failing quietly, then applies, notifies and audits; Check
// again restarts the 24 hours; "Use it anyway" switches without the check
// and is audited; a request replaced while its check ran is never applied;
// the admin's DNS hostname is remembered as a fallback, an IP never is.
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
  discardPendingDomain,
  getPendingDomain,
  recheckPendingDomain,
  saveDomainSettings,
  type DomainFlowDeps,
} from "../src/lib/domain-flow";
import { rememberedFallbackHosts } from "../src/lib/fallback-hosts";
import type { DomainCheckResult } from "../src/lib/domain-check";
import type { TlsMode } from "../src/lib/settings";

const KEYS = ["custom_domain", "tls_mode", "tls_email", PENDING_KEY, "fallback_hosts"];
const STAMP = `domflow-${Date.now()}`;
const actor = { id: null, name: STAMP, role: "admin" };
const saved = new Map<string, string>();

function result(domain: string, ok: boolean, code: DomainCheckResult["code"] = ok ? "ok" : "nxdomain"): DomainCheckResult {
  return {
    ok,
    code,
    domain,
    addresses: ok ? ["20.30.40.50"] : [],
    cname: null,
    tried: ok ? ["20.30.40.50"] : [],
    http_status: null,
    message: ok ? `${domain} reaches this server.` : `${domain} doesn't exist in DNS yet (no record found).`,
    checked_at: new Date().toISOString(),
  };
}

/** Injected deps: the check answers from `passes`, the clock is ours, every push and notice is counted. */
function rig(start = Date.now()) {
  const state = {
    now: start,
    passes: new Set<string>(),
    checks: [] as { domain: string; mode: TlsMode }[],
    applies: 0,
    notices: [] as { domain: string; requestedBy: number | null }[],
    onCheck: null as null | (() => Promise<void>),
  };
  const deps: Partial<DomainFlowDeps> = {
    check: async (domain, mode) => {
      state.checks.push({ domain, mode });
      if (state.onCheck) await state.onCheck();
      return result(domain, state.passes.has(domain));
    },
    apply: async () => {
      state.applies++;
      return { ok: true };
    },
    managed: () => true,
    now: () => state.now,
    notifyLive: async (domain, requestedBy) => {
      state.notices.push({ domain, requestedBy });
    },
  };
  return { state, deps };
}

async function auditRows(action: string) {
  const r = await pool().query<{ action: string; actor_name: string; details: Record<string, unknown>; target_label: string }>(
    "SELECT action, actor_name, details, target_label FROM audit_log WHERE action = $1 AND (actor_name = $2 OR details->>'requested_by' = $2) ORDER BY id",
    [action, STAMP]
  );
  return r.rows;
}

async function reset(domain = "live.example.com", mode: TlsMode = "auto") {
  await pool().query("DELETE FROM settings WHERE key = ANY($1)", [[PENDING_KEY, "fallback_hosts"]]);
  await setSetting("custom_domain", domain);
  await setSetting("tls_mode", mode);
  await setSetting("tls_email", "");
}

describe("custom domain flow", () => {
  before(async () => {
    await getSetting("__schema_bootstrap__");
    for (const k of KEYS) {
      const v = await getSetting(k);
      if (v !== undefined) saved.set(k, v);
    }
    delete process.env.COMPASSDOCS_FALLBACK_HOSTS;
  });
  after(async () => {
    await pool().query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
    for (const [k, v] of saved) await setSetting(k, v);
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
    assert.equal(state.applies, 0, "the proxy is not pushed");
    assert.deepEqual(state.checks, [{ domain: "docs.example.com", mode: "auto" }]);
    const s = await getAppSettings();
    assert.equal(s.custom_domain, "live.example.com", "the live address stays");
    const p = await getPendingDomain();
    assert.equal(p?.domain, "docs.example.com");
    assert.equal(p?.tls_email, "ops@example.com");
    assert.equal(p?.attempts, 1);
    assert.equal(p?.last_check.code, "nxdomain");
    assert.equal(Date.parse(p!.next_check_at) - state.now, RECHECK_INTERVAL_MS);
    assert.equal(Date.parse(p!.auto_until) - state.now, RECHECK_WINDOW_MS);
    const rows = await auditRows("domain.check_failed");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].details.code, "nxdomain");
    assert.match(String(rows[0].details.reason), /doesn't exist in DNS yet/);
    // The address the admin was on is remembered as a way back in.
    assert.equal(r.remembered_fallback, "myvm.eastus.cloudapp.azure.com");
    assert.deepEqual(await rememberedFallbackHosts(), ["myvm.eastus.cloudapp.azure.com"]);
  });

  test("pending → background re-check: waits, fails quietly, then applies, notifies and audits", async () => {
    const { state, deps } = rig();
    await saveDomainSettings({ domain: "docs.example.com", tls_mode: "internal", actor, via: "settings" }, deps);
    const failedAudits = (await auditRows("domain.check_failed")).length;

    // Not due yet.
    state.now += 60_000;
    assert.equal((await recheckPendingDomain({}, deps)).status, "waiting");
    assert.equal(state.checks.length, 1);

    // Due, still failing: attempts go up, nothing switched, no audit row per background try.
    state.now += RECHECK_INTERVAL_MS;
    const r1 = await recheckPendingDomain({}, deps);
    assert.equal(r1.status, "pending");
    assert.equal(r1.pending?.attempts, 2);
    assert.equal(state.applies, 0);
    assert.equal((await auditRows("domain.check_failed")).length, failedAudits);
    assert.equal((await getAppSettings()).custom_domain, "live.example.com");

    // DNS arrives: the next due check applies it.
    state.passes.add("docs.example.com");
    state.now += RECHECK_INTERVAL_MS;
    const r2 = await recheckPendingDomain({}, deps);
    assert.equal(r2.status, "applied");
    assert.equal(state.applies, 1);
    const s = await getAppSettings();
    assert.equal(s.custom_domain, "docs.example.com");
    assert.equal(s.tls_mode, "internal");
    assert.equal(await getPendingDomain(), null);
    assert.deepEqual(state.notices, [{ domain: "docs.example.com", requestedBy: null }]);
    const applied = await auditRows("domain.applied");
    assert.equal(applied.length, 1);
    assert.equal(applied[0].actor_name, "system");
    assert.equal(applied[0].details.via, "background");
    assert.equal(applied[0].details.attempts, 3);

    // Nothing left to do.
    assert.equal((await recheckPendingDomain({}, deps)).status, "none");
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

  test("a passing check switches at once and audits domain.applied", async () => {
    const { state, deps } = rig();
    state.passes.add("ready.example.com");
    const r = await saveDomainSettings({ domain: "ready.example.com", tls_mode: "auto", actor, via: "setup" }, deps);
    assert.equal(r.outcome, "applied");
    assert.equal(r.applied, true);
    assert.equal(state.applies, 1);
    assert.equal((await getAppSettings()).custom_domain, "ready.example.com");
    const rows = (await auditRows("domain.applied")).filter((x) => x.target_label === "ready.example.com");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].details.via, "setup");
    assert.equal(state.notices.length, 0, "the admin is looking at it: no bell for an immediate pass");
  });

  test("Use it anyway: switched without the check, pending cleared, audited domain.forced", async () => {
    const { state, deps } = rig();
    await saveDomainSettings({ domain: "behind-lb.example.com", actor, via: "settings" }, deps);
    assert.ok(await getPendingDomain());
    const r = await saveDomainSettings({ domain: "behind-lb.example.com", force: true, actor, ip: "203.0.113.9", via: "settings" }, deps);
    assert.equal(r.outcome, "forced");
    assert.equal(state.checks.length, 1, "no second check");
    assert.equal(state.applies, 1);
    assert.equal((await getAppSettings()).custom_domain, "behind-lb.example.com");
    assert.equal(await getPendingDomain(), null);
    const rows = (await auditRows("domain.forced")).filter((x) => x.target_label === "behind-lb.example.com");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].details.previous, "live.example.com");
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
    assert.equal(state.applies, 3);
    // A new mode for the same domain is a switch, so it is checked.
    await saveDomainSettings({ domain: "docs.example.com", tls_mode: "internal", actor, via: "settings" }, deps);
    assert.equal(state.checks.length, 1);
  });

  test("a request replaced while its check ran is never applied", async () => {
    const { state, deps } = rig();
    await saveDomainSettings({ domain: "first.example.com", actor, via: "settings" }, deps);
    state.passes.add("first.example.com");
    state.onCheck = async () => {
      state.onCheck = null;
      // The admin saves another domain meanwhile.
      await saveDomainSettings({ domain: "second.example.com", actor, via: "settings" }, deps);
    };
    const r = await recheckPendingDomain({ manual: true, actor }, deps);
    assert.equal(r.status, "superseded");
    assert.equal((await getAppSettings()).custom_domain, "live.example.com");
    assert.equal((await getPendingDomain())?.domain, "second.example.com");
    assert.equal(state.applies, 0);
  });

  test("Keep the current address discards the pending domain, audited", async () => {
    const { deps } = rig();
    await saveDomainSettings({ domain: "nope.example.com", actor, via: "settings" }, deps);
    assert.equal(await discardPendingDomain(actor), true);
    assert.equal(await getPendingDomain(), null);
    assert.equal(await discardPendingDomain(actor), false);
    assert.equal((await auditRows("domain.pending_discarded")).filter((x) => x.target_label === "nope.example.com").length, 1);
  });

  test("the remembered fallback: a DNS name other than the new domain, never an IP or localhost", async () => {
    const { deps } = rig();
    for (const host of ["20.1.2.3", "localhost:3000", "[2001:db8::1]", "docs.example.com", "bad_host.example.com"]) {
      const r = await saveDomainSettings({ domain: "docs.example.com", actor, hostHeader: host, via: "settings" }, deps);
      assert.equal(r.remembered_fallback, null, host);
    }
    assert.deepEqual(await rememberedFallbackHosts(), []);
    // From the environment already: not stored twice.
    process.env.COMPASSDOCS_FALLBACK_HOSTS = "myvm.eastus.cloudapp.azure.com";
    try {
      const r = await saveDomainSettings({ domain: "other.example.com", actor, hostHeader: "myvm.eastus.cloudapp.azure.com", via: "settings" }, deps);
      assert.equal(r.remembered_fallback, null);
    } finally {
      delete process.env.COMPASSDOCS_FALLBACK_HOSTS;
    }
    // At most five, newest first.
    for (let i = 1; i <= 7; i++) {
      await saveDomainSettings({ domain: `d${i}.example.com`, actor, hostHeader: `h${i}.example.org:443`, via: "settings" }, deps);
    }
    assert.deepEqual(await rememberedFallbackHosts(), ["h7.example.org", "h6.example.org", "h5.example.org", "h4.example.org", "h3.example.org"]);
  });
});
