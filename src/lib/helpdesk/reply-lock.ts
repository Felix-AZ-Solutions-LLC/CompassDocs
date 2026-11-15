// Helpdesk 1.20.20: the reply lock. One agent at a time writes a ticket's
// public reply; everyone else's Reply box is read-only ("Sam Lee is
// replying") and every send path refuses their public reply (409, code
// "reply_locked"). Internal notes and field changes are never locked.
// Built on the 1.19.1 collision warnings (lib/helpdesk/presence): the lock
// only counts while its holder's presence row is fresh, so closing the
// ticket (the presence DELETE of its last tab) or going quiet ends it too.
//
// Rules (lib/helpdesk/reply-lock-shared has the wording):
//   take       one transaction: the agent's advisory lock, then the ticket's
//              lock row FOR UPDATE; of concurrent takers exactly one gets it.
//              The desk's composer takes it on the first change to the Reply
//              box. An agent holds at most REPLY_LOCK_MAX_PER_AGENT (3); a
//              fourth releases their oldest (audited by the route).
//   refresh    the holder's composer (any of their tabs; the lock follows the
//              last tab that refreshed it), with how long since the box was
//              last touched (`idle_ms`): idle is measured on the server from
//              that last touch (`touched_at`), not from the heartbeat.
//   expiry     the last touch or heartbeat older than the idle timeout (Desk
//              settings, 2 minutes by default), more than
//              REPLY_LOCK_MAX_HOLD_MINUTES (60) since it was taken without a
//              send, or no presence row within the idle timeout: checked on
//              every read and in every refusal; the minute sweep deletes such
//              rows (lib/periodic hd_reply_locks).
//   release    the holder sends a public reply (in addMessage's transaction,
//              whichever path, whichever tab), empties the box, lets go, or
//              closes the tab that holds it (`tab_id`: closing another tab of
//              theirs leaves it alone). Leads and admins can release one, or
//              all of an agent's (audited).
//   send       addMessage asks inside its transaction with SELECT … FOR SHARE
//              on the lock row, so a take over (FOR UPDATE) waits for an
//              in-flight send and then finds the lock gone (409 LOCK_CHANGED);
//              a send that starts after a take over commits is refused.
//   take over  "Take over a reply" (replies.take_over): Managers and Admins on
//              any ticket they work; anyone else (a Team lead) only on
//              tickets of teams they lead, and never from a Manager or Admin.
//              With a reply capability. The previous holder's composer says
//              so and keeps their text; audited helpdesk.reply_lock.taken_over.
//   exempt     system sends (automations and their macros, via 'system' or no
//              author) unless an agent's action triggered the automation (then
//              the lock is checked against that agent), requesters (Get help,
//              the portal, chat, email, the connector's hd_reply_to_request),
//              drafts (the Claude connector only drafts), imports.
//   off        with the setting off nothing is taken, shown or refused: the
//              1.19.1 behaviour (presence and the send guard) stands alone.
// Server-only.

import "server-only";
import { getSetting, setSetting } from "../db";
import { hq, hqOne, withTx, type HdQueryable } from "./db-core";
import {
  LOCK_CHANGED,
  REPLY_LOCK_CODE,
  REPLY_LOCK_IDLE_DEFAULT_MINUTES,
  REPLY_LOCK_MAX_HOLD_MINUTES,
  REPLY_LOCK_MAX_PER_AGENT,
  lockInitials,
  lockRefusal,
  resolveReplyLockSettings,
  type HdReplyLock,
  type HdLiveLock,
  type HdReplyLockBrief,
  type HdReplyLockSettings,
  type HdReplyLockState,
} from "./reply-lock-shared";

export const HD_REPLY_LOCK_KEY = "helpdesk_reply_lock";
/** pg_advisory_xact_lock(namespace, user id): one agent's takes run one at a time (the cap counts their locks). */
const ADVISORY_NS = 1_201_901;

// --- Settings ----------------------------------------------------------------------------

/** No stored value at all (a database the schema has not reached): off, as for an upgrade. */
const FALLBACK: HdReplyLockSettings = { enabled: false, idle_minutes: REPLY_LOCK_IDLE_DEFAULT_MINUTES };
let cached: { at: number; value: HdReplyLockSettings } | null = null;
const CACHE_MS = 5_000;

