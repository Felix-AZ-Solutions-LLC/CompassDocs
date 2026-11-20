// Dark styles (1.20.35, lib/dark-style, STYLEGUIDE §Color and theming → Dark
// styles): the preference sanitising, the resolution order (person →
// workspace default → Slate), and the contrast of every style, computed from
// the token values in globals.css itself, so a later edit to a ramp cannot
// drop a pair below AA without this failing. The ratios are printed.
//
// Run: npm run test:integration (this file needs no DATABASE_URL).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DARK_STYLES,
  DARK_STYLE_CANVAS,
  DARK_STYLE_SWATCH,
  DEFAULT_DARK_STYLE,
  darkStyleCookieString,
  darkStyleForPage,
  resolveDarkStyle,
  sanitizeDarkStyle,
  sanitizeDarkStylePref,
  workspaceOnlyPath,
  type DarkStyle,
} from "../src/lib/dark-style";
import { DEFAULT_ACCENT, accentCss, darkAccentTints } from "../src/lib/theme";
import { normalizeSettings } from "../src/lib/settings";

const CSS = readFileSync(join(__dirname, "..", "src", "app", "globals.css"), "utf8");

type Rgb = [number, number, number];
type Tokens = Record<string, Rgb>;

function vars(block: string): Tokens {
  const out: Tokens = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(\d+) (\d+) (\d+);/g)) out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  return out;
}

