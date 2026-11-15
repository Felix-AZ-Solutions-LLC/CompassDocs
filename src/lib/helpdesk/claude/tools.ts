// Helpdesk 1.20.0: the tools Claude in the desk calls, run AS THE AGENT.
// The rules are the desk's and the Claude connector's own: canWorkTicket for
// every ticket (a ticket outside the agent's queues answers like one that
// does not exist), listTickets with the agent's scope for search, the
// connector's canned responses and asset tools (lib/mcp/helpdesk-tools
// callHelpdeskTool), the knowledge base's answer retrieval with the agent's
// own space scope, and the checklist view. On top, a team Claude is switched
// off for is never read or listed.
//
// Every result is quoted data (prompt.dataBlock / ticketBlock): escaped, with
// trust="untrusted" and who wrote each part, so text a requester or anyone
// else wrote can never pass for an instruction.
//
// Nothing here writes: a draft or a proposed change comes back as a card for
// the agent, who applies it through the desk's own routes with their own
// session (newbie review, required checklists, legal hold and every other
// rule apply there). 1.20.14: so are checklist ticks (Apply sends each item
// through the desk's own tick route) and checklist drafts (Save as draft
// saves an unpublished draft that someone publishes in Desk settings), and
// 1.20.15 macros (Apply sends it through the desk's own macro route, whose
// checks propose_macro runs first as a dry run), and 1.20.16 drafts of
// category changes, automations and recurring tickets (checked as Desk
// settings would; Save as draft sends the card's id to the desk's own
// settings route, which saves it unpublished, off or paused). Proposals are checked with the same permission
// functions the desk's PATCH uses, so Claude is told at once when the agent
// could not apply them. Server-only.

import "server-only";
import type { SessionUser, User } from "../../types";
import { callHelpdeskTool } from "../../mcp/helpdesk-tools";
import { canWorkTicket } from "../access";
import { hdCan } from "../roles";
import { getTicketByNumber, HdTicketError, listTickets, parseTicketNumber, validateTicketPatch } from "../tickets";
import { HD_PRIORITY_LABEL, HD_STATUS_LABEL, type HdTicket } from "../types";
import { DRAFT_LIMITS } from "../drafts";
import { teamAllowed } from "./config";
import { ticketForClaude } from "./context";
import { dataBlock, quote, quoteJson, ticketBlock } from "./prompt";
import type { ClaudeCard, ClaudeDeskConfig, ClaudeSource, ClaudeStreamEvent } from "./shared";

export interface ToolCtx {
  user: User;
  session: SessionUser;
  origin: string;
  ip: string | null;
  cfg: ClaudeDeskConfig;
  /** The chat this turn belongs to (its linked tickets feed the internal-note check). */
  chatId: number;
  /** The ticket open in the desk, when the agent works it. */
  ticket: HdTicket | null;
  /** The agent's explicit say-so (the panel's "May quote internal notes" switch) for this turn. */
  includeNotes: boolean;
  /** Ticket ids this turn touched (read, listed, a card's target): linked to the chat for erasure. */
  touched: Set<number>;
  /** Internal notes Claude has seen this turn. */
  notesSeen: string[];
}

type Activity = Extract<ClaudeStreamEvent, { type: "activity" }>;

export interface ToolOutcome {
  /** The tool_result content Claude reads. */
  content: string;
  isError: boolean;
  activity?: Omit<Activity, "type">;
  /** Candidate source chips (the turn keeps those the answer names). */
  sources?: ClaudeSource[];
  /** A card for the agent (created and numbered by the turn). */
  card?: { kind: ClaudeCard["kind"]; ticketId: number | null; payload: Record<string, unknown> };
}

const ok = (content: string, extra: Omit<ToolOutcome, "content" | "isError"> = {}): ToolOutcome => ({ content, isError: false, ...extra });
const done = (value: unknown, extra: Omit<ToolOutcome, "content" | "isError"> = {}): ToolOutcome => ({ content: JSON.stringify(value), isError: false, ...extra });
const fail = (text: string, extra: Omit<ToolOutcome, "content" | "isError"> = {}): ToolOutcome => ({ content: text, isError: true, ...extra });

const notFound = (n: unknown) => `No ticket #${String(n)} that you can see.`;
const teamOff = (n: number) => `Claude is switched off for #${n}'s team (Desk settings → Claude in the desk). Work on it without Claude.`;

/** Unwrap a connector tool's answer: its text, and whether it refused. */
async function viaConnector(ctx: ToolCtx, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; out: any }> {
  const r = (await callHelpdeskTool(ctx.user, name, args, { origin: ctx.origin, ip: ctx.ip })) as { content: { text: string }[]; isError: boolean };
  const text = r.content?.[0]?.text ?? "";
  let out: any = null;
  try {
    out = JSON.parse(text);
  } catch {
    /* a sentence */
  }
  return { isError: r.isError === true, text, out };
}

