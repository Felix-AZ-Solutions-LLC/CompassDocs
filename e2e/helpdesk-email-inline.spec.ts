import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { Client } from "pg";
import { ADMIN, api, ensureUser, login } from "./helpers";

// 1.20.11 "Email shows as sent": an emailed message with an HTML part shows
// its email formatted in the desk conversation without a click. The frame is
// as tall as the email (no scrollbar inside), the reply's quoted history is
// folded under "Show quoted text" (the frame grows when it opens), remote
// pictures stay hidden until "Show images", nothing in the email runs, and
// "Plain text" switches a message to its text body and sticks (the agent's
// desk preference) after a reload. A message without HTML, an email too
// complex to show (text, "Shown as text") and the requester's Get help view
// stay text.
//
// Workspace state: the inbound webhook is switched on (a secret made) under
// the email settings' advisory lock (728351, as e2e/helpdesk-email-html) only
// when it is off, and put back afterwards; the admin's desk preferences row is
// saved first and put back. The requester is this spec's own account; its
// tickets are deleted at the end. Licensed rig only.

const stamp = `${Date.now()}`;
const LOCK = 728351;
const REQUESTER = { username: "e2e_inline_requester", password: "E2eInlineRequester!123" };
const reqEmail = `rhea.${stamp}@clientco.example`;

/** A real PNG of random pixels (over the 4 KB the desk keeps as an attachment), so a browser can draw it. */
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

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/settings")).status !== 402;
}

