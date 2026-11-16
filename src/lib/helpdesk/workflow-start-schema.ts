// Helpdesk 1.20.21: Start a workflow from the desk (lib/helpdesk/workflow-start).
// Kept apart from the server code so lib/db's SCHEMA string can append it
// without importing anything. Additive and idempotent. Append after hd_tickets
// and users.
//
//   hd_workflow_start_ids   a start's idempotency key (client_start_id), one
//                           row per agent, ticket and key: the dialog makes one
//                           key when it opens and sends it with every try, so a
//                           double-click, a retry after a dropped answer or a
//                           second tab replaying the request starts nothing
//                           twice. Written inside the start's own transaction,
//                           under the ticket's row lock (the 1.20.18
//                           hd_message_send_ids pattern, without a separate
//                           claim: the lock already serialises two tries), so
//                           the key exists exactly when the start does.
//                           `request_ticket_id` is the ticket the run lives on
//                           (the same ticket, or the new request) and `mode`
//                           which of the two it was; a repeat answers with
//                           them. Kept a day (sweepStartIds, the
//                           hd_workflow_start_ids sweep). No form answers here.

export const HD_WORKFLOW_START_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_workflow_start_ids (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_id integer NOT NULL REFERENCES hd_tickets(id) ON DELETE CASCADE,
  client_start_id text NOT NULL,
  request_ticket_id integer REFERENCES hd_tickets(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('this', 'new')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ticket_id, client_start_id)
);
CREATE INDEX IF NOT EXISTS hd_workflow_start_ids_created ON hd_workflow_start_ids (created_at);
`;
