import { test, expect, type Page, type Route } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { ADMIN, EDITOR, ensureUser, login } from "./helpers";

// Settings → Plan & usage, the plan's banners and the AI spending choice
// (1.22.0, lib/plan; design A, B, D2, F).
//
// Self-hosted (the suite's own server): nothing new exists. The page and
// every API answer 404, the rail has no entry, the dashboard no banner.
//
// Cloud mode (a server started here on its own database, as
// cloud-mode.spec.ts does): with no plan in the license the section stays
// out of the rail and the page says so. No test can hold a license the
// vendor signed, so the page with a plan is checked against the APIs'
// answers stood in for (page.route), with the design's example workspace:
// Northwind on Starter, 3 of 3 agents, 204 of 250 active users, 11.2 of
// 25 GB and $13.10 of its $15 AI allowance. Then the tabs, the spending
// choice, the upgrade request, the banners (80%, past the buffer, the AI
// allowance, a license for another workspace) and their dismissal, in light
// and dark and at phone width.
//
// Screenshots (light and dark, deviceScaleFactor 1) when E2E_SHOTS_DIR is set.

const SHOTS = process.env.E2E_SHOTS_DIR || "";
const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "scripts", "start.cjs");
const SERVER_JS = path.join(ROOT, ".next", "standalone", "server.js");
// Its own port: support-access.spec.ts has 3987 (each cloud-mode spec spawns its own server).
const PORT = 3988;
const BASE = `http://localhost:${PORT}`;
const SECRET_KEY = randomBytes(32).toString("hex");
const DB_NAME = "compass_e2e_plan_usage";

async function shoot(page: Page, name: string, fullPage = true): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // The app shell scrolls inside <main>, so a whole page is a viewport as tall as its content.
  const vp = page.viewportSize();
  if (fullPage && vp) {
    const tall = await page.evaluate(() => (document.querySelector("main")?.scrollHeight ?? 0) + 8);
    if (tall > vp.height) await page.setViewportSize({ width: vp.width, height: tall });
  }
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
  if (vp) await page.setViewportSize(vp);
}

// --- The design's example, as GET /api/admin/plan answers it ---------------------------------

function months(): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

function trend(values: (number | null)[]) {
  const m = months();
  return m.map((month, i) => ({ month, value: values[i], partial: i === m.length - 1 }));
}

const MONTH = months()[5];

function northwind(over: Record<string, unknown> = {}) {
  return {
    workspace: { name: "Northwind Traders", id: "ws_2c91e4", address: "northwind.compassdocs.io" },
    plan: {
      name: "starter",
      label: "Starter",
      agentsIncluded: 3,
      agentsMax: 10,
      activeUsersLimit: 250,
      storageGb: 25,
      aiAllowanceUsd: 15,
      bufferPct: 20,
      renewsAt: "2027-03-14",
      billingContact: null,
      priceUsd: 199,
      billing: "annual",
      next: "shared",
    },
    countedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    month: MONTH,
    nextMonthStart: "1 Dec",
    meters: {
      agents: { key: "agents", value: 3, limit: 10, cap: 12, state: "normal", trend: trend([3, 3, 3, 3, 3, 3]) },
      users: { key: "users", value: 204, limit: 250, cap: 300, state: "warn", trend: trend([150, 162, 171, 180, 196, 204]) },
      storage: { key: "storage", value: 11.2, limit: 25, cap: 30, state: "normal", trend: trend([8.1, 8.8, 9.4, 10, 10.7, 11.2]) },
      ai: { key: "ai", value: 13.1, limit: 15, cap: 18, state: "warn", trend: trend([6.2, 8.4, 9.9, 11.3, 12.4, 13.1]) },
    },
    agents: { used: 3, included: 3, max: 10, holdAt: 12, extra: 0 },
    users: { byKind: { Agents: 3, Admins: 2, Approvers: 6, Editors: 31, Viewers: 151, Requesters: 11 } },
    storage: {
      bytes: 11_200_000_000,
      limitBytes: 25_000_000_000,
      areas: { files: 5_900_000_000, documents: 3_400_000_000, helpdesk: 1_900_000_000 },
      notCounted: { exports: 800_000_000 },
      steps: 0,
    },
    ai: {
      spentUsd: 13.1,
      allowanceUsd: 15,
      beyondUsd: 0,
      billedUsd: 0,
      spending: "keep",
      capUsd: null,
      paused: false,
      byFeature: { desk: 7.85, ask: 2.4, write: 1.95, mcp: 0.6 },
      details: { deskTurns: 412, askAnswers: 1208 },
      lastMonthUsd: 12.4,
      paceUsd: 14.6,
    },
    billingContact: "",
    billingContactSource: "default",
    licenseContact: null,
    mismatch: null,
    spending: { spending: "keep", capUsd: null },
    ...over,
  };
}

