// Helpdesk 1.20.37: the Help Center's richer home (lib/helpdesk/help-centre
// helpCentreHome, helpCentreSpace, countArticleView; the suggestions route;
// the home page's request tiles; the settings route). What this file proves:
//   - every home section reads through the one rule (publicArticleScope):
//     Popular articles, Recently updated and the space cards never hold a
//     draft, a document in the trash, a handbook-only or must-confirm
//     policy, a document in a private space, or one in a switched-off
//     category, signed in or not (the Help Center shows everyone the same);
//   - Popular counts only articles that were opened, most opened first, and
//     the counter keeps a number per article per day and nothing about who;
//     bots and prefetches never count, and one address counts once per
//     article in 30 minutes;
//   - a space card carries its description only for a chosen space, and a
//     space reached only through documents tagged public shows its name alone;
//   - the switches: each section off is neither shown nor fetched; Spaces
//     off brings back the categories; a value stored before 1.20.37 has
//     every section on; the greeting is one clean line; a save is audited
//     with what changed;
//   - the request tiles are what the portal offers, in its configured order:
//     never an inactive type, one restricted to groups, or one that needs
//     the directory; a desk department never filters them (1.20.23: the
//     portal is a requester's surface); at most eight, then "More";
//   - the suggestions route: request types and articles, six at most,
//     nothing restricted, the portal's rate limit, 404 while off;
//   - signing in keeps a tile's chosen type (cleanNextPath).
//
// The route and page tests write the portal and Help Center keys under the
// portal's advisory lock (728661, shared with test/helpdesk-portal.test.ts,
// test/helpdesk-help-centre.test.ts and the portal specs) and restore them.
// Every other fixture is this file's own.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-help-center-home.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { NextRequest } from "next/server";
import { pool, getSetting, setSetting, createSession } from "../src/lib/db";
import { newToken } from "../src/lib/password";
import { fixtureQuery } from "./support/retry";

// --- Request scope and licence stubs (as test/helpdesk-help-centre.test.ts) --------------

let currentRequest: Request | null = null;

function cookieJar(): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (currentRequest?.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return jar;
}

