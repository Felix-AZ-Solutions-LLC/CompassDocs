// Helpdesk 1.20.16: changes to the category list drafted by Claude, the pure
// half (no database): the change shapes, the limits, how a list of changes
// is checked against the list (planCategoryDraft) and how one reads in plain
// words. The server half is lib/helpdesk/category-drafts; the Categories tab
// imports this one.
//
// A draft is an ordered list of changes: add a category (with sub-categories),
// add a sub-category to a category on the list, rename a category or a
// sub-category. Never a delete, an archive or a merge. It is checked against
// the list as it would stand after each earlier change, with Desk settings'
// own name rules (categories-shared categoryNameProblem, unique within its
// level whatever the case, the per-level limits), when Claude saves it, when
// a person saves it and again, under the list's lock, when it is published.

import { CATEGORY_LIMITS, categoryKey, categoryNameProblem, cleanCategoryName, type HdCategory } from "./categories-shared";

export type HdCategoryDraftChange =
  | { kind: "add_category"; name: string; subcategories: string[] }
  | { kind: "add_subcategory"; category_id: number; category: string; name: string }
  | { kind: "rename"; id: number; parent: string | null; from: string; to: string };

/** The draft as the Categories tab and the tools read it. */
export interface HdCategoryDraft {
  changes: HdCategoryDraftChange[];
  draft_by_name: string;
  draft_at: string;
  /** "mcp" | "claude_desk". */
  draft_via: string;
}

export const CATEGORY_DRAFT_LIMITS = {
  /** Changes in one draft. */
  changes: 50,
} as const;

export const CATEGORY_DRAFT_KINDS = ["add_category", "add_subcategory", "rename"] as const;

/** One change in words: 'Add the category "Printers" with Toner, Paper jam'. */
export function categoryChangeLine(c: HdCategoryDraftChange): string {
  switch (c.kind) {
    case "add_category":
      return c.subcategories.length ? `Add the category "${c.name}" with ${c.subcategories.join(", ")}` : `Add the category "${c.name}"`;
    case "add_subcategory":
      return `Add the sub-category "${c.name}" to ${c.category}`;
    case "rename":
      return c.parent ? `Rename the sub-category ${c.parent} › ${c.from} to "${c.to}"` : `Rename the category ${c.from} to "${c.to}"`;
  }
}

interface SimEntry {
  id: number | null;
  name: string;
  subs: { id: number | null; name: string }[];
}

type Plan = { ok: true; changes: HdCategoryDraftChange[] } | { ok: false; error: string };

/**
 * Check `raw` (a list of changes, as Claude sends them or as stored) against
 * the list `tree` (archived entries included). Answers the changes in the
 * stored shape, the names spelled as they will be saved, or the first
 * problem as a sentence ("Change 2: …").
 */
