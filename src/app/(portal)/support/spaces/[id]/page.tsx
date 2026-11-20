// /support/spaces/<id>: one space's articles in the Help Center (1.20.37),
// where a space card's "See all" goes. Only what the Help Center's rule
// makes public (lib/helpdesk/help-centre helpCentreSpace, through
// publicArticleScope), grouped by category in the admin's order. A space
// with nothing public, a private one, or an unknown number is the portal's
// 404, like a category. The description shows only for a space the admin
// chose (a space reached only through documents tagged public shows its
// name alone). Indexed exactly when categories are.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPortalSettings, offeredTypes } from "@/lib/helpdesk/portal";
import { articleCount, categoryHref, getHelpCentreSettings, helpCentreSpace, spaceIdFrom } from "@/lib/helpdesk/help-centre";
import { ArticleRows, HelpBack, StillNeedHelp } from "@/components/helpdesk/portal/help/HelpCentre";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

async function load(segment: string) {
  const id = spaceIdFrom(segment);
  if (!id) return null;
  const [hc, portal] = await Promise.all([getHelpCentreSettings(), getPortalSettings()]);
  const space = await helpCentreSpace(id, { hc, portal });
  return space ? { space, hc, portal } : null;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  try {
    const got = await load((await params).id);
    if (got) return { title: got.space.name, robots: got.hc.indexing ? { index: true, follow: true } : { index: false, follow: false, nocache: true } };
  } catch {
    /* no database: the layout's defaults */
  }
  return { title: "Help Center" };
}

export default async function HelpSpacePage({ params }: { params: Params }) {
  const got = await load((await params).id);
  if (!got) notFound();
  const { space, portal } = got;
  const canRaise = (await offeredTypes(portal)).length > 0;
  const grouped = space.categories.length > 1;
  return (
    <div className="mx-auto mt-6 w-full max-w-3xl sm:mt-8">
      <HelpBack />
      <h1 className="mt-2 break-words text-2xl font-bold text-slate-900">{space.name}</h1>
      {space.description && <p className="mt-1 text-base text-slate-600">{space.description}</p>}
      <p className="mt-1 text-sm text-slate-500">{articleCount(space.total)}</p>
      <div className="mt-5 space-y-6">
        {space.categories.map((c) => (
          <section key={c.key} aria-labelledby={grouped ? `hc-cat-${c.key}` : undefined}>
            {grouped && (
              <h2 id={`hc-cat-${c.key}`} className="mb-2 text-lg font-semibold text-slate-900">
                <Link href={categoryHref(c.key)} className="hover:text-compass-700">
                  {c.name}
                </Link>
              </h2>
            )}
            <ArticleRows articles={c.articles} label={`Articles in ${c.name}`} />
          </section>
        ))}
      </div>
      {space.total > space.shown && (
        <p className="mt-3 text-sm text-slate-500" role="note">
          Showing the first {space.shown.toLocaleString("en")} of {space.total.toLocaleString("en")}. Search to find the others.
        </p>
      )}
      <StillNeedHelp canRaise={canRaise} className="mt-6" />
    </div>
  );
}
