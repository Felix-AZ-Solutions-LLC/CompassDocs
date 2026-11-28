import { notFound } from "next/navigation";
import { requireSettingsSection } from "@/lib/auth";
import { isCloud, PLAN_SECTION } from "@/lib/cloud";
import { SettingsPage } from "@/components/SettingsPage";
import { SubNav } from "@/components/SubNav";
import { PlanHeaderActions } from "@/components/plan/PlanUsage";

export const dynamic = "force-dynamic";

// 1.22.0: Settings → Plan & usage (lib/plan, design A). Only in a
// CompassDocs Cloud workspace: self-hosted, the pages do not exist. The
// pages read GET /api/admin/plan, which answers 404 without a plan in the
// licence (the page then says so); the rail lists the section only with
// one (lib/auth reachableSettingsSections).
export default async function PlanLayout({ children }: { children: React.ReactNode }) {
  if (!isCloud()) notFound();
  const user = await requireSettingsSection(PLAN_SECTION);
  return (
    <SettingsPage href={PLAN_SECTION} actions={<PlanHeaderActions email={user.email ?? ""} />}>
      <SubNav label="Plan & usage" section={PLAN_SECTION} root={PLAN_SECTION} />
      {children}
    </SettingsPage>
  );
}