export async function getReplyLockSettings(): Promise<HdReplyLockSettings> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const raw = await getSetting(HD_REPLY_LOCK_KEY);
  let stored: unknown = null;
  try {
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    stored = null;
  }
  const value = resolveReplyLockSettings(stored, FALLBACK);
  cached = { at: Date.now(), value };
  return value;
}

/** Save; answers what changed (for the audit row). Switching it off drops every lock at once. */
export async function saveReplyLockSettings(raw: unknown): Promise<{ settings: HdReplyLockSettings; changed: (keyof HdReplyLockSettings)[] } | { error: string }> {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!v) return { error: "Send the settings as an object." };
  if (v.enabled !== undefined && typeof v.enabled !== "boolean") return { error: "enabled is true or false." };
  if (v.idle_minutes !== undefined) {
    const n = Number(v.idle_minutes);
    if (!Number.isInteger(n) || n < 1 || n > 15) return { error: "The idle time is a whole number of minutes from 1 to 15." };
  }
  cached = null;
  const before = await getReplyLockSettings();
  const settings = resolveReplyLockSettings(v, before);
  const changed = (Object.keys(settings) as (keyof HdReplyLockSettings)[]).filter((k) => settings[k] !== before[k]);
  if (changed.length) {
    await setSetting(HD_REPLY_LOCK_KEY, JSON.stringify(settings));
    if (!settings.enabled) await hq("DELETE FROM hd_reply_locks");
  }
  cached = { at: Date.now(), value: settings };
  return { settings, changed };
}

/** Tests and the settings route: forget the cached value. */
export function forgetReplyLockSettings(): void {
  cached = null;
}

// --- The lock ----------------------------------------------------------------------------

/**
 * A lock row is live: touched and heartbeat within the idle timeout, taken
 * less than the maximum hold ago, the holder still on the ticket (presence)
 * and active. The numbers are the settings' integers, written in.
 */
function live(s: HdReplyLockSettings): string {
  const ttl = Math.max(60, Math.floor(s.idle_minutes * 60));
  const hold = REPLY_LOCK_MAX_HOLD_MINUTES * 60;
  return `(l.seen_at > now() - make_interval(secs => ${ttl})
   AND l.touched_at > now() - make_interval(secs => ${ttl})
   AND l.since > now() - make_interval(secs => ${hold})
   AND EXISTS (SELECT 1 FROM hd_ticket_presence p WHERE p.ticket_id = l.ticket_id AND p.user_id = l.user_id AND p.seen_at > now() - make_interval(secs => ${ttl}))
   AND EXISTS (SELECT 1 FROM users lu WHERE lu.id = l.user_id AND lu.status = 'active'))`;
}

export interface LockRow {
  ticket_id: number;
  user_id: number;
  name: string;
  tab_id: string;
  since: string;
  seen_at: string;
  touched_at: string;
  prev_user_id: number | null;
  prev_name: string | null;
  taken_over_at: string | null;
}

const COLS = `l.ticket_id, l.user_id, COALESCE(NULLIF(u.name, ''), u.username) AS name, l.tab_id, l.since, l.seen_at, l.touched_at,
              l.prev_user_id, COALESCE(NULLIF(pu.name, ''), pu.username) AS prev_name, l.taken_over_at`;
const FROM = "hd_reply_locks l JOIN users u ON u.id = l.user_id LEFT JOIN users pu ON pu.id = l.prev_user_id";

function norm<T extends LockRow>(r: T): T {
  return { ...r, ticket_id: Number(r.ticket_id), user_id: Number(r.user_id), prev_user_id: r.prev_user_id == null ? null : Number(r.prev_user_id) };
}

/**
 * The live lock on a ticket, or null (none, gone, or the setting is off).
 * `lock`: inside the caller's transaction, take the row FOR SHARE (a send:
 * a take over waits for it) or FOR UPDATE (a take over, a refresh).
 */
