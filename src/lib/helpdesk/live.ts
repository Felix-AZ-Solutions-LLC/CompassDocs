// Helpdesk 1.20.19: live queue updates, the server's side. Server-only.
//
// One LISTEN connection per server process (its own pg Client, outside the
// pool; DATABASE_LISTEN_URL when set, else the pool's DATABASE_URL) hears
// the hd_tickets triggers (lib/helpdesk/live-schema): each notification
// names only the ticket's team and owner before and after. Every open desk
// stream or long poll (GET /api/helpdesk/live) is a subscriber holding its
// agent's scope, the same scope the queue API applies (their teams' tickets
// and the ones they own; everything with agent_all), indexed by team and
// owner so a notification touches only the subscribers it concerns. A
// change outside a scope is never passed on, and nothing a client sees
// (cursor, timing, the catch-up answer) depends on one.
//
// Signals: a change schedules one signal per concerned subscriber, at a
// random moment in [debounce, debounce + gap) and never sooner than the gap
// after its previous one, so a burst folds and a desk full of agents does
// not reload in lockstep. Every signal then takes a token from the
// process's bucket (LIVE_LIMITS.signalsPerSecond): past it, signals queue
// for their turn. A listener reconnect ("everyone reload") goes the same way.
//
// Cursors are time, not counts ("<ms>.<boot>", live-shared): the server's
// clock when it last spoke to the stream. A reconnect asking "did I miss
// anything since?" is answered from the changes kept for ten minutes that
// concern that subscriber, with a 2 s margin for a cursor another process
// handed out (processes behind a load balancer each hear every change, a
// moment apart). Earlier than what this process can vouch for (before its
// listener was up, past the ring) counts as missed: one extra reload.
//
// Liveness: TCP keep-alive on the listener, and every 45 s a NOTIFY sent
// through the pool must come back to it within 5 s. A pooler in transaction
// mode accepts LISTEN and delivers nothing: that fails the check at start,
// live updates stay off (the desk polls) and a warning names
// DATABASE_LISTEN_URL. While the listener is down, requests are refused at
// once (503, the desk falls back) and one timer redials with a back-off.

import "server-only";
import { withDatabasePassword } from "../db-url";
import { databaseAuth, entraClientConfig } from "../db-auth";
import { randomBytes } from "node:crypto";
import { Client, type ClientConfig } from "pg";
import { dbReady, pool } from "../db";
import { logEvent } from "../log";
import { isDraining } from "../shutdown";
import type { Role } from "../types";
import { formatLiveCursor, LIVE_LIMITS, liveConcerns, liveGapMs, parseLiveCursor, parseLivePayload, type LiveChange } from "./live-shared";
import { LIVE_TRIGGERS } from "./live-schema";

export const LIVE_CHANNEL = "hd_queue_live";
const CHECK_CHANNEL = "hd_queue_live_check";

type U = { id: number; role: Role };

interface Entry extends LiveChange {
  at: number;
}

export interface LiveSubscriber {
  userId: number;
  teams: ReadonlySet<number> | "all";
  /** Called with the cursor when a signal is due. */
  signal: (cursor: string) => void;
  /** Called when the stream must end (signed out, off the desk, the licence gone). */
  end: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  lastSent: number;
  /** Look the session and scope up again now (the minute's refresh). */
  rescope: () => Promise<void>;
}

type ListenState = "idle" | "connecting" | "up" | "down";

interface Bus {
  boot: string;
  ring: Entry[];
  /** Changes at or after this are all in the ring (the listener was up, nothing dropped). */
  coveredSince: number;
  /** When the listener last came up (0: never). */
  upSince: number;
  subs: Set<LiveSubscriber>;
  byTeam: Map<number, Set<LiveSubscriber>>;
  byUser: Map<number, Set<LiveSubscriber>>;
  allScope: Set<LiveSubscriber>;
  /** Reserved places: per person and in all (taken before any await, given back on close). */
  reservedTotal: number;
  reservedBy: Map<number, number>;
  state: ListenState;
  client: Client | null;
  connecting: Promise<boolean> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
  checkTimer: ReturnType<typeof setInterval> | null;
  checks: Map<string, () => void>;
  /** The token bucket's theoretical arrival time (GCRA). */
  tat: number;
  /** Tests: a stand-in for the agent's scope and desk standing. */
  scopeOverride: ((user: U) => Promise<{ teams: number[] | "all"; agent: boolean }>) | null;
}

