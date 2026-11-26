import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { ADMIN, login } from "./helpers";

// The license from the CompassDocs console (1.21.3, lib/license-pull;
// Settings → License in cloud mode).
//
// A cloud-mode server is started on its own database with
// COMPASSDOCS_LICENSE_URL pointing at a fake console in this file. The
// console hands out a license signed with a throwaway key, which the app's
// verifier (the vendor's pinned key) refuses: the page shows the license as
// "Managed by CompassDocs Cloud", with no box to paste one, when it was last
// checked and why the console's license wasn't used; Check now asks again
// (and not twice within 30 s); the license API refuses changes. How an
// installed license reads (its expiry, days left) is checked against the
// page with the API's answer stood in for, since no test can hold a license
// the vendor signed. Then dark mode and phone width, and the logs: JSON,
// with no credential in them.
//
// Screenshots (light and dark, desktop and phone) when E2E_SHOTS_DIR is set.

const SHOTS = process.env.E2E_SHOTS_DIR || "";
const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "scripts", "start.cjs");
const SERVER_JS = path.join(ROOT, ".next", "standalone", "server.js");
const PORT = 3989;
const BASE = `http://localhost:${PORT}`;
const SECRET_KEY = randomBytes(32).toString("hex");
const LICENSE_TOKEN = `console-credential-${randomBytes(8).toString("hex")}`;
const WORKSPACE = "ws_e2e_license";
const DB_NAME = "compass_e2e_cloud_license";

function testSignedLicense(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  const payload = Buffer.from(
    JSON.stringify({ id: "lic_00000000000000e2", customer: "E2E Co", plan: "cloud", features: ["sso"], seats: 0, issued: "2026-11-01", expires: "2027-11-01", workspace: WORKSPACE })
  );
  return `${payload.toString("base64url")}.${sign(null, payload, privateKey).toString("base64url")}`;
}

/** The fake console: every request recorded, every answer a test-signed license. */
const consoleRequests: http.IncomingHttpHeaders[] = [];
let consoleServer: http.Server;
let consoleUrl = "";

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
      COMPASSDOCS_ADMIN_USER: ADMIN.username,
      COMPASSDOCS_ADMIN_PASSWORD: ADMIN.password,
      COMPASSDOCS_UPLOAD_DIR: mkdtempSync(path.join(tmpdir(), "cloud-license-e2e-uploads-")),
      COMPASSDOCS_LICENSE_URL: consoleUrl,
      COMPASSDOCS_LICENSE_TOKEN: LICENSE_TOKEN,
      COMPASSDOCS_WORKSPACE_ID: WORKSPACE,
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
  throw new Error(`${what} never happened:\n${server.out.join("\n")}`);
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

