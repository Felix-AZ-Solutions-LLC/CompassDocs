// Usage to the console (1.22.0): the daily counts of a CompassDocs Cloud
// workspace with a plan, sent to the console that issues its licence. The
// contract is in README "Usage to the console"; in short:
//
//   POST <COMPASSDOCS_USAGE_URL, else COMPASSDOCS_LICENSE_URL with its last
//         path segment replaced by "usage"> (lib/cloud usageReportUrl)
//   Authorization: Bearer <the licence request's credential>
//   Content-Type: application/json
//   Idempotency-Key: usage:<workspace>:<day>
//   X-CompassDocs-Workspace: COMPASSDOCS_WORKSPACE_ID
//   body: UsageReport (counts only: no names, emails or content)
//
// One report per UTC day, oldest first; a day is sent again whenever it was
// counted again (the console keeps the newest countedAt for a workspace and
// day). Limited like the licence request: FETCH_TIMEOUT_MS in all, a small
// body each way, no redirect followed, one request at a time. A failure
// stops the run and backs off (1 minute doubling to an hour, or the
// console's Retry-After); a refusal of the body itself (400, 409, 413, 422)
// is not retried until the day is counted again.
//
// Self-hosted, without a plan, or without COMPASSDOCS_LICENSE_URL, nothing
// here runs. Server-only.

import "server-only";
import pkg from "../../package.json";
import { licensePullConfig, usageReportUrl, type LicensePullConfig } from "./cloud";
import { hq } from "./helpdesk/db-core";
import type { PlanState } from "./plan";
import { AI_FEATURES, dayKey, type AiFeature } from "./plan-shared";
import type { DailyRow } from "./plan-usage";

export const REPORT_SCHEMA = 1;
export const FETCH_TIMEOUT_MS = 15_000;
/** The largest body sent (a report is about 600 bytes). */
export const MAX_REQUEST_BYTES = 8 * 1024;
/** The most of the console's answer read (then discarded). */
export const MAX_RESPONSE_BYTES = 4 * 1024;
export const BACKOFF_MIN_MS = 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;
/** Days further back than this are not sent (the console has them, or never will). */
export const REPORT_BACKLOG_DAYS = 35;
/** The endpoint isn't there (404): asked again after this long. */
export const MISSING_RETRY_MS = 6 * 60 * 60_000;
const RETRY_AFTER_MIN_MS = 60_000;
const RETRY_AFTER_MAX_MS = 6 * 60 * 60_000;

/** The body: counts only. Every field is a number, a date, an id, a plan name or the app version. */
export interface UsageReport {
  schema: 1;
  /** COMPASSDOCS_WORKSPACE_ID. */
  workspace: string;
  /** The UTC day counted (YYYY-MM-DD). */
  day: string;
  /** When it was counted (ISO 8601, UTC); the console keeps the newest per workspace and day. */
  countedAt: string;
  appVersion: string;
  /** The licence in force's id, and its plan's name. */
  licenseId: string | null;
  plan: string;
  /** People with a desk role on the day. */
  agents: number;
  /** Distinct people who signed in this calendar month (UTC) up to the end of the day. */
  activeUsers: number;
  /** What counts (Decision 4), in bytes, and by area. */
  storageBytes: number;
  storage: { files: number; documents: number; helpdesk: number };
  /** AI at cost this calendar month (UTC) up to the end of the day, in US dollars, by feature. */
  aiUsd: { total: number } & Record<AiFeature, number>;
  /** Set when the licence in force names another workspace (design F): the workspace it names. */
  licenseMismatch: { licenseWorkspace: string } | null;
}

/** Pure: a day's report. Only counts, ids and names of things, never a person or content. */
export function buildReport(row: Pick<DailyRow, "day" | "counted_at" | "plan" | "agents" | "active_users" | "storage_bytes" | "storage" | "ai_usd" | "ai">, ctx: { workspace: string; licenseId: string | null; mismatch: string | null }): UsageReport {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
  const r6 = (v: unknown) => Math.round(n(v) * 1_000_000) / 1_000_000;
  const ai = Object.fromEntries(AI_FEATURES.map((f) => [f, r6(row.ai?.[f])])) as Record<AiFeature, number>;
  const areas = (row.storage as { areas?: Record<string, unknown> } | undefined)?.areas ?? {};
  return {
    schema: REPORT_SCHEMA,
    workspace: ctx.workspace,
    day: String(row.day).slice(0, 10),
    countedAt: new Date(row.counted_at).toISOString(),
    appVersion: pkg.version,
    licenseId: ctx.licenseId ? String(ctx.licenseId).slice(0, 100) : null,
    plan: String(row.plan).slice(0, 20),
    agents: Math.trunc(n(row.agents)),
    activeUsers: Math.trunc(n(row.active_users)),
    storageBytes: Math.trunc(n(row.storage_bytes)),
    storage: { files: Math.trunc(n(areas.files)), documents: Math.trunc(n(areas.documents)), helpdesk: Math.trunc(n(areas.helpdesk)) },
    aiUsd: { total: r6(row.ai_usd), ...ai },
    licenseMismatch: ctx.mismatch ? { licenseWorkspace: ctx.mismatch.slice(0, 64) } : null,
  };
}

