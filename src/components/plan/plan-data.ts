"use client";

// The Plan & usage page's data (1.22.0): one GET /api/admin/plan shared by
// the header's upgrade button and the tab on screen, read again after a
// change. A 404 is "no plan" (the page shows so; with a licence for another
// workspace and none kept, its mismatch), anything else an error. A change
// also refreshes the server-rendered shells (the AI pause, the Claude
// panel) and tells the plan banner (PLAN_CHANGED_EVENT) to read again.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AiSpending, LicenceMismatch, PlanOverview } from "@/lib/plan-shared";

export type PlanData = PlanOverview & { spending: { spending: AiSpending; capUsd: number | null } };

export type PlanLoad = { state: "loading" } | { state: "none"; mismatch: LicenceMismatch | null } | { state: "error"; message: string } | { state: "ready"; data: PlanData };

/** Fired on window after a Plan & usage change: the banner reads its notices again. */
export const PLAN_CHANGED_EVENT = "compass:plan-changed";

let cache: { at: number; p: Promise<PlanLoad> } | null = null;
const listeners = new Set<(l: PlanLoad) => void>();

async function load(): Promise<PlanLoad> {
  try {
    const res = await fetch("/api/admin/plan", { cache: "no-store" });
    if (res.status === 404) {
      const b = await res.json().catch(() => null);
      return { state: "none", mismatch: (b?.mismatch as LicenceMismatch | undefined) ?? null };
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) return { state: "error", message: body?.error || "Couldn't load Plan & usage." };
    return { state: "ready", data: body as PlanData };
  } catch {
    return { state: "error", message: "Couldn't load Plan & usage." };
  }
}

function fetchPlan(force = false): Promise<PlanLoad> {
  if (!force && cache && Date.now() - cache.at < 10_000) return cache.p;
  const p = load();
  cache = { at: Date.now(), p };
  void p.then((l) => listeners.forEach((f) => f(l)));
  return p;
}

/** The overview, and a reload after a change. */
export function usePlan(): { load: PlanLoad; reload: () => void } {
  const router = useRouter();
  const [state, setState] = useState<PlanLoad>({ state: "loading" });
  useEffect(() => {
    let live = true;
    const on = (l: PlanLoad) => live && setState(l);
    listeners.add(on);
    void fetchPlan().then(on);
    return () => {
      live = false;
      listeners.delete(on);
    };
  }, []);
  const reload = useCallback(() => {
    void fetchPlan(true);
    // The app and desk shells' AI status (the pause, the beyond line) is rendered on the server.
    router.refresh();
    window.dispatchEvent(new Event(PLAN_CHANGED_EVENT));
  }, [router]);
  return { load: state, reload };
}
