// Helpdesk 1.20.33: automations that change the requester and read the body,
// against Postgres:
//   - "Change the requester from the message" on inbound email: a forwarder
//     on the rule's list makes the person after "From:" the requester (an
//     account, or a new outside contact taken in as inbound email does), with
//     the activity line, the audit entry and the old requester dropped or
//     kept as a CC; a sender off the list changes nothing; a sender who failed
//     the sender check, a desk agent's address (unless allowed) and one of
//     the desk's own addresses are never picked, and the ticket says why,
//     once;
//   - "Change the requester" to a person; the manual "Change requester"
//     route (the same primitive: CCs, follows, portal, line, audit);
//   - "Copy a value into a field": a pattern's group into a choice field
//     fitted to its options, a label's text into a text field, a tag; only
//     while empty; a misfit skipped and noted;
//   - ticket_updated rules settle (a second update runs nothing; no loop);
//   - save-time checks: unknown and non-Get-help people, unknown and
//     archived fields, a person or field deleted since (the 1.20.30 rules),
//     a field outside the rule's desk department;
//   - the Claude connector: hd_draft_automation with the new fields saves a
//     draft (off, unpublished), hd_list_automations shows them in words, and
//     a draft without the sender scope is refused.
//
// Harness as test/helpdesk-automation-drafts. Parallel-safe: everything is
// this file's own (STAMP); every rule only matches this file's tickets.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-automation-requester-body.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pool, getSetting, createSession, getUserById } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

let currentRequest: Request | null = null;
function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}
const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.automation-requester-body.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.automation-requester-body.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
{
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
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
  };
  require.cache[HEADERS_STUB] = headers;
  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = { ee: () => ({ present: true, features: ["helpdesk"] }), eePresent: () => true, featureEnabled: async (f: string) => f === "helpdesk", featureEnforced: async (f: string) => f === "helpdesk", featureEnabledFrom: (f: string) => f === "helpdesk", featureEnforcedFrom: (f: string) => f === "helpdesk" };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as { _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) return EE_STUB;
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
const rolesShared = require("../src/lib/helpdesk/roles-shared") as typeof import("../src/lib/helpdesk/roles-shared");
const connector = require("../src/lib/helpdesk/claude-connector") as typeof import("../src/lib/helpdesk/claude-connector");
const hdTools = require("../src/lib/mcp/helpdesk-tools") as typeof import("../src/lib/mcp/helpdesk-tools");
const automations = require("../src/lib/helpdesk/automations") as typeof import("../src/lib/helpdesk/automations");
const inbound = require("../src/lib/helpdesk/inbound") as typeof import("../src/lib/helpdesk/inbound");
const ccs = require("../src/lib/helpdesk/ccs") as typeof import("../src/lib/helpdesk/ccs");
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const messages = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
const customFields = require("../src/lib/helpdesk/custom-fields") as typeof import("../src/lib/helpdesk/custom-fields");
const requesterChange = require("../src/lib/helpdesk/requester-change") as typeof import("../src/lib/helpdesk/requester-change");
const deskDepts = require("../src/lib/helpdesk/desk-departments") as typeof import("../src/lib/helpdesk/desk-departments");
const auditLabels = require("../src/lib/audit-labels") as typeof import("../src/lib/audit-labels");
const convo = require("../src/lib/helpdesk/conversation-shared") as typeof import("../src/lib/helpdesk/conversation-shared");
const deskTools = require("../src/lib/helpdesk/claude/tools") as typeof import("../src/lib/helpdesk/claude/tools");
const deskPrompt = require("../src/lib/helpdesk/claude/prompt") as typeof import("../src/lib/helpdesk/claude/prompt");
const deskValidate = require("../src/lib/helpdesk/claude/validate") as typeof import("../src/lib/helpdesk/claude/validate");
const deskShared = require("../src/lib/helpdesk/claude/shared") as typeof import("../src/lib/helpdesk/claude/shared");
const deskConfig = require("../src/lib/helpdesk/claude/config") as typeof import("../src/lib/helpdesk/claude/config");
const { toSessionUser } = require("../src/lib/auth") as typeof import("../src/lib/auth");
const autoRoute = require("../src/app/api/helpdesk/admin/automations/route") as typeof import("../src/app/api/helpdesk/admin/automations/route");
const autoOneRoute = require("../src/app/api/helpdesk/admin/automations/[id]/route") as typeof import("../src/app/api/helpdesk/admin/automations/[id]/route");
const requesterRoute = require("../src/app/api/helpdesk/tickets/[number]/requester/route") as typeof import("../src/app/api/helpdesk/tickets/[number]/requester/route");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { InboundEmail } from "../src/lib/helpdesk/inbound-parse";
import type { HdTicketRow } from "../src/lib/helpdesk/types";

const RUN = `${process.pid}${Date.now().toString(36)}`;
const STAMP = `hdrb-${RUN}`;
/** A phrase only this file's tickets carry: every rule here asks for it. */
const WORD = `zqrb${RUN}`;
const IP = "203.0.113.177";
const CTX = { origin: "http://localhost", ip: IP };
const ALIAS = `help-${RUN}@acme.example`;
const FORWARDER = `forms-${RUN}@forms.example`;
const STRANGER = `ceo-${RUN}@evil.example`;
const NEWBIE_CONTACT = `new-${RUN}@customer.example`;

interface Person {
  id: number;
  name: string;
  email: string;
  session: string;
}
const P: Record<string, Person> = {};
const userIds: number[] = [];
const roleIds: number[] = [];
const ruleIds: number[] = [];
let teamId = 0;
const F: Record<string, string> = {};
const dirIds: number[] = [];

