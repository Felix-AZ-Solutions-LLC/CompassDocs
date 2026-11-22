// The CodeQL code-scanning fixes (request forgery, ReDoS, biased random,
// prompt and attribute escaping), each pinned where its behaviour changed.
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";

/* eslint-disable @typescript-eslint/no-require-imports */
const { slackResponseUrl, teamsQuestionText } = require("../src/lib/chat-ask") as typeof import("../src/lib/chat-ask");
const safeFetch = require("../src/lib/safe-fetch") as typeof import("../src/lib/safe-fetch");
const mapping = require("../src/lib/directory-mapping") as typeof import("../src/lib/directory-mapping");
const { applyMapping, parseMapping } = mapping;
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

/** Runs `fn` and asserts it took less than `ms`. The budgets are generous (2 s) so a slow CI runner doesn't flake: the
 *  inputs are sized so the old quadratic or exponential patterns take far longer than that. */
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
  test("IPv4 inside IPv6 is judged as that IPv4; IPv4-compatible and site-local are private", async () => {
    const saved = { proxy: process.env.HTTPS_PROXY, allow: process.env.COMPASSDOCS_FETCH_ALLOW_PRIVATE };
    delete process.env.HTTPS_PROXY;
    delete process.env.COMPASSDOCS_FETCH_ALLOW_PRIVATE;
    try {
      // The URL parser rewrites the dotted tail: [::ffff:8.8.8.8] arrives as [::ffff:808:808].
      assert.equal((await safeFetch.assertPublicTarget("http://[::ffff:8.8.8.8]/")).hostname, "[::ffff:808:808]");
      for (const u of ["http://[::ffff:127.0.0.1]/", "http://[::ffff:169.254.169.254]/", "http://[::ffff:10.0.0.1]/", "http://[::127.0.0.1]/", "http://[::8.8.8.8]/", "http://[fec0::1]/", "http://[fc00::1]/"]) {
        await assert.rejects(safeFetch.assertPublicTarget(u), /Blocked/, u);
      }
      // A word that only looks like a private prefix when written short is public (fcd::1 is 0fcd::1).
      assert.ok(!safeFetch.addressBlocked("fcd::1", true));
      process.env.COMPASSDOCS_FETCH_ALLOW_PRIVATE = "1";
      assert.equal((await safeFetch.assertPublicTarget("http://[::ffff:10.0.0.1]/")).hostname, "[::ffff:a00:1]");
      assert.ok(await safeFetch.assertPublicTarget("http://[fec0::1]/"));
      for (const u of ["http://[::ffff:127.0.0.1]/", "http://[::127.0.0.1]/", "http://[::1]/", "http://[fe80::1]/"]) {
        await assert.rejects(safeFetch.assertPublicTarget(u), /Blocked/, `${u} even with private ranges allowed`);
      }
    } finally {
      if (saved.proxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved.proxy;
      if (saved.allow === undefined) delete process.env.COMPASSDOCS_FETCH_ALLOW_PRIVATE;
      else process.env.COMPASSDOCS_FETCH_ALLOW_PRIVATE = saved.allow;
    }
  });
});

