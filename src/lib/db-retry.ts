// Riding out a database restart (1.21.2).
//
// Azure resizes, patches and fails over a PostgreSQL flexible server with a
// pause of 10 to 60 seconds: new connections are refused (ECONNREFUSED,
// 57P03 "the database system is starting up") and open ones are cut
// (57P01 admin_shutdown, "Connection terminated unexpectedly", ECONNRESET).
// lib/db's pool is a RetryingPool, which waits for the database through such
// a pause instead of failing every request that arrives in it.
//
// What is retried, exactly (and nothing else):
//
//   1. Getting a connection. pool().connect() and the connection half of
//      pool().query() are tried again, with backoff, when they fail with a
//      connection error (lib/db-errors isConnectionError). Nothing has been
//      sent to the server yet, so trying again can never run a statement
//      twice. Authentication, a missing database and every other error fail
//      at once, as before.
//   2. A pool().query() whose statement pg refused to send: "Client has
//      encountered a connection error and is not queryable" / "Client was
//      closed and is not queryable". pg answers that before writing a byte,
//      so the statement is run on a fresh connection.
//
// Never retried:
//
//   - A statement that was sent. If the connection drops after pool().query()
//     wrote its statement, the error goes to the caller: the server may have
//     run it and committed (an INSERT, an UPDATE, a nextval) before the
//     connection went, and nothing on this side can tell. Reads are not
//     special-cased either: a SELECT can call a function that writes.
//   - Anything on a client the caller holds (pool().connect() then BEGIN …
//     COMMIT). Only getting the client is retried; once the caller has it,
//     a statement that fails is the caller's error, and a transaction that
//     broke midway is never resumed or replayed. Its client is evicted from
//     the pool when it is released (below), never handed out again.
//
// How long: each request waits at most DATABASE_RETRY_WINDOW_MS (60 s in
// cloud mode; 0, no waiting, on a self-hosted install unless it is set), and
// never past the end of the outage's own window: a request that arrives 50 s
// into an outage waits 10 s more, and once an outage is older than the
// window, requests try once and fail at once until the database answers
// again, rather than every request queueing for a full minute. While the
// process is shutting down (lib/shutdown), no wait runs past the drain
// deadline less SHUTDOWN_RESERVE_MS, and none at all once the pool is
// closed. A request that gave up fails with DatabaseUnavailableError (its
// cause attached); with no waiting configured, with the driver's own error,
// as before 1.21.2.
//
// Broken clients: a client that saw a connection error, or whose connection
// is no longer usable, is released with an error, so pg-pool closes it
// rather than putting it back; one found broken when it is handed out is
// dropped and another taken. An error from an idle client (the server shut
// its connections) is noted, not thrown.
//
// One warning per outage: the first connection error logs "db.unavailable"
// once; the first success after it logs "db.available" with how long it
// lasted and how many requests waited or gave up. With telemetry on
// (lib/telemetry), outages and waiting requests are counted too.
//
// readyz checks the database without waiting (withoutDbRetry): a probe must
// answer within its own timeout.

import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { connectionErrorLabel, isConnectionError, isNeverSentError } from "./db-errors";
import { logEvent } from "./log";
import { telemetryHooks } from "./telemetry-hooks";

export type Env = Record<string, string | undefined>;

/** The default wait in cloud mode (ms). */
export const DEFAULT_CLOUD_RETRY_WINDOW_MS = 60_000;
/** The longest DATABASE_RETRY_WINDOW_MS may be. */
export const MAX_RETRY_WINDOW_MS = 10 * 60_000;
/** Backoff between tries: from BASE, doubling, at most MAX (each with jitter). */
export const RETRY_BASE_DELAY_MS = 250;
export const RETRY_MAX_DELAY_MS = 5_000;
/** While draining, waits end this long before the drain deadline (flush and close need it). */
export const SHUTDOWN_RESERVE_MS = 3_000;
/** A wait is slept in slices this long, so a drain or a closed pool ends it promptly. */
const SLICE_MS = 500;
/** A failure this long after the last one (and at least a window), with no success seen between, starts a new outage. */
const QUIET_MS = 30_000;