/** The key the console upserts on: one row per workspace and day. */
export function idempotencyKey(r: Pick<UsageReport, "workspace" | "day">): string {
  return `usage:${r.workspace}:${r.day}`;
}

export type SendOutcome =
  /** 2xx: the console has it. */
  | { kind: "stored"; status: number }
  /** 400, 409, 413, 422: it refused this body; not sent again until the day is counted again. */
  | { kind: "refused"; status: number; message: string }
  /** 401, 403. */
  | { kind: "unauthorized"; status: number }
  /** 404: the console takes no usage (yet). */
  | { kind: "missing"; status: number }
  /** No answer, a timeout, 429 or 5xx. */
  | { kind: "unreachable"; message: string; retryAfterMs?: number }
  /** Anything else (a redirect, another status). */
  | { kind: "error"; message: string };

function retryAfter(h: string | null, now: number): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(h) - now;
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, ms));
}

async function drain(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One POST of one day's report, by the contract above. Never throws. */
export async function sendUsageReport(
  url: URL,
  credential: string,
  report: UsageReport,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: number } = {}
): Promise<SendOutcome> {
  const body = JSON.stringify(report);
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) return { kind: "error", message: "The usage report is larger than it may be; it was not sent." };
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Idempotency-Key": idempotencyKey(report),
        "User-Agent": `CompassDocs/${pkg.version}`,
        "X-CompassDocs-Workspace": report.workspace,
        "X-CompassDocs-Version": pkg.version,
      },
      body,
    });
    const text = await drain(res).catch(() => "");
    const s = res.status;
    if (s >= 200 && s < 300) return { kind: "stored", status: s };
    if (s === 401 || s === 403) return { kind: "unauthorized", status: s };
    if (s === 404) return { kind: "missing", status: s };
    if (s === 400 || s === 409 || s === 413 || s === 422) {
      let why = "";
      try {
        const j = JSON.parse(text) as { error?: unknown };
        if (typeof j.error === "string") why = `: ${j.error.slice(0, 200)}`;
      } catch {
        /* not JSON */
      }
      return { kind: "refused", status: s, message: `The console refused the usage report (${s})${why}.` };
    }
    if (s === 429 || s >= 500) return { kind: "unreachable", message: `The console answered ${s}.`, retryAfterMs: retryAfter(res.headers.get("retry-after"), opts.now ?? Date.now()) };
    if (s >= 300 && s < 400) return { kind: "error", message: `The console redirected the usage report (${s}); it was not followed.` };
    return { kind: "error", message: `The console answered ${s}.` };
  } catch (e) {
    const x = e as { name?: string; message?: string } | null;
    const why = x?.name === "TimeoutError" || x?.name === "AbortError" ? `no answer within ${Math.round(timeoutMs / 1000)} s` : (x?.message ?? String(e)).split("\n")[0].slice(0, 200);
    return { kind: "unreachable", message: `The console can't be reached: ${why}.` };
  }
}

/** The wait after `failures` failures in a row: 1 minute doubling to an hour (±20%), or the console's Retry-After. */
export function reportDelayMs(failures: number, random: () => number = Math.random, retryAfterMs?: number): number {
  if (retryAfterMs) return retryAfterMs;
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, Math.min(failures - 1, 20)));
  return Math.round(base * (0.8 + 0.4 * random()));
}

export interface ReportDeps {
  fetch: typeof fetch;
  credential: (cfg: LicensePullConfig) => Promise<string>;
  now: () => number;
  random: () => number;
  timeoutMs: number;
}

const G = globalThis as unknown as {
  __compassUsageReport?: { failures: number; notBefore: number; inflight: Promise<ReportRun> | null; deps: Partial<ReportDeps> | null; logged: string };
};

function rstate() {
  return (G.__compassUsageReport ??= { failures: 0, notBefore: 0, inflight: null, deps: null, logged: "" });
}

/** Tests: stand in for the network, the credential or the clock (null: the real ones). */
export function setUsageReportDepsForTests(d: Partial<ReportDeps> | null): void {
  rstate().deps = d;
}

/** Tests: forget the backoff (a restart). */
export function resetUsageReportForTests(): void {
  const deps = G.__compassUsageReport?.deps ?? null;
  G.__compassUsageReport = undefined;
  rstate().deps = deps;
}

async function deps(): Promise<ReportDeps> {
  const d = rstate().deps ?? {};
  return {
    fetch: d.fetch ?? fetch,
    credential: d.credential ?? (await import("./license-pull")).consoleCredential,
    now: d.now ?? Date.now,
    random: d.random ?? Math.random,
    timeoutMs: d.timeoutMs ?? FETCH_TIMEOUT_MS,
  };
}