const g = globalThis as unknown as { __hdLiveBus2?: Bus };

function bus(): Bus {
  if (!g.__hdLiveBus2) {
    g.__hdLiveBus2 = {
      boot: randomBytes(4).toString("hex"),
      ring: [],
      coveredSince: Number.POSITIVE_INFINITY,
      upSince: 0,
      subs: new Set(),
      byTeam: new Map(),
      byUser: new Map(),
      allScope: new Set(),
      reservedTotal: 0,
      reservedBy: new Map(),
      state: "idle",
      client: null,
      connecting: null,
      reconnectTimer: null,
      backoffMs: LIVE_LIMITS.reconnectMinMs,
      checkTimer: null,
      checks: new Map(),
      tat: 0,
      scopeOverride: null,
    };
  }
  return g.__hdLiveBus2;
}

/** The cursor for "now", from this process. */
export function liveCursor(): string {
  return formatLiveCursor(Date.now(), bus().boot);
}

/** Open streams and long polls on this process. */
export function liveStreamCount(): number {
  return bus().subs.size;
}

// --- Places -------------------------------------------------------------------------

/**
 * Take a place for one stream or long poll, synchronously (no await between
 * the check and the count, so parallel connects can't pass the cap).
 * "user" or "process" when full; otherwise a release that gives it back once.
 */
export function reserveLive(userId: number): (() => void) | "user" | "process" {
  const b = bus();
  if (b.reservedTotal >= LIVE_LIMITS.perProcess) return "process";
  const mine = b.reservedBy.get(userId) ?? 0;
  if (mine >= LIVE_LIMITS.perUser) return "user";
  b.reservedTotal++;
  b.reservedBy.set(userId, mine + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    b.reservedTotal--;
    const n = (b.reservedBy.get(userId) ?? 1) - 1;
    if (n > 0) b.reservedBy.set(userId, n);
    else b.reservedBy.delete(userId);
  };
}

// --- Changes and signals ----------------------------------------------------------------

function prune(b: Bus, now: number): void {
  const horizon = now - LIVE_LIMITS.ringMs;
  let drop = 0;
  while (drop < b.ring.length && b.ring[drop].at < horizon) drop++;
  if (b.ring.length - drop > LIVE_LIMITS.ringMax) drop = b.ring.length - LIVE_LIMITS.ringMax;
  if (drop > 0) {
    b.coveredSince = Math.max(b.coveredSince, b.ring[drop - 1].at + 1);
    b.ring.splice(0, drop);
  }
  b.coveredSince = Math.max(b.coveredSince, horizon);
}

function concerned(b: Bus, change: LiveChange): Set<LiveSubscriber> {
  if (change.all) return new Set(b.subs);
  const out = new Set<LiveSubscriber>(b.allScope);
  for (const t of change.teams) for (const s of b.byTeam.get(t) ?? []) out.add(s);
  for (const u of change.users) for (const s of b.byUser.get(u) ?? []) out.add(s);
  return out;
}

/** Record a change and schedule a signal for every subscriber it concerns. */
export function publishLiveChange(change: LiveChange): void {
  const b = bus();
  const now = Date.now();
  b.ring.push({ ...change, at: now });
  prune(b, now);
  for (const s of concerned(b, change)) schedule(s);
}

/** ms until the next signal may go (and that slot is taken): a token bucket as GCRA. */
function takeToken(now: number): number {
  const b = bus();
  const interval = 1000 / LIVE_LIMITS.signalsPerSecond;
  const tolerance = interval * (LIVE_LIMITS.signalsPerSecond - 1);
  const tat = Math.max(b.tat, now);
  const wait = Math.max(0, tat - tolerance - now);
  b.tat = tat + interval;
  return wait;
}

