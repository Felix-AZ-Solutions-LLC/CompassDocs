import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, api, ensureUser, login } from "./helpers";

// 1.20.9 printing an original: the "View original" dialog's Print opens the
// print view in a new tab (?print=1, plus images=1 when Show images was
// pressed): a header the desk writes (the ticket, From, received, printed
// by), the email as the dialog shows it, a bar that says to press Ctrl+P
// (hidden on paper). Remote pictures follow the dialog's choice; inline
// (data:) ones always print; a script or handler in the email does nothing;
// the header's values are text. The served policy is checked on the real
// server (next.config.js headers win there). A requester gets 403.
//
// Workspace state as e2e/helpdesk-email-html: the inbound webhook is switched
// on under the email settings' advisory lock (728351) only when it is off,
// and put back. The requester is this spec's own; its tickets are deleted at
// the end. Remote pictures are served by a route stub (no outside host is
// contacted). Licensed rig only.

const stamp = `${Date.now()}`;
const LOCK = 728351;
const REQUESTER = { username: "e2e_print_requester", password: "E2ePrintRequester!123" };
const reqEmail = `rhea.${stamp}@clientco.example`;
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PRINT_CSP = (images: boolean) =>
  `default-src 'none'; img-src data:${images ? " https:" : ""}; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox allow-popups allow-popups-to-escape-sandbox allow-modals`;

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/settings")).status !== 402;
}

/** Remote pictures from images.example, answered here; the count of requests made. */
async function stubImages(ctx: BrowserContext): Promise<{ hits: () => number }> {
  let n = 0;
  await ctx.route("https://images.example/**", (route) => {
    n++;
    return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(PNG_1PX, "base64") });
  });
  return { hits: () => n };
}

