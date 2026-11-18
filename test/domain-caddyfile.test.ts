// The proxy config with fallback hosts (1.20.29, lib/caddy buildCaddyfile)
// and the fallback hostname rules (lib/fallback-hosts): the custom domain,
// each fallback host as its own site, the plain-HTTP route for the domain
// check on any host, and the strict validation of the hostname remembered
// from an admin's Host header.
//
// With a caddy binary (CADDY_BIN=/path/to/caddy, or caddy on PATH) every
// generated config is also run through `caddy adapt`; without one that test
// is skipped.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/domain-caddyfile.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCaddyfile, UnsafeCaddyValue } from "../src/lib/caddy";
import { normalizeSettings, validTlsEmail } from "../src/lib/settings";
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

  test("auto: each fallback is served like the domain, HTTP redirecting to its own HTTPS (review H1)", () => {
    const s = sites(buildCaddyfile("docs.example.com", "auto", "ops@example.com", [AZ, { host: "old.example.org", acme: true }]));
    assert.match(s.get("docs.example.com")!, /reverse_proxy app:3000/);
    assert.match(s.get("docs.example.com")!, /tls ops@example\.com/);
    // HTTPS: the app, with Let's Encrypt for the cloudapp name.
    const fb = s.get(AZ)!;
    assert.match(fb, /reverse_proxy app:3000/);
    assert.match(fb, /tls ops@example\.com/);
    // Plain HTTP: the check, then a redirect to the fallback's own HTTPS. Never the app in cleartext.
    const fbHttp = s.get(`http://${AZ}`)!;
    assert.ok(fbHttp.includes(`handle ${DOMAIN_CHECK_PATH}*`));
    assert.match(fbHttp, new RegExp(`redir https://${AZ.replace(/\./g, "\\.")}\\{uri\\} 308`));
    assert.ok(!/^\treverse_proxy/m.test(fbHttp), "no top-level reverse_proxy over plain HTTP");
    assert.ok(![...s.keys()].some((k) => k.includes(", http://")), "no site serving HTTPS and plain HTTP alike");
    assert.ok(s.get("old.example.org"));
    // The domain's own HTTP: the check, then the redirect to its HTTPS.
    const http = s.get("http://docs.example.com")!;
    assert.ok(http.indexOf(`handle ${DOMAIN_CHECK_PATH}*`) >= 0);
    assert.ok(http.indexOf(`handle ${DOMAIN_CHECK_PATH}*`) < http.indexOf("redir https://docs.example.com{uri} 308"));
    // Any other host (an IP) on HTTP: the check, then the custom domain, never its own Host (review M3).
    const any = s.get("http://")!;
    assert.match(any, new RegExp(`handle ${DOMAIN_CHECK_PATH.replace(/[.]/g, "\\.")}\\* \\{\\n\\t\\treverse_proxy app:3000`));
    assert.match(any, /redir https:\/\/docs\.example\.com\{uri\} 308/);
    assert.ok(!any.includes("{host}"));
  });

  test("a remembered fallback that failed its check gets the internal CA, never Let's Encrypt", () => {
    const s = sites(buildCaddyfile("docs.example.com", "auto", "", [{ host: "intranet.corp.example", acme: false }, { host: AZ, acme: true }]));
    assert.match(s.get("intranet.corp.example")!, /tls internal/);
    assert.ok(!s.get(AZ)!.includes("tls internal"));
  });

  test("transitional (HTTPS being verified): other names still get the app over plain HTTP", () => {
    const s = sites(buildCaddyfile("docs.example.com", "auto", "", [AZ], { transitional: true }));
    assert.equal(s.get("http://"), "\treverse_proxy app:3000\n");
    assert.ok(s.get("docs.example.com"));
  });

  test("internal: fallbacks use the internal CA too", () => {
    const s = sites(buildCaddyfile("smoke.compassdocs.test", "internal", "", ["fallback.compassdocs.test"]));
    assert.match(s.get("smoke.compassdocs.test")!, /tls internal/);
    assert.match(s.get("fallback.compassdocs.test")!, /tls internal/);
    assert.match(s.get("http://fallback.compassdocs.test")!, /redir https:\/\/fallback\.compassdocs\.test\{uri\} 308/);
  });

  test("custom: the pasted certificate is the domain's; a fallback gets its own automatic one", () => {
    const s = sites(buildCaddyfile("docs.example.com", "custom", "", [AZ]));
    assert.match(s.get("docs.example.com")!, /tls \/etc\/caddy\/certs\/cert\.pem \/etc\/caddy\/certs\/key\.pem/);
    const fb = s.get(AZ)!;
    assert.ok(!fb.includes("cert.pem"));
    assert.ok(!fb.includes("tls "));
  });

  test("off: plain HTTP everywhere, and other hosts keep Caddy's empty answer apart from the check", () => {
    const s = sites(buildCaddyfile("docs.example.com", "off", "", [AZ]));
    assert.match(s.get("http://docs.example.com")!, /reverse_proxy app:3000/);
    assert.match(s.get(`http://${AZ}`)!, /reverse_proxy app:3000/);
    assert.ok(!s.has(AZ));
    const any = s.get("http://")!;
    assert.match(any, /compassdocs-domain-check/);
    assert.ok(!any.includes("redir"));
  });

  test("a fallback that is the domain itself is not a second site", () => {
    const c = buildCaddyfile("docs.example.com", "auto", "", ["docs.example.com"]);
    assert.equal(c.match(/^docs\.example\.com \{/gm)?.length, 1);
  });

  test("never renders a value Caddyfile syntax could read as more than one token (review M2)", () => {
    for (const email of ["a@b.co\n}\n:9999 {", "a b@c.co", "x@y.co{", "x@y.co#", "{env.SECRET}@x.co"]) {
      assert.throws(() => buildCaddyfile("docs.example.com", "auto", email, []), UnsafeCaddyValue, JSON.stringify(email));
    }
    assert.throws(() => buildCaddyfile("docs.example.com", "auto", "", ["evil.example.com {"]), UnsafeCaddyValue);
    assert.throws(() => buildCaddyfile("docs.example.com respond", "auto", "", []), UnsafeCaddyValue);
  });

  // Real Caddy, when a binary is at hand (CADDY_BIN, or `caddy` on PATH): every mode adapts.
  const caddy = process.env.CADDY_BIN || "caddy";
  const haveCaddy = spawnSync(caddy, ["version"], { encoding: "utf8" }).status === 0;
  test("caddy adapt accepts every generated config", { skip: haveCaddy ? false : "no caddy binary (set CADDY_BIN)" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "caddyfile-"));
    try {
      for (const mode of ["auto", "internal", "custom", "off"] as const) {
        for (const transitional of [false, true]) {
          const file = join(dir, `${mode}-${transitional}.Caddyfile`);
          writeFileSync(file, buildCaddyfile("docs.example.com", mode, mode === "auto" ? "ops@example.com" : "", [AZ, { host: "intranet.corp.example", acme: false }], { transitional }));
          const r = spawnSync(caddy, ["adapt", "--config", file], { encoding: "utf8" });
          assert.equal(r.status, 0, `${mode}/${transitional}: ${r.stderr}`);
          JSON.parse(r.stdout);
        }
      }
      const boot = join(dir, "none.Caddyfile");
      writeFileSync(boot, buildCaddyfile("", "auto", "", [AZ]));
      assert.equal(spawnSync(caddy, ["adapt", "--config", boot], { encoding: "utf8" }).status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the renewal email (review M2)", () => {
  test("only a plain address, or blank", () => {
    assert.equal(validTlsEmail("ops@example.com"), "ops@example.com");
    assert.equal(validTlsEmail("  ops+tls@mail.example.co.uk "), "ops+tls@mail.example.co.uk");
    assert.equal(validTlsEmail(""), "");
    assert.equal(validTlsEmail("   "), "");
    for (const bad of ["ops@example.com\n}", "ops @example.com", "o{p}s@example.com", "ops@example.com#x", "ops@localhost", "nope", "ops@ex ample.com", "'ops'@example.com", null, 5]) {
      assert.equal(validTlsEmail(bad as never), null, String(bad));
    }
  });

  test("a stored value that isn't one never reaches the settings the proxy reads", () => {
    assert.equal(normalizeSettings({ tls_email: "x@y.co\n}\n:1 {" }).tls_email, "");
    assert.equal(normalizeSettings({ tls_email: "ops@example.com" }).tls_email, "ops@example.com");
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
      mergeFallbackHosts([AZ, "docs.example.com"], [{ host: "old.example.org", acme: false }, { host: AZ, acme: false }], ["docs.example.com"]),
      [
        { host: AZ, source: "env", acme: true },
        { host: "old.example.org", source: "remembered", acme: false },
      ]
    );
  });
});
