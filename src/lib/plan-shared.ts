// CompassDocs Cloud plans (1.22.0): the client-safe half. The plan's
// limits come from the signed licence (its `cloudPlan` claim, read by
// lib/plan cloudPlanState, server-only); this module holds what every
// screen, the daily count and the tests share: the claim's parser, the
// meter states and their buffer, the price of an extra agent and its
// proration, the AI allowance and its cap, and the threshold banners. No
// server imports, no I/O: every function here is pure.
//
// Months are calendar months in UTC (design H), everywhere: the meters,
// the AI allowance, the banners' "per month" and the history.

export type PlanName = "starter" | "shared" | "dedicated";
export const PLAN_NAMES: readonly PlanName[] = ["starter", "shared", "dedicated"];

/**
 * The `cloudPlan` claim, as signed by the console (README "The plan in the
 * licence"). Every limit may be null: no limit of that kind (Dedicated's
 * active users, a contract's agents).
 */
export interface CloudPlan {
  name: PlanName;
  /** Agents the plan includes at no extra cost. */
  agentsIncluded: number;
  /** The plan's agent maximum before the buffer; null = no maximum. */
  agentsMax: number | null;
  /** Active users a month; null = no cap. */
  activeUsersLimit: number | null;
  /** Storage included, in GB (10^9 bytes); null = by contract (no meter limit). */
  storageGb: number | null;
  /** AI included each month, in US dollars at cost; null = by contract (no allowance metered). */
  aiAllowanceUsd: number | null;
  /** The soft buffer above a limit, in percent (default 20). */
  bufferPct: number;
  /** The plan's renewal date (YYYY-MM-DD, UTC). */
  renewsAt: string;
  /** An email address the warning emails go to instead of every admin (Decision 5); null = all admins. */
  billingContact: string | null;
  /** The plan's monthly price in US dollars (shown on the plan card); null = the catalogue's. */
  priceUsd: number | null;
  /** How the plan is billed: proration of an extra agent follows it. */
  billing: "annual" | "monthly";
}

export const DEFAULT_BUFFER_PCT = 20;
/** One extra agent, a month (billed annually as 12 × this). */
export const EXTRA_AGENT_USD = 9.99;
/** Extra storage is sold in steps of this many GB… */
export const STORAGE_STEP_GB = 50;
/** …at this much a month each. */
export const STORAGE_STEP_USD = 25;
/** AI beyond the allowance is billed at cost × (1 + this). */
export const AI_MARKUP = 0.3;
/** Where upgrade requests go (the console's sales inbox). */
export const SALES_EMAIL = "sales@compassdocs.io";
/** Where a workspace with a licence problem writes (design F). */
export const SUPPORT_EMAIL = "support@compassdocs.io";
/** One gigabyte, as storage is sold (decimal). */
export const GB = 1_000_000_000;

export interface PlanCatalogueEntry {
  label: string;
  /** The monthly price, when the licence does not carry one. */
  priceUsd: number;
  /** The plan an upgrade moves to; null on the top plan. */
  next: PlanName | null;
  /** One line per limit, for the upgrade dialog's comparison. */
  summary: string[];
  /** The plan's usual agents (the licence's always win): included, and the maximum (null: by contract). */
  agents: { included: number; max: number | null };
}

/** The agreed plans (Cloud roadmap, 26 Nov 2026). The licence's limits always win; this is for words and the upgrade comparison. */
export const PLAN_CATALOGUE: Record<PlanName, PlanCatalogueEntry> = {
  starter: { label: "Starter", priceUsd: 199, next: "shared", summary: ["3 agents, up to 10", "250 active users", "25 GB · about $15 AI"], agents: { included: 3, max: 10 } },
  shared: { label: "Shared", priceUsd: 449, next: "dedicated", summary: ["5 agents, up to 25", "1,000 active users", "50 GB · about $40 AI"], agents: { included: 5, max: 25 } },
  dedicated: { label: "Dedicated", priceUsd: 2950, next: null, summary: ["Agents by contract", "No user cap", "250 GB · AI by contract"], agents: { included: 0, max: null } },
};

