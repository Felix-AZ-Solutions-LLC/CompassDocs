import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { ADMIN, login, api } from "./helpers";

// Filtering the queue by a custom field, and Export CSV (1.20.8). A team of
// its own, a "Pick one" field for it and three tickets (Laptop, Phone,
// Desktop). The queue's Filter dialog: start from every ticket, pick the
// team, add the custom field, tick Laptop and Phone; the list narrows to two
// and the filter strip says "Device type …: Laptop, Phone". Saved as a
// personal view, reopened from the views column, its Edit view dialog holds
// the condition. Export CSV downloads the view's tickets: the header row
// starts with the fixed columns and ends with the field's label, and a row
// holds "Laptop". Licensed rig only. Everything it makes (team, field,
// tickets, view) is its own and is deleted afterwards; the field is assigned
// to its own team only.
//
// E2E_SHOTS=<dir> also saves light screenshots at 1440.

const slow = expect.configure({ timeout: 60_000 });
const SHOTS = process.env.E2E_SHOTS ?? "";
const FIELDS_API = "/api/helpdesk/admin/custom-fields";

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/settings")).status !== 402;
}

test.describe("custom field filter and CSV export (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  const stamp = Date.now().toString(36);
  const teamName = `E2E CF Filter ${stamp}`;
  const label = `Device type ${stamp}`;
  let teamId = 0;
  let fieldKey = "";
  const tickets: Record<string, number> = {};
  const viewIds: number[] = [];

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    if (teamId) return;
    const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: teamName, icon: "monitor", members: [] } });
    expect(team.status, JSON.stringify(team.body)).toBe(201);
    teamId = team.body.team.id;
    const f = await api(page, FIELDS_API, { method: "POST", body: { label, type: "select", options: [{ label: "Laptop" }, { label: "Phone" }, { label: "Desktop" }], team_ids: [teamId] } });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    fieldKey = f.body.field.key;
    for (const [name, value] of [
      ["Dock drops the second screen", "laptop"],
      ["Mail app crashes on start", "phone"],
      ["Tower fan is loud", "desktop"],
    ] as const) {
      const t = await api(page, "/api/helpdesk/tickets", { method: "POST", body: { subject: `${name} ${stamp}`, body: "Since this morning.", team_id: teamId, priority: "normal" } });
      expect(t.status, JSON.stringify(t.body)).toBe(201);
      const n = t.body.ticket.number as number;
      tickets[value] = n;
      const p = await api(page, `/api/helpdesk/tickets/${n}`, { method: "PATCH", body: { custom_fields: { [fieldKey]: value } } });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
    }
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    for (const id of viewIds) await api(page, `/api/helpdesk/views/${id}`, { method: "DELETE" });
    for (const n of Object.values(tickets)) await api(page, `/api/helpdesk/tickets/${n}`, { method: "DELETE" });
    const fields = await api(page, FIELDS_API);
    for (const f of fields.body?.fields ?? []) if (String(f.label).includes(stamp)) await api(page, `${FIELDS_API}/${f.id}`, { method: "DELETE" });
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await page.close();
  });

  test("filter by a custom field, see the strip and the narrowed list, save and reopen the view, export it as CSV", async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/desk?team=${teamId}`);
    const filterBtn = page.getByRole("button", { name: "Filter tickets" });
    const filter = page.getByRole("dialog", { name: "Filter tickets" });
    // The busy dev rig may still be hydrating: click until the dialog opens.
    await expect(async () => {
      await filterBtn.click();
      await expect(filter).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 120_000 });
    await filter.getByLabel("Start from").selectOption("all");
    await filter.getByLabel("Team").selectOption({ label: teamName });
    const add = filter.getByLabel("Add a custom field");
    await slow(add).toBeVisible();
    await add.selectOption({ label });
    const row = filter.getByTestId(`cf-row-${fieldKey}`);
    await expect(row).toContainText(label);
    // Showing the list with nothing ticked says what is missing.
    await filter.getByRole("button", { name: "Show list" }).click();
    await expect(row.getByText("Tick at least one.")).toBeVisible();
    await row.getByLabel("Laptop").check();
    await row.getByLabel("Phone").check();
    await expect(filter).toContainText(`${label}: Laptop, Phone`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/filter-dialog-custom-field-1440-light.png` });
    await filter.getByRole("button", { name: "Show list" }).click();
    await slow(page).toHaveURL(new RegExp(`from=filter.*cf\\.${fieldKey}=any%3Alaptop%2Cphone`));

    // The strip shows the condition as a chip; the list holds the two tickets and not the third.
    const chip = page.getByTestId("cf-chip");
    await slow(chip).toContainText(`${label}: Laptop, Phone`);
    await expect(chip.getByRole("link", { name: `Remove the condition ${label}: Laptop, Phone` })).toHaveAttribute("data-tt", "Remove");
    const list = page.getByRole("region", { name: /Filtered tickets/ });
    await slow(list.getByRole("link", { name: new RegExp(`Dock drops the second screen ${stamp}`) })).toBeVisible();
    await expect(list.getByRole("link", { name: new RegExp(`Mail app crashes on start ${stamp}`) })).toBeVisible();
    await expect(list.getByRole("link", { name: new RegExp(`Tower fan is loud ${stamp}`) })).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/queue-custom-field-strip-1440-light.png` });

    // Save it as a personal view and open it again from the views column.
    await page.getByRole("button", { name: "Save view" }).click();
    const save = page.getByRole("dialog", { name: "Save this view" });
    await expect(save).toContainText(`${label}: Laptop, Phone`);
    await save.getByLabel("Name").fill(`Laptops and phones ${stamp}`);
    const only = save.getByRole("radio", { name: "Only me" });
    if (await only.count()) await only.check();
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/helpdesk/views") && r.request().method() === "POST");
    await save.getByRole("button", { name: "Save view" }).click();
    const res = await saved;
    expect(res.status()).toBe(201);
    const view = (await res.json()).view as { id: number; filters: Record<string, string> };
    viewIds.push(view.id);
    expect(view.filters[`cf.${fieldKey}`]).toBe("any:laptop,phone");

    await page.goto("/desk");
    const nav = page.getByRole("navigation", { name: "Ticket views" });
    const link = nav.getByRole("link", { name: new RegExp(`Laptops and phones ${stamp}`) });
    await slow(link).toBeVisible({ timeout: 120_000 });
    await link.click();
    await slow(page).toHaveURL(new RegExp(`saved=${view.id}`));
    await slow(page.getByRole("link", { name: new RegExp(`Dock drops the second screen ${stamp}`) })).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(`Tower fan is loud ${stamp}`) })).toHaveCount(0);
    await expect(link).toContainText(/2\s*tickets/);
    // Its Edit view dialog holds the condition as it was saved.
    await page.getByRole("button", { name: `Edit the view Laptops and phones ${stamp}` }).click();
    const edit = page.getByRole("dialog", { name: `Edit "Laptops and phones ${stamp}"` });
    const editRow = edit.getByTestId(`cf-row-${fieldKey}`);
    await slow(editRow).toBeVisible();
    await expect(editRow.getByLabel("Laptop")).toBeChecked();
    await expect(editRow.getByLabel("Phone")).toBeChecked();
    await expect(editRow.getByLabel("Desktop")).not.toBeChecked();
    await edit.getByRole("button", { name: "Cancel" }).click();

    // Export CSV: the view's tickets, with a column for the field.
    const exportBtn = page.getByRole("button", { name: "Export these tickets as CSV" });
    await expect(exportBtn).toHaveAttribute("data-tt", "Export CSV");
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), exportBtn.click()]);
    expect(download.suggestedFilename()).toMatch(/^tickets-\d{4}-\d{2}-\d{2}\.csv$/);
    const text = readFileSync(await download.path(), "utf8");
    expect(text.charCodeAt(0), "a BOM for Excel").toBe(0xfeff);
    const lines = text.slice(1).split("\r\n").filter(Boolean);
    const header = lines[0];
    expect(header.startsWith('"Number","Subject","Status","Priority","Team","Owner"')).toBe(true);
    expect(header).toContain(`"${label}"`);
    expect(lines).toHaveLength(3);
    const laptop = lines.find((l) => l.startsWith(`${tickets.laptop},`));
    expect(laptop, "the Laptop ticket's row").toBeTruthy();
    expect(laptop!.endsWith(',"Laptop"') || laptop!.includes(',"Laptop",')).toBe(true);
    expect(lines.some((l) => l.startsWith(`${tickets.desktop},`))).toBe(false);
    await slow(page.getByText("Exported 2 tickets.")).toBeVisible();
  });
});
