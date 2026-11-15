// Helpdesk 1.20.9: printing an email's original ("View original" → Print):
// GET /api/helpdesk/messages/[id]/original?print=1 (lib/helpdesk/email-html-print).
//
//   - who may print it: the same as who may view it (signed out, a requester,
//     a CC, an agent of another team, a session that owes the desk its Duo
//     approval, unlicensed, the recycle bin), and the same rate limit, shared
//     with viewing; not audited;
//   - the headers of each variant (print=1, print=1&images=1, and the view's
//     own two unchanged), and next.config.js stating the same, in an order
//     where the print rules win; the last print value counts, as Next reads it;
//   - the print header: the ticket, From, the ticket's CCs, received in the
//     workspace's time zone, printed by and when, an internal note said so;
//     every value is the sender's or a person's own text, so hostile values
//     are tested to come out as text;
//   - the email is kept apart from the header: its markup and CSS live in a
//     declarative shadow root, its @page rules are neutralised, a document
//     that does not read back in the expected shape is refused;
//   - pictures: remote ones only with images=1, cid: ones always, http never.
//
// Route handlers are called directly with real sessions (next/headers and
// lib/ee stubbed, as test/helpdesk-merge-bulk does). The Duo desk rule is
// stubbed for this process alone (what lib/auth reads from duo-policy), so
// the workspace's Duo settings are never touched. Parallel-safe: teams,
// people, tickets and files are this file's own (STAMP); the role matrix is
// read through the process-local test seam.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-email-html-print.test.ts

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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-email-html-print.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-email-html-print.virtual.js");
const POLICY_STUB = path.join(__dirname, "stubs", "duo-policy.helpdesk-email-html-print.virtual.js");
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
const shared = require("../src/lib/helpdesk/email-html-shared") as typeof import("../src/lib/helpdesk/email-html-shared");
const retention = require("../src/lib/helpdesk/retention") as typeof import("../src/lib/helpdesk/retention");
const retentionShared = require("../src/lib/helpdesk/retention-shared") as typeof import("../src/lib/helpdesk/retention-shared");
const bin = require("../src/lib/helpdesk/recycle-bin") as typeof import("../src/lib/helpdesk/recycle-bin");
const detail = require("../src/lib/helpdesk/detail") as typeof import("../src/lib/helpdesk/detail");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const apiTokens = require("../src/lib/helpdesk/api-tokens") as typeof import("../src/lib/helpdesk/api-tokens");
const dbLib = require("../src/lib/db") as typeof import("../src/lib/db");
const printLib = require("../src/lib/helpdesk/email-html-print") as typeof import("../src/lib/helpdesk/email-html-print");
const printShared = require("../src/lib/helpdesk/email-html-print-shared") as typeof import("../src/lib/helpdesk/email-html-print-shared");
const settingsStore = require("../src/lib/settings-store") as typeof import("../src/lib/settings-store");
const format = require("../src/lib/format") as typeof import("../src/lib/format");
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

const STAMP = `hdprint${Date.now().toString(36)}${process.pid}`;
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
  uploads = await mkdtemp(path.join(tmpdir(), "compass-email-html-print-"));
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
  await sanitize.stopSanitizeWorkerForTests(); // 1.20.8 runs the sanitiser in a worker; let the test process exit
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

/** GET the print view (or another variant of the original) as `who`. */
function printed(messageId: number, session: string | null, query = "?print=1"): Promise<Answer> {
  html.resetOriginalCacheForTests();
  return call(originalRoute.GET, req(`/messages/${messageId}/original${query}`, session), { id: String(messageId) });
}

