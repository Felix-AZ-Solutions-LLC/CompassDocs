import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { ADMIN } from "./helpers";

// Telemetry (1.21.1, lib/telemetry): a cloud-mode server from the standalone
// build, started the way the image starts it (start.cjs), exports to a tiny
// OTLP/HTTP receiver in this test (OTEL_EXPORTER_OTLP_ENDPOINT, http/json).
//
//   - a page request arrives as one SERVER span named by its route, an API
//     request with an id by its route template, and the sign-in's Postgres
//     query as a span with its statement text and no parameter values;
//   - the probes are in no payload; no secret, password or email address is
//     in any payload, traces or metrics;
//   - a log line written inside a request carries that request's trace_id;
//   - on SIGTERM the metrics are flushed (the request duration by route, the
//     pool's counts) and the process exits 0;
//   - a collector that answers 500 is logged once per distinct error, a
//     malformed Application Insights connection string is one warning and
//     not fatal, and a collector that hangs never holds up the exit.
//
// The suite's own server runs with no telemetry variables: telemetry off, no
// SDK loaded (test/telemetry.test.ts proves that part).

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "scripts", "start.cjs");
const SERVER_JS = path.join(ROOT, ".next", "standalone", "server.js");
const PORT = 3995;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET_KEY = randomBytes(32).toString("hex");
const AI_KEY = "sk-ant-telemetry-e2e-0123456789abcdef";
const SMTP_PASSWORD = "telemetry-relay-password-0123";
const SIGNIN_EMAIL = "ann.telemetry@example.com";
const SIGNIN_PASSWORD = "Telemetry!Password-0123";
const QUERY_EMAIL = "query.person@example.org";
const WORKSPACE = "ws-e2e-telemetry";

// --- The receiver ---------------------------------------------------------------------

interface Receiver {
  url: string;
  bodies: { path: string; raw: string }[];
  mode: "ok" | "fail" | "hang";
  close(): Promise<void>;
}

async function receiver(): Promise<Receiver> {
  const r: Receiver = { url: "", bodies: [], mode: "ok", close: async () => {} };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (r.mode === "hang") return; // never answers
      r.bodies.push({ path: req.url ?? "", raw: Buffer.concat(chunks).toString("utf8") });
      if (r.mode === "fail") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"message":"collector is down"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  r.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  r.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return r;
}

// --- OTLP/JSON ---------------------------------------------------------------------------

type AnyValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean; arrayValue?: { values: AnyValue[] } };
type KeyValue = { key: string; value: AnyValue };
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  attributes?: KeyValue[];
}

function value(v: AnyValue | undefined): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue) return v.arrayValue.values.map(value);
  return undefined;
}

function attrs(kv: KeyValue[] | undefined): Record<string, unknown> {
  return Object.fromEntries((kv ?? []).map((a) => [a.key, value(a.value)]));
}

function traces(r: Receiver): { resource: Record<string, unknown>; span: OtlpSpan; a: Record<string, unknown> }[] {
  return r.bodies
    .filter((b) => b.path === "/v1/traces")
    .flatMap((b) => {
      const body = JSON.parse(b.raw) as { resourceSpans: { resource: { attributes: KeyValue[] }; scopeSpans: { spans: OtlpSpan[] }[] }[] };
      return body.resourceSpans.flatMap((rs) =>
        rs.scopeSpans.flatMap((ss) => ss.spans.map((span) => ({ resource: attrs(rs.resource.attributes), span, a: attrs(span.attributes) })))
      );
    });
}

interface Point {
  metric: string;
  a: Record<string, unknown>;
  raw: Record<string, unknown>;
}

function metricPoints(r: Receiver): Point[] {
  return r.bodies
    .filter((b) => b.path === "/v1/metrics")
    .flatMap((b) => {
      const body = JSON.parse(b.raw) as {
        resourceMetrics: { scopeMetrics: { metrics: ({ name: string } & Record<string, { dataPoints?: ({ attributes?: KeyValue[] } & Record<string, unknown>)[] }>)[] }[] }[];
      };
      return body.resourceMetrics.flatMap((rm) =>
        rm.scopeMetrics.flatMap((sm) =>
          sm.metrics.flatMap((m) => {
            const data = (m.histogram ?? m.sum ?? m.gauge) as { dataPoints?: ({ attributes?: KeyValue[] } & Record<string, unknown>)[] } | undefined;
            return (data?.dataPoints ?? []).map((p) => ({ metric: m.name, a: attrs(p.attributes), raw: p }));
          })
        )
      );
    });
}

