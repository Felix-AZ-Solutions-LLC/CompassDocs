// OAuth 2.0 Dynamic Client Registration (RFC 7591) — lets Claude (or any MCP
// client) register itself before the authorize step. Public clients only:
// no secret is issued, PKCE is mandatory at the token endpoint.

import { countRecentOAuthClients, registerOAuthClient } from "@/lib/db";
import { corsJson, corsPreflight, redirectUriAllowed } from "@/lib/oauth";
import { ipFrom } from "@/lib/audit";
import { readTextCapped } from "@/lib/body-reader";
import { oauthRegisterRateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Registrations accepted from all addresses together in an hour (1.20.27). */
const REGISTRATIONS_PER_HOUR = 200;

export async function POST(req: Request) {
  // 1.20.27 (security review M1): registration is open by design (Claude
  // registers itself), so it is rate limited: 10 an hour per address and
  // REGISTRATIONS_PER_HOUR in all. A registration nobody uses within a day
  // is forgotten (db runDbMaintenance).
  if (oauthRegisterRateLimited(ipFrom(req) || "unknown") || (await countRecentOAuthClients()) >= REGISTRATIONS_PER_HOUR) {
    return corsJson({ error: "temporarily_unavailable", error_description: "Too many registrations. Try again later." }, 429);
  }
  let body: any;
  try {
    const text = await readTextCapped(req, 16 * 1024);
    if (text === null) return corsJson({ error: "invalid_client_metadata" }, 413);
    body = JSON.parse(text);
  } catch {
    return corsJson({ error: "invalid_client_metadata" }, 400);
  }

  const uris: string[] = Array.isArray(body?.redirect_uris)
    ? body.redirect_uris.map((u: unknown) => String(u)).filter(Boolean).slice(0, 10)
    : [];
  if (!uris.length || !uris.every((u) => u.length <= 2000 && redirectUriAllowed(u))) {
    return corsJson(
      {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be HTTPS (or localhost) URLs.",
      },
      400
    );
  }

  const client = await registerOAuthClient(String(body?.client_name ?? "MCP client"), uris);
  return corsJson(
    {
      client_id: client.client_id,
      client_name: client.name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201
  );
}

export const OPTIONS = async () => corsPreflight();
