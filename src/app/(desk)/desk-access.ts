// Who may use the desk, and what they see in it (1.19.0). Server-only.
//
// The desk is open to anyone holding a desk-side helpdesk permission:
// helpdesk.agent / helpdesk.agent_all (queues), helpdesk.admin
// (configuration) and helpdesk.reports (reports). The answers come from the
// core's helpdeskCapabilities (lib/helpdesk/access), the same checks the
// API's helpdeskGate makes, so a page never admits someone its routes
// would refuse.

import "server-only";
import { cache } from "react";
import { userHolds } from "@/lib/access";
import { helpdeskCapabilities } from "@/lib/helpdesk/access";
import { getAvailability } from "@/lib/helpdesk/teams";
import { hdCapsFor } from "@/lib/helpdesk/roles";
import { HD_ROLE_LABEL } from "@/lib/helpdesk/roles-shared";
import type { SessionUser } from "@/lib/types";
import type { HdAvailability } from "@/lib/helpdesk/types";
import type { HdEmailView } from "@/lib/helpdesk/email-html-shared";
import type { HdTicketOrder } from "@/lib/helpdesk/conversation-shared";
import type { HdQueueSort } from "@/lib/helpdesk/queue-sort-shared";

export interface DeskAccess {
  licensed: boolean;
  agent: boolean;
  agentAll: boolean;
  admin: boolean;
  reports: boolean;
  /** May open Settings → License (the gate's button). */
  manageLicense: boolean;
  /** Any desk-side permission at all. */
  any: boolean;
}

export const deskAccess = cache(async (user: SessionUser): Promise<DeskAccess> => {
  const [caps, manageLicense] = await Promise.all([
    helpdeskCapabilities(user),
    userHolds(user, "workspace.settings_read", { legacyMin: "admin" }),
  ]);
  return {
    licensed: caps.licensed,
    agent: caps.agent,
    agentAll: caps.agent_all,
    admin: caps.admin,
    reports: caps.reports,
    manageLicense,
    any: caps.agent || caps.admin || caps.reports,
  };
});

/** The agent's availability (hd_agent_prefs); "available" until they set one. */
export async function agentAvailability(userId: number): Promise<HdAvailability> {
  return getAvailability(userId).catch(() => "available" as const);
}

/**
 * How the agent reads a ticket (their desk preferences, lib/helpdesk/notify-prefs): emailed messages formatted or
 * as plain text (1.20.11), the conversation newest first with the reply box on top or oldest first (1.20.28), and
 * how the queue's list is sorted (1.20.36, null for the default), so the first paint already shows their order.
 */
export async function agentReadingPrefs(userId: number): Promise<{ emailView: HdEmailView; ticketOrder: HdTicketOrder; queueSort: HdQueueSort | null }> {
  const { getNotifyPrefs } = await import("@/lib/helpdesk/notify-prefs");
  return getNotifyPrefs(userId)
    .then((p) => ({ emailView: p.email_view, ticketOrder: p.ticket_order, queueSort: p.queue_sort }))
    .catch(() => ({ emailView: "formatted" as const, ticketOrder: "newest" as const, queueSort: null }));
}

/**
 * The agent's desk role (Newbie, Agent, Team lead, Manager, Admin) and its
 * capabilities (agent J's lib/helpdesk/roles hdCapsFor), which decide which
 * controls the desk shows: assign to others, change priority or status,
 * transfer, delete, export, review replies, and each settings page. The
 * routes check the same capabilities, so hiding a control never hides
 * something the person could do.
 */
export interface DeskRoleCaps {
  role: { key: string; label: string } | null;
  caps: string[];
  can: (cap: string) => boolean;
}

export const deskRoleCaps = cache(async (user: SessionUser): Promise<DeskRoleCaps> => {
  const v = await hdCapsFor(user).catch(() => null);
  const caps: string[] = v ? [...v.caps] : [];
  const role = v?.role ? { key: v.role, label: HD_ROLE_LABEL[v.role] } : null;
  return { role, caps, can: (c) => caps.includes(c) };
});

