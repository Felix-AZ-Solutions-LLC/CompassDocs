import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { ADMIN, login } from "./helpers";

// Cloud mode (1.21.0, lib/cloud; COMPASSDOCS_CLOUD=1).
//
// The suite's own server is self-hosted: there, Domain & HTTPS, Backups and
// the update check are where they always were. A second server is started
// here in cloud mode, on its own database, through the image's entry
// (scripts/start.cjs, as `node start.cjs` in the image): the rail leaves
// those sections out, their pages show "Managed by CompassDocs Cloud", their
// APIs answer 403, and the license, AI key and SMTP set by the platform are
// read-only. Then the SIGTERM path: requests in flight finish, new
// connections are refused, the logs are one JSON object per line, the
// process exits 0; and a shutdown the deadline cuts short exits 1 and says
// why.
//
// Screenshots (deviceScaleFactor 2, light and dark) of every settings page
// that changes, in both modes, when E2E_SHOTS_DIR is set.

const SHOTS = process.env.E2E_SHOTS_DIR || "";
const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "scripts", "start.cjs");
const SERVER_JS = path.join(ROOT, ".next", "standalone", "server.js");
const CLOUD_PORT = 3997;
const STOP_PORT = 3996;
const CLOUD = `http://localhost:${CLOUD_PORT}`;
const SECRET_KEY = randomBytes(32).toString("hex");

/** The pages that change in cloud mode: [file name, path, what to wait for]. */
const CHANGED_PAGES: [string, string][] = [
  ["system", "/admin"],
  ["domain", "/admin/domain"],
  ["backups", "/admin/backups"],
  ["license", "/admin/license"],
  ["ai", "/admin/ai"],
  ["email", "/admin/notifications/email"],
];

function cloudDbUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is not set");
  const u = new URL(base);
  u.pathname = "/compass_e2e_cloud";
  return u.toString();
}

async function resetCloudDb(): Promise<void> {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  try {
    await admin.query("DROP DATABASE IF EXISTS compass_e2e_cloud WITH (FORCE)");
    await admin.query("CREATE DATABASE compass_e2e_cloud");
  } finally {
    await admin.end();
  }
}

interface Server {
  proc: ChildProcess;
  out: string[];
  exited: Promise<number | null>;
}

