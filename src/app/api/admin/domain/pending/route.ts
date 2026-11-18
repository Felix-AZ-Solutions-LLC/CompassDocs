import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { actorFrom, ipFrom } from "@/lib/audit";
import { discardPendingDomain, domainState, recheckPendingDomain } from "@/lib/domain-flow";

export const dynamic = "force-dynamic";

// The custom domain waiting for its check (1.20.29, lib/domain-flow).
//   POST:   "Check again" now; applies it when it passes.
//   DELETE: "Keep the current address": forget it.
// "Use it anyway" is PATCH /api/admin/domain with `force: true`.

export async function POST(req: Request) {
  const gate = await apiGuard("admin", "workspace.domain_manage");
  if (gate instanceof NextResponse) return gate;
  const r = await recheckPendingDomain({ manual: true, actor: actorFrom(gate), ip: ipFrom(req) });
  if (r.status === "none") {
    return NextResponse.json({ error: "No domain is waiting for its check." }, { status: 404 });
  }
  if (r.status === "busy") {
    return NextResponse.json({ error: "A check of this domain is already running. Try again in a moment." }, { status: 409 });
  }
  return NextResponse.json({
    ok: true,
    status: r.status,
    applied: r.applied ?? false,
    check: r.check,
    proxyError: r.status === "applied" && !r.applied ? r.proxyError : undefined,
    state: await domainState(),
  });
}

export async function DELETE(req: Request) {
  const gate = await apiGuard("admin", "workspace.domain_manage");
  if (gate instanceof NextResponse) return gate;
  await discardPendingDomain(actorFrom(gate), ipFrom(req));
  return NextResponse.json({ ok: true, state: await domainState() });
}