test.describe.serial("cloud mode: the license from the console", () => {
  test.skip(!existsSync(SERVER_JS), "needs the standalone build (npm run build)");
  test.use({ baseURL: BASE, deviceScaleFactor: SHOTS ? 2 : 1, viewport: { width: 1280, height: 900 } });

  let server: Server;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const license = testSignedLicense();
    consoleServer = http.createServer((req, res) => {
      consoleRequests.push(req.headers);
      res.writeHead(200, { "content-type": "text/plain", etag: '"e2e-1"' });
      res.end(license);
    });
    await new Promise<void>((resolve) => consoleServer.listen(0, "127.0.0.1", resolve));
    consoleUrl = `http://127.0.0.1:${(consoleServer.address() as AddressInfo).port}/api/workspaces/${WORKSPACE}/license`;
    await resetDb();
    server = start();
    await waitFor("ready", async () => (await fetch(`http://127.0.0.1:${PORT}/readyz`)).ok, server);
  });

  test.afterAll(async () => {
    if (server && server.proc.exitCode === null) {
      server.proc.kill("SIGTERM");
      await server.exited;
    }
    consoleServer?.closeAllConnections();
    await new Promise<void>((resolve) => (consoleServer ? consoleServer.close(() => resolve()) : resolve()));
  });

  test("the console is asked shortly after start, with the workspace's credential and id", async () => {
    await waitFor("the first license check", () => consoleRequests.length >= 1, server, 60_000);
    const first = consoleRequests[0];
    expect(first.authorization).toBe(`Bearer ${LICENSE_TOKEN}`);
    expect(first["x-compassdocs-workspace"]).toBe(WORKSPACE);
    expect(first.accept).toBe("text/plain");
  });

  test("Settings → License: managed by CompassDocs Cloud, no box to paste a license, the last check and why its license wasn't used", async ({ page }) => {
    await login(page, ADMIN);
    await page.goto("/admin/license");
    const card = page.getByTestId("license-cloud");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("set-by-platform")).toContainText("Managed by CompassDocs Cloud");
    await expect(page.getByRole("textbox", { name: "License key" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Activate" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Remove license" })).toHaveCount(0);
    await expect(card).toContainText("Not installed yet");
    await expect(card.getByTestId("license-cloud-checked").locator("time")).toHaveAttribute("data-tt", /.+/);
    // The console's license is signed by another key: refused, and said so.
    await expect(card.getByTestId("license-cloud-check")).toContainText("does not verify");
    await expect(card.getByTestId("license-cloud-check")).toHaveClass(/ink-warn/);
    await shoot(page, "cloud-license-refused");

    // Check now asks again; a second press within 30 s is refused with a plain sentence.
    const before = consoleRequests.length;
    await card.getByRole("button", { name: "Check now" }).click();
    await expect(page.getByText("The license couldn't be checked. The license in force is kept.")).toBeVisible();
    expect(consoleRequests.length).toBe(before + 1);
    await card.getByRole("button", { name: "Check now" }).click();
    await expect(page.getByText(/The license was checked moments ago\. Try again in \d+ s\./)).toBeVisible();
    expect(consoleRequests.length).toBe(before + 1);
  });

  test("the license API refuses a pasted or removed license; Check now needs an administrator", async ({ page, playwright }) => {
    await login(page, ADMIN);
    for (const body of [{ license_key: "abc.def" }, { clear: true }]) {
      const r = await page.request.patch("/api/admin/license", { data: body });
      expect(r.status()).toBe(403);
      expect((await r.json()).code).toBe("cloud_managed");
    }
    const anonymous = await playwright.request.newContext({ baseURL: BASE });
    const r = await anonymous.post("/api/admin/license/check");
    expect([401, 403]).toContain(r.status());
    await anonymous.dispose();
  });

  test("an installed license shows its expiry and days left (the API's answer stood in for)", async ({ page }) => {
    await login(page, ADMIN);
    const checkedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    await page.route("**/api/admin/license", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const real = await (await route.fetch()).json();
      await route.fulfill({
        json: {
          ...real,
          source: "cloud",
          status: "active",
          daysLeft: 95,
          license: { customer: "E2E Co", plan: "cloud", seats: 0, agents: null, issued: "2026-11-20", expires: "2027-03-01" },
          cloud: { pull: true, check: { checkedAt, result: "updated", message: "Installed the license from CompassDocs Cloud: it expires 2027-03-01.", updatedAt: checkedAt } },
        },
      });
    });
    await page.goto("/admin/license");
    const card = page.getByTestId("license-cloud");
    await expect(card.getByTestId("license-cloud-expires")).toHaveText("2027-03-01 · 95d left");
    await expect(card.getByTestId("license-cloud-checked")).toContainText("5m ago");
    await expect(card.getByTestId("license-cloud-check")).not.toHaveClass(/ink-warn/);
    await shoot(page, "cloud-license-installed");

    // Dark mode: the card is a surface, not a light slab.
    await page.emulateMedia({ colorScheme: "dark" });
    const bg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgb(255, 255, 255)");
    await page.emulateMedia({ colorScheme: "light" });

    // Phone width: no sideways scroll, Check now still a real target.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(card.getByTestId("license-cloud-expires")).toBeVisible();
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sideways).toBeLessThanOrEqual(0);
    await shoot(page, "cloud-license-phone");
  });

  test("the logs are JSON, say what happened once, and never carry the credential", async () => {
    const all = server.out.join("\n");
    for (const line of server.out) expect(() => JSON.parse(line), line).not.toThrow();
    expect(all).not.toContain(LICENSE_TOKEN);
    expect(all).not.toContain(SECRET_KEY);
    const refused = server.out.map((l) => JSON.parse(l) as Record<string, unknown>).filter((o) => o.event === "license.console_rejected");
    expect(refused.length).toBe(1);
    expect(String(refused[0].message)).toContain("The license in force is kept.");
  });
});
