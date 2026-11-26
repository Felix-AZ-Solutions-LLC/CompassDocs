// The uploads half of a backup set (1.20.27, security review H5).
//
// A backup used to be the database alone, so a restore on a new host brought
// back every document and ticket and none of their attachments, images or
// mail attachments. Now each backup is a SET: the database dump and, beside
// it, an archive of the uploads volume, both encrypted with the master key
// (lib/secretbox encryptFile) before they touch disk or an off-site bucket.
//
// The archive is a plain POSIX tar (ustar, with a PAX header for a path too
// long for it), written and read here so nothing outside Node is needed.
// It never contains the master key file (`.secret.key`, or wherever
// COMPASSDOCS_KEY_FILE points), anything that is not a regular file or a
// directory (no links, no devices), or the scratch files a backup or a
// restore itself leaves in the volume, matched by the exact names they are
// given (second review M3: an attachment keeps its own extension, so a
// user's "notes.tmp" is content and is archived). A file deleted while the
// archive is written (an attachment removed, the trash purged) is skipped
// and counted, never a failed backup. Extraction writes only regular files,
// only under the uploads directory, never over the key file, and never
// through a link.
//
// 1.21.2: with the blob store (lib/file-store, COMPASSDOCS_FILE_STORE=blob)
// the archive is made from the workspace's container instead, in the same
// format (a stored file's key is its path: "<name>" or "hd-import/<name>"),
// and a restore writes the archive's stored files into the container. So a
// backup made on either store restores onto either: entries that are not a
// stored file's key (anything else an uploads folder held) are skipped and
// counted when restoring into a container.
//
// Server-only.

import "server-only";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, normalize, relative, resolve, sep } from "node:path";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { uploadDir } from "./uploads";
import { fileStore, fileStoreKind, isValidStoreKey, type StoredFile } from "./file-store";

const BLOCK = 512;

/** The master key file, by its path relative to the uploads directory, or null when it lives elsewhere. */
function keyFileRelative(root: string): string | null {
  const key = resolve(process.env.COMPASSDOCS_KEY_FILE || join(uploadDir(), ".secret.key"));
  const rel = relative(resolve(root), key);
  return rel && !rel.startsWith("..") && !rel.startsWith(sep) ? rel.split(sep).join("/") : null;
}

/**
 * The scratch files backups and restores make, by their exact generated
 * names: lib/backup's "compassdocs-<stamp>.dump.enc.tmp" (and ".files.tar.enc.tmp",
 * ".plain.tmp" while decrypting), and extraction's own
 * ".<name>.<pid>.restore.part" beside the file it is restoring.
 */
const SCRATCH_RE = [
  /^compassdocs-[0-9A-Za-z_-]+\.(?:dump\.enc|files\.tar\.enc)(?:\.tmp|\.plain\.tmp)$/,
  /^\..+\.\d+\.restore\.part$/,
];

/** A path the archive never holds and extraction never writes. */
export function excluded(rel: string, keyRel: string | null): boolean {
  const name = rel.split("/").pop() || "";
  if (keyRel && rel === keyRel) return true;
  if (name === ".secret.key") return true; // the default name, wherever the env points
  return SCRATCH_RE.some((re) => re.test(name));
}

function vanished(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

// --- Writing -------------------------------------------------------------------------

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name: string, size: number, mode: number, mtime: number, type: "0" | "5" | "x", prefix = ""): Buffer {
  const b = Buffer.alloc(BLOCK, 0);
  b.write(name, 0, 100, "utf8");
  b.write(octal(mode & 0o7777, 8), 100, 8, "ascii");
  b.write(octal(0, 8), 108, 8, "ascii"); // uid
  b.write(octal(0, 8), 116, 8, "ascii"); // gid
  b.write(octal(size, 12), 124, 12, "ascii");
  b.write(octal(Math.floor(mtime / 1000), 12), 136, 12, "ascii");
  b.write("        ", 148, 8, "ascii"); // checksum placeholder
  b.write(type, 156, 1, "ascii");
  b.write("ustar\0", 257, 6, "ascii");
  b.write("00", 263, 2, "ascii");
  b.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(octal(sum, 7) + " ", 148, 8, "ascii");
  return b;
}

/** A ustar name/prefix split, or null when the path needs a PAX header. */
function ustarName(path: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name) return { name, prefix };
  }
  return null;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

async function writeAll(out: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  if (!out.write(chunk)) await once(out as never, "drain");
}

function padding(size: number): Buffer {
  const rem = size % BLOCK;
  return rem ? Buffer.alloc(BLOCK - rem, 0) : Buffer.alloc(0);
}

export interface FilesArchiveResult {
  files: number;
  bytes: number;
  /** Files and folders deleted while the archive was being written: left out, not a failure. */
  vanished: number;
}

