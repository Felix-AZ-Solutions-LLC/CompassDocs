import { PlanUsage } from "@/components/plan/PlanUsage";
import { settingsMetadata } from "@/lib/settings-sections";

export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/plan", "Storage");

// The layout guards (cloud mode, workspace.settings_manage); the tab reads GET /api/admin/plan.
export default function Page() {
  return <PlanUsage tab="storage" />;
}
