// Helpdesk 1.20.6: the desk's event calendar. Kept apart from
// lib/helpdesk/desk-calendar (server code) so lib/db's SCHEMA string can
// append it without importing anything. Additive and idempotent; append
// after hd_tickets, hd_teams, hd_request_types and users.
//
// (Not to be confused with lib/helpdesk/calendars-schema: those are the
// business-hours "Calendars" a team's reply targets count in. This is the
// "Calendar" of events that tickets carry.)
//
//   hd_ticket_events     a ticket's one event (ticket_id is the key). The
//                        instants are UTC (starts_at, ends_at); an all-day
//                        event also keeps its calendar days (start_date to
//                        end_date, inclusive) and the zone they were entered
//                        in, and its instants are those days' midnights in
//                        that zone. ready_at = starts_at minus the setup
//                        lead time, stored so the reminder sweep and the
//                        calendar read one indexed column. place_key is the
//                        place trimmed, single-spaced and lower-cased: what
//                        the double-booking check compares. setup_done_*:
//                        "Setup complete", who and when. cancelled_at: the
//                        meeting was cancelled (an invite's METHOD:CANCEL, or
//                        a declined request); a cancelled event blocks
//                        nothing. ics_uid / ics_sequence: the meeting invite
//                        it came from, so an update finds it. time_rev goes
//                        up whenever the time or the lead time changes: the
//                        reminders already sent belong to the old revision,
//                        so they are sent again for the new one.
//   hd_event_reminders   what the reminder sweep has sent, keyed (ticket,
//                        kind, time_rev): the claim that makes a reminder go
//                        out once across restarts and instances. kind is
//                        'lead:<minutes>' or 'late'.
//   hd_calendar_feeds    private iCal feed links. One live link per person
//                        per scope (a team, or NULL = every team the person
//                        works). Only the SHA-256 of the token is kept, with
//                        its last four characters for display. The feed
//                        shows what its owner may see when it is fetched.
//   hd_calendar_prefs    what a person last chose on the Calendar page
//                        (view, team filter, colours, layers).
//   hd_request_types.calendar   "Goes on the calendar": which form fields
//                        hold the start, end and place, and the default
//                        setup lead time. '{}' = off.
//
// 1.20.34 "Hold until the event" (lib/helpdesk/desk-calendar-park):
//   hd_tickets.parked_until    a parked ticket (status on_hold) wakes then;
//                        NULL = not parked. idx_hd_tickets_parked is the
//                        wake tick's index (only parked rows are in it).
//   hd_tickets.parked_at / park_reason   since when, and why: 'agent',
//                        'invite' or 'request_type' ('' when not parked).
//   hd_tickets.park_prep_days   the ticket's own prep window in working
//                        days; NULL = the desk's (Desk settings → Event
//                        calendar). Kept when the ticket wakes.
//   hd_ticket_events.ics_dtstamp / ics_organizer   the invite's DTSTAMP and
//                        ORGANIZER address (lower case), so a later update
//                        of the same UID is told from an older one and only
//                        the organiser (or the ticket's own requester) moves
//                        or cancels the event.
//   hd_tickets.park_wake_failures / park_wake_error / park_wake_retry_at
//                        the wake sweep's failures for this ticket, the last
//                        error and when it may try again (a growing delay),
//                        so one failing ticket never holds the head of the
//                        due list; cleared when it wakes.
//   hd_ticket_parkings   each time a ticket was parked: when, why, and when
//                        it woke (NULL while parked). Reports' backlog reads
//                        it, so past figures don't move when tickets wake.
//                        Filled once from the tickets parked before it
//                        existed (guarded: only rows with no open entry).
//   The requester's reminder before the event is claimed in
//   hd_event_reminders as kind 'requester:<start instant>' (time_rev 0): once
//   per event date, and again when the event moves.

