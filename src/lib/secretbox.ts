import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { uploadDir } from "./uploads";
import { isCloud } from "./cloud";

// Envelope encryption for secrets at rest (AES-256-GCM). The master key never
// touches the database: it comes from the COMPASSDOCS_SECRET_KEY env var
// (recommended — 64 hex or 44 base64 chars for 32 bytes), or from a key file
// that is auto-generated on first boot. The default key-file location is
// inside the uploads volume so it persists across container recreates on a
// standard Docker install.
//
// 1.21.0, cloud mode (lib/cloud, COMPASSDOCS_CLOUD=1): the key comes only
// from COMPASSDOCS_SECRET_KEY, which Container Apps fills from Key Vault.
// No key file is ever created, written or read (not even
// COMPASSDOCS_KEY_FILE), and the process refuses to start without the
// variable (instrumentation, lib/cloud cloudStartupProblems). Self-hosted
// installs keep the order above; moving one to the variable is optional
// (README, "Moving a self-hosted install to COMPASSDOCS_SECRET_KEY"). Since
// the review of #334, a self-hosted install whose variable and key file hold
// different keys refuses to start (masterKeyConflict), and no new key file
// is written when the database already holds sealed values.
//
// Sealed values are stored as "enc:v1:<base64(iv | tag | ciphertext)>", so
// plaintext written by older versions passes through reads untouched and is
// migrated in place on boot.

const PREFIX = "enc:v1:";
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function parseKeyMaterial(raw: string): Buffer | null {
  const s = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  try {
    const b = Buffer.from(s, "base64");
    if (b.length === 32) return b;
  } catch {
    /* fall through */
  }
  return null;
}

function keyFilePath(): string {
  return process.env.COMPASSDOCS_KEY_FILE || join(uploadDir(), ".secret.key");
}

/** The key file's text (throws as readFileSync does). The one place it is read. */
function readKeyFile(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * The master key is unusable for an operator-fixable reason (unreadable key
 * file, bad env var). The message is written for the admin who will see it in
 * a settings error or the container log, so it names the cause and the fix.
 */
export class MasterKeyError extends Error {}

const CHOWN_HINT =
  "If you recently upgraded to 0.59 or later, the uploads volume is still " +
  "owned by root — run the one-time fix from the upgrade notes: " +
  "docker compose stop app && " +
  "docker compose run --rm --no-deps --user 0 app chown -R 1001:1001 /uploads /backups && " +
  "docker compose up -d " +
  "(https://docs.compassdocs.io/self-hosting/updating/)";

/** Where the master key comes from in this process: the variable, or the key file (self-hosted only). */
export function masterKeySource(): "env" | "file" {
  return process.env.COMPASSDOCS_SECRET_KEY || isCloud() ? "env" : "file";
}

/** Tests: forget the cached key, so the next call reads the environment again. */
export function resetMasterKeyForTests(): void {
  cachedKey = null;
  sealedDataExists = false;
}

// 1.21.0 (review of #334): the database already holds sealed values, so a
// brand-new key file would open none of them. Set by lib/db's boot, before
// it first asks for the key.
let sealedDataExists = false;

/** lib/db's boot: whether the settings already hold sealed values. */
export function noteSealedData(exists: boolean): void {
  sealedDataExists = exists;
}

/** The two keys of a self-hosted install that has both, when they differ; null otherwise (cloud mode never reads the file). */
function differingKeys(): { env: Buffer; file: Buffer; path: string } | null {
  if (isCloud()) return null;
  const raw = process.env.COMPASSDOCS_SECRET_KEY;
  const env = raw ? parseKeyMaterial(raw) : null;
  if (!env) return null;
  const path = keyFilePath();
  let file: Buffer | null = null;
  try {
    file = parseKeyMaterial(readKeyFile(path));
  } catch {
    return null; // no file (or unreadable): the variable is the only key
  }
  if (!file || file.equals(env)) return null;
  return { env, file, path };
}

/** Whether `stored` (a sealed value) opens with `key`. */
function opensWith(stored: string, key: Buffer): boolean {
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_LEN));
    decipher.setAuthTag(raw.subarray(IV_LEN, IV_LEN + TAG_LEN));
    decipher.update(raw.subarray(IV_LEN + TAG_LEN));
    decipher.final();
    return true;
  } catch {
    return false;
  }
}

