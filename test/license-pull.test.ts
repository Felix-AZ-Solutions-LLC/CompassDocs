// The license from the CompassDocs console (1.21.3, lib/license-pull):
// cloud mode with COMPASSDOCS_LICENSE_URL.
//
// Licenses here are signed with a throwaway Ed25519 key, never the vendor's:
// the app's verifier (lib/license parseLicense, the pinned vendor key) must
// refuse every one of them, and does (the "invalid signature" cases and the
// last describe). To exercise the rest of the rules the puller is given a
// verifier for the throwaway key (setLicensePullDepsForTests), the only
// stand-in; lib/license itself has no such hook. A fake console (a local
// HTTP server) answers each way the contract allows, and a few it doesn't.
//
// Covered: what is accepted (valid, this workspace, not expired, at least as
// new), what is refused (invalid signature, wrong or missing workspace,
// older, shorter, expired), the request (credential, workspace header, ETag,
// time limit, body limit, same-origin redirects only), a console that is
// down or slow, Retry-After, one log line per run of failures, Check now's
// rate limit, the last good license kept in the database across a restart,
// the start-up checks, and that a license not signed by the vendor is never
// in force whatever the database holds.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/license-pull.test.ts

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import type { License } from "../src/lib/license";
import { audienceScope, cloudStartupProblems, licenseManagedByCloud, licensePullConfig, licensePullProblems } from "../src/lib/cloud";
import { setAzureCredentialForTests } from "../src/lib/azure-credential";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const WS = "ws_7f3a9c";

function mint(claims: Partial<License> & Record<string, unknown>): string {
  const full = { id: "lic_0123456789abcdef", customer: "Acme", plan: "cloud", features: ["sso"], seats: 0, issued: "2026-11-01", expires: "2027-02-01", workspace: WS, ...claims };
  const payload = Buffer.from(JSON.stringify(full));
  return `${payload.toString("base64url")}.${sign(null, payload, privateKey).toString("base64url")}`;
}

/** parseLicense's rules with the throwaway key (tests only). */
function testParse(raw: string): { license?: License; error?: string } {
  const [body, sig] = raw.trim().split(".");
  if (!body || !sig) return { error: "Malformed license." };
  const payload = Buffer.from(body, "base64url");
  if (!verify(null, payload, publicKey, Buffer.from(sig, "base64url"))) return { error: "Signature does not match — check the key or reissue." };
  const lic = JSON.parse(payload.toString()) as License;
  if (!lic.customer || !Array.isArray(lic.features) || !lic.expires) return { error: "License is missing required fields." };
  return { license: lic };
}

const NOW = new Date("2026-11-26T12:00:00Z");

// --- The rules (pure) ----------------------------------------------------------------------

