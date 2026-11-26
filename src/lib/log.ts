// Logging. Server-only.
//
// Readable console lines by default, as always. JSON when
// COMPASSDOCS_LOG_FORMAT=json, or (1.21.0) in cloud mode (lib/cloud), where
// the platform ships stdout to its log store: one JSON object per line,
//
//   {"time":"…","level":"info","message":"…","event":"…","request_id":"…",…}
//
// with `ts` kept beside `time` for anyone who parsed the pre-1.21.0 lines.
// COMPASSDOCS_LOG_FORMAT=text keeps readable lines in cloud mode too.
//
// In JSON mode every console.log / info / warn / error / debug line of the
// process becomes such an object too (installJsonConsole: the server entry,
// start.cjs, does it before Next starts; instrumentation again for a process
// started some other way), so a stack trace is one line, not thirty.
//
// Never secrets: values of the secret variables (lib/cloud ENV_SECRETS and
// the SMTP and updater ones) are masked wherever they appear, so are
// passwords in connection strings, bearer tokens and API-key shapes, and
// fields named like a secret (password, token, secret, key…) are masked
// whole. The request id is the x-request-id header (the platform's, or one
// the proxy gives each request in JSON mode, proxy.ts), when the line is
// written inside a request.
//
// 1.21.1: with telemetry on (lib/telemetry-config), a line written while a
// sampled span is active carries its trace_id and span_id, so a log line in
// Log Analytics leads to its trace in Application Insights (or a collector).

import "server-only";
import { format, inspect } from "node:util";
import { createRequire } from "node:module";
import { join } from "node:path";
import { ENV_SECRETS, isCloud, jsonLogging, type Env } from "./cloud";
import { telemetryHooks } from "./telemetry-hooks";

type Level = "debug" | "info" | "warn" | "error";

export { jsonLogging };

// --- Redaction ------------------------------------------------------------------

/** Variables whose values never appear in a log line. */
const SECRET_VARS = [
  ...ENV_SECRETS.map((s) => s.env).filter((v) => v !== "DATABASE_URL" && v !== "DATABASE_LISTEN_URL"),
  "COMPASSDOCS_UPDATER_TOKEN",
  "COMPASSDOCS_SMTP_PASSWORD",
  // 1.21.1: telemetry's credentials (a collector's API-key header; Application Insights' key).
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "APPLICATIONINSIGHTS_CONNECTION_STRING",
];

/** A field whose name says it holds a secret: its value is masked whole. */
const SECRET_FIELD = /(pass(word)?|secret|token|api[_-]?key|private[_-]?key|authorization|cookie|credential)s?$/i;

const MASK = "[redacted]";

/**
 * The ways a secret's value can appear in a line: as it is, as util.inspect
 * writes it inside a logged object (quotes and backslashes escaped, a
 * newline as \n), and as JSON.stringify does. Longest first.
 */
function secretForms(v: string): string[] {
  const forms = new Set([v, inspect(v).slice(1, -1), JSON.stringify(v).slice(1, -1)]);
  return [...forms].filter((f) => f.length >= 6).sort((a, b) => b.length - a.length);
}

