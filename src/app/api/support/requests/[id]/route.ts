import { supportRequestStatus } from "@/lib/support";
import { bearer, supportErrorResponse, supportJson, supportRateLimit } from "@/lib/support-http";
import { supportAccessEnabled } from "@/lib/cloud";

export const dynamic = "force-dynamic";

// 1.21.4: where a support request stands, for the console (lib/support).
// Its credential is the request's own token: `Authorization: Bearer <token>`.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!supportAccessEnabled()) return supportJson({ error: "Not found.", code: "not_found" }, 404);
  const limited = supportRateLimit(req);
  if (limited) return limited;
  const token = bearer(req);
  if (!token) return supportJson({ error: "Send the request's token as Authorization: Bearer <token>.", code: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
  const { id } = await params;
  try {
    return supportJson({ request: await supportRequestStatus(id, token) });
  } catch (e) {
    return supportErrorResponse(e);
  }
}
