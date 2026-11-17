// Backups as a set (1.20.27, security review H5, M3, M12, Low): the database
// dump and an archive of the uploads volume, both encrypted; a restore puts
// both back and keeps the audit log's rows newer than the backup; deleting
// one removes the local files only; no plaintext scratch file is left.
//
// pg_dump and pg_restore run for real, so this file works on a database of
// its own (created from DATABASE_URL's server and dropped afterwards), never
// the shared one the other suites use.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/backup-set.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";

process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";
process.env.COMPASSDOCS_AUDIT_STDOUT = "0";

const SHARED = process.env.DATABASE_URL;
const NAME = `compassdocs_bk_${Date.now()}`;
let backupDir = "";
let uploadDir = "";
/* eslint-disable @typescript-eslint/no-require-imports */
let db: typeof import("../src/lib/db");
let backup: typeof import("../src/lib/backup");
/* eslint-enable @typescript-eslint/no-require-imports */

async function admin(sql: string): Promise<void> {
  const c = new Client({ connectionString: SHARED });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

before(async () => {
  assert.ok(SHARED, "DATABASE_URL is set");
  await admin(`CREATE DATABASE ${NAME}`);
  const url = new URL(SHARED!);
  url.pathname = `/${NAME}`;
  process.env.DATABASE_URL = url.toString();
  backupDir = await mkdtemp(join(tmpdir(), "cd-backups-"));
  uploadDir = await mkdtemp(join(tmpdir(), "cd-uploads-"));
  process.env.COMPASSDOCS_BACKUP_DIR = backupDir;
  process.env.COMPASSDOCS_UPLOAD_DIR = uploadDir;
  for (const k of ["BACKUP_S3_BUCKET", "BACKUP_AZURE_CONNECTION_STRING"]) delete process.env[k];
  db = require("../src/lib/db"); // eslint-disable-line @typescript-eslint/no-require-imports
  backup = require("../src/lib/backup"); // eslint-disable-line @typescript-eslint/no-require-imports
  await db.getSetting("__schema_bootstrap__");
});

after(async () => {
  await db?.pool().end().catch(() => {});
  process.env.DATABASE_URL = SHARED;
  await admin(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`).catch(() => {});
  await rm(backupDir, { recursive: true, force: true });
  await rm(uploadDir, { recursive: true, force: true });
});

const count = async (sql: string, params: unknown[] = []) => Number((await db.pool().query(sql, params)).rows[0].n);

test("a backup holds the database and the uploads, encrypted; a restore brings both back and keeps the newer audit rows", async () => {
  const { audit } = require("../src/lib/audit") as typeof import("../src/lib/audit"); // eslint-disable-line @typescript-eslint/no-require-imports
  await writeFile(join(uploadDir, "0123456789abcdef0123456789abcdef.pdf"), "%PDF-1.4 the contract");
  await writeFile(join(uploadDir, ".secret.key"), "never in a backup");
  await audit({ action: "test.before_backup", details: { n: 1 } });

  const made = await backup.createBackup(new Date("2026-11-17T10:00:00Z"));
  assert.ok(made.files, "the set has its files half");
  assert.equal(made.archived.files, 1, "the key file is not archived");
  const names = await readdir(backupDir);
  assert.deepEqual(names.sort(), [made.name, made.files!.name].sort(), "two files, no plaintext scratch file left");
  for (const n of names) {
    const head = (await readFile(join(backupDir, n))).subarray(0, 8).toString();
    assert.equal(head, "CDOCENC1", `${n} is encrypted`);
  }
  assert.ok(!(await readFile(join(backupDir, made.files!.name))).includes(Buffer.from("the contract")), "no plaintext in the archive");
  const listed = await backup.listBackups();
  assert.equal(listed[0].files?.name, made.files!.name);

  // After the backup: an audit row, an account, a lost file.
  await audit({ action: "test.after_backup", details: { n: 2 } });
  await db.pool().query("INSERT INTO users (username, name) VALUES ('after-backup', 'After')");
  await unlink(join(uploadDir, "0123456789abcdef0123456789abcdef.pdf"));
  await writeFile(join(uploadDir, "fedcba9876543210fedcba9876543210.png"), "added since");

  const r = await backup.restoreBackup(made.name);
  assert.equal(r.files, 1);
  assert.ok(r.audit_rows_kept >= 1, `the newer audit rows are kept (${r.audit_rows_kept})`);
  assert.equal(await count("SELECT count(*)::int AS n FROM users WHERE username = 'after-backup'"), 0, "the database is the backup's");
  assert.equal(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'test.after_backup'"), 1, "the audit log is not rolled back");
  assert.equal(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'test.before_backup'"), 1, "and nothing is doubled");
  assert.equal(await readFile(join(uploadDir, "0123456789abcdef0123456789abcdef.pdf"), "utf8"), "%PDF-1.4 the contract", "the attachment is back");
  assert.equal(await readFile(join(uploadDir, "fedcba9876543210fedcba9876543210.png"), "utf8"), "added since", "files added since are kept");
  // The identity sequence moved past the kept rows: a new row does not collide.
  await audit({ action: "test.after_restore" });
  assert.equal(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'test.after_restore'"), 1);
  assert.ok(!(await readdir(backupDir)).some((n) => n.endsWith(".tmp")), "no plaintext scratch file after the restore");

  // Deleting removes both local files.
  assert.equal(await backup.deleteBackup(made.name), true);
  assert.deepEqual(await readdir(backupDir), []);
});

test("a database-only backup from before 1.20.27 still restores", async () => {
  const made = await backup.createBackup(new Date("2026-11-17T11:00:00Z"));
  await unlink(join(backupDir, made.files!.name));
  const listed = await backup.listBackups();
  assert.equal(listed.find((b) => b.name === made.name)?.files, null);
  const r = await backup.restoreBackup(made.name);
  assert.equal(r.files, null);
});

test("a damaged attachments archive stops the restore before the database is touched (second review, Low)", async () => {
  const made = await backup.createBackup(new Date("2026-11-17T12:00:00Z"));
  await db.pool().query("INSERT INTO users (username, name) VALUES ('after-damaged', 'After')");
  // Cut the encrypted archive short: it no longer decrypts.
  const filesPath = join(backupDir, made.files!.name);
  const whole = await readFile(filesPath);
  await writeFile(filesPath, whole.subarray(0, Math.max(16, whole.length - 40)));
  await assert.rejects(backup.restoreBackup(made.name));
  assert.equal(await count("SELECT count(*)::int AS n FROM users WHERE username = 'after-damaged'"), 1, "the database was not restored");
  assert.ok(!(await readdir(backupDir)).some((n) => n.endsWith(".tmp")), "no plaintext scratch file left");
});

test("a database restore that fails says the attachments were already put back, and keeps the audit log", async () => {
  await writeFile(join(uploadDir, "aaaabbbbccccddddeeeeffff00001111.txt"), "an attachment");
  const made = await backup.createBackup(new Date("2026-11-17T13:00:00Z"));
  // A dump pg_restore cannot read: encrypted with our key, so it decrypts, then fails to restore.
  const { encryptFile } = require("../src/lib/secretbox") as typeof import("../src/lib/secretbox"); // eslint-disable-line @typescript-eslint/no-require-imports
  const junk = join(backupDir, "junk.plain");
  await writeFile(junk, "this is not a pg_dump archive");
  await encryptFile(junk, join(backupDir, made.name));
  await unlink(junk);
  await unlink(join(uploadDir, "aaaabbbbccccddddeeeeffff00001111.txt"));
  const err = await backup.restoreBackup(made.name).then(
    () => null,
    (e: unknown) => e
  );
  assert.ok(err instanceof backup.RestoreError, String(err));
  assert.equal((err as InstanceType<typeof backup.RestoreError>).stage, "database");
  assert.match((err as Error).message, /attachments were already put back/);
  assert.equal(await readFile(join(uploadDir, "aaaabbbbccccddddeeeeffff00001111.txt"), "utf8"), "an attachment", "the files half went back first");
  assert.ok((await count("SELECT count(*)::int AS n FROM audit_log")) > 0, "the audit log is still there");
});