const PEOPLE = [
  { name: "Priya Shah", countedAs: "Viewer", detail: "", lastAt: new Date().toISOString() },
  { name: "Marcus Bell", countedAs: "Agent", detail: "Editor in CompassDocs", lastAt: new Date().toISOString() },
  { name: "Chris Morales", countedAs: "Requester", detail: "Customer portal", lastAt: new Date(Date.now() - 3 * 86_400_000).toISOString() },
  { name: "Lena Fischer", countedAs: "Editor", detail: "", lastAt: new Date(Date.now() - 8 * 86_400_000).toISOString() },
  { name: "Omar Haddad", countedAs: "Viewer", detail: "", lastAt: new Date(Date.now() - 25 * 86_400_000).toISOString() },
];

/** Stand in for the Plan & usage APIs; returns what was sent to them. */
async function standIn(page: Page, overview: Record<string, unknown> = northwind(), notices: Record<string, unknown> | null = null) {
  const sent: { url: string; method: string; body: unknown }[] = [];
  const record = (route: Route) => sent.push({ url: route.request().url(), method: route.request().method(), body: route.request().postDataJSON?.() ?? null });
  await page.route("**/api/admin/plan", (route) => (route.request().method() === "GET" ? route.fulfill({ json: overview }) : route.fallback()));
  await page.route("**/api/admin/plan/people**", (route) => route.fulfill({ json: { month: MONTH, count: 204, by_kind: (overview as ReturnType<typeof northwind>).users.byKind, people: PEOPLE, shown: PEOPLE.length, limit: 500 } }));
  await page.route("**/api/admin/plan/settings", async (route) => {
    record(route);
    const b = route.request().postDataJSON() as { billing_contact?: string };
    const contact = b.billing_contact === undefined || b.billing_contact === "all_admins" ? { email: "", source: "admins", licenseContact: null } : { email: b.billing_contact, source: b.billing_contact ? "here" : "default", licenseContact: null };
    await route.fulfill({ json: { spending: { spending: "cap", capUsd: 40 }, billing_contact: contact } });
  });
  await page.route("**/api/admin/plan/upgrade", async (route) => {
    record(route);
    await route.fulfill({ json: { sent: true, to: "sales@compassdocs.io", plan: "Shared" } });
  });
  await page.route("**/api/plan/notices", async (route) => {
    if (route.request().method() === "POST") {
      record(route);
      return route.fulfill({ json: { ok: true } });
    }
    return notices ? route.fulfill({ json: notices }) : route.fulfill({ status: 404, json: { error: "No plan", code: "no_plan" } });
  });
  return sent;
}

// --- Self-hosted: unchanged ----------------------------------------------------------------