/** A ticket the agent works and Claude may touch (its team switched on); else the refusal sentence. */
async function workTicket(ctx: ToolCtx, raw: unknown): Promise<HdTicket | string> {
  const n = parseTicketNumber(typeof raw === "number" || typeof raw === "string" ? raw : "");
  if (!n) return notFound(raw);
  const t = await getTicketByNumber(n);
  if (!t || !(await canWorkTicket(ctx.user, t))) return notFound(raw);
  if (!teamAllowed(ctx.cfg, t.team_id)) return teamOff(t.number);
  ctx.touched.add(t.id);
  return t;
}

const ticketSource = (n: number): ClaudeSource => ({ kind: "ticket", label: `#${n}`, href: `/desk/tickets/${n}` });

// --- The tools -----------------------------------------------------------------------------

export async function runDeskTool(name: string, input: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "read_ticket":
        return await readTicket(input, ctx);
      case "search_tickets":
        return await searchTickets(input, ctx);
      case "search_articles":
        return await searchArticles(input, ctx);
      case "asset_lookup":
        return await assetLookup(input, ctx);
      case "list_canned_responses":
        return await cannedResponses(input, ctx);
      case "list_checklists":
        return await listChecklists(input, ctx);
      case "suggest_checklist":
        return await suggestChecklist(input, ctx);
      case "propose_checklist_ticks":
        return await proposeTicks(input, ctx);
      case "draft_checklist":
        return await draftChecklist(input, ctx);
      case "list_macros":
        return await listMacros(input, ctx);
      case "list_desk_settings":
        return await listDeskSettings(input, ctx);
      case "draft_categories":
        return await draftCategories(input, ctx);
      case "draft_automation":
        return await draftAutomation(input, ctx);
      case "draft_recurring":
        return await draftRecurring(input, ctx);
      case "propose_macro":
        return await proposeMacro(input, ctx);
      case "propose_ticket_change":
        return await proposeChange(input, ctx);
      case "draft_reply":
        return await draft("reply", input, ctx);
      case "draft_internal_note":
        return await draft("note", input, ctx);
    }
  } catch (e) {
    if (e instanceof HdTicketError) return fail(e.message);
    throw e;
  }
  return fail(`Unknown tool: ${name}`);
}

async function readTicket(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const t = await workTicket(ctx, a.number);
  if (typeof t === "string") return fail(t);
  const { ticket, notes } = await ticketForClaude(ctx.user, t);
  ctx.notesSeen.push(...notes);
  return ok(ticketBlock(ticket), {
    activity: { label: ctx.ticket && ctx.ticket.id === t.id ? `Read #${t.number} again` : `Read #${t.number}`, icon: "ticket" },
    sources: [ticketSource(t.number)],
  });
}

async function searchTickets(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const query = String(a.query ?? "").trim().slice(0, 200);
  if (!query) return fail("Say what to search for (query).");
  // The desk's own queue search with the agent's scope (their teams' tickets and those assigned to them).
  const { rows } = await listTickets(ctx.user, { view: "all", q: query, limit: 40, sort: "updated" });
  const want = a.status === "solved" ? ["solved", "closed"] : a.status === "open" ? ["new", "open", "pending", "on_hold"] : null;
  const found = rows
    .filter((t) => !ctx.ticket || t.id !== ctx.ticket.id)
    .filter((t) => !want || want.includes(t.status))
    // The per-team switch by team id: a team Claude is off for is never listed, assigned or not.
    .filter((t) => teamAllowed(ctx.cfg, t.team_id))
    .slice(0, 12);
  for (const t of found) ctx.touched.add(t.id);
  const body = found.length
    ? found
        .map(
          (t) =>
            `<result number="${t.number}" status="${t.status}" team="${quote(t.team_name ?? "none")}" updated="${t.updated_at}">\n<subject written_by="requester">${quote(t.subject)}</subject>\n<requester>${quote(t.requester_name ?? "")}</requester>${t.tags?.length ? `\n<tags>${quote(t.tags.join(", "))}</tags>` : ""}\n</result>`
        )
        .join("\n")
    : "No matching tickets in the agent's queues.";
  return ok(dataBlock("search_results", { query, note: found.length ? "Read a ticket with read_ticket before relying on it." : "" }, body), {
    activity: { label: a.status === "solved" ? "Searched solved tickets" : "Searched tickets", icon: "search" },
    sources: found.map((t) => ticketSource(t.number)),
  });
}

