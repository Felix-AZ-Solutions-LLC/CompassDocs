// Helpdesk 1.20.33: what automations that read the body and change the
// requester keep. Kept apart from the server code so lib/db's SCHEMA string
// can append it without importing anything. Additive and idempotent; append
// after hd_messages and hd_tickets.
//
//   hd_messages.sender_verified      for a message that came by email (the
//                                    inbound webhook or a Microsoft 365
//                                    mailbox, lib/helpdesk/inbound): true only
//                                    when the mail provider's verdict passed,
//                                    aligned with the From domain; false
//                                    otherwise, an address trusted without a
//                                    verdict included. NULL for everything
//                                    else (the desk, Get help, the portal, the
//                                    API: their author signed in) and for mail
//                                    from before 1.20.33.
//   hd_tickets.requester_set_by_agent_at
//                                    when an agent last set the requester by
//                                    hand (lib/helpdesk/requester-change);
//                                    from then on no rule changes it.
//   hd_tickets.requester_ack_held_at when the acknowledgement to a requester a
//                                    rule took from the message was held for
//                                    the rate limit (lib/helpdesk/automations
//                                    REQUESTER_ACK_LIMITS); notify skips it.
//
// An automation's "Change the requester from the message" acts only for a
// message from a sender on its list, and never for an email whose sender
// didn't pass the check (lib/helpdesk/automations): a forged From of the
// forwarder must not move a ticket and its replies to someone else.

export const HD_AUTOMATION_BODY_SCHEMA = `
ALTER TABLE hd_messages ADD COLUMN IF NOT EXISTS sender_verified boolean;
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS requester_set_by_agent_at timestamptz;
ALTER TABLE hd_tickets ADD COLUMN IF NOT EXISTS requester_ack_held_at timestamptz;
`;
