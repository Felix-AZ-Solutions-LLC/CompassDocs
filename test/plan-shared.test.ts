// CompassDocs Cloud plans (1.22.0, lib/plan-shared and lib/plan
// resolvePlan): the `cloudPlan` claim's parser (missing, partial or
// malformed reads as NO plan), the buffer maths and the meter states, the
// extra agent's proration, the AI allowance and its cap, the threshold
// banners and their dismissal, and which licence the plan is read from
// (the workspace check, the last match).
//
// Pure: resolvePlan is given a verifier with a throwaway key, so the suite
// holds whichever public key license.ts carries.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/plan-shared.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import {
  agentHoldAt,
  agentsState,
  aiPace,
  aiSpend,
  aiState,
  bufferCap,
  daysToRenewal,
  dismissalKey,
  extraAgents,
  gb,
  GB,
  lastMonths,
  meterState,
  noticeFor,
  isRealDay,
  billingContactFrom,
  BILLING_ALL_ADMINS,
  parsePlanClaim,
  prorateExtraAgent,
  storageSteps,
  thresholdsToEmail,
  usd,
  visibleNotices,
  type CloudPlan,
  type MeterReading,
} from "../src/lib/plan-shared";
import { resolvePlan } from "../src/lib/plan";
import type { License } from "../src/lib/license";

const STARTER = {
  name: "starter",
  agentsIncluded: 3,
  agentsMax: 10,
  activeUsersLimit: 250,
  storageGb: 25,
  aiAllowanceUsd: 15,
  renewsAt: "2027-03-14",
};

function plan(extra: Record<string, unknown> = {}): CloudPlan {
  const p = parsePlanClaim({ ...STARTER, ...extra });
  assert.ok(p, "the fixture parses");
  return p;
}

describe("the cloudPlan claim", () => {
  test("a full claim parses, with the defaults filled in", () => {
    const p = plan();
    assert.deepEqual(p, {
      name: "starter",
      agentsIncluded: 3,
      agentsMax: 10,
      activeUsersLimit: 250,
      storageGb: 25,
      aiAllowanceUsd: 15,
      bufferPct: 20,
      renewsAt: "2027-03-14",
      billingContact: null,
      priceUsd: null,
      billing: "annual",
    });
  });

  test("optional fields are read when present", () => {
    const p = plan({ bufferPct: 10, billingContact: " billing@northwind.example ", priceUsd: 199, billing: "monthly", renewsAt: "2027-03-14" });
    assert.equal(p.bufferPct, 10);
    assert.equal(p.billingContact, "billing@northwind.example");
    assert.equal(p.priceUsd, 199);
    assert.equal(p.billing, "monthly");
    assert.equal(p.renewsAt, "2027-03-14");
  });

  test("renewsAt is exactly YYYY-MM-DD and a real day (review): anything else is no plan", () => {
    for (const renewsAt of ["2027-03-14T00:00:00Z", "2027-03-14 ", "2027-3-14", "2027-02-30", "2027-13-01", "14/03/2027", "2027-03-14x"]) {
      assert.equal(parsePlanClaim({ ...STARTER, renewsAt }), null, renewsAt);
    }
    assert.equal(isRealDay("2028-02-29"), true, "a leap day");
    assert.equal(isRealDay("2027-02-29"), false);
  });

  test("limits may be null (no limit), but must be present", () => {
    const d = parsePlanClaim({ ...STARTER, name: "dedicated", agentsMax: null, activeUsersLimit: null, aiAllowanceUsd: null, storageGb: 250 });
    assert.ok(d);
    assert.equal(d.agentsMax, null);
    assert.equal(d.activeUsersLimit, null);
  });

  test("missing reads as no plan", () => {
    assert.equal(parsePlanClaim(undefined), null);
    assert.equal(parsePlanClaim(null), null);
  });

  test("partial reads as no plan: every required key", () => {
    for (const k of Object.keys(STARTER)) {
      const partial: Record<string, unknown> = { ...STARTER };
      delete partial[k];
      assert.equal(parsePlanClaim(partial), null, `without ${k}`);
    }
  });

  test("malformed reads as no plan", () => {
    const bad: Record<string, unknown>[] = [
      { name: "enterprise" },
      { name: "Starter" },
      { name: 1 },
      { agentsIncluded: -1 },
      { agentsIncluded: 2.5 },
      { agentsIncluded: "3" },
      { agentsIncluded: null },
      { agentsMax: 2 }, // below the included agents
      { agentsMax: -10 },
      { activeUsersLimit: "250" },
      { storageGb: -1 },
      { storageGb: Infinity },
      { aiAllowanceUsd: "15" },
      { aiAllowanceUsd: NaN },
      { renewsAt: "next March" },
      { renewsAt: 20270314 },
      { renewsAt: "2027-13-45" },
      { bufferPct: 120 },
      { bufferPct: -5 },
      { bufferPct: "20" },
      { billingContact: "not an address" },
      { billingContact: 42 },
      { priceUsd: -199 },
      { billing: "quarterly" },
    ];
    for (const b of bad) assert.equal(parsePlanClaim({ ...STARTER, ...b }), null, JSON.stringify(b));
    for (const v of ["starter", 3, [], [STARTER], true]) assert.equal(parsePlanClaim(v), null, JSON.stringify(v));
  });
});

