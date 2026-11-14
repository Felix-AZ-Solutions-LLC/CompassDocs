import { test, expect } from "@playwright/test";
import { ADMIN, api, login } from "./helpers";

// 1.20.10: a very long link in a message (an alert email's tracking or login
// URL) wraps inside its link chip and never runs past the message card into
// the side panel. A client's Mimecast alert showed a chip several times the
// card's width. Licensed rig only; the spec removes the team and ticket it
// makes.

const stamp = `${Date.now()}`;
const LONG_URL =
  "https://login-us.mimecast.com/u/login/?gta=cybergraph-report&link=report?t=" +
  "eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE3OTQ1NjAwMDB9.l8RsRyQGnYaTiXMEVlP1MAAyttKVSDRxlkx9iDhhe-2eM9mQBxEM8Uy9FfqUMbLNBNhvcLl7T_ea1rx1W_" +
  "AYB1ELZz2rKSiF5GP5NRpaVlH6qu1pPl3jDecpBWzaFLyrYDmjRnEkfCUjxdv_9EfROy_vgM1WVcEYTdfS4Uay3NpnBES-m0bsINWa9prBGe9lbsiFw4CaeitxBaY5" +
  "SuNRzpQz7kPFWEjz7FC9GgLySN0FY_mshb6seTwHg.7CEcU3hzVFg10qO5.2hotdKlLEBQeAraouBPMyC4E3f7Lm7tFZBZolm0FvEWBGY";

test.describe("long links in the desk conversation (licensed)", () => {
  let teamId = 0;
  let ticket = 0;

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    if (ticket) await api(page, `/api/helpdesk/tickets/${ticket}`, { method: "DELETE" });
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await page.close();
  });

  for (const width of [1440, 390]) {
    test(`a long link wraps inside the message card at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await login(page, ADMIN);
      test.skip((await api(page, "/api/helpdesk/admin/settings")).status === 402, "helpdesk is not licensed in this build");
      if (!ticket) {
        const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `E2E Long links ${stamp}`, icon: "monitor", members: [] } });
        expect(team.status).toBe(201);
        teamId = team.body.team.id;
        const t = await api(page, "/api/helpdesk/tickets", {
          method: "POST",
          body: { subject: `Long link ${stamp}`, body: `Please see Community article 1349 for more\n(\n${LONG_URL}\n)\nThanks`, team_id: teamId, priority: "normal" },
        });
        expect(t.status).toBe(201);
        ticket = t.body.ticket.number;
      }
      await page.goto(`/desk/tickets/${ticket}`);
      const link = page.locator(`a[href^="https://login-us.mimecast.com/"]`).first();
      await expect(link).toBeVisible();
      const fits = await link.evaluate((a) => {
        let card: HTMLElement | null = a.parentElement;
        while (card && !card.classList.contains("doc-prose")) card = card.parentElement;
        const box = card!.getBoundingClientRect();
        const chip = a.getBoundingClientRect();
        return { chipRight: Math.round(chip.right), proseRight: Math.round(box.right), scroll: card!.scrollWidth, client: card!.clientWidth };
      });
      expect(fits.chipRight, JSON.stringify(fits)).toBeLessThanOrEqual(fits.proseRight + 1);
      expect(fits.scroll, JSON.stringify(fits)).toBeLessThanOrEqual(fits.client + 1);
      // Nothing scrolls the page sideways either.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    });
  }
});
