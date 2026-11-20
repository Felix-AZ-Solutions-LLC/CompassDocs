// The queue's views (the left column of /desk) and how a view travels in
// the address: ?view=mine (default), ?view=overdue, or ?team=3 for a team's
// open tickets, plus ?sort=due|updated|created|priority. Opening a ticket
// keeps the query, so /desk/tickets/1047?view=overdue still shows the
// Overdue list beside it.
//
// 1.20.36 (lib/helpdesk/queue-sort-shared): the sort is the agent's desk
// preference. An explicit ?sort= still wins for the list it names (and
// travels with it while tickets open beside it) but is never saved; moving
// to another view drops it. The Parked view keeps its own order.

import { CircleAlert, CircleCheck, CirclePause, Hourglass, Inbox, List, UserRound, Workflow, type LucideIcon } from "lucide-react";
import type { HdNamedView } from "@/lib/helpdesk/types";
import { QUEUE_SORT_OPTIONS, resolveQueueSort, type HdQueueSort, type QueueSortSource } from "@/lib/helpdesk/queue-sort-shared";
import { isCfFilterKey, CF_FILTER_MAX, CF_VALUE_MAX } from "@/lib/helpdesk/custom-field-filters-shared";

export const VIEWS: { key: HdNamedView; label: string; icon: LucideIcon; alarm?: boolean }[] = [
  { key: "mine", label: "My open", icon: UserRound },
  { key: "unassigned", label: "Unassigned", icon: Inbox },
  { key: "open", label: "All open", icon: List },
  { key: "overdue", label: "Overdue", icon: CircleAlert, alarm: true },
  { key: "workflow", label: "In a workflow", icon: Workflow },
  { key: "waiting", label: "Waiting", icon: CirclePause },
  { key: "solved_week", label: "Solved this week", icon: CircleCheck },
  // 1.20.34 (lib/helpdesk/desk-calendar-park): tickets on hold until their event, soonest to wake first.
  { key: "parked", label: "Parked", icon: Hourglass },
];

/** 1.20.27: what will appear in an empty view (My open only ever holds the agent's own tickets). */
export const VIEW_EMPTY: Record<HdNamedView, string> = {
  mine: "Tickets assigned to you appear here.",
  unassigned: "New tickets nobody owns yet appear here as they arrive.",
  open: "New tickets appear here as they arrive.",
  overdue: "Tickets past a reply or resolve target appear here.",
  workflow: "Requests with a workflow running appear here.",
  waiting: "Tickets waiting on the requester or on hold appear here.",
  solved_week: "Tickets solved this week appear here.",
  parked: "Tickets held until their event appear here, soonest to wake first.",
};

export const SORTS = QUEUE_SORT_OPTIONS;

/**
 * Report drill-down (agent K's report charts link into the queue): these
 * query parameters filter the list across every status, under a
 * "Filtered from Reports" bar. `team` alone is the ordinary team view; any
 * other key here (or from=reports) makes it a drill-down.
 */
export const DRILL_KEYS = [
  "team",
  "assignee",
  "priority",
  "request_type",
  "channel",
  // 1.20.2: the help address a ticket came in on (the Filter dialog's Address).
  "mailbox",
  "status",
  "tag",
  "created_from",
  "created_to",
  "solved_from",
  "solved_to",
  "breached",
  "requester",
  "requester_email",
  "category",
  // 1.20.6: a sub-category (lib/helpdesk/categories), from the Filter dialog or a report's drill-down.
  "subcategory",
  "department",
  "office",
  "origin",
  "status_group",
  // 1.20.34: a saved view's "Include parked tickets" (with status_group=open).
  "include_parked",
  "vip",
  "integration",
  // 1.19.1 saved views (agent V4): the desk's own Filter dialog adds these.
  // `view` (the list a filter starts from) never makes a drill-down alone.
  "view",
  "q",
  "created_within",
] as const;

export interface QueueSel {
  view: HdNamedView | null;
  team: number | null;
  sort: HdQueueSort;
  /**
   * 1.20.36: where `sort` came from. Only "url" (an explicit ?sort=) is written back into the list's links; anything
   * else (the agent's preference, the default, Parked's own order) is resolved afresh on each page.
   */
  sortFrom?: QueueSortSource;
  /** The drill-down filters, when the list came from Reports. */
  drill: Record<string, string> | null;
  /** 1.19.1: where the filters came from: Reports (default) or the desk's Filter dialog (from=filter). */
  origin?: "reports" | "filter";
  /** 1.19.1: a saved view's id (?saved=12); its filters are the view's (components/helpdesk/desk/views). */
  saved?: number | null;
}

const VIEW_KEYS = new Set<string>(VIEWS.map((v) => v.key));

