// OpenTelemetry traces and metrics (1.21.1). Loaded only when an exporter is
// configured (lib/telemetry-config startTelemetryIfConfigured, from
// instrumentation.ts); a server without one never loads this file.
//
// Traces:
//   - one SERVER span per incoming request, started here as the request
//     arrives and ended when the response is done, named "GET /docs/[slug]"
//     from the route Next resolves (Next 16 writes http.route on it); Next's
//     own request spans become its children, so a request is one "request"
//     in Application Insights, not two. The probes (/healthz, /readyz) are
//     never traced: their whole request runs with tracing suppressed;
//   - outbound HTTP through node:http(s) (Azure Blob, S3, web push) and
//     fetch / undici (Microsoft Graph, Anthropic, webhooks), and each
//     Postgres query with its statement text and never its parameters,
//     only inside a traced request or job;
//   - one span per background job run (lib/shutdown runJob), named
//     "job <name>", and one per SMTP send (lib/mailer);
//   - sampling: parent-based trace-id ratio, every trace self-hosted and one
//     in five in cloud mode (lib/telemetry-config samplerSettings).
//
// Metrics (every 60 s): http.server.request.duration by method, status and
// route; the database pool's used, idle and waiting counts; background job
// runs and failures by job; mail sent and failed by transport. Nothing else:
// the instrumentations' own metrics are dropped.
//
// Every span is scrubbed on its way out (lib/telemetry-redact). Exporter
// errors are logged once per distinct error. On SIGTERM both providers are
// flushed during the drain, before the database pool closes, for at most a
// few seconds (lib/shutdown onFlush): a collector that hangs never holds up
// the exit.
//
// Server-only.

import "server-only";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import {
  context,
  diag,
  DiagLogLevel,
  metrics,
  propagation,
  trace,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  type Attributes,
  type Context,
  type Link,
  type Span,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator, setGlobalErrorHandler, suppressTracing } from "@opentelemetry/core";
import { defaultResource, detectResources, envDetector, resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  SamplingDecision,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
  type Sampler,
  type SamplingResult,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AggregationType, MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter, type ViewOptions } from "@opentelemetry/sdk-metrics";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import pkg from "../../package.json";
import { isCloud, type Env } from "./cloud";
import { onFlush } from "./shutdown";
import { isProbePath, type SamplerSettings, type TelemetryPlan } from "./telemetry-config";
import type { TelemetryHooks } from "./telemetry-hooks";
import { ScrubbingSpanExporter, scrubString } from "./telemetry-redact";