export async function activeReplyLock(ticketId: number, client?: HdQueryable, lock?: "share" | "update"): Promise<LockRow | null> {
  const s = await getReplyLockSettings();
  if (!s.enabled) return null;
  if (lock && client) {
    const row = await hqOne<LockRow & { live: boolean }>(
      `SELECT ${COLS}, ${live(s)} AS live FROM ${FROM} WHERE l.ticket_id = $1 FOR ${lock === "share" ? "SHARE" : "UPDATE"} OF l`,
      [ticketId],
      client
    );
    return row && row.live ? norm(row) : null;
  }
  const row = await hqOne<LockRow>(`SELECT ${COLS} FROM ${FROM} WHERE l.ticket_id = $1 AND ${live(s)}`, [ticketId], client);
  return row ? norm(row) : null;
}

/** Keep the holder's presence row (and this tab in it) alive with the lock. State and `since` stay the heartbeat's. */
async function keepPresence(ticketId: number, userId: number, tabId: string, client: HdQueryable): Promise<void> {
  await hq(
    `INSERT INTO hd_ticket_presence (ticket_id, user_id, state, seen_at, since, tabs)
     VALUES ($1, $2, 'replying', now(), now(), CASE WHEN $3::text = '' THEN '{}'::jsonb ELSE jsonb_build_object($3::text, extract(epoch from now())::bigint) END)
     ON CONFLICT (ticket_id, user_id) DO UPDATE SET seen_at = now(),
       tabs = CASE WHEN $3::text = '' THEN hd_ticket_presence.tabs ELSE hd_ticket_presence.tabs || jsonb_build_object($3::text, extract(epoch from now())::bigint) END`,
    [ticketId, userId, tabId],
    client
  );
}

/** A tab id from a request: short and plain, or none. */
export function cleanTabId(v: unknown): string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(v) ? v : "";
}

export type TakeResult = { ok: true; released: { ticket_id: number; number: number }[] } | { ok: false; holder: LockRow } | { ok: false; off: true };

/**
 * Take the ticket's reply lock for `userId` (from tab `tabId`): theirs when
 * nobody holds it, the holder's lock is gone, or they already hold it (a
 * refresh then, and the lock follows this tab). One transaction with the row
 * FOR UPDATE: of concurrent takers exactly one is answered ok, and ok always
 * means the row is theirs. Over the cap, their oldest other lock is released
 * (`released`, for the route's audit row).
 */
export async function takeReplyLock(ticketId: number, userId: number, tabId = ""): Promise<TakeResult> {
  const s = await getReplyLockSettings();
  if (!s.enabled) return { ok: false, off: true };
  return withTx(async (c): Promise<TakeResult> => {
    await c.query("SELECT pg_advisory_xact_lock($1, $2)", [ADVISORY_NS, userId]);
    await keepPresence(ticketId, userId, tabId, c);
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await hqOne<LockRow & { live: boolean }>(`SELECT ${COLS}, ${live(s)} AS live FROM ${FROM} WHERE l.ticket_id = $1 FOR UPDATE OF l`, [ticketId], c);
      if (cur && cur.live && Number(cur.user_id) !== userId) return { ok: false, holder: norm(cur) };
      if (cur) {
        const mine = cur.live && Number(cur.user_id) === userId;
        await c.query(
          `UPDATE hd_reply_locks SET user_id = $2, tab_id = CASE WHEN $3::text = '' THEN tab_id ELSE $3::text END, seen_at = now(), touched_at = now(),
                  since = CASE WHEN $4::boolean THEN since ELSE now() END,
                  prev_user_id = CASE WHEN $4::boolean THEN prev_user_id ELSE NULL END,
                  taken_over_at = CASE WHEN $4::boolean THEN taken_over_at ELSE NULL END
            WHERE ticket_id = $1`,
          [ticketId, userId, tabId, mine]
        );
      } else {
        const ins = await c.query(
          `INSERT INTO hd_reply_locks (ticket_id, user_id, tab_id, since, seen_at, touched_at) VALUES ($1, $2, $3, now(), now(), now())
           ON CONFLICT (ticket_id) DO NOTHING RETURNING ticket_id`,
          [ticketId, userId, tabId]
        );
        // Someone else inserted it a moment ago (their transaction has committed now): look again, under the row lock.
        if (!ins.rowCount) continue;
      }
      return { ok: true, released: await capLocks(c, s, userId, ticketId) };
    }
    // Rounds of someone else inserting and releasing in between: never "ok" without the row; say who has it.
    const holder = await hqOne<LockRow>(`SELECT ${COLS} FROM ${FROM} WHERE l.ticket_id = $1`, [ticketId], c);
    return {
      ok: false,
      holder: holder
        ? norm(holder)
        : { ticket_id: ticketId, user_id: 0, name: "Someone", tab_id: "", since: "", seen_at: "", touched_at: "", prev_user_id: null, prev_name: null, taken_over_at: null },
    };
  });
}

