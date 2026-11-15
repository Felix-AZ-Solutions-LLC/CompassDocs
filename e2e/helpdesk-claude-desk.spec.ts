import { mkdir } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, login, api } from "./helpers";
import { startFakeAnthropic, type FakeAnthropic } from "../test/support/fake-anthropic";

// Claude in the desk (1.20.0; mock-ups c1 to c3). Desk settings → Claude in
// the desk switched on; on a ticket, the Claude button's launcher with quick
// prompts (c2) and Ctrl/⌘+J; the docked panel (c1): a streamed answer with
// the tool activity line and source chips, a reply draft put in the reply
// box, and the status card applied through the desk's own PATCH (audited
// "via Claude in the desk"); the panel full screen at 390px. 1.20.14: Claude
// proposes ticking a checklist item and drafts a checklist; Apply ticks it
// through the desk's route ("via Claude in the desk"), Save as draft keeps
// the checklist unpublished in Desk settings → Checklists. 1.20.15: Claude
// proposes a macro; the card says what it will do; Apply applies it through
// the desk's own macro route ("via Claude in the desk", audited). 1.20.16:
// Claude drafts an automation, a recurring ticket and category changes; the
// cards say what each draft does; Save as draft keeps the automation off and
// unpublished (it opens with the draft strip in Desk settings → Automations).
//
// NEVER the real API. The spec starts the fake Messages API
// (test/support/fake-anthropic) on E2E_FAKE_ANTHROPIC_PORT (default 4917),
// and the rig's dev server must have been started with
//   COMPASSDOCS_ANTHROPIC_BASE_URL=http://127.0.0.1:4917
// It runs only when E2E_FAKE_ANTHROPIC=1 says so; otherwise it skips, so a
// rig pointed at the real API is never asked anything.
//
// Workspace-wide settings (the AI provider and key, hd_claude_desk) are
// changed under an advisory lock and restored afterwards; the key it stores
// is a dummy only the fake accepts. Everything else it makes is its own.
//
// E2E_SHOTS=<dir> saves c1 to c3 in light and dark at 1440, and the panel at 390.

const slow = expect.configure({ timeout: 60_000 });
const SHOTS = process.env.E2E_SHOTS ?? "";
const DB = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e";
const FAKE_PORT = Number(process.env.E2E_FAKE_ANTHROPIC_PORT || 4917);
const SETTINGS = ["ai_provider", "ai_model", "anthropic_api_key", "hd_claude_desk"];

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/claude-desk")).status !== 402;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.screenshot({ path: `${SHOTS}/${name}-light.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/${name}-dark.png` });
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await page.emulateMedia({ colorScheme: "light" });
}

test("claude in the desk: the licence gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  test.skip(await licensed(page), "the helpdesk is licensed here; the gate is not shown");
  expect((await api(page, "/api/helpdesk/admin/claude-desk")).status).toBe(402);
  expect((await api(page, "/api/helpdesk/claude/chat", { method: "POST", body: { ticket: null, text: "Hi" } })).status).toBe(402);
});

