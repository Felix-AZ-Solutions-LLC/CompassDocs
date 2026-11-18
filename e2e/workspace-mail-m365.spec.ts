import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { startFakeM365, type FakeM365 } from "../test/helpers/fake-m365";
import { ADMIN, api, login } from "./helpers";

// The workspace's outgoing email through Microsoft 365 (1.20.31), end to end
// on Settings → Notifications → Email against a fake Microsoft on this
// machine (test/helpers/fake-m365): choose Microsoft 365 (email keeps going
// out the old way until it is saved), refusals in plain words (a wrong
// secret, an expired one, an app that may not send), the manual save that
// switches to it, Check connection (nothing sent), the commands that limit
// the app to the sending mailbox with their copy button, Send test email,
// the System diagnostics row, Set up with Microsoft where the enterprise
// build has it (else the Enterprise note), and switching back to SMTP with
// both configurations kept.
//
// It runs only where the app was started with the test seam
// (COMPASSDOCS_M365_MAIL_TEST_BASE=http://127.0.0.1:PORT, lib/helpdesk/m365/graph;
// the one-click flow also COMPASSDOCS_SSO_SETUP_LOGIN_BASE / _GRAPH_BASE at
// <base>/login and <base>/graph): everywhere else it skips itself. Nothing
// here may contact Microsoft.
//
// The email settings are workspace state: written under the advisory lock
// the unit suites use (728351) and put back afterwards.

const stamp = `${Date.now()}`;
const MAILBOX = `compassdocs-${stamp}@acme.example`;
const OTHER = `ceo-${stamp}@acme.example`;
const PAGE = "/admin/notifications/email";
const LOCK = 728351;
const KEYS = [
  "mail_method",
  "mail_m365_tenant",
  "mail_m365_client_id",
  "mail_m365_client_secret",
  "mail_m365_mailbox",
  "mail_m365_from_name",
  "mail_m365_setup",
  "mail_m365_secret_expires",
  "mail_m365_sp_object_id",
  "mail_m365_entra_send",
  "mail_m365_check",
  "smtp_host",
  "smtp_port",
  "smtp_secure",
  "smtp_user",
  "smtp_pass",
  "smtp_from",
];

test.describe.configure({ mode: "serial" });

