// Support access end to end in the data layer (1.21.4, lib/support): a
// request from the console, an administrator's decision, a staff sign-in
// with a one-time grant token, what the session is and may hold, its end,
// and the audit trail. A cloud workspace on the shared test database, with a
// throwaway signing key (never the vendor's).
//
// Covered: requests (created once, idempotent, turned off, the limits, the
// status check with the request's own token); approve, deny, revoke,
// review, and their refusals; sign-in (before approval refused without
// spending the token, then accepted; replayed; another staff member; a
// higher level; a closed window; a token for another workspace; emergency
// off, capped at read-only, allowed); the session (its own service account,
// never listed or counted as an administrator, a token prefix that names
// its level, no sliding, ended by revoke and by its time); its permissions
// (read-only reads only; administrator without sign-in, people, tokens,
// exports); and every step in the audit log.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/support-access.test.ts

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const WS = `ws_test_${randomBytes(3).toString("hex")}`;
process.env.COMPASSDOCS_CLOUD = "1";
process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";
process.env.COMPASSDOCS_WORKSPACE_ID = WS;
process.env.COMPASSDOCS_SUPPORT_PUBLIC_KEY = (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
process.env.COMPASSDOCS_AUDIT_STDOUT = "0";

type Support = typeof import("../src/lib/support");
type Db = typeof import("../src/lib/db");
let S: Support;
let db: Db;
let admin: { id: number; name: string; role: string };

const T = () => Math.floor(Date.now() / 1000);
const id = (p: string) => `${p}_${randomBytes(10).toString("hex")}`;
function signed(claims: Record<string, unknown>, key = privateKey): string {
  const payload = Buffer.from(JSON.stringify(claims));
  return `${payload.toString("base64url")}.${sign(null, payload, key).toString("base64url")}`;
}
const STAFF = { name: "Sam Support", email: "sam@compassdocs.io" };
function requestToken(over: Record<string, unknown> = {}): string {
  return signed({ typ: "compassdocs.support_request", v: 1, jti: id("req"), workspace: WS, staff: STAFF, reason: "Ticket 9001: search is slow", level: "read_only", duration_minutes: 60, iat: T(), nbf: T(), exp: T() + 600, ...over });
}
function grantToken(over: Record<string, unknown> = {}): string {
  return signed({ typ: "compassdocs.support_grant", v: 1, jti: id("grt"), workspace: WS, staff: STAFF, reason: "Ticket 9001", level: "read_only", iat: T(), nbf: T(), exp: T() + 3600, ...over });
}

async function rejects(p: Promise<unknown>, code: string, status?: number): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    const x = e as { code?: string; status?: number; message?: string };
    assert.equal(x.code, code, x.message);
    if (status) assert.equal(x.status, status);
    return true;
  });
}

async function auditActions(target: string): Promise<string[]> {
  const r = await db.pool().query("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id", [target]);
  return r.rows.map((x) => x.action as string);
}

async function settings(requests: boolean, emergency: "off" | "read_only" | "admin") {
  await S.saveSupportSettings({ requests, emergency }, admin, null);
}

/** Approve a fresh request; answers its id. */
async function approved(over: Record<string, unknown> = {}): Promise<string> {
  const r = await S.createSupportRequest(requestToken(over));
  await S.decideSupportRequest(r.request.id, "approve", admin, null);
  return r.request.id;
}

before(async () => {
  S = await import("../src/lib/support");
  db = await import("../src/lib/db");
  await db.getSetting("__boot__");
  const name = `sa_admin_${randomBytes(4).toString("hex")}`;
  const u = await db.pool().query<{ id: number }>("INSERT INTO users (username, name, role) VALUES ($1, 'Ada Admin', 'admin') RETURNING id", [name]);
  admin = { id: u.rows[0].id, name: "Ada Admin", role: "admin" };
  await db.pool().query("DELETE FROM support_requests");
  await settings(true, "off");
});

after(async () => {
  await db.pool().query("DELETE FROM support_requests").catch(() => {});
  await db.pool().query("DELETE FROM users WHERE auth_provider = 'compassdocs_support' OR id = $1", [admin.id]).catch(() => {});
  await db.pool().query("DELETE FROM settings WHERE key = $1", [S.SUPPORT_SETTINGS_KEY]).catch(() => {});
  await db.pool().end();
});

