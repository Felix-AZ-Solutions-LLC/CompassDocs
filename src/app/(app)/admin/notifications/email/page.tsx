import Link from "next/link";
import { requireSettingsSection } from "@/lib/auth";
import { MailSettings } from "@/components/MailSettings";
import { mailView } from "@/lib/mail-config";
import { EMAIL_TEMPLATES, templateOverride } from "@/lib/email-templates";

import { settingsMetadata } from "@/lib/settings-sections";
export const dynamic = "force-dynamic";
export const metadata = settingsMetadata("/admin/notifications", "Email");

// 1.20.31: how the workspace's email is sent, SMTP or Microsoft 365 (components/MailSettings, lib/mail-config).
export default async function EmailPage() {
  await requireSettingsSection("/admin/notifications");
  const view = await mailView();
  const customized = (
    await Promise.all(EMAIL_TEMPLATES.map((t) => templateOverride(t.key)))
  ).filter(Boolean).length;
  return (
    <div>
      <MailSettings initial={view} />
      <p className="mt-6 text-sm text-slate-500">
        {customized > 0
          ? `${customized} of ${EMAIL_TEMPLATES.length} email templates are customized.`
          : `All ${EMAIL_TEMPLATES.length} email templates are at their defaults.`}{" "}
        <Link href="/admin/notifications/templates" className="link font-medium">
          Edit email templates
        </Link>
      </p>
    </div>
  );
}
