// Style-drift guard: US English (STYLEGUIDE §Vocabulary, US English, 1.20.37).
// The product's words are US English: "Help Center", "color", "canceled",
// "organization", "license" (noun and verb), "-ize". This reads every string
// a person can see in src (string literals, template text and JSX text, with
// the TypeScript parser, so comments never count) and fails on the common
// British spellings.
//
// What it leaves alone, because a rename there would break something:
//   - module paths, object keys, type unions, `case` labels and the side of
//     a comparison (a stored value such as the import status "cancelled" or
//     the retention action "anonymise");
//   - one-word lower-case or upper-case tokens (stored values, iCalendar's
//     STATUS:CANCELLED, the API error code "unauthorised");
//   - SQL (table and column names such as `acknowledgements`);
//   - addresses and slugs: a word joined to "-", "/", "." or "_"
//     ("help-centre", "anonymise-compliance");
//   - settings-search keywords, which keep the British spelling beside the
//     US one so either finds the page;
//   - the ALLOW list below: stored values and third-party text, each with
//     its reason.
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(__dirname, "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** The British spellings the product used before 1.20.37, and their families. */
const ISE_STEMS =
  "recogn|priorit|author|summar|sanit|custom|optim|normal|minim|maxim|initial|anonym|apolog|real|emphas|synchron|material|util|final|personal|categor|visual|standard|serial|capital|memor|local|item|critic|special|central|organ|reorgan";
// A prefix the British word may carry ("unrecognised", "uncategorised",
// "unauthorised", "recoloured", "re-enrol"): part of the word it flags.
const PREFIX = "(?:un|re|pre|non|mis|dis|de|over|under)-?";
export const BRITISH_RE = new RegExp(
  `(?<![A-Za-z0-9_\\-./@#$])(${PREFIX})?(` +
    [
      "centre[sd]?",
      "centring",
      "licen(?:ce|ces|ced)",
      "colour(?:s|ed|ing|ful)?",
      "behaviour(?:s|al)?",
      "favourites?",
      "honour(?:s|ed|ing)?",
      "neighbour(?:s|ing|hood)?",
      "cancell(?:ed|ing)",
      "labell(?:ed|ing)",
      "modell(?:ed|ing)",
      "travell(?:ed|ing|ers?)",
      "catalogues?",
      "analys(?:e|ed|ing)",
      "enrol(?:s|ment|ments)?",
      "programmes?",
      "grey(?:s|ed|ing)?",
      "judgements?",
      "acknowledgements?",
      "spelt|learnt|whilst|amongst",
      "defence|offence",
      `(?:${ISE_STEMS})is(?:e|es|ed|ing|ation|ations|er|ers)`,
    ].join("|") +
    ")(?![A-Za-z0-9_])",
  "i"
);
/** The whole word a match flags, prefix included. */
const flaggedWord = (m: RegExpExecArray) => `${m[1] ?? ""}${m[2]}`;

/** Stored values and third-party text that keep their spelling on purpose ("file suffix", exact text). */
const ALLOW: [string, string][] = [
  // The outbox row's error for a retired policy: the drain matches on it.
  ["lib/db.ts", "cancelled: policy retired"],
  // Phrases Outlook and Google write in meeting invites (third-party text the inbound matcher looks for).
  ["lib/helpdesk/desk-calendar-ics.ts", "has been cancelled"],
];
/** Files that are not English at all. */
const SKIP_FILES = ["lib/helpdesk/skills/detect.ts"];

const SQL = /\b(?:SELECT\s|INSERT INTO|UPDATE \w+(?: \w+)? SET|DELETE FROM|CREATE (?:TABLE|INDEX|UNIQUE)|ALTER TABLE|LEFT JOIN|JOIN\s|WHERE\s|CASE WHEN|COALESCE|-- )/;
const KEYWORD_OWNERS = new Set(["keywords"]);

function context(node: ts.Node): string {
  const p = node.parent;
  if (!p) return "";
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p) || ts.isModuleDeclaration(p)) return "skip";
  if (ts.isCallExpression(p) && (p.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(p.expression) && p.expression.text === "require"))) return "skip";
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isEnumMember(p)) && p.name === node) return "skip";
  if (ts.isLiteralTypeNode(p) || ts.isCaseClause(p)) return "skip";
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return "skip";
  if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return "skip";
  return "";
}

function owner(node: ts.Node): string {
  let n: ts.Node = node;
  for (let i = 0; i < 4 && n.parent; i++) {
    const p: ts.Node = n.parent;
    if (ts.isPropertyAssignment(p) && p.initializer === n) return p.name.getText();
    if (ts.isArrayLiteralExpression(p) || ts.isTemplateSpan(p) || ts.isTemplateExpression(p) || ts.isParenthesizedExpression(p)) {
      n = p;
      continue;
    }
    break;
  }
  return "";
}

