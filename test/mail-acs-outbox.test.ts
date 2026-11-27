// 1.21.5: the workspace's email through Azure Communication Services, end to
// end through the outbox (lib/mailer → lib/mail-outbox → lib/mail-acs), the
// database and the settings API, against the fake ACS
// (test/helpers/fake-acs) signed in to with a stand-in managed identity.
// Nothing here contacts Azure.
//
//   - sendMail and the helpdesk's transport QUEUE the message (sealed MIME),
//     the worker posts it once with its own Operation-Id, the row becomes
//     `accepted`, and the looked-up result settles it: Succeeded → sent (the
//     body wiped), Failed or Canceled → failed with ACS's reason;
//   - 429 with Retry-After pauses everything and fails nothing; the hourly
//     limit holds the rest; no answer after the post is uncertain and then
//     settled by looking its operation up; a refused identity pauses with
//     the reason;
//   - the limits at enqueue (50 recipients, 10 MB);
//   - From is the platform's sender, a help address becomes Reply-To, the
//     workspace's reply address fills in for mail that names none;
//   - the API: the method can't be switched (409 cloud_managed), the reply
//     address is saved and audited, the test email waits for ACS's result.
//
// The workspace's mail configuration is this file's alone while it runs
// (test/support/mail-lock, exclusive), as for test/mail-outbox.test.ts.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/mail-acs-outbox.test.ts

