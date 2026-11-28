// CompassDocs Cloud plan usage (1.22.0, lib/plan-usage) against the
// database: who counts as an active user (once a month, under their
// highest role; requesters only when they sign in; never disabled accounts
// or CompassDocs support), which storage counts (Decision 4), AI dollars by
// feature from both ledgers and the monthly cap, banner dismissal per admin
// per threshold per month, the threshold email (once per threshold per
// month, at most one a day), the warning recipients (Decision 5), the
// daily count and the 13-month history.
//
// Cloud mode is on for this file (COMPASSDOCS_CLOUD=1) and the plan is
// stood in (lib/plan setPlanForTests): no test can hold a licence the
// vendor signed. Activity, AI and threshold rows use months of their own in
// 2030, so files running at once (which may note activity this month) never
// change these counts.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/plan-usage.test.ts

process.env.COMPASSDOCS_CLOUD = "1";
// The platform's AI key (cloud mode's ANTHROPIC_API_KEY): only AI on it is the plan's (lib/plan-usage aiMetered).
process.env.ANTHROPIC_API_KEY = "sk-ant-test-platform";

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { pool, getSetting, setSetting } from "../src/lib/db";
import { fixtureQuery } from "./support/retry";
import { parsePlanClaim, GB, type CloudPlan } from "../src/lib/plan-shared";
import { setPlanForTests, type PlanState } from "../src/lib/plan";
import * as usage from "../src/lib/plan-usage";

const STAMP = `plan-${Date.now()}-${process.pid}`;
const PLAN = parsePlanClaim({ name: "starter", agentsIncluded: 3, agentsMax: 10, activeUsersLimit: 250, storageGb: 25, aiAllowanceUsd: 15, renewsAt: "2031-03-14" }) as CloudPlan;
const STATE: PlanState = { plan: PLAN, license: { id: "lic_test", customer: "Test", plan: "starter", features: [], seats: 0, issued: "2026-03-14", expires: "2031-03-14", workspace: "ws_test" }, source: "in_force", mismatch: null };

const userIds: number[] = [];
const contactIds: number[] = [];
const U: Record<string, number> = {};

async function user(key: string, role: string, status = "active", provider = "local"): Promise<number> {
  const r = await fixtureQuery("INSERT INTO users (username, name, email, role, status, auth_provider) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id", [
    `${STAMP}-${key}`,
    `Person ${key}`,
    `${STAMP}-${key}@example.test`,
    role,
    status,
    provider,
  ]);
  userIds.push(r.rows[0].id);
  U[key] = r.rows[0].id;
  return r.rows[0].id;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  setPlanForTests({ state: STATE, mismatch: null, remember: null });
  await user("viewer", "viewer");
  await user("editor", "editor");
  await user("approver", "approver");
  await user("admin", "admin");
  await user("agent", "viewer");
  await user("disabled", "editor", "disabled");
  await user("support", "admin", "service", "compassdocs_support");
  await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, 'agent') ON CONFLICT (user_id) DO UPDATE SET role = 'agent'", [U.agent]);
  const c = await fixtureQuery("INSERT INTO hd_portal_contacts (email, name) VALUES ($1, 'Chris Requester') RETURNING id", [`${STAMP}-req@customer.example`]);
  contactIds.push(c.rows[0].id);
});

after(async () => {
  setPlanForTests(null);
  await pool().query("DELETE FROM plan_active_users WHERE month >= '2030-01-01' AND month < '2031-01-01'");
  await pool().query("DELETE FROM ai_usage WHERE at >= '2030-01-01' AND at < '2031-01-01'");
  await pool().query("DELETE FROM hd_claude_usage WHERE at >= '2030-01-01' AND at < '2031-01-01'");
  await pool().query("DELETE FROM plan_notices WHERE month >= '2030-01-01' AND month < '2031-01-01'");
  await pool().query("DELETE FROM plan_banner_dismissals WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM plan_usage_daily WHERE day >= '2030-01-01' AND day < '2031-01-01'");
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_portal_contacts WHERE id = ANY($1)", [contactIds]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await setSetting(usage.AI_SPENDING_SETTING, "keep");
  await setSetting(usage.AI_CAP_SETTING, "");
  await setSetting(usage.BILLING_CONTACT_SETTING, "");
  await pool().end();
});

const MAY = new Date("2030-05-20T12:00:00Z");

