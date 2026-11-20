// Helpdesk tools in the Claude connector (1.19.1, agent V1). Definitions and
// handlers for the hd_* tools that src/app/api/mcp/route.ts lists and
// dispatches. The connector acts as the person who connected it: every tool
// asks lib/helpdesk exactly what the app's routes ask (helpdeskLicensed →
// 402, hdHolds/isAgent/hdCan per capability, canWorkTicket/ticketRelation,
// requesterSafe reads, the same rate limits) and writes through the same
// library functions (createTicket, addMessage with its newbie review,
// updateTicket, the workflow / request type / macro validators), so a tool
// can never do what the person could not do in the app.
//
// The owner's rules, which no setting changes:
//   - replies are DRAFTS ONLY. hd_draft_reply saves a draft the desk shows
//     as "Draft from Claude"; no tool sends a public reply to a requester.
//     (1.20.15: hd_apply_macro keeps the rule: a macro's reply is saved as
//     such a draft, and its status change is not made: an agent sets it
//     after sending the reply.)
//   - no tool approves or declines: hd_my_approvals returns approve_url.
//   - nothing is published: workflows, request types, macros and (1.20.14)
//     checklists are saved as drafts (an unpublished workflow draft, a
//     switched-off request type, a personal macro, an unpublished checklist
//     or proposed changes beside the live one) for a person to publish in
//     the app. 1.20.16: so are category list changes (a draft beside the
//     list), automations (a new rule saved off, or changes beside a running
//     one) and recurring tickets (a new schedule saved paused, or changes
//     beside a live one); no tool switches a rule or a schedule on, deletes
//     or merges anything.
// On top, Desk settings → Claude connector sets a workspace level (read /
// notes / update, lib/helpdesk/claude-connector) that every write checks.
//
// Every write is audited with details.via = "mcp" and the caller's address;
// messages written here carry via 'mcp' and ticket changes end "via Claude"
// on the timeline. Requesters never see internal notes or drafts.
// Server-only.

import { audit, actorFrom } from "../audit";
import { toSessionUser } from "../auth";
import { exportRateLimited } from "../rate-limit";
import type { User } from "../types";
import {
  agentTeamIds,
  canWorkTicket,
  hdHolds,
  hdRateLimited,
  helpdeskLicensed,
  HD_LICENCE_ERROR,
  isAgent,
  messagePostLimited,
  requestCreateLimited,
  ticketRelation,
} from "../helpdesk/access";
import type { TicketRelation } from "../helpdesk/access";
import { hdCan, HD_FORBIDDEN } from "../helpdesk/roles";
import { deskDepartmentScope } from "../helpdesk/desk-departments";
import {
  createTicket,
  getTicketByNumber,
  HdTicketError,
  isPriorityValue,
  isStatus,
  listMyRequests,
  listTickets,
  parseTicketNumber,
  parseView,
  TICKET_LIMITS,
  updateTicket,
  validateTicketPatch,
} from "../helpdesk/tickets";
import type { TicketListFilters } from "../helpdesk/tickets";
import { addMessage, MESSAGE_LIMITS } from "../helpdesk/messages";
import { textField } from "../helpdesk/routes";
import { getClaudeLevel, HD_CLAUDE_LEVEL_LABEL, HD_CLAUDE_LEVEL_RANK, type HdClaudeLevel } from "../helpdesk/claude-connector";
import { createReplyDraft, listPendingDrafts, DRAFT_LIMITS } from "../helpdesk/drafts";
import { mergedLock } from "../helpdesk/merge";
import { CANNED_TOOL_DEF, cannedResponsesTool } from "./canned-tool";
import { ASSET_TOOL_DEF, assetLookupTool } from "./assets-tool";
import type { HdFormField, HdMessage, HdTicket } from "../helpdesk/types";

type Args = Record<string, any>;
interface Ctx {
  /** The public origin, for absolute links. */
  origin: string;
  /** The caller's address, as lib/audit reads it. */
  ip: string | null;
}

// --- Tool output -----------------------------------------------------------------

function toolText(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}
function toolJson(value: unknown) {
  return toolText(JSON.stringify(value, null, 2));
}
const refuse = (text: string) => toolText(text, true);

// --- Definitions -------------------------------------------------------------------

type Side = "request" | "agent" | "reports" | "workflows" | "request_types" | "macros" | "checklists" | "macro_use" | "categories" | "automations" | "recurring";

interface HdToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Who it is for (listing and the first check of every call). */
  side: Side;
  /** The workspace level a write needs; reads have none. */
  write?: Exclude<HdClaudeLevel, "read">;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const NUMBER = { type: "number", description: "The ticket or request number (#1047 → 1047)." };