import { test, before, after, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { lockWorkspaceMail, type WorkspaceMailLock } from "./support/mail-lock";
import { startFakeAcs, type FakeAcs } from "./helpers/fake-acs";

process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";

let currentRequest: Request | null = null;
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.mail-acs.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.mail-acs.virtual.js");
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
    ee: () => ({ present: true, features: ["helpdesk"] }),
    eePresent: () => true,
    enterpriseLicensed: async () => false,
    featureEnabled: async (f: string) => f === "helpdesk",
    featureEnforced: async (f: string) => f === "helpdesk",
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
const outbox = require("../src/lib/mail-outbox") as typeof import("../src/lib/mail-outbox");
const shared = require("../src/lib/mail-outbox-shared") as typeof import("../src/lib/mail-outbox-shared");
const mailer = require("../src/lib/mailer") as typeof import("../src/lib/mailer");
const config = require("../src/lib/mail-config") as typeof import("../src/lib/mail-config");
const acs = require("../src/lib/mail-acs") as typeof import("../src/lib/mail-acs");
const credential = require("../src/lib/azure-credential") as typeof import("../src/lib/azure-credential");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const labels = require("../src/lib/audit-labels") as typeof import("../src/lib/audit-labels");
const diagnostics = require("../src/lib/diagnostics") as typeof import("../src/lib/diagnostics");
const mailRoute = require("../src/app/api/admin/mail/route") as typeof import("../src/app/api/admin/mail/route");
const { fixtureQuery } = require("./support/retry") as typeof import("./support/retry");
const { newToken } = require("../src/lib/password") as typeof import("../src/lib/password");
/* eslint-enable @typescript-eslint/no-require-imports */

const { pool, getSetting, createSession } = db;
const STAMP = `acs${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const SENDER = `DoNotReply@${STAMP}.mail.example.test`;
const TOKEN = "eyJhbGciOiJub25lIn0.eyJhdWQiOiJodHRwczovL2NvbW11bmljYXRpb24uYXp1cmUuY29tIn0.ZmFrZS1zaWduYXR1cmU";
const UNPACED = { gapMs: 0, perMinute: 10_000, perHour: 10_000 };
const ENV_KEYS = ["COMPASSDOCS_MAIL_TRANSPORT", "COMPASSDOCS_ACS_ENDPOINT", "COMPASSDOCS_ACS_SENDER", "COMPASSDOCS_ACS_REPLY_TO", "COMPASSDOCS_ACS_CONNECTION_STRING", "COMPASSDOCS_ACS_PER_MINUTE", "COMPASSDOCS_ACS_PER_HOUR"];
const KEYS = [...config.MAIL_CONFIG_KEYS];
type Person = { id: number; session: string; name: string; email: string };
let admin: Person;
let fake: FakeAcs;
let mailLock: WorkspaceMailLock | null = null;
let saved: { key: string; value: string }[] = [];
const envSaved: Record<string, string | undefined> = {};
let outboxFrom = 0;
let ledgerFrom = 0;
let auditFrom = 0;
const notices: string[] = [];
const scopes: string[] = [];

const drain = () => outbox.drainOutboxForTests();
const row = async (id: number) => (await pool().query("SELECT * FROM mail_outbox WHERE id = $1", [id])).rows[0];
const lastId = async () => Number((await pool().query("SELECT max(id) AS n FROM mail_outbox")).rows[0].n);
const queue = (subject: string, to = ["reader@example.test"], kind?: string) => mailer.sendMail(to, subject, "Body", `<p>${subject}</p>`, undefined, undefined, { kind });
/** Make every accepted row's lookup due now, then look. */
const lookNow = async () => {
  await pool().query("UPDATE mail_outbox SET provider_check_at = now() - interval '1 second' WHERE status = 'accepted' AND id > $1", [outboxFrom]);
  return outbox.checkAcceptedAcs();
};
const by = () => ({ actor: { id: admin.id, name: admin.name, role: "admin" as const } });

function req(url: string, who: Person | null, body?: unknown, method = "PATCH"): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": "203.0.113.33", origin: "http://localhost", host: "localhost" };
  if (who) headers.cookie = `compass_session=${who.session}`;
  return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(handler: (r: Request) => Promise<Response>, r: Request): Promise<{ status: number; body: any }> {
  currentRequest = r;
  try {
    const res = await handler(r);
    return { status: res.status, body: await res.json() };
  } finally {
    currentRequest = null;
  }
}
const API = "http://localhost/api/admin/mail";

async function clean(): Promise<void> {
  await pool().query("DELETE FROM mail_outbox WHERE id > $1", [outboxFrom]);
  await pool().query("DELETE FROM mail_send_ledger WHERE id > $1", [ledgerFrom]);
  await pool().query("UPDATE mail_outbox_control SET paused_until = NULL, rate_until = NULL, pause_reason = '', pause_kind = '', noticed_reason = '', noticed_at = NULL, failure_notice_at = NULL WHERE id = 1");
  await pool().query("DELETE FROM settings WHERE key = 'mail_reply_to'");
  outbox.setOutboxForTests({ autoDrain: false, limits: UNPACED });
  fake.reset();
  fake.token = TOKEN;
  notices.length = 0;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  mailLock = await lockWorkspaceMail("exclusive");
  saved = (await pool().query("SELECT key, value FROM settings WHERE key = ANY($1)", [KEYS])).rows;
  await pool().query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
  outboxFrom = Number((await pool().query("SELECT COALESCE(max(id), 0) AS n FROM mail_outbox")).rows[0].n);
  ledgerFrom = Number((await pool().query("SELECT COALESCE(max(id), 0) AS n FROM mail_send_ledger")).rows[0].n);
  auditFrom = Number((await pool().query("SELECT COALESCE(max(id), 0) AS n FROM audit_log")).rows[0].n);
  const em = `${STAMP}-admin@example.test`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'admin', 'active') RETURNING id`, [`${STAMP}-admin`, "ACS admin", em]);
  const session = newToken();
  await createSession(session, r.rows[0].id, new Date(Date.now() + 3_600_000).toISOString());
  admin = { id: r.rows[0].id, session, name: "ACS admin", email: em };
  fake = await startFakeAcs();
  for (const k of ENV_KEYS) envSaved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  // Self-hosted and not opted in: as before.
  assert.equal(await config.getMailMethod(), "smtp");
  process.env.COMPASSDOCS_MAIL_TRANSPORT = "acs";
  process.env.COMPASSDOCS_ACS_ENDPOINT = fake.base;
  process.env.COMPASSDOCS_ACS_SENDER = SENDER;
  credential.setAzureCredentialForTests({
    getToken: async (s) => {
      scopes.push(String(s));
      return { token: TOKEN, expiresOnTimestamp: Date.now() + 3_600_000 };
    },
  });
  acs.resetAcsForTests();
  acs.setAcsWaitForTests(async () => {});
  outbox.setOutboxNoticeSpyForTests((title) => void notices.push(title));
});

