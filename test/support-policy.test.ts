// What a CompassDocs support session may do (1.21.4, lib/support-policy) and
// the request proxy that enforces it before any route runs (src/proxy.ts).
//
// Covered: a session token's level by its prefix (and that an ordinary
// token never has one); read-only refused every change on every path (a
// page's server action included), but signing out; both levels refused
// their own access, exports, backups, account security and OAuth consent,
// whatever the method; administrator-level refused the writes support
// never makes; paths spelled to slip past (a trailing slash, doubled
// slashes, encoded letters); the permissions each level keeps; and the
// proxy: a 403 with a code for an API, the "not available" page at the
// same address for a page, the activity tag on page views and changes (not
// on prefetches or reads), a tag a client sent always dropped, and an
// ordinary session untouched.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/support-policy.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import {
  readPermission,
  REFUSED_ALWAYS,
  SESSION_COOKIE_NAME,
  SUPPORT_ACTIVITY_HEADER,
  SUPPORT_DENIED_PERMISSIONS,
  SUPPORT_NOT_ALLOWED_PAGE,
  SUPPORT_TOKEN_PREFIX,
  supportLevelOfToken,
  supportPermissionAllowed,
  supportRefusal,
} from "../src/lib/support-policy";
import { PERMISSIONS, PRESET_ROLES } from "../src/lib/permissions";
import { proxy } from "../src/proxy";
import { newToken } from "../src/lib/password";

const RO = `${SUPPORT_TOKEN_PREFIX.read_only}${"a".repeat(64)}`;
const RW = `${SUPPORT_TOKEN_PREFIX.admin}${"b".repeat(64)}`;

describe("the session's level, by its token", () => {
  test("support prefixes; an ordinary session's token never has one", () => {
    assert.equal(supportLevelOfToken(RO), "read_only");
    assert.equal(supportLevelOfToken(RW), "admin");
    assert.equal(supportLevelOfToken(undefined), null);
    assert.equal(supportLevelOfToken(""), null);
    for (let i = 0; i < 200; i++) assert.equal(supportLevelOfToken(newToken()), null);
  });

  test("the cookie name is lib/auth's", () => {
    const auth = readFileSync(new URL("../src/lib/auth.ts", import.meta.url), "utf8");
    assert.match(auth, new RegExp(`export const SESSION_COOKIE = "${SESSION_COOKIE_NAME}"`));
  });
});

describe("supportRefusal", () => {
  const writes = ["POST", "PUT", "PATCH", "DELETE"];

  test("read-only: every change refused, on every path, pages included", () => {
    for (const m of writes) {
      for (const p of ["/api/documents/1", "/api/admin/settings", "/api/helpdesk/tickets/3", "/doc/12", "/", "/api/v1/documents", "/api/comments"]) {
        assert.equal(supportRefusal("read_only", m, p)?.code, "support_read_only", `${m} ${p}`);
      }
    }
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) assert.equal(supportRefusal("read_only", m, "/api/documents/1"), null, m);
  });

  test("signing out and signing in again are always allowed", () => {
    for (const level of ["read_only", "admin"] as const) {
      assert.equal(supportRefusal(level, "POST", "/api/auth/logout"), null);
      assert.equal(supportRefusal(level, "DELETE", "/api/support/session"), null);
      assert.equal(supportRefusal(level, "POST", "/api/support/session"), null);
    }
    assert.equal(supportRefusal("read_only", "POST", "/api/auth/login")?.code, "support_read_only");
  });

  test("both levels: their own access, copies of the workspace, account security, OAuth consent; whatever the method", () => {
    const paths = [
      "/admin/support-access",
      "/api/admin/support",
      "/api/admin/support/requests/abc",
      "/api/admin/workspace-export",
      "/api/admin/workspace-export/0123/download",
      "/api/export",
      "/api/backups",
      "/api/backups/compassdocs-20260101-000000.dump.enc",
      "/account",
      "/account/password",
      "/account/two-step",
      "/api/account/tokens",
      "/api/account/2fa",
      "/oauth/authorize",
      "/api/oauth/approve",
      "/api/helpdesk/admin/api/tokens",
    ];
    for (const level of ["read_only", "admin"] as const) {
      for (const m of ["GET", "POST", "DELETE"]) {
        for (const p of paths) assert.equal(supportRefusal(level, m, p)?.code, "support_not_allowed", `${level} ${m} ${p}`);
      }
    }
  });

  test("paths spelled to slip past are caught", () => {
    for (const p of ["/api/admin/support/", "//api//admin/support", "/api/admin/%73upport", "/admin/support-access/", "/api/export/"]) {
      assert.equal(supportRefusal("admin", "GET", p)?.code, "support_not_allowed", p);
    }
    assert.equal(supportRefusal("admin", "GET", "/accounts-overview"), null, "a prefix of a word is not the path");
  });

  test("administrator: sign-in, people, roles and the license are read-only; other changes go through", () => {
    for (const p of ["/api/auth/change-password", "/api/admin/users", "/api/admin/users/4", "/api/admin/groups/2", "/api/admin/rbac/roles", "/api/admin/sso", "/api/admin/saml", "/api/admin/scim", "/api/admin/duo", "/api/admin/sign-in-security", "/api/admin/license", "/api/admin/section-access", "/api/scim/v2/Users"]) {
      assert.equal(supportRefusal("admin", "POST", p)?.code, "support_not_allowed", p);
      assert.equal(supportRefusal("admin", "GET", p), null, `reading ${p}`);
    }
    for (const p of ["/api/documents/1", "/api/admin/settings", "/api/helpdesk/tickets/3", "/doc/12"]) assert.equal(supportRefusal("admin", "PATCH", p), null, p);
  });

  test("the refused areas are a fixed list (a change here is a reviewed change)", () => {
    assert.ok(REFUSED_ALWAYS.includes("/api/admin/support"));
    assert.ok(REFUSED_ALWAYS.includes("/api/admin/workspace-export"));
  });
});