/** The tools, in the order tools/list shows them. */
export const HELPDESK_TOOL_DEFS: HdToolDef[] = [
  // Requester side (helpdesk.request).
  {
    name: "hd_request_types",
    side: "request",
    description:
      "Helpdesk: what the person can ask for. Lists the request types they may use, each with its form questions (key, label, type, options, required) and what happens next, including who approves. Pass slug for one type with answers prefilled from their directory entry. Use before hd_create_request.",
    inputSchema: obj({ slug: { type: "string", description: "One request type's slug, for its full form and prefilled answers." } }),
  },
  {
    name: "hd_suggest_articles",
    side: "request",
    description:
      "Helpdesk: documents in this workspace that may already answer a question, before a request is raised. Only documents the person can read. Offer these first; raise a request only if they don't help.",
    inputSchema: obj(
      {
        query: { type: "string", description: "The question or problem, in a few words." },
        limit: { type: "number", description: "1 to 8 (default 5)." },
      },
      ["query"]
    ),
  },
  {
    name: "hd_create_request",
    side: "request",
    write: "notes",
    description:
      "Helpdesk: raise a request for the person, as Get help would. With request_type (slug or id from hd_request_types), answers are checked like the form (required fields, options, dates, people). Without one, send subject and body. Returns the request number and its link. Confirm the details with the person before calling.",
    inputSchema: obj({
      request_type: { type: ["string", "number"], description: "Request type slug or id (from hd_request_types). Optional." },
      subject: { type: "string", description: "A few words. Defaults to the request type's title." },
      body: { type: "string", description: "What they need, in their words (markdown)." },
      answers: { type: "object", description: "Form answers keyed by question key." },
    }),
  },
  {
    name: "hd_my_requests",
    side: "request",
    description: "Helpdesk: the person's own requests, newest first, with status and where each one is (the current workflow step).",
    inputSchema: obj({ status: { type: "string", enum: ["open", "solved"], description: "Only open or only solved ones. Omit for both." } }),
  },
  {
    name: "hd_read_request",
    side: "request",
    description:
      "Helpdesk: one of the person's requests (or one they approve): status, progress steps, form answers and the public conversation. Never internal notes. Agents working a ticket use hd_read_ticket instead.",
    inputSchema: obj({ number: NUMBER }, ["number"]),
  },
  {
    name: "hd_reply_to_request",
    side: "request",
    write: "notes",
    description:
      "Helpdesk: add the person's own public reply to THEIR OWN request (as they would in Get help). A request waiting on them, or solved, opens again. This is the requester's own message; it is not for agents replying to requesters (agents use hd_draft_reply). Confirm the wording with the person first.",
    inputSchema: obj({ number: NUMBER, body: { type: "string", description: "The reply (markdown)." } }, ["number", "body"]),
  },
  {
    name: "hd_my_approvals",
    side: "request",
    description:
      "Helpdesk: approvals waiting for the person's decision, with the request's answers and opening message for context. No tool approves or declines: give the person approve_url so they decide in the app.",
    inputSchema: obj({}),
  },
  // Agent side (a desk role; capabilities apply).
  {
    name: "hd_queue",
    side: "agent",
    description:
      "Helpdesk desk: tickets in the person's queues (their teams' and those assigned to them; every team with See every team's tickets). Filter by view, team, status, priority, assignee, requester, tag, category, sub-category, custom field, missed target or text. Also lists the teams they work, with ids, the categories tickets can be given and the custom fields that can be filtered on.",
    inputSchema: obj({
      view: { type: "string", description: "mine | unassigned | open (default) | overdue | workflow | waiting | solved_week | parked (on hold until their event) | all | team:<id>" },
      team: { type: "number", description: "Team id." },
      status: { type: "string", enum: ["new", "open", "pending", "on_hold", "solved", "closed"] },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      assignee: { type: ["string", "number"], description: "A user id, \"me\" or \"none\"." },
      requester: { type: "number", description: "Requester's user id." },
      tag: { type: "string" },
      category: { type: "string", description: "A category's name (the result lists them), or \"none\" for tickets without one." },
      subcategory: { type: "string", description: "A sub-category's name; send its category too." },
      breached: { type: "boolean", description: "Only tickets past a running reply or resolution target now." },
      // 1.20.8 (additive): the queue's cf.<key> conditions (lib/helpdesk/custom-field-filters).
      custom_fields: {
        type: "object",
        description:
          'Custom field conditions by field key (the result lists the fields), all of which must match: { "device_type": "any:laptop,phone" }. Conditions: empty, filled, yes, no, any:<option values, comma-separated>, any_or_empty:<values>, contains:<text>, eq:/gte:/lte:<number>, on:/before:/after:<YYYY-MM-DD>, is:<user id>; only those that fit the field\'s kind. A value only matches on the field\'s teams; empty counts only tickets of those teams.',
      },
      query: { type: "string", description: "Text in the subject, requester or conversation, or a ticket number." },
      limit: { type: "number", description: "1 to 50 (default 25)." },
    }),
  },
  {
    name: "hd_read_ticket",
    side: "agent",
    description:
      "Helpdesk desk: the full ticket for an agent who works it: fields, reply and resolution targets, the whole conversation including internal notes, form answers, workflow progress and task hand-offs, the requester's contact card (directory visibility applies), agents it can be assigned to, any pending reply drafts, its checklists with checklist and item ids (required items must be ticked before it can be solved; tick them with hd_update_checklist) and the library checklists that can be added (checklist_templates), its linked assets (devices from Snipe-IT or Microsoft Intune) and the custom fields of its team with their values (custom_fields; set them with hd_update_ticket).",
    inputSchema: obj({ number: NUMBER }, ["number"]),
  },
  {
    name: "hd_add_internal_note",
    side: "agent",
    write: "notes",
    description:
      "Helpdesk desk: add an internal note to a ticket. Only agents see it; the requester never does and is not emailed. Needs the Add internal notes capability.",
    inputSchema: obj({ number: NUMBER, body: { type: "string", description: "The note (markdown)." } }, ["number", "body"]),
  },
  {
    name: "hd_draft_reply",
    side: "agent",
    write: "notes",
    description:
      "Helpdesk desk: save a reply DRAFT on a ticket. It is NOT sent: the draft waits in the ticket as \"Draft from Claude\" above the composer, and an agent edits it and sends it from the desk, or discards it (their send follows the normal rules, including newbie review). No tool sends a reply to a requester, and no setting allows it. Tell the person the draft is waiting in the desk. With canned_id (from hd_canned_responses), the draft starts from that canned response filled for this ticket, and body, if sent, follows it.",
    // 1.20.15 (additive): canned_id; body is then optional.
    inputSchema: obj(
      {
        number: NUMBER,
        body: { type: "string", description: "The reply text, addressed to the requester (markdown). Needed unless canned_id is sent." },
        canned_id: { type: "number", description: "A canned response's id (hd_canned_responses) the person may use: the draft starts from it, filled for this ticket." },
      },
      ["number"]
    ),
  },
  // Canned responses, read only (1.19.2, agent W4, lib/mcp/canned-tool).
  CANNED_TOOL_DEF,
  // Asset lookup, read only (1.19.3, lib/mcp/assets-tool).
  ASSET_TOOL_DEF,
  {
    name: "hd_update_ticket",
    side: "agent",
    write: "update",
    description:
      "Helpdesk desk: change a ticket's status, priority, team, assignee, tags, category, sub-category or custom fields, each within the person's desk role (Change status, Change priority, Transfer to another team, Take a ticket / Assign within their teams / Assign to anyone). Only when the workspace lets Claude update tickets. Changes show on the timeline \"via Claude\". A workspace may ask for details before a ticket is solved (\"Before you solve\"): hd_read_ticket lists them under before_you_solve; send the closing fields as solve_answers with status solved, after confirming the answers with the person. A category and a sub-category come from the desk admin's list (hd_read_ticket lists it under categories): a name that is not on it is refused, never added.",
    inputSchema: obj(
      {
        number: NUMBER,
        status: { type: "string", enum: ["new", "open", "pending", "on_hold", "solved", "closed"] },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        team_id: { type: ["number", "null"], description: "Team id (hd_queue lists them), or null for no team." },
        assignee_id: { type: ["number", "string", "null"], description: "An agent's user id (hd_read_ticket lists them), \"me\", or null to unassign." },
        tags: { type: "array", items: { type: "string" }, description: "The ticket's full tag list (replaces it)." },
        category: { type: ["string", "null"], description: "A category from the admin's list, by name (hd_read_ticket lists them); null or \"\" clears it and the sub-category." },
        subcategory: { type: ["string", "null"], description: "A sub-category of the ticket's category (or of `category`, sent with it), by name; null or \"\" clears it. A new category without one clears it." },
        custom_fields: {
          type: "object",
          description:
            "Custom field values keyed by field key from hd_read_ticket's custom_fields (text as a string, a choice as its option value, a number, a date YYYY-MM-DD, a date and time YYYY-MM-DDTHH:MM, yes/no as true or false, a person as their user id; null clears one). Only fields of the ticket's team can be set.",
        },
        solve_answers: {
          type: "object",
          description:
            "With status solved: the \"Before you solve\" closing fields, keyed by field key from hd_read_ticket's before_you_solve.closing_fields (text as a string, a choice as its option value, a number, a date YYYY-MM-DD, a tick as true, a person as their user id). Stored only if the ticket is solved.",
        },
        event: {
          type: ["object", "null"],
          description:
            "The ticket's event on the desk's Calendar (hd_read_ticket shows it as event). An object sets or changes it: starts_at and ends_at as date-times with their zone (2026-11-20T14:00:00Z or with an offset), or all_day true with start_date and end_date (YYYY-MM-DD, the last day inclusive); place; setup_minutes (how long before the start setup must be ready). setup_complete true marks the setup done: only after the person confirms it is, because the ticket can't be solved until then. null removes the event. park \"park\" holds the ticket until the event (on hold, out of the queue, targets paused; it wakes prep_days working days before setup is due, or the desk's window; refused with a sentence when the event is too close), park \"wake\" brings a parked ticket back now; prep_days alone (0 to 60, or null for the desk's) changes its window. Parking needs the person's Change status permission and their say-so; hd_read_ticket shows it as parking.",
        },
      },
      ["number"]
    ),
  },
  // 1.20.14: ticking and adding checklists on a ticket, as the agent would in the desk.
  {
    name: "hd_update_checklist",
    side: "agent",
    write: "update",
    description:
      "Helpdesk desk: tick or untick items on a ticket's checklists, or add a checklist from the library, exactly as the agent could in the desk (anyone who works the ticket; not on a closed or merged ticket). Item ids and checklist_templates come from hd_read_ticket. Several items in one call: all must be on the ticket or nothing changes. Tick an item only when the person confirms the step is really done: required items gate solving, and this never solves the ticket (use hd_update_ticket). The timeline shows each tick \"via Claude\".",
    inputSchema: obj(
      {
        number: NUMBER,
        items: {
          type: "array",
          description: "Items to change: [{ id, done }] with done true to tick and false to untick. Up to 50.",
          items: obj({ id: { type: "number", description: "The item's id (hd_read_ticket → checklists[].items[].id)." }, done: { type: "boolean" } }, ["id", "done"]),
        },
        add_template_id: { type: "number", description: "A library checklist to add (hd_read_ticket → checklist_templates[].id). Added before any ticking." },
      },
      ["number"]
    ),
  },
  // 1.20.15: macros, as the agent applies them in the desk (lib/helpdesk/macros applyMacroAs).
  {
    name: "hd_list_macros",
    side: "macro_use",
    description:
      "Helpdesk desk: the macros the person can apply (their own personal ones, their teams' and everyone's), each with its id, name, scope and what it does: its reply (a preview) and its changes to status, priority, team and tags, and whether it solves. With a ticket number they work, only the macros usable on that ticket, with the reply filled for it. Apply one with hd_apply_macro.",
    inputSchema: obj({
      number: { type: "number", description: "A ticket number (#1047 → 1047): only the macros usable there, reply filled for it." },
      query: { type: "string", description: "Words in the macro's name or reply." },
      limit: { type: "number", description: "1 to 50 (default 20)." },
    }),
  },
  {
    name: "hd_apply_macro",
    side: "macro_use",
    write: "update",
    description:
      "Helpdesk desk: apply a macro to a ticket as the person, with the desk's own checks (Use macros in the ticket's team, the macro is theirs to use, each change within their desk role, required checklist items and \"Before you solve\" when it solves, not on a closed or merged ticket). The macro's field changes are made at once and show \"via Claude\" on the timeline. Its reply is NOT sent: it is saved as a reply draft (\"Draft from Claude\") for an agent to send from the desk, and a status change the macro makes (for example Solved) is not made: nothing sets it later, so the agent sets it after sending the reply; the result says so. Confirm with the person before applying.",
    inputSchema: obj(
      {
        number: NUMBER,
        macro_id: { type: "number", description: "The macro's id (hd_list_macros)." },
      },
      ["number", "macro_id"]
    ),
  },
  {
    name: "hd_ticket_summary",
    side: "agent",
    description:
      "Helpdesk desk: the material to summarize a ticket (the conversation in order, internal notes marked, answers and where its workflow is) plus similar past tickets from the person's queues. You write the summary; nothing is saved.",
    inputSchema: obj({ number: NUMBER }, ["number"]),
  },
  {
    name: "hd_report",
    side: "reports",
    description:
      "Helpdesk desk: headline numbers for a period (created, solved, median first reply and resolution in business time, targets met, satisfaction) with splits by team, agent and category. The whole helpdesk needs All reports; team=<id> needs Team reports for that team; mine=true gives the person's own stats.",
    inputSchema: obj({
      from: { type: "string", description: "YYYY-MM-DD (default 30 days before to)." },
      to: { type: "string", description: "YYYY-MM-DD (default today)." },
      team: { type: "number", description: "One team's numbers." },
      mine: { type: "boolean", description: "Only tickets assigned to the person." },
    }),
  },
  // Admin side (capabilities apply). Drafts only: publishing stays in the app.
  {
    name: "hd_list_workflows",
    side: "workflows",
    description:
      "Helpdesk admin: the workspace's workflows (published or not, open runs, linked request types). Pass id for one workflow's working steps (the draft when there is one), the shape hd_draft_workflow takes.",
    inputSchema: obj({ id: { type: "number", description: "One workflow's id, for its steps." } }),
  },
  {
    name: "hd_draft_workflow",
    side: "workflows",
    write: "notes",
    description:
      "Helpdesk admin: create a workflow or save new steps as the DRAFT of an existing one. Nothing is published: running and new requests keep the published version until a person publishes the draft in the desk's workflow builder (edit_url). Steps: {key, kind, title, ...} with kind approval {approver:{kind:\"team\",team_id}|{kind:\"manager\"}|{kind:\"user\",user_id}|{kind:\"space_owner\"}, on_decline:\"close\"|\"continue\"}, task {team_id, due?:{after_hours}|{field, offset_days?}, description?}, parallel {steps:[task…]}, wait {until:{after_hours}|{field}}, notify {to:\"requester\"|{user_id}|{team_id}, message}, finish {csat?}. Read an existing one with hd_list_workflows first.",
    inputSchema: obj(
      {
        id: { type: "number", description: "An existing workflow to save a draft on. Omit to create a new (unpublished) workflow." },
        title: { type: "string", description: "New workflows: the name." },
        description: { type: "string", description: "New workflows: what it is for." },
        definition: { type: "object", description: "{ trigger: {}, steps: [...] }" },
      },
      ["definition"]
    ),
  },
  {
    name: "hd_draft_request_type",
    side: "request_types",
    write: "notes",
    description:
      "Helpdesk admin: draft a new request type and its form. It is saved switched off, so nobody sees it in Get help until a person reviews it and switches it on in Desk settings → Request types. Form fields: {key, label, type: choice|select|text|textarea|date|number|user|checkbox, required?, options?:[{value,label}], help?}.",
    inputSchema: obj(
      {
        title: { type: "string" },
        description: { type: "string" },
        icon: { type: "string", description: "A lucide icon name, like monitor or key." },
        team_id: { type: ["number", "null"], description: "The team that answers it." },
        category: { type: "string", description: "A category from the desk admin's list, by name. One that is not on the list is refused." },
        subcategory: { type: "string", description: "A sub-category of that category, by name." },
        form: { type: "array", items: { type: "object" } },
        workflow_id: { type: ["number", "null"], description: "A workflow to run (hd_list_workflows)." },
        sla_priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        eta_label: { type: "string", description: "\"Usually 2 to 3 days\"." },
      },
      ["title"]
    ),
  },
  // 1.20.14: checklist templates (Desk settings → Checklists): read, and drafts a person publishes.
  {
    name: "hd_list_checklists",
    side: "checklists",
    description:
      "Helpdesk admin: the checklist library (published ones and drafts waiting for review), with the teams and request types a checklist can name. Pass id for one checklist's items and request types in the shape hd_draft_checklist takes, and any draft waiting on it.",
    inputSchema: obj({ id: { type: "number", description: "One checklist's id." } }),
  },
  {
    name: "hd_draft_checklist",
    side: "checklists",
    write: "notes",
    description:
      "Helpdesk admin: draft a checklist template (a reusable list of steps agents tick on tickets), or propose changes to an existing one with id. Nothing goes live: a new one is saved unpublished (in no picker, added to nothing) and changes wait beside the live checklist, until a person reviews, edits and publishes them in Desk settings → Checklists (edit_url). Tell the person that. Items: {title, required?, team_id?, due_days?}; required items must be ticked before a ticket can be solved; due_days is 0 to 60 business days after the checklist is added. request_type_ids: request types that add it to every new request once published. Read hd_list_checklists first for ids.",
    inputSchema: obj({
      id: { type: "number", description: "An existing checklist to propose changes to. Omit to draft a new one." },
      name: { type: "string", description: "Up to 120 characters. Needed for a new one." },
      items: {
        type: "array",
        description: "The whole list, in order: 1 to 50 items. With id, omit to keep the current items.",
        items: obj(
          {
            title: { type: "string", description: "What needs doing, up to 300 characters." },
            required: { type: "boolean", description: "Must be ticked before the ticket can be solved." },
            team_id: { type: ["number", "null"], description: "The team that owns the step (hd_list_checklists lists teams)." },
            due_days: { type: ["number", "null"], description: "Due this many business days after the checklist is added (0 to 60)." },
          },
          ["title"]
        ),
      },
      request_type_ids: { type: "array", items: { type: "number" }, description: "Request types that add it to every new request once it is published (hd_list_checklists lists them). Up to 50." },
    }),
  },
  // 1.20.16: categories, automations and recurring tickets: read, and drafts a person publishes in Desk settings.
  {
    name: "hd_list_categories",
    side: "agent",
    description:
      "Helpdesk: the categories and sub-categories agents pick on a ticket (Desk settings → Categories), with ids; archived ones are marked and can't be set. For people who manage the list, also the changes Claude proposed that wait for review (draft). Use the names with hd_update_ticket; use the ids with hd_draft_categories.",
    inputSchema: obj({}),
  },
  {
    name: "hd_draft_categories",
    side: "categories",
    write: "notes",
    description:
      "Helpdesk admin: propose changes to the category list: add a category (with sub-categories), add a sub-category, rename a category or sub-category. Nothing changes now: the changes wait beside the list (added to any draft already waiting) until a person reviews and publishes them in Desk settings → Categories (edit_url). Tell the person that. A rename, once published, renames it on every ticket that has it. Claude can't delete, archive or merge categories. changes: [{kind:\"add_category\", name, subcategories?:[names]}, {kind:\"add_subcategory\", category (a name on the list) or category_id, name}, {kind:\"rename\", id (hd_list_categories), to}]. Up to 50.",
    inputSchema: obj(
      {
        changes: {
          type: "array",
          description: "The changes, in order. Up to 50.",
          items: obj(
            {
              kind: { type: "string", enum: ["add_category", "add_subcategory", "rename"] },
              name: { type: "string", description: "add_category / add_subcategory: the new name (up to 80 characters)." },
              subcategories: { type: "array", items: { type: "string" }, description: "add_category: its sub-categories." },
              category: { type: "string", description: "add_subcategory: the category it goes under, by name." },
              category_id: { type: "number", description: "add_subcategory: the category it goes under, by id." },
              id: { type: "number", description: "rename: the category or sub-category's id." },
              to: { type: "string", description: "rename: the new name." },
            },
            ["kind"]
          ),
        },
      },
      ["changes"]
    ),
  },
  {
    name: "hd_list_automations",
    side: "automations",
    description:
      "Helpdesk admin: the automations (When / If / Then rules, Desk settings → Automations) in run order, each in plain words with whether it is on, off, a draft from Claude, or has changes waiting: every condition and action, the subject and body phrases and patterns, who a rule makes the requester (from the message: with the senders it is limited to) and the values it copies into fields included. Pass id for one rule in the shape hd_draft_automation takes, and any draft waiting on it.",
    inputSchema: obj({ id: { type: "number", description: "One rule's id." } }),
  },
  {
    name: "hd_draft_automation",
    side: "automations",
    write: "notes",
    description:
      "Helpdesk admin: draft an automation rule, or propose changes to an existing one with id. Nothing runs: a new rule is saved switched OFF and marked Draft from Claude; changes wait beside the rule, which keeps running unchanged, until a person reviews and publishes them in Desk settings → Automations (edit_url). Tell the person that; only a person can switch a rule on. event: ticket_created | ticket_updated | requester_message | sla_nearing | sla_breached. The body a rule reads is the triggering requester message for requester_message, otherwise the opening message, as agents see it. " +
      "conditions (all optional, every one must match): {team_ids, categories (names from hd_list_categories), subcategories:[{category, subcategory}], priorities, request_type_ids, sources, keywords (whole words in subject or body), " +
      "subject_contains / subject_not_contains / body_contains / body_not_contains (lists of phrases: exact text, any case, not whole words; contains = any phrase appears, not_contains = none does), " +
      "subject_pattern / body_pattern ({pattern, match_case}: a regular expression on a linear-time RE2 engine, up to 200 characters, matched on the first 100 KB, any case unless match_case; no lookarounds or backreferences)}. " +
      "actions (at least one): {team_id, assignee_id, priority, status, category, subcategory, tags_add, internal_note, macro_id (a shared macro), notify: \"assignee\"|\"team\"|{user_id}, " +
      "requester_set: {user_id} or {email, name?}, keep_cc? (make that person the requester; keep_cc keeps the previous requester as a CC), " +
      "requester_from_message: {find: \"label\"|\"first\", labels (default [\"From:\", \"Email:\"]), senders (REQUIRED), domains?, keep_cc?, allow_agents?} (make the address found in the body the requester; creates them as an outside contact if nobody has it), " +
      "copy_values: up to 10 of {from: \"body\"|\"subject\", label (the rest of the line after it) or pattern (exactly one capture group), match_case?, field_key (a custom field of the rule's teams) or tag: true, only_if_empty? (default true)}}. " +
      "The requester can change only on ticket_created or requester_message (other events are refused), and a rule never changes the requester of a ticket an agent set it on by hand. " +
      "requester_from_message REQUIRES senders (exact addresses, or @domain except free-mail domains such as @gmail.com): the forwarder, alert system or web-form mailbox addresses (or @domain) whose messages it may act on; it does nothing for anyone else's message or an email whose sender didn't pass an aligned SPF/DKIM/DMARC check, reads only the topmost line that starts with a label (and only the bracketed address in \"Name <address>\"), never picks the desk's own addresses, the sender's own or a desk agent (unless allow_agents), and the draft is refused without senders, since otherwise anyone could write \"From: ceo@…\" and take over a ticket and its replies. " +
      "Examples: {conditions:{body_contains:[\"Submitted via web form\"]}, actions:{requester_from_message:{find:\"label\", labels:[\"Email:\"], senders:[\"forms@acme.example\"]}, copy_values:[{from:\"body\", label:\"Asset tag:\", field_key:\"asset_tag\"}]}}; " +
      "{conditions:{subject_pattern:{pattern:\"^\\\\[ALERT\\\\]\"}}, actions:{copy_values:[{from:\"subject\", pattern:\"host=(\\\\S+)\", tag:true}]}}. With id, fields not sent are kept.",
    inputSchema: obj({
      id: { type: "number", description: "An existing rule to propose changes to. Omit to draft a new one." },
      name: { type: "string", description: "Up to 120 characters. Needed for a new rule." },
      event: { type: "string", enum: ["ticket_created", "ticket_updated", "requester_message", "sla_nearing", "sla_breached"] },
      conditions: obj({
        team_ids: { type: "array", items: { type: "number" } },
        categories: { type: "array", items: { type: "string" }, description: "Category names from hd_list_categories." },
        subcategories: { type: "array", items: obj({ category: { type: "string" }, subcategory: { type: "string" } }, ["category", "subcategory"]) },
        priorities: { type: "array", items: { type: "string", enum: ["low", "normal", "high", "urgent"] } },
        request_type_ids: { type: "array", items: { type: "number" } },
        sources: { type: "array", items: { type: "string" } },
        keywords: { type: "array", items: { type: "string" }, description: "Whole words in the subject or body." },
        subject_contains: { type: "array", items: { type: "string" }, description: "Any of these phrases in the subject (exact text, any case)." },
        subject_not_contains: { type: "array", items: { type: "string" }, description: "None of these phrases in the subject." },
        body_contains: { type: "array", items: { type: "string" }, description: "Any of these phrases in the body (exact text, any case)." },
        body_not_contains: { type: "array", items: { type: "string" }, description: "None of these phrases in the body." },
        subject_pattern: obj({ pattern: { type: "string", description: "A regular expression (RE2), up to 200 characters." }, match_case: { type: "boolean" } }, ["pattern"]),
        body_pattern: obj({ pattern: { type: "string", description: "A regular expression (RE2), up to 200 characters, on the first 100 KB of the body." }, match_case: { type: "boolean" } }, ["pattern"]),
      }),
      actions: obj({
        team_id: { type: "number" },
        assignee_id: { type: "number" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        status: { type: "string", enum: ["open", "pending", "on_hold", "solved", "closed"] },
        category: { type: "string" },
        subcategory: { type: "string" },
        tags_add: { type: "array", items: { type: "string" } },
        internal_note: { type: "string" },
        macro_id: { type: "number", description: "A shared macro's id." },
        notify: { description: '"assignee", "team" or {user_id}.' },
        requester_set: obj(
          {
            user_id: { type: "number", description: "An account that can use Get help." },
            email: { type: "string", description: "Or an address (an account's, else someone outside the workspace)." },
            name: { type: "string", description: "The name to show for an outside address." },
            keep_cc: { type: "boolean", description: "Keep the previous requester as a CC (default false)." },
          }
        ),
        requester_from_message: obj(
          {
            find: { type: "string", enum: ["label", "first"], description: "label: the address on the same line after a label; first: the first usable address in the body." },
            labels: { type: "array", items: { type: "string" }, description: 'find "label": the labels tried in order. Default ["From:", "Email:"].' },
            senders: {
              type: "array",
              items: { type: "string" },
              description: "REQUIRED, at least one: the addresses or @domains of the forwarder, alert system or web-form mailbox. The action does nothing for a message from anyone else.",
            },
            domains: { type: "array", items: { type: "string" }, description: "Optional: only accept addresses at these domains (@example.com)." },
            keep_cc: { type: "boolean", description: "Keep the original sender as a CC (default false)." },
            allow_agents: { type: "boolean", description: "Allow an address that belongs to a desk agent (default false)." },
          },
          ["senders"]
        ),
        copy_values: {
          type: "array",
          description: "Up to 10. Each copies one value into a custom field (hd_read_ticket lists their keys) or adds it as a tag.",
          items: obj(
            {
              from: { type: "string", enum: ["body", "subject"] },
              label: { type: "string", description: 'Text after a label: the rest of that line, trimmed (e.g. "Asset tag:").' },
              pattern: { type: "string", description: "Or a regular expression with exactly one capture group." },
              match_case: { type: "boolean" },
              field_key: { type: "string", description: "The custom field to write (its kind must fit: an option, a number, a date)." },
              tag: { type: "boolean", description: "Add the value as a tag instead." },
              only_if_empty: { type: "boolean", description: "Only while the field is empty (default true)." },
            },
            ["from"]
          ),
        },
      }),
    }),
  },
  {
    name: "hd_list_recurring",
    side: "recurring",
    description:
      "Helpdesk admin: the recurring tickets (schedules that open a ticket by themselves, Desk settings → Recurring tickets) of the teams the person manages, each in plain words with its next run and whether it is on, paused, a draft from Claude or has changes waiting; also the teams they may schedule for and the request types. Pass id for one schedule in the shape hd_draft_recurring takes, and any draft waiting on it.",
    inputSchema: obj({ id: { type: "number", description: "One schedule's id." } }),
  },
  {
    name: "hd_draft_recurring",
    side: "recurring",
    write: "notes",
    description:
      "Helpdesk admin: draft a recurring ticket schedule, or propose changes to an existing one with id. Nothing opens: a new schedule is saved PAUSED and marked Draft from Claude; changes wait beside the schedule, which keeps running unchanged, until a person reviews and publishes them in Desk settings → Recurring tickets (edit_url). Tell the person that; only a person can switch a schedule on. Fields: team_id (a team they manage), subject and body ({{month}} {{date}} {{week}} {{team}} placeholders), priority, request_type_id, assign_mode (team_rules | user) with assignee_id, due_business_days (1 to 60), pattern ({kind:\"daily\",time:\"09:00\"} | {kind:\"weekly\",days:[1..7],time} | {kind:\"monthly\",mode:\"nth_weekday\",nth:1..4|-1,weekday:1..7,months:[],time} | {kind:\"monthly\",mode:\"day\",day:1..31,months:[],time} | {kind:\"interval\",unit:\"days\"|\"weeks\",every,start:\"YYYY-MM-DD\",time}), holiday_rule (next_working_day | skip | same_day), timezone (empty = the team calendar's). With id, fields not sent are kept.",
    inputSchema: obj({
      id: { type: "number", description: "An existing schedule to propose changes to. Omit to draft a new one." },
      team_id: { type: "number" },
      subject: { type: "string" },
      body: { type: "string" },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      request_type_id: { type: ["number", "null"] },
      assign_mode: { type: "string", enum: ["team_rules", "user"] },
      assignee_id: { type: ["number", "null"] },
      due_business_days: { type: ["number", "null"] },
      pattern: { type: "object" },
      holiday_rule: { type: "string", enum: ["next_working_day", "skip", "same_day"] },
      timezone: { type: "string" },
    }),
  },
  {
    name: "hd_draft_macro",
    side: "macros",
    write: "notes",
    description:
      "Helpdesk admin: draft a macro (a canned reply, optionally with field changes). It is saved as the person's personal macro, which only they see; sharing it with a team or everyone is done in Desk settings → Macros. Placeholders: {{requester.first_name}}, {{requester.name}}, {{ticket.number}}, {{ticket.subject}}, {{agent.name}}.",
    inputSchema: obj(
      {
        title: { type: "string" },
        body: { type: "string", description: "The reply text (markdown)." },
        actions: { type: "object", description: "Optional field changes: {status?, priority?, team_id?, tags_add?: []}." },
      },
      ["title"]
    ),
  },
];

const DEFS = new Map(HELPDESK_TOOL_DEFS.map((d) => [d.name, d]));

/** Is this one of the helpdesk tools? */
export function isHelpdeskTool(name: string): boolean {
  return DEFS.has(name);
}

const REPORT_CAPS = ["reports.own", "reports.team", "reports.all"] as const;

/** Does the person hold the side a tool is for? */
async function onSide(user: User, side: Side): Promise<boolean> {
  switch (side) {
    case "request":
      return hdHolds(user, "helpdesk.request");
    case "agent":
      return isAgent(user);
    case "reports":
      for (const c of REPORT_CAPS) if (await hdCan(user, c)) return true;
      return false;
    // 1.20.23: "Manage a desk department" opens each department-held side too (its own departments only;
    // lib/helpdesk/desk-departments, checked again by each tool).
    case "workflows":
      return (await hdCan(user, "workflows.manage")) || hdCan(user, "departments.manage");
    case "request_types":
      return (await hdCan(user, "request_types.manage")) || hdCan(user, "departments.manage");
    case "macros":
      return hdCan(user, "macros.manage_personal");
    case "checklists": {
      // Desk settings → Checklists' own rule (lib/helpdesk/checklists-caps).
      const { CHECKLIST_MANAGE_CAPS } = await import("../helpdesk/checklists-caps");
      for (const c of [...CHECKLIST_MANAGE_CAPS, "departments.manage" as const]) if (await hdCan(user, c)) return true;
      return false;
    }
    case "macro_use":
      // 1.20.15: an agent who holds Use macros somewhere (the desk's macro route's gate).
      return (await isAgent(user)) && hdCan(user, "macros.use");
    // 1.20.16: Desk settings' own rule for each page.
    case "categories":
      return hdCan(user, "settings.manage");
    case "automations":
      return (await hdCan(user, "automations.manage")) || hdCan(user, "departments.manage");
    case "recurring":
      return (await hdCan(user, "settings.manage")) || (await hdCan(user, "agents.manage_team")) || hdCan(user, "departments.manage");
  }
}

const allows = (level: HdClaudeLevel, need: HdToolDef["write"]) => !need || HD_CLAUDE_LEVEL_RANK[level] >= HD_CLAUDE_LEVEL_RANK[need];

/**
 * The helpdesk tools this person sees in tools/list: none unless the
 * helpdesk is licensed, then those of the sides they hold, writes only up
 * to the workspace level. Each call checks again whatever the listing said.
 */
export async function helpdeskToolsFor(user: User): Promise<{ name: string; description: string; inputSchema: Record<string, unknown> }[]> {
  try {
    if (!(await helpdeskLicensed())) return [];
    const level = await getClaudeLevel();
    const sides = new Map<Side, boolean>();
    const out = [];
    for (const d of HELPDESK_TOOL_DEFS) {
      if (!allows(level, d.write)) continue;
      if (!sides.has(d.side)) sides.set(d.side, await onSide(user, d.side));
      if (sides.get(d.side)) out.push({ name: d.name, description: d.description, inputSchema: d.inputSchema });
    }
    return out;
  } catch (e) {
    console.error("[mcp] helpdesk tool listing:", e);
    return [];
  }
}

// --- Shared pieces ------------------------------------------------------------------

const NOT_FOUND = (n: unknown) => `No ticket #${n} that you can see.`;
const tooMany = () => refuse("Too many requests. Wait a moment and try again (429).");

function levelRefusal(level: HdClaudeLevel, need: Exclude<HdClaudeLevel, "read">): string {
  const what = need === "update" ? "change tickets" : "save anything in the helpdesk";
  return `This workspace's Claude connector is set to "${HD_CLAUDE_LEVEL_LABEL[level]}", so Claude can't ${what} (Desk settings → Claude connector). Nothing was saved.`;
}

/** The ticket behind a number, when the person reaches it as needed; else undefined (the same answer either way). */
async function ticketFor(user: User, raw: unknown, need: "work" | "see"): Promise<{ t: HdTicket; relation: TicketRelation } | undefined> {
  const n = parseTicketNumber(typeof raw === "number" || typeof raw === "string" ? raw : "");
  if (!n) return undefined;
  const t = await getTicketByNumber(n);
  if (!t) return undefined;
  if (need === "work") return (await canWorkTicket(user, t)) ? { t, relation: "agent" } : undefined;
  const relation = await ticketRelation(user, t);
  return relation ? { t, relation } : undefined;
}

function author(user: User) {
  return { id: user.id, name: user.name || user.username, email: user.email };
}

/** An audit row as the app writes it, plus via "mcp" and the caller's address. */
async function auditMcp(user: User, ctx: Ctx, action: string, target: { type: string; id: number | null; label: string }, details: Record<string, unknown>) {
  await audit({
    actor: actorFrom({ id: user.id, name: user.name, username: user.username, role: user.role }),
    action,
    targetType: target.type,
    targetId: target.id,
    targetLabel: target.label.slice(0, 200),
    details: { ...details, via: "mcp" },
    ip: ctx.ip,
  });
}

const ticketLabel = (t: { number: number; subject: string }) => `#${t.number} ${t.subject}`;

function fieldsOut(form: HdFormField[]) {
  return form.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required === true,
    ...(f.options?.length ? { options: f.options.map((o) => ({ value: o.value, label: o.label })) } : {}),
    ...(f.help ? { help: f.help } : {}),
  }));
}