function isCloudEnv(env: Env): boolean {
  const v = env.COMPASSDOCS_CLOUD?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * How long a request waits for the database (ms): DATABASE_RETRY_WINDOW_MS
 * (0 to 600000) when set, else 60 s in cloud mode and 0 self-hosted.
 */
export function retryWindowMs(env: Env = process.env): number {
  const raw = env.DATABASE_RETRY_WINDOW_MS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.min(Math.round(n), MAX_RETRY_WINDOW_MS);
  }
  return isCloudEnv(env) ? DEFAULT_CLOUD_RETRY_WINDOW_MS : 0;
}

/** A request waited for the database and it did not come back in time. */
export class DatabaseUnavailableError extends Error {
  readonly code = "DB_UNAVAILABLE";
  constructor(
    readonly waitedMs: number,
    cause: unknown
  ) {
    super(
      `The database is unavailable (${connectionErrorLabel(cause)}); waited ${Math.round(waitedMs / 1000)} s for it.`,
      { cause }
    );
    this.name = "DatabaseUnavailableError";
  }
}

// --- Outage state (one per process: globalThis, like lib/db's pool) ---------------

interface Outage {
  since: number;
  lastFailureAt: number;
  error: string;
  waited: number;
  gaveUp: number;
  jobsSkipped: number;
}

const G = globalThis as unknown as {
  __compassDbOutage?: Outage | null;
  __compassDraining?: boolean;
  __compassDrainDeadline?: number;
  __compassLifecycle?: { draining?: boolean };
  __compassPoolClosed?: boolean;
};

type Log = (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => void;
let log: Log = (level, event, fields) => logEvent(level, event, fields);

/** Tests: capture the outage lines. Returns the previous logger. */
export function setDbRetryLogForTests(fn: Log | null): Log {
  const prev = log;
  log = fn ?? ((level, event, fields) => logEvent(level, event, fields));
  return prev;
}

/** The outage in progress, if any (tests, lib/shutdown). */
export function currentDbOutage(): Readonly<Outage> | null {
  return G.__compassDbOutage ?? null;
}

/** Tests: forget the outage. */
export function resetDbOutageForTests(): void {
  G.__compassDbOutage = null;
}

/** A connection error was seen: starts an outage (one warning) or extends the current one. */
export function noteDbFailure(e: unknown, now = Date.now(), env: Env = process.env): Outage {
  const window = retryWindowMs(env);
  let o = G.__compassDbOutage ?? null;
  // An outage nobody saw end (no query since) that went quiet for a whole window is over.
  if (o && now - o.lastFailureAt > Math.max(window, QUIET_MS)) o = null;
  if (!o) {
    o = { since: now, lastFailureAt: now, error: connectionErrorLabel(e), waited: 0, gaveUp: 0, jobsSkipped: 0 };
    G.__compassDbOutage = o;
    log("warn", "db.unavailable", {
      message:
        window > 0
          ? `The database is unavailable (${o.error}). Requests wait up to ${Math.round(window / 1000)} s for it to come back.`
          : `The database is unavailable (${o.error}). Requests fail until it is back (DATABASE_RETRY_WINDOW_MS is 0).`,
      error: o.error,
      retry_window_ms: window,
    });
    try {
      telemetryHooks()?.dbOutage?.();
    } catch {
      /* telemetry never breaks a query */
    }
  }
  o.lastFailureAt = now;
  return o;
}

/** A statement succeeded: ends the outage, if one is in progress (one line). */
export function noteDbSuccess(now = Date.now()): void {
  const o = G.__compassDbOutage;
  if (!o) return;
  G.__compassDbOutage = null;
  const seconds = Math.max(0, Math.round((now - o.since) / 1000));
  const parts = [`${o.waited} request${o.waited === 1 ? "" : "s"} waited for it`, `${o.gaveUp} gave up`];
  // Counted by lib/shutdown jobError: a background task that met the outage, tried again at its next run.
  if (o.jobsSkipped) parts.push(`${o.jobsSkipped} background task${o.jobsSkipped === 1 ? "" : "s"} skipped`);
  log("info", "db.available", {
    message: `The database is back after ${seconds} s: ${parts.join(", ")}.`,
    outage_ms: now - o.since,
    waited: o.waited,
    gave_up: o.gaveUp,
    jobs_skipped: o.jobsSkipped,
  });
}

/** A request is about to wait for the first time (counted in the outage's "requests waited" when it ends). */
function countWaiting(): void {
  const o = G.__compassDbOutage;
  if (o) o.waited++;
}

function countRetry(outcome: "recovered" | "gave_up"): void {
  const o = G.__compassDbOutage;
  if (o && outcome === "gave_up") o.gaveUp++;
  try {
    telemetryHooks()?.dbRetry?.(outcome);
  } catch {
    /* never breaks a query */
  }
}

// --- Waiting ---------------------------------------------------------------------------

const noRetry = new AsyncLocalStorage<true>();

/** Run `fn` with no waiting for the database (a probe answers within its own timeout). */
export function withoutDbRetry<T>(fn: () => T): T {
  return noRetry.run(true, fn);
}

/** Is waiting configured for this call at all (a window, and not inside withoutDbRetry)? */
function waitingOn(env: Env = process.env): boolean {
  return !noRetry.getStore() && retryWindowMs(env) > 0;
}

function draining(): boolean {
  return G.__compassDraining === true || G.__compassLifecycle?.draining === true;
}

/**
 * When this request must stop trying (ms since epoch): its own start plus
 * the window, never past the outage's own window, never past the drain
 * deadline less SHUTDOWN_RESERVE_MS (or now, draining with no deadline
 * known). `now` or earlier: no more tries.
 */
export function retryDeadline(startedAt: number, env: Env = process.env, now = Date.now()): number {
  if (noRetry.getStore()) return 0;
  const window = retryWindowMs(env);
  if (window <= 0) return 0;
  let until = startedAt + window;
  const o = G.__compassDbOutage;
  if (o) until = Math.min(until, o.since + window);
  if (draining()) {
    const d = G.__compassDrainDeadline;
    until = Math.min(until, typeof d === "number" ? d - SHUTDOWN_RESERVE_MS : now);
  }
  return until;
}

/** The pause before try number `attempt` (0-based): exponential with jitter, capped. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.min(attempt, 20));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/**
 * Sleep before the next try, in slices so a drain or a closed pool ends the
 * wait at once. False: stop trying (deadline reached, draining past it, or
 * the pool closed).
 */
async function pause(startedAt: number, attempt: number, closed: () => boolean): Promise<boolean> {
  let wake = Date.now() + backoffMs(attempt);
  let counted = attempt > 0;
  for (;;) {
    const now = Date.now();
    const until = retryDeadline(startedAt, process.env, now);
    if (closed() || now >= until) return false;
    wake = Math.min(wake, until);
    if (!counted) {
      countWaiting();
      counted = true;
    }
    if (now >= wake) return true;
    // Not unref'd: a script waiting for the database must not exit mid-wait.
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(SLICE_MS, wake - now)));
  }
}

