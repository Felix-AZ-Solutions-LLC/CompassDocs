import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ADMIN, api, ensureUser, login } from "./helpers";

// Start a workflow from the desk (1.20.21, lib/helpdesk/workflow-start).
// Licensed only (the EE rig); skips itself on 402. The admin builds a team, a
// published workflow (one wait step) and a "New laptop" request type whose
// form asks for a Model (required) and a Budget, then:
//   Sam (Agent)        on a ticket with no request type: … → Start a
//                      workflow…; the dialog says "On this ticket" before he
//                      chooses; a missing Model is caught; he starts it and
//                      the side panel's Workflow card and the request's
//                      answers show on the same ticket, with his note
//                      "Workflow started by Sam Lee: … (version 1)"
//                      on the same ticket again (it now has a run): the
//                      dialog says "On a new request"; he starts it and a new
//                      request opens for the same requester, linked both ways
//   double submit      the same client_start_id posted twice at once: one
//                      start, the other answers duplicate with the same
//                      request; a double click on the primary starts once
//   New ticket         Request type picker: the form shows, the subject may
//                      stay empty, changing the requester clears the type and
//                      its answers, "Create and start" opens the ticket with
//                      its Workflow card
//   permission off     Nico (Newbie, no "Start a workflow" by default) has no
//                      menu item and is refused by the API; with the
//                      capability switched off for Agent in the role matrix,
//                      Sam's item goes too (the matrix is put back after)
// E2E_SHOTS_DIR (optional) keeps screenshots of the dialog, light and dark.

const SAM = { username: "e2e_hd_ws_sam", password: "E2eSamLee!12345" };
const NICO = { username: "e2e_hd_ws_nico", password: "E2eNicoNewbie!12345" };
// A fresh requester each run: ensureUser keeps an existing account's name, and the dialog
// names the requester, so a reused account would still carry an earlier run's stamp.
const DAN = { username: `e2e_hd_ws_dan_${Date.now().toString(36)}`, password: "E2eDanielOkafor!12345" };
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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  await login(page, who);
  return { ctx, page };
}

/** The ticket's … menu, opened. */
async function openMore(page: Page, n: number) {
  await page.getByRole("button", { name: `More actions for ticket #${n}` }).click();
  return page.getByRole("menu", { name: `Ticket #${n}` });
}