describe("judgeLicense: what a fetched license must be", () => {
  let judge: typeof import("../src/lib/license-pull").judgeLicense;
  before(async () => {
    judge = (await import("../src/lib/license-pull")).judgeLicense;
  });
  const current = mint({ issued: "2026-10-01", expires: "2026-12-31" });

  test("valid, this workspace, newer: accepted", () => {
    const j = judge(mint({ issued: "2026-11-20", expires: "2027-03-01" }), current, WS, NOW, testParse);
    assert.equal(j.accept, true);
  });

  test("with nothing (or nothing valid) in force, any valid license for this workspace", () => {
    assert.equal(judge(mint({}), "", WS, NOW, testParse).accept, true);
    assert.equal(judge(mint({}), "garbage.token", WS, NOW, testParse).accept, true);
  });

  test("invalid signature: refused, by the app's own verifier too", async () => {
    const { parseLicense } = await import("../src/lib/license");
    const forged = mint({ issued: "2026-11-20", expires: "2030-01-01" });
    const j = judge(forged, current, WS, NOW); // the default: lib/license parseLicense, the vendor's key
    assert.equal(j.accept, false);
    assert.equal(j.accept === false && j.reason, "invalid");
    assert.ok(parseLicense(forged).error, "the vendor key never verifies a test-signed license");
    // A payload changed after signing.
    const [, sig] = forged.split(".");
    const tampered = `${Buffer.from(JSON.stringify({ customer: "X", features: ["sso"], expires: "2099-01-01", workspace: WS })).toString("base64url")}.${sig}`;
    const t = judge(tampered, current, WS, NOW, testParse);
    assert.equal(t.accept === false && t.reason, "invalid");
  });

  test("another workspace, or none named: refused", () => {
    const other = judge(mint({ workspace: "ws_other", expires: "2028-01-01" }), current, WS, NOW, testParse);
    assert.equal(other.accept === false && other.reason, "wrong_workspace");
    assert.match((other as { message: string }).message, /another workspace \(ws_other\)/);
    const none = judge(mint({ workspace: undefined, expires: "2028-01-01" }), current, WS, NOW, testParse);
    assert.equal(none.accept === false && none.reason, "wrong_workspace");
  });

  test("expired (its grace period included): refused, even with nothing in force", () => {
    const j = judge(mint({ issued: "2026-08-01", expires: "2026-11-20" }), "", WS, NOW, testParse);
    assert.equal(j.accept === false && j.reason, "expired");
  });

  test("older or shorter than the one in force: refused (never a downgrade)", () => {
    const shorter = judge(mint({ issued: "2026-11-20", expires: "2026-12-15" }), current, WS, NOW, testParse);
    assert.equal(shorter.accept === false && shorter.reason, "older");
    const olderIssue = judge(mint({ issued: "2026-09-01", expires: "2026-12-31" }), current, WS, NOW, testParse);
    assert.equal(olderIssue.accept === false && olderIssue.reason, "older");
    // Same expiry, issued later (a re-issue with other features): accepted.
    assert.equal(judge(mint({ issued: "2026-11-02", expires: "2026-12-31", seats: 50 }), current, WS, NOW, testParse).accept, true);
  });

  test("the same license: unchanged", () => {
    const j = judge(current, current, WS, NOW, testParse);
    assert.equal(j.accept === false && j.reason, "unchanged");
  });
});

describe("pickLicenseKey: the license in force", () => {
  let pick: typeof import("../src/lib/license").pickLicenseKey;
  before(async () => {
    pick = (await import("../src/lib/license")).pickLicenseKey;
  });
  const boot = mint({ issued: "2026-10-01", expires: "2026-12-31", workspace: undefined });
  const renewed = mint({ issued: "2026-11-20", expires: "2027-03-01" });

  test("the console's, when valid for this workspace and at least as new as the bootstrap", () => {
    assert.equal(pick({ managed: renewed, platform: boot, pullWorkspace: WS }, testParse), renewed);
    assert.equal(pick({ managed: renewed, pullWorkspace: WS }, testParse), renewed);
  });
  test("the bootstrap, when it is newer (the console redeployed the workspace with a later one)", () => {
    const later = mint({ issued: "2026-11-25", expires: "2027-06-01", workspace: undefined });
    assert.equal(pick({ managed: renewed, platform: later, pullWorkspace: WS }, testParse), later);
  });
  test("never a stored license for another workspace, or one that doesn't verify", () => {
    assert.equal(pick({ managed: mint({ workspace: "ws_other", expires: "2030-01-01" }), platform: boot, pullWorkspace: WS }, testParse), boot);
    assert.equal(pick({ managed: "abc.def", platform: boot, pullWorkspace: WS }, testParse), boot);
  });
  test("without the console (self-hosted, or no COMPASSDOCS_LICENSE_URL): exactly as before", () => {
    assert.equal(pick({ managed: renewed, platform: boot, pullWorkspace: null }, testParse), boot);
    assert.equal(pick({ stored: "saved", envKey: "env" }, testParse), "saved");
    assert.equal(pick({ envKey: "env" }, testParse), "env");
    assert.equal(pick({ platform: "plat", stored: "saved" }, testParse), "plat");
  });
});

