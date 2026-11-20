// Helpdesk 1.20.28: how the desk lays out a ticket's conversation. Pure and
// client-safe; the desk's ticket pane (components/helpdesk/desk/ticket/
// Conversation) and the tests read it.
//
//   Activity lines. A field change (priority, owner, team, category,
//   sub-category, custom fields, a rename; lib/helpdesk/tickets updateTicket)
//   is stored as an internal line with event 'change' and drawn as one muted
//   line like a status or CC line, never as a note card. An automation's
//   change names the rule (its author is "Automation: <rule>") with a bot
//   icon. A note someone wrote, an automation's own "add an internal note"
//   text included, stays a note card. Internal lines stay agents-only: the
//   requester's reads never carry them (lib/helpdesk/access requesterMessages).
//
//   Order and fold. Newest first (the default, composer on top) shows the
//   newest requester message and the newest agent reply, plus everything
//   newer than the older of the two; everything older folds behind "Show N
//   earlier messages" (N counts messages, not lines). Oldest first is the
//   pre-1.20.28 layout: composer at the bottom, nothing folded. Each agent's
//   choice is their desk preference (lib/helpdesk/notify-prefs ticket_order).
//
//   Files. A message's files are a list under it (STYLEGUIDE §Helpdesk: the
//   desk, "Files under a message"): a coloured type square, the name, the
//   size and Download. A picture the formatted email draws itself (its
//   attachment is `inline`, lib/helpdesk/email-html markInlineAttachments) is
//   left out of the list while the email shows formatted.

import { mdInline } from "./md-inline";
import type { HdAttachment, HdMessage } from "./types";

/** hd_messages.event of a field-change line (lib/helpdesk/tickets updateTicket). */
export const HD_CHANGE_EVENT = "change";
/** The author name an automation writes with (lib/helpdesk/automations applyRule). */
export const HD_AUTOMATION_PREFIX = "Automation: ";

export const HD_TICKET_ORDERS = ["newest", "oldest"] as const;
export type HdTicketOrder = (typeof HD_TICKET_ORDERS)[number];
export const HD_TICKET_ORDER_LABEL: Record<HdTicketOrder, string> = { newest: "Newest first", oldest: "Oldest first" };
export const HD_TICKET_ORDER_HINT: Record<HdTicketOrder, string> = { newest: "Reply box on top", oldest: "Reply box at the bottom" };

type Line = Pick<HdMessage, "kind" | "body" | "author_name"> & { event?: string | null };

/** A field change updateTicket wrote: an activity line, not a note card. */
export function isChangeLine(m: Line): boolean {
  return m.kind === "internal" && m.event === HD_CHANGE_EVENT;
}

/** Drawn as a line (status, CC, change and share lines), so not counted as a message. */
export function isActivityLine(m: Line): boolean {
  return m.kind === "system" || (m.kind === "internal" && (m.event === HD_CHANGE_EVENT || m.event === "share"));
}

/** The rule's name when an automation wrote it, else null. */
export function automationRule(authorName: string | null | undefined): string | null {
  const n = String(authorName ?? "");
  if (!n.startsWith(HD_AUTOMATION_PREFIX)) return null;
  return n.slice(HD_AUTOMATION_PREFIX.length).trim() || null;
}

/**
 * A change line as who and what: `actor` the person's or the rule's name as typed, `rest` the Markdown after the
 * author's escaped name ("changed the priority from Normal to Low"). Null when the body doesn't start with the author
 * (an older line, "Someone ..."): the caller shows the whole body.
 */
export function splitChangeLine(m: Line): { actor: string; automation: boolean; rest: string } | null {
  const name = String(m.author_name ?? "");
  // A status line (kind system) carries the name as typed, as the requester's views show it; a change line escapes it.
  const prefix = m.kind === "system" ? name : mdInline(name);
  if (!prefix || !m.body.startsWith(`${prefix} `)) return null;
  const rule = automationRule(name);
  return { actor: rule ?? name, automation: rule !== null, rest: m.body.slice(prefix.length + 1) };
}

