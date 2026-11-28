// The Plan & usage APIs' one gate (1.22.0): 404 outside cloud mode and
// without a plan in the licence (design E1: "its API answers 404"), and
// only for whoever can open Plan & usage (workspace.settings_manage: "an
// admin" here, design B2). Server-only.

import "server-only";
import { NextResponse } from "next/server";
import { apiGuard } from "./api-auth";
import { isCloud } from "./cloud";
import { planResolution, type PlanState } from "./plan";
import type { SessionUser } from "./types";

export const NO_PLAN = { error: "This workspace has no CompassDocs Cloud plan.", code: "no_plan" } as const;

export async function planApiGate(): Promise<{ user: SessionUser; state: PlanState } | NextResponse> {
  if (!isCloud()) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const user = await apiGuard("admin", "workspace.settings_manage");
  if (user instanceof NextResponse) return user;
  const resolution = await planResolution();
  const state = resolution.state;
  // Design F with no earlier matching licence: no plan, and the page says why (its mismatch empty state).
  if (!state) return NextResponse.json({ ...NO_PLAN, mismatch: resolution.mismatch }, { status: 404 });
  return { user, state };
}
