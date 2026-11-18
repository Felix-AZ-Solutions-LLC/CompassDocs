import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { Client } from "pg";
import { ADMIN, api, ensureUser, login, setTicketOrder } from "./helpers";

// 1.20.28: the desk's ticket conversation (lib/helpdesk/conversation-shared,
// ticket/Conversation, STYLEGUIDE §Helpdesk: the desk).
//
//   - newest first by default: the reply box on top, the newest requester
//     message and agent reply (and everything newer) shown, older history
//     behind "Show N earlier messages"; a link to a folded message opens it;
//   - field changes are activity lines (an automation's with its rule's name
//     and a bot, a person's with theirs), an automation's own note is a
//     compact note card, and none of them is a big internal-note card;
//   - a new message never moves what the agent is reading;
//   - Order: oldest first puts the reply box at the bottom, unfolded, and the
//     choice follows the agent (a reload, another browser);
//   - files are a list under their email; a picture the formatted email
//     draws (cid) is in the email, not the list, until it shows as text; an
//     attached .eml (a message/rfc822 part with no name) and a .msg come in;
//   - Settings → Agents on a 390px phone: no gap above each person, the role
//     control on screen, no sideways scroll.
//
// Workspace state: the inbound webhook is switched on under the email
// settings' advisory lock (728351, as e2e/helpdesk-email-inline) only when it
// is off, and put back; the admin's desk preferences row is saved first and
// put back. Messages are seeded straight into the database with fixed times,
// so the fold is exact. Licensed rig only; everything made is removed.

const stamp = `${Date.now()}`;
const LOCK = 728351;
const DB = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e";
const SHOTS = process.env.E2E_SHOTS_DIR;
const REQUESTER = { username: "e2e_conv_requester", password: "E2eConvRequester!123" };
const reqEmail = `linda.${stamp}@clientco.example`;
const see = expect.configure({ timeout: 30_000 });

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}-light.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/${name}-dark.png` });
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await page.emulateMedia({ colorScheme: "light" });
}

/** A real PNG of random pixels (over the 4 KB the desk keeps as an attachment). */
function noisePng(size = 48): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.concat(Array.from({ length: size }, () => Buffer.concat([Buffer.from([0]), randomBytes(size * 4)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const T = {
  r1: `I've booked AV for 1:30 ${stamp}-r1`,
  q2: `Can we move it to 2pm? ${stamp}-q2`,
  n1: `Checked the room calendar ${stamp}-n1`,
  r2: `Moved to 2pm ${stamp}-r2`,
  q3: `Here's the signed agreement ${stamp}-q3`,
  an: `VIP: call within the hour ${stamp}-an`,
  r3: `Thanks, all set for 2pm ${stamp}-r3`,
  note: `Projector bulb ordered ${stamp}-live`,
};

