import { mkdir } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, login, api, showWholeConversation } from "./helpers";

// Hold until the event (1.20.34, lib/helpdesk/desk-calendar-park):
//   - a ticket with an event three months out: the Event block's Hold until
//     the event opens the dialog with the wake date; held, the header shows
//     the Parked chip, the status reads On hold, the ticket leaves All open
//     and is listed in the Parked view with its wake and event dates and a
//     count; Wake now brings it back; parked again and its wake time put in
//     the past (in the database, as other specs move time), the server's
//     minute sweep wakes it with "Woke for the event on …";
//   - a meeting invite emailed to the team's address opens a ticket that is
//     answered and then parks itself; an updated invite (same UID, a later
//     SEQUENCE) threads into the same ticket and moves its wake date; a
//     cancellation wakes it with "The event was cancelled. Close this ticket
//     if nothing else is needed.";
//   - the requester's own request, parked, reads "Scheduled · …" in Get help.
// Inbound mail is seeded through the inbound webhook, as the other helpdesk
// email specs do (the webhook switched on only when off, Outside senders on
// for the spec and put back). Licensed rig only: the community build asserts
// the licence gate. Everything carries the spec's stamp and is removed.
//
// E2E_SHOTS=<dir> saves the parked ticket and the Parked view at 1440.

const slow = expect.configure({ timeout: 60_000 });
const SHOTS = process.env.E2E_SHOTS ?? "";
const DB = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e";

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/settings")).status !== 402;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.screenshot({ path: `${SHOTS}/${name}-1440-light.png` });
}

test("event parking: the licence gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  test.skip(await licensed(page), "the helpdesk is licensed here");
  expect((await api(page, "/api/helpdesk/tickets/1/event/park")).status).toBe(402);
});