/**
 * Self-hosted: COMPASSDOCS_SECRET_KEY is set AND the key file holds a
 * different key (1.21.0, review of #334: a key left unused in .env, or one
 * added by mistake, would silently take over from the file, and nothing
 * sealed with the file's key would open). `sample` is one sealed value from
 * the database (null: nothing is sealed; undefined: not known, e.g. at run
 * time or with the database unreachable): it says which key this install has
 * been using. One sentence for the log saying which to keep; null when there is
 * nothing to refuse (no variable, no readable file, the same key in both,
 * cloud mode, or the database's values open with the variable's key).
 */
export function masterKeyConflict(sample?: string | null): string | null {
  const k = differingKeys();
  if (!k) return null;
  const byEnv = sample ? opensWith(sample, k.env) : false;
  if (byEnv) return null;
  const byFile = sample ? opensWith(sample, k.file) : false;
  const head = `COMPASSDOCS_SECRET_KEY is set, but the key file ${k.path} holds a different key, so CompassDocs won't start. `;
  const keepFile =
    `To keep the file's key, remove COMPASSDOCS_SECRET_KEY from the environment, or set it to the file's value ` +
    `(docker compose run --rm --no-deps app cat ${k.path}).`;
  if (byFile) return head + `The credentials already encrypted in the database open only with the file's key. ${keepFile} Nothing was changed.`;
  if (sample) return head + `The credentials encrypted in the database open with neither key: restore the key that sealed them, or re-enter them after choosing one. ${keepFile} Nothing was changed.`;
  if (sample === undefined) return head + `Keep the one this install's credentials were encrypted with, usually the file's. ${keepFile} To keep the variable's key, delete the file. Nothing was changed.`;
  return head + `Nothing is encrypted in the database yet, so either key is safe: ${keepFile} To keep the variable's key, delete the file. Nothing was changed.`;
}

/**
 * Self-hosted start-up (instrumentation), before anything is decrypted or
 * sealed: a key conflict (masterKeyConflict) is one error line, then exit 1,
 * so the server never runs on the wrong key. (getMasterKey itself keeps the
 * order it always had, the variable first: a process that never started the
 * server, a script or a test, is not refused.)
 * When the database's values open with the variable's key, the install has
 * been running on it: one warning that the key file is no longer used, and
 * it starts as before.
 */
export async function checkSelfHostedKey(
  log: (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => void,
  exit: (code: number) => void = (code) => process.exit(code),
  sample: () => Promise<string | null | undefined> = async () => undefined
): Promise<boolean> {
  const k = differingKeys();
  if (!k) return true;
  let stored: string | null | undefined;
  try {
    stored = await Promise.race([sample(), new Promise<undefined>((r) => setTimeout(() => r(undefined), 5_000).unref?.())]);
  } catch {
    stored = undefined; // the database is not there yet: decided without it
  }
  const conflict = masterKeyConflict(stored);
  if (!conflict) {
    log("warn", "secret_key.file_unused", {
      message: `COMPASSDOCS_SECRET_KEY is the key in use; the key file ${k.path} holds another key and is not read. Delete it once you have a copy of the variable's key.`,
    });
    return true;
  }
  log("error", "secret_key.conflict", { message: conflict });
  await new Promise((r) => setTimeout(r, 200));
  exit(1);
  return false;
}

/** The 32-byte master key. Env var wins; otherwise a key file is read or
 * created (0600). Throws only if the key file can't be read *or* written.
 * In cloud mode only the env var counts: without it this throws. */
export function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const env = process.env.COMPASSDOCS_SECRET_KEY;
  if (!env && isCloud()) {
    throw new MasterKeyError(
      "COMPASSDOCS_SECRET_KEY is not set. In cloud mode (COMPASSDOCS_CLOUD=1) the encryption key comes only from the environment; no key file is created or read."
    );
  }
  if (env) {
    const parsed = parseKeyMaterial(env);
    if (!parsed) {
      throw new MasterKeyError(
        "COMPASSDOCS_SECRET_KEY must be 32 bytes, as 64 hex chars or 44 base64 chars."
      );
    }
    cachedKey = parsed;
    return cachedKey;
  }
  const path = keyFilePath();
  try {
    const parsed = parseKeyMaterial(readKeyFile(path));
    if (parsed) {
      cachedKey = parsed;
      return cachedKey;
    }
    throw new MasterKeyError(`Key file ${path} exists but does not contain a valid 32-byte key.`);
  } catch (e: any) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      throw new MasterKeyError(
        `The encryption key file (${path}) exists but is not readable by the app ` +
          `(permission denied), so credentials can't be encrypted or decrypted. ${CHOWN_HINT}`
      );
    }
    if (e?.code !== "ENOENT") throw e;
  }
  // 1.21.0 (review of #334): sealed values exist but their key file is gone.
  // A new key would open none of them, so none is written; the admin
  // restores the file (or sets the variable to the old key).
  if (sealedDataExists) {
    throw new MasterKeyError(
      `The encryption key file (${path}) is missing and COMPASSDOCS_SECRET_KEY is not set, but the database already holds credentials encrypted with a key. ` +
        `A new key would open none of them, so none was written. Restore ${path} from a backup of the uploads volume (or set COMPASSDOCS_SECRET_KEY to the old key) and restart. ` +
        `If the old key is lost for good, set COMPASSDOCS_SECRET_KEY to a new one (openssl rand -hex 32), restart, and enter those credentials again.`
    );
  }
  const fresh = randomBytes(32);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, fresh.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  } catch (e: any) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      throw new MasterKeyError(
        `Couldn't create the encryption key file (${path}): permission denied. ${CHOWN_HINT}`
      );
    }
    throw e;
  }
  cachedKey = fresh;
  return cachedKey;
}

