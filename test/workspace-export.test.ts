// Workspace export (1.21.4, lib/workspace-export), cloud mode, for real:
// pg_dump of the shared test database and the workspace's stored files, on
// the uploads folder and (with Azurite) in a blob container.
//
// Covered: the archive (README, manifest, the database dump and the files
// archive, nothing else, every path under one folder, no "..", no link,
// sizes and SHA-256 that match the manifest and the row); the files archive
// extracting to exactly the stored files; the dump readable by pg_restore;
// the pair listed by Settings → Backups' code as a set with its files half
// (an export restores on a self-hosted install); nothing on the app's local
// disk in blob mode; the export's objects never reachable as a stored file
// and never in a backup; one at a time and three a day; a failure (pg_dump
// missing) cleans up and says why; stale ones fail; the time limit; delete;
// and every step in the audit log.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/workspace-export.test.ts

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobEnv, freshContainer, skipWithoutAzurite } from "./support/azurite";

process.env.COMPASSDOCS_CLOUD = "1";
process.env.COMPASSDOCS_SECRET_KEY ||= "7c4f0d5e8a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5";
process.env.COMPASSDOCS_WORKSPACE_ID = "ws_export_test";
process.env.COMPASSDOCS_AUDIT_STDOUT = "0";

type X = typeof import("../src/lib/workspace-export");
type FS = typeof import("../src/lib/file-store");
let W: X;
let F: FS;
let db: typeof import("../src/lib/db");
let work = "";
const actor = { id: null, name: "Ada Admin", role: "admin" };

const A = "0123456789abcdef0123456789abcdef.pdf";
const B = "fedcba9876543210fedcba9876543210.png";
const IMPORT = "hd-import/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.csv";
const CONTENT: Record<string, Buffer> = {
  [A]: Buffer.from("%PDF-1.4 the contract"),
  [B]: Buffer.alloc(1024 * 1024 + 7, 3),
  [IMPORT]: Buffer.from("id,subject\n1,Printer\n"),
};

interface Entry {
  name: string;
  type: string;
  size: number;
  data: Buffer;
}