const HEADERS_STUB = path.join(__dirname, "stubs", "next-headers.helpdesk-help-center-home.virtual.js");
const EE_STUB = path.join(__dirname, "stubs", "ee.helpdesk-help-center-home.virtual.js");
const EE_REAL = path.join(__dirname, "..", "src", "lib", "ee");
const edition = { present: true, features: ["helpdesk"] as string[] };
{
  const headers = new Module(HEADERS_STUB);
  headers.filename = HEADERS_STUB;
  headers.loaded = true;
  headers.exports = {
    headers: async () => new Headers(currentRequest?.headers ?? {}),
    cookies: async () => {
      const jar = cookieJar();
      return {
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
      };
    },
    draftMode: async () => ({ isEnabled: false }),
  };
  require.cache[HEADERS_STUB] = headers;
  const ee = new Module(EE_STUB);
  ee.filename = EE_STUB;
  ee.loaded = true;
  ee.exports = {
    ee: () => edition,
    eePresent: () => true,
    featureEnabled: async (feature: string) => edition.features.includes(feature),
    featureEnforced: async (feature: string) => edition.features.includes(feature), featureEnabledFrom: (feature: string) => edition.features.includes(feature), featureEnforcedFrom: (feature: string) => edition.features.includes(feature),
  };
  require.cache[EE_STUB] = ee;
  const loader = Module as unknown as {
    _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string;
  };
  const resolveFilename = loader._resolveFilename;
  loader._resolveFilename = function (request: string, parent: { filename?: string } | null, ...rest: unknown[]) {
    if (request === "next/headers") return HEADERS_STUB;
    if (request === "@/lib/ee") return EE_STUB;
    if ((request === "./ee" || request === "../ee") && parent?.filename && path.resolve(path.dirname(parent.filename), request) === EE_REAL) {
      return EE_STUB;
    }
    return resolveFilename.call(this, request, parent, ...rest);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
const hc = require("../src/lib/helpdesk/help-centre") as typeof import("../src/lib/helpdesk/help-centre");
const portal = require("../src/lib/helpdesk/portal") as typeof import("../src/lib/helpdesk/portal");
const searchRoute = require("../src/app/(portal)/support/api/help/search/route") as typeof import("../src/app/(portal)/support/api/help/search/route");
const adminRoute = require("../src/app/api/helpdesk/admin/portal/help-centre/route") as typeof import("../src/app/api/helpdesk/admin/portal/help-centre/route");
const homePage = require("../src/app/(portal)/support/page") as typeof import("../src/app/(portal)/support/page");
const proxyMod = require("../src/proxy") as typeof import("../src/proxy");
/* eslint-enable @typescript-eslint/no-require-imports */

import type { HelpCentreSettings } from "../src/lib/helpdesk/help-centre-shared";
import type { PortalSettings } from "../src/lib/helpdesk/portal-shared";

// --- Fixtures -----------------------------------------------------------------------------

const STAMP = `hdhome${Date.now()}${Math.floor(Math.random() * 1e6)}`;
// A word only this file's documents and request types hold (letters only).
const WORD = `zh${STAMP.replace(/\d/g, (d) => "abcdefghij"[Number(d)])}`;
const HOST = "portal-home.example.test";
const ORIGIN = `http://${HOST}`;
const LOCK = 728661;

const spaceIds: number[] = [];
const userIds: number[] = [];
const typeIds: number[] = [];
const sp = { guides: 0, release: 0, priv: 0, tagged: 0, secret: 0 };
const cat = { start: 0, billing: 0, secretFolder: 0 };
const doc = {} as Record<
  "start1" | "start2" | "start3" | "start4" | "billing" | "release" | "draft" | "trashed" | "handbookOnly" | "ack" | "inPrivate" | "taggedOther" | "taggedInFolder",
  number
>;
const SECRET_SPACE = `Restructuring 2027 ${STAMP}`;
const fx = { team: 0, dept: 0 };
const rt = {} as Record<"second" | "first" | "inactive" | "groups" | "person" | "dept" | "extra", number>;
let admin = { id: 0, session: "" };
let lockClient: PoolClient;
let savedPortal: string | undefined;
let savedHc: string | undefined;

const settings = (over: Partial<HelpCentreSettings> = {}): HelpCentreSettings =>
  hc.cleanHelpCentreSettings({ enabled: true, from_spaces: true, spaces: [sp.guides, sp.release, sp.priv], tagged: false, ...over });
const portalWith = (types: number[]): PortalSettings => portal.cleanPortalSettings({ enabled: true, types: types.map((id) => ({ id, team_id: null })) });
const ctx = (over: Partial<HelpCentreSettings> = {}, p: PortalSettings = portalWith([])) => ({ hc: settings(over), portal: p });

const mine = (ids: number[]) => ids.filter((id) => Object.values(doc).includes(id));
const NEVER = () => [doc.draft, doc.trashed, doc.handbookOnly, doc.ack, doc.inPrivate];

async function space(name: string, visibility: string, description = ""): Promise<number> {
  const id = (
    await fixtureQuery("INSERT INTO spaces (slug, name, visibility, description) VALUES ($1, $2, $3, $4) RETURNING id", [
      `${STAMP}-${name.toLowerCase().replace(/\W+/g, "-")}`,
      `${name} ${STAMP}`,
      visibility,
      description,
    ])
  ).rows[0].id as number;
  spaceIds.push(id);
  return id;
}

async function document(fields: Record<string, unknown>): Promise<number> {
  const f = { status: "published", content: "", tags: "", author: `jane@${STAMP}.corp.test`, ...fields } as Record<string, unknown>;
  f.slug ??= `${STAMP}-${Math.random().toString(36).slice(2, 8)}`;
  const cols = Object.keys(f);
  return (await pool().query(`INSERT INTO documents (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`, cols.map((c) => f[c]))).rows[0].id as number;
}

async function views(documentId: number, n: number, daysAgo = 0): Promise<void> {
  await pool().query(
    `INSERT INTO hd_hc_article_views (document_id, day, views) VALUES ($1, current_date - $3::int, $2)
     ON CONFLICT (document_id, day) DO UPDATE SET views = EXCLUDED.views`,
    [documentId, n, daysAgo]
  );
}

async function requestType(title: string, position: number, extra: Record<string, unknown> = {}): Promise<number> {
  const f = { slug: `${STAMP}-${typeIds.length}`, title, description: `${title} description`, icon: "key", team_id: fx.team, form: "[]", position, ...extra } as Record<string, unknown>;
  const cols = Object.keys(f);
  const id = (await pool().query(`INSERT INTO hd_request_types (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`, cols.map((c) => f[c]))).rows[0].id as number;
  typeIds.push(id);
  return id;
}

let ipSeq = 0;
type Opts = { method?: string; cookie?: string; origin?: string | null; json?: unknown; ip?: string; ua?: string };
function makeRequest(url: string, o: Opts = {}): Request {
  ipSeq = (ipSeq % 250) + 1;
  const headers: Record<string, string> = { host: HOST, "x-forwarded-for": o.ip ?? `198.51.101.${ipSeq}` };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.origin) headers.origin = o.origin;
  let body: string | undefined;
  if (o.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(o.json);
  }
  return new Request(`${ORIGIN}${url}`, { method: o.method ?? (body ? "POST" : "GET"), headers, body });
}

async function call(handler: (req: Request, c: any) => Promise<Response>, url: string, o: Opts = {}) {
  const req = makeRequest(url, o);
  currentRequest = req;
  try {
    const res = await handler(req, undefined);
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  } finally {
    currentRequest = null;
  }
}

before(async () => {
  await getSetting("__schema_bootstrap__");
  sp.guides = await space("Customer guides", "internal", "How to use the product, step by step.");
  sp.release = await space("Release notes", "public", "What changed in each release.");
  sp.priv = await space("Finance private", "private", "Payroll and salaries.");
  sp.tagged = await space("Engineering", "internal", "Internal runbooks: do not share.");
  cat.start = (await pool().query("INSERT INTO space_categories (space_id, name, position) VALUES ($1, $2, 0) RETURNING id", [sp.guides, `Getting started ${STAMP}`])).rows[0].id;
  cat.billing = (await pool().query("INSERT INTO space_categories (space_id, name, position) VALUES ($1, $2, 1) RETURNING id", [sp.guides, `Billing ${STAMP}`])).rows[0].id;

  doc.start1 = await document({ space_id: sp.guides, category_id: cat.start, title: `Exporting reports ${WORD}`, position: 1 });
  doc.start2 = await document({ space_id: sp.guides, category_id: cat.start, title: `Inviting people ${WORD}`, position: 2 });
  doc.start3 = await document({ space_id: sp.guides, category_id: cat.start, title: `Changing your password ${WORD}`, position: 3 });
  doc.start4 = await document({ space_id: sp.guides, category_id: cat.start, title: `Dark mode ${WORD}`, position: 4 });
  doc.billing = await document({ space_id: sp.guides, category_id: cat.billing, title: `Paying an invoice ${WORD}` });
  doc.release = await document({ space_id: sp.release, title: `Release 4.2 ${WORD}` });
  doc.draft = await document({ space_id: sp.guides, category_id: cat.start, title: `Secret draft ${WORD}`, status: "draft" });
  doc.trashed = await document({ space_id: sp.guides, title: `Trashed ${WORD}`, deleted_at: new Date() });
  doc.handbookOnly = await document({ space_id: sp.guides, title: `Handbook only ${WORD}`, find_mode: "handbook_only" });
  doc.ack = await document({ space_id: sp.guides, title: `Confirm this policy ${WORD}`, type: "policy", ack_required: 1 });
  doc.inPrivate = await document({ space_id: sp.priv, title: `Salaries ${WORD}` });
  doc.taggedOther = await document({ space_id: sp.tagged, title: `Tagged FAQ ${WORD}`, tags: "public" });
  // Review M1: an internal space nobody chose, whose one public document (tagged) sits in a folder.
  sp.secret = (await fixtureQuery("INSERT INTO spaces (slug, name, visibility, description) VALUES ($1, $2, 'internal', 'Layoffs plan') RETURNING id", [`${STAMP}-restructuring`, SECRET_SPACE])).rows[0].id as number;
  spaceIds.push(sp.secret);
  cat.secretFolder = (await pool().query("INSERT INTO space_categories (space_id, name, position) VALUES ($1, $2, 0) RETURNING id", [sp.secret, `Org charts ${STAMP}`])).rows[0].id;
  doc.taggedInFolder = await document({ space_id: sp.secret, category_id: cat.secretFolder, title: `Who to call ${WORD}`, tags: "public" });

  // Every restricted document is the most viewed and the newest: the rule must still keep it out.
  const future = new Date(Date.now() + 86_400_000);
  for (const id of [doc.draft, doc.trashed, doc.handbookOnly, doc.ack, doc.inPrivate]) {
    await views(id, 1000);
    await pool().query("UPDATE documents SET updated_at = $2 WHERE id = $1", [id, future]);
  }
  await views(doc.start3, 50);
  await views(doc.start2, 20, 3);
  await views(doc.start2, 15, 10);
  await views(doc.billing, 30);
  await views(doc.release, 7, 200); // outside the 90-day window: not popular
  await views(doc.taggedInFolder, 25);
  // Recently updated: a known order among this file's documents.
  const t0 = Date.now();
  for (const [i, id] of [doc.start1, doc.start2, doc.start3, doc.start4, doc.billing, doc.release].entries()) {
    await pool().query("UPDATE documents SET updated_at = $2 WHERE id = $1", [id, new Date(t0 - (10 - i) * 60_000)]);
  }

  fx.team = (await pool().query("INSERT INTO hd_teams (name, position) VALUES ($1, 999) RETURNING id", [`Home team ${STAMP}`])).rows[0].id;
  fx.dept = (await pool().query("INSERT INTO hd_desk_departments (name, position) VALUES ($1, 99) RETURNING id", [`Home dept ${STAMP}`])).rows[0].id;
  rt.second = await requestType(`Password reset ${WORD}`, 20, { icon: "key-round" });
  rt.first = await requestType(`New laptop ${WORD}`, 10, { icon: "laptop", description: `Order a laptop for ${WORD} work` });
  rt.inactive = await requestType(`Retired request ${WORD}`, 1, { active: 0 });
  rt.groups = await requestType(`Groups only ${WORD}`, 2, { visibility: "groups" });
  rt.person = await requestType(`Needs a person ${WORD}`, 3, { form: JSON.stringify([{ key: "who", label: "Who", type: "user", required: true }]) });
  rt.dept = await requestType(`Department request ${WORD}`, 30, { desk_department_id: fx.dept });
  rt.extra = await requestType(`Something else ${WORD}`, 40);

  const r = await fixtureQuery(`INSERT INTO users (username, name, email, role, status) VALUES ($1, 'Ada Admin', $2, 'viewer', 'active') RETURNING id`, [`${STAMP}-admin`, `admin@${STAMP}.corp.test`]);
  admin = { id: r.rows[0].id, session: newToken() };
  userIds.push(admin.id);
  await createSession(admin.session, admin.id, new Date(Date.now() + 3_600_000).toISOString());
  await fixtureQuery(`INSERT INTO role_assignments (role_id, user_id, scope_type, space_id) SELECT r.id, $1, 'global', NULL FROM roles r WHERE r.key = 'helpdesk-agent'`, [admin.id]);
  await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT (user_id) DO UPDATE SET role = 'admin'", [admin.id]);
});

after(async () => {
  await pool().query("DELETE FROM hd_hc_article_views WHERE document_id = ANY($1)", [Object.values(doc)]);
  await pool().query("DELETE FROM hd_hc_searches WHERE q LIKE $1", [`%${WORD}%`]);
  await pool().query("DELETE FROM hd_request_types WHERE id = ANY($1)", [typeIds]);
  if (fx.team) await pool().query("DELETE FROM hd_teams WHERE id = $1", [fx.team]);
  if (fx.dept) await pool().query("DELETE FROM hd_desk_departments WHERE id = $1", [fx.dept]);
  await fixtureQuery("DELETE FROM documents WHERE space_id = ANY($1)", [spaceIds]);
  await pool().query("DELETE FROM spaces WHERE id = ANY($1)", [spaceIds]);
  await pool().query("DELETE FROM audit_log WHERE actor_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM sessions WHERE user_id = ANY($1)", [userIds]);
  await pool().query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [userIds]);
  await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await pool().end();
});

