"use client";

// 1.20.34 (lib/helpdesk/desk-calendar-park; STYLEGUIDE §Helpdesk: the event
// calendar, "Scheduled"): what a requester reads in place of "On hold" while
// their request is parked until its event: "Scheduled · Sun 15 Mar, 10:00 ·
// Room 4". An `info` chip with `CalendarDays`, never a link. Get help shows
// times in the person's zone and clock (the app's settings); the customer
// portal, which has no account settings, in the reader's own browser.

import { CalendarDays } from "lucide-react";
import { chipClass } from "@/components/Chip";
import { useAppSettings } from "@/components/SettingsProvider";
import { scheduledLabel } from "@/lib/helpdesk/desk-calendar-park-shared";
import { validZone } from "@/lib/helpdesk/desk-calendar-shared";
import type { HdScheduled } from "@/lib/helpdesk/types";

function Chip({ s, tz, h12, className }: { s: HdScheduled; tz: string; h12: boolean; className: string }) {
  const label = scheduledLabel(s, validZone(tz) ? tz : "UTC", h12);
  return (
    <span className={chipClass("info", "md", `max-w-full ${className}`)} data-testid="scheduled-chip" suppressHydrationWarning>
      <CalendarDays className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate" suppressHydrationWarning>
        {label}
      </span>
    </span>
  );
}

/** Get help: the signed-in person's zone and clock. */
export function ScheduledChip({ scheduled, className = "" }: { scheduled: HdScheduled; className?: string }) {
  const { timezone, time_format } = useAppSettings();
  return <Chip s={scheduled} tz={timezone} h12={time_format === "12h"} className={className} />;
}

/** The customer portal: the reader's browser zone and clock. */
export function PortalScheduledChip({ scheduled, className = "" }: { scheduled: HdScheduled; className?: string }) {
  const o = typeof Intl !== "undefined" ? Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions() : null;
  return <Chip s={scheduled} tz={o?.timeZone ?? "UTC"} h12={o?.hour12 === true} className={className} />;
}