describe("configuration (lib/cloud)", () => {
  const base = { COMPASSDOCS_CLOUD: "1", COMPASSDOCS_LICENSE_URL: "https://console.compassdocs.io/api/workspaces/ws_7f3a9c/license", COMPASSDOCS_WORKSPACE_ID: WS };

  test("self-hosted: the variables are ignored", () => {
    const env = { ...base, COMPASSDOCS_CLOUD: undefined, COMPASSDOCS_LICENSE_TOKEN: "t" };
    assert.equal(licensePullConfig(env), null);
    assert.deepEqual(licensePullProblems(env), []);
    assert.equal(licenseManagedByCloud(env), false);
  });

  test("managed identity (recommended) or a bearer token; the audience wins when both are set", () => {
    const entra = licensePullConfig({ ...base, COMPASSDOCS_LICENSE_AUDIENCE: "api://compassdocs-console" });
    assert.deepEqual(entra?.auth, { kind: "entra", audience: "api://compassdocs-console", scope: "api://compassdocs-console/.default" });
    assert.deepEqual(licensePullConfig({ ...base, COMPASSDOCS_LICENSE_TOKEN: "t0k" })?.auth, { kind: "token", token: "t0k" });
    assert.equal(licensePullConfig({ ...base, COMPASSDOCS_LICENSE_TOKEN: "t", COMPASSDOCS_LICENSE_AUDIENCE: "api://x" })?.auth.kind, "entra");
    assert.equal(audienceScope("https://console.example/"), "https://console.example/.default");
    assert.equal(audienceScope("api://x/.default"), "api://x/.default");
  });

  test("an unusable setting stops cloud mode, one sentence each", () => {
    const start = { ...base, COMPASSDOCS_SECRET_KEY: "a".repeat(64), DATABASE_URL: "postgres://x", COMPASSDOCS_BASE_URL: "https://acme.compassdocs.io" };
    const fatal = (env: Record<string, string | undefined>) => cloudStartupProblems(env).fatal.join(" | ");
    assert.match(fatal(start), /without a credential/);
    assert.match(fatal({ ...start, COMPASSDOCS_LICENSE_TOKEN: "t", COMPASSDOCS_WORKSPACE_ID: undefined }), /COMPASSDOCS_WORKSPACE_ID is not set/);
    assert.match(fatal({ ...start, COMPASSDOCS_LICENSE_TOKEN: "t", COMPASSDOCS_LICENSE_URL: "http://console.example/x" }), /must be an https:\/\/ address/);
    assert.match(fatal({ ...start, COMPASSDOCS_LICENSE_TOKEN: "t", COMPASSDOCS_LICENSE_URL: "https://u:p@console.example/x" }), /user name or password/);
    assert.equal(fatal({ ...start, COMPASSDOCS_LICENSE_TOKEN: "t" }), "");
    assert.equal(fatal({ ...start, COMPASSDOCS_LICENSE_TOKEN: "t", COMPASSDOCS_LICENSE_URL: "http://127.0.0.1:9/x" }), "", "loopback http is for tests");
    assert.match(cloudStartupProblems({ ...start, COMPASSDOCS_LICENSE_TOKEN: "t", COMPASSDOCS_LICENSE_AUDIENCE: "api://x" }).warnings.join(" "), /both set/);
  });

  test("the schedule: about 6 hours with jitter; failures back off from a minute to an hour; Retry-After wins", async () => {
    const { nextDelayMs, PULL_INTERVAL_MS, BACKOFF_MAX_MS } = await import("../src/lib/license-pull");
    assert.equal(nextDelayMs("unchanged", 0, () => 0.5), PULL_INTERVAL_MS);
    assert.equal(nextDelayMs("updated", 0, () => 0), Math.round(PULL_INTERVAL_MS * 0.9));
    assert.equal(nextDelayMs("none", 0, () => 1), Math.round(PULL_INTERVAL_MS * 1.1));
    assert.equal(nextDelayMs("unreachable", 1, () => 0.5), 60_000);
    assert.equal(nextDelayMs("unreachable", 3, () => 0.5), 240_000);
    assert.equal(nextDelayMs("unreachable", 30, () => 0.5), BACKOFF_MAX_MS);
    assert.equal(nextDelayMs("unreachable", 2, () => 0.5, 600_000), 600_000);
    assert.equal(nextDelayMs("rejected", 0, () => 0.5), 60 * 60_000);
  });
});

