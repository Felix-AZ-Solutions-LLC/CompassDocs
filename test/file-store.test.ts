// The file store (1.21.2, lib/file-store): the same contract on both
// backends, the uploads folder and an Azure Blob Storage container
// (Azurite), through lib/uploads as the app calls it: whole files, byte
// ranges (video seeking), existence, deletes, renames, listings, usage, a
// failed streamed write leaving nothing, keys that can't name anything
// else; the desk import's zip read by range from a blob; the settings
// checks and the start-up and readiness rules; and storage secrets kept out
// of log lines.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/file-store.test.ts
// (the blob half needs Azurite: test/support/azurite.ts).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { deflateRawSync } from "node:zlib";
import {
  blobConfig,
  checkFileStoreStartup,
  fileStore,
  fileStoreKind,
  fileStoreProblems,
  fileStoreReadiness,
  isValidStoreKey,
  resetFileStoreForTests,
  storeProblem,
  validContainerName,
  verifyFileStore,
} from "../src/lib/file-store";
import {
  deleteUpload,
  mailAttachment,
  mailAttachmentsForSend,
  readUpload,
  saveUpload,
  storedUsage,
  uploadExists,
  uploadReadStream,
} from "../src/lib/uploads";
import { isZipFile, readZipDirectory, readZipEntry, type ZipSource } from "../src/lib/helpdesk/import-zip";
import { redact } from "../src/lib/log";
import { AZURITE_CONNECTION_STRING, blobEnv, containerClient, freshContainer, skipWithoutAzurite } from "./support/azurite";

const STORE_VARS = ["COMPASSDOCS_FILE_STORE", "COMPASSDOCS_BLOB_CONTAINER", "COMPASSDOCS_BLOB_CONNECTION_STRING", "COMPASSDOCS_BLOB_ACCOUNT_URL", "COMPASSDOCS_UPLOAD_DIR", "COMPASSDOCS_CLOUD"];
const saved = Object.fromEntries(STORE_VARS.map((k) => [k, process.env[k]]));

function setEnv(vars: Record<string, string | undefined>): void {
  for (const k of STORE_VARS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  resetFileStoreForTests();
}

async function text(stream: Readable | null): Promise<string> {
  assert.ok(stream, "a stream");
  const parts: Buffer[] = [];
  for await (const c of stream!) parts.push(c as Buffer);
  return Buffer.concat(parts).toString("utf8");
}

async function streamError(stream: Readable | null): Promise<NodeJS.ErrnoException> {
  try {
    await text(stream);
  } catch (e) {
    return e as NodeJS.ErrnoException;
  }
  assert.fail("the stream should have failed");
}

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetFileStoreForTests();
});

