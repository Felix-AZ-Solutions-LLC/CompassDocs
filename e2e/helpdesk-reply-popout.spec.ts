import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { ADMIN, api, ensureUser, login } from "./helpers";

// The reply pop-out (1.20.18): the composer's Pop out opens the reply in a
// window of its own (/desk/tickets/[number]/reply). Licensed only (the EE
// rig); skips itself on 402.
//   carry over   typed text, the attachment already uploaded and the CC go
//                with it; the URL carries no text; the pane shows "Replying
//                in another window"; Send there closes the window, the pane's
//                conversation shows the reply and its composer is empty
//   hand back    an internal note popped out with Shift+O, then the window
//                closed unsent: the pane gets the note back; a second pop-out
//                for the same ticket finds the first; a blocked popup says so
//   note, solve  an internal note sent from the pop-out; "Send and set
//                Solved" there still asks "Before you solve"
//   collision    Sam sees "is replying" while the admin types in the pop-out,
//                Sam replies first, and the pop-out's Send shows the
//                collision dialog
//   mid-send     (security review) Bring back while the pop-out's send is on
//                its way: the pane says "Still sending in the other window"
//                and the reply goes out once; the pop-out closed after the
//                server took the send: the pane says "This reply was sent"
//                and gives nothing back to send twice
//   sign-out     signing out of the desk closes the pop-out and leaves no desk
//                draft or hand-off in the browser
//   taken back   a pop-out that doesn't answer is never taken over silently:
//                the pane asks, "Take it back" brings the text home, and the
//                pop-out, awake again, is read-only
// Everything is stamped and removed afterwards. E2E_SHOTS_DIR (optional)
// keeps screenshots: the pane at 1440 and the pop-out at its own size,
// light and dark.

