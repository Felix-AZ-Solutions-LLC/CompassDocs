import { test, expect, type Page } from "@playwright/test";
import { ADMIN, api, ensureUser, login } from "./helpers";

// Dark styles (1.20.35, lib/dark-style, STYLEGUIDE §Color and theming → Dark
// styles): Slate, Graphite and Black. A person picks one under Account →
// Preferences (or Workspace default); an admin picks the default under
// Settings → Workspace, which the portal, the help centre and sign-in pages
// always wear. The root layout renders data-dark-style on <html> on the
// server (from the compass-dark-style cookie and the workspace setting), so
// the first paint is already right.
//
// The workspace default is a shared setting: read first, restored after.
// The people are this spec's own. Dark comes from the device (Auto, the
// default theme, under emulateMedia), so it exercises "System while the OS
// is dark".

const stamp = `${Date.now()}`.slice(-7);
const CHOOSER = { username: `e2e_dark_${stamp}`, password: "E2eDarkStyle!12345" };
const FOLLOWER = { username: `e2e_darkws_${stamp}`, password: "E2eDarkStyle!12345" };

const htmlStyle = (page: Page) => page.evaluate(() => document.documentElement.getAttribute("data-dark-style"));
const bodyBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const token = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

/**
 * The portal in Graphite. Where the portal answers 200 (a build with the
 * helpdesk, the portal on) its page is graphite from the first paint. Where
 * it answers 404, Next's bare error shell carries neither the theme script
 * nor the server's attributes, so the page stays light whatever the theme
 * (as every 404 under the root layout does); the attribute still arrives.
 */
async function expectPortalGraphite(page: Page) {
  const res = await page.goto("/support");
  await expect.poll(() => htmlStyle(page)).toBe("graphite");
  if (res?.status() === 200) expect(await bodyBg(page)).toBe("rgb(16, 16, 18)");
}

/** Every value <html data-dark-style> held from the moment the element existed (the no-flash check). */
async function recordDarkStyle(page: Page) {
  await page.addInitScript(() => {
    const seen: (string | null)[] = [];
    (window as any).__darkStyleSeen = seen;
    let watching = false;
    const watch = () => {
      const html = document.documentElement;
      if (!html || watching) return;
      watching = true;
      seen.push(html.getAttribute("data-dark-style"));
      new MutationObserver(() => seen.push(html.getAttribute("data-dark-style"))).observe(html, {
        attributes: true,
        attributeFilter: ["data-dark-style"],
      });
    };
    watch();
    if (!watching) new MutationObserver(watch).observe(document, { childList: true });
  });
}

