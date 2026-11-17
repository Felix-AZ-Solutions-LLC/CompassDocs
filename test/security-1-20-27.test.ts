// 1.20.27 security fixes, the parts that need no database: the client
// address (lib/audit cleanIp / ipFrom), the audit log's stdout mirror, the
// licence's enforcement answer, the merge warning across requesters, the
// connector consent token, the setup token, password hashing and policy,
// the per-identifier sign-in budget, the capped body readers, the CSV
// writers, the uploads archive of a backup, and SSRF pinning in safeFetch
// (against a fake server on this machine; nothing leaves it).
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/security-1-20-27.test.ts

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scryptSync } from "node:crypto";

process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";
// safeFetch routes through an outbound proxy when one is configured; the pinning test talks to this machine directly.
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete process.env[k];

/* eslint-disable @typescript-eslint/no-require-imports */
const { cleanIp, ipFrom, auditLogFields } = require("../src/lib/audit") as typeof import("../src/lib/audit");
const { stateEnforces, licenceDaysLeft } = require("../src/lib/license-enforcement") as typeof import("../src/lib/license-enforcement");
const { crossRequesterWarning } = require("../src/lib/helpdesk/merge-shared") as typeof import("../src/lib/helpdesk/merge-shared");
const { consentToken, consentTokenValid } = require("../src/lib/oauth-consent") as typeof import("../src/lib/oauth-consent");
const { setupToken, setupTokenMatches } = require("../src/lib/setup-token") as typeof import("../src/lib/setup-token");
const password = require("../src/lib/password") as typeof import("../src/lib/password");
const { passwordProblem, PASSWORD_MIN } = require("../src/lib/password-policy") as typeof import("../src/lib/password-policy");
const guard = require("../src/lib/login-guard") as typeof import("../src/lib/login-guard");
const { readTextCapped } = require("../src/lib/body-reader") as typeof import("../src/lib/body-reader");
const safeFetchMod = require("../src/lib/safe-fetch") as typeof import("../src/lib/safe-fetch");
const { csvCell: importCsvCell } = require("../src/lib/helpdesk/import-csv") as typeof import("../src/lib/helpdesk/import-csv");
const { matrixCsv } = require("../src/lib/training-audit") as typeof import("../src/lib/training-audit");
const backupFiles = require("../src/lib/backup-files") as typeof import("../src/lib/backup-files");
const { envBaseOrigin } = require("../src/lib/workspace-origin") as typeof import("../src/lib/workspace-origin");
/* eslint-enable @typescript-eslint/no-require-imports */

const req = (headers: Record<string, string>) => new Request("http://app.test/x", { headers });

describe("the client address (security review H2)", () => {
  test("only a literal IP is believed; junk and formulas are no address", () => {
    assert.equal(cleanIp("203.0.113.9"), "203.0.113.9");
    assert.equal(cleanIp(" 2001:DB8::1 "), "2001:db8::1");
    assert.equal(cleanIp("::ffff:203.0.113.9"), "203.0.113.9", "an IPv4-mapped address is its IPv4 form");
    assert.equal(cleanIp("[2001:db8::1]:443"), "2001:db8::1");
    assert.equal(cleanIp("203.0.113.9:8443"), "203.0.113.9");
    assert.equal(cleanIp('=HYPERLINK("https://evil")'), null);
    assert.equal(cleanIp("unknown"), null);
    assert.equal(cleanIp(""), null);
  });

  test("ipFrom takes the trusted hop from the right, and refuses a forged non-address there", () => {
    delete process.env.COMPASSDOCS_TRUSTED_PROXY_HOPS;
    assert.equal(ipFrom(req({ "x-forwarded-for": "1.1.1.1, 198.51.100.4" })), "198.51.100.4");
    process.env.COMPASSDOCS_TRUSTED_PROXY_HOPS = "2";
    assert.equal(ipFrom(req({ "x-forwarded-for": "1.1.1.1, 198.51.100.4, 10.0.0.2" })), "198.51.100.4");
    delete process.env.COMPASSDOCS_TRUSTED_PROXY_HOPS;
    assert.equal(ipFrom(req({ "x-forwarded-for": "evil-text" })), null);
    assert.equal(ipFrom(req({ "x-real-ip": "203.0.113.7" })), "203.0.113.7");
  });
});

