// /desk/settings: the settings overview (1.20.13; until then a redirect to
// the first page this person's desk role reaches). Every section the role
// opens, by group, from the desk settings registry. The (desk) layout gates
// the licence first; every desk user reaches at least Notifications.

import { requireUser, reachableSettingsSections } from "@/lib/auth";
import { DeskSettingsHome } from "@/components/helpdesk/desk/settings/DeskSettingsHome";
import { deskSettingsViewer } from "@/components/helpdesk/desk/settings/settings-nav";
import { deskRoleCaps } from "../../desk-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function DeskSettingsIndex() {
  const user = await requireUser();
  const [role, adminSections] = await Promise.all([deskRoleCaps(user), reachableSettingsSections(user).catch(() => [] as string[])]);
  return <DeskSettingsHome viewer={deskSettingsViewer(role.caps, adminSections)} />;
}
