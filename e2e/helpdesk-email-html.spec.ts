import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, api, ensureUser, login } from "./helpers";

// 1.20.8 "View original": an HTML reply that comes in through the inbound
// webhook shows "View original" in the desk; the dialog renders it in a
// sandboxed frame with remote pictures hidden until "Show images"; a script
// in the email does nothing (neither in the frame nor in the desk); the
// requester's Get help view has no such control.
//
// The email settings are workspace state: the inbound webhook is switched on
// (a secret made) under the email settings' advisory lock (728351, as
// e2e/helpdesk-mailboxes) only when it is off, and put back afterwards.
// The requester is an account of this spec's own; its tickets are deleted at
// the end. Licensed rig only.

const stamp = `${Date.now()}`;
const LOCK = 728351;
const REQUESTER = { username: "e2e_html_requester", password: "E2eHtmlRequester!123" };
const reqEmail = `cara.${stamp}@clientco.example`;

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/settings")).status !== 402;
}

test.describe("View original (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  let db: Client;
  let savedSettings: string | null | undefined;
  const numbers: number[] = [];

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e" });
    await db.connect();
    await db.query("SELECT pg_advisory_lock($1)", [LOCK]);
  });

  test.afterAll(async () => {
    await db.query("DELETE FROM hd_tickets WHERE number = ANY($1) OR requester_email = $2", [numbers, reqEmail]);
    if (savedSettings !== undefined) {
      if (savedSettings === null) await db.query("DELETE FROM settings WHERE key = 'helpdesk_settings'");
      else await db.query("UPDATE settings SET value = $1 WHERE key = 'helpdesk_settings'", [savedSettings]);
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

  test("an HTML reply by email: View original, a sandboxed frame, pictures on request, no script runs; Get help has no such control", async ({ page, browser }) => {
    test.setTimeout(300_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");

    // A requester with an account (their mail is matched to it by its address).
    await ensureUser(page, REQUESTER, "viewer", "Cara Customer");
    await db.query("UPDATE users SET email = $2 WHERE username = $1", [REQUESTER.username, reqEmail]);

    // The inbound webhook: on as found, or switched on for this spec (put back afterwards).
    let s = await api(page, "/api/helpdesk/admin/settings");
    expect(s.status).toBe(200);
    if (!s.body.inbound_path) {
      savedSettings = (await db.query("SELECT value FROM settings WHERE key = 'helpdesk_settings'")).rows[0]?.value ?? null;
      s = await api(page, "/api/helpdesk/admin/settings", { method: "PATCH", body: { rotate_inbound_secret: true } });
      expect(s.status, JSON.stringify(s.body)).toBe(200);
    }
    const hook = s.body.inbound_path as string;
    expect(hook).toMatch(/^\/api\/helpdesk\/inbound\//);

    async function mailIn(data: Record<string, unknown>) {
      const r = await page.request.post(hook, { data: { from: `Cara Customer <${reqEmail}>`, to: "help@acme.example", dmarc: "pass", ...data } });
      expect(r.status(), await r.text()).toBe(200);
      const body = await r.json();
      if (body.ticket) numbers.push(body.ticket);
      return body as { outcome: string; ticket: number };
    }

    // A new ticket, then the requester's HTML reply on its thread.
    const subject = `Projector in room 4 ${stamp}`;
    const opened = await mailIn({ subject, text: "The projector in room 4 shows no picture.", html: "<p>The projector in room 4 shows <b>no picture</b>.</p>", message_id: `<open-${stamp}@clientco.example>` });
    expect(opened.outcome).toBe("created");
    const token = (await db.query("SELECT reply_token FROM hd_tickets WHERE number = $1", [opened.ticket])).rows[0].reply_token as string;
    const hostile =
      `<div style="font-family:Georgia,serif"><p>Still <b style="color:#b91c1c">no picture</b> after the restart. Photo of the cable:</p>` +
      `<img src="https://images.invalid/cable.jpg" alt="The cable" width="240">` +
      `<script>parent.document.title = "PWNED"; document.body.setAttribute("data-pwned", "script")</script>` +
      `<img src="x" onerror="document.body.setAttribute('data-pwned','onerror'); parent.document.title='PWNED'">` +
      `<svg onload="document.body.setAttribute('data-pwned','svg')"></svg>` +
      `<a id="go" href="javascript:document.body.setAttribute('data-pwned','link')">Open the manual</a></div>` +
      `<div class="gmail_quote">On Monday the desk wrote:<blockquote>Please restart the projector.</blockquote></div>`;
    const replied = await mailIn({
      subject: `Re: ${subject} [#${opened.ticket} ref:${token}]`,
      html: hostile,
      message_id: `<reply-${stamp}@clientco.example>`,
    });
    expect(replied.outcome).toBe("appended");

    // --- The desk ---
    const pageTitle = await (async () => {
      await page.goto(`/desk/tickets/${opened.ticket}`);
      await expect(page.getByRole("heading", { level: 2, name: subject })).toBeVisible({ timeout: 120_000 });
      return page.title();
    })();
    const reply = page.locator("li", { hasText: "after the restart" }).last();
    await expect(reply).toBeVisible();
    // The card shows the text body; the quote is cut there, kept in the original.
    await expect(reply).not.toContainText("Please restart the projector");
    const control = reply.getByRole("button", { name: "View original" });
    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute("data-tt", "View original");
    await expect(page.getByRole("button", { name: "View original" })).toHaveCount(2);

    await control.click();
    const dialog = page.getByRole("dialog", { name: "Original email" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("From Cara Customer");
    const frameEl = dialog.locator("iframe");
    // (The first read of the route compiles it on a dev server: give it time.)
    await expect(frameEl).toHaveAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox", { timeout: 120_000 });
    const frame = dialog.frameLocator("iframe");
    await expect(frame.locator("b", { hasText: "no picture" })).toBeVisible({ timeout: 60_000 });
    await expect(frame.getByText("Please restart the projector.")).toBeVisible();
    await expect(frame.locator("div").first()).toHaveAttribute("style", /font-family:Georgia/);

    // Remote pictures: hidden, then shown for this message.
    const bar = dialog.getByTestId("remote-images-bar");
    await expect(bar).toContainText("Remote images are hidden.");
    await expect(frame.locator('img[alt="The cable"]')).not.toHaveAttribute("src", /.+/);
    await bar.getByRole("button", { name: "Show images" }).click();
    await expect(bar).toContainText("Remote images are shown for this email.");
    await expect(frame.locator('img[alt="The cable"]')).toHaveAttribute("src", "https://images.invalid/cable.jpg");
    await expect(frame.locator('img[alt="The cable"]')).toHaveAttribute("referrerpolicy", "no-referrer");

    // No script ran: not in the frame (nothing marked its body), not in the desk (its title is untouched).
    await expect(frame.locator("body")).not.toHaveAttribute("data-pwned", /.*/);
    await expect(frame.locator("script, svg")).toHaveCount(0);
    await expect(frame.getByText("Open the manual")).not.toHaveAttribute("href", /.+/);
    await frame.getByText("Open the manual").click();
    await expect(frame.locator("body")).not.toHaveAttribute("data-pwned", /.*/);
    expect(await page.title()).toBe(pageTitle);
    expect(await page.evaluate(() => document.title)).not.toContain("PWNED");

    // Back to the conversation; opened again, pictures are hidden again (never remembered).
    await dialog.getByRole("button", { name: "Back to the conversation" }).click();
    await expect(dialog).toBeHidden();
    await expect(control).toBeFocused();
    await control.click();
    await expect(page.getByRole("dialog", { name: "Original email" }).getByTestId("remote-images-bar")).toContainText("Remote images are hidden.");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Original email" })).toBeHidden();

    // --- The requester's Get help view: the conversation, no "View original" ---
    const ctx = await browser.newContext();
    const rp = await ctx.newPage();
    try {
      await login(rp, REQUESTER);
      await rp.goto(`/help/requests/${opened.ticket}`);
      await expect(rp.getByText("after the restart")).toBeVisible({ timeout: 60_000 });
      await expect(rp.getByRole("button", { name: "View original" })).toHaveCount(0);
      // And the route itself refuses them.
      const msgId = (await db.query("SELECT m.id FROM hd_messages m JOIN hd_tickets t ON t.id = m.ticket_id WHERE t.number = $1 AND m.body LIKE '%after the restart%'", [opened.ticket])).rows[0].id;
      expect((await api(rp, `/api/helpdesk/messages/${msgId}/original?format=info`)).status).toBe(403);
    } finally {
      await ctx.close();
    }
  });
});
