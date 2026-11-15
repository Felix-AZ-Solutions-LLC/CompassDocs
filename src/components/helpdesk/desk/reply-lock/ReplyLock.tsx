"use client";

// The reply lock's pieces on the desk (1.20.20, lib/helpdesk/reply-lock;
// STYLEGUIDE §Helpdesk: the reply lock):
//
//   ReplyLockAvatar   the holder's face (UserAvatar: their directory photo,
//                     else initials) with a small pen badge; its data-tt is
//                     "Sam Lee · replying since 10:42" and it has the same
//                     words as its aria-label. Focusable, except inside a
//                     link (a queue row), where the row's own text says it.
//   ReplyLockBar      above the Reply box: "Sam Lee is replying" with Take
//                     over for those who may, or, for the person a lead took
//                     the reply from, "Priya took over this reply. Your text
//                     is kept as a draft." with Copy.
//   ReplyLockMine     the holder's own line in the composer's header, with
//                     Let go.
//   ReplyLockBadge    the queue row's badge.

import { useId, useState } from "react";
import { Copy, LockKeyhole, PenLine, UserRoundCheck, X } from "lucide-react";
import { Button, buttonClass, iconButtonClass } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { confirmDialog } from "@/components/Dialog";
import { useFormatDate } from "@/components/SettingsProvider";
import { toast } from "@/components/Toasts";
import { UserAvatar } from "@/components/UserAvatar";
import { lockSentence, takenOverNotice, type HdReplyLock, type HdReplyLockBrief } from "@/lib/helpdesk/reply-lock-shared";
import type { ComposerReplyLock } from "./reply-lock";

const first = (n: string) => n.trim().split(/\s+/)[0] || n;

/** "10:42" (or "10:42 AM") in the workspace's zone and clock. */
export function useLockClock(): (iso: string) => string {
  const { settings } = useFormatDate();
  return (iso: string) => {
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        hour12: settings.time_format === "12h",
        ...(settings.timezone ? { timeZone: settings.timezone } : {}),
      }).format(new Date(iso));
    } catch {
      return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
  };
}

/** The tooltip: "Sam Lee · replying since 10:42". */
export function lockTip(name: string, since: string, clock: (iso: string) => string): string {
  return `${name} · replying since ${clock(since)}`;
}

type LockFace = Pick<HdReplyLock, "name" | "photo_url" | "since">;

export function ReplyLockAvatar({
  lock,
  size = "sm",
  inLink = false,
  className = "",
}: {
  lock: LockFace;
  size?: "2xs" | "xs" | "sm";
  /** Inside a link (a queue row): hover tooltip only, nothing focusable. */
  inLink?: boolean;
  className?: string;
}) {
  const clock = useLockClock();
  const tip = lockTip(lock.name, lock.since, clock);
  // Small enough to leave the initials readable at every size.
  const badge = size === "2xs" ? "h-2.5 w-2.5 -right-1 -bottom-1" : size === "xs" ? "h-3.5 w-3.5 -right-1.5 -bottom-1" : "h-4 w-4 -right-1 -bottom-0.5";
  const glyph = size === "2xs" ? "h-1.5 w-1.5" : size === "xs" ? "h-2 w-2" : "h-2.5 w-2.5";
  return (
    <span
      data-tt={tip}
      {...(inLink ? { "aria-hidden": true } : { role: "img", "aria-label": `${lock.name} is replying, since ${clock(lock.since)}`, tabIndex: 0 })}
      data-testid="reply-lock-avatar"
      className={`relative inline-flex shrink-0 rounded-full outline-offset-2 ${className}`}
    >
      <UserAvatar name={lock.name} avatar={lock.photo_url ?? undefined} size={size} />
      <span className={`absolute grid place-items-center rounded-full bg-compass-600 text-white ring-2 ring-surface ${badge}`} aria-hidden>
        <PenLine className={glyph} />
      </span>
    </span>
  );
}

/** The queue row's badge: the holder's small face; the row reads "Sam Lee is replying" to a screen reader. */
export function ReplyLockBadge({ lock, className = "" }: { lock: HdReplyLockBrief; className?: string }) {
  return (
    <span className={`inline-flex items-center ${className}`} data-testid="reply-lock-badge">
      <ReplyLockAvatar lock={lock} size="2xs" inLink />
      <span className="sr-only">{lock.mine ? "You are replying" : lockSentence(lock.name)}, </span>
    </span>
  );
}

