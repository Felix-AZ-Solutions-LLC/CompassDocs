// 1.20.11 security review: the request proxy (src/proxy.ts) serves a no-cors
// subresource (picture, media, font, style, script, object, embed) that
// another site asked for, or that came by way of a redirect from one, as to a
// signed-out visitor: its Cookie header is gone before any route sees it.
// Same-origin requests, navigations, frames and fetch() keep their cookies,
// and the page header (x-compass-path) still goes to exactly the paths it
// went to before.
//
// The browser end (a picture in an email shown in the desk, redirected by
// another site to a desk URL) is checked in Chrome by
// e2e/helpdesk-email-inline.spec.ts; here, what the proxy hands Next.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/proxy-subresource-cookies.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { config, crossSiteSubresource, isPagePath, proxy, RETURN_PATH_HEADER } from "../src/proxy";

const ORIGIN = "https://desk.example";

/** What a route behind the proxy would see: the request headers after Next applies the proxy's overrides. */
function forwarded(path: string, headers: Record<string, string>): Headers {
  const req = new NextRequest(`${ORIGIN}${path}`, { headers });
  const res = proxy(req);
  assert.equal(res.headers.get("x-middleware-next"), "1", "never answers itself");
  const override = res.headers.get("x-middleware-override-headers");
  if (override === null) return new Headers(req.headers);
  const out = new Headers();
  for (const name of override.split(",").filter(Boolean)) {
    const v = res.headers.get(`x-middleware-request-${name}`);
    if (v !== null) out.set(name, v);
  }
  return out;
}

const COOKIE = "compass_session=s3cret; theme=dark";

describe("cookies on subresources", () => {
  test("a picture another site asks for, or a redirect through one: the cookie is gone, the rest kept", () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      const h = forwarded("/api/helpdesk/tickets", { cookie: COOKIE, "sec-fetch-dest": "image", "sec-fetch-site": site, "sec-fetch-mode": "no-cors", accept: "image/avif,image/*" });
      assert.equal(h.get("cookie"), null, site);
      assert.equal(h.get("accept"), "image/avif,image/*");
      assert.equal(h.get("sec-fetch-site"), site);
    }
  });

  test("every no-cors kind: image, audio, video, track, font, style, script, object, embed", () => {
    for (const dest of ["image", "audio", "video", "track", "font", "style", "script", "object", "embed", "IMAGE"]) {
      assert.equal(forwarded("/api/attachments/1", { cookie: COOKIE, "sec-fetch-dest": dest, "sec-fetch-site": "cross-site" }).get("cookie"), null, dest);
      assert.equal(crossSiteSubresource(new Headers({ "sec-fetch-dest": dest, "sec-fetch-site": "cross-site" })), true, dest);
    }
  });

  test("the app's own pictures and assets (same-origin) keep the cookie", () => {
    for (const dest of ["image", "script", "style", "font", "video"]) {
      for (const path of ["/api/helpdesk/attachments/7", "/api/directory/3/photo", "/api/attachments/9", "/icon.png"]) {
        assert.equal(forwarded(path, { cookie: COOKIE, "sec-fetch-dest": dest, "sec-fetch-site": "same-origin" }).get("cookie"), COOKIE, `${dest} ${path}`);
      }
    }
  });

  test("navigations, frames, fetch() and clients that send no Sec-Fetch headers keep the cookie", () => {
    const cases: Record<string, string>[] = [
      { "sec-fetch-dest": "document", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
      { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" },
      { "sec-fetch-dest": "empty", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
      { "sec-fetch-dest": "empty", "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" },
      { "sec-fetch-dest": "image" }, // no site: not a browser's say-so
      {},
    ];
    for (const h of cases) {
      assert.equal(forwarded("/api/helpdesk/me/notification-prefs", { cookie: COOKIE, ...h }).get("cookie"), COOKIE, JSON.stringify(h));
      assert.equal(forwarded("/desk/tickets/5", { cookie: COOKIE, ...h }).get("cookie"), COOKIE, JSON.stringify(h));
    }
  });

  test("a page asked for as a picture from another site gets its page header and no cookie", () => {
    const h = forwarded("/desk/tickets/5?x=1", { cookie: COOKIE, "sec-fetch-dest": "image", "sec-fetch-site": "cross-site", [RETURN_PATH_HEADER]: "/forged" });
    assert.equal(h.get("cookie"), null);
    assert.equal(h.get(RETURN_PATH_HEADER), "/desk/tickets/5?x=1");
  });

  test("the public pictures other sites embed (emails' logo, sign-in artwork, newsletter pictures, help centre files) are served anonymously: they need no session", () => {
    for (const path of ["/api/brand/logo", "/api/brand/artwork", "/api/newsletter/assets/abc.png", "/support/api/help/files/3", "/api/plantuml?src=x"]) {
      const h = forwarded(path, { cookie: COOKIE, "sec-fetch-dest": "image", "sec-fetch-site": "cross-site" });
      assert.equal(h.get("cookie"), null, path);
    }
  });
});

describe("the page header goes where it went before", () => {
  // The 1.20.5 matcher, as Next compiled it: pages (no _next/, no api/, no file extension) and everything under /desk.
  const before = (p: string) => /^\/(?!_next\/|api\/|.*\.[a-zA-Z0-9]+$).*$/.test(p) || p === "/desk" || p.startsWith("/desk/");
  const paths = ["/", "/doc/3", "/login", "/help/requests/9", "/desk", "/desk/tickets/42", "/desk/tickets/42.0", "/api/helpdesk/x", "/api", "/icon.png", "/favicon.ico", "/robots.txt", "/support", "/support/api/files/1", "/addin/taskpane"];
  for (const p of paths) {
    test(p, () => {
      assert.equal(isPagePath(p), before(p));
      const h = forwarded(p, { [RETURN_PATH_HEADER]: "/client-wrote-this" });
      if (before(p)) assert.equal(h.get(RETURN_PATH_HEADER), p);
      else assert.equal(h.get(RETURN_PATH_HEADER), "/client-wrote-this", "untouched, as before");
    });
  }

  test("the matcher covers the API and static files now, but not Next's own paths; /desk stays listed", () => {
    assert.ok(config.matcher.includes("/desk/:path*"));
    const all = new RegExp(`^${config.matcher[0].replace("/((?!", "/(?!").replace(").*)", ").*")}$`);
    for (const p of ["/api/helpdesk/attachments/1", "/icon.png", "/desk/x", "/"]) assert.ok(all.test(p), p);
    for (const p of ["/_next/static/chunks/a.js", "/_next/image", "/_next/data/x.json"]) assert.ok(!all.test(p), p);
  });
});