function schedule(s: LiveSubscriber): void {
  if (s.timer) return;
  const now = Date.now();
  const gap = liveGapMs(bus().subs.size);
  const due = Math.max(now + LIVE_LIMITS.debounceMs + Math.random() * gap, s.lastSent + gap);
  s.timer = setTimeout(() => {
    const wait = takeToken(Date.now());
    const send = () => {
      s.timer = null;
      s.lastSent = Date.now();
      try {
        s.signal(liveCursor());
      } catch {
        /* a stream that has gone away is removed by its own cleanup */
      }
    };
    if (wait > 0) s.timer = setTimeout(send, wait);
    else send();
  }, due - now);
}

/** Schedule one signal for `sub` as a change would (the catch-up after a reconnect). */
export function scheduleLiveSignal(sub: LiveSubscriber): void {
  schedule(sub);
}

/**
 * Did a change this subscriber cares about happen after `cursor`? A cursor
 * this process can't vouch for (malformed, earlier than its listener or its
 * ring) says yes. Only changes in the subscriber's scope, and time, decide.
 */
export function changedSince(raw: string | null | undefined, scope: { teams: ReadonlySet<number> | "all"; userId: number }): boolean {
  if (!raw) return false;
  const b = bus();
  const c = parseLiveCursor(raw);
  if (!c) return true;
  prune(b, Date.now());
  const from = c.boot === b.boot ? c.ms : c.ms - LIVE_LIMITS.skewMs;
  if (from < b.coveredSince) return true;
  for (let i = b.ring.length - 1; i >= 0 && b.ring[i].at > from; i--) if (liveConcerns(b.ring[i], scope)) return true;
  return false;
}

// --- The LISTEN connection -------------------------------------------------------

function clientConfig(): ClientConfig {
  // The pool's own settings (connection string, SSL, UTC), so the listener
  // reaches the same database the same way; DATABASE_LISTEN_URL replaces the
  // address (a direct or session-mode connection where DATABASE_URL is a
  // transaction-mode pooler).
  const po = (pool() as unknown as { options?: Record<string, unknown> }).options ?? {};
  const o = { ...po };
  // pg-pool keeps a password it was given as a hidden (non-enumerable) option, which a spread
  // leaves behind: the pool's separate DATABASE_PASSWORD (key=value DSN), or the Entra token function.
  if ("password" in po) o.password = po.password;
  for (const k of ["max", "min", "idleTimeoutMillis", "maxUses", "allowExitOnIdle", "Client", "Promise", "log", "maxLifetimeSeconds"]) delete o[k];
  const listenUrl = process.env.DATABASE_LISTEN_URL;
  if (listenUrl && databaseAuth() === "entra") {
    // 1.21.3 (lib/db-auth): the listen address taken apart like the pool's, with
    // the managed identity's token as its password and verified SSL (a
    // connection string here would replace the token with its empty password).
    delete o.connectionString;
    Object.assign(o, entraClientConfig(listenUrl));
  } else if (listenUrl) {
    // 1.21.0: DATABASE_PASSWORD applies to it too (lib/db-url).
    o.connectionString = withDatabasePassword(listenUrl);
  }
  return { ...(o as ClientConfig), keepAlive: true, keepAliveInitialDelayMillis: 10_000 };
}

/** Tests (1.21.3): the LISTEN connection's driver settings. */
export const listenClientConfigForTests = clientConfig;

/** Live updates can be offered right now (the listener is up and proven). */
export function liveAvailable(): boolean {
  return bus().state === "up";
}

function goDown(b: Bus, why: string): void {
  const c = b.client;
  b.client = null;
  const wasUp = b.state === "up";
  b.state = "down";
  b.coveredSince = Number.POSITIVE_INFINITY;
  if (b.checkTimer) clearInterval(b.checkTimer);
  b.checkTimer = null;
  for (const done of b.checks.values()) done();
  b.checks.clear();
  if (wasUp) logEvent("warn", "helpdesk.live_listener_lost", { reason: why });
  c?.removeAllListeners("end");
  c?.end().catch(() => {});
  scheduleReconnect(b);
}

