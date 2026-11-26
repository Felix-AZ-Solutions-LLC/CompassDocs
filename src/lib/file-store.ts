// Where the workspace's files live (1.21.2): the store behind lib/uploads.
//
// Two backends:
//
//   - local (the default, and every self-hosted install unless it opts in):
//     the uploads folder, COMPASSDOCS_UPLOAD_DIR (/uploads in the image),
//     exactly as before 1.21.2: the same paths, the same files, the same
//     errors.
//   - blob (COMPASSDOCS_FILE_STORE=blob): one container in Azure Blob
//     Storage, COMPASSDOCS_BLOB_CONTAINER in the account at
//     COMPASSDOCS_BLOB_ACCOUNT_URL. CompassDocs Cloud gives each workspace
//     its own container in a shared, zone-redundant (GZRS) account. The app
//     signs in with its managed identity (Microsoft Entra: workload identity
//     when AZURE_FEDERATED_TOKEN_FILE is set, else the container's managed
//     identity, the user-assigned one named by AZURE_CLIENT_ID when it is
//     set): no account key, no SAS. COMPASSDOCS_BLOB_CONNECTION_STRING is
//     for development against Azurite only, and cloud mode refuses one that
//     is not a loopback address.
//
// Every read, write, existence check, delete, size, listing and byte range
// of a user file goes through here. A file keeps its opaque random name as
// its key ("<32 hex>.<ext>", or "hd-import/<32 hex>.zip|csv" for a desk
// import's upload while it is being imported), checked against one pattern
// on every call, so a key can never name anything else (no path traversal,
// no other blob). Files are only ever served by the app's own authorised
// routes: blobs are private, written as application/octet-stream, and no
// URL to one, public or signed, is ever made.
//
// The Azure SDK (and @azure/identity) is loaded only when the blob store is
// first used, so a self-hosted install never loads either.
//
// No "server-only" marker, like lib/uploads: the tests import it.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { PassThrough, Transform, pipeline, type Readable } from "node:stream";
import { pipeline as pipelineAsync } from "node:stream/promises";
import { sharedAzureCredential } from "./azure-credential";

export type Env = Record<string, string | undefined>;
export type FileStoreKind = "local" | "blob";

/** A file's key: an upload's stored name, or a desk import's upload under hd-import/. */
const KEY_RE = /^(?:hd-import\/)?[a-f0-9]{32}(?:\.[a-z0-9]{1,12})?$/;

/** Is this a key a stored file may have? Checked on every call. */
export function isValidStoreKey(key: string): boolean {
  return typeof key === "string" && KEY_RE.test(key);
}

export interface StoredFile {
  key: string;
  size: number;
  modifiedAt: Date;
}

export interface FileStore {
  readonly kind: FileStoreKind;
  /** Where the files are, for a person (Diagnostics): never a secret. */
  describe(): string;
  /** Write a whole file (replacing one with that key). Nothing is left of a write that failed. */
  write(key: string, data: Buffer): Promise<void>;
  /** Write a file from a stream; returns its size. A failed write leaves nothing, and rejects with the stream's own error. */
  writeStream(key: string, src: Readable): Promise<number>;
  /** A whole file; rejects with code ENOENT when there is none. */
  read(key: string): Promise<Buffer>;
  /** A file, or the inclusive byte range of one, as a stream (an error, ENOENT included, arrives on the stream). */
  readStream(key: string, range?: { start: number; end: number }): Readable;
  /** Up to `length` bytes from `position`: fewer at the end of the file, none past it. */
  readRange(key: string, position: number, length: number): Promise<Buffer>;
  /** The file's size and time, or null when there is no such file. */
  stat(key: string): Promise<{ size: number; modifiedAt: Date } | null>;
  /** Remove a file; one already gone is not an error. */
  delete(key: string): Promise<void>;
  /** Give a file another key (the desk import's extension follows the file's content). */
  rename(from: string, to: string): Promise<void>;
  /** Every stored file with a valid key, in key order (local) or the service's order (blob). */
  list(): AsyncIterable<StoredFile>;
  /** The workspace's stored files and bytes (usage metering). */
  usage(): Promise<{ files: number; bytes: number }>;
  /** Can the store be reached (and, with `write`, written)? Rejects with the reason. */
  check(opts?: { write?: boolean; timeoutMs?: number }): Promise<void>;
}

