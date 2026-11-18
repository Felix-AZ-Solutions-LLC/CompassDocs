// The Domain & HTTPS routes after the 1.20.29 review: a renewal email that
// isn't a plain address is refused before anything is saved (M2); a PATCH
// that doesn't touch the domain leaves a waiting domain alone (L5); a
// remembered fallback can't be removed from the address the request came
// in on (M5). The handlers are called directly with next/headers stubbed,
// the way test/account-email.test.ts does it. No proxy is attached here.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/domain-routes.test.ts

import Module from "node:module";
import path from "node:path";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

let currentRequest: Request | null = null;
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.domain-routes.virtual.js");
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

const STAMP = `domroutes${Date.now()}`;
const KEYS = ["custom_domain", "tls_mode", "tls_email", "secure_cookies", "custom_domain_pending", "fallback_hosts"];
const saved = new Map<string, string>();
// Shared with test/domain-flow.test.ts, which writes the same settings rows.
const DOMAIN_SETTINGS_LOCK = 1202901;
let lockClient: import("pg").PoolClient | null = null;
let adminId = 0;
let session = "";
type Handler = (req: Request) => Promise<Response>;
let domainRoute: { PATCH: Handler };
let fallbackRoute: { DELETE: Handler };

async function call(handler: Handler, url: string, body: unknown, method: string, host?: string) {
  currentRequest = new Request(url, {
    method,
    headers: { cookie: `compass_session=${session}`, "content-type": "application/json", ...(host ? { host } : {}) },
    body: JSON.stringify(body),
  });
  try {
    const res = await handler(currentRequest);
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> | null };
  } finally {
    currentRequest = null;
  }
}

before(async () => {
  delete process.env.COMPASSDOCS_CADDY_ADMIN;
  await db.getSetting("__schema_bootstrap__");
  lockClient = await db.pool().connect();
  await lockClient.query("SELECT pg_advisory_lock($1)", [DOMAIN_SETTINGS_LOCK]);
  for (const k of KEYS) {
    const v = await db.getSetting(k);
    if (v !== undefined) saved.set(k, v);
  }
  const r = await db.pool().query<{ id: number }>(
    "INSERT INTO users (username, name, email, role, status) VALUES ($1, 'Domain admin', '', 'admin', 'active') RETURNING id",
    [`${STAMP}-admin`]
  );
  adminId = r.rows[0].id;
  session = newToken();
  await db.createSession(session, adminId, new Date(Date.now() + 3_600_000).toISOString());
  domainRoute = (await import("../src/app/api/admin/domain/route")) as unknown as { PATCH: Handler };
  fallbackRoute = (await import("../src/app/api/admin/domain/fallback/route")) as unknown as { DELETE: Handler };
});

after(async () => {
  await db.pool().query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
  for (const [k, v] of saved) await db.setSetting(k, v);
  await db.pool().query("DELETE FROM sessions WHERE user_id = $1", [adminId]);
  await db.pool().query("DELETE FROM audit_log WHERE actor_id = $1", [adminId]);
  await db.pool().query("DELETE FROM users WHERE id = $1", [adminId]);
  await lockClient?.query("SELECT pg_advisory_unlock($1)", [DOMAIN_SETTINGS_LOCK]);
  lockClient?.release();
  await db.pool().end();
});

describe("Domain & HTTPS routes", () => {
  test("a renewal email that isn't a plain address is refused, and nothing is saved (review M2)", async () => {
    await db.setSetting("tls_email", "ops@example.com");
    for (const bad of ["ops@example.com\n}\n:9999 {\n\trespond hi", "a b@example.com", "{env.X}@example.com"]) {
      const r = await call(domainRoute.PATCH, "http://docs.example.com/api/admin/domain", { custom_domain: "", tls_mode: "auto", tls_email: bad }, "PATCH");
      assert.equal(r.status, 400, bad);
      assert.match(String(r.body?.error), /plain email address/);
    }
    assert.equal(await db.getSetting("tls_email"), "ops@example.com");
  });

  test("a PATCH without domain fields leaves a waiting domain alone (review L5)", async () => {
    const row = JSON.stringify({
      domain: "waiting.example.com",
      tls_mode: "auto",
      tls_email: "",
      requested_at: new Date().toISOString(),
      requested_by: { id: null, name: STAMP },
      auto_until: new Date(Date.now() + 3_600_000).toISOString(),
      next_check_at: new Date(Date.now() + 300_000).toISOString(),
      attempts: 1,
      phase: "waiting",
      last_check: { ok: false, code: "nxdomain", domain: "waiting.example.com", addresses: [], cname: null, tried: [], message: "x", checked_at: new Date().toISOString() },
    });
    await db.setSetting("custom_domain_pending", row);
    const r = await call(domainRoute.PATCH, "http://docs.example.com/api/admin/domain", { secure_cookies: "always" }, "PATCH");
    assert.equal(r.status, 200);
    assert.equal(await db.getSetting("custom_domain_pending"), row);
    assert.equal(await db.getSetting("secure_cookies"), "always");
    assert.equal(r.body?.state?.pending?.domain, "waiting.example.com");
  });

  test("a remembered fallback can't be removed from the address the request came in on (review M5)", async () => {
    await db.setSetting("fallback_hosts", JSON.stringify([{ host: "here.example.org", acme: true }, { host: "there.example.org", acme: false }]));
    const mine = await call(fallbackRoute.DELETE, "http://here.example.org/api/admin/domain/fallback", { host: "here.example.org" }, "DELETE", "here.example.org");
    assert.equal(mine.status, 409);
    assert.match(String(mine.body?.error), /You're using here\.example\.org right now/);
    const other = await call(fallbackRoute.DELETE, "http://here.example.org/api/admin/domain/fallback", { host: "there.example.org" }, "DELETE", "here.example.org:443");
    assert.equal(other.status, 200);
    assert.deepEqual(JSON.parse((await db.getSetting("fallback_hosts"))!), [{ host: "here.example.org", acme: true }]);
  });
});
