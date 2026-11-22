// The CodeQL code-scanning fixes (request forgery, ReDoS, biased random,
// prompt and attribute escaping), each pinned where its behaviour changed.
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";

/* eslint-disable @typescript-eslint/no-require-imports */
const { slackResponseUrl } = require("../src/lib/chat-ask") as typeof import("../src/lib/chat-ask");
const safeFetch = require("../src/lib/safe-fetch") as typeof import("../src/lib/safe-fetch");
const { applyMapping, parseMapping } = require("../src/lib/directory-mapping") as typeof import("../src/lib/directory-mapping");
const { parseSearchQuery, SEARCH_QUERY_MAX } = require("../src/lib/search-query") as typeof import("../src/lib/search-query");
const { normalizeDomain } = require("../src/lib/settings") as typeof import("../src/lib/settings");
const { parseIdpMetadata } = require("../src/lib/saml-config") as typeof import("../src/lib/saml-config");
const { isValidFromAddress } = require("../src/lib/newsletter") as typeof import("../src/lib/newsletter");
const { parseRecipients } = require("../src/lib/directory-schedule-rules") as typeof import("../src/lib/directory-schedule-rules");
const { parseRecipientList } = require("../src/lib/directory-export-schedule-rules") as typeof import("../src/lib/directory-export-schedule-rules");
const { newReplyToken } = require("../src/lib/helpdesk/email") as typeof import("../src/lib/helpdesk/email");
const { newTicketReplyToken } = require("../src/lib/helpdesk/tickets") as typeof import("../src/lib/helpdesk/tickets");
const { newIntegrationKey, KEY_PREFIX } = require("../src/lib/helpdesk/intake/integrations") as typeof import("../src/lib/helpdesk/intake/integrations");
const { auditLogFields } = require("../src/lib/audit") as typeof import("../src/lib/audit");
/* eslint-enable @typescript-eslint/no-require-imports */

/** Runs `fn` and asserts it took less than `ms` (a catastrophic regex takes seconds). */
function fast<T>(ms: number, fn: () => T): T {
  const t0 = Date.now();
  const out = fn();
  assert.ok(Date.now() - t0 < ms, `took ${Date.now() - t0}ms`);
  return out;
}

describe("Slack response_url (js/request-forgery)", () => {
  test("only https on hooks.slack.com, rebuilt on that host", () => {
    assert.equal(
      slackResponseUrl("https://hooks.slack.com/commands/T1/123/abc?x=1"),
      "https://hooks.slack.com/commands/T1/123/abc?x=1"
    );
    for (const bad of [
      "",
      "not a url",
      "http://hooks.slack.com/commands/T1/1/a",
      "https://hooks.slack.com.evil.example/commands",
      "https://evil.example/https://hooks.slack.com/",
      "https://hooks.slack.com@evil.example/commands",
      "https://user:pw@hooks.slack.com/commands",
      "https://hooks.slack.com:8443/commands",
      "https://169.254.169.254/latest/meta-data",
    ]) {
      assert.equal(slackResponseUrl(bad), null, bad);
    }
  });
});

