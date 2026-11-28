// CompassDocs Cloud plan usage (1.22.0, design H): what the workspace
// counts, keeps and shows. Only a cloud workspace with a plan (lib/plan)
// counts, shows or caps anything; self-hosted, nothing here writes a row.
//
//   Active users   a person who signed in or used the app on at least one
//                  day this month (UTC), once, whatever they did: noted on
//                  the session check (lib/auth currentSession), a bearer
//                  credential's request (MCP, the v1 API: they count as
//                  themselves) and a customer portal session (requesters
//                  count only when they sign in: Decision 3). Not counted:
//                  people who only email the help address, share-link and
//                  public-site visitors, CompassDocs support sessions (their
//                  service accounts), disabled accounts.
//   Agents         people with a desk role on the day of the count
//                  (lib/helpdesk/roles-agents: the licence's own definition).
//   Storage        the stored files (attachments, images, ticket files) plus
//                  documents' text, version history and the Trash
//                  (Decision 4). Never backups, workspace exports or the
//                  search index.
//   AI             every AI request's tokens at the provider's price list
//                  (lib/helpdesk/claude/shared estimateCostUsd, the desk
//                  limits' own calculation), tagged with its feature: the
//                  desk's ledger (hd_claude_usage) plus ai_usage for Ask,
//                  Write and Proofread, and MCP.
//
// Once a day (and every 6 hours with the licence check-in's cadence) the
// counts are written to plan_usage_daily under an advisory lock, so
// replicas count once; thresholds are checked after the count (one email
// per meter per threshold per month, never more than one a day) and the
// day's counts go to the console (lib/plan-report). 13 months are kept.
//
// The AI cap (Decision 2: off by default) is checked before every AI
// request against the running total (aiGate), so it can be passed by at
// most the one request already admitted. Server-only.

import "server-only";
import { isCloud } from "./cloud";
import { getSetting, setSetting } from "./db";
import { hq, hqOne, withTx } from "./helpdesk/db-core";
import { estimateCostUsd, type ClaudeTokens } from "./helpdesk/claude/shared";
import { cloudPlanState, type PlanState } from "./plan";
import {
  AI_FEATURES,
  GB,
  agentHoldAt,
  agentsState,
  aiPace,
  aiSpend,
  aiState,
  bufferCap,
  dayKey,
  extraAgents,
  lastMonths,
  meterState,
  monthKey,
  monthStart,
  nextMonthStartLabel,
  planLabel,
  PLAN_CATALOGUE,
  storageSteps,
  thresholdsToEmail,
  visibleNotices,
  dismissalKey,
  validEmail,
  type AiFeature,
  type AiSpendView,
  type AiSpending,
  type MeterKey,
  type MeterReading,
  type PlanNotice,
  type PlanOverview,
  type PlanPerson,
  type Threshold,
  type TrendPoint,
} from "./plan-shared";

export const AI_SPENDING_SETTING = "plan_ai_spending";
export const AI_CAP_SETTING = "plan_ai_cap_usd";
export const BILLING_CONTACT_SETTING = "plan_billing_contact";
/** How long counts are kept (the trends read six of them). */
export const HISTORY_MONTHS = 13;
/** How often the counts are refreshed (the licence check-in's cadence). */
export const COUNT_EVERY_MS = 6 * 60 * 60_000;

// --- Active users --------------------------------------------------------------------------

const G = globalThis as unknown as { __compassPlanActive?: { day: string; seen: Set<string> } };

/**
 * Note that someone used the workspace today (cloud mode only; once per
 * person per day per process). Never throws and never waits: the request
 * that noted it is not held up.
 */
export function noteActive(kind: "user" | "portal", id: number, now: Date = new Date()): void {
  if (!isCloud() || !Number.isInteger(id) || id <= 0) return;
  const day = dayKey(now);
  const s = (G.__compassPlanActive ??= { day, seen: new Set() });
  if (s.day !== day) {
    s.day = day;
    s.seen = new Set();
  }
  const key = `${kind}:${id}`;
  if (s.seen.has(key)) return;
  s.seen.add(key);
  void recordActive(kind, id, now).catch(() => s.seen.delete(key));
}

/** The row noteActive writes (awaitable, for tests). */
export async function recordActive(kind: "user" | "portal", id: number, now: Date = new Date()): Promise<void> {
  await hq(
    `INSERT INTO plan_active_users (month, kind, subject_id, first_at, last_at) VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (month, kind, subject_id) DO UPDATE SET last_at = GREATEST(plan_active_users.last_at, EXCLUDED.last_at)`,
    [monthStart(now), kind, id, now]
  );
}

/** Tests: forget which people this process noted today. */
export function resetActiveMemoForTests(): void {
  G.__compassPlanActive = undefined;
}