describe("active users", () => {
  test("each person once a month, under their highest role; requesters when they sign in", async () => {
    const day = (d: number) => new Date(`2030-05-${String(d).padStart(2, "0")}T09:00:00Z`);
    for (const k of ["viewer", "editor", "approver", "admin", "agent"]) {
      await usage.recordActive("user", U[k], day(2));
      await usage.recordActive("user", U[k], day(9)); // a second day: still once
    }
    await usage.recordActive("portal", contactIds[0], day(4));
    const r = await usage.activeUsers(MAY);
    assert.equal(r.count, 6);
    // A workspace Administrator works the desk (helpdesk.admin from the role), so counts as an agent, like the licence's count.
    assert.deepEqual(r.byKind, { Agents: 2, Admins: 0, Approvers: 1, Editors: 1, Viewers: 1, Requesters: 1 });
    const people = await usage.activePeople(MAY);
    const agent = people.find((p) => p.name === "Person agent")!;
    assert.equal(agent.countedAs, "Agent", "a viewer on the desk counts as an agent");
    assert.equal(agent.detail, "Viewer in CompassDocs");
    assert.equal(people.find((p) => p.name === "Chris Requester")?.detail, "Customer portal");
  });

  test("never disabled accounts or CompassDocs support sessions", async () => {
    await usage.recordActive("user", U.disabled, new Date("2030-05-05T09:00:00Z"));
    await usage.recordActive("user", U.support, new Date("2030-05-05T09:00:00Z"));
    assert.equal((await usage.activeUsers(MAY)).count, 6);
  });

  test("a count as of a moment leaves out who came later (a day's final count)", async () => {
    assert.equal((await usage.activeUsers(MAY, new Date("2030-05-03T00:00:00Z"))).count, 5, "the requester first came on the 4th");
  });

  test("a new month starts again", async () => {
    assert.equal((await usage.activeUsers(new Date("2030-06-02T00:00:00Z"))).count, 0);
  });

  test("noteActive writes once a day per person, without waiting", async () => {
    usage.resetActiveMemoForTests();
    const at = new Date("2030-05-21T08:00:00Z");
    usage.noteActive("user", U.viewer, at);
    usage.noteActive("user", U.viewer, new Date("2030-05-21T17:00:00Z"));
    await new Promise((r) => setTimeout(r, 200));
    const row = await pool().query("SELECT last_at FROM plan_active_users WHERE month = '2030-05-01' AND kind = 'user' AND subject_id = $1", [U.viewer]);
    assert.equal(new Date(row.rows[0].last_at).toISOString(), at.toISOString(), "the second call that day wrote nothing");
  });
});

describe("storage (Decision 4)", () => {
  test("files, document text and versions and the Trash count; the desk's files count under Helpdesk; exports never", () => {
    const s = usage.storageAreas({ storeBytes: 7.8 * GB, deskFileBytes: 1.5 * GB, docTextBytes: 3.4 * GB, deskTextBytes: 0.4 * GB, exportBytes: 0.8 * GB });
    assert.equal(Math.round(s.areas.files / 1e8), 63, "the store's files less the desk's");
    assert.equal(s.areas.documents, 3.4 * GB);
    assert.equal(s.areas.helpdesk, 1.9 * GB);
    assert.equal(Math.round(s.bytes / 1e8), 116);
    assert.equal(s.notCounted.exports, 0.8 * GB);
  });

  test("the count reads the database and the file store, and leaves exports out", async () => {
    await pool().query("INSERT INTO workspace_exports (id, status, size) VALUES ($1, 'ready', $2)", [`${STAMP}-exp`, 5 * GB]);
    try {
      const s = await usage.countStorage();
      assert.ok(s.notCounted.exports >= 5 * GB);
      assert.equal(s.bytes, s.areas.files + s.areas.documents + s.areas.helpdesk);
      assert.ok(s.areas.documents > 0, "documents' text counts");
    } finally {
      await pool().query("DELETE FROM workspace_exports WHERE id = $1", [`${STAMP}-exp`]);
    }
  });
});

