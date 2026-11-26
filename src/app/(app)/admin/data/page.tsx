import { requireSettingsSection } from "@/lib/auth";
import { ImportExport } from "@/components/ImportExport";
import { MigrateImport } from "@/components/MigrateImport";
import { listSpaces } from "@/lib/db";
import { SettingsPage } from "@/components/SettingsPage";
import { EVERY_SPACE_UNFILTERED } from "@/lib/space-scope";
import { WorkspaceExport } from "@/components/WorkspaceExport";
import { EXPORT_TTL_MS, listWorkspaceExports, MAX_PER_DAY, workspaceExportAvailable } from "@/lib/workspace-export";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/data");

export default async function DataPage() {
  const user = await requireSettingsSection("/admin/data");
  // 1.21.4: a CompassDocs Cloud workspace's full export (lib/workspace-export);
  // a self-hosted install has Settings → Backups instead, and sees no change here.
  const exportable = workspaceExportAvailable() && !user.support;
  const [spaces, exports] = await Promise.all([listSpaces(EVERY_SPACE_UNFILTERED), exportable ? listWorkspaceExports() : Promise.resolve(null)]);
  return (
    <SettingsPage href="/admin/data">
    <div className="space-y-8">
      {exports && (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-slate-900">Your whole workspace</h2>
          <WorkspaceExport initial={exports} perDay={MAX_PER_DAY} keepDays={EXPORT_TTL_MS / 86_400_000} />
        </section>
      )}
      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Backup &amp; transfer</h2>
        <ImportExport />
      </section>
      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Migrate from another tool</h2>
        <MigrateImport spaces={spaces.map((s) => ({ id: s.id, name: s.name }))} />
      </section>
    </div>
    </SettingsPage>
  );
}
