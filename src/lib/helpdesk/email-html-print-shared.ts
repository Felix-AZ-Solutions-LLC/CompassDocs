// Helpdesk 1.20.9: printing an email's original ("View original" → Print).
// The words and the address both sides share (lib/helpdesk/email-html-print
// is the server half). No imports: safe in client components.

export const HD_ORIGINAL_PRINT_COPY = {
  tooltip: "Print this email",
  /** The print view's bar, on screen only. */
  bar: "This is the email as it prints. To print it or save it as a PDF, press Ctrl+P (Cmd+P on a Mac).",
  pageTitle: (n: number) => `Print #${n} original email`,
  from: "From",
  ccs: "CCs on the ticket",
  noCcs: "None",
  received: "Received",
  internal: "Internal note. Only agents should see it.",
  imagesLeftOut: "Remote images are not printed. Choose Show images before you print to include them.",
  insecure: (n: number) => (n === 1 ? "1 picture is not printed because it was not sent securely." : `${n} pictures are not printed because they were not sent securely.`),
  truncated: "This email was larger than 1 MB. Only its first part was kept.",
  printed: (by: string, on: string) => `Printed by ${by} on ${on}.`,
} as const;

/** The print view of a message's original; `images` follows the dialog's Show images. */
export function originalPrintHref(messageId: number, images: boolean): string {
  return `/api/helpdesk/messages/${messageId}/original?print=1${images ? "&images=1" : ""}`;
}