/** The roles people count under, highest first (design A6: each person counts once, under their highest role). */
export const COUNTED_AS = ["Agents", "Admins", "Approvers", "Editors", "Viewers", "Requesters"] as const;
export type CountedAs = (typeof COUNTED_AS)[number];

const ROLE_KIND: Record<string, CountedAs> = { admin: "Admins", approver: "Approvers", editor: "Editors", viewer: "Viewers" };

interface ActiveRow {
  kind: "user" | "portal";
  subject_id: number;
  last_at: string;
  name: string;
  role: string;
}

/** Everyone counted in the month that starts `month` ("2026-11-01"), before `before` (exclusive). */
async function activeRows(month: string, before: Date): Promise<ActiveRow[]> {
  return hq<ActiveRow>(
    `SELECT a.kind, a.subject_id, a.last_at,
            CASE WHEN a.kind = 'user' THEN coalesce(nullif(u.name, ''), u.username) ELSE coalesce(nullif(c.name, ''), c.email) END AS name,
            coalesce(u.role, '') AS role
       FROM plan_active_users a
       LEFT JOIN users u ON a.kind = 'user' AND u.id = a.subject_id
       LEFT JOIN hd_portal_contacts c ON a.kind = 'portal' AND c.id = a.subject_id
      WHERE a.month = $1 AND a.first_at < $2
        AND ((a.kind = 'user' AND u.id IS NOT NULL AND u.status = 'active' AND u.auth_provider <> 'compassdocs_support')
             OR (a.kind = 'portal' AND c.id IS NOT NULL))`,
    [month, before]
  );
}

async function deskAgentSet(): Promise<Set<number>> {
  try {
    const { deskAgentIds } = await import("./helpdesk/roles-agents");
    return new Set(await deskAgentIds());
  } catch {
    return new Set();
  }
}

/** How a row counts: Agent for anyone on the desk, else their workspace role; a portal contact is a Requester. */
export function countedAs(row: Pick<ActiveRow, "kind" | "role" | "subject_id">, agents: Set<number>): CountedAs {
  if (row.kind === "portal") return "Requesters";
  if (agents.has(row.subject_id)) return "Agents";
  return ROLE_KIND[row.role] ?? "Viewers";
}

/** The month's active users: how many, by role. */
export async function activeUsers(now: Date, before: Date = now): Promise<{ count: number; byKind: Record<CountedAs, number> }> {
  const [rows, agents] = await Promise.all([activeRows(monthStart(now), before), deskAgentSet()]);
  const byKind = Object.fromEntries(COUNTED_AS.map((k) => [k, 0])) as Record<CountedAs, number>;
  for (const r of rows) byKind[countedAs(r, agents)]++;
  return { count: rows.length, byKind };
}

/** "Who counted" (design A6): names stay in the workspace, for its admins. */
export async function activePeople(now: Date): Promise<PlanPerson[]> {
  const [rows, agents] = await Promise.all([activeRows(monthStart(now), new Date(now.getTime() + 1)), deskAgentSet()]);
  return rows
    .map((r) => {
      const as = countedAs(r, agents);
      const detail = r.kind === "portal" ? "Customer portal" : as === "Agents" && ROLE_KIND[r.role] ? `${ROLE_KIND[r.role].slice(0, -1)} in CompassDocs` : "";
      return { name: r.name || "Unnamed", countedAs: as.slice(0, -1), detail, lastAt: r.last_at };
    })
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.name.localeCompare(b.name));
}

// --- AI -----------------------------------------------------------------------------------------

export interface AiCall {
  feature: AiFeature;
  userId?: number | null;
  model: string;
  tokens: ClaudeTokens;
  /** A price already worked out (another provider): else the price list's for the model. */
  costUsd?: number;
}

