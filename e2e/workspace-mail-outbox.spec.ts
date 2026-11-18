import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { startFakeM365, type FakeM365 } from "../test/helpers/fake-m365";
import { ADMIN, api, login } from "./helpers";

// The outbox of the workspace's email through Microsoft 365 (1.20.32,
// lib/mail-outbox), end to end against a fake Microsoft on this machine
// (test/helpers/fake-m365): a burst of email is paced (spread over the
// minute, never all at once) and every message arrives; Microsoft's 429
// pauses the outbox (Settings → Notifications → Email → Outbox says until
// when) and the mail goes out after it, once; a send that gets no answer
// is "May have gone out" in the Outbox and Retry delivers it; a refused one
// is Discarded; and, where the helpdesk is licensed, a desk reply whose
// email fails says so on the message in the ticket, with Send again.
//
// The burst is an announcement emailed to a group of this spec's own
// people. It runs only where the app was started with the test seam
// (COMPASSDOCS_M365_MAIL_TEST_BASE=http://127.0.0.1:PORT,
// lib/helpdesk/m365/graph): everywhere else it skips itself. Nothing here
// may contact Microsoft. The email settings are workspace state: written
// under the advisory lock the unit suites use (728351) and put back.

const stamp = `${Date.now()}`;
const MAILBOX = `outbox-${stamp}@acme.example`;
const PAGE = "/admin/notifications/email";
const LOCK = 728351;
const KEYS = [
  "mail_method",
  "mail_m365_tenant",
  "mail_m365_client_id",
  "mail_m365_client_secret",
  "mail_m365_mailbox",
  "mail_m365_graph_user",
  "mail_m365_from_name",
  "mail_m365_setup",
  "mail_m365_secret_expires",
  "mail_m365_sp_object_id",
  "mail_m365_entra_send",
  "mail_m365_check",
];
const BURST = 6;

test.describe.configure({ mode: "serial" });

