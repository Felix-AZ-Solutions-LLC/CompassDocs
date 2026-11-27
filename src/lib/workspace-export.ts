// Workspace export (1.21.4): a CompassDocs Cloud customer takes a full copy
// of their workspace, to keep or to leave with. Cloud mode only; a
// self-hosted install has Settings → Backups, which this reuses.
//
// One archive, a POSIX tar (lib/backup-files writes it), holding exactly a
// self-hosted backup set, unencrypted, plus how to use it:
//
//   compassdocs-export-<stamp>/README.md                     how to import it
//   compassdocs-export-<stamp>/manifest.json                 what is in it (sizes, SHA-256)
//   compassdocs-export-<stamp>/compassdocs-<stamp>.dump      the database: pg_dump custom format
//   compassdocs-export-<stamp>/compassdocs-<stamp>.files.tar every stored file (lib/backup-files format)
//
// The two compassdocs-<stamp>.* files are a backup set as Settings → Backups
// lists and restores it on a self-hosted install (lib/backup: the files half
// may be unencrypted since 1.21.4), and each is also usable by hand
// (pg_restore; tar -x into the uploads folder).
//
// It is made in the background (startWorkspaceExport), in three stages, and
// never on the app's local disk: the database dump and the files archive
// are each streamed into the workspace's file store (lib/file-store
// exportStore: the uploads folder, or the workspace's blob container), then
// the outer archive is streamed from those two into the store too, and they
// are deleted. Memory stays bounded (stream backpressure, the blob upload's
// few 4 MB blocks), and nothing waits on the size of the workspace. Progress
// (stage, files and bytes) is in workspace_exports, which the page reads.
//
// Rules: one export runs at a time, MAX_PER_DAY start in any 24 hours; an
// export can be downloaded for EXPORT_TTL_MS, only by someone holding
// system.export (Administrators), only through the app's own route (never a
// public or signed URL), and never by a CompassDocs support session. Every
// start, finish, failure, download and deletion is in the audit log. An
// export a restart cut short is marked failed (its heartbeat stops) and its
// pieces removed; finished ones past their time are removed by the minute
// tick (sweepWorkspaceExports).

import "server-only";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { PassThrough, Transform, type Readable } from "node:stream";
import { join } from "node:path";
import pkg from "../../package.json";
import { isCloud } from "./cloud";
import { exportStore, fileStore, fileStoreKind, type FileStore, type StoredFile } from "./file-store";
import { pgEnv } from "./backup";
import { excluded, tarHeader, tarPadding, tarWrite, TAR_END, writeStoreTar } from "./backup-files";
import { pool, withAdvisoryLock } from "./db";
import { audit, type AuditActor } from "./audit";
import { logEvent } from "./log";

/** How long a finished export can be downloaded. */
export const EXPORT_TTL_MS = 7 * 24 * 60 * 60_000;
/** Exports started in any 24 hours. */
export const MAX_PER_DAY = 3;
/** A running export whose heartbeat is older than this was cut short (a restart). */
export const STALE_MS = 3 * 60_000;
/** Progress is written at most this often. */
const PROGRESS_EVERY_MS = 2_000;
/** Tables whose rows an export leaves out: live sign-in state, worthless anywhere else. */
export const EXCLUDED_TABLE_DATA = ["sessions", "duo_states", "support_token_uses", "saml_seen_responses"];
export const MANIFEST_FORMAT = "compassdocs-workspace-export";
export const MANIFEST_VERSION = 1;

export type ExportStatus = "running" | "ready" | "failed" | "expired" | "deleted";
export type ExportStage = "database" | "files" | "archive" | "done";

export interface ExportRow {
  id: string;
  status: ExportStatus;
  stage: ExportStage;
  requested_by_name: string;
  created_at: string;
  heartbeat_at: string;
  finished_at: string | null;
  files_total: number;
  files_done: number;
  bytes_total: number;
  bytes_done: number;
  size: number | null;
  sha256: string | null;
  file_name: string | null;
  error: string | null;
  expires_at: string | null;
  downloads: number;
}

export class ExportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "ExportError";
  }
}

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

