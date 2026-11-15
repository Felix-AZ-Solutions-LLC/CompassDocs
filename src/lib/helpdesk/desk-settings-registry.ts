// Helpdesk 1.20.13: the desk settings, declared once. Every page under
// /desk/settings, the group and section it belongs to, the tabs a section
// shows, the settings (cards) inside each page that the search can jump to,
// the words people search for, and which desk capability opens each page.
//
// The same shape as the CompassDocs settings registry (lib/settings-sections:
// groups of sections, a section's `pages` are its tabs, `topics` are cards
// reached by anchor), so the two settings areas look and behave alike. Read
// by the desk settings rail and its search, the section header and tab row,
// the /desk/settings overview, and test/helpdesk-settings-nav.test.ts, which
// fails when a settings route exists that is not listed here.
//
// Every address the desk settings ever had still answers: the pages kept
// their addresses (a section's tabs are pages at their old URLs), and the
// four that moved in 1.20.2 redirect (DESK_SETTINGS_MOVED).
//
// Client-safe: icons are component references, rendered by the consumer.

import {
  Bell,
  BellRing,
  BookOpen,
  Bot,
  CalendarClock,
  CalendarDays,
  ClipboardCheck,
  Clock,
  Contact,
  Fingerprint,
  FolderTree,
  Globe,
  Languages,
  Laptop,
  LifeBuoy,
  Link,
  List,
  ListChecks,
  ListOrdered,
  LockKeyhole,
  MailPlus,
  Mail,
  MessageCircle,
  MessageSquareText,
  Package,
  PhoneCall,
  Plug,
  Repeat,
  Shield,
  ShieldCheck,
  Shuffle,
  SlidersHorizontal,
  Sparkle,
  Star,
  TextCursorInput,
  Timer,
  Upload,
  Users,
  UsersRound,
  Webhook,
  Zap,
  BotMessageSquare,
  type LucideIcon,
} from "lucide-react";
import { CHECKLIST_MANAGE_CAPS } from "./checklists-caps";
import { MOVED_SETTINGS } from "./integrations-hub-shared";
import { rankSettings } from "../settings-search";

/** A card inside a page, reached by its anchor (`id` on the card). */
export interface DeskSettingsTopic {
  anchor: string;
  label: string;
  keywords?: string;
}

/** One page: a tab of its section, or the section itself when it has one page. */
export interface DeskSettingsPage {
  href: string;
  label: string;
  icon: LucideIcon;
  /**
   * The desk capabilities that open it (any one). Empty: every desk user
   * (Notifications). The page checks the same itself (SETTINGS_CAP in
   * app/(desk)/desk-access); the test holds the two together.
   */
  caps: readonly string[];
  /**
   * A page that lives in CompassDocs settings, not the desk (the Duo check
   * is in Settings → Single sign-on): opens for whoever can open that
   * CompassDocs section (lib/auth reachableSettingsSections).
   */
  adminSection?: string;
  keywords?: string;
  topics?: DeskSettingsTopic[];
  /** Kept out of the search (the alert source wizard). */
  unlisted?: boolean;
}

export interface DeskSettingsSection {
  key: string;
  label: string;
  icon: LucideIcon;
  /** One line under the section's title. */
  description: string;
  keywords: string;
  pages: DeskSettingsPage[];
  /**
   * Show the pages as tabs under the section's header (STYLEGUIDE §Settings
   * pages). False for the Integrations hub, whose pages are tiles with a
   * back link, and for one-page sections.
   */
  tabs: boolean;
}

export interface DeskSettingsGroup {
  label: string;
  sections: DeskSettingsSection[];
}

const S = "/desk/settings";
const ADMIN_CAPS = ["settings.manage"] as const;
const MACRO_CAPS = ["macros.manage_all", "macros.manage_team", "macros.manage_personal"] as const;

