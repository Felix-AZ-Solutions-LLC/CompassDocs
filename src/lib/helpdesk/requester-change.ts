// Helpdesk 1.20.33: changing a ticket's requester. The one primitive every
// path goes through: an agent's "Change requester" on the ticket's requester
// strip (POST /api/helpdesk/tickets/[number]/requester) and an automation's
// "Change the requester" (lib/helpdesk/automations applyRule). Before
// 1.20.33 nothing changed a requester after a ticket was opened.
//
// Who can be named (resolveRequester):
//   - an account: active, and able to use Get help (the people a requester
//     can be; an account that can't is refused by name);
//   - an address: an active account's (that account, as above; one whose role
//     can't use Get help is taken in unlinked, as inbound email takes it in),
//     else someone outside the workspace, taken in as inbound email creates a
//     requester (no account, their name and address on the ticket), only
//     while Desk settings → Email accepts outside senders. Never one of the
//     desk's own addresses, never a blocked customer-portal contact.
//
// What a change does, in one transaction with the ticket locked:
//   - requester_id, requester_name, requester_email;
//   - portal visibility: an account sees it in Get help by requester_id, so
//     portal_contact_id is cleared; on a customer-portal ticket an outside
//     address that is an unblocked portal contact takes it over (else it is
//     cleared, and the old contact no longer reaches it);
//   - CCs: the new requester is no longer a CC; the previous one is dropped
//     unless `keepCc` (then copied, with the usual "added … as CC." line);
//   - follows: a requester never follows (lib/helpdesk/ccs), so the new
//     requester's follow row goes;
//   - one agents-only activity line, event 'change' (the 1.20.28 layout):
//     "<who> changed the requester from A to B" (an automation's names its
//     rule, "Automation: <rule>", drawn with the bot icon), via 'system';
//   - after the commit: an audit entry (helpdesk.ticket.requester_changed),
//     the ticket.updated webhook and the ticket_updated rules
//     (lib/helpdesk/events; none for an automation's own change), and the
//     live queue update (the hd_tickets trigger watches the requester columns).
// Contact cards, notices and the requester's views read the ticket's
// requester when they are drawn or sent, so they follow at once.
//
// 1.20.33 review: an agent's change by hand (or adding a requester to a ticket
// that has none) is recorded on the ticket (requester_set_by_agent_at), and
// from then on no rule changes that ticket's requester. Closed tickets and
// tickets on legal hold change as any other ticket field edit does (field
// edits are allowed on them; a hold only stops deletion); a merged ticket or
// one in the recycle bin is refused.
// Server-only.

import "server-only";
import { audit } from "../audit";
import { logEvent } from "../log";
import { hq, hqOne, withTx } from "./db-core";
import { mdInline } from "./md-inline";
import { HD_CHANGE_EVENT } from "./conversation-shared";
import type { HdHookContext } from "./events";
import type { HdTicketRow } from "./types";

/** Who to make the requester: an account by id, or an address (with a name to show for someone outside). */
export interface RequesterPick {
  user_id?: number | null;
  email?: string;
  name?: string;
}

/** A requester as the ticket stores one. */
export interface ResolvedRequester {
  id: number | null;
  name: string;
  email: string;
}

export type RequesterRefusalCode = "not_found" | "not_permitted" | "invalid_email" | "own_address" | "outside_not_allowed" | "blocked";

export type Resolved = { ok: true; who: ResolvedRequester; unlinked?: boolean } | { ok: false; code: RequesterRefusalCode; error: string };

const EMAIL_RE = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;

/** A plausible single address. */
export function validRequesterEmail(v: string): boolean {
  return v.length <= 254 && EMAIL_RE.test(v);
}

/** Tests: answer the outside-senders setting for this process (null reads the workspace's again). */
let outsideOverride: boolean | null = null;
export function setRequesterOutsideSendersForTests(v: boolean | null): void {
  outsideOverride = v;
}

async function outsideAllowed(): Promise<boolean> {
  if (outsideOverride !== null) return outsideOverride;
  return (await (await import("./settings")).getHelpdeskSettings()).outside_senders === true;
}

/**
 * The desk's own addresses, one read for many: a listed help address (plus-tagged forms and ticket reply addresses
 * included, lib/helpdesk/mailboxes) or a team's email alias written as a whole address.
 */
