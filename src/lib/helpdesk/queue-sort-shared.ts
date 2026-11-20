// Helpdesk 1.20.36: how the desk queue's ticket list is sorted, as data and
// pure functions (no server imports: the queue, the Notifications page and
// lib/helpdesk/notify-prefs share it).
//
// The agent's choice is a desk preference (hd_notify_prefs.prefs.queue_sort,
// beside ticket_order), so it follows them across views, sessions, devices
// and windows. null means "the desk's default" (Due first), so an agent who
// never chose, or reset it, follows the default if it ever changes.
//
// Which sort a list shows (resolveQueueSort):
//   1. the Parked view's own order (soonest to wake first), whatever else
//      says: its clocks are paused, so the other sorts mean little there;
//   2. an explicit ?sort= in the address, for that list only and never saved
//      (shared links and report drill-downs keep working as they did);
//   3. the agent's saved sort;
//   4. the default, Due first.
// Saved views hold no sort of their own (lib/helpdesk/saved-views drops it),
// so a saved view follows the same order.

export const HD_QUEUE_SORTS = ["due", "priority", "updated", "created"] as const;
export type HdQueueSort = (typeof HD_QUEUE_SORTS)[number];

/** The desk's default when the agent has not chosen. */
export const QUEUE_SORT_DEFAULT: HdQueueSort = "due";

/** The labels, in the order the Sort menu lists them. */
export const QUEUE_SORT_OPTIONS: { value: HdQueueSort; label: string }[] = [
  { value: "due", label: "Due first" },
  { value: "priority", label: "Priority first" },
  { value: "updated", label: "Recently updated" },
  { value: "created", label: "Newest first" },
];

/** What the Parked view's fixed order reads as in the queue's header. */
export const PARKED_ORDER_LABEL = "Soonest to wake";
/** Why the Sort control is off in the Parked view (its tooltip and accessible name). */
export const PARKED_ORDER_REASON = "Parked tickets are always listed soonest to wake first.";

export function isQueueSort(v: unknown): v is HdQueueSort {
  return typeof v === "string" && (HD_QUEUE_SORTS as readonly string[]).includes(v);
}

/** A stored or submitted value as a sort, or null (the default) for anything else. Never throws. */
export function cleanQueueSort(v: unknown): HdQueueSort | null {
  return isQueueSort(v) ? v : null;
}

export function queueSortLabel(v: HdQueueSort): string {
  return QUEUE_SORT_OPTIONS.find((o) => o.value === v)?.label ?? "Due first";
}

/** Where the sort a list shows came from. */
export type QueueSortSource = "fixed" | "url" | "pref" | "default";

/**
 * The sort a list shows. `url` is the address's ?sort= (raw), `pref` the
 * agent's saved choice (raw: anything malformed counts as none), `fixed` true
 * for a list whose own definition sets the order (the Parked view). A fixed
 * list reads "due", which the server lists soonest to wake first there.
 */
export function resolveQueueSort(opts: { url?: string | null; pref?: unknown; fixed?: boolean }): { sort: HdQueueSort; from: QueueSortSource } {
  if (opts.fixed) return { sort: "due", from: "fixed" };
  if (isQueueSort(opts.url)) return { sort: opts.url, from: "url" };
  if (isQueueSort(opts.pref)) return { sort: opts.pref, from: "pref" };
  return { sort: QUEUE_SORT_DEFAULT, from: "default" };
}
