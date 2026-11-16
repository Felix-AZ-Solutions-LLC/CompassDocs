// Helpdesk 1.20.25: Desk settings → Email → Who can write in, the pure half
// of two settings the inbound pipeline (lib/helpdesk/inbound) and the
// Microsoft 365 intake (lib/helpdesk/m365/mail) both read:
//
//   trusted senders    whole addresses (docketing@firm.com) and "@domain"
//                      entries (@firm.com: that domain exactly, not its
//                      subdomains). Their mail, once its From passed the
//                      sender check, is never dropped as automatic mail and
//                      is held to a generous hard ceiling instead of the
//                      per-sender limit. Loop protection, duplicates and
//                      the sender check still apply.
//   per-sender limit   how many messages one sender may send in ten
//                      minutes before the rest wait (default 20).
//
// No database, no server-only imports: the settings page validates with the
// same functions the API does.

export const INBOUND_SENDER_LIMITS = {
  /** The per-sender limit's default, range and window. */
  perSender: 20,
  perSenderMin: 5,
  perSenderMax: 200,
  windowMinutes: 10,
  /** A trusted sender's hard ceiling per window, so a scanner gone wrong still cannot bury the desk. */
  trustedCeiling: 300,
  /** At most this many trusted entries. */
  trustedMax: 100,
} as const;

const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DOMAIN = /^@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** One trusted entry as stored (lower-cased, trimmed), or null when it is neither an address nor "@domain". */
export function cleanTrustedEntry(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v || v.length > 254) return null;
  return ADDRESS.test(v) || DOMAIN.test(v) ? v : null;
}

/**
 * The list as stored: one entry per line (or comma), cleaned, without
 * repeats. `problem` names the first entry that is neither an address nor
 * "@domain", or a list that is too long ('' = fine).
 */
export function cleanTrustedSenders(raw: unknown): { list: string[]; problem: string } {
  const items = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : typeof raw === "string" ? raw.split(/[\n,;]+/) : [];
  const list: string[] = [];
  for (const item of items) {
    if (!item.trim()) continue;
    const v = cleanTrustedEntry(item);
    if (!v) return { list: [], problem: `"${item.trim().slice(0, 80)}" isn't an email address or a domain written as @example.com.` };
    if (!list.includes(v)) list.push(v);
  }
  if (list.length > INBOUND_SENDER_LIMITS.trustedMax) return { list: [], problem: `List up to ${INBOUND_SENDER_LIMITS.trustedMax} trusted senders.` };
  return { list, problem: "" };
}

/** The sender addresses the automatic-mail rule names by themselves (bounces, no-reply senders). */
const ROBOT_SENDER = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i;

/**
 * Whether an address is on the list: the whole address, or "@" and its
 * domain exactly. A domain entry never covers that domain's bounce and
 * no-reply senders (mailer-daemon@, postmaster@, no-reply@, do-not-reply@):
 * only that exact address, listed, does.
 */
export function trustedSenderListed(address: string, list: readonly string[]): boolean {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 1) return false;
  return list.includes(a) || (!ROBOT_SENDER.test(a) && list.includes(a.slice(at)));
}

/** Why a per-sender limit is refused ('' = fine). */
export function perSenderLimitProblem(raw: unknown): string {
  const n = Number(raw);
  if (typeof raw === "boolean" || raw === null || raw === "" || !Number.isInteger(n) || n < INBOUND_SENDER_LIMITS.perSenderMin || n > INBOUND_SENDER_LIMITS.perSenderMax) {
    return `The limit per sender is a whole number from ${INBOUND_SENDER_LIMITS.perSenderMin} to ${INBOUND_SENDER_LIMITS.perSenderMax}.`;
  }
  return "";
}

/** A stored limit as read: anything out of range is the default. */
export function clampPerSenderLimit(raw: unknown): number {
  return raw !== undefined && !perSenderLimitProblem(raw) ? Number(raw) : INBOUND_SENDER_LIMITS.perSender;
}
