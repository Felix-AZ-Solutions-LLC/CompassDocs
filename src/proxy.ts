// Request proxy (Next.js 16's name for middleware). Three jobs:
//
// 1. Tell server components which page is being rendered, so a signed-out
//    visitor can be sent to /login with that page as `?next=` and come back
//    to it afterwards (lib/auth requireUser, lib/return-to). Server
//    components cannot see the request URL on their own, so this forwards it
//    as a request header. Pages only (and everything under /desk); one a
//    client sent itself is dropped on every path (1.20.35).
//
// 2. (1.20.11 security review) A picture, media, font, style sheet or script
//    that another site asks for, or that reached us through a redirect from
//    another site, is served as to a signed-out visitor: its Cookie header is
//    taken off before any route sees it. The browser says so itself:
//    Sec-Fetch-Dest names the kind of request and Sec-Fetch-Site is anything
//    but "same-origin" (a redirect through another site makes it
//    "cross-site"). The case it closes: an email shown in the desk (a
//    same-origin frame, lib/helpdesk/email-html originalInlineCsp) with
//    pictures shown, whose picture on another site redirects to a desk URL;
//    from a same-origin frame that request is same-site, so the browser
//    would send the SameSite=Lax session cookie along. The app's own pages
//    ask for these same-origin, so they are untouched; what other sites
//    legitimately embed (the logo and pictures in the app's emails, the
//    sign-in artwork, newsletter pictures, public help centre files,
//    diagrams) is public and served without a session anyway. Navigations,
//    frames, fetch() and API clients without these headers are untouched.
//
// 3. (1.20.37) A request Next's router makes as a prefetch carries
//    Next-Router-Prefetch, which a page's headers() no longer shows in Next
//    16; the proxy passes it on as x-compass-prefetch: 1, so the Help
//    Center's article page does not count a view nobody made
//    (lib/helpdesk/help-centre isPrefetch). One a client sent itself is
//    dropped on every path, like the page header.
//
// 4. (1.21.0) In JSON logging mode (cloud mode, or COMPASSDOCS_LOG_FORMAT=json;
//    lib/cloud jsonLogging) every request carries an x-request-id: the
//    platform's own when it sent a well-formed one, else a new UUID. Routes
//    and the log lines they write (lib/log request_id) see it, and the
//    response carries it back. Readable-log installs are untouched.
//
// 5. (1.21.4) A CompassDocs support session (lib/support; its cookie's token
//    says so by its prefix, lib/support-policy) is held to what it may do
//    before any route runs: a read-only one is refused every request that
//    changes something, both levels are refused their own access, copies of
//    the workspace, account security and the writes support never makes
//    (supportRefusal): an API answers 403 with a `code`, a page shows "Not
//    available in a support session" at the same address. Each page it
//    views and each change it asks for is tagged (SUPPORT_ACTIVITY_HEADER)
//    so lib/auth writes it to the audit log once. A tag a client sent is
//    dropped on every path.
//
// No authentication happens here — the session check stays in requireUser,
// where it can read the database.

import { NextResponse, type NextRequest } from "next/server";
import { jsonLogging } from "@/lib/cloud";
import { SESSION_COOKIE_NAME, SUPPORT_ACTIVITY_HEADER, SUPPORT_NOT_ALLOWED_PAGE, safeMethod, sessionControl, supportLevelOfToken, supportRefusal } from "@/lib/support-policy";

/** The request header that carries the page's path and query. */
export const RETURN_PATH_HEADER = "x-compass-path";

/** The request header that says the router asked for this page as a prefetch (lib/helpdesk/help-centre PREFETCH_HEADER). */
export const PREFETCH_HEADER = "x-compass-prefetch";

/** The request id header (1.21.0, lib/log). */
export const REQUEST_ID_HEADER = "x-request-id";

/** A request id worth keeping: the platform's, when it looks like one. */
export function requestIdFrom(headers: Headers): string {
  const given = headers.get(REQUEST_ID_HEADER)?.trim();
  return given && /^[A-Za-z0-9._:-]{8,128}$/.test(given) ? given : crypto.randomUUID();
}