const SERVER = 2; // OTLP SPAN_KIND_SERVER

// --- The server under test ---------------------------------------------------------------

interface Server {
  proc: ChildProcess;
  out: string[];
  exited: Promise<number | null>;
}

const DB = "compass_e2e_otel";

function dbUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is not set");
  const u = new URL(base);
  u.pathname = `/${DB}`;
  return u.toString();
}

async function resetDb(): Promise<void> {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB}`);
  } finally {
    await admin.end();
  }
}

function start(otlp: string, extra: Record<string, string> = {}): Server {
  const out: string[] = [];
  const proc = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(PORT),
      COMPASSDOCS_SERVER_JS: SERVER_JS,
      COMPASSDOCS_CLOUD: "1",
      COMPASSDOCS_SECRET_KEY: SECRET_KEY,
      COMPASSDOCS_BASE_URL: `http://localhost:${PORT}`,
      COMPASSDOCS_WORKSPACE_ID: WORKSPACE,
      DATABASE_URL: dbUrl(),
      COMPASSDOCS_ADMIN_USER: ADMIN.username,
      COMPASSDOCS_ADMIN_PASSWORD: ADMIN.password,
      COMPASSDOCS_UPLOAD_DIR: mkdtempSync(path.join(tmpdir(), "otel-e2e-uploads-")),
      ANTHROPIC_API_KEY: AI_KEY,
      COMPASSDOCS_SMTP_HOST: "smtp.platform.test",
      COMPASSDOCS_SMTP_PASSWORD: SMTP_PASSWORD,
      COMPASSDOCS_SMTP_FROM: "CompassDocs <no-reply@acme.compassdocs.test>",
      OTEL_EXPORTER_OTLP_ENDPOINT: otlp,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      // Cloud mode keeps one trace in five; this test wants them all.
      OTEL_TRACES_SAMPLER_ARG: "1",
      OTEL_BSP_SCHEDULE_DELAY: "200",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=e2e",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let partial = "";
  const collect = (chunk: Buffer) => {
    partial += chunk.toString();
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    out.push(...lines.filter((l) => l.trim()));
  };
  proc.stdout!.on("data", collect);
  proc.stderr!.on("data", collect);
  const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));
  return { proc, out, exited };
}

