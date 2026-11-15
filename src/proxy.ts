// Request proxy (Next.js 16's name for middleware). Two jobs:
//
// 1. Tell server components which page is being rendered, so a signed-out
//    visitor can be sent to /login with that page as `?next=` and come back
//    to it afterwards (lib/auth requireUser, lib/return-to). Server
//    components cannot see the request URL on their own, so this forwards it
//    as a request header. Pages only (and everything under /desk).
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
// No authentication happens here — the session check stays in requireUser,
// where it can read the database.

import { NextResponse, type NextRequest } from "next/server";

/** The request header that carries the page's path and query. */
export const RETURN_PATH_HEADER = "x-compass-path";

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
  if (!page && !anonymous) return NextResponse.next();
  const headers = new Headers(req.headers);
  if (page) headers.set(RETURN_PATH_HEADER, `${pathname}${search}`);
  if (anonymous) headers.delete("cookie");
  return NextResponse.next({ request: { headers } });
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
