// /desk/settings/*: the desk's configuration, a settings rail beside the
// page. The rail shows the sections the person's desk role reaches; each page
// checks its own capability too. 1.19.2 (agent W5, lib/helpdesk/whats-new):
// what this person has not seen yet (the rail's New chips, the release
// strip) is read here and shared with the rail and the pages.
//
// 1.20.13: the rail, its search and the tabbed sections come from one
// registry (lib/helpdesk/desk-settings-registry), drawn with the CompassDocs
// settings components (SettingsRail, PageHeader, SubNav). DeskSettingsChrome
// puts a tabbed section's header and tab row over its pages, and
// SettingsJumpHighlight lands a search result on its setting. This layout
// owns the page's scroll container (the desk shell's are not touched).

import { requireUser, reachableSettingsSections } from "@/lib/auth";
import { DeskSettingsNav } from "@/components/helpdesk/desk/settings/DeskSettingsNav";
import { DeskSettingsChrome } from "@/components/helpdesk/desk/settings/DeskSettingsChrome";
import { DeskNewProvider } from "@/components/helpdesk/desk/settings/DeskNew";
import { SettingsJumpHighlight } from "@/components/SettingsJumpHighlight";
import { ReachableSettingsProvider } from "@/components/SettingsLink";
import { deskSettingsViewer } from "@/components/helpdesk/desk/settings/settings-nav";
import { DESK_SETTINGS_PAGES, canOpenDeskSettingsPage } from "@/lib/helpdesk/desk-settings-registry";
import { deskNewState } from "@/lib/helpdesk/whats-new";
import { deskRoleCaps } from "../../desk-access";

export default async function DeskSettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [role, adminSections] = await Promise.all([deskRoleCaps(user), reachableSettingsSections(user).catch(() => [] as string[])]);
  const viewer = deskSettingsViewer(role.caps, adminSections);
  const fresh = await deskNewState(
    user.id,
    DESK_SETTINGS_PAGES.filter((p) => !p.adminSection && canOpenDeskSettingsPage(viewer, p)).map((p) => p.href)
  );
  // 1.20.27: the CompassDocs settings this person can open, so a desk page's SettingsLink to
  // Settings → AI or Domain & HTTPS is a link for those who can open it and plain text otherwise.
  return (
    <ReachableSettingsProvider sections={adminSections}>
    <DeskNewProvider initial={fresh}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
        <DeskSettingsNav viewer={viewer} />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <DeskSettingsChrome viewer={viewer}>{children}</DeskSettingsChrome>
        </div>
      </div>
      <SettingsJumpHighlight />
    </DeskNewProvider>
    </ReachableSettingsProvider>
  );
}
