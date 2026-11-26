// The copy command (1.21.2, scripts/copy-uploads-to-blob.cjs): an existing
// uploads folder into a blob container (Azurite). Copies exactly the stored
// files (never the key file or anything else), verifies each by size and
// MD5, is idempotent and resumable, never overwrites different content, and
// accepts exactly the names the app stores.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/copy-uploads-to-blob.test.ts
// (needs Azurite: test/support/azurite.ts).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STORE_KEY_PATTERN } from "../src/lib/file-store";
import { AZURITE_CONNECTION_STRING, containerClient, freshContainer, skipWithoutAzurite } from "./support/azurite";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const copy = require("../scripts/copy-uploads-to-blob.cjs") as {
  run: (argv: string[], env: Record<string, string | undefined>, out: (line: string) => void) => Promise<number>;
  KEY_RE: RegExp;
};

const A = "0123456789abcdef0123456789abcdef.pdf";
const B = "fedcba9876543210fedcba9876543210";
const IMPORT = "hd-import/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.zip";

let dir = "";
let container: { name: string; drop: () => Promise<void> } | null = null;
let skip: false | string = false;

before(async () => {
  skip = await skipWithoutAzurite();
  dir = await mkdtemp(join(tmpdir(), "cd-copy-"));
  await writeFile(join(dir, A), "%PDF-1.4 the contract");
  await writeFile(join(dir, B), Buffer.alloc(5 * 1024 * 1024 + 17, 3)); // more than one block
  await mkdir(join(dir, "hd-import"));
  await writeFile(join(dir, IMPORT), "PK zip");
  await writeFile(join(dir, ".secret.key"), "the master key");
  await writeFile(join(dir, "notes.txt"), "not a stored file");
  await mkdir(join(dir, "lost+found"));
  await symlink(join(dir, A), join(dir, "11111111111111111111111111111111.pdf"));
  if (!skip) container = await freshContainer("copy");
});

after(async () => {
  await container?.drop();
  await rm(dir, { recursive: true, force: true });
});

async function runCopy(extra: string[] = []): Promise<{ code: number; summary: Record<string, any> }> {
  const out: string[] = [];
  const code = await copy.run(["--from", dir, "--container", container!.name, "--json", ...extra], { COMPASSDOCS_BLOB_CONNECTION_STRING: AZURITE_CONNECTION_STRING }, (l) => out.push(l));
  return { code, summary: JSON.parse(out.join("\n")) };
}

async function blobs(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for await (const b of (await containerClient(container!.name)).listBlobsFlat()) out[b.name] = b.properties.contentLength ?? -1;
  return out;
}

test("the command accepts exactly the names the app stores", () => {
  assert.equal(copy.KEY_RE.source, STORE_KEY_PATTERN);
});

test("a dry run copies nothing", async (t) => {
  if (skip) return t.skip(skip);
  const { code, summary } = await runCopy(["--dry-run"]);
  assert.equal(code, 0);
  assert.equal(summary.would_copy, 3);
  assert.deepEqual(await blobs(), {});
});

test("copies the stored files, verified, and nothing else", async (t) => {
  if (skip) return t.skip(skip);
  const { code, summary } = await runCopy();
  assert.equal(code, 0);
  assert.equal(summary.files, 3);
  assert.equal(summary.copied, 3);
  assert.deepEqual(await blobs(), { [A]: 21, [B]: 5 * 1024 * 1024 + 17, [IMPORT]: 6 });
  const skipped = Object.fromEntries((summary.skipped as { path: string; reason: string }[]).map((s) => [s.path, s.reason]));
  assert.match(skipped[".secret.key"], /master key file \(never copied/);
  assert.match(skipped["notes.txt"], /not a stored file/);
  assert.match(skipped["lost+found/"], /folder/);
  assert.match(skipped["11111111111111111111111111111111.pdf"], /not a regular file/);
  const cc = await containerClient(container!.name);
  assert.equal((await cc.getBlockBlobClient(A).downloadToBuffer()).toString(), "%PDF-1.4 the contract");
  assert.ok((await cc.getBlockBlobClient(B).getProperties()).contentMD5, "the MD5 is stored for later checks");
  // The source folder is never changed.
  assert.equal(await readFile(join(dir, ".secret.key"), "utf8"), "the master key");
});

test("idempotent and resumable: a second run copies nothing; a missing blob is copied again", async (t) => {
  if (skip) return t.skip(skip);
  let r = await runCopy();
  assert.equal(r.code, 0);
  assert.equal(r.summary.copied, 0);
  assert.equal(r.summary.already_present, 3);
  // A run stopped part-way: one file never made it.
  await (await containerClient(container!.name)).getBlockBlobClient(IMPORT).delete();
  r = await runCopy();
  assert.equal(r.summary.copied, 1);
  assert.equal(r.summary.already_present, 2);
});

test("a blob with different content is a conflict, never overwritten", async (t) => {
  if (skip) return t.skip(skip);
  const cc = await containerClient(container!.name);
  await cc.getBlockBlobClient(A).uploadData(Buffer.from("someone else's file"));
  const r = await runCopy();
  assert.equal(r.code, 1);
  assert.equal(r.summary.conflicts.length, 1);
  assert.equal(r.summary.conflicts[0].key, A);
  assert.equal((await cc.getBlockBlobClient(A).downloadToBuffer()).toString(), "someone else's file");
});

test("bad usage exits 2 and says why", async () => {
  const out: string[] = [];
  assert.equal(await copy.run(["--from", dir], {}, (l) => out.push(l)), 2);
  assert.match(out[0], /name the container/);
  out.length = 0;
  assert.equal(await copy.run(["--container", "x", "--account-url", "https://a.blob.core.windows.net?sig=abc"], {}, (l) => out.push(l)), 2);
  assert.match(out[0], /no SAS/);
  out.length = 0;
  assert.equal(await copy.run(["--frob"], {}, (l) => out.push(l)), 2);
});
