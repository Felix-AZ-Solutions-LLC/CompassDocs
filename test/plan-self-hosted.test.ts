// Self-hosted installs don't change (1.22.0, design E): without cloud mode
// there is no plan, whatever is stood in or saved; the Plan & usage section
// is hidden and every one of its APIs answers 404; nothing is noted, counted
// or capped; the email library doesn't list the plan's email; and the AI
// entry points get no status.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/plan-self-hosted.test.ts

delete process.env.COMPASSDOCS_CLOUD;

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { pool, getSetting } from "../src/lib/db";
import { fixtureQuery } from "./support/retry";
import { cloudStartupProblems, sectionHiddenInMode, PLAN_SECTION, usageReportUrl } from "../src/lib/cloud";
import { parsePlanClaim, monthStart, type CloudPlan } from "../src/lib/plan-shared";
import { cloudPlanState, planResolution, setPlanForTests } from "../src/lib/plan";
import * as usage from "../src/lib/plan-usage";
import { listedTemplates, templateDef } from "../src/lib/email-templates";
import { SETTINGS_SECTIONS } from "../src/lib/settings-sections";

const PLAN = parsePlanClaim({ name: "starter", agentsIncluded: 3, agentsMax: 10, activeUsersLimit: 250, storageGb: 25, aiAllowanceUsd: 15, renewsAt: "2031-03-14" }) as CloudPlan;
let uid = 0;

before(async () => {
  await getSetting("__schema_bootstrap__");
  // Even with a plan stood in, self-hosted has none: cloud mode is the first switch.
  setPlanForTests({ state: { plan: PLAN, license: { id: "x", customer: "x", plan: "starter", features: [], seats: 0, issued: "2026-01-01", expires: "2031-01-01" }, source: "in_force", mismatch: null }, mismatch: null, remember: null });
  const r = await fixtureQuery("INSERT INTO users (username, name) VALUES ($1, 'Self Hosted') RETURNING id", [`selfhosted-${Date.now()}-${process.pid}`]);
  uid = r.rows[0].id;
});

after(async () => {
  setPlanForTests(null);
  await fixtureQuery("DELETE FROM users WHERE id = $1", [uid]);
  await pool().end();
});

describe("self-hosted: nothing new appears", () => {
  test("no plan, no mismatch", async () => {
    assert.equal(await cloudPlanState(), null);
    assert.deepEqual(await planResolution(), { state: null, mismatch: null, remember: null });
  });

  test("Plan & usage is hidden from the rail, its search and the palette", () => {
    assert.ok(SETTINGS_SECTIONS.some((s) => s.href === PLAN_SECTION), "registered once, in the one place sections live");
    assert.equal(sectionHiddenInMode(PLAN_SECTION), true);
    assert.equal(sectionHiddenInMode(PLAN_SECTION, { COMPASSDOCS_CLOUD: "1" }), false, "cloud mode: lib/auth then asks for a plan");
    assert.equal(sectionHiddenInMode("/admin/license"), false);
  });

  test("every Plan & usage API answers 404", async () => {
    const plan = await import("../src/app/api/admin/plan/route");
    const people = await import("../src/app/api/admin/plan/people/route");
    const settings = await import("../src/app/api/admin/plan/settings/route");
    const upgrade = await import("../src/app/api/admin/plan/upgrade/route");
    const notices = await import("../src/app/api/plan/notices/route");
    const json = (body: unknown) => new Request("http://localhost/api/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await plan.GET()).status, 404);
    assert.equal((await people.GET(new Request("http://localhost/api/admin/plan/people"))).status, 404);
    assert.equal((await settings.PUT(json({ ai_spending: "stop" }))).status, 404);
    assert.equal((await upgrade.POST(json({ target: "shared", reply_to: "a@b.example" }))).status, 404);
    assert.equal((await notices.GET()).status, 404);
    assert.equal((await notices.POST(json({ dismiss: [{ meter: "users", threshold: "80" }] }))).status, 404);
  });

  test("nobody is noted as active and no AI is recorded or capped", async () => {
    usage.resetActiveMemoForTests();
    usage.noteActive("user", uid);
    await usage.recordAiUsage({ feature: "ask", userId: uid, model: "claude-opus-5-5", tokens: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 } });
    await new Promise((r) => setTimeout(r, 150));
    const a = await pool().query("SELECT 1 FROM plan_active_users WHERE kind = 'user' AND subject_id = $1 AND month = $2", [uid, monthStart(new Date())]);
    assert.equal(a.rowCount, 0);
    const ai = await pool().query("SELECT 1 FROM ai_usage WHERE user_id = $1", [uid]);
    assert.equal(ai.rowCount, 0);
    assert.equal(await usage.aiGate(), null);
    await usage.assertAiAllowed();
    assert.equal(await usage.aiPlanStatus(true), null, "no status for the AI entry points");
  });

  test("the daily count does nothing, and no usage endpoint exists", async () => {
    const t = await usage.planUsageTick(new Date(), { report: false });
    assert.deepEqual(t.counted, []);
    assert.equal(usageReportUrl({ COMPASSDOCS_LICENSE_URL: "https://console.example/license", COMPASSDOCS_LICENSE_TOKEN: "t", COMPASSDOCS_WORKSPACE_ID: "ws" }), null);
    assert.deepEqual(cloudStartupProblems({ COMPASSDOCS_USAGE_URL: "https://elsewhere.example/usage" }), { fatal: [], warnings: [] });
  });

  test("the email library doesn't list the plan's email; its definition stays for cloud mode", () => {
    assert.ok(!listedTemplates().some((t) => t.key === "plan_usage_threshold"));
    assert.ok(templateDef("plan_usage_threshold"));
  });
});
