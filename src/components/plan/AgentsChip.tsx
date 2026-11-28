// The agents meter's state chip (1.22.0, STYLEGUIDE §Plan meter): one
// wording for Plan & usage's Agents card and the desk's Agents page, so the
// state is always said in words beside the bar (never color alone),
// the hold included ("At 12 · Starter's limit"). Prices only for whoever
// can open Plan & usage (`extraUsd` null: the count without the price).
// Server-safe.

import { TriangleAlert } from "lucide-react";
import { Chip, type ChipTone } from "@/components/Chip";
import { usd, type MeterState } from "@/lib/plan-shared";

export interface AgentsChipInput {
  used: number;
  included: number;
  /** The plan's maximum; null: agents by contract (no maximum, no hold). */
  max: number | null;
  holdAt: number | null;
  state: MeterState;
  /** The plan's name ("Starter"). */
  label: string;
  /** One extra agent's monthly price, or null to say no price. */
  extraUsd: number | null;
}

export function agentsChipView(a: AgentsChipInput): { tone: ChipTone; text: string; warn: boolean } {
  // No maximum: agents are by contract (Dedicated): no extra price, no buffer, no hold.
  if (a.max === null) return { tone: "neutral", text: `${a.used} ${a.used === 1 ? "agent" : "agents"} · by contract`, warn: false };
  const extra = Math.max(0, a.used - a.included);
  if (a.state === "past") return { tone: "error", text: `At ${a.holdAt ?? a.used} · ${a.label}'s limit, new agents held`, warn: true };
  if (a.state === "over") return { tone: "warn", text: `${a.used} of ${a.max} · in buffer`, warn: true };
  if (a.state === "warn") return { tone: "warn", text: `${a.used} of ${a.max} max`, warn: true };
  if (extra > 0) return { tone: "accent", text: a.extraUsd !== null ? `${extra} extra · ${usd(extra * a.extraUsd)}/mo` : `${extra} extra`, warn: false };
  return { tone: "neutral", text: a.used >= a.included ? `All ${a.included} included in use` : `${a.used} of ${a.included} included`, warn: false };
}

export function AgentsChip({ testid = "agents-chip", ...a }: AgentsChipInput & { testid?: string }) {
  const v = agentsChipView(a);
  return (
    <Chip tone={v.tone} data-testid={testid}>
      {v.warn && <TriangleAlert className="h-3 w-3" aria-hidden />}
      {v.text}
    </Chip>
  );
}