/** Over the cap: release the agent's oldest live locks on other tickets (in the take's transaction). */
async function capLocks(c: HdQueryable, s: HdReplyLockSettings, userId: number, keep: number): Promise<{ ticket_id: number; number: number }[]> {
  const mine = await hq<{ ticket_id: number; number: number }>(
    `SELECT l.ticket_id, t.number FROM hd_reply_locks l JOIN hd_tickets t ON t.id = l.ticket_id
      WHERE l.user_id = $1 AND l.ticket_id <> $2 AND ${live(s)}
      ORDER BY l.since, l.ticket_id`,
    [userId, keep],
    c
  );
  const over = mine.length - (REPLY_LOCK_MAX_PER_AGENT - 1);
  if (over <= 0) return [];
  const drop = mine.slice(0, over).map((r) => ({ ticket_id: Number(r.ticket_id), number: Number(r.number) }));
  await hq("DELETE FROM hd_reply_locks WHERE user_id = $1 AND ticket_id = ANY($2::int[])", [userId, drop.map((d) => d.ticket_id)], c);
  return drop;
}

/**
 * The holder's heartbeat from tab `tabId`: true while they still hold a live
 * lock (never takes a free one). `idleMs` is how long since the Reply box was
 * last touched in that tab: `touched_at` moves to then (never backwards), so
 * idle is the server's measure. Without it (an older client) the last touch
 * stays where it was.
 */
export async function refreshReplyLock(ticketId: number, userId: number, tabId = "", idleMs?: number): Promise<boolean> {
  const s = await getReplyLockSettings();
  if (!s.enabled) return false;
  const idle = idleMs === undefined || !Number.isFinite(idleMs) ? null : Math.min(Math.max(0, Math.floor(idleMs)), 86_400_000);
  return withTx(async (c) => {
    // Presence first (its key share on the ticket row), then the lock row: the order addMessage's send locks them in
    // reverse would otherwise deadlock (it holds the ticket FOR UPDATE, then the lock row FOR SHARE).
    await keepPresence(ticketId, userId, tabId, c);
    const cur = await activeReplyLock(ticketId, c, "update");
    if (!cur || cur.user_id !== userId) return false;
    await c.query(
      `UPDATE hd_reply_locks SET seen_at = now(), tab_id = CASE WHEN $3::text = '' THEN tab_id ELSE $3::text END,
              touched_at = CASE WHEN $4::bigint IS NULL THEN touched_at ELSE GREATEST(touched_at, now() - make_interval(secs => $4::bigint / 1000.0)) END
        WHERE ticket_id = $1 AND user_id = $2`,
      [ticketId, userId, tabId, idle]
    );
    return true;
  });
}

/**
 * Drop `userId`'s lock on the ticket. With `tabId` (the composer's let go,
 * emptied box, closed tab), only while that tab holds it: another tab of
 * theirs closing leaves it alone. Without (a send), whichever tab. Works
 * whatever the setting.
 */
export async function releaseReplyLock(ticketId: number, userId: number, client?: HdQueryable, tabId?: string): Promise<boolean> {
  const r = await hq(
    `DELETE FROM hd_reply_locks WHERE ticket_id = $1 AND user_id = $2 AND ($3::text IS NULL OR $3::text = '' OR tab_id = '' OR tab_id = $3::text) RETURNING ticket_id`,
    [ticketId, userId, tabId ?? null],
    client
  );
  return r.length > 0;
}