const parseDoc = (s: string) => new JSDOM(s, { virtualConsole: new VirtualConsole() }).window.document;
/** The email's part of a print document: its shadow root's template content, as a browser attaches it. */
const emailPart = (doc: Document) => (doc.querySelector(".cd-mail > .cd-host > template") as HTMLTemplateElement).content;
const headOf = (doc: Document) => doc.querySelector("header.cd-head") as HTMLElement;
/** The header's rows: label → value. */
function rows(doc: Document): Record<string, string> {
  const out: Record<string, string> = {};
  const dts = [...headOf(doc).querySelectorAll("dt")];
  for (const dt of dts) out[dt.textContent ?? ""] = dt.nextElementSibling?.textContent ?? "";
  return out;
}
const lines = (doc: Document) => [...headOf(doc).querySelectorAll("p")].map((p) => p.textContent ?? "");

const VIEW_CSP = (images: boolean) =>
  `default-src 'none'; img-src data:${images ? " https:" : ""}; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-popups allow-popups-to-escape-sandbox`;
const PRINT_CSP = (images: boolean) =>
  `default-src 'none'; img-src data:${images ? " https:" : ""}; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox allow-popups allow-popups-to-escape-sandbox allow-modals`;

// --- Who may print it ---------------------------------------------------------------------------------

describe("who may print it", () => {
  let msgId = 0;
  let noteId = 0;
  let number = 0;
  before(async () => {
    const { t, first } = await opened(mail(P.req, { html: "<p>Who can print me?</p>" }));
    msgId = first.id;
    number = t.number;
    await deliver(mail(P.agent, { subject: `Re: [#${t.number} ref:${t.reply_token}]`, inReplyTo: `<hd-note-${t.reply_token}-0a0b0c@desk.example>`, html: "<p>Agents only.</p>" }));
    noteId = (await messagesOf(t.id)).find((m) => m.kind === "internal")!.id;
    // Priya is copied on the ticket: a CC reads the conversation in Get help, never the original.
    await pool().query("INSERT INTO hd_ticket_ccs (ticket_id, user_id, email, name) VALUES ($1, $2, $3, $4)", [t.id, P.req2.id, P.req2.email, P.req2.name]);
  });

  test("an agent who works the ticket prints the email and the internal note (said so on the header); every team's agent too", async () => {
    const r = await printed(msgId, P.agent.session);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers.get("content-type"), "text/html; charset=utf-8");
    const doc = parseDoc(r.text);
    assert.match(emailPart(doc).textContent ?? "", /Who can print me\?/);
    assert.ok(!lines(doc).includes(printShared.HD_ORIGINAL_PRINT_COPY.internal));
    const note = await printed(noteId, P.agent2.session);
    assert.equal(note.status, 200);
    const nd = parseDoc(note.text);
    assert.match(emailPart(nd).textContent ?? "", /Agents only\./);
    assert.ok(lines(nd).includes(printShared.HD_ORIGINAL_PRINT_COPY.internal));
    assert.equal((await printed(msgId, P.manager.session)).status, 200);
  });

  test("signed out 401; the requester 403; a CC 403; an agent of another team 404; a message with no original 404", async () => {
    assert.equal((await printed(msgId, null)).status, 401);
    for (const who of [P.req, P.req2]) {
      for (const id of [msgId, noteId]) {
        const r = await printed(id, who.session);
        assert.equal(r.status, 403);
        assert.ok(!r.text.includes("Who can print me") && !r.text.includes("Agents only") && !r.text.includes("cd-head"));
      }
    }
    for (const id of [msgId, noteId]) assert.equal((await printed(id, P.other.session)).status, 404);
    const plain = await opened(mail(P.req, { text: "Plain text only." }));
    assert.equal((await printed(plain.first.id, P.agent.session)).status, 404);
    assert.equal((await printed(plain.first.id, P.agent.session, "?print=1&images=1")).status, 404);
  });

  test("a session that owes the desk its Duo approval: 401 mfa_required, nothing of the email or the ticket", async () => {
    owesDuo.add(P.agent.session);
    try {
      const r = await printed(msgId, P.agent.session, "?print=1&images=1");
      assert.equal(r.status, 401);
      assert.equal(r.body.code, "mfa_required");
      assert.ok(!r.text.includes("Who can print me") && !r.text.includes(String(number)));
    } finally {
      owesDuo.delete(P.agent.session);
    }
    assert.equal((await printed(msgId, P.agent.session)).status, 200);
  });

  test("unlicensed: 402", async () => {
    licensed = false;
    try {
      assert.equal((await printed(msgId, P.agent.session)).status, 402);
    } finally {
      licensed = true;
    }
  });

  test("a ticket in the recycle bin: 404 while it is there", async () => {
    const manager = (await dbLib.getUserById(P.manager.id))!;
    const [b] = await bin.binTickets(manager, [number]);
    assert.ok(b.ok, JSON.stringify(b));
    try {
      assert.equal((await printed(msgId, P.manager.session)).status, 404);
    } finally {
      const [r] = await bin.restoreTickets(manager, [number]);
      assert.ok(r.ok, JSON.stringify(r));
    }
    assert.equal((await printed(msgId, P.agent.session)).status, 200);
  });

  test("the rate limit is the view's own and shared with it: 120 reads a minute in all, then 429", async () => {
    const rater = await person("rater", "Rui Rater");
    await deskRole(rater.id, "agent");
    await member(T1, rater.id);
    await grant(rater.id, ["helpdesk.request"], "rater");
    for (let i = 0; i < 60; i++) assert.equal((await call(originalRoute.GET, req(`/messages/${msgId}/original`, rater.session), { id: String(msgId) })).status, 200);
    for (let i = 0; i < 60; i++) assert.equal((await call(originalRoute.GET, req(`/messages/${msgId}/original?print=1`, rater.session), { id: String(msgId) })).status, 200);
    assert.equal((await printed(msgId, rater.session)).status, 429);
    assert.equal((await printed(msgId, rater.session, "")).status, 429);
  });

  test("not audited: printing an original is reading a message", async () => {
    await printed(msgId, P.agent.session);
    await printed(msgId, P.agent.session, "?print=1&images=1");
    const n = (await pool().query("SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND (action LIKE '%original%' OR action LIKE '%print%')", [P.agent.id])).rows[0].n;
    assert.equal(n, 0);
  });
});

