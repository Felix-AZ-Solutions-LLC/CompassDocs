"use client";

// The ticket pane while its reply is popped out (1.20.18, STYLEGUIDE
// §Helpdesk: the desk, "The reply pop-out"): one quiet line where the
// composer was, so there is never a second box to send from. "Show window"
// brings the pop-out forward; "Bring back" asks it to hand the reply back
// (it saves and closes; the composer returns with the text). Security
// review fixes: while the pop-out is sending it says so instead of giving
// the reply back; a pop-out that doesn't answer is never taken over
// silently: the agent is asked.

import { AppWindow, CircleAlert } from "lucide-react";
import { Spinner } from "@/components/Spinner";
import type { ElsewhereState } from "./useReplyPopout";

export function ReplyElsewhere({
  state = "out",
  onShow,
  onBringBack,
  onTakeBack,
  onKeepWaiting,
}: {
  state?: ElsewhereState;
  onShow: () => void;
  onBringBack: () => void;
  onTakeBack?: () => void;
  onKeepWaiting?: () => void;
}) {
  const dot = (
    <span aria-hidden className="text-slate-500">
      ·
    </span>
  );
  return (
    <section
      aria-label="Reply"
      data-testid="reply-elsewhere"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-slate-200 bg-surface px-3 py-2.5 text-sm text-slate-600 shadow-xs print:hidden"
    >
      {state === "unanswered" ? (
        <>
          <CircleAlert className="h-4 w-4 shrink-0 ink-warn" aria-hidden />
          <span role="status">The other window isn&apos;t answering. Take the reply back here?</span>
          <button type="button" className="link font-medium" onClick={onTakeBack}>
            Take it back
          </button>
          {dot}
          <button type="button" className="link font-medium" onClick={onKeepWaiting}>
            Keep waiting
          </button>
        </>
      ) : state === "checking" ? (
        <>
          <Spinner size="sm" />
          <span role="status">Checking whether the reply was sent…</span>
        </>
      ) : (
        <>
          <AppWindow className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
          <span role="status">{state === "busy" ? "Still sending in the other window" : "Replying in another window"}</span>
          {dot}
          <button type="button" className="link font-medium" onClick={onShow}>
            Show window
          </button>
          {state !== "busy" && (
            <>
              {dot}
              <button type="button" className="link font-medium" onClick={onBringBack}>
                Bring back
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
