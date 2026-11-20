// Helpdesk 1.19.4 (C3): the customer portal help centre. Customers (anyone
// who can reach /support, signed in or not) search and read a chosen set
// of the workspace's documents before raising a request. Server-only.
//
// WHAT IS PUBLIC: one function decides, publicArticleScope below; its two
// readers (publicHelpArticles, publicHelpCounts) only add a SELECT. Every
// surface that shows a document to the portal goes through it: the help
// centre home (categories and their counts), a category page, search and
// the suggestions as you type, the request form's suggestions, an article
// page, the links between articles, and the files an article carries. No
// other code selects documents for the portal.
//
// A document is public when ALL of these hold:
//   - the help centre is on, and the portal is open (licensed and on);
//   - it is chosen: in one of the chosen spaces (while "Documents in chosen
//     spaces" is on), or tagged `public` (while "Documents tagged public"
//     is on);
//   - its category (folder, or the space's unfiled documents) is not
//     switched off on the settings page;
//   - and it is not restricted, nor is any page above it (parent_id, up to
//     20 levels): restricted is
//       * in the trash (deleted_at),
//       * a draft (status), or a draft branch of another document
//         (branch_of), whatever its status says,
//       * in a private space (whatever the settings name),
//       * handbook-only ("Where people find it", stored as handbook_only:
//         stricter than the app's no-orphans rule, which treats an orphan
//         as a space document),
//       * a policy people must confirm they have read (ack_required), or a
//         retired one (ack_retired_at): these are obligations for staff,
//       * a live training deck.
//
// What an article carries out is an allowlist (HelpArticle): id, title,
// summary, updated date, category name and, for the article page, the
// body. Never the author, an editor's or commenter's email, comments,
// version history, tags, the space's own settings or a reviewer. HTML
// comments (an author's notes to themselves) are removed from the body
// (publicBody), and search matches only the text the outside reads (title,
// summary, body without comments; never tags). Every address in the body
// is decided on the parsed tree (helpCentreUrl through MarkdownView's
// rewriteUrl): files point at the help centre's own file route, links to
// other documents point at their article when that article is public and
// keep only their text when not, any other address into the workspace is
// dropped, and other sites' addresses stay as written.
//
// Stats. Searches and "answered without a request" are counted without
// personal data (lib/helpdesk/help-centre-schema): no contact, account or
// network address, queries redacted, a random per-tab journey id. Only
// searches the help centre's own pages make count (never a link from
// elsewhere, never the request form's subject). A journey ends in a
// request when the portal's request route creates one carrying its id;
// the sign-in link carries the id to the browser that opens the email.

import "server-only";
import { getSetting, setSetting } from "../db";
import { getAppSettings } from "../settings-store";
import { spaceScopeFor } from "../access";
import { scopeAllows } from "../space-scope";
import type { Role } from "../types";
import { hq, hqOne } from "./db-core";
import { hdRateLimited } from "./access";
import { getPortalSettings, portalOpen, type PortalSettings } from "./portal";
import { HD_HELP_CENTRE_SETTINGS_KEY } from "./portal-refs";
import {
  DEFAULT_HELP_CENTRE_SETTINGS,
  HC_ANSWERED_AFTER_MS,
  HC_LIMITS,
  HC_PUBLIC_TAG,
  HC_STATS_DAYS,
  articleHref,
  cleanHelpCentreSettings,
  cleanHelpQuery,
  cleanJourneyId,
  isCategoryKey,
  queryWords,
  redactQuery,
  type HelpCentreSettings,
  type HelpCentreStats,
  type HelpSuggestion,
} from "./help-centre-shared";

export * from "./help-centre-shared";

// --- Settings ------------------------------------------------------------------------

// 1.20.30: defined in portal-refs (a space delete prunes it without loading the help centre).
export { HD_HELP_CENTRE_SETTINGS_KEY };

export async function getHelpCentreSettings(): Promise<HelpCentreSettings> {
  try {
    const raw = await getSetting(HD_HELP_CENTRE_SETTINGS_KEY);
    return cleanHelpCentreSettings(raw ? JSON.parse(raw) : DEFAULT_HELP_CENTRE_SETTINGS);
  } catch {
    return cleanHelpCentreSettings(DEFAULT_HELP_CENTRE_SETTINGS);
  }
}

