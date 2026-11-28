// Usage to the console (1.22.0, lib/plan-report; README "Usage to the
// console"): the body carries counts only (no names, emails or content),
// one report per workspace and day under its idempotency key, the request
// is limited like the licence request (time, size, no redirect), each
// answer is handled by the contract, and failures back off and retry
// without resending what the console already has.
//
// A fake console stands in for the network (setUsageReportDepsForTests);
// the plan is stood in (lib/plan setPlanForTests). Rows use days in 2032,
// which no other file touches.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/plan-report.test.ts

process.env.COMPASSDOCS_CLOUD = "1";
process.env.COMPASSDOCS_LICENSE_URL = "https://console.example/api/cloud/license";
process.env.COMPASSDOCS_LICENSE_TOKEN = "console-token-test";
process.env.COMPASSDOCS_WORKSPACE_ID = "ws_report_test";
delete process.env.COMPASSDOCS_LICENSE_AUDIENCE;
delete process.env.COMPASSDOCS_USAGE_URL;

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { pool, getSetting } from "../src/lib/db";
import { fixtureQuery } from "./support/retry";
import { parsePlanClaim, type CloudPlan } from "../src/lib/plan-shared";
import { setPlanForTests, type PlanState } from "../src/lib/plan";
import { usageReportProblems, usageReportUrl } from "../src/lib/cloud";
import * as report from "../src/lib/plan-report";

const PLAN = parsePlanClaim({ name: "starter", agentsIncluded: 3, agentsMax: 10, activeUsersLimit: 250, storageGb: 25, aiAllowanceUsd: 15, renewsAt: "2033-03-14" }) as CloudPlan;
const STATE: PlanState = { plan: PLAN, license: { id: "lic_report", customer: "Northwind Traders", plan: "starter", features: [], seats: 0, issued: "2032-03-14", expires: "2033-03-14", workspace: "ws_report_test" }, source: "in_force", mismatch: null };

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
const seen: Seen[] = [];
let answer: (n: number) => Response | Promise<Response> = () => new Response(null, { status: 204 });

const fakeFetch = (async (url: URL | string, init?: RequestInit) => {
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  seen.push({ url: String(url), method: init?.method ?? "GET", headers, body: JSON.parse(String(init?.body ?? "{}")) });
  return answer(seen.length);
}) as typeof fetch;

let clock = Date.parse("2032-05-21T00:10:00Z");
const DAYS = ["2032-05-18", "2032-05-19", "2032-05-20"];
const SECRET_NAME = "Priya Shah-Report";
const SECRET_EMAIL = "priya.report@northwind.example";

