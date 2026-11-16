import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ADMIN, api, ensureUser, login } from "./helpers";

// Desk departments (1.20.23, lib/helpdesk/desk-departments). Licensed only
// (the EE rig); skips itself on 402. The admin, in Desk settings → Teams →
// Desk departments:
//   - sees General (Default) holding the desk's teams, creates "HR <stamp>"
//     with New desk department, and moves the HR team into it with the
//     team's select: the confirm dialog lists Hana as losing General's
//     content (review M5), then the toast names the department;
//   - in Macros, files one macro in General and one in HR (the Desk
//     department field), and the list's Desk department filter shows HR's only;
// then, as the agents:
//   Sam (Agent, IT team in General)   the composer's macros list General's,
//                                     not HR's; applying HR's by id is "not found"
//   Hana (Agent, HR team in HR)       HR's, not General's
// and back as the admin: deleting HR is refused while the team is in it (the
// dialog says to move it first); once the team is back in General, HR is
// deleted with its macro moved to General.
// E2E_SHOTS_DIR (optional) keeps screenshots of the page, light and dark.

const SAM = { username: "e2e_hd_dd_sam", password: "E2eSamDept!12345" };
const HANA = { username: "e2e_hd_dd_hana", password: "E2eHanaDept!12345" };
const SHOTS = process.env.E2E_SHOTS_DIR;
const see = expect.configure({ timeout: 30_000 });

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/counts")).status !== 402;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}-1440-light.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}-1440-dark.png` });
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await page.emulateMedia({ colorScheme: "light" });
}

async function browserFor(browser: Browser, who: { username: string; password: string }): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await login(page, who);
  return { ctx, page };
}

