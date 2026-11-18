// Helpdesk 1.20.30: the customer portal's settings never keep a request
// type, team or space that no longer exists.
//
// Seen on 1.20.28: a request type offered in the portal and then deleted
// stayed in helpdesk_portal's `types`; the settings page could not show
// it, sent it back with every save, and every save refused it ("One of
// the request types no longer exists. Reload the page.") for good.
//
//   - the pure rules (portal-shared prunePortalRefs, help-centre-shared
//     pruneHelpCentreRefs / helpCentreRefIds)
//   - deleting a request type, a team or a space prunes the settings in
//     the delete's own transaction (lib/helpdesk/portal-refs)
//   - a workspace already in the bad state heals on the next read
//     (healPortalSettings / healHelpCentreSettings write the clean value)
//   - a checklist item whose owner team was deleted saves (the team goes)
//
// The settings are workspace keys: this file writes them under advisory
// lock 728661 (shared with the portal's other tests and specs) and
// restores them. Every other fixture is its own (stamped).
//
// Run: DATABASE_URL=… npx tsx --tsconfig ./tsconfig.test.json --test test/helpdesk-portal-stale.test.ts

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { pool, getSetting, deleteSpace } from "../src/lib/db";
import { cleanPortalSettings, prunePortalRefs, DEFAULT_PORTAL_SETTINGS } from "../src/lib/helpdesk/portal-shared";
import { cleanHelpCentreSettings, helpCentreRefIds, pruneHelpCentreRefs, DEFAULT_HELP_CENTRE_SETTINGS } from "../src/lib/helpdesk/help-centre-shared";
import { HD_HELP_CENTRE_SETTINGS_KEY, HD_PORTAL_SETTINGS_KEY, healHelpCentreSettings, healPortalSettings } from "../src/lib/helpdesk/portal-refs";
import { deleteRequestType } from "../src/lib/helpdesk/request-types";
import { deleteTeam } from "../src/lib/helpdesk/teams";
import { createTemplate, listTemplateRows, updateTemplate } from "../src/lib/helpdesk/checklists";
import { AUTOMATION_GONE, automationStoredRefs, createAutomation, deleteAutomation, getAutomation, updateAutomation, validateAutomationInput } from "../src/lib/helpdesk/automations";
import type { PortalPruneResult } from "../src/lib/helpdesk/portal-refs";

const LOCK = 728661;
const STAMP = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

// --- The pure rules ------------------------------------------------------------------

describe("prunePortalRefs", () => {
  const s = cleanPortalSettings({
    enabled: true,
    types: [
      { id: 1, team_id: 3 },
      { id: 2, team_id: 2 },
      { id: 3, team_id: 2 },
    ],
  });

  test("the production case: a deleted request type leaves the portal", () => {
    const r = prunePortalRefs(s, { types: [2, 3], teams: [2, 3] });
    assert.deepEqual(r.settings.types, [
      { id: 2, team_id: 2 },
      { id: 3, team_id: 2 },
    ]);
    assert.deepEqual(r.dropped_types, [1]);
    assert.deepEqual(r.cleared_teams, []);
    assert.equal(r.settings.enabled, true, "everything else is kept");
  });

  test("a deleted portal team falls back to the type's own team (team_id null); the type stays offered", () => {
    const r = prunePortalRefs(s, { types: [1, 2, 3], teams: [3] });
    assert.deepEqual(r.settings.types, [
      { id: 1, team_id: 3 },
      { id: 2, team_id: null },
      { id: 3, team_id: null },
    ]);
    assert.deepEqual(r.cleared_teams, [2, 3]);
    assert.deepEqual(r.dropped_types, []);
  });

  test("a type that is gone is dropped, not merely cleared, when its team is gone too", () => {
    const r = prunePortalRefs(s, { types: [2], teams: [] });
    assert.deepEqual(r.settings.types, [{ id: 2, team_id: null }]);
    assert.deepEqual(r.dropped_types, [1, 3]);
    assert.deepEqual(r.cleared_teams, [2]);
  });

  test("nothing stale: the same object back; a side left out is not checked", () => {
    assert.equal(prunePortalRefs(s, { types: [1, 2, 3], teams: [2, 3] }).settings, s);
    assert.equal(prunePortalRefs(s, {}).settings, s);
    assert.deepEqual(prunePortalRefs(s, { teams: [] }).dropped_types, []);
    assert.deepEqual(prunePortalRefs(s, { types: [] }).cleared_teams, []);
    assert.deepEqual(prunePortalRefs(DEFAULT_PORTAL_SETTINGS, { types: [], teams: [] }).settings.types, []);
  });

  test("the input is never changed", () => {
    const copy = JSON.stringify(s);
    prunePortalRefs(s, { types: [], teams: [] });
    assert.equal(JSON.stringify(s), copy);
  });
});