/** Save the settings (cleaned); answers what changed, by key. */
export async function saveHelpCentreSettings(raw: unknown): Promise<{ settings: HelpCentreSettings; changed: (keyof HelpCentreSettings)[] }> {
  const before = await getHelpCentreSettings();
  const next = cleanHelpCentreSettings(raw);
  const changed = (Object.keys(next) as (keyof HelpCentreSettings)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
  if (changed.length) await setSetting(HD_HELP_CENTRE_SETTINGS_KEY, JSON.stringify(next));
  return { settings: next, changed };
}

/** The settings a caller already read, so one request reads them once (and tests pass their own). */
export interface HelpCentreContext {
  hc?: HelpCentreSettings;
  portal?: PortalSettings;
}

async function resolve(given?: HelpCentreContext): Promise<{ hc: HelpCentreSettings; portal: PortalSettings }> {
  const [hc, portal] = await Promise.all([given?.hc ?? getHelpCentreSettings(), given?.portal ?? getPortalSettings()]);
  return { hc, portal };
}

/** The help centre exists: the portal is open (licensed and on) and the help centre is switched on. */
export async function helpCentreOpen(given?: HelpCentreContext): Promise<boolean> {
  const { hc, portal } = await resolve(given);
  if (!hc.enabled) return false;
  try {
    return await portalOpen(portal);
  } catch {
    return false;
  }
}

// --- THE RULE ------------------------------------------------------------------------

/** What a public article carries out. An allowlist: add nothing here that the outside should not read. */
export interface HelpArticle {
  id: number;
  title: string;
  href: string;
  summary: string;
  updated_at: string;
  category: { key: string; name: string };
  /**
   * 1.20.37: what a row says it sits in (SPACE_LABEL_SQL): the space's own
   * name only for a space the admin chose whose unfiled category is shown,
   * else the category's name, as before 1.20.37 (a folder's name; for a
   * space's unfiled documents, which the category already names, the
   * space's). Never the name of a space nobody published.
   */
  space: string;
  /** The body as the outside reads it (publicBody); only when asked for. */
  body?: string;
  /** 1.20.37: views in the last HC_LIMITS.popularDays days; only with order "popular". */
  views?: number;
}

export interface HelpArticleQuery {
  /** Only these documents. */
  ids?: number[];
  /** Matching this search (prefix words over the public text: title, summary and body without comments; title words too). */
  q?: string;
  /** With q: any of its words rather than all of them (the suggestions' second pass). */
  any?: boolean;
  /** Only this category key. */
  category?: string;
  /** 1.20.37: only this space. */
  space?: number;
  /** 1.20.37: newest update first ("recent"), or most viewed first ("popular"); else the admin's order. */
  order?: "recent" | "popular";
  /** At most this many (default 200, at most 5000). */
  limit?: number;
  /** Include the public body (an article page). */
  body?: boolean;
}

/**
 * True for a document row (`a`) that may never be public, whatever the
 * settings say. Every arm is listed in this module's header.
 */
function restrictedSql(a: string): string {
  return `(
    ${a}.deleted_at IS NOT NULL
    OR ${a}.status IS DISTINCT FROM 'published'
    OR ${a}.branch_of IS NOT NULL
    OR coalesce(${a}.find_mode, 'space') = 'handbook_only'
    OR coalesce(${a}.ack_required, 0) <> 0
    OR ${a}.ack_retired_at IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM spaces rs WHERE rs.id = ${a}.space_id AND rs.visibility IN ('public', 'internal'))
    OR EXISTS (SELECT 1 FROM training_decks rt WHERE rt.document_id = ${a}.id AND rt.archived_at IS NULL)
  )`;
}

const CATEGORY_KEY_SQL = `(CASE WHEN c.id IS NULL THEN 's' || d.space_id ELSE 'c' || c.id END)`;

/**
 * HTML comments, as publicBody removes them: from "<!--" to the first
 * "-->", or to the end when it never closes. The SQL twin (a PostgreSQL
 * ARE whose first quantifier is non-greedy, so the whole match is the
 * shortest, as in the JS) is COMMENT_SQL_RE.
 */
export const COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;
const COMMENT_SQL_RE = "<!--.*?(-->|$)";

/**
 * What a search may match: the text the outside reads. Title (A), summary
 * (B) and the body with its comments removed (C); never tags, never the
 * stored documents.search (which holds tags and the raw body).
 */
const PUBLIC_VECTOR_SQL = `(setweight(to_tsvector('english', coalesce(d.title, '')), 'A')
    || setweight(to_tsvector('english', coalesce(d.summary, '')), 'B')
    || setweight(to_tsvector('english', regexp_replace(coalesce(d.content, ''), '${COMMENT_SQL_RE}', '', 'g')), 'C'))`;

interface PublicScope {
  hc: HelpCentreSettings;
  portal: PortalSettings;
  /** The WHERE over documents d, spaces s and space_categories c. */
  where: string;
  params: unknown[];
  /** "rank DESC, " for a search, else "". */
  rank: string;
}

/**
 * THE RULE: the one place that decides what the help centre may show.
 * Answers the SQL scope of the public articles matching `query` (over
 * documents d JOIN spaces s LEFT JOIN space_categories c), or null when
 * the help centre is closed or the query can match nothing. Both readers
 * below (the articles, and their counts by category) take their WHERE from
 * here and add nothing to it. See this module's header for the rule.
 */
export async function publicArticleScope(query: Omit<HelpArticleQuery, "limit" | "body" | "order"> = {}, given?: HelpCentreContext): Promise<PublicScope | null> {
  const { hc, portal } = await resolve(given);
  if (!(await helpCentreOpen({ hc, portal }))) return null;
  const spaces = hc.from_spaces ? hc.spaces : [];
  if (!spaces.length && !hc.tagged) return null;
  if (query.ids && !query.ids.length) return null;
  if (query.category !== undefined && !isCategoryKey(query.category)) return null;
  if (query.space !== undefined && !(Number.isInteger(query.space) && query.space > 0 && query.space <= 2_147_483_647)) return null;

  const params: unknown[] = [spaces, hc.tagged, hc.hidden, HC_PUBLIC_TAG];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [
    `NOT ${restrictedSql("d")}`,
    // No page above it is restricted either (a page under a draft, a
    // handbook-only policy or a document in the trash stays inside).
    `NOT EXISTS (
       WITH RECURSIVE up(id, parent_id, depth) AS (
         SELECT pd.id, pd.parent_id, 1 FROM documents pd WHERE pd.id = d.parent_id
         UNION ALL
         SELECT pd.id, pd.parent_id, up.depth + 1 FROM documents pd JOIN up ON pd.id = up.parent_id WHERE up.depth < 20
       )
       SELECT 1 FROM up JOIN documents a ON a.id = up.id WHERE ${restrictedSql("a")}
     )`,
    `((cardinality($1::int[]) > 0 AND d.space_id = ANY($1::int[]))
       OR ($2::boolean AND EXISTS (SELECT 1 FROM unnest(string_to_array(d.tags, ',')) tg(t) WHERE lower(btrim(tg.t)) = $4)))`,
    `NOT (${CATEGORY_KEY_SQL} = ANY($3::text[]))`,
  ];
  if (query.ids) where.push(`d.id = ANY(${p(query.ids.filter((n) => Number.isInteger(n) && n > 0).slice(0, 5000))}::int[])`);
  if (query.category !== undefined) where.push(`${CATEGORY_KEY_SQL} = ${p(query.category)}`);
  if (query.space !== undefined) where.push(`d.space_id = ${p(query.space)}::int`);

  let rank = "";
  if (query.q !== undefined) {
    const words = queryWords(cleanHelpQuery(query.q));
    if (!words.length) return null;
    const ts = p(words.map((w) => `${w}:*`).join(query.any ? " | " : " & "));
    const likes = p(words.map((w) => `%${w.replace(/[\\%_]/g, (m) => `\\${m}`)}%`));
    where.push(`(${PUBLIC_VECTOR_SQL} @@ to_tsquery('english', ${ts}) OR lower(d.title) LIKE ${query.any ? "ANY" : "ALL"}(${likes}::text[]))`);
    rank = `ts_rank(${PUBLIC_VECTOR_SQL}, to_tsquery('english', ${ts})) + (CASE WHEN lower(d.title) LIKE ALL(${likes}::text[]) THEN 1 ELSE 0 END) DESC, `;
  }
  return { hc, portal, where: where.join("\n        AND "), params, rank };
}

const FROM_SQL = `FROM documents d
       JOIN spaces s ON s.id = d.space_id
       LEFT JOIN space_categories c ON c.id = d.category_id AND c.space_id = d.space_id`;

/** The admin's order: categories, then spaces by name, then the documents' own order. */
const DEFAULT_ORDER_SQL = "coalesce(c.position, -1), lower(s.name), d.position, lower(d.title), d.id";

/**
 * 1.20.37: views per document over the Popular window, for order "popular"
 * (a LEFT JOIN: it only orders, it never adds a row to the rule's).
 */
/**
 * 1.20.37 (review M1): the label a public row carries for its space. A
 * space's own name travels only when the admin chose the space (while
 * "Documents in chosen spaces" is on: publicArticleScope's $1) and did not
 * hide its unfiled category ($3); otherwise the row says its category, as
 * the category pages always did, so a document tagged public in a folder of
 * an internal space nobody chose ("Restructuring 2027") never names it.
 * Only valid inside a query whose params come from publicArticleScope.
 */
const SPACE_LABEL_SQL = `(CASE WHEN s.id = ANY($1::int[]) AND NOT (('s' || s.id) = ANY($3::text[])) THEN s.name ELSE coalesce(c.name, s.name) END)`;

const VIEWS_JOIN_SQL = `LEFT JOIN (
         SELECT document_id, sum(views)::int AS n FROM hd_hc_article_views
          WHERE day > current_date - ${HC_LIMITS.popularDays} GROUP BY document_id
       ) v ON v.document_id = d.id`;

/** The public articles matching `query` (publicArticleScope), or [] when the help centre is closed. */
export async function publicHelpArticles(query: HelpArticleQuery = {}, given?: HelpCentreContext): Promise<HelpArticle[]> {
  const scope = await publicArticleScope(query, given);
  if (!scope) return [];
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 200)), 5000);
  const popular = query.order === "popular";
  const order =
    query.order === "recent"
      ? `${scope.rank}d.updated_at DESC, d.id DESC`
      : popular
        ? `${scope.rank}coalesce(v.n, 0) DESC, ${DEFAULT_ORDER_SQL}`
        : `${scope.rank}${DEFAULT_ORDER_SQL}`;
  const rows = await hq<{
    id: number;
    title: string;
    slug: string;
    summary: string;
    updated_at: string;
    cat_key: string;
    cat_name: string;
    space_label: string;
    content?: string;
    views?: number;
  }>(
    `SELECT d.id, d.title, d.slug, d.summary, d.updated_at,
            ${CATEGORY_KEY_SQL} AS cat_key, coalesce(c.name, s.name) AS cat_name,
            ${SPACE_LABEL_SQL} AS space_label
            ${query.body ? ", d.content" : ""}
            ${popular ? ", coalesce(v.n, 0) AS views" : ""}
       ${FROM_SQL}
       ${popular ? VIEWS_JOIN_SQL : ""}
      WHERE ${scope.where}
      ORDER BY ${order}
      LIMIT ${limit}`,
    scope.params
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    href: articleHref(r.id, r.slug || r.title),
    summary: (r.summary ?? "").trim(),
    updated_at: r.updated_at,
    category: { key: r.cat_key, name: r.cat_name },
    space: r.space_label,
    ...(query.body ? { body: publicBody(r.content ?? "") } : {}),
    ...(popular ? { views: Number(r.views ?? 0) } : {}),
  }));
}

