// Helpdesk 1.20.16: changes to the category list drafted by Claude, the
// server half (shapes and checks: lib/helpdesk/category-drafts-shared;
// schema: hd_category_draft in lib/helpdesk/categories-schema).
//
//   - One draft at most, beside the live list. Claude's hd_draft_categories
//     and Save as draft on a Claude in the desk card add to it (a change to
//     the same thing replaces the earlier one); a person edits it, publishes
//     it or discards it on the Categories tab.
//   - Nothing in a draft is on the list: pickers, the API, hd_update_ticket
//     and every check read hd_categories only, so a drafted name can't be set
//     anywhere until it is published.
//   - Publishing is explicit and names the draft the person reviewed
//     (draft_at; 409 when Claude saved a newer one). It runs, in one
//     transaction under the list's lock, exactly what the page runs: the
//     same create (insertEntryTx) and the same rename (renameEntryTx, which
//     rewrites the name on tickets, request types, rules, saved views and
//     report filters). The draft is checked again first; any problem
//     publishes nothing.
//   - Every write takes the list's lock, so a draft save, a publish and a
//     change on the page never interleave.
// Server-only.

import "server-only";
import type { PoolClient } from "pg";
import { hqOne } from "./db-core";
import { categoryTree, HdCategoryError, insertEntryTx, renameEntryTx, withCategoryListLock, type CategoryChange, type RenameResult } from "./categories";
import { CATEGORY_DRAFT_LIMITS, mergeCategoryChanges, planCategoryDraft, type HdCategoryDraft, type HdCategoryDraftChange } from "./category-drafts-shared";
import { STALE_DISCARD_MESSAGE, STALE_DRAFT_MESSAGE, sameDraftInstant, type HdDraftVia } from "./claude-drafts-shared";

const COLS = "changes, draft_by_name, draft_at, draft_via, edited_by_name";

async function readDraft(client?: PoolClient, lock = false): Promise<HdCategoryDraft | null> {
  const r = await hqOne<HdCategoryDraft>(`SELECT ${COLS} FROM hd_category_draft WHERE id = 1${lock ? " FOR UPDATE" : ""}`, [], client);
  return r ?? null;
}

/** The draft waiting on the list, or null. */
export async function getCategoryDraft(): Promise<HdCategoryDraft | null> {
  return readDraft();
}

/**
 * Check changes Claude proposes against the list (and any draft already
 * waiting), without saving them: Claude in the desk's draft_categories card.
 */
export async function checkCategoryChanges(raw: unknown): Promise<HdCategoryDraftChange[]> {
  if (!Array.isArray(raw) || raw.length > CATEGORY_DRAFT_LIMITS.changes) {
    throw new HdCategoryError(`Send the changes as a list of up to ${CATEGORY_DRAFT_LIMITS.changes}.`);
  }
  const plan = planCategoryDraft(await categoryTree(), raw);
  if (!plan.ok) throw new HdCategoryError(plan.error);
  return plan.changes;
}

/**
 * Save changes Claude proposed (hd_draft_categories, Save as draft on a card):
 * added to the draft already waiting, the whole draft checked against the
 * list as it stands. Who asked, when and where are recorded.
 */
export async function saveCategoryDraft(
  raw: unknown,
  actor: { id: number | null; name: string; via: HdDraftVia }
): Promise<{ draft: HdCategoryDraft; kind: "new" | "added" }> {
  if (!Array.isArray(raw) || raw.length > CATEGORY_DRAFT_LIMITS.changes) {
    throw new HdCategoryError(`Send the changes as a list of up to ${CATEGORY_DRAFT_LIMITS.changes}.`);
  }
  return withCategoryListLock(async (client) => {
    const earlier = await readDraft(client, true);
    const all = earlier ? mergeCategoryChanges(earlier.changes, raw) : raw;
    const plan = planCategoryDraft(await categoryTree(client), all);
    if (!plan.ok) throw new HdCategoryError(plan.error, plan.stale ? 409 : 400);
    const d = await hqOne<HdCategoryDraft>(
      `INSERT INTO hd_category_draft (id, changes, draft_by, draft_by_name, draft_at, draft_via, updated_at) VALUES (1, $1, $2, $3, now(), $4, now())
       ON CONFLICT (id) DO UPDATE SET changes = EXCLUDED.changes, draft_by = EXCLUDED.draft_by, draft_by_name = EXCLUDED.draft_by_name,
              draft_at = now(), draft_via = EXCLUDED.draft_via, updated_at = now(), edited_by = NULL, edited_by_name = ''
       RETURNING ${COLS}`,
      [JSON.stringify(plan.changes), actor.id, actor.name, actor.via],
      client
    );
    return { draft: d!, kind: earlier ? ("added" as const) : ("new" as const) };
  });
}

/**
 * A person saves the draft as the Categories tab shows it (names edited,
 * changes taken out), naming the draft they saw (409 when Claude saved a
 * newer one). It stays a draft; who asked Claude for it is kept, the editor
 * is recorded and draft_at is renewed (review fix: a publish must name the
 * edited version). A change whose entry was renamed since is refused (409).
 * An empty list discards it.
 */
