"use client";

// The settings rail: sections grouped by area (Platform / Content / People &
// access / AI / Operations) with a search box over everything the console
// contains — sections, their routed pages and the cards inside them
// ("Workspace › Trash retention" links straight to the card). Section
// identity lives in lib/settings-sections, shared with each page's
// SettingsPage header and SubNav. Rows and group labels are the shared rail
// recipe (components/RailLink).
//
// The search box, results and grouped rows are the shared SettingsRail
// (1.20.13), which the desk's settings rail uses too; this file decides what
// the rows are and who may see them. Keyboard and the live count: see there.

import { usePathname } from "next/navigation";
import {
  SETTINGS_GROUPS,
  SETTINGS_INDEX,
  SETTINGS_SECTIONS,
  canOpenPage,
  canOpenSection,
  sectionLanding,
  type SettingsIndexEntry,
} from "@/lib/settings-sections";
import { rankSettings } from "@/lib/settings-search";
import { RailLink } from "./RailLink";
import { SettingsRail, type SettingsRailHit } from "./SettingsRail";

const MAX_RESULTS = 12;

export function SettingsNav({ reachable }: { reachable: string[] }) {
  const pathname = usePathname();
  // A section may have pages of its own (/admin/directory/fields); the rail
  // entry stays lit for all of them. Longest match wins, or /admin (System)
  // would claim every page.
  const path =
    SETTINGS_SECTIONS.filter((s) => pathname === s.href || pathname.startsWith(`${s.href}/`))
      .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? pathname;
  // The rail lists only what this user may open — the layout resolves that from
  // each section's permission, so a delegated role sees its one section rather
  // than twenty links that redirect home. Pages and topics inherit their
  // section's reachability, except a page with its own permission (1.19.1):
  // it shows for its holders, and a section reached only through such a
  // page is listed and lands on it.
  const allowed = new Set(reachable);
  const sections = SETTINGS_SECTIONS.filter((s) => canOpenSection(allowed, s));
  const groups = SETTINGS_GROUPS.map((g) => ({
    label: g.label,
    entries: g.sections
      .filter((s) => canOpenSection(allowed, s))
      .map((s) => ({ href: sectionLanding(allowed, s), icon: s.icon, label: s.label, active: path === s.href })),
  })).filter((g) => g.entries.length > 0);
  const reachableEntry = (e: SettingsIndexEntry) => {
    if (e.kind === "section") return canOpenSection(allowed, e.section);
    if (e.kind === "page") {
      const page = e.section.pages?.find((p) => p.href === e.href);
      return page ? canOpenPage(allowed, e.section, page) : allowed.has(e.section.href);
    }
    return allowed.has(e.section.href);
  };
  const search = (q: string): SettingsRailHit[] =>
    rankSettings(SETTINGS_INDEX.filter(reachableEntry), q, (e) => e.label, (e) => e.haystack)
      .slice(0, MAX_RESULTS)
      .map((e) =>
        e.kind === "section"
          ? { key: e.href, href: sectionLanding(allowed, e.section), label: e.label, section: { icon: e.section.icon, active: path === e.section.href } }
          : // The topic is what was searched for; the section is the breadcrumb.
            { key: e.href, href: e.href, label: e.label, trail: [e.section.label, e.kind === "page" ? "page" : "setting"] }
      );

  return (
    <div className="flex shrink-0 flex-col gap-1 sm:w-rail">
      <SettingsRail
        label="Settings sections"
        groups={groups}
        search={search}
        phone={
          /* Mobile: one horizontally scrollable flat row. */
          <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto sm:hidden">
            {sections.map((s) => (
              <span key={s.href} className="shrink-0 whitespace-nowrap">
                <RailLink href={sectionLanding(allowed, s)} icon={s.icon} label={s.label} active={path === s.href} />
              </span>
            ))}
          </nav>
        }
      />
    </div>
  );
}