function notFound(key: string, cause?: unknown): NodeJS.ErrnoException {
  const e = new Error(`No stored file ${key}.`, cause ? { cause } : undefined) as NodeJS.ErrnoException;
  e.code = "ENOENT";
  return e;
}

/** A stream that fails at once with `e` (the way a missing file fails on disk). */
function failedStream(e: Error): Readable {
  const s = new PassThrough();
  process.nextTick(() => s.destroy(e));
  return s;
}

function assertKey(key: string): void {
  if (!isValidStoreKey(key)) throw notFound(String(key).slice(0, 80));
}

// --- Configuration -------------------------------------------------------------------

/** COMPASSDOCS_FILE_STORE: "blob" opts in; unset or "local" is the uploads folder. */
export function fileStoreKind(env: Env = process.env): FileStoreKind {
  return env.COMPASSDOCS_FILE_STORE?.trim().toLowerCase() === "blob" ? "blob" : "local";
}

export interface BlobConfig {
  accountUrl: string;
  container: string;
  connectionString: string;
  /** A user-assigned managed identity's client id (AZURE_CLIENT_ID), when one is used. */
  clientId: string;
}

export function blobConfig(env: Env = process.env): BlobConfig {
  return {
    accountUrl: env.COMPASSDOCS_BLOB_ACCOUNT_URL?.trim().replace(/\/+$/, "") ?? "",
    container: env.COMPASSDOCS_BLOB_CONTAINER?.trim() ?? "",
    connectionString: env.COMPASSDOCS_BLOB_CONNECTION_STRING?.trim() ?? "",
    clientId: env.AZURE_CLIENT_ID?.trim() ?? "",
  };
}

function isCloudEnv(env: Env): boolean {
  const v = env.COMPASSDOCS_CLOUD?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Azure's container naming rule: 3–63 of a-z, 0-9 and single hyphens, starting and ending with a letter or digit. */
export function validContainerName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/.test(name);
}

/** The endpoint a connection string names (Azurite's BlobEndpoint, or the account's), for the loopback rule. */
function connectionStringHost(cs: string): string | null {
  const parts = Object.fromEntries(
    cs
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf("=");
        return i < 0 ? [p.toLowerCase(), ""] : [p.slice(0, i).toLowerCase(), p.slice(i + 1)];
      })
  );
  if (parts.usedevelopmentstorage === "true") return "127.0.0.1";
  if (parts.blobendpoint) {
    try {
      return new URL(parts.blobendpoint).hostname;
    } catch {
      return null;
    }
  }
  return parts.accountname ? `${parts.accountname}.blob.${parts.endpointsuffix || "core.windows.net"}` : null;
}

/**
 * Why the blob store can't be used as configured, one sentence each
 * (fatal: the process refuses to start), and what is merely worth saying.
 * Empty for the local store, which has nothing to check here.
 */
