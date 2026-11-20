// Helpdesk 1.19.4 (C3): the customer portal help centre's shared rules.
// Pure: the admin page, the portal pages and the server
// (lib/helpdesk/help-centre) read one set of definitions. Safe in client
// components.
//
// What is public is NOT decided here: lib/helpdesk/help-centre
// publicHelpArticles is the one function that answers it. This module only
// shapes the settings the admin chooses and the words and limits the pages
// share.

/** The tag that makes a document public under "Documents tagged public". */
export const HC_PUBLIC_TAG = "public";

export const HC_LIMITS = {
  /** Chosen spaces. */
  spaces: 100,
  /** Category keys kept in order or hidden. */
  categories: 500,
  /** A search as typed. */
  q: 120,
  /** A query as stored for the stats. */
  storedQ: 100,
  /** Suggestions as you type, and under the request form's subject. */
  suggest: 6,
  /** Articles a category page lists. */
  category: 300,
  /** Search results on the results page. */
  results: 30,
  /** 1.20.37: the home's greeting. */
  greeting: 120,
  /** 1.20.37: rows in the home's Popular articles and Recently updated. */
  home: 6,
  /** 1.20.37: articles on a space card. */
  spaceTop: 3,
  /** 1.20.37: space cards on the home. */
  homeSpaces: 24,
  /** 1.20.37: "What do you need?" tiles before "More". */
  tiles: 8,
  /** 1.20.37: request types among the suggestions as you type (the rest are articles). */
  suggestTypes: 2,
  /** 1.20.37: the window Popular articles counts views over (days). */
  popularDays: 90,
} as const;

/** 1.20.37: the home's greeting when the admin leaves it empty. */
export const HC_DEFAULT_GREETING = "How can we help?";

/** How long a journey may sit before "opened an article, raised nothing" counts as answered. */
export const HC_ANSWERED_AFTER_MS = 30 * 60_000;
/** The stats window. */
export const HC_STATS_DAYS = 30;

export interface HelpCentreSettings {
  /** "Show a help centre". */
  enabled: boolean;
  /** "Documents in chosen spaces". */
  from_spaces: boolean;
  /** The chosen spaces (space ids). Private spaces never count, whatever is stored. */
  spaces: number[];
  /** "Documents tagged public", from any space that is not private. */
  tagged: boolean;
  /** Category keys in the order the help centre shows them (unknown ones follow, by name). */
  order: string[];
  /** Category keys switched off: their articles are not public. */
  hidden: string[];
  /** "Let search engines index the help centre" (default off: noindex). */
  indexing: boolean;
  /** 1.20.37: the home's one-line greeting ("" = HC_DEFAULT_GREETING). */
  greeting: string;
  /** 1.20.37: the home's sections (all on by default). */
  show_popular: boolean;
  show_recent: boolean;
  show_spaces: boolean;
  show_tiles: boolean;
}

/** 1.20.37: the home's sections, in the order the home shows them. */
export const HC_HOME_SECTIONS = ["show_tiles", "show_popular", "show_recent", "show_spaces"] as const;
export type HelpHomeSection = (typeof HC_HOME_SECTIONS)[number];

export const DEFAULT_HELP_CENTRE_SETTINGS: HelpCentreSettings = {
  enabled: false,
  from_spaces: true,
  spaces: [],
  tagged: false,
  order: [],
  hidden: [],
  indexing: false,
  greeting: "",
  show_popular: true,
  show_recent: true,
  show_spaces: true,
  show_tiles: true,
};

/** One line of text: control characters and runs of spaces collapse, clamped. */
export function cleanGreeting(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, HC_LIMITS.greeting);
}

/** The greeting the home shows. */
export function helpGreeting(s: Pick<HelpCentreSettings, "greeting">): string {
  return s.greeting || HC_DEFAULT_GREETING;
}

/**
 * A category key: "c<id>" is a folder (space_categories row), "s<id>" is
 * the documents of space <id> that sit in no folder (shown under the
 * space's name).
 */
export const CATEGORY_KEY_RE = /^[cs][1-9]\d{0,9}$/;