/** Request kinds a page can make of another site without CORS (Sec-Fetch-Dest). */
const NO_CORS_SUBRESOURCES = new Set(["image", "audio", "video", "track", "font", "style", "script", "object", "embed"]);

/** A no-cors subresource asked for by another site (or by way of one): it is served without the visitor's cookies. */
export function crossSiteSubresource(headers: Headers): boolean {
  const dest = headers.get("sec-fetch-dest");
  const site = headers.get("sec-fetch-site");
  return !!dest && NO_CORS_SUBRESOURCES.has(dest.toLowerCase()) && !!site && site.toLowerCase() !== "same-origin";
}

/** The paths that get the page header: what the matcher held before 1.20.11 (pages, and everything under /desk). */
export function isPagePath(pathname: string): boolean {
  if (pathname === "/desk" || pathname.startsWith("/desk/")) return true;
  return !/^\/(?:_next\/|api\/)/.test(pathname) && !/\.[a-zA-Z0-9]+$/.test(pathname);
}

export function proxy(req: NextRequest) {
  // Next hands the proxy a normalised URL: the query is re-serialised
  // (a space becomes "+"), which keeps its meaning — the page reads the
  // same values back — but not its spelling.
  const { pathname, search } = req.nextUrl;
  const page = isPagePath(pathname);
  const anonymous = crossSiteSubresource(req.headers) && req.headers.has("cookie");
  // 1.20.35: a page header the client sent itself is never passed on, on any
  // path: the root layout reads it to decide the dark style (and the sign-in
  // return path before it), so only the proxy may write it.
  const forged = req.headers.has(RETURN_PATH_HEADER) || req.headers.has(PREFETCH_HEADER) || req.headers.has(SUPPORT_ACTIVITY_HEADER);
  const requestId = jsonLogging() ? requestIdFrom(req.headers) : null;
  // 1.21.4: a support session, by its cookie (none on a request whose cookies are taken off).
  const support = anonymous ? null : supportLevelOfToken(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!page && !anonymous && !forged && !requestId && !support) return NextResponse.next();
  const prefetch = req.headers.has("next-router-prefetch");
  if (support) {
    const refusal = supportRefusal(support, req.method, pathname);
    if (refusal) {
      if (page && safeMethod(req.method)) {
        const res = NextResponse.rewrite(new URL(SUPPORT_NOT_ALLOWED_PAGE, req.url));
        if (requestId) res.headers.set(REQUEST_ID_HEADER, requestId);
        return res;
      }
      return NextResponse.json(refusal, { status: 403, headers: requestId ? { [REQUEST_ID_HEADER]: requestId } : undefined });
    }
  }
  const headers = new Headers(req.headers);
  if (requestId) headers.set(REQUEST_ID_HEADER, requestId);
  headers.delete(RETURN_PATH_HEADER);
  headers.delete(PREFETCH_HEADER);
  headers.delete(SUPPORT_ACTIVITY_HEADER);
  if (page) headers.set(RETURN_PATH_HEADER, `${pathname}${search}`);
  if (page && prefetch) headers.set(PREFETCH_HEADER, "1");
  if (anonymous) headers.delete("cookie");
  // A page viewed (not a prefetch) or a change asked for, for the audit log.
  if (support && ((page && req.method === "GET" && !prefetch) || (!safeMethod(req.method) && !sessionControl(req.method, pathname)))) {
    headers.set(SUPPORT_ACTIVITY_HEADER, `${crypto.randomUUID()} ${req.method.toUpperCase()} ${pathname.slice(0, 1000)}`);
  }
  const res = NextResponse.next({ request: { headers } });
  if (requestId) res.headers.set(REQUEST_ID_HEADER, requestId);
  return res;
}

export const config = {
  matcher: [
    // Everything but Next's own paths (1.20.11: the API and static
    // files too, for the cookie rule; the page header still goes to pages
    // only, isPagePath). Under /desk, extension or not, is a page: the Duo
    // desk rule reads the header to know a page is a desk page (lib/auth
    // requireUser), so "/desk/tickets/42.0" must not arrive with a header
    // the client wrote itself (1.20.5).
    "/((?!_next/).*)",
    "/desk/:path*",
  ],
};