after(async () => {
  outbox.setOutboxForTests(null);
  outbox.setOutboxNoticeSpyForTests(null);
  acs.setAcsWaitForTests(null);
  acs.resetAcsForTests();
  credential.setAzureCredentialForTests(null);
  for (const k of ENV_KEYS) {
    if (envSaved[k] === undefined) delete process.env[k];
    else process.env[k] = envSaved[k];
  }
  await pool().query("DELETE FROM mail_outbox WHERE id > $1", [outboxFrom]).catch(() => {});
  await pool().query("DELETE FROM mail_send_ledger WHERE id > $1", [ledgerFrom]).catch(() => {});
  await pool().query("UPDATE mail_outbox_control SET paused_until = NULL, rate_until = NULL, pause_reason = '', pause_kind = '', noticed_reason = '', noticed_at = NULL, failure_notice_at = NULL WHERE id = 1").catch(() => {});
  await pool().query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
  for (const s of saved) await pool().query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [s.key, s.value]);
  await pool().query("DELETE FROM audit_log WHERE id > $1 AND action LIKE 'settings.mail%'", [auditFrom]).catch(() => {});
  await pool().query("DELETE FROM notifications WHERE user_id = $1", [admin.id]).catch(() => {});
  await pool().query("DELETE FROM sessions WHERE user_id = $1", [admin.id]).catch(() => {});
  await pool().query("DELETE FROM users WHERE id = $1", [admin.id]).catch(() => {});
  await mailLock?.release(email);
  await fake.close();
  await db.closePool();
});

