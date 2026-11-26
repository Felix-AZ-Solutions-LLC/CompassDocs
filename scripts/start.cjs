#!/usr/bin/env node
// The CompassDocs server entry (1.21.0): the image's command, `node start.cjs`,
// beside Next's standalone server.js. It starts that server and adds what a
// container platform needs from the process itself:
//
// - Graceful shutdown. On SIGTERM (or SIGINT) /readyz answers 503 at once,
//   the HTTP server stops accepting connections and lets the requests in
//   flight finish (Next's own handler: it also waits for work scheduled
//   with after()), and the app stops its schedulers, ends the desk's live
//   streams and waits for its background jobs (lib/shutdown). Then the
//   database pool closes and the process exits 0. All of it within
//   COMPASSDOCS_SHUTDOWN_TIMEOUT seconds (25; Azure Container Apps kills a
//   replica 30 s after SIGTERM by default): past it, open connections are
//   cut, what was still running is logged, and the exit code is 1.
// - JSON logs from the first line. In cloud mode (COMPASSDOCS_CLOUD=1) or
//   with COMPASSDOCS_LOG_FORMAT=json, Next's own start-up lines are JSON
//   objects too; once the app loads, lib/log takes over (redaction, request
//   ids).
//
// `node server.js` still works, as before 1.21.0, without these.
// COMPASSDOCS_SERVER_JS points at a server.js elsewhere (tests).
//
// Plain CommonJS with no dependencies: it is copied into the image as is.

"use strict";

const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const util = require("node:util");

