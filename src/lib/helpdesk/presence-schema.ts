// Helpdesk 1.19.1: who has a ticket open right now (collision warnings,
// agent V4). Kept apart from lib/helpdesk/presence (server code) so
// lib/db's SCHEMA string can append it without importing anything.
// Additive and idempotent. Append after hd_tickets (it references
// hd_tickets and users).
//
//   hd_ticket_presence   one row per agent with a ticket open: 'viewing'
//                        or 'replying' (typing in the composer). The desk
//                        heartbeats every ~10 s while the tab is visible;
//                        a row older than 30 s counts as gone (TTL in
//                        lib/helpdesk/presence-shared) and the minute
//                        sweep deletes rows older than five minutes.
//                        `since` is when the current state began.
//   hd_message_send_ids  1.20.18 (the reply pop-out's security review): a
//                        send's idempotency key (client_send_id), one row
//                        per agent, ticket and key. Claimed (message_id
//                        NULL) before the message is written and completed
//                        with its id after, so a repeat of the same send (a
//                        pop-out closed mid-send, then sent again from the
//                        desk) answers with the first message and posts
//                        nothing. Kept a day; the presence sweep deletes
//                        older rows (lib/helpdesk/send-once).

export const HD_PRESENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_ticket_presence (
  ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'viewing' CHECK (state IN ('viewing', 'replying')),
  seen_at timestamptz NOT NULL DEFAULT now(),
  since timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, user_id)
);
CREATE INDEX IF NOT EXISTS hd_ticket_presence_seen ON hd_ticket_presence (seen_at);
CREATE TABLE IF NOT EXISTS hd_message_send_ids (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
  client_send_id text NOT NULL,
  message_id integer REFERENCES hd_messages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ticket_id, client_send_id)
);
CREATE INDEX IF NOT EXISTS hd_message_send_ids_created ON hd_message_send_ids (created_at);
`;