export interface HelpCategory {
  key: string;
  name: string;
  count: number;
}

/** How many public articles each category holds (publicArticleScope; no row limit, no body). */
export async function publicHelpCounts(query: Pick<HelpArticleQuery, "category"> = {}, given?: HelpCentreContext): Promise<HelpCategory[]> {
  const scope = await publicArticleScope(query, given);
  if (!scope) return [];
  return hq<HelpCategory>(
    `SELECT ${CATEGORY_KEY_SQL} AS key, min(coalesce(c.name, s.name)) AS name, count(*)::int AS count
       ${FROM_SQL}
      WHERE ${scope.where}
      GROUP BY 1`,
    scope.params
  );
}

export interface HelpSpaceCount {
  id: number;
  name: string;
  count: number;
}

/** 1.20.37: how many public articles each space holds (publicArticleScope; no row limit, no body). */
export async function publicHelpSpaces(query: Pick<HelpArticleQuery, "space"> = {}, given?: HelpCentreContext): Promise<HelpSpaceCount[]> {
  const scope = await publicArticleScope(query, given);
  if (!scope) return [];
  return hq<HelpSpaceCount>(
    `SELECT s.id, min(s.name) AS name, count(*)::int AS count
       ${FROM_SQL}
      WHERE ${scope.where}
      GROUP BY s.id`,
    scope.params
  );
}

// --- The body as the outside reads it ----------------------------------------------------

/**
 * A published body for the outside: HTML comments (an author's notes to
 * themselves) removed, exactly as the search's public vector removes them.
 * Every address the body carries is then rewritten on the parsed tree by
 * helpCentreUrl (MarkdownView's rewriteUrl), after the sanitiser.
 */
export function publicBody(content: string): string {
  return content.replace(COMMENT_RE, "");
}

/**
 * Every document id the body might point at ("/doc/N" anywhere): a
 * superset, only used to look up which of them are public, so a link in
 * any form can be pointed at its article.
 */
export function linkedDocIds(content: string): number[] {
  const ids = new Set<number>();
  for (const m of content.matchAll(/\/doc\/(\d{1,10})/g)) ids.add(Number(m[1]));
  return [...ids].filter((n) => n > 0 && n <= 2_147_483_647);
}

export const HELP_FILE_PATH = "/support/api/help/files";

/** The host a relative address is resolved against (a stand-in: it is never a real host). */
const PORTAL_BASE = "http://portal.invalid/support/articles/";

export interface HelpUrlContext {
  /** Document id → its public article's address (only public ones). */
  publicHrefs: ReadonlyMap<number, string>;
  /** This workspace's own host names, lower-case (custom domain, the request's host). */
  ownHosts: ReadonlySet<string>;
}

