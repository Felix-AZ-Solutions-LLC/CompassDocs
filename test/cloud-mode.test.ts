// Cloud mode (1.21.0, lib/cloud): the switch, the encryption-key rules
// (lib/secretbox), the secrets the environment supplies (lib/cloud
// ENV_SECRETS, lib/db-url, lib/license, lib/smtp-config), the JSON log
// lines and their redaction (lib/log, start.cjs) and the app's half of a
// graceful shutdown (lib/shutdown). No database: every check here is a pure
// function or works on a temporary folder.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/cloud-mode.test.ts

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLOUD_AREAS,
  CLOUD_HIDDEN_SECTIONS,
  ENV_SECRETS,
  cloudRefusalMessage,
  cloudStartupProblems,
  envSmtp,
  isCloud,
  jsonLogging,
  platformValue,
  sectionHiddenInMode,
  validKeyMaterial,
} from "../src/lib/cloud";
import { separateDatabasePassword, withDatabasePassword } from "../src/lib/db-url";
import { SETTINGS_SECTIONS } from "../src/lib/settings-sections";

const HEX_KEY = "ab".repeat(32);
const B64_KEY = Buffer.alloc(32, 7).toString("base64");

/** Run `fn` with these variables set (undefined = unset), then put the environment back. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const out = fn();
    if (out instanceof Promise) return out.finally(restore) as T;
    restore();
    return out;
  } catch (e) {
    restore();
    throw e;
  }
}

describe("the cloud gate", () => {
  test("COMPASSDOCS_CLOUD=1 (or true / yes) is cloud mode; unset, 0 or anything else is self-hosted", () => {
    for (const v of ["1", "true", "TRUE", " yes "]) assert.equal(isCloud({ COMPASSDOCS_CLOUD: v }), true, v);
    for (const v of [undefined, "", "0", "false", "no", "cloud"]) assert.equal(isCloud({ COMPASSDOCS_CLOUD: v }), false, String(v));
  });

  test("it is read on every call, not once at load", () => {
    withEnv({ COMPASSDOCS_CLOUD: "1" }, () => assert.equal(isCloud(), true));
    withEnv({ COMPASSDOCS_CLOUD: undefined }, () => assert.equal(isCloud(), false));
  });

  test("the hidden settings sections are Domain & HTTPS and Backups, and both exist in the registry", () => {
    assert.deepEqual([...CLOUD_HIDDEN_SECTIONS].sort(), ["/admin/backups", "/admin/domain"]);
    for (const href of CLOUD_HIDDEN_SECTIONS) assert.ok(SETTINGS_SECTIONS.some((s) => s.href === href), href);
    assert.equal(sectionHiddenInMode("/admin/domain", { COMPASSDOCS_CLOUD: "1" }), true);
    assert.equal(sectionHiddenInMode("/admin/backups", { COMPASSDOCS_CLOUD: "1" }), true);
    assert.equal(sectionHiddenInMode("/admin/domain", {}), false, "self-hosted hides nothing");
    assert.equal(sectionHiddenInMode("/admin", { COMPASSDOCS_CLOUD: "1" }), false, "System stays (its update card gives way to a note)");
    assert.equal(sectionHiddenInMode("/admin/license", { COMPASSDOCS_CLOUD: "1" }), false);
  });

  test("every refusal is one plain sentence naming the area", () => {
    for (const area of Object.keys(CLOUD_AREAS) as (keyof typeof CLOUD_AREAS)[]) {
      const m = cloudRefusalMessage(area);
      assert.match(m, /is managed by CompassDocs Cloud, so it can't be changed here\.$/);
      assert.ok(m.startsWith(CLOUD_AREAS[area].label));
    }
  });
});

describe("start-up checks", () => {
  test("self-hosted: nothing to check", () => {
    assert.deepEqual(cloudStartupProblems({ DATABASE_URL: "" }), { fatal: [], warnings: [] });
  });

  test("cloud mode refuses to start without COMPASSDOCS_SECRET_KEY, saying so", () => {
    const r = cloudStartupProblems({ COMPASSDOCS_CLOUD: "1", DATABASE_URL: "postgres://x@db/app", COMPASSDOCS_BASE_URL: "https://acme.compassdocs.io" });
    assert.equal(r.fatal.length, 1);
    assert.match(r.fatal[0], /COMPASSDOCS_SECRET_KEY is not set\. Cloud mode never creates or reads a key file/);
  });

  test("...and with a key that isn't 32 bytes", () => {
    for (const bad of ["abc", "ab".repeat(31), Buffer.alloc(16).toString("base64")]) {
      const r = cloudStartupProblems({ COMPASSDOCS_CLOUD: "1", DATABASE_URL: "postgres://x@db/app", COMPASSDOCS_SECRET_KEY: bad, COMPASSDOCS_BASE_URL: "https://a.example" });
      assert.deepEqual(r.fatal, ["COMPASSDOCS_SECRET_KEY must be 32 bytes, as 64 hex or 44 base64 characters."], bad);
    }
  });

  test("a valid hex or base64 key, a database and an https address: no problems", () => {
    for (const key of [HEX_KEY, B64_KEY]) {
      assert.equal(validKeyMaterial(key), true);
      assert.deepEqual(
        cloudStartupProblems({ COMPASSDOCS_CLOUD: "1", DATABASE_URL: "postgres://x@db/app", COMPASSDOCS_SECRET_KEY: key, COMPASSDOCS_BASE_URL: "https://acme.compassdocs.io" }),
        { fatal: [], warnings: [] }
      );
    }
  });

  test("no DATABASE_URL is fatal", () => {
    const base = { COMPASSDOCS_CLOUD: "1", COMPASSDOCS_SECRET_KEY: HEX_KEY };
    assert.deepEqual(cloudStartupProblems({ ...base, COMPASSDOCS_BASE_URL: "https://a.example" }).fatal, ["DATABASE_URL is not set."]);
  });

  test("a COMPASSDOCS_BASE_URL that isn't https:// is fatal; only a loopback http address warns", () => {
    const base = { COMPASSDOCS_CLOUD: "1", COMPASSDOCS_SECRET_KEY: HEX_KEY, DATABASE_URL: "postgres://x@db/app" };
    for (const url of ["http://acme.compassdocs.io", "http://10.0.0.4:3000", "ftp://acme.compassdocs.io"]) {
      const r = cloudStartupProblems({ ...base, COMPASSDOCS_BASE_URL: url });
      assert.equal(r.fatal.length, 1, url);
      assert.match(r.fatal[0], /^COMPASSDOCS_BASE_URL must be an https:\/\/ address/, url);
    }
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3998", "http://[::1]:3000"]) {
      const r = cloudStartupProblems({ ...base, COMPASSDOCS_BASE_URL: url });
      assert.deepEqual(r.fatal, [], url);
      assert.match(r.warnings[0], /plain-http loopback address/, url);
    }
  });

  test("no COMPASSDOCS_BASE_URL (or a blank or invalid one) is fatal in cloud mode, saying why", () => {
    const base = { COMPASSDOCS_CLOUD: "1", COMPASSDOCS_SECRET_KEY: HEX_KEY, DATABASE_URL: "postgres://x@db/app" };
    for (const url of [undefined, "", "   "]) {
      const r = cloudStartupProblems({ ...base, COMPASSDOCS_BASE_URL: url });
      assert.equal(r.fatal.length, 1, String(url));
      assert.match(r.fatal[0], /^COMPASSDOCS_BASE_URL is not set\. Cloud mode builds every link in email and every sign-in redirect from it/);
      assert.deepEqual(r.warnings, []);
    }
    assert.deepEqual(cloudStartupProblems({ ...base, COMPASSDOCS_BASE_URL: "acme.compassdocs.io" }).fatal, [
      "COMPASSDOCS_BASE_URL is not a valid URL: set it to the workspace's public address, e.g. https://acme.compassdocs.io.",
    ]);
  });

  test("self-hosted: no COMPASSDOCS_BASE_URL is still fine", () => {
    assert.deepEqual(cloudStartupProblems({ DATABASE_URL: "postgres://x@db/app", COMPASSDOCS_SECRET_KEY: HEX_KEY }), { fatal: [], warnings: [] });
    assert.deepEqual(cloudStartupProblems({ COMPASSDOCS_CLOUD: "0", DATABASE_URL: "postgres://x@db/app" }), { fatal: [], warnings: [] });
  });
});

describe("cloud mode refuses to start (lib/shutdown checkCloudStartup)", () => {
  test("without the key: one error line naming it, then exit 1", async () => {
    const { checkCloudStartup } = await import("../src/lib/shutdown");
    const lines: [string, string, Record<string, unknown>][] = [];
    let code: number | null = null;
    const ok = await withEnv({ COMPASSDOCS_CLOUD: "1", COMPASSDOCS_SECRET_KEY: undefined, DATABASE_URL: "postgres://x@db/a", COMPASSDOCS_BASE_URL: "https://a.example" }, () =>
      checkCloudStartup((l, e, f) => void lines.push([l, e, f]), (c) => void (code = c))
    );
    assert.equal(ok, false);
    assert.equal(code, 1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0][0], "error");
    assert.equal(lines[0][1], "cloud.refused_to_start");
    assert.match(String(lines[0][2].message), /^Cloud mode \(COMPASSDOCS_CLOUD=1\) can't start: COMPASSDOCS_SECRET_KEY is not set\./);
  });

  test("without COMPASSDOCS_BASE_URL: one error line naming it, then exit 1", async () => {
    const { checkCloudStartup } = await import("../src/lib/shutdown");
    const lines: [string, string, Record<string, unknown>][] = [];
    let code: number | null = null;
    const ok = await withEnv({ COMPASSDOCS_CLOUD: "1", COMPASSDOCS_SECRET_KEY: HEX_KEY, DATABASE_URL: "postgres://x@db/a", COMPASSDOCS_BASE_URL: undefined }, () =>
      checkCloudStartup((l, e, f) => void lines.push([l, e, f]), (c) => void (code = c))
    );
    assert.equal(ok, false);
    assert.equal(code, 1);
    assert.equal(lines.length, 1);
    assert.deepEqual([lines[0][0], lines[0][1]], ["error", "cloud.refused_to_start"]);
    assert.match(String(lines[0][2].message), /^Cloud mode \(COMPASSDOCS_CLOUD=1\) can't start: COMPASSDOCS_BASE_URL is not set\./);
  });

  test("with it: starts, and says it runs in cloud mode", async () => {
    const { checkCloudStartup } = await import("../src/lib/shutdown");
    const lines: string[] = [];
    let code: number | null = null;
    const ok = await withEnv({ COMPASSDOCS_CLOUD: "1", COMPASSDOCS_SECRET_KEY: HEX_KEY, DATABASE_URL: "postgres://x@db/a", COMPASSDOCS_BASE_URL: "https://a.example" }, () =>
      checkCloudStartup((_l, e) => void lines.push(e), (c) => void (code = c))
    );
    assert.equal(ok, true);
    assert.equal(code, null);
    assert.deepEqual(lines, ["cloud.mode"]);
  });
});

describe("the encryption key (lib/secretbox)", () => {
  let dir = "";
  // Loaded per test after the environment is set: the key is cached per process.
  const box = () => require("../src/lib/secretbox") as typeof import("../src/lib/secretbox"); // eslint-disable-line @typescript-eslint/no-require-imports

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cloud-key-"));
    box().resetMasterKeyForTests();
  });
  afterEach(() => {
    box().resetMasterKeyForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  const keyFile = () => join(dir, ".secret.key");

  test("cloud mode without the variable: a clear error, and no key file is written", () => {
    withEnv({ COMPASSDOCS_CLOUD: "1", COMPASSDOCS_SECRET_KEY: undefined, COMPASSDOCS_KEY_FILE: undefined, COMPASSDOCS_UPLOAD_DIR: dir }, () => {
      assert.throws(() => box().getMasterKey(), (e: unknown) => e instanceof box().MasterKeyError && /COMPASSDOCS_SECRET_KEY is not set\. In cloud mode/.test((e as Error).message));
      assert.equal(existsSync(keyFile()), false, "never generated");
      assert.throws(() => box().sealSecret("hunter2"), box().MasterKeyError, "nothing is sealed without it");
    });
  });

  test("cloud mode never reads a key file from the uploads folder, even a valid one", () => {
    writeFileSync(keyFile(), HEX_KEY + "\n");
    withEnv({ COMPASSDOCS_CLOUD: "1", COMPASSDOCS_SECRET_KEY: undefined, COMPASSDOCS_KEY_FILE: undefined, COMPASSDOCS_UPLOAD_DIR: dir }, () => {
      assert.throws(() => box().getMasterKey(), box().MasterKeyError);
    });
    withEnv({ COMPASSDOCS_CLOUD: "1", COMPASSDOCS_SECRET_KEY: undefined, COMPASSDOCS_KEY_FILE: keyFile(), COMPASSDOCS_UPLOAD_DIR: dir }, () => {
      assert.throws(() => box().getMasterKey(), box().MasterKeyError, "nor one named by COMPASSDOCS_KEY_FILE");
    });
  });

  test("cloud mode with the variable: that key, and the file beside it is ignored", () => {
    writeFileSync(keyFile(), "cd".repeat(32) + "\n");
    withEnv({ COMPASSDOCS_CLOUD: "1", COMPASSDOCS_SECRET_KEY: HEX_KEY, COMPASSDOCS_KEY_FILE: undefined, COMPASSDOCS_UPLOAD_DIR: dir }, () => {
      assert.equal(box().getMasterKey().toString("hex"), HEX_KEY);
      assert.equal(box().masterKeySource(), "env");
      const sealed = box().sealSecret("hunter2");
      assert.ok(sealed.startsWith("enc:v1:"));
      assert.equal(box().openSecret(sealed), "hunter2");
    });
  });

  test("self-hosted is unchanged: no variable creates the key file once (0600), then reads it", () => {
    withEnv({ COMPASSDOCS_CLOUD: undefined, COMPASSDOCS_SECRET_KEY: undefined, COMPASSDOCS_KEY_FILE: undefined, COMPASSDOCS_UPLOAD_DIR: dir }, () => {
      const k = box().getMasterKey();
      assert.equal(box().masterKeySource(), "file");
      assert.equal(readFileSync(keyFile(), "utf8").trim(), k.toString("hex"));
      box().resetMasterKeyForTests();
      assert.equal(box().getMasterKey().toString("hex"), k.toString("hex"), "read back, not regenerated");
    });
  });

  test("self-hosted moving to the variable: set it to the file's key and old values still open", () => {
    let sealed = "";
    withEnv({ COMPASSDOCS_CLOUD: undefined, COMPASSDOCS_SECRET_KEY: undefined, COMPASSDOCS_KEY_FILE: undefined, COMPASSDOCS_UPLOAD_DIR: dir }, () => {
      sealed = box().sealSecret("smtp-password");
    });
    const fileKey = readFileSync(keyFile(), "utf8").trim();
    box().resetMasterKeyForTests();
    withEnv({ COMPASSDOCS_CLOUD: undefined, COMPASSDOCS_SECRET_KEY: fileKey, COMPASSDOCS_UPLOAD_DIR: dir }, () => {
      assert.equal(box().masterKeySource(), "env");
      assert.equal(box().openSecret(sealed), "smtp-password");
    });
  });

  test("self-hosted: a variable that differs from the key file refuses to start, saying which to keep; nothing changes", async () => {
    // Something sealed with the file's key, as an install that never used the variable.
    let sealedByFile = "";
    writeFileSync(keyFile(), "cd".repeat(32) + "\n");
    withEnv({ COMPASSDOCS_CLOUD: undefined, COMPASSDOCS_SECRET_KEY: undefined, COMPASSDOCS_KEY_FILE: undefined, COMPASSDOCS_UPLOAD_DIR: dir }, () => {
      sealedByFile = box().sealSecret("smtp-password");
    });
    box().resetMasterKeyForTests();
    await withEnv({ COMPASSDOCS_CLOUD: undefined, COMPASSDOCS_SECRET_KEY: HEX_KEY, COMPASSDOCS_KEY_FILE: undefined, COMPASSDOCS_UPLOAD_DIR: dir }, async () => {
      const conflict = String(box().masterKeyConflict(sealedByFile));
      assert.match(conflict, /^COMPASSDOCS_SECRET_KEY is set, but the key file .*\.secret\.key holds a different key, so CompassDocs won't start\./);
      assert.match(conflict, /open only with the file's key\. To keep the file's key, remove COMPASSDOCS_SECRET_KEY/);
      assert.ok(!conflict.includes(HEX_KEY) && !conflict.includes("cd".repeat(32)), "no key in the line");
      assert.match(String(box().masterKeyConflict(null)), /Nothing is encrypted in the database yet, so either key is safe/);
      assert.match(String(box().masterKeyConflict()), /Keep the one this install.s credentials were encrypted with, usually the file.s/);
      const lines: [string, string][] = [];
      let code: number | null = null;
      assert.equal(await box().checkSelfHostedKey((l, e) => void lines.push([l, e]), (c) => void (code = c), async () => sealedByFile), false);
      assert.deepEqual([lines, code], [[["error", "secret_key.conflict"]], 1]);
      assert.equal(readFileSync(keyFile(), "utf8").trim(), "cd".repeat(32), "the file is untouched");
    });
  });

  test("self-hosted: an install already running on the variable (an old key file left behind) starts as before, with a warning", async () => {
    let sealedByEnv = "";
    writeFileSync(keyFile(), "cd".repeat(32) + "\n");
    await withEnv({ COMPASSDOCS_CLOUD: undefined, COMPASSDOCS_SECRET_KEY: HEX_KEY, COMPASSDOCS_KEY_FILE: undefined, COMPASSDOCS_UPLOAD_DIR: dir }, async () => {
      const lines: [string, string][] = [];
      let code: number | null = null;
      // As 1.20.x sealed it with the variable (the file was not read then).
      const { createCipheriv, randomBytes } = await import("node:crypto");
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", Buffer.from(HEX_KEY, "hex"), iv);
      const ct = Buffer.concat([c.update("smtp-password", "utf8"), c.final()]);
      sealedByEnv = "enc:v1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
      assert.equal(box().masterKeyConflict(sealedByEnv), null);
      assert.equal(await box().checkSelfHostedKey((l, e) => void lines.push([l, e]), (x) => void (code = x), async () => sealedByEnv), true);
      assert.deepEqual([lines, code], [[["warn", "secret_key.file_unused"]], null]);
      assert.equal(box().openSecret(sealedByEnv), "smtp-password", "the variable's key, as before");
    });
  });

  test("self-hosted: the same key in both, or no file, is no conflict", async () => {
    await withEnv({ COMPASSDOCS_CLOUD: undefined, COMPASSDOCS_SECRET_KEY: HEX_KEY, COMPASSDOCS_KEY_FILE: undefined, COMPASSDOCS_UPLOAD_DIR: dir }, async () => {
      assert.equal(box().masterKeyConflict(), null, "no file");
      writeFileSync(keyFile(), HEX_KEY + "\n");
      assert.equal(box().masterKeyConflict(), null, "the same key");
      let code: number | null = null;
      assert.equal(await box().checkSelfHostedKey(() => {}, (c) => void (code = c)), true);
      assert.equal(code, null);
      assert.equal(box().getMasterKey().toString("hex"), HEX_KEY);
    });
    await withEnv({ COMPASSDOCS_CLOUD: "1", COMPASSDOCS_SECRET_KEY: HEX_KEY, COMPASSDOCS_UPLOAD_DIR: dir }, async () => {
      writeFileSync(keyFile(), "cd".repeat(32) + "\n");
      assert.equal(box().masterKeyConflict(), null, "cloud mode never reads the file");
    });
  });

  test("self-hosted: no key file and no variable, but sealed data in the database: no new key file is written", () => {
    withEnv({ COMPASSDOCS_CLOUD: undefined, COMPASSDOCS_SECRET_KEY: undefined, COMPASSDOCS_KEY_FILE: undefined, COMPASSDOCS_UPLOAD_DIR: dir }, () => {
      box().noteSealedData(true);
      assert.throws(() => box().getMasterKey(), (e: unknown) => e instanceof box().MasterKeyError && /is missing and COMPASSDOCS_SECRET_KEY is not set, but the database already holds credentials/.test((e as Error).message));
      assert.equal(existsSync(keyFile()), false, "none written");
      box().noteSealedData(false);
      box().getMasterKey();
      assert.equal(existsSync(keyFile()), true, "a fresh install still gets its key file");
    });
  });
});

describe("the database pool after a shutdown (lib/db)", () => {
  test("closePool: a later pool() throws instead of quietly making a new pool", async () => {
    await withEnv({ DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" }, async () => {
      const db = await import("../src/lib/db");
      await db.closePool();
      assert.throws(() => db.pool(), /The database pool is closed: the server is shutting down\./);
      db.reopenPoolForTests();
      const p = db.pool();
      assert.ok(p);
      await db.closePool();
      db.reopenPoolForTests();
    });
  });
});

describe("secrets from the environment", () => {
  test("the inventory names every secret once, with a kind", () => {
    const names = ENV_SECRETS.map((s) => s.env);
    assert.equal(new Set(names).size, names.length);
    for (const want of ["COMPASSDOCS_SECRET_KEY", "DATABASE_URL", "DATABASE_PASSWORD", "COMPASSDOCS_LICENSE_KEY", "ANTHROPIC_API_KEY", "COMPASSDOCS_SMTP_PASSWORD"]) {
      assert.ok(names.includes(want), want);
    }
    assert.deepEqual(ENV_SECRETS.filter((s) => s.kind === "required").map((s) => s.env), ["COMPASSDOCS_SECRET_KEY", "DATABASE_URL"]);
    for (const s of ENV_SECRETS.filter((s) => s.kind === "platform")) assert.ok(s.setting && s.where, `${s.env} names the setting it overrides`);
  });

  test("a platform value counts only in cloud mode, and only when set", () => {
    assert.equal(platformValue("COMPASSDOCS_LICENSE_KEY", { COMPASSDOCS_CLOUD: "1", COMPASSDOCS_LICENSE_KEY: " lic " }), "lic");
    assert.equal(platformValue("COMPASSDOCS_LICENSE_KEY", { COMPASSDOCS_CLOUD: "1", COMPASSDOCS_LICENSE_KEY: " " }), null);
    assert.equal(platformValue("COMPASSDOCS_LICENSE_KEY", { COMPASSDOCS_LICENSE_KEY: "lic" }), null, "self-hosted: the saved key keeps winning");
  });

  test("the license in force: the platform's in cloud mode, else the saved one, else the variable (as before)", async () => {
    const { effectiveLicenseKey } = await import("../src/lib/license");
    withEnv({ COMPASSDOCS_CLOUD: "1", COMPASSDOCS_LICENSE_KEY: "platform-key" }, () => assert.equal(effectiveLicenseKey("saved-key"), "platform-key"));
    withEnv({ COMPASSDOCS_CLOUD: "1", COMPASSDOCS_LICENSE_KEY: undefined }, () => assert.equal(effectiveLicenseKey("saved-key"), "saved-key"));
    withEnv({ COMPASSDOCS_CLOUD: undefined, COMPASSDOCS_LICENSE_KEY: "env-key" }, () => {
      assert.equal(effectiveLicenseKey("saved-key"), "saved-key");
      assert.equal(effectiveLicenseKey(""), "env-key");
      assert.equal(effectiveLicenseKey(undefined), "env-key");
    });
  });

  test("SMTP from the platform: cloud mode with COMPASSDOCS_SMTP_HOST, with defaults; never self-hosted", () => {
    const env = {
      COMPASSDOCS_CLOUD: "1",
      COMPASSDOCS_SMTP_HOST: "smtp.azurecomm.net",
      COMPASSDOCS_SMTP_USER: "relay",
      COMPASSDOCS_SMTP_PASSWORD: "s3cret",
      COMPASSDOCS_SMTP_FROM: "CompassDocs <no-reply@acme.compassdocs.io>",
    };
    assert.deepEqual(envSmtp(env), { host: "smtp.azurecomm.net", port: 587, secure: "starttls", user: "relay", pass: "s3cret", from: "CompassDocs <no-reply@acme.compassdocs.io>" });
    assert.deepEqual(envSmtp({ ...env, COMPASSDOCS_SMTP_PORT: "465", COMPASSDOCS_SMTP_SECURE: "TLS" })?.secure, "tls");
    assert.equal(envSmtp({ ...env, COMPASSDOCS_SMTP_HOST: "" }), null);
    assert.equal(envSmtp({ ...env, COMPASSDOCS_CLOUD: undefined }), null, "self-hosted reads the saved settings only");
  });

  test("DATABASE_PASSWORD becomes the URL's password; unset, the URL is untouched", () => {
    assert.equal(withDatabasePassword("postgres://app@db.example:5432/compass?sslmode=require", {}), "postgres://app@db.example:5432/compass?sslmode=require");
    assert.equal(
      withDatabasePassword("postgres://app@db.example:5432/compass?sslmode=require", { DATABASE_PASSWORD: "p@ss:w/rd" }),
      "postgres://app:p%40ss%3Aw%2Frd@db.example:5432/compass?sslmode=require"
    );
    assert.equal(withDatabasePassword("postgres://app:old@db/c", { DATABASE_PASSWORD: "new" }), "postgres://app:new@db/c", "it replaces one in the URL");
    assert.equal(separateDatabasePassword("host=db user=app dbname=c", { DATABASE_PASSWORD: "pw" }), "pw", "a key=value DSN gets it beside");
    assert.equal(separateDatabasePassword("postgres://app@db/c", { DATABASE_PASSWORD: "pw" }), undefined);
  });
});

describe("structured logs (lib/log)", () => {
  test("JSON in cloud mode or with COMPASSDOCS_LOG_FORMAT=json; readable by default; text wins over cloud", () => {
    assert.equal(jsonLogging({}), false);
    assert.equal(jsonLogging({ COMPASSDOCS_LOG_FORMAT: "json" }), true);
    assert.equal(jsonLogging({ COMPASSDOCS_CLOUD: "1" }), true);
    assert.equal(jsonLogging({ COMPASSDOCS_CLOUD: "1", COMPASSDOCS_LOG_FORMAT: "text" }), false);
  });

  test("one object per line: time, level, message, event, request id, fields; ts kept for older parsers", async () => {
    const { jsonLine } = await import("../src/lib/log");
    const now = new Date("2026-11-26T10:00:00.000Z");
    const line = jsonLine("warn", "two\nlines", { reason: "x" }, { event: "readyz", requestId: "req-12345678", now, env: {} });
    assert.ok(!line.includes("\n"));
    const o = JSON.parse(line);
    assert.deepEqual(Object.keys(o).slice(0, 5), ["time", "level", "message", "event", "request_id"]);
    assert.deepEqual(o, { time: now.toISOString(), level: "warn", message: "two\nlines", event: "readyz", request_id: "req-12345678", reason: "x", ts: now.toISOString() });
  });

  test("never secrets: the secret variables' values, URL passwords, bearer tokens, API keys and secret-named fields", async () => {
    const { jsonLine, redact } = await import("../src/lib/log");
    const env = { COMPASSDOCS_SECRET_KEY: HEX_KEY, COMPASSDOCS_SMTP_PASSWORD: "relay-pass-123", DATABASE_PASSWORD: "db-pass-456" };
    const text = redact(
      `key ${HEX_KEY} smtp relay-pass-123 db db-pass-456 url postgres://app:hunter22@db/c auth Bearer abcdefghijklmnop key sk-ant-api03-abcdefghijkl`,
      env
    );
    for (const secret of [HEX_KEY, "relay-pass-123", "db-pass-456", "hunter22", "abcdefghijklmnop", "sk-ant-api03"]) assert.ok(!text.includes(secret), secret);
    assert.match(text, /postgres:\/\/app:\[redacted\]@db\/c/);
    const o = JSON.parse(jsonLine("info", "saved", { password: "x", api_key: "y", token: "z", user: "ann", nested: { client_secret: "q" }, ok: true }, { env, requestId: "r" }));
    assert.deepEqual([o.password, o.api_key, o.token, o.nested.client_secret], ["[redacted]", "[redacted]", "[redacted]", "[redacted]"]);
    assert.equal(o.user, "ann");
    assert.equal(o.ok, true);
  });

  test("a secret written inside a logged object (util.inspect, JSON) is masked too", async () => {
    const { redact } = await import("../src/lib/log");
    const { inspect, format } = await import("node:util");
    const secret = `it's "q"\\x\nend`;
    const env = { COMPASSDOCS_SMTP_PASSWORD: secret };
    for (const shown of [format("%s", secret), inspect({ pass: secret }), format("%o", { cfg: { pass: secret } }), JSON.stringify({ p: secret })]) {
      const out = redact(shown, env);
      assert.ok(out.includes("[redacted]"), shown);
      assert.doesNotMatch(out, /it|end/, `${shown} → ${out}`);
    }
  });

  test("cloud mode with COMPASSDOCS_LOG_FORMAT=text: readable lines, still redacted", async () => {
    const { logEvent } = await import("../src/lib/log");
    const lines: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      withEnv({ COMPASSDOCS_CLOUD: "1", COMPASSDOCS_LOG_FORMAT: "text", COMPASSDOCS_SMTP_PASSWORD: "relay-pass-123" }, () => {
        logEvent("warn", "mail", { message: "login failed with relay-pass-123", password: "hunter22", user: "ann" });
      });
      withEnv({ COMPASSDOCS_CLOUD: undefined, COMPASSDOCS_LOG_FORMAT: "text" }, () => logEvent("warn", "mail", { password: "as-before" }));
    } finally {
      console.warn = orig;
    }
    assert.equal(lines[0], "[mail] message=login failed with [redacted] password=[redacted] user=ann");
    assert.equal(lines[1], "[mail] password=as-before", "self-hosted readable lines are as they were");
  });

  test("the setup token in JSON lines: its own field, never the message", async () => {
    const { jsonLine } = await import("../src/lib/log");
    const o = JSON.parse(jsonLine("warn", "open /setup and enter the setup token in this line's setup_token field.", { setup_token: "tok-abc-123456" }, { env: {}, requestId: "r", reveal: ["setup_token"] }));
    assert.equal(o.setup_token, "tok-abc-123456");
    assert.ok(!o.message.includes("tok-abc"));
    const hidden = JSON.parse(jsonLine("warn", "m", { setup_token: "tok-abc-123456" }, { env: {}, requestId: "r" }));
    assert.equal(hidden.setup_token, "[redacted]", "only a field named in reveal is shown");
  });

  test("request ids: a failed load of Next's store is tried again later, not given up for good", async () => {
    const { currentRequestId, setRequestStoreForTests } = await import("../src/lib/log");
    let throwOnce = true;
    const store = {
      getStore: () => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("boom");
        }
        return { type: "request", headers: { get: (n: string) => (n === "x-request-id" ? "req-abc" : null) } };
      },
    };
    try {
      setRequestStoreForTests(store);
      assert.equal(currentRequestId(), undefined, "this line loses its id");
      assert.equal(currentRequestId(), "req-abc", "the next one has it again");
      setRequestStoreForTests(null, Date.now() + 60_000);
      assert.equal(currentRequestId(), undefined, "a failed load waits a minute");
    } finally {
      setRequestStoreForTests(null, 0);
    }
  });

  test("a tagged console line keeps its tag as the event", async () => {
    const { splitTag } = await import("../src/lib/log");
    assert.deepEqual(splitTag("[backup] scheduler error: boom"), { event: "backup", message: "scheduler error: boom" });
    assert.deepEqual(splitTag("plain"), { message: "plain" });
  });

  test("start.cjs: Next's start-up lines as JSON before the app loads, colours and URL passwords out", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const entry = require("../scripts/start.cjs") as { earlyJsonLine: (l: string, t: string, n?: Date) => string; shutdownTimeoutMs: (e: object) => number; jsonLogging: (e: object) => boolean };
    const o = JSON.parse(entry.earlyJsonLine("info", "\u001b[32m✓\u001b[39m Ready in 80ms postgres://u:pw@h/d", new Date(0)));
    assert.equal(o.message, "✓ Ready in 80ms postgres://u:[redacted]@h/d");
    assert.equal(o.level, "info");
    assert.equal(o.time, new Date(0).toISOString());
    assert.equal(entry.shutdownTimeoutMs({}), 25_000);
    assert.equal(entry.shutdownTimeoutMs({ COMPASSDOCS_SHUTDOWN_TIMEOUT: "10" }), 10_000);
    assert.equal(entry.shutdownTimeoutMs({ COMPASSDOCS_SHUTDOWN_TIMEOUT: "0" }), 25_000);
    assert.equal(entry.jsonLogging({ COMPASSDOCS_CLOUD: "1" }), jsonLogging({ COMPASSDOCS_CLOUD: "1" }), "same rule as lib/cloud");
    const silenced = (entry as unknown as { warningsSilenced: (e: object, a: string[]) => boolean }).warningsSilenced;
    assert.equal(silenced({}, []), false);
    assert.equal(silenced({}, ["--no-warnings"]), true);
    assert.equal(silenced({ NODE_OPTIONS: "--max-old-space-size=512 --no-warnings" }, []), true);
    assert.equal(silenced({ NODE_NO_WARNINGS: "1" }, []), true);
  });
});

describe("start.cjs on SIGTERM, with a stand-in for Next's server.js", () => {
  // A real `node start.cjs` process: COMPASSDOCS_SERVER_JS points at a
  // server.js that listens on a free port and says "listening".
  async function run(serverJs: string, wait = "listening"): Promise<{ code: number | null; ms: number; out: string }> {
    const { spawn } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "startcjs-"));
    const file = join(dir, "server.js");
    writeFileSync(file, serverJs);
    const child = spawn(process.execPath, [join(__dirname, "..", "scripts", "start.cjs")], {
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "production", COMPASSDOCS_SERVER_JS: file, COMPASSDOCS_LOG_FORMAT: "text" } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c));
    child.stderr.on("data", (c: Buffer) => (out += c));
    try {
      const until = Date.now() + 10_000;
      while (!out.includes(wait) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      assert.ok(out.includes(wait), out);
      const t0 = Date.now();
      const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
      child.kill("SIGTERM");
      const code = await Promise.race([exited, new Promise<number | null>((r) => setTimeout(() => r(-1), 8_000))]);
      return { code, ms: Date.now() - t0, out };
    } finally {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("before Next registers its handler: start.cjs closes the server itself and exits 0 at once", async () => {
    const r = await run(`require("node:http").createServer((q, s) => s.end("ok")).listen(0, "127.0.0.1", () => console.log("listening"));`);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.ms < 3_000, `took ${r.ms} ms (the old behaviour waited 25 s and exited 1)`);
    assert.match(r.out, /Stopped cleanly/);
  });

  test("...and while server.js is still loading, before any server exists", async () => {
    const r = await run(`console.log("loading"); setTimeout(() => {}, 60_000);`, "loading");
    assert.equal(r.code, 0, r.out);
    assert.ok(r.ms < 3_000, `took ${r.ms} ms`);
  });

  test("with Next's handler registered: its exit(143) is held, then start.cjs exits 0", async () => {
    const r = await run(`
      const server = require("node:http").createServer((q, s) => s.end("ok"));
      server.listen(0, "127.0.0.1", () => {
        process.on("SIGTERM", () => server.close(() => { console.log("next closed"); process.exit(143); }));
        console.log("listening");
      });`);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /next closed/);
    assert.ok(r.ms < 3_000, `took ${r.ms} ms`);
  });
});

describe("graceful shutdown, the app's half (lib/shutdown)", () => {
  const sd = () => require("../src/lib/shutdown") as typeof import("../src/lib/shutdown"); // eslint-disable-line @typescript-eslint/no-require-imports
  beforeEach(() => sd().resetLifecycleForTests());
  afterEach(() => sd().resetLifecycleForTests());

  test("the drain stops the schedulers, waits for running jobs, refuses new ones; close runs last", async () => {
    const { every, runJob, onDrain, onClose, appDrain, appClose, isDraining } = sd();
    const order: string[] = [];
    let ticks = 0;
    every(5, () => ticks++);
    onDrain("live", () => void order.push("drain-hook"));
    onClose("pool", () => void order.push("pool-closed"));
    let release!: () => void;
    const job = runJob("digest", () => new Promise<string>((r) => (release = () => r("sent"))));
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(ticks > 0);
    const drained = appDrain(Date.now() + 2000);
    assert.equal(isDraining(), true);
    assert.equal(await runJob("late", async () => "ran"), undefined, "no new job once draining");
    const before = ticks;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ticks, before, "the scheduler stopped");
    setTimeout(() => {
      order.push("job-done");
      release();
    }, 30);
    assert.deepEqual(await drained, { clean: true, pending: [] });
    assert.equal(await job, "sent");
    assert.deepEqual(await appClose(Date.now() + 1000), { clean: true, pending: [] });
    assert.deepEqual(order, ["drain-hook", "job-done", "pool-closed"]);
  });

  test("past the deadline the drain says what was still running", async () => {
    const { runJob, appDrain } = sd();
    void runJob("directory-sync", () => new Promise(() => {}));
    const r = await appDrain(Date.now() + 50);
    assert.deepEqual(r, { clean: false, pending: ["directory-sync"] });
  });

  test("a failing job is logged with its name and never rejects", async () => {
    const { runJob } = sd();
    const errors: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      assert.equal(await runJob("reviews", async () => Promise.reject(new Error("boom"))), undefined);
    } finally {
      console.error = orig;
    }
    assert.equal(errors[0][0], "[reviews] error:");
  });
});
