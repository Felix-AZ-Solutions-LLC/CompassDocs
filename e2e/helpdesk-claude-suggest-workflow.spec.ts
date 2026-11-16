import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, api, ensureUser, login } from "./helpers";
import { startFakeAnthropic, type FakeAnthropic } from "../test/support/fake-anthropic";

// Claude in the desk suggests starting a workflow (1.20.22,
// lib/helpdesk/claude/workflow-cards). The admin builds a team, a published
// workflow and a "New starter" request type (Start date, Laptop, Job title,
// Manager), and a ticket whose requester wrote the answers in their message.
//   suggest    asked "Start the New starter … workflow", Claude (the fake
//              Messages API's desk scenario) lists the startable types and
//              suggests one: the card names the type, the workflow and
//              version, "On this ticket", its reason and the answers it drew
//              from the conversation; nothing starts
//   review     Review and start opens 1.20.21's dialog with the type chosen
//              and Claude's answers in its fields (the note says so); the
//              agent edits one and starts it; the toast, the Workflow card,
//              the note "… · suggested by Claude", the audit, and the card's
//              Started chip with Open #n
//   two tabs   while one tab reviews, the other shows the card In review;
//              Cancel gives it back; Dismiss sets it aside
//   stale      a card whose workflow was started meanwhile is Out of date at
//              Review, with why
//
// NEVER the real API: as e2e/helpdesk-claude-desk, the spec starts the fake on
// E2E_FAKE_ANTHROPIC_PORT (default 4917); the dev server must run with
// COMPASSDOCS_ANTHROPIC_BASE_URL=http://127.0.0.1:4917, and the spec runs
// only with E2E_FAKE_ANTHROPIC=1. Workspace-wide settings (the AI provider
// and key, hd_claude_desk) are changed under the same advisory lock as that
// spec and restored. Licensed only (skips on 402).

const slow = expect.configure({ timeout: 60_000 });
const DB = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e";
const FAKE_PORT = Number(process.env.E2E_FAKE_ANTHROPIC_PORT || 4917);
const SETTINGS = ["ai_provider", "ai_model", "anthropic_api_key", "hd_claude_desk"];
const SHOTS = process.env.E2E_SHOTS ?? "";

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/claude-desk")).status !== 402;
}

test("claude suggests a workflow: the licence gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  test.skip(await licensed(page), "the helpdesk is licensed here; the gate is not shown");
  expect((await api(page, "/api/helpdesk/claude/cards/1/workflow", { method: "POST", body: { op: "review" } })).status).toBe(402);
});

