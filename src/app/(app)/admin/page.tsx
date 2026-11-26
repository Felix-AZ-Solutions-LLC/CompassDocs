import { requireSettingsSection } from "@/lib/auth";
import { getSystemInfo } from "@/lib/system-info";
import { getAppSettings } from "@/lib/settings-store";
import { runDiagnostics } from "@/lib/diagnostics";
import { isCloud } from "@/lib/cloud";
import { SystemPanel } from "@/components/SystemPanel";
import { UpdatePanel } from "@/components/UpdatePanel";
import { DiagnosticsPanel } from "@/components/DiagnosticsPanel";
import { SettingsPage } from "@/components/SettingsPage";
import { Card } from "@/components/Card";
import { Chip } from "@/components/Chip";
import { CloudManagedNote } from "@/components/CloudManaged";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin");

export default async function SystemPage() {
  await requireSettingsSection("/admin");
  const cloud = isCloud();
  const [info, settings, checks] = await Promise.all([
    getSystemInfo(),
    getAppSettings(),
    runDiagnostics(),
  ]);
  return (
    <SettingsPage href="/admin">
    <div className="space-y-4">
      {/* 1.21.0: CompassDocs Cloud installs new versions (lib/cloud), so the
          update check and the one-click updater give way to a note. */}
      {cloud ? (
        <Card
          padding="p-4"
          title="Version & updates"
          actions={<Chip>v{info.app.version}</Chip>}
        >
          <CloudManagedNote area="updates" />
        </Card>
      ) : (
        <UpdatePanel />
      )}
      <DiagnosticsPanel initial={checks} />
      <SystemPanel info={info} settings={settings} cloud={cloud} />
    </div>
    </SettingsPage>
  );
}
