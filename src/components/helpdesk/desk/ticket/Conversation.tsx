"use client";

// A ticket's conversation in the desk: public messages as cards (an agent's
// reply carries the accent edge), internal notes in the amber note card with
// the "Internal note" chip (never shown to the requester), and system events
// (assignments, rules, workflow steps) as one muted line.
// Bodies are Markdown through the house MarkdownView (sanitised).
// 1.20.8: with `originals`, a message whose email had an HTML part carries
// the quiet "View original" control (./OriginalEmail); the text body stays
// what the card shows.
// 1.20.11: with `originals`, such a message shows its email formatted in
// place of the text body (./InlineEmail), with a "Plain text" / "Formatted"
// switch and "Open in a window" (the 1.20.8 dialog, where Print is). Other
// messages, and every other caller, are as before.
// 1.20.28 (lib/helpdesk/conversation-shared): field changes are activity
// lines like the status and CC lines (an automation's with a bot and its
// rule's name), an automation's own note is a compact note card, files are a
// list under their message (a picture the formatted email draws itself is
// left out of it), and `order="newest"` (the ticket pane's default) shows the
// newest first with older history folded behind "Show N earlier messages".
// Every other caller keeps oldest first, unfolded.

import { Component, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  Bot,
  CalendarCheck,
  ChevronDown,
  ClipboardCheck,
  Flag,
  FolderTree,
  Forward,
  History,
  Languages,
  Lock,
  Paperclip,
  PencilLine,
  RotateCw,
  SlidersHorizontal,
  UserMinus,
  UserPlus,
  UserRoundCheck,
  UserRoundPen,
  UserRoundX,
  Users,
  type LucideIcon,
} from "lucide-react";
import { isShareLine } from "@/lib/helpdesk/share-shared";
import {
  activityIcon,
  automationRule,
  fileKind,
  foldLabel,
  foldedIds,
  isActivityLine,
  isChangeLine,
  isPicture,
  listedFiles,
  plainChangeText,
  splitChangeLine,
  type HdActivityIcon,
  type HdFileTone,
  type HdTicketOrder,
} from "@/lib/helpdesk/conversation-shared";
import { ReviewStateChip } from "../roles/role-ui";
import { ContactHoverCard } from "@/components/helpdesk/contacts/ContactHoverCard";
import type { HdReviewState } from "@/lib/helpdesk/roles-shared";
import { chipClass } from "@/components/Chip";
import { MarkdownView } from "@/components/MarkdownView";
import { RelativeTime } from "@/components/RelativeTime";
import { initialsOf } from "@/components/UserAvatar";
import type { HdAttachment, HdMessage } from "@/lib/helpdesk/types";
import { bytesLabel } from "../ui";
import { OriginalEmailDialog } from "./OriginalEmail";
import { useInlineEmail } from "./InlineEmail";
import { MailStateLine } from "./MailStateLine";

const VIA: Record<string, string> = { email: "by email", portal: "in Get help", desk: "", system: "", mcp: "via Claude", customer_portal: "in the customer portal", api: "via API" };

const ACTIVITY_ICON: Record<HdActivityIcon, LucideIcon> = {
  bot: Bot,
  rename: PencilLine,
  team: Users,
  assign: UserRoundCheck,
  unassign: UserRoundX,
  category: FolderTree,
  priority: Flag,
  field: SlidersHorizontal,
  event: CalendarCheck,
  language: Languages,
  solve: ClipboardCheck,
  "cc-add": UserPlus,
  "cc-remove": UserMinus,
  requester: UserRoundPen,
  status: RotateCw,
  files: Paperclip,
  other: History,
};

/** A file's type square (STYLEGUIDE §Helpdesk: the desk, "Files under a message"): white on a fixed hue, both themes. */
const FILE_TONE: Record<HdFileTone, string> = {
  red: "bg-red-600",
  blue: "bg-blue-600",
  green: "bg-emerald-600",
  orange: "bg-orange-600",
  violet: "bg-violet-600",
  sky: "bg-sky-600",
  slate: "bg-slate-500",
};

