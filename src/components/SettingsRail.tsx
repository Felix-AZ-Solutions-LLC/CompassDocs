"use client";

// The settings rail's body, shared by CompassDocs settings (SettingsNav,
// lib/settings-sections) and the desk's settings (DeskSettingsNav,
// lib/helpdesk/desk-settings-registry) since 1.20.13, so the two look and
// behave the same: a search box over everything the area contains, then the
// sections in their groups. While a query is typed the groups give way to
// the results: a section row (its icon and name, like the rail) or a page or
// setting with where it lives underneath ("Email › setting").
//
// Keyboard: Enter opens the first result, Arrow Down moves into the results
// and Arrow Up and Down walk them (Arrow Up from the first goes back to the
// box), Escape clears the box and returns to it. A live count tells screen
// readers how many matched. Opening a result whose address has an #anchor
// scrolls to that setting and flashes it (SettingsJumpHighlight).
//
// The callers decide what the rows are and who may see them; this draws.

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, Search, type LucideIcon } from "lucide-react";
import { RailGroupLabel, RailLink, railRowClass } from "./RailLink";
import { controlClass, SectionEmpty } from "@/components/form";
import { announceSettingsJump } from "./SettingsJumpHighlight";

export interface SettingsRailEntry {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  /** The rail row's badge slot (the desk's New chip). */
  badge?: React.ReactNode;
}

export interface SettingsRailGroup {
  label: string;
  entries: SettingsRailEntry[];
}

export interface SettingsRailHit {
  key: string;
  href: string;
  label: string;
  /** A section row (icon and name, like the rail); else a page or setting row. */
  section?: { icon: LucideIcon; active: boolean };
  /** Where a page or setting lives, shown under its name: ["Email", "setting"]. */
  trail?: string[];
}

const WIDE = {
  // Literal class names per breakpoint (Tailwind cannot see built strings).
  sm: { search: "hidden sm:block", groups: "hidden sm:flex sm:flex-col sm:gap-1" },
  lg: { search: "hidden lg:block", groups: "hidden lg:flex lg:flex-col lg:gap-1" },
} as const;

export function SettingsRail({
  label,
  groups,
  search,
  phone,
  wide = "sm",
  searchOnPhone = false,
  landmarks = true,
  placeholder = "Search settings…",
}: {
  /** The accessible name of the rail's lists ("Settings sections"). */
  label: string;
  groups: SettingsRailGroup[];
  /** The rows for a query, already limited to what the viewer may open. */
  search: (query: string) => SettingsRailHit[];
  /** What shows under `wide` in place of the grouped rail. */
  phone?: React.ReactNode;
  /** The breakpoint from which the grouped rail shows. */
  wide?: keyof typeof WIDE;
  /** Show the search box on a phone too. */
  searchOnPhone?: boolean;
  /** Render the lists as `nav` landmarks (false when the caller's wrapper is the nav). */
  landmarks?: boolean;
  placeholder?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const countId = useId();
  const listId = useId();
  const matches = query.trim() ? search(query.trim()) : null;
  const List = landmarks ? "nav" : "div";
  const listLabel = landmarks ? label : undefined;

  function links(): HTMLElement[] {
    return Array.from(listRef.current?.querySelectorAll<HTMLElement>("a[href]") ?? []);
  }

  function opened(href: string) {
    setQuery("");
    announceSettingsJump(href);
  }

  function onBoxKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      if (query) {
        e.preventDefault();
        setQuery("");
      }
      return;
    }
    if (e.key === "Enter" && matches && matches.length > 0) {
      e.preventDefault();
      router.push(matches[0].href);
      opened(matches[0].href);
      return;
    }
    if (e.key === "ArrowDown" && matches && matches.length > 0) {
      e.preventDefault();
      links()[0]?.focus();
    }
  }

  function onListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const all = links();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      all[Math.min(at + 1, all.length - 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (at === 0) boxRef.current?.focus();
      else all[at - 1]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setQuery("");
      boxRef.current?.focus();
    }
  }

  const bp = WIDE[wide];
  return (
    <>
      <label className={`relative mb-1 ${searchOnPhone ? "block" : bp.search}`}>
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" aria-hidden />
        <input
          ref={boxRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onBoxKeyDown}
          placeholder={placeholder}
          aria-label="Search settings"
          aria-describedby={countId}
          aria-controls={matches ? listId : undefined}
          autoComplete="off"
          spellCheck={false}
          className={controlClass(false, "py-1.5 pl-8 pr-2")}
        />
      </label>
      <span id={countId} aria-live="polite" className="sr-only">
        {matches ? `${matches.length} ${matches.length === 1 ? "match" : "matches"}` : ""}
      </span>

      {matches ? (
        <div ref={listRef} onKeyDown={onListKeyDown}>
          <List id={listId} aria-label={listLabel} className="flex flex-col gap-1">
            {matches.map((m) =>
              m.section ? (
                <div key={m.key} onClickCapture={() => opened(m.href)}>
                  <RailLink href={m.href} icon={m.section.icon} label={m.label} active={m.section.active} />
                </div>
              ) : (
                <Link key={m.key} href={m.href} onClick={() => opened(m.href)} className={railRowClass(false, { dense: true })}>
                  {/* The setting is what was searched for; where it lives is the breadcrumb. */}
                  <span className="flex min-w-0 flex-col py-0.5 leading-tight">
                    <span className="truncate font-medium text-slate-800">{m.label}</span>
                    {m.trail && m.trail.length > 0 && (
                      <span className="flex flex-wrap items-center gap-0.5 text-2xs text-slate-500">
                        {m.trail.map((t, i) => (
                          <span key={i} className="flex items-center gap-0.5">
                            {i > 0 && <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />}
                            {t}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                </Link>
              )
            )}
            {matches.length === 0 && (
              <SectionEmpty className="px-3 py-2">No settings match &ldquo;{query.trim()}&rdquo;.</SectionEmpty>
            )}
          </List>
        </div>
      ) : (
        <>
          {phone}
          <List aria-label={listLabel} className={bp.groups}>
            {groups.map((g) => (
              <div key={g.label} className="flex flex-col gap-0.5">
                <RailGroupLabel>{g.label}</RailGroupLabel>
                {g.entries.map((s) => (
                  <RailLink key={s.href + s.label} href={s.href} icon={s.icon} label={s.label} active={s.active} badge={s.badge} />
                ))}
              </div>
            ))}
          </List>
        </>
      )}
    </>
  );
}