describe("the audit log's stdout mirror (security review M3)", () => {
  test("fields carry the row, with secrets redacted and long text cut", () => {
    const f = auditLogFields({
      actor: { id: 7, name: "Ann", role: "admin" },
      action: "settings.sso",
      targetType: "user",
      targetId: 9,
      targetLabel: "x".repeat(600),
      details: { client_secret: "abc", token: "cdk_x", token_id: 4, nested: { password: "p", ok: "fine" }, secret_changed: true },
      ip: "203.0.113.9",
    });
    assert.equal(f.action, "settings.sso");
    assert.equal(f.target_id, "9");
    assert.ok(String(f.target_label).length <= 501);
    const d = f.details as Record<string, any>;
    assert.equal(d.client_secret, "[redacted]");
    assert.equal(d.token, "[redacted]");
    assert.equal(d.token_id, 4, "an id is not a secret");
    assert.equal(d.nested.password, "[redacted]");
    assert.equal(d.nested.ok, "fine");
    assert.equal(d.secret_changed, true, "a flag about a secret is not the secret");
  });

  test("audit() writes one JSON line with COMPASSDOCS_LOG_FORMAT=json, even when the database is unreachable", async () => {
    const { audit } = require("../src/lib/audit") as typeof import("../src/lib/audit"); // eslint-disable-line @typescript-eslint/no-require-imports
    const lines: string[] = [];
    const log = console.log;
    const err = console.error;
    const fmt = process.env.COMPASSDOCS_LOG_FORMAT;
    const mirror = process.env.COMPASSDOCS_AUDIT_STDOUT;
    const dbUrl = process.env.DATABASE_URL;
    process.env.COMPASSDOCS_LOG_FORMAT = "json";
    delete process.env.COMPASSDOCS_AUDIT_STDOUT;
    // No database in this file: the insert fails, the mirror still writes.
    process.env.DATABASE_URL = "postgres://nobody:nothing@127.0.0.1:1/none";
    console.log = (s: string) => lines.push(String(s));
    console.error = () => {};
    try {
      await audit({ actor: { name: "=HYPERLINK(1)" }, action: "auth.login_failed", details: { password: "typed" }, ip: "203.0.113.1" });
    } finally {
      console.log = log;
      console.error = err;
      process.env.COMPASSDOCS_LOG_FORMAT = fmt;
      if (mirror === undefined) delete process.env.COMPASSDOCS_AUDIT_STDOUT;
      else process.env.COMPASSDOCS_AUDIT_STDOUT = mirror;
      if (dbUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = dbUrl;
    }
    const row = lines.map((l) => JSON.parse(l)).find((o) => o.event === "audit");
    assert.ok(row, `a JSON audit line was written (got ${lines.join(" | ")})`);
    assert.equal(row.action, "auth.login_failed");
    assert.equal(row.details.password, "[redacted]");
    assert.equal(row.ip, "203.0.113.1");
  });
});

describe("licence enforcement outlives the licence (security review M4)", () => {
  const lic = { id: "x", customer: "Acme", plan: "enterprise", features: ["sso", "scim"], seats: 0, issued: "2025-01-01", expires: "2026-01-01" } as never;
  test("active, in grace and expired licences that granted a feature enforce it; none or invalid never", () => {
    assert.equal(stateEnforces({ status: "active", license: lic, daysLeft: 3 }, "sso"), true);
    assert.equal(stateEnforces({ status: "grace", license: lic, daysLeft: 3 }, "scim"), true);
    assert.equal(stateEnforces({ status: "expired", license: lic }, "sso"), true);
    assert.equal(stateEnforces({ status: "expired", license: lic }, "directory_sync"), false, "only what it granted");
    assert.equal(stateEnforces({ status: "none" }, "sso"), false);
    assert.equal(stateEnforces({ status: "invalid", reason: "x" }, "sso"), false);
  });
  test("days left counts down past zero", () => {
    assert.equal(licenceDaysLeft({ status: "expired", license: lic }, new Date("2026-01-11T00:00:00Z")), -10);
    assert.equal(licenceDaysLeft({ status: "none" }), null);
  });
});

describe("merging across requesters (security review app H2)", () => {
  test("the same person (by account, or by address) is no warning", () => {
    assert.equal(crossRequesterWarning({ number: 1, requester_id: 5, requester_name: "Ann" }, [{ number: 2, requester_id: 5, requester_name: "Ann" }]), null);
    assert.equal(
      crossRequesterWarning({ number: 1, requester_id: null, requester_name: "Ann", requester_email: "ann@x.test" }, [
        { number: 2, requester_id: null, requester_name: "Ann B", requester_email: "ANN@x.test" },
      ]),
      null
    );
  });
  test("different people are named, both of them, with their tickets", () => {
    const w = crossRequesterWarning({ number: 1049, requester_id: 5, requester_name: "Client A", requester_email: "a@a.test" }, [
      { number: 1051, requester_id: null, requester_name: "Client B", requester_email: "b@b.test" },
    ]);
    assert.ok(w);
    assert.deepEqual(w!.requesters.map((r) => [r.name, r.numbers]), [["Client A", [1049]], ["Client B", [1051]]]);
    assert.match(w!.text, /Client A and Client B/);
    assert.match(w!.text, /each will see the other's conversation/);
  });
});

describe("the connector consent token (security review M1)", () => {
  const f = { client_id: "cdc_1", redirect_uri: "https://claude.example/cb", code_challenge: "c".repeat(43) };
  test("works for its session and fields only, and only while fresh", () => {
    const t = consentToken("sess-a", f);
    assert.equal(consentTokenValid(t, "sess-a", f), true);
    assert.equal(consentTokenValid(t, "sess-b", f), false, "another session");
    assert.equal(consentTokenValid(t, "sess-a", { ...f, redirect_uri: "https://evil.example/cb" }), false, "another address");
    assert.equal(consentTokenValid(t, "sess-a", { ...f, code_challenge: "d".repeat(43) }), false, "another challenge");
    assert.equal(consentTokenValid(consentToken("sess-a", f, Date.now() - 20 * 60_000), "sess-a", f), false, "expired");
    assert.equal(consentTokenValid("", "sess-a", f), false);
    assert.equal(consentTokenValid(undefined, "sess-a", f), false);
  });
});

describe("the first-run setup token (security review M11)", () => {
  test("derived from the master key, stable, forgiving of case and dashes, and required", () => {
    const t = setupToken();
    assert.match(t, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
    assert.equal(setupToken(), t, "every call and instance prints the same");
    assert.equal(setupTokenMatches(t), true);
    assert.equal(setupTokenMatches(t.toLowerCase().replace(/-/g, " ")), true);
    assert.equal(setupTokenMatches(t.slice(0, -1) + (t.endsWith("0") ? "1" : "0")), false);
    assert.equal(setupTokenMatches(""), false);
    assert.equal(setupTokenMatches(undefined), false);
  });
  test("COMPASSDOCS_SETUP_TOKEN sets it", () => {
    process.env.COMPASSDOCS_SETUP_TOKEN = "fixed-token-123";
    try {
      assert.equal(setupTokenMatches("FIXED-TOKEN-123"), true);
    } finally {
      delete process.env.COMPASSDOCS_SETUP_TOKEN;
    }
  });
});

describe("passwords (security review M7)", () => {
  test("the minimum is 12 for a new or changed password", () => {
    assert.equal(PASSWORD_MIN, 12);
    assert.ok(passwordProblem("elevenchars"));
    assert.equal(passwordProblem("twelve-chars"), undefined);
    assert.ok(passwordProblem("x".repeat(300)), "a megabyte of text is not hashed");
  });
  test("new hashes are scrypt N=2^17 and marked; old ones still verify and ask to be rehashed", async () => {
    const h = await password.hashPassword("Correct-horse-1");
    assert.match(h.hash, /^s2\$[0-9a-f]{128}$/);
    assert.equal(await password.verifyPassword("Correct-horse-1", h.hash, h.salt), true);
    assert.equal(await password.verifyPassword("wrong-horse-11", h.hash, h.salt), false);
    assert.equal(password.needsRehash(h.hash), false);
    const salt = "00112233445566778899aabbccddeeff";
    const legacy = scryptSync("Old-password-1", salt, 64).toString("hex");
    assert.equal(await password.verifyPassword("Old-password-1", legacy, salt), true);
    assert.equal(await password.verifyPassword("Old-password-2", legacy, salt), false);
    assert.equal(password.needsRehash(legacy), true);
    assert.equal(await password.verifyNothing("anything"), false);
  });
});

describe("the per-identifier sign-in budget (security review H2)", () => {
  test("failures from many addresses slow one name down, after ten, whatever the address", () => {
    const name = `spread-${Date.now()}`;
    for (let i = 0; i < 10; i++) {
      const a = guard.beginLoginAttempt(name, `198.18.${i}.1`);
      assert.equal(a.wait, 0, `attempt ${i + 1} from a new address`);
      assert.equal(a.identLockEngaged, i === 9, "the tenth begins the delays, audited once");
    }
    assert.ok(guard.loginRetryAfter(name, "198.18.200.1") > 0, "an eleventh, from yet another address, waits");
    assert.ok(guard.beginLoginAttempt(name, "198.18.201.1").wait > 0);
  });

  test("an address that signed in as the name is exempt, so the owner is never locked out by someone else", () => {
    const name = `owner-${Date.now()}`;
    const home = "198.19.0.1";
    const ok = guard.beginLoginAttempt(name, home);
    guard.refundLoginAttempt(ok, true); // the owner signs in from home
    for (let i = 0; i < 30; i++) guard.beginLoginAttempt(name, `198.19.1.${i + 1}`); // an attack from elsewhere
    assert.ok(guard.loginRetryAfter(name, "198.19.9.9") > 0, "strangers wait");
    assert.equal(guard.loginRetryAfter(name, home), 0, "home does not");
    assert.equal(guard.beginLoginAttempt(name, home).wait, 0);
  });

  test("an administrator's reset clears it", () => {
    const name = `reset-${Date.now()}`;
    for (let i = 0; i < 12; i++) guard.beginLoginAttempt(name, `198.20.0.${i + 1}`);
    assert.ok(guard.loginRetryAfter(name, "198.20.9.9") > 0);
    guard.clearIdentifierThrottle(name.toUpperCase());
    assert.equal(guard.loginRetryAfter(name, "198.20.9.9"), 0);
  });

  test("an attempt that did not fail gives its identifier count back", () => {
    const name = `refund-${Date.now()}`;
    for (let i = 0; i < 9; i++) guard.beginLoginAttempt(name, `198.21.0.${i + 1}`);
    const tenth = guard.beginLoginAttempt(name, "198.21.1.1");
    assert.equal(tenth.identLockEngaged, true);
    guard.refundLoginAttempt(tenth, false); // the right password, the code to come
    assert.equal(guard.loginRetryAfter(name, "198.21.2.2"), 0, "back to nine: no delay");
  });
});

describe("capped readers (security review app L5, L1)", () => {
  const streamed = (bytes: number) =>
    new Request("http://app.test/x", {
      method: "POST",
      body: new ReadableStream({
        start(c) {
          for (let i = 0; i < bytes; i += 1000) c.enqueue(new Uint8Array(Math.min(1000, bytes - i)).fill(97));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
  test("a request body is read up to its limit and no further, declared or streamed", async () => {
    assert.equal(await readTextCapped(streamed(4000), 5000), "a".repeat(4000));
    assert.equal(await readTextCapped(streamed(6000), 5000), null);
    assert.equal(await readTextCapped(new Request("http://app.test/x", { method: "POST", body: "x".repeat(10), headers: { "content-length": "99999" } }), 50), null);
  });
  test("a response body likewise", async () => {
    const res = (n: number) => new Response(new Uint8Array(n).fill(1));
    assert.equal((await safeFetchMod.readResponseCapped(res(100), 200))?.length, 100);
    assert.equal(await safeFetchMod.readResponseCapped(res(300), 200), null);
  });
});

describe("CSV writers defuse formulas (security review M6, app M3)", () => {
  test("the helpdesk import's writer has lib/csv's defence, quoting only when it must", () => {
    assert.equal(importCsvCell("=1+1"), `'=1+1`);
    assert.equal(importCsvCell("  =cmd"), `'  =cmd`, "after leading spaces (the old guard missed it)");
    assert.equal(importCsvCell("＝1"), `'＝1`, "the full-width form (likewise)");
    assert.equal(importCsvCell("\t@x"), `'\t@x`);
    assert.equal(importCsvCell("a;b"), `"a;b"`, "the semicolon still quotes");
    assert.equal(importCsvCell("plain"), `plain`);
  });
  test("the training matrix", () => {
    const csv = matrixCsv({ decks: [{ id: 1, title: "=HYPERLINK(\"x\")", tag: "" }], people: [{ user_id: 1, name: "@SUM(1)", username: "u", cells: ["+done"] }] } as never);
    assert.ok(!/(^|,)"[=+@-]/m.test(csv), csv);
    assert.match(csv, /"'=HYPERLINK/);
  });
});

describe("the workspace address (security review app H1)", () => {
  test("COMPASSDOCS_BASE_URL is an origin or nothing", () => {
    const was = process.env.COMPASSDOCS_BASE_URL;
    try {
      process.env.COMPASSDOCS_BASE_URL = "https://docs.example.test/some/path";
      assert.equal(envBaseOrigin(), "https://docs.example.test");
      process.env.COMPASSDOCS_BASE_URL = "javascript:alert(1)";
      assert.equal(envBaseOrigin(), null);
      process.env.COMPASSDOCS_BASE_URL = "https://user:pw@docs.example.test";
      assert.equal(envBaseOrigin(), null);
      delete process.env.COMPASSDOCS_BASE_URL;
      assert.equal(envBaseOrigin(), null);
    } finally {
      if (was === undefined) delete process.env.COMPASSDOCS_BASE_URL;
      else process.env.COMPASSDOCS_BASE_URL = was;
    }
  });
});

describe("the uploads half of a backup (security review H5)", () => {
  let root = "";
  let out = "";
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "cd-uploads-"));
    out = await mkdtemp(join(tmpdir(), "cd-restore-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
    delete process.env.COMPASSDOCS_KEY_FILE;
  });

  test("every file comes back byte for byte; the key file, links and scratch files never go in", async () => {
    await writeFile(join(root, "a1b2c3d4e5f60718293a4b5c6d7e8f90.png"), Buffer.from([0, 1, 2, 255]));
    await writeFile(join(root, ".secret.key"), "the master key");
    await writeFile(join(root, "x.dump.tmp"), "scratch");
    await mkdir(join(root, "hd-import", "deep".repeat(40)), { recursive: true });
    const long = join(root, "hd-import", "deep".repeat(40), "f".repeat(90) + ".csv");
    await writeFile(long, "a,b\n1,2\n");
    await writeFile(join(root, "empty.txt"), "");
    await symlink("/etc/passwd", join(root, "link"));
    const tar = join(out, "files.tar");
    const r = await backupFiles.writeFilesArchive(tar, { root });
    assert.equal(r.files, 3, "the png, the long-named csv and the empty file");
    const raw = await readFile(tar);
    assert.ok(!raw.includes(Buffer.from("the master key")), "the key file is never archived");
    assert.ok(!raw.includes(Buffer.from("scratch")));

    const dest = join(out, "restored");
    await writeFile(join(out, "keep-me"), "");
    await mkdir(dest);
    await writeFile(join(dest, ".secret.key"), "the NEW host's key");
    await writeFile(join(dest, "added-after.txt"), "kept");
    const x = await backupFiles.extractFilesArchive(tar, { root: dest });
    assert.equal(x.files, 3);
    assert.deepEqual(await readFile(join(dest, "a1b2c3d4e5f60718293a4b5c6d7e8f90.png")), Buffer.from([0, 1, 2, 255]));
    assert.equal(await readFile(join(dest, "hd-import", "deep".repeat(40), "f".repeat(90) + ".csv"), "utf8"), "a,b\n1,2\n");
    assert.equal(await readFile(join(dest, ".secret.key"), "utf8"), "the NEW host's key", "never overwritten");
    assert.equal(await readFile(join(dest, "added-after.txt"), "utf8"), "kept", "files added since stay");
    assert.ok(!(await readdir(dest)).includes("link"));
  });

  test("a path that would leave the uploads directory is refused", () => {
    assert.equal(backupFiles.safeArchivePath("../etc/passwd"), null);
    assert.equal(backupFiles.safeArchivePath("/etc/passwd"), null);
    assert.equal(backupFiles.safeArchivePath("a/../../b"), null);
    assert.equal(backupFiles.safeArchivePath("C:/x"), null);
    assert.equal(backupFiles.safeArchivePath("ok/file.png"), "ok/file.png");
  });
});

describe("safeFetch pins the address it checked (security review app L1)", () => {
  let server: Server;
  let port = 0;
  // An address of this machine that the guard allows (not loopback); skipped when there is none.
  const local = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === "IPv4" && !a.internal && !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)/.test(a.address))?.address;
  before(async () => {
    server = createServer((rq, rs) => {
      rs.writeHead(200, { "content-type": "text/plain" });
      rs.end(`hello ${rq.headers.host}`);
    });
    await new Promise<void>((r) => server.listen(0, "0.0.0.0", () => r()));
    port = (server.address() as { port: number }).port;
  });
  after(async () => {
    safeFetchMod.setSafeFetchResolverForTests(null);
    await new Promise<void>((r) => server.close(() => r()));
  });

  test("a name the system cannot resolve still reaches the address the check resolved (no second lookup)", { skip: !local }, async () => {
    safeFetchMod.setSafeFetchResolverForTests(async () => [{ address: local!, family: 4 }]);
    const res = await safeFetchMod.safeFetch(`http://rebind.compassdocs-test.invalid:${port}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /hello rebind\.compassdocs-test\.invalid/);
  });

  test("a blocked address is refused without saying which address the name resolved to", async () => {
    safeFetchMod.setSafeFetchResolverForTests(async () => [{ address: "10.1.2.3", family: 4 }]);
    await assert.rejects(safeFetchMod.safeFetch("http://internal.example.test/"), (e: Error) => {
      assert.ok(!e.message.includes("10.1.2.3"), e.message);
      return true;
    });
  });
});

describe("HSTS (security review, Low)", () => {
  test("at least 182 days, and no includeSubDomains", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require("../next.config.js");
    const rules = await cfg.headers();
    const hsts = rules.flatMap((r: { headers: { key: string; value: string }[] }) => r.headers).find((h: { key: string }) => h.key === "Strict-Transport-Security");
    assert.ok(hsts, "sent");
    const age = Number(/max-age=(\d+)/.exec(hsts.value)?.[1]);
    assert.ok(age >= 15_724_800, hsts.value);
    assert.ok(!/includeSubDomains/i.test(hsts.value));
  });
});
