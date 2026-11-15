"use client";

// 1.20.16: the "Draft from Claude" / "Changes from Claude" strip at the top of
// a settings editor (Categories, Automations, Recurring tickets), the same
// dashed box 1.20.14's Checklists editor draws (STYLEGUIDE §Helpdesk: drafts
// from Claude): Bot avatar, the title, "asked by {person} · {time} · not
// published", and one sentence on what stays as it is until it is published.

import { Bot } from "lucide-react";
import { RelativeTime } from "@/components/RelativeTime";

export function ClaudeDraftStrip({
  changes,
  askedBy,
  at,
  children,
  className = "",
  id,
}: {
  /** True: changes beside something live ("Changes from Claude"); false: a new draft ("Draft from Claude"). */
  changes: boolean;
  askedBy: string;
  at: string | null;
  /** The sentence (and anything else) under the title line. */
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  const title = changes ? "Changes from Claude" : "Draft from Claude";
  return (
    <section
      id={id}
      aria-label={title}
      data-testid="claude-draft-strip"
      className={`rounded-xl border-[1.5px] border-dashed border-compass-300 bg-compass-50 p-3 dark:border-compass-500/50 dark:bg-compass-500/10 ${className}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-900 text-slate-50" aria-hidden>
          <Bot className="h-4 w-4" />
        </span>
        <span className="text-sm font-semibold text-slate-900">{title}</span>
        <span className="text-xs text-slate-500">
          {askedBy ? `asked by ${askedBy} · ` : ""}
          {at && <RelativeTime value={at} />}
          {at ? " · " : ""}not published
        </span>
      </div>
      <div className="mt-1.5 text-sm text-slate-700 sm:pl-9">{children}</div>
    </section>
  );
}