async function person(key: string, opts: { desk?: "agent" | "admin" | "manager"; request?: boolean; name?: string } = {}) {
  const name = opts.name ?? `${key} ${STAMP}`;
  const email = `${key}-${RUN}@acme.example`;
  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status, timezone) VALUES ($1, $2, $3, 'viewer', 'active', 'UTC') RETURNING id`, [`${STAMP}-${key}`, name, email]);
  const id = r.rows[0].id as number;
  userIds.push(id);
  const session = newToken();
  await createSession(session, id, new Date(Date.now() + 3_600_000).toISOString());
  // No role at all (the ladder role taken away): an account that can't use Get help.
  // Deleting the Viewer assignment alone is not enough: every process's schema
  // bootstrap re-adds a ladder rung's missing assignment (db.ts
  // migrateLadderToAssignments), and the built-in Viewer role holds
  // helpdesk.request, so any test file starting in parallel handed Get help
  // back. The rung names no built-in role instead (as test/helpdesk-status-teams
  // does): the ladder trigger drops the Viewer row and the backfill has nothing to restore.
  if (opts.request === false) {
    await pool().query("UPDATE users SET role = $2 WHERE id = $1", [id, `${STAMP}-norung`]);
    await pool().query("DELETE FROM role_assignments WHERE user_id = $1", [id]);
  } else {
    const role = await fixtureQuery("INSERT INTO roles (key, name) VALUES ($1, $1) RETURNING id", [`${STAMP}-req-${key}`]);
    roleIds.push(role.rows[0].id);
    await fixtureQuery("INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'helpdesk.request')", [role.rows[0].id]);
    await fixtureQuery("INSERT INTO role_assignments (role_id, user_id, scope_type) VALUES ($1, $2, 'global')", [role.rows[0].id, id]);
  }
  if (opts.desk) {
    await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role", [id, opts.desk]);
    await pool().query("INSERT INTO hd_team_members (team_id, user_id, role) VALUES ($1, $2, 'agent') ON CONFLICT DO NOTHING", [teamId, id]);
  }
  P[key] = { id, name, email, session };
}

function mailFrom(from: string, text: string, over: Partial<InboundEmail> = {}): InboundEmail {
  return {
    provider: "generic",
    from: { email: from, name: "" },
    to: [{ email: ALIAS, name: "" }],
    cc: [],
    recipients: [],
    subject: `Web form request ${STAMP}`,
    text,
    html: "",
    stripped: "",
    messageId: `${newToken()}@mail.example.test`,
    inReplyTo: "",
    references: [],
    headers: {},
    auth: { dmarc: "pass" },
    files: [],
    ...over,
  } as InboundEmail;
}

async function mailIn(from: string, text: string, over: Partial<InboundEmail> = {}): Promise<HdTicketRow> {
  // This file sends many mails from the one forwarder: the per-sender limit is not what it tests.
  inbound.resetInboundRateLimitsForTests();
  const r = await inbound.processInboundEmail(mailFrom(from, text, over), { outsideSenders: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.ticket, JSON.stringify(r.body));
  return (await pool().query("SELECT * FROM hd_tickets WHERE number = $1", [r.body.ticket])).rows[0] as HdTicketRow;
}

const row = async (id: number) => (await pool().query("SELECT * FROM hd_tickets WHERE id = $1", [id])).rows[0] as HdTicketRow;
/** The ticket's timeline lines, each body as the desk shows it (the Markdown escapes undone). */
const lines = async (id: number) =>
  (
    (await pool().query("SELECT author_name, author_id, kind, body, event, via FROM hd_messages WHERE ticket_id = $1 AND kind <> 'public' ORDER BY id", [id])).rows as {
      author_name: string;
      author_id: number | null;
      kind: string;
      body: string;
      event: string | null;
      via: string;
    }[]
  ).map((l) => ({ ...l, body: convo.plainChangeText(l.body) }));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ccRows = async (id: number) => (await pool().query("SELECT user_id, lower(email) AS email FROM hd_ticket_ccs WHERE ticket_id = $1 ORDER BY id", [id])).rows as { user_id: number | null; email: string }[];
const values = async (id: number) =>
  Object.fromEntries(
    (await pool().query("SELECT f.key, v.value FROM hd_ticket_custom_values v JOIN hd_custom_fields f ON f.id = v.field_id WHERE v.ticket_id = $1", [id])).rows.map((r) => [r.key, r.value])
  );

/** A rule as Desk settings saves it (validated, created on and published), for this file's tickets only. */
async function rule(name: string, actions: Record<string, unknown>, opts: { event?: string; conditions?: Record<string, unknown> } = {}): Promise<number> {
  const v = await automations.validateAutomationInput({ name: `${name} ${STAMP}`, event: opts.event ?? "ticket_created", conditions: { body_contains: [WORD], ...(opts.conditions ?? {}) }, actions });
  assert.ok(v.ok, JSON.stringify(v));
  const a = await automations.createAutomation(v.value as import("../src/lib/helpdesk/automations").AutomationInput, null);
  ruleIds.push(a.id);
  return a.id;
}
const off = async (id: number) => pool().query("UPDATE hd_automations SET active = 0 WHERE id = $1", [id]);

const user = async (who: string) => (await getUserById(P[who].id))!;
async function tool(who: string, name: string, args: Record<string, unknown> = {}) {
  const r = (await hdTools.callHelpdeskTool(await user(who), name, args, CTX)) as { content: { text: string }[]; isError: boolean };
  const text = r.content[0]?.text ?? "";
  let out: any = null;
  try {
    out = JSON.parse(text);
  } catch {
    /* a sentence */
  }
  return { isError: r.isError, text, out };
}

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(handler: unknown, who: string, url: string, method = "GET", body?: unknown, params: Record<string, string> = {}) {
  currentRequest = new Request(`http://localhost/api/helpdesk${url}`, {
    method,
    headers: { cookie: `compass_session=${P[who].session}`, "content-type": "application/json", "x-forwarded-for": IP, host: "localhost", origin: "http://localhost" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const res = await (handler as Handler)(currentRequest, { params: Promise.resolve(params) });
    const raw = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* none */
    }
    return { status: res.status, body: json };
  } finally {
    currentRequest = null;
  }
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  roles.setRoleMatrixForTests(rolesShared.HD_DEFAULT_MATRIX);
  connector.setClaudeLevelForTests("notes");
  // Outside senders on for this file (the setting itself is the workspace's; these answer for this process).
  requesterChange.setRequesterOutsideSendersForTests(true);
  ccs.setOutsideSendersForTests(true);
  teamId = (await fixtureQuery("INSERT INTO hd_teams (name, position, email_alias) VALUES ($1, 9470, $2) RETURNING id", [`${STAMP} Service desk`, ALIAS])).rows[0].id;
  await person("admin", { desk: "admin" });
  await person("agent", { desk: "agent", name: `Ana Agent ${RUN}` });
  await person("jane", { name: `Jane Doe ${RUN}` });
  await person("sam", { name: `Sam Lee ${RUN}` });
  await person("viewer", { request: false, name: `Vic Viewer ${RUN}` });
  const mk = async (label: string, extra: Record<string, unknown>) => (await customFields.createCustomField({ label, key: `${label.toLowerCase().replace(/\W+/g, "_")}_${RUN}`.slice(0, 40), all_teams: false, team_ids: [teamId], ...extra }, { id: P.admin.id })).key;
  F.asset = await mk("Asset tag", { type: "text" });
  F.impact = await mk("Impact", { type: "select", options: [{ label: "High" }, { label: "Low" }] });
  F.count = await mk("Devices", { type: "number" });
});

