// Helpdesk 1.20.16: changes Claude proposed to the category list (lib/helpdesk/category-drafts),
// reviewed on Desk settings → Categories. Desk capability settings.manage, as for the list itself.
//
// GET  → { draft } (null when nothing waits).
// POST { card_id } is "Save as draft" on a Claude in the desk category card: the card's changes (this
//      person's offered card; 400 otherwise, and used once) are added to the draft, checked as the
//      page checks a name. Audited helpdesk.category_draft.created / .updated (via "claude_desk").
// PUT  { changes, draft_at }                 the person saves the draft as the page shows it (names
//      edited, changes taken out); it stays a draft. helpdesk.category_draft.updated.
// PUT  { publish: true, draft_at, changes? } publishes it: in one transaction, each change runs exactly
//      as the page's own add and rename (a rename rewrites the name on tickets, request types, rules,
//      saved views and report filters). helpdesk.category_draft.published, and one
//      helpdesk.category.created / .renamed per change, as the page writes them.
// PUT  { discard_draft: true, draft_at? }    drops it. helpdesk.category_draft.draft_discarded.
// Every PUT names the draft the person reviewed (draft_at): 409 when Claude saved a newer one.

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { HdCategoryError, type CategoryChange } from "@/lib/helpdesk/categories";
import { discardCategoryDraft, editCategoryDraft, getCategoryDraft, publishCategoryDraft, saveCategoryDraft } from "@/lib/helpdesk/category-drafts";
import { auditDraftCardApplied, claimDraftCard, releaseDraftCard } from "@/lib/helpdesk/claude/draft-cards";
import { draftViaDetails } from "@/lib/helpdesk/claude-drafts-shared";

export const dynamic = "force-dynamic";

const labelOf = (c: CategoryChange) => (c.parent ? `${c.parent.name} › ${c.name}` : c.name);
const kindOf = (c: CategoryChange) => (c.parent ? "sub-category" : "category");
const LABEL = "Category list changes";

export async function GET() {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ draft: await getCategoryDraft() });
}

export async function POST(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 8 * 1024);
  const card = await claimDraftCard(gate.id, b?.card_id, "categories");
  if (!card) return NextResponse.json({ error: "Save as draft works from the Claude card it came from. Add categories on this page instead." }, { status: 400 });
  try {
    const r = await saveCategoryDraft(card.draft.changes, { id: gate.id, name: gate.name || gate.username, via: "claude_desk" });
    await audit({
      actor: actorFrom(gate),
      action: r.kind === "new" ? "helpdesk.category_draft.created" : "helpdesk.category_draft.updated",
      targetType: "helpdesk_category",
      targetLabel: LABEL,
      details: { changes: r.draft.changes.length, draft: true, ...draftViaDetails("claude_desk"), card_id: card.id },
      ip: ipFrom(req),
    });
    await auditDraftCardApplied(gate, card, ipFrom(req));
    return NextResponse.json({ draft: r.draft }, { status: r.kind === "new" ? 201 : 200 });
  } catch (e) {
    await releaseDraftCard(gate.id, card.id);
    if (e instanceof HdCategoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function PUT(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 64 * 1024);
  if (!b) return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });
  const base = { actor: actorFrom(gate), targetType: "helpdesk_category", ip: ipFrom(req) };
  try {
    if (b.discard_draft === true) {
      const gone = await discardCategoryDraft(b.draft_at);
      if (!gone) return NextResponse.json({ error: "There are no changes waiting on the list." }, { status: 409 });
      await audit({
        ...base,
        action: "helpdesk.category_draft.draft_discarded",
        targetLabel: LABEL,
        details: { changes: gone.changes.length, drafted_by: gone.draft_by_name, drafted_via: gone.draft_via },
      });
      return NextResponse.json({ draft: null });
    }
    if (b.publish === true) {
      const r = await publishCategoryDraft(b.draft_at, b.changes, gate.id);
      const drafted = { drafted_by: r.draft.draft_by_name, drafted_via: r.draft.draft_via };
      await audit({
        ...base,
        action: "helpdesk.category_draft.published",
        targetLabel: LABEL,
        details: { changes: r.draft.changes.length, created: r.created.map(labelOf).slice(0, 200), renamed: r.renamed.map((x) => `${labelOf(x.before)} → ${x.after.name}`).slice(0, 200), ...drafted },
      });
      // Each change as the page audits it.
      for (const c of r.created) {
        await audit({
          ...base,
          action: "helpdesk.category.created",
          targetId: c.id,
          targetLabel: labelOf(c),
          details: { name: c.name, kind: kindOf(c), ...(c.parent ? { category: c.parent.name } : {}), from_draft: true, ...drafted },
        });
      }
      for (const x of r.renamed) {
        await audit({
          ...base,
          action: "helpdesk.category.renamed",
          targetId: x.after.id,
          targetLabel: labelOf(x.after),
          details: { kind: kindOf(x.after), from: x.before.name, to: x.after.name, tickets: x.tickets, ...(x.after.parent ? { category: x.after.parent.name } : {}), from_draft: true, ...drafted },
        });
      }
      return NextResponse.json({ ok: true, created: r.created.length, renamed: r.renamed.map((x) => ({ from: x.before.name, to: x.after.name, tickets: x.tickets })), draft: null });
    }
    const d = await editCategoryDraft(b.changes, b.draft_at);
    await audit({ ...base, action: d ? "helpdesk.category_draft.updated" : "helpdesk.category_draft.draft_discarded", targetLabel: LABEL, details: { changes: d?.changes.length ?? 0 } });
    return NextResponse.json({ draft: d });
  } catch (e) {
    if (e instanceof HdCategoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
