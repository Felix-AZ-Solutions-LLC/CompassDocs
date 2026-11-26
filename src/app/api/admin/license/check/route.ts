import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { licensePullConfig } from "@/lib/cloud";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { licenseView } from "@/lib/license-view";

export const dynamic = "force-dynamic";

// 1.21.3: Settings → License → Check now, in cloud mode with
// COMPASSDOCS_LICENSE_URL (lib/license-pull): ask the console for this
// workspace's license now. One request at a time per replica, and none
// within 30 s of the last (429, with Retry-After). The answer is the page's
// view, with the check's outcome in it; a newer license is installed only by
// the same checks as the schedule's.
export async function POST(req: Request) {
  const gate = await apiGuard("admin", "license.install");
  if (gate instanceof NextResponse) return gate;
  if (!licensePullConfig()) {
    return NextResponse.json({ error: "This workspace's license isn't fetched from CompassDocs Cloud, so there is nothing to check." }, { status: 404 });
  }
  const { checkLicenseNow } = await import("@/lib/license-pull");
  const out = await checkLicenseNow("manual");
  if (out.retryInMs !== undefined) {
    const secs = Math.max(1, Math.ceil(out.retryInMs / 1000));
    return NextResponse.json(
      { error: `The license was checked moments ago. Try again in ${secs} s.`, state: await licenseView() },
      { status: 429, headers: { "Retry-After": String(secs) } }
    );
  }
  await audit({
    actor: actorFrom(gate),
    action: "license.checked",
    details: { result: out.status.result },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, result: out.status.result, message: out.status.message, state: await licenseView() });
}