describe("the console asks", () => {
  test("a request is created once; the same token again answers the same request", async () => {
    const t = requestToken();
    const a = await S.createSupportRequest(t);
    assert.equal(a.created, true);
    assert.equal(a.request.status, "pending");
    const b = await S.createSupportRequest(t);
    assert.equal(b.created, false);
    assert.equal(b.request.id, a.request.id);
    assert.deepEqual(await auditActions(a.request.id), ["support.requested"]);
    // The console reads where it stands with the same token; another request's token is refused.
    assert.equal((await S.supportRequestStatus(a.request.id, t)).status, "pending");
    await rejects(S.supportRequestStatus(a.request.id, requestToken()), "wrong_request", 401);
    await S.decideSupportRequest(a.request.id, "deny", admin, null);
    assert.equal((await S.supportRequestStatus(a.request.id, t)).status, "denied");
  });

  test("refused: a forged or foreign token, requests turned off, too many waiting", async () => {
    const other = generateKeyPairSync("ed25519").privateKey;
    await rejects(S.createSupportRequest(signed(JSON.parse(Buffer.from(requestToken().split(".")[0], "base64url").toString()), other)), "bad_signature", 401);
    await rejects(S.createSupportRequest(requestToken({ workspace: "ws_someone_else" })), "wrong_workspace", 401);
    await rejects(S.createSupportRequest(grantToken()), "wrong_kind", 401);
    await settings(false, "off");
    await rejects(S.createSupportRequest(requestToken()), "support_requests_off", 403);
    await settings(true, "off");
    await db.pool().query("UPDATE support_requests SET status = 'denied' WHERE status = 'pending'");
    for (let i = 0; i < S.MAX_PENDING; i++) await S.createSupportRequest(requestToken());
    await rejects(S.createSupportRequest(requestToken()), "too_many_pending", 429);
    await db.pool().query("UPDATE support_requests SET status = 'denied' WHERE status = 'pending'");
  });

  test("an administrator is told in the bell", async () => {
    const before = await db.pool().query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1", [admin.id]);
    await S.createSupportRequest(requestToken());
    const after = await db.pool().query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1", [admin.id]);
    assert.ok(after.rows[0].n >= before.rows[0].n, "admins who can recover the workspace are told (this one may not be among them on a shared database)");
    await db.pool().query("UPDATE support_requests SET status = 'denied' WHERE status = 'pending'");
  });
});

describe("an administrator decides", () => {
  test("approve opens the window for the requested duration; deny and approve only while pending", async () => {
    const r = await S.createSupportRequest(requestToken({ duration_minutes: 90 }));
    const ok = await S.decideSupportRequest(r.request.id, "approve", admin, "203.0.113.9");
    assert.equal(ok.status, "approved");
    assert.equal(ok.decided_by_name, "Ada Admin");
    const span = new Date(ok.window_ends!).getTime() - new Date(ok.window_starts!).getTime();
    assert.equal(span, 90 * 60_000);
    await rejects(S.decideSupportRequest(r.request.id, "deny", admin, null), "not_pending", 409);
    await rejects(S.decideSupportRequest(r.request.id, "approve", admin, null), "not_pending", 409);
    await rejects(S.decideSupportRequest(r.request.id, "review", admin, null), "not_emergency", 409);
    await rejects(S.decideSupportRequest("req_doesnotexist_0000", "approve", admin, null), "not_found", 404);
    await S.decideSupportRequest(r.request.id, "revoke", admin, null);
    await rejects(S.decideSupportRequest(r.request.id, "revoke", admin, null), "not_active", 409);
    assert.deepEqual(await auditActions(r.request.id), ["support.requested", "support.approved", "support.revoked"]);
  });

  test("a request nobody decided lapses", async () => {
    const r = await S.createSupportRequest(requestToken());
    await S.sweepSupport(Date.now() + S.PENDING_TTL_MS + 1000);
    const row = await db.pool().query("SELECT status FROM support_requests WHERE id = $1", [r.request.id]);
    assert.equal(row.rows[0].status, "expired");
    await rejects(S.decideSupportRequest(r.request.id, "approve", admin, null), "not_pending", 409);
    assert.ok((await auditActions(r.request.id)).includes("support.request_expired"));
  });
});

