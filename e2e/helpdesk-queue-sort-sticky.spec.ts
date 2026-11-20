import { test, expect, type Browser, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, api, ensureUser, login } from "./helpers";

// The queue's sort is the agent's (1.20.36, lib/helpdesk/queue-sort-shared,
// STYLEGUIDE §Helpdesk: the desk "The queue's Sort is the agent's"):
//   - picked once in the list header (Newest first), it holds in another
//     view, after a reload (the server paints it: the page's HTML already
//     says Newest first) and after signing out and in, and the list's order
//     matches it each time; a refused save puts the last sort back with a
//     toast;
//   - two windows of one browser: a change in the queue reaches a window on
//     Settings → Notifications (not on the queue) at once, and the queue
//     there opens in it; a change on that card reaches the queue window;
//   - a ?sort=due link shows Due first (and keeps it while a ticket opens
//     beside the list) without changing the saved choice; a view picked in
//     the rail goes back to the agent's sort;
//   - the Parked view keeps soonest to wake first: the control is shown off
//     with its reason, and the list's order ignores the agent's sort;
//   - Settings → Notifications shows the choice and resets it to the default.
//
// The agent is a team member with the Agent role and nothing else, so other
// specs' tickets never reach their queue. Due dates, ages and wake times are
// set in the database relative to now (as other specs move time), so the
// rig's older data never matters. Licensed rig only; the spec removes its
// tickets, team and the agent's desk role and preference.

const AGENT = { username: "e2e_hd_sort_agent", password: "E2eSortAgent!12345" };
const stamp = `${Date.now()}`;
const DB = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e";

let teamId = 0;
let agentId = 0;
let db: Client;
/** This spec's tickets by name. */
const T: Record<string, number> = {};

async function asAdmin(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await login(page, ADMIN);
  return page;
}

const sortButton = (page: Page) => page.locator("section[aria-labelledby=queue-title]").getByRole("button", { name: /^Sort: / });

/** This spec's tickets in the order the list shows them. */
async function order(page: Page): Promise<string[]> {
  const byNumber = new Map(Object.entries(T).map(([k, n]) => [n, k]));
  const numbers = await page.locator("section[aria-labelledby=queue-title] li[data-number]:not([data-leaving])").evaluateAll((lis) => lis.map((li) => Number((li as HTMLElement).dataset.number)));
  return numbers.filter((n) => byNumber.has(n)).map((n) => byNumber.get(n)!);
}

async function expectOrder(page: Page, names: string[]) {
  await expect.poll(() => order(page), { timeout: 15_000 }).toEqual(names);
}

async function openList(page: Page, url: string, listLabel: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url);
  await expect(page.locator(`ul[aria-label='${listLabel}'] li`).first()).toBeVisible({ timeout: 60_000 });
}

async function savedSort(page: Page): Promise<unknown> {
  const r = await api(page, "/api/helpdesk/me/notification-prefs");
  expect(r.status).toBe(200);
  return r.body.prefs.queue_sort;
}

