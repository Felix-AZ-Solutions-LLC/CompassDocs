import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ADMIN, api, ensureUser, login } from "./helpers";

// Adding an agent on a CompassDocs Cloud plan (1.22.0, design C): the
// Agents page's plan meter, the price step past the included agents
// ("Adds an extra agent: $9.99/mo, prorated", a button that says the
// price, the add sent with confirm_extra), the note inside the buffer, and
// the hold at the buffer's end (the comparison, Upgrade to Shared, Add to
// desk aria-disabled with the reason). Light and dark.
//
// The plan is stood in on the agents API (page.route merges `plan` into the
// real answer), as helpdesk-agent-allowance.spec.ts does for the licence's
// numbers; the add itself is answered by the stand-in so the shared desk is
// left as it was. Unlicensed builds answer 402 behind the desk, so these
// skip themselves (the EE rig runs them). E2E_SHOTS=<dir> saves the
// screenshots at deviceScaleFactor 1.

const SHOTS = process.env.E2E_SHOTS ?? "";
const PICK = { username: "e2e_plan_pick", password: "E2ePlanPick!12345" };
const PICK_NAME = "Grace Planpick";
const AGENTS_API = /\/api\/helpdesk\/admin\/agents$/;

async function deskLicensed(page: Page): Promise<boolean> {
  const res = await api(page, "/api/helpdesk/admin/agents");
  if (res.status === 402) return false;
  expect(res.status, "the admin manages agents").toBe(200);
  return true;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

function plan(used: number) {
  return {
    name: "starter",
    label: "Starter",
    included: 3,
    max: 10,
    hold_at: 12,
    used,
    monthly_usd: 9.99,
    price_usd: 199,
    renews_at: "2027-03-14",
    billing: "annual",
    proration: { nowUsd: 35.14, days: 107, periodUsd: 119.88, until: "2027-03-14" },
    next: { name: "shared", label: "Shared", price_usd: 449, included: 5, max: 25 },
  };
}

/** The real agents list with the plan's numbers; POSTs recorded and answered 201. */
async function standIn(page: Page, used: number): Promise<unknown[]> {
  const posts: unknown[] = [];
  await page.unroute(AGENTS_API);
  await page.route(AGENTS_API, async (route) => {
    if (route.request().method() === "POST") {
      posts.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: { agent: null } });
    }
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, used, plan: plan(used) } });
  });
  return posts;
}

async function openAdd(page: Page) {
  await page.goto("/desk/settings/agents");
  await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
  await page.getByRole("button", { name: "Add agent" }).first().click();
  return page.getByRole("dialog");
}

async function pick(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Person" }).fill(PICK.username);
  await page.keyboard.press("Enter");
  await expect(dialog.getByText(PICK_NAME)).toBeVisible();
}

test.describe("adding an agent on a Cloud plan", () => {
  test.use({ deviceScaleFactor: 1, viewport: { width: 1280, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
  });

  test("the plan's meter replaces the licence's: included in Starter, no Buy more agents", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs it");
    await standIn(page, 3);
    await page.goto("/desk/settings/agents");
    const meter = page.getByTestId("plan-agents-meter");
    await expect(meter).toContainText("3 of 3 agents");
    await expect(meter).toContainText("included in Starter · $9.99/mo each beyond that · up to 10");
    await expect(page.getByRole("link", { name: /Buy more agents/ })).toHaveCount(0);
    await expect(meter.getByRole("meter", { name: "Helpdesk agents" })).toHaveAttribute("aria-valuemax", "10");
  });

  test("past the included agents: the price first, the button says it, the add confirms it", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs it");
    await ensureUser(page, PICK, "viewer", PICK_NAME);
    const posts = await standIn(page, 3);
    const dialog = await openAdd(page);
    await pick(page);
    const price = dialog.getByTestId("plan-price");
    await expect(price).toContainText("Adds an extra agent: $9.99/mo, prorated.");
    await expect(price).toContainText("All 3 agents included in Starter are in use. About $35.14 is charged now for the rest of your plan year (to 14 Mar 2027), then it renews with the plan.");
    const add = dialog.getByRole("button", { name: "Add to desk · $9.99/mo" });
    await expect(add).toBeEnabled();
    await shot(page, "plan-add-agent-price");
    await add.click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ role: "newbie", confirm_extra: true });
  });

  test("inside the buffer: the add still works, and says how many more fit", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs it");
    await ensureUser(page, PICK, "viewer", PICK_NAME);
    await standIn(page, 10);
    const dialog = await openAdd(page);
    await pick(page);
    await expect(dialog.getByTestId("plan-buffer")).toContainText("This is your 11th agent; Starter goes up to 10. You can add 2 more while we talk about Shared, which includes 5 agents and goes up to 25.");
    await expect(dialog.getByTestId("plan-price")).toContainText("With this one, 8 extra agents: $79.92 a month.");
    await expect(dialog.getByRole("button", { name: "Add to desk · $9.99/mo" })).toBeEnabled();
    await shot(page, "plan-add-agent-buffer");
  });

  test("at the buffer's end: new agents held, the comparison, Upgrade to Shared, Add to desk aria-disabled", async ({ page }) => {
    test.skip(!(await deskLicensed(page)), "helpdesk is not licensed in this build; the EE rig runs it");
    const posts = await standIn(page, 12);
    const dialog = await openAdd(page);
    const held = dialog.getByTestId("plan-held");
    await expect(held).toContainText("This workspace has 12 agents, Starter's limit with its buffer. Everyone on the desk keeps working. To add more, move to Shared (up to 25 agents), or take someone off the desk first.");
    await expect(dialog).toContainText("$199 + 9 × $9.99");
    await expect(dialog).toContainText("$288.91/mo");
    await expect(dialog).toContainText("$518.93/mo");
    await expect(dialog.getByRole("link", { name: "Upgrade to Shared" })).toHaveAttribute("href", "/admin/plan#upgrade");
    const add = dialog.getByRole("button", { name: "Add to desk" });
    await expect(add).toHaveAttribute("aria-disabled", "true");
    await expect(add).toHaveAttribute("aria-describedby", "plan-held-reason");
    await shot(page, "plan-add-agent-held");
    await add.click({ force: true });
    expect(posts.length, "nothing is sent while held").toBe(0);
  });
});