export const DESK_SETTINGS_GROUPS: DeskSettingsGroup[] = [
  {
    label: "General",
    sections: [
      { key: "setup", label: "Setup", icon: LifeBuoy, tabs: false, description: "The steps to get the helpdesk ready, and the starter sets.", keywords: "setup getting started checklist starter wizard", pages: [
          { href: "/desk/setup", label: "Setup", icon: LifeBuoy, caps: ADMIN_CAPS, keywords: "starter set teams request types first steps" },
        ] },
      { key: "appearance", label: "Appearance", icon: Sparkle, tabs: false, description: "How the desk looks for your agents.", keywords: "appearance background artwork wallpaper picture image theme look transparency dark light", pages: [
          { href: `${S}/appearance`, label: "Appearance", icon: Sparkle, caps: ADMIN_CAPS, topics: [
              { anchor: "artwork", label: "Background artwork", keywords: "background wallpaper picture image library upload light dark" },
              { anchor: "transparency", label: "Transparency", keywords: "transparency opacity blur frosted panels" },
            ] },
        ] },
    ],
  },
  {
    label: "Teams and people",
    sections: [
      { key: "teams", label: "Teams", icon: Users, tabs: false, description: "Who answers for what. Membership decides which queues an agent works.", keywords: "teams queues groups departments members hours targets", pages: [
          { href: `${S}/teams`, label: "Teams", icon: Users, caps: ["teams.manage"], keywords: "team queue members people hours" },
        ] },
      { key: "agents", label: "Agents and roles", icon: UsersRound, tabs: true, description: "Who works on the desk, at which role, with which skills and languages.", keywords: "agents people staff roles permissions capabilities newbie lead manager admin skills languages", pages: [
          { href: `${S}/agents`, label: "Agents", icon: UsersRound, caps: ["agents.manage_team", "agents.assign_roles"], keywords: "agents people staff add remove desk role newbie team lead manager" },
          { href: `${S}/skills`, label: "Skills and languages", icon: Languages, caps: ["agents.manage_team", "teams.manage"], keywords: "skills languages routing tags expertise", topics: [
              { anchor: "skills", label: "Skills", keywords: "skills expertise tags routing" },
              { anchor: "languages", label: "Languages", keywords: "languages spoken translation routing" },
            ] },
          { href: `${S}/roles`, label: "Roles", icon: ShieldCheck, caps: ["roles.manage"], keywords: "roles permissions capabilities matrix access rights" },
        ] },
      { key: "assignment", label: "Assignment", icon: Shuffle, tabs: true, description: "How new tickets find an owner: by hand, in turn, or to whoever is least busy. Rules run first.", keywords: "assignment round robin least busy auto assign routing owner", pages: [
          { href: `${S}/assignment`, label: "Teams", icon: Users, caps: ["agents.manage_team"], keywords: "round robin least busy capacity who takes tickets" },
          { href: `${S}/assignment/rules`, label: "Rules", icon: ListOrdered, caps: ["automations.manage"], keywords: "assignment rules routing conditions order test" },
          { href: `${S}/assignment/on-call`, label: "On call", icon: PhoneCall, caps: ["agents.manage_team"], keywords: "on call rota rotation cover out of hours pager" },
        ] },
    ],
  },
  {
    label: "Email",
    sections: [
      { key: "email", label: "Email", icon: Mail, tabs: false, description: "Forward your help addresses here, and replies thread back into the ticket.", keywords: "email mail inbound outbound help address mailbox smtp forward reply", pages: [
          { href: `${S}/email`, label: "Email", icon: Mail, caps: ["channels.manage"], keywords: "email mail mailbox inbox smtp", topics: [
              { anchor: "addresses", label: "Help addresses", keywords: "help address mailbox inbox support address forward smtp incoming mail" },
              { anchor: "microsoft-365", label: "Microsoft 365 mailboxes", keywords: "microsoft 365 m365 office 365 o365 outlook exchange graph shared mailbox connect" },
              { anchor: "send-from", label: "Send-from addresses", keywords: "send from sender reply from outgoing smtp spf dkim domain" },
              { anchor: "email-webhook", label: "Mail webhook", keywords: "webhook inbound forward mailgun postmark sendgrid" },
              { anchor: "who-can-write-in", label: "Who can write in", keywords: "outside senders external allow block spam domains" },
            ] },
        ] },
      { key: "email-templates", label: "Email templates", icon: MailPlus, tabs: false, description: "The header, body, signature and footer of each helpdesk email.", keywords: "email templates notifications messages header body signature footer wording branding", pages: [
          { href: `${S}/email-templates`, label: "Email templates", icon: MailPlus, caps: ["templates.manage"], keywords: "template email wording header body signature footer" },
        ] },
    ],
  },
  {
    label: "Tickets",
    sections: [
      { key: "fields", label: "Forms and fields", icon: List, tabs: true, description: "What people pick and answer when they ask for help, and what agents fill in.", keywords: "forms fields request types categories custom fields checklists before you solve", pages: [
          { href: `${S}/request-types`, label: "Request types", icon: List, caps: ["request_types.manage"], keywords: "request types forms questions get help intake ticket type" },
          { href: `${S}/categories`, label: "Categories", icon: FolderTree, caps: ADMIN_CAPS, keywords: "categories sub-categories subcategories classification tags drafts from claude" },
          { href: `${S}/custom-fields`, label: "Custom fields", icon: TextCursorInput, caps: ADMIN_CAPS, keywords: "custom fields extra fields attributes per team public agent only" },
          { href: `${S}/checklists`, label: "Checklists", icon: ListChecks, caps: CHECKLIST_MANAGE_CAPS, keywords: "checklists steps tasks to-do required items" },
          { href: `${S}/before-you-solve`, label: "Before you solve", icon: ClipboardCheck, caps: ADMIN_CAPS, keywords: "before you solve solve requirements closing fields required mandatory resolution" },
        ] },
      // 1.20.20: the reply lock (lib/helpdesk/reply-lock).
      { key: "reply-lock", label: "Reply lock", icon: LockKeyhole, tabs: false, description: "One agent at a time writes a ticket's reply. Others see who, and can still add notes.", keywords: "reply lock collision collisions takeover take over locked replying at once two agents same ticket double reply", pages: [
          { href: `${S}/reply-lock`, label: "Reply lock", icon: LockKeyhole, caps: ADMIN_CAPS, topics: [
              { anchor: "reply-lock", label: "Reply lock", keywords: "lock collision reply lock takeover take over on off" },
              { anchor: "reply-lock-idle", label: "When a lock lets go", keywords: "idle timeout minutes release expire away" },
              { anchor: "reply-lock-now", label: "Replies being written now", keywords: "release locks held stuck hoarding release all who is replying" },
            ] },
        ] },
      { key: "reply-targets", label: "Reply targets", icon: Clock, tabs: true, description: "Targets for each priority, and the office hours and holidays they are counted in.", keywords: "sla service level reply targets response time resolution due dates business hours calendars", pages: [
          { href: `${S}/sla`, label: "Targets", icon: Clock, caps: ["sla.manage"], keywords: "sla service level agreement reply targets first response resolution due dates due times breach priority", topics: [
              { anchor: "targets", label: "Targets by priority", keywords: "sla priority urgent high first reply resolve hours due dates" },
            ] },
          { href: `${S}/calendars`, label: "Office hours", icon: CalendarClock, caps: ["sla.manage"], keywords: "business hours office hours working hours calendars time zone open closed", topics: [
              { anchor: "calendars", label: "Business calendars", keywords: "business hours working week time zone opening" },
            ] },
          { href: `${S}/calendars/holidays`, label: "Holidays", icon: CalendarDays, caps: ["sla.manage"], keywords: "holidays public holidays bank holidays closed days", topics: [
              { anchor: "holiday-sets", label: "Holiday sets", keywords: "bank holidays public holidays import" },
            ] },
          { href: `${S}/calendars/test`, label: "Test a due time", icon: Timer, caps: ["sla.manage"], keywords: "test due time due date calculator when is it due" },
        ] },
      { key: "event-calendar", label: "Event calendar", icon: CalendarDays, tabs: false, description: "Reminders about the events on tickets, and the calendar feed links.", keywords: "event calendar events reminders ical ics feed subscribe outlook google calendar", pages: [
          { href: `${S}/event-calendar`, label: "Event calendar", icon: CalendarDays, caps: ADMIN_CAPS, topics: [
              { anchor: "reminders", label: "Event reminders", keywords: "reminders before events setup complete" },
              { anchor: "feed-links", label: "Calendar feed links", keywords: "ical ics feed subscribe outlook google private link revoke" },
            ] },
        ] },
    ],
  },
  {
    label: "Automation",
    sections: [
      { key: "automations", label: "Automations", icon: Bot, tabs: true, description: "Rules that sort and answer tickets for you, and tickets that open on a schedule.", keywords: "automations rules triggers auto recurring scheduled", pages: [
          { href: `${S}/automations`, label: "Automations", icon: Bot, caps: ["automations.manage"], keywords: "rules triggers when then conditions actions auto reply route drafts from claude" },
          { href: `${S}/recurring`, label: "Recurring tickets", icon: Repeat, caps: ["settings.manage", "agents.manage_team"], keywords: "recurring scheduled repeat every week month routine maintenance drafts from claude" },
        ] },
      { key: "macros", label: "Macros and replies", icon: Zap, tabs: true, description: "Macros and canned responses: one-click actions and saved replies, for you, your team or everyone.", keywords: "macros canned responses saved replies reply templates snippets quick replies", pages: [
          { href: `${S}/macros`, label: "Macros", icon: Zap, caps: MACRO_CAPS, keywords: "macros one click actions reply templates shortcuts" },
          { href: `${S}/canned`, label: "Canned responses", icon: MessageSquareText, caps: MACRO_CAPS, keywords: "canned responses saved replies reply templates snippets text" },
        ] },
    ],
  },
  {
    label: "Requesters",
    sections: [
      { key: "portal", label: "Customer portal", icon: Globe, tabs: true, description: "Let people outside your organisation raise and follow requests, without a CompassDocs account.", keywords: "customer portal support site external customers public help centre knowledge base", pages: [
          { href: `${S}/portal`, label: "Settings", icon: SlidersHorizontal, caps: ADMIN_CAPS, keywords: "portal on off brand protection captcha who can use", topics: [
              { anchor: "portal-requests", label: "What customers can ask for", keywords: "portal request types teams" },
              { anchor: "portal-access", label: "Who can use the portal", keywords: "portal domains sign in verification captcha" },
            ] },
          { href: `${S}/portal/help-centre`, label: "Help centre", icon: BookOpen, caps: ADMIN_CAPS, keywords: "help centre center knowledge base articles faq public seo indexing" },
          { href: `${S}/portal/customers`, label: "Customers", icon: UsersRound, caps: ADMIN_CAPS, keywords: "customers external people block unblock" },
        ] },
      { key: "csat", label: "Satisfaction", icon: Star, tabs: false, description: "Ask one question when a ticket is solved: how did we do?", keywords: "satisfaction csat survey rating feedback score how did we do", pages: [
          { href: `${S}/csat`, label: "Satisfaction", icon: Star, caps: ["csat.manage"], topics: [
              { anchor: "survey", label: "Satisfaction survey", keywords: "csat survey on off question rating" },
            ] },
        ] },
      { key: "contact-cards", label: "Contact cards", icon: Contact, tabs: false, description: "What agents see about the person who asked: directory fields, chat, VIPs.", keywords: "contact cards requester profile directory fields vip phone manager", pages: [
          { href: `${S}/contact-cards`, label: "Contact cards", icon: Contact, caps: ADMIN_CAPS, topics: [
              { anchor: "vips", label: "VIPs", keywords: "vip important people executives priority" },
              { anchor: "who-sees-what", label: "Who sees contact details", keywords: "privacy phone numbers visibility agents" },
            ] },
        ] },
      { key: "shortcuts", label: "Shortcuts", icon: Link, tabs: false, description: "Ways to start a request from elsewhere in CompassDocs, and the request type each opens.", keywords: "shortcuts get help links buttons quick request start a request", pages: [
          { href: `${S}/shortcuts`, label: "Shortcuts", icon: Link, caps: ADMIN_CAPS, keywords: "get help shortcuts request type links" },
        ] },
    ],
  },
  {
    label: "Integrations",
    sections: [
      { key: "integrations", label: "Integrations", icon: Plug, tabs: false, description: "Everything the helpdesk connects to: devices, chat apps, Claude, the API, and alert sources.", keywords: "integrations connect apps third party", pages: [
          { href: `${S}/integrations`, label: "Integrations", icon: Plug, caps: ["settings.manage", "channels.manage"], keywords: "integrations hub connect" },
          { href: `${S}/integrations/snipe-it`, label: "Snipe-IT", icon: Package, caps: ADMIN_CAPS, keywords: "snipe-it snipeit assets devices inventory hardware" },
          { href: `${S}/integrations/intune`, label: "Microsoft Intune", icon: Laptop, caps: ADMIN_CAPS, keywords: "intune microsoft endpoint devices compliance laptops mdm", topics: [
              { anchor: "intune-matching", label: "Matching devices to people", keywords: "intune serial match people" },
            ] },
          { href: `${S}/integrations/assets`, label: "Asset settings", icon: SlidersHorizontal, caps: ADMIN_CAPS, keywords: "assets devices who sees search all", topics: [
              { anchor: "who-sees-assets", label: "Who sees assets", keywords: "assets visibility agents search all devices" },
            ] },
          { href: `${S}/integrations/chat`, label: "Chat apps", icon: MessageCircle, caps: ADMIN_CAPS, keywords: "chat apps bot", topics: [
              { anchor: "chat-teams", label: "Microsoft Teams", keywords: "microsoft teams bot chat app" },
              { anchor: "chat-slack", label: "Slack", keywords: "slack bot chat app workspace" },
              { anchor: "chat-channels", label: "Channels that open tickets", keywords: "channels teams slack open tickets" },
            ] },
          { href: `${S}/integrations/claude-connector`, label: "Claude connector", icon: BotMessageSquare, caps: ADMIN_CAPS, keywords: "claude connector mcp anthropic ai assistant", topics: [
              { anchor: "claude-can", label: "What Claude can do with the connector", keywords: "mcp tools permissions read write" },
            ] },
          { href: `${S}/integrations/api`, label: "API and webhooks", icon: Webhook, caps: ADMIN_CAPS, keywords: "api rest tokens webhooks developers", topics: [
              { anchor: "api-tokens", label: "API tokens", keywords: "api tokens keys rest scripts developers bearer" },
              { anchor: "webhooks", label: "Webhooks", keywords: "webhooks outgoing events callbacks signed" },
            ] },
          { href: `${S}/integrations/alerts`, label: "Alert sources", icon: Bell, caps: ["settings.manage", "channels.manage"], keywords: "alerts monitoring grafana prometheus uptime bots automated mail intake" },
          { href: `${S}/integrations/new`, label: "New alert source", icon: Bell, caps: ["settings.manage", "channels.manage"], unlisted: true },
        ] },
      { key: "claude-desk", label: "Claude in the desk", icon: Sparkle, tabs: false, description: "A Claude chat in the desk that works on tickets with each agent.", keywords: "claude ai assistant anthropic chat llm drafts", pages: [
          { href: `${S}/claude-desk`, label: "Claude in the desk", icon: Sparkle, caps: ADMIN_CAPS, topics: [
              { anchor: "claude-abilities", label: "What Claude can do", keywords: "claude abilities web search actions" },
              { anchor: "claude-spending", label: "Claude spending", keywords: "claude budget spend cost limit monthly" },
            ] },
        ] },
    ],
  },
  {
    label: "Security and data",
    sections: [
      { key: "retention", label: "Retention and privacy", icon: Shield, tabs: false, description: "How long tickets are kept, and what happens to a person's tickets when their account goes.", keywords: "retention privacy gdpr delete anonymise anonymize data protection auto close", pages: [
          { href: `${S}/retention`, label: "Retention and privacy", icon: Shield, caps: ADMIN_CAPS, topics: [
              { anchor: "auto-close", label: "Close solved tickets automatically", keywords: "auto close closing solved days" },
              { anchor: "account-removal", label: "When an account is removed", keywords: "anonymise account removed export personal data gdpr" },
            ] },
        ] },
      { key: "import", label: "Import", icon: Upload, tabs: false, description: "Bring tickets across from Zoho Desk or a CSV file.", keywords: "import migrate zoho desk csv upload", pages: [
          { href: `${S}/import`, label: "Import", icon: Upload, caps: ADMIN_CAPS, keywords: "import zoho csv migrate" },
        ] },
      { key: "sign-in", label: "Sign-in and Duo", icon: Fingerprint, tabs: false, description: "The Duo check at sign-in, set in CompassDocs settings.", keywords: "duo mfa 2fa two factor multi factor authentication sign in login security", pages: [
          { href: "/admin/sso#duo", label: "Sign-in and Duo", icon: Fingerprint, caps: [], adminSection: "/admin/sso", keywords: "duo mfa 2fa two-factor multi-factor push sign in check" },
        ] },
    ],
  },
  {
    label: "You",
    sections: [
      { key: "notifications", label: "Notifications", icon: BellRing, tabs: false, description: "What reaches you about tickets, and where.", keywords: "notifications push alerts email sound quiet hours do not disturb", pages: [
          { href: `${S}/notifications`, label: "Notifications", icon: BellRing, caps: [], topics: [
              { anchor: "events", label: "What reaches you where", keywords: "events channels push email bell" },
              { anchor: "teams", label: "New tickets by team", keywords: "teams new tickets alerts" },
              { anchor: "quiet-hours", label: "Quiet hours", keywords: "quiet hours do not disturb dnd night" },
              { anchor: "following", label: "Following", keywords: "follow tickets I reply to" },
              { anchor: "emails", label: "Emails in the conversation", keywords: "formatted plain text html email view" },
              { anchor: "preview", label: "Preview and sound", keywords: "sound preview chime" },
              { anchor: "devices", label: "Push notifications", keywords: "push devices phone browser" },
            ] },
        ] },
    ],
  },
];