/**
 * One address in a public article, decided on its parsed form (resolved
 * against the portal with dot segments normalised, so "/support/../doc/1"
 * is /doc/1): an address on another site stays as written; mailto: and tel:
 * stay; on this workspace (a relative address, or one of `ownHosts`):
 *   /doc/N              → its article when public, else dropped
 *   /api/attachments/N  → /support/api/help/files/N (served only for a public article)
 *   the portal's pages  → kept (/support and under it, its API excepted but
 *                         for the help centre's files)
 *   anything else       → dropped.
 * Null means drop: a link keeps its text, an image or video goes.
 */
export function helpCentreUrl(raw: string, ctx: HelpUrlContext): string | null {
  const url = raw.trim();
  if (!url) return null;
  if (url.startsWith("#")) return /^#[\w-]{1,100}$/.test(url) ? url : null;
  let u: URL;
  try {
    u = new URL(url, PORTAL_BASE);
  } catch {
    return null;
  }
  if (u.protocol === "mailto:" || u.protocol === "tel:") return url;
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.host.toLowerCase();
  const own = host === "portal.invalid" || ctx.ownHosts.has(host) || ctx.ownHosts.has(u.hostname.toLowerCase());
  // Another site's address: left exactly as written (its /doc/N or
  // /api/attachments/N is not this workspace's).
  if (!own) return url;
  const path = u.pathname;
  const doc = /^\/doc\/(\d{1,10})\/?$/.exec(path);
  if (doc) {
    const href = ctx.publicHrefs.get(Number(doc[1]));
    return href ? `${href}${u.hash}` : null;
  }
  const att = /^\/api\/attachments\/(\d{1,10})$/.exec(path);
  if (att) return `${HELP_FILE_PATH}/${att[1]}`;
  if (/^\/support\/api\/help\/files\/\d{1,10}$/.test(path)) return path;
  if (path === "/support" || (path.startsWith("/support/") && !path.startsWith("/support/api/"))) return `${path}${u.search}${u.hash}`;
  return null;
}

/** This workspace's host names: its custom domain, and the host(s) the request came in on (comma-separated is fine). */
export async function helpCentreOwnHosts(requestHost: string | null | undefined): Promise<Set<string>> {
  const hosts = new Set<string>();
  const add = (h: string | null | undefined) => {
    const v = (h ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (v) {
      hosts.add(v);
      hosts.add(v.replace(/:\d+$/, ""));
    }
  };
  for (const h of (requestHost ?? "").split(",")) add(h);
  try {
    add((await getAppSettings()).custom_domain);
  } catch {
    /* no settings: the request's host only */
  }
  for (const env of [process.env.COMPASSDOCS_BASE_URL, process.env.NEXT_PUBLIC_BASE_URL]) add(env);
  return hosts;
}

// --- What the pages read -------------------------------------------------------------

/** Categories in the admin's order; ones not in it yet follow by name. */
export function orderCategories<T extends { key: string; name: string }>(cats: T[], order: readonly string[]): T[] {
  const pos = new Map(order.map((k, i) => [k, i]));
  return [...cats].sort((a, b) => {
    const pa = pos.get(a.key);
    const pb = pos.get(b.key);
    if (pa !== undefined && pb !== undefined) return pa - pb;
    if (pa !== undefined) return -1;
    if (pb !== undefined) return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.key.localeCompare(b.key);
  });
}

/** The help centre home's categories with their true article counts, in the admin's order. */
export async function helpCentreCategories(given?: HelpCentreContext): Promise<HelpCategory[]> {
  const { hc, portal } = await resolve(given);
  return orderCategories(await publicHelpCounts({}, { hc, portal }), hc.order);
}

/** One category: its true count and its first HC_LIMITS.category articles; null when it shows nothing. */
export async function helpCentreCategory(
  key: string,
  given?: HelpCentreContext
): Promise<{ key: string; name: string; total: number; articles: HelpArticle[] } | null> {
  if (!isCategoryKey(key)) return null;
  const { hc, portal } = await resolve(given);
  const [count] = await publicHelpCounts({ category: key }, { hc, portal });
  if (!count) return null;
  const articles = await publicHelpArticles({ category: key, limit: HC_LIMITS.category }, { hc, portal });
  if (!articles.length) return null;
  return { key, name: count.name, total: count.count, articles };
}

/**
 * One article with its body, its files, and where the documents it links
 * to are public (`links`, for helpCentreUrl); null when it is not public.
 */
export async function helpCentreArticle(
  id: number,
  given?: HelpCentreContext
): Promise<(HelpArticle & { body: string; files: { id: number; filename: string; href: string }[]; links: [number, string][] }) | null> {
  const { hc, portal } = await resolve(given);
  const [a] = await publicHelpArticles({ ids: [id], body: true, limit: 1 }, { hc, portal });
  if (!a) return null;
  // Links to other documents survive only to articles this same rule makes public.
  const linked = linkedDocIds(a.body ?? "").slice(0, 500);
  const reachable = linked.length ? await publicHelpArticles({ ids: linked, limit: linked.length }, { hc, portal }) : [];
  const files = await hq<{ id: number; filename: string }>("SELECT id, filename FROM attachments WHERE document_id = $1 ORDER BY created_at DESC, id DESC", [a.id]);
  return {
    ...a,
    body: a.body ?? "",
    files: files.map((f) => ({ id: f.id, filename: f.filename, href: `${HELP_FILE_PATH}/${f.id}` })),
    links: reachable.map((r) => [r.id, r.href]),
  };
}

/** A file an article carries, when that article is public; null otherwise. */
export async function helpCentreFile(id: number, given?: HelpCentreContext): Promise<{ id: number; filename: string; stored_name: string; mime_type: string; size: number } | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const att = await hqOne<{ id: number; document_id: number; filename: string; stored_name: string; mime_type: string; size: number }>(
    "SELECT id, document_id, filename, stored_name, mime_type, size FROM attachments WHERE id = $1",
    [id]
  );
  if (!att) return null;
  const [doc] = await publicHelpArticles({ ids: [att.document_id], limit: 1 }, given);
  if (!doc) return null;
  const { document_id: _d, ...file } = att;
  return file;
}

export function toSuggestion(a: HelpArticle): HelpSuggestion {
  return { id: a.id, title: a.title, href: a.href, category: a.category.name, space: a.space, summary: a.summary.slice(0, 240) };
}

