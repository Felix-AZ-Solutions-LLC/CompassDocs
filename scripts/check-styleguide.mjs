#!/usr/bin/env node
// Style-guide gate (STYLEGUIDE.md). Plain Node, no dependencies, so CI can
// run it straight after checkout and a releaser can run it with nothing
// installed. Each rule names the guide section it enforces and reports
// file:line per violation.
//
//   node scripts/check-styleguide.mjs                  check; exit 1 on a new violation
//   node scripts/check-styleguide.mjs --prune-baseline drop baseline entries that are fixed
//   node scripts/check-styleguide.mjs --list-rules     what is checked here and where else
//   node scripts/check-styleguide.mjs --write-baseline only in the PR that adds a rule, over
//                                                      the code that predates it
//
// This complements the guard tests in test/style-*.test.ts (run by
// `npm run test:integration` and the e2e job), which already enforce native
// `title=` on controls, the h1/PageHeader ladder, the input recipe's focus
// classes, slate-400 text, dark: on slate, bg-white, chips, spinners, typed
// glyphs, px literals and US English. Rules live in one place each: a rule
// that is in a test is not repeated here.
//
// Known violations that predate a rule live in
// scripts/styleguide-baseline.json, keyed by rule, file and the offending
// source (not the line number, so unrelated edits don't shift them). The
// check fails on any violation not in the baseline, and on a baseline entry
// that no longer matches anything (the fix landed: prune it so the count
// only goes down). Never add to the baseline to get a new violation
// through; fix it, or extend STYLEGUIDE.md with the exception and its
// reason, and the allow list of the rule here, in the same PR.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO, "src");
const BASELINE = join(REPO, "scripts", "styleguide-baseline.json");

// ---------------------------------------------------------------- files

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "__tests__") continue;
      walk(p, out);
    } else if (/\.(tsx|ts|css)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const FILES = walk(SRC).map((abs) => ({ abs, rel: relative(REPO, abs), src: readFileSync(abs, "utf8") }));
const tsx = () => FILES.filter((f) => f.rel.endsWith(".tsx"));
const css = () => FILES.filter((f) => f.rel.endsWith(".css"));

const lineOf = (src, index) => src.slice(0, index).split("\n").length;
const lineText = (src, index) => {
  const start = src.lastIndexOf("\n", index - 1) + 1;
  const end = src.indexOf("\n", index);
  return src.slice(start, end === -1 ? src.length : end);
};
/** A match on a line that is a comment (// …, * …, /* …, {/* …) or after a // on its line. */
function inComment(src, index) {
  const line = lineText(src, index);
  const col = index - (src.lastIndexOf("\n", index - 1) + 1);
  if (/^\s*(?:\/\/|\*|\/\*|\{\/\*)/.test(line)) return true;
  const before = line.slice(0, col);
  return /(?:^|[\s;{}(),])\/\/(?!\S*["'`])/.test(before);
}
const squash = (s) => s.replace(/\s+/g, " ").trim().slice(0, 140).trim();

// ------------------------------------------------------------ JSX scanning

/**
 * Every opening tag `<Tag …>` for the given names: its attribute text, the
 * children's source (up to the matching close tag) and whether it closes
 * itself. Attribute values may hold `>` inside {…} (arrow functions,
 * comparisons) and in strings, so the tag is read with a small scanner,
 * not a regex.
 */
function jsxElements(src, names) {
  const out = [];
  const open = new RegExp(`<(${names.join("|")})(?=[\\s/>])`, "g");
  for (const m of src.matchAll(open)) {
    if (inComment(src, m.index)) continue;
    // `a < b` and generics are not JSX: the char before `<` in JSX is not an identifier char.
    const prev = src[m.index - 1];
    if (prev && /[\w$)\]]/.test(prev)) continue;
    const tag = m[1];
    let i = m.index + m[0].length;
    let depth = 0;
    let quote = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        // Quotes inside {…} are JS strings; at depth 0 they delimit an attribute value.
        quote = c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    if (i >= src.length) continue;
    const selfClosing = src[i - 1] === "/";
    const attrs = src.slice(m.index + m[0].length, selfClosing ? i - 1 : i);
    let children = null;
    if (!selfClosing) {
      // Matching close tag, counting nested opens of the same name.
      const re = new RegExp(`<(/?)${tag}(?=[\\s/>])`, "g");
      re.lastIndex = i + 1;
      let level = 1;
      let r;
      while ((r = re.exec(src))) {
        if (r[1]) {
          if (--level === 0) break;
        } else {
          // A nested self-closing <Tag …/> doesn't open a level.
          const end = src.indexOf(">", r.index);
          if (src[end - 1] !== "/") level++;
        }
      }
      if (r) children = src.slice(i + 1, r.index);
    }
    out.push({ tag, attrs, children, selfClosing, index: m.index });
  }
  return out;
}

/** Names imported from lucide-react in a file (`X`, or the local name of `X as Y`). */
function lucideNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']lucide-react["']/g)) {
    for (const part of m[1].split(",")) {
      const p = part.trim();
      if (!p || p.startsWith("type ")) continue;
      const as = p.split(/\s+as\s+/);
      names.add((as[1] ?? as[0]).trim());
    }
  }
  return names;
}

