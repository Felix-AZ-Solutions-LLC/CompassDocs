"use client";

// The desk's global search (the top bar): one box over tickets, people and
// documents, "/" to focus it. A combobox (focus stays in the input, arrows
// walk the options, Enter opens one) whose results hang in a Popover
// listbox. Tickets open in the desk; people and documents open in
// CompassDocs in a new tab, so the desk keeps its place.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Search, Ticket, UserRound, X } from "lucide-react";
import { iconButtonClass } from "@/components/Button";
import { Popover } from "@/components/Popover";
import { Spinner } from "@/components/Spinner";
import { SectionEmpty, controlClass } from "@/components/form";
import { RAIL_GROUP_TEXT } from "@/components/RailLink";
import type { HdTicketListRow } from "@/lib/helpdesk/types";
import { getJson, listOf } from "./api";
import { useDeskKeys, useSingleKeyOn } from "./hotkeys";
import { statusChip } from "./ui";
import { chipClass } from "@/components/Chip";

type Hit =
  | { kind: "ticket"; id: string; label: string; sub: string; href: string; t: HdTicketListRow }
  | { kind: "person"; id: string; label: string; sub: string; href: string }
  | { kind: "doc"; id: string; label: string; sub: string; href: string };

const GROUP_LABEL: Record<Hit["kind"], string> = { ticket: "Tickets", person: "People", doc: "Documents" };
const ICON = { ticket: Ticket, person: UserRound, doc: FileText };

