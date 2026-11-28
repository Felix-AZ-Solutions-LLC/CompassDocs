import { test, expect, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { ADMIN, login } from "./helpers";

// Support access and the workspace export (1.21.4, lib/support,
// lib/workspace-export), in a cloud-mode server on its own database, with a
// throwaway signing key standing in for the console's signing service and
// the uploads folder as the file store.
//
// The console asks (a signed request token, POSTed as the console would);
// an administrator sees it on Settings → Support access and approves it; a
// staff member signs in from /login/support#<grant> in a browser of their
// own: the banner says read-only, whose and until when, the token is gone
// from the address, a change is refused, the support page itself is not
// theirs to see, and the same link can't be used twice. The audit log has
// it all; revoking ends the session at once; a denied request is history.
// Emergency access, once allowed, is shown on every settings page until
// reviewed. Then the export: started, made in the background, downloaded
// as one archive with its README. Dark mode and phone width on both pages.
//
// Screenshots (light and dark, desktop and phone) when E2E_SHOTS_DIR is set.

const SHOTS = process.env.E2E_SHOTS_DIR || "";
const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "scripts", "start.cjs");
const SERVER_JS = path.join(ROOT, ".next", "standalone", "server.js");
const PORT = 3987;
const BASE = `http://localhost:${PORT}`;
const SECRET_KEY = randomBytes(32).toString("hex");
const WORKSPACE = "ws_e2e_support";
const DB_NAME = "compass_e2e_support";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY = (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
const STAFF = { name: "Sam Support", email: "sam@compassdocs.io" };

const now = () => Math.floor(Date.now() / 1000);
function signed(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims));
  return `${payload.toString("base64url")}.${sign(null, payload, privateKey).toString("base64url")}`;
}
function requestToken(over: Record<string, unknown> = {}): string {
  return signed({
    typ: "compassdocs.support_request",
    v: 1,
    jti: `req_${randomBytes(10).toString("hex")}`,
    workspace: WORKSPACE,
    staff: STAFF,
    reason: "Ticket 4411: the import stalls at 80%",
    level: "read_only",
    duration_minutes: 120,
    iat: now(),
    nbf: now(),
    exp: now() + 600,
    ...over,
  });
}
function grantToken(over: Record<string, unknown> = {}): string {
  return signed({ typ: "compassdocs.support_grant", v: 1, jti: `grt_${randomBytes(10).toString("hex")}`, workspace: WORKSPACE, staff: STAFF, reason: "Ticket 4411", level: "read_only", iat: now(), nbf: now(), exp: now() + 3600, ...over });
}

function dbUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is not set");
  const u = new URL(base);
  u.pathname = `/${DB_NAME}`;
  return u.toString();
}

async function resetDb(): Promise<void> {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await admin.end();
  }
}

interface Server {
  proc: ChildProcess;
  out: string[];
  exited: Promise<number | null>;
}

function start(): Server {
  const out: string[] = [];
  const proc = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(PORT),
      COMPASSDOCS_SERVER_JS: SERVER_JS,
      COMPASSDOCS_CLOUD: "1",
      COMPASSDOCS_SECRET_KEY: SECRET_KEY,
      COMPASSDOCS_BASE_URL: BASE,
      DATABASE_URL: dbUrl(),
      ...(process.env.DATABASE_SSL ? { DATABASE_SSL: process.env.DATABASE_SSL } : {}),
      ...(process.env.COMPASSDOCS_PG_BIN ? { COMPASSDOCS_PG_BIN: process.env.COMPASSDOCS_PG_BIN } : {}),
      COMPASSDOCS_ADMIN_USER: ADMIN.username,
      COMPASSDOCS_ADMIN_PASSWORD: ADMIN.password,
      COMPASSDOCS_UPLOAD_DIR: mkdtempSync(path.join(tmpdir(), "support-e2e-uploads-")),
      COMPASSDOCS_WORKSPACE_ID: WORKSPACE,
      COMPASSDOCS_SUPPORT_PUBLIC_KEY: PUBLIC_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let partial = "";
  const collect = (chunk: Buffer) => {
    partial += chunk.toString();
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    out.push(...lines.filter((l) => l.trim()));
  };
  proc.stdout!.on("data", collect);
  proc.stderr!.on("data", collect);
  const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));
  return { proc, out, exited };
}