const hasAttr = (attrs, name) => new RegExp(`(?:^|\\s)${name}(?=[\\s=/]|$)`).test(attrs);

/**
 * The attribute text plus the definitions of the identifiers its className
 * names, so `const field = controlClass(false)` … `className={field}` counts
 * as the recipe.
 */
function withClassDefs(src, attrs) {
  const cls = attrs.match(/\bclassName=\{([\s\S]*?)\}(?=\s+[\w-]+=|\s*$|\s+\{)/)?.[1] ?? attrs.match(/\bclassName=\{([^}]*)\}/)?.[1];
  if (!cls) return attrs;
  let out = attrs;
  for (const [id] of cls.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    const def = src.match(new RegExp(`(?:const|let|var)\\s+${id.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}\\s*=\\s*([^;\\n]+)`));
    if (def) out += " " + def[1];
  }
  return out;
}

// ------------------------------------------------------------------ rules

const RULES = [];
const rule = (id, section, why, check) => RULES.push({ id, section, why, check });

rule(
  "css-triplet-var",
  "§Color and theming",
  "The theme's color variables hold raw `R G B` triplets: a bare var(--compass-600) is not a color and fails silently. Wrap it: rgb(var(--compass-600)) or rgb(var(--compass-600) / 0.5).",
  () => {
    // Which variables are triplets is read from the CSS itself, so a new
    // token is covered the day it is added.
    const triplets = new Set();
    for (const f of css()) for (const m of f.src.matchAll(/(--[\w-]+)\s*:\s*\d{1,3}\s+\d{1,3}\s+\d{1,3}\s*[;}]/g)) triplets.add(m[1]);
    const hits = [];
    for (const f of FILES) {
      for (const m of f.src.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (!triplets.has(m[1]) || inComment(f.src, m.index)) continue;
        const before = f.src.slice(Math.max(0, m.index - 40), m.index);
        if (/(?:^|[^a-z-])rgba?\(\s*$/i.test(before)) continue;
        // `--compass-ink: var(--compass-600);` aliases one triplet to another.
        if (/--[\w-]+\s*:\s*$/.test(before)) {
          const after = f.src.slice(m.index).match(/^var\(\s*--[\w-]+\s*\)\s*([;}])/);
          if (after) continue;
        }
        hits.push({ file: f.rel, line: lineOf(f.src, m.index), text: lineText(f.src, m.index) });
      }
    }
    return hits;
  }
);

