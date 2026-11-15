"use client";

// The ticket's composer: Reply (public, emailed to the requester) or
// Internal note (agents only), Markdown text, a macro picker ("/" at the
// start of an empty box), canned responses (";" at the start of a word, or
// the Canned response button; text only, 1.19.2 CannedPicker), an article
// picker ("[[" anywhere, or the
// Article button; the suggestions from your documents first), attachments,
// and a split Send whose menu sends and sets the status in one step
// (Waiting on requester, On hold, Solved). Ctrl/⌘+Enter sends. An unsent
// draft is kept per ticket in this browser, so switching tickets loses
// nothing.
//
// 1.20.18: Pop out (Shift+O) moves the reply into a window of its own
// (/desk/tickets/[number]/reply, ../popout). The text travels in the same
// draft; the message type, uploaded files and the picked macro travel in the
// pop-out's hand-off record (`handoff`: the pane takes it back, the pop-out
// keeps it current).

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { replyLabel } from "@/lib/helpdesk/ccs-shared";
import { BookOpen, ChevronDown, Lock, Paperclip, Reply, SquareArrowOutUpRight, X, Zap } from "lucide-react";
import { buttonClass, iconButtonClass } from "@/components/Button";
import { Popover, MenuItem } from "@/components/Popover";
import { Segmented } from "@/components/Segmented";
import { Spinner } from "@/components/Spinner";
import { controlClass } from "@/components/form";
import { toast } from "@/components/Toasts";
import type { HdAttachment, HdMacro, HdStatus, HdSuggestedArticle } from "@/lib/helpdesk/types";
import { itemOf, sendJson } from "../api";
import { bytesLabel, firstName } from "../ui";
import { MacroPicker, fillMacro } from "./MacroPicker";
import { ArticlePicker } from "./ArticlePicker";
import { CannedButton, useCannedPicker } from "./CannedPicker";
import type { HdNewerMessage } from "@/lib/helpdesk/presence-shared";
import { CollisionError, clearTyping, noteTyping, postGuarded } from "../presence/presence";
import { CollisionDialog } from "../presence/CollisionDialog";
import { useDeskMe } from "../me";
import { askTimeOnSolve } from "../time/TimeCard";
import { askMaintenanceOnSolve, logMaintenanceAfterSolve, type MaintenancePlan } from "../assets/SolveMaintenance";

import { mergeDraft } from "../claude/draft-fill";
// 1.20.5: "Before you solve" (lib/helpdesk/solve-requirements).
import { isSolveRequirementBlock } from "@/lib/helpdesk/solve-requirements-shared";
import { askBeforeYouSolve, type SolveExtras } from "../solve/BeforeYouSolve";
// 1.20.18: the reply pop-out's hand-off record (../popout/reply-popout).
// Security review fixes: drafts and the hand-off carry the agent's id; a send carries its idempotency key.
import { clearHandoff, newSendId, readDraft, readHandoff, writeDraft, writeHandoff } from "../popout/reply-popout";
import { ApiError } from "../api";
// 1.20.20: the reply lock (lib/helpdesk/reply-lock): one agent at a time writes the public reply.
import { handOffReplyLock, lastReplyTouch, moveReplyLock, pokeReplyLock, useComposerReplyLock } from "../reply-lock/reply-lock";
import { deskTabId, newDeskTabId } from "../reply-lock/tab";
import { ReplyLockBar, ReplyLockMine } from "../reply-lock/ReplyLock";

export type ComposerMode = "public" | "internal";

