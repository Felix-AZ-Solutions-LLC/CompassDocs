"use client";

// A filtered list's custom field conditions as chips (1.20.8,
// lib/helpdesk/custom-field-filters), on a row of their own under the
// "Filtered:" line, so a long condition is never cut off by it. Each chip is
// the condition in words ("Device type: Laptop, Phone") with the CC chip's
// round quiet X, a link to the same list without that condition.

import Link from "next/link";
import { X } from "lucide-react";
import { chipClass } from "@/components/Chip";
import { iconButtonClass } from "@/components/Button";
import { cfSummaryParts, isCfFilterKey } from "@/lib/helpdesk/custom-field-filters-shared";
import { selQs, type QueueSel } from "../queue/views";
import type { DeskFilterField } from "../custom-fields/filters";

/** The filters without their custom field conditions (the strip's summary line names the rest). */
export function withoutCustom(f: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(f).filter(([k]) => !isCfFilterKey(k)));
}

export function CustomFieldChips({
  sel,
  fields,
  names,
  basePath,
}: {
  sel: QueueSel;
  fields: DeskFilterField[] | undefined;
  names: Map<number, string>;
  basePath: string;
}) {
  const drill = sel.drill ?? {};
  const keys = Object.keys(drill).filter(isCfFilterKey);
  if (!keys.length) return null;
  return (
    <ul aria-label="Custom field conditions" className="flex flex-wrap gap-1 px-3 pb-2">
      {keys.map((k) => {
        const text = cfSummaryParts({ [k]: drill[k] }, fields, names)[0] ?? k;
        const rest = { ...drill };
        delete rest[k];
        return (
          <li key={k} className={chipClass("neutral", "md", "max-w-full pr-0.5")} data-testid="cf-chip">
            <span className="min-w-0 truncate" title={text}>
              {text}
            </span>
            <Link
              href={`${basePath}${selQs({ ...sel, drill: rest })}`}
              aria-label={`Remove the condition ${text}`}
              data-tt="Remove"
              className={iconButtonClass("quiet", "sm", "!h-5 !w-5 shrink-0 rounded-full [&>svg]:!h-3 [&>svg]:!w-3")}
            >
              <X aria-hidden />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
