// 1.20.27: one-click SCIM provisioning with Microsoft Entra, against the fake
// Microsoft (test/helpers/fake-m365). Nothing here contacts Microsoft.
//
//   - core: the token store (storeScimToken), the card's state
//     (scimAdminStatus: what the setup did, a token rotated since, which
//     kind of app single sign-on uses), the Generate button through it, the
//     audit labels;
//   - the enterprise overlay (skipped when ee/ is not in this checkout, as
//     test/helpdesk-m365-mail.test.ts's one-click tests are):
//       * single sign-on's setup makes its app from the non-gallery template
//         (instantiate, then the OIDC sign-in configured on the
//         application; no POST /applications, no POST /servicePrincipals);
//       * the provisioning setup: the scopes it asks for, the app it makes
//         (hidden from My Apps) or reuses (the single sign-on app when that
//         was made from the template; never an App registrations one), the
//         job from the SCIM template, externalId → objectId, the secrets,
//         Microsoft's connection test reaching the real SCIM endpoint with
//         the new token, start only when asked;
//       * re-runs find the same app and job; the token rotates each run,
//         and only once Entra has the new one;
//       * every failure in words with Microsoft's own text, saying whether
//         the old token still works; another tenant refused before anything;
//       * admins only, the rotation confirmed, unlicensed 402; audited
//         without the token.
//
// It writes the SSO and SCIM settings of the database it runs against and
// puts back what was there.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/scim-setup-microsoft.test.ts

import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeM365, type FakeApp, type FakeM365 } from "./helpers/fake-m365";

process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";

// next/headers (the session cookie, the request's headers) and lib/ee (a licensed Enterprise build).
let currentRequest: Request | null = null;
const edition = { present: true, features: ["sso", "scim"] as string[] };
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.scim-setup.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.scim-setup.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
{
  const jar = () => {
    const out = new Map<string, string>();
    for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
    }
    return out;
  };
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const j = jar();
      return { get: (name: string) => (j.has(name) ? { name, value: j.get(name) } : undefined), getAll: () => [...j].map(([name, value]) => ({ name, value })), has: (name: string) => j.has(name) };
    },
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;
  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = {
    ee: () => edition,
    eePresent: () => edition.present,
    featureEnabled: async (f: string) => edition.features.includes(f),
    featureEnabledFrom: (f: string) => edition.features.includes(f),
  };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as { _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee" || request === "../../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) return EE_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const db = require("../src/lib/db") as typeof import("../src/lib/db");
const scim = require("../src/lib/scim") as typeof import("../src/lib/scim");
const shared = require("../src/lib/scim-setup-shared") as typeof import("../src/lib/scim-setup-shared");
const ssoConfig = require("../src/lib/sso-config") as typeof import("../src/lib/sso-config");
const labels = require("../src/lib/audit-labels") as typeof import("../src/lib/audit-labels");
const { fixtureQuery } = require("./support/retry") as typeof import("./support/retry");
const { newToken } = require("../src/lib/password") as typeof import("../src/lib/password");
const adminScimRoute = require("../src/app/api/admin/scim/route") as typeof import("../src/app/api/admin/scim/route");
const usersRoute = require("../src/app/api/scim/v2/Users/route") as typeof import("../src/app/api/scim/v2/Users/route");
/* eslint-enable @typescript-eslint/no-require-imports */

