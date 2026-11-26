import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { actorFrom, ipFrom } from "@/lib/audit";
import { supportAccessEnabled } from "@/lib/cloud";
import { decideSupportRequest, type Decision } from "@/lib/support";
import { requireJson, supportErrorResponse, supportJson } from "@/lib/support-http";

export const dynamic = "force-dynamic";

const DECISIONS: readonly Decision[] = ["approve", "deny", "revoke", "review"];

// 1.21.4: approve or deny a support request, revoke access (ending its
// sessions at once), or mark emergency access reviewed (lib/support).
// apiGuard checks the Origin; the body must be application/json, which a
// form on another site can't send without the browser asking first.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!supportAccessEnabled()) return supportJson({ error: "Not found.", code: "not_found" }, 404);
  const gate = await apiGuard("admin", "user.update_role");
  if (gate instanceof NextResponse) return gate;
  if (gate.support) return supportJson({ error: "Not available in a support session.", code: "support_not_allowed" }, 403);
  const body = await requireJson(req);
  if (body instanceof NextResponse) return body;
  const action = (body as { action?: unknown }).action;
  if (!DECISIONS.includes(action as Decision)) return supportJson({ error: 'Send {"action": "approve"|"deny"|"revoke"|"review"}.', code: "invalid" }, 400);
  const { id } = await params;
  try {
    const request = await decideSupportRequest(id, action as Decision, { ...actorFrom(gate), id: gate.id }, ipFrom(req));
    return supportJson({ request });
  } catch (e) {
    return supportErrorResponse(e);
  }
}