describe("buffer maths and meter states", () => {
  test("the buffer's end: 20% above the limit, rounded down", () => {
    assert.equal(bufferCap(250), 300);
    assert.equal(bufferCap(10), 12);
    assert.equal(bufferCap(25), 30);
    assert.equal(bufferCap(1000), 1200);
    assert.equal(bufferCap(3), 3, "rounds down, never below the limit");
    assert.equal(bufferCap(250, 10), 275);
    assert.equal(bufferCap(250, 0), 250);
  });

  test("active users: normal, 80%, over within the buffer, past the buffer (design A5)", () => {
    assert.equal(meterState(150, 250), "normal");
    assert.equal(meterState(199, 250), "normal");
    assert.equal(meterState(200, 250), "warn");
    assert.equal(meterState(204, 250), "warn");
    assert.equal(meterState(250, 250), "warn", "at the limit: not over yet");
    assert.equal(meterState(271, 250), "over");
    assert.equal(meterState(300, 250), "over", "the buffer's end is still in the buffer");
    assert.equal(meterState(312, 250), "past");
    assert.equal(meterState(5000, null), "normal", "no cap: nothing to meter");
  });

  test("storage has no buffer: past the limit is over, never past", () => {
    assert.equal(meterState(21, 25, { buffer: false }), "warn");
    assert.equal(meterState(80, 25, { buffer: false }), "over");
  });

  test("agents: against the maximum, held AT the buffer's end", () => {
    const p = plan();
    assert.equal(agentsState(3, p), "normal");
    assert.equal(agentsState(8, p), "warn");
    assert.equal(agentsState(10, p), "warn");
    assert.equal(agentsState(11, p), "over");
    assert.equal(agentsState(12, p), "past", "at 12 new adds are held");
    assert.equal(agentHoldAt(p), 12);
    assert.equal(agentHoldAt(plan({ name: "shared", agentsIncluded: 5, agentsMax: 25 })), 30);
    assert.equal(agentHoldAt({ agentsMax: null, bufferPct: 20 }), null);
    assert.equal(extraAgents(3, p), 0);
    assert.equal(extraAgents(11, p), 8);
  });

  test("storage steps: each started 50 GB past the plan", () => {
    assert.equal(storageSteps(11.2 * GB, 25), 0);
    assert.equal(storageSteps(25 * GB, 25), 0);
    assert.equal(storageSteps(25 * GB + 1, 25), 1);
    assert.equal(storageSteps(75 * GB, 25), 1);
    assert.equal(storageSteps(75 * GB + 1, 25), 2);
    assert.equal(storageSteps(999 * GB, null), 0);
    assert.equal(gb(11.2 * GB), "11.2 GB");
    assert.equal(gb(640_000_000 / 10), "64 MB");
  });
});