// --- The home (1.20.37) -------------------------------------------------------------------

/** A space card on the home: its name, its description (chosen spaces only), its count and its top articles. */
export interface HelpHomeSpace {
  id: number;
  name: string;
  /** The space's own description, only for a space the admin chose; "" otherwise. */
  description: string;
  count: number;
  top: HelpSuggestion[];
}

export interface HelpHome {
  /** The most viewed public articles (only ones viewed at least once); [] when off. */
  popular: HelpSuggestion[];
  /** The newest updated public articles; [] when off. */
  recent: (HelpSuggestion & { updated_at: string })[];
  /** A card per space that may be named (spaceNamed), at most HC_LIMITS.homeSpaces; [] when off. */
  spaces: HelpHomeSpace[];
  /**
   * The categories as cards: all of them with Spaces off (the 1.19.4 home);
   * with Spaces on, those of the spaces without a card (a space that may not
   * be named, or one past the cap: review L3), so nothing public goes unlisted.
   */
  categories: HelpCategory[];
  /** Public articles in all (the categories' true counts). */
  total: number;
}

/** The admin chose this space (and "Documents in chosen spaces" is on): its description may show. */
function describes(hc: HelpCentreSettings, spaceId: number): boolean {
  return hc.from_spaces && hc.spaces.includes(spaceId);
}

/**
 * 1.20.37 (review M1): a space whose own name the outside may read, so it
 * may have a card and a page: one the admin chose whose unfiled category is
 * not hidden, or one whose unfiled category is public anyway (that category
 * already shows under the space's name). `cats` are the public categories.
 */
function spaceNamed(hc: HelpCentreSettings, spaceId: number, cats: readonly { key: string }[]): boolean {
  const unfiled = `s${spaceId}`;
  if (describes(hc, spaceId) && !hc.hidden.includes(unfiled)) return true;
  return cats.some((c) => c.key === unfiled);
}

interface HomeRow {
  id: number;
  title: string;
  slug: string;
  summary: string;
  updated_at: string;
  cat_key: string;
  cat_name: string;
  space_id: number;
  space_name: string;
  space_label: string;
  space_count: number;
  views: number;
  pop_rank: number;
  recent_rank: number;
  space_rank: number;
}

/**
 * Everything the home shows below its header band, each section through
 * the one rule (publicArticleScope) and each skipped when the admin
 * switched it off. A section with nothing in it comes back empty, and the
 * page leaves it out. The same for every visitor (no session is read).
 *
 * Review M4: two rule queries, whatever the number of spaces: the
 * categories' counts, and ONE query whose rows carry their rank in Popular,
 * in Recently updated and within their space (row_number() windows over the
 * one scope and the one views aggregate). Before, Popular, Recently updated,
 * the space counts and every card's top three were each a query of their
 * own (up to 28 rule evaluations for 24 cards). Two small lookups follow
 * (the categories' spaces and the chosen spaces' descriptions).
 */
export async function helpCentreHome(given?: HelpCentreContext): Promise<HelpHome> {
  const { hc, portal } = await resolve(given);
  const c = { hc, portal };
  const empty: HelpHome = { popular: [], recent: [], spaces: [], categories: [], total: 0 };
  if (!(await helpCentreOpen(c))) return empty;
  const cats = await helpCentreCategories(c);
  const total = cats.reduce((n, x) => n + x.count, 0);
  if (!total) return empty;
  const parts: string[] = [];
  if (hc.show_popular) parts.push(`(pop_rank <= ${HC_LIMITS.home} AND views > 0)`);
  if (hc.show_recent) parts.push(`recent_rank <= ${HC_LIMITS.home}`);
  if (hc.show_spaces) parts.push(`space_rank <= ${HC_LIMITS.spaceTop}`);
  let rows: HomeRow[] = [];
  if (parts.length) {
    const scope = await publicArticleScope({}, c);
    if (scope) {
      rows = await hq<HomeRow>(
        `WITH pub AS MATERIALIZED (
           SELECT d.id, d.title, d.slug, d.summary, d.updated_at,
                  ${CATEGORY_KEY_SQL} AS cat_key, coalesce(c.name, s.name) AS cat_name,
                  d.space_id, s.name AS space_name, ${SPACE_LABEL_SQL} AS space_label,
                  count(*) OVER (PARTITION BY d.space_id)::int AS space_count,
                  coalesce(v.n, 0) AS views,
                  row_number() OVER (ORDER BY coalesce(v.n, 0) DESC, ${DEFAULT_ORDER_SQL}) AS pop_rank,
                  row_number() OVER (ORDER BY d.updated_at DESC, d.id DESC) AS recent_rank,
                  row_number() OVER (PARTITION BY d.space_id ORDER BY coalesce(v.n, 0) DESC, ${DEFAULT_ORDER_SQL}) AS space_rank
             ${FROM_SQL}
             ${VIEWS_JOIN_SQL}
            WHERE ${scope.where}
         )
         SELECT * FROM pub WHERE ${parts.join(" OR ")}`,
        scope.params
      );
    }
  }
  const suggestion = (r: HomeRow): HelpSuggestion => ({
    id: r.id,
    title: r.title,
    href: articleHref(r.id, r.slug || r.title),
    category: r.cat_name,
    space: r.space_label,
    summary: (r.summary ?? "").trim().slice(0, 240),
  });
  const by = (rank: (r: HomeRow) => number) => [...rows].sort((a, b) => rank(a) - rank(b));
  const popular = hc.show_popular ? by((r) => Number(r.pop_rank)).filter((r) => Number(r.pop_rank) <= HC_LIMITS.home && Number(r.views) > 0) : [];
  const recent = hc.show_recent ? by((r) => Number(r.recent_rank)).filter((r) => Number(r.recent_rank) <= HC_LIMITS.home) : [];

  let spaces: HelpHomeSpace[] = [];
  let categories: HelpCategory[] = cats;
  if (hc.show_spaces) {
    // A space ranks where its first category sits in the admin's order.
    const spaceOfCat = await categorySpaces(cats.map((x) => x.key));
    const firstCat = new Map<number, number>();
    cats.forEach((x, i) => {
      const sid = spaceOfCat.get(x.key);
      if (sid !== undefined && !firstCat.has(sid)) firstCat.set(sid, i);
    });
    const top = new Map<number, HomeRow[]>();
    for (const r of by((x) => Number(x.space_rank))) {
      if (Number(r.space_rank) > HC_LIMITS.spaceTop) continue;
      top.set(r.space_id, [...(top.get(r.space_id) ?? []), r]);
    }
    const ordered = [...top.values()]
      .map((rs) => rs[0])
      .filter((r) => spaceNamed(hc, r.space_id, cats))
      .sort(
        (a, b) =>
          (firstCat.get(a.space_id) ?? Number.MAX_SAFE_INTEGER) - (firstCat.get(b.space_id) ?? Number.MAX_SAFE_INTEGER) ||
          a.space_name.localeCompare(b.space_name, undefined, { sensitivity: "base" }) ||
          a.space_id - b.space_id
      )
      .slice(0, HC_LIMITS.homeSpaces);
    const descriptions = await spaceDescriptions(ordered.filter((r) => describes(hc, r.space_id)).map((r) => r.space_id));
    spaces = ordered.map((r) => ({
      id: r.space_id,
      name: r.space_name,
      description: descriptions.get(r.space_id) ?? "",
      count: Number(r.space_count),
      top: top.get(r.space_id)!.map(suggestion),
    }));
    const carded = new Set(spaces.map((x) => x.id));
    categories = cats.filter((x) => !carded.has(spaceOfCat.get(x.key) ?? -1));
  }
  return {
    popular: popular.map(suggestion),
    recent: recent.map((r) => ({ ...suggestion(r), updated_at: r.updated_at })),
    spaces,
    categories,
    total,
  };
}