export interface ComposerHandle {
  focus: (mode?: ComposerMode) => void;
  /** Write a Markdown link to a document at the caret (the side column's Insert). */
  insertLink: (title: string, url: string) => void;
  /**
   * Put this text in the public reply box, after anything already written there ("Use as reply" on a Claude draft, 1.19.1);
   * 1.20.0: or in the internal note box (a Claude in the desk note draft). With `replace`, the earlier
   * Claude draft still in that box unchanged is swapped for this one (a refined draft never stacks).
   */
  fill: (text: string, target?: ComposerMode, replace?: string | null) => void;
  /** 1.20.18: Pop out (the pane's Shift+O); nothing happens without `onPopOut` or while sending or uploading. */
  popOut: () => void;
  /** 1.20.18: write the hand-off record now (the pop-out, on its way out). */
  persist: () => void;
}

const THEN: { status: HdStatus; label: string }[] = [
  { status: "pending", label: "Send and set Waiting on requester" },
  { status: "on_hold", label: "Send and set On hold" },
  { status: "solved", label: "Send and set Solved" },
];

const MAX_FILES = 10;
const MAX_BYTES = 20 * 1024 * 1024;


export const Composer = forwardRef<
  ComposerHandle,
  {
    number: number;
    subject: string;
    requesterName: string;
    agentName: string;
    suggestions: HdSuggestedArticle[];
    /**
     * Called after a message is sent; `macro` carries field changes to apply. 1.20.18: `mode`, whether it waits
     * for review, and the server's note when the status stayed (the pop-out tells the desk window).
     */
    onSent: (opts: { macro: HdMacro | null; status: HdStatus | null; mode?: ComposerMode; review?: boolean; warning?: string }) => void;
    disabled?: boolean;
    /** A newbie's public replies wait for a lead's review before the requester sees them. */
    forReview?: boolean;
    /** The desk role may add internal notes (tickets.internal_note). */
    allowNotes?: boolean;
    /** Where the composer starts: an automated ticket (no human requester) opens on the internal note. */
    defaultMode?: ComposerMode;
    /** Opened by an integration: the public tab reads "Reply", not "Reply to Monitoring". */
    automated?: boolean;
    /** The newest message the pane shows: the send guard's starting point (1.19.1 collision warnings). */
    latestMessageId?: number;
    /** Someone replied while you were typing: reload the conversation (1.19.1). */
    onNewer?: () => void;
    /** People copied on the ticket: the public tab reads "Reply to Daniel + 2 CC" (1.19.1, agent V3). */
    ccCount?: number;
    /** 1.20.5: a "Before you solve" requirement set matches this ticket (the ticket detail's before_solve). */
    beforeSolve?: boolean;
    /**
     * 1.20.18, the reply pop-out's hand-off record (message type, files, macro, the send's key): "take" starts from it
     * and clears it (the pane, as the reply comes back), "peek" starts from it and leaves it (the pane, taken back from a
     * pop-out that has not let go yet), "keep" starts from it and keeps it current until sent (the pop-out).
     */
    handoff?: "take" | "peek" | "keep";
    /** 1.20.18: shows Pop out; opens the window (inside the click) and says whether it opened. */
    onPopOut?: () => boolean;
    /** 1.20.18: the agent typed (the pop-out relays it, so the desk window's presence says "replying" too). */
    onTyping?: () => void;
    /** 1.20.18: asked first thing on Send; an answer refuses the send with that message (the pop-out no longer owns the reply). */
    canSend?: () => string | null;
    /** 1.20.18: a send, an upload or a solve question is in progress (the pop-out won't give the reply back meanwhile). */
    onBusy?: (busy: boolean) => void;
    /** 1.20.18: the server refused the send for good (e.g. "other_user": someone else is signed in now). */
    onRefused?: (code: string) => void;
  }