export function fileStoreProblems(env: Env = process.env): { fatal: string[]; warnings: string[] } {
  const fatal: string[] = [];
  const warnings: string[] = [];
  const raw = env.COMPASSDOCS_FILE_STORE?.trim().toLowerCase();
  if (raw && raw !== "blob" && raw !== "local") {
    fatal.push(`COMPASSDOCS_FILE_STORE must be "local" or "blob" (it is "${env.COMPASSDOCS_FILE_STORE!.trim().slice(0, 40)}").`);
    return { fatal, warnings };
  }
  if (fileStoreKind(env) !== "blob") {
    if (isCloudEnv(env)) {
      warnings.push(
        "COMPASSDOCS_FILE_STORE is not blob: files are kept in the uploads folder, which must then be a persistent volume every replica shares."
      );
    }
    return { fatal, warnings };
  }
  const c = blobConfig(env);
  if (!c.container) fatal.push("COMPASSDOCS_BLOB_CONTAINER is not set: name the workspace's container (COMPASSDOCS_FILE_STORE=blob).");
  else if (!validContainerName(c.container)) {
    fatal.push(`COMPASSDOCS_BLOB_CONTAINER "${c.container.slice(0, 70)}" is not a valid container name (3–63 lower-case letters, digits and single hyphens).`);
  }
  if (c.connectionString) {
    const host = connectionStringHost(c.connectionString);
    const loopback = !!host && /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(host);
    if (!host) fatal.push("COMPASSDOCS_BLOB_CONNECTION_STRING can't be read: it names no account or BlobEndpoint.");
    else if (!loopback) {
      if (isCloudEnv(env)) {
        fatal.push(
          "COMPASSDOCS_BLOB_CONNECTION_STRING is for development against Azurite only: cloud mode signs in with its managed identity. Unset it and set COMPASSDOCS_BLOB_ACCOUNT_URL."
        );
      } else {
        warnings.push(
          "COMPASSDOCS_BLOB_CONNECTION_STRING holds an account key or SAS: fine for development, but prefer COMPASSDOCS_BLOB_ACCOUNT_URL with a managed identity."
        );
      }
    }
    if (c.accountUrl) warnings.push("COMPASSDOCS_BLOB_ACCOUNT_URL is ignored while COMPASSDOCS_BLOB_CONNECTION_STRING is set.");
    return { fatal, warnings };
  }
  if (!c.accountUrl) {
    fatal.push("COMPASSDOCS_BLOB_ACCOUNT_URL is not set: give the storage account's blob address, e.g. https://acme.blob.core.windows.net.");
    return { fatal, warnings };
  }
  let u: URL | null = null;
  try {
    u = new URL(c.accountUrl);
  } catch {
    fatal.push("COMPASSDOCS_BLOB_ACCOUNT_URL is not a valid URL: e.g. https://acme.blob.core.windows.net.");
  }
  if (u) {
    if (u.search || u.username || u.password) {
      // A SAS in the address would be a credential in plain configuration (and in every log of it).
      fatal.push("COMPASSDOCS_BLOB_ACCOUNT_URL must be the bare account address, with no SAS or other query string: the app signs in with its managed identity.");
    } else if (u.protocol !== "https:") {
      fatal.push(`COMPASSDOCS_BLOB_ACCOUNT_URL must be an https:// address (it is ${u.protocol}//…).`);
    } else if (u.pathname !== "/" && u.pathname !== "") {
      fatal.push("COMPASSDOCS_BLOB_ACCOUNT_URL is the account's address only: the container goes in COMPASSDOCS_BLOB_CONTAINER.");
    }
  }
  return { fatal, warnings };
}

// --- Local: the uploads folder ---------------------------------------------------------

/** The uploads folder (lib/uploads uploadDir, read on every call: tests change it). */
function uploadRoot(env: Env = process.env): string {
  return env.COMPASSDOCS_UPLOAD_DIR || "/uploads";
}

/**
 * A path in the uploads folder. A run-time folder, never part of the build:
 * the ignore comment keeps the build's file tracing from copying the whole
 * project into every route that can reach this module.
 */
function inUploads(...parts: string[]): string {
  return join(/*turbopackIgnore: true*/ uploadRoot(), ...parts);
}

class LocalStore implements FileStore {
  readonly kind = "local" as const;

  private path(key: string): string {
    assertKey(key);
    return inUploads(key);
  }

  describe(): string {
    return uploadRoot();
  }

