// Backups with the blob file store (1.21.2, lib/backup-files): the files
// half of a backup set is made from the workspace's container, and a restore
// puts the files back into it; archives move between the stores either way
// (a self-hosted backup restores into a container, a container's backup
// into an uploads folder). Then a whole backup set, database and files,
// made and restored in blob mode, the way test/backup-set does it on disk.
//
// pg_dump and pg_restore run for real on a database of this file's own.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/backup-blob.test.ts
// (needs Azurite: test/support/azurite.ts).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { extractFilesArchive, writeFilesArchive } from "../src/lib/backup-files";
import { fileStore, resetFileStoreForTests } from "../src/lib/file-store";
import { blobEnv, containerClient, freshContainer, skipWithoutAzurite } from "./support/azurite";

process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";
process.env.COMPASSDOCS_AUDIT_STDOUT = "0";

const SHARED = process.env.DATABASE_URL;
const NAME = `compassdocs_bkblob_${Date.now()}`;
const A = "0123456789abcdef0123456789abcdef.pdf";
const B = "fedcba9876543210fedcba9876543210.png";
const IMPORT = "hd-import/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.csv";
const VARS = ["COMPASSDOCS_FILE_STORE", "COMPASSDOCS_BLOB_CONTAINER", "COMPASSDOCS_BLOB_CONNECTION_STRING", "COMPASSDOCS_UPLOAD_DIR", "COMPASSDOCS_BACKUP_DIR"];
const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));

let skip: false | string = false;
let work = "";
const drops: (() => Promise<void>)[] = [];

function useEnv(vars: Record<string, string>): void {
  for (const k of ["COMPASSDOCS_FILE_STORE", "COMPASSDOCS_BLOB_CONTAINER", "COMPASSDOCS_BLOB_CONNECTION_STRING"]) delete process.env[k];
  Object.assign(process.env, vars);
  resetFileStoreForTests();
}

async function container(): Promise<string> {
  const c = await freshContainer("bk");
  drops.push(c.drop);
  return c.name;
}

async function contents(name: string): Promise<Record<string, string>> {
  const cc = await containerClient(name);
  const out: Record<string, string> = {};
  for await (const b of cc.listBlobsFlat()) out[b.name] = (await cc.getBlockBlobClient(b.name).downloadToBuffer()).toString();
  return out;
}

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
  skip = await skipWithoutAzurite();
  work = await mkdtemp(join(tmpdir(), "cd-bkblob-"));
  process.env.COMPASSDOCS_UPLOAD_DIR = join(work, "uploads");
  await mkdir(process.env.COMPASSDOCS_UPLOAD_DIR, { recursive: true });
});

