// 1.20.31: the workspace's outgoing email through Microsoft 365, against the
// fake Microsoft (test/helpers/fake-m365). Nothing here contacts Microsoft.
//
//   - pure: the lock-down commands (access policy, RBAC for Applications) and
//     their quoting, From and Reply-To for a chosen sender, the secret's end,
//     the form's checks, Microsoft's refusals in plain words;
//   - the configuration: SMTP stays the default; a save signs in first and
//     refuses with Microsoft's reason in plain words (wrong or expired
//     secret, unknown app); the secret is sealed and never in the view; what
//     the token says (Entra's Mail.Send, the object ID) is kept; audited
//     (saved, secret replaced, method changed, test sent);
//   - choosing the method: refused while it is not set up; `use` after a
//     good save; back to SMTP keeps both configurations;
//   - sending: MIME through Graph as the mailbox, attachments, a chosen
//     sender as Reply-To, the size limit (nothing sent), 429 waited out,
//     refusals in words (not allowed, an access policy, no such mailbox),
//     the helpdesk's transport (a refused From reads as an SMTP 550);
//   - the connection check and the diagnostics row: sign-in plus "may send
//     as", sending nothing; the secret's end as warn / fail;
//   - the API: permissions, the test email by the method on screen;
//   - the enterprise overlay's Set up with Microsoft (skipped when ee/ is
//     not in this checkout): scopes, the app with Mail.Send only and its
//     consent, the saved configuration, a second run reusing the app,
//     failures undone.
//
// The workspace's mail configuration is this file's alone while it runs
// (test/support/mail-lock, exclusive); what it changes is put back.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/workspace-mail-m365.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lockWorkspaceMail, type WorkspaceMailLock } from "./support/mail-lock";
import { GRAPH_SP_ID, MAIL_SEND_ROLE_ID, startFakeM365, type FakeApp, type FakeM365 } from "./helpers/fake-m365";

process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";

// --- Request scope and edition stubs (as test/scim-setup-microsoft.test.ts) -------------

let currentRequest: Request | null = null;
let licensed = true;
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.workspace-mail.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.workspace-mail.virtual.js");
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
    ee: () => ({ present: true, features: [] }),
    eePresent: () => true,
    enterpriseLicensed: async () => licensed,
    featureEnabled: async () => false,
    featureEnforced: async () => false,
    featureEnabledFrom: () => false,
    featureEnforcedFrom: () => false,
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
const shared = require("../src/lib/mail-m365-shared") as typeof import("../src/lib/mail-m365-shared");
const errors = require("../src/lib/mail-m365-errors") as typeof import("../src/lib/mail-m365-errors");
const config = require("../src/lib/mail-config") as typeof import("../src/lib/mail-config");
const send = require("../src/lib/mail-m365") as typeof import("../src/lib/mail-m365");
const mailer = require("../src/lib/mailer") as typeof import("../src/lib/mailer");
const graphLib = require("../src/lib/helpdesk/m365/graph") as typeof import("../src/lib/helpdesk/m365/graph");
const diagnostics = require("../src/lib/diagnostics") as typeof import("../src/lib/diagnostics");
const delivery = require("../src/lib/newsletter-delivery") as typeof import("../src/lib/newsletter-delivery");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const labels = require("../src/lib/audit-labels") as typeof import("../src/lib/audit-labels");
const mailRoute = require("../src/app/api/admin/mail/route") as typeof import("../src/app/api/admin/mail/route");
const { fixtureQuery } = require("./support/retry") as typeof import("./support/retry");
const { newToken } = require("../src/lib/password") as typeof import("../src/lib/password");
/* eslint-enable @typescript-eslint/no-require-imports */

const { pool, getSetting, setSetting, createSession } = db;
const STAMP = `wm${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const MAILBOX = `compassdocs@${STAMP}.example.test`;
const OTHER = `ceo@${STAMP}.example.test`;
type Person = { id: number; session: string; name: string };
const U: Record<"admin" | "viewer", Person> = {} as never;
const API = "http://localhost/api/admin/mail";
const SMTP_KEYS = ["smtp_host", "smtp_port", "smtp_secure", "smtp_user", "smtp_pass", "smtp_from"];
const KEYS = [...config.MAIL_CONFIG_KEYS, ...SMTP_KEYS];
let saved: { key: string; value: string }[] = [];
let auditFrom = 0;
let fake: FakeM365;
let app: FakeApp;
let mailLock: WorkspaceMailLock | null = null;

function req(url: string, who: Person | null, body?: unknown, method = "PATCH"): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": "203.0.113.31", origin: "http://localhost", host: "localhost" };
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
const patch = (body: unknown, who: Person | null = U.admin) => call(mailRoute.PATCH, req(API, who, body));
const view = (who: Person | null = U.admin) => call(mailRoute.GET, req(API, who, undefined, "GET"));
const audits = async (action: string) =>
  (await pool().query("SELECT details, actor_id FROM audit_log WHERE action = $1 AND id > $2 ORDER BY id", [action, auditFrom])).rows as { details: Record<string, unknown>; actor_id: number }[];
const by = () => ({ actor: { id: U.admin.id, name: U.admin.name, role: "admin" as const } });
const manual = (over: Record<string, unknown> = {}) => ({ action: "m365", tenant: app.tenant, client_id: app.appId, secret: app.secrets[0], mailbox: MAILBOX, ...over });
const sentText = (i = -1) => fake.mailboxes.get(MAILBOX)!.sent.at(i)!.toString("utf8");

before(async () => {
  await getSetting("__schema_bootstrap__");
  mailLock = await lockWorkspaceMail("exclusive");
  saved = (await pool().query("SELECT key, value FROM settings WHERE key = ANY($1)", [KEYS])).rows;
  await pool().query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
  auditFrom = Number((await pool().query("SELECT COALESCE(max(id), 0) AS n FROM audit_log")).rows[0].n);
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  for (const role of ["admin", "viewer"] as const) {
    const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`, [`${STAMP}-${role}`, `Mail ${role}`, `${STAMP}-${role}@example.test`, role]);
    const session = newToken();
    await createSession(session, r.rows[0].id, expires);
    U[role] = { id: r.rows[0].id, session, name: `Mail ${role}` };
  }
  fake = await startFakeM365();
  process.env.COMPASSDOCS_M365_MAIL_TEST_BASE = fake.base;
  process.env.COMPASSDOCS_SSO_SETUP_LOGIN_BASE = `${fake.base}/login`;
  process.env.COMPASSDOCS_SSO_SETUP_GRAPH_BASE = `${fake.base}/graph`;
  fake.addMailbox(MAILBOX, "shared");
  fake.addMailbox(OTHER, "user");
  // An app registration made by hand, with Mail.Send granted in Entra.
  app = fake.addApp({ displayName: "Hand-made mail app", roles: ["Mail.Send"] });
  send.setM365RetryWaitForTests(async () => {});
});