/** The holder's own line in the composer header: they have the reply, and can let it go. */
export function ReplyLockMine({ lock }: { lock: ComposerReplyLock }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500" data-testid="reply-lock-mine">
      <LockKeyhole className="h-3.5 w-3.5" aria-hidden />
      Others see you're replying.
      <button type="button" className="link" onClick={() => void lock.letGo()}>
        Let go
      </button>
    </span>
  );
}

/** Above the Reply box while someone else holds the reply, or after a lead took it from you. */
export function ReplyLockBar({ lock, text, onTaken }: { lock: ComposerReplyLock; text: string; onTaken?: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const holder = lock.state?.lock ?? null;
  if (!holder || holder.mine) return null;

  if (lock.takenOver) {
    return (
      <div className="notice-warn mx-3 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 text-sm" role="status" data-testid="reply-lock-taken">
        <ReplyLockAvatar lock={holder} />
        <p className="min-w-0 flex-1">{takenOverNotice(lock.takenOver.by_name)}</p>
        {text.trim() && (
          <button
            type="button"
            className={buttonClass("secondary", "sm")}
            onClick={() => {
              void navigator.clipboard
                .writeText(text)
                .then(() => toast("ok", "Your text is copied."))
                .catch(() => toast("error", "Couldn't copy. Select the text and copy it."));
            }}
          >
            <Copy className="h-3.5 w-3.5" aria-hidden />
            Copy my text
          </button>
        )}
        <button type="button" onClick={lock.dismissTakenOver} aria-label="Dismiss" data-tt="Dismiss" className={iconButtonClass("quiet", "sm")}>
          <X aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div className="mx-3 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2" role="status" data-testid="reply-lock-bar">
      <ReplyLockAvatar lock={holder} />
      <p className="min-w-0 flex-1 text-sm text-slate-700">
        <span className="font-semibold text-slate-900">{holder.name}</span> is replying.{" "}
        <span className="text-slate-500">You can add an internal note meanwhile.</span>
      </p>
      {holder.can_take_over && (
        <span className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              const ok = await confirmDialog({
                title: `Release ${holder.name}'s reply?`,
                body: `Nobody holds it afterwards; ${first(holder.name)} keeps their text and can start again. To write it yourself, take it over.`,
                confirmLabel: "Release",
              });
              if (ok !== true) return;
              const err = await lock.release();
              toast(err ? "error" : "ok", err ?? "Released.");
            }}
          >
            Release
          </Button>
          <Button variant="secondary" size="sm" icon={<UserRoundCheck />} onClick={() => setConfirm(true)}>
            Take over
          </Button>
        </span>
      )}
      <TakeOverDialog
        open={confirm}
        name={holder.name}
        busy={busy}
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          setBusy(true);
          const err = await lock.takeOver();
          setBusy(false);
          setConfirm(false);
          if (err) toast("error", err);
          else {
            toast("ok", `You have the reply now. ${first(holder.name)} keeps their text as a draft.`);
            onTaken?.();
          }
        }}
      />
    </div>
  );
}

export function TakeOverDialog({ open, name, busy, onCancel, onConfirm }: { open: boolean; name: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const titleId = useId();
  const ledeId = useId();
  return (
    <Modal open={open} onClose={onCancel} labelledBy={titleId} describedBy={ledeId} className="w-full max-w-md rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <h2 id={titleId} className="flex items-start gap-2 text-base font-semibold text-slate-900">
        <UserRoundCheck className="mt-0.5 h-5 w-5 shrink-0 text-compass-600" aria-hidden />
        Take over {name}&apos;s reply?
      </h2>
      <p id={ledeId} className="mt-3 text-sm text-slate-600">
        {first(name)} can't send while you have it. Nothing they wrote is sent or lost: they keep it as a draft and see that you took over.
      </p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} data-autofocus>
          Cancel
        </Button>
        <Button variant="primary" onClick={onConfirm} busy={busy}>
          Take over
        </Button>
      </div>
    </Modal>
  );
}