/** The settings pages and the capability each needs (the nav and the pages read this). */
// 1.20.23 (lib/helpdesk/desk-departments): "Manage a desk department" (departments.manage) opens
// every page whose content lives in desk departments, for its holder's own departments; the
// departments themselves (Desk departments) are desk Admin's.
export const SETTINGS_CAP: Record<string, string[]> = {
  setup: ["settings.manage"],
  teams: ["teams.manage"],
  departments: ["settings.manage"],
  "request-types": ["request_types.manage", "departments.manage"],
  sla: ["sla.manage"],
  email: ["channels.manage"],
  automations: ["automations.manage", "departments.manage"],
  macros: ["macros.manage_all", "macros.manage_team", "macros.manage_personal", "departments.manage"],
  // Canned responses (1.19.2, agent W4).
  canned: ["macros.manage_all", "macros.manage_team", "macros.manage_personal", "departments.manage"],
  // Checklists (1.19.2, agent W3, lib/helpdesk/checklists-caps).
  checklists: ["settings.manage", "request_types.manage", "workflows.manage", "departments.manage"],
  // "Before you solve" requirement sets (1.20.5, lib/helpdesk/solve-requirements).
  "before-you-solve": ["settings.manage"],
  // Managed categories and sub-categories (1.20.6, lib/helpdesk/categories).
  categories: ["settings.manage"],
  // The event calendar's reminders and feed links (1.20.6, lib/helpdesk/desk-calendar).
  "event-calendar": ["settings.manage"],
  // Custom fields per team (1.20.6, lib/helpdesk/custom-fields).
  "custom-fields": ["settings.manage"],
  csat: ["csat.manage"],
  workflows: ["workflows.manage", "departments.manage"],
  "contact-cards": ["settings.manage"],
  // Team settings, people and on call: agents.manage_team (a lead for their own teams); rules: automations.manage (agent N).
  assignment: ["agents.manage_team", "automations.manage"],
  // Skills and languages (1.19.2, agent W2).
  skills: ["agents.manage_team", "teams.manage"],
  integrations: ["settings.manage", "channels.manage"],
  // Recurring tickets: every team (settings.manage) or a lead's own teams (1.19.1, agent V8).
  recurring: ["settings.manage", "agents.manage_team", "departments.manage"],
  // The Claude connector's workspace level (1.19.1, agent V1).
  claude: ["settings.manage"],
  // The customer portal for outside requesters (1.19.1, agent V6).
  portal: ["settings.manage"],
  // Ticket import from Zoho Desk or CSV (1.19.1, agent V7).
  import: ["settings.manage"],
  // Shortcut defaults and retention and privacy (1.19.1, agent V5).
  shortcuts: ["settings.manage"],
  retention: ["settings.manage"],
  // Assets: the Snipe-IT source (1.19.3, lib/helpdesk/assets).
  assets: ["settings.manage"],
  // Chat apps: Microsoft Teams and Slack (1.19.4 C1, lib/helpdesk/chat).
  chat: ["settings.manage"],
  // Appearance: the desk's background artwork (1.19.4 C5, lib/helpdesk/appearance).
  appearance: ["settings.manage"],
  // API tokens and outgoing webhooks (1.19.4 C2, lib/helpdesk/api-tokens, webhooks).
  api: ["settings.manage"],
  // Claude in the desk (1.20.0, lib/helpdesk/claude).
  "claude-desk": ["settings.manage"],
  // The reply lock (1.20.20, lib/helpdesk/reply-lock).
  "reply-lock": ["settings.manage"],
};

/** May this person open that settings page? */
export async function canOpenSettings(user: SessionUser, page: keyof typeof SETTINGS_CAP): Promise<boolean> {
  const r = await deskRoleCaps(user);
  return SETTINGS_CAP[page].some((c) => r.can(c));
}