type Log = (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => void;

// --- Sampling -------------------------------------------------------------------------

/**
 * Set while the app's own request span starts. When the trace is not sampled,
 * that span and Next's request spans (BaseServer.handleRequest) are still
 * recorded, never exported (only sampled spans are), so the route Next
 * resolves reaches the request span and the request metric has its route for
 * every request, not just the sampled ones. Nothing else is recorded.
 */
const requestRoot = { starting: false };

const NEXT_REQUEST_SPAN = "BaseServer.handleRequest";

/** The configured sampler, plus: the probes never, and the request spans always recorded. */
export class CompassSampler implements Sampler {
  constructor(private readonly inner: Sampler) {}

  shouldSample(ctx: Context, traceId: string, name: string, kind: SpanKind, attributes: Attributes, links: Link[]): SamplingResult {
    const target = attributes["http.target"];
    if (typeof target === "string" && isProbePath(target.split("?")[0])) return { decision: SamplingDecision.NOT_RECORD };
    const r = this.inner.shouldSample(ctx, traceId, name, kind, attributes, links);
    if (r.decision === SamplingDecision.NOT_RECORD && (requestRoot.starting || attributes["next.span_type"] === NEXT_REQUEST_SPAN)) {
      return { decision: SamplingDecision.RECORD, attributes: r.attributes, traceState: r.traceState };
    }
    return r;
  }

  toString(): string {
    return `CompassSampler{${this.inner.toString()}}`;
  }
}

/** OTEL_TRACES_SAMPLER's samplers, inside CompassSampler. */
export function buildSampler(s: SamplerSettings): Sampler {
  const ratio = () => new TraceIdRatioBasedSampler(s.ratio);
  switch (s.name) {
    case "always_on":
      return new CompassSampler(new AlwaysOnSampler());
    case "always_off":
      return new CompassSampler(new AlwaysOffSampler());
    case "traceidratio":
      return new CompassSampler(ratio());
    case "parentbased_always_on":
      return new CompassSampler(new ParentBasedSampler({ root: new AlwaysOnSampler() }));
    case "parentbased_always_off":
      return new CompassSampler(new ParentBasedSampler({ root: new AlwaysOffSampler() }));
    default:
      return new CompassSampler(new ParentBasedSampler({ root: ratio() }));
  }
}

// --- Resource ---------------------------------------------------------------------------

/** service.name=compassdocs, the version, the replica; the workspace in cloud mode; then OTEL_RESOURCE_ATTRIBUTES / OTEL_SERVICE_NAME, which win. */
export function buildResource(env: Env = process.env): Resource {
  const attrs: Attributes = {
    "service.name": "compassdocs",
    "service.version": pkg.version,
    "service.instance.id": env.CONTAINER_APP_REPLICA_NAME?.trim() || hostname(),
    "compassdocs.mode": isCloud(env) ? "cloud" : "self-hosted",
  };
  const workspace = env.COMPASSDOCS_WORKSPACE_ID?.trim();
  if (isCloud(env) && workspace) attrs["compassdocs.workspace.id"] = workspace.slice(0, 128);
  return defaultResource().merge(resourceFromAttributes(attrs)).merge(detectResources({ detectors: [envDetector] }));
}

// --- Errors, once each ------------------------------------------------------------------

const MAX_DISTINCT_ERRORS = 50;

/** Logs each distinct message once (exporter errors repeat on every batch); scrubbed like a span. */
export function onceLogger(log: Log, event: string): (text: string) => void {
  const seen = new Set<string>();
  let overflow = false;
  return (text: string) => {
    const message = scrubString(text).replace(/\s+/g, " ").trim().slice(0, 300);
    if (!message || seen.has(message)) return;
    if (seen.size >= MAX_DISTINCT_ERRORS) {
      if (!overflow) log("warn", event, { message: "Further telemetry errors are not logged (each distinct one was logged once)." });
      overflow = true;
      return;
    }
    seen.add(message);
    log("warn", event, { message });
  };
}

function errorText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return `${e.name}: ${e.message}${code !== undefined && code !== "" ? ` (${String(code)})` : ""}`;
  }
  return String(e);
}

// --- The request span -----------------------------------------------------------------------

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"]);
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

type Emit = (this: unknown, event: string | symbol, ...args: unknown[]) => boolean;

/** The app's request span of each request in flight, by trace id (RouteProcessor). */
const requestSpans = new Map<string, Span>();

function routeOf(span: unknown): string | undefined {
  const r = (span as { attributes?: Attributes }).attributes?.["http.route"];
  return typeof r === "string" && r ? r : undefined;
}

/**
 * Next writes the route on the request span above its own for pages, but for
 * a route handler (route.ts) only on its own request span: copy it up when
 * that span ends, so both kinds are named by route.
 */