export function planLabel(name: PlanName): string {
  return PLAN_CATALOGUE[name].label;
}

// --- The claim ------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const nonNegNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,190}\.[^\s@<>",;]{2,}$/;

/** A key that must be present: a value that passes `ok`, or null when `nullable`. */
function field<T>(o: Record<string, unknown>, key: string, ok: (v: unknown) => v is T, nullable: boolean): { ok: true; v: T | null } | { ok: false } {
  if (!(key in o)) return { ok: false };
  const v = o[key];
  if (v === null) return nullable ? { ok: true, v: null } : { ok: false };
  return ok(v) ? { ok: true, v } : { ok: false };
}

/**
 * Read a licence's `cloudPlan` claim. Missing, partial or malformed reads
 * as NO plan (null), never as a guess: the plan's limits and prices decide
 * what an admin is told and billed, and a claim the console signed wrong
 * must show nothing rather than wrong numbers.
 *
 * Required: name, agentsIncluded, agentsMax, activeUsersLimit, storageGb,
 * aiAllowanceUsd, renewsAt (the limits may be null, "no limit", but must be
 * present). Optional: bufferPct (0–100, default 20), billingContact (an
 * email), priceUsd, billing ("annual", the default, or "monthly"). An
 * optional field that is present but malformed also reads as no plan.
 */
export function parsePlanClaim(raw: unknown): CloudPlan | null {
  if (!isObj(raw)) return null;
  const name = raw.name;
  if (typeof name !== "string" || !(PLAN_NAMES as readonly string[]).includes(name)) return null;
  const included = field(raw, "agentsIncluded", nonNegInt, false);
  const max = field(raw, "agentsMax", nonNegInt, true);
  const users = field(raw, "activeUsersLimit", nonNegInt, true);
  const storage = field(raw, "storageGb", nonNegNum, true);
  const ai = field(raw, "aiAllowanceUsd", nonNegNum, true);
  if (!included.ok || !max.ok || !users.ok || !storage.ok || !ai.ok) return null;
  const renews = raw.renewsAt;
  if (typeof renews !== "string" || !ISO_DAY.test(renews.slice(0, 10)) || Number.isNaN(Date.parse(renews.slice(0, 10)))) return null;
  if (max.v !== null && max.v < (included.v as number)) return null;
  let bufferPct = DEFAULT_BUFFER_PCT;
  if ("bufferPct" in raw && raw.bufferPct !== undefined) {
    if (!nonNegInt(raw.bufferPct) || raw.bufferPct > 100) return null;
    bufferPct = raw.bufferPct;
  }
  let billingContact: string | null = null;
  if ("billingContact" in raw && raw.billingContact !== undefined && raw.billingContact !== null) {
    if (typeof raw.billingContact !== "string" || !EMAIL.test(raw.billingContact.trim())) return null;
    billingContact = raw.billingContact.trim();
  }
  let priceUsd: number | null = null;
  if ("priceUsd" in raw && raw.priceUsd !== undefined && raw.priceUsd !== null) {
    if (!nonNegNum(raw.priceUsd)) return null;
    priceUsd = raw.priceUsd;
  }
  let billing: CloudPlan["billing"] = "annual";
  if ("billing" in raw && raw.billing !== undefined) {
    if (raw.billing !== "annual" && raw.billing !== "monthly") return null;
    billing = raw.billing;
  }
  return {
    name: name as PlanName,
    agentsIncluded: included.v as number,
    agentsMax: max.v,
    activeUsersLimit: users.v,
    storageGb: storage.v,
    aiAllowanceUsd: ai.v,
    bufferPct,
    renewsAt: renews.slice(0, 10),
    billingContact,
    priceUsd,
    billing,
  };
}

/** Is `s` a plausible email address (the billing contact setting)? */
export function validEmail(s: string): boolean {
  return EMAIL.test(s.trim());
}

// --- Buffer maths and meter states ------------------------------------------------------------------