/** One timer, with a back-off; nothing else dials while the listener is down. */
function scheduleReconnect(b: Bus): void {
  if (b.reconnectTimer || isDraining()) return; // 1.21.0: never redial while shutting down
  const wait = b.backoffMs * (0.75 + Math.random() * 0.5);
  b.backoffMs = Math.min(LIVE_LIMITS.reconnectMaxMs, b.backoffMs * 2);
  b.reconnectTimer = setTimeout(() => {
    b.reconnectTimer = null;
    void connect(b);
  }, wait);
  b.reconnectTimer.unref?.();
}

/** A NOTIFY through the pool must come back to the listener; true when it did. Logs a notify queue past half full. */
async function selfCheck(b: Bus, client: Client): Promise<boolean> {
  const nonce = randomBytes(6).toString("hex");
  let heard = false;
  const back = new Promise<void>((resolve) => b.checks.set(nonce, () => ((heard = true), resolve())));
  try {
    const r = await pool().query<{ usage: number }>("SELECT pg_notify($1, $2), pg_notification_queue_usage() AS usage", [CHECK_CHANNEL, nonce]);
    const usage = Number(r.rows[0]?.usage ?? 0);
    if (usage > 0.5) logEvent("warn", "helpdesk.live_notify_queue_high", { usage: Math.round(usage * 100) / 100 });
    await Promise.race([back, new Promise((r2) => setTimeout(r2, LIVE_LIMITS.selfCheckTimeoutMs).unref?.())]);
  } catch {
    /* the pool is down: not heard */
  } finally {
    b.checks.delete(nonce);
  }
  return heard && b.client === client;
}

async function connect(b: Bus): Promise<boolean> {
  if (isDraining()) return false; // 1.21.0: stopLive closed the listener for good
  if (b.state === "up") return true;
  if (b.connecting) return b.connecting;
  b.state = "connecting";
  b.connecting = (async () => {
    await dbReady();
    const client = new Client(clientConfig());
    client.on("error", (e) => b.client === client && goDown(b, e.message));
    client.on("end", () => b.client === client && goDown(b, "ended"));
    client.on("notification", (n) => {
      if (n.channel === CHECK_CHANNEL) {
        b.checks.get(n.payload ?? "")?.();
        return;
      }
      if (n.channel !== LIVE_CHANNEL || b.client !== client) return;
      const change = parseLivePayload(n.payload ?? "");
      if (change) publishLiveChange(change);
    });
    try {
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5_000).unref?.());
      await Promise.race([
        (async () => {
          await client.connect();
          await client.query(`LISTEN ${LIVE_CHANNEL}; LISTEN ${CHECK_CHANNEL}`);
        })(),
        timeout,
      ]);
      b.client = client;
      if (!(await selfCheck(b, client))) {
        logEvent("warn", "helpdesk.live_unavailable", {
          reason:
            "The database accepted LISTEN but delivered no notification within 5 s (a pooler in transaction mode?). Live queue updates are off and the desk polls. Set DATABASE_LISTEN_URL to a direct or session-mode connection.",
        });
        b.client = null;
        throw new Error("self-check failed");
      }
      const missing = await client
        .query<{ n: number }>("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = to_regclass('hd_tickets') AND tgname = ANY($1)", [LIVE_TRIGGERS])
        .then((r) => LIVE_TRIGGERS.length - Number(r.rows[0]?.n ?? 0))
        .catch(() => 0);
      if (missing > 0) logEvent("warn", "helpdesk.live_triggers_missing", { missing, note: "hd_tickets was busy at start; the next start creates them. Until then the desk refreshes every minute." });
      b.state = "up";
      b.backoffMs = LIVE_LIMITS.reconnectMinMs;
      b.coveredSince = Date.now();
      b.upSince = b.coveredSince;
      b.checkTimer = setInterval(() => {
        void selfCheck(b, client).then((ok) => {
          if (!ok && b.client === client) goDown(b, "self-check: no notification came back");
        });
      }, LIVE_LIMITS.selfCheckMs);
      b.checkTimer.unref?.();
      // Whatever happened while nobody listened: everyone reloads, spread over the gap and the bucket.
      if (b.subs.size) publishLiveChange({ teams: [], users: [], all: true });
      return true;
    } catch (e) {
      if (b.client === client) b.client = null;
      client.removeAllListeners("end");
      client.end().catch(() => {});
      if ((e as Error).message !== "self-check failed") logEvent("warn", "helpdesk.live_listen_failed", { error: e instanceof Error ? e.message : String(e) });
      b.state = "down";
      scheduleReconnect(b);
      return false;
    } finally {
      b.connecting = null;
    }
  })();
  return b.connecting;
}

