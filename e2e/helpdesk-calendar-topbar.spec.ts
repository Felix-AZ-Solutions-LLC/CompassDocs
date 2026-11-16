import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";
import {
  allDayToday,
  allDayTodayLabel,
  badgeWords,
  nextTimedEvent,
  todayLeft,
  upcomingDays,
  type HdUpcomingEvents,
} from "../src/lib/helpdesk/desk-calendar-upcoming-shared";

// Upcoming events in the desk's top bar and today's count on the Calendar
// rail icon (1.20.24). Three events on a team's tickets: a short one running
// now (it ends three minutes in), a timed one later and an all-day one over
// three days from today. The pill shows the nearest timed event ("Now" while
// it runs); its menu lists the days with the All day rows first ("Day 1 of
// 3"), says "Today: N all-day events", closes on Escape and opens a day in
// the Calendar. The rail's Calendar icon counts today's timed events left;
// the browser's clock (page.clock) is moved past the short event's end and
// the count drops with no reload. What is expected is worked out from the
// endpoint's own answer with the shared rules, so another spec's events on
// the rig can't make it flaky. Licensed rig only: the community build
// asserts the licence gate. Everything it makes is removed afterwards.

const slow = expect.configure({ timeout: 60_000 });

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/settings")).status !== 402;
}

test("calendar top bar: the licence gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  test.skip(await licensed(page), "the helpdesk is licensed here; the gate is not shown");
  expect((await api(page, "/api/helpdesk/calendar/upcoming")).status).toBe(402);
});

