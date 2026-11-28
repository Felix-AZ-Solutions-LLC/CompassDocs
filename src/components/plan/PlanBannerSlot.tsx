// Where the plan's admin banner goes (1.22.0, design B1 and B2): the
// dashboard under the greeting and every settings page under the eyebrow,
// only in cloud mode and only for whoever can open Plan & usage
// (workspace.settings_manage). Everyone else, and every self-hosted
// workspace, gets nothing: no banner, no request. Server component.

import { isCloud } from "@/lib/cloud";
import { roleAtLeast, type SessionUser } from "@/lib/types";
import { PlanBanner } from "./PlanBanner";

/** May this person see the plan's warnings (and open Plan & usage)? Cloud mode only. */
export async function canSeePlanNotices(user: SessionUser): Promise<boolean> {
  if (!isCloud() || user.support) return false;
  const { legacyAuthzEnforcement, grantsFor, admits } = await import("@/lib/authz");
  if (legacyAuthzEnforcement()) return roleAtLeast(user.role, "admin");
  try {
    return admits(await grantsFor(user.id), "workspace.settings_manage");
  } catch {
    return false;
  }
}

export async function PlanBannerSlot({ user, place }: { user: SessionUser; place: "dashboard" | "settings" }) {
  if (!(await canSeePlanNotices(user))) return null;
  return <PlanBanner place={place} />;
}