/** The id a message's row carries, for a link to it (/desk/tickets/1047#message-88). */
export const messageAnchor = (id: number) => `message-${id}`;

export function Conversation({
  messages,
  requesterId,
  requesterEmail = null,
  meId,
  ticketNumber,
  origins,
  originals = false,
  order = "oldest",
}: {
  /** The requester's address: an email with no account behind it is theirs when it comes from it (the fold's sides). */
  requesterEmail?: string | null;
  /** With it, authors' names open their contact card on hover (agent O). */
  ticketNumber?: number;
  messages: HdMessage[];
  requesterId: number | null;
  meId: number;
  /** Message id → the ticket a merge moved it from ("from #1051", 1.19.1). */
  origins?: Record<number, number>;
  /** 1.20.8: offer "View original" on emailed messages (the ticket pane of an agent who works the ticket); 1.20.11: and show them formatted. */
  originals?: boolean;
  /** 1.20.28: "newest" (the ticket pane's default) shows the newest first and folds older history; "oldest" is the plain order. */
  order?: HdTicketOrder;
}) {
  const [original, setOriginal] = useState<HdMessage | null>(null);
  const newest = order === "newest";
  // The fold is decided once, as the conversation opens, as the set of messages it hides: anything not in it stays in
  // view, whatever its time (a message that arrives, a newbie's reply approved later, which moves to the end, or one
  // merged in), and an expanded history stays expanded.
  const [folds] = useState<Set<number>>(() => foldedIds(messages, { requesterId, requesterEmail }));
  const [expanded, setExpanded] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const firstRevealed = useRef<number | null>(null);

  const hiddenAll = newest && !expanded ? messages.filter((m) => folds.has(m.id)) : [];
  const hiddenCount = hiddenAll.filter((m) => !isActivityLine(m)).length;
  const folding = hiddenCount > 0;
  const shown = folding ? messages.filter((m) => !folds.has(m.id)) : messages;
  const hidden = folding ? hiddenAll : [];

  // A link to a message (#message-88) that is folded opens the history; either way it is scrolled to once shown.
  const linked = useRef<number | null>(null);
  const [linkTick, setLinkTick] = useState(0);
  useEffect(() => {
    const hit = /^#message-(\d+)$/.exec(window.location.hash);
    if (!hit || !messages.some((m) => m.id === Number(hit[1]))) return;
    linked.current = Number(hit[1]);
    if (folding && hidden.some((m) => m.id === linked.current)) setExpanded(true);
    else setLinkTick((n) => n + 1);
    // Once, as the conversation opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After the render that shows them: the linked message is scrolled to, or focus moves to the first message the
  // fold revealed (the button itself goes away).
  useEffect(() => {
    if (linked.current !== null) {
      // Not on screen yet (the fold opens in the next render): this runs again then.
      const el = document.getElementById(messageAnchor(linked.current));
      if (!el || !el.getClientRects().length) return;
      linked.current = null;
      requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
      return;
    }
    if (!expanded || firstRevealed.current === null) return;
    const el = document.getElementById(messageAnchor(firstRevealed.current));
    firstRevealed.current = null;
    el?.focus({ preventScroll: true });
  }, [expanded, linkTick]);

  const item = (m: HdMessage, offscreen = false) => {
    // Folded rows are in the page for print (which is full and oldest first) but not on screen.
    const display = offscreen ? "hidden print:flex" : "flex";
    if (isActivityLine(m) && !isShareLine(m)) return <ActivityLine key={m.id} m={m} origin={origins?.[m.id]} display={display} />;
    // 1.19.4 (area C6): "Ana shared this with Sam", an internal line agents alone see.
    if (isShareLine(m)) {
      return (
        <li
          key={m.id}
          id={messageAnchor(m.id)}
          tabIndex={-1}
          className={`${display} flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-slate-200 bg-surface px-3 py-2 text-xs text-slate-600 outline-none`}
          data-testid="share-line"
        >
          <Forward className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
          {/* The body is Markdown (names escaped by lib/helpdesk/md-inline), as in a note card. */}
          <div className="min-w-0 flex-1 [&>.doc-prose]:inline [&_.doc-prose]:text-xs! [&_.doc-prose]:text-slate-600! [&_.doc-prose_p]:my-0 [&_.doc-prose_p]:inline">
            <MarkdownView content={m.body} inline /> · <RelativeTime value={m.created_at} />
          </div>
          <span className={chipClass("warn", "sm")}>Agents only</span>
        </li>
      );
    }
    return (
      <MessageCard
        key={m.id}
        m={m}
        requesterId={requesterId}
        meId={meId}
        ticketNumber={ticketNumber}
        origin={origins?.[m.id]}
        original={originals && m.has_original_html === true}
        onOpenOriginal={() => setOriginal(m)}
        className={offscreen ? "hidden print:block" : ""}
      />
    );
  };

  const rows = newest ? [...shown].reverse() : shown;
  const folded = newest ? [...hidden].reverse() : hidden;
  // Newest first prints oldest first, like every printed conversation.
  const listClass = `flex gap-3 ${newest ? "flex-col print:flex-col-reverse" : "flex-col"}`;

  return (
    <>
      <KeepPlace list={list} watch={newest ? `${messages.length}:${messages[messages.length - 1]?.id ?? 0}` : ""}>
        <ol ref={list} className={listClass} aria-label="Conversation" data-order={order}>
          {rows.map((m) => item(m))}
          {folding && (
            <li className="print:hidden" data-testid="conversation-fold">
              <button
                type="button"
                aria-expanded={false}
                onClick={() => {
                  firstRevealed.current = folded[0]?.id ?? null;
                  setExpanded(true);
                }}
                className="group flex w-full items-center gap-3 rounded-md py-1 text-xs font-medium text-compass-700 before:h-px before:flex-1 before:bg-slate-200 after:h-px after:flex-1 after:bg-slate-200"
              >
                <span className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 group-hover:bg-compass-50">
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                  {foldLabel(hiddenCount)}
                </span>
              </button>
            </li>
          )}
          {folding ? folded.map((m) => item(m, true)) : null}
        </ol>
      </KeepPlace>
      {/* The dialog is a portal to <body> (components/Modal): nothing of it renders inside the list. */}
      {originals && <OriginalEmailDialog message={original} onClose={() => setOriginal(null)} />}
    </>
  );
}

/**
 * Newest first puts a new message at the top of the list: when the agent has scrolled down into the conversation,
 * whatever they were reading stays where it was on screen (the scroll moves by what was added above it). A browser
 * with scroll anchoring of its own has already kept it, and then nothing moves. With the top of the list in view,
 * the new message simply shows there.
 */
class KeepPlace extends Component<{ list: RefObject<HTMLOListElement | null>; watch: string; children: ReactNode }> {
  getSnapshotBeforeUpdate(prev: { watch: string }): { el: Element; y: number; scroller: HTMLElement } | null {
    if (!this.props.watch || prev.watch === this.props.watch) return null;
    const list = this.props.list.current;
    const scroller = list ? scrollParent(list) : null;
    if (!list || !scroller) return null;
    const top = scroller.getBoundingClientRect().top;
    if (list.getBoundingClientRect().top >= top) return null;
    for (const el of Array.from(list.children)) {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.bottom > top) return { el, y: r.top, scroller };
    }
    return null;
  }
  componentDidUpdate(_p: unknown, _s: unknown, snap: { el: Element; y: number; scroller: HTMLElement } | null) {
    if (!snap || !snap.el.isConnected) return;
    const dy = snap.el.getBoundingClientRect().top - snap.y;
    if (Math.abs(dy) >= 1) snap.scroller.scrollTop += dy;
  }
  render() {
    return this.props.children;
  }
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/**
 * 1.20.28: one muted line (STYLEGUIDE §Helpdesk: the desk, "Activity lines"): a status or CC line, or a field change
 * someone or an automation made. An automation's names its rule in bold after a bot, without "Automation:".
 */
function ActivityLine({ m, origin, display = "flex" }: { m: HdMessage; origin?: number; display?: string }) {
  const kind = activityIcon(m);
  const Icon = ACTIVITY_ICON[kind];
  const change = isChangeLine(m);
  // A status line an automation wrote ("Automation: Triage changed the status…") names its rule like a change line.
  const split = change ? splitChangeLine(m) : automationRule(m.author_name) ? splitChangeLine(m) : null;
  return (
    <li
      id={messageAnchor(m.id)}
      tabIndex={-1}
      className={`${display} items-start gap-2 px-1 text-xs text-slate-500 outline-none`}
      data-testid="activity-line"
      data-activity={kind}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
      <span className="min-w-0 break-words">
        {split ? (
          <>
            {split.automation && <span className="sr-only">Automation </span>}
            <span className={split.automation ? "font-semibold text-slate-700" : "font-medium text-slate-700"} data-testid="activity-actor">
              {split.actor}
            </span>{" "}
            {change ? plainChangeText(split.rest) : split.rest}
          </>
        ) : change ? (
          plainChangeText(m.body)
        ) : (
          m.body
        )}{" "}
        · <RelativeTime value={m.created_at} />
        {origin && ` · from #${origin}`}
      </span>
    </li>
  );
}

/** One message's card (1.20.11: a component, so an emailed message can keep its own view state). */
function MessageCard({
  m,
  requesterId,
  meId,
  ticketNumber,
  origin,
  original,
  onOpenOriginal,
  className = "",
}: {
  m: HdMessage;
  requesterId: number | null;
  meId: number;
  ticketNumber?: number;
  origin?: number;
  /** The message has an original email and the viewer may open it (the ticket pane of an agent who works it). */
  original: boolean;
  onOpenOriginal: () => void;
  className?: string;
}) {
  const internal = m.kind === "internal";
  // 1.20.28: an automation's own note ("add an internal note") is a compact note card that names its rule.
  const rule = internal ? automationRule(m.author_name) : null;
  // Desk roles: a newbie's public reply waits for a lead's review.
  const review = (m as HdMessage & { review_state?: string | null; review_note?: string | null });
  const fromAgent = !internal && m.author_id !== null && m.author_id !== requesterId;
  const mine = m.author_id === meId;
  const via = VIA[m.via] ?? "";
  const text: ReactNode = (
    <div
      className={`min-w-0 pl-9 [&_.doc-prose]:text-sm! [&_.doc-prose]:leading-relaxed! [&_.doc-prose_p]:my-1.5 ${
        internal ? "[&_.doc-prose]:text-amber-950! dark:[&_.doc-prose]:text-amber-100!" : ""
      }`}
    >
      <MarkdownView content={m.body} headingOffset={2} />
    </div>
  );
  const email = useInlineEmail({ id: m.id, enabled: original, author: m.author_name || m.author_email || "the sender", tinted: internal, text, onOpenWindow: onOpenOriginal });
  const all = m.attachments ?? [];
  const files = listedFiles(all, email.formatted);
  return (
    <li
      id={messageAnchor(m.id)}
      tabIndex={-1}
      data-testid={rule ? "automation-note" : undefined}
      className={`rounded-xl border shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-compass-500/40 ${rule ? "p-3" : "p-4"} ${
        internal
          ? "border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10"
          : `border-slate-200 bg-surface ${fromAgent ? "border-l-2 border-l-compass-500" : ""}`
      } ${className}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-2xs font-bold ${
            internal ? "bg-amber-200 text-amber-900 dark:bg-amber-500/25 dark:text-amber-200" : "bg-compass-100 text-compass-700"
          }`}
          aria-hidden
        >
          {rule ? <Bot className="h-3.5 w-3.5" /> : initialsOf(m.author_name || "?")}
        </span>
        <span className="text-sm font-semibold text-slate-900">
          {rule ? (
            <>
              <span className="sr-only">Automation </span>
              {rule}
            </>
          ) : mine ? (
            "You"
          ) : !ticketNumber ? (
            m.author_name || m.author_email
          ) : (
            <ContactHoverCard ticket={ticketNumber} userId={m.author_id} email={m.author_email} name={m.author_name || m.author_email}>
              {m.author_name || m.author_email}
            </ContactHoverCard>
          )}
        </span>
        {internal && (
          <span className={chipClass("warn", "sm")}>
            <Lock className="h-3 w-3" aria-hidden /> Internal note
          </span>
        )}
        <ReviewStateChip state={review.review_state as HdReviewState | null} />
        <span className="text-xs text-slate-500">
          <RelativeTime value={m.created_at} />
          {via && ` · ${via}`}
          {origin && ` · from #${origin}`}
        </span>
        {email.controls}
      </div>
      {review.review_state === "returned" && review.review_note && (
        <p className="mt-1 pl-9 text-xs text-slate-600">Reviewer&apos;s note: {review.review_note}</p>
      )}
      {/* 1.20.32: the reply's email failed, may not have gone out, or still waits in the Microsoft 365 outbox. */}
      {m.mail_delivery && ticketNumber ? <MailStateLine ticketNumber={ticketNumber} messageId={m.id} state={m.mail_delivery} /> : null}
      <div className={`${rule ? "mt-1" : "mt-1.5"} min-w-0`}>{email.body}</div>
      {/* On paper the email is its text, so its pictures are listed there too (hidden on screen while it is formatted). */}
      {all.length > 0 && <FileList files={all} shown={files} formatted={email.formatted} />}
    </li>
  );
}

/**
 * 1.20.28: a message's files (STYLEGUIDE §Helpdesk: the desk, "Files under a message"): "N attachments · size", then a
 * row per file with its type square, name, size and Download. A picture's name opens it in a new tab; anything else
 * downloads (the route serves it as a download).
 */
function FileList({ files, shown, formatted }: { files: HdAttachment[]; shown: HdAttachment[]; formatted: boolean }) {
  const onScreen = new Set(shown.map((f) => f.id));
  const head = (list: HdAttachment[]) => {
    const total = list.reduce((n, f) => n + (Number(f.size) || 0), 0);
    return (
      <>
        {list.length} {list.length === 1 ? "attachment" : "attachments"} · <span className="tabular-nums">{bytesLabel(total)}</span>
      </>
    );
  };
  const same = shown.length === files.length;
  // The list takes the width of the email above it: the formatted email spans the card, so the list does too; a text
  // message is indented under its author, so the list is as well (and on paper, where the email prints as text).
  return (
    <div
      className={`mt-3 overflow-hidden rounded-lg border border-slate-200 bg-surface break-inside-avoid ${formatted ? "print:ml-9" : "sm:ml-9"} ${shown.length ? "" : "hidden print:block"}`}
      data-testid="message-files"
    >
      <p className="flex items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-500">
        <Paperclip className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
        <span className={same ? "" : "print:hidden"}>{head(shown)}</span>
        {!same && <span className="hidden print:inline">{head(files)}</span>}
      </p>
      <ul aria-label="Files" className="divide-y divide-slate-100">
        {files.map((a) => {
          const href = `/api/helpdesk/attachments/${a.id}`;
          const kind = fileKind(a);
          const picture = isPicture(a);
          return (
            <li
              key={a.id}
              className={`${onScreen.has(a.id) ? "grid" : "hidden print:grid"} grid-cols-[1.75rem_minmax(0,1fr)_auto_auto] items-center gap-x-3 px-3 py-1.5 text-[0.8125rem]`}
            >
              <span className={`grid h-7 w-7 place-items-center rounded-md text-[0.5625rem] font-bold tracking-wide text-white ${FILE_TONE[kind.tone]}`} aria-hidden>
                {kind.label}
              </span>
              <a
                href={href}
                {...(picture ? { target: "_blank", rel: "noopener" } : { download: a.name })}
                className="truncate font-medium text-slate-800 underline-offset-2 hover:text-compass-700 hover:underline"
                // A long name truncates: the whole name is its tooltip.
                {...(a.name.length > 36 ? { "data-tt": a.name, "data-tt-wrap": "" } : {})}
              >
                {a.name}
              </a>
              <span className="text-xs tabular-nums text-slate-500">{bytesLabel(a.size)}</span>
              <a href={href} download={a.name} aria-label={`Download ${a.name}`} className="text-xs font-medium text-compass-700 underline-offset-2 hover:underline">
                Download
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