rule(
  "lucide-only",
  "§Icons",
  "Icons come from lucide-react only: no other icon package, and no hand-drawn <svg> icon. Data graphics and the documented marks are the allow list below.",
  () => {
    const OTHER_SETS =
      /from\s+["'](?:react-icons|@heroicons\/|@fortawesome\/|@tabler\/icons|@phosphor-icons\/|phosphor-react|@radix-ui\/react-icons|@mui\/icons-material|react-feather|feather-icons|@iconify\/|bootstrap-icons|ionicons|@primer\/octicons|lucide["'\/])/g;
    // Inline <svg> is allowed only where it is not an icon (§Icons, §Sign-in surfaces).
    const SVG_ALLOW = [
      "src/components/auth/ProviderMark.tsx", // the provider-mark exception (vendor marks)
      "src/components/auth/CompassBezel.tsx", // the sign-in cover's dial, an illustration
      "src/components/AnalyticsClient.tsx", // a chart
      "src/components/helpdesk/desk/reports/charts.tsx", // desk report charts (§Desk reports and charts)
    ];
    const hits = [];
    for (const f of FILES.filter((x) => /\.tsx?$/.test(x.rel))) {
      for (const m of f.src.matchAll(OTHER_SETS)) {
        if (inComment(f.src, m.index)) continue;
        hits.push({ file: f.rel, line: lineOf(f.src, m.index), text: lineText(f.src, m.index) });
      }
      for (const m of f.src.matchAll(/import\s+\w+\s+from\s+["'][^"']+\.svg["']/g)) {
        hits.push({ file: f.rel, line: lineOf(f.src, m.index), text: lineText(f.src, m.index) });
      }
      if (!f.rel.endsWith(".tsx") || SVG_ALLOW.includes(f.rel)) continue;
      for (const m of f.src.matchAll(/<svg\b/g)) {
        if (inComment(f.src, m.index)) continue;
        hits.push({ file: f.rel, line: lineOf(f.src, m.index), text: lineText(f.src, m.index) });
      }
    }
    return hits;
  }
);

rule(
  "icon-only-name",
  "§Tooltips, §Buttons, §Accessibility",
  "An icon-only control needs an accessible name: aria-label (matching its data-tt) or aria-labelledby. data-tt is presentation, not a name.",
  () => {
    const hits = [];
    for (const f of tsx()) {
      const icons = lucideNames(f.src);
      for (const el of jsxElements(f.src, ["button", "a", "Link", "Button"])) {
        if (hasAttr(el.attrs, "aria-label") || hasAttr(el.attrs, "aria-labelledby") || /\{\s*\.\.\./.test(el.attrs)) continue;
        let iconOnly = false;
        if (el.tag === "Button" && el.selfClosing && hasAttr(el.attrs, "icon")) iconOnly = true;
        else if (/\biconButtonClass\(/.test(el.attrs)) iconOnly = el.children == null || !/[A-Za-z]/.test(stripIcons(el.children, icons));
        else if (el.children != null && icons.size) {
          // Children that are nothing but lucide icons (and whitespace / JSX comments).
          const rest = el.children.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
          const tags = [...rest.matchAll(/<([A-Z]\w*)\b[^<>]*\/>/g)];
          iconOnly = tags.length > 0 && tags.every((t) => icons.has(t[1])) && rest.replace(/<([A-Z]\w*)\b[^<>]*\/>/g, "").trim() === "";
        }
        if (iconOnly) hits.push({ file: f.rel, line: lineOf(f.src, el.index), text: `<${el.tag}${el.attrs}>` });
      }
    }
    return hits;
  }
);
/** Children with lucide icons and comments removed: whatever text is left names the control. */
function stripIcons(children, icons) {
  return children
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/<([A-Z]\w*)\b[^<>]*\/>/g, (whole, name) => (icons.has(name) ? "" : whole))
    .replace(/className=(?:"[^"]*"|\{[^}]*\})/g, "");
}

rule(
  "form-control-recipe",
  "§Forms",
  "A text field, select or textarea is <TextInput>/<Select>/<Textarea> from components/form, or a raw element styled with controlClass() — never a browser-default or hand-styled control.",
  () => {
    // Inputs whose look is the browser's on purpose: the accent-color
    // natives (§Color and theming), hidden fields, file pickers behind a
    // button, and the buttons an <input type=submit> draws.
    const NATIVE = /\btype=["'{](?:["'`])?(?:checkbox|radio|hidden|file|range|color|submit|button|reset|image)\b/;
    const hits = [];
    for (const f of tsx()) {
      if (f.rel === "src/components/form.tsx") continue;
      for (const el of jsxElements(f.src, ["input", "select", "textarea"])) {
        if (el.tag === "input" && (NATIVE.test(el.attrs) || /\b(?:hidden|checked|defaultChecked)\b/.test(el.attrs))) continue;
        const all = withClassDefs(f.src, el.attrs);
        // §Focus / §Helpdesk: major incidents: a control inside a frame (.frame-input) and the
        // command palette's input (.cmd-input) are drawn by the frame around them.
        if (/\bcontrolClass\(|\b(?:frame|cmd)-input\b/.test(all) || /\{\s*\.\.\./.test(el.attrs)) continue;
        hits.push({ file: f.rel, line: lineOf(f.src, el.index), text: `<${el.tag}${el.attrs}>` });
      }
    }
    return hits;
  }
);

rule(
  "select-chevron",
  "§Forms",
  "A raw <select> styled with controlClass() adds SELECT_EXTRA (lucide's chevron), unless it is a list box (multiple, or size over 1).",
  () => {
    const hits = [];
    for (const f of tsx()) {
      if (f.rel === "src/components/form.tsx") continue;
      for (const el of jsxElements(f.src, ["select"])) {
        const all = withClassDefs(f.src, el.attrs);
        if (!/\bcontrolClass\(/.test(all)) continue;
        if (/\bSELECT_EXTRA\b|\bselect-chevron\b/.test(all)) continue;
        if (hasAttr(el.attrs, "multiple") || /\bsize=\{?\s*["']?(?:[2-9]|\d\d)/.test(el.attrs)) continue;
        hits.push({ file: f.rel, line: lineOf(f.src, el.index), text: `<select${el.attrs}>` });
      }
    }
    return hits;
  }
);

rule(
  "landmark-label",
  "§Accessibility",
  "Every <nav> and <aside> carries a unique aria-label (or aria-labelledby): a page with two unnamed landmarks reads as two identical regions.",
  () => {
    const hits = [];
    for (const f of tsx()) {
      for (const el of jsxElements(f.src, ["nav", "aside"])) {
        if (hasAttr(el.attrs, "aria-label") || hasAttr(el.attrs, "aria-labelledby") || /\{\s*\.\.\./.test(el.attrs)) continue;
        hits.push({ file: f.rel, line: lineOf(f.src, el.index), text: `<${el.tag}${el.attrs}>` });
      }
    }
    return hits;
  }
);

rule(
  "hover-danger",
  "§Buttons, §Color and theming",
  "A destructive hover is `hover-danger`, never a bare hover:bg-red-50/100 (a pale slab in dark mode).",
  () => {
    const hits = [];
    for (const f of FILES.filter((x) => /\.tsx?$/.test(x.rel))) {
      for (const m of f.src.matchAll(/(?<![\w:-])hover:bg-red-(?:50|100)\b/g)) {
        if (inComment(f.src, m.index)) continue;
        if (/\bdark:hover:bg-/.test(lineText(f.src, m.index))) continue;
        hits.push({ file: f.rel, line: lineOf(f.src, m.index), text: lineText(f.src, m.index) });
      }
    }
    return hits;
  }
);

rule(
  "document-title",
  "§Page skeleton (Document title)",
  "Never set document.title from a component: pages export metadata / generateMetadata and the root layout's template appends the workspace name.",
  () => {
    const hits = [];
    for (const f of FILES.filter((x) => /\.tsx?$/.test(x.rel))) {
      for (const m of f.src.matchAll(/\bdocument\.title\s*=(?!=)/g)) {
        if (inComment(f.src, m.index)) continue;
        hits.push({ file: f.rel, line: lineOf(f.src, m.index), text: lineText(f.src, m.index) });
      }
    }
    return hits;
  }
);

rule(
  "empty-state-icon",
  "§Empty states",
  "<EmptyState icon> takes a lucide element (icon={<Inbox />}), never an emoji or a string.",
  () => {
    const hits = [];
    for (const f of tsx()) {
      for (const el of jsxElements(f.src, ["EmptyState"])) {
        const m = el.attrs.match(/\bicon=(\{\s*["'`]|["'])/);
        if (!m) continue;
        hits.push({ file: f.rel, line: lineOf(f.src, el.index), text: `<EmptyState${el.attrs}>` });
      }
    }
    return hits;
  }
);

rule(
  "page-skeleton",
  "§Page skeleton",
  "Every page in the app shell renders inside PageContainer (directly, or through SettingsPage / AccountPage / a section layout that does): it carries the Normal/Wide/Full width and the phone gutter.",
  () => {
    // A page passes when it names one of the shells, or only redirects. A
    // route group whose layout renders the shell covers its pages.
    const SHELLS = /\b(?:PageContainer|PageWidth|SettingsPage|AccountPage)\b/;
    const ONLY_REDIRECT = /\b(?:redirect|permanentRedirect|notFound)\(/;
    const hits = [];
    const pages = FILES.filter((f) => /^src\/app\/\(app\)\/.*\/page\.tsx$/.test(f.rel) || f.rel === "src/app/(app)/page.tsx");
    const layoutsWithShell = FILES.filter((f) => /\/layout\.tsx$/.test(f.rel) && SHELLS.test(f.src)).map((f) => dirname(f.rel));
    for (const f of pages) {
      if (SHELLS.test(f.src)) continue;
      if (layoutsWithShell.some((d) => f.rel.startsWith(d + "/"))) continue;
      // Pages that delegate to one component: follow one import hop.
      if (delegatesToShell(f)) continue;
      if (ONLY_REDIRECT.test(f.src) && !/return\s*\(?\s*</.test(f.src)) continue;
      hits.push({ file: f.rel, line: 1, text: "(no PageContainer / SettingsPage / AccountPage)" });
    }
    return hits;
  }
);
function delegatesToShell(page) {
  for (const m of page.src.matchAll(/import\s+(?:\{[^}]*\}|\w+)(?:\s*,\s*\{[^}]*\})?\s+from\s+["']([^"']+)["']/g)) {
    let spec = m[1];
    let base;
    if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
    else if (spec.startsWith(".")) base = join(dirname(page.abs), spec);
    else continue;
    for (const ext of [".tsx", "/index.tsx", ".ts"]) {
      const hit = FILES.find((f) => f.abs === base + ext);
      if (hit && /\b(?:PageContainer|PageWidth|SettingsPage|AccountPage)\b/.test(hit.src) && !/\/(?:PageContainer|SettingsPage|AccountPage)\.tsx$/.test(hit.rel)) return true;
    }
  }
  return false;
}

// --------------------------------------------------------------- baseline

const key = (h) => `${h.rule}\t${h.file}\t${squash(h.text)}`;

function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch {
    return { entries: [] };
  }
}

function writeBaseline(entries) {
  const body = {
    $comment:
      "Known style-guide violations that predate a rule in scripts/check-styleguide.mjs. Only ever shrinks: fix an entry and run `node scripts/check-styleguide.mjs --prune-baseline`. Never add one to get a new violation through.",
    entries: entries.sort((a, b) => (a.rule + a.file + a.text).localeCompare(b.rule + b.file + b.text)),
  };
  writeFileSync(BASELINE, JSON.stringify(body, null, 2) + "\n");
}

// ------------------------------------------------------------------- main

const args = new Set(process.argv.slice(2));

if (args.has("--list-rules")) {
  for (const r of RULES) console.log(`${r.id.padEnd(20)} ${r.section}\n${" ".repeat(21)}${r.why}\n`);
  console.log("Also enforced, by test/style-*.test.ts (npm run test:integration, the e2e job):");
  console.log("  native title= on controls, PageHeader as the only h1, the input recipe's focus classes,");
  console.log("  slate-400 text, dark: on slate, bg-white, chips, buttons, spinners, typed glyphs,");
  console.log("  uppercase labels, floating panels, empty lines, px literals, US English.");
  process.exit(0);
}

const all = [];
for (const r of RULES) for (const h of r.check()) all.push({ rule: r.id, ...h });

const baseline = readBaseline();
const allowed = new Map();
for (const e of baseline.entries ?? []) {
  const k = `${e.rule}\t${e.file}\t${squash(e.text)}`;
  allowed.set(k, (allowed.get(k) ?? 0) + (e.count ?? 1));
}

if (args.has("--write-baseline")) {
  // Only for introducing a new rule over existing code. Reviewers: a PR
  // that grows this file without adding a rule is the thing to refuse.
  const counts = new Map();
  for (const h of all) counts.set(key(h), { rule: h.rule, file: h.file, text: squash(h.text), count: (counts.get(key(h))?.count ?? 0) + 1 });
  writeBaseline([...counts.values()].map((e) => (e.count === 1 ? { rule: e.rule, file: e.file, text: e.text } : e)));
  console.log(`Baseline written: ${all.length} known violation(s).`);
  process.exit(0);
}

const seen = new Map();
const fresh = [];
for (const h of all) {
  const k = key(h);
  const n = (seen.get(k) ?? 0) + 1;
  seen.set(k, n);
  if (n > (allowed.get(k) ?? 0)) fresh.push(h);
}
const stale = [];
for (const [k, n] of allowed) {
  const have = seen.get(k) ?? 0;
  if (have < n) {
    const [rule, file, text] = k.split("\t");
    stale.push({ rule, file, text, fixed: n - have });
  }
}

if (args.has("--prune-baseline")) {
  const kept = [];
  for (const e of baseline.entries ?? []) {
    const k = `${e.rule}\t${e.file}\t${squash(e.text)}`;
    const have = Math.min(seen.get(k) ?? 0, e.count ?? 1);
    if (have === 0) continue;
    kept.push(have === 1 ? { rule: e.rule, file: e.file, text: e.text } : { ...e, count: have });
  }
  writeBaseline(kept);
  console.log(`Baseline pruned: ${stale.reduce((s, e) => s + e.fixed, 0)} fixed violation(s) removed.`);
  process.exit(0);
}

const byRule = new Map(RULES.map((r) => [r.id, r]));
if (fresh.length) {
  console.error(`STYLEGUIDE.md: ${fresh.length} new violation(s)\n`);
  let last = null;
  for (const h of fresh.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line)) {
    if (h.rule !== last) {
      const r = byRule.get(h.rule);
      console.error(`${h.rule} (${r.section}): ${r.why}`);
      last = h.rule;
    }
    console.error(`  ${h.file}:${h.line}: ${squash(h.text)}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error file=${h.file},line=${h.line},title=STYLEGUIDE ${h.rule}::${byRule.get(h.rule).why}`);
  }
  console.error("");
}
if (stale.length) {
  console.error(`scripts/styleguide-baseline.json lists ${stale.length} violation(s) that are gone — run \`node scripts/check-styleguide.mjs --prune-baseline\` and commit it:`);
  for (const s of stale) console.error(`  ${s.rule}  ${s.file}: ${s.text}`);
  console.error("");
}

const known = all.length - fresh.length;
const summary = RULES.map((r) => `${r.id} ${all.filter((h) => h.rule === r.id).length}`).join(", ");
if (fresh.length || stale.length) {
  console.error(`Style-guide check failed. (${RULES.length} rules; ${known} known violation(s) in the baseline.)`);
  process.exit(1);
}
console.log(`Style-guide check passed: ${RULES.length} rules, no new violations; ${known} known in the baseline (${summary}).`);