async function searchArticles(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const query = String(a.query ?? "").trim().slice(0, 300);
  if (!query) return fail("Say what to look for (query).");
  // The knowledge base's own answer retrieval, with the agent's reading scope: published documents they can read.
  const [{ hybridRetrieveForAnswer }, { spaceScopeFor }, { findScopeFor }] = await Promise.all([
    import("../../embeddings"),
    import("../../access"),
    import("../../handbook-visibility"),
  ]);
  const docs = await hybridRetrieveForAnswer(query, 4, false, await spaceScopeFor(ctx.user), await findScopeFor(ctx.user));
  const body = docs.length
    ? docs.map((d) => `<article id="${d.id}" title="${quote(d.title).replace(/"/g, "&quot;")}" written_by="knowledge base author" url="${ctx.origin}/doc/${d.id}">\n${quote(d.content.slice(0, 2500))}\n</article>`).join("\n")
    : "No article the agent can read matches.";
  return ok(dataBlock("articles", { query }, body), {
    activity: { label: docs.length === 1 ? "Read 1 article" : `Read ${docs.length} articles`, icon: "book" },
    sources: docs.map((d) => ({ kind: "article" as const, label: d.title, href: `/doc/${d.id}` })),
  });
}

async function assetLookup(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const query = String(a.query ?? "").trim().slice(0, 120);
  const r = await viaConnector(ctx, "hd_asset_lookup", { query });
  if (r.isError) return fail(r.text);
  return ok(dataBlock("assets", { query, written_by: "the asset source (Snipe-IT)" }, quoteJson(r.out ?? r.text)), { activity: { label: `Checked ${query}`, icon: "package" } });
}

async function cannedResponses(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const args: Record<string, unknown> = { limit: 10 };
  if (typeof a.query === "string" && a.query.trim()) args.query = a.query.trim().slice(0, 200);
  if (ctx.ticket) args.number = ctx.ticket.number;
  const r = await viaConnector(ctx, "hd_canned_responses", args);
  if (r.isError) return fail(r.text);
  return ok(dataBlock("canned_responses", { written_by: "agents of this workspace (snippets to reuse)" }, quoteJson(r.out ?? r.text)), {
    activity: { label: "Looked at canned responses", icon: "message" },
  });
}

async function listChecklists(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const t = await workTicket(ctx, a.number);
  if (typeof t === "string") return fail(t);
  const { ticketChecklistView } = await import("../checklists");
  const v = await ticketChecklistView(ctx.session, t);
  const value = {
    // 1.20.14 (additive): checklist and item ids, for propose_checklist_ticks.
    checklists: v.checklists.map((c) => ({ id: c.id, name: c.name, done: c.done, total: c.total, required_open: c.required_open, items: c.items.map((i) => ({ id: i.id, title: i.title, done: i.done, required: !!i.required })) })),
    templates_that_can_be_added: v.can_edit ? v.templates : [],
    solve_blocked_by: v.solve_block,
  };
  return ok(dataBlock("checklists", { number: t.number, written_by: "agents and checklist templates" }, quoteJson(value)), {
    activity: { label: `Checked #${t.number}'s checklists`, icon: "list" },
  });
}

async function suggestChecklist(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const t = await workTicket(ctx, a.number);
  if (typeof t === "string") return fail(t);
  const { checklistsEditable, templateOptions, ticketChecklists } = await import("../checklists");
  if (!checklistsEditable(t)) return fail(t.merged_into ? "That ticket was merged; checklists go on the ticket it joined." : "That ticket is closed.");
  const tpl = (await templateOptions()).find((x) => x.id === Number(a.template_id));
  if (!tpl) return fail("No checklist template with that id. Call list_checklists for the ones that can be added.");
  if ((await ticketChecklists(t.id)).some((c) => c.name === tpl.name)) return fail(`#${t.number} already has the "${tpl.name}" checklist.`);
  return done(
    { suggested: true, applied: false, note: "The agent sees a card with Apply and Skip. Nothing was added." },
    {
      card: {
        kind: "checklist",
        ticketId: t.id,
        payload: { number: t.number, template_id: tpl.id, title: `Add the checklist "${tpl.name}"`, hint: String(a.reason ?? "").slice(0, 300) },
      },
    }
  );
}