before(async () => {
  await getSetting("__schema_bootstrap__");
  setPlanForTests({ state: STATE, mismatch: null, remember: null });
  report.setUsageReportDepsForTests({ fetch: fakeFetch, credential: async () => "console-token-test", now: () => clock, random: () => 0.5, timeoutMs: 2000 });
  // A person with a name and an address exists; nothing of theirs may leave.
  await fixtureQuery("INSERT INTO users (username, name, email) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [`report-${process.pid}`, SECRET_NAME, SECRET_EMAIL]);
  for (const [i, d] of DAYS.entries()) {
    await pool().query(
      `INSERT INTO plan_usage_daily (day, counted_at, plan, agents, active_users, storage_bytes, storage, ai_usd, ai)
       VALUES ($1, $2, 'starter', 3, $3, 12025908428, '{"bytes":12025908428,"areas":{"files":6300000000,"documents":3400000000,"helpdesk":2325908428},"notCounted":{"exports":800000000}}', 13.1, '{"desk":7.85,"ask":2.4,"write":1.95,"mcp":0.6}')
       ON CONFLICT (day) DO NOTHING`,
      [d, `${d}T23:59:00.000Z`, 200 + i]
    );
  }
});

after(async () => {
  setPlanForTests(null);
  report.setUsageReportDepsForTests(null);
  await pool().query("DELETE FROM plan_usage_daily WHERE day >= '2032-01-01' AND day < '2033-01-01'");
  await fixtureQuery("DELETE FROM users WHERE username = $1", [`report-${process.pid}`]);
  await pool().end();
});

describe("the endpoint", () => {
  test("the licence URL with its last segment replaced by usage, unless COMPASSDOCS_USAGE_URL says otherwise", () => {
    assert.equal(usageReportUrl()?.toString(), "https://console.example/api/cloud/usage");
    const env = { ...process.env, COMPASSDOCS_USAGE_URL: "https://console.example/v2/usage" };
    assert.equal(usageReportUrl(env)?.toString(), "https://console.example/v2/usage");
    assert.deepEqual(usageReportProblems(env), []);
  });

  test("a licence URL with a trailing slash (or a query) still gives …/usage (review)", () => {
    const base = process.env.COMPASSDOCS_LICENSE_URL!.replace(/\/+$/, "");
    assert.equal(usageReportUrl({ ...process.env, COMPASSDOCS_LICENSE_URL: `${base}/` })?.toString(), "https://console.example/api/cloud/usage");
    assert.equal(usageReportUrl({ ...process.env, COMPASSDOCS_LICENSE_URL: `${base}//?v=2` })?.toString(), "https://console.example/api/cloud/usage");
  });

  test("never another origin (the credential would go there), never plain http", () => {
    const other = { ...process.env, COMPASSDOCS_USAGE_URL: "https://elsewhere.example/usage" };
    assert.match(usageReportProblems(other)[0], /must be on the license endpoint's origin/);
    assert.equal(usageReportUrl(other), null);
    assert.match(usageReportProblems({ ...process.env, COMPASSDOCS_USAGE_URL: "http://console.example/usage" })[0], /https/);
    assert.match(usageReportProblems({ COMPASSDOCS_CLOUD: "1", COMPASSDOCS_USAGE_URL: "https://console.example/usage" })[0], /without COMPASSDOCS_LICENSE_URL/);
    assert.deepEqual(usageReportProblems({ COMPASSDOCS_USAGE_URL: "https://elsewhere.example/usage" }), [], "self-hosted: never read");
  });
});

describe("the body: counts only", () => {
  const row = {
    day: "2032-05-20",
    counted_at: "2032-05-20T23:59:00.000Z",
    plan: "starter",
    agents: 3,
    active_users: 204,
    storage_bytes: 12025908428,
    storage: { bytes: 12025908428, areas: { files: 6300000000, documents: 3400000000, helpdesk: 2325908428 }, notCounted: { exports: 800000000 } },
    ai_usd: 13.1,
    ai: { desk: 7.85, ask: 2.4, write: 1.95, mcp: 0.6 },
  };

  test("exactly the documented fields, numbers where the contract says numbers", () => {
    const b = report.buildReport(row, { workspace: "ws_report_test", licenseId: "lic_report", mismatch: null });
    assert.deepEqual(Object.keys(b).sort(), ["activeUsers", "agents", "aiUsd", "appVersion", "countedAt", "day", "licenseId", "licenseMismatch", "plan", "schema", "storage", "storageBytes", "workspace"]);
    assert.deepEqual(b.aiUsd, { total: 13.1, desk: 7.85, ask: 2.4, write: 1.95, mcp: 0.6 });
    assert.deepEqual(b.storage, { files: 6300000000, documents: 3400000000, helpdesk: 2325908428 });
    assert.equal(b.schema, 1);
    assert.equal(b.day, "2032-05-20");
    assert.equal(b.countedAt, "2032-05-20T23:59:00.000Z");
    assert.equal(b.licenseMismatch, null);
    assert.deepEqual(report.buildReport(row, { workspace: "ws_report_test", licenseId: null, mismatch: "ws_7f3a9c" }).licenseMismatch, { licenseWorkspace: "ws_7f3a9c" });
  });

  test("no personal data: every string is an id, a date, a plan name or the version", () => {
    const b = report.buildReport(row, { workspace: "ws_report_test", licenseId: "lic_report", mismatch: null });
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") strings.push(v);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(b);
    for (const s of strings) assert.match(s, /^(ws_[a-z_0-9]+|lic_[a-z_0-9]+|starter|\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?|\d+\.\d+\.\d+)$/, s);
    assert.equal(report.idempotencyKey(b), "usage:ws_report_test:2032-05-20");
  });
});

describe("sendUsageReport: the request and every answer", () => {
  const url = new URL("https://console.example/api/cloud/usage");
  const body = report.buildReport(
    { day: "2032-05-20", counted_at: "2032-05-20T23:59:00Z", plan: "starter", agents: 3, active_users: 204, storage_bytes: 1, storage: { bytes: 1, areas: { files: 1, documents: 0, helpdesk: 0 }, notCounted: { exports: 0 } }, ai_usd: 0, ai: { desk: 0, ask: 0, write: 0, mcp: 0 } },
    { workspace: "ws_report_test", licenseId: "lic_report", mismatch: null }
  );
  const once = (res: Response | (() => Promise<Response>)) =>
    report.sendUsageReport(url, "tok", body, { fetchImpl: (async () => (typeof res === "function" ? res() : res)) as typeof fetch, timeoutMs: 300, now: 0 });

  test("POST, the bearer credential, JSON, the idempotency key and the workspace", async () => {
    let h: Headers | null = null;
    let m = "";
    let redirect = "";
    await report.sendUsageReport(url, "tok", body, {
      fetchImpl: (async (_u: URL, init: RequestInit) => {
        h = new Headers(init.headers as Record<string, string>);
        m = init.method!;
        redirect = String(init.redirect);
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
    });
    assert.equal(m, "POST");
    assert.equal(redirect, "manual", "a redirect is never followed");
    assert.equal(h!.get("authorization"), "Bearer tok");
    assert.equal(h!.get("content-type"), "application/json");
    assert.equal(h!.get("idempotency-key"), "usage:ws_report_test:2032-05-20");
    assert.equal(h!.get("x-compassdocs-workspace"), "ws_report_test");
  });

  test("2xx stored; 401/403 unauthorized; 404 missing; 400/409/413/422 refused with the console's reason", async () => {
    assert.deepEqual(await once(new Response(null, { status: 200 })), { kind: "stored", status: 200 });
    assert.deepEqual(await once(new Response(null, { status: 201 })), { kind: "stored", status: 201 });
    assert.deepEqual(await once(new Response(null, { status: 403 })), { kind: "unauthorized", status: 403 });
    assert.deepEqual(await once(new Response(null, { status: 404 })), { kind: "missing", status: 404 });
    const refused = await once(new Response(JSON.stringify({ error: "workspace does not match the credential" }), { status: 409 }));
    assert.equal(refused.kind, "refused");
    assert.match((refused as { message: string }).message, /409.*workspace does not match the credential/);
    assert.equal((await once(new Response("{}", { status: 422 }))).kind, "refused");
  });

  test("429 and 5xx are unreachable, with Retry-After bounded to a minute … six hours", async () => {
    const r = await once(new Response(null, { status: 429, headers: { "retry-after": "5" } }));
    assert.deepEqual(r, { kind: "unreachable", message: "The console answered 429.", retryAfterMs: 60_000 });
    const r2 = await once(new Response(null, { status: 503, headers: { "retry-after": "90000" } }));
    assert.equal((r2 as { retryAfterMs: number }).retryAfterMs, 6 * 60 * 60_000);
    assert.equal((await once(new Response(null, { status: 500 }))).kind, "unreachable");
  });

  test("a redirect is an error; no answer in time is unreachable; a large answer is read no further", async () => {
    assert.equal((await once(new Response(null, { status: 307, headers: { location: "https://elsewhere.example/" } }))).kind, "error");
    const slow = await report.sendUsageReport(url, "tok", body, {
      timeoutMs: 100,
      fetchImpl: ((_u: URL, init: RequestInit) =>
        new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))))) as unknown as typeof fetch,
    });
    assert.equal(slow.kind, "unreachable");
    assert.match((slow as { message: string }).message, /no answer within/);
    assert.deepEqual(await once(new Response("x".repeat(report.MAX_RESPONSE_BYTES * 4), { status: 200 })), { kind: "stored", status: 200 });
  });

  test("backoff: a minute doubling to an hour", () => {
    const mid = () => 0.5;
    assert.equal(report.reportDelayMs(1, mid), 60_000);
    assert.equal(report.reportDelayMs(2, mid), 120_000);
    assert.equal(report.reportDelayMs(4, mid), 480_000);
    assert.equal(report.reportDelayMs(10, mid), 3_600_000);
    assert.equal(report.reportDelayMs(3, mid, 90_000), 90_000, "the console's Retry-After wins");
  });
});