after(async () => {
  for (const d of drops) await d().catch(() => {});
  await rm(work, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetFileStoreForTests();
});

test("a container's archive restores into another container, whole", async (t) => {
  if (skip) return t.skip(skip);
  const from = await container();
  useEnv(blobEnv(from));
  await fileStore().write(A, Buffer.from("%PDF-1.4 the contract"));
  await fileStore().write(B, Buffer.alloc(3 * 1024 * 1024 + 5, 9));
  await fileStore().write(IMPORT, Buffer.from("id,subject\n"));
  // Not a stored file (a stray probe): never archived.
  await (await containerClient(from)).getBlockBlobClient(".compassdocs-check-stray").uploadData(Buffer.from("x"));
  const tar = join(work, "blob.tar");
  const made = await writeFilesArchive(tar);
  assert.deepEqual(made, { files: 3, bytes: 21 + 3 * 1024 * 1024 + 5 + 11, vanished: 0 });

  const to = await container();
  useEnv(blobEnv(to));
  await fileStore().write("cccccccccccccccccccccccccccccccc.txt", Buffer.from("uploaded after the backup"));
  const r = await extractFilesArchive(tar);
  assert.equal(r.files, 3);
  assert.equal(r.skipped, 0);
  const got = await contents(to);
  assert.equal(got[A], "%PDF-1.4 the contract");
  assert.equal(got[B].length, 3 * 1024 * 1024 + 5);
  assert.equal(got[IMPORT], "id,subject\n");
  assert.equal(got["cccccccccccccccccccccccccccccccc.txt"], "uploaded after the backup", "files added since are kept");
  assert.equal(Object.keys(got).length, 4);
});

test("a self-hosted (uploads folder) archive restores into a container: stored files only, never the key file", async (t) => {
  if (skip) return t.skip(skip);
  const root = join(work, "selfhosted");
  await mkdir(join(root, "hd-import"), { recursive: true });
  await writeFile(join(root, A), "from the volume");
  await writeFile(join(root, IMPORT), "import");
  await writeFile(join(root, ".secret.key"), "never");
  await writeFile(join(root, "notes.txt"), "not a stored file");
  const tar = join(work, "local.tar");
  useEnv({});
  const made = await writeFilesArchive(tar, { root });
  assert.equal(made.files, 3, "the folder's archive holds everything but the key file");

  const to = await container();
  useEnv(blobEnv(to));
  const r = await extractFilesArchive(tar);
  assert.equal(r.files, 2);
  assert.equal(r.skipped, 1, "notes.txt is not a stored file");
  assert.deepEqual(await contents(to), { [A]: "from the volume", [IMPORT]: "import" });
});

test("a container's archive restores into an uploads folder", async (t) => {
  if (skip) return t.skip(skip);
  const from = await container();
  useEnv(blobEnv(from));
  await fileStore().write(A, Buffer.from("from the container"));
  await fileStore().write(IMPORT, Buffer.from("import"));
  const tar = join(work, "blob2.tar");
  await writeFilesArchive(tar);
  const root = join(work, "restored");
  useEnv({});
  const r = await extractFilesArchive(tar, { root });
  assert.equal(r.files, 2);
  assert.equal(await readFile(join(root, A), "utf8"), "from the container");
  assert.equal(await readFile(join(root, IMPORT), "utf8"), "import");
});

test("a truncated archive fails the restore and leaves no short blob", async (t) => {
  if (skip) return t.skip(skip);
  const from = await container();
  useEnv(blobEnv(from));
  await fileStore().write(B, Buffer.alloc(200_000, 4));
  const tar = join(work, "cut.tar");
  await writeFilesArchive(tar);
  const whole = await readFile(tar);
  await writeFile(tar, whole.subarray(0, 512 + 100_000));
  const to = await container();
  useEnv(blobEnv(to));
  await assert.rejects(extractFilesArchive(tar), /truncated/);
  assert.deepEqual(await contents(to), {});
});

test("a whole backup set in blob mode: made from the container, restored into it", async (t) => {
  if (skip) return t.skip(skip);
  assert.ok(SHARED, "DATABASE_URL is set");
  await admin(`CREATE DATABASE ${NAME}`);
  drops.push(() => admin(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`));
  const url = new URL(SHARED!);
  url.pathname = `/${NAME}`;
  const sharedUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url.toString();
  process.env.COMPASSDOCS_BACKUP_DIR = join(work, "backups");
  for (const k of ["BACKUP_S3_BUCKET", "BACKUP_AZURE_CONNECTION_STRING"]) delete process.env[k];
  const name = await container();
  useEnv(blobEnv(name));
  /* eslint-disable @typescript-eslint/no-require-imports */
  const db = require("../src/lib/db") as typeof import("../src/lib/db");
  const backup = require("../src/lib/backup") as typeof import("../src/lib/backup");
  /* eslint-enable @typescript-eslint/no-require-imports */
  try {
    await db.getSetting("__schema_bootstrap__");
    await fileStore().write(A, Buffer.from("%PDF-1.4 kept safe"));
    const made = await backup.createBackup(new Date("2026-11-26T10:00:00Z"));
    assert.equal(made.archived.files, 1);
    assert.deepEqual((await readdir(process.env.COMPASSDOCS_BACKUP_DIR!)).sort(), [made.name, made.files!.name].sort(), "the set is on local disk, encrypted, as before");
    // Lost after the backup.
    await fileStore().delete(A);
    await db.pool().query("INSERT INTO users (username, name) VALUES ('after-blob-backup', 'After')");
    const r = await backup.restoreBackup(made.name);
    assert.equal(r.files, 1);
    assert.equal((await fileStore().read(A)).toString(), "%PDF-1.4 kept safe", "the file is back in the container");
    const n = (await db.pool().query("SELECT count(*)::int AS n FROM users WHERE username = 'after-blob-backup'")).rows[0].n;
    assert.equal(n, 0, "the database is the backup's");
  } finally {
    await db.closePool().catch(() => {});
    db.reopenPoolForTests();
    process.env.DATABASE_URL = sharedUrl;
  }
});
