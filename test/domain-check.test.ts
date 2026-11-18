// The custom-domain check (1.20.29, lib/domain-check): its decisions over an
// injected resolver and fetch, never the network. NXDOMAIN, a CNAME to
// nothing, no address, a DNS failure, a wrong address, a timeout, a refused
// connection, a wrong answer (an echo of the token included), Cloudflare's
// proxy, private and loopback answers, and a pass through the real
// well-known route with the real token and proof.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/domain-check.test.ts

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import {
  checkDomain,
  checkProof,
  verifyHttpsOnce,
  UNKNOWN_TOKEN_HEADER,
  checkTokenValid,
  classifyFetchError,
  issueCheckToken,
  isCloudflareAddress,
  CHECK_TOKEN_TTL_MS,
  DOMAIN_CHECK_PATH,
  type ChallengeResponse,
  type DomainCheckDeps,
} from "../src/lib/domain-check";
import { GET as wellKnown } from "../src/app/.well-known/compassdocs-domain-check/[token]/route";
import { addressBlocked } from "../src/lib/safe-fetch";

before(() => {
  // A fixed master key for the token and proof (no key file is written).
  process.env.COMPASSDOCS_SECRET_KEY ||= "ab".repeat(32);
});

function dnsError(code: string): Error {
  return Object.assign(new Error(`query ${code}`), { code });
}

interface Fake {
  deps: DomainCheckDeps;
  gets: { host: string; address: string; path: string }[];
}

/** Deps from a DNS table and an HTTP answer per address. */
function fake(opts: {
  a?: string[] | string; // an error code string = the lookup fails with it
  aaaa?: string[] | string;
  cname?: string[] | string;
  answer?: (address: string, path: string, host: string) => Promise<ChallengeResponse>;
  clock?: () => number;
  dnsDelay?: () => void;
}): Fake {
  const gets: Fake["gets"] = [];
  const lookup = (v: string[] | string | undefined) => async () => {
    opts.dnsDelay?.();
    if (v === undefined) throw dnsError("ENODATA");
    if (typeof v === "string") throw dnsError(v);
    return v;
  };
  const deps: DomainCheckDeps = {
    resolve4: lookup(opts.a),
    resolve6: lookup(opts.aaaa),
    resolveCname: lookup(opts.cname),
    get: async ({ host, address, path }) => {
      gets.push({ host, address, path });
      if (!opts.answer) throw new Error("no answer configured");
      return opts.answer(address, path, host);
    },
    issueToken: () => issueCheckToken(),
    proofFor: checkProof,
    now: opts.clock ?? (() => Date.now()),
  };
  return { deps, gets };
}

/** This server: the real well-known route answering the request, for the Host it was asked on. */
async function thisServer(_address: string, path: string, host = "x"): Promise<ChallengeResponse> {
  const token = path.slice(DOMAIN_CHECK_PATH.length);
  const res = await wellKnown(new Request(`http://${host}${path}`), { params: Promise.resolve({ token }) });
  return { status: res.status, body: await res.text() };
}

