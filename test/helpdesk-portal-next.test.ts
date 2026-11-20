// Where a customer portal sign-in lands (lib/helpdesk/portal-shared,
// cleanNextPath). The value rides in the URL and the sign-in request, so it
// is attacker-controlled: it must only ever be a portal path. 1.20.34 lets
// one query through, "New request" with its preselected type
// (/support/new?type=<digits>), so a deep link from outside keeps its type
// through sign-in; nothing else gains a query.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-portal-next.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanNextPath, newRequestPath, portalSignInHref } from "../src/lib/helpdesk/portal-shared";

test("portal paths pass through as before", () => {
  for (const p of ["/support", "/support/new", "/support/requests", "/support/requests/42", "/support/requests/42/rate/good/abc-DEF"]) {
    assert.equal(cleanNextPath(p), p);
  }
  assert.equal(cleanNextPath("  /support/new  "), "/support/new");
});

test("New request keeps its type", () => {
  assert.equal(cleanNextPath("/support/new?type=3"), "/support/new?type=3");
  assert.equal(cleanNextPath("/support/new?type=1234567890"), "/support/new?type=1234567890");
  assert.equal(cleanNextPath(" /support/new?type=7 "), "/support/new?type=7");
});

test("no other query gets through, and nothing else rides along with type", () => {
  for (const bad of [
    "/support/new?type=",
    "/support/new?type=abc",
    "/support/new?type=-1",
    "/support/new?type=3.5",
    "/support/new?type=12345678901", // more than 10 digits
    "/support/new?type=3&x=1",
    "/support/new?type=3#frag",
    "/support/new?type=3?type=4",
    "/support/new?x=1&type=3",
    "/support/new?TYPE=3",
    "/support/new?type=%33",
    "/support/new?type=3%0d%0aSet-Cookie:x",
    "/support/new/?type=3",
    "/support/requests?type=3",
    "/support?type=3",
    "/support/api/new?type=3",
    "/support/new?next=//evil.example",
    "/support?next=/support/new",
  ]) {
    assert.equal(cleanNextPath(bad), "", `refused: ${JSON.stringify(bad)}`);
  }
});

test("open-redirect protections still hold", () => {
  for (const bad of [
    "//evil.example",
    "//evil.example/support/new?type=3",
    "https://evil.example/support/new?type=3",
    "http://evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/support//evil.example",
    "/support/../../evil",
    "/support/%2e%2e/admin",
    "/supportx",
    "/support.evil.example",
    "/admin",
    "/",
    "javascript:alert(1)",
    "/support/api/session",
    "/support/api",
    "",
  ]) {
    assert.equal(cleanNextPath(bad), "", `refused: ${JSON.stringify(bad)}`);
  }
  for (const v of [null, undefined, 3, {}, ["/support/new"]]) assert.equal(cleanNextPath(v), "");
});

test("newRequestPath and portalSignInHref build what cleanNextPath accepts", () => {
  assert.equal(newRequestPath(3), "/support/new?type=3");
  assert.equal(newRequestPath("12"), "/support/new?type=12");
  for (const none of [null, undefined, "", "x", "3&a=b", -1, 1.5, "12345678901"]) assert.equal(newRequestPath(none), "/support/new");

  const href = portalSignInHref(newRequestPath(3));
  assert.equal(href, "/support?next=%2Fsupport%2Fnew%3Ftype%3D3");
  // What the sign-in page reads back out of it is the path, intact.
  const next = new URL(href, "https://docs.example").searchParams.get("next");
  assert.equal(next, "/support/new?type=3");
  assert.equal(cleanNextPath(next), "/support/new?type=3");

  assert.equal(portalSignInHref("/support/requests"), "/support?next=%2Fsupport%2Frequests");
  assert.equal(portalSignInHref("https://evil.example"), "/support?signin=1", "never an outside next");
});