/** 1.20.14: propose ticking or unticking items; the agent's Apply sends each through the desk's tick route. */
async function proposeTicks(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const t = await workTicket(ctx, a.number);
  if (typeof t === "string") return fail(t);
  const { checklistsEditable, ticketChecklists } = await import("../checklists");
  if (!checklistsEditable(t)) return fail(t.merged_into ? "That ticket was merged; its checklists can't change." : "That ticket is closed; its checklists can't change.");
  const raw = Array.isArray(a.items) ? (a.items as { id: number; done: boolean }[]) : [];
  if (!raw.length) return fail("Say which items to tick or untick (items).");
  if (raw.length > 50) return fail("Up to 50 items at once.");
  const lists = await ticketChecklists(t.id);
  const byId = new Map(lists.flatMap((c) => c.items.map((i) => [i.id, { ...i, checklist: c.name }] as const)));
  const items: { id: number; title: string; checklist: string; done: boolean; required: boolean }[] = [];
  for (const r of raw) {
    const it = byId.get(r.id);
    if (!it) return fail(`Item ${r.id} isn't on #${t.number}'s checklists. Read the ticket's checklists for the item ids.`);
    if (items.some((x) => x.id === r.id)) continue;
    if (it.done !== r.done) items.push({ id: it.id, title: it.title, checklist: it.checklist, done: r.done, required: it.required });
  }
  if (!items.length) return fail(`Those items on #${t.number} are already as asked. Nothing to propose.`);
  const ticks = items.filter((i) => i.done).length;
  const verb = ticks === items.length ? "Tick" : ticks === 0 ? "Untick" : "Update";
  const title = items.length === 1 ? `${verb} "${items[0].title}"` : `${verb} ${items.length} checklist items`;
  const hint = typeof a.when === "string" && a.when.trim() ? a.when.trim().slice(0, 200) : "";
  return done(
    { proposed: true, applied: false, change: title, note: "The agent sees a card with Apply and Skip. Nothing changed. Ticking never solves the ticket." },
    { card: { kind: "checklist", ticketId: t.id, payload: { action: "tick", number: t.number, items, title, hint } } }
  );
}

/** 1.20.14: a new checklist template, checked as Desk settings would; Save as draft on the card stores it unpublished. */
async function draftChecklist(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const { CHECKLIST_MANAGE_CAPS } = await import("../checklists-caps");
  let may = false;
  for (const c of CHECKLIST_MANAGE_CAPS) if (await hdCan(ctx.user, c)) may = true;
  if (!may) return fail("The agent can't manage checklists (desk role), so there is nowhere to save a checklist draft. Suggest they ask someone who manages checklists.");
  const { checkTemplateDraft, ChecklistError } = await import("../checklists");
  let draft: Awaited<ReturnType<typeof checkTemplateDraft>>;
  try {
    draft = await checkTemplateDraft({ name: a.name, items: a.items, request_type_ids: [] });
  } catch (e) {
    if (e instanceof ChecklistError) return fail(e.message);
    throw e;
  }
  const required = draft.items.filter((i) => i.required).length;
  const hint = `${draft.items.length} ${draft.items.length === 1 ? "item" : "items"}${required ? `, ${required} required` : ""}. Save as draft keeps it unpublished until someone publishes it in Desk settings.`;
  return done(
    { drafted: true, saved: false, note: "The agent sees the checklist on a card and clicks Save as draft. Nothing is published: someone who manages checklists publishes it in Desk settings → Checklists." },
    { card: { kind: "checklist", ticketId: null, payload: { action: "draft", number: ctx.ticket?.number ?? null, draft, title: `Checklist draft: ${draft.name}`, hint } } }
  );
}

// --- Drafts for Desk settings (1.20.16) ---------------------------------------------------------

const SETTINGS_TOOL: Record<string, string> = { categories: "hd_list_categories", automations: "hd_list_automations", recurring: "hd_list_recurring" };

/** The connector's read tools, as the agent (their desk role decides what they see). */
async function listDeskSettings(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const what = typeof a.what === "string" && SETTINGS_TOOL[a.what] ? (a.what as string) : null;
  if (!what) return fail("Say which: categories, automations or recurring.");
  const id = Number.isSafeInteger(a.id) && a.id > 0 ? a.id : null;
  const r = await viaConnector(ctx, SETTINGS_TOOL[what], id && what !== "categories" ? { id } : {});
  if (r.isError) return fail(/\(403\)$/.test(r.text) ? `The agent can't manage ${what} (desk role).` : r.text);
  const label = what === "categories" ? "Read the categories" : what === "automations" ? "Read the automations" : "Read the recurring tickets";
  return ok(dataBlock("desk_settings", { what, written_by: "admins of this workspace (settings)" }, quoteJson(r.out ?? r.text)), { activity: { label, icon: "list" } });
}

const CANT = (what: string) => `The agent can't manage ${what} (desk role), so there is nowhere to save this draft. Suggest they ask someone who manages ${what}.`;

