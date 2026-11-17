// 1.20.27, second security review: the fixes that need a database.
//
//   H1  an upgrade with "SSO only" on names the administrators break-glass;
//       SSO only (or the list) cannot be saved without a usable one; the
//       COMPASSDOCS_SSO_ONLY_DISABLED escape hatch.
//   M1  the sign-in budget is the account's; a known address comes from
//       the database and is slowed, never refused.
//   M2  at most a few scrypt derivations at once, a bounded queue, 503.
//   M4  comment and training mail links come from the configured address,
//       never the request's Host.
//   M5  "Remove local passwords" keeps administrators' passwords and ends
//       unexchanged connector codes.
//   M6  a Duo-approved session meets "Require two-step sign-in".
//   M7  a lapsed licence: only relaxing SSO changes save.
//   Low a never-expiring token of an account that owes two-step set-up; the
//       72-hour expiry for temporary passwords set before the upgrade;
//       break-glass accounts must have an authenticator; revoking another
//       account's token needs a higher role; legacy hashes take as long as
//       current ones; the stdout audit mirror never carries what was typed.
//
// It runs on a database of its own (created from DATABASE_URL's server and
// dropped afterwards), so the SSO settings and boot steps it changes never
// reach the shared database the other suites use.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/security-review2.test.ts

import Module from "node:module";
import path from "node:path";
import { scryptSync } from "node:crypto";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";

process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";
process.env.COMPASSDOCS_AUDIT_STDOUT = "0";
delete process.env.COMPASSDOCS_DUO_DISABLED;
delete process.env.COMPASSDOCS_SSO_ONLY_DISABLED;
delete process.env.COMPASSDOCS_BASE_URL;

let currentRequest: Request | null = null;
let currentToken = "";
let ssoOnly = false;
/** Licensed features, and those a lapsed licence still enforces. */
const edition = { features: ["sso", "training"] as string[], lapsed: [] as string[] };
const mentionOrigins: string[] = [];
const trainingOrigins: string[] = [];
const STUBS = path.join(__dirname, "stubs");
const HEADERS_STUB = path.join(STUBS, "next-headers.review2.virtual.js");
const EE_STUB = path.join(STUBS, "ee.review2.virtual.js");
const COMMENTS_STUB = path.join(STUBS, "comments.review2.virtual.js");
const TRAINING_STUB = path.join(STUBS, "training.review2.virtual.js");
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
  const enforced = (f: string) => has(f) || edition.lapsed.includes(f);
  mk(EE_STUB, {
    ee: () => ({ present: true, features: edition.features }),
    eePresent: () => true,
    featureEnabled: async (f: string) => has(f),
    featureEnforced: async (f: string) => enforced(f),
    featureEnabledFrom: (f: string) => has(f),
    featureEnforcedFrom: (f: string) => enforced(f),
  });
  const loader = Module as unknown as { _resolveFilename: (r: string, p: { filename?: string } | null, ...rest: unknown[]) => string };
  const resolve = loader._resolveFilename;
  let stubbed = false;
  const stubLibs = () => {
    if (stubbed) return;
    stubbed = true;
    /* eslint-disable @typescript-eslint/no-require-imports */
    const comments = require("../src/lib/comments");
    mk(COMMENTS_STUB, { ...comments, notifyMentions: async (i: { origin: string }) => void mentionOrigins.push(i.origin) });
    const training = require("../src/lib/training");
    mk(TRAINING_STUB, { ...training, notifyTrainingAssigned: async (i: { origin: string }) => void trainingOrigins.push(i.origin) });
    /* eslint-enable @typescript-eslint/no-require-imports */
  };
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if (request === "@/lib/comments") return (stubLibs(), COMMENTS_STUB);
    if (request === "@/lib/training") return (stubLibs(), TRAINING_STUB);
    const from = parent?.filename ? path.dirname(parent.filename) : "";
    if ((request === "./ee" || request === "../ee") && path.resolve(from, request) === EE_REAL) return EE_STUB;
    return resolve.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