/** The end of the soft buffer above `limit`: 250 → 300, 10 → 12, 25 → 30 (rounded down, never below the limit). */
export function bufferCap(limit: number, bufferPct: number = DEFAULT_BUFFER_PCT): number {
  return Math.max(limit, Math.floor((limit * (100 + bufferPct)) / 100 + 1e-9));
}

/** The four states of a meter (design A5). Storage and AI have no "past": storage is billed in steps, AI beyond the allowance is billed. */
export type MeterState = "normal" | "warn" | "over" | "past";
export type MeterKey = "agents" | "users" | "storage" | "ai";
export const METER_KEYS: readonly MeterKey[] = ["agents", "users", "storage", "ai"];

/** The 80% line. */
export const WARN_SHARE = 0.8;

/**
 * Where `value` stands against `limit` with a buffer:
 *   normal  under 80% of the limit
 *   warn    80% up to the limit
 *   over    past the limit, within the buffer
 *   past    past the buffer (agents: AT the buffer's end, where adds are held)
 * A null limit is always normal (nothing to meter). Storage and AI never
 * reach "past" (`buffer: false`).
 */
export function meterState(value: number, limit: number | null, opts: { bufferPct?: number; buffer?: boolean; heldAtCap?: boolean } = {}): MeterState {
  if (limit === null) return "normal";
  if (limit <= 0) return value > 0 ? (opts.buffer === false ? "over" : "past") : "normal";
  const cap = bufferCap(limit, opts.bufferPct);
  if (opts.buffer !== false && (opts.heldAtCap ? value >= cap : value > cap)) return "past";
  if (value > limit) return "over";
  if (value >= limit * WARN_SHARE) return "warn";
  return "normal";
}

/** A meter's state for the agents count: against the plan's maximum (not the included count), held at the buffer's end. */
export function agentsState(used: number, plan: Pick<CloudPlan, "agentsMax" | "bufferPct">): MeterState {
  return meterState(used, plan.agentsMax, { bufferPct: plan.bufferPct, heldAtCap: true });
}

/** How many agents can be on the desk before new adds are held; null = no hold. */
export function agentHoldAt(plan: Pick<CloudPlan, "agentsMax" | "bufferPct">): number | null {
  return plan.agentsMax === null ? null : bufferCap(plan.agentsMax, plan.bufferPct);
}

/** Extra (paid) agents on the desk. */
export function extraAgents(used: number, plan: Pick<CloudPlan, "agentsIncluded">): number {
  return Math.max(0, used - plan.agentsIncluded);
}

/** Extra storage steps billed for `bytes` (0 within the plan). */
export function storageSteps(bytes: number, storageGb: number | null): number {
  if (storageGb === null) return 0;
  const over = bytes - storageGb * GB;
  return over > 0 ? Math.ceil(over / (STORAGE_STEP_GB * GB)) : 0;
}

// --- Money ---------------------------------------------------------------------------------------

/** "$13.10", "$1,234.50". */
export function usd(n: number): string {
  return `$${(Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "$199" for a whole amount, else "$9.99". */
export function usdShort(n: number): string {
  return Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : usd(n);
}

/** Round to cents. */
export function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

/** "11.2 GB", "0.8 GB", "640 MB". */
export function gb(bytes: number): string {
  if (bytes < 0.1 * GB) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(Math.round((bytes / GB) * 10) / 10).toLocaleString("en-US")} GB`;
}

// --- Proration ---------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function utcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Whole days from `now` (its UTC day) to the renewal date; 0 once it has passed. */
export function daysToRenewal(now: Date, renewsAt: string): number {
  const end = Date.parse(`${renewsAt.slice(0, 10)}T00:00:00Z`);
  return Math.max(0, Math.round((end - utcDay(now)) / DAY_MS));
}

export interface Proration {
  /** What is charged now. */
  nowUsd: number;
  /** The days it covers. */
  days: number;
  /** The yearly (annual) or monthly price of one extra agent. */
  periodUsd: number;
  billing: CloudPlan["billing"];
  /** The date it runs to (the renewal, or the month's end). */
  until: string;
}

