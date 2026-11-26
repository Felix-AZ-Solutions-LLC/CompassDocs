// Telemetry switches (1.21.1): OpenTelemetry traces and metrics, off unless
// an exporter is configured.
//
//   APPLICATIONINSIGHTS_CONNECTION_STRING  Azure Monitor (Application Insights)
//   OTEL_EXPORTER_OTLP_ENDPOINT            any OTLP/HTTP collector
//   OTEL_SDK_DISABLED=true                 off, whatever else is set
//
// Both work in either mode; with both set, both receive the same data. With
// neither, instrumentation.ts stops here: this module imports nothing from
// OpenTelemetry, and lib/telemetry (the SDK, the instrumentations and the
// exporters) is loaded only by startTelemetryIfConfigured, with a dynamic
// import, once one of them is set. test/telemetry.test.ts proves it.
//
// Logs are never exported: stdout already reaches the platform's log store
// (lib/log), so sending them again would only double the ingest cost.
//
// The rest of the app reaches the running SDK through lib/telemetry-hooks,
// never through this module: only instrumentation.ts imports it, so only
// its bundle can reach lib/telemetry (and the build traces the SDK's files
// for that one entry, not for every route).
//
// No "server-only" marker: pure functions that the tests read too.

import { isCloud, type Env } from "./cloud";

/** The platform's probes: never traced (they run every few seconds), never in the request metric. */
export const PROBE_PATH = /^\/(?:healthz|readyz)\/?$/;

/** Is this request path (no query) one of the probes? */
export function isProbePath(path: string): boolean {
  return PROBE_PATH.test(path);
}

// --- Application Insights connection string ----------------------------------------

export type ConnectionString =
  | { ok: true; instrumentationKey: string; ingestionHost: string }
  | { ok: false; reason: string };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An Application Insights connection string, "InstrumentationKey=<guid>;
 * IngestionEndpoint=https://…;…", checked the way the exporter would refuse
 * it, so a malformed one costs one warning instead of an exception. The
 * reason never repeats the value.
 */
export function parseConnectionString(raw: string): ConnectionString {
  const fields = new Map<string, string>();
  for (const part of raw.split(";")) {
    if (!part.trim()) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) return { ok: false, reason: "it is not a list of key=value pairs separated by semicolons" };
    fields.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  const ikey = fields.get("instrumentationkey");
  if (!ikey) return { ok: false, reason: "it has no InstrumentationKey" };
  if (!GUID.test(ikey)) return { ok: false, reason: "its InstrumentationKey is not a GUID" };
  let ingestionHost = "dc.services.visualstudio.com";
  const endpoint = fields.get("ingestionendpoint");
  if (endpoint) {
    let u: URL;
    try {
      u = new URL(endpoint);
    } catch {
      return { ok: false, reason: "its IngestionEndpoint is not a URL" };
    }
    if (u.protocol !== "https:") return { ok: false, reason: "its IngestionEndpoint is not an https:// address" };
    ingestionHost = u.host;
  }
  return { ok: true, instrumentationKey: ikey, ingestionHost };
}

// --- Sampling ---------------------------------------------------------------------------

export type SamplerName =
  | "always_on"
  | "always_off"
  | "traceidratio"
  | "parentbased_always_on"
  | "parentbased_always_off"
  | "parentbased_traceidratio";

const SAMPLERS: readonly SamplerName[] = [
  "always_on",
  "always_off",
  "traceidratio",
  "parentbased_always_on",
  "parentbased_always_off",
  "parentbased_traceidratio",
];

export interface SamplerSettings {
  name: SamplerName;
  /** For the ratio samplers: the share of traces kept, 0 to 1. */
  ratio: number;
}

/**
 * Parent-based trace-id ratio: every trace when self-hosted, one in five in
 * cloud mode (a workspace's probes and page loads add up across a fleet).
 * OTEL_TRACES_SAMPLER and OTEL_TRACES_SAMPLER_ARG override it, as in any
 * OpenTelemetry SDK. Problems with them are warnings and keep the default.
 */
export function samplerSettings(env: Env = process.env, warnings: string[] = []): SamplerSettings {
  const fallbackRatio = isCloud(env) ? 0.2 : 1;
  const rawName = env.OTEL_TRACES_SAMPLER?.trim().toLowerCase();
  let name: SamplerName = "parentbased_traceidratio";
  if (rawName) {
    if ((SAMPLERS as readonly string[]).includes(rawName)) name = rawName as SamplerName;
    else warnings.push(`OTEL_TRACES_SAMPLER=${rawName.slice(0, 40)} is not one this build supports (${SAMPLERS.join(", ")}): using parentbased_traceidratio.`);
  }
  let ratio = fallbackRatio;
  const rawArg = env.OTEL_TRACES_SAMPLER_ARG?.trim();
  if (rawArg && name.endsWith("traceidratio")) {
    const n = Number(rawArg);
    if (Number.isFinite(n) && n >= 0 && n <= 1) ratio = n;
    else warnings.push(`OTEL_TRACES_SAMPLER_ARG=${rawArg.slice(0, 40)} is not a number from 0 to 1: sampling ${fallbackRatio}.`);
  }
  return { name, ratio };
}

