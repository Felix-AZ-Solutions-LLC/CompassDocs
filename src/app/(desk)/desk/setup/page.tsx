// /desk/setup: the setup checklist (helpdesk managers).

import { requireUser, reachableSettingsSections } from "@/lib/auth";
import { ReachableSettingsProvider } from "@/components/SettingsLink";
import { DeskPageForbidden } from "@/components/helpdesk/desk/DeskGate";
import { SetupChecklist } from "@/components/helpdesk/desk/setup/SetupChecklist";
import { canOpenSettings } from "../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set up your helpdesk" };

export default async function SetupPage() {
  const user = await requireUser();
  if (!(await canOpenSettings(user, "setup"))) return <DeskPageForbidden what="Setup" />;
  // 1.20.27: the address step links Domain & HTTPS only for someone who can open it.
  const sections = await reachableSettingsSections(user).catch(() => [] as string[]);
  return (
    <ReachableSettingsProvider sections={sections}>
      <SetupChecklist />
    </ReachableSettingsProvider>
  );
}