  async write(key: string, data: Buffer): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, data);
    } catch (e) {
      // A write cut short (a full volume) is removed: no caller learns its name.
      await unlink(path).catch(() => {});
      throw e;
    }
  }

  async writeStream(key: string, src: Readable): Promise<number> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        cb(null, chunk);
      },
    });
    try {
      await pipelineAsync(src, counter, createWriteStream(path));
    } catch (e) {
      await unlink(path).catch(() => {});
      throw e;
    }
    return size;
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  readStream(key: string, range?: { start: number; end: number }): Readable {
    if (!isValidStoreKey(key)) return failedStream(notFound(String(key).slice(0, 80)));
    return createReadStream(inUploads(key), range);
  }

  async readRange(key: string, position: number, length: number): Promise<Buffer> {
    const { open } = await import("node:fs/promises");
    const fh = await open(this.path(key), "r");
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, position);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async stat(key: string): Promise<{ size: number; modifiedAt: Date } | null> {
    if (!isValidStoreKey(key)) return null;
    try {
      const s = await stat(inUploads(key));
      return s.isFile() ? { size: s.size, modifiedAt: s.mtime } : null;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    if (!isValidStoreKey(key)) return;
    await unlink(inUploads(key)).catch(() => {});
  }

  async rename(from: string, to: string): Promise<void> {
    await rename(this.path(from), this.path(to));
  }

  async *list(): AsyncIterable<StoredFile> {
    for (const dir of ["", "hd-import"]) {
      let names: string[];
      try {
        names = (await readdir(inUploads(dir))).sort();
      } catch {
        continue;
      }
      for (const n of names) {
        const key = dir ? `${dir}/${n}` : n;
        if (!isValidStoreKey(key)) continue;
        const s = await this.stat(key);
        if (s) yield { key, size: s.size, modifiedAt: s.modifiedAt };
      }
    }
  }

  async usage(): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    for await (const f of this.list()) {
      files++;
      bytes += f.size;
    }
    return { files, bytes };
  }

  async check(opts: { write?: boolean } = {}): Promise<void> {
    if (!opts.write) {
      await stat(inUploads());
      return;
    }
    const probe = inUploads(`.diag-${process.pid}-${Date.now()}`);
    await writeFile(probe, "ok");
    await unlink(probe);
  }
}

// --- Azure Blob Storage ----------------------------------------------------------------

type ContainerClient = import("@azure/storage-blob").ContainerClient;

/** The status and code of an Azure SDK error (RestError), when it is one. */
function restError(e: unknown): { status: number; code: string } {
  const x = e as { statusCode?: unknown; code?: unknown; details?: { errorCode?: unknown } } | null;
  return {
    status: typeof x?.statusCode === "number" ? x.statusCode : 0,
    code: String(x?.details?.errorCode ?? x?.code ?? ""),
  };
}

function isMissing(e: unknown): boolean {
  const r = restError(e);
  return r.status === 404 || r.code === "BlobNotFound";
}

const BLOB_HEADERS = { blobContentType: "application/octet-stream" };
/** Block size and parallel blocks for streamed uploads. */
const UPLOAD_BLOCK = 4 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;

class BlobStore implements FileStore {
  readonly kind = "blob" as const;
  private client: Promise<ContainerClient> | null = null;

  constructor(private readonly cfg: BlobConfig) {}

  private container(): Promise<ContainerClient> {
    if (!this.client) {
      const made = (async () => {
        const { BlobServiceClient } = await import("@azure/storage-blob");
        // Retries a little sooner than the SDK's default (4 s, then doubling): a person is waiting on most of these.
        const options = {
          userAgentOptions: { userAgentPrefix: "CompassDocs" },
          retryOptions: { maxTries: 4, retryDelayInMs: 800, maxRetryDelayInMs: 8_000 },
        };
        const service = this.cfg.connectionString
          ? BlobServiceClient.fromConnectionString(this.cfg.connectionString, options)
          : new BlobServiceClient(
              this.cfg.accountUrl,
              // 1.21.3: the process's one credential (lib/azure-credential), shared with the database's Entra sign-in.
              (await sharedAzureCredential()) as import("@azure/identity").TokenCredential,
              options
            );
        return service.getContainerClient(this.cfg.container);
      })();
      this.client = made;
      made.catch(() => {
        if (this.client === made) this.client = null;
      });
    }
    return this.client;
  }

