"use client";

// /desk/settings (1.20.13): the desk settings overview. One card per group
// of the rail (lib/helpdesk/desk-settings-registry), each listing its
// sections with their one line, and for a section with tabs, the tabs'
// names, so a reader sees where a setting lives before opening anything.
// Only what this person's desk role opens is listed. On a phone the rail
// collapses to its search box and an "All settings" link back here, so this
// page is the phone's settings menu. STYLEGUIDE §Helpdesk: desk settings.

import Link from "next/link";
import { Settings } from "lucide-react";
import { PageContainer } from "@/components/PageWidth";
import { PageHeader } from "@/components/PageHeader";
import { CARD_CLASS } from "@/components/Card";
import { CardTitle } from "@/components/Heading";
import { deskSectionLanding, deskSectionPages, deskSettingsGroups, type DeskSettingsViewer } from "@/lib/helpdesk/desk-settings-registry";
import { DeskNewChip, DeskNewStrip, useDeskNew } from "./DeskNew";

export function DeskSettingsHome({ viewer }: { viewer: DeskSettingsViewer }) {
  const groups = deskSettingsGroups(viewer);
  const fresh = useDeskNew();
  return (
    <PageContainer>
      <PageHeader icon={<Settings />} title="Settings" subtitle="How the desk works. Search for a setting, or pick a section." />
      {/* 1.20.27: the "New in <release>" strip lives here only, under the overview's header, never above a page's h1. */}
      <DeskNewStrip />
      {/* 1.20.16: columns, not a grid. The groups differ a lot in length (General has two
          sections, Requesters four with long lines), so grid rows left tall gaps under the short
          cards; columns stack each card straight under the one above. Reading order stays the
          DOM order (down each column). */}
      <div className="gap-4 md:columns-2 xl:columns-3" data-testid="desk-settings-home">
        {groups.map((g) => (
          <section key={g.label} className={`${CARD_CLASS} mb-4 break-inside-avoid p-4`} aria-label={g.label}>
            <CardTitle as="h2" className="mb-2 px-2">
              {g.label}
            </CardTitle>
            <ul role="list" className="flex flex-col gap-0.5">
              {g.sections.map((s) => {
                const Icon = s.icon;
                const tabs = s.tabs ? deskSectionPages(viewer, s) : [];
                return (
                  <li key={s.key}>
                    <Link
                      href={deskSectionLanding(viewer, s)}
                      className="flex items-start gap-3 rounded-lg px-2 py-2 transition hover:bg-slate-100"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-compass-50 text-compass-700" aria-hidden>
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900">
                          {s.label}
                          {fresh && s.pages.some((p) => fresh.isNew(p.href)) && <DeskNewChip />}
                        </span>
                        <span className="block text-xs text-slate-500">{s.description}</span>
                        {tabs.length > 1 && <span className="mt-0.5 block text-xs text-slate-500">{tabs.map((t) => t.label).join(" · ")}</span>}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </PageContainer>
  );
}