/** Record one AI request outside the desk (cloud mode only). Never throws. */
export async function recordAiUsage(call: AiCall, at: Date = new Date()): Promise<void> {
  if (!isCloud()) return;
  const t = call.tokens;
  const cost = call.costUsd ?? estimateCostUsd(call.model, t);
  try {
    await hq(
      `INSERT INTO ai_usage (at, feature, user_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [at, call.feature, call.userId ?? null, call.model.slice(0, 80), t.input, t.output, t.cacheRead, t.cacheWrite, Math.round(cost * 1_000_000) / 1_000_000]
    );
  } catch {
    /* the answer was given; a lost ledger row is a cent, not a failure */
  }
}

export interface AiMonth {
  total: number;
  byFeature: Record<AiFeature, number>;
  deskTurns: number;
  askAnswers: number;
}

/** AI dollars in `now`'s month (UTC) before `before`: the desk's ledger plus ai_usage, by feature. */
export async function aiMonth(now: Date, before: Date = new Date(now.getTime() + 1)): Promise<AiMonth> {
  const start = `${monthStart(now)}T00:00:00Z`;
  const [desk, rest] = await Promise.all([
    hqOne<{ usd: string; turns: string }>("SELECT coalesce(sum(cost_usd), 0) AS usd, count(*) AS turns FROM hd_claude_usage WHERE at >= $1 AND at < $2", [start, before]),
    hq<{ feature: string; usd: string; n: string }>("SELECT feature, coalesce(sum(cost_usd), 0) AS usd, count(*) AS n FROM ai_usage WHERE at >= $1 AND at < $2 GROUP BY feature", [start, before]),
  ]);
  const byFeature = Object.fromEntries(AI_FEATURES.map((f) => [f, 0])) as Record<AiFeature, number>;
  byFeature.desk = Number(desk?.usd ?? 0);
  let askAnswers = 0;
  for (const r of rest) {
    if ((AI_FEATURES as readonly string[]).includes(r.feature)) byFeature[r.feature as AiFeature] += Number(r.usd);
    if (r.feature === "ask") askAnswers = Number(r.n);
  }
  const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
  for (const f of AI_FEATURES) byFeature[f] = round(byFeature[f]);
  return { total: round(AI_FEATURES.reduce((s, f) => s + byFeature[f], 0)), byFeature, deskTurns: Number(desk?.turns ?? 0), askAnswers };
}

export interface AiSpendingChoice {
  spending: AiSpending;
  capUsd: number | null;
}

/** The admin's choice (Decision 2: keep AI on, no cap, until someone chooses otherwise). */
export async function getAiSpending(): Promise<AiSpendingChoice> {
  const [s, c] = await Promise.all([getSetting(AI_SPENDING_SETTING), getSetting(AI_CAP_SETTING)]);
  const spending: AiSpending = s === "stop" || s === "cap" ? s : "keep";
  const cap = c !== undefined && c !== "" && Number.isFinite(Number(c)) ? Number(c) : null;
  return { spending, capUsd: spending === "cap" ? cap : null };
}

export async function setAiSpending(choice: AiSpendingChoice): Promise<void> {
  await setSetting(AI_SPENDING_SETTING, choice.spending);
  await setSetting(AI_CAP_SETTING, choice.capUsd === null ? "" : String(choice.capUsd));
}

/** The month's AI spending against the plan and the cap; null without a plan. */
export async function aiSpendNow(now: Date = new Date(), state?: PlanState | null): Promise<(AiSpendView & { month: AiMonth }) | null> {
  const s = state === undefined ? await cloudPlanState() : state;
  if (!s) return null;
  const [month, choice] = await Promise.all([aiMonth(now), getAiSpending()]);
  return { ...aiSpend(month.total, s.plan.aiAllowanceUsd, choice.spending, choice.capUsd), month };
}

/** Why an AI request is refused: the cap is reached for this month (design D3). */
export class AiPausedError extends Error {
  readonly until: string;
  constructor(until: string) {
    super(aiPausedSentence(until, false));
    this.name = "AiPausedError";
    this.until = until;
  }
}

/** The pause, in words: everyone sees it (it names no amount); admins also read where to raise it. */
export function aiPausedSentence(until: string, admin: boolean): string {
  return `AI is paused until ${until}: this workspace reached its monthly AI limit. ${admin ? "Admins can raise the limit in Plan & usage." : "Ask an admin if you need it sooner."}`;
}

/**
 * Before an AI request: null when it may go ahead, else when AI starts
 * again ("1 Dec"). Only a cloud workspace with a plan and a cap reached is
 * ever paused; anything that fails here lets the request through (the cap
 * is a spending choice, not a security control).
 */
export async function aiGate(now: Date = new Date()): Promise<{ until: string } | null> {
  if (!isCloud()) return null;
  try {
    const choice = await getAiSpending();
    if (choice.spending === "keep") return null;
    const view = await aiSpendNow(now);
    return view?.paused ? { until: nextMonthStartLabel(now) } : null;
  } catch {
    return null;
  }
}

/** aiGate as a throw (chatComplete and the desk call it before each request). */
export async function assertAiAllowed(now: Date = new Date()): Promise<void> {
  const g = await aiGate(now);
  if (g) throw new AiPausedError(g.until);
}

// --- Storage ------------------------------------------------------------------------------------

export interface StorageCount {
  /** What counts (Decision 4). */
  bytes: number;
  areas: { files: number; documents: number; helpdesk: number };
  /** Shown, never counted. */
  notCounted: { exports: number };
}

/** Pure: the areas from the raw sums (files are the store's total less the desk's, which count under Helpdesk). */
export function storageAreas(raw: { storeBytes: number; deskFileBytes: number; docTextBytes: number; deskTextBytes: number; exportBytes: number }): StorageCount {
  const desk = Math.max(0, raw.deskFileBytes) + Math.max(0, raw.deskTextBytes);
  const files = Math.max(0, raw.storeBytes - Math.max(0, raw.deskFileBytes));
  const documents = Math.max(0, raw.docTextBytes);
  return { bytes: files + documents + desk, areas: { files, documents, helpdesk: desk }, notCounted: { exports: Math.max(0, raw.exportBytes) } };
}

/** Count storage now. The file store's usage already leaves out backups and export objects (lib/file-store). */
export async function countStorage(): Promise<StorageCount> {
  const { fileStore } = await import("./file-store");
  const [store, sums] = await Promise.all([
    fileStore()
      .usage()
      .catch(() => ({ bytes: 0, files: 0 })),
    hqOne<{ desk_files: string; doc_text: string; desk_text: string; exports: string }>(
      `SELECT
         (SELECT coalesce(sum(size), 0) FROM hd_attachments) AS desk_files,
         (SELECT coalesce(sum(octet_length(title) + octet_length(coalesce(summary, '')) + octet_length(content)), 0) FROM documents)
           + (SELECT coalesce(sum(octet_length(title) + octet_length(content)), 0) FROM doc_versions) AS doc_text,
         (SELECT coalesce(sum(octet_length(body)), 0) FROM hd_messages) + (SELECT coalesce(sum(size), 0) FROM hd_message_html) AS desk_text,
         (SELECT coalesce(sum(size), 0) FROM workspace_exports WHERE status = 'ready') AS exports`
    ),
  ]);
  return storageAreas({
    storeBytes: Number(store.bytes) || 0,
    deskFileBytes: Number(sums?.desk_files ?? 0),
    docTextBytes: Number(sums?.doc_text ?? 0),
    deskTextBytes: Number(sums?.desk_text ?? 0),
    exportBytes: Number(sums?.exports ?? 0),
  });
}

// --- The daily count -----------------------------------------------------------------------------

export interface DailyCounts {
  day: string;
  countedAt: string;
  plan: string;
  agents: number;
  activeUsers: number;
  storageBytes: number;
  storage: StorageCount;
  aiUsd: number;
  ai: Record<AiFeature, number>;
}

/**
 * Count `day` as of `asOf`: the month's active users and AI before `asOf`
 * (so a day counted after it ended is that day's final count), agents and
 * storage as they are now.
 */
export async function countUsage(state: PlanState, asOf: Date): Promise<DailyCounts> {
  const { countDeskAgents } = await import("./helpdesk/roles-agents");
  const monthOf = new Date(asOf.getTime() - 1);
  const [agents, users, storage, ai] = await Promise.all([
    countDeskAgents().catch(() => 0),
    activeUsers(monthOf, asOf),
    countStorage(),
    aiMonth(monthOf, asOf),
  ]);
  return {
    day: dayKey(monthOf),
    countedAt: new Date().toISOString(),
    plan: state.plan.name,
    agents,
    activeUsers: users.count,
    storageBytes: storage.bytes,
    storage,
    aiUsd: ai.total,
    ai: ai.byFeature,
  };
}

/** Write a day's counts (replacing an earlier count of the same day). */
export async function saveCounts(c: DailyCounts, client?: Parameters<typeof hq>[2]): Promise<void> {
  await hq(
    `INSERT INTO plan_usage_daily (day, counted_at, plan, agents, active_users, storage_bytes, storage, ai_usd, ai)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (day) DO UPDATE SET counted_at = EXCLUDED.counted_at, plan = EXCLUDED.plan, agents = EXCLUDED.agents,
       active_users = EXCLUDED.active_users, storage_bytes = EXCLUDED.storage_bytes, storage = EXCLUDED.storage,
       ai_usd = EXCLUDED.ai_usd, ai = EXCLUDED.ai`,
    [c.day, c.countedAt, c.plan, c.agents, c.activeUsers, c.storageBytes, JSON.stringify(c.storage), c.aiUsd, JSON.stringify(c.ai)],
    client
  );
}

export interface DailyRow {
  day: string;
  counted_at: string;
  plan: string;
  agents: number;
  active_users: number;
  storage_bytes: number;
  storage: StorageCount;
  ai_usd: number;
  ai: Record<AiFeature, number>;
  reported_at: string | null;
  reported_counted_at: string | null;
  report_attempts: number;
  report_error: string;
}

function toDaily(r: Record<string, unknown>): DailyRow {
  return {
    ...(r as unknown as DailyRow),
    day: String(r.day).slice(0, 10),
    agents: Number(r.agents),
    active_users: Number(r.active_users),
    storage_bytes: Number(r.storage_bytes),
    ai_usd: Number(r.ai_usd),
  };
}

/** The latest counted day up to `upTo` (today), or null. */
export async function latestCounts(upTo: Date = new Date()): Promise<DailyRow | null> {
  const r = await hqOne<Record<string, unknown>>("SELECT *, to_char(day, 'YYYY-MM-DD') AS day FROM plan_usage_daily WHERE day <= $1 ORDER BY plan_usage_daily.day DESC LIMIT 1", [dayKey(upTo)]);
  return r ? toDaily(r) : null;
}

/** Days in a range, oldest first. */
export async function countsBetween(from: string, to: string): Promise<DailyRow[]> {
  const rows = await hq<Record<string, unknown>>("SELECT *, to_char(day, 'YYYY-MM-DD') AS day FROM plan_usage_daily WHERE day >= $1 AND day <= $2 ORDER BY plan_usage_daily.day", [from, to]);
  return rows.map(toDaily);
}

/** Pure: a meter's six-month trend from the kept days (one value a month: its final count; agents its highest). */
export function trendFrom(rows: Pick<DailyRow, "day" | "agents" | "active_users" | "storage_bytes" | "ai_usd">[], key: MeterKey, now: Date): TrendPoint[] {
  const current = monthKey(now);
  return lastMonths(now, 6).map((m) => {
    const inMonth = rows.filter((r) => r.day.slice(0, 7) === m).sort((a, b) => a.day.localeCompare(b.day));
    if (!inMonth.length) return { month: m, value: null, partial: m === current };
    const last = inMonth[inMonth.length - 1];
    const value =
      key === "agents" ? Math.max(...inMonth.map((r) => r.agents)) : key === "users" ? last.active_users : key === "storage" ? Math.round((last.storage_bytes / GB) * 10) / 10 : Math.round(last.ai_usd * 100) / 100;
    return { month: m, value, partial: m === current };
  });
}

/** Forget counts, activity and AI rows older than HISTORY_MONTHS. */
export async function purgeHistory(now: Date, client?: Parameters<typeof hq>[2]): Promise<void> {
  const cutoff = `${monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (HISTORY_MONTHS - 1), 1)))}-01`;
  await hq("DELETE FROM plan_usage_daily WHERE day < $1", [cutoff], client);
  await hq("DELETE FROM plan_active_users WHERE month < $1", [cutoff], client);
  await hq("DELETE FROM ai_usage WHERE at < $1", [cutoff], client);
  await hq("DELETE FROM plan_notices WHERE month < $1", [cutoff], client);
  await hq("DELETE FROM plan_banner_dismissals WHERE month < $1", [cutoff], client);
}

// --- Readings, banners and the threshold email -----------------------------------------------

/** The four meters' readings from a day's counts (and the AI view, which carries the cap). */
export function readingsFrom(state: PlanState, c: { agents: number; active_users: number; storage_bytes: number }, ai: AiSpendView): MeterReading[] {
  const p = state.plan;
  return [
    { key: "agents", value: c.agents, limit: p.agentsMax, state: agentsState(c.agents, p) },
    { key: "users", value: c.active_users, limit: p.activeUsersLimit, state: meterState(c.active_users, p.activeUsersLimit, { bufferPct: p.bufferPct }) },
    {
      key: "storage",
      value: Math.round((c.storage_bytes / GB) * 10) / 10,
      limit: p.storageGb,
      state: p.storageGb === null ? "normal" : c.storage_bytes > p.storageGb * GB ? "over" : meterState(c.storage_bytes / GB, p.storageGb, { buffer: false }),
    },
    { key: "ai", value: ai.spentUsd, limit: ai.allowanceUsd, state: aiState(ai) },
  ];
}

/** The workspace's name as the banners say it. */
async function workspaceName(): Promise<string> {
  try {
    const { getAppSettings } = await import("./settings-store");
    return (await getAppSettings()).company_name || "This workspace";
  } catch {
    return "This workspace";
  }
}

/** What an admin's banners say now: the latest counts, the AI as it stands, less their dismissals. */
export async function noticesFor(userId: number, now: Date = new Date()): Promise<PlanNotice[]> {
  const state = await cloudPlanState();
  if (!state) return [];
  const [latest, ai, name, dismissed] = await Promise.all([
    latestCounts(now),
    aiSpendNow(now, state),
    workspaceName(),
    hq<{ meter: string; threshold: string; month: string }>(
      "SELECT meter, threshold, to_char(month, 'YYYY-MM') AS month FROM plan_banner_dismissals WHERE user_id = $1 AND month = $2",
      [userId, monthStart(now)]
    ),
  ]);
  if (!ai) return [];
  const month = monthKey(now);
  const counts = latest && latest.day.slice(0, 7) === month ? latest : { agents: latest?.agents ?? 0, active_users: 0, storage_bytes: latest?.storage_bytes ?? 0 };
  const readings = readingsFrom(state, counts, ai);
  return visibleNotices(readings, { workspace: name, plan: state.plan, month, ai, storageBytes: counts.storage_bytes }, dismissed.map((d) => `${d.month}:${d.meter}:${d.threshold}`));
}

/** Dismiss banners for one admin this month (each a meter and threshold). */
export async function dismissNotices(userId: number, items: { meter: MeterKey; threshold: Threshold }[], now: Date = new Date()): Promise<void> {
  for (const i of items) {
    await hq(
      `INSERT INTO plan_banner_dismissals (user_id, month, meter, threshold) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [userId, monthStart(now), i.meter, i.threshold]
    );
  }
}

