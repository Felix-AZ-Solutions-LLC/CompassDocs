// Helpdesk 1.20.28: field-change lines written before 1.20.28 get their
// marker, once, at the upgrade (lib/db initialize, guarded by a settings
// flag). Since 1.20.28 updateTicket marks each change line it writes with
// hd_messages.event 'change' (lib/helpdesk/conversation-shared), which the
// desk draws as an activity line; older lines had no marker and drew as big
// internal-note cards. This is the one place a line's text is matched: an
// internal, via 'system', unmarked line whose body is exactly the author's
// escaped name, a space and one of updateTicket's own sentences, on one line.
// A note someone wrote, an automation's "add an internal note" text and every
// other feature's line keep their card. The language and event lines (their
// own writers mark theirs since 1.20.28 too) are change lines as well. It
// runs after boot, outside the boot lock, in batches; done once it finishes.

import { mdInline } from "./md-inline";
import { HD_CHANGE_EVENT } from "./conversation-shared";

/** updateTicket's sentences (and the custom-field, event-setup and solve-details lines it carries), after the name. */
const VERBS = [
  /^renamed the ticket from "/,
  /^moved the ticket to /,
  /^took the ticket out of its team(?: via |$)/,
  /^took the ticket(?: via |$)/,
  /^assigned the ticket to /,
  /^unassigned the ticket(?: via |$)/,
  /^set the (?:sub-)?category to /,
  /^cleared the (?:sub-)?category(?: via |$)/,
  /^changed the priority from \S+ to \S+/,
  /^marked the event setup (?:as not )?complete(?: via |$)/,
  // 1.20.28 review: the other writers of change lines (lib/helpdesk/skills/store, lib/helpdesk/desk-calendar).
  /^changed the language from /,
  /^(?:added an event|changed the event): /,
  /^removed the event \(/,
  /^filled in the solve details: /,
  // A custom field: "set Asset tag to LT-0042", "cleared Asset tag".
  /^set .+ to /,
  /^cleared \S/,
];

/** Is this unmarked internal line one updateTicket wrote? Pure. */
export function looksLikeChangeLine(authorName: string | null | undefined, body: string): boolean {
  if (!body || body.length > 2000 || /[\r\n]/.test(body)) return false;
  const who = mdInline(authorName) || "Someone";
  if (!body.startsWith(`${who} `)) return false;
  const rest = body.slice(who.length + 1);
  return VERBS.some((re) => re.test(rest));
}

/** The upgrade's backfill, after boot and outside its lock (lib/db initialize). Answers how many lines it marked. */
export async function migrateChangeLines(db: { query: import("pg").Pool["query"] } | import("pg").PoolClient): Promise<number> {
  // The flag is written when the work is done, so a scan cut short (a restart, an error) runs again at the next boot;
  // each batch only marks lines still unmarked, so running twice, or in two processes at once, changes nothing more.
  const done = await db.query("SELECT 1 FROM settings WHERE key = 'migration_hd_change_lines'");
  if (done.rowCount) return 0;
  let after = 0;
  let marked = 0;
  for (;;) {
    const { rows } = await db.query<{ id: string; author_name: string; body: string }>(
      `SELECT id, author_name, body FROM hd_messages
        WHERE id > $1 AND kind = 'internal' AND via = 'system' AND event IS NULL AND length(body) <= 2000
        ORDER BY id LIMIT 2000`,
      [after]
    );
    if (!rows.length) break;
    after = Number(rows[rows.length - 1].id);
    const ids = rows.filter((r) => looksLikeChangeLine(r.author_name, r.body)).map((r) => Number(r.id));
    if (ids.length) {
      const r = await db.query("UPDATE hd_messages SET event = $2 WHERE id = ANY($1::bigint[]) AND event IS NULL", [ids, HD_CHANGE_EVENT]);
      marked += r.rowCount ?? 0;
    }
  }
  await db.query("INSERT INTO settings (key, value) VALUES ('migration_hd_change_lines', '1') ON CONFLICT (key) DO NOTHING");
  if (marked) console.log(`[helpdesk] marked ${marked} earlier field-change line(s) as activity lines`);
  return marked;
}

/** Boot's call: never in the way of start-up. A failure is logged and the work is tried again at the next boot. */
export function migrateChangeLinesInBackground(db: { query: import("pg").Pool["query"] }): void {
  void migrateChangeLines(db).catch((e) => console.error("[helpdesk] marking earlier change lines failed; it is tried again at the next start:", e instanceof Error ? e.message : e));
}