describe("domain check: DNS", () => {
  test("NXDOMAIN: doesn't exist in DNS yet, and nothing is fetched", async () => {
    const f = fake({ a: "ENOTFOUND", aaaa: "ENOTFOUND", cname: "ENOTFOUND" });
    const r = await checkDomain("docs.example.com", "auto", f.deps);
    assert.equal(r.ok, false);
    assert.equal(r.code, "nxdomain");
    assert.equal(r.message, "docs.example.com doesn't exist in DNS yet (no record found).");
    assert.deepEqual(r.addresses, []);
    assert.equal(f.gets.length, 0);
  });

  test("a CNAME to a name that doesn't exist says so", async () => {
    const f = fake({ a: "ENOTFOUND", aaaa: "ENOTFOUND", cname: ["myvm.eastus.cloudapp.azure.com."] });
    const r = await checkDomain("docs.example.com", "auto", f.deps);
    assert.equal(r.code, "nxdomain");
    assert.equal(r.cname, "myvm.eastus.cloudapp.azure.com");
    assert.match(r.message, /points at myvm\.eastus\.cloudapp\.azure\.com \(a CNAME record\), which doesn't exist in DNS yet/);
  });

  test("a name with no A or AAAA record", async () => {
    const r = await checkDomain("docs.example.com", "auto", fake({}).deps);
    assert.equal(r.code, "no_address");
    assert.match(r.message, /has no A or AAAA record yet/);
  });

  test("a DNS server failure is not reported as a missing name", async () => {
    const r = await checkDomain("docs.example.com", "auto", fake({ a: "ESERVFAIL", aaaa: "ESERVFAIL" }).deps);
    assert.equal(r.code, "dns_error");
    assert.match(r.message, /DNS server didn't answer \(ESERVFAIL\)/);
  });
});

describe("domain check: is it this server?", () => {
  test("a wrong address: something else answers", async () => {
    const f = fake({ a: ["1.2.3.4"], answer: async () => ({ status: 404, body: "<h1>Not Found</h1>" }) });
    const r = await checkDomain("docs.example.com", "auto", f.deps);
    assert.equal(r.code, "wrong_server");
    assert.equal(r.message, "docs.example.com points at 1.2.3.4; this server didn't answer there.");
    assert.equal("http_status" in r, false, "no HTTP status in the stored result (review L1)");
    assert.deepEqual(r.addresses, ["1.2.3.4"]);
    // The request went to the address DNS gave, for the name, on the check path.
    assert.equal(f.gets[0].address, "1.2.3.4");
    assert.equal(f.gets[0].host, "docs.example.com");
    assert.ok(f.gets[0].path.startsWith(DOMAIN_CHECK_PATH));
  });

  test("a timeout names port 80 and the ports to open", async () => {
    const f = fake({
      a: ["20.30.40.50"],
      answer: async () => {
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      },
    });
    const r = await checkDomain("docs.example.com", "auto", f.deps);
    assert.equal(r.code, "timeout");
    assert.match(r.message, /^Couldn't reach docs\.example\.com on port 80 \(timed out at 20\.30\.40\.50\): check that ports 80 and 443 are open\./);
    assert.match(r.message, /NAT hairpinning\), use Use it anyway/);
  });

  test("a refused connection", async () => {
    const f = fake({
      a: ["20.30.40.50"],
      answer: async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      },
    });
    const r = await checkDomain("docs.example.com", "internal", f.deps);
    assert.equal(r.code, "refused");
    assert.match(r.message, /connection refused at 20\.30\.40\.50/);
  });

  test("a token mismatch is not a pass: a wrong proof, or an echo of the token", async () => {
    const wrong = await checkDomain("docs.example.com", "auto", fake({ a: ["1.2.3.4"], answer: async () => ({ status: 200, body: "f".repeat(64) }) }).deps);
    assert.equal(wrong.code, "wrong_server");
    // A server whose 404 page prints the path it was asked for.
    const echo = await checkDomain(
      "docs.example.com",
      "auto",
      fake({ a: ["1.2.3.4"], answer: async (_a, path) => ({ status: 200, body: path.slice(DOMAIN_CHECK_PATH.length) }) }).deps
    );
    assert.equal(echo.ok, false);
    assert.equal(echo.code, "wrong_server");
    // Another CompassDocs (another master key) answering: its proof differs.
    const other = await checkDomain(
      "docs.example.com",
      "auto",
      fake({ a: ["1.2.3.4"], answer: async (_a, path, host) => ({ status: 200, body: `${checkProof(path.slice(DOMAIN_CHECK_PATH.length), host)}x` }) }).deps
    );
    assert.equal(other.ok, false);
  });

  test("a pass: the well-known route of this install answers with the proof", async () => {
    const f = fake({ a: ["20.30.40.50"], cname: ["myvm.eastus.cloudapp.azure.com"], answer: thisServer });
    const r = await checkDomain("docs.example.com", "auto", f.deps);
    assert.equal(r.ok, true, r.message);
    assert.equal(r.code, "ok");
    assert.deepEqual(r.tried, ["20.30.40.50"]);
    assert.equal(r.cname, "myvm.eastus.cloudapp.azure.com");
    assert.equal(r.message, "docs.example.com reaches this server.");
  });

  test("IPv4 is tried before IPv6, and a later address can pass", async () => {
    const f = fake({
      a: ["1.2.3.4"],
      aaaa: ["2001:db8::5"],
      answer: async (address, path, host) => (address === "1.2.3.4" ? { status: 502, body: "" } : thisServer(address, path, host)),
    });
    const r = await checkDomain("docs.example.com", "auto", f.deps);
    assert.equal(r.ok, true);
    assert.deepEqual(f.gets.map((g) => g.address), ["1.2.3.4", "2001:db8::5"]);
  });

  test("the whole check stops at its time budget", async () => {
    let t = 0;
    const f = fake({
      a: ["1.2.3.4", "5.6.7.8"],
      clock: () => t,
      answer: async () => {
        t += 9_000; // the first attempt eats the 8 s
        throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      },
    });
    const r = await checkDomain("docs.example.com", "auto", f.deps);
    assert.equal(r.code, "timeout");
    assert.equal(f.gets.length, 1);
  });
});

describe("domain check: the answer's kind of address", () => {
  test("Cloudflare's proxy (orange cloud) is named when the check fails through it", async () => {
    const f = fake({ a: ["104.16.1.1", "172.67.2.2"], answer: async () => ({ status: 403, body: "cf" }) });
    const r = await checkDomain("docs.example.com", "auto", f.deps);
    assert.equal(r.code, "cloudflare");
    assert.equal(r.message, "Cloudflare's proxy is on for docs.example.com (orange cloud): turn it off until the certificate is issued.");
    const off = await checkDomain("docs.example.com", "off", f.deps);
    assert.match(off.message, /behind Cloudflare's proxy/);
  });

  test("Cloudflare's proxy that passes the check through is a pass", async () => {
    const r = await checkDomain("docs.example.com", "off", fake({ a: ["104.16.1.1"], answer: thisServer }).deps);
    assert.equal(r.ok, true);
  });

  test("a private answer is refused for Let's Encrypt without a request, and checked for a LAN mode", async () => {
    const auto = fake({ a: ["10.0.0.5"], answer: thisServer });
    const r = await checkDomain("docs.corp.example", "auto", auto.deps);
    assert.equal(r.code, "private_address");
    assert.match(r.message, /points at 10\.0\.0\.5, a private address\. Let's Encrypt has to reach/);
    assert.equal(auto.gets.length, 0);
    const lan = fake({ a: ["10.0.0.5"], answer: thisServer });
    const ok = await checkDomain("docs.corp.example", "internal", lan.deps);
    assert.equal(ok.ok, true);
    assert.equal(lan.gets.length, 1);
  });

  test("loopback and link-local answers are never fetched, in any mode", async () => {
    for (const mode of ["auto", "internal", "custom", "off"] as const) {
      const f = fake({ a: ["127.0.0.1", "169.254.169.254"], aaaa: ["::1"], answer: thisServer });
      const r = await checkDomain("docs.example.com", mode, f.deps);
      assert.equal(r.code, "unusable_address");
      assert.equal(f.gets.length, 0);
    }
  });

  test("Cloudflare's ranges, both families", () => {
    assert.equal(isCloudflareAddress("104.16.0.1"), true);
    assert.equal(isCloudflareAddress("162.159.200.1"), true);
    assert.equal(isCloudflareAddress("8.8.8.8"), false);
    assert.equal(isCloudflareAddress("2606:4700:3033::ac43:a1b2"), true);
    assert.equal(isCloudflareAddress("2001:db8::1"), false);
  });
});

describe("domain check: the token and the route", () => {
  test("a token is valid for its two minutes, and only as issued", () => {
    const now = Date.now();
    const t = issueCheckToken(now);
    assert.equal(checkTokenValid(t, now), true);
    assert.equal(checkTokenValid(t, now + CHECK_TOKEN_TTL_MS + 1), false);
    const [exp, nonce, sig] = t.split(".");
    assert.equal(checkTokenValid(`${exp}.${nonce.replace(/^./, nonce[0] === "a" ? "b" : "a")}.${sig}`, now), false);
    assert.equal(checkTokenValid(`${(now + 60_000).toString(36)}.${nonce}.${sig}`, now), false);
    assert.equal(checkTokenValid("../../etc/passwd", now), false);
    assert.equal(checkTokenValid("", now), false);
  });

  test("the route answers the proof for a valid token and its Host, a marked 404 otherwise, never cached", async () => {
    const t = issueCheckToken();
    const ok = await wellKnown(new Request("http://docs.example.com:80/x"), { params: Promise.resolve({ token: t }) });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.equal(await ok.text(), checkProof(t, "docs.example.com"));
    assert.notEqual(checkProof(t, "docs.example.com"), t);
    const bad = await wellKnown(new Request("http://x"), { params: Promise.resolve({ token: "nope" }) });
    assert.equal(bad.status, 404);
    assert.equal(bad.headers.get(UNKNOWN_TOKEN_HEADER), "unknown-token");
  });

  test("the proof is bound to the host (review L2): one fetched for another name doesn't pass", async () => {
    const t = issueCheckToken();
    assert.notEqual(checkProof(t, "a.example.com"), checkProof(t, "b.example.com"));
    assert.equal(checkProof(t, "A.Example.com:80"), checkProof(t, "a.example.com"));
    // This install, but answering as if asked for another name (a proxy rewriting Host).
    const r = await checkDomain(
      "docs.example.com",
      "auto",
      fake({ a: ["1.2.3.4"], answer: (a, path) => thisServer(a, path, "other.example.com") }).deps
    );
    assert.equal(r.ok, false);
    assert.equal(r.code, "wrong_server");
  });

  test("no usable master key: a failed result with a reason, never a throw (review L7)", async () => {
    const f = fake({ a: ["1.2.3.4"], answer: thisServer });
    f.deps.issueToken = () => {
      throw new Error("Key file /uploads/.secret.key exists but is not readable");
    };
    const r = await checkDomain("docs.example.com", "auto", f.deps);
    assert.equal(r.code, "internal_error");
    assert.match(r.message, /Couldn't run the check for docs\.example\.com: Key file/);
    assert.equal(f.gets.length, 0);
  });

  test("the HTTP time budget starts after DNS (review L6)", async () => {
    let t = 0;
    const f = fake({ a: ["1.2.3.4"], clock: () => t, dnsDelay: () => (t += 5_000), answer: thisServer });
    const r = await checkDomain("docs.example.com", "auto", f.deps);
    assert.equal(r.ok, true, "a slow DNS answer leaves the full 8 s for the request");
    assert.equal(f.gets.length, 1);
  });

  test("fetch failures map to timeout, refused or unreachable", () => {
    assert.equal(classifyFetchError(Object.assign(new Error("x"), { name: "TimeoutError" })), "timeout");
    assert.equal(classifyFetchError({ name: "TypeError", cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }), "timeout");
    assert.equal(classifyFetchError({ cause: { code: "ECONNREFUSED" } }), "refused");
    assert.equal(classifyFetchError({ cause: { code: "EHOSTUNREACH" } }), "unreachable");
    assert.equal(classifyFetchError(null), "unreachable");
  });
});

describe("HTTPS after the switch (review M3)", () => {
  const deps = (get: (input: { host: string; address: string; path: string; https?: unknown }) => Promise<ChallengeResponse>) => ({
    get: get as never,
    issueToken: () => issueCheckToken(),
    proofFor: checkProof,
  });

  test("this server over HTTPS, with Let's Encrypt certificates verified", async () => {
    let seen: { https?: unknown } | null = null;
    const r = await verifyHttpsOnce(
      "docs.example.com",
      "auto",
      "20.30.40.50",
      deps(async (input) => {
        seen = input;
        return thisServer(input.address, input.path, input.host);
      })
    );
    assert.equal(r.ok, true);
    assert.deepEqual(seen!.https, { verifyCert: true });
    // Self-signed in internal mode: the certificate isn't verified, the proof still is.
    let internal: { https?: unknown } | null = null;
    const ok = await verifyHttpsOnce("docs.example.com", "internal", "10.0.0.5", deps(async (i) => ((internal = i), thisServer(i.address, i.path, i.host))));
    assert.equal(ok.ok, true);
    assert.deepEqual(internal!.https, { verifyCert: false });
  });

  test("port 443 closed, no certificate, or someone else", async () => {
    const refused = await verifyHttpsOnce("docs.example.com", "auto", "1.2.3.4", deps(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }));
    assert.equal(refused.code, "https_port");
    const tls = await verifyHttpsOnce("docs.example.com", "auto", "1.2.3.4", deps(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR" } });
    }));
    assert.equal(tls.code, "https_certificate");
    assert.equal(tls.detail, "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR");
    const other = await verifyHttpsOnce("docs.example.com", "auto", "1.2.3.4", deps(async () => ({ status: 200, body: "hello" })));
    assert.equal(other.code, "https_wrong_server");
  });
});

describe("IPv4 carried inside IPv6 (review L1)", () => {
  test("NAT64 and 6to4 forms are judged as the IPv4 address they carry", () => {
    assert.equal(addressBlocked("64:ff9b::7f00:1", false), true); // 127.0.0.1
    assert.equal(addressBlocked("64:ff9b::169.254.169.254", false), true); // metadata
    assert.equal(addressBlocked("64:ff9b::a00:5", true), true); // 10.0.0.5, private
    assert.equal(addressBlocked("64:ff9b::a00:5", false), false);
    assert.equal(addressBlocked("64:ff9b::808:808", true), false); // 8.8.8.8
    assert.equal(addressBlocked("2002:7f00:1::1", false), true); // 6to4 of 127.0.0.1
    assert.equal(addressBlocked("2002:c0a8:101::", true), true); // 192.168.1.1
    assert.equal(addressBlocked("2002:808:808::1", true), false);
    assert.equal(addressBlocked("2001:db8::1", true), false);
  });
});