test.describe("desk departments (licensed)", () => {
  test.use({ viewport: { width: 1440, height: 900 }, actionTimeout: 60_000 });
  const stamp = Date.now().toString(36);
  const made: { teams: number[]; macros: number[]; agents: number[]; tickets: number[]; dept: number } = { teams: [], macros: [], agents: [], tickets: [], dept: 0 };

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    const deps = (await api(page, "/api/helpdesk/admin/desk-departments")).body?.departments as { id: number; is_default: boolean }[] | undefined;
    const general = deps?.find((d) => d.is_default)?.id;
    for (const t of made.teams) if (general) await api(page, `/api/helpdesk/admin/desk-departments/${general}/teams`, { method: "PUT", body: { team_id: t, confirm: true } });
    for (const n of made.tickets) await api(page, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
    for (const id of made.macros) await api(page, `/api/helpdesk/admin/macros/${id}`, { method: "DELETE" });
    if (made.dept) await api(page, `/api/helpdesk/admin/desk-departments/${made.dept}${general ? `?move_content_to=${general}` : ""}`, { method: "DELETE" });
    for (const id of made.agents) await api(page, `/api/helpdesk/admin/agents/${id}`, { method: "DELETE" });
    for (const t of made.teams) await api(page, `/api/helpdesk/admin/teams/${t}`, { method: "DELETE" });
    await page.close();
  });

  test("create a department, move a team into it, file macros in it; agents see only their departments'; delete it", async ({ page, browser }) => {
    test.setTimeout(420_000);

    // --- Fixtures: two teams (both start in General), an agent in each ---------------------------
    await ensureUser(page, SAM, "viewer", "Sam Lee");
    await ensureUser(page, HANA, "viewer", "Hana Ito");
    const users = (await api(page, "/api/users/mentionable")).body.users as { id: number; username: string }[];
    const idOf = (u: string) => users.find((x) => x.username === u)!.id;
    const itName = `E2E IT ${stamp}`;
    const hrName = `E2E People ${stamp}`;
    for (const name of [itName, hrName]) {
      const t = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name } });
      expect(t.status, JSON.stringify(t.body)).toBe(201);
      made.teams.push(t.body.team.id);
    }
    const [itTeam, hrTeam] = made.teams;
    for (const [u, team] of [[SAM.username, itTeam], [HANA.username, hrTeam]] as const) {
      const id = idOf(u);
      made.agents.push(id);
      await api(page, `/api/helpdesk/admin/agents/${id}`, { method: "DELETE" });
      const added = await api(page, "/api/helpdesk/admin/agents", { method: "POST", body: { user_id: id, role: "agent", team_ids: [team] } });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
    }

    // --- Desk settings → Teams → Desk departments --------------------------------------------------
    await page.goto("/desk/settings/departments");
    await see(page.getByRole("heading", { level: 1, name: "Teams" })).toBeVisible({ timeout: 90_000 });
    await see(page.getByRole("navigation", { name: "Teams settings" }).getByRole("link", { name: "Desk departments" })).toBeVisible();
    const list = page.getByTestId("hd-desk-departments");
    await see(list.getByTestId("hd-desk-department-row").first()).toContainText("General");
    await see(list.getByTestId("hd-desk-department-row").first()).toContainText("Default");
    // General has no Delete; it can be renamed.
    await see(page.getByRole("button", { name: "Delete General" })).toHaveCount(0);
    await see(page.getByRole("button", { name: "Rename General" })).toBeVisible();

    const deptName = `HR ${stamp}`;
    await page.getByRole("button", { name: "New desk department" }).click();
    const prompt = page.getByRole("dialog", { name: "New desk department" });
    await prompt.getByLabel("Name").fill(deptName);
    await prompt.getByRole("button", { name: "Create desk department" }).click();
    await see(page.getByText(`${deptName} created. Move its teams into it below.`)).toBeVisible();
    await see(list.getByTestId("hd-desk-department-row").filter({ hasText: deptName })).toContainText("0 teams");
    const deps = (await api(page, "/api/helpdesk/admin/desk-departments")).body.departments as { id: number; name: string; is_default: boolean }[];
    made.dept = deps.find((d) => d.name === deptName)!.id;
    const general = deps.find((d) => d.is_default)!.id;

    // Move the HR team with its select. Hana loses General's content, so the move asks first (review M5).
    await page.getByLabel(hrName).selectOption({ label: deptName });
    const confirmMove = page.getByRole("dialog", { name: `Move ${hrName} to ${deptName}?` });
    await see(confirmMove.getByTestId("hd-team-move-affected")).toContainText("Hana Ito");
    await see(confirmMove.getByTestId("hd-team-move-affected")).toContainText("lose General's content");
    await shot(page, "desk-departments-move-confirm");
    await confirmMove.getByRole("button", { name: "Move team" }).click();
    await see(page.getByText(`${hrName} is now in ${deptName}.`)).toBeVisible();
    await see(list.getByTestId("hd-desk-department-row").filter({ hasText: deptName })).toContainText("1 team");
    await shot(page, "desk-departments");

    // --- Macros, one per department --------------------------------------------------------------
    const generalMacro = `General hello ${stamp}`;
    const hrMacro = `HR hello ${stamp}`;
    await page.goto("/desk/settings/macros");
    for (const [title, dept] of [[generalMacro, "General"], [hrMacro, deptName]] as const) {
      await page.getByRole("button", { name: "New macro" }).first().click();
      const dialog = page.getByRole("dialog", { name: "New macro" });
      await dialog.getByLabel("Name", { exact: true }).fill(title);
      await dialog.getByRole("textbox", { name: "Reply", exact: true }).fill("Hello {{requester.first_name}}.");
      await dialog.getByTestId("hd-desk-department").selectOption({ label: dept });
      await dialog.getByRole("button", { name: "Create macro" }).click();
      await see(page.getByText("Macro created.")).toBeVisible();
      await see(dialog).toHaveCount(0);
    }
    const mine = ((await api(page, "/api/helpdesk/admin/macros")).body.macros as { id: number; title: string; desk_department_id: number | null }[]).filter((m) =>
      [generalMacro, hrMacro].includes(m.title)
    );
    made.macros.push(...mine.map((m) => m.id));
    expect(mine.find((m) => m.title === hrMacro)?.desk_department_id).toBe(made.dept);
    expect(mine.find((m) => m.title === generalMacro)?.desk_department_id).toBe(general);
    // The list's filter: HR only.
    await page.getByTestId("hd-desk-department-filter").selectOption({ label: deptName });
    await see(page.getByText(hrMacro)).toBeVisible();
    await see(page.getByText(generalMacro)).toHaveCount(0);
    await shot(page, "desk-departments-macros");

    // --- The agents ------------------------------------------------------------------------------
    const ticket = await api(page, "/api/helpdesk/tickets", { method: "POST", body: { subject: `Printer jam ${stamp}`, body: "Paper stuck.", team_id: itTeam, priority: "normal" } });
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
    const n = ticket.body.ticket.number as number;
    made.tickets.push(n);
    const sam = await browserFor(browser, SAM);
    const hana = await browserFor(browser, HANA);
    try {
      const titles = async (p: Page) => ((await api(p, "/api/helpdesk/macros")).body.macros as { title: string }[]).map((m) => m.title);
      const samSees = await titles(sam.page);
      expect(samSees).toContain(generalMacro);
      expect(samSees).not.toContain(hrMacro);
      const hanaSees = await titles(hana.page);
      expect(hanaSees).toContain(hrMacro);
      expect(hanaSees).not.toContain(generalMacro);
      const hrId = mine.find((m) => m.title === hrMacro)!.id;
      const refused = await api(sam.page, `/api/helpdesk/tickets/${n}/macro/${hrId}`, { method: "POST", body: { preview: true } });
      expect(refused.status).toBe(404);
      // In the composer: Sam's macro menu lists General's, not HR's.
      await sam.page.goto(`/desk/tickets/${n}?team=${itTeam}`);
      await see(sam.page.getByRole("heading", { level: 2, name: new RegExp(`Printer jam ${stamp}`) })).toBeVisible({ timeout: 90_000 });
      await sam.page.getByRole("button", { name: /^Macro/ }).first().click();
      const picker = sam.page.getByRole("dialog", { name: "Macros" });
      await see(picker.getByText(generalMacro)).toBeVisible();
      await see(picker.getByText(hrMacro)).toHaveCount(0);
    } finally {
      await sam.ctx.close();
      await hana.ctx.close();
    }

    // --- Deleting HR ---------------------------------------------------------------------------
    await page.goto("/desk/settings/departments");
    await page.getByRole("button", { name: `Delete ${deptName}` }).click();
    const del = page.getByRole("dialog", { name: `Delete ${deptName}?` });
    await see(del).toContainText(`Move its 1 team (${hrName}) to another desk department first`);
    await del.getByRole("button", { name: "Close" }).last().click();
    await page.getByLabel(hrName).selectOption({ label: "General" });
    await page.getByRole("dialog", { name: `Move ${hrName} to General?` }).getByRole("button", { name: "Move team" }).click();
    await see(page.getByText(`${hrName} is now in General.`)).toBeVisible();
    await page.getByRole("button", { name: `Delete ${deptName}` }).click();
    await see(del).toContainText("It still holds 1 macro");
    await del.getByLabel("Move its content to").selectOption({ label: "General" });
    await del.getByRole("button", { name: "Move content and delete" }).click();
    await see(page.getByText(`${deptName} deleted. Its content is in General now.`)).toBeVisible();
    made.dept = 0;
    const after = ((await api(page, "/api/helpdesk/admin/macros")).body.macros as { title: string; desk_department_id: number | null }[]).find((m) => m.title === hrMacro);
    expect(after?.desk_department_id).toBe(general);
  });
});