/** Who the threshold email goes to: the billing contact when one is named (the setting, else the licence's), else every active admin with an address (Decision 5). */
export async function warningRecipients(state: PlanState): Promise<{ email: string; userId: number | null }[]> {
  const named = ((await getSetting(BILLING_CONTACT_SETTING)) ?? "").trim() || state.plan.billingContact || "";
  if (named && validEmail(named)) {
    const u = await hqOne<{ id: number }>("SELECT id FROM users WHERE lower(email) = lower($1) AND status = 'active' LIMIT 1", [named]);
    return [{ email: named, userId: u?.id ?? null }];
  }
  const admins = await hq<{ id: number; email: string }>("SELECT id, email FROM users WHERE role = 'admin' AND status = 'active' AND email <> '' ORDER BY id");
  return admins.map((a) => ({ email: a.email, userId: a.id }));
}

/** Send the day's threshold email if anything new was reached (at most one a day). Returns the thresholds sent. */
export async function sendThresholdEmail(state: PlanState, c: DailyRow, now: Date = new Date()): Promise<PlanNotice[]> {
  const ai = await aiSpendNow(now, state);
  if (!ai) return [];
  const month = monthKey(now);
  if (c.day.slice(0, 7) !== month) return [];
  const sentRows = await hq<{ meter: string; threshold: string; month: string; sent_at: string }>(
    "SELECT meter, threshold, to_char(month, 'YYYY-MM') AS month, sent_at FROM plan_notices WHERE month = $1",
    [monthStart(now)]
  );
  // Never more than one a day.
  if (sentRows.some((r) => dayKey(new Date(r.sent_at)) === dayKey(now))) return [];
  const name = await workspaceName();
  const readings = readingsFrom(state, c, ai);
  const fresh = thresholdsToEmail(readings, { workspace: name, plan: state.plan, month, ai, storageBytes: c.storage_bytes }, sentRows.map((r) => `${r.month}:${r.meter}:${r.threshold}`));
  if (!fresh.length) return [];
  const recipients = await warningRecipients(state);
  // Claim first, so two replicas can't both send it.
  const claimed = await withTx(async (client) => {
    const won: PlanNotice[] = [];
    for (const n of fresh) {
      const r = await client.query(
        "INSERT INTO plan_notices (month, meter, threshold, recipients, sent_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING meter",
        [monthStart(now), n.meter, n.threshold, recipients.length, now]
      );
      if (r.rowCount) won.push(n);
    }
    return won;
  });
  if (!claimed.length || !recipients.length) return claimed;
  try {
    const { renderEmail } = await import("./email-templates");
    const { sendMail } = await import("./mailer");
    const { mailOrigin } = await import("./workspace-origin");
    const origin = await mailOrigin();
    const p = state.plan;
    const vars = {
      headline: thresholdHeadline(claimed[0], name, p.name),
      notices: claimed.map((n) => `**${n.lead}** ${n.rest}`).join("\n\n"),
      meters: meterLines(p, c, ai).join("\n"),
      plan_name: planLabel(p.name),
      plan_url: `${origin}/admin/plan`,
      restart_date: `1 ${new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" })}`,
    };
    for (const r of recipients) {
      const mail = await renderEmail("plan_usage_threshold", vars, origin, { ...(r.userId ? { recipientUserId: r.userId } : { recipientEmail: r.email }), manageLink: false });
      await sendMail([r.email], mail.subject, mail.text, mail.html, undefined, undefined, { kind: "plan_usage" });
    }
  } catch (e) {
    const { logEvent } = await import("./log");
    logEvent("warn", "plan.threshold_email_failed", { message: e instanceof Error ? e.message.split("\n")[0] : String(e) });
  }
  return claimed;
}

