import { mkdir } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, login, api } from "./helpers";

// Claude drafts for categories, automations and recurring tickets (1.20.16),
// reviewed in Desk settings. Drafts are made the way Claude's tools save them
// (rows marked unpublished, or a proposal beside a live one), then a person:
//   - Automations: a new rule from Claude is off with "Draft from Claude" and
//     no Turn on; ?id= opens it with the draft strip; Save draft keeps it off;
//     Publish rule switches it on. Changes beside a running rule are
//     discarded, leaving it as it was.
//   - Recurring tickets: a new schedule is paused, the editor hides the on/off
//     switch and Open one now; Publish schedule switches it on. Changes beside
//     a live one are published.
//   - Categories: the strip above the list; a name edited, a change taken
//     out, Save draft; Publish changes (confirmed for a rename) puts them on
//     the list.
// Licensed rig only. Everything it makes carries its stamp and is removed.
//
// E2E_SHOTS=<dir> saves each review state at 1440 light and dark, and 390.

const slow = expect.configure({ timeout: 60_000 });
const SHOTS = process.env.E2E_SHOTS ?? "";
const DB = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e";

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/settings")).status !== 402;
}

async function shots(page: Page, name: string) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.screenshot({ path: `${SHOTS}/${name}-1440-light.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/${name}-1440-dark.png` });
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await page.emulateMedia({ colorScheme: "light" });
}

async function small(page: Page, url: string, name: string, ready: (p: Page) => Promise<void>) {
  if (!SHOTS) return;
  const ctx = await page.context().browser()!.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, baseURL: test.info().project.use.baseURL });
  const p = await ctx.newPage();
  await login(p, ADMIN);
  await p.goto(url);
  await ready(p);
  expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await p.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await p.screenshot({ path: `${SHOTS}/${name}-390-light.png` });
  await ctx.close();
}

test("claude drafts: the licence gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  test.skip(await licensed(page), "the helpdesk is licensed here");
  expect((await api(page, "/api/helpdesk/admin/categories/draft")).status).toBe(402);
});