describe("the outbox through Azure Communication Services", () => {
  beforeEach(clean);

  test("queued, posted once with our Operation-Id and the managed identity's token, accepted, then sent once ACS says Succeeded", async () => {
    assert.equal(await config.getMailMethod(), "acs");
    await queue("Welcome", ["reader@example.test"], "invite");
    const id = await lastId();
    let r = await row(id);
    assert.equal(r.status, "queued");
    assert.ok(String(r.mime).startsWith("enc:v1:"), "the body is sealed before anything is tried");
    assert.equal(fake.sends().length, 0, "nothing is sent on the spot");
    await drain();
    const [send] = fake.sends();
    assert.equal(send.headers.authorization, `Bearer ${TOKEN}`);
    assert.ok(scopes.every((s) => s === "https://communication.azure.com/.default"));
    r = await row(id);
    assert.equal(r.status, "accepted");
    assert.equal(r.provider_op, send.headers["operation-id"]);
    assert.ok(r.provider_check_at, "its result is looked up later");
    assert.equal(send.json.senderAddress, SENDER);
    assert.deepEqual(send.json.recipients, { to: [{ address: "reader@example.test" }] });
    assert.equal(send.json.content.subject, "Welcome");
    assert.equal(send.json.content.html, "<p>Welcome</p>");
    assert.equal(send.json.headers["Message-ID"], r.message_id);
    // The budget counts it.
    assert.equal(Number((await pool().query("SELECT count(*)::int AS n FROM mail_send_ledger WHERE id > $1", [ledgerFrom])).rows[0].n), 1);
    // The Outbox shows it as being sent, waiting for its result.
    const v = await outbox.outboxView();
    assert.equal(v.method, "acs");
    assert.equal(v.per_hour, 10_000);
    assert.equal(v.waiting.find((w) => w.id === id)?.status, "sending");
    assert.equal(await lookNow(), 1);
    r = await row(id);
    assert.equal(r.status, "sent");
    assert.equal(r.mime, null);
    assert.equal(fake.sends().length, 1, "posted exactly once");
  });

  test("Failed and Canceled results fail the row with ACS's reason, and the admins hear of it", async () => {
    await queue("Bounces");
    await queue("Canceled");
    await drain();
    const [a, b] = fake.sends().map((s) => String(s.headers["operation-id"]));
    fake.outcome = (op) =>
      op.id === a ? { status: "Failed", error: { code: "EmailDroppedAllRecipientsSuppressed", message: "All recipients are on the suppression list" } } : op.id === b ? { status: "Canceled" } : { status: "Succeeded" };
    assert.equal(await lookNow(), 2);
    const rows = (await pool().query("SELECT status, last_error, provider_op FROM mail_outbox WHERE id > $1 ORDER BY id", [outboxFrom])).rows;
    assert.deepEqual(
      rows.map((x) => [x.status, x.last_error]),
      [
        ["failed", "Azure Communication Services could not deliver this email: All recipients are on the suppression list."],
        ["failed", "Azure Communication Services canceled this email."],
      ]
    );
    assert.ok(notices.some((n) => /wasn't sent|weren't sent/.test(n)));
    const v = await outbox.outboxView();
    assert.equal(v.problems_total, 2);
  });

  test("a result still running is looked at again later; one never known after two hours is uncertain", async () => {
    fake.outcome = () => ({ status: "Running" });
    await queue("Slow");
    await drain();
    const id = await lastId();
    assert.equal(await lookNow(), 0);
    let r = await row(id);
    assert.equal(r.status, "accepted");
    assert.equal(r.settle_checks, 1);
    assert.ok(new Date(r.provider_check_at).getTime() > Date.now() + 20_000, "backs off");
    await pool().query("UPDATE mail_outbox SET posted_at = now() - interval '3 hours' WHERE id = $1", [id]);
    await lookNow();
    r = await row(id);
    assert.equal(r.status, "uncertain");
    assert.equal(r.last_error, shared.ACS_NO_RESULT_REASON);
  });

  test("429 with Retry-After: nothing fails, everything waits at least a minute, the slot is given back, and it goes after", async () => {
    fake.sendQueue.push({ status: 429, headers: { "retry-after": "90" }, body: { error: { code: "TooManyRequests", message: "Too many requests" } } });
    await queue("Throttled");
    await queue("Behind it");
    await drain();
    const rows = (await pool().query("SELECT status, next_attempt_at FROM mail_outbox WHERE id > $1 ORDER BY id", [outboxFrom])).rows;
    assert.deepEqual(rows.map((x) => x.status), ["queued", "queued"]);
    assert.ok(new Date(rows[0].next_attempt_at).getTime() > Date.now() + 80_000, "waits out Retry-After");
    const ctl = (await pool().query("SELECT paused_until, pause_kind FROM mail_outbox_control WHERE id = 1")).rows[0];
    assert.equal(ctl.pause_kind, "rate");
    assert.ok(new Date(ctl.paused_until).getTime() > Date.now() + 80_000);
    assert.equal(Number((await pool().query("SELECT count(*)::int AS n FROM mail_send_ledger WHERE id > $1", [ledgerFrom])).rows[0].n), 0, "a refused send is not counted");
    assert.equal(fake.sends().length, 1, "the second one was not tried into the slow-down");
    await outbox.resumeOutbox();
    await drain();
    assert.deepEqual((await pool().query("SELECT status FROM mail_outbox WHERE id > $1 ORDER BY id", [outboxFrom])).rows.map((x) => x.status), ["accepted", "accepted"]);
  });

  test("the hourly limit holds the rest of the hour's mail in the queue", async () => {
    outbox.setOutboxForTests({ autoDrain: false, limits: { gapMs: 0, perMinute: 10_000, perHour: 2 } });
    for (const s of ["One", "Two", "Three"]) await queue(s);
    const d = await drain();
    assert.equal(fake.sends().length, 2);
    assert.deepEqual((await pool().query("SELECT status FROM mail_outbox WHERE id > $1 ORDER BY id", [outboxFrom])).rows.map((x) => x.status), ["accepted", "accepted", "queued"]);
    assert.ok(d.waitMs !== null && d.waitMs > 3_000_000, `waits about an hour (${d.waitMs})`);
  });

  test("no answer after the POST: uncertain, then settled by looking up its own Operation-Id", async () => {
    fake.sendQueue.push("drop");
    await queue("Lost answer");
    await drain();
    const id = await lastId();
    let r = await row(id);
    assert.equal(r.status, "uncertain");
    assert.equal(r.last_error, shared.ACS_UNCERTAIN_REASON);
    assert.ok(r.provider_op);
    assert.ok(fake.ops.has(r.provider_op), "ACS had it");
    await pool().query("UPDATE mail_outbox SET updated_at = now() - interval '2 minutes' WHERE id = $1", [id]);
    assert.equal(await outbox.settleUncertain(), 1);
    r = await row(id);
    assert.equal(r.status, "sent");
    assert.equal(fake.sends().length, 1, "never sent twice by itself");
  });

  test("a refused identity pauses the outbox with the reason; no message is failed for it", async () => {
    fake.token = "another-token";
    await queue("Denied");
    await drain();
    const r = await row(await lastId());
    assert.equal(r.status, "queued");
    assert.match(r.last_error, /refused to send this email \(401\)/);
    const ctl = (await pool().query("SELECT pause_kind, pause_reason FROM mail_outbox_control WHERE id = 1")).rows[0];
    assert.equal(ctl.pause_kind, "refusal");
    assert.match(ctl.pause_reason, /Communication and Email Service Owner/);
    assert.ok(!ctl.pause_reason.includes(TOKEN));
    assert.ok(notices.includes("Email is paused"));
  });

  test("ACS's limits are checked when a message is queued: 50 recipients, 10 MB", async () => {
    const many = Array.from({ length: 51 }, (_, i) => `r${i}@example.test`);
    await assert.rejects(queue("Too many", many), (e: unknown) => /51 recipients\. Azure Communication Services takes at most 50/.test((e as Error).message));
    await assert.rejects(
      outbox.enqueueMime(Buffer.alloc(10_000_001, 65), { recipients: ["reader@example.test"], subject: "Big" }),
      (e: unknown) => (e as Error).name === "MailTooLargeError" && /Azure Communication Services takes at most 10\.0 MB/.test((e as Error).message)
    );
    // Under Microsoft 365's 2.9 MB this would have been refused; through ACS 5 MB is fine.
    assert.ok((await outbox.enqueueMime(Buffer.concat([Buffer.from("To: reader@example.test\r\nSubject: Mid\r\n\r\n"), Buffer.alloc(5_000_000, 65)]), { recipients: ["reader@example.test"], subject: "Mid" })) > 0);
    assert.equal(fake.sends().length, 0);
  });

  test("helpdesk mail: From the platform's sender, Reply-To the help address, threading headers kept; the workspace's reply address fills in for the rest", async () => {
    const t = await mailer.workspaceTransport();
    assert.equal(t?.method, "acs");
    assert.equal(t?.from, SENDER);
    await t!.send(
      { from: `"Acme Support" <help@acme.example>`, to: "customer@example.test", subject: "Re: printer", text: "On it.", messageId: "<hd-1@acme.example>", references: "<c-1@example.test>", headers: { "Auto-Submitted": "auto-replied" } },
      { kind: "helpdesk_reply" }
    );
    await config.saveWorkspaceReplyTo("office@acme.example", by());
    await queue("Digest");
    await drain();
    const [desk, digest] = fake.sends();
    assert.equal(desk.json.senderAddress, SENDER);
    assert.deepEqual(desk.json.replyTo, [{ address: "help@acme.example", displayName: "Acme Support" }]);
    assert.equal(desk.json.headers["Message-ID"], "<hd-1@acme.example>");
    assert.equal(desk.json.headers.References, "<c-1@example.test>");
    assert.equal(desk.json.headers["Auto-Submitted"], "auto-replied");
    assert.deepEqual(digest.json.replyTo, [{ address: "office@acme.example" }]);
    const audit = (await pool().query("SELECT details FROM audit_log WHERE action = 'settings.mail_reply_to' AND id > $1 ORDER BY id DESC LIMIT 1", [auditFrom])).rows[0];
    assert.deepEqual(audit.details, { from: null, to: "office@acme.example" });
    assert.ok(labels.hasActionLabel("settings.mail_reply_to"));
  });
});

