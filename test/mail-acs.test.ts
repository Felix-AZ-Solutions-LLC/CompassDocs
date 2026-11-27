// 1.21.5: email through Azure Communication Services, the parts that need no
// database: the configuration (lib/mail-acs-config, the start-up check and
// the connection-string refusal in cloud mode), a built message read back
// into ACS's JSON (lib/mail-acs-mime: recipients, Reply-To, text and HTML,
// attachments and their size limit, headers), the client against a fake
// ACS (lib/mail-acs, test/helpers/fake-acs: the managed identity's token,
// the access key's HMAC signature, send, the operation lookup, 429 with
// Retry-After, how each refusal is read), the hourly pacing, and that no key
// or token reaches a log line. Nothing here contacts Azure.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/mail-acs.test.ts

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
import { startFakeAcs, type FakeAcs } from "./helpers/fake-acs";
import { ACS_SCOPE, MAIL_ACS_MAX_BYTES, acsConfig, acsProblems, checkMailTransportStartup, parseAcsConnectionString, type AcsConfig } from "../src/lib/mail-acs-config";
import { acsRequestFromMime, parseBuiltMime, parseParams } from "../src/lib/mail-acs-mime";
import { acsRequestFor, getAcsOperation, operationSentence, postAcsEmail, probeAcs, resetAcsForTests, retryAfterMs, sendAcsNow, setAcsWaitForTests } from "../src/lib/mail-acs";
import { MailSendError } from "../src/lib/mail-send-error";
import { setAzureCredentialForTests } from "../src/lib/azure-credential";
import { acsPace, classifySendError, paceDecision, PRIORITY } from "../src/lib/mail-outbox-shared";
import { redact } from "../src/lib/log";

const SENDER = "DoNotReply@mail.example.test";
const KEY = Buffer.from("a-development-access-key-for-the-fake-acs").toString("base64");
const ENDPOINT = "https://acme-mail.communication.azure.com";

/** A message as lib/mail-m365 buildMime builds it (the same nodemailer settings). */
async function build(m: Parameters<ReturnType<typeof nodemailer.createTransport>["sendMail"]>[0]): Promise<Buffer> {
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  return (await composer.sendMail(m)).message as unknown as Buffer;
}

