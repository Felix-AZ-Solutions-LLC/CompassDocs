// Cloud mode (1.21.0) against the real routes and database: in cloud mode
// every API that manages hosting or installs software answers 403 with
// `code: "cloud_managed"` and a plain sentence, the settings rail and the
// palette leave those sections out, a platform-supplied secret can't be
// changed, the session cookie is always Secure and links use
// COMPASSDOCS_BASE_URL. In self-hosted mode the same calls behave as before.
// /readyz checks the migrations and turns 503 while draining.
//
// The database boots in self-hosted mode first (cloud mode is switched on
// per call, after the master key is cached), so nothing here seals a value
// with a key other tests don't have.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/cloud-routes.test.ts

import Module from "node:module";
import path from "node:path";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

let currentRequest: Request | null = null;
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.cloud-routes.virtual.js");
{
  const jar = () => {
    const out = new Map<string, string>();
    for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
    }
    return out;
  };
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const j = jar();
      return {
        get: (name: string) => (j.has(name) ? { name, value: j.get(name) } : undefined),
        getAll: () => [...j].map(([name, value]) => ({ name, value })),
        has: (name: string) => j.has(name),
      };
    },
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;
  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const db = require("../src/lib/db") as typeof import("../src/lib/db");
const { newToken } = require("../src/lib/password") as typeof import("../src/lib/password");
/* eslint-enable @typescript-eslint/no-require-imports */

const STAMP = `cloudroutes${Date.now()}`;
const KEY = "ab".repeat(32);
let adminId = 0;
let session = "";

type Handler = (req: Request, ctx?: unknown) => Promise<Response>;
type Route = Partial<Record<"GET" | "POST" | "PATCH" | "PUT" | "DELETE", Handler>>;

const CLOUD_ENV: Record<string, string> = {
  COMPASSDOCS_CLOUD: "1",
  COMPASSDOCS_SECRET_KEY: KEY,
  COMPASSDOCS_BASE_URL: "https://acme.compassdocs.io",
};

