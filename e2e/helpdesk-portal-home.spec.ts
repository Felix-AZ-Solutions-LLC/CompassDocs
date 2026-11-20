import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, api, login } from "./helpers";

// The Help Center's richer home (1.20.37): a branded header band (the
// portal's own logo, its name, the admin's greeting and the big search),
// then "What do you need?" (request tiles that open their form), Popular
// articles, Recently updated and a card per space; search suggestions as
// you type, driven by the keyboard (a combobox); a section switched off in
// Desk settings → Customer portal → Help Center disappears; the words are
// US English ("Help Center").
//
// The portal and Help Center settings are workspace keys: written under
// advisory lock 728661 (shared with the portal's unit tests and specs) and
// restored afterwards. Every document, space, team, request type and view
// count is this spec's own. Licensed rig only (the helpdesk is
// Enterprise): skipped elsewhere.

const stamp = `${Date.now()}`;
// A searchable word only this spec's documents and types hold (letters only).
const W = `ph${stamp.replace(/\d/g, (d) => "abcdefghij"[Number(d)])}`;
const LOCK = 728661;
// A one-pixel PNG, as the portal's logo route stores it (lib/uploads).
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f80f0000010101006e2a8b2f0000000049454e44ae426082", "hex");

async function licensed(page: Page): Promise<boolean> {
  const r = await api(page, "/api/helpdesk/admin/settings");
  return r.status !== 402;
}