describe("reportPendingUsage: idempotent per workspace and day, retried with backoff", () => {
  test("every day not sent, oldest first; then nothing more until a day is counted again", async () => {
    seen.length = 0;
    answer = () => new Response(null, { status: 204 });
    report.resetUsageReportForTests();
    const r = await report.reportPendingUsage(STATE);
    assert.deepEqual(r.sent, DAYS);
    assert.deepEqual(seen.map((s) => s.body.day), DAYS);
    assert.ok(seen.every((s) => s.url === "https://console.example/api/cloud/usage" && s.method === "POST"));
    assert.deepEqual(seen.map((s) => s.headers["idempotency-key"]), DAYS.map((d) => `usage:ws_report_test:${d}`));
    const all = JSON.stringify(seen.map((s) => s.body));
    assert.ok(!all.includes(SECRET_NAME) && !all.includes(SECRET_EMAIL), "no names or emails, ever");
    seen.length = 0;
    assert.deepEqual((await report.reportPendingUsage(STATE)).sent, [], "the console has them: nothing resent");
    assert.equal(seen.length, 0);
    // Counted again: that day (only) goes again, under the same key, with the newer countedAt.
    await pool().query("UPDATE plan_usage_daily SET counted_at = '2032-05-21T00:05:00Z', active_users = 205 WHERE day = '2032-05-20'");
    assert.deepEqual((await report.reportPendingUsage(STATE)).sent, ["2032-05-20"]);
    assert.equal(seen[0].body.countedAt, "2032-05-21T00:05:00.000Z");
    assert.equal(seen[0].body.activeUsers, 205);
  });

  test("a 503 stops the run, keeps the day pending and backs off; the retry sends it", async () => {
    await pool().query("UPDATE plan_usage_daily SET counted_at = '2032-05-21T06:00:00Z' WHERE day IN ('2032-05-19', '2032-05-20')");
    seen.length = 0;
    answer = () => new Response(null, { status: 503 });
    report.resetUsageReportForTests();
    const r = await report.reportPendingUsage(STATE);
    assert.deepEqual(r.sent, []);
    assert.equal(r.outcome?.kind, "unreachable");
    assert.equal(r.nextInMs, 60_000);
    assert.equal(seen.length, 1, "stopped at the first failure");
    const err = await pool().query("SELECT report_attempts, report_error FROM plan_usage_daily WHERE day = '2032-05-19'");
    assert.equal(err.rows[0].report_attempts, 1);
    assert.match(err.rows[0].report_error, /503/);
    // Inside the backoff: nothing is sent.
    seen.length = 0;
    clock += 30_000;
    assert.equal((await report.reportPendingUsage(STATE)).sent.length, 0);
    assert.equal(seen.length, 0, "waits out the backoff");
    // A second failure doubles it.
    clock += 31_000;
    const r2 = await report.reportPendingUsage(STATE);
    assert.equal(r2.nextInMs, 120_000);
    // The console answers again: both days go, oldest first.
    clock += 121_000;
    seen.length = 0;
    answer = () => new Response(null, { status: 200 });
    assert.deepEqual((await report.reportPendingUsage(STATE)).sent, ["2032-05-19", "2032-05-20"]);
  });

  test("a refused body is not resent until the day is counted again", async () => {
    await pool().query("UPDATE plan_usage_daily SET counted_at = '2032-05-21T12:00:00Z' WHERE day = '2032-05-20'");
    seen.length = 0;
    answer = () => new Response(JSON.stringify({ error: "plan does not match" }), { status: 422 });
    report.resetUsageReportForTests();
    const r = await report.reportPendingUsage(STATE);
    assert.equal(r.outcome?.kind, "refused");
    seen.length = 0;
    answer = () => new Response(null, { status: 204 });
    assert.deepEqual((await report.reportPendingUsage(STATE)).sent, [], "not this body again");
    assert.equal(seen.length, 0);
  });

  test("a day counted again while its refused body was on the way is still sent: the refusal marks only the body sent (review)", async () => {
    await pool().query("UPDATE plan_usage_daily SET counted_at = '2032-05-21T12:30:00Z', reported_counted_at = NULL WHERE day = '2032-05-20'");
    seen.length = 0;
    // The console refuses; meanwhile the day is counted again (another replica's 6-hourly count).
    answer = async () => {
      await pool().query("UPDATE plan_usage_daily SET counted_at = '2032-05-21T12:45:00Z' WHERE day = '2032-05-20'");
      return new Response(JSON.stringify({ error: "plan does not match" }), { status: 422 });
    };
    report.resetUsageReportForTests();
    assert.equal((await report.reportPendingUsage(STATE)).outcome?.kind, "refused");
    seen.length = 0;
    answer = () => new Response(null, { status: 204 });
    assert.deepEqual((await report.reportPendingUsage(STATE)).sent, ["2032-05-20"], "the newer count is a new body");
    assert.equal(seen[0].body.countedAt, "2032-05-21T12:45:00.000Z");
  });

  test("a 404 (no usage endpoint yet) waits six hours", async () => {
    await pool().query("UPDATE plan_usage_daily SET counted_at = '2032-05-21T13:00:00Z' WHERE day = '2032-05-20'");
    answer = () => new Response(null, { status: 404 });
    report.resetUsageReportForTests();
    const r = await report.reportPendingUsage(STATE);
    assert.equal(r.outcome?.kind, "missing");
    assert.equal(r.nextInMs, report.MISSING_RETRY_MS);
  });
});