test.describe("claude in the desk (licensed, fake Messages API)", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(process.env.E2E_FAKE_ANTHROPIC !== "1", "set E2E_FAKE_ANTHROPIC=1 with the dev server on COMPASSDOCS_ANTHROPIC_BASE_URL=http://127.0.0.1:4917");
  const stamp = Date.now().toString(36);
  const teamName = `E2E Claude ${stamp}`;
  let teamId = 0;
  let number = 0;
  let db: Client;
  let fake: FakeAnthropic;
  let saved: { key: string; value: string }[] = [];

  test.beforeAll(async () => {
    fake = await startFakeAnthropic({ port: FAKE_PORT });
    db = new Client({ connectionString: DB });
    await db.connect();
    await db.query("SELECT pg_advisory_lock(hashtext('helpdesk_claude_desk_settings_test'))");
    saved = (await db.query("SELECT key, value FROM settings WHERE key = ANY($1)", [SETTINGS])).rows;
    // A dummy key (only the fake answers) on the Anthropic provider, Opus 5.5.
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
    if (!teamId) {
      const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: teamName, icon: "monitor", members: [] } });
      expect(team.status, JSON.stringify(team.body)).toBe(201);
      teamId = team.body.team.id;
    }
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    // 1.19.4: a delete goes to the recycle bin; purge it for good (its Claude chats go with it).
    if (number) {
      await api(page, "/api/helpdesk/recycle-bin", { method: "POST", body: { action: "bin", numbers: [number] } });
      await api(page, "/api/helpdesk/recycle-bin", { method: "POST", body: { action: "purge", numbers: [number] } });
    }
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await page.close();
    await db.query("DELETE FROM settings WHERE key = ANY($1)", [SETTINGS]);
    for (const r of saved) await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [r.key, r.value]);
    await db.query("SELECT pg_advisory_unlock(hashtext('helpdesk_claude_desk_settings_test'))");
    await db.end();
    await fake.close();
  });

  test("c3: Desk settings → Claude in the desk switches it on, as drawn", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/desk/settings/claude-desk");
    await slow(page.getByRole("heading", { level: 1, name: "Claude in the desk" })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("Uses the key and model set in Settings → AI · Claude Opus 5.5")).toBeVisible();
    for (const label of ["Read tickets, notes and your articles", "Search past solved tickets and assets", "Search the web", "Suggest ticket changes", "Draft replies and internal notes"]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    await page.getByRole("switch", { name: /^Claude in the desk Uses the key/ }).click();
    await page.getByRole("switch", { name: /^Search the web\b/ }).click();
    await page.getByLabel("Sites Claude may search", { exact: true }).fill("support.microsoft.com, support.apple.com, docs.paloaltonetworks.com");
    await page.getByLabel("Monthly limit for the workspace", { exact: true }).fill("400");
    await page.getByLabel("Monthly limit per agent", { exact: true }).fill("25");
    await page.getByRole("button", { name: "Save Claude settings" }).click();
    await slow(page.getByText("Claude in the desk settings saved.")).toBeVisible();
    const audit = await db.query("SELECT details FROM audit_log WHERE action = 'helpdesk.settings.updated' AND details->>'section' = 'claude_desk' ORDER BY id DESC LIMIT 1");
    expect(audit.rows[0]?.details.changed).toContain("enabled");
    await page.reload();
    await slow(page.getByText("Only these sites: support.microsoft.com, support.apple.com, docs.paloaltonetworks.com")).toBeVisible();
    await shot(page, "c3-claude-settings-1440");
  });

  test("c2 and c1: the launcher, a streamed answer, a draft in the reply box and Apply", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const t = await api(page, "/api/helpdesk/tickets", {
      method: "POST",
      body: { subject: `Laptop won't connect to VPN from home ${stamp}`, body: 'Since this morning the VPN client says "Authentication failed" when I connect from home. It works in the office.', team_id: teamId, priority: "normal" },
    });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    number = t.body.ticket.number;
    await db.query("UPDATE hd_tickets SET requester_name = 'Daniel Okafor' WHERE number = $1", [number]);
    expect((await api(page, `/api/helpdesk/tickets/${number}/messages`, { method: "POST", body: { kind: "internal", body: "MFA re-enrolled yesterday after the phone swap; the old token is probably cached." } })).status).toBe(201);

    await page.goto(`/desk/tickets/${number}`);
    const claude = page.getByRole("button", { name: "Claude", exact: true });
    await slow(claude).toBeVisible({ timeout: 120_000 });
    // c2: the launcher.
    await claude.click();
    const launcher = page.getByRole("menu", { name: `Ask Claude about #${number}` });
    await expect(launcher).toBeVisible();
    for (const p of ["Summarise this ticket", "Has this happened before?", "Draft a reply", "Translate my reply into French", "What should I do next?"]) {
      await expect(launcher.getByRole("menuitem", { name: p })).toBeVisible();
    }
    await shot(page, "c2-claude-launcher-1440");
    await launcher.getByRole("menuitem", { name: "Has this happened before?" }).click();

    // c1: the panel answers, with the activity line.
    const panel = page.getByRole("complementary", { name: "Claude" });
    await expect(panel).toBeVisible();
    await slow(panel.getByText("Searched solved tickets", { exact: true })).toBeVisible();
    await slow(panel.getByRole("log").getByText(/couldn't find an earlier ticket|times? in the last month/)).toBeVisible();
    const sent = fake.requests.filter((r) => Array.isArray(r.body?.tools));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0].body.output_config).toEqual({ effort: "high" });
    expect(sent[0].body.tools.some((x: { type?: string }) => x.type === "web_search_20260209")).toBe(true);

    // Ask for a draft by typing: it lands in the reply box; the change waits for Apply.
    const box = panel.getByLabel("Ask Claude");
    await box.fill("Draft a reply with the steps, and put it on waiting.");
    await box.press("Enter");
    await slow(panel.getByText("Reply draft for Daniel", { exact: true })).toBeVisible();
    await expect(panel.getByText("in your reply box", { exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => [...document.querySelectorAll("textarea")].some((t) => t.value.includes("the VPN client keeps your old sign-in token"))), { timeout: 60_000 })
      .toBe(true);
    await expect(panel.getByText("Set status to Waiting on requester", { exact: true })).toBeVisible();
    await expect(panel.getByText("After you send the reply.", { exact: true })).toBeVisible();
    expect((await db.query("SELECT status FROM hd_tickets WHERE number = $1", [number])).rows[0].status, "not applied yet").toBe(t.body.ticket.status);
    await shot(page, "c1-claude-panel-1440");

    await panel.getByRole("button", { name: "Apply" }).click();
    await slow(panel.getByText("Applied", { exact: true })).toBeVisible();
    // The Apply button gives way to "Applied": focus stays in the panel, on the question box.
    await expect(panel.getByLabel("Ask Claude")).toBeFocused();
    expect((await db.query("SELECT status FROM hd_tickets WHERE number = $1", [number])).rows[0].status).toBe("pending");
    const audit = await db.query("SELECT details FROM audit_log WHERE action = 'helpdesk.ticket.updated' AND details->>'via' = 'claude_desk' AND (details->>'number')::int = $1", [number]);
    expect(audit.rowCount).toBe(1);
    const chats = await db.query("SELECT details FROM audit_log WHERE action = 'helpdesk.claude.chat' AND (details->>'number')::int = $1", [number]);
    expect(chats.rowCount).toBeGreaterThanOrEqual(2);

    // Ctrl/⌘+J closes and reopens it; Escape closes it and focus returns.
    await page.keyboard.press("Control+j");
    await expect(panel).toHaveCount(0);
    await page.keyboard.press("Control+j");
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Reply draft for Daniel", { exact: true })).toBeVisible();
    await panel.getByLabel("Ask Claude").press("Escape");
    await expect(panel).toHaveCount(0);

    // The panel at 390: full screen.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press("Control+j");
    await expect(panel).toBeVisible();
    // The chat is loaded again before the picture.
    await slow(panel.getByText("Reply draft for Daniel", { exact: true })).toBeVisible();
    const boxSize = await panel.boundingBox();
    expect(Math.round(boxSize?.width ?? 0)).toBe(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, "c1-claude-panel-390");
  });

  test("checklists: Claude proposes a tick and drafts a checklist; Apply ticks it, Save as draft keeps it unpublished", async ({ page }) => {
    test.setTimeout(300_000);
    expect(number, "the c1 test made the ticket").toBeGreaterThan(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    const tplName = `Laptop handover ${stamp}`;
    const draftName = `Leaver kit ${stamp}`;
    const tpl = await api(page, "/api/helpdesk/admin/checklists", { method: "POST", body: { name: tplName, items: [{ title: "Wipe the laptop", required: true }, { title: "Return the badge" }] } });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(201);
    const added = await api(page, `/api/helpdesk/tickets/${number}/checklists`, { method: "POST", body: { template_id: tpl.body.template.id } });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const item = (added.body.checklists as { name: string; items: { id: number; title: string }[] }[]).find((c) => c.name === tplName)!.items[0];
    try {
      fake.queue(
        {
          content: [
            { type: "tool_use", name: "propose_checklist_ticks", input: { number, items: [{ id: item.id, done: true }], when: null } },
            {
              type: "tool_use",
              name: "draft_checklist",
              input: { name: draftName, items: [{ title: "Disable sign-in", required: true, team_id: null, due_days: 0 }, { title: "Collect the laptop", required: false, team_id: null, due_days: 2 }] },
            },
          ],
        },
        { content: [{ type: "text", text: "I prepared the tick and a checklist draft. Apply or save them when you're ready." }] }
      );
      await page.goto(`/desk/tickets/${number}`);
      await slow(page.getByRole("button", { name: "Claude", exact: true })).toBeVisible({ timeout: 120_000 });
      await page.keyboard.press("Control+j");
      const panel = page.getByRole("complementary", { name: "Claude" });
      await expect(panel).toBeVisible();
      // The ticket's chat is loaded again before asking (a question typed while it loads is not sent).
      await slow(panel.getByText("Reply draft for Daniel", { exact: true })).toBeVisible();
      const box = panel.getByLabel("Ask Claude");
      await box.fill("The laptop is wiped. Tick it, and make a leaver checklist from this.");
      await expect(box).toHaveValue(/laptop is wiped/);
      await box.press("Enter");
      const tick = panel.getByRole("region", { name: 'Tick "Wipe the laptop"' });
      const draft = panel.getByRole("region", { name: `Checklist draft: ${draftName}` });
      await slow(tick).toBeVisible();
      await slow(draft).toBeVisible();
      await expect(draft).toContainText("Disable sign-in");
      await expect(draft.getByText("Required", { exact: true })).toBeVisible();
      expect((await db.query("SELECT done_at FROM hd_ticket_checklist_items WHERE id = $1", [item.id])).rows[0].done_at, "not ticked before Apply").toBeNull();
      await shot(page, "claude-checklist-cards-1440");

      await tick.getByRole("button", { name: "Apply" }).click();
      await slow(tick.getByText("Applied", { exact: true })).toBeVisible();
      expect((await db.query("SELECT done_at FROM hd_ticket_checklist_items WHERE id = $1", [item.id])).rows[0].done_at).not.toBeNull();
      const line = await db.query("SELECT body FROM hd_messages m JOIN hd_tickets t ON t.id = m.ticket_id WHERE t.number = $1 AND m.body LIKE '%ticked%' ORDER BY m.id DESC LIMIT 1", [number]);
      expect(line.rows[0]?.body).toMatch(/ticked "Wipe the laptop" .* via Claude in the desk$/);

      await draft.getByRole("button", { name: "Save as draft" }).click();
      await slow(draft.getByText("Saved as draft", { exact: true })).toBeVisible();
      await expect(draft.getByRole("link", { name: "Review in Checklists" })).toBeVisible();
      const saved = await db.query("SELECT published, draft_via FROM hd_checklist_templates WHERE name = $1", [draftName]);
      expect(saved.rows[0]).toEqual({ published: 0, draft_via: "claude_desk" });
    } finally {
      const list = await api(page, "/api/helpdesk/admin/checklists");
      for (const t of list.body?.templates ?? []) if (String(t.name).includes(stamp)) await api(page, `/api/helpdesk/admin/checklists/${t.id}`, { method: "DELETE" });
    }
  });

  test("macros: Claude proposes a macro, the card says what it will do, Apply applies it through the desk's route", async ({ page, browser }) => {
    test.setTimeout(300_000);
    expect(number, "the c1 test made the ticket").toBeGreaterThan(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    const title = `VPN re-pair ${stamp}`;
    const made = await api(page, "/api/helpdesk/admin/macros", {
      method: "POST",
      body: {
        title,
        body: "Hi {{requester.first_name}}, this is the old sign-in token the VPN client keeps after a phone change. Quit the client, remove the saved account and sign in again. {{agent.first_name}}",
        actions: { priority: "high", tags_add: ["vpn-repair"] },
        team_id: null,
      },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const macroId = made.body.macro.id as number;
    try {
      fake.queue(
        { content: [{ type: "tool_use", name: "propose_macro", input: { number, macro_id: macroId } }] },
        { content: [{ type: "text", text: "The VPN re-pair macro fits this one. Apply it when you're ready." }] }
      );
      await page.goto(`/desk/tickets/${number}`);
      await slow(page.getByRole("button", { name: "Claude", exact: true })).toBeVisible({ timeout: 120_000 });
      await page.keyboard.press("Control+j");
      const panel = page.getByRole("complementary", { name: "Claude" });
      await expect(panel).toBeVisible();
      await slow(panel.getByText("Reply draft for Daniel", { exact: true })).toBeVisible();
      const box = panel.getByLabel("Ask Claude");
      await box.fill("Use our VPN re-pair macro.");
      await expect(box).toHaveValue(/re-pair macro/);
      await box.press("Enter");
      const card = panel.getByRole("region", { name: `Apply the macro "${title}" to #${number}` });
      await slow(card).toBeVisible();
      for (const line of ["Sends this reply to the requester as you", "Sets the priority to High", "Adds the tag vpn-repair"]) {
        await expect(card.getByText(line, { exact: true })).toBeVisible();
      }
      await expect(card.getByLabel("The reply it sends")).toContainText("Hi Daniel, this is the old sign-in token");
      const before = (await db.query("SELECT priority FROM hd_tickets WHERE number = $1", [number])).rows[0].priority;
      expect(before, "nothing changed before Apply").toBe("normal");
      await card.scrollIntoViewIfNeeded();
      await shot(page, "claude-macro-card-1440");

      // At 390 (deviceScaleFactor 2): the panel full screen, the card from the chat's history.
      if (SHOTS) {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, baseURL: test.info().project.use.baseURL });
        const small = await ctx.newPage();
        await login(small, ADMIN);
        await small.goto(`/desk/tickets/${number}`);
        await slow(small.getByRole("button", { name: "Claude", exact: true })).toBeVisible({ timeout: 120_000 });
        await small.keyboard.press("Control+j");
        const smallCard = small.getByRole("complementary", { name: "Claude" }).getByRole("region", { name: `Apply the macro "${title}" to #${number}` });
        await slow(smallCard).toBeVisible();
        await smallCard.scrollIntoViewIfNeeded();
        expect(await small.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await small.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
        await small.screenshot({ path: `${SHOTS}/claude-macro-card-390-light.png` });
        await ctx.close();
      }

      await card.getByRole("button", { name: "Apply" }).dblclick();
      await slow(card.getByText("Applied", { exact: true })).toBeVisible();
      const t = (await db.query("SELECT id, priority, tags FROM hd_tickets WHERE number = $1", [number])).rows[0];
      expect(t.priority).toBe("high");
      expect(t.tags).toContain("vpn-repair");
      const reply = await db.query("SELECT body FROM hd_messages WHERE ticket_id = $1 AND kind = 'public' ORDER BY id DESC LIMIT 1", [t.id]);
      expect(reply.rows[0]?.body).toMatch(/^Hi Daniel, this is the old sign-in token/);
      const line = await db.query("SELECT body FROM hd_messages WHERE ticket_id = $1 AND body LIKE '%priority%' ORDER BY id DESC LIMIT 1", [t.id]);
      expect(line.rows[0]?.body).toMatch(/ via Claude in the desk$/);
      const audit = await db.query("SELECT details FROM audit_log WHERE action = 'helpdesk.macro.applied' AND target_id = $1 ORDER BY id DESC LIMIT 1", [t.id]);
      expect(audit.rows[0]?.details).toMatchObject({ macro_id: macroId, reply: "sent", via: "claude_desk" });
      // A double click applied it once (1.20.15 review: the card is claimed once, Apply is disabled in flight).
      const sentCount = await db.query("SELECT count(*)::int AS n FROM hd_messages WHERE ticket_id = $1 AND kind = 'public' AND body LIKE 'Hi Daniel, this is the old sign-in token%'", [t.id]);
      expect(sentCount.rows[0].n).toBe(1);
      const applies = await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'helpdesk.macro.applied' AND target_id = $1", [t.id]);
      expect(applies.rows[0].n).toBe(1);
    } finally {
      await api(page, `/api/helpdesk/admin/macros/${macroId}`, { method: "DELETE" });
    }
  });
  test("settings drafts: Claude drafts an automation, a schedule and category changes; Save as draft keeps the rule off", async ({ page, browser }) => {
    test.setTimeout(300_000);
    expect(number, "the c1 test made the ticket").toBeGreaterThan(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    const rule = `Printer tickets ${stamp}`;
    const sched = `Printer toner check ${stamp}`;
    const cat = `Printers ${stamp}`;
    try {
      fake.queue(
        {
          content: [
            {
              type: "tool_use",
              name: "draft_automation",
              input: {
                id: 0,
                name: rule,
                event: "ticket_created",
                conditions: { team_ids: [], categories: [], subcategories: [], priorities: [], request_type_ids: [], sources: [], keywords: ["printer", "toner"] },
                actions: { team_id: teamId, assignee_id: 0, priority: "high", status: "", category: "", subcategory: "", tags_add: ["printer"], internal_note: "", macro_id: 0, notify: "" },
              },
            },
            {
              type: "tool_use",
              name: "draft_recurring",
              input: {
                id: 0,
                team_id: teamId,
                subject: `${sched}: {{month}}`,
                body: "Check toner levels on every floor.",
                priority: "normal",
                request_type_id: 0,
                assignee_id: 0,
                due_business_days: 2,
                pattern: { kind: "monthly", time: "09:00", days: [], mode: "nth_weekday", nth: 1, weekday: 1, day: 1, months: [], unit: "weeks", every: 1, start: "2026-01-01" },
                holiday_rule: "next_working_day",
                timezone: "Europe/London",
              },
            },
            { type: "tool_use", name: "draft_categories", input: { changes: [{ kind: "add_category", id: 0, category: "", name: cat, subcategories: ["Toner", "Paper jam"] }] } },
          ],
        },
        { content: [{ type: "text", text: "I drafted a rule, a monthly toner check and a Printers category. Save them as drafts and someone publishes them." }] }
      );
      await page.goto(`/desk/tickets/${number}`);
      await slow(page.getByRole("button", { name: "Claude", exact: true })).toBeVisible({ timeout: 120_000 });
      await page.keyboard.press("Control+j");
      const panel = page.getByRole("complementary", { name: "Claude" });
      await expect(panel).toBeVisible();
      await slow(panel.getByText("Reply draft for Daniel", { exact: true })).toBeVisible();
      const box = panel.getByLabel("Ask Claude");
      await box.fill("Printer tickets keep coming. Set up a rule, a monthly toner check and a category for them.");
      await expect(box).toHaveValue(/Printer tickets/);
      await box.press("Enter");
      const ruleCard = panel.getByRole("region", { name: `Automation draft: ${rule}` });
      const schedCard = panel.getByRole("region", { name: `Recurring ticket draft: ${sched}` });
      const catCard = panel.getByRole("region", { name: "Category change" });
      await slow(ruleCard).toBeVisible();
      await slow(schedCard).toBeVisible();
      await slow(catCard).toBeVisible();
      await expect(ruleCard.getByText("When a ticket is created", { exact: true })).toBeVisible();
      await expect(ruleCard.getByText('If it mentions "printer" or "toner"', { exact: true })).toBeVisible();
      await expect(ruleCard.getByText(/^Then move it to .*, set the priority to High, add the tag printer$/)).toBeVisible();
      await expect(catCard.getByText(`Add the category "${cat}" with Toner, Paper jam`, { exact: true })).toBeVisible();
      await expect(schedCard).toContainText("Due in 2 business days");
      expect((await db.query("SELECT 1 FROM hd_automations WHERE name = $1", [rule])).rowCount, "nothing saved before Save as draft").toBe(0);
      await ruleCard.scrollIntoViewIfNeeded();
      await shot(page, "claude-settings-draft-cards-1440");
      if (SHOTS) {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, baseURL: test.info().project.use.baseURL });
        const small = await ctx.newPage();
        await login(small, ADMIN);
        await small.goto(`/desk/tickets/${number}`);
        await slow(small.getByRole("button", { name: "Claude", exact: true })).toBeVisible({ timeout: 120_000 });
        await small.keyboard.press("Control+j");
        const smallCard = small.getByRole("complementary", { name: "Claude" }).getByRole("region", { name: `Automation draft: ${rule}` });
        await slow(smallCard).toBeVisible();
        await smallCard.scrollIntoViewIfNeeded();
        expect(await small.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await small.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
        await small.screenshot({ path: `${SHOTS}/claude-settings-draft-cards-390-light.png` });
        await ctx.close();
      }

      await ruleCard.getByRole("button", { name: "Save as draft" }).click();
      await slow(ruleCard.getByText("Saved as draft", { exact: true })).toBeVisible();
      await expect(ruleCard.getByRole("link", { name: "Review in Automations" })).toBeVisible();
      const row = (await db.query("SELECT id, active, published, draft_via FROM hd_automations WHERE name = $1", [rule])).rows[0];
      expect({ active: row.active, published: row.published, draft_via: row.draft_via }).toEqual({ active: 0, published: 0, draft_via: "claude_desk" });
      await schedCard.getByRole("button", { name: "Skip" }).click();
      await slow(schedCard.getByText("Skipped", { exact: true })).toBeVisible();
      await catCard.getByRole("button", { name: "Skip" }).click();
      expect((await db.query("SELECT 1 FROM hd_recurring WHERE subject LIKE $1", [`${sched}%`])).rowCount).toBe(0);

      // The review in Desk settings: off, Draft from Claude, Publish switches it on.
      await page.goto(`/desk/settings/automations?id=${row.id}`);
      const dialog = page.getByRole("dialog");
      await slow(dialog.getByRole("region", { name: "Draft from Claude" })).toBeVisible({ timeout: 60_000 });
      await expect(dialog.getByRole("button", { name: "Publish rule" })).toBeVisible();
      await dialog.getByRole("button", { name: "Close" }).click();
      const listRow = page.getByRole("listitem").filter({ hasText: rule });
      await expect(listRow.getByText("Draft from Claude", { exact: true })).toBeVisible();
      await expect(listRow.getByRole("button", { name: /^Turn on/ })).toHaveCount(0);
    } finally {
      await db.query("DELETE FROM hd_automations WHERE name = $1", [rule]);
      await db.query("DELETE FROM hd_recurring WHERE subject LIKE $1", [`${sched}%`]);
      await db.query("DELETE FROM hd_category_draft WHERE changes::text LIKE $1", [`%${stamp}%`]);
    }
  });
});