test.describe("self-hosted: no Plan & usage", () => {
  test("the page and its APIs answer 404, the rail has no entry and the dashboard no banner", async ({ page }) => {
    await login(page, ADMIN);
    const res = await page.goto("/admin/plan");
    expect(res?.status()).toBe(404);
    for (const url of ["/api/admin/plan", "/api/admin/plan/people", "/api/plan/notices"]) {
      expect((await page.request.get(url)).status(), url).toBe(404);
    }
    await page.goto("/admin/license");
    await expect(page.getByRole("link", { name: "License" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Plan & usage" })).toHaveCount(0);
    await page.goto("/");
    await expect(page.getByTestId("plan-banner")).toHaveCount(0);
  });
});

// --- Cloud mode ----------------------------------------------------------------------------

function dbUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is not set");
  const u = new URL(base);
  u.pathname = `/${DB_NAME}`;
  return u.toString();
}

async function resetDb(): Promise<void> {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await admin.end();
  }
}

interface Server {
  proc: ChildProcess;
  out: string[];
  exited: Promise<number | null>;
}

function start(): Server {
  const out: string[] = [];
  const proc = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(PORT),
      COMPASSDOCS_SERVER_JS: SERVER_JS,
      COMPASSDOCS_CLOUD: "1",
      COMPASSDOCS_SECRET_KEY: SECRET_KEY,
      COMPASSDOCS_BASE_URL: BASE,
      COMPASSDOCS_WORKSPACE_ID: "ws_2c91e4",
      DATABASE_URL: dbUrl(),
      COMPASSDOCS_ADMIN_USER: ADMIN.username,
      COMPASSDOCS_ADMIN_PASSWORD: ADMIN.password,
      COMPASSDOCS_UPLOAD_DIR: mkdtempSync(path.join(tmpdir(), "plan-usage-e2e-uploads-")),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let partial = "";
  const collect = (chunk: Buffer) => {
    partial += chunk.toString();
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    out.push(...lines.filter((l) => l.trim()));
  };
  proc.stdout!.on("data", collect);
  proc.stderr!.on("data", collect);
  const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));
  return { proc, out, exited };
}

