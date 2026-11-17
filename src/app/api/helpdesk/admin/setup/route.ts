// GET /api/helpdesk/admin/setup   the setup checklist's state:
//   { steps: [{ key, done, summary }], done, total, setup_complete }
// Helpdesk 1.19.0 (desk capability settings.manage).

import { NextResponse } from "next/server";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { setupChecklist } from "@/lib/helpdesk/seed";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  // 1.20.27 (security review app H1, M1): the address desk and portal mail
  // link to; null when none is configured (the checklist says what to do).
  const { workspaceOrigin } = await import("@/lib/workspace-origin");
  return NextResponse.json({ ...(await setupChecklist()), workspace_address: await workspaceOrigin() });
}
