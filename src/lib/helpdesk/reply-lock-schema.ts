// Helpdesk 1.20.20: the reply lock (lib/helpdesk/reply-lock). Kept apart from
// the server code so lib/db's SCHEMA string can append it without importing
// anything. Additive and idempotent. Append after hd_tickets, hd_messages,
// hd_ticket_presence and settings.
//
//   hd_reply_locks   one row per ticket whose public reply someone holds:
//                    the holder, when they took it (`since`) and their last
//                    heartbeat (`seen_at`). Internal notes are never locked,
//                    so there is no row for them. A row whose heartbeat is
//                    older than the idle timeout, or whose holder has no
//                    presence row on the ticket within it, counts as gone
//                    (checked on every read and by the minute sweep, which
//                    deletes it). `prev_user_id` / `taken_over_at`: a lead
//                    took it over from that person (their composer shows it).
//                    1.20.20 review: `tab_id` (the browser tab that holds it:
//                    only that tab's close releases it) and `touched_at` (the
//                    last edit, as the holder's composer reports it: idle is
//                    measured from it). hd_ticket_presence.tabs: the tabs
//                    beating for that row ({tab id: epoch}), so one tab's
//                    leave keeps the row while another tab still has it open.
//
// 1.20.20, live (1.20.19's bus, lib/helpdesk/live): a lock taken, moved to
// someone else or gone fires the same 'hd_queue_live' notify as a ticket
// change, with the same payload (the ticket's team and owner only: no names,
// no number), so the agents whose queues show the ticket hear it within the
// bus's debounce and gap (its token bucket and per-stream folding apply) and
// their desks fetch the lock again. A heartbeat (same holder) fires nothing.
// The triggers are created behind pg_trigger lookups under a 2 s lock_timeout,
// as 1.20.19's are.
//
// The setting (settings key helpdesk_reply_lock) is written once (a guarded block: no write on later boots), on the first
// boot that has this table: switched ON for a desk with no tickets, messages, teams or help addresses
// yet (a new install), OFF for a desk already set up or in use (an upgrade), so a team's way of
// working never changes under it. An admin switches it in Desk settings.

export const HD_REPLY_LOCK_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_reply_locks (
  ticket_id integer PRIMARY KEY REFERENCES hd_tickets(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  since timestamptz NOT NULL DEFAULT now(),
  seen_at timestamptz NOT NULL DEFAULT now(),
  prev_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  taken_over_at timestamptz
);
CREATE INDEX IF NOT EXISTS hd_reply_locks_seen ON hd_reply_locks (seen_at);
ALTER TABLE hd_reply_locks ADD COLUMN IF NOT EXISTS tab_id text NOT NULL DEFAULT '';
ALTER TABLE hd_reply_locks ADD COLUMN IF NOT EXISTS touched_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS hd_reply_locks_user ON hd_reply_locks (user_id);
ALTER TABLE hd_ticket_presence ADD COLUMN IF NOT EXISTS tabs jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE OR REPLACE FUNCTION hd_reply_lock_live_notify() RETURNS trigger AS $fn$
DECLARE
  tm integer;
  asg integer;
BEGIN
  SELECT team_id, assignee_id INTO tm, asg FROM hd_tickets
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.ticket_id ELSE NEW.ticket_id END AND deleted_at IS NULL;
  IF FOUND THEN
    PERFORM pg_notify('hd_queue_live', ',,' || coalesce(tm::text, '') || ',' || coalesce(asg::text, ''));
  END IF;
  RETURN NULL;
END
$fn$ LANGUAGE plpgsql;
DO $$ BEGIN
  PERFORM set_config('compass.rl_prev_lock_timeout', current_setting('lock_timeout'), true);
  PERFORM set_config('lock_timeout', '2s', true);
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('hd_reply_locks') AND tgname = 'hd_reply_locks_live_insert') THEN
      CREATE TRIGGER hd_reply_locks_live_insert AFTER INSERT ON hd_reply_locks FOR EACH ROW EXECUTE FUNCTION hd_reply_lock_live_notify();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('hd_reply_locks') AND tgname = 'hd_reply_locks_live_update') THEN
      CREATE TRIGGER hd_reply_locks_live_update AFTER UPDATE ON hd_reply_locks
        FOR EACH ROW WHEN (OLD.user_id IS DISTINCT FROM NEW.user_id) EXECUTE FUNCTION hd_reply_lock_live_notify();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('hd_reply_locks') AND tgname = 'hd_reply_locks_live_delete') THEN
      CREATE TRIGGER hd_reply_locks_live_delete AFTER DELETE ON hd_reply_locks FOR EACH ROW EXECUTE FUNCTION hd_reply_lock_live_notify();
    END IF;
  EXCEPTION WHEN lock_not_available THEN
    RAISE WARNING 'CompassDocs: hd_reply_locks was busy, so the reply lock live triggers were not created. The next start tries again.';
  END;
  PERFORM set_config('lock_timeout', current_setting('compass.rl_prev_lock_timeout'), true);
END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM settings WHERE key = 'helpdesk_reply_lock') THEN INSERT INTO settings (key, value) VALUES ('helpdesk_reply_lock', CASE WHEN EXISTS (SELECT 1 FROM hd_messages) OR EXISTS (SELECT 1 FROM hd_tickets) OR EXISTS (SELECT 1 FROM hd_teams) OR EXISTS (SELECT 1 FROM hd_mailboxes) THEN '{"enabled":false,"idle_minutes":2}' ELSE '{"enabled":true,"idle_minutes":2}' END) ON CONFLICT (key) DO NOTHING; END IF; END $$;
`;
