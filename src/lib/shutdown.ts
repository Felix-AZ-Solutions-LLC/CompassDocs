// Graceful shutdown (1.21.0), for both modes.
//
// A container platform (Azure Container Apps, Docker, Kubernetes) stops a
// replica with SIGTERM and kills it after a grace period (Container Apps:
// 30 s by default). On SIGTERM the server entry (start.cjs, the image's
// command) does, within COMPASSDOCS_SHUTDOWN_TIMEOUT seconds (25 by
// default):
//
//   1. drain: /readyz answers 503 so no new traffic is routed here, the HTTP
//      server stops accepting connections, and the app stops its schedulers
//      (no new background work), ends its live streams (the desk's live
//      queue reconnects to another replica) and waits for the background
//      jobs already running — while the requests in flight finish;
//   2. flush (1.21.1): telemetry, when it is on (lib/telemetry), sends what
//      it holds, for at most FLUSH_MAX_MS and never past the deadline; a
//      flush that doesn't finish is given up on, logged, and never makes the
//      shutdown unclean;
//   3. close: the database pool (and the LISTEN connection) is closed once
//      no request or job can use it;
//   4. exit 0. A shutdown the deadline cut short exits 1 and logs what was
//      still running.
//
// The state lives on globalThis because the server entry, instrumentation
// and the route bundles are separate module graphs in one process (like
// lib/db's pool). This module holds the app's half; start.cjs holds the
// HTTP server's half and calls appDrain / appClose.
//
// Server-only.

import "server-only";
import { cloudStartupProblems } from "./cloud";
import { telemetryHooks } from "./telemetry-hooks";

export interface Lifecycle {
  /** SIGTERM received: refuse new work, /readyz says so. */
  draining: boolean;
  /** Background jobs running now, by name. */
  jobs: Map<Promise<unknown>, string>;
  /** Scheduler timers, cleared on drain. */
  timers: Set<ReturnType<typeof setInterval>>;
  /** Run when draining starts (end live streams). */
  onDrain: { name: string; fn: () => void | Promise<void> }[];
  /** Run after the drain, before the close hooks, bounded (flush telemetry). */
  onFlush: { name: string; fn: () => void | Promise<void> }[];
  /** Run after the drain, last (close the pool). */
  onClose: { name: string; fn: () => void | Promise<void> }[];
}

const g = globalThis as unknown as {
  __compassLifecycle?: Lifecycle;
  /** Set by start.cjs before draining starts, so /readyz turns 503 at once. */
  __compassDraining?: boolean;
  /** Called by start.cjs: the app's half of the drain. */
  __compassAppDrain?: (deadlineAt: number) => Promise<DrainResult>;
  /** Called by start.cjs once the server and the jobs are done. */
  __compassAppClose?: (deadlineAt: number) => Promise<DrainResult>;
};

export function lifecycle(): Lifecycle {
  if (!g.__compassLifecycle) {
    g.__compassLifecycle = { draining: false, jobs: new Map(), timers: new Set(), onDrain: [], onFlush: [], onClose: [] };
  }
  return g.__compassLifecycle;
}

/** Is the process shutting down? /readyz answers 503 and no new background job starts. */
export function isDraining(): boolean {
  return lifecycle().draining || g.__compassDraining === true;
}

/** Run `fn` every `ms` until the drain (a scheduler). */
export function every(ms: number, fn: () => unknown): void {
  const t = setInterval(() => void fn(), ms);
  lifecycle().timers.add(t);
}

/** Run `fn` once after `ms`, unless the drain came first. */
export function after(ms: number, fn: () => unknown): void {
  const l = lifecycle();
  const t = setTimeout(() => {
    l.timers.delete(t);
    void fn();
  }, ms);
  l.timers.add(t);
}

/**
 * Run a background job, tracked so the drain waits for it. Not started once
 * draining (resolves undefined). Never rejects: a failure is logged with
 * the job's name, the way the schedulers always have. With telemetry on
 * (1.21.1), each run is one span named "job <name>" and counts as a run (and
 * a failure, when it throws).
 */
export async function runJob<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (isDraining()) return undefined;
  const l = lifecycle();
  const p = (async () => {
    try {
      const t = telemetryHooks();
      return await (t ? t.job(name, fn) : fn());
    } catch (e) {
      console.error(`[${name}] error:`, e);
      return undefined;
    }
  })();
  l.jobs.set(p, name);
  try {
    return await p;
  } finally {
    l.jobs.delete(p);
  }
}

/** Register work for the start of the drain (end live streams). */
export function onDrain(name: string, fn: () => void | Promise<void>): void {
  const l = lifecycle();
  if (!l.onDrain.some((h) => h.name === name)) l.onDrain.push({ name, fn });
}

