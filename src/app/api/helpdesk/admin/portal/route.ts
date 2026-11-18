// GET /api/helpdesk/admin/portal → { settings, types, teams, custom_domain, path }
// PUT /api/helpdesk/admin/portal  PortalSettings (brand_logo excepted: the
//     logo route sets it) → { settings, types }
//
// Helpdesk 1.19.1, Desk settings → Customer portal (agent V6): on or off,
// which request types outside customers can raise and the team each goes
// to, who can use it (anyone with an email, or approved domains), the
// brand, and protection (per-address limits, blocked words and domains).
// A request type that needs the directory (lib/helpdesk/portal
// portalBlockers) can't be exposed: 400 naming why. Desk capability
// settings.manage. Audited as helpdesk.portal.updated with { changed }.
//
// 1.20.30: a request type or team that no longer exists is never a refusal.
// The read cleans the stored value (lib/helpdesk/portal-refs
// healPortalSettings: a deleted type leaves the portal, a deleted portal
// team falls back to the type's own team, and the cleaned value is written
// back), and a save drops such entries from what was sent the same way, so
// a page opened before the delete still saves. A heal that wrote the stored
// value is audited by the system (lib/helpdesk/portal-refs auditPortalHeal).

import { NextResponse } from "next/server";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { readJson } from "@/lib/helpdesk/access";
import { hdCapGate } from "@/lib/helpdesk/roles";
import { badRequest } from "@/lib/helpdesk/routes";
import { hq } from "@/lib/helpdesk/db-core";
import { getAppSettings } from "@/lib/settings-store";
import {
  PORTAL_BLOCKER_TEXT,
  PORTAL_PATH,
  cleanPortalSettings,
  portalTypeOptions,
  prunePortalRefs,
  savePortalSettings,
} from "@/lib/helpdesk/portal";
import { auditPortalHeal, healPortalSettings } from "@/lib/helpdesk/portal-refs";

export const dynamic = "force-dynamic";

async function extras() {
  const [teams, app] = await Promise.all([
    hq<{ id: number; name: string }>("SELECT id, name FROM hd_teams ORDER BY position, name, id"),
    getAppSettings().catch(() => ({ custom_domain: "" })),
  ]);
  // 1.20.27 (security review app H1): the address mail links use; null: the portal sends no sign-in links.
  const { workspaceOrigin } = await import("@/lib/workspace-origin");
  return { teams, custom_domain: app.custom_domain || "", workspace_address: await workspaceOrigin(), path: PORTAL_PATH };
}

export async function GET(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const healed = await healPortalSettings();
  await auditPortalHeal(healed, "read", ipFrom(req));
  const { settings } = healed;
  return NextResponse.json({ settings, types: await portalTypeOptions(settings), ...(await extras()) });
}

export async function PUT(req: Request) {
  const gate = await hdCapGate("settings.manage");
  if (gate instanceof NextResponse) return gate;
  const b = await readJson(req, 64 * 1024);
  if (!b) return badRequest("Send the settings as JSON.");
  const healed = await healPortalSettings();
  await auditPortalHeal(healed, "save", ipFrom(req));
  const before = healed.settings;
  const options = await portalTypeOptions(before);
  const teamIds = (await hq<{ id: number }>("SELECT id FROM hd_teams")).map((r) => r.id);
  // The logo is the logo route's: whatever the body says, keep the stored one.
  // A request type or team deleted since the page loaded drops out (1.20.30).
  const { settings: next } = prunePortalRefs(cleanPortalSettings({ ...b, brand_logo: before.brand_logo }), { types: options.map((o) => o.id), teams: teamIds });
  for (const t of next.types) {
    const o = options.find((x) => x.id === t.id)!;
    if (o.blockers.length) return badRequest(`“${o.title}” can't be offered to outside customers: ${PORTAL_BLOCKER_TEXT[o.blockers[0]].toLowerCase()}`);
  }
  if (next.access === "domains" && next.domains.length === 0) return badRequest("Add at least one approved domain, or let anyone with an email use the portal.");
  if (next.enabled && next.types.length === 0) return badRequest("Choose at least one thing customers can ask for before turning the portal on.");
  const { settings, changed } = await savePortalSettings(next);
  if (changed.length) {
    await audit({
      actor: actorFrom(gate),
      action: "helpdesk.portal.updated",
      targetType: "helpdesk_portal",
      targetLabel: "Customer portal",
      details: {
        changed,
        ...(changed.includes("enabled") ? { enabled: settings.enabled } : {}),
        ...(changed.includes("access") ? { access: settings.access } : {}),
        ...(changed.includes("types") ? { types: settings.types.map((t) => t.id) } : {}),
      },
      ip: ipFrom(req),
    });
  }
  return NextResponse.json({ settings, types: await portalTypeOptions(settings), ...(await extras()) });
}
