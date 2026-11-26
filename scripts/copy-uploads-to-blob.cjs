#!/usr/bin/env node
// Copy an install's uploads folder into its Azure Blob Storage container
// (1.21.2), to move an existing install onto the blob store
// (COMPASSDOCS_FILE_STORE=blob, lib/file-store).
//
//   node copy-uploads-to-blob.cjs [--from /uploads] [--container NAME]
//        [--account-url https://ACCOUNT.blob.core.windows.net] [--dry-run]
//        [--create-container] [--concurrency 4] [--json]
//
// Settings default to the same variables the app reads: COMPASSDOCS_UPLOAD_DIR
// (/uploads), COMPASSDOCS_BLOB_CONTAINER, COMPASSDOCS_BLOB_ACCOUNT_URL, or
// COMPASSDOCS_BLOB_CONNECTION_STRING (Azurite / development). With an account
// URL it signs in with DefaultAzureCredential: an operator's `az login`, a
// service principal (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET),
// or the managed identity where it runs. It needs the Storage Blob Data
// Contributor role on the container.
//
// What it copies: every stored file, exactly the names the app stores and
// accepts ("<32 hex>.<ext>" and "hd-import/<32 hex>.zip|csv"). Anything else
// in the folder is listed as skipped and never copied: the master key file
// (.secret.key: cloud mode takes the key from COMPASSDOCS_SECRET_KEY, so give
// it this file's contents), backups, scratch files, links, folders.
//
// Idempotent and resumable: a file whose blob already exists with the same
// size and MD5 is left alone, so a run that was stopped is simply run again.
// A blob that exists with different content is never overwritten: it is
// reported as a conflict and the run exits 1. Every file it writes is read
// back (size and the MD5 the service stored) before it is counted as copied.
// The source folder is never changed.
//
// Exit codes: 0 everything is in the container; 1 a conflict or a failed
// file (run again once fixed); 2 bad usage or settings.
//
// Plain CommonJS with only the Azure SDK (shipped in the image's
// node_modules): it runs as `node copy-uploads-to-blob.cjs` in the image's
// /app, or from a source checkout as `node scripts/copy-uploads-to-blob.cjs`.

"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

/** lib/file-store KEY_RE: the names a stored file may have (a test keeps the two the same). */
const KEY_RE = /^(?:hd-import\/)?[a-f0-9]{32}(?:\.[a-z0-9]{1,12})?$/;

