// Helpdesk 1.20.33: the limits of an automation's subject and body
// conditions and actions, apart from the engine (lib/helpdesk/automation-
// body-shared imports re2js), so the rule editor can show them without
// loading the engine until "Try it" is used. lib/helpdesk/automations
// spreads them into AUTOMATION_LIMITS.

export const AUTOMATION_BODY_LIMITS = {
  /** One phrase of a "contains" list. */
  phrase: 200,
  /** A pattern's length. */
  pattern: 200,
  /** How much of the body a phrase or pattern is matched against (bytes of UTF-8). */
  bodyBytes: 100 * 1024,
  /** One label ("Asset tag:", "From:"). */
  label: 60,
  /** Labels one "from the message" action tries. */
  labels: 10,
  /** Sender and domain entries of one "from the message" action. */
  senders: 50,
  /** "Copy a value into a field" actions in one rule. */
  copies: 10,
  /** The "Try it" box's sample. */
  sample: 20_000,
} as const;

/** The labels "Change the requester from the message" tries when the admin names none. */
export const DEFAULT_REQUESTER_LABELS: readonly string[] = ["From:", "Email:"];