/** A stored zip with one deflated CSV and one stored attachment. */
function tinyZip(): Buffer {
  const entries = [
    { name: "Tickets.csv", data: Buffer.from("id,subject\n1,Printer\n2,VPN\n"), method: 8 },
    { name: "Attachments/screen.png", data: Buffer.from("PNGDATA-0123456789"), method: 0 },
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const body = e.method === 8 ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.method, 8);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.method, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** The same contract, whichever store is configured. */
function contract(label: string, setup: () => Promise<{ env: Record<string, string>; done: () => Promise<void>; skip?: false | string }>) {
  describe(`file store contract: ${label}`, async () => {
    let env: Record<string, string> = {};
    let done: () => Promise<void> = async () => {};
    const ready = await setup().catch((e) => {
      throw e;
    });
    const skip = ready.skip ?? false;
    env = ready.env;
    done = ready.done;
    before(() => setEnv(env));
    after(async () => {
      await done();
    });

    test("saveUpload, readUpload, uploadReadStream (whole and ranges), uploadExists, deleteUpload", { skip }, async () => {
      setEnv(env);
      const body = Buffer.from("0123456789abcdefghij");
      const name = await saveUpload(body, ".mp4");
      assert.match(name, /^[a-f0-9]{32}\.mp4$/);
      assert.equal(await uploadExists(name), true);
      assert.deepEqual(await readUpload(name), body);
      assert.equal(await text(uploadReadStream(name)), body.toString());
      // Inclusive ranges, as the attachment routes ask for them (start-end, start-, suffix).
      assert.equal(await text(uploadReadStream(name, { start: 2, end: 5 })), "2345");
      assert.equal(await text(uploadReadStream(name, { start: 10, end: 19 })), "abcdefghij");
      assert.equal(await text(uploadReadStream(name, { start: 19, end: 19 })), "j");
      assert.equal(await text(uploadReadStream(name, { start: 0, end: 0 })), "0");
      assert.equal((await fileStore().stat(name))?.size, 20);
      await deleteUpload(name);
      assert.equal(await uploadExists(name), false);
      await deleteUpload(name); // already gone: not an error
      const gone = await streamError(uploadReadStream(name));
      assert.equal(gone.code, "ENOENT", "a missing file is ENOENT on the stream, as on disk");
      await assert.rejects(readUpload(name), (e: NodeJS.ErrnoException) => e.code === "ENOENT");
    });

    test("keys can never name anything else", { skip }, async () => {
      setEnv(env);
      for (const bad of ["../etc/passwd", "hd-import/../../x", "/abs", "0123456789abcdef0123456789abcdef/..", "ABCDEF0123456789ABCDEF0123456789", "hd-import/x.zip", ".secret.key", ""]) {
        assert.equal(isValidStoreKey(bad), false, bad);
        assert.equal(uploadReadStream(bad), null);
        assert.equal(await uploadExists(bad), false);
        assert.equal(await fileStore().stat(bad), null);
        await assert.rejects(fileStore().write(bad, Buffer.from("x")), (e: NodeJS.ErrnoException) => e.code === "ENOENT");
        const s = fileStore().readStream(bad);
        assert.equal((await streamError(s)).code, "ENOENT");
      }
      assert.equal(isValidStoreKey("hd-import/0123456789abcdef0123456789abcdef.zip"), true);
    });

    test("writeStream: the size, and a failed stream leaves nothing (rejecting with the stream's own error)", { skip }, async () => {
      setEnv(env);
      const store = fileStore();
      const key = "hd-import/" + "a".repeat(32) + ".csv";
      const size = await store.writeStream(key, Readable.from([Buffer.from("id,subject\n"), Buffer.from("1,Hello\n")], { objectMode: false }));
      assert.equal(size, 19);
      assert.equal((await store.read(key)).toString(), "id,subject\n1,Hello\n");
      class Refused extends Error {}
      const failing = Readable.from(
        (async function* () {
          yield Buffer.alloc(1024, 1);
          throw new Refused("too large");
        })(),
        { objectMode: false }
      );
      const key2 = "hd-import/" + "b".repeat(32) + ".zip";
      await assert.rejects(store.writeStream(key2, failing), (e) => e instanceof Refused);
      assert.equal(await store.stat(key2), null, "nothing is left of the failed write");
      await store.rename(key, "hd-import/" + "c".repeat(32) + ".csv");
      assert.equal(await store.stat(key), null);
      assert.equal((await store.read("hd-import/" + "c".repeat(32) + ".csv")).toString(), "id,subject\n1,Hello\n");
      await store.delete("hd-import/" + "c".repeat(32) + ".csv");
    });

    test("readRange: fewer bytes at the end, none past it", { skip }, async () => {
      setEnv(env);
      const name = await saveUpload(Buffer.from("hello world"), ".txt");
      const store = fileStore();
      assert.equal((await store.readRange(name, 6, 5)).toString(), "world");
      assert.equal((await store.readRange(name, 6, 50)).toString(), "world");
      assert.equal((await store.readRange(name, 11, 4)).length, 0);
      assert.equal((await store.readRange(name, 500, 4)).length, 0);
      await deleteUpload(name);
    });

    test("the desk import's zip, read by range from the store", { skip }, async () => {
      setEnv(env);
      const store = fileStore();
      const key = "hd-import/" + "d".repeat(32) + ".zip";
      await store.write(key, tinyZip());
      const src: ZipSource = {
        size: async () => (await store.stat(key))!.size,
        read: (p, l) => store.readRange(key, p, l),
        stream: (s, e) => store.readStream(key, { start: s, end: e }),
      };
      assert.equal(await isZipFile(src), true);
      const entries = await readZipDirectory(src);
      assert.deepEqual(entries.map((e) => e.name), ["Tickets.csv", "Attachments/screen.png"]);
      assert.equal((await readZipEntry(src, entries[0], 1024)).toString(), "id,subject\n1,Printer\n2,VPN\n");
      assert.equal((await readZipEntry(src, entries[1], 1024)).toString(), "PNGDATA-0123456789");
      await store.delete(key);
    });

    test("list and usage count the stored files (usage metering)", { skip }, async () => {
      setEnv(env);
      const before = await storedUsage();
      const a = await saveUpload(Buffer.alloc(1000, 7), ".bin");
      const b = await saveUpload(Buffer.alloc(24, 1), "");
      const after = await storedUsage();
      assert.equal(after.files - before.files, 2);
      assert.equal(after.bytes - before.bytes, 1024);
      const keys: string[] = [];
      for await (const f of fileStore().list()) keys.push(f.key);
      assert.ok(keys.includes(a) && keys.includes(b));
      await deleteUpload(a);
      await deleteUpload(b);
    });

    test("check: reachable and writable", { skip }, async () => {
      setEnv(env);
      await fileStore().check({ write: true });
      assert.equal(await verifyFileStore(), null);
    });
  });
}

contract("the uploads folder (local, the default)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cd-store-local-"));
  return { env: { COMPASSDOCS_UPLOAD_DIR: dir }, done: () => rm(dir, { recursive: true, force: true }) };
});

