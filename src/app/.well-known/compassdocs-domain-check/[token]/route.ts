import { checkProof, checkTokenValid, normalHost, UNKNOWN_TOKEN_HEADER } from "@/lib/domain-check";
import { cloudRefusal } from "@/lib/api-auth";

// The custom-domain check's answer (1.20.29, lib/domain-check). Before a
// domain is handed to the proxy, the app asks
// http://<domain>/.well-known/compassdocs-domain-check/<token> and expects
// this proof back, which only a process holding this workspace's master key
// can compute, for the name it was asked on (the Host header). Public on
// purpose: it reveals nothing (a token it did not issue, or one past its two
// minutes, is a 404 with a marker header only this route sends) and it is
// reached over plain HTTP on any host, through the proxy's catch-all route.

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  // 1.21.0: CompassDocs Cloud manages this (lib/cloud); 403 in cloud mode.
  const cloud = cloudRefusal("domain");
  if (cloud) return cloud;
  const { token } = await ctx.params;
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
  if (!checkTokenValid(token)) {
    return new Response("compassdocs-domain-check: unknown or expired token\n", {
      status: 404,
      headers: { ...headers, [UNKNOWN_TOKEN_HEADER]: "unknown-token" },
    });
  }
  let host = req.headers.get("host") || "";
  if (!host) {
    try {
      host = new URL(req.url).host;
    } catch {
      host = "";
    }
  }
  return new Response(checkProof(token, normalHost(host)), { status: 200, headers });
}