/** Category list changes, checked as the Categories tab would; Save as draft adds them to the draft beside the list. */
async function draftCategories(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  if (!(await hdCan(ctx.user, "settings.manage"))) return fail(CANT("categories"));
  const { CATEGORY_DRAFT_LIMITS, categoryChangeLine } = await import("../category-drafts-shared");
  if (!Array.isArray(a.changes) || a.changes.length === 0 || a.changes.length > CATEGORY_DRAFT_LIMITS.changes) return fail(`Propose 1 to ${CATEGORY_DRAFT_LIMITS.changes} changes.`);
  const raw = (a.changes as Record<string, any>[]).map((c) =>
    c.kind === "rename"
      ? { kind: "rename", id: c.id, to: c.name }
      : c.kind === "add_subcategory"
        ? { kind: "add_subcategory", category: c.category, name: c.name }
        : { kind: c.kind, name: c.name, subcategories: Array.isArray(c.subcategories) ? c.subcategories : [] }
  );
  const { checkCategoryChanges } = await import("../category-drafts");
  const { HdCategoryError } = await import("../categories");
  let changes: Awaited<ReturnType<typeof checkCategoryChanges>>;
  try {
    changes = await checkCategoryChanges(raw);
  } catch (e) {
    if (e instanceof HdCategoryError) return fail(e.message);
    throw e;
  }
  const lines = changes.map(categoryChangeLine);
  return done(
    { drafted: true, saved: false, note: "The agent sees the changes on a card and clicks Save as draft. Nothing changes on the list: someone who manages categories publishes them in Desk settings → Categories." },
    {
      card: {
        kind: "change",
        ticketId: null,
        payload: {
          action: "settings_draft",
          target: "categories",
          target_id: null,
          number: ctx.ticket?.number ?? null,
          draft: { changes },
          title: changes.length === 1 ? "Category change" : `${changes.length} category changes`,
          hint: "Save as draft keeps the list as it is until someone publishes the changes in Desk settings.",
          lines,
        },
      },
    }
  );
}

/** Desk-shaped automation input (strict: empty means not used) → the settings API's shape. */
function automationInput(a: Record<string, any>): Record<string, unknown> {
  const c = (a.conditions ?? {}) as Record<string, any>;
  const x = (a.actions ?? {}) as Record<string, any>;
  const list = (v: unknown) => (Array.isArray(v) && v.length ? v : undefined);
  const conditions: Record<string, unknown> = {};
  for (const k of ["team_ids", "categories", "subcategories", "priorities", "request_type_ids", "sources", "keywords"]) if (list(c[k])) conditions[k] = c[k];
  const actions: Record<string, unknown> = {};
  for (const k of ["team_id", "assignee_id", "macro_id"]) if (Number.isInteger(x[k]) && x[k] > 0) actions[k] = x[k];
  for (const k of ["priority", "status", "category", "subcategory", "internal_note", "notify"]) if (typeof x[k] === "string" && x[k].trim()) actions[k] = x[k];
  if (list(x.tags_add)) actions.tags_add = x.tags_add;
  return { name: a.name, event: a.event, conditions, actions };
}

/** An automation rule, checked as Desk settings would; Save as draft saves it off (or beside the live rule). */
async function draftAutomation(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  if (!(await hdCan(ctx.user, "automations.manage"))) return fail(CANT("automations"));
  const au = await import("../automations");
  const id = Number.isSafeInteger(a.id) && a.id > 0 ? (a.id as number) : null;
  const live = id ? await au.getAutomation(id) : undefined;
  if (id && !live) return fail(`No automation with id ${id}. Call list_desk_settings for the rules.`);
  let draft: Awaited<ReturnType<typeof au.checkAutomationDraft>>;
  try {
    draft = await au.checkAutomationDraft(automationInput(a));
  } catch (e) {
    if (e instanceof au.AutomationDraftError) return fail(e.message);
    throw e;
  }
  const w = await au.automationInWords(draft);
  const lines = [`When ${w.when.charAt(0).toLowerCase()}${w.when.slice(1)}`, `If ${w.if.join(", and ")}`, `Then ${w.then.join(", ")}`];
  const hint = live
    ? `The rule keeps running as it is until someone publishes these changes in Desk settings.`
    : "Saved switched off. It runs only once someone publishes it in Desk settings.";
  return done(
    { drafted: true, saved: false, note: "The agent sees the rule on a card and clicks Save as draft. Nothing runs: someone who manages automations publishes it in Desk settings → Automations." },
    {
      card: {
        kind: "change",
        ticketId: null,
        payload: {
          action: "settings_draft",
          target: "automation",
          target_id: live?.id ?? null,
          number: ctx.ticket?.number ?? null,
          draft,
          title: live ? `Changes to the automation "${live.name}"` : `Automation draft: ${draft.name}`,
          hint,
          lines,
        },
      },
    }
  );
}

/** Desk-shaped recurring input (strict: 0 and empty mean not used) → the settings API's shape. */
function recurringInput(a: Record<string, any>): Record<string, unknown> {
  const p = (a.pattern ?? {}) as Record<string, any>;
  const pattern =
    p.kind === "weekly"
      ? { kind: "weekly", days: p.days, time: p.time }
      : p.kind === "monthly"
        ? p.mode === "day"
          ? { kind: "monthly", mode: "day", day: p.day, months: p.months ?? [], time: p.time }
          : { kind: "monthly", mode: "nth_weekday", nth: p.nth, weekday: p.weekday, months: p.months ?? [], time: p.time }
        : p.kind === "interval"
          ? { kind: "interval", unit: p.unit, every: p.every, start: p.start, time: p.time }
          : { kind: p.kind, time: p.time };
  return {
    team_id: a.team_id,
    subject: a.subject,
    body: a.body ?? "",
    priority: a.priority,
    request_type_id: Number.isInteger(a.request_type_id) && a.request_type_id > 0 ? a.request_type_id : null,
    assign_mode: Number.isInteger(a.assignee_id) && a.assignee_id > 0 ? "user" : "team_rules",
    assignee_id: Number.isInteger(a.assignee_id) && a.assignee_id > 0 ? a.assignee_id : null,
    due_business_days: Number.isInteger(a.due_business_days) && a.due_business_days > 0 ? a.due_business_days : null,
    pattern,
    holiday_rule: a.holiday_rule,
    timezone: typeof a.timezone === "string" ? a.timezone : "",
  };
}

