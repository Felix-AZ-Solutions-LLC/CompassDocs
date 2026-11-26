import { spawn } from "child_process";
import { withDatabasePassword } from "./db-url";
import { createReadStream } from "fs";
import { mkdir, readdir, stat, unlink } from "fs/promises";
import { join, basename } from "path";
import { activeDestinations } from "./backup-destinations";
import { getAllSettings, pool } from "./db";
import { encryptFile, decryptFile, isEncryptedFile } from "./secretbox";

// Full backups. The database is dumped with pg_dump (custom format) and,
// since 1.20.27, the uploads volume (attachments, images, mail attachments)
// is archived beside it: a backup is a SET of two files with one name stem,
//
//   compassdocs-YYYYMMDD-HHMMSS.dump.enc        the database
//   compassdocs-YYYYMMDD-HHMMSS.files.tar.enc   the uploads (lib/backup-files)
//
// both encrypted with the workspace master key (AES-256-GCM) before they
// touch disk or an off-site bucket, and mirrored to every configured
// off-site destination (S3 / Azure). The master key file is never in a
// backup: keep COMPASSDOCS_SECRET_KEY (or a copy of the key file) somewhere
// safe that is NOT the backup bucket; without it no backup can be read.
// Restore uses pg_restore --clean for the database and adds the archived
// files back to the uploads volume. A backup made before 1.20.27 has no
// files half and restores the database only, as before.
//
// 1.20.27 (security review M12): deleting or pruning backups removes the
// LOCAL copies only. Off-site copies are never deleted from inside the app,
// so an administrator's account (or ransomware using one) cannot wipe both;
// retire them with the bucket's own lifecycle rules and object lock.
//
// 1.20.27 (security review M3): a restore keeps the audit log's rows that
// are newer than the backup, so restoring yesterday's backup cannot erase
// what was done since (restoreBackup).

const PREFIX = "compassdocs-";
const EXT_ENC = ".dump.enc";
const FILES_EXT = ".files.tar.enc";
const ADVISORY_LOCK = 728342; // distinct from the schema-init lock

export function backupDir(): string {
  return process.env.COMPASSDOCS_BACKUP_DIR || "/backups";
}

// pg_dump/pg_restore live on PATH in the Docker image; COMPASSDOCS_PG_BIN lets
// a dev point at a specific install (e.g. Homebrew / a versioned path).
function pgBin(name: "pg_dump" | "pg_restore"): string {
  const dir = process.env.COMPASSDOCS_PG_BIN;
  return dir ? join(dir, name) : name;
}

// Derive libpq PG* env from DATABASE_URL so credentials never hit the argv/ps.
function pgEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set.");
  // 1.21.0: with DATABASE_PASSWORD (lib/db-url).
  const url = new URL(withDatabasePassword(raw));
  env.PGHOST = url.hostname;
  env.PGPORT = url.port || "5432";
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  env.PGDATABASE = url.pathname.replace(/^\//, "") || "compassdocs";
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  else if (process.env.DATABASE_SSL === "require") env.PGSSLMODE = "require";
  else if (process.env.DATABASE_SSL === "disable") env.PGSSLMODE = "disable";
  return env;
}

/**
 * 1.20.31: a dump made by a newer pg_dump (17+) carries session settings an
 * older server doesn't know, such as `SET transaction_timeout = 0;`. pg_restore
 * reports that as its only error and exits 1 although everything else was
 * restored. Those, and nothing else, are tolerated: every error pg_restore
 * printed must be an unrecognized configuration parameter on a SET statement.
 */
export function onlyUnknownSettingErrors(stderr: string): boolean {
  const errors = stderr.split("\n").filter((l) => /\berror:/i.test(l));
  if (!errors.length) return false;
  const known = /could not execute query: ERROR:\s+unrecognized configuration parameter "[a-z_.]+"/i;
  if (!errors.every((l) => known.test(l))) return false;
  const commands = stderr.split("\n").filter((l) => /^\s*Command was:/i.test(l));
  return commands.every((l) => /^\s*Command was:\s*SET\s+[a-z_.]+\s*(=|TO)/i.test(l));
}

function run(cmd: string, args: string[], tolerate?: (stderr: string) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: pgEnv() });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 || (code === 1 && tolerate?.(stderr))
        ? resolve()
        : reject(new Error(`${basename(cmd)} exited ${code}: ${stderr.trim().slice(-500)}`))
    );
  });
}

// Only allow our own dump filenames — blocks path traversal on name params.
export function isValidBackupName(name: string): boolean {
  return /^compassdocs-\d{8}-\d{6}\.dump(\.enc)?$/.test(name);
}