const { pool, getSetting, createSession } = db;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const STAMP = `scim${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
type Person = { id: number; session: string; name: string };
const U: Record<"admin" | "editor" | "viewer", Person> = {} as never;

// Workspace-wide settings this file changes, put back in after().
const KEYS = [
  "sso_enabled", "sso_tenant", "sso_client_id", "sso_client_secret", "sso_authority", "sso_auto_provision", "sso_default_role",
  "sso_allowed_domains", "sso_only", "sso_vendor", "sso_secret_expires", "sso_app_template",
  "scim_enabled", "scim_token_hash", "scim_token_at", "scim_last_request_at", "scim_entra",
];
let saved: { key: string; value: string }[] = [];
let auditFrom = 0;

function req(url: string, who: Person | null, body?: unknown, method = "POST"): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": "203.0.113.27", origin: "http://localhost", host: "localhost" };
  if (who) headers.cookie = `compass_session=${who.session}`;
  return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(handler: (r: Request) => Promise<Response>, r: Request): Promise<{ status: number; body: any }> {
  currentRequest = r;
  try {
    const res = await handler(r);
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, body: type.includes("json") ? await res.json() : await res.text() };
  } finally {
    currentRequest = null;
  }
}

const audits = async (action: string) =>
  (await pool().query("SELECT details, actor_id FROM audit_log WHERE action = $1 AND id > $2 ORDER BY id", [action, auditFrom])).rows as { details: Record<string, unknown>; actor_id: number }[];

/** The SCIM endpoint as Microsoft's connection test calls it: GET /Users?filter=userName eq "<random>". */
const scimAnswers = async (base: string, token: string) => {
  const filter = encodeURIComponent(`userName eq "${randomUUID()}"`);
  const r = await usersRoute.GET(new Request(`${base}/Users?filter=${filter}`, { headers: { authorization: `Bearer ${token}`, host: "localhost" } }));
  return r.status;
};

before(async () => {
  await getSetting("__schema_bootstrap__");
  saved = (await pool().query("SELECT key, value FROM settings WHERE key = ANY($1)", [KEYS])).rows;
  await pool().query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
  auditFrom = Number((await pool().query("SELECT COALESCE(max(id), 0) AS n FROM audit_log")).rows[0].n);
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  for (const role of ["admin", "editor", "viewer"] as const) {
    const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`, [`${STAMP}-${role}`, `Scim ${role} ${STAMP.slice(-4)}`, `${STAMP}-${role}@example.test`, role]);
    const session = newToken();
    await createSession(session, r.rows[0].id, expires);
    U[role] = { id: r.rows[0].id, session, name: `Scim ${role}` };
  }
});

after(async () => {
  await pool().query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
  for (const s of saved) await pool().query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [s.key, s.value]);
  const ids = Object.values(U).map((u) => u.id);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [ids]).catch(() => {});
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [ids]).catch(() => {});
  await pool().end();
});

// --- Core ---------------------------------------------------------------------------------

