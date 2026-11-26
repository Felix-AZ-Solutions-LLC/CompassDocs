// Azurite, the Azure Storage emulator, for the blob store's tests (1.21.2).
//
// CI starts it before the integration step (.github/workflows/e2e.yml); on
// a machine without it, run it first:
//
//   npx azurite@3.37.0 azurite-blob --silent --skipApiVersionCheck --loose --location /tmp/azurite --blobHost 127.0.0.1
//
// AZURITE_CONNECTION_STRING overrides the well-known development account.
// Without Azurite the blob tests are skipped, except in CI (CI=true), where
// they fail: a green run there always ran them.

import { randomBytes } from "node:crypto";

/** Azurite's published development account (not a secret: it is in Microsoft's documentation). */
export const AZURITE_CONNECTION_STRING =
  process.env.AZURITE_CONNECTION_STRING ||
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

let reachable: Promise<boolean> | null = null;

/** Is Azurite answering? Asked once per test file. */
export function azuriteReachable(): Promise<boolean> {
  reachable ??= (async () => {
    try {
      const { BlobServiceClient } = await import("@azure/storage-blob");
      const svc = BlobServiceClient.fromConnectionString(AZURITE_CONNECTION_STRING, { retryOptions: { maxTries: 1 } });
      await svc.listContainers().byPage({ maxPageSize: 1 }).next();
      return true;
    } catch {
      return false;
    }
  })();
  return reachable;
}

/** The `skip` option for a blob test: false when Azurite answers; a reason (never in CI) when it doesn't. */
export async function skipWithoutAzurite(): Promise<false | string> {
  if (await azuriteReachable()) return false;
  if (process.env.CI) throw new Error("Azurite is not running at 127.0.0.1:10000, and CI must run the blob store's tests.");
  return "Azurite is not running (see test/support/azurite.ts)";
}

/** A new, empty container; `drop` removes it. */
export async function freshContainer(prefix = "t"): Promise<{ name: string; drop: () => Promise<void> }> {
  const { BlobServiceClient } = await import("@azure/storage-blob");
  const svc = BlobServiceClient.fromConnectionString(AZURITE_CONNECTION_STRING);
  const name = `${prefix}-${randomBytes(6).toString("hex")}`;
  await svc.getContainerClient(name).create();
  return { name, drop: async () => void (await svc.getContainerClient(name).deleteIfExists()) };
}

/** The container's client (tests look at what was stored, behind the app's back). */
export async function containerClient(name: string) {
  const { BlobServiceClient } = await import("@azure/storage-blob");
  return BlobServiceClient.fromConnectionString(AZURITE_CONNECTION_STRING).getContainerClient(name);
}

/** The environment that points the app's file store at a container. */
export function blobEnv(container: string): Record<string, string> {
  return { COMPASSDOCS_FILE_STORE: "blob", COMPASSDOCS_BLOB_CONTAINER: container, COMPASSDOCS_BLOB_CONNECTION_STRING: AZURITE_CONNECTION_STRING };
}
