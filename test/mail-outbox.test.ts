// 1.20.32: the outbox of the workspace's email through Microsoft 365
// (lib/mail-outbox, lib/mail-outbox-shared), against the fake Microsoft
// (test/helpers/fake-m365). Nothing here contacts Microsoft.
//
//   - pure: the pacing arithmetic (the gap that spreads a burst, the
//     60-second window, the pause), the daily cap and its wait, the order
//     of kinds, how a refusal is read, the From swap and address lists;
//   - the queue: built and SEALED before any attempt, the body wiped once
//     sent, urgent before ordinary before bulk, attachments read at enqueue;
//   - the budget in the database: concurrent claimers (as two instances)
//     never exceed it together; the daily cap holds ordinary mail and lets
//     urgent mail through; newsletters draw from it and give way;
//   - Microsoft's answers: 429 pauses everything and nothing is lost or
//     doubled; no answer after the post is `uncertain` (never resent by
//     itself), settled from Sent Items only when the app may read it; no
//     answer at sign-in is not; a refusal for everyone pauses with the
//     reason and tells the admins once; a refusal of one message fails it;
//     500 is tried again; a dead instance's claim is taken back;
//   - SMTP: sent on the spot as before, nothing queued; switching to SMTP
//     with mail waiting says so, then sends it by SMTP From the SMTP From;
//   - the admin API (permissions, Retry, Discard, Try now, audited), the
//     desk (a reply's failed email on the message, Send again), pruning,
//     diagnostics.
//
// The workspace's mail configuration is this file's alone while it runs
// (test/support/mail-lock, exclusive); what it changes is put back.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/mail-outbox.test.ts

import { test, before, after, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lockWorkspaceMail, type WorkspaceMailLock } from "./support/mail-lock";
import { startFakeM365, type FakeApp, type FakeM365 } from "./helpers/fake-m365";

process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";

let currentRequest: Request | null = null;
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.mail-outbox.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.mail-outbox.virtual.js");
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
const shared = require("../src/lib/mail-outbox-shared") as typeof import("../src/lib/mail-outbox-shared");
const outbox = require("../src/lib/mail-outbox") as typeof import("../src/lib/mail-outbox");
const mailer = require("../src/lib/mailer") as typeof import("../src/lib/mailer");
const config = require("../src/lib/mail-config") as typeof import("../src/lib/mail-config");
const send = require("../src/lib/mail-m365") as typeof import("../src/lib/mail-m365");
const graphLib = require("../src/lib/helpdesk/m365/graph") as typeof import("../src/lib/helpdesk/m365/graph");
const delivery = require("../src/lib/newsletter-delivery") as typeof import("../src/lib/newsletter-delivery");
const secretbox = require("../src/lib/secretbox") as typeof import("../src/lib/secretbox");
const diagnostics = require("../src/lib/diagnostics") as typeof import("../src/lib/diagnostics");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const notifyMod = require("../src/lib/helpdesk/notify") as typeof import("../src/lib/helpdesk/notify");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const messages = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
const access = require("../src/lib/helpdesk/access") as typeof import("../src/lib/helpdesk/access");
const labels = require("../src/lib/audit-labels") as typeof import("../src/lib/audit-labels");
const outboxRoute = require("../src/app/api/admin/mail/outbox/route") as typeof import("../src/app/api/admin/mail/outbox/route");
const resendRoute = require("../src/app/api/helpdesk/tickets/[number]/messages/[id]/resend/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/messages/[id]/resend/route");
const newsletterLib = require("../src/lib/newsletter") as typeof import("../src/lib/newsletter");
const { fixtureQuery } = require("./support/retry") as typeof import("./support/retry");
const { newToken } = require("../src/lib/password") as typeof import("../src/lib/password");
/* eslint-enable @typescript-eslint/no-require-imports */

const { pool, getSetting, createSession } = db;
const { PRIORITY, paceDecision, dailyWaitMs, mailPriority, classifySendError, DEFAULT_PACE } = shared;
const STAMP = `ob${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const MAILBOX = `outbox@${STAMP}.example.test`;
type Person = { id: number; session: string; name: string; email: string };
const U: Record<"admin" | "viewer", Person> = {} as never;
const API = "http://localhost/api/admin/mail/outbox";
const SMTP_KEYS = ["smtp_host", "smtp_port", "smtp_secure", "smtp_user", "smtp_pass", "smtp_from"];
const KEYS = [...config.MAIL_CONFIG_KEYS, ...SMTP_KEYS];
const UNPACED = { gapMs: 0, perMinute: 10_000 };
let saved: { key: string; value: string }[] = [];
let auditFrom = 0;
let outboxFrom = 0;
let ledgerFrom = 0;
let fake: FakeM365;
let app: FakeApp;
let mailLock: WorkspaceMailLock | null = null;
const notices: string[] = [];
const ticketIds: number[] = [];
const by = () => ({ actor: { id: U.admin.id, name: U.admin.name, role: "admin" as const } });
const drain = () => outbox.drainOutboxForTests();
const sent = () => fake.mailboxes.get(MAILBOX)!.sent;
const subjects = () => sent().map((m) => m.toString("utf8").match(/^Subject: (.*)$/m)?.[1] ?? "");
const row = async (id: number) => (await pool().query("SELECT * FROM mail_outbox WHERE id = $1", [id])).rows[0];
const ours = async () => (await pool().query("SELECT * FROM mail_outbox WHERE id > $1 ORDER BY id", [outboxFrom])).rows;
const control = async () => (await pool().query("SELECT * FROM mail_outbox_control WHERE id = 1")).rows[0];
const queue = (subject: string, kind?: string, to = ["reader@example.test"]) => mailer.sendMail(to, subject, "Body", undefined, undefined, undefined, { kind });
const lastId = async () => Number((await pool().query("SELECT max(id) AS n FROM mail_outbox")).rows[0].n);

function req(url: string, who: Person | null, body?: unknown, method = "PATCH"): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": "203.0.113.32", origin: "http://localhost", host: "localhost" };
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
const audits = async (action: string) => (await pool().query("SELECT details FROM audit_log WHERE action = $1 AND id > $2 ORDER BY id", [action, auditFrom])).rows as { details: Record<string, unknown> }[];

/** A clean outbox and budget for each test (only this file's rows; the lock keeps every other mail file out). */
async function clean(): Promise<void> {
  await pool().query("DELETE FROM mail_outbox WHERE id > $1", [outboxFrom]);
  await pool().query("DELETE FROM mail_send_ledger WHERE id > $1", [ledgerFrom]);
  await pool().query("UPDATE mail_outbox_control SET paused_until = NULL, rate_until = NULL, pause_reason = '', pause_kind = '', noticed_reason = '', noticed_at = NULL, failure_notice_at = NULL WHERE id = 1");
  outbox.setOutboxForTests({ autoDrain: false, limits: UNPACED });
  delete fake.fail.sendMail;
  delete fake.fail.token;
  fake.throttleNext = 0;
  fake.retryAfter = 0;
  app.roles = ["Mail.Send"];
  graphLib.clearM365TokensForTests();
  notices.length = 0;
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  mailLock = await lockWorkspaceMail("exclusive");
  saved = (await pool().query("SELECT key, value FROM settings WHERE key = ANY($1)", [KEYS])).rows;
  await pool().query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
  auditFrom = Number((await pool().query("SELECT COALESCE(max(id), 0) AS n FROM audit_log")).rows[0].n);
  outboxFrom = Number((await pool().query("SELECT COALESCE(max(id), 0) AS n FROM mail_outbox")).rows[0].n);
  ledgerFrom = Number((await pool().query("SELECT COALESCE(max(id), 0) AS n FROM mail_send_ledger")).rows[0].n);
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  for (const role of ["admin", "viewer"] as const) {
    const em = `${STAMP}-${role}@example.test`;
    const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`, [`${STAMP}-${role}`, `Outbox ${role}`, em, role]);
    const session = newToken();
    await createSession(session, r.rows[0].id, expires);
    U[role] = { id: r.rows[0].id, session, name: `Outbox ${role}`, email: em };
  }
  fake = await startFakeM365();
  process.env.COMPASSDOCS_M365_MAIL_TEST_BASE = fake.base;
  fake.addMailbox(MAILBOX, "shared");
  app = fake.addApp({ displayName: "Outbox app", roles: ["Mail.Send"] });
  send.setM365RetryWaitForTests(async () => {});
  outbox.setOutboxForTests({ autoDrain: false, limits: UNPACED });
  outbox.setOutboxNoticeSpyForTests((title) => void notices.push(title));
  await config.saveM365SendConfig({ tenant: app.tenant, client_id: app.appId, secret: app.secrets[0], mailbox: MAILBOX, from_name: "Firm Docs" }, by(), { use: true, confirm: true });
  assert.equal(await config.getMailMethod(), "m365");
});