export function planCategoryDraft(tree: readonly HdCategory[], raw: unknown): Plan {
  if (!Array.isArray(raw)) return { ok: false, error: "Send the changes as a list." };
  if (raw.length === 0) return { ok: false, error: "Propose at least one change." };
  if (raw.length > CATEGORY_DRAFT_LIMITS.changes) return { ok: false, error: `A draft holds up to ${CATEGORY_DRAFT_LIMITS.changes} changes.` };
  const sim: SimEntry[] = tree.map((c) => ({ id: c.id, name: c.name, subs: c.subcategories.map((s) => ({ id: s.id, name: s.name })) }));
  const out: HdCategoryDraftChange[] = [];
  const renamed = new Set<number>();
  const at = (i: number, why: string): Plan => ({ ok: false, error: `Change ${i + 1}: ${why}` });
  const entryById = (id: number) => {
    for (const c of sim) {
      if (c.id === id) return { entry: c, parent: null as SimEntry | null };
      const s = c.subs.find((x) => x.id === id);
      if (s) return { entry: s, parent: c };
    }
    return null;
  };
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as Record<string, unknown> | null;
    if (!r || typeof r !== "object" || Array.isArray(r)) return at(i, "each change is an object with a kind.");
    if (!(CATEGORY_DRAFT_KINDS as readonly unknown[]).includes(r.kind)) {
      return at(i, "the kind is add_category, add_subcategory or rename. Claude can't delete, archive or merge categories.");
    }
    if (r.kind === "add_category") {
      const name = cleanCategoryName(r.name);
      const problem = categoryNameProblem(name, "category");
      if (problem) return at(i, problem);
      if (sim.some((c) => categoryKey(c.name) === categoryKey(name))) return at(i, `there is already a category called "${name}".`);
      if (sim.length >= CATEGORY_LIMITS.categories) return at(i, `the list holds up to ${CATEGORY_LIMITS.categories} categories.`);
      const rawSubs = r.subcategories ?? [];
      if (!Array.isArray(rawSubs) || rawSubs.length > CATEGORY_LIMITS.subcategories) {
        return at(i, `sub-categories are a list of up to ${CATEGORY_LIMITS.subcategories} names.`);
      }
      const subs: string[] = [];
      for (const s of rawSubs) {
        const sub = cleanCategoryName(s);
        const p = categoryNameProblem(sub, "sub-category");
        if (p) return at(i, p);
        if (subs.some((x) => categoryKey(x) === categoryKey(sub))) return at(i, `"${sub}" is listed twice.`);
        subs.push(sub);
      }
      sim.push({ id: null, name, subs: subs.map((n) => ({ id: null, name: n })) });
      out.push({ kind: "add_category", name, subcategories: subs });
      continue;
    }
    if (r.kind === "add_subcategory") {
      const name = cleanCategoryName(r.name);
      const problem = categoryNameProblem(name, "sub-category");
      if (problem) return at(i, problem);
      const byId = typeof r.category_id === "number" && Number.isInteger(r.category_id) && r.category_id > 0 ? sim.find((c) => c.id === r.category_id) : undefined;
      const parent = byId ?? (typeof r.category === "string" && r.category.trim() ? sim.find((c) => categoryKey(c.name) === categoryKey(r.category as string)) : undefined);
      if (!parent) return at(i, "that category is not on the list. Name a category from the list, or add the category with its sub-categories.");
      if (parent.subs.some((s) => categoryKey(s.name) === categoryKey(name))) return at(i, `${parent.name} already has a sub-category called "${name}".`);
      if (parent.subs.length >= CATEGORY_LIMITS.subcategories) return at(i, `a category holds up to ${CATEGORY_LIMITS.subcategories} sub-categories.`);
      parent.subs.push({ id: null, name });
      if (parent.id === null) {
        // A category added by this draft: the sub-category goes with it.
        const add = out.find((c) => c.kind === "add_category" && categoryKey(c.name) === categoryKey(parent.name)) as Extract<HdCategoryDraftChange, { kind: "add_category" }>;
        add.subcategories.push(name);
      } else out.push({ kind: "add_subcategory", category_id: parent.id, category: parent.name, name });
      continue;
    }
    // rename
    const id = typeof r.id === "number" && Number.isInteger(r.id) && r.id > 0 ? r.id : null;
    const found = id ? entryById(id) : null;
    if (!id || !found || found.entry.id === null) return at(i, "rename needs the id of a category or sub-category on the list (hd_list_categories lists them).");
    if (renamed.has(id)) return at(i, `"${found.entry.name}" is renamed twice. Keep one rename.`);
    const to = cleanCategoryName(r.to ?? r.name);
    const what = found.parent ? "sub-category" : "category";
    const problem = categoryNameProblem(to, what);
    if (problem) return at(i, problem);
    if (to === found.entry.name) return at(i, `it is already called "${to}".`);
    const siblings = found.parent ? found.parent.subs : sim;
    if (siblings.some((s) => s !== found.entry && categoryKey(s.name) === categoryKey(to))) {
      return at(i, found.parent ? `${found.parent.name} already has a sub-category called "${to}".` : `there is already a category called "${to}". Claude can't merge two categories.`);
    }
    const from = found.entry.name;
    found.entry.name = to;
    renamed.add(id);
    out.push({ kind: "rename", id, parent: found.parent ? found.parent.name : null, from, to });
  }
  return { ok: true, changes: out };
}

/**
 * Claude adds to a draft that is already waiting: a change to the same thing
 * (a rename of the same entry, an add of the same name) replaces the earlier
 * one; the rest are kept, in order, with the new ones after them.
 */
export function mergeCategoryChanges(earlier: readonly HdCategoryDraftChange[], raw: readonly unknown[]): unknown[] {
  const same = (a: HdCategoryDraftChange, b: Record<string, unknown>): boolean => {
    if (a.kind !== b.kind) return false;
    if (a.kind === "rename") return a.id === b.id;
    if (a.kind === "add_category") return categoryKey(a.name) === categoryKey(cleanCategoryName(b.name));
    return (
      categoryKey(a.name) === categoryKey(cleanCategoryName(b.name)) &&
      (a.category_id === b.category_id || (typeof b.category === "string" && categoryKey(a.category) === categoryKey(b.category)))
    );
  };
  const fresh = raw.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r));
  return [...earlier.filter((e) => !fresh.some((f) => same(e, f))), ...raw];
}
