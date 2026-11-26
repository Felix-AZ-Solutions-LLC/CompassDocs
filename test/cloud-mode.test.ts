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

  test("no DATABASE_URL is fatal; no or a plain-http COMPASSDOCS_BASE_URL only warns", () => {
    const base = { COMPASSDOCS_CLOUD: "1", COMPASSDOCS_SECRET_KEY: HEX_KEY };
    assert.deepEqual(cloudStartupProblems({ ...base, COMPASSDOCS_BASE_URL: "https://a.example" }).fatal, ["DATABASE_URL is not set."]);
    const none = cloudStartupProblems({ ...base, DATABASE_URL: "postgres://x@db/app" });
    assert.deepEqual(none.fatal, []);
    assert.match(none.warnings[0], /COMPASSDOCS_BASE_URL is not set/);
    assert.match(cloudStartupProblems({ ...base, DATABASE_URL: "postgres://x@db/app", COMPASSDOCS_BASE_URL: "http://a.example" }).warnings[0], /should be an https:\/\/ address/);
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
