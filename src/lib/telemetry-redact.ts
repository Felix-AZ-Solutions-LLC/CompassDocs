// What a span may carry when it leaves the process (1.21.1, lib/telemetry).
//
// Every span passes through scrubSpan on its way to an exporter, whatever
// created it (Next's own spans, the HTTP, fetch and Postgres
// instrumentations, the app's job and SMTP spans):
//
//   - never request or response headers, except user-agent, content-type,
//     content-length and x-request-id; never cookies or credentials, nor any
//     attribute whose name says it holds one (password, token, secret…);
//   - never a query string (search terms, sign-in tokens and return paths
//     ride in them), never the password in a URL, never the raw request path
//     of an incoming request (it can hold a token: the route, e.g.
//     /invite/[token], names the request instead);
//   - never SQL parameter values (db.postgresql.values, db.query.parameter.*);
//   - never a request or response body;
//   - every remaining string, the span's name, its status message and its
//     exceptions' messages and stacks are masked the way log lines are
//     (lib/log redact: secret variables' values, bearer tokens, API-key
//     shapes, URL passwords), and email addresses become [email].
//
// Server-only (it reuses lib/log). Imports only OpenTelemetry's API types.

import "server-only";
import { SpanKind, type Attributes, type AttributeValue } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter, TimedEvent } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { redact } from "./log";
import type { Env } from "./cloud";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// The same, %-encoded in a URL ("a%40b.com").
const EMAIL_ENCODED = /[A-Za-z0-9._%+-]+%40[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gi;

/** Headers whose value may be recorded (http.request.header.<name> / http.response.header.<name>). */
export const SAFE_HEADERS: ReadonlySet<string> = new Set(["user-agent", "content-type", "content-length", "x-request-id"]);

/** An attribute name that says its value is a secret: dropped whole. */
const SECRET_KEY = /(pass(word|wd)?|secret|token|api[_-]?key|private[_-]?key|authorization|cookie|credential|session)s?$/i;

/** Attributes never exported, whatever their value. */
const DROPPED_KEYS = new Set([
  "http.target", // the raw path and query of an incoming request (Next's request span)
  "url.query",
  "http.request.body",
  "http.response.body",
  "http.client_ip",
  "client.address",
  "client.port",
  "db.postgresql.values",
  "db.statement.values",
]);
const DROPPED_PREFIXES = ["db.query.parameter.", "enduser.", "user.", "http.request.body.", "http.response.body."];

/** Attributes holding a URL: kept without their query, fragment or password. */
const URL_KEYS = new Set(["url.full", "http.url", "url.original"]);

/** A string as it may leave the process: lib/log's masks, then email addresses. */
export function scrubString(s: string, env: Env = process.env): string {
  return redact(s, env).replace(EMAIL, "[email]").replace(EMAIL_ENCODED, "[email]");
}

/** A URL without its user name and password, query string or fragment. */
export function stripUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return raw.replace(/[?#][\s\S]*$/, "");
  }
}

function keyDropped(key: string): boolean {
  if (DROPPED_KEYS.has(key)) return true;
  if (DROPPED_PREFIXES.some((p) => key.startsWith(p))) return true;
  const header = /^http\.(?:request|response)\.header\.(.+)$/.exec(key);
  if (header) return !SAFE_HEADERS.has(header[1].toLowerCase());
  return SECRET_KEY.test(key);
}

function scrubValue(key: string, value: AttributeValue, env: Env): AttributeValue {
  if (typeof value === "string") return scrubString(URL_KEYS.has(key) ? stripUrl(value) : value, env);
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === "string" ? scrubString(URL_KEYS.has(key) ? stripUrl(v) : v, env) : v)) as AttributeValue;
  }
  return value;
}

/** A span's (or event's) attributes as they may leave the process. */
export function scrubAttributes(attrs: Attributes | undefined, env: Env = process.env): Attributes {
  const out: Attributes = {};
  if (!attrs) return out;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || keyDropped(key)) continue;
    out[key] = scrubValue(key, value, env);
  }
  return out;
}

function scrubEvent(e: TimedEvent, env: Env): TimedEvent {
  return { ...e, name: scrubString(e.name, env), attributes: e.attributes ? scrubAttributes(e.attributes, env) : e.attributes };
}

/** Next's request span (BaseServer.handleRequest): a child of the app's own request span, so not a second "request". */
function isNextRequestSpan(span: ReadableSpan): boolean {
  return span.attributes["next.span_type"] === "BaseServer.handleRequest" && !!span.parentSpanContext;
}

/**
 * A span as it may leave the process. A copy: the SDK's own span is not
 * touched. `extra` attributes are added after scrubbing (the exporter's own,
 * e.g. Application Insights' sample rate).
 */
export function scrubSpan(span: ReadableSpan, env: Env = process.env, extra?: Attributes): ReadableSpan {
  const attributes = scrubAttributes(span.attributes, env);
  if (extra) Object.assign(attributes, extra);
  return {
    name: scrubString(span.name, env),
    kind: isNextRequestSpan(span) ? SpanKind.INTERNAL : span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    status: span.status.message ? { ...span.status, message: scrubString(span.status.message, env) } : span.status,
    attributes,
    links: span.links.map((l) => ({ ...l, attributes: l.attributes ? scrubAttributes(l.attributes, env) : l.attributes })),
    events: span.events.map((e) => scrubEvent(e, env)),
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/**
 * An exporter that scrubs every span before the real one sees it, and never
 * throws into the SDK: a failure becomes a FAILED result (logged once per
 * distinct error by lib/telemetry's error handler).
 */
export class ScrubbingSpanExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly extra?: Attributes
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    let scrubbed: ReadableSpan[];
    try {
      scrubbed = spans.map((s) => scrubSpan(s, process.env, this.extra));
    } catch (error) {
      // Never send a span that could not be scrubbed.
      resultCallback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    try {
      this.inner.export(scrubbed, resultCallback);
    } catch (error) {
      resultCallback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
