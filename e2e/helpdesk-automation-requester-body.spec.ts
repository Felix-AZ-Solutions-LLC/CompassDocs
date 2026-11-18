import { mkdir } from "node:fs/promises";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, login, api, showWholeConversation } from "./helpers";

// Automations that read the body and change the requester (1.20.33):
//   - a rule built in the editor: a body phrase, "Change the requester from
//     the message" scoped to a web-form forwarder (Create is refused in the
//     form until "Only for messages from" is filled in) and "Copy a value
//     into a field" (Asset tag);
//   - an inbound email from the forwarder whose body says "From: Jane …"
//     ends with Jane as the requester, the activity line in the rule's name
//     and the asset tag copied; the same email from someone else changes
//     nothing;
//   - a pattern condition plus a pattern copy into a choice field, with the
//     Try it box showing the match and its group;
//   - "Change requester" on the requester strip puts it right by hand;
//   - an MCP draft (hd_draft_automation) with the new fields shows as a draft
//     with "What this rule will do".
// Inbound mail is seeded through the inbound webhook, as the other helpdesk
// email specs do. Workspace state touched and put back: the inbound webhook
// (switched on only when off), Outside senders (on for the spec) and the
// Claude connector level (notes while it runs, when it was read only).
// Everything else carries the spec's stamp and is deleted. Licensed rig only.
//
// E2E_SHOTS=<dir> saves the editor, the Try it box and the ticket at 1440
// light and dark.

const slow = expect.configure({ timeout: 60_000 });
const SHOTS = process.env.E2E_SHOTS ?? "";
const DB = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e";

async function licensed(page: Page): Promise<boolean> {
  return (await api(page, "/api/helpdesk/admin/settings")).status !== 402;
}

