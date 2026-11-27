import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { actorFrom, ipFrom } from "@/lib/audit";
import { supportAccessEnabled } from "@/lib/cloud";
import { saveSupportSettings, supportAccessOverview, type EmergencyAccess } from "@/lib/support";
import { requireJson, supportErrorResponse, supportJson } from "@/lib/support-http";

export const dynamic = "force-dynamic";

// 1.21.4: Settings → Support access (lib/support). Who may administer users
// (user.update_role, the workspace's recovery permission) decides who
// CompassDocs support may be. A support session never reaches this route
// (lib/support-policy).

export async function GET() {
  if (!supportAccessEnabled()) return supportJson({ error: "Not found.", code: "not_found" }, 404);
  const gate = await apiGuard("admin", "user.update_role");
  if (gate instanceof NextResponse) return gate;
  if (gate.support) return supportJson({ error: "Not available in a support session.", code: "support_not_allowed" }, 403);
  try {
    return supportJson(await supportAccessOverview());
  } catch (e) {
    return supportErrorResponse(e);
  }
}

export async function PATCH(req: Request) {
  if (!supportAccessEnabled()) return supportJson({ error: "Not found.", code: "not_found" }, 404);
  const gate = await apiGuard("admin", "user.update_role");
  if (gate instanceof NextResponse) return gate;
  if (gate.support) return supportJson({ error: "Not available in a support session.", code: "support_not_allowed" }, 403);
  const body = await requireJson(req);
  if (body instanceof NextResponse) return body;
  const { requests, emergency } = body as { requests?: unknown; emergency?: unknown };
  if (typeof requests !== "boolean" || !["off", "read_only", "admin"].includes(String(emergency))) {
    return supportJson({ error: 'Send {"requests": true|false, "emergency": "off"|"read_only"|"admin"}.', code: "invalid" }, 400);
  }
  try {
    const settings = await saveSupportSettings({ requests, emergency: emergency as EmergencyAccess }, actorFrom(gate), ipFrom(req));
    return supportJson({ settings });
  } catch (e) {
    return supportErrorResponse(e);
  }
}
