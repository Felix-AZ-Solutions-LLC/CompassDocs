import { requireSettingsSection } from "@/lib/auth";
import { domainState } from "@/lib/domain-flow";
import { isCloud } from "@/lib/cloud";
import { DomainSettings } from "@/components/DomainSettings";
import { CloudManagedPage } from "@/components/CloudManaged";
import { SettingsPage } from "@/components/SettingsPage";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/domain");

export default async function DomainPage() {
  await requireSettingsSection("/admin/domain");
  // 1.21.0: CompassDocs Cloud owns the address and HTTPS (lib/cloud); the
  // section is out of the rail, and an old link lands on this note.
  if (isCloud()) {
    return (
      <SettingsPage href="/admin/domain" docs={false}>
        <CloudManagedPage area="domain" />
      </SettingsPage>
    );
  }
  // 1.20.29: with the domain waiting for its check and the fallback addresses.
  const initial = await domainState();
  return (
    <SettingsPage href="/admin/domain">
      <DomainSettings initial={initial} />
    </SettingsPage>
  );
}
