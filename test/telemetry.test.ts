// Telemetry (1.21.1, lib/telemetry-config, lib/telemetry, lib/telemetry-redact):
// off by default with nothing loaded, the sampler's defaults, what a span may
// carry when it leaves the process, the probes left out, trace ids on log
// lines, job spans and counts, and the flush on SIGTERM with an exporter
// that hangs. The Postgres check needs DATABASE_URL (the CI integration job
// has one) and is skipped without it.
//
// The SDK is only ever loaded with a dynamic import below, after the first
// test has checked that nothing of it loads while telemetry is off. Node runs
// each test file in its own process, so no other file has loaded it either.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/telemetry.test.ts

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { registerHooks } from "node:module";
import type { AddressInfo } from "node:net";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { PushMetricExporter, ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { parseConnectionString, samplerSettings, startTelemetryIfConfigured, telemetryEnabled, telemetryPlan, type TelemetryPlan } from "../src/lib/telemetry-config";
import { telemetryHooks } from "../src/lib/telemetry-hooks";
import { jsonLine } from "../src/lib/log";
import { appClose, flushDeadline, onClose, resetLifecycleForTests, runJob, CLOSE_RESERVE_MS, FLUSH_MAX_MS } from "../src/lib/shutdown";

// Every module this process resolves from here on (require and import alike).
const resolved: string[] = [];
registerHooks({
  resolve(specifier, ctx, next) {
    resolved.push(specifier);
    return next(specifier, ctx);
  },
});
const sdkLoads = () => resolved.filter((s) => /@opentelemetry\/(?!api$)|@azure\/monitor-opentelemetry|[\\/]telemetry(?:\.ts)?$|^\.\/telemetry$/.test(s));

type Line = { level: string; event: string; fields: Record<string, unknown> };
const logs: Line[] = [];
const log = (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => void logs.push({ level, event, fields });

const KEY = "11111111-2222-3333-4444-555555555555";

describe("off by default", () => {
  test("with neither exporter set nothing of the SDK is imported, and nothing starts", async () => {
    const before = resolved.length;
    assert.equal(await startTelemetryIfConfigured(log, {}), false);
    assert.equal(await startTelemetryIfConfigured(log, { COMPASSDOCS_CLOUD: "1" }), false);
    assert.deepEqual(sdkLoads(), [], "an OpenTelemetry module was loaded with telemetry off");
    assert.equal(telemetryHooks(), undefined);
    assert.equal(logs.length, 0);
    assert.ok(resolved.length >= before);
  });

  test("OTEL_SDK_DISABLED=true wins over both exporters", async () => {
    const env = { OTEL_SDK_DISABLED: "true", APPLICATIONINSIGHTS_CONNECTION_STRING: `InstrumentationKey=${KEY}`, OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" };
    assert.equal(telemetryEnabled(telemetryPlan(env)), false);
    assert.equal(await startTelemetryIfConfigured(log, env), false);
    assert.deepEqual(sdkLoads(), []);
  });

  test("a malformed connection string is one warning, and the app runs without telemetry", async () => {
    logs.length = 0;
    assert.equal(await startTelemetryIfConfigured(log, { COMPASSDOCS_CLOUD: "1", APPLICATIONINSIGHTS_CONNECTION_STRING: "not-a-connection-string" }), false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, "warn");
    assert.match(String(logs[0].fields.message), /^APPLICATIONINSIGHTS_CONNECTION_STRING is set but malformed \(.+\): running without Application Insights\.$/);
    assert.doesNotMatch(String(logs[0].fields.message), /not-a-connection-string/);
    assert.deepEqual(sdkLoads(), []);
    logs.length = 0;
  });
});

describe("the plan (lib/telemetry-config)", () => {
  test("connection strings: a GUID key, an https ingestion endpoint", () => {
    assert.equal(parseConnectionString(`InstrumentationKey=${KEY};IngestionEndpoint=https://westeurope-5.in.applicationinsights.azure.com/;LiveEndpoint=https://x/`).ok, true);
    assert.deepEqual(parseConnectionString(`InstrumentationKey=${KEY}`), { ok: true, instrumentationKey: KEY, ingestionHost: "dc.services.visualstudio.com" });
    for (const bad of ["garbage", "IngestionEndpoint=https://x/", "InstrumentationKey=not-a-guid", `InstrumentationKey=${KEY};IngestionEndpoint=http://plain/`, `InstrumentationKey=${KEY};IngestionEndpoint=nope`]) {
      assert.equal(parseConnectionString(bad).ok, false, bad);
    }
  });

  test("either exporter starts it; both together export to both", () => {
    assert.equal(telemetryEnabled(telemetryPlan({})), false);
    const otlp = telemetryPlan({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example:4318" });
    assert.deepEqual(otlp.otlp, { endpoint: "https://collector.example:4318", host: "collector.example:4318", protocol: "http/protobuf" });
    assert.equal(otlp.azure, null);
    const both = telemetryPlan({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318", OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", APPLICATIONINSIGHTS_CONNECTION_STRING: `InstrumentationKey=${KEY}` });
    assert.equal(both.otlp?.protocol, "http/json");
    assert.equal(both.azure?.ingestionHost, "dc.services.visualstudio.com");
    assert.equal(both.metricIntervalMs, 60_000);
    const grpc = telemetryPlan({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4317", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" });
    assert.equal(grpc.otlp?.protocol, "http/protobuf");
    assert.equal(grpc.warnings.length, 1);
    const bad = telemetryPlan({ OTEL_EXPORTER_OTLP_ENDPOINT: "collector:4318" });
    assert.equal(bad.otlp, null);
    assert.equal(telemetryEnabled(bad), false);
    assert.equal(telemetryEnabled(telemetryPlan({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c", OTEL_TRACES_EXPORTER: "none", OTEL_METRICS_EXPORTER: "none" })), false);
  });

  test("sampling: parent-based ratio, 1.0 self-hosted and 0.2 in cloud mode; OTEL_TRACES_SAMPLER(_ARG) override it", () => {
    assert.deepEqual(samplerSettings({}), { name: "parentbased_traceidratio", ratio: 1 });
    assert.deepEqual(samplerSettings({ COMPASSDOCS_CLOUD: "1" }), { name: "parentbased_traceidratio", ratio: 0.2 });
    assert.deepEqual(samplerSettings({ COMPASSDOCS_CLOUD: "1", OTEL_TRACES_SAMPLER_ARG: "0.05" }), { name: "parentbased_traceidratio", ratio: 0.05 });
    assert.deepEqual(samplerSettings({ OTEL_TRACES_SAMPLER: "always_off" }), { name: "always_off", ratio: 1 });
    assert.deepEqual(samplerSettings({ OTEL_TRACES_SAMPLER: "TraceIdRatio", OTEL_TRACES_SAMPLER_ARG: "0.5" }), { name: "traceidratio", ratio: 0.5 });
    const warnings: string[] = [];
    assert.deepEqual(samplerSettings({ COMPASSDOCS_CLOUD: "1", OTEL_TRACES_SAMPLER: "jaeger_remote", OTEL_TRACES_SAMPLER_ARG: "2" }, warnings), { name: "parentbased_traceidratio", ratio: 0.2 });
    assert.equal(warnings.length, 2);
    assert.equal(telemetryPlan({ COMPASSDOCS_CLOUD: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "http://c" }).sampler.ratio, 0.2);
  });

  test("the flush gets at most FLUSH_MAX_MS, leaves the pool CLOSE_RESERVE_MS, and is never in the past", () => {
    const now = 1_000_000;
    assert.equal(flushDeadline(now + 25_000, now), now + FLUSH_MAX_MS);
    assert.equal(flushDeadline(now + 3_000, now), now + 3_000 - CLOSE_RESERVE_MS);
    assert.equal(flushDeadline(now + 500, now), now + 250);
    assert.equal(flushDeadline(now - 5_000, now), now + 250);
  });
});

describe("what a span may carry (lib/telemetry-redact)", () => {
  const SECRET = "sk-ant-api03-telemetry-test-secret-0123456789";
  const env = { ANTHROPIC_API_KEY: SECRET };

  test("headers, cookies, credentials, query strings, URL passwords, bodies and SQL parameters never leave", async () => {
    const { scrubAttributes } = await import("../src/lib/telemetry-redact");
    const out = scrubAttributes(
      {
        "http.request.header.user-agent": ["Mozilla/5.0"],
        "http.request.header.content-type": ["application/json"],
        "http.request.header.x-request-id": ["req-1234567890"],
        "http.request.header.cookie": ["compass_session=abc"],
        "http.request.header.authorization": ["Bearer abcdefghijkl"],
        "http.response.header.set-cookie": ["compass_session=abc"],
        "http.request.header.x-api-key": ["k"],
        "http.target": "/login?next=%2Fdocs&token=abc",
        "url.full": "https://user:hunter2@graph.microsoft.com/v1.0/users/jane.doe@contoso.com/sendMail?$filter=x#frag",
        "url.query": "?token=abc",
        "url.path": "/v1.0/users/jane.doe%40contoso.com/messages",
        "db.query.text": "SELECT id FROM users WHERE username = $1 AND email = 'someone@example.com'",
        "db.postgresql.values": ["someone@example.com", "hunter2"],
        "db.query.parameter.0": "hunter2",
        "http.request.body": '{"password":"hunter2"}',
        "client.address": "203.0.113.9",
        "enduser.id": "jane",
        "smtp.password": "hunter2",
        "app.note": `key ${SECRET} and Bearer abcdefghijklmnop for bob@example.org`,
        "http.response.status_code": 200,
      },
      env
    );
    assert.deepEqual(Object.keys(out).sort(), [
      "app.note",
      "db.query.text",
      "http.request.header.content-type",
      "http.request.header.user-agent",
      "http.request.header.x-request-id",
      "http.response.status_code",
      "url.full",
      "url.path",
    ]);
    assert.equal(out["url.full"], "https://graph.microsoft.com/v1.0/users/[email]/sendMail");
    assert.equal(out["url.path"], "/v1.0/users/[email]/messages");
    assert.equal(out["db.query.text"], "SELECT id FROM users WHERE username = $1 AND email = '[email]'");
    assert.equal(out["app.note"], "key [redacted] and Bearer [redacted] for [email]");
    const all = JSON.stringify(out);
    for (const s of [SECRET, "hunter2", "abcdefghijkl", "compass_session", "token=", "someone@example.com", "203.0.113.9"]) assert.ok(!all.includes(s), s);
  });

  test("a span's name, status, exceptions and kind: masked, and Next's request span is not a second request", async () => {
    const { scrubSpan } = await import("../src/lib/telemetry-redact");
    const { SpanKind } = await import("@opentelemetry/api");
    const span = {
      name: "GET /people/ann@example.com",
      kind: SpanKind.SERVER,
      spanContext: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }),
      parentSpanContext: { traceId: "a".repeat(32), spanId: "c".repeat(16), traceFlags: 1 },
      startTime: [0, 0],
      endTime: [0, 1],
      status: { code: 2, message: `failed with ${SECRET}` },
      attributes: { "next.span_type": "BaseServer.handleRequest", "http.target": "/x?y=1" },
      links: [],
      events: [{ name: "exception", time: [0, 0], attributes: { "exception.message": `postgres://app:pw-123456@db/x for ann@example.com`, "exception.stacktrace": `Error: ${SECRET}\n at x` } }],
      duration: [0, 1],
      ended: true,
      resource: {} as never,
      instrumentationScope: { name: "next.js" },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    } as unknown as ReadableSpan;
    const out = scrubSpan(span, env, { "microsoft.sample_rate": 20 });
    assert.equal(out.name, "GET /people/[email]");
    assert.equal(out.kind, SpanKind.INTERNAL);
    assert.equal(out.status.message, "failed with [redacted]");
    assert.deepEqual(out.attributes, { "next.span_type": "BaseServer.handleRequest", "microsoft.sample_rate": 20 });
    assert.equal(out.events[0].attributes?.["exception.message"], "postgres://app:[redacted]@db/x for [email]");
    assert.equal(out.events[0].attributes?.["exception.stacktrace"], "Error: [redacted]\n at x");
    assert.equal(out.spanContext().spanId, "b".repeat(16));
    assert.equal(span.name, "GET /people/ann@example.com", "the SDK's own span is not changed");
  });

  test("an exporter that throws is a FAILED result, never an exception in the SDK", async () => {
    const { ScrubbingSpanExporter } = await import("../src/lib/telemetry-redact");
    const throwing = { export: () => { throw new Error("boom"); }, shutdown: async () => {} } as unknown as SpanExporter;
    const results: number[] = [];
    new ScrubbingSpanExporter(throwing).export([], (r) => results.push(r.code));
    assert.deepEqual(results, [1]);
  });

  test("an exporter error is logged once per distinct error, scrubbed", async () => {
    const { onceLogger } = await import("../src/lib/telemetry");
    const lines: Line[] = [];
    const once = onceLogger((level, event, fields) => lines.push({ level, event, fields }), "telemetry.error");
    for (let i = 0; i < 5; i++) once("Telemetry export failed: OTLPExporterError: Service Unavailable (503)");
    once(`Telemetry export failed: connect ECONNREFUSED for ops@example.com`);
    assert.equal(lines.length, 2);
    assert.equal(lines[1].fields.message, "Telemetry export failed: connect ECONNREFUSED for [email]");
  });
});

// --- The running SDK, with in-memory exporters ----------------------------------------------------

type Mod = typeof import("../src/lib/telemetry");
let tel: Mod;
let spans: import("@opentelemetry/sdk-trace-base").InMemorySpanExporter;
let metricsOut: import("@opentelemetry/sdk-metrics").InMemoryMetricExporter;

function plan(ratio = 1, extra: Partial<TelemetryPlan> = {}): TelemetryPlan {
  return { azure: null, otlp: null, traces: true, metrics: true, sampler: { name: "parentbased_traceidratio", ratio }, metricIntervalMs: 60_000, warnings: [], ...extra };
}

async function startWith(ratio: number): Promise<void> {
  await tel.stopTelemetryForTests();
  const { InMemorySpanExporter } = await import("@opentelemetry/sdk-trace-base");
  const { InMemoryMetricExporter, AggregationTemporality } = await import("@opentelemetry/sdk-metrics");
  spans = new InMemorySpanExporter();
  metricsOut = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  await tel.startTelemetry(plan(ratio), log, { spanExporters: [spans], metricExporters: [metricsOut] });
}

async function flushed(): Promise<{ spans: ReadableSpan[]; metrics: ResourceMetrics[] }> {
  const r = tel.runningForTests()!;
  await r.tracerProvider.forceFlush();
  await r.meterProvider.forceFlush();
  return { spans: spans.getFinishedSpans(), metrics: metricsOut.getMetrics() };
}

function points(ms: ResourceMetrics[], name: string): { attributes: Record<string, unknown>; value: unknown }[] {
  const last = ms.at(-1);
  if (!last) return [];
  return last.scopeMetrics.flatMap((s) => s.metrics.filter((m) => m.descriptor.name === name).flatMap((m) => m.dataPoints as { attributes: Record<string, unknown>; value: unknown }[]));
}

/** A server that does what Next does inside a request: writes the route on the request span, starts a child span, logs a line. */
let server: http.Server;
let base = "";
const seenLines: Record<string, unknown>[] = [];

describe("the running SDK", () => {
  before(async () => {
    tel = await import("../src/lib/telemetry");
    assert.ok(sdkLoads().length > 0, "the resolve hook does see the SDK load (so the off-by-default check above means something)");
    await startWith(1);
    server = http.createServer(async (req, res) => {
      const { trace } = await import("@opentelemetry/api");
      const path = (req.url ?? "/").split("?")[0];
      if (path.startsWith("/docs/")) trace.getActiveSpan()?.setAttribute("http.route", "/docs/[slug]");
      const child = trace.getTracer("next.js").startSpan("render route (app) /docs/[slug]");
      seenLines.push(JSON.parse(jsonLine("info", "inside a request", {}, { requestId: "req-abcdefgh" })));
      child.end();
      req.headers["x-request-id"] = "req-abcdefgh"; // as Next's proxy override does
      // A route handler: Next writes the route only on its own request span, which ends after the response.
      const handler = path.startsWith("/api/items/")
        ? trace.getTracer("next.js").startSpan("GET", { attributes: { "next.span_type": "BaseServer.handleRequest" } })
        : null;
      handler?.setAttribute("http.route", "/api/items/[id]");
      res.statusCode = path === "/boom" ? 500 : 200;
      res.end("ok");
      if (handler) void Promise.resolve().then(() => handler.end());
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await tel.stopTelemetryForTests();
  });

  beforeEach(() => {
    spans?.reset();
    seenLines.length = 0;
    resetLifecycleForTests();
  });

  test("a request is one SERVER span named by its route, with the request id and without its path or query", async () => {
    const r = await fetch(`${base}/docs/getting-started?token=secret-token-value&email=ann@example.com`, { headers: { "user-agent": "unit-test", cookie: "compass_session=abc" } });
    assert.equal(r.status, 200);
    await r.text();
    const { spans: out } = await flushed();
    const root = out.find((s) => s.kind === 1);
    assert.ok(root, "a SERVER span");
    assert.equal(root.name, "GET /docs/[slug]");
    assert.equal(root.attributes["http.route"], "/docs/[slug]");
    assert.equal(root.attributes["http.response.status_code"], 200);
    assert.equal(root.attributes["request_id"], "req-abcdefgh");
    assert.equal(root.attributes["user_agent.original"], "unit-test");
    const child = out.find((s) => s.name.startsWith("render route"));
    assert.equal(child?.parentSpanContext?.spanId, root.spanContext().spanId);
    const all = JSON.stringify(out.map((s) => ({ n: s.name, a: s.attributes })));
    for (const s of ["getting-started", "secret-token-value", "ann@example.com", "compass_session"]) assert.ok(!all.includes(s), s);
  });

  test("a route handler's route (on Next's own request span) names the request span too", async () => {
    await (await fetch(`${base}/api/items/4815162342`)).text();
    const { spans: out } = await flushed();
    const root = out.find((s) => s.kind === 1)!;
    assert.equal(root.name, "GET /api/items/[id]");
    assert.equal(root.attributes["http.route"], "/api/items/[id]");
    const next = out.find((s) => s.attributes["next.span_type"] === "BaseServer.handleRequest")!;
    assert.equal(next.kind, 0, "Next's request span is exported as INTERNAL: one request, one SERVER span");
    assert.ok(!JSON.stringify(out.map((s) => [s.name, s.attributes])).includes("4815162342"));
  });

  test("a log line written inside a sampled span carries its trace_id and span_id; outside, none", async () => {
    await (await fetch(`${base}/docs/x`)).text();
    const { spans: out } = await flushed();
    const root = out.find((s) => s.kind === 1)!;
    assert.equal(seenLines[0].trace_id, root.spanContext().traceId);
    assert.equal(seenLines[0].span_id, root.spanContext().spanId);
    const outside = JSON.parse(jsonLine("info", "outside"));
    assert.equal(outside.trace_id, undefined);
    assert.equal(outside.span_id, undefined);
  });

  test("the probes are never traced, nor anything they do", async () => {
    for (const p of ["/healthz", "/readyz", "/readyz/", "/healthz?x=1"]) await (await fetch(`${base}${p}`)).text();
    const { spans: out, metrics: ms } = await flushed();
    assert.deepEqual(out.map((s) => s.name), []);
    assert.equal(seenLines.every((l) => l.trace_id === undefined), true);
    assert.equal(points(ms, "http.server.request.duration").some((p) => /healthz|readyz/.test(JSON.stringify(p.attributes))), false);
  });

  test("a 5xx marks the request span as an error", async () => {
    await (await fetch(`${base}/boom`)).text();
    const { spans: out } = await flushed();
    const root = out.find((s) => s.kind === 1)!;
    assert.equal(root.status.code, 2);
    assert.equal(root.name, "GET");
  });

  test("http.server.request.duration has the route of every request, sampled or not", async () => {
    await startWith(0);
    for (let i = 0; i < 3; i++) await (await fetch(`${base}/docs/unsampled-${i}`)).text();
    await (await fetch(`${base}/api/items/9`)).text();
    const { spans: out, metrics: ms } = await flushed();
    assert.deepEqual(out, [], "nothing exported at ratio 0");
    assert.ok(points(ms, "http.server.request.duration").some((d) => d.attributes["http.route"] === "/api/items/[id]"), "a route handler's route too");
    const p = points(ms, "http.server.request.duration").find((d) => d.attributes["http.route"] === "/docs/[slug]");
    assert.ok(p, "the route is on the metric");
    assert.deepEqual(p.attributes, { "http.request.method": "GET", "http.response.status_code": 200, "http.route": "/docs/[slug]" });
    assert.equal((p.value as { count: number }).count, 3);
    await startWith(1);
  });

  test("a background job is one span named by the job, with its runs and failures counted", async () => {
    const SECRET = "sk-ant-api03-job-secret-0123456789";
    process.env.ANTHROPIC_API_KEY = SECRET;
    try {
      assert.equal(await runJob("digest", async () => 42), 42);
      assert.equal(await runJob("digest", async () => { throw new Error(`could not mail ann@example.com with ${SECRET}`); }), undefined);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    const { spans: out, metrics: ms } = await flushed();
    const jobs = out.filter((s) => s.name === "job digest");
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].attributes["compassdocs.job.name"], "digest");
    assert.equal(jobs[1].status.code, 2);
    const ev = JSON.stringify(jobs[1].events);
    assert.ok(ev.includes("could not mail [email] with [redacted]"), ev);
    assert.ok(!ev.includes(SECRET) && !ev.includes("ann@example.com"));
    assert.equal(points(ms, "compassdocs.job.runs").find((p) => p.attributes["compassdocs.job.name"] === "digest")?.value, 2);
    assert.equal(points(ms, "compassdocs.job.failures").find((p) => p.attributes["compassdocs.job.name"] === "digest")?.value, 1);
  });

  test("mail sent and failed are counted by transport", async () => {
    const hooks = telemetryHooks()!;
    hooks.mail("m365", true);
    hooks.mail("m365", false);
    await hooks.smtp({ host: "smtp.example.test", port: 587 }, async () => "sent");
    await assert.rejects(hooks.smtp({ host: "smtp.example.test", port: 587 }, async () => { throw new Error("421 try later"); }));
    const { spans: out, metrics: ms } = await flushed();
    assert.equal(points(ms, "compassdocs.mail.sent").reduce((n, p) => n + Number(p.value), 0), 2);
    assert.equal(points(ms, "compassdocs.mail.failed").reduce((n, p) => n + Number(p.value), 0), 2);
    const smtp = out.filter((s) => s.name === "smtp send");
    assert.equal(smtp.length, 2);
    assert.equal(smtp[0].attributes["server.address"], "smtp.example.test");
  });

  test("the pool's used, idle and waiting counts, from the pool as it is", async () => {
    const g = globalThis as { __compassPool?: unknown };
    const prev = g.__compassPool;
    g.__compassPool = { totalCount: 4, idleCount: 1, waitingCount: 2 };
    try {
      const { metrics: ms } = await flushed();
      const conn = points(ms, "db.client.connection.count");
      assert.equal(conn.find((p) => p.attributes["db.client.connection.state"] === "used")?.value, 3);
      assert.equal(conn.find((p) => p.attributes["db.client.connection.state"] === "idle")?.value, 1);
      assert.equal(points(ms, "db.client.connection.pending_requests")[0]?.value, 2);
    } finally {
      g.__compassPool = prev;
    }
  });

  test("Postgres: the statement text, never its parameters", { skip: !process.env.DATABASE_URL && "needs DATABASE_URL" }, async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      await runJob("pg-check", async () => {
        await pool.query("SELECT $1::text AS who, $2::text AS secret", ["someone@example.com", "pg-param-secret-value"]);
      });
    } finally {
      await pool.end();
    }
    const { spans: out } = await flushed();
    const job = out.find((s) => s.name === "job pg-check");
    const q = out.find((s) => s.attributes["db.system.name"] === "postgresql" || s.attributes["db.system"] === "postgresql");
    assert.ok(q, `a pg span among ${out.map((s) => s.name).join(", ")}`);
    assert.equal(q.parentSpanContext?.spanId, job?.spanContext().spanId);
    assert.equal(q.attributes["db.query.text"] ?? q.attributes["db.statement"], "SELECT $1::text AS who, $2::text AS secret");
    const all = JSON.stringify(out.map((s) => s.attributes));
    assert.ok(!all.includes("someone@example.com") && !all.includes("pg-param-secret-value"), all);
  });
});

describe("the flush on SIGTERM (lib/shutdown appClose)", () => {
  after(async () => {
    await Promise.race([tel.stopTelemetryForTests(), new Promise((r) => setTimeout(r, 3000))]);
  });

  test("an exporter that never answers: the flush is given up on, the pool still closes, before the deadline", async () => {
    await tel.stopTelemetryForTests();
    resetLifecycleForTests();
    process.env.OTEL_BSP_EXPORT_TIMEOUT = "1500";
    const hang = { export: () => {}, shutdown: () => new Promise<void>(() => {}), forceFlush: () => new Promise<void>(() => {}) } as unknown as SpanExporter;
    const hangMetrics = { export: () => {}, shutdown: () => new Promise<void>(() => {}), forceFlush: () => new Promise<void>(() => {}) } as unknown as PushMetricExporter;
    await tel.startTelemetry(plan(1, { metricIntervalMs: 1_500 }), log, { spanExporters: [hang], metricExporters: [hangMetrics] });
    delete process.env.OTEL_BSP_EXPORT_TIMEOUT;
    await runJob("before-shutdown", async () => {});
    let poolClosedAt = 0;
    onClose("database-pool", () => {
      poolClosedAt = Date.now();
    });
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
    const t0 = Date.now();
    let result;
    try {
      result = await appClose(t0 + 2_000);
    } finally {
      console.warn = warn;
    }
    const took = Date.now() - t0;
    assert.ok(took < 2_000, `appClose took ${took} ms`);
    assert.ok(poolClosedAt > 0, "the pool closed");
    assert.ok(poolClosedAt - t0 >= 2_000 - CLOSE_RESERVE_MS - 50, "after the flush was given up on");
    assert.deepEqual(result, { clean: true, pending: [] }, "a flush cut short is not unfinished work");
    assert.deepEqual(warned, ["[shutdown] telemetry: not flushed in time, exiting without it."]);
  });
});