/** Run `fn` in cloud mode (or with these variables), then restore. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const inCloud = <T>(fn: () => Promise<T>, extra: Record<string, string> = {}) => withEnv({ ...CLOUD_ENV, ...extra }, fn);
const selfHosted = <T>(fn: () => Promise<T>) => withEnv({ COMPASSDOCS_CLOUD: undefined }, fn);

async function call(handler: Handler, url: string, method: string, body?: unknown, ctx?: unknown) {
  currentRequest = new Request(url, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json", host: new URL(url).host },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    const res = await handler(currentRequest, ctx);
    const text = await res.text();
    let json: Record<string, any> | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: json, text };
  } finally {
    currentRequest = null;
  }
}

const load = async (p: string) => (await import(p)) as unknown as Route;

before(async () => {
  await db.getSetting("__schema_bootstrap__");
  const r = await db.pool().query<{ id: number }>(
    "INSERT INTO users (username, name, email, role, status) VALUES ($1, 'Cloud admin', '', 'admin', 'active') RETURNING id",
    [`${STAMP}-admin`]
  );
  adminId = r.rows[0].id;
  session = newToken();
  await db.createSession(session, adminId, new Date(Date.now() + 3_600_000).toISOString());
});

after(async () => {
  await db.pool().query("DELETE FROM sessions WHERE user_id = $1", [adminId]);
  await db.pool().query("DELETE FROM audit_log WHERE actor_id = $1", [adminId]);
  await db.pool().query("DELETE FROM users WHERE id = $1", [adminId]);
  await db.pool().end();
});

const ORIGIN = "http://ws.example";

/** Every handler of every API that manages hosting or installs software, as [label, route file, method, path, body?, params?]. */
const REFUSED: [string, string, keyof Route, string, unknown?, Record<string, string>?][] = [
  ["Domain & HTTPS: read", "../src/app/api/admin/domain/route", "GET", "/api/admin/domain"],
  ["Domain & HTTPS: save", "../src/app/api/admin/domain/route", "PATCH", "/api/admin/domain", { custom_domain: "docs.example.com" }],
  ["Domain: remove a fallback host", "../src/app/api/admin/domain/fallback/route", "DELETE", "/api/admin/domain/fallback", { host: "old.example.com" }],
  ["Domain: check again", "../src/app/api/admin/domain/pending/route", "POST", "/api/admin/domain/pending"],
  ["Domain: keep the current address", "../src/app/api/admin/domain/pending/route", "DELETE", "/api/admin/domain/pending"],
  ["Domain check proof", "../src/app/.well-known/compassdocs-domain-check/[token]/route", "GET", "/.well-known/compassdocs-domain-check/abc", undefined, { token: "abc" }],
  ["Updater: update now", "../src/app/api/admin/update/route", "POST", "/api/admin/update"],
  ["Updater: check for updates", "../src/app/api/admin/version/route", "GET", "/api/admin/version"],
  ["Backups: list", "../src/app/api/backups/route", "GET", "/api/backups"],
  ["Backups: back up now", "../src/app/api/backups/route", "POST", "/api/backups"],
  ["Backups: download", "../src/app/api/backups/[name]/route", "GET", "/api/backups/x.dump", undefined, { name: "x.dump" }],
  ["Backups: delete", "../src/app/api/backups/[name]/route", "DELETE", "/api/backups/x.dump", undefined, { name: "x.dump" }],
  ["Backups: restore", "../src/app/api/backups/[name]/restore/route", "POST", "/api/backups/x.dump/restore", {}, { name: "x.dump" }],
  ["Backups: destinations read", "../src/app/api/admin/backup-destinations/route", "GET", "/api/admin/backup-destinations"],
  ["Backups: destinations save", "../src/app/api/admin/backup-destinations/route", "PATCH", "/api/admin/backup-destinations", { action: "test", kind: "s3" }],
  ["Backups: schedule (workspace settings)", "../src/app/api/admin/settings/route", "PATCH", "/api/admin/settings", { backup_frequency: "daily" }],
];