type Db = typeof import("../src/lib/db");
let db: Db;
let routing: typeof import("../src/lib/sign-in-routing");
let auth: typeof import("../src/lib/auth");
let password: typeof import("../src/lib/password");
let guard: typeof import("../src/lib/login-guard");
let security: typeof import("../src/lib/sign-in-security");
let loginRoute: typeof import("../src/app/api/auth/login/route");
let ssoRoute: typeof import("../src/app/api/admin/sso/route");
let removeRoute: typeof import("../src/app/api/admin/sso/remove-passwords/route");
let commentsRoute: typeof import("../src/app/api/documents/[id]/comments/route");
let deckRoute: typeof import("../src/app/api/training/decks/[id]/route");
let v1: typeof import("../src/lib/v1-auth");
/* eslint-enable @typescript-eslint/no-require-imports */

const SHARED = process.env.DATABASE_URL;
const NAME = `compassdocs_sr2_${Date.now()}`;
const ORIGIN = "https://docs.example.test";
const PW = "Correct-horse-battery-1";
let seq = 0;

async function adminSql(sql: string): Promise<void> {
  const c = new Client({ connectionString: SHARED });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

before(async () => {
  assert.ok(SHARED, "DATABASE_URL is set");
  await adminSql(`CREATE DATABASE ${NAME}`);
  const url = new URL(SHARED!);
  url.pathname = `/${NAME}`;
  process.env.DATABASE_URL = url.toString();
  /* eslint-disable @typescript-eslint/no-require-imports */
  db = require("../src/lib/db");
  routing = require("../src/lib/sign-in-routing");
  routing.setSignInSetupForTests(() => ({ oidc: null, saml: null, ssoOnly }));
  auth = require("../src/lib/auth");
  password = require("../src/lib/password");
  guard = require("../src/lib/login-guard");
  security = require("../src/lib/sign-in-security");
  loginRoute = require("../src/app/api/auth/login/route");
  ssoRoute = require("../src/app/api/admin/sso/route");
  removeRoute = require("../src/app/api/admin/sso/remove-passwords/route");
  commentsRoute = require("../src/app/api/documents/[id]/comments/route");
  deckRoute = require("../src/app/api/training/decks/[id]/route");
  v1 = require("../src/lib/v1-auth");
  /* eslint-enable @typescript-eslint/no-require-imports */
  await db.getSetting("__schema_bootstrap__");
});

after(async () => {
  routing?.setSignInSetupForTests(null);
  await db?.pool().end().catch(() => {});
  process.env.DATABASE_URL = SHARED;
  await adminSql(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`).catch(() => {});
});

const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.pool().query(sql, params).then((r) => r.rows as T[]);

async function user(tag: string, opts: { role?: string; password?: string | null; legacyHash?: boolean; provider?: string } = {}) {
  let hash: string | null = null;
  let salt: string | null = null;
  if (opts.password !== null) {
    const pw = opts.password ?? PW;
    if (opts.legacyHash) {
      salt = "00112233445566778899aabbccddeeff";
      hash = scryptSync(pw, salt, 64).toString("hex");
    } else ({ hash, salt } = await password.hashPassword(pw));
  }
  const name = `r2-${tag}-${++seq}`;
  const r = await q<{ id: number }>(
    `INSERT INTO users (username, name, email, role, auth_provider, password_hash, password_salt) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [name, `R2 ${tag}`, `${name}@r2.test`, opts.role ?? "viewer", opts.provider ?? "local", hash, salt]
  );
  return { id: r[0].id, username: name, email: `${name}@r2.test` };
}

async function session(id: number, method: string | null = "password", ip = "198.51.100.9"): Promise<string> {
  const t = password.newToken();
  await db.createSession(t, id, new Date(Date.now() + 3_600_000).toISOString(), ip, "review2.test", method as never);
  return t;
}

function as(token: string, url: string, init: RequestInit = {}): Request {
  currentToken = token;
  currentRequest = new Request(url, {
    ...init,
    headers: { "x-forwarded-host": "phish.example.invalid", "x-forwarded-proto": "https", ...((init.headers as Record<string, string>) ?? {}) },
  });
  return currentRequest;
}

const body = (method: string, b: unknown, ip = "203.0.113.20"): RequestInit => ({
  method,
  headers: { "content-type": "application/json", "x-forwarded-for": ip },
  body: JSON.stringify(b),
});

async function reboot(): Promise<void> {
  (globalThis as { __compassInit?: unknown }).__compassInit = undefined;
  await db.getSetting("__schema_bootstrap__");
}

async function setRaw(key: string, value: string | null): Promise<void> {
  if (value === null) await q("DELETE FROM settings WHERE key = $1", [key]);
  else await db.setSetting(key, value);
}

const breakGlass = async () => JSON.parse((await db.getSetting("sso_break_glass_user_ids")) || "[]") as number[];

describe("H1: an upgrade with SSO only on", () => {
  test("names the active administrators with a password break-glass, on the audit log", async () => {
    const admin = await user("seed-admin", { role: "admin" });
    const off = await user("seed-off", { role: "admin" });
    await q("UPDATE users SET status = 'disabled' WHERE id = $1", [off.id]);
    const nopw = await user("seed-nopw", { role: "admin", password: null });
    const editor = await user("seed-editor", { role: "editor" });
    await setRaw("sso_only", "1");
    await setRaw("sso_break_glass_user_ids", null);
    try {
      await reboot();
      const list = await breakGlass();
      assert.ok(list.includes(admin.id), "the active administrator with a password");
      for (const u of [off, nopw, editor]) assert.ok(!list.includes(u.id), `not ${u.username}`);
      const rows = await q<{ details: { break_glass_user_ids: { to: number[] }; reason: string } }>(
        "SELECT details FROM audit_log WHERE action = 'settings.break_glass_seeded' ORDER BY id DESC LIMIT 1"
      );
      assert.equal(rows[0]?.details.reason, "upgrade");
      assert.deepEqual(rows[0].details.break_glass_user_ids.to, list);

      // A list with someone who can still get in is left alone at the next boot.
      await db.setSetting("sso_break_glass_user_ids", JSON.stringify([admin.id]));
      await reboot();
      assert.deepEqual(await breakGlass(), [admin.id]);
    } finally {
      await setRaw("sso_only", null);
    }
  });

  test("SSO only off: nothing is seeded", async () => {
    await setRaw("sso_break_glass_user_ids", null);
    await reboot();
    assert.equal(await db.getSetting("sso_break_glass_user_ids"), undefined);
  });

  test("SSO only (or the list) cannot be saved without a usable break-glass administrator; turning it off always can", async () => {
    const admin = await user("patch-admin", { role: "admin" });
    const tok = await session(admin.id);
    const viewer = await user("patch-viewer");
    await setRaw("sso_break_glass_user_ids", null);
    const patch = (b: unknown) => ssoRoute.PATCH(as(tok, `${ORIGIN}/api/admin/sso`, body("PATCH", b)));
    try {
      let r = await patch({ sso_only: true, break_glass_user_ids: [] });
      assert.equal(r.status, 409);
      assert.equal((await r.json()).code, "break_glass_required");
      r = await patch({ sso_only: true, break_glass_user_ids: [viewer.id] });
      assert.equal(r.status, 409, "a viewer is not an administrator");
      assert.equal(await db.getSetting("sso_only"), undefined, "nothing was saved");
      r = await patch({ sso_only: true, break_glass_user_ids: [admin.id] });
      assert.equal(r.status, 200);
      assert.equal(await db.getSetting("sso_only"), "1");
      r = await patch({ break_glass_user_ids: [] });
      assert.equal(r.status, 409, "emptying the list while SSO only is on");
      r = await patch({ sso_only: false, break_glass_user_ids: [] });
      assert.equal(r.status, 200, "turning SSO only off is always allowed");
      assert.equal(await db.getSetting("sso_only"), "0");
    } finally {
      await setRaw("sso_only", null);
      await setRaw("sso_break_glass_user_ids", null);
    }
  });

  test("COMPASSDOCS_SSO_ONLY_DISABLED=1 lets every password account sign in again", async () => {
    const plain = await user("hatch");
    ssoOnly = true;
    try {
      assert.deepEqual(await auth.login(plain.username, PW), { refused: "sso_only" });
      process.env.COMPASSDOCS_SSO_ONLY_DISABLED = "1";
      assert.equal((await routing.signInSetup()).ssoOnly, false);
      const ok = await auth.login(plain.username, PW);
      assert.ok(ok && "token" in ok, "signed in with a password");
    } finally {
      ssoOnly = false;
      delete process.env.COMPASSDOCS_SSO_ONLY_DISABLED;
    }
  });
});

describe("M7: a lapsed licence", () => {
  test("only relaxing SSO changes save: SSO only off, the break-glass list, a new secret; the full form with nothing else changed is fine", async () => {
    const admin = await user("lapse-admin", { role: "admin" });
    const tok = await session(admin.id);
    edition.features = edition.features.filter((f) => f !== "sso");
    edition.lapsed = ["sso"];
    await db.setSetting("sso_only", "1");
    await db.setSetting("sso_break_glass_user_ids", JSON.stringify([admin.id]));
    const patch = (b: unknown) => ssoRoute.PATCH(as(tok, `${ORIGIN}/api/admin/sso`, body("PATCH", b)));
    try {
      const view = (await (await ssoRoute.GET()).json()) as Record<string, unknown>;
      assert.equal(view.lapsed, true);
      assert.equal((await patch({ tenant: "contoso.example" })).status, 402);
      assert.equal((await patch({ auto_provision: !view.auto_provision })).status, 402);
      assert.equal((await patch({ client_secret: "a-new-secret" })).status, 200, "a new client secret");
      const form = {
        sso_enabled: view.sso_enabled,
        tenant: view.tenant,
        client_id: view.client_id,
        authority: view.authority,
        auto_provision: view.auto_provision,
        default_role: view.default_role,
        allowed_domains: view.allowed_domains,
        sso_only: true,
        break_glass_user_ids: [admin.id],
      };
      assert.equal((await patch(form)).status, 200, "the whole form, unchanged");
      assert.equal((await patch({ ...form, sso_only: false })).status, 200, "SSO only off");
      assert.equal((await patch({ ...form, sso_only: true })).status, 402, "but not back on");
    } finally {
      edition.features.push("sso");
      edition.lapsed = [];
      for (const k of ["sso_only", "sso_break_glass_user_ids", "sso_client_secret"]) await setRaw(k, null);
    }
  });
});

describe("M1: the sign-in throttle", () => {
  test("the budget is the account's: its username and its email share one", () => {
    const account = 900_000 + seq;
    for (let i = 0; i < 10; i++) guard.beginLoginAttempt("someone", `198.18.40.${i + 1}`, { account, known: false });
    assert.ok(guard.loginRetryAfter("someone@x.test", "198.18.41.1", { account, known: false }) > 0, "the email waits too");
    assert.equal(guard.loginRetryAfter("someone@x.test", "198.18.41.1"), 0, "a typed text's own budget is separate");
    guard.clearIdentifierThrottle(account);
    assert.equal(guard.loginRetryAfter("someone", "198.18.41.1", { account, known: false }), 0);
  });

  test("a known address is never refused by a lock, only slowed, until its queue is 30 seconds long", () => {
    const account = 910_000 + seq;
    const ip = "198.18.50.1";
    // A stranger forging this address spends the pair, the address and the budget…
    const slows: number[] = [];
    let refusedAt = -1;
    for (let i = 0; i < 40; i++) {
      const a = guard.beginLoginAttempt("victim", ip, { account, known: true });
      if (a.wait > 0) {
        refusedAt = i;
        break;
      }
      slows.push(a.slowMs ?? 0);
    }
    assert.deepEqual(slows.slice(0, 6), [0, 0, 0, 0, 0, 0], "the first failures cost nothing");
    assert.ok(slows[7] > 0 && slows[8] > slows[7], `then each waits longer (${slows.slice(5, 10).join(", ")})`);
    assert.ok(refusedAt > 8, `only a queue over 30 s is refused (${refusedAt})`);
    // …and from a stranger's own address the same account is refused at once.
    for (let i = 0; i < 5; i++) guard.beginLoginAttempt("victim", "198.18.51.1", { account, known: false });
    assert.ok(guard.beginLoginAttempt("victim", "198.18.51.1", { account, known: false }).wait > 0);
    guard.clearIdentifierThrottle(account);
    assert.equal(guard.beginLoginAttempt("victim", ip, { account, known: true }).wait, 0, "an administrator's reset clears the queue");
  });

  test("a known address comes from the database: a session or a recorded sign-in in the last 30 days", async () => {
    const u = await user("known");
    assert.equal(await db.knownSignInAddress(u.id, "198.18.60.1"), false);
    await session(u.id, "password", "198.18.60.1");
    assert.equal(await db.knownSignInAddress(u.id, "198.18.60.1"), true, "a session from it");
    await q("INSERT INTO audit_log (actor_id, actor_name, action, ip) VALUES ($1, 'x', 'auth.login', '198.18.60.2')", [u.id]);
    assert.equal(await db.knownSignInAddress(u.id, "198.18.60.2"), true, "a recorded sign-in");
    await q("INSERT INTO audit_log (actor_id, actor_name, action, ip, at) VALUES ($1, 'x', 'auth.login', '198.18.60.3', now() - interval '31 days')", [u.id]);
    assert.equal(await db.knownSignInAddress(u.id, "198.18.60.3"), false, "older than 30 days");
    assert.equal(await db.knownSignInAddress(u.id, "unknown"), false);
  });

  test("the owner signs in from home while a stranger spends the account's budget from everywhere, after a restart", async () => {
    const owner = await user("owner");
    const home = "198.18.70.1";
    // Signed in from home last week: in the database, not in this process's memory.
    await q("INSERT INTO audit_log (actor_id, actor_name, action, ip, at) VALUES ($1, 'x', 'auth.login', $2, now() - interval '7 days')", [owner.id, home]);
    const post = (u: string, p: string, ip: string) => loginRoute.POST(as("", `${ORIGIN}/api/auth/login`, body("POST", { username: u, password: p }, ip)));
    for (let i = 0; i < 12; i++) await post(i % 2 ? owner.username : owner.email, "wrong-password-1", `198.18.71.${i + 1}`);
    assert.equal((await post(owner.email, PW, "198.18.72.1")).status, 429, "a stranger's address waits, whichever name it types");
    // A forged copy of the home address spends its pair lock too…
    for (let i = 0; i < 6; i++) await post(owner.username, "wrong-password-1", home);
    // …and still only slows it.
    assert.equal((await post(owner.username, PW, home)).status, 200, "home signs in");
  });
});

describe("M2: password checks", () => {
  test("at most the limit run at once; a full queue fails at once (PasswordBusyError) and the sign-in answers 503", async () => {
    process.env.COMPASSDOCS_PASSWORD_HASH_CONCURRENCY = "1";
    const u = await user("busy");
    try {
      let peak = 0;
      const watch = setInterval(() => (peak = Math.max(peak, password.passwordHashLoad().running)), 5);
      const flood = Array.from({ length: password.VERIFY_QUEUE_MAX + 8 }, () => password.verifyNothing("x").then(() => "ok", (e: unknown) => e));
      const res = await loginRoute.POST(as("", `${ORIGIN}/api/auth/login`, body("POST", { username: u.username, password: PW }, "198.18.80.1")));
      assert.equal(res.status, 503);
      assert.equal((await res.json()).code, "busy");
      assert.ok(res.headers.get("retry-after"));
      const outcomes = await Promise.all(flood);
      clearInterval(watch);
      const busy = outcomes.filter((o) => o instanceof password.PasswordBusyError).length;
      assert.ok(busy >= 7, `the overflow was refused (${busy})`);
      assert.equal(peak, 1, "never more than the limit at once");
      // Making a hash is never refused, only queued.
      const made = await Promise.all(Array.from({ length: 3 }, () => password.hashPassword("Another-pass-123")));
      assert.equal(made.length, 3);
      // And the queue drained: the sign-in works again.
      const again = await loginRoute.POST(as("", `${ORIGIN}/api/auth/login`, body("POST", { username: u.username, password: PW }, "198.18.80.1")));
      assert.equal(again.status, 200);
    } finally {
      delete process.env.COMPASSDOCS_PASSWORD_HASH_CONCURRENCY;
    }
  });

  test("a legacy hash takes as long to check as a current one (both spend one derivation of each kind)", async () => {
    const legacySalt = "00112233445566778899aabbccddeeff";
    const legacy = scryptSync(PW, legacySalt, 64).toString("hex");
    const current = await password.hashPassword(PW);
    const time = async (fn: () => Promise<unknown>) => {
      const t = process.hrtime.bigint();
      await fn();
      return Number(process.hrtime.bigint() - t) / 1e6;
    };
    await password.verifyPassword(PW, legacy, legacySalt); // warm up
    const l = Math.min(await time(() => password.verifyPassword(PW, legacy, legacySalt)), await time(() => password.verifyPassword(PW, legacy, legacySalt)));
    const c = Math.min(await time(() => password.verifyPassword(PW, current.hash, current.salt)), await time(() => password.verifyPassword(PW, current.hash, current.salt)));
    const n = Math.min(await time(() => password.verifyNothing(PW)), await time(() => password.verifyNothing(PW)));
    assert.ok(l > c * 0.6 && l < c * 1.6, `legacy ${l.toFixed(0)} ms vs current ${c.toFixed(0)} ms`);
    assert.ok(n > c * 0.6 && n < c * 1.6, `unknown account ${n.toFixed(0)} ms vs current ${c.toFixed(0)} ms`);
    assert.equal(await password.verifyPassword(PW, legacy, legacySalt), true, "and it still verifies");
  });
});

describe("M4: links in mail come from the configured address, never the request's Host", () => {
  let author: { id: number; username: string };
  let tok = "";
  let docId = 0;
  before(async () => {
    author = await user("mail-admin", { role: "admin" });
    tok = await session(author.id);
    docId = (await q<{ id: number }>("SELECT id FROM documents ORDER BY id LIMIT 1"))[0].id;
  });

  test("a comment's mention", async () => {
    const target = await user("mentioned", { role: "editor" });
    const post = () =>
      commentsRoute.POST(as(tok, `${ORIGIN}/api/documents/${docId}/comments`, body("POST", { body: "Have a look", mention_ids: [target.id] })), {
        params: Promise.resolve({ id: String(docId) }),
      });
    mentionOrigins.length = 0;
    assert.equal((await post()).status, 201);
    process.env.COMPASSDOCS_BASE_URL = "https://docs.example.test/";
    try {
      assert.equal((await post()).status, 201);
    } finally {
      delete process.env.COMPASSDOCS_BASE_URL;
    }
    assert.deepEqual(mentionOrigins, ["", "https://docs.example.test"], "relative with no address; never phish.example.invalid");
  });

  test("a training assignment", async () => {
    const learner = await user("learner");
    const deck = await q<{ id: number }>("INSERT INTO training_decks (document_id, created_by) VALUES ($1, $2) RETURNING id", [docId, author.id]);
    const post = (who: number) =>
      deckRoute.POST(as(tok, `${ORIGIN}/api/training/decks/${deck[0].id}`, body("POST", { user_ids: [who] })), {
        params: Promise.resolve({ id: String(deck[0].id) }),
      });
    trainingOrigins.length = 0;
    try {
      assert.equal((await post(learner.id)).status, 200);
      process.env.COMPASSDOCS_BASE_URL = "https://docs.example.test";
      const second = await user("learner2");
      assert.equal((await post(second.id)).status, 200);
    } finally {
      delete process.env.COMPASSDOCS_BASE_URL;
      await q("DELETE FROM training_decks WHERE id = $1", [deck[0].id]);
    }
    assert.deepEqual(trainingOrigins, ["", "https://docs.example.test"]);
  });
});

describe("M5: Remove local passwords", () => {
  test("keeps every administrator's password, ends the others' unexchanged connector codes, and the copy count says so", async () => {
    const glass = await user("rm-glass", { role: "admin" });
    const otherAdmin = await user("rm-admin", { role: "admin" });
    const editor = await user("rm-editor", { role: "editor" });
    const tok = await session(glass.id);
    await q("INSERT INTO oauth_clients (client_id, name) VALUES ('r2-client', 'R2')");
    await q("INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at) VALUES ('r2-code', 'r2-client', $1, 'https://x', 'c', now() + interval '10 minutes')", [editor.id]);
    // Only these accounts are in play: everyone else in this database is on the list.
    const others = (await q<{ id: number }>("SELECT id FROM users WHERE NOT (id = ANY($1))", [[otherAdmin.id, editor.id]])).map((r) => r.id);
    await db.setSetting("sso_break_glass_user_ids", JSON.stringify(others.slice(0, 1).concat(glass.id)));
    ssoOnly = true;
    try {
      assert.equal(await db.countLocalPasswords([glass.id, ...others.filter((id) => id !== otherAdmin.id)]), 1, "only the editor");
      const r = await removeRoute.POST(as(tok, `${ORIGIN}/api/admin/sso/remove-passwords`, { method: "POST" }));
      assert.equal(r.status, 200);
      const rows = await q<{ id: number; has: boolean }>("SELECT id, password_hash IS NOT NULL AS has FROM users WHERE id = ANY($1)", [[glass.id, otherAdmin.id, editor.id]]);
      const has = Object.fromEntries(rows.map((x) => [x.id, x.has]));
      assert.equal(has[glass.id], true, "break-glass kept");
      assert.equal(has[otherAdmin.id], true, "another administrator kept: a password is their only way in");
      assert.equal(has[editor.id], false, "the editor's cleared");
      assert.equal((await q("SELECT 1 FROM oauth_codes WHERE code_hash = 'r2-code'")).length, 0, "the unexchanged code is gone");
      assert.deepEqual(
        (await db.adminsOutsideBreakGlass([glass.id])).map((a) => a.id).filter((id) => id === otherAdmin.id),
        [otherAdmin.id],
        "the page names the administrator SSO only keeps out"
      );
    } finally {
      ssoOnly = false;
      await setRaw("sso_break_glass_user_ids", null);
      await q("DELETE FROM oauth_clients WHERE client_id = 'r2-client'");
    }
  });
});

describe("M6 and the break-glass rule: who owes two-step set-up", () => {
  const pendingOf = async (token: string) => {
    currentToken = token;
    return (await auth.currentSession())?.pending ?? null;
  };

  test("a session Duo approved meets Require two-step; one let in because Duo was unreachable does not", async () => {
    const u = await user("duo");
    await db.setSetting("require_two_step", "everyone");
    try {
      const plain = await session(u.id);
      assert.equal(await pendingOf(plain), "two_step");
      const approved = await session(u.id);
      await db.markSessionMfa(approved, "duo");
      assert.equal(await pendingOf(approved), null, "Duo is the second factor");
      const unreachable = await session(u.id);
      await db.markSessionMfa(unreachable, "duo_unreachable");
      assert.equal(await pendingOf(unreachable), "two_step");
    } finally {
      await setRaw("require_two_step", null);
    }
  });

  test("a break-glass account signing in with a password while SSO only is on must set an authenticator up, whatever the rule", async () => {
    const glass = await user("bg-totp", { role: "admin" });
    await db.setSetting("sso_only", "1");
    await db.setSetting("sso_break_glass_user_ids", JSON.stringify([glass.id]));
    ssoOnly = true;
    try {
      const before = await session(glass.id);
      assert.equal(await pendingOf(before), null, "a session opened before is not interrupted");
      const signedIn = await auth.login(glass.username, PW, undefined, { ip: "198.18.90.1" });
      assert.ok(signedIn && "token" in signedIn && signedIn.breakGlass);
      assert.equal(await pendingOf(signedIn.token), "two_step", "the break-glass sign-in owes an authenticator");
      assert.equal(await security.twoStepRequiredFor({ id: glass.id, role: "admin" }), true, "and may not turn it off");
      await q("UPDATE users SET totp_enabled = 1 WHERE id = $1", [glass.id]);
      assert.equal(await pendingOf(signedIn.token), null, "set up: nothing owed");
    } finally {
      ssoOnly = false;
      await setRaw("sso_only", null);
      await setRaw("sso_break_glass_user_ids", null);
    }
  });
});

describe("Lows", () => {
  test("a never-expiring token of an account that owes two-step set-up is refused until it is set up; an expiring one is not", async () => {
    const u = await user("bearer");
    const forever = await db.createApiToken(u.id, "old", ["read", "write"], null);
    const expiring = await db.createApiToken(u.id, "new", ["read", "write"], 30);
    const call = (t: string) => v1.v1Auth(new Request(`${ORIGIN}/api/v1/documents`, { headers: { authorization: `Bearer ${t}` } }), "read");
    await db.setSetting("require_two_step", "everyone");
    try {
      const refused = await call(forever.token);
      assert.ok(refused instanceof Response && refused.status === 403);
      assert.ok(!((await call(expiring.token)) instanceof Response), "an expiring token was made by a session that passed the rule");
      await q("UPDATE users SET totp_enabled = 1 WHERE id = $1", [u.id]);
      assert.ok(!((await call(forever.token)) instanceof Response), "set up: it works again");
      await q("UPDATE users SET totp_enabled = 0, auth_provider = 'oidc' WHERE id = $1", [u.id]);
      assert.ok(!((await call(forever.token)) instanceof Response), "a single sign-on account is not asked");
    } finally {
      await setRaw("require_two_step", null);
    }
  });

  test("a temporary password set before the upgrade gets 72 hours from the upgrade, once", async () => {
    const u = await user("temp");
    await q("UPDATE users SET must_change_password = 1, temp_password_expires_at = NULL WHERE id = $1", [u.id]);
    await setRaw("migration_temp_password_expiry", null);
    await reboot();
    const [row] = await q<{ hours: number }>("SELECT extract(epoch FROM temp_password_expires_at - now()) / 3600 AS hours FROM users WHERE id = $1", [u.id]);
    assert.ok(Number(row.hours) > 71 && Number(row.hours) <= 72, String(row.hours));
    await q("UPDATE users SET temp_password_expires_at = NULL WHERE id = $1", [u.id]);
    await reboot();
    const [again] = await q<{ e: string | null }>("SELECT temp_password_expires_at AS e FROM users WHERE id = $1", [u.id]);
    assert.equal(again.e, null, "the migration ran once");
  });

  test("revoking another account's credentials needs a higher role, unless you are an administrator", async () => {
    const admin = await user("rk-admin", { role: "admin" });
    const approver = await user("rk-approver", { role: "approver" });
    const approver2 = await user("rk-approver2", { role: "approver" });
    const editor = await user("rk-editor", { role: "editor" });
    const actor = (u: { id: number }, role: "admin" | "approver") => ({ id: u.id, role });
    assert.equal(await security.mayRevokeFor(actor(approver, "approver"), editor.id), "ok");
    assert.equal(await security.mayRevokeFor(actor(approver, "approver"), approver2.id), "forbidden", "the same role");
    assert.equal(await security.mayRevokeFor(actor(approver, "approver"), admin.id), "forbidden");
    assert.equal(await security.mayRevokeFor(actor(approver, "approver"), approver.id), "ok", "their own");
    assert.equal(await security.mayRevokeFor(actor(admin, "admin"), approver2.id), "ok");
    assert.equal(await security.mayRevokeFor(actor(admin, "admin"), 987_654_321), "not_found");
  });

  test("the stdout audit mirror never carries what was typed into the sign-in form", () => {
    const { auditLogFields } = require("../src/lib/audit") as typeof import("../src/lib/audit"); // eslint-disable-line @typescript-eslint/no-require-imports
    const f = auditLogFields({ action: "auth.login_failed", actor: { name: "hunter2-Password!" }, targetType: "user", targetLabel: "hunter2-Password!", ip: "198.18.0.1" });
    assert.ok(!JSON.stringify(f).includes("hunter2"), JSON.stringify(f));
    assert.match(String(f.actor_name), /^typed:[0-9a-f]{12}$/);
    assert.equal(f.actor_name, f.target_label, "the same text, the same fingerprint");
    const ok = auditLogFields({ action: "auth.login", actor: { id: 1, name: "Alice" }, ip: "198.18.0.1" });
    assert.equal(ok.actor_name, "Alice", "a signed-in person's name is kept");
  });
});
