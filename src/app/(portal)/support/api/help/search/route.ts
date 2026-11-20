// GET  /support/api/help/search?q=…&j=<journey>   → { articles: HelpSuggestion[], types: HelpTypeSuggestion[] }
//      suggestions as you type in the Help Center's search box: at most six
//      in all (1.20.37), up to two of them the request types the portal
//      offers whose title or description matches (lib/helpdesk/portal
//      offeredTypes, the same list New request shows; none when nothing can
//      be raised, while the home's Request tiles are switched off, or, on a
//      portal that admits only some addresses, to anyone but a signed-in
//      contact it admits: help-centre requestTypesVisible), the rest
//      articles.
// POST /support/api/help/search  { q }             → { articles }
//      the request form's suggestions from its subject: the subject travels
//      in the body (never the address, so no proxy or access log keeps it)
//      and is never counted or stored.
// Customer portal help centre (Helpdesk 1.19.4, C3). Public: no sign-in
// needed. 404 while the help centre or the portal is off (it says nothing
// about the workspace). 40 a minute per network address (an IPv6 /64),
// 429 with its own sentence. Only the help centre's rule
// (lib/helpdesk/help-centre publicArticleScope) picks the articles. A GET
// is counted for the settings page's numbers only when the page itself
// asked (same origin), so a link from elsewhere cannot fill the stats; a
// POST must be same-origin.

import { ipFrom } from "@/lib/audit";
import {
  HC_LIMITS,
  cleanHelpQuery,
  getHelpCentreSettings,
  helpCentreOpen,
  helpSearchLimited,
  matchRequestTypes,
  newRequestHref,
  requestTypesVisible,
  searchHelpCentre,
  type HelpTypeSuggestion,
} from "@/lib/helpdesk/help-centre";
import { currentPortalContact, getPortalSettings, offeredTypes, portalNotFound, portalOriginRejection } from "@/lib/helpdesk/portal";
import { portalJson, readSmallJson } from "@/lib/helpdesk/portal-http";

export const dynamic = "force-dynamic";

const LIMITED = "Too many searches right now. Wait a moment and try again.";

async function open() {
  const [hc, portal] = await Promise.all([getHelpCentreSettings(), getPortalSettings()]);
  return (await helpCentreOpen({ hc, portal })) ? { hc, portal } : null;
}

export async function GET(req: Request) {
  const ctx = await open();
  if (!ctx) return portalNotFound();
  if (helpSearchLimited(ipFrom(req) ?? "unknown")) return portalJson({ error: LIMITED, limited: true }, 429);
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const form = url.searchParams.get("src") === "form";
  // Request types first in the budget (at most two), so a matching one always shows; articles fill the rest.
  // Nothing is looked up for a query too short to search (review M2).
  const asksTypes = !form && cleanHelpQuery(q).length >= 2 && ctx.hc.show_tiles && requestTypesVisible(ctx.portal, ctx.portal.access === "anyone" ? null : await currentPortalContact(ctx.portal));
  const types: HelpTypeSuggestion[] = asksTypes
    ? matchRequestTypes(await offeredTypes(ctx.portal), q, HC_LIMITS.suggestTypes).map((t) => ({ id: t.id, title: t.title, href: newRequestHref(t.id), icon: t.icon }))
    : [];
  const articles = await searchHelpCentre(
    q,
    {
      journey: url.searchParams.get("j") ?? "",
      // A page from before the POST form may still ask by address: never counted.
      source: form ? "form" : "home",
      record: portalOriginRejection(req) === null,
      limit: HC_LIMITS.suggest - types.length,
    },
    ctx
  );
  return portalJson({ articles, types });
}

export async function POST(req: Request) {
  const ctx = await open();
  if (!ctx) return portalNotFound();
  const cross = portalOriginRejection(req);
  if (cross) return cross;
  if (helpSearchLimited(ipFrom(req) ?? "unknown")) return portalJson({ error: LIMITED, limited: true }, 429);
  const b = await readSmallJson(req, 2048);
  if (!b) return portalJson({ error: "Send the words to look for." }, 400);
  const articles = await searchHelpCentre(b.q, { source: "form", record: false }, ctx);
  return portalJson({ articles });
}