/** A recurring schedule, checked as Desk settings would; Save as draft saves it paused (or beside the live one). */
async function draftRecurring(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const rc = await import("../recurring");
  const id = Number.isSafeInteger(a.id) && a.id > 0 ? (a.id as number) : null;
  const live = id ? await rc.getRecurring(id) : undefined;
  if (id && (!live || !(await rc.canManageRecurringTeam(ctx.session, live.team_id)))) return fail(`No recurring ticket with id ${id} that the agent manages. Call list_desk_settings for them.`);
  let draft: Awaited<ReturnType<typeof rc.checkRecurringDraft>>;
  try {
    draft = await rc.checkRecurringDraft(recurringInput(a));
  } catch (e) {
    if (e instanceof rc.RecurringDraftError) return fail(e.message);
    throw e;
  }
  if (!(await rc.canManageRecurringTeam(ctx.session, draft.team_id))) return fail(CANT("that team's recurring tickets"));
  const { scheduleTitle } = await import("../recurring-shared");
  return done(
    { drafted: true, saved: false, note: "The agent sees the schedule on a card and clicks Save as draft. Nothing opens: someone who manages the team's schedules publishes it in Desk settings → Recurring tickets." },
    {
      card: {
        kind: "change",
        ticketId: null,
        payload: {
          action: "settings_draft",
          target: "recurring",
          target_id: live?.id ?? null,
          number: ctx.ticket?.number ?? null,
          draft,
          title: live ? `Changes to the recurring ticket "${scheduleTitle(live.subject)}"` : `Recurring ticket draft: ${scheduleTitle(draft.subject)}`,
          hint: live ? "The schedule keeps running as it is until someone publishes these changes in Desk settings." : "Saved paused. It opens tickets only once someone publishes it in Desk settings.",
          lines: await rc.recurringInWords(draft),
        },
      },
    }
  );
}

/** 1.20.15: the macros the agent can apply on a ticket (the connector's hd_list_macros, as the agent). */
async function listMacros(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const t = await workTicket(ctx, a.number);
  if (typeof t === "string") return fail(t);
  const args: Record<string, unknown> = { number: t.number, limit: 30 };
  if (typeof a.query === "string" && a.query.trim()) args.query = a.query.trim().slice(0, 200);
  const r = await viaConnector(ctx, "hd_list_macros", args);
  if (r.isError) return fail(r.text);
  // The connector's note is about its own drafts rule; here the agent's Apply runs the macro.
  const value = r.out && typeof r.out === "object" ? { ...r.out, note: "Offer one with propose_macro. Applying it is the agent's click." } : r.text;
  return ok(dataBlock("macros", { number: t.number, written_by: "agents of this workspace (saved macros)" }, quoteJson(value)), {
    activity: { label: "Looked at macros", icon: "list" },
  });
}

/**
 * 1.20.15: propose a macro. The desk route's own checks run now as a dry run (as the agent: the
 * macro is theirs to use, every change within their role, required checklist items and "Before
 * you solve" if it solves, newbie review), so the card says what Apply will really do.
 */
