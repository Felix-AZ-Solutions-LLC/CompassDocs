import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { ADMIN, login } from "./helpers";

// Files in Azure Blob Storage (1.21.2, lib/file-store; COMPASSDOCS_FILE_STORE=blob).
//
// A cloud-mode server of its own (through start.cjs, on its own database)
// keeps its files in an Azurite container: an attachment uploaded through the
// app lands in the container under its stored name, comes back whole and by
// byte range (video seeking), and is removed with its attachment. /readyz is
// not ready while the container does not exist and becomes ready once it
// does; a missing setting stops the process with one line.
//
// Needs the standalone build and Azurite (CI starts it; see
// test/support/azurite.ts for running it locally).

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "scripts", "start.cjs");
const SERVER_JS = path.join(ROOT, ".next", "standalone", "server.js");
const PORT = 3990;
// Azurite's development account (the SDK knows its published key; none is written here).
const AZURITE = process.env.AZURITE_CONNECTION_STRING || "UseDevelopmentStorage=true";
const CONTAINER = `e2e-${randomBytes(4).toString("hex")}`;

async function service() {
  const { BlobServiceClient } = await import("@azure/storage-blob");
  return BlobServiceClient.fromConnectionString(AZURITE, { retryOptions: { maxTries: 1 } });
}

async function azuriteUp(): Promise<boolean> {
  try {
    await (await service()).listContainers().byPage({ maxPageSize: 1 }).next();
    return true;
  } catch {
    return false;
  }
}

function dbUrl(): string {
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = "/compass_e2e_blob";
  return u.toString();
}

async function admin(sql: string): Promise<void> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

interface Server {
  proc: ChildProcess;
  out: string[];
  exited: Promise<number | null>;
}

