"use client";

// The one sub-navigation (STYLEGUIDE §Settings pages): a section with
// several jobs gets pages, and this row switches between them under the
// section header. Started life as the directory's tab bar; Notifications
// (channels / email templates) and, later, Roles and Workspace use it too.
// The tabs come from lib/settings-sections (`pages`), so the rail search
// and this row can never disagree about what a section contains.

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { canOpenPage, settingsPages, settingsSection } from "@/lib/settings-sections";
import { useReachableSettings } from "./SettingsLink";
import { useEdgeFade } from "./edge-fade";

export interface SubNavItem {
  href: string;
  label: string;
  icon?: LucideIcon;
  /** 1.20.27: other addresses this tab stays lit under (Templates for a template's own page at /event/…), for a first tab that otherwise lights only on its exact address. */
  also?: readonly string[];
}

export function SubNav({
  label,
  section,
  items: given,
  root,
  className = "",
}: {
  /** The accessible name of the row ("Directory settings"). */
  label: string;
  /** A settings section href: its `pages` become the tabs. Resolved here, on
   *  the client, because icon components cannot cross from a server layout. */
  section?: string;
  items?: readonly SubNavItem[];
  /** The first tab's href: exact match only, so it doesn't light for every sub-page. */
  root?: string;
  className?: string;
}) {
  const path = usePathname();
  // A section's tabs show only the pages the viewer may open (1.19.1: a page
  // may carry its own permission). Outside the app layout, all of them.
  const reachable = useReachableSettings();
  const sec = section ? settingsSection(section) : undefined;
  const items = given ?? (sec ? settingsPages(sec.href).filter((p) => !reachable || canOpenPage(reachable, sec, p)) : []);
  const base = root ?? items[0]?.href;
  // One tab is current: the longest one the address is, or is under (the
  // first tab only when it is the address itself). 1.20.13: tabs may nest
  // (Office hours /calendars, Holidays /calendars/holidays), and both lit.
  const under = (p: string) => path === p || path.startsWith(`${p}/`);
  const current = items
    .filter((t) => (t.href === base ? path === t.href : under(t.href)) || (("also" in t ? t.also : undefined) ?? []).some(under))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  // 1.20.13: on a phone the row scrolls sideways; bring the current tab into it.
  // 1.20.27: to a tab boundary, never slicing the tab before it ("Rol", "Custo"):
  // the tab before stays whole when both fit, otherwise the current tab starts
  // the row. The row snaps to tab starts and fades at an edge with more past it.
  const navRef = useEdgeFade<HTMLElement>();
  useEffect(() => {
    const nav = navRef.current;
    const tab = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !tab || nav.scrollWidth <= nav.clientWidth) return;
    const box = nav.getBoundingClientRect();
    const at = (el: Element) => el.getBoundingClientRect().left - box.left + nav.scrollLeft;
    const left = at(tab);
    const right = left + tab.offsetWidth;
    if (left >= nav.scrollLeft && right <= nav.scrollLeft + nav.clientWidth) return;
    const prev = tab.previousElementSibling;
    const from = prev && right - at(prev) <= nav.clientWidth ? at(prev) : left;
    nav.scrollLeft = Math.max(0, from);
  }, [current, navRef]);
  return (
    <nav ref={navRef} aria-label={label} className={`edge-fade mb-5 flex snap-x gap-1 overflow-x-auto border-b border-slate-200 ${className}`.trim()}>
      {items.map((t) => {
        const active = t.href === current;
        const Icon = t.icon;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px flex shrink-0 snap-start items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition ${
              active
                ? "border-compass-600 text-compass-700"
                : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800"
            }`}
          >
            {Icon && <Icon className="h-4 w-4" aria-hidden />}
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