function thresholdHeadline(n: PlanNotice, name: string, plan: CloudPlan["name"]): string {
  const what: Record<MeterKey, string> = { agents: "agents", users: "active users", storage: "storage", ai: "AI allowance" };
  const where = n.threshold === "80" ? "is at 80% of" : n.threshold === "past" ? "is past the buffer of" : n.threshold === "paused" ? "has paused AI under" : "is over";
  return `${name} ${where} its ${planLabel(plan)} plan's ${what[n.meter]}`;
}

type CloudPlan = PlanState["plan"];

function meterLines(p: CloudPlan, c: Pick<DailyRow, "agents" | "active_users" | "storage_bytes">, ai: AiSpendView): string[] {
  const { usd, gb } = PLAN_FMT;
  return [
    `- Active users: ${c.active_users.toLocaleString("en-US")}${p.activeUsersLimit !== null ? ` of ${p.activeUsersLimit.toLocaleString("en-US")}` : ""}`,
    `- AI allowance: ${usd(ai.spentUsd)}${ai.allowanceUsd !== null ? ` of ${usd(ai.allowanceUsd)}` : ""}`,
    `- Storage: ${gb(c.storage_bytes)}${p.storageGb !== null ? ` of ${p.storageGb} GB` : ""}`,
    `- Agents: ${c.agents} of ${p.agentsIncluded} included${p.agentsMax !== null ? ` (up to ${p.agentsMax})` : ""}`,
  ];
}

