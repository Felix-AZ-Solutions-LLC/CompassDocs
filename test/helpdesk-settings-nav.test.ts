// Helpdesk 1.20.13: the desk settings registry (lib/helpdesk/desk-settings-registry),
// which draws the desk settings rail, its search, the tabbed sections and
// the /desk/settings overview.
//   - nothing can be missed: every desk settings route is registered (a
//     static route as a page of its own, a dynamic one under a registered
//     page), every registered page has a route, and every address that
//     moved still has a page that redirects to a registered one;
//   - every searchable setting's anchor is an id some component renders;
//   - the registry and the page guards agree: for each desk role, the
//     pages the rail and the search offer are exactly the pages whose
//     guard (SETTINGS_CAP / canOpenSettings in app/(desk)/desk-access) lets
//     that role in, checked against real accounts and their desk roles;
//   - the search finds settings by their synonyms (SMTP, Outlook, MFA,
//     webhook, SLA, due dates, reply templates), best first, and only what
//     the person may open: an Agent sees their own Notifications and their
//     own macros and canned responses, nothing an admin configures;
//   - the tab row shows on a tab, not on a detail page under it.
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-settings-nav.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { pool, getSetting } from "../src/lib/db";
import { fixtureQuery } from "./support/retry";
import * as reg from "../src/lib/helpdesk/desk-settings-registry";
import { HD_DEFAULT_MATRIX, HD_CAP_KEYS } from "../src/lib/helpdesk/roles-shared";
import { firstSettingsHref, deskSettingsViewer } from "../src/components/helpdesk/desk/settings/settings-nav";

const ROOT = join(__dirname, "..");
const SETTINGS_DIR = join(ROOT, "src", "app", "(desk)", "desk", "settings");
const HOME = "/desk/settings";
const pathOf = (href: string) => href.split("#")[0].split("?")[0];

function pageRoutes(dir: string, base: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) pageRoutes(p, /^\(.*\)$/.test(name) ? base : `${base}/${name}`, out);
    else if (name === "page.tsx") out.push(base);
  }
  return out;
}
const ROUTES = pageRoutes(SETTINGS_DIR, HOME);
const REGISTERED = reg.DESK_SETTINGS_PAGES.filter((p) => !p.adminSection).map((p) => pathOf(p.href));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(name)) out.push(p);
  }
  return out;
}
const SOURCES = [...walk(join(ROOT, "src", "components")), ...walk(join(ROOT, "src", "app"))].map((f) => readFileSync(f, "utf8"));

const ALL = { caps: [...HD_CAP_KEYS] };
const ADMIN = { caps: [...HD_DEFAULT_MATRIX.admin], adminSections: ["/admin/sso"] };
const viewerOf = (role: keyof typeof HD_DEFAULT_MATRIX) => ({ caps: [...HD_DEFAULT_MATRIX[role]] });
const sectionKeys = (v: reg.DeskSettingsViewer) => reg.deskSettingsGroups(v).flatMap((g) => g.sections.map((s) => s.key));