test.describe("dark styles", () => {
  test.describe.configure({ mode: "serial" });
  let savedDefault = "slate";

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    await ensureUser(page, CHOOSER, "viewer", "Dana Dark");
    await ensureUser(page, FOLLOWER, "viewer", "Wes Workspace");
    const s = await api(page, "/api/admin/settings");
    savedDefault = s.body?.dark_style ?? "slate";
    // Start from the upgrade state: Slate for everyone.
    expect((await api(page, "/api/admin/settings", { method: "PATCH", body: { dark_style: "slate" } })).status).toBe(200);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, ADMIN);
    await api(page, "/api/admin/settings", { method: "PATCH", body: { dark_style: savedDefault } });
    await page.close();
  });

  test("Slate is the default: nothing changes until someone chooses", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await login(page, FOLLOWER);
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("dark");
    expect(await htmlStyle(page)).toBe("slate");
    expect(await bodyBg(page)).toBe("rgb(9, 13, 22)");
    expect(await token(page, "--surface")).toBe("19 26 40");
  });

  test("choosing Black applies at once, survives a reload with no flash, and is in the server's HTML", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await login(page, CHOOSER);
    await page.goto("/account/preferences");
    const group = page.getByRole("radiogroup", { name: "Dark style" });
    await expect(group.getByRole("radio", { name: "Workspace default" })).toBeChecked();
    await expect(group).toContainText("Currently Slate");

    const saved = page.waitForResponse((r) => r.url().endsWith("/api/account/preferences") && r.request().method() === "PATCH");
    await group.getByRole("radio", { name: "Black" }).check();
    expect((await saved).status()).toBe(200);
    await expect.poll(() => htmlStyle(page)).toBe("black");
    expect(await bodyBg(page)).toBe("rgb(0, 0, 0)");
    // A card on the page steps up from the black page.
    const card = page.locator("[data-dark-style-option]").first();
    await expect(card).toBeVisible();
    expect(await token(page, "--surface")).toBe("13 13 14");

    // The server renders the attribute on <html>: the first paint is already black.
    const html = await (await page.request.get("/account/preferences")).text();
    expect(html).toMatch(/<html[^>]*\sdata-dark-style="black"/);
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === "compass-dark-style")?.value).toBe("black");

    // Reload: the attribute is black from the moment <html> exists, never anything else.
    await recordDarkStyle(page);
    await page.reload();
    await expect(page.getByRole("radiogroup", { name: "Dark style" }).getByRole("radio", { name: "Black" })).toBeChecked();
    const seen = await page.evaluate(() => (window as any).__darkStyleSeen as (string | null)[]);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["black"]));
    expect(await bodyBg(page)).toBe("rgb(0, 0, 0)");

    // Saved to the account: a fresh browser that signs in gets it on its first page.
    const other = await page.context().browser()!.newContext({ colorScheme: "dark" });
    const p2 = await other.newPage();
    await login(p2, CHOOSER);
    expect(await htmlStyle(p2)).toBe("black");
    const home = await (await p2.request.get("/")).text();
    expect(home).toMatch(/<html[^>]*\sdata-dark-style="black"/);
    await other.close();
  });

  test("the admin's default applies to a person on Workspace default and to the portal, and is audited", async ({ page, browser }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await login(page, ADMIN);
    await page.goto("/admin/workspace");
    const group = page.getByRole("radiogroup", { name: "Default dark style" });
    await expect(group.getByRole("radio", { name: "Slate" })).toBeChecked();
    await group.getByRole("radio", { name: "Graphite" }).check();
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/admin/settings") && r.request().method() === "PATCH");
    await page.getByRole("button", { name: /Save changes/ }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByText("Workspace settings saved.")).toBeVisible();

    const log = await api(page, "/api/admin/audit?category=settings&limit=50");
    const row = (log.body.rows as any[]).find((r) => r.action === "settings.dark_style");
    expect(row, "the change is in the audit log").toBeTruthy();
    const details = typeof row.details === "string" ? JSON.parse(row.details) : row.details;
    expect(details).toEqual({ from: "slate", to: "graphite" });

    // A person who never chose: Graphite, from the server's first paint.
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const follower = await ctx.newPage();
    await login(follower, FOLLOWER);
    expect(await htmlStyle(follower)).toBe("graphite");
    expect(await bodyBg(follower)).toBe("rgb(16, 16, 18)");
    expect(await (await follower.request.get("/")).text()).toMatch(/<html[^>]*\sdata-dark-style="graphite"/);
    await follower.goto("/account/preferences");
    await expect(follower.getByRole("radiogroup", { name: "Dark style" })).toContainText("Currently Graphite");
    await ctx.close();

    // Someone who chose Black keeps Black in the app.
    const chooserCtx = await browser.newContext({ colorScheme: "dark" });
    const chooser = await chooserCtx.newPage();
    await login(chooser, CHOOSER);
    expect(await htmlStyle(chooser)).toBe("black");
    // …but the portal, the help centre and the public pages wear the workspace's. In a build
    // without the helpdesk (or with the public site off) those answer 404, and Next sends a bare error
    // shell whose <html> attributes come in the streamed payload instead; either way the server says graphite.
    for (const path of ["/support", "/support/search?q=vpn", "/public"]) {
      const res = await chooser.request.get(path);
      const body = await res.text();
      if (res.status() === 200) expect(body, path).toMatch(/<html[^>]*\sdata-dark-style="graphite"/);
      else expect(body, path).toMatch(/"data-dark-style\\":\\"graphite\\"/);
    }
    await expectPortalGraphite(chooser);
    await chooserCtx.close();

    // A visitor with no account at all, on the portal and the sign-in page.
    const anon = await browser.newContext({ colorScheme: "dark" });
    const visitor = await anon.newPage();
    await expectPortalGraphite(visitor);
    await visitor.goto("/login");
    expect(await htmlStyle(visitor)).toBe("graphite");
    expect(await bodyBg(visitor)).toBe("rgb(16, 16, 18)");
    expect(await (await visitor.request.get("/login")).text()).toMatch(/<html[^>]*\sdata-dark-style="graphite"/);
    // A stale or forged cookie never wins on these pages, and never breaks one.
    await anon.addCookies([{ name: "compass-dark-style", value: "black", url: page.url() }]);
    await visitor.goto("/login");
    expect(await htmlStyle(visitor)).toBe("graphite");
    await anon.addCookies([{ name: "compass-dark-style", value: "neon", url: page.url() }]);
    await visitor.goto("/support");
    expect(await htmlStyle(visitor)).toBe("graphite");
    await anon.close();

    // A bad value is refused, not stored.
    expect((await api(page, "/api/admin/settings", { method: "PATCH", body: { dark_style: "neon" } })).status).toBe(400);
    expect((await api(page, "/api/admin/settings")).body.dark_style).toBe("graphite");
  });

  test("signed in, the account decides whatever cookie the browser holds; signing out clears it", async ({ page, context }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await login(page, CHOOSER);
    // No cookie at all (a single sign-on, say, or a cleared browser): the session still says Black.
    await context.clearCookies({ name: "compass-dark-style" });
    expect(await (await page.request.get("/")).text()).toMatch(/<html[^>]*\sdata-dark-style="black"/);
    // Someone else's choice left behind on a shared browser never wins over the signed-in account.
    await context.addCookies([{ name: "compass-dark-style", value: "slate", url: page.url() }]);
    expect(await (await page.request.get("/")).text()).toMatch(/<html[^>]*\sdata-dark-style="black"/);
    // The installed desk's title bar reads the account too (a dark device's theme-color is Black's).
    const desk = await (await page.request.get("/desk")).text();
    expect(desk).toMatch(/<meta name="theme-color"[^>]*(?:content="#0d0d0e"[^>]*media="\(prefers-color-scheme: dark\)"|media="\(prefers-color-scheme: dark\)"[^>]*content="#0d0d0e")/);

    // Signing out removes the cookie, so the next person starts from the workspace's style.
    await page.goto("/");
    expect(await page.evaluate(async () => (await fetch("/api/auth/logout", { method: "POST" })).status)).toBe(200);
    expect((await context.cookies()).find((c) => c.name === "compass-dark-style")).toBeUndefined();
    await page.goto("/login");
    expect(await htmlStyle(page)).toBe("graphite");
  });

  test("a refused save changes nothing: not the account, not the cookie, not the page", async ({ page, context }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await login(page, CHOOSER);
    // One bad field refuses the whole request before anything is saved, and sets no cookie.
    const res = await page.request.fetch("/api/account/preferences", { method: "PATCH", data: { dark_style: "slate", theme: "neon" } });
    expect(res.status()).toBe(400);
    expect(res.headers()["set-cookie"]).toBeUndefined();
    expect(await (await page.request.get("/")).text()).toMatch(/<html[^>]*\sdata-dark-style="black"/);

    // A save the server refuses puts the choice and the page back, and says so.
    await page.goto("/account/preferences");
    await page.route("**/api/account/preferences", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Couldn't save just now." }) })
    );
    const group = page.getByRole("radiogroup", { name: "Dark style" });
    await group.getByRole("radio", { name: "Graphite" }).check();
    await expect(page.getByText("Couldn't save just now.")).toBeVisible();
    await expect(group.getByRole("radio", { name: "Black" })).toBeChecked();
    expect(await htmlStyle(page)).toBe("black");
    expect((await context.cookies()).find((c) => c.name === "compass-dark-style")?.value).toBe("black");
    await page.unroute("**/api/account/preferences");
  });

  test("light mode is unaffected, and print stays light", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await login(page, CHOOSER);
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("light");
    // The person's choice is still on <html>, and changes nothing in light mode.
    expect(await htmlStyle(page)).toBe("black");
    expect(await bodyBg(page)).toBe("rgb(248, 250, 252)");
    for (const [name, value] of [
      ["--surface", "255 255 255"],
      ["--canvas", "248 250 252"],
      ["--slate-900", "15 23 42"],
      ["--slate-200", "226 232 240"],
      ["--control-edge", "226 232 240"],
      ["--compass-50", "237 245 251"],
      ["--dark-panel", "15 23 42"],
    ]) {
      expect(await token(page, name), name).toBe(value);
    }

    // Dark and Black on screen, but the printer gets the light theme.
    await page.emulateMedia({ colorScheme: "dark", media: "print" });
    await page.goto("/account/preferences");
    expect(await htmlStyle(page)).toBe("black");
    expect(await token(page, "--surface")).toBe("255 255 255");
    expect(await bodyBg(page)).toBe("rgb(255, 255, 255)");
  });
});
