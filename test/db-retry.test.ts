// Riding out a database restart (1.21.2, lib/db-retry): through a TCP proxy
// in front of the real Postgres that can refuse connections, answer like a
// server that is starting up (57P03), or cut a connection right after a
// statement reached the server. Checks exactly what is retried (getting a
// connection, a statement pg never sent) and what never is (a statement that
// was sent, a transaction that broke midway), the waiting window and its
// caps (the outage's own window, the drain deadline, a closed pool, readyz),
// broken clients evicted, one warning per outage, and background jobs that
// skip a run quietly.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/db-retry.test.ts

import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { Client, type Pool } from "pg";
import {
  DatabaseUnavailableError,
  RetryingPool,
  backoffMs,
  currentDbOutage,
  resetDbOutageForTests,
  retryDeadline,
  retryWindowMs,
  setDbRetryLogForTests,
  withoutDbRetry,
  RETRY_MAX_DELAY_MS,
  SHUTDOWN_RESERVE_MS,
} from "../src/lib/db-retry";
import { connectionErrorLabel, isConnectionError, isNeverSentError } from "../src/lib/db-errors";
import { jobError, resetLifecycleForTests, runJob } from "../src/lib/shutdown";

const URL_ = process.env.DATABASE_URL;
const TABLE = `db_retry_${process.pid}`;

// --- A proxy that can misbehave --------------------------------------------------------

type Mode = "up" | "down" | "starting" | "cut-after-statement";

class FlakyProxy {
  mode: Mode = "up";
  /** Connections accepted, and statements forwarded before a cut. */
  accepted = 0;
  cutStatements = 0;
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  port = 0;

  constructor(private readonly target: { host: string; port: number }) {}

  async listen(): Promise<void> {
    this.server = net.createServer((client) => this.handle(client));
    await new Promise<void>((resolve) => this.server!.listen(this.port, "127.0.0.1", resolve));
    this.port = (this.server!.address() as net.AddressInfo).port;
  }

  private handle(client: net.Socket): void {
    this.accepted++;
    this.sockets.add(client);
    client.on("close", () => this.sockets.delete(client));
    client.on("error", () => {});
    if (this.mode === "starting") {
      // Answer the startup packet like a server that is starting up: FATAL 57P03.
      client.once("data", () => {
        const fields = Buffer.concat([
          Buffer.from("SFATAL\0VFATAL\0C57P03\0Mthe database system is starting up\0", "utf8"),
          Buffer.from([0]),
        ]);
        const head = Buffer.alloc(5);
        head.write("E", 0);
        head.writeUInt32BE(fields.length + 4, 1);
        client.end(Buffer.concat([head, fields]));
      });
      return;
    }
    const upstream = net.connect(this.target.port, this.target.host);
    this.sockets.add(upstream);
    upstream.on("close", () => {
      this.sockets.delete(upstream);
      client.destroy();
    });
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    let answered = true;
    // After a cut statement, the server's answer is dropped: it ran it, the client never hears.
    upstream.on("data", (d) => answered && client.write(d));
    client.on("data", (d: Buffer) => {
      // A statement: simple query (Q) or the extended protocol's Parse (P) / Bind (B).
      const statement = d.length > 0 && (d[0] === 0x51 || d[0] === 0x50 || d[0] === 0x42);
      if (this.mode === "cut-after-statement" && statement) {
        this.cutStatements++;
        answered = false;
        upstream.write(d);
        // The server gets the statement and runs it; the answer never comes back.
        setTimeout(() => {
          client.destroy();
          upstream.destroy();
        }, 300);
        return;
      }
      upstream.write(d);
    });
  }

  /** Stop listening (connections are refused) and cut every open connection. */
  async down(): Promise<void> {
    this.mode = "down";
    const server = this.server;
    this.server = null;
    // Cut first: close() waits for every open connection to end.
    const closed = new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    for (const s of this.sockets) s.destroy();
    await closed;
  }

  async up(): Promise<void> {
    this.mode = "up";
    if (!this.server) await this.listen();
  }

  async close(): Promise<void> {
    await this.down();
  }
}

// --- Fixtures ----------------------------------------------------------------------------

let proxy: FlakyProxy;
let lines: { level: string; event: string; message: string }[] = [];
const savedEnv = { window: process.env.DATABASE_RETRY_WINDOW_MS, cloud: process.env.COMPASSDOCS_CLOUD };

function urlVia(port: number): string {
  const u = new URL(URL_!);
  u.hostname = "127.0.0.1";
  u.port = String(port);
  return u.toString();
}

