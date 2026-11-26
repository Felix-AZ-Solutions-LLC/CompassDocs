// Signing in to PostgreSQL with Microsoft Entra (1.21.3, lib/db-auth,
// lib/azure-credential): DATABASE_AUTH=entra.
//
// The managed identity is a stand-in (setAzureCredentialForTests) that hands
// out a JWT-shaped token; a role on the suite's Postgres has that token as
// its password, so a connection signs in only if the token reached it. The
// database is reached through a TLS front (test/support/tls-pg-proxy), as an
// Azure flexible server is: SSL is required and the certificate verified.
//
// Covered: the token cache (one request for many connections, renewal ahead
// of expiry in the background, a renewal failure that costs nothing while
// the token is good, a burst of callers sharing one request, a token about
// to expire), which failures count as a database outage for lib/db-retry
// (an unreachable token service waits; a refused identity fails at once),
// the start-up checks, and every path that connects: the pool and the
// schema boot (lib/db), the helpdesk's LISTEN connection with and without
// DATABASE_LISTEN_URL (lib/helpdesk/live), and pg_dump through lib/backup's
// environment. Never a token in a log line.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/db-entra.test.ts

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { Client } from "pg";
import {
  CachedToken,
  EntraTokenError,
  FAILURE_MEMO_MS,
  MAX_RENEW_AHEAD_MS,
  MIN_TOKEN_LIFE_MS,
  RENEW_RETRY_MS,
  describeIdentity,
  isTransientTokenFailure,
  setAzureCredentialForTests,
  type TokenSource,
} from "../src/lib/azure-credential";
import {
  ENTRA_POSTGRES_SCOPE,
  checkDatabaseAuthStartup,
  databaseAuth,
  databaseAuthProblems,
  entraClientConfig,
  entraLibpqEnv,
  resetDatabaseTokenForTests,
  setDbAuthLogForTests,
} from "../src/lib/db-auth";
import { isConnectionError } from "../src/lib/db-errors";
import { DatabaseUnavailableError, resetDbOutageForTests, setDbRetryLogForTests } from "../src/lib/db-retry";
import { redact } from "../src/lib/log";
import { makeCertificate, TlsPgProxy, type TestCertificate } from "./support/tls-pg-proxy";

const BASE_URL = process.env.DATABASE_URL;
const ROLE = `entra_app_${process.pid}`;
const DB = `entra_db_${process.pid}`;
// A JWT's shape (header.payload.signature), as long as a real Entra token.
const TOKEN = `eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJodHRwczovL29zc3JkYm1zLWFhZC5kYXRhYmFzZS53aW5kb3dzLm5ldCIsIm9pZCI6InRlc3QifQ.${"s".repeat(1400)}`;

// --- A managed identity that can misbehave ---------------------------------------------

type Mode = "ok" | "down" | "refused";

class FakeIdentity implements TokenSource {
  mode: Mode = "ok";
  calls = 0;
  scopes: string[] = [];
  lifeMs = 60 * 60_000;
  token = TOKEN;
  async getToken(scopes: string | string[]) {
    this.calls++;
    this.scopes.push(String(scopes));
    if (this.mode === "down") {
      const e = new Error("ManagedIdentityCredential: Network unreachable. Message: connect ECONNREFUSED 169.254.169.254:80");
      e.name = "CredentialUnavailableError";
      throw e;
    }
    if (this.mode === "refused") {
      const e = new Error("ManagedIdentityCredential: Authentication failed. Message Identity not found");
      e.name = "CredentialUnavailableError";
      throw e;
    }
    return { token: this.token, expiresOnTimestamp: Date.now() + this.lifeMs };
  }
}

