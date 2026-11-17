import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { setSetting } from "@/lib/db";
import { featureEnabled } from "@/lib/ee";
import { newScimToken, scimAdminStatus, storeScimToken } from "@/lib/scim";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { requestOrigin } from "@/lib/oauth";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// Admin controls for SCIM provisioning: status, enable/disable, and bearer
// token generation. The raw token is returned exactly once; only its SHA-256
// is stored. The one-click setup with Microsoft (1.20.27) is the enterprise
// overlay's (/api/ee/scim/setup/*); its outcome is part of the status here.

async function status(req: Request) {
  return scimAdminStatus(`${requestOrigin(req)}/api/scim/v2`);
}

export async function GET(req: Request) {
  const gate = await apiGuard("admin", "identity.scim_read");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await status(req));
}

export async function POST(req: Request) {
  const gate = await apiGuard("admin", "identity.scim_manage");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  if (!(await featureEnabled("scim"))) {
    return NextResponse.json(
      { error: "SCIM provisioning is not included in your license." },
      { status: 402 }
    );
  }

  const token = newScimToken();
  await storeScimToken(token);
  await audit({
    actor: actorFrom(user),
    action: "scim.token_generated",
    ip: ipFrom(req),
  });
  // The raw token appears in this response only — never stored, never again.
  return NextResponse.json({ token, ...(await status(req)) });
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin", "identity.scim_manage");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be true or false." }, { status: 400 });
  }
  await setSetting("scim_enabled", body.enabled ? "1" : "0");
  await audit({
    actor: actorFrom(user),
    action: body.enabled ? "scim.enabled" : "scim.disabled",
    ip: ipFrom(req),
  });
  return NextResponse.json(await status(req));
}
