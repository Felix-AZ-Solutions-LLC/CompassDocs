import { requireSettingsSection } from "@/lib/auth";
import { domainState } from "@/lib/domain-flow";
import { DomainSettings } from "@/components/DomainSettings";
import { SettingsPage } from "@/components/SettingsPage";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/domain");

export default async function DomainPage() {
  await requireSettingsSection("/admin/domain");
  // 1.20.29: with the domain waiting for its check and the fallback addresses.
  const initial = await domainState();
  return (
    <SettingsPage href="/admin/domain">
      <DomainSettings initial={initial} />
    </SettingsPage>
  );
}