after(async () => {
  outbox.setOutboxForTests(null);
  outbox.setOutboxNoticeSpyForTests(null);
  send.setM365RetryWaitForTests(null);
  graphLib.clearM365TokensForTests();
  await pool().query("DELETE FROM mail_outbox WHERE id > $1", [outboxFrom]).catch(() => {});
  await pool().query("DELETE FROM mail_send_ledger WHERE id > $1", [ledgerFrom]).catch(() => {});
  await pool().query("UPDATE mail_outbox_control SET paused_until = NULL, rate_until = NULL, pause_reason = '', pause_kind = '', noticed_reason = '', noticed_at = NULL, failure_notice_at = NULL WHERE id = 1").catch(() => {});
  await pool().query("DELETE FROM settings WHERE key = ANY($1)", [KEYS]);
  for (const s of saved) await pool().query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [s.key, s.value]);
  if (ticketIds.length) await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [ticketIds]).catch(() => {});
  const ids = Object.values(U).map((u) => u.id);
  await pool().query("DELETE FROM audit_log WHERE id > $1 AND (action LIKE 'settings.mail%' OR action LIKE 'settings.smtp%' OR action = 'helpdesk.reply_mail_resent')", [auditFrom]).catch(() => {});
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [ids]).catch(() => {});
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [ids]).catch(() => {});
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [ids]).catch(() => {});
  delete process.env.COMPASSDOCS_M365_MAIL_TEST_BASE;
  await mailLock?.release(email);
  await fake.close();
  await pool().end();
});

// --- Pure ------------------------------------------------------------------------------------------

describe("pure: pacing, the daily cap, the order, refusals", () => {
  const at = 1_000_000_000_000;
  const state = (over: Partial<import("../src/lib/mail-outbox-shared").PaceState> = {}) => ({ nowMs: at, pausedUntilMs: null, lastAtMs: null, minute: [], dayRecipients: 0, ...over });

  test("the gap spreads a burst over the minute: about 25 a minute, never at its top", () => {
    assert.equal(DEFAULT_PACE.perMinute, 25);
    assert.equal(DEFAULT_PACE.gapMs, 2_400);
    assert.deepEqual(paceDecision(state(), 1, PRIORITY.normal), { ok: true });
    assert.deepEqual(paceDecision(state({ lastAtMs: at - 1_000 }), 1, PRIORITY.normal), { ok: false, why: "gap", waitMs: 1_400 });
    assert.deepEqual(paceDecision(state({ lastAtMs: at - 2_400 }), 1, PRIORITY.normal), { ok: true });
    // A simulated burst of 60 messages: one every 2.4 s, so no 60-second window ever holds more than 25.
    const times: number[] = [];
    let now = at;
    while (times.length < 60) {
      const minute = times.filter((t) => t > now - 60_000);
      const d = paceDecision(state({ nowMs: now, lastAtMs: times.at(-1) ?? null, minute }), 1, PRIORITY.bulk);
      if (d.ok) times.push(now);
      else now += d.waitMs;
    }
    for (const t of times) assert.ok(times.filter((x) => x >= t && x < t + 60_000).length <= 25);
    assert.ok(times[24] - times[0] >= 57_000, "25 sends take most of a minute, not its first second");
  });

  test("the 60-second window and the pause", () => {
    const minute = Array.from({ length: 25 }, (_, i) => at - 59_000 + i * 100);
    assert.deepEqual(paceDecision(state({ minute, lastAtMs: minute.at(-1)! }), 1, PRIORITY.urgent, { ...DEFAULT_PACE, gapMs: 0 }), { ok: false, why: "minute", waitMs: 1_000 });
    assert.deepEqual(paceDecision(state({ pausedUntilMs: at + 61_000 }), 1, PRIORITY.urgent), { ok: false, why: "paused", waitMs: 61_000 });
    assert.deepEqual(paceDecision(state({ pausedUntilMs: at - 1 }), 1, PRIORITY.urgent), { ok: true }, "a pause that ended");
  });

  test("the daily cap: ordinary and bulk stop at 9,500 recipients; urgent may use the margin", () => {
    assert.equal(shared.MAIL_DAILY_SAFE_CAP, 9_500);
    assert.equal(shared.MAIL_DAILY_RECIPIENT_LIMIT, 10_000);
    assert.ok(shared.MAIL_DAILY_URGENT_CAP > shared.MAIL_DAILY_SAFE_CAP && shared.MAIL_DAILY_URGENT_CAP < 10_000);
    assert.deepEqual(paceDecision(state({ dayRecipients: 9_499 }), 1, PRIORITY.bulk), { ok: true });
    assert.equal(paceDecision(state({ dayRecipients: 9_500 }), 1, PRIORITY.normal).ok, false);
    assert.equal((paceDecision(state({ dayRecipients: 9_490 }), 20, PRIORITY.bulk) as { why: string }).why, "daily", "a message to 20 people does not squeeze in");
    assert.deepEqual(paceDecision(state({ dayRecipients: 9_500 }), 1, PRIORITY.urgent), { ok: true });
    assert.equal(paceDecision(state({ dayRecipients: shared.MAIL_DAILY_URGENT_CAP }), 1, PRIORITY.urgent).ok, false);
    // The wait: until enough of the day's sends age out.
    const sends = [
      { atMs: at - 20 * 3_600_000, recipients: 5_000 },
      { atMs: at - 2 * 3_600_000, recipients: 4_500 },
    ];
    assert.equal(dailyWaitMs(sends, at, 1, 9_500), 4 * 3_600_000, "the first 5,000 age out in 4 hours");
    assert.equal(dailyWaitMs([{ atMs: at - 86_399_000, recipients: 9_500 }], at, 1, 9_500), 60_000, "at least a minute");
  });

  test("the order: sign-in links and helpdesk replies first, notifications next, digests and newsletters last", () => {
    for (const k of ["password_reset", "sign_in_link", "verification", "invite", "helpdesk_reply"]) assert.equal(mailPriority(k), PRIORITY.urgent, k);
    for (const k of ["mention", "helpdesk_notice", "webhook_alert", "", undefined]) assert.equal(mailPriority(k), PRIORITY.normal, String(k));
    for (const k of ["digest", "notification_digest", "announcement", "training", "review", "subscription", "newsletter", "directory_export"]) assert.equal(mailPriority(k), PRIORITY.bulk, k);
    assert.equal(email.helpdeskMailKind("hd_reply", true), "helpdesk_reply");
    assert.equal(email.helpdeskMailKind("hd_reply", false), "helpdesk_notice", "an agent's own copy is not urgent");
    assert.equal(email.helpdeskMailKind("hd_portal_link", true), "sign_in_link");
    assert.equal(email.helpdeskMailKind("hd_report_digest", false), "helpdesk_report");
  });

  test("how a refusal is read", () => {
    assert.equal(classifySendError({ status: 429 }), "rate");
    assert.equal(classifySendError({ status: 503 }), "rate");
    assert.equal(classifySendError({ status: 0, kind: "timeout" }), "uncertain");
    assert.equal(classifySendError({ status: 0, kind: "network" }), "uncertain");
    assert.equal(classifySendError({ status: 504 }), "uncertain");
    assert.equal(classifySendError({ status: 0, kind: "blocked" }), "repeat");
    assert.equal(classifySendError({ status: 403, code: "ErrorAccessDenied" }), "repeat");
    assert.equal(classifySendError({ status: 401 }), "repeat");
    assert.equal(classifySendError({ status: 404, code: "ErrorInvalidUser" }), "repeat");
    assert.equal(classifySendError({ status: 400, kind: "auth" }), "repeat");
    assert.equal(classifySendError({ status: 0, code: "not_set_up" }), "repeat");
    assert.equal(classifySendError({ status: 500 }), "transient");
    assert.equal(classifySendError({ status: 400, code: "ErrorInvalidRecipients" }), "failed");
    assert.equal(classifySendError({ status: 413, name: "MailTooLargeError", kind: "too_large" }), "failed");
  });

  test("MIME helpers: the From swapped (folded headers too), a header read, address lists", () => {
    const mime = Buffer.from("Content-Type: text/plain\r\nFrom: =?UTF-8?Q?Firm_D=C3=B6cs?=\r\n <outbox@x.test>\r\nTo: a@x.test, \"B, Bee\" <b@x.test>\r\nMessage-ID: <abc@x.test>\r\n\r\nBody\r\nFrom: not a header\r\n");
    const out = outbox.replaceFrom(mime, "From: Help <help@smtp.test>").toString("latin1");
    assert.match(out, /^Content-Type: text\/plain\r\nFrom: Help <help@smtp\.test>\r\nTo: /);
    assert.doesNotMatch(out, /outbox@x\.test/);
    assert.match(out, /\r\n\r\nBody\r\nFrom: not a header\r\n$/, "the body is untouched");
    assert.equal(outbox.mimeHeader(mime, "message-id"), "<abc@x.test>");
    assert.deepEqual(outbox.addressList('a@x.test, "B, Bee" <b@x.test>'), ["a@x.test", "b@x.test"]);
    assert.deepEqual(outbox.addressList(["A@X.test", "a@x.test", "not an address"]), ["a@x.test"]);
  });
});

