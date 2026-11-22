// Directory mapping patterns stored before RE2 was required (a lookaround, a
// backreference): they must keep working after the upgrade and survive any
// edit of their field, while a new or edited pattern must compile in RE2 and
// is refused with the engine's reason. Against a real PostgreSQL, because
// what matters is the stored row: parseField and updateField round-tripping it.
//
// Run: npm run test:integration  (needs DATABASE_URL)

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { pool, getSetting } from "../src/lib/db";
import { applyFieldMappings, createField, deleteField, listFields, reapplyMappings, updateField } from "../src/lib/directory";
import { legacyPatterns } from "../src/lib/directory-mapping";

const KEY = "cq_legacy_pattern";
const KEY_NEW = "cq_new_pattern";
// Digits not followed by "x": a lookahead, which RE2 can't run.
const LOOKAROUND = "(\\d+)(?!x)";

async function clean() {
  for (const key of [KEY, KEY_NEW]) {
    const f = (await listFields()).find((x) => x.key === key);
    if (f) await deleteField(f.id);
  }
}

/** The field as an install from before the change stored it: straight into the table. */
async function storeLegacyField(): Promise<number> {
  const mappings = {
    microsoft: { kind: "extract", path: "employeeId", pattern: LOOKAROUND, group: 1 },
    google: { kind: "first", of: [{ kind: "path", path: "missing" }, { kind: "extract", path: "employeeId", pattern: "(\\w)\\1", group: 0 }] },
  };
  const r = await pool().query<{ id: number }>(
    `INSERT INTO directory_fields (key, label, sort, builtin, mappings)
     VALUES ($1, 'CQ Legacy pattern', 9000, 0, $2) RETURNING id`,
    [KEY, JSON.stringify(mappings)]
  );
  return r.rows[0].id;
}

describe("directory patterns stored before RE2 was required", () => {
  before(async () => {
    await getSetting("__schema_bootstrap__");
    await clean();
  });
  after(clean);

  test("still extract after the upgrade, and are flagged as legacy", async () => {
    await storeLegacyField();
    const f = (await listFields()).find((x) => x.key === KEY)!;
    assert.deepEqual(f.mappings.microsoft, { kind: "extract", path: "employeeId", pattern: LOOKAROUND, group: 1 }, "kept, not dropped as 'Not mapped'");
    assert.equal(f.mappings.google?.kind, "first");
    assert.deepEqual(legacyPatterns(f.mappings), [LOOKAROUND, "(\\w)\\1"]);
    const applied = applyFieldMappings([f], "microsoft", { employeeId: "4711" });
    assert.equal(applied.synced[KEY], "4711");
    assert.equal(applyFieldMappings([f], "google", { employeeId: "aab" }).synced[KEY], "aa", "the backreference inside a first-of chain too");
  });

  test("survive a rename, and the mapping sent back unchanged", async () => {
    const f = (await listFields()).find((x) => x.key === KEY)!;
    const renamed = await updateField(f.id, { label: "CQ Legacy pattern (renamed)" });
    assert.deepEqual(renamed!.mappings, f.mappings);
    // The fields panel saves both providers' mappings when one changes.
    const resent = await updateField(f.id, { mappings: { ...f.mappings, google: { kind: "path", path: "employeeId" } } });
    assert.deepEqual(resent!.mappings.microsoft, f.mappings.microsoft);
    const stored = (await pool().query<{ mappings: any }>("SELECT mappings FROM directory_fields WHERE id = $1", [f.id])).rows[0].mappings;
    assert.equal(stored.microsoft.pattern, LOOKAROUND);
  });

  test("a sync's reapply logs a warning naming the field", async () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(" "));
    try {
      await reapplyMappings();
    } finally {
      console.warn = orig;
    }
    assert.ok(warnings.some((w) => w.includes("directory.legacy_pattern") && w.includes(KEY)), warnings.join("\n"));
  });

  test("a new or edited lookaround pattern is refused with RE2's reason", async () => {
    const f = (await listFields()).find((x) => x.key === KEY)!;
    await assert.rejects(
      updateField(f.id, { mappings: { ...f.mappings, microsoft: { kind: "extract", path: "employeeId", pattern: "(\\d+)(?!y)" } } }),
      /can't be used: lookarounds and backreferences aren't supported/
    );
    await assert.rejects(
      createField({ label: "CQ New pattern", key: KEY_NEW, mappings: { microsoft: { kind: "extract", path: "x", pattern: "(?<=a)b" } } }),
      /lookarounds and backreferences aren't supported/
    );
    await assert.rejects(
      createField({ label: "CQ New pattern", key: KEY_NEW, mappings: { microsoft: { kind: "extract", path: "x", pattern: "[^]" } } }),
      /The pattern "\[\^\]" can't be used: /
    );
    assert.equal((await listFields()).some((x) => x.key === KEY_NEW), false);
    const ok = await createField({ label: "CQ New pattern", key: KEY_NEW, mappings: { microsoft: { kind: "extract", path: "x", pattern: "x(\\d+)$" } } });
    assert.equal(ok.mappings.microsoft?.kind, "extract");
  });
});