async function waitFor(what: string, ok: () => boolean | Promise<boolean>, server: Server, ms = 120_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (server.proc.exitCode !== null) throw new Error(`server exited ${server.proc.exitCode}:\n${server.out.join("\n")}`);
    try {
      if (await ok()) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} never happened:\n${server.out.slice(-40).join("\n")}`);
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}.png`), fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** POST a token the way the console does. */
async function consolePost(token: string): Promise<{ status: number; body: { request?: { id: string; status: string }; code?: string } }> {
  const res = await fetch(`${BASE}/api/support/requests`, { method: "POST", headers: { "content-type": "text/plain" }, body: token });
  return { status: res.status, body: await res.json() };
}

/** A staff member's own browser, signed in through /login/support#<token>. */
async function staffSignIn(browser: Browser, token: string): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  await page.goto(`/login/support#${token}`);
  await expect(page.getByRole("heading", { name: "CompassDocs support sign-in" })).toBeVisible();
  return page;
}

test.describe.serial("cloud mode: support access and the workspace export", () => {
  test.skip(!existsSync(SERVER_JS), "needs the standalone build (npm run build)");
  test.use({ baseURL: BASE, deviceScaleFactor: SHOTS ? 2 : 1, viewport: { width: 1280, height: 900 } });

  let server: Server;
  let requestId = "";
  let staff: Page;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    await resetDb();
    server = start();
    await waitFor("ready", async () => (await fetch(`http://127.0.0.1:${PORT}/readyz`)).ok, server);
  });

  test.afterAll(async () => {
    await staff?.context().close().catch(() => {});
    if (server && server.proc.exitCode === null) {
      server.proc.kill("SIGTERM");
      await server.exited;
    }
  });

  test("the console asks; a forged or foreign request is refused", async () => {
    const forged = requestToken().split(".");
    forged[1] = forged[1].replace(/^./, (c) => (c === "A" ? "B" : "A"));
    expect((await consolePost(forged.join("."))).status).toBe(401);
    expect((await consolePost(requestToken({ workspace: "ws_other" }))).body.code).toBe("wrong_workspace");
    const r = await consolePost(requestToken());
    expect(r.status).toBe(201);
    expect(r.body.request?.status).toBe("pending");
    requestId = r.body.request!.id;
  });

  test("an administrator sees the request and approves it", async ({ page }) => {
    await login(page, ADMIN);
    await page.goto("/admin/support-access");
    await expect(page.getByRole("heading", { level: 1, name: "Support access" })).toBeVisible();
    const row = page.getByTestId("support-request");
    await expect(row).toContainText("Sam Support");
    await expect(row).toContainText("sam@compassdocs.io");
    await expect(row).toContainText("Read-only");
    await expect(row).toContainText("2 hours");
    await expect(row).toContainText("Ticket 4411: the import stalls at 80%");
    await shoot(page, "support-access-waiting");
    await row.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Approved: Sam Support can sign in/)).toBeVisible();
    await expect(page.getByTestId("support-active-item")).toContainText("Sam Support");
    await expect(page.getByTestId("support-pending")).toHaveCount(0);
  });

  test("staff sign in: the banner, the token gone from the address, read-only enforced, the support page not theirs", async ({ browser }) => {
    const token = grantToken({ request: requestId });
    staff = await staffSignIn(browser, token);
    await expect(staff).toHaveURL(`${BASE}/login/support`);
    await expect(staff.getByTestId("support-sign-in-preview")).toContainText("Sam Support");
    await shoot(staff, "support-sign-in");
    await staff.getByRole("button", { name: "Sign in as CompassDocs support" }).click();
    await staff.waitForURL(`${BASE}/`);
    const banner = staff.getByTestId("support-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("CompassDocs support session");
    await expect(banner).toContainText("Read-only");
    await expect(banner).toContainText("Sam Support");
    await expect(banner.locator("time")).toHaveAttribute("data-tt", /.+/);
    // The sidebar footer names what the session may do, never "Admin".
    await expect(staff.getByRole("link", { name: /Manage account|Sam Support/ }).first()).toContainText("Support · read-only");
    await shoot(staff, "support-banner");

    // Read-only: a change is refused before any route runs.
    const write = await staff.request.post("/api/admin/settings", { data: { company_name: "Hacked" } });
    expect(write.status()).toBe(403);
    expect((await write.json()).code).toBe("support_read_only");
    // Its own access, and the workspace's copies, are not support's.
    await staff.goto("/admin/support-access");
    await expect(staff.getByRole("heading", { level: 1, name: "Not available in a support session" })).toBeVisible();
    expect((await staff.request.get("/api/admin/support")).status()).toBe(403);
    expect((await staff.request.get("/api/admin/workspace-export")).status()).toBe(403);
    // Reading works: an administrator's settings page.
    await staff.goto("/admin/users");
    await expect(staff.getByRole("heading", { level: 1, name: "Users" })).toBeVisible();
    // Its own account (named in the sidebar) is not in the workspace's list of people.
    await expect(staff.locator("main").getByText("CompassDocs support)")).toHaveCount(0);
    await expect(staff.getByTestId("support-banner")).toBeVisible();

    // The same link can't be used twice.
    const again = await staffSignIn(browser, token);
    await again.getByRole("button", { name: "Sign in as CompassDocs support" }).click();
    await expect(again.locator("form [role=alert]")).toContainText("already been used");
    await again.context().close();
  });

  test("the audit log and Support access show what support did", async ({ page }) => {
    await login(page, ADMIN);
    await page.goto("/admin/audit?category=support");
    const log = page.locator("main");
    await expect(log.getByText("CompassDocs support signed in").first()).toBeVisible();
    await expect(log.getByText("CompassDocs support viewed a page").first()).toBeVisible();
    await expect(log.getByText("Approved CompassDocs support access").first()).toBeVisible();
    await expect(log.getByText("CompassDocs support asked for access").first()).toBeVisible();
    await page.goto("/admin/support-access");
    await expect(page.getByTestId("support-active-item")).toContainText(/1 sign-in · [1-9]\d* pages? viewed · 0 changes/);
    await shoot(page, "support-access-active");
  });

  test("revoke ends the session at once", async ({ page }) => {
    await login(page, ADMIN);
    await page.goto("/admin/support-access");
    await page.getByTestId("support-active-item").getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Revoke access" }).click();
    await expect(page.getByText("Access revoked.")).toBeVisible();
    await expect(page.getByTestId("support-history-item").first()).toContainText("Revoked");
    await staff.reload();
    await expect(staff).toHaveURL(/\/login/);
    await expect(staff.getByTestId("support-banner")).toHaveCount(0);
    expect((await staff.request.get("/api/admin/audit")).status()).toBe(401);
  });

  test("a denied request is history; signing in for it is refused", async ({ page, browser }) => {
    const r = await consolePost(requestToken({ level: "admin", duration_minutes: 30 }));
    await login(page, ADMIN);
    await page.goto("/admin/support-access");
    const row = page.getByTestId("support-request");
    await expect(row).toContainText("Administrator");
    await row.getByRole("button", { name: "Deny" }).click();
    await expect(page.getByText("Request denied.")).toBeVisible();
    await expect(page.getByTestId("support-history-item").first()).toContainText("Denied");
    const s = await staffSignIn(browser, grantToken({ request: r.body.request!.id, level: "admin" }));
    await s.getByRole("button", { name: "Sign in as CompassDocs support" }).click();
    await expect(s.locator("form [role=alert]")).toContainText("was denied");
    await s.context().close();
  });

  test("emergency access: off by default; allowed, it is said on every settings page until reviewed", async ({ page, browser }) => {
    const em = () => grantToken({ emergency: "Production outage, INC-88", level: "read_only", exp: now() + 1800 });
    let s = await staffSignIn(browser, em());
    await s.getByRole("button", { name: "Sign in as CompassDocs support" }).click();
    await expect(s.locator("form [role=alert]")).toContainText("doesn't allow emergency");
    await s.context().close();

    await login(page, ADMIN);
    await page.goto("/admin/support-access");
    await page.getByLabel("Emergency access without approval").selectOption("read_only");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Support access settings saved.")).toBeVisible();

    s = await staffSignIn(browser, em());
    await expect(s.getByTestId("support-sign-in-preview")).toContainText("(emergency)");
    await s.getByRole("button", { name: "Sign in as CompassDocs support" }).click();
    await s.waitForURL(`${BASE}/`);
    await expect(s.getByTestId("support-banner")).toContainText("emergency access");
    await s.getByTestId("support-banner").getByRole("button", { name: "End session" }).click();
    await s.waitForURL(/\/login/);
    await s.context().close();

    await page.goto("/admin");
    await expect(page.getByTestId("support-emergency-note")).toContainText("emergency access once");
    await page.goto("/admin/support-access");
    const note = page.getByTestId("support-emergency");
    await expect(note).toContainText("Production outage, INC-88");
    await shoot(page, "support-access-emergency");
    await note.getByRole("button", { name: "Mark reviewed" }).click();
    await expect(page.getByText("Marked reviewed.")).toBeVisible();
    await page.goto("/admin");
    await expect(page.getByTestId("support-emergency-note")).toHaveCount(0);
  });

  test("Support access in dark mode and at phone width", async ({ page }) => {
    await login(page, ADMIN);
    // Dark before the page loads, so the boot script paints it dark. Switching
    // after load leans on ThemeToggle's live listener, which only exists once
    // the page has hydrated: an early switch raced it and could be missed.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/admin/support-access");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const card = page.locator("#history");
    expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgb(255, 255, 255)");
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator("#settings")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await shoot(page, "support-access-phone");
  });

  test("the workspace export: started, made in the background, downloaded as one archive", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, ADMIN);
    // Backups (managed by CompassDocs Cloud) points here.
    await page.goto("/admin/backups");
    await page.getByRole("link", { name: "Export your workspace" }).click();
    await expect(page).toHaveURL(/\/admin\/data#workspace-export$/);
    const card = page.locator("#workspace-export");
    await expect(card).toContainText("No exports yet");
    await card.getByRole("button", { name: "Export the workspace" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Start the export" }).click();
    await expect(page.getByText("The export has started.")).toBeVisible();
    await expect(card.getByTestId("workspace-export-row").first()).toHaveAttribute("data-status", "ready", { timeout: 90_000 });
    await expect(card.getByRole("button", { name: "Export the workspace" })).toBeEnabled();
    await shoot(page, "workspace-export-ready");

    const [download] = await Promise.all([page.waitForEvent("download"), card.getByTestId("workspace-export-download").first().click()]);
    expect(download.suggestedFilename()).toMatch(/^compassdocs-export-\d{8}-\d{6}\.tar$/);
    const file = await download.path();
    const tar = readFileSync(file!);
    const text = tar.toString("latin1");
    expect(text).toContain("/README.md");
    expect(text).toContain("/manifest.json");
    expect(text).toMatch(/compassdocs-\d{8}-\d{6}\.dump/);
    expect(text).toMatch(/compassdocs-\d{8}-\d{6}\.files\.tar/);
    expect(text).toContain("# CompassDocs workspace export");
    expect(text).toContain("PGDMP"); // the dump's own magic
    await expect(card.getByTestId("workspace-export-row").first()).toContainText(/sha256 [0-9a-f]{64}/);

    // Another site can't start a download; the second export of the minute is still allowed (three a day).
    const id = await card.getByTestId("workspace-export-download").first().getAttribute("href");
    const cross = await page.request.get(id!, { headers: { "sec-fetch-site": "cross-site" } });
    expect(cross.status()).toBe(403);

    await page.goto("/admin/audit?category=workspace");
    await expect(page.locator("main").getByText("Downloaded a workspace export").first()).toBeVisible();
    await expect(page.locator("main").getByText("Workspace export ready").first()).toBeVisible();

    await page.goto("/admin/data");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator("#workspace-export")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await shoot(page, "workspace-export-phone");
  });

  test("the logs carry no token", async () => {
    const all = server.out.join("\n");
    expect(all).not.toContain(SECRET_KEY);
    for (const line of server.out) expect(() => JSON.parse(line), line).not.toThrow();
  });
});