describe("permissions a support session keeps", () => {
  const admin = PRESET_ROLES.admin.permissions as readonly string[];

  test("never the denied ones, at either level", () => {
    for (const key of SUPPORT_DENIED_PERMISSIONS) {
      assert.ok(PERMISSIONS.some((p) => p.key === key), `${key} is a real permission`);
      assert.equal(supportPermissionAllowed("admin", key), false, key);
      assert.equal(supportPermissionAllowed("read_only", key), false, key);
    }
    for (const key of ["account.token_create", "user.update_role", "identity.sso_manage", "license.install", "system.export", "integration.webhook_manage", "document.share_create"]) {
      assert.ok(SUPPORT_DENIED_PERMISSIONS.includes(key), key);
    }
  });

  test("read-only keeps only what reads", () => {
    const kept = admin.filter((k) => supportPermissionAllowed("read_only", k));
    for (const k of kept) assert.ok(readPermission(k), k);
    for (const k of ["document.read", "document.read_draft", "space.read_all", "audit.read", "search.query", "workspace.settings_read", "helpdesk.agent_all"]) {
      assert.equal(supportPermissionAllowed("read_only", k), true, k);
    }
    for (const k of ["document.update", "document.publish", "document.create", "comment.create", "workspace.settings_manage", "space.update", "attachment.upload", "document.track_view", "document.presence"]) {
      assert.equal(supportPermissionAllowed("read_only", k), false, k);
    }
  });

  test("administrator keeps an administrator's work", () => {
    for (const k of ["document.update", "document.publish", "workspace.settings_manage", "space.update", "audit.read"]) assert.equal(supportPermissionAllowed("admin", k), true, k);
  });
});

describe("the request proxy", () => {
  const ORIGIN = "https://acme.compassdocs.io";
  function run(method: string, path: string, headers: Record<string, string> = {}) {
    return proxy(new NextRequest(`${ORIGIN}${path}`, { method, headers }));
  }
  function forwardedHeader(res: Response, name: string): string | null {
    return res.headers.get(`x-middleware-request-${name}`);
  }
  const ro = { cookie: `${SESSION_COOKIE_NAME}=${RO}` };
  const rw = { cookie: `${SESSION_COOKIE_NAME}=${RW}` };

  test("read-only: an API change is a 403 with its code, before any route", async () => {
    const res = run("POST", "/api/documents", ro);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "support_read_only");
    const action = run("POST", "/doc/12", { ...ro, "next-action": "abc" });
    assert.equal(action.status, 403, "a page's server action too");
  });

  test("a page support may not open shows the not-available page at the same address", () => {
    const res = run("GET", "/admin/support-access", rw);
    assert.equal(new URL(res.headers.get("x-middleware-rewrite")!).pathname, SUPPORT_NOT_ALLOWED_PAGE);
    assert.equal(run("GET", "/api/admin/support", rw).status, 403);
  });

  test("page views and changes are tagged for the audit log; reads of an API and prefetches are not", () => {
    const page = run("GET", "/doc/12", ro);
    assert.match(forwardedHeader(page, SUPPORT_ACTIVITY_HEADER) ?? "", /^[0-9a-f-]{36} GET \/doc\/12$/);
    assert.equal(forwardedHeader(run("GET", "/doc/12", { ...ro, "next-router-prefetch": "1" }), SUPPORT_ACTIVITY_HEADER), null);
    assert.equal(forwardedHeader(run("GET", "/api/documents/12", ro), SUPPORT_ACTIVITY_HEADER), null);
    assert.match(forwardedHeader(run("PATCH", "/api/documents/12", rw), SUPPORT_ACTIVITY_HEADER) ?? "", / PATCH \/api\/documents\/12$/);
    assert.equal(forwardedHeader(run("DELETE", "/api/support/session", ro), SUPPORT_ACTIVITY_HEADER), null, "ending the session is not a change");
    assert.equal(forwardedHeader(run("POST", "/api/auth/logout", rw), SUPPORT_ACTIVITY_HEADER), null);
  });

  test("a tag a client sent is dropped, for anyone", () => {
    const forged = { [SUPPORT_ACTIVITY_HEADER]: "11111111-1111-1111-1111-111111111111 GET /x" };
    for (const h of [forged, { ...forged, cookie: `${SESSION_COOKIE_NAME}=${newToken()}` }]) {
      const res = run("GET", "/api/documents", h);
      const override = res.headers.get("x-middleware-override-headers") ?? "";
      assert.ok(override.split(",").length > 0);
      assert.equal(forwardedHeader(res, SUPPORT_ACTIVITY_HEADER), null);
    }
  });

  test("an ordinary session is untouched", () => {
    const h = { cookie: `${SESSION_COOKIE_NAME}=${newToken()}` };
    for (const [m, p] of [["POST", "/api/documents"], ["GET", "/admin/support-access"], ["DELETE", "/api/admin/workspace-export/x"]]) {
      const res = run(m, p, h);
      assert.equal(res.headers.get("x-middleware-next"), "1", `${m} ${p}`);
      assert.equal(forwardedHeader(res, SUPPORT_ACTIVITY_HEADER), null);
    }
  });

  test("a cross-site subresource carries no cookie, so no support session either", () => {
    const res = run("GET", "/api/attachments/1", { ...ro, "sec-fetch-dest": "image", "sec-fetch-site": "cross-site" });
    assert.equal(res.headers.get("x-middleware-next"), "1");
  });
});