test.describe("Workspace email outbox through Microsoft 365 (fake Microsoft)", () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e" });
  let fake: FakeM365 | null = null;
  let base = "";
  let ours = false;
  let saved: { key: string; value: string }[] = [];
  let runStart = "";
  let adminId = 0;
  let outboxFrom = 0;
  let ledgerFrom = 0;
  let groupId = 0;
  const userIds: number[] = [];
  const announcementTitles: string[] = [];
  const ticketNumbers: number[] = [];

  const ctl = async (op: string, body?: unknown) => (await fetch(`${base}/__fake/${op}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) })).json();
  const sentTo = async (): Promise<{ sent: string[]; sentAt: number[] }> => {
    const mb = ((await ctl("state")).mailboxes as { address: string; sent: string[]; sentAt: number[] }[]).find((m) => m.address === MAILBOX);
    return { sent: mb?.sent ?? [], sentAt: mb?.sentAt ?? [] };
  };
  const outbox = (page: Page) => page.getByTestId("mail-outbox");
  const rows = async () => (await db.query("SELECT id, status, subject, kind, last_error FROM mail_outbox WHERE id > $1 ORDER BY id", [outboxFrom])).rows;
  /** An announcement emailed to this spec's group: one email per person, through the outbox. */
  const announce = async (page: Page, title: string) => {
    announcementTitles.push(title);
    const r = await api(page, "/api/admin/announcements", { method: "POST", body: { title, body: "From the outbox spec.", level: "info", email_mode: "groups", email_group_ids: [groupId] } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.emailed as number;
  };
  const people = async (n: number) => {
    await db.query("DELETE FROM group_members WHERE group_id = $1", [groupId]);
    for (const id of userIds.slice(0, n)) await db.query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [groupId, id]);
  };

  test.beforeAll(async () => {
    await db.connect();
  });

  test.afterAll(async () => {
    if (ours) {
      await db.query("DELETE FROM mail_outbox WHERE id > $1", [outboxFrom]).catch(() => {});
      await db.query("DELETE FROM mail_send_ledger WHERE id > $1", [ledgerFrom]).catch(() => {});
      await db.query("UPDATE mail_outbox_control SET paused_until = NULL, rate_until = NULL, pause_reason = '', pause_kind = '', noticed_reason = '' WHERE id = 1").catch(() => {});
      await db.query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
      for (const s of saved) await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [s.key, s.value]);
      if (announcementTitles.length) await db.query("DELETE FROM announcements WHERE title = ANY($1)", [announcementTitles]).catch(() => {});
      if (ticketNumbers.length) await db.query("DELETE FROM hd_tickets WHERE number = ANY($1)", [ticketNumbers]).catch(() => {});
      if (groupId) await db.query("DELETE FROM groups WHERE id = $1", [groupId]).catch(() => {});
      if (userIds.length) await db.query("DELETE FROM users WHERE id = ANY($1)", [userIds]).catch(() => {});
      await db.query("DELETE FROM audit_log WHERE (action LIKE 'settings.mail%' OR action = 'announcement.posted' OR action = 'helpdesk.reply_mail_resent') AND at >= $1 AND actor_id = $2", [runStart, adminId]).catch(() => {});
      await db.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {});
    }
    if (base) await ctl("reset").catch(() => {});
    await db.end();
    await fake?.close();
  });

  test("a burst is paced and delivered; 429 pauses then delivers; no answer is uncertain until Retry; Discard", async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, ADMIN);
    const first = await api(page, "/api/admin/mail");
    expect(first.status).toBe(200);
    test.skip(!first.body?.test_base, "the rig was not started with COMPASSDOCS_M365_MAIL_TEST_BASE; nothing here may contact Microsoft");
    base = first.body.test_base as string;
    const alive = await fetch(`${base}/__fake/ping`, { method: "POST" }).then((r) => r.ok, () => false);
    if (!alive) {
      try {
        fake = await startFakeM365({ port: Number(new URL(base).port) });
      } catch {
        test.skip(true, `port ${new URL(base).port} is in use by something that is not the fake Microsoft`);
      }
    }
    await db.query("SELECT pg_advisory_lock($1)", [LOCK]);
    ours = true;
    runStart = (await db.query("SELECT now()::text AS t")).rows[0].t;
    adminId = (await db.query("SELECT id FROM users WHERE username = $1", [ADMIN.username])).rows[0].id;
    saved = (await db.query("SELECT key, value FROM settings WHERE key = ANY($1)", [KEYS])).rows;
    outboxFrom = Number((await db.query("SELECT COALESCE(max(id), 0) AS n FROM mail_outbox")).rows[0].n);
    ledgerFrom = Number((await db.query("SELECT COALESCE(max(id), 0) AS n FROM mail_send_ledger")).rows[0].n);
    await db.query("UPDATE mail_outbox_control SET paused_until = NULL, rate_until = NULL, pause_reason = '', pause_kind = '' WHERE id = 1");
    await ctl("reset");
    await ctl("mailbox", { address: MAILBOX, kind: "shared" });
    for (let i = 0; i < BURST; i++) {
      const r = await db.query("INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id", [`outbox-${stamp}-${i}`, `Outbox Reader ${i}`, `reader-${i}-${stamp}@example.test`]);
      userIds.push(r.rows[0].id);
    }
    groupId = (await db.query("INSERT INTO groups (name) VALUES ($1) RETURNING id", [`Outbox spec ${stamp}`])).rows[0].id;

    // Microsoft 365 chosen, with an app made by hand.
    const made = await ctl("app", { roles: ["Mail.Send"], displayName: "Outbox spec app" });
    const saveR = await api(page, "/api/admin/mail", { method: "PATCH", body: { action: "m365", tenant: made.tenant, client_id: made.client_id, secret: made.secret, mailbox: MAILBOX, use: true, confirm: true } });
    expect(saveR.status, JSON.stringify(saveR.body)).toBe(200);
    expect(saveR.body.view.method).toBe("m365");

    // --- The Outbox section, empty -----------------------------------------------------------------------
    await page.goto(PAGE);
    await expect(outbox(page)).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#outbox").getByRole("heading", { name: "Outbox" })).toBeVisible();
    await expect(outbox(page)).toContainText("Nothing failed.");
    await expect(page.getByTestId("outbox-day")).toContainText("of 10,000");

    // --- A burst: queued at once, sent paced (spread over the minute), every one delivered --------------------
    await people(BURST);
    expect(await announce(page, `Outbox burst ${stamp}`)).toBe(BURST);
    await expect.poll(async () => (await sentTo()).sent.filter((m) => m.includes(`Outbox burst ${stamp}`)).length, { timeout: 120_000, intervals: [1_000] }).toBe(BURST);
    const { sent, sentAt } = await sentTo();
    const burst = sentAt.slice(-BURST);
    for (let i = 1; i < burst.length; i++) expect(burst[i] - burst[i - 1], "about 2.4 s apart, never a burst").toBeGreaterThanOrEqual(2_000);
    for (let i = 0; i < BURST; i++) expect(sent.some((m) => m.includes(`reader-${i}-${stamp}@example.test`)), `reader ${i}`).toBe(true);
    expect((await rows()).filter((r) => r.subject.includes(`Outbox burst ${stamp}`)).map((r) => [r.status, r.kind])).toEqual(Array.from({ length: BURST }, () => ["sent", "announcement"]));
    await page.reload();
    await expect(page.getByTestId("outbox-sent-hour")).not.toHaveText("0");

    // --- 429: everything pauses at least a minute; the page says until when; then it goes, once -----------------
    await people(1);
    await ctl("set", { throttleNext: 1, retryAfter: 2 });
    await announce(page, `Outbox throttled ${stamp}`);
    await expect.poll(async () => (await db.query("SELECT pause_kind FROM mail_outbox_control WHERE id = 1")).rows[0].pause_kind, { timeout: 60_000 }).toBe("rate");
    await page.reload();
    await expect(page.getByTestId("outbox-paused")).toContainText("Paused until", { timeout: 30_000 });
    await expect(page.getByTestId("outbox-paused")).toContainText("Microsoft 365 asked this mailbox to slow down");
    expect((await sentTo()).sent.filter((m) => m.includes(`Outbox throttled ${stamp}`)).length).toBe(0);
    await expect.poll(async () => (await sentTo()).sent.filter((m) => m.includes(`Outbox throttled ${stamp}`)).length, { timeout: 150_000, intervals: [2_000] }).toBe(1);
    await page.waitForTimeout(3_000);
    expect((await sentTo()).sent.filter((m) => m.includes(`Outbox throttled ${stamp}`)).length, "never doubled").toBe(1);

    // --- No answer after the post: "May have gone out"; Retry (asks first) delivers it --------------------------
    await ctl("set", { fail: { sendMail: -2 } });
    await announce(page, `Outbox lost answer ${stamp}`);
    await expect.poll(async () => (await rows()).find((r) => r.subject.includes(`Outbox lost answer ${stamp}`))?.status, { timeout: 90_000 }).toBe("uncertain");
    await ctl("set", { fail: {} });
    await page.reload();
    const lost = page.getByTestId("outbox-problem").filter({ hasText: `Outbox lost answer ${stamp}` });
    await expect(lost).toBeVisible({ timeout: 30_000 });
    await expect(lost).toContainText("May have gone out");
    await expect(lost).toContainText("Microsoft didn't answer, so this may have gone out.");
    await expect(lost).toContainText(`reader-0-${stamp}@example.test`);
    const before = (await sentTo()).sent.filter((m) => m.includes(`Outbox lost answer ${stamp}`)).length;
    expect(before, "Microsoft took the first one").toBe(1);
    await lost.getByRole("button", { name: "Retry" }).click();
    const ask = page.getByRole("dialog");
    await expect(ask).toContainText("it may have gone out already");
    await ask.getByRole("button", { name: "Send again" }).click();
    await expect(page.getByText("Queued to send again.")).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await sentTo()).sent.filter((m) => m.includes(`Outbox lost answer ${stamp}`)).length, { timeout: 90_000 }).toBe(2);
    await expect(page.getByTestId("outbox-problem").filter({ hasText: `Outbox lost answer ${stamp}` })).toHaveCount(0);

    // --- A refusal of one message: Failed, with Microsoft's reason; Discard (asks first) -------------------------
    await ctl("set", { fail: { sendMail: 400 } });
    await announce(page, `Outbox refused ${stamp}`);
    await expect.poll(async () => (await rows()).find((r) => r.subject.includes(`Outbox refused ${stamp}`))?.status, { timeout: 90_000 }).toBe("failed");
    await ctl("set", { fail: {} });
    await page.reload();
    const refused = page.getByTestId("outbox-problem").filter({ hasText: `Outbox refused ${stamp}` });
    await expect(refused).toContainText("Failed", { timeout: 30_000 });
    await expect(refused).toContainText("Microsoft 365 refused the email (error 400");
    await refused.getByRole("button", { name: "Discard" }).click();
    await expect(page.getByRole("dialog")).toContainText("is never sent, and its content is deleted");
    await page.getByRole("dialog").getByRole("button", { name: "Discard" }).click();
    await expect(page.getByText("Discarded.", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("outbox-problem").filter({ hasText: `Outbox refused ${stamp}` })).toHaveCount(0);
    const discarded = (await db.query("SELECT status, mime FROM mail_outbox WHERE subject LIKE $1", [`%Outbox refused ${stamp}%`])).rows[0];
    expect([discarded.status, discarded.mime]).toEqual(["discarded", null]);
    expect((await sentTo()).sent.filter((m) => m.includes(`Outbox refused ${stamp}`)).length).toBe(0);

    // --- Waiting mail is listed, and Discard all waiting (asks first) empties the queue -----------------------
    await people(2);
    await ctl("set", { throttleNext: 1, retryAfter: 2 });
    await announce(page, `Outbox waiting ${stamp}`);
    await expect.poll(async () => (await db.query("SELECT pause_kind FROM mail_outbox_control WHERE id = 1")).rows[0].pause_kind, { timeout: 60_000 }).toBe("rate");
    await page.reload();
    const waiting = page.getByTestId("outbox-waiting");
    await expect(waiting).toContainText("Waiting (2)", { timeout: 30_000 });
    await expect(waiting.getByTestId("outbox-waiting-row").filter({ hasText: `Outbox waiting ${stamp}` })).toHaveCount(2);
    await waiting.getByRole("button", { name: "Discard all waiting" }).click();
    await expect(page.getByRole("dialog")).toContainText("None of them is sent");
    await page.getByRole("dialog").getByRole("button", { name: "Discard all waiting" }).click();
    await expect(page.getByText("Discarded 2 waiting emails.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("outbox-waiting")).toHaveCount(0);
    expect((await rows()).filter((r) => r.subject.includes(`Outbox waiting ${stamp}`)).map((r) => r.status)).toEqual(["discarded", "discarded"]);
    await db.query("UPDATE mail_outbox_control SET paused_until = NULL, rate_until = NULL, pause_reason = '', pause_kind = '' WHERE id = 1");

    // Sent rows keep no body.
    const bodies = (await db.query("SELECT count(*)::int AS n FROM mail_outbox WHERE id > $1 AND status = 'sent' AND mime IS NOT NULL", [outboxFrom])).rows[0].n;
    expect(bodies).toBe(0);

    // Audited.
    const actions = (await db.query("SELECT action FROM audit_log WHERE action LIKE 'settings.mail_outbox%' AND at >= $1 AND actor_id = $2", [runStart, adminId])).rows.map((r) => r.action);
    expect(actions).toContain("settings.mail_outbox_retry");
    expect(actions).toContain("settings.mail_outbox_discard");
    expect(actions).toContain("settings.mail_outbox_discard_all");
  });

  test("a desk reply whose email fails says so on the message, with Send again", async ({ page }) => {
    test.setTimeout(300_000);
    test.skip(!ours, "the outbox flow did not run on this rig");
    await login(page, ADMIN);
    const probe = await api(page, "/api/helpdesk/tickets?view=all");
    test.skip(probe.status === 402 || probe.status === 404, "the helpdesk is not licensed in this build; the EE rig runs the flow");
    const created = await api(page, "/api/helpdesk/tickets", { method: "POST", body: { subject: `Outbox desk ${stamp}`, body: "The printer is jammed.", priority: "normal" } });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const number = Number(created.body?.ticket?.number ?? created.body?.number);
    ticketNumbers.push(number);
    const customer = `customer-${stamp}@outside.example.test`;
    await db.query("UPDATE hd_tickets SET requester_id = NULL, requester_name = 'Casey Customer', requester_email = $2 WHERE number = $1", [number, customer]);
    await ctl("set", { fail: { sendMail: 400 } });
    const reply = await api(page, `/api/helpdesk/tickets/${number}/messages`, { method: "POST", body: { kind: "public", body: `Try turning it off and on ${stamp}.` } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    await expect.poll(async () => (await db.query("SELECT status FROM mail_outbox WHERE ref_type = 'hd_message' AND recipients = $1 ORDER BY id DESC LIMIT 1", [customer])).rows[0]?.status, { timeout: 90_000 }).toBe("failed");
    await ctl("set", { fail: {} });
    await page.goto(`/desk/tickets/${number}`);
    const line = page.getByTestId("message-mail-state");
    await expect(line).toContainText(`Not sent to ${customer}: Microsoft 365 refused the email (error 400`, { timeout: 60_000 });
    await line.getByRole("button", { name: "Send again" }).click();
    await expect(page.getByTestId("message-mail-state")).toContainText(`Queued to send again to ${customer}`, { timeout: 30_000 });
    await expect.poll(async () => (await sentTo()).sent.filter((m) => m.includes(`Try turning it off and on ${stamp}`)).length, { timeout: 90_000 }).toBe(1);
    await page.reload();
    await expect(page.getByText(`Try turning it off and on ${stamp}.`).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("message-mail-state")).toHaveCount(0);
  });
});