/**
 * What adding one extra agent charges now (design C1). Annual: $119.88 a
 * year (12 × $9.99) for the days to the plan's renewal, over the plan
 * year's length (the 365 or 366 days before the renewal date): 107 days to
 * 14 Mar 2027 is $35.14. Monthly: $9.99 for the rest of the month (today
 * included) over the month's days. The console charges it (Stripe prorates);
 * this is the figure the dialog shows.
 */
export function prorateExtraAgent(now: Date, plan: Pick<CloudPlan, "renewsAt" | "billing">, monthlyUsd: number = EXTRA_AGENT_USD): Proration {
  if (plan.billing === "monthly") {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const inMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const left = inMonth - now.getUTCDate() + 1;
    const until = new Date(Date.UTC(y, m + 1, 1)).toISOString().slice(0, 10);
    return { nowUsd: cents((monthlyUsd * left) / inMonth), days: left, periodUsd: monthlyUsd, billing: "monthly", until };
  }
  const yearly = cents(monthlyUsd * 12);
  const end = new Date(`${plan.renewsAt.slice(0, 10)}T00:00:00Z`);
  const start = new Date(Date.UTC(end.getUTCFullYear() - 1, end.getUTCMonth(), end.getUTCDate()));
  const yearDays = Math.round((end.getTime() - start.getTime()) / DAY_MS);
  const days = Math.min(yearDays, daysToRenewal(now, plan.renewsAt));
  return { nowUsd: cents((yearly * days) / yearDays), days, periodUsd: yearly, billing: "annual", until: plan.renewsAt.slice(0, 10) };
}

// --- Months (UTC) ------------------------------------------------------------------------------------

/** "2026-11". */
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The first day of `d`'s month, "2026-11-01". */
export function monthStart(d: Date): string {
  return `${monthKey(d)}-01`;
}

/** "2026-11-27". */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "November" (from a Date or "2026-11"). */
export function monthName(m: Date | string): string {
  const i = typeof m === "string" ? Number(m.slice(5, 7)) - 1 : m.getUTCMonth();
  return MONTHS[i] ?? "";
}

/** "Nov". */
export function monthShort(m: Date | string): string {
  return monthName(m).slice(0, 3);
}

