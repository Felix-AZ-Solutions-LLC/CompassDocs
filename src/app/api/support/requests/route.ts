import { ipFrom } from "@/lib/audit";
import { createSupportRequest } from "@/lib/support";
import { supportErrorResponse, supportJson, supportRateLimit, tokenFromBody } from "@/lib/support-http";
import { supportAccessEnabled } from "@/lib/cloud";

export const dynamic = "force-dynamic";

// 1.21.4: the CompassDocs console asks for support access (lib/support).
// The body is a signed request token (lib/support-token); the contract is in
// README "Support access". Answers 404 unless this is a cloud workspace with
// support access configured, exactly like a route that does not exist.
export async function POST(req: Request) {
  if (!supportAccessEnabled()) return supportJson({ error: "Not found.", code: "not_found" }, 404);
  const limited = supportRateLimit(req);
  if (limited) return limited;
  const token = await tokenFromBody(req);
  if (typeof token !== "string") return token;
  try {
    const { created, request } = await createSupportRequest(token, { ip: ipFrom(req) });
    return supportJson({ request }, created ? 201 : 200);
  } catch (e) {
    return supportErrorResponse(e);
  }
}