function exportRow(r: Record<string, unknown>): ExportRow {
  return {
    ...(r as unknown as ExportRow),
    created_at: iso(r.created_at)!,
    heartbeat_at: iso(r.heartbeat_at)!,
    finished_at: iso(r.finished_at),
    expires_at: iso(r.expires_at),
    files_total: Number(r.files_total ?? 0),
    files_done: Number(r.files_done ?? 0),
    bytes_total: Number(r.bytes_total ?? 0),
    bytes_done: Number(r.bytes_done ?? 0),
    size: r.size == null ? null : Number(r.size),
  };
}

export const archiveKey = (id: string) => `exports/${id}.tar`;
const dumpKey = (id: string) => `exports/${id}.dump`;
const filesKey = (id: string) => `exports/${id}.files`;
const ID_RE = /^[a-f0-9]{32}$/;

/** Only in a CompassDocs Cloud workspace. */
export function workspaceExportAvailable(): boolean {
  return isCloud();
}

// --- Starting ----------------------------------------------------------------------------------

const G = globalThis as unknown as { __compassExports?: Map<string, AbortController> };
const running = () => (G.__compassExports ??= new Map());

/** Stop every export this process is making (the drain, lib/shutdown): each is marked failed and its pieces removed. */
export async function abortWorkspaceExports(): Promise<void> {
  for (const c of running().values()) c.abort(new ExportError("The workspace restarted during the export. Start it again.", 503, "interrupted"));
}

/** Start an export. Refused while one runs, and past MAX_PER_DAY in 24 hours. */
export async function startWorkspaceExport(actor: AuditActor, ip: string | null, opts: { run?: boolean } = {}): Promise<ExportRow> {
  if (!workspaceExportAvailable()) throw new ExportError("Not found.", 404, "not_found");
  await failStale();
  const id = randomBytes(16).toString("hex");
  const row = await withAdvisoryLock("workspace-export", async (client) => {
    const busy = await client.query("SELECT 1 FROM workspace_exports WHERE status = 'running'");
    if (busy.rows[0]) throw new ExportError("An export is already being made. Wait for it to finish.", 409, "export_running");
    const day = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM workspace_exports WHERE created_at > now() - interval '1 day'");
    if ((day.rows[0]?.n ?? 0) >= MAX_PER_DAY) throw new ExportError(`At most ${MAX_PER_DAY} exports can be started in 24 hours. Try again later.`, 429, "export_limit");
    const r = await client.query(
      `INSERT INTO workspace_exports (id, status, stage, requested_by, requested_by_name) VALUES ($1, 'running', 'database', $2, $3) RETURNING *`,
      [id, actor.id ?? null, actor.name ?? ""]
    );
    return exportRow(r.rows[0]);
  });
  await audit({ actor, action: "workspace.export_started", targetType: "workspace_export", targetId: id, targetLabel: "Workspace export", ip });
  if (opts.run !== false) void runWorkspaceExport(id, actor);
  return row;
}

// --- Making it ---------------------------------------------------------------------------------

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** A stream that counts and hashes what passes through it. */
function meter(onBytes?: (n: number) => void): Transform & { bytes: () => number; sha256: () => string } {
  const hash = createHash("sha256");
  let n = 0;
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      hash.update(chunk);
      onBytes?.(n);
      cb(null, chunk);
    },
  }) as Transform & { bytes: () => number; sha256: () => string };
  let digest: string | null = null;
  t.bytes = () => n;
  t.sha256 = () => (digest ??= hash.digest("hex"));
  return t;
}

function pgBin(name: "pg_dump"): string {
  const dir = process.env.COMPASSDOCS_PG_BIN;
  return dir ? join(dir, name) : name;
}

/** pg_dump of the whole database, custom format (what lib/backup makes), into the store. */
async function dumpDatabase(store: FileStore, key: string, signal: AbortSignal, onBytes: (n: number) => void): Promise<{ size: number; sha256: string }> {
  const env = await pgEnv();
  const args = ["-Fc", "--no-owner", "--no-privileges", ...EXCLUDED_TABLE_DATA.map((t) => `--exclude-table-data=${t}`)];
  const child = spawn(pgBin("pg_dump"), args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + d.toString()).slice(-2000)));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  const onAbort = () => child.kill("SIGTERM");
  signal.addEventListener("abort", onAbort, { once: true });
  const m = meter(onBytes);
  // Both are waited for, whatever happens to either: the caller removes the piece only once nothing writes it.
  const write = store.writeStream(key, child.stdout.pipe(m));
  try {
    const [w, x] = await Promise.allSettled([write, exited]);
    signal.throwIfAborted();
    if (x.status === "rejected") throw x.reason;
    if (x.value !== 0) throw new Error(`pg_dump exited ${x.value}: ${stderr.trim().split("\n").pop() ?? ""}`.trim());
    if (w.status === "rejected") throw w.reason;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return { size: m.bytes(), sha256: m.sha256() };
}