test.describe("start a workflow from the desk (licensed)", () => {
  test.use({ viewport: { width: 1440, height: 900 }, actionTimeout: 60_000 });
  const stamp = Date.now().toString(36);
  const made: { team: number; type: number; workflow: number; tickets: number[]; agents: number[]; matrix: Record<string, string[]> | null } = {
    team: 0,
    type: 0,
    workflow: 0,
    tickets: [],
    agents: [],
    matrix: null,
  };

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    if (made.matrix) await api(page, "/api/helpdesk/admin/roles", { method: "PUT", body: { matrix: made.matrix } });
    for (const n of made.tickets) await api(page, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
    if (made.type) await api(page, `/api/helpdesk/admin/request-types/${made.type}`, { method: "DELETE" });
    if (made.workflow) await api(page, `/api/helpdesk/admin/workflows/${made.workflow}`, { method: "DELETE" });
    for (const id of made.agents) await api(page, `/api/helpdesk/admin/agents/${id}`, { method: "DELETE" });
    if (made.team) await api(page, `/api/helpdesk/admin/teams/${made.team}`, { method: "DELETE" });
    await page.close();
  });

  test("on this ticket, on a new request, New ticket, a double submit, and with the capability off", async ({ page, browser }) => {
    test.setTimeout(480_000);

    // --- Fixtures -------------------------------------------------------------------------------
    await ensureUser(page, SAM, "viewer", "Sam Lee");
    await ensureUser(page, NICO, "viewer", "Nico Newbie");
    await ensureUser(page, DAN, "viewer", `Daniel Okafor ${stamp}`);
    const users = (await api(page, "/api/users/mentionable")).body.users as { id: number; username: string }[];
    const idOf = (u: string) => users.find((x) => x.username === u)!.id;
    const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `E2E Start a workflow ${stamp}`, icon: "monitor", members: [{ user_id: idOf(ADMIN.username), role: "lead" }] } });
    expect(team.status, JSON.stringify(team.body)).toBe(201);
    made.team = team.body.team.id;
    for (const [u, role] of [[SAM.username, "agent"], [NICO.username, "newbie"]] as const) {
      const id = idOf(u);
      made.agents.push(id);
      await api(page, `/api/helpdesk/admin/agents/${id}`, { method: "DELETE" });
      const added = await api(page, "/api/helpdesk/admin/agents", { method: "POST", body: { user_id: id, role, team_ids: [made.team] } });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
    }
    const wfTitle = `Laptop order ${stamp}`;
    const wf = await api(page, "/api/helpdesk/admin/workflows", {
      method: "POST",
      body: { title: wfTitle, definition: { trigger: {}, steps: [{ key: "w", kind: "wait", title: "Give the supplier a day", until: { after_hours: 24 } }] } },
    });
    expect(wf.status, JSON.stringify(wf.body)).toBe(201);
    made.workflow = wf.body.workflow.id;
    expect((await api(page, `/api/helpdesk/admin/workflows/${made.workflow}/publish`, { method: "POST" })).status).toBe(200);
    const typeTitle = `New laptop ${stamp}`;
    const rt = await api(page, "/api/helpdesk/admin/request-types", {
      method: "POST",
      body: {
        title: typeTitle,
        description: "A laptop for someone who needs one.",
        icon: "laptop",
        team_id: made.team,
        workflow_id: made.workflow,
        form: [
          { key: "model", label: "Model", type: "text", required: true },
          { key: "budget", label: "Budget", type: "number" },
        ],
      },
    });
    expect([200, 201], JSON.stringify(rt.body)).toContain(rt.status);
    made.type = Number(rt.body?.request_type?.id ?? rt.body?.id);
    const dan = idOf(DAN.username);
    const raise = async (subject: string) => {
      const r = await api(page, "/api/helpdesk/tickets", {
        method: "POST",
        body: { subject: `${subject} ${stamp}`, body: "My laptop won't hold a charge any more.", team_id: made.team, priority: "normal", requester_id: dan },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      made.tickets.push(r.body.ticket.number);
      return r.body.ticket.number as number;
    };
    const n1 = await raise("Laptop battery dead");

    const sam = await browserFor(browser, SAM);
    try {
      // --- On this ticket -------------------------------------------------------------------------
      await sam.page.goto(`/desk/tickets/${n1}?team=${made.team}`);
      await see(sam.page.getByRole("heading", { level: 2, name: new RegExp(`Laptop battery dead ${stamp}`) })).toBeVisible({ timeout: 90_000 });
      await (await openMore(sam.page, n1)).getByRole("menuitem", { name: "Start a workflow…" }).click();
      const dialog = sam.page.getByRole("dialog", { name: "Start a workflow" });
      await see(dialog).toBeVisible();
      // What will happen, before anything is chosen.
      const mode = dialog.getByTestId("start-workflow-mode");
      await see(mode).toHaveAttribute("data-mode", "this");
      await see(mode).toContainText("On this ticket");
      await see(mode).toContainText(`The workflow runs on this ticket, #${n1}, which becomes Daniel Okafor ${stamp}'s request.`);
      await see(dialog.getByRole("button", { name: "Start on this ticket" })).toBeVisible();
      await dialog.getByLabel("Request type").selectOption({ label: typeTitle });
      await see(dialog.getByText(`Starts ${wfTitle} (version 1, 1 step)`)).toBeVisible();
      // The type's own form, with Get help's checks.
      await dialog.getByRole("button", { name: "Start on this ticket" }).click();
      await see(dialog.getByText("This is needed.")).toBeVisible();
      await see(dialog.getByLabel("Model")).toBeFocused();
      await dialog.getByLabel("Model").fill("ThinkPad X1 Carbon");
      await dialog.getByLabel("Budget (optional)").fill("1800");
      await shot(sam.page, "start-workflow-this");
      await dialog.getByRole("button", { name: "Start on this ticket" }).click();
      await see(sam.page.getByText(`${wfTitle} started on #${n1}.`)).toBeVisible({ timeout: 60_000 });
      await see(dialog).toHaveCount(0);
      // The run lives here: the Workflow card, the answers, the note.
      await see(sam.page.getByRole("heading", { name: `Workflow · ${wfTitle}` })).toBeVisible({ timeout: 60_000 });
      await see(sam.page.getByRole("heading", { name: "Request details" })).toBeVisible();
      await see(sam.page.getByText("ThinkPad X1 Carbon")).toBeVisible();
      await see(sam.page.getByText(`Workflow started by Sam Lee: ${wfTitle} (version 1).`, { exact: false })).toBeVisible();

      // --- On a new request (the ticket now has a run) -------------------------------------------
      await (await openMore(sam.page, n1)).getByRole("menuitem", { name: "Start a workflow…" }).click();
      await see(dialog).toBeVisible();
      await see(mode).toHaveAttribute("data-mode", "new");
      await see(mode).toContainText("On a new request");
      await see(mode).toContainText(`#${n1} is already a ${typeTitle} request, so a new request is opened for Daniel Okafor ${stamp}`);
      await dialog.getByLabel("Request type").selectOption({ label: typeTitle });
      await dialog.getByLabel("Model").fill("MacBook Air");
      await shot(sam.page, "start-workflow-new");
      await dialog.getByRole("button", { name: "Open a request and start" }).dblclick();
      const toast = sam.page.getByText(new RegExp(`^Request #(\\d+) opened and ${wfTitle} started\\.$`));
      await see(toast).toBeVisible({ timeout: 60_000 });
      const n2 = Number((await toast.textContent())!.match(/#(\d+)/)![1]);
      made.tickets.push(n2);
      // A double click started it once: the note on this ticket names exactly one new request.
      const conversation = sam.page.getByRole("list", { name: "Conversation" });
      await see(conversation.getByRole("listitem").filter({ hasText: "on a new request:" })).toHaveCount(1, { timeout: 30_000 });
      await see(conversation.getByRole("link", { name: new RegExp(`^#${n2} `) })).toBeVisible();
      const req2 = await api(sam.page, `/api/helpdesk/tickets/${n2}`);
      expect(req2.status).toBe(200);
      expect(req2.body.ticket.requester_id).toBe(dan);
      expect(req2.body.ticket.request_type_title).toBe(typeTitle);
      expect(req2.body.ticket.source).toBe("desk");
      expect(req2.body.workflow?.workflow_title).toBe(wfTitle);
      expect(req2.body.messages.some((m: { kind: string; body: string }) => m.kind === "internal" && m.body.includes(`(/desk/tickets/${n1})`))).toBe(true);
      const first = await api(sam.page, `/api/helpdesk/tickets/${n1}`);
      expect(first.body.ticket.request_type_title).toBe(typeTitle);

      // --- Double submit through the API: one key, two posts at once ------------------------------
      const n3 = await raise("Docking station");
      const both = await sam.page.evaluate(
        async ({ n, type }) => {
          const body = JSON.stringify({ request_type_id: type, answers: { model: "Dock" }, client_start_id: "e2edoublesubmit0123456789", expect: "this" });
          const post = () => fetch(`/api/helpdesk/tickets/${n}/start-workflow`, { method: "POST", headers: { "content-type": "application/json" }, body }).then(async (r) => ({ status: r.status, body: await r.json() }));
          return Promise.all([post(), post()]);
        },
        { n: n3, type: made.type }
      );
      expect(both.map((x) => x.status)).toEqual([200, 200]);
      expect(both.map((x) => x.body.duplicate).sort()).toEqual([false, true]);
      expect(both[0].body.request.number).toBe(n3);
      expect(both[1].body.request.number).toBe(n3);
      const d3 = await api(sam.page, `/api/helpdesk/tickets/${n3}`);
      expect(d3.body.workflow?.workflow_title).toBe(wfTitle);
      expect(d3.body.messages.filter((m: { kind: string; body: string }) => m.kind === "internal" && m.body.startsWith("Workflow started by")).length).toBe(1);

      // --- New ticket with a request type --------------------------------------------------------
      await sam.page.goto(`/desk?team=${made.team}`);
      await sam.page.getByRole("button", { name: "New ticket" }).click();
      const nt = sam.page.getByRole("dialog", { name: "New ticket" });
      await nt.getByRole("combobox", { name: "Requester" }).fill(`Daniel Okafor ${stamp}`);
      await sam.page.getByRole("option", { name: new RegExp(`Daniel Okafor ${stamp}`) }).first().click();
      await nt.getByLabel("Request type (optional)").selectOption({ label: typeTitle });
      await nt.getByLabel("Model").fill("Typed for the wrong person");
      // A new requester starts from no type: nothing typed (or prefilled) for the last one carries over.
      await nt.getByRole("button", { name: "Change" }).click();
      await nt.getByRole("combobox", { name: "Requester" }).fill(`Daniel Okafor ${stamp}`);
      await sam.page.getByRole("option", { name: new RegExp(`Daniel Okafor ${stamp}`) }).first().click();
      await see(nt.getByLabel("Request type (optional)")).toHaveValue("");
      await expect(nt.getByLabel("Model")).toHaveCount(0);
      await nt.getByLabel("Request type (optional)").selectOption({ label: typeTitle });
      await see(nt.getByText(`Starts ${wfTitle} (version 1) when the ticket is created.`)).toBeVisible();
      await expect(nt.getByLabel("Model")).toHaveValue("");
      await nt.getByLabel("Model").fill("Dell XPS 13");
      // Get help's rule: the type, then the first text answer.
      await see(nt.getByText(`Left empty: "${typeTitle}: Dell XPS 13".`)).toBeVisible();
      await nt.getByRole("button", { name: "Create and start" }).click();
      await see(nt).toHaveCount(0, { timeout: 60_000 });
      await sam.page.waitForURL(/\/desk\/tickets\/\d+/);
      const n4 = Number(sam.page.url().match(/\/desk\/tickets\/(\d+)/)![1]);
      made.tickets.push(n4);
      await see(sam.page.getByRole("heading", { name: `Workflow · ${wfTitle}` })).toBeVisible({ timeout: 60_000 });
      await see(sam.page.getByText("Dell XPS 13").first()).toBeVisible();

      // --- Permission off ----------------------------------------------------------------------------
      // Nico (Newbie) has no "Start a workflow" by default: no item, and the API refuses.
      const nico = await browserFor(browser, NICO);
      try {
        const n5 = await raise("Mouse broken");
        await nico.page.goto(`/desk/tickets/${n5}?team=${made.team}`);
        await see(nico.page.getByRole("heading", { level: 2, name: new RegExp(`Mouse broken ${stamp}`) })).toBeVisible({ timeout: 90_000 });
        const menu = await openMore(nico.page, n5);
        await see(menu.getByRole("menuitem").first()).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: "Start a workflow…" })).toHaveCount(0);
        await nico.page.keyboard.press("Escape");
        expect((await api(nico.page, `/api/helpdesk/tickets/${n5}/start-workflow`)).status).toBe(403);
        const refused = await api(nico.page, `/api/helpdesk/tickets/${n5}/start-workflow`, {
          method: "POST",
          body: { request_type_id: made.type, answers: { model: "x" }, client_start_id: "e2enewbierefused0123456", expect: "this" },
        });
        expect(refused.status).toBe(403);
        expect((await api(page, `/api/helpdesk/tickets/${n5}`)).body.ticket.request_type_title).toBeNull();

        // The capability switched off for Agent: Sam's item goes too.
        const roles = await api(page, "/api/helpdesk/admin/roles");
        expect(roles.status).toBe(200);
        made.matrix = roles.body.matrix;
        const off = await api(page, "/api/helpdesk/admin/roles", {
          method: "PUT",
          body: { matrix: { agent: (roles.body.matrix.agent as string[]).filter((c) => c !== "workflows.start") } },
        });
        expect(off.status, JSON.stringify(off.body)).toBe(200);
        // The matrix is cached for 2 s per server module (lib/helpdesk/roles MATRIX_TTL_MS), and the
        // desk page reads its own copy: wait until the change is seen before opening the ticket.
        await expect.poll(async () => (await api(sam.page, `/api/helpdesk/tickets/${n5}/start-workflow`)).status, { timeout: 15_000 }).toBe(403);
        await sam.page.waitForTimeout(2_500);
        await sam.page.goto(`/desk/tickets/${n5}?team=${made.team}`);
        await see(sam.page.getByRole("heading", { level: 2, name: new RegExp(`Mouse broken ${stamp}`) })).toBeVisible({ timeout: 90_000 });
        const samMenu = await openMore(sam.page, n5);
        await see(samMenu.getByRole("menuitem").first()).toBeVisible();
        await expect(samMenu.getByRole("menuitem", { name: "Start a workflow…" })).toHaveCount(0);
        await sam.page.keyboard.press("Escape");
        expect((await api(sam.page, `/api/helpdesk/tickets/${n5}/start-workflow`)).status).toBe(403);
        // And New ticket offers no Request type.
        await sam.page.getByRole("button", { name: "New ticket" }).click();
        await sam.page.getByRole("dialog", { name: "New ticket" }).getByRole("combobox", { name: "Requester" }).fill(`Daniel Okafor ${stamp}`);
        await sam.page.getByRole("option", { name: new RegExp(`Daniel Okafor ${stamp}`) }).first().click();
        await expect(sam.page.getByLabel("Request type (optional)")).toHaveCount(0);
        await sam.page.keyboard.press("Escape");
      } finally {
        if (made.matrix) {
          await api(page, "/api/helpdesk/admin/roles", { method: "PUT", body: { matrix: made.matrix } });
          made.matrix = null;
        }
        await nico.ctx.close();
      }
    } finally {
      await sam.ctx.close();
    }
  });
});
