import { requireSettingsSection } from "@/lib/auth";
import { listAuditLog, auditCategories } from "@/lib/audit";
import { featureEnabled } from "@/lib/ee";
import { AuditLog } from "@/components/AuditLog";
import { SettingsPage } from "@/components/SettingsPage";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/audit");

const PAGE_SIZE = 50;

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  await requireSettingsSection("/admin/audit");
  // 1.21.4: ?category= opens the log filtered (Support access links to "support").
  const asked = (await searchParams).category ?? "";
  const categories = await auditCategories();
  const category = categories.includes(asked) ? asked : "";
  const [{ rows, total }, exportEnabled] = await Promise.all([
    listAuditLog({ limit: PAGE_SIZE, offset: 0, ...(category ? { category } : {}) }),
    featureEnabled("audit_export"),
  ]);
  return (
    <SettingsPage href="/admin/audit">
    <AuditLog
      initial={{ rows, total, categories, limit: PAGE_SIZE, category }}
      exportEnabled={exportEnabled}
    />
    </SettingsPage>
  );
}