async function proposeMacro(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const t = await workTicket(ctx, a.number);
  if (typeof t === "string") return fail(t);
  // Review fix: a macro card is only ever for the ticket the agent is looking at.
  if (!ctx.ticket || ctx.ticket.id !== t.id) {
    return fail(`A macro can be proposed only for the ticket the agent has open${ctx.ticket ? ` (#${ctx.ticket.number})` : ""}. Tell the agent to open #${t.number} and ask again there.`);
  }
  const macroId = Number(a.macro_id);
  const mac = await import("../macros");
  const r = Number.isSafeInteger(macroId) && macroId > 0 ? await mac.applyMacroAs(ctx.session, t.number, macroId, { dryRun: true, origin: ctx.origin }) : null;
  if (!r || (!r.ok && r.status === 404 && r.error === "Macro not found.")) return fail(`No macro with id ${String(a.macro_id)} that the agent can use. Call list_macros for the ones they can apply.`);
  if (!r.ok) {
    if (r.status === 404) return fail(notFound(a.number));
    if (r.merged) {
      const { mergedLock } = await import("../merge");
      return fail((await mergedLock(t)) ?? "That ticket was merged; a macro can't change it.");
    }
    if (r.status === 409 && r.error === "This ticket is closed.") return fail("That ticket is closed; a macro can't change it.");
    return fail(`The agent can't apply that macro on #${t.number}: ${r.error}`);
  }
  const res = r.result;
  // Whether the macro itself sets Solved or Closed (not whether this dry run would).
  const solves = r.macro.actions?.status === "solved" || r.macro.actions?.status === "closed";
  const lines: string[] = [];
  if (res.body) lines.push(res.held ? "Sends this reply for review first (your replies are checked by a lead)" : "Sends this reply to the requester as you");
  if (res.patch.status !== undefined) lines.push(`Sets the status to ${HD_STATUS_LABEL[res.patch.status]}`);
  else if (r.macro.actions?.status && r.macro.actions.status !== t.status && res.held) lines.push("Leaves the status as it is until your reply is approved");
  if (res.patch.priority !== undefined) lines.push(`Sets the priority to ${HD_PRIORITY_LABEL[res.patch.priority]}`);
  if (res.patch.team_id !== undefined) {
    const { listTeams } = await import("../teams");
    lines.push(`Moves it to the team ${(await listTeams()).find((x) => x.id === res.patch.team_id)?.name ?? "chosen"}`);
  }
  if (res.patch.tags) {
    const added = res.patch.tags.filter((x) => !t.tags.includes(x));
    if (added.length) lines.push(`Adds ${added.length === 1 ? "the tag" : "the tags"} ${added.join(", ")}`);
  }
  if (!lines.length) return fail(`That macro would change nothing on #${t.number}: it has no reply and the ticket already is as it sets it.`);
  const { hqOne } = await import("../db-core");
  const last = Number((await hqOne<{ id: number | null }>("SELECT max(id) AS id FROM hd_messages WHERE ticket_id = $1", [t.id]))?.id ?? 0);
  const title = `Apply the macro "${r.macro.title}" to #${t.number}`;
  if (!r.plan) return fail("That macro can't be proposed right now. Ask again.");
  return done(
    { proposed: true, applied: false, macro: r.macro.title, will: lines, note: "The agent sees a card with what it will do, and Apply and Skip. Nothing changed and nothing was sent." },
    {
      card: {
        kind: "change",
        ticketId: t.id,
        // The whole reply (review fix), and the plan Apply must match. Claude's own words (no `when`) are never on the card.
        payload: { action: "macro", number: t.number, macro_id: r.macro.id, title, lines, reply: res.body, last_message_id: last, solves, plan: r.plan },
      },
    }
  );
}

/** "Set status to Waiting on requester", "Set priority to High and add the tag vpn", … */
async function describeChange(t: HdTicket, p: ReturnType<typeof validateTicketPatch>): Promise<string> {
  const parts: string[] = [];
  if (p.status !== undefined) parts.push(`status to ${HD_STATUS_LABEL[p.status]}`);
  if (p.priority !== undefined) parts.push(`priority to ${HD_PRIORITY_LABEL[p.priority]}`);
  if (p.team_id !== undefined) {
    const { listTeams } = await import("../teams");
    const team = (await listTeams()).find((x) => x.id === p.team_id);
    parts.push(`team to ${team?.name ?? "none"}`);
  }
  if (p.assignee_id !== undefined) {
    const { hqOne } = await import("../db-core");
    const u = p.assignee_id ? await hqOne<{ name: string }>("SELECT coalesce(nullif(name, ''), username) AS name FROM users WHERE id = $1", [p.assignee_id]) : undefined;
    parts.push(`owner to ${u?.name ?? "nobody"}`);
  }
  let text = parts.length ? `Set ${parts.join(", ").replace(/, ([^,]*)$/, " and $1")}` : "";
  if (p.tags !== undefined) {
    const added = p.tags.filter((x) => !t.tags.includes(x));
    const removed = t.tags.filter((x) => !p.tags!.includes(x));
    const tagText = [added.length ? `add ${added.length === 1 ? "the tag" : "the tags"} ${added.join(", ")}` : "", removed.length ? `remove ${removed.join(", ")}` : ""].filter(Boolean).join(" and ");
    if (tagText) text = text ? `${text}, and ${tagText}` : tagText.charAt(0).toUpperCase() + tagText.slice(1);
  }
  return text || "No change";
}

async function proposeChange(a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const t = await workTicket(ctx, a.number);
  if (typeof t === "string") return fail(t);
  const raw: Record<string, unknown> = {};
  for (const k of ["status", "priority", "tags", "team_id", "assignee_id"] as const) if (a[k] !== null && a[k] !== undefined) raw[k] = a[k];
  const patch = validateTicketPatch(raw);
  // Leave out what would not change.
  if (patch.status === t.status) delete patch.status;
  if (patch.priority === t.priority) delete patch.priority;
  if (patch.team_id === t.team_id) delete patch.team_id;
  if (patch.assignee_id === t.assignee_id) delete patch.assignee_id;
  if (patch.tags && JSON.stringify([...patch.tags].sort()) === JSON.stringify([...t.tags].sort())) delete patch.tags;
  if (!Object.keys(patch).length) return fail(`That is how #${t.number} already is. Nothing to propose.`);
  // Solving goes through the desk's solve flow (time, maintenance, required checklists), which runs in the open ticket.
  if ((patch.status === "solved" || patch.status === "closed") && (!ctx.ticket || ctx.ticket.id !== t.id)) {
    return fail(`Solving or closing #${t.number} is done with the ticket open in the desk. Tell the agent to open #${t.number} to solve it there.`);
  }
  // The desk PATCH's own checks, so a proposal the agent could not apply is refused now.
  const { patchRefusal } = await import("../patch-caps");
  const refused = await patchRefusal(ctx.session, t, patch);
  if (refused) return fail(`The agent can't make that change: ${refused}`);
  if (patch.status !== undefined) {
    const { mergedLock } = await import("../merge");
    const locked = await mergedLock(t);
    if (locked) return fail(locked);
  }
  const title = await describeChange(t, patch);
  const hint = typeof a.when === "string" && a.when.trim() ? a.when.trim().slice(0, 200) : "";
  return done(
    { proposed: true, applied: false, change: title, note: "The agent sees a card with Apply and Skip. Nothing changed." },
    { card: { kind: "change", ticketId: t.id, payload: { number: t.number, patch, title, hint } } }
  );
}

/** Sentences of a text, normalised, long enough to count as quoting. */
export function sentences(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim().replace(/[.!?;]+$/, ""))
    .filter((s) => s.length >= 24);
}

/** Does `draft` quote any of `notes` (a sentence of 24 characters or more, word for word)? */
export function quotesNotes(draft: string, notes: readonly string[]): boolean {
  const d = draft.toLowerCase().replace(/\s+/g, " ");
  return notes.some((n) => sentences(n).some((s) => d.includes(s)));
}

async function draft(kind: "reply" | "note", a: Record<string, any>, ctx: ToolCtx): Promise<ToolOutcome> {
  const t = await workTicket(ctx, a.number);
  if (typeof t === "string") return fail(t);
  const teamId = t.team_id;
  if (kind === "reply") {
    // A draft is a reply in waiting: the agent must be able to reply at all (sent or held for review), as for the connector.
    if (!(await hdCan(ctx.user, "tickets.reply_public", { teamId })) && !(await hdCan(ctx.user, "tickets.reply_needs_review", { teamId }))) {
      return fail("The agent can't reply to the requester on this ticket (desk role).");
    }
  } else if (!(await hdCan(ctx.user, "tickets.internal_note", { teamId }))) {
    return fail("The agent can't add internal notes on this ticket (desk role).");
  }
  const { mergedLock } = await import("../merge");
  const locked = await mergedLock(t);
  if (locked) return fail(locked);
  const body = String(a.body ?? "").trim();
  if (!body) return fail("Write the draft (body).");
  if (body.length > DRAFT_LIMITS.body) return fail("The draft is too long.");
  if (kind === "reply" && !ctx.includeNotes) {
    // Internal notes stay out of a requester's reply unless the agent switched on "May quote internal notes":
    // the notes of every ticket this chat has touched, this turn's included, and of the target.
    const notes = [...ctx.notesSeen, ...(await (await import("./chats")).linkedInternalNotes(ctx.chatId, [...ctx.touched, t.id]))];
    if (quotesNotes(body, notes)) {
      return fail(
        "This reply quotes an internal note, which the requester must not see. Rewrite it without the note's text. If the agent wants the note in the reply, they switch on \"May quote internal notes\" and ask again."
      );
    }
  }
  // A draft written while other tickets were in view, or that names one, is not put in the box without a click.
  const others = [...ctx.touched].filter((id) => id !== t.id && (!ctx.ticket || id !== ctx.ticket.id));
  const namesOther = [...body.matchAll(/#0*(\d+)\b/g)].some((m) => Number(m[1]) !== t.number);
  const first = (t.requester_name || "").trim().split(/\s+/)[0];
  const title = kind === "reply" ? (first ? `Reply draft for ${first}` : "Reply draft") : "Internal note draft";
  return done(
    { drafted: true, sent: false, where: kind === "reply" ? "the agent's reply box" : "the agent's internal note box", note: "Nothing was sent or saved. The agent edits it and sends it themselves." },
    { card: { kind, ticketId: t.id, payload: { number: t.number, title, body, ...(others.length || namesOther ? { cites_other: true } : {}) } } }
  );
}
