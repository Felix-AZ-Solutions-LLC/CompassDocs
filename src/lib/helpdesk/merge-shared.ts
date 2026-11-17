// Helpdesk 1.19.1: merge and bulk edit pieces the desk (client) and the
// server share (agent V2), so the dialog previews exactly what the server
// writes. No server imports here.

/** Tickets merged into one at a time. */
export const MERGE_MAX = 50;
/** Tickets one bulk edit may change. */
export const BULK_MAX = 200;

/** The requester-facing sentence on a merged request (the dialog previews it). */
export function mergedNote(keepNumber: number): string {
  return `Your request has been joined with #${keepNumber} so one person can help with both.`;
}

/** "#1051", "#1051 and #1052", "#1051, #1052 and #1053". */
export function listNumbers(numbers: number[]): string {
  const s = numbers.map((n) => `#${n}`);
  return s.length <= 1 ? s.join("") : `${s.slice(0, -1).join(", ")} and ${s[s.length - 1]}`;
}

/** "Priya Natarajan", "Priya Natarajan and Daniel Okafor", "A, B and C". */
export function listNames(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What the ticket pane shows about merges (agents only). */
export interface HdMergeInfo {
  /** This ticket was merged into … */
  /** `deleted`: it is in the recycle bin (1.19.4): show "a deleted ticket", never its number or subject. */
  into: { number: number; subject: string; deleted?: boolean } | null;
  /** … and these were merged into this one. */
  merged_in: { number: number; subject: string }[];
  /** Message id → the number of the ticket it came from ("from #1051"). */
  message_origins: Record<number, number>;
}

/** POST /api/helpdesk/tickets/bulk patch. */
export interface HdBulkPatch {
  status?: string;
  priority?: string;
  team_id?: number | null;
  assignee_id?: number | null;
  add_tags?: string[];
  remove_tags?: string[];
}

/** One ticket's outcome in a bulk edit. */
export interface HdBulkResult {
  number: number;
  ok: boolean;
  /** Why it was skipped. */
  error?: string;
  /** The fields that changed (ok with [] = already as asked). */
  changed?: string[];
}

// --- Merging across requesters (1.20.27, security review app H2) ---------------------
//
// A merge moves the merged tickets' public conversations and files onto the
// kept ticket, and their requesters become CCs there, so when the tickets
// came from DIFFERENT people each will see the other's conversation. The
// owner chose to keep that behaviour (merging two clients' "VPN down" can be
// right) and to say so plainly: the merge dialog names both sides before the
// agent confirms, the API answers the same facts (a preview, and on the
// merge itself), and the audit row records it. Nothing is blocked.

/** Who a ticket is from, as the merge warning compares them. */
export interface MergeParty {
  number: number;
  requester_id: number | null;
  requester_name: string;
  requester_email?: string | null;
}

/** One requester the merge brings together: their name, email and tickets. */
export interface MergeRequester {
  name: string;
  email: string;
  numbers: number[];
}

export interface CrossRequesterWarning {
  /** Every distinct requester, the kept ticket's first. */
  requesters: MergeRequester[];
  /** The dialog's sentence, naming them. */
  text: string;
}

/** The identity two tickets share when they come from the same person: the account, else the email address. */
function partyKey(p: MergeParty): string {
  if (p.requester_id) return `u:${p.requester_id}`;
  const email = (p.requester_email || "").trim().toLowerCase();
  return email ? `e:${email}` : `t:${p.number}`;
}

/**
 * Null when every ticket is from the same requester; otherwise who they are
 * and the warning to show. An account and an email-only requester with the
 * same address count as one person.
 */
export function crossRequesterWarning(keep: MergeParty, others: MergeParty[]): CrossRequesterWarning | null {
  const byKey = new Map<string, MergeRequester>();
  const emailOf = new Map<string, string>();
  for (const p of [keep, ...others]) {
    let key = partyKey(p);
    const email = (p.requester_email || "").trim().toLowerCase();
    // An account and a mail-only requester with one address are one person.
    if (email && emailOf.has(email)) key = emailOf.get(email)!;
    if (email && !emailOf.has(email)) emailOf.set(email, key);
    const r = byKey.get(key) ?? { name: p.requester_name || p.requester_email || "Unknown requester", email: p.requester_email || "", numbers: [] };
    r.numbers.push(p.number);
    byKey.set(key, r);
  }
  if (byKey.size < 2) return null;
  const requesters = [...byKey.values()];
  const names = requesters.map((r) => r.name);
  const text =
    requesters.length === 2
      ? `These tickets are from different people: ${names[0]} and ${names[1]}. Once merged, each will see the other's conversation and files, and both will get the replies.`
      : `These tickets are from ${requesters.length} different people: ${listNames(names)}. Once merged, each will see the others' conversations and files, and all of them will get the replies.`;
  return { requesters, text };
}
