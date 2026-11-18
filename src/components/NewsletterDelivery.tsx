"use client";

// 1.20.31: a newsletter's background send through Microsoft 365
// (lib/newsletter-delivery): how far it has got, read again every few
// seconds while it goes on; why it paused or stopped; who failed and why;
// "Try again" for a stopped send and "Retry the N that failed" once it is
// done. Shown on the newsletter's page when a background send exists.

import { useCallback, useEffect, useState } from "react";
import { RotateCcw, Send } from "lucide-react";
import { Button } from "@/components/Button";
import { FormError } from "@/components/form";
import { toast } from "@/components/Toasts";
import { useFormatDate } from "@/components/SettingsProvider";
import type { NewsletterDeliveryView } from "@/lib/newsletter-delivery-shared";

export function useNewsletterDelivery(id: number, enabled: boolean) {
  const [d, setD] = useState<NewsletterDeliveryView | null>(null);
  const load = useCallback(async () => {
    const r = await fetch(`/api/newsletter/${id}/delivery`).catch(() => null);
    if (r?.ok) setD((await r.json()).delivery ?? null);
  }, [id]);
  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);
  const live = d && (d.state === "sending" || d.state === "paused");
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [live, load]);
  return { delivery: d, setDelivery: setD, reload: load };
}

export function NewsletterDeliveryPanel({
  id,
  delivery,
  canAct,
  onChange,
}: {
  id: number;
  delivery: NewsletterDeliveryView;
  canAct: boolean;
  onChange: (d: NewsletterDeliveryView) => void;
}) {
  const fmt = useFormatDate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const d = delivery;
  const pct = d.total ? Math.round(((d.sent + d.failed) / d.total) * 100) : 0;

  async function act(action: "retry" | "resume") {
    setBusy(true);
    setError("");
    const r = await fetch(`/api/newsletter/${id}/delivery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    const data = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) {
      setError(data?.error || "Could not do that.");
      return;
    }
    onChange(data.delivery);
    toast("ok", action === "retry" ? "The failed recipients are queued again." : "Sending goes on.");
  }

  const line =
    d.state === "done"
      ? d.failed
        ? `Sent to ${d.sent} of ${d.total}. ${d.failed} failed.`
        : `Sent to all ${d.total} recipients.`
      : d.state === "stopped"
        ? `Stopped after ${d.sent} of ${d.total}.`
        : d.state === "paused"
          ? `${d.sent} of ${d.total} sent. Microsoft 365 asked to slow down: sending goes on at ${fmt.dateTime(d.paused_until)}.`
          : `Sending through Microsoft 365: ${d.sent} of ${d.total} sent${d.failed ? `, ${d.failed} failed` : ""}.`;

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs" data-testid="newsletter-delivery" data-state={d.state}>
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <Send className="h-4 w-4 text-slate-500" aria-hidden /> Delivery
      </h2>
      <p className="mt-1 text-sm text-slate-700" aria-live="polite">
        {line}
      </p>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-label="Sent so far"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="h-full rounded-full bg-compass-500" style={{ width: `${pct}%` }} />
      </div>
      {(d.state === "sending" || d.state === "paused") && (
        <p className="mt-2 text-xs text-slate-500">
          It goes out in the background, about 25 a minute: Microsoft 365 lets one mailbox send about 30 a minute and 10,000 a day. You can leave this page.
        </p>
      )}
      {d.state === "stopped" && (
        <p className="notice-warn mt-2 rounded-lg border px-3 py-2 text-sm" data-testid="newsletter-delivery-stopped">
          {d.stop_reason} Nobody else was sent it.
        </p>
      )}
      {d.failures.length > 0 && (
        <details className="mt-2 text-sm text-slate-600">
          <summary className="cursor-pointer text-sm font-semibold text-slate-900">Who failed, and why</summary>
          <ul role="list" className="mt-1 space-y-0.5 text-xs">
            {d.failures.map((f) => (
              <li key={f.email} className="[overflow-wrap:anywhere]">
                {f.email}: {f.error}
              </li>
            ))}
            {d.failed > d.failures.length && <li>…and {d.failed - d.failures.length} more.</li>}
          </ul>
        </details>
      )}
      {canAct && (d.state === "stopped" || (d.state === "done" && d.failed > 0)) && (
        <div className="mt-3">
          {d.state === "stopped" ? (
            <Button variant="secondary" size="sm" icon={<RotateCcw />} busy={busy} onClick={() => void act("resume")}>
              Try again
            </Button>
          ) : (
            <Button variant="secondary" size="sm" icon={<RotateCcw />} busy={busy} onClick={() => void act("retry")}>
              Retry the {d.failed} that failed
            </Button>
          )}
        </div>
      )}
      <FormError className="mt-2">{error}</FormError>
    </div>
  );
}
