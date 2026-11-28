"use client";

// The AI allowance where people use AI (1.22.0, design D1 and D3): the
// shell resolves it once per page (lib/plan-usage aiPlanStatus) and the
// entry points read it here. Outside a CompassDocs Cloud workspace with a
// plan (or on an admin's own AI key) the value is null or says nothing,
// and nothing renders.
//
//   - Past this month's allowance, ONE quiet line for people who can open
//     Plan & usage (Decision 7): "Beyond this month's allowance: billed at
//     cost +30%." text-xs, no color, no chip, no dismiss: information.
//   - With the cap reached, everyone sees the pause (it names no amount);
//     admins also read where to raise it, everyone else "Ask an admin".
//     Said once wherever it shows: the line (Ask, the Write menu), or the
//     Claude panel's own paused state (AiPausedPanel, the header chip).

import { createContext, useContext } from "react";
import Link from "next/link";
import { CirclePause, Info } from "lucide-react";
import { chipClass } from "@/components/Chip";
import type { AiPlanStatus } from "@/lib/plan-usage";

const Ctx = createContext<AiPlanStatus | null>(null);

export function AiPlanProvider({ value, children }: { value: AiPlanStatus | null; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAiPlan(): AiPlanStatus | null {
  return useContext(Ctx);
}

/** Where to go, by audience: admins raise the limit, everyone else asks one. */
function WhoCanRaise({ admin }: { admin: boolean }) {
  return admin ? (
    <>
      Admins can raise the limit in{" "}
      <Link href="/admin/plan/ai#ai-spending" className="link">
        Plan & usage
      </Link>
      .
    </>
  ) : (
    <>Ask an admin if you need it sooner.</>
  );
}

/**
 * The plan's line beside an AI entry point: the pause (everyone) or the
 * beyond-the-allowance line (admins). `pausedUntil` says the pause even
 * when the page's status didn't know (the cap was reached since it loaded:
 * Ask's answer carries it).
 */
export function AiPlanLine({ className = "", pausedUntil }: { className?: string; pausedUntil?: string }) {
  const s = useAiPlan();
  const until = pausedUntil ?? s?.pausedUntil ?? null;
  const admin = !!s?.admin;
  if (until) {
    return (
      <p className={`flex items-start gap-1.5 text-xs text-slate-600 ${className}`} role="status" data-testid="ai-paused">
        <CirclePause className="mt-px h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
        <span>
          AI is paused until {until}: this workspace reached its monthly AI limit. <WhoCanRaise admin={admin} />
        </span>
      </p>
    );
  }
  if (s?.admin && s.beyond) {
    return (
      <p className={`flex items-start gap-1.5 text-xs text-slate-500 ${className}`} data-testid="ai-beyond">
        <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
        Beyond this month's allowance: billed at cost +30%.
      </p>
    );
  }
  return null;
}

/** Design D3: the Claude panel's header chip while AI is paused. */
export function AiPausedChip() {
  const s = useAiPlan();
  if (!s?.pausedUntil) return null;
  return (
    <span className={chipClass("neutral", "sm")} data-testid="ai-paused-chip">
      <CirclePause className="h-3 w-3" aria-hidden />
      Paused until {s.pausedUntil}
    </span>
  );
}

/**
 * Design D3: the Claude panel's body while AI is paused: centred, what
 * happened, that everything else works, when it starts again, and who can
 * raise the limit.
 */
export function AiPausedPanel({ place = "the desk" }: { place?: string }) {
  const s = useAiPlan();
  if (!s?.pausedUntil) return null;
  return (
    <div className="py-6 text-center" role="status" data-testid="ai-paused-panel">
      <span className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-slate-100 text-slate-500" aria-hidden>
        <CirclePause className="h-5 w-5" />
      </span>
      <p className="mt-3 font-semibold text-slate-800">AI is paused for the rest of {s.month}</p>
      <p className="mx-auto mt-1 max-w-xs text-sm text-slate-600">
        {s.workspace} reached its monthly AI limit. Everything else in {place} works as usual. It starts again on {s.restartsOn}.
      </p>
      <p className="mx-auto mt-3 max-w-xs text-sm text-slate-600">
        <WhoCanRaise admin={s.admin} />
      </p>
    </div>
  );
}

/** The pause sentence (design D3), for a tooltip or a reason beside a disabled control. */
export function aiPausedText(until: string, admin: boolean): string {
  return `AI is paused until ${until}: this workspace reached its monthly AI limit. ${admin ? "Admins can raise the limit in Plan & usage." : "Ask an admin if you need it sooner."}`;
}