// --- The token cache (no database) -----------------------------------------------------

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("CachedToken: one token per scope, renewed ahead of expiry", () => {
  function clocked(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }
  function source(lifeMs: number, clock: { now: () => number }) {
    const s = { calls: 0, fail: null as Error | null, next: 1 };
    const src: TokenSource = {
      async getToken() {
        s.calls++;
        if (s.fail) throw s.fail;
        return { token: `tok-${s.next++}`, expiresOnTimestamp: clock.now() + lifeMs };
      },
    };
    return { s, src };
  }

  test("renewAt: half the life, at most 30 minutes before expiry, or the service's earlier hint", () => {
    assert.equal(CachedToken.renewAt(0, 24 * 3600_000), 24 * 3600_000 - MAX_RENEW_AHEAD_MS);
    assert.equal(CachedToken.renewAt(0, 10 * 60_000), 5 * 60_000);
    assert.equal(CachedToken.renewAt(0, 24 * 3600_000, 12 * 3600_000), 12 * 3600_000);
    // A hint after the computed time is not used.
    assert.equal(CachedToken.renewAt(0, 60 * 60_000, 59 * 60_000), 30 * 60_000);
  });

  test("many callers, one request; the held token serves until it is due", async () => {
    const clock = clocked();
    const { s, src } = source(60 * 60_000, clock);
    const c = new CachedToken("scope/.default", { source: async () => src, now: clock.now, identity: "test identity" });
    const got = await Promise.all(Array.from({ length: 20 }, () => c.get()));
    assert.ok(got.every((t) => t === "tok-1"));
    assert.equal(s.calls, 1, "a burst of new connections asks the token service once");
    clock.advance(29 * 60_000);
    assert.equal(await c.get(), "tok-1");
    assert.equal(s.calls, 1);
  });

  test("past its renewal time: the held token is returned at once and renewed in the background", async () => {
    const clock = clocked();
    const { s, src } = source(60 * 60_000, clock);
    const c = new CachedToken("scope/.default", { source: async () => src, now: clock.now, identity: "test identity" });
    await c.get();
    clock.advance(31 * 60_000);
    assert.equal(await c.get(), "tok-1", "never waits while the token in hand is good");
    await settle();
    assert.equal(s.calls, 2);
    assert.equal(await c.get(), "tok-2");
  });

  test("a renewal that fails while the token is good: no error, logged once, tried again later", async () => {
    const clock = clocked();
    const { s, src } = source(60 * 60_000, clock);
    const failures: EntraTokenError[] = [];
    let recovered = 0;
    const c = new CachedToken("scope/.default", {
      source: async () => src,
      now: clock.now,
      identity: "test identity",
      onRenewFailure: (e) => failures.push(e),
      onRecovered: () => recovered++,
    });
    await c.get();
    clock.advance(31 * 60_000);
    s.fail = Object.assign(new Error("connect ETIMEDOUT 169.254.169.254:80"), { code: "ETIMEDOUT" });
    for (let i = 0; i < 5; i++) {
      assert.equal(await c.get(), "tok-1");
      await settle();
    }
    assert.equal(s.calls, 2, "not retried before RENEW_RETRY_MS");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].transient, true);
    clock.advance(RENEW_RETRY_MS);
    await c.get();
    await settle();
    assert.equal(s.calls, 3);
    assert.equal(failures.length, 1, "a run of failures is one line");
    s.fail = null;
    clock.advance(RENEW_RETRY_MS);
    await c.get();
    await settle();
    assert.equal(recovered, 1);
    assert.equal(await c.get(), "tok-2");
  });

  test("with no usable token the caller waits for, or fails with, the token service; a failure is remembered briefly", async () => {
    const clock = clocked();
    const { s, src } = source(60 * 60_000, clock);
    s.fail = Object.assign(new Error("Identity not found"), { statusCode: 400 });
    const c = new CachedToken("https://ossrdbms-aad.database.windows.net/.default", { source: async () => src, now: clock.now, identity: "user-assigned managed identity abc" });
    await assert.rejects(c.get(), (e: unknown) => {
      assert.ok(e instanceof EntraTokenError);
      assert.equal(e.transient, false);
      assert.equal(e.code, "ENTRA_TOKEN_REFUSED");
      assert.match(e.message, /^Could not get a Microsoft Entra token for https:\/\/ossrdbms-aad\.database\.windows\.net\/\.default as the user-assigned managed identity abc: Identity not found$/);
      return true;
    });
    await assert.rejects(c.get());
    assert.equal(s.calls, 1, `within ${FAILURE_MEMO_MS} ms the failure is answered from memory`);
    clock.advance(FAILURE_MEMO_MS);
    s.fail = null;
    assert.equal(await c.get(), "tok-1");
  });

  test("a token that is about to expire is not used; one past MIN_TOKEN_LIFE_MS from expiry is fetched again", async () => {
    const clock = clocked();
    const { s, src } = source(MIN_TOKEN_LIFE_MS / 2, clock);
    const c = new CachedToken("scope/.default", { source: async () => src, now: clock.now, identity: "x" });
    await assert.rejects(c.get(), (e: unknown) => e instanceof EntraTokenError && e.transient);
    const long = source(10 * 60_000, clock);
    const d = new CachedToken("scope/.default", { source: async () => long.src, now: clock.now, identity: "x" });
    await d.get();
    clock.advance(10 * 60_000 - MIN_TOKEN_LIFE_MS + 1);
    assert.equal(await d.get(), "tok-2", "too little life left: waits for a new one");
    assert.equal(s.calls, 1);
  });

  test("the error never carries a token-shaped string from the SDK's message", async () => {
    const clock = clocked();
    const { s, src } = source(60 * 60_000, clock);
    s.fail = new Error(`bad response Bearer ${TOKEN} and ${TOKEN}`);
    const c = new CachedToken("scope/.default", { source: async () => src, now: clock.now, identity: "x" });
    await assert.rejects(c.get(), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.ok(!e.message.includes(TOKEN.slice(0, 40)), e.message);
      return true;
    });
  });

  test("transient: network codes, timeouts, 429/5xx, anywhere in the cause chain; not a refusal", () => {
    assert.equal(isTransientTokenFailure(Object.assign(new Error("x"), { code: "ECONNREFUSED" })), true);
    assert.equal(isTransientTokenFailure(new Error("ManagedIdentityCredential: Network unreachable. Message: boom")), true);
    assert.equal(isTransientTokenFailure(Object.assign(new Error("x"), { statusCode: 503 })), true);
    assert.equal(isTransientTokenFailure(Object.assign(new Error("x"), { statusCode: 429 })), true);
    assert.equal(isTransientTokenFailure(new Error("outer", { cause: Object.assign(new Error("inner"), { code: "ETIMEDOUT" }) })), true);
    assert.equal(isTransientTokenFailure(Object.assign(new Error("aborted"), { name: "AbortError" })), true);
    assert.equal(isTransientTokenFailure(Object.assign(new Error("Identity not found"), { statusCode: 400 })), false);
    assert.equal(isTransientTokenFailure(new Error("ManagedIdentityCredential: Authentication failed. Message AADSTS700016")), false);
  });
});