export const DESK_SETTINGS_SECTIONS: DeskSettingsSection[] = DESK_SETTINGS_GROUPS.flatMap((g) => g.sections);
export const DESK_SETTINGS_PAGES: DeskSettingsPage[] = DESK_SETTINGS_SECTIONS.flatMap((s) => s.pages);

/** The desk settings overview (/desk/settings). */
export const DESK_SETTINGS_HOME = S;

/**
 * Addresses that moved, and where each redirects (its old route stays as a
 * server page that checks sign-in and the capability first: STYLEGUIDE
 * §Integrations hub, "A page that moved keeps its old address").
 */
export const DESK_SETTINGS_MOVED: Readonly<Record<string, string>> = MOVED_SETTINGS;

/** Who is looking: their desk capabilities and the CompassDocs settings sections they reach. */
export interface DeskSettingsViewer {
  caps: readonly string[];
  adminSections?: readonly string[];
}

const pathOf = (href: string) => href.split("#")[0].split("?")[0];

export function canOpenDeskSettingsPage(viewer: DeskSettingsViewer, page: DeskSettingsPage): boolean {
  if (page.adminSection) return (viewer.adminSections ?? []).includes(page.adminSection);
  return page.caps.length === 0 || page.caps.some((c) => viewer.caps.includes(c));
}