// --- The pool --------------------------------------------------------------------------

type TrackedClient = PoolClient & {
  __compassBroken?: boolean;
  __compassTracked?: boolean;
  _queryable?: boolean;
  _ending?: boolean;
};

/** A client whose connection pg already knows is gone (no round trip). */
function unusable(c: TrackedClient): boolean {
  return c.__compassBroken === true || c._queryable === false || c._ending === true;
}

/**
 * Watch one client's statements for its whole life: a connection error marks
 * it broken (it is evicted at release); a result ends the outage.
 */
function track(c: TrackedClient): void {
  if (c.__compassTracked) return;
  c.__compassTracked = true;
  const original = c.query;
  const onError = (e: unknown) => {
    if (isConnectionError(e)) {
      c.__compassBroken = true;
      noteDbFailure(e);
    }
  };
  c.query = function (this: unknown, ...args: unknown[]) {
    const last = args[args.length - 1];
    if (typeof last === "function") {
      const cb = last as (err: unknown, res: unknown) => void;
      args[args.length - 1] = (err: unknown, res: unknown) => {
        if (err) onError(err);
        else noteDbSuccess();
        cb(err, res);
      };
      return (original as (...a: unknown[]) => unknown).apply(c, args);
    }
    const out = (original as (...a: unknown[]) => unknown).apply(c, args);
    if (out && typeof (out as Promise<unknown>).then === "function") {
      (out as Promise<unknown>).then(() => noteDbSuccess(), onError);
    }
    return out;
  } as PoolClient["query"];
}

/**
 * lib/db's pool: a pg Pool whose connect() and query() wait through a
 * database restart, by the rules at the top of this file.
 */