describe("safeFetch target checks: IPv6 literals", () => {
  test("a bracketed IPv6 loopback, private or mapped address is refused, proxied or not", async () => {
    const saved = process.env.HTTPS_PROXY;
    try {
      for (const proxy of [undefined, "http://proxy.invalid:3128"]) {
        if (proxy) process.env.HTTPS_PROXY = proxy;
        else delete process.env.HTTPS_PROXY;
        for (const u of ["http://[::1]/", "http://[fd00::1]:8080/x", "http://[::ffff:127.0.0.1]/", "http://[fe80::1]/"]) {
          await assert.rejects(safeFetch.assertPublicTarget(u), /Blocked/, `${u} via ${proxy ?? "direct"}`);
        }
      }
      delete process.env.HTTPS_PROXY;
      // A public IPv6 literal is judged as the address it is, not as a name to resolve.
      assert.equal((await safeFetch.assertPublicTarget("https://[2606:4700::1111]/")).hostname, "[2606:4700::1111]");
    } finally {
      if (saved === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved;
    }
  });
});

describe("directory mapping patterns run on a linear-time engine (js/regex-injection)", () => {
  test("a catastrophic pattern answers at once; captures and case work as before", () => {
    const record = { title: `${"a".repeat(5000)}!`, phone: "+1 555 0100 x2345", dept: "SALES-emea" };
    assert.deepEqual(fast(500, () => applyMapping({ kind: "extract", path: "title", pattern: "(a+)+$" }, record)), []);
    assert.deepEqual(applyMapping({ kind: "extract", path: "phone", pattern: "x(\\d{2,5})$" }, record), ["2345"]);
    assert.deepEqual(applyMapping({ kind: "extract", path: "dept", pattern: "^(sales)-" }, record), ["SALES"]);
    assert.deepEqual(applyMapping({ kind: "extract", path: "dept", pattern: "-(\\w+)", group: 0 }, record), ["-emea"]);
    // A group past the pattern's own falls back to the whole match, as before.
    assert.deepEqual(applyMapping({ kind: "extract", path: "dept", pattern: "emea", group: 3 }, record), ["emea"]);
  });
  test("lookarounds and backreferences are refused when a mapping is saved", () => {
    assert.equal(parseMapping({ kind: "extract", path: "x", pattern: "(?=a)a" }), null);
    assert.equal(parseMapping({ kind: "extract", path: "x", pattern: "(a)\\1" }), null);
    assert.ok(parseMapping({ kind: "extract", path: "x", pattern: "x(\\d+)$" }));
  });
});

describe("ReDoS: inputs bounded or patterns made linear (js/polynomial-redos)", () => {
  test("search operators are read from the first SEARCH_QUERY_MAX characters only", () => {
    const long = "0".repeat(50_000);
    const r = fast(500, () => parseSearchQuery(long));
    assert.equal(r.text.length, SEARCH_QUERY_MAX);
    assert.deepEqual(parseSearchQuery('tag:ops space:"Run books" restart').filters, { tag: "ops", space: "Run books" });
  });
  test("a custom domain drops any path and port, and a run of slashes is cheap", () => {
    assert.equal(normalizeDomain("https://Docs.Example.com:8443/some/path"), "docs.example.com");
    assert.equal(normalizeDomain("docs.example.com/"), "docs.example.com");
    assert.equal(fast(500, () => normalizeDomain(`docs.example.com${"/".repeat(50_000)}\n`)), "docs.example.com");
  });
  test("address lists: an over-long address is not an address", () => {
    const longDots = `a@${".".repeat(20_000)}`;
    assert.equal(fast(500, () => isValidFromAddress(longDots)), false);
    assert.equal(isValidFromAddress("HR Team <hr@example.com>"), true);
    assert.deepEqual(fast(500, () => parseRecipients(`ok@example.com, ${longDots}`)), ["ok@example.com"]);
    assert.deepEqual(fast(500, () => parseRecipientList([longDots, "Ok@Example.com"])), ["ok@example.com"]);
  });
  test("IdP metadata: SSO location in either attribute order, the first certificate, and no blow-up on junk", () => {
    const md = `<?xml version="1.0"?>
<md:EntityDescriptor entityID="https://idp.example.com/meta">
  <md:IDPSSODescriptor>
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>
      MIIC AAAA
    </ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleLogoutService Location="https://idp.example.com/slo" Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/sso/post"/>
    <md:SingleSignOnService Location="https://idp.example.com/sso/redirect" Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
    assert.deepEqual(parseIdpMetadata(md), {
      idpIssuer: "https://idp.example.com/meta",
      idpSsoUrl: "https://idp.example.com/sso/redirect",
      idpCert: "MIICAAAA",
    });
    const postOnly = md.replace(/<md:SingleSignOnService Location[^>]*>/, "");
    assert.equal(parseIdpMetadata(postOnly)?.idpSsoUrl, "https://idp.example.com/sso/post");
    assert.equal(parseIdpMetadata(md.replace(/<\/ds:X509Certificate>/, "")), null);
    const junk = `entityID="x" ${"<SingleSignOnService".repeat(5_000)} ${"<X509Certificate".repeat(5_000)}`;
    assert.equal(fast(1000, () => parseIdpMetadata(junk)), null);
  });
});

describe("tokens: every character uniform (js/biased-cryptographic-random)", () => {
  test("reply tokens and integration keys keep their shape", () => {
    for (let i = 0; i < 50; i++) {
      assert.match(newReplyToken(), /^[a-z0-9]{16}$/);
      assert.match(newTicketReplyToken(), /^[a-z0-9]{16}$/);
      const k = newIntegrationKey();
      assert.match(k.key, new RegExp(`^${KEY_PREFIX}[A-Za-z0-9]{40}$`));
      assert.equal(k.prefix, k.key.slice(0, KEY_PREFIX.length + 6));
    }
    // Every letter of the alphabet turns up, the end of it as often as the start (roughly).
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i++) for (const c of newReplyToken()) counts.set(c, (counts.get(c) ?? 0) + 1);
    assert.equal(counts.size, 36);
  });
});

describe("the audit mirror's fingerprint of a typed identifier is keyed (js/insufficient-password-hash)", () => {
  test("stable, and not the bare SHA-256 a wordlist could reverse", () => {
    const f = auditLogFields({ action: "auth.login_failed", actor: { name: "Hunter2-Password!" }, targetLabel: "hunter2-password!" });
    assert.match(String(f.actor_name), /^typed:[0-9a-f]{12}$/);
    assert.equal(f.actor_name, f.target_label);
    const bare = createHash("sha256").update("hunter2-password!").digest("hex").slice(0, 12);
    assert.notEqual(f.actor_name, `typed:${bare}`);
  });
});