// --- The home's sections, through the one rule ---------------------------------------------

describe("the home's sections (helpCentreHome)", () => {
  test("Popular articles: opened ones only, most opened first in the last 90 days, never a restricted one", async () => {
    const home = await hc.helpCentreHome(ctx());
    const popular = mine(home.popular.map((a) => a.id));
    assert.deepEqual(popular, [doc.start3, doc.start2, doc.billing], "50, then 35 over two days, then 30; release's views are older than 90 days");
    for (const id of NEVER()) assert.ok(!home.popular.some((a) => a.id === id), `never popular: ${id}`);
    assert.equal(home.popular.find((a) => a.id === doc.start3)?.space, `Customer guides ${STAMP}`, "a row says its space");
    assert.deepEqual(Object.keys(home.popular[0]).sort(), ["category", "href", "id", "space", "summary", "title"], "an allowlist: no view count, author or tags travel");
  });

  test("Recently updated: newest first, never a restricted one (even the newest)", async () => {
    const home = await hc.helpCentreHome(ctx());
    const recent = mine(home.recent.map((a) => a.id));
    assert.deepEqual(recent.slice(0, 6), [doc.release, doc.billing, doc.start4, doc.start3, doc.start2, doc.start1].slice(0, recent.length));
    for (const id of NEVER()) assert.ok(!home.recent.some((a) => a.id === id), `never recent: ${id}`);
    assert.ok(home.recent.length <= hc.HC_LIMITS.home);
  });

  test("space cards: public spaces only, true counts, top three by views, description only for a chosen space", async () => {
    const home = await hc.helpCentreHome(ctx({ tagged: true }));
    const guides = home.spaces.find((x) => x.id === sp.guides);
    assert.ok(guides, "the chosen space has a card");
    assert.equal(guides!.count, 5, "four in Getting started and one in Billing; the restricted ones are not counted");
    assert.deepEqual(guides!.top.map((a) => a.id), [doc.start3, doc.start2, doc.billing]);
    assert.equal(guides!.description, "How to use the product, step by step.");
    assert.ok(!home.spaces.some((x) => x.id === sp.priv), "never a private space, even when chosen");
    const tagged = home.spaces.find((x) => x.id === sp.tagged);
    assert.ok(tagged, "a space reached through a document tagged public has a card");
    assert.equal(tagged!.description, "", "but only its name: it was never published as a whole");
    assert.ok(!JSON.stringify(home).includes("do not share"));
    assert.ok(!JSON.stringify(home).includes("Payroll"));
    for (const x of home.spaces) for (const id of NEVER()) assert.ok(!x.top.some((a) => a.id === id));
    // With Spaces on, only the categories of spaces without a card are listed (More topics, review L3).
    assert.ok(!home.categories.some((c) => [`c${cat.start}`, `c${cat.billing}`, `s${sp.tagged}`].includes(c.key)), "a carded space's categories are not repeated");
    assert.deepEqual(home.categories.map((c) => c.key).filter((k) => k === `c${cat.secretFolder}`), [`c${cat.secretFolder}`]);
  });

  test("a category switched off takes its articles out of every section", async () => {
    const home = await hc.helpCentreHome(ctx({ hidden: [`c${cat.start}`] }));
    for (const id of [doc.start1, doc.start2, doc.start3, doc.start4]) {
      assert.ok(!home.popular.some((a) => a.id === id) && !home.recent.some((a) => a.id === id), `hidden: ${id}`);
    }
    assert.equal(home.spaces.find((x) => x.id === sp.guides)?.count, 1);
  });

  test("each switch: a section off is empty; Spaces off lists the categories instead", async () => {
    const off = await hc.helpCentreHome(ctx({ show_popular: false, show_recent: false, show_spaces: false }));
    assert.deepEqual([off.popular, off.recent, off.spaces], [[], [], []]);
    assert.ok(off.categories.some((c) => c.key === `c${cat.start}` && c.count === 4), "the categories, with their true counts");
    assert.ok(off.total >= 6);
  });

  test("the Help Center off, the portal off or no license: nothing", async () => {
    for (const c of [ctx({ enabled: false }), { hc: settings(), portal: portal.cleanPortalSettings({ enabled: false }) }]) {
      assert.deepEqual(await hc.helpCentreHome(c), { popular: [], recent: [], spaces: [], categories: [], total: 0 });
    }
    edition.features = [];
    try {
      assert.equal((await hc.helpCentreHome(ctx())).total, 0);
    } finally {
      edition.features = ["helpdesk"];
    }
  });

  test("review M1: a tagged document in a folder of a space nobody chose never names that space", async () => {
    const home = await hc.helpCentreHome(ctx({ tagged: true }));
    const row = home.popular.find((a) => a.id === doc.taggedInFolder);
    assert.ok(row, "it is public and popular");
    assert.equal(row!.space, `Org charts ${STAMP}`, "labeled with its folder, as before 1.20.37");
    assert.ok(!home.spaces.some((x) => x.id === sp.secret), "no card for it");
    assert.ok(home.categories.some((c) => c.key === `c${cat.secretFolder}`), "its folder is listed under More topics instead");
    const json = JSON.stringify(home);
    assert.ok(!json.includes("Restructuring") && !json.includes("Layoffs"), "neither its name nor its description");
    const found = await hc.searchHelpCentre(`call ${WORD}`, { record: false }, ctx({ tagged: true }));
    assert.equal(found.find((a) => a.id === doc.taggedInFolder)?.space, `Org charts ${STAMP}`);
    assert.ok(!JSON.stringify(found).includes("Restructuring"));
    assert.equal(await hc.helpCentreSpace(sp.secret, ctx({ tagged: true })), null, "and no page");
  });

  test("review M1: a chosen space whose unfiled category is hidden is not named either", async () => {
    const over = { hidden: [`s${sp.guides}`] };
    const home = await hc.helpCentreHome(ctx(over));
    assert.ok(!home.spaces.some((x) => x.id === sp.guides), "no card");
    assert.equal(home.popular.find((a) => a.id === doc.start3)?.space, `Getting started ${STAMP}`, "rows say their folder");
    assert.ok(!home.popular.concat(home.recent).some((a) => a.space === `Customer guides ${STAMP}`));
    assert.ok(home.categories.some((c) => c.key === `c${cat.start}`), "its folders are listed under More topics");
    assert.equal(await hc.helpCentreSpace(sp.guides, ctx(over)), null);
    assert.ok(await hc.helpCentreSpace(sp.guides, ctx()), "shown again once the unfiled category is");
  });

  test("review M4: the home reads the rule twice, whatever the number of spaces", async () => {
    const p = pool() as unknown as { query: (...a: unknown[]) => Promise<unknown> };
    const real = p.query.bind(p);
    const seen: string[] = [];
    p.query = (...a: unknown[]) => {
      if (typeof a[0] === "string") seen.push(a[0]);
      return real(...a);
    };
    try {
      await hc.helpCentreHome(ctx({ tagged: true }));
    } finally {
      p.query = real;
    }
    const rule = seen.filter((q) => q.includes("FROM documents d"));
    assert.equal(rule.length, 2, `rule queries: ${rule.length}`);
    assert.ok(seen.length <= 4, `queries in all: ${seen.length}`);
  });

  test("a space's page: by category in the admin's order; null for a private, unknown or empty space", async () => {
    const page = await hc.helpCentreSpace(sp.guides, ctx({ order: [`c${cat.billing}`, `c${cat.start}`] }));
    assert.ok(page);
    assert.deepEqual(page!.categories.map((c) => c.key), [`c${cat.billing}`, `c${cat.start}`]);
    assert.equal(page!.total, 5);
    assert.ok(!page!.categories.flatMap((c) => c.articles).some((a) => NEVER().includes(a.id)));
    assert.equal(await hc.helpCentreSpace(sp.priv, ctx()), null);
    assert.equal(await hc.helpCentreSpace(2_000_000_000, ctx()), null);
    assert.equal(await hc.helpCentreSpace(sp.tagged, ctx()), null, "not chosen and nothing tagged in scope");
    assert.equal((await hc.helpCentreSpace(sp.tagged, ctx({ tagged: true })))?.description, "");
    assert.equal(hc.spaceIdFrom("12"), 12);
    assert.equal(hc.spaceIdFrom("012"), null);
    assert.equal(hc.spaceIdFrom("12a"), null);
  });
});