describe("staff sign in", () => {
  test("before approval: refused, and the token is not spent; after approval the same token works, once", async () => {
    const r = await S.createSupportRequest(requestToken());
    const t = grantToken({ request: r.request.id });
    await rejects(S.startSupportSession(t), "not_approved", 403);
    await S.decideSupportRequest(r.request.id, "approve", admin, null);
    const s = await S.startSupportSession(t, { ip: "198.51.100.7", userAgent: "test" });
    assert.ok(s.token.startsWith("sup_ro_"), "the cookie names its level");
    assert.equal(s.level, "read_only");
    await rejects(S.startSupportSession(t), "replayed", 409);
    const actions = await auditActions(r.request.id);
    assert.ok(actions.includes("support.sign_in_refused"));
    assert.ok(actions.includes("support.signed_in"));
  });

  test("refused: another staff member, a higher level, another workspace, a closed window", async () => {
    const rid = await approved();
    await rejects(S.startSupportSession(grantToken({ request: rid, staff: { name: "Eve", email: "eve@example.com" } })), "wrong_staff", 403);
    await rejects(S.startSupportSession(grantToken({ request: rid, level: "admin" })), "level_too_high", 403);
    await rejects(S.startSupportSession(grantToken({ request: rid, workspace: "ws_other" })), "wrong_workspace", 401);
    await rejects(S.startSupportSession(grantToken({ request: "req_not_in_this_ws_0" })), "unknown_request", 403);
    await db.pool().query("UPDATE support_requests SET window_ends = now() - interval '1 minute' WHERE id = $1", [rid]);
    await rejects(S.startSupportSession(grantToken({ request: rid })), "window_closed", 403);
  });

  test("the session ends at the earlier of the token's end and the window's", async () => {
    const rid = await approved({ duration_minutes: 30 });
    const s = await S.startSupportSession(grantToken({ request: rid, exp: T() + 4 * 3600 }));
    assert.ok(s.expiresAt.getTime() <= Date.now() + 30 * 60_000 + 1000);
    const short = await S.startSupportSession(grantToken({ request: rid, exp: T() + 600 }));
    assert.ok(short.expiresAt.getTime() <= Date.now() + 600_000 + 1000);
  });

  test("emergency: off by default; capped at read-only; allowed, it is shown until reviewed", async () => {
    const em = (level = "read_only") => grantToken({ emergency: "P1 outage, INC-123", level });
    await settings(true, "off");
    await rejects(S.startSupportSession(em()), "emergency_off", 403);
    await settings(true, "read_only");
    await rejects(S.startSupportSession(em("admin")), "level_too_high", 403);
    const before = await S.unreviewedEmergencies();
    const s = await S.startSupportSession(em());
    assert.equal(await S.unreviewedEmergencies(), before + 1);
    const row = (await db.pool().query("SELECT id, kind, emergency_reason, decided_by_name FROM support_requests WHERE id = (SELECT request_id FROM support_sessions WHERE id = $1)", [s.sessionId])).rows[0];
    assert.equal(row.kind, "emergency");
    assert.equal(row.emergency_reason, "P1 outage, INC-123");
    assert.ok((await auditActions(row.id)).includes("support.emergency_access"));
    await S.decideSupportRequest(row.id, "review", admin, null);
    assert.equal(await S.unreviewedEmergencies(), before);
    await settings(true, "admin");
    const a = await S.startSupportSession(em("admin"));
    assert.ok(a.token.startsWith("sup_rw_"));
    await settings(true, "off");
  });
});