describe("lib/db-errors: which token failures are a database outage", () => {
  test("an unreachable token service waits (connection error); a refused identity does not", () => {
    assert.equal(isConnectionError(new EntraTokenError("system-assigned managed identity", ENTRA_POSTGRES_SCOPE, true, "Network unreachable")), true);
    assert.equal(isConnectionError(new EntraTokenError("system-assigned managed identity", ENTRA_POSTGRES_SCOPE, false, "Identity not found")), false);
  });
});

describe("start-up checks and identity names", () => {
  const ok = { DATABASE_AUTH: "entra", DATABASE_URL: "postgres://app-identity@srv.postgres.database.azure.com/ws1" };

  test("unset or password: nothing changes and nothing is said", async () => {
    assert.equal(databaseAuth({}), "password");
    assert.equal(databaseAuth({ DATABASE_AUTH: "password" }), "password");
    assert.deepEqual(databaseAuthProblems({ DATABASE_URL: "postgres://u:p@h/db", DATABASE_PASSWORD: "x", DATABASE_SSL: "disable" }), []);
    const lines: unknown[] = [];
    assert.equal(await checkDatabaseAuthStartup((...a) => lines.push(a), () => assert.fail("exit"), { DATABASE_URL: "postgres://u:p@h/db" }), true);
    assert.deepEqual(lines, []);
  });

  test("a usable entra setting passes and says how it signs in", async () => {
    assert.equal(databaseAuth(ok), "entra");
    assert.deepEqual(databaseAuthProblems(ok), []);
    const lines: [string, string, Record<string, unknown>][] = [];
    assert.equal(await checkDatabaseAuthStartup((l, e, f) => lines.push([l, e, f]), () => assert.fail("exit"), { ...ok, AZURE_CLIENT_ID: "11111111-2222" }), true);
    assert.equal(lines.length, 1);
    assert.match(String(lines[0][2].message), /Microsoft Entra token for the user-assigned managed identity 11111111-2222, as the role app-identity, over SSL that verifies the server/);
  });

  test("each unusable setting is its own fatal line, and the process exits 1", async () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ DATABASE_AUTH: "aad" }, /DATABASE_AUTH must be "entra"/],
      [{ ...ok, DATABASE_PASSWORD: "pw" }, /remove DATABASE_PASSWORD/],
      [{ ...ok, DATABASE_SSL: "disable" }, /requires SSL/],
      [{ ...ok, DATABASE_URL: "postgres://app:secret@srv/ws1" }, /has a password in it/],
      [{ ...ok, DATABASE_URL: "postgres://srv/ws1" }, /must name the managed identity's PostgreSQL role/],
      [{ ...ok, DATABASE_URL: "postgres://app@srv/ws1?sslmode=disable" }, /sslmode=disable/],
      [{ ...ok, DATABASE_URL: "host=srv user=app dbname=ws1" }, /must be a postgres:\/\/ URL/],
      [{ ...ok, DATABASE_LISTEN_URL: "postgres://app:pw@direct/ws1" }, /DATABASE_LISTEN_URL has a password/],
    ];
    for (const [env, re] of cases) {
      const lines: [string, string, Record<string, unknown>][] = [];
      let code: number | null = null;
      assert.equal(await checkDatabaseAuthStartup((l, e, f) => lines.push([l, e, f]), (c) => (code = c), env), false, JSON.stringify(env));
      assert.equal(code, 1);
      assert.ok(lines.every(([l, e]) => l === "error" && e === "db.refused_to_start"));
      assert.ok(lines.some(([, , f]) => re.test(String(f.message))), `${JSON.stringify(env)}: ${JSON.stringify(lines)}`);
    }
  });

  test("the identity: workload, user-assigned, system-assigned", () => {
    assert.equal(describeIdentity({}), "system-assigned managed identity");
    assert.equal(describeIdentity({ AZURE_CLIENT_ID: "abc" }), "user-assigned managed identity abc");
    assert.equal(describeIdentity({ AZURE_CLIENT_ID: "abc", AZURE_TENANT_ID: "t", AZURE_FEDERATED_TOKEN_FILE: "/f" }), "workload identity abc");
  });

  test("the driver settings: the URL taken apart, no connection string, SSL verified, a password function", () => {
    const c = entraClientConfig("postgres://app%40id@srv.postgres.database.azure.com:6432/ws%201?application_name=cd", {});
    assert.equal(c.host, "srv.postgres.database.azure.com");
    assert.equal(c.port, 6432);
    assert.equal(c.user, "app@id");
    assert.equal(c.database, "ws 1");
    assert.equal(c.application_name, "cd");
    assert.equal((c as { connectionString?: string }).connectionString, undefined);
    assert.equal(typeof c.password, "function");
    assert.deepEqual(c.ssl, { rejectUnauthorized: true });
    assert.deepEqual(entraClientConfig("postgres://app@srv/ws1", { DATABASE_SSL: "no-verify" }).ssl, { rejectUnauthorized: false });
  });

  test("lib/log and start.cjs's early lines mask a JWT wherever it appears", () => {
    assert.equal(redact(`token=${TOKEN} end`, {}), "token=[redacted] end");
    assert.ok(!redact(`{"password":"${TOKEN}"}`, {}).includes("eyJ0eXAi"));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const entry = require("../scripts/start.cjs") as { earlyJsonLine: (l: string, t: string, n?: Date) => string };
    const line = JSON.parse(entry.earlyJsonLine("error", `auth failed for ${TOKEN} (Bearer ${TOKEN})`, new Date(0))) as { message: string };
    assert.ok(!line.message.includes("eyJ0eXAi"), line.message);
    // A license token (one dot, not a credential) is left alone, as are ordinary words.
    assert.equal(redact("eyJhbGciOi.abc and words", {}), "eyJhbGciOi.abc and words");
  });
});