describe("AI cost by feature and the cap", () => {
  test("both ledgers, by feature, at the price list", async () => {
    await usage.recordAiUsage({ feature: "ask", userId: U.viewer, model: "claude-sonnet-5-5", tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } }, new Date("2030-05-10T10:00:00Z"));
    await usage.recordAiUsage({ feature: "write", userId: U.editor, model: "claude-opus-5-5", tokens: { input: 100_000, output: 100_000, cacheRead: 0, cacheWrite: 0 } }, new Date("2030-05-11T10:00:00Z"));
    await usage.recordAiUsage({ feature: "mcp", model: "x", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.6 }, new Date("2030-05-12T10:00:00Z"));
    await pool().query("INSERT INTO hd_claude_usage (user_id, model, cost_usd, requests, stop_reason, at, plan_metered) VALUES ($1, 'claude-opus-5-5', 7.85, 1, 'end_turn', '2030-05-12T11:00:00Z', true)", [U.agent]);
    // A desk turn on an admin's own key: theirs to pay, never the plan's.
    await pool().query("INSERT INTO hd_claude_usage (user_id, model, cost_usd, requests, stop_reason, at, plan_metered) VALUES ($1, 'claude-opus-5-5', 99, 1, 'end_turn', '2030-05-12T12:00:00Z', false)", [U.agent]);
    // A desk turn still running (its one-step reservation): counted by the cap's check only.
    await pool().query("INSERT INTO hd_claude_usage (user_id, model, cost_usd, requests, stop_reason, at, plan_metered) VALUES ($1, 'claude-opus-5-5', 0.5, 0, 'running', $2, true)", [U.agent, new Date("2030-05-12T13:00:00Z")]);
    const m = await usage.aiMonth(MAY);
    assert.equal(m.byFeature.ask, 2, "1M input tokens of Sonnet 5.5 at $2");
    assert.equal(m.byFeature.write, 2.4, "100k in at $4 + 100k out at $20 per million");
    assert.equal(m.byFeature.mcp, 0.6);
    assert.equal(m.byFeature.desk, 7.85);
    assert.equal(m.total, 12.85);
    assert.equal(m.deskTurns, 1);
    assert.equal(m.askAnswers, 1);
    assert.equal((await usage.aiMonth(MAY, undefined, { reserved: true })).total, 13.35, "the cap's check counts the running turn's reservation");
    await pool().query("DELETE FROM hd_claude_usage WHERE stop_reason = 'running' AND at = '2030-05-12T13:00:00Z'");
  });

  test("keep AI on (the default): never paused", async () => {
    await setSetting(usage.AI_SPENDING_SETTING, "");
    assert.deepEqual(await usage.getAiSpending(), { spending: "keep", capUsd: null });
    assert.equal(await usage.aiGate(MAY), null);
  });

  test("a cap above the month's spending lets AI through; at it, AI pauses until the 1st", async () => {
    await usage.setAiSpending({ spending: "cap", capUsd: 40 });
    assert.equal(await usage.aiGate(MAY), null, "$12.85 of a $40 cap");
    const at = "2030-05-18T10:00:00.000Z";
    await usage.recordAiUsage({ feature: "write", model: "x", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 27.15 }, new Date(at));
    try {
      assert.deepEqual(await usage.aiGate(MAY), { until: "1 Jun" });
      // The error's sentence names no audience: the screens add "Admins can raise…" or "Ask an admin…" for their reader.
      await assert.rejects(usage.assertAiAllowed(MAY, "desk"), (e: Error) => e.name === "AiPausedError" && e.message === "AI is paused until 1 Jun: this workspace reached its monthly AI limit.");
      await usage.setAiSpending({ spending: "cap", capUsd: 5 });
      assert.deepEqual(await usage.getAiSpending(), { spending: "cap", capUsd: 5 });
    } finally {
      await pool().query("DELETE FROM ai_usage WHERE at = $1", [at]);
    }
    await usage.setAiSpending({ spending: "cap", capUsd: 14 });
    assert.equal(await usage.aiGate(MAY), null, "a cap below the $15 allowance caps at the allowance: $12.85 goes through");
  });

  test("stop at the allowance: paused once the $15 is used", async () => {
    await usage.setAiSpending({ spending: "stop", capUsd: null });
    assert.equal(await usage.aiGate(MAY), null, "$12.85 of $15");
    await usage.recordAiUsage({ feature: "ask", model: "x", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 2.15 }, new Date("2030-05-19T10:00:00Z"));
    assert.deepEqual(await usage.aiGate(MAY), { until: "1 Jun" });
    assert.equal(await usage.aiGate(new Date("2030-06-01T00:10:00Z")), null, "a new month starts again");
    await usage.setAiSpending({ spending: "keep", capUsd: null });
  });

  test("the entry points' status: the pause for everyone, the 'beyond' line for admins only (Decision 7)", async () => {
    await usage.recordAiUsage({ feature: "ask", model: "x", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 1 }, new Date("2030-05-19T11:00:00Z"));
    const pick = (s: Awaited<ReturnType<typeof usage.aiPlanStatus>>) => s && { pausedUntil: s.pausedUntil, admin: s.admin, beyond: s.beyond };
    assert.deepEqual(pick(await usage.aiPlanStatus(true, MAY)), { pausedUntil: null, admin: true, beyond: true });
    assert.deepEqual(pick(await usage.aiPlanStatus(false, MAY)), { pausedUntil: null, admin: false, beyond: false });
    await usage.setAiSpending({ spending: "stop", capUsd: null });
    const paused = await usage.aiPlanStatus(false, MAY);
    assert.deepEqual(pick(paused), { pausedUntil: "1 Jun", admin: false, beyond: false });
    assert.equal(paused?.month, "May");
    assert.equal(paused?.restartsOn, "1 June", "design D3: \"It starts again on 1 June\"");
    // On an admin's own key nothing is the plan's: never paused, never "beyond".
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      assert.equal(await usage.aiMetered("desk"), false);
      assert.equal(await usage.aiGate(MAY, "desk"), null, "an admin's own key is never paused by the plan");
      assert.deepEqual(pick(await usage.aiPlanStatus(true, MAY)), { pausedUntil: null, admin: true, beyond: false });
    } finally {
      process.env.ANTHROPIC_API_KEY = key;
    }
    assert.equal(await usage.aiMetered("desk"), true);
    await usage.setAiSpending({ spending: "keep", capUsd: null });
  });
});

