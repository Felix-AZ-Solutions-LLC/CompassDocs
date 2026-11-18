// Helpdesk 1.20.33: what an automation reads in a ticket's subject and body,
// the pure half (lib/helpdesk/automation-body-shared) and the rule checks that
// need no database (lib/helpdesk/automations validateConditions /
// validateActions / automationMatches / effectivePatch):
//   - phrases: contains / doesn't contain, exact text in any case, not whole
//     words; the keyword condition unchanged;
//   - patterns on the linear-time engine: a catastrophic-backtracking pattern
//     on a long string finishes at once; any case unless match case; an
//     invalid pattern, a lookaround or an over-long one refused in a sentence;
//   - "Copy a value": the text after a label, a pattern's capture group, the
//     value fitted to the field's kind (options any case, numbers, dates, yes
//     or no, capped text), tags;
//   - "From the message": the addresses tried, in order, with the name on the
//     line; the sender scope; the required senders list refused when empty;
//   - effectivePatch: a requester or field value the ticket already has
//     changes nothing (the rule settles).
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-automation-body.test.ts (no DATABASE_URL needed)

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  AUTOMATION_BODY_LIMITS,
  addressAtDomain,
  FREE_MAIL_DOMAINS,
  freeMailDomain,
  lineAddress,
  lineLabel,
  requesterCandidate,
  capBody,
  capturedValue,
  cleanDomainList,
  cleanSenderList,
  compilePattern,
  extractCopyValue,
  fitFieldValue,
  parsePlainDate,
  parsePlainNumber,
  patternHit,
  phraseHit,
  senderInScope,
  textAfterLabel,
  tryPattern,
  valueAsTag,
} from "../src/lib/helpdesk/automation-body-shared";
import { AUTOMATION_LIMITS, REQUESTER_SCOPE_REQUIRED, automationMatches, copyWords, effectivePatch, requesterFromMessageWords, validateActions, validateConditions } from "../src/lib/helpdesk/automations";
import { activityIcon } from "../src/lib/helpdesk/conversation-shared";
import { normalizeEmail, parseAddress, parseAddressList } from "../src/lib/helpdesk/inbound-parse";
import { bracketedAddress } from "../src/lib/helpdesk/mailboxes-shared";
import { authVerdict } from "../src/lib/helpdesk/intake/email-rules";
import type { MatchTarget } from "../src/lib/helpdesk/automations";

const target = (over: Partial<MatchTarget> = {}): MatchTarget => ({
  team_id: 3,
  category: "Network",
  priority: "normal",
  request_type_id: null,
  source: "email",
  subject: "[Web form] Laptop won't start",
  body: "Submitted via the web form\\.  \nFrom\\: Jane Doe <jane@acme.example>",
  text: "Submitted via the web form.\nFrom: Jane Doe <jane@acme.example>\nAsset tag: LT-0042\nImpact: high",
  ...over,
});

describe("phrases: exact text, any case, not whole words", () => {
  test("contains matches any phrase, in any case, inside words too", () => {
    assert.equal(phraseHit(["web form"], "Submitted via the WEB FORM."), true);
    assert.equal(phraseHit(["vpn"], "my vpnclient keeps dropping"), true, "part of a word counts");
    assert.equal(phraseHit(["printer", "toner"], "the Toner is low"), true);
    assert.equal(phraseHit(["printer"], "the toner is low"), false);
    assert.equal(phraseHit(["  ", ""], "anything"), false, "an empty phrase never matches");
  });

  test("the four conditions on a ticket: contains any, doesn't contain none", () => {
    const t = target();
    assert.equal(automationMatches({ subject_contains: ["[web form]"] }, t), true);
    assert.equal(automationMatches({ subject_contains: ["[portal]"] }, t), false);
    assert.equal(automationMatches({ subject_not_contains: ["out of office"] }, t), true);
    assert.equal(automationMatches({ subject_not_contains: ["out of office", "LAPTOP"] }, t), false, "one phrase present is enough to fail");
    assert.equal(automationMatches({ body_contains: ["asset tag:"] }, t), true);
    assert.equal(automationMatches({ body_not_contains: ["this is a test"] }, t), true);
    assert.equal(automationMatches({ body_not_contains: ["submitted via"] }, t), false);
    // The body as agents read it: no Markdown escapes in the way ("From\:" is stored, "From:" is read).
    assert.equal(automationMatches({ body_contains: ["From: Jane"] }, t), true);
    // Without `text` (a target built elsewhere) the stored body is read.
    assert.equal(automationMatches({ body_contains: ["From\\: Jane"] }, target({ text: undefined })), true);
    // All listed conditions must hold.
    assert.equal(automationMatches({ subject_contains: ["web form"], body_contains: ["nothing like this"] }, t), false);
  });

  test("the keyword condition stays whole words", () => {
    assert.equal(automationMatches({ keywords: ["laptop"] }, target()), true);
    assert.equal(automationMatches({ keywords: ["lap"] }, target()), false);
  });
});