export function DeskSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const listId = useId();
  const singleKey = useSingleKeyOn();
  // The full placeholder does not fit a phone's top bar; the name stays whole.
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // 1.20.27: under sm the box is an icon until opened (the top bar's Claude, Upcoming, status, bell and
  // avatar left it about 60px); open, it covers the bar, and closes when emptied and left.
  const [expanded, setExpanded] = useState(false);
  const collapsed = !wide && !expanded;
  const openSearch = () => {
    setExpanded(true);
    // Focus once the input is drawn.
    requestAnimationFrame(() => input.current?.focus());
  };
  const closeSearch = () => {
    setExpanded(false);
    setOpen(false);
    setQ("");
  };

  useDeskKeys({ "/": () => (wide ? input.current?.focus() : openSearch()) });

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      setBusy(false);
      return;
    }
    setBusy(true);
    const ac = new AbortController();
    const t = setTimeout(async () => {
      const qs = encodeURIComponent(term);
      const [tickets, people, docs] = await Promise.all([
        getJson(`/api/helpdesk/tickets?q=${qs}&sort=updated&limit=6`, "", ac.signal).catch(() => null),
        getJson(`/api/directory/search?q=${qs}&limit=4`, "", ac.signal).catch(() => null),
        getJson(`/api/search?q=${qs}&limit=4`, "", ac.signal).catch(() => null),
      ]);
      if (ac.signal.aborted) return;
      const out: Hit[] = [];
      for (const t of listOf<HdTicketListRow>(tickets, "tickets").slice(0, 6)) {
        out.push({ kind: "ticket", id: `t${t.number}`, label: t.subject, sub: `#${t.number} · ${t.requester_name}`, href: `/desk/tickets/${t.number}`, t });
      }
      for (const p of listOf<{ id: number; name: string; title?: string; department?: string; email?: string }>(people, "people").slice(0, 4)) {
        out.push({ kind: "person", id: `p${p.id}`, label: p.name, sub: [p.title, p.department].filter(Boolean).join(" · ") || p.email || "", href: `/directory/${p.id}` });
      }
      for (const d of listOf<{ id: number; title: string; space_name?: string }>(docs, "hits").slice(0, 4)) {
        out.push({ kind: "doc", id: `d${d.id}`, label: d.title, sub: d.space_name || "", href: `/doc/${d.id}` });
      }
      setHits(out);
      setActive(0);
      setBusy(false);
    }, 200);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [q]);

  const groups = useMemo(() => {
    const g: { kind: Hit["kind"]; items: { hit: Hit; index: number }[] }[] = [];
    hits.forEach((hit, index) => {
      let grp = g.find((x) => x.kind === hit.kind);
      if (!grp) g.push((grp = { kind: hit.kind, items: [] }));
      grp.items.push({ hit, index });
    });
    return g;
  }, [hits]);

  function go(hit: Hit) {
    setOpen(false);
    setQ("");
    if (hit.kind === "ticket") router.push(hit.href);
    else window.open(hit.href, "_blank", "noopener");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (hits.length ? (a + 1) % hits.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (hits.length ? (a - 1 + hits.length) % hits.length : 0));
    } else if (e.key === "Enter" && hits[active]) {
      e.preventDefault();
      go(hits[active]);
    }
  }

  const showPanel = open && q.trim().length >= 2;

  if (collapsed) {
    return (
      <button type="button" onClick={openSearch} aria-label="Search tickets, people and documents" data-tt="Search" className={iconButtonClass("quiet", "md")}>
        <Search aria-hidden />
      </button>
    );
  }

  return (
    <div
      className={
        wide
          ? "relative min-w-0 flex-1 sm:max-w-[34rem]"
          : // Open on a phone: over the whole bar, with a close button.
            "absolute inset-x-2 top-2 z-30 flex items-center gap-1 bg-surface"
      }
      onBlur={(e) => {
        if (!wide && !q && !e.currentTarget.contains(e.relatedTarget as Node | null)) setExpanded(false);
      }}
    >
      <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-label="Search tickets, people and documents"
        aria-expanded={showPanel}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showPanel && hits[active] ? `${listId}-${hits[active].id}` : undefined}
        placeholder={wide ? "Search tickets, people and docs" : "Search"}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        // 1.20.27: 16px text on a phone, so iOS does not zoom in on focus (controlClass's own default).
        className={controlClass(false, "h-9 w-full pl-9 pr-9", false)}
      />
      {singleKey && (
        <span className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 sm:block" aria-hidden>
          <kbd className="cmd-kbd">/</kbd>
        </span>
      )}
      </div>
      {!wide && (
        <button type="button" onClick={closeSearch} aria-label="Close search" data-tt="Close" className={iconButtonClass("quiet", "md")}>
          <X aria-hidden />
        </button>
      )}
      <Popover
        open={showPanel}
        onClose={() => setOpen(false)}
        triggerRef={input}
        role="group"
        label="Search results"
        width="w-full min-w-[min(22rem,calc(100vw-1rem))]"
        className="mt-1 max-h-[70vh] overflow-y-auto"
      >
        <div id={listId} role="listbox" aria-label="Search results">
          {busy && hits.length === 0 && (
            <div className="flex items-center gap-2 px-3 py-3 text-sm text-slate-500">
              <Spinner size="sm" /> Searching…
            </div>
          )}
          {!busy && hits.length === 0 && <SectionEmpty className="px-3 py-3">Nothing matches &ldquo;{q.trim()}&rdquo;.</SectionEmpty>}
          {groups.map((g) => (
            <div key={g.kind} role="group" aria-label={GROUP_LABEL[g.kind]} className="py-1">
              <p className={`${RAIL_GROUP_TEXT} px-2 pb-1 pt-1.5`}>{GROUP_LABEL[g.kind]}</p>
              {g.items.map(({ hit, index }) => {
                const Icon = ICON[hit.kind];
                const chip = hit.kind === "ticket" ? statusChip(hit.t, true) : null;
                return (
                  <div
                    key={hit.id}
                    id={`${listId}-${hit.id}`}
                    role="option"
                    aria-selected={index === active}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => go(hit)}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm ${index === active ? "bg-compass-50" : ""}`}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-slate-900">{hit.label}</span>
                      {hit.sub && <span className="block truncate text-xs text-slate-500">{hit.sub}</span>}
                    </span>
                    {chip && <span className={chipClass(chip.tone, "sm")}>{chip.label}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </Popover>
    </div>
  );
}
