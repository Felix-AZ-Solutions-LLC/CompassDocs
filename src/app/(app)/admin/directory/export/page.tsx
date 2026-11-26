import { requireSettingsSection } from "@/lib/auth";
import { getSetting } from "@/lib/db";
import { listFields } from "@/lib/directory";
import { listExportPresets } from "@/lib/directory-export-config";
import { listMarkers } from "@/lib/directory-markers";
import { getExportRunLog } from "@/lib/directory-export-schedule";
import { getMailMethod, mailConfigured } from "@/lib/mail-config";
import { DirectoryExportPanel } from "@/components/directory-admin/DirectoryExportPanel";

import { settingsMetadata } from "@/lib/settings-sections";
import { originForDomain } from "@/lib/workspace-origin";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/directory", "Export");

export default async function DirectoryExportPage() {
  await requireSettingsSection("/admin/directory");
  const fields = await listFields();
  // The markers first: the presets' marker ids are checked against them.
  const markers = await listMarkers(fields);
  const [presets, smtp, runLog, domain, method] = await Promise.all([
    listExportPresets(fields, markers),
    mailConfigured(),
    getExportRunLog(),
    getSetting("custom_domain"),
    getMailMethod(),
  ]);
  // Download links go out by email, so they carry the address people know
  // the workspace by (the custom domain, as other emailed links do); without
  // one the editor uses the browser's own origin.
  const linkOrigin = originForDomain(domain) ?? undefined;
  return (
    <DirectoryExportPanel
      fields={fields}
      initialPresets={presets}
      initialMarkers={markers}
      smtpConfigured={smtp}
      mailM365={method === "m365"}
      runLog={runLog}
      linkOrigin={linkOrigin}
    />
  );
}