describe("pruneHelpCentreRefs", () => {
  const s = cleanHelpCentreSettings({ enabled: true, spaces: [10, 11, 12], order: ["s10", "c5", "s11", "c6"], hidden: ["s12", "c6"], tagged: true });

  test("helpCentreRefIds names the chosen spaces, the spaces and folders the keys name", () => {
    const r = helpCentreRefIds(s);
    assert.deepEqual(r.spaces.sort(), [10, 11, 12]);
    assert.deepEqual(r.categories.sort(), [5, 6]);
  });

  test("a deleted space leaves the chosen spaces and its s<id> key leaves order and hidden", () => {
    const r = pruneHelpCentreRefs(s, { spaces: [10, 11] });
    assert.deepEqual(r.settings.spaces, [10, 11]);
    assert.deepEqual(r.dropped, [12]);
    assert.deepEqual(r.settings.order, ["s10", "c5", "s11", "c6"]);
    assert.deepEqual(r.settings.hidden, ["c6"]);
    assert.deepEqual(r.dropped_keys, ["s12"]);
    assert.equal(r.changed, true);
    assert.equal(r.settings.tagged, true);
  });

  test("with the folders given, a deleted folder's c<id> key goes too", () => {
    const r = pruneHelpCentreRefs(s, { spaces: [10, 11, 12], categories: [5] });
    assert.deepEqual(r.settings.spaces, [10, 11, 12]);
    assert.deepEqual(r.dropped, []);
    assert.deepEqual(r.settings.order, ["s10", "c5", "s11"]);
    assert.deepEqual(r.settings.hidden, ["s12"]);
    assert.equal(r.changed, true);
  });

  test("nothing stale: unchanged, the same object back", () => {
    const r = pruneHelpCentreRefs(s, { spaces: [10, 11, 12], categories: [5, 6] });
    assert.equal(r.changed, false);
    assert.equal(r.settings, s);
    assert.equal(pruneHelpCentreRefs(DEFAULT_HELP_CENTRE_SETTINGS, { spaces: [] }).changed, false);
  });
});

// --- Against the database ------------------------------------------------------------

let lockClient: PoolClient;
const saved = new Map<string, string | null>();
const made = { teams: [] as number[], types: [] as number[], spaces: [] as number[], templates: [] as number[], rules: [] as number[] };

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool().query(sql, params)).rows as T[];
}