export interface UsEnglishHit {
  file: string;
  line: number;
  word: string;
  text: string;
}

/** Every British spelling in what a person reads in `source` (one file). */
export function britishInSource(file: string, source: string): UsEnglishHit[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: UsEnglishHit[] = [];
  const check = (node: ts.Node, text: string, ctxNode: ts.Node, whole: string) => {
    const m = BRITISH_RE.exec(text);
    if (!m) return;
    if (context(ctxNode) === "skip" || KEYWORD_OWNERS.has(owner(ctxNode))) return;
    if (SQL.test(whole)) return;
    const s = text.trim();
    // A single lower-case or upper-case token is a stored value, never a sentence.
    if (!/\s/.test(s) && !/^[A-Z][a-z]+[.…:]?$/.test(s)) return;
    if (ALLOW.some(([f, t]) => file.endsWith(f) && s === t)) return;
    out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, word: flaggedWord(m), text: s.slice(0, 100) });
  };
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node, node.text, node, node.text);
    else if (ts.isTemplateExpression(node)) {
      const whole = node.getText(sf);
      for (const piece of [node.head, ...node.templateSpans.map((s) => s.literal)]) check(piece, piece.text, node, whole);
    } else if (ts.isJsxText(node)) check(node, node.getText(sf), node, "");
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("style drift guard: US English", () => {
  test("no British spellings in what a person reads (§Vocabulary, US English)", () => {
    const hits: string[] = [];
    for (const file of walk(ROOT)) {
      const rel = relative(ROOT, file);
      if (SKIP_FILES.includes(rel)) continue;
      for (const h of britishInSource(rel, readFileSync(file, "utf8"))) hits.push(`${h.file}:${h.line}: "${h.word}" in ${JSON.stringify(h.text)}`);
    }
    assert.deepEqual(hits, [], `British spelling in user-facing text — write it in US English (keys and stored values excepted):\n${hits.join("\n")}`);
  });

  test("the rule catches the common British spellings and leaves keys alone", () => {
    const flagged = (src: string) => britishInSource("x.tsx", src).map((h) => h.word.toLowerCase());
    // Prose, labels, tooltips and JSX text.
    assert.deepEqual(flagged(`const a = "Search the help centre";`), ["centre"]);
    assert.deepEqual(flagged(`<b data-tt="Pick a colour">Your licence</b>`), ["colour", "licence"]);
    assert.deepEqual(flagged(`const t = \`Workflow cancelled by \${who}\`;`), ["cancelled"]);
    assert.deepEqual(flagged(`toast("ok", "Record anonymised.");`), ["anonymised"]);
    assert.deepEqual(flagged(`const l = { cancelled: "Cancelled" };`), ["cancelled"]);
    for (const w of ["organisation", "behaviour", "favourite", "labelled", "catalogue", "analyse", "enrolment", "programme", "greyed", "judgement", "prioritise", "summarise", "recognised"]) {
      assert.deepEqual(flagged(`const s = "the ${w} here";`), [w], w);
    }
    // A prefix does not hide the British word (review L5).
    for (const w of ["unrecognised", "uncategorised", "unauthorised", "recoloured", "re-enrol", "reorganisation", "uncancelled", "disorganised"]) {
      assert.deepEqual(flagged(`const s = "the ${w} thing";`), [w], w);
    }
    assert.deepEqual(flagged(`const s = "unrecognized, uncategorized, unauthorized, recolored, re-enroll";`), [], "their US forms pass");
    // US spellings pass.
    assert.deepEqual(flagged(`const a = "Help Center · color · canceled · license · organization · licensed · analyze";`), []);
    // Keys, stored values, slugs, SQL, comparisons and comments are never words a person reads.
    assert.deepEqual(flagged(`import x from "@/lib/helpdesk/help-centre";`), []);
    assert.deepEqual(flagged(`if (s === "cancelled") run("anonymise");`), []);
    assert.deepEqual(flagged(`type S = "cancelled" | "open"; const o = { "colour": 1 };`), []);
    assert.deepEqual(flagged(`const href = "/desk/settings/portal/help-centre";`), []);
    assert.deepEqual(flagged(`q("UPDATE hd_import_jobs SET status = 'cancelled' WHERE id = $1");`), []);
    assert.deepEqual(flagged(`// the help centre, colour and licence\nconst a = 1;`), []);
    assert.deepEqual(flagged(`const k = { keywords: "help centre center colour" };`), []);
    assert.deepEqual(flagged(`<span aria-labelledby="x">Hi</span>`), []);
  });
});
