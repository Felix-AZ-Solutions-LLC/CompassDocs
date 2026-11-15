"use client";

// 1.20.13: the header and tab row of a desk settings section with several
// pages (STYLEGUIDE §Settings pages: a section with several jobs gets pages),
// drawn exactly as CompassDocs settings draws them: the section's PageHeader
// (icon, name, one line; the page's one h1), then the shared SubNav with the
// tabs this person's role opens, then the tab's page. The pages kept their
// addresses, so the section is found from the address in the registry
// (lib/helpdesk/desk-settings-registry), and each page component, written
// to stand alone, renders as a tab inside SettingsSubPage (its own header
// becomes the tab's intro row with its Create button). Anywhere else (a
// one-page section, a detail page under a tab, a page this role cannot
// open) the page renders as it always has.

import { usePathname } from "next/navigation";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { SubNav } from "@/components/SubNav";
import { SettingsSubPage } from "@/components/SettingsSubPage";
import { deskTabbedSectionAt, type DeskSettingsViewer } from "@/lib/helpdesk/desk-settings-registry";

export function DeskSettingsChrome({ viewer, children }: { viewer: DeskSettingsViewer; children: React.ReactNode }) {
  const pathname = usePathname() || "";
  const at = deskTabbedSectionAt(pathname, viewer);
  if (!at) return <>{children}</>;
  const { section, tabs } = at;
  const Icon = section.icon;
  return (
    <PageContainer>
      <PageHeader icon={<Icon />} title={section.label} subtitle={section.description} className="mb-4" />
      {tabs.length > 1 && (
        <SubNav label={`${section.label} settings`} items={tabs.map((t) => ({ href: t.href, label: t.label, icon: t.icon }))} root={tabs[0].href} />
      )}
      <SettingsSubPage>{children}</SettingsSubPage>
    </PageContainer>
  );
}
