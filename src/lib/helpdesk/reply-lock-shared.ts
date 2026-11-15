// Helpdesk 1.20.20: the reply lock, the parts the desk's client code and the
// server share. Dependency-free.
//
// The first agent who starts a public reply on a ticket (the first change
// they make to the Reply box: a keystroke, a paste, a macro, canned response
// or article inserted, a Claude draft used, a file attached) takes the
// ticket's reply lock. While they hold it nobody else can send a public
// reply on that ticket, by any path; internal notes and field changes are
// never locked. The lock goes when the holder sends, empties the Reply box,
// lets go, closes the ticket (or its window), or is idle for the desk's
// idle timeout. Team leads of the ticket's team, managers and admins (the
// "Take over a reply" capability) can take it over.

export const REPLY_LOCK_IDLE_DEFAULT_MINUTES = 2;
export const REPLY_LOCK_IDLE_MIN_MINUTES = 1;
export const REPLY_LOCK_IDLE_MAX_MINUTES = 15;
/** How often an open ticket asks who holds its reply (while the tab is visible). */
export const REPLY_LOCK_POLL_MS = 4_000;
/** How often the holder's composer refreshes its lock while it is in use. */
export const REPLY_LOCK_REFRESH_MS = 15_000;
/** The 409's `code` when a reply is refused because someone else holds the lock. */
export const REPLY_LOCK_CODE = "reply_locked";
/** 1.20.20 review: an agent holds at most this many live locks; a new one releases their oldest (audited). */
export const REPLY_LOCK_MAX_PER_AGENT = 3;
/** 1.20.20 review: a lock never lasts longer than this without a send, however busy its heartbeat claims to be. */
export const REPLY_LOCK_MAX_HOLD_MINUTES = 60;
/** The take over's answer when the lock moved (sent, let go, someone else) between the confirm and the click. */
export const LOCK_CHANGED = "Someone else changed the reply just now. Look again.";

export interface HdReplyLockSettings {
  enabled: boolean;
  /** Minutes without a heartbeat (or a touch of the Reply box) before the lock goes by itself. */
  idle_minutes: number;
}

/** Fill and clamp a stored or sent value. Never throws. */
export function resolveReplyLockSettings(raw: unknown, fallback: HdReplyLockSettings = { enabled: false, idle_minutes: REPLY_LOCK_IDLE_DEFAULT_MINUTES }): HdReplyLockSettings {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const n = Number(v.idle_minutes);
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : fallback.enabled,
    idle_minutes: Number.isInteger(n) && n >= REPLY_LOCK_IDLE_MIN_MINUTES && n <= REPLY_LOCK_IDLE_MAX_MINUTES ? n : fallback.idle_minutes,
  };
}

/** Who holds a ticket's reply, as one viewer sees it. */
export interface HdReplyLock {
  user_id: number;
  name: string;
  initials: string;
  /** Their photo: the directory's when it has one (and the viewer may see photos), else their account picture; null for initials. */
  photo_url: string | null;
  /** When they took it (ISO). */
  since: string;
  /** Their last heartbeat (ISO). */
  seen_at: string;
  /** The viewer holds it. */
  mine: boolean;
  /** 1.20.20 (pop-out): for the holder, whether the asking tab is the one that holds it (another tab of theirs, or the reply's pop-out, may). */
  this_tab?: boolean;
  /** The viewer may take it over (not their own; "Take over a reply" in the ticket's team). */
  can_take_over: boolean;
}

/** GET/POST /api/helpdesk/tickets/[n]/reply-lock. */
export interface HdReplyLockState {
  enabled: boolean;
  idle_minutes: number;
  lock: HdReplyLock | null;
  /** For the person a lead took the reply from, while the lead holds it. */
  taken_from_you?: { by_user_id: number; by_name: string; at: string } | null;
}

/** A live lock on Desk settings → Reply lock (who holds which reply now). */
export interface HdLiveLock {
  ticket_id: number;
  number: number;
  subject: string;
  team_id: number | null;
  user_id: number;
  name: string;
  since: string;
  /** Their last edit of the reply. */
  touched_at: string;
}

/** One locked ticket for the queue's rows (GET /api/helpdesk/reply-locks). */
export interface HdReplyLockBrief {
  number: number;
  user_id: number;
  name: string;
  initials: string;
  photo_url: string | null;
  since: string;
  mine: boolean;
}

const first = (n: string) => n.trim().split(/\s+/)[0] || n;

/** "Sam Lee is replying" (the locked Reply box's sentence). */
export function lockSentence(name: string): string {
  return `${name} is replying`;
}

/** The refusal every send path answers with (409, `code` REPLY_LOCK_CODE). */
export function lockRefusal(name: string): string {
  return `${name} is replying to this ticket, so your reply wasn't sent. You can still add an internal note.`;
}

/** The previous holder's notice in their composer. */
export function takenOverNotice(byName: string): string {
  return `${first(byName)} took over this reply. Your text is kept as a draft.`;
}

/** An agent's emailed reply that met someone else's lock: kept as a note, never sent to the requester. */
export function emailedWhileLocked(holder: string): string {
  return `Sent by email while ${holder} was replying, so it was added as an internal note and not sent to the requester.`;
}

/** "Ana Ruiz" → "AR" (UserAvatar's rule). */
export function lockInitials(name: string): string {
  const letters = name
    .split(/\s+/)
    .map((p) => p.replace(/^[^\p{L}\p{N}]+/u, "")[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return letters || name.trim().slice(0, 1) || "?";
}