/** The pages of a section this person may open (its tabs). */
export function deskSectionPages(viewer: DeskSettingsViewer, section: DeskSettingsSection): DeskSettingsPage[] {
  return section.pages.filter((p) => !p.unlisted && canOpenDeskSettingsPage(viewer, p));
}

/** The groups and sections this person reaches (empty ones left out). */
export function deskSettingsGroups(viewer: DeskSettingsViewer): DeskSettingsGroup[] {
  return DESK_SETTINGS_GROUPS.map((g) => ({ ...g, sections: g.sections.filter((s) => deskSectionPages(viewer, s).length > 0) })).filter(
    (g) => g.sections.length > 0
  );
}

/** Where a section's rail entry goes: its first page the person may open. */
export function deskSectionLanding(viewer: DeskSettingsViewer, section: DeskSettingsSection): string {
  return deskSectionPages(viewer, section)[0]?.href ?? section.pages[0].href;
}

/** The registered page an address is on (the longest page href it is, or is under). */
export function deskSettingsPageFor(pathname: string): { section: DeskSettingsSection; page: DeskSettingsPage } | undefined {
  let best: { section: DeskSettingsSection; page: DeskSettingsPage } | undefined;
  for (const section of DESK_SETTINGS_SECTIONS) {
    for (const page of section.pages) {
      const p = pathOf(page.href);
      if (pathname === p || pathname.startsWith(`${p}/`)) {
        if (!best || p.length > pathOf(best.page.href).length) best = { section, page };
      }
    }
  }
  return best;
}