/** "14 Mar 2027" (UTC). */
export function shortDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${monthShort(d)} ${d.getUTCFullYear()}`;
}

/** The first day of next month, "1 Dec". */
export function nextMonthStartLabel(now: Date): string {
  const n = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return `1 ${monthShort(n)}`;
}

/** The month keys of the six calendar months ending with `now`'s, oldest first. */
export function lastMonths(now: Date, count = 6): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  return out;
}

// --- The AI allowance ----------------------------------------------------------------------------------

/** Where AI spending is recorded, by feature (design A6, H). */
export type AiFeature = "desk" | "ask" | "write" | "mcp";
export const AI_FEATURES: readonly AiFeature[] = ["desk", "ask", "write", "mcp"];
export const AI_FEATURE_LABEL: Record<AiFeature, { label: (workspace: string) => string; help: string }> = {
  desk: { label: () => "Claude in the desk", help: "The desk's Claude panel" },
  ask: { label: (w) => `Ask ${w || "CompassDocs"}`, help: "Answers from your documents" },
  write: { label: () => "Write and Proofread", help: "In the document editor" },
  mcp: { label: () => "MCP tools", help: "Summaries for Claude and other apps" },
};

/** What happens past the allowance (Decision 2: keep AI on, no cap, by default). */
export type AiSpending = "keep" | "stop" | "cap";
export const AI_SPENDING: readonly AiSpending[] = ["keep", "stop", "cap"];

export interface AiSpendView {
  /** This month at cost. */
  spentUsd: number;
  allowanceUsd: number | null;
  /** Beyond the allowance, at cost. */
  beyondUsd: number;
  /** What the beyond part is billed at (× 1.3). */
  billedUsd: number;
  spending: AiSpending;
  /** The cap in force (the allowance for "stop", the amount for "cap"); null = no cap. */
  capUsd: number | null;
  /** AI is paused for the rest of the month. */
  paused: boolean;
}

/**
 * The AI allowance and the cap (design D2). The cap is checked before each
 * AI request against the running total, so it can be passed by at most the
 * one request already admitted (cents). "stop" caps at the allowance; "cap"
 * at the amount (never below the allowance); "keep" never pauses.
 */
export function aiSpend(spentUsd: number, allowanceUsd: number | null, spending: AiSpending, capAmount: number | null): AiSpendView {
  const allowance = allowanceUsd;
  const beyond = allowance === null ? 0 : Math.max(0, spentUsd - allowance);
  let cap: number | null = null;
  if (spending === "stop" && allowance !== null) cap = allowance;
  if (spending === "cap" && capAmount !== null && Number.isFinite(capAmount)) cap = allowance === null ? capAmount : Math.max(allowance, capAmount);
  return {
    spentUsd: cents(spentUsd),
    allowanceUsd: allowance,
    beyondUsd: cents(beyond),
    billedUsd: cents(beyond * (1 + AI_MARKUP)),
    spending,
    capUsd: cap,
    paused: cap !== null && spentUsd >= cap,
  };
}

/** "On pace for about $14.60 by 30 Nov": only from day 7 (design A4), else null. */
export function aiPace(spentUsd: number, now: Date): number | null {
  const day = now.getUTCDate();
  if (day < 7) return null;
  const inMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return cents((spentUsd / day) * inMonth);
}

/** The AI meter's state: an allowance is "warn" from 80%, "over" once used (beyond it, billed); never "past". */
export function aiState(view: Pick<AiSpendView, "spentUsd" | "allowanceUsd">): MeterState {
  if (view.allowanceUsd === null) return "normal";
  if (view.spentUsd >= view.allowanceUsd && view.allowanceUsd > 0) return "over";
  return meterState(view.spentUsd, view.allowanceUsd, { buffer: false });
}

// --- Thresholds and banners (design B) ----------------------------------------------------------------

/** A meter's thresholds: 80%, the limit (AI: the allowance used), past the buffer; and AI's pause. */
export type Threshold = "80" | "limit" | "past" | "paused";
const THRESHOLD_RANK: Record<Threshold, number> = { "80": 1, limit: 2, past: 3, paused: 4 };

/** The highest threshold a meter state has reached; null under 80%. */
export function thresholdOf(state: MeterState): Threshold | null {
  if (state === "warn") return "80";
  if (state === "over") return "limit";
  if (state === "past") return "past";
  return null;
}

export interface MeterReading {
  key: MeterKey;
  value: number;
  /** The limit the thresholds are against (agents: the plan's maximum); null = not metered. */
  limit: number | null;
  state: MeterState;
}

export interface PlanNotice {
  /** The month it is about ("2026-11"). */
  month: string;
  meter: MeterKey;
  threshold: Threshold;
  /** notice-info at 80% (a fact); notice-warn at the limit and past it. Never notice-error (design B1). */
  tone: "info" | "warn";
  /** The bold first sentence and the rest. */
  lead: string;
  rest: string;
}

/** A dismissal's key: one per admin, per threshold, per month (Decision 9). */
export function dismissalKey(n: Pick<PlanNotice, "month" | "meter" | "threshold">): string {
  return `${n.month}:${n.meter}:${n.threshold}`;
}

export interface NoticeContext {
  workspace: string;
  plan: CloudPlan;
  month: string;
  /** For the AI sentence. */
  ai?: AiSpendView;
  storageBytes?: number;
}

/** A share in whole percent (204 of 250 is 82%), never above 99 below the limit. */
export function pct(value: number, limit: number): number {
  const p = Math.round((value / limit) * 100);
  return value < limit ? Math.min(99, p) : p;
}

/** One meter's banner at its threshold, or null below 80% or without a limit. */
export function noticeFor(r: MeterReading, ctx: NoticeContext): PlanNotice | null {
  const { plan, workspace: w } = ctx;
  const label = planLabel(plan.name);
  const next = PLAN_CATALOGUE[plan.name].next;
  const nextLabel = next ? planLabel(next) : null;
  const base = { month: ctx.month, meter: r.key } as const;
  if (r.key === "ai") {
    const ai = ctx.ai;
    if (!ai || ai.allowanceUsd === null) return null;
    if (ai.paused) {
      return {
        ...base,
        threshold: "paused",
        tone: "warn",
        lead: `AI is paused for the rest of ${monthName(ctx.month)}.`,
        rest: `${w} reached its monthly AI limit (${usd(ai.capUsd ?? ai.spentUsd)}). Everything else works as usual; AI starts again next month, or raise the limit in Plan & usage.`,
      };
    }
    if (r.state === "over") {
      return {
        ...base,
        threshold: "limit",
        tone: "info",
        lead: `${w} has used its ${usdShort(ai.allowanceUsd)} AI allowance for ${monthName(ctx.month)}.`,
        rest: `AI keeps working; the rest of the month is billed at cost +30% (so far ${usd(ai.beyondUsd)} beyond, billed as ${usd(ai.billedUsd)}).`,
      };
    }
    if (r.state === "warn") {
      return {
        ...base,
        threshold: "80",
        tone: "info",
        lead: `${w} has used ${pct(ai.spentUsd, ai.allowanceUsd)}% of its ${usdShort(ai.allowanceUsd)} AI allowance this month.`,
        rest: "Nothing stops if it runs out: AI beyond the allowance is billed at cost +30%.",
      };
    }
    return null;
  }
  if (r.limit === null) return null;
  const t = thresholdOf(r.state);
  if (!t) return null;
  if (r.key === "users") {
    const cap = bufferCap(r.limit, plan.bufferPct);
    const lim = r.limit.toLocaleString("en-US");
    if (t === "80")
      return { ...base, threshold: t, tone: "info", lead: `${w} is at ${pct(r.value, r.limit)}% of ${label}'s ${lim} active users this month`, rest: `(${r.value.toLocaleString("en-US")} people). Nothing changes if you go over; there's a ${(cap - r.limit).toLocaleString("en-US")}-person buffer.` };
    if (t === "limit")
      return { ...base, threshold: t, tone: "warn", lead: `${w} is over ${label}'s ${lim} active users this month`, rest: `(${r.value.toLocaleString("en-US")} people). Everyone keeps signing in as normal. If it goes past ${cap.toLocaleString("en-US")}, we'll get in touch${nextLabel ? ` about ${nextLabel}` : ""}.` };
    return { ...base, threshold: t, tone: "warn", lead: `${w} has outgrown ${label}: ${r.value.toLocaleString("en-US")} active users this month, past the ${cap.toLocaleString("en-US")} buffer.`, rest: `Nobody is locked out and nothing is turned off.${next ? ` ${nextLabel} includes ${PLAN_CATALOGUE[next].summary[1]} a month.` : ""}` };
  }
  if (r.key === "agents") {
    const cap = bufferCap(r.limit, plan.bufferPct);
    if (t === "80")
      return { ...base, threshold: t, tone: "info", lead: `${w} has ${r.value} of ${label}'s ${r.limit} agents.`, rest: `${r.limit - r.value} more fit on ${label}, and ${cap - r.limit} more while we talk${nextLabel ? ` about ${nextLabel}` : ""}.` };
    if (t === "limit")
      return { ...base, threshold: t, tone: "warn", lead: `${w} has ${r.value} agents; ${label} goes up to ${r.limit}.`, rest: `Everyone on the desk keeps working, and ${Math.max(0, cap - r.value)} more can be added while we talk${nextLabel ? ` about ${nextLabel}` : ""}.` };
    return { ...base, threshold: t, tone: "warn", lead: `${w} has ${r.value} agents, ${label}'s limit with its buffer.`, rest: `Everyone on the desk keeps working; new agents wait until ${nextLabel ? `you move to ${nextLabel}` : "we talk"}.` };
  }
  // storage: no buffer; past the plan, it is billed in steps.
  const used = gb(ctx.storageBytes ?? r.value * GB);
  if (t === "80")
    return { ...base, threshold: "80", tone: "info", lead: `${w} is using ${used} of ${label}'s ${r.limit} GB.`, rest: `Nothing stops if you go over: extra storage is ${usdShort(STORAGE_STEP_USD)} a month per ${STORAGE_STEP_GB} GB.` };
  return { ...base, threshold: "limit", tone: "warn", lead: `${w} is using ${used}, past ${label}'s ${r.limit} GB.`, rest: `Everything keeps working: extra storage is ${usdShort(STORAGE_STEP_USD)} a month per ${STORAGE_STEP_GB} GB. Emptying the Trash frees space.` };
}