/** Category key → its space id ("s<id>" is the space itself; "c<id>" looks up its folder). */
async function categorySpaces(keys: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const folders: number[] = [];
  for (const k of keys) {
    if (k[0] === "s") out.set(k, Number(k.slice(1)));
    else folders.push(Number(k.slice(1)));
  }
  if (folders.length) {
    for (const r of await hq<{ id: number; space_id: number }>("SELECT id, space_id FROM space_categories WHERE id = ANY($1::int[])", [folders])) out.set(`c${r.id}`, r.space_id);
  }
  return out;
}

/** The descriptions of these spaces (the caller passes only chosen spaces that have public articles). */
async function spaceDescriptions(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await hq<{ id: number; description: string }>("SELECT id, description FROM spaces WHERE id = ANY($1::int[]) AND visibility <> 'private'", [ids]);
  return new Map(rows.map((r) => [r.id, (r.description ?? "").trim().slice(0, 300)]));
}

/**
 * 1.20.37: one space's page: its public articles by category (the admin's
 * order), its true count and, for a chosen space, its description; null
 * when it shows nothing: unknown, private, nothing public in it, or a space
 * whose name may not be shown (spaceNamed, review M1).
 */
export async function helpCentreSpace(
  id: number,
  given?: HelpCentreContext
): Promise<{ id: number; name: string; description: string; total: number; shown: number; categories: { key: string; name: string; articles: HelpSuggestion[] }[] } | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const { hc, portal } = await resolve(given);
  const c = { hc, portal };
  const unfiled = describes(hc, id) && !hc.hidden.includes(`s${id}`) ? [] : await publicHelpCounts({ category: `s${id}` }, c);
  if (!spaceNamed(hc, id, unfiled)) return null;
  const [count] = await publicHelpSpaces({ space: id }, c);
  if (!count) return null;
  const articles = await publicHelpArticles({ space: id, limit: HC_LIMITS.category }, c);
  if (!articles.length) return null;
  const order = orderCategories(
    [...new Map(articles.map((a) => [a.category.key, a.category])).values()],
    hc.order
  );
  const description = describes(hc, id) ? ((await spaceDescriptions([id])).get(id) ?? "") : "";
  return {
    id,
    name: count.name,
    description,
    total: count.count,
    shown: articles.length,
    categories: order.map((cat) => ({ key: cat.key, name: cat.name, articles: articles.filter((a) => a.category.key === cat.key).map(toSuggestion) })),
  };
}

/**
 * 1.20.37 (review M2): may this visitor see the portal's request types (the
 * home's tiles, the suggestions' types)? While anyone with an email may use
 * the portal, everyone; otherwise only a signed-in contact, whom
 * currentPortalContact has already checked against the access rule. The
 * catalog of what can be asked for is not shown to the world on a portal
 * that admits only some domains.
 */
export function requestTypesVisible(portal: Pick<PortalSettings, "access">, contact: unknown): boolean {
  return portal.access === "anyone" || !!contact;
}

// --- Views (1.20.37) -----------------------------------------------------------------------

/**
 * Not a person in a browser: crawlers, link unfurlers, monitors and HTTP
 * libraries, by their own user agent (cheap, and enough: a view count is
 * an ordering, not a record).
 */
const BOT_UA_RE = /bot\b|bot\/|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp|telegram|discord|skype|monitor|pingdom|uptime|headless|lighthouse|curl\/|wget\/|python|java\/|go-http|okhttp|axios|node-fetch|undici|libwww|httpclient/i;

export function isBotAgent(ua: string | null | undefined): boolean {
  const v = (ua ?? "").trim();
  return !v || BOT_UA_RE.test(v);
}

/**
 * The request header src/proxy.ts sets (to "1") on a request Next's router
 * made as a prefetch (it sees Next-Router-Prefetch, which a page's
 * headers() does not in Next 16), and strips from any request a client
 * sent with it.
 */
export const PREFETCH_HEADER = "x-compass-prefetch";

/**
 * A prefetch or prerender asks for the page before (or without) anyone
 * opening it. Review L1: in Next 16 a page's headers() never shows
 * Next-Router-Prefetch, so the proxy's PREFETCH_HEADER is the router's
 * signal here; the browser's own (Purpose / Sec-Purpose: speculation rules,
 * link rel=prefetch) still reach the page. Besides this check, nothing on
 * the portal prefetches an article: ArticleLink sets prefetch={false}, and
 * no loading boundary sits over the portal (one would make the router
 * prefetch the page down to it).
 */
export function isPrefetch(h: Headers): boolean {
  const purpose = `${h.get("purpose") ?? ""} ${h.get("sec-purpose") ?? ""} ${h.get("x-purpose") ?? ""}`.toLowerCase();
  return h.get(PREFETCH_HEADER) === "1" || h.get("next-router-prefetch") !== null || /prefetch|prerender|preview/.test(purpose);
}

