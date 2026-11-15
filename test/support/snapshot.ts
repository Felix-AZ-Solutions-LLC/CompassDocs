// Run some reads of the app's code against one consistent view of the
// database, while other test files keep writing to it.
//
// Every lib/db and lib/helpdesk query goes through pool() (lib/db), which
// hands back global.__compassPool. For the length of `fn` that is replaced by
// one connection inside a REPEATABLE READ READ ONLY transaction, so every
// statement `fn` runs sees the same snapshot: two code paths that read the
// same facts can be compared without another file's commit landing between
// them. READ ONLY makes a write inside `fn` fail loudly instead of quietly
// joining the snapshot. Anything else this process runs meanwhile goes
// through the same connection, so keep `fn` to reads, with no background
// work of the file still running.

import type { Pool } from "pg";
import { pool } from "../../src/lib/db";

export async function inOneSnapshot<T>(fn: () => Promise<T>): Promise<T> {
  const real = pool();
  const client = await real.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const query = client.query.bind(client);
  const pinned = {
    query,
    connect: async () => ({ query, release: () => {} }),
  } as unknown as Pool;
  global.__compassPool = pinned;
  try {
    return await fn();
  } finally {
    global.__compassPool = real;
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}