/**
 * The pop-out seam (1.20.18): move this agent's lock from tab `fromTab` to tab
 * `toTab` in one statement, so the pane closing afterwards releases nothing.
 */
export async function handOffReplyLock(ticketId: number, userId: number, fromTab: string, toTab: string): Promise<boolean> {
  const s = await getReplyLockSettings();
  if (!s.enabled || !toTab) return false;
  const r = await hq(
    `UPDATE hd_reply_locks l SET tab_id = $4, seen_at = now() WHERE l.ticket_id = $1 AND l.user_id = $2 AND (l.tab_id = $3 OR l.tab_id = '') AND ${live(s)} RETURNING l.ticket_id`,
    [ticketId, userId, fromTab, toTab]
  );
  return r.length > 0;
}

/**
 * Take the lock over from `expectFrom`, its live holder (the route has checked
 * that the caller may take it from them). One transaction with the row FOR
 * UPDATE, so an in-flight send (FOR SHARE) finishes first: if it sent (or the
 * lock moved for any other reason) the answer is 409 LOCK_CHANGED and nothing
 * moves. `from` is who had it; null when the caller already held it.
 */
export async function takeOverReplyLock(
  ticketId: number,
  userId: number,
  expectFrom: number,
  tabId = ""
): Promise<{ ok: true; from: { id: number; name: string } | null } | { ok: false; status: 409; error: string }> {
  const s = await getReplyLockSettings();
  if (!s.enabled) return { ok: false, status: 409, error: "Reply locks are off." };
  return withTx(async (c): Promise<{ ok: true; from: { id: number; name: string } | null } | { ok: false; status: 409; error: string }> => {
    // Presence first (see refreshReplyLock): then an in-flight send is waited for, never deadlocked with.
    await keepPresence(ticketId, userId, tabId, c);
    const cur = await activeReplyLock(ticketId, c, "update");
    if (cur && cur.user_id === userId) return { ok: true, from: null };
    if (!cur || cur.user_id !== expectFrom) return { ok: false, status: 409, error: LOCK_CHANGED };
    await c.query(
      `UPDATE hd_reply_locks SET user_id = $2, tab_id = $3, since = now(), seen_at = now(), touched_at = now(), prev_user_id = $4, taken_over_at = now()
        WHERE ticket_id = $1`,
      [ticketId, userId, tabId, cur.user_id]
    );
    return { ok: true, from: { id: cur.user_id, name: cur.name } };
  });
}

/**
 * The refusal for a public reply by `userId` on a ticket someone else holds
 * (null = go ahead: no lock, theirs, or the setting is off). Every send path
 * asks it; with `client` (addMessage, review approval) inside the caller's
 * transaction, holding the lock row FOR SHARE until it commits.
 */
export async function replyLockCheck(
  ticketId: number,
  userId: number | null,
  client?: HdQueryable
): Promise<{ status: 409; error: string; code: typeof REPLY_LOCK_CODE; holder: { user_id: number; name: string } } | null> {
  if (!userId) return null;
  const cur = await activeReplyLock(ticketId, client, client ? "share" : undefined);
  if (!cur || cur.user_id === userId) return null;
  return { status: 409, error: lockRefusal(cur.name), code: REPLY_LOCK_CODE, holder: { user_id: cur.user_id, name: cur.name } };
}

// --- Release by a lead or admin -------------------------------------------------------------


/** Every live lock (Desk settings → Reply lock), oldest first. */
export async function liveReplyLocks(): Promise<HdLiveLock[]> {
  const s = await getReplyLockSettings();
  if (!s.enabled) return [];
  const rows = await hq<HdLiveLock>(
    `SELECT l.ticket_id, t.number, t.subject, t.team_id, l.user_id, COALESCE(NULLIF(u.name, ''), u.username) AS name, l.since, l.touched_at
       FROM hd_reply_locks l JOIN hd_tickets t ON t.id = l.ticket_id AND t.deleted_at IS NULL JOIN users u ON u.id = l.user_id
      WHERE ${live(s)} ORDER BY l.since, l.ticket_id LIMIT 500`
  );
  return rows.map((r) => ({ ...r, ticket_id: Number(r.ticket_id), number: Number(r.number), user_id: Number(r.user_id), since: iso(r.since), touched_at: iso(r.touched_at) }));
}