// --- The policy ------------------------------------------------------------------------------------------

describe("the policy of each variant", () => {
  let msgId = 0;
  before(async () => {
    msgId = (await opened(mail(P.req, { html: "<p>Policy</p>" }))).first.id;
  });

  test("print=1 and print=1&images=1 each have their own policy; the view's two are unchanged", async () => {
    for (const [q, csp] of [
      ["", VIEW_CSP(false)],
      ["?images=1", VIEW_CSP(true)],
      ["?print=1", PRINT_CSP(false)],
      ["?print=1&images=1", PRINT_CSP(true)],
      ["?images=1&print=1", PRINT_CSP(true)],
    ] as const) {
      const r = await printed(msgId, P.agent.session, q);
      assert.equal(r.status, 200, q);
      assert.equal(r.headers.get("content-security-policy"), csp, q);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff", q);
      assert.equal(r.headers.get("referrer-policy"), "no-referrer", q);
      assert.equal(r.headers.get("cache-control"), "private, no-store", q);
      assert.equal(r.headers.get("x-frame-options"), q.includes("print") ? "DENY" : "SAMEORIGIN", q);
      assert.equal(r.headers.get("cross-origin-resource-policy"), "same-origin", q);
      assert.equal(/class="cd-head"/.test(r.text), q.includes("print"), q);
    }
    // Never scripts, never its own origin: the print sandbox adds allow-modals alone.
    for (const images of [false, true]) {
      const csp = printLib.originalPrintHeaders(images)["Content-Security-Policy"];
      assert.doesNotMatch(csp, /allow-scripts|allow-same-origin|script-src|unsafe-eval/);
      assert.match(csp, /(^|; )default-src 'none'(;|$)/);
    }
    // Whatever a base policy says, the print policy drops scripts and same-origin from its sandbox.
    assert.equal(
      printLib.originalPrintCsp("default-src 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-same-origin allow-popups allow-forms"),
      "default-src 'none'; frame-ancestors 'none'; sandbox allow-popups allow-modals"
    );
  });

  test("next.config.js states each policy for production, the print rules last so they win", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require("../next.config.js") as { headers: () => Promise<{ source: string; has?: { type: string; key: string; value?: string }[]; headers: { key: string; value: string }[] }[]> };
    const all = await config.headers();
    const rules = all.filter((h) => h.source === "/api/helpdesk/messages/:id/original");
    assert.equal(rules.length, 6); // 1.20.11: and the inline variant's two (test/helpdesk-email-inline)
    // Apply the rules as Next does (every matching rule in order, the last value of a key wins) to each query.
    const applied = (query: Record<string, string>) => {
      const h = new Map<string, string>();
      for (const r of all) {
        if (r.source !== "/api/helpdesk/messages/:id/original" && r.source !== "/((?!addin).*)") continue;
        if ((r.has ?? []).every((c) => c.type === "query" && query[c.key] !== undefined && new RegExp(`^${c.value}$`).test(query[c.key]))) {
          for (const x of r.headers) h.set(x.key, x.value);
        }
      }
      return h;
    };
    assert.equal(applied({}).get("Content-Security-Policy"), html.originalHeaders(false)["Content-Security-Policy"]);
    assert.equal(applied({ images: "1" }).get("Content-Security-Policy"), html.originalHeaders(true)["Content-Security-Policy"]);
    assert.equal(applied({ print: "1" }).get("Content-Security-Policy"), printLib.originalPrintHeaders(false)["Content-Security-Policy"]);
    assert.equal(applied({ print: "1", images: "1" }).get("Content-Security-Policy"), printLib.originalPrintHeaders(true)["Content-Security-Policy"]);
    assert.equal(applied({ print: "1" }).get("Content-Security-Policy"), PRINT_CSP(false));
    assert.equal(applied({ print: "1", images: "1" }).get("Content-Security-Policy"), PRINT_CSP(true));
    assert.equal(applied({ print: "1" }).get("X-Frame-Options"), "DENY");
    assert.equal(applied({ print: "1", images: "1" }).get("Referrer-Policy"), "no-referrer");
    assert.equal(applied({ print: "2" }).get("Content-Security-Policy"), VIEW_CSP(false), "only print=1 is the print view");
    const general = all.findIndex((h) => h.source === "/((?!addin).*)");
    assert.ok(all.findIndex((h) => h.has?.some((c) => c.key === "print")) > general);
  });

  test("a repeated print, or a repeated images beside print=1, is refused with 400; format=info stays the info", async () => {
    for (const q of ["?print=1&print=0", "?print=0&print=1", "?print=1&print=1", "?print=1&images=1&images=0", "?images=1&print=1&images=1"]) {
      const r = await printed(msgId, P.agent.session, q);
      assert.equal(r.status, 400, q);
      assert.ok(!r.text.includes("Policy") && !r.text.includes("cd-head"), q);
    }
    assert.equal((await printed(msgId, P.agent.session, "?print=0")).headers.get("content-security-policy"), VIEW_CSP(false), "only print=1 is the print view");
    const info = await printed(msgId, P.agent.session, "?format=info&print=1");
    assert.equal(info.status, 200);
    assert.equal(info.body.ok, true);
  });

  test("too complex: 422 with the sentence, under the print policy", async () => {
    const { first } = await opened(mail(P.req, { html: "<div>".repeat(shared.EMAIL_HTML_LIMITS.depth + 50) + "deep" }));
    for (const q of ["?print=1", "?print=1&images=1"]) {
      const r = await printed(first.id, P.agent.session, q);
      assert.equal(r.status, 422);
      assert.ok(r.text.includes(shared.HD_ORIGINAL_COPY.tooComplex), r.text.slice(0, 300));
      assert.equal(r.headers.get("content-security-policy"), PRINT_CSP(false));
    }
  });
});