/**
 * Review M3: the view counter's own memory, never the shared rate-limit
 * buckets (lib/helpdesk/access hdRateLimited): address-and-article keys
 * could grow those to millions, and every limiter walks them past 20,000.
 * Bounded twice: at most `maxKeys` address-and-article keys at once (when
 * full, new ones are not counted until old ones expire), and at most
 * `perAddress` distinct articles counted per address per window (beyond
 * that a visitor, or a crawler that hides its name, counts nothing new).
 * Entries go in in time order with one window, so the oldest are at the
 * front of the Map and expiring them is a loop that stops at the first
 * live one.
 *
 * Review L2: per instance (each server process remembers its own visitors;
 * behind several instances a reload on another one may count again, which
 * is fine for an ordering). A request with no usable address is not counted
 * at all, rather than sharing one key that would hide everyone else.
 */
export class ViewDedupe {
  private seen = new Map<string, number>();
  private perIp = new Map<string, { count: number; until: number }>();
  constructor(private readonly opts: { maxKeys: number; perAddress: number; windowMs: number }) {}

  /** True when this address may count this article now (and remembers that it did). */
  allow(address: string, documentId: number, now = Date.now()): boolean {
    this.expire(now);
    const key = `${address}|${documentId}`;
    if (this.seen.has(key)) return false;
    let a = this.perIp.get(address);
    if (a && a.count >= this.opts.perAddress) return false;
    if (this.seen.size >= this.opts.maxKeys || (!a && this.perIp.size >= this.opts.maxKeys)) return false;
    if (!a) {
      a = { count: 0, until: now + this.opts.windowMs };
      this.perIp.set(address, a);
    }
    a.count++;
    this.seen.set(key, now + this.opts.windowMs);
    return true;
  }

  /** Keys held now (tests). */
  size(): { keys: number; addresses: number } {
    return { keys: this.seen.size, addresses: this.perIp.size };
  }

  private expire(now: number): void {
    for (const [k, until] of this.seen) {
      if (until > now) break;
      this.seen.delete(k);
    }
    for (const [k, v] of this.perIp) {
      if (v.until > now) break;
      this.perIp.delete(k);
    }
  }
}

const VIEW_WINDOW_MS = 30 * 60_000;
const views = new ViewDedupe({ maxKeys: 50_000, perAddress: 20, windowMs: VIEW_WINDOW_MS });

/**
 * Count one view of a public article: nothing about who (no contact,
 * account, address or journey is stored; the row is a number per article
 * per day). Skipped for bots and prefetches, without a usable address, for
 * an address (an IPv6 /64) that already counted this article in the last
 * 30 minutes or 20 articles in that window, and while the counter's memory
 * is full (ViewDedupe). Never throws; true when it counted.
 */