// --- The queue -------------------------------------------------------------------------------------

describe("the queue: sealed, wiped, in order", () => {
  beforeEach(clean);

  test("queued before any attempt, sealed with the master key; once sent, the body is wiped and the metadata kept", async () => {
    const link = `https://docs.example.test/reset?token=${newToken()}`;
    const before = sent().length;
    await mailer.sendMail(["someone@example.test"], `Reset your password ${STAMP}`, `Open ${link} to choose a new password.`, undefined, undefined, undefined, { kind: "password_reset" });
    assert.equal(sent().length, before, "nothing sent in the call");
    const [r] = await ours();
    assert.deepEqual([r.status, r.kind, r.priority, r.recipient_count, r.recipients, r.attempts], ["queued", "password_reset", 0, 1, "someone@example.test", 0]);
    assert.ok(secretbox.isSealed(r.mime), "sealed at rest");
    assert.ok(!r.mime.includes(link) && !r.mime.includes(Buffer.from(link).toString("base64").slice(0, 24)), "the link is not readable in the row");
    assert.match(Buffer.from(secretbox.openSecret(r.mime), "base64").toString("utf8"), /reset\?token=/);
    assert.match(r.message_id, /^<.+@.+>$/);
    await drain();
    assert.equal(sent().length, before + 1);
    assert.match(sent().at(-1)!.toString("utf8"), /reset\?token=/);
    const done = await row(Number(r.id));
    assert.equal(done.status, "sent");
    assert.equal(done.mime, null, "the body is wiped once sent");
    assert.ok(done.sent_at && done.subject.startsWith("Reset your password"));
  });

  test("attachments are read when queued: the file may go before the send", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-"));
    const file = path.join(dir, "export.csv");
    fs.writeFileSync(file, "name,email\nAda,ada@example.test\n");
    await mailer.sendMail(["boss@example.test"], "Weekly export", "Attached.", undefined, undefined, [{ filename: "export.csv", path: file }], { kind: "directory_export" });
    fs.rmSync(dir, { recursive: true, force: true });
    await drain();
    assert.match(sent().at(-1)!.toString("utf8"), /filename=export\.csv/);
    // Too large is still refused at once, in words, and nothing is queued.
    const big = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ob-")), "big.bin");
    fs.writeFileSync(big, Buffer.alloc(2_400_000, 7));
    const n = (await ours()).length;
    await assert.rejects(() => mailer.sendMail(["boss@example.test"], "Big", "Body", undefined, undefined, [{ filename: "big.bin", path: big }]), (e: Error) => e.name === "MailTooLargeError");
    assert.equal((await ours()).length, n);
  });

  test("urgent first, then ordinary, then bulk; oldest first within each", async () => {
    await queue(`${STAMP} digest`, "digest");
    await queue(`${STAMP} mention 1`, "mention");
    await queue(`${STAMP} newsletter`, "newsletter");
    await queue(`${STAMP} sign-in`, "sign_in_link");
    await queue(`${STAMP} mention 2`, "mention");
    const before = sent().length;
    await drain();
    assert.deepEqual(subjects().slice(before), [`${STAMP} sign-in`, `${STAMP} mention 1`, `${STAMP} mention 2`, `${STAMP} digest`, `${STAMP} newsletter`]);
  });
});

// --- The budget ------------------------------------------------------------------------------------

describe("one budget in the database, for every instance and for newsletters", () => {
  beforeEach(clean);

  test("concurrent claimers (as several instances) never exceed the minute's budget together", async () => {
    outbox.setOutboxForTests({ autoDrain: false, limits: { gapMs: 0, perMinute: 4 } });
    const answers = await Promise.all(Array.from({ length: 12 }, (_, i) => outbox.takeMailSlot({ source: `instance-${i % 3}`, priority: PRIORITY.urgent })));
    assert.equal(answers.filter((a) => a.ok).length, 4);
    const waits = answers.filter((a) => !a.ok) as { why: string; waitMs: number }[];
    assert.ok(waits.every((w) => w.why === "minute" && w.waitMs > 55_000 && w.waitMs <= 60_000));
    // The outbox's own claims share it: nothing more goes this minute.
    await queue(`${STAMP} over the minute`, "mention");
    const r = await drain();
    assert.equal(r.sent, 0);
    assert.ok(r.waitMs! > 55_000);
    assert.equal((await ours())[0].status, "queued");
  });

  test("sends are spread: the next waits out the gap", async () => {
    outbox.setOutboxForTests({ autoDrain: false, limits: { gapMs: 2_400, perMinute: 25 } });
    assert.equal((await outbox.takeMailSlot({ source: "t", priority: PRIORITY.urgent })).ok, true);
    const d = await outbox.takeMailSlot({ source: "t", priority: PRIORITY.urgent });
    assert.equal(d.ok, false);
    assert.equal((d as { why: string }).why, "gap");
    assert.ok((d as { waitMs: number }).waitMs > 2_000 && (d as { waitMs: number }).waitMs <= 2_400);
  });

  test("over the daily cap ordinary mail waits (queued, not bounced); urgent mail still goes", async () => {
    await pool().query("INSERT INTO mail_send_ledger (at, recipients, source) VALUES (now() - interval '3 hours', 9500, 'test')");
    await queue(`${STAMP} daily ordinary`, "mention");
    let r = await drain();
    assert.equal(r.sent, 0);
    assert.ok(r.waitMs! >= 20 * 3_600_000, "until the morning's sends age out");
    await queue(`${STAMP} daily urgent`, "helpdesk_reply");
    r = await drain();
    assert.equal(r.sent, 1);
    const rows = await ours();
    assert.deepEqual(rows.map((x) => [x.subject, x.status]), [[`${STAMP} daily ordinary`, "queued"], [`${STAMP} daily urgent`, "sent"]]);
    const v = await outbox.outboxView();
    assert.ok(v.day_recipients >= 9_501);
  });

  test("newsletters draw from the same budget and give way to waiting mail", async () => {
    outbox.setOutboxForTests({ autoDrain: false, limits: { gapMs: 0, perMinute: 3 } });
    await queue(`${STAMP} first`, "mention");
    await queue(`${STAMP} second`, "mention");
    assert.equal((await drain()).sent, 2);
    const nid = (await pool().query("INSERT INTO newsletters (subject, body, author_name, status) VALUES ($1, 'Body', 'Author', 'approved') RETURNING id", [`${STAMP} issue`])).rows[0].id;
    const got: string[] = [];
    delivery.setNewsletterSenderForTests(async (to) => void got.push(to[0]));
    try {
      await delivery.startNewsletterSend(nid, { subject: "Issue", text: "Body", html: "<p>Body</p>", from: "", attachments: [] }, ["n1@example.test", "n2@example.test", "n3@example.test"], { audience: "Everyone" });
      await pool().query("UPDATE newsletter_send_jobs SET last_batch_at = NULL, claimed_until = NULL WHERE newsletter_id = $1", [nid]);
      await delivery.newsletterDeliveryTick();
      assert.equal(got.length, 1, "two of the minute's three went to the outbox's mail");
      assert.equal((await delivery.newsletterDelivery(nid))!.queued, 2);
      // A waiting urgent message goes before the newsletter's next recipient.
      outbox.setOutboxForTests({ autoDrain: false, limits: UNPACED });
      await queue(`${STAMP} urgent while a newsletter runs`, "sign_in_link");
      const d = await outbox.takeMailSlot({ source: "newsletter" });
      assert.equal(d.ok, false, "bulk gives way");
      assert.equal((await drain()).sent, 1);
      assert.equal((await outbox.takeMailSlot({ source: "newsletter" })).ok, true);
    } finally {
      delivery.setNewsletterSenderForTests(null);
      await pool().query("DELETE FROM newsletters WHERE id = $1", [nid]);
    }
  });

  test("a newsletter told to slow down pauses the outbox too", async () => {
    const nid = (await pool().query("INSERT INTO newsletters (subject, body, author_name, status) VALUES ($1, 'Body', 'Author', 'approved') RETURNING id", [`${STAMP} issue 429`])).rows[0].id;
    delivery.setNewsletterSenderForTests(async () => {
      throw new send.MailSendError("Microsoft 365 is limiting how fast this app sends. Try again in 90 seconds.", 429, "ApplicationThrottled", "http", 90_000);
    });
    try {
      await delivery.startNewsletterSend(nid, { subject: "Issue", text: "Body", html: "<p>Body</p>", from: "", attachments: [] }, ["z1@example.test"], { audience: "Everyone" });
      await delivery.newsletterDeliveryTick();
      const v = await outbox.outboxView();
      assert.equal(v.paused?.kind, "rate");
      assert.ok(Date.parse(v.paused!.until!) > Date.now() + 80_000);
      await queue(`${STAMP} waits for the newsletter's pause`, "sign_in_link");
      assert.equal((await drain()).sent, 0);
    } finally {
      delivery.setNewsletterSenderForTests(null);
      await pool().query("DELETE FROM newsletters WHERE id = $1", [nid]);
    }
  });
});