/**
 * Whether live updates can be served now. The first call starts the
 * listener and waits for it (its self-check included, ~5 s at most); while
 * it is down the answer is false at once and only the reconnect timer dials.
 */
export function ensureListening(): Promise<boolean> {
  // 1.21.0 (review of #334): shutting down, the listener stays closed
  // (stopLive), and no stream may open to hold the server past its drain.
  if (isDraining()) return Promise.resolve(false);
  const b = bus();
  if (b.state === "up") return Promise.resolve(true);
  if (b.state === "connecting" && b.connecting) return b.connecting;
  if (b.state === "idle") return connect(b);
  return Promise.resolve(false);
}

// --- Subscribers -------------------------------------------------------------------

async function scopeOf(user: U): Promise<{ teams: number[] | "all"; agent: boolean }> {
  const b = bus();
  if (b.scopeOverride) return b.scopeOverride(user);
  const { agentTeamIds, helpdeskLicensed, isAgent } = await import("./access");
  const [licensed, agent] = await Promise.all([helpdeskLicensed(), isAgent(user)]);
  if (!licensed || !agent) return { teams: [], agent: false };
  return { teams: await agentTeamIds(user), agent: true };
}

const asSet = (teams: number[] | "all"): ReadonlySet<number> | "all" => (teams === "all" ? "all" : new Set(teams));

function index(b: Bus, s: LiveSubscriber): void {
  if (s.teams === "all") b.allScope.add(s);
  else for (const t of s.teams) (b.byTeam.get(t) ?? b.byTeam.set(t, new Set()).get(t)!).add(s);
  (b.byUser.get(s.userId) ?? b.byUser.set(s.userId, new Set()).get(s.userId)!).add(s);
}

function unindex(b: Bus, s: LiveSubscriber): void {
  b.allScope.delete(s);
  if (s.teams !== "all")
    for (const t of s.teams) {
      const set = b.byTeam.get(t);
      set?.delete(s);
      if (set && !set.size) b.byTeam.delete(t);
    }
  const mine = b.byUser.get(s.userId);
  mine?.delete(s);
  if (mine && !mine.size) b.byUser.delete(s.userId);
}

/**
 * The browser session behind a stream is still good for the desk: the
 * session row (unexpired, its account active), and no Duo approval owed for
 * the desk. Asked at every scope refresh; never slides the session's expiry.
 */
export async function deskSessionValid(token: string | null, userId: number): Promise<boolean> {
  if (!token) return false;
  const { getSessionUser, getAllSettings } = await import("../db");
  const s = await getSessionUser(token);
  if (!s || s.id !== userId) return false;
  const settings = await getAllSettings();
  const { duoSwitchedOn } = await import("../duo-policy");
  if (!duoSwitchedOn(settings)) return true;
  const { duoSessionStanding } = await import("../duo-gate");
  return !(await duoSessionStanding(settings, s, token)).verdict.desk;
}

/**
 * Subscribe a stream for `user` (already through helpdeskGate("agent"), its
 * place reserved). The scope is looked up now and every minute, with the
 * session (`valid`): a refresh that finds the session gone, the person off
 * the desk or the licence gone ends the stream. `release` gives the place
 * back when the subscription closes, or at once if subscribing fails.
 */