async function waitReady(server: Server, ms = 120_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (server.proc.exitCode !== null) throw new Error(`server exited ${server.proc.exitCode}:\n${server.out.join("\n")}`);
    try {
      const r = await fetch(`${BASE}/readyz`);
      if (r.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the server never became ready:\n${server.out.join("\n")}`);
}

function lines(server: Server): Record<string, unknown>[] {
  return server.out.flatMap((l) => {
    try {
      return [JSON.parse(l) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

async function stop(server: Server | undefined): Promise<void> {
  if (server && server.proc.exitCode === null) {
    server.proc.kill("SIGKILL");
    await server.exited;
  }
}

test.describe.serial("telemetry to an OTLP collector", () => {
  test.skip(!existsSync(SERVER_JS), "needs the standalone build (npm run build)");

  let rx: Receiver;
  let server: Server;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    await resetDb();
    rx = await receiver();
    server = start(rx.url);
    await waitReady(server);
  });

  test.afterAll(async () => {
    await stop(server);
    await rx?.close();
  });

  test("a page, an API route with an id and the sign-in's query arrive as spans named by route, with no parameters", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await fetch(`${BASE}/healthz`)).ok).toBe(true);
      expect((await fetch(`${BASE}/readyz`)).ok).toBe(true);
    }
    const page = await fetch(`${BASE}/login?next=%2Fdesk&email=${encodeURIComponent(QUERY_EMAIL)}`, { headers: { cookie: "compass_session=not-a-session" } });
    expect(page.status).toBe(200);
    await page.text();
    const api = await fetch(`${BASE}/api/v1/documents/4815162342`, { headers: { authorization: "Bearer cd_not_a_real_token_0123456789" } });
    expect(api.status).toBeGreaterThanOrEqual(400);
    await api.text();
    const signIn = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: SIGNIN_EMAIL, password: SIGNIN_PASSWORD }),
    });
    expect(signIn.status).toBe(401);
    await signIn.text();

    await expect
      .poll(() => traces(rx).filter((t) => t.span.kind === SERVER).map((t) => t.span.name), { timeout: 20_000 })
      .toEqual(expect.arrayContaining(["GET /login", "GET /api/v1/documents/[id]", "POST /api/auth/login"]));

    const all = traces(rx);
    const loginPage = all.find((t) => t.span.kind === SERVER && t.span.name === "GET /login")!;
    expect(loginPage.a["http.route"]).toBe("/login");
    expect(loginPage.a["http.response.status_code"]).toBe(200);
    expect(loginPage.span.parentSpanId || "").toBe("");
    expect(loginPage.resource["service.name"]).toBe("compassdocs");
    expect(loginPage.resource["service.version"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(loginPage.resource["compassdocs.workspace.id"]).toBe(WORKSPACE);
    expect(loginPage.resource["deployment.environment.name"]).toBe("e2e");
    // Next's own spans sit under the request span, in its trace.
    expect(all.filter((t) => t.span.traceId === loginPage.span.traceId && t.span.parentSpanId).length).toBeGreaterThan(0);
    // One request, one SERVER span.
    expect(all.filter((t) => t.span.traceId === loginPage.span.traceId && t.span.kind === SERVER)).toHaveLength(1);

    const apiSpan = all.find((t) => t.span.kind === SERVER && t.span.name === "GET /api/v1/documents/[id]")!;
    expect(apiSpan.a["http.route"]).toBe("/api/v1/documents/[id]");

    const signInSpan = all.find((t) => t.span.kind === SERVER && t.span.name === "POST /api/auth/login")!;
    expect(signInSpan.a["http.response.status_code"]).toBe(401);
    const queries = all.filter((t) => t.span.traceId === signInSpan.span.traceId && (t.a["db.system.name"] === "postgresql" || t.a["db.system"] === "postgresql"));
    expect(queries.length, "the sign-in's Postgres queries").toBeGreaterThan(0);
    for (const q of queries) {
      const text = String(q.a["db.query.text"] ?? q.a["db.statement"] ?? "");
      expect(text.length).toBeGreaterThan(0);
      expect(Object.keys(q.a).some((k) => k.startsWith("db.query.parameter.") || k === "db.postgresql.values")).toBe(false);
    }
    expect(queries.some((q) => /\$1/.test(String(q.a["db.query.text"] ?? q.a["db.statement"])))).toBe(true);
  });

  test("a log line written inside a request carries that request's trace_id", async () => {
    // An unknown Server Action: Next logs "Failed to find Server Action" from inside the request.
    const r = await fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "next-action": "00".repeat(21), "content-type": "text/plain;charset=UTF-8" },
      body: "[]",
    });
    await r.text();
    await expect.poll(() => lines(server).filter((l) => typeof l.trace_id === "string").length, { timeout: 20_000 }).toBeGreaterThan(0);
    const ids = new Set(traces(rx).map((t) => t.span.traceId));
    await expect.poll(() => {
      const known = new Set(traces(rx).map((t) => t.span.traceId));
      return lines(server).filter((l) => typeof l.trace_id === "string").some((l) => known.has(String(l.trace_id)));
    }, { timeout: 20_000 }).toBe(true);
    for (const l of lines(server).filter((x) => typeof x.trace_id === "string")) {
      expect(String(l.trace_id)).toMatch(/^[0-9a-f]{32}$/);
      expect(String(l.span_id)).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(ids.size).toBeGreaterThan(0);
  });

  test("SIGTERM flushes the metrics (request duration by route, the pool) and exits 0; no probe, secret or email in any payload", async () => {
    test.setTimeout(60_000);
    server.proc.kill("SIGTERM");
    expect(await server.exited).toBe(0);

    const points = metricPoints(rx);
    const durations = points.filter((p) => p.metric === "http.server.request.duration");
    expect(durations.find((p) => p.a["http.route"] === "/login" && p.a["http.request.method"] === "GET")).toBeTruthy();
    expect(durations.find((p) => p.a["http.route"] === "/api/v1/documents/[id]")).toBeTruthy();
    const conns = points.filter((p) => p.metric === "db.client.connection.count");
    expect(conns.map((p) => p.a["db.client.connection.state"]).sort()).toEqual(expect.arrayContaining(["idle", "used"]));
    expect(points.some((p) => p.metric === "db.client.connection.pending_requests")).toBe(true);
    // Only the app's own metrics: the instrumentations' are dropped.
    for (const p of points) expect(["http.server.request.duration", "db.client.connection.count", "db.client.connection.pending_requests", "compassdocs.job.runs", "compassdocs.job.failures", "compassdocs.mail.sent", "compassdocs.mail.failed"]).toContain(p.metric);

    const payloads = rx.bodies.map((b) => b.raw).join("\n");
    expect(payloads.length).toBeGreaterThan(0);
    for (const s of [SECRET_KEY, AI_KEY, SMTP_PASSWORD, SIGNIN_PASSWORD, ADMIN.password, SIGNIN_EMAIL, QUERY_EMAIL, "not-a-session", "cd_not_a_real_token", "next=%2Fdesk", "/healthz", "/readyz", "4815162342"]) {
      expect(payloads, `"${s}" in a telemetry payload`).not.toContain(s);
    }
    expect(payloads).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/);

    const ls = lines(server);
    const started = ls.filter((l) => l.event === "telemetry.started");
    expect(started).toHaveLength(1);
    expect(String(started[0].message)).toMatch(/^Telemetry on: traces and metrics to an OTLP collector \(127\.0\.0\.1:\d+, http\/json\), sampling 100% of traces\. Logs are not exported\.$/);
    expect(ls.filter((l) => l.event === "telemetry.error")).toEqual([]);
    expect(String(ls.at(-1)?.message)).toMatch(/^Stopped cleanly in \d+ ms/);
  });
});

test.describe.serial("telemetry when the collector fails or hangs", () => {
  test.skip(!existsSync(SERVER_JS), "needs the standalone build (npm run build)");

  let rx: Receiver;
  let server: Server;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    await resetDb();
    rx = await receiver();
    rx.mode = "fail";
    server = start(rx.url, {
      // Malformed: one warning, and OTLP export carries on.
      APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=not-a-guid;IngestionEndpoint=https://example.invalid/",
      COMPASSDOCS_SHUTDOWN_TIMEOUT: "8",
    });
    await waitReady(server);
  });

  test.afterAll(async () => {
    await stop(server);
    await rx?.close();
  });

  test("a malformed connection string is one warning; a collector answering 500 is logged once, however many batches fail", async () => {
    for (let i = 0; i < 6; i++) {
      await (await fetch(`${BASE}/login`)).text();
      await new Promise((r) => setTimeout(r, 400));
    }
    await expect.poll(() => rx.bodies.filter((b) => b.path === "/v1/traces").length, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
    const ls = lines(server);
    const config = ls.filter((l) => l.event === "telemetry.config");
    expect(config).toHaveLength(1);
    expect(String(config[0].message)).toMatch(/^APPLICATIONINSIGHTS_CONNECTION_STRING is set but malformed \(its InstrumentationKey is not a GUID\): running without Application Insights\.$/);
    expect(ls.filter((l) => l.event === "telemetry.started")).toHaveLength(1);
    const errors = ls.filter((l) => l.event === "telemetry.error").map((l) => String(l.message));
    expect(errors.length).toBeGreaterThan(0);
    expect(new Set(errors).size, errors.join("\n")).toBe(errors.length);
    expect(errors.length).toBeLessThanOrEqual(3);
  });

  test("a collector that hangs: SIGTERM still exits 0, inside the shutdown deadline", async () => {
    test.setTimeout(60_000);
    rx.mode = "hang";
    await (await fetch(`${BASE}/login`)).text();
    await new Promise((r) => setTimeout(r, 500));
    const t0 = Date.now();
    server.proc.kill("SIGTERM");
    expect(await server.exited).toBe(0);
    const took = Date.now() - t0;
    expect(took).toBeLessThan(8_000);
    const ls = lines(server);
    expect(ls.some((l) => /telemetry: not flushed in time, exiting without it\./.test(String(l.message)))).toBe(true);
    expect(String(ls.at(-1)?.message)).toMatch(/^Stopped cleanly in \d+ ms/);
  });
});
