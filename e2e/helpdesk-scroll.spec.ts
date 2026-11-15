import { test, expect, type Page } from "@playwright/test";
import { ADMIN, api, login } from "./helpers";

// 1.20.12 "Desk panes own their scroll" (STYLEGUIDE §Helpdesk: the desk).
// On a desktop the ticket's conversation and its side column scroll on
// their own: scrolling one never moves the other, and each reaches its own
// end. No scroll area in the desk, and never the page itself, scrolls past
// its last content into empty space (an escaped sr-only label used to make
// the document thousands of pixels tall). A phone is one scroll, with no
// sideways scroll. Licensed rig only; the spec removes the team and the
// ticket it makes.

const stamp = `${Date.now()}`;

const MESSAGES: ["public" | "internal", string][] = [
  ["internal", "Checked the controller: the laptop roams between AP-3F-02 and AP-3F-05 every few minutes. Signal is around -72 dBm at her desk."],
  ["public", "Hi Priya,\n\nThanks for the detail. Could you tell me roughly when the last two drops happened? Then I can match them with the access point logs."],
  ["internal", "Driver on her machine is 22.230.0.8, current is 23.40.0.4. The vendor lists a roaming fix in 23.20."],
  ["public", "Hi Priya,\n\nYour Wi-Fi driver is a bit old. We will push an update tonight. Please restart the laptop tomorrow morning and tell us if the drops continue."],
  ["internal", "Driver pushed to the device group 'Floor 3 pilot'. Deployment succeeded at 21:14."],
  ["public", "Good morning Priya,\n\nThe update is installed. If it happens again, please note the time and the room.\n\n1. Open Settings\n2. Go to Network and internet\n3. Choose Wi-Fi, then Hardware properties\n4. Send us a screenshot of that page"],
  ["internal", "One drop at 10:42 in Atlas. The controller shows a band steer from 5 GHz to 2.4 GHz at 10:42:07."],
  ["internal", "Networking sees 78% airtime on channel 36 for AP-3F-05 between 10:00 and 11:00."],
  ["public", "Hi Priya,\n\nThe drop at 10:42 lines up with a busy period on the access point in Atlas. Our network team is moving it to a quieter channel this evening."],
  ["internal", "AP-3F-05 moved to channel 149, minimum RSSI lowered to -75. Change CHG-2231."],
  ["public", "Hi Priya,\n\nWe will keep an eye on it until Thursday and then close this ticket if everything stays quiet. Just reply here if it comes back."],
  ["public", "Hi Priya,\n\nEverything has stayed stable for three days, so I will mark this as solved. Thank you for the detailed reports.\n\nBest regards,\nSam"],
];

const CONV = "[data-testid=ticket-conversation-pane]";
const SIDE = "[data-testid=ticket-side-pane]";
const ARTICLE = "article[aria-labelledby=ticket-subject]";

/** Every scroll area inside the desk's page area (and the document), with its sizes. */
async function scrollAreas(page: Page) {
  return page.evaluate(() => {
    const out: { name: string; sh: number; ch: number; sw: number; cw: number; ox: string }[] = [];
    const se = document.scrollingElement!;
    out.push({ name: "document", sh: se.scrollHeight, ch: se.clientHeight, sw: se.scrollWidth, cw: se.clientWidth, ox: "visible" });
    for (const el of document.querySelectorAll<HTMLElement>("main *, main")) {
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY) || el.scrollHeight <= el.clientHeight + 1 || el.getBoundingClientRect().width === 0) continue;
      const name = el.getAttribute("data-testid") || el.getAttribute("aria-label") || `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 4).join(".")}`;
      out.push({ name, sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth, ox: cs.overflowX });
    }
    return out;
  });
}

/**
 * Scrolls each scroll area in the page area to its end and returns, per area, the space between
 * its last in-flow child (plus its own bottom padding) and its inner bottom edge. 0 means it ends
 * exactly at its content: nothing blank to scroll into. Scroll positions are put back.
 */
