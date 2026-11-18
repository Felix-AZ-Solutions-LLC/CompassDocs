"use client";

// 1.20.32: where an agent's reply's email stands, when it is not simply sent
// (STYLEGUIDE §Helpdesk: the desk, "A reply's email that didn't go out").
// Through Microsoft 365 a reply is accepted into the workspace's outbox
// (lib/mail-outbox) and sent moments later; if that copy then fails, may not
// have gone out (Microsoft didn't answer), was discarded by an admin, or is
// still waiting after two minutes, the message says so in one small line
// under its meta, with Send again where the body is still kept. Send again on
// an uncertain one asks first: it may arrive twice.

import { useState } from "react";
import { Ban, Clock, RotateCw, TriangleAlert, CircleHelp } from "lucide-react";
import { Button } from "@/components/Button";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import type { MessageMailState } from "@/lib/mail-outbox-shared";

export function MailStateLine({ ticketNumber, messageId, state }: { ticketNumber: number; messageId: number; state: MessageMailState }) {
  const [busy, setBusy] = useState(false);
  const [again, setAgain] = useState(false);
  const to = state.to.split(",")[0]?.trim() || "the requester";
  const more = state.to.split(",").length > 1 ? ` and ${state.to.split(",").length - 1} more` : "";

  async function sendAgain() {
    if (state.state === "uncertain") {
      const ok = await confirmDialog({
        title: "Send the email again?",
        body: `Microsoft didn't answer when it was sent, so ${to} may have it already. Sending again may deliver a second copy.`,
        confirmLabel: "Send again",
      });
      if (ok !== true) return;
    }
    setBusy(true);
    const res = await fetch(`/api/helpdesk/tickets/${ticketNumber}/messages/${messageId}/resend`, { method: "POST" }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    setBusy(false);
    if (!res?.ok) {
      toast("error", data?.error || "Couldn't send it again.");
      return;
    }
    setAgain(true);
    toast("ok", "Queued to send again.");
  }

  if (again) {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 pl-9 text-xs text-slate-500 print:hidden" role="status" data-testid="message-mail-state" data-state="queued">
        <Clock className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
        Queued to send again to {to}
        {more}.
      </p>
    );
  }

  const line =
    state.state === "failed" ? (
      <span className="text-red-600">
        Not sent to {to}
        {more}: {state.reason || "Microsoft 365 refused it."}
      </span>
    ) : state.state === "uncertain" ? (
      <span className="ink-warn">
        May not have reached {to}
        {more}: Microsoft didn&apos;t answer, so it may have gone out.
      </span>
    ) : state.state === "discarded" ? (
      <span>
        Not sent to {to}
        {more}: an administrator discarded it.
      </span>
    ) : (
      <span>
        Waiting to send to {to}
        {more}. Email through Microsoft 365 is paced; it goes out shortly.
      </span>
    );
  const Icon = state.state === "failed" ? TriangleAlert : state.state === "uncertain" ? CircleHelp : state.state === "discarded" ? Ban : Clock;
  const iconTone = state.state === "failed" ? "text-red-600" : state.state === "uncertain" ? "ink-warn" : "text-slate-400";

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-9 print:hidden" data-testid="message-mail-state" data-state={state.state}>
      <p className="flex min-w-0 items-start gap-1.5 text-xs text-slate-500" role={state.state === "failed" || state.state === "uncertain" ? "alert" : undefined}>
        <Icon className={`mt-px h-3.5 w-3.5 shrink-0 ${iconTone}`} aria-hidden />
        {line}
      </p>
      {state.can_resend && (state.state === "failed" || state.state === "uncertain") && (
        <Button variant="secondary" size="sm" icon={<RotateCw />} busy={busy} onClick={() => void sendAgain()}>
          Send again
        </Button>
      )}
    </div>
  );
}