// --- The plan -----------------------------------------------------------------------------

export type OtlpProtocol = "http/protobuf" | "http/json";

export interface TelemetryPlan {
  /** Application Insights, when its connection string is set and well-formed. */
  azure: { connectionString: string; ingestionHost: string } | null;
  /** An OTLP/HTTP collector, when OTEL_EXPORTER_OTLP_ENDPOINT is set and a URL. */
  otlp: { endpoint: string; host: string; protocol: OtlpProtocol } | null;
  /** Traces exported (OTEL_TRACES_EXPORTER=none turns them off). */
  traces: boolean;
  /** Metrics exported (OTEL_METRICS_EXPORTER=none turns them off). */
  metrics: boolean;
  sampler: SamplerSettings;
  /** Metric export interval (OTEL_METRIC_EXPORT_INTERVAL, 60 s by default). */
  metricIntervalMs: number;
  /** One sentence each, for the log: a setting that was ignored, and why. */
  warnings: string[];
}

function disabled(v: string | undefined): boolean {
  return v?.trim().toLowerCase() === "true";
}

/** What telemetry would run with this environment. Never throws. */
export function telemetryPlan(env: Env = process.env): TelemetryPlan {
  const warnings: string[] = [];
  const plan: TelemetryPlan = {
    azure: null,
    otlp: null,
    traces: env.OTEL_TRACES_EXPORTER?.trim().toLowerCase() !== "none",
    metrics: env.OTEL_METRICS_EXPORTER?.trim().toLowerCase() !== "none",
    sampler: { name: "parentbased_traceidratio", ratio: 1 },
    metricIntervalMs: 60_000,
    warnings,
  };
  if (disabled(env.OTEL_SDK_DISABLED)) return plan;

  const cs = env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim();
  if (cs) {
    const parsed = parseConnectionString(cs);
    if (parsed.ok) plan.azure = { connectionString: cs, ingestionHost: parsed.ingestionHost };
    else warnings.push(`APPLICATIONINSIGHTS_CONNECTION_STRING is set but malformed (${parsed.reason}): running without Application Insights.`);
  }

  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (endpoint) {
    let u: URL | null = null;
    try {
      u = new URL(endpoint);
    } catch {
      /* below */
    }
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) {
      warnings.push("OTEL_EXPORTER_OTLP_ENDPOINT is not an http:// or https:// URL: running without OTLP export.");
    } else {
      const raw = env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim().toLowerCase();
      let protocol: OtlpProtocol = "http/protobuf";
      if (raw === "http/json") protocol = "http/json";
      else if (raw && raw !== "http/protobuf") warnings.push(`OTEL_EXPORTER_OTLP_PROTOCOL=${raw.slice(0, 20)} is not supported (http/protobuf or http/json): using http/protobuf.`);
      plan.otlp = { endpoint, host: u.host, protocol };
    }
  }

  if (plan.azure || plan.otlp) {
    plan.sampler = samplerSettings(env, warnings);
    const interval = Number(env.OTEL_METRIC_EXPORT_INTERVAL);
    if (Number.isFinite(interval) && interval >= 1000) plan.metricIntervalMs = interval;
  }
  return plan;
}

/** Will telemetry start? An exporter is configured, and not everything is turned off. */
export function telemetryEnabled(plan: TelemetryPlan): boolean {
  return !!(plan.azure || plan.otlp) && (plan.traces || plan.metrics);
}

type Log = (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => void;

/**
 * instrumentation.ts, first thing: start telemetry if it is configured.
 * Without an exporter it returns false having loaded nothing. A problem
 * (a malformed connection string, the SDK failing to start) is a warning and
 * the app runs without telemetry: it never stops the server.
 */
export async function startTelemetryIfConfigured(log: Log, env: Env = process.env): Promise<boolean> {
  const plan = telemetryPlan(env);
  for (const message of plan.warnings) log("warn", "telemetry.config", { message });
  if (!telemetryEnabled(plan)) return false;
  try {
    const { startTelemetry } = await import("./telemetry");
    await startTelemetry(plan, log);
    return true;
  } catch (e) {
    log("warn", "telemetry.config", { message: `Telemetry could not start, running without it: ${e instanceof Error ? e.message : String(e)}` });
    return false;
  }
}
