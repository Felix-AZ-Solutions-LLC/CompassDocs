import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ipFrom } from "@/lib/audit";
import { SESSION_COOKIE, cookieOptions, currentSession, clearDarkStyleCookie } from "@/lib/auth";
import { crossOriginRejection } from "@/lib/api-auth";
import { supportAccessEnabled } from "@/lib/cloud";
import { endOwnSupportSession, startSupportSession } from "@/lib/support";
import { NO_STORE, supportErrorResponse, supportJson, supportRateLimit, tokenFromBody } from "@/lib/support-http";
import { logout } from "@/lib/auth";

export const dynamic = "force-dynamic";

// 1.21.4: a CompassDocs staff member signs in with a grant token
// (lib/support). The /support/sign-in page reads the token from its
// address's fragment (never sent to a server, never in a log) and posts it
// here, same-origin, as JSON. The token is used once; the session cookie is
// set for exactly as long as the access lasts. Any session already in this
// browser is signed out first, so a support session never stacks on a
// customer's.
export async function POST(req: Request) {
  if (!supportAccessEnabled()) return supportJson({ error: "Not found.", code: "not_found" }, 404);
  const cross = await crossOriginRejection();
  if (cross) return cross;
  if ((req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() !== "application/json") {
    return supportJson({ error: "Send the token as application/json.", code: "unsupported_media_type" }, 415);
  }
  const limited = supportRateLimit(req);
  if (limited) return limited;
  const token = await tokenFromBody(req);
  if (typeof token !== "string") return token;
  try {
    const previous = (await cookies()).get(SESSION_COOKIE)?.value;
    const s = await startSupportSession(token, { ip: ipFrom(req), userAgent: req.headers.get("user-agent") });
    if (previous) await logout(previous).catch(() => {});
    const res = NextResponse.json({ ok: true, level: s.level, expires_at: s.expiresAt.toISOString(), next: "/" }, { headers: NO_STORE });
    const maxAge = Math.max(60, Math.floor((s.expiresAt.getTime() - Date.now()) / 1000));
    // Always Secure in cloud mode (lib/auth secureCookie), so set here the same way.
    res.cookies.set(SESSION_COOKIE, s.token, cookieOptions(maxAge, true));
    return res;
  } catch (e) {
    return supportErrorResponse(e);
  }
}

// The staff member ends the session (the banner's End session).
export async function DELETE() {
  const cross = await crossOriginRejection();
  if (cross) return cross;
  const s = await currentSession();
  if (!s?.user.support) return supportJson({ error: "This is not a support session.", code: "not_support" }, 400);
  await endOwnSupportSession(s.user.support.session_id);
  await logout(s.token).catch(() => {});
  const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
  res.cookies.set(SESSION_COOKIE, "", cookieOptions(0, true));
  clearDarkStyleCookie(res, true);
  return res;
}
