// Style-drift guard, 1.20.27 polish (STYLEGUIDE §Color and theming, §Notices,
// §Tables, §Helpdesk: desk settings). Each rule bans a regression the
// 1.20.27 review of all 68 desk pages (desktop light, desktop dark, phone)
// found and fixed:
//   - accent ink that is unreadable on a dark page (text-compass-800 / -900
//     measured 1.9:1 on the dark tint: only -600 and -700 are lifted);
//   - compass-200 / -300 borders and rings with no dark pair (they do not
//     flip, so they glared at rgb(179 211 236) on the dark page), in the
//     helpdesk, where every one now has a pair or is a .notice-info strip;
//   - desk table headers drawn without TABLE_HEAD_ROW (bold, centred,
//     sentence case beside every other table's eyebrow row);
//   - free-standing amber-600 ink in the helpdesk (ink-warn carries both
//     themes);
//   - the "New in <release>" strip anywhere but the settings overview
//     (it once sat above a page's h1).
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT).filter((f) => !f.includes("/__tests__/"));
const rel = (f: string) => relative(ROOT, f).split("\\").join("/");
const helpdesk = (f: string) => rel(f).startsWith("components/helpdesk/") || rel(f).startsWith("app/(desk)/") || rel(f).startsWith("app/(portal)/");
/** A comment line (// …, * …, {/* … *\/}), which may name a banned class to explain it. */
const comment = (line: string) => /^\s*(?:\/\/|\*|\/\*|\{\/\*)/.test(line);

function offenders(re: RegExp, filter: (file: string, line: string) => boolean = () => true): string[] {
  const out: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (comment(line) || !re.test(line) || !filter(file, line)) return;
      out.push(`${rel(file)}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  return out;
}

describe("style drift guard: 1.20.27 desk polish", () => {
  test("no text-compass-800 / -900 ink without a dark pair (§Color and theming: use text-compass-ink-strong)", () => {
    // A variant (hover:, group-hover:) is lifted in globals.css; the base ink is not.
    const hits = offenders(/(?<![:\w-])text-compass-(?:800|900)\b/, (_f, line) => !/\bdark:text-/.test(line));
    assert.deepEqual(hits, [], `accent ink that disappears in dark mode — use text-compass-ink-strong:\n${hits.join("\n")}`);
  });

  test("helpdesk: compass-200 / -300 borders and rings carry a dark pair (§Notices: .notice-info)", () => {
    // compass-50 and -100 flip with the theme; -200 and -300 do not. A hover
    // border is transient and left alone.
    const hits = offenders(
      /(?<![:\w-])(?:border|ring|divide)-compass-(?:200|300)\b/,
      (file, line) => helpdesk(file) && !/\bdark:(?:border|ring|divide)-/.test(line)
    );
    assert.deepEqual(
      hits,
      [],
      `a light-blue edge that glares on a dark page — use notice-info, or pair it (dark:border-compass-500/40; a selected chip dark:border-compass-500):\n${hits.join("\n")}`
    );
  });

  test("desk tables: the header row is TABLE_HEAD_ROW (§Tables)", () => {
    // A screen-reader-only data table (charts' SrTable) and the printed calendar
    // (its own paper styles) are not on-screen tables.
    const ALLOW = ["components/helpdesk/desk/reports/charts.tsx", "components/helpdesk/desk/calendar/CalendarPrint.tsx"];
    const re = /<thead\b(?![^>]*(?:TABLE_HEAD_ROW|sr-only))[^>]*>\s*<tr\b(?![^>]*TABLE_HEAD_ROW)[^>]*>/g;
    const hits: string[] = [];
    for (const file of files) {
      if (!rel(file).startsWith("components/helpdesk/desk/") || !file.endsWith(".tsx") || ALLOW.includes(rel(file))) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(re)) hits.push(`${rel(file)}:${src.slice(0, m.index).split("\n").length}`);
    }
    assert.deepEqual(hits, [], `a bare <thead><tr> — put TABLE_HEAD_ROW on the <thead> or its <tr>:\n${hits.join("\n")}`);
  });

  test("helpdesk: no free-standing amber-600 ink (§Color and theming: ink-warn)", () => {
    const hits = offenders(/(?<![:\w-])text-amber-600\b/, (file) => helpdesk(file));
    assert.deepEqual(hits, [], `amber-600 is 3.2:1 on white and unpaired in dark mode — use ink-warn:\n${hits.join("\n")}`);
  });

  test("the What's new strip renders on the desk settings overview only, under its header", () => {
    const hits = offenders(/<DeskNewStrip\b/, (file) => !rel(file).endsWith("components/helpdesk/desk/settings/DeskSettingsHome.tsx"));
    assert.deepEqual(hits, [], `the "New in <release>" strip belongs on the settings overview only:\n${hits.join("\n")}`);
  });

  test(".notice-info carries both themes (globals.css)", () => {
    const css = readFileSync(join(ROOT, "app", "globals.css"), "utf8");
    const rule = /\.notice-info\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    assert.match(rule, /border-compass-200/, ".notice-info keeps the info tint's border");
    assert.match(rule, /dark:border-compass-500\/40/, ".notice-info pairs the border for dark mode");
  });
});
