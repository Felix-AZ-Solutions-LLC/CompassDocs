// Helpdesk 1.20.16: Save as draft on Claude in the desk's settings draft cards
// (categories, automations, recurring tickets; ClaudeSettingsDraftCard in
// ./shared). The desk's own settings routes save the draft, and only from a
// real card: one of this agent's, still offered, for that kind of setting
// (the 1.20.14 review's rule for checklist cards). The card is claimed
// (offered → applied) in the same step, so one card saves one draft however
// often it is sent; a save that is refused gives the card back (the claim
// and release live in ./chats beside 1.20.15's claimMacroCard). What is
// saved is the card's own content, checked again by the route as Desk
// settings would: nothing the request body says can change it.
// Server-only.

import "server-only";
import { audit, actorFrom } from "../../audit";
import { claimSettingsDraftCard, releaseClaimedCard } from "./chats";
import type { SessionUser } from "../../types";
import type { ClaudeSettingsDraftTarget } from "./shared";

export interface ClaimedDraftCard {
  id: number;
  ticket_id: number | null;
  target_id: number | null;
  draft: Record<string, unknown>;
  number: number | null;
}

/**
 * Claim this agent's offered draft card for `target` (chats claimSettingsDraftCard, the pattern of
 * 1.20.15's claimMacroCard); null when there is no such card, it was used, or it carries no draft.
 */
export async function claimDraftCard(userId: number, rawCardId: unknown, target: ClaudeSettingsDraftTarget): Promise<ClaimedDraftCard | null> {
  const c = await claimSettingsDraftCard(userId, rawCardId, target);
  if (!c) return null;
  if (!c.payload?.draft || typeof c.payload.draft !== "object") {
    await releaseClaimedCard(userId, c.id);
    return null;
  }
  const tid = c.payload.target_id;
  return {
    id: c.id,
    ticket_id: c.ticket_id,
    target_id: typeof tid === "number" && Number.isInteger(tid) && tid > 0 ? tid : null,
    draft: c.payload.draft as Record<string, unknown>,
    number: typeof c.payload.number === "number" ? c.payload.number : null,
  };
}

/** A refused save wrote nothing: the card is offered again, so the agent can try after fixing what was refused. */
export async function releaseDraftCard(userId: number, cardId: number): Promise<void> {
  await releaseClaimedCard(userId, cardId);
}

/** The card's decision in the audit log, as the card route writes it (helpdesk.claude.card). */
export async function auditDraftCardApplied(user: SessionUser, card: ClaimedDraftCard, ip: string | null): Promise<void> {
  await audit({
    actor: actorFrom(user),
    action: "helpdesk.claude.card",
    targetType: card.ticket_id ? "helpdesk_ticket" : "helpdesk_claude",
    targetId: card.ticket_id,
    targetLabel: card.number ? `#${card.number}` : "Claude in the desk",
    details: { card_id: card.id, kind: "change", state: "applied", number: card.number, via: "claude_desk" },
    ip,
  });
}
