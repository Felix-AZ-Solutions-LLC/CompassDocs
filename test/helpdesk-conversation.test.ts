// Helpdesk 1.20.28: the desk's ticket conversation (lib/helpdesk/
// conversation-shared, ticket/Conversation).
//
//   - field changes are activity lines: updateTicket marks each internal line
//     it writes with event 'change' (a person's, an automation's, Claude's);
//     the status line stays a system line; an automation's own note and a
//     person's note stay notes; the upgrade marks earlier change lines once,
//     by their exact shape, and nothing else;
//   - a change line splits into who and what (the rule's name without
//     "Automation: "), with an icon per kind of change, and reads as plain
//     text (mdInline's escapes undone, never parsed);
//   - newest first's fold: the newest requester message and the newest agent
//     reply shown with everything newer, older messages folded and counted
//     (lines not counted), nothing folded when nothing would hide;
//   - files: the type square, and the pictures a formatted email draws itself
//     marked `inline` on the desk's ticket read (only those its HTML names by
//     cid, within the picture budget), and left out of the list only while
//     the email shows formatted;
//   - the per-agent order preference (ticket_order), newest first by default.
//
// Parallel-safe: everything is this file's own (STAMP); the upgrade's flag is
// put back as it was.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-conversation.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pool, getSetting } from "../src/lib/db";
import { fixtureQuery } from "./support/retry";
import {
  activityIcon,
  automationRule,
  fileKind,
  foldLabel,
  foldPlan,
  isActivityLine,
  isChangeLine,
  listedFiles,
  plainChangeText,
  splitChangeLine,
} from "../src/lib/helpdesk/conversation-shared";
import { looksLikeChangeLine, migrateChangeLines } from "../src/lib/helpdesk/change-lines";
import { mdInline } from "../src/lib/helpdesk/md-inline";
import type { HdAttachment, HdMessage } from "../src/lib/helpdesk/types";

// --- next/headers and lib/ee outside Next (as test/helpdesk-core) ------------------------

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-conversation.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-conversation.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
{
  const virtual = (file: string, exports: Record<string, unknown>) => {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
  };
  virtual(HEADERS_STUB, {
    headers: async () => new Headers(),
    cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
    draftMode: async () => ({ isEnabled: false }),
  });
  virtual(EE_STUB, {
    ee: () => ({ present: true, features: ["helpdesk"] }),
    eePresent: () => true,
    featureEnabled: async (f: string) => f === "helpdesk",
    featureEnforced: async (f: string) => f === "helpdesk",
  });
  const loader = Module as unknown as { _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string };
  const resolve = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) return EE_STUB;
    return resolve.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const tickets = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const messages = require("../src/lib/helpdesk/messages") as typeof import("../src/lib/helpdesk/messages");
const emailHtml = require("../src/lib/helpdesk/email-html") as typeof import("../src/lib/helpdesk/email-html");
const detail = require("../src/lib/helpdesk/detail") as typeof import("../src/lib/helpdesk/detail");
const prefs = require("../src/lib/helpdesk/notify-prefs") as typeof import("../src/lib/helpdesk/notify-prefs");
const prefsShared = require("../src/lib/helpdesk/notify-prefs-shared") as typeof import("../src/lib/helpdesk/notify-prefs-shared");
const htmlShared = require("../src/lib/helpdesk/email-html-shared") as typeof import("../src/lib/helpdesk/email-html-shared");
/* eslint-enable @typescript-eslint/no-require-imports */

const STAMP = `hdconv-${Date.now()}-${randomBytes(3).toString("hex")}`;
const U: Record<"requester" | "agent", { id: number; name: string }> = { requester: { id: 0, name: "" }, agent: { id: 0, name: "" } };
let teamId = 0;
let otherTeam = 0;