async function blankAtEnd(page: Page) {
  return page.evaluate(() => {
    const out: { name: string; gap: number }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("main *, main")) {
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY) || el.scrollHeight <= el.clientHeight + 1 || el.getBoundingClientRect().width === 0) continue;
      const before = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      const kids = [...el.children].filter((c) => {
        const k = getComputedStyle(c);
        return k.position !== "absolute" && k.position !== "fixed" && k.display !== "none";
      });
      const last = kids[kids.length - 1];
      if (last) {
        const lastBottom = last.getBoundingClientRect().bottom + parseFloat(getComputedStyle(last).marginBottom);
        const inner = el.getBoundingClientRect().top + el.clientTop + el.clientHeight;
        out.push({ name: el.getAttribute("data-testid") || el.getAttribute("aria-label") || el.tagName.toLowerCase(), gap: Math.round(inner - lastBottom - parseFloat(cs.paddingBottom)) });
      }
      el.scrollTop = before;
    }
    return out;
  });
}

const pos = (page: Page, sel: string) =>
  page.locator(sel).evaluate((el) => ({ top: Math.round(el.scrollTop), left: Math.round(el.scrollLeft), y: Math.round(el.getBoundingClientRect().top), max: el.scrollHeight - el.clientHeight }));

async function wheelOver(page: Page, sel: string, dy: number, dx = 0) {
  const b = (await page.locator(sel).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + Math.min(b.height / 2, 150));
  await page.mouse.wheel(dx, dy);
  await page.waitForTimeout(400);
}