/**
 * The section whose header and tab row this address shows: only on a tab
 * itself (a detail page under a tab, such as one requirement set, keeps its
 * own header and back link), only for a tabbed section, and only when the
 * person may open that tab.
 */
export function deskTabbedSectionAt(pathname: string, viewer: DeskSettingsViewer): { section: DeskSettingsSection; tabs: DeskSettingsPage[] } | undefined {
  const at = deskSettingsPageFor(pathname);
  if (!at || !at.section.tabs || pathOf(at.page.href) !== pathname) return undefined;
  if (!canOpenDeskSettingsPage(viewer, at.page)) return undefined;
  return { section: at.section, tabs: deskSectionPages(viewer, at.section) };
}

/** First page this person reaches (Setup aside). */
export function firstDeskSettingsHref(viewer: DeskSettingsViewer): string {
  for (const s of deskSettingsGroups(viewer).flatMap((g) => g.sections)) {
    if (s.key === "setup" || s.key === "sign-in") continue;
    return deskSectionLanding(viewer, s);
  }
  return `${S}/notifications`;
}

/** One searchable row: a section, a page (tab) in it, or a setting (card) on a page. */
export interface DeskSettingsHit {
  kind: "section" | "page" | "topic";
  section: DeskSettingsSection;
  page: DeskSettingsPage;
  href: string;
  label: string;
  /** Where it is: the section, and the tab when the section has tabs. */
  trail: string[];
  haystack: string;
}

