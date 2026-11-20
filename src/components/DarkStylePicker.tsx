"use client";

// The dark style choice (1.20.35, lib/dark-style): radio cards, each with a
// small preview of the style (its page, a card on it with the card's edge,
// a line of body text, a line of muted text and an accent dot). Account →
// Preferences offers it with "Workspace default" first; Settings → Workspace
// offers the three styles as the default. The selected card is the house
// selected style (border-compass-300 dark:border-compass-500 on the accent
// tint, STYLEGUIDE §Color and theming).
//
// The previews are drawn from DARK_STYLE_SWATCH, the one place outside
// globals.css that holds dark colours (test/dark-style.test.ts keeps the two
// equal): a preview shows the style whatever theme the page is in.

import { useId } from "react";
import { DARK_STYLE_SWATCH, type DarkStyle } from "@/lib/dark-style";

export interface DarkStyleOption<T extends string> {
  value: T;
  label: string;
  description: string;
  /** The style the preview draws (for "Workspace default": the workspace's). */
  swatch: DarkStyle;
}

export function DarkStyleSwatch({ style }: { style: DarkStyle }) {
  const c = DARK_STYLE_SWATCH[style];
  const rgb = (v: string) => `rgb(${v})`;
  return (
    <span
      aria-hidden
      data-swatch={style}
      className="block rounded-md p-2 ring-1 ring-slate-200"
      style={{ backgroundColor: rgb(c.canvas) }}
    >
      <span
        className="flex items-center gap-2 rounded-sm border px-2 py-1.5"
        style={{ backgroundColor: rgb(c.surface), borderColor: rgb(c.edge) }}
      >
        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-compass-600" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="block h-1.5 w-4/5 rounded-full" style={{ backgroundColor: rgb(c.ink) }} />
          <span className="block h-1.5 w-1/2 rounded-full" style={{ backgroundColor: rgb(c.muted) }} />
        </span>
      </span>
    </span>
  );
}

export function DarkStylePicker<T extends string>({
  label,
  name,
  value,
  onChange,
  options,
  describedBy,
}: {
  /** The group's accessible name. */
  label: string;
  name: string;
  value: T;
  onChange: (next: T) => void;
  options: DarkStyleOption<T>[];
  /** A help line elsewhere on the page that describes the group. */
  describedBy?: string;
}) {
  const id = useId();
  return (
    <div role="radiogroup" aria-label={label} aria-describedby={describedBy} className="card-grid gap-2 [--card-min:9rem]">
      {options.map((o) => {
        const checked = o.value === value;
        const rid = `${id}-${o.value}`;
        return (
          // The whole card takes a click (the preview included); the radio and
          // its label carry the name, so a screen reader hears "Black" and
          // then the description, not both as one name.
          <div
            key={o.value}
            data-dark-style-option={o.value}
            onClick={(e) => {
              // The radio and its label answer their own clicks (once).
              if (checked || (e.target as HTMLElement).closest("label, input")) return;
              onChange(o.value);
            }}
            className={`flex cursor-pointer flex-col gap-2 rounded-lg border p-2.5 transition ${
              checked ? "border-compass-300 bg-compass-50/60 dark:border-compass-500" : "border-slate-200 hover:bg-slate-50"
            }`}
          >
            <DarkStyleSwatch style={o.swatch} />
            <span className="flex items-start gap-2">
              <input
                type="radio"
                id={rid}
                name={name}
                value={o.value}
                checked={checked}
                onChange={() => onChange(o.value)}
                aria-describedby={`${rid}-desc`}
                className="mt-0.5 h-4 w-4 shrink-0"
              />
              <span className="min-w-0">
                <label htmlFor={rid} className="block cursor-pointer text-sm font-medium text-slate-800">
                  {o.label}
                </label>
                <span id={`${rid}-desc`} className="block text-xs text-slate-500">
                  {o.description}
                </span>
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
