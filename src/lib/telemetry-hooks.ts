// The running SDK's hooks for the rest of the app (1.21.1): lib/shutdown's
// background jobs, lib/log's trace ids and the mailers call these. Undefined
// while telemetry is off, so each call is one property read.
//
// Deliberately apart from lib/telemetry-config: this module imports nothing
// and never loads lib/telemetry, so the routes that use it (through lib/log,
// lib/shutdown, lib/mailer) carry no reference to the SDK. lib/telemetry
// installs the hooks on globalThis when it starts.
//
// No "server-only" marker: it holds no secrets and the tests read it.

/** What the running SDK offers the app (lib/telemetry installs it on globalThis). */
export interface TelemetryHooks {
  /** The active span's ids, while a sampled span is active (lib/log). */
  traceIds(): { trace_id: string; span_id: string } | null;
  /** One span per run of a background job, and its run/failure counts (lib/shutdown runJob). */
  job<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** A span around one SMTP send, and the mail counts (lib/mailer). */
  smtp<T>(server: { host: string; port: number }, fn: () => Promise<T>): Promise<T>;
  /** Count one mail handed to Microsoft 365 (sent) or refused (failed). */
  mail(transport: "smtp" | "m365", ok: boolean): void;
  /** 1.21.2 (lib/db-retry): a database outage began. */
  dbOutage?(): void;
  /** 1.21.2 (lib/db-retry): a request that waited for the database got it, or gave up. */
  dbRetry?(outcome: "recovered" | "gave_up"): void;
}

const G = globalThis as unknown as { __compassTelemetry?: TelemetryHooks };

/** The running SDK's hooks, or undefined when telemetry is off. */
export function telemetryHooks(): TelemetryHooks | undefined {
  return G.__compassTelemetry;
}

/** Count one mail by outcome, when telemetry is on. Never throws. */
export function countMail(transport: "smtp" | "m365", ok: boolean): void {
  try {
    G.__compassTelemetry?.mail(transport, ok);
  } catch {
    /* telemetry never breaks a send */
  }
}