// --- The view counter -----------------------------------------------------------------------

describe("the view counter (countArticleView)", () => {
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
  const at = async (id: number) => Number((await pool().query("SELECT coalesce(sum(views), 0) AS n FROM hd_hc_article_views WHERE document_id = $1 AND day = current_date", [id])).rows[0].n);

  test("a browser counts once per address and article in 30 minutes; bots and prefetches never", async () => {
    const id = doc.start4;
    const before = await at(id);
    assert.equal(await hc.countArticleView(id, { headers: new Headers({ "user-agent": ua }), ip: "203.0.113.41" }), true);
    assert.equal(await hc.countArticleView(id, { headers: new Headers({ "user-agent": ua }), ip: "203.0.113.41" }), false, "a reload does not count again");
    assert.equal(await hc.countArticleView(id, { headers: new Headers({ "user-agent": ua }), ip: "203.0.113.42" }), true, "another address does");
    for (const bot of ["Googlebot/2.1 (+http://www.google.com/bot.html)", "Slackbot-LinkExpanding 1.0", "curl/8.5.0", "python-requests/2.31", ""]) {
      assert.equal(await hc.countArticleView(id, { headers: new Headers({ "user-agent": bot }), ip: "203.0.113.43" }), false, `bot: ${bot}`);
    }
    for (const h of [{ "next-router-prefetch": "1" }, { purpose: "prefetch" }, { "sec-purpose": "prefetch;prerender" }] as Record<string, string>[]) {
      assert.equal(await hc.countArticleView(id, { headers: new Headers({ "user-agent": ua, ...h }), ip: "203.0.113.44" }), false, JSON.stringify(h));
    }
    assert.equal(await at(id), before + 2);
  });

  test("review M3: the counter's memory has a hard cap, and an address counts at most 20 articles a window", () => {
    const d = new hc.ViewDedupe({ maxKeys: 5, perAddress: 3, windowMs: 1000 });
    assert.equal(d.allow("a", 1, 0), true);
    assert.equal(d.allow("a", 1, 10), false, "the same article again");
    assert.equal(d.allow("a", 2, 10), true);
    assert.equal(d.allow("a", 3, 10), true);
    assert.equal(d.allow("a", 4, 10), false, "past the per-address cap");
    assert.equal(d.allow("b", 1, 20), true);
    assert.equal(d.allow("c", 1, 20), true);
    assert.equal(d.allow("e", 1, 20), false, "full: a new key is not counted");
    assert.deepEqual(d.size(), { keys: 5, addresses: 3 });
    assert.equal(d.allow("e", 1, 1005), true, "the oldest expired entry goes cheaply, and a new key fits again");
    assert.deepEqual(d.size(), { keys: 5, addresses: 3 }, "a's window is over: e takes its place");
    assert.equal(d.allow("a", 1, 1005), false, "full again");
    assert.equal(d.allow("a", 1, 2100), true, "everything expired: a new window");
    assert.deepEqual(d.size(), { keys: 1, addresses: 1 });
  });

  test("review L2/L1: no usable address counts nothing; the proxy marks the router's prefetch and drops a forged mark", async () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
    assert.equal(await hc.countArticleView(doc.start1, { headers: new Headers({ "user-agent": ua }), ip: null }), false);
    assert.equal(await hc.countArticleView(doc.start1, { headers: new Headers({ "user-agent": ua }), ip: "unknown" }), false);
    assert.equal(await hc.countArticleView(doc.start1, { headers: new Headers({ "user-agent": ua, "x-compass-prefetch": "1" }), ip: "203.0.113.70" }), false);
    const run = (headers: Record<string, string>) => proxyMod.proxy(new NextRequest(`${ORIGIN}/support/articles/1-x`, { headers })).headers;
    assert.equal(run({ "next-router-prefetch": "1" }).get("x-middleware-request-x-compass-prefetch"), "1");
    assert.equal(run({ "x-compass-prefetch": "1" }).get("x-middleware-request-x-compass-prefetch"), null, "a client's own is dropped");
    assert.equal(run({}).get("x-middleware-request-x-compass-prefetch"), null);
  });

  test("it stores a number per article per day and nothing about who", async () => {
    const cols = (await pool().query("SELECT column_name FROM information_schema.columns WHERE table_name = 'hd_hc_article_views' ORDER BY column_name")).rows.map((r) => r.column_name);
    assert.deepEqual(cols, ["day", "document_id", "views"]);
    assert.equal(hc.isBotAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"), false);
  });
});