export async function subscribeLive(
  user: U,
  handlers: { signal: (cursor: string) => void; end: () => void },
  opts: { release?: () => void; valid?: () => Promise<boolean> } = {}
): Promise<{ sub: LiveSubscriber; close: () => void }> {
  const b = bus();
  let scope: { teams: number[] | "all"; agent: boolean };
  try {
    scope = await scopeOf(user);
  } catch (e) {
    opts.release?.();
    throw e;
  }
  let closed = false;
  const rescope = async () => {
    try {
      const [ok, s] = await Promise.all([opts.valid ? opts.valid() : Promise.resolve(true), scopeOf(user)]);
      if (closed) return;
      if (!ok || !s.agent) {
        close();
        handlers.end();
        return;
      }
      unindex(b, sub);
      sub.teams = asSet(s.teams);
      index(b, sub);
    } catch {
      /* keep the last scope; the stream ends on its own within six minutes */
    }
  };
  const sub: LiveSubscriber = { userId: user.id, teams: asSet(scope.teams), signal: handlers.signal, end: handlers.end, timer: null, lastSent: 0, rescope };
  b.subs.add(sub);
  index(b, sub);
  // Staggered, so streams opened together don't all look themselves up together.
  let refresh: ReturnType<typeof setInterval> | null = null;
  const first = setTimeout(() => {
    void rescope();
    refresh = setInterval(() => void rescope(), LIVE_LIMITS.scopeRefreshMs);
    refresh.unref?.();
  }, LIVE_LIMITS.scopeRefreshMs * (0.5 + Math.random() * 0.5));
  first.unref?.();
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(first);
    if (refresh) clearInterval(refresh);
    if (sub.timer) clearTimeout(sub.timer);
    sub.timer = null;
    b.subs.delete(sub);
    unindex(b, sub);
    opts.release?.();
  };
  if (!scope.agent) {
    close();
    handlers.end();
  }
  return { sub, close };
}

// --- Tests -------------------------------------------------------------------------

/** Tests: replace the scope lookup (null restores it). */
export function setLiveScopeForTests(fn: Bus["scopeOverride"]): void {
  bus().scopeOverride = fn;
}

/** Tests: every stream looks its session and scope up now, as the minute's refresh does. */
export async function rescopeLiveForTests(): Promise<void> {
  await Promise.all([...bus().subs].map((s) => s.rescope()));
}

/** Tests: drop the LISTEN connection as if the database went away. */
export async function dropLiveListenerForTests(): Promise<void> {
  const c = bus().client;
  if (c) await c.end().catch(() => {});
}

/** Tests: run the liveness check now; false (and the listener goes down) when the NOTIFY did not come back. */
export async function selfCheckLiveForTests(): Promise<boolean> {
  const b = bus();
  const c = b.client;
  if (!c || b.state !== "up") return false;
  const ok = await selfCheck(b, c);
  if (!ok && b.client === c) goDown(b, "self-check: no notification came back");
  return ok;
}

/** Tests: the listener's state and the places reserved. */
export function liveStateForTests(): { state: ListenState; reserved: number; reconnecting: boolean; indexedTeams: number; upSince: number } {
  const b = bus();
  return { state: b.state, reserved: b.reservedTotal, reconnecting: !!b.reconnectTimer, indexedTeams: b.byTeam.size, upSince: b.upSince };
}

/** Tests: the changes this process remembers (to say which one made an answer "changed"). */
export function liveRingForTests(): readonly (LiveChange & { at: number })[] {
  return bus().ring;
}

/**
 * 1.21.0 (lib/shutdown): the process is stopping. Every live stream and long
 * poll ends now (the desk reconnects, to another replica if there is one)
 * and the LISTEN connection closes.
 */
export async function stopLive(): Promise<void> {
  const b = bus();
  for (const s of [...b.subs]) {
    try {
      s.end();
    } catch {
      /* already gone */
    }
  }
  await stopLiveForTests();
}

/** Tests: end the LISTEN connection for good (the test process can exit). */
export async function stopLiveForTests(): Promise<void> {
  const b = bus();
  const c = b.client;
  b.client = null;
  b.state = "idle";
  if (b.reconnectTimer) clearTimeout(b.reconnectTimer);
  b.reconnectTimer = null;
  if (b.checkTimer) clearInterval(b.checkTimer);
  b.checkTimer = null;
  for (const s of b.subs) if (s.timer) clearTimeout(s.timer);
  b.subs.clear();
  b.byTeam.clear();
  b.byUser.clear();
  b.allScope.clear();
  if (c) {
    c.removeAllListeners("end");
    await c.end().catch(() => {});
  }
}
