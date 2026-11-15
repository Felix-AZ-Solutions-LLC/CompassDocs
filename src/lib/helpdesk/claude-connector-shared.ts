// Helpdesk 1.19.1: what the Claude connector (MCP) may do in the helpdesk
// (agent V1). Client-safe: Desk settings → Claude connector, the MCP tools
// (lib/mcp/helpdesk-tools) and the tests read one set of words and rules.
//
// Claude always acts as the person who connected it, with their desk role
// and teams; the workspace level below only ever narrows that.
//
//   read     find and read what the person can see, and summarise it
//   notes    (default) also write: internal notes, reply drafts, the
//            person's own requests and replies on them, and drafts of
//            workflows, request types, macros, (1.20.14) checklists and
//            (1.20.16) category list changes, automations and recurring
//            tickets (a new rule saved off, a new schedule saved paused)
//   update   also change tickets: status, priority, team, assignee, tags,
//            and (1.20.14) ticking checklist items and adding checklists,
//            and (1.20.15) applying macros (a macro's reply becomes a draft)
//
// Whatever the level, three things are never possible (no tool exists and
// no setting adds one): sending a reply to a requester, deciding an
// approval, and publishing a workflow, request type, macro, checklist,
// (1.20.16) category change, automation or recurring ticket. No tool
// switches a rule or a schedule on, deletes or merges anything.

export const HD_CLAUDE_KEY = "helpdesk_claude_connector";

export const HD_CLAUDE_LEVELS = ["read", "notes", "update"] as const;
export type HdClaudeLevel = (typeof HD_CLAUDE_LEVELS)[number];

export const HD_CLAUDE_DEFAULT_LEVEL: HdClaudeLevel = "notes";

export const HD_CLAUDE_LEVEL_RANK: Record<HdClaudeLevel, number> = { read: 0, notes: 1, update: 2 };

export function isClaudeLevel(v: unknown): v is HdClaudeLevel {
  return typeof v === "string" && (HD_CLAUDE_LEVELS as readonly string[]).includes(v);
}

export const HD_CLAUDE_LEVEL_LABEL: Record<HdClaudeLevel, string> = {
  read: "Read only",
  notes: "Read, add internal notes and save reply drafts",
  update: "Also update tickets",
};

export const HD_CLAUDE_LEVEL_HINT: Record<HdClaudeLevel, string> = {
  read: "Find and read requests and tickets the person can see, and summarise them.",
  notes: "Recommended. Drafts wait in the ticket for an agent to send or discard.",
  update: "Status, priority, team, assignee, tags, checklist items and macros, within the person's role.",
};

/** The never-list, word for word as Desk settings shows it. */
export const HD_CLAUDE_NEVER: readonly string[] = [
  "Send a reply to a requester, a macro's reply included: Claude saves a draft and a person sends it.",
  "Approve or decline: Claude lists what's waiting and links to the approval.",
  "Publish a workflow, request type, macro, checklist, category change, automation or recurring ticket: Claude saves a draft for someone to publish, and never switches a rule or schedule on.",
];

/** Audit actions the connector writes (each row carries details.via = "mcp"). */
export const HD_CLAUDE_AUDIT_ACTIONS = [
  "helpdesk.request.created",
  "helpdesk.request.replied",
  "helpdesk.note.added",
  "helpdesk.reply_draft.created",
  "helpdesk.ticket.updated",
  "helpdesk.workflow.created",
  "helpdesk.workflow.updated",
  "helpdesk.request_type.created",
  "helpdesk.macro.created",
  // 1.20.14: checklist drafts, ticks and checklists added on tickets.
  "helpdesk.checklist_template.created",
  "helpdesk.checklist_template.updated",
  "helpdesk.checklist.item_ticked",
  "helpdesk.checklist.item_unticked",
  "helpdesk.checklist.added",
  // 1.20.15: a macro applied (its reply saved as a draft).
  "helpdesk.macro.applied",
  // 1.20.16: drafts of category list changes, automations and recurring tickets.
  "helpdesk.category_draft.created",
  "helpdesk.category_draft.updated",
  "helpdesk.automation.created",
  "helpdesk.automation.updated",
  "helpdesk.recurring.created",
  "helpdesk.recurring.updated",
] as const;

/** One line of "Recent activity via Claude". */
export interface HdClaudeActivity {
  id: number;
  at: string;
  actor_id: number | null;
  actor_name: string;
  action: string;
  /** "Saved a reply draft on #1047". */
  summary: string;
}

/** The activity line for an audit row the connector wrote. */
export function claudeActivitySummary(action: string, details: Record<string, unknown> | null, label: string | null): string {
  const n = typeof details?.number === "number" ? `#${details.number}` : "";
  const name = (label ?? "").trim();
  switch (action) {
    case "helpdesk.request.created":
      return n ? `Raised ${n} from Claude` : "Raised a request from Claude";
    case "helpdesk.request.replied":
      return n ? `Replied on ${n}` : "Replied on a request";
    case "helpdesk.note.added":
      return n ? `Added an internal note on ${n}` : "Added an internal note";
    case "helpdesk.reply_draft.created":
      return n ? `Saved a reply draft on ${n}` : "Saved a reply draft";
    case "helpdesk.ticket.updated":
      return n ? `Updated ${n}` : "Updated a ticket";
    case "helpdesk.workflow.created":
    case "helpdesk.workflow.updated":
      return name ? `Saved a workflow draft: ${name}` : "Saved a workflow draft";
    case "helpdesk.request_type.created":
      return name ? `Saved a request type draft: ${name}` : "Saved a request type draft";
    case "helpdesk.macro.created":
      return name ? `Saved a macro draft: ${name}` : "Saved a macro draft";
    case "helpdesk.checklist_template.created":
    case "helpdesk.checklist_template.updated":
      return name ? `Saved a checklist draft: ${name}` : "Saved a checklist draft";
    case "helpdesk.checklist.item_ticked": {
      const title = typeof details?.title === "string" ? ` "${details.title}"` : " an item";
      return n ? `Ticked${title} on ${n}` : `Ticked${title}`;
    }
    case "helpdesk.checklist.item_unticked": {
      const title = typeof details?.title === "string" ? ` "${details.title}"` : " an item";
      return n ? `Unticked${title} on ${n}` : `Unticked${title}`;
    }
    case "helpdesk.checklist.added": {
      const list = typeof details?.name === "string" ? ` "${details.name}"` : "";
      return n ? `Added the checklist${list} to ${n}` : `Added the checklist${list}`;
    }
    case "helpdesk.macro.applied": {
      const macro = typeof details?.macro === "string" ? ` "${details.macro}"` : "";
      const draft = details?.reply === "draft" ? " (reply saved as a draft)" : "";
      return n ? `Applied the macro${macro} to ${n}${draft}` : `Applied the macro${macro}${draft}`;
    }
    case "helpdesk.category_draft.created":
    case "helpdesk.category_draft.updated": {
      const c = typeof details?.changes === "number" ? details.changes : 0;
      return c ? `Saved a draft of ${c} category ${c === 1 ? "change" : "changes"}` : "Saved a draft of category changes";
    }
    case "helpdesk.automation.created":
    case "helpdesk.automation.updated":
      return name ? `Saved an automation draft: ${name}` : "Saved an automation draft";
    case "helpdesk.recurring.created":
    case "helpdesk.recurring.updated":
      return name ? `Saved a recurring ticket draft: ${name}` : "Saved a recurring ticket draft";
    default:
      return name || action;
  }
}
