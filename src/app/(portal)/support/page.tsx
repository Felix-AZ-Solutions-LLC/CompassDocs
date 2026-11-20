// /support: the customer portal's home (Helpdesk 1.19.1, mock #13).
// With the Help Center on (1.19.4, C3, mock h1) it is the Help Center for
// everyone, signed in or not; the sign-in form then answers at
// /support?signin=1 and wherever a page sends someone to sign in
// (?next=…, ?expired=1). With it off, the home is the sign-in as before.
// Signed in already, on the sign-in form: straight to ?next, else to Your
// requests.
//
// 1.20.37: the home is a branded header band and its sections (Popular
// articles, Recently updated, Spaces, the request tiles), each through the
// Help Center's one rule (lib/helpdesk/help-centre helpCentreHome) and each
// switched on or off in Desk settings → Customer portal → Help Center. The
// tiles are the request types the portal offers (offeredTypes: its
// configured order, the admin's choice, nothing a type's visibility or
// directory needs blocks), shown whenever something can be raised: the
// rule "Still need help?" follows, signed in or not (a signed-out visitor
// signs in first and comes back to the chosen form). Review M2: while the
// portal admits only some addresses (access "domains"), the catalog is
// shown only to a signed-in contact the rule admits (currentPortalContact
// re-checks it); a signed-out visitor sees the header's Sign in instead.

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cleanNextPath, currentPortalContact, getPortalSettings, offeredTypes, portalBrand, portalOpen } from "@/lib/helpdesk/portal";
import { HC_LIMITS, getHelpCentreSettings, helpCentreHome, helpCentreOpen, helpGreeting, requestTypesVisible } from "@/lib/helpdesk/help-centre";
import { PortalSignIn } from "@/components/helpdesk/portal/PortalSignIn";
import { HelpCentreHome } from "@/components/helpdesk/portal/help/HelpCentre";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

/** The Help Center home, rather than the sign-in form. */
function wantsHome(sp: SP): boolean {
  return sp.next === undefined && sp.signin === undefined && sp.expired === undefined;
}

export async function generateMetadata({ searchParams }: { searchParams: Promise<SP> }): Promise<Metadata> {
  try {
    const sp = await searchParams;
    const [hc, portal] = await Promise.all([getHelpCentreSettings(), getPortalSettings()]);
    if (wantsHome(sp) && (await helpCentreOpen({ hc, portal }))) {
      return { title: "Help Center", robots: hc.indexing ? { index: true, follow: true } : { index: false, follow: false, nocache: true } };
    }
  } catch {
    /* no database: the layout's defaults */
  }
  return { title: "Sign in" };
}

export default async function PortalHome({ searchParams }: { searchParams: Promise<SP> }) {
  const settings = await getPortalSettings();
  if (!(await portalOpen(settings))) notFound();
  const sp = await searchParams;
  const hc = await getHelpCentreSettings();
  if (wantsHome(sp) && (await helpCentreOpen({ hc, portal: settings }))) {
    const ctx = { hc, portal: settings };
    const [home, types, brand, contact] = await Promise.all([helpCentreHome(ctx), offeredTypes(settings), portalBrand(settings), currentPortalContact(settings)]);
    const canRaise = types.length > 0;
    const tiles = hc.show_tiles && requestTypesVisible(settings, contact) ? types : [];
    return (
      <HelpCentreHome
        brand={{ name: brand.name, logoUrl: brand.logo_url }}
        greeting={helpGreeting(hc)}
        tiles={tiles.slice(0, HC_LIMITS.tiles).map((t) => ({ id: t.id, title: t.title, description: t.description, icon: t.icon }))}
        moreTiles={tiles.length > HC_LIMITS.tiles}
        popular={home.popular}
        recent={home.recent}
        spaces={home.spaces}
        categories={home.categories}
        total={home.total}
        canRaise={canRaise}
      />
    );
  }
  const next = cleanNextPath(typeof sp.next === "string" ? sp.next : "");
  if (await currentPortalContact(settings)) redirect(next || "/support/requests");
  return <PortalSignIn next={next} />;
}
