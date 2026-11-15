// The settings search's matching and ranking, shared by the CompassDocs
// settings rail (lib/settings-sections) and the desk's (1.20.13,
// lib/helpdesk/desk-settings-registry), so both find things the same way.
//
// A row matches when every word of the query appears somewhere in its
// haystack (label, section and keywords), so "due dates" and "dates due"
// both find reply targets and "mail" still finds Email. Whole words beat
// the start of a word, and the row's own label beats its keywords, so
// "SLA" lists Reply targets (a keyword, whole) before Slack (a label that
// only starts with it). Pure, client-safe.

/** The query's words, lower-cased. */
export function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function wordStarts(text: string, word: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${esc(word)}`).test(text);
}
function wholeWord(text: string, word: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${esc(word)}($|[^a-z0-9])`).test(text);
}

/**
 * How well a row matches (lower is better), or null when it does not.
 * `label` is what the row shows; `haystack` everything it can be found by
 * (already lower-cased, the label included).
 */
export function settingsMatchScore(query: string, label: string, haystack: string): number | null {
  const words = queryWords(query);
  if (words.length === 0) return null;
  if (!words.every((w) => haystack.includes(w))) return null;
  const l = label.toLowerCase();
  const q = words.join(" ");
  if (l === q) return 0;
  if (words.every((w) => wholeWord(l, w))) return 1;
  if (words.every((w) => wholeWord(haystack, w))) return 2;
  if (words.every((w) => wordStarts(l, w))) return 3;
  if (words.every((w) => wordStarts(haystack, w))) return 4;
  if (words.every((w) => l.includes(w))) return 5;
  return 6;
}

/** Rows that match, best first; ties keep the index's own order. */
export function rankSettings<T>(rows: readonly T[], query: string, label: (r: T) => string, haystack: (r: T) => string): T[] {
  const scored: { row: T; score: number; i: number }[] = [];
  rows.forEach((row, i) => {
    const score = settingsMatchScore(query, label(row), haystack(row));
    if (score !== null) scored.push({ row, score, i });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((s) => s.row);
}