export async function ownDeskAddressMatcher(): Promise<(address: string) => boolean> {
  const { ownAddressMatcher } = await import("./mailboxes");
  const own = await ownAddressMatcher();
  const aliases = (await hq<{ email_alias: string }>("SELECT email_alias FROM hd_teams")).map((r) => r.email_alias.trim().toLowerCase()).filter((a) => a.includes("@"));
  return (address: string) => {
    const a = address.trim().toLowerCase();
    return own(a) || aliases.includes(a);
  };
}

/**
 * 1.20.33 (review L7): every address a desk agent has here, one read for many: their account's, their directory
 * entry's and its aliases (a synced entry's proxyAddresses), each compared without a "+tag" and in any case.
 */
export async function deskAgentAddressMatcher(): Promise<(address: string) => boolean> {
  const { listDeskAgents } = await import("./roles-agents");
  const { mailboxKey } = await import("./mailboxes-shared");
  const ids = (await listDeskAgents()).filter((a) => a.role !== null).map((a) => a.user_id);
  const keys = new Set<string>();
  if (ids.length) {
    const rows = await hq<{ email: string; dir_email: string | null; proxies: unknown }>(
      `SELECT u.email, dp.email AS dir_email, dp.provider_record -> 'proxyAddresses' AS proxies
         FROM users u LEFT JOIN directory_people dp ON dp.id = u.directory_person_id
        WHERE u.id = ANY($1::int[])`,
      [ids]
    );
    for (const r of rows) {
      for (const a of [r.email, r.dir_email ?? "", ...(Array.isArray(r.proxies) ? r.proxies.map((x) => String(x).replace(/^smtp:/i, "")) : [])]) {
        const k = mailboxKey(a);
        if (k) keys.add(k);
      }
    }
  }
  return (address: string) => {
    const k = mailboxKey(address);
    return !!k && keys.has(k);
  };
}

async function mayRequest(u: { id: number; role: string }): Promise<boolean> {
  const { canUseHelpdesk } = await import("./access");
  return canUseHelpdesk(u as Parameters<typeof canUseHelpdesk>[0]);
}

/**
 * Who a pick names, as the ticket would store them, or why they can't be the requester (one plain sentence).
 * `opts.outside` overrides the outside-senders setting (tests).
 */
export async function resolveRequester(pick: RequesterPick, opts: { outside?: boolean } = {}): Promise<Resolved> {
  if (pick.user_id !== undefined && pick.user_id !== null) {
    const u = await hqOne<{ id: number; name: string; username: string; email: string; role: string }>(
      "SELECT id, name, username, email, role FROM users WHERE id = $1 AND status = 'active'",
      [Number(pick.user_id)]
    );
    if (!u) return { ok: false, code: "not_found", error: "That person has no active account." };
    if (!(await mayRequest(u))) return { ok: false, code: "not_permitted", error: `${u.name || u.username} can't use Get help, so they can't be a requester. Give them a role that includes Get help, or name an address instead.` };
    return { ok: true, who: { id: u.id, name: (u.name || u.username).slice(0, 200), email: (u.email ?? "").slice(0, 320) } };
  }
  const email = (pick.email ?? "").trim().toLowerCase();
  if (!validRequesterEmail(email)) return { ok: false, code: "invalid_email", error: "Name a person, or a single email address." };
  if ((await ownDeskAddressMatcher())(email)) return { ok: false, code: "own_address", error: `${email} is one of the desk's own addresses, so it can't be a requester.` };
  const u = await hqOne<{ id: number; name: string; username: string; email: string; role: string }>(
    "SELECT id, name, username, email, role FROM users WHERE lower(email) = $1 AND status = 'active' ORDER BY id LIMIT 1",
    [email]
  );
  if (u && (await mayRequest(u))) return { ok: true, who: { id: u.id, name: (u.name || u.username).slice(0, 200), email: u.email || email } };
  // Someone outside the workspace (or an account that can't use Get help, taken in unlinked as inbound email does).
  if (!(opts.outside ?? (await outsideAllowed()))) {
    return {
      ok: false,
      code: "outside_not_allowed",
      error: u
        ? `${u.name || u.username}'s account can't use Get help, and mail from outside the workspace isn't accepted (Desk settings → Email → Outside senders), so they can't be the requester.`
        : `Nobody in the workspace has the address ${email}, and mail from outside the workspace isn't accepted (Desk settings → Email → Outside senders), so it can't be the requester.`,
    };
  }
  if (await (await import("./portal-hooks")).portalContactBlocked(email)) return { ok: false, code: "blocked", error: `${email} is a blocked customer-portal contact.` };
  const contact = await hqOne<{ name: string }>("SELECT name FROM hd_portal_contacts WHERE lower(email) = $1", [email]).catch(() => undefined);
  const name = (pick.name ?? "").replace(/[\r\n<>"]/g, " ").trim() || contact?.name?.trim() || (u ? u.name || u.username : "") || email;
  return { ok: true, who: { id: null, name: name.slice(0, 200), email }, ...(u ? { unlinked: true } : {}) };
}

/** Is `who` already the ticket's requester? */
export function sameRequester(t: Pick<HdTicketRow, "requester_id" | "requester_email">, who: Pick<ResolvedRequester, "id" | "email">): boolean {
  if (who.id !== null) return t.requester_id === who.id;
  return t.requester_id === null && (t.requester_email ?? "").trim().toLowerCase() === who.email.trim().toLowerCase();
}

/** How a requester is named on the activity line: an account by name; someone outside by name and address. */
function requesterLabel(r: { id: number | null; name: string; email: string }): string {
  const name = (r.name ?? "").trim();
  const email = (r.email ?? "").trim();
  if (r.id !== null) return name || email || "someone";
  if (name && email && name.toLowerCase() !== email.toLowerCase()) return `${name} (${email})`;
  return email || name || "someone";
}

/** 1.20.33 (review M3 b): what a rule's change meets once an agent set the requester by hand. */
export const AGENT_SET_REQUESTER = "an agent set it by hand, so rules leave it as it is";

export class RequesterChangeError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code: RequesterRefusalCode | "merged" | "binned" | "agent_set" | "" = ""
  ) {
    super(message);
  }
}

