// Helpdesk 1.20.8: an inbound email's original HTML, kept beside the message
// it became (lib/helpdesk/email-html). Kept apart from the server code so
// lib/db's SCHEMA string can append it without importing anything. Additive
// and idempotent; append after hd_messages (it references it).
//
//   hd_message_html  one row per message that came from an email with an
//                    HTML part (a new ticket, a reply, a follow-up, a
//                    forward, an agent's reply or internal note by email),
//                    from the inbound webhook or a Microsoft 365 mailbox.
//                    `html` is the sender's HTML exactly as it arrived
//                    (quoted history and forwarded content included), never
//                    sanitised at rest: it is sanitised every time it is
//                    shown, so a better sanitiser later applies to old mail.
//                    `size` is the original part's size in bytes; past 1 MB
//                    only the first part is kept and `truncated` is set.
//                    `cids` maps an inline picture's Content-ID to the
//                    message's own stored attachment ({"attachment_id": n})
//                    or, for a tiny picture the attachment rules skip (a
//                    signature logo), to the picture itself ({"mime",
//                    "data"}: base64, a few KB at most). Goes with its message
//                    (ON DELETE CASCADE); anonymising a ticket deletes it.
// Nothing is back-filled: messages from before 1.20.8 have no row.

export const HD_EMAIL_HTML_SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_message_html (
  message_id integer PRIMARY KEY REFERENCES hd_messages(id) ON DELETE CASCADE,
  html text NOT NULL,
  size integer NOT NULL DEFAULT 0,
  truncated boolean NOT NULL DEFAULT false,
  cids jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
