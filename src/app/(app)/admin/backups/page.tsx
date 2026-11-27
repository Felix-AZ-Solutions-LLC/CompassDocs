import { requireSettingsSection } from "@/lib/auth";
import { listBackups } from "@/lib/backup";
import { destinationStatus } from "@/lib/backup-destinations";
import { getBackupDestState } from "@/lib/backup-config";
import { getAppSettings } from "@/lib/settings-store";
import { isCloud } from "@/lib/cloud";
import { BackupsClient } from "@/components/BackupsClient";
import { BackupDestinations } from "@/components/BackupDestinations";
import { CloudManagedPage } from "@/components/CloudManaged";
import { SettingsPage } from "@/components/SettingsPage";
import { PackageOpen } from "lucide-react";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/backups");

export default async function BackupsPage() {
  await requireSettingsSection("/admin/backups");
  // 1.21.0: CompassDocs Cloud backs the workspace up (lib/cloud); the section
  // is out of the rail, and an old link lands on this note.
  if (isCloud()) {
    return (
      <SettingsPage href="/admin/backups" docs={false}>
        <CloudManagedPage area="backups" action={{ href: "/admin/data#workspace-export", label: "Export your workspace", icon: <PackageOpen /> }} />
      </SettingsPage>
    );
  }
  const [backups, settings, destinations, destState] = await Promise.all([
    listBackups(),
    getAppSettings(),
    destinationStatus(),
    getBackupDestState(),
  ]);
  return (
    <SettingsPage href="/admin/backups">
    <div className="space-y-8">
      <BackupsClient backups={backups} destinations={destinations} settings={settings} />
      <BackupDestinations initial={destState} />
    </div>
    </SettingsPage>
  );
}