test.describe("Print the original email (licensed)", () => {
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

  test("Print from the dialog: the header, pictures as the dialog chose, no script runs, the policy of each variant", async ({ page, browser }) => {
    test.setTimeout(300_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    const images = await stubImages(page.context());

    await ensureUser(page, REQUESTER, "viewer", "Rhea Requester");
    await db.query("UPDATE users SET email = $2 WHERE username = $1", [REQUESTER.username, reqEmail]);

    let s = await api(page, "/api/helpdesk/admin/settings");
    expect(s.status).toBe(200);
    if (!s.body.inbound_path) {
      savedSettings = (await db.query("SELECT value FROM settings WHERE key = 'helpdesk_settings'")).rows[0]?.value ?? null;
      s = await api(page, "/api/helpdesk/admin/settings", { method: "PATCH", body: { rotate_inbound_secret: true } });
      expect(s.status, JSON.stringify(s.body)).toBe(200);
    }
    const hook = s.body.inbound_path as string;

    async function mailIn(data: Record<string, unknown>) {
      const r = await page.request.post(hook, { data: { from: `Rhea Requester <${reqEmail}>`, to: "help@acme.example", dmarc: "pass", ...data } });
      expect(r.status(), await r.text()).toBe(200);
      const body = await r.json();
      if (body.ticket) numbers.push(body.ticket);
      return body as { outcome: string; ticket: number };
    }

    const subject = `Badge reader <b>lobby</b> & "door 2" ${stamp}`;
    const opened = await mailIn({ subject, text: "The badge reader at the lobby door is dead.", html: "<p>The badge reader is <b>dead</b>.</p>", message_id: `<open-${stamp}@clientco.example>` });
    expect(opened.outcome).toBe("created");
    const t = (await db.query("SELECT reply_token, subject FROM hd_tickets WHERE number = $1", [opened.ticket])).rows[0];
    const reply =
      `<div style="font-family:Georgia,serif"><p>Still <b style="color:#b91c1c">dead</b> this morning. Photo of the reader:</p>` +
      `<img src="https://images.example/reader.png" alt="The reader" width="120" height="80">` +
      `<img src="data:image/png;base64,${PNG_1PX}" alt="Inline sign" width="40" height="40">` +
      `<script>document.title = "PWNED"; document.body.setAttribute("data-pwned", "script")</script>` +
      `<img src="x" onerror="document.title='PWNED'; document.body.setAttribute('data-pwned','onerror')">` +
      `<p onclick="document.title='PWNED'" id="tap">Tap here</p>` +
      `<style>.cd-head{display:none!important} header{visibility:hidden}</style></div>`;
    const replied = await mailIn({ subject: `Re: ${t.subject} [#${opened.ticket} ref:${t.reply_token}]`, html: reply, message_id: `<reply-${stamp}@clientco.example>` });
    expect(replied.outcome).toBe("appended");
    const msgId = (await db.query("SELECT m.id FROM hd_messages m JOIN hd_tickets t ON t.id = m.ticket_id WHERE t.number = $1 AND m.body LIKE '%this morning%'", [opened.ticket])).rows[0].id as number;

    // --- The desk: the dialog's Print ---
    await page.goto(`/desk/tickets/${opened.ticket}`);
    await expect(page.getByRole("heading", { level: 2, name: t.subject })).toBeVisible({ timeout: 120_000 });
    const card = page.locator("li", { hasText: "this morning" }).last();
    await card.getByRole("button", { name: "Open in a window" }).click();
    const dialog = page.getByRole("dialog", { name: "Original email" });
    await expect(dialog).toBeVisible();
    const print = dialog.getByRole("link", { name: "Print this email" });
    await expect(print).toBeVisible({ timeout: 120_000 });
    await expect(print).toHaveAttribute("data-tt", "Print this email");
    await expect(print).toHaveAttribute("target", "_blank");
    await expect(print).toHaveAttribute("rel", /noopener/);
    await expect(print).toHaveAttribute("href", `/api/helpdesk/messages/${msgId}/original?print=1`);
    const deskTitle = await page.title();

    // Pictures hidden in the dialog: the print view leaves the remote one out.
    const [pv] = await Promise.all([page.context().waitForEvent("page"), print.click()]);
    let dialogs = 0;
    pv.on("dialog", (d) => {
      dialogs++;
      void d.dismiss();
    });
    await pv.waitForLoadState("load");
    await expect(pv.locator("header.cd-head h1")).toHaveText(`#${opened.ticket} ${t.subject}`, { timeout: 120_000 });
    await expect(pv.locator("header.cd-head")).toBeVisible();
    await expect(pv.locator("header.cd-head b")).toHaveCount(0);
    const row = (label: string) => pv.locator("header.cd-head dt", { hasText: label }).locator("xpath=following-sibling::dd[1]");
    await expect(row("From")).toHaveText(`Rhea Requester <${reqEmail}>`);
    await expect(row("CCs on the ticket")).toHaveText("None");
    await expect(row("Received")).toHaveText(/\d.*\d/);
    await expect(pv.locator("header.cd-head")).toContainText(/Printed by .+ on .+\./);
    await expect(pv.locator("header.cd-head")).toContainText("Remote images are not printed.");
    await expect(pv.locator(".cd-bar")).toContainText("press Ctrl+P (Cmd+P on a Mac)");
    // The email, as the dialog shows it, in its own shadow root.
    await expect(pv.locator(".cd-body b", { hasText: "dead" })).toBeVisible();
    await expect(pv.locator('img[alt="The reader"]')).not.toHaveAttribute("src", /.+/);
    await expect.poll(() => pv.locator('img[alt="Inline sign"]').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
    expect(images.hits()).toBe(0);
    // No script ran and no handler fires: the page is untouched, and so is the desk.
    await pv.locator("#tap").click();
    await expect(pv.locator(".cd-body")).not.toHaveAttribute("data-pwned", /.*/);
    await expect(pv.locator("script")).toHaveCount(0);
    expect(await pv.title()).toBe(`Print #${opened.ticket} original email`);
    expect(dialogs).toBe(0);
    expect(await page.title()).toBe(deskTitle);
    // The bar is for the screen: on paper it is gone and the header stays.
    await pv.emulateMedia({ media: "print" });
    await expect(pv.locator(".cd-bar")).toBeHidden();
    await expect(pv.locator("header.cd-head")).toBeVisible();
    await pv.emulateMedia({ media: "screen" });
    await pv.close();

    // Show images, then Print: the remote picture is printed too.
    await dialog.getByTestId("remote-images-bar").getByRole("button", { name: "Show images" }).click();
    await expect(print).toHaveAttribute("href", `/api/helpdesk/messages/${msgId}/original?print=1&images=1`);
    const [pv2] = await Promise.all([page.context().waitForEvent("page"), print.click()]);
    await pv2.waitForLoadState("load");
    await expect(pv2.locator('img[alt="The reader"]')).toHaveAttribute("src", "https://images.example/reader.png", { timeout: 120_000 });
    await expect.poll(() => pv2.locator('img[alt="The reader"]').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
    expect(images.hits()).toBeGreaterThan(0);
    await expect(pv2.locator("header.cd-head")).not.toContainText("Remote images are not printed.");
    await expect(pv2.locator(".cd-body")).not.toHaveAttribute("data-pwned", /.*/);
    await pv2.close();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // The policy the real server sends (next.config.js headers win over the route's own).
    for (const [q, csp] of [
      ["?print=1", PRINT_CSP(false)],
      ["?print=1&images=1", PRINT_CSP(true)],
    ] as const) {
      const r = await page.request.get(`/api/helpdesk/messages/${msgId}/original${q}`);
      expect(r.status()).toBe(200);
      expect(r.headers()["content-security-policy"]).toBe(csp);
      expect(r.headers()["x-frame-options"]).toBe("DENY");
      expect(r.headers()["referrer-policy"]).toBe("no-referrer");
    }
    const view = await page.request.get(`/api/helpdesk/messages/${msgId}/original`);
    expect(view.headers()["content-security-policy"]).toContain("frame-ancestors 'self'; sandbox allow-popups allow-popups-to-escape-sandbox");

    // --- The requester: never ---
    const ctx = await browser.newContext();
    const rp = await ctx.newPage();
    try {
      await login(rp, REQUESTER);
      expect((await api(rp, `/api/helpdesk/messages/${msgId}/original?print=1`)).status).toBe(403);
    } finally {
      await ctx.close();
    }
  });
});
