// A refusal from the service that sends the workspace's email (Microsoft 365
// since 1.20.31, Azure Communication Services since 1.21.5), in a sentence.
// Pure (no server-only marker): lib/mail-m365 re-exports both classes as
// before, and lib/mail-acs, which the tests import directly, throws them too,
// so the outbox, the newsletter job and the helpdesk read every service's
// refusals alike (lib/mail-outbox-shared classifySendError).

import { mailTooLarge } from "./mail-m365-shared";

/** SMTP-like fields let the helpdesk's sender checks read it. */
export class MailSendError extends Error {
  /** 550 for a refused From (ErrorSendAsDenied), as an SMTP server answers one; undefined otherwise. */
  responseCode?: number;
  response?: string;
  constructor(
    message: string,
    /** The HTTP status; 0 when nothing came back. */
    public status: number,
    public code = "",
    /** "auth" (the sign-in or the identity was refused), "config" (a setting every message shares), "timeout", "network", "too_large"… */
    public kind = "",
    /** A 429's Retry-After, when the service gave one. */
    public retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "MailSendError";
    if (code.toLowerCase() === "errorsendasdenied") {
      this.responseCode = 550;
      this.response = `550 5.7.60 SendAsDenied: ${message}`;
    }
  }
}

export class MailTooLargeError extends MailSendError {
  /** `message`: the service's own sentence (default: Microsoft 365's). */
  constructor(
    public bytes: number,
    message?: string
  ) {
    super(message ?? mailTooLarge(bytes), 413, "too_large", "too_large");
    this.name = "MailTooLargeError";
  }
}