// --- Settings ---------------------------------------------------------------------------------

describe("the home's settings", () => {
  test("a value stored before 1.20.37 has every section on; the greeting is one clean line", () => {
    const old = hc.cleanHelpCentreSettings({ enabled: true, spaces: [1] });
    assert.deepEqual([old.show_popular, old.show_recent, old.show_spaces, old.show_tiles, old.greeting], [true, true, true, true, ""]);
    const s = hc.cleanHelpCentreSettings({ show_popular: false, show_tiles: "no", greeting: "  Hi there,\n\tneed   a hand?  " + "x".repeat(200) });
    assert.equal(s.show_popular, false);
    assert.equal(s.show_tiles, true, "only false switches a section off");
    assert.ok(s.greeting.startsWith("Hi there, need a hand? x"));
    assert.equal(s.greeting.length, hc.HC_LIMITS.greeting);
    assert.equal(hc.helpGreeting(hc.cleanHelpCentreSettings({})), "How can we help?");
    assert.equal(hc.helpGreeting(hc.cleanHelpCentreSettings({ greeting: "Hi, Acme customers" })), "Hi, Acme customers");
  });

  test("signing in keeps a tile's chosen type, and nothing else in a query", () => {
    assert.equal(portal.cleanNextPath("/support/new?type=12"), "/support/new?type=12");
    for (const bad of ["/support/new?type=0", "/support/new?type=1&x=2", "/support/requests?type=1", "/support/new?next=//evil", "/support/new?type=12#x"]) {
      assert.equal(portal.cleanNextPath(bad), "", bad);
    }
    assert.equal(portal.cleanNextPath("/support/requests/12"), "/support/requests/12");
  });

  test("request types match by word prefix, titles first, in the given order", () => {
    const types = [
      { id: 1, title: "New laptop", description: "Order a machine" },
      { id: 2, title: "Password reset", description: "Locked out of your laptop" },
      { id: 3, title: "Printer", description: "" },
    ];
    assert.deepEqual(hc.matchRequestTypes(types, "lap", 5).map((t) => t.id), [1, 2]);
    assert.deepEqual(hc.matchRequestTypes(types, "pass res", 5).map((t) => t.id), [2]);
    assert.deepEqual(hc.matchRequestTypes(types, "lap", 1).map((t) => t.id), [1]);
    assert.deepEqual(hc.matchRequestTypes(types, "l", 5), [], "two characters at least");
    assert.deepEqual(hc.matchRequestTypes(types, "zzz", 5), []);
  });
});