/**
 * A change line's Markdown as the text it stands for. The line is written by the server alone: plain words and values
 * escaped by mdInline, so undoing those escapes (and dropping its invisible word joiners) gives exactly the values'
 * characters. Shown as text, never parsed: nothing in a value can become a link or markup.
 */
export function plainChangeText(md: string): string {
  return md.replace(/\u2060/g, "").replace(/\\([\\`*_[\]<>~&|{}:#+=.)-])/g, "$1");
}

export type HdActivityIcon =
  | "bot"
  | "rename"
  | "team"
  | "assign"
  | "unassign"
  | "category"
  | "priority"
  | "field"
  | "event"
  | "park"
  | "language"
  | "solve"
  | "cc-add"
  | "cc-remove"
  | "requester"
  | "status"
  | "files"
  | "other";

/** The icon an activity line carries (cheap: the verb after the name; never decides what the line is). */
export function activityIcon(m: Line): HdActivityIcon {
  if (automationRule(m.author_name)) return "bot";
  const split = isChangeLine(m) ? splitChangeLine(m) : null;
  const what = split ? split.rest : m.body;
  if (m.kind === "system") {
    if (/ as CC\.$/.test(m.body)) return "cc-add";
    if (/ from CC\.$| left the CC list\.$/.test(m.body)) return "cc-remove";
    if (/attachments? (?:was|were) not added/.test(m.body)) return "files";
    return "status";
  }
  // 1.20.34 (lib/helpdesk/desk-calendar-park): the desk's own parking lines ("Woke for the event on …", "Parked until …").
  if (!split && /^(?:Woke\b|Parked until |Not parked: |The event moved to .* so the ticket now wakes|The event was cancelled\. Close this ticket|(?:The ticket moved to another team|The desk's prep window changed|Its team's business calendar changed), so the ticket now wakes)/.test(m.body)) return "park";
  if (!split) return "other";
  if (/^renamed the ticket/.test(what)) return "rename";
  if (/^(?:moved the ticket to|took the ticket out of its team)/.test(what)) return "team";
  if (/^unassigned the ticket/.test(what)) return "unassign";
  if (/^(?:assigned the ticket to|took the ticket)/.test(what)) return "assign";
  // 1.20.33 (lib/helpdesk/requester-change): "changed the requester from A to B", "set the requester to B".
  if (/^(?:changed|set) the requester\b/.test(what)) return "requester";
  if (/^(?:set|cleared) the (?:sub-)?category/.test(what)) return "category";
  if (/^changed the priority/.test(what)) return "priority";
  if (/^(?:marked the event setup|added an event|changed the event|removed the event)/.test(what)) return "event";
  if (/^(?:parked the ticket until|woke the ticket|changed the prep window|ended the parking)/.test(what)) return "park";
  if (/^(?:changed|set|cleared) the language/.test(what)) return "language";
  if (/^filled in the solve details/.test(what)) return "solve";
  if (/^(?:set|cleared) /.test(what)) return "field";
  return "other";
}

/** Who a public message is from, for newest first's fold. */
export type HdMessageSide = "requester" | "agent" | "other";

/** Through these an agent writes in the desk (a person's desk reply, Claude, the API). */
const AGENT_VIAS = new Set(["desk", "mcp", "api"]);

/**
 * The side of a public message, for the fold (1.20.28 review):
 *   - "agent": a system send (an automation's macro reply, an auto-acknowledgement: author null, via 'system'),
 *     or someone other than the requester writing as an agent (a team member, or through the desk, Claude or the
 *     API);
 *   - "requester": the requester's account, or (no account) an email from the requester's own address;
 *   - "other": anyone else, such as a CC replying by email or Get help, or the requester of a ticket merged in.
 * Only "requester" and "agent" anchor the fold.
 */
export function messageSide(
  m: Pick<HdMessage, "kind" | "author_id" | "author_email" | "via"> & { author_team_name?: string | null },
  who: { requesterId: number | null; requesterEmail?: string | null }
): HdMessageSide {
  if (m.via === "system") return "agent";
  if (m.author_id !== null) {
    if (who.requesterId !== null && m.author_id === who.requesterId) return "requester";
    return m.author_team_name || AGENT_VIAS.has(m.via) ? "agent" : "other";
  }
  const from = String(m.author_email ?? "").trim().toLowerCase();
  const requester = String(who.requesterEmail ?? "").trim().toLowerCase();
  // An email with no account behind it: the requester's own address, or (an older row without one) theirs too.
  return !from || !requester || from === requester ? "requester" : "other";
}

/**
 * Newest first's fold, over the messages oldest first: `from` is the index of the first message shown (the older of
 * the newest requester message and the newest agent reply); everything before it folds. `folded` counts the messages
 * (cards, not lines) folded. Nothing folds when that would hide no message.
 */
export function foldPlan(messages: HdMessage[], who: { requesterId: number | null; requesterEmail?: string | null }): { from: number; folded: number } {
  let lastRequester = -1;
  let lastAgent = -1;
  messages.forEach((m, i) => {
    if (m.kind !== "public") return;
    const side = messageSide(m, who);
    if (side === "agent") lastAgent = i;
    else if (side === "requester") lastRequester = i;
  });
  const from = lastRequester < 0 ? lastAgent : lastAgent < 0 ? lastRequester : Math.min(lastRequester, lastAgent);
  if (from <= 0) return { from: 0, folded: 0 };
  const folded = messages.slice(0, from).filter((m) => !isActivityLine(m)).length;
  return folded ? { from, folded } : { from: 0, folded: 0 };
}

/**
 * The messages newest first folds as the ticket opens (their ids): fixed from then on, so a message that arrives,
 * is approved after review (it moves to the end) or is merged in later is never folded away.
 */
export function foldedIds(messages: HdMessage[], who: { requesterId: number | null; requesterEmail?: string | null }): Set<number> {
  const plan = foldPlan(messages, who);
  return new Set(plan.folded ? messages.slice(0, plan.from).map((m) => m.id) : []);
}

/** "Show 6 earlier messages". */
export function foldLabel(n: number): string {
  return `Show ${n} earlier ${n === 1 ? "message" : "messages"}`;
}

// --- Files ------------------------------------------------------------------------------

export type HdFileTone = "red" | "blue" | "green" | "orange" | "violet" | "sky" | "slate";

const KINDS: [RegExp, string, HdFileTone][] = [
  [/\.pdf$/, "PDF", "red"],
  [/\.(?:docx?|odt|rtf)$/, "DOC", "blue"],
  [/\.(?:xlsx?|ods|csv)$/, "XLS", "green"],
  [/\.(?:pptx?|odp)$/, "PPT", "orange"],
  [/\.(?:eml|msg)$/, "EML", "violet"],
  [/\.(?:png|jpe?g|gif|webp|heic)$/, "IMG", "sky"],
  [/\.zip$/, "ZIP", "slate"],
  [/\.(?:mp4|mov|webm)$/, "VID", "slate"],
  [/\.(?:mp3|m4a|wav)$/, "AUD", "slate"],
  [/\.(?:txt|log|md|json)$/, "TXT", "slate"],
];

/** The type square of a file: a short label and a tone, from its name (then its stored type). */
export function fileKind(a: Pick<HdAttachment, "name" | "type">): { label: string; tone: HdFileTone } {
  const name = a.name.toLowerCase();
  for (const [re, label, tone] of KINDS) if (re.test(name)) return { label, tone };
  if (a.type.startsWith("image/")) return { label: "IMG", tone: "sky" };
  if (a.type === "application/pdf") return { label: "PDF", tone: "red" };
  return { label: "FILE", tone: "slate" };
}

/** A picture the desk serves inline (the same rule as the attachments route). */
export function isPicture(a: Pick<HdAttachment, "type">): boolean {
  return /^image\/(png|jpeg|gif|webp)$/.test(a.type);
}

/** The files a message lists: its inline pictures are left out while its email shows formatted. */
export function listedFiles(attachments: HdAttachment[], formatted: boolean): HdAttachment[] {
  return formatted ? attachments.filter((a) => a.inline !== true) : attachments;
}
