"use client";

// The desk's own shell (1.19.0, /desk): a full-screen workspace meant to
// stay open in its own tab beside CompassDocs, so it has no CompassDocs
// sidebar. A top bar (the Desk mark, global search, CompassDocs ↗, the
// bell, the availability menu) over an icon rail (Tickets, Approvals,
// Workflows, Reports, Settings) and the page. Under md the rail folds into
// a menu button at the left of the top bar, so a phone gets the whole
// width for the page.

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, CalendarDays, ExternalLink, Inbox, LifeBuoy, Menu, Settings, Stamp, Workflow } from "lucide-react";
import { Popover } from "@/components/Popover";
import { iconButtonClass } from "@/components/Button";
import { railIconClass, railRowClass } from "@/components/RailLink";
import type { HdAvailability, HdCounts } from "@/lib/helpdesk/types";
import type { HdEmailView } from "@/lib/helpdesk/email-html-shared";
import type { HdTicketOrder } from "@/lib/helpdesk/conversation-shared";
import type { HdQueueSort } from "@/lib/helpdesk/queue-sort-shared";
import { useQueueSortSync } from "./queue/queue-sort";
import { DeskBell } from "./DeskBell";
import { DeskSearch } from "./DeskSearch";
import { WorkspaceAddressBanner } from "./WorkspaceAddressNotice";
import { AvailabilityMenu } from "./AvailabilityMenu";
import { DeskCountsContext, useCountsPoll } from "./counts";
import { DeskMeContext } from "./me";
// Status page services per team (1.19.2, agent W6): the pill, the pop-ups, the queue banner's data.
import { StatusPill } from "./team-status/StatusPill";
import { StatusPopups } from "./team-status/StatusPopups";
import { TeamStatusProvider } from "./team-status/data";
// Desk background artwork (1.19.4 C5, ./appearance): the root that paints it, and "My desk background".
import type { HdDeskLook } from "@/lib/helpdesk/appearance-shared";
import { DeskLookRoot } from "./appearance/DeskLook";
import { DeskBackgroundMenuItem, MyDeskBackgroundPanel } from "./appearance/MyDeskBackground";
// Claude in the desk (1.20.0): the top bar's button, Ctrl/⌘+J and the docked panel.
import { ClaudeButton, ClaudeDeskProvider, type ClaudeDeskProps } from "./claude/ClaudeDesk";
// 1.20.18: the reply pop-out (/desk/tickets/[number]/reply) is a desk page with no top bar or rail.
import { adoptLegacyDrafts, isReplyPopoutPath, pruneDeskStorage } from "./popout/reply-popout";
import { useReplyPopoutToasts } from "./popout/useReplyPopout";
// 1.20.24: upcoming events in the top bar and today's count on the Calendar rail icon.
import { useUpcomingEvents } from "./calendar/upcoming";
import { UpcomingPill } from "./calendar/UpcomingPill";
import { badgeText, badgeWords } from "@/lib/helpdesk/desk-calendar-upcoming-shared";

export interface DeskCaps {
  agent: boolean;
  /** Helpdesk admin (the helpdesk.admin permission). */
  admin: boolean;
  reports: boolean;
  /** The desk role may build workflows. */
  workflows: boolean;
  /** Where Settings leads: the first settings page the role reaches. */
  settingsHref: string;
}

interface Dest {
  href: string;
  label: string;
  icon: ReactNode;
  match: (p: string) => boolean;
  badge?: number;
  badgeLabel?: string;
  /** 1.20.24: the count may be higher ("12+"): the calendar's answer was cut short. */
  badgeMore?: boolean;
}