/**
 * The selection in the address. `pref` is the agent's saved sort (null or anything malformed: the default); an
 * explicit ?sort= wins over it, and a list of parked tickets (the Parked view, a filtered list starting from it,
 * status_group=parked) ignores both.
 */
export function readSel(sp: URLSearchParams | null, pref: unknown = null): QueueSel {
  const team = Number(sp?.get("team"));
  const view = sp?.get("view") ?? "";
  const url = sp?.get("sort") ?? null;
  const sortOf = (fixed: boolean) => {
    const r = resolveQueueSort({ url, pref, fixed });
    return { sort: r.sort, sortFrom: r.from };
  };
  const drill: Record<string, string> = {};
  for (const k of DRILL_KEYS) {
    const v = sp?.get(k);
    if (v) drill[k] = v.slice(0, k === "requester_email" ? 320 : 80);
  }
  // 1.20.8: custom field conditions (cf.<key>, lib/helpdesk/custom-field-filters) from the Filter dialog.
  let custom = 0;
  for (const [k, v] of sp ?? []) {
    if (!isCfFilterKey(k) || !v || k in drill || ++custom > CF_FILTER_MAX) continue;
    drill[k] = v.slice(0, CF_VALUE_MAX);
  }
  const origin = sp?.get("from") === "filter" ? "filter" : "reports";
  const saved = Number(sp?.get("saved"));
  if (Number.isSafeInteger(saved) && saved > 0) {
    // A saved view's own filters may start from Parked: fixSavedOrder, once the views are known.
    return { drill: null, team: null, view: null, saved, ...sortOf(false) };
  }
  const isDrill = sp?.get("from") === "reports" || origin === "filter" || Object.keys(drill).some((k) => k !== "team" && k !== "view");
  if (isDrill && origin === "filter") {
    return { drill, origin, team: null, view: null, ...sortOf(startsFromParked(drill)) };
  }
  const teamSel = Number.isSafeInteger(team) && team > 0 ? team : null;
  const named = teamSel ? null : VIEW_KEYS.has(view) ? (view as HdNamedView) : "mine";
  return {
    drill: isDrill ? drill : null,
    team: teamSel,
    view: named,
    ...sortOf(isDrill ? startsFromParked(drill) : named === "parked"),
  };
}

/**
 * Filters that list only parked tickets: the Parked view, or status_group=parked (Reports' "Parked now" drill-down,
 * a saved view). Such a list keeps Parked's own order (the server lists it soonest to wake first).
 */
export function startsFromParked(filters: Record<string, string> | null | undefined): boolean {
  return filters?.view === "parked" || filters?.status_group === "parked";
}

/** A saved view whose filters list parked tickets keeps Parked's order (its filters load after the address is read). */
export function fixSavedOrder(sel: QueueSel, filters: Record<string, string> | undefined): QueueSel {
  if (!sel.saved || !startsFromParked(filters) || sel.sortFrom === "fixed") return sel;
  return { ...sel, sort: "due", sortFrom: "fixed" };
}

/** True when the list's own definition fixes its order (the Sort control is shown off). */
export const fixedOrder = (sel: QueueSel): boolean => sel.sortFrom === "fixed";

/**
 * The query string for a selection ("" for the default My open). The sort is written only when it came from the
 * address (1.20.36): an explicit ?sort= stays with its list; the agent's own sort needs no parameter.
 */
export function selQs(sel: QueueSel): string {
  const p = new URLSearchParams();
  const sort = () => {
    if (sel.sortFrom === "url") p.set("sort", sel.sort);
  };
  if (sel.drill) {
    p.set("from", sel.origin ?? "reports");
    for (const [k, v] of Object.entries(sel.drill)) p.set(k, v);
    sort();
    return `?${p.toString()}`;
  }
  // A saved view (1.19.1) unless a built-in view or a team was picked.
  if (sel.saved && !sel.team && !sel.view) {
    p.set("saved", String(sel.saved));
    sort();
    return `?${p.toString()}`;
  }
  if (sel.team) p.set("team", String(sel.team));
  else if (sel.view && sel.view !== "mine") p.set("view", sel.view);
  sort();
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** The API query for a selection. */
export function apiQs(sel: QueueSel): string {
  const p = new URLSearchParams();
  if (sel.drill) {
    // Every status unless the drill-down names one.
    p.set("view", "all");
    for (const [k, v] of Object.entries(sel.drill)) p.set(k, v);
    p.set("sort", sel.sort);
    return p.toString();
  }
  if (sel.team) {
    p.set("view", "open");
    p.set("team", String(sel.team));
  } else p.set("view", sel.view ?? "mine");
  p.set("sort", sel.sort);
  return p.toString();
}