export const HD_DESK_CALENDAR_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_ticket_events (
  ticket_id integer PRIMARY KEY REFERENCES hd_tickets(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  all_day integer NOT NULL DEFAULT 0,
  start_date date,
  end_date date,
  timezone text NOT NULL DEFAULT 'UTC',
  place text NOT NULL DEFAULT '',
  place_key text NOT NULL DEFAULT '',
  setup_minutes integer NOT NULL DEFAULT 0,
  ready_at timestamptz NOT NULL,
  setup_done_at timestamptz,
  setup_done_by integer REFERENCES users(id) ON DELETE SET NULL,
  setup_done_by_name text NOT NULL DEFAULT '',
  cancelled_at timestamptz,
  source text NOT NULL DEFAULT 'agent',
  ics_uid text NOT NULL DEFAULT '',
  ics_sequence integer NOT NULL DEFAULT 0,
  repeats integer NOT NULL DEFAULT 0,
  time_rev integer NOT NULL DEFAULT 1,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at >= starts_at)
);
CREATE INDEX IF NOT EXISTS idx_hd_ticket_events_start ON hd_ticket_events (starts_at);
CREATE INDEX IF NOT EXISTS idx_hd_ticket_events_end ON hd_ticket_events (ends_at);
CREATE INDEX IF NOT EXISTS idx_hd_ticket_events_place ON hd_ticket_events (place_key, starts_at) WHERE place_key <> '' AND cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hd_ticket_events_uid ON hd_ticket_events (ics_uid) WHERE ics_uid <> '';
CREATE INDEX IF NOT EXISTS idx_hd_ticket_events_ready ON hd_ticket_events (ready_at) WHERE setup_done_at IS NULL AND cancelled_at IS NULL;
CREATE TABLE IF NOT EXISTS hd_event_reminders (
  ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
  kind text NOT NULL,
  time_rev integer NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  recipients integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ticket_id, kind, time_rev)
);
CREATE TABLE IF NOT EXISTS hd_calendar_feeds (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id integer REFERENCES hd_teams(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  last4 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by_name text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_calendar_feeds_live ON hd_calendar_feeds (owner_id, COALESCE(team_id, 0)) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS hd_calendar_prefs (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE hd_request_types ADD COLUMN IF NOT EXISTS calendar jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS parked_until timestamptz;
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS parked_at timestamptz;
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS park_reason text NOT NULL DEFAULT '';
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS park_prep_days integer;
CREATE INDEX IF NOT EXISTS idx_hd_tickets_parked ON hd_tickets (parked_until) WHERE parked_until IS NOT NULL;
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS park_wake_failures integer NOT NULL DEFAULT 0;
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS park_wake_error text NOT NULL DEFAULT '';
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS park_wake_retry_at timestamptz;
CREATE TABLE IF NOT EXISTS hd_ticket_parkings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
  parked_at timestamptz NOT NULL,
  woke_at timestamptz,
  reason text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_hd_ticket_parkings_ticket ON hd_ticket_parkings (ticket_id, parked_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_ticket_parkings_open ON hd_ticket_parkings (ticket_id) WHERE woke_at IS NULL;
DO $$ BEGIN INSERT INTO hd_ticket_parkings (ticket_id, parked_at, reason)
  SELECT t.id, COALESCE(t.parked_at, t.updated_at), t.park_reason FROM hd_tickets t
   WHERE t.parked_until IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hd_ticket_parkings p WHERE p.ticket_id = t.id AND p.woke_at IS NULL)
  ON CONFLICT DO NOTHING; END $$;
ALTER TABLE hd_ticket_events ADD COLUMN IF NOT EXISTS ics_dtstamp timestamptz;
ALTER TABLE hd_ticket_events ADD COLUMN IF NOT EXISTS ics_organizer text NOT NULL DEFAULT '';
`;

/**
 * lib/helpdesk/retention's auto-close (solved → closed): never a ticket whose
 * event's setup is not marked complete. Reads hd_tickets' columns, as its
 * CLOSE_WHERE does. Here (and not in lib/helpdesk/desk-calendar) so retention
 * imports nothing but a string.
 */
export const EVENT_HOLDS_CLOSE_SQL = `NOT EXISTS (SELECT 1 FROM hd_ticket_events ev WHERE ev.ticket_id = hd_tickets.id AND ev.cancelled_at IS NULL AND ev.setup_done_at IS NULL)`;

/** 1.20.34: a ticket's open parking entry ends (it woke, or its parking was cleared). $1 ticket id, $2 when. */
export const PARK_HISTORY_CLOSE_SQL = "UPDATE hd_ticket_parkings SET woke_at = $2 WHERE ticket_id = $1 AND woke_at IS NULL";
