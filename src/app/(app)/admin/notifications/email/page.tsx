import Link from "next/link";
import { requireSettingsSection } from "@/lib/auth";
import { MailSettings } from "@/components/MailSettings";
import { mailView } from "@/lib/mail-config";
import { outboxView } from "@/lib/mail-outbox";
import { roleAtLeast, type Role } from "@/lib/types";
import { listedTemplates, templateOverride } from "@/lib/email-templates";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/notifications", "Email");

async function maySeeOutbox(user: { id: number; role: Role }): Promise<boolean> {
  try {
    const { legacyAuthzEnforcement, grantsFor, admits } = await import("@/lib/authz");
    if (legacyAuthzEnforcement()) return roleAtLeast(user.role, "admin");
    return admits(await grantsFor(user.id), "integration.smtp_read");
  } catch {
    return false;
  }
}

// 1.20.31: how the workspace's email is sent, SMTP or Microsoft 365 (components/MailSettings, lib/mail-config).
export default async function EmailPage() {
  const user = await requireSettingsSection("/admin/notifications");
  const view = await mailView();
  // 1.20.32: the Microsoft 365 outbox (lib/mail-outbox), shown under the card to whoever may read the mail settings
  // (integration.smtp_read, as GET /api/admin/mail/outbox asks).
  const outbox = (await maySeeOutbox(user)) ? await outboxView().catch(() => null) : null;
  const customized = (
    await Promise.all(listedTemplates().map((t) => templateOverride(t.key)))
  ).filter(Boolean).length;
  return (
    <div>
      <MailSettings initial={view} outbox={outbox} />
      <p className="mt-6 text-sm text-slate-500">
        {customized > 0
          ? `${customized} of ${listedTemplates().length} email templates are customized.`
          : `All ${listedTemplates().length} email templates are at their defaults.`}{" "}
        <Link href="/admin/notifications/templates" className="link font-medium">
          Edit email templates
        </Link>
      </p>
    </div>
  );
}