test.describe("Workspace email through Microsoft 365 (fake Microsoft)", () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e" });
  let fake: FakeM365 | null = null;
  let base = "";
  let ours = false;
  let saved: { key: string; value: string }[] = [];
  // What this run wrote to the audit log is deleted afterwards, and nothing else.
  let runStart = "";
  let adminId = 0;
  let adminEmail = "";

  const ctl = async (op: string, body?: unknown) => (await fetch(`${base}/__fake/${op}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) })).json();
  const card = (page: Page) => page.getByTestId("mail-settings");
  const m365 = (page: Page) => page.getByTestId("mail-m365");
  const method = (page: Page, name: "SMTP" | "Microsoft 365") => page.getByRole("radiogroup", { name: "Send email with" }).getByRole("radio", { name });
  // The rig may hold helpdesk send-from addresses or export schedules from other specs: then the switch asks first.
  const maybeConfirm = async (page: Page) => {
    const d = page.getByRole("dialog");
    if (await d.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false)) await d.getByRole("button", { name: "Switch" }).click();
  };
  const sentAs = async (address: string): Promise<string[]> => ((await ctl("state")).mailboxes as { address: string; sent: string[] }[]).find((m) => m.address === address)?.sent ?? [];

  test.beforeAll(async () => {
    await db.connect();
  });

  test.afterAll(async () => {
    if (ours) {
      await db.query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
      for (const s of saved) await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [s.key, s.value]);
      await db.query("DELETE FROM audit_log WHERE action LIKE 'settings.mail%' AND at >= $1 AND actor_id = $2", [runStart, adminId]);
      await db.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {});
    }
    // The fake Microsoft is the rig's: leave it empty for the next spec.
    if (base) await ctl("reset").catch(() => {});
    await db.end();
    await fake?.close();
  });

  test("choose Microsoft 365, refusals, save, check, limit, test, diagnostics, one click, back to SMTP", async ({ page }) => {
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
    const me = (await db.query("SELECT id, email FROM users WHERE username = $1", [ADMIN.username])).rows[0];
    adminId = me.id;
    adminEmail = String(me.email || "").toLowerCase();
    saved = (await db.query("SELECT key, value FROM settings WHERE key = ANY($1)", [KEYS])).rows;
    // Start as a workspace that sends nothing yet.
    await db.query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
    await ctl("reset");
    await ctl("mailbox", { address: MAILBOX, kind: "shared" });
    await ctl("mailbox", { address: OTHER, kind: "user" });

    // --- Choose Microsoft 365: shown, not yet chosen ---------------------------------------------------
    await page.goto(PAGE);
    await expect(card(page)).toBeVisible({ timeout: 60_000 });
    await expect(card(page)).toHaveAttribute("data-method", "smtp");
    await expect(page.locator("#email").getByText("Not set up", { exact: true })).toBeVisible();
    await method(page, "Microsoft 365").click();
    await expect(method(page, "Microsoft 365")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("mail-draft")).toContainText("Once the Microsoft 365 settings below are saved, email goes out through Microsoft 365 instead.");
    await expect(card(page)).toHaveAttribute("data-method", "smtp");
    await expect(m365(page).getByRole("button", { name: "Save and send through Microsoft 365" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send test email" })).toBeDisabled();

    // --- An app made by hand, with Mail.Send granted in Entra --------------------------------------------
    const made = await ctl("app", { roles: ["Mail.Send"], displayName: "Hand-made mail app" });
    await m365(page).getByLabel("Sending mailbox").fill(MAILBOX);
    const manual = m365(page).getByTestId("mail-m365-manual");
    if (!(await manual.evaluate((d) => (d as HTMLDetailsElement).open))) await manual.locator("summary").click();
    await manual.getByLabel("Tenant ID").fill(made.tenant);
    await manual.getByLabel("Application (client) ID").fill(made.client_id);

    // A wrong secret: Microsoft's refusal, in plain words; nothing saved.
    await manual.getByLabel(/Client secret/).fill("fake~not-the-secret");
    await m365(page).getByRole("button", { name: "Save and send through Microsoft 365" }).click();
    await maybeConfirm(page);
    await expect(m365(page).getByRole("alert")).toHaveText(
      "Microsoft 365 refused the app's sign-in: the client secret is wrong. Paste the secret's Value (not its Secret ID), or create a new one.",
      { timeout: 30_000 }
    );
    expect((await api(page, "/api/admin/mail")).body.m365.configured).toBe(false);

    // The right one: saved, signed in, chosen.
    await manual.getByLabel(/Client secret/).fill(made.secret);
    await m365(page).getByRole("button", { name: "Save and send through Microsoft 365" }).click();
    await maybeConfirm(page);
    await expect(page.getByText("Saved. Email now goes out through Microsoft 365.")).toBeVisible({ timeout: 30_000 });
    await expect(card(page)).toHaveAttribute("data-method", "m365");
    await expect(page.getByTestId("mail-draft")).toHaveCount(0);
    await expect(page.locator("#email").getByText("Set up", { exact: true })).toBeVisible();
    const v = (await api(page, "/api/admin/mail")).body;
    expect([v.method, v.m365.mailbox, v.m365.entra_send, v.m365.has_secret]).toEqual(["m365", MAILBOX, true, true]);
    expect(JSON.stringify(v)).not.toContain(made.secret);

    // Changing the sending mailbox takes the secret again.
    await m365(page).getByLabel("Sending mailbox").fill(OTHER);
    await m365(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(m365(page).getByRole("alert")).toContainText("Enter the client secret again to change the sending mailbox", { timeout: 30_000 });
    await m365(page).getByLabel("Sending mailbox").fill(MAILBOX);

    // --- Check connection: signed in and allowed, nothing sent ------------------------------------------
    const sentBefore = (await sentAs(MAILBOX)).length;
    await m365(page).getByRole("button", { name: "Check connection" }).click();
    await expect(m365(page).getByTestId("mail-check")).toContainText(`Signed in, and the app may send as ${MAILBOX}. Nothing was sent.`, { timeout: 30_000 });
    expect((await sentAs(MAILBOX)).length).toBe(sentBefore);

    // --- Limit the app to the mailbox: the access policy commands, with a copy button --------------------
    const lock = page.getByTestId("mail-lockdown");
    await expect(lock.getByRole("heading", { name: `Limit the app to ${MAILBOX}` })).toBeVisible();
    await expect(lock).toContainText("Mail.Send permission lets an app send as any mailbox in your organisation");
    const commands = lock.getByTestId("mail-commands");
    const short = String(made.client_id).slice(0, 8);
    // Named after the app, so a second CompassDocs in the same tenant makes its own group.
    await expect(commands).toContainText(`New-DistributionGroup -Name 'CompassDocs sending mailbox ${short}' -Alias 'compassdocs-mail-${short}' -Type Security -Members '${MAILBOX}'`);
    await expect(commands).toContainText(`New-ApplicationAccessPolicy -AppId '${made.client_id}' -PolicyScopeGroupId 'CompassDocs sending mailbox ${short}' -AccessRight RestrictAccess -Description 'CompassDocs sending mailbox ${short}'`);
    await expect(commands).toContainText(`Test-ApplicationAccessPolicy -Identity '${MAILBOX}' -AppId '${made.client_id}'`);
    expect(await commands.innerText()).not.toContain('"');
    await expect(lock.getByRole("button", { name: "Copy commands" }).first()).toBeVisible();
    await lock.getByText("Microsoft's newer way: RBAC for Applications").click();
    await expect(lock.getByTestId("mail-commands-rbac")).toContainText(`-Role 'Application Mail.Send' -CustomResourceScope 'CompassDocs sending mailbox ${short}'`);

    // Check connection also tries the admin's own mailbox: before the lock-down the app can send as it too.
    if (adminEmail) {
      await ctl("mailbox", { address: adminEmail, kind: "user" });
      await m365(page).getByRole("button", { name: "Check connection" }).click();
      await expect(lock.getByTestId("mail-not-limited")).toContainText(`Needs attention: the app can also send as ${adminEmail}`, { timeout: 30_000 });
      await expect(page.locator("#email").getByText("Needs attention", { exact: true })).toBeVisible();
    }

    // "The admin ran them": the policy holds the mailbox. Sending still works; another mailbox is refused.
    await ctl("policy", { addresses: [MAILBOX] });
    if (adminEmail) {
      await m365(page).getByRole("button", { name: "Check connection" }).click();
      await expect(lock.getByTestId("mail-limited")).toContainText(`The app can't send as ${adminEmail}: it is limited, as it should be.`, { timeout: 30_000 });
      await expect(page.locator("#email").getByText("Set up", { exact: true })).toBeVisible();
    }

    // --- Send test email ----------------------------------------------------------------------------------
    await page.getByLabel("Send a test to").fill(`me-${stamp}@example.test`);
    await page.getByRole("button", { name: "Send test email" }).click();
    await expect(page.getByText(`Test email sent to me-${stamp}@example.test through Microsoft 365.`)).toBeVisible({ timeout: 30_000 });
    const sent = await sentAs(MAILBOX);
    expect(sent.at(-1)).toContain("This test was sent through Microsoft 365.");
    expect(sent.at(-1)).toMatch(new RegExp(`^From: .*${MAILBOX.replace(/[.]/g, "\\.")}`, "m"));

    // --- System diagnostics: the chosen method, checked -------------------------------------------------------
    await page.goto("/admin");
    const row = page.locator("li", { hasText: "Email (Microsoft 365)" }).first();
    await expect(row).toContainText(`Signed in and allowed to send as ${MAILBOX}.`, { timeout: 60_000 });
    await expect(page.locator("li", { hasText: "Email (SMTP)" })).toHaveCount(0);

    // --- Errors: the app loses Mail.Send; then its secret expires ---------------------------------------------
    await ctl("roles", { roles: [] });
    await page.goto(PAGE);
    await m365(page).getByRole("button", { name: "Check connection" }).click();
    await expect(m365(page).getByTestId("mail-check")).toContainText(`The app isn't allowed to send as ${MAILBOX} (Mail.Send not granted or blocked by an application access policy).`, { timeout: 30_000 });
    await expect(page.locator("#email").getByText("Needs attention", { exact: true })).toBeVisible();
    // The token no longer carries Mail.Send: the page offers the RBAC commands instead.
    await expect(lock.getByTestId("mail-commands")).toContainText("New-ManagementRoleAssignment");
    await page.getByLabel("Send a test to").fill(`me-${stamp}@example.test`);
    await page.getByRole("button", { name: "Send test email" }).click();
    await expect(card(page).getByRole("alert").last()).toContainText(`The app isn't allowed to send as ${MAILBOX}`, { timeout: 30_000 });
    await ctl("roles", { roles: ["Mail.Send"] });
    await ctl("expire");
    await m365(page).getByRole("button", { name: "Check connection" }).click();
    await expect(m365(page).getByTestId("mail-check")).toContainText("Microsoft 365 refused the app's sign-in: the client secret has expired. Create a new secret and paste it here.", { timeout: 30_000 });
    await page.goto("/admin");
    const failing = page.locator("li", { hasText: "Email (Microsoft 365)" }).first();
    await expect(failing).toContainText("Failing", { timeout: 60_000 });
    await expect(failing).toContainText("the client secret has expired");
    await expect(failing.getByRole("link", { name: "Set up Microsoft 365" })).toHaveAttribute("href", "/admin/notifications/email");

    // --- Set up with Microsoft: the enterprise build's, else the Enterprise note ----------------------------------
    await page.goto(PAGE);
    const probe = await api(page, "/api/ee/mail/setup/poll", { method: "POST", body: { setup_id: "none" } });
    if (probe.status === 410) {
      await ctl("reset");
      await ctl("mailbox", { address: MAILBOX, kind: "shared" });
      await ctl("mailbox", { address: OTHER, kind: "user" });
      await m365(page).getByLabel("Sending mailbox").fill(MAILBOX);
      await m365(page).getByRole("button", { name: "Set up with Microsoft" }).click();
      await expect(m365(page).getByText("H7KQ2MZP9")).toBeVisible({ timeout: 60_000 });
      await expect(m365(page).getByRole("status")).toContainText("Done. The app was created in Entra, Mail.Send was granted and the details were filled in.", { timeout: 120_000 });
      await expect(m365(page).getByRole("status")).toContainText(`Next, limit the app to ${MAILBOX} with the commands below.`);
      const state = await ctl("state");
      const apps = (state.apps as { displayName: string; roles: string[]; deleted: boolean; requiredResourceAccess: { resourceAccess: { id: string }[] }[] }[]).filter((a) => !a.deleted);
      expect(apps.map((a) => [a.displayName, a.roles])).toEqual([["CompassDocs Workspace Mail", ["Mail.Send"]]]);
      expect(apps[0].requiredResourceAccess.flatMap((r) => r.resourceAccess.map((x) => x.id))).toEqual(["b633e1c5-b582-4048-a93e-9f11b44c7e96"]);
      const after = (await api(page, "/api/admin/mail")).body;
      expect([after.m365.setup, after.m365.entra_send, after.m365.configured]).toEqual(["one_click", true, true]);
      expect(after.m365.secret_expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      await expect(page.getByTestId("mail-lockdown").getByTestId("mail-commands")).toContainText("New-ApplicationAccessPolicy");
      await page.getByLabel("Send a test to").fill(`me-${stamp}@example.test`);
      await page.getByRole("button", { name: "Send test email" }).click();
      await expect(page.getByText(`Test email sent to me-${stamp}@example.test through Microsoft 365.`)).toBeVisible({ timeout: 30_000 });
    } else {
      await expect(m365(page).getByTestId("mail-one-click-enterprise")).toContainText("Set up with Microsoft creates the app, grants it Mail.Send and fills this in for you in Enterprise.");
      await expect(m365(page).getByRole("button", { name: "Set up with Microsoft" })).toHaveCount(0);
      // Back to a secret that works, for what follows.
      const fresh = await ctl("app", { roles: ["Mail.Send"] });
      await ctl("mailbox", { address: MAILBOX, kind: "shared" }).catch(() => {});
      const man = m365(page).getByTestId("mail-m365-manual");
      await man.getByLabel("Application (client) ID").fill(fresh.client_id);
      await man.getByLabel(/Client secret/).fill(fresh.secret);
      await m365(page).getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Microsoft 365 settings saved.")).toBeVisible({ timeout: 30_000 });
    }

    // --- Back to SMTP: shown first, chosen once saved; Microsoft 365 is kept ------------------------------------
    await method(page, "SMTP").click();
    await expect(page.getByTestId("mail-draft")).toContainText("Email still goes out through Microsoft 365.");
    const smtp = page.getByTestId("mail-smtp");
    await smtp.getByLabel("SMTP host").fill("127.0.0.1");
    await smtp.getByLabel("Port").fill("2525");
    await smtp.getByLabel("From address").fill(`docs-${stamp}@acme.example`);
    await smtp.getByRole("button", { name: "Save and send by SMTP" }).click();
    await expect(page.getByText("SMTP settings saved. Email now goes out by SMTP.")).toBeVisible({ timeout: 30_000 });
    await expect(card(page)).toHaveAttribute("data-method", "smtp");
    const back = (await api(page, "/api/admin/mail")).body;
    expect([back.method, back.m365.configured, back.m365.mailbox]).toEqual(["smtp", true, MAILBOX]);
    // Microsoft 365 is set up, so choosing it again switches, after saying what changes: the From is not the SMTP one.
    await method(page, "Microsoft 365").click();
    const ask = page.getByRole("dialog");
    await expect(ask.getByTestId("mail-switch-warnings")).toContainText(`Email now comes from docs-${stamp}@acme.example. Through Microsoft 365 it comes from ${MAILBOX} instead.`, { timeout: 30_000 });
    await ask.getByRole("button", { name: "Switch" }).click();
    await expect(page.getByText("Email now goes out through Microsoft 365.")).toBeVisible({ timeout: 30_000 });
    await expect(card(page)).toHaveAttribute("data-method", "m365");
    await expect(m365(page).getByLabel("Sending mailbox")).toHaveValue(MAILBOX);
    await method(page, "SMTP").click();
    await expect(card(page)).toHaveAttribute("data-method", "smtp");
    await page.goto("/admin");
    await expect(page.locator("li", { hasText: "Email (SMTP)" }).first()).toContainText("Configured for 127.0.0.1:2525.", { timeout: 60_000 });

    // Audited.
    const actions = (await db.query("SELECT action FROM audit_log WHERE action LIKE 'settings.mail%' AND at >= $1 AND actor_id = $2", [runStart, adminId])).rows.map((r) => r.action);
    for (const a of ["settings.mail_m365", "settings.mail_method", "settings.mail_test", "settings.mail_check"]) expect(actions).toContain(a);
  });
});