const PLAN_FMT = {
  usd: (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`,
  gb: (b: number) => `${(Math.round((b / GB) * 10) / 10).toLocaleString("en-US")} GB`,
};

// --- The run --------------------------------------------------------------------------------------

export interface TickResult {
  counted: string[];
  emailed: number;
  /** When to run again (ms). */
  nextInMs: number;
}

/**
 * One run: count today (if not counted within COUNT_EVERY_MS) and finish
 * yesterday (if its last count was before midnight), forget what is past
 * 13 months, send a threshold email if one is due, then report to the
 * console. Under an advisory lock, so replicas take turns.
 */
export async function planUsageTick(now: Date = new Date(), opts: { report?: boolean } = {}): Promise<TickResult> {
  const state = await cloudPlanState();
  if (!state) return { counted: [], emailed: 0, nextInMs: COUNT_EVERY_MS };
  const counted: string[] = [];
  const today = dayKey(now);
  const midnight = new Date(`${today}T00:00:00Z`);
  const yesterday = dayKey(new Date(midnight.getTime() - 1));
  const { withAdvisoryLock } = await import("./db");
  await withAdvisoryLock("plan-usage", async () => {
    const rows = await countsBetween(yesterday, today);
    const y = rows.find((r) => r.day === yesterday);
    const t = rows.find((r) => r.day === today);
    if (y && new Date(y.counted_at) < midnight) {
      await saveCounts(await countUsage(state, midnight));
      counted.push(yesterday);
    }
    if (!t || now.getTime() - new Date(t.counted_at).getTime() >= COUNT_EVERY_MS) {
      await saveCounts(await countUsage(state, now));
      counted.push(today);
    }
    if (counted.length) await purgeHistory(now);
  });
  let emailed = 0;
  const latest = await latestCounts(now);
  if (latest) emailed = (await sendThresholdEmail(state, latest, now)).length;
  let nextInMs = COUNT_EVERY_MS;
  if (opts.report !== false) {
    const { reportPendingUsage } = await import("./plan-report");
    const r = await reportPendingUsage(state);
    nextInMs = Math.min(COUNT_EVERY_MS, r.nextInMs);
  }
  // The first count after midnight UTC: the day's final count is taken a few minutes into the next.
  const toMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5) - now.getTime();
  return { counted, emailed, nextInMs: Math.max(60_000, Math.min(nextInMs, toMidnight)) };
}

/** Make sure today has a count (the Plan & usage page asks before it reads one). */
export async function ensureCounted(now: Date = new Date()): Promise<void> {
  const latest = await latestCounts(now);
  if (latest && latest.day === dayKey(now)) return;
  await planUsageTick(now, { report: false });
}

const S = globalThis as unknown as { __compassPlanJob?: boolean };

/** Start counting (instrumentation, cloud mode): shortly after start, then by planUsageTick's next. Stops with the drain. */
export function startPlanUsage(): void {
  if (!isCloud() || S.__compassPlanJob) return;
  S.__compassPlanJob = true;
  void (async () => {
    const { after, runJob } = await import("./shutdown");
    const schedule = (ms: number) =>
      after(ms, () =>
        runJob("plan-usage", async () => {
          let next = COUNT_EVERY_MS;
          try {
            next = (await planUsageTick()).nextInMs;
          } catch (e) {
            const { logEvent } = await import("./log");
            logEvent("warn", "plan.count_failed", { message: e instanceof Error ? e.message.split("\n")[0] : String(e) });
            next = 15 * 60_000;
          } finally {
            schedule(next);
          }
        })
      );
    schedule(20_000 + Math.round(Math.random() * 20_000));
  })();
}

// --- The overview (Plan & usage) ------------------------------------------------------------

/** Everything the Plan & usage page shows (null without a plan). */
export async function planOverview(now: Date = new Date()): Promise<PlanOverview | null> {
  const resolution = await (await import("./plan")).planResolution();
  const state = resolution.state;
  if (!state) return null;
  await ensureCounted(now).catch(() => {});
  const from = `${lastMonths(now, 6)[0]}-01`;
  const [rows, ai, users, name, contact] = await Promise.all([
    countsBetween(from, dayKey(now)),
    aiSpendNow(now, state),
    activeUsers(now, new Date(now.getTime() + 1)),
    workspaceName(),
    getSetting(BILLING_CONTACT_SETTING),
  ]);
  if (!ai) return null;
  const p = state.plan;
  const latest = rows.length ? rows[rows.length - 1] : null;
  const month = monthKey(now);
  const thisMonth = latest && latest.day.slice(0, 7) === month;
  const counts = {
    agents: latest?.agents ?? 0,
    active_users: thisMonth ? latest!.active_users : users.count,
    storage_bytes: latest?.storage_bytes ?? 0,
  };
  const readings = readingsFrom(state, counts, ai);
  const byKey = Object.fromEntries(readings.map((r) => [r.key, r])) as Record<MeterKey, MeterReading>;
  const lastMonthKey = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const lastMonthRows = rows.filter((r) => r.day.slice(0, 7) === lastMonthKey);
  const storage = (latest?.storage as StorageCount | undefined) ?? { bytes: 0, areas: { files: 0, documents: 0, helpdesk: 0 }, notCounted: { exports: 0 } };
  const capOf = (limit: number | null, buffer: boolean) => (limit === null ? null : buffer ? bufferCap(limit, p.bufferPct) : Math.round(limit * (1 + p.bufferPct / 100) * 100) / 100);
  const meter = (key: MeterKey, limit: number | null, buffer: boolean) => ({
    key,
    value: byKey[key].value,
    limit,
    cap: capOf(limit, buffer),
    state: byKey[key].state,
    trend: trendFrom(rows, key, now),
  });
  const cat = PLAN_CATALOGUE[p.name];
  const { envBaseOrigin } = await import("./workspace-origin");
  return {
    workspace: { name, id: (await import("./plan")).workspaceId(), address: (envBaseOrigin() ?? "").replace(/^https?:\/\//, "") },
    plan: { ...p, label: planLabel(p.name), priceUsd: p.priceUsd ?? cat.priceUsd, next: cat.next },
    countedAt: latest?.counted_at ?? null,
    month,
    nextMonthStart: nextMonthStartLabel(now),
    meters: {
      agents: meter("agents", p.agentsMax, true),
      users: meter("users", p.activeUsersLimit, true),
      storage: meter("storage", p.storageGb, false),
      ai: meter("ai", p.aiAllowanceUsd, false),
    },
    agents: { used: counts.agents, included: p.agentsIncluded, max: p.agentsMax, holdAt: agentHoldAt(p), extra: extraAgents(counts.agents, p) },
    users: { byKind: users.byKind },
    storage: { ...storage, limitBytes: p.storageGb === null ? null : p.storageGb * GB, steps: storageSteps(storage.bytes, p.storageGb) },
    ai: {
      ...ai,
      byFeature: ai.month.byFeature,
      details: { deskTurns: ai.month.deskTurns, askAnswers: ai.month.askAnswers },
      lastMonthUsd: lastMonthRows.length ? Number(lastMonthRows[lastMonthRows.length - 1].ai_usd) : 0,
      paceUsd: aiPace(ai.spentUsd, now),
    },
    billingContact: (contact ?? "").trim() || p.billingContact || "",
    mismatch: resolution.mismatch,
  };
}

// --- AI entry points (design D1, D3) ------------------------------------------------------------

export interface AiPlanStatus {
  /** AI is paused until this day ("1 Dec"): everyone sees it, it names no amount. */
  pausedUntil: string | null;
  /** The viewer can open Plan & usage (the only people who see billing words, Decision 7). */
  admin: boolean;
  /** Past this month's allowance (admins only): "billed at cost +30%". */
  beyond: boolean;
}

/**
 * What the AI entry points say (the shells compute it once per page): null
 * outside cloud mode or without a plan. Cheap for everyone but admins: the
 * month's spending is read only when a cap is set, or for an admin's line.
 */
export async function aiPlanStatus(planAdmin: boolean, now: Date = new Date()): Promise<AiPlanStatus | null> {
  if (!isCloud()) return null;
  try {
    const state = await cloudPlanState();
    if (!state) return null;
    const choice = await getAiSpending();
    if (!planAdmin && choice.spending === "keep") return { pausedUntil: null, admin: false, beyond: false };
    const view = await aiSpendNow(now, state);
    if (!view) return null;
    return {
      pausedUntil: view.paused ? nextMonthStartLabel(now) : null,
      admin: planAdmin,
      beyond: planAdmin && view.allowanceUsd !== null && view.allowanceUsd > 0 && view.spentUsd >= view.allowanceUsd,
    };
  } catch {
    return null;
  }
}
