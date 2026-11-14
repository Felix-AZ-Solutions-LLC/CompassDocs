"use client";

// "View original" (1.20.8): an emailed message as its sender saw it. The
// control is a quiet icon button on the message card (only on a message
// whose email had an HTML part, only in the desk's ticket pane); it opens a
// dialog rather than expanding in place because emails are laid out for
// their own width (a 600px newsletter table), carry their own colours, and
// can be long: the conversation column is too narrow for them, and an
// expander would push the composer away and mix the sender's styles into
// the thread. The dialog gives the email a white "paper" surface in both
// themes (never inverted or restyled), a way back (Back to the
// conversation, the close button, Escape), and focus returns to the control.
//
// The email itself is a sandboxed frame (no allow-scripts, no
// allow-same-origin: it cannot reach the desk's cookies, storage or page)
// on GET /api/helpdesk/messages/{id}/original, which sanitises it on the
// server and serves it under its own Content-Security-Policy. Remote
// pictures are hidden until "Show images", for this message only and only
// while the dialog is open; the choice is never remembered.

import { useEffect, useId, useState } from "react";
import { ArrowLeft, ImageOff, Image as ImageIcon, MailOpen, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { LoadingRow } from "@/components/Spinner";
import { RelativeTime } from "@/components/RelativeTime";
import { HD_ORIGINAL_COPY, type HdOriginalInfo } from "@/lib/helpdesk/email-html-shared";
import type { HdMessage } from "@/lib/helpdesk/types";
import { getJson } from "../api";

/** The quiet control on a message card. */
export function ViewOriginalButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={HD_ORIGINAL_COPY.control}
      data-tt={HD_ORIGINAL_COPY.control}
      data-testid="view-original"
      className={iconButtonClass("quiet", "sm", "print:hidden")}
    >
      <MailOpen className="h-4 w-4" aria-hidden />
    </button>
  );
}

export function OriginalEmailDialog({ message, onClose }: { message: HdMessage | null; onClose: () => void }) {
  const titleId = useId();
  const [info, setInfo] = useState<HdOriginalInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Never remembered: a new message (or the dialog opened again) starts with pictures hidden.
  const [images, setImages] = useState(false);
  const id = message?.id ?? null;

  useEffect(() => {
    setInfo(null);
    setError(null);
    setImages(false);
    if (id === null) return;
    const ctl = new AbortController();
    getJson<HdOriginalInfo>(`/api/helpdesk/messages/${id}/original?format=info`, HD_ORIGINAL_COPY.failed, ctl.signal)
      .then((i) => setInfo(i))
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message || HD_ORIGINAL_COPY.failed);
      });
    return () => ctl.abort();
  }, [id]);

  const src = id === null ? "" : `/api/helpdesk/messages/${id}/original${images ? "?images=1" : ""}`;

  return (
    <Modal
      open={message !== null}
      onClose={onClose}
      labelledBy={titleId}
      className="flex max-h-[calc(100dvh-2rem)] w-full max-w-4xl flex-col rounded-xl border border-slate-200 bg-surface shadow-modal"
    >
      <div className="flex items-start gap-3 px-5 pt-4">
        <MailOpen className="mt-0.5 h-5 w-5 shrink-0 text-compass-600" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            {HD_ORIGINAL_COPY.title}
          </h2>
          {message && (
            <p className="mt-0.5 truncate text-sm text-slate-500">
              From {message.author_name || message.author_email} · <RelativeTime value={message.created_at} />
            </p>
          )}
        </div>
        <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 px-5 pt-3">
        {error && <p className="notice-error rounded-lg border px-3 py-2 text-sm">{error}</p>}
        {!info && !error && <LoadingRow className="py-10" />}
        {info?.ok && (
          <>
            {info.remote_images > 0 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-700" data-testid="remote-images-bar">
                {images ? (
                  <>
                    <ImageIcon className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                    <span className="min-w-0 flex-1">{HD_ORIGINAL_COPY.imagesShown}</span>
                  </>
                ) : (
                  <>
                    <ImageOff className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                    <span className="min-w-0 flex-1">{HD_ORIGINAL_COPY.imagesHidden}</span>
                    <Button variant="secondary" size="sm" icon={<ImageIcon />} onClick={() => setImages(true)}>
                      {HD_ORIGINAL_COPY.showImages}
                    </Button>
                  </>
                )}
              </div>
            )}
            {info.insecure_images > 0 && <p className="text-xs text-slate-500">{HD_ORIGINAL_COPY.insecure(info.insecure_images)}</p>}
            {info.truncated && <p className="notice-warn rounded-lg border px-3 py-2 text-sm">{HD_ORIGINAL_COPY.truncated}</p>}
            {/* The paper: literal white in both themes (STYLEGUIDE §Helpdesk: the desk, "View original"). */}
            <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-200 bg-white">
              <iframe
                key={src}
                src={src}
                title={HD_ORIGINAL_COPY.frameTitle}
                sandbox="allow-popups allow-popups-to-escape-sandbox"
                referrerPolicy="no-referrer"
                loading="eager"
                data-testid="original-frame"
                className="block h-[min(70dvh,48rem)] w-full bg-white"
              />
            </div>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-4">
        <p className="text-xs text-slate-500">{HD_ORIGINAL_COPY.plainReplies}</p>
        <Button variant="secondary" size="sm" icon={<ArrowLeft />} onClick={onClose}>
          Back to the conversation
        </Button>
      </div>
    </Modal>
  );
}