export interface ReportRun {
  sent: string[];
  /** The last outcome, when anything was tried. */
  outcome: SendOutcome | null;
  /** When to try again (ms). */
  nextInMs: number;
}

/** The days to send: counted again since last sent, within REPORT_BACKLOG_DAYS, oldest first. */
async function pendingDays(now: number): Promise<DailyRow[]> {
  const from = dayKey(new Date(now - REPORT_BACKLOG_DAYS * 86_400_000));
  const rows = await hq<Record<string, unknown>>(
    `SELECT *, to_char(day, 'YYYY-MM-DD') AS day FROM plan_usage_daily
      WHERE day >= $1 AND day <= $2 AND (reported_counted_at IS NULL OR reported_counted_at <> counted_at)
      ORDER BY plan_usage_daily.day LIMIT 40`,
    [from, dayKey(new Date(now))]
  );
  return rows.map((r) => ({ ...(r as unknown as DailyRow), day: String(r.day).slice(0, 10) }));
}

async function say(level: "info" | "warn", event: string, message: string): Promise<void> {
  const s = rstate();
  if (s.logged === `${event}:${message}`) return;
  s.logged = `${event}:${message}`;
  const { logEvent } = await import("./log");
  logEvent(level, event, { message });
}

/**
 * Send every day not yet sent (or counted again since), oldest first; stop
 * at the first failure and back off. One run at a time per process. Never
 * throws.
 */
export function reportPendingUsage(state: PlanState): Promise<ReportRun> {
  const s = rstate();
  if (s.inflight) return s.inflight;
  const p = runReport(state)
    .catch((e): ReportRun => ({ sent: [], outcome: { kind: "error", message: e instanceof Error ? e.message : String(e) }, nextInMs: BACKOFF_MAX_MS }))
    .finally(() => {
      s.inflight = null;
    });
  s.inflight = p;
  return p;
}

async function runReport(state: PlanState): Promise<ReportRun> {
  const s = rstate();
  const d = await deps();
  const cfg = licensePullConfig();
  const url = usageReportUrl();
  const idle = 6 * 60 * 60_000;
  if (!cfg || !url) return { sent: [], outcome: null, nextInMs: idle };
  const now = d.now();
  if (now < s.notBefore) return { sent: [], outcome: null, nextInMs: s.notBefore - now };
  const days = await pendingDays(now);
  if (!days.length) return { sent: [], outcome: null, nextInMs: idle };
  let credential: string;
  try {
    credential = await d.credential(cfg);
  } catch (e) {
    s.failures++;
    const next = reportDelayMs(s.failures, d.random);
    s.notBefore = now + next;
    await say("warn", "plan.usage_report_failed", `No credential for the console: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    return { sent: [], outcome: { kind: "unauthorized", status: 0 }, nextInMs: next };
  }
  const sent: string[] = [];
  let outcome: SendOutcome | null = null;
  for (const row of days) {
    const report = buildReport(row, { workspace: cfg.workspaceId, licenseId: state.license.id ?? null, mismatch: state.mismatch?.licenseWorkspace ?? null });
    outcome = await sendUsageReport(url, credential, report, { fetchImpl: d.fetch, timeoutMs: d.timeoutMs, now: d.now() });
    if (outcome.kind === "stored") {
      await hq("UPDATE plan_usage_daily SET reported_at = now(), reported_counted_at = counted_at, report_attempts = 0, report_error = '' WHERE day = $1 AND counted_at = $2", [row.day, row.counted_at]);
      sent.push(row.day);
      continue;
    }
    if (outcome.kind === "refused") {
      // Not this body again: the next count of the day is sent afresh.
      // Only if the day wasn't counted again meanwhile: a newer count is a new body, still to send.
      await hq("UPDATE plan_usage_daily SET reported_counted_at = counted_at, report_attempts = report_attempts + 1, report_error = $2 WHERE day = $1 AND counted_at = $3", [row.day, outcome.message, row.counted_at]);
      await say("warn", "plan.usage_report_refused", `${outcome.message} Day ${row.day}.`);
      continue;
    }
    const message = outcome.kind === "missing" ? "The console has no usage endpoint (404)." : outcome.kind === "unauthorized" ? `The console refused the credential (${outcome.status}).` : outcome.message;
    await hq("UPDATE plan_usage_daily SET report_attempts = report_attempts + 1, report_error = $2 WHERE day = $1", [row.day, message.slice(0, 300)]);
    s.failures++;
    const next = outcome.kind === "missing" ? MISSING_RETRY_MS : reportDelayMs(s.failures, d.random, outcome.kind === "unreachable" ? outcome.retryAfterMs : undefined);
    s.notBefore = d.now() + next;
    await say(outcome.kind === "missing" ? "info" : "warn", "plan.usage_report_failed", `${message} Usage is kept and sent again later.`);
    return { sent, outcome, nextInMs: next };
  }
  if (s.failures) await say("info", "plan.usage_report_ok", "The console takes usage reports again.");
  s.failures = 0;
  s.notBefore = 0;
  return { sent, outcome, nextInMs: idle };
}