/**
 * Write the uploads directory to `dest` as a tar (plaintext; the caller
 * encrypts it and deletes this file). A missing uploads directory is an
 * empty archive. `skip` names absolute paths to leave out as well (the
 * backup's own files when the backup directory is inside uploads).
 */
export async function writeFilesArchive(dest: string, opts: { root?: string; skip?: string[] } = {}): Promise<FilesArchiveResult> {
  // 1.21.2: the blob store's files (an explicit root is always a folder).
  if (!opts.root && fileStoreKind() === "blob") return writeStoreArchive(dest);
  const root = resolve(opts.root ?? uploadDir());
  const keyRel = keyFileRelative(root);
  const skip = new Set((opts.skip ?? []).map((p) => resolve(p)));
  const out = createWriteStream(dest, { mode: 0o600 });
  const closed = once(out, "close");
  let files = 0;
  let bytes = 0;
  let gone = 0;

  async function entry(rel: string, abs: string): Promise<void> {
    // A regular file is opened before anything is written for it: one that
    // has vanished since the folder was listed is skipped, and once it is
    // open, deleting it no longer matters (the open handle still reads it).
    let fh: import("node:fs/promises").FileHandle | null = null;
    let st: import("node:fs").Stats;
    try {
      st = await lstat(abs);
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) return;
      if (st.isFile()) {
        fh = await open(abs, "r");
        const now = await fh.stat();
        if (!now.isFile() || now.ino !== st.ino) {
          await fh.close();
          return; // replaced by something else between the two looks
        }
        st = now;
      }
    } catch (e) {
      if (fh) await fh.close().catch(() => {});
      if (vanished(e)) {
        gone++;
        return;
      }
      throw e;
    }
    try {
      await writeEntry(rel, st, fh);
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  async function writeEntry(rel: string, st: import("node:fs").Stats, fh: import("node:fs/promises").FileHandle | null): Promise<void> {
    const path = st.isDirectory() ? `${rel}/` : rel;
    const split = ustarName(path);
    if (!split) {
      const pax = Buffer.from(paxRecord("path", path), "utf8");
      await writeAll(out, header("PaxHeader", pax.length, 0o644, st.mtimeMs, "x"));
      await writeAll(out, pax);
      await writeAll(out, padding(pax.length));
    }
    const { name, prefix } = split ?? { name: path.slice(-100).replace(/^\/+/, ""), prefix: "" };
    if (st.isDirectory()) {
      await writeAll(out, header(name, 0, st.mode, st.mtimeMs, "5", prefix));
      return;
    }
    await writeAll(out, header(name, st.size, st.mode, st.mtimeMs, "0", prefix));
    let written = 0;
    for await (const chunk of fh!.createReadStream({ start: 0, end: Math.max(0, st.size - 1), autoClose: false })) {
      const buf = chunk as Buffer;
      // A file that grew while it was read is cut at the size its header promised.
      const part = buf.subarray(0, Math.max(0, st.size - written));
      written += part.length;
      await writeAll(out, part);
      if (written >= st.size) break;
    }
    if (st.size === 0) written = 0;
    // A file that shrank while it was read is padded to the promised size.
    if (written < st.size) await writeAll(out, Buffer.alloc(st.size - written, 0));
    await writeAll(out, padding(st.size));
    files++;
    bytes += st.size;
  }

  async function walk(dirRel: string): Promise<void> {
    const dirAbs = dirRel ? join(root, dirRel) : root;
    let names: string[];
    try {
      names = (await readdir(dirAbs)).sort();
    } catch (e) {
      if (vanished(e)) {
        if (dirRel) gone++; // a folder removed while it was walked
        return;
      }
      throw e;
    }
    for (const n of names) {
      const rel = dirRel ? `${dirRel}/${n}` : n;
      const abs = join(root, rel);
      if (excluded(rel, keyRel) || skip.has(resolve(abs))) continue;
      let st: import("node:fs").Stats | null = null;
      try {
        st = await lstat(abs);
      } catch (e) {
        if (!vanished(e)) throw e;
        gone++;
      }
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        await entry(rel, abs);
        await walk(rel);
      } else if (st.isFile()) {
        await entry(rel, abs);
      }
    }
  }

  try {
    await walk("");
    await writeAll(out, Buffer.alloc(BLOCK * 2, 0)); // end of archive
  } finally {
    out.end();
    await closed;
  }
  return { files, bytes, vanished: gone };
}

/**
 * 1.21.2: the archive of the blob store's files, in the format above. Each
 * blob is opened (its download answered) before its header is written: one
 * deleted since the listing is skipped and counted. One that goes while it
 * is read is padded to its promised size and counted as vanished (keys are
 * never reused, so nothing refers to it any more); any other read failure
 * fails the backup rather than archive a damaged file.
 */