export interface RequesterActor {
  id: number | null;
  name: string;
  role?: string | null;
  /** As updateTicket's: the line ends "via Claude" / "via API" / "via Claude in the desk". */
  via?: "mcp" | "api" | "claude_desk";
}

export interface ChangeRequesterResult {
  changed: boolean;
  before: HdTicketRow;
  to: ResolvedRequester;
  /** keepCc: whether the previous requester was copied, or why not. */
  cc?: { kept: true } | { kept: false; reason: string };
}

/**
 * Make `pick` the ticket's requester (see the header). Throws RequesterChangeError (the sentence a route says)
 * when the pick can't be a requester or the ticket can't change. Undefined when the ticket doesn't exist.
 * A pick that is already the requester changes nothing (`changed: false`), so a rule that set it settles.
 */
export async function changeRequester(
  ticketId: number,
  pick: RequesterPick | Resolved,
  actor: RequesterActor,
  opts: {
    keepCc?: boolean;
    ctx?: HdHookContext;
    ip?: string | null;
    /** More for the audit entry (an automation's id and name, where the address was found). */
    auditDetails?: Record<string, unknown>;
    outside?: boolean;
    /**
     * 1.20.33 (review M3 b): "agent", a person's change by hand: recorded on the ticket, and from then on no rule
     * changes its requester; "automation": refused (code agent_set) when an agent has set it by hand.
     */
    by?: "agent" | "automation";
  } = {}
): Promise<ChangeRequesterResult | undefined> {
  const resolved = "ok" in pick ? pick : await resolveRequester(pick, { outside: opts.outside });
  if (!resolved.ok) throw new RequesterChangeError(resolved.error, 400, resolved.code);
  const who = resolved.who;
  const now = new Date();
  const name = actor.name || "Someone";
  const suffix = actor.via === "mcp" ? " via Claude" : actor.via === "api" ? " via API" : actor.via === "claude_desk" ? " via Claude in the desk" : "";
  const tx = await withTx(async (client) => {
    const { getTicketRow } = await import("./tickets");
    const before = await getTicketRow(ticketId, client, true);
    if (!before) return undefined;
    if (before.deleted_at) throw new RequesterChangeError(`#${before.number} is in the recycle bin.`, 409, "binned");
    if (before.merged_into) {
      const into = await hqOne<{ number: number }>("SELECT number FROM hd_tickets WHERE id = $1", [before.merged_into], client);
      throw new RequesterChangeError(into ? `#${before.number} was merged into #${into.number}. Change the requester there.` : `#${before.number} was merged into another ticket.`, 409, "merged");
    }
    if (opts.by === "automation" && before.requester_set_by_agent_at) throw new RequesterChangeError(AGENT_SET_REQUESTER, 409, "agent_set");
    if (sameRequester(before, who)) {
      // Confirming the requester by hand still locks it against rules.
      if (opts.by === "agent" && !before.requester_set_by_agent_at) await client.query("UPDATE hd_tickets SET requester_set_by_agent_at = $2 WHERE id = $1", [ticketId, now]);
      return { before, changed: false as const };
    }
    // Portal visibility: an account reads it in Get help; on a portal ticket an unblocked portal contact with the new address takes it over.
    let portalContact: number | null = null;
    if (who.id === null && before.portal_contact_id) {
      portalContact = (await hqOne<{ id: number }>("SELECT id FROM hd_portal_contacts WHERE lower(email) = lower($1) AND blocked = 0", [who.email], client))?.id ?? null;
    }
    await client.query(
      `UPDATE hd_tickets SET requester_id = $2, requester_name = $3, requester_email = $4, portal_contact_id = $5, updated_at = $6${
        opts.by === "agent" ? ", requester_set_by_agent_at = $6" : ""
      } WHERE id = $1`,
      [ticketId, who.id, who.name.slice(0, 200), who.email.slice(0, 320), portalContact, now]
    );
    // The new requester is no CC of their own ticket, and never follows it.
    await client.query(
      `DELETE FROM hd_ticket_ccs WHERE ticket_id = $1 AND NOT account_removed
          AND (($2::int IS NOT NULL AND user_id = $2) OR (user_id IS NULL AND $3 <> '' AND lower(email) = lower($3)))`,
      [ticketId, who.id, who.email]
    );
    if (who.id !== null) await client.query("DELETE FROM hd_ticket_followers WHERE ticket_id = $1 AND user_id = $2", [ticketId, who.id]);
    const lines: { kind: "internal" | "system"; body: string; event: string | null }[] = [];
    const had = before.requester_id !== null || !!before.requester_email;
    const from = requesterLabel({ id: before.requester_id, name: before.requester_name, email: before.requester_email });
    lines.push({
      kind: "internal",
      event: HD_CHANGE_EVENT,
      body: had ? `${mdInline(name)} changed the requester from ${mdInline(from)} to ${mdInline(requesterLabel(who))}${suffix}` : `${mdInline(name)} set the requester to ${mdInline(requesterLabel(who))}${suffix}`,
    });
    let cc: ChangeRequesterResult["cc"];
    if (opts.keepCc && had) {
      const { addCcs } = await import("./ccs");
      const r = await addCcs(
        ticketId,
        [before.requester_id !== null ? { userId: before.requester_id } : { email: before.requester_email, name: before.requester_name }],
        { userId: actor.id, name, via: actor.via ?? "requester_change" },
        client
      );
      if (r.added.length) {
        cc = { kept: true };
        // As addCcs's own line (the requester-visible "added … as CC.").
        lines.push({ kind: "system", event: null, body: `${mdInline(name)} added ${mdInline(r.added[0].name || r.added[0].email)} as CC.` });
      } else cc = { kept: false, reason: r.skipped[0]?.reason ?? "skipped" };
    }
    for (const l of lines) {
      await client.query(
        `INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via, created_at, event) VALUES ($1, $2, $3, $4, $5, 'system', $6, $7)`,
        [ticketId, actor.id, name, l.kind, l.body, now, l.event]
      );
    }
    return { before, changed: true as const, cc };
  });
  if (!tx) return undefined;
  if (!tx.changed) return { changed: false, before: tx.before, to: who };
  const b = tx.before;
  await audit({
    actor: { id: actor.id, name, role: actor.role ?? null },
    action: "helpdesk.ticket.requester_changed",
    targetType: "helpdesk_ticket",
    targetId: ticketId,
    targetLabel: `#${b.number} ${b.subject}`.slice(0, 200),
    details: {
      number: b.number,
      from: { user_id: b.requester_id, name: b.requester_name, email: b.requester_email },
      to: { user_id: who.id, name: who.name, email: who.email },
      ...(resolved.unlinked ? { unlinked: true } : {}),
      ...(opts.keepCc ? { kept_as_cc: tx.cc?.kept === true } : {}),
      ...(actor.via ? { via: actor.via } : {}),
      ...(opts.auditDetails ?? {}),
    },
    ip: opts.ip ?? null,
  });
  logEvent("info", "helpdesk.requester_changed", { ticket: b.number, actor: actor.id, automation: opts.auditDetails?.automation ?? null });
  const { afterTicketUpdated } = await import("./events");
  await afterTicketUpdated(ticketId, { assigneeChangedTo: undefined, solved: false, changed: ["requester"] }, { actorId: actor.id, actorName: name, ...(opts.ctx ?? {}) });
  return { changed: true, before: b, to: who, ...(tx.cc ? { cc: tx.cc } : {}) };
}