>(function Composer({ number, subject, requesterName, agentName, suggestions, onSent, disabled, forReview = false, allowNotes = true, defaultMode = "public", automated = false, latestMessageId, onNewer, ccCount = 0, beforeSolve = false, handoff, onPopOut, onTyping, canSend, onBusy, onRefused }, ref) {
  const me = useDeskMe();
  const uid = me.id;
  // 1.20.18: a reply handed over from the other window starts where it was left (read once, at mount).
  const [start] = useState(() => (handoff ? readHandoff(uid, number) : null));
  // 1.20.18: this send's idempotency key, kept (and handed over) until the send goes through.
  const sendId = useRef<string | null>(start?.send_id ?? null);
  const [mode, setMode] = useState<ComposerMode>(() =>
    start && (start.mode === "public" || allowNotes) ? start.mode : allowNotes ? defaultMode : "public"
  );
  // A new ticket (or a change of role) resets the message type; the first run keeps the hand-off's.
  const modeKey = useRef(`${number}:${defaultMode}:${allowNotes}`);
  useEffect(() => {
    const k = `${number}:${defaultMode}:${allowNotes}`;
    if (modeKey.current === k) return;
    modeKey.current = k;
    setMode(allowNotes ? defaultMode : "public");
  }, [number, defaultMode, allowNotes]);
  useEffect(() => {
    if (handoff === "take" && start) clearHandoff(uid, number);
    // Read once at mount: later tickets in the same pane start fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<HdAttachment[]>(() => start?.files ?? []);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [macro, setMacro] = useState<HdMacro | null>(() => start?.macro ?? null);
  const [macroOpen, setMacroOpen] = useState(false);
  const [articleOpen, setArticleOpen] = useState(false);
  const [thenOpen, setThenOpen] = useState(false);
  // 1.20.20: the first change to the Reply box takes the reply lock; someone else's makes the box read-only.
  const lock = useComposerReplyLock(number, mode === "public", !!text.trim());
  const lockRO = mode === "public" && lock.lockedByOther;
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const macroBtn = useRef<HTMLButtonElement>(null);
  const articleBtn = useRef<HTMLButtonElement>(null);
  const thenBtn = useRef<HTMLButtonElement>(null);
  // Canned responses (1.19.2, agent W4): the ";" picker and its button.
  const canned = useCannedPicker({ area, number, requesterName, agentName, disabled, setText: change });
  /** Text handed over by fill() across a switch to the public box (1.19.1). */
  const filled = useRef<string | null>(null);
  // 1.19.1 send guard (lib/helpdesk/presence): the newest message id when
  // this text was started; Send asks the server whether anyone else has
  // written since. A collision opens the dialog instead of sending.
  const baseline = useRef<number | null>(null);
  const [collision, setCollision] = useState<{ newer: HdNewerMessage[]; then: HdStatus | null } | null>(null);
  useEffect(() => {
    baseline.current = null;
  }, [number, mode]);
  useEffect(() => {
    if (!text.trim()) {
      baseline.current = null;
      clearTyping(number);
    } else if (baseline.current === null) baseline.current = latestMessageId ?? 0;
  }, [text, number, latestMessageId]);

  // A new ticket (or a mode switch) loads its own draft. 1.20.18: the first run keeps the hand-off's files and macro.
  const draftKeyNow = useRef(`${number}:${mode}`);
  useEffect(() => {
    setText(filled.current ?? readDraft(uid, number, mode));
    filled.current = null;
    const k = `${number}:${mode}`;
    if (draftKeyNow.current === k) return;
    draftKeyNow.current = k;
    setFiles([]);
    setMacro(null);
    setUploadError("");
  }, [number, mode]);

  // 1.20.20: the reply lock's tabs in the hand-off record (the pop-out's and the pane's), kept as they were handed over.
  const lockTabs = useRef({ tab: start?.lock_tab ?? null, home: start?.lock_home ?? null });
  const lockFields = () => ({ lock_tab: lockTabs.current.tab, lock_home: lockTabs.current.home, lock_at: lastReplyTouch(number) || start?.lock_at || null });
  // 1.20.20: the reply came back to the pane (brought or taken back): its lock comes back to this tab with it.
  useEffect(() => {
    if ((handoff === "take" || handoff === "peek") && start?.lock_tab) void moveReplyLock(number, start.lock_tab, deskTabId());
    // At mount only, as the hand-off is read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1.20.18: the pop-out keeps its hand-off record current, so a reload or a close hands back what is here now.
  const sentOut = useRef(false);
  const persist = () => {
    if (handoff === "keep" && !sentOut.current) writeHandoff(uid, number, { mode, files, macro, send_id: sendId.current, ...lockFields() });
  };
  useEffect(() => {
    if (handoff === "keep" && !sentOut.current) writeHandoff(uid, number, { mode, files, macro, send_id: sendId.current, ...lockFields() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff, uid, number, mode, files, macro]);

  // 1.20.18: what is in progress (a send with its solve questions, an upload), for the pop-out.
  const [phase, setPhase] = useState(0);
  useEffect(() => onBusy?.(phase > 0 || uploading > 0), [phase, uploading, onBusy]);

  /** 1.20.18: Pop out. The text is already in the draft; the rest goes in the hand-off record first. */
  function popOut() {
    if (!onPopOut || busy || uploading > 0 || disabled) return;
    writeDraft(uid, number, mode, text);
    // 1.20.20: the reply lock goes with the reply. The pop-out's tab id is minted here and handed to it in the hand-off
    // record (never the address); the lock moves to it before the window opens and comes back if the window is blocked.
    const popTab = newDeskTabId();
    const home = deskTabId();
    lockTabs.current = { tab: popTab, home };
    writeHandoff(uid, number, { mode, files, macro, send_id: sendId.current, lock_tab: popTab, lock_home: home, lock_at: lastReplyTouch(number) || null });
    const moving = lock.mine ? handOffReplyLock(number, popTab) : null;
    if (!onPopOut() && moving) void moving.then((moved) => moved && moveReplyLock(number, popTab, home));
  }

  useImperativeHandle(ref, () => ({
    focus(next) {
      if (next && next !== mode && (next === "public" || allowNotes)) setMode(next);
      requestAnimationFrame(() => area.current?.focus());
    },
    insertLink(title, url) {
      insertAtCursor(`[${title}](${absolute(url)})`);
    },
    fill(draft, target = "public", replace = null) {
      // A note needs the note capability; without it a note draft is not put anywhere.
      if (target === "internal" && !allowNotes) return;
      // What the agent already wrote in that box stays, above the draft; an earlier Claude draft is replaced.
      const had = mode === target ? text : readDraft(uid, number, target);
      const next = mergeDraft(had, draft, replace);
      writeDraft(uid, number, target, next);
      if (target === "public") lock.touch(!!next.trim());
      if (mode === target) setText(next);
      else {
        filled.current = next;
        setMode(target);
      }
      requestAnimationFrame(() => area.current?.focus());
    },
    popOut,
    persist,
  }));

  function change(v: string) {
    setText(v);
    writeDraft(uid, number, mode, v);
    if (v.trim()) {
      noteTyping(number); // "is replying" for the others (1.19.1)
      onTyping?.();
    }
    if (mode === "public") lock.touch(!!v.trim());
  }

  function insertAtCursor(snippet: string) {
    const el = area.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + snippet + text.slice(end);
    change(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + snippet.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function onInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    // "/" typed into an empty box opens the macros instead of writing it.
    if (text === "" && v === "/") {
      setMacroOpen(true);
      return;
    }
    // "[[" opens the article picker; the brackets are not kept.
    const caret = e.target.selectionStart ?? v.length;
    if (v.slice(caret - 2, caret) === "[[" && v.length > text.length) {
      change(v.slice(0, caret - 2) + v.slice(caret));
      setArticleOpen(true);
      return;
    }
    change(v);
    canned.onInput(v, caret);
  }

  async function upload(list: FileList | null) {
    if (!list || list.length === 0) return;
    setUploadError("");
    const picked = Array.from(list).slice(0, MAX_FILES - files.length);
    for (const f of picked) {
      if (f.size > MAX_BYTES) {
        setUploadError(`${f.name} is larger than 20 MB, the limit for one file.`);
        continue;
      }
      setUploading((u) => u + 1);
      try {
        const body = new FormData();
        body.append("file", f);
        const res = await fetch("/api/helpdesk/attachments", { method: "POST", body });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const server = (data as { error?: string }).error;
          if (res.status === 413) throw new Error(server || `${f.name} is too large to attach.`);
          if (res.status === 415) throw new Error(server || `${f.name} is a kind of file that can't be attached.`);
          throw new Error(server || `Couldn't attach ${f.name}.`);
        }
        setFiles((prev) => [...prev, itemOf<HdAttachment>(data, "attachment")]);
      } catch (err) {
        setUploadError((err as Error).message);
      } finally {
        setUploading((u) => u - 1);
      }
    }
    if (fileInput.current) fileInput.current.value = "";
  }

  // 1.19.3: the maintenance record chosen for this send's solve (assets/SolveMaintenance).
  const maintenancePlan = useRef<MaintenancePlan | null>(null);
  // 1.20.5: what the "Before you solve" dialog collected for this send's solve (solve/BeforeYouSolve).
  const solveExtras = useRef<SolveExtras | null>(null);

  /** 1.20.18: one send (its solve questions, the POST, a retry) counts as in progress from start to end. */
  async function send(then: HdStatus | null, force = false, askedAgain = false) {
    setPhase((p) => p + 1);
    try {
      await sendOnce(then, force, askedAgain);
    } finally {
      setPhase((p) => p - 1);
    }
  }

  async function sendOnce(then: HdStatus | null, force = false, askedAgain = false) {
    setThenOpen(false);
    if (mode === "public" && lock.lockedByOther) return;
    if (!text.trim() || busy || uploading) {
      if (!text.trim()) area.current?.focus();
      return;
    }
    // 1.20.18: the pop-out checks it still owns the reply before anything is asked or sent.
    const refused = canSend?.() ?? null;
    if (refused) {
      toast("error", refused);
      return;
    }
    const status = then ?? (mode === "public" && macro?.actions.status ? macro.actions.status : null);
    // A team that records time asks for it before a solve, as Solve and `e`
    // do (1.19.1, agent V8's askTimeOnSolve); cancelling sends nothing. A
    // forced resend after a collision warning was already asked.
    // 1.19.3: a linked asset may log a maintenance record once solved (assets/SolveMaintenance);
    // a forced resend keeps what was chosen the first time.
    if (status === "solved" && !force) {
      const plan = await askMaintenanceOnSolve(number, subject);
      if (plan === false) return;
      maintenancePlan.current = plan;
    }
    if (status === "solved" && !force && !(await askTimeOnSolve(number, me.id))) return;
    // 1.20.5: a "Before you solve" requirement set asks for what the ticket still needs. Cancelling sends nothing and
    // leaves the text as it is. A public reply counts as the reply a set may require; a reply that waits for review
    // changes no status, so nothing is asked. A forced resend keeps what was filled in the first time.
    const publicReply = mode === "public";
    if (status === "solved" && !force && !askedAgain && !(publicReply && forReview)) {
      const extra = await askBeforeYouSolve(number, { applies: beforeSolve, reply: publicReply, subject });
      if (extra === false) return;
      solveExtras.current = extra;
    }
    // Asked again after the solve questions: the desk may have taken the reply back meanwhile.
    const late = canSend?.() ?? null;
    if (late) {
      toast("error", late);
      return;
    }
    // 1.20.18: the key stays the same for every try of this send, here or in the other window (hand-off).
    if (!sendId.current) {
      sendId.current = newSendId();
      persist();
    }
    setBusy(true);
    try {
      // The send guard (1.19.1): postGuarded throws CollisionError on a 409 { newer }.
      const sent = await postGuarded<{ status_unchanged?: string; duplicate?: boolean }>(
        `/api/helpdesk/tickets/${number}/messages`,
        {
          kind: mode,
          body: text.trim(),
          attachments: files.map((f) => f.id),
          then_status: status ?? undefined,
          ...(status === "solved" && solveExtras.current ? { solve_answers: solveExtras.current.solve_answers, solve_fields: solveExtras.current.solve_fields } : {}),
          ...(latestMessageId !== undefined ? { expect_last_message_id: baseline.current ?? latestMessageId } : {}),
          ...(force ? { force: true } : {}),
          client_send_id: sendId.current,
          expect_user_id: uid,
        },
        mode === "public" ? "Couldn't send the reply." : "Couldn't add the note."
      );
      clearTyping(number);
      sendId.current = null;
      if (mode === "public") lock.sent();
      // 1.20.18: the same send had already gone through (from the other window): nothing was posted twice.
      if (sent?.duplicate) toast("ok", mode === "public" ? "This reply was already sent." : "This note was already added.");
      else toast("ok", mode === "public" ? (forReview ? "Sent for review. A lead checks it before it goes out." : "Reply sent.") : "Note added.");
      // 1.19.2: sent, but a required checklist item was unticked meanwhile, so the status stayed (agent W3).
      if (sent?.status_unchanged) toast("error", `Sent, but the status didn't change. ${sent.status_unchanged}`);
      else if (status === "solved" && maintenancePlan.current) void logMaintenanceAfterSolve(number, maintenancePlan.current);
      maintenancePlan.current = null;
      solveExtras.current = null;
      writeDraft(uid, number, mode, "");
      // 1.20.18: nothing is left to hand back once sent.
      if (handoff === "keep") sentOut.current = true;
      clearHandoff(uid, number);
      setText("");
      setFiles([]);
      const used = macro;
      setMacro(null);
      onSent({ macro: used, status, mode, review: mode === "public" && forReview, warning: sent?.status_unchanged || undefined });
    } catch (err) {
      pokeReplyLock(number); // 1.20.20: a 409 "Sam Lee is replying" shows the lock at once
      if (err instanceof CollisionError) {
        setCollision({ newer: err.newer, then });
        onNewer?.();
      } else if (status === "solved" && !askedAgain && isSolveRequirementBlock((err as Error).message)) {
        // 1.20.5: nothing was sent. A set switched on since the ticket was loaded: ask now and send once more.
        setBusy(false);
        const extra = await askBeforeYouSolve(number, { force: true, reply: publicReply, subject });
        if (extra) {
          solveExtras.current = extra;
          return sendOnce(then, force, true);
        }
        if (extra === null) toast("error", (err as Error).message);
      } else {
        toast("error", (err as Error).message);
        // 1.20.18: someone else is signed in now: this page's reply is not theirs to send.
        if (err instanceof ApiError && err.code === "other_user") onRefused?.(err.code);
      }
    } finally {
      setBusy(false);
    }
  }

  const internal = mode === "internal";
  const sendLabel = internal ? "Add note" : forReview ? "Send for review" : "Send";

  return (
    <section
      aria-label="Reply"
      className={`rounded-xl border shadow-xs ${
        internal ? "border-amber-200 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/5" : "border-slate-200 bg-surface"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2">
        <Segmented
          size="sm"
          label="Message type"
          value={mode}
          onChange={setMode}
          options={[
            { value: "public", label: replyLabel(requesterName && !automated ? firstName(requesterName) : "", ccCount), icon: Reply },
            ...(allowNotes ? [{ value: "internal" as const, label: "Internal note", icon: Lock }] : []),
          ]}
        />
        {internal && <span className="text-xs text-slate-500">Only agents see notes.</span>}
        {!internal && forReview && <span className="text-xs text-slate-500">A lead reviews your reply before it goes out.</span>}
        {!internal && lock.mine && <ReplyLockMine lock={lock} />}
        {/* 1.20.18: Pop out, desktop widths only (a new window means nothing on a phone). */}
        {onPopOut && (
          <span className="ml-auto hidden sm:inline-flex print:hidden">
            <button
              type="button"
              onClick={popOut}
              disabled={busy || uploading > 0 || disabled}
              aria-label="Pop out the reply"
              aria-keyshortcuts="Shift+O"
              data-tt="Pop out (Shift+O)"
              data-tt-align="end"
              className={iconButtonClass("quiet", "sm")}
            >
              <SquareArrowOutUpRight aria-hidden />
            </button>
          </span>
        )}
      </div>
      {!internal && <ReplyLockBar lock={lock} text={text} onTaken={() => requestAnimationFrame(() => area.current?.focus())} />}
      <textarea
        ref={area}
        value={text}
        onChange={onInput}
        {...canned.textareaProps}
        onSelect={canned.onCaret}
        onKeyDown={(e) => {
          if (canned.onKeyDown(e)) return;
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send(null);
          }
        }}
        disabled={disabled}
        readOnly={lockRO}
        onFocus={() => !internal && lock.touch(false)}
        aria-label={internal ? "Internal note" : "Reply"}
        placeholder={internal ? "Write a note for the team… / for a macro, ; for a canned response, [[ for an article" : "Write a reply… / for a macro, ; for a canned response, [[ for an article"}
        rows={4}
        maxLength={20000}
        className={controlClass(false, "block min-h-24 w-full resize-y rounded-none border-0 bg-transparent px-3 py-3 text-sm shadow-none")}
      />
      {macro && (
        <p className="px-3 pb-1 text-xs text-slate-500">
          Macro: <span className="font-medium text-slate-700">{macro.title}</span>
          {macroChanges(macro) && <> · on send it also {macroChanges(macro)}</>}{" "}
          <button type="button" className="link" onClick={() => setMacro(null)}>
            Don&apos;t apply
          </button>
        </p>
      )}
      {(files.length > 0 || uploading > 0) && (
        <ul className="flex flex-wrap gap-2 px-3 pb-2" aria-label="Attachments">
          {files.map((f) => (
            <li key={f.id} className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-surface py-0.5 pl-2 pr-0.5 text-xs text-slate-600">
              <Paperclip className="h-3.5 w-3.5 text-slate-400" aria-hidden />
              <span className="max-w-48 truncate">{f.name}</span>
              <span className="text-slate-500">· {bytesLabel(f.size)}</span>
              <button
                type="button"
                onClick={() => setFiles((prev) => prev.filter((x) => x.id !== f.id))}
                aria-label={`Remove ${f.name}`}
                data-tt="Remove"
                className={iconButtonClass("quiet", "sm")}
              >
                <X aria-hidden />
              </button>
            </li>
          ))}
          {uploading > 0 && (
            <li className="inline-flex items-center gap-1.5 text-xs text-slate-500">
              <Spinner size="sm" /> Uploading…
            </li>
          )}
        </ul>
      )}
      {uploadError && (
        <p role="alert" className="px-3 pb-2 text-xs text-red-600">
          {uploadError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-3 py-2">
        <div className="relative">
          <button
            ref={macroBtn}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={macroOpen}
            disabled={lockRO}
            onClick={() => setMacroOpen((o) => !o)}
            className={buttonClass("secondary", "sm")}
          >
            <Zap className="h-3.5 w-3.5" aria-hidden />
            Macro
          </button>
          <MacroPicker
            open={macroOpen}
            onClose={() => setMacroOpen(false)}
            triggerRef={macroBtn}
            onPick={async (m) => {
              setMacroOpen(false);
              setMacro(m);
              // The server fills every placeholder for this ticket; the
              // client fill is the fallback if the preview is refused.
              let body = fillMacro(m.body, { requesterName, agentName, number, subject });
              try {
                const d = await sendJson<{ body?: string }>(`/api/helpdesk/tickets/${number}/macro/${m.id}`, "POST", { preview: true });
                if (typeof d.body === "string") body = d.body;
              } catch {
                /* keep the client-side fill */
              }
              insertAtCursor(body);
            }}
          />
        </div>
        <CannedButton picker={canned} disabled={disabled || lockRO} />
        <div className="relative">
          <button
            ref={articleBtn}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={articleOpen}
            disabled={lockRO}
            onClick={() => setArticleOpen((o) => !o)}
            className={buttonClass("secondary", "sm")}
          >
            <BookOpen className="h-3.5 w-3.5" aria-hidden />
            Article
          </button>
          <ArticlePicker
            open={articleOpen}
            onClose={() => setArticleOpen(false)}
            triggerRef={articleBtn}
            suggestions={suggestions}
            onPick={(a) => {
              setArticleOpen(false);
              insertAtCursor(`[${a.title}](${absolute(a.url)})`);
            }}
          />
        </div>
        <input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} onChange={(e) => upload(e.target.files)} aria-hidden />
        <button
          type="button"
          onClick={() => {
            if (!internal) lock.touch(true);
            fileInput.current?.click();
          }}
          disabled={files.length >= MAX_FILES || lockRO}
          aria-label="Attach files"
          data-tt="Attach files"
          className={iconButtonClass("bordered", "sm")}
        >
          <Paperclip aria-hidden />
        </button>
        <div className="relative ml-auto inline-flex">
          <button
            type="button"
            onClick={() => send(null)}
            disabled={busy || uploading > 0 || disabled || lockRO}
            aria-busy={busy || undefined}
            className={buttonClass("primary", "sm", "rounded-r-none")}
          >
            {busy && <Spinner size="sm" />}
            {sendLabel}
          </button>
          <button
            ref={thenBtn}
            type="button"
            onClick={() => setThenOpen((o) => !o)}
            disabled={busy || uploading > 0 || disabled || lockRO}
            aria-haspopup="menu"
            aria-expanded={thenOpen}
            aria-label={`${sendLabel} and set the status`}
            data-tt="Send and set the status"
            className={buttonClass("primary", "sm", "rounded-l-none border-l border-white/30 px-1.5")}
          >
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </button>
          <Popover open={thenOpen} onClose={() => setThenOpen(false)} triggerRef={thenBtn} role="menu" label="Send and set the status" align="end" side="top" width="w-72">
            {THEN.map((t) => (
              <MenuItem key={t.status} onClick={() => send(t.status)}>
                {internal ? t.label.replace("Send", "Add note") : t.label}
              </MenuItem>
            ))}
          </Popover>
        </div>
      </div>
      {/* 1.19.1 collision warning (mock-up 5): nothing was sent. */}
      <CollisionDialog
        open={collision !== null}
        newer={collision?.newer ?? []}
        mode={mode}
        requesterName={automated ? "" : requesterName}
        busy={busy}
        onKeep={() => {
          // These messages have been seen now: Send warns only about newer ones.
          baseline.current = Math.max(baseline.current ?? 0, ...(collision?.newer ?? []).map((m) => m.id));
          setCollision(null);
          requestAnimationFrame(() => area.current?.focus());
        }}
        onDiscard={() => {
          setCollision(null);
          change("");
          setFiles([]);
          setMacro(null);
          clearTyping(number);
        }}
        onSendAnyway={() => {
          const then = collision?.then ?? null;
          setCollision(null);
          void send(then, true);
        }}
      />
    </section>
  );
});

function absolute(url: string): string {
  if (/^https?:\/\//i.test(url) || typeof window === "undefined") return url;
  return `${window.location.origin}${url.startsWith("/") ? "" : "/"}${url}`;
}

function macroChanges(m: HdMacro): string {
  const parts: string[] = [];
  if (m.actions.status) parts.push("sets the status");
  if (m.actions.priority) parts.push("sets the priority");
  if (m.actions.team_id) parts.push("moves the team");
  if (m.actions.tags_add?.length) parts.push(`adds ${m.actions.tags_add.join(", ")}`);
  return parts.join(", ");
}