/** Short key identifier for diagnostics (never reveals the key). */
export function keyFingerprint(): string {
  return createHash("sha256").update(getMasterKey()).digest("hex").slice(0, 12);
}

export function isSealed(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Encrypt a settings value. Empty stays empty; sealing is idempotent. */
export function sealSecret(plain: string): string {
  if (!plain || isSealed(plain)) return plain;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", getMasterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

// --- File encryption (backups) ----------------------------------------------
//
// Format: 8-byte magic "CDOCENC1" | 12-byte IV | ciphertext | 16-byte GCM tag.
// Streamed, so dump size doesn't matter; the tag lands at the end of the file
// and is verified on decrypt.

const FILE_MAGIC = Buffer.from("CDOCENC1");

export async function encryptFile(src: string, dest: string): Promise<void> {
  const { createReadStream, createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", getMasterKey(), iv);
  const out = createWriteStream(dest, { mode: 0o600 });
  out.write(FILE_MAGIC);
  out.write(iv);
  await pipeline(createReadStream(src), cipher, out, { end: false });
  out.end(cipher.getAuthTag());
  await new Promise<void>((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
  });
}

export async function isEncryptedFile(path: string): Promise<boolean> {
  const { open } = await import("node:fs/promises");
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(FILE_MAGIC.length);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return bytesRead === FILE_MAGIC.length && buf.equals(FILE_MAGIC);
  } finally {
    await fh.close();
  }
}

export async function decryptFile(src: string, dest: string): Promise<void> {
  const { createReadStream, createWriteStream } = await import("node:fs");
  const { open, stat } = await import("node:fs/promises");
  const { pipeline } = await import("node:stream/promises");
  const size = (await stat(src)).size;
  const headerLen = FILE_MAGIC.length + IV_LEN;
  if (size < headerLen + TAG_LEN) throw new Error("Encrypted file is truncated.");

  const fh = await open(src, "r");
  let iv: Buffer;
  let tag: Buffer;
  try {
    const header = Buffer.alloc(headerLen);
    await fh.read(header, 0, headerLen, 0);
    if (!header.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
      throw new Error("Not a CompassDocs-encrypted file.");
    }
    iv = header.subarray(FILE_MAGIC.length);
    tag = Buffer.alloc(TAG_LEN);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    await fh.close();
  }

  const decipher = createDecipheriv("aes-256-gcm", getMasterKey(), iv);
  decipher.setAuthTag(tag);
  await pipeline(
    createReadStream(src, { start: headerLen, end: size - TAG_LEN - 1 }),
    decipher,
    createWriteStream(dest, { mode: 0o600 })
  );
}

/**
 * Decrypt a stored value. Plaintext (pre-migration) passes through unchanged.
 * A sealed value that fails to decrypt (wrong/lost master key) returns "" so
 * the dependent feature degrades to "not configured" instead of crashing —
 * with a loud log line, since that's an operator problem to fix.
 */
export function openSecret(stored: string): string {
  if (!stored || !isSealed(stored)) return stored;
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", getMasterKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch (e) {
    // Distinguish "can't get at the key" (fixable, key intact) from a genuine
    // key mismatch — conflating them sends operators down the wrong path.
    if (e instanceof MasterKeyError) {
      console.error(`[secretbox] Failed to decrypt a stored secret — ${e.message}`);
    } else {
      console.error(
        "[secretbox] Failed to decrypt a stored secret — the master key " +
          "(COMPASSDOCS_SECRET_KEY or the key file) does not match the one that " +
          "encrypted it. Re-enter the affected credential in Settings."
      );
    }
    return "";
  }
}