test.describe("desk scroll areas (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  let teamId = 0;
  let ticket = 0;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await browser.newPage();
    await login(page, ADMIN);
    if ((await api(page, "/api/helpdesk/admin/settings")).status === 402) {
      await page.close();
      return;
    }
    const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `E2E Scroll ${stamp}`, icon: "monitor", members: [] } });
    expect(team.status).toBe(201);
    teamId = team.body.team.id;
    const t = await api(page, "/api/helpdesk/tickets", {
      method: "POST",
      body: {
        subject: `Laptop keeps dropping off the office Wi-Fi ${stamp}`,
        body: "Hi team,\n\nSince Monday my laptop drops off the office Wi-Fi every 20 minutes or so. Video calls freeze and I lose my VPN session each time.\n\nThanks,\nPriya",
        team_id: teamId,
        priority: "high",
        tags: ["wifi", "laptop", "floor-3", "vpn"],
      },
    });
    expect(t.status).toBe(201);
    ticket = t.body.ticket.number;
    for (const [kind, body] of MESSAGES) {
      const r = await api(page, `/api/helpdesk/tickets/${ticket}/messages`, { method: "POST", body: { kind, body } });
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    }
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    if (ticket) await api(page, `/api/helpdesk/tickets/${ticket}`, { method: "DELETE" });
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!ticket, "helpdesk is not licensed in this build");
    await login(page, ADMIN);
  });

  async function openTicket(page: Page, width: number, height: number) {
    await page.setViewportSize({ width, height });
    await page.goto(`/desk/tickets/${ticket}?view=open`);
    await expect(page.locator("ol[aria-label=Conversation] > li").last()).toContainText("Best regards");
    // The side column's cards load on their own; let them settle before measuring.
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);
  }

  test("at 1440px the conversation and the side column scroll on their own, each to its own end", async ({ page }) => {
    await openTicket(page, 1440, 900);
    const conv = page.locator(CONV);
    const side = page.locator(SIDE);

    // Two scroll areas, each taller inside than outside; the article and the page scroll nothing.
    const areas = await scrollAreas(page);
    const names = areas.map((a) => a.name);
    expect(names, JSON.stringify(areas)).toContain("ticket-conversation-pane");
    expect(names, JSON.stringify(areas)).toContain("ticket-side-pane");
    expect(names.some((n) => n.startsWith("article")), JSON.stringify(areas)).toBe(false);
    const doc = areas[0];
    expect(doc.sh, "the page itself never scrolls").toBeLessThanOrEqual(doc.ch + 1);

    // Wheel over the conversation: it moves, the side column does not (scroll position or place).
    const side0 = await pos(page, SIDE);
    await wheelOver(page, CONV, 600);
    const conv1 = await pos(page, CONV);
    expect(conv1.top).toBeGreaterThan(0);
    expect(await pos(page, SIDE)).toEqual(side0);

    // Wheel far past the conversation's end: it stops at its end; nothing else moves.
    for (let i = 0; i < 12; i++) await wheelOver(page, CONV, 1500);
    const convEnd = await pos(page, CONV);
    expect(convEnd.top).toBeGreaterThanOrEqual(convEnd.max - 1);
    expect(await pos(page, SIDE)).toEqual(side0);
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
    expect((await pos(page, ARTICLE)).top).toBe(0);
    // At its end the composer is the last thing, flush with the bottom padding.
    await expect(page.locator(`${CONV} textarea`).first()).toBeInViewport();

    // And the other way: the side column to its end leaves the conversation where it was.
    for (let i = 0; i < 6; i++) await wheelOver(page, SIDE, 1500);
    const sideEnd = await pos(page, SIDE);
    expect(sideEnd.top).toBeGreaterThan(0);
    expect(sideEnd.top).toBeGreaterThanOrEqual(sideEnd.max - 1);
    expect(sideEnd.y).toBe(side0.y);
    expect(await pos(page, CONV)).toEqual(convEnd);

    // No scroll area ends in blank space: the last content meets the bottom (padding included).
    for (const a of await blankAtEnd(page)) expect(Math.abs(a.gap), `${a.name} ends ${a.gap}px from its content`).toBeLessThanOrEqual(2);

    // Nothing scrolls sideways: a sideways wheel leaves every area at 0.
    await wheelOver(page, CONV, 0, 400);
    await wheelOver(page, SIDE, 0, 400);
    expect((await pos(page, CONV)).left).toBe(0);
    expect((await pos(page, SIDE)).left).toBe(0);
    for (const a of await scrollAreas(page)) if (a.name !== "document") expect(a.sw <= a.cw + 1 || a.ox === "hidden", `${a.name} scrolls sideways`).toBe(true);
    await expect(conv).toBeVisible();
    await expect(side).toBeVisible();
  });

  test("keyboard: a click on text in a column, then Page Down, Space, End and Home scroll that column only", async ({ page }) => {
    await openTicket(page, 1440, 900);
    await page.locator(`${CONV} ol[aria-label=Conversation] > li p`).first().click();
    const side0 = await pos(page, SIDE);
    await page.keyboard.press("PageDown");
    await page.waitForTimeout(400);
    const a = (await pos(page, CONV)).top;
    expect(a).toBeGreaterThan(0);
    await page.keyboard.press("Space");
    await page.waitForTimeout(400);
    expect((await pos(page, CONV)).top).toBeGreaterThan(a);
    await page.keyboard.press("End");
    await page.waitForTimeout(600);
    const end = await pos(page, CONV);
    expect(end.top).toBeGreaterThanOrEqual(end.max - 1);
    expect(await pos(page, SIDE)).toEqual(side0);

    // The side column: click its text (an eyebrow), then End.
    const sb = (await page.locator(SIDE).boundingBox())!;
    await page.mouse.click(sb.x + sb.width - 30, sb.y + 12);
    await page.keyboard.press("End");
    await page.waitForTimeout(600);
    const sEnd = await pos(page, SIDE);
    expect(sEnd.top).toBeGreaterThanOrEqual(sEnd.max - 1);
    expect(await pos(page, CONV)).toEqual(end);
    await page.keyboard.press("Home");
    await page.waitForTimeout(600);
    expect((await pos(page, SIDE)).top).toBe(0);

    // `r` reaches the composer from the top of the conversation (it scrolls into view in its column).
    await page.evaluate((s) => { document.querySelector(s)!.scrollTop = 0; }, CONV);
    await page.locator(`${CONV} ol[aria-label=Conversation] > li p`).first().click();
    await page.keyboard.press("r");
    await expect(page.locator(`${CONV} textarea`).first()).toBeFocused();
    await expect(page.locator(`${CONV} textarea`).first()).toBeInViewport();
  });

  test("a menu in the side column opens inside it, not cut off at its edge", async ({ page }) => {
    await openTicket(page, 1440, 900);
    const trigger = page.locator(`${SIDE} button[aria-label^="Priority"]`);
    await trigger.click();
    const menu = page.locator(`${SIDE} [role=menu]`);
    await expect(menu).toBeVisible();
    const m = (await menu.boundingBox())!;
    const s = (await page.locator(SIDE).boundingBox())!;
    expect(m.x).toBeGreaterThanOrEqual(s.x);
    expect(m.x + m.width).toBeLessThanOrEqual(s.x + s.width);
    expect((await pos(page, SIDE)).left).toBe(0);
    await page.keyboard.press("Escape");
  });

  for (const [w, h] of [
    [1280, 720],
    [1024, 768],
  ]) {
    test(`at ${w}x${h} (one column beside the list) nothing scrolls past its content`, async ({ page }) => {
      await openTicket(page, w, h);
      const areas = await scrollAreas(page);
      expect(areas[0].sh, "the page itself never scrolls").toBeLessThanOrEqual(areas[0].ch + 1);
      for (const a of await blankAtEnd(page)) expect(Math.abs(a.gap), `${a.name} ends ${a.gap}px from its content`).toBeLessThanOrEqual(2);
      // The queue list beside it is its own scroll and stays where it is.
      const list0 = await page.evaluate(() => document.querySelector<HTMLElement>("section[aria-labelledby=queue-title] .overflow-y-auto")?.scrollTop ?? 0);
      await wheelOver(page, ARTICLE, 2000);
      expect((await pos(page, ARTICLE)).top).toBeGreaterThan(0);
      expect(await page.evaluate(() => document.querySelector<HTMLElement>("section[aria-labelledby=queue-title] .overflow-y-auto")?.scrollTop ?? 0)).toBe(list0);
    });
  }

  test("at 390px the ticket is one scroll, ends at its content and never scrolls sideways", async ({ page }) => {
    await openTicket(page, 390, 844);
    const areas = await scrollAreas(page);
    // One scroll area: the ticket itself (the columns are plain flow); the page scrolls nothing.
    expect(areas.filter((a) => a.name !== "document").map((a) => a.name), JSON.stringify(areas)).toEqual([expect.stringMatching(/^article/)]);
    expect(areas[0].sh).toBeLessThanOrEqual(areas[0].ch + 1);
    expect(areas[0].sw).toBeLessThanOrEqual(areas[0].cw + 1);
    for (const sel of [CONV, SIDE]) expect(await page.locator(sel).evaluate((el) => getComputedStyle(el).overflowY)).toBe("visible");

    await wheelOver(page, ARTICLE, 0, 400);
    expect((await pos(page, ARTICLE)).left).toBe(0);
    for (let i = 0; i < 12; i++) await wheelOver(page, ARTICLE, 2000);
    const end = await pos(page, ARTICLE);
    expect(end.top).toBeGreaterThanOrEqual(end.max - 1);
    for (const a of await blankAtEnd(page)) expect(Math.abs(a.gap), `${a.name} ends ${a.gap}px from its content`).toBeLessThanOrEqual(2);
    // The side column's last card is on screen at the bottom: no dead space under it.
    const last = (await page.locator(`${SIDE} > * > *`).last().boundingBox())!;
    expect(last.y + last.height).toBeLessThanOrEqual(844);
    expect(last.y + last.height).toBeGreaterThan(844 - 120);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });

  test("a long menu (the list's views under xl) ends at its last row", async ({ page }) => {
    await openTicket(page, 1024, 768);
    await page.getByRole("button", { name: /change view/ }).click();
    const menu = page.getByRole("menu", { name: "Ticket views" });
    await expect(menu).toBeVisible();
    const r = await menu.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      const last = el.lastElementChild!;
      const inner = el.getBoundingClientRect().top + el.clientTop + el.clientHeight;
      return { scrolls: el.scrollHeight > el.clientHeight + 1, gap: Math.round(inner - last.getBoundingClientRect().bottom - parseFloat(getComputedStyle(el).paddingBottom)), bottom: el.getBoundingClientRect().bottom };
    });
    expect(r.bottom).toBeLessThanOrEqual(768);
    if (r.scrolls) expect(Math.abs(r.gap), JSON.stringify(r)).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
    await page.keyboard.press("Escape");
  });

  /** The open menu is whole on screen and inside the box of every pane that clips it. */
  async function menuFits(menu: ReturnType<Page["getByRole"]>) {
    return menu.evaluate((m) => {
      const r = m.getBoundingClientRect();
      const box = { top: 0, left: 0, right: document.documentElement.clientWidth, bottom: window.innerHeight };
      if (getComputedStyle(m).position !== "fixed") {
        for (let p = m.parentElement; p && p !== document.body; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (!/auto|scroll|hidden|clip/.test(`${cs.overflowX} ${cs.overflowY}`)) continue;
          const b = p.getBoundingClientRect();
          box.top = Math.max(box.top, b.top);
          box.left = Math.max(box.left, b.left);
          box.right = Math.min(box.right, b.right);
          box.bottom = Math.min(box.bottom, b.bottom);
        }
      }
      const fits = r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.left >= box.left - 1 && r.right <= box.right + 1;
      return { fits, menu: [r.top, r.bottom, r.left, r.right].map(Math.round), box: [box.top, box.bottom, box.left, box.right].map(Math.round) };
    });
  }

  test("the side column's lowest menu opens whole on screen and its last choice is clickable", async ({ page }) => {
    await openTicket(page, 1440, 900);
    const side = page.locator(SIDE);
    await side.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const trigger = side.locator("button[aria-haspopup=menu]:visible").last();
    await expect(trigger).toBeVisible();
    await trigger.click();
    const menu = side.getByRole("menu");
    await expect(menu).toBeVisible();
    const fit = await menuFits(menu);
    expect(fit.fits, JSON.stringify(fit)).toBe(true);
    const last = menu.locator('[role^="menuitem"]:not([disabled])').last();
    await last.click({ timeout: 10_000 });
    await expect(menu).toHaveCount(0);
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  });

  test.describe("a row menu at the end of a long settings list", () => {
    let parentId = 0;
    test.beforeAll(async ({ browser }) => {
      if (!ticket) return;
      const page = await browser.newPage();
      await login(page, ADMIN);
      const p = await api(page, "/api/helpdesk/admin/categories", { method: "POST", body: { name: `E2E Scroll ${stamp}` } });
      expect(p.status, JSON.stringify(p.body)).toBe(201);
      parentId = p.body.category.id;
      for (let i = 1; i <= 24; i++) {
        const s = await api(page, "/api/helpdesk/admin/categories", { method: "POST", body: { name: `Scroll sub ${String(i).padStart(2, "0")} ${stamp}`, parent_id: parentId } });
        expect(s.status, JSON.stringify(s.body)).toBe(201);
      }
      await page.close();
    });
    test.afterAll(async ({ browser }) => {
      if (!parentId) return;
      const page = await browser.newPage();
      await login(page, ADMIN);
      const list = await api(page, "/api/helpdesk/admin/categories");
      const mine = (list.body?.categories ?? []).find((c: { id: number }) => c.id === parentId);
      for (const s of mine?.subcategories ?? []) await api(page, `/api/helpdesk/admin/categories/${s.id}`, { method: "DELETE" });
      await api(page, `/api/helpdesk/admin/categories/${parentId}`, { method: "DELETE" });
      await page.close();
    });

    for (const [w, h] of [
      [1440, 900],
      [1280, 720],
    ]) {
      test(`at ${w}x${h} it opens whole on screen and its last item is clickable`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: h });
        await page.goto("/desk/settings/categories");
        const lastName = `Scroll sub 24 ${stamp}`;
        const more = page.getByRole("button", { name: `More actions for ${lastName}` });
        await expect(more).toBeAttached({ timeout: 60_000 });
        // Scroll the settings pane to its very end: the row sits at the bottom of the screen.
        await more.evaluate((b) => {
          for (let p = b.parentElement; p; p = p.parentElement)
            if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) {
              p.scrollTop = p.scrollHeight;
              break;
            }
        });
        const rb = (await more.boundingBox())!;
        expect(rb.y + rb.height, "the row is near the bottom of the screen").toBeGreaterThan(h - 200);
        await more.click();
        const menu = page.getByRole("menu", { name: `Actions for ${lastName}` });
        await expect(menu).toBeVisible();
        const fit = await menuFits(menu);
        expect(fit.fits, JSON.stringify(fit)).toBe(true);
        // The last item (Delete) takes a click without any scrolling, and asks first.
        const last = menu.getByRole("menuitem").last();
        await expect(last).toHaveText(/Delete/);
        await last.click({ timeout: 10_000 });
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
      });
    }
  });

  test("other desk pages: the page never scrolls and no pane ends in blank space", async ({ page }) => {
    for (const [w, h] of [
      [1440, 900],
      [390, 844],
    ]) {
      await page.setViewportSize({ width: w, height: h });
      for (const path of ["/desk?view=open", "/desk/settings/teams", "/desk/reports"]) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(600);
        const areas = await scrollAreas(page);
        expect(areas[0].sh, `${path} at ${w}: the page itself scrolls`).toBeLessThanOrEqual(areas[0].ch + 1);
        expect(areas[0].sw, `${path} at ${w}: the page scrolls sideways`).toBeLessThanOrEqual(areas[0].cw + 1);
        for (const a of areas.slice(1)) expect(a.sw <= a.cw + 1 || a.ox === "hidden", `${path} at ${w}: ${a.name} scrolls sideways`).toBe(true);
        for (const a of await blankAtEnd(page)) expect(Math.abs(a.gap), `${path} at ${w}: ${a.name} ends ${a.gap}px from its content`).toBeLessThanOrEqual(2);
      }
    }
  });
});
