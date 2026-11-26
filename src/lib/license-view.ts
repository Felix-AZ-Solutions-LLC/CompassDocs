// The license page's view of the license (Settings → License; /api/admin/license
// and, 1.21.3, its Check now). Client-safe: the raw license token is never
// echoed back; its (non-secret) decoded claims are fine to display.
//
// Server-only.

import "server-only";
import { licenseManagedByCloud, licensePullConfig } from "./cloud";
import { getDatabaseStats } from "./db";
import { licenseState, licenseSource, effectiveFeatures, agentsClaim, agentAllowanceFor, BUY_AGENTS_URL } from "./license";
import type { EntitlementFeature } from "./license";
import { ee, eePresent, featureEnabled } from "./ee";

// All entitlements the product knows about, with friendly labels for the UI.
const ALL_FEATURES: { key: EntitlementFeature; label: string }[] = [
  { key: "helpdesk", label: "Helpdesk" },
  { key: "sso", label: "Single sign-on (SSO)" },
  { key: "scim", label: "SCIM provisioning" },
  { key: "audit_export", label: "Audit-log export" },
  { key: "priority_support", label: "Dedicated support (48-hour response)" },
  { key: "directory_sync", label: "Microsoft 365 directory sync" },
  { key: "policy_ack", label: "Policy acknowledgments" },
  { key: "training", label: "Training & onboarding" },
];

// How many people count against the helpdesk agent allowance (everyone on
// Settings → Agents); null when the helpdesk isn't on (not in this build,
// or not licensed), so there are no agents to count. Loaded lazily.
async function deskAgentsUsed(): Promise<number | null> {
  if (!(await featureEnabled("helpdesk"))) return null;
  const { countDeskAgents } = await import("./helpdesk/roles-agents");
  return countDeskAgents();
}

/** The page's view (GET /api/admin/license). */
export async function licenseView() {
  const pull = !!licensePullConfig();
  const [s, source, stats, agentsUsed, pullStatus] = await Promise.all([
    licenseState(),
    licenseSource(),
    getDatabaseStats(),
    deskAgentsUsed(),
    pull ? import("./license-pull").then((m) => m.readPullStatus()) : Promise.resolve(null),
  ]);
  const bundled = ee().features;
  const licensed =
    s.status === "active" || s.status === "grace" ? effectiveFeatures(s.license) : [];

  const license =
    "license" in s
      ? {
          customer: s.license.customer,
          plan: s.license.plan,
          seats: s.license.seats,
          // The key's agent allowance whatever the licence's state (null =
          // unlimited); agentsAllowed below is the one in force.
          agents: agentsClaim(s.license),
          issued: s.license.issued,
          expires: s.license.expires,
        }
      : null;

  return {
    edition: eePresent() ? "enterprise" : "community",
    source, // cloud | platform | settings | env | none
    // 1.21.3: in cloud mode the license is CompassDocs Cloud's (COMPASSDOCS_LICENSE_KEY
    // and/or the console's COMPASSDOCS_LICENSE_URL): shown, never pasted or removed here.
    // `pull`: the console is asked (Check now); `check`: its last outcome (never a token or ETag).
    cloud: licenseManagedByCloud()
      ? {
          pull,
          check: pullStatus
            ? { checkedAt: pullStatus.checkedAt, result: pullStatus.result, message: pullStatus.message, updatedAt: pullStatus.updatedAt ?? null }
            : null,
        }
      : null,
    status: s.status, // none | invalid | active | grace | expired
    reason: s.status === "invalid" ? s.reason : undefined,
    daysLeft: s.status === "active" || s.status === "grace" ? s.daysLeft : undefined,
    license,
    seatsUsed: stats.users,
    // The helpdesk agent allowance in force (null = unlimited: no limit on
    // the key, or the licence is in grace) and how many count against it
    // (null when the helpdesk isn't licensed in this build).
    agentsAllowed: agentAllowanceFor(s),
    agentsUsed,
    buyAgentsUrl: BUY_AGENTS_URL,
    features: ALL_FEATURES.map((f) => ({
      key: f.key,
      label: f.label,
      bundled: bundled.includes(f.key), // present in this build
      licensed: licensed.includes(f.key), // granted by the license
      active: bundled.includes(f.key) && licensed.includes(f.key),
    })),
  };
}

