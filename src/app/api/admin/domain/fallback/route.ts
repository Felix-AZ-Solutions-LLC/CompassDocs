import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { applyProxyConfig, proxyManaged } from "@/lib/caddy";
import { domainState } from "@/lib/domain-flow";
import { forgetFallbackHost, validFallbackHost } from "@/lib/fallback-hosts";

export const dynamic = "force-dynamic";

// Remove a remembered fallback address (1.20.29, lib/fallback-hosts): the
// proxy stops serving it. Addresses from COMPASSDOCS_FALLBACK_HOSTS are the
// server's and change only there.
export async function DELETE(req: Request) {
  const gate = await apiGuard("admin", "workspace.domain_manage");
  if (gate instanceof NextResponse) return gate;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const host = validFallbackHost(body?.host);
  if (!host || !(await forgetFallbackHost(host))) {
    return NextResponse.json({ error: "That address isn't a remembered fallback." }, { status: 404 });
  }
  const applied = proxyManaged() ? await applyProxyConfig() : { ok: false as const, error: undefined };
  await audit({
    actor: actorFrom(gate),
    action: "domain.fallback_removed",
    targetType: "domain",
    targetLabel: host,
    details: { host, applied: applied.ok },
    ip: ipFrom(req),
  });
  return NextResponse.json({
    ok: true,
    applied: applied.ok,
    proxyError: proxyManaged() && !applied.ok ? applied.error : undefined,
    state: await domainState(),
  });
}