test.describe("claude suggests starting a workflow (licensed, fake Messages API)", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(process.env.E2E_FAKE_ANTHROPIC !== "1", "set E2E_FAKE_ANTHROPIC=1 with the dev server on COMPASSDOCS_ANTHROPIC_BASE_URL=http://127.0.0.1:4917");
  test.use({ viewport: { width: 1440, height: 900 }, actionTimeout: 60_000 });
  const stamp = Date.now().toString(36);
  const DAN = { username: `e2e_hd_cwf_dan_${stamp}`, password: "E2eDanielOkafor!12345" };
  const made = { team: 0, type: 0, workflow: 0, tickets: [] as number[] };
  const typeTitle = `New starter ${stamp}`;
  const wfTitle = `Onboarding ${stamp}`;
  let db: Client;
  let fake: FakeAnthropic;
  let saved: { key: string; value: string }[] = [];

  test.beforeAll(async () => {
    fake = await startFakeAnthropic({ port: FAKE_PORT });
    db = new Client({ connectionString: DB });
    await db.connect();
    await db.query("SELECT pg_advisory_lock(hashtext('helpdesk_claude_desk_settings_test'))");
    saved = (await db.query("SELECT key, value FROM settings WHERE key = ANY($1)", [SETTINGS])).rows;
    for (const [k, v] of [
      ["ai_provider", "anthropic"],
      ["ai_model", "claude-opus-5-5"],
      ["anthropic_api_key", `sk-ant-e2e-fake-${stamp}`],
    ]) {
      await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [k, v]);
    }
    await db.query("DELETE FROM settings WHERE key = 'hd_claude_desk'");
  });

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    for (const n of made.tickets) {
      await api(page, "/api/helpdesk/recycle-bin", { method: "POST", body: { action: "bin", numbers: [n] } });
      await api(page, "/api/helpdesk/recycle-bin", { method: "POST", body: { action: "purge", numbers: [n] } });
    }
    if (made.type) await api(page, `/api/helpdesk/admin/request-types/${made.type}`, { method: "DELETE" });
    if (made.workflow) await api(page, `/api/helpdesk/admin/workflows/${made.workflow}`, { method: "DELETE" });
    if (made.team) await api(page, `/api/helpdesk/admin/teams/${made.team}`, { method: "DELETE" });
    await page.close();
    await db.query("DELETE FROM settings WHERE key = ANY($1)", [SETTINGS]);
    for (const r of saved) await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [r.key, r.value]);
    await db.query("SELECT pg_advisory_unlock(hashtext('helpdesk_claude_desk_settings_test'))");
    await db.end();
    await fake.close();
  });

  /** A ticket for Dan whose opening message holds the answers, as a requester would write them. */
  async function raise(page: Page, subject: string, dan: number): Promise<number> {
    const r = await api(page, "/api/helpdesk/tickets", {
      method: "POST",
      body: {
        subject: `${subject} ${stamp}`,
        body: "Hi, Alex is joining my team.\nStart date: 2026-12-07\nLaptop: Windows laptop\nJob title: Data analyst\nThanks!",
        team_id: made.team,
        priority: "normal",
        requester_id: dan,
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    made.tickets.push(r.body.ticket.number);
    return r.body.ticket.number as number;
  }

  /** The ticket open in the desk, the Claude panel open on it, the question asked. */
  async function ask(page: Page, n: number, question: string) {
    await page.goto(`/desk/tickets/${n}?team=${made.team}`);
    await slow(page.getByRole("button", { name: "Claude", exact: true })).toBeVisible({ timeout: 120_000 });
    await page.keyboard.press("Control+j");
    const panel = page.getByRole("complementary", { name: "Claude" });
    await expect(panel).toBeVisible();
    // The (empty) chat has loaded before asking: a question typed while it loads is not sent.
    await slow(panel.getByText(`Ask Claude about #${n}`)).toBeVisible();
    const box = panel.getByLabel("Ask Claude");
    await box.fill(question);
    await expect(box).toHaveValue(question);
    await box.press("Enter");
    return panel;
  }

  test("Claude suggests, the agent reviews and starts it; two tabs; Dismiss; a stale card", async ({ page, browser }) => {
    test.setTimeout(480_000);
    // --- Fixtures -------------------------------------------------------------------------------
    expect((await api(page, "/api/helpdesk/admin/claude-desk", { method: "PUT", body: { enabled: true } })).status).toBe(200);
    await ensureUser(page, DAN, "viewer", `Daniel Okafor ${stamp}`);
    const users = (await api(page, "/api/users/mentionable")).body.users as { id: number; username: string }[];
    const idOf = (u: string) => users.find((x) => x.username === u)!.id;
    const dan = idOf(DAN.username);
    const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `E2E Claude workflows ${stamp}`, icon: "monitor", members: [{ user_id: idOf(ADMIN.username), role: "lead" }] } });
    expect(team.status, JSON.stringify(team.body)).toBe(201);
    made.team = team.body.team.id;
    const wf = await api(page, "/api/helpdesk/admin/workflows", {
      method: "POST",
      body: { title: wfTitle, definition: { trigger: {}, steps: [{ key: "w", kind: "wait", title: "Give IT a day", until: { after_hours: 24 } }] } },
    });
    expect(wf.status, JSON.stringify(wf.body)).toBe(201);
    made.workflow = wf.body.workflow.id;
    expect((await api(page, `/api/helpdesk/admin/workflows/${made.workflow}/publish`, { method: "POST" })).status).toBe(200);
    const rt = await api(page, "/api/helpdesk/admin/request-types", {
      method: "POST",
      body: {
        title: typeTitle,
        description: "Someone joins: their laptop, accounts and first day.",
        icon: "user-plus",
        team_id: made.team,
        workflow_id: made.workflow,
        form: [
          { key: "start_date", label: "Start date", type: "date", required: true },
          { key: "laptop", label: "Laptop", type: "choice", required: true, options: [{ value: "mac", label: "MacBook Pro" }, { value: "win", label: "Windows laptop" }] },
          { key: "job", label: "Job title", type: "text", required: true },
          { key: "manager", label: "Manager", type: "user" },
        ],
      },
    });
    expect([200, 201], JSON.stringify(rt.body)).toContain(rt.status);
    made.type = Number(rt.body?.request_type?.id ?? rt.body?.id);
    const question = `Please start the ${typeTitle} workflow for this.`;

    // --- Suggest -------------------------------------------------------------------------------------
    const n1 = await raise(page, "Alex starts in December", dan);
    const panel = await ask(page, n1, question);
    const card = panel.getByRole("region", { name: `Start "${typeTitle}"` });
    await slow(card).toBeVisible();
    await expect(panel.getByText("Checked which workflows can start", { exact: true })).toBeVisible();
    await expect(card.getByText(`Starts ${wfTitle} (version 1)`, { exact: true })).toBeVisible();
    await expect(card.getByText("On this ticket", { exact: true })).toBeVisible();
    // Claude's own words, labelled as such.
    await expect(card.getByText(`Claude's reason: Daniel Okafor ${stamp} is asking for what ${typeTitle} covers.`)).toBeVisible();
    const answers = card.getByLabel("Claude's proposed answers");
    await expect(answers).toContainText("Start date:2026-12-07");
    await expect(answers).toContainText("Laptop:Windows laptop");
    await expect(answers).toContainText("Job title:Data analyst");
    expect((await api(page, `/api/helpdesk/tickets/${n1}`)).body.ticket.request_type_title, "nothing started before Review").toBeNull();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/claude-workflow-card-1440-light.png` });

    // --- Two tabs: while this one reviews, the other sees it In review ------------------------------------
    await card.getByRole("button", { name: "Review and start" }).click();
    const dialog = page.getByRole("dialog", { name: "Start a workflow" });
    await slow(dialog).toBeVisible();
    await expect(dialog.getByTestId("start-workflow-from-claude")).toContainText("Claude suggested this and filled in answers from the conversation");
    await expect(dialog.getByLabel("Request type")).toHaveValue(String(made.type));
    await expect(dialog.getByLabel("Start date")).toHaveValue("2026-12-07");
    await expect(dialog.getByLabel("Job title")).toHaveValue("Data analyst");
    await expect(dialog.getByRole("radio", { name: /Windows laptop/ })).toBeChecked();
    const second = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: test.info().project.use.baseURL });
    const tab2 = await second.newPage();
    try {
      await login(tab2, ADMIN);
      await tab2.goto(`/desk/tickets/${n1}?team=${made.team}`);
      await slow(tab2.getByRole("button", { name: "Claude", exact: true })).toBeVisible({ timeout: 120_000 });
      await tab2.keyboard.press("Control+j");
      const card2 = tab2.getByRole("complementary", { name: "Claude" }).getByRole("region", { name: `Start "${typeTitle}"` });
      await slow(card2.getByText("In review", { exact: true })).toBeVisible();
      await expect(card2.getByRole("button", { name: "Review and start" })).toHaveCount(0);
    } finally {
      await second.close();
    }

    // --- Start it, with one answer edited ------------------------------------------------------------------
    await dialog.getByLabel("Job title").fill("Senior data analyst");
    await dialog.getByRole("button", { name: "Start on this ticket" }).click();
    await slow(page.getByText(`${wfTitle} started on #${n1}.`)).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await slow(card.getByText("Started", { exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: `Open #${n1}` })).toBeVisible();
    await slow(page.getByRole("heading", { name: `Workflow · ${wfTitle}` })).toBeVisible();
    const t1 = await api(page, `/api/helpdesk/tickets/${n1}`);
    expect(t1.body.ticket.request_type_title).toBe(typeTitle);
    const note = (t1.body.messages as { kind: string; body: string }[]).find((m) => m.kind === "internal" && m.body.startsWith("Workflow started by"));
    expect(note?.body).toMatch(new RegExp(`\\(version 1\\) · suggested by Claude\\. This ticket is now a `));
    const audit = await db.query("SELECT details FROM audit_log WHERE action = 'helpdesk.workflow_run.started' AND target_id = $1 ORDER BY id DESC LIMIT 1", [String(n1)]);
    expect(audit.rows[0]?.details.suggested_by).toBe("claude_desk");
    const answersRow = await db.query("SELECT form_answers FROM hd_tickets WHERE number = $1", [n1]);
    expect(answersRow.rows[0].form_answers).toMatchObject({ start_date: "2026-12-07", laptop: "win", job: "Senior data analyst" });

    // --- Cancel gives the card back; Dismiss sets it aside -----------------------------------------------------
    const n2 = await raise(page, "Sam's replacement", dan);
    const panel2 = await ask(page, n2, question);
    const card2 = panel2.getByRole("region", { name: `Start "${typeTitle}"` });
    await slow(card2).toBeVisible();
    await card2.getByRole("button", { name: "Review and start" }).click();
    await slow(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await slow(card2.getByRole("button", { name: "Review and start" })).toBeVisible();
    await card2.getByRole("button", { name: "Dismiss" }).click();
    await slow(card2.getByText("Dismissed", { exact: true })).toBeVisible();
    expect((await api(page, `/api/helpdesk/tickets/${n2}`)).body.ticket.request_type_title).toBeNull();

    // --- Stale: the workflow was started meanwhile ------------------------------------------------------------------
    const n3 = await raise(page, "Priya's new hire", dan);
    const panel3 = await ask(page, n3, question);
    const card3 = panel3.getByRole("region", { name: `Start "${typeTitle}"` });
    await slow(card3).toBeVisible();
    const direct = await api(page, `/api/helpdesk/tickets/${n3}/start-workflow`, {
      method: "POST",
      body: { request_type_id: made.type, answers: { start_date: "2026-12-14", laptop: "mac", job: "Designer" }, client_start_id: `e2ecwfstale${stamp}0123456`, expect: "this" },
    });
    expect(direct.status, JSON.stringify(direct.body)).toBe(200);
    await card3.getByRole("button", { name: "Review and start" }).click();
    await slow(card3.getByText("Out of date", { exact: true })).toBeVisible();
    await expect(card3.getByText(new RegExp(`#${n3} already runs ${wfTitle}`))).toBeVisible();
    await expect(dialog).toHaveCount(0);
  });
});
