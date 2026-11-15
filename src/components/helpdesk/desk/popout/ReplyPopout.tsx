"use client";

// The reply pop-out window (1.20.18, /desk/tickets/[number]/reply; STYLEGUIDE
// §Helpdesk: the desk, "The reply pop-out"). A compact header (number,
// subject, requester, status, who else is here, CCs and the answer-from
// address), the latest messages under a toggle, a draft from Claude, and the
// ticket pane's own Composer with everything it does there: macros, canned
// responses, articles, attachments, Send and Send-and-set-status, the solve
// prompts (maintenance, time, Before you solve), newbie review, internal
// notes, the presence heartbeat and the send guard's collision dialog.
//
// It loads the ticket from the same route as the pane, so a fresh load checks
// access and a ticket the agent can't work shows the pane's refusal. It
// claims the reply for this ticket (usePopoutOwner): a second pop-out for the
// same ticket says so and sends nothing. Sent: the desk window hears it
// (reload, empty composer, a toast) and this window closes. Closed unsent:
// the desk window gets the reply back.

import { useCallback, useEffect, useRef, useState } from "react";
import { AppWindow, ChevronDown, CircleCheck, Inbox, Lock, LogOut, ShieldOff, Trash2, TriangleAlert, Undo2 } from "lucide-react";
import { chipClass } from "@/components/Chip";
import { EmptyState } from "@/components/form";
import { LoadingRow } from "@/components/Spinner";
import { PageHeader } from "@/components/PageHeader";
import type { HdMacro, HdStatus, HdTicketDetail, HdTicketPatch } from "@/lib/helpdesk/types";
import { ApiError, getJson } from "../api";
import { useCan, useDeskMe } from "../me";
import { statusChip } from "../ui";
import { Composer, type ComposerHandle, type ComposerMode } from "../ticket/Composer";
import { Conversation } from "../ticket/Conversation";
import { ClaudeDraftCard } from "../ticket/ClaudeDraftCard";
import { TicketCcRow, useTicketPeople } from "../ticket/TicketPeople";
import { TicketPresence } from "../presence/TicketPresence";
import { latestMessageId } from "../presence/presence";
import { SolveMaintenanceHost } from "../assets/SolveMaintenance";
import { BeforeYouSolveHost } from "../solve/BeforeYouSolve";
import { usePopoutOwner } from "./useReplyPopout";
import { readHandoff } from "./reply-popout";
import { adoptDeskTabId } from "../reply-lock/tab";
import { inheritReplyTouch } from "../reply-lock/reply-lock";

/** How many of the latest messages the window shows. */
const LATEST = 3;

// 1.20.18 (security review): first thing, cut the link back to the window that opened this one, so a page
// this window is later sent to (a link in a message) can never reach or redirect the desk. The two windows
// talk only over the same-origin channel (./reply-popout).
if (typeof window !== "undefined") {
  try {
    window.opener = null;
  } catch {
    /* already gone */
  }
}

/**
 * Close the window. A browser closes only a window a script opened (Pop out does); one opened by hand
 * (a pasted address) stays, so it goes to `fallback` in the desk instead.
 */
function closeWindow(fallback?: string) {
  try {
    window.close();
  } catch {
    /* the browser decides */
  }
  if (fallback) setTimeout(() => !window.closed && window.location.assign(fallback), 300);
}