/** `text` with every secret this process knows of, and every secret-looking shape, masked. */
export function redact(text: string, env: Env = process.env): string {
  let out = text;
  for (const name of SECRET_VARS) {
    const v = env[name];
    if (v && v.length >= 6) for (const form of secretForms(v)) out = out.split(form).join(MASK);
  }
  // A connection string's password: scheme://user:password@host
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)@/gi, `$1${MASK}@`);
  // Authorization headers and bearer tokens.
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MASK}`);
  // API-key shapes: Anthropic, OpenAI, Slack, GitHub.
  out = out.replace(/\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,})/g, MASK);
  // Sealed settings (lib/secretbox) are ciphertext, but never worth printing.
  out = out.replace(/enc:v1:[A-Za-z0-9+/=]{16,}/g, `enc:v1:${MASK}`);
  return out;
}

function redactValue(key: string, value: unknown, env: Env, depth = 0): unknown {
  if (SECRET_FIELD.test(key) && value !== null && value !== undefined && value !== "" && typeof value !== "boolean") return MASK;
  if (typeof value === "string") return redact(value, env);
  if (value instanceof Error) return redact(value.stack || value.message, env);
  if (depth < 4 && value && typeof value === "object") {
    if (Array.isArray(value)) return value.map((v) => redactValue("", v, env, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(k, v, env, depth + 1);
    return out;
  }
  return value;
}

// --- Request id -------------------------------------------------------------------

type HeaderStore = { type?: string; headers?: { get(name: string): string | null } };
type WorkUnitStorage = { getStore(): HeaderStore | undefined };
let workUnitStorage: WorkUnitStorage | null = null;
/** When loading Next's store failed: not tried again before this (ms since epoch). */
let retryLoadAt = 0;
const RETRY_LOAD_MS = 60_000;

/** Next's own per-request store, loaded once; after a failure, tried again a minute later. */
function requestStore(now = Date.now()): WorkUnitStorage | null {
  if (workUnitStorage) return workUnitStorage;
  if (now < retryLoadAt) return null;
  try {
    // Next's own per-request store (what next/headers reads): the
    // ".external" module is never bundled, so the copy in node_modules
    // (beside the server, which runs from its own folder) is the one Next
    // fills. Loaded at run time so this module stays importable anywhere.
    const req = createRequire(join(process.cwd(), "noop.js"));
    workUnitStorage = req("next/dist/server/app-render/work-unit-async-storage.external.js").workUnitAsyncStorage ?? null;
    if (!workUnitStorage) retryLoadAt = now + RETRY_LOAD_MS;
  } catch {
    retryLoadAt = now + RETRY_LOAD_MS;
  }
  return workUnitStorage;
}

/**
 * The x-request-id of the request this code runs in, when there is one.
 * One failure never turns request ids off for the rest of the process
 * (review of #334): a store that couldn't be loaded is tried again a
 * minute later, and a store that throws only costs this one line its id.
 */
export function currentRequestId(): string | undefined {
  try {
    const store = requestStore()?.getStore();
    const id = store?.type === "request" ? store.headers?.get("x-request-id") : null;
    return id ? id.slice(0, 128) : undefined;
  } catch {
    return undefined;
  }
}

/** Tests: forget the loaded store (or a failed load), or put one in its place. */
export function setRequestStoreForTests(store: WorkUnitStorage | null, retryAt = 0): void {
  workUnitStorage = store;
  retryLoadAt = retryAt;
}

// --- Lines --------------------------------------------------------------------------

/** The active sampled span's ids (1.21.1), or nothing: telemetry off, no span, or a failure. */
function activeTraceIds(): { trace_id: string; span_id: string } | null {
  try {
    return telemetryHooks()?.traceIds() ?? null;
  } catch {
    return null;
  }
}

/**
 * One JSON log line (no newline): time, level, message, event, request id,
 * trace and span ids (1.21.1, while a sampled span is active), then the
 * fields, all redacted, except the fields named in `reveal` (the
 * self-hosted setup token, which the operator has to read from the log).
 */
export function jsonLine(
  level: Level,
  message: string,
  fields: Record<string, unknown> = {},
  opts: { event?: string; requestId?: string; traceIds?: { trace_id: string; span_id: string } | null; now?: Date; env?: Env; reveal?: string[] } = {}
): string {
  const env = opts.env ?? process.env;
  const time = (opts.now ?? new Date()).toISOString();
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (["time", "ts", "level", "message", "event", "request_id", "trace_id", "span_id"].includes(k)) continue;
    if (v !== undefined) rest[k] = opts.reveal?.includes(k) ? v : redactValue(k, v, env);
  }
  const requestId = opts.requestId ?? currentRequestId();
  const ids = opts.traceIds === undefined ? activeTraceIds() : opts.traceIds;
  return JSON.stringify({
    time,
    level,
    message: redact(message, env),
    ...(opts.event ? { event: opts.event } : {}),
    ...(requestId ? { request_id: requestId } : {}),
    ...(ids ? { trace_id: ids.trace_id, span_id: ids.span_id } : {}),
    ...rest,
    ts: time,
  });
}

const RAW = globalThis as unknown as {
  /** The console's own methods, kept by whoever patched it first (start.cjs or installJsonConsole). */
  __compassRawConsole?: Record<"log" | "info" | "warn" | "error" | "debug", (...args: unknown[]) => void>;
  __compassJsonConsole?: boolean;
};

function rawWrite(level: Level, line: string): void {
  const raw = RAW.__compassRawConsole;
  const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
  // eslint-disable-next-line no-console
  (raw ? raw[method] : console[method])(line);
}

export function logEvent(
  level: Level,
  event: string,
  fields: Record<string, unknown> = {},
  opts: { reveal?: string[] } = {}
): void {
  if (jsonLogging()) {
    const { message, ...rest } = fields;
    rawWrite(level, jsonLine(level, typeof message === "string" ? message : event, rest, { event, reveal: opts.reveal }));
    return;
  }
  // Readable lines: as before, except in cloud mode (COMPASSDOCS_LOG_FORMAT=text
  // there), where they are redacted like the JSON ones (review of #334).
  const cloud = isCloud();
  const extras = Object.entries(fields)
    .map(([k, v]) => {
      const shown = cloud && !opts.reveal?.includes(k) ? redactValue(k, v, process.env) : v;
      return `${k}=${typeof shown === "string" ? shown : JSON.stringify(shown)}`;
    })
    .join(" ");
  // eslint-disable-next-line no-console
  console[level === "info" || level === "debug" ? "log" : level](`[${event}]${extras ? " " + extras : ""}`);
}

/** "[backup] scheduler error: …" → event "backup", the rest the message. */
export function splitTag(message: string): { event?: string; message: string } {
  const m = /^\[([a-z0-9_.:-]{1,40})\]\s?([\s\S]*)$/i.exec(message);
  return m ? { event: m[1], message: m[2] } : { message };
}

/**
 * JSON mode: every console line of the process becomes one JSON object.
 * Idempotent; keeps the console's own methods for logEvent. In text mode a
 * no-op, except in cloud mode, where lines stay readable but are redacted.
 */
export function installJsonConsole(): void {
  if (RAW.__compassJsonConsole) return;
  if (!jsonLogging()) {
    // Readable lines in cloud mode (COMPASSDOCS_LOG_FORMAT=text) are still
    // redacted (review of #334). Self-hosted readable lines are untouched.
    if (isCloud()) installRedactingConsole();
    return;
  }
  const raw = RAW.__compassRawConsole ?? {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };
  RAW.__compassRawConsole = raw;
  RAW.__compassJsonConsole = true;
  const make =
    (level: Level) =>
    (...args: unknown[]) => {
      try {
        const text = format(...args);
        // A line that already is one of ours (logEvent through a patched console) passes as it is.
        if (text.startsWith('{"time":')) return rawWrite(level, text);
        const { event, message } = splitTag(text);
        rawWrite(level, jsonLine(level, message, {}, { event }));
      } catch {
        rawWrite(level, JSON.stringify({ time: new Date().toISOString(), level, message: "unprintable log line" }));
      }
    };
  console.log = make("info");
  console.info = make("info");
  console.warn = make("warn");
  console.error = make("error");
  console.debug = make("debug");
}

/** Cloud mode with readable lines: every console line as it was, redacted. */
function installRedactingConsole(): void {
  const raw = RAW.__compassRawConsole ?? {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };
  RAW.__compassRawConsole = raw;
  RAW.__compassJsonConsole = true;
  const make =
    (method: "log" | "info" | "warn" | "error" | "debug") =>
    (...args: unknown[]) => {
      try {
        raw[method](redact(format(...args)));
      } catch {
        raw[method]("unprintable log line");
      }
    };
  console.log = make("log");
  console.info = make("info");
  console.warn = make("warn");
  console.error = make("error");
  console.debug = make("debug");
}