// --- Microsoft's answers -----------------------------------------------------------------------------

describe("Microsoft's answers", () => {
  beforeEach(clean);

  test("429: the row stays queued with Retry-After (at least a minute), everything pauses; then it goes, once", async () => {
    fake.throttleNext = 1;
    fake.retryAfter = 5;
    await queue(`${STAMP} throttled`, "mention");
    await queue(`${STAMP} behind it`, "mention");
    const before = sent().length;
    const r = await drain();
    assert.equal(r.sent, 1, "one attempt, then the pause");
    assert.equal(sent().length, before, "nothing taken");
    const [a, b] = await ours();
    assert.equal(a.status, "queued");
    assert.ok(new Date(a.next_attempt_at).getTime() > Date.now() + 55_000, "at least a minute, though Microsoft said 5 seconds");
    assert.match(a.last_error, /limiting how fast/);
    assert.equal(b.status, "queued");
    const c = await control();
    assert.equal(c.pause_kind, "rate");
    assert.ok(new Date(c.paused_until).getTime() > Date.now() + 55_000);
    assert.equal((await outbox.takeMailSlot({ source: "newsletter" })).ok, false, "newsletters wait too");
    assert.deepEqual(notices, [], "a slow-down is not an admin's problem");
    // The minute passes.
    await pool().query("UPDATE mail_outbox_control SET paused_until = now() - interval '1 second' WHERE id = 1");
    await pool().query("UPDATE mail_outbox SET next_attempt_at = now() WHERE id > $1", [outboxFrom]);
    await drain();
    assert.equal(sent().length, before + 2);
    assert.equal(subjects().filter((s) => s === `${STAMP} throttled`).length, 1, "never doubled");
    assert.deepEqual((await ours()).map((x) => x.status), ["sent", "sent"]);
  });

  test("no answer after the request left: uncertain, never resent by itself; Retry sends it (the admin's choice)", async () => {
    fake.fail.sendMail = -2;
    await queue(`${STAMP} lost answer`, "mention");
    const before = sent().length;
    await drain();
    assert.equal(sent().length, before + 1, "Microsoft took it");
    const [r] = await ours();
    assert.equal(r.status, "uncertain");
    assert.equal(r.last_error, shared.UNCERTAIN_REASON);
    assert.ok(r.mime, "the body is kept for Retry");
    assert.deepEqual(notices, ["An email wasn't sent"]);
    delete fake.fail.sendMail;
    await drain();
    assert.equal(sent().length, before + 1, "the worker never sends it again");
    // The app may not read the mailbox (Mail.Send only): Sent Items answers 403, so it is left for an admin.
    await pool().query("UPDATE mail_outbox SET updated_at = now() - interval '2 minutes' WHERE id = $1", [r.id]);
    assert.equal(await outbox.settleUncertain(), 0);
    assert.deepEqual([(await row(Number(r.id))).status, (await row(Number(r.id))).settle_checks], ["uncertain", 3]);
    const api = await call(outboxRoute.PATCH, req(API, U.admin, { action: "retry", id: Number(r.id) }));
    assert.equal(api.status, 200);
    await drain();
    assert.equal(sent().length, before + 2);
    assert.equal((await row(Number(r.id))).status, "sent");
    assert.deepEqual((await audits("settings.mail_outbox_retry")).map((x) => x.details.was), ["uncertain"]);
  });

  test("an app that may read Sent Items settles an uncertain send by its Message-ID", async () => {
    app.roles = ["Mail.Send", "Mail.Read"];
    graphLib.clearM365TokensForTests();
    fake.fail.sendMail = -2;
    await queue(`${STAMP} settle me`, "mention");
    await drain();
    delete fake.fail.sendMail;
    const [r] = await ours();
    assert.equal(r.status, "uncertain");
    await pool().query("UPDATE mail_outbox SET updated_at = now() - interval '2 minutes' WHERE id = $1", [r.id]);
    assert.equal(await outbox.settleUncertain(), 1);
    const done = await row(Number(r.id));
    assert.deepEqual([done.status, done.mime], ["sent", null]);
  });

  test("no answer at sign-in: nothing left, so it is tried again (not uncertain)", async () => {
    graphLib.clearM365TokensForTests();
    fake.fail.token = -1;
    await queue(`${STAMP} sign-in timeout`, "mention");
    await drain();
    const [r] = await ours();
    assert.equal(r.status, "queued");
    assert.equal(r.posted_at, null);
    assert.ok(new Date(r.next_attempt_at).getTime() > Date.now() + 30_000);
    delete fake.fail.token;
    await pool().query("UPDATE mail_outbox SET next_attempt_at = now() WHERE id = $1", [r.id]);
    await drain();
    assert.equal((await row(Number(r.id))).status, "sent");
  });

  test("a refusal every message would get pauses the outbox with the reason, tells the admins once, and resumes when fixed", async () => {
    app.roles = [];
    graphLib.clearM365TokensForTests();
    await queue(`${STAMP} refused 1`, "mention");
    await queue(`${STAMP} refused 2`, "mention");
    await drain();
    let rows = await ours();
    assert.deepEqual(rows.map((x) => x.status), ["queued", "queued"], "nothing failed: they wait");
    const c = await control();
    assert.equal(c.pause_kind, "refusal");
    assert.equal(c.pause_reason, `The app isn't allowed to send as ${MAILBOX} (Mail.Send not granted or blocked by an application access policy).`);
    assert.deepEqual(notices, ["Email is paused"]);
    const v = await outbox.outboxView();
    assert.equal(v.paused?.kind, "refusal");
    assert.ok((await diagnostics.checkOutbox())!.status === "fail");
    // The pause runs out and the same refusal comes back: no second notice.
    await pool().query("UPDATE mail_outbox_control SET paused_until = now() WHERE id = 1");
    await pool().query("UPDATE mail_outbox SET next_attempt_at = now() WHERE id > $1", [outboxFrom]);
    await drain();
    assert.deepEqual(notices, ["Email is paused"]);
    // Fixed (as the admin's Check connection or a save would): Try now.
    app.roles = ["Mail.Send"];
    graphLib.clearM365TokensForTests();
    const api = await call(outboxRoute.PATCH, req(API, U.admin, { action: "resume" }));
    assert.equal(api.status, 200);
    await drain();
    rows = await ours();
    assert.deepEqual(rows.map((x) => x.status), ["sent", "sent"]);
    assert.equal((await control()).pause_kind, "");
    assert.equal((await audits("settings.mail_outbox_resume")).length, 1);
    // An admin got the bell notice.
    const bell = (await pool().query("SELECT title FROM notifications WHERE user_id = $1 AND title = 'Email is paused'", [U.admin.id])).rows;
    assert.equal(bell.length, 1);
  });

  test("a refusal of one message fails it with Microsoft's reason; 500 is tried again, then fails", async () => {
    let answer: Error = new send.MailSendError("Microsoft 365 refused the email (error 400, ErrorInvalidRecipients).", 400, "ErrorInvalidRecipients", "http");
    outbox.setOutboxForTests({ autoDrain: false, limits: UNPACED, post: async () => { throw answer; } });
    await queue(`${STAMP} bad recipient`, "mention");
    await drain();
    let [r] = await ours();
    assert.deepEqual([r.status, r.last_error], ["failed", "Microsoft 365 refused the email (error 400, ErrorInvalidRecipients)."]);
    assert.ok(r.mime, "kept until retried or discarded");
    const v = await outbox.outboxView();
    assert.equal(v.problems[0].id, Number(r.id));
    assert.equal(v.problems[0].can_retry, true);
    await clean();
    answer = new send.MailSendError("Microsoft 365 had a problem (error 500). Try again shortly.", 500, "", "http");
    outbox.setOutboxForTests({ autoDrain: false, limits: UNPACED, post: async () => { throw answer; } });
    await queue(`${STAMP} server error`, "mention");
    for (let i = 0; i < shared.MAIL_TRANSIENT_ATTEMPTS; i++) {
      await drain();
      [r] = await ours();
      if (i < shared.MAIL_TRANSIENT_ATTEMPTS - 1) {
        assert.equal(r.status, "queued", `attempt ${i + 1}`);
        await pool().query("UPDATE mail_outbox SET next_attempt_at = now() WHERE id = $1", [r.id]);
      }
    }
    assert.deepEqual([r.status, r.attempts], ["failed", shared.MAIL_TRANSIENT_ATTEMPTS]);
  });

  test("a claim left by an instance that died: back to queued when never posted, else uncertain", async () => {
    await queue(`${STAMP} never posted`, "mention");
    await queue(`${STAMP} posted`, "mention");
    const [a, b] = await ours();
    await pool().query("UPDATE mail_outbox SET status = 'sending', claimed_by = 'dead:1', claimed_at = now() - interval '10 minutes' WHERE id = ANY($1)", [[a.id, b.id]]);
    await pool().query("UPDATE mail_outbox SET posted_at = now() - interval '10 minutes' WHERE id = $1", [b.id]);
    // A fresh claim is not touched.
    await queue(`${STAMP} fresh claim`, "mention");
    const c = (await ours())[2];
    await pool().query("UPDATE mail_outbox SET status = 'sending', claimed_by = 'alive:1', claimed_at = now() WHERE id = $1", [c.id]);
    assert.deepEqual(await outbox.reclaimStale(), { requeued: 1, uncertain: 1 });
    assert.equal((await row(Number(a.id))).status, "queued");
    assert.deepEqual([(await row(Number(b.id))).status, (await row(Number(b.id))).last_error], ["uncertain", shared.UNCERTAIN_REASON]);
    assert.equal((await row(Number(c.id))).status, "sending");
  });
});