describe("the registry covers every route", () => {
  test("every desk settings route is registered, and every registered page exists", () => {
    assert.ok(ROUTES.length > 40, `found ${ROUTES.length} routes`);
    const moved = Object.keys(reg.DESK_SETTINGS_MOVED);
    for (const r of ROUTES) {
      if (r === HOME || REGISTERED.includes(r) || moved.includes(r)) continue;
      // A dynamic route (a team, a requirement set, an alert source) sits under the page it belongs to.
      const parent = REGISTERED.find((h) => r.startsWith(`${h}/`));
      assert.ok(r.includes("[") && parent, `${r} is not in lib/helpdesk/desk-settings-registry: add it to a section (and its search words)`);
    }
    for (const h of REGISTERED) {
      const file = h === "/desk/setup" ? join(ROOT, "src", "app", "(desk)", "desk", "setup", "page.tsx") : join(SETTINGS_DIR, h.slice(HOME.length + 1), "page.tsx");
      assert.ok(existsSync(file), `${h} is registered but has no page (${relative(ROOT, file)})`);
    }
    assert.equal(new Set(REGISTERED).size, REGISTERED.length, "a page is registered twice");
    assert.equal(new Set(reg.DESK_SETTINGS_SECTIONS.map((s) => s.key)).size, reg.DESK_SETTINGS_SECTIONS.length);
  });

  test("every address that moved still answers, after the capability check, with a redirect to a registered page", () => {
    for (const [from, to] of Object.entries(reg.DESK_SETTINGS_MOVED)) {
      const src = readFileSync(join(SETTINGS_DIR, from.slice(HOME.length + 1), "page.tsx"), "utf8");
      assert.match(src, /canOpenSettings\(/, `${from} checks the capability first`);
      assert.match(src, new RegExp(`redirect\\(MOVED_SETTINGS\\["${from.replace(/\//g, "\\/")}"\\]`), `${from} redirects through MOVED_SETTINGS`);
      assert.ok(REGISTERED.includes(pathOf(to)), `${from} → ${to} is registered`);
    }
  });

  test("every searchable setting's anchor is an id a component renders", () => {
    for (const p of reg.DESK_SETTINGS_PAGES) {
      for (const t of p.topics ?? []) {
        const literal = SOURCES.some((s) => s.includes(`id="${t.anchor}"`));
        // `chat-${app}` renders chat-teams and chat-slack.
        const prefix = t.anchor.slice(0, t.anchor.lastIndexOf("-"));
        const templated = prefix.length > 0 && SOURCES.some((s) => s.includes(`id={\`${prefix}-\${`));
        assert.ok(literal || templated, `${p.href}#${t.anchor} has no element with that id`);
      }
    }
  });

  test("every page and section says what it is, in plain words", () => {
    for (const s of reg.DESK_SETTINGS_SECTIONS) {
      assert.ok(s.description.length > 15 && !s.description.includes("—"), s.key);
      assert.ok(s.pages.length > 0, s.key);
      if (s.tabs) assert.ok(s.pages.filter((p) => !p.unlisted).length > 1, `${s.key} has tabs, so more than one page`);
      for (const p of s.pages) assert.ok(p.adminSection || p.caps.length > 0 || p.href.endsWith("/notifications"), `${p.href} names its capabilities`);
    }
    // A small number of clear groups.
    assert.ok(reg.DESK_SETTINGS_GROUPS.length <= 9);
    assert.deepEqual(
      reg.DESK_SETTINGS_GROUPS.map((g) => g.label),
      ["General", "Teams and people", "Email", "Tickets", "Automation", "Requesters", "Integrations", "Security and data", "You"]
    );
  });
});

describe("search", () => {
  const first = (q: string, v: reg.DeskSettingsViewer = ADMIN) => reg.searchDeskSettings(v, q)[0]?.href;
  const hrefs = (q: string, v: reg.DeskSettingsViewer = ADMIN) => reg.searchDeskSettings(v, q).map((h) => h.href);

  test("finds settings by the words people use, best first", () => {
    assert.ok(hrefs("SMTP").some((h) => h.startsWith("/desk/settings/email")), "SMTP");
    assert.equal(first("mailbox"), "/desk/settings/email");
    for (const h of ["/desk/settings/email#addresses", "/desk/settings/email#microsoft-365"]) assert.ok(hrefs("mailbox").includes(h), h);
    assert.ok(hrefs("Outlook").includes("/desk/settings/email#microsoft-365"), "Outlook");
    assert.ok(hrefs("exchange").includes("/desk/settings/email#microsoft-365"), "exchange");
    for (const q of ["MFA", "2FA", "Duo", "two factor"]) assert.equal(first(q), "/admin/sso#duo", q);
    assert.ok(hrefs("webhook").includes("/desk/settings/integrations/api#webhooks"), "webhook");
    assert.equal(first("SLA"), "/desk/settings/sla", "SLA: Reply targets before Slack");
    assert.ok(hrefs("SLA").indexOf("/desk/settings/integrations/chat#chat-slack") > 0);
    assert.equal(first("due dates"), "/desk/settings/sla");
    assert.equal(first("dates due"), "/desk/settings/sla", "word order does not matter");
    assert.ok(hrefs("reply templates").includes("/desk/settings/canned"), "reply templates");
    assert.equal(first("canned"), "/desk/settings/canned");
    assert.equal(first("holidays"), "/desk/settings/calendars/holidays");
    assert.equal(first("intune"), "/desk/settings/integrations/intune");
    assert.equal(first("quiet hours"), "/desk/settings/notifications#quiet-hours");
    assert.ok(hrefs("mail").length > 0, "a part of a word still finds (mail → email)");
    assert.deepEqual(hrefs("zzqx nothing"), []);
    assert.ok(reg.searchDeskSettings(ADMIN, "e").length <= 12, "at most 12 rows");
    // Unlisted pages (the alert source wizard) are never offered.
    assert.ok(!hrefs("new alert source").includes("/desk/settings/integrations/new"));
  });

  test("a section's row goes to the first of its tabs the person may open", () => {
    const manager = viewerOf("manager");
    const row = reg.searchDeskSettings(manager, "agents and roles").find((h) => h.kind === "section");
    assert.equal(row?.href, "/desk/settings/agents");
    const lead = viewerOf("team_lead");
    assert.equal(reg.searchDeskSettings(lead, "assignment").find((h) => h.kind === "section")?.href, "/desk/settings/assignment");
  });
});

describe("permissions", () => {
  test("an Agent reaches only their own settings: notifications, and their own macros and canned responses", () => {
    const agent = viewerOf("agent");
    assert.deepEqual(sectionKeys(agent), ["macros", "notifications"]);
    assert.deepEqual(reg.searchDeskSettings(agent, "smtp"), []);
    assert.deepEqual(reg.searchDeskSettings(agent, "duo"), []);
    assert.deepEqual(reg.searchDeskSettings(agent, "request types"), []);
    assert.equal(reg.searchDeskSettings(agent, "quiet")[0]?.href, "/desk/settings/notifications#quiet-hours");
    assert.equal(firstSettingsHref(agent.caps), HOME);
  });

  test("a Newbie reaches Notifications alone; nobody is ever left with nothing", () => {
    assert.deepEqual(sectionKeys(viewerOf("newbie")), ["notifications"]);
    assert.deepEqual(sectionKeys({ caps: [] }), ["notifications"]);
    assert.equal(reg.firstDeskSettingsHref({ caps: [] }), "/desk/settings/notifications");
  });

  test("Sign-in and Duo shows only for someone who can open Settings → Single sign-on", () => {
    assert.ok(!sectionKeys({ caps: ALL.caps }).includes("sign-in"));
    assert.ok(sectionKeys(ADMIN).includes("sign-in"));
    assert.deepEqual(deskSettingsViewer(ALL.caps, ["/admin/users", "/admin/sso"]).adminSections, ["/admin/sso"]);
  });

  test("a Manager sees the tabs their role opens, and no email channels or roles matrix", () => {
    const m = viewerOf("manager");
    assert.ok(!sectionKeys(m).includes("email"), "Email is channels.manage (Admins)");
    const at = reg.deskTabbedSectionAt("/desk/settings/agents", m);
    assert.deepEqual(at?.tabs.map((t) => t.label), ["Agents", "Skills and languages"]);
    assert.deepEqual(reg.deskTabbedSectionAt("/desk/settings/roles", m), undefined, "a tab the role cannot open draws no chrome");
  });

  test("the tab row is on a tab, never on a detail page under one, nor on a one-page section", () => {
    assert.equal(reg.deskTabbedSectionAt("/desk/settings/custom-fields", ADMIN)?.section.key, "fields");
    assert.deepEqual(
      reg.deskTabbedSectionAt("/desk/settings/calendars/holidays", ADMIN)?.tabs.map((t) => t.href),
      ["/desk/settings/sla", "/desk/settings/calendars", "/desk/settings/calendars/holidays", "/desk/settings/calendars/test"]
    );
    assert.equal(reg.deskTabbedSectionAt("/desk/settings/before-you-solve/12", ADMIN), undefined);
    assert.equal(reg.deskTabbedSectionAt("/desk/settings/teams", ADMIN), undefined);
    assert.equal(reg.deskTabbedSectionAt("/desk/settings/integrations/chat", ADMIN), undefined, "the hub's pages keep their back link");
    assert.equal(reg.deskSettingsPageFor("/desk/settings/teams/7")?.section.key, "teams");
    assert.equal(reg.deskSettingsPageFor("/desk/settings/integrations/12")?.section.key, "integrations");
  });
});

// The guards themselves, against real accounts: what the registry offers each
// desk role is what that role's pages let in.
describe("the registry agrees with the page guards", () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const roles = require("../src/lib/helpdesk/roles") as typeof import("../src/lib/helpdesk/roles");
  const access = require("../src/app/(desk)/desk-access") as typeof import("../src/app/(desk)/desk-access");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const STAMP = `hdsetnav${Date.now().toString(36)}${process.pid}`;
  const ids: number[] = [];
  const U: Record<string, { id: number; role: "viewer"; username: string }> = {};

  // Pages guarded by SETTINGS_CAP[key]; the rest name their guard here.
  const KEY: Record<string, string> = {
    "/desk/settings/integrations/snipe-it": "assets",
    "/desk/settings/integrations/intune": "assets",
    "/desk/settings/integrations/assets": "assets",
    "/desk/settings/integrations/chat": "chat",
    "/desk/settings/integrations/claude-connector": "claude",
    "/desk/settings/integrations/api": "api",
  };
  const OWN_GUARD: Record<string, readonly string[]> = {
    "/desk/settings/agents": ["agents.assign_roles", "agents.manage_team"],
    "/desk/settings/roles": ["roles.manage"],
    "/desk/settings/assignment": ["agents.manage_team"],
    "/desk/settings/assignment/rules": ["automations.manage"],
    "/desk/settings/assignment/on-call": ["agents.manage_team"],
    "/desk/settings/calendars": ["sla.manage"],
    "/desk/settings/calendars/holidays": ["sla.manage"],
    "/desk/settings/calendars/test": ["sla.manage"],
    "/desk/settings/portal/help-centre": ["settings.manage"],
    "/desk/settings/portal/customers": ["settings.manage"],
    "/desk/settings/email-templates": ["templates.manage"],
    "/desk/settings/integrations/alerts": ["settings.manage", "channels.manage"],
    "/desk/settings/integrations/new": ["settings.manage", "channels.manage"],
    "/desk/settings/notifications": [],
  };

  before(async () => {
    await getSetting("__schema_bootstrap__");
    roles.setRoleMatrixForTests(roles.HD_DEFAULT_MATRIX);
    for (const r of ["newbie", "agent", "team_lead", "manager", "admin"]) {
      const row = await fixtureQuery("INSERT INTO users (username, name, email, role, status) VALUES ($1, $2, $3, 'viewer', 'active') RETURNING id", [
        `${STAMP}-${r}`,
        `${r} ${STAMP}`,
        `${STAMP}-${r}@example.test`,
      ]);
      ids.push(row.rows[0].id);
      await pool().query("INSERT INTO hd_agent_roles (user_id, role) VALUES ($1, $2)", [row.rows[0].id, r]);
      U[r] = { id: row.rows[0].id, role: "viewer", username: `${STAMP}-${r}` };
    }
  });

  after(async () => {
    roles.setRoleMatrixForTests(null);
    await pool().query("DELETE FROM hd_agent_roles WHERE user_id = ANY($1)", [ids]);
    await fixtureQuery("DELETE FROM users WHERE id = ANY($1)", [ids]);
    await pool().end();
  });

  test("the registry's capabilities are the guards' capabilities, page by page", () => {
    for (const p of reg.DESK_SETTINGS_PAGES) {
      if (p.adminSection) continue;
      const path = pathOf(p.href);
      const key = KEY[path] ?? (path === "/desk/setup" ? "setup" : path.slice(HOME.length + 1).split("/")[0]);
      const guard = OWN_GUARD[path] ?? access.SETTINGS_CAP[key];
      assert.ok(guard, `${path}: name its guard (SETTINGS_CAP key "${key}")`);
      assert.deepEqual([...p.caps].sort(), [...guard].sort(), path);
    }
  });

  test("each desk role is offered exactly the pages it can open", async () => {
    for (const r of Object.keys(U)) {
      const user = U[r] as never;
      const rc = await access.deskRoleCaps(user);
      assert.deepEqual([...rc.caps].sort(), [...HD_DEFAULT_MATRIX[r as keyof typeof HD_DEFAULT_MATRIX]].sort(), `${r}'s capabilities`);
      const viewer = { caps: rc.caps };
      for (const p of reg.DESK_SETTINGS_PAGES) {
        if (p.adminSection) continue;
        const path = pathOf(p.href);
        const key = KEY[path] ?? (path === "/desk/setup" ? "setup" : path.slice(HOME.length + 1).split("/")[0]);
        if (!(key in access.SETTINGS_CAP) || OWN_GUARD[path]) continue;
        assert.equal(
          reg.canOpenDeskSettingsPage(viewer, p),
          await access.canOpenSettings(user, key as keyof typeof access.SETTINGS_CAP),
          `${r} on ${path}`
        );
      }
    }
    // The Agent's rail, from their real account.
    const agent = await access.deskRoleCaps(U.agent as never);
    assert.deepEqual(sectionKeys({ caps: agent.caps }), ["macros", "notifications"]);
    const admin = await access.deskRoleCaps(U.admin as never);
    assert.ok(sectionKeys({ caps: admin.caps }).length >= 20, "an Admin sees every desk section");
  });
});
