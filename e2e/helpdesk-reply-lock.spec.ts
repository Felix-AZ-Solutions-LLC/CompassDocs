import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, api, ensureUser, login } from "./helpers";

// The reply lock (1.20.20, lib/helpdesk/reply-lock). Licensed only (the EE
// rig); skips itself on 402. Three people, each in a browser of their own:
//   Sam (Agent)        starts a reply and so holds the ticket's reply
//   Ana (Agent)        sees the read-only Reply box with Sam's avatar and its
//                      "Sam Lee · replying since …" tooltip, the badge on the
//                      queue row and in the header; adds an internal note;
//                      her box unlocks once Sam has sent
//   Priya (Team lead)  takes over Sam's next reply after confirming; Sam sees
//                      "Priya took over this reply. Your text is kept as a
//                      draft." with his text still in the box
//   the admin          releases all of Priya's locks in Desk settings →
//                      Reply lock; Sam's box unlocks with his text
//   pop-out (1.20.18)  Sam starts again and pops the reply out: the lock moves
//                      to the pop-out's tab (Ana still sees Sam replying while
//                      he writes there), and Bring back moves it home
// Reply locks are switched on for the run and off again afterwards (the
// shared database's upgrade default); everything else is stamped and
// removed. E2E_SHOTS_DIR (optional) keeps screenshots: 1440 light and dark,
// and 390 light, at device scale 2.

// Its own accounts: other specs add and remove e2e_hd_sam as an agent, and may run at the same time on the shared rig.
const SAM = { username: "e2e_hd_rl_sam", password: "E2eSamLee!12345" };
const ANA = { username: "e2e_hd_rl_ana", password: "E2eAnaKowalski!12345" };
const PRIYA = { username: "e2e_hd_rl_priya", password: "E2ePriyaLead!12345" };
const SHOTS = process.env.E2E_SHOTS_DIR;
const see = expect.configure({ timeout: 30_000 });
const DB = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e";

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/counts")).status !== 402;
}

async function shot(page: Page, name: string, opts: { hover?: () => Promise<void>; phone?: boolean } = {}) {
  if (!SHOTS) return;
  // The dev server's own issues badge is not the page.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  const settle = async () => {
    if (opts.hover) await opts.hover();
    await page.waitForTimeout(300);
  };
  await settle();
  await page.screenshot({ path: `${SHOTS}/${name}-1440-light.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await settle();
  await page.screenshot({ path: `${SHOTS}/${name}-1440-dark.png` });
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await page.emulateMedia({ colorScheme: "light" });
  if (opts.phone !== false) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await settle();
    await page.screenshot({ path: `${SHOTS}/${name}-390-light.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
  }
}

async function browserFor(browser: Browser, who: { username: string; password: string }): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  await login(page, who);
  return { ctx, page };
}

