// Helpdesk 1.20.8: "View original", the words and limits both sides share
// (lib/helpdesk/email-html is the server half). No imports: safe in client
// components.

export const EMAIL_HTML_LIMITS = {
  /** The original HTML part kept per message, in bytes; past it the first part is kept and marked truncated. */
  storeBytes: 1024 * 1024,
  /** Elements (opening tags) in a document the sanitiser will read. Past it the original is refused with a sentence. */
  tags: 60_000,
  /** How deep elements may nest (an open-element stack read before parsing). Past it the original is refused. */
  depth: 400,
  /** Attributes on one tag, and in all (1.20.8 security review). Past either the original is refused. */
  tagAttrs: 200,
  attrs: 200_000,
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
  /** 1.20.11, the inline variant (?inline=1) only: its quoted history was folded under "Show quoted text". */
  quoted?: boolean;
}

/** Raised whenever the sanitiser's output changes (email-html-worker.cjs SANITIZER_VERSION): kept results are made again. */
export const EMAIL_HTML_SANITIZER_VERSION = 2;

export const HD_ORIGINAL_COPY = {
  control: "Open in a window", // 1.20.11 (was "View original": the email now shows in the conversation)
  title: "Original email",
  imagesHidden: "Remote images are hidden.",
  showImages: "Show images",
  imagesShown: "Remote images are shown for this email.",
  insecure: (n: number) => (n === 1 ? "1 picture is not shown because it is not sent securely." : `${n} pictures are not shown because they are not sent securely.`),
  truncated: "This email was larger than 1 MB. Only its first part was kept.",
  plainReplies: "Replies from the desk are still sent as plain text.",
  tooComplex: "This email is too complex to show. Its text is in the conversation.",
  busy: "The desk is busy showing other emails. Try again in a moment.",
  failed: "The original email couldn't be shown. Try again.",
  frameTitle: "The original email, as its sender wrote it",
} as const;

/**
 * 1.20.11: the desk conversation shows an emailed message formatted, in place (ticket/InlineEmail). The words of
 * its controls. "Open in a window" is the 1.20.8 dialog (where Print is).
 */
export const HD_INLINE_EMAIL_COPY = {
  plainText: "Plain text",
  formatted: "Formatted",
  shownAsText: "Shown as text",
  openWindow: HD_ORIGINAL_COPY.control,
  imagesHidden: "Remote images are hidden",
  showImages: "Show images",
  showRest: "Show the rest",
  truncated: "Only the first 1 MB of this email was kept.",
  frameTitle: (name: string) => `Email from ${name}`,
} as const;

/** How an agent reads emailed messages in the desk conversation (their desk preference, lib/helpdesk/notify-prefs). */
export type HdEmailView = "formatted" | "plain";

/** The inline frame's height cap in CSS pixels before "Show the rest". */
export const INLINE_EMAIL_MAX_HEIGHT = 4000;

/** The inline variant's address (the desk conversation's frame). */
export function originalInlineHref(id: number, images: boolean): string {
  return `/api/helpdesk/messages/${id}/original?inline=1${images ? "&images=1" : ""}`;
}