function parseArgs(argv, env) {
  const opts = {
    from: env.COMPASSDOCS_UPLOAD_DIR || "/uploads",
    container: (env.COMPASSDOCS_BLOB_CONTAINER || "").trim(),
    accountUrl: (env.COMPASSDOCS_BLOB_ACCOUNT_URL || "").trim().replace(/\/+$/, ""),
    connectionString: (env.COMPASSDOCS_BLOB_CONNECTION_STRING || "").trim(),
    dryRun: false,
    createContainer: false,
    concurrency: 4,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value.`);
      return v;
    };
    if (a === "--from") opts.from = value();
    else if (a === "--container") opts.container = value();
    else if (a === "--account-url") opts.accountUrl = value().replace(/\/+$/, "");
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--create-container") opts.createContainer = true;
    else if (a === "--concurrency") opts.concurrency = Math.max(1, Math.min(32, Number(value()) || 4));
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`Unknown option ${a}.`);
  }
  return opts;
}

/** Every file under `root`, split into the stored files to copy and everything else. */
async function survey(root) {
  const files = [];
  const skipped = [];
  async function walk(rel) {
    const abs = rel ? path.join(root, rel) : root;
    const names = (await fsp.readdir(abs)).sort();
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      const st = await fsp.lstat(path.join(root, r));
      if (st.isDirectory()) {
        // Stored files live at the top and in hd-import/ only; any other folder is not the app's.
        if (r === "hd-import") await walk(r);
        else skipped.push({ path: `${r}/`, reason: "a folder the app does not store files in" });
      } else if (!st.isFile()) {
        skipped.push({ path: r, reason: "not a regular file" });
      } else if (!KEY_RE.test(r)) {
        skipped.push({ path: r, reason: n === ".secret.key" ? "the master key file (never copied: set COMPASSDOCS_SECRET_KEY to its contents)" : "not a stored file's name" });
      } else {
        files.push({ key: r, abs: path.join(root, r), size: st.size });
      }
    }
  }
  await walk("");
  return { files, skipped };
}

function md5File(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("md5");
    fs.createReadStream(abs)
      .on("error", reject)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest()));
  });
}

async function containerClient(opts) {
  // import(), not require(): the image ships the SDK's ES module build, the one the app loads.
  const { BlobServiceClient } = await import("@azure/storage-blob");
  let service;
  if (opts.connectionString) service = BlobServiceClient.fromConnectionString(opts.connectionString);
  else {
    const { DefaultAzureCredential } = await import("@azure/identity");
    service = new BlobServiceClient(opts.accountUrl, new DefaultAzureCredential());
  }
  return service.getContainerClient(opts.container);
}

async function blobProps(blob) {
  try {
    return await blob.getProperties();
  } catch (e) {
    if (e && (e.statusCode === 404 || e.code === "BlobNotFound")) return null;
    throw e;
  }
}

function sameMd5(a, b) {
  return !!a && !!b && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

/** Copy one file: skip when already there, refuse to overwrite different content, verify what it wrote. */
async function copyOne(container, f, opts) {
  const blob = container.getBlockBlobClient(f.key);
  const md5 = await md5File(f.abs);
  const existing = await blobProps(blob);
  if (existing) {
    if (existing.contentLength === f.size && (sameMd5(existing.contentMD5, md5) || !existing.contentMD5)) {
      // No stored MD5 (written by the app itself, which does not set one): the same size is the check.
      return { key: f.key, outcome: "present", size: f.size };
    }
    return { key: f.key, outcome: "conflict", size: f.size, detail: `the container already holds ${f.key} with different content (${existing.contentLength} bytes); not overwritten` };
  }
  if (opts.dryRun) return { key: f.key, outcome: "would-copy", size: f.size };
  await blob.uploadStream(fs.createReadStream(f.abs), 4 * 1024 * 1024, 4, {
    blobHTTPHeaders: { blobContentType: "application/octet-stream", blobContentMD5: md5 },
    // Never over a blob that appeared meanwhile (another run): that one is checked instead, next run.
    conditions: { ifNoneMatch: "*" },
  });
  const after = await blobProps(blob);
  if (!after || after.contentLength !== f.size || !sameMd5(after.contentMD5, md5)) {
    return { key: f.key, outcome: "failed", size: f.size, detail: `read back ${after ? after.contentLength : "nothing"} bytes; expected ${f.size}` };
  }
  return { key: f.key, outcome: "copied", size: f.size };
}

async function run(argv = process.argv.slice(2), env = process.env, out = (line) => process.stdout.write(line + "\n")) {
  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (e) {
    out(`error: ${e.message}`);
    return 2;
  }
  if (opts.help) {
    out(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 40).filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    return 0;
  }
  if (!opts.container) {
    out("error: name the container: --container or COMPASSDOCS_BLOB_CONTAINER.");
    return 2;
  }
  if (!opts.connectionString && !/^https:\/\/[^/?#]+$/.test(opts.accountUrl)) {
    out("error: give the account address (https://ACCOUNT.blob.core.windows.net, no SAS): --account-url or COMPASSDOCS_BLOB_ACCOUNT_URL.");
    return 2;
  }
  let surveyed;
  try {
    surveyed = await survey(path.resolve(opts.from));
  } catch (e) {
    out(`error: can't read ${opts.from}: ${e.message}`);
    return 2;
  }
  const container = await containerClient(opts);
  if (opts.createContainer && !opts.dryRun) await container.createIfNotExists();
  const results = [];
  let next = 0;
  async function worker() {
    while (next < surveyed.files.length) {
      const f = surveyed.files[next++];
      try {
        results.push(await copyOne(container, f, opts));
      } catch (e) {
        const detail = e && e.message ? String(e.message).split("\n")[0] : String(e);
        results.push({ key: f.key, outcome: "failed", size: f.size, detail });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, Math.max(1, surveyed.files.length)) }, worker));
  results.sort((a, b) => (a.key < b.key ? -1 : 1));
  const count = (o) => results.filter((r) => r.outcome === o);
  const summary = {
    from: path.resolve(opts.from),
    container: opts.container,
    dry_run: opts.dryRun,
    files: surveyed.files.length,
    bytes: surveyed.files.reduce((n, f) => n + f.size, 0),
    copied: count("copied").length,
    already_present: count("present").length,
    would_copy: count("would-copy").length,
    conflicts: count("conflict").map((r) => ({ key: r.key, detail: r.detail })),
    failed: count("failed").map((r) => ({ key: r.key, detail: r.detail })),
    skipped: surveyed.skipped,
  };
  if (opts.json) out(JSON.stringify(summary));
  else {
    out(`${summary.files} stored files (${summary.bytes} bytes) in ${summary.from} -> container ${summary.container}${opts.dryRun ? " (dry run)" : ""}`);
    out(`  copied and verified: ${summary.copied}; already there: ${summary.already_present}${opts.dryRun ? `; would copy: ${summary.would_copy}` : ""}`);
    for (const c of summary.conflicts) out(`  conflict: ${c.key}: ${c.detail}`);
    for (const f of summary.failed) out(`  failed: ${f.key}: ${f.detail}`);
    for (const s of summary.skipped) out(`  skipped: ${s.path}: ${s.reason}`);
    out(summary.conflicts.length || summary.failed.length ? "Not everything is in the container: fix the above and run again." : "Every stored file is in the container.");
  }
  return summary.conflicts.length || summary.failed.length ? 1 : 0;
}

module.exports = { run, parseArgs, survey, KEY_RE };

if (require.main === module) {
  run().then(
    (code) => process.exit(code),
    (e) => {
      process.stdout.write(`error: ${e && e.message ? String(e.message).split("\n")[0] : e}\n`);
      process.exit(1);
    }
  );
}
