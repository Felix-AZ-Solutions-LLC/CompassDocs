import { checkProof, checkTokenValid } from "@/lib/domain-check";

// The custom-domain check's answer (1.20.29, lib/domain-check). Before a
// domain is handed to the proxy, the app asks
// http://<domain>/.well-known/compassdocs-domain-check/<token> and expects
// this proof back, which only a process holding this workspace's master key
// can compute. Public on purpose: it reveals nothing (a token it did not
// issue, or one past its two minutes, is a plain 404) and it is reached
// over plain HTTP on any host, through the proxy's catch-all route.

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
  if (!checkTokenValid(token)) return new Response("Not found\n", { status: 404, headers });
  return new Response(checkProof(token), { status: 200, headers });
}