/** A message as a tool shows it. Agents see the review state of a newbie's reply. */
function messageOut(m: HdMessage, agent: boolean) {
  const review = (m as HdMessage & { review_state?: string | null }).review_state;
  return {
    at: m.created_at,
    author: m.author_name || m.author_email || "",
    kind: m.kind,
    ...(m.via === "mcp" ? { via: "Claude" } : m.via === "email" ? { via: "email" } : {}),
    ...(agent && review ? { review_state: review } : {}),
    body: m.body,
    ...(m.attachments?.length ? { attachments: m.attachments.map((a) => a.name) } : {}),
  };
}

// --- Dispatch ----------------------------------------------------------------------

/**
 * Run one helpdesk tool as `user`. Licence (402), the tool's side, then
 * the workspace level for writes; then the tool's own checks, the app's.
 */
export async function callHelpdeskTool(user: User, name: string, args: Args, ctx: Ctx) {
  const def = DEFS.get(name);
  if (!def) return refuse(`Unknown tool: ${name}`);
  if (!(await helpdeskLicensed())) return refuse(`${HD_LICENCE_ERROR} (402)`);
  if (!(await onSide(user, def.side))) return refuse(`${HD_FORBIDDEN} (403)`);
  if (def.write) {
    const level = await getClaudeLevel();
    if (!allows(level, def.write)) return refuse(levelRefusal(level, def.write));
  }
  const a: Args = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  try {
    switch (name) {
      case "hd_request_types":
        return await requestTypes(user, a);
      case "hd_suggest_articles":
        return await suggest(user, a, ctx);
      case "hd_create_request":
        return await createRequest(user, a, ctx);
      case "hd_my_requests":
        return await myRequests(user, a, ctx);
      case "hd_read_request":
        return await readRequest(user, a, ctx);
      case "hd_reply_to_request":
        return await replyToRequest(user, a, ctx);
      case "hd_my_approvals":
        return await myApprovals(user, ctx);
      case "hd_queue":
        return await queue(user, a, ctx);
      case "hd_read_ticket":
        return await readTicket(user, a, ctx);
      case "hd_add_internal_note":
        return await internalNote(user, a, ctx);
      case "hd_draft_reply":
        return await draftReply(user, a, ctx);
      case "hd_update_ticket":
        return await updateTicketTool(user, a, ctx);
      case "hd_canned_responses": {
        const r = await cannedResponsesTool(user, a);
        return r.ok ? toolJson(r.value) : refuse(r.error);
      }
      case "hd_asset_lookup": {
        const r = await assetLookupTool(user, a);
        return r.ok ? toolJson(r.value) : refuse(r.error);
      }
      case "hd_ticket_summary":
        return await ticketSummary(user, a, ctx);
      case "hd_report":
        return await report(user, a);
      case "hd_list_workflows":
        return await listWorkflowsTool(user, a, ctx);
      case "hd_draft_workflow":
        return await draftWorkflow(user, a, ctx);
      case "hd_draft_request_type":
        return await draftRequestType(user, a, ctx);
      case "hd_draft_macro":
        return await draftMacro(user, a, ctx);
      case "hd_update_checklist":
        return await updateChecklistTool(user, a, ctx);
      case "hd_list_checklists":
        return await listChecklistsTool(user, a, ctx);
      case "hd_draft_checklist":
        return await draftChecklist(user, a, ctx);
      case "hd_list_macros":
        return await listMacrosTool(user, a, ctx);
      case "hd_apply_macro":
        return await applyMacroTool(user, a, ctx);
      case "hd_list_categories":
        return await listCategoriesTool(user, ctx);
      case "hd_draft_categories":
        return await draftCategoriesTool(user, a, ctx);
      case "hd_list_automations":
        return await listAutomationsTool(user, a, ctx);
      case "hd_draft_automation":
        return await draftAutomationTool(user, a, ctx);
      case "hd_list_recurring":
        return await listRecurringTool(user, a, ctx);
      case "hd_draft_recurring":
        return await draftRecurringTool(user, a, ctx);
    }
  } catch (e) {
    if (e instanceof HdTicketError) return refuse(e.message);
    // 1.20.23 review L3: a draft racing a desk department's deletion.
    const dd = await import("../helpdesk/desk-departments");
    if (dd.isDeskDepartmentGone(e)) return refuse(`${dd.DESK_DEPARTMENT_GONE} Nothing was saved.`);
    throw e;
  }
  return refuse(`Unknown tool: ${name}`);
}

