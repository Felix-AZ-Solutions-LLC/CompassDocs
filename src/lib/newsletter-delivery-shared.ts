// 1.20.31: the shape of a newsletter's background send through Microsoft 365
// (lib/newsletter-delivery), for the page. No server-only imports.

export interface NewsletterDeliveryView {
  state: "sending" | "paused" | "stopped" | "done";
  total: number;
  sent: number;
  failed: number;
  queued: number;
  paused_until: string | null;
  stop_reason: string;
  /** The first failures, with Microsoft's reason. */
  failures: { email: string; error: string }[];
  started_at: string;
  finished_at: string | null;
}