describe("an extra agent's proration (design C1)", () => {
  test("annual: $119.88 a year for the days to renewal, $35.14 for 107 days", () => {
    const now = new Date("2026-11-27T10:00:00Z");
    assert.equal(daysToRenewal(now, "2027-03-14"), 107);
    const p = prorateExtraAgent(now, { renewsAt: "2027-03-14", billing: "annual" });
    assert.equal(p.periodUsd, 119.88);
    assert.equal(p.days, 107);
    assert.equal(p.nowUsd, 35.14);
    assert.equal(p.until, "2027-03-14");
  });

  test("annual: the whole year on the renewal's day a year before, nothing on the day itself", () => {
    assert.equal(prorateExtraAgent(new Date("2026-03-14T00:00:00Z"), { renewsAt: "2027-03-14", billing: "annual" }).nowUsd, 119.88);
    assert.equal(prorateExtraAgent(new Date("2027-03-14T12:00:00Z"), { renewsAt: "2027-03-14", billing: "annual" }).nowUsd, 0);
    assert.equal(prorateExtraAgent(new Date("2027-04-01T12:00:00Z"), { renewsAt: "2027-03-14", billing: "annual" }).nowUsd, 0, "past the renewal: nothing");
  });

  test("monthly: $9.99 for the rest of the month, today included", () => {
    const p = prorateExtraAgent(new Date("2026-11-27T10:00:00Z"), { renewsAt: "2027-03-14", billing: "monthly" });
    assert.equal(p.days, 4);
    assert.equal(p.nowUsd, Math.round((9.99 * 4 * 100) / 30) / 100);
    assert.equal(p.until, "2026-12-01");
  });
});

describe("the AI allowance and the cap (design D2)", () => {
  test("keep AI on: never paused; beyond the allowance billed at cost +30%", () => {
    const v = aiSpend(17.4, 15, "keep", null);
    assert.equal(v.paused, false);
    assert.equal(v.capUsd, null);
    assert.equal(v.beyondUsd, 2.4);
    assert.equal(v.billedUsd, 3.12);
    assert.equal(usd(v.billedUsd), "$3.12");
  });

  test("stop at the allowance: paused once it is used, not before", () => {
    assert.equal(aiSpend(14.99, 15, "stop", null).paused, false);
    assert.equal(aiSpend(15, 15, "stop", null).paused, true);
    assert.equal(aiSpend(15.02, 15, "stop", null).capUsd, 15);
  });

  test("cap at an amount: includes the allowance, never below it", () => {
    assert.equal(aiSpend(39.99, 15, "cap", 40).paused, false);
    assert.equal(aiSpend(40, 15, "cap", 40).paused, true);
    assert.equal(aiSpend(12, 15, "cap", 5).capUsd, 15, "a cap below the allowance is the allowance");
    assert.equal(aiSpend(12, 15, "cap", null).paused, false, "no amount: no cap");
  });

  test("the cap's overshoot is bounded by the one request already admitted", () => {
    // Checked before each request against the running total: the request that crosses it finishes, the next is refused.
    let total = 0;
    const answers = [0.31, 0.29, 0.4, 0.35, 0.33];
    const admitted: number[] = [];
    for (const a of answers) {
      if (aiSpend(total, 1, "stop", null).paused) break;
      admitted.push(a);
      total += a;
    }
    assert.ok(total - 1 < Math.max(...answers), `overshoot ${total - 1} is under one answer`);
    assert.equal(aiSpend(total, 1, "stop", null).paused, true);
  });

  test("the AI meter: warn from 80%, over once used, never past", () => {
    assert.equal(aiState({ spentUsd: 11, allowanceUsd: 15 }), "normal");
    assert.equal(aiState({ spentUsd: 13.1, allowanceUsd: 15 }), "warn");
    assert.equal(aiState({ spentUsd: 15, allowanceUsd: 15 }), "over");
    assert.equal(aiState({ spentUsd: 500, allowanceUsd: 15 }), "over");
    assert.equal(aiState({ spentUsd: 500, allowanceUsd: null }), "normal");
  });

  test("on pace for: only from day 7", () => {
    assert.equal(aiPace(3, new Date("2026-11-06T12:00:00Z")), null);
    assert.equal(aiPace(13.1, new Date("2026-11-27T12:00:00Z")), Math.round((13.1 / 27) * 30 * 100) / 100);
  });
});