/** Release one ticket's lock (whoever holds it) or every lock of one agent. Answers what went, for the audit row. */
export async function forceReleaseReplyLocks(target: { ticketId: number } | { userId: number }): Promise<{ ticket_id: number; number: number; user_id: number; name: string }[]> {
  const byTicket = "ticketId" in target;
  const rows = await hq<{ ticket_id: number; number: number; user_id: number; name: string }>(
    `DELETE FROM hd_reply_locks l USING hd_tickets t, users u
      WHERE t.id = l.ticket_id AND u.id = l.user_id AND ${byTicket ? "l.ticket_id = $1" : "l.user_id = $1"}
      RETURNING l.ticket_id, t.number, l.user_id, COALESCE(NULLIF(u.name, ''), u.username) AS name`,
    [byTicket ? target.ticketId : target.userId]
  );
  return rows.map((r) => ({ ticket_id: Number(r.ticket_id), number: Number(r.number), user_id: Number(r.user_id), name: r.name }));
}

// --- Views -----------------------------------------------------------------------------------

/** Each person's picture: the directory photo when there is one and the viewer may see photos, else their account picture. */
async function photosFor(userIds: number[], viewer: { id: number; role: import("../types").Role }): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!userIds.length) return out;
  const { userHolds } = await import("../access");
  const readPhoto = await userHolds(viewer, "directory.photo_read", { legacyMin: "viewer" }).catch(() => false);
  const rows = await hq<{ id: number; avatar: string; dir_id: number | null; dir_updated: string | null }>(
    `SELECT u.id, u.avatar, p.id AS dir_id, p.updated_at AS dir_updated
       FROM users u
       LEFT JOIN LATERAL (
         SELECT p.id, p.updated_at FROM directory_people p
          WHERE p.hidden = 0 AND p.photo <> '' AND (p.id = u.directory_person_id OR (u.directory_person_id IS NULL AND u.email <> '' AND lower(p.email) = lower(u.email)))
          ORDER BY (p.id = u.directory_person_id) DESC NULLS LAST, p.id LIMIT 1
       ) p ON true
      WHERE u.id = ANY($1::int[])`,
    [userIds]
  );
  for (const r of rows) {
    if (readPhoto && r.dir_id) out.set(Number(r.id), `/api/directory/${r.dir_id}/photo?v=${Math.floor((Date.parse(String(r.dir_updated)) || 0) / 1000)}`);
    else if (r.avatar && r.avatar.startsWith("data:image/") && r.avatar.length < 96_000) out.set(Number(r.id), r.avatar);
  }
  return out;
}

const iso = (v: unknown): string => {
  if (v instanceof Date) return v.toISOString();
  const t = Date.parse(String(v ?? ""));
  return Number.isNaN(t) ? String(v ?? "") : new Date(t).toISOString();
};

/**
 * What one agent sees of a ticket's lock (GET/POST …/reply-lock). `team_id` is the ticket's, for "Take over".
 * `tab`: the asking browser tab, so the holder's tabs know which of them holds it (`this_tab`).
 */
export async function replyLockState(ticket: { id: number; team_id: number | null }, viewer: import("../types").SessionUser, tab = ""): Promise<HdReplyLockState> {
  const s = await getReplyLockSettings();
  if (!s.enabled) return { enabled: false, idle_minutes: s.idle_minutes, lock: null, taken_from_you: null };
  const cur = await activeReplyLock(ticket.id);
  if (!cur) return { enabled: true, idle_minutes: s.idle_minutes, lock: null, taken_from_you: null };
  const mine = cur.user_id === viewer.id;
  const photos = await photosFor([cur.user_id], viewer);
  const lock: HdReplyLock = {
    user_id: cur.user_id,
    name: cur.name,
    initials: lockInitials(cur.name),
    photo_url: photos.get(cur.user_id) ?? null,
    since: iso(cur.since),
    seen_at: iso(cur.seen_at),
    mine,
    ...(mine ? { this_tab: !tab || !cur.tab_id || cur.tab_id === tab } : {}),
    can_take_over: !mine && (await mayTakeOver(viewer, ticket.team_id, cur.user_id)),
  };
  const takenFromYou = !mine && cur.prev_user_id === viewer.id && cur.taken_over_at ? { by_user_id: cur.user_id, by_name: cur.name, at: iso(cur.taken_over_at) } : null;
  return { enabled: true, idle_minutes: s.idle_minutes, lock, taken_from_you: takenFromYou };
}