/** Every searchable row, sections first, before permissions. */
export const DESK_SETTINGS_INDEX: DeskSettingsHit[] = DESK_SETTINGS_SECTIONS.flatMap((section) => {
  const first = section.pages[0];
  const rows: DeskSettingsHit[] = [
    { kind: "section", section, page: first, href: first.href, label: section.label, trail: [], haystack: `${section.label} ${section.keywords}`.toLowerCase() },
  ];
  for (const page of section.pages) {
    if (page.unlisted) continue;
    const own = page.label !== section.label;
    if (own)
      rows.push({ kind: "page", section, page, href: page.href, label: page.label, trail: [section.label], haystack: `${section.label} ${page.label} ${page.keywords ?? ""}`.toLowerCase() });
    for (const t of page.topics ?? []) {
      rows.push({
        kind: "topic",
        section,
        page,
        href: `${pathOf(page.href)}#${t.anchor}`,
        label: t.label,
        trail: own ? [section.label, page.label] : [section.label],
        haystack: `${section.label} ${own ? page.label : ""} ${t.label} ${t.keywords ?? ""}`.toLowerCase(),
      });
    }
  }
  return rows;
});

/**
 * The search: rows this person may open that match every word of the query,
 * best first (lib/settings-search, shared with CompassDocs settings). A
 * section row goes to the first of its tabs the person may open.
 */
export function searchDeskSettings(viewer: DeskSettingsViewer, query: string, limit = 12): DeskSettingsHit[] {
  const open = DESK_SETTINGS_INDEX.filter((h) =>
    h.kind === "section" ? deskSectionPages(viewer, h.section).length > 0 : canOpenDeskSettingsPage(viewer, h.page)
  ).map((h) => (h.kind === "section" ? { ...h, href: deskSectionLanding(viewer, h.section) } : h));
  return rankSettings(open, query, (h) => h.label, (h) => h.haystack).slice(0, limit);
}