function block(selector: string): string {
  const re = new RegExp(selector.replace(/[[\]().*+?^$|\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}");
  const m = re.exec(CSS);
  assert.ok(m, `globals.css has a ${selector} block`);
  return m[1];
}

const LIGHT = vars(block(":root"));
const SLATE_BLOCK = vars(block(':root[data-theme="dark"]'));
const STYLE_BLOCK: Record<Exclude<DarkStyle, "slate">, Tokens> = {
  graphite: vars(block(':root[data-theme="dark"][data-dark-style="graphite"]')),
  black: vars(block(':root[data-theme="dark"][data-dark-style="black"]')),
};

/** What a page in each style computes: light :root, then the Slate block, then the style's own. */
const TOKENS: Record<DarkStyle, Tokens> = {
  slate: { ...LIGHT, ...SLATE_BLOCK },
  graphite: { ...LIGHT, ...SLATE_BLOCK, ...STYLE_BLOCK.graphite },
  black: { ...LIGHT, ...SLATE_BLOCK, ...STYLE_BLOCK.black },
};

function lum([r, g, b]: Rgb): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;

// Semantic dark inks (plain Tailwind, not themed): red-400 (globals.css lifts
// text-red-600 to it), amber-300 (ink-warn), emerald-300 (ink-ok).
const RED_400: Rgb = [248, 113, 113];
const AMBER_300: Rgb = hex("#ffd230");
const EMERALD_300: Rgb = hex("#5ee9b5");

/** The pairs and their floors (WCAG 2.2 AA: 4.5:1 text, 3:1 non-text). */
function pairs(t: Tokens): { name: string; fg: Rgb; bg: Rgb; min: number }[] {
  const out: { name: string; fg: Rgb; bg: Rgb; min: number }[] = [];
  const grounds = ["surface", "canvas", "slate-100"] as const;
  for (const g of grounds) {
    for (const ink of ["slate-900", "slate-800", "slate-700"]) out.push({ name: `body ${ink} on ${g}`, fg: t[ink], bg: t[g], min: 4.5 });
    for (const ink of ["slate-600", "slate-500"]) out.push({ name: `muted ${ink} on ${g}`, fg: t[ink], bg: t[g], min: 4.5 });
    out.push({ name: `accent ink on ${g}`, fg: t["compass-ink"], bg: t[g], min: 4.5 });
    out.push({ name: `accent ink strong on ${g}`, fg: t["compass-ink-strong"], bg: t[g], min: 4.5 });
    out.push({ name: `focus ring compass-300 on ${g}`, fg: t["compass-300"], bg: t[g], min: 3 });
    out.push({ name: `red ink on ${g}`, fg: RED_400, bg: t[g], min: 4.5 });
    out.push({ name: `ink-warn on ${g}`, fg: AMBER_300, bg: t[g], min: 4.5 });
    out.push({ name: `ink-ok on ${g}`, fg: EMERALD_300, bg: t[g], min: 4.5 });
  }
  for (const g of ["surface", "canvas"] as const) {
    out.push({ name: `placeholder slate-400 on ${g}`, fg: t["slate-400"], bg: t[g], min: 4.5 });
  }
  // The selected / current tint (bg-compass-50 text-compass-700, a selected row).
  out.push({ name: "accent ink strong on compass-50", fg: t["compass-ink-strong"], bg: t["compass-50"], min: 4.5 });
  out.push({ name: "body slate-900 on compass-50", fg: t["slate-900"], bg: t["compass-50"], min: 4.5 });
  out.push({ name: "muted slate-500 on compass-50", fg: t["slate-500"], bg: t["compass-50"], min: 4.5 });
  out.push({ name: "body slate-900 on compass-100", fg: t["slate-900"], bg: t["compass-100"], min: 4.5 });
  out.push({ name: "tooltip ink on tooltip", fg: t["tt-ink"], bg: t["tt-bg"], min: 4.5 });
  out.push({ name: "code ink on code block", fg: t["dark-panel-ink"], bg: t["dark-panel"], min: 4.5 });
  out.push({ name: "code bar label on code bar", fg: t["dark-panel-muted"], bg: t["dark-panel-raised"], min: 4.5 });
  return out;
}

/** The control edge (a form field's border, WCAG 1.4.11) on the surface and canvas. */
const EDGE_FLOOR: Record<DarkStyle, number> = {
  graphite: 3,
  black: 3,
  // Slate is today's ramp, unchanged by instruction: its field edge has
  // measured 1.48:1 since dark mode shipped. Held at that value so it can
  // only improve; raising it is a visible change for everyone, so it is a
  // product decision of its own (STYLEGUIDE §Color and theming → Dark styles).
  slate: 1.45,
};

describe("dark style preference", () => {
  test("the workspace default is sanitised: a known style, else null", () => {
    assert.equal(sanitizeDarkStyle("black"), "black");
    assert.equal(sanitizeDarkStyle(" Graphite "), "graphite");
    assert.equal(sanitizeDarkStyle("SLATE"), "slate");
    for (const bad of ["workspace", "", "midnight", "black; color:red", null, undefined, 3, {}, ["black"]]) {
      assert.equal(sanitizeDarkStyle(bad), null, String(bad));
    }
  });

  test("a person's choice is sanitised: a style or workspace, else null", () => {
    assert.equal(sanitizeDarkStylePref("workspace"), "workspace");
    assert.equal(sanitizeDarkStylePref("WORKSPACE "), "workspace");
    assert.equal(sanitizeDarkStylePref("graphite"), "graphite");
    for (const bad of ["", "system", "oled", "<b>", null, undefined, true]) {
      assert.equal(sanitizeDarkStylePref(bad), null, String(bad));
    }
  });

  test("resolution: the person's choice, then the workspace default, then Slate", () => {
    assert.equal(DEFAULT_DARK_STYLE, "slate");
    assert.equal(resolveDarkStyle("black", "graphite"), "black");
    assert.equal(resolveDarkStyle("slate", "black"), "slate", "choosing Slate beats a Black default");
    assert.equal(resolveDarkStyle("workspace", "graphite"), "graphite");
    assert.equal(resolveDarkStyle(undefined, "black"), "black", "no cookie: the workspace default");
    assert.equal(resolveDarkStyle("nonsense", "black"), "black", "a stale cookie falls through");
    assert.equal(resolveDarkStyle("workspace", "nonsense"), "slate");
    assert.equal(resolveDarkStyle(undefined, undefined), "slate");
  });

  test("the portal, Help Center, public site and sign-in pages follow the workspace default", () => {
    for (const p of ["/support", "/support/articles/reset-vpn", "/support/requests?x=1", "/public", "/public/hr/leave", "/share/abc", "/upload/abc", "/login", "/login/duo", "/login/preview?theme=dark", "/setup", "/oauth/authorize?client_id=x", "/account/password", "/account/two-step"]) {
      assert.ok(workspaceOnlyPath(p), p);
      assert.equal(darkStyleForPage(p, "black", "graphite"), "graphite", p);
    }
    for (const p of ["/", "/desk", "/desk/tickets/12/reply", "/account/preferences", "/admin/workspace", "/supporting", "/loginx", "/publications", "/oauthx", ""]) {
      assert.ok(!workspaceOnlyPath(p), p);
      assert.equal(darkStyleForPage(p, "black", "graphite"), "black", p);
    }
    assert.equal(darkStyleForPage("/desk", "workspace", "graphite"), "graphite");
  });

  test("the stored workspace setting defaults to Slate and drops junk", () => {
    assert.equal(normalizeSettings({}).dark_style, "slate");
    assert.equal(normalizeSettings({ dark_style: "black" }).dark_style, "black");
    assert.equal(normalizeSettings({ dark_style: "purple" }).dark_style, "slate");
  });

  test("the cookie line", () => {
    assert.equal(darkStyleCookieString("black"), "compass-dark-style=black; Path=/; Max-Age=31536000; SameSite=Lax");
    assert.match(darkStyleCookieString("workspace", true), /; Secure$/);
  });
});

describe("dark style tokens (globals.css)", () => {
  test("Graphite and Black re-declare every variable the Slate block sets (the accent ink excepted)", () => {
    // The accent ink is derived from the accent (lib/theme) and measured on all three below.
    const shared = new Set(["compass-ink", "compass-ink-strong"]);
    // Tokens that are dark in both themes, so the Slate block inherits them from :root.
    const alsoDark = ["dark-panel", "dark-panel-raised", "dark-panel-hover", "dark-panel-ink", "dark-panel-muted", "shadow-ink", "scrim-ink"];
    const need = [...Object.keys(SLATE_BLOCK).filter((k) => !shared.has(k)), ...alsoDark];
    for (const style of ["graphite", "black"] as const) {
      const missing = need.filter((k) => !(k in STYLE_BLOCK[style]));
      assert.deepEqual(missing, [], `${style} leaves these to Slate's values: ${missing.join(", ")}`);
    }
  });

  test("the style blocks are screen-only, so print keeps its light theme", () => {
    const at = CSS.indexOf(':root[data-theme="dark"][data-dark-style="graphite"] {');
    const media = CSS.lastIndexOf("@media", at);
    assert.ok(CSS.slice(media, at).startsWith("@media screen"), "the Graphite and Black blocks sit inside @media screen");
  });

  test("Black's page is #000 and every style steps up: canvas < surface < slate-100 < slate-200 < slate-300", () => {
    assert.deepEqual(TOKENS.black.canvas, [0, 0, 0]);
    assert.deepEqual(TOKENS.black["slate-50"], [0, 0, 0]);
    for (const style of DARK_STYLES) {
      const t = TOKENS[style];
      const steps = ["canvas", "surface", "slate-100", "slate-200", "slate-300"].map((k) => lum(t[k]));
      for (let i = 1; i < steps.length; i++) assert.ok(steps[i] > steps[i - 1], `${style}: step ${i} is lighter than the one under it`);
      // Cards on the page and a hover on a card stay distinguishable.
      assert.ok(ratio(t.surface, t.canvas) >= 1.05, `${style}: surface on canvas ${ratio(t.surface, t.canvas).toFixed(2)}`);
      assert.ok(ratio(t["slate-100"], t.surface) >= 1.1, `${style}: slate-100 on surface`);
      // A divider or a card's edge (decorative; not a WCAG pair) stays visible.
      assert.ok(ratio(t["slate-200"], t.surface) >= 1.4, `${style}: slate-200 on surface ${ratio(t["slate-200"], t.surface).toFixed(2)}`);
    }
  });

  test("Graphite and Black have no blue cast", () => {
    const neutral = ["surface", "canvas", ...["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"].map((n) => `slate-${n}`), "control-edge", "tt-bg", "dark-panel", "dark-panel-raised", "dark-panel-hover", "dark-panel-ink", "dark-panel-muted", "shadow-ink", "scrim-ink"];
    for (const style of ["graphite", "black"] as const) {
      for (const k of neutral) {
        const [r, g, b] = TOKENS[style][k];
        assert.ok(Math.abs(g - r) <= 1 && b - r >= 0 && b - r <= 4, `${style} --${k} is ${r} ${g} ${b}: more than a hair off grey`);
      }
    }
  });

  test("every style meets AA for text, muted text, placeholders, accent ink and focus rings (ratios printed)", () => {
    const rows: string[] = [];
    const failures: string[] = [];
    for (const style of DARK_STYLES) {
      for (const p of pairs(TOKENS[style])) {
        assert.ok(p.fg && p.bg, `${style}: ${p.name} has both tokens`);
        const r = ratio(p.fg, p.bg);
        rows.push(`${style.padEnd(8)} ${p.name.padEnd(36)} ${r.toFixed(2)}:1 (min ${p.min})`);
        if (r < p.min) failures.push(`${style}: ${p.name} is ${r.toFixed(2)}:1, below ${p.min}`);
      }
      for (const g of ["surface", "canvas"] as const) {
        const r = ratio(TOKENS[style]["control-edge"], TOKENS[style][g]);
        rows.push(`${style.padEnd(8)} ${`field edge on ${g}`.padEnd(36)} ${r.toFixed(2)}:1 (min ${EDGE_FLOOR[style]})`);
        if (r < EDGE_FLOOR[style]) failures.push(`${style}: the field edge on ${g} is ${r.toFixed(2)}:1, below ${EDGE_FLOOR[style]}`);
      }
    }
    console.log(rows.join("\n"));
    assert.deepEqual(failures, []);
  });

  test("Slate is exactly the 1.20.34 ramp", () => {
    const want: Record<string, string> = {
      surface: "19 26 40", canvas: "9 13 22", "slate-50": "9 13 22", "slate-100": "30 39 56", "slate-200": "45 56 78",
      "slate-300": "58 71 94", "slate-400": "122 134 154", "slate-500": "148 161 181", "slate-600": "176 187 204",
      "slate-700": "200 209 222", "slate-800": "221 227 236", "slate-900": "237 241 247", "slate-950": "248 250 252",
      "compass-50": "23 34 58", "compass-100": "30 45 78", "compass-ink": "130 180 224", "compass-ink-strong": "160 198 232",
      // Tokens that replaced literals: the literals' values.
      "control-edge": "45 56 78", "tt-bg": "226 232 240", "tt-ink": "15 23 42", "dark-panel": "15 23 42",
      "dark-panel-raised": "30 41 59", "dark-panel-hover": "51 65 85", "dark-panel-ink": "226 232 240",
      "dark-panel-muted": "148 163 184", "shadow-ink": "15 23 42", "scrim-ink": "2 6 23",
    };
    for (const [k, v] of Object.entries(want)) assert.equal(TOKENS.slate[k]?.join(" "), v, `--${k}`);
  });

  test("light mode's new tokens are the literals they replaced", () => {
    const want: Record<string, string> = {
      "control-edge": "226 232 240", "tt-bg": "15 23 42", "tt-ink": "248 250 252", "dark-panel": "15 23 42",
      "dark-panel-raised": "30 41 59", "dark-panel-hover": "51 65 85", "dark-panel-ink": "226 232 240",
      "dark-panel-muted": "148 163 184", "shadow-ink": "15 23 42", "scrim-ink": "2 6 23", "slate-200": "226 232 240",
    };
    for (const [k, v] of Object.entries(want)) assert.equal(LIGHT[k]?.join(" "), v, `--${k}`);
  });

  test("the swatch previews and the accent-tint canvases match globals.css", () => {
    for (const style of DARK_STYLES) {
      const t = TOKENS[style];
      const sw = DARK_STYLE_SWATCH[style];
      assert.equal(sw.canvas, t.canvas.join(" "), `${style} canvas`);
      assert.equal(sw.surface, t.surface.join(" "), `${style} surface`);
      assert.equal(sw.edge, t["slate-200"].join(" "), `${style} edge`);
      assert.equal(sw.ink, t["slate-900"].join(" "), `${style} ink`);
      assert.equal(sw.muted, t["slate-500"].join(" "), `${style} muted`);
      assert.deepEqual(DARK_STYLE_CANVAS[style], t.canvas, `${style} canvas for the accent tints`);
    }
  });

  test("the desk background's secondary ink is each style's own slate-600 (desk-look.css)", () => {
    const desk = readFileSync(join(__dirname, "..", "src", "components", "helpdesk", "desk", "appearance", "desk-look.css"), "utf8");
    for (const style of ["graphite", "black"] as const) {
      const m = new RegExp(`data-dark-style="${style}"\\] \\.desk-art\\[data-art-dark\\] \\{\\s*--slate-500: (\\d+ \\d+ \\d+);`).exec(desk);
      assert.ok(m, `desk-look.css overrides the ink for ${style}`);
      assert.equal(m[1], TOKENS[style]["slate-600"].join(" "), `${style} desk ink`);
      // At least as light as Slate's (the ink the artwork contrast was measured with).
      assert.ok(lum(TOKENS[style]["slate-600"]) >= lum(TOKENS.slate["slate-600"]) - 0.005, `${style} desk ink as light as Slate's`);
    }
  });

  test("over desk artwork a form field's edge softens like every other edge (desk-look.css, components/form)", () => {
    const desk = readFileSync(join(__dirname, "..", "src", "components", "helpdesk", "desk", "appearance", "desk-look.css"), "utf8");
    const form = readFileSync(join(__dirname, "..", "src", "components", "form.tsx"), "utf8");
    // Whatever edge class the control recipe paints has a 60% rule under .desk-art.
    const edge = /const controlOk = "(border-[a-z0-9-]+) /.exec(form)?.[1];
    assert.ok(edge, "components/form controlOk names its edge class");
    const token = edge === "border-control-edge" ? "control-edge" : edge.replace("border-", "");
    const rule = new RegExp(`\\.desk-art\\[data-art-dark\\]\\) \\.${edge} \\{\\s*border-color: rgb\\(var\\(--${token}\\) / 0\\.6\\);`);
    assert.match(desk, rule, `desk-look.css softens .${edge} to 60% over artwork`);
  });

  test("the default accent's tints on Graphite and Black are lib/theme's formula", () => {
    for (const style of ["graphite", "black"] as const) {
      const want = darkAccentTints(DEFAULT_ACCENT, DARK_STYLE_CANVAS[style]);
      assert.equal(STYLE_BLOCK[style]["compass-50"].join(" "), want.c50, `${style} compass-50`);
      assert.equal(STYLE_BLOCK[style]["compass-100"].join(" "), want.c100, `${style} compass-100`);
    }
  });
});

describe("the accent on every dark style", () => {
  const PRESETS = ["#2e75bd", "#4f46e5", "#7c3aed", "#0f766e", "#047857", "#b45309", "#dc2626", "#db2777", "#475569"];

  test("a custom accent re-tints compass-50 / -100 per style, screen only", () => {
    const css = accentCss("#d97706");
    for (const style of ["graphite", "black"] as const) {
      const want = darkAccentTints("#d97706", DARK_STYLE_CANVAS[style]);
      assert.ok(
        css.includes(`:root[data-theme="dark"][data-dark-style="${style}"]{--compass-50:${want.c50};--compass-100:${want.c100}}`),
        `${style} tints`
      );
    }
    assert.match(css, /@media screen\{:root\[data-theme="dark"\]\[data-dark-style="graphite"\]/);
    assert.equal(accentCss(DEFAULT_ACCENT), "", "the default accent still emits nothing");
  });

  test("every preset accent keeps its dark ink and focus ring readable on every style", () => {
    const failures: string[] = [];
    for (const accent of PRESETS) {
      const a = hex(accent);
      const toward = (t: number): Rgb => a.map((c) => Math.round(c + (255 - c) * t)) as Rgb;
      // What accentCss emits for dark mode: ink = 50% white, strong = 62%, focus ring = compass-300 = 50% white.
      const ink = accent === DEFAULT_ACCENT ? TOKENS.slate["compass-ink"] : toward(0.5);
      const strong = accent === DEFAULT_ACCENT ? TOKENS.slate["compass-ink-strong"] : toward(0.62);
      for (const style of DARK_STYLES) {
        const t = TOKENS[style];
        const c50 = accent === DEFAULT_ACCENT ? t["compass-50"] : (darkAccentTints(accent, DARK_STYLE_CANVAS[style]).c50.split(" ").map(Number) as Rgb);
        for (const g of [t.surface, t.canvas, t["slate-100"]]) {
          if (ratio(ink, g) < 4.5) failures.push(`${accent} ink on ${style} ${g.join(" ")}: ${ratio(ink, g).toFixed(2)}`);
          if (ratio(ink, g) < 3) failures.push(`${accent} focus ring on ${style}`);
        }
        if (ratio(strong, c50) < 4.5) failures.push(`${accent} strong ink on ${style} compass-50: ${ratio(strong, c50).toFixed(2)}`);
      }
    }
    assert.deepEqual(failures, []);
  });
});