describe("banners: dismissal per admin, per threshold, per month (Decision 9)", () => {
  test("a dismissed threshold is gone for that admin only", async () => {
    // A count for a day in 2030 that puts active users at 82%.
    await pool().query(
      `INSERT INTO plan_usage_daily (day, counted_at, plan, agents, active_users, storage_bytes, ai_usd) VALUES ('2030-05-20', '2030-05-20T06:00:00Z', 'starter', 3, 204, $1, 0)
       ON CONFLICT (day) DO UPDATE SET active_users = 204, counted_at = EXCLUDED.counted_at`,
      [11 * GB]
    );
    const users = async (id: number) => (await usage.noticesFor(id, MAY)).filter((n) => n.meter === "users").map((n) => `${n.meter}:${n.threshold}`);
    assert.deepEqual(await users(U.admin), ["users:80"]);
    await usage.dismissNotices(U.admin, [{ meter: "users", threshold: "80" }], MAY);
    assert.deepEqual(await users(U.admin), []);
    assert.deepEqual(await users(U.approver), ["users:80"], "another admin still sees it");
    await pool().query("UPDATE plan_usage_daily SET active_users = 263 WHERE day = '2030-05-20'");
    assert.deepEqual(await users(U.admin), ["users:limit"], "the next threshold shows again");
    assert.deepEqual(await users(U.admin).then(() => usage.noticesFor(U.admin, new Date("2030-06-02T00:00:00Z"))).then((n) => n.filter((x) => x.meter === "users")), [], "June has no count yet");
  });
});