class RouteProcessor implements SpanProcessor {
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    if (span.attributes["next.span_type"] !== NEXT_REQUEST_SPAN) return;
    const route = routeOf(span);
    const root = requestSpans.get(span.spanContext().traceId);
    if (route && root && !routeOf(root)) root.setAttribute("http.route", route);
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

interface RequestTelemetry {
  tracer: ReturnType<BasicTracerProvider["getTracer"]>;
  record(seconds: number, attrs: Attributes): void;
}

/**
 * Around one incoming request: the probes with tracing suppressed; anything
 * else inside its own SERVER span, ended (and measured) when the response is
 * done. `next` is the server's own handling.
 */
function handleRequest(t: RequestTelemetry, req: IncomingMessage, res: ServerResponse, next: () => boolean): boolean {
  let span: Span;
  let parent: Context;
  let method: string;
  try {
    const path = (req.url || "/").split("?")[0];
    if (isProbePath(path)) return context.with(suppressTracing(context.active()), next);
    const raw = String(req.method || "GET").toUpperCase();
    method = METHODS.has(raw) ? raw : "_OTHER";
    const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const attributes: Attributes = {
      "http.request.method": method,
      "url.scheme": forwarded === "https" || (req.socket as { encrypted?: boolean })?.encrypted ? "https" : "http",
      "network.protocol.version": req.httpVersion,
    };
    if (method === "_OTHER") attributes["http.request.method_original"] = raw.slice(0, 20);
    const ua = req.headers["user-agent"];
    if (typeof ua === "string") attributes["user_agent.original"] = ua.slice(0, 512);
    parent = propagation.extract(ROOT_CONTEXT, req.headers);
    requestRoot.starting = true;
    try {
      span = t.tracer.startSpan(method, { kind: SpanKind.SERVER, attributes }, parent);
    } finally {
      requestRoot.starting = false;
    }
  } catch {
    return next();
  }
  const started = performance.now();
  const traceId = span.spanContext().traceId;
  requestSpans.set(traceId, span);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const endedAt = new Date();
    const seconds = (performance.now() - started) / 1000;
    const status = res.statusCode;
    // One turn later, so Next's own request spans have ended and their route reached this one.
    setImmediate(() => {
      try {
        if (requestSpans.get(traceId) === span) requestSpans.delete(traceId);
        const route = routeOf(span);
        if (route) span.updateName(`${method} ${route}`);
        span.setAttribute("http.response.status_code", status);
        if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        const id = req.headers["x-request-id"];
        if (typeof id === "string" && REQUEST_ID.test(id)) span.setAttribute("request_id", id);
        span.end(endedAt);
        t.record(seconds, { "http.request.method": method, "http.response.status_code": status, ...(route ? { "http.route": route } : {}) });
      } catch {
        /* telemetry never breaks a response */
      }
    });
  };
  res.once("finish", finish);
  res.once("close", finish);
  return context.with(trace.setSpan(parent, span), next);
}

/** Wrap http(s).Server's emit so every "request" goes through handleRequest. Returns the undo. */
function wrapServers(t: RequestTelemetry): () => void {
  const undo: (() => void)[] = [];
  for (const proto of [http.Server.prototype, https.Server.prototype] as unknown as { emit: Emit }[]) {
    const original = proto.emit;
    if ((original as { __compassTelemetry?: boolean }).__compassTelemetry) continue;
    const own = Object.prototype.hasOwnProperty.call(proto, "emit");
    const wrapped: Emit = function (this: unknown, event, ...args) {
      if (event !== "request") return original.call(this, event, ...args);
      return handleRequest(t, args[0] as IncomingMessage, args[1] as ServerResponse, () => original.call(this, event, ...args));
    };
    (wrapped as { __compassTelemetry?: boolean }).__compassTelemetry = true;
    proto.emit = wrapped;
    undo.push(() => {
      if (own) proto.emit = original;
      else delete (proto as { emit?: Emit }).emit;
    });
  }
  return () => undo.forEach((u) => u());
}

// --- Exporters ---------------------------------------------------------------------------------

interface Target {
  /** For the start-up line: where to, never a credential. */
  label: string;
  spans?: SpanExporter;
  metrics?: PushMetricExporter;
  /** Added to every span this target receives. */
  extra?: Attributes;
}

