import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { ADMIN, api, login } from "./helpers";

// Helpdesk 1.20.30: the customer portal's settings never keep a request
// type, team or space that no longer exists.
//
// Seen on 1.20.28: a request type offered in the portal and then deleted
// stayed in the helpdesk_portal setting; the settings page could not show
// it, sent it back with every save, and every "Save portal settings"
// failed with "One of the request types no longer exists. Reload the
// page." for good. Now deleting a request type, team or space prunes the
// portal's settings, and the settings routes heal a stored value that
// already names one (the read writes the cleaned value back; a save drops
// what was sent for it).
//
// The portal and help centre settings are workspace keys: written under
// advisory lock 728661 (shared with the portal's unit tests and specs) and
// restored afterwards. Licensed rig only (the helpdesk is Enterprise):
// skipped elsewhere.

const stamp = `${Date.now()}`;
const LOCK = 728661;
const PORTAL = "helpdesk_portal";
const HC = "helpdesk_portal_hc";

async function licensed(page: Page): Promise<boolean> {
  const r = await api(page, "/api/helpdesk/admin/settings");
  return r.status !== 402;
}

const portalBody = (types: { id: number; team_id: number | null }[]) => ({
  enabled: false,
  types,
  access: "anyone",
  domains: [],
  brand_name: `Stale E2E ${stamp}`,
  limits: {},
  blocked_words: [],
  blocked_domains: [],
});

