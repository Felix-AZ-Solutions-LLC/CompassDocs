import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, login } from "./helpers";

// Settings → Domain & HTTPS (1.20.29): a custom domain that didn't pass its
// check waits under the field with the reason, the DNS answer and what
// happens next, and offers Check again, Use it anyway (behind a warning
// dialog) and Keep the current address.
//
// The e2e rig has no bundled Caddy, so nothing is checked or pushed for
// real: the pending domain is written to the settings table as the check
// would leave it, and the spec drives the page around it. It never runs the
// check itself (that would ask real DNS). Every setting it touches is put
// back afterwards.

const PENDING_KEY = "custom_domain_pending";
const DOMAIN = "docs-e2e-pending.example.com";
const REASON = `${DOMAIN} doesn't exist in DNS yet (no record found).`;

function pendingRow(now = Date.now()) {
  return JSON.stringify({
    domain: DOMAIN,
    tls_mode: "auto",
    tls_email: "",
    requested_at: new Date(now - 60_000).toISOString(),
    requested_by: { id: null, name: "e2e" },
    auto_until: new Date(now + 23 * 3600_000).toISOString(),
    next_check_at: new Date(now + 4 * 60_000).toISOString(),
    attempts: 1,
    last_check: {
      ok: false,
      code: "nxdomain",
      domain: DOMAIN,
      addresses: [],
      cname: null,
      tried: [],
      http_status: null,
      message: REASON,
      checked_at: new Date(now - 60_000).toISOString(),
    },
  });
}

test.describe("Domain & HTTPS: a domain waiting for its check", () => {
  test.describe.configure({ mode: "serial" });
  let db: Client;
  const saved = new Map<string, string | null>();

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e" });
    await db.connect();
    for (const key of [PENDING_KEY, "custom_domain", "tls_mode", "tls_email"]) {
      const r = await db.query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key]);
      saved.set(key, r.rows[0]?.value ?? null);
    }
  });
  test.afterAll(async () => {
    for (const [key, value] of saved) {
      if (value === null) await db.query("DELETE FROM settings WHERE key = $1", [key]);
      else
        await db.query(
          "INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
          [key, value]
        );
    }
    await db.end();
  });
  test.beforeEach(async () => {
    await db.query(
      "INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [PENDING_KEY, pendingRow()]
    );
  });

  test("the card says why, what still serves and what happens next", async ({ page }) => {
    await login(page, ADMIN);
    await page.goto("/admin/domain");
    const card = page.getByTestId("domain-pending");
    await expect(card).toBeVisible();
    await expect(card).toContainText(`${DOMAIN} isn't switched on yet`);
    await expect(card.getByRole("status")).toHaveText(REASON);
    await expect(card).toContainText("DNS answer: none");
    await expect(card).toContainText("Checking again every 5 minutes until");
    // The field shows what the admin asked for.
    await expect(page.getByLabel("Domain", { exact: true })).toHaveValue(DOMAIN);
    await expect(card.getByRole("button", { name: "Check again" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Use it anyway" })).toBeVisible();
    await expect(card.getByRole("button", { name: /^Keep / })).toBeVisible();
  });

  test("Use it anyway asks first, naming the risk; Cancel changes nothing", async ({ page }) => {
    await login(page, ADMIN);
    await page.goto("/admin/domain");
    await page.getByTestId("domain-pending").getByRole("button", { name: "Use it anyway" }).click();
    const dialog = page.getByRole("dialog", { name: `Use ${DOMAIN} without the check?` });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("couldn’t confirm");
    await expect(dialog).toContainText("audit log");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("domain-pending")).toBeVisible();
    const r = await db.query("SELECT 1 FROM settings WHERE key = $1", [PENDING_KEY]);
    expect(r.rowCount).toBe(1);
  });

  test("a switch being verified shows a status card without buttons", async ({ page }) => {
    const now = Date.now();
    const row = JSON.parse(pendingRow(now));
    row.phase = "verifying";
    row.verify = { address: "203.0.113.10", until: new Date(now + 120_000).toISOString(), origin: "settings" };
    await db.query("UPDATE settings SET value = $2 WHERE key = $1", [PENDING_KEY, JSON.stringify(row)]);
    await login(page, ADMIN);
    await page.goto("/admin/domain");
    const card = page.getByTestId("domain-verifying");
    await expect(card.getByRole("status")).toContainText(`Switching to ${DOMAIN}: checking HTTPS`);
    await expect(card).toContainText("keeps working");
    await expect(card.getByRole("button")).toHaveCount(0);
    await expect(page.getByTestId("domain-pending")).toHaveCount(0);
  });

  test("Keep the current address discards it, and the audit log says so", async ({ page }) => {
    await login(page, ADMIN);
    await page.goto("/admin/domain");
    await page.getByTestId("domain-pending").getByRole("button", { name: /^Keep / }).click();
    await expect(page.getByTestId("domain-pending")).toBeHidden();
    await expect(page.getByText(`${DOMAIN} was discarded.`)).toBeVisible();
    const r = await db.query("SELECT 1 FROM settings WHERE key = $1", [PENDING_KEY]);
    expect(r.rowCount).toBe(0);
    const a = await db.query("SELECT 1 FROM audit_log WHERE action = 'domain.pending_discarded' AND target_label = $1", [DOMAIN]);
    expect(a.rowCount).toBeGreaterThan(0);
  });
});
