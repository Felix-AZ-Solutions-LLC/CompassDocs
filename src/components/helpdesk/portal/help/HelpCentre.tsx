// The customer portal's Help Center (Helpdesk 1.19.4, C3, mock h1 at 1440
// and 390). Server-safe pieces: the home, the article list a category, a
// space or a search shows, and the "Still need help?" card. Everything they
// show came through lib/helpdesk/help-centre (publicArticleScope).
//
// The home (1.20.37): a branded header band (the portal's logo or initials,
// its name, the admin's greeting and the big search) on the workspace
// accent, then, each only when it has something and the admin left it on
// (Desk settings → Customer portal → Help Center → Home page): "What do you
// need?" (the request types the portal offers, as tiles that open their
// form), Popular articles and Recently updated (side by side when both
// show), and a card per space with its top articles (or, with Spaces off,
// the categories as before); then "Still need help?".

import Link from "next/link";
import { ArrowRight, BookOpen, ChevronLeft, ChevronRight, Clock, TrendingUp } from "lucide-react";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/form";
import { articleCount, categoryHref, newRequestHref, spaceHref, type HelpSuggestion } from "@/lib/helpdesk/help-centre-shared";
import { requestTypeIcon } from "@/components/helpdesk/help/request-type-icon";
import { HelpSearch } from "./HelpSearch";
import { ArticleDate, ArticleLink } from "./HelpBits";
import { PortalLogo } from "../PortalLogo";

export interface HomeCategory {
  key: string;
  name: string;
  count: number;
}

export interface HomeTile {
  id: number;
  title: string;
  description: string;
  icon: string;
}

export interface HomeSpace {
  id: number;
  name: string;
  description: string;
  count: number;
  top: HelpSuggestion[];
}

export interface HelpHomeProps {
  brand: { name: string; logoUrl: string | null };
  greeting: string;
  /** The request types to show as tiles (at most HC_LIMITS.tiles), and whether there are more. */
  tiles: HomeTile[];
  moreTiles: boolean;
  popular: HelpSuggestion[];
  recent: (HelpSuggestion & { updated_at: string })[];
  spaces: HomeSpace[];
  /** The categories as cards: all of them with Spaces off, else those of the spaces without a card. */
  categories: HomeCategory[];
  /** Public articles in all (0: the "No articles yet" card). */
  total: number;
  canRaise: boolean;
}

/**
 * The header band: full width (the portal's main pads its sides; this
 * cancels them), the accent wash from `.hc-band` in globals.css
 * (rgb(var(--compass-*)), so a custom accent and every dark style follow).
 */
function HeaderBand({ brand, greeting }: { brand: HelpHomeProps["brand"]; greeting: string }) {
  return (
    <section
      aria-labelledby="hc-greeting"
      data-help-section="band"
      className="hc-band -mx-4 border-b border-slate-200 px-4 pb-9 pt-8 text-center sm:-mx-6 sm:px-6 sm:pb-12 sm:pt-11 print:border-b-0 print:px-0 print:pb-4 print:pt-0"
    >
      <div className="mx-auto flex w-full max-w-xl flex-col items-center">
        <div className="flex max-w-full items-center gap-3">
          <PortalLogo name={brand.name} logoUrl={brand.logoUrl} size="lg" />
          <span className="min-w-0 truncate text-base font-semibold text-slate-800" data-testid="hc-band-name">
            {brand.name}
          </span>
        </div>
        <h1 id="hc-greeting" className="mt-4 break-words text-2xl font-bold text-slate-900 sm:text-[1.75rem]">
          {greeting}
        </h1>
        <HelpSearch className="mt-5 print:hidden" />
      </div>
    </section>
  );
}

/** A section heading with its icon, and an optional link on the right. */
function SectionTitle({ id, icon, children, action }: { id: string; icon?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 id={id} className="flex items-center gap-2 text-lg font-semibold text-slate-900">
        {icon}
        {children}
      </h2>
      {action}
    </div>
  );
}

