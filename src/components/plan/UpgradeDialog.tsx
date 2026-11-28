"use client";

// Request an upgrade (1.22.0, design A9 and C3). The console's billing
// hand-off isn't built yet, so both dialogs ask CompassDocs by email: the
// workspace sends sales@ a request with the admin's reply-to address and
// their note (POST /api/admin/plan/upgrade); when the workspace can't send
// email, the answer is a mailto: link, opened instead. One dialog, two
// framings: "Move to Shared?" compares the plans; "Talk to us about
// Dedicated" asks what we should know.

import { useEffect, useId, useState } from "react";
import { ArrowUpRight, Send, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Field, FormError, Textarea, TextInput } from "@/components/form";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/Toasts";
import { PLAN_CATALOGUE, planLabel, shortDate, usdShort, SALES_EMAIL, type PlanName } from "@/lib/plan-shared";

export interface UpgradeContext {
  current: PlanName;
  target: PlanName;
  workspace: string;
  renewsAt: string;
  /** The current plan's price (the licence's, else the catalogue's). */
  priceUsd: number;
  /** Prefilled reply-to. */
  replyTo: string;
}

export function UpgradeDialog({ open, onClose, ctx }: { open: boolean; onClose: () => void; ctx: UpgradeContext }) {
  const titleId = useId();
  const [replyTo, setReplyTo] = useState(ctx.replyTo);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setReplyTo(ctx.replyTo);
    setNote("");
    setError("");
  }, [open, ctx.replyTo]);
  const dedicated = ctx.target === "dedicated";
  const target = PLAN_CATALOGUE[ctx.target];
  const now = PLAN_CATALOGUE[ctx.current];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/admin/plan/upgrade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: ctx.target, reply_to: replyTo, note }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error || "Couldn't send the request.");
        return;
      }
      if (body.sent) {
        toast("ok", `Sent to CompassDocs. We'll reply to ${replyTo} within one business day.`);
      } else if (typeof body.mailto === "string") {
        window.location.href = body.mailto;
        toast("ok", `Your email app opens with the request to ${SALES_EMAIL}: send it from there.`);
      }
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <form onSubmit={submit} noValidate>
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            {dedicated ? "Talk to us about Dedicated" : `Move to ${target.label}?`}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
            <X aria-hidden />
          </button>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          {dedicated
            ? `Dedicated gives ${ctx.workspace} its own servers, no user cap and 250 GB. We'll reply by email within one business day.`
            : `${target.label} fits where ${ctx.workspace} is heading. Your documents, people and settings stay exactly as they are.`}
        </p>
        {!dedicated && (
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <PlanBox caption={`Now: ${now.label}`} price={`${usdShort(ctx.priceUsd)}/mo`} lines={now.summary} />
            <PlanBox caption={target.label} price={`${usdShort(target.priceUsd)}/mo`} lines={target.summary} selected />
          </div>
        )}
        {!dedicated && (
          <p className="mt-3 text-xs text-slate-500">
            We'll set it up with you by email. You pay the difference for the rest of your plan year, to {shortDate(ctx.renewsAt)}, and the new limits arrive with your license.
          </p>
        )}
        <div className="mt-4 space-y-4">
          <Field label="Reply to">
            <TextInput type="email" autoComplete="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} required />
          </Field>
          <Field label="Anything we should know (optional)">
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder={dedicated ? "About 600 staff from January…" : "When you'd like to move, anything to plan around…"} />
          </Field>
          {error && <FormError>{error}</FormError>}
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button type="submit" busy={busy} icon={dedicated ? <Send /> : <ArrowUpRight />}>
            {dedicated ? "Send request" : `Ask to move to ${planLabel(ctx.target)}`}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
        <p className="mt-3 text-xs text-slate-500">The request goes to {SALES_EMAIL} with your workspace's plan and the address above.</p>
      </form>
    </Modal>
  );
}

function PlanBox({ caption, price, lines, selected = false }: { caption: string; price: string; lines: string[]; selected?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 text-sm ${selected ? "border-compass-300 bg-compass-50/60 dark:border-compass-500" : "border-slate-200"}`}>
      <p className="text-xs text-slate-500">{caption}</p>
      <p className="font-semibold text-slate-900">{price}</p>
      <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

/** The header's one primary action (design A1): Upgrade to Shared on Starter, Talk to us about Dedicated on Shared, none on Dedicated. */
export function upgradeLabel(current: PlanName): { target: PlanName; label: string } | null {
  const next = PLAN_CATALOGUE[current].next;
  if (!next) return null;
  return { target: next, label: next === "dedicated" ? "Talk to us about Dedicated" : `Upgrade to ${planLabel(next)}` };
}
