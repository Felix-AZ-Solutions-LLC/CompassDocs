// Helpdesk 1.20.8: the ticket CSV's cap and fixed columns, which the desk's
// Export CSV control and the server (lib/helpdesk/ticket-export) share. Pure.

/** Tickets one export writes, at most; the desk asks before a longer list is cut. */
export const TICKET_EXPORT_MAX_ROWS = 10_000;

/** The fixed columns, in order; one column per live custom field follows them. */
export const TICKET_EXPORT_COLUMNS = [
  "Number",
  "Subject",
  "Status",
  "Priority",
  "Team",
  "Owner",
  "Requester",
  "Requester email",
  "Category",
  "Sub-category",
  "Tags",
  "Created",
  "Updated",
  "First reply",
  "Solved",
  "Due",
  "Channel",
  "Help address",
  "Event start",
  "Event end",
  "Event place",
] as const;
