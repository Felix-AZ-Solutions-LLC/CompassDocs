// 1.20.27 security fixes that need the database: "SSO only" enforced with
// a break-glass list (H1) and "Remove local passwords"; temporary passwords
// that expire (M2); rehashing on sign-in (M7); the steps a session can owe
// (a forced password change, M2; two-step set-up, H3) refused on every API;
// the absolute session lifetime (M8); bearer credentials revoked by a
// password reset or change, expiring API tokens, and the connector's OAuth
// (H4, M1, L4); the 2FA disable throttle (Low); the MCP endpoint's batch cap
// and rate limit (app M5).
//
// "SSO only" is read through a stub of lib/sign-in-routing, so no single
// sign-on settings of the shared database change; the two-step and lifetime
// settings are set for a moment and put back.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/security-sessions.test.ts

import Module from "node:module";
import path from "node:path";
import { scryptSync } from "node:crypto";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";
delete process.env.COMPASSDOCS_DUO_DISABLED;

let currentRequest: Request | null = null;
let currentToken = "";
let ssoOnly = false;
const edition = { present: true, features: ["sso"] as string[] };
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.security.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.security.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
{
  const mk = (file: string, exports: unknown) => {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
  };
  mk(HEADERS_STUB, {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => ({
      get: (name: string) => (name === "compass_session" && currentToken ? { name, value: currentToken } : undefined),
      getAll: () => [],
      has: () => false,
    }),
    draftMode: async () => ({ isEnabled: false }),
  });
  const has = (f: string) => edition.features.includes(f);
  mk(EE_STUB, {
    ee: () => edition,
    eePresent: () => true,
    featureEnabled: async (f: string) => has(f),
    featureEnforced: async (f: string) => has(f),
    featureEnabledFrom: (f: string) => has(f),
    featureEnforcedFrom: (f: string) => has(f),
  });
  const loader = Module as unknown as { _resolveFilename: (r: string, p: { filename?: string } | null, ...rest: unknown[]) => string };
  const resolve = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    const from = parent?.filename ? path.dirname(parent.filename) : "";
    if ((request === "./ee" || request === "../ee") && path.resolve(from, request) === EE_REAL) return EE_STUB;
    return resolve.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const db = require("../src/lib/db") as typeof import("../src/lib/db");
const routing = require("../src/lib/sign-in-routing") as typeof import("../src/lib/sign-in-routing");
routing.setSignInSetupForTests(() => ({ oidc: null, saml: null, ssoOnly }));
const { fixtureQuery } = require("./support/retry") as typeof import("./support/retry");
const auth = require("../src/lib/auth") as typeof import("../src/lib/auth");
const apiAuth = require("../src/lib/api-auth") as typeof import("../src/lib/api-auth");
const { hashPassword, newToken } = require("../src/lib/password") as typeof import("../src/lib/password");
const { totpCode, generateTotpSecret } = require("../src/lib/totp") as typeof import("../src/lib/totp");
const { consentToken } = require("../src/lib/oauth-consent") as typeof import("../src/lib/oauth-consent");
const { v1Auth } = require("../src/lib/v1-auth") as typeof import("../src/lib/v1-auth");
const loginRoute = require("../src/app/api/auth/login/route") as typeof import("../src/app/api/auth/login/route");
const changePasswordRoute = require("../src/app/api/auth/change-password/route") as typeof import("../src/app/api/auth/change-password/route");
const adminUserRoute = require("../src/app/api/admin/users/[id]/route") as typeof import("../src/app/api/admin/users/[id]/route");
const tokensRoute = require("../src/app/api/account/tokens/route") as typeof import("../src/app/api/account/tokens/route");
const twofaRoute = require("../src/app/api/account/2fa/route") as typeof import("../src/app/api/account/2fa/route");
const approveRoute = require("../src/app/api/oauth/approve/route") as typeof import("../src/app/api/oauth/approve/route");
const registerRoute = require("../src/app/api/oauth/register/route") as typeof import("../src/app/api/oauth/register/route");
const mcpRoute = require("../src/app/api/mcp/route") as typeof import("../src/app/api/mcp/route");
/* eslint-enable @typescript-eslint/no-require-imports */

const { pool, setSetting, getSetting } = db;
const ORIGIN = "https://docs.example.test";
const STAMP = `sec${Date.now()}`;
const PW = "Correct-horse-battery-1";
const ids: number[] = [];
const clients: string[] = [];

async function user(tag: string, opts: { role?: string; password?: string | null; legacyHash?: boolean; provider?: string } = {}) {
  let hash: string | null = null;
  let salt: string | null = null;
  if (opts.password !== null) {
    const pw = opts.password ?? PW;
    if (opts.legacyHash) {
      salt = "00112233445566778899aabbccddeeff";
      hash = scryptSync(pw, salt, 64).toString("hex");
    } else ({ hash, salt } = await hashPassword(pw));
  }
  const r = await pool().query<{ id: number }>(
    `INSERT INTO users (username, name, email, role, auth_provider, password_hash, password_salt) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [`${STAMP}-${tag}`, `Sec ${tag}`, `${tag}@${STAMP}.test`, opts.role ?? "viewer", opts.provider ?? "local", hash, salt]
  );
  ids.push(r.rows[0].id);
  return { id: r.rows[0].id, username: `${STAMP}-${tag}` };
}

async function session(id: number, method: string | null = "password"): Promise<string> {
  const t = newToken();
  await db.createSession(t, id, new Date(Date.now() + 3_600_000).toISOString(), "198.51.100.9", "security.test", method as never);
  return t;
}

function as(token: string, url: string, init: RequestInit = {}): Request {
  currentToken = token;
  currentRequest = new Request(url, { ...init, headers: { "x-forwarded-host": "docs.example.test", "x-forwarded-proto": "https", ...((init.headers as Record<string, string>) ?? {}) } });
  return currentRequest;
}

const json = (body: unknown, ip = "203.0.113.20") => ({ method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });

async function withSettings<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(values)) saved[k] = await getSetting(k);
  try {
    for (const [k, v] of Object.entries(values)) await setSetting(k, v);
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) await pool().query("DELETE FROM settings WHERE key = $1", [k]);
      else await setSetting(k, v);
    }
  }
}

async function audited(action: string, targetId: number): Promise<number> {
  return Number((await pool().query("SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND target_id = $2", [action, String(targetId)])).rows[0].n);
}

before(async () => {
  await getSetting("__schema_bootstrap__");
});

after(async () => {
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [ids]);
  await pool().query("DELETE FROM oauth_clients WHERE client_id = ANY($1)", [clients]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [ids]);
});

describe("SSO only is enforced (H1)", () => {
  let glass: { id: number; username: string };
  let plain: { id: number; username: string };
  let savedGlass: string | undefined;
  before(async () => {
    glass = await user("glass", { role: "admin" });
    plain = await user("plain");
    savedGlass = await getSetting("sso_break_glass_user_ids");
    await setSetting("sso_break_glass_user_ids", JSON.stringify([glass.id]));
    ssoOnly = true;
  });
  after(async () => {
    ssoOnly = false;
    if (savedGlass === undefined) await pool().query("DELETE FROM settings WHERE key = 'sso_break_glass_user_ids'");
    else await setSetting("sso_break_glass_user_ids", savedGlass);
  });

  test("a password signs in only a break-glass account, and every other attempt gets one answer", async () => {
    assert.deepEqual(await auth.login(plain.username, PW), { refused: "sso_only" }, "the right password, not break-glass");
    assert.deepEqual(await auth.login(plain.username, "wrong-password-1"), { refused: "sso_only" });
    assert.deepEqual(await auth.login(`${STAMP}-nobody`, PW), { refused: "sso_only" }, "an unknown name");
    assert.deepEqual(await auth.login(glass.username, "wrong-password-1"), { refused: "sso_only" }, "break-glass, wrong password");
    const ok = await auth.login(glass.username, PW);
    assert.ok(ok && "token" in ok && ok.breakGlass === true);
  });

  test("the sign-in route refuses with code sso_only, and audits each break-glass sign-in", async () => {
    const refused = await loginRoute.POST(as("", `${ORIGIN}/api/auth/login`, json({ username: plain.username, password: PW }, "203.0.113.31")));
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).code, "sso_only");
    const before = await audited("auth.break_glass_login", glass.id);
    const ok = await loginRoute.POST(as("", `${ORIGIN}/api/auth/login`, json({ username: glass.username, password: PW }, "203.0.113.32")));
    assert.equal(ok.status, 200);
    assert.equal(await audited("auth.break_glass_login", glass.id), before + 1);
  });

  test("Remove local passwords clears every other password, with its tokens and password sessions, and keeps break-glass and the caller", async () => {
    const victim = await user("leftover");
    const ssoSession = await session(victim.id, "sso");
    const pwSession = await session(victim.id, "password");
    const mine = await session(victim.id, null);
    await db.createApiToken(victim.id, "old", ["read"]);
    // Only this file's accounts: everyone else in the shared database is kept.
    const others = (await pool().query<{ id: number }>("SELECT id FROM users WHERE NOT (id = ANY($1))", [[victim.id, plain.id]])).rows.map((r) => r.id);
    const cleared = await db.removeLocalPasswords([...others, glass.id], mine);
    assert.deepEqual(cleared.map((c) => c.id).sort(), [victim.id, plain.id].sort());
    const row = (await pool().query("SELECT password_hash FROM users WHERE id = $1", [victim.id])).rows[0];
    assert.equal(row.password_hash, null);
    assert.ok((await pool().query("SELECT password_hash FROM users WHERE id = $1", [glass.id])).rows[0].password_hash, "break-glass keeps it");
    assert.equal(Number((await pool().query("SELECT count(*)::int AS n FROM api_tokens WHERE user_id = $1", [victim.id])).rows[0].n), 0);
    assert.ok(await db.getSessionUser(ssoSession), "a single sign-on session stays");
    assert.equal(await db.getSessionUser(pwSession), undefined, "a password session goes");
    assert.ok(await db.getSessionUser(mine), "the administrator's own session stays");
  });
});

describe("temporary passwords and rehashing (M2, M7)", () => {
  test("a temporary password stops working 72 hours after it was set", async () => {
    const u = await user("temp");
    const { hash, salt } = await hashPassword(PW);
    await db.setUserPassword(u.id, hash, salt, true);
    const row = (await pool().query("SELECT temp_password_expires_at - now() AS left FROM users WHERE id = $1", [u.id])).rows[0];
    assert.ok(row.left.hours >= 71 || row.left.days >= 2, `about 72 hours (${JSON.stringify(row.left)})`);
    assert.ok(await auth.login(u.username, PW).then((r) => r && "token" in r), "works while fresh");
    await pool().query("UPDATE users SET temp_password_expires_at = now() - interval '1 minute' WHERE id = $1", [u.id]);
    assert.deepEqual(await auth.login(u.username, PW), { refused: "temp_expired" });
    assert.equal(await auth.login(u.username, "wrong-password-1"), null, "said only to someone who typed it");
  });

  test("a hash made with the old scrypt parameters is stored again at sign-in", async () => {
    const u = await user("legacy", { legacyHash: true });
    const r = await auth.login(u.username, PW);
    assert.ok(r && "token" in r);
    const row = (await pool().query("SELECT password_hash FROM users WHERE id = $1", [u.id])).rows[0];
    assert.match(row.password_hash, /^s2\$/);
    assert.ok(await auth.login(u.username, PW).then((x) => x && "token" in x), "and still signs in");
  });
});

describe("steps a session owes (M2, H3) and the absolute lifetime (M8)", () => {
  test("a forced password change: every API refuses, the change itself does not, and then all is open", async () => {
    const u = await user("forced");
    const { hash, salt } = await hashPassword(PW);
    await db.setUserPassword(u.id, hash, salt, true);
    const t = await session(u.id);
    as(t, `${ORIGIN}/api/anything`);
    const refused = await apiAuth.apiSession();
    assert.ok(refused instanceof Response);
    assert.equal((refused as Response).status, 403);
    assert.equal((await (refused as Response).json()).code, "password_change_required");
    assert.equal(await auth.getCurrentUser(), null, "no one, to anything that asks the plain way");
    const mint = await tokensRoute.POST(as(t, `${ORIGIN}/api/account/tokens`, json({ name: "sneaky" })));
    assert.equal(mint.status, 403, "no token can be minted meanwhile");
    const changed = await changePasswordRoute.POST(as(t, `${ORIGIN}/api/auth/change-password`, json({ currentPassword: PW, newPassword: "A-new-password-2" })));
    assert.equal(changed.status, 200, await changed.clone().text());
    as(t, `${ORIGIN}/api/anything`);
    assert.ok(!((await apiAuth.apiSession()) instanceof Response), "open once changed");
  });

  test("Require two-step sign-in covers password sessions without an authenticator, and the set-up routes only", async () => {
    await withSettings({ require_two_step: "everyone" }, async () => {
      const u = await user("twostep");
      const pw = await session(u.id, "password");
      const sso = await session(u.id, "sso");
      as(pw, `${ORIGIN}/api/x`);
      assert.equal((await auth.currentSession())?.pending, "two_step");
      const refused = await apiAuth.apiSession();
      assert.ok(refused instanceof Response);
      assert.equal((await (refused as Response).json()).code, "two_step_required");
      const setup = await twofaRoute.POST(as(pw, `${ORIGIN}/api/account/2fa`, json({ action: "setup" })));
      assert.equal(setup.status, 200, "the set-up route answers");
      const { secret } = (await setup.json()) as { secret: string };
      as(sso, `${ORIGIN}/api/x`);
      assert.equal((await auth.currentSession())?.pending, null, "single sign-on brings its own second step");
      const on = await twofaRoute.POST(as(pw, `${ORIGIN}/api/account/2fa`, json({ action: "enable", code: totpCode(secret) })));
      assert.equal(on.status, 200);
      as(pw, `${ORIGIN}/api/x`);
      assert.equal((await auth.currentSession())?.pending, null, "set up: nothing owed");
      // And it cannot be turned off while the rule covers the account.
      const off = await twofaRoute.POST(as(pw, `${ORIGIN}/api/account/2fa`, json({ action: "disable", code: totpCode(secret) })));
      assert.equal(off.status, 403);
    });
  });

  test("off by default: nobody is asked", async () => {
    const saved = await getSetting("require_two_step");
    await pool().query("DELETE FROM settings WHERE key = 'require_two_step'");
    try {
      const u = await user("default");
      as(await session(u.id, "password"), `${ORIGIN}/api/x`);
      assert.equal((await auth.currentSession())?.pending, null);
    } finally {
      if (saved !== undefined) await setSetting("require_two_step", saved);
    }
  });

  test("a session ends its lifetime after it began, however active", async () => {
    const u = await user("lifetime");
    const t = await session(u.id, null);
    as(t, `${ORIGIN}/api/x`);
    assert.ok(await auth.currentSession(), "fresh");
    await pool().query("UPDATE sessions SET created_at = now() - interval '31 days' WHERE user_id = $1", [u.id]);
    assert.equal(await auth.currentSession(), null, "past the default 30 days");
    assert.equal(Number((await pool().query("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1", [u.id])).rows[0].n), 0, "and deleted");
    await withSettings({ session_max_days: "60" }, async () => {
      const t2 = await session(u.id, null);
      await pool().query("UPDATE sessions SET created_at = now() - interval '31 days' WHERE user_id = $1", [u.id]);
      as(t2, `${ORIGIN}/api/x`);
      assert.ok(await auth.currentSession(), "the setting lengthens it");
    });
  });
});

describe("bearer credentials (H4, M1, L4)", () => {
  async function grant(userId: number) {
    const c = await db.registerOAuthClient(`${STAMP} app`, ["https://claude.example.test/cb"]);
    clients.push(c.client_id);
    return { client: c.client_id, tokens: await db.createOAuthTokens(c.client_id, userId) };
  }

  test("a changed password ends the account's tokens, app grants and other sessions; the change is audited", async () => {
    const u = await user("change");
    const t = await session(u.id);
    const other = await session(u.id);
    await db.createApiToken(u.id, "laptop", ["read", "write"]);
    const g = await grant(u.id);
    const res = await changePasswordRoute.POST(as(t, `${ORIGIN}/api/auth/change-password`, json({ currentPassword: PW, newPassword: "Another-good-pass-3" })));
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).revoked, { api_tokens: 1, oauth_grants: 1, other_sessions: 1 });
    assert.equal(await db.getUserByOAuthToken(g.tokens.accessToken), undefined);
    assert.equal(await db.getSessionUser(other), undefined);
    assert.ok(await db.getSessionUser(t), "this session stays");
    assert.equal(await audited("auth.password_changed", u.id), 1);
  });

  test("an administrator's reset does the same, and the new password is temporary", async () => {
    const admin = await user("admin", { role: "admin" });
    const u = await user("reset");
    await db.createApiToken(u.id, "ci", ["read"]);
    await grant(u.id);
    const res = await adminUserRoute.PATCH(as(await session(admin.id), `${ORIGIN}/api/admin/users/${u.id}`, { ...json({ resetPassword: "Temporary-pass-42" }), method: "PATCH" }), {
      params: Promise.resolve({ id: String(u.id) }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual((await res.json()).revoked, { api_tokens: 1, oauth_grants: 1 });
    const row = (await pool().query("SELECT must_change_password, temp_password_expires_at FROM users WHERE id = $1", [u.id])).rows[0];
    assert.equal(row.must_change_password, 1);
    assert.ok(row.temp_password_expires_at);
  });

  test("new tokens expire (90 days by default); only an administrator may make one that never does", async () => {
    const viewer = await user("tokv");
    const vt = await session(viewer.id);
    const plain = await tokensRoute.POST(as(vt, `${ORIGIN}/api/account/tokens`, json({ name: "default" })));
    assert.equal(plain.status, 201);
    const rec = (await plain.json()).record;
    const days = (new Date(rec.expires_at).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 89 && days <= 90, `90 days (${days})`);
    assert.equal((await tokensRoute.POST(as(vt, `${ORIGIN}/api/account/tokens`, json({ name: "x", expires_in_days: 7 })))).status, 400);
    assert.equal((await tokensRoute.POST(as(vt, `${ORIGIN}/api/account/tokens`, json({ name: "x", expires_in_days: null })))).status, 403);
    const admin = await user("toka", { role: "admin" });
    const forever = await tokensRoute.POST(as(await session(admin.id), `${ORIGIN}/api/account/tokens`, json({ name: "svc", expires_in_days: null })));
    assert.equal(forever.status, 201);
    assert.equal((await forever.json()).record.expires_at, null);
    const { token } = await db.createApiToken(viewer.id, "old", ["read"], 30);
    assert.ok(await db.getUserByApiToken(token));
    await pool().query("UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1 AND name = 'old'", [viewer.id]);
    assert.equal(await db.getUserByApiToken(token), undefined, "an expired token is refused");
  });

  test("the consent decision needs this site's Origin and the page's token", async () => {
    const u = await user("consent");
    const t = await session(u.id, null);
    const c = await db.registerOAuthClient(`${STAMP} consent`, ["https://claude.example.test/cb"]);
    clients.push(c.client_id);
    const form = (extra: Record<string, string> = {}) => {
      const f = new FormData();
      for (const [k, v] of Object.entries({ client_id: c.client_id, redirect_uri: "https://claude.example.test/cb", code_challenge: "c".repeat(43), code_challenge_method: "S256", decision: "approve", ...extra })) f.set(k, v);
      return f;
    };
    const foreign = await approveRoute.POST(as(t, `${ORIGIN}/api/oauth/approve`, { method: "POST", body: form(), headers: { origin: "https://marketing.example.test" } }));
    assert.equal(foreign.status, 403, "a foreign Origin");
    const noToken = await approveRoute.POST(as(t, `${ORIGIN}/api/oauth/approve`, { method: "POST", body: form() }));
    assert.equal(noToken.status, 403, "no consent token");
    const good = consentToken(t, { client_id: c.client_id, redirect_uri: "https://claude.example.test/cb", code_challenge: "c".repeat(43) });
    const ok = await approveRoute.POST(as(t, `${ORIGIN}/api/oauth/approve`, { method: "POST", body: form({ consent_token: good }) }));
    assert.equal(ok.status, 303);
    assert.match(ok.headers.get("location") || "", /code=cda_/);
  });

  test("a refresh with another client's id changes nothing; a grant ends 90 days after approval", async () => {
    const u = await user("refresh");
    const g = await grant(u.id);
    assert.equal(await db.rotateOAuthTokens(g.tokens.refreshToken, "cdc_someone_else"), undefined);
    const rotated = await db.rotateOAuthTokens(g.tokens.refreshToken, g.client);
    assert.ok(rotated, "the real client's refresh token still works");
    await pool().query("UPDATE oauth_tokens SET grant_started_at = now() - interval '91 days' WHERE user_id = $1", [u.id]);
    assert.equal(await db.getUserByOAuthToken(rotated!.accessToken), undefined);
    assert.equal(await db.rotateOAuthTokens(rotated!.refreshToken, g.client), undefined);
  });

  test("client registration is rate limited per address", async () => {
    const ip = `203.0.113.${100 + Math.floor(Math.random() * 100)}`;
    const reg = () =>
      registerRoute.POST(new Request(`${ORIGIN}/api/oauth/register`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ client_name: `${STAMP} reg`, redirect_uris: ["https://claude.example.test/cb"] }) }));
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await reg();
      statuses.push(r.status);
      if (r.status === 201) clients.push((await r.json()).client_id);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(201));
    assert.equal(statuses[10], 429);
  });

  test("the MCP endpoint caps batches at 20 and counts every call against 120 a minute", async () => {
    const u = await user("mcp");
    const { token } = await db.createApiToken(u.id, "mcp", ["read", "write"]);
    const call = (body: unknown) =>
      mcpRoute.POST(new Request(`${ORIGIN}/api/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
    const ping = (i: number) => ({ jsonrpc: "2.0", id: i, method: "ping" });
    assert.equal((await call(Array.from({ length: 21 }, (_, i) => ping(i)))).status, 400);
    for (let b = 0; b < 6; b++) assert.equal((await call(Array.from({ length: 20 }, (_, i) => ping(i)))).status, 200, `batch ${b + 1}`);
    const over = await call(ping(1));
    assert.equal(over.status, 429);
    assert.ok(Number(over.headers.get("retry-after")) > 0);
  });

  test("a token of an account that must set a new password works nowhere", async () => {
    const u = await user("mustbearer");
    const { token } = await db.createApiToken(u.id, "t", ["read", "write"]);
    await pool().query("UPDATE users SET must_change_password = 1 WHERE id = $1", [u.id]);
    const v1 = await v1Auth(new Request(`${ORIGIN}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } }), "read");
    assert.ok(v1 instanceof Response && v1.status === 403);
    const mcp = await mcpRoute.POST(new Request(`${ORIGIN}/api/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }));
    assert.equal(mcp.status, 403);
  });
});

describe("turning two-step sign-in off is throttled (Low)", () => {
  test("five wrong codes, then a wait", async () => {
    const u = await user("disable");
    const secret = generateTotpSecret();
    await db.setPendingTotpSecret(u.id, secret);
    await db.enableTotp(u.id, []);
    const t = await session(u.id, "password_totp");
    const ip = "203.0.113.77";
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await twofaRoute.POST(as(t, `${ORIGIN}/api/account/2fa`, json({ action: "disable", code: "000000" }, ip)))).status);
    }
    assert.deepEqual(statuses, [400, 400, 400, 400, 400, 429]);
  });
});