function destinations(caps: DeskCaps, counts: HdCounts | null, eventsLeft = 0, eventsMore = false): Dest[] {
  const out: Dest[] = [];
  if (caps.agent)
    out.push({
      href: "/desk",
      label: "Tickets",
      icon: <Inbox className="h-5 w-5" aria-hidden />,
      match: (p) => p === "/desk" || p.startsWith("/desk/tickets"),
    });
  // 1.20.6: the events on tickets (lib/helpdesk/desk-calendar). Agents, as the queue.
  if (caps.agent)
    out.push({
      href: "/desk/calendar",
      label: "Calendar",
      icon: <CalendarDays className="h-5 w-5" aria-hidden />,
      match: (p) => p.startsWith("/desk/calendar"),
      // 1.20.24: today's timed events that haven't ended (all-day and past ones never count).
      badge: eventsLeft,
      badgeLabel: badgeWords(eventsLeft, eventsMore),
      badgeMore: eventsMore,
    });
  out.push({
    href: "/desk/approvals",
    label: "Approvals",
    icon: <Stamp className="h-5 w-5" aria-hidden />,
    match: (p) => p.startsWith("/desk/approvals"),
    badge: counts?.approvals_waiting || 0,
    badgeLabel: "approvals waiting for you",
  });
  if (caps.workflows)
    out.push({
      href: "/desk/workflows",
      label: "Workflows",
      icon: <Workflow className="h-5 w-5" aria-hidden />,
      match: (p) => p.startsWith("/desk/workflows"),
    });
  if (caps.reports)
    out.push({
      href: "/desk/reports",
      label: "Reports",
      icon: <BarChart3 className="h-5 w-5" aria-hidden />,
      match: (p) => p.startsWith("/desk/reports"),
    });
  out.push({
      href: caps.settingsHref,
      label: "Settings",
      icon: <Settings className="h-5 w-5" aria-hidden />,
      match: (p) => p.startsWith("/desk/settings") || p.startsWith("/desk/setup"),
    });
  return out;
}

