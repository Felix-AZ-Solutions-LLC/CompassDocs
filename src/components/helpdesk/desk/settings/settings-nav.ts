// Where the desk's Settings entry and its redirects go, from the desk
// settings registry (1.20.13, lib/helpdesk/desk-settings-registry, which
// replaced this file's own list of pages and capabilities). Plain module:
// the server layouts and redirects read it.

import { DESK_SETTINGS_HOME, DESK_SETTINGS_PAGES, deskSettingsGroups, type DeskSettingsViewer } from "@/lib/helpdesk/desk-settings-registry";

/** The viewer the registry reads: desk capabilities, and the CompassDocs settings sections a desk page links to. */
export function deskSettingsViewer(caps: readonly string[], adminSections: readonly string[] = []): DeskSettingsViewer {
  return { caps, adminSections: adminSections.filter((h) => DESK_SETTINGS_PAGES.some((p) => p.adminSection === h)) };
}

/**
 * Where the desk's Settings entry goes: the settings overview, which lists
 * every section this person's role reaches (1.20.13; it used to be the
 * first page of the rail). Every desk user reaches Notifications at least.
 */
export function firstSettingsHref(caps: readonly string[]): string {
  return deskSettingsGroups({ caps }).length > 0 ? DESK_SETTINGS_HOME : `${DESK_SETTINGS_HOME}/notifications`;
}