before(async () => {
  await getSetting("__schema_bootstrap__");
  for (const k of ["requester", "agent"] as const) {
    const name = k === "agent" ? `Sam *Lee* ${STAMP}` : `Linda Berger ${STAMP}`;
    const r = await fixtureQuery(
      "INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id",
      [`${STAMP}-${k}`, name, `${STAMP}-${k}@example.test`]
    );
    U[k] = { id: r.rows[0].id, name };
  }
  teamId = (await fixtureQuery("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`${STAMP} IT`])).rows[0].id;
  otherTeam = (await fixtureQuery("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`${STAMP} Facilities: rooms`])).rows[0].id;
});

after(async () => {
  await pool().query("DELETE FROM hd_tickets WHERE team_id = ANY($1) OR requester_id = $2", [[teamId, otherTeam], U.requester.id]);
  await pool().query("DELETE FROM hd_teams WHERE id = ANY($1)", [[teamId, otherTeam]]);
  await pool().query("DELETE FROM hd_notify_prefs WHERE user_id = ANY($1)", [[U.requester.id, U.agent.id]]);
  await pool().query("DELETE FROM users WHERE id = ANY($1)", [[U.requester.id, U.agent.id]]);
  await pool().end();
});

async function newTicket(subject: string) {
  return tickets.createTicket(
    { subject: `${subject} ${STAMP}`, body: "The projector in 4B won't turn on.", team_id: teamId, requester: { id: U.requester.id, name: U.requester.name, email: `${STAMP}-requester@example.test` } },
    { silent: true }
  );
}

// --- Pure: lines, fold, files ------------------------------------------------------------

let nextId = 1;
function msg(over: Partial<HdMessage> & Pick<HdMessage, "kind">): HdMessage {
  return {
    id: nextId++,
    ticket_id: 1,
    author_id: null,
    author_name: "",
    author_email: "",
    body: "x",
    via: "desk",
    attachments: [],
    email_message_id: null,
    created_at: new Date(Date.UTC(2026, 10, 18, 9, nextId)).toISOString(),
    ...over,
  };
}
const REQ = 10;
const AGENT = 20;
const fromRequester = (body = "hi") => msg({ kind: "public", author_id: REQ, body, via: "email" });
const fromAgent = (body = "reply") => msg({ kind: "public", author_id: AGENT, body });
const note = () => msg({ kind: "internal", author_id: AGENT, body: "a note" });
const change = (who = "Sam Lee", what = "changed the priority from Normal to Low") => msg({ kind: "internal", author_name: who, via: "system", body: `${mdInline(who)} ${what}`, event: "change" });
const status = () => msg({ kind: "system", author_name: "Sam Lee", via: "system", body: "Sam Lee changed the status from New to Open" });

describe("activity lines (pure)", () => {
  test("a change line is a line; a note, an automation's note and a share line are not change lines", () => {
    assert.equal(isChangeLine(change()), true);
    assert.equal(isActivityLine(change()), true);
    assert.equal(isActivityLine(status()), true);
    assert.equal(isActivityLine(msg({ kind: "internal", body: "Ana shared this with Sam", event: "share" })), true);
    assert.equal(isActivityLine(note()), false);
    const automationNote = msg({ kind: "internal", author_name: "Automation: VIP triage", via: "system", body: "Call them within the hour." });
    assert.equal(isActivityLine(automationNote), false, "an automation's own note stays a note card");
    assert.equal(automationRule(automationNote.author_name), "VIP triage");
    assert.equal(automationRule("Sam Lee"), null);
  });

  test("a change line splits into who and what; an automation's names its rule; the text is plain", () => {
    const rule = "IT Support email: low priority, assign Charles";
    const a = splitChangeLine(change(`Automation: ${rule}`, `assigned the ticket to ${mdInline("Charles Diaz")}`));
    assert.deepEqual(a, { actor: rule, automation: true, rest: "assigned the ticket to Charles Diaz" });
    const p = splitChangeLine(change("Sam *Lee*", `set the category to ${mdInline("Hardware › Laptops")}`));
    assert.deepEqual(p && { actor: p.actor, automation: p.automation }, { actor: "Sam *Lee*", automation: false });
    assert.equal(plainChangeText(p!.rest), "set the category to Hardware › Laptops");
    // Escapes undone, word joiners gone, nothing parsed.
    const weird = `[click](https://evil.example) *bold* _x_ \`code\` <b>html</b> a|b {c} 1. #h C:\\dir www.x.com ana@x.com`;
    assert.equal(plainChangeText(`renamed the ticket from "${mdInline(weird)}"`), `renamed the ticket from "${weird}"`);
    // A body that doesn't start with its author (an old "Someone" line) is shown whole.
    assert.equal(splitChangeLine(change("", "x")), null);
  });

  test("each kind of change has its icon; an automation's is the bot", () => {
    const icon = (what: string, who = "Sam Lee") => activityIcon(change(who, what));
    assert.equal(icon("changed the priority from Normal to Low", "Automation: Triage"), "bot");
    assert.equal(icon('renamed the ticket from "Old"'), "rename");
    assert.equal(icon("moved the ticket to Facilities"), "team");
    assert.equal(icon("took the ticket out of its team"), "team");
    assert.equal(icon("assigned the ticket to Kim"), "assign");
    assert.equal(icon("took the ticket"), "assign");
    assert.equal(icon("unassigned the ticket"), "unassign");
    assert.equal(icon("set the category to Hardware"), "category");
    assert.equal(icon("cleared the sub-category"), "category");
    assert.equal(icon("changed the priority from Normal to High via API"), "priority");
    assert.equal(icon("set Asset tag to LT-1"), "field");
    assert.equal(icon("marked the event setup complete"), "event");
    assert.equal(icon("filled in the solve details: Cause"), "solve");
    assert.equal(activityIcon(msg({ kind: "system", body: "Kelli added Theresa as CC." })), "cc-add");
    assert.equal(activityIcon(msg({ kind: "system", body: "Kelli removed Theresa from CC." })), "cc-remove");
    assert.equal(activityIcon(status()), "status");
    assert.equal(activityIcon(msg({ kind: "system", body: "2 attachments were not added from the email:\n\n- a.exe" })), "files");
  });
});

describe("newest first's fold (pure)", () => {
  test("the newest requester message and agent reply show, with everything newer; older messages fold and are counted", () => {
    const list = [fromRequester("first"), fromAgent("a1"), note(), fromRequester("second"), change(), fromAgent("a2"), status(), note(), fromRequester("third"), change(), fromAgent("a3"), status()];
    // Newest requester: "third" (8); newest agent reply: "a3" (10). The older of the two is "third".
    const plan = foldPlan(list, REQ);
    assert.equal(plan.from, 8);
    assert.equal(plan.folded, 6, "first, a1, note, second, a2, note: lines are not counted");
    assert.equal(foldLabel(plan.folded), "Show 6 earlier messages");
    assert.equal(foldLabel(1), "Show 1 earlier message");
  });

  test("the agent replied before the requester's latest: from the agent's reply", () => {
    const list = [fromRequester(), fromAgent(), fromRequester(), fromAgent("latest reply"), note(), fromRequester("latest")];
    assert.deepEqual(foldPlan(list, REQ), { from: 3, folded: 3 });
  });

  test("nothing folds when nothing would hide: a new ticket, only lines before, no public message", () => {
    assert.deepEqual(foldPlan([fromRequester()], REQ), { from: 0, folded: 0 });
    assert.deepEqual(foldPlan([fromRequester(), fromAgent()], REQ), { from: 0, folded: 0 });
    assert.deepEqual(foldPlan([status(), change(), fromRequester(), fromAgent()], REQ), { from: 0, folded: 0 });
    assert.deepEqual(foldPlan([note(), note()], REQ), { from: 0, folded: 0 });
    // No agent reply yet: older requester messages fold behind the newest one.
    assert.deepEqual(foldPlan([fromRequester(), fromRequester(), fromRequester()], REQ), { from: 2, folded: 2 });
    // An emailed message from an address with no account (author null) is the requester's side.
    assert.deepEqual(foldPlan([fromAgent(), msg({ kind: "public", author_id: null, via: "email" }), fromAgent(), msg({ kind: "public", author_id: null, via: "email" })], null), { from: 2, folded: 2 });
  });
});

describe("files (pure)", () => {
  const a = (name: string, type: string, extra: Partial<HdAttachment> = {}): HdAttachment => ({ id: nextId++, name, size: 1000, type, ...extra });
  test("the type square from the name, then the stored type", () => {
    assert.deepEqual(fileKind(a("Meeting agreement signed.pdf", "application/pdf")), { label: "PDF", tone: "red" });
    assert.deepEqual(fileKind(a("Attendees.XLSX", "application/octet-stream")), { label: "XLS", tone: "green" });
    assert.deepEqual(fileKind(a("notes.docx", "")), { label: "DOC", tone: "blue" });
    assert.deepEqual(fileKind(a("FW Room booking.eml", "message/rfc822")), { label: "EML", tone: "violet" });
    assert.deepEqual(fileKind(a("Outlook item.msg", "")), { label: "EML", tone: "violet" });
    assert.deepEqual(fileKind(a("Room 4B.jpg", "image/jpeg")), { label: "IMG", tone: "sky" });
    assert.deepEqual(fileKind(a("scan", "image/png")), { label: "IMG", tone: "sky" });
    assert.deepEqual(fileKind(a("deck.pptx", "")), { label: "PPT", tone: "orange" });
    assert.deepEqual(fileKind(a("data.bin", "application/octet-stream")), { label: "FILE", tone: "slate" });
  });
  test("inline pictures are left out only while the email shows formatted", () => {
    const files = [a("logo.png", "image/png", { inline: true }), a("report.pdf", "application/pdf"), a("photo.jpg", "image/jpeg")];
    assert.deepEqual(listedFiles(files, true).map((f) => f.name), ["report.pdf", "photo.jpg"]);
    assert.deepEqual(listedFiles(files, false).map((f) => f.name), ["logo.png", "report.pdf", "photo.jpg"]);
  });
});

// --- Database: change lines ----------------------------------------------------------------

describe("change lines are marked", () => {
  test("updateTicket marks its internal lines 'change'; the status line stays a system line; notes are notes", async () => {
    const t = await newTicket("Projector");
    await tickets.updateTicket(t.id, { priority: "high", subject: `Projector in 4B ${STAMP}` }, { id: U.agent.id, name: U.agent.name });
    await tickets.updateTicket(t.id, { team_id: otherTeam, status: "open" }, { id: null, name: "Automation: Rooms go to Facilities" }, { fromAutomation: true });
    await tickets.updateTicket(t.id, { priority: "low" }, { id: U.agent.id, name: U.agent.name, via: "api" });
    await messages.addMessage(t.id, { kind: "internal", body: "Call them within the hour.", author: { id: null, name: "Automation: VIP triage", email: "" }, via: "system", asRequester: false }, { silent: true });
    await messages.addMessage(t.id, { kind: "internal", body: `${U.agent.name} changed the priority from Low to High`, author: { id: U.agent.id, name: U.agent.name, email: "" }, via: "desk" }, { silent: true });
    const list = await messages.listMessages(t.id);
    const lines = list.filter(isChangeLine);
    assert.deepEqual(
      lines.map((m) => plainChangeText(splitChangeLine(m)?.rest ?? m.body)),
      [`renamed the ticket from "Projector ${STAMP}"`, "changed the priority from Normal to High", `moved the ticket to ${STAMP} Facilities: rooms`, "changed the priority from High to Low via API"]
    );
    assert.deepEqual([...new Set(lines.map((m) => splitChangeLine(m)?.actor))], [U.agent.name, "Rooms go to Facilities"]);
    assert.equal(splitChangeLine(lines[2])?.automation, true);
    const statusLine = list.find((m) => m.kind === "system" && /changed the status/.test(m.body));
    assert.ok(statusLine && !isChangeLine(statusLine) && isActivityLine(statusLine));
    const notes = list.filter((m) => m.kind === "internal" && !isActivityLine(m)).map((m) => m.body);
    assert.deepEqual(notes, ["Call them within the hour.", `${U.agent.name} changed the priority from Low to High`], "a note that reads like a change is still a note");
  });

  test("the upgrade marks earlier change lines once, by their exact shape, and nothing else", async () => {
    const t = await newTicket("Old lines");
    const insert = async (author: string, body: string, kind = "internal", via = "system") =>
      (await pool().query("INSERT INTO hd_messages (ticket_id, author_id, author_name, kind, body, via) VALUES ($1, NULL, $2, $3, $4, $5) RETURNING id", [t.id, author, kind, body, via])).rows[0].id as number;
    const yes = [
      await insert("Sam *Lee*", `${mdInline("Sam *Lee*")} changed the priority from Normal to High`),
      await insert("Automation: Rule: one", `${mdInline("Automation: Rule: one")} assigned the ticket to ${mdInline("Kim Ode")}`),
      await insert("", "Someone took the ticket via API"),
      await insert("Ana", `Ana set ${mdInline("Asset tag")} to ${mdInline("LT-0042")}`),
      await insert("Ana", `Ana renamed the ticket from "${mdInline("Old: subject")}"`),
    ];
    const no = [
      await insert("Automation: Rule: one", "Call the requester within the hour."),
      await insert("Automation: Rule: one", "Automation: Rule: one changed the priority from Normal to High"), // not escaped: not updateTicket's
      await insert("Ana", "Ana changed the priority from Normal to High", "internal", "desk"),
      await insert("Ana", "Ana changed the priority from Normal to High\n\nand a second paragraph"),
      await insert("Ana", "Ana changed her mind about the printer"),
      await insert("Ana", "Ana changed the status from New to Open", "system"),
    ];
    assert.equal(looksLikeChangeLine("Sam *Lee*", `${mdInline("Sam *Lee*")} unassigned the ticket`), true);
    assert.equal(looksLikeChangeLine("Sam", "Sam cleared Asset tag via Claude"), true);
    assert.equal(looksLikeChangeLine("Sam", "Sam: please check"), false);
    const flag = await pool().query("SELECT value FROM settings WHERE key = 'migration_hd_change_lines'");
    await pool().query("DELETE FROM settings WHERE key = 'migration_hd_change_lines'");
    const client = await pool().connect();
    try {
      assert.ok((await migrateChangeLines(client)) >= yes.length);
      assert.equal(await migrateChangeLines(client), 0, "once");
    } finally {
      client.release();
      if (!flag.rowCount) await pool().query("DELETE FROM settings WHERE key = 'migration_hd_change_lines'");
    }
    const ev = new Map((await pool().query("SELECT id, event FROM hd_messages WHERE id = ANY($1)", [[...yes, ...no]])).rows.map((r) => [r.id as number, r.event as string | null]));
    for (const id of yes) assert.equal(ev.get(id), "change", `marked ${id}`);
    for (const id of no) assert.equal(ev.get(id), null, `left ${id}`);
  });
});

// --- Database: inline pictures ------------------------------------------------------------

describe("inline pictures on the desk's ticket read", () => {
  test("only the pictures the HTML names by cid, mapped to the message's own files, within the budget", async () => {
    const t = await newTicket("Signature pictures");
    const opening = (await messages.listMessages(t.id))[0];
    const att = (id: number, name: string, type: string, size = 20_000): HdAttachment => ({ id, name, type, size });
    const base = 880_000_000 + Math.floor(Math.random() * 1_000_000);
    const files = [
      att(base + 1, "image001.png", "image/png"), // the signature logo, named in the newest part
      att(base + 2, "image002.jpg", "image/jpeg"), // the CISSP badge, in the quoted part only
      att(base + 3, "photo.png", "image/png"), // has a Content-ID the HTML never names (Apple Mail does this)
      att(base + 4, "agreement.pdf", "application/pdf"), // a document, named by cid all the same
      att(base + 5, "huge.png", "image/png", htmlShared.EMAIL_HTML_LIMITS.inlineBytes + 1), // past the inline budget
    ];
    await pool().query("UPDATE hd_messages SET attachments = $2::jsonb WHERE id = $1", [opening.id, JSON.stringify(files)]);
    const html =
      '<p>See below.</p><img src="CID:image001.png@01DB4F2A"><div id="divRplyFwdMsg">From: Ana</div>' +
      '<blockquote><img src="cid:image002.jpg@01DB4F2A"><a href="cid:agreement">x</a><img src="cid:huge@x"></blockquote>';
    const cids = {
      "image001.png@01db4f2a": { attachment_id: base + 1 },
      "image002.jpg@01db4f2a": { attachment_id: base + 2 },
      "photo@apple": { attachment_id: base + 3 },
      agreement: { attachment_id: base + 4 },
      "huge@x": { attachment_id: base + 5 },
      "tiny@logo": { mime: "image/png", data: "iVBORw0KGgo=" },
      "other@msg": { attachment_id: 1 },
    };
    await pool().query("INSERT INTO hd_message_html (message_id, html, size, cids) VALUES ($1, $2, $3, $4)", [opening.id, html, html.length, JSON.stringify(cids)]);
    const second = await messages.addMessage(t.id, { kind: "public", body: "No original here.", author: { id: U.requester.id, name: U.requester.name, email: "" }, via: "email", asRequester: true, attachments: [att(base + 6, "image001.png", "image/png")] }, { silent: true });
    assert.ok(second);

    const marked = await emailHtml.markInlineAttachments(await messages.listMessages(t.id));
    const first = marked.find((m) => m.id === opening.id)!;
    assert.deepEqual(
      first.attachments.map((a) => [a.name, a.inline === true]),
      [
        ["image001.png", true],
        ["image002.jpg", true],
        ["photo.png", false],
        ["agreement.pdf", false],
        ["huge.png", false],
      ]
    );
    assert.equal(marked.find((m) => m.id === second.message.id)!.attachments[0].inline, undefined, "no original: listed as it is");
    // The desk's read carries it; the formatted email lists only the rest.
    const d = await detail.ticketDetail({ id: U.agent.id, role: "viewer" }, (await tickets.getTicketById(t.id))!, true);
    const shown = d.messages.find((m) => m.id === opening.id)!;
    assert.deepEqual(listedFiles(shown.attachments, true).map((a) => a.name), ["photo.png", "agreement.pdf", "huge.png"]);
    assert.equal(listedFiles(shown.attachments, false).length, 5);
    // A requester's read never carries the flag.
    const { requesterMessages } = await import("../src/lib/helpdesk/access");
    assert.ok(requesterMessages(await messages.listMessages(t.id)).every((m) => m.attachments.every((a) => a.inline === undefined)));
  });
});

// --- The order preference ------------------------------------------------------------------

describe("ticket order preference", () => {
  test("newest first by default, saved per agent, and checked", async () => {
    assert.equal(prefsShared.defaultPrefs().ticket_order, "newest");
    assert.equal(prefsShared.resolvePrefs({ ticket_order: "sideways" }).ticket_order, "newest");
    assert.equal((await prefs.getNotifyPrefs(U.agent.id)).ticket_order, "newest");
    await prefs.saveNotifyPrefs(U.agent.id, { ticket_order: "oldest" });
    assert.equal((await prefs.getNotifyPrefs(U.agent.id)).ticket_order, "oldest");
    assert.equal((await prefs.getNotifyPrefs(U.requester.id)).ticket_order, "newest", "per agent");
    await assert.rejects(prefs.saveNotifyPrefs(U.agent.id, { ticket_order: "random" }), /newest first or oldest first/);
    // Other preferences are kept.
    await prefs.saveNotifyPrefs(U.agent.id, { email_view: "plain" });
    const p = await prefs.getNotifyPrefs(U.agent.id);
    assert.deepEqual([p.ticket_order, p.email_view], ["oldest", "plain"]);
  });
});