after(async () => {
  send.setM365RetryWaitForTests(null);
  graphLib.clearM365TokensForTests();
  await pool().query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
  for (const s of saved) await pool().query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [s.key, s.value]);
  const ids = Object.values(U).map((u) => u.id);
  await pool().query("DELETE FROM audit_log WHERE id > $1 AND action LIKE 'settings.mail%'", [auditFrom]).catch(() => {});
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [ids]).catch(() => {});
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [ids]).catch(() => {});
  delete process.env.COMPASSDOCS_M365_MAIL_TEST_BASE;
  delete process.env.COMPASSDOCS_SSO_SETUP_LOGIN_BASE;
  delete process.env.COMPASSDOCS_SSO_SETUP_GRAPH_BASE;
  await mailLock?.release(email);
  await fake.close();
  await pool().end();
});

// --- Pure ------------------------------------------------------------------------------------

describe("pure: commands, From, the secret's end, words", () => {
  test("the access policy commands name the group, the app and the mailbox, each a single-quoted literal", () => {
    const c = shared.accessPolicyCommands({ clientId: "AAAAAAAA-1111-2222-3333-444444444444", mailbox: "CompassDocs@Firm.com" })!;
    assert.equal(
      c,
      [
        "Connect-ExchangeOnline",
        "New-DistributionGroup -Name 'CompassDocs sending mailbox aaaaaaaa' -Alias 'compassdocs-mail-aaaaaaaa' -Type Security -Members 'compassdocs@firm.com'",
        "Set-DistributionGroup -Identity 'CompassDocs sending mailbox aaaaaaaa' -HiddenFromAddressListsEnabled $true",
        "New-ApplicationAccessPolicy -AppId 'aaaaaaaa-1111-2222-3333-444444444444' -PolicyScopeGroupId 'CompassDocs sending mailbox aaaaaaaa' -AccessRight RestrictAccess -Description 'CompassDocs sending mailbox aaaaaaaa'",
        "Test-ApplicationAccessPolicy -Identity 'compassdocs@firm.com' -AppId 'aaaaaaaa-1111-2222-3333-444444444444'",
      ].join("\n")
    );
    // An apostrophe is doubled inside the literal; anything a shell gives meaning to is never accepted at all.
    assert.match(shared.accessPolicyCommands({ clientId: "aaaaaaaa-1111-2222-3333-444444444444", mailbox: "o'brien@firm.com" })!, /-Members 'o''brien@firm\.com'/);
    for (const bad of ["a;b@firm.com", "$(evil)@firm.com", "a b@firm.com", "a`b@firm.com", "a\"b@firm.com", "help+tag@firm.com"]) {
      assert.equal(shared.accessPolicyCommands({ clientId: "aaaaaaaa-1111-2222-3333-444444444444", mailbox: bad }), null, bad);
    }
    assert.equal(shared.accessPolicyCommands({ clientId: "not-a-guid", mailbox: "a@firm.com" }), null);
    assert.equal(
      shared.accessPolicyUpdateCommands({ clientId: "aaaaaaaa-1111-2222-3333-444444444444", mailbox: "new@firm.com" }),
      "Connect-ExchangeOnline\nUpdate-DistributionGroupMember -Identity 'CompassDocs sending mailbox aaaaaaaa' -Members 'new@firm.com' -Confirm:$false"
    );
  });

  test("RBAC for Applications: the service principal, a scope naming the one mailbox, the Application Mail.Send role, the check", () => {
    const c = shared.rbacCommands({ clientId: "aaaaaaaa-1111-2222-3333-444444444444", spObjectId: "bbbbbbbb-1111-2222-3333-444444444444", mailbox: "compassdocs@firm.com" })!;
    assert.match(c, /^Connect-ExchangeOnline\nNew-ServicePrincipal -AppId 'aaaaaaaa-1111-2222-3333-444444444444' -ObjectId 'bbbbbbbb-1111-2222-3333-444444444444' -DisplayName 'CompassDocs Workspace Mail'\n/);
    assert.match(c, /New-ManagementScope -Name 'CompassDocs sending mailbox aaaaaaaa' -RecipientRestrictionFilter 'EmailAddresses -eq ''compassdocs@firm\.com'''/);
    assert.match(c, /New-ManagementRoleAssignment -Name 'CompassDocs workspace Mail\.Send aaaaaaaa' -App 'bbbbbbbb-1111-2222-3333-444444444444' -Role 'Application Mail\.Send' -CustomResourceScope 'CompassDocs sending mailbox aaaaaaaa'/);
    assert.match(c, /Test-ServicePrincipalAuthorization -Identity 'bbbbbbbb-[^']+' -Resource 'compassdocs@firm\.com'/);
    assert.equal(shared.rbacCommands({ clientId: "aaaaaaaa-1111-2222-3333-444444444444", spObjectId: "", mailbox: "compassdocs@firm.com" }), null, "not before the object ID is known");
  });

  test("From is always the mailbox; another chosen sender becomes Reply-To under its own name", () => {
    assert.deepEqual(shared.m365FromFor("mail@firm.com", ""), { from: "mail@firm.com" });
    assert.deepEqual(shared.m365FromFor("mail@firm.com", "Firm Docs"), { from: '"Firm Docs" <mail@firm.com>' });
    assert.deepEqual(shared.m365FromFor("mail@firm.com", "Firm Docs", "HR Team <hr@firm.com>"), { from: '"HR Team" <mail@firm.com>', replyTo: '"HR Team" <hr@firm.com>' });
    assert.deepEqual(shared.m365FromFor("mail@firm.com", "Firm Docs", "hr@firm.com"), { from: '"Firm Docs" <mail@firm.com>', replyTo: "hr@firm.com" });
    assert.deepEqual(shared.m365FromFor("mail@firm.com", "Firm Docs", "Weekly <MAIL@firm.com>"), { from: '"Weekly" <mail@firm.com>' }, "the mailbox itself: no Reply-To");
    // Nothing a header could be split with gets through, in From or in Reply-To.
    for (const evil of ['Evil "\r\nBcc: x@y <hr@firm.com>', "HR\r\nBcc: x@y.example <hr@firm.com>", "a@b.example, c@d.example"]) {
      const w = shared.m365FromFor("mail@firm.com", "", evil);
      assert.ok(!/[\r\n]/.test(w.from + (w.replyTo ?? "")), evil);
      assert.ok(!(w.replyTo ?? "").includes(","), evil);
    }
  });

  test("the secret's end: ok, soon (30 days), expired; and the sentence", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    assert.deepEqual(shared.secretExpiry("", now), { state: "unknown" });
    assert.equal(shared.secretExpiry("2027-06-01", now).state, "ok");
    assert.deepEqual(shared.secretExpiry("2026-12-10", now), { state: "soon", days: 23, date: "2026-12-10" });
    assert.equal(shared.secretExpiry("2026-11-17", now).state, "expired");
    assert.equal(shared.secretExpirySentence("2027-06-01", now), "");
    assert.match(shared.secretExpirySentence("2026-12-10", now), /^The client secret expires on 2026-12-10 \(in 23 days\)\. Create a new secret/);
    assert.match(shared.secretExpirySentence("2026-11-17", now), /^The client secret expired on 2026-11-17\./);
  });

  test("the form's checks", () => {
    const ok = { tenant: "8f4c2b7e-3d1a-4e6f-9b2c-5a7d1e0f4c93", client_id: "aaaaaaaa-1111-2222-3333-444444444444", secret: "s3cret~value", mailbox: "mail@firm.com" };
    assert.equal(shared.mailM365Problem(ok), "");
    assert.equal(shared.mailM365Problem({ ...ok, secret: "" }), "Enter the client secret's value.");
    assert.equal(shared.mailM365Problem({ ...ok, secret: "" }, true), "");
    assert.equal(shared.mailM365Problem({ ...ok, client_id: "nope" }), "The application (client) ID is a GUID. Copy it from the app registration's Overview page.");
    assert.equal(shared.mailM365Problem({ ...ok, mailbox: "" }), "Enter the sending mailbox's email address: the address mail goes out from, such as compassdocs@yourcompany.com.");
    assert.match(shared.mailM365Problem({ ...ok, mailbox: "a b@firm.com" }), /^Enter the sending mailbox's email address/);
    assert.equal(shared.mailM365Problem({ ...ok, graph_user: "not a name" }), "Enter the mailbox's sign-in name (such as compassdocs@yourcompany.onmicrosoft.com) or its object ID, or leave it empty.");
    assert.equal(shared.mailM365Problem({ ...ok, graph_user: "mail@contoso.onmicrosoft.com" }), "");
  });

  test("Microsoft's refusals in plain words", () => {
    const e = (status: number, code: string, kind = "http", retryAfterMs: number | null = null) => errors.m365SendSentence({ status, code, kind, retryAfterMs, message: "(raw)" }, "mail@firm.com");
    assert.equal(e(401, "AADSTS7000222", "auth"), "Microsoft 365 refused the app's sign-in: the client secret has expired. Create a new secret and paste it here.");
    assert.equal(e(401, "AADSTS7000215", "auth"), "Microsoft 365 refused the app's sign-in: the client secret is wrong. Paste the secret's Value (not its Secret ID), or create a new one.");
    assert.equal(e(400, "AADSTS700016", "auth"), "Microsoft 365 refused the app's sign-in: there is no app registration with that application (client) ID in the tenant.");
    assert.equal(e(400, "AADSTS90002", "auth"), "Microsoft 365 refused the app's sign-in: the tenant was not found. Check the tenant ID.");
    assert.equal(e(403, "ErrorAccessDenied"), "The app isn't allowed to send as mail@firm.com (Mail.Send not granted or blocked by an application access policy).");
    assert.equal(e(404, "MailboxNotEnabledForRESTAPI"), "mail@firm.com has no Exchange Online mailbox that can send (it may be on-premises, unlicensed or switched off).");
    assert.equal(e(404, "ResourceNotFound"), "Microsoft 365 found no mailbox mail@firm.com. Enter the mailbox's sign-in name (user principal name) or its main address.");
    assert.equal(e(403, "ErrorSendAsDenied"), "Microsoft 365 refused the From address: mail@firm.com may send only as itself unless Exchange gives it Send As permission on that address.");
    assert.equal(e(429, "ApplicationThrottled", "http", 7_000), "Microsoft 365 is limiting how fast this app sends. Try again in 7 seconds.");
    assert.equal(e(503, ""), "Microsoft 365 had a problem (error 503). Try again shortly.");
    assert.equal(e(0, "", "timeout"), "(raw)", "no answer: the client's own sentence");
  });
});