test.describe("reply lock (licensed)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  const stamp = Date.now().toString(36);
  let teamId = 0;
  const ticketNumbers: number[] = [];
  const agentIds: number[] = [];

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    await api(page, "/api/helpdesk/admin/reply-lock", { method: "PUT", body: { enabled: false, idle_minutes: 2 } });
    for (const n of ticketNumbers) await api(page, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
    for (const id of agentIds) await api(page, `/api/helpdesk/admin/agents/${id}`, { method: "DELETE" });
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await page.close();
  });

  test("one agent replies at a time; others see who, can add notes, and a lead can take over", async ({ page, browser }) => {
    test.setTimeout(480_000);
    const before = await api(page, "/api/helpdesk/admin/reply-lock");
    expect(before.status).toBe(200);
    const on = await api(page, "/api/helpdesk/admin/reply-lock", { method: "PUT", body: { enabled: true, idle_minutes: 2 } });
    expect(on.status).toBe(200);
    expect(on.body.settings.enabled).toBe(true);

    await ensureUser(page, SAM, "viewer", "Sam Lee");
    await ensureUser(page, ANA, "viewer", "Ana Kowalski");
    await ensureUser(page, PRIYA, "viewer", "Priya Natarajan");
    const users = (await api(page, "/api/users/mentionable")).body.users as { id: number; username: string }[];
    const idOf = (u: string) => users.find((x) => x.username === u)!.id;
    const myId = idOf(ADMIN.username);
    const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `E2E Reply lock ${stamp}`, icon: "monitor", members: [{ user_id: myId, role: "lead" }] } });
    expect(team.status).toBe(201);
    teamId = team.body.team.id;
    for (const [u, role] of [[SAM.username, "agent"], [ANA.username, "agent"], [PRIYA.username, "team_lead"]] as const) {
      const id = idOf(u);
      agentIds.push(id);
      await api(page, `/api/helpdesk/admin/agents/${id}`, { method: "DELETE" });
      const added = await api(page, "/api/helpdesk/admin/agents", { method: "POST", body: { user_id: id, role, team_ids: [teamId] } });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
    }
    const subject = `VPN drops every ten minutes ${stamp}`;
    const created = await api(page, "/api/helpdesk/tickets", {
      method: "POST",
      body: { subject, body: "Since the update this morning the VPN drops every ten minutes, at home and in the office.", team_id: teamId, priority: "high", requester_id: myId },
    });
    expect(created.status).toBe(201);
    const n = created.body.ticket.number as number;
    ticketNumbers.push(n);
    // A second ticket, so the queue has a row without a badge beside the locked one.
    const other = await api(page, "/api/helpdesk/tickets", {
      method: "POST",
      body: { subject: `New starter needs a laptop ${stamp}`, body: "Starts on Monday.", team_id: teamId, priority: "normal", requester_id: myId },
    });
    ticketNumbers.push(other.body.ticket.number);
    const url = `/desk/tickets/${n}?team=${teamId}`;

    // Read only: which browser tab holds the lock (the pop-out steps).
    const db = new Client({ connectionString: DB });
    await db.connect();
    const sam = await browserFor(browser, SAM);
    const ana = await browserFor(browser, ANA);
    const priya = await browserFor(browser, PRIYA);
    try {
      // Sam starts a reply: he holds it.
      await sam.page.goto(url);
      await see(sam.page.getByRole("heading", { level: 2, name: new RegExp(subject) })).toBeVisible({ timeout: 90_000 });
      const samBox = sam.page.getByRole("textbox", { name: "Reply" });
      await samBox.click();
      await samBox.pressSequentially("Hi, I've pushed a new VPN profile to your laptop. ", { delay: 5 });
      await see(sam.page.getByTestId("reply-lock-mine")).toContainText("Others see you're replying.");

      // Ana opens it: read-only, with Sam's avatar and the tooltip.
      await ana.page.goto(url);
      await see(ana.page.getByRole("heading", { level: 2, name: new RegExp(subject) })).toBeVisible({ timeout: 90_000 });
      const bar = ana.page.getByTestId("reply-lock-bar");
      await see(bar).toContainText("Sam Lee is replying.");
      await see(bar).toContainText("You can add an internal note meanwhile.");
      const avatar = bar.getByTestId("reply-lock-avatar");
      await see(avatar).toHaveAttribute("data-tt", /^Sam Lee · replying since \d{1,2}:\d{2}/);
      await see(avatar).toHaveAttribute("aria-label", /^Sam Lee is replying, since /);
      await expect(bar.getByRole("button", { name: "Take over" })).toHaveCount(0);
      const anaBox = ana.page.getByRole("textbox", { name: "Reply" });
      await see(anaBox).toHaveAttribute("readonly", "");
      await see(ana.page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
      // The header strip and the queue row show him too.
      await see(ana.page.getByTestId("ticket-presence")).toContainText("Sam Lee is replying");
      await see(ana.page.getByTestId("ticket-presence").getByTestId("reply-lock-avatar")).toBeVisible();
      const row = ana.page.locator(`li[data-number="${n}"]`);
      await see(row.getByTestId("reply-lock-badge")).toBeVisible();
      await see(row.getByTestId("reply-lock-avatar")).toHaveAttribute("data-tt", /^Sam Lee · replying since/);
      await expect(ana.page.locator(`li[data-number="${other.body.ticket.number}"]`).getByTestId("reply-lock-badge")).toHaveCount(0);
      await avatar.focus();
      await shot(ana.page, "locked-composer", { hover: () => avatar.hover() });
      await avatar.blur();
      await shot(ana.page, "queue-badge", { hover: () => row.getByTestId("reply-lock-avatar").hover(), phone: false });

      // Ana adds an internal note: notes are never locked.
      await ana.page.getByRole("radio", { name: "Internal note" }).click();
      const note = ana.page.getByRole("textbox", { name: "Internal note" });
      await note.fill("Same drop pattern as last week's ticket; the profile fix worked there.");
      await ana.page.getByRole("button", { name: "Add note", exact: true }).click();
      await see(ana.page.getByText("Note added.")).toBeVisible();
      await ana.page.getByRole("radio", { name: /^Reply/ }).click();

      // Sam sends: Ana's box unlocks.
      await samBox.pressSequentially("Restart once and it should hold.", { delay: 5 });
      await sam.page.getByRole("button", { name: "Send", exact: true }).click();
      // The 1.19.1 send guard still tells him about Ana's note first; he has read it, so he sends anyway.
      const guard = sam.page.getByRole("dialog", { name: "Ana Kowalski added a note while you were typing" });
      await see(guard).toBeVisible({ timeout: 60_000 });
      await guard.getByRole("button", { name: "Send anyway" }).click();
      await see(sam.page.getByText("Reply sent.")).toBeVisible({ timeout: 60_000 });
      await see(ana.page.getByTestId("reply-lock-bar")).toHaveCount(0, { timeout: 30_000 });
      await see(ana.page.getByRole("textbox", { name: "Reply" })).not.toHaveAttribute("readonly", "");
      await see(row.getByTestId("reply-lock-badge")).toHaveCount(0, { timeout: 30_000 });

      // Sam starts the next reply; Priya (Team lead) takes it over.
      const samText = "Following up: did the restart fix it? If not, ";
      await samBox.click();
      await samBox.pressSequentially(samText, { delay: 5 });
      await see(sam.page.getByTestId("reply-lock-mine")).toBeVisible();
      await priya.page.goto(url);
      await see(priya.page.getByRole("heading", { level: 2, name: new RegExp(subject) })).toBeVisible({ timeout: 90_000 });
      const pBar = priya.page.getByTestId("reply-lock-bar");
      await see(pBar).toContainText("Sam Lee is replying.");
      await pBar.getByRole("button", { name: "Take over" }).click();
      const confirm = priya.page.getByRole("dialog", { name: "Take over Sam Lee's reply?" });
      await see(confirm).toBeVisible();
      await see(confirm).toContainText("they keep it as a draft");
      await shot(priya.page, "takeover-confirm");
      await confirm.getByRole("button", { name: "Take over" }).click();
      await see(priya.page.getByText(/You have the reply now/)).toBeVisible();
      await see(priya.page.getByTestId("reply-lock-mine")).toBeVisible();
      await see(priya.page.getByRole("textbox", { name: "Reply" })).not.toHaveAttribute("readonly", "");

      // Sam is told, and keeps his text (read-only, with Copy).
      const taken = sam.page.getByTestId("reply-lock-taken");
      await see(taken).toContainText("Priya took over this reply. Your text is kept as a draft.", { timeout: 30_000 });
      await see(taken.getByRole("button", { name: "Copy my text" })).toBeVisible();
      await see(samBox).toHaveValue(samText);
      await see(samBox).toHaveAttribute("readonly", "");
      await see(sam.page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
      await shot(sam.page, "takeover-notice", { hover: () => taken.getByTestId("reply-lock-avatar").hover() });

      // 1.20.20 review: Desk settings → Reply lock lists who holds what; the admin releases all of Priya's locks.
      await page.goto("/desk/settings/reply-lock");
      const now = page.locator("#reply-lock-now");
      await see(now.getByRole("link", { name: new RegExp(`#${n} ${subject}`) })).toBeVisible({ timeout: 60_000 });
      await now.getByRole("button", { name: "Release all of Priya Natarajan's locks" }).click();
      const sure = page.getByRole("dialog", { name: "Release all of Priya Natarajan's locks?" });
      await see(sure).toBeVisible();
      await sure.getByRole("button", { name: "Release all" }).click();
      await see(page.getByText(/^Released (one lock|\d+ locks)\.$/)).toBeVisible();
      await see(now.getByRole("link", { name: new RegExp(`#${n} ${subject}`) })).toHaveCount(0);
      // Sam's box unlocks with his text still in it.
      await see(sam.page.getByTestId("reply-lock-taken")).toHaveCount(0, { timeout: 30_000 });
      await see(samBox).not.toHaveAttribute("readonly", "");
      await see(samBox).toHaveValue(samText);

      // 1.20.20 with 1.20.18: the lock goes into the pop-out with the reply and comes back with it. The lock row's tab
      // says which window holds it; Ana sees Sam replying all along.
      const tabOf = async () =>
        (await db.query("SELECT l.tab_id FROM hd_reply_locks l JOIN hd_tickets t ON t.id = l.ticket_id WHERE t.number = $1", [n])).rows[0]?.tab_id as string | undefined;
      await samBox.click();
      await samBox.press("End");
      await samBox.pressSequentially("let me know ", { delay: 5 });
      await see(sam.page.getByTestId("reply-lock-mine")).toBeVisible();
      await see.poll(tabOf, { timeout: 30_000 }).toBeTruthy();
      const paneTab = await tabOf();
      await see(ana.page.getByTestId("reply-lock-bar")).toContainText("Sam Lee is replying.", { timeout: 30_000 });
      const [pop] = await Promise.all([sam.page.waitForEvent("popup", { timeout: 30_000 }), sam.page.getByRole("button", { name: "Pop out the reply" }).click()]);
      await pop.waitForLoadState("domcontentloaded");
      const popBox = pop.getByRole("textbox", { name: "Reply" });
      await see(popBox).toHaveValue(/let me know/, { timeout: 90_000 });
      await see.poll(tabOf, { timeout: 30_000 }).not.toBe(paneTab);
      const popTab = await tabOf();
      expect(popTab).toBeTruthy();
      await popBox.click();
      await popBox.press("End");
      await popBox.pressSequentially("and we'll look again.", { delay: 5 });
      // Past the pane's release delay and a few polls: the pane released nothing, and the pop-out's heartbeat keeps it.
      await pop.waitForTimeout(6_000);
      expect(await tabOf()).toBe(popTab);
      await see(pop.getByTestId("reply-lock-mine")).toBeVisible();
      await see(ana.page.getByTestId("reply-lock-bar")).toContainText("Sam Lee is replying.");
      await see(ana.page.getByRole("textbox", { name: "Reply" })).toHaveAttribute("readonly", "");
      // Bring it back: the text and the lock come home to the pane's tab.
      await sam.page.getByRole("button", { name: "Bring back" }).click();
      await see(sam.page.getByRole("textbox", { name: "Reply" })).toHaveValue(/and we'll look again\./, { timeout: 30_000 });
      await see.poll(tabOf, { timeout: 30_000 }).toBe(paneTab);
      await see(sam.page.getByTestId("reply-lock-mine")).toBeVisible();
      await see(ana.page.getByTestId("reply-lock-bar")).toContainText("Sam Lee is replying.");

    } finally {
      for (const b of [sam, ana, priya]) await b.ctx.close();
      await db.end();
    }
  });
});
