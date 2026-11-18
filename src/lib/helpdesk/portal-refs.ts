// Helpdesk 1.20.30: the customer portal's settings never hold a request
// type, team or space that no longer exists. Server-only.
//
// The bug (seen on 1.20.28): a request type offered in the portal and
// then deleted stayed in the helpdesk_portal setting's `types`. The page
// draws a row only for types that exist, so the stale entry could not be
// seen or unticked, it went back with every save, and the save refused it
// ("One of the request types no longer exists. Reload the page.") for
// good. The same trap held a deleted team named as a type's portal team
// and a deleted space chosen for the help centre (helpdesk_portal_hc).
//
// Two halves:
//   - Deleting a request type, team or space prunes both settings in the
//     delete's own transaction (lib/helpdesk/request-types
//     deleteRequestType, lib/helpdesk/teams deleteTeam, lib/db deleteSpace).
//   - Reading the settings page heals a workspace already in that state
//     (healPortalSettings, healHelpCentreSettings): the stale entries are
//     dropped and the cleaned value is written back. Only an entry naming
//     a row that is gone is touched (ids are never reused), so nothing a
//     person chose is lost; the write happens only when something was
//     stale, under the setting row's lock, re-checked inside it.
//
// The rules themselves are pure (portal-shared prunePortalRefs,
// help-centre-shared pruneHelpCentreRefs). A request type whose portal
// team is gone stays offered and goes to the type's own team (team_id
// null), as offeredTypes already routed it at request time.
//
// The settings' keys live here (portal.ts and help-centre.ts re-export
// them) so the delete paths can reach them without loading the portal.
// Neither key is a sealed setting (lib/db SENSITIVE_SETTINGS): the value
// is read and written as it is stored.

import "server-only";
import type { PoolClient } from "pg";
import { hq, withTx, type HdQueryable } from "./db-core";
import { DEFAULT_PORTAL_SETTINGS, cleanPortalSettings, prunePortalRefs, type PortalSettings } from "./portal-shared";
import { DEFAULT_HELP_CENTRE_SETTINGS, cleanHelpCentreSettings, helpCentreRefIds, pruneHelpCentreRefs, type HelpCentreSettings } from "./help-centre-shared";

export const HD_PORTAL_SETTINGS_KEY = "helpdesk_portal";
export const HD_HELP_CENTRE_SETTINGS_KEY = "helpdesk_portal_hc";

/** The setting as stored, parsed; undefined when there is none or it is not JSON (it reads as the default then). */
async function readStored(key: string, client?: HdQueryable, lock = false): Promise<unknown> {
  const rows = await hq<{ value: string }>(`SELECT value FROM settings WHERE key = $1${lock ? " FOR UPDATE" : ""}`, [key], client);
  if (!rows[0]) return undefined;
  try {
    return JSON.parse(rows[0].value);
  } catch {
    return undefined;
  }
}

async function liveIds(table: "hd_request_types" | "hd_teams" | "spaces" | "space_categories", ids: number[], client?: HdQueryable): Promise<number[]> {
  if (!ids.length) return [];
  return (await hq<{ id: number }>(`SELECT id FROM ${table} WHERE id = ANY($1::int[])`, [ids], client)).map((r) => r.id);
}

export interface PortalPruneResult {
  settings: PortalSettings;
  dropped_types: number[];
  cleared_teams: number[];
}

async function prunePortal(s: PortalSettings, client?: HdQueryable): Promise<PortalPruneResult> {
  const teamIds = [...new Set(s.types.map((t) => t.team_id).filter((x): x is number => x !== null))];
  // One after the other: inside a transaction both go through the one client.
  const types = await liveIds("hd_request_types", s.types.map((t) => t.id), client);
  const teams = await liveIds("hd_teams", teamIds, client);
  return prunePortalRefs(s, { types, teams });
}

export interface HelpCentrePruneResult {
  settings: HelpCentreSettings;
  dropped: number[];
  changed: boolean;
}

async function pruneHelpCentre(s: HelpCentreSettings, client?: HdQueryable): Promise<HelpCentrePruneResult> {
  const refs = helpCentreRefIds(s);
  const spaces = await liveIds("spaces", refs.spaces, client);
  const categories = await liveIds("space_categories", refs.categories, client);
  return pruneHelpCentreRefs(s, { spaces, categories });
}

const portalChanged = (r: PortalPruneResult) => r.dropped_types.length > 0 || r.cleared_teams.length > 0;

/**
 * In the caller's transaction (after its DELETE): drop every request type
 * that is gone from the portal's offered types and every portal team that
 * is gone, and write the setting back when that changed anything. The
 * setting's row is locked until the caller commits.
 */
export async function prunePortalSettingsTx(client: PoolClient): Promise<PortalPruneResult | null> {
  const raw = await readStored(HD_PORTAL_SETTINGS_KEY, client, true);
  if (raw === undefined) return null;
  const r = await prunePortal(cleanPortalSettings(raw), client);
  if (!portalChanged(r)) return null;
  await client.query("UPDATE settings SET value = $2 WHERE key = $1", [HD_PORTAL_SETTINGS_KEY, JSON.stringify(r.settings)]);
  return r;
}

/** As prunePortalSettingsTx, for the help centre's chosen spaces and category keys. */
export async function pruneHelpCentreSettingsTx(client: PoolClient): Promise<HelpCentrePruneResult | null> {
  const raw = await readStored(HD_HELP_CENTRE_SETTINGS_KEY, client, true);
  if (raw === undefined) return null;
  const r = await pruneHelpCentre(cleanHelpCentreSettings(raw), client);
  if (!r.changed) return null;
  await client.query("UPDATE settings SET value = $2 WHERE key = $1", [HD_HELP_CENTRE_SETTINGS_KEY, JSON.stringify(r.settings)]);
  return r;
}

/**
 * The portal settings with nothing stale in them (the settings route's
 * read and save). A workspace whose stored value names a deleted request
 * type or team is cleaned for good here: checked without a lock first, and
 * only when something is stale, pruned again under the row's lock and
 * written back.
 */
export async function healPortalSettings(): Promise<PortalPruneResult> {
  const raw = await readStored(HD_PORTAL_SETTINGS_KEY);
  const first = await prunePortal(cleanPortalSettings(raw ?? DEFAULT_PORTAL_SETTINGS));
  if (raw === undefined || !portalChanged(first)) return first;
  const healed = await withTx(prunePortalSettingsTx);
  if (healed) return healed;
  // Someone else cleaned it meanwhile: what is stored now is clean.
  return prunePortal(cleanPortalSettings((await readStored(HD_PORTAL_SETTINGS_KEY)) ?? DEFAULT_PORTAL_SETTINGS));
}

/** As healPortalSettings, for the help centre (helpdesk_portal_hc). */
export async function healHelpCentreSettings(): Promise<HelpCentrePruneResult> {
  const raw = await readStored(HD_HELP_CENTRE_SETTINGS_KEY);
  const first = await pruneHelpCentre(cleanHelpCentreSettings(raw ?? DEFAULT_HELP_CENTRE_SETTINGS));
  if (raw === undefined || !first.changed) return first;
  const healed = await withTx(pruneHelpCentreSettingsTx);
  if (healed) return healed;
  return pruneHelpCentre(cleanHelpCentreSettings((await readStored(HD_HELP_CENTRE_SETTINGS_KEY)) ?? DEFAULT_HELP_CENTRE_SETTINGS));
}