/** The exporters the plan names, loaded on demand: OTLP over HTTP (protobuf or JSON) and Application Insights. */
async function buildTargets(plan: TelemetryPlan, log: Log): Promise<Target[]> {
  const targets: Target[] = [];
  if (plan.otlp) {
    const json = plan.otlp.protocol === "http/json";
    const t: Target = { label: `an OTLP collector (${plan.otlp.host}, ${plan.otlp.protocol})` };
    // The exporters read OTEL_EXPORTER_OTLP_ENDPOINT (plus /v1/traces, /v1/metrics), _HEADERS and _TIMEOUT themselves.
    if (plan.traces) {
      const m = json ? await import("@opentelemetry/exporter-trace-otlp-http") : await import("@opentelemetry/exporter-trace-otlp-proto");
      t.spans = new m.OTLPTraceExporter();
    }
    if (plan.metrics) {
      const m = json ? await import("@opentelemetry/exporter-metrics-otlp-http") : await import("@opentelemetry/exporter-metrics-otlp-proto");
      t.metrics = new m.OTLPMetricExporter();
    }
    targets.push(t);
  }
  if (plan.azure) {
    // The exporter's own usage reports to Microsoft (statsbeat, SDK stats) stay off unless asked for.
    for (const k of ["APPLICATION_INSIGHTS_NO_STATSBEAT", "APPLICATIONINSIGHTS_STATSBEAT_DISABLED", "APPLICATIONINSIGHTS_SDKSTATS_DISABLED"]) process.env[k] ??= "true";
    try {
      const az = await import("@azure/monitor-opentelemetry-exporter");
      // No offline storage: a span that can't be sent is dropped, never written to the container's disk.
      const options = { connectionString: plan.azure.connectionString, disableOfflineStorage: true };
      const ratio = plan.sampler.name.endsWith("traceidratio") ? plan.sampler.ratio : plan.sampler.name.endsWith("always_off") ? 0 : 1;
      const extra: Attributes = {};
      // Application Insights scales its counts by this (a 20% sample counts each request five times).
      if (ratio > 0) extra["microsoft.sample_rate"] = Math.round(ratio * 10000) / 100;
      // It keeps resource attributes off each request and dependency: the workspace goes on every span instead.
      const workspace = buildResource().attributes["compassdocs.workspace.id"];
      if (typeof workspace === "string") extra["compassdocs.workspace.id"] = workspace;
      targets.push({
        label: `Application Insights (${plan.azure.ingestionHost})`,
        spans: plan.traces ? new az.AzureMonitorTraceExporter(options) : undefined,
        metrics: plan.metrics ? new az.AzureMonitorMetricExporter(options) : undefined,
        extra,
      });
    } catch (e) {
      log("warn", "telemetry.config", { message: `Application Insights could not be set up, running without it: ${errorText(e)}` });
    }
  }
  return targets;
}

// --- Start and stop -------------------------------------------------------------------------------

interface Running {
  tracerProvider: BasicTracerProvider;
  meterProvider: MeterProvider;
  undo: () => void;
}

let running: Running | null = null;

const G = globalThis as unknown as {
  __compassTelemetry?: TelemetryHooks;
  __compassPool?: { totalCount: number; idleCount: number; waitingCount: number };
};

/** Seconds buckets for the request metric (OpenTelemetry's recommendation for http.server.request.duration). */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];

/** The instrumentations' own meters: their metrics are not wanted (the list above is all). */
const DROPPED_METERS = ["@opentelemetry/instrumentation-http", "@opentelemetry/instrumentation-undici", "@opentelemetry/instrumentation-pg"];

export interface StartOptions {
  /** Tests: export here instead of the plan's targets. */
  spanExporters?: SpanExporter[];
  metricExporters?: PushMetricExporter[];
}

/**
 * Start the SDK for this plan. Idempotent. Registers the global providers
 * Next and the instrumentations use, the request span, the hooks the app
 * calls (lib/telemetry-config telemetryHooks) and the flush on shutdown.
 */
