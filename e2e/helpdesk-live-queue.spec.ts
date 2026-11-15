import { test, expect, type Browser, type Page } from "@playwright/test";
import { ADMIN, api, ensureUser, login } from "./helpers";

// Live queue updates (1.20.19, STYLEGUIDE §Live updates and motion). With
// the queue open, a ticket created through the API in the agent's team
// appears within a few seconds wearing the highlight, and the Unassigned
// and All open counts go up by one; solving it takes it out and the counts
// come back down. A ticket in a team the agent can't see changes nothing.
// A list scrolled down keeps its place and shows the "1 new ticket" pill.
// Reduced motion still updates (no animation, the highlight still shows).
//
// The agent is a team member with the Agent role and nothing else, so
// other specs' tickets never reach their queue. Licensed rig only; the spec
// removes its tickets, teams and the agent's desk role.

const AGENT = { username: "e2e_hd_live_agent", password: "E2eLiveAgent!12345" };
const stamp = `${Date.now()}`;
/** Seconds a live change may take to show (the server folds changes for 250 ms; the reload is one request). */
const N = 5_000;

const FILLER = [
  "Second floor printer jams on duplex",
  "VPN drops every hour on the train",
  "New starter needs a laptop on Monday",
  "Shared mailbox for Payroll is missing",
  "Teams camera is black in Atlas room",
  "Password reset for the HR portal",
  "Monitor flickers on the hot desk by the window",
  "Excel add-in crashes on startup",
];

let teamA = 0;
let teamB = 0;
let agentId = 0;
const made: number[] = [];

async function asAdmin(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await login(page, ADMIN);
  return page;
}

const count = (page: Page, label: string) => page.locator('nav[aria-label="Ticket views"] a', { hasText: label }).locator("[data-live-count]");
const row = (page: Page, n: number) => page.locator(`li[data-number="${n}"]:not([data-leaving])`);
const listBox = (page: Page) => page.locator("section[aria-labelledby=queue-title] div.overflow-y-auto");

async function openQueue(page: Page, size = { width: 1440, height: 900 }) {
  await page.setViewportSize(size);
  const stream = page.waitForResponse((r) => r.url().includes("/api/helpdesk/live"), { timeout: 120_000 });
  await page.goto("/desk?view=open&sort=created");
  await expect(page.locator("ul[aria-label='All open tickets'] li").first()).toBeVisible({ timeout: 120_000 });
  expect((await stream).status()).toBe(200);
  await expect(count(page, "All open")).toBeVisible();
  // Let the counts and the stream's hello settle.
  await page.waitForTimeout(1_500);
}