describe("core: the token store and the card's state", () => {
  test("storeScimToken makes the token THE token: hash only, endpoint on, the old one refused", async () => {
    const first = scim.newScimToken();
    assert.deepEqual((await scim.storeScimToken(first)).replaced, false);
    assert.equal(await getSetting("scim_token_hash"), sha(first));
    assert.equal(await getSetting("scim_enabled"), "1");
    assert.equal(await scimAnswers("http://localhost/api/scim/v2", first), 200);
    const second = scim.newScimToken();
    const r = await scim.storeScimToken(second);
    assert.equal(r.replaced, true);
    assert.match(r.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(await scimAnswers("http://localhost/api/scim/v2", first), 401);
    assert.equal(await scimAnswers("http://localhost/api/scim/v2", second), 200);
    assert.ok(!(await pool().query("SELECT 1 FROM settings WHERE value LIKE $1", [`%${second}%`])).rowCount, "the raw token is stored nowhere");
  });

  test("the card's state: what the setup did, a token rotated here since, which app single sign-on uses", async () => {
    let s = await scim.scimAdminStatus("http://localhost/api/scim/v2");
    assert.deepEqual([s.entra, s.entra_token_stale, s.sso_app], [null, false, "none"]);
    const at = (await getSetting("scim_token_at"))!;
    await scim.saveScimEntraState({ tenant: "t", sp_id: "s", app_id: "a", display_name: "CompassDocs provisioning", job_id: "scim.1", reused_sso_app: false, base_url: "http://localhost/api/scim/v2", token_at: at, verified: true, started: false, at });
    s = await scim.scimAdminStatus("http://localhost/api/scim/v2");
    assert.equal(s.entra?.display_name, "CompassDocs provisioning");
    assert.equal(s.entra_token_stale, false);
    // The Generate button after the setup: Entra's copy is stale, and the card says so.
    await new Promise((r) => setTimeout(r, 5));
    const gen = await call(adminScimRoute.POST, req("http://localhost/api/admin/scim", U.admin));
    assert.equal(gen.status, 200);
    assert.match(gen.body.token, /^cdscim_/);
    assert.equal(gen.body.entra_token_stale, true);
    assert.equal(gen.body.entra.sp_id, "s");
    // Single sign-on's app: known only when the one-click setup recorded it.
    await ssoConfig.updateSsoConfig({ clientId: "11111111-2222-3333-4444-555555555555" });
    assert.equal((await scim.scimAdminStatus("x")).sso_app, "unknown");
    await scim.recordSsoApp("11111111-2222-3333-4444-555555555555", shared.NON_GALLERY_TEMPLATE_ID);
    assert.equal((await scim.scimAdminStatus("x")).sso_app, "provisioning");
    await scim.recordSsoApp("11111111-2222-3333-4444-555555555555", "");
    assert.equal((await scim.scimAdminStatus("x")).sso_app, "sign_in_only");
    await ssoConfig.updateSsoConfig({ clientId: "99999999-2222-3333-4444-555555555555" });
    assert.equal((await scim.scimAdminStatus("x")).sso_app, "unknown", "a client ID changed by hand since");
    await pool().query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
  });

  test("the admin route's state is the same, for admins only", async () => {
    const get = await call(adminScimRoute.GET, req("http://localhost/api/admin/scim", U.admin, undefined, "GET"));
    assert.equal(get.status, 200);
    assert.deepEqual(Object.keys(get.body).sort(), ["base_url", "enabled", "entra", "entra_token_stale", "last_request_at", "licensed", "sso_app", "token_set"]);
    assert.equal(get.body.base_url, "http://localhost/api/scim/v2");
    for (const who of [U.editor, U.viewer]) {
      assert.equal((await call(adminScimRoute.GET, req("http://localhost/api/admin/scim", who, undefined, "GET"))).status, 403);
      assert.equal((await call(adminScimRoute.POST, req("http://localhost/api/admin/scim", who))).status, 403);
    }
  });

  test("the setup's audit keys have labels; the Entra link names the enterprise app", () => {
    assert.equal(labels.actionLabel("scim.setup_with_microsoft"), "Set up SCIM provisioning with Microsoft");
    assert.equal(labels.actionLabel("scim.setup_with_microsoft_failed"), "Could not set up SCIM provisioning with Microsoft");
    assert.equal(
      shared.entraAppUrl("0f6e5a3c-0000-4000-8000-000000000001", "1a2b3c4d-0000-4000-8000-000000000002"),
      "https://entra.microsoft.com/#view/Microsoft_AAD_IAM/ManagedAppMenuBlade/~/Overview/objectId/0f6e5a3c-0000-4000-8000-000000000001/appId/1a2b3c4d-0000-4000-8000-000000000002"
    );
  });
});

// --- The enterprise overlay ------------------------------------------------------------------

const EE_DIR = path.join(__dirname, "..", "ee");
const HAS_EE = fs.existsSync(path.join(EE_DIR, "scim-setup.ts"));

describe("the one-click setups (enterprise overlay)", { skip: !HAS_EE && "the enterprise overlay is not in this checkout" }, () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let scimSetup: any, ssoSetup: any, enterprise: any;
  let fake: FakeM365;
  const EE = "http://localhost/api/ee";
  const NG = "8adf8e6e-67b2-4cf2-a259-e3dc5476c621";
  const probes: string[] = [];

  const scimStart = (body: unknown, who: Person | null = U.admin) => call((r) => scimSetup.scimSetupHandler("POST", ["start"], r), req(`${EE}/scim/setup/start`, who, body));
  const scimPoll = (id: string, who: Person | null = U.admin) => call((r) => scimSetup.scimSetupHandler("POST", ["poll"], r), req(`${EE}/scim/setup/poll`, who, { setup_id: id }));
  /** Start, one "not yet", then the poll that does the work. */
  const runScim = async (body: unknown = { rotate: true }) => {
    const s = await scimStart(body);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual((await scimPoll(s.body.setup_id)).body, { status: "pending" });
    return scimPoll(s.body.setup_id);
  };
  const runSso = async () => {
    const s = await call((r) => ssoSetup.ssoSetupHandler("POST", ["start"], r), req(`${EE}/sso/setup/start`, U.admin, {}));
    assert.equal(s.status, 200);
    const poll = () => call((r) => ssoSetup.ssoSetupHandler("POST", ["poll"], r), req(`${EE}/sso/setup/poll`, U.admin, { setup_id: s.body.setup_id }));
    assert.deepEqual((await poll()).body, { status: "pending" });
    return poll();
  };
  const step = (r: { body: { steps?: { key: string; status: string; text: string }[] } }, key: string) => r.body.steps?.find((s) => s.key === key);
  const live = () => [...fake.apps.values()].filter((a) => !a.deleted);
  const named = (n: string) => live().filter((a) => a.displayName === n);
  const tokenInEntra = (a: FakeApp) => fake.syncSecrets.get(a.spId)?.find((s) => s.key === "SecretToken")?.value ?? "";
  const n = (m: string | RegExp) => fake.calls(m).length;

  before(async () => {
    fake = await startFakeM365();
    process.env.COMPASSDOCS_SSO_SETUP_LOGIN_BASE = `${fake.base}/login`;
    process.env.COMPASSDOCS_SSO_SETUP_GRAPH_BASE = `${fake.base}/graph`;
    /* eslint-disable @typescript-eslint/no-require-imports */
    scimSetup = require("../ee/scim-setup");
    ssoSetup = require("../ee/sso-setup");
    enterprise = require("../ee/index").default;
    /* eslint-enable @typescript-eslint/no-require-imports */
    // Microsoft's connection test reaches the real SCIM endpoint with what was saved in Entra.
    fake.scimProbe = async (base, token) => {
      probes.push(base);
      const status = await scimAnswers(base, token);
      return { ok: status === 200, message: `HTTP ${status}` };
    };
    await pool().query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
  });

  after(async () => {
    delete process.env.COMPASSDOCS_SSO_SETUP_LOGIN_BASE;
    delete process.env.COMPASSDOCS_SSO_SETUP_GRAPH_BASE;
    await fake.close();
  });

  test("permissions: no session 401, editors and viewers 403, unlicensed 402; nothing reaches Microsoft", async () => {
    const before = fake.deviceScopes.length;
    assert.equal((await scimStart({ rotate: true }, null)).status, 401);
    for (const who of [U.editor, U.viewer]) {
      assert.equal((await scimStart({ rotate: true }, who)).status, 403);
      assert.equal((await scimPoll("whatever", who)).status, 403);
    }
    // The dispatcher's licence gate (this database has no licence granting SCIM).
    const unlicensed = await call((r) => enterprise.dispatch("POST", ["scim", "setup", "start"], r), req(`${EE}/scim/setup/start`, U.admin, { rotate: true }));
    assert.deepEqual([unlicensed.status, unlicensed.body.error], [402, "SCIM is not included in your license."]);
    assert.equal(fake.deviceScopes.length, before);
    assert.equal((await scimPoll("whatever")).status, 410);
  });

  test("single sign-on's setup makes its app from the non-gallery template and configures OIDC sign-in on it", async () => {
    fake.replicationLag = 2; // Microsoft has not finished making the app for its first two calls
    const r = await runSso();
    fake.replicationLag = 0;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(fake.deviceScopes.at(-1), "https://graph.microsoft.com/Application.ReadWrite.All openid profile", "the same scope as before 1.20.27");
    assert.equal(n("POST /graph/v1.0/applications "), 0, "no app registration made with POST /applications");
    assert.equal(n(/^POST \/graph\/v1\.0\/servicePrincipals \d/), 0, "the template made the service principal");
    assert.equal(n(`POST /graph/v1.0/applicationTemplates/${NG}/instantiate 201`), 1);
    assert.equal(n(/ 404$/), 2, "the two not-yet answers were waited out");
    const [app] = named("CompassDocs");
    assert.ok(app);
    assert.equal(app.templateId, NG);
    assert.deepEqual(app.web?.redirectUris, ["http://localhost/api/ee/sso/callback"]);
    assert.match(String(app.web?.homePageUrl), /customappsso/, "what the template set on the web platform is kept");
    assert.ok(!("redirectUriSettings" in (app.web ?? {})));
    assert.equal(app.signInAudience, "AzureADMyOrg");
    assert.equal(app.appRoleAssignmentRequired, false, "sign-in open to the tenant, as before");
    assert.equal(app.secrets.length, 1);
    assert.deepEqual([r.body.status, r.body.client_id, r.body.provisioning_capable], ["done", app.appId, true]);
    const cfg = await ssoConfig.getSsoConfig();
    assert.deepEqual([cfg.enabled, cfg.tenant, cfg.clientId, cfg.clientSecret], [true, fake.tenantId, app.appId, app.secrets[0]]);
    assert.match((await getSetting("sso_secret_expires")) ?? "", /^\d{4}-\d{2}-\d{2}$/);
    assert.equal((await scim.scimAdminStatus("x")).sso_app, "provisioning");
    const a = (await audits("settings.sso_auto_setup")).at(-1)!;
    assert.deepEqual(a.details, { tenant: fake.tenantId, client_id: app.appId, provisioning_capable: true });
  });

  test("provisioning reuses that single sign-on app: one app for sign-on and provisioning", async () => {
    const sso = named("CompassDocs")[0];
    const instantiated = n("/instantiate 201");
    const r = await runScim({ rotate: true, start: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(n("/instantiate 201"), instantiated, "no new app");
    assert.deepEqual([r.body.sp_id, r.body.app_id, r.body.display_name, r.body.reused_sso_app, r.body.made_app], [sso.spId, sso.appId, "CompassDocs", true, false]);
    assert.match(step(r, "app")!.text, /Found your single sign-on app "CompassDocs"\. It was made from Microsoft's non-gallery template, so it carries provisioning too\./);
    assert.ok(!step(r, "hide"), "a sign-in app is never hidden from My Apps");
    assert.ok(fake.syncJobs.get(sso.spId), "the job is on the single sign-on app");
    assert.equal(fake.deviceScopes.at(-1), "https://graph.microsoft.com/Application.ReadWrite.All https://graph.microsoft.com/Synchronization.ReadWrite.All openid profile");
    assert.equal(tokenInEntra(sso).length > 20, true);
    assert.equal(await getSetting("scim_token_hash"), sha(tokenInEntra(sso)));
  });

  test("an App registrations app (single sign-on before 1.20.27) is never used: provisioning gets its own, hidden from My Apps", async () => {
    // Start over: no setup recorded, the single sign-on app an old-style one.
    await pool().query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
    for (const a of live()) a.deleted = true;
    fake.syncJobs.clear();
    const old = fake.addApp({ displayName: "CompassDocs", templateId: null });
    await ssoConfig.updateSsoConfig({ tenant: fake.tenantId, clientId: old.appId, clientSecret: old.secrets[0], enabled: true });
    fake.replicationLag = 2;
    const r = await runScim({ rotate: true });
    fake.replicationLag = 0;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(
      r.body.steps.map((s: { key: string; status: string }) => `${s.key}:${s.status}`),
      ["signin:done", "sso_app:skipped", "app:done", "hide:done", "job:done", "mapping:done", "secrets:done", "token:done", "validate:done", "start:skipped"]
    );
    assert.match(step(r, "sso_app")!.text, /Your single sign-on app "CompassDocs" was made in App registrations .*Sign-on and provisioning are two apps in Entra\./);
    assert.ok(!fake.syncJobs.has(old.spId), "nothing was tried on the App registrations app");
    const [made] = named("CompassDocs provisioning");
    assert.ok(made, "made from the template");
    assert.equal(made.templateId, NG);
    assert.ok(made.spTags?.includes("HideApp"));
    assert.ok(made.spTags?.includes("WindowsAzureActiveDirectoryIntegratedApp"), "the template's own tags are kept");
    assert.deepEqual([r.body.made_app, r.body.reused_sso_app, r.body.verified, r.body.started], [true, false, true, false]);
    assert.equal(r.body.entra_url, shared.entraAppUrl(made.spId, made.appId));

    const job = fake.syncJobs.get(made.spId)!;
    assert.match(job.id, /^scim\./, "made from the SCIM template Entra lists");
    assert.equal(job.status, "NotConfigured", "not started: Start provisioning now was not ticked");
    assert.match(step(r, "start")!.text, /Not started \(Start provisioning now was not ticked\)/);
    // externalId ← objectId on users; groups (already objectId) untouched; the schema went back whole.
    const rules = (job.schema as { synchronizationRules: { objectMappings: { sourceObjectName: string; attributeMappings: { targetAttributeName: string; source: { name: string; expression: string } }[] }[] }[] }).synchronizationRules;
    const users = rules[0].objectMappings.find((o) => o.sourceObjectName === "User")!;
    assert.deepEqual(users.attributeMappings.find((m) => m.targetAttributeName === "externalId")!.source, { expression: "[objectId]", name: "objectId", parameters: [], type: "Attribute" });
    assert.equal(users.attributeMappings.find((m) => m.targetAttributeName === "userName")!.source.name, "userPrincipalName");
    assert.equal(users.attributeMappings.length, 5);
    assert.ok(!("@odata.context" in job.schema));
    // The secrets: this workspace's Tenant URL, and the token that is now THE token here.
    const secrets = fake.syncSecrets.get(made.spId)!;
    assert.deepEqual(secrets.map((s) => s.key), ["BaseAddress", "SecretToken"]);
    assert.equal(secrets[0].value, "http://localhost/api/scim/v2");
    assert.equal(r.body.base_url, "http://localhost/api/scim/v2");
    assert.equal(probes.at(-1), "http://localhost/api/scim/v2", "Microsoft's test called the SCIM endpoint");
    assert.equal(await getSetting("scim_token_hash"), sha(tokenInEntra(made)));
    assert.equal(await getSetting("scim_enabled"), "1");
    assert.equal(await scimAnswers("http://localhost/api/scim/v2", tokenInEntra(made)), 200);
    // Never the token in the answer, the state or the audit.
    const token = tokenInEntra(made);
    assert.ok(!JSON.stringify(r.body).includes(token));
    assert.ok(!(await pool().query("SELECT 1 FROM settings WHERE value LIKE $1", [`%${token}%`])).rowCount);
    assert.ok(!(await pool().query("SELECT 1 FROM audit_log WHERE details::text LIKE $1", [`%${token}%`])).rowCount);
    const a = (await audits("scim.setup_with_microsoft")).at(-1)!;
    assert.equal(a.actor_id, U.admin.id);
    assert.deepEqual(a.details, {
      tenant: fake.tenantId, app: "CompassDocs provisioning", app_id: made.appId, sp_id: made.spId, job_id: job.id,
      made_app: true, reused_sso_app: false, mapping: "done", token_rotated: true, verified: true, started: false, start_asked: false,
    });
    assert.deepEqual((await audits("scim.token_generated")).at(-1)!.details, { via: "setup_with_microsoft" });
    const state = (await scim.getScimEntraState())!;
    assert.deepEqual([state.sp_id, state.job_id, state.verified, state.started, state.token_at], [made.spId, job.id, true, false, await getSetting("scim_token_at")]);
  });

  test("run again with Start provisioning now: the same app and job, a new token (the old one stops), provisioning started", async () => {
    const [made] = named("CompassDocs provisioning");
    const oldToken = tokenInEntra(made);
    const counts = [n("/instantiate 201"), n("POST /graph/v1.0/servicePrincipals/" + made.spId + "/synchronization/jobs 201"), n("PUT /graph/v1.0/servicePrincipals/" + made.spId + "/synchronization/jobs/")];
    // A token is set: the start must say the rotation was confirmed.
    const refused = await scimStart({ start: true });
    assert.deepEqual([refused.status, refused.body.code], [409, "confirm_rotate"]);
    assert.match(refused.body.error, /makes a new secret token, and the current one stops working/);
    const r = await runScim({ rotate: true, start: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([n("/instantiate 201"), n("POST /graph/v1.0/servicePrincipals/" + made.spId + "/synchronization/jobs 201"), n("PUT /graph/v1.0/servicePrincipals/" + made.spId + "/synchronization/jobs/")], counts, "nothing made twice, the schema left alone");
    assert.ok(!fake.log.includes("! second provisioning job asked for"));
    assert.equal(named("CompassDocs provisioning").length, 1);
    assert.match(step(r, "app")!.text, /Found the enterprise app "CompassDocs provisioning" this setup used before\./);
    assert.match(step(r, "job")!.text, /Found its provisioning job \(not started yet\)\./);
    assert.deepEqual(step(r, "mapping"), { key: "mapping", status: "done", text: "externalId is already mapped to objectId." });
    assert.match(step(r, "token")!.text, /^Rotated the CompassDocs secret token: the previous one stopped working/);
    assert.notEqual(tokenInEntra(made), oldToken);
    assert.equal(await scimAnswers("http://localhost/api/scim/v2", oldToken), 401);
    assert.equal(await scimAnswers("http://localhost/api/scim/v2", tokenInEntra(made)), 200);
    assert.equal(fake.syncJobs.get(made.spId)!.status, "Active");
    assert.deepEqual([r.body.started, step(r, "start")!.status], [true, "done"]);
    assert.equal((await audits("scim.setup_with_microsoft")).at(-1)!.details.started, true);
    // A third run finds it running and leaves it be.
    const again = await runScim({ rotate: true, start: true });
    assert.equal(again.status, 200);
    assert.match(step(again, "start")!.text, /already running; it goes on with the new token/);
    assert.equal(n(/\/start 204$/), 1, "start was not called again on a running job");
  });

  test("the setup's record is lost: it finds the app by name rather than making a second", async () => {
    await pool().query("DELETE FROM settings WHERE key = $1", [scim.SCIM_ENTRA_KEY]);
    const made = n("/instantiate 201");
    const r = await runScim({ rotate: true });
    assert.equal(r.status, 200);
    assert.equal(n("/instantiate 201"), made);
    assert.match(step(r, "app")!.text, /Found the enterprise app "CompassDocs provisioning", made from Microsoft's non-gallery template\./);
  });

  test("Microsoft refuses the secrets: stopped in words, nothing changed here, the current token still works", async () => {
    const [app] = named("CompassDocs provisioning");
    const hash = await getSetting("scim_token_hash");
    const working = tokenInEntra(app);
    fake.failStep = "secrets";
    const r = await runScim({ rotate: true, start: true });
    fake.failStep = "";
    assert.equal(r.status, 502);
    assert.equal(
      r.body.error,
      "Microsoft did not save the Tenant URL and the new secret token: The secret token could not be saved for this application. Nothing was changed in CompassDocs: the current secret token still works."
    );
    assert.equal(r.body.token_rotated, false);
    assert.deepEqual(step(r, "secrets")?.status, "failed");
    assert.deepEqual(r.body.steps.map((s: { key: string }) => s.key).slice(-1), ["secrets"]);
    assert.equal(await getSetting("scim_token_hash"), hash);
    assert.equal(await scimAnswers("http://localhost/api/scim/v2", working), 200);
    const f = (await audits("scim.setup_with_microsoft_failed")).at(-1)!;
    assert.deepEqual([f.details.step, f.details.token_rotated, f.details.sp_id], ["secrets", false, app.spId]);
  });

  test("Microsoft cannot reach CompassDocs: the new token is saved in both places, not started, and the admin is told why", async () => {
    const [app] = named("CompassDocs provisioning");
    fake.syncJobs.get(app.spId)!.status = "Paused";
    fake.scimProbe = async () => ({ ok: false, message: "connection timed out" });
    const r = await runScim({ rotate: true, start: true });
    fake.scimProbe = async (base, token) => ({ ok: (await scimAnswers(base, token)) === 200, message: "" });
    assert.equal(r.status, 502);
    assert.match(
      r.body.error,
      /^Microsoft could not connect to CompassDocs at http:\/\/localhost\/api\/scim\/v2: We received this unexpected response from your application: connection timed out\. Entra calls only https addresses\. The Tenant URL and the new token are saved in Entra; once Microsoft can reach this address from the internet, run the setup again or use Test Connection in Entra\.$/
    );
    assert.equal(r.body.token_rotated, true);
    assert.equal(await getSetting("scim_token_hash"), sha(tokenInEntra(app)), "the token Entra holds is THE token");
    assert.equal(fake.syncJobs.get(app.spId)!.status, "Paused", "never started on a failed test");
    assert.ok(!step(r, "start"));
    const state = (await scim.getScimEntraState())!;
    assert.deepEqual([state.verified, state.started], [false, false]);
    // Microsoft's wrapped wording ({"Message": …} inside error.message) comes out as plain words.
    fake.failStep = "validate";
    const w = await runScim({ rotate: true });
    fake.failStep = "";
    assert.match(w.body.error, /: You appear to have entered invalid credentials\. Please confirm you are using the correct information for an administrative account\. /);
    assert.ok(!w.body.error.includes('"Code"'));
  });

  test("start refused, mapping unreadable: the first stops with words, the second only warns", async () => {
    const [app] = named("CompassDocs provisioning");
    fake.failStep = "start";
    const r = await runScim({ rotate: true, start: true });
    assert.equal(r.status, 502);
    assert.equal(r.body.error, "Everything is set up and tested, but Microsoft did not start provisioning: The signed-in user is not allowed to start provisioning for this application. Start it in Entra under Provisioning.");
    assert.equal((await scim.getScimEntraState())!.verified, true);
    fake.failStep = "schema";
    const w = await runScim({ rotate: true, start: true });
    fake.failStep = "";
    assert.equal(w.status, 200);
    assert.equal(step(w, "mapping")!.status, "warning");
    assert.match(step(w, "mapping")!.text, /^Could not change the externalId mapping \(The schema could not be read right now\.\) Map externalId to objectId by hand/);
    assert.equal(fake.syncJobs.get(app.spId)!.status, "Active");
  });

  test("a mapping someone changed is left as it is", async () => {
    const [app] = named("CompassDocs provisioning");
    const job = fake.syncJobs.get(app.spId)!;
    const users = (job.schema as any).synchronizationRules[0].objectMappings[0].attributeMappings; // eslint-disable-line @typescript-eslint/no-explicit-any
    users.find((m: { targetAttributeName: string }) => m.targetAttributeName === "externalId").source = { expression: "[employeeId]", name: "employeeId", parameters: [], type: "Attribute" };
    const r = await runScim({ rotate: true });
    assert.equal(r.status, 200);
    assert.deepEqual(step(r, "mapping"), { key: "mapping", status: "skipped", text: "Left externalId mapped to [employeeId]: someone changed it from Microsoft's default, so it stays." });
  });

  test("failures before anything exists: Microsoft refuses the app or the job, in its own words", async () => {
    await pool().query("DELETE FROM settings WHERE key = $1", [scim.SCIM_ENTRA_KEY]);
    for (const a of named("CompassDocs provisioning")) a.deleted = true;
    const hash = await getSetting("scim_token_hash");
    fake.failStep = "instantiate";
    const a = await runScim({ rotate: true });
    assert.equal(a.status, 502);
    assert.equal(a.body.error, 'Microsoft did not make the enterprise app "CompassDocs provisioning": Insufficient privileges to complete the operation.');
    assert.equal(named("CompassDocs provisioning").length, 0);
    fake.failStep = "jobs";
    const j = await runScim({ rotate: true });
    fake.failStep = "";
    assert.equal(j.status, 502);
    assert.equal(j.body.error, "Microsoft did not make the provisioning job: The signed-in user is not allowed to configure provisioning for this application. Nothing was changed in CompassDocs: the current secret token still works.");
    assert.deepEqual(j.body.steps.map((s: { key: string; status: string }) => `${s.key}:${s.status}`), ["signin:done", "sso_app:skipped", "app:done", "hide:done", "job:failed"]);
    assert.equal(await getSetting("scim_token_hash"), hash, "the token was never touched");
    // The re-run picks up the app the failed run made, rather than making another.
    const ok = await runScim({ rotate: true });
    assert.equal(ok.status, 200);
    assert.equal(named("CompassDocs provisioning").length, 1);
    assert.match(step(ok, "app")!.text, /made from Microsoft's non-gallery template\.$/);
  });

  test("another tenant than single sign-on's, or than the last setup's: refused before anything is asked of Entra", async () => {
    const graphCalls = n("/graph/");
    const hash = await getSetting("scim_token_hash");
    fake.deviceTenant = "11111111-aaaa-bbbb-cccc-222222222222";
    const r = await runScim({ rotate: true });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /^You signed in to a different Microsoft Entra tenant than the one single sign-on uses, so nothing was changed\./);
    await ssoConfig.updateSsoConfig({ tenant: "contoso.example" }); // a domain, not a tenant ID: no comparison
    const p = await runScim({ rotate: true });
    assert.match(p.body.error, /^You signed in to a different Microsoft Entra tenant than the one provisioning was set up in, so nothing was changed\./);
    fake.deviceTenant = fake.tenantId;
    await ssoConfig.updateSsoConfig({ tenant: fake.tenantId });
    assert.equal(n("/graph/"), graphCalls);
    assert.equal(await getSetting("scim_token_hash"), hash);
  });

  test("no token yet: no confirmation needed, and the step says it was made rather than rotated", async () => {
    await pool().query("DELETE FROM settings WHERE key = ANY($1)", [["scim_token_hash", "scim_enabled", "scim_token_at"]]);
    const r = await runScim({});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(step(r, "token")!.text, "Made the CompassDocs secret token and turned SCIM provisioning on.");
  });
});