test.describe("ticket conversation 1.20.28 (licensed)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.describe.configure({ mode: "serial", timeout: 300_000 });
  let db: Client;
  let adminId = 0;
  let requesterId = 0;
  let teamId = 0;
  let number = 0;
  let savedPrefs: string | null | undefined;
  let savedSettings: string | null | undefined;
  const numbers: number[] = [];
  const ids: Record<string, number> = {};

  test.beforeAll(async ({ browser }) => {
    db = new Client({ connectionString: DB });
    await db.connect();
    await db.query("SELECT pg_advisory_lock($1)", [LOCK]);
    adminId = (await db.query("SELECT id FROM users WHERE username = $1", [ADMIN.username])).rows[0]?.id ?? 0;
    savedPrefs = adminId ? ((await db.query("SELECT prefs::text AS p FROM hd_notify_prefs WHERE user_id = $1", [adminId])).rows[0]?.p ?? null) : undefined;
    const page = await browser.newPage();
    await login(page, ADMIN);
    if ((await api(page, "/api/helpdesk/admin/settings")).status === 402) {
      await page.close();
      return;
    }
    await ensureUser(page, REQUESTER, "viewer", "Linda Berger");
    await db.query("UPDATE users SET email = $2, name = 'Linda Berger' WHERE username = $1", [REQUESTER.username, reqEmail]);
    requesterId = (await db.query("SELECT id FROM users WHERE username = $1", [REQUESTER.username])).rows[0].id;
    const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `E2E Rooms ${stamp}`, icon: "monitor", members: [{ user_id: adminId, role: "lead" }] } });
    expect(team.status, JSON.stringify(team.body)).toBe(201);
    teamId = team.body.team.id;
    const t = await api(page, "/api/helpdesk/tickets", {
      method: "POST",
      body: { subject: `Room 4B setup for the board meeting ${stamp}`, body: `The screen in room 4B needs moving ${stamp}-open`, team_id: teamId, requester_id: requesterId },
    });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    number = t.body.ticket.number;
    numbers.push(number);
    await page.close();

    // The conversation, an hour old, minute by minute (see the header): what was there at creation goes first.
    const ticketId = (await db.query("SELECT id FROM hd_tickets WHERE number = $1", [number])).rows[0].id as number;
    const base = Date.now() - 60 * 60_000;
    const at = (min: number) => new Date(base + min * 60_000).toISOString();
    await db.query("UPDATE hd_messages SET created_at = $2 WHERE ticket_id = $1", [ticketId, at(0)]);
    const add = async (key: string, min: number, row: { kind: string; author_id: number | null; author_name: string; body: string; via: string; event?: string }) => {
      const r = await db.query(
        "INSERT INTO hd_messages (ticket_id, author_id, author_name, author_email, kind, body, via, event, created_at) VALUES ($1, $2, $3, '', $4, $5, $6, $7, $8) RETURNING id",
        [ticketId, row.author_id, row.author_name, row.kind, row.body, row.via, row.event ?? null, at(min)]
      );
      ids[key] = r.rows[0].id;
    };
    const agent = (body: string) => ({ kind: "public", author_id: adminId, author_name: "Kelli Ivanisko", body, via: "desk" });
    const linda = (body: string) => ({ kind: "public", author_id: requesterId, author_name: "Linda Berger", body, via: "email" });
    await add("r1", 5, agent(T.r1));
    await add("q2", 10, linda(T.q2));
    // An automation's change, as updateTicket writes it (the rule's name escaped, lib/helpdesk/md-inline).
    await add("c1", 12, { kind: "internal", author_id: null, author_name: "Automation: Triage rule", body: "Automation\\: Triage rule changed the priority from Normal to Low", via: "system", event: "change" });
    await add("n1", 15, { kind: "internal", author_id: adminId, author_name: "Kelli Ivanisko", body: T.n1, via: "desk" });
    await add("r2", 20, agent(T.r2));
    await add("cc", 25, { kind: "system", author_id: adminId, author_name: "Kelli Ivanisko", body: "Kelli Ivanisko added Theresa Wooldridge as CC.", via: "system" });
    await add("q3", 30, linda(T.q3));
    await add("an", 32, { kind: "internal", author_id: null, author_name: "Automation: Triage rule", body: T.an, via: "system" });
    await add("r3", 35, agent(T.r3));
    await add("c2", 40, { kind: "internal", author_id: adminId, author_name: "Kelli Ivanisko", body: "Kelli Ivanisko assigned the ticket to Charles Diaz", via: "system", event: "change" });
  });

  test.afterAll(async ({ browser }) => {
    if (numbers.length) await db.query("DELETE FROM hd_tickets WHERE number = ANY($1) OR requester_email = $2", [numbers, reqEmail]);
    if (teamId) {
      const page = await browser.newPage();
      await login(page, ADMIN);
      await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
      await page.close();
    }
    if (savedSettings !== undefined) {
      if (savedSettings === null) await db.query("DELETE FROM settings WHERE key = 'helpdesk_settings'");
      else await db.query("UPDATE settings SET value = $1 WHERE key = 'helpdesk_settings'", [savedSettings]);
    }
    if (adminId && savedPrefs !== undefined) {
      if (savedPrefs === null) await db.query("DELETE FROM hd_notify_prefs WHERE user_id = $1", [adminId]);
      else await db.query("UPDATE hd_notify_prefs SET prefs = $2::jsonb WHERE user_id = $1", [adminId, savedPrefs]);
    }
    const u = (await db.query("SELECT id FROM users WHERE username = $1", [REQUESTER.username])).rows[0];
    if (u) {
      await db.query("DELETE FROM notifications WHERE user_id = $1", [u.id]);
      await db.query("DELETE FROM sessions WHERE user_id = $1", [u.id]);
      await db.query("DELETE FROM audit_log WHERE actor_id = $1", [u.id]);
      await db.query("DELETE FROM users WHERE id = $1", [u.id]).catch(() => undefined);
    }
    await db.query("SELECT pg_advisory_unlock($1)", [LOCK]);
    await db.end();
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!number, "helpdesk is not licensed in this build; the EE rig runs the flow");
    await login(page, ADMIN);
  });

  const conversation = (page: Page) => page.getByRole("list", { name: "Conversation" });
  const item = (page: Page, key: string) => page.locator(`#message-${ids[key]}`);
  const top = async (page: Page, key: string) => (await item(page, key).boundingBox())!.y;

  test("newest first: the reply box on top, the newest exchange shown, older history folded; lines, not note cards", async ({ page }) => {
    await setTicketOrder(page, "newest");
    await page.goto(`/desk/tickets/${number}`);
    await see(page.getByRole("heading", { level: 2, name: new RegExp(`Room 4B setup for the board meeting ${stamp}`) })).toBeVisible({ timeout: 120_000 });
    await see(page.getByTestId("conversation-order")).toHaveText(/Order:\s*Newest first/);
    await see(conversation(page)).toHaveAttribute("data-order", "newest");

    // The reply box sits above the conversation.
    const reply = page.locator('section[aria-label="Reply"]');
    await see(reply).toBeVisible();
    expect((await reply.boundingBox())!.y).toBeLessThan(await top(page, "c2"));

    // Shown: the newest requester message (q3), the newest reply (r3) and what came after, newest first.
    for (const k of ["c2", "r3", "an", "q3"]) await see(item(page, k)).toBeVisible();
    expect(await top(page, "c2")).toBeLessThan(await top(page, "r3"));
    expect(await top(page, "r3")).toBeLessThan(await top(page, "an"));
    expect(await top(page, "an")).toBeLessThan(await top(page, "q3"));
    // Folded: everything older, counted in messages (the opening, r1, q2, n1, r2), not lines (the CC and the change).
    for (const k of ["r2", "cc", "n1", "c1", "q2", "r1"]) await see(item(page, k)).toBeHidden();
    const fold = page.getByTestId("conversation-fold").getByRole("button");
    await see(fold).toHaveText(/^Show (\d+) earlier messages$/);
    const n = Number((await fold.textContent())!.match(/\d+/)![0]);
    // (A note the desk wrote at creation, if any, folds too.)
    expect(n).toBeGreaterThanOrEqual(5);
    await see(fold).toHaveAttribute("aria-expanded", "false");
    await shot(page, "conversation-newest-folded-1440");

    // Activity lines: the automation's names its rule (no "Automation:") with a bot; a person's names them.
    const auto = item(page, "c1");
    await fold.click();
    await see(page.getByTestId("conversation-fold")).toHaveCount(0);
    for (const k of ["r2", "cc", "n1", "c1", "q2", "r1"]) await see(item(page, k)).toBeVisible();
    // Focus moves to the first row the fold revealed (the newest of them, the CC line).
    await see(item(page, "cc")).toBeFocused();
    expect(await top(page, "q3")).toBeLessThan(await top(page, "r2"));
    expect(await top(page, "q2")).toBeLessThan(await top(page, "r1"));
    await see(auto).toHaveAttribute("data-testid", "activity-line");
    await see(auto).toHaveAttribute("data-activity", "bot");
    await see(auto).toContainText("Triage rule changed the priority from Normal to Low");
    await see(auto).not.toContainText("Automation:");
    await see(auto).not.toContainText("Internal note");
    await see(auto.getByTestId("activity-actor")).toHaveText("Triage rule");
    expect(Number(await auto.getByTestId("activity-actor").evaluate((e) => getComputedStyle(e).fontWeight))).toBeGreaterThanOrEqual(600);
    await see(item(page, "c2")).toHaveAttribute("data-activity", "assign");
    await see(item(page, "c2")).toContainText("Kelli Ivanisko assigned the ticket to Charles Diaz");
    await see(item(page, "cc")).toHaveAttribute("data-activity", "cc-add");
    // The automation's own note is a compact note card; a person's note is the note card.
    await see(item(page, "an")).toHaveAttribute("data-testid", "automation-note");
    await see(item(page, "an")).toContainText("Triage rule");
    await see(item(page, "an")).toContainText("Internal note");
    await see(item(page, "an")).toContainText(T.an);
    await see(item(page, "n1")).toContainText("Internal note");
    await shot(page, "conversation-newest-open-1440");

    // A link to a folded message opens the history and shows it (a fresh load: a hash change alone reloads nothing).
    await page.goto("about:blank");
    await page.goto(`/desk/tickets/${number}#message-${ids.r1}`);
    await see(item(page, "r1")).toBeVisible({ timeout: 120_000 });
    await see(item(page, "r1")).toBeInViewport();

    // The requester never sees a line or a note (Get help shows public messages and status lines only).
    const ctx = await page.context().browser()!.newContext();
    const rp = await ctx.newPage();
    try {
      await login(rp, REQUESTER);
      const mine = await api(rp, `/api/helpdesk/requests/${number}`);
      if (mine.status === 200) {
        const bodies = (mine.body.messages ?? mine.body.request?.messages ?? []).map((m: { body: string }) => m.body).join("\n");
        expect(bodies).toContain(T.q3);
        expect(bodies).not.toContain("Triage rule");
        expect(bodies).not.toContain(T.n1);
      }
    } finally {
      await ctx.close();
    }
  });

  test("a new message never moves what the agent is reading; with the top in view it shows there", async ({ page }) => {
    await setTicketOrder(page, "newest");
    await page.goto(`/desk/tickets/${number}`);
    await see(item(page, "r3")).toBeVisible({ timeout: 120_000 });
    await page.getByTestId("conversation-fold").getByRole("button").click();
    // A note typed in the reply box, then the agent scrolls down into the history and sends it with the keys.
    await page.getByRole("radio", { name: "Internal note" }).click();
    const box = page.getByRole("textbox", { name: "Internal note" });
    await box.fill(T.note);
    const pane = page.getByTestId("ticket-conversation-pane");
    await pane.evaluate((el) => { el.scrollTop = Math.min(700, el.scrollHeight - el.clientHeight); });
    await page.waitForTimeout(300);
    const scrolled = await pane.evaluate((el) => el.scrollTop);
    expect(scrolled).toBeGreaterThan(100);
    // The row the agent reads: the first one below the pane's top edge.
    const anchor = await pane.evaluate((el) => {
      const edge = el.getBoundingClientRect().top;
      const row = [...el.querySelectorAll<HTMLElement>("ol[aria-label=Conversation] > li")].find((li) => li.getBoundingClientRect().top >= edge && li.offsetHeight > 0);
      return row ? { id: row.id, y: row.getBoundingClientRect().top } : null;
    });
    expect(anchor).not.toBeNull();
    // The keys go to the box that still has focus (a locator's press would scroll it back into view first).
    await page.keyboard.press("Control+Enter");
    await see(conversation(page).locator(":scope > li", { hasText: T.note })).toHaveCount(1, { timeout: 60_000 });
    await page.waitForTimeout(500);
    const after = await page.locator(`#${anchor!.id}`).evaluate((e) => e.getBoundingClientRect().top);
    expect(Math.abs(after - anchor!.y), "the row being read stays where it was").toBeLessThanOrEqual(2);
    expect(await pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(scrolled);

    // Back at the top: the newest is right under the reply box.
    await pane.evaluate((el) => { el.scrollTop = 0; });
    const newest = conversation(page).locator(":scope > li").first();
    await see(newest).toContainText(T.note);
    await see(newest).toBeInViewport();
  });

  test("Order: oldest first puts the reply box at the bottom, nothing folded, and follows the agent", async ({ page, browser }) => {
    await setTicketOrder(page, "newest");
    await page.goto(`/desk/tickets/${number}`);
    await see(item(page, "r3")).toBeVisible({ timeout: 120_000 });
    await page.getByTestId("conversation-order").click();
    const menu = page.getByRole("menu", { name: "Order" });
    await see(menu.getByRole("menuitemradio", { name: /Newest first/ })).toHaveAttribute("aria-checked", "true");
    await see(menu.getByRole("menuitemradio", { name: /Oldest first/ })).toContainText("Reply box at the bottom");
    await menu.getByRole("menuitemradio", { name: /Oldest first/ }).click();
    await see(page.getByTestId("conversation-order")).toHaveText(/Order:\s*Oldest first/);
    await see(conversation(page)).toHaveAttribute("data-order", "oldest");
    await see(page.getByTestId("conversation-fold")).toHaveCount(0);
    await see(item(page, "r1")).toBeVisible();
    expect(await top(page, "r1")).toBeLessThan(await top(page, "r3"));
    const reply = page.locator('section[aria-label="Reply"]');
    expect((await reply.boundingBox())!.y).toBeGreaterThan(await top(page, "r3"));
    await see.poll(async () => (await api(page, "/api/helpdesk/me/notification-prefs")).body.prefs.ticket_order).toBe("oldest");
    await shot(page, "conversation-oldest-1440");

    // A reload, and another browser of the same agent: still oldest first.
    await page.reload();
    await see(page.getByTestId("conversation-order")).toHaveText(/Oldest first/, { timeout: 120_000 });
    const other = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const op = await other.newPage();
    try {
      await login(op, ADMIN);
      await op.goto(`/desk/tickets/${number}`);
      await see(op.getByTestId("conversation-order")).toHaveText(/Oldest first/, { timeout: 120_000 });
      await see(op.getByRole("list", { name: "Conversation" })).toHaveAttribute("data-order", "oldest");
    } finally {
      await other.close();
    }

    // And back.
    await page.getByTestId("conversation-order").click();
    await page.getByRole("menu", { name: "Order" }).getByRole("menuitemradio", { name: /Newest first/ }).click();
    await see(conversation(page)).toHaveAttribute("data-order", "newest");
    await see.poll(async () => (await api(page, "/api/helpdesk/me/notification-prefs")).body.prefs.ticket_order).toBe("newest");

    // On paper: the whole conversation, oldest first, without the reply box or the Order control.
    await page.emulateMedia({ media: "print" });
    await see(item(page, "r1")).toBeVisible();
    expect(await top(page, "r1")).toBeLessThan(await top(page, "r3"));
    await see(page.getByTestId("conversation-order")).toBeHidden();
    await see(page.getByTestId("ticket-reply-area")).toBeHidden();
    await page.emulateMedia({ media: "screen" });
  });

  test("files stay with their email: a list, the email's own pictures drawn in it, attached emails come in", async ({ page }) => {
    // The inbound webhook (switched on only when it is off; put back afterwards).
    let s = await api(page, "/api/helpdesk/admin/settings");
    expect(s.status).toBe(200);
    if (!s.body.inbound_path) {
      savedSettings = (await db.query("SELECT value FROM settings WHERE key = 'helpdesk_settings'")).rows[0]?.value ?? null;
      s = await api(page, "/api/helpdesk/admin/settings", { method: "PATCH", body: { rotate_inbound_secret: true } });
      expect(s.status, JSON.stringify(s.body)).toBe(200);
    }
    // Emails show formatted (the default; the preferences row is put back afterwards).
    await api(page, "/api/helpdesk/me/notification-prefs", { method: "PUT", body: { email_view: "formatted", ticket_order: "newest" } });
    const eml = ["Received: from mx.example.com by mail.example.com", "From: Room Bookings <rooms@example.com>", "Subject: Room booking confirmation", "MIME-Version: 1.0", "", "Room 4B is booked for 14:00.", ""].join("\r\n");
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(2048)]);
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(6000, 0x20)]);
    const subject = `Signed agreement for 4B ${stamp}`;
    const r = await page.request.post(s.body.inbound_path as string, {
      data: {
        from: `Linda Berger <${reqEmail}>`,
        to: "help@acme.example",
        dmarc: "pass",
        subject,
        text: `Here's the signed agreement ${stamp}-mail.`,
        html: `<p>Here's the signed agreement ${stamp}-mail.</p><p>Linda Berger<br><img src="cid:logo@clientco" alt="Clientco" width="48" height="48"></p>`,
        message_id: `<files-${stamp}@clientco.example>`,
        attachments: [
          { filename: "Meeting agreement signed.pdf", content_type: "application/pdf", content: pdf.toString("base64") },
          { filename: "logo.png", content_type: "image/png", content: noisePng().toString("base64"), content_id: "<logo@clientco>" },
          { content_type: "message/rfc822", content: Buffer.from(eml).toString("base64") },
          { filename: "Outlook item.msg", content_type: "application/vnd.ms-outlook", content: ole.toString("base64") },
        ],
      },
    });
    expect(r.status(), await r.text()).toBe(200);
    const made = (await r.json()) as { ticket: number };
    numbers.push(made.ticket);

    // The ticket read: every file kept, the signature picture marked as drawn by the email.
    const d = await api(page, `/api/helpdesk/tickets/${made.ticket}`);
    const opening = (d.body.messages as { id: number; attachments: { name: string; inline?: boolean }[] }[])[0];
    expect(opening.attachments.map((a) => [a.name, a.inline === true]).sort()).toEqual([
      ["Meeting agreement signed.pdf", false],
      ["Outlook item.msg", false],
      ["Room booking confirmation.eml", false],
      ["logo.png", true],
    ]);
    expect((d.body.messages as { body: string }[]).some((m) => /not added/.test(m.body))).toBe(false);

    await page.goto(`/desk/tickets/${made.ticket}`);
    const card = page.locator(`#message-${opening.id}`);
    await see(card.getByTestId("inline-email")).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
    const files = card.getByTestId("message-files");
    await see(files).toContainText("3 attachments");
    const rows = files.getByRole("list", { name: "Files" }).getByRole("listitem");
    await see(rows).toHaveCount(3);
    await see(files).not.toContainText("logo.png");
    await see(rows.filter({ hasText: "Meeting agreement signed.pdf" })).toContainText("PDF");
    await see(rows.filter({ hasText: "Room booking confirmation.eml" })).toContainText("EML");
    await see(rows.filter({ hasText: "Outlook item.msg" })).toContainText("EML");
    const dl = files.getByRole("link", { name: "Download Meeting agreement signed.pdf" });
    await see(dl).toHaveAttribute("download", "Meeting agreement signed.pdf");
    await see(dl).toHaveAttribute("href", /^\/api\/helpdesk\/attachments\/\d+$/);
    // The size lines up (tabular figures).
    await see(rows.first().locator("span.tabular-nums")).toHaveCSS("font-variant-numeric", "tabular-nums");
    await shot(page, "conversation-files-1440");

    // Shown as text, the email's picture is a file like the others again.
    await card.getByTestId("email-view-toggle").click();
    await see(card.getByTestId("inline-email")).toHaveAttribute("data-state", "plain");
    await see(files).toContainText("4 attachments");
    await see(files).toContainText("logo.png");
    await card.getByTestId("email-view-toggle").click();
    await see(files).toContainText("3 attachments");

    // A phone: the list fits, no sideways scroll.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await see(page.locator(`#message-${opening.id}`).getByTestId("message-files")).toBeVisible({ timeout: 120_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const box = (await page.locator(`#message-${opening.id}`).getByTestId("message-files").boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await shot(page, "conversation-files-390");
  });

  test("Settings → Agents on a phone: no gap above each person, the role on screen, no sideways scroll", async ({ page }) => {
    await page.goto("/desk/settings/agents");
    const rows = page.getByTestId("agent-row");
    await see(rows.first()).toBeVisible({ timeout: 120_000 });
    // Wide: one table, every cell top-aligned.
    await see(rows.first().locator("td").first()).toHaveCSS("vertical-align", "top");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await see(page.locator("thead").first()).toBeHidden();
    const n = Math.min(await rows.count(), 6);
    for (let i = 0; i < n; i++) {
      const m = await rows.nth(i).evaluate((tr) => {
        const r = tr.getBoundingClientRect();
        const cells = [...tr.querySelectorAll("td")].map((td) => td.getBoundingClientRect());
        return { top: r.top, person: cells[0].top, role: { left: cells[1].left, right: cells[1].right }, width: document.documentElement.clientWidth };
      });
      expect(m.person - m.top, `row ${i}: the person starts at the row's top`).toBeLessThanOrEqual(16);
      expect(m.role.left).toBeGreaterThanOrEqual(0);
      expect(m.role.right, `row ${i}: the role is on screen`).toBeLessThanOrEqual(m.width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await shot(page, "agents-390");
  });
});