contract("an Azure Blob Storage container (Azurite)", async () => {
  const skip = await skipWithoutAzurite();
  if (skip) return { env: {}, done: async () => {}, skip };
  const c = await freshContainer("store");
  return { env: blobEnv(c.name), done: c.drop };
});

describe("the uploads folder is exactly as before 1.21.2", () => {
  test("files are plain files at <upload dir>/<name>, imports under hd-import/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-store-paths-"));
    try {
      setEnv({ COMPASSDOCS_UPLOAD_DIR: dir });
      assert.equal(fileStoreKind(), "local");
      const name = await saveUpload(Buffer.from("plain"), ".txt");
      assert.equal(await readFile(join(dir, name), "utf8"), "plain");
      await fileStore().write("hd-import/" + "e".repeat(32) + ".zip", Buffer.from("PK"));
      assert.ok((await stat(join(dir, "hd-import", "e".repeat(32) + ".zip"))).isFile());
      // A newsletter's attachment is still its path (what the queued jobs of earlier versions hold).
      assert.deepEqual(mailAttachment("a.pdf", name), { filename: "a.pdf", path: join(dir, name) });
      assert.deepEqual(await mailAttachmentsForSend([mailAttachment("a.pdf", name)]), [{ filename: "a.pdf", path: join(dir, name) }]);
      // The key file and anything else in the folder are not stored files.
      await writeFile(join(dir, ".secret.key"), "k");
      await mkdir(join(dir, "lost+found"));
      const keys: string[] = [];
      for await (const f of fileStore().list()) keys.push(f.key);
      assert.deepEqual(keys.sort(), [name, "hd-import/" + "e".repeat(32) + ".zip"].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the blob store as the app uses it", () => {
  test("a newsletter attachment is its stored name, read when the mail is built", async (t) => {
    const skip = await skipWithoutAzurite();
    if (skip) return t.skip(skip);
    const c = await freshContainer("mail");
    try {
      setEnv(blobEnv(c.name));
      const name = await saveUpload(Buffer.from("%PDF-1.4"), ".pdf");
      assert.deepEqual(mailAttachment("a.pdf", name), { filename: "a.pdf", storedName: name });
      assert.deepEqual(await mailAttachmentsForSend([mailAttachment("a.pdf", name)]), [{ filename: "a.pdf", content: Buffer.from("%PDF-1.4") }]);
    } finally {
      await c.drop();
    }
  });

  test("blobs are private application/octet-stream, under their stored names only", async (t) => {
    const skip = await skipWithoutAzurite();
    if (skip) return t.skip(skip);
    const c = await freshContainer("priv");
    try {
      setEnv(blobEnv(c.name));
      const name = await saveUpload(Buffer.from("<svg onload=alert(1)>"), ".svg");
      const cc = await containerClient(c.name);
      const props = await cc.getBlockBlobClient(name).getProperties();
      assert.equal(props.contentType, "application/octet-stream");
      const access = (await cc.getProperties()).blobPublicAccess;
      assert.ok(!access, "the container is not public");
      const names: string[] = [];
      for await (const b of cc.listBlobsFlat()) names.push(b.name);
      assert.deepEqual(names, [name]);
    } finally {
      await c.drop();
    }
  });

  test("a container that does not exist is a configuration problem, not ready; one that answers is verified once", async (t) => {
    const skip = await skipWithoutAzurite();
    if (skip) return t.skip(skip);
    setEnv(blobEnv("no-such-container-here"));
    const p = await verifyFileStore(3000);
    assert.equal(p?.kind, "config");
    assert.match(p!.message, /^The container does not exist: Azure Blob Storage \(127\.0\.0\.1\), container no-such-container-here\./);
    const logged: unknown[] = [];
    assert.ok(await fileStoreReadiness(3000, (...a) => logged.push(a)));
    assert.ok(await fileStoreReadiness(3000, (...a) => logged.push(a)));
    assert.equal(logged.length, 1, "the same failure is logged once");
    const c = await freshContainer("ready");
    try {
      setEnv(blobEnv(c.name));
      assert.equal(await fileStoreReadiness(3000), null);
      await c.drop();
      // Verified once: a later blip does not take the replica out of rotation.
      assert.equal(await fileStoreReadiness(3000), null);
    } finally {
      await c.drop();
    }
  });

  test("start-up: a bad setting exits 1 with one line each; an unreachable container is one line and no exit", async () => {
    const lines: { level: string; event: string; message: string }[] = [];
    const log = (level: string, event: string, f: Record<string, unknown>) => lines.push({ level, event, message: String(f.message) });
    let code: number | null = null;
    setEnv({ COMPASSDOCS_FILE_STORE: "blob" });
    assert.equal(await checkFileStoreStartup(log, (c) => (code = c)), false);
    assert.equal(code, 1);
    assert.deepEqual(
      lines.map((l) => l.event),
      ["file_store.refused_to_start", "file_store.refused_to_start"]
    );
    assert.match(lines[0].message, /COMPASSDOCS_BLOB_CONTAINER is not set/);
    assert.match(lines[1].message, /COMPASSDOCS_BLOB_ACCOUNT_URL is not set/);

    lines.length = 0;
    code = null;
    // Nothing listens on port 9: no answer.
    setEnv({
      COMPASSDOCS_FILE_STORE: "blob",
      COMPASSDOCS_BLOB_CONTAINER: "acme",
      COMPASSDOCS_BLOB_CONNECTION_STRING: AZURITE_CONNECTION_STRING.replace("127.0.0.1:10000", "127.0.0.1:9"),
    });
    assert.equal(await checkFileStoreStartup(log, (c) => (code = c)), true);
    assert.equal(code, null);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "file_store.unreachable");
    assert.doesNotMatch(lines[0].message, /Eby8vdM02/, "never the account key");

    lines.length = 0;
    setEnv({});
    assert.equal(await checkFileStoreStartup(log, (c) => (code = c)), true);
    assert.deepEqual(lines, [], "the uploads folder: nothing checked, nothing said");
  });
});