/**
 * May `viewer` take a reply over (or release it) on a ticket of `teamId` from
 * `holderId`? "Take over a reply" and a reply capability there; then Managers
 * and Admins on any ticket they work; anyone else (a Team lead) only in teams
 * they lead, and never from a Manager or Admin.
 */
export async function mayTakeOver(viewer: import("../types").SessionUser, teamId: number | null, holderId?: number | null): Promise<boolean> {
  const { hdCan, hdLeadTeamIds, hdRoleOf } = await import("./roles");
  const { HD_ROLE_RANK } = await import("./roles-shared");
  if (!(await hdCan(viewer, "replies.take_over"))) return false;
  if (!(await hdCan(viewer, "tickets.reply_public", { teamId })) && !(await hdCan(viewer, "tickets.reply_needs_review", { teamId }))) return false;
  const rank = HD_ROLE_RANK[(await hdRoleOf(viewer))?.role ?? "newbie"];
  if (rank >= HD_ROLE_RANK.manager) return true;
  if (teamId === null || !(await hdLeadTeamIds(viewer.id)).includes(teamId)) return false;
  if (holderId) {
    const holder = await hdRoleOf(holderId);
    if (holder && HD_ROLE_RANK[holder.role] >= HD_ROLE_RANK.manager) return false;
  }
  return true;
}

/** The live locks among `numbers` the viewer works (the queue's row badges). */
export async function replyLockBriefs(viewer: import("../types").SessionUser, numbers: number[]): Promise<{ enabled: boolean; locks: HdReplyLockBrief[] }> {
  const s = await getReplyLockSettings();
  if (!s.enabled || !numbers.length) return { enabled: s.enabled, locks: [] };
  const rows = await hq<{ number: number; requester_id: number | null; team_id: number | null; assignee_id: number | null; ticket_id: number; user_id: number; name: string; since: string }>(
    `SELECT t.number, t.requester_id, t.team_id, t.assignee_id, l.ticket_id, l.user_id, COALESCE(NULLIF(u.name, ''), u.username) AS name, l.since
       FROM hd_reply_locks l JOIN hd_tickets t ON t.id = l.ticket_id AND t.deleted_at IS NULL JOIN users u ON u.id = l.user_id
      WHERE t.number = ANY($1::int[]) AND ${live(s)}
      ORDER BY t.number`,
    [numbers]
  );
  const { canWorkTicket } = await import("./access");
  const seen: typeof rows = [];
  for (const r of rows) {
    if (await canWorkTicket(viewer, { id: Number(r.ticket_id), requester_id: r.requester_id, team_id: r.team_id, assignee_id: r.assignee_id })) seen.push(r);
  }
  const photos = await photosFor([...new Set(seen.map((r) => Number(r.user_id)))], viewer);
  return {
    enabled: true,
    locks: seen.map((r) => ({
      number: Number(r.number),
      user_id: Number(r.user_id),
      name: r.name,
      initials: lockInitials(r.name),
      photo_url: photos.get(Number(r.user_id)) ?? null,
      since: iso(r.since),
      mine: Number(r.user_id) === viewer.id,
    })),
  };
}

/** The periodic sweep: delete locks that are no longer live (or every lock while the setting is off). */
export async function sweepReplyLocks(): Promise<number> {
  const s = await getReplyLockSettings();
  if (!s.enabled) return (await hq("DELETE FROM hd_reply_locks RETURNING ticket_id")).length;
  const rows = await hq(`DELETE FROM hd_reply_locks l WHERE NOT ${live(s)} RETURNING l.ticket_id`);
  return rows.length;
}