export async function startTelemetry(plan: TelemetryPlan, log: Log, opts: StartOptions = {}): Promise<void> {
  if (running) return;
  const env = process.env;
  const logError = onceLogger(log, "telemetry.error");
  setGlobalErrorHandler((e) => logError(`Telemetry export failed: ${errorText(e)}`));
  const diagLine = (...args: unknown[]) => {
    const text = format(...args);
    // instrumentation-http says so for node:http, which the server entry loaded first; it is patched below anyway.
    if (/has been loaded before/.test(text)) return;
    logError(text);
  };
  diag.setLogger({ error: diagLine, warn: diagLine, info: () => {}, debug: () => {}, verbose: () => {} }, DiagLogLevel.WARN);

  // Stable semantic conventions (url.full, http.request.method, db.query.text) unless asked otherwise.
  env.OTEL_SEMCONV_STABILITY_OPT_IN ??= "http,database";
  // Outbound fetch is traced by the undici instrumentation; Next's own fetch spans would be duplicates.
  env.NEXT_OTEL_FETCH_DISABLED ??= "1";

  const targets = opts.spanExporters || opts.metricExporters ? [] : await buildTargets(plan, log);
  const spanExporters: { exporter: SpanExporter; extra?: Attributes }[] = [
    ...(opts.spanExporters ?? []).map((exporter) => ({ exporter })),
    ...targets.filter((t) => t.spans).map((t) => ({ exporter: t.spans!, extra: t.extra })),
  ];
  const metricExporters = [...(opts.metricExporters ?? []), ...targets.flatMap((t) => (t.metrics ? [t.metrics] : []))];
  if (!opts.spanExporters && !opts.metricExporters && !targets.length) return;

  const resource = buildResource(env);
  const spanProcessors: SpanProcessor[] = [
    new RouteProcessor(),
    ...spanExporters.map(({ exporter, extra }) => new BatchSpanProcessor(new ScrubbingSpanExporter(exporter, extra))),
  ];
  const tracerProvider = new BasicTracerProvider({
    resource,
    sampler: buildSampler(plan.sampler),
    // A migration's SQL can run to 100 kB; Application Insights keeps 8 kB of a property.
    spanLimits: env.OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT || env.OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT ? undefined : { attributeValueLengthLimit: 4096 },
    spanProcessors,
  });
  const exportIntervalMillis = plan.metricIntervalMs;
  const meterProvider = new MeterProvider({
    resource,
    readers: metricExporters.map(
      (exporter) => new PeriodicExportingMetricReader({ exporter, exportIntervalMillis, exportTimeoutMillis: Math.min(30_000, exportIntervalMillis) })
    ),
    views: DROPPED_METERS.map((meterName): ViewOptions => ({ meterName, aggregation: { type: AggregationType.DROP } })),
  });

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(tracerProvider);
  metrics.setGlobalMeterProvider(meterProvider);

  const unregister = registerInstrumentations({
    tracerProvider,
    meterProvider,
    instrumentations: [
      // Incoming requests are the request span below (with Next's route), not this instrumentation's.
      new HttpInstrumentation({ disableIncomingRequestInstrumentation: true, requireParentforOutgoingSpans: true }),
      new UndiciInstrumentation({ requireParentforSpans: true }),
      // Statement text only: enhancedDatabaseReporting (parameter values) stays off.
      new PgInstrumentation({ requireParentSpan: true, enhancedDatabaseReporting: false, ignoreConnectSpans: true }),
    ],
  });
  // node:http and node:https were loaded by the server entry before this ran: requiring them
  // again hands them to the instrumentation now rather than at the next require.
  try {
    const req = createRequire(join(process.cwd(), "noop.js"));
    req("node:http");
    req("node:https");
  } catch {
    /* patched at their next require instead */
  }

  const meter = meterProvider.getMeter("compassdocs", pkg.version);
  const requestDuration = meter.createHistogram("http.server.request.duration", {
    unit: "s",
    description: "Duration of HTTP server requests.",
    advice: { explicitBucketBoundaries: DURATION_BUCKETS },
  });
  const jobRuns = meter.createCounter("compassdocs.job.runs", { unit: "{run}", description: "Background job runs, by job." });
  const jobFailures = meter.createCounter("compassdocs.job.failures", { unit: "{run}", description: "Background job runs that failed, by job." });
  const mailSent = meter.createCounter("compassdocs.mail.sent", { unit: "{message}", description: "Email handed to the SMTP relay or Microsoft 365." });
  const mailFailed = meter.createCounter("compassdocs.mail.failed", { unit: "{message}", description: "Email the SMTP relay or Microsoft 365 refused, or that could not be sent." });
  // 1.21.2 (lib/db-retry): database outages, and the requests that waited through one.
  const dbOutages = meter.createCounter("compassdocs.db.outages", { unit: "{outage}", description: "Database outages: the first connection error after the database last answered." });
  const dbRetries = meter.createCounter("compassdocs.db.retried_requests", { unit: "{request}", description: "Requests that waited for the database, by outcome (recovered, gave_up)." });
  const connections = meter.createObservableUpDownCounter("db.client.connection.count", { unit: "{connection}", description: "Database pool connections, by state." });
  const pending = meter.createObservableUpDownCounter("db.client.connection.pending_requests", { unit: "{request}", description: "Requests waiting for a database pool connection." });
  meter.addBatchObservableCallback(
    (r) => {
      // The pool as it is: never one made for this (lib/db pool() would), none once it is closed.
      const p = G.__compassPool;
      if (!p) return;
      const pool = { "db.client.connection.pool.name": "compassdocs" };
      r.observe(connections, Math.max(0, p.totalCount - p.idleCount), { ...pool, "db.client.connection.state": "used" });
      r.observe(connections, p.idleCount, { ...pool, "db.client.connection.state": "idle" });
      r.observe(pending, p.waitingCount, pool);
    },
    [connections, pending]
  );

  const tracer = tracerProvider.getTracer("compassdocs", pkg.version);
  const undoServers = wrapServers({ tracer, record: (s, a) => requestDuration.record(s, a) });

  const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));
  const hooks: TelemetryHooks = {
    traceIds() {
      const sc = trace.getSpan(context.active())?.spanContext();
      if (!sc || !isSpanContextValid(sc) || (sc.traceFlags & TraceFlags.SAMPLED) === 0) return null;
      return { trace_id: sc.traceId, span_id: sc.spanId };
    },
    job(name, fn) {
      const attrs = { "compassdocs.job.name": name };
      return tracer.startActiveSpan(`job ${name}`, { kind: SpanKind.INTERNAL, attributes: attrs }, async (span) => {
        try {
          return await fn();
        } catch (e) {
          jobFailures.add(1, attrs);
          span.recordException(asError(e));
          span.setStatus({ code: SpanStatusCode.ERROR, message: asError(e).message });
          throw e;
        } finally {
          jobRuns.add(1, attrs);
          span.end();
        }
      });
    },
    smtp(server, fn) {
      const attributes = { "server.address": server.host, "server.port": server.port, "network.protocol.name": "smtp" };
      return tracer.startActiveSpan("smtp send", { kind: SpanKind.CLIENT, attributes }, async (span) => {
        try {
          const out = await fn();
          mailSent.add(1, { "compassdocs.mail.transport": "smtp" });
          return out;
        } catch (e) {
          mailFailed.add(1, { "compassdocs.mail.transport": "smtp" });
          span.recordException(asError(e));
          span.setStatus({ code: SpanStatusCode.ERROR, message: asError(e).message });
          throw e;
        } finally {
          span.end();
        }
      });
    },
    mail(transport, ok) {
      (ok ? mailSent : mailFailed).add(1, { "compassdocs.mail.transport": transport });
    },
    dbOutage() {
      dbOutages.add(1);
    },
    dbRetry(outcome) {
      dbRetries.add(1, { "compassdocs.db.retry.outcome": outcome });
    },
  };
  G.__compassTelemetry = hooks;

  // SIGTERM: flushed during the drain, before the pool closes, bounded (lib/shutdown).
  onFlush("telemetry", async () => {
    await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
  });

  running = {
    tracerProvider,
    meterProvider,
    undo: () => {
      unregister();
      undoServers();
    },
  };

  const what = [plan.traces ? "traces" : "", plan.metrics ? "metrics" : ""].filter(Boolean).join(" and ");
  const sampling = plan.sampler.name.endsWith("traceidratio") ? `${plan.sampler.ratio * 100}% of traces` : plan.sampler.name;
  if (targets.length) {
    log("info", "telemetry.started", {
      message: `Telemetry on: ${what} to ${targets.map((t) => t.label).join(" and ")}, sampling ${sampling}. Logs are not exported.`,
      sampler: plan.sampler.name,
      ratio: plan.sampler.ratio,
    });
  }
}

/** Tests: stop everything startTelemetry set up, so a test can start it again. */
export async function stopTelemetryForTests(): Promise<void> {
  const r = running;
  if (!r) return;
  running = null;
  r.undo();
  delete G.__compassTelemetry;
  await Promise.allSettled([r.tracerProvider.shutdown(), r.meterProvider.shutdown()]);
  trace.disable();
  context.disable();
  propagation.disable();
  metrics.disable();
  diag.disable();
}

/** Tests: the running providers (forceFlush). */
export function runningForTests(): { tracerProvider: BasicTracerProvider; meterProvider: MeterProvider } | null {
  return running;
}
