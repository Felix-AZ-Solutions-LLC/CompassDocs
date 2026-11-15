// Helpdesk 1.20.11: an emailed message shows formatted in the desk
// conversation (GET /api/helpdesk/messages/[id]/original?inline=1,
// lib/helpdesk/email-html originalView `inline`, the worker's foldQuotes,
// ticket/InlineEmail in the desk).
//
//   - the variant's exact headers (its sandbox adds allow-same-origin, never
//     allow-scripts) and next.config.js stating the same, applied as Next
//     applies its rules; the dialog and print variants unchanged;
//   - who may read it (the same matrix as the original), and only as the
//     desk's frame (Sec-Fetch-Dest / Sec-Fetch-Site), once, never with print;
//   - the mark the desk reads (<meta name="compass-email">), the remote
//     picture count, pictures on the desk's own host dropped;
//   - quoted history folded on replies across real-world shapes (Gmail,
//     Outlook on the web and desktop, Apple Mail, Thunderbird, Yahoo, a
//     generic "On … wrote:"), and left alone where it should be (a forward,
//     the message that opened its ticket, an answer written below or between
//     quotes, an email that is only a quote);
//   - refusals (too complex, busy) as a marked empty page the desk turns into
//     the text body;
//   - the per-agent default (email_view in the desk preferences).
//
// Same rig as test/helpdesk-email-html (route handlers called directly with
// real sessions, next/headers and lib/ee stubbed, Duo stubbed for this
// process). Parallel-safe: everything is this file's own (STAMP).
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-email-inline.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
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

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-email-inline.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-email-inline.virtual.js");
const POLICY_STUB = path.join(__dirname, "stubs", "duo-policy.helpdesk-email-inline.virtual.js");
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
const worker = require("../src/lib/helpdesk/email-html-worker.cjs") as {
  cleanCss(css: string): string;
  cidKey(raw: string): string;
  SANITIZER_VERSION: number;
  sanitize(html: string, opts: Record<string, unknown>): { ok: boolean; html?: string; quoted?: boolean };
};
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
const prefsRoute = require("../src/app/api/helpdesk/me/notification-prefs/route") as typeof import("../src/app/api/helpdesk/me/notification-prefs/route");
const notifyPrefs = require("../src/lib/helpdesk/notify-prefs") as typeof import("../src/lib/helpdesk/notify-prefs");
const notifyShared = require("../src/lib/helpdesk/notify-prefs-shared") as typeof import("../src/lib/helpdesk/notify-prefs-shared");
const printLib = require("../src/lib/helpdesk/email-html-print") as typeof import("../src/lib/helpdesk/email-html-print");
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

