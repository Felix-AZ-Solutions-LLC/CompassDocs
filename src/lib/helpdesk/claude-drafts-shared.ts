// Helpdesk 1.20.16: drafts from Claude for desk settings beyond checklists
// (categories, automations, recurring tickets). The client-safe half: the
// shape every draftable row carries, the sentences the routes and pages
// share, and the timestamp check an explicit publish makes. The model is
// 1.20.14's checklist drafts (lib/helpdesk/checklists) after its security
// review:
//
//   - A NEW thing Claude drafts is saved unpublished (published = 0): an
//     automation switched off, a recurring schedule paused, and it never
//     runs, opens a ticket or is offered anywhere until a person publishes it.
//   - CHANGES to a published one wait in `draft` beside it; the live one keeps
//     working unchanged until a person publishes them.
//   - Publishing is explicit (publish / publish_draft) and names the draft
//     the person reviewed (draft_at): a newer one is refused (409), never
//     published unseen. A plain save edits the live copy (or the unpublished
//     draft) and keeps a pending draft. Saves and publishes lock the row.
//   - Claude never switches anything on, never deletes, never merges.

/** Where a draft came from: the Claude connector, or a Claude in the desk card. */
export type HdDraftVia = "mcp" | "claude_desk";

/** The columns a draftable row carries (as the routes return them). */
export interface HdClaudeDraftFields<T> {
  /** False for a new one Claude drafted that nobody has published yet. */
  published: boolean;
  /** Changes Claude proposed to a published one; null when none. */
  draft: T | null;
  /** Who asked Claude for the draft, and when ("" and null when there is none). */
  draft_by_name: string;
  draft_at: string | null;
  /** "mcp" or "claude_desk"; "" when there is no draft. */
  draft_via: string;
}

/** Does this row wait for a person (a new draft, or proposed changes)? */
export function waitsForReview(t: { published: boolean; draft: unknown }): boolean {
  return !t.published || !!t.draft;
}

/** The chip the settings lists show: "Draft from Claude" / "Changes from Claude"; null when nothing waits. */
export function draftChipLabel(t: { published: boolean; draft: unknown }): string | null {
  return !t.published ? "Draft from Claude" : t.draft ? "Changes from Claude" : null;
}

/** Is `b` (what the person's page sent) the same instant as the draft's `a`? */
export function sameDraftInstant(a: string | Date | null | undefined, b: unknown): boolean {
  if (!a || (typeof b !== "string" && !(b instanceof Date))) return false;
  const x = new Date(a).getTime();
  const y = new Date(b as string).getTime();
  return Number.isFinite(x) && x === y;
}

/** The refusal when Claude saved a newer draft since the person opened the page. */
export const STALE_DRAFT_MESSAGE = "Claude saved a newer draft since you opened this. Reload to review it before you publish.";
export const STALE_DISCARD_MESSAGE = "Claude saved a newer draft since you opened this. Reload to review it.";
export const NO_CHANGES_WAITING = "There are no changes waiting here.";

/** SQL: the draft columns as the routes return them. */
export const DRAFT_COLS_SQL = "(published = 1) AS published, draft, draft_by_name, draft_at, draft_via";
/** SQL: clear the proposal (after publishing or discarding it). */
export const CLEAR_DRAFT_SQL = "draft = NULL, draft_by = NULL, draft_by_name = '', draft_at = NULL, draft_via = ''";

/** The audit marker of a draft saved through Claude (as the other Claude writes carry it). */
export function draftViaDetails(via: HdDraftVia): Record<string, string> {
  return via === "mcp" ? { via: "mcp" } : { via: "claude_desk", via_label: "via Claude in the desk" };
}