describe("directory mapping patterns run on a linear-time engine (js/regex-injection)", () => {
  test("a catastrophic pattern answers at once; captures and case work as before", () => {
    const record = { title: `${"a".repeat(5000)}!`, phone: "+1 555 0100 x2345", dept: "SALES-emea" };
    assert.deepEqual(fast(2000, () => applyMapping({ kind: "extract", path: "title", pattern: "(a+)+$" }, record)), [], "exponential on a backtracking engine");
    assert.deepEqual(applyMapping({ kind: "extract", path: "phone", pattern: "x(\\d{2,5})$" }, record), ["2345"]);
    assert.deepEqual(applyMapping({ kind: "extract", path: "dept", pattern: "^(sales)-" }, record), ["SALES"]);
    assert.deepEqual(applyMapping({ kind: "extract", path: "dept", pattern: "-(\\w+)", group: 0 }, record), ["-emea"]);
    // A group past the pattern's own falls back to the whole match, as before.
    assert.deepEqual(applyMapping({ kind: "extract", path: "dept", pattern: "emea", group: 3 }, record), ["emea"]);
  });
  test("a new pattern must compile in RE2; a stored one that doesn't is kept and runs on the legacy engine", () => {
    for (const p of ["(?=a)a", "(a)\\1"]) {
      assert.match(String(mapping.patternProblem(p)), /lookarounds and backreferences aren't supported/, p);
      // Still parsed (a stored mapping is never dropped), and flagged.
      assert.ok(parseMapping({ kind: "extract", path: "x", pattern: p }), p);
      assert.deepEqual(mapping.legacyPatterns({ kind: "extract", path: "x", pattern: p }), [p]);
    }
    assert.match(String(mapping.patternProblem("[^]")), /^The pattern "\[\^\]" can't be used: /);
    assert.equal(mapping.patternProblem("x(\\d+)$"), null);
    // Sent back unchanged it passes; anything new is held to RE2.
    const stored = { microsoft: { kind: "extract", path: "x", pattern: "(?=a)a" } };
    assert.equal(mapping.newPatternProblem(stored, ["(?=a)a"]), null);
    assert.match(String(mapping.newPatternProblem({ microsoft: { kind: "first", of: [{ kind: "extract", path: "x", pattern: "(?!b)a" }] } }, ["(?=a)a"])), /lookarounds/);
  });
  test("the legacy engine sees at most LEGACY_VALUE_MAX characters of a value", () => {
    const at = (n: number) => `${"a".repeat(n)}ID-7`;
    const legacy = { kind: "extract" as const, path: "v", pattern: "(?=a)a*ID-(\\d)" };
    assert.equal(mapping.compilePattern(legacy.pattern)?.engine, "legacy");
    assert.deepEqual(applyMapping(legacy, { v: at(mapping.LEGACY_VALUE_MAX - 10) }), ["7"]);
    assert.deepEqual(applyMapping(legacy, { v: at(mapping.LEGACY_VALUE_MAX) }), [], "the tail past the cap is not read");
    // A quadratic legacy pattern over a long value stays bounded by the cap (16 s uncapped on 200,000 characters).
    // The cap bounds polynomial blow-ups only; an exponential legacy pattern is why the panel asks for a rewrite.
    const slow = { kind: "extract" as const, path: "v", pattern: "^(?=a)?a*a*b" };
    assert.equal(mapping.compilePattern(slow.pattern)?.engine, "legacy");
    assert.deepEqual(fast(2000, () => applyMapping(slow, { v: "a".repeat(200_000) })), []);
  });
});

describe("ReDoS: inputs bounded or patterns made linear (js/polynomial-redos)", () => {
  test("search operators are read from the first SEARCH_QUERY_MAX characters only", () => {
    const long = "0".repeat(200_000);
    const r = fast(2000, () => parseSearchQuery(long));
    assert.equal(r.text.length, SEARCH_QUERY_MAX);
    assert.deepEqual(parseSearchQuery('tag:ops space:"Run books" restart').filters, { tag: "ops", space: "Run books" });
  });
  test("a custom domain drops any path and port, and a run of slashes is cheap", () => {
    assert.equal(normalizeDomain("https://Docs.Example.com:8443/some/path"), "docs.example.com");
    assert.equal(normalizeDomain("docs.example.com/"), "docs.example.com");
    assert.equal(fast(2000, () => normalizeDomain(`docs.example.com${"/".repeat(200_000)}\n`)), "docs.example.com");
  });
  test("address lists: an over-long address is not an address", () => {
    // Fails the address pattern at its last character: the old patterns took 20 s and more on this.
    const longDots = `a@${".".repeat(200_000)}@`;
    assert.equal(fast(2000, () => isValidFromAddress(longDots)), false);
    assert.equal(isValidFromAddress("HR Team <hr@example.com>"), true);
    assert.deepEqual(fast(2000, () => parseRecipients(`ok@example.com, ${longDots}`)), ["ok@example.com"]);
    assert.deepEqual(fast(2000, () => parseRecipientList([longDots, "Ok@Example.com"])), ["ok@example.com"]);
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
    // A ResponseLocation is never taken for the Location.
    const response = md.replace(
      '<md:SingleSignOnService Location="https://idp.example.com/sso/redirect"',
      '<md:SingleSignOnService ResponseLocation="https://idp.example.com/sso/response" Location="https://idp.example.com/sso/redirect"'
    );
    assert.equal(parseIdpMetadata(response)?.idpSsoUrl, "https://idp.example.com/sso/redirect");
    const responseOnly = md.replace('Location="https://idp.example.com/sso/redirect"', 'ResponseLocation="https://idp.example.com/sso/response"');
    assert.equal(parseIdpMetadata(responseOnly)?.idpSsoUrl, "https://idp.example.com/sso/post", "no Location on the redirect binding: the POST one");
    const junk = `entityID="x" ${"<SingleSignOnService".repeat(5_000)} ${"<X509Certificate".repeat(5_000)}`;
    assert.equal(fast(2000, () => parseIdpMetadata(junk)), null);
  });
});

describe("the Teams question strip (js/polynomial-redos)", () => {
  test("drops the mention and tags, and a run of unclosed < or <at> is cheap", () => {
    assert.equal(teamsQuestionText("<at>Ask Docs</at> how do we <b>roll back</b>&nbsp;a deploy?"), "how do we roll back a deploy?");
    assert.equal(teamsQuestionText("is 3 < 4 <i>really</i>?"), "is 3 < 4 really ?");
    assert.equal(fast(2000, () => teamsQuestionText(`${"<".repeat(200_000)}x`)).length, 200_001);
    assert.equal(fast(2000, () => teamsQuestionText(`${"<at>".repeat(200_000)}x`)), "x", "each unclosed <at> is a tag of its own");
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
  });
  test("a-d are a ninth of the characters, as uniform gives, not the eighth byte % 36 gave", () => {
    // byte % 36 maps 256 values onto 36: a-d get 8 bytes each, the rest 7, so
    // a-d were 32/256 = 12.5% of characters; uniform is 4/36 = 11.1%. Over
    // 20,000 tokens (320,000 characters) the standard error of the share is
    // about 0.06%, so 11.8% sits more than 10 of them from both.
    for (const [name, make] of [["email", newReplyToken], ["tickets", newTicketReplyToken]] as const) {
      let ad = 0;
      let all = 0;
      for (let i = 0; i < 20_000; i++) {
        for (const c of make()) {
          all++;
          if (c <= "d" && c >= "a") ad++;
        }
      }
      const share = ad / all;
      assert.ok(share > 0.104 && share < 0.118, `${name}: a-d share ${(share * 100).toFixed(2)}%`);
    }
    // The integration key's alphabet is 62: A-H were 40/256 = 15.6% under byte % 62, 8/62 = 12.9% uniform.
    let ah = 0;
    let all = 0;
    for (let i = 0; i < 8_000; i++) {
      for (const c of newIntegrationKey().key.slice(KEY_PREFIX.length)) {
        all++;
        if (c >= "A" && c <= "H") ah++;
      }
    }
    assert.ok(ah / all > 0.122 && ah / all < 0.142, `integration key A-H share ${((ah / all) * 100).toFixed(2)}%`);
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