// --- Routes and the page (the workspace's portal keys, under the lock) ---------------------------

describe("routes and the home page", () => {
  before(async () => {
    lockClient = await pool().connect();
    await lockClient.query("SELECT pg_advisory_lock($1)", [LOCK]);
    savedPortal = await getSetting(portal.HD_PORTAL_SETTINGS_KEY);
    savedHc = await getSetting(hc.HD_HELP_CENTRE_SETTINGS_KEY);
    await setSetting(portal.HD_PORTAL_SETTINGS_KEY, JSON.stringify(portalWith(Object.values(rt))));
    await setSetting(hc.HD_HELP_CENTRE_SETTINGS_KEY, JSON.stringify(settings()));
  });

  after(async () => {
    for (const [key, saved] of [
      [portal.HD_PORTAL_SETTINGS_KEY, savedPortal],
      [hc.HD_HELP_CENTRE_SETTINGS_KEY, savedHc],
    ] as const) {
      if (saved === undefined) await pool().query("DELETE FROM settings WHERE key = $1", [key]);
      else await setSetting(key, saved);
    }
    await lockClient.query("SELECT pg_advisory_unlock($1)", [LOCK]);
    lockClient.release();
  });

  async function home(sp: Record<string, string> = {}): Promise<any> {
    currentRequest = makeRequest("/support");
    try {
      const el = (await homePage.default({ searchParams: Promise.resolve(sp) })) as { props: any };
      return el.props;
    } finally {
      currentRequest = null;
    }
  }

  test("tiles: what the portal offers, in its configured order; never inactive, group-only or directory-bound; a desk department never filters", async () => {
    const p = await home();
    const ids = p.tiles.map((t: { id: number }) => t.id);
    assert.deepEqual(ids, [rt.first, rt.second, rt.dept, rt.extra], "position order: 10, 20, 30, 40");
    assert.equal(p.moreTiles, false);
    assert.equal(p.canRaise, true);
    assert.deepEqual(Object.keys(p.tiles[0]).sort(), ["description", "icon", "id", "title"], "a tile carries no team, form or workflow");
    assert.equal(p.greeting, "How can we help?");
    assert.equal(p.brand.logoUrl, null, "no logo: the initials (the brand's own source, unchanged)");
  });

  test("tiles: at most eight, then More; none with the switch off or nothing to raise", async () => {
    const many: number[] = [];
    for (let i = 0; i < 7; i++) many.push(await requestType(`Bulk type ${i} ${WORD}`, 100 + i));
    await setSetting(portal.HD_PORTAL_SETTINGS_KEY, JSON.stringify(portalWith([...Object.values(rt), ...many])));
    try {
      const p = await home();
      assert.equal(p.tiles.length, 8);
      assert.equal(p.moreTiles, true);
      await setSetting(hc.HD_HELP_CENTRE_SETTINGS_KEY, JSON.stringify(settings({ show_tiles: false, greeting: "Hello, Acme" })));
      const off = await home();
      assert.deepEqual(off.tiles, []);
      assert.equal(off.greeting, "Hello, Acme");
      await setSetting(portal.HD_PORTAL_SETTINGS_KEY, JSON.stringify(portalWith([rt.inactive, rt.groups])));
      await setSetting(hc.HD_HELP_CENTRE_SETTINGS_KEY, JSON.stringify(settings()));
      const none = await home();
      assert.equal(none.canRaise, false, "only blocked types: nothing to raise");
    } finally {
      await setSetting(portal.HD_PORTAL_SETTINGS_KEY, JSON.stringify(portalWith(Object.values(rt))));
      await setSetting(hc.HD_HELP_CENTRE_SETTINGS_KEY, JSON.stringify(settings()));
    }
  });

  test("the page's sections are the rule's: no restricted title reaches a signed-out visitor", async () => {
    const p = await home();
    const json = JSON.stringify(p);
    for (const secret of [`Secret draft ${WORD}`, `Trashed ${WORD}`, `Handbook only ${WORD}`, `Confirm this policy ${WORD}`, `Salaries ${WORD}`, "Payroll"]) {
      assert.ok(!json.includes(secret), `never on the home: ${secret}`);
    }
  });

  test("suggestions: request types and articles, six at most, nothing restricted, nothing blocked", async () => {
    const r = await call(searchRoute.GET, `/support/api/help/search?q=${WORD}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.types.length <= hc.HC_LIMITS.suggestTypes);
    assert.ok(r.body.articles.length + r.body.types.length <= 6);
    const typeIdsSeen = r.body.types.map((t: { id: number }) => t.id);
    assert.deepEqual(typeIdsSeen, [rt.first, rt.second], "the first two offered, in order");
    assert.deepEqual(Object.keys(r.body.types[0]).sort(), ["href", "icon", "id", "title"]);
    assert.equal(r.body.types[0].href, `/support/new?type=${rt.first}`);
    const blocked = await call(searchRoute.GET, `/support/api/help/search?q=${encodeURIComponent(`groups ${WORD}`)}`);
    assert.deepEqual(blocked.body.types, [], "a group-only type is never suggested");
    const retired = await call(searchRoute.GET, `/support/api/help/search?q=${encodeURIComponent(`retired ${WORD}`)}`);
    assert.deepEqual(retired.body.types, [], "an inactive type is never suggested");
    const secret = await call(searchRoute.GET, `/support/api/help/search?q=${encodeURIComponent(`secret ${WORD}`)}`);
    assert.ok(!secret.body.articles.some((a: { id: number }) => NEVER().includes(a.id)));
    const salaries = await call(searchRoute.GET, `/support/api/help/search?q=${encodeURIComponent(`salaries ${WORD}`)}`);
    assert.ok(!JSON.stringify(salaries.body).includes("Salaries"));
    const article = r.body.articles[0];
    assert.equal(typeof article.space, "string", "an article says its space");
    const form = await call(searchRoute.GET, `/support/api/help/search?q=${WORD}&src=form`);
    assert.deepEqual(form.body.types, [], "the request form's suggestions are articles only");
  });

  test("suggestions: the portal's rate limit (40 a minute per address), and 404 while off", async () => {
    const ip = `192.0.2.${Math.floor(Math.random() * 200) + 20}`;
    let last = 0;
    let body: any = null;
    for (let i = 0; i < 41; i++) ({ status: last, body } = await call(searchRoute.GET, `/support/api/help/search?q=ab${i}`, { ip }));
    assert.equal(last, 429);
    assert.equal(body.limited, true);
    assert.ok(!("types" in body) && !("articles" in body), "a limited answer carries nothing");
    await setSetting(hc.HD_HELP_CENTRE_SETTINGS_KEY, JSON.stringify(settings({ enabled: false })));
    try {
      assert.equal((await call(searchRoute.GET, `/support/api/help/search?q=${WORD}`)).status, 404);
    } finally {
      await setSetting(hc.HD_HELP_CENTRE_SETTINGS_KEY, JSON.stringify(settings()));
    }
  });

  test("review M2: on a portal for some domains, tiles and type suggestions only for a signed-in contact it admits", async () => {
    const domains = portal.cleanPortalSettings({ enabled: true, access: "domains", domains: ["clientco.example"], types: Object.values(rt).map((id) => ({ id, team_id: null })) });
    await setSetting(portal.HD_PORTAL_SETTINGS_KEY, JSON.stringify(domains));
    const contact = (await pool().query("INSERT INTO hd_portal_contacts (email) VALUES ($1) RETURNING id", [`riley.${STAMP}@clientco.example`])).rows[0].id as number;
    const token = randomBytes(32).toString("hex");
    await pool().query("INSERT INTO hd_portal_sessions (contact_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [contact, createHash("sha256").update(token, "utf8").digest("hex")]);
    const cookie = `compass_portal=${token}`;
    const homeAs = async (c?: string) => {
      currentRequest = makeRequest("/support", { cookie: c });
      try {
        return ((await homePage.default({ searchParams: Promise.resolve({}) })) as { props: any }).props;
      } finally {
        currentRequest = null;
      }
    };
    try {
      const out = await homeAs();
      assert.deepEqual(out.tiles, [], "signed out: no catalog");
      assert.ok(!JSON.stringify(out).includes(`Password reset ${WORD}`));
      assert.deepEqual((await call(searchRoute.GET, `/support/api/help/search?q=${WORD}`)).body.types, []);
      const inside = await homeAs(cookie);
      assert.equal(inside.tiles.length, 4, "a signed-in contact the rule admits sees them");
      assert.equal((await call(searchRoute.GET, `/support/api/help/search?q=${WORD}`, { cookie })).body.types.length, 2);
      await setSetting(hc.HD_HELP_CENTRE_SETTINGS_KEY, JSON.stringify(settings({ show_tiles: false })));
      assert.deepEqual((await call(searchRoute.GET, `/support/api/help/search?q=${WORD}`, { cookie })).body.types, [], "Request tiles off: no type suggestions either");
    } finally {
      await setSetting(hc.HD_HELP_CENTRE_SETTINGS_KEY, JSON.stringify(settings()));
      await setSetting(portal.HD_PORTAL_SETTINGS_KEY, JSON.stringify(portalWith(Object.values(rt))));
      await pool().query("DELETE FROM hd_portal_contacts WHERE id = $1", [contact]);
    }
  });

  test("the settings route saves the home's switches and greeting, and audits what changed", async () => {
    const as = `compass_session=${admin.session}`;
    const next = settings({ spaces: [sp.guides, sp.release], show_popular: false, show_spaces: false, greeting: "Welcome to Acme support" });
    const ok = await call(adminRoute.PUT, "/api/helpdesk/admin/portal/help-centre", { method: "PUT", origin: ORIGIN, cookie: as, json: next });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.settings, next);
    const audit = (await pool().query("SELECT details FROM audit_log WHERE actor_id = $1 AND action = 'helpdesk.portal.help_centre_updated' ORDER BY id DESC LIMIT 1", [admin.id])).rows[0];
    assert.ok(audit, "audited");
    assert.ok(audit.details.changed.includes("show_popular") && audit.details.changed.includes("show_spaces") && audit.details.changed.includes("greeting"));
    assert.equal(audit.details.show_popular, false);
    assert.equal(audit.details.show_spaces, false);
    assert.equal(audit.details.greeting, "Welcome to Acme support");
    assert.ok(!("show_recent" in audit.details), "an unchanged switch is not listed");
    const p = await home();
    assert.deepEqual(p.popular, [], "the stored switch drives the page");
    assert.deepEqual(p.spaces, []);
    assert.ok(p.categories.length > 0, "Spaces off: the categories");
    assert.equal(p.greeting, "Welcome to Acme support");
    await setSetting(hc.HD_HELP_CENTRE_SETTINGS_KEY, JSON.stringify(settings()));
  });
});