// --- SMTP --------------------------------------------------------------------------------------------

describe("SMTP: unchanged, and the switch away from Microsoft 365", () => {
  beforeEach(clean);
  after(async () => {
    await pool().query("DELETE FROM settings WHERE key = ANY($1)", [SMTP_KEYS]);
    await config.setMailMethod("m365", by(), { force: true });
  });

  test("by SMTP, sendMail sends on the spot and queues nothing", async () => {
    await config.setMailMethod("smtp", by(), { force: true });
    try {
      const n = (await ours()).length;
      // Not set up: refused at once, as before.
      await assert.rejects(() => mailer.sendMail(["r@example.test"], "x", "y"), /isn't set up yet/);
      // Set up against a port nothing listens on: the error comes from the attempt itself, in the call.
      for (const [k, v] of [["smtp_host", "127.0.0.1"], ["smtp_port", "1"], ["smtp_secure", "none"], ["smtp_from", "Docs <docs@smtp.example.test>"]]) await db.setSetting(k, v);
      await assert.rejects(() => mailer.sendMail(["r@example.test"], "x", "y"), (e: Error & { code?: string }) => /ECONNREFUSED|connect/i.test(`${e.code} ${e.message}`));
      assert.equal((await ours()).length, n, "nothing queued");
      const t = (await mailer.workspaceTransport())!;
      assert.equal(t.method, "smtp");
      assert.equal(t.send, t.sendNow, "the desk's transport sends on the spot");
    } finally {
      await config.setMailMethod("m365", by(), { force: true });
    }
  });

  test("switching to SMTP with mail waiting says how many; after the switch they go by SMTP, From the SMTP From", async () => {
    for (const [k, v] of [["smtp_host", "127.0.0.1"], ["smtp_port", "2525"], ["smtp_secure", "none"], ["smtp_from", "Docs <docs@smtp.example.test>"]]) await db.setSetting(k, v);
    await queue(`${STAMP} waiting 1`, "mention", ["one@example.test", "two@example.test"]);
    await queue(`${STAMP} waiting 2`, "digest");
    const w = await config.methodSwitchWarnings("smtp");
    assert.deepEqual(w, ["2 emails are still waiting in the Microsoft 365 outbox. After the switch they go out by SMTP from docs@smtp.example.test. To drop them instead, discard them under Outbox first."]);
    await assert.rejects(() => config.setMailMethod("smtp", by()), (e: Error & { code?: string }) => e.code === "confirm");
    const smtp: { raw: string; to: string[]; from: string }[] = [];
    outbox.setOutboxForTests({ autoDrain: false, limits: UNPACED, smtp: async (raw, env) => void smtp.push({ raw: raw.toString("utf8"), to: env.to, from: env.from }) });
    assert.equal(await config.setMailMethod("smtp", by(), { confirm: true }), true);
    const before = sent().length;
    await drain();
    assert.equal(sent().length, before, "nothing through Microsoft 365");
    assert.equal(smtp.length, 2);
    assert.deepEqual(smtp[0].to, ["one@example.test", "two@example.test"]);
    assert.equal(smtp[0].from, "docs@smtp.example.test");
    assert.match(smtp[0].raw, /^From: Docs <docs@smtp\.example\.test>$/m);
    assert.doesNotMatch(smtp[0].raw, new RegExp(MAILBOX.replace(/[.]/g, "\\.")));
    assert.deepEqual((await ours()).map((x) => x.status), ["sent", "sent"]);
    assert.ok((await config.methodSwitchWarnings("m365")).every((w) => !/still waiting/i.test(w)), "nothing about waiting mail the other way");
  });
});

// --- The admin's API ---------------------------------------------------------------------------------

describe("the admin's Outbox: view, Retry, Discard", () => {
  beforeEach(clean);

  test("admins only; the view never holds a body; Discard wipes it; audited", async () => {
    outbox.setOutboxForTests({ autoDrain: false, limits: UNPACED, post: async () => { throw new send.MailSendError("Microsoft 365 said the email was too large.", 413, "", "too_large"); } });
    await queue(`${STAMP} to discard`, "announcement", ["a@example.test", "b@example.test"]);
    await drain();
    assert.equal((await call(outboxRoute.GET, req(API, U.viewer, undefined, "GET"))).status, 403);
    assert.equal((await call(outboxRoute.PATCH, req(API, U.viewer, { action: "discard", id: 1 }))).status, 403);
    const g = await call(outboxRoute.GET, req(API, U.admin, undefined, "GET"));
    assert.equal(g.status, 200);
    assert.equal(g.body.m365, true);
    assert.equal(g.body.daily_limit, 10_000);
    const p = g.body.problems.find((x: { subject: string }) => x.subject === `${STAMP} to discard`);
    assert.deepEqual([p.status, p.recipients, p.recipient_count, p.kind, p.reason], ["failed", "a@example.test, b@example.test", 2, "announcement", "Microsoft 365 said the email was too large."]);
    assert.ok(!JSON.stringify(g.body).includes("enc:v1:"), "no body in the view");
    const d = await call(outboxRoute.PATCH, req(API, U.admin, { action: "discard", id: p.id }));
    assert.equal(d.status, 200);
    const r = await row(p.id);
    assert.deepEqual([r.status, r.mime], ["discarded", null]);
    assert.equal((await call(outboxRoute.PATCH, req(API, U.admin, { action: "retry", id: p.id }))).status, 409, "nothing left to retry");
    assert.equal((await call(outboxRoute.PATCH, req(API, U.admin, { action: "discard", id: p.id }))).status, 409);
    assert.deepEqual((await audits("settings.mail_outbox_discard")).map((x) => [x.details.id, x.details.was, x.details.recipients]), [[p.id, "failed", 2]]);
    for (const a of ["settings.mail_outbox_retry", "settings.mail_outbox_discard", "settings.mail_outbox_resume", "helpdesk.reply_mail_resent"]) assert.ok(labels.hasActionLabel(a), a);
  });

  test("pruned after 30 days; the budget's rows after a day", async () => {
    await queue(`${STAMP} old`, "mention");
    await drain();
    const [r] = await ours();
    await pool().query("UPDATE mail_outbox SET updated_at = now() - interval '31 days' WHERE id = $1", [r.id]);
    await pool().query("INSERT INTO mail_send_ledger (at, recipients, source) VALUES (now() - interval '26 hours', 1, 'old')");
    await outbox.pruneOutbox();
    assert.equal(await row(Number(r.id)), undefined);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM mail_send_ledger WHERE source = 'old'")).rows[0].n, 0);
  });
});

// --- The desk ----------------------------------------------------------------------------------------

describe("the desk: a reply's email that didn't go out shows on the message", () => {
  beforeEach(clean);

  test("accepted as queued and urgent; a failure shows on the message (agents only); Send again queues it again", async () => {
    const outside = `${STAMP}-customer@outside.example.test`;
    const t = await tickets.createTicket({ subject: `${STAMP} Printer`, body: "It jammed.", requester: { id: null, name: "Customer", email: outside }, via: "email", source: "email" } as never, { silent: true });
    ticketIds.push(t.id);
    const added = await messages.addMessage(t.id, { kind: "public", body: "Try turning it off and on.", author: { id: U.admin.id, name: U.admin.name, email: U.admin.email }, via: "desk" }, { silent: true });
    const mid = added!.message.id;
    await notifyMod.notifyReply(t.id, mid, { actorId: U.admin.id, actorName: U.admin.name });
    const rows = (await ours()).filter((x) => x.ref_type === "hd_message" && Number(x.ref_id) === mid);
    assert.equal(rows.length, 1, "the reply to the requester is queued with its message");
    assert.deepEqual([rows[0].kind, rows[0].priority, rows[0].recipients, rows[0].status], ["helpdesk_reply", 0, outside, "queued"]);
    // From the mailbox under the help address's name; the reply address and threading are in the MIME as before.
    const mime = Buffer.from(secretbox.openSecret(rows[0].mime), "base64").toString("utf8");
    assert.match(mime, new RegExp(`^From: .*<${MAILBOX.replace(/[.]/g, "\\.")}>`, "m"));
    assert.match(mime, /^References: <hd\./m);

    outbox.setOutboxForTests({ autoDrain: false, limits: UNPACED, post: async () => { throw new send.MailSendError("Microsoft 365 refused the email (error 400, ErrorInvalidRecipients).", 400, "ErrorInvalidRecipients", "http"); } });
    await drain();
    let list = await messages.listMessages(t.id, { mailState: true });
    let m = list.find((x) => x.id === mid)!;
    assert.deepEqual(m.mail_delivery, { state: "failed", to: outside, reason: "Microsoft 365 refused the email (error 400, ErrorInvalidRecipients).", can_resend: true });
    assert.equal((await messages.listMessages(t.id)).find((x) => x.id === mid)!.mail_delivery, undefined, "only the agent's view asks");
    assert.equal((access.requesterMessages(list).find((x) => x.id === mid) as { mail_delivery?: unknown }).mail_delivery, undefined, "never the requester's");

    outbox.setOutboxForTests({ autoDrain: false, limits: UNPACED });
    assert.equal(await outbox.resendForRef({ type: "hd_message", id: mid }, by()), 1);
    assert.equal(await outbox.resendForRef({ type: "hd_message", id: mid }, by()), 0, "nothing more to send again");
    const before = sent().length;
    await drain();
    assert.equal(sent().length, before + 1);
    list = await messages.listMessages(t.id, { mailState: true });
    m = list.find((x) => x.id === mid)!;
    assert.equal(m.mail_delivery, null, "sent: no line");
    assert.equal((await audits("helpdesk.reply_mail_resent")).length, 1);
  });

  test("the settings page's test mails are still sent at once", async () => {
    const before = sent().length;
    const r = await email.sendMailboxTestMail({ id: 999_998, address: "help@firm.example", name: "Firm Help" }, "me@example.test");
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(sent().length, before + 1);
    assert.equal((await ours()).length, 0, "nothing queued");
  });
});

// --- 1.20.32 review fixes ----------------------------------------------------------------------------

describe("review fixes: a changed mailbox, claims, the budget, the waiting list, test sends", () => {
  beforeEach(clean);

  test("H1: a message queued before the sending mailbox changed goes out From the new one (its name kept)", async () => {
    const NEW = `outbox-new@${STAMP}.example.test`;
    fake.addMailbox(NEW, "shared");
    await mailer.sendMail(["r@example.test"], `${STAMP} queued under the old mailbox`, "Body", undefined, "HR Team <hr@firm.example>", undefined, { kind: "mention" });
    const before = (await ours())[0];
    assert.match(Buffer.from(secretbox.openSecret(before.mime), "base64").toString("utf8"), new RegExp(`^From: .*<${MAILBOX.replace(/[.]/g, "\\.")}>`, "m"));
    await config.saveM365SendConfig({ tenant: app.tenant, client_id: app.appId, secret: app.secrets[0], mailbox: NEW, from_name: "Firm Docs" }, by());
    fake.strictFrom = true;
    try {
      await drain();
      const mb = fake.mailboxes.get(NEW)!;
      assert.equal(mb.sent.length, 1, "Exchange took it: no SendAsDenied");
      const mime = mb.sent[0].toString("utf8");
      assert.match(mime, new RegExp(`^From: "?HR Team"? <${NEW.replace(/[.]/g, "\\.")}>`, "m"), "the name kept, the address the new mailbox's");
      assert.match(mime, /^Reply-To: HR Team <hr@firm\.example>/m, "a chosen sender's Reply-To is left as it is");
      assert.equal((await row(Number(before.id))).status, "sent");
      // A Reply-To that was the old mailbox follows it.
      const old = Buffer.from(`From: Docs <${MAILBOX}>\r\nReply-To: ${MAILBOX}\r\nTo: a@x.test\r\n\r\nBody`);
      const moved = (await outbox.fromForMailbox(old, NEW)).toString("utf8");
      assert.match(moved, new RegExp(`^Reply-To: ${NEW.replace(/[.]/g, "\\.")}`, "m"));
      assert.equal(outbox.fromForMailbox.length >= 2, true);
      assert.equal((await outbox.fromForMailbox(Buffer.from(`From: <${NEW}>\r\n\r\nx`), NEW)).toString("utf8"), `From: <${NEW}>\r\n\r\nx`, "already right: untouched");
    } finally {
      fake.strictFrom = false;
      await config.saveM365SendConfig({ tenant: app.tenant, client_id: app.appId, secret: app.secrets[0], mailbox: MAILBOX, from_name: "Firm Docs" }, by());
    }
  });

  test("H1: a refusal for everyone is capped per message, rotates the probe, and one refused again after others went out fails at once", async () => {
    const refusal = () => new send.MailSendError(`The app isn't allowed to send as ${MAILBOX} (Mail.Send not granted or blocked by an application access policy).`, 403, "ErrorAccessDenied", "http");
    let refuse = (_s: string) => true;
    const posted: string[] = [];
    outbox.setOutboxForTests({
      autoDrain: false,
      limits: UNPACED,
      post: async (mime) => {
        const subj = mime.toString("utf8").match(/^Subject: (.*)$/m)?.[1] ?? "";
        posted.push(subj);
        if (refuse(subj)) throw refusal();
      },
    });
    const due = () => pool().query("UPDATE mail_outbox_control SET paused_until = now() WHERE id = 1");
    await queue(`${STAMP} A`, "mention");
    await queue(`${STAMP} B`, "mention");
    await drain();
    let [a, b] = await ours();
    assert.deepEqual([a.status, a.refusals, b.status], ["queued", 1, "queued"]);
    assert.ok(new Date(a.next_attempt_at).getTime() > new Date((await control()).paused_until).getTime(), "A goes to the back, past the pause");
    // The pause ends: B is the probe, not A again. B goes (the problem is gone for B).
    refuse = (s) => s.endsWith(" A");
    await due();
    await drain();
    [a, b] = await ours();
    assert.deepEqual(posted, [`${STAMP} A`, `${STAMP} B`]);
    assert.equal(b.status, "sent");
    // A's turn comes; refused again although B went out since: the refusal is A's own, so A fails, and nothing more waits behind it.
    await pool().query("UPDATE mail_outbox SET next_attempt_at = now() WHERE id = $1", [a.id]);
    await drain();
    a = await row(Number(a.id));
    assert.deepEqual([a.status, a.last_error], ["failed", refusal().message]);
    // A real refusal for everyone: one message is refused at most MAIL_REFUSAL_ATTEMPTS times, then fails with the count.
    await clean();
    outbox.setOutboxForTests({ autoDrain: false, limits: UNPACED, post: async () => { throw refusal(); } });
    await queue(`${STAMP} alone`, "mention");
    for (let i = 0; i < shared.MAIL_REFUSAL_ATTEMPTS; i++) {
      await due();
      await pool().query("UPDATE mail_outbox SET next_attempt_at = now() WHERE id > $1 AND status = 'queued'", [outboxFrom]);
      await drain();
    }
    const [c] = await ours();
    assert.equal(c.status, "failed");
    assert.match(c.last_error, new RegExp(`\\(refused ${shared.MAIL_REFUSAL_ATTEMPTS} times\\)$`));
  });

  test("M1: a claim taken back before the post sends nothing; late writes never undo a reclaim, a Retry or a Discard", async () => {
    let posts = 0;
    let takeOnce = true;
    outbox.setOutboxForTests({
      autoDrain: false,
      limits: UNPACED,
      beforePost: async () => {
        if (!takeOnce) return;
        takeOnce = false;
        // This instance stalled; another took the claim back (never posted, so back to the queue).
        assert.deepEqual(await outbox.reclaimStale(0), { requeued: 1, uncertain: 0 });
      },
      post: async () => void posts++,
    });
    await queue(`${STAMP} stalled`, "mention");
    await drain();
    assert.equal(posts, 1, "posted once, by the claim that held it, never by the one that lost it");
    assert.equal((await ours())[0].status, "sent");
    // A slow-down answered after the claim was taken back and the admin retried: the late requeue changes nothing.
    await clean();
    outbox.setOutboxForTests({
      autoDrain: false,
      limits: UNPACED,
      post: async () => {
        await outbox.reclaimStale(0); // posted: uncertain
        const [r] = await ours();
        await outbox.retryOutboxMessage(Number(r.id), by());
        throw new send.MailSendError("Microsoft 365 is limiting how fast this app sends. Try again in 5 seconds.", 429, "", "http", 5_000);
      },
    });
    await queue(`${STAMP} late answer`, "mention");
    await drain();
    const r = (await ours())[0];
    assert.deepEqual([r.status, r.last_error, r.attempts], ["queued", "", 0], "the admin's Retry stands");
    // A late "sent" for a discarded row does not bring it back.
    await clean();
    outbox.setOutboxForTests({
      autoDrain: false,
      limits: UNPACED,
      post: async () => {
        await pool().query("UPDATE mail_outbox SET status = 'discarded', mime = NULL, claimed_by = NULL WHERE id > $1", [outboxFrom]);
      },
    });
    await queue(`${STAMP} discarded meanwhile`, "mention");
    await drain();
    assert.equal((await ours())[0].status, "discarded");
  });

  test("M2: the budget counts only what may have reached Microsoft; slow-downs don't use up a message's tries", async () => {
    const ledgerFor = async () => Number((await pool().query("SELECT count(*)::int AS n FROM mail_send_ledger WHERE id > $1 AND source = 'outbox'", [ledgerFrom])).rows[0].n);
    // No answer at sign-in, a slow-down, a refusal of one message: nothing reached Microsoft, nothing counted.
    graphLib.clearM365TokensForTests();
    fake.fail.token = -1;
    await queue(`${STAMP} sign-in timeout`, "mention");
    await drain();
    delete fake.fail.token;
    assert.equal(await ledgerFor(), 0);
    let [r] = await ours();
    assert.equal(r.signin_failures, 1);
    await clean();
    for (let i = 0; i < shared.MAIL_TRANSIENT_ATTEMPTS + 2; i++) {
      fake.throttleNext = 1;
      if (i === 0) await queue(`${STAMP} throttled often`, "mention");
      await pool().query("UPDATE mail_outbox_control SET paused_until = NULL WHERE id = 1");
      await pool().query("UPDATE mail_outbox SET next_attempt_at = now() WHERE id > $1", [outboxFrom]);
      await drain();
    }
    [r] = await ours();
    assert.deepEqual([r.status, r.transient_attempts], ["queued", 0], "seven slow-downs, still queued: they are not tries");
    assert.equal(await ledgerFor(), 0);
    outbox.setOutboxForTests({ autoDrain: false, limits: UNPACED, post: async () => { throw new send.MailSendError("Microsoft 365 refused the email (error 400, ErrorInvalidRecipients).", 400, "ErrorInvalidRecipients", "http"); } });
    await pool().query("UPDATE mail_outbox_control SET paused_until = NULL WHERE id = 1");
    await pool().query("UPDATE mail_outbox SET next_attempt_at = now() WHERE id > $1", [outboxFrom]);
    await drain();
    assert.equal(await ledgerFor(), 0, "a refused message is given back too");
    // Sent and uncertain count.
    outbox.setOutboxForTests({ autoDrain: false, limits: UNPACED });
    await queue(`${STAMP} counted`, "mention");
    await drain();
    fake.fail.sendMail = -2;
    await queue(`${STAMP} counted, may have gone`, "mention");
    await drain();
    delete fake.fail.sendMail;
    assert.equal(await ledgerFor(), 2);
    // A newsletter's slot comes back when its send reached nothing.
    const slot = await outbox.takeMailSlot({ source: "newsletter" });
    assert.ok(slot.ok && slot.slotId);
    await outbox.releaseMailSlot(slot.slotId);
    assert.equal(Number((await pool().query("SELECT count(*)::int AS n FROM mail_send_ledger WHERE id = $1", [slot.slotId])).rows[0].n), 0);
  });

  test("M3: the waiting messages are listed, and Discard all waiting empties the queue (audited)", async () => {
    await queue(`${STAMP} wait 1`, "digest");
    await queue(`${STAMP} wait 2`, "sign_in_link");
    const v = await outbox.outboxView();
    assert.equal(v.queued, 2);
    assert.deepEqual(v.waiting.map((w) => [w.subject, w.priority, w.status]), [[`${STAMP} wait 2`, 0, "queued"], [`${STAMP} wait 1`, 2, "queued"]]);
    const r = await call(outboxRoute.PATCH, req(API, U.admin, { action: "discard_waiting" }));
    assert.equal(r.status, 200);
    assert.equal(r.body.discarded, 2);
    assert.equal(r.body.outbox.queued, 0);
    assert.deepEqual((await ours()).map((x) => [x.status, x.mime]), [["discarded", null], ["discarded", null]]);
    assert.deepEqual((await audits("settings.mail_outbox_discard_all")).map((x) => x.details.discarded), [2]);
    assert.ok(labels.hasActionLabel("settings.mail_outbox_discard_all"));
    assert.equal((await call(outboxRoute.PATCH, req(API, U.viewer, { action: "discard_waiting" }))).status, 403);
  });

  test("M4: a newsletter's test send is direct, so the author hears Microsoft's answer at once", async () => {
    const input = { subject: `${STAMP} test issue`, markdown: "Hello", orgName: "Firm", logoUrl: "", accent: "#2e75bd", origin: "", authorName: "Author", to: { emails: ["author@example.test"] } };
    const before = sent().length;
    assert.deepEqual(await newsletterLib.sendNewsletter(input), { sent: 1 });
    assert.equal(sent().length, before + 1, "sent in the call");
    assert.equal((await ours()).length, 0, "never queued");
    app.roles = [];
    graphLib.clearM365TokensForTests();
    const r = await newsletterLib.sendNewsletter(input);
    assert.equal(r.sent, 0);
    assert.match(r.error!, /isn't allowed to send as/);
  });

  test("Low 1: more recipients than one send may have is refused at enqueue; Low 9: quoted local parts are addresses", async () => {
    const many = Array.from({ length: shared.MAIL_MAX_RECIPIENTS + 1 }, (_, i) => `p${i}@example.test`);
    await assert.rejects(() => mailer.sendMail(many, "Too many", "Body"), (e: Error & { code?: string }) => e.code === "too_many_recipients" && /501 recipients/.test(e.message));
    assert.equal((await ours()).length, 0);
    outbox.setOutboxForTests({ autoDrain: false, limits: { ...UNPACED, safeCap: 3 } });
    await assert.rejects(() => mailer.sendMail(["a@x.test", "b@x.test", "c@x.test", "d@x.test"], "Over the day", "Body"), /at most 3/);
    outbox.setOutboxForTests({ autoDrain: false, limits: UNPACED });
    assert.deepEqual(outbox.addressList(['"john doe"@example.test, Ann <ann@example.test>']), ['"john doe"@example.test', "ann@example.test"]);
    // Recipients given but none an address: kept as a failed row the admin sees, not only a log line.
    const t = (await mailer.workspaceTransport())!;
    await t.send({ from: t.from, to: "undisclosed-recipients:;", subject: `${STAMP} nobody`, text: "x" });
    const [r] = await ours();
    assert.equal(r.status, "failed");
    assert.match(r.last_error, /None of this email's recipients is an email address/);
    assert.ok((await outbox.outboxView()).problems.some((p) => p.id === Number(r.id)));
  });

  test("Low 2: Retry starts the counts again; Low 3: a refusal never shortens Microsoft's pause, and Try now never lifts it", async () => {
    outbox.setOutboxForTests({ autoDrain: false, limits: UNPACED, post: async () => { throw new send.MailSendError("Microsoft 365 refused the email (error 400).", 400, "", "http"); } });
    await queue(`${STAMP} retry counts`, "mention");
    await drain();
    let [r] = await ours();
    assert.deepEqual([r.status, r.attempts], ["failed", 1]);
    await outbox.retryOutboxMessage(Number(r.id), by());
    [r] = await ours();
    assert.deepEqual([r.status, r.attempts, r.transient_attempts, r.refusals], ["queued", 0, 0, 0]);
    await clean();
    await outbox.pauseOutboxForRate(30 * 60_000, "slow down");
    await outbox.pauseOutboxForRefusal("The app isn't allowed to send.");
    let c = await control();
    assert.equal(c.pause_kind, "refusal");
    assert.ok(new Date(c.paused_until).getTime() > Date.now() + 29 * 60_000, "not shortened to 10 minutes");
    const api = await call(outboxRoute.PATCH, req(API, U.admin, { action: "resume" }));
    assert.equal(api.status, 200);
    c = await control();
    assert.equal(c.pause_kind, "rate", "Microsoft's slow-down is kept");
    assert.ok(new Date(c.paused_until).getTime() > Date.now() + 29 * 60_000);
    assert.equal(api.body.outbox.paused.kind, "rate");
  });

  test("Low 5: a leftover row going by SMTP is stamped before the hand-over (a crash is uncertain, not resent)", async () => {
    for (const [k, v] of [["smtp_host", "127.0.0.1"], ["smtp_port", "2525"], ["smtp_secure", "none"], ["smtp_from", "Docs <docs@smtp.example.test>"]]) await db.setSetting(k, v);
    await queue(`${STAMP} smtp stamp`, "mention");
    let stamped: unknown = "not seen";
    outbox.setOutboxForTests({
      autoDrain: false,
      limits: UNPACED,
      smtp: async () => {
        stamped = (await ours())[0].posted_at;
        await outbox.reclaimStale(0);
        throw new Error("the process died here");
      },
    });
    await config.setMailMethod("smtp", by(), { confirm: true });
    try {
      await drain();
      assert.ok(stamped && stamped !== "not seen", "posted_at set before the hand-over");
      const [r] = await ours();
      assert.equal(r.status, "uncertain", "taken back as uncertain, and the late error changes nothing");
    } finally {
      await config.setMailMethod("m365", by(), { force: true });
      await pool().query("DELETE FROM settings WHERE key = ANY($1)", [SMTP_KEYS]);
    }
  });

  test("Low 7: Send again is refused on a merged ticket, and audited against the ticket", async () => {
    const outside = `${STAMP}-merged@outside.example.test`;
    const t = await tickets.createTicket({ subject: `${STAMP} To merge`, body: "x", requester: { id: null, name: "C", email: outside }, via: "email", source: "email" } as never, { silent: true });
    const keep = await tickets.createTicket({ subject: `${STAMP} Kept`, body: "x", requester: { id: null, name: "C", email: outside }, via: "email", source: "email" } as never, { silent: true });
    ticketIds.push(t.id, keep.id);
    const added = await messages.addMessage(t.id, { kind: "public", body: "Reply", author: { id: U.admin.id, name: U.admin.name, email: U.admin.email }, via: "desk" }, { silent: true });
    const mid = added!.message.id;
    outbox.setOutboxForTests({ autoDrain: false, limits: UNPACED, post: async () => { throw new send.MailSendError("Microsoft 365 refused the email (error 400).", 400, "", "http"); } });
    await notifyMod.notifyReply(t.id, mid, { actorId: U.admin.id, actorName: U.admin.name });
    await drain();
    const url = `http://localhost/api/helpdesk/tickets/${t.number}/messages/${mid}/resend`;
    const params = { params: Promise.resolve({ number: String(t.number), id: String(mid) }) };
    const post = (r: Request) => resendRoute.POST(r, params);
    const ok = await call(post, req(url, U.admin, {}, "POST"));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const a = (await pool().query("SELECT target_type, target_id, details FROM audit_log WHERE action = 'helpdesk.reply_mail_resent' AND id > $1 ORDER BY id DESC LIMIT 1", [auditFrom])).rows[0];
    assert.deepEqual([a.target_type, a.target_id, a.details.ticket, a.details.message], ["helpdesk_ticket", String(t.id), t.number, mid]);
    await drain();
    await pool().query("UPDATE hd_tickets SET merged_into = $2 WHERE id = $1", [t.id, keep.id]);
    const refused = await call(post, req(url, U.admin, {}, "POST"));
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /merged into/);
  });

  test("Low 8: Send again shows no 'waiting' line straight away (it counts from the last enqueue)", async () => {
    await queue(`${STAMP} old but retried`, "mention");
    const [r] = await ours();
    await pool().query("UPDATE mail_outbox SET created_at = now() - interval '1 hour', queued_at = now() - interval '1 hour', status = 'failed', ref_type = 'hd_message', ref_id = -77 WHERE id = $1", [r.id]);
    await outbox.retryOutboxMessage(Number(r.id), by());
    const fresh = await row(Number(r.id));
    assert.ok(new Date(fresh.queued_at).getTime() > Date.now() - 60_000);
  });
});
