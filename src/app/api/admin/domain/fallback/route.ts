import { NextResponse } from "next/server";
import { apiGuard, cloudRefusal } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { applyProxyConfig, proxyManaged } from "@/lib/caddy";
import { domainState } from "@/lib/domain-flow";
import { fallbackHostFromHostHeader, forgetFallbackHost, validFallbackHost } from "@/lib/fallback-hosts";

export const dynamic = "force-dynamic";

// Remove a remembered fallback address (1.20.29, lib/fallback-hosts): the
// proxy stops serving it. Addresses from COMPASSDOCS_FALLBACK_HOSTS are the
// server's and change only there.
export async function DELETE(req: Request) {
  // 1.21.0: CompassDocs Cloud manages this (lib/cloud); 403 in cloud mode.
  const cloud = cloudRefusal("domain");
  if (cloud) return cloud;
  const gate = await apiGuard("admin", "workspace.domain_manage");
  if (gate instanceof NextResponse) return gate;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const host = validFallbackHost(body?.host);
  // 1.20.29 (review M5): never the address this very request came in on.
  if (host && fallbackHostFromHostHeader(req.headers.get("host")) === host) {
    return NextResponse.json(
      { error: `You're using ${host} right now, so it can't be removed from here. Open CompassDocs at another address to remove it.` },
      { status: 409 }
    );
  }
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
