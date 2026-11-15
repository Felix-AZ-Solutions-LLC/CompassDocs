// Helpdesk 1.20.18 (the reply pop-out's security review): a send's
// idempotency key. The desk's composer sends `client_send_id` with POST
// /api/helpdesk/tickets/[number]/messages and keeps the same key until the
// send goes through, so the same reply sent twice (a pop-out closed while
// its send was on the way, then sent again from the desk) posts once: the
// repeat answers 200 with the first message and `duplicate: true`.
//
// hd_message_send_ids (presence-schema) holds one row per agent, ticket and
// key. claimSend inserts it (message_id NULL) before anything is written,
// so two requests racing with one key cannot both post; completeSend fills
// in the message; releaseSend deletes the claim when nothing was posted (a
// refusal, a collision warning, an error). A claim left unfinished for two
// minutes (a crash between the two) may be claimed again. Rows are kept a
// day (sweepSendIds, run by the presence sweep). They hold no message text.
// Server-only.

import "server-only";
import { hq } from "./db-core";

/** How long a finished key is remembered. */
export const SEND_ID_KEEP_SECONDS = 24 * 60 * 60;
/** An unfinished claim older than this is taken to be abandoned. */
export const SEND_ID_STALE_SECONDS = 120;

const SEND_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** The body's client_send_id: null when absent, "bad" when malformed. */
export function cleanSendId(v: unknown): string | null | "bad" {
  if (v === undefined || v === null || v === "") return null;
  return typeof v === "string" && SEND_ID_RE.test(v) ? v : "bad";
}

export type SendClaim = { claimed: true } | { claimed: false; messageId: number | null };

/** Claim the key for this send. Not claimed: an earlier send with it finished (messageId) or is still going (null). */
export async function claimSend(userId: number, ticketId: number, sendId: string): Promise<SendClaim> {
  const rows = await hq<{ message_id: number | null; claimed: boolean }>(
    `INSERT INTO hd_message_send_ids (user_id, ticket_id, client_send_id) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, ticket_id, client_send_id) DO UPDATE
       SET created_at = now()
       WHERE hd_message_send_ids.message_id IS NULL
         AND hd_message_send_ids.created_at < now() - make_interval(secs => $4)
     RETURNING message_id, true AS claimed`,
    [userId, ticketId, sendId, SEND_ID_STALE_SECONDS]
  );
  if (rows.length) return { claimed: true };
  const found = await hq<{ message_id: number | null }>(
    "SELECT message_id FROM hd_message_send_ids WHERE user_id = $1 AND ticket_id = $2 AND client_send_id = $3",
    [userId, ticketId, sendId]
  );
  return { claimed: false, messageId: found[0]?.message_id ?? null };
}

/** The key's message, if a send with it already finished. */
export async function sentWith(userId: number, ticketId: number, sendId: string): Promise<number | null> {
  const r = await hq<{ message_id: number | null }>(
    "SELECT message_id FROM hd_message_send_ids WHERE user_id = $1 AND ticket_id = $2 AND client_send_id = $3 AND message_id IS NOT NULL",
    [userId, ticketId, sendId]
  );
  return r[0]?.message_id ?? null;
}

export async function completeSend(userId: number, ticketId: number, sendId: string, messageId: number): Promise<void> {
  await hq("UPDATE hd_message_send_ids SET message_id = $4 WHERE user_id = $1 AND ticket_id = $2 AND client_send_id = $3", [userId, ticketId, sendId, messageId]);
}

/** Nothing was posted: the key may be used again. */
export async function releaseSend(userId: number, ticketId: number, sendId: string): Promise<void> {
  await hq("DELETE FROM hd_message_send_ids WHERE user_id = $1 AND ticket_id = $2 AND client_send_id = $3 AND message_id IS NULL", [userId, ticketId, sendId]);
}

/** Forget keys older than a day. */
export async function sweepSendIds(now: Date = new Date()): Promise<number> {
  const r = await hq<{ ticket_id: number }>(
    "DELETE FROM hd_message_send_ids WHERE created_at < $1::timestamptz - make_interval(secs => $2) RETURNING ticket_id",
    [now.toISOString(), SEND_ID_KEEP_SECONDS]
  );
  return r.length;
}
