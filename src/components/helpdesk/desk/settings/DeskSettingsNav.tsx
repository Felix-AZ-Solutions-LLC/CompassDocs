"use client";

// The desk's settings rail (1.20.13): the CompassDocs settings rail
// (components/SettingsRail: search box, results, grouped rows) over the desk
// settings registry (lib/helpdesk/desk-settings-registry), so the two
// settings areas look and behave alike. A row per section, in its group
// (General, Teams and people, Email, Tickets, Automation, Requesters,
// Integrations, Security and data, You); a section's own pages are tabs
// under its header, not rows here. Only what the person's desk role opens
// is listed, and only that is searched (agent J's roles).
//
// Under lg the rail is a bar over the page: the search box, then "All
// settings" (the overview, which lists every section) and the section the
// page belongs to. The New chip (1.19.2, agent W5) sits on a section with a
// page this person hasn't opened yet.

import { usePathname } from "next/navigation";
import { LayoutGrid } from "lucide-react";
import { RailLink } from "@/components/RailLink";
import { SettingsRail, type SettingsRailHit } from "@/components/SettingsRail";
import {
  DESK_SETTINGS_HOME,
  deskSectionLanding,
  deskSettingsGroups,
  deskSettingsPageFor,
  searchDeskSettings,
  type DeskSettingsViewer,
} from "@/lib/helpdesk/desk-settings-registry";
import { DeskNewChip, useDeskNew } from "./DeskNew";

export function DeskSettingsNav({ viewer }: { viewer: DeskSettingsViewer }) {
  const pathname = usePathname() || "";
  const fresh = useDeskNew();
  const here = deskSettingsPageFor(pathname)?.section.key;
  const groups = deskSettingsGroups(viewer).map((g) => ({
    label: g.label,
    entries: g.sections.map((s) => ({
      href: deskSectionLanding(viewer, s),
      icon: s.icon,
      label: s.label,
      active: here === s.key,
      badge: fresh && s.pages.some((p) => fresh.isNew(p.href)) ? <DeskNewChip /> : undefined,
    })),
  }));
  const current = groups.flatMap((g) => g.entries).find((e) => e.active);
  const search = (q: string): SettingsRailHit[] =>
    searchDeskSettings(viewer, q).map((h) =>
      h.kind === "section"
        ? { key: `s:${h.section.key}`, href: h.href, label: h.label, section: { icon: h.section.icon, active: here === h.section.key } }
        : { key: h.href, href: h.href, label: h.label, trail: [...h.trail, h.kind === "page" ? "page" : "setting"] }
    );

  return (
    <nav
      aria-label="Desk settings"
      className="flex shrink-0 flex-col gap-1 border-b border-slate-200 bg-surface px-3 py-2 lg:block lg:w-rail lg:overflow-y-auto lg:border-b-0 lg:border-r lg:px-2 lg:py-4 print:hidden"
    >
      <SettingsRail
        label="Desk settings"
        landmarks={false}
        wide="lg"
        searchOnPhone
        groups={groups}
        search={search}
        phone={
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto lg:hidden">
            <span className="shrink-0 whitespace-nowrap">
              <RailLink href={DESK_SETTINGS_HOME} icon={LayoutGrid} label="All settings" active={pathname === DESK_SETTINGS_HOME} />
            </span>
            {current && (
              <span className="min-w-0 shrink whitespace-nowrap">
                <RailLink href={current.href} icon={current.icon} label={current.label} active />
              </span>
            )}
          </div>
        }
      />
    </nav>
  );
}
