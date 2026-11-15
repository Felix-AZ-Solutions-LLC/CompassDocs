// Two ways a boot (lib/db initialize) met other work on the same database:
//
//   - the ladder backfill (migrateLadderToAssignments) runs on every boot and
//     fills in a global role assignment for each user that lacks one. Its
//     foreign key check locked those users one by one, so a statement
//     deleting several of them in another order deadlocked with it (40P01:
//     one held user A and wanted B, the other the reverse). Seen as the
//     integration suite's "deadlock detected" in a before hook, when one
//     file booted while another tore its accounts down; the same holds for a
//     replica starting while another serves a bulk removal. It now skips a
//     user another transaction is deleting, so it never waits on one;
//   - a boot that failed was cached: every later query of the process failed
//     with the same error until a restart. Now the next query boots again.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/boot-races.test.ts

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Client, Pool } from "pg";
import { getSetting, migrateLadderToAssignments, pool } from "../src/lib/db";

const STAMP = `boot-race-${Date.now()}-${process.pid}`;

after(async () => {
  await pool().end();
});

test("a boot that failed is tried again by the next query, not kept", async () => {
  // This process has not booted yet: the first boot gets a pool that cannot connect.
  assert.equal(global.__compassInit, undefined, "this file must run before anything else boots in its process");
  const real = global.__compassPool;
  global.__compassPool = new Pool({ host: "127.0.0.1", port: 1, connectionTimeoutMillis: 2000 });
  try {
    await assert.rejects(getSetting("__schema_bootstrap__"));
  } finally {
    await global.__compassPool.end().catch(() => {});
    global.__compassPool = real;
  }
  // The database is reachable again: the next query boots and answers.
  await getSetting("__schema_bootstrap__");
});

test("the ladder backfill skips a user another transaction is deleting, so the two never deadlock", async () => {
  const ids: number[] = [];
  for (let i = 0; i < 2; i++) {
    const r = await pool().query("INSERT INTO users (username, name, email, role, status) VALUES ($1, $1, $1 || '@example.test', 'viewer', 'active') RETURNING id", [`${STAMP}-${i}`]);
    ids.push(r.rows[0].id);
  }
  const ladder = async (id: number) =>
    (await pool().query("SELECT 1 FROM role_assignments ra JOIN roles r ON r.id = ra.role_id WHERE ra.user_id = $1 AND r.key = 'viewer' AND ra.scope_type = 'global'", [id])).rowCount;
  // Both lose their ladder assignment (as a restore from an older dump, or a teardown, leaves them).
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [ids]);
  const [gone, kept] = ids;
  const remover = new Client({ connectionString: process.env.DATABASE_URL });
  await remover.connect();
  const booter = await pool().connect();
  try {
    // One statement's worth of a bulk removal: the first user deleted, the second still to come.
    await remover.query("BEGIN");
    await remover.query("DELETE FROM users WHERE id = $1", [gone]);
    // The boot's backfill runs meanwhile. It used to wait on the deleted user (and, holding the
    // second one, deadlock with the removal's next row); now it goes past it.
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      migrateLadderToAssignments(booter).then(() => "done"),
      new Promise<string>((r) => (timer = setTimeout(() => r("waited on the user being deleted"), 5000))),
    ]);
    clearTimeout(timer);
    assert.equal(outcome, "done");
    assert.equal(await ladder(kept), 1, "the user nobody is deleting got its assignment back");
    // The removal goes on to the second user and commits.
    await remover.query("DELETE FROM users WHERE id = $1", [kept]);
    await remover.query("COMMIT");
    assert.equal((await pool().query("SELECT count(*)::int AS n FROM users WHERE id = ANY($1)", [ids])).rows[0].n, 0);
  } finally {
    await remover.query("ROLLBACK").catch(() => {});
    await remover.end();
    booter.release();
    await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [ids]);
    await pool().query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  }
});