async function waitReady(server: Server): Promise<void> {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    if (server.proc.exitCode !== null) throw new Error(`server exited ${server.proc.exitCode}:\n${server.out.join("\n")}`);
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/readyz`)).ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`never ready:\n${server.out.join("\n")}`);
}

test.describe.serial("cloud mode: Plan & usage", () => {
  test.skip(!existsSync(SERVER_JS), "needs the standalone build (npm run build)");
  test.use({ baseURL: BASE, deviceScaleFactor: 1, viewport: { width: 1280, height: 900 } });

  let server: Server;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    await resetDb();
    server = start();
    await waitReady(server);
  });

  test.afterAll(async () => {
    if (server && server.proc.exitCode === null) {
      server.proc.kill("SIGTERM");
      await server.exited;
    }
  });

  test("without a plan in the license: no rail entry, the APIs answer 404, the page says so", async ({ page }) => {
    await login(page, ADMIN);
    expect((await page.request.get("/api/admin/plan")).status()).toBe(404);
    expect((await page.request.get("/api/plan/notices")).status()).toBe(404);
    await page.goto("/admin/license");
    await expect(page.getByRole("link", { name: "Plan & usage" })).toHaveCount(0);
    await page.goto("/admin/plan");
    await expect(page.getByRole("heading", { level: 1, name: "Plan & usage" })).toBeVisible();
    await expect(page.getByText("No CompassDocs Cloud plan")).toBeVisible();
    await page.goto("/");
    await expect(page.getByTestId("plan-banner")).toHaveCount(0);
  });

  test("Overview: the plan and the four meters, each with its state in words and the real numbers", async ({ page }) => {
    await login(page, ADMIN);
    await standIn(page);
    await page.goto("/admin/plan");
    await expect(page.getByRole("heading", { level: 3, name: "Starter" })).toBeVisible();
    await expect(page.getByText("Billed annually")).toBeVisible();
    await expect(page.getByText("14 Mar 2027")).toBeVisible();
    await expect(page.getByText("northwind.compassdocs.io")).toBeVisible();
    // The one primary action on Starter.
    await expect(page.getByRole("button", { name: "Upgrade to Shared" })).toBeVisible();

    await expect(page.getByTestId("agents-chip")).toHaveText("All 3 included in use");
    await expect(page.getByTestId("users-chip")).toHaveText("82% of plan");
    await expect(page.getByTestId("storage-chip")).toHaveText("Within plan");
    await expect(page.getByTestId("ai-chip")).toHaveText("87% used");

    const users = page.getByRole("meter", { name: "Active users this month" });
    await expect(users).toHaveAttribute("aria-valuemax", "250");
    await expect(users).toHaveAttribute("aria-valuenow", "204");
    await expect(users).toHaveAttribute("aria-valuetext", "204 of 250");
    await expect(page.getByRole("meter", { name: "AI this month, at cost" })).toHaveAttribute("aria-valuetext", "$13.10 of $15.00");
    await expect(page.locator('[data-plan-meter="users"]')).toContainText("Buffer to 300.");
    await expect(page.locator('[data-plan-meter="ai"]')).toContainText("On pace for about $14.60");
    // The trend's numbers, for a screen reader.
    await expect(page.locator('[data-plan-meter="users"] table caption')).toHaveText("Active users, last six months");
    await expect(page.locator('[data-plan-meter="users"] tbody tr').last()).toContainText("204 people (so far)");
    await shoot(page, "plan-overview");

    // Phone width: no sideways scroll.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByTestId("users-chip")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await shoot(page, "plan-overview-390");
  });

  test("the four states of a meter: over within the buffer is amber with words; past the buffer says so", async ({ page }) => {
    await login(page, ADMIN);
    const base = northwind();
    await standIn(
      page,
      northwind({
        meters: {
          ...base.meters,
          agents: { ...base.meters.agents, value: 12, state: "past" },
          users: { ...base.meters.users, value: 271, state: "over" },
          storage: { ...base.meters.storage, value: 31, state: "over" },
          ai: { ...base.meters.ai, value: 17.4, state: "over" },
        },
        agents: { used: 12, included: 3, max: 10, holdAt: 12, extra: 9 },
        storage: { ...base.storage, bytes: 31_000_000_000, steps: 1 },
        ai: { ...base.ai, spentUsd: 17.4, beyondUsd: 2.4, billedUsd: 3.12 },
      })
    );
    await page.goto("/admin/plan");
    await expect(page.getByTestId("agents-chip")).toHaveText("At 12 · Starter's limit, new agents held");
    await expect(page.getByTestId("users-chip")).toHaveText("Over by 21 · in buffer");
    await expect(page.getByTestId("storage-chip")).toHaveText("1 extra 50 GB · $25/mo");
    await expect(page.getByTestId("ai-chip")).toHaveText("$2.40 beyond · billed $3.12");
    await expect(page.getByRole("meter", { name: "Active users this month" })).toHaveAttribute("aria-valuetext", "271 of 250, over by 21");
    // Past the limit the fill is amber (the usage meter's rule).
    const fill = page.locator('[data-plan-meter="users"] [role="meter"] > div').last();
    expect(await fill.evaluate((el) => el.className)).toContain("bg-amber-500");
    await shoot(page, "plan-overview-over");
  });

  test("the tabs: who counted (with its CSV), storage by area, AI by feature", async ({ page }) => {
    await login(page, ADMIN);
    await standIn(page);
    await page.goto("/admin/plan/people");
    await expect(page.getByRole("heading", { name: `Who counted in` })).toBeVisible();
    await expect(page.getByText("Requesters 11")).toBeVisible();
    // The count, the chips and the list come from one answer.
    await expect(page.getByText(/^204 people so far\./)).toBeVisible();
    await expect(page.getByRole("row", { name: /Chris Morales Requester Customer portal/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download CSV" })).toHaveAttribute("href", "/api/admin/plan/people?format=csv");
    await shoot(page, "plan-people");

    // (The tab row lists the pages the rail reaches; with the plan stood in on the API only, the page is opened by its address.)
    await page.goto("/admin/plan/storage");
    await expect(page.getByRole("heading", { name: "What's using storage" })).toBeVisible();
    await expect(page.getByText("Text, version history and the Trash")).toBeVisible();
    await expect(page.getByText(/Not counted:.*\(0\.8 GB\)/)).toBeVisible();
    await shoot(page, "plan-storage");

    await page.goto("/admin/plan/ai");
    await expect(page.getByRole("heading", { name: /AI by feature in/ })).toBeVisible();
    await expect(page.getByText("Claude in the desk", { exact: true })).toBeVisible();
    await expect(page.getByText("412 answers", { exact: true })).toBeVisible();
    await expect(page.getByText("Ask Northwind Traders", { exact: true })).toBeVisible();
    await expect(page.getByText("Within allowance · nothing billed yet")).toBeVisible();
    await shoot(page, "plan-ai");
  });

  test("Monthly AI spending: keep AI on by default; a cap is saved and sent as chosen", async ({ page }) => {
    await login(page, ADMIN);
    const sent = await standIn(page);
    await page.goto("/admin/plan/ai#ai-spending");
    const group = page.getByRole("radiogroup", { name: "Monthly AI spending" });
    await expect(group.getByRole("radio", { name: "Keep AI on" })).toBeChecked();
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    await group.getByRole("radio", { name: "Cap at an amount" }).check();
    await page.getByRole("textbox", { name: /Cap, a month/ }).fill("40");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("AI pauses at $40.00 a month.")).toBeVisible();
    expect(sent.find((s) => s.url.endsWith("/api/admin/plan/settings"))?.body).toEqual({ ai_spending: "cap", ai_cap_usd: 40 });
  });

  test("Upgrade to Shared asks CompassDocs, with the plans compared", async ({ page }) => {
    await login(page, ADMIN);
    const sent = await standIn(page);
    await page.goto("/admin/plan");
    await page.getByRole("button", { name: "Upgrade to Shared" }).click();
    const dialog = page.getByRole("dialog", { name: "Move to Shared?" });
    await expect(dialog).toContainText("Now: Starter");
    await expect(dialog).toContainText("$449/mo");
    await dialog.getByRole("textbox", { name: "Reply to" }).fill("alex.rivera@northwind.example");
    await dialog.getByRole("textbox", { name: /Anything we should know/ }).fill("About 600 staff from January.");
    await shoot(page, "plan-upgrade", false);
    await dialog.getByRole("button", { name: "Ask to move to Shared" }).click();
    await expect(page.getByText(/Sent to CompassDocs\. We'll reply to alex\.rivera@northwind\.example/)).toBeVisible();
    expect(sent.find((s) => s.url.endsWith("/api/admin/plan/upgrade"))?.body).toEqual({ target: "shared", reply_to: "alex.rivera@northwind.example", note: "About 600 staff from January." });
  });

  test("banners: one for every meter at a threshold, admins only, dismissed per admin", async ({ page, browser }) => {
    const notices = {
      plan: "starter",
      mismatch: null,
      notices: [
        {
          month: MONTH,
          meter: "users",
          threshold: "past",
          tone: "warn",
          lead: "Northwind has outgrown Starter: 312 active users this month, past the 300 buffer.",
          rest: "Nobody is locked out and nothing is turned off. Shared includes 1,000 active users a month.",
          short: { lead: "Past Starter's active users and its buffer this month.", rest: "Nobody is locked out." },
        },
        {
          month: MONTH,
          meter: "ai",
          threshold: "limit",
          tone: "info",
          lead: "Northwind has used its $15 AI allowance for November.",
          rest: "AI keeps working; the rest of the month is billed at cost +30% (so far $0.40 beyond, billed as $0.52).",
          short: { lead: "This month's AI allowance is used.", rest: "AI keeps working, billed at cost +30%." },
        },
      ],
    };
    await login(page, ADMIN);
    const sent = await standIn(page, northwind(), notices);
    await page.goto("/");
    const banner = page.getByTestId("plan-banner");
    // The dashboard says it short (design B2); the settings pages in full.
    await expect(banner).toContainText("Past Starter's active users and its buffer this month. Nobody is locked out.");
    await expect(banner).not.toContainText("nothing is turned off");
    await expect(banner.getByRole("note", { name: "Plan usage" })).toHaveAttribute("data-plan-tone", "warn");
    await expect(banner.getByRole("link", { name: "Upgrade to Shared" })).toHaveAttribute("href", "/admin/plan#upgrade");
    await shoot(page, "plan-banner-dashboard", false);
    await page.goto("/admin/license");
    await expect(page.getByTestId("plan-banner")).toContainText("outgrown Starter");
    await expect(page.getByTestId("plan-banner")).toContainText("Nobody is locked out and nothing is turned off.");
    await shoot(page, "plan-banner-settings", false);
    // Not repeated on Plan & usage: its meters say it.
    await page.goto("/admin/plan");
    await expect(page.getByTestId("users-chip")).toBeVisible();
    await expect(page.getByTestId("plan-banner")).toHaveCount(0);
    // Dismiss: gone for this admin, with both thresholds sent.
    await page.goto("/");
    await page.getByTestId("plan-banner").getByRole("button", { name: /Dismiss/ }).click();
    await expect(page.getByTestId("plan-banner")).toHaveCount(0);
    expect(sent.find((s) => s.method === "POST" && s.url.endsWith("/api/plan/notices"))?.body).toEqual({
      dismiss: [
        { meter: "users", threshold: "past" },
        { meter: "ai", threshold: "limit" },
      ],
    });

    // 80% alone is a fact (notice-info), linking to the page.
    await page.unroute("**/api/plan/notices");
    await page.route("**/api/plan/notices", (route) =>
      route.fulfill({
        json: {
          plan: "starter",
          mismatch: null,
          notices: [
            {
              month: MONTH,
              meter: "users",
              threshold: "80",
              tone: "info",
              lead: "Northwind is at 82% of Starter's 250 active users this month",
              rest: "(204 people). Nothing changes if you go over; there's a 50-person buffer.",
              short: { lead: "82% of Starter's active users this month.", rest: "Nothing changes if you go over." },
            },
          ],
        },
      })
    );
    await page.goto("/");
    await expect(page.getByTestId("plan-banner")).toContainText("82% of Starter's active users this month. Nothing changes if you go over.");
    await expect(page.getByTestId("plan-banner").getByRole("note", { name: "Plan usage" })).toHaveAttribute("data-plan-tone", "info");
    await expect(page.getByTestId("plan-banner").getByRole("link", { name: "Open Plan & usage" })).toBeVisible();
    await shoot(page, "plan-banner-80", false);

    // Someone who isn't an admin never asks.
    const other = await browser.newPage({ baseURL: BASE });
    await ensureUser(page, EDITOR, "editor", "E2E Editor");
    await login(other, EDITOR);
    let asked = false;
    other.on("request", (r) => {
      if (r.url().includes("/api/plan/notices")) asked = true;
    });
    await other.goto("/");
    await expect(other.locator("h1")).toBeVisible();
    await other.waitForTimeout(500);
    expect(asked).toBe(false);
    await expect(other.getByTestId("plan-banner")).toHaveCount(0);
    await other.close();
  });

  test("a license for another workspace: said plainly on every settings page, one line on the dashboard", async ({ page }) => {
    await login(page, ADMIN);
    await standIn(page, northwind(), { plan: "starter", notices: [], mismatch: { licenseWorkspace: "ws_7f3a9c", workspaceId: "ws_2c91e4", runningOn: { plan: "starter", renewsAt: "2027-03-14" } } });
    await page.goto("/admin/license");
    const n = page.getByTestId("plan-mismatch");
    await expect(n).toContainText("This workspace's plan license is for a different workspace.");
    await expect(n).toContainText("ws_7f3a9c");
    await expect(n).toContainText("It runs on its last license that matched (Starter, renews 14 Mar 2027).");
    await expect(n.getByRole("button", { name: /Dismiss/ })).toHaveCount(0);
    await shoot(page, "plan-mismatch", false);
    await page.goto("/");
    await expect(page.getByTestId("plan-mismatch")).toContainText("See what to do");
  });

  test("a license for another workspace and none kept: the notice says it once; Plan & usage says what it waits for", async ({ page }) => {
    await login(page, ADMIN);
    const mismatch = { licenseWorkspace: "ws_7f3a9c", workspaceId: "ws_2c91e4", runningOn: null };
    await standIn(page, northwind(), { plan: null, notices: [], mismatch });
    await page.route("**/api/admin/plan", (route) => route.fulfill({ status: 404, json: { error: "This workspace has no CompassDocs Cloud plan.", code: "no_plan", mismatch } }));
    await page.goto("/admin/plan");
    const n = page.getByTestId("plan-mismatch");
    await expect(n).toContainText("There is no earlier license for this workspace to run on");
    expect((await n.innerText()).match(/until this is fixed/g)?.length, "said once").toBe(1);
    await expect(page.getByRole("heading", { name: "Waiting for this workspace's plan license" })).toBeVisible();
    await expect(page.getByText("No CompassDocs Cloud plan")).toHaveCount(0);
    await shoot(page, "plan-mismatch-empty", false);
  });

  test("the billing contact: the license's named as such; every admin can be chosen over it; the toast says who", async ({ page }) => {
    await login(page, ADMIN);
    const sent = await standIn(page, northwind({ billingContact: "billing@northwind.example", billingContactSource: "license", licenseContact: "billing@northwind.example" }));
    await page.goto("/admin/plan");
    await expect(page.getByTestId("billing-contact")).toHaveText("billing@northwind.example (from the license)");
    await page.locator("#billing-contact").getByRole("button", { name: "Change" }).click();
    const dialog = page.getByRole("dialog", { name: "Billing contact" });
    await expect(dialog.getByRole("radio", { name: "The license's contact" })).toBeChecked();
    await dialog.getByRole("radio", { name: "Every admin" }).check();
    await shoot(page, "plan-billing-contact", false);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Warning emails go to every admin.")).toBeVisible();
    expect(sent.find((s) => s.url.endsWith("/api/admin/plan/settings"))?.body).toEqual({ billing_contact: "all_admins" });
  });

  test("Dedicated: agents and AI by contract: no buffer, no price, no \"Stop at the allowance\"", async ({ page }) => {
    await login(page, ADMIN);
    const base = northwind();
    await standIn(
      page,
      northwind({
        plan: { ...base.plan, name: "dedicated", label: "Dedicated", agentsIncluded: 0, agentsMax: null, activeUsersLimit: null, aiAllowanceUsd: null, storageGb: 250, priceUsd: 2950, next: null },
        meters: { ...base.meters, agents: { ...base.meters.agents, value: 31, limit: null, cap: null, state: "normal" }, ai: { ...base.meters.ai, limit: null, cap: null, state: "normal" } },
        agents: { used: 31, included: 0, max: null, holdAt: null, extra: 0 },
        ai: { ...base.ai, allowanceUsd: null },
      })
    );
    await page.goto("/admin/plan");
    await expect(page.getByTestId("agents-chip")).toHaveText("31 agents · by contract");
    await expect(page.locator('[data-plan-meter="agents"]')).not.toContainText("$9.99");
    await expect(page.locator('[data-plan-meter="agents"] .plan-buffer')).toHaveCount(0);
    const fill = page.locator('[data-plan-meter="agents"] [role="meter"] > div').last();
    expect(await fill.evaluate((el) => el.className)).toContain("bg-compass-600");
    await page.goto("/admin/plan/ai#ai-spending");
    await expect(page.getByText("Dedicated's AI is by contract. You can cap it at a monthly amount.")).toBeVisible();
    await expect(page.getByRole("radio", { name: "Stop at the allowance" })).toHaveCount(0);
  });
});