function start(port: number, extra: Record<string, string> = {}): Server {
  const out: string[] = [];
  const proc = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      COMPASSDOCS_SERVER_JS: SERVER_JS,
      COMPASSDOCS_CLOUD: "1",
      COMPASSDOCS_SECRET_KEY: SECRET_KEY,
      COMPASSDOCS_BASE_URL: `http://localhost:${port}`,
      DATABASE_URL: cloudDbUrl(),
      COMPASSDOCS_ADMIN_USER: ADMIN.username,
      COMPASSDOCS_ADMIN_PASSWORD: ADMIN.password,
      COMPASSDOCS_UPLOAD_DIR: mkdtempSync(path.join(tmpdir(), "cloud-e2e-uploads-")),
      ...extra,
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

async function waitReady(port: number, server: Server, ms = 120_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (server.proc.exitCode !== null) throw new Error(`server exited ${server.proc.exitCode}:\n${server.out.join("\n")}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (r.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server on ${port} never became ready:\n${server.out.join("\n")}`);
}

async function shoot(page: Page, name: string, fullPage = true): Promise<void> {
  if (!SHOTS) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}.png`), fullPage });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** The settings rail on a desktop-width page (the phone row has the same name and is hidden). */
const settingsRail = (page: Page) => page.locator('nav[aria-label="Settings sections"]:visible').first();

test.describe("self-hosted: nothing changed", () => {
  test.use({ deviceScaleFactor: SHOTS ? 2 : 1, viewport: { width: 1280, height: 900 } });

  test("Domain & HTTPS, Backups and the update check are all there, and their APIs answer", async ({ page }) => {
    await login(page, ADMIN);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Version & updates" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Check now|Checking/ })).toBeVisible();
    await expect(page.getByTestId("cloud-managed-updates")).toHaveCount(0);
    const rail = settingsRail(page);
    await expect(rail.getByRole("link", { name: "Domain & HTTPS" })).toBeVisible();
    await expect(rail.getByRole("link", { name: "Backups" })).toBeVisible();
    await page.goto("/admin/domain");
    await expect(page.getByTestId("cloud-managed-domain")).toHaveCount(0);
    await expect(page.getByText("Custom domain", { exact: false }).first()).toBeVisible();
    await page.goto("/admin/backups");
    await expect(page.getByTestId("cloud-managed-backups")).toHaveCount(0);
    for (const p of ["/api/admin/domain", "/api/backups", "/api/admin/backup-destinations"]) {
      const r = await page.request.get(p);
      expect(r.status(), p).toBe(200);
    }
    for (const [name, p] of CHANGED_PAGES) {
      await page.goto(p);
      await page.waitForLoadState("networkidle");
      await shoot(page, `before-${name}`);
      if (name === "system") {
        // The Storage card, below the fold: its backup rows (self-hosted) or the note (cloud).
        await page.getByRole("heading", { name: "Storage" }).scrollIntoViewIfNeeded();
        await shoot(page, `before-system-storage`, false);
      }
    }
  });
});

test.describe.serial("cloud mode", () => {
  test.skip(!existsSync(SERVER_JS), "needs the standalone build (npm run build)");
  test.use({ baseURL: CLOUD, deviceScaleFactor: SHOTS ? 2 : 1, viewport: { width: 1280, height: 900 } });

  let server: Server;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    await resetCloudDb();
    server = start(CLOUD_PORT, {
      COMPASSDOCS_LICENSE_KEY: "platform-supplied-license",
      ANTHROPIC_API_KEY: "sk-ant-platform-e2e-0000000000",
      COMPASSDOCS_SMTP_HOST: "smtp.platform.test",
      COMPASSDOCS_SMTP_PASSWORD: "platform-relay-password",
      COMPASSDOCS_SMTP_FROM: "CompassDocs <no-reply@acme.compassdocs.test>",
    });
    await waitReady(CLOUD_PORT, server);
  });

  test.afterAll(async () => {
    if (server && server.proc.exitCode === null) {
      server.proc.kill("SIGTERM");
      await server.exited;
    }
  });

  test("the APIs that manage hosting answer 403 with a plain sentence", async ({ request }) => {
    const calls: [string, string, unknown?][] = [
      ["GET", "/api/admin/domain"],
      ["PATCH", "/api/admin/domain", { custom_domain: "docs.example.com" }],
      ["DELETE", "/api/admin/domain/fallback", { host: "old.example.com" }],
      ["POST", "/api/admin/domain/pending"],
      ["DELETE", "/api/admin/domain/pending"],
      ["GET", "/.well-known/compassdocs-domain-check/abc"],
      ["POST", "/api/admin/update"],
      ["GET", "/api/admin/version"],
      ["GET", "/api/backups"],
      ["POST", "/api/backups"],
      ["GET", "/api/backups/compassdocs-x.dump.enc"],
      ["DELETE", "/api/backups/compassdocs-x.dump.enc"],
      ["POST", "/api/backups/compassdocs-x.dump.enc/restore"],
      ["GET", "/api/admin/backup-destinations"],
      ["PATCH", "/api/admin/backup-destinations", { action: "test" }],
    ];
    for (const [method, p, data] of calls) {
      const r = await request.fetch(p, { method, ...(data ? { data } : {}) });
      expect(r.status(), `${method} ${p}`).toBe(403);
      const body = await r.json();
      expect(body.code, `${method} ${p}`).toBe("cloud_managed");
      expect(body.error).toMatch(/is managed by CompassDocs Cloud, so it can't be changed here\.$/);
    }
  });

  test("the probes: /healthz and /readyz", async ({ request }) => {
    const live = await request.get("/healthz");
    expect(live.status()).toBe(200);
    const ready = await request.get("/readyz");
    expect(ready.status()).toBe(200);
    expect(await ready.json()).toMatchObject({ status: "ready", migrations: "applied" });
    expect(ready.headers()["x-request-id"], "JSON logging: every response carries its request id").toBeTruthy();
  });

  test("the hidden sections are out of the rail and its search; their pages say who manages them", async ({ page }) => {
    await login(page, ADMIN);
    await page.goto("/admin");
    const rail = settingsRail(page);
    await expect(rail.getByRole("link", { name: "System" })).toBeVisible();
    await expect(rail.getByRole("link", { name: "Domain & HTTPS" })).toHaveCount(0);
    await expect(rail.getByRole("link", { name: "Backups" })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Search settings" }).fill("backup");
    await expect(rail.getByRole("link", { name: /Backups/ })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Search settings" }).fill("tls certificate");
    await expect(rail.getByRole("link", { name: /Domain/ })).toHaveCount(0);

    // System: the update check gives way to a note; the Storage card loses its backup rows.
    await page.getByRole("textbox", { name: "Search settings" }).fill("");
    await expect(page.getByRole("heading", { name: "Version & updates" })).toBeVisible();
    await expect(page.getByTestId("cloud-managed-updates")).toContainText("Managed by CompassDocs Cloud");
    await expect(page.getByRole("button", { name: /Check now/ })).toHaveCount(0);
    await expect(page.getByTestId("cloud-managed-backups")).toBeVisible();
    await expect(page.getByText("Backup path")).toHaveCount(0);

    for (const [p, id] of [["/admin/domain", "cloud-managed-domain"], ["/admin/backups", "cloud-managed-backups"]] as const) {
      await page.goto(p);
      await expect(page.getByTestId(id)).toContainText("Managed by CompassDocs Cloud");
      await expect(page.locator("h1")).toBeVisible();
      // The section's Docs button (its docs are for self-hosting) is left out.
      await expect(page.locator('a[data-tt$="documentation (opens in a new tab)"]')).toHaveCount(0);
    }
  });

  test("the license, the AI key and SMTP are set by the platform, read-only", async ({ page }) => {
    await login(page, ADMIN);
    await page.goto("/admin/license");
    await expect(page.getByTestId("set-by-platform")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "License key" })).toHaveCount(0);
    await page.goto("/admin/ai");
    await expect(page.getByTestId("set-by-platform")).toBeVisible();
    await expect(page.getByText("with a key set by the platform")).toBeVisible();
    await page.goto("/admin/notifications/email");
    await expect(page.getByTestId("mail-smtp").getByTestId("set-by-platform")).toBeVisible();
    await expect(page.getByTestId("mail-smtp")).toContainText("no-reply@acme.compassdocs.test");
    await expect(page.getByText("platform-relay-password")).toHaveCount(0);
    for (const [name, p] of CHANGED_PAGES) {
      await page.goto(p);
      await page.waitForLoadState("networkidle");
      await shoot(page, `after-${name}`);
      if (name === "system") {
        // The Storage card, below the fold: its backup rows (self-hosted) or the note (cloud).
        await page.getByRole("heading", { name: "Storage" }).scrollIntoViewIfNeeded();
        await shoot(page, `after-system-storage`, false);
      }
    }
  });

  test("the logs are one JSON object per line, with no secret in them", async () => {
    expect(server.out.length).toBeGreaterThan(0);
    for (const line of server.out) {
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line);
      } catch {
        throw new Error(`not a JSON line: ${line}`);
      }
      expect(typeof o.time, line).toBe("string");
      expect(typeof o.level, line).toBe("string");
      expect(typeof o.message, line).toBe("string");
    }
    const all = server.out.join("\n");
    for (const secret of [SECRET_KEY, "platform-relay-password", "sk-ant-platform-e2e", ADMIN.password]) expect(all).not.toContain(secret);
    expect(all).toContain("Running in cloud mode");
  });
});

test.describe.serial("graceful shutdown on SIGTERM", () => {
  test.skip(!existsSync(SERVER_JS), "needs the standalone build (npm run build)");

  /** A POST whose body is still arriving: an in-flight request. */
  function slowRequest(port: number): { socket: net.Socket; finish: () => void; response: Promise<string> } {
    const body = JSON.stringify({ username: "nobody-here", password: "not-a-password" });
    const socket = net.connect(port, "127.0.0.1");
    socket.write(
      `POST /api/auth/login HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n${body.slice(0, 5)}`
    );
    let got = "";
    const response = new Promise<string>((resolve) => {
      socket.on("data", (d) => (got += d.toString()));
      socket.on("close", () => resolve(got));
      socket.on("error", () => resolve(got));
    });
    return { socket, finish: () => socket.write(body.slice(5)), response };
  }

  const refused = (port: number) =>
    new Promise<boolean>((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => {
        s.destroy();
        resolve(false);
      });
      s.on("error", () => resolve(true));
    });

  test("in-flight requests finish, new connections are refused, the pool closes, exit 0", async () => {
    test.setTimeout(150_000);
    const server = start(STOP_PORT, { COMPASSDOCS_SHUTDOWN_TIMEOUT: "15" });
    await waitReady(STOP_PORT, server);
    const inflight = slowRequest(STOP_PORT);
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    server.proc.kill("SIGTERM");
    await expect.poll(() => refused(STOP_PORT), { timeout: 5_000 }).toBe(true);
    expect(server.proc.exitCode, "still finishing the request in flight").toBeNull();
    await new Promise((r) => setTimeout(r, 1000));
    inflight.finish();
    const res = await inflight.response;
    expect(res).toMatch(/^HTTP\/1\.1 401 /);
    expect(await server.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(15_000);
    const lines = server.out.map((l) => JSON.parse(l) as { event?: string; message: string });
    const stop = lines.filter((l) => l.event === "shutdown").map((l) => l.message);
    expect(stop[0]).toMatch(/^SIGTERM received: draining for up to 15 s\.$/);
    expect(stop.at(-1)).toMatch(/^Stopped cleanly in \d+ ms: requests finished, background jobs done, database pool closed\.$/);
  });

  test("a request still in flight at the deadline is cut, logged, and the exit code says so", async () => {
    test.setTimeout(150_000);
    const server = start(STOP_PORT, { COMPASSDOCS_SHUTDOWN_TIMEOUT: "2" });
    await waitReady(STOP_PORT, server);
    const inflight = slowRequest(STOP_PORT);
    await new Promise((r) => setTimeout(r, 300));
    server.proc.kill("SIGTERM");
    expect(await server.exited).toBe(1);
    await inflight.response;
    const last = JSON.parse(server.out.at(-1)!) as { level: string; message: string; pending?: string[] };
    expect(last.level).toBe("warn");
    expect(last.message).toMatch(/^Stopped after \d+ ms with work unfinished: 1 HTTP connection/);
  });
});