test.describe("Email shows as sent (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  let db: Client;
  let savedSettings: string | null | undefined;
  let adminId = 0;
  let savedPrefs: string | null | undefined;
  const numbers: number[] = [];

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e" });
    await db.connect();
    await db.query("SELECT pg_advisory_lock($1)", [LOCK]);
    adminId = (await db.query("SELECT id FROM users WHERE username = $1", [ADMIN.username])).rows[0]?.id ?? 0;
    savedPrefs = adminId ? ((await db.query("SELECT prefs::text AS p FROM hd_notify_prefs WHERE user_id = $1", [adminId])).rows[0]?.p ?? null) : undefined;
  });

  test.afterAll(async () => {
    await db.query("DELETE FROM hd_tickets WHERE number = ANY($1) OR requester_email = $2", [numbers, reqEmail]);
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

  test("an HTML reply shows formatted in place: sized to the email, quote folded, pictures on request, nothing runs; Plain text sticks; text stays text elsewhere", async ({ page, browser }) => {
    test.setTimeout(420_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    await ensureUser(page, REQUESTER, "viewer", "Rhea Requester");
    await db.query("UPDATE users SET email = $2 WHERE username = $1", [REQUESTER.username, reqEmail]);
    // Start from the default (formatted), whatever this admin chose before (put back afterwards).
    await db.query("UPDATE hd_notify_prefs SET prefs = prefs - 'email_view' WHERE user_id = $1", [adminId]);

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

    // The opening email (HTML), the requester's HTML reply (a Gmail quote, a remote picture, hostile bits), a
    // plain-text reply, and an HTML reply too complex to show.
    const subject = `Badge reader at door 3 ${stamp}`;
    const opened = await mailIn({
      subject,
      text: "The badge reader at door 3 stays red.",
      html: `<div style="font-family:Georgia,serif;color:#1e3a8a"><h2 style="margin:0 0 8px">Door 3</h2><p>The badge reader at door 3 <b>stays red</b>.</p></div>`,
      message_id: `<open-${stamp}@clientco.example>`,
    });
    expect(opened.outcome).toBe("created");
    const token = (await db.query("SELECT reply_token FROM hd_tickets WHERE number = $1", [opened.ticket])).rows[0].reply_token as string;
    const ref = `Re: ${subject} [#${opened.ticket} ref:${token}]`;
    const reply =
      `<div dir="ltr"><p>Still <b style="color:#b91c1c">red</b> this morning. Photo:</p>` +
      `<img src="https://images.invalid/reader.jpg" alt="The reader" width="240" height="120">` +
      `<script>parent.document.title = "PWNED"; parent.__pwned = 1; document.body.setAttribute("data-pwned", "script")</script>` +
      `<img src="x" onerror="parent.__pwned = 1; document.body.setAttribute('data-pwned','onerror')">` +
      `<p id="tap" onclick="parent.__pwned = 1">Tap here</p>` +
      `<a id="go" href="javascript:parent.__pwned=1">Open the manual</a></div>` +
      `<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, IT help wrote:<br></div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">` +
      `<p>Please hold your badge to the reader for three seconds.</p>${"<p>Earlier line.</p>".repeat(12)}</blockquote></div>`;
    expect((await mailIn({ subject: ref, html: reply, message_id: `<reply-${stamp}@clientco.example>` })).outcome).toBe("appended");
    expect((await mailIn({ subject: ref, text: `Plain text only, from my phone ${stamp}.`, message_id: `<plain-${stamp}@clientco.example>` })).outcome).toBe("appended");
    expect(
      (await mailIn({ subject: ref, text: `Too deep to draw ${stamp}.`, html: `<p>Too deep to draw ${stamp}.</p>${"<div>".repeat(450)}x`, message_id: `<deep-${stamp}@clientco.example>` })).outcome
    ).toBe("appended");

    // --- The desk ---
    await page.goto(`/desk/tickets/${opened.ticket}`);
    await expect(page.getByRole("heading", { level: 2, name: subject })).toBeVisible({ timeout: 120_000 });
    const deskTitle = await page.title();
    const conversation = page.getByRole("list", { name: "Conversation" });
    const card = (text: string) => conversation.locator(":scope > li", { hasText: text }).last();
    const first = card("stays red");
    const replyCard = card("this morning");
    const plainCard = card("Plain text only");
    const deepCard = card("Too deep to draw");

    // Formatted, no click: the opening email and the reply.
    await expect(first.getByTestId("inline-email")).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
    await expect(first.frameLocator("iframe").locator("h2", { hasText: "Door 3" })).toBeVisible();
    await expect(replyCard.getByTestId("inline-email")).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
    const frameEl = replyCard.getByTestId("inline-email-frame");
    await expect(frameEl).toHaveAttribute("sandbox", "allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    const frame = replyCard.frameLocator("iframe");
    await expect(frame.locator("b", { hasText: "red" })).toBeVisible();
    await expect(frame.locator("p").first()).toHaveCSS("color", "rgb(31, 41, 55)");
    await expect(replyCard.getByTestId("email-text")).toBeHidden();
    const toggle = replyCard.getByTestId("email-view-toggle");
    await expect(toggle).toHaveAttribute("aria-label", "Plain text");
    await expect(toggle).toHaveAttribute("data-tt", "Plain text");
    await expect(replyCard.getByRole("button", { name: "Open in a window" })).toHaveAttribute("data-tt", "Open in a window");

    // As tall as the email: no scrollbar inside, the frame's height is the document's.
    const fit = async () =>
      frameEl.evaluate((f: HTMLIFrameElement) => {
        const root = f.contentDocument!.documentElement;
        return { frame: f.getBoundingClientRect().height, doc: Math.ceil(root.getBoundingClientRect().height), scroll: root.scrollHeight, client: root.clientHeight };
      });
    await expect.poll(async () => { const m = await fit(); return Math.abs(m.frame - m.doc) <= 1 && m.scroll <= m.client + 1; }, { timeout: 20_000 }).toBe(true);
    const closedHeight = (await fit()).frame;

    // The quote: folded, then shown (and the frame grows with it).
    const quote = frame.getByText("Please hold your badge to the reader for three seconds.");
    await expect(quote).toBeHidden();
    await expect(frame.locator("details.cd-quote")).not.toHaveAttribute("open", /.*/);
    await frame.getByText("Show quoted text").click();
    await expect(quote).toBeVisible();
    await expect(frame.getByText("Hide quoted text")).toBeVisible();
    await expect.poll(async () => (await fit()).frame, { timeout: 20_000 }).toBeGreaterThan(closedHeight + 100);
    await expect.poll(async () => { const m = await fit(); return Math.abs(m.frame - m.doc) <= 1 && m.scroll <= m.client + 1; }, { timeout: 20_000 }).toBe(true);
    await frame.getByText("Hide quoted text").click();
    await expect.poll(async () => (await fit()).frame, { timeout: 20_000 }).toBeLessThan(closedHeight + 2);

    // Remote pictures: hidden, then shown for this message.
    const bar = replyCard.getByTestId("inline-images-bar");
    await expect(bar).toContainText("Remote images are hidden");
    await expect(frame.locator('img[alt="The reader"]')).not.toHaveAttribute("src", /.+/);
    await bar.getByRole("button", { name: "Show images" }).click();
    await expect(frame.locator('img[alt="The reader"]')).toHaveAttribute("src", "https://images.invalid/reader.jpg", { timeout: 60_000 });
    await expect(bar).toBeHidden();
    await expect(first.getByTestId("inline-images-bar")).toHaveCount(0);

    // Nothing in the email ran: not in its frame, not in the desk.
    await frame.locator("#tap").click();
    await frame.getByText("Open the manual").click();
    await expect(frame.locator("script")).toHaveCount(0);
    await expect(frame.locator("body")).not.toHaveAttribute("data-pwned", /.*/);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(await page.title()).toBe(deskTitle);

    // A message without HTML is as before; an email too complex to draw is its text, "Shown as text".
    await expect(plainCard.getByTestId("inline-email")).toHaveCount(0);
    await expect(plainCard.getByTestId("email-view-toggle")).toHaveCount(0);
    await expect(plainCard.getByText(`Plain text only, from my phone ${stamp}.`)).toBeVisible();
    await expect(deepCard.getByTestId("inline-email")).toHaveAttribute("data-state", "text", { timeout: 60_000 });
    await expect(deepCard.getByText(`Too deep to draw ${stamp}.`)).toBeVisible();
    await expect(deepCard.getByTestId("email-view-toggle")).toHaveAttribute("data-tt", "Shown as text");

    // "Open in a window" is the dialog, with Print.
    await replyCard.getByRole("button", { name: "Open in a window" }).click();
    const dialog = page.getByRole("dialog", { name: "Original email" });
    await expect(dialog.getByRole("link", { name: "Print this email" })).toBeVisible({ timeout: 60_000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // Plain text: this message switches to its text body; the choice sticks after a reload (the default for every message).
    await toggle.click();
    await expect(replyCard.getByTestId("inline-email")).toHaveAttribute("data-state", "plain");
    await expect(replyCard.getByText("this morning")).toBeVisible();
    await expect(frameEl).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-label", "Formatted");
    await expect(first.getByTestId("inline-email")).toHaveAttribute("data-state", "ready", { timeout: 5_000 });
    await expect.poll(async () => (await api(page, "/api/helpdesk/me/notification-prefs")).body.prefs.email_view, { timeout: 30_000 }).toBe("plain");
    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name: subject })).toBeVisible({ timeout: 120_000 });
    await expect(card("this morning").getByTestId("inline-email")).toHaveAttribute("data-state", "plain");
    await expect(card("stays red").getByTestId("inline-email")).toHaveAttribute("data-state", "plain");
    await expect(card("this morning").getByTestId("email-view-toggle")).toHaveAttribute("aria-label", "Formatted");
    await expect(card("this morning").getByTestId("inline-email-frame")).toHaveCount(0);
    // And back.
    await card("this morning").getByTestId("email-view-toggle").click();
    await expect(card("this morning").getByTestId("inline-email")).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
    await expect.poll(async () => (await api(page, "/api/helpdesk/me/notification-prefs")).body.prefs.email_view, { timeout: 30_000 }).toBe("formatted");

    // 1.20.11 security review: a constant edge around the email, in both themes.
    await expect(card("this morning").getByTestId("inline-email-paper")).toHaveCSS("border-top-width", "1px");
    await expect(card("this morning").getByTestId("inline-email-paper")).toHaveCSS("border-top-style", "solid");

    // An email whose height follows its frame's (100vh and a margin) stops growing: frozen well under the cap.
    expect(
      (await mailIn({ subject: ref, text: `Tall one ${stamp}.`, html: `<style>.v{height:100vh;margin-bottom:300px;background:#eef}</style><div class="v">Tall one ${stamp}.</div>`, message_id: `<vh-${stamp}@clientco.example>` }))
        .outcome
    ).toBe("appended");
    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name: subject })).toBeVisible({ timeout: 120_000 });
    const tall = card(`Tall one ${stamp}.`);
    await tall.scrollIntoViewIfNeeded();
    await expect(tall.getByTestId("inline-email")).toHaveAttribute("data-frozen", "1", { timeout: 60_000 });
    await page.waitForTimeout(1500);
    const tallHeight = await tall.getByTestId("inline-email-frame").evaluate((f) => f.getBoundingClientRect().height);
    expect(tallHeight).toBeLessThan(2400);
    await page.waitForTimeout(1500);
    expect(await tall.getByTestId("inline-email-frame").evaluate((f) => f.getBoundingClientRect().height)).toBe(tallHeight);

    // A picture on another site that redirects to the desk reaches it signed out (src/proxy.ts): the agent's own
    // attachment, which loads for them directly, fails through the redirect (401); a public file loads either way.
    expect(
      (await mailIn({ subject: ref, text: `With a photo ${stamp}.`, attachments: [{ filename: "photo.png", content_type: "image/png", content: noisePng().toString("base64") }], message_id: `<photo-${stamp}@clientco.example>` }))
        .outcome
    ).toBe("appended");
    const attId = (await db.query("SELECT a.id FROM hd_attachments a JOIN hd_tickets t ON t.id = a.ticket_id WHERE t.number = $1 ORDER BY a.id DESC LIMIT 1", [opened.ticket])).rows[0].id as number;
    const hits: string[] = [];
    const redirector: Server = createServer((rq, rs) => {
      const to = new URL(rq.url ?? "/", "http://127.0.0.1").searchParams.get("to") ?? "/";
      hits.push(to);
      rs.writeHead(302, { Location: to });
      rs.end();
    });
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", () => r()));
    // The desk's own policy would refuse a picture from http://127.0.0.1 before any request is made: the same
    // agent's session in a tab that ignores page policies stands for the email's frame (whose policy allows https
    // pictures; a local test server has no https). What reaches the desk is the same request.
    const probeCtx = await browser.newContext({ bypassCSP: true, storageState: await page.context().storageState() });
    const probe = await probeCtx.newPage();
    try {
      await probe.goto(`/desk/tickets/${opened.ticket}`);
      const port = (redirector.address() as { port: number }).port;
      const desk = new URL(probe.url()).origin;
      const loads = (src: string) =>
        probe.evaluate(
          (src) =>
            new Promise<string>((r) => {
              const i = new Image();
              i.onload = () => r("load");
              i.onerror = () => r("error");
              i.src = src;
            }),
          src
        );
      expect(await loads(`/api/helpdesk/attachments/${attId}?direct=${stamp}`)).toBe("load");
      expect(await loads(`http://127.0.0.1:${port}/r?to=${encodeURIComponent(`${desk}/api/helpdesk/attachments/${attId}?via=${stamp}`)}`)).toBe("error");
      expect(await loads(`http://127.0.0.1:${port}/r?to=${encodeURIComponent(`${desk}/icon.png`)}`)).toBe("load");
      expect(hits.length).toBe(2);
    } finally {
      await probeCtx.close();
      await new Promise<void>((r) => redirector.close(() => r()));
    }

    // The inline document is the desk's frame only: opened as a page it is refused, with a small page that says so.
    const msgId = (await db.query("SELECT m.id FROM hd_messages m JOIN hd_tickets t ON t.id = m.ticket_id WHERE t.number = $1 AND m.body LIKE '%this morning%'", [opened.ticket])).rows[0].id;
    const direct = await page.goto(`/api/helpdesk/messages/${msgId}/original?inline=1`);
    expect(direct?.status()).toBe(400);
    await expect(page.getByText("This email shows in the ticket's conversation in the desk.")).toBeVisible();

    // --- The requester's Get help view: text, no frame, no switch ---
    const ctx = await browser.newContext();
    const rp = await ctx.newPage();
    try {
      await login(rp, REQUESTER);
      await rp.goto(`/help/requests/${opened.ticket}`);
      await expect(rp.getByText("this morning")).toBeVisible({ timeout: 60_000 });
      await expect(rp.locator("iframe")).toHaveCount(0);
      await expect(rp.getByRole("button", { name: /Plain text|Formatted|Open in a window/ })).toHaveCount(0);
      expect((await api(rp, `/api/helpdesk/messages/${msgId}/original?inline=1`)).status).toBe(403);
    } finally {
      await ctx.close();
    }
  });
});
