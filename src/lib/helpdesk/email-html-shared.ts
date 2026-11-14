// Helpdesk 1.20.8: "View original", the words and limits both sides share
// (lib/helpdesk/email-html is the server half). No imports: safe in client
// components.

export const EMAIL_HTML_LIMITS = {
  /** The original HTML part kept per message, in bytes; past it the first part is kept and marked truncated. */
  storeBytes: 1024 * 1024,
  /** Elements (opening tags) in a document the sanitiser will read. Past it the original is refused with a sentence. */
  tags: 60_000,
  /** How deep elements may nest (an estimate read before parsing). Past it the original is refused. */
  depth: 400,
  /** Inline pictures (cid:) drawn from the message's own attachments, in bytes in total per view. */
  inlineBytes: 8 * 1024 * 1024,
  /** Tiny inline pictures the attachment rules skip (signature logos), kept with the HTML: how many, per message. */
  tinyCids: 30,
} as const;

/** What GET /api/helpdesk/messages/{id}/original?format=info answers (the dialog reads it before it draws the frame). */
export interface HdOriginalInfo {
  ok: boolean;
  /** The sentence to show instead of the email (too large or too complex, gone). */
  error?: string;
  /** https pictures hidden until "Show images". */
  remote_images: number;
  /** Pictures over plain http, never shown. */
  insecure_images: number;
  /** Only the first 1 MB of the email was kept. */
  truncated: boolean;
  /** The original part's size in bytes. */
  size: number;
}

export const HD_ORIGINAL_COPY = {
  control: "View original",
  title: "Original email",
  imagesHidden: "Remote images are hidden.",
  showImages: "Show images",
  imagesShown: "Remote images are shown for this email.",
  insecure: (n: number) => (n === 1 ? "1 picture is not shown because it is not sent securely." : `${n} pictures are not shown because they are not sent securely.`),
  truncated: "This email was larger than 1 MB. Only its first part was kept.",
  plainReplies: "Replies from the desk are still sent as plain text.",
  tooComplex: "This email is too large or too complex to show safely. Its text is in the conversation.",
  failed: "The original email couldn't be shown. Try again.",
  frameTitle: "The original email, as its sender wrote it",
} as const;