/** Every stored file, as the backup's files archive, into the store. */
async function archiveFiles(
  store: FileStore,
  key: string,
  listed: StoredFile[],
  signal: AbortSignal,
  progress: (p: { files: number; bytes: number }) => void
): Promise<{ size: number; sha256: string; files: number; bytes: number; vanished: number }> {
  const out = new PassThrough();
  const m = meter();
  const write = store.writeStream(key, out.pipe(m));
  let result;
  try {
    result = await writeStoreTar(out, fileStore(), listed, progress, signal);
    out.end();
  } catch (e) {
    out.destroy(e as Error);
    await write.catch(() => {});
    throw e;
  }
  await write;
  return { size: m.bytes(), sha256: m.sha256(), ...result };
}

export interface ExportManifest {
  format: typeof MANIFEST_FORMAT;
  version: typeof MANIFEST_VERSION;
  created_at: string;
  compassdocs_version: string;
  workspace_id: string | null;
  database: { file: string; format: "pg_dump custom (-Fc)"; size: number; sha256: string; rows_left_out_of: string[] };
  files: { file: string; format: "ustar"; size: number; sha256: string; count: number; bytes: number; skipped_while_exporting: number };
  file_store: "local" | "blob";
}

/** The README in the archive: how to bring the export into a self-hosted CompassDocs. */
export function exportReadme(m: ExportManifest): string {
  const dump = m.database.file;
  const files = m.files.file;
  const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;
  return `# CompassDocs workspace export

Made ${m.created_at} by CompassDocs ${m.compassdocs_version}${m.workspace_id ? ` (workspace ${m.workspace_id})` : ""}.

| File | What it is | Size | SHA-256 |
| --- | --- | --- | --- |
| \`${dump}\` | The database, as \`pg_dump --format=custom\` (PostgreSQL 16) | ${mb(m.database.size)} | \`${m.database.sha256}\` |
| \`${files}\` | Every stored file (attachments, images, logos, newsletter and helpdesk files), ${m.files.count} files, as a POSIX tar | ${mb(m.files.size)} | \`${m.files.sha256}\` |
| \`manifest.json\` | The same facts, for a script | | |

Check a file with \`sha256sum <file>\` (Linux) or \`shasum -a 256 <file>\` (macOS).

The two \`${dump.replace(/\.dump$/, "")}.*\` files are a CompassDocs backup set, unencrypted: anyone who has them can read the whole workspace. Keep them as you would the workspace itself.

## Bring it into a self-hosted CompassDocs

You need CompassDocs ${m.compassdocs_version} or newer (https://github.com/Felix-AZ-Solutions-LLC/CompassDocs), installed as its README says (\`install.sh\`, or Docker Compose). Importing **replaces** the database of the install you import into: use a new install.

### With Settings → Backups (recommended)

1. Install CompassDocs and finish the first-run setup (any administrator account: it is replaced by the import).
2. Copy both files into the install's backups volume:

   \`\`\`bash
   docker compose cp ${dump} app:/backups/
   docker compose cp ${files} app:/backups/
   \`\`\`

3. Sign in, open **Settings → Backups**: the export is listed as a backup taken ${m.created_at.slice(0, 10)}, "With attachments". Press **Restore** and confirm.
4. Restart the app (\`docker compose restart app\`) and sign in with your workspace's own accounts.

### By hand

\`\`\`bash
# The database (into an empty database the app's user owns):
pg_restore --clean --if-exists --no-owner --no-privileges -d "$DATABASE_URL" ${dump}
# The files, into the uploads folder (COMPASSDOCS_UPLOAD_DIR, /uploads in the image):
tar -xf ${files} -C /path/to/uploads
\`\`\`

Then start CompassDocs. It brings the database's schema up to its own version at start-up.

## What doesn't come with it

- **Saved credentials.** Passwords and keys the workspace saved for its integrations (SMTP, Microsoft 365, single sign-on, SCIM, Slack and Teams, the directory sync, Duo, helpdesk mailboxes) are in the database encrypted with this workspace's encryption key, which is not in the export. Either ask CompassDocs support for the key before you import and set it as \`COMPASSDOCS_SECRET_KEY\` on the new install, or enter those credentials again in Settings after importing.
- **Who was signed in.** Sessions are left out (and ${m.database.rows_left_out_of.join(", ")} with them): everyone signs in again.
- **The license.** A CompassDocs Cloud license is for its workspace; install a license for the new install in Settings → License.
- **Hosting.** The address, HTTPS, backups and updates of the new install are yours to set up (README "Self-hosting").
${m.files.skipped_while_exporting ? `\n${m.files.skipped_while_exporting} file(s) were deleted while the export was being made and are not in it.\n` : ""}`;
}