describe("threshold banners and their dismissal (design B)", () => {
  const p = plan();
  const ctx = { workspace: "Northwind", plan: p, month: "2026-11" };
  const r = (key: MeterReading["key"], value: number, limit: number | null, state: MeterReading["state"]): MeterReading => ({ key, value, limit, state });

  test("80% is a fact (info); the limit and past the buffer are warnings; never an error", () => {
    const n80 = noticeFor(r("users", 204, 250, "warn"), ctx)!;
    assert.equal(n80.tone, "info");
    assert.equal(n80.threshold, "80");
    assert.match(n80.lead, /Northwind is at 82% of Starter's 250 active users this month/);
    assert.match(n80.rest, /Nothing changes if you go over; there's a 50-person buffer/);
    const over = noticeFor(r("users", 263, 250, "over"), ctx)!;
    assert.equal(over.tone, "warn");
    assert.match(over.rest, /Everyone keeps signing in as normal\. If it goes past 300, we'll get in touch about Shared/);
    const past = noticeFor(r("users", 312, 250, "past"), ctx)!;
    assert.equal(past.threshold, "past");
    assert.match(past.lead, /outgrown Starter: 312 active users this month, past the 300 buffer/);
    assert.match(past.rest, /Nobody is locked out and nothing is turned off/);
    assert.equal(noticeFor(r("users", 150, 250, "normal"), ctx), null);
  });

  test("storage says it is billed in steps, not a buffer", () => {
    const n = noticeFor(r("storage", 30, 25, "over"), { ...ctx, storageBytes: 30 * GB })!;
    assert.match(n.rest, /extra storage is \$25 a month per 50 GB/);
    assert.doesNotMatch(n.rest, /buffer/);
  });

  test("AI: the allowance used, and the pause", () => {
    const ai = aiSpend(15.4, 15, "keep", null);
    const n = noticeFor(r("ai", 15.4, 15, "over"), { ...ctx, ai })!;
    assert.match(n.lead, /has used its \$15 AI allowance for November/);
    assert.match(n.rest, /so far \$0\.40 beyond, billed as \$0\.52/);
    const paused = noticeFor(r("ai", 15, 15, "over"), { ...ctx, ai: aiSpend(15, 15, "stop", null) })!;
    assert.equal(paused.threshold, "paused");
  });

  test("AI by contract (no allowance) with a cap reached: the pause is still said (review)", () => {
    const d = plan({ name: "dedicated", agentsMax: null, activeUsersLimit: null, aiAllowanceUsd: null });
    const ai = aiSpend(120, null, "cap", 100);
    assert.equal(ai.paused, true);
    const n = noticeFor(r("ai", 120, null, "normal"), { ...ctx, plan: d, ai })!;
    assert.equal(n.threshold, "paused");
    assert.equal(noticeFor(r("ai", 50, null, "normal"), { ...ctx, plan: d, ai: aiSpend(50, null, "cap", 100) }), null, "under the cap: nothing");
  });

  test("the dashboard's short line (design B2)", () => {
    const n80 = noticeFor(r("users", 204, 250, "warn"), ctx)!;
    assert.deepEqual(n80.short, { lead: "82% of Starter's active users this month.", rest: "Nothing changes if you go over." });
    assert.equal(noticeFor(r("agents", 12, 10, "past"), ctx)!.short.lead, "12 agents, Starter's limit with its buffer.");
    assert.equal(noticeFor(r("ai", 15, 15, "over"), { ...ctx, ai: aiSpend(15, 15, "stop", null) })!.short.lead, "AI is paused for the rest of November.");
  });

  test("a dismissal hides that threshold, for that month only, until the next threshold", () => {
    const readings = [r("users", 204, 250, "warn"), r("agents", 3, 10, "normal")];
    assert.equal(visibleNotices(readings, ctx, []).length, 1);
    const key = dismissalKey({ month: "2026-11", meter: "users", threshold: "80" });
    assert.equal(key, "2026-11:users:80");
    assert.equal(visibleNotices(readings, ctx, [key]).length, 0, "dismissed for this month");
    assert.equal(visibleNotices(readings, { ...ctx, month: "2026-12" }, [key]).length, 1, "next month it shows again");
    const over = [r("users", 263, 250, "over")];
    assert.equal(visibleNotices(over, ctx, [key]).length, 1, "the next threshold shows again");
  });

  test("two meters at once: both, the most severe first", () => {
    const v = visibleNotices([r("users", 204, 250, "warn"), r("agents", 12, 10, "past")], ctx, []);
    assert.deepEqual(v.map((n) => n.meter), ["agents", "users"]);
  });

  test("the email: only thresholds not sent this month", () => {
    const readings = [r("users", 263, 250, "over"), r("storage", 21, 25, "warn")];
    const fresh = thresholdsToEmail(readings, { ...ctx, storageBytes: 21 * GB }, ["2026-11:users:limit"]);
    assert.deepEqual(fresh.map((n) => `${n.meter}:${n.threshold}`), ["storage:80"]);
  });

  test("six calendar months, oldest first", () => {
    assert.deepEqual(lastMonths(new Date("2026-11-27T00:00:00Z")), ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    assert.deepEqual(lastMonths(new Date("2026-02-10T00:00:00Z"), 3), ["2025-12", "2026-01", "2026-02"]);
  });
});

// --- Which licence the plan comes from (design F) -----------------------------------------

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
function mint(claims: Partial<License> & Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify({ id: "lic_t", customer: "Northwind", plan: "starter", features: ["helpdesk"], seats: 0, issued: "2026-03-14", expires: "2027-03-14", ...claims }));
  return `${payload.toString("base64url")}.${sign(null, payload, privateKey).toString("base64url")}`;
}
function parse(raw: string): { license?: License; error?: string } {
  const [b, s] = raw.split(".");
  if (!b || !s) return { error: "Malformed" };
  const payload = Buffer.from(b, "base64url");
  if (!verify(null, payload, publicKey, Buffer.from(s, "base64url"))) return { error: "bad signature" };
  return { license: JSON.parse(payload.toString()) as License };
}
const NOW = new Date("2026-11-27T12:00:00Z");

describe("resolvePlan: the licence names its workspace", () => {
  test("a licence with a plan for this workspace is the plan, and is remembered as the last match", () => {
    const t = mint({ workspace: "ws_2c91e4", cloudPlan: STARTER });
    const r = resolvePlan({ inForce: t, lastMatch: null, workspaceId: "ws_2c91e4", now: NOW }, parse);
    assert.equal(r.state?.plan.name, "starter");
    assert.equal(r.state?.source, "in_force");
    assert.equal(r.mismatch, null);
    assert.equal(r.remember, t);
    assert.equal(resolvePlan({ inForce: t, lastMatch: t, workspaceId: "ws_2c91e4", now: NOW }, parse).remember, null, "already kept");
  });

  test("a licence for another workspace: keeps running on the last match, never read-only (Decision 6)", () => {
    const good = mint({ workspace: "ws_2c91e4", cloudPlan: STARTER });
    const wrong = mint({ workspace: "ws_7f3a9c", cloudPlan: { ...STARTER, name: "shared", agentsIncluded: 5, agentsMax: 25 } });
    const r = resolvePlan({ inForce: wrong, lastMatch: good, workspaceId: "ws_2c91e4", now: NOW }, parse);
    assert.equal(r.state?.plan.name, "starter", "the last matching plan, not the other workspace's");
    assert.equal(r.state?.source, "last_match");
    assert.deepEqual(r.mismatch, { licenseWorkspace: "ws_7f3a9c", workspaceId: "ws_2c91e4", runningOn: { plan: "starter", renewsAt: "2027-03-14" } });
    assert.equal(r.remember, null, "a mismatch is never remembered");
  });

  test("a licence for another workspace with nothing kept: no plan, and the mismatch is said", () => {
    const wrong = mint({ workspace: "ws_7f3a9c", cloudPlan: STARTER });
    const r = resolvePlan({ inForce: wrong, lastMatch: null, workspaceId: "ws_2c91e4", now: NOW }, parse);
    assert.equal(r.state, null);
    assert.equal(r.mismatch?.runningOn, null);
    const none = resolvePlan({ inForce: mint({ cloudPlan: STARTER }), lastMatch: null, workspaceId: "ws_2c91e4", now: NOW }, parse);
    assert.equal(none.mismatch?.licenseWorkspace, "no workspace");
  });

  test("an Enterprise licence in cloud mode has no plan and is never checked (design E)", () => {
    const ent = mint({ plan: "enterprise", workspace: "ws_other" });
    assert.deepEqual(resolvePlan({ inForce: ent, lastMatch: null, workspaceId: "ws_2c91e4", now: NOW }, parse), { state: null, mismatch: null, remember: null });
  });

  test("a malformed plan, an expired licence or a bad signature: no plan", () => {
    assert.equal(resolvePlan({ inForce: mint({ workspace: "ws_2c91e4", cloudPlan: { ...STARTER, agentsMax: "ten" } }), workspaceId: "ws_2c91e4", now: NOW }, parse).state, null);
    assert.equal(resolvePlan({ inForce: mint({ workspace: "ws_2c91e4", cloudPlan: STARTER, expires: "2026-10-01" }), workspaceId: "ws_2c91e4", now: NOW }, parse).state, null);
    const t = mint({ workspace: "ws_2c91e4", cloudPlan: STARTER });
    assert.equal(resolvePlan({ inForce: `${t.split(".")[0]}.AAAA`, workspaceId: "ws_2c91e4", now: NOW }, parse).state, null);
    assert.ok(resolvePlan({ inForce: mint({ workspace: "ws_2c91e4", cloudPlan: STARTER, expires: "2026-11-20" }), workspaceId: "ws_2c91e4", now: NOW }, parse).state, "in grace still counts");
  });

  test("without COMPASSDOCS_WORKSPACE_ID there is nothing to compare: the plan is used, never remembered", () => {
    const r = resolvePlan({ inForce: mint({ workspace: "ws_any", cloudPlan: STARTER }), workspaceId: null, now: NOW }, parse);
    assert.equal(r.state?.plan.name, "starter");
    assert.equal(r.remember, null);
  });
});

describe("the billing contact (Decision 5, review)", () => {
  test("an address set here; every admin chosen here over the licence's contact; else the licence's; else every admin", () => {
    assert.deepEqual(billingContactFrom("ops@acme.example", "lic@acme.example"), { email: "ops@acme.example", source: "here", licenseContact: "lic@acme.example" });
    assert.deepEqual(billingContactFrom(BILLING_ALL_ADMINS, "lic@acme.example"), { email: "", source: "admins", licenseContact: "lic@acme.example" });
    assert.deepEqual(billingContactFrom("", "lic@acme.example"), { email: "lic@acme.example", source: "license", licenseContact: "lic@acme.example" });
    assert.deepEqual(billingContactFrom(undefined, null), { email: "", source: "default", licenseContact: null });
  });
});

describe("agents by contract (no maximum, review)", () => {
  test("never extra agents, so never a price", () => {
    const d = plan({ name: "dedicated", agentsIncluded: 0, agentsMax: null, activeUsersLimit: null, aiAllowanceUsd: null });
    assert.equal(extraAgents(30, d), 0);
    assert.equal(agentHoldAt(d), null);
  });
});