export function ReplyPopout({ number }: { number: number }) {
  const me = useDeskMe();
  const can$ = useCan();
  const [d, setD] = useState<HdTicketDetail | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [showLatest, setShowLatest] = useState(true);
  const [sentHere, setSentHere] = useState(false);
  const [otherUser, setOtherUser] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const people = useTicketPeople(number);
  // 1.20.18: a send, an upload or a solve question in progress: the reply is not given back meanwhile.
  const busy = useRef(false);
  const onBusy = useCallback((b: boolean) => void (busy.current = b), []);
  // 1.20.20: the reply lock came with the reply. Before the composer mounts, this window takes the tab id the desk
  // handed the lock to (and the desk tab's, to hand it back to when it closes unsent), from the hand-off record.
  useState(() => {
    const h = readHandoff(me.id, number);
    if (h?.lock_tab) {
      adoptDeskTabId(h.lock_tab, h.lock_home);
      if (h.lock_at) inheritReplyTouch(number, h.lock_at);
    }
    return null;
  });
  const owner = usePopoutOwner(number, me.id, {
    save: () => composer.current?.persist(),
    busy: () => busy.current,
    // Claude in the desk's "Use as reply", forwarded from the desk window.
    onFill: (text, mode, replace) => composer.current?.fill(text, mode, replace),
  });

  const load = useCallback(
    (quiet = false) =>
      getJson<HdTicketDetail>(`/api/helpdesk/tickets/${number}`, "Couldn't load that ticket.")
        .then((r) => {
          setD(r);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!quiet) setError({ status: e instanceof ApiError ? e.status : 0, message: (e as Error).message });
        }),
    [number]
  );

  // The pane's rhythm, a little quicker: what arrived while composing shows up here too.
  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && load(true), 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function afterSend({ macro, mode, review, warning }: { macro: HdMacro | null; status: HdStatus | null; mode?: ComposerMode; review?: boolean; warning?: string }) {
    // Sent: the desk hears it first (its toast and reload never wait on what follows).
    owner.sent(mode === "internal" ? "internal" : review ? "review" : "public", warning);
    setSentHere(true);
    // A macro's other changes, as the pane applies them (the route checks each one). `keepalive`, so closing
    // this window now still lets them through; the desk reloads once they are in.
    if (macro && d) {
      const p: HdTicketPatch = {};
      if (macro.actions.priority) p.priority = macro.actions.priority;
      if (macro.actions.team_id) p.team_id = macro.actions.team_id;
      if (macro.actions.tags_add?.length) p.tags = Array.from(new Set([...d.ticket.tags, ...macro.actions.tags_add]));
      if (Object.keys(p).length) {
        await fetch(`/api/helpdesk/tickets/${number}`, {
          method: "PATCH",
          keepalive: true,
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(p),
        }).catch(() => null);
        owner.changed();
      }
    }
    closeWindow();
  }

  const t = d?.ticket;
  let body: React.ReactNode;
  if (owner.state === "signedout") {
    body = <Refusal icon={<LogOut />} title="You signed out" text="Sign in again from the desk to carry on. Nothing was sent from here." back="/login" />;
  } else if (otherUser) {
    body = (
      <Refusal
        icon={<ShieldOff />}
        title="Someone else is signed in now"
        text="This window was opened for another account, so it sends nothing. Open the ticket from the desk instead."
        back="/desk"
      />
    );
  } else if (owner.state === "taken") {
    body = (
      <Refusal
        icon={<Undo2 />}
        title="This reply was taken back in the desk"
        text="Finish it in the ticket. Nothing more is sent from this window."
        back={`/desk/tickets/${number}`}
      />
    );
  } else if (owner.state === "duplicate") {
    body = (
      <Refusal
        icon={<AppWindow />}
        title="This reply is already open in another window"
        text="Finish it there. Two windows for one reply could send it twice."
        back={`/desk/tickets/${number}`}
      />
    );
  } else if (sentHere) {
    body = <Refusal icon={<CircleCheck />} title="Sent" text="You can close this window." back={`/desk/tickets/${number}`} />;
  } else if (error) {
    body =
      error.status === 410 ? (
        <Refusal icon={<Trash2 />} title={`Ticket #${number} is in the recycle bin`} text="Restore it from the desk before replying." />
      ) : error.status === 404 ? (
        <Refusal icon={<Inbox />} title={`There's no ticket #${number}`} text="It may have been deleted, or the number is wrong." />
      ) : error.status === 403 ? (
        <Refusal icon={<ShieldOff />} title="This ticket belongs to another team" text="You can open tickets of the teams you're in and tickets assigned to you." />
      ) : (
        <Refusal icon={<TriangleAlert />} title="Couldn't load this ticket" text={error.message} retry={() => void load()} />
      );
  } else if (!d || !t || owner.state === "checking") {
    body = <LoadingRow className="py-16" />;
  } else if (!d.can_work) {
    body = <Refusal icon={<ShieldOff />} title="You can't reply on this ticket" text="You can read this ticket but not work it: it belongs to a team you're not in." />;
  } else if (t.merged_into) {
    const into = d.merge?.into && !d.merge.into.deleted ? d.merge.into : null;
    body = <Refusal icon={<Lock />} title="This ticket was merged" text={into ? `Reply on #${into.number} instead.` : "Reply on the ticket it was merged into."} />;
  }

  const chip = t ? statusChip(t) : null;
  const latest = d?.messages.slice(-LATEST) ?? [];
  const ready = !body && d && t;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="reply-popout">
      <PageHeader className="sr-only" title={t ? `Reply to #${t.number}: ${t.subject}` : `Reply #${number}`} />
      {ready && (
        <header className="shrink-0 border-b border-slate-200 bg-surface px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-slate-500">
                #{t.number}
                {t.team_name && ` · ${t.team_name}`}
                {" · "}
                {t.requester_name || t.requester_email}
                {t.requester_name && t.requester_email && <span className="text-slate-500"> ({t.requester_email})</span>}
              </p>
              <h2 className="mt-0.5 truncate text-base font-semibold text-slate-900" data-tt={t.subject}>
                {t.subject}
              </h2>
            </div>
            {chip && <span className={chipClass(chip.tone, "sm")}>{chip.label}</span>}
          </div>
          <TicketPresence number={t.number} className="mt-1.5" />
          <TicketCcRow
            number={t.number}
            state={people}
            meId={me.id}
            requesterId={t.requester_id}
            canEdit={t.status !== "solved" && t.status !== "closed" && (can$("tickets.reply_public") || can$("tickets.reply_needs_review"))}
          />
          {/* The answer-from address (1.20.2), as the side panel shows it: changed there, read here. */}
          {d.mailboxes && d.mailbox && (
            <p className="mt-1.5 text-xs text-slate-500" data-testid="reply-from">
              Answering from <span className="font-medium text-slate-700">{d.mailbox.address}</span>
            </p>
          )}
        </header>
      )}
      <div tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto px-4 py-3 outline-none">
        {body ?? (
          ready && (
            <div className="flex flex-col gap-3">
              {latest.length > 0 && (
                <section aria-label="Latest messages">
                  <button
                    type="button"
                    onClick={() => setShowLatest((s) => !s)}
                    aria-expanded={showLatest}
                    aria-controls="reply-latest"
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-800"
                  >
                    <ChevronDown className={`h-3.5 w-3.5 transition ${showLatest ? "" : "-rotate-90"}`} aria-hidden />
                    {d.messages.length > LATEST ? `Latest ${LATEST} of ${d.messages.length} messages` : "Messages"}
                  </button>
                  <div id="reply-latest" hidden={!showLatest} className="mt-2">
                    <Conversation messages={latest} requesterId={t.requester_id} meId={me.id} ticketNumber={t.number} origins={d.merge?.message_origins} originals />
                  </div>
                </section>
              )}
              <ClaudeDraftCard number={t.number} onUse={(text) => composer.current?.fill(text)} />
              <Composer
                ref={composer}
                number={t.number}
                subject={t.subject}
                requesterName={t.requester_name}
                ccCount={people.people?.ccs.length ?? 0}
                agentName={me.name}
                suggestions={d.suggested_articles}
                onSent={afterSend}
                forReview={!can$("tickets.reply_public")}
                allowNotes={can$("tickets.internal_note")}
                defaultMode={t.automated === 1 ? "internal" : "public"}
                automated={t.automated === 1}
                latestMessageId={latestMessageId(d.messages)}
                onNewer={() => void load(true)}
                beforeSolve={d.before_solve === true}
                handoff="keep"
                onTyping={owner.typing}
                canSend={() => (owner.checkOwner() ? null : "This reply was taken back in the desk. Nothing was sent from here.")}
                onBusy={onBusy}
                onRefused={() => setOtherUser(true)}
              />
            </div>
          )
        )}
      </div>
      {/* The solve flow's dialogs, as in the pane. */}
      <SolveMaintenanceHost />
      <BeforeYouSolveHost onChanged={() => void load(true)} />
    </div>
  );
}

function Refusal({ icon, title, text, retry, back = "/desk" }: { icon: React.ReactNode; title: string; text: string; retry?: () => void; back?: string }) {
  return (
    <div className="mx-auto max-w-lg py-6">
      <EmptyState icon={icon} title={title} body={text} action={retry ? { onClick: retry, label: "Try again" } : { onClick: () => closeWindow(back), label: "Close this window" }} />
    </div>
  );
}