describe("the threshold email", () => {
  test("once per meter per threshold per month, at most one a day, to the billing contact when named", async () => {
    await setSetting(usage.BILLING_CONTACT_SETTING, `${STAMP}-billing@example.test`);
    assert.deepEqual(await usage.warningRecipients(STATE), [{ email: `${STAMP}-billing@example.test`, userId: null }]);
    await setSetting(usage.BILLING_CONTACT_SETTING, "");
    const admins = await usage.warningRecipients(STATE);
    assert.ok(admins.some((a) => a.userId === U.admin), "every active admin");
    assert.ok(!admins.some((a) => a.userId === U.support), "never CompassDocs support");

    const row = (users: number) => ({ day: "2030-06-10", counted_at: "2030-06-10T06:00:00Z", plan: "starter", agents: 3, active_users: users, storage_bytes: 0, storage: { bytes: 0, areas: { files: 0, documents: 0, helpdesk: 0 }, notCounted: { exports: 0 } }, ai_usd: 0, ai: { desk: 0, ask: 0, write: 0, mcp: 0 }, reported_at: null, reported_counted_at: null, report_attempts: 0, report_error: "" });
    const d10 = new Date("2030-06-10T07:00:00Z");
    const first = await usage.sendThresholdEmail(STATE, row(204), d10);
    assert.deepEqual(first.map((n) => `${n.meter}:${n.threshold}`), ["users:80"]);
    assert.deepEqual(await usage.sendThresholdEmail(STATE, row(263), d10), [], "never two in a day");
    const d11 = new Date("2030-06-11T07:00:00Z");
    assert.deepEqual((await usage.sendThresholdEmail(STATE, { ...row(204), day: "2030-06-11" }, d11)).length, 0, "80% was sent this month");
    const next = await usage.sendThresholdEmail(STATE, { ...row(263), day: "2030-06-11" }, d11);
    assert.deepEqual(next.map((n) => n.threshold), ["limit"]);
  });
});

describe("the daily count and the history", () => {
  test("a trend is one value a month: the final count, agents the month's highest", () => {
    const rows = [
      { day: "2030-04-03", agents: 4, active_users: 100, storage_bytes: 9 * GB, ai_usd: 3 },
      { day: "2030-04-30", agents: 3, active_users: 180, storage_bytes: 10 * GB, ai_usd: 12.4 },
      { day: "2030-05-20", agents: 3, active_users: 204, storage_bytes: 11.2 * GB, ai_usd: 13.1 },
    ];
    const t = usage.trendFrom(rows, "users", MAY);
    assert.equal(t.length, 6);
    assert.deepEqual(t.slice(-2), [
      { month: "2030-04", value: 180, partial: false },
      { month: "2030-05", value: 204, partial: true },
    ]);
    assert.equal(usage.trendFrom(rows, "agents", MAY)[4].value, 4);
    assert.equal(usage.trendFrom(rows, "storage", MAY)[5].value, 11.2);
    assert.equal(usage.trendFrom(rows, "ai", MAY)[4].value, 12.4);
    assert.equal(usage.trendFrom(rows, "users", MAY)[0].value, null, "a month with no count");
  });

  test("a count is written for its day and replaces an earlier one", async () => {
    const c = await usage.countUsage(STATE, new Date("2030-05-21T00:00:00Z"));
    assert.equal(c.day, "2030-05-20", "counted at midnight: the day that ended");
    assert.equal(c.plan, "starter");
    assert.ok(c.activeUsers >= 6);
    await usage.saveCounts(c);
    const kept = await usage.countsBetween("2030-05-20", "2030-05-20");
    assert.equal(kept.length, 1);
    assert.equal(kept[0].active_users, c.activeUsers);
  });

  test("13 months are kept", async () => {
    await pool().query("INSERT INTO plan_usage_daily (day, plan) VALUES ('2030-01-15', 'starter') ON CONFLICT DO NOTHING");
    await pool().query("INSERT INTO plan_usage_daily (day, plan) VALUES ('2030-02-01', 'starter') ON CONFLICT DO NOTHING");
    await usage.purgeHistory(new Date("2031-02-10T00:00:00Z"));
    const left = await pool().query("SELECT to_char(day, 'YYYY-MM-DD') AS day FROM plan_usage_daily WHERE day IN ('2030-01-15', '2030-02-01')");
    assert.deepEqual(left.rows.map((r) => r.day), ["2030-02-01"]);
  });
});

// --- 1.22.0 review fixes ------------------------------------------------------------------------

/** A plan with no limits: the runs below send no threshold email whatever they count. */
const OPEN = parsePlanClaim({ name: "dedicated", agentsIncluded: 0, agentsMax: null, activeUsersLimit: null, storageGb: null, aiAllowanceUsd: null, renewsAt: "2031-03-14" }) as CloudPlan;
const OPEN_STATE: PlanState = { ...STATE, plan: OPEN };

/** A file store stand-in: `list()` yields the stored files (only file keys, as the real stores do); `usage()` is the container's every blob. */
function fakeStore(files: number[], opts: { failList?: boolean } = {}) {
  return {
    async *list() {
      if (opts.failList) throw new Error("the container could not be listed");
      for (const [i, size] of files.entries()) yield { key: `${String(i).padStart(32, "0")}.png`, size, modifiedAt: new Date() };
    },
    async usage() {
      throw new Error("usage() sums every blob, exports included: the plan must never read it");
    },
  };
}