/**
 * The banners an admin sees: one per meter at its highest threshold this
 * month, less those this admin dismissed (a dismissal hides that threshold
 * until the next threshold or the next month). Most severe first.
 */
export function visibleNotices(readings: MeterReading[], ctx: NoticeContext, dismissed: Iterable<string>): PlanNotice[] {
  const gone = new Set(dismissed);
  const out: PlanNotice[] = [];
  for (const r of readings) {
    const n = noticeFor(r, ctx);
    if (n && !gone.has(dismissalKey(n))) out.push(n);
  }
  return out.sort((a, b) => THRESHOLD_RANK[b.threshold] - THRESHOLD_RANK[a.threshold]);
}

/**
 * Thresholds reached that have not been emailed this month: what the daily
 * count sends (several the same day go in one email). `sent` holds
 * dismissalKey-shaped keys of what went before.
 */
export function thresholdsToEmail(readings: MeterReading[], ctx: NoticeContext, sent: Iterable<string>): PlanNotice[] {
  const done = new Set(sent);
  return readings.map((r) => noticeFor(r, ctx)).filter((n): n is PlanNotice => !!n && !done.has(dismissalKey(n)));
}

// --- Plan & usage API shapes (shared by the route and the page) ------------------------------------------

export interface TrendPoint {
  month: string;
  value: number | null;
  /** The month isn't over (the point is hollow). */
  partial: boolean;
}