async function progressUpdate(id: string, fields: Partial<Pick<ExportRow, "stage" | "files_total" | "files_done" | "bytes_total" | "bytes_done">>): Promise<void> {
  const sets: string[] = ["heartbeat_at = now()"];
  const params: unknown[] = [id];
  for (const [k, v] of Object.entries(fields)) {
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  await pool().query(`UPDATE workspace_exports SET ${sets.join(", ")} WHERE id = $1 AND status = 'running'`, params);
}

function throttle(fn: () => void): () => void {
  let last = 0;
  return () => {
    const now = Date.now();
    if (now - last < PROGRESS_EVERY_MS) return;
    last = now;
    fn();
  };
}

/**
 * Make the export started as `id` (in the background; never throws). On
 * failure the row says why, and every piece written is removed.
 */
export async function runWorkspaceExport(id: string, actor: AuditActor = { name: "system" }): Promise<ExportRow | null> {
  if (!ID_RE.test(id)) return null;
  const controller = new AbortController();
  running().set(id, controller);
  const signal = controller.signal;
  const store = exportStore();
  const now = new Date();
  const base = `compassdocs-${stamp(now)}`;
  const folder = `compassdocs-export-${stamp(now)}`;
  try {
    // 1. The database.
    let dbBytes = 0;
    const tickDb = throttle(() => void progressUpdate(id, { bytes_done: dbBytes }).catch(() => {}));
    const db = await dumpDatabase(store, dumpKey(id), signal, (n) => {
      dbBytes = n;
      tickDb();
    });

    // 2. The files.
    const listed: StoredFile[] = [];
    for await (const f of fileStore().list()) if (!excluded(f.key, null)) listed.push(f);
    listed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const bytesTotal = listed.reduce((n, f) => n + f.size, 0);
    await progressUpdate(id, { stage: "files", files_total: listed.length, bytes_total: bytesTotal, files_done: 0, bytes_done: 0 });
    let done = { files: 0, bytes: 0 };
    const tickFiles = throttle(() => void progressUpdate(id, { files_done: done.files, bytes_done: done.bytes }).catch(() => {}));
    const files = await archiveFiles(store, filesKey(id), listed, signal, (p) => {
      done = p;
      tickFiles();
    });

    // 3. The archive.
    await progressUpdate(id, { stage: "archive", files_done: files.files, bytes_done: 0, bytes_total: db.size + files.size });
    const manifest: ExportManifest = {
      format: MANIFEST_FORMAT,
      version: MANIFEST_VERSION,
      created_at: now.toISOString(),
      compassdocs_version: pkg.version,
      workspace_id: process.env.COMPASSDOCS_WORKSPACE_ID?.trim() || null,
      database: { file: `${base}.dump`, format: "pg_dump custom (-Fc)", size: db.size, sha256: db.sha256, rows_left_out_of: EXCLUDED_TABLE_DATA },
      files: { file: `${base}.files.tar`, format: "ustar", size: files.size, sha256: files.sha256, count: files.files, bytes: files.bytes, skipped_while_exporting: files.vanished },
      file_store: fileStoreKind(),
    };
    let copied = 0;
    const tickArchive = throttle(() => void progressUpdate(id, { bytes_done: copied }).catch(() => {}));
    const outer = await writeOuterArchive(store, id, folder, manifest, signal, (n) => {
      copied = n;
      tickArchive();
    });

    const fileName = `${folder}.tar`;
    const r = await pool().query(
      `UPDATE workspace_exports SET status = 'ready', stage = 'done', finished_at = now(), heartbeat_at = now(), size = $2, sha256 = $3, file_name = $4,
              expires_at = now() + make_interval(secs => $5), bytes_done = bytes_total, error = NULL
        WHERE id = $1 AND status = 'running' RETURNING *`,
      [id, outer.size, outer.sha256, fileName, EXPORT_TTL_MS / 1000]
    );
    await Promise.all([store.delete(dumpKey(id)), store.delete(filesKey(id))]).catch(() => {});
    if (!r.rows[0]) {
      // Deleted or failed by someone else while it ran: nothing to keep.
      await store.delete(archiveKey(id)).catch(() => {});
      return null;
    }
    const row = exportRow(r.rows[0]);
    await audit({
      actor,
      action: "workspace.export_ready",
      targetType: "workspace_export",
      targetId: id,
      targetLabel: fileName,
      details: { size: outer.size, sha256: outer.sha256, files: files.files, database_bytes: db.size, expires_at: row.expires_at },
    });
    logEvent("info", "workspace.export_ready", { message: `Workspace export ${id} is ready (${outer.size} bytes).` });
    return row;
  } catch (e) {
    const reason = signal.aborted && signal.reason instanceof ExportError ? signal.reason.message : e instanceof Error ? e.message.split("\n")[0].slice(0, 300) : String(e);
    await Promise.all([store.delete(dumpKey(id)), store.delete(filesKey(id)), store.delete(archiveKey(id))]).catch(() => {});
    await pool()
      .query(`UPDATE workspace_exports SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1 AND status = 'running'`, [id, reason])
      .catch(() => {});
    await audit({ actor, action: "workspace.export_failed", targetType: "workspace_export", targetId: id, targetLabel: "Workspace export", details: { error: reason } });
    logEvent("error", "workspace.export_failed", { message: `Workspace export ${id} failed: ${reason}` });
    return null;
  } finally {
    running().delete(id);
  }
}

/** The outer archive: README, manifest, then the two parts read back from the store. */
async function writeOuterArchive(
  store: FileStore,
  id: string,
  folder: string,
  manifest: ExportManifest,
  signal: AbortSignal,
  onBytes: (n: number) => void
): Promise<{ size: number; sha256: string }> {
  const out = new PassThrough();
  const m = meter();
  const write = store.writeStream(archiveKey(id), out.pipe(m));
  const mtime = Date.parse(manifest.created_at);
  let copied = 0;
  const entry = async (name: string, body: Buffer | { key: string; size: number }) => {
    signal.throwIfAborted();
    const size = Buffer.isBuffer(body) ? body.length : body.size;
    await tarWrite(out, tarHeader(`${folder}/${name}`, size, 0o644, mtime, "0"));
    if (Buffer.isBuffer(body)) await tarWrite(out, body);
    else {
      let n = 0;
      const src: Readable = store.readStream(body.key);
      try {
        for await (const chunk of src) {
          signal.throwIfAborted();
          const buf = chunk as Buffer;
          n += buf.length;
          if (n > size) throw new Error(`The export's ${name} grew while it was being archived.`);
          await tarWrite(out, buf);
          copied += buf.length;
          onBytes(copied);
        }
      } finally {
        src.destroy();
      }
      if (n !== size) throw new Error(`The export's ${name} could not be read back whole (${n} of ${size} bytes).`);
    }
    await tarWrite(out, tarPadding(size));
  };
  try {
    await entry("README.md", Buffer.from(exportReadme(manifest), "utf8"));
    await entry("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"));
    const d = await store.stat(dumpKey(id));
    const f = await store.stat(filesKey(id));
    if (!d || !f) throw new Error("The export's parts went missing before they were archived.");
    await entry(manifest.database.file, { key: dumpKey(id), size: d.size });
    await entry(manifest.files.file, { key: filesKey(id), size: f.size });
    await tarWrite(out, TAR_END);
    out.end();
  } catch (e) {
    out.destroy(e as Error);
    await write.catch(() => {});
    throw e;
  }
  await write;
  return { size: m.bytes(), sha256: m.sha256() };
}

