// A user with no role at all — the ladder role taken away — is how a test
// makes "an account that can't use Get help" (or that holds nothing else).
// Deleting the user's role_assignments does that, but not for long: every
// process's boot (lib/db initialize) runs migrateLadderToAssignments, which
// gives each user without one the built-in role named by users.role again.
// The integration suite runs its files in parallel processes against one
// database, and they boot at different times, so another file booting
// between the delete and the check hands the user Viewer back — and with it
// helpdesk.request, which every built-in role holds.
//
// withoutLadderRole holds the boot lock (728341, the advisory lock
// initialize takes around the schema and that backfill) for the delete and
// the check together: a boot under way finishes first, and one that starts
// meanwhile waits the few milliseconds until the check is done. Keep the
// body short — every other test file's boot waits on it — and don't boot
// inside it (this file's own boot is done once its before() has run).
//
// The lock is taken on a connection of its own, outside lib/db's pool, so
// the body keeps all of the pool's connections; ending that connection
// frees the lock, whichever way the body finishes.
//
// When the role-less state has to last longer than a lock should be held —
// a whole describe, or checks that poll a mailbox and send mail — use
// noLadderRung instead: it points users.role at a key no built-in role has,
// so the ladder trigger drops the user's rung assignment and the backfill
// (which only restores the built-in role users.role names) has nothing to
// give back. No lock, so nothing waits on it. The user must be one the test
// made, and deleted or reset afterwards (helpdesk-status-teams does the same
// for Nat Nostatus).

import { Client } from "pg";

/** The advisory lock lib/db's initialize() holds while it boots the schema. */
export const BOOT_LOCK = 728341;

/** Take these users' role assignments away and run `body` before any boot can give them back. */
export async function withoutLadderRole<T>(userIds: number[], body: () => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: `ladder-lock:${process.pid}` });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [BOOT_LOCK]);
    await client.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
    return await body();
  } finally {
    await client.end().catch(() => {});
  }
}

/** A users.role value that names no built-in role: the ladder backfill has nothing to restore. */
export const NO_RUNG = "test-no-rung";

/** Take these users' role assignments away for good: their rung names no built-in role, so no boot gives one back. */
export async function noLadderRung(userIds: number[]): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: `ladder-lock:no-rung:${process.pid}` });
  await client.connect();
  try {
    await client.query("UPDATE users SET role = $2 WHERE id = ANY($1)", [userIds, NO_RUNG]);
    await client.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  } finally {
    await client.end().catch(() => {});
  }
}