export function DeskShell({
  user,
  caps,
  unread,
  availability,
  emailView = "formatted",
  ticketOrder = "newest",
  queueSort = null,
  installSlot,
  role,
  roleCaps,
  look = null,
  lookMenu = false,
  claude = null,
  addressWarning = null,
  children,
}: {
  user: { id: number; name: string };
  caps: DeskCaps;
  unread: number;
  availability: HdAvailability;
  /** 1.20.11: how emailed messages read in the conversation (the agent's desk preference). */
  emailView?: HdEmailView;
  /** 1.20.28: the ticket pane's conversation order (the agent's desk preference, lib/helpdesk/conversation-shared). */
  ticketOrder?: HdTicketOrder;
  /** 1.20.36: how the queue's list is sorted (the agent's desk preference; null for the default, queue/queue-sort). */
  queueSort?: HdQueueSort | null;
  /** The desk app's install prompt (agent F's InstallDesk), shown in the user menu. */
  installSlot?: ReactNode;
  role: { key: string; label: string } | null;
  roleCaps: string[];
  /** The desk background for this person (1.19.4, lib/helpdesk/appearance deskLookFor); null is the plain desk. */
  look?: HdDeskLook | null;
  /** The user menu offers "Desk background…". */
  lookMenu?: boolean;
  /** Claude in the desk, when it is on for this agent (1.20.0). */
  claude?: ClaudeDeskProps | null;
  /** 1.20.27: a desk admin on a workspace with no configured address (lib/workspace-origin): the
   *  dismissible strip under the top bar; `canSet` when they can open Domain & HTTPS. */
  addressWarning?: { canSet: boolean } | null;
  children: ReactNode;
}) {
  const pathname = usePathname() || "/desk";
  // 1.20.18: the reply pop-out gets the desk's providers (who you are, your role, dialogs) and nothing else:
  // no top bar, no rail, no counts or status polling. The layout's gates (sign-in, licence, Duo) ran as for any desk page.
  const bare = isReplyPopoutPath(pathname);
  // 1.20.19: `live` bumps on each live signal (./live), for the queue to reload its list.
  const { counts, refresh, live } = useCountsPoll(caps.agent && !bare);
  // 1.20.24: one copy for the pill and the rail badge; reloads on the same live signal, no poll of its own.
  const upcoming = useUpcomingEvents(caps.agent && !bare, live);
  // A reply sent from a pop-out is announced here, in the desk window (the pop-out closes as it sends).
  useReplyPopoutToasts(user.id, caps.agent && !bare);
  // 1.20.36: the queue's sort follows the agent's other desk windows from every desk page, not only the queue.
  useQueueSortSync(user.id, caps.agent);
  // 1.20.18 (security review): a shared computer keeps no one else's desk drafts or hand-offs. 1.20.16's drafts named
  // no one: the first agent to open the desk in this browser adopts them (once), so nobody loses a reply mid-upgrade.
  useEffect(() => {
    adoptLegacyDrafts(user.id);
    pruneDeskStorage(user.id);
  }, [user.id]);
  const dests = destinations(caps, counts, upcoming.left, upcoming.leftMore);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const userMenu = useRef<HTMLDivElement>(null);

  // The fold menu closes when the page changes under it.
  useEffect(() => setMenuOpen(false), [pathname]);

  if (bare) {
    return (
      <DeskMeContext.Provider value={{ id: user.id, name: user.name, agent: caps.agent, admin: caps.admin, reports: caps.reports, role, caps: roleCaps, email_view: emailView, ticket_order: ticketOrder, queue_sort: queueSort }}>
        <DeskCountsContext.Provider value={{ counts, refresh }}>
          <div className="relative flex h-dvh flex-col overflow-clip bg-canvas print:h-auto print:overflow-visible">
            <main id="main" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 outline-none">
              {children}
            </main>
          </div>
        </DeskCountsContext.Provider>
      </DeskMeContext.Provider>
    );
  }

  return (
    <DeskMeContext.Provider value={{ id: user.id, name: user.name, agent: caps.agent, admin: caps.admin, reports: caps.reports, role, caps: roleCaps, email_view: emailView, ticket_order: ticketOrder, queue_sort: queueSort }}>
    <DeskCountsContext.Provider value={{ counts, refresh, live }}>
    <TeamStatusProvider enabled={caps.agent}>
    <ClaudeHost claude={claude}>
      {/* 1.20.12: `relative overflow-clip`, not `overflow-hidden`. Every `sr-only` label (a list count's
          " open tickets", a due's full text) is `position: absolute`; with no positioned ancestor it
          escaped the panes and made the document itself thousands of pixels tall, so a wheel past the
          end of a pane scrolled the whole desk up into empty space. Positioned, the root contains them;
          `clip` (not a scroll container) means nothing, not even scrollIntoView, can scroll it. */}
      {/* 1.20.27: the installed desk is viewportFit cover (pwa/metadata), so the shell keeps clear of a
          notch and the home indicator with the safe-area insets (zero in a browser tab). */}
      <DeskLookRoot
        look={look}
        menu={lookMenu}
        className="relative flex h-dvh flex-col overflow-clip bg-canvas pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] print:h-auto print:overflow-visible print:p-0"
      >
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-compass-600 focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
        >
          Skip to content
        </a>
        <header className="relative flex h-13 shrink-0 items-center gap-2 border-b border-slate-200 bg-surface px-2 sm:gap-3 sm:px-4 print:hidden">
          {/* Under md the rail folds into this menu. */}
          <div className="relative md:hidden">
            <button
              ref={menuBtn}
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Desk menu"
              data-tt="Desk menu"
              data-tt-pos="bottom"
              data-tt-align="start"
              className={iconButtonClass("quiet", "md")}
            >
              <Menu aria-hidden />
            </button>
            <Popover open={menuOpen} onClose={() => setMenuOpen(false)} triggerRef={menuBtn} role="menu" label="Desk menu" width="w-60" className="mt-1">
              {dests.map((d) => (
                <Link
                  key={d.href}
                  href={d.href}
                  role="menuitem"
                  aria-current={d.match(pathname) ? "page" : undefined}
                  className={railRowClass(d.match(pathname), { dense: true })}
                >
                  <span className={railIconClass(d.match(pathname))}>{d.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{d.label}</span>
                  {d.badge ? (
                    <span className="rounded-full bg-compass-600 px-1.5 text-2xs font-semibold text-white">
                      {badgeText(d.badge, d.badgeMore)}
                      <span className="sr-only"> {d.badgeLabel}</span>
                    </span>
                  ) : null}
                </Link>
              ))}
              <Link href="/" target="_blank" role="menuitem" className={railRowClass(false, { dense: true })}>
                <ExternalLink className="h-5 w-5 text-slate-400" aria-hidden />
                <span className="min-w-0 flex-1 truncate">CompassDocs</span>
              </Link>
            </Popover>
          </div>
          <Link href={caps.agent ? "/desk" : "/desk/approvals"} className="flex shrink-0 items-center gap-2 text-base font-bold text-slate-900">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-compass-600 text-white">
              <LifeBuoy className="h-4.5 w-4.5" aria-hidden />
            </span>
            <span className="hidden sm:inline">Desk</span>
          </Link>
          {/* 1.20.27: under sm the search is an icon at the end of this slot that opens a full-width bar. */}
          <div className="flex min-w-0 flex-1 justify-end sm:ml-3 sm:justify-start">
            <DeskSearch />
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            {claude && <ClaudeButton />}
            {caps.agent && <UpcomingPill upcoming={upcoming} />}
            {caps.agent && <StatusPill />}
            <a
              href="/"
              target="_blank"
              rel="noopener"
              className="hidden items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-800 lg:inline-flex"
            >
              CompassDocs
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <DeskBell initialUnread={unread} />
            <div ref={userMenu} className="relative">
              <AvailabilityMenu
                name={user.name}
                role={role?.key ?? null}
                initial={availability}
                extra={
                  <>
                    {installSlot}
                    <DeskBackgroundMenuItem />
                  </>
                }
              />
              <MyDeskBackgroundPanel anchor={userMenu} />
            </div>
          </div>
        </header>
        {addressWarning && <WorkspaceAddressBanner userId={user.id} canSet={addressWarning.canSet} />}
        <div className="flex min-h-0 flex-1">
          <nav aria-label="Desk" className="hidden w-sidebar-rail shrink-0 flex-col items-center gap-1.5 border-r border-slate-200 bg-surface py-3 md:flex print:hidden">
            {dests.map((d) => {
              const on = d.match(pathname);
              return (
                <Link
                  key={d.href}
                  href={d.href}
                  data-tt={d.label}
                  data-tt-pos="right"
                  aria-label={d.badge ? `${d.label}, ${d.badge} ${d.badgeLabel}` : d.label}
                  aria-current={on ? "page" : undefined}
                  className={`relative grid h-10.5 w-10.5 place-items-center rounded-lg transition ${
                    on ? "bg-compass-50 text-compass-700" : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                  }`}
                >
                  {d.icon}
                  {d.badge ? (
                    <span
                      className="absolute right-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-compass-600 px-1 text-3xs font-semibold leading-none text-white"
                      aria-hidden
                    >
                      {badgeText(d.badge, d.badgeMore)}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </nav>
          <main id="main" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 outline-none">
            {children}
          </main>
        </div>
      </DeskLookRoot>
      {caps.agent && <StatusPopups />}
    </ClaudeHost>
    </TeamStatusProvider>
    </DeskCountsContext.Provider>
    </DeskMeContext.Provider>
  );
}

/** The Claude provider when Claude is on for this agent; the page as it is otherwise. */
function ClaudeHost({ claude, children }: { claude: ClaudeDeskProps | null; children: ReactNode }) {
  return claude ? <ClaudeDeskProvider props={claude}>{children}</ClaudeDeskProvider> : <>{children}</>;
}