// --- Every connection path, against the suite's Postgres through TLS --------------------

describe("DATABASE_AUTH=entra: every connection the app makes signs in with the token", { skip: !BASE_URL && "DATABASE_URL is not set" }, () => {
  let cert: TestCertificate | null = null;
  let proxy: TlsPgProxy;
  let admin: Client;
  const identity = new FakeIdentity();
  const logs: [string, string, Record<string, unknown>][] = [];
  const allLogs: unknown[] = [];
  const saved: Record<string, string | undefined> = {};
  let entraUrl = "";

  function setEnv(vars: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(vars)) {
      if (!(k in saved)) saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  async function freshPool() {
    const db = await import("../src/lib/db");
    await db.closePool();
    db.reopenPoolForTests();
    resetDatabaseTokenForTests();
    resetDbOutageForTests();
    return db;
  }

  before(async () => {
    cert = makeCertificate();
    if (!cert) return;
    const u = new URL(BASE_URL!);
    proxy = new TlsPgProxy({ host: u.hostname, port: Number(u.port || 5432) }, cert);
    await proxy.listen();
    admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
    // The managed identity's role (pgaadauth_create_principal on Azure); its "password" is the token here.
    await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${TOKEN}'`);
    await admin.query(`CREATE DATABASE ${DB} OWNER ${ROLE}`);
    entraUrl = `postgres://${ROLE}@127.0.0.1:${proxy.port}/${DB}?sslrootcert=${encodeURIComponent(cert.certFile)}`;
    setAzureCredentialForTests(identity);
    setDbAuthLogForTests((l, e, f) => (logs.push([l, e, f]), allLogs.push([l, e, f])));
    setDbRetryLogForTests((l, e, f) => (logs.push([l, e, f]), allLogs.push([l, e, f])));
    setEnv({
      DATABASE_AUTH: "entra",
      DATABASE_URL: entraUrl,
      DATABASE_PASSWORD: undefined,
      DATABASE_LISTEN_URL: undefined,
      DATABASE_SSL: undefined,
      PGPASSWORD: undefined,
      AZURE_CLIENT_ID: "11111111-aaaa-bbbb-cccc-222222222222",
      DATABASE_RETRY_WINDOW_MS: "0",
    });
  });

  after(async () => {
    if (!cert) return;
    const db = await import("../src/lib/db");
    await db.closePool().catch(() => {});
    db.reopenPoolForTests();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    setAzureCredentialForTests(null);
    setDbAuthLogForTests(null);
    setDbRetryLogForTests(null);
    // The front first: its connections end, so nothing holds the database open.
    await proxy.close();
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
    await admin.end();
    rmSync(cert.dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    identity.mode = "ok";
  });

  test("the pool and the schema boot (migrations) sign in as the identity's role, over TLS, with one token", async (t) => {
    if (!cert) return t.skip("openssl is not available to make a test certificate");
    const db = await freshPool();
    identity.calls = 0;
    await db.dbReady();
    const r = await db.pool().query<{ u: string }>("SELECT current_user AS u");
    assert.equal(r.rows[0].u, ROLE);
    // Several connections at once (the pool's max), still one token request.
    await Promise.all(Array.from({ length: 5 }, () => db.pool().query("SELECT pg_sleep(0.05)")));
    assert.equal(identity.calls, 1, "connections share the cached token");
    assert.deepEqual([...new Set(identity.scopes)], [ENTRA_POSTGRES_SCOPE]);
    assert.ok(proxy.tlsSessions >= 1);
    assert.equal(proxy.plaintextAttempts, 0, "never without SSL");
    const tables = await db.pool().query<{ n: number }>("SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'settings'");
    assert.equal(tables.rows[0].n, 1, "the boot created the schema as the identity's role");
  });

  test("the server's certificate is verified: an unknown CA is refused, DATABASE_SSL=no-verify only encrypts", async (t) => {
    if (!cert) return t.skip("openssl is not available");
    setEnv({ DATABASE_URL: `postgres://${ROLE}@127.0.0.1:${proxy.port}/${DB}` });
    let db = await freshPool();
    await assert.rejects(db.pool().query("SELECT 1"), /self[- ]signed|unable to verify|certificate/i);
    setEnv({ DATABASE_SSL: "no-verify" });
    db = await freshPool();
    assert.equal((await db.pool().query<{ one: number }>("SELECT 1 AS one")).rows[0].one, 1);
    setEnv({ DATABASE_URL: entraUrl, DATABASE_SSL: undefined });
    await freshPool();
  });

  test("the LISTEN connection: from the pool's settings, and from DATABASE_LISTEN_URL", async (t) => {
    if (!cert) return t.skip("openssl is not available");
    const { listenClientConfigForTests } = await import("../src/lib/helpdesk/live");
    for (const listenUrl of [undefined, entraUrl]) {
      setEnv({ DATABASE_LISTEN_URL: listenUrl });
      const db = await freshPool();
      const config = listenClientConfigForTests();
      assert.equal(typeof config.password, "function", `listen url ${listenUrl ? "set" : "unset"}: the token function is kept`);
      assert.equal((config as { connectionString?: string }).connectionString, undefined);
      const before = proxy.tlsSessions;
      const client = new Client(config);
      await client.connect();
      const heard = new Promise<string>((resolve) => client.on("notification", (n) => resolve(n.payload ?? "")));
      await client.query("LISTEN entra_test");
      await db.pool().query("SELECT pg_notify('entra_test', 'hello')");
      assert.equal(await heard, "hello");
      assert.equal((await client.query<{ u: string }>("SELECT current_user AS u")).rows[0].u, ROLE);
      await client.end();
      assert.ok(proxy.tlsSessions > before, "over TLS");
    }
    setEnv({ DATABASE_LISTEN_URL: undefined });
  });

  test("backups: pg_dump signs in with the token in its environment (never its arguments), SSL verify-full", async (t) => {
    if (!cert) return t.skip("openssl is not available");
    await freshPool();
    const { pgEnv } = await import("../src/lib/backup");
    const env = await pgEnv();
    assert.equal(env.PGUSER, ROLE);
    assert.equal(env.PGPASSWORD, TOKEN);
    assert.equal(env.PGSSLMODE, "verify-full");
    assert.equal(env.PGSSLROOTCERT, cert.certFile);
    assert.equal(env.PGHOST, "127.0.0.1");
    assert.equal(env.PGDATABASE, DB);
    const libpq = await entraLibpqEnv(`postgres://${ROLE}@srv/${DB}`, { DATABASE_SSL: "no-verify" });
    assert.equal(libpq.PGSSLMODE, "require");
    assert.equal((await entraLibpqEnv(`postgres://${ROLE}@srv/${DB}`, {})).PGSSLROOTCERT, "system");
    const which = spawnSync(process.env.COMPASSDOCS_PG_BIN ? `${process.env.COMPASSDOCS_PG_BIN}/pg_dump` : "pg_dump", ["--version"]);
    if (which.status !== 0) return t.skip("pg_dump is not installed");
    const before = proxy.tlsSessions;
    // Asynchronously: the TLS front runs in this process.
    const run = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.env.COMPASSDOCS_PG_BIN ? `${process.env.COMPASSDOCS_PG_BIN}/pg_dump` : "pg_dump", ["--schema-only", "-t", "settings", "-f", "/dev/null"], { env });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(run.code, 0, run.stderr);
    assert.ok(proxy.tlsSessions > before, "pg_dump went through TLS");
    assert.equal(proxy.plaintextAttempts, 0);
  });

  test("a token service that does not answer: the request waits (lib/db-retry) and goes through when it is back", async (t) => {
    if (!cert) return t.skip("openssl is not available");
    setEnv({ DATABASE_RETRY_WINDOW_MS: "8000" });
    const db = await freshPool();
    identity.mode = "down";
    logs.length = 0;
    setTimeout(() => (identity.mode = "ok"), 1500).unref();
    const r = await db.pool().query<{ u: string }>("SELECT current_user AS u");
    assert.equal(r.rows[0].u, ROLE);
    assert.ok(identity.calls > 1);
    const outage = logs.find(([, e]) => e === "db.unavailable");
    assert.ok(outage, "one database-unavailable warning");
    assert.match(String(outage![2].message), /Could not get a Microsoft Entra token for https:\/\/ossrdbms-aad\.database\.windows\.net\/\.default as the user-assigned managed identity 11111111-aaaa-bbbb-cccc-222222222222/);
    assert.equal(logs.filter(([, e]) => e === "db.entra_token_failed").length, 1, "the token failure is said once");
    assert.ok(logs.some(([, e]) => e === "db.available"));
    // Down for longer than the window: DatabaseUnavailableError, its cause the token error.
    setEnv({ DATABASE_RETRY_WINDOW_MS: "1500" });
    const db2 = await freshPool();
    identity.mode = "down";
    await assert.rejects(db2.pool().query("SELECT 1"), (e: unknown) => e instanceof DatabaseUnavailableError && (e.cause as Error).name === "EntraTokenError");
    setEnv({ DATABASE_RETRY_WINDOW_MS: "0" });
  });

  test("an identity that is refused fails at once, with one line naming the identity and the scope", async (t) => {
    if (!cert) return t.skip("openssl is not available");
    setEnv({ DATABASE_RETRY_WINDOW_MS: "30000" });
    const db = await freshPool();
    identity.mode = "refused";
    logs.length = 0;
    const started = Date.now();
    await assert.rejects(db.pool().query("SELECT 1"), (e: unknown) => {
      assert.ok(e instanceof EntraTokenError, String(e));
      assert.equal(e.transient, false);
      return true;
    });
    assert.ok(Date.now() - started < 5_000, "not waited for: waiting will not fix it");
    const failed = logs.filter(([, e]) => e === "db.entra_token_failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0][0], "error");
    assert.match(String(failed[0][2].message), /as the user-assigned managed identity 11111111-aaaa-bbbb-cccc-222222222222: .*Identity not found/);
    assert.match(String(failed[0][2].message), /ossrdbms-aad\.database\.windows\.net\/\.default/);
    assert.ok(!logs.some(([, e]) => e === "db.unavailable"), "not an outage");
    setEnv({ DATABASE_RETRY_WINDOW_MS: "0" });
  });

  test("no log line ever carries the token", async (t) => {
    if (!cert) return t.skip("openssl is not available");
    const all = JSON.stringify(allLogs);
    assert.ok(allLogs.length > 0);
    assert.ok(!all.includes(TOKEN.slice(0, 60)));
    assert.ok(!all.includes("sssssssssssssssssssss"));
  });
});