export function isCategoryKey(v: unknown): v is string {
  return typeof v === "string" && CATEGORY_KEY_RE.test(v);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function idList(raw: unknown, max: number): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const x of raw) {
    const n = typeof x === "number" ? x : typeof x === "string" && /^\d+$/.test(x) ? Number(x) : NaN;
    if (Number.isInteger(n) && n > 0 && n <= 2_147_483_647 && !out.includes(n)) out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

function keyList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    if (isCategoryKey(x) && !out.includes(x)) out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

/** Settings as stored or as sent, cleaned to the shape. Never throws. */
export function cleanHelpCentreSettings(raw: unknown): HelpCentreSettings {
  const v = isObj(raw) ? raw : {};
  return {
    enabled: v.enabled === true,
    from_spaces: v.from_spaces === undefined ? DEFAULT_HELP_CENTRE_SETTINGS.from_spaces : v.from_spaces === true,
    spaces: idList(v.spaces, HC_LIMITS.spaces),
    tagged: v.tagged === true,
    order: keyList(v.order, HC_LIMITS.categories),
    hidden: keyList(v.hidden, HC_LIMITS.categories),
    indexing: v.indexing === true,
    greeting: cleanGreeting(v.greeting),
    // Sections are on unless switched off (a value stored before 1.20.37 has none of them).
    show_popular: v.show_popular !== false,
    show_recent: v.show_recent !== false,
    show_spaces: v.show_spaces !== false,
    show_tiles: v.show_tiles !== false,
  };
}

/** The space ids and folder ids the help centre settings name (chosen spaces, and the category keys in order and hidden). */
export function helpCentreRefIds(settings: HelpCentreSettings): { spaces: number[]; categories: number[] } {
  const spaces = new Set(settings.spaces);
  const categories = new Set<number>();
  for (const k of [...settings.order, ...settings.hidden]) (k[0] === "s" ? spaces : categories).add(Number(k.slice(1)));
  return { spaces: [...spaces], categories: [...categories] };
}

/**
 * 1.20.30: the help centre settings against the spaces (and folders) that
 * exist. A space that is gone leaves `spaces`, and its "s<id>" category
 * key leaves `order` and `hidden`; with `categories` given, a folder's
 * "c<id>" key that is gone leaves them too (a deleted space takes its
 * folders with it). Pure: the space delete, the settings route's read and
 * save, and the tests share it.
 */
export function pruneHelpCentreRefs(
  settings: HelpCentreSettings,
  live: { spaces: Iterable<number>; categories?: Iterable<number> }
): { settings: HelpCentreSettings; dropped: number[]; dropped_keys: string[]; changed: boolean } {
  const spaces = new Set(live.spaces);
  const categories = live.categories === undefined ? null : new Set(live.categories);
  const keepKey = (k: string) => (k[0] === "s" ? spaces.has(Number(k.slice(1))) : !categories || categories.has(Number(k.slice(1))));
  const dropped = settings.spaces.filter((id) => !spaces.has(id));
  const order = settings.order.filter(keepKey);
  const hidden = settings.hidden.filter(keepKey);
  const dropped_keys = [...new Set([...settings.order, ...settings.hidden].filter((k) => !keepKey(k)))];
  const changed = dropped.length > 0 || dropped_keys.length > 0;
  if (!changed) return { settings, dropped, dropped_keys, changed };
  return { settings: { ...settings, spaces: settings.spaces.filter((id) => spaces.has(id)), order, hidden }, dropped, dropped_keys, changed };
}

/** A search as typed: search operators a customer did not mean dropped, quotes gone, spaces collapsed, clamped. */
export function cleanHelpQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\b(space|type|tag|author|status):\S*/gi, " ")
    .replace(/["“”]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, HC_LIMITS.q);
}

/** The words of a query, for a prefix search (letters and digits only, at most eight). */
export function queryWords(q: string): string[] {
  return (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length <= 40).slice(0, 8);
}

/**
 * A query as the stats keep it: lower-case, with anything that looks like
 * an email address or a long number (an order, a phone) replaced, so a
 * customer who types their own details leaves none behind.
 */
export function redactQuery(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^\s@]+@[^\s@]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{5,}\d/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, HC_LIMITS.storedQ);
}

/** A browser tab's journey id: what the page makes with crypto.randomUUID (or similar), nothing else. */
export function cleanJourneyId(raw: unknown): string {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(raw) ? raw : "";
}

/** "exporting-reports-to-csv" from a stored slug or a title, for the address. */
export function articleSlug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function articleHref(id: number, slugOrTitle: string): string {
  const s = articleSlug(slugOrTitle);
  return `/support/articles/${id}${s ? `-${s}` : ""}`;
}

/** The article id at the front of "/support/articles/<id>-<slug>"'s segment, or null. */
export function articleIdFrom(segment: string): number | null {
  const m = /^(\d{1,10})(?:-[a-z0-9-]*)?$/.exec(segment);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 && n <= 2_147_483_647 ? n : null;
}

export function categoryHref(key: string): string {
  return `/support/categories/${key}`;
}

/** 1.20.37: a space's page in the Help Center (its public articles, by category). */
export function spaceHref(id: number): string {
  return `/support/spaces/${id}`;
}

/** The space id in "/support/spaces/<id>", or null. */
export function spaceIdFrom(segment: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(segment)) return null;
  const n = Number(segment);
  return n <= 2_147_483_647 ? n : null;
}

/** 1.20.37: the new-request form with this request type chosen. */
export function newRequestHref(typeId: number): string {
  return `/support/new?type=${typeId}`;
}

/** "1 article", "8 articles". */
export function articleCount(n: number): string {
  return n === 1 ? "1 article" : `${n.toLocaleString("en")} articles`;
}

/** What a public suggestion carries: never an author, a space id, tags or text beyond the summary. */
export interface HelpSuggestion {
  id: number;
  title: string;
  href: string;
  category: string;
  /** 1.20.37: the space's name (the suggestions show "title · space"). */
  space: string;
  summary: string;
}

/** 1.20.37: a request type among the suggestions as you type: only what the portal offers. */
export interface HelpTypeSuggestion {
  id: number;
  title: string;
  href: string;
  icon: string;
}

/**
 * 1.20.37: the request types whose title or description holds every word
 * of the query as a word prefix ("pass" finds "Password reset"), titles
 * first, in the given (configured) order otherwise. Pure: the caller hands
 * in only the types the portal offers.
 */
export function matchRequestTypes<T extends { id: number; title: string; description: string }>(types: readonly T[], q: string, limit: number): T[] {
  const clean = cleanHelpQuery(q);
  const words = queryWords(clean);
  if (clean.length < 2 || !words.length || limit <= 0) return [];
  const has = (text: string) => {
    const mine = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    return words.every((w) => mine.some((m) => m.startsWith(w)));
  };
  const inTitle = types.filter((t) => has(t.title));
  const inBody = types.filter((t) => !inTitle.includes(t) && has(`${t.title} ${t.description}`));
  return [...inTitle, ...inBody].slice(0, limit);
}

export interface HelpCentreStats {
  searches: number;
  /** Journeys that searched or opened a suggestion, settled (older than 30 minutes). */
  journeys: number;
  /** Of those, the share that opened an article and raised no request; null with none. */
  answered_pct: number | null;
  /** The most frequent search; null with none. */
  top_search: string | null;
}
