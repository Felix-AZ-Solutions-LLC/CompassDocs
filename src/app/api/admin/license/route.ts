import { NextResponse } from "next/server";
import { apiGuard, platformSettingRefusal } from "@/lib/api-auth";
import { licenseManagedByCloud } from "@/lib/cloud";
import { setSetting } from "@/lib/db";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { parseLicense } from "@/lib/license";
import { licenseView } from "@/lib/license-view";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("admin", "license.read");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await licenseView());
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin", "license.install");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // 1.21.0: the platform's license (cloud mode, COMPASSDOCS_LICENSE_KEY) is read-only here;
  // 1.21.3: so is one the console delivers (COMPASSDOCS_LICENSE_URL).
  if (licenseManagedByCloud()) return platformSettingRefusal("The license key");

  if (body?.clear === true) {
    await setSetting("license_key", "");
    await audit({ actor: actorFrom(gate), action: "license.removed", ip: ipFrom(req) });
    return NextResponse.json({ ok: true, state: await licenseView() });
  }

  const key = typeof body?.license_key === "string" ? body.license_key.trim() : "";
  if (key) {
    // Reject an invalid/tampered key up front rather than storing garbage.
    const { license, error } = parseLicense(key);
    if (error || !license) {
      return NextResponse.json({ error: error || "Invalid license." }, { status: 400 });
    }
    await setSetting("license_key", key);
    await audit({
      actor: actorFrom(gate),
      action: "license.set",
      targetLabel: license.customer,
      details: { plan: license.plan, expires: license.expires },
      ip: ipFrom(req),
    });
  }

  return NextResponse.json({ ok: true, state: await licenseView() });
}