test.describe("hold until the event (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  const stamp = Date.now().toString(36);
  const ALIAS = `rooms-${stamp}@acme.example`;
  const ORGANISER = `pa-${stamp}@customer.example`;
  const teamName = `E2E Parking ${stamp}`;
  const UID = `${stamp}-booking@calendar.example`;
  let teamId = 0;
  let hook = "";
  let db: Client;
  let savedSettings: string | null = null;
  let outsideBefore: boolean | null = null;
  const tickets: number[] = [];
  let inviteTicket = 0;

  // Three months out at 10:00 UTC (the rig's workspace zone), and the same two weeks later.
  const start = new Date(Date.now() + 90 * 86_400_000);
  start.setUTCHours(10, 0, 0, 0);
  const moved = new Date(start.getTime() + 14 * 86_400_000);
  const ics = (method: string, seq: number, at: Date) => {
    const s = (d: Date) => d.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    return [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      `METHOD:${method}`,
      "BEGIN:VEVENT",
      `UID:${UID}`,
      `SEQUENCE:${seq}`,
      `DTSTAMP:${s(new Date(Date.now() + seq * 60_000))}`,
      `ORGANIZER:mailto:${ORGANISER}`,
      `DTSTART:${s(at)}`,
      `DTEND:${s(new Date(at.getTime() + 2 * 3_600_000))}`,
      "SUMMARY:Conference room booking",
      "LOCATION:Room 4",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
  };

  // The first invite carries Pat's words; an update or a cancellation only the calendar app's own text (a written
  // message in an update would wake the ticket so it's read).
  async function mailIn(page: Page, subject: string, calendar: string, text = "Please book the room.") {
    const r = await page.request.post(hook, { data: { from: `Pat <${ORGANISER}>`, to: ALIAS, dmarc: "pass", subject, text, calendar, message_id: `<${Date.now()}-${Math.random()}@customer.example>` } });
    expect(r.status(), await r.text()).toBe(200);
    return (await r.json()) as { outcome: string; ticket: number };
  }
  const ticketOf = async (page: Page, n: number) => (await api(page, `/api/helpdesk/tickets/${n}`)).body;

  test.beforeAll(async () => {
    db = new Client({ connectionString: DB });
    await db.connect();
  });

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    if (teamId) return;
    const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: teamName, icon: "building", email_alias: ALIAS, members: [] } });
    expect(team.status, JSON.stringify(team.body)).toBe(201);
    teamId = team.body.team.id;
    let s = await api(page, "/api/helpdesk/admin/settings");
    outsideBefore = s.body.settings?.outside_senders ?? s.body.outside_senders ?? null;
    if (!s.body.inbound_path) {
      savedSettings = (await db.query("SELECT value FROM settings WHERE key = 'helpdesk_settings'")).rows[0]?.value ?? null;
      s = await api(page, "/api/helpdesk/admin/settings", { method: "PATCH", body: { rotate_inbound_secret: true } });
      expect(s.status, JSON.stringify(s.body)).toBe(200);
    }
    hook = s.body.inbound_path as string;
    expect((await api(page, "/api/helpdesk/admin/settings", { method: "PATCH", body: { outside_senders: true } })).status).toBe(200);
  });

  test.afterAll(async ({ browser }) => {
    await db.query("DELETE FROM hd_tickets WHERE subject LIKE $1 OR team_id = $2", [`%${stamp}%`, teamId || -1]);
    if (savedSettings !== null) await db.query("UPDATE settings SET value = $1 WHERE key = 'helpdesk_settings'", [savedSettings]);
    await db.end();
    const page = await browser.newPage();
    await login(page, ADMIN);
    if (savedSettings === null && outsideBefore === false) await api(page, "/api/helpdesk/admin/settings", { method: "PATCH", body: { outside_senders: false } });
    for (const n of new Set(tickets)) await api(page, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await page.close();
  });

  test("Hold until the event from the Event block, the Parked chip, the Parked view, Wake now, and the sweep waking it", async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const t = await api(page, "/api/helpdesk/tickets", { method: "POST", body: { subject: `Annual conference room setup ${stamp}`, body: "Room 4 for the March conference.", team_id: teamId, priority: "normal" } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const n = t.body.ticket.number as number;
    tickets.push(n);
    const ev = await api(page, `/api/helpdesk/tickets/${n}/event`, { method: "PUT", body: { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 7_200_000).toISOString(), place: "Room 4", setup_minutes: 60 } });
    expect(ev.status, JSON.stringify(ev.body)).toBe(200);

    await page.goto(`/desk/tickets/${n}`);
    const card = page.getByTestId("event-card");
    await slow(card).toBeVisible({ timeout: 120_000 });
    const dialog = page.getByTestId("park-dialog");
    await expect(async () => {
      await card.getByRole("button", { name: "Hold until the event" }).click();
      await expect(dialog).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 90_000 });
    await expect(dialog.getByTestId("park-prep-days")).toHaveValue("10");
    await slow(dialog.getByTestId("park-preview")).toContainText("It wakes");
    const [post] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/helpdesk/tickets/${n}/event/park`) && r.request().method() === "POST"),
      dialog.getByTestId("park-save").click(),
    ]);
    expect(post.status(), JSON.stringify(await post.json())).toBe(200);
    await slow(dialog).toHaveCount(0);

    // The header: the chip with its two actions; the status reads On hold.
    const chip = page.getByTestId("parked-chip");
    await slow(chip).toContainText(/^Parked until \w{3} \d{1,2} \w{3}( \d{4})? · for the event on \w{3} \d{1,2} \w{3}/);
    await expect(page.getByRole("button", { name: "Status: On hold" })).toBeVisible();
    await expect(page.getByTestId("park-wake")).toBeVisible();
    await expect(page.getByTestId("park-change-prep")).toBeVisible();
    await showWholeConversation(page);
    await slow(page.getByText(/parked the ticket until .* for the event on /)).toBeVisible();
    const parked = await ticketOf(page, n);
    expect(parked.ticket.status).toBe("on_hold");
    expect(parked.parking.parked_until).toBeTruthy();
    await shot(page, "event-parking-ticket");

    // The queue: not in All open; listed in Parked with its dates, and counted.
    expect(((await api(page, `/api/helpdesk/tickets?view=open&team=${teamId}`)).body.tickets as { number: number }[]).some((r) => r.number === n)).toBe(false);
    await page.goto(`/desk?view=parked`);
    const row = page.locator(`li[data-number="${n}"]`);
    await slow(row).toBeVisible({ timeout: 120_000 });
    await expect(row).toContainText("Parked");
    await expect(row.getByTestId("parked-row-when")).toContainText(/^Wakes .* · event /);
    const rail = page.getByRole("link", { name: /^Parked/ }).first();
    await expect(rail).toContainText(/\d/);
    await shot(page, "event-parking-view");

    // Wake now.
    await page.goto(`/desk/tickets/${n}`);
    await slow(page.getByTestId("park-wake")).toBeVisible({ timeout: 120_000 });
    await page.getByTestId("park-wake").click();
    await slow(page.getByTestId("parked-chip")).toHaveCount(0);
    expect((await ticketOf(page, n)).ticket.status).toBe("open");

    // Parked again, its wake time put in the past: the server's minute sweep wakes it.
    expect((await api(page, `/api/helpdesk/tickets/${n}/event/park`, { method: "POST", body: { action: "park" } })).status).toBe(200);
    await db.query("UPDATE hd_tickets SET parked_until = now() - interval '1 minute' WHERE number = $1", [n]);
    await expect.poll(async () => (await ticketOf(page, n)).ticket.status, { timeout: 180_000, intervals: [5_000] }).toBe("open");
    const msgs = (await ticketOf(page, n)).messages as { body: string }[];
    expect(msgs.some((m) => m.body.startsWith("Woke for the event on "))).toBe(true);
  });

  test("a meeting invite: answered, then parked; an updated invite moves the wake date on the same ticket; a cancellation wakes it", async ({ page }) => {
    test.setTimeout(300_000);
    const first = await mailIn(page, `Conference room booking ${stamp}`, ics("REQUEST", 0, start));
    expect(first.outcome).toBe("created");
    inviteTicket = first.ticket;
    tickets.push(inviteTicket);
    let t = await ticketOf(page, inviteTicket);
    expect(t.ticket.status).toBe("on_hold");
    expect(t.parking.reason).toBe("invite");
    const wake1 = Date.parse(t.parking.parked_until);
    const lines = (t.messages as { body: string }[]).map((m) => m.body);
    expect(lines.findIndex((b) => b.startsWith("Parked until "))).toBeGreaterThan(lines.findIndex((b) => b.startsWith("Event added from the meeting invite")));

    const upd = await mailIn(page, `Updated: Conference room booking ${stamp}`, ics("REQUEST", 1, moved), "This event has been updated.");
    expect([upd.outcome, upd.ticket]).toEqual(["appended", inviteTicket]);
    t = await ticketOf(page, inviteTicket);
    expect(t.ticket.status).toBe("on_hold");
    expect(Date.parse(t.parking.parked_until)).toBeGreaterThan(wake1);
    expect(t.event.starts_at).toBe(moved.toISOString());

    await page.goto(`/desk/tickets/${inviteTicket}`);
    await slow(page.getByTestId("parked-chip")).toBeVisible({ timeout: 120_000 });

    const cancel = await mailIn(page, `Canceled: Conference room booking ${stamp}`, ics("CANCEL", 2, moved), "This event has been cancelled.");
    expect([cancel.outcome, cancel.ticket]).toEqual(["appended", inviteTicket]);
    t = await ticketOf(page, inviteTicket);
    expect(t.ticket.status).toBe("open");
    expect(t.event.cancelled).toBe(true);
    expect((t.messages as { body: string }[]).some((m) => m.body === "The event was cancelled. Close this ticket if nothing else is needed.")).toBe(true);
  });

  test("the requester's own parked request reads Scheduled in Get help", async ({ page }) => {
    test.setTimeout(300_000);
    const made = await api(page, "/api/helpdesk/requests", { method: "POST", body: { subject: `Board dinner ${stamp}`, body: "The private room for twelve, please." } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const n = made.body.ticket.number as number;
    tickets.push(n);
    expect((await api(page, `/api/helpdesk/tickets/${n}`, { method: "PATCH", body: { team_id: teamId } })).status).toBe(200);
    expect((await api(page, `/api/helpdesk/tickets/${n}/event`, { method: "PUT", body: { starts_at: start.toISOString(), place: "Room 4" } })).status).toBe(200);
    expect((await api(page, `/api/helpdesk/tickets/${n}/event/park`, { method: "POST", body: { action: "park" } })).status).toBe(200);
    await page.goto(`/help/requests/${n}`);
    const chip = page.getByTestId("scheduled-chip");
    await slow(chip).toBeVisible({ timeout: 120_000 });
    await expect(chip).toContainText(/^Scheduled · \w{3} \d{1,2} \w{3}( \d{4})?, \d{1,2}:\d{2}( [AP]M)? · Room 4$/);
    await expect(page.getByText("On hold", { exact: true })).toHaveCount(0);
  });
});
