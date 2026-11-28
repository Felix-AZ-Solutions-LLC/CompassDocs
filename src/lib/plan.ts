// The CompassDocs Cloud plan in force (1.22.0): the one switch for
// everything plan-related (design E1). A plan exists only when
//
//   - this is a cloud workspace (lib/cloud isCloud: COMPASSDOCS_CLOUD=1), and
//   - the licence in force (lib/license) is active or in its grace, and
//     carries a `cloudPlan` claim that parses (lib/plan-shared
//     parsePlanClaim: missing, partial or malformed is no plan).
//
// Self-hosted, or a cloud workspace on an Enterprise licence (a migrated
// customer), has no plan: no Plan & usage section, its APIs answer 404, the
// daily count does not run, no banner, no price step, no AI cap. Their
// seats and agents rules are exactly as in 1.21.5.
//
// The licence names its workspace (design F). With COMPASSDOCS_WORKSPACE_ID
// set, a licence carrying a plan is used for the plan only when its
// `workspace` claim is this workspace, the platform's bootstrap licence
// included. One that names another workspace changes nothing: the
// workspace keeps running on the last licence whose plan matched (kept in
// PLAN_LAST_MATCH_SETTING), never read-only (Decision 6), and the admins
// see the notice. With none kept, there is no plan until it is fixed.
//
// Server-only. Read on every call it can be (memoised for 30 seconds: the
// banner, the AI cap and the agent price step all ask).

import "server-only";
import { isCloud, PLAN_SECTION } from "./cloud";
import { getSetting, setSetting } from "./db";
import { GRACE_DAYS, licenseKey, parseLicense, type License } from "./license";
import { parsePlanClaim, type CloudPlan, type LicenceMismatch } from "./plan-shared";
import { roleAtLeast, type SessionUser } from "./types";

/** The last licence whose plan named this workspace (a token), for a mismatch (design F). */
export const PLAN_LAST_MATCH_SETTING = "plan_license_last_match";

type Parse = (raw: string) => { license?: License; error?: string };

export interface PlanState {
  plan: CloudPlan;
  /** The licence the plan comes from. */
  license: License;
  /** "in_force": the licence in force; "last_match": the last one that named this workspace (the one in force names another). */
  source: "in_force" | "last_match";
  mismatch: LicenceMismatch | null;
}

export interface PlanResolution {
  state: PlanState | null;
  /** The licence in force carries a plan for another workspace (null otherwise, plan or not). */
  mismatch: LicenceMismatch | null;
  /** A token to keep as the last match (it differs from the one kept), or null. */
  remember: string | null;
}

/** Active or in grace, by lib/license's dates. */
function current(l: License, now: Date): boolean {
  const end = Date.parse(l.expires);
  return Number.isFinite(end) && now.getTime() <= end + GRACE_DAYS * 86_400_000;
}

/**
 * Pure: the plan, given the licence in force, the last match kept, this
 * workspace's id and the time. `parse` is lib/license parseLicense in the
 * app (tests sign with their own key).
 */
export function resolvePlan(
  input: { inForce: string; lastMatch?: string | null; workspaceId: string | null; now: Date },
  parse: Parse = parseLicense
): PlanResolution {
  const token = input.inForce.trim();
  const lic = token ? parse(token).license : undefined;
  const plan = lic && current(lic, input.now) ? parsePlanClaim(lic.cloudPlan) : null;
  if (!lic || !plan) return { state: null, mismatch: null, remember: null };
  const ws = input.workspaceId?.trim() || null;
  if (!ws || lic.workspace === ws) {
    const remember = ws && token !== (input.lastMatch ?? "").trim() ? token : null;
    return { state: { plan, license: lic, source: "in_force", mismatch: null }, mismatch: null, remember };
  }
  // The licence in force names another workspace: the last that matched, if any.
  const keptToken = (input.lastMatch ?? "").trim();
  const kept = keptToken ? parse(keptToken).license : undefined;
  const keptPlan = kept && kept.workspace === ws && current(kept, input.now) ? parsePlanClaim(kept.cloudPlan) : null;
  const mismatch: LicenceMismatch = {
    licenseWorkspace: String(lic.workspace ?? "").slice(0, 64) || "no workspace",
    workspaceId: ws,
    runningOn: kept && keptPlan ? { plan: keptPlan.name, renewsAt: keptPlan.renewsAt } : null,
  };
  return { state: kept && keptPlan ? { plan: keptPlan, license: kept, source: "last_match", mismatch } : null, mismatch, remember: null };
}

/** COMPASSDOCS_WORKSPACE_ID, when set. */
export function workspaceId(env: Record<string, string | undefined> = process.env): string | null {
  return env.COMPASSDOCS_WORKSPACE_ID?.trim() || null;
}

const G = globalThis as unknown as { __compassPlan?: { until: number; value: PlanResolution } | null; __compassPlanTest?: PlanResolution | null };

/** Tests: forget the remembered answer. */
export function resetPlanMemoForTests(): void {
  G.__compassPlan = null;
}

/**
 * Tests: answer this resolution instead of reading the licence (null: the
 * real one). Cloud mode is still required. No test can hold a licence the
 * vendor signed, so the DB-backed tests of the count, the cap and the agent
 * rules stand a plan in here; resolvePlan is tested with its own key.
 */
export function setPlanForTests(r: PlanResolution | null): void {
  G.__compassPlanTest = r;
  G.__compassPlan = null;
}

/** The plan resolution now (cloud mode only; self-hosted is always no plan, no mismatch). */
export async function planResolution(): Promise<PlanResolution> {
  if (!isCloud()) return { state: null, mismatch: null, remember: null };
  if (G.__compassPlanTest) return G.__compassPlanTest;
  const now = Date.now();
  const memo = G.__compassPlan;
  if (memo && now < memo.until) return memo.value;
  const [inForce, lastMatch] = await Promise.all([licenseKey(), getSetting(PLAN_LAST_MATCH_SETTING)]);
  const value = resolvePlan({ inForce, lastMatch, workspaceId: workspaceId(), now: new Date(now) });
  if (value.remember) await setSetting(PLAN_LAST_MATCH_SETTING, value.remember).catch(() => {});
  G.__compassPlan = { until: now + 30_000, value };
  return value;
}

/** The plan in force with its licence, or null (no plan: see the module's header). */
export async function cloudPlanState(): Promise<PlanState | null> {
  return (await planResolution()).state;
}

/** The plan in force, or null. */
export async function cloudPlan(): Promise<CloudPlan | null> {
  return (await cloudPlanState())?.plan ?? null;
}

/** The Plan & usage settings section (and everything under it). */
export { PLAN_SECTION };

/**
 * May this person open Plan & usage, and so see the plan's prices, warnings
 * and upgrade (design B2: "an admin" here is workspace.settings_manage)?
 * Cloud mode only; never a CompassDocs support session.
 */
export async function isPlanAdmin(user: Pick<SessionUser, "id" | "role" | "support">): Promise<boolean> {
  if (!isCloud() || user.support) return false;
  const { legacyAuthzEnforcement, grantsFor, admits } = await import("./authz");
  if (legacyAuthzEnforcement()) return roleAtLeast(user.role, "admin");
  try {
    return admits(await grantsFor(user.id), "workspace.settings_manage");
  } catch {
    return false;
  }
}