const SAM = { username: "e2e_hd_sam", password: "E2eSamLee!12345" };
const SHOTS = process.env.E2E_SHOTS_DIR;
const see = expect.configure({ timeout: 45_000 });
const POP = { width: 720, height: 780 };

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/counts")).status !== 402;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  // The dev server's own issue badge is not part of the page.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" }).catch(() => {});
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}-light.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/${name}-dark.png` });
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await page.emulateMedia({ colorScheme: "light" });
}

/** Click Pop out (or press Shift+O) and take the window it opens. */
async function popOut(page: Page, how: "click" | "key" = "click"): Promise<Page> {
  const [pop] = await Promise.all([
    page.waitForEvent("popup", { timeout: 30_000 }),
    how === "click" ? page.getByRole("button", { name: "Pop out the reply" }).click() : page.keyboard.press("Shift+O"),
  ]);
  await pop.setViewportSize(POP);
  await pop.waitForLoadState("domcontentloaded");
  return pop;
}

test.describe("reply pop-out (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ viewport: { width: 1440, height: 900 } });
  const stamp = Date.now().toString(36);
  let teamId = 0;
  let myId = 0;
  let samId = 0;
  let setId = 0;
  const tickets: number[] = [];

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    if (teamId) return;
    const users = (await api(page, "/api/users/mentionable")).body.users as { id: number; username: string }[];
    myId = users.find((u) => u.username === ADMIN.username)!.id;
    await ensureUser(page, SAM, "viewer", "Sam Lee");
    samId = ((await api(page, "/api/users/mentionable")).body.users as { id: number; username: string }[]).find((u) => u.username === SAM.username)!.id;
    const team = await api(page, "/api/helpdesk/admin/teams", {
      method: "POST",
      body: { name: `E2E Pop-out ${stamp}`, icon: "monitor", members: [{ user_id: myId, role: "lead" }] },
    });
    expect(team.status, JSON.stringify(team.body)).toBe(201);
    teamId = team.body.team.id;
    await api(page, `/api/helpdesk/admin/agents/${samId}`, { method: "DELETE" });
    const added = await api(page, "/api/helpdesk/admin/agents", { method: "POST", body: { user_id: samId, role: "agent", team_ids: [teamId] } });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    if (setId) await api(page, `/api/helpdesk/admin/solve-requirements/${setId}`, { method: "DELETE" });
    for (const n of tickets) await api(page, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
    if (samId) await api(page, `/api/helpdesk/admin/agents/${samId}`, { method: "DELETE" });
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await page.close();
  });

  async function newTicket(page: Page, subject: string): Promise<number> {
    const t = await api(page, "/api/helpdesk/tickets", {
      method: "POST",
      body: { subject: `${subject} ${stamp}`, body: "Since this morning the VPN client says Authentication failed.", team_id: teamId, priority: "normal", requester_id: myId },
    });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    tickets.push(t.body.ticket.number);
    return t.body.ticket.number as number;
  }

  async function openTicket(page: Page, n: number) {
    await page.goto(`/desk/tickets/${n}?team=${teamId}`);
    await see(page.getByRole("textbox", { name: "Reply", exact: true }).or(page.getByRole("textbox", { name: "Internal note", exact: true }))).toBeVisible({ timeout: 120_000 });
  }

  /** Type into a box until the busy dev rig has hydrated it. */
  async function type(box: ReturnType<Page["getByRole"]>, text: string) {
    await expect(async () => {
      await box.fill(text);
      await expect(box).toHaveValue(text, { timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
  }

  const messages = async (page: Page, n: number) => (await api(page, `/api/helpdesk/tickets/${n}`)).body.messages as { kind: string; body: string }[];

  test("the typed reply, its file and its CC go with it; sent there, the pane shows it and starts empty", async ({ page }) => {
    test.setTimeout(420_000);
    const n = await newTicket(page, "Laptop won't connect from home");
    const cc = await api(page, `/api/helpdesk/tickets/${n}/ccs`, { method: "POST", body: { people: [{ user_id: samId }] } });
    expect(cc.status, JSON.stringify(cc.body)).toBe(200);
    await openTicket(page, n);
    const box = page.getByRole("textbox", { name: "Reply", exact: true });
    const TEXT = `I've renewed the VPN profile on your laptop. Please try again. ${stamp}`;
    await type(box, TEXT);
    await page.locator('section[aria-label="Reply"] input[type="file"]').setInputFiles({ name: "vpn-log.txt", mimeType: "text/plain", buffer: Buffer.from("auth failed 08:14\n") });
    // An upload on the busy dev rig can take a while.
    await see(page.getByRole("list", { name: "Attachments" })).toContainText("vpn-log.txt", { timeout: 120_000 });
    await see(page.getByRole("button", { name: "Pop out the reply" })).toBeVisible();
    await shot(page, "pane-popout-control-1440");

    const pop = await popOut(page);
    expect(pop.url()).toMatch(new RegExp(`/desk/tickets/${n}/reply$`));
    expect(pop.url()).not.toContain("VPN");
    const popBox = pop.getByRole("textbox", { name: "Reply", exact: true });
    await see(popBox).toHaveValue(TEXT, { timeout: 120_000 });
    await see(pop.getByRole("list", { name: "Attachments" })).toContainText("vpn-log.txt");
    await see(pop.getByRole("group", { name: "CC" })).toContainText("Sam Lee");
    await see(pop.getByRole("heading", { level: 2, name: new RegExp(`Laptop won't connect from home ${stamp}`) })).toBeVisible();
    await see(pop.getByRole("radio", { name: /Reply to/ })).toBeChecked();
    // No top bar or rail in the window.
    await expect(pop.getByRole("navigation", { name: "Desk" })).toHaveCount(0);

    // The pane: one quiet line, no second box to send from.
    await see(page.getByTestId("reply-elsewhere")).toContainText("Replying in another window");
    await expect(page.getByRole("textbox", { name: "Reply", exact: true })).toHaveCount(0);
    await shot(page, "pane-replying-elsewhere-1440");
    await shot(pop, "popout-720");

    // The agent can keep using the desk meanwhile: the queue is still there.
    await expect(page.getByRole("navigation", { name: "Desk" })).toBeVisible();

    const closed = pop.waitForEvent("close", { timeout: 120_000 });
    await pop.getByRole("button", { name: "Send", exact: true }).click();
    await closed;
    await see(page.getByText(`Reply sent on #${n}.`)).toBeVisible();
    await see(page.getByRole("list", { name: "Conversation" }).getByText(TEXT)).toBeVisible({ timeout: 60_000 });
    await see(page.getByRole("textbox", { name: "Reply", exact: true })).toHaveValue("");
    await expect(page.getByTestId("reply-elsewhere")).toHaveCount(0);
    const sent = (await messages(page, n)).filter((m) => m.kind === "public" && m.body === TEXT);
    expect(sent).toHaveLength(1);

    // A phone gets no Pop out: a new window makes no sense there.
    await page.setViewportSize({ width: 390, height: 844 });
    await see(page.getByRole("textbox", { name: "Reply", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pop out the reply" })).toBeHidden();
  });

  test("closed unsent, the note comes back; a second pop-out finds the first; a blocked window says so", async ({ page, context }) => {
    test.setTimeout(420_000);
    const n = await newTicket(page, "Printer on floor 3 jams");
    await openTicket(page, n);

    // A blocked popup: a plain message, and the composer stays.
    await page.evaluate(() => {
      (window as unknown as { __open: typeof window.open }).__open = window.open;
      window.open = () => null;
    });
    await type(page.getByRole("textbox", { name: "Reply", exact: true }), "Checking the tray now.");
    await page.getByRole("button", { name: "Pop out the reply" }).click();
    await see(page.getByText("Your browser blocked the new window. Allow pop-ups for this site, then try again.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Reply", exact: true })).toHaveValue("Checking the tray now.");
    await page.evaluate(() => {
      window.open = (window as unknown as { __open: typeof window.open }).__open;
    });

    // An internal note, popped out with Shift+O from the page.
    await page.getByRole("radio", { name: "Internal note" }).click();
    const NOTE = `Tray 2 roller looks worn; parts ordered. ${stamp}`;
    await type(page.getByRole("textbox", { name: "Internal note", exact: true }), NOTE);
    await page.getByRole("heading", { level: 2, name: new RegExp(`Printer on floor 3 jams ${stamp}`) }).click();
    const pop = await popOut(page, "key");
    await see(pop.getByRole("textbox", { name: "Internal note", exact: true })).toHaveValue(NOTE, { timeout: 120_000 });
    await see(page.getByTestId("reply-elsewhere")).toBeVisible();

    // A second pop-out for the same ticket: Shift+O and Show window bring the first forward; no new window.
    let extra = 0;
    const count = () => extra++;
    context.on("page", count);
    await page.getByRole("heading", { level: 2, name: new RegExp(`Printer on floor 3 jams ${stamp}`) }).click();
    await page.keyboard.press("Shift+O");
    await page.getByRole("button", { name: "Show window" }).click();
    await page.waitForTimeout(1_500);
    context.off("page", count);
    expect(extra).toBe(0);
    // Opened by hand in another tab, the address refuses to start a second reply.
    const other = await context.newPage();
    await other.goto(`/desk/tickets/${n}/reply`);
    await see(other.getByText("This reply is already open in another window")).toBeVisible({ timeout: 120_000 });
    await expect(other.getByRole("textbox", { name: "Internal note" })).toHaveCount(0);
    await other.close();

    // Closed without sending: the pane gets the note back, still a note.
    await pop.close({ runBeforeUnload: true });
    await see(page.getByRole("textbox", { name: "Internal note", exact: true })).toHaveValue(NOTE, { timeout: 30_000 });
    await see(page.getByRole("radio", { name: "Internal note" })).toBeChecked();
    expect((await messages(page, n)).some((m) => m.body === NOTE)).toBe(false);

    // Bring back works too.
    const again = await popOut(page);
    await see(again.getByRole("textbox", { name: "Internal note", exact: true })).toHaveValue(NOTE, { timeout: 120_000 });
    const gone = again.waitForEvent("close", { timeout: 30_000 });
    await page.getByRole("button", { name: "Bring back" }).click();
    await gone;
    await see(page.getByRole("textbox", { name: "Internal note", exact: true })).toHaveValue(NOTE, { timeout: 30_000 });
  });

  test("an internal note from the pop-out; Send and set Solved there still asks Before you solve", async ({ page }) => {
    test.setTimeout(480_000);
    // A requirement set for this run's team only: one closing field.
    const made = await api(page, "/api/helpdesk/admin/solve-requirements", { method: "POST", body: { name: `Pop-out closing ${stamp}` } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    setId = made.body.set.id;
    const put = await api(page, `/api/helpdesk/admin/solve-requirements/${setId}`, {
      method: "PUT",
      body: { enabled: true, team_ids: [teamId], ticket_fields: [], fields: [{ key: "root_cause", label: "Root cause", type: "textarea", required: true }] },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    const n = await newTicket(page, "Shared drive is read-only");
    await openTicket(page, n);
    const pop = await popOut(page);
    await see(pop.getByRole("textbox", { name: "Reply", exact: true })).toBeVisible({ timeout: 120_000 });
    await pop.getByRole("radio", { name: "Internal note" }).click();
    const NOTE = `Checked the share permissions: the group lost write access. ${stamp}`;
    await type(pop.getByRole("textbox", { name: "Internal note", exact: true }), NOTE);
    const closed = pop.waitForEvent("close", { timeout: 120_000 });
    await pop.getByRole("button", { name: "Add note", exact: true }).click();
    await closed;
    await see(page.getByRole("list", { name: "Conversation" }).getByText(NOTE)).toBeVisible({ timeout: 60_000 });
    expect((await messages(page, n)).filter((m) => m.kind === "internal" && m.body === NOTE)).toHaveLength(1);

    // Pop out again, write the answer and solve with it.
    await see(page.getByRole("textbox", { name: "Reply", exact: true }).or(page.getByRole("textbox", { name: "Internal note", exact: true }))).toBeVisible();
    const solve = await popOut(page);
    await see(solve.getByRole("radio", { name: "Internal note" })).toBeVisible({ timeout: 120_000 });
    await solve.getByRole("radio", { name: /Reply to/ }).click();
    const REPLY = `Write access is back on the shared drive. ${stamp}`;
    await type(solve.getByRole("textbox", { name: "Reply", exact: true }), REPLY);
    await solve.getByRole("button", { name: "Send and set the status" }).click();
    await solve.getByRole("menuitem", { name: "Send and set Solved" }).click();
    const dialog = solve.getByRole("dialog", { name: `Before you solve #${n}` });
    await see(dialog).toBeVisible({ timeout: 60_000 });
    await see(dialog.getByRole("textbox", { name: "Root cause" })).toBeVisible();
    // Cancelled: nothing sent, the text stays.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(solve.getByRole("textbox", { name: "Reply", exact: true })).toHaveValue(REPLY);
    expect((await messages(page, n)).some((m) => m.body === REPLY)).toBe(false);
    await solve.getByRole("button", { name: "Send and set the status" }).click();
    await solve.getByRole("menuitem", { name: "Send and set Solved" }).click();
    await see(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Root cause" }).fill("The group's write permission was removed by a cleanup script.");
    const closedSolve = solve.waitForEvent("close", { timeout: 120_000 });
    await dialog.getByRole("button", { name: "Send and solve" }).click();
    await closedSolve;
    const after = (await api(page, `/api/helpdesk/tickets/${n}`)).body;
    expect(after.ticket.status).toBe("solved");
    expect(after.messages.filter((m: { kind: string; body: string }) => m.kind === "public" && m.body === REPLY)).toHaveLength(1);
    // The set off again at once: no other run's tickets are ever asked.
    await api(page, `/api/helpdesk/admin/solve-requirements/${setId}`, { method: "DELETE" });
    setId = 0;
  });

  test("presence and the send guard work from the pop-out", async ({ page, browser }) => {
    test.setTimeout(420_000);
    const n = await newTicket(page, "Can't open the payroll report");
    let samCtx: BrowserContext | null = null;
    try {
      samCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const sam = await samCtx.newPage();
      await login(sam, SAM);
      await sam.goto(`/desk/tickets/${n}?team=${teamId}`);
      await see(sam.getByRole("textbox", { name: "Reply", exact: true })).toBeVisible({ timeout: 120_000 });

      await openTicket(page, n);
      const pop = await popOut(page);
      const popBox = pop.getByRole("textbox", { name: "Reply", exact: true });
      await see(popBox).toBeVisible({ timeout: 120_000 });
      // Sam is here: the pop-out shows it.
      await see(pop.getByTestId("ticket-presence")).toContainText("Sam Lee is viewing", { timeout: 60_000 });
      await popBox.click();
      await popBox.pressSequentially("Could you send a screenshot of the error?", { delay: 5 });
      // Sam sees the admin replying, and it stays "replying" (the pane's own heartbeat agrees).
      const samSees = sam.getByTestId("ticket-presence");
      await see(samSees).toContainText("is replying", { timeout: 45_000 });
      // Keep typing across several heartbeats of both admin windows: the desk pane's own beat
      // never flips it back to "viewing" while the reply is being written in the pop-out.
      const seen: string[] = [];
      for (let i = 0; i < 16; i++) {
        await popBox.press("End");
        await popBox.pressSequentially(".", { delay: 5 });
        await sam.waitForTimeout(1_500);
        seen.push((await samSees.textContent()) ?? "");
      }
      expect(seen.filter((x) => x.includes("is viewing")), seen.join(" | ")).toEqual([]);

      // Sam replies first.
      const samBox = sam.getByRole("textbox", { name: "Reply", exact: true });
      await type(samBox, `I've reset your report permissions. ${stamp}`);
      await sam.getByRole("button", { name: "Send", exact: true }).click();
      await see(sam.getByText("Reply sent.")).toBeVisible({ timeout: 60_000 });

      const posted: number[] = [];
      pop.on("response", (r) => {
        if (r.url().endsWith(`/api/helpdesk/tickets/${n}/messages`) && r.request().method() === "POST") posted.push(r.status());
      });
      await pop.getByRole("button", { name: "Send", exact: true }).click();
      const dialog = pop.getByRole("dialog", { name: "Sam Lee replied while you were typing" });
      await see(dialog).toBeVisible({ timeout: 60_000 });
      await see(dialog).toContainText("I've reset your report permissions.");
      await see.poll(() => posted, { timeout: 60_000 }).toEqual([409]);
      await shot(pop, "popout-collision-720");
      await dialog.getByRole("button", { name: "Keep editing" }).click();
      await expect(popBox).toHaveValue(/^Could you send a screenshot of the error\?\.+$/);
      const closed = pop.waitForEvent("close", { timeout: 120_000 });
      await pop.getByRole("button", { name: "Send", exact: true }).click();
      await closed;
      expect(posted).toEqual([409, 201]);
      await see(page.getByRole("list", { name: "Conversation" }).getByText("Could you send a screenshot of the error?")).toBeVisible({ timeout: 60_000 });
    } finally {
      await samCtx?.close();
    }
  });

  test("mid-send: Bring back waits for the send; closed after the server took it, nothing comes back to send twice", async ({ page }) => {
    test.setTimeout(420_000);
    const n = await newTicket(page, "Teams calls drop after a minute");
    await openTicket(page, n);
    const url = `**/api/helpdesk/tickets/${n}/messages`;

    // A: the send is held on its way; Bring back is refused with "Still sending".
    const A = `I've reset your Teams client cache. Please try a call now. ${stamp}`;
    await type(page.getByRole("textbox", { name: "Reply", exact: true }), A);
    const pop = await popOut(page);
    await see(pop.getByRole("textbox", { name: "Reply", exact: true })).toHaveValue(A, { timeout: 120_000 });
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const isHeld = new Promise<void>((r) => (held = r));
    await pop.route(url, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      held();
      await released;
      await route.continue();
    });
    await pop.getByRole("button", { name: "Send", exact: true }).click();
    await isHeld;
    await page.getByRole("button", { name: "Bring back" }).click();
    await see(page.getByTestId("reply-elsewhere")).toContainText("Still sending in the other window");
    await expect(page.getByRole("textbox", { name: "Reply", exact: true })).toHaveCount(0);
    const closed = pop.waitForEvent("close", { timeout: 120_000 });
    release();
    await closed;
    await see(page.getByRole("list", { name: "Conversation" }).getByText(A)).toBeVisible({ timeout: 60_000 });
    await see(page.getByRole("textbox", { name: "Reply", exact: true })).toHaveValue("");
    expect((await messages(page, n)).filter((m) => m.body === A)).toHaveLength(1);

    // B: the server took the send, then the window closed before the answer came back.
    const B = `If it drops again, send me the time it happened. ${stamp}`;
    await type(page.getByRole("textbox", { name: "Reply", exact: true }), B);
    const pop2 = await popOut(page);
    await see(pop2.getByRole("textbox", { name: "Reply", exact: true })).toHaveValue(B, { timeout: 120_000 });
    let posted!: () => void;
    const isPosted = new Promise<void>((r) => (posted = r));
    let finish!: () => void;
    const finished = new Promise<void>((r) => (finish = r));
    await pop2.route(url, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const resp = await route.fetch();
      posted();
      await finished;
      await route.fulfill({ response: resp }).catch(() => {});
    });
    await pop2.getByRole("button", { name: "Send", exact: true }).click();
    await isPosted;
    await pop2.close({ runBeforeUnload: true });
    finish();
    await see(page.getByText("This reply was sent.")).toBeVisible({ timeout: 60_000 });
    await see(page.getByRole("textbox", { name: "Reply", exact: true })).toHaveValue("");
    expect((await messages(page, n)).filter((m) => m.body === B)).toHaveLength(1);
  });

  test("taken back: a pop-out that doesn't answer is asked about, never taken silently; awake again it is read-only", async ({ page }) => {
    test.setTimeout(420_000);
    const n = await newTicket(page, "Shared mailbox missing in Outlook");
    await openTicket(page, n);
    const TEXT = `I've added you to the shared mailbox; restart Outlook. ${stamp}`;
    await type(page.getByRole("textbox", { name: "Reply", exact: true }), TEXT);
    const pop = await popOut(page);
    await see(pop.getByRole("textbox", { name: "Reply", exact: true })).toHaveValue(TEXT, { timeout: 120_000 });
    // The pop-out stops answering, as a hung or sleeping window would: it neither hears nor says anything on
    // the channel (its heartbeat in storage goes on, so it looks alive).
    await pop.evaluate(() => {
      const w = window as unknown as { __data?: PropertyDescriptor; __post?: typeof BroadcastChannel.prototype.postMessage };
      w.__data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
      w.__post = BroadcastChannel.prototype.postMessage;
      Object.defineProperty(MessageEvent.prototype, "data", { configurable: true, get() { throw new Error("asleep"); } });
      BroadcastChannel.prototype.postMessage = () => {};
    });
    await page.getByRole("button", { name: "Bring back" }).click();
    const box = page.getByTestId("reply-elsewhere");
    await see(box).toContainText("The other window isn't answering. Take the reply back here?");
    await expect(page.getByRole("textbox", { name: "Reply", exact: true })).toHaveCount(0);
    await shot(page, "pane-not-answering-1440");
    await page.getByRole("button", { name: "Take it back" }).click();
    await see(page.getByRole("textbox", { name: "Reply", exact: true })).toHaveValue(TEXT);
    // Awake again: read-only, nothing to send from there.
    await pop.evaluate(() => {
      const w = window as unknown as { __data?: PropertyDescriptor; __post?: typeof BroadcastChannel.prototype.postMessage };
      if (w.__data) Object.defineProperty(MessageEvent.prototype, "data", w.__data);
      if (w.__post) BroadcastChannel.prototype.postMessage = w.__post;
      window.dispatchEvent(new Event("focus"));
    });
    await see(pop.getByText("This reply was taken back in the desk")).toBeVisible({ timeout: 30_000 });
    await expect(pop.getByRole("textbox", { name: "Reply", exact: true })).toHaveCount(0);
    await shot(pop, "popout-taken-back-720");
    // The desk sends it, once.
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await see(page.getByRole("textbox", { name: "Reply", exact: true })).toHaveValue("", { timeout: 60_000 });
    await see(page.getByRole("list", { name: "Conversation" }).getByText(TEXT)).toBeVisible({ timeout: 60_000 });
    expect((await messages(page, n)).filter((m) => m.body === TEXT)).toHaveLength(1);
    await pop.close();
  });

  test("sign-out closes the pop-out and leaves no desk drafts in this browser", async ({ page }) => {
    test.setTimeout(300_000);
    const n = await newTicket(page, "Laptop battery swells");
    await openTicket(page, n);
    await type(page.getByRole("textbox", { name: "Reply", exact: true }), `Please stop using it; a replacement is on its way. ${stamp}`);
    const pop = await popOut(page);
    await see(pop.getByRole("textbox", { name: "Reply", exact: true })).toBeVisible({ timeout: 120_000 });
    const keys = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("compass-desk-")));
    expect((await keys()).length).toBeGreaterThan(0);
    const closed = pop.waitForEvent("close", { timeout: 60_000 });
    await page.getByRole("button", { name: /: (Available|Away|Offline)$/ }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await closed;
    await page.waitForURL(/\/login/, { timeout: 60_000 });
    expect(await keys()).toEqual([]);
  });
});