test.describe("the queue's sort is the agent's (licensed)", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const admin = await asAdmin(browser);
    if ((await api(admin, "/api/helpdesk/counts")).status !== 200) {
      await admin.close();
      return;
    }
    await ensureUser(admin, AGENT, "viewer", "Sami Sorter");
    const users = (await api(admin, "/api/users/mentionable")).body.users as { id: number; username: string }[];
    agentId = users.find((u) => u.username === AGENT.username)!.id;
    const t = await api(admin, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `E2E Sort IT ${stamp}`, icon: "monitor", position: 9910 } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    teamId = t.body.team.id;
    let add = await api(admin, "/api/helpdesk/admin/agents", { method: "POST", body: { user_id: agentId, role: "agent", team_ids: [teamId] } });
    if (add.status !== 201) {
      await api(admin, `/api/helpdesk/admin/agents/${agentId}`, { method: "DELETE" });
      add = await api(admin, "/api/helpdesk/admin/agents", { method: "POST", body: { user_id: agentId, role: "agent", team_ids: [teamId] } });
    }
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    // Five tickets: A, B, C open; P2 then P1 to park (P1 is the newer one but wakes later).
    for (const [key, subject] of [
      ["A", "Printer on the second floor jams"],
      ["B", "VPN drops on the train"],
      ["C", "New starter needs a laptop"],
      ["P2", "Projector for the June offsite"],
      ["P1", "Stage lights for the autumn launch"],
    ] as const) {
      const r = await api(admin, "/api/helpdesk/tickets", { method: "POST", body: { subject: `${subject} ${stamp}`, body: "Raised at the desk.", team_id: teamId } });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      T[key] = r.body.ticket.number;
    }
    await admin.close();
    db = new Client({ connectionString: DB });
    await db.connect();
    // Ages and dues relative to now: Due first is A, C, B; Newest first is C, B, A.
    const set = (key: string, ageMin: number, dueMin: number) =>
      db.query(
        `UPDATE hd_tickets SET created_at = now() - make_interval(mins => $2), updated_at = now() - make_interval(mins => $2),
           first_replied_at = now(), first_reply_due = NULL, resolve_due = now() + make_interval(mins => $3), sla_paused_at = NULL
         WHERE number = $1`,
        [T[key], ageMin, dueMin]
      );
    await set("A", 30, 60);
    await set("B", 20, 300);
    await set("C", 10, 180);
    await set("P2", 50, 60);
    await set("P1", 40, 60);
    // Parked: P2 wakes in 10 days, P1 in 20, so soonest to wake is P2, P1 and newest first would be P1, P2.
    await db.query("UPDATE hd_tickets SET status = 'on_hold', parked_until = now() + interval '20 days' WHERE number = $1", [T.P1]);
    await db.query("UPDATE hd_tickets SET status = 'on_hold', parked_until = now() + interval '10 days' WHERE number = $1", [T.P2]);
  });

  test.afterAll(async ({ browser }) => {
    await db?.end().catch(() => {});
    if (!teamId) return;
    const admin = await asAdmin(browser);
    for (const n of Object.values(T)) await api(admin, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
    if (agentId) await api(admin, `/api/helpdesk/admin/agents/${agentId}`, { method: "DELETE" });
    await api(admin, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await admin.close();
    const c = new Client({ connectionString: DB });
    await c.connect();
    await c.query("UPDATE hd_notify_prefs SET prefs = prefs - 'queue_sort' WHERE user_id = $1", [agentId]).catch(() => {});
    await c.end();
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!teamId, "helpdesk is not licensed in this build");
    await login(page, AGENT);
  });

  test("Newest first, picked once, holds in another view, after a reload and after signing out and in", async ({ page, browser }) => {
    // Everyone starts on the existing default.
    expect((await api(page, "/api/helpdesk/me/notification-prefs", { method: "PUT", body: { queue_sort: null } })).status).toBe(200);
    await openList(page, "/desk?view=open", "All open tickets");
    await expect(sortButton(page)).toHaveAttribute("aria-label", "Sort: Due first");
    await expectOrder(page, ["A", "C", "B"]);

    // Pick Newest first: shown at once, saved, and the address stays as it was.
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/me/notification-prefs") && r.request().method() === "PUT");
    await sortButton(page).click();
    await page.getByRole("menuitemradio", { name: "Newest first" }).click();
    expect((await saved).status()).toBe(200);
    await expect(sortButton(page)).toHaveAttribute("aria-label", "Sort: Newest first");
    await expectOrder(page, ["C", "B", "A"]);
    expect(new URL(page.url()).searchParams.get("sort")).toBeNull();
    expect(await savedSort(page)).toBe("created");

    // Another view and back.
    const rail = page.locator('nav[aria-label="Ticket views"]');
    await rail.getByRole("link", { name: /^Unassigned/ }).click();
    await expect(page).toHaveURL(/view=unassigned/);
    await expect(sortButton(page)).toHaveAttribute("aria-label", "Sort: Newest first");
    await expectOrder(page, ["C", "B", "A"]);
    await rail.getByRole("link", { name: /^All open/ }).click();
    await expect(page).toHaveURL(/view=open/);
    await expect(sortButton(page)).toHaveAttribute("aria-label", "Sort: Newest first");
    await expectOrder(page, ["C", "B", "A"]);

    // A reload: the server paints it (the HTML already says so; nothing re-sorts as the list loads).
    const html = await (await page.request.get("/desk?view=open")).text();
    expect(html).toContain('aria-label="Sort: Newest first"');
    expect(html).not.toContain('aria-label="Sort: Due first"');
    await page.reload();
    await expect(sortButton(page)).toHaveAttribute("aria-label", "Sort: Newest first");
    await expectOrder(page, ["C", "B", "A"]);

    // Signed out and in again (a new session), and in a second window.
    expect(await page.evaluate(async () => (await fetch("/api/auth/logout", { method: "POST" })).status)).toBe(200);
    await login(page, AGENT);
    await openList(page, "/desk?view=open", "All open tickets");
    await expect(sortButton(page)).toHaveAttribute("aria-label", "Sort: Newest first");
    await expectOrder(page, ["C", "B", "A"]);
    const other = await browser.newPage();
    try {
      await login(other, AGENT);
      await openList(other, "/desk/tickets/" + T.B + "?view=open", "All open tickets");
      await expect(sortButton(other)).toHaveAttribute("aria-label", "Sort: Newest first");
      await expectOrder(other, ["C", "B", "A"]);
    } finally {
      await other.close();
    }
  });

  test("a refused save puts the last sort back with a toast", async ({ page }) => {
    await openList(page, "/desk?view=open", "All open tickets");
    await expect(sortButton(page)).toHaveAttribute("aria-label", "Sort: Newest first");
    await page.route("**/api/helpdesk/me/notification-prefs", (route) =>
      route.request().method() === "PUT" ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "The desk is busy." }) }) : route.continue()
    );
    await sortButton(page).click();
    await page.getByRole("menuitemradio", { name: "Priority first" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "The desk is busy. Your sort is back to Newest first." })).toBeVisible();
    await expect(sortButton(page)).toHaveAttribute("aria-label", "Sort: Newest first");
    await expectOrder(page, ["C", "B", "A"]);
    await page.unroute("**/api/helpdesk/me/notification-prefs");
    expect(await savedSort(page)).toBe("created");
  });

  test("two windows: a change in one reaches the other, on the queue or not", async ({ page }) => {
    await openList(page, "/desk?view=open", "All open tickets");
    await expect(sortButton(page)).toHaveAttribute("aria-label", "Sort: Newest first");
    // The second window is on Settings → Notifications: no queue there.
    const other = await page.context().newPage();
    try {
      await other.setViewportSize({ width: 1440, height: 900 });
      await other.goto("/desk/settings/notifications");
      const group = other.getByRole("radiogroup", { name: "Sort tickets" });
      await expect(group.getByRole("radio", { name: "Newest first" })).toHaveAttribute("aria-checked", "true");
      // Changed in the queue window: the card in the other window follows without a reload.
      const saved = page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/me/notification-prefs") && r.request().method() === "PUT");
      await sortButton(page).click();
      await page.getByRole("menuitemradio", { name: "Priority first" }).click();
      expect((await saved).status()).toBe(200);
      await expect(group.getByRole("radio", { name: "Priority first" })).toHaveAttribute("aria-checked", "true");
      // Opening the queue there: already in it.
      await other.goto("/desk?view=open");
      await expect(sortButton(other)).toHaveAttribute("aria-label", "Sort: Priority first");
      // And back the other way: a change on the card in one window reaches the queue in the other.
      await page.goto("/desk/settings/notifications");
      const savedBack = page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/me/notification-prefs") && r.request().method() === "PUT");
      await page.getByRole("radiogroup", { name: "Sort tickets" }).getByRole("radio", { name: "Newest first" }).click();
      expect((await savedBack).status()).toBe(200);
      await expect(sortButton(other)).toHaveAttribute("aria-label", "Sort: Newest first");
      await expectOrder(other, ["C", "B", "A"]);
    } finally {
      await other.close();
    }
    expect(await savedSort(page)).toBe("created");
  });

  test("a ?sort=due link shows Due first without changing the saved choice", async ({ page }) => {
    await openList(page, "/desk?view=open&sort=due", "All open tickets");
    await expect(sortButton(page)).toHaveAttribute("aria-label", "Sort: Due first");
    await expectOrder(page, ["A", "C", "B"]);
    // Opening a ticket beside the list keeps the link's sort.
    await page.locator(`li[data-number="${T.C}"] a[data-row]`).click();
    await expect(page).toHaveURL(new RegExp(`/desk/tickets/${T.C}\\?view=open&sort=due$`));
    await expect(sortButton(page)).toHaveAttribute("aria-label", "Sort: Due first");
    await expectOrder(page, ["A", "C", "B"]);
    expect(await savedSort(page)).toBe("created");
    // A view picked in the rail is the agent's own list again.
    await page.locator('nav[aria-label="Ticket views"]').getByRole("link", { name: /^Unassigned/ }).click();
    await expect(page).toHaveURL(/view=unassigned$/);
    await expect(sortButton(page)).toHaveAttribute("aria-label", "Sort: Newest first");
    await expectOrder(page, ["C", "B", "A"]);
    expect(await savedSort(page)).toBe("created");
  });

  test("the Parked view keeps soonest to wake first, with the control off and saying why", async ({ page }) => {
    for (const url of ["/desk?view=parked", "/desk?view=parked&sort=created"]) {
      await openList(page, url, "Parked tickets");
      const off = page.locator("section[aria-labelledby=queue-title]").getByRole("button", { name: "Sort: Soonest to wake" });
      await expect(off).toBeDisabled();
      const why = page.getByRole("note", { name: "Parked tickets are always listed soonest to wake first." });
      await expect(why).toHaveAttribute("data-tt", "Parked tickets are always listed soonest to wake first.");
      await expect(why).toHaveAttribute("tabindex", "0");
      await expectOrder(page, ["P2", "P1"]);
    }
    expect(await savedSort(page)).toBe("created");
    // Leaving Parked, the agent's sort is back.
    await page.locator('nav[aria-label="Ticket views"]').getByRole("link", { name: /^All open/ }).click();
    await expect(sortButton(page)).toHaveAttribute("aria-label", "Sort: Newest first");
    await expectOrder(page, ["C", "B", "A"]);
  });

  test("Settings → Notifications shows the choice and resets it to the default", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/desk/settings/notifications");
    const group = page.getByRole("radiogroup", { name: "Sort tickets" });
    await expect(group.getByRole("radio", { name: "Newest first" })).toHaveAttribute("aria-checked", "true");
    const reset = page.getByRole("button", { name: "Reset to default" });
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/me/notification-prefs") && r.request().method() === "PUT");
    await reset.click();
    expect((await saved).status()).toBe(200);
    await expect(group.getByRole("radio", { name: "Due first" })).toHaveAttribute("aria-checked", "true");
    await expect(reset).toHaveCount(0);
    expect(await savedSort(page)).toBeNull();
    await openList(page, "/desk?view=open", "All open tickets");
    await expect(sortButton(page)).toHaveAttribute("aria-label", "Sort: Due first");
    await expectOrder(page, ["A", "C", "B"]);
  });
});
