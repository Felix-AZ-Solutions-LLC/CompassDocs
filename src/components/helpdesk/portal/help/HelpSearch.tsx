"use client";

// The Help Center's search (Helpdesk 1.19.4, C3, mock h1; a combobox since
// 1.20.37): one box, and from two characters (200 ms after the last key)
// suggestions in a card right under it (not a floating panel: the band
// grows to hold them, as in the mock). Up to six in all: the matching
// articles ("title · space", BookOpen) and up to two of the request types
// the portal offers (their own icon, "New request"), from
// /support/api/help/search, which only ever answers what a visitor may see.
//
// Keyboard (the ARIA combobox pattern, focus stays in the box): Arrow Down
// and Up move the active option (aria-activedescendant), Enter opens it,
// Escape closes the list; Enter with no option active submits the form to
// the results page. The form is a plain GET to /support/search, so search
// works without script too. A rate-limited answer shows the server's "Too
// many searches" sentence over the last suggestions, never "No articles
// match".

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Search } from "lucide-react";
import { SectionEmpty, TextInput } from "@/components/form";
import { requestTypeIcon } from "@/components/helpdesk/help/request-type-icon";
import { journeyId, journeyStep } from "./journey";
import type { HelpSuggestion, HelpTypeSuggestion } from "@/lib/helpdesk/help-centre-shared";

const MIN_QUERY = 2;
const DEBOUNCE_MS = 200;

interface Found {
  articles: HelpSuggestion[];
  types: HelpTypeSuggestion[];
}

type Option = { kind: "article"; item: HelpSuggestion } | { kind: "type"; item: HelpTypeSuggestion };

function announce(n: number): string {
  if (n === 0) return "No suggestions match that yet.";
  return n === 1 ? "1 suggestion. Use the arrow keys to choose it." : `${n} suggestions. Use the arrow keys to choose one.`;
}

export function HelpSearch({ initial = "", autoFocus = false, wide = false, className = "" }: { initial?: string; autoFocus?: boolean; wide?: boolean; className?: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initial);
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const [active, setActive] = useState(-1);
  // The server's sentence when searching is rate-limited (never "no match").
  const [limited, setLimited] = useState("");
  const [journey, setJourney] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const query = q.trim();

  useEffect(() => {
    setJourney(journeyId());
  }, []);

  useEffect(() => {
    if (!open || query.length < MIN_QUERY) {
      setFound(null);
      setLimited("");
      setActive(-1);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      const j = journeyId(true);
      setJourney(j);
      try {
        const res = await fetch(`/support/api/help/search?q=${encodeURIComponent(query)}&j=${encodeURIComponent(j)}`, {
          signal: ctl.signal,
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        const data = (await res.json().catch(() => ({}))) as { articles?: HelpSuggestion[]; types?: HelpTypeSuggestion[]; error?: string };
        if (ctl.signal.aborted) return;
        if (res.status === 429) {
          setLimited(data.error || "Too many searches right now. Wait a moment and try again.");
          setFound((cur) => cur ?? { articles: [], types: [] });
          return;
        }
        setLimited("");
        setActive(-1);
        setFound(res.ok ? { articles: data.articles ?? [], types: data.types ?? [] } : { articles: [], types: [] });
      } catch {
        if (!ctl.signal.aborted) setFound((cur) => cur ?? { articles: [], types: [] });
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [query, open]);

  const show = open && query.length >= MIN_QUERY && found !== null;
  const options: Option[] = found ? [...found.articles.map((item) => ({ kind: "article" as const, item })), ...found.types.map((item) => ({ kind: "type" as const, item }))] : [];
  const optionId = (i: number) => `${baseId}-opt-${i}`;
  const hasList = show && options.length > 0;

  function go(o: Option) {
    if (o.kind === "article") journeyStep("open");
    setOpen(false);
    router.push(o.item.href);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      if (show) {
        e.preventDefault();
        setOpen(false);
        setActive(-1);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!show) {
        if (query.length >= MIN_QUERY) setOpen(true);
        return;
      }
      if (!options.length) return;
      e.preventDefault();
      if (e.key === "ArrowDown") setActive((i) => (i + 1) % options.length);
      else setActive((i) => (i <= 0 ? options.length - 1 : i - 1));
      return;
    }
    if (e.key === "Enter" && hasList && active >= 0 && active < options.length) {
      e.preventDefault();
      go(options[active]);
    }
    // Enter with nothing active: the form's own submit opens the results page.
  }

  return (
    <form action="/support/search" method="get" role="search" className={`mx-auto w-full text-left ${wide ? "" : "max-w-xl"} ${className}`.replace(/\s+/g, " ").trim()}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-slate-500" aria-hidden />
        <TextInput
          ref={input}
          type="search"
          name="q"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={(e) => {
            // A click on an option keeps focus in the box (mousedown is prevented), so a blur leaves the search.
            if (!e.currentTarget.form?.contains(e.relatedTarget as Node | null)) setOpen(false);
          }}
          onKeyDown={onKeyDown}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={autoFocus}
          maxLength={120}
          placeholder="Search the Help Center"
          aria-label="Search the Help Center"
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={hasList}
          aria-controls={listId}
          aria-activedescendant={hasList && active >= 0 ? optionId(active) : undefined}
          autoComplete="off"
          enterKeyHint="search"
          className="h-12 rounded-xl pl-11 pr-4 text-base shadow-xs sm:text-[0.95rem]"
        />
        {journey && <input type="hidden" name="j" value={journey} />}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {show ? (limited ? limited : announce(options.length)) : ""}
      </p>
      {/* Always in the DOM, so aria-controls names it; shown while there are suggestions (or a sentence) to show. */}
      <div className={show ? "mt-2 overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-xs" : "hidden"} data-testid="help-suggestions">
        {show && limited && (
          <p className="notice-warn border-b px-4 py-2.5 text-sm" data-testid="help-limited">
            {limited}
          </p>
        )}
        {show && options.length === 0 && !limited && <SectionEmpty className="px-4 py-3">No articles match that yet. Try other words, or raise a request.</SectionEmpty>}
        <ul id={listId} role="listbox" aria-label="Suggestions" className={hasList ? "" : "hidden"} onMouseDown={(e) => e.preventDefault()}>
          {hasList &&
            options.map((o, i) => {
              const Icon = o.kind === "article" ? BookOpen : requestTypeIcon(o.item.icon);
              const on = i === active;
              return (
                <li
                  key={`${o.kind}-${o.item.id}`}
                  id={optionId(i)}
                  role="option"
                  aria-selected={on}
                  data-kind={o.kind}
                  onClick={() => go(o)}
                  onMouseMove={() => setActive(i)}
                  className={`flex cursor-pointer items-center gap-2.5 border-b border-slate-100 px-4 py-2.5 text-[0.95rem] last:border-b-0 ${on ? "bg-compass-50" : "hover:bg-slate-50"}`}
                >
                  <Icon className={`h-4 w-4 shrink-0 ${o.kind === "article" ? "text-slate-500" : "text-compass-600"}`} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-slate-900">{o.item.title}</span>
                  <span className="max-w-[45%] shrink-0 truncate text-xs text-slate-500">{o.kind === "article" ? o.item.space : "New request"}</span>
                </li>
              );
            })}
        </ul>
      </div>
    </form>
  );
}