describe("Settings → Notifications → Email under ACS", () => {
  beforeEach(clean);

  test("the view says ACS, the method can't be switched, the reply address saves, the test email waits for ACS's result", async () => {
    const view = await call(mailRoute.GET as unknown as (r: Request) => Promise<Response>, req(API, admin, undefined, "GET"));
    assert.equal(view.status, 200);
    assert.equal(view.body.method, "acs");
    assert.equal(view.body.configured, true);
    assert.deepEqual({ ...view.body.acs, endpoint_host: "" }, { sender: SENDER, endpoint_host: "", auth: "managed_identity", reply_to: "", reply_to_default: "", per_minute: 30, per_hour: 100, cloud: false });
    const sw = await call(mailRoute.PATCH, req(API, admin, { action: "method", method: "smtp" }));
    assert.equal(sw.status, 409);
    assert.equal(sw.body.code, "cloud_managed");
    await assert.rejects(config.setMailMethod("m365", by(), { force: true }), (e: unknown) => (e as { code?: string }).code === "cloud_managed");
    const bad = await call(mailRoute.PATCH, req(API, admin, { action: "reply_to", reply_to: "not an address" }));
    assert.equal(bad.status, 400);
    const ok = await call(mailRoute.PATCH, req(API, admin, { action: "reply_to", reply_to: "help@acme.example" }));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.view.acs.reply_to, "help@acme.example");
    const t = await call(mailRoute.PATCH, req(API, admin, { action: "test", to: "admin@example.test" }));
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.body.method, "acs");
    assert.ok(fake.requests.some((r) => r.method === "GET"), "the test email's result was looked up");
    assert.deepEqual(fake.sends()[0].json.replyTo, [{ address: "help@acme.example" }]);
    fake.outcome = () => ({ status: "Failed", error: { code: "Bounced", message: "Mailbox unavailable" } });
    const failed = await call(mailRoute.PATCH, req(API, admin, { action: "test", to: "admin@example.test" }));
    assert.equal(failed.status, 502);
    assert.match(failed.body.error, /could not deliver this email: Mailbox unavailable/);
    const check = await call(mailRoute.PATCH, req(API, admin, { action: "check" }));
    assert.equal(check.body.ok, true);
    const diag = await diagnostics.checkMail({ live: true });
    assert.equal(diag.status, "pass");
    assert.equal(diag.label, "Email (Azure Communication Services)");
  });
});