describe("review: one person, one active user (a portal contact who is also an app user)", () => {
  test("a requester whose email is an active user's counts once, as that user; the count, chips and list agree", async () => {
    const c = await fixtureQuery("INSERT INTO hd_portal_contacts (email, name) VALUES ($1, 'Same Person') RETURNING id", [`${STAMP}-editor@example.test`.toUpperCase()]);
    contactIds.push(c.rows[0].id);
    const at = new Date("2030-09-03T09:00:00Z");
    await usage.recordActive("user", U.editor, at);
    await usage.recordActive("portal", c.rows[0].id, new Date("2030-09-04T09:00:00Z"));
    await usage.recordActive("portal", contactIds[0], at);
    const sep = new Date("2030-09-20T00:00:00Z");
    const s = await usage.activeSummary(sep);
    assert.equal(s.count, 2, "the editor and the other requester: the editor's portal sign-in is the editor");
    assert.equal(s.people.length, s.count);
    assert.deepEqual(s.byKind, { Agents: 0, Admins: 0, Approvers: 0, Editors: 1, Viewers: 0, Requesters: 1 });
    assert.equal((await usage.activeUsers(sep)).count, s.count, "the daily count says the same");
    assert.ok(!s.people.some((p) => p.name === "Same Person"));
  });
});

describe("review: storage counts the stored files, never the container's other blobs", () => {
  test("the store's listing (file keys only), never usage(), which in blob mode includes workspace exports", async () => {
    const desk = Number((await pool().query("SELECT coalesce(sum(size), 0) AS n FROM hd_attachments")).rows[0].n);
    const s = await usage.countStorage(fakeStore([1000, 2000, 3000]));
    // The listing's 6000 bytes, less the desk's attachments (they count under Helpdesk); usage() was never called (it throws).
    assert.equal(s.areas.files, Math.max(0, 6000 - desk));
    assert.equal(await usage.storedFileBytes(fakeStore([1000, 2000, 3000])), 6000);
  });

  test("a store that can't be listed fails the count (never a 0)", async () => {
    await assert.rejects(usage.countStorage(fakeStore([], { failList: true })), /could not be listed/);
  });
});

describe("review: the count is all or nothing, under a tried lock, one run at a time", () => {
  before(() => setPlanForTests({ state: OPEN_STATE, mismatch: null, remember: null }));
  after(() => setPlanForTests({ state: STATE, mismatch: null, remember: null }));

  test("a part that fails fails the whole count: nothing is saved or sent", async () => {
    usage.resetPlanTickForTests();
    const at = new Date("2030-07-15T09:00:00Z");
    await assert.rejects(usage.countUsage(OPEN_STATE, at, { store: fakeStore([], { failList: true }) }));
    await assert.rejects(usage.planUsageTick(at, { report: false, store: fakeStore([], { failList: true }) }));
    assert.equal((await usage.countsBetween("2030-07-14", "2030-07-15")).length, 0, "no partial count was saved");
  });

  test("another replica holding the lock: this one skips at once (never waits on a pool connection)", async () => {
    usage.resetPlanTickForTests();
    const other = await pool().connect();
    try {
      await other.query("SELECT pg_advisory_lock(hashtext('plan-usage'))");
      const started = Date.now();
      const r = await usage.planUsageTick(new Date("2030-07-16T09:00:00Z"), { report: false, store: fakeStore([10]) });
      assert.equal(r.skipped, true);
      assert.deepEqual(r.counted, []);
      assert.ok(Date.now() - started < 5000, "it did not wait for the lock");
    } finally {
      await other.query("SELECT pg_advisory_unlock(hashtext('plan-usage'))");
      other.release();
    }
    assert.equal((await usage.countsBetween("2030-07-16", "2030-07-16")).length, 0);
  });

  test("two runs at once in a process share one count", async () => {
    usage.resetPlanTickForTests();
    const at = new Date("2030-07-17T09:00:00Z");
    const a = usage.planUsageTick(at, { report: false, store: fakeStore([10]) });
    const b = usage.planUsageTick(at, { report: false, store: fakeStore([10]) });
    assert.equal(a, b, "the second call gets the first's run");
    const r = await a;
    assert.deepEqual(r.counted, ["2030-07-17"]);
    assert.equal((await usage.countsBetween("2030-07-17", "2030-07-17")).length, 1);
  });

  test("a page never waits for a count: it starts one in the background, at most one at a time and one per five minutes", async () => {
    usage.resetPlanTickForTests();
    const at = new Date("2030-07-18T09:00:00Z");
    const other = await pool().connect();
    try {
      // Hold the lock so the background run is quick and saves nothing (the page's answer is what is tested).
      await other.query("SELECT pg_advisory_lock(hashtext('plan-usage'))");
      assert.equal(await usage.ensureCounted(at), true, "today has no count: one is started");
      assert.equal(await usage.ensureCounted(at), false, "not a second one");
      await usage.planUsageTick(at).catch(() => {});
    } finally {
      await other.query("SELECT pg_advisory_unlock(hashtext('plan-usage'))");
      other.release();
    }
    assert.equal(await usage.ensureCounted(at), false, "started less than five minutes ago");
    usage.resetPlanTickForTests();
  });
});