// --- The print header ----------------------------------------------------------------------------------

describe("the print header", () => {
  test("the ticket, From, the ticket's CCs, received in the workspace's time zone, printed by whom and when", async () => {
    const { t, first } = await opened(mail(P.req, { subject: `${STAMP} Printer jams on page 2`, html: "<p>Printer jams on <b>page 2</b>.</p>" }));
    await pool().query("INSERT INTO hd_ticket_ccs (ticket_id, user_id, email, name) VALUES ($1, NULL, $2, $3)", [t.id, "sam.lee@clientco.example", "Sam Lee"]);
    const r = await printed(first.id, P.agent.session);
    assert.equal(r.status, 200, r.text);
    const doc = parseDoc(r.text);
    assert.equal(doc.title, `Print #${t.number} original email`);
    assert.equal(headOf(doc).querySelector("h1")!.textContent, `#${t.number} ${STAMP} Printer jams on page 2`);
    const settings = await settingsStore.getAppSettings();
    const created = (await pool().query("SELECT created_at FROM hd_messages WHERE id = $1", [first.id])).rows[0].created_at as string | Date;
    const zone = settings.timezone ? ` (${settings.timezone})` : "";
    assert.deepEqual(rows(doc), {
      From: `Daniel Okafor <${P.req.email}>`,
      "CCs on the ticket": "Sam Lee <sam.lee@clientco.example>",
      Received: `${format.formatDateTime(new Date(created).toISOString(), settings)}${zone}`,
    });
    const last = lines(doc).at(-1)!;
    assert.ok(last.startsWith("Printed by Ana Kowalski on "), last);
    assert.ok(last.endsWith(`${zone}.`), last);
    // On screen: the bar that says how to print, hidden on paper.
    assert.equal(doc.querySelector(".cd-bar")!.textContent, printShared.HD_ORIGINAL_PRINT_COPY.bar);
    const css = doc.head.querySelector("style")!.textContent ?? "";
    assert.match(css, /@media print \{\n  html, body \{ background: #fff; \}\n  \.cd-bar \{ display: none; \}/);
    assert.match(css, /@page \{/);
    assert.match(css, /counter\(pages\)/);
    assert.match(css, new RegExp(`Ticket #${t.number} `));
    // The email as the dialog shows it, in its shadow root.
    assert.match(emailPart(doc).querySelector(".cd-body")!.innerHTML, /Printer jams on <b>page 2<\/b>\./);
    // No CCs: "None".
    const solo = await opened(mail(P.req, { html: "<p>Solo</p>" }));
    assert.equal(rows(parseDoc((await printed(solo.first.id, P.agent.session)).text))["CCs on the ticket"], "None");
  });

  test("hostile values (the subject, the sender's name and address, a CC's name) come out as text, never markup", async () => {
    const { t, first } = await opened(mail(P.req, { html: "<p>Body</p>" }));
    const subject = `</title></style><script>alert(1)</script><img src=x onerror=alert(2)> "quoted" & 'single' </template><!--`;
    const name = `"><svg onload=alert(3)><b>Boss</b>`;
    const addr = `x"@evil.example<script>alert(4)</script>`;
    await pool().query("UPDATE hd_tickets SET subject = $2 WHERE id = $1", [t.id, subject]);
    await pool().query("UPDATE hd_messages SET author_name = $2, author_email = $3 WHERE id = $1", [first.id, name, addr]);
    await pool().query("INSERT INTO hd_ticket_ccs (ticket_id, user_id, email, name) VALUES ($1, NULL, $2, $3)", [t.id, "cc@clientco.example", "<i>Ivy</i>\n Injected: line"]);
    const r = await printed(first.id, P.agent.session, "?print=1&images=1");
    assert.equal(r.status, 200, r.text);
    assert.ok(printLib.hasExpectedShape(r.text), "the document reads back in its shape");
    const doc = parseDoc(r.text);
    assert.equal(headOf(doc).querySelector("h1")!.textContent, `#${t.number} ${subject}`);
    assert.deepEqual(
      { From: rows(doc).From, CC: rows(doc)["CCs on the ticket"] },
      { From: `${name} <${addr}>`, CC: "<i>Ivy</i> Injected: line <cc@clientco.example>" }
    );
    // Nothing of it became an element, in the head or the body: ours are the only ones outside the email's template.
    assert.equal(doc.querySelectorAll("script, img, svg, b, i, iframe").length, 0);
    assert.equal(doc.head.children.length, 4);
    assert.equal(doc.title, `Print #${t.number} original email`);
    assert.ok(!r.text.includes("<script>") && !r.text.includes("<svg") && !r.text.includes("<img src=x"));
    assert.ok(r.text.includes("&lt;/title&gt;&lt;/style&gt;&lt;script&gt;alert(1)&lt;/script&gt;"));
  });

  test("the email's own CSS and markup stay with the email: it cannot hide, restyle or forge the header", async () => {
    const hostile =
      `<html><head><style>.cd-head{display:none!important} header,h1,dl{visibility:hidden} body > *{display:none} :root{background:red}` +
      ` @page { margin: 0; @top-left { content: "FAKE" } } @PAGE :first { size: 10mm }</style></head>` +
      `<body style="margin-top:-500px"><div class="cd-head"><h1>#1 Invoice approved</h1>From: ceo@acme.example</div>` +
      `<p>&lt;/template&gt;&lt;div class="cd-head"&gt;</p><p style="position:fixed;top:0">Fixed</p><style>@page{margin:0}</style></body></html>`;
    const { first } = await opened(mail(P.req, { html: hostile }));
    const r = await printed(first.id, P.agent.session);
    assert.equal(r.status, 200, r.text);
    assert.ok(printLib.hasExpectedShape(r.text));
    const doc = parseDoc(r.text);
    // One header in the document's own tree, ours; the email's copy is inside the template.
    assert.equal(doc.querySelectorAll(".cd-head").length, 1);
    assert.equal(doc.querySelectorAll("header.cd-head").length, 1);
    const part = emailPart(doc);
    assert.equal(part.querySelectorAll("div.cd-head").length, 1);
    assert.match(part.textContent ?? "", /<\/template><div class="cd-head">/, "the text stays text");
    // The email's style sheets are in the shadow tree, their @page rules neutralised; ours is the page's only one.
    const theirs = [...part.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
    assert.match(theirs, /\.cd-head\{display:none!important\}/);
    assert.doesNotMatch(theirs, /@page\b/i);
    assert.match(theirs, /@x-cd-page/);
    assert.equal(doc.head.querySelectorAll("style").length, 1);
    assert.equal(doc.body.querySelectorAll(":scope style").length, 0);
    // The body's own style rides on the email's box, inside the shadow tree.
    assert.equal(part.querySelector(".cd-body")!.getAttribute("style"), "margin-top:-500px");
    // The page holds the email's box in: its layout contained, nothing drawn above it.
    const css = doc.head.querySelector("style")!.textContent ?? "";
    assert.match(css, /\.cd-mail \{ contain: layout; isolation: isolate; overflow-y: clip;/);
    assert.match(css, /\.cd-head \{ position: relative; z-index: 2147483646; background: #fff;[^}]*print-color-adjust: exact;/);
  });

  test("a document that does not read back in its shape is refused", () => {
    const h: Parameters<typeof printLib.buildOriginalPrintDocument>[1] = {
      number: 7,
      subject: "Shape",
      from: "a <a@b.example>",
      ccs: "None",
      received: "today",
      printed: "Printed by me.",
      internal: false,
      truncated: false,
      imagesLeftOut: 0,
      insecure: 0,
    };
    const ok = printLib.buildOriginalPrintDocument('<!doctype html><html><head></head><body><p>fine</p></body></html>', h)!;
    assert.ok(ok && printLib.hasExpectedShape(ok));
    const tamper = (from: string, to: string) => {
      assert.ok(ok.includes(from), from);
      return ok.replace(from, to);
    };
    assert.equal(printLib.hasExpectedShape(tamper("</template>", '</template><div class="x">out</div>')), false, "beside the template");
    assert.equal(printLib.hasExpectedShape(tamper("</template></div></div>", '</template></div></div><p>after</p>')), false, "after the email's box");
    assert.equal(printLib.hasExpectedShape(tamper('<header class="cd-head">', '<header class="cd-head"><style>x{}</style>')), false, "inside the header");
    assert.equal(printLib.hasExpectedShape(tamper("</title>", "</title><link rel=stylesheet href=x>")), false, "in the head");
    assert.equal(printLib.hasExpectedShape(tamper('shadowrootmode="open"', 'shadowrootmode="closed"')), false);
    assert.equal(printLib.hasExpectedShape(tamper("</template>", "</template><template></template>")), false, "a second template");
    assert.equal(printLib.hasExpectedShape("not a document"), false);
  });

  test("the email goes in as the sanitiser wrote it: refused when it is not that shape or could end its template early", async () => {
    const h: Parameters<typeof printLib.buildOriginalPrintDocument>[1] = {
      number: 8, subject: "Shape", from: "a", ccs: "None", received: "today", printed: "Printed by me.", internal: false, truncated: false, imagesLeftOut: 0, insecure: 0,
    };
    const ok = await sanitize.sanitizeEmailHtml('<html dir="rtl" lang="ar"><body style="color:#123" class="x"><p title="a > b">مرحبا</p></body></html>');
    assert.ok(ok.ok);
    const out = printLib.buildOriginalPrintDocument((ok as { html: string }).html, h)!;
    assert.ok(out && printLib.hasExpectedShape(out));
    const body = emailPart(parseDoc(out)).querySelector(".cd-body")!;
    assert.deepEqual([body.getAttribute("dir"), body.getAttribute("lang"), body.getAttribute("style"), body.getAttribute("class")], ["rtl", "ar", "color:#123", "cd-body"]);
    assert.equal(body.querySelector("p")!.getAttribute("title"), "a > b");
    // An attribute that spells the end of a template: the serialiser writes it escaped, so it stays an attribute.
    const sneaky = await sanitize.sanitizeEmailHtml('<p title="</template><h1>Fake</h1>">x</p>');
    assert.ok(sneaky.ok);
    const sd = parseDoc(printLib.buildOriginalPrintDocument((sneaky as { html: string }).html, h)!);
    assert.equal(emailPart(sd).querySelector("p")!.getAttribute("title"), "</template><h1>Fake</h1>");
    assert.equal(sd.querySelectorAll("h1").length, 1);
    // Had it been written raw (a serialiser that did not escape it): refused, never spliced.
    const raw = '<!doctype html>\n<html><head></head><body><p title="</template><h1>Fake</h1>">x</p></body></html>';
    assert.equal(printLib.buildOriginalPrintDocument(raw, h), null);
    assert.equal(printLib.buildOriginalPrintDocument(raw.replace("</template>", "</TEMPLATE >"), h), null);
    for (const bad of ["<p>no document</p>", "<!doctype html><html><body><p>no head</p></body></html>", "<!doctype html><html><head></head><body></body></html><p>after</p>"]) {
      assert.equal(printLib.buildOriginalPrintDocument(bad, h), null, bad);
    }
  });

  test("cost: the email is not parsed again; a large one adds little to the sanitiser's own time", async () => {
    const h: Parameters<typeof printLib.buildOriginalPrintDocument>[1] = {
      number: 9, subject: "Big", from: "a", ccs: "None", received: "today", printed: "Printed by me.", internal: false, truncated: false, imagesLeftOut: 0, insecure: 0,
    };
    // A generous sanitiser limit: on a loaded CI runner this email can take longer than the 3 s production limit.
    sanitize.setSanitizeTimeoutForTests(60_000);
    let big: Awaited<ReturnType<typeof sanitize.sanitizeEmailHtml>>;
    try {
      big = await sanitize.sanitizeEmailHtml("<p>" + "<b>x</b><i>y</i> ".repeat(29_000) + "</p>");
    } finally {
      sanitize.setSanitizeTimeoutForTests(null);
    }
    assert.ok(big.ok, JSON.stringify(big).slice(0, 200));
    const t0 = performance.now();
    const out = printLib.buildOriginalPrintDocument((big as { html: string }).html, h);
    const ms = performance.now() - t0;
    assert.ok(out && out.length > (big as { html: string }).html.length);
    // About 130 ms on an idle machine; the bound leaves room for a busy CI runner.
    assert.ok(ms < 2_000, `${Math.round(ms)} ms`);
  });

  test("a long email still reads back whole", async () => {
    const long = `<table width="600">${Array.from({ length: 400 }, (_, i) => `<tr><td>Row ${i}</td></tr>`).join("")}</table>`;
    const { first } = await opened(mail(P.req, { html: long }));
    const doc = parseDoc((await printed(first.id, P.agent.session)).text);
    assert.equal(emailPart(doc).querySelectorAll("tr").length, 400);
  });
});

// --- Pictures ------------------------------------------------------------------------------------------

describe("pictures", () => {
  test("remote pictures only with images=1 (the dialog's Show images); cid: ones always; http never", async () => {
    const shot = png(6000);
    const { first } = await opened(
      mail(P.req, {
        html: `<p>Photo:</p><img alt="cid" src="cid:shot1@people.example"><img alt="remote" src="https://images.example/cable.jpg"><img alt="plain" src="http://plain.example/a.png">`,
        files: [{ name: "shot.png", type: "image/png", data: shot, contentId: "shot1@people.example" }],
      })
    );
    const copy = printShared.HD_ORIGINAL_PRINT_COPY;
    const hidden = parseDoc((await printed(first.id, P.agent.session)).text);
    const hp = emailPart(hidden);
    assert.equal(hp.querySelector('img[alt="cid"]')!.getAttribute("src"), `data:image/png;base64,${shot.toString("base64")}`);
    assert.equal(hp.querySelector('img[alt="remote"]')!.getAttribute("src"), null);
    assert.equal(hp.querySelector('img[alt="plain"]')!.getAttribute("src"), null);
    assert.ok(lines(hidden).includes(copy.imagesLeftOut));
    assert.ok(lines(hidden).includes(copy.insecure(1)));

    const shownRes = await printed(first.id, P.agent.session, "?print=1&images=1");
    assert.equal(shownRes.headers.get("content-security-policy"), PRINT_CSP(true));
    const shown = parseDoc(shownRes.text);
    const sp = emailPart(shown);
    assert.equal(sp.querySelector('img[alt="remote"]')!.getAttribute("src"), "https://images.example/cable.jpg");
    assert.equal(sp.querySelector('img[alt="remote"]')!.getAttribute("referrerpolicy"), "no-referrer");
    assert.equal(sp.querySelector('img[alt="plain"]')!.getAttribute("src"), null);
    assert.match(sp.querySelector('img[alt="cid"]')!.getAttribute("src")!, /^data:image\/png;base64,/);
    assert.ok(!lines(shown).includes(copy.imagesLeftOut));
    assert.ok(lines(shown).includes(copy.insecure(1)));
    // Pictures never split across pages.
    assert.match(sp.querySelector("style")!.textContent ?? "", /img\{max-width:100%;break-inside:avoid\}/);
  });

  test("a truncated email says so on the header", async () => {
    const big = `<p>${"Grüße aus Köln. ".repeat(80_000)}</p>`;
    const { first } = await opened(mail(P.req, { html: big, text: "Long one" }));
    const doc = parseDoc((await printed(first.id, P.agent.session)).text);
    assert.ok(lines(doc).includes(printShared.HD_ORIGINAL_PRINT_COPY.truncated));
  });
});