// --- Against a fake console and the database ---------------------------------------------------

interface Answer {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  /** Write this many bytes of body. */
  bigBody?: number;
}

class FakeConsole {
  port = 0;
  requests: { url: string; headers: http.IncomingHttpHeaders }[] = [];
  answer: (req: http.IncomingMessage) => Answer = () => ({ status: 404 });
  private server: http.Server | null = null;

  async listen(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.requests.push({ url: req.url ?? "", headers: req.headers });
      const a = this.answer(req);
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(a.status, { "content-type": "text/plain", ...(a.headers ?? {}) });
        if (a.bigBody) res.end("x".repeat(a.bigBody));
        else res.end(a.body ?? "");
      };
      if (a.delayMs) setTimeout(send, a.delayMs).unref();
      else send();
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server!.address() as net.AddressInfo).port;
  }

  url(path = "/api/workspaces/ws_7f3a9c/license"): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

describe("the puller against a fake console and the database", { skip: !process.env.DATABASE_URL && "DATABASE_URL is not set" }, () => {
  let lp: typeof import("../src/lib/license-pull");
  let lic: typeof import("../src/lib/license");
  let db: typeof import("../src/lib/db");
  const consoleServer = new FakeConsole();
  const lines: [string, string, Record<string, unknown>][] = [];
  const saved: Record<string, string | undefined> = {};
  const BOOT = mint({ issued: "2026-10-01", expires: "2026-12-31", workspace: undefined });
  const SECRET = "license-endpoint-secret-0123456789";
  let clock = NOW.getTime();

  function setEnv(vars: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(vars)) {
      if (!(k in saved)) saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  async function clearStored() {
    await db.pool().query("DELETE FROM settings WHERE key = ANY($1)", [[lic.CLOUD_LICENSE_SETTING, lp.CLOUD_LICENSE_STATUS_SETTING]]);
  }

  async function stored(): Promise<string | undefined> {
    return db.getSetting(lic.CLOUD_LICENSE_SETTING);
  }

  /** A restart: this process forgets everything; the database keeps what it kept. */
  function restart() {
    lp.resetLicensePullForTests();
    clock += 60_000; // past Check now's gap
  }

  before(async () => {
    await consoleServer.listen();
    lp = await import("../src/lib/license-pull");
    lic = await import("../src/lib/license");
    db = await import("../src/lib/db");
    await db.getSetting("__boot__"); // the schema, before cloud mode (nothing sealed with another key)
    setEnv({
      COMPASSDOCS_CLOUD: "1",
      COMPASSDOCS_LICENSE_URL: consoleServer.url(),
      COMPASSDOCS_LICENSE_TOKEN: SECRET,
      COMPASSDOCS_LICENSE_AUDIENCE: undefined,
      COMPASSDOCS_WORKSPACE_ID: WS,
      COMPASSDOCS_LICENSE_KEY: BOOT,
    });
    lp.setLicensePullDepsForTests({ parse: testParse, now: () => clock, random: () => 0.5, log: (l, e, f) => lines.push([l, e, f]), timeoutMs: 1_000 });
    await clearStored();
  });

  after(async () => {
    await clearStored().catch(() => {});
    lp.setLicensePullDepsForTests(null);
    lp.resetLicensePullForTests();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    setAzureCredentialForTests(null);
    await consoleServer.close();
    await db.closePool();
  });

  beforeEach(() => {
    restart();
    lines.length = 0;
    consoleServer.requests.length = 0;
  });

  test("a valid, newer license for this workspace is installed and kept in the database; the request carries the credential and the workspace", async () => {
    const renewed = mint({ issued: "2026-11-20", expires: "2027-03-01" });
    consoleServer.answer = () => ({ status: 200, body: `${renewed}\n`, headers: { etag: '"v2"' } });
    const out = await lp.checkLicenseNow("schedule");
    assert.equal(out.status.result, "updated", out.status.message);
    assert.match(out.status.message, /expires 2027-03-01 \(the one before expired 2026-12-31\)/);
    assert.equal(await stored(), renewed);
    const req = consoleServer.requests[0];
    assert.equal(req.headers.authorization, `Bearer ${SECRET}`);
    assert.equal(req.headers["x-compassdocs-workspace"], WS);
    assert.equal(req.headers.accept, "text/plain");
    assert.match(String(req.headers["user-agent"]), /^CompassDocs\/\d+\.\d+\.\d+$/);
    assert.equal(req.headers["if-none-match"], undefined, "nothing held yet");
    const status = await lp.readPullStatus();
    assert.equal(status?.result, "updated");
    assert.equal(status?.etag, '"v2"');
    assert.ok(status?.updatedAt && status.contactedAt);
    assert.ok(lines.some(([l, e]) => l === "info" && e === "license.renewed"));
    assert.ok(!JSON.stringify(lines).includes(SECRET));
    assert.equal(out.nextInMs, lp.PULL_INTERVAL_MS);
  });

  test("the next request names the ETag held; 304 is unchanged", async () => {
    consoleServer.answer = (req) => (req.headers["if-none-match"] === '"v2"' ? { status: 304 } : { status: 500 });
    const out = await lp.checkLicenseNow("schedule");
    assert.equal(out.status.result, "unchanged", out.status.message);
    assert.equal(consoleServer.requests[0].headers["if-none-match"], '"v2"');
  });

  test("restart: the stored license stays the one in force, so an older one from the console is refused", async () => {
    const held = await stored();
    assert.ok(held);
    const older = mint({ issued: "2026-11-05", expires: "2027-01-15" });
    consoleServer.answer = () => ({ status: 200, body: older });
    const out = await lp.checkLicenseNow("schedule");
    assert.equal(out.status.result, "rejected");
    assert.match(out.status.message, /older or shorter than the one in force .*expires 2027-03-01/);
    assert.equal(await stored(), held, "never a downgrade");
    assert.equal(out.nextInMs, 60 * 60_000);
  });

  test("invalid signature, wrong workspace, expired: refused, the license in force kept", async () => {
    const held = await stored();
    const otherKey = generateKeyPairSync("ed25519").privateKey;
    const payload = Buffer.from(JSON.stringify({ id: "lic_x", customer: "Acme", plan: "cloud", features: ["sso"], seats: 0, issued: "2026-11-25", expires: "2030-01-01", workspace: WS }));
    const forged = `${payload.toString("base64url")}.${sign(null, payload, otherKey).toString("base64url")}`;
    for (const [body, re] of [
      [forged, /does not verify: Signature does not match/],
      [mint({ issued: "2026-11-25", expires: "2030-01-01", workspace: "ws_other" }), /another workspace/],
      [mint({ issued: "2026-11-25", expires: "2027-01-01", workspace: undefined }), /names no workspace/],
      [mint({ issued: "2026-10-01", expires: "2026-11-01" }), /expired on 2026-11-01/],
    ] as const) {
      restart();
      consoleServer.answer = () => ({ status: 200, body });
      const out = await lp.checkLicenseNow("schedule");
      assert.equal(out.status.result, "rejected");
      assert.match(out.status.message, re);
      assert.equal(await stored(), held);
    }
    const warned = lines.filter(([, e]) => e === "license.console_rejected");
    assert.equal(warned.length, 4, "each distinct refusal is said once");
  });

  test("console down: the license is kept, one warning for the run, backoff doubling", async () => {
    const held = await stored();
    await consoleServer.close();
    try {
      const a = await lp.checkLicenseNow("schedule");
      clock += 60_000;
      const b = await lp.checkLicenseNow("schedule");
      clock += 60_000;
      const c = await lp.checkLicenseNow("schedule");
      for (const o of [a, b, c]) assert.equal(o.status.result, "unreachable", o.status.message);
      assert.match(a.status.message, /can't be reached: .*ECONNREFUSED/);
      assert.deepEqual([a.nextInMs, b.nextInMs, c.nextInMs], [60_000, 120_000, 240_000]);
      assert.equal(lines.filter(([, e]) => e === "license.console_unreachable").length, 1, "logged once");
      assert.equal(await stored(), held);
      // A restart during the outage: the stored license is still the one in force (the console's, not the bootstrap).
      restart();
      const key = await lic.licenseKey();
      assert.notEqual(key, held, "the app's own verifier never trusts a test-signed license...");
      assert.equal(key, BOOT, "...so it falls back to the bootstrap, never to nothing");
    } finally {
      await consoleServer.listen();
      setEnv({ COMPASSDOCS_LICENSE_URL: consoleServer.url() });
    }
  });

  test("back again: one line saying so", async () => {
    consoleServer.answer = () => ({ status: 304 });
    // Start from a logged outage.
    await consoleServer.close();
    await lp.checkLicenseNow("schedule");
    await consoleServer.listen();
    setEnv({ COMPASSDOCS_LICENSE_URL: consoleServer.url() });
    clock += 60_000;
    const out = await lp.checkLicenseNow("schedule");
    assert.equal(out.status.result, "unchanged");
    assert.deepEqual(
      lines.map(([, e]) => e),
      ["license.console_unreachable", "license.console_ok"]
    );
  });

  test("slow console: given up after the time limit, as unreachable", async () => {
    consoleServer.answer = () => ({ status: 200, body: mint({}), delayMs: 3_000 });
    const started = Date.now();
    const out = await lp.checkLicenseNow("schedule");
    assert.ok(Date.now() - started < 2_500, "the 1 s test limit held");
    assert.equal(out.status.result, "unreachable");
    assert.match(out.status.message, /no answer within 1 s/);
  });

  test("redirects: same origin followed, another host refused (the credential never leaves)", async () => {
    const renewed = mint({ issued: "2026-11-24", expires: "2027-04-01" });
    consoleServer.answer = (req) =>
      req.url === "/api/workspaces/ws_7f3a9c/license" ? { status: 307, headers: { location: "/v2/license" } } : { status: 200, body: renewed };
    const out = await lp.checkLicenseNow("schedule");
    assert.equal(out.status.result, "updated", out.status.message);
    assert.deepEqual(consoleServer.requests.map((r) => r.url), ["/api/workspaces/ws_7f3a9c/license", "/v2/license"]);
    restart();
    consoleServer.requests.length = 0;
    consoleServer.answer = () => ({ status: 302, headers: { location: `http://localhost:${consoleServer.port}/elsewhere` } });
    const away = await lp.checkLicenseNow("schedule");
    assert.equal(away.status.result, "error");
    assert.match(away.status.message, /redirected to another host \(localhost:\d+\); the request was not followed/);
    assert.equal(consoleServer.requests.length, 1);
    restart();
    consoleServer.requests.length = 0;
    consoleServer.answer = () => ({ status: 302, headers: { location: "/loop" } });
    const loop = await lp.checkLicenseNow("schedule");
    assert.match(loop.status.message, /redirected more than 2 times/);
    assert.equal(consoleServer.requests.length, 3);
  });

  test("answers the contract defines: 204/404 none, 401/403 refused, 429/503 with Retry-After, and bodies that aren't a license", async () => {
    const cases: [Answer, string, RegExp?][] = [
      [{ status: 204 }, "none"],
      [{ status: 404 }, "none"],
      [{ status: 401 }, "unauthorized", /refused the workspace's credential \(401\)\. Check COMPASSDOCS_LICENSE_TOKEN/],
      [{ status: 403 }, "unauthorized"],
      [{ status: 503, headers: { "retry-after": "120" } }, "unreachable", /answered 503/],
      [{ status: 429, headers: { "retry-after": "5" } }, "unreachable"],
      [{ status: 200, body: "<html>login</html>" }, "error", /is not a license/],
      [{ status: 200, bigBody: 20_000 }, "error", /larger than 16 KB/],
      [{ status: 418 }, "error", /answered 418/],
    ];
    for (const [answer, result, re] of cases) {
      restart();
      consoleServer.answer = () => answer;
      const out = await lp.checkLicenseNow("schedule");
      assert.equal(out.status.result, result, `${answer.status}: ${out.status.message}`);
      if (re) assert.match(out.status.message, re);
      if (answer.status === 503) assert.equal(out.nextInMs, 120_000, "Retry-After honoured");
      if (answer.status === 429) assert.equal(out.nextInMs, 60_000, "Retry-After floored at a minute");
    }
  });

  test("Check now: one request at a time, none within 30 s of the last", async () => {
    consoleServer.answer = () => ({ status: 304, delayMs: 100 });
    const [a, b] = await Promise.all([lp.checkLicenseNow("manual"), lp.checkLicenseNow("manual")]);
    assert.equal(a, b, "a second caller shares the request in flight");
    assert.equal(consoleServer.requests.length, 1);
    clock += 10_000;
    const c = await lp.checkLicenseNow("manual");
    assert.equal(c.retryInMs, 20_000);
    assert.equal(consoleServer.requests.length, 1);
  });

  test("the managed identity: an Entra token for the audience's /.default, cached", async () => {
    const scopes: string[] = [];
    setAzureCredentialForTests({
      async getToken(s) {
        scopes.push(String(s));
        return { token: "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJhcGk6Ly9jb25zb2xlIn0.c2ln", expiresOnTimestamp: Date.now() + 3600_000 };
      },
    });
    setEnv({ COMPASSDOCS_LICENSE_AUDIENCE: "api://compassdocs-console" });
    lp.setLicensePullDepsForTests({ parse: testParse, now: () => clock, random: () => 0.5, log: (l, e, f) => lines.push([l, e, f]), timeoutMs: 1_000 });
    try {
      consoleServer.answer = () => ({ status: 304 });
      await lp.checkLicenseNow("schedule");
      restart();
      await lp.checkLicenseNow("schedule");
      assert.equal(consoleServer.requests[0].headers.authorization, "Bearer eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJhcGk6Ly9jb25zb2xlIn0.c2ln");
      assert.deepEqual(scopes, ["api://compassdocs-console/.default", "api://compassdocs-console/.default"]);
      // A credential that can't be had: no request, "unauthorized" (or "unreachable" when transient).
      setAzureCredentialForTests({
        async getToken() {
          throw Object.assign(new Error("Identity not found"), { statusCode: 400 });
        },
      });
      restart();
      consoleServer.requests.length = 0;
      const out = await lp.checkLicenseNow("schedule");
      assert.equal(out.status.result, "unauthorized");
      assert.match(out.status.message, /Could not get a Microsoft Entra token for api:\/\/compassdocs-console\/\.default as the system-assigned managed identity: Identity not found/);
      assert.equal(consoleServer.requests.length, 0);
    } finally {
      setEnv({ COMPASSDOCS_LICENSE_AUDIENCE: undefined });
      setAzureCredentialForTests(null);
    }
  });

  test("whatever the database holds, only a license signed by the vendor is ever in force", async () => {
    // A forged license written straight into the setting (as a bug or an attacker with database access might).
    await db.setSetting(lic.CLOUD_LICENSE_SETTING, mint({ issued: "2026-11-25", expires: "2099-01-01", features: ["sso", "scim", "helpdesk"] }));
    assert.equal(await lic.licenseKey(), BOOT);
    const state = await lic.licenseState();
    assert.equal(state.status, "invalid", "the bootstrap here is test-signed too: invalid, never active");
    assert.notEqual(await lic.licenseSource(), "cloud");
  });
});
