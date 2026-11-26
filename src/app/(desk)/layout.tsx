// The desk (1.19.0, /desk): the helpdesk agents' full-screen workspace, in
// its own route group beside (app) so it carries no CompassDocs sidebar or
// palette (STYLEGUIDE §Page skeleton, "A page that must not have the app
// shell at all"). It repeats what (app)/layout.tsx does first (sign-in,
// the forced password change, the interface scale, the date settings, one
// ToastHost and one DialogHost) and then gates on the licence and on the
// desk permissions: unlicensed is the house licence gate, no desk
// permission is a page pointing to Get help.

import { redirect } from "next/navigation";
import type { Metadata, Viewport } from "next";
import { requireUser, currentPagePath, reachableSettingsSections, requestDarkStylePref, SESSION_COOKIE } from "@/lib/auth";
import { safeReturnPath } from "@/lib/return-to";
import { getAppSettings } from "@/lib/settings-store";
import { settingsForUser } from "@/lib/format";
import { unreadNotificationCount } from "@/lib/db";
import { SettingsProvider } from "@/components/SettingsProvider";
import { WidthProvider } from "@/components/PageWidth";
import { ToastHost } from "@/components/Toasts";
import { DialogHost } from "@/components/Dialog";
import { UiScaleSync } from "@/components/UiScale";
import { DarkStyleSync } from "@/components/DarkStyleSync";
import { DARK_STYLE_COOKIE, resolveDarkStyle } from "@/lib/dark-style";
import { DeskShell } from "@/components/helpdesk/desk/DeskShell";
import { DuoDeskPrompt } from "@/components/helpdesk/desk/DuoDeskPrompt";
import { DeskForbidden, DeskLicenceGate } from "@/components/helpdesk/desk/DeskGate";
import { DeskKeysProvider } from "@/components/helpdesk/desk/DeskKeysProvider";
import { PwaHead } from "@/components/helpdesk/desk/pwa/PwaHead";
import { InstallDeskMenuItem } from "@/components/helpdesk/desk/pwa/InstallDesk";
import { deskPwaMetadata, deskPwaViewportFor } from "@/components/helpdesk/desk/pwa/metadata";
import { cookies } from "next/headers";
import { firstSettingsHref } from "@/components/helpdesk/desk/settings/settings-nav";
import { agentAvailability, agentReadingPrefs, deskAccess, deskRoleCaps } from "./desk-access";
import { deskLookFor } from "@/lib/helpdesk/appearance";
import { claudeDeskClientProps } from "@/lib/helpdesk/claude/desk-props";
import { SupportBanner } from "@/components/support/SupportBanner";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Desk", template: "%s · Desk" },
  robots: { index: false, follow: false },
  // The desk installs as an app of its own (agent F's manifest and icons).
  ...deskPwaMetadata,
};

// The installed desk's title bar follows the person's dark style (1.20.35):
// the signed-in account's, else this browser's cookie, else the workspace's.
export async function generateViewport(): Promise<Viewport> {
  const jar = await cookies();
  const cookiePref = jar.get(DARK_STYLE_COOKIE)?.value;
  const sessionToken = jar.get(SESSION_COOKIE)?.value;
  let workspace: unknown;
  let pref: string | undefined = cookiePref;
  try {
    workspace = (await getAppSettings()).dark_style;
    pref = await requestDarkStylePref(sessionToken, cookiePref);
  } catch {
    /* no database: the cookie, else Slate */
  }
  return deskPwaViewportFor(resolveDarkStyle(pref, workspace));
}

/** A desk admin's workspace-address warning: null while an address is configured. */
async function deskAddressWarning(user: Awaited<ReturnType<typeof requireUser>>): Promise<{ canSet: boolean } | null> {
  try {
    const { workspaceOrigin } = await import("@/lib/workspace-origin");
    if (await workspaceOrigin()) return null;
    const sections = await reachableSettingsSections(user).catch(() => [] as string[]);
    return { canSet: sections.includes("/admin/domain") };
  } catch {
    return null;
  }
}

export default async function DeskLayout({ children }: { children: React.ReactNode }) {
  // "desk" (1.20.5): the Duo desk rule is asked here whatever path the request claims to be for.
  const user = await requireUser("desk");
  if (user.must_change_password) {
    const back = safeReturnPath(await currentPagePath());
    redirect(back === "/" ? "/account/password" : `/account/password?next=${encodeURIComponent(back)}`);
  }

  const [access, workspaceSettings] = await Promise.all([deskAccess(user), getAppSettings()]);
  const settings = settingsForUser(workspaceSettings, user);

  let body: React.ReactNode;
  if (!access.licensed) {
    body = <DeskLicenceGate canManage={access.manageLicense} />;
  } else if (!access.any) {
    body = <DeskForbidden />;
  } else {
    const [unread, availability, role, look, claude, reading] = await Promise.all([
      unreadNotificationCount(user.id),
      agentAvailability(user.id),
      deskRoleCaps(user),
      // The desk background artwork (1.19.4 C5, lib/helpdesk/appearance).
      deskLookFor(user.id),
      // Claude in the desk (1.20.0): null unless it is on for this agent.
      claudeDeskClientProps(user),
      // 1.20.11: emails formatted or as plain text in the conversation; 1.20.28: the conversation's order;
      // 1.20.36: the queue's sort (desk preferences).
      agentReadingPrefs(user.id),
    ]);
    const reports = access.reports || role.can("reports.own") || role.can("reports.team") || role.can("reports.all");
    // 1.20.27 (lib/workspace-origin): with no configured address desk mail has no working links and the
    // portal sends no sign-in links; desk admins see a dismissible strip saying so, linking Domain & HTTPS
    // when they can open it.
    const addressWarning = access.admin ? await deskAddressWarning(user) : null;
    body = (
      <DeskShell
        user={{ id: user.id, name: user.name || user.username }}
        caps={{
          agent: access.agent,
          admin: access.admin,
          reports,
          // 1.20.23: "Manage a desk department" opens the builder for its holder's desk departments.
          workflows: role.can("workflows.manage") || role.can("departments.manage"),
          settingsHref: firstSettingsHref(role.caps),
        }}
        role={role.role}
        roleCaps={role.caps}
        claude={claude}
        addressWarning={addressWarning}
        unread={unread}
        availability={availability}
        emailView={reading.emailView}
        ticketOrder={reading.ticketOrder}
        queueSort={reading.queueSort}
        installSlot={<InstallDeskMenuItem />}
        look={look.look}
        lookMenu={look.menu}
      >
        {children}
      </DeskShell>
    );
  }

  return (
    <SettingsProvider value={settings}>
      <WidthProvider initial={user.page_width}>
        <DeskKeysProvider singleKey={user.single_key_shortcuts}>
          <UiScaleSync accountPref={user.ui_scale} />
          <DarkStyleSync style={resolveDarkStyle(user.dark_style, workspaceSettings.dark_style)} pref={user.dark_style ?? "workspace"} />
          {body}
          {access.licensed && access.any && <PwaHead />}
          <ToastHost />
          <DialogHost />
          {/* 1.20.5: shown only when a desk request is refused for want of a Duo approval. */}
          <DuoDeskPrompt />
          {/* 1.21.4: a CompassDocs support session says so in the desk too (lib/support). */}
          {user.support && <SupportBanner support={user.support} floating />}
        </DeskKeysProvider>
      </WidthProvider>
    </SettingsProvider>
  );
}