export async function countArticleView(documentId: number, req: { headers: Headers; ip: string | null }): Promise<boolean> {
  try {
    if (!Number.isInteger(documentId) || documentId <= 0) return false;
    if (isBotAgent(req.headers.get("user-agent")) || isPrefetch(req.headers)) return false;
    const ip = (req.ip ?? "").trim();
    if (!ip || ip === "unknown") return false;
    if (!views.allow(searchClientKey(ip), documentId)) return false;
    await hq(
      `INSERT INTO hd_hc_article_views (document_id, day, views) VALUES ($1, current_date, 1)
       ON CONFLICT (document_id, day) DO UPDATE SET views = hd_hc_article_views.views + 1`,
      [documentId]
    );
    await pruneOld().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// --- Limits ----------------------------------------------------------------------------

/**
 * The address a search is counted against: the network address, or for
 * IPv6 its /64 (one household or office gets one /64, so rotating within
 * it buys nothing).
 */
export function searchClientKey(ip: string): string {
  const v = (ip || "unknown").trim().toLowerCase();
  if (!v.includes(":")) return v;
  const parts = v.split("::");
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(":") : [];
  const full = parts.length > 1 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail] : head;
  return `${full.slice(0, 4).map((h) => h.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/**
 * Searching (as you type, the results page and the request form's
 * suggestions): 40 a minute per network address (an IPv6 /64). There is
 * deliberately no workspace-wide bucket: a shared one let a handful of
 * addresses switch search off for every customer. Each search is one
 * indexed query over the chosen spaces, so the per-address limit is the
 * cost bound. In-memory, like the portal's other limits.
 */
export function helpSearchLimited(ip: string): boolean {
  return hdRateLimited(`hc-search:${searchClientKey(ip)}`, 40, 60_000);
}

/** Journey steps: 60 a minute from one network address. */
export function helpJourneyLimited(ip: string): boolean {
  return hdRateLimited(`hc-journey:${searchClientKey(ip)}`, 60, 60_000);
}

// --- Search, with the stats -------------------------------------------------------------

export type HelpSearchSource = "home" | "form";

/**
 * Search the help centre. Only the help centre's own search box counts
 * in the stats, and only when the caller says the page itself asked
 * (`record`): the request form's subject ("form") is never stored, since
 * it is the start of someone's request, not a search.
 */
export async function searchHelpCentre(
  raw: unknown,
  opts: { journey?: unknown; source?: HelpSearchSource; limit?: number; record?: boolean } = {},
  given?: HelpCentreContext
): Promise<HelpSuggestion[]> {
  const q = cleanHelpQuery(raw);
  if (q.length < 2) return [];
  const limit = Math.min(Math.max(1, opts.limit ?? HC_LIMITS.suggest), HC_LIMITS.results);
  const hits = await publicHelpArticles({ q, limit }, given);
  // Fewer than asked with every word: fill up with articles holding some of
  // them ("export csv" also suggests "Why a large export times out"), after.
  if (hits.length < limit && queryWords(q).length > 1) {
    const seen = new Set(hits.map((h) => h.id));
    for (const h of await publicHelpArticles({ q, any: true, limit }, given)) {
      if (hits.length >= limit) break;
      if (!seen.has(h.id)) hits.push(h);
    }
  }
  if (opts.record === true && opts.source !== "form") {
    await recordSearch(cleanJourneyId(opts.journey), q, hits.length, "home").catch(() => {});
  }
  return hits.map(toSuggestion);
}

let lastPrune = 0;

/** Keep 90 days: the stats read 30. At most once an hour, as rows are written. */
async function pruneOld(): Promise<void> {
  if (Date.now() - lastPrune < 3_600_000) return;
  lastPrune = Date.now();
  await hq("DELETE FROM hd_hc_searches WHERE at < now() - interval '90 days'");
  await hq("DELETE FROM hd_hc_journeys WHERE started_at < now() - interval '90 days'");
  await hq("DELETE FROM hd_hc_article_views WHERE day < current_date - 90");
}

/**
 * Count a search. Typing extends the journey's last search for 20 seconds
 * (the new query starts with the old or the reverse), so a word typed key
 * by key is one search.
 */
export async function recordSearch(journey: string, q: string, results: number, source: HelpSearchSource): Promise<void> {
  const stored = redactQuery(q);
  if (stored.length < 2) return;
  if (journey) {
    await hq(
      `INSERT INTO hd_hc_journeys (id, searched) VALUES ($1, true)
       ON CONFLICT (id) DO UPDATE SET searched = true, last_at = now()`,
      [journey]
    );
    const prev = await hqOne<{ id: number; q: string }>(
      `SELECT id, q FROM hd_hc_searches WHERE journey = $1 AND at > now() - interval '20 seconds' ORDER BY at DESC, id DESC LIMIT 1`,
      [journey]
    );
    if (prev && (stored.startsWith(prev.q) || prev.q.startsWith(stored))) {
      await hq("UPDATE hd_hc_searches SET q = $2, results = $3, at = now() WHERE id = $1", [prev.id, stored, results]);
      return;
    }
  }
  await hq("INSERT INTO hd_hc_searches (journey, q, results, source) VALUES ($1, $2, $3, $4)", [journey, stored, results, source]);
  await pruneOld().catch(() => {});
}

export type HelpJourneyEvent = "open" | "submit";

/**
 * A journey's step: "open" (an article opened from a search or a
 * suggestion; from the browser) or "submit" (a request raised afterwards;
 * from the server, when the portal's request route creates the request).
 * Best effort.
 */
export async function recordJourney(rawId: unknown, event: HelpJourneyEvent): Promise<boolean> {
  const id = cleanJourneyId(rawId);
  if (!id) return false;
  if (event === "open") {
    await hq(
      `INSERT INTO hd_hc_journeys (id, opened) VALUES ($1, 1)
       ON CONFLICT (id) DO UPDATE SET opened = least(hd_hc_journeys.opened + 1, 1000), last_at = now()`,
      [id]
    );
    await pruneOld().catch(() => {});
    return true;
  }
  const rows = await hq("UPDATE hd_hc_journeys SET submitted = true, last_at = now() WHERE id = $1 RETURNING id", [id]);
  return rows.length > 0;
}

/**
 * A request was raised in the portal: the journeys it ends. `formJourney`
 * is the tab's own (the form sends it); the sign-in link carries the tab's
 * journey through the email to the browser that opens it, which keeps it
 * (portal session route) and sends it the same way. Never throws.
 */
export async function journeyRaisedRequest(formJourney: unknown): Promise<void> {
  await recordJourney(formJourney, "submit").catch(() => false);
}

/** The settings page's "Last 30 days". */
export async function helpCentreStats(): Promise<HelpCentreStats> {
  const days = `${HC_STATS_DAYS} days`;
  const [count, top, j] = await Promise.all([
    hqOne<{ n: number }>("SELECT count(*)::int AS n FROM hd_hc_searches WHERE at > now() - $1::interval", [days]),
    hqOne<{ q: string }>(
      `SELECT q FROM hd_hc_searches WHERE at > now() - $1::interval
        GROUP BY q ORDER BY count(*) DESC, max(at) DESC LIMIT 1`,
      [days]
    ),
    hqOne<{ total: number; answered: number }>(
      `SELECT count(*)::int AS total, (count(*) FILTER (WHERE opened > 0 AND NOT submitted))::int AS answered
         FROM hd_hc_journeys
        WHERE started_at > now() - $1::interval AND last_at < now() - $2::interval AND (searched OR opened > 0)`,
      [days, `${HC_ANSWERED_AFTER_MS / 1000} seconds`]
    ),
  ]);
  const total = j?.total ?? 0;
  return {
    searches: count?.n ?? 0,
    journeys: total,
    answered_pct: total > 0 ? Math.round(((j?.answered ?? 0) / total) * 100) : null,
    top_search: top?.q ?? null,
  };
}

// --- The settings page ---------------------------------------------------------------

export interface HelpCentreSpaceOption {
  id: number;
  name: string;
  /** A private space: never public, listed only so a stored choice can be seen and removed. */
  private: boolean;
}

/**
 * The spaces the settings page offers and names: every space that is not
 * private, and of the private ones only those already chosen (stored) or
 * that this person can open. Never the name of a private space they could
 * not otherwise see (settings.manage is a desk capability, not a space
 * grant).
 */
export async function helpCentreSpaceOptions(user: { id: number; role: Role }, chosen: readonly number[]): Promise<HelpCentreSpaceOption[]> {
  const [rows, scope] = await Promise.all([
    hq<{ id: number; name: string; visibility: string }>("SELECT id, name, visibility FROM spaces ORDER BY lower(name), id"),
    spaceScopeFor(user),
  ]);
  return rows
    .filter((r) => r.visibility !== "private" || chosen.includes(r.id) || scopeAllows(scope, r.id))
    .map((r) => ({ id: r.id, name: r.name, private: r.visibility === "private" }));
}

export interface HelpCentreAdminCategory extends HelpCategory {
  hidden: boolean;
}

/**
 * The categories a selection would show, hidden ones included (marked), in
 * the admin's order: what the settings page lists to reorder and switch
 * off. Runs the same rule as the portal, as if the help centre and the
 * portal were on, so the page can be set up before either is switched on.
 */
export async function helpCentreAdminCategories(draft: HelpCentreSettings, portal?: PortalSettings): Promise<HelpCentreAdminCategory[]> {
  const p = portal ?? (await getPortalSettings());
  const counts = await publicHelpCounts({}, { hc: { ...draft, enabled: true, hidden: [] }, portal: { ...p, enabled: true } });
  const hidden = new Set(draft.hidden);
  return orderCategories(
    counts.map((c) => ({ ...c, hidden: hidden.has(c.key) })),
    draft.order
  );
}
