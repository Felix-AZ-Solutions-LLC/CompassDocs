// An asset sync as the workspace would run it with no other source syncing.
//
// A sync claims its run under an advisory lock (lib/helpdesk/assets
// syncProvider: pg_try_advisory_xact_lock), and the key is one per kind of
// source: ASSETS_SYNC_LOCK for every Snipe-IT source, INTUNE_SYNC_LOCK for
// every Intune one. A workspace has one of each, so that is "one run at a
// time". The test files each sync their own stamped source (snipeit:<stamp>,
// intune:<stamp>) against one database, and helpdesk-intune holds the
// Snipe-IT key on purpose; a claim made while another file's claim holds the
// key answers "running" though nothing runs on this file's source.
//
// That answer is taken only when the source's own record says a run is live
// (what "running" means for it); otherwise the claim is made again. The
// other files' claims are short transactions, so a few tries at most.

import type * as Assets from "../../src/lib/helpdesk/assets";

type AssetsModule = Pick<typeof Assets, "syncProvider" | "syncState" | "assetsSweep">;
type SyncResult = Awaited<ReturnType<typeof Assets.syncProvider>>;

const pause = () => new Promise((r) => setTimeout(r, 50));

/** syncProvider(key, opts), made again while "running" is only another source's claim. */
export async function syncAlone(assets: AssetsModule, key: string, opts: { force?: boolean } = { force: true }): Promise<SyncResult> {
  for (let i = 0; ; i++) {
    const r = await assets.syncProvider(key, opts);
    if (r.skipped !== "running" || (await assets.syncState(key)).running || i >= 200) return r;
    await pause();
  }
}

/**
 * assetsSweep() for a workspace whose sources are `keys`, in the sweep's
 * order (Snipe-IT, then Intune). A source the sweep skipped as "running"
 * while its own record is not live (another file's claim held the key) is
 * synced again the way the sweep syncs it (not forced), so the answer is
 * the sweep's as if nothing else were syncing.
 */
export async function sweepAlone(assets: AssetsModule, keys: string | string[]): Promise<SyncResult[]> {
  const list = Array.isArray(keys) ? keys : [keys];
  const r = await assets.assetsSweep();
  if (r.length !== list.length) return r;
  for (let i = 0; i < r.length; i++) {
    if (r[i].skipped === "running" && !(await assets.syncState(list[i])).running) r[i] = await syncAlone(assets, list[i], {});
  }
  return r;
}