/** Typed as lib/db hands it out (pool(): Pool). */
function poolVia(opts: { max?: number; connectTimeout?: number } = {}): Pool {
  return new RetryingPool({ connectionString: urlVia(proxy.port), max: opts.max ?? 3, connectionTimeoutMillis: opts.connectTimeout ?? 3000 });
}

async function direct<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: URL_ });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

before(async () => {
  assert.ok(URL_, "DATABASE_URL is set");
  const u = new URL(URL_!);
  proxy = new FlakyProxy({ host: u.hostname === "localhost" ? "127.0.0.1" : u.hostname, port: Number(u.port) || 5432 });
  await proxy.listen();
  await direct(`CREATE TABLE IF NOT EXISTS ${TABLE} (id serial PRIMARY KEY, note text NOT NULL)`);
});

after(async () => {
  await proxy.close();
  await direct(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
  if (savedEnv.window === undefined) delete process.env.DATABASE_RETRY_WINDOW_MS;
  else process.env.DATABASE_RETRY_WINDOW_MS = savedEnv.window;
  if (savedEnv.cloud === undefined) delete process.env.COMPASSDOCS_CLOUD;
  else process.env.COMPASSDOCS_CLOUD = savedEnv.cloud;
});

beforeEach(async () => {
  await proxy.up();
  proxy.accepted = 0;
  proxy.cutStatements = 0;
  lines = [];
  setDbRetryLogForTests((level, event, f) => lines.push({ level, event, message: String(f.message) }));
  resetDbOutageForTests();
  resetLifecycleForTests();
  process.env.DATABASE_RETRY_WINDOW_MS = "8000";
  delete process.env.COMPASSDOCS_CLOUD;
  await direct(`TRUNCATE ${TABLE}`);
});

afterEach(() => {
  setDbRetryLogForTests(null);
  resetDbOutageForTests();
  resetLifecycleForTests();
});

const rows = async () => Number((await direct<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLE}`))[0].n);
const later = (ms: number, fn: () => unknown) => setTimeout(() => void fn(), ms);

// --- The rules, as pure functions ---------------------------------------------------------

describe("which errors are an outage", () => {
  test("connection errors are; a statement's own errors, authentication and a missing database are not", () => {
    for (const e of [
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.4:5432"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }),
      Object.assign(new Error("the database system is starting up"), { code: "57P03" }),
      new Error("Connection terminated unexpectedly"),
      new Error("timeout exceeded when trying to connect"),
      new Error("Connection terminated due to connection timeout", { cause: new Error("x") }),
      new Error("Client has encountered a connection error and is not queryable"),
      new DatabaseUnavailableError(1000, new Error("Connection terminated unexpectedly")),
    ]) {
      assert.equal(isConnectionError(e), true, connectionErrorLabel(e));
    }
    for (const e of [
      Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }),
      Object.assign(new Error('password authentication failed for user "x"'), { code: "28P01" }),
      Object.assign(new Error('database "nope" does not exist'), { code: "3D000" }),
      Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
      Object.assign(new Error("deadlock detected"), { code: "40P01" }),
      Object.assign(new Error("getaddrinfo ENOTFOUND db.example"), { code: "ENOTFOUND" }),
      new Error("syntax error at or near"),
      null,
      "Connection terminated unexpectedly",
    ]) {
      assert.equal(isConnectionError(e), false, String((e as Error)?.message ?? e));
    }
    assert.equal(isNeverSentError(new Error("Client has encountered a connection error and is not queryable")), true);
    assert.equal(isNeverSentError(new Error("Client was closed and is not queryable")), true);
    assert.equal(isNeverSentError(new Error("Connection terminated unexpectedly")), false, "a cut connection may have run the statement");
  });

  test("the window: 60 s in cloud mode, none self-hosted, DATABASE_RETRY_WINDOW_MS when set (capped)", () => {
    assert.equal(retryWindowMs({}), 0);
    assert.equal(retryWindowMs({ COMPASSDOCS_CLOUD: "1" }), 60_000);
    assert.equal(retryWindowMs({ COMPASSDOCS_CLOUD: "1", DATABASE_RETRY_WINDOW_MS: "0" }), 0);
    assert.equal(retryWindowMs({ DATABASE_RETRY_WINDOW_MS: "15000" }), 15_000);
    assert.equal(retryWindowMs({ DATABASE_RETRY_WINDOW_MS: "99999999" }), 600_000);
    assert.equal(retryWindowMs({ COMPASSDOCS_CLOUD: "1", DATABASE_RETRY_WINDOW_MS: "junk" }), 60_000);
  });

  test("backoff doubles from 250 ms to at most 5 s, with jitter", () => {
    assert.equal(backoffMs(0, () => 0), 125);
    assert.equal(backoffMs(0, () => 1), 250);
    assert.equal(backoffMs(3, () => 1), 2000);
    assert.equal(backoffMs(30, () => 1), RETRY_MAX_DELAY_MS);
    assert.ok(backoffMs(30, () => 0) >= RETRY_MAX_DELAY_MS / 2);
  });

  test("the deadline: the request's window, the outage's window, the drain deadline, withoutDbRetry", () => {
    const env = { DATABASE_RETRY_WINDOW_MS: "60000" };
    assert.equal(retryDeadline(1_000_000, env, 1_000_000), 1_060_000);
    assert.equal(withoutDbRetry(() => retryDeadline(1_000_000, env, 1_000_000)), 0, "a probe never waits");
    assert.equal(retryDeadline(1_000_000, {}, 1_000_000), 0, "self-hosted: no waiting");
    const g = globalThis as unknown as { __compassDbOutage?: unknown; __compassDraining?: boolean; __compassDrainDeadline?: number };
    g.__compassDbOutage = { since: 950_000, lastFailureAt: 999_000, error: "x", waited: 0, gaveUp: 0, jobsSkipped: 0 };
    assert.equal(retryDeadline(1_000_000, env, 1_000_000), 1_010_000, "50 s into an outage, 10 s are left");
    g.__compassDraining = true;
    g.__compassDrainDeadline = 1_005_000;
    assert.equal(retryDeadline(1_000_000, env, 1_000_000), 1_005_000 - SHUTDOWN_RESERVE_MS, "never past the drain deadline");
    g.__compassDrainDeadline = undefined;
    assert.equal(retryDeadline(1_000_000, env, 1_000_000), 1_000_000, "draining, deadline unknown: no more waiting");
    g.__compassDraining = undefined;
  });
});

// --- Against a real server through the proxy ---------------------------------------------

describe("waiting through an outage", () => {
  test("refused connections: requests wait, then succeed; one warning and one recovery line for the whole outage", async () => {
    const pool = poolVia();
    try {
      await pool.query("SELECT 1");
      await proxy.down();
      // The pool's idle client sees its connection close (a server that stops says so first:
      // 57P01). A statement already sent on a connection as it closes is never retried (below).
      await new Promise((r) => setTimeout(r, 200));
      later(1500, () => proxy.up());
      const started = Date.now();
      const results = await Promise.all([1, 2, 3, 4, 5].map((n) => pool.query<{ n: number }>("SELECT $1::int AS n", [n])));
      assert.deepEqual(results.map((r) => r.rows[0].n), [1, 2, 3, 4, 5]);
      assert.ok(Date.now() - started >= 1000, "they waited for the database");
      assert.deepEqual(
        lines.map((l) => `${l.level} ${l.event}`),
        ["warn db.unavailable", "info db.available"],
        "one warning per outage, not one per request"
      );
      assert.match(lines[0].message, /Requests wait up to 8 s for it to come back\.$/);
      assert.match(lines[1].message, /^The database is back after \d+ s: 5 requests waited for it, 0 gave up\.$/);
      assert.equal(currentDbOutage(), null);
    } finally {
      await pool.end();
    }
  });

  test("a server that is starting up (57P03) is waited for, and so is pool.connect() for a transaction", async () => {
    const pool = poolVia();
    try {
      proxy.mode = "starting";
      later(1200, () => (proxy.mode = "up"));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`INSERT INTO ${TABLE} (note) VALUES ('after 57P03')`);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      assert.equal(await rows(), 1);
      assert.ok(proxy.accepted >= 2, "connected again after the refusal");
      assert.equal(lines[0]?.event, "db.unavailable");
      assert.match(lines[0].message, /57P03|starting up/);
    } finally {
      await pool.end();
    }
  });

  test("a request gives up after the window with DatabaseUnavailableError, and the outage's window caps later ones", async () => {
    process.env.DATABASE_RETRY_WINDOW_MS = "1500";
    const pool = poolVia();
    try {
      await proxy.down();
      let started = Date.now();
      await assert.rejects(pool.query("SELECT 1"), (e: unknown) => {
        assert.ok(e instanceof DatabaseUnavailableError);
        assert.match((e as Error).message, /^The database is unavailable \(.*ECONNREFUSED.*\); waited [12] s for it\.$/);
        assert.equal(isConnectionError(e), true);
        return true;
      });
      const waited = Date.now() - started;
      assert.ok(waited >= 1300 && waited < 4000, `waited about the window (${waited} ms)`);
      // The outage is now older than its window: the next request tries once and fails at once.
      started = Date.now();
      await assert.rejects(pool.query("SELECT 1"), DatabaseUnavailableError);
      assert.ok(Date.now() - started < 500, "no second full wait");
      assert.equal(currentDbOutage()?.gaveUp, 2);
      await proxy.up();
      await pool.query("SELECT 1");
      assert.match(lines.at(-1)!.message, /1 request waited for it, 2 gave up/);
    } finally {
      await pool.end();
    }
  });

  test("self-hosted default (no window): fails at once with the driver's own error, as before 1.21.2", async () => {
    delete process.env.DATABASE_RETRY_WINDOW_MS;
    const pool = poolVia();
    try {
      await proxy.down();
      const started = Date.now();
      await assert.rejects(pool.query("SELECT 1"), (e: NodeJS.ErrnoException) => {
        assert.ok(!(e instanceof DatabaseUnavailableError));
        assert.equal(e.code, "ECONNREFUSED");
        return true;
      });
      await assert.rejects(pool.connect(), (e: NodeJS.ErrnoException) => e.code === "ECONNREFUSED");
      assert.ok(Date.now() - started < 1000);
    } finally {
      await pool.end();
    }
  });

  test("authentication failures are never waited for", async () => {
    const u = new URL(urlVia(proxy.port));
    u.password = "definitely-wrong";
    const pool: Pool = new RetryingPool({ connectionString: u.toString(), max: 1 });
    try {
      const started = Date.now();
      await assert.rejects(pool.query("SELECT 1"), (e: NodeJS.ErrnoException) => e.code === "28P01");
      assert.ok(Date.now() - started < 1500);
      assert.equal(proxy.accepted, 1, "tried once");
      assert.deepEqual(lines, [], "not an outage");
    } finally {
      await pool.end();
    }
  });

  test("telemetry counts the outage and the requests that waited (recovered or gave up)", async () => {
    const counts = { outages: 0, recovered: 0, gave_up: 0 };
    const g = globalThis as unknown as { __compassTelemetry?: unknown };
    g.__compassTelemetry = {
      traceIds: () => null,
      job: (_n: string, fn: () => Promise<unknown>) => fn(),
      smtp: (_s: unknown, fn: () => Promise<unknown>) => fn(),
      mail: () => {},
      dbOutage: () => void counts.outages++,
      dbRetry: (o: "recovered" | "gave_up") => void counts[o]++,
    };
    process.env.DATABASE_RETRY_WINDOW_MS = "1200";
    const pool = poolVia();
    try {
      await proxy.down();
      await assert.rejects(pool.query("SELECT 1"), DatabaseUnavailableError);
      resetDbOutageForTests();
      process.env.DATABASE_RETRY_WINDOW_MS = "8000";
      later(800, () => proxy.up());
      await pool.query("SELECT 1");
      assert.deepEqual(counts, { outages: 2, recovered: 1, gave_up: 1 });
    } finally {
      delete g.__compassTelemetry;
      await pool.end();
    }
  });

  test("withoutDbRetry (readyz): no waiting", async () => {
    const pool = poolVia();
    try {
      await proxy.down();
      const started = Date.now();
      await assert.rejects(withoutDbRetry(() => pool.query("SELECT 1")), (e: NodeJS.ErrnoException) => e.code === "ECONNREFUSED");
      assert.ok(Date.now() - started < 1000);
    } finally {
      await pool.end();
    }
  });
});

describe("never re-running a statement", () => {
  test("a write whose connection drops after the statement was sent is not re-run", async () => {
    const pool = poolVia();
    try {
      await pool.query("SELECT 1"); // a connection in the pool, past its startup
      proxy.mode = "cut-after-statement";
      later(2000, () => (proxy.mode = "up"));
      await assert.rejects(pool.query(`INSERT INTO ${TABLE} (note) VALUES ($1)`, ["once"]), (e: Error) => {
        assert.ok(!(e instanceof DatabaseUnavailableError), "the caller gets the connection error itself: nothing was retried");
        assert.equal(isConnectionError(e), true);
        return true;
      });
      // Long enough for any retry to have happened.
      await new Promise((r) => setTimeout(r, 2500));
      assert.equal(proxy.cutStatements, 1, "the statement was sent exactly once");
      assert.equal(await rows(), 1, "the server ran it once (it committed before the connection went) and it was not run again");
      // The pool carries on with a fresh connection.
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n, 1);
    } finally {
      await pool.end();
    }
  });

  test("a transaction that broke midway is not resumed or replayed, and its client is evicted", async () => {
    const pool = poolVia({ max: 1 });
    try {
      const first = await pool.connect();
      const pid = (await first.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await first.query("BEGIN");
      await first.query(`INSERT INTO ${TABLE} (note) VALUES ('in the transaction')`);
      proxy.mode = "cut-after-statement";
      await assert.rejects(first.query("COMMIT"), (e: Error) => isConnectionError(e));
      first.release();
      proxy.mode = "up";
      await new Promise((r) => setTimeout(r, 2500));
      assert.equal(proxy.cutStatements, 1, "COMMIT was sent once, never again");
      // Whether the COMMIT landed is the server's business; this side never replays the INSERT.
      assert.ok((await rows()) <= 1);
      const next = await pool.connect();
      try {
        const pid2 = (await next.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        assert.notEqual(pid2, pid, "the broken client was not handed out again");
      } finally {
        next.release();
      }
    } finally {
      await pool.end();
    }
  });

  test("a client whose connection died while idle is dropped before use; the statement runs on a fresh one", async () => {
    const pool = poolVia({ max: 2 });
    try {
      const c = await pool.connect();
      const pid = (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      c.release();
      // pg already knows this connection failed (no round trip needed to see it).
      (c as unknown as { _queryable: boolean })._queryable = false;
      const r = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      assert.notEqual(r.rows[0].pid, pid);
      assert.equal(pool.totalCount, 1, "the dead client is gone from the pool");
    } finally {
      await pool.end();
    }
  });

  test("the server ending idle connections (admin shutdown) is noted, never an uncaught error", async () => {
    const pool = poolVia({ max: 2 });
    try {
      const a = await pool.connect();
      const pid = (await a.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      a.release();
      await direct("SELECT pg_terminate_backend($1)", [pid]);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(pool.totalCount, 0, "pg-pool removed the dead idle client");
      assert.equal(lines[0]?.event, "db.unavailable");
      assert.equal((await pool.query("SELECT 1 AS one")).rows[0].one, 1);
      assert.equal(lines.at(-1)?.event, "db.available");
    } finally {
      await pool.end();
    }
  });
});

describe("shutdown and background jobs", () => {
  test("draining: a waiting request stops before the drain deadline; a closed pool stops it at once", async () => {
    process.env.DATABASE_RETRY_WINDOW_MS = "30000";
    const g = globalThis as unknown as { __compassDraining?: boolean; __compassDrainDeadline?: number };
    const pool = poolVia();
    try {
      await proxy.down();
      g.__compassDraining = true;
      g.__compassDrainDeadline = Date.now() + SHUTDOWN_RESERVE_MS + 1000;
      let started = Date.now();
      await assert.rejects(pool.query("SELECT 1"), DatabaseUnavailableError);
      let took = Date.now() - started;
      assert.ok(took < 2000, `stopped by the drain deadline less the reserve (${took} ms)`);
      g.__compassDraining = undefined;
      g.__compassDrainDeadline = undefined;
      resetDbOutageForTests();
      started = Date.now();
      const waiting = pool.query("SELECT 1").catch((e) => e);
      await new Promise((r) => setTimeout(r, 400));
      await pool.end();
      const e = await waiting;
      took = Date.now() - started;
      assert.ok(e instanceof Error);
      assert.ok(took < 1500, `the closed pool ended the wait (${took} ms)`);
    } finally {
      g.__compassDraining = undefined;
      g.__compassDrainDeadline = undefined;
      await pool.end().catch(() => {});
    }
  });

  test("a background job that meets an outage is a skipped run: not logged again, counted in the recovery line", async () => {
    process.env.DATABASE_RETRY_WINDOW_MS = "500";
    const pool = poolVia();
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      await proxy.down();
      assert.equal(await runJob("hourly", async () => (await pool.query("SELECT 1")).rows), undefined);
      jobError("[digest] scheduler error:", new DatabaseUnavailableError(500, new Error("Connection terminated unexpectedly")));
      jobError("[digest] scheduler error:", new Error("a real bug"));
      assert.equal(errors.length, 1, "only the non-outage error is logged");
      assert.match(String(errors[0][0]), /\[digest\] scheduler error:/);
      await proxy.up();
      assert.ok(await runJob("hourly", async () => (await pool.query("SELECT 1")).rows));
      assert.match(lines.at(-1)!.message, /2 background tasks skipped/);
    } finally {
      console.error = original;
      await pool.end();
    }
  });
});