async function create(page: Page, team: number, subject: string): Promise<number> {
  const r = await api(page, "/api/helpdesk/tickets", { method: "POST", body: { subject, body: "Reported at the service desk.", team_id: team } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  made.push(r.body.ticket.number);
  return r.body.ticket.number;
}

const num = async (page: Page, label: string) => Number(await count(page, label).textContent());

test.describe("live queue (licensed)", () => {
  test.describe.configure({ mode: "serial", timeout: 300_000 });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const admin = await asAdmin(browser);
    if ((await api(admin, "/api/helpdesk/counts")).status !== 200) {
      await admin.close();
      return;
    }
    await ensureUser(admin, AGENT, "viewer", "Lena Live");
    const users = (await api(admin, "/api/users/mentionable")).body.users as { id: number; username: string }[];
    agentId = users.find((u) => u.username === AGENT.username)!.id;
    const a = await api(admin, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `E2E Live IT ${stamp}`, icon: "monitor", position: 9900 } });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    teamA = a.body.team.id;
    const b = await api(admin, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `E2E Live Facilities ${stamp}`, icon: "building", position: 9901 } });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    teamB = b.body.team.id;
    let add = await api(admin, "/api/helpdesk/admin/agents", { method: "POST", body: { user_id: agentId, role: "agent", team_ids: [teamA] } });
    if (add.status !== 201) {
      await api(admin, `/api/helpdesk/admin/agents/${agentId}`, { method: "DELETE" });
      add = await api(admin, "/api/helpdesk/admin/agents", { method: "POST", body: { user_id: agentId, role: "agent", team_ids: [teamA] } });
    }
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    await admin.close();
    // The agent raises the filler tickets (the API allows 10 new tickets a minute a person).
    const agent = await browser.newPage();
    await login(agent, AGENT);
    for (const s of FILLER) await create(agent, teamA, `${s} ${stamp}`);
    await agent.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!teamA) return;
    const admin = await asAdmin(browser);
    for (const n of made) await api(admin, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
    if (agentId) await api(admin, `/api/helpdesk/admin/agents/${agentId}`, { method: "DELETE" });
    await api(admin, `/api/helpdesk/admin/teams/${teamA}`, { method: "DELETE" });
    await api(admin, `/api/helpdesk/admin/teams/${teamB}`, { method: "DELETE" });
    await admin.close();
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!teamA, "helpdesk is not licensed in this build");
    await login(page, AGENT);
  });

  test("a new ticket slides in highlighted and the counts go up; solved, it leaves and they go down", async ({ page, browser }) => {
    await openQueue(page);
    const un = await num(page, "Unassigned");
    const all = await num(page, "All open");
    const admin = await asAdmin(browser);
    try {
      const t0 = Date.now();
      const n = await create(admin, teamA, `Badge reader at the loading dock is offline ${stamp}`);
      // At the top of the list (newest first), wearing the highlight.
      await expect(page.locator(`li[data-number="${n}"].hd-live-new`)).toBeVisible({ timeout: N });
      const took = Date.now() - t0;
      expect(took).toBeLessThan(N);
      await expect(page.locator("ul[aria-label='All open tickets'] > li:not([data-leaving])").first()).toHaveAttribute("data-number", String(n));
      await expect(count(page, "Unassigned")).toHaveText(String(un + 1), { timeout: N });
      await expect(count(page, "All open")).toHaveText(String(all + 1), { timeout: N });
      // The team's count on the rail follows too.
      const teamCount = page.locator('nav[aria-label="Ticket views"] a', { hasText: `E2E Live IT ${stamp}` }).locator("[data-live-count]");
      await expect(teamCount).toHaveText(String(FILLER.length + 1), { timeout: N });
      // The highlight fades and goes.
      await expect(row(page, n)).not.toHaveClass(/hd-live-new/, { timeout: 4_000 });
      test.info().annotations.push({ type: "latency", description: `appeared after ${took} ms` });

      const solved = await api(admin, `/api/helpdesk/tickets/${n}`, { method: "PATCH", body: { status: "solved" } });
      expect(solved.status, JSON.stringify(solved.body)).toBe(200);
      await expect(page.locator(`li[data-number="${n}"]`)).toHaveCount(0, { timeout: N });
      await expect(count(page, "Unassigned")).toHaveText(String(un), { timeout: N });
      await expect(count(page, "All open")).toHaveText(String(all), { timeout: N });
    } finally {
      await admin.close();
    }
  });

  test("a ticket in a team the agent can't see changes nothing", async ({ page, browser }) => {
    await openQueue(page);
    const un = await num(page, "Unassigned");
    const all = await num(page, "All open");
    const rows = await page.locator("ul[aria-label='All open tickets'] > li").count();
    const admin = await asAdmin(browser);
    try {
      const n = await create(admin, teamB, `Leaking tap in the third floor kitchen ${stamp}`);
      await page.waitForTimeout(4_000);
      await expect(page.locator(`li[data-number="${n}"]`)).toHaveCount(0);
      expect(await num(page, "Unassigned")).toBe(un);
      expect(await num(page, "All open")).toBe(all);
      expect(await page.locator("ul[aria-label='All open tickets'] > li").count()).toBe(rows);
      await expect(page.locator(`nav[aria-label="Ticket views"]`)).not.toContainText(`E2E Live Facilities ${stamp}`);
      // The stream is alive: a ticket in their own team still arrives.
      const mine = await create(admin, teamA, `Projector remote missing in Orion ${stamp}`);
      await expect(row(page, mine)).toBeVisible({ timeout: N });
    } finally {
      await admin.close();
    }
  });

  test("a list scrolled down keeps its place and shows the new tickets pill", async ({ page }) => {
    await openQueue(page, { width: 1440, height: 600 });
    const box = listBox(page);
    await box.evaluate((el) => (el.scrollTop = 120));
    await page.waitForTimeout(300);
    const before = await box.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      const li = [...el.querySelectorAll<HTMLElement>("li[data-number]")].find((l) => l.getBoundingClientRect().bottom > top + 1)!;
      return { n: li.dataset.number, y: Math.round(li.getBoundingClientRect().top) };
    });
    const n = await create(page, teamA, `Wi-Fi guest password expired ${stamp}`);
    const pill = page.getByTestId("queue-new-above");
    await expect(pill).toHaveText("1 new ticket", { timeout: N });
    await expect(page.locator(`li[data-number="${n}"]`)).toHaveCount(1);
    const after = await box.evaluate((el, n) => {
      const li = el.querySelector<HTMLElement>(`li[data-number="${n}"]`)!;
      return { y: Math.round(li.getBoundingClientRect().top), scrollTop: el.scrollTop };
    }, before.n);
    expect(Math.abs(after.y - before.y), "the first row in view did not move").toBeLessThanOrEqual(1);
    expect(after.scrollTop).toBeGreaterThan(120);
    // The pill takes the agent up to it, and goes.
    await pill.click();
    await expect.poll(() => box.evaluate((el) => el.scrollTop), { timeout: 3_000 }).toBeLessThanOrEqual(2);
    await expect(row(page, n)).toBeInViewport();
    await expect(pill).toHaveCount(0);
  });

  test("behind a proxy that refuses the stream, long polling still brings the ticket", async ({ page, browser }) => {
    // Every stream request (no ?wait=) fails as a buffering proxy's would; the long poll goes through.
    await page.route(/\/api\/helpdesk\/live(\?(?!.*wait=).*)?$/, (route) => route.fulfill({ status: 502, body: "Bad gateway" }));
    await page.setViewportSize({ width: 1440, height: 900 });
    const poll = page.waitForRequest((r) => r.url().includes("/api/helpdesk/live?wait="), { timeout: 120_000 });
    await page.goto("/desk?view=open&sort=created");
    await expect(page.locator("ul[aria-label='All open tickets'] li").first()).toBeVisible({ timeout: 120_000 });
    await poll;
    await page.waitForTimeout(1_000);
    const admin = await asAdmin(browser);
    try {
      const n = await create(admin, teamA, `Laptop fan is very loud ${stamp}`);
      await expect(row(page, n)).toBeVisible({ timeout: N });
    } finally {
      await admin.close();
    }
  });

  test("with reduced motion the list and counts still update, without animation", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    const admin = await asAdmin(browser);
    try {
      await login(page, AGENT);
      await openQueue(page);
      const all = await num(page, "All open");
      const n = await create(admin, teamA, `Docking station not charging ${stamp}`);
      const li = page.locator(`li[data-number="${n}"].hd-live-new`);
      await expect(li).toBeVisible({ timeout: N });
      // Nothing slides or grows: no animation on the row, and the highlight is a still background.
      expect(await li.evaluate((el) => el.getAnimations().length)).toBe(0);
      expect(await li.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
      await expect(count(page, "All open")).toHaveText(String(all + 1), { timeout: N });
      expect(await count(page, "All open").evaluate((el) => el.getAnimations().length)).toBe(0);
    } finally {
      await admin.close();
      await ctx.close();
    }
  });
});