describe("cloud mode: the APIs that manage hosting answer 403", () => {
  for (const [label, file, method, p, body, params] of REFUSED) {
    test(label, async () => {
      const route = await load(file);
      const handler = route[method];
      assert.ok(handler, `${file} has ${method}`);
      const r = await inCloud(() => call(handler!, `${ORIGIN}${p}`, method, body, params ? { params: Promise.resolve(params) } : undefined));
      assert.equal(r.status, 403, r.text);
      assert.equal(r.body?.code, "cloud_managed");
      assert.match(String(r.body?.error), /is managed by CompassDocs Cloud, so it can't be changed here\.$/);
    });
  }

  test("the workspace settings route still saves everything else", async () => {
    const route = await load("../src/app/api/admin/settings/route");
    const r = await inCloud(() => call(route.PATCH!, `${ORIGIN}/api/admin/settings`, "PATCH", {}));
    assert.equal(r.status, 200, r.text);
  });
});

describe("self-hosted: the same APIs behave as before", () => {
  test("Domain & HTTPS reads its state", async () => {
    const route = await load("../src/app/api/admin/domain/route");
    const r = await selfHosted(() => call(route.GET!, `${ORIGIN}/api/admin/domain`, "GET"));
    assert.equal(r.status, 200, r.text);
    assert.ok(r.body && "custom_domain" in r.body);
  });

  test("Backups lists", async () => {
    const route = await load("../src/app/api/backups/route");
    const r = await selfHosted(() => call(route.GET!, `${ORIGIN}/api/backups`, "GET"));
    assert.notEqual(r.status, 403, r.text);
    assert.notEqual(r.body?.code, "cloud_managed");
  });

  test("Update now without an updater says so (400), as before", async () => {
    const route = await load("../src/app/api/admin/update/route");
    const r = await withEnv({ COMPASSDOCS_CLOUD: undefined, COMPASSDOCS_UPDATER_URL: undefined, COMPASSDOCS_UPDATER_TOKEN: undefined }, () =>
      call(route.POST!, `${ORIGIN}/api/admin/update`, "POST")
    );
    assert.equal(r.status, 400);
    assert.match(String(r.body?.error), /No updater is configured/);
  });

  test("the domain check proof answers its 404 for an unknown token, as before", async () => {
    const route = await load("../src/app/.well-known/compassdocs-domain-check/[token]/route");
    const r = await selfHosted(() => call(route.GET!, `${ORIGIN}/.well-known/compassdocs-domain-check/abc`, "GET", undefined, { params: Promise.resolve({ token: "abc" }) }));
    assert.equal(r.status, 404);
  });
});

describe("the settings rail, search and palette", () => {
  test("cloud mode leaves Domain & HTTPS and Backups out; self-hosted keeps them", async () => {
    const { reachableSettingsSections } = await import("../src/lib/auth");
    const user = { id: adminId, role: "admin" } as Parameters<typeof reachableSettingsSections>[0];
    const cloud = await inCloud(() => reachableSettingsSections(user));
    const self = await selfHosted(() => reachableSettingsSections(user));
    for (const href of ["/admin/domain", "/admin/backups"]) {
      assert.ok(self.includes(href), `self-hosted: ${href}`);
      assert.ok(!cloud.includes(href), `cloud: ${href}`);
    }
    assert.deepEqual(
      self.filter((h) => h !== "/admin/domain" && h !== "/admin/backups"),
      cloud,
      "nothing else changes"
    );
  });

  test("the palette's Backups command is gone in cloud mode", async () => {
    const { allowedCommandIds, navCapabilities } = await import("../src/lib/nav-capabilities");
    const user = (await db.getUserById(adminId))!;
    const { toSessionUser } = await import("../src/lib/auth");
    const caps = await navCapabilities(toSessionUser(user));
    assert.ok((await selfHosted(async () => allowedCommandIds(caps))).includes("backup.open"));
    assert.ok(!(await inCloud(async () => allowedCommandIds(caps))).includes("backup.open"));
  });
});

describe("secrets the platform supplies are read-only", () => {
  test("license: the platform's key wins, the panel says so, and changing it is refused", async () => {
    const route = await load("../src/app/api/admin/license/route");
    const env = { COMPASSDOCS_LICENSE_KEY: "not-a-real-license" };
    const got = await inCloud(() => call(route.GET!, `${ORIGIN}/api/admin/license`, "GET"), env);
    assert.equal(got.status, 200, got.text);
    assert.equal(got.body?.source, "platform");
    for (const body of [{ clear: true }, { license_key: "x" }]) {
      const r = await inCloud(() => call(route.PATCH!, `${ORIGIN}/api/admin/license`, "PATCH", body), env);
      assert.equal(r.status, 403, JSON.stringify(body));
      assert.match(String(r.body?.error), /The license key is set by the platform/);
    }
    // Self-hosted with the same variable: a saved key may still be added or removed (an empty PATCH changes nothing).
    const self = await withEnv({ COMPASSDOCS_CLOUD: undefined, ...env }, () => call(route.PATCH!, `${ORIGIN}/api/admin/license`, "PATCH", {}));
    assert.equal(self.status, 200, self.text);
    assert.notEqual(self.body?.state?.source, "platform");
  });

  test("AI: the platform's Anthropic key is shown as such and can't be replaced or removed", async () => {
    const route = await load("../src/app/api/admin/ai/route");
    const env = { ANTHROPIC_API_KEY: "sk-ant-platform-0000000000" };
    const got = await inCloud(() => call(route.GET!, `${ORIGIN}/api/admin/ai`, "GET"), env);
    assert.equal(got.body?.source, "platform");
    for (const body of [{ clear: true }, { api_key: "sk-ant-mine" }]) {
      const r = await inCloud(() => call(route.PATCH!, `${ORIGIN}/api/admin/ai`, "PATCH", body), env);
      assert.equal(r.status, 403, JSON.stringify(body));
    }
  });

  test("SMTP: the platform's relay is what GET shows (no password), and only `use` is accepted", async () => {
    const route = await load("../src/app/api/admin/smtp/route");
    const env = { COMPASSDOCS_SMTP_HOST: "smtp.platform.example", COMPASSDOCS_SMTP_PASSWORD: "relay-secret", COMPASSDOCS_SMTP_FROM: "no-reply@acme.compassdocs.io" };
    const got = await inCloud(() => call(route.GET!, `${ORIGIN}/api/admin/smtp`, "GET"), env);
    assert.equal(got.status, 200);
    assert.equal(got.body?.host, "smtp.platform.example");
    assert.equal(got.body?.platform, true);
    assert.equal(got.body?.has_pass, true);
    assert.ok(!got.text.includes("relay-secret"), "the password never leaves the server");
    const r = await inCloud(() => call(route.PATCH!, `${ORIGIN}/api/admin/smtp`, "PATCH", { host: "smtp.mine.example" }), env);
    assert.equal(r.status, 403);
    assert.match(String(r.body?.error), /SMTP is set by the platform/);
    const self = await withEnv({ COMPASSDOCS_CLOUD: undefined, ...env }, () => call(route.GET!, `${ORIGIN}/api/admin/smtp`, "GET"));
    assert.notEqual(self.body?.host, "smtp.platform.example", "self-hosted never reads the platform's SMTP variables");
    assert.equal(self.body?.platform, false);
  });
});

describe("the address and the session cookie", () => {
  test("cloud mode: links come from COMPASSDOCS_BASE_URL, never a saved custom domain", async () => {
    const { workspaceOrigin } = await import("../src/lib/workspace-origin");
    const { getAppSettings } = await import("../src/lib/settings-store");
    const saved = (await getAppSettings()).custom_domain;
    assert.equal(await inCloud(() => workspaceOrigin()), "https://acme.compassdocs.io");
    assert.equal(await inCloud(() => workspaceOrigin(), { COMPASSDOCS_BASE_URL: "" }), null);
    const self = await withEnv({ COMPASSDOCS_CLOUD: undefined, COMPASSDOCS_BASE_URL: "https://env.example" }, () => workspaceOrigin());
    assert.equal(self, saved ? `https://${saved}` : "https://env.example", "self-hosted: the custom domain, else the variable, as before");
  });

  test("cloud mode: the session cookie is always Secure; self-hosted follows its setting", async () => {
    const { secureCookie } = await import("../src/lib/auth");
    const plain = new Request("http://ws.example/api/auth/login");
    assert.equal(await inCloud(() => secureCookie(plain)), true);
    const mode = await db.getSetting("secure_cookies");
    if (!mode || mode === "auto") assert.equal(await withEnv({ COMPASSDOCS_CLOUD: undefined, COMPASSDOCS_INSECURE_COOKIES: undefined }, () => secureCookie(plain)), false);
  });
});

describe("/readyz", () => {
  test("ready: migrations applied and the database answering", async () => {
    const { GET } = await import("../src/app/readyz/route");
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ready");
    assert.equal(body.migrations, "applied");
    assert.equal(db.schemaReady(), true);
  });

  test("draining: 503 at once, without touching the database", async () => {
    const { GET } = await import("../src/app/readyz/route");
    const g = globalThis as { __compassDraining?: boolean };
    g.__compassDraining = true;
    try {
      const res = await GET();
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { status: "draining" });
    } finally {
      g.__compassDraining = undefined;
    }
  });

  test("/healthz never touches the database", async () => {
    const { GET } = await import("../src/app/healthz/route");
    const res = await GET();
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ok");
  });
});
