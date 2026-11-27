// Cloud mode (1.21.0, lib/cloud; STYLEGUIDE §Settings pages, "An area the
// platform manages"): what stands in for a part of the app that CompassDocs
// Cloud manages, at the empty-state tier its place calls for, and the
// read-only label of a setting the platform supplies.
//
//   - CloudManagedPage: a whole settings page (Domain & HTTPS, Backups) is
//     the page-level EmptyState, under the page's own header.
//   - CloudManagedNote: a card's worth inside a page (Version & updates on
//     System, the backup rows of its Storage card) is a SectionEmpty line.
//   - SetByPlatform: a setting the platform supplies (license key, AI key,
//     SMTP) keeps its label; its input is replaced by this line ("Managed by
//     CompassDocs Cloud" for the license the console renews, 1.21.3).
//
// No action, but one (1.21.4): Backups points at the workspace export
// (Settings → Import & export), the copy a customer can take themselves.
// Otherwise there is nothing in the workspace to go to, and the sentences
// say where to ask instead.

import { Cloud } from "lucide-react";
import { EmptyState, SectionEmpty, type EmptyAction } from "./form";
import { chipClass } from "./Chip";
import { CLOUD_AREAS, CLOUD_MANAGED_TITLE, SET_BY_PLATFORM, type CloudArea } from "@/lib/cloud";

export function CloudManagedPage({ area, action }: { area: CloudArea; action?: EmptyAction }) {
  return (
    <div data-testid={`cloud-managed-${area}`}>
      <EmptyState icon={<Cloud />} title={CLOUD_MANAGED_TITLE} body={CLOUD_AREAS[area].body} action={action} />
    </div>
  );
}

export function CloudManagedNote({ area, className = "" }: { area: CloudArea; className?: string }) {
  return (
    <SectionEmpty className={className}>
      <span data-testid={`cloud-managed-${area}`}>
        <span className="font-medium text-slate-700">{CLOUD_MANAGED_TITLE}.</span> {CLOUD_AREAS[area].body}
      </span>
    </SectionEmpty>
  );
}

/**
 * A platform-supplied value in place of its input: the chip, then what it is
 * (never the secret itself). 1.21.3: `label` CLOUD_MANAGED_TITLE for a value
 * the platform also renews (the license from the console).
 */
export function SetByPlatform({ children, label = SET_BY_PLATFORM }: { children?: React.ReactNode; label?: string }) {
  return (
    <p data-testid="set-by-platform" className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
      <span className={chipClass("info")}>
        <Cloud className="h-3.5 w-3.5" aria-hidden /> {label}
      </span>
      {children && <span className="text-xs text-slate-500">{children}</span>}
    </p>
  );
}