// --- Requester side -------------------------------------------------------------------

async function requestTypes(user: User, a: Args) {
  const { getRequestTypeBySlug, listRequestTypesForUser, mayUseRequestType } = await import("../helpdesk/request-types");
  const { directoryDefaults, nextStepsFor } = await import("../helpdesk/detail");
  const describe = async (rt: import("../helpdesk/types").HdRequestType) => {
    const steps = await nextStepsFor(rt).catch(() => []);
    return {
      id: rt.id,
      slug: rt.slug,
      title: rt.title,
      description: rt.description,
      team: rt.team_name ?? null,
      eta: rt.eta_label || null,
      form: fieldsOut(rt.form),
      approvals: steps.filter((s) => s.kind === "approval").map((s) => (s.detail ? `${s.title} (${s.detail})` : s.title)),
      what_happens_next: steps.map((s) => (s.detail ? `${s.title}: ${s.detail}` : s.title)),
    };
  };
  if (a.slug !== undefined && a.slug !== null && a.slug !== "") {
    const rt = await getRequestTypeBySlug(String(a.slug).slice(0, 80));
    if (!rt || !(await mayUseRequestType(user, rt.id))) return refuse(`No request type "${a.slug}" that you can use.`);
    return toolJson({ ...(await describe(rt)), prefilled_answers: await directoryDefaults(user.id, rt.form) });
  }
  const types = await listRequestTypesForUser(user);
  const out = [];
  for (const rt of types) out.push(await describe(rt));
  return toolJson({ request_types: out, note: "Without a request type, hd_create_request takes a subject and a description." });
}

async function suggest(user: User, a: Args, ctx: Ctx) {
  if (hdRateLimited(`hd-suggest:${user.id}`, 60, 60_000)) return tooMany();
  const q = String(a.query ?? "").slice(0, 200);
  const limit = Math.min(8, Math.max(1, Number(a.limit) || 5));
  const { suggestArticles } = await import("../helpdesk/suggest");
  const hits = await suggestArticles(user, q, limit);
  return toolJson({ articles: hits.map((h) => ({ doc_id: h.doc_id, title: h.title, space: h.space_name, read_minutes: h.read_minutes, url: `${ctx.origin}${h.url}` })) });
}

async function createRequest(user: User, a: Args, ctx: Ctx) {
  if (requestCreateLimited(user.id)) return tooMany();
  let subject = textField(a.subject, TICKET_LIMITS.subject);
  if (subject === null) return refuse(`Keep the subject under ${TICKET_LIMITS.subject} characters.`);
  const body = textField(a.body, TICKET_LIMITS.body);
  if (body === null) return refuse("The description is too long.");
  const { getRequestType, getRequestTypeBySlug, mayUseRequestType, validateAnswers } = await import("../helpdesk/request-types");
  let requestTypeId: number | null = null;
  let answers: import("../helpdesk/types").HdFormAnswers = {};
  if (a.request_type !== undefined && a.request_type !== null && a.request_type !== "") {
    const rt =
      typeof a.request_type === "number" || /^\d+$/.test(String(a.request_type))
        ? await getRequestType(Number(a.request_type))
        : await getRequestTypeBySlug(String(a.request_type).slice(0, 80));
    if (!rt || !(await mayUseRequestType(user, rt.id))) return refuse("That request type is not available.");
    const checked = await validateAnswers(rt.form, a.answers ?? {});
    if (!checked.ok) return refuse(checked.error);
    requestTypeId = rt.id;
    answers = checked.value;
    if (!subject) subject = rt.title;
  }
  if (!subject) return refuse("Say in a few words what you need (subject).");
  if (!requestTypeId && !body) return refuse("Describe what you need (body).");
  const ticket = await createTicket(
    {
      subject,
      body: body ?? "",
      requester: author(user),
      via: "mcp",
      source: "portal",
      source_ref: {},
      request_type_id: requestTypeId,
      answers,
    },
    { actorId: user.id, actorName: user.name, origin: ctx.origin }
  );
  await auditMcp(user, ctx, "helpdesk.request.created", { type: "helpdesk_ticket", id: ticket.id, label: ticketLabel(ticket) }, {
    number: ticket.number,
    request_type_id: requestTypeId,
  });
  const { requesterSafe } = await import("../helpdesk/access");
  const s = requesterSafe(ticket, []).summary;
  return toolJson({ number: s.number, subject: s.subject, status: s.status_label, team: s.team_name, url: `${ctx.origin}/help/requests/${s.number}` });
}

async function myRequests(user: User, a: Args, ctx: Ctx) {
  const status = a.status === "open" || a.status === "solved" ? a.status : undefined;
  // Requests the person is copied on too, as Get help's My requests lists them (1.19.1 CCs).
  const rows = await listMyRequests(user.id, { status, limit: 50, includeCopied: true });
  return toolJson({
    requests: rows.map((r) => ({
      number: r.number,
      subject: r.subject,
      status: r.status_label,
      type: r.request_type_title,
      team: r.team_name,
      current_step: r.current_step ?? null,
      last_reply: r.last_public_at ? { by: r.last_public_author, at: r.last_public_at } : null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      url: `${ctx.origin}/help/requests/${r.number}`,
    })),
  });
}

async function readRequest(user: User, a: Args, ctx: Ctx) {
  const found = await ticketFor(user, a.number, "see");
  if (!found) return refuse(NOT_FOUND(a.number));
  const { requestDetail } = await import("../helpdesk/detail");
  // Requester-safe whatever the relation: public and system messages only (lib/helpdesk/access requesterSafe).
  const r = await requestDetail(user, found.t, found.relation);
  return toolJson({
    number: r.number,
    subject: r.subject,
    status: r.status_label,
    type: r.request_type_title,
    team: r.team_name,
    requester: r.requester_name,
    created_at: r.created_at,
    solved_at: r.solved_at,
    current_step: r.current_step,
    progress: r.workflow?.steps ?? null,
    answers: r.answers,
    // 1.20.6: the Public custom fields that have a value (requestDetail reads no agent-only field).
    ...(r.details?.length ? { details: r.details.map((d) => ({ label: d.label, value: d.value })) } : {}),
    conversation: r.messages.map((m) => messageOut(m, false)),
    can_reply: r.can_reply,
    ...(r.my_approval ? { waiting_for_your_decision: { step: r.my_approval.title, approve_url: `${ctx.origin}/help/approvals` } } : {}),
    url: `${ctx.origin}/help/requests/${r.number}`,
  });
}

async function replyToRequest(user: User, a: Args, ctx: Ctx) {
  if (messagePostLimited(user.id)) return tooMany();
  const found = await ticketFor(user, a.number, "see");
  // Only the requester, or (1.19.1) someone copied on the request, posts here: the route's rule.
  const copied = async (ticketId: number) => (await import("../helpdesk/ccs")).isCcOf(user.id, ticketId);
  if (!found || (found.t.requester_id !== user.id && !(await copied(found.t.id)))) return refuse(`No request #${a.number} of yours.`);
  const t = found.t;
  // Someone who works the ticket replies from the desk (newbie review applies there), even when copied on it.
  if (t.requester_id !== user.id && found.relation === "agent") {
    return refuse(`You work #${t.number}, so reply from the desk: ${ctx.origin}/desk/tickets/${t.number} (409).`);
  }
  if (t.status === "closed") return refuse("This request is closed. Raise a new one with hd_create_request (409).");
  const body = textField(a.body, MESSAGE_LIMITS.body);
  if (body === null) return refuse("The reply is too long.");
  if (!body) return refuse("Write a reply (body).");
  const res = await addMessage(t.id, { kind: "public", body, author: author(user), via: "mcp", asRequester: true }, { origin: ctx.origin });
  if (!res) return refuse(NOT_FOUND(a.number));
  await auditMcp(user, ctx, "helpdesk.request.replied", { type: "helpdesk_ticket", id: t.id, label: ticketLabel(t) }, {
    number: t.number,
    message_id: res.message.id,
  });
  return toolJson({ number: t.number, posted: true, reopened: res.reopened, status: res.status, url: `${ctx.origin}/help/requests/${t.number}` });
}

async function myApprovals(user: User, ctx: Ctx) {
  const { listMyApprovals } = await import("../helpdesk/approvals");
  const rows = await listMyApprovals(user, "pending");
  return toolJson({
    note: "No tool approves or declines. The person decides in the app: give them approve_url.",
    approvals: rows.map((x) => ({
      id: x.id,
      step: x.step_title,
      why_you: x.reason,
      number: x.ticket_number,
      subject: x.subject,
      type: x.request_type_title,
      requester: x.requester_name,
      waiting_since: x.created_at,
      answers: x.answers,
      opening_message: x.body,
      can_decide: x.can_decide,
      approve_url: `${ctx.origin}/help/approvals`,
      request_url: `${ctx.origin}/help/requests/${x.ticket_number}`,
    })),
  });
}

// --- Agent side ----------------------------------------------------------------------

async function queue(user: User, a: Args, ctx: Ctx) {
  const f: TicketListFilters = {};
  if (a.view !== undefined && a.view !== null && a.view !== "") {
    const view = parseView(String(a.view));
    if (!view) return refuse("Unknown view. Use mine, unassigned, open, overdue, workflow, waiting, solved_week, parked, all or team:<id>.");
    f.view = view;
  }
  if (a.team !== undefined && a.team !== null) {
    const n = Number(a.team);
    if (!Number.isInteger(n) || n <= 0) return refuse("Unknown team.");
    f.team_id = n;
  }
  if (a.status !== undefined && a.status !== null) {
    if (!isStatus(a.status)) return refuse("Unknown status.");
    f.status = a.status;
    f.view ??= "all";
  }
  if (a.priority !== undefined && a.priority !== null) {
    if (!isPriorityValue(a.priority)) return refuse("Unknown priority.");
    f.priority = a.priority;
  }
  if (a.assignee !== undefined && a.assignee !== null) {
    if (a.assignee === "me" || a.assignee === "none") f.assignee = a.assignee;
    else if (Number.isInteger(Number(a.assignee)) && Number(a.assignee) > 0) f.assignee = Number(a.assignee);
    else return refuse("Unknown assignee.");
  }
  if (a.requester !== undefined && a.requester !== null) {
    if (!Number.isInteger(Number(a.requester)) || Number(a.requester) <= 0) return refuse("Unknown requester.");
    f.requester_id = Number(a.requester);
  }
  if (typeof a.tag === "string" && a.tag) f.tag = a.tag.slice(0, 80);
  // 1.20.6: by category and sub-category (lib/helpdesk/categories); "none" = tickets without one.
  if (typeof a.category === "string" && a.category) f.category = a.category === "none" ? "" : a.category.slice(0, 80);
  if (typeof a.subcategory === "string" && a.subcategory) f.subcategory = a.subcategory === "none" ? "" : a.subcategory.slice(0, 80);
  if (a.breached === true) f.breached = "now";
  // 1.20.8: custom field conditions, the queue's own cf.<key> parameters.
  const cfMod = await import("../helpdesk/custom-field-filters");
  if (a.custom_fields !== undefined && a.custom_fields !== null) {
    if (typeof a.custom_fields !== "object" || Array.isArray(a.custom_fields)) return refuse('Send custom_fields as an object by field key, like { "device_type": "any:laptop" }.');
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(a.custom_fields as Record<string, unknown>)) {
      if (typeof v !== "string") return refuse(`The condition for "${k.slice(0, 60)}" is text, like "empty" or "contains:dock".`);
      p.set(cfMod.cfParamKey(k), v);
    }
    const custom = await cfMod.parseCustomFieldFilters(p);
    if (!custom.ok) return refuse(custom.error);
    if (custom.filters.length) f.custom = custom.filters;
  }
  f.q = String(a.query ?? "").slice(0, TICKET_LIMITS.q);
  f.limit = Math.min(50, Math.max(1, Number(a.limit) || 25));
  const [{ rows, total }, scope] = await Promise.all([listTickets(user, f), agentTeamIds(user)]);
  const { listTeams } = await import("../helpdesk/teams");
  const teams = (await listTeams()).filter((t) => scope === "all" || scope.includes(t.id));
  return toolJson({
    total,
    tickets: rows.map((r) => ({
      number: r.number,
      subject: r.subject,
      status: r.status,
      priority: r.priority,
      team: r.team_name,
      assignee: r.assignee_name,
      requester: r.requester_name,
      ...(r.requester_vip ? { vip: true } : {}),
      tags: r.tags,
      category: r.category || null,
      subcategory: r.subcategory || null,
      in_workflow: r.in_workflow,
      due: r.due_label || null,
      updated_at: r.updated_at,
      url: `${ctx.origin}/desk/tickets/${r.number}`,
    })),
    teams: teams.map((t) => ({ id: t.id, name: t.name })),
    // 1.20.6: the categories a ticket can be given, each with its sub-categories (the desk admin's list).
    categories: (await (await import("../helpdesk/categories")).activeCategories()).map((c) => ({ name: c.name, subcategories: c.subcategories.map((x) => x.name) })),
    // 1.20.8: the live custom fields custom_fields can filter on (left out when there are none).
    ...(await queueCustomFields()),
  });
}