describe("review: the AI cap holds under concurrency (reservations), on the platform's key only", () => {
  const JUL = new Date("2030-07-10T10:00:00Z");
  after(async () => usage.setAiSpending({ spending: "keep", capUsd: null }));

  test("requests at the same time each reserve their most; once reservations reach the cap the next is refused", async () => {
    await usage.setAiSpending({ spending: "cap", capUsd: 20 });
    const admit = () => usage.admitAi({ feature: "ask", userId: U.viewer, model: "claude-sonnet-5-5", reserveUsd: 12 }, JUL);
    const r = await Promise.allSettled([admit(), admit(), admit()]);
    const ok = r.filter((x) => x.status === "fulfilled") as PromiseFulfilledResult<number | null>[];
    assert.equal(ok.length, 2, "$0 and $12 are under the $20 cap; $24 is not (the overshoot is at most the one request admitted last)");
    assert.equal(r.filter((x) => x.status === "rejected" && (x.reason as Error).name === "AiPausedError").length, 1);
    // Settled at what they used: a smaller cost frees the cap again; a failed request's reservation goes.
    await usage.settleAi(ok[0].value!, { model: "claude-sonnet-5-5", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 1 });
    await usage.settleAi(ok[1].value!, null);
    const m = await usage.aiMonth(JUL);
    assert.equal(m.byFeature.ask, 1, "the settled request at its cost; the failed one gone");
    const again = await usage.admitAi({ feature: "ask", model: "claude-sonnet-5-5", reserveUsd: 1 }, JUL);
    assert.notEqual(again, null, "under the cap again");
    await usage.settleAi(again!, null);
  });

  test("a reservation counts for the cap's check, never for the counts and pages", async () => {
    const before = (await usage.aiMonth(JUL)).total;
    const id = await usage.admitAi({ feature: "write", model: "claude-sonnet-5-5", reserveUsd: 3 }, JUL);
    assert.ok(id);
    assert.equal((await usage.aiMonth(JUL)).total, before);
    assert.equal((await usage.aiMonth(JUL, undefined, { reserved: true })).total, Math.round((before + 3) * 1e6) / 1e6);
    await usage.settleAi(id!, null);
  });
});

describe("review: the billing contact (Decision 5)", () => {
  const LIC: PlanState = { ...STATE, plan: { ...PLAN, billingContact: `${STAMP}-lic@example.test` } };
  after(async () => setSetting(usage.BILLING_CONTACT_SETTING, ""));

  test("the licence's contact by default; every admin when chosen here, whatever the licence names; an address set here first", async () => {
    await setSetting(usage.BILLING_CONTACT_SETTING, "");
    assert.deepEqual(await usage.warningRecipients(LIC), [{ email: `${STAMP}-lic@example.test`, userId: null }]);
    await setSetting(usage.BILLING_CONTACT_SETTING, "all_admins");
    const admins = await usage.warningRecipients(LIC);
    assert.ok(admins.some((a) => a.userId === U.admin) && !admins.some((a) => a.email.endsWith("-lic@example.test")), "the licence's contact can be overridden");
    await setSetting(usage.BILLING_CONTACT_SETTING, `${STAMP}-here@example.test`);
    assert.deepEqual(await usage.warningRecipients(LIC), [{ email: `${STAMP}-here@example.test`, userId: null }]);
  });
});