describe("settings", () => {
  const cloud = { COMPASSDOCS_CLOUD: "1" };
  const ok = { COMPASSDOCS_FILE_STORE: "blob", COMPASSDOCS_BLOB_CONTAINER: "ws-acme", COMPASSDOCS_BLOB_ACCOUNT_URL: "https://cdcloud.blob.core.windows.net" };

  test("valid settings, and the uploads folder by default", () => {
    assert.deepEqual(fileStoreProblems({}), { fatal: [], warnings: [] });
    assert.deepEqual(fileStoreProblems({ COMPASSDOCS_FILE_STORE: "local" }), { fatal: [], warnings: [] });
    assert.deepEqual(fileStoreProblems(ok), { fatal: [], warnings: [] });
    assert.deepEqual(fileStoreProblems({ ...ok, ...cloud }), { fatal: [], warnings: [] });
    assert.equal(fileStoreKind({}), "local");
    assert.equal(fileStoreKind({ COMPASSDOCS_FILE_STORE: " Blob " }), "blob");
    assert.deepEqual(blobConfig({ ...ok, COMPASSDOCS_BLOB_ACCOUNT_URL: "https://cdcloud.blob.core.windows.net/" }).accountUrl, "https://cdcloud.blob.core.windows.net");
  });

  test("cloud mode on the uploads folder is a warning: it must be a shared volume", () => {
    const r = fileStoreProblems(cloud);
    assert.deepEqual(r.fatal, []);
    assert.match(r.warnings[0], /persistent volume every replica shares/);
  });

  test("each bad setting is one sentence", () => {
    const fatal = (env: Record<string, string>) => fileStoreProblems(env).fatal;
    assert.match(fatal({ COMPASSDOCS_FILE_STORE: "s3" })[0], /must be "local" or "blob"/);
    assert.match(fatal({ ...ok, COMPASSDOCS_BLOB_CONTAINER: "Bad_Name" })[0], /not a valid container name/);
    assert.match(fatal({ ...ok, COMPASSDOCS_BLOB_ACCOUNT_URL: "http://cdcloud.blob.core.windows.net" })[0], /must be an https:\/\/ address/);
    assert.match(fatal({ ...ok, COMPASSDOCS_BLOB_ACCOUNT_URL: "https://cdcloud.blob.core.windows.net?sv=2024&sig=abc" })[0], /no SAS or other query string/);
    assert.match(fatal({ ...ok, COMPASSDOCS_BLOB_ACCOUNT_URL: "https://cdcloud.blob.core.windows.net/ws-acme" })[0], /the container goes in COMPASSDOCS_BLOB_CONTAINER/);
    assert.match(fatal({ ...ok, COMPASSDOCS_BLOB_ACCOUNT_URL: "not a url" })[0], /not a valid URL/);
    // A real account's connection string (a key) is refused in cloud mode; Azurite's (loopback) is fine.
    const real = "DefaultEndpointsProtocol=https;AccountName=cdcloud;AccountKey=c2VjcmV0;EndpointSuffix=core.windows.net";
    assert.match(fatal({ ...ok, ...cloud, COMPASSDOCS_BLOB_CONNECTION_STRING: real })[0], /for development against Azurite only/);
    assert.deepEqual(fatal({ ...ok, ...cloud, COMPASSDOCS_BLOB_CONNECTION_STRING: AZURITE_CONNECTION_STRING }), []);
    assert.match(fileStoreProblems({ ...ok, COMPASSDOCS_BLOB_CONNECTION_STRING: real }).warnings[0], /prefer COMPASSDOCS_BLOB_ACCOUNT_URL/);
    assert.equal(validContainerName("ws-acme-01"), true);
    assert.equal(validContainerName("ws--acme"), false);
    assert.equal(validContainerName("ab"), false);
  });

  test("an authorisation failure names the role to grant, and never a secret", () => {
    setEnv(ok);
    const p = storeProblem(Object.assign(new Error("This request is not authorized to perform this operation using this permission."), { statusCode: 403, code: "AuthorizationPermissionMismatch" }));
    assert.equal(p.kind, "config");
    assert.match(p.message, /Storage Blob Data Contributor/);
    assert.match(p.message, /\(cdcloud\.blob\.core\.windows\.net\), container ws-acme/);
    const n = storeProblem(Object.assign(new Error("getaddrinfo ENOTFOUND cdcloud.blob.core.windows.net"), { code: "ENOTFOUND" }));
    assert.equal(n.kind, "unreachable");
    const cred = storeProblem(Object.assign(new Error("ManagedIdentityCredential: no managed identity endpoint"), { name: "CredentialUnavailableError" }));
    assert.equal(cred.kind, "config");
    assert.match(cred.message, /managed identity/);
  });
});

test("log lines never carry a storage key, a SAS signature or the development connection string", () => {
  const env = { COMPASSDOCS_BLOB_CONNECTION_STRING: "DefaultEndpointsProtocol=https;AccountName=cdcloud;AccountKey=bXlTZWNyZXRLZXk9PQ==;EndpointSuffix=core.windows.net" };
  const line = redact(
    `failed with ${env.COMPASSDOCS_BLOB_CONNECTION_STRING} and AccountKey=QUJDREVGRzEyMzQ1Ng==;BlobEndpoint=x and https://a.blob.core.windows.net/c/b?sv=2024-01-01&se=2026&sig=ab%2Bcd%3D&sp=r and SharedAccessSignature=sv=2024&sig=zz;`,
    env
  );
  assert.doesNotMatch(line, /bXlTZWNyZXRLZXk9PQ|QUJDREVGRzEyMzQ1Ng|ab%2Bcd|sig=zz/);
  assert.match(line, /\[redacted\]/);
  assert.match(line, /sp=r/, "the rest of the URL stays readable");
});
