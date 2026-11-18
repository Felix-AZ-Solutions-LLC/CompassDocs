// The proxy config with fallback hosts (1.20.29, lib/caddy buildCaddyfile)
// and the fallback hostname rules (lib/fallback-hosts): the custom domain,
// each fallback host as its own site, the plain-HTTP route for the domain
// check on any host, and the strict validation of the hostname remembered
// from an admin's Host header.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/domain-caddyfile.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildCaddyfile } from "../src/lib/caddy";
import { DOMAIN_CHECK_PATH } from "../src/lib/domain-check";
import {
  envFallbackHosts,
  fallbackHostFromHostHeader,
  mergeFallbackHosts,
  validFallbackHost,
} from "../src/lib/fallback-hosts";

const AZ = "myvm.eastus.cloudapp.azure.com";

/** The site blocks of a Caddyfile: address line → body. */
function sites(caddyfile: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^([^\s{][^{\n]*?) \{\n([\s\S]*?)^\}$/gm;
  for (const m of caddyfile.matchAll(re)) out.set(m[1], m[2]);
  return out;
}

describe("buildCaddyfile", () => {
  test("no domain: the bootstrap catch-all, unchanged (it already serves every host)", () => {
    const c = buildCaddyfile("", "auto", "", [AZ]);
    assert.match(c, /:80 \{\n\treverse_proxy app:3000\n\}/);
    assert.ok(!c.includes(AZ));
    assert.match(c, /admin 0\.0\.0\.0:2019/);
  });

  test("auto: the domain, each fallback with automatic HTTPS plus HTTP, and the check on any host", () => {
    const s = sites(buildCaddyfile("docs.example.com", "auto", "ops@example.com", [AZ, "old.example.org"]));
    assert.match(s.get("docs.example.com")!, /reverse_proxy app:3000/);
    assert.match(s.get("docs.example.com")!, /tls ops@example\.com/);
    // The fallback is its own site: HTTPS (Let's Encrypt for the cloudapp name) and plain HTTP, proxied to the app.
    const fb = s.get(`${AZ}, http://${AZ}`);
    assert.ok(fb, "fallback site present");
    assert.match(fb!, /reverse_proxy app:3000/);
    assert.ok(!fb!.includes("tls internal"));
    assert.ok(s.get("old.example.org, http://old.example.org"));
    // The domain's own HTTP: the check, then the redirect to HTTPS.
    const http = s.get("http://docs.example.com")!;
    assert.ok(http.indexOf(`handle ${DOMAIN_CHECK_PATH}*`) >= 0);
    assert.ok(http.indexOf(`handle ${DOMAIN_CHECK_PATH}*`) < http.indexOf("redir https://{host}{uri} 308"));
    // Any other host on HTTP: the check reaches the app, the rest redirects as before.
    const any = s.get("http://")!;
    assert.match(any, new RegExp(`handle ${DOMAIN_CHECK_PATH.replace(/[.]/g, "\\.")}\\* \\{\\n\\t\\treverse_proxy app:3000`));
    assert.match(any, /redir https:\/\/\{host\}\{uri\} 308/);
  });

  test("internal: fallbacks use the internal CA too", () => {
    const s = sites(buildCaddyfile("smoke.compassdocs.test", "internal", "", ["fallback.compassdocs.test"]));
    assert.match(s.get("smoke.compassdocs.test")!, /tls internal/);
    assert.match(s.get("fallback.compassdocs.test, http://fallback.compassdocs.test")!, /tls internal/);
  });

  test("custom: the pasted certificate is the domain's; a fallback gets its own automatic one", () => {
    const s = sites(buildCaddyfile("docs.example.com", "custom", "", [AZ]));
    assert.match(s.get("docs.example.com")!, /tls \/etc\/caddy\/certs\/cert\.pem \/etc\/caddy\/certs\/key\.pem/);
    const fb = s.get(`${AZ}, http://${AZ}`)!;
    assert.ok(!fb.includes("cert.pem"));
    assert.ok(!fb.includes("tls "));
  });

  test("off: plain HTTP everywhere, and other hosts keep Caddy's empty answer apart from the check", () => {
    const s = sites(buildCaddyfile("docs.example.com", "off", "", [AZ]));
    assert.match(s.get("http://docs.example.com")!, /reverse_proxy app:3000/);
    assert.ok(s.get(`http://${AZ}`));
    assert.ok(!s.has(AZ));
    const any = s.get("http://")!;
    assert.match(any, /compassdocs-domain-check/);
    assert.ok(!any.includes("redir"));
  });

  test("a fallback that is the domain itself is not a second site", () => {
    const c = buildCaddyfile("docs.example.com", "auto", "", ["docs.example.com"]);
    assert.ok(!c.includes("docs.example.com, http://docs.example.com"));
  });
});

describe("fallback hostnames", () => {
  test("valid DNS names only: never an IP, localhost, a port, a path or a wildcard", () => {
    assert.equal(validFallbackHost("MyVM.EastUS.cloudapp.azure.com"), "myvm.eastus.cloudapp.azure.com");
    assert.equal(validFallbackHost("docs.example.com."), "docs.example.com");
    for (const bad of ["10.0.0.4", "localhost", "app.localhost", "intranet", "docs.example.com:8443", "http://docs.example.com", "docs.example.com/x", "*.example.com", "a b.example.com", "-bad.example.com", "x".repeat(70) + ".example.com", "", null, 42]) {
      assert.equal(validFallbackHost(bad as never), null, String(bad));
    }
  });

  test("the hostname of an admin's Host header", () => {
    assert.equal(fallbackHostFromHostHeader("myvm.eastus.cloudapp.azure.com"), AZ);
    assert.equal(fallbackHostFromHostHeader("Docs.Example.com:8443"), "docs.example.com");
    assert.equal(fallbackHostFromHostHeader("20.1.2.3"), null);
    assert.equal(fallbackHostFromHostHeader("20.1.2.3:80"), null);
    assert.equal(fallbackHostFromHostHeader("[2001:db8::1]:443"), null);
    assert.equal(fallbackHostFromHostHeader("localhost:3000"), null);
    assert.equal(fallbackHostFromHostHeader("evil.example.com, docs.example.com"), null);
    assert.equal(fallbackHostFromHostHeader("user@evil.example.com"), null);
    assert.equal(fallbackHostFromHostHeader("evil.example.com/path"), null);
    assert.equal(fallbackHostFromHostHeader(""), null);
    assert.equal(fallbackHostFromHostHeader(null), null);
  });

  test("COMPASSDOCS_FALLBACK_HOSTS: comma-separated, invalid entries skipped, no duplicates", () => {
    assert.deepEqual(envFallbackHosts(` ${AZ}, bad host!, 10.0.0.1,${AZ.toUpperCase()},second.example.org `), [AZ, "second.example.org"]);
    assert.deepEqual(envFallbackHosts(""), []);
    assert.deepEqual(envFallbackHosts(undefined), []);
  });

  test("merged: the environment's first, never the domain, never twice", () => {
    assert.deepEqual(
      mergeFallbackHosts([AZ, "docs.example.com"], ["old.example.org", AZ], ["docs.example.com"]),
      [
        { host: AZ, source: "env" },
        { host: "old.example.org", source: "remembered" },
      ]
    );
  });
});