export async function editCategoryDraft(raw: unknown, draftAt: unknown, editor: { id: number | null; name: string } = { id: null, name: "" }): Promise<HdCategoryDraft | null> {
  if (!Array.isArray(raw) || raw.length > CATEGORY_DRAFT_LIMITS.changes) {
    throw new HdCategoryError(`Send the changes as a list of up to ${CATEGORY_DRAFT_LIMITS.changes}.`);
  }
  return withCategoryListLock(async (client) => {
    const cur = await readDraft(client, true);
    if (!cur) throw new HdCategoryError("There are no changes waiting on the list.", 409);
    if (!sameDraftInstant(cur.draft_at, draftAt)) throw new HdCategoryError(STALE_DRAFT_MESSAGE, 409);
    if (raw.length === 0) {
      await client.query("DELETE FROM hd_category_draft WHERE id = 1");
      return null;
    }
    const plan = planCategoryDraft(await categoryTree(client), raw);
    if (!plan.ok) throw new HdCategoryError(plan.error, plan.stale ? 409 : 400);
    // Review fix: the person's edit is a new version (a new draft_at, so a publish must name it) and says who made it.
    return (await hqOne<HdCategoryDraft>(
      `UPDATE hd_category_draft SET changes = $1, updated_at = now(), draft_at = now(), edited_by = $2, edited_by_name = $3 WHERE id = 1 RETURNING ${COLS}`,
      [JSON.stringify(plan.changes), editor.id, editor.name],
      client
    ))!;
  });
}

export interface PublishedCategoryDraft {
  draft: HdCategoryDraft;
  created: CategoryChange[];
  renamed: RenameResult[];
}

/**
 * Publish the draft the person reviewed (`draftAt`), as the Categories tab
 * shows it (`raw`: the changes, maybe edited; omitted = as saved). One
 * transaction under the list's lock: checked again, then each change runs
 * exactly as the page's own create and rename do. Any problem publishes
 * nothing (the sentence says which change).
 */
export async function publishCategoryDraft(draftAt: unknown, raw?: unknown, actorId: number | null = null): Promise<PublishedCategoryDraft> {
  if (raw !== undefined && (!Array.isArray(raw) || raw.length > CATEGORY_DRAFT_LIMITS.changes)) {
    throw new HdCategoryError(`Send the changes as a list of up to ${CATEGORY_DRAFT_LIMITS.changes}.`);
  }
  // Review fix: what is published is what was reviewed, so each change says what it acts on
  // (a rename its "from" and category, a new sub-category its category), checked against the list.
  if (
    Array.isArray(raw) &&
    raw.some((c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      return (o.kind === "rename" && (typeof o.from !== "string" || !("parent" in o))) || (o.kind === "add_subcategory" && typeof o.category !== "string");
    })
  ) {
    throw new HdCategoryError("Publish the changes as the Categories tab shows them: each rename with the name it renames.");
  }
  return withCategoryListLock(async (client) => {
    const cur = await readDraft(client, true);
    if (!cur) throw new HdCategoryError("There are no changes waiting on the list.", 409);
    if (!sameDraftInstant(cur.draft_at, draftAt)) throw new HdCategoryError(STALE_DRAFT_MESSAGE, 409);
    const plan = planCategoryDraft(await categoryTree(client), raw ?? cur.changes);
    if (!plan.ok) throw new HdCategoryError(plan.error, 409);
    const created: CategoryChange[] = [];
    const renamed: RenameResult[] = [];
    for (const c of plan.changes) {
      if (c.kind === "add_category") {
        const made = await insertEntryTx(client, null, c.name, actorId);
        created.push(made);
        for (const sub of c.subcategories) created.push(await insertEntryTx(client, made.id, sub, actorId));
      } else if (c.kind === "add_subcategory") {
        created.push(await insertEntryTx(client, c.category_id, c.name, actorId));
      } else {
        const r = await renameEntryTx(client, c.id, c.to);
        if (!r) throw new HdCategoryError(`"${c.from}" is no longer on the list. Nothing was published.`, 409);
        renamed.push(r);
      }
    }
    await client.query("DELETE FROM hd_category_draft WHERE id = 1");
    return { draft: { ...cur, changes: plan.changes }, created, renamed };
  });
}

/** Drop the draft (the list stays as it is). Null when there is none; with `draftAt`, only the one the person saw. */
export async function discardCategoryDraft(draftAt?: unknown): Promise<HdCategoryDraft | null> {
  return withCategoryListLock(async (client) => {
    const cur = await readDraft(client, true);
    if (!cur) return null;
    if (draftAt !== undefined && draftAt !== null && !sameDraftInstant(cur.draft_at, draftAt)) throw new HdCategoryError(STALE_DISCARD_MESSAGE, 409);
    await client.query("DELETE FROM hd_category_draft WHERE id = 1");
    return cur;
  });
}