/** Read a ustar archive (the format lib/backup-files writes). */
function untar(buf: Buffer): Entry[] {
  const out: Entry[] = [];
  let pos = 0;
  let pax: string | null = null;
  while (pos + 512 <= buf.length) {
    const h = buf.subarray(pos, pos + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a: number, l: number) => {
      const s = h.subarray(a, a + l);
      const z = s.indexOf(0);
      return (z < 0 ? s : s.subarray(0, z)).toString("utf8");
    };
    const size = parseInt(str(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(345, 155);
    const name = pax ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    const data = buf.subarray(pos + 512, pos + 512 + size);
    pos += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = /path=([^\n]*)\n/.exec(data.toString())?.[1] ?? null;
      continue;
    }
    pax = null;
    out.push({ name, type, size, data });
  }
  return out;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function readAll(store: import("../src/lib/file-store").FileStore, key: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of store.readStream(key)) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

async function reset(): Promise<void> {
  await db.pool().query("DELETE FROM workspace_exports");
}

/** Start and finish one export; answers its row. */
async function oneExport(): Promise<import("../src/lib/workspace-export").ExportRow> {
  const row = await W.startWorkspaceExport(actor, "203.0.113.4", { run: false });
  assert.equal(row.status, "running");
  const done = await W.runWorkspaceExport(row.id, actor);
  assert.ok(done, "the export finished");
  return done!;
}

/** Everything about one finished export's archive that holds whatever the store. */
async function checkArchive(row: import("../src/lib/workspace-export").ExportRow) {
  assert.equal(row.status, "ready");
  assert.match(row.file_name ?? "", /^compassdocs-export-\d{8}-\d{6}\.tar$/);
  const buf = await readAll(F.exportStore(), W.archiveKey(row.id));
  assert.equal(buf.length, row.size);
  assert.equal(sha(buf), row.sha256);
  const entries = untar(buf);
  const folder = row.file_name!.replace(/\.tar$/, "");
  const names = entries.map((e) => e.name);
  assert.equal(entries.length, 4);
  for (const e of entries) {
    assert.equal(e.type, "0", `${e.name} is a regular file`);
    assert.ok(e.name.startsWith(`${folder}/`), `${e.name} is under ${folder}/`);
    assert.ok(!e.name.split("/").includes(".."), e.name);
  }
  const stamp = folder.replace("compassdocs-export-", "");
  assert.deepEqual(names, [`${folder}/README.md`, `${folder}/manifest.json`, `${folder}/compassdocs-${stamp}.dump`, `${folder}/compassdocs-${stamp}.files.tar`]);
  const manifest = JSON.parse(entries[1].data.toString());
  assert.equal(manifest.format, "compassdocs-workspace-export");
  assert.equal(manifest.workspace_id, "ws_export_test");
  assert.equal(manifest.database.sha256, sha(entries[2].data));
  assert.equal(manifest.database.size, entries[2].size);
  assert.equal(manifest.files.sha256, sha(entries[3].data));
  assert.deepEqual(manifest.database.rows_left_out_of, W.EXCLUDED_TABLE_DATA);
  const readme = entries[0].data.toString();
  assert.match(readme, /Settings → Backups/);
  assert.match(readme, /COMPASSDOCS_SECRET_KEY/);
  assert.ok(readme.includes(manifest.database.sha256));
  // The files archive holds exactly the stored files.
  const files = untar(entries[3].data).filter((e) => e.type === "0");
  assert.deepEqual(Object.fromEntries(files.map((e) => [e.name, sha(e.data)])), Object.fromEntries(Object.entries(CONTENT).map(([k, v]) => [k, sha(v)])));
  // The dump is a real custom-format dump of this database.
  const dumpPath = join(work, `check-${row.id}.dump`);
  await writeFile(dumpPath, entries[2].data);
  const list = execFileSync("pg_restore", ["--list", dumpPath]).toString();
  assert.match(list, /TABLE public documents/);
  assert.match(list, /TABLE DATA public documents/);
  assert.doesNotMatch(list, /TABLE DATA public sessions/, "sessions' rows are left out");
  return { entries, folder, stamp };
}

before(async () => {
  W = await import("../src/lib/workspace-export");
  F = await import("../src/lib/file-store");
  db = await import("../src/lib/db");
  await db.getSetting("__boot__");
  work = await mkdtemp(join(tmpdir(), "cd-wsexport-"));
  process.env.COMPASSDOCS_UPLOAD_DIR = join(work, "uploads");
  await mkdir(process.env.COMPASSDOCS_UPLOAD_DIR, { recursive: true });
  F.resetFileStoreForTests();
  for (const [k, v] of Object.entries(CONTENT)) await F.fileStore().write(k, v);
  await reset();
});

after(async () => {
  await reset().catch(() => {});
  await rm(work, { recursive: true, force: true });
  await db.pool().end();
});

describe("the uploads folder", () => {
  test("one archive: README, manifest, the database and every stored file", async () => {
    await reset();
    const row = await oneExport();
    const { entries, stamp } = await checkArchive(row);
    // The pieces are gone; only the archive is kept, under exports/ in the uploads folder.
    assert.deepEqual(await readdir(join(work, "uploads", "exports")), [`${row.id}.tar`]);
    // It restores on a self-hosted install: Settings → Backups lists the pair as a set with its files half.
    const backups = join(work, "backups");
    await mkdir(backups, { recursive: true });
    await writeFile(join(backups, `compassdocs-${stamp}.dump`), entries[2].data);
    await writeFile(join(backups, `compassdocs-${stamp}.files.tar`), entries[3].data);
    process.env.COMPASSDOCS_BACKUP_DIR = backups;
    const { listBackups, isValidBackupFile } = await import("../src/lib/backup");
    const listed = await listBackups();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].files?.name, `compassdocs-${stamp}.files.tar`);
    assert.ok(isValidBackupFile(`compassdocs-${stamp}.files.tar`));
    // And its files half extracts into an uploads folder: exactly the stored files.
    const { extractFilesArchive } = await import("../src/lib/backup-files");
    const root = join(work, "restored");
    const r = await extractFilesArchive(join(backups, `compassdocs-${stamp}.files.tar`), { root });
    assert.equal(r.files, 3);
    assert.equal((await readFile(join(root, A))).toString(), "%PDF-1.4 the contract");
    delete process.env.COMPASSDOCS_BACKUP_DIR;
    // Audited.
    const audit = await db.pool().query("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id", [row.id]);
    assert.deepEqual(audit.rows.map((x) => x.action), ["workspace.export_started", "workspace.export_ready"]);
  });

  test("an export's objects are never a stored file, never in a backup, never an attachment", async () => {
    const [row] = (await W.listWorkspaceExports()).filter((r) => r.status === "ready");
    const key = W.archiveKey(row.id);
    assert.equal(F.isValidStoreKey(key), false);
    assert.equal(F.isExportKey(key), true);
    assert.equal(await F.fileStore().stat(key), null, "the files' store doesn't answer for it");
    await assert.rejects(F.fileStore().read(key));
    for (const k of [A, "../uploads/.secret.key", "exports/../.secret.key", `exports/${row.id}.tar/../x`]) assert.equal(F.isExportKey(k), false, k);
    await assert.rejects(F.exportStore().read(A), "the export store doesn't answer for a stored file");
    const listed: string[] = [];
    for await (const f of F.fileStore().list()) listed.push(f.key);
    assert.ok(!listed.some((k) => k.startsWith("exports/")));
    const { writeFilesArchive } = await import("../src/lib/backup-files");
    const tar = join(work, "backup.tar");
    const made = await writeFilesArchive(tar);
    assert.equal(made.files, 3, "a backup of the uploads folder leaves exports/ out");
    assert.ok(!untar(await readFile(tar)).some((e) => e.name.startsWith("exports")));
  });

  test("one at a time, three a day", async () => {
    await reset();
    const first = await W.startWorkspaceExport(actor, null, { run: false });
    await assert.rejects(W.startWorkspaceExport(actor, null, { run: false }), (e: { code?: string; status?: number }) => e.code === "export_running" && e.status === 409);
    await db.pool().query("UPDATE workspace_exports SET status = 'failed' WHERE id = $1", [first.id]);
    await W.startWorkspaceExport(actor, null, { run: false });
    await db.pool().query("UPDATE workspace_exports SET status = 'failed' WHERE status = 'running'");
    await W.startWorkspaceExport(actor, null, { run: false });
    await db.pool().query("UPDATE workspace_exports SET status = 'failed' WHERE status = 'running'");
    await assert.rejects(W.startWorkspaceExport(actor, null, { run: false }), (e: { code?: string; status?: number }) => e.code === "export_limit" && e.status === 429);
    await reset();
  });

  test("a failure says why and leaves nothing behind", async () => {
    await reset();
    const row = await W.startWorkspaceExport(actor, null, { run: false });
    const bin = process.env.COMPASSDOCS_PG_BIN;
    process.env.COMPASSDOCS_PG_BIN = join(work, "no-such-bin");
    try {
      assert.equal(await W.runWorkspaceExport(row.id, actor), null);
    } finally {
      if (bin === undefined) delete process.env.COMPASSDOCS_PG_BIN;
      else process.env.COMPASSDOCS_PG_BIN = bin;
    }
    const after = await W.getWorkspaceExport(row.id);
    assert.equal(after?.status, "failed");
    assert.ok(after?.error);
    const left = await readdir(join(work, "uploads", "exports")).catch(() => [] as string[]);
    assert.ok(!left.some((n) => n.startsWith(row.id)), "no piece of it is kept");
    const audit = await db.pool().query("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id", [row.id]);
    assert.ok(audit.rows.map((x) => x.action).includes("workspace.export_failed"));
  });

  test("a stopped heartbeat fails it; past its time it is removed; deleting removes it now", async () => {
    await reset();
    const stale = await W.startWorkspaceExport(actor, null, { run: false });
    await db.pool().query("UPDATE workspace_exports SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1", [stale.id]);
    await W.sweepWorkspaceExports();
    assert.equal((await W.getWorkspaceExport(stale.id))?.status, "failed");

    const row = await oneExport();
    await assert.doesNotReject(W.openWorkspaceExport(row.id, actor, null).then((o) => o.stream.destroy()));
    await db.pool().query("UPDATE workspace_exports SET expires_at = now() - interval '1 second' WHERE id = $1", [row.id]);
    await assert.rejects(W.openWorkspaceExport(row.id, actor, null), (e: { status?: number }) => e.status === 410);
    await W.sweepWorkspaceExports();
    assert.equal((await W.getWorkspaceExport(row.id))?.status, "expired");
    assert.equal(await F.exportStore().stat(W.archiveKey(row.id)), null);

    const again = await oneExport();
    await W.deleteWorkspaceExport(again.id, actor, null);
    assert.equal((await W.getWorkspaceExport(again.id))?.status, "deleted");
    assert.equal(await F.exportStore().stat(W.archiveKey(again.id)), null);
    await assert.rejects(W.openWorkspaceExport(again.id, actor, null), (e: { status?: number }) => e.status === 404);
    await assert.rejects(W.openWorkspaceExport("../../etc/passwd", actor, null), (e: { status?: number }) => e.status === 404);
  });

  test("downloads are counted and audited from their first byte; a range is a range", async () => {
    await reset();
    const row = await oneExport();
    const part = await W.openWorkspaceExport(row.id, actor, "198.51.100.1", { start: 0, end: 511 });
    let n = 0;
    for await (const c of part.stream) n += (c as Buffer).length;
    assert.equal(n, 512);
    const rest = await W.openWorkspaceExport(row.id, actor, null, { start: 512, end: row.size! - 1 });
    rest.stream.destroy();
    assert.equal((await W.getWorkspaceExport(row.id))?.downloads, 1);
    assert.deepEqual(W.parseRange("bytes=0-9", 100), { start: 0, end: 9 });
    assert.deepEqual(W.parseRange("bytes=90-", 100), { start: 90, end: 99 });
    assert.deepEqual(W.parseRange("bytes=-10", 100), { start: 90, end: 99 });
    assert.equal(W.parseRange("bytes=100-", 100), "unsatisfiable");
    assert.equal(W.parseRange("bytes=0-1,5-6", 100), null);
    assert.equal(W.parseRange(null, 100), null);
  });

  test("self-hosted: not available", async () => {
    process.env.COMPASSDOCS_CLOUD = "";
    try {
      assert.equal(W.workspaceExportAvailable(), false);
      await assert.rejects(W.startWorkspaceExport(actor, null, { run: false }), (e: { status?: number }) => e.status === 404);
    } finally {
      process.env.COMPASSDOCS_CLOUD = "1";
    }
  });
});

describe("Azure Blob Storage (Azurite)", () => {
  test("made in the workspace's container, never on local disk; the same archive", async (t) => {
    const skip = await skipWithoutAzurite();
    if (skip) return t.skip(skip);
    const c = await freshContainer("exp");
    const saved = { ...process.env };
    try {
      Object.assign(process.env, blobEnv(c.name));
      // No uploads folder at all: anything written to local disk would fail here.
      process.env.COMPASSDOCS_UPLOAD_DIR = join(work, "must-not-exist");
      F.resetFileStoreForTests();
      for (const [k, v] of Object.entries(CONTENT)) await F.fileStore().write(k, v);
      await reset();
      const row = await oneExport();
      await checkArchive(row);
      await assert.rejects(readdir(join(work, "must-not-exist")), "nothing was written to the local disk");
      const names: string[] = [];
      for await (const o of F.exportStore().list()) names.push(o.key);
      assert.deepEqual(names, [W.archiveKey(row.id)], "only the archive is kept");
      const files: string[] = [];
      for await (const f of F.fileStore().list()) files.push(f.key);
      assert.deepEqual(files.sort(), Object.keys(CONTENT).sort(), "the export is not a stored file");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      F.resetFileStoreForTests();
      await c.drop();
    }
  });
});