after(async () => {
  requesterChange.setRequesterOutsideSendersForTests(null);
  ccs.setOutsideSendersForTests(null);
  connector.setClaudeLevelForTests(null);
  roles.setRoleMatrixForTests(null);
  await pool().query("DELETE FROM hd_tickets WHERE subject LIKE $1 OR team_id = $2 OR requester_id = ANY($3)", [`%${STAMP}%`, teamId, userIds]);
  await pool().query("DELETE FROM hd_automations WHERE name LIKE $1 OR id = ANY($2)", [`%${STAMP}%`, ruleIds]);
  await pool().query("DELETE FROM hd_custom_fields WHERE key = ANY($1)", [Object.values(F)]);
  await pool().query("DELETE FROM hd_team_members WHERE team_id = $1", [teamId]);
  await pool().query("DELETE FROM hd_teams WHERE id = $1", [teamId]);
  await pool().query("DELETE FROM notifications WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1) OR target_label LIKE $2", [userIds, `%${STAMP}%`]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE role_id = ANY($1)", [roleIds]);
  await pool().query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("UPDATE users SET directory_person_id = NULL WHERE id = ANY($1)", [userIds]);
  if (dirIds.length) await pool().query("DELETE FROM directory_people WHERE id = ANY($1)", [dirIds]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

describe("change the requester from the message (inbound email from a forwarder)", () => {
  test("the forwarder's message makes the person after From: the requester: the line, the audit entry, the forwarder dropped", async () => {
    const id = await rule("Web form requester", { requester_from_message: { find: "label", labels: ["From:", "Email:"], senders: [FORWARDER] } });
    try {
      const t = await mailIn(FORWARDER, `${WORD}\nSubmitted via the web form\nFrom: Jane Doe <${P.jane.email}>\nMessage: my laptop won't start`);
      const after = await row(t.id);
      assert.equal(after.requester_id, P.jane.id);
      assert.equal(after.requester_email, P.jane.email);
      assert.equal(after.requester_name, P.jane.name);
      const ls = await lines(t.id);
      const line = ls.find((l) => /changed the requester/.test(l.body));
      assert.ok(line, JSON.stringify(ls));
      assert.equal(line.author_name, `Automation: Web form requester ${STAMP}`);
      assert.equal(line.kind, "internal");
      assert.equal(line.event, "change");
      assert.equal(line.via, "system");
      assert.match(line.body, new RegExp(`changed the requester from ${escapeRe(FORWARDER)} to ${escapeRe(P.jane.name)}$`));
      const audit = (await pool().query("SELECT actor_id, actor_name, details FROM audit_log WHERE action = 'helpdesk.ticket.requester_changed' AND target_id = $1", [String(t.id)])).rows;
      assert.equal(audit.length, 1);
      assert.equal(audit[0].actor_id, null);
      assert.equal(audit[0].details.automation, id);
      assert.equal(audit[0].details.how, "from_message");
      assert.deepEqual(audit[0].details.to, { user_id: P.jane.id, name: P.jane.name, email: P.jane.email });
      assert.equal(audit[0].details.from.email, FORWARDER);
      assert.deepEqual(await ccRows(t.id), [], "the old requester is dropped unless kept as a CC");
      assert.equal(auditLabels.actionLabel("helpdesk.ticket.requester_changed"), "Changed a ticket's requester");
      // The run counted: last_run_at set.
      assert.ok((await pool().query("SELECT last_run_at FROM hd_automations WHERE id = $1", [id])).rows[0].last_run_at);
    } finally {
      await off(id);
    }
  });

  test("the same email from a sender off the list changes nothing, and says nothing", async () => {
    const id = await rule("Scoped requester", { requester_from_message: { senders: [FORWARDER] } });
    try {
      const t = await mailIn(STRANGER, `${WORD}\nFrom: ${P.jane.email}\nPlease make me the requester`);
      const after = await row(t.id);
      assert.equal(after.requester_id, null);
      assert.equal(after.requester_email, STRANGER);
      assert.equal((await lines(t.id)).filter((l) => /requester/.test(l.body)).length, 0);
      // A domain entry covers the forwarder's domain, not the stranger's.
      const v = await automations.validateAutomationInput({ name: "x", event: "ticket_created", actions: { requester_from_message: { senders: ["@forms.example"] } } });
      assert.ok(v.ok);
    } finally {
      await off(id);
    }
  });

  test("a forwarder that failed the sender check moves nothing; the ticket says why", async () => {
    const id = await rule("Checked requester", { requester_from_message: { senders: [FORWARDER] } });
    try {
      const t = await mailIn(FORWARDER, `${WORD}\nFrom: ${P.jane.email}`, { auth: { dmarc: "fail" } as never });
      assert.equal((await row(t.id)).requester_email, FORWARDER);
      const skip = (await lines(t.id)).filter((l) => /couldn't change the requester/.test(l.body));
      assert.equal(skip.length, 1);
      assert.match(skip[0].body, /didn't pass the sender check/);
      assert.equal(skip[0].event, "change");
      assert.equal(skip[0].author_name, `Automation: Checked requester ${STAMP}`);
      assert.equal((await pool().query("SELECT sender_verified FROM hd_messages WHERE ticket_id = $1 AND kind = 'public' ORDER BY id LIMIT 1", [t.id])).rows[0].sender_verified, false);
      // An email from before 1.20.33 (no sender check recorded) is not trusted either.
      const old = await mailIn(FORWARDER, `${WORD}\nFrom: ${P.sam.email}`, { subject: `Older mail ${STAMP}` });
      await pool().query("UPDATE hd_messages SET sender_verified = NULL WHERE ticket_id = $1", [old.id]);
      await pool().query("UPDATE hd_tickets SET requester_id = NULL, requester_name = $2, requester_email = $2 WHERE id = $1", [old.id, FORWARDER]);
      const r = (await pool().query("SELECT * FROM hd_automations WHERE id = $1", [id])).rows[0];
      assert.equal(await automations.applyRule(r, await row(old.id)), false);
      assert.equal((await row(old.id)).requester_email, FORWARDER);
      assert.ok((await lines(old.id)).some((l) => /came in before its sender check was recorded/.test(l.body)));
    } finally {
      await off(id);
    }
  });

  test("a desk agent's address and the desk's own address are never picked (agents only when allowed); one candidate only; the skip is noted once", async () => {
    const id = await rule("Agents excluded", { requester_from_message: { senders: [FORWARDER] } });
    let t: HdTicketRow;
    try {
      // The topmost labelled line decides (review L1): its address is refused, and the "Email:" line under it is not tried.
      t = await mailIn(FORWARDER, `${WORD}\nFrom: ${P.agent.email}\nEmail: ${P.jane.email}`);
      assert.equal((await row(t.id)).requester_email, FORWARDER);
      const skip = (await lines(t.id)).filter((l) => /couldn't change the requester/.test(l.body));
      assert.equal(skip.length, 1, JSON.stringify(skip));
      assert.match(skip[0].body, /belongs to a desk agent$/);
      // Run again on the same ticket: the same reason is not written twice.
      const r = await pool().query("SELECT * FROM hd_automations WHERE id = $1", [id]);
      assert.equal(await automations.applyRule(r.rows[0], await row(t.id)), false);
      assert.equal((await lines(t.id)).filter((l) => /couldn't change the requester/.test(l.body)).length, 1);
      // One of the desk's own addresses (a team's alias).
      const own = await mailIn(FORWARDER, `${WORD}\nFrom: Help <${ALIAS}>`);
      assert.equal((await row(own.id)).requester_email, FORWARDER);
      assert.ok((await lines(own.id)).some((l) => /is one of the desk's own addresses/.test(l.body)));
      // Review L7: the agent's address with a +tag, in another case, and an alias their directory entry has.
      const [local, domain] = P.agent.email.split("@");
      const tagged = await mailIn(FORWARDER, `${WORD}\nFrom: ${local.toUpperCase()}+desk@${domain.toUpperCase()}`);
      assert.ok((await lines(tagged.id)).some((l) => /belongs to a desk agent/.test(l.body)));
      const alias = `ana.alias-${RUN}@acme.example`;
      const dp = await pool().query("INSERT INTO directory_people (name, email, provider_record) VALUES ($1, $2, $3) RETURNING id", [
        `Ana ${STAMP}`,
        `ana.dir-${RUN}@acme.example`,
        JSON.stringify({ proxyAddresses: [`SMTP:${P.agent.email}`, `smtp:${alias}`] }),
      ]);
      dirIds.push(dp.rows[0].id);
      await pool().query("UPDATE users SET directory_person_id = $2 WHERE id = $1", [P.agent.id, dp.rows[0].id]);
      for (const a of [alias, `ana.dir-${RUN}@acme.example`]) {
        const x = await mailIn(FORWARDER, `${WORD}\nFrom: <${a}>`);
        assert.equal((await row(x.id)).requester_email, FORWARDER, a);
        assert.ok((await lines(x.id)).some((l) => /belongs to a desk agent/.test(l.body)), a);
      }
    } finally {
      await off(id);
    }
    const allowed = await rule("Agents allowed", { requester_from_message: { senders: [FORWARDER], allow_agents: true } });
    try {
      const t2 = await mailIn(FORWARDER, `${WORD}\nFrom: ${P.agent.email}`);
      assert.equal((await row(t2.id)).requester_id, P.agent.id);
    } finally {
      await off(allowed);
    }
  });

  test("the display name never picks the requester: only the bracketed address (review H1)", async () => {
    const id = await rule("Display names", { requester_from_message: { senders: [FORWARDER], domains: ["@customer.example"] } });
    try {
      const t = await mailIn(FORWARDER, `${WORD}\nFrom: "${P.jane.email}" <attacker-${RUN}@evil.example>`);
      assert.equal((await row(t.id)).requester_email, FORWARDER);
      assert.ok((await lines(t.id)).some((l) => new RegExp(`attacker-${RUN}@evil\\.example isn't at @customer\\.example`).test(l.body)));
    } finally {
      await off(id);
    }
  });

  test("an address nobody has becomes a new outside contact, as inbound email takes one in; keep_cc keeps the forwarder as a CC", async () => {
    const id = await rule("New contact", { requester_from_message: { find: "first", senders: [FORWARDER], domains: ["@customer.example"], keep_cc: true } });
    try {
      const t = await mailIn(FORWARDER, `${WORD}\nName: Nia New\nContact: Nia New <${NEWBIE_CONTACT}>\nReply-To: noreply@forms.example`);
      const after = await row(t.id);
      assert.equal(after.requester_id, null);
      assert.equal(after.requester_email, NEWBIE_CONTACT);
      assert.equal(after.requester_name, "Nia New");
      assert.deepEqual(await ccRows(t.id), [{ user_id: null, email: FORWARDER }]);
      const ls = await lines(t.id);
      assert.ok(ls.some((l) => l.kind === "system" && /added .* as CC\./.test(l.body)), JSON.stringify(ls));
      assert.ok(ls.some((l) => l.body.endsWith(`changed the requester from ${FORWARDER} to Nia New (${NEWBIE_CONTACT})`)), JSON.stringify(ls));
    } finally {
      await off(id);
    }
  });
});

describe("change the requester to a person, and the manual control", () => {
  test("a rule makes a named person the requester; the CC they held goes, they stop following", async () => {
    const id = await rule("Make Sam requester", { requester_set: { user_id: P.sam.id, keep_cc: true } });
    try {
      const t = await tickets.createTicket(
        { subject: `Laptop ${STAMP}`, body: `${WORD} please`, requester: { id: P.jane.id, name: P.jane.name, email: P.jane.email }, team_id: teamId, via: "portal", source: "portal" },
        { silent: true }
      );
      const after = await row(t.id);
      assert.equal(after.requester_id, P.sam.id);
      assert.deepEqual(await ccRows(t.id), [{ user_id: P.jane.id, email: P.jane.email.toLowerCase() }], "keep_cc kept Jane as a CC");
    } finally {
      await off(id);
    }
  });

  test("POST /tickets/[number]/requester: an agent who works it changes the requester; CCs, follows, line and audit", async () => {
    const t = await tickets.createTicket(
      { subject: `Monitor ${STAMP}`, body: "no signal", requester: { id: null, name: "Forms", email: FORWARDER }, team_id: teamId, via: "email", source: "email" },
      { silent: true }
    );
    // Sam is copied, and an agent-ish follow row exists for him.
    await ccs.addCcs(t.id, [{ userId: P.sam.id }], { userId: P.agent.id, name: P.agent.name });
    await pool().query("INSERT INTO hd_ticket_followers (ticket_id, user_id, added_by) VALUES ($1, $2, $2) ON CONFLICT DO NOTHING", [t.id, P.sam.id]);
    const r = await call(requesterRoute.POST, "agent", `/tickets/${t.number}/requester`, "POST", { user_id: P.sam.id }, { number: String(t.number) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changed, true);
    assert.equal(r.body.ticket.requester_id, P.sam.id);
    assert.deepEqual(await ccRows(t.id), [], "the new requester is no CC, and the old one is dropped");
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM hd_ticket_followers WHERE ticket_id = $1 AND user_id = $2", [t.id, P.sam.id])).rows[0].n, 0);
    const line = (await lines(t.id)).find((l) => /changed the requester/.test(l.body))!;
    assert.equal(line.author_id, P.agent.id);
    assert.equal(line.event, "change");
    const audit = (await pool().query("SELECT actor_id, details, ip FROM audit_log WHERE action = 'helpdesk.ticket.requester_changed' AND target_id = $1", [String(t.id)])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_id, P.agent.id);
    assert.equal(audit[0].ip, IP);
    // Again: nothing changes.
    const again = await call(requesterRoute.POST, "agent", `/tickets/${t.number}/requester`, "POST", { user_id: P.sam.id }, { number: String(t.number) });
    assert.equal(again.body.changed, false);
    // Someone who can't use Get help is refused in a sentence; so is an agent who doesn't work the ticket's team (404).
    const viewer = await call(requesterRoute.POST, "agent", `/tickets/${t.number}/requester`, "POST", { user_id: P.viewer.id }, { number: String(t.number) });
    assert.equal(viewer.status, 400);
    assert.match(viewer.body.error, /can't use Get help, so they can't be a requester/);
    const own = await call(requesterRoute.POST, "agent", `/tickets/${t.number}/requester`, "POST", { email: ALIAS }, { number: String(t.number) });
    assert.equal(own.status, 400);
    const stranger = await call(requesterRoute.POST, "jane", `/tickets/${t.number}/requester`, "POST", { user_id: P.jane.id }, { number: String(t.number) });
    assert.ok([403, 404].includes(stranger.status), String(stranger.status));
  });
});

describe("copy a value into a field", () => {
  test("a pattern's group into a choice field (any case), a label's text into a text field, a tag; a misfit is skipped and noted", async () => {
    const id = await rule("Copy values", {
      copy_values: [
        { from: "body", pattern: "Impact:\\s*(\\w+)", field_key: F.impact },
        { from: "body", label: "Asset tag:", field_key: F.asset },
        { from: "body", label: "Devices:", field_key: F.count },
        { from: "subject", pattern: "\\[(site-\\w+)\\]", tag: true },
      ],
    });
    try {
      const t = await mailIn(FORWARDER, `${WORD}\nImpact: HIGH\nAsset tag:  LT-0042  \nDevices: a dozen`, { subject: `[site-north] Web form ${STAMP}` });
      assert.deepEqual(await values(t.id), { [F.impact]: "high", [F.asset]: "LT-0042" });
      assert.ok((await row(t.id)).tags.includes("site-north"));
      const ls = await lines(t.id);
      assert.ok(ls.some((l) => l.event === "change" && /set Impact to High/.test(l.body)), JSON.stringify(ls));
      const skip = ls.filter((l) => /couldn't copy into Devices/.test(l.body));
      assert.equal(skip.length, 1);
      assert.match(skip[0].body, /is not a number/);
      // The copied values are audited as the rule's change.
      const audit = (await pool().query("SELECT actor_name, details FROM audit_log WHERE action = 'helpdesk.ticket.updated' AND target_id = $1", [String(t.id)])).rows;
      assert.equal(audit.length, 1);
      assert.equal(audit[0].actor_name, `Automation: Copy values ${STAMP}`);
      assert.deepEqual([audit[0].details.automation, [...audit[0].details.changed].sort(), [...audit[0].details.fields].sort()], [id, ["custom_fields", "tags"], [F.asset, F.impact].sort()]);
    } finally {
      await off(id);
    }
  });

  test("only while the field is empty, by default; a ticket_updated rule settles and never loops", async () => {
    const id = await rule("Copy on update", { copy_values: [{ from: "body", label: "Asset tag:", field_key: F.asset }] }, { event: "ticket_updated" });
    try {
      const t = await tickets.createTicket(
        { subject: `Dock ${STAMP}`, body: `${WORD}\nAsset tag: DK-7`, requester: { id: P.sam.id, name: P.sam.name, email: P.sam.email }, team_id: teamId, via: "portal", source: "portal" },
        { silent: true }
      );
      const first = await automations.runAutomations("ticket_updated", t.id);
      assert.deepEqual(first.ran, [id]);
      assert.deepEqual(await values(t.id), { [F.asset]: "DK-7" });
      const changes = (await lines(t.id)).length;
      // A person's later update (and the rule's own writes) run nothing more: the value is there.
      await tickets.updateTicket(t.id, { priority: "high" }, { id: P.agent.id, name: P.agent.name });
      const second = await automations.runAutomations("ticket_updated", t.id);
      assert.deepEqual(second.ran, [], "nothing left to change: the rule settles");
      assert.equal((await lines(t.id)).length, changes + 1, "only the person's priority line");
      // A value set by hand stays: only while empty.
      await tickets.updateTicket(t.id, { custom_fields: { [F.asset]: "BY-HAND" } }, { id: P.agent.id, name: P.agent.name });
      assert.deepEqual((await automations.runAutomations("ticket_updated", t.id)).ran, []);
      assert.deepEqual(await values(t.id), { [F.asset]: "BY-HAND" });
    } finally {
      await off(id);
    }
  });
});

describe("rules and an agent's correction (review M3, M4)", () => {
  test("the requester changes only on a new ticket or the requester's message: other events are refused everywhere", async () => {
    for (const event of ["ticket_updated", "sla_nearing", "sla_breached"]) {
      const v = await automations.validateAutomationInput({ name: `Ev ${STAMP}`, event, actions: { requester_set: { user_id: P.jane.id } } });
      assert.deepEqual(v, { ok: false, error: automations.REQUESTER_EVENT_REFUSED }, event);
    }
    assert.equal((await automations.validateAutomationInput({ name: `Ev ${STAMP}`, event: "requester_message", actions: { requester_from_message: { senders: [FORWARDER] } } })).ok, true);
    const route = await call(autoRoute.POST, "admin", "/admin/automations", "POST", { name: `Ev ${STAMP}`, event: "ticket_updated", actions: { requester_from_message: { senders: [FORWARDER] } } });
    assert.deepEqual([route.status, route.body.error], [400, automations.REQUESTER_EVENT_REFUSED]);
    const mcp = await tool("admin", "hd_draft_automation", { name: `Ev ${STAMP}`, event: "sla_breached", actions: { requester_set: { user_id: P.jane.id } } });
    assert.equal(mcp.isError, true);
    assert.match(mcp.text, /only on "A ticket is created" or "The requester sends a message"/);
    // A rule saved on a new ticket can't be moved to another event while it changes the requester; switching it off always works.
    const id = await rule("Event move", { requester_set: { user_id: P.jane.id } });
    await assert.rejects(automations.updateAutomation(id, { event: "ticket_updated" }), /only on "A ticket is created"/);
    assert.ok(await automations.updateAutomation(id, { active: 0 }));
  });

  test("once an agent sets the requester by hand, rules never change it again, and say so once", async () => {
    const id = await rule("Late requester", { requester_from_message: { senders: [FORWARDER] } }, { event: "requester_message" });
    try {
      const t = await tickets.createTicket(
        { subject: `Hand set ${STAMP}`, body: "Opened by the form", requester: { id: null, name: "Forms", email: FORWARDER }, team_id: teamId, via: "email", source: "email" },
        { silent: true }
      );
      const r = await call(requesterRoute.POST, "agent", `/tickets/${t.number}/requester`, "POST", { user_id: P.sam.id }, { number: String(t.number) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok((await row(t.id)).requester_set_by_agent_at, "the change by hand is recorded");
      // The forwarder writes again (copied, so its message is a requester-side message): the rule leaves Sam.
      await ccs.addCcs(t.id, [{ email: FORWARDER, name: "Forms" }], { userId: P.agent.id, name: P.agent.name });
      for (let i = 0; i < 2; i++) {
        await messages.addMessage(t.id, { kind: "public", body: `${WORD}\nFrom: ${P.jane.email}`, author: { id: null, name: "Forms", email: FORWARDER }, via: "email", asRequester: true, sender_verified: true });
      }
      assert.equal((await row(t.id)).requester_id, P.sam.id);
      const skip = (await lines(t.id)).filter((l) => /couldn't change the requester: an agent set it by hand/.test(l.body));
      assert.equal(skip.length, 1, "noted once");
    } finally {
      await off(id);
    }
  });

  test("every rule of a run reads the same triggering message and its real sender (a CC's message is the CC's)", async () => {
    const CC = `cc-${RUN}@forms.example`;
    const a = await rule("Run first", { requester_from_message: { senders: [CC] } }, { event: "requester_message" });
    const b = await rule("Run second", { copy_values: [{ from: "body", label: "Asset tag:", field_key: F.asset }] }, { event: "requester_message" });
    try {
      const t = await tickets.createTicket(
        { subject: `Same message ${STAMP}`, body: "Opened", requester: { id: P.sam.id, name: P.sam.name, email: P.sam.email }, team_id: teamId, via: "portal", source: "portal" },
        { silent: true }
      );
      await ccs.addCcs(t.id, [{ email: CC, name: "Form copy" }], { userId: P.agent.id, name: P.agent.name });
      // The CC writes: the rules read the CC's message with the CC as its sender; the first changes the requester,
      // and the second still reads that same message (before 1.20.33 it re-read the new requester's, finding none).
      await messages.addMessage(t.id, { kind: "public", body: `${WORD}\nFrom: ${P.jane.email}\nAsset tag: CC-9`, author: { id: null, name: "Form copy", email: CC }, via: "email", asRequester: true, sender_verified: true });
      assert.equal((await row(t.id)).requester_id, P.jane.id);
      assert.deepEqual(await values(t.id), { [F.asset]: "CC-9" });
    } finally {
      await off(a);
      await off(b);
    }
  });
});

describe("the sender check, acknowledgements, drafts and ticket states (review M1, M2, L3, L4, L9, L10)", () => {
  test("an address trusted without SPF/DKIM results is not a checked sender (M1); a DMARC pass must align with the From (M2)", async () => {
    const id = await rule("Trusted only", { requester_from_message: { senders: [FORWARDER] } });
    try {
      // No verdict at all, with "trust addresses without results" on: taken in, but not checked.
      const r = await inbound.processInboundEmail(mailFrom(FORWARDER, `${WORD}\nFrom: ${P.jane.email}`, { auth: {} as never }), { outsideSenders: true, trustUnverified: true });
      const t = (await pool().query("SELECT * FROM hd_tickets WHERE number = $1", [r.body.ticket])).rows[0] as HdTicketRow;
      assert.equal((await pool().query("SELECT sender_verified FROM hd_messages WHERE ticket_id = $1 AND kind = 'public' ORDER BY id LIMIT 1", [t.id])).rows[0].sender_verified, false);
      assert.equal((await row(t.id)).requester_email, FORWARDER);
      // A DMARC pass in Authentication-Results without header.from, or for another domain: not checked either.
      for (const ar of ["mx.forms.example; dmarc=pass", "mx.forms.example; dmarc=pass header.from=evil.example"]) {
        const x = await mailIn(FORWARDER, `${WORD}\nFrom: ${P.jane.email}`, { auth: undefined, headers: { "authentication-results": ar }, headerList: [["authentication-results", ar]] } as never);
        assert.equal((await row(x.id)).requester_email, FORWARDER, ar);
      }
      // Aligned: checked, and the requester changes.
      const ok = await mailIn(FORWARDER, `${WORD}\nFrom: ${P.jane.email}`, { auth: undefined, headers: { "authentication-results": "mx.forms.example; dmarc=pass header.from=forms.example" }, headerList: [["authentication-results", "mx.forms.example; dmarc=pass header.from=forms.example"]] } as never);
      assert.equal((await row(ok.id)).requester_id, P.jane.id);
    } finally {
      await off(id);
    }
  });

  test("trusted senders (1.20.25) need the same aligned pass (M2)", () => {
    const list = ["@forms.example"];
    const withAr = (ar: string) => mailFrom(FORWARDER, "x", { auth: undefined, headers: { "authentication-results": ar }, headerList: [["authentication-results", ar]] } as never);
    assert.equal(inbound.isTrustedSender(withAr("mx; dmarc=pass header.from=forms.example"), list), true);
    assert.equal(inbound.isTrustedSender(withAr("mx; dmarc=pass"), list), false);
    assert.equal(inbound.isTrustedSender(withAr("mx; dmarc=pass header.from=evil.example"), list), false);
    assert.equal(inbound.isTrustedSender(mailFrom(FORWARDER, "x", { auth: { dmarc: "pass" } as never }), list), true, "the provider's own verdict on its parsed From");
    // A display name holding a listed address changes nothing: the From is the bracketed address.
    assert.equal(inbound.isTrustedSender(mailFrom(`attacker@evil.example`, "x", { auth: { dmarc: "pass" } as never }), list), false);
  });

  test("acknowledgements to requesters taken from the message are limited per address and held past it (L3)", async () => {
    const target = `ack-${RUN}@customer.example`;
    const id = await rule("Ack limit", { requester_from_message: { senders: [FORWARDER] } });
    try {
      const made: HdTicketRow[] = [];
      for (let i = 0; i <= automations.REQUESTER_ACK_LIMITS.perAddressPerDay; i++) made.push(await mailIn(FORWARDER, `${WORD}\nFrom: <${target}>`));
      const rows = await Promise.all(made.map((t) => row(t.id)));
      assert.ok(rows.every((r) => r.requester_email === target), "the requester still changes");
      assert.deepEqual(rows.map((r) => !!r.requester_ack_held_at), [...Array(automations.REQUESTER_ACK_LIMITS.perAddressPerDay).fill(false), true]);
      const last = await lines(made[made.length - 1].id);
      assert.ok(last.some((l) => new RegExp(`held the acknowledgment to ${target.replace(/[.]/g, "\\.")}`).test(l.body)), JSON.stringify(last));
    } finally {
      await off(id);
    }
  });

  test("drafts are checked for the fields' desk department at save and on publish (L4)", async () => {
    const dept = (await pool().query("INSERT INTO hd_desk_departments (name) VALUES ($1) RETURNING id", [`Other ${STAMP}`])).rows[0].id as number;
    const otherTeam = (await fixtureQuery("INSERT INTO hd_teams (name, position, desk_department_id) VALUES ($1, 9471, $2) RETURNING id", [`${STAMP} Other`, dept])).rows[0].id as number;
    const key = `other_${RUN}`.slice(0, 40);
    try {
      await customFields.createCustomField({ label: `Other field ${RUN}`, key, type: "text", all_teams: false, team_ids: [otherTeam] }, { id: P.admin.id });
      F.other = key;
      const d = await tool("admin", "hd_draft_automation", { name: `Other dept ${STAMP}`, event: "ticket_created", actions: { copy_values: [{ from: "body", label: "X:", field_key: key }] } });
      assert.equal(d.isError, true, d.text);
      assert.match(d.text, /isn't a field of any team in the .* desk department/);
      // A draft row that names it anyway (saved before the check): publishing it is refused.
      const row0 = await pool().query(
        `INSERT INTO hd_automations (name, event, conditions, actions, active, position, published, draft_by_name, draft_at, draft_via, desk_department_id)
         VALUES ($1, 'ticket_created', '{}', $2, 0, 9991, 0, 'Claude', now(), 'mcp', hd_default_desk_department()) RETURNING id, draft_at`,
        [`Sneaky ${STAMP}`, JSON.stringify({ copy_values: [{ from: "body", label: "X:", field_key: key }] })]
      );
      ruleIds.push(row0.rows[0].id);
      const pub = await call(autoOneRoute.PATCH, "admin", `/admin/automations/${row0.rows[0].id}`, "PATCH", { name: `Sneaky ${STAMP}`, event: "ticket_created", conditions: {}, actions: { copy_values: [{ from: "body", label: "X:", field_key: key }] }, publish: true, draft_at: row0.rows[0].draft_at }, { id: String(row0.rows[0].id) });
      assert.equal(pub.status, 400, JSON.stringify(pub.body));
      assert.equal(pub.body.code, "desk_department");
    } finally {
      await pool().query("DELETE FROM hd_custom_fields WHERE key = $1", [key]);
      await pool().query("DELETE FROM hd_teams WHERE id = $1", [otherTeam]);
      await pool().query("DELETE FROM hd_desk_departments WHERE id = $1", [dept]);
    }
  });

  test("closed tickets and tickets on legal hold change as other field edits do; a ticket with no requester gets one (L9, L10)", async () => {
    const t = await tickets.createTicket(
      { subject: `Held ${STAMP}`, body: "x", requester: { id: P.sam.id, name: P.sam.name, email: P.sam.email }, team_id: teamId, via: "portal", source: "portal", status: "closed" },
      { silent: true }
    );
    await pool().query("UPDATE hd_tickets SET legal_hold = 1 WHERE id = $1", [t.id]);
    // A field edit works on it…
    assert.ok((await tickets.updateTicket(t.id, { tags: ["held"] }, { id: P.agent.id, name: P.agent.name }))?.changed.includes("tags"));
    // …and so does a requester change.
    const r = await call(requesterRoute.POST, "agent", `/tickets/${t.number}/requester`, "POST", { user_id: P.jane.id }, { number: String(t.number) });
    assert.deepEqual([r.status, r.body.changed], [200, true]);
    await pool().query("UPDATE hd_tickets SET legal_hold = 0 WHERE id = $1", [t.id]);
    // No requester (an alert, say): an agent adds one through the same primitive.
    const none = await tickets.createTicket({ subject: `Alert ${STAMP}`, body: "disk full", requester: { id: null, name: "", email: "" }, team_id: teamId, via: "api", source: "api" }, { silent: true });
    const add = await call(requesterRoute.POST, "agent", `/tickets/${none.number}/requester`, "POST", { email: NEWBIE_CONTACT, name: "Nia New" }, { number: String(none.number) });
    assert.deepEqual([add.status, add.body.changed, add.body.ticket.requester_email], [200, true, NEWBIE_CONTACT]);
    assert.ok((await lines(none.id)).some((l) => l.body.endsWith(`set the requester to Nia New (${NEWBIE_CONTACT})`)));
  });
});

describe("save-time checks", () => {
  const save = (actions: Record<string, unknown>, stored = automations.NO_AUTOMATION_REFS) => automations.validateAutomationInput({ name: `Check ${STAMP}`, event: "ticket_created", actions }, false, stored);
  test("people: unknown, can't use Get help, one of the desk's own addresses", async () => {
    assert.deepEqual(await save({ requester_set: { user_id: 99_999_999 } }), { ok: false, error: "Change the requester: unknown person. Pick someone with an active account, or an address." });
    const v = await save({ requester_set: { user_id: P.viewer.id } });
    assert.equal(v.ok, false);
    assert.match((v as { error: string }).error, /^Change the requester: Vic Viewer .* can't use Get help/);
    const own = await save({ requester_set: { email: ALIAS } });
    assert.match((own as { error: string }).error, /one of the desk's own addresses/);
    assert.equal((await save({ requester_set: { email: NEWBIE_CONTACT, name: "Nia" } })).ok, true);
  });

  test("a person or a field deleted since: dropped with a notice, refused when it was all the rule did (the 1.20.30 rules)", async () => {
    const gone = 99_999_998;
    const stored = automations.automationStoredRefs({ actions: { requester_set: { user_id: gone }, copy_values: [{ from: "body", label: "X:", field_key: "deleted_field_zz" }] } });
    const both = await save({ requester_set: { user_id: gone }, copy_values: [{ from: "body", label: "X:", field_key: "deleted_field_zz" }], tags_add: ["kept"] }, stored);
    assert.ok(both.ok, JSON.stringify(both));
    assert.deepEqual(both.value.actions, { tags_add: ["kept"] });
    assert.deepEqual(both.notices, [automations.AUTOMATION_GONE.requesterAction, automations.AUTOMATION_GONE.fieldAction]);
    assert.deepEqual(await save({ requester_set: { user_id: gone } }, stored), { ok: false, error: automations.AUTOMATION_GONE.requesterOnlyAction });
    assert.deepEqual(await save({ copy_values: [{ from: "body", label: "X:", field_key: "deleted_field_zz" }] }, stored), { ok: false, error: automations.AUTOMATION_GONE.fieldOnlyAction });
    // Not named before: refused.
    assert.match((await save({ copy_values: [{ from: "body", label: "X:", field_key: "deleted_field_zz" }] })).ok ? "" : "no custom field", /no custom field/);
  });

  test("an archived field can't be newly named; a field outside the rule's desk department is refused by the route", async () => {
    const key = `archived_${RUN}`.slice(0, 40);
    const f = await customFields.createCustomField({ label: `Old ${RUN}`, key, type: "text", all_teams: true }, { id: P.admin.id });
    F.archived = f.key;
    await pool().query("UPDATE hd_custom_fields SET archived_at = now() WHERE key = $1", [key]);
    customFields.invalidateCustomFields();
    const r = await save({ copy_values: [{ from: "body", label: "X:", field_key: key }] });
    assert.match((r as { error: string }).error, /is archived, so a rule can't fill it in/);
    // The field of a team in the default department is not a field of another department's teams.
    const other = await pool().query("INSERT INTO hd_desk_departments (name) VALUES ($1) RETURNING id", [`Dept ${STAMP}`]).catch(() => null);
    if (other) {
      try {
        const msg = await deskDepts.automationFieldsRefusal(other.rows[0].id, [{ field_key: F.asset }]);
        assert.match(msg ?? "", /isn't a field of any team in the .* desk department/);
        assert.equal(await deskDepts.automationFieldsRefusal(null, [{ field_key: F.asset }]), null);
      } finally {
        await pool().query("DELETE FROM hd_desk_departments WHERE id = $1", [other.rows[0].id]);
      }
    }
  });

  test("the settings route: the scope sentence, and the GET lists fields and requester names", async () => {
    const r = await call(autoRoute.POST, "admin", "/admin/automations", "POST", { name: `No scope ${STAMP}`, event: "ticket_created", actions: { requester_from_message: { find: "label", senders: [] } } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, automations.REQUESTER_SCOPE_REQUIRED);
    const ok = await call(autoRoute.POST, "admin", "/admin/automations", "POST", {
      name: `With scope ${STAMP}`,
      event: "ticket_created",
      active: 0,
      conditions: { body_contains: [WORD], subject_pattern: { pattern: "^\\[web form\\]" } },
      actions: { requester_set: { user_id: P.jane.id }, copy_values: [{ from: "body", label: "Asset tag:", field_key: F.asset }] },
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    ruleIds.push(ok.body.automation.id);
    const g = await call(autoRoute.GET, "admin", "/admin/automations");
    assert.equal(g.status, 200);
    assert.ok(g.body.requesters.some((x: { id: number }) => x.id === P.jane.id));
    assert.ok(g.body.fields.some((x: { key: string; type: string }) => x.key === F.impact && x.type === "select"));
    const mine = g.body.automations.find((a: { id: number }) => a.id === ok.body.automation.id);
    assert.deepEqual(mine.in_words.if, [`the message contains "${WORD}"`, "the subject matches the pattern /^\\[web form\\]/"]);
    assert.deepEqual(mine.in_words.then, [`make ${P.jane.name} the requester`, 'copy the text after "Asset tag:" in the message into Asset tag while it is empty']);
  });
});

describe("the Claude connector: drafts with the new fields stay drafts", () => {
  test("hd_draft_automation saves it off and unpublished; hd_list_automations shows it; no sender scope, no draft", async () => {
    const draft = await tool("admin", "hd_draft_automation", {
      name: `Claude web form ${STAMP}`,
      event: "ticket_created",
      conditions: { body_contains: [WORD, "Submitted via"], body_pattern: { pattern: "Asset tag:\\s*\\S+" } },
      actions: {
        requester_from_message: { find: "label", labels: ["Email:"], senders: [FORWARDER] },
        copy_values: [{ from: "body", label: "Asset tag:", field_key: F.asset }],
      },
    });
    assert.equal(draft.isError, false, draft.text);
    const id = draft.out.id as number;
    ruleIds.push(id);
    assert.equal(draft.out.saved, "draft (switched off, not published)");
    assert.equal(draft.out.active, false);
    assert.equal(draft.out.published, false);
    assert.deepEqual(draft.out.in_words.then, [
      `make the email address after "Email:" in the message the requester, only for messages from ${FORWARDER}`,
      'copy the text after "Asset tag:" in the message into Asset tag while it is empty',
    ]);
    const stored = (await pool().query("SELECT active, published, conditions, actions FROM hd_automations WHERE id = $1", [id])).rows[0];
    assert.equal(stored.active, 0);
    assert.equal(stored.published, 0);
    assert.deepEqual(stored.actions.requester_from_message, { find: "label", labels: ["Email:"], senders: [FORWARDER] });
    // A draft never runs.
    const t = await mailIn(FORWARDER, `${WORD}\nSubmitted via the form\nEmail: ${P.jane.email}\nAsset tag: Q-1`);
    assert.equal((await row(t.id)).requester_email, FORWARDER);
    // The listing shows the new parts in words, and the shape the draft tool takes.
    const one = await tool("admin", "hd_list_automations", { id });
    assert.equal(one.isError, false, one.text);
    assert.deepEqual(one.out.conditions.body_pattern, { pattern: "Asset tag:\\s*\\S+" });
    assert.ok(one.out.in_words.if.includes('the message matches the pattern /Asset tag:\\s*\\S+/'));
    const all = await tool("admin", "hd_list_automations");
    assert.ok(all.out.automations.some((a: { id: number; then: string[] }) => a.id === id && a.then[0].includes(`only for messages from ${FORWARDER}`)));
    // Without the sender scope: refused, nothing saved.
    const bad = await tool("admin", "hd_draft_automation", { name: `Unscoped ${STAMP}`, event: "ticket_created", actions: { requester_from_message: { find: "first", senders: [] } } });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /Only for messages from/);
    assert.match(bad.text, /Nothing was saved\./);
    // The tool's description says so too.
    const spec = (await hdTools.helpdeskToolsFor(await user("admin"))).find((x) => x.name === "hd_draft_automation")!;
    assert.match(spec.description, /requester_from_message REQUIRES senders/);
  });
});

describe("Claude in the desk: the strict tool takes the new fields", () => {
  test("draft_automation with a body phrase, requester from the message and a copy: valid against its schema, a card in plain words", async () => {
    const cfg = { ...deskShared.CLAUDE_DESK_DEFAULTS, enabled: true, teams_off: [], caps: { read: true, search: true, web: false, changes: true, drafts: true } };
    deskConfig.setClaudeDeskConfigForTests(cfg);
    try {
      const input = {
        id: 0,
        name: `Desk web form ${STAMP}`,
        event: "ticket_created",
        conditions: {
          team_ids: [],
          categories: [],
          subcategories: [],
          priorities: [],
          request_type_ids: [],
          sources: [],
          keywords: [],
          subject_contains: [],
          subject_not_contains: [],
          body_contains: [WORD],
          body_not_contains: [],
          subject_pattern: { pattern: "", match_case: false },
          body_pattern: { pattern: "Asset tag:\\s*\\S+", match_case: false },
        },
        actions: {
          team_id: 0,
          assignee_id: 0,
          priority: "",
          status: "",
          category: "",
          subcategory: "",
          tags_add: [],
          internal_note: "",
          macro_id: 0,
          notify: "",
          requester_set: { user_id: 0, email: "", name: "", keep_cc: false },
          requester_from_message: { find: "label", labels: [], senders: [FORWARDER], domains: [], keep_cc: false, allow_agents: false },
          copy_values: [{ from: "body", label: "Asset tag:", pattern: "", match_case: false, field_key: F.asset, tag: false, only_if_empty: true }],
        },
      };
      const spec = deskPrompt.TOOL_SPECS.find((t) => t.name === "draft_automation")!;
      assert.equal(deskValidate.schemaError(spec.input_schema as never, input), null);
      const u = await user("admin");
      const ctx = { user: u, session: toSessionUser(u), origin: "http://localhost", ip: IP, cfg, chatId: 0, ticket: null, includeNotes: false, touched: new Set<number>(), notesSeen: [] as string[] };
      const out = (await deskTools.runDeskTool("draft_automation", input, ctx as never)) as { card?: { payload: { draft: { actions: Record<string, unknown> }; lines: string[] } } };
      assert.ok(out.card, JSON.stringify(out));
      assert.deepEqual(out.card.payload.draft.actions.requester_from_message, { find: "label", labels: ["From:", "Email:"], senders: [FORWARDER] });
      assert.match(out.card.payload.lines[2], /make the email address after "From:" or "Email:" in the message the requester, only for messages from/);
      // No senders: no card, the scope sentence.
      const bad = (await deskTools.runDeskTool(
        "draft_automation",
        { ...input, actions: { ...input.actions, requester_from_message: { ...input.actions.requester_from_message, senders: [] } } },
        ctx as never
      )) as { result?: unknown; card?: unknown };
      assert.equal(bad.card, undefined);
      assert.match(JSON.stringify(bad), /Only for messages from/);
    } finally {
      deskConfig.setClaudeDeskConfigForTests(null);
    }
  });
});
