import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, api, ensureUser, login } from "./helpers";

// Desk settings, grouped, tabbed and searchable (1.20.13; the registry is
// lib/helpdesk/desk-settings-registry, the components are CompassDocs
// settings' own: SettingsRail, PageHeader, SubNav). As the admin: the
// overview lists the groups; the search finds a setting by a word that is
// not its name ("outlook" → Microsoft 365 mailboxes), Enter opens it, and the
// card is scrolled into view and flashed; arrows walk the results; a section
// with several pages shows them as tabs under one h1, and the tabs switch;
// the addresses that moved in 1.20.2 still land; nothing scrolls sideways
// on a phone. As an Agent (desk role "agent", no admin capability): only
// their own settings in the rail and in the search, and an admin page says
// no. Licensed rig only; the Agent's desk role and role assignment are
// removed afterwards.

const AGENT = { username: "e2e_hd_settings_agent", password: "E2eSetAgent!123" };
const HOME = "/desk/settings";

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/settings")).status !== 402;
}

test.describe("desk settings search and tabs (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  let db: Client;

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e" });
    await db.connect();
  });
  test.afterAll(async () => {
    await db.query("DELETE FROM role_assignments WHERE user_id = (SELECT id FROM users WHERE username = $1) AND role_id = (SELECT id FROM roles WHERE key = 'helpdesk-agent')", [AGENT.username]);
    await db.query("DELETE FROM hd_agent_roles WHERE user_id = (SELECT id FROM users WHERE username = $1)", [AGENT.username]);
    await db.end();
  });

  test("search finds a setting by another word and lands on it; tabs switch; old addresses land", async ({ page }) => {
    test.setTimeout(900_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");

    // The overview: one card per group, each section with its line.
    await page.goto(HOME);
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible({ timeout: 120_000 });
    const home = page.getByTestId("desk-settings-home");
    for (const g of ["General", "Teams and people", "Email", "Tickets", "Automation", "Requesters", "Integrations", "Security and data", "You"])
      await expect(home.getByRole("heading", { level: 2, name: g, exact: true })).toBeVisible();
    const rail = page.getByRole("navigation", { name: "Desk settings" });
    await expect(rail.getByRole("link", { name: /^Forms and fields/ })).toBeVisible();
    // The Duo check lives in CompassDocs settings; the admin can open it, so it is listed.
    await expect(rail.getByRole("link", { name: /^Sign-in and Duo/ })).toHaveAttribute("href", "/admin/sso#duo");

    // A synonym: "outlook" is nowhere in "Microsoft 365 mailboxes".
    const box = rail.getByLabel("Search settings");
    await box.fill("outlook");
    const hit = rail.getByRole("link", { name: /Microsoft 365 mailboxes.*Email/ });
    await expect(hit).toBeVisible();
    // Arrows: down into the results, up back to the box.
    await box.press("ArrowDown");
    await expect(rail.getByRole("link").first()).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(box).toBeFocused();
    // No result: the empty line.
    await box.fill("zzqx");
    await expect(rail.getByText("No settings match “zzqx”.")).toBeVisible();
    await box.fill("outlook");
    await expect(hit).toBeVisible();
    await expect(rail.getByRole("link").first()).toHaveAccessibleName(/Microsoft 365 mailboxes/);
    await box.press("Enter");
    await page.waitForURL((u) => u.pathname === "/desk/settings/email" && u.hash === "#microsoft-365", { timeout: 120_000 });
    await expect(box).toHaveValue("");
    const card = page.locator("#microsoft-365");
    await expect(card).toHaveAttribute("data-settings-flash", "", { timeout: 120_000 });
    await expect(card).toBeInViewport();
    await expect(rail.getByRole("link", { name: /^Email$/ })).toHaveAttribute("aria-current", "page");

    // MFA finds the Duo check in CompassDocs settings.
    await box.fill("MFA");
    await expect(rail.getByRole("link").first()).toHaveAccessibleName(/Sign-in and Duo/);
    await box.press("Escape");
    await expect(box).toHaveValue("");

    // A tabbed section: one h1 (the section), the tabs, the tab's own Create button.
    await page.goto("/desk/settings/request-types");
    await expect(page.getByRole("heading", { level: 1, name: "Forms and fields" })).toBeVisible({ timeout: 120_000 });
    await expect(page.locator("h1")).toHaveCount(1);
    const tabs = page.getByRole("navigation", { name: "Forms and fields settings" });
    await expect(tabs.getByRole("link", { name: "Request types" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: "New request type" })).toBeVisible({ timeout: 120_000 });
    await tabs.getByRole("link", { name: "Custom fields" }).click();
    await page.waitForURL((u) => u.pathname === "/desk/settings/custom-fields", { timeout: 120_000 });
    await expect(tabs.getByRole("link", { name: "Custom fields" })).toHaveAttribute("aria-current", "page");
    await expect(tabs.getByRole("link", { name: "Request types" })).not.toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 2, name: "Custom fields" })).toBeAttached({ timeout: 120_000 });
    await expect(page.locator("h1")).toHaveCount(1);
    // Nested tabs light one at a time (Office hours /calendars, Holidays /calendars/holidays).
    await page.goto("/desk/settings/calendars/holidays");
    const rt = page.getByRole("navigation", { name: "Reply targets settings" });
    await expect(rt.getByRole("link", { name: "Holidays" })).toHaveAttribute("aria-current", "page", { timeout: 120_000 });
    await expect(rt.getByRole("link", { name: "Office hours" })).not.toHaveAttribute("aria-current", "page");
    await expect(rail.getByRole("link", { name: /^Reply targets/ })).toHaveAttribute("aria-current", "page");

    // Search jumps to a tab of a section.
    await box.fill("canned");
    await box.press("Enter");
    await page.waitForURL((u) => u.pathname === "/desk/settings/canned", { timeout: 120_000 });
    await expect(page.getByRole("navigation", { name: "Macros and replies settings" }).getByRole("link", { name: "Canned responses" })).toHaveAttribute("aria-current", "page", { timeout: 120_000 });

    // The addresses that moved still land.
    for (const [old, to] of [
      ["/desk/settings/chat", "/desk/settings/integrations/chat"],
      ["/desk/settings/claude", "/desk/settings/integrations/claude-connector"],
    ]) {
      await page.goto(old);
      await page.waitForURL((u) => u.pathname === to, { timeout: 120_000 });
    }

    // A phone: the rail is the search box and "All settings"; nothing scrolls sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/desk/settings/custom-fields");
    await expect(rail.getByRole("link", { name: "All settings" })).toBeVisible({ timeout: 120_000 });
    await expect(rail.getByRole("link", { name: /^Forms and fields/ })).toHaveAttribute("aria-current", "page");
    await expect(rail.getByLabel("Search settings")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
    await rail.getByRole("link", { name: "All settings" }).click();
    await page.waitForURL((u) => u.pathname === HOME, { timeout: 120_000 });
    await expect(home).toBeVisible({ timeout: 120_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
  });

  test("an Agent sees only their own settings, in the rail and in the search", async ({ page, browser }) => {
    test.setTimeout(600_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build");
    await ensureUser(page, AGENT, "viewer", "Ines Agent");
    const id = (await db.query("SELECT id FROM users WHERE username = $1", [AGENT.username])).rows[0].id as number;
    await db.query(
      `INSERT INTO role_assignments (role_id, user_id, scope_type, space_id) SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = 'helpdesk-agent'
        AND NOT EXISTS (SELECT 1 FROM role_assignments a WHERE a.user_id = $1 AND a.role_id = r.id)`,
      [id]
    );
    await db.query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, 'agent') ON CONFLICT (user_id) DO UPDATE SET role = 'agent'", [id]);

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    try {
      await login(p, AGENT);
      await p.goto(HOME);
      await expect(p.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible({ timeout: 120_000 });
      const rail = p.getByRole("navigation", { name: "Desk settings" });
      // Their notifications, and their own macros and canned responses: nothing an admin sets up.
      await expect(rail.getByRole("link", { name: /^Notifications/ })).toBeVisible();
      await expect(rail.getByRole("link", { name: /^Macros and replies/ })).toBeVisible();
      await expect(rail.getByRole("link")).toHaveCount(2);
      const home = p.getByTestId("desk-settings-home");
      await expect(home.getByRole("heading", { level: 2 })).toHaveText(["Automation", "You"]);

      const box = rail.getByLabel("Search settings");
      for (const q of ["smtp", "duo", "request types", "webhook"]) {
        await box.fill(q);
        await expect(rail.getByText(`No settings match “${q}”.`), q).toBeVisible();
      }
      await box.fill("quiet");
      await box.press("Enter");
      await p.waitForURL((u) => u.pathname === "/desk/settings/notifications" && u.hash === "#quiet-hours", { timeout: 120_000 });
      await expect(p.locator("#quiet-hours")).toHaveAttribute("data-settings-flash", "", { timeout: 120_000 });

      // An admin page, opened by its address, says no.
      await p.goto("/desk/settings/email");
      await expect(p.getByText("Email is for helpdesk managers")).toBeVisible({ timeout: 120_000 });
    } finally {
      await ctx.close();
    }
  });
});