export interface PlanMeterView {
  key: MeterKey;
  value: number;
  limit: number | null;
  /** Where the bar's buffer ends (limit × 1.2); null without a buffer. */
  cap: number | null;
  state: MeterState;
  trend: TrendPoint[];
}

export interface PlanOverview {
  workspace: { name: string; id: string | null; address: string };
  plan: CloudPlan & { label: string; priceUsd: number; next: PlanName | null };
  /** When the counts shown were taken (ISO), and the month. */
  countedAt: string | null;
  month: string;
  nextMonthStart: string;
  meters: Record<MeterKey, PlanMeterView>;
  agents: { used: number; included: number; max: number | null; holdAt: number | null; extra: number };
  users: { byKind: Record<string, number> };
  storage: { bytes: number; limitBytes: number | null; areas: { files: number; documents: number; helpdesk: number }; notCounted: { exports: number }; steps: number };
  ai: AiSpendView & { byFeature: Record<AiFeature, number>; details: { deskTurns: number; askAnswers: number }; lastMonthUsd: number; paceUsd: number | null };
  billingContact: string;
  /** The licence in force names another workspace (design F): the plan shown is the last that matched. */
  mismatch: LicenceMismatch | null;
}

export interface LicenceMismatch {
  /** The workspace the licence in force names. */
  licenseWorkspace: string;
  /** This workspace (COMPASSDOCS_WORKSPACE_ID). */
  workspaceId: string;
  /** The last matching licence's plan, when one is kept. */
  runningOn: { plan: PlanName; renewsAt: string } | null;
}

export interface PlanPerson {
  name: string;
  /** Under their highest role. */
  countedAs: string;
  /** "Customer portal", "Editor in CompassDocs" … */
  detail: string;
  lastAt: string;
}