describe("patterns: a linear-time engine", () => {
  test("a catastrophic-backtracking pattern on a long string finishes at once", () => {
    const evil = `${"a".repeat(100_000)}!`;
    const started = Date.now();
    assert.equal(patternHit({ pattern: "(a+)+$" }, evil), false);
    assert.equal(patternHit({ pattern: "(a|aa)+$" }, evil), false);
    assert.equal(patternHit({ pattern: "^(\\w+\\s?)*$" }, `${"word ".repeat(10_000)}!`), false);
    const took = Date.now() - started;
    assert.ok(took < 2_000, `three exponential-time patterns took ${took} ms`);
    // The same on a whole rule.
    const t0 = Date.now();
    assert.equal(automationMatches({ body_pattern: { pattern: "(a+)+$" } }, target({ text: evil })), false);
    assert.ok(Date.now() - t0 < 1_000);
  });

  test("any case unless match case; subject and body", () => {
    assert.equal(automationMatches({ subject_pattern: { pattern: "^\\[web form\\]" } }, target()), true);
    assert.equal(automationMatches({ subject_pattern: { pattern: "^\\[web form\\]", match_case: true } }, target()), false);
    assert.equal(automationMatches({ subject_pattern: { pattern: "^\\[Web form\\]", match_case: true } }, target()), true);
    assert.equal(automationMatches({ body_pattern: { pattern: "asset tag:\\s*LT-\\d{4}" } }, target()), true);
    assert.equal(automationMatches({ body_pattern: { pattern: "serial:\\s*\\d+" } }, target()), false);
  });

  test("only the first 100 KB of the body is matched", () => {
    const late = `${"x".repeat(AUTOMATION_BODY_LIMITS.bodyBytes + 10)}NEEDLE`;
    assert.equal(patternHit({ pattern: "NEEDLE" }, late), false);
    assert.equal(patternHit({ pattern: "NEEDLE" }, `NEEDLE${late}`), true);
    // Bytes, not characters: three-byte characters count three.
    const wide = "€".repeat(AUTOMATION_BODY_LIMITS.bodyBytes);
    assert.ok(new TextEncoder().encode(capBody(wide)).length <= AUTOMATION_BODY_LIMITS.bodyBytes);
    assert.equal(capBody("short"), "short");
  });

  test("an invalid pattern is refused at save time with a plain sentence", () => {
    const bad = validateConditions({ body_pattern: { pattern: "(unclosed" } });
    assert.equal(bad.ok, false);
    assert.match((bad as { error: string }).error, /^Body matches pattern: The pattern "\(unclosed" can't be used: missing closing \)\. Try it in the box below the pattern\.$/);
    const look = validateConditions({ subject_pattern: { pattern: "(?<=Ticket )\\d+" } });
    assert.equal(look.ok, false);
    assert.match((look as { error: string }).error, /lookarounds and backreferences aren't supported/);
    const back = validateConditions({ subject_pattern: "(a)\\1" });
    assert.match((back as { error: string }).error, /lookarounds and backreferences aren't supported/);
    const long = validateConditions({ body_pattern: { pattern: "a".repeat(AUTOMATION_LIMITS.pattern + 1) } });
    assert.match((long as { error: string }).error, /Keep a pattern under 200 characters\./);
    const mc = validateConditions({ body_pattern: { pattern: "x", match_case: "yes" } });
    assert.match((mc as { error: string }).error, /match_case is true or false/);
    // A valid one is stored as given; an empty one is no condition.
    const ok = validateConditions({ body_pattern: { pattern: "LT-\\d+", match_case: true }, subject_pattern: { pattern: "" } });
    assert.deepEqual(ok, { ok: true, value: { body_pattern: { pattern: "LT-\\d+", match_case: true } } });
  });

  test("phrase lists are checked like keywords, with their own sentences", () => {
    assert.deepEqual(validateConditions({ subject_contains: [" Web form ", "web FORM", ""] }), { ok: true, value: { subject_contains: ["Web form"] } });
    assert.match((validateConditions({ body_contains: ["x".repeat(201)] }) as { error: string }).error, /^Body contains phrases: keep each phrase under 200 characters\.$/);
    assert.match((validateConditions({ body_not_contains: [3] }) as { error: string }).error, /each phrase is text/);
    assert.match((validateConditions({ subject_typo: ["x"] }) as { error: string }).error, /Unknown condition: subject_typo/);
  });

  test("Try it: the same compile and match, with each group's text", () => {
    assert.deepEqual(tryPattern("Asset tag:\\s*(\\S+)", false, "hello\nASSET TAG:  LT-0042 (blue)"), { matched: true, match: "ASSET TAG:  LT-0042", groups: ["LT-0042"] });
    assert.deepEqual(tryPattern("(a)|(b)", false, "b"), { matched: true, match: "b", groups: [null, "b"] });
    assert.deepEqual(tryPattern("zzz", false, "abc"), { matched: false, match: "", groups: [] });
    assert.match((tryPattern("(", false, "x") as { error: string }).error, /can't be used/);
    assert.equal(compilePattern("x(", false).ok, false);
  });
});

describe("copy a value: find it, then fit it to the field", () => {
  const text = target().text!;
  test("text after a label: the rest of that line, trimmed; any case unless match case", () => {
    assert.equal(textAfterLabel(text, "Asset tag:"), "LT-0042");
    assert.equal(textAfterLabel(text, "asset TAG:"), "LT-0042");
    assert.equal(textAfterLabel(text, "asset TAG:", true), null);
    assert.equal(textAfterLabel("Asset tag:\nAsset tag: AB-1", "Asset tag:"), "AB-1", "an empty first occurrence is passed over");
    assert.equal(textAfterLabel(text, "Serial:"), null);
  });

  test("a pattern's one capture group", () => {
    assert.equal(capturedValue("Asset tag:\\s*(LT-\\d+)", false, text), "LT-0042");
    assert.equal(capturedValue("Serial:\\s*(\\S+)", false, text), null);
    assert.equal(extractCopyValue({ from: "subject", pattern: "\\[(web form)\\]" }, "[Web form] x", ""), "Web form");
    assert.equal(extractCopyValue({ from: "body", label: "Impact:" }, "", text), "high");
  });

  test("fit to the field's kind: options any case, numbers and dates parse, text capped; a misfit says why", () => {
    const options = [
      { value: "high", label: "High" },
      { value: "low", label: "Low" },
    ];
    assert.deepEqual(fitFieldValue({ label: "Impact", type: "select", options }, "HIGH"), { ok: true, value: "high" });
    assert.deepEqual(fitFieldValue({ label: "Impact", type: "select", options }, "Low"), { ok: true, value: "low" });
    assert.deepEqual(fitFieldValue({ label: "Impact", type: "select", options }, "Medium"), { ok: false, why: '"Medium" is not one of its options' });
    assert.deepEqual(fitFieldValue({ label: "Count", type: "number" }, "1,234.50"), { ok: true, value: 1234.5 });
    assert.deepEqual(fitFieldValue({ label: "Count", type: "number" }, "12 units"), { ok: false, why: '"12 units" is not a number' });
    assert.deepEqual(fitFieldValue({ label: "Due", type: "date" }, "2026-11-20"), { ok: true, value: "2026-11-20" });
    assert.deepEqual(fitFieldValue({ label: "Due", type: "date" }, "20 Nov 2026"), { ok: true, value: "2026-11-20" });
    assert.deepEqual(fitFieldValue({ label: "Due", type: "date" }, "November 20, 2026"), { ok: true, value: "2026-11-20" });
    assert.equal(fitFieldValue({ label: "Due", type: "date" }, "11/12/2026").ok, false, "day-first or month-first is ambiguous");
    assert.equal(fitFieldValue({ label: "Due", type: "date" }, "2026-02-30").ok, false);
    assert.deepEqual(fitFieldValue({ label: "At", type: "datetime" }, "2026-11-20 9:05"), { ok: true, value: "2026-11-20T09:05" });
    assert.deepEqual(fitFieldValue({ label: "VIP", type: "checkbox" }, "Yes"), { ok: true, value: true });
    assert.equal(fitFieldValue({ label: "VIP", type: "checkbox" }, "maybe").ok, false);
    const long = fitFieldValue({ label: "Note", type: "text" }, "x".repeat(900));
    assert.equal(long.ok && String(long.value).length, 500, "short text is capped to the field's limit");
    assert.deepEqual(fitFieldValue({ label: "Owner", type: "user" }, "Jane <JANE@acme.example>"), { ok: true, value: "jane@acme.example" });
    assert.equal(fitFieldValue({ label: "Owner", type: "user" }, "Jane").ok, false);
    assert.deepEqual(fitFieldValue({ label: "Asset", type: "text" }, "   "), { ok: false, why: "it was empty" });
    assert.equal(parsePlainNumber("1,23"), null);
    assert.equal(parsePlainDate("31 Foo 2026"), null);
    assert.equal(valueAsTag("LT 0042"), "lt-0042");
    assert.equal(valueAsTag("<b>"), null);
  });
});

describe("change the requester from the message: which address, and from whom", () => {
  const body = ["Forwarded by the web form", "Reply-To: noreply@forms.acme.example", "From: Jane Doe <Jane@Acme.example>", "Email: jane.alt@acme.example", "Cc: ops@acme.example"].join("\n");
  test("after a label: the topmost line that starts with a label decides, and nothing later is read (review L1)", () => {
    assert.deepEqual(requesterCandidate(body, "label"), { address: { email: "jane@acme.example", name: "Jane Doe" }, label: "From:" });
    // The topmost labelled line, whatever the labels' order.
    assert.deepEqual(requesterCandidate(body, "label", ["Email:", "From:"]).address?.email, "jane@acme.example");
    // A label line without an address stops the search: the next line (or a later quoted "From:") is never read.
    assert.deepEqual(requesterCandidate("From:\njane@acme.example\n> From: ceo@acme.example", "label"), { address: null, label: "From:" });
    assert.deepEqual(requesterCandidate("Hello\nNothing here", "label"), { address: null, label: null });
  });

  test("a label starts its line, after whitespace and quote markers (review L6)", () => {
    assert.equal(requesterCandidate("Reply-From: ceo@acme.example\nFrom: jane@acme.example", "label").address?.email, "jane@acme.example");
    assert.equal(requesterCandidate("Sent From: ceo@acme.example\nFrom: jane@acme.example", "label").address?.email, "jane@acme.example");
    assert.equal(requesterCandidate("  > > From: jane@acme.example", "label").address?.email, "jane@acme.example");
    assert.equal(requesterCandidate("Please reply From: ceo@acme.example", "label").address, null);
    assert.deepEqual(lineLabel("   >From: x", ["From:"]), { label: "From:", rest: " x" });
    assert.equal(textAfterLabel("Old asset tag: A-1\nAsset tag: B-2", "Asset tag:"), "B-2", "copy labels start their line too");
  });

  test("the first address in the body: only the first one found", () => {
    assert.deepEqual(requesterCandidate(body, "first").address, { email: "noreply@forms.acme.example", name: "" });
  });

  test("the display name never picks the address: only the bracketed one counts (review H1)", () => {
    const pick = (line: string, find: "label" | "first" = "label") => requesterCandidate(line, find).address;
    // Quoted and unquoted display names holding an address.
    assert.deepEqual(pick('From: "ceo@company.com" <attacker@evil.example>'), { email: "attacker@evil.example", name: "" });
    assert.deepEqual(pick("From: ceo@company.com <attacker@evil.example>"), { email: "attacker@evil.example", name: "" });
    assert.deepEqual(pick('"ceo@company.com" <attacker@evil.example>', "first"), { email: "attacker@evil.example", name: "" });
    assert.deepEqual(pick("ceo@company.com <attacker@evil.example>", "first"), { email: "attacker@evil.example", name: "" });
    // Several brackets: a quoted display name's own "<…>" is not an address; the last unquoted one is.
    assert.deepEqual(pick('From: "Jane <ceo@company.com>" <jane@customer.example>'), { email: "jane@customer.example", name: "" });
    assert.deepEqual(pick("From: Jane <ceo@company.com> <jane@customer.example>"), { email: "jane@customer.example", name: "" });
    // An encoded word ("ceo@company.com" in base64) is no name and no address.
    assert.deepEqual(pick("From: =?UTF-8?B?Y2VvQGNvbXBhbnkuY29t?= <jane@customer.example>"), { email: "jane@customer.example", name: "" });
    assert.deepEqual(pick("From: =?utf-8?q?ceo=40company.com?= <jane@customer.example>"), { email: "jane@customer.example", name: "" });
    // A plain name is kept as the name.
    assert.deepEqual(pick('From: "Doe, Jane" <jane@customer.example>'), { email: "jane@customer.example", name: "Doe, Jane" });
    assert.equal(lineAddress("Write to <mailto:Jane@Customer.example>")?.email, "jane@customer.example");
  });

  test("parseAddress and the headers read the same way: the bracketed address (review M2)", () => {
    assert.deepEqual(parseAddress('"ceo@company.com" <attacker@evil.example>'), { email: "attacker@evil.example", name: "" });
    assert.deepEqual(parseAddress("ceo@company.com <attacker@evil.example>"), { email: "attacker@evil.example", name: "" });
    assert.deepEqual(parseAddress('"Jane <ceo@company.com>" <jane@customer.example>'), { email: "jane@customer.example", name: "" });
    assert.deepEqual(parseAddress("=?UTF-8?B?Y2VvQGNvbXBhbnkuY29t?= <jane@customer.example>").email, "jane@customer.example");
    // Unchanged for ordinary values.
    assert.deepEqual(parseAddress("Priya Shah <Priya@Example.com>"), { email: "priya@example.com", name: "Priya Shah" });
    assert.deepEqual(parseAddress('"Shah, Priya" <priya@example.com>'), { email: "priya@example.com", name: "Shah, Priya" });
    assert.deepEqual(parseAddress("priya@example.com"), { email: "priya@example.com", name: "" });
    assert.deepEqual(parseAddressList('"Lee, Sam" <sam@x.example>, "ceo@x.example" <eve@y.example>').map((a) => a.email), ["sam@x.example", "eve@y.example"]);
    assert.equal(normalizeEmail("Bounce <bounce+1@x.example>"), "bounce+1@x.example");
    assert.equal(bracketedAddress("no brackets here@x.example"), null);
  });

  test("the sender scope: whole addresses and @domain exactly", () => {
    assert.equal(senderInScope("Forms@Acme.example", ["forms@acme.example"]), true);
    assert.equal(senderInScope("alerts@acme.example", ["@acme.example"]), true);
    assert.equal(senderInScope("x@sub.acme.example", ["@acme.example"]), false, "a domain entry is that domain exactly");
    assert.equal(senderInScope("ceo@evil.example", ["forms@acme.example", "@acme.example"]), false);
    assert.equal(senderInScope("", ["@acme.example"]), false);
    assert.equal(addressAtDomain("jane@acme.example", ["@acme.example"]), true);
    assert.equal(addressAtDomain("jane@evil.example", ["@acme.example"]), false);
    assert.deepEqual(cleanSenderList(["Forms@Acme.example", "@acme.example", "forms@acme.example"]), { list: ["forms@acme.example", "@acme.example"], problem: "" });
    assert.match(cleanSenderList(["not an address"]).problem, /isn't an email address or a domain/);
    assert.deepEqual(cleanDomainList("acme.example, @other.example"), { list: ["@acme.example", "@other.example"], problem: "" });
    assert.match(cleanDomainList(["jane@acme.example"]).problem, /domain/);
  });

  test("a whole free-mail domain is refused as a sender; an exact address there is fine (review L8)", () => {
    for (const d of ["@gmail.com", "@googlemail.com", "@outlook.com", "@hotmail.com", "@live.com", "@msn.com", "@yahoo.com", "@icloud.com", "@me.com", "@aol.com", "@proton.me", "@protonmail.com", "@gmx.de", "@gmx.net", "@mail.com", "@yandex.ru", "@zoho.com"]) {
      const r = cleanSenderList([d]);
      assert.equal(r.list.length, 0, d);
      assert.match(r.problem, /free email provider anyone can sign up to/, d);
    }
    assert.deepEqual(cleanSenderList(["forms.acme@gmail.com"]), { list: ["forms.acme@gmail.com"], problem: "" });
    assert.deepEqual(cleanSenderList(["@gmx-partner.example", "@mail.company.example"]).problem, "");
    assert.equal(freeMailDomain("gmx.co.uk"), false, "gmx.* is one top-level domain");
    assert.equal(freeMailDomain("GMX.AT"), true);
    assert.ok(FREE_MAIL_DOMAINS.includes("yandex.*"));
    assert.match((validateActions({ requester_from_message: { senders: ["@gmail.com"] } }) as { error: string }).error, /only for messages from: @gmail\.com is a free email provider/);
  });

  test("the sender scope is required: a rule without it is refused in a sentence", () => {
    const none = validateActions({ requester_from_message: { find: "label", senders: [] } });
    assert.deepEqual(none, { ok: false, error: REQUESTER_SCOPE_REQUIRED });
    assert.match(REQUESTER_SCOPE_REQUIRED, /Only for messages from/);
    assert.deepEqual(validateActions({ requester_from_message: { find: "label" } }), { ok: false, error: REQUESTER_SCOPE_REQUIRED });
    const ok = validateActions({ requester_from_message: { senders: ["Forms@acme.example"], domains: ["acme.example"], keep_cc: true } });
    assert.deepEqual(ok, { ok: true, value: { requester_from_message: { find: "label", labels: ["From:", "Email:"], senders: ["forms@acme.example"], domains: ["@acme.example"], keep_cc: true } } });
    const first = validateActions({ requester_from_message: { find: "first", senders: ["@forms.example"], allow_agents: true } });
    assert.deepEqual(first, { ok: true, value: { requester_from_message: { find: "first", senders: ["@forms.example"], allow_agents: true } } });
    assert.match((validateActions({ requester_from_message: { find: "last", senders: ["a@b.example"] } }) as { error: string }).error, /find is "label"/);
    assert.match((validateActions({ requester_from_message: { senders: ["nope"] } }) as { error: string }).error, /only for messages from: "nope" isn't an email address/);
  });
});

describe("rule validation: the requester and copy actions", () => {
  test("change the requester to a person: one of an account or an address", () => {
    assert.deepEqual(validateActions({ requester_set: { user_id: 12 } }), { ok: true, value: { requester_set: { user_id: 12 } } });
    assert.deepEqual(validateActions({ requester_set: { email: " Jane@Acme.example ", name: "Jane", keep_cc: true } }), { ok: true, value: { requester_set: { email: "jane@acme.example", name: "Jane", keep_cc: true } } });
    assert.match((validateActions({ requester_set: { user_id: 3, email: "a@b.example" } }) as { error: string }).error, /not both/);
    assert.match((validateActions({ requester_set: { email: "not-an-address" } }) as { error: string }).error, /isn't a single email address/);
    assert.match((validateActions({ requester_set: {} }) as { error: string }).error, /pick the person/);
    assert.match((validateActions({ requester_set: { user_id: 3 }, requester_from_message: { senders: ["a@b.example"] } }) as { error: string }).error, /to a person or from the message, not both/);
  });

  test("copy a value: where from, how found, where to, with sentences", () => {
    const one = validateActions({ copy_values: [{ from: "body", label: " Asset tag: ", field_key: "asset_tag" }] });
    assert.deepEqual(one, { ok: true, value: { copy_values: [{ from: "body", label: "Asset tag:", field_key: "asset_tag" }] } });
    const tag = validateActions({ copy_values: [{ from: "subject", pattern: "host=(\\S+)", tag: true, only_if_empty: false }] });
    assert.deepEqual(tag, { ok: true, value: { copy_values: [{ from: "subject", pattern: "host=(\\S+)", tag: true }] } });
    const err = (v: unknown) => (validateActions({ copy_values: v }) as { error: string }).error;
    assert.match(err([{ label: "A:", pattern: "(x)", field_key: "a" }]), /after a label or with a pattern, not both/);
    assert.match(err([{ field_key: "a" }]), /say where the value is/);
    assert.match(err([{ pattern: "Asset tag: \\S+", field_key: "a" }]), /exactly one group in brackets/);
    assert.match(err([{ pattern: "(a)(b)", field_key: "a" }]), /exactly one group/);
    assert.deepEqual(validateActions({ copy_values: [{ pattern: "(?:x|y)(\\d+)", field_key: "a" }] }).ok, true, "non-capturing groups are fine");
    assert.match(err([{ label: "A:", field_key: "a", tag: true }]), /into a field or add a tag, not both/);
    assert.match(err([{ label: "A:" }]), /pick the custom field/);
    assert.match(err([{ label: "A:", field_key: "Not A Key" }]), /isn't a custom field's key/);
    assert.match(err([{ label: "A:", field_key: "a", from: "header" }]), /copy from "subject" or "body"/);
    assert.match(err(Array.from({ length: 11 }, () => ({ label: "A:", tag: true }))), /up to 10 values/);
    assert.match(err([{ label: "A:", tag: true }, { pattern: "(", tag: true }]), /^Copy a value into a field \(2\): The pattern/);
  });

  test("the plain words name every part, the sender scope included", () => {
    assert.equal(
      requesterFromMessageWords({ find: "label", labels: ["From:", "Email:"], senders: ["forms@acme.example", "@alerts.example"], domains: ["@acme.example"], keep_cc: true }),
      'make the email address after "From:" or "Email:" in the message the requester, only for messages from forms@acme.example or @alerts.example, only addresses at @acme.example, keeping the original sender as a CC'
    );
    assert.equal(requesterFromMessageWords({ find: "first", senders: ["a@b.example"], allow_agents: true }), "make the first email address in the message the requester, only for messages from a@b.example, desk agents allowed");
    assert.equal(copyWords({ from: "body", label: "Asset tag:", field_key: "asset_tag" }, "Asset tag"), 'copy the text after "Asset tag:" in the message into Asset tag while it is empty');
    assert.equal(copyWords({ from: "subject", pattern: "host=(\\S+)", tag: true }, ""), "add what the pattern /host=(\\S+)/ finds in the subject as a tag");
  });
});

describe("effectivePatch: nothing to change means the rule settles", () => {
  const t = { team_id: 1, assignee_id: null, priority: "normal" as const, status: "open" as const, category: "", tags: ["vpn"], requester_id: 7, requester_email: "jane@acme.example" };
  test("a requester the ticket already has, and a field value it already holds, change nothing", () => {
    assert.deepEqual(effectivePatch({}, t, { requester: { id: 7, name: "Jane", email: "jane@acme.example" } }), {});
    assert.deepEqual(effectivePatch({}, t, { requester: { id: 8, name: "Sam", email: "sam@acme.example" } }), { requester: { id: 8, name: "Sam", email: "sam@acme.example" } });
    const outside = { ...t, requester_id: null, requester_email: "Forms@acme.example" };
    assert.deepEqual(effectivePatch({}, outside, { requester: { id: null, name: "forms", email: "forms@acme.example" } }), {});
    assert.deepEqual(effectivePatch({}, t, { custom: { asset_tag: "LT-0042" }, customNow: { asset_tag: "LT-0042" } }), {});
    assert.deepEqual(effectivePatch({}, t, { custom: { asset_tag: "LT-0042", impact: "high" }, customNow: { asset_tag: "LT-0042" } }), { custom_fields: { impact: "high" } });
    assert.deepEqual(effectivePatch({ tags_add: ["vpn"] }, t, { tags: ["vpn", "lt-0042"] }), { tags: ["vpn", "lt-0042"] });
    assert.deepEqual(effectivePatch({}, t, { tags: ["vpn"] }), {});
    // The old two-argument form is unchanged.
    assert.deepEqual(effectivePatch({ priority: "normal", tags_add: ["vpn"] }, t), {});
  });

  test("the activity line of a requester change carries its own icon (an automation's the bot)", () => {
    assert.equal(activityIcon({ kind: "internal", event: "change", author_name: "Ana", body: "Ana changed the requester from forms@acme.example to Jane" }), "requester");
    assert.equal(activityIcon({ kind: "internal", event: "change", author_name: "Automation: Web form", body: "Automation\\: Web form changed the requester from a to b" }), "bot");
  });
});

describe("the sender check: a DMARC pass counts only aligned with the From domain (review M2)", () => {
  const ar = (v: string) => ({ provider: "generic", from: "forms@acme.example", headerList: [["authentication-results", v]] as [string, string][] });
  test("an Authentication-Results DMARC pass without header.from, or for another domain, is not a pass", () => {
    assert.equal(authVerdict(ar("mx.example; dmarc=pass")).ok, false);
    assert.match(authVerdict(ar("mx.example; dmarc=pass")).reason, /header\.from not given/);
    assert.equal(authVerdict(ar("mx.example; dmarc=pass header.from=evil.example")).ok, false);
    assert.equal(authVerdict(ar("mx.example; dmarc=pass header.from=acme.example")).ok, true);
    // The organisational domain aligns (a subdomain's From).
    assert.equal(authVerdict({ ...ar("mx.example; dmarc=pass header.from=acme.example"), from: "forms@mail.acme.example" }).ok, true);
  });

  test("the provider's own verdict (out of band) is on the From it parsed, so it stands; SPF and DKIM still need alignment", () => {
    assert.equal(authVerdict({ provider: "generic", from: "forms@acme.example", auth: { dmarc: "pass" } }).ok, true);
    assert.equal(authVerdict({ provider: "generic", from: "", auth: { dmarc: "pass" } }).ok, false, "no From domain, nothing to align with");
    assert.equal(authVerdict({ provider: "sendgrid", from: "forms@acme.example", auth: { spf: "pass", envelopeFrom: "bounce@evil.example" } }).ok, false);
    assert.equal(authVerdict({ provider: "sendgrid", from: "forms@acme.example", auth: { dkim: "{@acme.example : pass}" } }).ok, true);
    // A display name naming another domain changes nothing: the From is the bracketed address.
    assert.equal(authVerdict({ provider: "generic", from: parseAddress('"x@evil.example" <forms@acme.example>').email, headerList: [["authentication-results", "mx; dmarc=pass header.from=acme.example"]] }).ok, true);
  });
});
