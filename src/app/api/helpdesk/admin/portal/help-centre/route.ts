// GET /api/helpdesk/admin/portal/help-centre
//     → { settings, spaces, categories, stats, portal_on }
// PUT /api/helpdesk/admin/portal/help-centre  HelpCentreSettings
//     → the same shape, after saving
// POST /api/helpdesk/admin/portal/help-centre  { preview: HelpCentreSettings }
//     → { categories } for a selection not saved yet (nothing stored)
//
// Helpdesk 1.19.4 (C3), Desk settings → Customer portal → Help centre: on
// or off, what's public (chosen spaces and/or documents tagged public),
// the categories' order and which are switched off, search engine
// indexing, the home page (1.20.37: its greeting and the switches for
// Popular articles, Recently updated, Spaces and the request tiles), and
// the last 30 days' numbers. What is actually public is
// lib/helpdesk/help-centre publicHelpArticles; this route only stores the
// choices. Desk capability settings.manage. Audited as
// helpdesk.portal.help_centre_updated with { changed } (and the new value
// of enabled, the space ids, tagged, indexing, the greeting and each home
// section's switch when they changed).
//
// 1.20.30: a space that no longer exists is never a refusal. The read
// cleans the stored value (lib/helpdesk/portal-refs healHelpCentreSettings:
// the space, and its category keys, leave the settings and the cleaned
// value is written back), and a save drops a space id it can't name, as a
// deleted space or a private space this person was never shown: both read
// alike, so the answer says nothing about which private spaces exist.
// Category keys are kept only when already stored or of a space (or its
// folders) this person is shown. A heal that wrote the stored value is
// audited (lib/helpdesk/portal-refs auditHelpCentreHeal).

import { NextResponse } from "next/server";
import type { SessionUser } from "@/lib/types";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { badRequest } from "@/lib/helpdesk/routes";
import { getPortalSettings } from "@/lib/helpdesk/portal";
import { auditHelpCentreHeal, healHelpCentreSettings } from "@/lib/helpdesk/portal-refs";
import { hq } from "@/lib/helpdesk/db-core";
import {
  HC_HOME_SECTIONS,
  cleanHelpCentreSettings,
  helpCentreAdminCategories,
  helpCentreSpaceOptions,
  helpCentreStats,
  saveHelpCentreSettings,
  type HelpCentreSettings,
} from "@/lib/helpdesk/help-centre";

export const dynamic = "force-dynamic";

/**
 * The page's data. `spaces` names every space that is not private, and of
 * the private ones only those already chosen or that this person can open
 * (helpCentreSpaceOptions): settings.manage is a desk capability, never a
 * way to learn which private spaces exist.
 */
async function view(user: SessionUser, settings: HelpCentreSettings) {
  const portal = await getPortalSettings();
  const [spaces, categories, stats] = await Promise.all([helpCentreSpaceOptions(user, settings.spaces), helpCentreAdminCategories(settings, portal), helpCentreStats()]);
  return { settings, spaces, categories, stats, portal_on: portal.enabled };
}

export async function GET(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const healed = await healHelpCentreSettings();
  await auditHelpCentreHeal(healed, "read", ipFrom(req));
  return NextResponse.json(await view(gate, healed.settings));
}

export async function POST(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 64 * 1024);
  if (!b || typeof b.preview !== "object") return badRequest("Send the selection to preview.");
  return NextResponse.json({ categories: await helpCentreAdminCategories(cleanHelpCentreSettings(b.preview)) });
}

export async function PUT(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 64 * 1024);
  if (!b) return badRequest("Send the settings as JSON.");
  const sent = cleanHelpCentreSettings(b);
  const healed = await healHelpCentreSettings();
  await auditHelpCentreHeal(healed, "save", ipFrom(req));
  const stored = healed.settings;
  // A private space nobody showed this person reads as one that does not exist:
  // both drop out of the save (1.20.30; they were a refusal that no reload could clear).
  const spaces = await helpCentreSpaceOptions(gate, stored.spaces);
  const known = new Map(spaces.map((s) => [s.id, s]));
  // Category keys in order and hidden: the ones already stored (another admin's choice for a
  // space this person can't open stays), and the keys of the spaces this person is shown and
  // their folders. Nothing else is stored, so a save can't be used to learn which space or
  // folder ids exist (a stored key of one deleted later is cleaned up by the heal above).
  const folders = known.size ? await hq<{ id: number }>("SELECT id FROM space_categories WHERE space_id = ANY($1::int[])", [[...known.keys()]]) : [];
  const allowed = new Set([...stored.order, ...stored.hidden, ...[...known.keys()].map((id) => `s${id}`), ...folders.map((f) => `c${f.id}`)]);
  const next = {
    ...sent,
    spaces: sent.spaces.filter((id) => known.has(id)),
    order: sent.order.filter((k) => allowed.has(k)),
    hidden: sent.hidden.filter((k) => allowed.has(k)),
  };
  const priv = next.spaces.map((id) => known.get(id)!).find((s) => s.private);
  if (priv) return badRequest(`“${priv.name}” is a private space. Private spaces are never public: remove it from the Help Center.`);
  if (next.enabled && !next.tagged && !(next.from_spaces && next.spaces.length)) {
    return badRequest("Choose at least one space, or documents tagged public, before showing the Help Center.");
  }
  const { settings, changed } = await saveHelpCentreSettings(next);
  if (changed.length) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.portal.help_centre_updated",
      targetType: "helpdesk_portal",
      targetLabel: "Customer portal Help Center",
      details: {
        changed,
        ...(changed.includes("enabled") ? { enabled: settings.enabled } : {}),
        ...(changed.includes("spaces") || changed.includes("from_spaces") ? { from_spaces: settings.from_spaces, spaces: settings.spaces } : {}),
        ...(changed.includes("tagged") ? { tagged: settings.tagged } : {}),
        ...(changed.includes("indexing") ? { indexing: settings.indexing } : {}),
        ...(changed.includes("hidden") ? { hidden: settings.hidden } : {}),
        // 1.20.37: the home page's greeting and sections.
        ...(changed.includes("greeting") ? { greeting: settings.greeting } : {}),
        ...Object.fromEntries(HC_HOME_SECTIONS.filter((k) => changed.includes(k)).map((k) => [k, settings[k]])),
      },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json(await view(gate, settings));
}