test.describe("portal Help Center home (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  let db: Client;
  const saved = new Map<string, string | null>();
  const ids = { space: 0, cat: 0, team: 0, typeA: 0, typeB: 0, popular: 0, older: 0, newest: 0, draft: 0 };

  test.beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5599/compass_e2e" });
    await db.connect();
    await db.query("SELECT pg_advisory_lock($1)", [LOCK]);
  });

  test.afterAll(async () => {
    for (const [k, v] of saved) {
      if (v === null) await db.query("DELETE FROM settings WHERE key = $1", [k]);
      else await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [k, v]);
    }
    if (ids.typeA || ids.typeB) await db.query("DELETE FROM hd_request_types WHERE id = ANY($1)", [[ids.typeA, ids.typeB]]);
    if (ids.team) await db.query("DELETE FROM hd_teams WHERE id = $1", [ids.team]);
    if (ids.space) {
      await db.query("DELETE FROM documents WHERE space_id = $1", [ids.space]);
      await db.query("DELETE FROM spaces WHERE id = $1", [ids.space]);
    }
    await db.query("DELETE FROM hd_hc_searches WHERE q LIKE $1", [`%${W}%`]);
    await db.query("SELECT pg_advisory_unlock($1)", [LOCK]);
    await db.end();
  });

  async function setSetting(key: string, value: string) {
    if (!saved.has(key)) {
      const r = await db.query("SELECT value FROM settings WHERE key = $1", [key]);
      saved.set(key, r.rows[0]?.value ?? null);
    }
    await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, value]);
  }

  async function seed(page: Page) {
    ids.space = (await db.query("INSERT INTO spaces (slug, name, visibility, description) VALUES ($1, $2, 'internal', $3) RETURNING id", [`ph-e2e-${stamp}`, `Customer guides ${W}`, "How to use the product, step by step."])).rows[0].id;
    ids.cat = (await db.query("INSERT INTO space_categories (space_id, name, position) VALUES ($1, $2, 0) RETURNING id", [ids.space, `Getting started ${W}`])).rows[0].id;
    const doc = async (title: string, status = "published") =>
      (await db.query("INSERT INTO documents (space_id, category_id, title, slug, status, content) VALUES ($1, $2, $3, $4, $5, 'Body.') RETURNING id", [ids.space, ids.cat, title, `ph-${stamp}-${Math.random().toString(36).slice(2, 7)}`, status])).rows[0].id as number;
    ids.popular = await doc(`Connecting to the VPN ${W}`);
    ids.older = await doc(`Exporting reports ${W}`);
    ids.newest = await doc(`What changed in 4.2 ${W}`);
    ids.draft = await doc(`Secret draft ${W}`, "draft");
    await db.query("UPDATE documents SET updated_at = now() - interval '3 days' WHERE id = $1", [ids.older]);
    await db.query("UPDATE documents SET updated_at = now() + interval '1 hour' WHERE id = ANY($1)", [[ids.newest, ids.draft]]);
    await db.query("INSERT INTO hd_hc_article_views (document_id, day, views) VALUES ($1, current_date, 40), ($2, current_date, 500)", [ids.popular, ids.draft]);
    ids.team = (await db.query("INSERT INTO hd_teams (name, position) VALUES ($1, 999) RETURNING id", [`Portal home E2E ${stamp}`])).rows[0].id;
    const type = async (title: string, position: number, icon: string) =>
      (await db.query("INSERT INTO hd_request_types (slug, title, description, icon, team_id, form, position) VALUES ($1, $2, $3, $4, $5, '[]', $6) RETURNING id", [`ph-e2e-${stamp}-${position}`, title, `${title}, in a few words.`, icon, ids.team, position])).rows[0].id as number;
    ids.typeA = await type(`Order a laptop ${W}`, 990, "laptop");
    ids.typeB = await type(`Reset a password ${W}`, 991, "key-round");
    await setSetting(
      "helpdesk_portal",
      JSON.stringify({
        enabled: true,
        types: [
          { id: ids.typeA, team_id: null },
          { id: ids.typeB, team_id: null },
        ],
        access: "anyone",
        domains: [],
        brand_name: `Acme Support ${W}`,
        brand_logo: "",
        limits: {},
        blocked_words: [],
        blocked_domains: [],
      })
    );
    await setSetting("helpdesk_portal_hc", JSON.stringify({ enabled: true, from_spaces: true, spaces: [ids.space], tagged: false, order: [], hidden: [], indexing: false, greeting: `Hi there, how can we help ${W}?` }));
    // The portal's own logo, uploaded as Desk settings → Customer portal → Brand does (the source the band shares with the header).
    const up = await page.request.post("/api/helpdesk/admin/portal/logo", {
      multipart: { file: { name: "logo.png", mimeType: "image/png", buffer: PNG } },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(up.status(), await up.text()).toBe(200);
  }

  test("the band, the sections, a tile, suggestions by keyboard, a section switched off, US English", async ({ page, browser }) => {
    test.setTimeout(600_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");
    await seed(page);

    for (const p of ["/support", `/support/spaces/${ids.space}`, "/support/new", `/support/api/help/search?q=${W}`, "/support/api/logo"]) {
      await page.request.get(p, { timeout: 180_000, maxRedirects: 0 }).catch(() => null);
    }

    const ctx = await browser.newContext();
    const cust = await ctx.newPage();
    await cust.goto("/support");
    await expect(cust).toHaveTitle(/Help Center/);

    // The header band: the portal's own logo (or its initials), its name, the greeting, the big search.
    const band = cust.locator('[data-help-section="band"]');
    await expect(band.getByRole("heading", { level: 1, name: `Hi there, how can we help ${W}?` })).toBeVisible();
    await expect(band.getByTestId("hc-band-name")).toHaveText(`Acme Support ${W}`);
    // The custom logo still shows, in the header and in the band, from the one source.
    const logoSrc = await cust.locator("header img").getAttribute("src");
    expect(logoSrc).toMatch(/^\/support\/api\/logo\?v=/);
    await expect(band.getByTestId("portal-logo")).toHaveAttribute("src", logoSrc!);
    expect((await cust.request.get(logoSrc!)).status()).toBe(200);
    await expect(cust.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Help Center" })).toBeVisible();

    // Popular: opened articles only, never the draft (however often opened).
    const popular = cust.locator('[data-help-section="popular"]');
    await expect(popular.getByRole("heading", { name: "Popular articles" })).toBeVisible();
    await expect(popular.getByRole("link", { name: new RegExp(`Connecting to the VPN ${W}`) })).toBeVisible();
    await expect(popular.getByText(`Secret draft ${W}`)).toHaveCount(0);

    // Recently updated: newest first, never the draft.
    const recent = cust.locator('[data-help-section="recent"]');
    await expect(recent.getByRole("link").first()).toContainText(`What changed in 4.2 ${W}`);
    await expect(recent.getByText(`Secret draft ${W}`)).toHaveCount(0);

    // A card per space: description, true count, top articles and See all.
    const card = cust.locator(`[data-help-space="${ids.space}"]`);
    await expect(card).toContainText("How to use the product, step by step.");
    await expect(card).toContainText("3 articles");
    await expect(card.getByRole("link", { name: new RegExp(`Connecting to the VPN ${W}`) })).toBeVisible();
    await card.getByRole("link", { name: /See all/ }).click();
    await expect(cust.getByRole("heading", { level: 1, name: `Customer guides ${W}` })).toBeVisible({ timeout: 60_000 });
    await expect(cust.getByText(`Secret draft ${W}`)).toHaveCount(0);

    // Suggestions by keyboard: arrows move the active option, Enter opens it, Escape closes.
    await cust.goto("/support");
    const box = cust.getByRole("combobox", { name: "Search the Help Center" });
    await box.fill(`vpn ${W}`);
    const list = cust.getByRole("listbox", { name: "Suggestions" });
    await expect(list.getByRole("option", { name: new RegExp(`Connecting to the VPN ${W}`) })).toBeVisible({ timeout: 30_000 });
    await expect(box).toHaveAttribute("aria-expanded", "true");
    await box.press("Escape");
    await expect(box).toHaveAttribute("aria-expanded", "false");
    await box.press("ArrowDown");
    await expect(list.getByRole("option").first()).toBeVisible({ timeout: 30_000 });
    await box.press("ArrowDown");
    await expect(list.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await expect(box).toHaveAttribute("aria-activedescendant", (await list.getByRole("option").first().getAttribute("id"))!);
    await box.press("Enter");
    await expect(cust.getByRole("heading", { level: 1, name: `Connecting to the VPN ${W}` })).toBeVisible({ timeout: 60_000 });

    // A request type among the suggestions; Enter with nothing chosen opens the results page.
    await cust.goto("/support");
    await box.fill(`laptop ${W}`);
    await expect(list.getByRole("option", { name: new RegExp(`Order a laptop ${W}`) })).toBeVisible({ timeout: 30_000 });
    await box.press("Enter");
    await expect(cust).toHaveURL(/\/support\/search\?q=/, { timeout: 60_000 });

    // A tile opens its form (signed out: sign in first, then straight back to the chosen form).
    await cust.goto("/support");
    const tiles = cust.locator('[data-help-section="tiles"]');
    await expect(tiles.getByRole("heading", { name: "What do you need?" })).toBeVisible();
    await tiles.getByRole("link", { name: new RegExp(`Reset a password ${W}`) }).click();
    await expect(cust).toHaveURL(new RegExp(`next=${encodeURIComponent(`/support/new?type=${ids.typeB}`).replace(/[?]/g, "\\?")}`), { timeout: 60_000 });

    // A phone: nothing scrolls sideways.
    await cust.setViewportSize({ width: 390, height: 844 });
    await cust.goto("/support");
    await expect(band.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await cust.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // The admin switches Popular off and sets the greeting back: Popular is gone, the rest stays.
    await page.goto("/desk/settings/portal/help-centre");
    const home = page.locator("#help-center-home");
    await expect(home.getByRole("heading", { name: "Home page" })).toBeVisible({ timeout: 60_000 });
    await home.getByRole("switch", { name: "Popular articles" }).or(home.getByRole("checkbox", { name: "Popular articles" })).click();
    await home.getByLabel("Greeting").fill("");
    await page.getByRole("button", { name: "Save Help Center" }).click();
    await expect(page.getByText("Help Center saved.", { exact: false })).toBeVisible({ timeout: 30_000 });
    await cust.setViewportSize({ width: 1280, height: 900 });
    await cust.goto("/support");
    await expect(cust.locator('[data-help-section="popular"]')).toHaveCount(0);
    await expect(cust.locator('[data-help-section="recent"]')).toBeVisible();
    await expect(band.getByRole("heading", { level: 1, name: "How can we help?" })).toBeVisible();
    const audit = await db.query("SELECT details FROM audit_log WHERE action = 'helpdesk.portal.help_centre_updated' ORDER BY id DESC LIMIT 1");
    expect(audit.rows[0].details.show_popular).toBe(false);
    await ctx.close();
    // The uploaded logo goes again (the settings are restored after all).
    await page.request.delete("/api/helpdesk/admin/portal/logo", { headers: { origin: new URL(page.url()).origin } });
  });
});