function start(extra: Record<string, string>): Server {
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
      COMPASSDOCS_SECRET_KEY: randomBytes(32).toString("hex"),
      COMPASSDOCS_BASE_URL: `http://localhost:${PORT}`,
      DATABASE_URL: dbUrl(),
      COMPASSDOCS_ADMIN_USER: ADMIN.username,
      COMPASSDOCS_ADMIN_PASSWORD: ADMIN.password,
      // No uploads folder at all: every file must go to the container.
      COMPASSDOCS_UPLOAD_DIR: "/nonexistent/compassdocs-uploads",
      COMPASSDOCS_FILE_STORE: "blob",
      COMPASSDOCS_BLOB_CONTAINER: CONTAINER,
      COMPASSDOCS_BLOB_CONNECTION_STRING: AZURITE,
      NO_PROXY: "127.0.0.1,localhost",
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

async function readyz(): Promise<{ status: number; body: Record<string, unknown> } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/readyz`);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } catch {
    return null;
  }
}

test.describe.serial("files in Azure Blob Storage", () => {
  test.skip(!existsSync(SERVER_JS), "needs the standalone build (npm run build)");
  let server: Server | null = null;
  let up = false;

  test.beforeAll(async () => {
    up = await azuriteUp();
    if (!up && process.env.CI) throw new Error("Azurite is not running at 127.0.0.1:10000 (the e2e workflow starts it).");
    if (!up) return;
    await admin("DROP DATABASE IF EXISTS compass_e2e_blob WITH (FORCE)");
    await admin("CREATE DATABASE compass_e2e_blob");
  });

  test.afterAll(async () => {
    if (server && server.proc.exitCode === null) {
      server.proc.kill("SIGTERM");
      await server.exited;
    }
    if (!up) return;
    await (await service()).getContainerClient(CONTAINER).deleteIfExists();
    await admin("DROP DATABASE IF EXISTS compass_e2e_blob WITH (FORCE)").catch(() => {});
  });

  test("a missing setting: one error line saying which, then exit 1", async () => {
    test.skip(!up, "Azurite is not running");
    test.setTimeout(90_000);
    const s = start({ COMPASSDOCS_BLOB_CONTAINER: "" });
    const code = await Promise.race([s.exited, new Promise<string>((r) => setTimeout(() => r("still running"), 60_000))]);
    if (code === "still running") s.proc.kill("SIGKILL");
    expect(code, s.out.join("\n")).toBe(1);
    const refusals = s.out.map((l) => JSON.parse(l) as Record<string, unknown>).filter((o) => o.event === "file_store.refused_to_start");
    expect(refusals).toHaveLength(1);
    expect(String(refusals[0].message)).toMatch(/^File storage can't start: COMPASSDOCS_BLOB_CONTAINER is not set/);
  });

  test("not ready while the container does not exist; ready once it does", async () => {
    test.skip(!up, "Azurite is not running");
    test.setTimeout(180_000);
    server = start({});
    // Up, migrated, but the container is missing: 503 "file storage unreachable".
    await expect
      .poll(async () => (await readyz())?.body.reason, { timeout: 120_000, intervals: [1000] })
      .toBe("file storage unreachable");
    const lines = server.out.map((l) => JSON.parse(l) as Record<string, unknown>);
    const misconfigured = lines.filter((o) => o.event === "file_store.misconfigured");
    expect(misconfigured, server.out.join("\n")).toHaveLength(1);
    expect(String(misconfigured[0].message)).toMatch(/^The container does not exist: Azure Blob Storage \(127\.0\.0\.1\), container e2e-/);
    await (await service()).getContainerClient(CONTAINER).create();
    await expect.poll(async () => (await readyz())?.status, { timeout: 30_000, intervals: [1000] }).toBe(200);
    expect((await readyz())?.body.file_store).toBe("verified");
  });

  test("an attachment goes to the container and comes back whole and by byte range", async ({ browser }) => {
    test.skip(!up, "Azurite is not running");
    test.setTimeout(120_000);
    const context = await browser.newContext({ baseURL: `http://localhost:${PORT}` });
    const page = await context.newPage();
    await login(page, ADMIN);
    const c = new Client({ connectionString: dbUrl() });
    await c.connect();
    const docId = (await c.query<{ id: number }>("SELECT id FROM documents ORDER BY id LIMIT 1")).rows[0].id;
    const video = Buffer.concat([Buffer.from("\x00\x00\x00\x18ftypmp42"), randomBytes(200_000)]);
    const up1 = await page.request.post(`/api/documents/${docId}/attachments`, {
      multipart: { file: { name: "clip.mp4", mimeType: "video/mp4", buffer: video } },
    });
    expect(up1.status(), await up1.text()).toBe(200);
    const att = (await up1.json()).attachment as { id: number; url: string };
    const stored = (await c.query<{ stored_name: string }>("SELECT stored_name FROM attachments WHERE id = $1", [att.id])).rows[0].stored_name;
    await c.end();

    const blob = (await service()).getContainerClient(CONTAINER).getBlockBlobClient(stored);
    const props = await blob.getProperties();
    expect(props.contentLength).toBe(video.length);
    expect(props.contentType).toBe("application/octet-stream");

    const whole = await page.request.get(att.url);
    expect(whole.status()).toBe(200);
    expect(whole.headers()["content-type"]).toBe("video/mp4");
    expect(Buffer.compare(await whole.body(), video)).toBe(0);

    const part = await page.request.get(att.url, { headers: { Range: "bytes=4-11" } });
    expect(part.status()).toBe(206);
    expect(part.headers()["content-range"]).toBe(`bytes 4-11/${video.length}`);
    expect((await part.body()).toString("latin1")).toBe("ftypmp42");
    const tail = await page.request.get(att.url, { headers: { Range: "bytes=-10" } });
    expect(tail.status()).toBe(206);
    expect(Buffer.compare(await tail.body(), video.subarray(video.length - 10))).toBe(0);

    const del = await page.request.delete(att.url);
    expect(del.status()).toBe(200);
    expect(await blob.exists()).toBe(false);
    await context.close();

    // Nothing in the server's log carries the connection string.
    expect(server!.out.join("\n")).not.toContain(AZURITE);
  });
});