/** "What do you need?": a tile per request type, each starting that type's form. */
function RequestTiles({ tiles, more }: { tiles: HomeTile[]; more: boolean }) {
  return (
    <section aria-labelledby="hc-tiles" data-help-section="tiles" className="print:hidden">
      <SectionTitle
        id="hc-tiles"
        action={
          more ? (
            <Link href="/support/new" className="inline-flex items-center gap-1 text-sm font-medium text-compass-700 hover:underline">
              More<span className="sr-only"> things you can ask for</span>
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          ) : null
        }
      >
        What do you need?
      </SectionTitle>
      <ul className="grid grid-cols-1 gap-3 min-[30rem]:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => {
          const Icon = requestTypeIcon(t.icon);
          return (
            <li key={t.id} className="min-w-0">
              <Link
                href={newRequestHref(t.id)}
                className="flex h-full items-start gap-3 rounded-xl border border-slate-200 bg-surface p-4 shadow-xs transition hover:border-compass-300 hover:bg-slate-50"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-compass-50 text-compass-700">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block break-words font-semibold text-slate-900">{t.title}</span>
                  {t.description && <span className="mt-0.5 line-clamp-2 block text-sm text-slate-500">{t.description}</span>}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Popular articles / Recently updated: a card of article rows, the title in it. */
function ArticleCard({
  id,
  section,
  title,
  icon,
  rows,
}: {
  id: string;
  section: string;
  title: string;
  icon: React.ReactNode;
  rows: (HelpSuggestion & { updated_at?: string })[];
}) {
  return (
    <section aria-labelledby={id} data-help-section={section} className="min-w-0 rounded-xl border border-slate-200 bg-surface shadow-xs break-inside-avoid">
      <h2 id={id} className="flex items-center gap-2 px-4 pb-1 pt-4 text-lg font-semibold text-slate-900">
        {icon}
        {title}
      </h2>
      <ol className="px-2 pb-2">
        {rows.map((a) => (
          <li key={a.id}>
            <ArticleLink href={a.href} className="flex items-start gap-2.5 rounded-lg px-2 py-2 transition hover:bg-slate-50">
              <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-compass-600" aria-hidden />
              <span className="min-w-0">
                <span className="block break-words font-medium text-slate-900">{a.title}</span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  {a.space}
                  {a.updated_at && (
                    <>
                      {" · Updated "}
                      <ArticleDate value={a.updated_at} />
                    </>
                  )}
                </span>
              </span>
            </ArticleLink>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** A card per space: its name, description, count, top articles and "See all". */
function SpaceCards({ spaces }: { spaces: HomeSpace[] }) {
  return (
    <section aria-labelledby="hc-spaces" data-help-section="spaces">
      <SectionTitle id="hc-spaces">Browse by space</SectionTitle>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {spaces.map((x) => (
          <li key={x.id} className="flex min-w-0 flex-col rounded-xl border border-slate-200 bg-surface p-4 shadow-xs break-inside-avoid" data-help-space={x.id}>
            <h3 className="break-words text-base font-semibold text-slate-900">
              <Link href={spaceHref(x.id)} className="hover:text-compass-700">
                {x.name}
              </Link>
            </h3>
            <p className="mt-0.5 text-xs text-slate-500">{articleCount(x.count)}</p>
            {x.description && <p className="mt-2 line-clamp-2 text-sm text-slate-600">{x.description}</p>}
            {x.top.length > 0 && (
              <ul className="mt-3 space-y-1 border-t border-slate-100 pt-2.5" aria-label={`Top articles in ${x.name}`}>
                {x.top.map((a) => (
                  <li key={a.id}>
                    <ArticleLink href={a.href} className="flex items-start gap-2 rounded-md py-1 text-sm text-slate-700 hover:text-compass-700">
                      <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-compass-600" aria-hidden />
                      <span className="min-w-0 break-words">{a.title}</span>
                    </ArticleLink>
                  </li>
                ))}
              </ul>
            )}
            <Link href={spaceHref(x.id)} className="mt-auto inline-flex items-center gap-1 self-start pt-3 text-sm font-medium text-compass-700 hover:underline print:hidden">
              See all<span className="sr-only"> {articleCount(x.count)} in {x.name}</span>
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The categories as cards: the 1.19.4 home (with Spaces off), or, under the
 * space cards, "More topics": the categories of spaces without a card (one
 * whose name may not be shown, or one past the cards' cap).
 */
function CategoryCards({ categories, title }: { categories: HomeCategory[]; title?: string }) {
  return (
    <nav aria-label={title ?? "Categories"} data-help-section="categories">
      {title && <SectionTitle id="hc-topics">{title}</SectionTitle>}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-3.5">
        {categories.map((c) => (
          <li key={c.key} className="min-w-0">
            <Link
              href={categoryHref(c.key)}
              className="block h-full rounded-xl border border-slate-200 bg-surface p-4 transition hover:border-compass-300 hover:bg-slate-50"
            >
              <span className="block hyphens-auto break-words font-semibold text-slate-900">{c.name}</span>
              <span className="mt-0.5 block text-[0.8rem] text-slate-500">{articleCount(c.count)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function HelpCentreHome(p: HelpHomeProps) {
  const lists = [
    p.popular.length > 0 && <ArticleCard key="popular" id="hc-popular" section="popular" title="Popular articles" icon={<TrendingUp className="h-4 w-4 text-compass-600" aria-hidden />} rows={p.popular} />,
    p.recent.length > 0 && <ArticleCard key="recent" id="hc-recent" section="recent" title="Recently updated" icon={<Clock className="h-4 w-4 text-compass-600" aria-hidden />} rows={p.recent} />,
  ].filter(Boolean);
  return (
    <>
      <HeaderBand brand={p.brand} greeting={p.greeting} />
      <div className="mx-auto mt-7 flex w-full max-w-5xl flex-col gap-8 sm:mt-8">
        {p.canRaise && p.tiles.length > 0 && <RequestTiles tiles={p.tiles} more={p.moreTiles} />}
        {p.total === 0 ? (
          <EmptyState icon={<BookOpen />} title="No articles yet" body="Articles appear here once they're published. Search above, or raise a request." />
        ) : (
          <>
            {lists.length > 0 && <div className="grid grid-cols-1 gap-6 md:grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))]">{lists}</div>}
            {p.spaces.length > 0 && <SpaceCards spaces={p.spaces} />}
            {p.categories.length > 0 && <CategoryCards categories={p.categories} title={p.spaces.length > 0 ? "More topics" : undefined} />}
          </>
        )}
        <StillNeedHelp canRaise={p.canRaise} />
      </div>
    </>
  );
}

/** "Still need help? Raise a request and we'll get back to you by email." with New request; nothing when nothing can be raised. */
export function StillNeedHelp({ canRaise, className = "" }: { canRaise: boolean; className?: string }) {
  if (!canRaise) return null;
  return (
    <div className={`flex items-center gap-3 rounded-xl border border-slate-200 bg-surface px-4 py-4 sm:px-5 print:hidden ${className}`.trim()}>
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold text-slate-900">Still need help?</h2>
        <p className="text-sm text-slate-500">Raise a request and we&apos;ll get back to you by email.</p>
      </div>
      <Button href="/support/new" className="shrink-0">
        New request
      </Button>
    </div>
  );
}

/** Back to the Help Center's home. */
export function HelpBack({ href = "/support", label = "Help Center" }: { href?: string; label?: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-compass-700 print:hidden">
      <ChevronLeft className="h-4 w-4" aria-hidden /> {label}
    </Link>
  );
}

/** Articles as rows: the title (a link) and its summary, with the category when asked. */
export function ArticleRows({ articles, label, showCategory = false }: { articles: HelpSuggestion[]; label: string; showCategory?: boolean }) {
  return (
    <ul className="overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-xs" aria-label={label}>
      {articles.map((a) => (
        <li key={a.id} className="border-b border-slate-100 last:border-b-0">
          <ArticleLink href={a.href} className="flex items-start gap-2.5 px-4 py-3.5 transition hover:bg-slate-50 sm:px-5">
            <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-compass-600" aria-hidden />
            <span className="min-w-0">
              <span className="block font-semibold text-slate-900">{a.title}</span>
              {(a.summary || showCategory) && (
                <span className="mt-0.5 line-clamp-2 block text-sm text-slate-500">
                  {showCategory && <span className="font-medium text-slate-600">{a.category}</span>}
                  {showCategory && a.summary && " · "}
                  {a.summary}
                </span>
              )}
            </span>
          </ArticleLink>
        </li>
      ))}
    </ul>
  );
}
