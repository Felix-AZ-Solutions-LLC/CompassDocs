// Guard (1.21.4): every test stub of lib/ee carries the settings-map
// variants featureEnabledFrom and featureEnforcedFrom, not only the async
// pair. Test files run in parallel against one database; while
// test/duo-mfa.test.ts has a Duo rule on, every session check in every other
// file reaches lib/duo-config's featureEnforcedFrom("sso", …), and a stub
// without it failed test/email-parts-api.test.ts with "featureEnforcedFrom is
// not a function" (PR #339). See test/support/ee-stub.ts.
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = __dirname;
const SELF = __filename;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}

test("every lib/ee stub has featureEnabledFrom and featureEnforcedFrom", () => {
  const stubs = walk(ROOT).filter((f) => f !== SELF && /\beePresent\s*:/.test(readFileSync(f, "utf8")));
  assert.ok(stubs.length > 0, "found no lib/ee stubs: has the stub shape changed?");
  const missing = stubs
    .filter((f) => {
      const src = readFileSync(f, "utf8");
      return !/\bfeatureEnabledFrom\s*:/.test(src) || !/\bfeatureEnforcedFrom\s*:/.test(src);
    })
    .map((f) => relative(ROOT, f).split("\\").join("/"));
  assert.deepEqual(missing, [], `lib/ee stubs without the *From variants: ${missing.join(", ")}`);
});
