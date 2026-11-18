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
// On the record: a delete names what it removed in its own audit row
// (portalPruneDetails / helpCentrePruneDetails), and a heal that wrote the
// stored value adds a helpdesk.portal.updated (or .help_centre_updated)
// row by the system (auditPortalHeal / auditHelpCentreHeal).
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
import { audit, actorFrom } from "../audit";
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
  /** Space ids that left the chosen spaces. */
  dropped: number[];
  /** Category keys ("s<id>", "c<id>") that left order and hidden. */
  dropped_keys: string[];
  changed: boolean;
}

/** What a heal answers: the clean settings, what it removed, and whether it wrote the stored value. */
export type PortalHeal = PortalPruneResult & { healed: boolean };
export type HelpCentreHeal = HelpCentrePruneResult & { healed: boolean };

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
export async function healPortalSettings(): Promise<PortalHeal> {
  const raw = await readStored(HD_PORTAL_SETTINGS_KEY);
  const first = await prunePortal(cleanPortalSettings(raw ?? DEFAULT_PORTAL_SETTINGS));
  if (raw === undefined || !portalChanged(first)) return { ...first, healed: false };
  const healed = await withTx(prunePortalSettingsTx);
  if (healed) return { ...healed, healed: true };
  // Someone else cleaned it meanwhile: what is stored now is clean.
  const now = await prunePortal(cleanPortalSettings((await readStored(HD_PORTAL_SETTINGS_KEY)) ?? DEFAULT_PORTAL_SETTINGS));
  return { ...now, dropped_types: [], cleared_teams: [], healed: false };
}

/** As healPortalSettings, for the help centre (helpdesk_portal_hc). */
export async function healHelpCentreSettings(): Promise<HelpCentreHeal> {
  const raw = await readStored(HD_HELP_CENTRE_SETTINGS_KEY);
  const first = await pruneHelpCentre(cleanHelpCentreSettings(raw ?? DEFAULT_HELP_CENTRE_SETTINGS));
  if (raw === undefined || !first.changed) return { ...first, healed: false };
  const healed = await withTx(pruneHelpCentreSettingsTx);
  if (healed) return { ...healed, healed: true };
  const now = await pruneHelpCentre(cleanHelpCentreSettings((await readStored(HD_HELP_CENTRE_SETTINGS_KEY)) ?? DEFAULT_HELP_CENTRE_SETTINGS));
  return { ...now, dropped: [], dropped_keys: [], changed: false, healed: false };
}

// --- Audit ------------------------------------------------------------------------------

/** What a prune removed from the portal settings, for a delete's audit details (empty when nothing). */
export function portalPruneDetails(r: PortalPruneResult | null | undefined): Record<string, number[]> {
  if (!r) return {};
  return {
    ...(r.dropped_types.length ? { portal_types_removed: r.dropped_types } : {}),
    ...(r.cleared_teams.length ? { portal_team_cleared_types: r.cleared_teams } : {}),
  };
}

/** As portalPruneDetails, for the help centre settings. */
export function helpCentrePruneDetails(r: HelpCentrePruneResult | null | undefined): Record<string, unknown> {
  if (!r) return {};
  return {
    ...(r.dropped.length ? { help_centre_spaces_removed: r.dropped } : {}),
    ...(r.dropped_keys.length ? { help_centre_keys_removed: r.dropped_keys } : {}),
  };
}

/**
 * A heal that wrote the stored value is on the record as the settings'
 * own change (helpdesk.portal.updated / helpdesk.portal.help_centre_updated),
 * by the system (nobody chose it), naming what it removed and whether a
 * read or a save of the settings page found it.
 */
export async function auditPortalHeal(h: PortalHeal, on: "read" | "save", ip?: string | null): Promise<void> {
  if (!h.healed) return;
  await audit({
    actor: actorFrom(null),
    action: "helpdesk.portal.updated",
    targetType: "helpdesk_portal",
    targetLabel: "Customer portal",
    details: { changed: ["types"], cleanup: on, ...portalPruneDetails(h), types: h.settings.types.map((t) => t.id) },
    ip: ip ?? null,
  });
}

export async function auditHelpCentreHeal(h: HelpCentreHeal, on: "read" | "save", ip?: string | null): Promise<void> {
  if (!h.healed) return;
  const changed = [...(h.dropped.length ? ["spaces"] : []), ...(h.dropped_keys.length ? ["order", "hidden"] : [])];
  await audit({
    actor: actorFrom(null),
    action: "helpdesk.portal.help_centre_updated",
    targetType: "helpdesk_portal",
    targetLabel: "Customer portal help centre",
    details: { changed, cleanup: on, ...helpCentrePruneDetails(h), spaces: h.settings.spaces },
    ip: ip ?? null,
  });
}
