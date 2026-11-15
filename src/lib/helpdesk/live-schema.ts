// Helpdesk 1.20.19: live queue updates. Kept apart from lib/helpdesk/live
// (server code) so lib/db's SCHEMA string can append it without importing
// anything. Additive and idempotent. Append after hd_tickets.
//
//   hd_queue_live_notify()   one pg_notify on 'hd_queue_live' whose payload
//                            is only the ticket's team and owner, before and
//                            after the change: "oldTeam,oldOwner,newTeam,
//                            newOwner" (ids, an empty field for none). No
//                            subject, no number, nothing a reader could learn
//                            the ticket from.
//
// Three row triggers call it, each with a WHEN, so a write the queue can't
// show costs nothing:
//   hd_tickets_live_insert   a new ticket (not one created already binned)
//   hd_tickets_live_update   only when a column the queue lists, filters,
//                            sorts or counts on changed (LIVE_COLUMNS), and
//                            never for a ticket in the bin before and after
//   hd_tickets_live_delete   a hard delete of a ticket not in the bin
//
// Cost: trigger and pg_notify measured about 4.5 µs a row. NOTIFY also takes
// Postgres's global notify lock at commit, so commits that notified are
// serialised for that instant. Postgres folds identical payloads within one
// transaction; bulk edits (lib/helpdesk/bulk) save one ticket per
// transaction, so nothing folds there and the bus (lib/helpdesk/live) folds
// them per stream instead (debounce, gap, rate limit). A statement-level
// trigger would only help multi-row statements, which the desk doesn't
// write, so the triggers stay per row.
//
// Created once, behind pg_trigger lookups, under a 2 s lock_timeout: on a
// busy hd_tickets the boot skips them with a WARNING in the Postgres log and
// the next start tries again (the listener also logs that they are missing;
// the desk keeps its minute poll meanwhile). The pre-release trigger
// `hd_tickets_queue_live` (every write, no WHEN) is dropped the same way.
// The function is CREATE OR REPLACE'd, so a change to it reaches the
// triggers; a change to a WHEN needs new trigger names.

/** The columns whose change can move a ticket in a queue, a view or a count (the UPDATE trigger's WHEN). */
export const LIVE_COLUMNS = [
  "status",
  "team_id",
  "assignee_id",
  "priority",
  "subject",
  "requester_id",
  "requester_name",
  "requester_email",
  "category",
  "subcategory",
  "tags",
  "request_type_id",
  "source",
  "parent_ticket_id",
  "first_reply_due",
  "resolve_due",
  "first_replied_at",
  "solved_at",
  "sla_paused_at",
  "first_reply_breached_at",
  "resolve_breached_at",
  "workflow_run_id",
  "automated",
  "integration_id",
  "merged_into",
  "mailbox_id",
  "updated_at",
  "deleted_at",
] as const;

/** The trigger names the listener checks for at start (lib/helpdesk/live). */
export const LIVE_TRIGGERS = ["hd_tickets_live_insert", "hd_tickets_live_update", "hd_tickets_live_delete"] as const;

const OLD_ROW = LIVE_COLUMNS.map((c) => `OLD.${c}`).join(", ");
const NEW_ROW = LIVE_COLUMNS.map((c) => `NEW.${c}`).join(", ");

export const HD_LIVE_SCHEMA = `
CREATE OR REPLACE FUNCTION hd_queue_live_notify() RETURNS trigger AS $fn$
DECLARE
  p text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    p := ',,' || coalesce(NEW.team_id::text, '') || ',' || coalesce(NEW.assignee_id::text, '');
  ELSIF TG_OP = 'DELETE' THEN
    p := coalesce(OLD.team_id::text, '') || ',' || coalesce(OLD.assignee_id::text, '') || ',,';
  ELSE
    p := coalesce(OLD.team_id::text, '') || ',' || coalesce(OLD.assignee_id::text, '') || ','
      || coalesce(NEW.team_id::text, '') || ',' || coalesce(NEW.assignee_id::text, '');
  END IF;
  PERFORM pg_notify('hd_queue_live', p);
  RETURN NULL;
END
$fn$ LANGUAGE plpgsql;
DO $$ BEGIN
  PERFORM set_config('compass.live_prev_lock_timeout', current_setting('lock_timeout'), true);
  PERFORM set_config('lock_timeout', '2s', true);
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('hd_tickets') AND tgname = 'hd_tickets_queue_live') THEN
      DROP TRIGGER hd_tickets_queue_live ON hd_tickets;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('hd_tickets') AND tgname = 'hd_tickets_live_insert') THEN
      CREATE TRIGGER hd_tickets_live_insert AFTER INSERT ON hd_tickets
        FOR EACH ROW WHEN (NEW.deleted_at IS NULL) EXECUTE FUNCTION hd_queue_live_notify();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('hd_tickets') AND tgname = 'hd_tickets_live_update') THEN
      CREATE TRIGGER hd_tickets_live_update AFTER UPDATE ON hd_tickets
        FOR EACH ROW WHEN ((OLD.deleted_at IS NULL OR NEW.deleted_at IS NULL)
          AND (${OLD_ROW}) IS DISTINCT FROM (${NEW_ROW}))
        EXECUTE FUNCTION hd_queue_live_notify();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('hd_tickets') AND tgname = 'hd_tickets_live_delete') THEN
      CREATE TRIGGER hd_tickets_live_delete AFTER DELETE ON hd_tickets
        FOR EACH ROW WHEN (OLD.deleted_at IS NULL) EXECUTE FUNCTION hd_queue_live_notify();
    END IF;
  EXCEPTION WHEN lock_not_available THEN
    RAISE WARNING 'CompassDocs: hd_tickets was busy, so the live queue triggers were not created. The next start tries again.';
  END;
  PERFORM set_config('lock_timeout', current_setting('compass.live_prev_lock_timeout'), true);
END $$;
`;