/** The uploads half of a set (1.20.27). */
export function isValidFilesName(name: string): boolean {
  return /^compassdocs-\d{8}-\d{6}\.files\.tar\.enc$/.test(name);
}

/** Either file of a set: what the download route serves. */
export function isValidBackupFile(name: string): boolean {
  return isValidBackupName(name) || isValidFilesName(name);
}

/** The files half that belongs with a database dump's name. */
export function filesNameFor(dumpName: string): string {
  return dumpName.replace(/\.dump(\.enc)?$/, FILES_EXT);
}

function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** When a backup was taken, from its name (UTC); null when the name says nothing. */
export function backupTakenAt(name: string): Date | null {
  const m = /^compassdocs-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\./.exec(name);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface BackupInfo {
  name: string;
  size: number;
  created_at: string; // ISO
  /** The uploads half (1.20.27); null for a backup made before 1.20.27, or one whose files half is missing. */
  files: { name: string; size: number } | null;
}

export interface CreateBackupResult extends BackupInfo {
  uploaded: string[]; // destination labels the copy reached
  uploadErrors: string[];
  /** Files and bytes the uploads archive holds (1.20.27), and files deleted while it was written (left out). */
  archived: { files: number; bytes: number; vanished: number };
}

export async function createBackup(now: Date = new Date()): Promise<CreateBackupResult> {
  const dir = backupDir();
  await mkdir(dir, { recursive: true });
  const name = `${PREFIX}${stamp(now)}${EXT_ENC}`;
  const path = join(dir, name);
  const filesName = filesNameFor(name);
  const filesPath = join(dir, filesName);

  // Dump to a scratch file, encrypt it into place, then shred the plaintext.
  // 1.20.27 (security review, Low): the dump runs inside the try, so a
  // failed or interrupted pg_dump never leaves a plaintext file behind.
  const plain = path + ".tmp";
  try {
    await run(pgBin("pg_dump"), ["-Fc", "--no-owner", "--no-privileges", "-f", plain]);
    await encryptFile(plain, path);
  } finally {
    await unlink(plain).catch(() => {});
  }

  // 1.20.27 (security review H5): the uploads volume, as the set's second file.
  const filesPlain = filesPath + ".tmp";
  let archived = { files: 0, bytes: 0, vanished: 0 };
  try {
    const { writeFilesArchive } = await import("./backup-files");
    archived = await writeFilesArchive(filesPlain, { skip: [dir] });
    await encryptFile(filesPlain, filesPath);
  } catch (e) {
    // A set without its files half is not a backup to keep: remove the dump too.
    await unlink(path).catch(() => {});
    await unlink(filesPath).catch(() => {});
    throw new Error(`Could not archive the uploads: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await unlink(filesPlain).catch(() => {});
  }
  const info = await backupInfo(name);

  // Mirror to any configured off-site destinations (never fail the local backup
  // because a remote is down — just report it).
  const uploaded: string[] = [];
  const uploadErrors: string[] = [];
  for (const dest of await activeDestinations()) {
    try {
      await dest.upload(path, name);
      await dest.upload(filesPath, filesName);
      uploaded.push(dest.label);
    } catch (e: any) {
      uploadErrors.push(`${dest.label}: ${e?.message || "upload failed"}`);
    }
  }
  return { ...info, uploaded, uploadErrors, archived };
}

async function backupInfo(name: string): Promise<BackupInfo> {
  const s = await stat(join(backupDir(), name));
  const filesName = filesNameFor(name);
  const f = await stat(join(backupDir(), filesName)).catch(() => null);
  return {
    name,
    size: s.size,
    created_at: new Date(s.mtimeMs).toISOString(),
    files: f && f.isFile() ? { name: filesName, size: f.size } : null,
  };
}

export async function listBackups(): Promise<BackupInfo[]> {
  let files: string[];
  try {
    files = await readdir(backupDir());
  } catch {
    return []; // dir not created yet
  }
  const infos = await Promise.all(
    files.filter(isValidBackupName).map((n) => backupInfo(n))
  );
  return infos.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function backupPath(name: string): string | null {
  if (!isValidBackupFile(name)) return null;
  return join(backupDir(), name);
}

export function backupReadStream(name: string) {
  const p = backupPath(name);
  if (!p) return null;
  return createReadStream(p);
}

/**
 * Delete a backup set's LOCAL files (the database dump and its uploads
 * archive). 1.20.27 (security review M12): off-site copies are never
 * deleted from the app; the bucket's lifecycle rules retire them.
 */
export async function deleteBackup(name: string): Promise<boolean> {
  if (!isValidBackupName(name)) return false;
  const p = backupPath(name);
  if (!p) return false;
  try {
    await unlink(p);
  } catch {
    return false;
  }
  await unlink(join(backupDir(), filesNameFor(name))).catch(() => {});
  return true;
}

/** Keep the newest `keep` local backups, delete the rest (local only, as deleteBackup). Returns removed count. */
export async function pruneBackups(keep: number): Promise<number> {
  if (!Number.isFinite(keep) || keep <= 0) return 0;
  const all = await listBackups();
  const toRemove = all.slice(keep);
  let n = 0;
  for (const b of toRemove) if (await deleteBackup(b.name)) n++;
  return n;
}

export interface RestoreResult {
  /** Files put back in the uploads volume; null when the backup has no files half (made before 1.20.27). */
  files: number | null;
  /** Audit rows written after the backup and kept through the restore (security review M3). */
  audit_rows_kept: number;
  /** Where the kept audit rows were saved when they could not be put back (a table name), else null. */
  audit_rows_saved_in: string | null;
}

/**
 * A restore that stopped part-way (1.20.27, second review, Low), saying
 * exactly what it had done: `stage` "files" means nothing was changed
 * except attachments already put back (`files`); "database" means the
 * attachments were put back and the database restore failed (pg_restore
 * --clean may have left it partly restored).
 */
export class RestoreError extends Error {
  constructor(
    message: string,
    readonly stage: "files" | "database",
    readonly files: number | null
  ) {
    super(message);
    this.name = "RestoreError";
  }
}

/** Decrypt `src` to a scratch file next to it when it is encrypted; the caller deletes `scratch`. */
async function plainCopy(src: string): Promise<{ path: string; scratch: string | null }> {
  if (!(await isEncryptedFile(src))) return { path: src, scratch: null };
  const scratch = src + ".plain.tmp";
  try {
    await decryptFile(src, scratch);
  } catch (e) {
    await unlink(scratch).catch(() => {});
    throw e;
  }
  return { path: scratch, scratch };
}

/**
 * Restore the workspace from a local backup set (DESTRUCTIVE for the
 * database — pg_restore --clean; the uploads are added back, never removed).
 *
 * 1.20.27 (security review M3): the audit log is not rolled back. Its rows
 * are copied to a temporary table on a connection of our own before the
 * restore (temporary tables are never in a dump, so pg_restore --clean
 * cannot touch it) and the ones the restored log lacks are put back after,
 * with their own ids and times; the identity sequence then moves past them.
 */
export async function restoreBackup(name: string): Promise<RestoreResult> {
  const p = backupPath(name);
  if (!p || !isValidBackupName(name)) throw new Error("Invalid backup name.");
  await stat(p); // throws if missing
  const filesPath = join(backupDir(), filesNameFor(name));
  const hasFiles = Boolean(await stat(filesPath).catch(() => null));

  // 1.20.27 (second review, Low): the attachments go back FIRST. Adding
  // files never removes one, so if this step fails the database has not
  // been touched and the workspace is as it was; if the database step
  // fails after it, the error says the attachments were already put back.
  // Both halves are decrypted before either is applied, so a damaged or
  // wrongly keyed file stops the restore before anything changes.
  let files: number | null = null;
  const archive = hasFiles ? await plainCopy(filesPath) : null;
  let dump: { path: string; scratch: string | null } | null = null;
  try {
    dump = await plainCopy(p);
    if (archive) {
      try {
        const { extractFilesArchive } = await import("./backup-files");
        files = (await extractFilesArchive(archive.path)).files;
      } catch (e) {
        throw new RestoreError(
          `The attachments could not be restored, so the database was not touched: ${e instanceof Error ? e.message : String(e)}`,
          "files",
          null
        );
      }
    }
  } catch (e) {
    if (archive?.scratch) await unlink(archive.scratch).catch(() => {});
    if (dump?.scratch) await unlink(dump.scratch).catch(() => {});
    throw e;
  }
  if (archive?.scratch) await unlink(archive.scratch).catch(() => {});

  const keeper = await pool().connect();
  let audit_rows_kept = 0;
  let audit_rows_saved_in: string | null = null;
  let failure: unknown = null;
  try {
    await keeper.query("DROP TABLE IF EXISTS pg_temp.audit_keep");
    await keeper.query("CREATE TEMP TABLE audit_keep AS SELECT * FROM audit_log");
    try {
      const env = pgEnv();
      await run(pgBin("pg_restore"), [
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "-d",
        env.PGDATABASE as string,
        dump.path,
      ], onlyUnknownSettingErrors);
    } catch (e) {
      failure = e;
    } finally {
      if (dump.scratch) await unlink(dump.scratch).catch(() => {});
    }
  } finally {
    try {
      audit_rows_kept = await putBackAuditRows(keeper);
    } catch (e) {
      console.error("[backup] could not put the audit log's newer rows back after the restore:", e);
    }
    // 1.20.27 (second review, Low): a restore that failed with audit_log
    // gone (or a put-back that failed) must not lose the kept rows: they are
    // saved in a table of their own, and the log and the error say where.
    if (audit_rows_kept === 0) audit_rows_saved_in = await saveKeptAuditRows(keeper).catch(() => null);
    await keeper.query("DROP TABLE IF EXISTS pg_temp.audit_keep").catch(() => {});
    keeper.release();
  }
  if (failure) {
    const reason = failure instanceof Error ? failure.message : String(failure);
    const filesPart = files === null ? "" : `The attachments were already put back (${files} file${files === 1 ? "" : "s"}). `;
    const auditPart = audit_rows_saved_in ? ` The audit log's rows were saved in the table ${audit_rows_saved_in}.` : "";
    throw new RestoreError(`${filesPart}The database restore failed: ${reason}${auditPart}`, "database", files);
  }
  return { files, audit_rows_kept, audit_rows_saved_in };
}

/**
 * Keep the copied audit rows in a real table when they could not be put
 * back (1.20.27): only when audit_log is missing, or lacks rows the copy
 * has. Answers the table's name, or null when nothing needed saving.
 */
async function saveKeptAuditRows(client: import("pg").PoolClient): Promise<string | null> {
  const present = await client.query("SELECT to_regclass('public.audit_log') IS NOT NULL AS ok");
  if (present.rows[0]?.ok) {
    const missing = await client.query("SELECT 1 FROM audit_keep k WHERE NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.id = k.id) LIMIT 1");
    if (!missing.rowCount) return null;
  } else {
    const any = await client.query("SELECT 1 FROM audit_keep LIMIT 1");
    if (!any.rowCount) return null;
  }
  const name = `audit_log_kept_${Date.now()}`;
  await client.query(`CREATE TABLE ${name} AS SELECT * FROM audit_keep`);
  console.error(`[backup] the audit log's rows were saved in the table ${name}; put them back with INSERT ... OVERRIDING SYSTEM VALUE once the database is restored.`);
  return name;
}

/** Put back the kept audit rows the restored log lacks; answers how many. */
async function putBackAuditRows(client: import("pg").PoolClient): Promise<number> {
  const exists = await client.query("SELECT to_regclass('public.audit_log') IS NOT NULL AS ok");
  if (!exists.rows[0]?.ok) return 0;
  // Only the columns both tables have: a backup from an older version may lack a newer column.
  const cols = await client.query<{ column_name: string }>(
    `SELECT a.column_name FROM information_schema.columns a
       JOIN information_schema.columns k ON k.column_name = a.column_name
        AND k.table_name = 'audit_keep' AND k.table_schema LIKE 'pg_temp%'
      WHERE a.table_schema = 'public' AND a.table_name = 'audit_log'
      ORDER BY a.ordinal_position`
  );
  const list = cols.rows.map((r) => `"${r.column_name.replace(/"/g, '""')}"`).join(", ");
  if (!list.includes('"id"')) return 0;
  const r = await client.query(
    `INSERT INTO audit_log (${list}) OVERRIDING SYSTEM VALUE
     SELECT ${list} FROM audit_keep k WHERE NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.id = k.id)
     ORDER BY k.id`
  );
  await client.query(
    `SELECT setval(pg_get_serial_sequence('audit_log', 'id'), GREATEST((SELECT COALESCE(max(id), 0) FROM audit_log), 1))`
  );
  return r.rowCount ?? 0;
}

// --- Scheduling --------------------------------------------------------------

function frequencyMs(freq: string): number {
  if (freq === "daily") return 24 * 60 * 60 * 1000;
  if (freq === "weekly") return 7 * 24 * 60 * 60 * 1000;
  return 0; // "off"
}

/**
 * Run a scheduled backup if one is due (newest backup older than the configured
 * frequency). Guarded by a Postgres advisory lock so only one app instance runs
 * it. Safe to call frequently (e.g. hourly).
 */
export async function runScheduledBackupIfDue(now: Date = new Date()): Promise<boolean> {
  const settings = await getAllSettings();
  const interval = frequencyMs(settings.backup_frequency || "off");
  if (interval === 0) return false;

  const client = await pool().connect();
  try {
    const got = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [ADVISORY_LOCK]);
    if (!got.rows[0].ok) return false; // another instance holds it
    try {
      const backups = await listBackups();
      const newest = backups[0];
      const due = !newest || now.getTime() - new Date(newest.created_at).getTime() >= interval;
      if (!due) return false;
      await createBackup(now);
      await pruneBackups(Number(settings.backup_keep) || 7);
      return true;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK]).catch(() => {});
    }
  } finally {
    client.release();
  }
}
