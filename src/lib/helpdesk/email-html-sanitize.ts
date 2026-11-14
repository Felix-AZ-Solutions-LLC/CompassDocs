// Helpdesk 1.20.8: an inbound email's original HTML made safe to show
// ("View original", lib/helpdesk/email-html). Sanitised on output, every
// time, on the server: DOMPurify on jsdom, in a worker thread
// (email-html-worker.cjs, which says what comes out), never on the server's
// main thread. The route that serves the result adds the second line of
// defence (a sandboxed frame with no scripts and its own origin, and a
// Content-Security-Policy that loads nothing but pictures).
//
// Bounded twice (security review, 1.20.8):
//   1. Before anything parses it, the email is measured in one linear pass
//      (lib/helpdesk/html-scan): more than 60,000 elements, nesting deeper
//      than 400, more than 200 attributes on a tag or 200,000 in all, or
//      more than 2 MB, is refused ("too_complex") without starting the
//      worker.
//   2. The worker sanitises one email at a time and gets 3 seconds for it.
//      Past that it is stopped (terminated, so the work really ends) and the
//      email is refused ("timeout"); the next email gets a fresh worker. At
//      most 8 emails wait their turn; more is "busy".
//
// The worker file is found by its path from the working directory, which is
// the project in development and in tests, and the standalone folder in
// production (Next's standalone server starts there; next.config.js ships
// the file with outputFileTracingIncludes). Server-only.

import "server-only";
import { existsSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { logEvent } from "../log";
import { EMAIL_HTML_LIMITS } from "./email-html-shared";
import { scanHtml, type HtmlShape } from "./html-scan";

export interface SanitizeOptions {
  /** Show https pictures (Show images). Default false. */
  remoteImages?: boolean;
  /** Content-ID (normalised by cidKey) → a data: URI of the picture. */
  cids?: Map<string, string>;
}

export type SanitizeResult =
  | { ok: true; html: string; remoteImages: number; insecureImages: number; missingCids: number }
  | { ok: false; reason: "too_complex" | "timeout" | "busy" | "failed" };

/** A Content-ID as the HTML and the attachment name it: angle brackets, URL escapes and case undone. */
export function cidKey(raw: string): string {
  let s = String(raw ?? "").trim().replace(/^cid:/i, "");
  try {
    s = decodeURIComponent(s);
  } catch {
    /* kept as written */
  }
  return s.replace(/^</, "").replace(/>$/, "").trim().toLowerCase().slice(0, 500);
}

/** The email's shape, measured before anything parses it (lib/helpdesk/html-scan, with the View original limits). */
export function htmlComplexity(html: string): HtmlShape {
  return scanHtml(html, { elements: EMAIL_HTML_LIMITS.tags, depth: EMAIL_HTML_LIMITS.depth, tagAttrs: EMAIL_HTML_LIMITS.tagAttrs, attrs: EMAIL_HTML_LIMITS.attrs });
}

// --- The worker -------------------------------------------------------------------------

export const SANITIZE_TIMEOUT_MS = 3000;
const QUEUE_MAX = 8;

/** Where the worker file is: the project in development and tests, the standalone folder in production. */
export function workerFile(): string {
  return path.join(process.cwd(), "src", "lib", "helpdesk", "email-html-worker.cjs");
}

interface Job {
  id: number;
  html: string;
  opts: { remoteImages: boolean; cids: [string, string][] };
  resolve: (r: SanitizeResult) => void;
}

let worker: Worker | null = null;
let current: { job: Job; timer: NodeJS.Timeout } | null = null;
const queue: Job[] = [];
let nextId = 1;
let timeoutMs = SANITIZE_TIMEOUT_MS;

/** Tests: a shorter (or longer) time limit; null restores 3 seconds. */
export function setSanitizeTimeoutForTests(ms: number | null): void {
  timeoutMs = ms ?? SANITIZE_TIMEOUT_MS;
}

function finish(result: SanitizeResult): void {
  if (!current) return;
  clearTimeout(current.timer);
  const { job } = current;
  current = null;
  job.resolve(result);
  pump();
}

function dropWorker(): void {
  const w = worker;
  worker = null;
  if (w) void w.terminate().catch(() => {});
}

function startWorker(): Worker | null {
  const file = workerFile();
  if (!existsSync(file)) {
    logEvent("error", "helpdesk.email_html_worker_missing", { file });
    return null;
  }
  const w = new Worker(file, { workerData: { role: "email-html" }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
  w.on("message", (m: { id: number; result: SanitizeResult }) => {
    if (current && worker === w && m.id === current.job.id) finish(m.result);
  });
  const lost = () => {
    if (worker !== w) return;
    worker = null;
    if (current) finish({ ok: false, reason: "failed" });
  };
  w.on("error", (e) => {
    logEvent("error", "helpdesk.email_html_worker_failed", { error: e instanceof Error ? e.message : String(e) });
    lost();
  });
  w.on("exit", lost);
  // An idle worker never keeps the process alive (after the listeners, which would ref it again).
  w.unref();
  return w;
}

/** Tests: stop the worker (a new one starts with the next email). */
export async function stopSanitizeWorkerForTests(): Promise<void> {
  const w = worker;
  worker = null;
  if (w) await w.terminate().catch(() => {});
}

function pump(): void {
  if (current || !queue.length) return;
  const job = queue.shift()!;
  if (!worker) worker = startWorker();
  if (!worker) {
    job.resolve({ ok: false, reason: "failed" });
    pump();
    return;
  }
  const timer = setTimeout(() => {
    // Past its time: the worker is stopped (its work really ends) and the next email gets a fresh one.
    logEvent("warn", "helpdesk.email_html_timeout", { ms: timeoutMs });
    dropWorker();
    finish({ ok: false, reason: "timeout" });
  }, timeoutMs);
  current = { job, timer };
  worker.postMessage({ id: job.id, html: job.html, opts: job.opts });
}

/**
 * The email as a whole HTML document, safe to serve under the original
 * route's policy, sanitised in the worker. Refuses an email too large or too
 * complex to read in bounded time ("too_complex"), one that takes longer
 * than 3 seconds ("timeout"), and answers "busy" when 8 emails already wait.
 */
export function sanitizeEmailHtml(html: string, opts: SanitizeOptions = {}): Promise<SanitizeResult> {
  const input = String(html ?? "");
  if (input.length > EMAIL_HTML_LIMITS.storeBytes * 2 || htmlComplexity(input).over) return Promise.resolve({ ok: false, reason: "too_complex" });
  if (queue.length >= QUEUE_MAX) return Promise.resolve({ ok: false, reason: "busy" });
  return new Promise<SanitizeResult>((resolve) => {
    queue.push({ id: nextId++, html: input, opts: { remoteImages: opts.remoteImages === true, cids: [...(opts.cids ?? new Map<string, string>()).entries()] }, resolve });
    pump();
  });
}

/**
 * Never called. The worker requires jsdom and dompurify by name; naming them
 * here lets the production build's file tracing ship them to the standalone
 * folder (both are server-external packages, see next.config.js).
 */
export async function workerPackagesForTracing(): Promise<void> {
  await import("jsdom");
  await import("dompurify");
}