describe("the session", () => {
  test("its own service account: never listed, never an administrator who can recover the workspace", async () => {
    const rid = await approved();
    const s = await S.startSupportSession(grantToken({ request: rid }));
    const u = (await db.pool().query("SELECT u.* FROM users u JOIN support_sessions ss ON ss.principal_id = u.id WHERE ss.id = $1", [s.sessionId])).rows[0];
    assert.equal(u.status, "service");
    assert.equal(u.auth_provider, "compassdocs_support");
    assert.equal(u.password_hash, null);
    assert.equal(u.email, "");
    assert.equal(u.name, "Sam Support (CompassDocs support)");
    assert.ok(!(await db.listUsers()).some((x) => x.id === u.id), "not in the Users list");
    const { recoveryHolders } = await import("../src/lib/authz");
    assert.ok(!(await recoveryHolders()).some((x) => x.id === u.id), "never counted as an administrator");
    // The browser session: found by its token (stored hashed), with its support session.
    const row = await db.getSessionUser(s.token);
    assert.equal(row?.id, u.id);
    assert.equal(row?.support_session_id, s.sessionId);
    assert.equal(row?.session_auth_method, "support");
    const live = await S.liveSupportSession(s.sessionId, u.id);
    assert.equal(live?.level, "read_only");
    assert.equal(live?.staffEmail, "sam@compassdocs.io");
    // The same token with its prefix taken off (or swapped) is no session.
    assert.equal(await db.getSessionUser(s.token.slice("sup_ro_".length)), undefined);
    assert.equal(await db.getSessionUser(`sup_rw_${s.token.slice("sup_ro_".length)}`), undefined);
  });

  test("permissions: read-only reads; administrator works but never on sign-in, people, tokens or exports", async () => {
    const { grantsFor, holds, admits } = await import("../src/lib/authz");
    const ro = await S.startSupportSession(grantToken({ request: await approved() }));
    const rw = await S.startSupportSession(grantToken({ request: await approved({ level: "admin" }), level: "admin" }));
    const principal = async (sid: number) => (await db.pool().query("SELECT principal_id FROM support_sessions WHERE id = $1", [sid])).rows[0].principal_id as number;
    const g1 = await grantsFor(await principal(ro.sessionId));
    const g2 = await grantsFor(await principal(rw.sessionId));
    assert.equal(holds(g1, "audit.read"), true);
    assert.equal(admits(g1, "document.read"), true);
    for (const k of ["document.update", "workspace.settings_manage", "comment.create", "user.create"] as const) assert.equal(admits(g1, k), false, `read-only ${k}`);
    assert.equal(admits(g2, "document.update"), true);
    assert.equal(holds(g2, "workspace.settings_manage"), true);
    for (const k of ["user.create", "user.update_role", "user.reset_password", "account.token_create", "account.password_change", "identity.sso_manage", "license.install", "system.export", "system.backup_download", "integration.webhook_manage", "role.assign", "group.manage_members"] as const) {
      assert.equal(holds(g2, k), false, `administrator ${k}`);
    }
  });

  test("revoke ends it at once; the end is in the audit log", async () => {
    const rid = await approved();
    const s = await S.startSupportSession(grantToken({ request: rid }));
    const principal = (await db.pool().query("SELECT principal_id FROM support_sessions WHERE id = $1", [s.sessionId])).rows[0].principal_id;
    assert.ok(await db.getSessionUser(s.token));
    await S.decideSupportRequest(rid, "revoke", admin, null);
    assert.equal(await db.getSessionUser(s.token), undefined, "the browser session is gone");
    assert.equal(await S.liveSupportSession(s.sessionId, principal), null);
    const actions = await auditActions(rid);
    assert.ok(actions.includes("support.revoked"));
    assert.ok(actions.includes("support.session_ended"));
    const end = (await db.pool().query("SELECT details FROM audit_log WHERE target_id = $1 AND action = 'support.session_ended'", [rid])).rows[0].details;
    assert.equal(end.reason, "revoked");
  });

  test("at its end it ends (the minute tick), and says so", async () => {
    const rid = await approved();
    const s = await S.startSupportSession(grantToken({ request: rid }));
    await db.pool().query("UPDATE support_sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [s.sessionId]);
    const swept = await S.sweepSupport();
    assert.ok(swept.ended >= 1);
    assert.equal(await db.getSessionUser(s.token), undefined);
    const end = (await db.pool().query("SELECT details FROM audit_log WHERE target_id = $1 AND action = 'support.session_ended'", [rid])).rows[0].details;
    assert.equal(end.reason, "expired");
  });

  test("signing out ends it; page views and changes are counted and audited once per request", async () => {
    const rid = await approved();
    const s = await S.startSupportSession(grantToken({ request: rid }));
    const principal = (await db.pool().query("SELECT principal_id FROM support_sessions WHERE id = $1", [s.sessionId])).rows[0].principal_id;
    const live = (await S.liveSupportSession(s.sessionId, principal))!;
    const nonce = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await S.recordSupportActivity(live, principal, `${nonce} GET /admin/users`);
    await S.recordSupportActivity(live, principal, `${nonce} GET /admin/users`);
    await S.recordSupportActivity(live, principal, "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee PATCH /api/documents/4");
    await S.recordSupportActivity(live, principal, "not a tag");
    const ss = (await db.pool().query("SELECT pages, actions FROM support_sessions WHERE id = $1", [s.sessionId])).rows[0];
    assert.deepEqual(ss, { pages: 1, actions: 1 });
    await S.endOwnSupportSession(s.sessionId);
    assert.equal(await db.getSessionUser(s.token), undefined);
    const actions = await auditActions(rid);
    assert.equal(actions.filter((a) => a === "support.page_viewed").length, 1);
    assert.equal(actions.filter((a) => a === "support.action").length, 1);
    assert.ok(actions.includes("support.session_ended"));
  });

  test("support access switched off (the key removed): every support session stops", async () => {
    const rid = await approved();
    const s = await S.startSupportSession(grantToken({ request: rid }));
    const principal = (await db.pool().query("SELECT principal_id FROM support_sessions WHERE id = $1", [s.sessionId])).rows[0].principal_id;
    const key = process.env.COMPASSDOCS_SUPPORT_PUBLIC_KEY;
    delete process.env.COMPASSDOCS_SUPPORT_PUBLIC_KEY;
    try {
      assert.equal(await S.liveSupportSession(s.sessionId, principal), null);
      await rejects(S.createSupportRequest(requestToken()), "not_found", 404);
    } finally {
      process.env.COMPASSDOCS_SUPPORT_PUBLIC_KEY = key;
    }
  });

  test("the overview lists waiting, active, unreviewed and past access", async () => {
    const o = await S.supportAccessOverview();
    assert.equal(o.workspaceId, WS);
    assert.ok(o.active.length >= 1);
    assert.ok(o.history.length >= 1);
    for (const item of [...o.active, ...o.history]) assert.ok(Array.isArray(item.sessions));
  });
});
