import { join, extname } from "path";
import { randomBytes } from "crypto";
import { fileStore, fileStoreKind } from "./file-store";

// Document attachments and every other uploaded file. Each is stored under
// an opaque random name; the original filename is kept in the DB. 1.21.2:
// the bytes live in the workspace's file store (lib/file-store): the
// uploads folder by default, exactly as before, or an Azure Blob Storage
// container (COMPASSDOCS_FILE_STORE=blob).

/**
 * The uploads folder: the local store's files, and (self-hosted) the master
 * key file's default home (lib/secretbox). In blob mode no user file is
 * kept here.
 */
export function uploadDir(): string {
  return process.env.COMPASSDOCS_UPLOAD_DIR || "/uploads";
}

// Stored names are 32 hex chars + an optional short extension — validated on
// every read to block path traversal (lib/file-store checks every key again).
const STORED_RE = /^[a-f0-9]{32}(\.[a-z0-9]{1,12})?$/;
export function isValidStoredName(n: string): boolean {
  return STORED_RE.test(n);
}

export function safeExt(filename: string): string {
  const e = extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(e) ? e : "";
}

export async function saveUpload(buf: Buffer, ext: string): Promise<string> {
  const name = randomBytes(16).toString("hex") + (ext || "");
  // A write cut short (a full volume, a dropped connection) leaves nothing: no caller learns its name.
  await fileStore().write(name, buf);
  return name;
}

export function uploadReadStream(storedName: string, range?: { start: number; end: number }) {
  if (!isValidStoredName(storedName)) return null;
  return fileStore().readStream(storedName, range);
}

/** A stored file, whole (1.21.2: in place of reading the uploads folder directly). Rejects when it is missing. */
export async function readUpload(storedName: string): Promise<Buffer> {
  if (!isValidStoredName(storedName)) throw Object.assign(new Error("Not a stored file name."), { code: "ENOENT" });
  return fileStore().read(storedName);
}

/** Mime types the attachment endpoint serves inline as playable video. */
export function isInlineVideo(mime: string): boolean {
  return /^video\/(mp4|webm|ogg|quicktime)$/.test(mime);
}

/** Whether the stored file actually exists (streams error mid-response otherwise). */
export async function uploadExists(storedName: string): Promise<boolean> {
  if (!isValidStoredName(storedName)) return false;
  try {
    return (await fileStore().stat(storedName)) !== null;
  } catch {
    return false;
  }
}

export async function deleteUpload(storedName: string): Promise<void> {
  if (!isValidStoredName(storedName)) return;
  try {
    await fileStore().delete(storedName);
  } catch {
    /* already gone */
  }
}

/**
 * 1.21.2: the workspace's stored files and bytes, for usage metering: the
 * uploads folder's stored files, or every blob in the workspace's
 * container. One directory walk, or one listing call per 5000 blobs.
 */
export async function storedUsage(): Promise<{ files: number; bytes: number }> {
  return fileStore().usage();
}

/**
 * A mail attachment for a stored file (newsletters): by its path in the
 * uploads folder, as before 1.21.2, or (blob store) by its stored name,
 * read when the mail is built (mailAttachmentsForSend).
 */
export interface MailAttachment {
  filename: string;
  path?: string;
  storedName?: string;
}

export function mailAttachment(filename: string, storedName: string): MailAttachment {
  return fileStoreKind() === "local" ? { filename, path: join(/*turbopackIgnore: true*/ uploadDir(), storedName) } : { filename, storedName };
}

/** Attachments as nodemailer takes them: a stored name becomes its bytes; a path stays a path. */
export async function mailAttachmentsForSend(list: MailAttachment[] | undefined): Promise<{ filename: string; path?: string; content?: Buffer }[] | undefined> {
  if (!list?.length) return undefined;
  return Promise.all(
    list.map(async (a) => (a.storedName ? { filename: a.filename, content: await readUpload(a.storedName) } : { filename: a.filename, path: a.path }))
  );
}

// Only these image types are served inline; everything else (incl. SVG, HTML,
// PDFs) is served as a download to prevent any script execution on our origin.
const INLINE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export function isInlineImage(mime: string): boolean {
  return INLINE_MIME.has(mime);
}

/**
 * Identify an image by its magic bytes — never by a client-supplied mime or
 * filename. Returns the mime + canonical extension for exactly the four
 * inline-servable types above, or null for anything else (SVG deliberately
 * excluded: it can carry script, so it is never accepted as an "image").
 */
export function sniffImage(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length >= 8 && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return { mime: "image/png", ext: ".png" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg", ext: ".jpg" };
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "GIF8") {
    return { mime: "image/gif", ext: ".gif" };
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { mime: "image/webp", ext: ".webp" };
  }
  return null;
}