// --- Reading, downloading, deleting ------------------------------------------------------------

/** "bytes=a-b" / "bytes=a-" / "bytes=-n" against `size`; null for none or anything else (the whole file is sent). */
export function parseRange(h: string | null, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return "unsatisfiable";
  return { start, end };
}


export async function listWorkspaceExports(limit = 10): Promise<ExportRow[]> {
  await failStale();
  const r = await pool().query("SELECT * FROM workspace_exports ORDER BY created_at DESC LIMIT $1", [limit]);
  return r.rows.map(exportRow);
}

export async function getWorkspaceExport(id: string): Promise<ExportRow | null> {
  if (!ID_RE.test(id)) return null;
  const r = await pool().query("SELECT * FROM workspace_exports WHERE id = $1", [id]);
  return r.rows[0] ? exportRow(r.rows[0]) : null;
}

/** A ready export's archive (or a byte range of it) to send, or why not. Counts and audits a download from its first byte. */
export async function openWorkspaceExport(
  id: string,
  actor: AuditActor,
  ip: string | null,
  range?: { start: number; end: number }
): Promise<{ row: ExportRow; stream: Readable }> {
  const row = await getWorkspaceExport(id);
  if (!row || row.status === "deleted") throw new ExportError("That export doesn't exist.", 404, "not_found");
  if (row.status !== "ready" || !row.expires_at || new Date(row.expires_at).getTime() <= Date.now()) {
    throw new ExportError(row.status === "running" ? "That export isn't ready yet." : "That export is no longer available. Start a new one.", 410, "not_available");
  }
  const stream = exportStore().readStream(archiveKey(id), range);
  if (!range || range.start === 0) {
    await pool().query("UPDATE workspace_exports SET downloads = downloads + 1, last_downloaded_at = now() WHERE id = $1", [id]);
    await audit({ actor, action: "workspace.export_downloaded", targetType: "workspace_export", targetId: id, targetLabel: row.file_name, details: { size: row.size, sha256: row.sha256 }, ip });
  }
  return { row, stream };
}