test.describe("customer portal settings: deleted request types, teams and spaces (licensed)", () => {
  test.describe.configure({ mode: "serial" });
  let db: Client;
  const saved = new Map<string, string | null>();
  const made = { types: [] as number[], teams: [] as number[], spaces: [] as number[], rules: [] as number[], checklists: [] as number[] };

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
    if (made.rules.length) await db.query("DELETE FROM hd_automations WHERE id = ANY($1::int[])", [made.rules]);
    if (made.checklists.length) await db.query("DELETE FROM hd_checklist_templates WHERE id = ANY($1::int[])", [made.checklists]);
    if (made.types.length) await db.query("DELETE FROM hd_request_types WHERE id = ANY($1::int[])", [made.types]);
    if (made.teams.length) await db.query("DELETE FROM hd_teams WHERE id = ANY($1::int[])", [made.teams]);
    if (made.spaces.length) await db.query("DELETE FROM spaces WHERE id = ANY($1::int[])", [made.spaces]);
    await db.query("DELETE FROM audit_log WHERE target_label LIKE $1", [`%${stamp}%`]);
    await db.query("SELECT pg_advisory_unlock($1)", [LOCK]);
    await db.end();
  });

  async function setSetting(key: string, value: unknown) {
    if (!saved.has(key)) {
      const r = await db.query("SELECT value FROM settings WHERE key = $1", [key]);
      saved.set(key, r.rows[0]?.value ?? null);
    }
    await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, JSON.stringify(value)]);
  }

  async function stored(key: string): Promise<Record<string, any>> {
    const r = await db.query("SELECT value FROM settings WHERE key = $1", [key]);
    return JSON.parse(r.rows[0]?.value ?? "null");
  }

  async function newTeam(page: Page, n: string): Promise<number> {
    const r = await api(page, "/api/helpdesk/admin/teams", { method: "POST", body: { name: `Stale ${n} ${stamp}` } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    made.teams.push(r.body.team.id);
    return r.body.team.id;
  }

  async function newType(page: Page, n: string, teamId: number | null = null): Promise<number> {
    const r = await api(page, "/api/helpdesk/admin/request-types", {
      method: "POST",
      body: { title: `Stale ${n} ${stamp}`, slug: `stale-${n}-${stamp}`, team_id: teamId, form: [], sla_priority: "normal", visibility: "all" },
    });
    expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
    const id = (r.body.request_type ?? r.body.type ?? r.body).id as number;
    made.types.push(id);
    return id;
  }

  /** A space straight in the database (a space delete needs it empty; it is). */
  async function newSpace(n: string): Promise<number> {
    const id = (await db.query("INSERT INTO spaces (slug, name, visibility) VALUES ($1, $2, 'internal') RETURNING id", [`stale-${n}-${stamp}`, `Stale ${n} ${stamp}`])).rows[0].id as number;
    made.spaces.push(id);
    return id;
  }

  const typeIds = (s: Record<string, any>) => (s.types as { id: number }[]).map((t) => t.id);

  test("offer a request type, delete it, then the portal settings still save", async ({ page }) => {
    test.setTimeout(300_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");

    const team = await newTeam(page, "routing");
    const gone = await newType(page, "gone", team);
    const kept = await newType(page, "kept", team);
    await setSetting(PORTAL, {});
    const offered = await api(page, "/api/helpdesk/admin/portal", { method: "PUT", body: portalBody([{ id: gone, team_id: team }, { id: kept, team_id: null }]) });
    expect(offered.status, JSON.stringify(offered.body)).toBe(200);
    expect(typeIds(await stored(PORTAL))).toEqual([gone, kept]);

    // Delete it in Desk settings → Request types: it leaves the portal in the same transaction.
    const del = await api(page, `/api/helpdesk/admin/request-types/${gone}`, { method: "DELETE" });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(typeIds(await stored(PORTAL))).toEqual([kept]);

    // A page opened before the delete still saves: the deleted type is dropped, not refused.
    const stale = await api(page, "/api/helpdesk/admin/portal", { method: "PUT", body: portalBody([{ id: gone, team_id: team }, { id: kept, team_id: null }]) });
    expect(stale.status, JSON.stringify(stale.body)).toBe(200);
    expect(typeIds(stale.body.settings)).toEqual([kept]);
    expect(typeIds(await stored(PORTAL))).toEqual([kept]);

    // And the page itself: change the name, Save portal settings.
    await page.goto("/desk/settings/portal");
    const name = page.getByLabel("Portal name");
    await expect(name).toBeVisible({ timeout: 90_000 });
    await name.fill(`Stale E2E renamed ${stamp}`);
    await page.getByRole("button", { name: "Save portal settings" }).click();
    await expect(page.getByText("Portal settings saved. The portal is off.")).toBeVisible();
    const after = await stored(PORTAL);
    expect(after.brand_name).toBe(`Stale E2E renamed ${stamp}`);
    expect(typeIds(after)).toEqual([kept]);
  });

  test("a workspace already holding a deleted request type heals on the next read, and on save", async ({ page }) => {
    test.setTimeout(300_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");

    const kept = await newType(page, "heal-kept");
    const gone = await newType(page, "heal-gone");
    // Deleted the way 1.20.28 did: the row goes, the portal setting keeps naming it.
    await db.query("DELETE FROM hd_request_types WHERE id = $1", [gone]);
    const bad = { ...portalBody([{ id: gone, team_id: null }, { id: kept, team_id: null }]), enabled: true };
    await setSetting(PORTAL, bad);

    // The read cleans it and writes the clean value back.
    const got = await api(page, "/api/helpdesk/admin/portal");
    expect(got.status).toBe(200);
    expect(typeIds(got.body.settings)).toEqual([kept]);
    expect(typeIds(await stored(PORTAL))).toEqual([kept]);
    expect((await stored(PORTAL)).enabled).toBe(true);

    // The same bad state, then a save straight away (what a page opened earlier sends).
    await setSetting(PORTAL, bad);
    const put = await api(page, "/api/helpdesk/admin/portal", { method: "PUT", body: { ...bad, enabled: false } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(typeIds(put.body.settings)).toEqual([kept]);
    expect(typeIds(await stored(PORTAL))).toEqual([kept]);

    // Only the stale entry goes: with nothing else to offer, turning the portal on is still refused, saying why.
    await setSetting(PORTAL, { ...bad, types: [{ id: gone, team_id: null }] });
    const none = await api(page, "/api/helpdesk/admin/portal", { method: "PUT", body: { ...bad, types: [{ id: gone, team_id: null }] } });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/Choose at least one thing customers can ask for/);
    expect(typeIds(await stored(PORTAL))).toEqual([]);
  });

  test("a deleted team: the type stays offered and goes to its own team", async ({ page }) => {
    test.setTimeout(300_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");

    const own = await newTeam(page, "own");
    const portalTeam = await newTeam(page, "portal");
    const rt = await newType(page, "team-type", own);
    await setSetting(PORTAL, {});
    const offered = await api(page, "/api/helpdesk/admin/portal", { method: "PUT", body: portalBody([{ id: rt, team_id: portalTeam }]) });
    expect(offered.status, JSON.stringify(offered.body)).toBe(200);

    // Deleting the team clears the type's portal team in the same transaction.
    const del = await api(page, `/api/helpdesk/admin/teams/${portalTeam}`, { method: "DELETE" });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect((await stored(PORTAL)).types).toEqual([{ id: rt, team_id: null }]);
    const got = await api(page, "/api/helpdesk/admin/portal");
    const option = (got.body.types as { id: number; exposed: boolean; portal_team_id: number | null }[]).find((t) => t.id === rt);
    expect(option).toMatchObject({ exposed: true, portal_team_id: null });

    // A page opened before the delete still saves; the team drops out.
    const stale = await api(page, "/api/helpdesk/admin/portal", { method: "PUT", body: portalBody([{ id: rt, team_id: portalTeam }]) });
    expect(stale.status, JSON.stringify(stale.body)).toBe(200);
    expect(stale.body.settings.types).toEqual([{ id: rt, team_id: null }]);

    // Already in the bad state (a team deleted on 1.20.28): the read heals it.
    const goneTeam = await newTeam(page, "gone");
    await db.query("DELETE FROM hd_teams WHERE id = $1", [goneTeam]);
    await setSetting(PORTAL, portalBody([{ id: rt, team_id: goneTeam }]));
    const healed = await api(page, "/api/helpdesk/admin/portal");
    expect(healed.status).toBe(200);
    expect(healed.body.settings.types).toEqual([{ id: rt, team_id: null }]);
    expect((await stored(PORTAL)).types).toEqual([{ id: rt, team_id: null }]);
  });

  test("automations and checklists that name a deleted team or request type still save", async ({ page }) => {
    test.setTimeout(300_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");

    const keepTeam = await newTeam(page, "au-keep");
    const goneTeam = await newTeam(page, "au-gone");
    const keepType = await newType(page, "au-keep");
    const goneType = await newType(page, "au-gone");
    const rule = { name: `Stale rule ${stamp}`, event: "ticket_created", conditions: { team_ids: [goneTeam, keepTeam], request_type_ids: [goneType, keepType] }, actions: { team_id: goneTeam, priority: "high" } };
    const created = await api(page, "/api/helpdesk/admin/automations", { method: "POST", body: { ...rule, active: 0 } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    made.rules.push(created.body.automation.id);
    const cl = await api(page, "/api/helpdesk/admin/checklists", { method: "POST", body: { name: `Stale checklist ${stamp}`, items: [{ title: "Check it", team_id: goneTeam }], request_type_ids: [goneType, keepType] } });
    expect(cl.status, JSON.stringify(cl.body)).toBe(201);
    made.checklists.push(cl.body.template.id);

    expect((await api(page, `/api/helpdesk/admin/teams/${goneTeam}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(page, `/api/helpdesk/admin/request-types/${goneType}`, { method: "DELETE" })).status).toBe(200);

    // A rule whose only team condition was deleted: refused with what to do, not turned into "any team" (checked
    // first, while the stored rule still names the deleted team; once a save drops it, the id is just unknown).
    const only = await api(page, `/api/helpdesk/admin/automations/${created.body.automation.id}`, { method: "PATCH", body: { ...rule, conditions: { team_ids: [goneTeam] }, actions: { priority: "high" } } });
    expect(only.status).toBe(400);
    expect(only.body.error).toMatch(/The team this rule checks for was deleted/);
    // The editor sends the rule back as it loaded it: the deleted entries drop out, and the save says the move went.
    const saved = await api(page, `/api/helpdesk/admin/automations/${created.body.automation.id}`, { method: "PATCH", body: { ...rule, active: 0 } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.automation.conditions).toEqual({ team_ids: [keepTeam], request_type_ids: [keepType] });
    expect(saved.body.automation.actions).toEqual({ priority: "high" });
    expect(saved.body.notices).toEqual(["The team this rule moved tickets to was deleted, so the rule no longer moves them."]);


    // The checklist: renamed without sending its lists; the deleted owner team and request type drop out.
    const renamed = await api(page, `/api/helpdesk/admin/checklists/${cl.body.template.id}`, { method: "PUT", body: { name: `Stale checklist ${stamp} renamed` } });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.template.request_type_ids).toEqual([keepType]);
    expect(renamed.body.template.items[0].team_id ?? null).toBeNull();
  });

  test("a deleted Help Center space leaves the Help Center settings; a stored one heals", async ({ page }) => {
    test.setTimeout(300_000);
    await login(page, ADMIN);
    test.skip(!(await licensed(page)), "helpdesk is not licensed in this build; the EE rig runs the flow");

    const gone = await newSpace("hc-gone");
    const kept = await newSpace("hc-kept");
    const hc = { enabled: false, from_spaces: true, spaces: [gone, kept], tagged: false, order: [`s${gone}`, `s${kept}`], hidden: [], indexing: false };
    await setSetting(HC, hc);

    // Deleting the space (Admin → Spaces) prunes the help centre's settings in the same transaction.
    const del = await api(page, `/api/admin/spaces/${gone}`, { method: "DELETE" });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    let s = await stored(HC);
    expect(s.spaces).toEqual([kept]);
    expect(s.order).toEqual([`s${kept}`]);

    // A page opened before the delete still saves.
    const stale = await api(page, "/api/helpdesk/admin/portal/help-centre", { method: "PUT", body: hc });
    expect(stale.status, JSON.stringify(stale.body)).toBe(200);
    expect(stale.body.settings.spaces).toEqual([kept]);

    // Already in the bad state (a space deleted on 1.20.28): the read heals it and writes it back.
    await setSetting(HC, hc);
    const got = await api(page, "/api/helpdesk/admin/portal/help-centre");
    expect(got.status).toBe(200);
    expect(got.body.settings.spaces).toEqual([kept]);
    s = await stored(HC);
    expect(s.spaces).toEqual([kept]);
    expect(s.order).toEqual([`s${kept}`]);

    // And straight to a save from that state.
    await setSetting(HC, hc);
    const put = await api(page, "/api/helpdesk/admin/portal/help-centre", { method: "PUT", body: hc });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect((await stored(HC)).spaces).toEqual([kept]);
  });
});