/**
 * Register a flush for after the drain and before the close hooks
 * (telemetry, 1.21.1). It gets at most FLUSH_MAX_MS, ends early enough to
 * leave the close hooks CLOSE_RESERVE_MS, and is never counted as unfinished
 * work: a flush that hangs is given up on and logged.
 */
export function onFlush(name: string, fn: () => void | Promise<void>): void {
  const l = lifecycle();
  if (!l.onFlush.some((h) => h.name === name)) l.onFlush.push({ name, fn });
}

/** Register work for the very end (close the database pool). */
export function onClose(name: string, fn: () => void | Promise<void>): void {
  const l = lifecycle();
  if (!l.onClose.some((h) => h.name === name)) l.onClose.push({ name, fn });
}

export interface DrainResult {
  /** Everything finished before the deadline. */
  clean: boolean;
  /** What was still running when the deadline came. */
  pending: string[];
}

function until(deadlineAt: number): Promise<"deadline"> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve("deadline"), Math.max(0, deadlineAt - Date.now()));
    t.unref?.();
  });
}

async function runHooks(hooks: Lifecycle["onDrain"], deadlineAt: number): Promise<string[]> {
  const pending = new Set(hooks.map((h) => h.name));
  const all = Promise.all(
    hooks.map(async (h) => {
      try {
        await h.fn();
      } catch (e) {
        console.error(`[shutdown] ${h.name}:`, e);
      }
      pending.delete(h.name);
    })
  );
  await Promise.race([all, until(deadlineAt)]);
  return [...pending];
}

/**
 * The app's half of the drain: stop the schedulers, run the drain hooks and
 * wait for the background jobs running now, until `deadlineAt`.
 */
export async function appDrain(deadlineAt: number): Promise<DrainResult> {
  const l = lifecycle();
  l.draining = true;
  for (const t of l.timers) clearInterval(t);
  l.timers.clear();
  const hookPending = await runHooks(l.onDrain, deadlineAt);
  const jobs = [...l.jobs.keys()];
  if (jobs.length) await Promise.race([Promise.allSettled(jobs), until(deadlineAt)]);
  const pending = [...hookPending, ...[...l.jobs.values()]];
  return { clean: pending.length === 0, pending };
}

/** The longest a flush may take, and the time it always leaves the close hooks. */
export const FLUSH_MAX_MS = 5_000;
export const CLOSE_RESERVE_MS = 1_000;

/** When the flush must be done by: FLUSH_MAX_MS from now at most, CLOSE_RESERVE_MS before the deadline, never in the past. */
export function flushDeadline(deadlineAt: number, now = Date.now()): number {
  return Math.min(now + FLUSH_MAX_MS, Math.max(now + 250, deadlineAt - CLOSE_RESERVE_MS));
}

/**
 * The last steps: the flush hooks (telemetry), bounded by flushDeadline, then
 * the close hooks (the database pool), until `deadlineAt`. A flush cut short
 * is logged and never pending.
 */
export async function appClose(deadlineAt: number): Promise<DrainResult> {
  const l = lifecycle();
  if (l.onFlush.length) {
    const late = await runHooks(l.onFlush, flushDeadline(deadlineAt));
    for (const name of late) console.warn(`[shutdown] ${name}: not flushed in time, exiting without it.`);
  }
  const pending = await runHooks(l.onClose, deadlineAt);
  return { clean: pending.length === 0, pending };
}

/** Called once by instrumentation: hands start.cjs the app's half. */
export function exposeLifecycle(): void {
  g.__compassAppDrain = appDrain;
  g.__compassAppClose = appClose;
}

/**
 * Cloud mode's start-up check (instrumentation): warnings are logged; a
 * missing or unusable COMPASSDOCS_SECRET_KEY, DATABASE_URL or
 * COMPASSDOCS_BASE_URL is one clear error line each, and the process exits 1 before it serves anything. The
 * platform shows the line beside the failed revision.
 */
export async function checkCloudStartup(
  log: (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => void,
  exit: (code: number) => void = (code) => process.exit(code)
): Promise<boolean> {
  const { fatal, warnings } = cloudStartupProblems();
  for (const w of warnings) log("warn", "cloud.config", { message: w });
  if (fatal.length) {
    for (const f of fatal) log("error", "cloud.refused_to_start", { message: `Cloud mode (COMPASSDOCS_CLOUD=1) can't start: ${f}` });
    // Give the lines a moment to reach the platform's log stream.
    await new Promise((r) => setTimeout(r, 200));
    exit(1);
    return false;
  }
  log("info", "cloud.mode", { message: "Running in cloud mode: hosting, updates and backups are managed by CompassDocs Cloud." });
  return true;
}

/** Tests: forget every timer, job and hook. */
export function resetLifecycleForTests(): void {
  const l = lifecycle();
  for (const t of l.timers) clearInterval(t);
  g.__compassLifecycle = undefined;
  g.__compassDraining = undefined;
}