async function queueCustomFields(): Promise<{ custom_fields?: { key: string; label: string; type: string; options?: string[] }[] }> {
  const fields = (await (await import("../helpdesk/custom-fields")).customFieldsSnapshot()).filter((x) => !x.archived);
  if (!fields.length) return {};
  return { custom_fields: fields.map((x) => ({ key: x.key, label: x.label, type: x.type, ...(x.options.length ? { options: x.options.map((o) => o.value) } : {}) })) };
}

async function readTicket(user: User, a: Args, ctx: Ctx) {
  const found = await ticketFor(user, a.number, "work");
  if (!found) return refuse(NOT_FOUND(a.number));
  const t = found.t;
  const [{ ticketDetail }, { answerRows }, { assignableAgents }] = await Promise.all([
    import("../helpdesk/detail"),
    import("../helpdesk/request-types"),
    import("../helpdesk/teams"),
  ]);
  // The desk's own read: the contact card follows the directory's visibility for this viewer.
  const d = await ticketDetail(user, t, true);
  const [answers, drafts, agents] = await Promise.all([
    d.form.length ? answerRows(d.form, t.form_answers ?? {}) : Promise.resolve([]),
    listPendingDrafts(t.id),
    assignableAgents(t.team_id).catch(() => []),
  ]);
  return toolJson({
    number: t.number,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    team: t.team_id ? { id: t.team_id, name: t.team_name } : null,
    // 1.20.2: the help address replies about this ticket go out under (lib/helpdesk/mailboxes).
    mailbox: d.mailbox ? { address: d.mailbox.address, name: d.mailbox.name } : null,
    assignee: t.assignee_id ? { id: t.assignee_id, name: t.assignee_name } : null,
    tags: t.tags,
    category: t.category,
    // 1.20.6 (additive): the sub-category, and the admin's list a category and sub-category are picked from.
    subcategory: t.subcategory ?? "",
    categories: (await (await import("../helpdesk/categories")).activeCategories()).map((c) => ({ name: c.name, subcategories: c.subcategories.map((x) => x.name) })),
    type: t.request_type_title,
    source: t.source,
    created_at: t.created_at,
    updated_at: t.updated_at,
    sla: {
      first_reply: d.sla.first_reply.label || null,
      resolve: d.sla.resolve.label || null,
      note: d.clock_note ?? null,
      target: d.sla_target_note || null,
    },
    requester: d.requester,
    answers,
    workflow: d.workflow,
    parent: d.parent,
    tasks: d.children.map((c) => ({ number: c.number, subject: c.subject, status: c.status, team: c.team_name })),
    // 1.19.2: checklists (agents only; required items must be ticked before it can be solved; agent W3).
    checklists: await (await import("../helpdesk/checklists")).checklistsForMcp(t.id),
    // 1.20.14 (additive): the library checklists an agent could add by hand now (hd_update_checklist add_template_id).
    checklist_templates: await checklistTemplatesFor(user, t),
    // 1.20.5: the "Before you solve" answers kept on the ticket, and what a solve would still need (lib/helpdesk/solve-requirements).
    ...(await (await import("../helpdesk/solve-requirements")).solveRequirementsForMcp(t)),
    // 1.20.6: the ticket's event on the desk's Calendar, or null (lib/helpdesk/desk-calendar). While its setup is not complete the ticket can't be solved.
    event: await (await import("../helpdesk/desk-calendar")).ticketEventOut(t.id),
    // 1.20.34: parked until its event (on hold, out of the queue, its targets paused): when it wakes and its prep window; null when
    // it has no event and isn't parked (lib/helpdesk/desk-calendar-park). Park or wake it with hd_update_ticket's event.park.
    parking: await (await import("../helpdesk/desk-calendar-park")).parkingOf(t.id),
    // 1.20.6: the custom fields of the ticket's team, each with its key, kind, options and value (agents only; lib/helpdesk/custom-fields).
    custom_fields: await (await import("../helpdesk/custom-fields")).customFieldsForMcp(t),
    // 1.19.3: linked assets from Snipe-IT (agents only; lib/helpdesk/assets).
    assets: await (await import("../helpdesk/assets")).assetsForMcp(t.id),
    conversation: d.messages.map((m) => messageOut(m, true)),
    pending_drafts: drafts.map((x) => ({ id: x.id, asked_by: x.created_by_name, at: x.created_at, body: x.body })),
    assignable_agents: agents.map((g) => ({ id: g.user_id, name: g.name })),
    url: `${ctx.origin}/desk/tickets/${t.number}`,
  });
}

async function internalNote(user: User, a: Args, ctx: Ctx) {
  if (messagePostLimited(user.id)) return tooMany();
  const found = await ticketFor(user, a.number, "work");
  if (!found) return refuse(NOT_FOUND(a.number));
  const t = found.t;
  if (!(await hdCan(user, "tickets.internal_note", { teamId: t.team_id }))) return refuse(`${HD_FORBIDDEN} (403: Add internal notes)`);
  const locked = await mergedLock(t);
  if (locked) return refuse(`${locked} (409)`);
  const body = textField(a.body, MESSAGE_LIMITS.body);
  if (body === null) return refuse("The note is too long.");
  if (!body) return refuse("Write the note (body).");
  const res = await addMessage(t.id, { kind: "internal", body, author: author(user), via: "mcp", asRequester: false }, { origin: ctx.origin });
  if (!res) return refuse(NOT_FOUND(a.number));
  await auditMcp(user, ctx, "helpdesk.note.added", { type: "helpdesk_ticket", id: t.id, label: ticketLabel(t) }, {
    number: t.number,
    message_id: res.message.id,
  });
  return toolJson({ number: t.number, added: true, visible_to: "agents only", url: `${ctx.origin}/desk/tickets/${t.number}` });
}

async function draftReply(user: User, a: Args, ctx: Ctx) {
  if (messagePostLimited(user.id)) return tooMany();
  const found = await ticketFor(user, a.number, "work");
  if (!found) return refuse(NOT_FOUND(a.number));
  const t = found.t;
  // A draft is a reply in waiting: the person must be able to reply at all (sent or held for review).
  const teamId = t.team_id;
  if (!(await hdCan(user, "tickets.reply_public", { teamId })) && !(await hdCan(user, "tickets.reply_needs_review", { teamId }))) {
    return refuse(`${HD_FORBIDDEN} (403: Reply to the requester)`);
  }
  const locked = await mergedLock(t);
  if (locked) return refuse(`${locked} (409)`);
  let body = textField(a.body, DRAFT_LIMITS.body);
  if (body === null) return refuse("The draft is too long.");
  // 1.20.15: canned_id starts the draft from a canned response the person may use there, filled for
  // the ticket as hd_canned_responses fills it (lib/helpdesk/canned, the desk's own insert rules).
  let canned: { id: number; name: string } | null = null;
  if (a.canned_id !== undefined && a.canned_id !== null) {
    const id = Number(a.canned_id);
    const cn = await import("../helpdesk/canned");
    const c = Number.isSafeInteger(id) && id > 0 ? await cn.getCanned(id) : undefined;
    // 1.20.23: and in one of their desk departments (or All departments), as the desk's picker.
    if (!c || !cn.cannedVisibleTo(c, user.id, await agentTeamIds(user), t.team_id, await deskDepartmentScope(user))) {
      return refuse(`No canned response with id ${String(a.canned_id)} that you can use on #${t.number}. hd_canned_responses lists them. Nothing was saved.`);
    }
    const filled = (await cn.renderCannedFor(c, t, user)).trim();
    body = body ? `${filled}\n\n${body}` : filled;
    if (body.length > DRAFT_LIMITS.body) return refuse("The draft is too long.");
    canned = { id: c.id, name: c.title };
  }
  if (!body) return refuse("Write the draft (body), or send canned_id.");
  const draft = await createReplyDraft(t.id, body, user.id, "claude");
  // A canned response put into a reply counts as a use, as an insert in the desk does.
  if (canned) await (await import("../helpdesk/canned")).recordCannedUse(canned.id, user.id, t.id);
  await auditMcp(user, ctx, "helpdesk.reply_draft.created", { type: "helpdesk_ticket", id: t.id, label: ticketLabel(t) }, {
    number: t.number,
    draft_id: draft.id,
    ...(canned ? { canned_id: canned.id } : {}),
  });
  return toolJson({
    number: t.number,
    draft_id: draft.id,
    ...(canned ? { canned_response: canned } : {}),
    sent: false,
    note: "Saved as a draft. Nothing was sent to the requester. It waits in the ticket as \"Draft from Claude\" for an agent to edit and send, or discard.",
    url: `${ctx.origin}/desk/tickets/${t.number}`,
  });
}

async function updateTicketTool(user: User, a: Args, ctx: Ctx) {
  const found = await ticketFor(user, a.number, "work");
  if (!found) return refuse(NOT_FOUND(a.number));
  const t = found.t;
  const raw: Record<string, unknown> = {};
  // 1.20.6: custom_fields ({ "<field key>": value | null }) are set like tags: by an agent who works the ticket.
  for (const k of ["status", "priority", "team_id", "assignee_id", "tags", "category", "subcategory", "custom_fields"] as const) if (a[k] !== undefined) raw[k] = a[k];
  if (raw.assignee_id === "me") raw.assignee_id = user.id;
  // 1.20.6: `event` sets, changes or (null) removes the ticket's event (lib/helpdesk/desk-calendar).
  const hasEvent = a.event !== undefined;
  if (!Object.keys(raw).length && !hasEvent) return refuse("Say what to change: status, priority, team_id, assignee_id, tags, category, subcategory, custom_fields or event.");
  const patch = validateTicketPatch(raw);
  const session = toSessionUser(user);
  const { patchRefusal } = await import("../helpdesk/patch-caps");
  const refused = await patchRefusal(session, t, patch);
  if (refused) return refuse(`${refused} (403)`);
  // A merged ticket's status is locked, as the desk's PATCH route does.
  if (patch.status !== undefined && patch.status !== t.status) {
    const locked = await mergedLock(t);
    if (locked) return refuse(`${locked} (409)`);
  }
  if (t.source === "workflow" && (patch.status === "solved" || patch.status === "closed") && patch.status !== t.status) {
    const { validateTaskSolve } = await import("../helpdesk/engine");
    const missing = await validateTaskSolve(t.id);
    if (missing) return refuse(`${missing.error} The task's hand-off is entered in the desk (Mark done).`);
  }
  // 1.20.6: the event first; setup_complete sent with a status that solves is saved in the solve's own transaction.
  let eventChanged = false;
  let setupComplete = false;
  if (hasEvent) {
    const cal = await import("../helpdesk/desk-calendar");
    try {
      // 1.20.34: event.park / event.prep_days need the person's Change status permission, as the desk's status menu.
      const mayPark = await hdCan(user, "tickets.change_status", { teamId: t.team_id });
      const done = await cal.applyEventPatch(t, a.event, { id: user.id, name: user.name || user.username, role: user.role, via: "mcp" }, { origin: ctx.origin, deferSetup: patch.status === "solved" || patch.status === "closed", mayPark });
      eventChanged = done.changed;
      setupComplete = done.setupDeferred;
    } catch (e) {
      if (e instanceof cal.EventError) return refuse(`${e.message} (${e.status})`);
      throw e;
    }
  }
  // 1.20.5: a solve that a "Before you solve" requirement set refuses says what to send (lib/helpdesk/solve-requirements).
  let r: Awaited<ReturnType<typeof updateTicket>>;
  try {
    r = Object.keys(patch).length
      ? await updateTicket(t.id, patch, { id: user.id, name: user.name || user.username, role: user.role, via: "mcp" }, { origin: ctx.origin }, { solveAnswers: a.solve_answers ?? undefined, setupComplete })
      : await getTicketByNumber(t.number).then((ticket) => (ticket ? { ticket, changed: [], before: t } : undefined));
  } catch (e) {
    if (e instanceof HdTicketError && e.extra?.code === "solve_requirements") {
      return refuse(`${e.message} (${e.status}) Set the ticket fields first (custom fields with custom_fields, in the same call or before), and send the closing fields as solve_answers with status solved: hd_read_ticket lists them under before_you_solve. An event's setup is marked with event: { setup_complete: true }, once the person confirms it is done.`);
    }
    // 1.20.6: a category or sub-category that is not on the admin's list. The sentence names the allowed values; nothing was changed.
    if (e instanceof HdTicketError && (e.extra?.code === "category_not_listed" || e.extra?.code === "subcategory_not_listed")) {
      return refuse(`${e.message} (${e.status}) Nothing was changed. Only the desk admin adds categories (Desk settings, Categories).`);
    }
    throw e;
  }
  if (!r) return refuse(NOT_FOUND(a.number));
  if (eventChanged || setupComplete) {
    await auditMcp(user, ctx, "helpdesk.ticket.updated", { type: "helpdesk_ticket", id: t.id, label: ticketLabel(r.ticket) }, { number: t.number, changed: ["event"] });
  }
  if (r.changed.includes("assignee_id")) {
    const { recordManualAssignment } = await import("../helpdesk/assignment/engine");
    void recordManualAssignment(r.ticket.id, {
      fromUserId: r.before.assignee_id,
      toUserId: r.ticket.assignee_id,
      teamId: r.ticket.team_id,
      actorId: user.id,
    });
  }
  if (r.changed.length) {
    await auditMcp(user, ctx, "helpdesk.ticket.updated", { type: "helpdesk_ticket", id: t.id, label: ticketLabel(r.ticket) }, {
      number: t.number,
      changed: r.changed,
    });
  }
  return toolJson({
    number: r.ticket.number,
    changed: [...r.changed, ...(eventChanged || setupComplete ? ["event"] : [])],
    event: await (await import("../helpdesk/desk-calendar")).ticketEventOut(r.ticket.id),
    parking: await (await import("../helpdesk/desk-calendar-park")).parkingOf(r.ticket.id),
    status: (await getTicketByNumber(r.ticket.number))?.status ?? r.ticket.status,
    priority: r.ticket.priority,
    team: r.ticket.team_name,
    assignee: r.ticket.assignee_name,
    tags: r.ticket.tags,
    url: `${ctx.origin}/desk/tickets/${r.ticket.number}`,
  });
}