async function writeStoreArchive(dest: string): Promise<FilesArchiveResult> {
  const store = fileStore();
  const listed: StoredFile[] = [];
  for await (const f of store.list()) if (!excluded(f.key, null)) listed.push(f);
  listed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const out = createWriteStream(dest, { mode: 0o600 });
  const closed = once(out, "close");
  let files = 0;
  let bytes = 0;
  let gone = 0;
  let importDir = false;
  try {
    for (const f of listed) {
      const now = await store.stat(f.key);
      if (!now) {
        gone++;
        continue;
      }
      if (f.key.startsWith("hd-import/") && !importDir) {
        await writeAll(out, header("hd-import/", 0, 0o755, now.modifiedAt.getTime(), "5"));
        importDir = true;
      }
      const size = now.size;
      const body: Readable | null = size > 0 ? store.readStream(f.key, { start: 0, end: size - 1 }) : null;
      // The first chunk (or the error) before the header: a blob gone since it was listed is skipped.
      const it = body ? body[Symbol.asyncIterator]() : null;
      let first: IteratorResult<unknown> | null = null;
      if (it) {
        try {
          first = await it.next();
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
            gone++;
            continue;
          }
          throw new Error(`Could not read the stored file ${f.key}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      await writeAll(out, header(f.key, size, 0o600, now.modifiedAt.getTime(), "0"));
      let written = 0;
      let cutShort = false;
      try {
        for (let r = first; r && !r.done; r = await it!.next()) {
          const buf = r.value as Buffer;
          const part = buf.subarray(0, Math.max(0, size - written));
          written += part.length;
          await writeAll(out, part);
          if (written >= size) break;
        }
      } catch (e) {
        if (await store.stat(f.key).catch(() => "unknown")) {
          throw new Error(`Could not read the stored file ${f.key}: ${e instanceof Error ? e.message : String(e)}`);
        }
        cutShort = true;
      } finally {
        body?.destroy();
      }
      if (written < size) await writeAll(out, Buffer.alloc(size - written, 0));
      await writeAll(out, padding(size));
      if (cutShort) {
        gone++;
        continue;
      }
      files++;
      bytes += size;
    }
    await writeAll(out, Buffer.alloc(BLOCK * 2, 0)); // end of archive
  } finally {
    out.end();
    await closed;
  }
  return { files, bytes, vanished: gone };
}

// --- Reading -------------------------------------------------------------------------

function readOctal(b: Buffer, start: number, len: number): number {
  const s = b.subarray(start, start + len).toString("ascii").replace(/\0.*$/, "").trim();
  return s ? parseInt(s, 8) : 0;
}

function readString(b: Buffer, start: number, len: number): string {
  const s = b.subarray(start, start + len);
  const end = s.indexOf(0);
  return (end === -1 ? s : s.subarray(0, end)).toString("utf8");
}

function checksumOk(b: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : b[i];
  return sum === readOctal(b, 148, 8);
}

/** A tar entry's path made safe to join under the root, or null to skip it. */
export function safeArchivePath(raw: string): string | null {
  if (!raw || raw.includes("\0") || raw.startsWith("/") || /^[a-zA-Z]:/.test(raw) || raw.includes("\\")) return null;
  const clean = normalize(raw).replace(/\/+$/, "");
  if (!clean || clean === "." || clean.split("/").some((p) => p === ".." || p === "")) return null;
  return clean;
}

export interface ExtractResult {
  files: number;
  bytes: number;
  skipped: number;
}

/** One entry of an archive: its type flag, path (PAX path when given), size and where its data starts. */
interface ArchiveEntry {
  type: string;
  path: string;
  size: number;
  dataAt: number;
}

/** The entries of an archive, read by position from `fh` (PAX path headers applied, not yielded). */
async function* archiveEntries(fh: import("node:fs/promises").FileHandle): AsyncGenerator<ArchiveEntry> {
  let pos = 0;
  let paxPath: string | null = null;
  const block = Buffer.alloc(BLOCK);
  const read = async (buf: Buffer, at: number) => (await fh.read(buf, 0, buf.length, at)).bytesRead;
  for (;;) {
    if ((await read(block, pos)) < BLOCK) break;
    pos += BLOCK;
    if (block.every((x) => x === 0)) break; // end of archive
    if (!checksumOk(block)) throw new Error("The attachments archive is damaged (bad header checksum).");
    const size = readOctal(block, 124, 12);
    const type = String.fromCharCode(block[156] || 48);
    const prefix = readString(block, 345, 155);
    const name = readString(block, 0, 100);
    const dataAt = pos;
    pos += size + ((BLOCK - (size % BLOCK)) % BLOCK);

    if (type === "x") {
      const pax = Buffer.alloc(size);
      await read(pax, dataAt);
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(pax.toString("utf8"));
      paxPath = m ? m[1] : null;
      continue;
    }
    const path = paxPath ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = null;
    yield { type, path, size, dataAt };
  }
}

/** Copy `size` bytes at `at` of the archive to `out`, refusing a truncated archive. */
async function copyEntry(fh: import("node:fs/promises").FileHandle, at: number, size: number, out: NodeJS.WritableStream): Promise<void> {
  let left = size;
  const chunk = Buffer.alloc(Math.min(1024 * 1024, Math.max(size, 1)));
  while (left > 0) {
    const { bytesRead: n } = await fh.read(chunk, 0, Math.min(chunk.length, left), at);
    if (n <= 0) throw new Error("The attachments archive is truncated.");
    await writeAll(out, Buffer.from(chunk.subarray(0, n)));
    left -= n;
    at += n;
  }
}

/**
 * Restore an archive written by writeFilesArchive into the uploads
 * directory. Files are added or replaced, never deleted: a file uploaded
 * after the backup stays (the restored database simply no longer points at
 * it). Each file is written beside its target and renamed into place, so a
 * failed restore never leaves a half-written attachment.
 *
 * 1.21.2: with the blob store, into the workspace's container instead
 * (extractIntoStore).
 */
export async function extractFilesArchive(src: string, opts: { root?: string } = {}): Promise<ExtractResult> {
  if (!opts.root && fileStoreKind() === "blob") return extractIntoStore(src);
  const root = resolve(opts.root ?? uploadDir());
  const keyRel = keyFileRelative(root);
  await mkdir(root, { recursive: true });
  const fh = await open(src, "r");
  let files = 0;
  let bytes = 0;
  let skipped = 0;

  try {
    for await (const { type, path, size, dataAt } of archiveEntries(fh)) {
      const rel = safeArchivePath(path);
      if (!rel || excluded(rel, keyRel)) {
        skipped++;
        continue;
      }
      const target = join(root, rel);
      if (!resolve(target).startsWith(root + sep)) {
        skipped++;
        continue;
      }
      if (type === "5") {
        await mkdirNoLinks(root, rel);
        continue;
      }
      if (type !== "0" && type !== "\0") {
        skipped++; // links, devices, anything else: never written
        continue;
      }
      await mkdirNoLinks(root, dirname(rel) === "." ? "" : dirname(rel));
      const existing = await lstat(target).catch(() => null);
      if (existing && !existing.isFile()) {
        skipped++; // never write through a link or over a directory
        continue;
      }
      const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.restore.part`);
      const out = createWriteStream(tmp, { mode: 0o600 });
      const closed = once(out, "close");
      try {
        await copyEntry(fh, dataAt, size, out);
      } catch (e) {
        out.destroy();
        await unlink(tmp).catch(() => {});
        throw e;
      }
      out.end();
      await closed;
      await rename(tmp, target);
      files++;
      bytes += size;
    }
  } finally {
    await fh.close();
  }
  return { files, bytes, skipped };
}

/**
 * 1.21.2: restore an archive into the blob store. Only regular-file entries
 * whose path is a stored file's key are written (each one blob, replaced
 * whole: a blob appears complete or not at all); everything else (folders,
 * links, the key file, any other file an uploads folder held) is skipped,
 * folders silently, the rest counted. Never deletes a blob.
 */
async function extractIntoStore(src: string): Promise<ExtractResult> {
  const store = fileStore();
  const fh = await open(src, "r");
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  try {
    for await (const { type, path, size, dataAt } of archiveEntries(fh)) {
      if (type === "5") continue;
      const rel = safeArchivePath(path);
      if (!rel || (type !== "0" && type !== "\0") || excluded(rel, null) || !isValidStoreKey(rel)) {
        skipped++;
        continue;
      }
      if (size > 0) {
        // The size is checked first, so a truncated archive fails here, never as a short blob.
        const st = await fh.stat();
        if (dataAt + size > st.size) throw new Error("The attachments archive is truncated.");
      }
      const body = fh.createReadStream({ start: dataAt, end: dataAt + Math.max(0, size - 1), autoClose: false });
      if (size === 0) {
        body.destroy();
        await store.write(rel, Buffer.alloc(0));
      } else {
        const written = await store.writeStream(rel, body);
        if (written !== size) {
          await store.delete(rel).catch(() => {});
          throw new Error("The attachments archive is truncated.");
        }
      }
      files++;
      bytes += size;
    }
  } finally {
    await fh.close();
  }
  return { files, bytes, skipped };
}

/** mkdir -p under root, refusing to pass through a symbolic link. */
async function mkdirNoLinks(root: string, rel: string): Promise<void> {
  if (!rel) return;
  let cur = root;
  for (const part of rel.split("/")) {
    cur = join(cur, part);
    const st = await lstat(cur).catch(() => null);
    if (!st) await mkdir(cur);
    else if (!st.isDirectory()) throw new Error(`The attachments archive names ${rel}, which is not a folder here.`);
  }
}