async function shots(page: Page, name: string) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.screenshot({ path: `${SHOTS}/${name}-1440-light.png` });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/${name}-1440-dark.png` });
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  await page.emulateMedia({ colorScheme: "light" });
}

async function mcp(request: APIRequestContext, token: string, tool: string, args: Record<string, unknown>) {
  const res = await request.post("/api/mcp", {
    headers: { authorization: `Bearer ${token}` },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const text = body.result?.content?.[0]?.text ?? "";
  let out: any = null;
  try {
    out = JSON.parse(text);
  } catch {
    /* a sentence */
  }
  return { isError: body.result?.isError === true, text, out };
}

test("automations from the body: the licence gate holds in the community build", async ({ page }) => {
  await login(page, ADMIN);
  test.skip(await licensed(page), "the helpdesk is licensed here");
  expect((await api(page, "/api/helpdesk/admin/automations")).status).toBe(402);
});

test.describe("automations that read the body and change the requester (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  const stamp = Date.now().toString(36);
  const ALIAS = `help-${stamp}@acme.example`;
  const FORWARDER = `forms-${stamp}@forms.example`;
  const STRANGER = `someone-${stamp}@elsewhere.example`;
  const JANE = `jane-${stamp}@customer.example`;
  const PHRASE = `Submitted via the web form ${stamp}`;
  const teamName = `E2E Web form ${stamp}`;
  const ruleName = `Web form requester ${stamp}`;
  const patternRule = `Impact from the body ${stamp}`;
  const assetLabel = `Asset tag ${stamp}`;
  const impactLabel = `Impact ${stamp}`;
  let teamId = 0;
  const fieldIds: number[] = [];
  const fieldKeys: Record<string, string> = {};
  let hook = "";
  let db: Client;
  let savedSettings: string | null = null;
  let outsideBefore: boolean | null = null;
  let levelBefore: string | null = null;
  let tokenId: number | null = null;
  let janeTicket = 0;

  async function mailIn(page: Page, from: string, subject: string, text: string) {
    const r = await page.request.post(hook, { data: { from: `Web form <${from}>`, to: ALIAS, dmarc: "pass", subject, text, message_id: `<${Date.now()}-${Math.random()}@forms.example>` } });
    expect(r.status(), await r.text()).toBe(200);
    const body = (await r.json()) as { outcome: string; ticket: number };
    expect(body.ticket, JSON.stringify(body)).toBeTruthy();
    return body.ticket;
  }

  test.beforeAll(async () => {
    db = new Client({ connectionString: DB });
    await db.connect();
  });

  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    if (teamId) return;
    const team = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: teamName, icon: "monitor", email_alias: ALIAS, members: [] } });
    expect(team.status, JSON.stringify(team.body)).toBe(201);
    teamId = team.body.team.id;
    for (const [k, body] of [
      ["asset", { label: assetLabel, type: "text", team_ids: [teamId] }],
      ["impact", { label: impactLabel, type: "select", options: [{ label: "High" }, { label: "Low" }], team_ids: [teamId] }],
    ] as const) {
      const f = await api(page, "/api/helpdesk/admin/custom-fields", { method: "POST", body });
      expect(f.status, JSON.stringify(f.body)).toBe(201);
      fieldIds.push(f.body.field.id);
      fieldKeys[k] = f.body.field.key;
    }
    // The inbound webhook (switched on only when it is off), and mail from outside the workspace accepted.
    let s = await api(page, "/api/helpdesk/admin/settings");
    expect(s.status).toBe(200);
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
    await db.query("DELETE FROM hd_tickets WHERE subject LIKE $1", [`%${stamp}%`]);
    await db.query("DELETE FROM hd_automations WHERE name LIKE $1", [`%${stamp}%`]);
    if (fieldIds.length) await db.query("DELETE FROM hd_custom_fields WHERE id = ANY($1)", [fieldIds]);
    if (savedSettings !== null) await db.query("UPDATE settings SET value = $1 WHERE key = 'helpdesk_settings'", [savedSettings]);
    await db.end();
    const page = await browser.newPage();
    await login(page, ADMIN);
    if (savedSettings === null && outsideBefore === false) await api(page, "/api/helpdesk/admin/settings", { method: "PATCH", body: { outside_senders: false } });
    if (levelBefore === "read") await api(page, "/api/helpdesk/admin/claude", { method: "PUT", body: { level: "read" } });
    if (tokenId) await api(page, `/api/account/tokens/${tokenId}`, { method: "DELETE" });
    if (teamId) await api(page, `/api/helpdesk/admin/teams/${teamId}`, { method: "DELETE" });
    await page.close();
  });

  test("a rule built in the editor: a body phrase, the requester from the message scoped to the forwarder, a value copied", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/desk/settings/automations");
    await slow(page.getByRole("heading", { level: 1, name: "Automations" })).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: "New rule" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "New rule" })).toBeVisible();
    await dialog.getByLabel("Name").fill(ruleName);
    // If: a body phrase (Subject and body).
    const body = dialog.getByTestId("rule-subject-body");
    await body.getByLabel("Body contains any of").fill(PHRASE);
    // Then: change the requester from the message.
    const req = dialog.getByTestId("rule-requester");
    await req.getByRole("radio", { name: "From the message" }).click();
    await expect(req.getByRole("radio", { name: "After a label, on the same line" })).toBeChecked();
    await expect(req.getByLabel("Labels")).toHaveValue("From:, Email:");
    // Without the sender scope the form refuses, saying why.
    await dialog.getByRole("button", { name: "Create rule" }).click();
    await expect(req.getByRole("alert")).toContainText("List who these messages come from");
    await req.getByLabel("Only for messages from").fill(FORWARDER);
    // Copy the asset tag into its field.
    const copy = dialog.getByTestId("rule-copy-values");
    await copy.getByRole("button", { name: "Add a value to copy" }).click();
    const row = copy.getByRole("listitem", { name: "Copy 1" });
    await row.getByRole("textbox", { name: "Label", exact: true }).fill("Asset tag:");
    await row.getByLabel("Into").selectOption({ label: `${assetLabel} (Short text)` });
    await expect(row.getByLabel("Only if the field is empty")).toBeChecked();
    await expect(row.getByRole("button", { name: "Remove copy 1" })).toHaveAttribute("data-tt", "Remove");
    await req.scrollIntoViewIfNeeded();
    await shots(page, "automation-requester-editor");
    await dialog.getByRole("button", { name: "Create rule" }).click();
    await slow(page.getByText("Rule created.")).toBeVisible();
    const listed = page.getByRole("listitem").filter({ hasText: ruleName });
    await expect(listed).toContainText("requester from the message");
    await expect(listed).toContainText("copy a value");
    // As saved: the scope, the default labels, the copy.
    const saved = (await db.query("SELECT actions FROM hd_automations WHERE name = $1", [ruleName])).rows[0].actions;
    expect(saved.requester_from_message).toEqual({ find: "label", labels: ["From:", "Email:"], senders: [FORWARDER] });
    expect(saved.copy_values).toEqual([{ from: "body", label: "Asset tag:", field_key: fieldKeys.asset }]);
  });

  test("an email from the forwarder makes Jane the requester, with the activity line; from anyone else nothing changes", async ({ page }) => {
    test.setTimeout(300_000);
    const subject = `Laptop won't start ${stamp}`;
    janeTicket = await mailIn(page, FORWARDER, subject, `${PHRASE}\nFrom: Jane Doe <${JANE}>\nAsset tag: LT-${stamp}\nMy laptop won't start.`);
    const t = await api(page, `/api/helpdesk/tickets/${janeTicket}`);
    expect(t.status).toBe(200);
    expect(t.body.ticket.requester_email).toBe(JANE);
    expect(t.body.ticket.requester_name).toBe("Jane Doe");
    expect(((t.body.custom_fields ?? []) as { key: string; value: unknown }[]).find((f) => f.key === fieldKeys.asset)?.value).toBe(`LT-${stamp}`);

    await page.goto(`/desk/tickets/${janeTicket}`);
    await slow(page.getByRole("heading", { level: 2, name: subject })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("requester-name")).toHaveText("Jane Doe");
    await showWholeConversation(page);
    const line = page.getByText(`changed the requester from Web form (${FORWARDER}) to Jane Doe (${JANE})`);
    await slow(line).toBeVisible();
    await expect(page.locator("li", { has: line }).first()).toContainText(ruleName);
    await shots(page, "automation-requester-ticket");

    // The same email from a sender who isn't the forwarder: the requester stays the sender, and nothing is said.
    const other = await mailIn(page, STRANGER, `Also from the form ${stamp}`, `${PHRASE}\nFrom: Jane Doe <${JANE}>`);
    const o = await api(page, `/api/helpdesk/tickets/${other}`);
    expect(o.body.ticket.requester_email).toBe(STRANGER);
    expect(JSON.stringify(o.body.messages)).not.toContain("changed the requester");
  });

  test("a pattern condition and a pattern copy into a choice field; Try it shows the match and its group", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/desk/settings/automations");
    await slow(page.getByRole("heading", { level: 1, name: "Automations" })).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: "New rule" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill(patternRule);
    const body = dialog.getByTestId("rule-subject-body");
    await body.getByText("Advanced: patterns").click();
    await body.getByLabel("Body matches pattern").fill(`Ref ${stamp}`);
    // Then: copy the impact with a pattern, tried first in the Try it box.
    const copy = dialog.getByTestId("rule-copy-values");
    await copy.getByRole("button", { name: "Add a value to copy" }).click();
    const row = copy.getByRole("listitem", { name: "Copy 1" });
    await row.getByLabel("Find it").selectOption({ label: "With a pattern" });
    await row.getByRole("textbox", { name: "Pattern", exact: true }).fill("Impact:\\s*(\\w+)");
    const tester = row.getByTestId("pattern-tester");
    await tester.getByText("Try it").click();
    await tester.getByLabel("Sample text").fill("Name: Jane\nImpact: HIGH\nThanks");
    const result = tester.getByTestId("pattern-tester-result");
    await expect(result).toContainText("Matches");
    await expect(result).toContainText("Impact: HIGH");
    await expect(result.getByRole("list", { name: "Capture groups" })).toContainText("Group 1: HIGH");
    // An invalid pattern says so in the box, in the same sentence a save gives.
    await row.getByRole("textbox", { name: "Pattern", exact: true }).fill("Impact:\\s*(\\w+");
    await expect(result).toContainText("can't be used: missing closing )");
    await row.getByRole("textbox", { name: "Pattern", exact: true }).fill("Impact:\\s*(\\w+)");
    await tester.scrollIntoViewIfNeeded();
    await shots(page, "automation-try-it");
    await row.getByLabel("Into").selectOption({ label: `${impactLabel} (Pick one)` });
    await dialog.getByRole("button", { name: "Create rule" }).click();
    await slow(page.getByText("Rule created.")).toBeVisible();

    const n = await mailIn(page, FORWARDER, `Printer ${stamp}`, `Ref ${stamp}\nImpact: high\nThe printer is offline.`);
    const t = await api(page, `/api/helpdesk/tickets/${n}`);
    expect(((t.body.custom_fields ?? []) as { key: string; value: unknown }[]).find((f) => f.key === fieldKeys.impact)?.value).toBe("high");
    // A body without the pattern: the rule doesn't match, the field stays empty.
    const m = await mailIn(page, FORWARDER, `Scanner ${stamp}`, `Impact: low\nThe scanner is offline.`);
    const u = await api(page, `/api/helpdesk/tickets/${m}`);
    expect(((u.body.custom_fields ?? []) as { key: string; value: unknown }[]).find((f) => f.key === fieldKeys.impact)?.value ?? null).toBeNull();
  });

  test("Change requester on the requester strip puts it right by hand, keeping the old one as a CC", async ({ page }) => {
    test.setTimeout(300_000);
    expect(janeTicket).toBeGreaterThan(0);
    await page.goto(`/desk/tickets/${janeTicket}`);
    await slow(page.getByTestId("requester-name")).toHaveText("Jane Doe", { timeout: 120_000 });
    const control = page.getByRole("button", { name: "Change requester" });
    await expect(control).toHaveAttribute("data-tt", "Change requester");
    await control.click();
    const panel = page.getByRole("dialog", { name: "Change requester" });
    await expect(panel).toBeVisible();
    const sam = `sam-${stamp}@customer.example`;
    await panel.getByLabel("Or an email address").fill(sam);
    await panel.getByLabel("Keep Jane Doe as a CC").check();
    await panel.getByRole("button", { name: "Change requester" }).click();
    await slow(page.getByText(`${sam} is now the requester.`)).toBeVisible();
    await slow(page.getByTestId("requester-name")).toHaveText(sam);
    await showWholeConversation(page);
    await expect(page.getByText(`changed the requester from Jane Doe (${JANE}) to ${sam}`)).toBeVisible();
    const people = await api(page, `/api/helpdesk/tickets/${janeTicket}/people`);
    expect(JSON.stringify(people.body)).toContain(JANE);
  });

  test("an MCP draft with the new fields shows as a draft, off, with what it will do", async ({ page, request }) => {
    test.setTimeout(300_000);
    levelBefore = (await api(page, "/api/helpdesk/admin/claude")).body.level as string;
    if (levelBefore === "read") expect((await api(page, "/api/helpdesk/admin/claude", { method: "PUT", body: { level: "notes" } })).status).toBe(200);
    const minted = await api(page, "/api/account/tokens", { method: "POST", body: { name: `e2e-automation-body-${stamp}`, scopes: ["read", "write"] } });
    expect(minted.status).toBe(201);
    tokenId = minted.body.record?.id ?? null;
    const token = minted.body.token as string;
    const name = `Claude web form ${stamp}`;
    // Without the sender scope: refused.
    const refused = await mcp(request, token, "hd_draft_automation", { name, event: "ticket_created", actions: { requester_from_message: { find: "first", senders: [] } } });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Only for messages from");
    const r = await mcp(request, token, "hd_draft_automation", {
      name,
      event: "ticket_created",
      conditions: { subject_contains: ["[Web form]"], body_pattern: { pattern: "Asset tag:\\s*\\S+" } },
      actions: {
        requester_from_message: { find: "label", labels: ["Email:"], senders: [FORWARDER] },
        copy_values: [{ from: "body", label: "Asset tag:", field_key: fieldKeys.asset }],
      },
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.out.saved).toBe("draft (switched off, not published)");
    await page.goto(`/desk/settings/automations?id=${r.out.id}`);
    const dialog = page.getByRole("dialog");
    const strip = dialog.getByRole("region", { name: "Draft from Claude" });
    await slow(strip).toBeVisible({ timeout: 120_000 });
    const words = strip.getByTestId("rule-summary");
    await expect(words).toContainText('the subject contains "[Web form]"');
    await expect(words).toContainText(`only for messages from ${FORWARDER}`);
    await expect(words).toContainText(`into ${assetLabel} while it is empty`);
    // The form shows the draft's parts to edit.
    await expect(dialog.getByTestId("rule-requester").getByRole("radio", { name: "From the message" })).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByTestId("rule-requester").getByLabel("Only for messages from")).toHaveValue(FORWARDER);
    await expect(dialog.getByTestId("rule-subject-body").getByLabel("Body matches pattern")).toHaveValue("Asset tag:\\s*\\S+");
    await dialog.getByRole("button", { name: "Close" }).click();
    const listed = page.getByRole("listitem").filter({ hasText: name });
    await expect(listed.getByText("Draft from Claude")).toBeVisible();
    await expect(listed.getByText("Off")).toBeVisible();
  });
});