/** Delete a finished (or failed) export's archive now; a running one is stopped. */
export async function deleteWorkspaceExport(id: string, actor: AuditActor, ip: string | null): Promise<void> {
  const row = await getWorkspaceExport(id);
  if (!row || row.status === "deleted") throw new ExportError("That export doesn't exist.", 404, "not_found");
  running().get(id)?.abort(new ExportError("Deleted while it was being made.", 409, "deleted"));
  await pool().query("UPDATE workspace_exports SET status = 'deleted', finished_at = COALESCE(finished_at, now()) WHERE id = $1", [id]);
  const store = exportStore();
  await Promise.all([store.delete(archiveKey(id)), store.delete(dumpKey(id)), store.delete(filesKey(id))]).catch(() => {});
  await audit({ actor, action: "workspace.export_deleted", targetType: "workspace_export", targetId: id, targetLabel: row.file_name ?? "Workspace export", ip });
}

/** Running exports whose heartbeat stopped (a restart, a crash) are failed; their pieces are removed. */
async function failStale(): Promise<void> {
  const r = await pool().query(
    `UPDATE workspace_exports SET status = 'failed', finished_at = now(), error = 'The workspace restarted during the export. Start it again.'
      WHERE status = 'running' AND heartbeat_at < now() - make_interval(secs => $1) RETURNING id`,
    [STALE_MS / 1000]
  );
  if (!r.rows.length) return;
  const store = exportStore();
  for (const { id } of r.rows as { id: string }[]) {
    if (running().has(id)) continue;
    await Promise.all([store.delete(archiveKey(id)), store.delete(dumpKey(id)), store.delete(filesKey(id))]).catch(() => {});
  }
}

/**
 * The minute tick (cloud mode): exports past their time are removed (the
 * row stays, "expired"), stale running ones fail, and an export object no
 * row knows (a crash between the two) is removed. Idempotent.
 */
export async function sweepWorkspaceExports(): Promise<{ expired: number }> {
  if (!workspaceExportAvailable()) return { expired: 0 };
  await failStale();
  const r = await pool().query(
    `UPDATE workspace_exports SET status = 'expired' WHERE status = 'ready' AND expires_at <= now() RETURNING id`
  );
  const store = exportStore();
  for (const { id } of r.rows as { id: string }[]) await store.delete(archiveKey(id)).catch(() => {});
  // Objects no running or ready export owns.
  try {
    const keep = new Set(
      (await pool().query<{ id: string }>("SELECT id FROM workspace_exports WHERE status IN ('running', 'ready')")).rows.map((x) => x.id)
    );
    for await (const o of store.list()) {
      const id = o.key.slice("exports/".length, "exports/".length + 32);
      if (!keep.has(id) && !running().has(id) && Date.now() - o.modifiedAt.getTime() > STALE_MS) await store.delete(o.key).catch(() => {});
    }
  } catch {
    /* the next tick */
  }
  return { expired: r.rows.length };
}