describe("configuration", () => {
  test("unset: nothing is read, nothing is said; ACS variables alone are only a warning", () => {
    assert.equal(acsConfig({}), null);
    assert.deepEqual(acsProblems({}), { fatal: [], warnings: [] });
    const p = acsProblems({ COMPASSDOCS_ACS_ENDPOINT: ENDPOINT });
    assert.deepEqual(p.fatal, []);
    assert.match(p.warnings[0], /COMPASSDOCS_MAIL_TRANSPORT is not "acs"/);
  });

  test("another transport name is refused, naming where SMTP and Microsoft 365 are chosen", () => {
    const p = acsProblems({ COMPASSDOCS_MAIL_TRANSPORT: "smtp" });
    assert.match(p.fatal[0], /must be "acs" or unset/);
  });

  test("the managed identity: the endpoint and the sender, ACS's default limits", () => {
    const c = acsConfig({ COMPASSDOCS_MAIL_TRANSPORT: "ACS", COMPASSDOCS_ACS_ENDPOINT: `${ENDPOINT}/`, COMPASSDOCS_ACS_SENDER: SENDER })!;
    assert.deepEqual(c, { endpoint: ENDPOINT, sender: SENDER, auth: { kind: "entra", scope: "https://communication.azure.com/.default" }, replyTo: "", perMinute: 30, perHour: 100 });
    assert.equal(ACS_SCOPE, "https://communication.azure.com/.default");
    const shared = acsConfig({ COMPASSDOCS_MAIL_TRANSPORT: "acs", COMPASSDOCS_ACS_ENDPOINT: ENDPOINT, COMPASSDOCS_ACS_SENDER: SENDER, COMPASSDOCS_ACS_PER_MINUTE: "10", COMPASSDOCS_ACS_PER_HOUR: "40" })!;
    assert.equal(shared.perMinute, 10);
    assert.equal(shared.perHour, 40);
  });

  test("settings that can't work are refused, one sentence each", () => {
    const base = { COMPASSDOCS_MAIL_TRANSPORT: "acs" };
    assert.match(acsProblems(base).fatal.join(" "), /COMPASSDOCS_ACS_SENDER is not set.*COMPASSDOCS_ACS_ENDPOINT is not set/);
    assert.match(acsProblems({ ...base, COMPASSDOCS_ACS_SENDER: `"Acme" <${SENDER}>`, COMPASSDOCS_ACS_ENDPOINT: ENDPOINT }).fatal[0], /one email address alone/);
    assert.match(acsProblems({ ...base, COMPASSDOCS_ACS_SENDER: SENDER, COMPASSDOCS_ACS_ENDPOINT: "http://acme.communication.azure.com" }).fatal[0], /https/);
    assert.match(acsProblems({ ...base, COMPASSDOCS_ACS_SENDER: SENDER, COMPASSDOCS_ACS_ENDPOINT: `${ENDPOINT}/?code=x` }).fatal[0], /no key or query/);
    assert.match(acsProblems({ ...base, COMPASSDOCS_ACS_SENDER: SENDER, COMPASSDOCS_ACS_ENDPOINT: `${ENDPOINT}/emails` }).fatal[0], /resource's address only/);
    assert.match(acsProblems({ ...base, COMPASSDOCS_ACS_SENDER: SENDER, COMPASSDOCS_ACS_ENDPOINT: ENDPOINT, COMPASSDOCS_ACS_PER_HOUR: "0" }).fatal[0], /COMPASSDOCS_ACS_PER_HOUR must be a whole number/);
    assert.match(acsProblems({ ...base, COMPASSDOCS_ACS_SENDER: SENDER, COMPASSDOCS_ACS_ENDPOINT: "https://mail.example.com" }).warnings[0], /not a \*\.communication\.azure\.com address/);
    assert.equal(acsConfig({ ...base, COMPASSDOCS_ACS_SENDER: SENDER, COMPASSDOCS_ACS_ENDPOINT: "http://acme" }), null);
  });

  test("a connection string: parsed; refused in cloud mode unless it is a loopback endpoint; allowed self-hosted with a warning", () => {
    assert.deepEqual(parseAcsConnectionString(`endpoint=${ENDPOINT}/;accesskey=${KEY}`), { endpoint: ENDPOINT, accessKey: KEY });
    assert.equal(parseAcsConnectionString("endpoint=;accesskey="), null);
    const env = { COMPASSDOCS_MAIL_TRANSPORT: "acs", COMPASSDOCS_ACS_SENDER: SENDER, COMPASSDOCS_ACS_CONNECTION_STRING: `endpoint=${ENDPOINT}/;accesskey=${KEY}` };
    const cloud = acsProblems({ ...env, COMPASSDOCS_CLOUD: "1" });
    assert.match(cloud.fatal[0], /COMPASSDOCS_ACS_CONNECTION_STRING is for development only: cloud mode signs in with its managed identity/);
    assert.equal(acsConfig({ ...env, COMPASSDOCS_CLOUD: "1" }), null);
    const local = { ...env, COMPASSDOCS_CLOUD: "1", COMPASSDOCS_ACS_CONNECTION_STRING: `endpoint=http://127.0.0.1:9/;accesskey=${KEY}` };
    assert.deepEqual(acsProblems(local).fatal, []);
    assert.deepEqual(acsConfig(local)!.auth, { kind: "key", accessKey: KEY });
    const selfHosted = acsProblems(env);
    assert.deepEqual(selfHosted.fatal, []);
    assert.match(selfHosted.warnings[0], /holds the resource's access key/);
    assert.equal(acsConfig(env)!.endpoint, ENDPOINT);
    assert.match(acsProblems({ ...env, COMPASSDOCS_ACS_CONNECTION_STRING: "nonsense" }).fatal[0], /can't be read/);
    // No sentence repeats the key.
    for (const s of [...cloud.fatal, ...selfHosted.warnings]) assert.ok(!s.includes(KEY));
  });

  test("start-up: a connection string to a real resource stops cloud mode, saying why and never the key; a good setting is one info line", async () => {
    const lines: { level: string; event: string; message: string }[] = [];
    const log = (level: "info" | "warn" | "error", event: string, f: Record<string, unknown>) => void lines.push({ level, event, message: String(f.message) });
    let code: number | null = null;
    const ok = await checkMailTransportStartup(log, (c) => void (code = c), {
      COMPASSDOCS_CLOUD: "1",
      COMPASSDOCS_MAIL_TRANSPORT: "acs",
      COMPASSDOCS_ACS_SENDER: SENDER,
      COMPASSDOCS_ACS_CONNECTION_STRING: `endpoint=${ENDPOINT}/;accesskey=${KEY}`,
    });
    assert.equal(ok, false);
    assert.equal(code, 1);
    assert.equal(lines[0].event, "mail.refused_to_start");
    assert.ok(lines.every((l) => !l.message.includes(KEY)));
    lines.length = 0;
    assert.equal(await checkMailTransportStartup(log, () => assert.fail("must not exit"), { COMPASSDOCS_MAIL_TRANSPORT: "acs", COMPASSDOCS_ACS_SENDER: SENDER, COMPASSDOCS_ACS_ENDPOINT: ENDPOINT }), true);
    assert.deepEqual(lines.map((l) => l.event), ["mail.transport"]);
    assert.match(lines[0].message, /from DoNotReply@mail\.example\.test at acme-mail\.communication\.azure\.com \(managed identity\), at most 30 a minute and 100 an hour/);
    lines.length = 0;
    assert.equal(await checkMailTransportStartup(log, () => assert.fail("must not exit"), {}), true);
    assert.deepEqual(lines, []);
  });
});

describe("a built message as ACS's request", () => {
  test("recipients, subject, text and HTML, Reply-To, attachments and headers", async () => {
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10, 0x80]);
    const html = `<p>${"Grüße aus dem Büro — ".repeat(20)}</p><p><a href="https://acme.example/x?y=1&z=2">Open</a></p>`;
    const mime = await build({
      from: `"Acme Helpdesk" <help@acme.example>`,
      to: [`"Zoë Ångström" <zoe@example.test>`, "bob@example.test"],
      cc: "carol@example.test",
      subject: "Résumé of ticket #42 — done ✓",
      text: "Line one\nLine two — ✓",
      html,
      messageId: "<msg-42@acme.example>",
      references: "<orig-1@example.test>",
      inReplyTo: "<orig-1@example.test>",
      headers: { "List-Unsubscribe": "<https://acme.example/u/abc>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", "Auto-Submitted": "auto-replied" },
      attachments: [
        { filename: "Übersicht März.pdf", content: pdf },
        { filename: "notes.txt", content: "plain notes" },
      ],
    });
    const req = acsRequestFromMime(mime, { sender: SENDER, rcpt: ["zoe@example.test", "bob@example.test", "carol@example.test", "dave@example.test"], replyTo: "office@acme.example" });
    assert.equal(req.senderAddress, SENDER);
    assert.deepEqual(req.recipients.to, [{ address: "zoe@example.test", displayName: "Zoë Ångström" }, { address: "bob@example.test" }]);
    assert.deepEqual(req.recipients.cc, [{ address: "carol@example.test" }]);
    // In the envelope but in neither header: Bcc.
    assert.deepEqual(req.recipients.bcc, [{ address: "dave@example.test" }]);
    assert.equal(req.content.subject, "Résumé of ticket #42 — done ✓");
    assert.equal(req.content.plainText?.replace(/\r\n/g, "\n"), "Line one\nLine two — ✓");
    assert.equal(req.content.html, html);
    // From another address than the sender: answers go to it.
    assert.deepEqual(req.replyTo, [{ address: "help@acme.example", displayName: "Acme Helpdesk" }]);
    assert.equal(req.attachments?.length, 2);
    assert.deepEqual(req.attachments![0], { name: "Übersicht März.pdf", contentType: "application/pdf", contentInBase64: pdf.toString("base64") });
    assert.equal(Buffer.from(req.attachments![1].contentInBase64, "base64").toString(), "plain notes");
    assert.equal(req.attachments![1].contentType, "text/plain");
    assert.equal(req.headers?.["Message-ID"], "<msg-42@acme.example>");
    assert.equal(req.headers?.["In-Reply-To"], "<orig-1@example.test>");
    assert.equal(req.headers?.["References"], "<orig-1@example.test>");
    assert.equal(req.headers?.["List-Unsubscribe"], "<https://acme.example/u/abc>");
    assert.equal(req.headers?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.equal(req.headers?.["Auto-Submitted"], "auto-replied");
    for (const structural of ["From", "To", "Cc", "Subject", "Date", "MIME-Version", "Content-Type", "Reply-To"]) assert.equal(req.headers?.[structural], undefined, structural);
    assert.equal(req.userEngagementTrackingDisabled, true);
  });

  test("Reply-To: the message's own, else its From when it is not the sender, else the workspace's reply address, else none", async () => {
    const own = await build({ from: SENDER, replyTo: `"Desk" <desk@acme.example>`, to: "a@example.test", subject: "s", text: "t" });
    assert.deepEqual(acsRequestFromMime(own, { sender: SENDER, replyTo: "office@acme.example" }).replyTo, [{ address: "desk@acme.example", displayName: "Desk" }]);
    const plain = await build({ from: SENDER, to: "a@example.test", subject: "s", text: "t" });
    assert.deepEqual(acsRequestFromMime(plain, { sender: SENDER, replyTo: "office@acme.example" }).replyTo, [{ address: "office@acme.example" }]);
    assert.equal(acsRequestFromMime(plain, { sender: SENDER.toLowerCase() }).replyTo, undefined);
    // HTML only, and text only.
    const htmlOnly = acsRequestFromMime(await build({ from: SENDER, to: "a@example.test", subject: "s", html: "<b>x</b>" }), { sender: SENDER });
    assert.deepEqual(htmlOnly.content, { subject: "s", html: "<b>x</b>" });
    assert.deepEqual(acsRequestFromMime(plain, { sender: SENDER }).content, { subject: "s", plainText: "t" });
  });

  test("parameters: quoted, RFC 2231 continuations and charsets", () => {
    assert.deepEqual(parseParams(`attachment; filename="a; b.txt"`), { value: "attachment", params: { filename: "a; b.txt" } });
    assert.equal(parseParams("attachment; filename*0*=utf-8''%C3%9Cber; filename*1*=sicht.pdf").params.filename, "Übersicht.pdf");
    assert.equal(parseParams("text/plain; charset=utf-8").value, "text/plain");
  });

  test("a message that can't be read back, and one over 10 MB with its attachments base64-encoded, are refused before anything is sent", async () => {
    const c: AcsConfig = { endpoint: "http://127.0.0.1:9", sender: SENDER, auth: { kind: "key", accessKey: KEY }, replyTo: "", perMinute: 30, perHour: 100 };
    assert.throws(() => acsRequestFor(Buffer.from("no headers here"), c), (e: unknown) => e instanceof MailSendError && e.code === "unreadable");
    const fits = await build({ from: SENDER, to: "a@example.test", subject: "s", text: "t", attachments: [{ filename: "a.bin", content: Buffer.alloc(7_000_000, 1) }] });
    assert.ok(acsRequestFor(fits, c).attachments);
    const big = await build({ from: SENDER, to: "a@example.test", subject: "s", text: "t", attachments: [{ filename: "a.bin", content: Buffer.alloc(7_600_000, 1) }] });
    assert.throws(
      () => acsRequestFor(big, c),
      (e: unknown) => e instanceof MailSendError && e.name === "MailTooLargeError" && e.kind === "too_large" && /at most 10\.0 MB per email, about 7\.5 MB of files/.test(e.message)
    );
    assert.equal(classifySendError({ name: "MailTooLargeError", kind: "too_large", status: 413 }), "failed");
    assert.equal(MAIL_ACS_MAX_BYTES, 10_000_000);
    // The parse alone sees no recipients in a message without any.
    assert.throws(() => acsRequestFromMime(Buffer.from("Subject: x\r\n\r\nbody"), { sender: SENDER }), /no recipients/);
    assert.equal(parseBuiltMime(Buffer.from("Subject: =?UTF-8?B?w5w=?=\r\nTo: a@example.test\r\n\r\nbody")).subject, "Ü");
  });
});

describe("the client, against a fake ACS", () => {
  let fake: FakeAcs;
  const scopes: string[] = [];
  const TOKEN = "eyJhbGciOiJub25lIn0.eyJhdWQiOiJodHRwczovL2NvbW11bmljYXRpb24uYXp1cmUuY29tIn0.c2lnbmF0dXJlLXRoaXM";
  const entra = (): AcsConfig => ({ endpoint: fake.base, sender: SENDER, auth: { kind: "entra", scope: ACS_SCOPE }, replyTo: "", perMinute: 30, perHour: 100 });
  const keyed = (): AcsConfig => ({ endpoint: fake.base, sender: SENDER, auth: { kind: "key", accessKey: KEY }, replyTo: "", perMinute: 30, perHour: 100 });
  const waits: number[] = [];
  let mime: Buffer;

  before(async () => {
    fake = await startFakeAcs();
    setAcsWaitForTests(async (ms) => void waits.push(ms));
    mime = await build({ from: SENDER, to: "reader@example.test", subject: "Hello", text: "Body", html: "<p>Body</p>" });
  });
  after(async () => {
    setAcsWaitForTests(null);
    setAzureCredentialForTests(null);
    resetAcsForTests();
    await fake.close();
  });
  beforeEach(() => {
    fake.reset();
    fake.token = TOKEN;
    fake.accessKey = null;
    scopes.length = 0;
    waits.length = 0;
    resetAcsForTests();
    setAzureCredentialForTests({
      getToken: async (s) => {
        scopes.push(String(s));
        return { token: TOKEN, expiresOnTimestamp: Date.now() + 3_600_000 };
      },
    });
  });

  test("send: the managed identity's token for ACS's scope, our Operation-Id, the request as built, api-version 2023-03-31; then its result", async () => {
    const op = await postAcsEmail(acsRequestFor(mime, entra()), entra(), "4b1f7c2e-1a2b-4c3d-8e9f-0123456789ab");
    assert.deepEqual(op, { id: "4b1f7c2e-1a2b-4c3d-8e9f-0123456789ab", status: "Running", error: "", retryAfterMs: 1000 });
    assert.deepEqual(scopes, ["https://communication.azure.com/.default"]);
    const [r] = fake.sends();
    assert.equal(r.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(r.headers["operation-id"], "4b1f7c2e-1a2b-4c3d-8e9f-0123456789ab");
    assert.equal(r.headers["content-type"], "application/json");
    assert.equal(r.json.senderAddress, SENDER);
    assert.deepEqual(r.json.recipients, { to: [{ address: "reader@example.test" }] });
    assert.deepEqual(r.json.content, { subject: "Hello", plainText: "Body", html: "<p>Body</p>" });
    const done = await getAcsOperation(op.id, entra());
    assert.equal(done.status, "Succeeded");
    // The token is cached: a second call does not ask again.
    assert.equal(scopes.length, 1);
  });

  test("a connection string signs each request with HMAC-SHA256 over the method, path, date, host and body hash", async () => {
    fake.token = null;
    fake.accessKey = KEY;
    const op = await postAcsEmail(acsRequestFor(mime, keyed()), keyed());
    assert.equal(op.status, "Running");
    const r = fake.sends()[0];
    assert.match(String(r.headers.authorization), /^HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=/);
    assert.ok(r.headers["x-ms-date"] && r.headers["x-ms-content-sha256"]);
    assert.equal((await getAcsOperation(op.id, keyed())).status, "Succeeded");
    // A wrong key is refused (the fake checks the signature).
    const wrong = { ...keyed(), auth: { kind: "key" as const, accessKey: Buffer.from("another-key").toString("base64") } };
    await assert.rejects(postAcsEmail(acsRequestFor(mime, wrong), wrong), (e: unknown) => e instanceof MailSendError && e.status === 401 && e.kind === "auth");
    assert.equal(scopes.length, 0, "a key needs no Entra token");
  });

  test("Failed and Canceled carry ACS's reason; an unknown operation is not_found", async () => {
    fake.outcome = () => ({ status: "Failed", error: { code: "EmailDroppedAllRecipientsSuppressed", message: "Message dropped because all recipients were suppressed" } });
    const op = await postAcsEmail(acsRequestFor(mime, entra()), entra());
    const failed = await getAcsOperation(op.id, entra());
    assert.equal(failed.status, "Failed");
    assert.equal(operationSentence(failed), "Azure Communication Services could not deliver this email: Message dropped because all recipients were suppressed.");
    assert.equal(operationSentence({ id: "x", status: "Canceled", error: "", retryAfterMs: null }), "Azure Communication Services canceled this email.");
    await assert.rejects(getAcsOperation("0000aaaa-0000-0000-0000-000000000000", entra()), (e: unknown) => e instanceof MailSendError && e.code === "not_found");
  });

  test("429 with Retry-After: a slow-down, not a failure; a direct send waits it out and goes", async () => {
    fake.sendQueue.push({ status: 429, headers: { "retry-after": "7" }, body: { error: { code: "TooManyRequests", message: "Too many requests" } } });
    await assert.rejects(postAcsEmail(acsRequestFor(mime, entra()), entra()), (e: unknown) => {
      assert.ok(e instanceof MailSendError);
      assert.equal(e.status, 429);
      assert.equal(e.retryAfterMs, 7000);
      assert.equal(classifySendError(e), "rate");
      return true;
    });
    fake.sendQueue.push({ status: 429, headers: { "retry-after-ms": "1500", "retry-after": "9" } });
    const op = await sendAcsNow(mime, { config: entra() });
    assert.deepEqual(waits, [1500]);
    assert.equal(op.status, "Running");
    assert.equal(fake.sends().length, 3);
    // Without waiting (a newsletter recipient: its job pauses instead).
    fake.sendQueue.push({ status: 429, headers: { "retry-after": "3" } });
    await assert.rejects(sendAcsNow(mime, { config: entra(), wait429: false }), (e: unknown) => (e as MailSendError).status === 429);
    assert.equal(retryAfterMs(new Headers({ "retry-after": new Date(Date.now() + 5000).toUTCString() })) !== null, true);
  });

  test("each refusal is read for the outbox: identity, sender, this message, ACS's own trouble, no answer", async () => {
    const send = async () => postAcsEmail(acsRequestFor(mime, entra()), entra()).then(() => null, (e: MailSendError) => e);
    fake.token = "another-token";
    const denied = (await send())!;
    assert.equal(denied.status, 401);
    assert.equal(classifySendError(denied), "repeat");
    assert.match(denied.message, /Communication and Email Service Owner role/);
    assert.ok(!denied.message.includes(TOKEN));
    fake.token = TOKEN;
    fake.sendQueue.push({ status: 400, body: { error: { code: "InvalidSenderUserName", message: "The sender username is not valid for this domain." } } });
    const sender = (await send())!;
    assert.equal(sender.kind, "config");
    assert.equal(classifySendError(sender), "repeat");
    assert.match(sender.message, /COMPASSDOCS_ACS_SENDER/);
    fake.sendQueue.push({ status: 400, body: { error: { code: "BadRequest", message: "Recipient address is invalid." } } });
    assert.equal(classifySendError((await send())!), "failed");
    fake.sendQueue.push({ status: 500, body: { error: { code: "InternalError", message: "oops" } } });
    assert.equal(classifySendError((await send())!), "transient");
    fake.sendQueue.push("drop");
    const gone = (await send())!;
    assert.equal(gone.status, 0);
    assert.equal(classifySendError(gone), "uncertain");
  });

  test("the token service: a refusal says so and sends nothing; no answer is transient", async () => {
    setAzureCredentialForTests({ getToken: async () => Promise.reject(Object.assign(new Error("ManagedIdentityCredential: identity not found"), { name: "CredentialUnavailableError" })) });
    resetAcsForTests();
    await assert.rejects(postAcsEmail(acsRequestFor(mime, entra()), entra()), (e: unknown) => e instanceof MailSendError && e.kind === "auth" && /Microsoft Entra token for https:\/\/communication\.azure\.com\/\.default/.test(e.message));
    setAzureCredentialForTests({ getToken: async () => Promise.reject(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })) });
    resetAcsForTests();
    await assert.rejects(postAcsEmail(acsRequestFor(mime, entra()), entra()), (e: unknown) => e instanceof MailSendError && e.kind === "signin" && e.status === 0);
    assert.equal(fake.sends().length, 0);
  });

  test("a direct send that waits for its result (the test email): Succeeded returns, Failed throws ACS's reason", async () => {
    const ok = await sendAcsNow(mime, { config: entra(), waitResult: true });
    assert.equal(ok.status, "Succeeded");
    fake.outcome = (op) => (op.polls < 2 ? { status: "Running" } : { status: "Failed", error: { code: "Bounced", message: "Recipient mailbox does not exist" } });
    await assert.rejects(sendAcsNow(mime, { config: entra(), waitResult: true }), /could not deliver this email: Recipient mailbox does not exist/);
  });

  test("probe: signs in and looks up an operation that does not exist, sending nothing", async () => {
    assert.deepEqual(await probeAcs(entra()), { ok: true, message: `Signed in to ${new URL(fake.base).host} as the app's managed identity. Nothing was sent.` });
    fake.token = "another-token";
    const bad = await probeAcs(entra());
    assert.equal(bad.ok, false);
    assert.match(bad.message, /refused/);
    assert.equal(fake.sends().length, 0);
  });
});

describe("pacing and logs", () => {
  test("the hourly limit holds the next send until the oldest of the hour ages out", () => {
    const lim = acsPace(30, 100);
    assert.equal(lim.gapMs, 2000);
    const now = 10_000_000;
    const hour = Array.from({ length: 100 }, (_, i) => now - 3_000_000 + i * 1000);
    const d = paceDecision({ nowMs: now, pausedUntilMs: null, lastAtMs: hour[99], minute: [], dayRecipients: 100, hour }, 1, PRIORITY.normal, lim);
    assert.deepEqual(d, { ok: false, why: "hour", waitMs: hour[0] + 3_600_000 - now });
    assert.deepEqual(paceDecision({ nowMs: now, pausedUntilMs: null, lastAtMs: hour[99], minute: [], dayRecipients: 99, hour: hour.slice(1) }, 1, PRIORITY.normal, lim), { ok: true });
    // Microsoft 365 has no hourly limit: the same hour passes.
    assert.deepEqual(paceDecision({ nowMs: now, pausedUntilMs: null, lastAtMs: hour[99], minute: [], dayRecipients: 100, hour }, 1, PRIORITY.normal, { ...lim, perHour: Number.POSITIVE_INFINITY }), { ok: true });
  });

  test("no access key, request signature or token reaches a log line", () => {
    const cs = `endpoint=${ENDPOINT}/;accesskey=${KEY}`;
    const env = { COMPASSDOCS_ACS_CONNECTION_STRING: cs };
    const line = redact(`connecting with ${cs} and Authorization: HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=abcDEF123+/= then Bearer eyJabc12345.eyJdef67890.sig`, env);
    assert.ok(!line.includes(KEY));
    assert.ok(!line.includes("abcDEF123"));
    assert.ok(!line.includes("eyJdef67890"));
    assert.match(redact(`accesskey=${KEY}`, {}), /accesskey=\[redacted\]/);
  });
});