async function put(key: string, value: unknown): Promise<void> {
  if (!saved.has(key)) saved.set(key, (await getSetting(key)) ?? null);
  await q("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, JSON.stringify(value)]);
}

async function stored(key: string): Promise<Record<string, unknown>> {
  return JSON.parse((await getSetting(key)) ?? "null");
}

async function team(n: string): Promise<number> {
  const id = (await q<{ id: number }>("INSERT INTO hd_teams (name) VALUES ($1) RETURNING id", [`Stale ${n} ${STAMP}`]))[0].id;
  made.teams.push(id);
  return id;
}

async function type(n: string, teamId: number | null = null): Promise<number> {
  const id = (await q<{ id: number }>("INSERT INTO hd_request_types (slug, title, team_id) VALUES ($1, $2, $3) RETURNING id", [`stale-${n}-${STAMP}`, `Stale ${n} ${STAMP}`, teamId]))[0].id;
  made.types.push(id);
  return id;
}

async function space(n: string): Promise<number> {
  const id = (await q<{ id: number }>("INSERT INTO spaces (slug, name) VALUES ($1, $2) RETURNING id", [`stale-${n}-${STAMP}`, `Stale ${n} ${STAMP}`]))[0].id;
  made.spaces.push(id);
  return id;
}

before(async () => {
  await q("SELECT 1");
  // dbReady: the helpdesk schema exists before the fixtures.
  await (await import("../src/lib/db")).dbReady();
  lockClient = await pool().connect();
  await lockClient.query("SELECT pg_advisory_lock($1)", [LOCK]);
});

after(async () => {
  for (const [k, v] of saved) {
    if (v === null) await q("DELETE FROM settings WHERE key = $1", [k]);
    else await q("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [k, v]);
  }
  if (made.templates.length) await q("DELETE FROM hd_checklist_templates WHERE id = ANY($1::int[])", [made.templates]);
  for (const id of made.rules) await deleteAutomation(id);
  if (made.types.length) await q("DELETE FROM hd_request_types WHERE id = ANY($1::int[])", [made.types]);
  if (made.teams.length) await q("DELETE FROM hd_teams WHERE id = ANY($1::int[])", [made.teams]);
  if (made.spaces.length) await q("DELETE FROM spaces WHERE id = ANY($1::int[])", [made.spaces]);
  await lockClient.query("SELECT pg_advisory_unlock($1)", [LOCK]);
  lockClient.release();
  await pool().end();
});

describe("deleting prunes the settings in the same transaction", () => {
  test("a request type: it leaves the portal's offered types, the others stay as they were", async () => {
    const t = await team("rt");
    const gone = await type("gone");
    const kept = await type("kept");
    await put(HD_PORTAL_SETTINGS_KEY, { enabled: true, types: [{ id: gone, team_id: t }, { id: kept, team_id: t }], brand_name: "Acme" });
    const out: { portal?: PortalPruneResult | null } = {};
    assert.ok(await deleteRequestType(gone, out));
    assert.deepEqual(out.portal?.dropped_types, [gone], "what left the portal, for the delete's audit row");
    const s = await stored(HD_PORTAL_SETTINGS_KEY);
    assert.deepEqual(s.types, [{ id: kept, team_id: t }]);
    assert.equal(s.brand_name, "Acme");
    assert.equal(s.enabled, true);
  });

  test("a team: a type sent to it goes to its own team (team_id null) and stays offered", async () => {
    const gone = await team("gone");
    const other = await team("other");
    const a = await type("a", other);
    const b = await type("b");
    await put(HD_PORTAL_SETTINGS_KEY, { enabled: true, types: [{ id: a, team_id: gone }, { id: b, team_id: other }] });
    const out: { portal?: PortalPruneResult | null } = {};
    assert.ok(await deleteTeam(gone, out));
    assert.deepEqual(out.portal?.cleared_teams, [a]);
    assert.deepEqual((await stored(HD_PORTAL_SETTINGS_KEY)).types, [
      { id: a, team_id: null },
      { id: b, team_id: other },
    ]);
  });

  test("a space: it leaves the help centre's chosen spaces, with its category keys and its folders'", async () => {
    const gone = await space("gone");
    const kept = await space("kept");
    const folder = (await q<{ id: number }>("INSERT INTO space_categories (space_id, name) VALUES ($1, 'Guides') RETURNING id", [gone]))[0].id;
    await put(HD_HELP_CENTRE_SETTINGS_KEY, { enabled: true, from_spaces: true, spaces: [gone, kept], order: [`c${folder}`, `s${gone}`, `s${kept}`], hidden: [`s${gone}`], tagged: false });
    const res = await deleteSpace(gone);
    assert.equal(res.ok, true);
    assert.deepEqual(res.helpCentre?.dropped, [gone]);
    assert.deepEqual(res.helpCentre?.dropped_keys.sort(), [`c${folder}`, `s${gone}`].sort());
    const s = await stored(HD_HELP_CENTRE_SETTINGS_KEY);
    assert.deepEqual(s.spaces, [kept]);
    assert.deepEqual(s.order, [`s${kept}`]);
    assert.deepEqual(s.hidden, []);
    assert.equal(s.enabled, true);
  });

  test("a space that holds a document is refused, counted inside the delete's transaction, and stays", async () => {
    const full = await space("full");
    await q("INSERT INTO documents (space_id, title, slug, content, status, author) VALUES ($1, 'Kept', $2, '', 'draft', 'test')", [full, `kept-${STAMP}`]);
    const res = await deleteSpace(full);
    assert.deepEqual([res.ok, res.docCount], [false, 1]);
    assert.equal((await q("SELECT 1 FROM spaces WHERE id = $1", [full])).length, 1);
    await q("DELETE FROM documents WHERE space_id = $1", [full]);
  });

  test("a delete with no portal setting stored writes none", async () => {
    await put(HD_PORTAL_SETTINGS_KEY, {});
    await q("DELETE FROM settings WHERE key = $1", [HD_PORTAL_SETTINGS_KEY]);
    assert.ok(await deleteRequestType(await type("nosetting")));
    assert.equal(await getSetting(HD_PORTAL_SETTINGS_KEY), undefined);
  });
});

describe("a workspace already in the bad state heals on the next read", () => {
  test("portal: a stale request type and a stale team are cleaned and written back", async () => {
    const live = await type("live");
    const goneType = (await q<{ id: number }>("SELECT COALESCE(max(id), 0) + 1000 AS id FROM hd_request_types"))[0].id;
    const goneTeam = (await q<{ id: number }>("SELECT COALESCE(max(id), 0) + 1000 AS id FROM hd_teams"))[0].id;
    await put(HD_PORTAL_SETTINGS_KEY, { enabled: true, types: [{ id: goneType, team_id: null }, { id: live, team_id: goneTeam }], brand_name: "Acme" });
    const r = await healPortalSettings();
    assert.deepEqual(r.settings.types, [{ id: live, team_id: null }]);
    assert.deepEqual(r.dropped_types, [goneType]);
    assert.deepEqual(r.cleared_teams, [live]);
    const s = await stored(HD_PORTAL_SETTINGS_KEY);
    assert.deepEqual(s.types, [{ id: live, team_id: null }]);
    assert.equal(s.brand_name, "Acme");
    // Clean now: a second read changes nothing.
    const again = await healPortalSettings();
    assert.deepEqual(again.dropped_types, []);
    assert.deepEqual(again.cleared_teams, []);
  });

  test("portal: a stored value that is not JSON reads as the default and is left alone", async () => {
    await put(HD_PORTAL_SETTINGS_KEY, {});
    await q("UPDATE settings SET value = 'not json' WHERE key = $1", [HD_PORTAL_SETTINGS_KEY]);
    const r = await healPortalSettings();
    assert.deepEqual(r.settings.types, []);
    assert.equal(await getSetting(HD_PORTAL_SETTINGS_KEY), "not json");
  });

  test("help centre: a stale space is cleaned and written back", async () => {
    const kept = await space("hc-kept");
    const gone = (await q<{ id: number }>("SELECT COALESCE(max(id), 0) + 1000 AS id FROM spaces"))[0].id;
    await put(HD_HELP_CENTRE_SETTINGS_KEY, { enabled: true, from_spaces: true, spaces: [gone, kept], order: [`s${gone}`], hidden: [], tagged: true });
    const r = await healHelpCentreSettings();
    assert.deepEqual(r.settings.spaces, [kept]);
    assert.deepEqual(r.dropped, [gone]);
    const s = await stored(HD_HELP_CENTRE_SETTINGS_KEY);
    assert.deepEqual(s.spaces, [kept]);
    assert.deepEqual(s.order, []);
    assert.equal(s.tagged, true);
    assert.equal((await healHelpCentreSettings()).changed, false);
  });
});

describe("checklists: a request type deleted since it was chosen", () => {
  test("a save that leaves the list out, and publishing a draft that names it, drop it; a new unknown one refuses", async () => {
    const gone = await type("cl-gone");
    const kept = await type("cl-kept");
    const tpl = await createTemplate({ name: `Stale types ${STAMP}`, items: [{ title: "Check" }], request_type_ids: [gone, kept] }, { id: null, name: "Test" }, null);
    made.templates.push(tpl.id);
    // A waiting draft (as Claude saves one) that names the type too.
    await q("UPDATE hd_checklist_templates SET draft = $2::jsonb, draft_at = now() WHERE id = $1", [tpl.id, JSON.stringify({ name: `Stale types ${STAMP} v2`, items: [{ key: "a", title: "Check" }], request_type_ids: [gone] })]);
    await q("DELETE FROM hd_request_types WHERE id = $1", [gone]); // as 1.20.28 left it
    const row = (await listTemplateRows()).find((t) => t.id === tpl.id)!;
    assert.deepEqual(row.request_type_ids, [kept]);
    assert.deepEqual(row.draft?.request_type_ids, [], "the draft's deleted type is not shown either");
    const renamed = await updateTemplate(tpl.id, { name: `Stale types ${STAMP} renamed` }, { dept: null });
    assert.deepEqual(renamed!.after.request_type_ids, [kept]);
    const draftAt = (await q<{ draft_at: string }>("SELECT draft_at FROM hd_checklist_templates WHERE id = $1", [tpl.id]))[0].draft_at;
    const published = await updateTemplate(tpl.id, {}, { publishDraft: true, draftAt, dept: null });
    assert.deepEqual(published!.after.request_type_ids, []);
    await assert.rejects(updateTemplate(tpl.id, { request_type_ids: [2_000_000_000] }, { dept: null }), /request types no longer exists/);
  });
});

describe("automations: a team or request type deleted since the rule was saved", () => {
  test("automationStoredRefs names live and draft teams and types", () => {
    const r = automationStoredRefs({ conditions: { team_ids: [1], request_type_ids: [5] }, actions: { team_id: 2 } }, { conditions: { team_ids: [3] }, actions: {} }, null);
    assert.deepEqual([...r.teams].sort(), [1, 2, 3]);
    assert.deepEqual([...r.types], [5]);
  });

  test("validateAutomationInput: dropped beside others, refused with what to do when it was all, a dead move target dropped and said", async () => {
    const live = await team("au-live");
    const goneTeam = await team("au-gone");
    const liveType = await type("au-live");
    const goneType = await type("au-gone");
    await q("DELETE FROM hd_teams WHERE id = $1", [goneTeam]);
    await q("DELETE FROM hd_request_types WHERE id = $1", [goneType]);
    const stored = { teams: [goneTeam], types: [goneType] };
    const base = { name: `Rule ${STAMP}`, event: "ticket_created" };

    const both = await validateAutomationInput({ ...base, conditions: { team_ids: [goneTeam, live], request_type_ids: [goneType, liveType] }, actions: { priority: "high" } }, false, stored);
    assert.ok(both.ok);
    if (both.ok) {
      assert.deepEqual(both.value.conditions, { team_ids: [live], request_type_ids: [liveType] });
      assert.deepEqual(both.notices, []);
    }

    const onlyTeam = await validateAutomationInput({ ...base, conditions: { team_ids: [goneTeam] }, actions: { priority: "high" } }, false, stored);
    assert.deepEqual(onlyTeam, { ok: false, error: AUTOMATION_GONE.teamCondition });
    const onlyType = await validateAutomationInput({ ...base, conditions: { request_type_ids: [goneType] }, actions: { priority: "high" } }, false, stored);
    assert.deepEqual(onlyType, { ok: false, error: AUTOMATION_GONE.typeCondition });

    const move = await validateAutomationInput({ ...base, actions: { team_id: goneTeam, priority: "high" } }, false, stored);
    assert.ok(move.ok);
    if (move.ok) {
      assert.deepEqual(move.value.actions, { priority: "high" });
      assert.deepEqual(move.notices, [AUTOMATION_GONE.teamAction]);
    }
    const onlyMove = await validateAutomationInput({ ...base, actions: { team_id: goneTeam } }, false, stored);
    assert.deepEqual(onlyMove, { ok: false, error: AUTOMATION_GONE.teamOnlyAction });

    // Not named before: still unknown.
    assert.deepEqual(await validateAutomationInput({ ...base, conditions: { team_ids: [goneTeam, live] }, actions: { priority: "high" } }), { ok: false, error: "Unknown team." });
    assert.deepEqual(await validateAutomationInput({ ...base, conditions: { request_type_ids: [goneType, liveType] }, actions: { priority: "high" } }), { ok: false, error: "Unknown request type." });
  });

  test("a stored rule moving to a deleted team: the editor's save drops it and says so; publishing a draft naming it works", async () => {
    const live = await team("au2-live");
    const gone = await team("au2-gone");
    const rule = await createAutomation({ name: `Move ${STAMP}`, event: "ticket_created", conditions: { team_ids: [gone, live] }, actions: { team_id: gone, priority: "high" }, active: 0 }, null);
    made.rules.push(rule.id);
    await q("DELETE FROM hd_teams WHERE id = $1", [gone]); // as 1.20.28 left it
    const cur = (await getAutomation(rule.id))!;
    const v = await validateAutomationInput({ name: cur.name, event: cur.event, conditions: cur.conditions, actions: cur.actions }, true, automationStoredRefs(cur, cur.draft));
    assert.ok(v.ok);
    if (!v.ok) return;
    assert.deepEqual(v.notices, [AUTOMATION_GONE.teamAction]);
    const r = await updateAutomation(rule.id, v.value);
    assert.deepEqual(r!.after.conditions, { team_ids: [live] });
    assert.deepEqual(r!.after.actions, { priority: "high" });

    // A draft (as Claude saves one beside the live rule) naming the deleted team, then published.
    const gone2 = await team("au2-gone2");
    await q("UPDATE hd_automations SET draft = $2::jsonb, draft_at = now(), draft_base_at = updated_at WHERE id = $1", [
      rule.id,
      JSON.stringify({ name: cur.name, event: cur.event, conditions: { team_ids: [live] }, actions: { team_id: gone2, status: "open" } }),
    ]);
    await q("DELETE FROM hd_teams WHERE id = $1", [gone2]);
    const draftAt = (await q<{ draft_at: string }>("SELECT draft_at FROM hd_automations WHERE id = $1", [rule.id]))[0].draft_at;
    const pub = await updateAutomation(rule.id, {}, { publishDraft: true, draftAt });
    assert.deepEqual(pub!.after.actions, { status: "open" });
    assert.deepEqual(pub!.notices, [AUTOMATION_GONE.teamAction]);
  });
});

describe("checklists: an owner team deleted since it was chosen", () => {
  test("the next save drops the owner team instead of refusing; a team never named still refuses", async () => {
    const t = await team("owner");
    const tpl = await createTemplate({ name: `Stale owner ${STAMP}`, items: [{ title: "Ship it", team_id: t }], request_type_ids: [] }, { id: null, name: "Test" }, null);
    made.templates.push(tpl.id);
    assert.ok(await deleteTeam(t));
    const r = await updateTemplate(tpl.id, { name: `Stale owner ${STAMP} renamed` }, { dept: null });
    assert.ok(r);
    assert.equal(r!.after.items[0].team_id, undefined);
    await assert.rejects(updateTemplate(tpl.id, { items: [{ title: "Ship it", team_id: 2_000_000_000 }] }, { dept: null }), /owner teams no longer exists/);
  });
});