/** Up to three telling words of a subject, for "similar tickets". */
function keywords(subject: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "from", "that", "this", "can't", "cannot", "not", "does", "doesn't", "won't", "when", "after", "have", "into", "since"]);
  const words = subject
    .toLowerCase()
    .split(/[^\p{L}\p{N}'-]+/u)
    .filter((w) => w.length >= 3 && !stop.has(w));
  return [...new Set(words)].sort((x, y) => y.length - x.length).slice(0, 3);
}

async function ticketSummary(user: User, a: Args, ctx: Ctx) {
  const found = await ticketFor(user, a.number, "work");
  if (!found) return refuse(NOT_FOUND(a.number));
  const t = found.t;
  const [{ ticketDetail, currentStep }, { answerRows }] = await Promise.all([import("../helpdesk/detail"), import("../helpdesk/request-types")]);
  const d = await ticketDetail(user, t, true);
  const answers = d.form.length ? await answerRows(d.form, t.form_answers ?? {}) : [];
  // Similar tickets: the same queues, ranked by how many of the subject's telling words they share.
  const score = new Map<number, { hits: number; row: Awaited<ReturnType<typeof listTickets>>["rows"][number] }>();
  for (const w of keywords(t.subject)) {
    const { rows } = await listTickets(user, { view: "all", q: w, limit: 15, sort: "updated" });
    for (const r of rows) {
      if (r.id === t.id) continue;
      const s = score.get(r.id) ?? { hits: 0, row: r };
      s.hits++;
      score.set(r.id, s);
    }
  }
  const similar = [...score.values()]
    .sort((x, y) => y.hits - x.hits || Number(["solved", "closed"].includes(y.row.status)) - Number(["solved", "closed"].includes(x.row.status)))
    .slice(0, 5)
    .map(({ row }) => ({ number: row.number, subject: row.subject, status: row.status, team: row.team_name, updated_at: row.updated_at, url: `${ctx.origin}/desk/tickets/${row.number}` }));
  return toolJson({
    instructions: "Summarize this ticket for an agent: the problem, what has been tried, where it stands and the next step. Internal notes are agent-only: keep them out of anything meant for the requester.",
    ticket: { number: t.number, subject: t.subject, status: t.status, priority: t.priority, team: t.team_name, assignee: t.assignee_name, requester: t.requester_name, opened: t.created_at },
    answers,
    workflow_step: currentStep(d.workflow),
    conversation: d.messages.map((m) => messageOut(m, true)),
    similar_tickets: similar,
  });
}

async function report(user: User, a: Args) {
  const { getHelpdeskSettings } = await import("../helpdesk/settings");
  const { parseReportRange, reportSummary } = await import("../helpdesk/reports");
  const p = new URLSearchParams();
  if (typeof a.from === "string" && a.from) p.set("from", a.from);
  if (typeof a.to === "string" && a.to) p.set("to", a.to);
  if (a.team !== undefined && a.team !== null) p.set("team", String(a.team));
  if (a.mine === true) p.set("agent", "me");
  const settings = await getHelpdeskSettings();
  const parsed = parseReportRange(p, settings.timezone);
  if (!parsed.ok) return refuse(parsed.error);
  const range = parsed.range as typeof parsed.range & { own?: boolean };
  // The reports route's rule (agent J's matrix).
  let allowed: boolean;
  if (range.own) {
    allowed = await hdCan(user, "reports.own");
    range.assignee_id = user.id;
  } else if (range.team_id) allowed = await hdCan(user, "reports.team", { teamId: range.team_id });
  else allowed = await hdCan(user, "reports.all");
  if (!allowed) return refuse(`${HD_FORBIDDEN} (403: ${range.own ? "Their own stats" : range.team_id ? "Team reports" : "All reports"})`);
  if (exportRateLimited(`hd-report:${user.id}`)) return refuse("Too many reports. Try again in a minute (429).");
  const r = await reportSummary({ from: range.from, to: range.to, team_id: range.team_id, assignee_id: range.assignee_id });
  return toolJson({
    from: r.from,
    to: r.to,
    timezone: settings.timezone,
    scope: range.own ? "your tickets" : range.team_id ? `team ${range.team_id}` : "every team",
    created: r.created,
    solved: r.solved,
    first_reply_median_minutes: r.first_reply_median_minutes,
    resolution_median_minutes: r.resolution_median_minutes,
    sla_met_percent: r.sla_met_percent,
    csat_percent: r.csat_percent,
    csat_average: r.csat_average ?? null,
    csat_responses: r.csat_responses,
    by_team: r.by_team.slice(0, 20),
    by_agent: r.by_agent.slice(0, 20),
    by_category: r.by_category.slice(0, 20),
    by_subcategory: (r.by_subcategory ?? []).slice(0, 40),
    note: "Times are business minutes in each team's calendar.",
  });
}

// --- Admin side: drafts only ------------------------------------------------------------

async function listWorkflowsTool(user: User, a: Args, ctx: Ctx) {
  const { getWorkflow, listWorkflows, workingDefinition } = await import("../helpdesk/workflows");
  if (a.id !== undefined && a.id !== null) {
    const found = Number.isSafeInteger(Number(a.id)) ? await getWorkflow(Number(a.id)) : undefined;
    // 1.20.23: only one of the person's desk departments' workflows, or All departments'.
    const w = found ? (await deptRowsFor(user, "workflows", [found]))[0] : undefined;
    if (!w) return refuse(`No workflow with id ${a.id}.`);
    return toolJson({
      id: w.id,
      slug: w.slug,
      title: w.title,
      description: w.description,
      desk_department: w.desk_department,
      can_change: w.can_change,
      published: w.published === 1,
      version: w.version,
      unpublished_changes: w.has_changes || (!w.published && !!w.draft),
      runs_open: w.runs_open,
      request_types: w.request_types,
      definition: workingDefinition(w),
      edit_url: `${ctx.origin}/desk/workflows/${w.slug}`,
    });
  }
  const rows = await deptRowsFor(user, "workflows", await listWorkflows());
  return toolJson({
    workflows: rows.map((w) => ({
      id: w.id,
      slug: w.slug,
      title: w.title,
      desk_department: w.desk_department,
      can_change: w.can_change,
      published: w.published === 1,
      version: w.version,
      unpublished_changes: w.has_changes || (!w.published && !!w.draft),
      runs_open: w.runs_open,
      runs_last_30_days: w.runs_recent,
      request_types: w.request_types.map((r) => r.title),
      edit_url: `${ctx.origin}/desk/workflows/${w.slug}`,
    })),
  });
}

// --- 1.20.23: desk departments on the admin side (lib/helpdesk/desk-departments) ---------------
//
// The connector's lists show the person's desk departments' items and All departments' (as Desk
// settings does), each with its desk_department name and whether they may change it; a draft of
// changes to an item needs a department they manage (All departments: desk Admin only); a new
// draft goes into their starting department (the default one when they manage it).

type DeptFeature = import("../helpdesk/desk-departments").HdDeskDepartmentFeature;

/** Why the person may not draft changes to an item of department `deptId` (they see it, they don't manage it); null = fine. */
async function deptDraftRefusal(user: User, feature: DeptFeature, deptId: number | null | undefined): Promise<string | null> {
  const dd = await import("../helpdesk/desk-departments");
  const access = await dd.deskDepartmentAccess(user, feature);
  if (dd.mayManageDept(access, deptId ?? null)) return null;
  return deptId === null || deptId === undefined
    ? `It is shared with all desk departments: only a desk Admin can change it (403). Nothing was saved.`
    : `It belongs to the ${await dd.deskDepartmentName(deptId)} desk department, which you don't manage (403). Nothing was saved.`;
}

/** The department a new draft goes into, or the refusal. */
async function newDraftDept(user: User, feature: DeptFeature): Promise<{ value: number | null } | { error: string }> {
  const dd = await import("../helpdesk/desk-departments");
  const start = await dd.startingDeptFor(await dd.deskDepartmentAccess(user, feature));
  return start === null ? { error: "You don't manage any desk department to save a draft in (403). Nothing was saved." } : { value: start };
}

/** Rows filtered to what the person sees, with their department's name and can_change. */
async function deptRowsFor<T extends { desk_department_id?: number | null }>(user: User, feature: DeptFeature, rows: T[]): Promise<(T & { desk_department: string; can_change: boolean })[]> {
  const dd = await import("../helpdesk/desk-departments");
  const access = await dd.deskDepartmentAccess(user, feature);
  const names = new Map((await dd.listDeskDepartments()).map((d) => [d.id, d.name]));
  return rows
    .filter((r) => dd.maySeeDept(access, r.desk_department_id))
    .map((r) => ({
      ...r,
      desk_department: r.desk_department_id == null ? dd.ALL_DESK_DEPARTMENTS_LABEL : (names.get(r.desk_department_id) ?? "Desk department"),
      can_change: dd.mayManageDept(access, r.desk_department_id),
    }));
}

async function draftWorkflow(user: User, a: Args, ctx: Ctx) {
  const { createWorkflow, getWorkflow, saveWorkflowDraft, validateWorkflowDefinition, validateWorkflowMeta } = await import("../helpdesk/workflows");
  const PUBLISH = "Nothing is published: a person reviews and publishes it in the desk's workflow builder (edit_url).";
  if (a.id !== undefined && a.id !== null) {
    const id = Number(a.id);
    const existing = Number.isSafeInteger(id) ? await getWorkflow(id) : undefined;
    if (!existing || !(await deptRowsFor(user, "workflows", [existing])).length) return refuse(`No workflow with id ${a.id}.`);
    const notMine = await deptDraftRefusal(user, "workflows", existing.desk_department_id);
    if (notMine) return refuse(notMine);
    // Only the steps change, and only in the draft: name and address stay as the builder left them.
    const meta = await validateWorkflowMeta({}, existing);
    if (!meta.ok) return refuse(meta.error);
    const checked = await validateWorkflowDefinition(a.definition, id);
    if (!checked.ok) return refuse(checked.error);
    const w = await saveWorkflowDraft(id, meta.value, checked.value);
    if (!w) return refuse(`No workflow with id ${a.id}.`);
    await auditMcp(user, ctx, "helpdesk.workflow.updated", { type: "helpdesk_workflow", id, label: w.title }, { fields: ["draft"], steps: checked.value.steps.length });
    return toolJson({ id: w.id, title: w.title, saved: "draft", published_version_unchanged: w.published === 1, note: PUBLISH, edit_url: `${ctx.origin}/desk/workflows/${w.slug}` });
  }
  const meta = await validateWorkflowMeta({ title: a.title, description: a.description ?? "" });
  if (!meta.ok) return refuse(meta.error);
  const dept = await newDraftDept(user, "workflows");
  if ("error" in dept) return refuse(dept.error);
  // Review M1/M2: its trigger's request type and its checklists fit the department it goes into.
  const checked = await validateWorkflowDefinition(a.definition, null, dept.value);
  if (!checked.ok) return refuse(checked.error);
  const w = await createWorkflow(meta.value, checked.value, dept.value);
  await auditMcp(user, ctx, "helpdesk.workflow.created", { type: "helpdesk_workflow", id: w.id, label: w.title }, { slug: w.slug, steps: checked.value.steps.length });
  return toolJson({ id: w.id, title: w.title, saved: "draft", published: false, note: PUBLISH, edit_url: `${ctx.origin}/desk/workflows/${w.slug}` });
}

async function draftRequestType(user: User, a: Args, ctx: Ctx) {
  const { createRequestType, validateRequestTypeInput } = await import("../helpdesk/request-types");
  const input: Record<string, unknown> = {};
  for (const k of ["title", "description", "icon", "team_id", "category", "subcategory", "form", "workflow_id", "sla_priority", "eta_label"]) {
    if (a[k] !== undefined) input[k] = a[k];
  }
  // A draft: switched off, so it is in nobody's Get help until a person turns it on.
  input.active = 0;
  const checked = await validateRequestTypeInput(input);
  if (!checked.ok) return refuse(checked.error);
  // 1.20.23: in the person's starting desk department; its workflow must be of that department or All departments.
  const dept = await newDraftDept(user, "request_types");
  if ("error" in dept) return refuse(dept.error);
  const mismatch = await (await import("../helpdesk/desk-departments")).requestTypeWorkflowRefusal(dept.value, checked.value.workflow_id);
  if (mismatch) return refuse(`${mismatch} Nothing was saved.`);
  let rt;
  try {
    rt = await createRequestType({ ...checked.value, active: 0 }, dept.value);
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return refuse("Another request type already uses that address name.");
    throw e;
  }
  await auditMcp(user, ctx, "helpdesk.request_type.created", { type: "helpdesk_request_type", id: rt.id, label: rt.title }, {
    slug: rt.slug,
    team_id: rt.team_id,
    workflow_id: rt.workflow_id,
    fields: rt.form.length,
    visibility: rt.visibility,
    active: false,
  });
  return toolJson({
    id: rt.id,
    slug: rt.slug,
    title: rt.title,
    saved: "draft (switched off)",
    note: "Nobody sees it in Get help yet. A person reviews it and switches it on in Desk settings → Request types.",
    edit_url: `${ctx.origin}/desk/settings/request-types`,
  });
}

async function draftMacro(user: User, a: Args, ctx: Ctx) {
  const { createMacro, MacroLimitError, validateMacroInput } = await import("../helpdesk/macros");
  // A draft is the person's own personal macro: nobody else sees it until they share it in the app.
  const input = await validateMacroInput({ title: a.title, body: a.body ?? "", actions: a.actions ?? {}, personal: true });
  if (!input.ok) return refuse(input.error);
  let macro;
  try {
    macro = await createMacro({ ...(input.value as import("../helpdesk/macros").MacroInput), team_id: null, owner_id: user.id }, user.id);
  } catch (e) {
    if (e instanceof MacroLimitError) return refuse(e.message);
    throw e;
  }
  await auditMcp(user, ctx, "helpdesk.macro.created", { type: "helpdesk_macro", id: macro.id, label: macro.title }, {
    scope: "personal",
    team_id: null,
    actions: Object.keys(macro.actions ?? {}),
  });
  return toolJson({
    id: macro.id,
    title: macro.title,
    saved: "draft (your personal macro)",
    note: "Only you see it. Share it with a team or everyone in Desk settings → Macros.",
    edit_url: `${ctx.origin}/desk/settings/macros`,
  });
}

// --- Checklists (1.20.14) ----------------------------------------------------------------

/** The library checklists that can be added to this ticket now (none on a closed or merged one, none it already has). */
/** 1.20.23: only the person's desk departments' checklists and All departments' (lib/helpdesk/desk-departments). */
async function checklistTemplatesFor(user: User, t: HdTicket): Promise<{ id: number; name: string; items: number; required: number }[]> {
  const cl = await import("../helpdesk/checklists");
  if (!cl.checklistsEditable(t)) return [];
  const [options, on] = await Promise.all([deskDepartmentScope(user).then(cl.templateOptions), cl.ticketChecklists(t.id)]);
  const have = new Set(on.map((c) => c.template_id));
  return options.filter((o) => !have.has(o.id));
}

const CHECKLIST_BATCH = 50;

async function updateChecklistTool(user: User, a: Args, ctx: Ctx) {
  const found = await ticketFor(user, a.number, "work");
  if (!found) return refuse(NOT_FOUND(a.number));
  const t = found.t;
  const posInt = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
  let addId: number | null = null;
  if (a.add_template_id !== undefined && a.add_template_id !== null) {
    addId = posInt(a.add_template_id);
    if (!addId) return refuse("add_template_id is a checklist id from hd_read_ticket's checklist_templates.");
  }
  const changes: { id: number; done: boolean }[] = [];
  if (a.items !== undefined && a.items !== null) {
    if (!Array.isArray(a.items)) return refuse("Send items as a list of { id, done }.");
    if (a.items.length > CHECKLIST_BATCH) return refuse(`Up to ${CHECKLIST_BATCH} items in one call.`);
    for (const [i, raw] of (a.items as unknown[]).entries()) {
      const it = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
      const id = posInt(it?.id);
      if (!it || !id || typeof it.done !== "boolean") return refuse(`Item ${i + 1} needs an id (from hd_read_ticket's checklists) and done true or false.`);
      const twice = changes.find((c) => c.id === id);
      if (twice && twice.done !== it.done) return refuse(`Item ${id} is asked to be both ticked and unticked. Send it once.`);
      if (!twice) changes.push({ id, done: it.done });
    }
  }
  if (!addId && !changes.length) return refuse("Say what to do: items to tick or untick ([{ id, done }]), or add_template_id. hd_read_ticket lists both.");
  const cl = await import("../helpdesk/checklists");
  // Ticking is open to anyone who works the ticket (the desk's rule); a closed or merged ticket can't change.
  if (!cl.checklistsEditable(t)) return refuse(t.merged_into ? `#${t.number} was merged into another ticket, so its checklists can't change (409).` : `#${t.number} is closed, so its checklists can't change (409).`);
  let added: { checklist_id: number; name: string } | null = null;
  let ticked: Awaited<ReturnType<typeof cl.tickItemsAs>> = [];
  try {
    if (addId) {
      if (!(await cl.templateOptions(await deskDepartmentScope(user))).some((o) => o.id === addId)) return refuse(`No library checklist with id ${addId} that can be added. hd_read_ticket lists them under checklist_templates. Nothing was changed.`);
      added = await cl.addChecklistAs(user, t, addId, { ip: ctx.ip, via: "mcp" });
    }
    if (changes.length) ticked = await cl.tickItemsAs(user, t, changes, { ip: ctx.ip, via: "mcp" });
  } catch (e) {
    if (e instanceof cl.ChecklistError) return refuse(`${e.message}${added ? ` The checklist "${added.name}" was added first.` : ""} (${e.status})`);
    throw e;
  }
  const block = await cl.checklistSolveRefusal(t.id);
  return toolJson({
    number: t.number,
    ...(added ? { added: { checklist_id: added.checklist_id, name: added.name } } : {}),
    ...(ticked.length
      ? { items: ticked.map((x) => ({ id: x.id, title: x.title, checklist: x.checklist, done: x.done, changed: x.changed, ...(x.required ? { required: true } : {}) })) }
      : {}),
    checklists: await cl.checklistsForMcp(t.id),
    required_open: block ? block.open.map((o) => ({ id: o.id, title: o.title, checklist: o.checklist })) : [],
    note: block ? "Required items are still open, so the ticket can't be solved yet." : "No required item is open. Solving is still done with hd_update_ticket, with the person's say-so.",
    url: `${ctx.origin}/desk/tickets/${t.number}`,
  });
}

const checklistsUrl = (ctx: Ctx, id?: number) => `${ctx.origin}/desk/settings/checklists${id ? `?id=${id}` : ""}`;

function checklistStatus(t: { published: boolean; draft: unknown }): string {
  return !t.published ? "draft (not published)" : t.draft ? "published, with changes waiting for review" : "published";
}

async function listChecklistsTool(user: User, a: Args, ctx: Ctx) {
  const cl = await import("../helpdesk/checklists");
  if (a.id !== undefined && a.id !== null) {
    const id = Number(a.id);
    const found = Number.isSafeInteger(id) && id > 0 ? await cl.getTemplate(id) : undefined;
    // 1.20.23: only one of the person's desk departments' checklists, or All departments'.
    const t = found ? (await deptRowsFor(user, "checklists", [found]))[0] : undefined;
    if (!t) return refuse(`No checklist with id ${a.id}.`);
    return toolJson({
      id: t.id,
      name: t.name,
      desk_department: t.desk_department,
      can_change: t.can_change,
      status: checklistStatus(t),
      items: t.items,
      request_type_ids: t.request_type_ids,
      draft: t.draft ? { ...t.draft, asked_by: t.draft_by_name, at: t.draft_at } : null,
      edit_url: checklistsUrl(ctx, t.id),
    });
  }
  const [all, teams, types] = await Promise.all([
    cl.listTemplateRows(),
    (await import("../helpdesk/db-core")).hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams ORDER BY position, lower(name), id"),
    // 1.20.23 review L1: only the request types of the caller's desk departments and All departments'.
    import("../helpdesk/desk-departments").then(async (dd) => dd.requestTypeOptions((await dd.deskDepartmentAccess(user, "checklists")).scope)),
  ]);
  const rows = await deptRowsFor(user, "checklists", all);
  return toolJson({
    checklists: rows.map((t) => ({
      id: t.id,
      name: t.name,
      desk_department: t.desk_department,
      can_change: t.can_change,
      status: checklistStatus(t),
      items: t.items.length,
      required: t.items.filter((i) => i.required).length,
      added_automatically_to: t.added_to,
      used_on_tickets: t.used,
    })),
    teams,
    request_types: types.map((r) => ({ id: r.id, title: r.title, switched_on: r.active === 1 })),
    edit_url: checklistsUrl(ctx),
  });
}

async function draftChecklist(user: User, a: Args, ctx: Ctx) {
  const cl = await import("../helpdesk/checklists");
  const input: Record<string, unknown> = {};
  for (const k of ["name", "items", "request_type_ids"]) if (a[k] !== undefined) input[k] = a[k];
  let id: number | undefined;
  if (a.id !== undefined && a.id !== null) {
    id = Number(a.id);
    if (!Number.isSafeInteger(id) || id <= 0) return refuse(`No checklist with id ${a.id}.`);
  }
  // 1.20.23: changes only to a checklist of a desk department they manage; a new one in their starting department.
  let dept: number | null | undefined;
  if (id !== undefined) {
    const cur = await cl.getTemplate(id);
    if (!cur || !(await deptRowsFor(user, "checklists", [cur])).length) return refuse(`No checklist with id ${a.id}. Nothing was saved.`);
    const notMine = await deptDraftRefusal(user, "checklists", cur.desk_department_id);
    if (notMine) return refuse(notMine);
  } else {
    const d = await newDraftDept(user, "checklists");
    if ("error" in d) return refuse(d.error);
    dept = d.value;
  }
  let r: Awaited<ReturnType<typeof cl.saveTemplateDraft>>;
  try {
    r = await cl.saveTemplateDraft(input, { id: user.id, name: user.name || user.username, via: "mcp" }, id, dept);
  } catch (e) {
    if (e instanceof cl.ChecklistError) return refuse(`${e.message} Nothing was saved.`);
    throw e;
  }
  const t = r.template;
  const shape = t.draft ?? t;
  const counts = { items: shape.items.length, required: shape.items.filter((i) => i.required).length, request_type_ids: shape.request_type_ids, draft: true };
  if (r.kind === "new") await auditMcp(user, ctx, "helpdesk.checklist_template.created", { type: "helpdesk_checklist", id: t.id, label: t.name }, { ...counts, published: false });
  else await auditMcp(user, ctx, "helpdesk.checklist_template.updated", { type: "helpdesk_checklist", id: t.id, label: t.name }, { changed: ["draft"], ...counts, published: t.published });
  return toolJson({
    id: t.id,
    name: shape.name,
    saved: r.kind === "changes" ? "draft of changes (the live checklist is unchanged)" : "draft (not published)",
    published: t.published,
    items: shape.items.length,
    note:
      r.kind === "changes"
        ? "Tickets and request types keep using the live checklist. A person with checklist access reviews the changes and publishes or discards them in Desk settings → Checklists."
        : "Nobody can add it to a ticket yet and nothing adds it automatically. A person with checklist access reviews it, edits it if needed and publishes it in Desk settings → Checklists.",
    edit_url: checklistsUrl(ctx, t.id),
  });
}

// --- Macros (1.20.15) ----------------------------------------------------------------------

const MACRO_REPLY_PREVIEW = 400;

async function listMacrosTool(user: User, a: Args, ctx: Ctx) {
  const mac = await import("../helpdesk/macros");
  let t: HdTicket | null = null;
  if (a.number !== undefined && a.number !== null && a.number !== "") {
    const found = await ticketFor(user, a.number, "work");
    if (!found) return refuse(NOT_FOUND(a.number));
    t = found.t;
    // The desk's rule: Use macros in the ticket's team.
    if (!(await hdCan(user, "macros.use", { teamId: t.team_id }))) return refuse(`${HD_FORBIDDEN} (403: Use macros on #${t.number})`);
  }
  const query = typeof a.query === "string" ? a.query.trim().toLowerCase().slice(0, 200) : "";
  const limit = Math.min(50, Math.max(1, Number.isFinite(Number(a.limit)) ? Math.floor(Number(a.limit)) : 20));
  // Exactly the macros the desk lets them apply: their own personal ones, their teams' and everyone's (macroVisibleTo).
  // 1.20.23: everyone's in their desk departments and All departments only.
  const all = await mac.listMacros(await agentTeamIds(user), user.id, await deskDepartmentScope(user));
  const hits = all.filter((m) => !query || m.title.toLowerCase().includes(query) || m.body.toLowerCase().includes(query)).slice(0, limit);
  const mctx = t ? await mac.macroContext(t.id, { id: user.id, name: user.name || user.username, email: user.email }, ctx.origin) : null;
  const out = [];
  for (const m of hits) {
    const does = await mac.macroDoes(m);
    const reply = (mctx ? mac.renderMacro(m.body, mctx) : m.body).trim();
    out.push({
      id: m.id,
      name: m.title,
      scope: m.scope,
      team: m.scope === "team" ? m.team_name ?? null : null,
      does: does.lines,
      solves: does.solves,
      reply_preview: reply ? (reply.length > MACRO_REPLY_PREVIEW ? `${reply.slice(0, MACRO_REPLY_PREVIEW - 1)}…` : reply) : null,
      changes: m.actions ?? {},
    });
  }
  return toolJson({
    ...(t ? { ticket: t.number } : {}),
    count: out.length,
    macros: out,
    note: "Apply one with hd_apply_macro, after confirming with the person. Its reply is saved as a draft for an agent to send from the desk, never sent, and its status change is not made (the agent sets it after sending the reply). Macros never change the assignee.",
  });
}

async function applyMacroTool(user: User, a: Args, ctx: Ctx) {
  if (messagePostLimited(user.id)) return tooMany();
  const n = parseTicketNumber(typeof a.number === "number" || typeof a.number === "string" ? a.number : "");
  if (!n) return refuse(NOT_FOUND(a.number));
  const macroId = Number(a.macro_id);
  if (!Number.isSafeInteger(macroId) || macroId <= 0) return refuse("macro_id is a macro's id from hd_list_macros.");
  const { applyMacroAs, MACRO_DRAFT_STATUS_WAITS } = await import("../helpdesk/macros");
  // The desk route's own function, as the person; the reply becomes a draft (this connector never sends one).
  const r = await applyMacroAs(toSessionUser(user), n, macroId, { origin: ctx.origin, replyAs: "draft", via: "mcp", ip: ctx.ip });
  if (!r.ok) {
    if (r.status === 404 && r.error === "Ticket not found.") return refuse(NOT_FOUND(a.number));
    if (r.status === 404) return refuse(`No macro with id ${macroId} that you can use. hd_list_macros lists them. Nothing was changed.`);
    if (r.merged) {
      const t = await getTicketByNumber(n);
      const locked = t ? await mergedLock(t) : null;
      return refuse(`${locked ?? `#${n} was merged into another ticket.`} (409) Nothing was changed.`);
    }
    if (r.status === 409 && r.error === "This ticket is closed.") return refuse(`#${n} is closed, so a macro can't change it. (409) Nothing was changed.`);
    if (r.missing) return refuse(`${r.error} (409) The task's hand-off is entered in the desk (Mark done). Nothing was changed.`);
    return refuse(`${r.error} (${r.status}) Nothing was changed.`);
  }
  const res = r.result;
  const fresh = await getTicketByNumber(n);
  const drafted = res.draft_id !== undefined;
  const waits = res.status_unchanged === MACRO_DRAFT_STATUS_WAITS;
  const notes: string[] = [];
  if (drafted) notes.push("The macro's reply was saved as a draft and NOT sent. It waits in the ticket as \"Draft from Claude\" for an agent to edit and send from the desk, or discard. Tell the person.");
  if (waits) notes.push(`The macro's status change (${r.macro.actions?.status}) was not made: set it once the reply is sent, in the desk or with hd_update_ticket, with the person's say-so.`);
  else if (res.status_unchanged) notes.push(`The status was not changed: ${res.status_unchanged}`);
  if (res.patch && Object.keys(res.patch).length) notes.push("The other changes were made and show \"via Claude\" on the timeline.");
  if (!drafted && !Object.keys(res.patch).length) notes.push("Nothing needed changing: the ticket already was as the macro sets it.");
  return toolJson({
    number: n,
    macro: { id: r.macro.id, name: r.macro.title },
    changed: Object.keys(res.patch),
    reply: drafted ? { saved_as: "draft", draft_id: res.draft_id, sent: false } : null,
    ...(res.status_unchanged ? { status_unchanged: res.status_unchanged } : {}),
    status: fresh?.status,
    priority: fresh?.priority,
    team: fresh?.team_name ?? null,
    tags: fresh?.tags ?? [],
    note: notes.join(" "),
    url: `${ctx.origin}/desk/tickets/${n}`,
  });
}

// --- Categories, automations and recurring tickets (1.20.16) --------------------------------------
// Read, and drafts a person publishes (lib/helpdesk/category-drafts, automations, recurring; the
// model of 1.20.14's checklist drafts). Validation is Desk settings' own; nothing goes live, is
// switched on, deleted or merged here.

const settingsUrl = (ctx: Ctx, page: "categories" | "automations" | "recurring", id?: number) => `${ctx.origin}/desk/settings/${page}${id ? `?id=${id}` : ""}`;

function draftStatus(t: { published?: boolean; draft?: unknown }, live: string): string {
  return t.published === false ? "draft from Claude (not published)" : t.draft ? `${live}, with changes from Claude waiting for review` : live;
}

async function listCategoriesTool(user: User, ctx: Ctx) {
  const { categoryTree } = await import("../helpdesk/categories");
  const tree = await categoryTree();
  const manages = await hdCan(user, "settings.manage");
  const out: Record<string, unknown> = {
    categories: tree.map((c) => ({
      id: c.id,
      name: c.name,
      ...(c.archived ? { archived: true } : {}),
      subcategories: c.subcategories.map((x) => ({ id: x.id, name: x.name, ...(x.archived ? { archived: true } : {}) })),
    })),
    note: "Archived entries stay on old tickets and can't be set. Only listed names can be set on a ticket.",
  };
  if (manages) {
    const { getCategoryDraft } = await import("../helpdesk/category-drafts");
    const { categoryChangeLine } = await import("../helpdesk/category-drafts-shared");
    const d = await getCategoryDraft();
    out.draft = d ? { changes: d.changes.map(categoryChangeLine), asked_by: d.draft_by_name, at: d.draft_at, status: "waiting for review (not published)" } : null;
    out.edit_url = settingsUrl(ctx, "categories");
  }
  return toolJson(out);
}

async function draftCategoriesTool(user: User, a: Args, ctx: Ctx) {
  const { HdCategoryError } = await import("../helpdesk/categories");
  const { saveCategoryDraft } = await import("../helpdesk/category-drafts");
  const { categoryChangeLine, CATEGORY_DRAFT_LIMITS } = await import("../helpdesk/category-drafts-shared");
  if (!Array.isArray(a.changes) || a.changes.length > CATEGORY_DRAFT_LIMITS.changes) {
    return refuse(`Send the changes as a list of up to ${CATEGORY_DRAFT_LIMITS.changes}. Nothing was saved.`);
  }
  let r: Awaited<ReturnType<typeof saveCategoryDraft>>;
  try {
    r = await saveCategoryDraft(a.changes, { id: user.id, name: user.name || user.username, via: "mcp" });
  } catch (e) {
    if (e instanceof HdCategoryError) return refuse(`${e.message} Nothing was saved.`);
    throw e;
  }
  await auditMcp(user, ctx, r.kind === "new" ? "helpdesk.category_draft.created" : "helpdesk.category_draft.updated", { type: "helpdesk_category", id: null, label: "Category list changes" }, {
    changes: r.draft.changes.length,
    draft: true,
  });
  return toolJson({
    saved: "draft of changes (the category list is unchanged)",
    changes: r.draft.changes.map(categoryChangeLine),
    note: "Agents keep picking from the list as it is. A person who manages categories reviews the changes, edits them if needed and publishes or discards them in Desk settings → Categories. A published rename renames it on every ticket that has it.",
    edit_url: settingsUrl(ctx, "categories"),
  });
}

const AUTOMATION_LIST_MAX = 200;

async function listAutomationsTool(user: User, a: Args, ctx: Ctx) {
  const au = await import("../helpdesk/automations");
  if (a.id !== undefined && a.id !== null) {
    const id = Number(a.id);
    const found = Number.isSafeInteger(id) && id > 0 ? await au.getAutomation(id) : undefined;
    // 1.20.23: only one of the person's desk departments' rules, or All departments'.
    const r = found ? (await deptRowsFor(user, "automations", [found]))[0] : undefined;
    if (!r) return refuse(`No automation with id ${a.id}.`);
    const words = await au.automationInWords(r);
    return toolJson({
      id: r.id,
      name: r.name,
      desk_department: r.desk_department,
      can_change: r.can_change,
      status: draftStatus(r, r.active ? "on" : "off"),
      event: r.event,
      conditions: r.conditions,
      actions: r.actions,
      in_words: words,
      draft: r.draft ? { ...r.draft, in_words: await au.automationInWords(r.draft), asked_by: r.draft_by_name, at: r.draft_at } : null,
      edit_url: settingsUrl(ctx, "automations", r.id),
    });
  }
  const rules = (await deptRowsFor(user, "automations", await au.listAutomations())).slice(0, AUTOMATION_LIST_MAX);
  // Review fix: one batch of name lookups for every rule (not a handful of queries per rule).
  const words = await au.automationsInWords(rules);
  const out = rules.map((r, i) => ({
    id: r.id,
    order: i + 1,
    name: r.name,
    desk_department: r.desk_department,
    can_change: r.can_change,
    status: draftStatus(r, r.active ? "on" : "off"),
    when: words[i].when,
    if: words[i].if,
    then: words[i].then,
  }));
  return toolJson({
    automations: out,
    note: "Rules run in this order, first to last, on each event. A rule runs on tickets of its desk department's teams (All departments: every ticket); a ticket with no team counts as the default desk department's.",
    edit_url: settingsUrl(ctx, "automations"),
  });
}

async function draftAutomationTool(user: User, a: Args, ctx: Ctx) {
  const au = await import("../helpdesk/automations");
  const input: Record<string, unknown> = {};
  for (const k of ["name", "event", "conditions", "actions"]) if (a[k] !== undefined) input[k] = a[k];
  let id: number | undefined;
  if (a.id !== undefined && a.id !== null) {
    id = Number(a.id);
    if (!Number.isSafeInteger(id) || id <= 0) return refuse(`No automation with id ${a.id}.`);
  }
  // 1.20.23: changes only to a rule of a desk department they manage; a new one in their starting department.
  let dept: number | null | undefined;
  if (id !== undefined) {
    const cur = await au.getAutomation(id);
    if (!cur || !(await deptRowsFor(user, "automations", [cur])).length) return refuse(`No automation with id ${a.id}. Nothing was saved.`);
    const notMine = await deptDraftRefusal(user, "automations", cur.desk_department_id);
    if (notMine) return refuse(notMine);
  } else {
    const d = await newDraftDept(user, "automations");
    if ("error" in d) return refuse(d.error);
    dept = d.value;
  }
  let r: Awaited<ReturnType<typeof au.saveAutomationDraft>>;
  try {
    r = await au.saveAutomationDraft(input, { id: user.id, name: user.name || user.username, via: "mcp" }, id, dept);
  } catch (e) {
    if (e instanceof au.AutomationDraftError) return refuse(`${e.message} Nothing was saved.`);
    throw e;
  }
  const rule = r.automation;
  const shape = rule.draft ?? rule;
  const details = { event: shape.event, conditions: shape.conditions, actions: Object.keys(shape.actions ?? {}), draft: true };
  if (r.kind === "new") await auditMcp(user, ctx, "helpdesk.automation.created", { type: "helpdesk_automation", id: rule.id, label: rule.name }, { ...details, active: 0, published: false });
  else await auditMcp(user, ctx, "helpdesk.automation.updated", { type: "helpdesk_automation", id: rule.id, label: rule.name }, { changed: ["draft"], ...details, published: rule.published });
  const words = await au.automationInWords(shape);
  return toolJson({
    id: rule.id,
    name: shape.name,
    saved: r.kind === "changes" ? "draft of changes (the live rule keeps running unchanged)" : "draft (switched off, not published)",
    published: rule.published,
    active: rule.active === 1,
    in_words: words,
    note:
      r.kind === "changes"
        ? "The rule keeps running as it is. A person who manages automations reviews the changes and publishes or discards them in Desk settings → Automations."
        : "It is off and never runs until a person who manages automations reviews it and publishes it in Desk settings → Automations, which switches it on.",
    edit_url: settingsUrl(ctx, "automations", rule.id),
  });
}

const RECURRING_LIST_MAX = 200;

async function listRecurringTool(user: User, a: Args, ctx: Ctx) {
  const rc = await import("../helpdesk/recurring");
  const { patternSummary } = await import("../helpdesk/recurring-shared");
  const su = toSessionUser(user);
  if (a.id !== undefined && a.id !== null) {
    const id = Number(a.id);
    const s = Number.isSafeInteger(id) && id > 0 && id < 2 ** 31 ? await rc.getRecurring(id) : undefined;
    if (!s || !(await rc.canManageRecurringTeam(su, s.team_id))) return refuse(`No recurring ticket with id ${a.id} that you manage.`);
    return toolJson({
      id: s.id,
      status: draftStatus(s, s.enabled ? "on" : "paused"),
      ...rc.draftOfSchedule(s),
      in_words: await rc.recurringInWords(rc.draftOfSchedule(s)),
      next_run_at: s.next_run_at,
      draft: s.draft ? { ...s.draft, in_words: await rc.recurringInWords(s.draft), asked_by: s.draft_by_name, at: s.draft_at } : null,
      edit_url: settingsUrl(ctx, "recurring", s.id),
    });
  }
  const [all, teams] = await Promise.all([rc.canManageAllRecurring(su), rc.recurringTeams(su)]);
  const schedules = (await rc.listRecurring(all ? "all" : teams.map((t) => t.id))).slice(0, RECURRING_LIST_MAX);
  // 1.20.23 review L1: only the request types of the caller's desk departments and All departments'.
  const dd = await import("../helpdesk/desk-departments");
  const types = (await dd.requestTypeOptions(await dd.deskDepartmentScope(su))).map(({ id, title, team_id }) => ({ id, title, team_id }));
  return toolJson({
    recurring: schedules.map((s) => ({
      id: s.id,
      subject: s.subject,
      team: s.team_name,
      repeats: patternSummary(s.pattern),
      status: draftStatus(s, s.enabled ? "on" : "paused"),
      next_run_at: s.enabled ? s.next_run_at : null,
    })),
    teams: teams.map((t) => ({ id: t.id, name: t.name, timezone: t.timezone, members: t.members })),
    request_types: types,
    edit_url: settingsUrl(ctx, "recurring"),
  });
}

async function draftRecurringTool(user: User, a: Args, ctx: Ctx) {
  const rc = await import("../helpdesk/recurring");
  const su = toSessionUser(user);
  const input: Record<string, unknown> = {};
  for (const k of ["team_id", "subject", "body", "priority", "request_type_id", "assign_mode", "assignee_id", "due_business_days", "pattern", "holiday_rule", "timezone"]) {
    if (a[k] !== undefined) input[k] = a[k];
  }
  let live: import("../helpdesk/recurring-shared").HdRecurring | undefined;
  let id: number | undefined;
  if (a.id !== undefined && a.id !== null) {
    id = Number(a.id);
    live = Number.isSafeInteger(id) && id > 0 && id < 2 ** 31 ? await rc.getRecurring(id) : undefined;
    if (!live || !(await rc.canManageRecurringTeam(su, live.team_id))) return refuse(`No recurring ticket with id ${a.id} that you manage. Nothing was saved.`);
  }
  let r: Awaited<ReturnType<typeof rc.saveRecurringDraft>>;
  try {
    const draft = await rc.checkRecurringDraft(input, live ? live.draft ?? rc.draftOfSchedule(live) : undefined);
    if (!(await rc.canManageRecurringTeam(su, draft.team_id))) return refuse("You can only schedule tickets for teams you lead (403). Nothing was saved.");
    r = await rc.saveRecurringDraft(draft, { id: user.id, name: user.name || user.username, via: "mcp" }, id);
  } catch (e) {
    if (e instanceof rc.RecurringDraftError) return refuse(`${e.message} Nothing was saved.`);
    throw e;
  }
  const s = r.schedule;
  const shape = s.draft ?? rc.draftOfSchedule(s);
  const { scheduleTitle } = await import("../helpdesk/recurring-shared");
  const details = { team_id: shape.team_id, pattern: shape.pattern, draft: true };
  if (r.kind === "new") await auditMcp(user, ctx, "helpdesk.recurring.created", { type: "helpdesk_recurring", id: s.id, label: scheduleTitle(shape.subject) }, { ...details, enabled: false, published: false });
  else await auditMcp(user, ctx, "helpdesk.recurring.updated", { type: "helpdesk_recurring", id: s.id, label: scheduleTitle(s.subject) }, { changed: ["draft"], ...details, published: s.published });
  return toolJson({
    id: s.id,
    subject: shape.subject,
    saved: r.kind === "changes" ? "draft of changes (the live schedule keeps running unchanged)" : "draft (paused, not published)",
    published: s.published,
    enabled: s.enabled,
    in_words: await rc.recurringInWords(shape),
    note:
      r.kind === "changes"
        ? "The schedule keeps opening tickets as it is. A person who manages it reviews the changes and publishes or discards them in Desk settings → Recurring tickets."
        : "It is paused and opens no ticket until a person who manages the team's schedules reviews it and publishes it in Desk settings → Recurring tickets, which switches it on.",
    edit_url: settingsUrl(ctx, "recurring", s.id),
  });
}
