// Security controls outlive the licence (1.20.27, security review M4).
//
// lib/license answers "may this feature be USED and CONFIGURED": an active
// licence or one in its 14-day grace. That stays the gate for every settings
// page and every configuration change. But a lapsed renewal must not quietly
// switch a firm's protections off: Duo stopping being asked, "SSO only"
// letting passwords back in, Entra's deprovisioning calls answered 403 so
// leavers stay active. So the ENFORCEMENT of those controls asks a weaker
// question: has a licence verified by our signature ever granted the
// feature? An expired licence still has. No licence, or one that does not
// verify, never has.
//
// Nothing here touches lib/license; it reads only its exports. Server-only.

import "server-only";
import { effectiveFeatures, effectiveLicenseKey, evaluate, licenseKey, type EntitlementFeature, type LicenseState } from "./license";

/** The enforcement answer for a licence state (pure; exported for tests). */
export function stateEnforces(state: LicenseState, feature: EntitlementFeature): boolean {
  if (state.status !== "active" && state.status !== "grace" && state.status !== "expired") return false;
  return effectiveFeatures(state.license).includes(feature);
}

/** Does a verified licence, current or expired, grant `feature`? (Not whether the code is in this build: see lib/ee featureEnforced.) */
export async function licenceEnforces(feature: EntitlementFeature): Promise<boolean> {
  return stateEnforces(evaluate(await licenseKey()), feature);
}

// Remembered for a minute per key, like lib/ee featureEnabledFrom: the Duo
// check asks on every request of a workspace that enforces it.
let memo: { key: string; until: number; state: LicenseState } | null = null;

/** licenceEnforces for a caller that already holds the settings map: no query. */
export function licenceEnforcesFrom(feature: EntitlementFeature, settings: Record<string, string>): boolean {
  const key = effectiveLicenseKey(settings.license_key);
  const now = Date.now();
  if (!memo || memo.key !== key || now >= memo.until) memo = { key, until: now + 60_000, state: evaluate(key) };
  return stateEnforces(memo.state, feature);
}

/** Days until the licence stops being active (negative once expired); null without a verified licence. */
export function licenceDaysLeft(state: LicenseState, now = new Date()): number | null {
  if (state.status !== "active" && state.status !== "grace" && state.status !== "expired") return null;
  return Math.ceil((new Date(state.license.expires).getTime() - now.getTime()) / 86_400_000);
}