function req(url: string, session: string | null, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost", ...(init.headers ?? {}) };
  if (session) headers.cookie = `compass_session=${session}`;
  return new Request(`http://localhost/api/helpdesk${url}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** GET the original (the frame's document, or ?format=info) as `who`. */
function original(messageId: number, session: string | null, query = "", headers: Record<string, string> = {}): Promise<Answer> {
  html.resetOriginalCacheForTests();
  return call(originalRoute.GET, req(`/messages/${messageId}/original${query}`, session, { headers }), { id: String(messageId) });
}

/** The inline variant as the desk's frame asks for it. */
const FRAME = { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" };
const inline = (messageId: number, session: string | null, extra = "") => original(messageId, session, `?inline=1${extra}`, FRAME);

// --- Fixtures ---------------------------------------------------------------------------------

const STAMP = `hdinl${Date.now().toString(36)}${process.pid}`;
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

before(async () => {
  await getSetting("__schema_bootstrap__");
  uploads = await mkdtemp(path.join(tmpdir(), "compass-email-inline-"));
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
  await pool().query("DELETE FROM hd_notify_prefs WHERE user_id = ANY($1)", [everyone]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [everyone]);
  await rm(uploads, { recursive: true, force: true });
  await pool().end();
});

// --- Helpers ---------------------------------------------------------------------------------------------

/** The ticket and its first message opened by `e`. */
async function opened(e: InboundEmail) {
  const r = await deliver(e);
  assert.ok(r.ticket, JSON.stringify(r));
  const t = await ticketByNumber(r.ticket!);
  const [first] = await messagesOf(t.id);
  return { r, t, first };
}

/** A reply on `t`'s thread from the requester, and its message. */
async function replied(t: { id: number; number: number; subject: string; reply_token: string }, htmlPart: string, from: Person = P.req) {
  const r = await deliver(mail(from, { subject: `Re: ${t.subject} [#${t.number} ref:${t.reply_token}]`, html: htmlPart }));
  assert.equal(r.outcome, "appended", JSON.stringify(r));
  const msgs = await messagesOf(t.id);
  return msgs[msgs.length - 1];
}

/** The document's mark, parsed. */
function markOf(text: string): Record<string, string> | null {
  const doc = new JSDOM(text, { virtualConsole: new VirtualConsole() }).window.document;
  const m = doc.querySelector('meta[name="compass-email"]');
  if (!m) return null;
  return Object.fromEntries([...m.attributes].map((a) => [a.name, a.value]));
}

/** What a reader sees before any "Show quoted text": the text outside the folded part. */
function visible(text: string): string {
  const doc = new JSDOM(text, { virtualConsole: new VirtualConsole() }).window.document;
  doc.querySelector("details.cd-quote")?.remove();
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}
function folded(text: string): string {
  const doc = new JSDOM(text, { virtualConsole: new VirtualConsole() }).window.document;
  return (doc.querySelector("details.cd-quote > .cd-quote-body")?.textContent ?? "").replace(/\s+/g, " ").trim();
}

const VIEW_CSP = (images: boolean) =>
  `default-src 'none'; img-src data:${images ? " https:" : ""}; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-popups allow-popups-to-escape-sandbox`;
const INLINE_CSP = (images: boolean) =>
  `default-src 'none'; img-src data:${images ? " https:" : ""}; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox`;

// --- The variant: headers, mark, config -------------------------------------------------------------

describe("the inline variant", () => {
  let t: Awaited<ReturnType<typeof opened>>["t"];
  let replyId = 0;
  before(async () => {
    ({ t } = await opened(mail(P.req, { html: "<p>The <b>projector</b> shows no picture.</p>" })));
    replyId = (await replied(t, `<div><p>Still <b>no picture</b>.</p><img src="https://img.example/cable.jpg" alt="cable"><img src="https://img.example/plug.jpg" alt="plug"></div>${QUOTED}`)).id;
  });

  test("its headers, exactly; the sandbox adds allow-same-origin and never allow-scripts; no script-src under default-src 'none'", async () => {
    for (const images of [false, true]) {
      const r = await inline(replyId, P.agent.session, images ? "&images=1" : "");
      assert.equal(r.status, 200, r.text);
      assert.equal(r.headers.get("content-security-policy"), INLINE_CSP(images));
      assert.equal(r.headers.get("content-type"), "text/html; charset=utf-8");
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.equal(r.headers.get("referrer-policy"), "no-referrer");
      assert.equal(r.headers.get("cache-control"), "private, no-store");
      assert.equal(r.headers.get("x-frame-options"), "SAMEORIGIN");
      assert.equal(r.headers.get("cross-origin-resource-policy"), "same-origin");
      const csp = r.headers.get("content-security-policy")!;
      assert.doesNotMatch(csp, /allow-scripts|script-src|unsafe-eval|allow-forms|allow-top-navigation|allow-modals/);
      assert.match(csp, /(^|; )default-src 'none'(;|$)/);
      assert.deepEqual(html.originalInlineHeaders(images)["Content-Security-Policy"], INLINE_CSP(images));
    }
    // The dialog's and the print view's stay as they were.
    assert.equal((await original(replyId, P.agent.session)).headers.get("content-security-policy"), VIEW_CSP(false));
    assert.equal((await original(replyId, P.agent.session, "?images=1")).headers.get("content-security-policy"), VIEW_CSP(true));
    assert.equal((await original(replyId, P.agent.session, "?print=1")).headers.get("content-security-policy"), printLib.originalPrintHeaders(false)["Content-Security-Policy"]);
  });

  test("next.config.js states each policy, applied as Next applies its rules; the inline rules sit before print's", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require("../next.config.js") as { headers: () => Promise<{ source: string; has?: { type: string; key: string; value?: string }[]; headers: { key: string; value: string }[] }[]> };
    const all = await config.headers();
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
    assert.equal(applied({ inline: "1" }).get("Content-Security-Policy"), html.originalInlineHeaders(false)["Content-Security-Policy"]);
    assert.equal(applied({ inline: "1", images: "1" }).get("Content-Security-Policy"), html.originalInlineHeaders(true)["Content-Security-Policy"]);
    assert.equal(applied({ inline: "1" }).get("Referrer-Policy"), "no-referrer");
    assert.equal(applied({ inline: "0" }).get("Content-Security-Policy"), html.originalHeaders(false)["Content-Security-Policy"], "only inline=1 is the inline variant");
    assert.equal(applied({}).get("Content-Security-Policy"), html.originalHeaders(false)["Content-Security-Policy"]);
    assert.equal(applied({ images: "1" }).get("Content-Security-Policy"), html.originalHeaders(true)["Content-Security-Policy"]);
    assert.equal(applied({ print: "1" }).get("Content-Security-Policy"), printLib.originalPrintHeaders(false)["Content-Security-Policy"]);
    const at = (key: string) => all.findIndex((r) => r.has?.some((c) => c.key === key));
    assert.ok(at("inline") > all.findIndex((r) => r.source === "/((?!addin).*)"), "after the general rule");
    assert.ok(at("inline") < at("print"), "before the print rules, which stay last");
  });

  test("the mark the desk reads: remote pictures counted, hidden until images=1; the email's own look kept; edge to edge", async () => {
    const r = await inline(replyId, P.agent.session);
    const mark = markOf(r.text)!;
    assert.equal(mark.content, "ok");
    assert.equal(mark["data-remote-images"], "2");
    assert.equal(mark["data-insecure-images"], "0");
    assert.equal(mark["data-quoted"], "1");
    assert.equal(mark["data-truncated"], "0");
    assert.doesNotMatch(r.text, /img\.example/);
    assert.match(r.text, /<b>no picture<\/b>/);
    assert.match(r.text, /html:root\{height:auto!important/);
    assert.match(r.text, /body\{margin:0\}/);
    const info = await original(replyId, P.agent.session, "?inline=1&format=info");
    assert.equal(info.status, 200);
    assert.deepEqual([info.body.remote_images, info.body.quoted], [2, true]);
    const shown = await inline(replyId, P.agent.session, "&images=1");
    assert.equal(markOf(shown.text)!["data-remote-images"], "0");
    assert.match(shown.text, /src="https:\/\/img\.example\/cable\.jpg"/);
    // The dialog's document: no mark, nothing folded (it shows the whole email).
    const dialog = await original(replyId, P.agent.session);
    assert.equal(markOf(dialog.text), null);
    assert.doesNotMatch(dialog.text, /cd-quote/);
    assert.match(dialog.text, /Please restart the laptop\./);
    assert.equal((await original(replyId, P.agent.session, "?format=info")).body.quoted, undefined, "the dialog's info is as it was");
  });

  test("a picture on the desk's own host is never loaded nor offered (it would carry the agent's cookies)", async () => {
    const m = await replied(t, '<p>Self</p><img src="https://localhost/api/helpdesk/tickets" alt="self"><img src="https://LOCALHOST:8443/x.png" alt="self2"><img src="https://cdn.example/ok.png" alt="ok">');
    const r = await inline(m.id, P.agent.session, "&images=1");
    assert.doesNotMatch(r.text, /src="https:\/\/localhost/i);
    assert.match(r.text, /src="https:\/\/cdn\.example\/ok\.png"/);
    assert.equal(markOf((await inline(m.id, P.agent.session)).text)!["data-remote-images"], "1");
    // 1.20.11 security review: a trailing dot, an escaped one, or capitals are the desk's host too.
    const dotted = await replied(t, '<p>Dots</p><img src="https://localhost./a.png" alt="d1"><img src="https://localhost%2e/b.png" alt="d2"><img src="https://LocalHost../c.png" alt="d3"><img src="https://cdn.example/ok2.png" alt="ok">');
    const d = await inline(dotted.id, P.agent.session, "&images=1");
    assert.doesNotMatch(d.text, /src="https:\/\/localhost/i);
    assert.match(d.text, /src="https:\/\/cdn\.example\/ok2\.png"/);
    assert.equal(markOf((await inline(dotted.id, P.agent.session)).text)!["data-remote-images"], "1");
    const viaDot = await original(dotted.id, P.agent.session, "?inline=1&images=1", { ...FRAME, host: "cdn.example." });
    assert.doesNotMatch(viaDot.text, /cdn\.example\/ok2\.png/, "the desk's own host given with a trailing dot");
    // Behind a proxy the browser's host is the forwarded one.
    const proxied = await original(m.id, P.agent.session, "?inline=1&images=1", { ...FRAME, "x-forwarded-host": "cdn.example" });
    assert.doesNotMatch(proxied.text, /cdn\.example\/ok\.png/);
  });

  test("a script, a handler, a javascript: link or a form in the email never survive (the same sanitiser)", async () => {
    const m = await replied(
      t,
      `<p onclick="parent.x=1">Tap</p><script>parent.document.title='PWNED'</script><img src=x onerror="parent.x=1"><a href="javascript:parent.x=1">go</a><form action="/api/helpdesk/tickets"><input name=a></form><meta http-equiv="refresh" content="0;url=/desk"><base href="/desk/">`
    );
    const r = await inline(m.id, P.agent.session);
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.text, /<script|onclick|onerror|javascript:|<form|<input|http-equiv|<base/i);
    assert.equal(markOf(r.text)!.content, "ok");
  });
});

// --- Who may read it, and how ------------------------------------------------------------------------------

describe("who may read the inline variant, and only as the desk's frame", () => {
  let msgId = 0;
  let noteId = 0;
  let number = 0;
  before(async () => {
    const { t, first } = await opened(mail(P.req, { html: "<p>Inline, who can see me?</p>" }));
    msgId = first.id;
    number = t.number;
    await deliver(mail(P.agent, { subject: `Re: [#${t.number} ref:${t.reply_token}]`, inReplyTo: `<hd-note-${t.reply_token}-0a0b0c@desk.example>`, html: "<p>Agents only, inline.</p>" }));
    noteId = (await messagesOf(t.id)).find((m) => m.kind === "internal")!.id;
  });

  test("an agent who works the ticket: the message and the internal note; every team's for a desk admin", async () => {
    for (const id of [msgId, noteId]) assert.equal((await inline(id, P.agent.session)).status, 200);
    assert.match((await inline(noteId, P.agent2.session)).text, /Agents only, inline\./);
    assert.equal((await inline(msgId, P.manager.session)).status, 200);
  });

  test("signed out 401; the requester 403; another team's agent 404; unknown 404; Duo owed 401; unlicensed 402; in the bin 404", async () => {
    assert.equal((await inline(msgId, null)).status, 401);
    for (const id of [msgId, noteId]) {
      const r = await inline(id, P.req.session);
      assert.equal(r.status, 403);
      assert.ok(!r.text.includes("who can see me") && !r.text.includes("Agents only"));
      assert.equal((await inline(id, P.other.session)).status, 404);
    }
    assert.equal((await call(originalRoute.GET, req("/messages/99999999/original?inline=1", P.agent.session, { headers: FRAME }), { id: "99999999" })).status, 404);
    owesDuo.add(P.agent.session);
    try {
      const r = await inline(msgId, P.agent.session);
      assert.equal(r.status, 401);
      assert.equal(r.body.code, "mfa_required");
    } finally {
      owesDuo.delete(P.agent.session);
    }
    licensed = false;
    try {
      assert.equal((await inline(msgId, P.agent.session)).status, 402);
    } finally {
      licensed = true;
    }
    const manager = (await dbLib.getUserById(P.manager.id))!;
    const [b] = await bin.binTickets(manager, [number]);
    assert.ok(b.ok);
    assert.equal((await inline(msgId, P.manager.session)).status, 404);
    const [rs] = await bin.restoreTickets(manager, [number]);
    assert.ok(rs.ok);
    assert.equal((await inline(msgId, P.agent.session)).status, 200);
  });

  test("opened as a page, or from another site: 400 (it is the desk's frame); without those headers (an older browser) it is served", async () => {
    const refused: Record<string, string>[] = [
      { "sec-fetch-dest": "document", "sec-fetch-site": "same-origin" },
      { "sec-fetch-dest": "document", "sec-fetch-site": "cross-site" },
      { "sec-fetch-dest": "iframe", "sec-fetch-site": "cross-site" },
      { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-site" },
      { "sec-fetch-dest": "image" },
    ];
    for (const h of refused) {
      const r = await original(msgId, P.agent.session, "?inline=1", h);
      assert.equal(r.status, 400, JSON.stringify(h));
      assert.ok(!r.text.includes("who can see me"));
    }
    assert.equal((await original(msgId, P.agent.session, "?inline=1")).status, 200);
    // 1.20.11 security review: the refusal is a small page (never JSON) marked refused; a frame the person reloads
    // from its own menu (Sec-Fetch-Site: none) is served.
    const page = await original(msgId, P.agent.session, "?inline=1", { "sec-fetch-dest": "document", "sec-fetch-site": "none" });
    assert.equal(page.status, 400);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    assert.deepEqual(markOf(page.text), { name: "compass-email", content: "refused", "data-reason": "not_here" });
    assert.match(page.text, /This email shows in the ticket's conversation in the desk\./);
    assert.match(page.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal((await original(msgId, P.agent.session, "?inline=1", { "sec-fetch-dest": "iframe", "sec-fetch-site": "none" })).status, 200);
    // The dialog's frame and the info read are not held to it (as in 1.20.8).
    assert.equal((await original(msgId, P.agent.session, "", { "sec-fetch-dest": "document" })).status, 200);
    assert.equal((await original(msgId, P.agent.session, "?inline=1&format=info", { "sec-fetch-dest": "empty" })).status, 200);
  });

  test("inline once, never with print; a repeated images or format is 400 as before", async () => {
    for (const q of ["?inline=1&inline=1", "?inline=0&inline=1", "?inline=1&print=1", "?print=1&inline=1&images=1", "?inline=1&images=1&images=1"]) {
      const r = await original(msgId, P.agent.session, q, FRAME);
      assert.equal(r.status, 400, q);
      assert.ok(!r.text.includes("who can see me"), q);
    }
  });

  test("not audited: reading a message", async () => {
    const n = (await pool().query("SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND action LIKE '%original%'", [P.agent.id])).rows[0].n;
    assert.equal(n, 0);
  });
});

// --- Quoted history ------------------------------------------------------------------------------------------

/** Real-world reply shapes: [name, the HTML, the new text a reader should see, a phrase from the quote]. */
const REPLIES: [string, string, string, string][] = [
  [
    "Gmail",
    `<div dir="ltr">Thanks, that fixed it.</div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Mon, 3 Nov 2026 at 10:11, IT help &lt;help@desk.example&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr">Please restart the projector.</div><br><div class="gmail_quote"><div class="gmail_attr">On Sun, Cara wrote:</div><blockquote class="gmail_quote">Older still</blockquote></div></blockquote></div>`,
    "Thanks, that fixed it.",
    "Please restart the projector.",
  ],
  [
    "Outlook on the web",
    `<div style="font-family:Aptos,Arial,sans-serif;font-size:12pt">Works now, thank you.</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%" tabindex="-1"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif" style="font-size:11pt"><b>From:</b> IT help &lt;help@desk.example&gt;<br><b>Sent:</b> Monday, November 3, 2026 10:11<br><b>To:</b> Cara &lt;cara@clientco.example&gt;<br><b>Subject:</b> RE: Projector</font><div>&nbsp;</div></div><div><div>Please restart the projector.</div></div>`,
    "Works now, thank you.",
    "Please restart the projector.",
  ],
  [
    "Outlook desktop",
    `<div class="WordSection1"><p class="MsoNormal">Still broken this morning.<o:p></o:p></p><p class="MsoNormal"><o:p>&nbsp;</o:p></p><div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in"><p class="MsoNormal"><b>From:</b> IT help &lt;help@desk.example&gt; <br><b>Sent:</b> Monday, November 3, 2026 10:11 AM<br><b>To:</b> Cara &lt;cara@clientco.example&gt;<br><b>Subject:</b> RE: Projector<o:p></o:p></p></div></div><p class="MsoNormal"><o:p>&nbsp;</o:p></p><p class="MsoNormal">Please restart the projector.<o:p></o:p></p></div>`,
    "Still broken this morning.",
    "Please restart the projector.",
  ],
  [
    "Outlook, German",
    `<div><p>Funktioniert wieder.</p><div style="border:none;border-top:solid #B5C4DF 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p><b>Von:</b> IT help<br><b>Gesendet:</b> Montag, 3. November 2026 10:11<br><b>An:</b> Cara<br><b>Betreff:</b> AW: Beamer</p></div><p>Bitte den Beamer neu starten.</p></div>`,
    "Funktioniert wieder.",
    "Bitte den Beamer neu starten.",
  ],
  [
    "Apple Mail",
    `<html><body dir="auto"><div dir="ltr">Got it, thanks!</div><div dir="ltr"><br><blockquote type="cite">On 3 Nov 2026, at 10:11, IT help &lt;help@desk.example&gt; wrote:<br><br></blockquote></div><blockquote type="cite"><div dir="ltr">Please restart the projector.</div></blockquote></body></html>`,
    "Got it, thanks!",
    "Please restart the projector.",
  ],
  [
    "Thunderbird",
    `<p>That did it.</p><div class="moz-cite-prefix">On 03/11/2026 10:11, IT help wrote:<br></div><blockquote type="cite" cite="mid:abc@desk.example"><p>Please restart the projector.</p></blockquote>`,
    "That did it.",
    "Please restart the projector.",
  ],
  [
    "Yahoo",
    `<div class="ydp3e5d1a8byahoo-style-wrap"><div>Yes please, go ahead.</div></div><div id="ydpa1b2c3yahoo_quoted_7781" class="ydpa1b2c3yahoo_quoted"><div style="font-family:Helvetica"><div>On Monday, November 3, 2026, 10:11 AM, IT help &lt;help@desk.example&gt; wrote:</div><div><br></div><div>Please restart the projector.</div></div></div>`,
    "Yes please, go ahead.",
    "Please restart the projector.",
  ],
  [
    "generic On … wrote:",
    `Thanks!<br><br>On Mon, Nov 3, 2026, IT help wrote:<br><blockquote style="border-left:2px solid #ccc">Please restart the projector.</blockquote>`,
    "Thanks!",
    "Please restart the projector.",
  ],
  [
    "Original Message",
    `<div>New words above.</div><div>-----Original Message-----<br>From: IT help<br>Sent: Monday<br>Subject: Projector<br><br>Please restart the projector.</div>`,
    "New words above.",
    "Please restart the projector.",
  ],
];

describe("quoted history", () => {
  let t: Awaited<ReturnType<typeof opened>>["t"];
  before(async () => {
    ({ t } = await opened(mail(P.req, { html: "<p>Projector in room 4.</p>" })));
  });

  for (const [name, part, mine, quote] of REPLIES) {
    test(`a reply from ${name}: the quote is folded under "Show quoted text", the new text shows, the quote is one click away`, async () => {
      const m = await replied(t, part);
      const r = await inline(m.id, P.agent.session);
      assert.equal(r.status, 200, r.text);
      assert.equal(markOf(r.text)!["data-quoted"], "1", name);
      assert.ok(visible(r.text).includes(mine), `${name}: ${visible(r.text)}`);
      assert.ok(!visible(r.text).includes(quote), `${name}: the quote is folded: ${visible(r.text)}`);
      assert.ok(folded(r.text).includes(quote), `${name}: and in the fold`);
      assert.match(r.text, /<details class="cd-quote"><summary><span class="cd-quote-show">Show quoted text<\/span><span class="cd-quote-hide">Hide quoted text<\/span><\/summary>/);
      // The text body starts with the same new text (lib/helpdesk/inbound-parse cuts its quote too).
      assert.ok(m.body.replace(/\\/g, "").startsWith(mine.slice(0, 12)), `${name}: ${m.body}`);
    });
  }

  test("only the first quote is folded, and only once; a quote nested in the fold stays inside it", async () => {
    const m = await replied(t, REPLIES[0][1]);
    const r = await inline(m.id, P.agent.session);
    assert.equal((r.text.match(/<details class="cd-quote">/g) ?? []).length, 1);
    assert.ok(folded(r.text).includes("Older still"));
  });

  test("a forward that opened its ticket is never folded: the forwarded part is the content", async () => {
    const fwd = `<p>Can you look at this one?</p><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong>Vendor Billing</strong><br>Subject: Invoice 2231</div><br><div>Invoice <b>2231</b> is overdue.</div><div class="gmail_quote">On Fri, Vendor wrote:<blockquote>Reminder one</blockquote></div></div>`;
    const { first } = await opened(mail(P.agent, { subject: `Fwd: Invoice 2231 ${STAMP}`, html: fwd }));
    const r = await inline(first.id, P.agent.session);
    assert.equal(markOf(r.text)!["data-quoted"], "0");
    assert.doesNotMatch(r.text, /<details class="cd-quote"/);
    assert.ok(visible(r.text).includes("Invoice 2231 is overdue."));
    assert.equal(await html.quoteFolding(first.id), false);
  });

  test("any message that opened its ticket keeps its quote (its text body kept it too); a follow-up's opening message folds", async () => {
    const { t: t2, first } = await opened(mail(P.req, { html: REPLIES[0][1] }));
    assert.equal(markOf((await inline(first.id, P.agent.session)).text)!["data-quoted"], "0");
    assert.ok(first.body.includes("Please restart the projector"), "the text body kept it");
    await pool().query("UPDATE hd_tickets SET status = 'closed', closed_at = now() WHERE id = $1", [t2.id]);
    const follow = await deliver(mail(P.req, { subject: `Re: ${t2.subject} [#${t2.number} ref:${t2.reply_token}]`, html: REPLIES[0][1] }));
    assert.equal(follow.outcome, "follow_up");
    const [fm] = await messagesOf((await ticketByNumber(follow.ticket!)).id);
    assert.equal(await html.quoteFolding(fm.id), true);
    assert.equal(markOf((await inline(fm.id, P.agent.session)).text)!["data-quoted"], "1");
  });

  test("a forward sent into an existing ticket (Gmail and Apple Mail) is not folded either", async () => {
    for (const part of [
      `<div>FYI, from the vendor</div><div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br>From: Vendor</div><div>Your order shipped.</div></div>`,
      `<div>See below</div><div><br><div>Begin forwarded message:</div><br><blockquote type="cite"><div>From: Vendor</div><div>Your order shipped.</div></blockquote></div>`,
    ]) {
      const m = await replied(t, part);
      const r = await inline(m.id, P.agent.session);
      assert.equal(markOf(r.text)!["data-quoted"], "0", part);
      assert.ok(visible(r.text).includes("Your order shipped."));
    }
  });

  test("an answer written below the quote, or between quoted lines, is not folded", async () => {
    for (const part of [
      `<div class="gmail_quote"><div class="gmail_attr">On Mon, IT help wrote:</div><blockquote class="gmail_quote">Which room?</blockquote></div><div>Room 4, second floor.</div>`,
      `<blockquote type="cite">Which room?</blockquote><p>Room 4.</p><blockquote type="cite">Which floor?</blockquote><p>Second floor.</p>`,
    ]) {
      const m = await replied(t, part);
      const r = await inline(m.id, P.agent.session);
      assert.equal(markOf(r.text)!["data-quoted"], "0", part);
      assert.ok(visible(r.text).includes("Second floor") || visible(r.text).includes("second floor"));
    }
  });

  test("an email that is only a quote is shown whole (nothing would be left to read)", async () => {
    const m = await replied(t, `<div class="gmail_quote"><div class="gmail_attr">On Mon, IT help wrote:</div><blockquote class="gmail_quote">Please restart the projector.</blockquote></div>`);
    const r = await inline(m.id, P.agent.session);
    assert.equal(markOf(r.text)!["data-quoted"], "0");
    assert.ok(visible(r.text).includes("Please restart the projector."));
  });

  test("an email that only quotes on purpose (no reply header) keeps its blockquote", async () => {
    const m = await replied(t, `<p>The manual says:</p><blockquote>Hold the power button for ten seconds.</blockquote><p>Did that, no luck.</p>`);
    const r = await inline(m.id, P.agent.session);
    assert.equal(markOf(r.text)!["data-quoted"], "0");
    assert.ok(visible(r.text).includes("Hold the power button"));
  });

  test("a merged-in ticket's opening message keeps its quote; its replies fold", async () => {
    const keep = await opened(mail(P.req, { html: "<p>Keep this ticket.</p>" }));
    const gone = await opened(mail(P.req2, { html: REPLIES[0][1] }));
    const goneReply = await replied(gone.t, REPLIES[4][1], P.req2);
    const r = await call(mergeRoute.POST, req("/tickets/merge", P.agent.session, { body: { keep: keep.t.number, merge: [gone.t.number], notify: false } }));
    assert.equal(r.status, 200, r.text);
    assert.equal(await html.quoteFolding(gone.first.id), false);
    assert.equal(await html.quoteFolding(goneReply.id), true);
  });

  test("the worker on its own: folding is the inline variant's alone, and a broken fold never refuses the email", async () => {
    const r = await sanitize.sanitizeEmailHtml(REPLIES[0][1], {});
    assert.ok(r.ok);
    assert.doesNotMatch(r.ok ? r.html : "", /cd-quote|compass-email/);
    const deep = `<p>Top</p>${"<div>".repeat(300)}<div class="gmail_quote">On Mon, X wrote:<blockquote>q</blockquote></div>${"</div>".repeat(300)}`;
    const d = await sanitize.sanitizeEmailHtml(deep, { inline: { collapseQuotes: true, selfHost: "localhost", truncated: false } });
    assert.ok(d.ok);
    assert.equal(d.ok && d.quoted, true);
  });
});

// --- Refusals: the desk shows the text --------------------------------------------------------------------

describe("refusals", () => {
  test("too complex: 422, an empty page marked refused (too_complex) under the inline policy; nothing of the email", async () => {
    const { first } = await opened(mail(P.req, { html: "<div>".repeat(shared.EMAIL_HTML_LIMITS.depth + 50) + "deep inline" }));
    const r = await inline(first.id, P.agent.session);
    assert.equal(r.status, 422);
    assert.deepEqual(markOf(r.text), { name: "compass-email", content: "refused", "data-reason": "too_complex" });
    assert.ok(!r.text.includes("deep inline"));
    assert.equal(r.headers.get("content-security-policy"), INLINE_CSP(false));
  });

  test("busy (8 emails waiting): 503 marked refused (busy), which the desk retries once and then shows the text", async () => {
    const { first } = await opened(mail(P.req, { html: "<p>Busy inline</p>" }));
    html.resetOriginalCacheForTests();
    sanitize.setSanitizeTimeoutForTests(60_000);
    const heavy = "<p>x</p>" + "<span>a</span>".repeat(30_000);
    const jobs = Array.from({ length: 9 }, () => sanitize.sanitizeEmailHtml(heavy, {}));
    try {
      const r = await call(originalRoute.GET, req(`/messages/${first.id}/original?inline=1`, P.agent.session, { headers: FRAME }), { id: String(first.id) });
      assert.equal(r.status, 503);
      assert.deepEqual(markOf(r.text), { name: "compass-email", content: "refused", "data-reason": "busy" });
    } finally {
      await Promise.all(jobs);
      sanitize.setSanitizeTimeoutForTests(null);
    }
    // Busy is never kept: the next read is the email.
    const again = await call(originalRoute.GET, req(`/messages/${first.id}/original?inline=1`, P.agent.session, { headers: FRAME }), { id: String(first.id) });
    assert.equal(again.status, 200);
    assert.equal(markOf(again.text)!.content, "ok");
  });

  test("a refusal (too complex, or past its time) is kept for the message: every variant, picture choice and agent gets it without new work", async () => {
    const { first } = await opened(mail(P.req, { html: "<p>Slow inline</p>" + "<span>a</span>".repeat(20_000) }));
    html.resetOriginalCacheForTests();
    sanitize.setSanitizeTimeoutForTests(1);
    try {
      const r = await call(originalRoute.GET, req(`/messages/${first.id}/original?inline=1`, P.agent.session, { headers: FRAME }), { id: String(first.id) });
      assert.equal(r.status, 422);
    } finally {
      sanitize.setSanitizeTimeoutForTests(60_000);
    }
    try {
      const t0 = Date.now();
      for (const [q, who] of [["?inline=1&images=1", P.agent], ["", P.agent2], ["?images=1", P.manager], ["?format=info", P.agent]] as const) {
        const r = await call(originalRoute.GET, req(`/messages/${first.id}/original${q}`, who.session, { headers: q.startsWith("?inline") ? FRAME : {} }), { id: String(first.id) });
        assert.equal(r.status, 422, q);
      }
      assert.ok(Date.now() - t0 < 1500, "kept, not sanitised again");
      html.resetOriginalCacheForTests();
      const again = await call(originalRoute.GET, req(`/messages/${first.id}/original?inline=1`, P.agent.session, { headers: FRAME }), { id: String(first.id) });
      assert.equal(again.status, 200, "worked on again once it is no longer kept");
    } finally {
      sanitize.setSanitizeTimeoutForTests(null);
    }
  });

  test("a message with no original: 404, as before", async () => {
    const { first } = await opened(mail(P.req, { text: "Plain only." }));
    assert.equal((await inline(first.id, P.agent.session)).status, 404);
  });

  test("a truncated email says so in its mark", async () => {
    const big = "<p>Big</p><p>" + "word ".repeat(220_000) + "</p>";
    const { first } = await opened(mail(P.req, { html: big }));
    const r = await inline(first.id, P.agent.session);
    assert.equal(r.status, 200);
    assert.equal(markOf(r.text)!["data-truncated"], "1");
  });
});

// --- The agent's default ------------------------------------------------------------------------------------

describe("the per-agent default (email_view)", () => {
  const put = (session: string, body: unknown) => call(prefsRoute.PUT, req("/me/notification-prefs", session, { method: "PUT", body }));
  const get = (session: string) => call(prefsRoute.GET, req("/me/notification-prefs", session));

  test("formatted until the agent chooses; plain is kept; other preferences untouched; junk refused with a sentence", async () => {
    assert.equal(notifyShared.defaultPrefs().email_view, "formatted");
    assert.equal((await get(P.agent2.session)).body.prefs.email_view, "formatted");
    await put(P.agent2.session, { auto_follow: false });
    const r = await put(P.agent2.session, { email_view: "plain" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.prefs.email_view, "plain");
    assert.equal(r.body.prefs.auto_follow, false, "the rest stays");
    assert.equal((await notifyPrefs.getNotifyPrefs(P.agent2.id)).email_view, "plain");
    const bad = await put(P.agent2.session, { email_view: "html" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "Emails show formatted or as plain text.");
    assert.equal((await put(P.agent2.session, { email_view: "formatted" })).body.prefs.email_view, "formatted");
    // Per person: another agent's default is untouched.
    assert.equal((await notifyPrefs.getNotifyPrefs(P.agent.id)).email_view, "formatted");
    // A stored row from before 1.20.11 (no email_view) or a corrupt value reads as formatted.
    assert.equal(notifyShared.resolvePrefs({ sound: false }).email_view, "formatted");
    assert.equal(notifyShared.resolvePrefs({ email_view: 7 }).email_view, "formatted");
  });

  test("the requester has no such preference (the route is agents only)", async () => {
    assert.equal((await put(P.req.session, { email_view: "plain" })).status, 403);
  });
});

// --- The text stays the text elsewhere -------------------------------------------------------------------------

describe("everywhere else the text body", () => {
  test("the desk's ticket read, API v1 and the requester's read carry the text body; no HTML", async () => {
    const { t, first } = await opened(mail(P.req, { html: "<p>API <b>inline</b> check</p>", text: "API inline check" }));
    const d = await call(ticketRoute.GET, req(`/tickets/${t.number}`, P.agent.session), { number: String(t.number) });
    const m = d.body.messages.find((x: { id: number }) => x.id === first.id);
    assert.equal(m.body, "API inline check");
    assert.equal(m.has_original_html, true);
    const full = await tickets.getTicketById(t.id);
    const mine = await detail.requestDetail(P.req, full!, "requester");
    assert.ok(mine.messages.every((x) => !("has_original_html" in x) && !String(x.body).includes("<b>")));
  });
});

// --- 1.20.11 security review: folding stays a small constant factor over the sanitise ----------------------------

describe("folding cost on hostile shapes", () => {
  const chain = (n: number, open: string, close: string) => open.repeat(n) + close.repeat(n);
  const SHAPES: [string, string][] = [
    ["nested Outlook-header blocks (30 chains, 399 deep)", "<p>hi</p>" + chain(399, '<div style="border-top:solid">', "</div>").repeat(30)],
    ["one deep header chain then 50,000 elements", "<p>hi</p>" + chain(399, '<div style="border-top:solid">', "</div>") + "<b>x</b>".repeat(50_000)],
    ["a style of 27,000 border-top: names", `<p>hi</p><div style="${"border-top:".repeat(27_000)}">x</div>`],
    ["19,000 On … wrote: and blockquote pairs", "<p>hi</p>" + "<p>On Mon wrote:</p><blockquote>q</blockquote>".repeat(19_000)],
    ["29,000 blockquote type=cite", "<p>hi</p>" + "<blockquote type=cite>q</blockquote>".repeat(29_000)],
    ["40 gmail_quote chains, 399 deep", "<p>hi</p>" + chain(399, '<div class="gmail_quote">', "</div>").repeat(40)],
    ["30,000 yahoo_quoted", "<p>hi</p>" + "<div class=yahoo_quoted></div>".repeat(30_000)],
    ["40 blockquote chains, 399 deep", "<p>hi</p>" + chain(399, "<blockquote>", "</blockquote>").repeat(40)],
  ];
  const time = (html: string, inline: boolean) => {
    const t0 = process.hrtime.bigint();
    const r = worker.sanitize(html, { cids: [], ...(inline ? { inline: { collapseQuotes: true, selfHost: "localhost", truncated: false } } : {}) });
    assert.ok(r.ok);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  for (const [name, html] of SHAPES) {
    test(name, () => {
      time("<p>warm</p>", true);
      const plain = time(html, false);
      const inline = time(html, true);
      // Generous for a loaded CI runner; before the fix these were 4x to 60x (and minutes for the first).
      assert.ok(inline < plain * 2.5 + 1500, `${name}: inline ${inline.toFixed(0)} ms vs plain ${plain.toFixed(0)} ms`);
    });
  }

  test("through the route with the production time limit: the worst shape is shown, not refused", async () => {
    const { t } = await opened(mail(P.req, { html: "<p>Open</p>" }));
    const m = await replied(t, "<p>hi</p>" + chain(399, '<div style="border-top:solid">', "</div>").repeat(30));
    sanitize.setSanitizeTimeoutForTests(null);
    const r = await inline(m.id, P.agent.session);
    assert.equal(r.status, 200, r.text.slice(0, 200));
  });
});
