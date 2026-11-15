"use client";

// "Sam Lee is viewing" / "Sam Lee is replying •••" in the ticket's header
// (1.19.1 collision warnings, agent V4; STYLEGUIDE §Helpdesk: the desk,
// Presence). Up to three overlapping initials avatars with the emerald
// presence ring, the names ("Sam and 2 others") and the verb; typing dots
// while anyone is replying. Nothing renders while nobody else is here. A
// polite live region, so a screen reader hears someone arrive.
// 1.20.20: the reply lock's holder leads the line with their own avatar
// (ReplyLockAvatar: the pen badge and "Sam Lee · replying since 10:42") and
// counts as replying however long since their last keystroke.

import { presenceInitials, presenceNames, presenceVerb, type HdPresence } from "@/lib/helpdesk/presence-shared";
import type { HdReplyLock } from "@/lib/helpdesk/reply-lock-shared";
import { useTicketPresence } from "./presence";
import { useReplyLockState } from "../reply-lock/reply-lock";
import { ReplyLockAvatar } from "../reply-lock/ReplyLock";

export function TicketPresence({ number, className = "" }: { number: number; className?: string }) {
  const present = useTicketPresence(number);
  const s = useReplyLockState(number);
  const lock = s?.enabled && s.lock && !s.lock.mine ? s.lock : null;
  return <PresenceLine present={present} lock={lock} className={className} />;
}

/** The line itself (also used by the screenshots harness and tests). */
export function PresenceLine({ present: seen, lock = null, className = "" }: { present: HdPresence[]; lock?: HdReplyLock | null; className?: string }) {
  const present: HdPresence[] = lock
    ? [
        { user_id: lock.user_id, name: lock.name, initials: presenceInitials(lock.name), state: "replying", since: lock.since, seen_at: lock.seen_at },
        ...seen.filter((p) => p.user_id !== lock.user_id),
      ]
    : seen;
  const replying = present.some((p) => p.state === "replying");
  const detail = present.map((p) => `${p.name} ${p.state === "replying" ? "replying" : "viewing"}`).join(" · ");
  return (
    <div role="status" aria-live="polite" className={`min-w-0 ${className}`}>
      {present.length > 0 && (
        <span className="inline-flex max-w-full items-center gap-2 text-xs text-slate-600" data-testid="ticket-presence">
          {lock && <ReplyLockAvatar lock={lock} size="xs" className="ring-2 ring-emerald-500 ring-offset-2 ring-offset-surface" />}
          <span className={`flex shrink-0 -space-x-1.5 ${lock && present.length === 1 ? "hidden" : ""}`} data-tt={detail} aria-hidden>
            {present.filter((p) => p.user_id !== lock?.user_id).slice(0, lock ? 2 : 3).map((p) => (
              <span
                key={p.user_id}
                className="grid h-7 w-7 place-items-center rounded-full bg-compass-100 text-2xs font-bold text-compass-700 ring-2 ring-emerald-500 ring-offset-2 ring-offset-surface"
              >
                {p.initials}
              </span>
            ))}
          </span>
          <span className="min-w-0 truncate">
            <span className="font-semibold text-slate-800">{presenceNames(present)}</span> {presenceVerb(present)}
          </span>
          {replying && <TypingDots />}
        </span>
      )}
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" aria-hidden>
      {[0, 150, 300].map((d) => (
        <span key={d} className="h-1.5 w-1.5 rounded-full bg-compass-500 motion-safe:animate-bounce" style={{ animationDelay: `${d}ms` }} />
      ))}
    </span>
  );
}