export class RetryingPool extends Pool {
  constructor(config?: PoolConfig) {
    super(config);
    // An idle client's connection failed (the server closed it): pg-pool has
    // already removed it. Noted for the outage line; never an uncaught error.
    this.on("error", (e) => {
      if (isConnectionError(e)) noteDbFailure(e);
      else log("error", "db.idle_client_error", { message: `An idle database connection failed: ${connectionErrorLabel(e)}` });
    });
  }

  private closedNow(): boolean {
    return (this as unknown as { ending?: boolean }).ending === true || G.__compassPoolClosed === true;
  }

  /**
   * The error a request that stopped trying fails with: DatabaseUnavailableError
   * when waiting is configured, the driver's own error when it is not (as
   * before 1.21.2).
   */
  private gaveUp(startedAt: number, e: unknown): unknown {
    if (!waitingOn()) return e;
    countRetry("gave_up");
    return new DatabaseUnavailableError(Date.now() - startedAt, e);
  }

  /** A usable client, waiting through an outage while the deadline allows. */
  private async acquire(startedAt: number, attempt: { n: number }): Promise<PoolClient> {
    for (;;) {
      let client: TrackedClient;
      try {
        client = (await super.connect()) as TrackedClient;
      } catch (e) {
        if (!isConnectionError(e)) throw e;
        noteDbFailure(e);
        if (await pause(startedAt, attempt.n++, () => this.closedNow())) continue;
        throw this.gaveUp(startedAt, e);
      }
      if (unusable(client)) {
        // Died while idle and not yet noticed: drop it, take another (no pause: nothing was tried).
        client.release(new Error("database connection is no longer usable"));
        continue;
      }
      track(client);
      // While the caller holds it, a connection error is the caller's (its
      // query fails with it); the client's own 'error' event only marks it.
      const onClientError = (e: unknown) => {
        client.__compassBroken = true;
        if (isConnectionError(e)) noteDbFailure(e);
      };
      client.on("error", onClientError);
      const release = client.release;
      client.release = ((err?: Error | boolean) => {
        client.removeListener("error", onClientError);
        const broken = unusable(client);
        return release(err || (broken ? new Error("database connection broken") : undefined));
      }) as PoolClient["release"];
      return client;
    }
  }

  // pg's overloads (promise and callback forms) are kept: the callback form
  // goes through the same waiting.
  connect(): Promise<PoolClient>;
  connect(callback: (err: Error | undefined, client: PoolClient | undefined, done: (release?: unknown) => void) => void): void;
  connect(callback?: (err: Error | undefined, client: PoolClient | undefined, done: (release?: unknown) => void) => void): Promise<PoolClient> | void {
    const started = Date.now();
    const attempt = { n: 0 };
    const p = this.acquire(started, attempt).then((c) => {
      if (attempt.n > 0) countRetry("recovered");
      return c;
    });
    if (!callback) return p;
    p.then(
      (c) => callback(undefined, c, (err?: unknown) => c.release(err as Error | undefined)),
      (e: Error) => callback(e, undefined, () => {})
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(...args: any[]): any {
    const last = args[args.length - 1];
    const first = args[0] as { submit?: unknown } | undefined;
    // Callback form and submittables (cursors, streams): pg-pool's own query, whose connect is ours.
    if (typeof last === "function" || (first && typeof first.submit === "function")) {
      return (super.query as (...a: unknown[]) => unknown).apply(this, args);
    }
    return this.queryWithRetry(args);
  }

  private async queryWithRetry(args: unknown[]): Promise<unknown> {
    const started = Date.now();
    const attempt = { n: 0 };
    for (;;) {
      const client = await this.acquire(started, attempt);
      let res: unknown;
      try {
        res = await (client.query as (...a: unknown[]) => Promise<unknown>).apply(client, args);
      } catch (e) {
        // As pg-pool's own query: a client whose statement failed is not reused.
        client.release(e as Error);
        if (isNeverSentError(e)) {
          noteDbFailure(e);
          if (await pause(started, attempt.n++, () => this.closedNow())) continue;
          throw this.gaveUp(started, e);
        }
        throw e;
      }
      client.release();
      if (attempt.n > 0) countRetry("recovered");
      return res;
    }
  }
}