test.describe("claude drafts in desk settings (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  const stamp = Date.now().toString(36);
  const WORD = `zz${stamp}`;
  const teamName = `E2E Drafts ${stamp}`;
  let teamId = 0;
  let db: Client;
  const ASKED = "Priya Shah";

  test.beforeAll(async () => {
    db = new Client({ connectionString: DB });
    await db.connect();
  });

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    if (!teamId) {
      const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: teamName, icon: "monitor", members: [] } });
      expect(team.status, JSON.stringify(team.body)).toBe(201);
      teamId = team.body.team.id;
    }
  });

  test.afterAll(async ({ browser }) => {
    await db.query("DELETE FROM hd_automations WHERE name LIKE $1", [`%${stamp}%`]);
    await db.query("DELETE FROM hd_recurring WHERE subject LIKE $1", [`%${stamp}%`]);
    await db.query("DELETE FROM hd_category_draft WHERE changes::text LIKE $1", [`%${stamp}%`]);
    await db.query("DELETE FROM hd_categories WHERE name LIKE $1", [`%${stamp}%`]);
    await db.end();
    const page = await browser.newPage();
    await login(page, ADMIN);
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await page.close();
  });

  test("automations: a draft rule is off until published; changes beside a running rule are discarded", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const draftName = `Printer tickets to ${teamName}`;
    const liveName = `Toner requests ${stamp}`;
    // As hd_draft_automation saves them: a new rule off and unpublished, and changes beside a running one.
    const d = await db.query(
      `INSERT INTO hd_automations (name, event, conditions, actions, active, position, published, draft_by_name, draft_at, draft_via)
       VALUES ($1, 'ticket_created', $2, $3, 0, 9990, 0, $4, now() - interval '3 minutes', 'mcp') RETURNING id`,
      [draftName, JSON.stringify({ keywords: [WORD, "printer"] }), JSON.stringify({ team_id: teamId, priority: "high", tags_add: ["printer"] }), ASKED]
    );
    const draftId = d.rows[0].id as number;
    const live = await api(page, "/api/helpdesk/admin/automations", {
      method: "POST",
      body: { name: liveName, event: "ticket_created", conditions: { keywords: [WORD, "toner"] }, actions: { tags_add: ["toner"] }, active: 1 },
    });
    expect(live.status, JSON.stringify(live.body)).toBe(201);
    const liveId = live.body.automation.id as number;
    await db.query("UPDATE hd_automations SET draft = $2, draft_by_name = $3, draft_at = now() - interval '1 minute', draft_via = 'claude_desk' WHERE id = $1", [
      liveId,
      JSON.stringify({ name: liveName, event: "ticket_created", conditions: { keywords: [WORD, "toner"] }, actions: { tags_add: ["toner"], team_id: teamId } }),
      ASKED,
    ]);

    await page.goto("/desk/settings/automations");
    await slow(page.getByRole("heading", { level: 1, name: "Automations" })).toBeVisible({ timeout: 60_000 });
    const draftRow = page.getByRole("listitem").filter({ hasText: draftName });
    await slow(draftRow.getByText("Draft from Claude", { exact: true })).toBeVisible();
    await expect(draftRow.getByText("Off", { exact: true })).toBeVisible();
    await expect(draftRow.getByRole("button", { name: /^Turn on/ })).toHaveCount(0);
    const liveRow = page.getByRole("listitem").filter({ hasText: liveName });
    await expect(liveRow.getByText("Changes from Claude", { exact: true })).toBeVisible();
    await draftRow.scrollIntoViewIfNeeded();
    await shots(page, "automations-list-drafts");

    // ?id= opens the draft for review.
    await page.goto(`/desk/settings/automations?id=${draftId}`);
    const dialog = page.getByRole("dialog");
    const strip = dialog.getByRole("region", { name: "Draft from Claude" });
    await slow(strip).toBeVisible({ timeout: 60_000 });
    await expect(strip).toContainText(`asked by ${ASKED}`);
    await expect(strip).toContainText("not published");
    await expect(strip).toContainText("Publishing switches it on");
    await expect(dialog.getByRole("heading", { name: `Draft ${draftName}` })).toBeVisible();
    await shots(page, "automations-draft-review");
    await small(page, `/desk/settings/automations?id=${draftId}`, "automations-draft-review", async (p) => {
      await slow(p.getByRole("dialog").getByRole("region", { name: "Draft from Claude" })).toBeVisible({ timeout: 60_000 });
    });
    // Save draft keeps it off; then Publish rule switches it on.
    await dialog.getByRole("button", { name: "Save draft" }).click();
    await slow(page.getByText("Draft saved. It stays off.")).toBeVisible();
    expect((await db.query("SELECT active, published FROM hd_automations WHERE id = $1", [draftId])).rows[0]).toEqual({ active: 0, published: 0 });
    await draftRow.getByRole("button", { name: /^Review/ }).click();
    await slow(dialog.getByRole("button", { name: "Publish rule" })).toBeVisible();
    await dialog.getByRole("button", { name: "Publish rule" }).click();
    await slow(page.getByText("Rule published and switched on.")).toBeVisible();
    await expect(draftRow.getByText("Draft from Claude", { exact: true })).toHaveCount(0);
    await expect(draftRow.getByRole("button", { name: /^Turn off/ })).toBeVisible();
    expect((await db.query("SELECT active, published FROM hd_automations WHERE id = $1", [draftId])).rows[0]).toEqual({ active: 1, published: 1 });

    // Changes beside the running rule: reviewed, then discarded.
    await liveRow.getByRole("button", { name: `Edit ${liveName}` }).click();
    const changes = dialog.getByRole("region", { name: "Changes from Claude" });
    await slow(changes).toBeVisible();
    await expect(changes).toContainText("keeps running as it is");
    await shots(page, "automations-changes-review");
    await dialog.getByRole("button", { name: "Discard changes" }).click();
    await slow(page.getByText("Changes discarded. The rule runs as it did.")).toBeVisible();
    await expect(liveRow.getByText("Changes from Claude", { exact: true })).toHaveCount(0);
    const after = (await db.query("SELECT actions, draft FROM hd_automations WHERE id = $1", [liveId])).rows[0];
    expect(after).toEqual({ actions: { tags_add: ["toner"] }, draft: null });
  });

  test("recurring tickets: a draft schedule is paused until published; changes are published", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const base = { team_id: teamId, body: "Check toner on every floor and order what is low.", priority: "normal", pattern: { kind: "monthly", mode: "nth_weekday", nth: 1, weekday: 1, months: [], time: "09:00" }, timezone: "Europe/London", enabled: false };
    const a = await api(page, "/api/helpdesk/admin/recurring", { method: "POST", body: { ...base, subject: `Toner check {{month}} ${stamp}`, due_business_days: 2 } });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const draftId = a.body.schedule.id as number;
    // As hd_draft_recurring saves a new one: paused, unpublished.
    await db.query("UPDATE hd_recurring SET published = 0, enabled = 0, next_run_at = NULL, draft_by_name = $2, draft_at = now() - interval '2 minutes', draft_via = 'mcp' WHERE id = $1", [draftId, ASKED]);
    const b = await api(page, "/api/helpdesk/admin/recurring", { method: "POST", body: { ...base, subject: `Fire alarm test ${stamp}`, enabled: true } });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const liveId = b.body.schedule.id as number;
    const { team_id, body, priority, pattern, timezone } = base;
    await db.query("UPDATE hd_recurring SET draft = $2, draft_by_name = $3, draft_at = now() - interval '1 minute', draft_via = 'claude_desk' WHERE id = $1", [
      liveId,
      JSON.stringify({ team_id, subject: `Fire alarm test, every floor ${stamp}`, body, priority: "high", request_type_id: null, assign_mode: "team_rules", assignee_id: null, due_business_days: 1, pattern, holiday_rule: "next_working_day", timezone }),
      ASKED,
    ]);
    void priority;

    await page.goto(`/desk/settings/recurring?id=${draftId}`);
    await slow(page.getByRole("heading", { level: 2, name: "Recurring tickets" })).toBeVisible({ timeout: 60_000 });
    const row = page.getByRole("row").filter({ hasText: `Toner check ${stamp}` });
    await slow(row.getByText("Draft from Claude", { exact: true })).toBeVisible();
    const editor = page.locator("#recurring-editor");
    const strip = editor.getByRole("region", { name: "Draft from Claude" });
    await slow(strip).toBeVisible();
    await expect(strip).toContainText("opens no ticket until you publish it");
    await expect(editor.getByRole("button", { name: "Open one now" })).toHaveCount(0);
    await expect(editor.getByText("Schedule is on")).toHaveCount(0);
    await shots(page, "recurring-draft-review");
    await small(page, `/desk/settings/recurring?id=${draftId}`, "recurring-draft-review", async (p) => {
      await slow(p.locator("#recurring-editor").getByRole("region", { name: "Draft from Claude" })).toBeVisible({ timeout: 60_000 });
      await p.locator("#recurring-editor").scrollIntoViewIfNeeded();
    });
    expect((await api(page, `/api/helpdesk/admin/recurring/${draftId}/run`, { method: "POST", body: {} })).status, "a draft opens nothing").toBe(409);
    await editor.getByRole("button", { name: "Publish schedule" }).click();
    await slow(page.getByText("Schedule published and switched on.")).toBeVisible();
    const pub = (await db.query("SELECT enabled, published, next_run_at FROM hd_recurring WHERE id = $1", [draftId])).rows[0];
    expect(pub.enabled).toBe(1);
    expect(pub.published).toBe(1);
    expect(pub.next_run_at).not.toBeNull();

    await page.goto(`/desk/settings/recurring?id=${liveId}`);
    const changes = page.locator("#recurring-editor").getByRole("region", { name: "Changes from Claude" });
    await slow(changes).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#recurring-editor").getByRole("textbox", { name: "Subject" })).toHaveValue(`Fire alarm test, every floor ${stamp}`);
    await shots(page, "recurring-changes-review");
    await page.locator("#recurring-editor").getByRole("button", { name: "Publish changes" }).click();
    await slow(page.getByText("Changes published. The schedule runs with them now.")).toBeVisible();
    const live = (await db.query("SELECT subject, priority, enabled, draft FROM hd_recurring WHERE id = $1", [liveId])).rows[0];
    expect(live).toEqual({ subject: `Fire alarm test, every floor ${stamp}`, priority: "high", enabled: 1, draft: null });
  });

  test("categories: the changes wait above the list; edited, saved, then published", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const waiting = await db.query("SELECT 1 FROM hd_category_draft WHERE id = 1");
    test.skip((waiting.rowCount ?? 0) > 0, "another category draft is waiting on this rig");
    const hw = await api(page, "/api/helpdesk/admin/categories", { method: "POST", body: { name: `Hardware ${stamp}` } });
    expect(hw.status, JSON.stringify(hw.body)).toBe(201);
    const sub = await api(page, "/api/helpdesk/admin/categories", { method: "POST", body: { name: "Laptop", parent_id: hw.body.category.id } });
    const changes = [
      { kind: "add_category", name: `Printers ${stamp}`, subcategories: ["Toner", "Paper jam"] },
      { kind: "add_subcategory", category_id: hw.body.category.id, category: `Hardware ${stamp}`, name: "Dock" },
      { kind: "rename", id: sub.body.category.id, parent: `Hardware ${stamp}`, from: "Laptop", to: "Notebook" },
    ];
    await db.query("INSERT INTO hd_category_draft (id, changes, draft_by_name, draft_at, draft_via) VALUES (1, $1, $2, now() - interval '4 minutes', 'mcp')", [JSON.stringify(changes), ASKED]);

    await page.goto(`/desk/settings/categories?id=${hw.body.category.id}`);
    await slow(page.getByRole("heading", { level: 2, name: "Categories" })).toBeVisible({ timeout: 60_000 });
    const strip = page.getByRole("region", { name: "Changes from Claude" });
    await slow(strip).toBeVisible();
    await expect(strip).toContainText(`asked by ${ASKED}`);
    await expect(strip.getByTestId("hd-category-draft-change")).toHaveCount(3);
    const row = page.getByTestId("hd-category-row").filter({ hasText: `Hardware ${stamp}` });
    await expect(row.getByText("Changes from Claude").first()).toBeVisible();
    await strip.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await shots(page, "categories-draft-review");
    await small(page, "/desk/settings/categories", "categories-draft-review", async (p) => {
      await slow(p.getByRole("region", { name: "Changes from Claude" })).toBeVisible({ timeout: 60_000 });
    });
    // Not offered on tickets while it is a draft.
    const picks = await api(page, "/api/helpdesk/categories");
    expect(JSON.stringify(picks.body)).not.toContain(`Printers ${stamp}`);

    // Edit a name, take one change out, save the draft.
    await strip.getByRole("textbox", { name: "Rename Hardware " + stamp + " › Laptop to: name" }).fill("Notebook PC");
    await strip.getByRole("button", { name: `Take out: Add the sub-category "Dock" to Hardware ${stamp}` }).click();
    await strip.getByRole("button", { name: "Save draft" }).click();
    await slow(page.getByText("Draft saved. The list is unchanged.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Changes from Claude" }).getByTestId("hd-category-draft-change")).toHaveCount(2);
    // Publish (a rename: confirmed).
    await page.getByRole("region", { name: "Changes from Claude" }).getByRole("button", { name: "Publish changes" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Publish changes" }).click();
    await slow(page.getByText("Changes published. Agents can pick them now.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Changes from Claude" })).toHaveCount(0);
    await expect(page.getByTestId("hd-category-row").filter({ hasText: `Printers ${stamp}` })).toBeVisible();
    await expect(page.getByTestId("hd-subcategory-row").filter({ hasText: "Notebook PC" })).toBeVisible();
    expect((await db.query("SELECT 1 FROM hd_category_draft")).rowCount).toBe(0);
  });
});