function cloudMode(env = process.env) {
  const v = (env.COMPASSDOCS_CLOUD || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** lib/cloud jsonLogging, repeated here: this file loads before the app. */
function jsonLogging(env = process.env) {
  const f = (env.COMPASSDOCS_LOG_FORMAT || "").trim().toLowerCase();
  if (f === "json") return true;
  if (f === "text") return false;
  return cloudMode(env);
}

/** Seconds → ms, 25 s by default, between 1 s and 10 minutes. */
function shutdownTimeoutMs(env = process.env) {
  const s = Number(env.COMPASSDOCS_SHUTDOWN_TIMEOUT);
  return Math.round((Number.isFinite(s) && s >= 1 && s <= 600 ? s : 25) * 1000);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** A start-up line as JSON (before the app's logger is loaded): time, level, message, with ANSI colours and any URL password taken out. */
function earlyJsonLine(level, text, now = new Date()) {
  const message = String(text)
    .replace(ANSI, "")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)@/gi, "$1[redacted]@")
    .trim();
  const time = now.toISOString();
  return JSON.stringify({ time, level, message, event: "server", ts: time });
}

/** JSON mode: patch the console now, so Next's banner is JSON too. lib/log replaces this once the app loads. */
function installEarlyJsonConsole() {
  const raw = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };
  globalThis.__compassRawConsole = raw;
  const make = (level, method) => (...args) => {
    const text = util.format(...args);
    if (text.startsWith('{"time":')) return raw[method](text);
    if (!text.replace(ANSI, "").trim()) return; // Next's blank spacer lines
    raw[method](earlyJsonLine(level, text));
  };
  console.log = make("info", "log");
  console.info = make("info", "log");
  console.warn = make("warn", "warn");
  console.error = make("error", "error");
  console.debug = make("debug", "log");
  // Node's own warnings ("(node:1) Warning: …") are written to stderr
  // directly, not through the console: route them through it.
  process.emitWarning = function emitWarning(warning, ...rest) {
    const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type || "Warning";
    const text = warning instanceof Error ? `${warning.name}: ${warning.message}` : `${type}: ${warning}`;
    console.warn(`[node] ${text}`);
  };
}

/** Every HTTP(S) server this process creates (Next's one), to cut connections at the deadline. */
const servers = [];
function captureServers() {
  for (const mod of [http, https]) {
    const create = mod.createServer;
    mod.createServer = function createServer(...args) {
      const server = create.apply(this, args);
      servers.push(server);
      return server;
    };
  }
}

function say(level, event, message, fields = {}) {
  if (jsonLogging()) {
    const raw = globalThis.__compassRawConsole || console;
    const time = new Date().toISOString();
    (level === "error" ? raw.error : level === "warn" ? raw.warn : raw.log)(JSON.stringify({ time, level, message, event, ...fields, ts: time }));
  } else {
    const extras = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(`[${event}] ${message}${extras ? " " + extras : ""}`);
  }
}

function openConnections() {
  return Promise.all(
    servers.map((s) => new Promise((resolve) => s.getConnections((err, n) => resolve(err ? 0 : n))))
  ).then((counts) => counts.reduce((a, b) => a + b, 0));
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Wire the shutdown. Next registers its own SIGTERM/SIGINT handler when it
 * starts (unless NEXT_MANUAL_SIG_HANDLE is set): it closes the server, waits
 * for the requests in flight and its after() work, then calls
 * process.exit(143/130). This runs beside it: while shutting down, that exit
 * is held until the app has drained and the pool is closed, then the
 * process exits with this function's code.
 */
function installShutdown({ exit = process.exit.bind(process), now = Date.now } = {}) {
  const manual = !!process.env.NEXT_MANUAL_SIG_HANDLE;
  let stopping = false;
  let nextExited;
  const nextDone = new Promise((resolve) => (nextExited = resolve));
  const realExit = process.exit.bind(process);
  process.exit = function patchedExit(code) {
    // Next's handler is done (server closed, after() work awaited): hold it.
    if (stopping && (code === 143 || code === 130)) {
      nextExited(code);
      return undefined;
    }
    return realExit(code);
  };

  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    const started = now();
    const timeoutMs = shutdownTimeoutMs();
    const deadlineAt = started + timeoutMs;
    globalThis.__compassDraining = true;
    say("info", "shutdown", `${signal} received: draining for up to ${timeoutMs / 1000} s.`, { signal });

    // Keep-alive connections that finish their request close at once.
    const idle = setInterval(() => servers.forEach((s) => s.closeIdleConnections?.()), 100);
    servers.forEach((s) => s.closeIdleConnections?.());
    // Without Next's handler (NEXT_MANUAL_SIG_HANDLE), close the servers here.
    const serversDone = manual
      ? Promise.all(servers.map((s) => new Promise((resolve) => (s.listening ? s.close(() => resolve()) : resolve()))))
      : nextDone;
    const drain =
      typeof globalThis.__compassAppDrain === "function"
        ? globalThis.__compassAppDrain(deadlineAt).catch((e) => ({ clean: false, pending: [`drain failed: ${e?.message || e}`] }))
        : Promise.resolve({ clean: true, pending: [] });

    const outcome = await Promise.race([
      Promise.all([serversDone, drain]).then(([, d]) => ({ timedOut: false, drain: d })),
      sleep(Math.max(0, deadlineAt - now())).then(() => ({ timedOut: true, drain: null })),
    ]);
    clearInterval(idle);

    const pending = [];
    if (outcome.timedOut) {
      const open = await openConnections();
      if (open) pending.push(`${open} HTTP connection${open === 1 ? "" : "s"}`);
      const d = await Promise.race([drain, sleep(0).then(() => null)]);
      if (!d) pending.push("background jobs");
      else pending.push(...d.pending);
      servers.forEach((s) => s.closeAllConnections?.());
    } else {
      pending.push(...outcome.drain.pending);
    }

    // Last: the pool, now that nothing can use it. A little past the
    // deadline at most, still inside the platform's grace period.
    let closed = { clean: true, pending: [] };
    // The app registers its half from instrumentation; without it (the app
    // never finished starting) there is no pool or job to wait for.
    const appLoaded = typeof globalThis.__compassAppDrain === "function";
    if (typeof globalThis.__compassAppClose === "function") {
      closed = await globalThis.__compassAppClose(Math.max(deadlineAt, now() + 2000)).catch((e) => ({ clean: false, pending: [`close failed: ${e?.message || e}`] }));
    }
    pending.push(...closed.pending);

    const clean = pending.length === 0;
    const ms = now() - started;
    if (clean && appLoaded) say("info", "shutdown", `Stopped cleanly in ${ms} ms: requests finished, background jobs done, database pool closed.`, { duration_ms: ms, clean });
    else if (clean) say("info", "shutdown", `Stopped cleanly in ${ms} ms (the app had not started its background work).`, { duration_ms: ms, clean });
    else say("warn", "shutdown", `Stopped after ${ms} ms with work unfinished: ${pending.join(", ")}.`, { duration_ms: ms, clean, pending });
    exit(clean ? 0 : 1);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  return shutdown;
}

function main() {
  const serverJs = process.env.COMPASSDOCS_SERVER_JS
    ? path.resolve(process.env.COMPASSDOCS_SERVER_JS)
    : path.join(__dirname, "server.js");
  if (jsonLogging()) installEarlyJsonConsole();
  captureServers();
  installShutdown();
  require(serverJs);
}

if (require.main === module) main();

module.exports = { cloudMode, jsonLogging, shutdownTimeoutMs, earlyJsonLine };
