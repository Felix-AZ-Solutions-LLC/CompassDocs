"use client";

// The AI allowance where people use AI (1.22.0, design D1 and D3): the
// shell resolves it once per page (lib/plan-usage aiPlanStatus) and the
// entry points read it here. Outside a CompassDocs Cloud workspace with a
// plan the value is null and nothing renders.
//
//   - Past this month's allowance, ONE quiet line for people who can open
//     Plan & usage (Decision 7): "Beyond this month's allowance: billed at
//     cost +30%." text-xs, no color, no chip, no dismiss: information.
//   - With the cap reached, everyone sees the pause (it names no amount);
//     admins also read where to raise it, everyone else "Ask an admin".

import { createContext, useContext } from "react";
import Link from "next/link";
import { CirclePause, Info } from "lucide-react";
import type { AiPlanStatus } from "@/lib/plan-usage";

const Ctx = createContext<AiPlanStatus | null>(null);

export function AiPlanProvider({ value, children }: { value: AiPlanStatus | null; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAiPlan(): AiPlanStatus | null {
  return useContext(Ctx);
}

/** The pause sentence (design D3). */
export function aiPausedText(until: string, admin: boolean): string {
  return `AI is paused until ${until}: this workspace reached its monthly AI limit. ${admin ? "Admins can raise the limit in Plan & usage." : "Ask an admin if you need it sooner."}`;
}

export function AiPlanLine({ className = "" }: { className?: string }) {
  const s = useAiPlan();
  if (!s) return null;
  if (s.pausedUntil) {
    return (
      <p className={`flex items-start gap-1.5 text-xs text-slate-600 ${className}`} role="status" data-testid="ai-paused">
        <CirclePause className="mt-px h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
        <span>
          AI is paused until {s.pausedUntil}: this workspace reached its monthly AI limit.{" "}
          {s.admin ? (
            <>
              Admins can raise the limit in{" "}
              <Link href="/admin/plan/ai#ai-spending" className="link">
                Plan & usage
              </Link>
              .
            </>
          ) : (
            "Ask an admin if you need it sooner."
          )}
        </span>
      </p>
    );
  }
  if (s.admin && s.beyond) {
    return (
      <p className={`flex items-start gap-1.5 text-xs text-slate-500 ${className}`} data-testid="ai-beyond">
        <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
        Beyond this month's allowance: billed at cost +30%.
      </p>
    );
  }
  return null;
}