// --- The configuration ------------------------------------------------------------------------

describe("the configuration and the method", () => {
  test("SMTP is the default and nothing is set up", async () => {
    assert.equal(await config.getMailMethod(), "smtp");
    assert.equal(await config.mailConfigured(), false);
    const v = await view();
    assert.equal(v.status, 200);
    assert.equal(v.body.method, "smtp");
    assert.equal(v.body.m365.configured, false);
    assert.equal(v.body.one_click, "available");
    assert.equal(v.body.test_base, fake.base);
  });

  test("permissions: a viewer may neither look nor change", async () => {
    assert.equal((await view(U.viewer)).status, 403);
    assert.equal((await patch(manual(), U.viewer)).status, 403);
    assert.equal((await view(null)).status, 401);
  });

  test("choosing Microsoft 365 before it is set up is refused: nothing would go out", async () => {
    const r = await patch({ action: "method", method: "m365" });
    assert.deepEqual([r.status, r.body.error], [409, "Set up Microsoft 365 first: nothing could be sent with it yet."]);
    assert.equal(await config.getMailMethod(), "smtp");
  });

  test("a wrong secret, an expired one, an unknown app: refused in plain words, nothing stored", async () => {
    let r = await patch(manual({ secret: "fake~wrong-secret-value" }));
    assert.deepEqual([r.status, r.body.error], [409, "Microsoft 365 refused the app's sign-in: the client secret is wrong. Paste the secret's Value (not its Secret ID), or create a new one."]);
    fake.expiredSecrets.push("fake~expired-secret-value");
    r = await patch(manual({ secret: "fake~expired-secret-value" }));
    assert.deepEqual([r.status, r.body.error], [409, "Microsoft 365 refused the app's sign-in: the client secret has expired. Create a new secret and paste it here."]);
    r = await patch(manual({ client_id: "aaaaaaaa-1111-2222-3333-444444444444" }));
    assert.equal(r.status, 409);
    assert.match(r.body.error, /no app registration with that application \(client\) ID/);
    r = await patch(manual({ mailbox: "not an address" }));
    assert.equal(r.status, 400);
    assert.equal((await config.getM365SendConfig()).clientId, "");
    assert.equal((await audits("settings.mail_m365")).length, 0);
  });

  test("a good save: signed in, the secret sealed and never shown, the token's facts kept, audited; `use` chooses Microsoft 365", async () => {
    const r = await patch(manual({ tenant: "contoso.example", from_name: "Firm Docs", use: true }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.verified, true);
    assert.equal(r.body.method_changed, true);
    const m = r.body.view.m365;
    assert.equal(m.tenant, app.tenant, "the tenant the token signs in to, not the domain typed");
    assert.deepEqual([m.client_id, m.mailbox, m.from_name, m.has_secret, m.setup, m.entra_send, m.sp_object_id, m.configured], [app.appId, MAILBOX, "Firm Docs", true, "manual", true, app.spId, true]);
    assert.ok(!JSON.stringify(r.body).includes(app.secrets[0]), "the secret is not in the answer");
    const raw = (await pool().query("SELECT value FROM settings WHERE key = 'mail_m365_client_secret'")).rows[0].value as string;
    assert.ok(!raw.includes(app.secrets[0]), "sealed at rest");
    assert.equal((await config.getM365SendConfig()).secret, app.secrets[0]);
    assert.equal(await config.getMailMethod(), "m365");
    assert.equal(await config.mailConfigured(), true);
    const [saveAudit] = await audits("settings.mail_m365");
    assert.equal(saveAudit.actor_id, U.admin.id);
    assert.deepEqual((saveAudit.details as { changed: string[] }).changed.sort(), ["client_id", "from_name", "mailbox", "secret", "tenant"]);
    assert.ok(!JSON.stringify(saveAudit.details).includes(app.secrets[0]));
    assert.deepEqual((await audits("settings.mail_method")).map((a) => a.details), [{ from: "smtp", to: "m365" }]);
    assert.equal((await audits("settings.mail_m365_secret")).length, 0, "nothing was replaced");
    // The workspace From and the readiness every caller asks.
    assert.equal(await config.workspaceFrom(), `"Firm Docs" <${MAILBOX}>`);
  });

  test("an empty secret keeps the stored one; a new one is audited as replaced", async () => {
    let r = await patch(manual({ secret: "" }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.changed, []);
    const second = `fake~second-${newToken()}`;
    app.secrets.push(second);
    r = await patch(manual({ secret: second }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.changed, ["secret"]);
    assert.equal((await audits("settings.mail_m365_secret")).length, 1);
    assert.equal((await config.getM365SendConfig()).secret, second);
  });

  test("every label is there", () => {
    for (const a of ["settings.mail_method", "settings.mail_m365", "settings.mail_m365_secret", "settings.mail_m365_auto_setup", "settings.mail_test"]) assert.ok(labels.hasActionLabel(a), a);
  });
});

// --- Sending --------------------------------------------------------------------------------

describe("sending through Microsoft 365", () => {
  test("sendMail: the MIME goes to Graph as the mailbox, under its name", async () => {
    const before = fake.mailboxes.get(MAILBOX)!.sent.length;
    await mailer.sendMail(["reader@example.test"], `Hello ${STAMP}`, "Plain words.", "<p>Plain words.</p>");
    assert.equal(fake.mailboxes.get(MAILBOX)!.sent.length, before + 1);
    const mime = sentText();
    assert.match(mime, /^From: "?Firm Docs"? <compassdocs@/m);
    assert.match(mime, /^To: reader@example\.test/m);
    assert.match(mime, new RegExp(`^Subject: Hello ${STAMP}`, "m"));
    assert.match(mime, /text\/html/);
    assert.ok(fake.calls(`POST /graph/v1.0/users/${encodeURIComponent(MAILBOX)}/sendMail 202`).length >= 1);
  });

  test("a newsletter's chosen sender: From the mailbox under the sender's name, Reply-To the sender; attachments travel", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-"));
    const file = path.join(dir, "agenda.txt");
    fs.writeFileSync(file, "Agenda for Monday");
    await mailer.sendMail(["reader@example.test"], "Newsletter", "Body", undefined, "HR Team <hr@firm.example>", [{ filename: "agenda.txt", path: file }]);
    const mime = sentText();
    assert.match(mime, /^From: "?HR Team"? <compassdocs@/m);
    assert.match(mime, /^Reply-To: HR Team <hr@firm\.example>/m);
    assert.match(mime, /filename=agenda\.txt/);
    assert.match(mime, new RegExp(Buffer.from("Agenda for Monday").toString("base64")));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("too large with its attachments: refused before anything is sent, in words; a newsletter loop stops", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-"));
    const file = path.join(dir, "big.bin");
    fs.writeFileSync(file, Buffer.alloc(2_400_000, 7));
    const before = fake.mailboxes.get(MAILBOX)!.sent.length;
    await assert.rejects(
      () => mailer.sendMail(["reader@example.test"], "Big", "Body", undefined, undefined, [{ filename: "big.bin", path: file }]),
      (e: Error) => {
        assert.equal(e.name, "MailTooLargeError");
        assert.match(e.message, /^This email is 3\.\d MB with its attachments\. Microsoft 365 takes at most 2\.9 MB per email this way\./);
        assert.equal(send.refusalRepeats(e), true);
        return true;
      }
    );
    assert.equal(fake.mailboxes.get(MAILBOX)!.sent.length, before);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("429: Retry-After is waited out, twice at most, then the sentence", async () => {
    const waits: number[] = [];
    send.setM365RetryWaitForTests(async (ms) => void waits.push(ms));
    fake.retryAfter = 3;
    fake.fail.sendMail = 429;
    try {
      await assert.rejects(() => mailer.sendMail(["reader@example.test"], "Busy", "Body"), /Microsoft 365 is limiting how fast this app sends\. Try again in 3 seconds\./);
      assert.deepEqual(waits, [3000, 3000]);
    } finally {
      delete fake.fail.sendMail;
      fake.retryAfter = 0;
      send.setM365RetryWaitForTests(async () => {});
    }
  });

  test("refusals: no Mail.Send, an access policy that leaves the mailbox out, a mailbox that is not there", async () => {
    app.roles = [];
    graphLib.clearM365TokensForTests();
    await assert.rejects(() => mailer.sendMail(["r@example.test"], "x", "y"), (e: Error) => e.message === `The app isn't allowed to send as ${MAILBOX} (Mail.Send not granted or blocked by an application access policy).` && send.refusalRepeats(e));
    app.roles = ["Mail.Send"];
    app.policy = new Set([OTHER]);
    graphLib.clearM365TokensForTests();
    await assert.rejects(() => mailer.sendMail(["r@example.test"], "x", "y"), /blocked by an application access policy/);
    app.policy = new Set([MAILBOX]);
    await mailer.sendMail(["r@example.test"], "allowed by the policy", "y");
    app.policy = null;
    const cfg = await config.getM365SendConfig();
    await assert.rejects(() => send.sendViaM365({ to: ["r@example.test"], subject: "x", text: "y" }, { ...cfg, mailbox: `nobody@${STAMP}.example.test` }), /Microsoft 365 found no mailbox nobody@/);
  });

  test("the helpdesk's transport: the mailbox as From; a From it may not send as reads as an SMTP 550 refusal of the sender", async () => {
    const t = (await mailer.workspaceTransport())!;
    assert.equal(t.method, "m365");
    assert.equal(t.from, `"Firm Docs" <${MAILBOX}>`);
    await t.send({ from: t.from, to: "req@example.test", replyTo: "help+hd-abc@firm.example", subject: "[#12 ref:abc]", text: "Reply", html: "<p>Reply</p>", messageId: "<hd.abc.1@firm.example>", references: "<hd.abc.root@firm.example>", headers: { "Auto-Submitted": "auto-replied" } });
    const mime = sentText();
    assert.match(mime, /^Message-ID: <hd\.abc\.1@firm\.example>/m);
    assert.match(mime, /^References: <hd\.abc\.root@firm\.example>/m);
    assert.match(mime, /^Reply-To: help\+hd-abc@firm\.example/m);
    fake.strictFrom = true;
    try {
      await assert.rejects(
        () => t.send({ from: "support@firm.example", to: "req@example.test", subject: "x", text: "y", headers: {} }),
        (e: unknown) => {
          assert.equal(email.isSenderRejection(e), true);
          assert.match((e as Error).message, /^Microsoft 365 refused the From address/);
          return true;
        }
      );
    } finally {
      fake.strictFrom = false;
    }
    assert.equal(await email.helpdeskMailReady(), true);
  });
});

// --- The check, diagnostics and the test email -----------------------------------------------------

describe("the connection check, diagnostics, the test email", () => {
  test("Check connection: signs in and asks Graph, sending nothing; tries the admin's own mailbox too; kept and audited", async () => {
    const sentBefore = fake.mailboxes.get(MAILBOX)!.sent.length;
    // The admin's own address is no mailbox in the fake: whether the app is limited is not known.
    let r = await patch({ action: "check" });
    assert.equal(r.status, 200);
    assert.equal(r.body.check.ok, true);
    assert.equal(r.body.check.limited, null);
    assert.match(r.body.check.message, new RegExp(`^Signed in, and the app may send as ${MAILBOX.replace(/[.]/g, "\\.")}\\. Nothing was sent\\. Whether it is limited`));
    assert.equal(r.body.view.m365.last_check.ok, true);
    // The admin has a mailbox there: the app (Mail.Send in Entra, no policy) can send as it too.
    fake.addMailbox(`${STAMP}-admin@example.test`, "user");
    r = await patch({ action: "check" });
    assert.equal(r.body.check.limited, false);
    assert.match(r.body.check.message, /The app can also send as .*-admin@example\.test: it is not limited to .* yet\. Run the lock-down commands below\./);
    assert.equal(r.body.view.m365.last_check.other, `${STAMP}-admin@example.test`);
    // "The admin ran the commands": an access policy over the sending mailbox only.
    app.policy = new Set([MAILBOX]);
    graphLib.clearM365TokensForTests();
    r = await patch({ action: "check" });
    assert.equal(r.body.check.ok, true);
    assert.equal(r.body.check.limited, true);
    assert.match(r.body.check.message, /It can't send as .*-admin@example\.test, as it should\./);
    app.policy = null;
    assert.equal(fake.mailboxes.get(MAILBOX)!.sent.length, sentBefore, "nothing was sent");
    assert.deepEqual((await audits("settings.mail_check")).map((a) => a.details.limited), [null, false, true]);
    app.roles = [];
    graphLib.clearM365TokensForTests();
    const no = await patch({ action: "check" });
    assert.equal(no.body.check.ok, false);
    assert.match(no.body.check.message, /isn't allowed to send as/);
    assert.equal(no.body.view.m365.entra_send, false, "the token no longer carries Mail.Send: the RBAC commands apply");
    app.roles = ["Mail.Send"];
    graphLib.clearM365TokensForTests();
  });

  test("diagnostics: a page render shows the last check and never calls Microsoft; Run checks probes when it is over 10 minutes old", async () => {
    // Locked down, so the check passes whole (an app that can send as others too warns: the next test).
    app.policy = new Set([MAILBOX]);
    graphLib.clearM365TokensForTests();
    await patch({ action: "check" });
    const calls = fake.requests.length;
    let row = await diagnostics.checkMail();
    assert.equal(fake.requests.length, calls, "no call to Microsoft on a render");
    assert.deepEqual([row.label, row.status], ["Email (Microsoft 365)", "pass"]);
    assert.match(row.detail, new RegExp(`^Signed in and allowed to send as ${MAILBOX.replace(/[.]/g, "\\.")}\\. Nothing was sent to check it\\. Checked `));
    row = await diagnostics.checkMail({ live: true });
    assert.equal(fake.requests.length, calls, "a fresh check is reused by Run checks too");
    const old = { at: new Date(Date.now() - 11 * 60_000).toISOString(), ok: true, message: "old", limited: null, other: "" };
    await setSetting("mail_m365_check", JSON.stringify(old));
    row = await diagnostics.checkMail();
    assert.equal(fake.requests.length, calls, "a stale check is shown, not redone, on a render");
    row = await diagnostics.checkMail({ live: true });
    assert.ok(fake.requests.length > calls, "Run checks probes again once the last check is old");
    assert.equal(row.status, "pass");
    app.policy = null;
    graphLib.clearM365TokensForTests();
  });

  test("diagnostics: the secret's end warns, then fails; a refusal fails; an app that is not limited warns", async () => {
    let row = await diagnostics.checkMail({ live: true });
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    await setSetting("mail_m365_secret_expires", soon);
    row = await diagnostics.checkMail();
    assert.equal(row.status, "warn");
    assert.match(row.detail, /^The client secret expires on /);
    assert.deepEqual(row.fix, { href: "/admin/notifications/email", label: "Set up Microsoft 365" });
    await setSetting("mail_m365_secret_expires", "2020-01-01");
    row = await diagnostics.checkMail();
    assert.equal(row.status, "fail");
    await setSetting("mail_m365_secret_expires", "");
    fake.fail.sendMail = 403;
    await setSetting("mail_m365_check", "");
    row = await diagnostics.checkMail({ live: true });
    delete fake.fail.sendMail;
    assert.equal(row.status, "fail");
    assert.match(row.detail, /refused the From address|isn't allowed to send/);
    await setSetting("mail_m365_check", JSON.stringify({ at: new Date().toISOString(), ok: true, message: "x", limited: false, other: "someone@x.test" }));
    row = await diagnostics.checkMail();
    assert.equal(row.status, "warn");
    assert.match(row.detail, /^The app can send as other mailboxes too/);
    await setSetting("mail_m365_check", "");
  });

  test("the test email by the method on screen, audited; SMTP not set up says so", async () => {
    let r = await patch({ action: "test", method: "m365", to: "me@example.test" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(sentText(), /This test was sent through Microsoft 365/);
    r = await patch({ action: "test", method: "smtp", to: "me@example.test" });
    assert.deepEqual([r.status, r.body.error], [409, "SMTP isn't set up yet. Save its settings first."]);
    app.roles = [];
    graphLib.clearM365TokensForTests();
    r = await patch({ action: "test", to: "me@example.test" });
    app.roles = ["Mail.Send"];
    graphLib.clearM365TokensForTests();
    assert.equal(r.status, 502);
    assert.match(r.body.error, /isn't allowed to send as/);
    assert.deepEqual((await audits("settings.mail_test")).map((a) => [a.details.method, a.details.ok]), [["m365", true], ["m365", false]]);
  });

  test("back to SMTP keeps the Microsoft 365 configuration; SMTP can't be chosen until it is set up", async () => {
    let r = await patch({ action: "method", method: "smtp" });
    assert.deepEqual([r.status, r.body.error], [409, "Set up SMTP first: nothing could be sent with it yet."]);
    await setSetting("smtp_host", "smtp.example.test");
    await setSetting("smtp_from", "docs@example.test");
    r = await patch({ action: "method", method: "smtp" });
    assert.equal(r.status, 200);
    assert.equal(r.body.view.method, "smtp");
    assert.equal(r.body.view.m365.configured, true, "kept");
    assert.equal(r.body.view.m365.client_id, app.appId);
    assert.equal(await config.workspaceFrom(), "docs@example.test");
    // Back to Microsoft 365: the From changes, so the switch asks first.
    r = await patch({ action: "method", method: "m365" });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "confirm");
    assert.deepEqual(r.body.warnings, [`Email now comes from docs@example.test. Through Microsoft 365 it comes from ${MAILBOX} instead.`]);
    assert.equal(await config.getMailMethod(), "smtp");
    assert.deepEqual((await patch({ action: "warnings", method: "m365" })).body.warnings, r.body.warnings);
    r = await patch({ action: "method", method: "m365", confirm: true });
    assert.equal(r.body.view.method, "m365");
    assert.deepEqual((await audits("settings.mail_method")).map((a) => a.details.to), ["m365", "smtp", "m365"]);
  });
});

// --- Review fixes: the mailbox, the secret, the desk, newsletters ------------------------------

describe("the sending mailbox, the secret, the desk's From", () => {
  test("changing the sending mailbox takes the secret again", async () => {
    const r = await patch(manual({ secret: "", mailbox: OTHER }));
    assert.deepEqual([r.status, r.body.code], [400, "secret_needed"]);
    assert.match(r.body.error, /^Enter the client secret again to change the sending mailbox/);
    assert.equal((await config.getM365SendConfig()).mailbox, MAILBOX);
  });

  test("a sign-in name that is not the address: Graph is asked by it, mail comes from the address", async () => {
    const ADDR = `news@${STAMP}.example.test`;
    const UPN = `news-${STAMP}@contoso.onmicrosoft.com`;
    fake.addMailbox(ADDR, "shared", { upn: UPN });
    // By the address alone Graph finds nothing (the fake is strict, as Microsoft documents /users/{id | UPN}).
    let r = await patch(manual({ mailbox: ADDR }));
    assert.equal(r.status, 200);
    let check = await patch({ action: "check" });
    assert.match(check.body.check.message, /found no mailbox/);
    r = await patch(manual({ mailbox: ADDR, graph_user: UPN }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.view.m365.graph_user, UPN);
    check = await patch({ action: "check" });
    assert.equal(check.body.check.ok, true);
    await mailer.sendMail(["reader@example.test"], "By sign-in name", "Body");
    const mime = fake.mailboxes.get(ADDR)!.sent.at(-1)!.toString("utf8");
    assert.match(mime, new RegExp(`^From: .*${ADDR.replace(/[.]/g, "\\.")}`, "m"));
    // Back to the main mailbox for what follows.
    r = await patch(manual({ graph_user: "" }));
    assert.equal(r.status, 200);
    assert.equal((await config.getM365SendConfig()).mailbox, MAILBOX);
  });

  test("a secret that can't be opened is a clear failure, not 'not set up'", async () => {
    const raw = (await pool().query("SELECT value FROM settings WHERE key = 'mail_m365_client_secret'")).rows[0].value as string;
    await pool().query("UPDATE settings SET value = $1 WHERE key = 'mail_m365_client_secret'", [`${raw.slice(0, raw.length - 6)}AAAAAA`]);
    try {
      const v = (await view()).body;
      assert.deepEqual([v.m365.secret_unreadable, v.m365.configured, v.configured], [true, true, true]);
      const check = await patch({ action: "check" });
      assert.equal(check.body.check.message, config.SECRET_UNREADABLE);
      await assert.rejects(() => mailer.sendMail(["r@example.test"], "x", "y"), (e: Error) => e.message === config.SECRET_UNREADABLE);
      assert.equal((await diagnostics.checkMail()).detail, config.SECRET_UNREADABLE);
      const r = await patch(manual({ secret: "" }));
      assert.deepEqual([r.status, r.body.error], [400, config.SECRET_UNREADABLE]);
    } finally {
      await pool().query("UPDATE settings SET value = $1 WHERE key = 'mail_m365_client_secret'", [raw]);
    }
  });

  test("the desk through Microsoft 365: never From a send-from address; From the mailbox under the help address's name, answers to the help address", async () => {
    fake.strictFrom = true;
    try {
      const t = await email.sendSendAddressTestMail({ address: "support@firm.example", name: "Support" }, "me@example.test");
      assert.equal(t.ok, false);
      assert.equal(t.senderRejected, undefined, "not a refusal: nothing is recorded on the address");
      assert.match(t.error!, new RegExp(`^Email goes out through Microsoft 365, so replies are sent from ${MAILBOX.replace(/[.]/g, "\\.")} under the help address's name and send-from addresses are not used\\.`));
      const before = fake.mailboxes.get(MAILBOX)!.sent.length;
      const r = await email.sendMailboxTestMail({ id: 999_999, address: "help@firm.example", name: "Firm Help", send_address: "support@firm.example", send_address_name: "Support" }, "me@example.test");
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(fake.mailboxes.get(MAILBOX)!.sent.length, before + 1);
      const mime = sentText();
      assert.match(mime, new RegExp(`^From: "?Firm Help"? <${MAILBOX.replace(/[.]/g, "\\.")}>`, "m"));
      assert.match(mime, /^Reply-To: help@firm\.example/m);
    } finally {
      fake.strictFrom = false;
    }
  });
});

describe("newsletters through Microsoft 365: in the background, paced", () => {
  let nid = 0;
  const sent: string[] = [];
  let behave: (to: string) => void = () => {};
  before(async () => {
    nid = (await pool().query("INSERT INTO newsletters (subject, body, author_name, status) VALUES ($1, 'Body', 'Author', 'approved') RETURNING id", [`${STAMP} issue`])).rows[0].id;
    delivery.setNewsletterSenderForTests(async (to) => {
      behave(to[0]);
      sent.push(to[0]);
    });
  });
  after(async () => {
    delivery.setNewsletterSenderForTests(null);
    await pool().query("DELETE FROM newsletters WHERE id = $1", [nid]);
  });
  const payload = { subject: "Issue", text: "Body", html: "<p>Body</p>", from: "", attachments: [] };
  const people = Array.from({ length: 30 }, (_, i) => `p${String(i).padStart(2, "0")}@${STAMP}.example.test`);
  const tick = async () => {
    await delivery.resetNewsletterPacingForTests();
    return delivery.newsletterDeliveryTick();
  };

  test("queued, then about 25 a minute; one batch a minute whichever instance ticks", async () => {
    const d = await delivery.startNewsletterSend(nid, payload, people, { audience: "Everyone", actor: { id: U.admin.id, name: U.admin.name } });
    assert.deepEqual([d.state, d.total, d.queued], ["sending", 30, 30]);
    await assert.rejects(() => delivery.startNewsletterSend(nid, payload, people, { audience: "Everyone" }), /already being sent/);
    let t = await tick();
    assert.equal(t.sent, delivery.NEWSLETTER_PER_TICK);
    // Straight away again: the minute is not over, nothing goes.
    t = await delivery.newsletterDeliveryTick();
    assert.equal(t.newsletter, null);
    assert.equal((await delivery.newsletterDelivery(nid))!.queued, 5);
  });

  test("Microsoft asks to slow down: the job pauses, nobody is lost or sent twice", async () => {
    let once = true;
    behave = () => {
      if (once) {
        once = false;
        throw new send.MailSendError("Microsoft 365 is limiting how fast this app sends. Try again in 120 seconds.", 429, "TooManyRequests", "http", 120_000);
      }
    };
    await tick();
    const d = (await delivery.newsletterDelivery(nid))!;
    assert.equal(d.state, "paused");
    assert.equal(d.queued, 5);
    assert.ok(d.paused_until && Date.parse(d.paused_until) > Date.now() + 100_000);
    behave = () => {};
  });

  test("a recipient Microsoft refuses fails on its own; done: the count is real and 'everyone' is not claimed", async () => {
    behave = (to) => {
      if (to === people[27]) throw new send.MailSendError("Microsoft 365 refused the email (error 400, ErrorInvalidRecipients).", 400, "ErrorInvalidRecipients");
    };
    await tick();
    const d = (await delivery.newsletterDelivery(nid))!;
    assert.deepEqual([d.state, d.sent, d.failed, d.queued], ["done", 29, 1, 0]);
    assert.deepEqual(d.failures, [{ email: people[27], error: "Microsoft 365 refused the email (error 400, ErrorInvalidRecipients)." }]);
    const n = (await pool().query("SELECT status, sent_count FROM newsletters WHERE id = $1", [nid])).rows[0];
    assert.deepEqual([n.status, n.sent_count], ["sent", 29]);
    const c = (await pool().query("SELECT body FROM newsletter_comments WHERE newsletter_id = $1 AND kind = 'sent'", [nid])).rows.map((r) => r.body);
    assert.deepEqual(c, ["Sent to 29 of 30 recipients (everyone); 1 failed. Open the newsletter to see why and retry them."]);
    assert.equal(new Set(sent).size, sent.length, "nobody was sent it twice");
    assert.equal(sent.length, 29);
  });

  test("Retry the 1 that failed: only that one is sent again, and the count grows", async () => {
    behave = () => {};
    const d = await delivery.resumeNewsletterSend(nid, "failed");
    assert.deepEqual([d.state, d.queued], ["sending", 1]);
    await tick();
    const after = (await delivery.newsletterDelivery(nid))!;
    assert.deepEqual([after.state, after.sent, after.failed], ["done", 30, 0]);
    assert.equal((await pool().query("SELECT sent_count FROM newsletters WHERE id = $1", [nid])).rows[0].sent_count, 30);
    assert.equal(sent.filter((e) => e === people[27]).length, 1);
    await assert.rejects(() => delivery.resumeNewsletterSend(nid, "failed"), /nothing to retry/);
  });

  test("a refusal that would repeat for everyone stops the send, with the reason; Try again goes on", async () => {
    const id2 = (await pool().query("INSERT INTO newsletters (subject, body, author_name, status) VALUES ($1, 'Body', 'Author', 'approved') RETURNING id", [`${STAMP} issue 2`])).rows[0].id;
    try {
      await delivery.startNewsletterSend(id2, payload, people.slice(0, 3), { audience: "Everyone" });
      behave = () => {
        throw new send.MailSendError(`The app isn't allowed to send as ${MAILBOX} (Mail.Send not granted or blocked by an application access policy).`, 403, "ErrorAccessDenied");
      };
      await tick();
      let d = (await delivery.newsletterDelivery(id2))!;
      assert.deepEqual([d.state, d.queued, d.sent], ["stopped", 3, 0]);
      assert.match(d.stop_reason, /isn't allowed to send as/);
      behave = () => {};
      await delivery.resumeNewsletterSend(id2, "stopped");
      await tick();
      d = (await delivery.newsletterDelivery(id2))!;
      assert.deepEqual([d.state, d.sent], ["done", 3]);
      assert.deepEqual((await pool().query("SELECT body FROM newsletter_comments WHERE newsletter_id = $1 AND kind = 'sent'", [id2])).rows.map((r) => r.body), ["Sent to everyone — 3 recipients."]);
    } finally {
      await pool().query("DELETE FROM newsletters WHERE id = $1", [id2]);
    }
  });

  test("labels for the new audit actions", () => {
    for (const a of ["newsletter.send_started", "newsletter.send_retried", "newsletter.send_resumed", "settings.mail_check", "settings.mail_m365_auto_setup_failed"]) assert.ok(labels.hasActionLabel(a), a);
  });
});

// --- The enterprise overlay's one-click setup -------------------------------------------------

const EE_SETUP = path.join(__dirname, "..", "ee", "workspace-mail-setup.ts");
describe("Set up with Microsoft (enterprise overlay)", { skip: !fs.existsSync(EE_SETUP) && "the enterprise overlay is not in this checkout" }, () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let setup: any;
  const EE = "http://localhost/api/ee/mail/setup";
  const start = (body: unknown, who: Person | null = U.admin) => call((r) => setup.workspaceMailSetupHandler("POST", ["start"], r), req(`${EE}/start`, who, body, "POST"));
  const poll = (id: string, who: Person | null = U.admin) => call((r) => setup.workspaceMailSetupHandler("POST", ["poll"], r), req(`${EE}/poll`, who, { setup_id: id }, "POST"));
  const run = async (body: unknown) => {
    const s = await start(body);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual((await poll(s.body.setup_id)).body, { status: "pending" });
    return poll(s.body.setup_id);
  };
  let squatter: FakeApp | null = null;
  const ours = () => [...fake.apps.values()].filter((a) => a.displayName === "CompassDocs Workspace Mail" && !a.deleted && a !== squatter);

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    setup = require("../ee/workspace-mail-setup");
    // Start from SMTP with nothing for Microsoft 365, as a new workspace.
    await pool().query("DELETE FROM settings WHERE key = ANY($1)", [config.MAIL_CONFIG_KEYS]);
    await setSetting("mail_method", "smtp");
  });

  test("admins only; the sending mailbox first", async () => {
    assert.equal((await start({ mailbox: MAILBOX }, null)).status, 401);
    assert.equal((await start({ mailbox: MAILBOX }, U.viewer)).status, 403);
    const s = await start({});
    assert.deepEqual([s.status, s.body.error], [400, "Enter the sending mailbox first: the address mail goes out from, such as compassdocs@yourcompany.com."]);
  });

  test("a failure after the app was made takes it out again; nothing is saved", async () => {
    fake.failStep = "consent";
    try {
      const r = await run({ mailbox: MAILBOX });
      assert.equal(r.status, 502);
      assert.match(r.body.error, /Insufficient privileges.*The new app registration was removed from Entra again\./);
    } finally {
      fake.failStep = "";
    }
    assert.equal(ours().length, 0);
    assert.equal((await config.getM365SendConfig()).clientId, "");
  });

  test("the first run: never an app found by its name; a new app with Mail.Send only, admin consent, a secret, saved and chosen", async () => {
    // Someone registered an app with the setup's name (and owns it): it must not be picked up and given Mail.Send.
    squatter = fake.addApp({ displayName: "CompassDocs Workspace Mail" });
    const r = await run({ mailbox: MAILBOX, from_name: "Firm Docs", use: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "done");
    assert.equal(r.body.verified, true);
    assert.equal(r.body.reused, false);
    assert.match(r.body.secret_expires, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Date.parse(r.body.secret_expires) > Date.now() + 700 * 86_400_000, "about 24 months");
    assert.ok(fake.deviceScopes.at(-1)!.includes("Application.ReadWrite.All") && fake.deviceScopes.at(-1)!.includes("AppRoleAssignment.ReadWrite.All"));
    const [a] = ours();
    assert.ok(a);
    assert.deepEqual(a.requiredResourceAccess, [{ resourceAppId: "00000003-0000-0000-c000-000000000000", resourceAccess: [{ id: MAIL_SEND_ROLE_ID, type: "Role" }] }]);
    assert.deepEqual(a.assignments?.map((x) => [x.appRoleId, x.resourceId]), [[MAIL_SEND_ROLE_ID, GRAPH_SP_ID]]);
    assert.deepEqual(a.roles, ["Mail.Send"]);
    const c = await config.getM365SendConfig();
    assert.deepEqual([c.tenant, c.clientId, c.mailbox, c.fromName, c.setup, c.secretExpires, c.entraSend, c.spObjectId], [a.tenant, a.appId, MAILBOX, "Firm Docs", "one_click", r.body.secret_expires, true, a.spId]);
    assert.equal(c.secret, a.secrets[0]);
    assert.equal(await config.getMailMethod(), "m365");
    assert.deepEqual([squatter!.roles, squatter!.assignments ?? [], squatter!.secrets.length], [[], [], 1], "the look-alike app was not touched");
    assert.equal(c.createdApp, a.appId);
    assert.ok(c.secretKeyId);
    const [auto] = await audits("settings.mail_m365_auto_setup");
    assert.equal(auto.details.client_id, a.appId);
    assert.ok(!JSON.stringify(auto.details).includes(a.secrets[0]));
    await mailer.sendMail(["reader@example.test"], "After one click", "Body");
    assert.match(sentText(), /Subject: After one click/);
  });

  test("a second run renews the saved app's secret only, removes the one it made before, and a repeated poll makes no third", async () => {
    const before = ours()[0].secrets[0];
    const s = await start({ mailbox: MAILBOX });
    await poll(s.body.setup_id);
    const r = await poll(s.body.setup_id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.reused, r.body.old_secret_removed], [true, true]);
    const all = ours();
    assert.equal(all.length, 1, "no second app");
    assert.equal(all[0].assignments?.length, 1, "consent left as it was");
    assert.equal(all[0].secrets.length, 1, "the previous secret this setup made is gone");
    assert.notEqual(all[0].secrets[0], before);
    assert.equal((await config.getM365SendConfig()).secret, all[0].secrets[0]);
    assert.ok((await audits("settings.mail_m365_secret")).length >= 1);
    // The same poll again (a proxy cut the first one off): the outcome, not a second run.
    const again = await poll(s.body.setup_id);
    assert.deepEqual(again.body, r.body);
    assert.equal(ours()[0].secrets.length, 1);
  });

  test("an app limited with RBAC (no Mail.Send in Entra): a run renews its secret and never adds the permission or consent back", async () => {
    const a = ours()[0];
    a.roles = [];
    a.assignments = [];
    a.requiredResourceAccess = [];
    graphLib.clearM365TokensForTests();
    await patch({ action: "check" });
    assert.equal((await config.getM365SendConfig()).entraSend, false);
    const r = await run({ mailbox: MAILBOX });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reused, true);
    assert.deepEqual([a.roles, a.assignments, a.requiredResourceAccess], [[], [], []], "the lock-down is left as it is");
    a.roles = ["Mail.Send"];
    graphLib.clearM365TokensForTests();
  });

  test("a refusal on an app it found leaves the app and the saved configuration as they were", async () => {
    const keep = await config.getM365SendConfig();
    const before = ours()[0].secrets.length;
    fake.failStep = "addPassword";
    try {
      const r = await run({ mailbox: MAILBOX });
      assert.equal(r.status, 502);
      assert.equal(r.body.error, "Insufficient privileges to complete the operation. The app you send with was left as it was.");
    } finally {
      fake.failStep = "";
    }
    const [failed] = (await audits("settings.mail_m365_auto_setup_failed")).slice(-1);
    assert.match(String(failed.details.error), /^Insufficient privileges/);
    assert.equal(ours().length, 1);
    assert.equal(ours()[0].secrets.length, before);
    assert.equal((await config.getM365SendConfig()).secret, keep.secret);
  });

  test("unlicensed: the page offers it as Enterprise", async () => {
    licensed = false;
    try {
      assert.equal((await view()).body.one_click, "enterprise");
    } finally {
      licensed = true;
    }
  });
});
