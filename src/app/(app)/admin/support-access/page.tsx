import { notFound } from "next/navigation";
import { requireSettingsSection } from "@/lib/auth";
import { supportAccessEnabled } from "@/lib/cloud";
import { supportAccessOverview } from "@/lib/support";
import { SettingsPage } from "@/components/SettingsPage";
import { SupportAccessPanel } from "@/components/support/SupportAccessPanel";
import { settingsMetadata } from "@/lib/settings-sections";

export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/support-access");

// 1.21.4: Settings → Support access (lib/support). Only in a CompassDocs
// Cloud workspace with support access configured; anywhere else the page
// does not exist. A support session never reaches it (lib/support-policy).
export default async function SupportAccessPage() {
  if (!supportAccessEnabled()) notFound();
  const user = await requireSettingsSection("/admin/support-access");
  if (user.support) notFound();
  const overview = await supportAccessOverview();
  return (
    <SettingsPage href="/admin/support-access" docs={false}>
      <SupportAccessPanel overview={overview} />
    </SettingsPage>
  );
}