test.describe("calendar top bar (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  const stamp = Date.now().toString(36);
  let teamId = 0;
  const tickets: number[] = [];

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    if (!teamId) {
      const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `E2E Topbar ${stamp}`, icon: "building", members: [] } });
      expect(team.status, JSON.stringify(team.body)).toBe(201);
      teamId = team.body.team.id;
    }
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    for (const n of new Set(tickets)) await api(page, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await page.close();
  });

  async function eventTicket(page: Page, subject: string, event: Record<string, unknown>): Promise<number> {
    const t = await api(page, "/api/helpdesk/tickets", { method: "POST", body: { subject: `${subject} ${stamp}`, body: "On the calendar.", team_id: teamId, priority: "normal" } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const n = t.body.ticket.number as number;
    tickets.push(n);
    const put = await api(page, `/api/helpdesk/tickets/${n}/event`, { method: "PUT", body: event });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    return n;
  }

  test("the pill shows the nearest timed event, the menu groups by day with All day first, and the rail count drops when an event ends", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const before = await api(page, "/api/helpdesk/calendar/upcoming");
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    const { today, timezone: tz } = before.body as HdUpcomingEvents;
    const minute = 60_000;
    const t0 = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    // The short one started ten minutes ago and ends three minutes from now (to the second, so the clock can be moved past it).
    const standupEnd = Math.floor((t0 + 3 * minute) / 1000) * 1000;
    const standup = await eventTicket(page, "Standup", { starts_at: iso(t0 - 10 * minute), ends_at: iso(standupEnd) });
    const freeze = await eventTicket(page, "Change freeze", { starts_at: iso(t0 + 40 * minute), ends_at: iso(t0 + 70 * minute) });
    const conference = await eventTicket(page, "Conference", { all_day: true, start_date: today, end_date: addDays(today, 2), timezone: tz });

    const data = (await api(page, "/api/helpdesk/calendar/upcoming")).body as HdUpcomingEvents;
    const numbers = data.events.map((e) => e.number);
    expect(numbers).toEqual(expect.arrayContaining([standup, freeze, conference]));

    // The browser's clock starts at the real time and runs; it is moved on below.
    await page.clock.install({ time: new Date() });
    await page.goto("/desk");

    // The pill: the nearest timed event (never the all-day one); ours runs now.
    const pill = page.getByTestId("upcoming-pill");
    const next = nextTimedEvent(data.events, Date.now())!;
    await slow(pill).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("upcoming-pill-subject")).toHaveText(next.subject);
    if (next.number === standup) await expect(page.getByTestId("upcoming-pill-when")).toHaveText("Now");
    await expect(pill).not.toContainText(`Conference ${stamp}`);

    // The rail: today's timed events still to end.
    const rail = page.getByRole("navigation", { name: "Desk" }).getByRole("link", { name: /^Calendar/ });
    const label = (n: number) => (n > 0 ? `Calendar, ${n} ${badgeWords(n)}` : "Calendar");
    const countNow = todayLeft(data.events, Date.now(), data.timezone);
    expect(countNow).toBeGreaterThanOrEqual(1);
    await slow(rail).toHaveAttribute("aria-label", label(countNow));
    await expect(rail).toContainText(String(countNow > 99 ? "99+" : countNow));

    // The menu: by day, All day rows first, "Today: N all-day events", our three events.
    await pill.click();
    const menu = page.getByRole("menu", { name: "Upcoming events" });
    await expect(menu).toBeVisible();
    await expect(page.getByTestId("upcoming-allday-today")).toHaveText(allDayTodayLabel(allDayToday(data.events, Date.now(), data.timezone)));
    const expected = upcomingDays(data.events, Date.now(), data.timezone, data.horizon_days);
    await expect(menu.getByTestId("upcoming-day")).toHaveCount(expected.length);
    const todayGroup = menu.getByRole("group", { name: "Today" });
    await expect(todayGroup.getByTestId("upcoming-allday").filter({ hasText: `Conference ${stamp}` })).toContainText("Day 1 of 3");
    await expect(todayGroup.getByTestId("upcoming-timed").filter({ hasText: `Standup ${stamp}` })).toContainText("Now");
    // Within the day the All day rows come before the timed ones.
    const kinds = await todayGroup.getByRole("menuitem").evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
    expect(kinds.lastIndexOf("upcoming-allday")).toBeLessThan(kinds.indexOf("upcoming-timed"));
    // A later day shows the conference's next day.
    await expect(menu.getByRole("group", { name: "Tomorrow" }).getByTestId("upcoming-allday").filter({ hasText: `Conference ${stamp}` })).toContainText("Day 2 of 3");
    await expect(menu.getByRole("menuitem", { name: "Open calendar" })).toBeVisible();
    // Keyboard: focus is in the menu, arrows walk it, Escape closes it and gives focus back.
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(pill).toBeFocused();

    // The short event ends: the count drops and the pill moves on, with no reload.
    await page.clock.fastForward(standupEnd - Date.now() + 2_000);
    const later = standupEnd + 2_000;
    await slow(rail).toHaveAttribute("aria-label", label(todayLeft(data.events, later, data.timezone)));
    expect(todayLeft(data.events, later, data.timezone)).toBeLessThan(countNow);
    const after = nextTimedEvent(data.events, later)!;
    await expect(page.getByTestId("upcoming-pill-subject")).toHaveText(after.subject);
    await expect(pill).not.toContainText(`Standup ${stamp}`);

    // An event opens its day in the Calendar, for all teams, even with the Calendar already open on another view;
    // following the link never changes what the Calendar remembers.
    const prefsBefore = (await api(page, "/api/helpdesk/calendar/prefs")).body.prefs;
    await page.goto("/desk/calendar?view=month");
    await slow(page.getByTestId("calendar-title")).toBeVisible();
    await pill.click();
    const link = menu.getByTestId("upcoming-allday").filter({ hasText: `Conference ${stamp}` }).first();
    await expect(link).toHaveAttribute("href", `/desk/calendar?view=day&date=${today}&team=0`);
    await link.click();
    await slow(page).toHaveURL(new RegExp(`/desk/calendar\\?view=day&date=${today}`));
    await slow(page.getByTestId("calendar-title")).toHaveText(new RegExp(String(Number(today.slice(8)))));
    await page.waitForTimeout(1_500); // past the page's 400 ms prefs save, were there one
    expect((await api(page, "/api/helpdesk/calendar/prefs")).body.prefs).toEqual(prefsBefore);
  });
});

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
