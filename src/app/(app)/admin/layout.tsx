import { redirect } from "next/navigation";
import { Settings } from "lucide-react";
import { requireUser, reachableSettingsSections } from "@/lib/auth";
import { SettingsNav } from "@/components/SettingsNav";
import { SettingsJumpHighlight } from "@/components/SettingsJumpHighlight";
import { PageContainer } from "@/components/PageWidth";
import { RAIL_GROUP_TEXT } from "@/components/RailLink";
import { getAllSettings } from "@/lib/db";
import { duoSwitchedOn } from "@/lib/duo-policy";
import { licenseState } from "@/lib/license";
import { licenceDaysLeft } from "@/lib/license-enforcement";
import { eePresent } from "@/lib/ee";

/** Days before expiry the settings pages start saying so (1.20.27, security review M4). */
const LICENCE_WARN_DAYS = 30;

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Enforcement lives on each page, not here (0.93): the console is no longer
  // all-or-nothing, so a role holding one settings permission gets that section
  // and nothing else. The layout only decides whether there is anything at all
  // to show, and which entries the rail may link to.
  const user = await requireUser();
  const reachable = await reachableSettingsSections(user);
  if (reachable.length === 0) redirect("/");
  // 1.20.5: the server's emergency switch is holding the Duo rules off. Say so
  // on every settings page until it is removed. Read only when the switch is set.
  const duoHeldOff = process.env.COMPASSDOCS_DUO_DISABLED === "1" && duoSwitchedOn(await getAllSettings());
  // 1.20.27 (security review M4): a licence about to lapse, or lapsed, is
  // said on every settings page to whoever can open the License section.
  // Its security controls keep being enforced after it lapses; only their
  // settings stop changing.
  let licenceNote: { days: number; expires: string } | null = null;
  if (eePresent() && reachable.includes("/admin/license")) {
    const state = await licenseState();
    const days = licenceDaysLeft(state);
    if (days !== null && days <= LICENCE_WARN_DAYS && "license" in state) licenceNote = { days, expires: state.license.expires };
  }

  return (
    <PageContainer>
      {/* An eyebrow, not a heading: the section (SettingsPage) is the page's
          h1. "Settings — Manage your workspace" on every admin page pushed the
          first control 250px down and gave the console two h1-sized titles. */}
      <p className={`mb-4 flex items-center gap-1.5 ${RAIL_GROUP_TEXT}`}>
        <Settings className="h-3.5 w-3.5" aria-hidden /> Settings
      </p>
      {duoHeldOff && (
        <div className="notice-warn mb-4 rounded-lg border px-3 py-2 text-sm">
          Duo is switched off on the server (<code className="font-mono text-xs">COMPASSDOCS_DUO_DISABLED=1</code>). Nobody is being asked
          for Duo. Remove it and restart to enforce your Duo rules again.
        </div>
      )}
      {licenceNote && (
        <div className={`${licenceNote.days < 0 ? "notice-error" : "notice-warn"} mb-4 rounded-lg border px-3 py-2 text-sm`}>
          {licenceNote.days > 0
            ? `Your Enterprise licence expires in ${licenceNote.days} day${licenceNote.days === 1 ? "" : "s"}. `
            : licenceNote.days === 0
              ? "Your Enterprise licence expires today. "
              : "Your Enterprise licence has expired. "}
          Single sign-on, SSO only, SCIM deprovisioning and Duo keep being enforced after it lapses, but their settings can&apos;t be changed,
          and other Enterprise features stop, until it is renewed.{" "}
          <a href="/admin/license" className="link font-medium">
            Open License
          </a>
        </div>
      )}
      <div className="flex flex-col gap-6 sm:flex-row sm:gap-8">
        {/* Sticky and self-scrolling: the 20-entry rail stays put while a long
            page (Workspace, Notifications, Backups) scrolls, and fits a
            900px-tall laptop by scrolling inside its own box. self-start is
            what lets a flex child stick at all. */}
        <div className="shrink-0 sm:sticky sm:top-6 sm:max-h-[calc(100vh-3rem)] sm:self-start sm:overflow-y-auto sm:overscroll-contain">
          <SettingsNav reachable={reachable} />
        </div>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
      {/* 1.20.13: a search result's #anchor scrolls to its card and flashes it. */}
      <SettingsJumpHighlight />
    </PageContainer>
  );
}
