"use client";

// 1.20.27: the icon of a team or a request type, picked from the icons the
// desk can draw (TeamIcon's closed map) instead of typed or chosen by its
// lucide name ("monitor", "user-plus"), which admins were shown raw. A
// radio group of 32px icon tiles (36px on touch), one tab stop, the arrows
// move the choice; each tile names its icon in data-tt and aria-label.
// "Default" (the Users icon) stores an empty name.

import { useId, useRef } from "react";
import { TEAM_ICONS } from "./TeamIcon";

/** The names offered: every glyph once (userPlus is an old alias of user-plus). */
const NAMES = ["", ...Object.keys(TEAM_ICONS).filter((n) => n !== "userPlus")];

function nameLabel(n: string): string {
  if (!n) return "Default";
  const words = n.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function TeamIconPicker({
  label = "Icon",
  value,
  onChange,
  disabled = false,
  help,
}: {
  label?: string;
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
  help?: string;
}) {
  const id = useId();
  const group = useRef<HTMLDivElement>(null);
  // An unknown stored name shows as Default (TeamIcon draws Users for it too).
  const current = NAMES.includes(value) ? value : "";

  function move(from: number, by: number) {
    const next = (from + by + NAMES.length) % NAMES.length;
    onChange(NAMES[next]);
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }

  return (
    <div>
      <span id={`${id}-label`} className="mb-1 block text-xs font-medium text-slate-500">
        {label}
      </span>
      <div
        ref={group}
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        aria-describedby={help ? `${id}-help` : undefined}
        className="flex flex-wrap gap-1"
      >
        {NAMES.map((n, i) => {
          const Icon = n ? TEAM_ICONS[n] : TEAM_ICONS.users;
          const on = n === current;
          return (
            <button
              key={n || "default"}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={nameLabel(n)}
              data-tt={nameLabel(n)}
              tabIndex={on ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange(n)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                  e.preventDefault();
                  move(i, 1);
                } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                  e.preventDefault();
                  move(i, -1);
                }
              }}
              className={`grid h-8 w-8 place-items-center rounded-lg border transition disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:h-9 pointer-coarse:w-9 ${
                on
                  ? "border-compass-300 bg-compass-50 text-compass-700 dark:border-compass-500"
                  : "border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden />
            </button>
          );
        })}
      </div>
      {help && (
        <span id={`${id}-help`} className="mt-1 block text-xs text-slate-500">
          {help}
        </span>
      )}
    </div>
  );
}