  private async blob(key: string) {
    assertKey(key);
    return (await this.container()).getBlockBlobClient(key);
  }

  describe(): string {
    let where = "Azure Blob Storage";
    if (this.cfg.connectionString) {
      const host = connectionStringHost(this.cfg.connectionString);
      if (host) where += ` (${host})`;
    } else {
      try {
        where += ` (${new URL(this.cfg.accountUrl).host})`;
      } catch {
        /* checked at start-up */
      }
    }
    return `${where}, container ${this.cfg.container}`;
  }

  async write(key: string, data: Buffer): Promise<void> {
    const b = await this.blob(key);
    // One request below the SDK's single-shot limit, staged blocks above it: either way the blob appears whole or not at all.
    await b.uploadData(data, { blobHTTPHeaders: BLOB_HEADERS });
  }

  async writeStream(key: string, src: Readable): Promise<number> {
    const b = await this.blob(key);
    let size = 0;
    let sourceError: unknown = null;
    src.once("error", (e) => {
      sourceError = e;
    });
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        cb(null, chunk);
      },
    });
    pipeline(src, counter, () => {});
    try {
      await b.uploadStream(counter, UPLOAD_BLOCK, UPLOAD_CONCURRENCY, { blobHTTPHeaders: BLOB_HEADERS });
    } catch (e) {
      counter.destroy();
      // Blocks staged but never committed are not a blob; delete in case the commit went through.
      await b.deleteIfExists().catch(() => {});
      throw sourceError ?? e;
    }
    if (sourceError) {
      await b.deleteIfExists().catch(() => {});
      throw sourceError;
    }
    return size;
  }

  async read(key: string): Promise<Buffer> {
    const b = await this.blob(key);
    try {
      return await b.downloadToBuffer();
    } catch (e) {
      if (isMissing(e)) throw notFound(key, e);
      throw e;
    }
  }

  readStream(key: string, range?: { start: number; end: number }): Readable {
    const out = new PassThrough();
    const abort = new AbortController();
    out.once("close", () => abort.abort());
    (async () => {
      const b = await this.blob(key);
      const offset = range ? range.start : 0;
      const count = range ? range.end - range.start + 1 : undefined;
      const res = await b.download(offset, count, { abortSignal: abort.signal });
      const body = res.readableStreamBody as Readable | undefined;
      if (!body) throw new Error(`The blob ${key} came back without a body.`);
      pipeline(body, out, () => {});
    })().catch((e) => {
      if (!out.destroyed) out.destroy(isMissing(e) ? notFound(key, e) : (e as Error));
    });
    return out;
  }

  async readRange(key: string, position: number, length: number): Promise<Buffer> {
    if (length <= 0) return Buffer.alloc(0);
    const b = await this.blob(key);
    let res;
    try {
      res = await b.download(position, length);
    } catch (e) {
      // A range that starts past the end (416 InvalidRange): nothing there.
      if (restError(e).status === 416) return Buffer.alloc(0);
      if (isMissing(e)) throw notFound(key, e);
      throw e;
    }
    const parts: Buffer[] = [];
    for await (const chunk of res.readableStreamBody as Readable) parts.push(chunk as Buffer);
    return Buffer.concat(parts);
  }

  async stat(key: string): Promise<{ size: number; modifiedAt: Date } | null> {
    if (!isValidStoreKey(key)) return null;
    try {
      const p = await (await this.blob(key)).getProperties();
      return { size: p.contentLength ?? 0, modifiedAt: p.lastModified ?? new Date(0) };
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    if (!isValidStoreKey(key)) return;
    await (await this.blob(key)).deleteIfExists();
  }

  async rename(from: string, to: string): Promise<void> {
    // Copied through the app (a server-side copy would need the source authorised separately), then the old one removed.
    const src = await this.blob(from);
    let res;
    try {
      res = await src.download();
    } catch (e) {
      if (isMissing(e)) throw notFound(from, e);
      throw e;
    }
    await this.writeStream(to, res.readableStreamBody as Readable);
    await src.deleteIfExists();
  }

  async *list(): AsyncIterable<StoredFile> {
    for await (const b of (await this.container()).listBlobsFlat()) {
      if (!isValidStoreKey(b.name)) continue;
      yield { key: b.name, size: b.properties.contentLength ?? 0, modifiedAt: b.properties.lastModified };
    }
  }

  /** Every blob in the container, whatever its name: what the account stores (and bills) for the workspace. One listing call per 5000 blobs. */
  async usage(): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    for await (const b of (await this.container()).listBlobsFlat()) {
      files++;
      bytes += b.properties.contentLength ?? 0;
    }
    return { files, bytes };
  }

  async check(opts: { write?: boolean; timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const abortSignal = AbortSignal.timeout(timeoutMs);
    const work = (async () => {
      const c = await this.container();
      // One listing page of one blob: the container exists and the identity may read it.
      await c.listBlobsFlat().byPage({ maxPageSize: 1 }).next();
      if (opts.write) {
        const probe = c.getBlockBlobClient(`.compassdocs-check-${randomBytes(8).toString("hex")}`);
        await probe.uploadData(Buffer.from("ok"), { blobHTTPHeaders: BLOB_HEADERS, abortSignal });
        await probe.deleteIfExists({ abortSignal });
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`), { code: "ETIMEDOUT" })), timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      work.catch(() => {});
    }
  }
}

// --- The store in use ------------------------------------------------------------------

const G = globalThis as unknown as {
  __compassFileStore?: { config: string; store: FileStore };
  /** The blob store answered once (start-up or /readyz): from then on it is "verified". */
  __compassFileStoreVerified?: string;
  __compassFileStoreCheck?: Promise<StoreProblem | null>;
  __compassFileStoreLastProblem?: string;
};

function configKey(env: Env): string {
  if (fileStoreKind(env) === "local") return "local";
  const c = blobConfig(env);
  return JSON.stringify([c.accountUrl, c.container, c.connectionString, c.clientId]);
}

/**
 * The workspace's file store, by the environment now (tests change it). One
 * per configuration, shared by every module graph of the process (its
 * client and credential are reused, and so are their tokens).
 */
export function fileStore(env: Env = process.env): FileStore {
  const config = configKey(env);
  if (G.__compassFileStore?.config !== config) {
    G.__compassFileStore = { config, store: config === "local" ? new LocalStore() : new BlobStore(blobConfig(env)) };
  }
  return G.__compassFileStore.store;
}

/** Tests: forget the store, the verification and the last problem. */
export function resetFileStoreForTests(): void {
  G.__compassFileStore = undefined;
  G.__compassFileStoreVerified = undefined;
  G.__compassFileStoreCheck = undefined;
  G.__compassFileStoreLastProblem = undefined;
}

export interface StoreProblem {
  /** config: the container, identity or permission is wrong (waiting won't fix it); unreachable: no answer. */
  kind: "config" | "unreachable";
  message: string;
}

/** What a failed check means, in one sentence (never a key, a SAS or a token). */
export function storeProblem(e: unknown, store: FileStore = fileStore()): StoreProblem {
  const where = store.describe();
  const r = restError(e);
  const name = String((e as { name?: unknown })?.name ?? "");
  const message = e instanceof Error ? e.message.split("\n")[0].slice(0, 300) : String(e);
  if (r.code === "ContainerNotFound" || (r.status === 404 && !r.code)) {
    return { kind: "config", message: `The container does not exist: ${where}. Create it, or set COMPASSDOCS_BLOB_CONTAINER to the workspace's container.` };
  }
  if (r.status === 403 || /^Authorization/.test(r.code)) {
    return {
      kind: "config",
      message: `The app's identity may not use ${where} (${r.code || "403"}): give it the Storage Blob Data Contributor role on the container (a new role assignment can take a few minutes to apply).`,
    };
  }
  if (r.status === 401 || /^Authentication/.test(r.code) || /CredentialUnavailableError|AuthenticationError|AuthenticationRequiredError/.test(name)) {
    return {
      kind: "config",
      message: `The app could not sign in to ${where}: ${message} (cloud mode uses the container app's managed identity; AZURE_CLIENT_ID names a user-assigned one).`,
    };
  }
  return { kind: "unreachable", message: `${where} can't be reached: ${message}` };
}

/**
 * Start-up (instrumentation), whatever the mode: nothing for the local store.
 * For the blob store, a missing or invalid setting is one error line each
 * and the process exits 1 before it serves anything; then the container is
 * tried once: a container, identity or permission problem, or no answer, is
 * one error line and the process keeps running, not ready (/readyz) until
 * the container answers.
 */
export async function checkFileStoreStartup(
  log: (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => void,
  exit: (code: number) => void = (code) => process.exit(code),
  env: Env = process.env
): Promise<boolean> {
  const { fatal, warnings } = fileStoreProblems(env);
  for (const w of warnings) log("warn", "file_store.config", { message: w });
  if (fatal.length) {
    for (const f of fatal) log("error", "file_store.refused_to_start", { message: `File storage can't start: ${f}` });
    await new Promise((r) => setTimeout(r, 200));
    exit(1);
    return false;
  }
  if (fileStoreKind(env) !== "blob") return true;
  const problem = await verifyFileStore(10_000, env);
  if (problem) {
    log("error", problem.kind === "config" ? "file_store.misconfigured" : "file_store.unreachable", {
      message: `${problem.message} Files can't be read or saved, and /readyz reports not ready, until it answers.`,
    });
  } else {
    log("info", "file_store", { message: `Files are stored in ${fileStore(env).describe()}.` });
  }
  return true;
}

/**
 * Try the blob store once (one listing call), deduplicating concurrent
 * tries; remembered for the process once it answered. Null when it is
 * reachable (or this is the local store).
 */
export async function verifyFileStore(timeoutMs = 3_000, env: Env = process.env): Promise<StoreProblem | null> {
  if (fileStoreKind(env) !== "blob") return null;
  const config = configKey(env);
  if (G.__compassFileStoreVerified === config) return null;
  if (!G.__compassFileStoreCheck) {
    const store = fileStore(env);
    const run = store
      .check({ timeoutMs })
      .then(() => {
        G.__compassFileStoreVerified = config;
        G.__compassFileStoreLastProblem = undefined;
        return null;
      })
      .catch((e: unknown) => storeProblem(e, store))
      .finally(() => {
        if (G.__compassFileStoreCheck === run) G.__compassFileStoreCheck = undefined;
      });
    G.__compassFileStoreCheck = run;
  }
  return G.__compassFileStoreCheck;
}

/**
 * /readyz in blob mode: ready once the container has answered once in this
 * process (start-up, or a probe since). Storage is shared by every replica,
 * so after that a storage blip is not a reason to take this replica out of
 * rotation (every replica would go, pages that need no file included); a
 * revision whose container is wrong or unreachable from the start never
 * becomes ready. Logs a failure once per distinct reason.
 */
export async function fileStoreReadiness(
  timeoutMs: number,
  log?: (level: "error", event: string, fields: Record<string, unknown>) => void
): Promise<StoreProblem | null> {
  const problem = await verifyFileStore(timeoutMs);
  if (problem && log && G.__compassFileStoreLastProblem !== problem.message) {
    G.__compassFileStoreLastProblem = problem.message;
    log("error", "readyz.file_store", { reason: "file storage unreachable", error: problem.message });
  }
  return problem;
}

// --- Copying the uploads folder into a container (scripts/copy-uploads-to-blob.cjs) ----

/** The pattern a stored file's key must match, for the copy command (kept in step with KEY_RE by a test). */
export const STORE_KEY_PATTERN = KEY_RE.source;
